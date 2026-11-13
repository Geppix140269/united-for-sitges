const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
// Usage: node render-facebook-images.js <dir containing favicon.svg>
const dir = process.argv[2];
const svg = fs.readFileSync(path.join(dir,'favicon.svg'),'utf8');
const font = `<link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@900&display=swap" rel="stylesheet">`;
const bg = `background: radial-gradient(ellipse at 45% 35%, #22406f 0%, #1c3561 45%, #182c52 100%);`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 720, height: 720 } });
  await p.setContent(`<html><body style="margin:0;width:720px;height:720px;${bg}display:flex;align-items:center;justify-content:center">
    <div style="width:560px;height:560px;filter:drop-shadow(0 8px 18px rgba(0,0,0,.35))">${svg.replace('<svg','<svg width="560" height="560"')}</div></body></html>`);
  await p.screenshot({ path: path.join(dir,'u4s-facebook-profile-720.png') });
  await p.setViewportSize({ width: 1640, height: 624 });
  await p.setContent(`<html><head>${font}</head><body style="margin:0;width:1640px;height:624px;${bg}display:flex;align-items:center;justify-content:center;gap:48px;font-family:'Nunito Sans',sans-serif">
    <div style="width:250px;height:250px;filter:drop-shadow(0 8px 18px rgba(0,0,0,.35))">${svg.replace('<svg','<svg width="250" height="250"')}</div>
    <div><div style="color:#FBF8F2;font-weight:900;font-size:96px;letter-spacing:-1px;line-height:1">United for Sitges</div>
    <div style="display:flex;gap:16px;margin-top:28px"><span style="width:14px;height:14px;border-radius:50%;background:#119C94"></span><span style="width:14px;height:14px;border-radius:50%;background:#F2A71B"></span><span style="width:14px;height:14px;border-radius:50%;background:#EE6A50"></span></div></div></body></html>`, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: path.join(dir,'u4s-facebook-cover-1640x624.png') });
  await b.close();
})();
