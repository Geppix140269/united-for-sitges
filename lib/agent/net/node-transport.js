// Node transport for safeGet (tests, scripts, any Node host): one HTTPS GET,
// no redirects followed, no connection pooling, and the guarded public-only
// DNS lookup pinned into the socket so a rebinding answer is refused.
import https from 'node:https';
import dns from 'node:dns';
import { guardedLookup, readLimited, FetchLimitError, UnsafeDestinationError } from './safe-get.js';

export async function systemResolver(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

export function httpsTransport(url, { resolver = systemResolver, lookup, timeoutMs, maxBytes, headers }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const req = https.request({
      protocol: 'https:', hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method: 'GET',
      headers: { 'Accept-Encoding': 'identity', ...headers }, lookup: lookup || guardedLookup(resolver), agent: false, servername: url.hostname,
    }, (res) => {
      const status = res.statusCode || 0;
      const resHeaders = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)]));
      if (status >= 300 && status < 400) {
        res.resume();
        return finish(resolve, { status, headers: resHeaders, body: new Uint8Array(0) });
      }
      const declared = Number(resHeaders['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        return finish(reject, new FetchLimitError('response_too_large'));
      }
      readLimited(res, maxBytes).then((body) => finish(resolve, { status, headers: resHeaders, body }), (err) => finish(reject, err));
    });
    const timer = setTimeout(() => { req.destroy(); finish(reject, new FetchLimitError('timeout')); }, timeoutMs);
    req.on('error', (err) => finish(reject, err instanceof UnsafeDestinationError || err?.code === 'unsafe_destination' ? err : Object.assign(new Error('network_error'), { code: 'network_error' })));
    req.end();
  });
}
