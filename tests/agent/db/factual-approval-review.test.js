import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, setTestEnv, resetDb, superDb, workerDb, closeDbs, addUser, addChannel, adminRequest } from '../helpers.js';
import { sha256Hex, textFingerprint } from '../../../lib/agent/crypto.js';
import { handleAdmin } from '../../../lib/agent/handlers/admin.js';
import { authorizePublication } from '../../../lib/agent/policy.js';
import { getSettings } from '../../../lib/agent/db.js';

describe('Security regression: review of factual editorial content', { skip: dbSkip }, () => {
  let mod; let channel; let calendar; let contentRow; let publication;
  const sourceSlug = 'official-test-source';

  before(() => setTestEnv());
  beforeEach(async () => {
    setTestEnv();
    await resetDb();
    mod = await addUser({ moderator: true });
    channel = await addChannel({ provider: 'mock', account_label: 'Review Mock' });
    await superDb().query(
      `insert into ufs_agent.sources(slug,title,url,publisher,source_class,verified_by,verified_at,active)
       values ($1,'Official source','https://www.sitges.cat/','Ajuntament de Sitges','official_municipal',$2,now(),true)`,
      [sourceSlug, mod.id],
    );
    const scheduledAt = new Date(Date.now() + 86400000);
    calendar = await superDb().one(
      `insert into ufs_agent.editorial_calendar(planned_date,planned_slot,category,topic,topic_key,
         source_requirements,status)
       values ($1,'morning','local_government','Verified council information','verified-council-test',
               $2::jsonb,'ready') returning *`,
      [scheduledAt.toISOString().slice(0,10), JSON.stringify({ factual: true, sources: [sourceSlug] })],
    );
    const canonical = {
      title: 'Verified council information',
      body: 'The Ajuntament publishes local government information for residents.',
      facebook_text: 'The Ajuntament publishes local government information for residents.',
      instagram_caption: 'The Ajuntament publishes local government information for residents.',
      claims: [{ text: 'The council publishes information.', source_slug: sourceSlug,
        supporting_excerpt: 'The Ajuntament publishes local government information for residents.' }],
    };
    contentRow = await superDb().one(
      `insert into ufs_agent.content(editorial_calendar_id, revision, canonical_content,
       source_references, factual_verification_status, neutrality_validation_status, duplication_status,
       publishability, gate_results, content_hash, origin)
       values ($1,1,$2::jsonb,$3::jsonb,'passed','passed','unique','publishable',$4::jsonb,$5,'ai')
       returning *`,
      [calendar.id, JSON.stringify(canonical), JSON.stringify([{ slug: sourceSlug, url: 'https://www.sitges.cat/' }]),
        JSON.stringify([{ name: 'source_excerpt', severity: 'hard', result: 'pass' }]), sha256Hex(JSON.stringify(canonical))],
    );
    publication = await superDb().one(
      `insert into ufs_agent.publications(content_id, channel_id, scheduled_at, scheduled_local_date,
         scheduled_slot, platform_text, text_fingerprint, idempotency_key)
       values ($1,$2,$3,$4,'morning',$5,$6,$7) returning *`,
      [contentRow.id, channel.id, scheduledAt, scheduledAt.toISOString().slice(0,10),
        canonical.facebook_text, textFingerprint(canonical.facebook_text), `review-${contentRow.id}`],
    );
  });
  after(() => closeDbs());

  const call = async (body) => {
    const response = await handleAdmin(adminRequest('POST', { body }), {
      getDb: () => workerDb(), verifyUser: async () => ({ id: mod.id }),
    });
    return { status: response.status, body: await response.json() };
  };

  test('an unapproved factual post cannot be published even in AUTONOMOUS mode', async () => {
    const settings = await getSettings(workerDb());
    settings.publishing.mode = 'AUTONOMOUS';
    settings.publishing.autonomous_publishing_enabled = true;
    const now = new Date(new Date(publication.scheduled_at).getTime() + 30000);
    const decision = authorizePublication({ settings, channel, content: contentRow,
      calendar, publication, now, mediaCheck: { ok: true } });
    assert.equal(decision.mode, 'block');
    assert.ok(decision.reasons.includes('factual_human_review_required'));
  });

  test('moderator must verify exact content hash and explicitly attest source review', async () => {
    const missing = await call({ action: 'content_approve', content_id: contentRow.id,
      content_hash: contentRow.content_hash });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'source_review_confirmation_required');
    const stale = await call({ action: 'content_approve', content_id: contentRow.id,
      content_hash: 'a'.repeat(64), confirm: 'I VERIFIED ALL FACTUAL CLAIMS AGAINST THE SOURCES' });
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error, 'content_changed_reload');
    const approved = await call({ action: 'content_approve', content_id: contentRow.id,
      content_hash: contentRow.content_hash, confirm: 'I VERIFIED ALL FACTUAL CLAIMS AGAINST THE SOURCES' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const row = await superDb().one('select approved_by, approved_at from ufs_agent.content where id=$1', [contentRow.id]);
    assert.equal(row.approved_by, mod.id);
    assert.ok(row.approved_at);
  });

  test('manual replacement cannot downgrade a factual topic into unsourced content', async () => {
    const result = await call({
      action: 'content_replace', calendar_id: calendar.id, approve: true,
      title: 'Unsourced statement', body: 'This unsupported factual text must never be posted.',
      facebook_text: 'This unsupported factual text must never be posted.',
      instagram_caption: 'This unsupported factual text must never be posted.',
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'factual_replacement_requires_source_review');
  });
});
