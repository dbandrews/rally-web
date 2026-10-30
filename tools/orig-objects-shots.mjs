#!/usr/bin/env node
// tools/orig-objects-shots.mjs — OBJECTS BUILDER tool: the start view of ported stages in the REAL game with the
// original-asset view, plus the objects component's per-frame stats (draw calls, triangles, visible instances,
// impostors) next to the whole renderer's numbers. Screenshots go to artifacts/port/objects/<stage>_<cam>.png;
// compare them with the original .cache/original/<archive>/track/<layout>/<dir>/Screenshots/*.tga.
//
//   node tools/orig-objects-shots.mjs --stages corsica-1-f,hillclimb-1b-f --cams chase,bonnet
//   node tools/orig-objects-shots.mjs --stages kenya-2-f --s 0,600 --variants default,s3tc=0
//
// Per (stage, variant): fresh page ?stage=<id>&menu=0&countdown=0 (+ variant params), race started with the
// car parked at the spawn (or teleported to each --s spline distance), then each camera is shot after a short
// settle. One JSON line per shot; exit 1 on any console error / page error / failed request.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, openGame, parseArgs, startServer, waitReady } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const stages = String(args.stages ?? 'corsica-1-f').split(',');
const variants = String(args.variants ?? 'default').split(',');
const cams = String(args.cams ?? 'chase').split(',');
const sList = args.s === undefined ? [null] : String(args.s).split(',').map(Number);
const outDir = path.join(ROOT, String(args.out ?? 'artifacts/port/objects'));
fs.mkdirSync(outDir, { recursive: true });

let server = null;
let browser = null;
const problems = [];
try {
  const base = typeof args.url === 'string' ? args.url : (server = await startServer()).url;
  browser = await launchBrowser({ headed: !!args.headed });
  for (const v of variants) {
    const extra = v === 'default' ? {} : Object.fromEntries(v.split('&').map((kv) => kv.split('=')));
    for (const id of stages) {
      const g = await openGame(browser, base, { stage: id, menu: 0, countdown: 0, quality: args.quality ?? 'high', pr: 1, ...extra }, { width: Number(args.width ?? 1280), height: Number(args.height ?? 720) });
      await waitReady(g.page, 240000);
      await g.page.evaluate(() => {
        const r = window.__rally;
        r.startRace();
        r.pause(true);
        r.step(24);
      });
      for (const s of sList) {
        if (s !== null) await g.page.evaluate((s) => window.__rally.teleport(s, 0), s);
        for (const cam of cams) {
          const info = await g.page.evaluate((cam) => {
            const r = window.__rally;
            r.setCamera(cam);
            for (let i = 0; i < 12; i++) r.step(4);
            const R = window.__rallyRenderer;
            const st = R.stats();
            const objs = R.scene?.getObjectByName('orig:objects');
            const os = objs?.userData?.stats ?? null;
            const d = R.debugInfo();
            return { stage: r.getStageInfo().id, s: Math.round(r.getRaceState().s), orig: d.orig, s3tc: d.s3tc, cam: d.camera, calls: st.drawCalls, tris: st.triangles, objects: os && { ...os } };
          }, cam);
          // let a few real frames render so the shot shows the settled view
          await g.page.waitForTimeout(400);
          const tag = s === null ? '' : `_s${s}`;
          const file = path.join(outDir, `${id}${v === 'default' ? '' : '_' + v.replace(/[^a-z0-9]+/gi, '-')}${tag}_${cam}.png`);
          await g.page.screenshot({ path: file, timeout: 180000 });
          console.log(JSON.stringify({ variant: v, cam, ...info, errors: g.errors.length, warnings: g.warnings.length, shot: path.relative(ROOT, file) }));
        }
      }
      for (const e of g.errors) problems.push(`${id} [${v}] ${e}`);
      for (const w of g.warnings) console.log(`warning ${id} [${v}]: ${w}`);
      await g.context.close();
    }
  }
} catch (e) {
  problems.push(String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
for (const p of problems) console.error(p);
process.exit(problems.length ? 1 : 0);
