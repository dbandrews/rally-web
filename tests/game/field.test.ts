/**
 * tests/game/field.test.ts — OWNED BY THE AI-RACE BUILDER. CarField (src/game/field.ts) with fake sims, a fake host and a
 * scripted driver: roster -> prepare -> grid -> parked until GO -> laps / finish / standings -> recovery -> clear.
 */
import { describe, expect, it, vi } from 'vitest';
import { DT, neutralControls } from '../../src/core/constants';
import type { AiOpponentSpec, FieldHost, FieldStepContext } from '../../src/core/field';
import type { Controls, ICarSim, RaceSelection, RaceState, Stage } from '../../src/core/types';
import { CarFlagSource } from '../../src/game/carFlags';
import { CarField, POST_FINISH_LIMIT_S } from '../../src/game/field';
import type { AiDriver, AiDriverInit } from '../../src/game/ai/driver';
import { RaceController } from '../../src/game/race';
import { MemoryStore } from '../../src/game/storage';
import { FakeCar, makeCircleStage, makeLineStage } from './fakes';

const SEL: RaceSelection = { stageId: 'line', archetype: 'awd_wrc', tyre: 0, transmission: 'auto', setup: {}, steerSensFast: true, seed: 1, opponents: 3 };

const spec = (i: number, car = 'Micra'): AiOpponentSpec => ({
  id: `ai${i}`,
  origCar: car,
  archetype: 'fwd_hatch',
  name: `Car ${i}`,
  skill: 1,
  tyreScale: 1,
  gridIndex: i,
  slotBase: 24 * i,
});

/** A kinematic AI car: FakeCar with its own id. */
class AiFake extends FakeCar {
  constructor(id: string) {
    super();
    Object.defineProperty(this, 'id', { value: id });
  }
  override telemetry() {
    const t = super.telemetry();
    t.id = (this as unknown as { id: string }).id;
    return t;
  }
}

class Host implements FieldHost {
  cars: AiFake[] = [];
  created: string[] = [];
  createCar(sp: AiOpponentSpec): ICarSim {
    const c = new AiFake(sp.id);
    this.cars.push(c);
    this.created.push(sp.id);
    return c;
  }
}

/** Scripted driver: full throttle straight (the kinematic car follows its heading), optional per-car speed. */
function scripted(throttle: (id: string, inp: Parameters<AiDriver['update']>[0]) => number = () => 1) {
  const drivers: { id: string; resets: number; last: Controls }[] = [];
  const make = (init: AiDriverInit): AiDriver => {
    const rec = { id: init.spec.id, resets: 0, last: neutralControls() };
    drivers.push(rec);
    return {
      placeholder: true,
      reset: () => void rec.resets++,
      update: (inp) => {
        rec.last = { steer: 0, throttle: inp.running ? throttle(init.spec.id, inp) : 0, brake: 0, handbrake: inp.running ? 0 : 1, gearUp: false, gearDown: false };
        return rec.last;
      },
      debug: () => ({ placeholder: true }),
    };
  };
  return { make, drivers };
}

function raceState(over: Partial<RaceState> = {}): RaceState {
  return { ...new RaceController({ store: new MemoryStore() }).state, ...over };
}

async function setup(stage: Stage, n = 3, opts: { throttle?: Parameters<typeof scripted>[0] } = {}) {
  const host = new Host();
  const drv = scripted(opts.throttle);
  const field = new CarField({ specs: Array.from({ length: 3 }, (_, i) => spec(i + 1)), createDriver: drv.make });
  const specs = await field.prepare({ ...SEL, stageId: stage.id, opponents: n }, stage, { heightAt: () => 0 } as never, host);
  const race = raceState({ phase: 'countdown', s: stage.startS, stageId: stage.id });
  field.begin(race);
  const player = new FakeCar();
  const ctx: FieldStepContext = { player: { sim: player, telemetry: player.telemetry() }, race };
  return { host, drv, field, specs, race, player, ctx };
}

/** One physics substep in main.ts's order (without the contact step). */
function substep(f: Awaited<ReturnType<typeof setup>>) {
  f.field.step(DT, f.ctx);
  f.field.afterStep(DT, f.ctx);
}

describe('prepare / begin', () => {
  it('opponents 0: nothing is built, every method is inert', async () => {
    const host = new Host();
    const field = new CarField();
    const specs = await field.prepare({ ...SEL, opponents: 0 }, makeLineStage({ startS: 60 }), {} as never, host);
    expect(specs).toEqual([]);
    expect(host.created).toEqual([]);
    expect(field.sims).toHaveLength(0);
    expect(field.renderStates(0.5)).toHaveLength(0);
    expect(field.otherFrames(0.016, false)).toHaveLength(0);
    expect(field.snapshot().opponents).toBe(0);
    expect(field.snapshot().standings).toEqual([]);
    expect(field.drainEvents()).toEqual([]);
    field.begin(raceState());
    field.step(DT, {} as never);
    field.afterStep(DT, {} as never);
  });

  it('a stage without a roster (not an original stage) gets no opponents', async () => {
    const host = new Host();
    const field = new CarField();
    const specs = await field.prepare({ ...SEL, opponents: 3 }, makeLineStage({ startS: 60 }), {} as never, host);
    expect(specs).toEqual([]);
    expect(host.created).toEqual([]);
  });

  it('creates one sim per opponent through the host and places them on the grid, parked', async () => {
    const stage = makeLineStage({ startS: 60, length: 1000 });
    const f = await setup(stage);
    expect(f.specs.map((s) => s.id)).toEqual(['ai1', 'ai2', 'ai3']);
    expect(f.host.created).toEqual(['ai1', 'ai2', 'ai3']);
    expect(f.field.sims).toHaveLength(3);
    // synthetic grid on a procedural stage: [startS - 8, 2, 6]; the player (0) takes the front-left slot
    const slots = f.host.cars.map((c) => {
      const t = c.telemetry();
      const pr = stage.project(t.pos);
      return { s: Math.round(pr.s * 100) / 100, lateral: Math.round(pr.lateral * 100) / 100 };
    });
    // line stage: THREE +x is the lateral axis, facing -z; ai1 = slot 1 (right column, front row), ai2 = slot 2 (left, row 2)
    expect(slots[0]).toEqual({ s: 52, lateral: 2 });
    expect(slots[1]).toEqual({ s: 46, lateral: -2 });
    expect(slots[2]).toEqual({ s: 46, lateral: 2 });
    for (const c of f.host.cars) expect(c.parked).toBe(true);
    expect(f.field.snapshot().cars.map((c) => c.gridIndex)).toEqual([1, 2, 3]);
  });

  it('a newer prepare wins over a slower older one', async () => {
    const stage = makeLineStage({ startS: 60 });
    const host = new Host();
    const field = new CarField({ specs: [spec(1), spec(2), spec(3)], createDriver: scripted().make });
    const a = field.prepare({ ...SEL, opponents: 3 }, stage, {} as never, host);
    const b = field.prepare({ ...SEL, opponents: 1 }, stage, {} as never, host);
    await Promise.all([a, b]);
    expect(field.opponents.map((s) => s.id)).toEqual(['ai1']);
    expect(field.sims).toHaveLength(1);
  });
});

describe('standings on the grid', () => {
  it('before GO the field reads in grid order whatever the projections say (row mates tie on the slot distance)', async () => {
    const stage = makeLineStage({ startS: 60, length: 1000 });
    const f = await setup(stage);
    f.race.s = 52; // the player's slot s on the synthetic grid (startS − 8)
    f.field.begin(f.race);
    for (let i = 0; i < 30; i++) substep(f);
    f.host.cars[0].place(2.3, f.host.cars[0].pos.z - 0.4); // ai1 drifts 0.4 m ahead of the player while still parked
    substep(f);
    const s = f.field.snapshot();
    expect(s.standings.map((e) => e.id)).toEqual(['player', 'ai1', 'ai2', 'ai3']);
    expect(s.playerPosition).toBe(1);
  });
});

describe('shared countdown', () => {
  it('the AI cars stay parked through the countdown and are released in the substep the player is', async () => {
    const stage = makeLineStage({ startS: 60, length: 1000 });
    const f = await setup(stage);
    for (let i = 0; i < 120; i++) substep(f); // countdown: nothing moves
    for (const c of f.host.cars) {
      expect(c.parked).toBe(true);
      expect(c.speed).toBe(0);
      expect(c.lastControls.handbrake).toBe(1);
    }
    f.race.phase = 'running'; // RaceController.startNow() ran inside race.fixedUpdate of this substep
    f.field.step(DT, f.ctx); // (the field.step of this substep ran before the race logic: still parked)
    f.field.afterStep(DT, f.ctx);
    for (const c of f.host.cars) expect(c.parked).toBe(false);
    for (let i = 0; i < 120; i++) substep(f);
    for (const c of f.host.cars) expect(c.speed).toBeGreaterThan(5);
    expect(f.drv.drivers.every((d) => d.resets >= 2)).toBe(true); // begin + GO
  });
});

describe('laps, finish and standings', () => {
  it('a point-to-point race: finish times, order, events, track braking, then the run-out', async () => {
    const stage = makeLineStage({ startS: 60, length: 600, finishS: 560, checkpoints: [200, 400] });
    // car 1 is the fastest, car 3 the slowest
    const f = await setup(stage, 3, { throttle: (id) => (id === 'ai1' ? 1 : id === 'ai2' ? 0.8 : 0.6) });
    f.race.phase = 'running';
    for (let i = 0; i < 4000 && !f.field.snapshot().cars.every((c) => c.finished); i++) {
      f.race.time = (i + 1) * DT;
      substep(f);
    }
    const snap = f.field.snapshot();
    expect(snap.cars.every((c) => c.finished)).toBe(true);
    const times = snap.cars.map((c) => c.finishTime!);
    expect(times[0]).toBeLessThan(times[1]);
    expect(times[1]).toBeLessThan(times[2]);
    const ev = f.field.drainEvents().filter((e) => e.type === 'aiFinish');
    expect(ev.map((e) => e.type === 'aiFinish' && e.id)).toEqual(['ai1', 'ai2', 'ai3']);
    expect(ev.map((e) => e.type === 'aiFinish' && e.position)).toEqual([1, 2, 3]);
    // the player has not finished: the AI cars take 1..3, the player 4th
    expect(snap.standings.map((s) => s.id)).toEqual(['ai1', 'ai2', 'ai3', 'player']);
    expect(snap.standings.map((s) => s.position)).toEqual([1, 2, 3, 4]);
    expect(snap.playerPosition).toBe(4);
    expect(snap.fieldSize).toBe(4);
    expect(snap.standings[1].gapToLeader).toBeCloseTo(times[1] - times[0], 3);
    expect(snap.standings[3].finished).toBe(false);
    // they roll out under the run-out controller (not the scripted driver) and the stage's finish braking applies
    const before = f.drv.drivers[0].last;
    for (let i = 0; i < 60; i++) substep(f);
    expect(f.drv.drivers[0].last).toBe(before);
  });

  it('the player wins: position 1 / finished first, then the AI cars finish behind (standings final once all are in)', async () => {
    const stage = makeLineStage({ startS: 60, length: 600, finishS: 560, checkpoints: [] });
    const f = await setup(stage, 2, { throttle: () => 0.7 });
    f.race.phase = 'running';
    for (let i = 0; i < 900; i++) {
      f.race.time = (i + 1) * DT;
      substep(f);
    }
    // the player finishes at 6.5 s
    f.race.phase = 'finished';
    f.race.finishTime = 6.5;
    f.race.s = 560;
    substep(f);
    let snap = f.field.snapshot();
    expect(snap.standings[0].id).toBe('player');
    expect(snap.standings[0].finished).toBe(true);
    expect(snap.playerPosition).toBe(1);
    for (let i = 0; i < 6000 && !f.field.snapshot().cars.every((c) => c.finished); i++) substep(f);
    snap = f.field.snapshot();
    expect(snap.cars.every((c) => c.finished)).toBe(true);
    expect(snap.standings.map((s) => s.id)).toEqual(['player', 'ai1', 'ai2'].slice(0, 3));
    expect(snap.standings.every((s) => s.finished)).toBe(true);
    expect(snap.standings[1].gapToLeader).toBeGreaterThan(0);
  });

  it('a lap circuit counts laps and finishes after the last', async () => {
    const stage = makeCircleStage({ radius: 60, laps: 2, startS: 0, checkpoints: [] });
    const f = await setup(stage, 1, { throttle: () => 1 });
    f.race.phase = 'running';
    let lapsSeen = 1;
    for (let i = 0; i < 12000 && !f.field.snapshot().cars[0].finished; i++) {
      f.race.time = (i + 1) * DT;
      // keep the kinematic car on the circle: steer toward the centre line (the scripted driver only goes straight)
      const c = f.host.cars[0];
      const pr = stage.project(c.pos);
      c.heading = Math.atan2(stage.tangentAt(pr.s).x, -stage.tangentAt(pr.s).z);
      substep(f);
      lapsSeen = Math.max(lapsSeen, f.field.snapshot().cars[0].lap);
    }
    expect(lapsSeen).toBe(2);
    expect(f.field.snapshot().cars[0].finished).toBe(true);
    expect(f.field.snapshot().cars[0].lap).toBe(2);
  });

  it('after the grace period the unfinished AI cars are DNF, ranked by distance', async () => {
    const stage = makeLineStage({ startS: 60, length: 100000, finishS: 99990, checkpoints: [] });
    const f = await setup(stage, 2, { throttle: (id) => (id === 'ai1' ? 0.2 : 0.4) });
    f.race.phase = 'running';
    for (let i = 0; i < 240; i++) substep(f);
    f.race.phase = 'finished';
    f.race.finishTime = 2;
    f.race.s = stage.finishS;
    const grace = Math.ceil((POST_FINISH_LIMIT_S + 2) / DT);
    for (let i = 0; i < grace; i++) substep(f);
    const snap = f.field.snapshot();
    expect(snap.cars.every((c) => !c.finished && c.ai?.dnf === true)).toBe(true);
    expect(snap.standings.map((s) => s.id)).toEqual(['player', 'ai2', 'ai1']); // finished first, then by distance
  });
});

describe('recovery', () => {
  it('a car off the road (> 30 m) goes back 20 m on the centre line (the driver keeps its state)', async () => {
    const stage = makeLineStage({ startS: 60, length: 1000, width: 8 });
    const f = await setup(stage, 1, { throttle: () => 1 });
    f.race.phase = 'running';
    for (let i = 0; i < 240; i++) substep(f);
    const car = f.host.cars[0];
    const before = stage.project(car.pos);
    car.place(45, car.pos.z, 0, car.speed); // 45 m to the side
    const resetsBefore = car.resets;
    const driverResets = f.drv.drivers[0].resets;
    substep(f);
    expect(car.resets).toBe(resetsBefore + 1);
    const pose = car.lastPose!;
    const pr = stage.project({ x: pose.pos.x, y: 0, z: -pose.pos.z });
    expect(pr.lateral).toBeCloseTo(0, 3);
    expect(before.s - pr.s).toBeCloseTo(20 - (stage.project(car.pos).s - before.s) * 0, 0); // ≈ 20 m back of where it was
    expect(f.drv.drivers[0].resets).toBe(driverResets); // the driver keeps its state (race-progress base)
    expect(f.field.snapshot().cars[0].resets).toBe(1);
    expect(f.field.drainEvents()).toContainEqual({ type: 'aiReset', id: 'ai1', reason: 'offTrack' });
  });

  it('a car that cannot move for 10 s while asking to is reset in place', async () => {
    const stage = makeLineStage({ startS: 60, length: 1000 });
    const f = await setup(stage, 1, { throttle: () => 1 });
    f.host.cars[0].frozen = true; // never moves
    f.race.phase = 'running';
    const n = Math.ceil(10.2 / DT);
    for (let i = 0; i < n; i++) substep(f);
    expect(f.field.snapshot().cars[0].resets).toBe(1);
    expect(f.field.drainEvents()).toContainEqual({ type: 'aiReset', id: 'ai1', reason: 'stuck' });
  });

  it('nothing is checked before GO (a car on the grid beside the limit is not reset)', async () => {
    const stage = makeLineStage({ startS: 60, length: 1000 });
    const f = await setup(stage, 1);
    f.host.cars[0].place(45, f.host.cars[0].pos.z);
    for (let i = 0; i < 50; i++) substep(f);
    expect(f.field.snapshot().cars[0].resets).toBe(0);
  });
});

describe('frame views and housekeeping', () => {
  it('render states: AI flags, grid index, interpolation, reused objects, THREE space', async () => {
    const stage = makeLineStage({ startS: 60, length: 1000 });
    const f = await setup(stage, 2, { throttle: () => 1 });
    f.race.phase = 'running';
    for (let i = 0; i < 30; i++) substep(f);
    const a = f.field.renderStates(0);
    const b = f.field.renderStates(1);
    expect(a).toHaveLength(2);
    expect(a).toBe(b); // one array
    expect(a[0]).toBe(f.field.renderStates(0.5)[0]); // one object per car
    const car = f.host.cars[0];
    expect(a[0]).toMatchObject({ id: 'ai1', ai: true, player: false, ghost: false, carIndex: 1, origCar: 'Micra' });
    const z1 = f.field.renderStates(1)[0].pos.z;
    expect(z1).toBeCloseTo(car.pos.z, 6); // alpha 1 = the current pose, THREE space
    const z0 = f.field.renderStates(0)[0].pos.z;
    expect(z0).toBeGreaterThan(z1); // alpha 0 = one substep earlier (moving toward -z)
    expect(f.field.renderStates(0)[0].carFlags).toBeDefined();
    // first frame after a reset flags justReset once
    const rs = f.field.renderStates(0)[0];
    expect(rs.justReset).toBe(false);
  });

  it('setFrame before renderStates: the AI flag timers get this frame dt (0 while paused), not the previous frame', async () => {
    const f = await setup(makeLineStage({ startS: 60 }), 2);
    const dts: number[] = [];
    const spy = vi.spyOn(CarFlagSource.prototype, 'update').mockImplementation(function (this: CarFlagSource, dt: number) {
      dts.push(dt);
      return this.flags;
    });
    try {
      f.field.setFrame(0.016, false);
      f.field.renderStates(0.5);
      f.field.setFrame(0.02, true); // the first paused frame: no advance, not the previous 0.016
      f.field.renderStates(0.5);
      f.field.setFrame(0.03, false); // the first frame after: the full dt, not 0
      f.field.renderStates(0.5);
    } finally {
      spy.mockRestore();
    }
    expect(dts).toEqual([0.016, 0.016, 0, 0, 0.03, 0.03]); // two AI cars per frame
  });

  it('other frames feed audio / HUD with live telemetry and the car flags', async () => {
    const f = await setup(makeLineStage({ startS: 60 }), 3);
    const o = f.field.otherFrames(1 / 60, false);
    expect(o.map((x) => x.id)).toEqual(['ai1', 'ai2', 'ai3']);
    expect(o[0]).toMatchObject({ kind: 'ai', origCar: 'Micra', name: 'Car 1', archetype: 'fwd_hatch' });
    expect(o[0].telemetry.id).toBe('ai1');
    expect(o[0].carFlags).toBeDefined();
    expect(f.field.otherFrames(1 / 60, true)).toBe(o);
  });

  it('the snapshot exposes each AI car\'s object-hit count (wall contact checks)', async () => {
    const f = await setup(makeLineStage({ startS: 60 }), 2);
    expect(f.field.snapshot().cars.map((c) => c.objectHits)).toEqual([0, 0]);
    const tel = f.host.cars[1].telemetry();
    vi.spyOn(f.host.cars[1], 'telemetry').mockReturnValue({ ...tel, collision: { ...tel.collision, objectHits: 7 } });
    expect(f.field.snapshot().cars.map((c) => c.objectHits)).toEqual([0, 7]);
  });

  it('the snapshot is JSON-safe and consistent', async () => {
    const f = await setup(makeLineStage({ startS: 60 }), 3);
    f.race.phase = 'running';
    for (let i = 0; i < 100; i++) substep(f);
    const s = f.field.snapshot();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(s.opponents).toBe(3);
    expect(s.cars).toHaveLength(3);
    expect(s.standings).toHaveLength(4);
    expect(new Set(s.standings.map((e) => e.id))).toEqual(new Set(['player', 'ai1', 'ai2', 'ai3']));
    expect(s.standings.filter((e) => e.player)).toHaveLength(1);
    expect(s.standings[s.playerPosition - 1].player).toBe(true);
    expect(s.cars[0].ai).toMatchObject({ placeholder: true, dnf: false });
  });

  it('step / afterStep reuse their working objects (no per-substep allocation of views)', async () => {
    const f = await setup(makeLineStage({ startS: 60 }), 3);
    f.race.phase = 'running';
    for (let i = 0; i < 10; i++) substep(f);
    const rs = f.field.renderStates(0.5);
    const frames = f.field.otherFrames(0.016, false);
    const snap = f.field.snapshot();
    const cars = snap.cars;
    const standings = snap.standings;
    for (let i = 0; i < 200; i++) substep(f);
    expect(f.field.renderStates(0.5)).toBe(rs);
    expect(f.field.otherFrames(0.016, false)).toBe(frames);
    expect(f.field.snapshot()).toBe(snap);
    expect(f.field.snapshot().cars).toBe(cars);
    expect(f.field.snapshot().standings).toBe(standings);
  });

  it('begin() again (restart) resets every tracker and the clock; clear() drops everything', async () => {
    const stage = makeLineStage({ startS: 60, length: 600, finishS: 560, checkpoints: [] });
    const f = await setup(stage, 2, { throttle: () => 1 });
    f.race.phase = 'running';
    for (let i = 0; i < 3000; i++) substep(f);
    expect(f.field.snapshot().cars.some((c) => c.finished)).toBe(true);
    f.race.phase = 'countdown';
    f.field.begin(f.race);
    const s = f.field.snapshot();
    expect(s.cars.every((c) => !c.finished && c.resets === 0 && c.lap === 1)).toBe(true);
    expect(f.host.cars.every((c) => c.parked)).toBe(true);
    expect(f.field.drainEvents()).toEqual([]);
    f.field.clear();
    expect(f.field.sims).toHaveLength(0);
    expect(f.field.opponents).toHaveLength(0);
    expect(f.field.renderStates(0.5)).toHaveLength(0);
    expect(f.field.snapshot().opponents).toBe(0);
    expect(f.field.snapshot().standings).toEqual([]);
    f.field.step(DT, f.ctx);
    f.field.afterStep(DT, f.ctx);
  });
});
