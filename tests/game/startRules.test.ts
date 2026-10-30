/**
 * tests/game/startRules.test.ts — the original's start / timing / reset rules on the race controller
 * (docs/orig/race.md): spawn grid vs trigger 0, lap-order checkpoint gates, the reset target and lap
 * circuits' reset, best times / ghosts keyed by the original car.
 */
import { describe, expect, it } from 'vitest';
import { DT } from '../../src/core/constants';
import type { RaceEvent, Stage } from '../../src/core/types';
import { RaceController } from '../../src/game/race';
import { MemoryStore } from '../../src/game/storage';
import { bestKey, ghostKey } from '../../src/game/bestTimes';
import { buildGates } from '../../src/game/timing';
import { FakeCar, makeCircleStage, makeLineStage, note } from './fakes';

const steps = (sec: number) => Math.round(sec / DT);

/** A line stage with a ported-style spawn grid (stage.spawnS + startPose there). */
function withSpawn(stage: Stage, spawnS: number): Stage {
  return { ...stage, spawnS, startPose: { pos: stage.pointAt(spawnS), dir: stage.tangentAt(spawnS) } } as Stage;
}

function cruise(car: FakeCar, race: RaceController, v: number, n: number): RaceEvent[] {
  const ev: RaceEvent[] = [];
  for (let i = 0; i < n; i++) {
    car.place(0, car.pos.z - v * DT, 0, v);
    race.fixedUpdate(DT, car.telemetry());
    ev.push(...race.drainEvents());
  }
  return ev;
}

describe('start: spawn grid vs trigger 0 (corsica-2-f: spawn 559, trigger 0 545, valid range from 550)', () => {
  const stage = withSpawn(makeLineStage({ length: 2000, startS: 545, finishS: 1500, checkpoints: [1220], validRange: [550, 2000] }), 559);

  it('places the car at the spawn grid, not at / behind the start line, even with startGridBack', () => {
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore(), startGridBack: 8 });
    race.begin(stage, car, { countdown: false });
    expect(-car.pos.z).toBeCloseTo(559, 6);
    expect(race.state.s).toBeCloseTo(559, 6);
  });

  it('no outOfRange reset at GO; the clock runs from GO; checkpoint and finish at their trigger distances', () => {
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore(), startGridBack: 8 });
    race.begin(stage, car, { countdown: true });
    const ev: RaceEvent[] = [];
    while (race.state.phase === 'countdown') {
      race.fixedUpdate(DT, car.telemetry());
      ev.push(...race.drainEvents());
    }
    // wait 2 s at the grid, then drive at 20 m/s
    for (let i = 0; i < steps(2); i++) {
      race.fixedUpdate(DT, car.telemetry());
      ev.push(...race.drainEvents());
    }
    expect(race.state.resetting).toBe(false);
    ev.push(...cruise(car, race, 20, steps(50)));
    expect(ev.filter((e) => e.type === 'reset')).toEqual([]);
    const cp = ev.find((e) => e.type === 'checkpoint') as { time: number } | undefined;
    // 2 s waiting + (1220 - 559) / 20 s
    expect(cp?.time).toBeCloseTo(2 + (1220 - 559) / 20, 2);
    const fin = ev.find((e) => e.type === 'finish') as { time: number } | undefined;
    expect(fin?.time).toBeCloseTo(2 + (1500 - 559) / 20, 2);
  });

  it('procedural stages (no spawnS) keep the grid spot behind the line', () => {
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore(), startGridBack: 8 });
    race.begin(makeLineStage({ startS: 40 }), car, { countdown: false });
    expect(-car.pos.z).toBeCloseTo(32, 6);
  });
});

describe('reset rules (FUN_004b3e50)', () => {
  it('point-to-point: max(s - 20, validRange[0] + 1), even past the start line', () => {
    const stage = withSpawn(makeLineStage({ length: 2000, startS: 545, finishS: 1500, validRange: [550, 2000] }), 559);
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    cruise(car, race, 10, steps(1)); // s = 569
    race.requestReset('manual');
    for (let i = 0; i < steps(1); i++) race.fixedUpdate(DT, car.telemetry());
    expect(-car.pos.z).toBeCloseTo(551, 3);
  });

  it('lap circuits have no valid range: back 20 m across the lap line, the lap still counts', () => {
    const stage = makeCircleStage({ radius: 100, laps: 2, checkpoints: [] });
    const L = stage.length;
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    const drive = (ds: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const s = race.state.s + ds;
        const p = stage.pointAt(s);
        const t = stage.tangentAt(s);
        car.place(p.x, p.z, Math.atan2(t.x, -t.z), ds / DT);
        race.fixedUpdate(DT, car.telemetry());
      }
    };
    drive(0.1, 50); // 5 m past the line
    race.requestReset('manual');
    for (let i = 0; i < steps(1); i++) race.fixedUpdate(DT, car.telemetry());
    expect(race.state.s).toBeCloseTo(L - 15, 3);
    expect(race.state.resets).toBe(1);
    expect(race.state.lap).toBe(1);
    // back over the line (15 m) and one lap: lap 2 starts, not before
    const ev: RaceEvent[] = [];
    for (let i = 0; i < Math.round((L + 15 - 1) / 0.25); i++) {
      drive(0.25, 1);
      ev.push(...race.drainEvents());
    }
    expect(ev.filter((e) => e.type === 'lap')).toEqual([]);
    for (let i = 0; i < 20; i++) {
      drive(0.25, 1);
      ev.push(...race.drainEvents());
    }
    expect(ev.filter((e) => e.type === 'lap')).toHaveLength(1);
    expect(race.state.lap).toBe(2);
  });
});

describe('buildGates: lap-order checkpoint indices', () => {
  it('a lap line part-way round the loop: splits past s = 0 come first, indices follow the crossing order', () => {
    // iceracing 1F style: lap line at 0.9 L, splits at 0.2 L and 0.6 L (absolute spline s)
    const base = makeCircleStage({ radius: 100, laps: 2 });
    const L = base.length;
    const stage = { ...base, startS: 0.9 * L, finishS: 0.9 * L, checkpoints: [0.6 * L, 0.2 * L] };
    const g = buildGates(stage);
    expect(g.map((x) => x.kind)).toEqual(['checkpoint', 'checkpoint', 'lap', 'checkpoint', 'checkpoint', 'finish']);
    expect(g.map((x) => x.index)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(g[0].dist).toBeCloseTo(0.3 * L, 6);
    expect(g[1].dist).toBeCloseTo(0.7 * L, 6);
    expect(g[2].dist).toBeCloseTo(L, 6);
  });
});

describe('best times and ghosts keyed by the original car', () => {
  it('saves under the car name, loads per car, the ghost render state carries origCar', () => {
    const store = new MemoryStore();
    const stage = makeLineStage({ startS: 10, finishS: 210, checkpoints: [] });
    const run = (origCar?: string) => {
      const car = new FakeCar();
      const race = new RaceController({ store });
      race.begin(stage, car, { countdown: false, ...(origCar ? { origCar } : {}) });
      return { car, race };
    };
    const a = run('ImprezaWRX');
    expect(a.race.state.bestTime).toBeNull();
    a.race.startNow();
    cruise(a.car, a.race, 20, steps(11));
    expect(a.race.state.phase).toBe('finished');
    expect(store.getItem(bestKey(stage.id, stage.seed, 'ImprezaWRX'))).not.toBeNull();
    expect(store.getItem(ghostKey(stage.id, stage.seed, 'ImprezaWRX'))).not.toBeNull();
    expect(store.getItem(bestKey(stage.id, stage.seed, 'awd_wrc'))).toBeNull();
    // the same archetype as another original car, or as the archetype car: separate records
    expect(run('LancerEVO').race.state.bestTime).toBeNull();
    expect(run().race.state.bestTime).toBeNull();
    const b = run('ImprezaWRX');
    expect(b.race.state.bestTime).toBeCloseTo(10, 2);
    expect(b.race.hasGhost).toBe(true);
    b.race.startNow();
    cruise(b.car, b.race, 0, 4);
    const rs = b.race.ghostRenderState(b.car.telemetry(), 0)!;
    expect(rs.origCar).toBe('ImprezaWRX');
    expect(rs.archetype).toBe('awd_wrc');
  });
});

describe('timing triggers count within 20 m of the centre line (FUN_00483470)', () => {
  it('a checkpoint passed 25 m off the line waits and counts when the car comes back', () => {
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(makeLineStage({ startS: 10, finishS: 900, checkpoints: [200] }), car, { countdown: false });
    race.startNow();
    const ev: RaceEvent[] = [];
    const go = (lat: number, n: number) => {
      for (let i = 0; i < n; i++) {
        car.place(lat, car.pos.z - 20 * DT, 0, 20);
        race.fixedUpdate(DT, car.telemetry());
        ev.push(...race.drainEvents());
      }
    };
    go(0, steps(9)); // s = 190
    go(25, steps(1)); // s = 210, 25 m off: not counted
    expect(ev.filter((e) => e.type === 'checkpoint')).toEqual([]);
    go(0, 1);
    const cp = ev.find((e) => e.type === 'checkpoint') as { time: number } | undefined;
    expect(cp?.time).toBeCloseTo(10 + DT, 3);
  });
});

describe('resets on a multi-level / mesh world (yHint)', () => {
  it('a car that fell off the mesh is reset onto the road under a deck, not onto the deck', () => {
    // fake mesh world: a deck 8 m above the road everywhere (topmost without a hint), the road with one
    const world = {
      heightAt: (_x: number, _z: number, yHint?: number) => (yHint !== undefined && yHint < 4 ? 0 : 8),
    } as unknown as import('../../src/core/types').WorldQuery;
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(makeLineStage({ startS: 10 }), car, { countdown: false, world });
    expect(car.lastPose!.pos.y).toBeLessThan(2);
    race.startNow();
    cruise(car, race, 20, steps(5)); // s = 110
    car.place(0, car.pos.z, 0, 10, -6); // fell through (nothing hit off the mesh): below the spline by 6 m
    race.fixedUpdate(DT, car.telemetry());
    expect(race.state.resetting).toBe(true);
    for (let i = 0; i < steps(1); i++) race.fixedUpdate(DT, car.telemetry());
    expect(race.drainEvents().find((e) => e.type === 'reset')).toEqual({ type: 'reset', reason: 'belowTrack' });
    expect(car.lastPose!.pos.y).toBeCloseTo(1.5, 6);
  });
});

describe('the archive valid range verbatim (stage.validRange, its minimum past the start line)', () => {
  // corsica-2-f: splineRange 550/6000, trigger 0 at 545, spawn 559
  const stage = withSpawn(makeLineStage({ length: 2000, startS: 545, finishS: 1500, validRange: [550, 6000] }), 559) as Stage;

  it('reset floor = validRange[0] + 1 (551), not the start line + 1 (546)', () => {
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    cruise(car, race, 10, steps(1)); // s = 569
    race.requestReset('manual');
    for (let i = 0; i < steps(1); i++) race.fixedUpdate(DT, car.telemetry());
    expect(-car.pos.z).toBeCloseTo(551, 3);
  });

  it('driving back past 550 (behind the range minimum, still past the start line) is outOfRange, as in the original', () => {
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore(), stuckReset: false });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    const ev = cruise(car, race, -5, steps(1.6)); // 559 → 551: inside
    expect(race.state.resetting).toBe(false);
    ev.push(...cruise(car, race, -5, steps(0.4))); // → 549: out
    expect(race.state.resetting).toBe(true);
    for (let i = 0; i < steps(1); i++) {
      race.fixedUpdate(DT, car.telemetry());
      ev.push(...race.drainEvents());
    }
    expect(ev.find((e) => e.type === 'reset')).toEqual({ type: 'reset', reason: 'outOfRange' });
    expect(-car.pos.z).toBeCloseTo(551, 3);
  });
});

describe('pacenote played flags across resets (FUN_0074b620 / FUN_0074b680)', () => {
  it('a reset keeps the flags: a note jumped over in one step stays unplayed and fires on the next pass', () => {
    const stage = makeLineStage({ startS: 10, pacenotes: [note(100, 'a'), note(100.5, 'b'), note(300, 'c')] });
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    const said = (ev: RaceEvent[]) => ev.filter((e) => e.type === 'pacenote').map((e) => (e as { note: { text: string } }).note.text);
    const ev: RaceEvent[] = [];
    for (const z of [-99.9, -100.9]) {
      // 99.9 → 100.9 in one step: only the last passed note ('b') fires; 'a' is never the last one, never marked
      car.place(0, z, 0, 20);
      race.fixedUpdate(DT, car.telemetry());
      ev.push(...race.drainEvents());
    }
    expect(said(ev)).toEqual(['b']);
    race.requestReset('manual');
    for (let i = 0; i < steps(1); i++) race.fixedUpdate(DT, car.telemetry());
    race.drainEvents();
    expect(race.state.s).toBeCloseTo(80.9, 3); // back 20 m
    // on the way back past 100 'a' is the last passed note and unplayed: it fires (the original's flags); 'b' does not
    expect(said(cruise(car, race, 20, steps(2)))).toEqual(['a']);
  });

  it("a restart clears the flags (resetPaceNotes): the notes fire again", () => {
    const stage = makeLineStage({ startS: 10, pacenotes: [note(50, 'a')] });
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    const said = (ev: RaceEvent[]) => ev.filter((e) => e.type === 'pacenote').map((e) => (e as { note: { text: string } }).note.text);
    expect(said(cruise(car, race, 20, steps(3)))).toEqual(['a']);
    race.requestReset('restart');
    race.drainEvents();
    expect(said(cruise(car, race, 20, steps(3)))).toEqual(['a']);
  });
});

describe('post-finish track braking (FUN_004b3790 state 4 → phys+0x44, MECHANICS_SPEC §2.7)', () => {
  it("the finish hands the car the stage's bodyBrakingFactorForTrack; a reset / restart clears it", () => {
    const stage = { ...makeLineStage({ startS: 10, finishS: 110, checkpoints: [] }), trackBraking: 0.4 } as Stage;
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    cruise(car, race, 20, steps(4)); // s = 90: not finished
    expect(car.trackBraking).toBe(0);
    cruise(car, race, 20, steps(2));
    expect(race.state.phase).toBe('finished');
    expect(car.trackBraking).toBe(0.4);
    race.begin(stage, car, { countdown: false });
    expect(car.trackBraking).toBe(0);
  });

  it('procedural stages (no factor) do not brake the car after the finish', () => {
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(makeLineStage({ startS: 10, finishS: 110, checkpoints: [] }), car, { countdown: false });
    race.startNow();
    cruise(car, race, 20, steps(6));
    expect(race.state.phase).toBe('finished');
    expect(car.trackBraking).toBe(0);
  });
});
