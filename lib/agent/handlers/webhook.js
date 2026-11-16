// Meta webhook receiver. Verifies, deduplicates and stores events, then
// acknowledges. It never classifies, replies, publishes or moderates.

import { verifyMetaSignature, safeEqualString } from '../crypto.js';
import { parseMetaWebhook, WebhookPayloadError } from '../meta/webhook.js';
import { enqueueEvents } from '../moderation.js';
import { getSettings, audit } from '../db.js';
import { env, HARD_LIMITS } from '../config.js';
import { json, text, readRawBody, BodyTooLarge, log } from '../http.js';

export async function handleVerify(request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge') || '';
  const expected = env('META_VERIFY_TOKEN');
  if (!expected) return text(503, 'not configured');
  if (mode === 'subscribe' && safeEqualString(token || '', expected) && /^[A-Za-z0-9_-]{1,128}$/.test(challenge)) {
    return text(200, challenge);
  }
  return text(403, 'forbidden');
}

export async function handleEvent(request, { getDb, now = new Date() } = {}) {
  const appSecret = env('META_APP_SECRET');
  if (!appSecret) return json(503, { error: 'not_configured' });
  const pepper = env('AGENT_AUTHOR_PEPPER');
  if (!pepper && process.env.VERCEL_ENV === 'production') return json(503, { error: 'not_configured' });
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('application/json')) return json(415, { error: 'unsupported_media_type' });

  let raw;
  try {
    raw = await readRawBody(request, HARD_LIMITS.maxWebhookBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLarge) return json(413, { error: 'payload_too_large' });
    return json(400, { error: 'unreadable_body' });
  }
  if (!verifyMetaSignature(raw, request.headers.get('x-hub-signature-256'), appSecret)) {
    log('webhook_signature_rejected', { bytes: raw.length });
    return json(401, { error: 'invalid_signature' });
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  let parsed;
  try {
    parsed = parseMetaWebhook(body, { pepper });
  } catch (err) {
    if (err instanceof WebhookPayloadError) {
      log('webhook_payload_rejected', { reason: err.message });
      // Signed but malformed: acknowledge so Meta does not retry forever.
      return json(200, { received: true, accepted: 0, rejected: true });
    }
    throw err;
  }
  try {
    const db = getDb();
    const settings = await getSettings(db);
    const res = await enqueueEvents(db, parsed.events, { settings, now });
    if (res.unknownAccount) await audit(db, { actorType: 'provider', action: 'webhook_unknown_account', entityType: 'webhook', detail: { count: res.unknownAccount } });
    log('webhook_accepted', { inserted: res.inserted, duplicates: res.duplicates, ignored: parsed.ignored, unknown: res.unknownAccount });
    return json(200, { received: true, accepted: res.inserted, duplicates: res.duplicates });
  } catch (err) {
    // Storage failed: return 5xx so Meta retries delivery (up to 36 hours).
    log('webhook_storage_failed', { code: err.code || 'db_error' });
    return json(503, { error: 'temporarily_unavailable' });
  }
}
