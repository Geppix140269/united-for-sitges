// Approved-source retrieval for editorial content. Only registry entries
// that are active and recently verified by a person can be used. Retrieved
// text is untrusted data: it is only searched for supporting excerpts and
// passed to the model inside an untrusted boundary.

const MAX_TEXT = 20000;

export function sourceUsable(source, { now = new Date(), maxAgeDays = 90 } = {}) {
  if (!source) return 'unknown_source';
  if (!source.active) return 'source_inactive';
  if (!source.verified_at || !source.verified_by) return 'source_unverified';
  if ((now - new Date(source.verified_at)) / 86400000 > maxAgeDays) return 'source_verification_stale';
  if (source.review_by && new Date(source.review_by) < now) return 'source_review_overdue';
  return null;
}

export function maxAgeFromSetting(setting) {
  const m = /^verified_within_(\d{1,3})_days$/.exec(setting || '');
  return m ? Number(m[1]) : 90;
}

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

export async function retrieveSource(source, { fetchImpl = globalThis.fetch, now = new Date(), sha256 } = {}) {
  const ref = { slug: source.slug, url: source.url, title: source.title, publisher: source.publisher, retrieved_at: now.toISOString(), verified_at: source.verified_at };
  try {
    const res = await fetchImpl(source.url, { redirect: 'follow', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'UnitedForSitgesAgent/1.0 (+https://unitedforsitges.com)' } });
    ref.http_status = res.status;
    ref.last_modified = res.headers.get('last-modified') || null;
    if (!res.ok) return { ok: false, ref, reason: `http_${res.status}` };
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('html') && !type.includes('text')) return { ok: false, ref, reason: 'unsupported_content_type' };
    const text = htmlToText(await res.text());
    if (text.length < 200) return { ok: false, ref, reason: 'content_too_short' };
    ref.content_hash = sha256(text);
    return { ok: true, ref, text };
  } catch {
    return { ok: false, ref, reason: 'fetch_failed' };
  }
}

export function normaliseForMatch(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

export function excerptSupported(excerpt, sourceText) {
  const e = normaliseForMatch(excerpt);
  if (e.length < 20) return false;
  return normaliseForMatch(sourceText).includes(e);
}
