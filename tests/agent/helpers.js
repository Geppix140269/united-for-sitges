// Shared test helpers. All providers, credentials and models are mocked.
// Database tests need AGENT_TEST_DATABASE_URL (see scripts/agent-test-db.sh)
// and are skipped when it is not set.

import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Db, createPool } from '../../lib/agent/db.js';
import { MockAdapter } from '../../lib/agent/adapters/mock.js';
import { validate } from '../../lib/agent/schema.js';

export const TEST_DB_URL = process.env.AGENT_TEST_DATABASE_URL;
export const SUPER_URL = process.env.AGENT_TEST_SUPER_URL || (TEST_DB_URL ? TEST_DB_URL.replace(/ufs_agent_worker:[^@]+@/, 'postgres@') : null);
if (process.env.AGENT_REQUIRE_DB === '1' && !TEST_DB_URL) {
  throw new Error('AGENT_REQUIRE_DB=1 but AGENT_TEST_DATABASE_URL is not set: database tests would be skipped');
}
export const dbSkip = TEST_DB_URL ? false : 'AGENT_TEST_DATABASE_URL not set (run: bash scripts/agent-test-db.sh start)';

export const APP_SECRET = 'test-app-secret-not-real';

export function sign(raw, secret = APP_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

export function setTestEnv(extra = {}) {
  const base = {
    META_APP_SECRET: APP_SECRET,
    META_VERIFY_TOKEN: 'verify-token-for-tests',
    AGENT_AUTHOR_PEPPER: 'pepper-for-tests',
    CRON_SECRET: 'c'.repeat(40),
    SUPABASE_URL: 'https://supabase.invalid',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    AGENT_LLM_ENABLED: 'true',
  };
  for (const [k, v] of Object.entries({ ...base, ...extra })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of ['AGENT_LIVE_META_REPLIES', 'AGENT_LIVE_META_PUBLISHING', 'AGENT_LIVE_INSTAGRAM_PUBLISHING', 'AGENT_LIVE_EMAIL', 'AGENT_ALLOW_SUPERVISED', 'AGENT_ALLOW_AUTONOMOUS']) {
    if (!(k in extra)) delete process.env[k];
  }
}

export function fbCommentPayload({ pageId = '1111', commentId = '1111_2222', message = 'Hello', fromId = '9999', verb = 'add' } = {}) {
  return {
    object: 'page',
    entry: [{ id: pageId, time: 1763300000, changes: [{ field: 'feed', value: { item: 'comment', verb, comment_id: commentId, post_id: '1111_3333', parent_id: '1111_3333', message, from: { id: fromId, name: 'Someone' }, created_time: 1763300000 } }] }],
  };
}

export function webhookRequest(body, { secret = APP_SECRET, signature, contentType = 'application/json' } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://unitedforsitges.com/api/agent/meta-webhook', {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-hub-signature-256': signature ?? sign(raw, secret) },
    body: raw,
  });
}

// Fake model: a function (kind, args) -> value | Error. kind derived from schema.
export class FakeModel {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }
  async structured(args) {
    const kind = args.schema.properties.reply_text ? 'draft' : args.schema.properties.facebook_text ? 'content' : 'classify';
    this.calls.push({ kind, ...args });
    const out = await this.handler(kind, args);
    if (out instanceof Error) throw out;
    // Mirrors AnthropicModelClient: output must pass strict schema validation.
    const { parseAndValidate } = await import('../../lib/agent/llm.js');
    return { value: parseAndValidate(typeof out === 'string' ? out : JSON.stringify(out), args.schema), usage: { input: 10, output: 5 } };
  }
}

export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const route = typeof routes === 'function' ? routes(u, init) : routes[u];
    if (!route) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (route instanceof Error) throw route;
    const body = route.body instanceof Uint8Array || typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {});
    return new Response(body, { status: route.status || 200, headers: route.headers || { 'content-type': route.contentType || 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

// Network double for safeGet: a resolver returning a public address and a
// transport serving canned responses. safeGet's checks still run in full.
export const PUBLIC_IP = '93.184.216.34';
export function fakeNet(routes, { address = PUBLIC_IP } = {}) {
  const calls = [];
  const resolver = async () => [{ address, family: 4 }];
  const transport = async (url) => {
    calls.push(url.toString());
    const route = typeof routes === 'function' ? routes(url.toString()) : routes[url.toString()];
    if (!route) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
    if (route instanceof Error) throw route;
    const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? ''));
    return { status: route.status || 200, headers: { 'content-type': route.contentType || 'text/html', ...(route.headers || {}) }, body };
  };
  return { resolver, transport, calls };
}

let pool = null;
let superPool = null;
let defaultSettings = null;

export function workerDb() {
  if (!pool) pool = createPool(TEST_DB_URL, { max: 4 });
  return new Db(pool);
}

export function superDb() {
  if (!superPool) superPool = createPool(SUPER_URL, { max: 2 });
  return new Db(superPool);
}

export async function closeDbs() {
  if (pool) await pool.end();
  if (superPool) await superPool.end();
  pool = null;
  superPool = null;
}

const AGENT_TABLES = ['publication_metrics', 'publications', 'content', 'editorial_calendar', 'actions', 'drafts', 'cases', 'events', 'faq', 'sources',
  'channels', 'audit_log', 'usage_counters', 'digests', 'external_notes'];

export async function resetDb() {
  const s = superDb();
  if (!defaultSettings) defaultSettings = await s.query('select key, value from ufs_agent.settings');
  await s.query(`truncate ${AGENT_TABLES.map((t) => `ufs_agent.${t}`).join(', ')} cascade`);
  for (const row of defaultSettings) await s.query('update ufs_agent.settings set value=$2 where key=$1', [row.key, row.value]);
  await s.query('truncate public.ufs_reports, public.ufs_replies, public.ufs_topics, public.ufs_profiles cascade');
  await s.query('delete from auth.users');
}

export async function patchSetting(key, patch) {
  await superDb().query('update ufs_agent.settings set value = value || $2::jsonb where key=$1', [key, JSON.stringify(patch)]);
}

export async function addChannel(overrides = {}) {
  const ch = {
    provider: 'mock', external_account_id: `acct-${randomUUID().slice(0, 8)}`, account_label: 'Mock Page', connection_status: 'verified',
    capabilities: { reply: true, publish: true }, ingest_enabled: true, auto_reply_enabled: false, publishing_enabled: true, paused: false,
    token_status: 'valid', permissions_verified: [], language_preference: 'en', credential_ref: null, ...overrides,
  };
  return superDb().one(
    `insert into ufs_agent.channels(provider, external_account_id, account_label, connection_status, capabilities, ingest_enabled, auto_reply_enabled,
       publishing_enabled, paused, token_status, permissions_verified, language_preference, credential_ref)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [ch.provider, ch.external_account_id, ch.account_label, ch.connection_status, JSON.stringify(ch.capabilities), ch.ingest_enabled, ch.auto_reply_enabled,
      ch.publishing_enabled, ch.paused, ch.token_status, JSON.stringify(ch.permissions_verified), ch.language_preference, ch.credential_ref],
  );
}

export async function addApprovedFaq({ slug = 'what-is-u4s', phrases = ['what is united for sitges'], answer = 'United for Sitges is an independent, non-partisan civic information initiative.', language = 'en', channels = ['mock', 'facebook_page'], expiresInDays = 30, approvedDaysAgo = 1, isFactual = false, sourceVerifiedDaysAgo = null } = {}) {
  const { textFingerprint } = await import('../../lib/agent/crypto.js');
  return superDb().one(
    `insert into ufs_agent.faq(slug, canonical_question, match_phrases, approved_answer, language, allowed_channels, active, approved_by, approved_at, expires_at, answer_fingerprint, is_factual, source_url, source_verified_at)
     values ($1,$2,$3,$4,$5,$6,true,$7, now() - make_interval(days => $8), now() + make_interval(days => $9), $10, $11, $12, $13) returning *`,
    [slug, phrases[0], phrases, answer, language, channels, randomUUID(), approvedDaysAgo, expiresInDays, textFingerprint(answer), isFactual,
      isFactual ? 'https://unitedforsitges.com/' : null, sourceVerifiedDaysAgo == null ? null : new Date(Date.now() - sourceVerifiedDaysAgo * 86400000)],
  );
}

export function mockRegistry() {
  const map = new Map();
  const adapterFor = (channel) => {
    if (!map.has(channel.id)) map.set(channel.id, new MockAdapter({ accountId: channel.external_account_id }));
    return map.get(channel.id);
  };
  adapterFor.map = map;
  return adapterFor;
}

export async function addUser({ email = `${randomUUID().slice(0, 8)}@example.test`, moderator = false, suspended = false } = {}) {
  const id = randomUUID();
  const s = superDb();
  await s.query('insert into auth.users(id, email, email_confirmed_at) values ($1,$2,now())', [id, email]);
  await s.query('insert into public.ufs_profiles(user_id, display_name, is_moderator, is_suspended) values ($1,$2,$3,$4)', [id, `User ${id.slice(0, 6)}`, moderator, suspended]);
  return { id, email };
}

export function adminRequest(method, { token = 'valid-token-abcdefghijklmnop', query = '', body } = {}) {
  return new Request(`https://unitedforsitges.com/api/agent/admin${query}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'https://unitedforsitges.com' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export { validate, pg };
