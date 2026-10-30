#!/usr/bin/env node
// tools/env-shots.mjs — ENVIRONMENT BUILDER tool: framebuffer shots of the original environment (sky box, clouds,
// fog, lights, sun flare, weather) on ported stages, for comparison with the original Screenshots/*.tga.
//
//   node tools/env-shots.mjs --stages corsica-1-f,kenya-1-f [--gamma 0] [--width 800 --height 600] [--cam bonnet]
//
// Per stage: one fresh page (?stage=<id>&menu=0&countdown=0&quality=low&pr=1, plus gamma / extra --q params),
// autopilot for a moment at the start, then shots `start`, `mid` (teleported to half the stage) and `sun`
// (debug camera from the car toward the original sun). Shots are the WebGL canvas itself (toDataURL right after
// the stepped frame: no HUD), like the original's framebuffer grabs. With the default --gamma 0 the in-race gamma
// ramp is off (Screenshots/*.tga carry none). Output: artifacts/port/environment/shots/<stage>_<shot>[_g].png and
// one JSON line per shot (pipeline far plane, gamma, flare drawn, draw calls / triangles, console problems).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, openGame, parseArgs, startServer, waitReady } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const stages = String(args.stages ?? 'corsica-1-f').split(',');
const gamma = String(args.gamma ?? '0');
const cam = String(args.cam ?? 'bonnet');
const width = Number(args.width ?? 800);
const height = Number(args.height ?? 600);
const outDir = path.join(ROOT, String(args.out ?? 'artifacts/port/environment/shots'));
const extra = typeof args.q === 'string' ? Object.fromEntries(args.q.split('&').map((kv) => kv.split('='))) : {};
fs.mkdirSync(outDir, { recursive: true });

let server = null, browser = null;
const problems = [];
try {
  const base = typeof args.url === 'string' ? args.url : (server = await startServer()).url;
  browser = await launchBrowser({ headed: !!args.headed });
  for (const id of stages) {
    const query = { stage: id, menu: 0, countdown: 0, quality: 'low', pr: 1, aa: 0, ...(gamma === '1' ? {} : { gamma }), ...extra };
    const g = await openGame(browser, base, query, { width, height });
    await waitReady(g.page, 240000);
    await g.page.evaluate(({ cam }) => {
      const r = window.__rally;
      r.startRace();
      r.setAutopilot(true);
      r.pause(true);
      r.setCamera(cam);
      for (let i = 0; i < 10; i++) r.step(12);
    }, { cam });
    for (const shot of ['start', 'mid', 'sun']) {
      const res = await g.page.evaluate(({ shot }) => {
        const r = window.__rally;
        const R = window.__rallyRenderer;
        R.setDebugCamera(null);
        if (shot === 'mid') {
          const info = r.getStageInfo();
          r.teleport((info.length ?? 2000) * 0.5, 0);
          for (let i = 0; i < 6; i++) r.step(12);
        }
        if (shot === 'sun') {
          const p = window.__rallyOrigPipeline;
          const sd = p?.environment?.data?.light?.sunDirThree ?? [0, 0.7, -0.7];
          const cp = R.debugInfo().camera;
          const h = Math.hypot(sd[0], sd[2]) || 1;
          // look along the sun's heading, pitched up by the sun's elevation (slope clamped to 0.05..0.5) so the flare
          // and the horizon both show
          const el = Math.min(0.5, Math.max(0.05, sd[1]));
          R.setDebugCamera({ x: cp.x, y: cp.y + 1, z: cp.z }, { x: cp.x + (sd[0] / h) * 100, y: cp.y + 1 + el * 100, z: cp.z + (sd[2] / h) * 100 }, false);
        }
        r.step(2);
        const url = R.domElement.toDataURL('image/png');
        const st = R.stats();
        const p = window.__rallyOrigPipeline;
        return {
          url,
          s: Math.round(r.getRaceState().s),
          calls: st.drawCalls,
          tris: st.triangles,
          orig: R.debugInfo().orig,
          far: p ? Math.round(p.mainFar) : null,
          gamma: p?.gamma ?? null,
          flare: p?.environment?.flareShown ?? null,
        };
      }, { shot });
      const file = path.join(outDir, `${id}_${shot}${gamma === '0' ? '' : '_g'}.png`);
      fs.writeFileSync(file, Buffer.from(res.url.split(',')[1], 'base64'));
      delete res.url;
      console.log(JSON.stringify({ stage: id, shot, ...res, errors: g.errors.length, warnings: g.warnings.length, file: path.relative(ROOT, file) }));
    }
    for (const e of g.errors) problems.push(`[${id}] ${e}`);
    for (const w of g.warnings) console.log(`  warning [${id}]: ${w}`);
    await g.context.close();
  }
} catch (e) {
  problems.push(String(e?.stack ?? e));
} finally {
  await browser?.close();
  await server?.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
