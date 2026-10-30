#!/usr/bin/env node
// tools/cars/car-shots.mjs — CARS BUILDER tool: renders of the ORIGINAL cars (public/assets/cars, `npm run assets --
// --parts cars`) for comparison with the original's menu icons, and in-game shots on ported stages.
//
//   node tools/cars/car-shots.mjs showroom [--cars all|A,B] [--views icon,side,rear,top] [--stage <id>]
//        → artifacts/port/cars/showroom[_<stage>].png: per car the original icon (Icon<Car>.tga) + the views
//   node tools/cars/car-shots.mjs details --cars ImprezaWRX
//        → artifacts/port/cars/details_<car>.png: LOD 0..3, brake / reverse / night lights, steer, damage morph,
//          gravel wheel, ghost
//   node tools/cars/car-shots.mjs stage --stages corsica-1-f,kenya-1-f --cars ImprezaWRX,Peugeot205 [--seconds 3]
//        → artifacts/port/cars/stage_<stage>_<car>_<cam>.png: the real game (?car=<Name>), autopilot, chase /
//          bonnet / a side debug camera; prints the renderer's draw calls / triangles and debugInfo().origCars
//
// Exit 1 on console errors / page errors / failed requests (the game must load original cars silently).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, IGNORED_CONSOLE, launchBrowser, openGame, parseArgs, startServer, waitReady } from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const mode = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'showroom';
const outDir = path.join(ROOT, String(args.out ?? 'artifacts/port/cars'));
fs.mkdirSync(outDir, { recursive: true });
const manifestPath = path.join(ROOT, 'public/assets/manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.log('no public/assets/manifest.json — build the cars first: npm run assets -- --parts cars');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8') || 'null');
const builtCars = manifest?.cars ?? [];
const pickCars = (v, def) => (v === undefined ? def : v === 'all' ? builtCars : String(v).split(','));

const VIEWS = {
  icon: { label: 'front 3/4 (icon view)', az: 38, el: 14, dist: 7, fov: 30 },
  side: { label: 'left side', az: 90, el: 4, dist: 8, fov: 30 },
  rear: { label: 'rear 3/4', az: 150, el: 16, dist: 7.5, fov: 30 },
  top: { label: 'top', az: 90, el: 80, dist: 12, fov: 30 },
  front: { label: 'front', az: 0, el: 6, dist: 7, fov: 30 },
};
const DETAIL_VIEWS = [
  { label: 'LOD0', az: 38, el: 14, dist: 7, lod: 0 },
  { label: 'LOD1', az: 38, el: 14, dist: 7, lod: 1 },
  { label: 'LOD2', az: 38, el: 14, dist: 7, lod: 2 },
  { label: 'LOD3', az: 38, el: 14, dist: 7, lod: 3 },
  { label: 'rear, lights off', az: 165, el: 8, dist: 5.5 },
  { label: 'brake lights', az: 165, el: 8, dist: 5.5, brake: true },
  { label: 'reverse lights', az: 165, el: 8, dist: 5.5, reverse: true },
  { label: 'night head flares', az: 20, el: 6, dist: 6.5, night: true },
  { label: 'steer 25° right', az: 0, el: 55, dist: 6, steer: 25 },
  { label: 'gravel wheel (tyre 2)', az: 90, el: 4, dist: 6, tyre: 2 },
  { label: 'damage morph 1', az: 38, el: 14, dist: 7, damage: 1 },
  { label: 'ghost', az: 38, el: 14, dist: 7, ghost: true },
];

let server = null;
let browser = null;
const problems = [];
const watch = (page) => {
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !IGNORED_CONSOLE.some((r) => r.test(m.text())) && problems.push(`console.${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => !r.url().includes('favicon') && problems.push(`requestfailed: ${r.url()}`));
};

async function showroom(base, cars, views, file, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(base + 'tools/cars/showroom.html');
  await page.waitForFunction(() => !!window.__showroom, null, { timeout: 120000 });
  const res = await page.evaluate((o) => window.__showroom.run(o), { cars, views, width: opts.width ?? 300, height: opts.height ?? 200, stageId: opts.stageId ?? null, menu: true });
  for (const r of res) {
    if (r.error) problems.push(`${r.car}: ${r.error.split('\n')[0]}`);
    console.log(`${r.car.padEnd(18)} ${r.name.padEnd(36)} ${r.shots.map((s) => `${s.label}: ${s.drawCalls} calls ${Math.round(s.triangles / 100) / 10}k tris`).join(' | ')}`);
  }
  await page.screenshot({ path: file, fullPage: true, timeout: 300000 });
  console.log('→', path.relative(ROOT, file));
  await ctx.close();
}

async function stageShots(base, stages, cars, seconds) {
  for (const stage of stages) {
    for (const car of cars) {
      const g = await openGame(browser, base, { stage, car, menu: 0, countdown: 0, quality: args.quality ?? 'low' }, { width: 960, height: 540 });
      await waitReady(g.page, 180000);
      // wait for the original visual (loads after the procedural car)
      await g.page.waitForFunction(() => (window.__rallyRenderer.debugInfo().origCars ?? []).some((c) => c.car), null, { timeout: 120000, polling: 250 }).catch(() => {});
      await g.page.evaluate((frames) => {
        const r = window.__rally;
        r.startRace();
        r.setAutopilot(true);
        r.pause(true);
        for (let i = 0; i < frames; i++) r.step(12);
      }, Math.round((seconds * 120) / 12));
      const cams = [
        { name: 'chase', cam: 'chase' },
        { name: 'bonnet', cam: 'bonnet' },
        { name: 'side', cam: 'chase', debug: { pos: { x: -4.2, y: 1.1, z: -1.2 }, target: { x: 0, y: 0.2, z: -0.3 } } },
        { name: 'front', cam: 'chase', debug: { pos: { x: -2.6, y: 1.3, z: -5.5 }, target: { x: 0, y: 0.3, z: 0 } } },
      ];
      for (const c of cams) {
        const info = await g.page.evaluate((c) => {
          const r = window.__rally;
          const R = window.__rallyRenderer;
          r.setCamera(c.cam);
          R.setDebugCamera(c.debug ? c.debug.pos : null, c.debug?.target, true);
          for (let i = 0; i < 8; i++) r.step(4);
          const st = R.stats();
          const d = R.debugInfo();
          return { kmh: Math.round(r.getTelemetry().speedKmh), calls: st.drawCalls, tris: st.triangles, origCars: d.origCars, orig: d.orig };
        }, c);
        const file = path.join(outDir, `stage_${stage}_${car}_${c.name}.png`);
        await g.page.screenshot({ path: file, timeout: 180000 });
        console.log(JSON.stringify({ stage, car, cam: c.name, ...info, shot: path.relative(ROOT, file) }));
      }
      for (const e of g.errors) problems.push(`[${stage} ${car}] ${e}`);
      for (const w of g.warnings) problems.push(`[${stage} ${car}] warning: ${w}`);
      await g.context.close();
    }
  }
}

try {
  const base = typeof args.url === 'string' ? args.url : (server = await startServer()).url;
  browser = await launchBrowser({ headed: !!args.headed });
  if (mode === 'showroom') {
    const cars = pickCars(args.cars, builtCars);
    const views = String(args.views ?? 'icon,side,rear').split(',').map((v) => VIEWS[v]);
    const stageId = typeof args.stage === 'string' ? args.stage : null;
    const tag = typeof args.tag === 'string' ? `_${args.tag}` : '';
    await showroom(base, cars, views, path.join(outDir, `showroom${stageId ? `_${stageId}` : ''}${tag}.png`), { stageId });
  } else if (mode === 'details') {
    for (const car of pickCars(args.cars, ['ImprezaWRX'])) await showroom(base, [car], DETAIL_VIEWS, path.join(outDir, `details_${car}.png`), { width: 300, height: 200 });
  } else if (mode === 'stage') {
    await stageShots(base, String(args.stages ?? 'corsica-1-f').split(','), pickCars(args.cars, ['ImprezaWRX']), Number(args.seconds ?? 3));
  } else throw new Error(`unknown mode ${mode}`);
} catch (e) {
  problems.push(String(e?.stack ?? e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
for (const p of problems.slice(0, 30)) console.log('PROBLEM', p);
process.exit(problems.length ? 1 : 0);
