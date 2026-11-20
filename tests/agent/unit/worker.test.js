import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { routeApi } from '../../../worker/index.js';
import { setTestEnv } from '../helpers.js';

const ctx = () => { const waits = []; return { waits, waitUntil: (p) => waits.push(p) }; };

test('non-API paths go to static assets and never touch agent code', async () => {
  const seen = [];
  const env = { ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('asset'); } } };
  for (const p of ['/', '/community.html', '/apis.html', '/api-docs']) {
    const res = await worker.fetch(new Request(`https://unitedforsitges.com${p}`), env, ctx());
    assert.equal(await res.text(), 'asset');
  }
  assert.deepEqual(seen, ['/', '/community.html', '/apis.html', '/api-docs']);
});

test('API routing: known routes, 404 for unknown, 405 with Allow for wrong method', async () => {
  const deps = () => ({ getDb: () => { throw new Error('no db in this test'); }, close: async () => {} });
  assert.equal((await routeApi(new Request('https://x/api/agent/unknown'), deps)).response.status, 404);
  const r = (await routeApi(new Request('https://x/api/agent/cron'), deps)).response;
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'POST');
  assert.equal((await routeApi(new Request('https://x/api/agent/meta-webhook', { method: 'DELETE' }), deps)).response.status, 405);
});

test('API requests use Worker bindings, fail closed without them, and release the per-request pool', async () => {
  setTestEnv({ META_VERIFY_TOKEN: undefined });
  const c = ctx();
  const env = { ASSETS: { fetch: async () => new Response('asset') } };
  const res = await worker.fetch(new Request('https://x/api/agent/meta-webhook?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=7'), env, c);
  assert.equal(res.status, 503);
  const res2 = await worker.fetch(new Request('https://x/api/agent/meta-webhook?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=7'), { ...env, META_VERIFY_TOKEN: 'abc' }, c);
  assert.equal(res2.status, 200);
  assert.equal(await res2.text(), '7');
  assert.equal(c.waits.length, 2, 'per-request deps are closed via waitUntil');
  await Promise.all(c.waits);
});

test('scheduled() does nothing unless AGENT_SCHEDULER_ENABLED is true', async () => {
  setTestEnv();
  const c = ctx();
  await worker.scheduled({ cron: '*/5 * * * *' }, {}, c);
  assert.equal(c.waits.length, 0);
  await worker.scheduled({ cron: '*/5 * * * *' }, { AGENT_SCHEDULER_ENABLED: 'yes please' }, c);
  assert.equal(c.waits.length, 0, 'only an explicit true-like value enables it');
});
