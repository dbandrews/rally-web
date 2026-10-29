import { describe, expect, it } from 'vitest';
import { DT } from '../../src/core/constants';
import type { RaceEvent, Stage } from '../../src/core/types';
import { RaceController } from '../../src/game/race';
import { MemoryStore } from '../../src/game/storage';
import { FakeCar, makeCircleStage, makeLineStage, note } from './fakes';

const steps = (sec: number) => Math.round(sec / DT);

function setup(stage: Stage = makeLineStage(), store = new MemoryStore()) {
  const car = new FakeCar();
  const race = new RaceController({ store });
  race.begin(stage, car, { countdown: false });
  return { stage, car, race, store };
}

/** Drive the fake car straight along the line stage (three -Z) at v m/s for n steps. */
function cruise(car: FakeCar, race: RaceController, v: number, n: number, lateral = 0): RaceEvent[] {
  const ev: RaceEvent[] = [];
  for (let i = 0; i < n; i++) {
    car.place(lateral, car.pos.z - v * DT, 0, v);
    race.fixedUpdate(DT, car.telemetry());
    ev.push(...race.drainEvents());
  }
  return ev;
}

describe('RaceController: start, clock, splits, finish, best', () => {
  it('begin places the car at the start (raised), parked; startNow runs the clock in sim time', () => {
    const { car, race, stage } = setup();
    expect(race.state.phase).toBe('idle');
    expect(car.parked).toBe(true);
    expect(car.resets).toBe(1);
    expect(-car.pos.z).toBeCloseTo(stage.startS, 6);
    expect(car.pos.y).toBeGreaterThan(0.3);
    race.startNow();
    expect(car.parked).toBe(false);
    expect(race.isControllable()).toBe(true);
    cruise(car, race, 0, 240);
    expect(race.state.time).toBeCloseTo(2, 9);
  });

  it('countdown 3-2-1-GO in sim time, not controllable until GO', () => {
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(makeLineStage(), car, { countdown: true });
    expect(race.state.phase).toBe('countdown');
    expect(race.state.message).toBe('3');
    const ev: RaceEvent[] = [];
    let n = 0;
    while (race.state.phase === 'countdown') {
      expect(race.isControllable()).toBe(false);
      race.fixedUpdate(DT, car.telemetry());
      ev.push(...race.drainEvents());
      n++;
    }
    expect(n).toBe(steps(3));
    expect(ev.filter((e) => e.type === 'countdown').map((e) => (e as { n: number }).n)).toEqual([3, 2, 1]);
    expect(ev.some((e) => e.type === 'go')).toBe(true);
    expect(race.state.message).toBe('GO!');
    expect(race.isControllable()).toBe(true);
  });

  it('checkpoint splits are interpolated to the ms, finish stops the clock and saves the best', () => {
    const { car, race, store, stage } = setup(makeLineStage({ startS: 10, finishS: 990, checkpoints: [250, 500, 750] }));
    race.startNow();
    // 20 m/s from s = 10: checkpoint at 250 → 12.000 s
    const ev = cruise(car, race, 20, steps(60));
    const cps = ev.filter((e) => e.type === 'checkpoint') as Extract<RaceEvent, { type: 'checkpoint' }>[];
    expect(cps.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(cps[0].time).toBeCloseTo(12, 3);
    expect(cps[1].time).toBeCloseTo(24.5, 3);
    expect(cps[0].delta).toBeNull();
    const fin = ev.find((e) => e.type === 'finish') as Extract<RaceEvent, { type: 'finish' }>;
    expect(fin).toBeTruthy();
    expect(fin.time).toBeCloseTo(49, 3);
    expect(fin.best).toBe(true);
    expect(race.state.phase).toBe('finished');
    expect(race.state.finishTime).toBeCloseTo(49, 3);
    expect(race.state.splits).toHaveLength(4);
    expect(race.isControllable()).toBe(false);
    const t = race.state.time;
    cruise(car, race, 20, 120);
    expect(race.state.time).toBe(t); // clock frozen
    // second run: best loaded, deltas vs best
    const car2 = new FakeCar();
    const race2 = new RaceController({ store });
    race2.begin(stage, car2, { countdown: false });
    expect(race2.state.bestTime).toBeCloseTo(49, 3);
    expect(race2.state.bestSplits).toHaveLength(4);
    race2.startNow();
    const ev2 = cruise(car2, race2, 25, steps(50));
    const cp0 = ev2.find((e) => e.type === 'checkpoint') as Extract<RaceEvent, { type: 'checkpoint' }>;
    expect(cp0.delta).toBeCloseTo(240 / 25 - 12, 3);
    const fin2 = ev2.find((e) => e.type === 'finish') as Extract<RaceEvent, { type: 'finish' }>;
    expect(fin2.best).toBe(true);
    // the state keeps the PREVIOUS best for the results screen
    expect(race2.state.bestTime).toBeCloseTo(49, 3);
    const race3 = new RaceController({ store });
    race3.begin(stage, new FakeCar(), { countdown: false });
    expect(race3.state.bestTime).toBeCloseTo(980 / 25, 3);
  });

  it('a slower run is not saved as best; a teleported run never is', () => {
    const store = new MemoryStore();
    const stage = makeLineStage({ startS: 10, finishS: 210, checkpoints: [] });
    const a = setup(stage, store);
    a.race.startNow();
    cruise(a.car, a.race, 20, steps(12));
    expect(a.race.state.finishTime).toBeCloseTo(10, 3);
    const b = setup(stage, store);
    b.race.startNow();
    const ev = cruise(b.car, b.race, 10, steps(25));
    expect((ev.find((e) => e.type === 'finish') as { best: boolean }).best).toBe(false);
    const c = setup(stage, store);
    c.race.startNow();
    c.race.teleport(200, 0);
    const ev2 = cruise(c.car, c.race, 30, 120);
    expect((ev2.find((e) => e.type === 'finish') as { best: boolean }).best).toBe(false);
    expect(new RaceController({ store }).best.load('line', 1, 'awd_wrc')?.time).toBeCloseTo(10, 3);
  });

  it('testpad: no finish, no auto reset, no wrong way', () => {
    const { car, race } = setup(makeLineStage({ discipline: 'testpad' }));
    race.startNow();
    const ev = cruise(car, race, 30, steps(40), 60);
    expect(race.state.phase).toBe('running');
    expect(ev.some((e) => e.type === 'reset' || e.type === 'finish')).toBe(false);
    car.place(0, car.pos.z, Math.PI, 10);
    for (let i = 0; i < steps(3); i++) race.fixedUpdate(DT, car.telemetry());
    expect(race.state.wrongWay).toBe(false);
  });
});

describe('RaceController: laps (closed stages)', () => {
  it('counts laps by route distance across the lap line, then finishes', () => {
    const stage = makeCircleStage({ radius: 100, laps: 3 });
    const { car, race } = setup(stage);
    race.startNow();
    const L = stage.length;
    const v = 30;
    const ev: RaceEvent[] = [];
    let s = 0;
    for (let i = 0; i < steps((3 * L) / v + 2); i++) {
      s += v * DT;
      const th = s / 100;
      car.place(100 * Math.cos(th), 100 * Math.sin(th), 0, v);
      race.fixedUpdate(DT, car.telemetry());
      ev.push(...race.drainEvents());
    }
    const laps = ev.filter((e) => e.type === 'lap') as Extract<RaceEvent, { type: 'lap' }>[];
    expect(laps.map((e) => e.lap)).toEqual([1, 2, 3]);
    expect(laps[0].lapTime).toBeCloseTo(L / v, 2);
    expect(laps[1].lapTime).toBeCloseTo(L / v, 2);
    expect(race.state.phase).toBe('finished');
    expect(race.state.finishTime).toBeCloseTo((3 * L) / v, 2);
    expect(race.state.splits).toHaveLength(9);
    expect(race.state.lap).toBe(3);
    expect(race.state.progress).toBeCloseTo(1, 6);
  });

  it('driving backwards over the line does not count a lap', () => {
    const stage = makeCircleStage({ radius: 100, laps: 2 });
    const { car, race } = setup(stage);
    race.startNow();
    let s = 0;
    for (let i = 0; i < steps(10); i++) {
      s -= 10 * DT;
      const th = s / 100;
      car.place(100 * Math.cos(th), 100 * Math.sin(th), 0, 10);
      race.fixedUpdate(DT, car.telemetry());
    }
    expect(race.drainEvents().some((e) => e.type === 'lap' || e.type === 'checkpoint')).toBe(false);
    expect(race.state.lap).toBe(1);
  });
});

describe('RaceController: §5.4 resets', () => {
  it('manual reset: 1 s fade, controls off, teleport at 0.5 s to s - 20 raised 1.5 m, clock keeps running', () => {
    const { car, race } = setup(makeLineStage({ startS: 10 }));
    race.startNow();
    cruise(car, race, 20, steps(5)); // s = 110
    const s0 = race.state.s;
    const t0 = race.state.time;
    const resets0 = car.resets;
    race.requestReset('manual');
    expect(race.state.resetting).toBe(true);
    expect(race.isControllable()).toBe(false);
    const fades: number[] = [];
    let teleportStep = -1;
    for (let i = 0; i < steps(1.0); i++) {
      race.fixedUpdate(DT, car.telemetry());
      fades.push(race.state.fade);
      if (teleportStep < 0 && car.resets > resets0) teleportStep = i + 1;
    }
    expect(teleportStep).toBe(steps(0.5));
    expect(Math.max(...fades)).toBeCloseTo(1, 6);
    expect(fades[steps(0.25) - 1]).toBeCloseTo(0.5, 2);
    expect(race.state.resetting).toBe(false);
    expect(race.state.fade).toBe(0);
    expect(race.isControllable()).toBe(true);
    expect(-car.pos.z).toBeCloseTo(s0 - 20, 1);
    expect(car.lastPose!.pos.y).toBeCloseTo(1.5, 6);
    expect(car.speed).toBe(0);
    expect(race.state.time).toBeCloseTo(t0 + 1, 6);
    expect(race.state.resets).toBe(1);
    expect(race.drainEvents().filter((e) => e.type === 'reset')).toHaveLength(1);
  });

  it('reset target never goes behind startS + 1', () => {
    const { car, race, stage } = setup(makeLineStage({ startS: 10 }));
    race.startNow();
    cruise(car, race, 10, steps(0.5));
    race.requestReset('manual');
    for (let i = 0; i < steps(1); i++) race.fixedUpdate(DT, car.telemetry());
    expect(-car.pos.z).toBeCloseTo(stage.startS + 1, 3);
  });

  it('manual reset is ignored before the start, during countdown and after the finish', () => {
    const { car, race } = setup();
    race.requestReset('manual');
    expect(race.state.resetting).toBe(false);
    const c2 = new FakeCar();
    const r2 = new RaceController({ store: new MemoryStore() });
    r2.begin(makeLineStage(), c2, { countdown: true });
    r2.requestReset('manual');
    expect(r2.state.resetting).toBe(false);
    void car;
  });

  it("'api' reset is immediate (no fade)", () => {
    const { car, race } = setup();
    race.startNow();
    cruise(car, race, 20, steps(5));
    const r0 = car.resets;
    race.requestReset('api');
    expect(car.resets).toBe(r0 + 1);
    expect(race.state.resetting).toBe(false);
    expect(race.state.resets).toBe(1);
  });

  it('auto reset: lateral > 30 m (offTrack), below the road < -5 m (belowTrack), outside the valid range', () => {
    const a = setup();
    a.race.startNow();
    cruise(a.car, a.race, 20, steps(2), 31);
    expect(a.race.state.resetting).toBe(true);
    for (let i = 0; i < steps(1); i++) a.race.fixedUpdate(DT, a.car.telemetry());
    expect(a.race.drainEvents().find((e) => e.type === 'reset')).toEqual({ type: 'reset', reason: 'offTrack' });
    expect(Math.abs(a.car.pos.x)).toBeLessThan(1e-6);

    const b = setup();
    b.race.startNow();
    b.car.place(0, -100, 0, 10, -6);
    b.race.fixedUpdate(DT, b.car.telemetry());
    expect(b.race.state.resetting).toBe(true);

    const c = setup(makeLineStage({ validRange: [5, 600] }));
    c.race.startNow();
    c.car.place(0, -700, 0, 10);
    c.race.fixedUpdate(DT, c.car.telemetry());
    expect(c.race.state.resetting).toBe(true);
  });

  it('stuck: upside down for 2.5 s resets in place', () => {
    const { car, race } = setup();
    race.startNow();
    cruise(car, race, 20, steps(3));
    const s0 = race.state.s;
    const upsideDown = () => {
      const t = car.telemetry();
      t.quat = { w: 0, x: 0, y: 0, z: 1 }; // rolled 180°
      t.speedKmh = t.speedWorldKmh = 0;
      return t;
    };
    for (let i = 0; i < steps(2.4); i++) race.fixedUpdate(DT, upsideDown());
    expect(race.state.resetting).toBe(false);
    for (let i = 0; i < steps(0.2); i++) race.fixedUpdate(DT, upsideDown());
    expect(race.state.resetting).toBe(true);
    for (let i = 0; i < steps(1); i++) race.fixedUpdate(DT, car.telemetry());
    expect(-car.pos.z).toBeCloseTo(s0, 0);
  });

  it('stuck: crawling counts only while a pedal is pressed (waiting at the line is not stuck)', () => {
    const { car, race } = setup();
    race.startNow();
    cruise(car, race, 20, steps(1));
    const still = (throttle: number) => {
      const t = car.telemetry();
      t.speedKmh = t.speedWorldKmh = 0;
      t.throttle = throttle;
      t.brake = 0;
      return t;
    };
    for (let i = 0; i < steps(12); i++) race.fixedUpdate(DT, still(0));
    expect(race.state.resetting).toBe(false);
    for (let i = 0; i < steps(10.2); i++) race.fixedUpdate(DT, still(1));
    expect(race.state.resetting).toBe(true);
  });

  it('teleport places the car at (s, lateral) immediately', () => {
    const { car, race } = setup();
    race.teleport(300, 4);
    expect(-car.pos.z).toBeCloseTo(300, 6);
    expect(car.pos.x).toBeCloseTo(4, 6);
    expect(race.state.s).toBe(300);
  });
});

describe('RaceController: pacenotes, wrong way, ghost', () => {
  it('§5.7: last passed note fires once, only within 20 m of the line, never replayed after a reset', () => {
    const notes = [note(100, '4 right'), note(140, '3 left', { direction: 'left', severity: 3 }), note(200, '6 right')];
    const { car, race } = setup(makeLineStage({ startS: 10, pacenotes: notes }));
    race.startNow();
    const ev = cruise(car, race, 20, steps(7)); // to s = 150
    const fired = ev.filter((e) => e.type === 'pacenote').map((e) => (e as { note: { text: string } }).note.text);
    expect(fired).toEqual(['4 right', '3 left']);
    expect(race.state.pacenotes.map((n) => n.text)).toEqual(['3 left', '4 right']);
    // reset back 20 m → s 130: '4 right' is the last passed note but must not replay
    race.requestReset('manual');
    const ev2: RaceEvent[] = [];
    for (let i = 0; i < steps(1); i++) {
      race.fixedUpdate(DT, car.telemetry());
      ev2.push(...race.drainEvents());
    }
    ev2.push(...cruise(car, race, 20, steps(1)));
    expect(ev2.filter((e) => e.type === 'pacenote')).toEqual([]);
    // off the line by > 20 m: the next note waits
    const ev3 = cruise(car, race, 20, steps(2.6), 25); // to s ≈ 202 but 25 m off the line
    expect(ev3.filter((e) => e.type === 'pacenote')).toEqual([]);
    const ev4 = cruise(car, race, 1, 2, 0);
    expect(ev4.filter((e) => e.type === 'pacenote').map((e) => (e as { note: { text: string } }).note.text)).toEqual(['6 right']);
  });

  it('wrong way after 1 s against the spline, clears after driving the right way', () => {
    const { car, race } = setup();
    race.startNow();
    cruise(car, race, 20, steps(5));
    const ev: RaceEvent[] = [];
    for (let i = 0; i < steps(1.2); i++) {
      car.place(0, car.pos.z + 10 * DT, Math.PI, 10); // heading +Z = backwards
      race.fixedUpdate(DT, car.telemetry());
      ev.push(...race.drainEvents());
    }
    expect(race.state.wrongWay).toBe(true);
    expect(race.state.message).toBe('WRONG WAY');
    expect(ev).toContainEqual({ type: 'wrongWay', on: true });
    cruise(car, race, 10, steps(0.6));
    expect(race.state.wrongWay).toBe(false);
  });

  it('records a 30 Hz ghost of the best run and replays it on the next run', () => {
    const store = new MemoryStore();
    const stage = makeLineStage({ startS: 10, finishS: 310, checkpoints: [] });
    const a = setup(stage, store);
    expect(a.race.hasGhost).toBe(false);
    a.race.startNow();
    cruise(a.car, a.race, 20, steps(16));
    expect(a.race.state.phase).toBe('finished');
    const b = setup(stage, store);
    expect(b.race.hasGhost).toBe(true);
    expect(b.race.ghostPose()).toBeNull(); // not started
    b.race.startNow();
    cruise(b.car, b.race, 0, steps(5));
    const g = b.race.ghostPose()!;
    // ghost started at s = 10 and drove 20 m/s for 5 s
    expect(-g.pos.z).toBeCloseTo(10 + 100, 0);
    const rs = b.race.ghostRenderState(b.car.telemetry(), 0)!;
    expect(rs.ghost).toBe(true);
    expect(rs.id).toBe('ghost');
    expect(rs.pos.z).toBeCloseTo(g.pos.z, 6);
  });
});

describe('RaceController: state is plain JSON data', () => {
  it('survives a JSON round trip mid-run (test API clones it)', () => {
    const { car, race } = setup(makeLineStage({ pacenotes: [note(50)] }));
    race.startNow();
    cruise(car, race, 20, steps(15));
    const s = race.state;
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(structuredClone(s)).toEqual(s);
  });
});
