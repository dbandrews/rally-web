// tools/effects-shots.mjs — EFFECTS-BUILDER tool: drive a stage with the autopilot (stepped, deterministic),
// then look at the player car from chase / side / low cameras and save screenshots + the original-effects stats.
//
//   node tools/effects-shots.mjs --stage kenya-1-f [--car AudiS1] [--seconds 12] [--out artifacts/effects/<stage>]
//                                [--keys "ArrowUp+ArrowLeft:2000"] [--query orig=0]
// Prints JSON: { errors, warnings, stats, shots }. Console errors are failures (exit 1).
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, openGame, parseArgs, ROOT, startServer, waitReady } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const stage = args.stage ?? 'kenya-1-f';
const seconds = Number(args.seconds ?? 12);
const out = path.resolve(ROOT, args.out ?? `artifacts/effects/${stage}`);
fs.mkdirSync(out, { recursive: true });
const query = { stage, menu: 0, countdown: 0, audio: 0 };
if (args.car) query.car = args.car;
for (const kv of [].concat(args.query ?? [])) {
  const [k, v] = String(kv).split('=');
  query[k] = v;
}

const server = await startServer();
const browser = await launchBrowser();
let code = 0;
try {
  const g = await openGame(browser, server.url, query);
  await waitReady(g.page, 120000);
  const page = g.page;
  await page.evaluate(() => {
    const r = window.__rally;
    r.startRace();
    r.setAutopilot(true);
    r.pause(true);
  });
  // wait for the async original-effects load
  await page.waitForFunction(() => window.__rallyRenderer?.particles?.orig?.stage !== undefined, null, { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(3000);
  const shots = [];
  const views = [
    ['chase', { x: 0, y: 2.2, z: 7.5 }, { x: 0, y: 0.4, z: -4 }],
    ['side', { x: 6, y: 1.6, z: 4 }, { x: 0, y: 0.3, z: 1.5 }],
    ['rear-low', { x: -2.5, y: 0.8, z: 6 }, { x: 0, y: 0.3, z: 0 }],
  ];
  const stepsPer = 30; // 0.25 s sim per call
  const total = Math.round((seconds * 120) / stepsPer);
  for (let i = 0; i < total; i++) await page.evaluate((n) => window.__rally.step(n), stepsPer);
  // the last 0.75 s at 60 Hz frames, so short-lived particles (0.1–0.3 s) are alive as in the real game
  for (let i = 0; i < 45; i++) await page.evaluate(() => window.__rally.step(2));
  const stats = await page.evaluate(() => ({
    fx: window.__rallyRenderer.particles.orig.debugStats(),
    info: window.__rallyRenderer.debugInfo(),
    tel: (() => {
      const t = window.__rally.getTelemetry();
      return { speedKmh: t.speedKmh, wheels: t.wheels.map((w) => ({ surface: w.surface, material: w.material, slip: +Math.tan(w.slipAngle).toFixed(3), kappa: +w.kappa.toFixed(3) })) };
    })(),
  }));
  for (const [name, pos, target] of views) {
    await page.evaluate(([p, t]) => window.__rallyRenderer.setDebugCamera(p, t, true), [pos, target]);
    for (let i = 0; i < 6; i++) await page.evaluate(() => window.__rally.step(2));
    await page.waitForTimeout(400);
    const file = path.join(out, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push(path.relative(ROOT, file));
  }
  await page.evaluate(() => window.__rallyRenderer.setDebugCamera(null));
  const res = { stage, errors: g.errors, warnings: g.warnings.slice(0, 20), stats, shots };
  console.log(JSON.stringify(res, null, 2));
  if (g.errors.length) code = 1;
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);
