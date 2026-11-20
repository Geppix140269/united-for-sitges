// Approved-source retrieval for editorial content. Only registry entries
// that are active and recently verified by a person can be used. Retrieved
// text is untrusted data: it is only searched for supporting excerpts and
// passed to the model inside an untrusted boundary.

import { safeGet, hostsOf } from '../net/safe-get.js';

const MAX_TEXT = 20000;
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

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

// Retrieval goes through safeGet: HTTPS only, registry hosts only (also for
// every redirect), public DNS answers only (checked again at connect time),
// at most 2 MB, 12 s. `net` lets tests inject a transport and resolver while
// keeping every safety check active.
export async function retrieveSource(source, { now = new Date(), sha256, allowedHosts, net = {} } = {}) {
  const ref = { slug: source.slug, url: source.url, title: source.title, publisher: source.publisher, retrieved_at: now.toISOString(), verified_at: source.verified_at };
  try {
    const res = await safeGet(source.url, {
      allowedHosts: allowedHosts || hostsOf([source.url]),
      maxBytes: MAX_DOWNLOAD_BYTES,
      headers: { 'User-Agent': 'UnitedForSitgesAgent/1.0 (+https://unitedforsitges.com)', Accept: 'text/html, text/plain;q=0.9' },
      ...(net.transport ? { transport: net.transport } : {}),
      ...(net.resolver ? { resolver: net.resolver } : {}),
    });
    ref.http_status = res.status;
    ref.last_modified = res.headers['last-modified'] || null;
    if (res.redirects) ref.final_url = res.finalUrl;
    if (res.status < 200 || res.status >= 300) return { ok: false, ref, reason: `http_${res.status}` };
    const type = String(res.headers['content-type'] || '').toLowerCase();
    if (!type.includes('html') && !type.includes('text')) return { ok: false, ref, reason: 'unsupported_content_type' };
    const text = htmlToText(new TextDecoder('utf-8').decode(res.body));
    if (text.length < 200) return { ok: false, ref, reason: 'content_too_short' };
    ref.content_hash = sha256(text);
    return { ok: true, ref, text };
  } catch (err) {
    return { ok: false, ref, reason: err.code === 'unsafe_destination' ? `unsafe_destination:${err.reason}` : (err.code || 'fetch_failed') };
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
