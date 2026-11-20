// Renders the first-party branded category cards used for Instagram posts
// (JPEG, 1080x1350, 4:5). Text is limited to the category name and the
// project name; no claims are ever baked into images.
// Usage: node scripts/agent-render-cards.js
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const LABELS = {
  civic_information: 'Civic information', local_government: 'Local government', electoral_resources: 'Official electoral resources',
  urban_planning: 'Public space and planning', mobility: 'Mobility and accessibility', tourism: 'Tourism and residents',
  local_economy: 'Local economy', community_wellbeing: 'Community wellbeing', environment: 'Environment',
  international_integration: 'International residents', platform_updates: 'Platform updates', community_questions: 'Your questions',
};
const svg = readFileSync(new URL('../favicon.svg', import.meta.url), 'utf8').replace('<svg', '<svg width="300" height="300"');
const out = new URL('../assets/agent/cards/', import.meta.url);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
for (const [key, label] of Object.entries(LABELS)) {
  await page.setContent(`<html><head><style>body{margin:0;width:1080px;height:1350px;font-family:'Nunito Sans',system-ui,sans-serif;
    background:radial-gradient(ellipse at 45% 30%,#22406f 0%,#1c3561 45%,#182c52 100%);color:#FBF8F2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:56px;text-align:center}
    .label{font-size:84px;font-weight:900;line-height:1.08;max-width:900px;letter-spacing:-1px}.name{font-size:44px;font-weight:800;opacity:.92}
    .dots{display:flex;gap:18px}.dots span{width:18px;height:18px;border-radius:50%}</style></head>
    <body><div style="filter:drop-shadow(0 8px 18px rgba(0,0,0,.35))">${svg}</div><div class="label">${label}</div>
    <div class="dots"><span style="background:#119C94"></span><span style="background:#F2A71B"></span><span style="background:#EE6A50"></span></div>
    <div class="name">United for Sitges</div></body></html>`);
  await page.screenshot({ path: new URL(`${key.replace(/_/g, '-')}.jpg`, out).pathname, type: 'jpeg', quality: 86 });
}
await browser.close();
console.log(`Rendered ${Object.keys(LABELS).length} cards`);
