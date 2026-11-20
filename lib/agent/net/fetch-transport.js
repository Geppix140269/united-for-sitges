// Web-fetch transport for safeGet on Cloudflare Workers: manual redirects
// (each hop is re-validated by safeGet), identity encoding, streamed byte
// limit and timeout. DNS cannot be pinned on Workers; see safe-get.js.
import { readLimited, FetchLimitError } from './safe-get.js';

export async function fetchTransport(url, { timeoutMs, maxBytes, headers, fetchImpl = globalThis.fetch }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url.toString(), { method: 'GET', redirect: 'manual', headers: { 'Accept-Encoding': 'identity', ...headers }, signal: ctrl.signal });
    } catch {
      throw ctrl.signal.aborted ? new FetchLimitError('timeout') : Object.assign(new Error('network_error'), { code: 'network_error' });
    }
    const resHeaders = {};
    res.headers.forEach((v, k) => { resHeaders[k.toLowerCase()] = v; });
    if (res.status >= 300 && res.status < 400) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { status: res.status, headers: resHeaders, body: new Uint8Array(0) };
    }
    const declared = Number(resHeaders['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new FetchLimitError('response_too_large');
    }
    const body = res.body ? await readLimited(res.body, maxBytes) : new Uint8Array(0);
    return { status: res.status, headers: resHeaders, body };
  } finally {
    clearTimeout(timer);
  }
}

// DNS-over-HTTPS resolver (Cloudflare 1.1.1.1 JSON API) for the public-address
// pre-check on Workers. Returns A and AAAA answers only.
export function dohResolver({ fetchImpl = globalThis.fetch, endpoint = 'https://cloudflare-dns.com/dns-query' } = {}) {
  return async (hostname) => {
    const out = [];
    for (const [type, family] of [['A', 4], ['AAAA', 6]]) {
      const res = await fetchImpl(`${endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
      if (!res.ok) throw new Error('doh_failed');
      const data = await res.json();
      for (const a of data.Answer || []) {
        if ((family === 4 && a.type === 1) || (family === 6 && a.type === 28)) out.push({ address: String(a.data), family });
      }
    }
    return out;
  };
}
