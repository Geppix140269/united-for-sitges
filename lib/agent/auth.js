// Admin authorisation. Identity comes ONLY from a Supabase Auth access token
// verified server-side by Supabase (GET /auth/v1/user). Moderator status
// comes ONLY from public.ufs_profiles (is_moderator and not is_suspended),
// read through ufs_agent.is_active_moderator. user_metadata, client flags
// and request bodies are never trusted for authorisation.

import { env } from './config.js';

export class AuthError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function verifySupabaseUser(accessToken, { fetchImpl = globalThis.fetch, supabaseUrl = env('SUPABASE_URL'), publishableKey = env('SUPABASE_PUBLISHABLE_KEY') } = {}) {
  if (!accessToken || !/^[A-Za-z0-9._-]{20,4096}$/.test(accessToken)) throw new AuthError(401, 'missing_token');
  if (!supabaseUrl || !publishableKey) throw new AuthError(503, 'auth_not_configured');
  let res;
  try {
    res = await fetchImpl(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new AuthError(503, 'auth_unavailable');
  }
  if (res.status === 401 || res.status === 403) throw new AuthError(401, 'invalid_token');
  if (!res.ok) throw new AuthError(503, 'auth_unavailable');
  const user = await res.json().catch(() => null);
  if (!user || !UUID_RE.test(String(user.id || ''))) throw new AuthError(401, 'invalid_token');
  if (user.is_anonymous) throw new AuthError(403, 'anonymous_not_allowed');
  if (!user.email_confirmed_at && !user.confirmed_at) throw new AuthError(403, 'email_unconfirmed');
  return { id: user.id };
}

export async function requireModerator(db, request, deps = {}) {
  const header = request.headers.get('authorization') || '';
  const m = /^Bearer (.+)$/.exec(header);
  const user = await (deps.verifyUser || verifySupabaseUser)(m ? m[1].trim() : '', deps);
  const row = await db.one('select ufs_agent.is_active_moderator($1::uuid) as ok', [user.id]);
  if (!row?.ok) throw new AuthError(403, 'not_moderator');
  return user;
}
