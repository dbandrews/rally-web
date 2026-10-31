#!/usr/bin/env node
// tools/ai-stages.mjs — the solo AI table: one AI car (the ported original AI, AI friction mode, the original collision
// mesh, no player, no other cars) drives every stage to the finish, stepped at 120 Hz and deterministic. For each
// stage the (event, car) of an AiTimes file of that track is used, once with the AiTimes schedule and once without.
//
//   node tools/ai-stages.mjs [--stages all|id,id] [--jobs 4] [--out artifacts/phase2/ai-brain]
//
// Runs tests/game/ai/soloTable.test.ts in --jobs parallel vitest processes (needs public/assets: npm run assets) and
// writes <out>/ai-stages.json and <out>/ai-stages.md. Exit 1 when a stage does not finish or needs a reset.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const out = path.resolve(ROOT, arg('out', 'artifacts/phase2/ai-brain'));
const jobs = Math.max(1, Number(arg('jobs', '4')));
const idx = fs.readFileSync(path.join(ROOT, 'src/world/ports/index.ts'), 'utf8');
const all = [...idx.match(/PORTED_ORDER[^=]*=\s*Object\.freeze\(\[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const sel = arg('stages', 'all');
const stages = sel === 'all' ? all : sel.split(',');
if (!fs.existsSync(path.join(ROOT, 'public/assets/manifest.json'))) {
  console.error('ai-stages: public/assets is missing (npm run assets)');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-stages-'));
const parts = Array.from({ length: Math.min(jobs, stages.length) }, () => []);
stages.forEach((s, i) => parts[i % parts.length].push(s));
const run = (part, k) =>
  new Promise((resolve) => {
    const table = path.join(tmp, `t${k}.json`);
    const p = spawn('npx', ['vitest', 'run', 'tests/game/ai/soloTable.test.ts', '--reporter=verbose'], {
      cwd: ROOT,
      env: { ...process.env, AI_STAGES: part.join(','), AI_TABLE: table },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.on('data', (d) => process.stdout.write(String(d).split('\n').filter((l) => /^[a-z]+-\d/.test(l)).map((l) => l + '\n').join('')));
    p.stderr.on('data', () => {});
    p.on('close', (code) => resolve({ code, table }));
  });
const results = await Promise.all(parts.map(run));
const rows = [];
for (const r of results) {
  if (fs.existsSync(r.table)) rows.push(...JSON.parse(fs.readFileSync(r.table, 'utf8')));
}
rows.sort((a, b) => all.indexOf(a.stage) - all.indexOf(b.stage));
fs.writeFileSync(path.join(out, 'ai-stages.json'), JSON.stringify(rows, null, 1));
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'DNF');
let md = '# Solo AI car per stage (ported original AI, AI friction, original collision mesh)\n\n';
md += '| stage | car | event | finish (s) with AiTimes | AiTimes total (s) | ratio | finish (s) no schedule | resets | max lateral (m) | mean abs lateral (m) | max km/h |\n|---|---|---|---|---|---|---|---|---|---|---|\n';
let bad = 0;
for (const r of rows) {
  const ratio = r.scheduleTotal ? r.finishTime / r.scheduleTotal : NaN;
  if (!r.finished || r.resets > 0) bad++;
  md += `| ${r.stage} | ${r.car} | ${r.event ?? '-'} | ${f(r.finishTime)} | ${r.scheduleTotal ? f(r.scheduleTotal) : '-'} | ${f(ratio, 3)} | ${r.noSchedule ? f(r.noSchedule.finishTime) : '-'} | ${r.resets} | ${f(r.maxLateral)} | ${f(r.meanAbsLateral, 2)} | ${f(r.maxSpeedKmh, 0)} |\n`;
}
md += `\n${rows.length} stages, ${rows.filter((r) => r.finished).length} finished, ${rows.reduce((a, r) => a + r.resets, 0)} resets in total.\n`;
fs.writeFileSync(path.join(out, 'ai-stages.md'), md);
console.log(md);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad || rows.length !== stages.length ? 1 : 0);
