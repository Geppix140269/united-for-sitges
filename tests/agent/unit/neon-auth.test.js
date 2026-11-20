import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyNeonAuthToken, requireModerator, AuthError, _clearJwksCache } from '../../../lib/agent/auth.js';

const AUTH_URL = 'https://ep-test.neonauth.example/neondb/auth';
const JWKS_URL = `${AUTH_URL}/.well-known/jwks.json`;
const USER = '6f9619ff-8b86-4d11-b42d-00c04fc964ff';

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function keypair(kid) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { kid, privateKey: kp.privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', x: pub.x, kid, alg: 'EdDSA' } };
}

async function sign(key, claims, header = {}) {
  const h = enc({ alg: 'EdDSA', kid: key.kid, typ: 'JWT', ...header });
  const p = enc(claims);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

function jwksFetch(keys, counter = { n: 0 }) {
  const fn = async (url) => {
    counter.n += 1;
    assert.equal(url, JWKS_URL);
    return Response.json({ keys: keys.map((k) => k.jwk) });
  };
  fn.counter = counter;
  return fn;
}

const now = Date.UTC(2026, 10, 20, 10, 0, 0);
const valid = (over = {}) => ({ sub: USER, email: 'mod@example.test', iat: now / 1000 - 10, exp: now / 1000 + 900, ...over });

describe('Neon Auth JWT verification', () => {
  let key;
  beforeEach(async () => {
    _clearJwksCache();
    key = await keypair('k1');
  });

  test('a valid Ed25519 token from the published JWKS yields the user id', async () => {
    const token = await sign(key, valid());
    assert.deepEqual(await verifyNeonAuthToken(token, { authUrl: AUTH_URL, fetchImpl: jwksFetch([key]), now }), { id: USER });
  });

  test('expired, not-yet-valid and future-issued tokens are rejected', async () => {
    for (const [claims, code] of [[valid({ exp: now / 1000 - 120 }), 'token_expired'], [valid({ nbf: now / 1000 + 600 }), 'invalid_token'], [valid({ iat: now / 1000 + 600 }), 'invalid_token'], [valid({ exp: undefined }), 'token_expired']]) {
      const token = await sign(key, claims);
      await assert.rejects(verifyNeonAuthToken(token, { authUrl: AUTH_URL, fetchImpl: jwksFetch([key]), now }), (e) => e instanceof AuthError && e.code === code);
    }
  });

  test('tampered payload, foreign key, alg none and malformed tokens are rejected', async () => {
    const token = await sign(key, valid());
    const [h, , s] = token.split('.');
    const forged = `${h}.${enc(valid({ sub: '00000000-0000-4000-8000-000000000000' }))}.${s}`;
    await assert.rejects(verifyNeonAuthToken(forged, { authUrl: AUTH_URL, fetchImpl: jwksFetch([key]), now }), (e) => e.code === 'invalid_token');
    const other = await keypair('k1'); // same kid, different key
    await assert.rejects(verifyNeonAuthToken(await sign(other, valid()), { authUrl: AUTH_URL, fetchImpl: jwksFetch([key]), now }), (e) => e.code === 'invalid_token');
    const none = `${enc({ alg: 'none', kid: 'k1' })}.${enc(valid())}.`;
    await assert.rejects(verifyNeonAuthToken(none, { authUrl: AUTH_URL, fetchImpl: jwksFetch([key]), now }), AuthError);
    const hs = await sign(key, valid(), { alg: 'HS256' });
    await assert.rejects(verifyNeonAuthToken(hs, { authUrl: AUTH_URL, fetchImpl: jwksFetch([key]), now }), (e) => e.code === 'invalid_token');
    await assert.rejects(verifyNeonAuthToken('not-a-jwt', { authUrl: AUTH_URL, fetchImpl: jwksFetch([key]), now }), (e) => e.code === 'missing_token');
  });

  test('unknown kid refetches the JWKS once (key rotation) and then fails closed', async () => {
    const rotated = await keypair('k2');
    const counter = { n: 0 };
    const keys = [key];
    const fetchImpl = jwksFetch(keys, counter);
    await verifyNeonAuthToken(await sign(key, valid()), { authUrl: AUTH_URL, fetchImpl, now });
    keys.push(rotated);
    assert.deepEqual(await verifyNeonAuthToken(await sign(rotated, valid()), { authUrl: AUTH_URL, fetchImpl, now }), { id: USER });
    assert.equal(counter.n, 2);
    const ghost = await keypair('k9');
    await assert.rejects(verifyNeonAuthToken(await sign(ghost, valid()), { authUrl: AUTH_URL, fetchImpl, now }), (e) => e.code === 'invalid_token');
  });

  test('issuer and audience are enforced when configured; subject must be a uuid', async () => {
    const t = await sign(key, valid({ iss: 'https://other.example', aud: 'x' }));
    await assert.rejects(verifyNeonAuthToken(t, { authUrl: AUTH_URL, issuer: 'https://unitedforsitges.com', fetchImpl: jwksFetch([key]), now }), (e) => e.code === 'invalid_token');
    await assert.rejects(verifyNeonAuthToken(t, { authUrl: AUTH_URL, audience: 'u4s', fetchImpl: jwksFetch([key]), now }), (e) => e.code === 'invalid_token');
    await assert.rejects(verifyNeonAuthToken(await sign(key, valid({ sub: 'admin' })), { authUrl: AUTH_URL, fetchImpl: jwksFetch([key]), now }), (e) => e.code === 'invalid_token');
  });

  test('missing configuration or unreachable JWKS fails closed with 503', async () => {
    const token = await sign(key, valid());
    await assert.rejects(verifyNeonAuthToken(token, { authUrl: undefined, fetchImpl: jwksFetch([key]), now }), (e) => e.status === 503);
    await assert.rejects(verifyNeonAuthToken(token, { authUrl: 'http://insecure.example', fetchImpl: jwksFetch([key]), now }), (e) => e.status === 503);
    await assert.rejects(verifyNeonAuthToken(token, { authUrl: AUTH_URL, fetchImpl: async () => new Response('down', { status: 500 }), now }), (e) => e.status === 503);
  });

  test('a valid token is still refused when the database says the user is not an active moderator', async () => {
    const token = await sign(key, valid());
    const req = new Request('https://unitedforsitges.com/api/agent/admin', { headers: { authorization: `Bearer ${token}` } });
    const db = { one: async (sql, params) => { assert.match(sql, /is_active_moderator/); assert.deepEqual(params, [USER]); return { ok: false }; } };
    await assert.rejects(requireModerator(db, req, { authOptions: { authUrl: AUTH_URL, fetchImpl: jwksFetch([key]), now } }), (e) => e.status === 403 && e.code === 'not_moderator');
    const okDb = { one: async () => ({ ok: true }) };
    assert.deepEqual(await requireModerator(okDb, req, { authOptions: { authUrl: AUTH_URL, fetchImpl: jwksFetch([key]), now } }), { id: USER });
  });
});
