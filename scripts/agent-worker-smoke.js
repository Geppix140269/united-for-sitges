// End-to-end smoke test of the real Worker in workerd (wrangler dev, local
// mode, no Cloudflare account, no deploy) against the throwaway test
// PostgreSQL. Proves: static site still served, server code not exposed,
// endpoints fail closed without configuration, a signed Meta webhook is
// stored through node-postgres inside workerd, the manual tick runs, and the
// scheduled() handler stays idle while AGENT_SCHEDULER_ENABLED is unset.
// Usage: AGENT_TEST_DATABASE_URL=... [AGENT_TEST_SUPER_URL=...] node scripts/agent-worker-smoke.js
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';

const DB = process.env.AGENT_TEST_DATABASE_URL;
const SUPER = process.env.AGENT_TEST_SUPER_URL || (DB ? DB.replace(/ufs_agent_worker:[^@]+@/, 'postgres@') : null);
if (!DB) { console.error('AGENT_TEST_DATABASE_URL is required'); process.exit(2); }

let PORT = 8790 + Math.floor(Math.random() * 100);
let BASE = `http://127.0.0.1:${PORT}`;
const APP_SECRET = 'worker-smoke-app-secret';
const CRON_SECRET = 's'.repeat(40);
const PAGE_ID = String(900000 + Math.floor(Math.random() * 99999));

let failed = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};

function startWorker(vars) {
  const args = ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--test-scheduled', '--log-level', 'log'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const env = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delete env[k];
  // Own process group so stop() also terminates wrangler's workerd child.
  const child = spawn('npx', args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.getLog = () => log;
  return child;
}

async function waitReady(child) {
  for (let i = 0; i < 90; i += 1) {
    try {
      const r = await fetch(`${BASE}/favicon.svg`);
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(child.getLog());
  throw new Error('wrangler dev did not start');
}

async function stop(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 1500));
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  // Next phase uses a fresh port so it can never hit a lingering instance.
  PORT += 1;
  BASE = `http://127.0.0.1:${PORT}`;
}

const sup = new pg.Client({ connectionString: SUPER });
await sup.connect();

// Phase 1: no configuration at all, everything must fail closed.
let w = startWorker({});
try {
  await waitReady(w);
  const home = await fetch(`${BASE}/`);
  check(home.status === 200 && (await home.text()).includes('United for Sitges'), 'static home page served by assets');
  check((await fetch(`${BASE}/community.html`)).status === 200, 'community page served');
  check((await fetch(`${BASE}/agent-console.html`)).status === 200, 'agent console page served');
  for (const p of ['/lib/agent/policy.js', '/worker/index.js', '/tests/agent/helpers.js', '/package.json', '/data/agent/faq-seed.json']) {
    const r = await fetch(`${BASE}${p}`);
    check(r.status === 404, `server/internal file not served: ${p}`, `status ${r.status}`);
  }
  const verify = await fetch(`${BASE}/api/agent/meta-webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`);
  check(verify.status === 503, 'webhook verification fails closed without config', `status ${verify.status}`);
  const post = await fetch(`${BASE}/api/agent/meta-webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check(post.status === 503, 'webhook POST fails closed without config', `status ${post.status}`);
  const admin = await fetch(`${BASE}/api/agent/admin`);
  check(admin.status === 503 || admin.status === 401, 'admin API refuses without config', `status ${admin.status}`);
  const cron = await fetch(`${BASE}/api/agent/cron`, { method: 'POST' });
  check(cron.status === 503, 'manual tick fails closed without CRON_SECRET', `status ${cron.status}`);
  check((await fetch(`${BASE}/api/agent/nope`)).status === 404, 'unknown API route is 404');
  check((await fetch(`${BASE}/api/agent/cron`)).status === 405, 'GET on cron route is 405');
} finally {
  await stop(w);
}

// Phase 2: test configuration against the local database.
await sup.query(
  `insert into ufs_agent.channels(provider, external_account_id, account_label, connection_status, ingest_enabled)
   values ('facebook_page',$1,'Worker smoke page','verified',true)`, [PAGE_ID],
);
w = startWorker({
  AGENT_DATABASE_URL: DB, META_APP_SECRET: APP_SECRET, META_VERIFY_TOKEN: 'smoke-verify', AGENT_AUTHOR_PEPPER: 'smoke-pepper',
  CRON_SECRET, NEON_AUTH_URL: 'https://neon-auth.invalid/neondb/auth',
});
try {
  await waitReady(w);
  const challenge = await fetch(`${BASE}/api/agent/meta-webhook?hub.mode=subscribe&hub.verify_token=smoke-verify&hub.challenge=4242`);
  check(challenge.status === 200 && (await challenge.text()) === '4242', 'webhook verification echoes challenge');
  const commentId = `${PAGE_ID}_${Date.now()}`;
  const body = JSON.stringify({ object: 'page', entry: [{ id: PAGE_ID, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: commentId, post_id: `${PAGE_ID}_1`, message: 'Where is the community forum?', from: { id: '123456' } } }] }] });
  const sig = `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
  const bad = await fetch(`${BASE}/api/agent/meta-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body });
  check(bad.status === 401, 'bad signature rejected in workerd', `status ${bad.status}`);
  for (let i = 0; i < 2; i += 1) {
    const r = await fetch(`${BASE}/api/agent/meta-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
    check(r.status === 200, `signed webhook accepted (delivery ${i + 1})`, `status ${r.status}`);
  }
  const stored = await sup.query('select count(*)::int as n from ufs_agent.events where external_object_id=$1', [commentId]);
  check(stored.rows[0].n === 1, 'event stored exactly once via node-postgres inside workerd', `rows ${stored.rows[0].n}`);
  const unauth = await fetch(`${BASE}/api/agent/cron`, { method: 'POST', headers: { authorization: 'Bearer wrong' } });
  check(unauth.status === 401, 'manual tick rejects wrong secret');
  const tick = await fetch(`${BASE}/api/agent/cron?jobs=events,actions`, { method: 'POST', headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const summary = await tick.json().catch(() => ({}));
  check(tick.status === 200 && summary.mode?.moderation === 'SHADOW', 'manual tick runs in SHADOW', `status ${tick.status}`);
  const kase = await sup.query('select c.category from ufs_agent.cases c join ufs_agent.events e on e.id=c.event_id where e.external_object_id=$1', [commentId]);
  check(kase.rows.length === 1, 'tick classified the stored event into one case', kase.rows[0]?.category);
  const admin = await fetch(`${BASE}/api/agent/admin`, { headers: { authorization: 'Bearer abc.def.ghi' } });
  check(admin.status === 401 || admin.status === 503, 'admin API refuses an invalid token', `status ${admin.status}`);
  const before = w.getLog().length;
  const sched = await fetch(`${BASE}/__scheduled?cron=*/5+*+*+*+*`);
  check(sched.status === 200, 'scheduled() handler invoked');
  // Logs are flushed asynchronously by wrangler; wait for the handler's line.
  // A late log line from the earlier manual tick may also land here, so only
  // a scheduled run (its log line carries "cron") counts as the scheduler running.
  for (let i = 0; i < 16 && !/agent_tick_skipped|"event":"agent_tick","cron"/.test(w.getLog().slice(before)); i += 1) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const after = w.getLog().slice(before);
  const idle = /agent_tick_skipped/.test(after) && !/"event":"agent_tick","cron"/.test(after);
  if (!idle) console.log(`--- log after /__scheduled ---\n${after.slice(-1500)}\n---`);
  check(idle, 'scheduled() stays idle while AGENT_SCHEDULER_ENABLED is unset');
} finally {
  await stop(w);
  await sup.query('delete from ufs_agent.cases where event_id in (select id from ufs_agent.events where channel_id in (select id from ufs_agent.channels where external_account_id=$1))', [PAGE_ID]);
  await sup.query('delete from ufs_agent.events where channel_id in (select id from ufs_agent.channels where external_account_id=$1)', [PAGE_ID]);
  await sup.query('delete from ufs_agent.channels where external_account_id=$1', [PAGE_ID]);
  await sup.end();
}

console.log(failed ? `\n${failed} worker check(s) failed` : '\nworker smoke checks passed');
process.exit(failed ? 1 : 0);
