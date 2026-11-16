import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

// Normalised fingerprint used to bind approvals to exact text.
// Whitespace at the ends is trimmed and line endings unified; nothing else is
// changed, so any visible edit produces a new fingerprint.
export function textFingerprint(text) {
  const normalised = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  return sha256Hex(`v1\n${normalised}`);
}

// Verify Meta's X-Hub-Signature-256 header against the ORIGINAL raw body.
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== 'string') return false;
  const m = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const provided = Buffer.from(m[1].toLowerCase(), 'hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = createHash('sha256').update(a).digest();
  const bb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ab, bb) && a.length === b.length;
}

// One-way pseudonymous reference for an external author id. Keyed so the
// stored value cannot be reversed by hashing known ids without the pepper.
export function authorRef(provider, externalUserId, pepper) {
  if (!externalUserId) return null;
  const key = pepper || 'u4s-agent-dev-pepper-not-for-production';
  return createHmac('sha256', key).update(`${provider}:${externalUserId}`).digest('hex');
}

export function newWorkerId() {
  return `w-${randomUUID()}`;
}
