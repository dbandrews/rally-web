#!/usr/bin/env node
// tools/assets/check-game.mjs — load ported stages in the REAL game with URL variants and report console
// errors / warnings, whether the original view was used, and a screenshot per (stage, variant).
//
//   node tools/assets/check-game.mjs --stages corsica-1-f,kenya-1-r --variants default,orig=0,s3tc=0
//   node tools/assets/check-game.mjs --stages corsica-1-f --cams chase,bonnet --seconds 4
//
// Each variant is a fresh page (the URL params are read at start-up): ?stage=<id>&menu=0&countdown=0 plus
// the variant's params ("default" = none). The car drives on autopilot for --seconds of sim time (stepped),
// then each camera is shot to artifacts/assets-check/<stage>_<variant>_<cam>.png. Prints one JSON line per
// shot (renderer debugInfo().orig = loaded original parts, s3tc = compressed path in use). Exit 1 on any
// console error / page error / failed request, or on a warning with --strict.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, openGame, parseArgs, startServer, waitReady } from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const stages = String(args.stages ?? 'corsica-1-f').split(',');
const variants = String(args.variants ?? 'default,orig=0,s3tc=0').split(',');
const cams = String(args.cams ?? 'chase').split(',');
const seconds = Number(args.seconds ?? 3);
const outDir = path.join(ROOT, String(args.out ?? 'artifacts/assets-check'));
fs.mkdirSync(outDir, { recursive: true });

let server = null, browser = null;
const problems = [];
try {
  const base = typeof args.url === 'string' ? args.url : (server = await startServer()).url;
  browser = await launchBrowser({ headed: !!args.headed });
  for (const v of variants) {
    const extra = v === 'default' ? {} : Object.fromEntries(v.split('&').map((kv) => kv.split('=')));
    for (const id of stages) {
      const g = await openGame(browser, base, { stage: id, menu: 0, countdown: 0, quality: args.quality ?? 'low', ...extra });
      await waitReady(g.page, 180000);
      await g.page.evaluate((frames) => {
        const r = window.__rally;
        r.startRace();
        r.setAutopilot(true);
        r.pause(true);
        for (let i = 0; i < frames; i++) r.step(12);
      }, Math.round((seconds * 120) / 12));
      for (const cam of cams) {
        const info = await g.page.evaluate((cam) => {
          const r = window.__rally;
          r.setCamera(cam);
          for (let i = 0; i < 12; i++) r.step(4);
          const d = window.__rallyRenderer.debugInfo();
          return { stage: r.getStageInfo().id, s: Math.round(r.getRaceState().s), kmh: Math.round(r.getTelemetry().speedKmh), orig: d.orig, s3tc: d.s3tc, calls: window.__rallyRenderer.stats().drawCalls };
        }, cam);
        const file = path.join(outDir, `${id}_${v.replace(/[^a-z0-9]+/gi, '-')}_${cam}.png`);
        await g.page.screenshot({ path: file, timeout: 180000 });
        console.log(JSON.stringify({ variant: v, cam, ...info, errors: g.errors.length, warnings: g.warnings.length, shot: path.relative(ROOT, file) }));
      }
      for (const e of g.errors) problems.push(`[${id} ${v}] ${e}`);
      for (const w of g.warnings) (args.strict ? problems : []).push(`[${id} ${v}] warning: ${w}`), console.log(`  warning [${id} ${v}]: ${w}`);
      await g.page.context().close();
    }
  }
} catch (e) {
  problems.push(String(e?.stack ?? e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
for (const p of problems.slice(0, 20)) console.log('PROBLEM', p);
process.exit(problems.length ? 1 : 0);
