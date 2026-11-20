// Admin authorisation. Identity comes ONLY from a Neon Auth (Better Auth)
// session JWT, verified here against Neon Auth's published JWKS (EdDSA,
// Ed25519) with WebCrypto, so it works on Cloudflare Workers and in Node.
// Moderator status comes ONLY from public.ufs_profiles (is_moderator and not
// is_suspended) plus a verified, non-banned neon_auth user, read through
// ufs_agent.is_active_moderator. Token claims such as roles or metadata,
// client flags and request bodies are never trusted for authorisation.

import { env } from './config.js';

export class AuthError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map(); // url -> { keys, fetchedAt }

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part) {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
  } catch {
    throw new AuthError(401, 'invalid_token');
  }
}

async function loadJwks(url, fetchImpl, { force = false, now = Date.now() } = {}) {
  const cached = jwksCache.get(url);
  if (cached && !force && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch {
    throw new AuthError(503, 'auth_unavailable');
  }
  if (!res.ok) throw new AuthError(503, 'auth_unavailable');
  const data = await res.json().catch(() => null);
  const keys = Array.isArray(data?.keys) ? data.keys.filter((k) => k && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string' && typeof k.kid === 'string') : [];
  jwksCache.set(url, { keys, fetchedAt: now });
  return keys;
}

async function importEd25519(jwk) {
  const material = { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  try {
    return await crypto.subtle.importKey('jwk', material, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    // Older workerd naming.
    return crypto.subtle.importKey('jwk', material, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']);
  }
}

async function verifyEd25519(key, signature, data) {
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data);
  } catch {
    return crypto.subtle.verify({ name: 'NODE-ED25519' }, key, signature, data);
  }
}

export function jwksUrlFor(authUrl) {
  if (!authUrl || !/^https:\/\//.test(authUrl)) return null;
  return `${authUrl.replace(/\/$/, '')}/.well-known/jwks.json`;
}

export async function verifyNeonAuthToken(token, {
  fetchImpl = globalThis.fetch, authUrl = env('NEON_AUTH_URL'), issuer = env('NEON_AUTH_ISSUER'),
  audience = env('NEON_AUTH_AUDIENCE'), now = Date.now(), clockSkewSec = 60,
} = {}) {
  if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 8192) throw new AuthError(401, 'missing_token');
  const jwksUrl = jwksUrlFor(authUrl);
  if (!jwksUrl) throw new AuthError(503, 'auth_not_configured');
  const [h, p, s] = token.split('.');
  const header = decodeJson(h);
  if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') throw new AuthError(401, 'invalid_token');
  let keys = await loadJwks(jwksUrl, fetchImpl, { now });
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await loadJwks(jwksUrl, fetchImpl, { force: true, now });
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new AuthError(401, 'invalid_token');
  const ok = await verifyEd25519(await importEd25519(jwk), b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AuthError(401, 'invalid_token');
  const claims = decodeJson(p);
  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + clockSkewSec < nowSec) throw new AuthError(401, 'token_expired');
  if (typeof claims.nbf === 'number' && claims.nbf - clockSkewSec > nowSec) throw new AuthError(401, 'invalid_token');
  if (typeof claims.iat === 'number' && claims.iat - clockSkewSec > nowSec) throw new AuthError(401, 'invalid_token');
  if (issuer && claims.iss !== issuer) throw new AuthError(401, 'invalid_token');
  if (audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new AuthError(401, 'invalid_token');
  }
  const id = String(claims.sub || claims.id || '');
  if (!UUID_RE.test(id)) throw new AuthError(401, 'invalid_token');
  return { id };
}

export function _clearJwksCache() {
  jwksCache.clear();
}

export async function requireModerator(db, request, deps = {}) {
  const header = request.headers.get('authorization') || '';
  const m = /^Bearer (.+)$/.exec(header);
  const user = await (deps.verifyUser || verifyNeonAuthToken)(m ? m[1].trim() : '', deps.authOptions || {});
  const row = await db.one('select ufs_agent.is_active_moderator($1::uuid) as ok', [user.id]);
  if (!row?.ok) throw new AuthError(403, 'not_moderator');
  return user;
}
