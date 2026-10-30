#!/usr/bin/env node
// tests/audio/browser-check.mjs — OWNED BY THE AUDIO BUILDER. The real game in headless Chromium: drives a stage
// with the autopilot and records what the audio engine plays (window.__rallyAudio.state(), src/audio/audio.ts):
// the path (original / synth), every sample that got a voice, the patches heard, the co-driver words spoken and the
// console errors / warnings. Variants: default (original bank) and orig=0 (synth fallback).
//
//   node tests/audio/browser-check.mjs [--stage corsica-1-f] [--car ImprezaWRX] [--seconds 25] [--cam chaseFar]
//                                      [--variants default,orig=0] [--out artifacts/audio-check]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { CHROMIUM_ARGS, ROOT, openGame, parseArgs, sleep, startServer, waitReady } from '../../tools/lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const stage = String(args.stage ?? 'corsica-1-f');
const car = String(args.car ?? 'ImprezaWRX');
const seconds = Number(args.seconds ?? 25);
const variants = String(args.variants ?? 'default,orig=0').split(',');
const outDir = path.resolve(ROOT, String(args.out ?? 'artifacts/audio-check'));
fs.mkdirSync(outDir, { recursive: true });

const server = args.url ? null : await startServer();
const base = args.url ? String(args.url) : server.url;
const browser = await chromium.launch({ headless: !args.headed, args: [...CHROMIUM_ARGS, '--autoplay-policy=no-user-gesture-required'] });
const results = [];
let ok = true;
try {
  for (const v of variants) {
    const query = { stage, car, autopilot: 1, menu: 0, countdown: 1, ghost: 0 };
    if (args.cam) query.cam = String(args.cam);
    if (v !== 'default') {
      const [k, val] = v.split('=');
      query[k] = val ?? '1';
    }
    const t0 = Date.now();
    const g = await openGame(browser, base, query);
    // co-driver voice on (the HUD speaks only with the setting; persisted in localStorage)
    await g.page.evaluate(() => localStorage.setItem('rally-web:ui:v2', JSON.stringify({ voice: true, pacenoteHud: true, hud: true })));
    await g.page.reload({ waitUntil: 'load' });
    await waitReady(g.page, 120000);
    await g.page.keyboard.press('Shift'); // a user gesture: AudioEngine.resume()
    const samples = new Map();
    const patches = new Set();
    const words = [];
    let last = null;
    let maxVoices = 0;
    let lastSpeaking = '';
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      await sleep(250);
      const st = await g.page.evaluate(() => window.__rallyAudio?.state() ?? null);
      if (!st) continue;
      last = st;
      const o = st.original;
      if (!o) continue;
      maxVoices = Math.max(maxVoices, o.voices.length);
      for (const vo of o.voices) samples.set(vo.sample, Math.max(samples.get(vo.sample) ?? 0, vo.gain));
      for (const p of o.heard) patches.add(p);
      const sp = o.coDriver.speaking ? o.coDriver.speaking.join(' ') : '';
      if (sp && sp !== lastSpeaking) words.push(sp);
      lastSpeaking = sp;
    }
    const race = await g.page.evaluate(() => window.__rally?.getRaceState?.() ?? null);
    const pacenoteInfo = await g.page.evaluate(() => {
      const i = window.__rally?.getStageInfo?.();
      return i ? { count: i.pacenoteCount ?? null } : null;
    });
    const shot = path.join(outDir, `${stage}-${v.replace(/[^a-z0-9]+/gi, '_')}.png`);
    await g.page.screenshot({ path: shot });
    const r = {
      variant: v,
      url: g.url,
      mode: last?.mode ?? null,
      running: last?.running ?? false,
      car: last?.original?.car ?? null,
      stageKey: last?.original?.stage ?? null,
      ticks: last?.original?.ticks ?? 0,
      maxVoices,
      cpuMs: last?.cpuMs ?? null,
      listener: last?.original?.listener ?? null,
      envObjects: last?.original?.envObjects ?? 0,
      samples: [...samples.entries()].map(([s, gmax]) => `${s} (max gain ${gmax})`).sort(),
      patches: [...patches].sort(),
      coDriverNotes: words,
      coDriverNotesStarted: last?.original?.coDriver?.notes ?? 0,
      pacenotesOnStage: pacenoteInfo,
      raceS: race ? Math.round(race.s) : null,
      phase: race?.phase ?? null,
      errors: g.errors,
      warnings: g.warnings,
      seconds: Math.round((Date.now() - t0) / 1000),
      screenshot: path.relative(ROOT, shot),
    };
    const expectMode = v === 'orig=0' ? 'synth' : 'original';
    r.ok = r.errors.length === 0 && r.running && r.mode === expectMode && (expectMode === 'synth' || (r.samples.length > 0 && r.ticks > 0));
    ok &&= r.ok;
    results.push(r);
    await g.context.close();
  }
} finally {
  await browser.close();
  await server?.close();
}
fs.writeFileSync(path.join(outDir, `${stage}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ ok, results }, null, 2));
process.exit(ok ? 0 : 1);
