// Small HTTP helpers for Web-standard Request/Response handlers.

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra } });
}

export function text(status, body) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
}

export class BodyTooLarge extends Error {
  constructor() {
    super('Payload too large');
    this.code = 'payload_too_large';
  }
}

// Reads the raw body as a Buffer, enforcing a hard byte limit even when the
// Content-Length header is missing or wrong.
export async function readRawBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge();
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new BodyTooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function log(event, fields = {}) {
  // Structured, credential-free logging for Vercel runtime logs.
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (/token|secret|password|authorization|key/i.test(k)) continue;
    safe[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...safe }));
}
