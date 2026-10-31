#!/usr/bin/env node
// tools/ghosts-check.mjs — GHOSTS BUILDER browser acceptance (phase 2): team ghosts, best-run ghost, SAVE GHOST round trip
// across a page reload, ?ghost=0. Headless, stepped (deterministic), screenshots into artifacts/phase2/ghosts/, result.json.
//
//   node tools/ghosts-check.mjs [--out artifacts/phase2/ghosts] [--stages hillclimb-2c-r:DeltaS4:AndersC,...]
//
// Per team-ghost stage (stage:car:driver): the menu's Ghost row on that team ghost (screenshot), Start through the real menu
// (countdown, solo), the ghost beside the player at GO, mid-run, the frozen end; and, in the page, the ghost's position at
// known ticks == the decoded file (src/game/ghosts player + frame code, bit-exact). Then a full SAVE GHOST round trip
// (autopilot run to the finish, name dialog incl. the invalid-name and overwrite paths, reload, load the saved ghost and
// compare it with the recorded run) and ?ghost=0. Exit status 1 when any check or the console fails.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchBrowser, openGame, parseArgs, sleep, startServer, waitReady } from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const OUT = path.resolve(ROOT, typeof args.out === 'string' ? args.out : 'artifacts/phase2/ghosts');
fs.mkdirSync(OUT, { recursive: true });
const STAGES = (typeof args.stages === 'string' ? args.stages : 'hillclimb-2c-r:DeltaS4:AndersC,rallycross-1-f:Peugeot206:Erikp,corsica-1-f:NissanSkyline:KikiW')
  .split(',')
  .map((s) => s.split(':'));

const only = typeof args.only === 'string' ? args.only.split(',') : null; // team,go,save,best,ghost0
const want = (k) => !only || only.includes(k);
const results = { checks: [], screenshots: [], errors: [], stages: {} };
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};
const shot = async (page, name) => {
  const f = path.join(OUT, name + '.png');
  // headless SwiftShader can lag behind a long stepped run: one retry with a longer timeout
  try {
    await page.screenshot({ path: f, timeout: 60000 });
  } catch {
    await sleep(2000);
    await page.screenshot({ path: f, timeout: 600000 });
  }
  results.screenshots.push(path.relative(ROOT, f));
};
const frames = (page, n = 2) =>
  page.evaluate(async (k) => {
    for (let i = 0; i < k; i++) await new Promise((r) => requestAnimationFrame(() => r()));
  }, n);

const srv = await startServer();
const browser = await launchBrowser();
const pages = [];
async function open(query, size) {
  const g = await openGame(browser, srv.url, query, size);
  pages.push(g);
  await waitReady(g.page, 120000);
  await sleep(800);
  return g;
}

/** In the page: the ghost file's expected THREE position at `tick` (ticks applied since GO), from the real modules. */
const EXPECT_FN = `
async (a) => {
  const { parseGhost } = await import('/src/game/ghosts/format.ts');
  const { GhostPlayer } = await import('/src/game/ghosts/player.ts');
  const { newGhostPose, poseFromState, stageWorldHeight } = await import('/src/game/ghosts/frame.ts');
  let bytes;
  if (a.url) bytes = new Uint8Array(await (await fetch(a.url)).arrayBuffer());
  else {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('rally-web-ghosts', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const rec = await new Promise((res, rej) => { const r = db.transaction('ghosts').objectStore('ghosts').get(a.id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    bytes = rec.bytes;
  }
  const file = parseGhost(bytes);
  const p = new GhostPlayer(file);
  const out = new Float32Array(9);
  const pose = newGhostPose();
  const H = stageWorldHeight(a.stageId);
  const res = [];
  let n = 0;
  for (const t of a.ticks) {
    while (n < t) { n++; if (!p.step(out) && !p.finished) break; }
    poseFromState(out, H, pose);
    res.push({ tick: t, x: pose.pos.x, y: pose.pos.y, z: pose.pos.z, finished: p.finished });
  }
  return { frames: file.frameCount, total: file.splits[file.splits.length - 1], name: file.ghostName, car: file.carTemplate, res };
}`;

const expectFn = new Function('return ' + EXPECT_FN.trim())();

async function focusGhostRow(page) {
  // the Start button is focused when the main menu opens; Up once = the Ghost row (the last row)
  await page.keyboard.press('ArrowUp');
  await sleep(250);
}
async function pickGhost(page, needle) {
  // the lists fill in asynchronously (a loaded software-GL box can take seconds): keep cycling for up to ~40 s
  for (let i = 0; i < 100; i++) {
    const t = await page.evaluate(() => document.querySelector('.rw-opt.rw-focus .rw-val')?.textContent ?? '');
    if (t.includes(needle)) return t;
    await page.keyboard.press('ArrowRight');
    await sleep(i % 6 === 5 ? 1500 : 250);
  }
  return null;
}
async function waitPhase(page, phase, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = await page.evaluate(() => window.__rally.getRaceState().phase);
    if (p === phase) return true;
    await sleep(100);
  }
  return false;
}
/** Step the paused sim until `phase`, returning the number of steps taken. */
const stepUntil = (page, phase, chunk = 30, max = 100000) =>
  page.evaluate(
    ([ph, c, m]) => {
      const R = window.__rally;
      let n = 0;
      while (R.getRaceState().phase !== ph && n < m) {
        R.step(c);
        n += c;
      }
      return n;
    },
    [phase, chunk, max],
  );

try {
  // =================================================================================== team ghosts through the menu
  for (const [stageId, car, driver] of want('team') ? STAGES : []) {
    console.log(`\n== ${stageId} / ${car} / ${driver}`);
    const g = await open({ stage: stageId, car });
    const { page } = g;
    await focusGhostRow(page);
    const picked = await pickGhost(page, driver);
    check(`${stageId}: the Ghost row lists team ghost ${driver}`, !!picked, picked);
    // opponents: None (the row above the Ghost row), then back to the Ghost row so the screenshot shows it
    await page.keyboard.press('ArrowUp');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
    await sleep(300);
    await shot(page, `menu-ghostrow-${stageId}`);
    const rows = await page.evaluate(() => document.querySelector('.rw-rows')?.innerText.replace(/\n+/g, ' | '));
    results.stages[stageId] = { menuRows: rows };
    await page.keyboard.press('Enter'); // Start stage through the real menu path (countdown)
    check(`${stageId}: countdown started`, await waitPhase(page, 'countdown'));
    await page.evaluate(() => window.__rally.pause(true));
    const steps = await stepUntil(page, 'running', 30);
    await page.evaluate(() => window.__rally.step(1)); // the first running tick (the ghost has no pose before it)
    check(`${stageId}: GO after the 3 s countdown`, steps >= 360 && steps <= 390, steps);
    // the race is on tick (steps past GO); ticks since GO = the ghost's tick counter
    const gh0 = await page.evaluate(() => window.__rally.getGhosts());
    check(`${stageId}: getGhosts() has the team ghost with the file's car`, gh0.length === 1 && gh0[0].source === 'team' && gh0[0].origCar === car, gh0[0]);
    const stageInfo = await page.evaluate(() => window.__rally.getStageInfo());
    const ghostId = gh0[0]?.id;
    // positions at known ticks == the decoded file
    const file = await page.evaluate(() => window.__rally.getGhosts().length && null);
    void file;
    const fileName = (await (await fetch(srv.url + 'assets/global/ghosts.json')).json()).ghosts.find((e) => e.driver === driver && e.stageId === stageId).file;
    const base = gh0[0].tick;
    const ticks = [base, base + 7, base + 8, base + 100, base + 1000, base + 3000];
    const got = [];
    let prev = base;
    for (const t of ticks) {
      const s = await page.evaluate((n) => {
        const R = window.__rally;
        R.step(n);
        const gg = R.getGhosts()[0];
        return { tick: gg.tick, pos: gg.pos, finished: gg.finished };
      }, t - prev);
      prev = t;
      got.push(s);
    }
    const exp = await page.evaluate(expectFn, { url: `${srv.url}assets/global/ghosts/${fileName}.bin`, stageId, ticks: got.map((x) => x.tick) });
    let maxd = 0;
    got.forEach((s, i) => {
      const e = exp.res[i];
      maxd = Math.max(maxd, Math.abs(s.pos.x - e.x), Math.abs(s.pos.y - e.y), Math.abs(s.pos.z - e.z));
    });
    check(`${stageId}: getGhosts() position at ticks ${got.map((x) => x.tick).join(',')} == the decoded file`, maxd === 0, { maxAbsDiff: maxd });
    // screenshots: go / mid / frozen end. Rewind is not possible: take GO from a fresh load below
    await shot(page, `mid-early-${stageId}`);
    // the frozen end: run the ghost to its end (frames-1)*8 ticks; the player stands still, teleport it next to the ghost
    const endTick = (exp.frames - 1) * 8;
    const cur = got[got.length - 1].tick;
    await page.evaluate((n) => window.__rally.step(n), endTick - cur + 160);
    const fin1 = await page.evaluate(() => window.__rally.getGhosts()[0]);
    await page.evaluate(() => window.__rally.step(120));
    const fin2 = await page.evaluate(() => window.__rally.getGhosts()[0]);
    check(`${stageId}: the ghost freezes at its end (finished, position unchanged for 1 s)`, fin1.finished && fin2.finished && fin1.pos.x === fin2.pos.x && fin1.pos.z === fin2.pos.z, { tick: fin2.tick, endTick });
    const finExp = await page.evaluate(expectFn, { url: `${srv.url}assets/global/ghosts/${fileName}.bin`, stageId, ticks: [endTick] });
    check(`${stageId}: the frozen pose is the last applied one (7/8 of the last segment)`, Math.abs(fin2.pos.x - finExp.res[0].x) < 1e-9 && Math.abs(fin2.pos.z - finExp.res[0].z) < 1e-9);
    // bring the player next to the frozen ghost: the ghost's route position is its finish line
    await page.evaluate(([fs, lat]) => window.__rally.teleport(fs - 18, lat), [stageInfo.finishS ?? stageInfo.length - 40, 2]);
    await page.evaluate(() => window.__rally.setCamera('chaseFar'));
    await page.evaluate(() => window.__rally.step(150));
    await frames(page, 3);
    await shot(page, `end-frozen-${stageId}`);
    results.stages[stageId].ghost = { name: fileName, tickEnd: endTick, maxdPosDiff: maxd, ids: ghostId };
    check(`${stageId}: 0 console errors`, g.errors.length === 0, g.errors.slice(0, 3));
    await g.context.close();
  }

  // =================================================================================== GO / mid screenshots (fresh loads, stepped)
  for (const [stageId, car, driver] of want('go') ? STAGES : []) {
    const g = await open({ stage: stageId, car, menu: 0, countdown: 0, ai: 0 });
    const { page } = g;
    const ent = (await (await fetch(srv.url + 'assets/global/ghosts.json')).json()).ghosts.find((e) => e.driver === driver && e.stageId === stageId);
    await page.evaluate(async ([id, c, f]) => {
      const R = window.__rally;
      await R.loadStage(id, { origCar: c, opponents: 0, ghost: { source: 'team', id: 'team:' + f } });
      R.pause(true);
      R.startRace();
      R.step(2);
      R.setCamera('chaseFar');
    }, [stageId, car, ent.file]);
    await frames(page, 4);
    await shot(page, `go-${stageId}`);
    const go = await page.evaluate(() => ({ ghost: window.__rally.getGhosts()[0], tel: window.__rally.getTelemetry().pos }));
    const dist = Math.hypot(go.ghost.pos.x - go.tel.x, go.ghost.pos.z - go.tel.z);
    results.stages[stageId].goDistance = +dist.toFixed(1);
    // 2.5 s after GO: the player is still on the grid, the ghost has pulled away
    await page.evaluate(() => window.__rally.step(300));
    await frames(page, 4);
    await shot(page, `go-plus2s-${stageId}`);
    // mid-run: the ghost at tick 1500 (12.5 s), the player driving (autopilot)
    await page.evaluate(() => {
      const R = window.__rally;
      R.setAutopilot(true);
      for (let i = 0; i < 50; i++) R.step(30);
    });
    await frames(page, 4);
    await shot(page, `mid-${stageId}`);
    check(`${stageId}: GO and mid-run screenshots taken (ghost ${dist.toFixed(1)} m from the player at GO)`, true);
    check(`${stageId}: 0 console errors (fresh load)`, g.errors.length === 0, g.errors.slice(0, 3));
    await g.context.close();
  }

  // =================================================================================== best run + SAVE GHOST round trip
  if (want('save')) {
    const stageId = 'corsica-3-f';
    const car = 'Micra';
    console.log(`\n== SAVE GHOST round trip on ${stageId}`);
    // low quality / half resolution: a 160 s autopilot run piles up effects and the screenshots of a loaded software-GL box take minutes otherwise
    const g = await open({ stage: stageId, car, menu: 0, countdown: 0, ai: 0, quality: 'low', pr: 0.5 });
    const { page } = g;
    // drive with the autopilot, recording the player's THREE positions for the first 3000 ticks
    const run = await page.evaluate(
      async ([id, c]) => {
        const R = window.__rally;
        await R.loadStage(id, { origCar: c, opponents: 0, ghost: { source: 'best' } });
        R.pause(true);
        R.setAutopilot(true);
        R.startRace();
        const pos = [];
        let n = 0;
        // the first 1200 ticks one by one (the player's THREE positions), then in chunks (every call renders a frame)
        while (R.getRaceState().phase === 'running' && n < 60000) {
          const k = n < 1200 ? 1 : 60;
          R.step(k);
          n += k;
          if (n <= 1200) {
            const p = R.getTelemetry().pos;
            pos.push([p.x, p.y, p.z]);
          }
        }
        const st = R.getRaceState();
        return { ticks: n, phase: st.phase, time: st.finishTime, splits: st.splits, pos, ghosts: R.getGhosts() };
      },
      [stageId, car],
    );
    check('first run: finished with the autopilot', run.phase === 'finished' && run.time > 20, { time: run.time, ticks: run.ticks });
    check('first run: no best-run ghost to race yet', run.ghosts.length === 0);
    // the results screen opens 1.6 s (wall clock) after the finish, from the frame loop: let frames run until it is up, then freeze again
    await page.evaluate(() => window.__rally.pause(false));
    await page.waitForSelector('.rw-card .rw-btn', { timeout: 180000 });
    await page.evaluate(() => window.__rally.pause(true));
    await shot(page, 'save-results');
    const btns = await page.evaluate(() => [...document.querySelectorAll('.rw-card .rw-btn')].map((b) => b.textContent));
    check('results screen offers SAVE GHOST', btns.includes('Save ghost'), btns);
    await page.evaluate(() => [...document.querySelectorAll('.rw-card .rw-btn')].find((b) => b.textContent === 'Save ghost').click());
    await sleep(400);
    await shot(page, 'save-dialog');
    const hasInput = await page.evaluate(() => !!document.querySelector('.rw-ghostdlg input'));
    check('the name dialog opens with a text input', hasInput);
    // invalid name
    await page.keyboard.type('bad/name');
    await page.keyboard.press('Enter');
    await sleep(300);
    const err = await page.evaluate(() => document.querySelector('.rw-gd-error')?.textContent);
    check('invalid name is refused with the original text', err === 'This ghost file name is invalid.', err);
    await shot(page, 'save-invalid');
    await page.evaluate(() => { document.querySelector('.rw-ghostdlg input').value = ''; });
    await page.keyboard.type('Round Trip');
    await page.keyboard.press('Enter');
    await sleep(800);
    const done = await page.evaluate(() => document.querySelector('.rw-ghostdlg .rw-gd-text')?.textContent);
    check('SAVE GHOST saved', /Ghost saved: Round Trip/.test(done ?? ''), done);
    await shot(page, 'save-done');
    await page.keyboard.press('Enter'); // OK
    await sleep(300);
    // save again under the same name: overwrite confirm
    await page.evaluate(() => [...document.querySelector('.rw-card') ? document.querySelectorAll('.rw-card .rw-btn') : []].find((b) => b.textContent === 'Save ghost')?.click());
    await sleep(300);
    await page.evaluate(() => { document.querySelector('.rw-ghostdlg input').value = ''; });
    await page.keyboard.type('ROUND trip');
    await page.keyboard.press('Enter');
    await sleep(600);
    const ow = await page.evaluate(() => document.querySelector('.rw-ghostdlg .rw-gd-text')?.textContent);
    check('same name (any case) asks to overwrite', /already exists/.test(ow ?? ''), ow);
    await shot(page, 'save-overwrite');
    await page.keyboard.press('Escape'); // cancel
    await sleep(300);
    check('Esc closes the dialog', !(await page.evaluate(() => !!document.querySelector('.rw-ghostdlg'))));
    const idb = await page.evaluate(
      () =>
        new Promise((res) => {
          const r = indexedDB.open('rally-web-ghosts', 1);
          r.onsuccess = () => {
            const q = r.result.transaction('ghosts').objectStore('ghosts').getAll();
            q.onsuccess = () => res(q.result.map((x) => ({ id: x.id, name: x.name, car: x.car, time: x.time, bytes: x.bytes.length })));
          };
        }),
    );
    check('one record in IndexedDB (the overwrite did not duplicate)', idb.length === 1 && idb[0].car === car && idb[0].name === 'Round Trip', idb);
    check('0 console errors (save flow)', g.errors.length === 0, g.errors.slice(0, 3));
    results.stages.save = { idb, firstRunTime: run.time };

    // ---- reload: the saved ghost is listed, loads in a fresh page, and replays the recorded run
    // a new page load of the same origin (menu on, as a player would reopen the game): IndexedDB persists
    await page.goto(`${srv.url}?stage=${stageId}&car=${car}`, { waitUntil: 'load' });
    await waitReady(page, 120000);
    await sleep(1200);
    await focusGhostRow(page);
    const label = await pickGhost(page, 'Round Trip');
    check('after a reload the Ghost row lists the saved ghost', !!label, label);
    await shot(page, 'reload-menu-saved');
    const bestRow = await page.evaluate(() => document.querySelector('.rw-info')?.innerText);
    check('the info line says it is a saved ghost with its car', /saved ghost/.test(bestRow ?? '') && /Nissan|Micra/.test(bestRow ?? ''), bestRow);
    const sel = await page.evaluate(() => window.__rally && 1);
    void sel;
    // start through the menu, solo
    await page.keyboard.press('ArrowUp');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    check('saved ghost race: countdown', await waitPhase(page, 'countdown'));
    await page.evaluate(() => window.__rally.pause(true));
    await stepUntil(page, 'running', 30);
    await page.evaluate(() => window.__rally.step(1));
    const gu = await page.evaluate(() => window.__rally.getGhosts());
    check('the saved ghost races: source user, its name and car', gu.length === 1 && gu[0].source === 'user' && gu[0].name === 'Round Trip' && gu[0].origCar === car, gu[0]);
    check('the saved ghost has the recorded total time', Math.abs(gu[0].time - run.time) < 0.001, { ghost: gu[0].time, run: run.time });
    // compare with the file in IndexedDB and with the recorded player track
    const base = gu[0].tick;
    const ticksWanted = [base, base + 8, base + 80, base + 600, base + 1000, base + 1150];
    const gotU = [];
    let pv = base;
    for (const t of ticksWanted) {
      gotU.push(await page.evaluate((n) => {
        const R = window.__rally;
        R.step(n);
        const gg = R.getGhosts()[0];
        return { tick: gg.tick, pos: gg.pos };
      }, t - pv));
      pv = t;
    }
    const expU = await page.evaluate(expectFn, { id: idb[0].id, stageId, ticks: gotU.map((x) => x.tick) });
    let md = 0;
    let mTrack = 0;
    gotU.forEach((s, i) => {
      const e = expU.res[i];
      md = Math.max(md, Math.abs(s.pos.x - e.x), Math.abs(s.pos.y - e.y), Math.abs(s.pos.z - e.z));
      // the ghost lags the recorded player by one tick; both are THREE-space positions of the same run
      const p = run.pos[s.tick - 2]; // tick counter is 1-based; run.pos[i] = state after step i+1
      if (p) mTrack = Math.max(mTrack, Math.hypot(s.pos.x - p[0], s.pos.y - p[1], s.pos.z - p[2]));
    });
    check('saved ghost position at known ticks == the decoded saved file', md === 0, { maxAbsDiff: md });
    check('saved ghost follows the recorded run (within the 15 Hz quantisation)', mTrack < 0.6, { maxDistToRecordedPlayer: +mTrack.toFixed(3) });
    await page.evaluate(() => window.__rally.setCamera('chaseFar'));
    await page.evaluate(() => window.__rally.step(2));
    await frames(page, 3);
    await shot(page, 'saved-ghost-running');
    check('0 console errors (reload + saved ghost race)', g.errors.length === 0, g.errors.slice(0, 3));

    // ---- delete from the menu (Delete key on the Ghost row, confirmation)
    await page.evaluate(async () => {
      const R = window.__rally;
      R.pause(false);
      await R.loadStage('corsica-3-f', { origCar: 'Micra', opponents: 0 });
    });
    await page.keyboard.press('Escape'); // idle phase: opens the main menu
    await sleep(800);
    await focusGhostRow(page);
    const again = await pickGhost(page, 'Round Trip');
    check('saved ghost still listed before the delete', !!again, again);
    await page.keyboard.press('Delete');
    await sleep(400);
    const dtxt = await page.evaluate(() => document.querySelector('.rw-ghostdlg .rw-gd-text')?.textContent);
    check('Delete asks for confirmation (original text 636)', /Do you really want to/.test(dtxt ?? '') && /Round Trip/.test(dtxt ?? ''), dtxt);
    await shot(page, 'delete-confirm');
    await page.keyboard.press('ArrowLeft'); // Delete (the first button)
    await page.keyboard.press('Enter');
    await sleep(600);
    const left = await page.evaluate(
      () =>
        new Promise((res) => {
          const r = indexedDB.open('rally-web-ghosts', 1);
          r.onsuccess = () => {
            const q = r.result.transaction('ghosts').objectStore('ghosts').getAll();
            q.onsuccess = () => res(q.result.length);
          };
        }),
    );
    check('the saved ghost is deleted from IndexedDB', left === 0, left);
    await g.context.close();
  }

  // =================================================================================== best-run ghost across a reload
  if (want('best')) {
    const stageId = 'corsica-3-f';
    console.log(`\n== best-run ghost on ${stageId}`);
    const g = await open({ stage: stageId, car: 'Corolla', menu: 0, countdown: 0, ai: 0, quality: 'low', pr: 0.5 });
    const { page } = g;
    const first = await page.evaluate(
      async ([id]) => {
        const R = window.__rally;
        await R.loadStage(id, { origCar: 'Corolla', opponents: 0 });
        R.pause(true);
        R.setAutopilot(true);
        R.startRace();
        let n = 0;
        while (R.getRaceState().phase === 'running' && n < 80000) {
          R.step(30);
          n += 30;
        }
        return { phase: R.getRaceState().phase, time: R.getRaceState().finishTime };
      },
      [stageId],
    );
    check('best-run: first run finished', first.phase === 'finished', first);
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('rally-web:ghost')));
    check('best-run ghost stored under the v3 key (the exe layout), no v2 key', keys.length === 1 && keys[0].startsWith('rally-web:ghost:v3:'), keys);
    await page.reload({ waitUntil: 'load', timeout: 240000 });
    await waitReady(page, 240000);
    const info = await page.evaluate(async ([id]) => {
      const R = window.__rally;
      await R.loadStage(id, { origCar: 'Corolla', opponents: 0 });
      R.pause(true);
      R.startRace();
      R.step(10);
      return R.getGhosts();
    }, [stageId]);
    check('best-run ghost races after a reload (source best, total time = the first run)', info.length === 1 && info[0].source === 'best' && Math.abs(info[0].time - first.time) < 0.001, info[0]);
    check('0 console errors (best run)', g.errors.length === 0, g.errors.slice(0, 3));
    await g.context.close();
  }

  // =================================================================================== ?ghost=0
  if (want('ghost0')) {
    const stageId = 'hillclimb-2c-r';
    console.log(`\n== ?ghost=0 on ${stageId}`);
    const g = await open({ stage: stageId, car: 'DeltaS4', ghost: 0 });
    const { page } = g;
    await sleep(300);
    await shot(page, 'ghost0-menu');
    const dis = await page.evaluate(() => [...document.querySelectorAll('.rw-opt')].find((r) => r.querySelector('.rw-k')?.textContent === 'Ghost')?.className);
    const info = null;
    check('?ghost=0: the Ghost row is disabled (skipped by the cursor)', /rw-disabled/.test(dis ?? ''), { cls: dis, info });
    const r = await page.evaluate(async () => {
      const R = window.__rally;
      await R.loadStage('hillclimb-2c-r', { origCar: 'DeltaS4', opponents: 0, ghost: { source: 'team', id: 'team:AndersC_Hillclimb2Cr' } });
      R.pause(true);
      R.startRace();
      R.step(30);
      R.setCamera('chaseFar');
      return { ghosts: R.getGhosts(), stats: R.getFrameStats() };
    });
    check('?ghost=0: no ghost in play', r.ghosts.length === 0, r.ghosts);
    await frames(page, 4);
    await shot(page, 'ghost0-go');
    check('0 console errors (?ghost=0)', g.errors.length === 0, g.errors.slice(0, 3));
    await g.context.close();
  }
} catch (e) {
  check('script finished without throwing', false, String(e?.stack ?? e));
}

for (const g of pages) {
  for (const e of g.errors) results.errors.push(e);
  for (const w of g.warnings) results.errors.push('warning: ' + w);
}
check('0 console errors and warnings in total', results.errors.length === 0, results.errors.slice(0, 5));
fs.writeFileSync(path.join(OUT, only ? `result-${only.join('-')}.json` : 'result.json'), JSON.stringify(results, null, 1));
await browser.close();
await srv.close();
const failed = results.checks.filter((c) => !c.ok);
console.log(`\n${results.checks.length - failed.length}/${results.checks.length} checks ok; screenshots in ${path.relative(ROOT, OUT)}`);
process.exit(failed.length ? 1 : 0);
