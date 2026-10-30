/**
 * tests/sim/car.test.ts — OWNED BY THE SIM BUILDER.
 *
 * Unit tests of src/sim beyond the §7 feel tests: §3/§4 parameter tables, derived values (§2.5.4, §2.2,
 * §2.3.6, §2.6.1), live tuning (§6: setParams rebuilds, live surface table), setup options (§5.5), DEV
 * toggles (§0.3), sleep / hill-hold (§2.10, §2.3.5), chassis + obstacle collisions (§2.9), flip assist
 * (§2.6 W19), damage hook (§5.6), NaN guard, telemetry contract details and the per-step time budget.
 */
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_IDS, DT, MATERIAL, SURFACE_IDS } from '../../src/core/constants';
import { normalize, qFromAxisAngle } from '../../src/core/math';
import type { Obstacle, SurfaceId, TyreType } from '../../src/core/types';
import { CarSim } from '../../src/sim/car';
import { ARCHETYPE_PARAMS, DEFAULT_SURFACE_TABLE, makeCarParams, makeSurfaceTable, muKinetic, muStatic } from '../../src/sim/params';
import { buildLoadTable, LOAD_TABLE_SHIPPED, torqueCurveAt, tyreForce } from '../../src/sim/tables';
import { jsonSafetyIssue } from '../helpers/json';
import { createFlatWorld, flatSpawnPose } from './flatworld';
import { ctl, makeCar, reachSpeed, run, t3Brake } from './harness';
import { createProfileWorld, flatProfile } from './profileworld';

const inRange = (x: number, lo: number, hi: number) => {
  expect(x, `${x} ≥ ${lo}`).toBeGreaterThanOrEqual(lo);
  expect(x, `${x} ≤ ${hi}`).toBeLessThanOrEqual(hi);
};

// =====================================================================================================
describe('§3 / §4 parameter tables', () => {
  it('§3.2 archetype values', () => {
    const a = ARCHETYPE_PARAMS.awd_wrc;
    const f = ARCHETYPE_PARAMS.fwd_hatch;
    const r = ARCHETYPE_PARAMS.rwd_classic;
    expect([a.mass, f.mass, r.mass]).toEqual([1230, 960, 1010]);
    expect([a.torqueScale, f.torqueScale, r.torqueScale]).toEqual([935, 930, 1350]);
    expect([a.wheelDrive, f.wheelDrive, r.wheelDrive]).toEqual([2, 0, 1]);
    expect([a.nGears, f.nGears, r.nGears]).toEqual([6, 6, 5]);
    expect(a.gearRatio).toEqual([-3.3, 3.35, 2.15, 1.55, 1.22, 0.97, 0.84]);
    expect(f.gearRatio).toEqual(a.gearRatio);
    expect(r.gearRatio).toEqual([-3.3, 3.42, 2.15, 1.52, 1.17, 0.75]);
    expect(a.wheelFL).toEqual({ x: -0.755, y: 0.53, z: 1.21 });
    expect(a.wheelRL).toEqual({ x: -0.76, y: 0.53, z: -1.32 });
    expect(f.wheelFL).toEqual({ x: -0.765, y: 0.57, z: 1.235 });
    expect(f.wheelRL).toEqual({ x: -0.765, y: 0.57, z: -1.31 });
    expect(r.wheelFL).toEqual({ x: -0.655, y: 0.48, z: 1.26 });
    expect(r.wheelRL).toEqual({ x: -0.73, y: 0.48, z: -1.19 });
    expect([a.hullFrontZ, a.hullRearZ, f.hullFrontZ, f.hullRearZ, r.hullFrontZ, r.hullRearZ]).toEqual([2.07, -2.3, 1.95, -2.05, 1.8, -1.9]);
    for (const p of [a, f, r]) {
      expect(p.turboSize).toBe(1);
      expect(p.gravity).toBe(12);
      expect(p.wheel.front.rollStiffness).toBe(14200);
      expect(p.wheel.rear.rollStiffness).toBe(15000);
      expect([p.wheel.front.staticSlipAngleFast, p.wheel.rear.staticSlipAngleFast]).toEqual([0.12, 0.06]);
      expect([p.wheel.front.staticSlipAngleSlow, p.wheel.rear.staticSlipAngleSlow]).toEqual([0.08, 0.1]);
      expect(p.wheel.front.wheelInertia).toBe(0.050027); // INVERSE inertia, not "fixed"
    }
  });

  // §4.3 table: static / kinetic μ per tyre type
  const MU: Record<SurfaceId, [number, number][]> = {
    tarmac: [[2.407, 2.061], [2.266, 1.903], [2.126, 1.701], [1.902, 1.522], [1.79, 1.432]],
    gravel: [[1.55, 1.24], [1.71, 1.368], [1.775, 1.42], [1.35, 1.08], [1.305, 1.044]],
    gravelDeep: [[1.55, 1.24], [1.55, 1.24], [1.55, 1.24], [1.55, 1.24], [1.55, 1.24]],
    mud: [[1.15, 0.92], [1.28, 1.024], [1.38, 1.104], [1.25, 1.0], [1.407, 1.126]],
    snow: [[0.34, 0.272], [0.437, 0.349], [0.437, 0.349], [1.31, 1.048], [1.407, 1.125]],
    ice: [[0.095, 0.076], [0.345, 0.276], [0.595, 0.476], [1.195, 0.956], [1.295, 1.036]],
    grass: [[0.808, 0.646], [1.203, 0.962], [1.502, 1.202], [1.35, 1.08], [1.449, 1.159]],
    sand: [[0.899, 0.719], [1.28, 1.024], [1.449, 1.159], [1.35, 1.08], [1.35, 1.08]],
    cobbles: [[1.75, 1.4], [1.75, 1.4], [1.75, 1.4], [1.75, 1.4], [1.75, 1.4]],
    water: [[1.895, 1.622], [1.784, 1.499], [1.674, 1.339], [1.498, 1.198], [1.41, 1.128]],
    // appended original materials (§4.4 rows of PhysicsParam.con through the §4.2 formulas)
    wood: [[1.526, 1.221], [1.6, 1.28], [1.6, 1.28], [1.6, 1.28], [1.6, 1.28]],
    snowChunky: [[0.242, 0.194], [0.339, 0.272], [0.339, 0.272], [1.31, 1.048], [1.504, 1.203]],
    snowDeep: [[0.25, 0.2], [0.35, 0.28], [0.35, 0.28], [1.35, 1.08], [1.55, 1.24]],
    snowAsphalt: [[0.339, 0.272], [0.437, 0.349], [0.437, 0.349], [1.31, 1.048], [1.407, 1.125]],
    snowDitch: [[0.25, 0.2], [0.35, 0.28], [0.35, 0.28], [1.35, 1.08], [1.55, 1.24]],
    leaf: [[1.75, 1.4], [1.7, 1.36], [1.6, 1.28], [1.5, 1.2], [1.4, 1.12]],
    asphaltGrass: [[1.825, 1.46], [1.725, 1.38], [1.7, 1.36], [1.65, 1.32], [1.625, 1.3]],
    gravelGrass: [[1.4, 1.12], [1.45, 1.16], [1.5, 1.2], [1.45, 1.16], [1.4, 1.12]],
    mudGrass: [[1.3, 1.04], [1.35, 1.08], [1.4, 1.12], [1.35, 1.08], [1.3, 1.04]],
    mudDitch: [[1.45, 1.16], [1.45, 1.16], [1.45, 1.16], [1.45, 1.16], [1.45, 1.16]],
    sandDeep: [[1.65, 1.32], [1.65, 1.32], [1.65, 1.32], [1.65, 1.32], [1.65, 1.32]],
    sandDark: [[0.899, 0.719], [1.28, 1.024], [1.449, 1.159], [1.35, 1.08], [1.35, 1.08]],
    sandDarkDeep: [[1.65, 1.32], [1.65, 1.32], [1.65, 1.32], [1.65, 1.32], [1.65, 1.32]],
  };
  it('§4.3 static / kinetic μ for all 23 surfaces × 5 tyre types (±0.002)', () => {
    for (const id of SURFACE_IDS) {
      const def = DEFAULT_SURFACE_TABLE[id];
      expect(def.material).toBe(MATERIAL[id]);
      for (let t = 0; t < 5; t++) {
        expect(Math.abs(muStatic(def, t as TyreType) - MU[id][t][0]), `${id} tyre ${t} μs`).toBeLessThanOrEqual(0.002);
        expect(Math.abs(muKinetic(def, t as TyreType) - MU[id][t][1]), `${id} tyre ${t} μk`).toBeLessThanOrEqual(0.002);
      }
    }
  });
  it('§4.3 DEEP set and surface columns', () => {
    const deep = SURFACE_IDS.filter((id) => DEFAULT_SURFACE_TABLE[id].deep);
    // the original's DEEP switch (FUN_006d0410): orig ids {0, 9, 11, 12, 18, 19, 22}
    expect(deep.sort()).toEqual(['grass', 'gravelDeep', 'mudDitch', 'sandDarkDeep', 'sandDeep', 'snowDeep', 'snowDitch']);
    const g = DEFAULT_SURFACE_TABLE.gravelDeep;
    expect([g.bodyK, g.bodyKScale, g.maxDepth, g.epsilon, g.frictionLevel, g.bump, g.bumpFlag]).toEqual([1.0, 0.25, 0.04, 0.4, 0.0, 0.02, 1]);
    expect(g.tyre[2].bestRollK).toBe(5.01);
    expect(DEFAULT_SURFACE_TABLE.cobbles.tyre[0].bestRollK).toBe(3.1);
    expect(DEFAULT_SURFACE_TABLE.ice.frictionLevel).toBe(2);
    expect(DEFAULT_SURFACE_TABLE.tarmac.frictionLevel).toBe(-1);
  });
  it('makeCarParams / makeSurfaceTable return independent deep copies', () => {
    const p = makeCarParams('awd_wrc', { mass: 1500, wheel: { rear: { springK: 1 } } });
    expect(p.mass).toBe(1500);
    expect(p.wheel.rear.springK).toBe(1);
    expect(p.wheel.front.springK).toBe(35000);
    expect(ARCHETYPE_PARAMS.awd_wrc.mass).toBe(1230);
    expect(ARCHETYPE_PARAMS.awd_wrc.wheel.rear.springK).toBe(35000);
    const s = makeSurfaceTable();
    s.tarmac.tyre[0].bestStatic = 0;
    expect(DEFAULT_SURFACE_TABLE.tarmac.tyre[0].bestStatic).toBe(2.151);
  });
});

// =====================================================================================================
describe('§2 tables and derived values', () => {
  it('§2.3.2 torque curve shape', () => {
    expect(torqueCurveAt(1000)).toBeCloseTo(0.1953, 4);
    expect(torqueCurveAt(5300)).toBeGreaterThan(1.0);
    expect(torqueCurveAt(9600)).toBe(0);
    expect(torqueCurveAt(-3000)).toBe(torqueCurveAt(3000));
  });
  it('§2.6.1 LOAD_TABLE closed form reproduces the shipped table (< 1e-4) and puts the peak at exactly μ·Fz', () => {
    const wp = { ...ARCHETYPE_PARAMS.awd_wrc.wheel.front, latPosK: 5.00238 + 1e-12 }; // force the rebuild path
    const t = buildLoadTable(wp, true, 1);
    for (let j = 0; j < 20; j++) for (let q = 0; q < 4; q++) expect(Math.abs(t[j * 4 + q] - LOAD_TABLE_SHIPPED[j][q])).toBeLessThan(1e-4);
    // tuned curve: rebuilt table keeps the lateral peak = μ·Fz
    const tuned = { ...wp, latPosK: 8, latNegK: 0.1 };
    const tt = buildLoadTable(tuned, true, 1);
    const out = { Fx: 0, Fy: 0, Mz: 0, aEq: 0 };
    let peak = 0;
    for (let a = 0.01; a < 1.2; a += 0.002) peak = Math.max(peak, tyreForce(out, tt, tuned, Math.tan(a), 0, 3500, 3500, 1).Fy);
    expect(Math.abs(peak / 3500 - 1)).toBeLessThan(0.002);
    // locked wheel still brakes at ≈ μ·Fz (§2.6.1)
    const lock = tyreForce(out, buildLoadTable(wp, false, 1), wp, 0, -1, 3700, 3700, 1);
    expect(Math.abs(lock.Fx / 3700 + 1)).toBeLessThan(0.01);
  });
  it('§2.5.4 frontShare2, §2.5.5 static loads, §2.2 shift speeds, §2.3.6 brake caps', () => {
    const exp = {
      awd_wrc: { fs2: 1.0435, F: 3850, R: 3530, shift: [40.4, 62.9, 87.3, 110.9, 139.5] },
      fwd_hatch: { fs2: 1.0295, F: 2965, R: 2795, shift: [40.4, 62.9, 87.3, 110.9, 139.5] },
      rwd_classic: { fs2: 0.9714, F: 2945, R: 3115, shift: [39.6, 62.9, 89.0, 115.6] },
    } as const;
    for (const id of ARCHETYPE_IDS) {
      const c = makeCar({ car: id });
      // 0.5 s at rest first: the load moment is one step lagged (§2.5.5) and the rwd car leaves the settle with a
      // decaying standstill pitch chatter (lm.z ±840 N·m right after it, < 40 after 0.5 s)
      run(c, 0.5, () => ctl());
      const d = c.debug();
      expect(Math.abs(d.frontShare2 - exp[id].fs2)).toBeLessThan(5e-4);
      expect(Math.abs(-d.wheels[0].load - exp[id].F)).toBeLessThan(10);
      expect(Math.abs(-d.wheels[2].load - exp[id].R)).toBeLessThan(10);
      exp[id].shift.forEach((v, i) => expect(Math.abs(d.shiftSpeed[i] - v)).toBeLessThan(0.1));
      expect(d.wheels.map((w) => w.brakeCap)).toEqual([5000, 5000, 3000, 3000]);
    }
  });
  // v1.5: the spring reads the compression FRACTION (SL − hitDist)/SL (FUN_006cf620 with the ray's c0 / c4, §2.5.3), so
  // the static compression is (1 − x)·SL² ≈ 0.074 m instead of 0.10 m and every car rides ≈ 2.5 cm higher than v1.4
  it('ride height at equilibrium ≈ 0.446 / 0.421 / 0.508 m (§3.2, v1.5) and wheel centres near y ≈ -0.12 (awd)', () => {
    const h: Record<string, number> = {};
    for (const id of ARCHETYPE_IDS) {
      const c = makeCar({ car: id });
      run(c, 3, () => ctl({ brake: 0.05 })); // a held pedal disables sleep → true spring equilibrium
      h[id] = c.telemetry().posSim.y;
      if (id === 'awd_wrc') for (const w of c.telemetry().wheels) inRange(w.visual.centreLocal.y, -0.14, -0.1);
    }
    inRange(h.awd_wrc, 0.435, 0.455);
    inRange(h.fwd_hatch, 0.41, 0.43);
    inRange(h.rwd_classic, 0.495, 0.52);
  });
});

// =====================================================================================================
describe('§6 live tuning, §5.5 setup options', () => {
  it('setParams rebuilds derived values: setup.brake, setup.gearRatio, mass/upgrade, steerSensFast', () => {
    const c = makeCar({});
    c.setParams({ setup: { brake: 1.2 } });
    expect(c.debug().wheels.map((w) => Math.round(w.brakeCap))).toEqual([6000, 6000, 2000, 2000]); // 75 % front
    c.setParams({ setup: { gearRatio: 1.2 } });
    const d = c.debug();
    expect(d.ratio[1]).toBeCloseTo(3.35 * 1.2, 9);
    expect(d.ratio[5]).toBeCloseTo(0.97 * 0.8, 9);
    expect(d.shiftSpeed[0]).toBeCloseTo(135.31 / (3.35 * 1.2), 1);
    c.setParams({ mass: 1500, upgrade: { weight: 0.9 } });
    expect(c.debug().mass).toBeCloseTo(1350, 9);
    expect(c.debug().inertia.y).toBeCloseTo(1.45 * 1350, 6);
  });
  it('archetype switch through setParams(makeCarParams(other)) changes geometry, gears and drive layout', () => {
    const c = makeCar({ car: 'awd_wrc' });
    c.setParams(makeCarParams('rwd_classic'));
    run(c, 2, () => ctl({ throttle: 1 }));
    const t = c.telemetry();
    expect(t.archetype).toBe('rwd_classic');
    expect(t.nGears).toBe(5);
    expect(t.wheels[0].visual.centreLocal.x).toBeCloseTo(-0.655, 9);
    expect(t.wheels[0].driveT).toBeLessThan(t.wheels[3].driveT); // 37.5 / 62.5 split
  });
  it('setup.suspension and springK change the ride height; steerSensFast picks the slip-angle set', () => {
    const h = (o: object) => {
      const c = makeCar({ params: o });
      run(c, 3, () => ctl({ brake: 0.05 }));
      return c.telemetry().posSim.y;
    };
    const base = h({});
    expect(h({ setup: { suspension: 1.3 } })).toBeGreaterThan(base + 0.01);
    expect(h({ setup: { suspension: 0.7 } })).toBeLessThan(base - 0.01);
    expect(h({ wheel: { front: { springK: 60000 }, rear: { springK: 60000 } } })).toBeGreaterThan(base + 0.02);
  });
  it('the live surface table is read every step (in-place edits apply without setSurfaces)', () => {
    const world = createFlatWorld({ surface: 'tarmac' });
    const surfaces = makeSurfaceTable();
    const c = new CarSim({ params: makeCarParams('awd_wrc'), world, surfaces });
    c.reset(flatSpawnPose(world, 0, 0, 0, 0.4225));
    reachSpeed(c, 100);
    surfaces.tarmac.tyre[0].bestStatic = 1.0; // μs ≈ 1.26
    const p0 = c.telemetry().posSim.z;
    while (c.telemetry().speedKmh > 0.2) c.step(ctl({ brake: 1 }), DT);
    expect(c.telemetry().posSim.z - p0).toBeGreaterThan(25); // tarmac default: ≈ 15.5 m
  });
  it('tyreType and muGlobalScale change braking distance', () => {
    const d0 = t3Brake({ surface: 'tarmac' })!.dist;
    expect(t3Brake({ surface: 'tarmac', tyre: 4 })!.dist).toBeGreaterThan(d0 * 1.2);
    expect(t3Brake({ surface: 'tarmac', params: { muGlobalScale: 0.5 } })!.dist).toBeGreaterThan(d0 * 1.7);
  });
});

// =====================================================================================================
describe('§2.10 sleep, §2.3.5 hill-hold, §0.3 DEV toggles', () => {
  it('standstill without input sleeps (exact rest); steering alone keeps it asleep', () => {
    for (const steer of [0, 1]) {
      const c = makeCar({});
      const p0 = c.telemetry().posSim;
      run(c, 3, () => ctl({ steer }));
      const t = c.telemetry();
      expect(c.debug().slept).toBe(true);
      expect(Math.hypot(t.posSim.x - p0.x, t.posSim.z - p0.z)).toBeLessThan(1e-3);
    }
  });
  it('15 % slope: no input holds (sleep), throttle 0.12 creeps slowly uphill (hill-hold)', () => {
    const normal = normalize({ x: 0, y: 1, z: -0.15 }); // nose uphill (+z rises)
    const world = createFlatWorld({ normal });
    const mk = () => {
      const c = new CarSim({ params: makeCarParams('awd_wrc'), world });
      c.reset(flatSpawnPose(world, 0, 0, 0, 0.4225 / normal.y));
      return c;
    };
    const a = mk();
    const z0 = a.telemetry().posSim.z;
    run(a, 5, () => ctl());
    expect(Math.abs(a.telemetry().posSim.z - z0)).toBeLessThan(0.01);
    const b = mk();
    run(b, 5, () => ctl({ throttle: 0.12 }));
    const dz = b.telemetry().posSim.z - z0;
    inRange(dz, -0.05, 2); // reference: +0.66 m in 5 s (no rolling back: EngineBrakeConstant hill-hold)
  });
  it('DEV-3 smoothYawFrictionSign removes the straight-line TWStaMy chatter (≈ 0.033 rad/s pp → 0)', () => {
    const pp = (smooth: boolean) => {
      const c = makeCar({ params: { assist: { smoothYawFrictionSign: smooth } } });
      reachSpeed(c, 100);
      const yr: number[] = [];
      run(c, 3, () => ctl({ throttle: 0.45 }), () => yr.push(c.telemetry().yawRate));
      return Math.max(...yr) - Math.min(...yr);
    };
    inRange(pp(false), 0.02, 0.05);
    expect(pp(true)).toBeLessThan(0.005);
  });
  it('DEV-7 heavyCarSleep lets a 1600 kg car sleep (original: never sleeps above ≈ 1440 kg)', () => {
    const sleeps = (on: boolean) => {
      const c = makeCar({ params: { mass: 1600, assist: { heavyCarSleep: on } } });
      run(c, 3, () => ctl({ brake: 0.05 })); // reach the spring equilibrium first (front spring ≈ 3.13·m N > 4500)
      run(c, 3, () => ctl());
      return c.debug().slept;
    };
    expect(sleeps(false)).toBe(false);
    expect(sleeps(true)).toBe(true);
  });
  it('DEV-6 sleepPedalThreshold: a 0.05 resting pedal disables sleep in the original, not with DEV-6', () => {
    const slept = (on: boolean) => {
      const c = makeCar({ params: { assist: { sleepPedalThreshold: on } } });
      run(c, 2, () => ctl({ brake: 0.05 }));
      return c.debug().slept;
    };
    expect(slept(false)).toBe(false);
    expect(slept(true)).toBe(true);
  });
  it('DEV-9 settleToEquilibrium: a reset drop rests at the spring equilibrium, at rest, launch without a bob; off = original freeze', () => {
    for (const car of ARCHETYPE_IDS) {
      // true equilibrium: a 0.01 brake keeps the car awake so it rests on its springs
      const eq = makeCar({ car });
      run(eq, 6, () => ctl({ brake: 0.01 }));
      const yEq = eq.telemetry().posSim.y;
      const drop = (on: boolean) => {
        const c = makeCar({ car, raise: 0.4225 + 1.5, params: { assist: { settleToEquilibrium: on } } });
        const t = c.telemetry();
        let lo = Infinity;
        let hi = -Infinity;
        run(c, 0.5, () => ctl({ throttle: 1 }), () => {
          const y = c.telemetry().posSim.y;
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        });
        return { dy: t.posSim.y - yEq, v: Math.hypot(t.velSim.x, t.velSim.y, t.velSim.z), yaw: Math.abs(t.yawRate), bob: hi - lo };
      };
      const on = drop(true);
      expect(Math.abs(on.dy), car).toBeLessThan(0.001);
      expect(on.v).toBe(0);
      expect(on.yaw).toBeLessThan(1e-3);
      expect(on.bob, car).toBeLessThan(0.004);
      // the original settle lets sleep freeze the body centimetres off its springs (the bug DEV-9 removes)
      expect(Math.abs(drop(false).dy), car).toBeGreaterThan(0.01);
    }
  });
  it('DEV-1 bigBetaSymmetric only matters for left drifts beyond 0.75 rad (toggle is live)', () => {
    const c = makeCar({ params: { assist: { bigBetaSymmetric: false } } });
    expect(c.params.assist.bigBetaSymmetric).toBe(false);
    c.setParams({ assist: { bigBetaSymmetric: true } });
    expect(c.params.assist.bigBetaSymmetric).toBe(true);
  });
});

// =====================================================================================================
describe('§2.9 chassis collision, obstacles, W19 flip assist', () => {
  const roof = qFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI);
  // v1.5: the original's body solver FUN_006d0970 (ported literally, proven against the executed exe) replaces the
  // DEV-4 impulse model. On its roof the body rests on the solver's push-out and normal impulse; the impulse uses the
  // one-step-lagged ω (B+0x44), so the body keeps a period-2 rock of |ω| ≈ 0.09 rad/s (≈ 0.04° per step, invisible).
  it('dropped on its roof from 1 m (gravel): comes to rest within 1 s (height and attitude steady)', () => {
    const world = createFlatWorld({ surface: 'gravel' });
    const c = new CarSim({ params: makeCarParams('awd_wrc', { tyreType: 2 }), world });
    c.reset({ pos: { x: 0, y: 2.0, z: 0 }, q: roof }, 0); // roof points (y = 1.0) 1 m above the ground
    const ys: number[] = [];
    const ups: number[] = [];
    run(c, 1.5, () => ctl(), () => {
      const q = c.telemetry().quatSim;
      ys.push(c.telemetry().posSim.y);
      ups.push(1 - 2 * (q.x * q.x + q.z * q.z)); // world y of the body up axis
    });
    const t = c.telemetry();
    expect(t.bodyOnGround).toBe(true);
    expect(t.impactImpulse >= 0).toBe(true);
    // at rest from 1.0 s on: height change < 5 mm and attitude change < 0.2° over the last 0.5 s
    const tail = ys.slice(Math.round(1 / DT));
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.005);
    const upTail = ups.slice(Math.round(1 / DT)).map((u) => Math.acos(Math.max(-1, Math.min(1, u))));
    expect(((Math.max(...upTail) - Math.min(...upTail)) * 180) / Math.PI).toBeLessThan(0.2);
    inRange(t.posSim.y, 0.95, 1.05);
    expect(Math.hypot(t.angVelLocal.x, t.angVelLocal.y, t.angVelLocal.z)).toBeLessThan(0.15);
    expect(Math.hypot(t.velSim.x, t.velSim.z)).toBeLessThan(0.05);
    expect(t.simFaults).toBe(0);
  });
  // [M] the original's roof friction: the anchor impulse BodyK·T·(weight share along n) fires every 0.2 s or on the
  // next contact (§2.9), i.e. ≈ BodyK·12 m/s² (gravel 0.92 → 1.13 g) plus the 2 m/s² free-flight damping (§2.10);
  // v1.4's DEV-4 target of 0.4-0.6 g was a design guess
  it('slides on its roof with 1.0-1.4 g of deceleration on gravel (original body solver)', () => {
    const world = createFlatWorld({ surface: 'gravel' });
    const c = new CarSim({ params: makeCarParams('awd_wrc', { tyreType: 2 }), world });
    c.reset({ pos: { x: 0, y: 1.0, z: 0 }, q: roof }, 0);
    run(c, 1, () => ctl());
    c.setForwardSpeed(10);
    run(c, 0.5, () => ctl());
    const v = Math.hypot(c.telemetry().velSim.x, c.telemetry().velSim.z);
    inRange((10 - v) / 0.5 / 9.81, 1.0, 1.4);
  });
  it('flip assist: a stopped car on its side rights itself under throttle (both sides)', () => {
    for (const ang of [Math.PI / 2, -Math.PI / 2]) {
      const world = createFlatWorld();
      const c = new CarSim({ params: makeCarParams('awd_wrc'), world });
      c.reset({ pos: { x: 0, y: 0.9, z: 0 }, q: qFromAxisAngle({ x: 0, y: 0, z: 1 }, ang) }, 0);
      run(c, 2, () => ctl());
      let upright = Infinity;
      run(
        c,
        6,
        () => ctl({ throttle: 1 }),
        (t) => {
          const q = c.telemetry().quatSim;
          if (upright === Infinity && 1 - 2 * (q.x * q.x + q.z * q.z) > 0.9 && c.telemetry().nContacts >= 3) upright = t;
        },
      );
      expect(upright).toBeLessThan(4);
    }
  });
  it('flip assist off: the car stays on its side', () => {
    const c = new CarSim({ params: makeCarParams('awd_wrc', { flipAssist: false }), world: createFlatWorld() });
    c.reset({ pos: { x: 0, y: 0.9, z: 0 }, q: qFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2) }, 0);
    run(c, 6, () => ctl({ throttle: 1 }));
    const q = c.telemetry().quatSim;
    expect(1 - 2 * (q.x * q.x + q.z * q.z)).toBeLessThan(0.5);
  });

  const treeRun = (lat: number, kmh = 60) => {
    const tree: Obstacle = { kind: 'tree', pos: { x: lat, y: 0, z: 40 }, radius: 0.35, height: 8 };
    const world = createProfileWorld(flatProfile(), 'tarmac', [tree]);
    const c = makeCar({ world, z: -200 });
    let t = 0;
    while (c.telemetry().posSim.z < 20 && t < 30) {
      c.step(ctl({ throttle: c.telemetry().speedKmh < kmh ? 1 : 0 }), DT);
      t += DT;
    }
    let maxImp = 0;
    let minGap = Infinity;
    run(
      c,
      3,
      () => ctl({ throttle: 0.3 }),
      () => {
        const tl = c.telemetry();
        maxImp = Math.max(maxImp, tl.impactImpulse);
        // tree centre in the car frame must stay outside the hull footprint (no pass-through)
        const dx = lat - tl.posSim.x;
        const dz = 40 - tl.posSim.z;
        minGap = Math.min(minGap, Math.hypot(Math.max(0, Math.abs(dx) - 0.85), Math.max(0, dz - 2.07, -2.3 - dz)));
      },
    );
    return { c, maxImp, minGap };
  };
  it('obstacles: a head-on tree hit at 60 km/h stops the car (no pass-through, impulse reported, no faults)', () => {
    const { c, maxImp, minGap } = treeRun(0);
    const t = c.telemetry();
    expect(t.posSim.z).toBeLessThan(40);
    expect(t.speedKmh).toBeLessThan(10);
    expect(maxImp).toBeGreaterThan(1230 * 10);
    expect(minGap).toBeGreaterThan(0.2); // the 0.35 m trunk never gets deeper than 0.15 m into the hull
    expect(t.simFaults).toBe(0);
    expect(Math.abs(t.yawRate)).toBeLessThan(1);
  });
  it('obstacles: a glancing hit deflects the car and it carries on (forgiving)', () => {
    const { c, maxImp } = treeRun(1.15);
    const t = c.telemetry();
    expect(maxImp).toBeGreaterThan(0);
    expect(t.posSim.z).toBeGreaterThan(45);
    expect(t.speedKmh).toBeGreaterThan(40);
    expect(t.posSim.x).toBeLessThan(0); // pushed away from the trunk (trunk on the right)
  });
});

// =====================================================================================================
describe('§5.6 damage hook (DEV-5)', () => {
  const crash = (physical: boolean) => {
    const tree: Obstacle = { kind: 'rock', pos: { x: 0.5, y: 0, z: 30 }, radius: 0.6, height: 2 };
    const world = createProfileWorld(flatProfile(), 'tarmac', [tree]);
    const c = makeCar({ world, z: -60, params: { damage: { physical } } });
    let maxImp = 0;
    run(
      c,
      8,
      () => ctl({ throttle: c.telemetry().speedKmh < 70 ? 1 : 0 }),
      () => (maxImp = Math.max(maxImp, c.telemetry().impactImpulse)),
    );
    expect(maxImp).toBeGreaterThan(1000 * 15); // the crash happened
    return c;
  };
  it('off by default: impacts leave no damage', () => {
    const d = crash(false).damageState();
    expect(d.suspension.every((x) => x === 0) && d.engine === 0 && !d.gearbox).toBe(true);
  });
  it('on: a 70 km/h crash damages the front within the §5.6 clamps; repair() clears it', () => {
    const c = crash(true);
    const d = c.damageState();
    expect(Math.max(...d.suspension)).toBeGreaterThan(0);
    for (const x of [...d.suspension, ...d.brakes, d.engine]) inRange(x, 0, 0.25);
    for (const s of d.steer) inRange(s, -0.05, 0.05);
    c.repair();
    expect(c.damageState().suspension.every((x) => x === 0)).toBe(true);
  });
});

// =====================================================================================================
describe('NaN / explosion guard, telemetry contract, budget', () => {
  it('an exploding parameter set is rolled back: telemetry stays finite and simFaults counts the trips', () => {
    const c = makeCar({});
    run(c, 1, () => ctl({ throttle: 1 }));
    c.setParams({ wheel: { front: { springK: 1e12, dampK: 1e9 }, rear: { springK: 1e12 } }, damperCap: 1e15, antiPogo: false });
    run(c, 1, () => ctl({ throttle: 1 }));
    const t = c.telemetry();
    expect(t.simFaults).toBeGreaterThan(0);
    expect(jsonSafetyIssue(t)).toBeNull();
    c.setParams(makeCarParams('awd_wrc'));
    const n = t.simFaults;
    run(c, 3, () => ctl({ throttle: 1 }));
    expect(c.telemetry().simFaults).toBe(n);
    expect(c.telemetry().speedKmh).toBeGreaterThan(20);
  });
  it('non-finite controls and world normals are sanitised', () => {
    const base = createFlatWorld();
    let bad = 0;
    const world = {
      ...base,
      raycast: (o: Parameters<typeof base.raycast>[0], d: Parameters<typeof base.raycast>[1], m: number) => {
        const h = base.raycast(o, d, m);
        if (h && bad-- > 0) return { ...h, normal: { x: NaN, y: NaN, z: NaN } };
        return h;
      },
    };
    const c = makeCar({ world });
    run(c, 1, () => ctl({ throttle: 1 }));
    bad = 12;
    c.step({ steer: NaN, throttle: Infinity, brake: NaN, handbrake: 0, gearUp: false, gearDown: false }, DT);
    run(c, 0.1, () => ctl({ throttle: 1 }));
    expect(jsonSafetyIssue(c.telemetry())).toBeNull();
    expect(c.telemetry().speedKmh).toBeGreaterThan(5);
  });
  it('telemetry: fresh object per step (kept references never change), JSON-safe, three = mirror(sim)', () => {
    const c = makeCar({});
    const a = c.telemetry();
    const aJson = JSON.stringify(a);
    expect(c.telemetry()).toBe(a); // cached until the next step
    run(c, 1, () => ctl({ throttle: 1, steer: 0.3 }));
    const b = c.telemetry();
    expect(b).not.toBe(a);
    expect(JSON.stringify(a)).toBe(aJson);
    expect(jsonSafetyIssue(b)).toBeNull();
    expect(b.pos).toEqual({ x: b.posSim.x, y: b.posSim.y, z: -b.posSim.z });
    expect(b.quat).toEqual({ w: b.quatSim.w, x: -b.quatSim.x, y: -b.quatSim.y, z: b.quatSim.z });
    for (const w of b.wheels) expect(w.contactPointThree.z).toBe(-w.contactPoint.z);
    expect(b.wheels[0].visual.steerAngle).toBeGreaterThan(0);
    expect(b.wheels[2].visual.steerAngle).toBe(0);
    expect(b.wheels[0].visual.centreLocal.z).toBeLessThan(0); // front wheel: three car-local forward = -Z
  });
  it('steer angle: 0.6 rad at standstill, 0.4 rad above 40 km/h (§2.1)', () => {
    const c = makeCar({});
    c.step(ctl({ steer: 1 }), DT);
    expect(c.telemetry().steerAngle).toBeCloseTo(0.6, 3);
    reachSpeed(c, 60);
    c.step(ctl({ steer: 1 }), DT);
    expect(c.telemetry().steerAngle).toBeCloseTo(0.4, 9);
  });
  it('aLat / aLong come from Δv over 2 steps and match the force-based value on average', () => {
    const c = makeCar({});
    reachSpeed(c, 80);
    const a: number[] = [];
    const f: number[] = [];
    run(
      c,
      2,
      () => ctl({ steer: 0.25, throttle: 0.5 }),
      () => {
        a.push(c.telemetry().aLat);
        const d = c.debug();
        f.push((d.right.x * d.forceWorld.x + d.right.y * d.forceWorld.y + d.right.z * d.forceWorld.z) / d.mass);
      },
    );
    const mean = (x: number[]) => x.slice(120).reduce((s, v) => s + v, 0) / (x.length - 120);
    expect(Math.abs(mean(a) - mean(f))).toBeLessThan(0.05 * Math.abs(mean(f)));
    expect(mean(a)).toBeGreaterThan(5);
  });
  it('parked: clutch open + all wheels braked, throttle free-revs, the car does not move', () => {
    const c = makeCar({});
    c.setParked(true);
    const z0 = c.telemetry().posSim.z;
    run(c, 2, () => ctl({ throttle: 1 }));
    const t = c.telemetry();
    expect(t.parked).toBe(true);
    expect(Math.abs(t.posSim.z - z0)).toBeLessThan(0.01);
    expect(t.rpm).toBeGreaterThan(3000);
    c.setParked(false);
    run(c, 1, () => ctl({ throttle: 1 }));
    expect(c.telemetry().speedKmh).toBeGreaterThan(20);
  });
  it('frozen cars skip step(); setWorld switches the ground', () => {
    const c = makeCar({});
    c.setFrozen(true);
    const n = c.telemetry().stepCount;
    run(c, 1, () => ctl({ throttle: 1 }));
    expect(c.telemetry().stepCount).toBe(n);
    c.setFrozen(false);
    c.setWorld(createFlatWorld({ surface: 'ice' }));
    c.step(ctl(), DT);
    expect(c.telemetry().wheels[0].surface).toBe('ice');
  });
  it('one step of one car takes < 0.05 ms', () => {
    const c = makeCar({ surface: 'gravel' });
    const a = ctl({ throttle: 1, steer: 0.3 });
    const b = ctl({ throttle: 0.5, steer: -0.6 });
    for (let i = 0; i < 5000; i++) c.step(i % 600 < 300 ? a : b, DT);
    const N = 30000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) c.step(i % 600 < 300 ? a : b, DT);
    const us = ((performance.now() - t0) * 1000) / N;
    expect(us).toBeLessThan(50);
  });
});
