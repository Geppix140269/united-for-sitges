import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, setTestEnv, workerDb, superDb, closeDbs, resetDb, addUser, addChannel, adminRequest, mockRegistry } from '../helpers.js';
import { handleAdmin } from '../../../lib/agent/handlers/admin.js';
import { AuthError } from '../../../lib/agent/auth.js';

async function asRole(role, uid, sql, params = []) {
  return superDb().tx(async (t) => {
    await t.query(`set local role ${role}`);
    if (uid) {
      await t.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      await t.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role })]);
    }
    return t.query(sql, params);
  });
}

describe('Database security boundary', { skip: dbSkip }, () => {
  before(() => setTestEnv());
  beforeEach(() => resetDb());
  after(() => closeDbs());

  test('anonymous and authenticated (Neon Data API roles) have no access to any agent table (tests 9 and 10)', async () => {
    const tables = await superDb().query("select tablename from pg_tables where schemaname='ufs_agent'");
    assert.ok(tables.length >= 16);
    for (const role of ['anonymous', 'authenticated']) {
      for (const { tablename } of tables) {
        await assert.rejects(asRole(role, null, `select 1 from ufs_agent.${tablename} limit 1`), /permission denied/, `${role} ${tablename}`);
      }
      await assert.rejects(asRole(role, null, 'select ufs_agent.is_active_moderator(gen_random_uuid())'), /permission denied/);
    }
  });

  test('fresh installation ships every outbound path OFF (moderation SHADOW, publishing SHADOW, no email, no channel enabled)', async () => {
    const rows = Object.fromEntries((await superDb().query('select key, value from ufs_agent.settings')).map((r) => [r.key, r.value]));
    assert.equal(rows.moderation.mode, 'SHADOW');
    assert.equal(rows.moderation.auto_reply_enabled, false);
    assert.equal(rows.publishing.mode, 'SHADOW');
    assert.equal(rows.publishing.autonomous_publishing_enabled, false);
    assert.equal(rows.publishing.forum_publishing_enabled, false);
    assert.equal(rows.emergency_stop.active, false);
    assert.equal(rows.digest.send_enabled, false);
    const ch = await superDb().one("insert into ufs_agent.channels(provider, external_account_id, account_label) values ('facebook_page','5555','Defaults check') returning *");
    assert.equal(ch.ingest_enabled, false);
    assert.equal(ch.auto_reply_enabled, false);
    assert.equal(ch.publishing_enabled, false);
    assert.equal(ch.connection_status, 'unverified');
    assert.equal(ch.token_status, 'unknown');
    assert.deepEqual(ch.capabilities, {});
    await assert.rejects(superDb().query("update ufs_agent.settings set value = jsonb_set(value, '{mode}', '\"FULLY_AUTONOMOUS\"') where key='moderation'"), /check constraint/);
  });

  test('RLS is enabled and forced on every agent table', async () => {
    const rows = await superDb().query("select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='ufs_agent' and c.relkind='r'");
    for (const r of rows) {
      assert.equal(r.relrowsecurity, true, r.relname);
      assert.equal(r.relforcerowsecurity, true, r.relname);
    }
  });

  test('worker role cannot read or write forum tables directly, only through the bridge', async () => {
    await assert.rejects(workerDb().query('select * from public.ufs_topics'), /permission denied/);
    await assert.rejects(workerDb().query("update public.ufs_topics set status='approved'"), /permission denied/);
    await assert.rejects(workerDb().query('select * from neon_auth."user"'), /permission denied/);
    await assert.rejects(workerDb().query('select * from ufs_internal.admin_contact'), /permission denied/);
    const rows = await workerDb().query("select * from ufs_agent.forum_items_since(now() - interval '1 day', '00000000-0000-0000-0000-000000000000'::uuid, 10)");
    assert.ok(Array.isArray(rows));
  });

  test('worker cannot rewrite or recently delete audit history', async () => {
    await workerDb().query("insert into ufs_agent.audit_log(actor_type, action, entity_type) values ('system','test_entry','test')");
    await assert.rejects(workerDb().query("update ufs_agent.audit_log set action='tampered'"), /append-only|permission denied/);
    await assert.rejects(superDb().query("update ufs_agent.audit_log set action='tampered'"), /append-only/);
    await assert.rejects(workerDb().query('delete from ufs_agent.audit_log'), /cannot be deleted/);
  });

  test('credential references cannot hold token values', async () => {
    await assert.rejects(addChannel({ credential_ref: 'EAABwzLixnjYBO0ZCZBexampletoken' }), /check constraint/);
    const ok = await addChannel({ credential_ref: 'env:META_PAGE_ACCESS_TOKEN' });
    assert.equal(ok.credential_ref, 'env:META_PAGE_ACCESS_TOKEN');
  });

  test('existing forum registration and moderation keep working (test 21)', async () => {
    const member = await addUser();
    const mod = await addUser({ moderator: true });
    // Member submits a pending topic through the normal RLS path.
    await asRole('authenticated', member.id, `insert into public.ufs_topics(author_id, author_name, category, title, body)
      values ($1, (select display_name from public.ufs_profiles where user_id=$1), 'living', 'Beach cleaning schedule', 'When are the beaches cleaned during the winter months?')`, [member.id]);
    assert.equal((await asRole('anonymous', null, 'select id from public.ufs_topics')).length, 0, 'pending topic hidden from public');
    // Ordinary member cannot approve.
    await asRole('authenticated', member.id, "update public.ufs_topics set status='approved'");
    assert.equal((await superDb().query("select status from public.ufs_topics"))[0].status, 'pending');
    // Moderator approves.
    await asRole('authenticated', mod.id, "update public.ufs_topics set status='approved'");
    assert.equal((await asRole('anonymous', null, 'select id from public.ufs_topics')).length, 1);
    // Agent can see it through the bridge for triage, without changing it.
    const items = await workerDb().query("select kind, status from ufs_agent.forum_items_since(now() - interval '1 hour', '00000000-0000-0000-0000-000000000000'::uuid, 10)");
    assert.equal(items[0].kind, 'topic');
  });
});

describe('Admin API authorisation (tests 8, 9, 10)', { skip: dbSkip }, () => {
  let users;
  const tokens = new Map();
  const deps = () => ({
    getDb: () => workerDb(),
    adapterFor: mockRegistry(),
    verifyUser: async (token) => {
      if (!tokens.has(token)) throw new AuthError(401, 'invalid_token');
      return tokens.get(token);
    },
  });
  before(() => setTestEnv());
  beforeEach(async () => {
    await resetDb();
    users = { member: await addUser(), mod: await addUser({ moderator: true }), suspended: await addUser({ moderator: true, suspended: true }), unverified: await addUser({ moderator: true, verified: false }), banned: await addUser({ moderator: true, banned: true }) };
    tokens.clear();
    tokens.set('member-token-xxxxxxxxxxxxxxxx', { id: users.member.id });
    tokens.set('mod-token-xxxxxxxxxxxxxxxxxxx', { id: users.mod.id });
    tokens.set('suspended-token-xxxxxxxxxxxxx', { id: users.suspended.id });
    tokens.set('unverified-token-xxxxxxxxxxxx', { id: users.unverified.id });
    tokens.set('banned-token-xxxxxxxxxxxxxxxx', { id: users.banned.id });
  });
  after(() => closeDbs());

  test('no token or an invalid token is 401', async () => {
    const res = await handleAdmin(new Request('https://unitedforsitges.com/api/agent/admin'), deps());
    assert.equal(res.status, 401);
    assert.equal((await handleAdmin(adminRequest('GET', { token: 'bogus-token-xxxxxxxxxxxxxxxx' }), deps())).status, 401);
  });

  test('ordinary members and suspended, unverified or banned moderators cannot read cases', async () => {
    for (const token of ['member-token-xxxxxxxxxxxxxxxx', 'suspended-token-xxxxxxxxxxxxx', 'unverified-token-xxxxxxxxxxxx', 'banned-token-xxxxxxxxxxxxxxxx']) {
      const res = await handleAdmin(adminRequest('GET', { token, query: '?view=cases' }), deps());
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, 'not_moderator');
    }
  });

  test('ordinary member cannot approve, publish or stop anything', async () => {
    for (const body of [{ action: 'draft_approve', draft_id: '00000000-0000-0000-0000-000000000000', fingerprint: 'a'.repeat(64) }, { action: 'set_emergency_stop', active: false }, { action: 'set_publishing', mode: 'AUTONOMOUS' }]) {
      const res = await handleAdmin(adminRequest('POST', { token: 'member-token-xxxxxxxxxxxxxxxx', body }), deps());
      assert.equal(res.status, 403);
    }
  });

  test('moderator can read overview and toggle the emergency stop, which is audited', async () => {
    const tok = 'mod-token-xxxxxxxxxxxxxxxxxxx';
    const ov = await handleAdmin(adminRequest('GET', { token: tok }), deps());
    assert.equal(ov.status, 200);
    const body = await ov.json();
    assert.equal(body.settings.moderation.mode, 'SHADOW');
    assert.equal(body.settings.publishing.mode, 'SHADOW');
    const res = await handleAdmin(adminRequest('POST', { token: tok, body: { action: 'set_emergency_stop', active: true, reason: 'test stop' } }), deps());
    assert.equal(res.status, 200);
    const audit = await superDb().query("select actor_id, detail from ufs_agent.audit_log where action='setting_changed'");
    assert.equal(audit[0].actor_id, users.mod.id);
  });

  test('SUPERVISED and AUTONOMOUS cannot be enabled without deployment authorisation and confirmation', async () => {
    const tok = 'mod-token-xxxxxxxxxxxxxxxxxxx';
    let res = await handleAdmin(adminRequest('POST', { token: tok, body: { action: 'set_moderation_mode', mode: 'SUPERVISED', confirm: 'ENABLE SUPERVISED MODERATION' } }), deps());
    assert.equal((await res.json()).error, 'supervised_not_authorised_for_this_deployment');
    res = await handleAdmin(adminRequest('POST', { token: tok, body: { action: 'set_publishing', mode: 'AUTONOMOUS', confirm: 'ENABLE AUTONOMOUS PUBLISHING' } }), deps());
    assert.equal((await res.json()).error, 'autonomous_not_authorised_for_this_deployment');
    setTestEnv({ AGENT_ALLOW_SUPERVISED: 'true' });
    res = await handleAdmin(adminRequest('POST', { token: tok, body: { action: 'set_moderation_mode', mode: 'SUPERVISED' } }), deps());
    assert.equal((await res.json()).error, 'confirmation_required');
    setTestEnv();
  });

  test('cross-origin writes are refused', async () => {
    const req = new Request('https://unitedforsitges.com/api/agent/admin', { method: 'POST', headers: { authorization: 'Bearer mod-token-xxxxxxxxxxxxxxxxxxx', origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'set_emergency_stop', active: true, reason: 'x y z' }) });
    assert.equal((await handleAdmin(req, deps())).status, 403);
  });
});
