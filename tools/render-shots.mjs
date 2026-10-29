#!/usr/bin/env node
// tools/render-shots.mjs — RENDER BUILDER tool: screenshots of the render preview page
// (tools/render-preview/index.html: synthetic stage + kinematic fake car; no sim/world/game needed).
//
//   node tools/render-shots.mjs                     # default scenario set → artifacts/render/*.png
//   node tools/render-shots.mjs --only chase,dust   # subset by name
//   node tools/render-shots.mjs --url http://localhost:5173/ --width 1920 --height 1080
//
// Prints a JSON summary (per shot: render stats, draw calls, triangles, particles, cpu ms) and any
// console errors. Exit code 1 on page errors.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const W = Number(args.width ?? 1280), H = Number(args.height ?? 720);
const outDir = path.join(ROOT, String(args.out ?? 'artifacts/render'));
fs.mkdirSync(outDir, { recursive: true });

/** Each scenario: load options, car settings, camera, simulated seconds. */
const SCENARIOS = [
  { name: 'chase_gravel', load: { env: 'day', car: 'awd_wrc', s: 30 }, set: { speed: 22, drift: 0.0 }, cam: 'chase', run: 2.5 },
  { name: 'chase_gravel_slide', load: { env: 'day', car: 'awd_wrc', s: 60 }, set: { speed: 24, drift: 0.45, wheelspin: 6 }, cam: 'chase', run: 3 },
  { name: 'chaseFar_tarmac_smoke', load: { env: 'day', car: 'rwd_classic', s: 230 }, set: { speed: 18, drift: 0.5, wheelspin: 9 }, cam: 'chaseFar', run: 2.5 },
  { name: 'chaseNear_snow', load: { env: 'snow', car: 'fwd_hatch', s: 420 }, set: { speed: 20, drift: 0.3, wheelspin: 4 }, cam: 'chaseNear', run: 3 },
  { name: 'chaseHigh_mud', load: { env: 'overcast', car: 'awd_wrc', s: 630 }, set: { speed: 20, drift: 0.35, wheelspin: 5 }, cam: 'chaseHigh', run: 2.5 },
  { name: 'bonnet_ice', load: { env: 'dusk', car: 'rwd_classic', s: 830 }, set: { speed: 18, drift: 0.2 }, cam: 'bonnet', run: 1.5 },
  { name: 'bumper_sand', load: { env: 'desert', car: 'awd_wrc', s: 1030 }, set: { speed: 25 }, cam: 'bumper', run: 1.5 },
  { name: 'tetherLow_grass', load: { env: 'day', car: 'fwd_hatch', s: 1230 }, set: { speed: 15, drift: 0.3, wheelspin: 5 }, cam: 'tetherLow', run: 3 },
  { name: 'tetherHigh_start', load: { env: 'day', car: 'awd_wrc', s: 0 }, set: { speed: 0 }, cam: 'tetherHigh', run: 1 },
  { name: 'night_cobbles', load: { env: 'night', car: 'awd_wrc', s: 1630 }, set: { speed: 16, brake: 1 }, cam: 'chase', run: 2 },
  { name: 'water_spray', load: { env: 'overcast', car: 'rwd_classic', s: 1830 }, set: { speed: 25 }, cam: 'chase', run: 2.5 },
  { name: 'lookback', load: { env: 'day', car: 'awd_wrc', s: 60 }, set: { speed: 20, drift: 0.3, wheelspin: 5 }, cam: 'chase', lookBack: true, run: 2 },
  { name: 'ghost', load: { env: 'day', car: 'awd_wrc', s: 240, surfaces: ['tarmac'] }, set: { speed: 15 }, ghost: true, cam: 'chaseFar', run: 1.5 },
  { name: 'flipped', load: { env: 'day', car: 'awd_wrc', s: 80 }, set: { speed: 3, extraRoll: 2.6 }, cam: 'chase', run: 2 },
];

// static model checks: three-quarter front, side and rear-three-quarter views (car-local debug camera)
const ORBIT = [];
for (const car of ['awd_wrc', 'fwd_hatch', 'rwd_classic']) {
  ORBIT.push({ name: `model_${car}_front34`, car, pos: { x: -4.2, y: 1.4, z: -5.2 }, target: { x: 0, y: 0.1, z: 0 } });
  ORBIT.push({ name: `model_${car}_side`, car, pos: { x: 6.5, y: 0.6, z: 0 }, target: { x: 0, y: 0.1, z: 0 } });
  ORBIT.push({ name: `model_${car}_rear34`, car, pos: { x: 3.8, y: 1.8, z: 5.2 }, target: { x: 0, y: 0.1, z: 0 } });
}

const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const want = (n) => !only || [...only].some((o) => n.includes(o));

let server = null, browser = null;
const summary = { ok: false, shots: [], errors: [] };
try {
  const base = typeof args.url === 'string' ? args.url : (server = await startServer()).url;
  browser = await launchBrowser({ headed: !!args.headed });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => summary.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/GPU stall|software WebGL|GL Driver/i.test(m.text())) summary.errors.push(`console: ${m.text()}`);
    if (m.type() === 'info' || m.type() === 'warning') summary.shots.length === 0 && console.error(`[page] ${m.text()}`);
  });
  const q = `quality=${args.quality ?? 'high'}&pr=${args.pr ?? 1}&aa=${args.aa ?? 1}`;
  await page.goto(`${base}tools/render-preview/index.html?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__preview && window.__preview.ready, null, { timeout: 120000 });
  for (const sc of SCENARIOS) {
    if (!want(sc.name)) continue;
    const t0 = Date.now();
    const stats = await page.evaluate((sc) => {
      const p = window.__preview;
      p.load(sc.load);
      p.camera(sc.cam);
      p.lookBack(!!sc.lookBack);
      p.set(sc.set);
      p.ghost(!!sc.ghost);
      p.run(sc.run, 30);
      const st = p.stats();
      p.lookBack(false);
      return st;
    }, sc);
    const file = path.join(outDir, `${sc.name}.png`);
    await page.screenshot({ path: file });
    summary.shots.push({ name: sc.name, file: path.relative(ROOT, file), ms: Date.now() - t0, stats });
  }
  for (const o of ORBIT) {
    if (!want(o.name)) continue;
    const stats = await page.evaluate((o) => {
      const p = window.__preview;
      p.load({ env: 'day', car: o.car, s: 240, flat: true, surfaces: ['tarmac'] });
      p.set({ speed: 0, steer: 0.6 });
      p.debugCamera(o.pos, o.target, true);
      p.run(0.5, 30);
      const st = p.stats();
      p.debugCamera(null);
      return st;
    }, o);
    const file = path.join(outDir, `${o.name}.png`);
    await page.screenshot({ path: file });
    summary.shots.push({ name: o.name, file: path.relative(ROOT, file), stats });
  }
  summary.ok = summary.errors.length === 0;
} catch (e) {
  summary.errors.push(String(e && e.stack ? e.stack : e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
for (const s of summary.shots) {
  const st = s.stats ?? {};
  console.log(`${s.name.padEnd(24)} calls ${String(st.drawCalls).padStart(4)}  tris ${String(Math.round((st.triangles ?? 0) / 1000)).padStart(5)}k  particles ${String(st.particles).padStart(5)}  skids ${String(st.skidSegments).padStart(5)}  cpu ${st.cpuMs}ms  ${s.ms ?? ''}ms`);
}
if (summary.errors.length) console.log('ERRORS:\n' + summary.errors.join('\n'));
process.exit(summary.ok ? 0 : 1);
