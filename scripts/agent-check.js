// Static checks for the Community Agent (npm run check). No network, no
// database, no credentials. Exits non-zero on any failure.
//  1. Every agent JavaScript file parses (node --check).
//  2. Agent data files are valid and internally consistent.
//  3. All live outbound switches are OFF when no environment is set.
//  4. The migration ships every outbound default as OFF / SHADOW.
//  5. Cloudflare config: Worker only on /api/*, no Cron Triggers, scheduler
//     gated by AGENT_SCHEDULER_ENABLED, server code excluded from public assets.
//  6. No credential-shaped strings in agent files; no em dashes (house style).

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const failures = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => console.log(`ok   ${msg}`);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const agentFiles = [
  ...walk(join(root, 'lib/agent')), ...walk(join(root, 'worker')), ...walk(join(root, 'tests/agent')),
  ...walk(join(root, 'data/agent')),
  ...['js/agent-console.js', 'agent-console.html', 'scripts/agent-check.js', 'scripts/agent-seed.js', 'scripts/agent-test-db.sh', 'scripts/agent-render-cards.js',
    'scripts/agent-site-smoke.js', 'scripts/agent-worker-smoke.js', 'neon/agent-schema.sql', '.github/workflows/agent-ci.yml', 'package.json', 'wrangler.jsonc', '.assetsignore']
    .map((f) => join(root, f)).filter(existsSync),
  ...walk(join(root, 'docs')).filter((f) => /COMMUNITY_AGENT_/.test(f)),
];

// 1. Syntax
let jsCount = 0;
for (const f of agentFiles.filter((p) => p.endsWith('.js'))) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  jsCount += 1;
  if (r.status !== 0) fail(`syntax error in ${relative(root, f)}: ${r.stderr.split('\n')[0]}`);
}
ok(`${jsCount} JavaScript files parse`);

// 2. Data files
try {
  const sources = JSON.parse(readFileSync(join(root, 'data/agent/sources.json'), 'utf8')).sources;
  const topics = JSON.parse(readFileSync(join(root, 'data/agent/editorial-topics.json'), 'utf8')).topics;
  const faq = JSON.parse(readFileSync(join(root, 'data/agent/faq-seed.json'), 'utf8')).faq;
  const slugs = new Set(sources.map((s) => s.slug));
  if (slugs.size !== sources.length) fail('duplicate source slugs');
  for (const s of sources) {
    if (!/^https:\/\//.test(s.url)) fail(`source ${s.slug} is not https`);
    if ('active' in s || 'verified_at' in s) fail(`source seed ${s.slug} must not pre-activate or pre-verify`);
  }
  const keys = new Set();
  for (const t of topics) {
    if (keys.has(t.key)) fail(`duplicate topic ${t.key}`);
    keys.add(t.key);
    if (!['morning', 'evening'].includes(t.slot)) fail(`topic ${t.key} has invalid slot`);
    for (const s of t.sources) if (!slugs.has(s)) fail(`topic ${t.key} references unknown source ${s}`);
    if (t.factual && !t.sources.length) fail(`factual topic ${t.key} has no sources`);
  }
  for (const f of faq) if ('active' in f || 'approved_by' in f) fail(`FAQ seed ${f.slug} must not be pre-approved`);
  ok(`data files valid (${sources.length} sources, ${topics.length} topics, ${faq.length} proposed FAQ)`);
} catch (err) {
  fail(`data files invalid: ${err.message}`);
}

// 3. Live switches default OFF
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AGENT_|^META_|^RESEND_|^ANTHROPIC_/.test(k)));
const sw = spawnSync(process.execPath, ['--input-type=module', '-e',
  "import { liveSwitches } from './lib/agent/config.js'; console.log(JSON.stringify(liveSwitches()));"], { cwd: root, env: cleanEnv, encoding: 'utf8' });
try {
  const switches = JSON.parse(sw.stdout);
  for (const [k, v] of Object.entries(switches)) if (v !== false) fail(`live switch ${k} is not off by default`);
  ok(`live switches off by default: ${Object.keys(switches).join(', ')}`);
} catch {
  fail(`could not evaluate live switches: ${sw.stderr}`);
}

// 4. Migration defaults
const mig = readFileSync(join(root, 'neon/agent-schema.sql'), 'utf8');
const mustContain = {
  "moderation mode SHADOW": "jsonb_build_object('mode','SHADOW','auto_reply_enabled',false)",
  'publishing mode SHADOW': "'mode','SHADOW',\n    'autonomous_publishing_enabled',false",
  'emergency stop row exists': "('emergency_stop', jsonb_build_object('active',false))",
  'digest email off': "jsonb_build_object('send_enabled',false",
  'forum publishing off': "'forum_publishing_enabled',false",
  'channel ingest off': 'ingest_enabled boolean not null default false',
  'channel auto replies off': 'auto_reply_enabled boolean not null default false',
  'channel publishing off': 'publishing_enabled boolean not null default false',
  'worker role cannot log in': 'create role ufs_agent_worker nologin',
};
for (const [label, needle] of Object.entries(mustContain)) {
  if (!mig.includes(needle)) fail(`migration default missing: ${label}`);
}
if (/'mode','(SUPERVISED|AUTONOMOUS)'/.test(mig)) fail('migration enables an outbound mode');
ok('migration ships outbound defaults OFF / SHADOW');

// 5. Deployment configuration (Cloudflare Workers)
try {
  const wr = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  if (wr.triggers && Array.isArray(wr.triggers.crons) && wr.triggers.crons.length) fail('wrangler.jsonc defines Cron Triggers (scheduler must stay off)');
  if (wr.main !== 'worker/index.js') fail('wrangler.jsonc main is not worker/index.js');
  const rwf = wr.assets && wr.assets.run_worker_first;
  if (!Array.isArray(rwf) || rwf.length !== 1 || rwf[0] !== '/api/*') fail('Worker must run first only for /api/*');
  if (!(wr.compatibility_flags || []).includes('nodejs_compat')) fail('nodejs_compat flag missing');
  if (wr.vars && Object.keys(wr.vars).some((k) => /^AGENT_(LIVE|ALLOW|LLM|SCHEDULER)/.test(k))) fail('wrangler.jsonc sets an activation variable');
} catch (err) {
  fail(`wrangler.jsonc unreadable: ${err.message}`);
}
const ignore = readFileSync(join(root, '.assetsignore'), 'utf8').split('\n').map((l) => l.trim());
for (const p of ['lib', 'worker', 'tests', 'node_modules', 'data/agent', 'package.json']) if (!ignore.includes(p)) fail(`.assetsignore must exclude ${p}`);
const workerSrc = readFileSync(join(root, 'worker/index.js'), 'utf8');
if (!/boolEnv\('AGENT_SCHEDULER_ENABLED'\)/.test(workerSrc)) fail('scheduled() is not gated by AGENT_SCHEDULER_ENABLED');
if (existsSync(join(root, 'vercel.json'))) fail('vercel.json present (hosting is Cloudflare)');
if (existsSync(join(root, 'api'))) fail('legacy api/ directory present (endpoints live in worker/index.js)');
ok('Cloudflare: Worker only on /api/*, no Cron Triggers, scheduler gated, server code excluded from assets');

// 6. Secrets and style
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, 'Anthropic key'], [/sb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key'],
  [/EAA[A-Za-z0-9]{30,}/, 'Meta access token'], [/\bre_[A-Za-z0-9]{20,}/, 'Resend key'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/service_role"?\s*[:=]\s*"?eyJ/, 'service role JWT'], [/postgres(?:ql)?:\/\/[^:\s]+:(?!agent_test_only|postgres@)[^@\s]{6,}@(?!localhost|127\.0\.0\.1)/, 'database URL with password'],
];
let scanned = 0;
for (const f of agentFiles) {
  if (/\.(jpg|png)$/.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  scanned += 1;
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) fail(`${label} pattern in ${relative(root, f)}`);
  if (text.includes(String.fromCharCode(0x2014))) fail(`em dash in ${relative(root, f)}`);
}
ok(`${scanned} agent files scanned: no credential patterns, no em dashes`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('\nagent checks passed');
