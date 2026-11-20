import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { isPublicAddress, validateTarget, safeGet, guardedLookup, readLimited, UnsafeDestinationError, ipFamily } from '../../../lib/agent/net/safe-get.js';
import { httpsTransport } from '../../../lib/agent/net/node-transport.js';
import { fetchTransport, dohResolver } from '../../../lib/agent/net/fetch-transport.js';
import { retrieveSource } from '../../../lib/agent/editorial/sources.js';
import { fetchAndCheckImage } from '../../../lib/agent/editorial/media.js';
import { sha256Hex } from '../../../lib/agent/crypto.js';
import { fakeNet, PUBLIC_IP } from '../helpers.js';

const ALLOWED = ['www.sitges.cat', 'unitedforsitges.com'];
const html = `<html><body>${'Official municipal information. '.repeat(20)}</body></html>`;

describe('Address classification', () => {
  test('private, loopback, link-local, metadata, CGNAT, multicast and reserved addresses are not public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.10',
      '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '2002:7f00:1::1', '2001::1', 'not-an-ip', '']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });
  test('public unicast addresses are allowed', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2001:4860:4860::8888', '2a00:1450:4003:80e::200e', '::ffff:8.8.8.8']) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
  });
});

describe('URL validation', () => {
  const bad = {
    'http://www.sitges.cat/': 'https_required',
    'ftp://www.sitges.cat/': 'https_required',
    'file:///etc/passwd': 'https_required',
    'https://user:pass@www.sitges.cat/': 'credentials_in_url',
    'https://www.sitges.cat:8443/': 'port_not_allowed',
    'https://127.0.0.1/': 'ip_literal_not_allowed',
    'https://2130706433/': 'ip_literal_not_allowed',
    'https://[::1]/': 'ip_literal_not_allowed',
    'https://169.254.169.254/latest/meta-data/': 'ip_literal_not_allowed',
    'https://evil.example/': 'host_not_allowlisted',
    'https://www.sitges.cat.evil.example/': 'host_not_allowlisted',
    'https://sitges.cat/': 'host_not_allowlisted',
    'not a url': 'invalid_url',
  };
  for (const [url, reason] of Object.entries(bad)) {
    test(`rejects ${url}`, () => {
      assert.throws(() => validateTarget(url, ALLOWED), (e) => e instanceof UnsafeDestinationError && e.reason === reason);
    });
  }
  test('accepts an allowlisted https host on the default port, case-insensitively', () => {
    assert.equal(validateTarget('https://WWW.Sitges.cat:443/ajuntament', ALLOWED).hostname, 'www.sitges.cat');
  });
});

describe('safeGet', () => {
  test('DNS answer pointing to a private address is refused before any request', async () => {
    const net = fakeNet({ 'https://www.sitges.cat/': { body: html } }, { address: '10.0.0.5' });
    await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, ...net }), (e) => e.reason === 'non_public_address');
    assert.equal(net.calls.length, 0);
  });
  test('mixed public and private DNS answers are refused', async () => {
    const resolver = async () => [{ address: PUBLIC_IP, family: 4 }, { address: '127.0.0.1', family: 4 }];
    await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, resolver, transport: async () => { throw new Error('must not connect'); } }), (e) => e.reason === 'non_public_address');
  });
  test('redirect to a non-allowlisted host is refused', async () => {
    const net = fakeNet({ 'https://www.sitges.cat/': { status: 302, headers: { location: 'https://attacker.example/x' } } });
    await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, ...net }), (e) => e.reason === 'host_not_allowlisted');
  });
  test('redirect downgrade to http, to an IP literal or to the metadata service is refused', async () => {
    for (const location of ['http://www.sitges.cat/', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://www.sitges.cat:8080/']) {
      const net = fakeNet({ 'https://www.sitges.cat/': { status: 301, headers: { location } } });
      await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, ...net }), UnsafeDestinationError, location);
    }
  });
  test('redirect to an allowlisted host that resolves privately is refused', async () => {
    const transport = async (url) => (url.hostname === 'www.sitges.cat' ? { status: 302, headers: { location: 'https://unitedforsitges.com/' }, body: Buffer.alloc(0) } : { status: 200, headers: {}, body: Buffer.from('x') });
    const resolver = async (host) => [{ address: host === 'unitedforsitges.com' ? '192.168.0.10' : PUBLIC_IP, family: 4 }];
    await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, transport, resolver }), (e) => e.reason === 'non_public_address');
  });
  test('redirect chains are bounded', async () => {
    const net = fakeNet((url) => ({ status: 302, headers: { location: `${url}a` } }));
    await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, maxRedirects: 3, ...net }), (e) => e.reason === 'too_many_redirects');
    assert.equal(net.calls.length, 4);
  });
  test('relative redirects within the same allowed host are followed and recorded', async () => {
    const net = fakeNet({ 'https://www.sitges.cat/': { status: 301, headers: { location: '/ajuntament' } }, 'https://www.sitges.cat/ajuntament': { body: html } });
    const res = await safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, ...net });
    assert.equal(res.status, 200);
    assert.equal(res.finalUrl, 'https://www.sitges.cat/ajuntament');
    assert.equal(res.redirects, 1);
  });
  test('oversized bodies are refused', async () => {
    const net = fakeNet({ 'https://www.sitges.cat/': { body: 'x'.repeat(2048) } });
    await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, maxBytes: 1024, ...net }), (e) => e.code === 'response_too_large');
  });
  test('streaming reader stops at the byte limit', async () => {
    let produced = 0;
    const infinite = new Readable({ read() { produced += 1024; this.push(Buffer.alloc(1024)); } });
    await assert.rejects(readLimited(infinite, 64 * 1024), (e) => e.code === 'response_too_large');
    assert.ok(produced < 200 * 1024, 'stopped reading shortly after the limit');
  });
});

describe('DNS rebinding protection on the real HTTPS transport', () => {
  test('guarded lookup refuses a private answer at connect time even after a public pre-check', async () => {
    let calls = 0;
    const rebinding = async () => { calls += 1; return [{ address: calls === 1 ? PUBLIC_IP : '127.0.0.1', family: 4 }]; };
    // Where port 443 can be bound (root), a listener on 127.0.0.1 also proves
    // no connection reaches the private address. Unprivileged CI runners
    // cannot bind 443; the connect-time refusal is asserted either way.
    let connections = 0;
    const server = createServer((s) => { connections += 1; s.destroy(); });
    const listening = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(443, '127.0.0.1', () => resolve(true));
    });
    try {
      await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, resolver: rebinding, transport: httpsTransport, timeoutMs: 3000 }),
        (e) => e.code === 'unsafe_destination' && e.reason === 'non_public_address');
      assert.equal(calls >= 2, true, 'socket performed its own guarded lookup');
      if (listening) assert.equal(connections, 0);
    } finally {
      if (listening) server.close();
    }
  });
  test('guardedLookup supports the all:true form used by Node happy eyeballs', async () => {
    const lookup = guardedLookup(async () => [{ address: PUBLIC_IP, family: 4 }, { address: '2001:4860:4860::8888', family: 6 }]);
    const all = await new Promise((resolve, reject) => lookup('x', { all: true }, (e, a) => (e ? reject(e) : resolve(a))));
    assert.equal(all.length, 2);
    const one = await new Promise((resolve, reject) => lookup('x', { family: 6 }, (e, a, f) => (e ? reject(e) : resolve([a, f]))));
    assert.deepEqual(one, ['2001:4860:4860::8888', 6]);
  });
});

describe('Callers use the hardened fetcher', () => {
  const source = { slug: 'sitges-equip-govern', url: 'https://www.sitges.cat/ajuntament/organitzacio/equip-de-govern', title: 't', publisher: 'p' };
  test('source retrieval refuses a redirect off the registry and records why', async () => {
    const net = fakeNet({ [source.url]: { status: 302, headers: { location: 'https://pastebin.example/raw' } } });
    const r = await retrieveSource(source, { sha256: sha256Hex, allowedHosts: ['www.sitges.cat'], net });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unsafe_destination:host_not_allowlisted');
  });
  test('source retrieval refuses a registry host that resolves to an internal address', async () => {
    const r = await retrieveSource(source, { sha256: sha256Hex, allowedHosts: ['www.sitges.cat'], net: fakeNet({ [source.url]: { body: html } }, { address: '169.254.169.254' }) });
    assert.equal(r.reason, 'unsafe_destination:non_public_address');
  });
  test('callers cannot widen the allowlist or size limit through the network options', async () => {
    const net = { ...fakeNet({ [source.url]: { body: 'y'.repeat(3 * 1024 * 1024), contentType: 'text/html' } }), allowedHosts: ['evil.example'], maxBytes: 1e9 };
    const r = await retrieveSource(source, { sha256: sha256Hex, allowedHosts: ['www.sitges.cat'], net });
    assert.equal(r.reason, 'response_too_large');
  });
  test('successful retrieval through an allowed redirect records the final URL', async () => {
    const net = fakeNet({ [source.url]: { status: 301, headers: { location: '/ajuntament/organitzacio/equip-de-govern/' } }, [`${source.url}/`]: { body: html } });
    const r = await retrieveSource(source, { sha256: sha256Hex, allowedHosts: ['www.sitges.cat'], net });
    assert.equal(r.ok, true);
    assert.equal(r.ref.final_url, `${source.url}/`);
  });
  test('image checks only fetch first-party card URLs on public addresses', async () => {
    assert.equal((await fetchAndCheckImage('https://evil.example/x.jpg', fakeNet({}))).reason, 'media_not_first_party');
    const url = 'https://unitedforsitges.com/assets/agent/cards/mobility.jpg';
    assert.equal((await fetchAndCheckImage(url, fakeNet({ [url]: { body: 'x', contentType: 'image/jpeg' } }, { address: '10.0.0.1' }))).reason, 'unsafe_destination:non_public_address');
  });
});

describe('Workers transport (fetch) and DNS-over-HTTPS resolver', () => {
  const resolver = async () => [{ address: PUBLIC_IP, family: 4 }];
  const respond = (routes) => async (url, init) => {
    assert.equal(init.redirect, 'manual', 'redirects must never be followed automatically');
    const r = routes[url];
    if (!r) return new Response('nf', { status: 404 });
    return new Response(r.body ?? '', { status: r.status || 200, headers: r.headers || { 'content-type': 'text/html' } });
  };
  const transport = (routes) => (url, opts) => fetchTransport(url, { ...opts, fetchImpl: respond(routes) });

  test('manual redirects off the allowlist are refused', async () => {
    const t = transport({ 'https://www.sitges.cat/': { status: 302, headers: { location: 'https://evil.example/' } } });
    await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, transport: t, resolver }), (e) => e.reason === 'host_not_allowlisted');
  });
  test('allowed redirect is followed and body returned as bytes', async () => {
    const t = transport({ 'https://www.sitges.cat/': { status: 301, headers: { location: '/a' } }, 'https://www.sitges.cat/a': { body: html } });
    const res = await safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, transport: t, resolver });
    assert.equal(res.status, 200);
    assert.ok(res.body instanceof Uint8Array);
    assert.equal(res.finalUrl, 'https://www.sitges.cat/a');
  });
  test('declared and streamed oversize bodies are refused', async () => {
    const declared = transport({ 'https://www.sitges.cat/': { body: 'x', headers: { 'content-type': 'text/html', 'content-length': String(10 * 1024 * 1024) } } });
    await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, transport: declared, resolver }), (e) => e.code === 'response_too_large');
    let pulled = 0;
    const endless = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(4096)); } });
    const t = (url, opts) => fetchTransport(url, { ...opts, fetchImpl: async () => new Response(endless, { status: 200, headers: { 'content-type': 'text/html' } }) });
    await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, transport: t, resolver, maxBytes: 64 * 1024 }), (e) => e.code === 'response_too_large');
    assert.ok(pulled < 40);
  });
  test('slow responses time out', async () => {
    const slow = (url, opts) => fetchTransport(url, { ...opts, fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, transport: slow, resolver, timeoutMs: 50 }), (e) => e.code === 'timeout');
  });
  test('DoH resolver returns A and AAAA answers and private answers are refused', async () => {
    const doh = dohResolver({ fetchImpl: async (u) => Response.json({ Answer: u.includes('type=AAAA') ? [{ type: 28, data: '2001:4860:4860::8888' }] : [{ type: 5, data: 'alias.example.' }, { type: 1, data: '10.0.0.7' }] }) });
    const answers = await doh('www.sitges.cat');
    assert.deepEqual(answers.map((a) => a.address), ['10.0.0.7', '2001:4860:4860::8888']);
    await assert.rejects(safeGet('https://www.sitges.cat/', { allowedHosts: ALLOWED, transport: async () => { throw new Error('must not connect'); }, resolver: doh }), (e) => e.reason === 'non_public_address');
  });
  test('ipFamily recognises literals without node:net', () => {
    assert.equal(ipFamily('10.0.0.1'), 4);
    assert.equal(ipFamily('::1'), 6);
    assert.equal(ipFamily('www.sitges.cat'), 0);
    assert.equal(ipFamily('999.1.1.1'), 0);
  });
});
