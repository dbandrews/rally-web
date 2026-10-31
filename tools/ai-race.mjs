#!/usr/bin/env node
// tools/ai-race.mjs — AI-RACE BUILDER (phase 2, docs/PHASE2_AI.md). Stepped, deterministic multi-car race driver.
//
// For each stage: loads it with N AI opponents through the test API (window.__rally.loadStage(id, { opponents })), runs
// the real 3 s countdown, drives the player with the autopilot, steps the sim in chunks while the loop is paused
// (independent of the headless frame rate) until the player and every AI car have finished (or --max-sim), and checks
//   * the field: roster size, grid slots on the road, parked until GO, getField() consistent with the HUD ("n / N"),
//     standings = finish order, every AI car finished, no automatic resets (reported), the driver kind
//     (placeholder true = the architect's Autopilot stand-in, false = the ported original controller; --real asserts false),
//   * 0 console errors and warnings,
//   * restart / stage change / main-menu round trips leave no AI sim, renderer car or field state behind,
//   * perf: ms of wall time per simulated second, solo vs the field, on the same stage (a short fixed-length run each).
// Screenshots (grid at the countdown, mid-race, results with the standings, the HUD, the menu row) go to --out.
//
// usage: node tools/ai-race.mjs [--stages corsica-1-f,hillclimb-1a-f,iceracing-1-f,rallycross-1-f] [--opponents 3]
//          [--car ImprezaWRX] [--seed 1] [--max-sim 900] [--chunk 60] [--out artifacts/phase2/ai-race] [--real]
//          [--no-perf] [--no-menu] [--no-contact] [--no-determinism] [--skip-race] [--quality low]
// exit code 0 = all checks passed.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, openGame, parseArgs, startServer, waitReady } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const stages = String(args.stages ?? 'corsica-1-f,hillclimb-1a-f,iceracing-1-f,rallycross-1-f').split(',').filter(Boolean);
const opponents = Number(args.opponents ?? 3);
const car = args.car === undefined ? 'ImprezaWRX' : String(args.car);
const seed = Number(args.seed ?? 1);
const maxSim = Number(args['max-sim'] ?? 900);
const chunk = Math.max(1, Math.floor(Number(args.chunk ?? 60)));
const outDir = path.resolve(ROOT, String(args.out ?? 'artifacts/phase2/ai-race'));
const requireReal = !!args.real;
const quality = String(args.quality ?? 'low');
fs.mkdirSync(outDir, { recursive: true });

const report = { stages: {}, perf: {}, checks: [], failures: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) });
  if (!ok) report.failures.push(`${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`);
};
const rel = (f) => path.relative(ROOT, f);

const server = await startServer();
const browser = await launchBrowser();
const query = (extra = {}) => ({ menu: 0, countdown: 1, quality, pr: 1, ...extra });

async function shot(page, name) {
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, timeout: 240000 });
  return rel(file);
}

/** Step the sim by `n` substeps and render one frame (the loop is paused). */
const step = (page, n) => page.evaluate((k) => { window.__rally.step(k); }, n);

const hudText = (page) =>
  page.evaluate(() => {
    const p = document.querySelector('.rw-ai-pos b');
    const rows = [...document.querySelectorAll('.rw-ai-row')].map((r) => ({
      pos: Number(r.querySelector('.rw-n')?.textContent ?? 0),
      you: r.classList.contains('rw-you'),
      name: r.querySelector('.rw-nm')?.textContent ?? '',
    }));
    const dots = document.querySelectorAll('.rw-ai-dot').length;
    return { pos: p ? p.textContent : null, rows, dots, shown: !!p && getComputedStyle(document.querySelector('.rw-ai')).display !== 'none' };
  });

async function raceStage(id) {
  const rec = { id, opponents, car };
  const { page, errors, warnings } = await openGame(browser, server.url, query({ stage: id, car, ai: opponents, seed }));
  await waitReady(page);
  await page.evaluate(() => window.__rally.pause(true));
  await page.evaluate(async ([sid, o, c, s]) => { await window.__rally.loadStage(sid, { origCar: c, opponents: o, countdown: true, seed: s }); window.__rally.pause(true); }, [id, opponents, car, seed]);
  await step(page, 2);

  // ---- grid at the countdown
  let f = await page.evaluate(() => window.__rally.getField());
  rec.roster = f.cars.map((c) => ({ id: c.id, car: c.origCar, grid: c.gridIndex, s: +c.s.toFixed(1), lateral: +c.lateral.toFixed(2), parked: c.parked }));
  check(`${id}: ${opponents} AI cars on the grid`, f.opponents === opponents && f.cars.length === opponents, f.opponents);
  const info = await page.evaluate(() => window.__rally.getStageInfo());
  rec.placeholder = f.cars.length ? f.cars[0].ai?.placeholder === true : null;
  if (requireReal) check(`${id}: the real AI driver (placeholder false)`, f.cars.every((c) => c.ai?.placeholder !== true), f.cars.map((c) => c.ai?.placeholder));
  check(`${id}: all AI cars parked on the grid`, f.cars.every((c) => c.parked));
  check(`${id}: grid columns ±lateral`, f.cars.every((c) => Math.abs(c.lateral) > 0.5 && Math.abs(c.lateral) < info.length), rec.roster.map((r) => r.lateral));
  await step(page, 60);
  rec.gridShot = await shot(page, `${id}-grid-countdown.png`);
  const raceNow = await page.evaluate(() => window.__rally.getRaceState());
  check(`${id}: countdown running while the AI cars wait`, raceNow.phase === 'countdown', raceNow.phase);
  const before = await page.evaluate(() => window.__rally.getField().cars.map((c) => [c.s, c.lateral]));
  await step(page, 60);
  const after = await page.evaluate(() => window.__rally.getField().cars.map((c) => [c.s, c.lateral]));
  check(`${id}: no AI car moves before GO`, before.every((b, i) => Math.abs(b[0] - after[i][0]) < 0.05 && Math.abs(b[1] - after[i][1]) < 0.05));

  // ---- run
  await page.evaluate(() => window.__rally.setAutopilot(true));
  const t0 = Date.now();
  let simT = 0;
  let midShot = false;
  let resultsShot = false;
  let hudChecks = 0;
  let hudMismatch = 0;
  const events = [];
  const leadLog = [];
  while (simT < maxSim) {
    await step(page, chunk);
    const st = await page.evaluate(() => {
      const r = window.__rally;
      return { race: r.getRaceState(), field: r.getField(), ev: r.getRaceEvents() };
    });
    simT += chunk / 120;
    for (const e of st.ev) if (e.type === 'finish' || e.type === 'reset') events.push({ ...e, simT: +simT.toFixed(1) });
    f = st.field;
    if (!midShot && st.race.phase === 'running' && st.race.progress > 0.35) {
      midShot = true;
      await step(page, 1);
      rec.midShot = await shot(page, `${id}-mid-race.png`);
      const h = await hudText(page);
      rec.hudMid = h;
      check(`${id}: HUD shows the field`, h.shown && h.rows.length === opponents + 1 && h.dots === opponents, h);
    }
    // HUD vs getField every few chunks
    if (st.race.phase === 'running' && Math.round(simT) % 5 === 0) {
      const h = await hudText(page);
      const want = `${f.playerPosition}/${f.fieldSize}`;
      hudChecks++;
      if (!h.pos || h.pos.replace(/\s/g, '') !== want) hudMismatch++;
    }
    leadLog.push(f.standings.map((e) => e.id).join('>'));
    const allIn = f.cars.every((c) => c.finished);
    if (st.race.phase === 'finished' && !resultsShot) {
      // the results card opens 1.6 s of wall time after the finish (the AI cars may still be racing: the table is live)
      resultsShot = true;
      await new Promise((r) => setTimeout(r, 1800));
      await step(page, 1);
      rec.resultsShot = await shot(page, `${id}-results.png`);
      const table = await page.evaluate(() => document.querySelector('.rw-ai-table')?.textContent ?? null);
      check(`${id}: results screen lists the standings`, !!table && /You/.test(table), table);
      rec.resultsLive = table;
    }
    if (st.race.phase === 'finished' && allIn) break;
  }
  if (rec.resultsLive && /racing/.test(rec.resultsLive)) {
    // the results card opened while AI cars were still on the road: its table followed them to the line
    await step(page, 1);
    const table = await page.evaluate(() => document.querySelector('.rw-ai-table')?.textContent ?? '');
    rec.resultsFinal = table;
    check(`${id}: the open results table updated to the final standings`, !/racing/.test(table) && /\d:\d\d\.\d{3}/.test(table), table);
  }
  rec.wallSeconds = +((Date.now() - t0) / 1000).toFixed(1);
  rec.simSeconds = +simT.toFixed(1);
  f = await page.evaluate(() => window.__rally.getField());
  const race = await page.evaluate(() => window.__rally.getRaceState());
  rec.finalStandings = f.standings.map((e) => ({ pos: e.position, id: e.id, name: e.name, finished: e.finished, time: e.finishTime, gap: e.gapToLeader, lap: e.lap }));
  rec.cars = f.cars.map((c) => ({ id: c.id, car: c.origCar, finished: c.finished, time: c.finishTime, resets: c.resets, lap: c.lap, ai: c.ai }));
  rec.events = events;
  rec.leaderChanges = new Set(leadLog).size;
  check(`${id}: player finished`, race.phase === 'finished' && race.finishTime > 0, race.phase);
  check(`${id}: every AI car finished`, f.cars.every((c) => c.finished), f.cars.map((c) => [c.id, c.finished, +c.s.toFixed(0), c.resets]));
  const fin = f.standings.filter((e) => e.finished);
  check(`${id}: standings are in finish order`, fin.every((e, i) => i === 0 || fin[i - 1].finishTime <= e.finishTime), fin.map((e) => [e.id, e.finishTime]));
  check(`${id}: positions 1..N, one player`, f.standings.map((e) => e.position).join() === f.standings.map((_, i) => i + 1).join() && f.standings.filter((e) => e.player).length === 1);
  check(`${id}: playerPosition matches standings`, f.standings[f.playerPosition - 1]?.player === true);
  const pFin = f.standings.find((e) => e.player);
  check(`${id}: player time = race time`, pFin && Math.abs((pFin.finishTime ?? -1) - race.finishTime) < 1e-6, [pFin?.finishTime, race.finishTime]);
  check(`${id}: HUD position == getField (${hudChecks} samples)`, hudMismatch === 0, hudMismatch);
  const hud = await hudText(page);
  rec.hudEnd = hud;
  check(`${id}: HUD strip lists everyone`, hud.rows.length === opponents + 1);
  rec.aiResets = f.cars.reduce((n, c) => n + c.resets, 0);
  check(`${id}: no console errors or warnings`, errors.length === 0 && warnings.length === 0, { errors, warnings });
  report.stages[id] = rec;

  // ---- restart / stage change / back-to-menu leave nothing behind
  const cars = () =>
    page.evaluate(() => ({
      field: window.__rally.getField().opponents,
      sims: window.__rally.getField().cars.length,
      renderer: window.__rallyRenderer.debugInfo().origCars.map((c) => c.id).sort(),
    }));
  await page.evaluate(([sid, o, c, s]) => window.__rally.loadStage(sid, { origCar: c, opponents: o, countdown: true, seed: s }), [id, opponents, car, seed]);
  let c1 = await cars();
  check(`${id}: reload keeps exactly the roster`, c1.field === opponents && c1.renderer.join() === ['ai' + 1, 'ai' + 2, 'ai' + 3, 'player'].slice(0, opponents).concat(['player']).sort().join(), c1);
  await page.evaluate(([sid, c, s]) => window.__rally.loadStage(sid, { origCar: c, opponents: 0, countdown: true, seed: s }), [id, car, seed]);
  c1 = await cars();
  check(`${id}: opponents 0 drops every AI sim and renderer car`, c1.field === 0 && c1.sims === 0 && c1.renderer.join() === 'player', c1);
  const other = stages.find((s) => s !== id) ?? (id === 'kenya-1-f' ? 'corsica-1-f' : 'kenya-1-f');
  await page.evaluate(([sid, o, c, s]) => window.__rally.loadStage(sid, { origCar: c, opponents: o, countdown: true, seed: s }), [other, opponents, car, seed]);
  c1 = await cars();
  check(`${id}: stage change -> ${other} rebuilds the roster once`, c1.field === opponents && c1.renderer.length === opponents + 1, c1);
  await page.context().close();
}

/** Car-car contact (sim-contact): a stationary player in front of a charging AI car is hit, and nobody passes through. */
async function contact(id) {
  const { page, errors, warnings } = await openGame(browser, server.url, query({ stage: id, car, ai: opponents, seed }));
  await waitReady(page);
  await page.evaluate(() => window.__rally.pause(true));
  await page.evaluate(([sid, o, c, s]) => window.__rally.loadStage(sid, { origCar: c, opponents: o, countdown: false, seed: s }), [id, opponents, car, s0(seed)]);
  await page.evaluate(() => window.__rally.startRace());
  await step(page, 240); // the AI cars get going
  const f = await page.evaluate(() => window.__rally.getField());
  const ai = f.cars[0];
  await page.evaluate(([s, l]) => { window.__rally.teleport(s + 22, l); window.__rally.setControls({ brake: 1, handbrake: 1 }); }, [ai.s, ai.lateral]);
  let minDist = 1e9;
  let hits0 = (await page.evaluate(() => window.__rally.getTelemetry())).collision.carHits ?? 0;
  for (let i = 0; i < 40; i++) {
    await step(page, 15);
    const r = await page.evaluate(() => ({ t: window.__rally.getTelemetry(), f: window.__rally.getField() }));
    for (const c of r.f.cars) minDist = Math.min(minDist, Math.hypot(c.pos.x - r.t.pos.x, c.pos.z - r.t.pos.z));
  }
  const hits1 = (await page.evaluate(() => window.__rally.getTelemetry())).collision.carHits ?? 0;
  report.contact = { stage: id, carHits0: hits0, carHits1: hits1, minCentreDistanceM: +minDist.toFixed(2) };
  check(`${id}: an AI car hits the stationary player (carHits)`, hits1 > hits0, report.contact);
  check(`${id}: cars never pass through each other (centre distance >= 1.2 m)`, minDist >= 1.2, minDist);
  check(`${id}: contact run has no console errors or warnings`, errors.length === 0 && warnings.length === 0, { errors, warnings });
  await page.context().close();
}
const s0 = (x) => x;

/** Two fresh pages, the same stepped 25 s: every AI car must be in the same place with the same speed (bit for bit). */
async function determinism(id) {
  const run = async () => {
    const { page, errors, warnings } = await openGame(browser, server.url, query({ stage: id, car, ai: opponents, seed }));
    await waitReady(page);
    await page.evaluate(() => window.__rally.pause(true));
    await page.evaluate(async ([sid, o, c, s]) => { await window.__rally.loadStage(sid, { origCar: c, opponents: o, countdown: true, seed: s }); window.__rally.pause(true); }, [id, opponents, car, seed]);
    const samples = [];
    for (let i = 0; i < 25; i++) {
      await step(page, 120);
      samples.push(await page.evaluate(() => window.__rally.getField().cars.map((c) => [c.pos.x, c.pos.y, c.pos.z, c.speedKmh, c.s, c.lateral, c.steer, c.throttle, c.brake])));
    }
    await page.context().close();
    return { samples, errors, warnings };
  };
  const a = await run();
  const b = await run();
  let firstDiff = null;
  for (let i = 0; i < a.samples.length && firstDiff === null; i++) if (JSON.stringify(a.samples[i]) !== JSON.stringify(b.samples[i])) firstDiff = i + 1;
  report.determinism = { stage: id, seconds: 25, firstDifferentSecond: firstDiff };
  check(`${id}: two stepped runs give identical AI cars (25 s)`, firstDiff === null, firstDiff === null ? undefined : { second: firstDiff, a: a.samples[firstDiff - 1], b: b.samples[firstDiff - 1] });
  check(`${id}: determinism runs have no console errors or warnings`, a.errors.length + b.errors.length + a.warnings.length + b.warnings.length === 0);
}

async function menuShots() {
  const { page, errors, warnings } = await openGame(browser, server.url, { menu: 1, quality, pr: 1, stage: stages[0], car });
  await waitReady(page);
  await new Promise((r) => setTimeout(r, 500));
  const row = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.rw-opt')];
    const i = rows.findIndex((r) => /Opponents/i.test(r.querySelector('.rw-k')?.textContent ?? ''));
    return { i, n: rows.length, val: i >= 0 ? rows[i].querySelector('.rw-val')?.textContent : null };
  });
  check('menu: an Opponents row exists with the default 3', row.i >= 0 && /3/.test(row.val ?? ''), row);
  if (row.i >= 0) {
    await page.evaluate((i) => document.querySelectorAll('.rw-opt')[i].dispatchEvent(new MouseEvent('click', { bubbles: true })), row.i);
    await new Promise((r) => setTimeout(r, 150));
    report.menuShot = await shot(page, 'menu-opponents-row.png');
    const info = await page.evaluate(() => document.querySelector('.rw-info')?.textContent ?? '');
    report.menuInfo = info;
    check('menu: the info line names the opponents', /3 AI cars/.test(info), info);
    // keyboard: arrows change the focused row
    await page.keyboard.press('ArrowLeft');
    await new Promise((r) => setTimeout(r, 80));
    const v2 = await page.evaluate((i) => document.querySelectorAll('.rw-opt')[i].querySelector('.rw-val')?.textContent, row.i);
    check('menu: ← lowers the opponent count (keyboard)', /2/.test(v2 ?? ''), v2);
    await page.keyboard.press('ArrowRight');
  }
  check('menu: no console errors or warnings', errors.length === 0 && warnings.length === 0, { errors, warnings });
  await page.context().close();
}

async function perf(id) {
  // The same fixed 20 s of sim (autopilot) solo vs the field. "sim" = step(2400) in ONE call (a single frame is rendered at
  // its end), so it is the pure physics + field cost; "frame" = one more step(1) = one rendered frame of the whole scene
  // (headless SwiftShader software GL: slow, only the solo / field difference means anything). Every configuration runs
  // 3 times, interleaved, and the fastest counts (the first page of a process pays the shader / JIT warm-up).
  const run = async (n) => {
    const { page } = await openGame(browser, server.url, query({ stage: id, car, ai: n, seed }));
    await waitReady(page);
    await page.evaluate(() => window.__rally.pause(true));
    await page.evaluate(([sid, o, c, s]) => window.__rally.loadStage(sid, { origCar: c, opponents: o, countdown: false, seed: s }), [id, n, car, seed]);
    await page.evaluate(() => { window.__rally.setAutopilot(true); window.__rally.startRace(); });
    await step(page, 240);
    const t0 = Date.now();
    await step(page, 2400);
    const sim = Date.now() - t0;
    const t1 = Date.now();
    await step(page, 1);
    const frame = Date.now() - t1;
    await page.context().close();
    return { sim, frame };
  };
  const best = { solo: { sim: Infinity, frame: Infinity }, field: { sim: Infinity, frame: Infinity } };
  for (let k = 0; k < 3; k++) {
    for (const [name, n] of [['solo', 0], ['field', opponents]]) {
      const r = await run(n);
      best[name].sim = Math.min(best[name].sim, r.sim);
      best[name].frame = Math.min(best[name].frame, r.frame);
    }
  }
  report.perf[id] = {
    cars: opponents + 1,
    solo: { msPerSimSecond: +(best.solo.sim / 20).toFixed(1), msPerRenderedFrame: best.solo.frame },
    field: { msPerSimSecond: +(best.field.sim / 20).toFixed(1), msPerRenderedFrame: best.field.frame },
    simRatio: +(best.field.sim / best.solo.sim).toFixed(2),
    note: 'headless SwiftShader (software GL), quality low; simulated seconds at 120 Hz, autopilot, 20 s after GO',
  };
}

try {
  if (!args['skip-race']) for (const id of stages) await raceStage(id);
  if (!args['no-determinism']) await determinism(stages[0]);
  if (!args['no-contact']) await contact(stages[0]);
  if (!args['no-menu']) await menuShots();
  if (!args['no-perf']) await perf(stages[0]);
} catch (e) {
  check('tool run', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.close();
}

report.ok = report.failures.length === 0;
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ok: report.ok, failures: report.failures, perf: report.perf, stages: Object.fromEntries(Object.entries(report.stages).map(([k, v]) => [k, { wall: v.wallSeconds, sim: v.simSeconds, placeholder: v.placeholder, standings: v.finalStandings, aiResets: v.aiResets }])) }, null, 1));
process.exit(report.ok ? 0 : 1);
