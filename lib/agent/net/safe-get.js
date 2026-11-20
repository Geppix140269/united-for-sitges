// Hardened outbound GET for content the agent retrieves from the web
// (approved sources, first-party images). Defends against SSRF:
//  * HTTPS only, port 443, no credentials in the URL, no IP-literal hosts;
//  * exact host allowlist (registry hosts), re-checked on every redirect;
//  * manual redirects, at most `maxRedirects`, each target fully re-validated;
//  * every DNS answer must be a public unicast address;
//  * hard byte limit enforced while streaming, overall timeout.
// Transports: in Node (tests, scripts) node-transport.js pins the guarded
// lookup into the socket, so a rebinding answer at connect time is refused.
// On Cloudflare Workers, fetch-transport.js is used with a DNS-over-HTTPS
// pre-check; Workers cannot pin DNS, but their egress cannot reach private
// networks or a metadata service, so a rebinding answer has no target there.
// This module has no Node-only imports so it bundles for Workers.

export class UnsafeDestinationError extends Error {
  constructor(reason) {
    super(`Unsafe destination: ${reason}`);
    this.code = 'unsafe_destination';
    this.reason = reason;
  }
}

export class FetchLimitError extends Error {
  constructor(reason) {
    super(reason);
    this.code = reason;
  }
}

// ---------------------------------------------------------------- addresses
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

function isPublicV4(ip) {
  const n = ipv4ToInt(ip);
  return !V4_BLOCKED.some(({ base, mask }) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
}

// Expands an IPv6 address (optionally with embedded IPv4) to 8 hextets.
function expandV6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(fill).fill('0'), ...t].map((x) => parseInt(x || '0', 16));
  return parts.length === 8 && parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? parts : null;
}

function isPublicV6(ip) {
  const p = expandV6(ip);
  if (!p) return false;
  // IPv4-mapped (::ffff:a.b.c.d): judge the embedded IPv4 address.
  if (p.slice(0, 5).every((x) => x === 0) && p[5] === 0xffff) {
    return isPublicV4(`${p[6] >> 8}.${p[6] & 255}.${p[7] >> 8}.${p[7] & 255}`);
  }
  const first = p[0];
  if ((first & 0xe000) !== 0x2000) return false;           // only 2000::/3 global unicast
  if (first === 0x2001 && p[1] < 0x0200) return false;    // 2001::/23 protocol assignments (Teredo etc.)
  if (first === 0x2001 && p[1] === 0x0db8) return false;  // documentation
  if (first === 0x2002) return false;                     // 6to4 (embeds arbitrary IPv4)
  return true;
}

const V4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export function ipFamily(value) {
  const s = String(value || '');
  if (V4_RE.test(s)) return 4;
  if (s.includes(':') && /^[0-9a-fA-F:.%a-zA-Z0-9]+$/.test(s) && expandV6(s)) return 6;
  return 0;
}

export function isPublicAddress(ip) {
  const family = ipFamily(ip);
  if (family === 4) return isPublicV4(ip);
  if (family === 6) return isPublicV6(ip);
  return false;
}

// -------------------------------------------------------------------- URLs
export function validateTarget(input, allowedHosts) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    throw new UnsafeDestinationError('invalid_url');
  }
  if (url.protocol !== 'https:') throw new UnsafeDestinationError('https_required');
  if (url.username || url.password) throw new UnsafeDestinationError('credentials_in_url');
  if (url.port && url.port !== '443') throw new UnsafeDestinationError('port_not_allowed');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (ipFamily(host) || /^[0-9.]+$/.test(host)) throw new UnsafeDestinationError('ip_literal_not_allowed');
  const allowed = new Set((allowedHosts || []).map((h) => String(h).toLowerCase()));
  if (!allowed.has(host)) throw new UnsafeDestinationError('host_not_allowlisted');
  return url;
}

// --------------------------------------------------------------------- DNS
export async function resolvePublic(hostname, resolver) {
  let answers;
  try {
    answers = await resolver(hostname);
  } catch {
    throw new UnsafeDestinationError('dns_failed');
  }
  if (!Array.isArray(answers) || answers.length === 0) throw new UnsafeDestinationError('dns_empty');
  for (const a of answers) {
    if (!isPublicAddress(a.address)) throw new UnsafeDestinationError('non_public_address');
  }
  return answers;
}

// lookup() for net/https: every resolution performed by the socket goes
// through the same public-address check.
export function guardedLookup(resolver) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    resolvePublic(hostname, resolver).then((answers) => {
      const wanted = opts.family ? answers.filter((a) => a.family === opts.family) : answers;
      if (!wanted.length) return cb(new UnsafeDestinationError('dns_family_unavailable'));
      if (opts.all) return cb(null, wanted.map((a) => ({ address: a.address, family: a.family })));
      return cb(null, wanted[0].address, wanted[0].family);
    }, (err) => cb(err));
  };
}

// ------------------------------------------------------------------ bodies
// Accepts a Node stream or a Web ReadableStream.
export async function readLimited(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  const push = (chunk) => {
    const buf = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    total += buf.byteLength;
    if (total > maxBytes) throw new FetchLimitError('response_too_large');
    chunks.push(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  };
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        push(value);
      }
    } catch (err) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw err;
    }
  } else {
    try {
      for await (const chunk of stream) push(chunk);
    } catch (err) {
      if (typeof stream.destroy === 'function') stream.destroy();
      throw err;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

let nodeDefaults = null;
async function defaults() {
  if (!nodeDefaults) nodeDefaults = await import('./node-transport.js');
  return nodeDefaults;
}

// Public entry point.
export async function safeGet(input, {
  allowedHosts, maxBytes = 2 * 1024 * 1024, maxRedirects = 3, timeoutMs = 12000,
  transport, resolver, headers = {},
} = {}) {
  if (!transport || !resolver) {
    const d = await defaults();
    transport = transport || d.httpsTransport;
    resolver = resolver || d.systemResolver;
  }
  let current = input;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = validateTarget(current, allowedHosts);
    await resolvePublic(url.hostname, resolver); // early, explicit check
    const res = await transport(url, { lookup: guardedLookup(resolver), timeoutMs, maxBytes, headers });
    if (res.body && res.body.byteLength > maxBytes) throw new FetchLimitError('response_too_large');
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location;
      if (!location) throw new UnsafeDestinationError('redirect_without_location');
      current = new URL(location, url); // re-validated at the top of the loop
      continue;
    }
    return { status: res.status, headers: res.headers, body: res.body || new Uint8Array(0), finalUrl: url.toString(), redirects: hop };
  }
  throw new UnsafeDestinationError('too_many_redirects');
}

export function hostsOf(urls) {
  const out = new Set();
  for (const u of urls) {
    try { out.add(new URL(u).hostname.toLowerCase()); } catch { /* skip invalid */ }
  }
  return [...out];
}
