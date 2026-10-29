#!/usr/bin/env node
// tools/render-stage-shots.mjs — RENDER BUILDER tool: screenshots of the REAL game (sim + world + game)
// on every stage from several cameras, driven by the autopilot with deterministic stepping.
//
//   node tools/render-stage-shots.mjs                              # all stages, default cameras
//   node tools/render-stage-shots.mjs --stages pine-ridge,frostvale --cams chase,bonnet --seconds 8
//   node tools/render-stage-shots.mjs --quality high --pr 1 --aa 1  # (defaults) full-quality frames
//
// For each stage: load (car via --car), start, autopilot on, pause, then advance `seconds` of sim time in
// 4-step frames (so effects / cameras see a normal frame cadence), and screenshot each camera after a
// short re-settle. Output: artifacts/render-stages/<stage>_<cam>.png + a summary line per shot.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, openGame, parseArgs, startServer, waitReady } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const outDir = path.join(ROOT, String(args.out ?? 'artifacts/render-stages'));
fs.mkdirSync(outDir, { recursive: true });
const cams = String(args.cams ?? 'chase,chaseFar,bonnet,tetherLow').split(',');
const seconds = Number(args.seconds ?? 6);
const car = String(args.car ?? 'awd_wrc');
const query = { menu: 0, countdown: 0, quality: args.quality ?? 'high', pr: args.pr ?? 1, aa: args.aa ?? 1, car };

let server = null, browser = null;
const errors = [];
try {
  const base = typeof args.url === 'string' ? args.url : (server = await startServer()).url;
  browser = await launchBrowser({ headed: !!args.headed });
  const g = await openGame(browser, base, { stage: 'testpad', ...query }, { width: Number(args.width ?? 1280), height: Number(args.height ?? 720) });
  await waitReady(g.page, 120000);
  const all = await g.page.evaluate(() => window.__rally.listStages().map((s) => s.id));
  const stages = typeof args.stages === 'string' ? args.stages.split(',') : all;
  for (const id of stages) {
    await g.page.evaluate(async ({ id, car }) => {
      const r = window.__rally;
      await r.loadStage(id, { car, countdown: false });
      r.startRace();
      r.setAutopilot(true);
      r.pause(true);
    }, { id, car });
    // drive in frame-sized chunks
    const frames = Math.round((seconds * 120) / 12);
    await g.page.evaluate((frames) => {
      for (let i = 0; i < frames; i++) window.__rally.step(12);
    }, frames);
    for (const cam of cams) {
      const info = await g.page.evaluate((cam) => {
        const r = window.__rally;
        r.setCamera(cam);
        for (let i = 0; i < 24; i++) r.step(4); // let the camera / effects settle in this view (0.8 s)
        const t = r.getTelemetry();
        const R = window.__rallyRenderer;
        const st = R.stats();
        return { kmh: Math.round(t.speedKmh), surface: t.wheels[0].surface, s: Math.round(r.getRaceState().s), calls: st.drawCalls, tris: st.triangles, ...R.debugInfo() };
      }, cam);
      const file = path.join(outDir, `${id}_${cam}.png`);
      await g.page.screenshot({ path: file, timeout: 180000 });
      console.log(`${id.padEnd(12)} ${cam.padEnd(10)} s=${String(info.s).padStart(5)} ${String(info.kmh).padStart(3)} km/h ${String(info.surface).padEnd(8)} calls ${info.calls} tris ${Math.round(info.tris / 1000)}k particles ${info.particles} skids ${info.skidSegments}`);
    }
  }
  errors.push(...g.errors);
} catch (e) {
  errors.push(String(e && e.stack ? e.stack : e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
if (errors.length) console.log('ERRORS:\n' + errors.slice(0, 10).join('\n'));
process.exit(errors.length ? 1 : 0);
