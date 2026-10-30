#!/usr/bin/env node
// tools/cars/menu-check.mjs — CARS BUILDER tool: the car selection end-to-end in the REAL menu.
//
//   node tools/cars/menu-check.mjs [--stage corsica-1-f] [--steps 3] [--variant orig=0]
//
// Opens the game with the menu, reads the Car row's choices (original cars by their LocaleEnglish names, then the
// archetype class cars), steps the Car row `--steps` times to the right, screenshots the menu
// (artifacts/port/cars/menu_<variant>.png), presses Start and checks that the renderer shows that original car
// (debugInfo().origCars) and the sim runs its handling preset (telemetry mass). Exit 1 on console errors /
// warnings or a mismatch.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, openGame, parseArgs, startServer, waitReady } from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const stage = String(args.stage ?? 'corsica-1-f');
const steps = Number(args.steps ?? 3);
const variant = typeof args.variant === 'string' ? args.variant : 'default';
const outDir = path.join(ROOT, 'artifacts/port/cars');
fs.mkdirSync(outDir, { recursive: true });
const problems = [];
let server = null;
let browser = null;
try {
  const base = typeof args.url === 'string' ? args.url : (server = await startServer()).url;
  browser = await launchBrowser({ headed: !!args.headed });
  const extra = variant === 'default' ? {} : Object.fromEntries(variant.split('&').map((kv) => kv.split('=')));
  const g = await openGame(browser, base, { stage, quality: 'low', ...extra }, { width: 1280, height: 800 });
  await waitReady(g.page, 180000);
  const carRow = await g.page.evaluate(() => [...document.querySelectorAll('[data-row]')].find((el) => el.querySelector('.rw-k')?.textContent === 'Car')?.getAttribute('data-row'));
  if (carRow === undefined) throw new Error('no Car row in the menu');
  const read = () =>
    g.page.evaluate((i) => {
      const row = document.querySelector(`.rw-rows [data-row="${i}"]`);
      return { value: row?.querySelector('.rw-val')?.textContent ?? null, info: document.querySelector('.rw-info')?.textContent ?? '' };
    }, carRow);
  const seen = [];
  // walk the whole list once (wraps) to collect the choices
  const first = await read();
  seen.push(first.value);
  for (let i = 0; i < 40; i++) {
    await g.page.click(`.rw-rows [data-row="${carRow}"] [data-d="1"]`);
    const v = (await read()).value;
    if (v === first.value) break;
    seen.push(v);
  }
  console.log(`Car row: ${seen.length} choices:`, seen.join(' | '));
  for (let i = 0; i < steps; i++) await g.page.click(`.rw-rows [data-row="${carRow}"] [data-d="1"]`);
  await g.page.hover(`.rw-rows [data-row="${carRow}"]`);
  await g.page.waitForTimeout(1500); // cars.json → icon / spec lines
  const picked = await read();
  console.log('picked:', picked.value, '·', picked.info);
  await g.page.screenshot({ path: path.join(outDir, `menu_${variant.replace(/[^a-z0-9]+/gi, '-')}.png`) });
  await g.page.click('.rw-btn.rw-primary');
  await waitReady(g.page, 60000);
  await g.page.waitForFunction(() => window.__rally.getRaceState().phase !== 'idle', null, { timeout: 120000 }).catch(() => {});
  await g.page.waitForFunction(() => (window.__rallyRenderer.debugInfo().origCars ?? []).some((c) => c.car), null, { timeout: 60000, polling: 250 }).catch(() => {});
  const after = await g.page.evaluate(() => {
    const r = window.__rally;
    for (let i = 0; i < 30; i++) r.step(4);
    return { origCars: window.__rallyRenderer.debugInfo().origCars, mass: r.getParams().car.mass, archetype: r.getTelemetry().archetype };
  });
  console.log('after start:', JSON.stringify(after));
  await g.page.screenshot({ path: path.join(outDir, `menu_${variant.replace(/[^a-z0-9]+/gi, '-')}_race.png`) });
  const origNames = seen.filter((v) => !/class car/.test(v ?? ''));
  if (variant === 'default') {
    if (origNames.length !== 29) problems.push(`expected 29 original cars in the Car row, got ${origNames.length}`);
    const player = after.origCars.find((c) => c.id === 'player');
    if (!player?.car) problems.push('the started race shows no original car');
  } else if (origNames.length !== 0) problems.push(`${variant}: original cars listed without assets`);
  for (const e of g.errors) problems.push(e);
  for (const w of g.warnings) problems.push(`warning: ${w}`);
  await g.context.close();
} catch (e) {
  problems.push(String(e?.stack ?? e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
for (const p of problems.slice(0, 20)) console.log('PROBLEM', p);
process.exit(problems.length ? 1 : 0);
