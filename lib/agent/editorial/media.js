// Media validation for platform requirements (Instagram: JPEG only,
// <= 8 MB, aspect ratio 4:5 to 1.91:1, width 320..1440 px).
// Uses the project's own branded category cards (first-party assets).

export const CARD_BASE_URL = 'https://unitedforsitges.com/assets/agent/cards';

export function cardUrlFor(category) {
  if (!/^[a-z_]{3,40}$/.test(category)) return null;
  return `${CARD_BASE_URL}/${category.replace(/_/g, '-')}.jpg`;
}

// Reads JPEG dimensions from SOFn markers. Returns null for non-JPEG data.
export function jpegInfo(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

export function checkInstagramImage(buf) {
  if (!buf) return { ok: false, reason: 'no_data' };
  if (buf.length > 8 * 1024 * 1024) return { ok: false, reason: 'too_large' };
  const info = jpegInfo(buf);
  if (!info) return { ok: false, reason: 'not_jpeg' };
  if (info.width < 320 || info.width > 1440) return { ok: false, reason: 'width_out_of_range' };
  const ratio = info.width / info.height;
  if (ratio < 0.8 - 1e-3 || ratio > 1.91 + 1e-3) return { ok: false, reason: 'aspect_ratio_out_of_range' };
  return { ok: true, ...info };
}

export async function fetchAndCheckImage(url, fetchImpl = globalThis.fetch) {
  if (!url || !url.startsWith(`${CARD_BASE_URL}/`)) return { ok: false, reason: 'media_not_first_party' };
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/jpeg')) return { ok: false, reason: 'content_type_not_jpeg' };
    return checkInstagramImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }
}
