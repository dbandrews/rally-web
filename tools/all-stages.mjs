#!/usr/bin/env node
// tools/all-stages.mjs — drive EVERY stage to the finish with the autopilot (npm run stages).
//
// Starts one Vite server and runs `tools/drive.mjs --autopilot --until-finish` per stage (stepped mode:
// deterministic and independent of the headless frame rate), a few at a time. Each run checks: finished
// (test pad: one full loop of its road), no console errors, finite telemetry, no sim faults, never below the
// ground, never flying off, never stuck, no automatic resets, no rollover, facing the travel direction.
// Screenshots + trace per stage in artifacts/finish/<car>/<stage>/. Prints a table and a JSON summary
// (artifacts/finish/<car>/summary.json); exit 1 if any stage fails.
//
// Options: --stages a,b  --car <archetype>  --seed <n>  --jobs <n> (default 2; SwiftShader is CPU-heavy)
//          --aggression <x>  --max-sim <s> (default 600)  --shots 0 (no screenshots)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const ALL = ['pine-ridge', 'col-du-vent', 'frostvale', 'red-basin', 'kettle-park', 'lake-skoga', 'testpad'];
const stages = typeof args.stages === 'string' ? args.stages.split(',') : ALL;
const jobs = Math.max(1, Number(args.jobs ?? 2));
const car = typeof args.car === 'string' ? args.car : 'awd_wrc';
const outRoot = path.join(ROOT, 'artifacts', 'finish', car);
fs.mkdirSync(outRoot, { recursive: true });

function runOne(url, stage) {
  return new Promise((resolve) => {
    const out = path.join('artifacts', 'finish', car, stage);
    const a = ['tools/drive.mjs', '--url', url, '--stage', stage, '--car', car, '--autopilot', '--until-finish', '--out', out, '--max-sim', String(args['max-sim'] ?? 600)];
    for (const k of ['seed', 'aggression', 'shots']) if (args[k] !== undefined && args[k] !== true) a.push(`--${k}`, String(args[k]));
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
        console.error(`${res.r.ok ? 'PASS' : 'FAIL'} ${s} (${res.wall.toFixed(0)} s wall)${fails.length ? ' failed: ' + fails.join(', ') : ''}`);
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
  resets: r.summary?.resets ?? null,
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
  'stage        ok    finish          resets  avg km/h  max km/h  clear min/max  |lat| max  surfaces',
  ...rows.map(
    (x) =>
      `${x.stage.padEnd(12)} ${(x.ok ? 'PASS' : 'FAIL').padEnd(5)} ${String(x.finish).padEnd(15)} ${String(x.resets).padEnd(7)} ${String(x.avgKmh).padEnd(9)} ${String(x.maxKmh).padEnd(9)} ${`${x.minClearance}/${x.maxClearance}`.padEnd(14)} ${String(x.maxLateral).padEnd(10)} ${x.surfaces}`,
  ),
].join('\n');
const summary = { ok: rows.every((x) => x.ok), car, rows };
fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(table);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
