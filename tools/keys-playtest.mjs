#!/usr/bin/env node
// tools/keys-playtest.mjs — end-to-end playtest with REAL keyboard events (npm run keys).
//
// For each stage (default: testpad and pine-ridge) it opens the game WITH the start menu and checks, using
// only page.keyboard (no test-API input overrides):
//   menu       the main menu is shown, phase idle
//   countdown  Enter starts the stage: phase countdown, then running
//   drive      ArrowUp accelerates, ArrowUp+ArrowLeft turns the car (heading changes)
//   reset      R resets onto the road (resets +1, fade, car back near the centre line, at rest)
//   camera     C cycles the camera (chase -> chaseFar)
//   panel      F1 opens the tuning panel; typing a new torqueScale into its number box changes the
//              car (setParam path 'torqueScale') and the car accelerates measurably slower afterwards
//   overlay    F2 shows the telemetry overlay; F1 / F2 close both again
// Screenshots per stage in artifacts/keys/<stage>/. Prints a JSON summary; exit 1 on any failure.
//
// Options: --stages a,b  --url http://host:port/  --headed  --torque <value> (default 40 % of the shipped value)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, openGame, parseArgs, sleep, startServer, waitReady } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const stages = typeof args.stages === 'string' ? args.stages.split(',') : ['testpad', 'pine-ridge'];
const result = { ok: false, stages: {}, errors: [] };
/** Throttle-hold length for the torque comparison (sim seconds). */
const ACC_S = 3.5;

const tel = (page) => page.evaluate(() => window.__rally.getTelemetry());
const race = (page) => page.evaluate(() => window.__rally.getRaceState());

async function waitFor(page, fn, arg, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(fn, arg)) return Date.now() - t0;
    await sleep(50);
  }
  throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
}

/** Hold the given keys until `simSeconds` of sim time have passed; returns [{t, v, heading}] samples. */
async function holdForSim(page, keys, simSeconds, timeoutMs = 60000) {
  const t0 = (await tel(page)).simTime;
  for (const k of keys) await page.keyboard.down(k);
  const samples = [];
  const wall0 = Date.now();
  try {
    for (;;) {
      const s = await page.evaluate(() => {
        const t = window.__rally.getTelemetry();
        const q = t.quat;
        return { t: t.simTime, v: t.speedKmh, heading: Math.atan2(-(2 * (q.x * q.z + q.w * q.y)), -(1 - 2 * (q.x * q.x + q.y * q.y))) };
      });
      samples.push({ ...s, t: s.t - t0 });
      if (s.t - t0 >= simSeconds) break;
      if (Date.now() - wall0 > timeoutMs) throw new Error(`holdForSim: sim did not advance ${simSeconds} s`);
      await sleep(30);
    }
  } finally {
    for (const k of [...keys].reverse()) await page.keyboard.up(k);
  }
  return samples;
}

/** Speed (km/h) at sim time t (linear interpolation over samples). */
function speedAt(samples, t) {
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (b.t >= t) return a.v + ((b.v - a.v) * (t - a.t)) / Math.max(1e-6, b.t - a.t);
  }
  return samples[samples.length - 1].v;
}

/** Tap a key and wait until at least two frames have been rendered (taps within one frame coalesce). */
async function tap(page, key) {
  const f0 = await page.evaluate(() => window.__rally.getFrameStats().frames);
  await page.keyboard.press(key);
  await waitFor(page, (f) => window.__rally.getFrameStats().frames >= f + 2, f0, 10000, `frames after ${key}`);
}

async function pressReset(page, rs0) {
  await tap(page, 'KeyR');
  await waitFor(page, (n) => window.__rally.getRaceState().resets > n, rs0, 15000, 'reset counted');
  await waitFor(page, () => !window.__rally.getRaceState().resetting && window.__rally.getRaceState().controllable, null, 30000, 'reset finished');
  // let the settle finish and the car come to rest
  await waitFor(page, () => window.__rally.getTelemetry().speedKmh < 1, null, 20000, 'car at rest after reset');
}

async function playStage(browser, base, stageId) {
  const out = path.join(ROOT, 'artifacts', 'keys', stageId);
  fs.mkdirSync(out, { recursive: true });
  const st = { ok: false, checks: {}, screenshots: [] };
  const check = (name, ok, info) => (st.checks[name] = { ok: !!ok, ...(info ?? {}) });
  const shot = async (page, name) => {
    const f = path.join(out, `${name}.png`);
    await page.screenshot({ path: f });
    st.screenshots.push(path.relative(ROOT, f));
  };
  const g = await openGame(browser, base, { stage: stageId, audio: 0 });
  const { page } = g;
  try {
    await waitReady(page, 90000);
    await page.mouse.click(5, 5); // focus the page (real players click / press a key first)

    // ---- menu
    const menu = await page.evaluate(() => ({
      open: !!document.querySelector('.rw-menu.rw-open'),
      phase: window.__rally.getRaceState().phase,
      text: document.querySelector('.rw-menu')?.textContent?.slice(0, 120) ?? '',
    }));
    check('menu', menu.open && menu.phase === 'idle', menu);
    await shot(page, '01-menu');

    // ---- Enter -> countdown -> running
    await page.keyboard.press('Enter');
    await waitFor(page, () => window.__rally.getRaceState().phase === 'countdown', null, 15000, 'countdown');
    const cd = await race(page);
    await shot(page, '02-countdown');
    const goMs = await waitFor(page, () => window.__rally.getRaceState().phase === 'running', null, 60000, 'GO');
    check('countdown', !(await page.evaluate(() => !!document.querySelector('.rw-menu.rw-open'))), { countdownAt: +cd.countdown.toFixed(2), msToGo: goMs });

    // ---- drive: throttle from the line (baseline acceleration), then throttle + left
    const p0 = await tel(page);
    const base1 = await holdForSim(page, ['ArrowUp'], 2.0);
    const v15a = speedAt(base1, 1.5);
    const turn = await holdForSim(page, ['ArrowUp', 'ArrowLeft'], 1.0);
    const p1 = await tel(page);
    let dHead = turn[turn.length - 1].heading - turn[0].heading;
    dHead = Math.atan2(Math.sin(dHead), Math.cos(dHead));
    const moved = Math.hypot(p1.pos.x - p0.pos.x, p1.pos.z - p0.pos.z);
    // car local forward -Z; steering left turns toward -X when facing -Z: heading (atan2 x,z of forward) grows
    check('drive', v15a > 15 && moved > 10 && Math.abs(dHead) > 0.15, {
      speedAt1_5s: +v15a.toFixed(1),
      moved: +moved.toFixed(1),
      headingChangeDeg: +((dHead * 180) / Math.PI).toFixed(1),
      steerTel: +p1.steer.toFixed(2),
    });
    await shot(page, '03-driving');

    // ---- R reset
    const r0 = await race(page);
    await pressReset(page, r0.resets);
    const r1 = await race(page);
    const after = await page.evaluate(() => window.__rally.probe());
    check('reset', r1.resets === r0.resets + 1 && Math.abs(after.lateral) < 2.5 && after.clearance > 0 && after.upY > 0.9, {
      resets: r1.resets,
      lateral: +after.lateral.toFixed(2),
      clearance: +after.clearance.toFixed(2),
      sBefore: +r0.s.toFixed(1),
      sAfter: +r1.s.toFixed(1),
    });

    // ---- C camera
    const cam0 = await page.evaluate(() => window.__rallyRenderer.getCameraMode());
    await tap(page, 'KeyC');
    const cam1 = await page.evaluate(() => window.__rallyRenderer.getCameraMode());
    check('camera', cam0 !== cam1, { from: cam0, to: cam1 });
    await shot(page, '04-camera-' + cam1);
    // back to the default view for the measurements / screenshots
    for (let i = 0; i < 7; i++) await tap(page, 'KeyC');
    const cam2 = await page.evaluate(() => window.__rallyRenderer.getCameraMode());

    // ---- baseline acceleration from rest (after the reset) with shipped torque. The launch is wheelspin /
    // traction limited (§2), so torque shows from ~40 km/h on: compare the speed after 3.5 s.
    const accBase = await holdForSim(page, ['ArrowUp'], ACC_S);
    const vBase = speedAt(accBase, ACC_S);
    const latBase = (await page.evaluate(() => window.__rally.probe())).lateral;
    const r2 = await race(page);
    await pressReset(page, r2.resets);

    // ---- F1 tuning panel: type a new torqueScale into the number box
    await tap(page, 'F1');
    const panelOpen = await page.evaluate(() => {
      const el = document.querySelector('.lil-gui.rw-tuning');
      return !!el && getComputedStyle(el).display !== 'none';
    });
    const shipped = await page.evaluate(() => window.__rally.getParams().car.torqueScale);
    // the panel's torqueScale control has step 5 (tuningSchema)
    const target = args.torque !== undefined ? Number(args.torque) : Math.round((shipped * 0.4) / 5) * 5;
    const typed = await page.evaluate(() => {
      // find the torqueScale controller (Engine folder), open its folders, focus its text box
      const ctrls = [...document.querySelectorAll('.lil-gui.rw-tuning .lil-controller')];
      const c = ctrls.find((el) => el.querySelector('.lil-name')?.textContent?.trim() === 'torqueScale');
      if (!c) return { found: false };
      for (let f = c.closest('.lil-gui'); f && !f.classList.contains('lil-root'); f = f.parentElement?.closest('.lil-gui')) {
        if (f.classList.contains('lil-closed')) f.querySelector(':scope > .lil-title')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      const input = c.querySelector('input');
      input.scrollIntoView({ block: 'center' });
      input.id = 'kp-torque-input';
      return { found: true, value: input.value };
    });
    if (!typed.found) throw new Error('torqueScale controller not found in the tuning panel');
    await sleep(400); // folder open transition
    await page.click('#kp-torque-input', { clickCount: 3 });
    await page.keyboard.type(String(target));
    await page.keyboard.press('Enter');
    await page.evaluate(() => document.activeElement?.blur());
    await sleep(200);
    const now = await page.evaluate(() => window.__rally.getParams().car.torqueScale);
    await shot(page, '05-panel');
    check('panel', panelOpen && now === target, { open: panelOpen, shipped, typed: target, carTorqueScale: now, inputBefore: typed.value });

    // the panel has focus-stealing inputs: make sure driving keys reach the car again
    const accLow = await holdForSim(page, ['ArrowUp'], ACC_S);
    const vLow = speedAt(accLow, ACC_S);
    const latLow = (await page.evaluate(() => window.__rally.probe())).lateral;
    check('panelChangesCar', vLow < vBase * 0.85, {
      [`speedAt${ACC_S}s_shipped`]: +vBase.toFixed(1),
      [`speedAt${ACC_S}s_tuned`]: +vLow.toFixed(1),
      ratio: +(vLow / Math.max(1e-6, vBase)).toFixed(2),
      lateralAfter: [+latBase.toFixed(2), +latLow.toFixed(2)],
    });

    // ---- F2 telemetry overlay
    await tap(page, 'F2');
    await sleep(300);
    const ovl = await page.evaluate(() => {
      const el = document.querySelector('.rw-ovl');
      const vis = !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
      return { visible: vis, text: (el?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 160) };
    });
    await shot(page, '06-overlay');
    check('overlay', ovl.visible && /km\/h|rpm/i.test(ovl.text), ovl);
    await tap(page, 'F2');
    await tap(page, 'F1');
    const closed = await page.evaluate(() => ({
      ovl: getComputedStyle(document.querySelector('.rw-ovl')).display === 'none',
      panel: getComputedStyle(document.querySelector('.lil-gui.rw-tuning')).display === 'none',
    }));
    check('togglesClose', closed.ovl && closed.panel, closed);
    st.cameraRestored = cam2;
  } catch (e) {
    st.error = String(e && e.stack ? e.stack : e);
    await shot(page, '99-error').catch(() => {});
  }
  st.errors = g.errors;
  st.ok = !st.error && g.errors.length === 0 && Object.values(st.checks).every((c) => c.ok);
  await g.context.close();
  return st;
}

let server = null;
let browser = null;
try {
  const base = typeof args.url === 'string' ? args.url : (server = await startServer()).url;
  browser = await launchBrowser({ headed: !!args.headed });
  for (const s of stages) result.stages[s] = await playStage(browser, base, s);
  result.ok = Object.values(result.stages).every((s) => s.ok);
} catch (err) {
  result.errors.push(String(err && err.stack ? err.stack : err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
