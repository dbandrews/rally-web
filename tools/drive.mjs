#!/usr/bin/env node
// tools/drive.mjs — ARCHITECT-OWNED reusable playtest CLI (npm run drive -- <options>).
//
// Opens the game headless (SwiftShader WebGL2), starts a race, drives it with REAL keyboard events and/or
// the autopilot, samples telemetry at 5 Hz, takes screenshots, and prints a JSON summary.
//
// Options
//   --stage <id>            stage id (default: testpad)
//   --car <archetype>       awd_wrc | fwd_hatch | rwd_classic (default awd_wrc)
//   --tyre <0..4|name>      tyre type (default: stage default)
//   --seed <n>              stage / sim seed (default 1)
//   --cam <i|name>          camera mode (default: renderer default)
//   --autopilot             autopilot drives (keys still apply on top of nothing: autopilot wins)
//   --seconds <N>           total drive time in wall seconds (default 10, or the --keys total if longer)
//   --keys "<seq>"          sequential steps "KEYS:ms", KEYS = Key or Key+Key (Playwright key names,
//                           e.g. ArrowUp, ArrowLeft, Space, KeyA, Enter). "_:ms" or "wait:ms" = idle.
//                           Example: --keys "ArrowUp:3000,ArrowUp+ArrowLeft:1500,Space+ArrowLeft:500,_:1000"
//   --shots <K>             screenshots evenly spaced over the run (default 3; 0 = none)
//   --out <dir>             output dir for screenshots + trace.json (default artifacts/drive)
//   --param path=value      setParam before the run (repeatable), e.g. --param mass=1400 --param camera.fov=80
//   --countdown             run the real countdown instead of startRace() (default: skip)
//   --timescale <x>         loop time scale
//   --url <base>            use an already running dev server (e.g. http://localhost:5173/)
//   --headed                show the browser window
//   --width/--height        viewport (default 1280x720)
//   --full                  include the full 5 Hz time series in the printed JSON (always in trace.json)
//
// Stepped mode (deterministic, independent of the headless frame rate; for full-stage runs):
//   --until-finish          drive until the race finishes (implies --stepped); fails if it does not
//   --stepped [n]           pause the loop and advance n substeps per call (default 30 = 0.25 s sim), sampling
//                           after each call; --seconds then counts SIM seconds (default 10, or --max-sim)
//   --max-sim <s>           sim-time cap for --until-finish (default 600)
//   --shot-every <s>        stepped mode: a screenshot every s sim seconds (default 30 with --until-finish, else
//                           --shots evenly over --seconds); --shots 0 disables screenshots
//   --aggression <x>        autopilot aggression (0.3..1.2)
//
// Health checks (summary.checks, all modes; result.ok requires all of them): noConsoleErrors, finite telemetry
// (noNaN), no sim guard trips (noSimFaults), never below the ground (noFallThrough: clearance > -0.5 m), never
// flying off (noFlyOff: clearance < 12 m and |lateral| < 40 m), not stuck (noStuck: progress within any 15 s of
// sim time while running), no automatic resets (noAutoResets: autopilot runs only), upright (noRollover: up-vector
// y > 0 except < 1 s spells), finished (with --until-finish; on a test pad: one full loop of its road, lappedPad).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, openGame, parseArgs, sleep, startServer, waitReady } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function parseKeys(spec) {
  if (!spec || spec === true) return [];
  return String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((step) => {
      const i = step.lastIndexOf(':');
      if (i < 0) throw new Error(`bad --keys step '${step}' (want KEY:ms)`);
      const keys = step.slice(0, i).trim();
      const ms = Number(step.slice(i + 1));
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`bad duration in '${step}'`);
      const list = keys === '_' || keys.toLowerCase() === 'wait' || keys === '' ? [] : keys.split('+').map((k) => k.trim());
      return { keys: list, ms };
    });
}

function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && Number.isFinite(Number(v))) return Number(v);
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const keySteps = parseKeys(args.keys);
const keysTotal = keySteps.reduce((a, s) => a + s.ms, 0);
const untilFinish = !!args['until-finish'];
const stepped = untilFinish || args.stepped !== undefined;
const stepChunk = Math.max(1, Math.floor(Number(args.stepped === true || args.stepped === undefined ? 30 : args.stepped) || 30));
const maxSim = Number(args['max-sim'] ?? 600);
const seconds = stepped
  ? Number(args.seconds ?? (untilFinish ? maxSim : 10))
  : Math.max(Number(args.seconds ?? (keysTotal > 0 ? 0 : 10)), keysTotal / 1000);
const shots = Math.max(0, Math.floor(Number(args.shots ?? 3)));
const outDir = path.resolve(ROOT, typeof args.out === 'string' ? args.out : 'artifacts/drive');
fs.mkdirSync(outDir, { recursive: true });

const query = {
  stage: typeof args.stage === 'string' ? args.stage : 'testpad',
  car: typeof args.car === 'string' ? args.car : undefined,
  tyre: args.tyre !== undefined && args.tyre !== true ? args.tyre : undefined,
  seed: args.seed !== undefined && args.seed !== true ? args.seed : undefined,
  cam: args.cam !== undefined && args.cam !== true ? args.cam : undefined,
  autopilot: args.autopilot ? 1 : undefined,
  timescale: args.timescale !== undefined && args.timescale !== true ? args.timescale : undefined,
  menu: 0,
  countdown: args.countdown ? 1 : 0,
  audio: 0,
};

const result = {
  ok: false,
  args: { ...query, seconds, keys: args.keys ?? null, shots, stepped: stepped ? stepChunk : false, untilFinish },
  errors: [],
  screenshots: [],
};
let server = null;
let browser = null;
try {
  const base = typeof args.url === 'string' ? args.url : (server = await startServer()).url;
  browser = await launchBrowser({ headed: !!args.headed });
  const g = await openGame(browser, base, query, {
    width: Number(args.width ?? 1280),
    height: Number(args.height ?? 720),
  });
  const { page } = g;
  result.url = g.url;
  await waitReady(page, 90000);

  for (const p of asList(args.param)) {
    const s = String(p);
    const eq = s.indexOf('=');
    if (eq < 0) throw new Error(`bad --param '${s}' (want path=value)`);
    const k = s.slice(0, eq), v = parseValue(s.slice(eq + 1));
    await page.evaluate(([k, v]) => window.__rally.setParam(k, v), [k, v]);
  }
  if (args.aggression !== undefined && args.aggression !== true) {
    await page.evaluate((a) => window.__rally.setParam('autopilot.aggression', a), Number(args.aggression)).catch((e) => {
      result.errors.push(`aggression: ${e}`);
    });
  }
  result.stage = await page.evaluate(() => window.__rally.getStageInfo());
  if (!args.countdown) await page.evaluate(() => window.__rally.startRace());

  // ---- sampler (5 Hz)
  const trace = [];
  const tStart = Date.now();
  let running = true;
  const sample = async () => {
    const s = await page.evaluate(() => {
      const r = window.__rally;
      const t = r.getTelemetry();
      const race = r.getRaceState();
      const p = r.probe();
      return {
        simTime: +t.simTime.toFixed(3),
        speedKmh: +t.speedKmh.toFixed(2),
        rpm: Math.round(t.rpm),
        gear: t.gear,
        throttle: +t.throttle.toFixed(2),
        brake: +t.brake.toFixed(2),
        handbrake: +t.handbrake.toFixed(2),
        steer: +t.steer.toFixed(3),
        beta: +t.beta.toFixed(4),
        yawRate: +t.yawRate.toFixed(4),
        aLat: +t.aLat.toFixed(3),
        aLong: +t.aLong.toFixed(3),
        nContacts: t.nContacts,
        airborne: t.airborne,
        pos: { x: +t.pos.x.toFixed(2), y: +t.pos.y.toFixed(2), z: +t.pos.z.toFixed(2) },
        surfaces: t.wheels.map((w) => w.surface ?? '-').join(','),
        modes: t.wheels.map((w) => w.mode).join(''),
        phase: race.phase,
        raceTime: +race.time.toFixed(3),
        s: +race.s.toFixed(1),
        lateral: +race.lateral.toFixed(2),
        progress: +race.progress.toFixed(4),
        resets: race.resets,
        message: race.message,
        simFaults: t.simFaults ?? 0,
        finite: [t.pos.x, t.pos.y, t.pos.z, t.vel.x, t.vel.y, t.vel.z, t.speedKmh, t.rpm, t.yawRate].every(Number.isFinite),
        clearance: +p.clearance.toFixed(2),
        upY: +p.upY.toFixed(3),
        headingErrDeg: +p.headingErrDeg.toFixed(1),
        roadLateral: +p.lateral.toFixed(2),
      };
    });
    trace.push({ t: +((Date.now() - tStart) / 1000).toFixed(2), ...s });
  };
  const sampler = stepped ? Promise.resolve() : (async () => {
    while (running) {
      const next = Date.now() + 200;
      try {
        await sample();
      } catch (e) {
        result.errors.push(`sample: ${e}`);
      }
      await sleep(Math.max(0, next - Date.now()));
    }
  })();

  // ---- stepped mode: advance the sim in chunks while the loop is paused (deterministic, fast headless)
  if (stepped) {
    // --until-finish runs have no known length: default to a screenshot every 30 s of sim time
    const shotEvery = args['shot-every'] !== undefined ? Number(args['shot-every']) : untilFinish && shots > 0 ? 30 : 0;
    let nextShot = shotEvery > 0 ? shotEvery : seconds / Math.max(1, shots);
    let shotN = 0;
    await page.evaluate(() => window.__rally.pause(true));
    const sim0 = (await page.evaluate(() => window.__rally.getTelemetry().simTime)) ?? 0;
    let simT = 0;
    // test pads have no finish line: there, "finish" = one full loop of the road (route distance >= length)
    const pad = result.stage.discipline === 'testpad';
    let prevS = null;
    let loopDist = 0;
    while (simT < seconds) {
      const st = await page.evaluate((n) => {
        const r = window.__rally;
        const t = r.step(n);
        const race = r.getRaceState();
        return { simTime: t.simTime, phase: race.phase, s: race.s };
      }, stepChunk);
      simT = st.simTime - sim0;
      await sample();
      trace[trace.length - 1].t = +simT.toFixed(2);
      if (prevS !== null) {
        const L = result.stage.length;
        let d = st.s - prevS;
        if (d > L / 2) d -= L;
        if (d < -L / 2) d += L;
        loopDist += d;
      }
      prevS = st.s;
      result.loopDistance = +loopDist.toFixed(1);
      const done = untilFinish && (st.phase === 'finished' || (pad && loopDist >= result.stage.length));
      if ((shots > 0 || shotEvery > 0) && (simT >= nextShot || done) && (shotEvery > 0 || shotN < shots)) {
        shotN++;
        const file = path.join(outDir, `shot-${String(shotN).padStart(2, '0')}.png`);
        await page.screenshot({ path: file });
        result.screenshots.push(path.relative(ROOT, file));
        nextShot += shotEvery > 0 ? shotEvery : seconds / Math.max(1, shots);
      }
      if (done) {
        // let the finish settle for a moment (results screen) then stop
        await page.evaluate(() => window.__rally.step(60));
        break;
      }
    }
    await page.evaluate(() => window.__rally.pause(false));
  }

  // ---- screenshots
  const shotTimes = stepped ? [] : Array.from({ length: shots }, (_, i) => (seconds * 1000 * (i + 1)) / shots);
  const shooter = (async () => {
    for (let i = 0; i < shotTimes.length; i++) {
      const wait = tStart + shotTimes[i] - Date.now() - (i === shotTimes.length - 1 ? 150 : 0);
      if (wait > 0) await sleep(wait);
      const file = path.join(outDir, `shot-${String(i + 1).padStart(2, '0')}.png`);
      await page.screenshot({ path: file });
      result.screenshots.push(path.relative(ROOT, file));
    }
  })();

  // ---- keys (real keyboard events)
  const keyer = (async () => {
    for (const step of keySteps) {
      for (const k of step.keys) await page.keyboard.down(k);
      await sleep(step.ms);
      for (const k of [...step.keys].reverse()) await page.keyboard.up(k);
    }
  })();

  await keyer;
  const remaining = stepped ? 0 : tStart + seconds * 1000 - Date.now();
  if (remaining > 0) await sleep(remaining);
  await shooter;
  running = false;
  await sampler;
  await sample();

  // ---- summary
  const speeds = trace.map((p) => p.speedKmh);
  let distance = 0;
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1].pos, b = trace[i].pos;
    distance += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  const last = trace[trace.length - 1] ?? {};
  const final = await page.evaluate(() => ({
    race: window.__rally.getRaceState(),
    frame: window.__rally.getFrameStats(),
  }));
  result.summary = {
    samples: trace.length,
    wallSeconds: +((Date.now() - tStart) / 1000).toFixed(2),
    simSeconds: trace.length ? +(last.simTime - trace[0].simTime).toFixed(2) : 0,
    maxSpeedKmh: speeds.length ? Math.max(...speeds) : 0,
    avgSpeedKmh: speeds.length ? +(speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(2) : 0,
    distanceM: +distance.toFixed(1),
    maxAbsBetaDeg: +((Math.max(0, ...trace.map((p) => Math.abs(p.beta))) * 180) / Math.PI).toFixed(1),
    maxAbsLatG: +(Math.max(0, ...trace.map((p) => Math.abs(p.aLat))) / 9.81).toFixed(2),
    airborneSamples: trace.filter((p) => p.airborne).length,
    gearsUsed: [...new Set(trace.map((p) => p.gear))].sort((a, b) => a - b),
    surfacesSeen: [...new Set(trace.flatMap((p) => p.surfaces.split(',')))].filter((s) => s !== '-'),
    finalS: last.s,
    finalProgress: last.progress,
    resets: final.race.resets,
    phase: final.race.phase,
    raceTime: +final.race.time.toFixed(3),
    finishTime: final.race.finishTime,
    splits: final.race.splits,
    fps: +final.frame.fps.toFixed(1),
    physicsSteps: final.frame.physicsSteps,
  };
  // ---- health checks
  const checks = {};
  const check = (name, ok, info) => (checks[name] = { ok: !!ok, ...(info ?? {}) });
  const runningSamples = trace.filter((p) => p.phase === 'running');
  check('noConsoleErrors', g.errors.length === 0, { count: g.errors.length });
  check('noNaN', trace.every((p) => p.finite), { bad: trace.filter((p) => !p.finite).length });
  const faults = Math.max(0, ...trace.map((p) => p.simFaults));
  check('noSimFaults', faults === 0, { simFaults: faults });
  const minClear = Math.min(...trace.map((p) => p.clearance));
  check('noFallThrough', minClear > -0.5, { minClearance: minClear });
  const maxClear = Math.max(...trace.map((p) => p.clearance));
  const maxLat = Math.max(0, ...trace.map((p) => Math.abs(p.roadLateral)));
  check('noFlyOff', maxClear < 12 && maxLat < 40, { maxClearance: maxClear, maxAbsLateral: maxLat });
  // stuck: no forward progress over any 15 s of sim time while running
  let stuckAt = null;
  const dt = trace.length > 1 ? Math.max(0.05, (last.simTime - trace[0].simTime) / (trace.length - 1)) : 0.25;
  const win = Math.max(1, Math.round(15 / dt));
  for (let i = win; i < runningSamples.length; i++) {
    if (runningSamples[i].progress - runningSamples[i - win].progress <= 1e-4 && runningSamples[i].progress < 1) {
      stuckAt = runningSamples[i].simTime;
      break;
    }
  }
  const isPad = result.stage?.discipline === 'testpad';
  check('noStuck', isPad || stuckAt === null, { stuckAtSim: stuckAt });
  if (args.autopilot) check('noAutoResets', final.race.resets === 0, { resets: final.race.resets });
  // rollover: up-vector y below 0 for more than 1 s of sim time
  let inv = 0, maxInv = 0;
  for (let i = 1; i < trace.length; i++) {
    inv = trace[i].upY < 0 ? inv + (trace[i].simTime - trace[i - 1].simTime) : 0;
    maxInv = Math.max(maxInv, inv);
  }
  check('noRollover', maxInv < 1, { maxUpsideDownS: +maxInv.toFixed(2) });
  const moving = runningSamples.filter((p) => p.speedKmh > 25);
  const backwards = moving.filter((p) => p.headingErrDeg > 100).length;
  result.summary.headingErr = {
    movingSamples: moving.length,
    over45deg: moving.filter((p) => p.headingErrDeg > 45).length,
    over100deg: backwards,
    maxAbsBetaMovingDeg: +((Math.max(0, ...moving.map((p) => Math.abs(p.beta))) * 180) / Math.PI).toFixed(1),
  };
  if (args.autopilot) check('facesTravel', moving.length === 0 || backwards / moving.length < 0.02, { backwardsSamples: backwards });
  if (untilFinish && isPad) check('lappedPad', (result.loopDistance ?? 0) >= result.stage.length, { loopDistance: result.loopDistance, length: +result.stage.length.toFixed(1), simSeconds: result.summary.simSeconds });
  else if (untilFinish) check('finished', final.race.phase === 'finished', { phase: final.race.phase, finishTime: final.race.finishTime });
  result.checks = checks;
  result.raceState = final.race;
  if (args.full) result.trace = trace;
  fs.writeFileSync(path.join(outDir, 'trace.json'), JSON.stringify({ args: result.args, stage: result.stage, trace }, null, 1));
  result.traceFile = path.relative(ROOT, path.join(outDir, 'trace.json'));
  result.errors.push(...g.errors);
  result.warnings = g.warnings.slice(0, 20);
  result.ok = g.errors.length === 0 && Object.values(checks).every((c) => c.ok);
} catch (err) {
  result.errors.push(String(err && err.stack ? err.stack : err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
