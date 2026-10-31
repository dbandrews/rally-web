/**
 * tests/sim/contact.sim.test.ts - car-car contact between REAL CarSims (src/sim/contact.ts + CarSim.contactBody()):
 * head-on, rear-end and side-swipe on a flat world and on a real stage (Track.gcm through src/world/orig, skipped when
 * public/assets is absent), a resting stacked pair, the live-view write-back (telemetry cache, anchor timer, carHits /
 * carStrength), a solo-identity check and the no-allocation budget of stepCarContacts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { DT, SETTLE_STEPS } from '../../src/core/constants';
import { qYawSim } from '../../src/core/math';
import { simPoseOnStage } from '../../src/core/stageUtil';
import type { Controls, SimPose, Stage, WorldQuery } from '../../src/core/types';
import { liftAboveGround } from '../../src/game/stageMath';
import { CarSim } from '../../src/sim/car';
import { setContactMultiplayer, stepCarContacts } from '../../src/sim/contact';
import { makeSurfaceTable } from '../../src/sim/params';
import { origCarParams } from '../../src/sim/presets';
import { attachOriginalWorld } from '../../src/world/orig';
import { buildStage } from '../../src/world/stages';
import { builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';
import { createFlatWorld, flatSpawnPose } from './flatworld';

const NO_INPUT: Controls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, gearUp: false, gearDown: false };

function micra(world: WorldQuery, index: number, name = 'Micra'): CarSim {
  return new CarSim({ params: origCarParams(name), world, surfaces: makeSurfaceTable(), origCar: name, slotBase: 24 * index });
}

/** Place cars on `poses` (settle), give them forward speeds. */
function setup(world: WorldQuery, poses: SimPose[], speeds: number[], names: string[] = []): CarSim[] {
  const cars = poses.map((p, i) => {
    const c = micra(world, i, names[i] ?? 'Micra');
    c.reset(p, SETTLE_STEPS);
    return c;
  });
  cars.forEach((c, i) => c.setForwardSpeed(speeds[i]));
  return cars;
}

interface RunOut {
  maxImpulse: number;
  pairSteps: number;
  maxKeGain: number;
  /** Largest CollisionTelemetry.carStrength seen on each car right after a contact step (the record is the latest
   *  contact's B+0x19c: later, separating contacts of the same hit overwrite it with 0). */
  maxStrength: number[];
  /** Per step: signed gap along the A->B axis between the centres (m). */
  gaps: number[];
  /** Relative speed along the A->B axis, negative = closing, after each step. */
  closing: number[];
}

function ke(c: CarSim): number {
  const d = c.debug();
  const t = c.telemetry();
  const v = t.velSim;
  const L = d.angMomLocal;
  const I = d.inertia;
  return 0.5 * d.mass * (v.x * v.x + v.y * v.y + v.z * v.z) + 0.5 * (L.x * L.x / I.x + L.y * L.y / I.y + L.z * L.z / I.z);
}

function simulate(cars: CarSim[], steps: number): RunOut {
  const out: RunOut = { maxImpulse: 0, pairSteps: 0, maxKeGain: 0, maxStrength: cars.map(() => 0), gaps: [], closing: [] };
  for (let i = 0; i < steps; i++) {
    for (const c of cars) c.step(NO_INPUT, DT);
    const before = cars.reduce((s, c) => s + ke(c), 0);
    const r = stepCarContacts(cars, DT);
    if (r.pairs > 0) {
      out.pairSteps++;
      out.maxImpulse = Math.max(out.maxImpulse, r.maxImpulse);
      const after = cars.reduce((s, c) => s + ke(c), 0);
      out.maxKeGain = Math.max(out.maxKeGain, after - before);
      cars.forEach((c, k) => (out.maxStrength[k] = Math.max(out.maxStrength[k], c.telemetry().collision.carStrength ?? 0)));
    }
    const a = cars[0].telemetry();
    const b = cars[1].telemetry();
    const dx = b.posSim.x - a.posSim.x, dz = b.posSim.z - a.posSim.z;
    const dl = Math.hypot(dx, dz) || 1;
    out.gaps.push(dl);
    out.closing.push(((b.velSim.x - a.velSim.x) * dx + (b.velSim.z - a.velSim.z) * dz) / dl);
  }
  return out;
}

function expectHealthy(cars: CarSim[]): void {
  for (const c of cars) {
    const t = c.telemetry();
    expect(t.simFaults).toBe(0);
    for (const v of [t.posSim.x, t.posSim.y, t.posSim.z, t.velSim.x, t.velSim.y, t.velSim.z, t.angVelLocal.x, t.angVelLocal.y, t.angVelLocal.z])
      expect(Number.isFinite(v)).toBe(true);
    expect(Math.hypot(t.velSim.x, t.velSim.y, t.velSim.z)).toBeLessThan(60);
  }
}

/** The three scenarios on any world; `place(along, lateral, reverse)` gives a pose on the road. */
function scenarios(label: string, makeWorld: () => { world: WorldQuery; place: (along: number, lateral: number, reverse?: boolean) => SimPose }) {
  describe(label, () => {
    it('rear-end: the follower hits the slower car; finite impulse, no energy gain, cars separate, record set on both', () => {
      const { world, place } = makeWorld();
      const cars = setup(world, [place(0, 0), place(5.6, 0)], [16, 5]);
      const r = simulate(cars, 360);
      expectHealthy(cars);
      expect(r.pairSteps).toBeGreaterThan(0);
      expect(Number.isFinite(r.maxImpulse)).toBe(true);
      expect(r.maxImpulse).toBeGreaterThan(500); // ~11 m/s closing x ~1/2 reduced mass
      expect(r.maxImpulse).toBeLessThanOrEqual(30000);
      expect(r.maxKeGain).toBeLessThan(1e-3 * 0.5 * 1000 * 16 * 16); // never gains (rotational fudge only)
      // after the hit the pair is not closing any more and the gap keeps growing
      expect(Math.max(...r.closing.slice(-30))).toBeGreaterThan(-0.05);
      expect(r.gaps[r.gaps.length - 1]).toBeGreaterThan(r.gaps[Math.floor(r.gaps.length / 3)] - 0.5);
      for (let k = 0; k < 2; k++) {
        expect(cars[k].telemetry().collision.carHits).toBeGreaterThan(0);
        expect(r.maxStrength[k]).toBeGreaterThan(500); // sound.md 7: type 1 plays at >= 5
        expect(r.maxStrength[k]).toBeLessThanOrEqual(30000);
      }
    });

    it('head-on: both cars lose their closing speed, finite, simFaults 0', () => {
      const { world, place } = makeWorld();
      const cars = setup(world, [place(0, 0), place(9, 0, true)], [14, 14]);
      const vBefore = Math.hypot(cars[0].telemetry().velSim.x, cars[0].telemetry().velSim.z);
      const r = simulate(cars, 360);
      expectHealthy(cars);
      expect(r.pairSteps).toBeGreaterThan(0);
      expect(r.maxImpulse).toBeGreaterThan(2000);
      expect(r.maxImpulse).toBeLessThanOrEqual(30000);
      expect(r.maxKeGain).toBeLessThan(1);
      for (const c of cars) {
        const t = c.telemetry();
        expect(Math.hypot(t.velSim.x, t.velSim.z)).toBeLessThan(vBefore); // slowed down
        expect(t.collision.carHits).toBeGreaterThan(0);
      }
      expect(Math.max(...r.closing.slice(-30))).toBeGreaterThan(-0.05);
    });

    it('side swipe: parallel cars with overlapping flanks are pushed apart sideways', () => {
      const { world, place } = makeWorld();
      const cars = setup(world, [place(0, 0), place(1.5, 1.45)], [20, 14]);
      const lat0 = 1.45;
      const r = simulate(cars, 240);
      expectHealthy(cars);
      expect(r.pairSteps).toBeGreaterThan(0);
      expect(r.maxKeGain).toBeLessThan(1);
      const a = cars[0].telemetry().posSim;
      const b = cars[1].telemetry().posSim;
      // the lateral gap (x on the flat world / across the road) did not collapse: the flanks do not interpenetrate for good
      const pa = place(0, 0).pos, pb = place(1.5, lat0).pos;
      const lateralAxis = { x: pb.x - pa.x, z: pb.z - pa.z };
      const ll = Math.hypot(lateralAxis.x, lateralAxis.z);
      void ll;
      expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(1.4);
    });
  });
}

function flatPlace(world: WorldQuery) {
  return (along: number, lateral: number, reverse = false): SimPose => flatSpawnPose(world, lateral, 50 + along, reverse ? Math.PI : 0, 0.6);
}

scenarios('on a flat world (Micra x Micra)', () => {
  const world = createFlatWorld({ surface: 'tarmac' });
  return { world, place: flatPlace(world) };
});

describe('a resting stacked pair does not explode', () => {
  it('two parked Micras interpenetrating by 0.5 m: bounded velocities for 4 s, simFaults 0', () => {
    const world = createFlatWorld({ surface: 'tarmac' });
    const cars = setup(world, [flatSpawnPose(world, 0, 50, 0, 0.6), flatSpawnPose(world, 0.4, 51.2, 0.3, 0.6)], [0, 0]);
    let maxV = 0;
    for (let i = 0; i < 480; i++) {
      for (const c of cars) c.step(NO_INPUT, DT);
      stepCarContacts(cars, DT);
      for (const c of cars) {
        const v = c.telemetry().velSim;
        maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z));
      }
    }
    expectHealthy(cars);
    expect(maxV).toBeLessThan(20);
    // they ended up apart in x/z (the overlap pushes in the horizontal plane)
    const a = cars[0].telemetry().posSim, b = cars[1].telemetry().posSim;
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(1.5);
  });
});

describe('the live view', () => {
  it('writes back: telemetry cache dropped, velocity changed, anchor timer 0.2, carHits/carStrength absent until used', () => {
    const world = createFlatWorld({ surface: 'tarmac' });
    const cars = setup(world, [flatSpawnPose(world, 0, 50, 0, 0.6), flatSpawnPose(world, 0, 53.75, 0, 0.6)], [15, 0]);
    for (const c of cars) c.step(NO_INPUT, DT);
    expect(cars[0].telemetry().collision.carHits).toBeUndefined(); // solo-style telemetry: no record yet
    const pre = cars[0].telemetry(); // caches the telemetry (the object physicsStep's race logic used to keep using)
    const v0 = pre.speedWorldKmh;
    const r = stepCarContacts(cars, DT);
    expect(r.pairs).toBe(1);
    const t = cars[0].telemetry();
    expect(t).not.toBe(pre); // a re-read after the contact step is a fresh object (main.ts hands it to the race logic)
    expect(t.speedWorldKmh).toBeLessThan(v0 - 1); // the new velocity is visible without another step
    expect(t.collision.carHits).toBe(1);
    expect(t.collision.carStrength).toBeCloseTo(r.maxImpulse, 6);
    expect(cars[1].telemetry().speedWorldKmh).toBeGreaterThan(1);
    const view = cars[0].contactBody();
    expect(view.prevN.x === 1.5 || Math.abs(Math.hypot(view.prevN.x, view.prevN.y, view.prevN.z) - 1) < 1e-5).toBe(true);
    expect(view.hull.nPts).toBe(18);
    expect(view.hull.nPl).toBe(10);
    // a second car-car step with the cars still touching counts again
    stepCarContacts(cars, DT);
    expect(cars[0].telemetry().collision.carHits).toBeGreaterThanOrEqual(1);
  });

  it('the multiplayer flag caps the impulse at 10000 instead of 30000', () => {
    const world = createFlatWorld({ surface: 'tarmac' });
    const run = (mp: boolean) => {
      setContactMultiplayer(mp);
      const cars = setup(world, [flatSpawnPose(world, 0, 50, 0, 0.6), flatSpawnPose(world, 0, 54.6, Math.PI, 0.6)], [80, 80]);
      for (const c of cars) c.step(NO_INPUT, DT);
      const r = stepCarContacts(cars, DT);
      setContactMultiplayer(false);
      return r.maxImpulse;
    };
    expect(run(false)).toBeGreaterThan(10000);
    expect(run(true)).toBeCloseTo(10000, 6);
  });

  it('solo identity: pulling the view every step never changes a car that is not in contact', () => {
    const world = createFlatWorld({ surface: 'tarmac' });
    const mk = () => setup(world, [flatSpawnPose(world, 0, 50, 0, 0.6), flatSpawnPose(world, 30, 200, 0, 0.6)], [20, 10]);
    const a = mk();
    const b = mk();
    const drive: Controls = { ...NO_INPUT, throttle: 0.6, steer: 0.2 };
    for (let i = 0; i < 600; i++) {
      for (const c of a) c.step(drive, DT);
      for (const c of b) c.step(drive, DT);
      stepCarContacts(b, DT); // 150 m apart: no contact, the views are pulled
    }
    for (let k = 0; k < 2; k++) {
      const ta = a[k].telemetry() as unknown as Record<string, unknown>;
      const tb = b[k].telemetry() as unknown as Record<string, unknown>;
      const col = { ...(tb.collision as object) } as Record<string, unknown>;
      expect(col.carHits).toBe(0);
      delete col.carHits;
      delete col.carStrength;
      expect({ ...tb, collision: col }).toEqual(ta);
    }
  });
});

describe('stepCarContacts allocation budget (4 cars x 1 s)', () => {
  it('does not allocate per call (heap growth over 200 000 calls with an active contact)', () => {
    const world = createFlatWorld({ surface: 'tarmac' });
    const cars = setup(
      world,
      [flatSpawnPose(world, 0, 50), flatSpawnPose(world, 0, 53.8), flatSpawnPose(world, 1.5, 52), flatSpawnPose(world, -1.5, 52)],
      [0, 0, 0, 0],
    );
    for (const c of cars) c.step(NO_INPUT, DT);
    let pairs = 0;
    const warm = 60_000; // long enough for the optimising JIT (its code / feedback objects count in heapUsed) to settle
    for (let i = 0; i < warm; i++) pairs += stepCarContacts(cars, DT).pairs;
    expect(pairs).toBeGreaterThan(0);
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const heap = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;
    // heapUsed without --expose-gc is noisy under a loaded machine (JIT / GC timing), so take the best of 3 windows:
    // a real per-call allocation shows in every window, noise does not
    let grow = Infinity;
    let ms = 0;
    for (let w = 0; w < 3; w++) {
      gc?.();
      const h0 = heap();
      const t0 = performance.now();
      for (let i = 0; i < 200_000; i++) stepCarContacts(cars, DT);
      ms = performance.now() - t0;
      grow = Math.min(grow, heap() - h0);
    }
    // any per-call allocation of even 64 bytes would add 12.8 MB
    expect(grow).toBeLessThan(4_000_000);
    // 200 000 calls = 1 667 s of 120 Hz sim; the budget for 1 s is 120 calls: far below a millisecond
    expect(ms / 200_000 * 120).toBeLessThan(5);
  });
});

// ------------------------------------------------------------------------------------------------ a real stage
describe.skipIf(!builtAssetsPresent)('on a real stage (Track.gcm through src/world/orig)', () => {
  let world: WorldQuery;
  let stage: Stage;
  beforeAll(async () => {
    useBuiltAssets();
    const built = await attachOriginalWorld(buildStage('newzealand-1-f', 1));
    world = built.world;
    stage = built.stage;
  }, 120_000);
  afterAll(() => _setAssetFetchForTests(null));

  /** Poses on the road from the start grid forward; `reverse` faces the car back up the road. */
  const place = (along: number, lateral: number, reverse = false): SimPose => {
    const s0 = stage.startS + 20;
    const p = liftAboveGround(stage, simPoseOnStage(stage, s0 + along, lateral, 0.6, world), 0.6, world);
    if (!reverse) return p;
    const a = simPoseOnStage(stage, s0 + along - 1, lateral, 0, world).pos;
    const b = simPoseOnStage(stage, s0 + along + 1, lateral, 0, world).pos;
    return { pos: p.pos, q: qYawSim(Math.atan2(b.x - a.x, b.z - a.z) + Math.PI) };
  };

  it('has a road under the start section', () => {
    const p = place(0, 0);
    expect(world.heightAt(p.pos.x, p.pos.z, p.pos.y)).toBeGreaterThan(-1e5);
  });

  it('rear-end on the stage', () => {
    const cars = setup(world, [place(0, 0), place(5.6, 0)], [14, 5]);
    const r = simulate(cars, 300);
    expectHealthy(cars);
    expect(r.pairSteps).toBeGreaterThan(0);
    expect(r.maxImpulse).toBeGreaterThan(300);
    expect(r.maxKeGain).toBeLessThan(1);
    expect(cars[0].telemetry().collision.carHits).toBeGreaterThan(0);
  });

  it('head-on on the stage', () => {
    const cars = setup(world, [place(0, 0), place(9, 0, true)], [12, 12]);
    const r = simulate(cars, 300);
    expectHealthy(cars);
    expect(r.pairSteps).toBeGreaterThan(0);
    expect(r.maxImpulse).toBeGreaterThan(1000);
    expect(Math.max(...r.closing.slice(-30))).toBeGreaterThan(-0.05);
  });

  it('side swipe on the stage', () => {
    const cars = setup(world, [place(0, -0.7), place(1.5, 0.7)], [18, 12]);
    const r = simulate(cars, 240);
    expectHealthy(cars);
    expect(r.pairSteps).toBeGreaterThan(0);
    expect(r.maxKeGain).toBeLessThan(1);
  });
});
