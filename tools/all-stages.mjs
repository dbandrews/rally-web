#!/usr/bin/env node
// tools/all-stages.mjs — drive EVERY stage to the finish with the autopilot (npm run stages). Race builder.
//
// Starts one Vite server and runs `tools/drive.mjs --autopilot --until-finish` per stage (stepped mode:
// deterministic and independent of the headless frame rate), a few at a time. Each run checks: finished
// (test pad: one full loop of its road), no console errors, finite telemetry, no sim faults, never below the
// ground, never flying off, never stuck, no automatic resets, no rollover, facing the travel direction.
// Screenshots + trace + result.json per stage in artifacts/finish/<car>/<stage>/. Prints a table (with the object
// hits and the reset reasons) and a JSON summary (artifacts/finish/<car>/summary.json); exit 1 if any stage fails.
// The car is the game's default (the original's ORIG_DEFAULT_CAR, Micra, with its Car_Micra.col hull, when the cars
// are built; else the awd_wrc archetype) unless --car names one; without --car, <car> is `default`.
//
// Default stage set: the 48 PORTED original stages (src/world/ports/index.ts PORTED_ORDER); `--stages
// procedural` = the 7 procedural ones, `--stages all` = both, or a comma list of ids.
// The sim-time cap per stage (--max-sim, default: per stage) is the stage's own race distance — start line
// to finish, or laps × lap length — at 8 m/s plus 60 s, never below 600 s (iceracing-1-r: 5 × 1923 m took
// 620 s of sim with awd_wrc, so the old fixed 600 s failed it).
//
// Options: --stages a,b|ported|procedural|all  --car <archetype|original car>  --seed <n>  --jobs <n> (default 2;
//          SwiftShader is CPU-heavy)  --aggression <x>  --max-sim <s> (overrides the per-stage cap)
//          --shots 0 (no screenshots)  --shot-every <s> (sim seconds between screenshots, default 10)
//          --out <dir> (default artifacts/finish/<car>)  --list (print the set)
//          --drive <script> (default tools/drive.mjs)  --query k=v (repeatable; forwarded to the drive script
//          as --query k=v, extra URL parameters such as orig=0, for drive scripts that support it)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const PROCEDURAL = ['pine-ridge', 'col-du-vent', 'frostvale', 'red-basin', 'kettle-park', 'lake-skoga', 'testpad'];
const PORTS = path.join(ROOT, 'src', 'world', 'ports');

/** The ported stage ids in catalogue order (the generated index's PORTED_ORDER). */
function portedOrder() {
  const idx = fs.readFileSync(path.join(PORTS, 'index.ts'), 'utf8');
  const m = /PORTED_ORDER[^=]*=\s*Object\.freeze\(\[([^\]]*)\]/.exec(idx);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}

/** Race distance of a stage (m): ported = finish - spawn, or laps × lap length; procedural = null. */
function raceDistance(id) {
  const f = path.join(PORTS, `${id}.ts`);
  if (!fs.existsSync(f)) return null;
  const src = fs.readFileSync(f, 'utf8');
  const num = (name) => Number(new RegExp(`export const ${name}[^=]*= ([-\\d.]+)`).exec(src)?.[1]);
  const closed = /export const CLOSED = true/.test(src);
  const trig = (/export const TRIGGERS[^=]*= \[([^\]]*)\]/.exec(src)?.[1] ?? '').split(',').map(Number).filter(Number.isFinite);
  if (closed) return num('LAPS') * num('SPLINE_LENGTH');
  return trig.length ? trig[trig.length - 1] - Math.min(num('SPAWN_S'), trig[0]) : null;
}

const maxSimFor = (id) => {
  if (args['max-sim'] !== undefined && args['max-sim'] !== true) return Number(args['max-sim']);
  const d = raceDistance(id);
  return d === null ? 600 : Math.max(600, Math.ceil(d / 8 + 60));
};

const sel = typeof args.stages === 'string' ? args.stages : 'ported';
const stages =
  sel === 'ported' ? portedOrder() : sel === 'procedural' ? PROCEDURAL : sel === 'all' ? [...PROCEDURAL, ...portedOrder()] : sel.split(',');
const jobs = Math.max(1, Number(args.jobs ?? 2));
// no --car: drive.mjs passes none, so the game picks its default car (the original default car when built)
const car = typeof args.car === 'string' ? args.car : null;
const outRel = typeof args.out === 'string' ? args.out : path.join('artifacts', 'finish', car ?? 'default');
const outRoot = path.resolve(ROOT, outRel);
const driveScript = typeof args.drive === 'string' ? args.drive : 'tools/drive.mjs';
// a screenshot every 10 s of sim (drive.mjs default 30 s): stepNow renders every 0.25 s chunk and headless SwiftShader
// queues that GPU work; on the heavier procedural stages 30 s of backlog (≈ 120 frames) made the first screenshot
// exceed Playwright's 30 s timeout. Shorter intervals drain the same total work in smaller pieces.
const shotEvery = args['shot-every'] !== undefined && args['shot-every'] !== true ? Number(args['shot-every']) : 10;
const queries = args.query === undefined ? [] : (Array.isArray(args.query) ? args.query : [args.query]).filter((q) => q !== true);
if (args.list) {
  // --list: the stage set and its sim caps, no runs
  for (const s of stages) console.log(`${s.padEnd(16)} race ${String(Math.round(raceDistance(s) ?? 0)).padStart(5)} m  cap ${maxSimFor(s)} s`);
  process.exit(0);
}
fs.mkdirSync(outRoot, { recursive: true });

function runOne(url, stage) {
  return new Promise((resolve) => {
    const out = path.join(outRel, stage);
    const a = [driveScript, '--url', url, '--stage', stage, ...(car ? ['--car', car] : []), '--autopilot', '--until-finish', '--out', out, '--max-sim', String(maxSimFor(stage))];
    for (const k of ['seed', 'aggression', 'shots']) if (args[k] !== undefined && args[k] !== true) a.push(`--${k}`, String(args[k]));
    if (String(args.shots) !== '0') a.push('--shot-every', String(shotEvery));
    for (const q of queries) a.push('--query', String(q));
    const child = spawn(process.execPath, a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      let r = null;
      try {
        r = JSON.parse(stdout);
      } catch {
        r = { ok: false, errors: [`unparseable drive.mjs output (exit ${code}): ${stdout.slice(0, 400)} ${stderr.slice(0, 400)}`] };
      }
      resolve({ stage, code, r });
    });
  });
}

const server = await startServer();
const results = [];
try {
  const queue = [...stages];
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      while (queue.length) {
        const s = queue.shift();
        const t0 = Date.now();
        const res = await runOne(server.url, s);
        res.wall = (Date.now() - t0) / 1000;
        results.push(res);
        const fails = Object.entries(res.r.checks ?? {}).filter(([, c]) => !c.ok).map(([k]) => k);
        console.error(`${res.r.ok ? 'PASS' : 'FAIL'} ${s} (${res.wall.toFixed(0)} s wall, cap ${maxSimFor(s)} s sim)${fails.length ? ' failed: ' + fails.join(', ') : ''}`);
      }
    }),
  );
} finally {
  await server.close();
}

results.sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage));
const fmt = (t) => (t == null ? '—' : `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`);
const rows = results.map(({ stage, r }) => ({
  stage,
  ok: !!r.ok,
  finish: r.stage?.discipline === 'testpad' ? `loop ${r.loopDistance ?? 0} m` : fmt(r.summary?.finishTime),
  maxSim: maxSimFor(stage),
  resets: r.summary?.resets ?? null,
  resetReasons: (r.summary?.resetReasons ?? []).map((x) => x.reason),
  objectHits: r.summary?.objectHits ?? null,
  avgKmh: r.summary?.avgSpeedKmh ?? null,
  maxKmh: r.summary?.maxSpeedKmh ?? null,
  minClearance: r.checks?.noFallThrough?.minClearance ?? null,
  maxClearance: r.checks?.noFlyOff?.maxClearance ?? null,
  maxLateral: r.checks?.noFlyOff?.maxAbsLateral ?? null,
  surfaces: (r.summary?.surfacesSeen ?? []).join(' '),
  failed: Object.entries(r.checks ?? {}).filter(([, c]) => !c.ok).map(([k]) => k),
  errors: (r.errors ?? []).slice(0, 3),
  screenshots: r.screenshots ?? [],
}));
const table = [
  'stage            ok    finish          resets  obj hits  avg km/h  max km/h  clear min/max  |lat| max  failed / resets / surfaces',
  ...rows.map(
    (x) =>
      `${x.stage.padEnd(16)} ${(x.ok ? 'PASS' : 'FAIL').padEnd(5)} ${String(x.finish).padEnd(15)} ${String(x.resets).padEnd(7)} ${String(x.objectHits).padEnd(9)} ${String(x.avgKmh).padEnd(9)} ${String(x.maxKmh).padEnd(9)} ${`${x.minClearance}/${x.maxClearance}`.padEnd(14)} ${String(x.maxLateral).padEnd(10)} ${x.failed.length ? x.failed.join(',') + ' / ' : ''}${x.resetReasons.length ? x.resetReasons.join(',') + ' / ' : ''}${x.surfaces}`,
  ),
].join('\n');
const summary = { ok: rows.every((x) => x.ok), car: car ?? 'default', rows };
fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(table);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
