#!/usr/bin/env node
// tools/smoke.mjs — ARCHITECT-OWNED end-to-end smoke test (npm run smoke).
//
// Starts Vite on a free port, opens /?stage=testpad&menu=0 in headless chromium (SwiftShader WebGL2),
// waits for window.__rally.ready, starts the race, holds throttle for 3 s via setRawInput, and asserts
// the car moved. Also checks pause/step, teleport and reset through the test API. Screenshot:
// artifacts/smoke.png. Prints a JSON summary; exits 1 on any failure (incl. console errors).
//
// Options: --url http://host:port/ (use a running dev server)  --headed  --seconds 3
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, openGame, parseArgs, sleep, startServer, waitReady } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const holdMs = Math.round(Number(args.seconds ?? 3) * 1000);
const outDir = path.join(ROOT, 'artifacts');
fs.mkdirSync(outDir, { recursive: true });

const summary = { ok: false, checks: {}, errors: [], warnings: [], url: null, timings: {} };
const fail = (name, msg) => {
  summary.checks[name] = { ok: false, msg };
};
const pass = (name, info) => {
  summary.checks[name] = { ok: true, ...(info ?? {}) };
};

let server = null;
let browser = null;
const t0 = Date.now();
try {
  const base = typeof args.url === 'string' ? args.url : (server = await startServer()).url;
  summary.timings.server = Date.now() - t0;
  browser = await launchBrowser({ headed: !!args.headed });
  const g = await openGame(browser, base, { stage: 'testpad', menu: 0 });
  const { page } = g;
  summary.url = g.url;
  await waitReady(page, 90000);
  summary.timings.ready = Date.now() - t0;
  pass('ready');

  const info = await page.evaluate(() => ({ version: window.__rally.version, stage: window.__rally.getStageInfo() }));
  summary.version = info.version;
  summary.stage = { id: info.stage.id, length: info.stage.length, discipline: info.stage.discipline };

  // ---- drive: hold throttle (keyboard-style digital input through the §5.1 filter)
  const before = await page.evaluate(() => {
    window.__rally.startRace();
    return window.__rally.getTelemetry();
  });
  await page.evaluate(() => window.__rally.setRawInput({ device: 'keyboard', throttleDigital: true, throttle: 1 }));
  await sleep(holdMs);
  const after = await page.evaluate(() => window.__rally.getTelemetry());
  const race = await page.evaluate(() => window.__rally.getRaceState());
  const stats = await page.evaluate(() => window.__rally.getFrameStats());
  await page.evaluate(() => window.__rally.setRawInput(null));
  const moved = Math.hypot(after.pos.x - before.pos.x, after.pos.y - before.pos.y, after.pos.z - before.pos.z);
  summary.drive = {
    heldMs: holdMs,
    speedKmh: +after.speedKmh.toFixed(2),
    moved: +moved.toFixed(2),
    gear: after.gear,
    rpm: Math.round(after.rpm),
    phase: race.phase,
    raceTime: +race.time.toFixed(2),
    simTimeAdvanced: +(after.simTime - before.simTime).toFixed(3),
    fps: +stats.fps.toFixed(1),
    frames: stats.frames,
  };
  if (after.speedKmh > 0 && moved > 1) pass('drive', { speedKmh: summary.drive.speedKmh, moved: summary.drive.moved });
  else fail('drive', `car did not move: speed ${after.speedKmh} km/h, moved ${moved} m`);
  if (race.phase === 'running') pass('racePhase');
  else fail('racePhase', `expected phase 'running', got '${race.phase}'`);

  await page.screenshot({ path: path.join(outDir, 'smoke.png') });
  summary.screenshot = 'artifacts/smoke.png';

  // ---- deterministic stepping while paused
  const stepRes = await page.evaluate(() => {
    const r = window.__rally;
    r.pause(true);
    const a = r.getTelemetry().stepCount;
    const t = r.step(12);
    r.pause(false);
    return { a, b: t.stepCount };
  });
  if (stepRes.b - stepRes.a === 12) pass('pauseStep');
  else fail('pauseStep', `step(12) advanced ${stepRes.b - stepRes.a} steps`);

  // ---- teleport + reset
  const tp = await page.evaluate(() => {
    const r = window.__rally;
    const info = r.getStageInfo();
    const s = Math.min(info.length - 50, info.startS + 100);
    r.teleport(s, 0);
    const t1 = r.getTelemetry();
    r.reset();
    const t2 = r.getTelemetry();
    return { s, resetCount1: t1.resetCount, resetCount2: t2.resetCount, raceS: r.getRaceState().s };
  });
  if (tp.resetCount2 > tp.resetCount1) pass('teleportReset', tp);
  else fail('teleportReset', `reset did not increment resetCount (${JSON.stringify(tp)})`);

  // ---- params round trip
  const pr = await page.evaluate(() => {
    const r = window.__rally;
    r.setParam('mass', 1300);
    const m = r.getParams().car.mass;
    r.setParam('car.mass', 1230);
    let threw = false;
    try {
      r.setParam('car.noSuchKey', 1);
    } catch {
      threw = true;
    }
    return { m, threw };
  });
  if (pr.m === 1300 && pr.threw) pass('params');
  else fail('params', JSON.stringify(pr));

  await sleep(300); // let a few frames render after the API calls
  summary.errors = g.errors;
  summary.warnings = g.warnings.slice(0, 20);
  summary.ignoredConsole = g.ignored.length;
  if (g.errors.length === 0) pass('noErrors');
  else fail('noErrors', `${g.errors.length} console/page error(s)`);
} catch (err) {
  fail('exception', String(err && err.stack ? err.stack : err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
summary.timings.total = Date.now() - t0;
summary.ok = Object.values(summary.checks).length > 0 && Object.values(summary.checks).every((c) => c.ok);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
