import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, sign, fbCommentPayload, webhookRequest, APP_SECRET } from '../helpers.js';
import { handleVerify, handleEvent } from '../../../lib/agent/handlers/webhook.js';
import { verifyMetaSignature } from '../../../lib/agent/crypto.js';
import { parseMetaWebhook, WebhookPayloadError } from '../../../lib/agent/meta/webhook.js';
import { handleCron } from '../../../lib/agent/handlers/cron.js';

describe('Meta webhook verification (test 1)', () => {
  beforeEach(() => setTestEnv());

  test('valid challenge is echoed', async () => {
    const res = await handleVerify(new Request('https://x/api?hub.mode=subscribe&hub.verify_token=verify-token-for-tests&hub.challenge=12345'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '12345');
  });

  test('wrong verify token is rejected', async () => {
    const res = await handleVerify(new Request('https://x/api?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345'));
    assert.equal(res.status, 403);
  });

  test('missing configuration fails closed', async () => {
    setTestEnv({ META_VERIFY_TOKEN: undefined });
    const res = await handleVerify(new Request('https://x/api?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1'));
    assert.equal(res.status, 503);
  });
});

describe('Signature and payload validation (tests 2 and 4)', () => {
  beforeEach(() => setTestEnv());
  const noDb = { getDb: () => { throw new Error('db must not be reached'); } };

  test('signature over raw body verifies; tampered body fails', () => {
    const raw = Buffer.from(JSON.stringify(fbCommentPayload()));
    assert.equal(verifyMetaSignature(raw, sign(raw), APP_SECRET), true);
    const tampered = Buffer.from(raw.toString().replace('Hello', 'Hellp'));
    assert.equal(verifyMetaSignature(tampered, sign(raw), APP_SECRET), false);
    assert.equal(verifyMetaSignature(raw, 'sha256=zz', APP_SECRET), false);
    assert.equal(verifyMetaSignature(raw, undefined, APP_SECRET), false);
    assert.equal(verifyMetaSignature(raw, sign(raw, 'other-secret'), APP_SECRET), false);
  });

  test('invalid signature is rejected before any storage', async () => {
    const res = await handleEvent(webhookRequest(fbCommentPayload(), { secret: 'wrong' }), noDb);
    assert.equal(res.status, 401);
  });

  test('re-serialised JSON with a valid-looking signature of different bytes is rejected', async () => {
    const body = fbCommentPayload();
    const sig = sign(JSON.stringify(body, null, 2));
    const res = await handleEvent(webhookRequest(body, { signature: sig }), noDb);
    assert.equal(res.status, 401);
  });

  test('oversized payload is rejected with 413', async () => {
    const big = JSON.stringify({ object: 'page', entry: [], pad: 'x'.repeat(300 * 1024) });
    const res = await handleEvent(webhookRequest(big), noDb);
    assert.equal(res.status, 413);
  });

  test('non-JSON content type is rejected', async () => {
    const res = await handleEvent(webhookRequest('a=b', { contentType: 'application/x-www-form-urlencoded' }), noDb);
    assert.equal(res.status, 415);
  });

  test('signed but malformed JSON returns 400 without storage', async () => {
    const res = await handleEvent(webhookRequest('{"object":'), noDb);
    assert.equal(res.status, 400);
  });

  test('signed but structurally invalid payload is acknowledged and dropped', async () => {
    const res = await handleEvent(webhookRequest({ object: 'page', entry: 'nope' }), noDb);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).rejected, true);
  });

  test('parser keeps only bounded, minimal fields and pseudonymises the author', () => {
    const long = 'a'.repeat(5000);
    const { events } = parseMetaWebhook(fbCommentPayload({ message: long, fromId: '4242' }), { pepper: 'p' });
    assert.equal(events.length, 1);
    assert.equal(events[0].contentExcerpt.length, 2000);
    assert.match(events[0].authorRef, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(events[0]).includes('4242'));
    assert.ok(!JSON.stringify(events[0]).includes('Someone'));
  });

  test('parser rejects unsupported objects and ignores non-comment changes', () => {
    assert.throws(() => parseMetaWebhook({ object: 'user', entry: [{}] }), WebhookPayloadError);
    const { events, ignored } = parseMetaWebhook({ object: 'page', entry: [{ id: '1', changes: [{ field: 'feed', value: { item: 'status', verb: 'add' } }] }] });
    assert.equal(events.length, 0);
    assert.equal(ignored, 1);
  });

  test('page own comments are flagged so the agent never answers itself', () => {
    const { events } = parseMetaWebhook(fbCommentPayload({ pageId: '1111', fromId: '1111' }));
    assert.equal(events[0].authorIsPage, true);
  });

  test('edited comment produces a distinct idempotency key; identical redelivery does not', () => {
    const a = parseMetaWebhook(fbCommentPayload({ message: 'one' })).events[0];
    const b = parseMetaWebhook(fbCommentPayload({ message: 'one' })).events[0];
    const c = parseMetaWebhook(fbCommentPayload({ message: 'two', verb: 'edited' })).events[0];
    assert.equal(a.idempotencyKey, b.idempotencyKey);
    assert.notEqual(a.idempotencyKey, c.idempotencyKey);
  });
});

describe('Cron endpoint authentication', () => {
  beforeEach(() => setTestEnv());
  test('missing or wrong bearer token is rejected', async () => {
    const deps = { getDb: () => { throw new Error('unreachable'); } };
    assert.equal((await handleCron(new Request('https://x/api/agent/cron'), deps)).status, 401);
    assert.equal((await handleCron(new Request('https://x/api/agent/cron', { headers: { authorization: 'Bearer wrong' } }), deps)).status, 401);
  });
  test('short CRON_SECRET is treated as not configured', async () => {
    setTestEnv({ CRON_SECRET: 'short' });
    assert.equal((await handleCron(new Request('https://x/api/agent/cron', { headers: { authorization: 'Bearer short' } }), {})).status, 503);
  });
});
