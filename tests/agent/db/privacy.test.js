// Issue #5: end-to-end erasure of every local copy, suppression of
// re-ingestion, retention of derived text, audit restrictions, retries.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, setTestEnv, workerDb, superDb, closeDbs, resetDb, addChannel, mockRegistry, FakeModel, fbCommentPayload, webhookRequest, addUser, adminRequest } from '../helpers.js';
import { handleEvent } from '../../../lib/agent/handlers/webhook.js';
import { handleAdmin } from '../../../lib/agent/handlers/admin.js';
import { processEventQueue } from '../../../lib/agent/moderation.js';
import { executePendingActions, executeOne } from '../../../lib/agent/executor.js';
import { applyRetention, processPendingPrivacyRequests } from '../../../lib/agent/privacy.js';
import { getSettings } from '../../../lib/agent/db.js';

const FB_PERMS = ['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement', 'pages_manage_posts'];
const PERSONAL = 'Joan Puig from carrer Major';
const SUMMARY = 'Resident asks where the nearest recycling point to the station is.';

async function deliver(channel, { message, fromId = '777001', commentId = `${channel.external_account_id}_${Math.floor(Math.random() * 1e9)}`, verb = 'add' }) {
  const res = await handleEvent(webhookRequest(fbCommentPayload({ pageId: channel.external_account_id, commentId, message, fromId, verb })), { getDb: () => workerDb() });
  assert.equal(res.status, 200);
  return { commentId, body: await res.json() };
}

const model = () => new FakeModel((kind) => (kind === 'classify'
  ? { category: 'civic_information', risk_level: 'medium', language: 'en', summary: SUMMARY, is_question: true, needs_human: false, injection_detected: false, reasons: [] }
  : { reply_text: 'Thanks for asking. We will check the official municipal information and reply here.', language: 'en', source_ids_used: [], needs_fact_check: false }));

async function processQueue(adapterFor) {
  const db = workerDb();
  return processEventQueue(db, { settings: await getSettings(db), model: model(), adapterFor }, { workerId: `w-${Math.random()}` });
}

const count = async (sql, params = []) => Number((await superDb().one(sql, params)).n);

describe('Erasure of every local copy (issue #5)', { skip: dbSkip }, () => {
  let channel; let mod; let deps; let call;

  // One comment by "author 777001" taken all the way to an approved reply,
  // with personal text copied into a human draft, the audit log and a digest.
  async function scenario({ fromId = '777001', message = `Hi, I am ${PERSONAL}. Where is the recycling point near the station?` } = {}) {
    const { commentId } = await deliver(channel, { message, fromId });
    await processQueue(deps.adapterFor);
    const ev = await superDb().one('select * from ufs_agent.events where external_object_id=$1', [commentId]);
    const kase = await superDb().one('select * from ufs_agent.cases where event_id=$1', [ev.id]);
    const d1 = await superDb().one('select * from ufs_agent.drafts where case_id=$1 order by version desc limit 1', [kase.id]);
    const edit = await call({ action: 'draft_edit', case_id: kase.id, text: `Hello ${PERSONAL}, the recycling point is next to the station.`, based_on_fingerprint: d1.content_fingerprint });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    const ok = await call({ action: 'draft_approve', draft_id: edit.body.draft.id, fingerprint: edit.body.draft.content_fingerprint });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await superDb().query(`insert into ufs_agent.digests(kind, period_key, status, subject, body_text, content_hash)
      values ('daily', $1, 'dry_run', 's', $2, repeat('0', 64))`, [`2026-11-${10 + Math.floor(Math.random() * 9)}-${commentId.slice(-4)}`, `High-priority incidents:\n- medium civic_information: ${SUMMARY.slice(0, 160)}\nOther line`]);
    return { commentId, ev, kase };
  }

  before(() => setTestEnv());
  beforeEach(async () => {
    setTestEnv({ AGENT_LIVE_META_REPLIES: 'true' });
    await resetDb();
    channel = await addChannel({ provider: 'facebook_page', external_account_id: String(5000 + Math.floor(Math.random() * 1e6)), permissions_verified: FB_PERMS });
    mod = await addUser({ moderator: true });
    deps = { getDb: () => workerDb(), adapterFor: mockRegistry(), verifyUser: async () => ({ id: mod.id }) };
    call = async (body) => {
      const res = await handleAdmin(adminRequest('POST', { body }), deps);
      return { status: res.status, body: await res.json() };
    };
  });
  after(() => closeDbs());

  test('item erasure redacts events, cases, drafts, queued actions, audit details and digests atomically', async () => {
    const { ev, kase } = await scenario();
    assert.equal(await count("select count(*) n from ufs_agent.actions where case_id=$1 and execution_status='pending'", [kase.id]), 1);
    assert.ok(await count("select count(*) n from ufs_agent.audit_log where detail::text like $1", [`%${PERSONAL}%`]) >= 2, 'precondition: personal text is in the audit log');

    const res = await call({ action: 'privacy_request_create', event_id: ev.id, scope: 'item', reason_code: 'data_subject_request', confirm: 'ERASE STORED DATA' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'completed');

    const e = await superDb().one('select * from ufs_agent.events where id=$1', [ev.id]);
    assert.equal(e.content_excerpt, null);
    assert.equal(e.author_ref, null);
    assert.equal(e.permalink, null);
    assert.equal(e.redaction_reason, 'data_subject_request');
    const c = await superDb().one('select * from ufs_agent.cases where id=$1', [kase.id]);
    assert.equal(c.summary, '[redacted]');
    assert.ok(!['open', 'awaiting_approval', 'escalated'].includes(c.status), `no open work remains on erased content (${c.status})`);
    const drafts = await superDb().query('select * from ufs_agent.drafts where case_id=$1', [kase.id]);
    assert.ok(drafts.length >= 2 && drafts.every((d) => d.proposed_answer === '[redacted]' && d.redacted_at));
    assert.ok(drafts.every((d) => !['proposed', 'approved'].includes(d.status)), 'no draft can still be approved or sent');
    assert.ok(drafts.every((d) => /^[a-f0-9]{64}$/.test(d.content_fingerprint)), 'fingerprints kept as non-identifying accountability');
    const act = await superDb().one('select * from ufs_agent.actions where case_id=$1', [kase.id]);
    assert.equal(act.execution_status, 'cancelled');
    assert.equal(act.status_reason, 'privacy_redaction');
    assert.equal(act.payload_text, '[redacted]');

    // Nothing anywhere still holds the personal text or the summary.
    for (const [table, col] of [['events', 'content_excerpt'], ['cases', 'summary'], ['drafts', 'proposed_answer'], ['actions', 'payload_text'], ['digests', 'body_text']]) {
      assert.equal(await count(`select count(*) n from ufs_agent.${table} where ${col} like $1`, [`%${PERSONAL}%`]), 0, table);
    }
    assert.equal(await count('select count(*) n from ufs_agent.audit_log where detail::text like $1', [`%${PERSONAL}%`]), 0, 'audit');
    assert.equal(await count('select count(*) n from ufs_agent.digests where body_text like $1', [`%${SUMMARY.slice(0, 40)}%`]), 0, 'digest');
    const dg = await superDb().one("select body_text, content_hash, redacted_at from ufs_agent.digests where kind='daily' limit 1");
    assert.match(dg.body_text, /\[redacted\]/);
    assert.equal(dg.content_hash, (await superDb().one("select encode(sha256(convert_to($1,'UTF8')),'hex') h", [dg.body_text])).h);

    // Audit keeps its structure: same rows, structural keys readable, stamp added.
    const approved = await superDb().one("select detail from ufs_agent.audit_log where action='draft_approved'");
    assert.equal(approved.detail.approved_text, '[redacted]');
    assert.match(approved.detail.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(approved.detail._redaction.reason, 'data_subject_request');

    // Accountability record: counts only, no identifiers of the person.
    const reqRow = await superDb().one('select * from ufs_agent.privacy_requests where id=$1', [res.body.request_id]);
    assert.equal(reqRow.status, 'completed');
    assert.ok(reqRow.result.events === 1 && reqRow.result.drafts >= 2 && reqRow.result.actions_cancelled === 1 && reqRow.result.audit_entries >= 2 && reqRow.result.digests === 1, JSON.stringify(reqRow.result));
    assert.ok(!JSON.stringify(reqRow).includes(PERSONAL));
    assert.equal(await count("select count(*) n from ufs_agent.audit_log where action='privacy_request_completed'"), 1);
  });

  test('erasure is idempotent and confirmation and reason are required', async () => {
    const { ev } = await scenario();
    assert.equal((await call({ action: 'privacy_request_create', event_id: ev.id, scope: 'item', reason_code: 'data_subject_request' })).body.error, 'confirmation_required');
    assert.equal((await call({ action: 'privacy_request_create', event_id: ev.id, scope: 'item', reason_code: 'because', confirm: 'ERASE STORED DATA' })).body.error, 'invalid_reason_code');
    const first = await call({ action: 'privacy_request_create', event_id: ev.id, scope: 'item', reason_code: 'data_subject_request', confirm: 'ERASE STORED DATA' });
    const again = await superDb().one('select ufs_agent.process_privacy_request($1) as r', [first.body.request_id]);
    assert.deepEqual(again.r, first.body.result, 'completed request returns its stored result');
    const second = await call({ action: 'privacy_request_create', event_id: ev.id, scope: 'item', reason_code: 'data_subject_request', confirm: 'ERASE STORED DATA' });
    assert.equal(second.body.status, 'completed');
    assert.equal(second.body.result.events, 0, 'nothing left to redact');
    assert.equal(second.body.result.audit_entries, 0, 'audit rows are never redacted twice');
  });

  test('author scope erases every stored item by the same author and nobody else', async () => {
    const a1 = await scenario({ fromId: '888001' });
    await deliver(channel, { message: `Second message by ${PERSONAL}`, fromId: '888001' });
    await deliver(channel, { message: 'Unrelated question from someone else about bus timetables', fromId: '999002' });
    await processQueue(deps.adapterFor);
    const res = await call({ action: 'privacy_request_create', event_id: a1.ev.id, scope: 'author', reason_code: 'data_subject_request', confirm: 'ERASE STORED DATA' });
    assert.equal(res.body.result.matched_events, 2);
    assert.equal(await count('select count(*) n from ufs_agent.events where content_excerpt like $1', [`%${PERSONAL}%`]), 0);
    assert.equal(await count("select count(*) n from ufs_agent.events where content_excerpt like '%bus timetables%'"), 1, 'other authors untouched');
  });

  test('edits and redeliveries of an erased comment are not stored again; objection also blocks the author', async () => {
    const { ev, commentId } = await scenario({ fromId: '666001' });
    await call({ action: 'privacy_request_create', event_id: ev.id, scope: 'item', reason_code: 'data_subject_request', confirm: 'ERASE STORED DATA' });
    const edited = await deliver(channel, { message: `EDITED: still ${PERSONAL}`, fromId: '666001', commentId, verb: 'edited' });
    assert.equal(edited.body.accepted, 0);
    assert.equal(await count('select count(*) n from ufs_agent.events where content_excerpt like $1', [`%${PERSONAL}%`]), 0);
    // Item erasure does not silence the person's future comments...
    const later = await deliver(channel, { message: 'A new, separate question about parking', fromId: '666001' });
    assert.equal(later.body.accepted, 1);
    // ...an objection with suppress_future does.
    const ev2 = await superDb().one("select id from ufs_agent.events where content_excerpt like '%parking%'");
    await call({ action: 'privacy_request_create', event_id: ev2.id, scope: 'author', reason_code: 'objection', suppress_future: true, confirm: 'ERASE STORED DATA' });
    const blocked = await deliver(channel, { message: 'Yet another comment after the objection', fromId: '666001' });
    assert.equal(blocked.body.accepted, 0);
    assert.equal(await count("select count(*) n from ufs_agent.privacy_suppressions where kind='author'"), 1);
  });

  test('queued replies never reach the provider after erasure, including one already claimed by a worker', async () => {
    await superDb().query("update ufs_agent.settings set value = value || '{\"mode\":\"SUPERVISED\"}'::jsonb where key='moderation'");
    const { ev, kase, commentId } = await scenario();
    // A worker claims the action, then the erasure lands before its provider write.
    const claimed = await superDb().one(`update ufs_agent.actions set execution_status='executing', lease_owner='w-race', lease_expires_at=now()+interval '2 minutes', attempt_count=attempt_count+1
      where case_id=$1 returning *`, [kase.id]);
    const res = await call({ action: 'privacy_request_create', event_id: ev.id, scope: 'item', reason_code: 'data_subject_request', confirm: 'ERASE STORED DATA' });
    assert.equal(res.body.result.actions_cancelled, 1);
    const out = await executeOne(workerDb(), { adapterFor: deps.adapterFor }, claimed, 'w-race');
    assert.notEqual(out.status, 'succeeded');
    const mock = deps.adapterFor.map.get(channel.id);
    assert.equal((mock?.calls || []).filter((c) => c.op === 'replyToComment').length, 0);
    await executePendingActions(workerDb(), { settings: await getSettings(workerDb()), adapterFor: deps.adapterFor }, { workerId: 'w2' });
    assert.equal((mock?.calls || []).filter((c) => c.op === 'replyToComment').length, 0);
    assert.ok(commentId);
  });

  test('an event erased while being processed gets no case', async () => {
    await deliver(channel, { message: `Processing race with ${PERSONAL}`, fromId: '555001' });
    const ev = await superDb().one('select * from ufs_agent.events limit 1');
    await superDb().query("select ufs_agent.redact_events(array[$1::uuid], 'data_subject_request', null)", [ev.id]);
    // A worker that had already claimed it continues with the old in-memory copy.
    const { processEvent } = await import('../../../lib/agent/moderation.js');
    const r = await processEvent(workerDb(), { settings: await getSettings(workerDb()), model: model() }, { ...ev, provider: 'facebook_page' });
    assert.equal(r.outcome, 'case_exists_or_redacted');
    assert.equal(await count('select count(*) n from ufs_agent.cases'), 0);
  });

  test('audit log stays append-only except for the scoped, one-time redaction', async () => {
    const { ev } = await scenario();
    const row = await superDb().one("select id, detail from ufs_agent.audit_log where action='draft_edited'");
    const w = workerDb();
    await assert.rejects(w.query("update ufs_agent.audit_log set detail = jsonb_set(detail, '{text}', '\"tampered\"') || '{\"_redaction\":{}}' where id=$1", [row.id]), /append-only/);
    await assert.rejects(w.query("update ufs_agent.audit_log set detail = (detail - 'case_id') || '{\"_redaction\":{}}' where id=$1", [row.id]), /append-only/, 'keys cannot be removed');
    await assert.rejects(w.query("update ufs_agent.audit_log set detail = detail || '{\"extra\":1,\"_redaction\":{}}' where id=$1", [row.id]), /append-only/, 'keys cannot be invented');
    await assert.rejects(w.query("update ufs_agent.audit_log set detail = jsonb_set(detail, '{text}', '\"[redacted]\"') where id=$1", [row.id]), /append-only/, 'stamp is mandatory');
    await assert.rejects(w.query("update ufs_agent.audit_log set action='other' where id=$1", [row.id]), /permission denied|append-only/);
    await assert.rejects(w.query('delete from ufs_agent.audit_log where id=$1', [row.id]), /cannot be deleted/);
    await call({ action: 'privacy_request_create', event_id: ev.id, scope: 'item', reason_code: 'data_subject_request', confirm: 'ERASE STORED DATA' });
    await assert.rejects(w.query("update ufs_agent.audit_log set detail = ufs_agent.redacted_detail(detail, null, 'retention') where id=$1", [row.id]), /append-only/, 'redaction happens once');
    // Drafts: arbitrary edits still impossible; only the redaction marker is allowed.
    const d = await superDb().one('select id from ufs_agent.drafts limit 1');
    await assert.rejects(superDb().query("update ufs_agent.drafts set proposed_answer='changed', redacted_at=null where id=$1", [d.id]), /immutable/);
  });

  test('a failed erasure changes nothing, is recorded, and succeeds on retry', async () => {
    const { ev, kase } = await scenario();
    // Inject a one-off failure in the middle of the transaction.
    await superDb().query(`create or replace function ufs_agent.test_fail_once() returns trigger language plpgsql as $$
      begin if exists (select 1 from pg_tables where tablename = 'privacy_fail_flag') then raise exception 'injected failure'; end if; return new; end $$`);
    await superDb().query('create table public.privacy_fail_flag(x int)');
    await superDb().query('create trigger test_fail_once before update on ufs_agent.cases for each row execute function ufs_agent.test_fail_once()');
    try {
      const res = await call({ action: 'privacy_request_create', event_id: ev.id, scope: 'item', reason_code: 'data_subject_request', confirm: 'ERASE STORED DATA' });
      assert.equal(res.body.status, 'failed');
      const e = await superDb().one('select content_excerpt from ufs_agent.events where id=$1', [ev.id]);
      assert.match(e.content_excerpt, /Joan Puig/, 'rollback: nothing partially redacted');
      assert.equal(await count("select count(*) n from ufs_agent.actions where case_id=$1 and execution_status='pending'", [kase.id]), 1);
      const r = await superDb().one('select status, attempts, last_error from ufs_agent.privacy_requests');
      assert.equal(r.status, 'failed');
      assert.equal(r.attempts, 1);
      await superDb().query('drop table public.privacy_fail_flag');
      // The scheduler's privacy job retries it.
      const retried = await processPendingPrivacyRequests(workerDb());
      assert.equal(retried[0].status, 'completed');
      assert.equal((await superDb().one('select content_excerpt from ufs_agent.events where id=$1', [ev.id])).content_excerpt, null);
      assert.equal((await superDb().one('select attempts from ufs_agent.privacy_requests')).attempts, 2);
    } finally {
      await superDb().query('drop trigger if exists test_fail_once on ufs_agent.cases');
      await superDb().query('drop table if exists public.privacy_fail_flag');
    }
  });
});

describe('Retention of derived text (issue #5)', { skip: dbSkip }, () => {
  let channel; let mod; let deps;
  before(() => setTestEnv());
  beforeEach(async () => {
    setTestEnv();
    await resetDb();
    channel = await addChannel({ provider: 'facebook_page', external_account_id: String(7000 + Math.floor(Math.random() * 1e6)), permissions_verified: FB_PERMS });
    mod = await addUser({ moderator: true });
    deps = { getDb: () => workerDb(), adapterFor: mockRegistry(), verifyUser: async () => ({ id: mod.id }) };
  });
  after(() => closeDbs());

  async function oldItems(n, daysAgo) {
    for (let i = 0; i < n; i += 1) await deliver(channel, { message: `Old message ${i} by ${PERSONAL}`, fromId: `44400${i}` });
    await processQueue(deps.adapterFor);
    await superDb().query(`update ufs_agent.events set received_at = now() - make_interval(days => $1)`, [daysAgo]);
  }

  test('expired events and all derived copies are redacted in bounded, idempotent batches', async () => {
    await oldItems(5, 100);
    await superDb().query("update ufs_agent.settings set value = value || '{\"batch_size\":2}'::jsonb where key='retention'");
    const settings = await getSettings(workerDb());
    const runs = [];
    for (let i = 0; i < 4; i += 1) runs.push(await applyRetention(workerDb(), { settings }));
    assert.deepEqual(runs.map((r) => r.eventsRedacted), [2, 2, 1, 0]);
    assert.equal(runs[0].moreDue, true);
    for (const [table, col] of [['events', 'content_excerpt'], ['cases', 'summary'], ['drafts', 'proposed_answer']]) {
      assert.equal(await count(`select count(*) n from ufs_agent.${table} where ${col} like $1 or ${col} like $2`, [`%${PERSONAL}%`, `%${SUMMARY.slice(0, 30)}%`]), 0, table);
    }
    assert.equal(await count("select count(*) n from ufs_agent.events where redaction_reason='retention'"), 5);
    assert.equal(await count('select count(*) n from ufs_agent.privacy_suppressions'), 0, 'retention does not suppress future comments');
  });

  test('recent events are untouched; identifiers, suppressions, digests and notes expire on their own clocks', async () => {
    await oldItems(1, 10);
    const settings = await getSettings(workerDb());
    let r = await applyRetention(workerDb(), { settings });
    assert.equal(r.eventsRedacted, 0);
    assert.equal(await count('select count(*) n from ufs_agent.events where content_excerpt is not null'), 1);

    await superDb().query(`update ufs_agent.events set received_at = now() - interval '500 days'`);
    await superDb().query(`insert into ufs_agent.privacy_suppressions(channel_id, kind, value, expires_at) values ($1,'object','123_456', now() - interval '1 day')`, [channel.id]);
    await superDb().query(`insert into ufs_agent.digests(kind, period_key, status, body_text, generated_at) values ('daily','2025-01-01','dry_run','old body', now() - interval '120 days')`);
    await superDb().query(`insert into ufs_agent.external_notes(source_label, summary, created_by, created_at) values ('Some group','Old note text', $1, now() - interval '400 days')`, [mod.id]);
    r = await applyRetention(workerDb(), { settings });
    assert.equal(r.eventsRedacted, 1);
    assert.equal(r.identifiersPurged, 1, 'text first, then identifiers, in the same run');
    const e = await superDb().one('select external_object_id, idempotency_key, external_parent_id from ufs_agent.events');
    assert.match(e.external_object_id, /^purged:/);
    assert.match(e.idempotency_key, /^purged:/);
    assert.equal(e.external_parent_id, null);
    assert.equal(await count('select count(*) n from ufs_agent.privacy_suppressions'), 0);
    assert.equal((await superDb().one("select body_text from ufs_agent.digests where period_key='2025-01-01'")).body_text, '[expired]');
    assert.equal((await superDb().one('select summary from ufs_agent.external_notes')).summary, '[expired]');
    const again = await applyRetention(workerDb(), { settings });
    assert.equal(again.identifiersPurged + again.eventsRedacted + again.digestsExpired + again.notesExpired, 0, 'idempotent');
  });
});

describe('Open cases are closed by erasure', { skip: dbSkip }, () => {
  before(() => setTestEnv());
  beforeEach(() => resetDb());
  after(() => closeDbs());
  test('an open case on erased content becomes dismissed', async () => {
    const channel = await addChannel({ provider: 'facebook_page', external_account_id: String(8000 + Math.floor(Math.random() * 1e6)), permissions_verified: FB_PERMS });
    await deliver(channel, { message: `Open case text by ${PERSONAL}`, fromId: '333001' });
    await processQueue(mockRegistry());
    const kase = await superDb().one('select * from ufs_agent.cases');
    assert.ok(['open', 'awaiting_approval', 'escalated'].includes(kase.status));
    await superDb().query("select ufs_agent.redact_events(array[$1::uuid], 'data_subject_request', null)", [kase.event_id]);
    assert.equal((await superDb().one('select status from ufs_agent.cases')).status, 'dismissed');
  });
});
