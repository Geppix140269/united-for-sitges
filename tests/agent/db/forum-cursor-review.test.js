import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, setTestEnv, resetDb, workerDb, superDb, closeDbs, addUser, addChannel } from '../helpers.js';
import { getSettings } from '../../../lib/agent/db.js';
import { ingestForum } from '../../../lib/agent/jobs.js';

describe('Security regression: forum keyset pagination', { skip: dbSkip }, () => {
  before(() => setTestEnv());
  beforeEach(async () => { await resetDb(); });
  after(() => closeDbs());

  test('never loses forum posts sharing the same created_at across 100-item pages', async () => {
    const member = await addUser({ moderator: true });
    const channel = await addChannel({
      provider: 'forum', external_account_id: 'forum-main', account_label: 'U4S forum',
      capabilities: {}, publishing_enabled: false, auto_reply_enabled: false,
    });
    const postedAt = new Date(Date.now() - 60000);
    // The production forum trigger requires actor=auth.uid(). Use a test JWT
    // within the transaction, and an authorised moderator to bypass rate limits.
    await superDb().tx(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [member.id]);
      await tx.query(
        `insert into public.ufs_topics(id, author_id, author_name, category, title, body, status, created_at)
         select md5('forum-cursor:' || n::text)::uuid, $1::uuid, 'Review User', 'questions',
                'Test topic number ' || n::text,
                'A test community message for reliable agent ingestion.',
                'pending', $2::timestamptz
         from generate_series(1,205) as n`,
        [member.id, postedAt],
      );
    });
    const settings = await getSettings(workerDb());
    const deps = { settings, now: new Date() };
    const batches = [];
    for (let i = 0; i < 4; i++) {
      batches.push((await ingestForum(workerDb(), deps)).inserted);
    }
    assert.deepEqual(batches, [100, 100, 5, 0]);
    const rows = await superDb().query('select count(*)::int as n from ufs_agent.events');
    assert.equal(rows[0].n, 205);
    const last = await superDb().one('select capabilities from ufs_agent.channels where id=$1', [channel.id]);
    assert.equal(last.capabilities.forum_cursor, postedAt.toISOString());
    assert.match(last.capabilities.forum_cursor_id, /^[0-9a-f-]{36}$/i);
  });
});
