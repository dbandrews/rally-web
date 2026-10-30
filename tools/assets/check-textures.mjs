#!/usr/bin/env node
// tools/assets/check-textures.mjs — GPU check of built textures (public/assets/tex) in headless Chromium.
//
//   node tools/assets/check-textures.mjs                          # an even sample of 80 tex/*.rtex
//   node tools/assets/check-textures.mjs --ids-from stages/kenya-1-f/track.json   # every texId a part file uses
//   node tools/assets/check-textures.mjs --limit 0                # every texture
//
// Each texture goes through TextureStore twice (S3TC upload and the JS DXT fallback); every level (every
// slice of volumes) is read back with texelFetch and compared with the JS decode of the .rtex. `--ids-from`
// also checks every array of exactly 6 texIds in that JSON as a cube map (face order + orientation against
// the 2-D faces). Exit 1 on any mismatch, GL error or console error. Options: --url (running dev server).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, parseArgs, startServer, IGNORED_CONSOLE } from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const TEX = path.join(ROOT, 'public', 'assets', 'tex');
if (!fs.existsSync(TEX)) {
  console.log('no public/assets/tex — build textures first (npm run assets)');
  process.exit(1);
}
let ids = [];
const cubes = [];
if (typeof args['ids-from'] === 'string') {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'assets', args['ids-from']), 'utf8'));
  const isId = (v) => typeof v === 'string' && /^[0-9a-f]{20}$/.test(v);
  const walk = (v) => {
    if (isId(v)) ids.push(v);
    else if (Array.isArray(v)) {
      if (v.length === 6 && v.every(isId)) cubes.push(v);
      v.forEach(walk);
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(json);
  ids = [...new Set(ids)];
} else {
  const all = fs.readdirSync(TEX).filter((f) => f.endsWith('.rtex')).map((f) => f.slice(0, -5)).sort();
  const limit = Number(args.limit ?? 80);
  const step = limit > 0 ? Math.max(1, Math.floor(all.length / limit)) : 1;
  ids = all.filter((_, i) => i % step === 0).slice(0, limit > 0 ? limit : undefined);
}

let server = null, browser = null, report = null;
const errors = [];
try {
  const base = typeof args.url === 'string' ? args.url : (server = await startServer()).url;
  browser = await launchBrowser({ headed: !!args.headed });
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => m.type() === 'error' && !IGNORED_CONSOLE.some((r) => r.test(m.text())) && errors.push(`console.error: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(base + 'tools/assets/check-textures.html');
  await page.waitForFunction(() => !!window.__check, null, { timeout: 120000 });
  report = await page.evaluate((o) => window.__check.run(o), { ids, cubes });
} catch (e) {
  errors.push(String(e?.stack ?? e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
if (report) {
  const { mismatches, ...rest } = report;
  console.log(JSON.stringify({ ...rest, mismatches: mismatches.length }, null, 1));
  for (const m of mismatches.slice(0, 20)) console.log('MISMATCH', m);
}
for (const e of errors.slice(0, 10)) console.log('ERROR', e);
process.exit(errors.length || !report || report.mismatches.length || report.glErrors ? 1 : 0);
