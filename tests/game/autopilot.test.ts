import { describe, expect, it } from 'vitest';
import { DT } from '../../src/core/constants';
import { Autopilot } from '../../src/game/autopilot';
import { pursuitAngle, pursuitSteer, SpeedProfile, steerLock } from '../../src/game/driving';
import { RaceController } from '../../src/game/race';
import { curvatureAt, forwardOfThree, heightfieldAt, rightOfQuat, upYOfQuat } from '../../src/game/stageMath';
import { MemoryStore } from '../../src/game/storage';
import { FakeCar, makeCircleStage, makeLineStage } from './fakes';

describe('steering math', () => {
  it('§2.1 lock: 0.40 rad at speed, +0.005 rad per km/h below 40', () => {
    expect(steerLock(100)).toBeCloseTo(0.4, 9);
    expect(steerLock(0)).toBeCloseTo(0.6, 9);
    expect(steerLock(20)).toBeCloseTo(0.5, 9);
  });

  it('pure pursuit: target right → positive angle, straight ahead → 0, behind → full lock to its side', () => {
    expect(pursuitAngle(0, 20, 2.5)).toBe(0);
    expect(pursuitAngle(2, 20, 2.5)).toBeGreaterThan(0);
    expect(pursuitAngle(-2, 20, 2.5)).toBeLessThan(0);
    // arc through (x, z): k = 2x / (x² + z²)
    expect(pursuitAngle(5, 10, 2.5)).toBeCloseTo(Math.atan((2 * 5 * 2.5) / 125), 9);
    expect(pursuitAngle(1, -5, 2.5)).toBeCloseTo(Math.PI / 2, 9);
    expect(pursuitSteer(-1, -5, 100)).toBe(-1);
    expect(Math.abs(pursuitSteer(0.5, 30, 100))).toBeLessThan(0.1);
  });

  it('car-frame helpers agree with the THREE convention (forward -Z, yaw right = -rotation about +Y)', () => {
    const h = 0.3;
    const q = { w: Math.cos(-h / 2), x: 0, y: Math.sin(-h / 2), z: 0 };
    const f = forwardOfThree(q);
    expect(f.x).toBeCloseTo(Math.sin(h), 9);
    expect(f.z).toBeCloseTo(-Math.cos(h), 9);
    const r = rightOfQuat(q);
    expect(r.x).toBeCloseTo(Math.cos(h), 9);
    expect(r.z).toBeCloseTo(Math.sin(h), 9);
    expect(upYOfQuat(q)).toBeCloseTo(1, 9);
    expect(upYOfQuat({ w: 0, x: 1, y: 0, z: 0 })).toBeCloseTo(-1, 9);
  });

  it('curvature and heightfield helpers', () => {
    const c = makeCircleStage({ radius: 50 });
    expect(curvatureAt(c, 100)).toBeCloseTo(1 / 50, 3);
    expect(curvatureAt(makeLineStage(), 300)).toBeCloseTo(0, 9);
    const hf = { originX: 0, originZ: 0, cellSize: 10, nx: 2, nz: 2, heights: new Float32Array([0, 10, 0, 10]), materials: new Uint8Array(4) };
    expect(heightfieldAt(hf, 5, 5)).toBeCloseTo(5, 6);
    expect(Number.isNaN(heightfieldAt(hf, -1, 5))).toBe(true);
  });
});

describe('speed profile', () => {
  it('corner speed = sqrt(grip·g / κ), straights capped, braking zone before a bend', () => {
    const c = makeCircleStage({ radius: 60 });
    const p = new SpeedProfile(c, { gripScale: 1, vMax: 80 });
    // tarmac grip 1.05 g on R 60
    expect(p.at(100)).toBeCloseTo(Math.sqrt((1.05 * 9.81) / (1 / 60)), 0);
    const line = new SpeedProfile(makeLineStage({ surface: 'tarmac' }), { vMax: 50 });
    expect(line.at(500)).toBeCloseTo(50, 3);
    expect(line.minAhead(100, 50)).toBeCloseTo(50, 3);
  });
});

describe('Autopilot', () => {
  it('steers toward the line and accelerates on a straight; returns valid controls', () => {
    const stage = makeLineStage({ length: 2000, finishS: 1990, checkpoints: [] });
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    car.place(3, car.pos.z, 0, 15); // 3 m right of the line, facing along it
    race.fixedUpdate(DT, car.telemetry());
    const ap = new Autopilot();
    const c = ap.update(DT, car.telemetry(), stage, race.state);
    expect(c.steer).toBeLessThan(0); // line is to the left
    expect(c.throttle).toBeGreaterThan(0.3);
    expect(c.brake).toBe(0);
    for (let i = 0; i < 120 * 20; i++) {
      const k = ap.update(DT, car.telemetry(), stage, race.state);
      expect(k.steer).toBeGreaterThanOrEqual(-1);
      expect(k.steer).toBeLessThanOrEqual(1);
      expect(k.throttle).toBeGreaterThanOrEqual(0);
      expect(k.throttle).toBeLessThanOrEqual(1);
      car.step(k, DT);
      race.fixedUpdate(DT, car.telemetry());
    }
    expect(Math.abs(race.state.lateral)).toBeLessThan(0.5);
    expect(race.state.s).toBeGreaterThan(800);
  });

  it('follows a circle (closed stage) and keeps close to the line', () => {
    const stage = makeCircleStage({ radius: 80, laps: 1 });
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    const ap = new Autopilot();
    let maxLat = 0;
    for (let i = 0; i < 120 * 30 && race.state.phase === 'running'; i++) {
      const k = ap.update(DT, car.telemetry(), stage, race.state);
      car.step(k, DT);
      race.fixedUpdate(DT, car.telemetry());
      if (i > 240) maxLat = Math.max(maxLat, Math.abs(race.state.lateral));
    }
    expect(race.state.phase).toBe('finished');
    expect(maxLat).toBeLessThan(3);
  });

  it('brakes when far too fast for the bend ahead', () => {
    const stage = makeCircleStage({ radius: 30 });
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    car.speed = 40;
    const ap = new Autopilot();
    const c = ap.update(DT, car.telemetry(), stage, race.state);
    expect(c.brake).toBeGreaterThan(0.5);
    expect(c.throttle).toBe(0);
  });

  it('gets unstuck: reverses with opposite lock, then drives on', () => {
    const stage = makeLineStage({ length: 2000, finishS: 1990, checkpoints: [] });
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore(), stuckReset: false });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    const ap = new Autopilot();
    let reversed = false;
    for (let i = 0; i < 120 * 4; i++) {
      // a wall: the car cannot move
      const k = ap.update(DT, car.telemetry(), stage, race.state);
      race.fixedUpdate(DT, car.telemetry());
      if (ap.debug.mode === 'reverse') {
        reversed = true;
        expect(k.brake).toBeGreaterThan(0.3); // auto box: held brake selects reverse
        expect(k.throttle).toBe(0);
        break;
      }
    }
    expect(reversed).toBe(true);
  });

  it('manual gearbox: shifts up near the limiter', () => {
    const stage = makeLineStage({ length: 2000 });
    const car = new FakeCar();
    car.transmission = 'manual';
    car.rpm = 7800;
    car.gear = 2;
    car.speed = 20;
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    car.speed = 20;
    const ap = new Autopilot();
    const c = ap.update(DT, car.telemetry(), stage, race.state);
    expect(c.gearUp).toBe(true);
    const c2 = ap.update(DT, car.telemetry(), stage, race.state);
    expect(c2.gearUp).toBe(false); // one-substep edge + cooldown
  });
});

describe('autopilot obstacle avoidance (optional world)', () => {
  it('steers round a colliding object on the centre line and back to the line after it', () => {
    const stage = makeLineStage({ startS: 10, width: 10 });
    // a 1.5 m object on the centre line at s = 60 (sim z = +60: three z = -60)
    const obstacle = { kind: 'tent', pos: { x: 0, y: 0, z: 60 }, radius: 1.5, height: 3 };
    const world = {
      obstaclesNear: (p: { x: number; z: number }, r: number, out: unknown[] = []) => {
        out.length = 0;
        if (Math.hypot(p.x - obstacle.pos.x, p.z - obstacle.pos.z) < r + obstacle.radius) out.push(obstacle);
        return out;
      },
    } as unknown as import('../../src/core/types').WorldQuery;
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    const ap = new Autopilot();
    ap.world = world;
    let minGap = Infinity;
    for (let i = 0; i < Math.round(12 / DT); i++) {
      const c = ap.update(DT, car.telemetry(), stage, race.state);
      car.step(c, DT);
      race.fixedUpdate(DT, car.telemetry());
      minGap = Math.min(minGap, Math.hypot(car.pos.x - 0, -car.pos.z - 60));
    }
    expect(race.state.s).toBeGreaterThan(120);
    expect(minGap).toBeGreaterThan(1.5 + 0.8);
    expect(Math.abs(car.pos.x)).toBeLessThan(1.5); // back near the centre line
    // without the world it drives straight through the object's place
    const car2 = new FakeCar();
    const race2 = new RaceController({ store: new MemoryStore() });
    race2.begin(stage, car2, { countdown: false });
    race2.startNow();
    const ap2 = new Autopilot();
    let minGap2 = Infinity;
    for (let i = 0; i < Math.round(12 / DT); i++) {
      car2.step(ap2.update(DT, car2.telemetry(), stage, race2.state), DT);
      race2.fixedUpdate(DT, car2.telemetry());
      minGap2 = Math.min(minGap2, Math.hypot(car2.pos.x, -car2.pos.z - 60));
    }
    expect(minGap2).toBeLessThan(0.5);
  });
});
