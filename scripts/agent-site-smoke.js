// Smoke test: existing public pages and the agent console load without
// uncaught JavaScript errors and keep their key elements (test 22).
// Serves the repository statically on a local port; no deployment involved.
// Usage: node scripts/agent-site-smoke.js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = new URL('..', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path.startsWith('..') || path.startsWith('api/') || path.startsWith('lib/')) { res.writeHead(404); res.end(); return; }
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const checks = [
  ['/index.html', 'h1'], ['/community.html', 'main'], ['/privacy.html', 'h1'], ['/programmes.html', 'main'], ['/agent-console.html', '#loginForm'],
];
const browser = await chromium.launch();
let failed = 0;
for (const [path, selector] of checks) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort()); // offline: third-party CDNs blocked
  const res = await page.goto(base + path, { waitUntil: 'load' });
  const found = await page.$(selector);
  const ok = res.status() === 200 && found && errors.length === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${path} status=${res.status()} selector=${Boolean(found)} jsErrors=${errors.length}${errors.length ? ` ${errors[0]}` : ''}`);
  await page.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
