/**
 * Ghosts in the race controller (src/game/race.ts ghost region + src/game/ghosts/session.ts): the best-run ghost in the exe
 * layout, the session best, SAVE GHOST / list / load / delete round trip, ghost selection (best / saved / off), a late-loaded
 * ghost catching up, the one-tick lag, the retired v2 key, ?ghost=0 (enabled: false).
 */
import { describe, expect, it } from 'vitest';
import { DT } from '../../../src/core/constants';
import type { RaceEvent } from '../../../src/core/types';
import { bestKey, ghostKey, legacyGhostKey } from '../../../src/game/bestTimes';
import { parseGhost, ghostTotalTime, GHOST_FRAME_BYTES } from '../../../src/game/ghosts/format';
import { MemoryGhostBackend, UserGhostStore, userGhostId } from '../../../src/game/ghosts/store';
import { RaceController } from '../../../src/game/race';
import { MemoryStore } from '../../../src/game/storage';
import { FakeCar, makeLineStage } from '../fakes';

const steps = (sec: number) => Math.round(sec / DT);

function make(store = new MemoryStore(), users = new UserGhostStore(new MemoryGhostBackend()), opts: { ghost?: boolean } = {}) {
  const car = new FakeCar();
  const race = new RaceController({ store, ghostStore: users, ...opts });
  return { car, race, store, users };
}

const STAGE = () => makeLineStage({ startS: 10, finishS: 410, checkpoints: [150, 300] });

function cruise(car: FakeCar, race: RaceController, v: number, n: number, lateral = 0): RaceEvent[] {
  const ev: RaceEvent[] = [];
  for (let i = 0; i < n; i++) {
    car.place(lateral, car.pos.z - v * DT, 0, v);
    race.fixedUpdate(DT, car.telemetry());
    ev.push(...race.drainEvents());
  }
  return ev;
}

/** One complete run at `v` m/s; returns the controller (finished). */
function run(m: ReturnType<typeof make>, v: number, origCar?: string, ghost?: Parameters<RaceController['begin']>[2]['ghost']) {
  const stage = STAGE();
  m.race.begin(stage, m.car, { countdown: false, ...(origCar ? { origCar } : {}), ...(ghost ? { ghost } : {}) });
  m.race.startNow();
  cruise(m.car, m.race, v, steps(400 / v + 2));
  expect(m.race.state.phase).toBe('finished');
  return stage;
}

describe('best-run ghost: the exe layout in the store', () => {
  it('a best run is stored as a 3.0 file (base64) under the v3 key; no v2 key is written', () => {
    const m = make();
    const stage = run(m, 20, 'Micra');
    const text = m.store.getItem(ghostKey(stage.id, stage.seed, 'Micra'));
    expect(text).not.toBeNull();
    expect(m.store.getItem(legacyGhostKey(stage.id, stage.seed, 'Micra'))).toBeNull();
    const g = parseGhost(Uint8Array.from(atob(text as string), (c) => c.charCodeAt(0)));
    expect(g.version).toBe('3.0');
    expect(g.carTemplate).toBe('MicraGhost');
    expect(g.trailer.length).toBe(0);
    // 20 s at 120 Hz = 2400 ticks = 300 frames of the 15 Hz grid (frame k at tick 8k + 7)
    expect(g.frameCount).toBeGreaterThan(290);
    expect(g.frameCount).toBeLessThan(310);
    expect(g.splits.length).toBe(3); // two checkpoints + the finish
    expect(ghostTotalTime(g)).toBeCloseTo(m.race.state.finishTime as number, 3);
    expect(g.frames.length).toBe(g.frameCount * GHOST_FRAME_BYTES);
  });

  it('the old 30 Hz JSON ghost (v2 key) is ignored without errors and removed by clear()', () => {
    const m = make();
    const stage = STAGE();
    m.store.setItem(legacyGhostKey(stage.id, stage.seed, 'awd_wrc'), JSON.stringify({ v: 1, hz: 30, count: 2, stride: 8, b64: 'AAAA' }));
    m.store.setItem(bestKey(stage.id, stage.seed, 'awd_wrc'), JSON.stringify({ v: 1, time: 20, splits: [5, 10, 20], archetype: 'awd_wrc', date: 1, resets: 0 }));
    m.race.begin(stage, m.car, { countdown: false });
    expect(m.race.hasGhost).toBe(false);
    expect(m.race.ghostLook()).toBeNull();
    m.race.startNow();
    cruise(m.car, m.race, 10, 10);
    expect(m.race.ghostInfos()).toEqual([]);
    m.race.best.clear(stage.id, stage.seed, 'awd_wrc');
    expect(m.store.getItem(legacyGhostKey(stage.id, stage.seed, 'awd_wrc'))).toBeNull();
  });

  it('a corrupt stored ghost is ignored', () => {
    const m = make();
    const stage = STAGE();
    m.store.setItem(ghostKey(stage.id, stage.seed, 'awd_wrc'), 'not base64 !!!');
    m.race.begin(stage, m.car, { countdown: false });
    expect(m.race.hasGhost).toBe(false);
    m.store.setItem(ghostKey(stage.id, stage.seed, 'awd_wrc'), btoa('3.0\0garbage'));
    m.race.begin(stage, m.car, { countdown: false });
    expect(m.race.hasGhost).toBe(false);
  });

  it('plays tick by tick: the ghost shows the recorded run one tick late and freezes at its end', () => {
    const m = make();
    const stage = run(m, 20);
    const b = make(m.store, m.users);
    const car = b.car;
    b.race.begin(stage, car, { countdown: false });
    expect(b.race.hasGhost).toBe(true);
    expect(b.race.ghostLook()).toEqual({ origCar: undefined, archetype: 'awd_wrc' }); // the best run: the player's own car
    expect(b.race.ghostPose()).toBeNull(); // not started
    b.race.startNow();
    expect(b.race.ghostInfos()).toEqual([]);
    cruise(car, b.race, 0, 1);
    const i1 = b.race.ghostInfos()[0];
    expect(i1).toMatchObject({ id: 'ghost', source: 'best', tick: 1, finished: false });
    // tick 1 = the initial state = the car's state at the first running step (s = 10 + one 20 m/s step)
    expect(i1.pos.z).toBeCloseTo(-(10 + 20 * DT), 3);
    cruise(car, b.race, 0, 599);
    const g = b.race.ghostPose()!;
    // 600 ticks (5 s) at 20 m/s from s = 10, minus the one-tick lag: 110 m minus 20 * DT
    expect(-g.pos.z).toBeCloseTo(10 + 100 - 20 * DT, 0);
    expect(b.race.ghostInfos()[0].tick).toBe(600);
    // after the ghost's end: frozen
    cruise(car, b.race, 0, steps(30));
    const info = b.race.ghostInfos()[0];
    expect(info.finished).toBe(true);
    const z0 = info.pos.z;
    cruise(car, b.race, 0, 240);
    expect(b.race.ghostInfos()[0].pos.z).toBe(z0);
    expect(-z0).toBeGreaterThan(390); // the last pose is 7/8 into the last segment, just short of the finish line
  });

  it('?ghost=0 (enabled: false) records nothing and plays nothing', () => {
    const m = make(new MemoryStore(), undefined, { ghost: false });
    const stage = run(m, 20);
    expect(m.store.getItem(ghostKey(stage.id, stage.seed, 'awd_wrc'))).toBeNull();
    expect(m.race.canSaveGhost()).toBe(false);
    expect(m.race.hasGhost).toBe(false);
  });

  it('a debug teleport makes the run invalid: no best-run ghost, no session best', () => {
    const m = make();
    const stage = STAGE();
    m.race.begin(stage, m.car, { countdown: false });
    m.race.startNow();
    cruise(m.car, m.race, 20, 100);
    m.race.teleport(50, 0);
    cruise(m.car, m.race, 20, steps(21));
    expect(m.race.state.phase).toBe('finished');
    expect(m.store.getItem(ghostKey(stage.id, stage.seed, 'awd_wrc'))).toBeNull();
    expect(m.race.canSaveGhost()).toBe(false);
  });
});

describe('session best and SAVE GHOST', () => {
  it('the session best is the faster of the finished runs; only it can be saved', async () => {
    const m = make();
    expect(m.race.canSaveGhost()).toBe(false);
    run(m, 20, 'Micra');
    expect(m.race.canSaveGhost()).toBe(true);
    const t1 = m.race.state.finishTime as number;
    run(m, 16, 'Micra'); // slower
    expect(m.race.canSaveGhost()).toBe(true);
    expect(await m.race.saveSessionGhost('Fast')).toBe(true);
    const saved = (await m.race.listGhosts('line'))[0];
    expect(saved.time).toBeCloseTo(t1, 3); // the 20 m/s run, not the later slower one
    run(m, 25, 'Micra'); // faster
    expect(await m.race.saveSessionGhost('Faster')).toBe(true);
    const list = await m.race.listGhosts('line');
    expect(list.map((e) => e.name).sort()).toEqual(['Fast', 'Faster']);
    expect(list.find((e) => e.name === 'Faster')!.time).toBeLessThan(t1);
  });

  it('another stage / car has no session best', () => {
    const m = make();
    run(m, 20, 'Micra');
    expect(m.race.canSaveGhost()).toBe(true);
    m.race.begin(STAGE(), m.car, { countdown: false, origCar: 'Corolla' });
    expect(m.race.canSaveGhost()).toBe(false);
    m.race.begin(STAGE(), m.car, { countdown: false, origCar: 'Micra' });
    expect(m.race.canSaveGhost()).toBe(true);
  });

  it('invalid names are refused; a name saves case-insensitively over itself; list and delete round trip', async () => {
    const m = make();
    run(m, 20, 'Micra');
    for (const bad of ['', '   ', 'a/b', 'what?', 'CON', 'x'.repeat(33), 'dots.']) expect(await m.race.saveSessionGhost(bad), JSON.stringify(bad)).toBe(false);
    expect(await m.race.saveSessionGhost('  My   Ghost ')).toBe(true);
    expect(await m.race.saveSessionGhost('my ghost')).toBe(true); // same file name: overwritten
    const list = await m.race.listGhosts('line');
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ source: 'user', name: 'my ghost', origCar: 'Micra', stageId: 'line', deletable: true });
    expect(list[0].id).toBe(userGhostId('line', 'Micra', 'my ghost'));
    expect((await m.race.listGhosts('other')).length).toBe(0);
    await m.race.deleteGhost(list[0].id);
    expect((await m.race.listGhosts('line')).length).toBe(0);
    await m.race.deleteGhost('team:foo'); // not a user ghost: ignored
  });

  it('a saved ghost is a 3.0 file with the typed name that the loader reads back', async () => {
    const m = make();
    run(m, 20, 'Micra');
    await m.race.saveSessionGhost('Ünï Gh0st');
    const rec = (await m.users.list('line'))[0];
    const g = parseGhost(rec.bytes);
    expect(g.version).toBe('3.0');
    expect(g.ghostName).toBe('Ünï Gh0st');
    expect(g.carTemplate).toBe('MicraGhost');
    expect(rec.time).toBeCloseTo(ghostTotalTime(g), 6);
  });
});

describe('racing a saved ghost', () => {
  it('prepare + begin: the ghost file\'s own car, the saved name, the playback equals the best-run playback', async () => {
    const m = make();
    const stage = run(m, 20, 'Micra');
    await m.race.saveSessionGhost('Keeper');
    const id = (await m.race.listGhosts(stage.id))[0].id;
    // a different player car: the ghost keeps the file's car
    const b = make(new MemoryStore(), m.users);
    const sel = { source: 'user' as const, id };
    await b.race.prepareGhost(sel);
    b.race.begin(stage, b.car, { countdown: false, origCar: 'Corolla', ghost: sel });
    expect(b.race.hasGhost).toBe(true);
    // main.ts loads the ghost's visual with the race: its car is known before GO (the file's, not the player's Corolla)
    expect(b.race.ghostLook()?.origCar).toBe('Micra');
    expect(b.race.selectedGhost).toEqual(sel);
    b.race.startNow();
    cruise(b.car, b.race, 0, 600);
    const info = b.race.ghostInfos()[0];
    expect(info).toMatchObject({ source: 'user', name: 'Keeper', origCar: 'Micra', tick: 600 });
    const rs = b.race.ghostRenderState(b.car.telemetry(), 1)!; // alpha 1 = the latest tick
    expect(rs.origCar).toBe('Micra');
    expect(rs.ghost).toBe(true);
    expect(rs.id).toBe('ghost');
    expect(rs.pos.z).toBeCloseTo(info.pos.z, 9);
    // wheels: the front pair carries the steer, all four the spin, none touches the ground
    const w = (rs.telemetry as { wheels: Array<{ contact: boolean; visual: { steerAngle: number; spinAngle: number } }> }).wheels;
    expect(w.every((x) => !x.contact)).toBe(true);
    expect(w[2].visual.steerAngle).toBe(0);
    // the same file as the best run of the first controller: identical positions tick for tick
    const c = make(m.store, m.users);
    c.race.begin(stage, c.car, { countdown: false, origCar: 'Micra' });
    c.race.startNow();
    cruise(c.car, c.race, 0, 600);
    expect(c.race.ghostInfos()[0].pos).toEqual(info.pos);
  });

  it('a ghost that arrives after GO catches up to the current tick (no prepare)', async () => {
    const m = make();
    const stage = run(m, 20, 'Micra');
    await m.race.saveSessionGhost('Late');
    const id = (await m.race.listGhosts(stage.id))[0].id;
    const ref = make(new MemoryStore(), m.users);
    await ref.race.prepareGhost({ source: 'user', id });
    ref.race.begin(stage, ref.car, { countdown: false, ghost: { source: 'user', id } });
    ref.race.startNow();
    cruise(ref.car, ref.race, 0, 700);
    const late = make(new MemoryStore(), m.users);
    late.race.begin(stage, late.car, { countdown: false, ghost: { source: 'user', id } });
    expect(late.race.hasGhost).toBe(false);
    late.race.startNow();
    cruise(late.car, late.race, 0, 300);
    expect(late.race.ghostInfos()).toEqual([]);
    await new Promise((r) => setTimeout(r, 20)); // the store read resolves
    expect(late.race.hasGhost).toBe(true);
    cruise(late.car, late.race, 0, 400);
    expect(late.race.ghostInfos()[0].tick).toBe(700);
    expect(late.race.ghostInfos()[0].pos).toEqual(ref.race.ghostInfos()[0].pos);
  });

  it('selection off: no ghost even with a stored best run; a missing saved ghost: none', async () => {
    const m = make();
    const stage = run(m, 20);
    const b = make(m.store, m.users);
    b.race.begin(stage, b.car, { countdown: false, ghost: { source: 'off' } });
    expect(b.race.hasGhost).toBe(false);
    b.race.begin(stage, b.car, { countdown: false, ghost: { source: 'user', id: 'user:line/Micra/none' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(b.race.hasGhost).toBe(false);
    b.race.begin(stage, b.car, { countdown: false, ghost: { source: 'best' } });
    expect(b.race.hasGhost).toBe(true);
  });

  it('getGhosts info is plain JSON', async () => {
    const m = make();
    const stage = run(m, 20);
    const b = make(m.store, m.users);
    b.race.begin(stage, b.car, { countdown: false });
    b.race.startNow();
    cruise(b.car, b.race, 0, 50);
    const info = b.race.ghostInfos();
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
    expect(info[0].frames).toBeGreaterThan(100);
    expect(info[0].time).toBeCloseTo(m.race.state.finishTime as number, 3);
  });
});

describe('ghosts do not disturb the race', () => {
  it('race state is identical with a ghost to race and with the ghost switched off', () => {
    const m = make();
    const stage = run(m, 20);
    const a = make(m.store, m.users);
    const b = make(m.store, m.users);
    const seen: string[][] = [[], []];
    [a, b].forEach((x, i) => {
      x.race.begin(stage, x.car, { countdown: false, ghost: i === 0 ? { source: 'off' } : { source: 'best' } });
      x.race.startNow();
      for (let k = 0; k < 300; k++) {
        cruise(x.car, x.race, 18, 1);
        seen[i].push(JSON.stringify(x.race.state));
      }
    });
    expect(a.race.hasGhost).toBe(false);
    expect(b.race.hasGhost).toBe(true);
    expect(seen[1] === seen[0] || seen[1].every((v, i) => v === seen[0][i])).toBe(true);
  });
});
