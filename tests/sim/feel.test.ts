/**
 * tests/sim/feel.test.ts — OWNED BY THE SIM BUILDER.
 *
 * docs/MECHANICS_SPEC.md §7 feel-validation tests (headless, §7.1 harness in ./harness.ts).
 * Expected values are the spec's [M]/[E] numbers; tolerance ±12 % unless the spec states a range.
 *
 * Where the spec's expected value contradicts the spec's own equations, the model is kept faithful and the
 * assertion is skipped with the reason; next to it a "reference" assertion pins the value the spec-literal
 * Python implementation (tools/reference/spec_sim_check.py, run with the archetype's parameters) produces.
 * T19 (auto reset on the stage spline) belongs to the race controller (src/game, tests/contracts/game.test.ts);
 * only its sim part (reset + settle) is tested here.
 */
import { describe, expect, it } from 'vitest';
import { DT, neutralRawInput } from '../../src/core/constants';
import { qYawSim } from '../../src/core/math';
import type { ArchetypeId, SurfaceId, TyreType } from '../../src/core/types';
import { InputFilter } from '../../src/sim/inputFilter';
import {
  airPhases,
  cornering,
  ctl,
  driftHold,
  makeCar,
  maxHoldableBeta,
  powerStep,
  t8Power,
  profileRun,
  reachSpeed,
  run,
  t1Accel,
  t3bCoast,
  t3Brake,
  t4Lateral,
  t5Handbrake,
  t6Recovery,
  t7MaxBeta,
  t12Step,
  t16Coast,
  t18Deep,
} from './harness';
import { createProfileWorld, hillProfile, rampProfile } from './profileworld';

const ARCH: ArchetypeId[] = ['awd_wrc', 'fwd_hatch', 'rwd_classic'];

/** |actual - expected| ≤ tol·|expected|. */
function near(actual: number | null, expected: number, tol = 0.12): void {
  expect(actual, `expected ≈ ${expected} (±${tol * 100} %)`).not.toBeNull();
  expect(Math.abs((actual as number) - expected), `${actual} vs ${expected} ±${tol * 100} %`).toBeLessThanOrEqual(Math.abs(expected) * tol);
}
function inRange(actual: number | null, lo: number, hi: number): void {
  expect(actual, `expected in [${lo}, ${hi}]`).not.toBeNull();
  expect(actual as number, `${actual} ≥ ${lo}`).toBeGreaterThanOrEqual(lo);
  expect(actual as number, `${actual} ≤ ${hi}`).toBeLessThanOrEqual(hi);
}

// =====================================================================================================
describe('§7 T1 acceleration / T2 top speed', () => {
  // [t60, t100, t160 | null]
  // v1.3: sand / mud (gravel tyres) = the original's loose rally stage surfaces (§4.3); values from running the model.
  const T1: Record<ArchetypeId, Record<string, [number, number, number | null]>> = {
    awd_wrc: { tarmac: [2.4, 4.6, 8.2], gravel: [2.7, 4.8, 8.5], sand: [2.8, 4.96, 8.7], mud: [2.8, 4.98, 8.9], snow: [2.8, 5.0, null], snow_tt: [5.0, 9.4, null] },
    fwd_hatch: { tarmac: [2.1, 4.1, 7.1], gravel: [2.3, 4.3, 7.5], sand: [2.5, 4.5, 8.2], mud: [2.6, 4.7, 8.65], snow: [2.7, 4.8, null], snow_tt: [10.0, NaN, null] },
    rwd_classic: { tarmac: [1.5, 3.2, 4.9], gravel: [1.7, 3.3, 5.2], sand: [1.77, 3.4, 5.3], mud: [1.8, 3.44, 5.44], snow: [1.9, 3.5, null], snow_tt: [6.3, 11.9, null] },
  };
  const CASES: [string, SurfaceId, TyreType][] = [
    ['tarmac', 'tarmac', 0],
    ['gravel', 'gravel', 2],
    ['sand', 'sand', 2],
    ['mud', 'mud', 2],
    ['snow', 'snow', 3],
    ['snow_tt', 'snow', 0],
  ];
  const results: Record<string, ReturnType<typeof t1Accel>> = {};
  const get = (car: ArchetypeId, key: string) => {
    const k = `${car}/${key}`;
    if (!results[k]) {
      const c = CASES.find((x) => x[0] === key)!;
      results[k] = t1Accel({ car, surface: c[1], tyre: c[2] }, key === 'snow_tt' ? 16 : 12);
    }
    return results[k];
  };

  for (const car of ARCH) {
    for (const [key] of CASES) {
      it(`T1 ${car} ${key}: 0-60 / 0-100 / 0-160 within ±12 %`, () => {
        const r = get(car, key);
        const [e60, e100, e160] = T1[car][key];
        near(r.t60, e60);
        if (Number.isNaN(e100)) expect(r.t100 === null || r.t100 > 15).toBe(true); // "> 15 s"
        else near(r.t100, e100);
        if (e160 !== null) near(r.t160, e160);
      });
    }
  }

  it('T1 ordering: rwd < fwd < awd on matched surfaces; tarmac < gravel < sand < mud; gravel < snow; wrong tyres on snow ≥ 1.9× slower', () => {
    for (const car of ARCH) {
      expect(get(car, 'gravel').t100!).toBeLessThan(get(car, 'sand').t100!);
      expect(get(car, 'sand').t100!).toBeLessThan(get(car, 'mud').t100!);
    }
    for (const key of ['tarmac', 'gravel', 'sand', 'mud', 'snow']) {
      expect(get('rwd_classic', key).t100!).toBeLessThan(get('fwd_hatch', key).t100!);
      expect(get('fwd_hatch', key).t100!).toBeLessThan(get('awd_wrc', key).t100!);
    }
    for (const car of ARCH) {
      expect(get(car, 'tarmac').t100!).toBeLessThan(get(car, 'gravel').t100!);
      expect(get(car, 'gravel').t100!).toBeLessThan(get(car, 'snow').t100!);
      const wrong = get(car, 'snow_tt').t100 ?? Infinity;
      expect(wrong / get(car, 'snow').t100!).toBeGreaterThanOrEqual(1.9);
    }
  });

  const TOP: Record<ArchetypeId, number> = { awd_wrc: 210, fwd_hatch: 213, rwd_classic: 245 };
  for (const car of ARCH) {
    it(`T2 ${car}: top speed ${TOP[car]} km/h ±5 % after 60 s, in top gear, limiter rpm`, () => {
      const r = t1Accel({ car, surface: 'tarmac' }, 60);
      near(r.vtop, TOP[car], 0.05);
      const nG = car === 'rwd_classic' ? 5 : 6;
      expect(r.gear).toBe(nG);
    });
  }
  it('T2 deep gravel (awd, gravel tyres): top speed < 140 km/h', () => {
    const r = t1Accel({ car: 'awd_wrc', surface: 'gravelDeep', tyre: 2 }, 40);
    expect(r.vtop).toBeLessThan(140);
  });
  it('T2 HUD rpm sits at the limiter at top speed (display clamp ≥ CutRPM)', () => {
    const car = makeCar({});
    run(car, 60, () => ctl({ throttle: 1 }));
    const t = car.telemetry();
    expect(t.rpm).toBeGreaterThan(t.rpmRedline);
    expect(t.rpm).toBeLessThanOrEqual(t.rpmMax);
  });
});

// =====================================================================================================
describe('§7 T3 braking / T3b coast-down', () => {
  const ROWS: [string, SurfaceId, TyreType, number, number, number | null][] = [
    // label, surface, tyre, dist lo, dist hi, time
    ['tarmac', 'tarmac', 0, 13.8, 17.6, 1.1],
    ['gravel', 'gravel', 2, 19.5, 24.8, 1.6],
    ['sand', 'sand', 2, 23.5, 29.8, 1.92], // v1.3 [M]: 26.4-26.6 m
    ['mud', 'mud', 2, 24.6, 31.2, 2.03], // v1.3 [M]: 27.8-28.1 m
    ['snow', 'snow', 3, 26, 34, 2.15],
    ['ice', 'ice', 4, 26, 34, 2.15],
    ['snow_tt', 'snow', 0, 90, 120, null],
  ];
  const dist: Record<string, number> = {};
  for (const [label, surface, tyre, lo, hi, time] of ROWS) {
    for (const car of ARCH) {
      it(`T3 ${car} ${label}: 100→0 distance in [${lo}, ${hi}] m${time ? `, time ≈ ${time} s` : ''}`, () => {
        const r = t3Brake({ car, surface, tyre });
        expect(r).not.toBeNull();
        inRange(r!.dist, lo, hi);
        if (time) near(r!.time, time);
        dist[`${car}/${label}`] = r!.dist;
      });
    }
    if (label !== 'snow_tt') {
      it(`T3 ${label}: all three archetypes within ±3 % of each other`, () => {
        const d = ARCH.map((car) => dist[`${car}/${label}`] ?? t3Brake({ car, surface, tyre })!.dist);
        expect(Math.max(...d) / Math.min(...d)).toBeLessThanOrEqual(1.03 * 1.03);
      });
    }
  }
  it('T3 ice on tarmac tyres: top speed ≈ 86 km/h; from an initialised 100 km/h (gear 4) ≈ 255 m (225-285), ≈ 20.3 s', () => {
    const top = t1Accel({ surface: 'ice', tyre: 0 }, 90);
    near(top.vtop, 86, 0.05);
    const r = t3Brake({ surface: 'ice', tyre: 0 }, { kmh: 100, gear: 4 })!;
    inRange(r.dist, 225, 285);
    near(r.time, 20.3);
  });

  it('T3b coast-down 1 s from 100 km/h on tarmac / gravel: 5.0-5.7 m/s²', () => {
    inRange(t3bCoast({ surface: 'tarmac' }), 5.0, 5.7);
    inRange(t3bCoast({ surface: 'gravel' }), 5.0, 5.7);
  });
  it('T3b snow / ice: 5.0-5.5 m/s² (spec v1.2 band, corrected to the spec-literal values; v1.1 said 4.2-5.2)', () => {
    inRange(t3bCoast({ surface: 'snow' }), 5.0, 5.5);
    inRange(t3bCoast({ surface: 'ice' }), 5.0, 5.5);
  });
  it('T3b snow / ice match the spec-literal reference (5.30 / 5.21 m/s² ±2 %) and stay below tarmac', () => {
    const snow = t3bCoast({ surface: 'snow' })!;
    const ice = t3bCoast({ surface: 'ice' })!;
    near(snow, 5.3, 0.02);
    near(ice, 5.21, 0.02);
    expect(snow).toBeLessThan(t3bCoast({ surface: 'tarmac' })!);
    expect(ice).toBeLessThan(snow);
  });
});

// =====================================================================================================
describe('§7 T4 peak steady-state lateral acceleration (filtered, awd_wrc)', () => {
  const ROWS: [string, SurfaceId, TyreType, number, number | null][] = [
    ['tarmac', 'tarmac', 0, 2.59, 2.76],
    ['gravel', 'gravel', 2, 1.86, 1.9],
    ['snow', 'snow', 3, 1.43, 1.39],
    ['ice', 'ice', 4, 1.42, 1.37],
    ['snow_tt', 'snow', 0, 0.33, 0.36],
    ['ice_tt', 'ice', 0, 0.12, null],
    ['ice_gt', 'ice', 2, 0.51, 0.57],
    ['sand', 'sand', 2, 1.49, 1.51], // v1.3 [M]
    ['mud', 'mud', 2, 1.45, 1.44], // v1.3 [M]
  ];
  const filtered: Record<string, number> = {};
  for (const [label, surface, tyre, e60, e100] of ROWS) {
    it(`T4 awd ${label}: ${e60}${e100 !== null ? ` / ${e100}` : ''} g ±12 %`, () => {
      const a = t4Lateral({ surface, tyre }, 60).filtered;
      near(a, e60);
      let best = a;
      if (e100 !== null) {
        const b = t4Lateral({ surface, tyre }, 100).filtered;
        near(b, e100);
        best = Math.max(a, b);
      }
      filtered[label] = best;
    });
  }
  it('T4 matched-tyre ratios tarmac : gravel : sand : mud : snow = 1 : (0.66-0.80) : (0.50-0.61) : (0.48-0.59) : (0.48-0.60)', () => {
    const f = (l: string, s: SurfaceId, t: TyreType) =>
      filtered[l] ?? Math.max(t4Lateral({ surface: s, tyre: t }, 60).filtered, t4Lateral({ surface: s, tyre: t }, 100).filtered);
    const tar = f('tarmac', 'tarmac', 0);
    inRange(f('gravel', 'gravel', 2) / tar, 0.66, 0.8);
    inRange(f('sand', 'sand', 2) / tar, 0.5, 0.61); // sim 0.55
    inRange(f('mud', 'mud', 2) / tar, 0.48, 0.59); // sim 0.53
    inRange(f('snow', 'snow', 3) / tar, 0.48, 0.6);
  });
  it('T4 fwd / rwd (unfiltered, ordering): rwd ≥ awd on every matched surface; fwd within its bands', () => {
    const FWD: Record<string, [number, number]> = { tarmac: [2.6, 2.9], gravel: [1.9, 1.9], snow: [1.4, 1.47], ice: [1.4, 1.47] };
    for (const [label, surface, tyre] of ROWS.slice(0, 4)) {
      const un = (car: ArchetypeId) => Math.max(t4Lateral({ car, surface, tyre }, 60).unfiltered, t4Lateral({ car, surface, tyre }, 100).unfiltered);
      const awd = un('awd_wrc');
      const rwd = un('rwd_classic');
      const fwd = un('fwd_hatch');
      expect(rwd, `rwd ≥ awd on ${label}`).toBeGreaterThanOrEqual(awd);
      inRange(fwd, FWD[label][0] * 0.88, FWD[label][1] * 1.12);
    }
  });
});

// =====================================================================================================
describe('§7 T5 handbrake turn at 60 km/h on gravel', () => {
  const REF: Record<ArchetypeId, { h05: number; h10: [number, number]; v10: number; h20: number; nohb: number }> = {
    awd_wrc: { h05: 38, h10: [75, 100], v10: 32, h20: 176, nohb: 80 },
    fwd_hatch: { h05: 31, h10: [56, 78], v10: 31, h20: 158, nohb: 50 },
    rwd_classic: { h05: 39, h10: [82, 110], v10: 33, h20: 224, nohb: 77 },
  };
  for (const car of ARCH) {
    it(`T5 ${car}: heading ${REF[car].h05}° / ${REF[car].h10.join('-')}° / ${REF[car].h20}°, speed ${REF[car].v10} km/h at 1 s; pass criteria`, () => {
      const hb = t5Handbrake({ car, surface: 'gravel' })!;
      const nohb = t5Handbrake({ car, surface: 'gravel' }, { useHb: false, thrAfter: 0, hbTime: 9 })!;
      const r = REF[car];
      near(hb.marks['0.5'].heading, r.h05);
      inRange(hb.marks['1.0'].heading, r.h10[0], r.h10[1]);
      near(hb.marks['1.0'].kmh, r.v10);
      near(hb.marks['2.0'].heading, r.h20);
      near(nohb.marks['1.0'].heading, r.nohb);
      // pass: turns +5..+20° more than without handbrake within 1 s, loses ≥ 40 % speed, accelerates away within 0.3 s
      inRange(hb.marks['1.0'].heading - nohb.marks['1.0'].heading, 5, 20);
      expect(hb.marks['1.0'].kmh).toBeLessThanOrEqual(0.6 * 60);
      const after = hb.trace.filter((p) => p.t > 0.5);
      let minI = 0;
      for (let i = 0; i < after.length; i++) if (after[i].kmh < after[minI].kmh) minI = i;
      expect(after[minI].t).toBeLessThanOrEqual(0.8 + 1e-9);
      expect(hb.marks['1.0'].kmh).toBeGreaterThan(after[minI].kmh);
    });
  }
  for (const car of ARCH) {
    it(`T5b ${car}: handbrake tap adds +3..+20° at 1 s, no spin (< 120°)`, () => {
      const tap = t5Handbrake({ car, surface: 'gravel' }, { steer: 0.6, hbTime: 0.15, thrAfter: 0.6 })!;
      const no = t5Handbrake({ car, surface: 'gravel' }, { steer: 0.6, hbTime: 0.15, thrAfter: 0.6, useHb: false })!;
      inRange(tap.marks['1.0'].heading - no.marks['1.0'].heading, 3, 20);
      expect(tap.marks['1.0'].heading).toBeLessThan(120);
    });
  }
  for (const car of ARCH) {
    it(`T5c ${car}: holding the handbrake 1.5 s stops the car (< 5 km/h) by 1.0-1.2 s, heading 50-100° (v1.2 band)`, () => {
      const hold = t5Handbrake({ car, surface: 'gravel' }, { hbTime: 1.5 })!;
      const stop = hold.trace.find((p) => p.kmh < 5)!;
      expect(stop).toBeDefined();
      expect(stop.t).toBeLessThanOrEqual(1.2);
      inRange(hold.marks['1.0'].heading, 50, 100);
    });
  }
  it('T5c rwd_classic stops by 1.2 s and matches the spec-literal reference (97.8° ±2°, 3.8 km/h at 1.0 s)', () => {
    const hold = t5Handbrake({ car: 'rwd_classic', surface: 'gravel' }, { hbTime: 1.5 })!;
    expect(hold.trace.find((p) => p.kmh < 5)!.t).toBeLessThanOrEqual(1.2);
    inRange(hold.marks['1.0'].heading, 95.8, 99.8);
  });
});

// =====================================================================================================
describe('§7 T6-T8 tarmac recovery and power slides', () => {
  it('T6 awd: tarmac slide peak |β| 12-15°, |β| < 5° within 0.43-0.53 s', () => {
    const r = t6Recovery();
    inRange(r.peakBeta, 12, 15);
    inRange(r.tBelow5, 0.43, 0.53);
  });
  it('T6 fwd / rwd: recover below 5° within 1 s (S1)', () => {
    for (const car of ['fwd_hatch', 'rwd_classic'] as const) {
      const r = t6Recovery({ car });
      expect(r.tBelow5).not.toBeNull();
      expect(r.tBelow5!).toBeLessThan(1);
    }
  });
  for (const car of ARCH) {
    it(`T7 ${car}: no sustained power slide on tarmac (max |β| ≤ 4°) from every start state (spec / steady / spooled)`, () => {
      expect(t7MaxBeta({ car, surface: 'tarmac' }, 100)).toBeLessThanOrEqual(4);
      for (const start of ['steady', 'spooled'] as const) expect(t8Power({ car, surface: 'tarmac' }, 100, start, 3).maxBeta).toBeLessThanOrEqual(4);
    });
  }
  // §7.1 v1.2: the power tests start from a DEFINED turbo state. The outcome of T8 for the rwd car is decided by the
  // §2.3.3 turbo spool [V] (×(1 + thr/40) per step above half throttle, about 2.3 s from idle to the waste gate).
  it('T8 steady cruise (turbo at idle): awd / fwd max |β| ≤ 4° over 6 s; rwd < 10° for the first 3 s (turbo lag), > 30° within 5 s', () => {
    for (const car of ['awd_wrc', 'fwd_hatch'] as const) {
      const r = t8Power({ car, surface: 'gravel' }, 80, 'steady', 6);
      expect(r.boost0).toBeLessThan(0.05);
      expect(r.maxBeta, car).toBeLessThanOrEqual(4);
    }
    const rwd = t8Power({ car: 'rwd_classic', surface: 'gravel' }, 80, 'steady', 6);
    expect(rwd.boost0).toBeLessThan(0.05);
    expect(rwd.maxBeta3).toBeLessThan(10);
    expect(rwd.t30).not.toBeNull();
    inRange(rwd.t30, 3, 5);
  });
  it('T8 turbo spooled (3 s of left-foot braking at 80 km/h): awd / fwd max |β| ≤ 4°; rwd > 30° within 1.5 s', () => {
    for (const car of ['awd_wrc', 'fwd_hatch'] as const) {
      const r = t8Power({ car, surface: 'gravel' }, 80, 'spooled', 3);
      expect(r.boost0).toBeGreaterThan(0.95);
      expect(r.maxBeta, car).toBeLessThanOrEqual(4);
    }
    const rwd = t8Power({ car: 'rwd_classic', surface: 'gravel' }, 80, 'spooled', 3);
    expect(rwd.boost0).toBeGreaterThan(0.95);
    expect(rwd.t30).not.toBeNull();
    expect(rwd.t30!).toBeLessThanOrEqual(1.5);
  });
  it('T8 spec-literal start (reference, v1.1 protocol): awd / fwd ≤ 4°, rwd > 30° in 3 s only because it starts at boost ≈ 0.11', () => {
    expect(t7MaxBeta({ car: 'awd_wrc', surface: 'gravel' }, 80)).toBeLessThanOrEqual(4);
    expect(t7MaxBeta({ car: 'fwd_hatch', surface: 'gravel' }, 80)).toBeLessThanOrEqual(4);
    const r = t8Power({ car: 'rwd_classic', surface: 'gravel' }, 80, 'spec', 3);
    expect(r.boost0).toBeGreaterThan(0.05);
    expect(r.maxBeta).toBeGreaterThan(30);
  });
});

// =====================================================================================================
describe('drift hold (regression probe for design targets S2 / F1; not a §7 [M] value; spec §7 v1.3)', () => {
  // v1.3: the probe uses a counter-steer P-I-D controller (harness driftHold, ki 0.1; maxHoldableBeta also tries the P-D
  // gains). The v1.2 P-D probe under-reported the holdable angle through its steady-state error ("AWD holds 12-20°").
  // Shipped (spec-faithful) baseline on gravel: awd holds 10-40° but only by steering INTO the slide (TWKinSteer, no
  // opposite-lock equilibrium); fwd cannot hold a power slide at any steer; rwd holds 10-45° while its speed runs away.
  // A holdable-slide alternative is the NON-default "Arcade drift" preset (tests/sim/presets.test.ts).
  const holds: Record<string, ReturnType<typeof maxHoldableBeta>> = {};
  const hold = (car: ArchetypeId, surface: SurfaceId) => (holds[`${car}/${surface}`] ??= maxHoldableBeta({ car, surface }));
  const row = (car: ArchetypeId, surface: SurfaceId, bT: number) => hold(car, surface).rows.find((r) => r.target === bT)!;
  it('gravel: max holdable β awd 35-45° (sim 40°), fwd 0°, rwd ≥ 40° (sim 45°); awd steers INTO the slide', () => {
    console.table(ARCH.flatMap((car) => hold(car, 'gravel').rows.map((r) => ({ car, target: r.target, ki: r.ki, meanBeta: +r.meanBeta.toFixed(1), inBandPct: Math.round(r.inBandPct), meanKmh: Math.round(r.meanKmh), meanSteer: +r.meanSteer.toFixed(2), held: r.held }))));
    inRange(hold('awd_wrc', 'gravel').maxHeld, 35, 45);
    inRange(row('awd_wrc', 'gravel', 30).meanSteer, 0.55, 0.8); // sim +0.68: no opposite-lock equilibrium
    expect(row('awd_wrc', 'gravel', 20).inBandPct).toBeGreaterThanOrEqual(95);
    expect(hold('fwd_hatch', 'gravel').maxHeld).toBe(0);
    for (const r of hold('fwd_hatch', 'gravel').rows) expect(r.meanBeta, `fwd target ${r.target}`).toBeLessThan(8);
    expect(hold('rwd_classic', 'gravel').maxHeld).toBeGreaterThanOrEqual(40);
    const r30 = row('rwd_classic', 'gravel', 30);
    expect(r30.meanKmh).toBeGreaterThan(r30.kmhFlick); // speed runs away
    // ordering at the 30° target: rwd needs the least steer, fwd cannot get there
    expect(row('rwd_classic', 'gravel', 30).meanSteer).toBeLessThan(row('awd_wrc', 'gravel', 30).meanSteer);
    expect(row('awd_wrc', 'gravel', 30).meanBeta).toBeGreaterThan(row('fwd_hatch', 'gravel', 30).meanBeta + 20);
  });
  it('gravel, v1.2 P-D reference (ki 0): awd mean β 15-26° at a 30° target (the old "12-20°" headline), rwd in band', () => {
    const pd = (car: ArchetypeId, bT: number) => driftHold({ car, surface: 'gravel' }, bT, { ki: 0 });
    inRange(pd('awd_wrc', 20).meanBeta, 9, 17);
    inRange(pd('awd_wrc', 30).meanBeta, 15, 26);
    expect(pd('fwd_hatch', 30).meanBeta).toBeLessThan(8);
    expect(pd('rwd_classic', 20).inBandPct).toBeGreaterThanOrEqual(90);
  });
  it('sand / mud (the original loose rally surfaces, §4.3 v1.3): awd mud ≥ 35° (sim 40°) but sand only 10-20° (sim 10°: under-rotates); fwd 0°; rwd ≥ 35°', () => {
    expect(hold('awd_wrc', 'mud').maxHeld).toBeGreaterThanOrEqual(35);
    inRange(hold('awd_wrc', 'sand').maxHeld, 10, 20);
    expect(row('awd_wrc', 'sand', 30).meanBeta).toBeLessThan(27);
    for (const s of ['sand', 'mud'] as SurfaceId[]) {
      expect(hold('fwd_hatch', s).maxHeld, s).toBe(0);
      expect(hold('rwd_classic', s).maxHeld, s).toBeGreaterThanOrEqual(35);
    }
  });
});

// =====================================================================================================
describe('§7 T9-T12 power understeer / oversteer, lift-off, yaw response', () => {
  // §7.1 v1.2: T9-T11 start from a steady 3 s straight (turbo at idle), then the 4 s cornering bot, then the step.
  // The result still depends on the entry history (the 4 s corner is a transient: β and the turbo keep moving), so
  // the bounds are bands over the histories below; the v1.1 spec-literal numbers are pinned as a reference.
  const HISTORIES: { entry: 'none' | 'left' | 'right'; hold: number }[] = [
    { entry: 'none', hold: 3 },
    { entry: 'none', hold: 6 },
    { entry: 'left', hold: 3 },
    { entry: 'right', hold: 3 },
  ];
  it('T9 fwd power understeer: r grows ≥ +25 % in the window and at 1 s (steer 0.45); steer 0.6: ≥ +25 % window, > +100 % at 1 s', () => {
    for (const h of HISTORIES) {
      const a = powerStep({ car: 'fwd_hatch' }, 0.45, 'power', h);
      const b = powerStep({ car: 'fwd_hatch' }, 0.6, 'power', h);
      expect(a.drWinPct, JSON.stringify(h)).toBeGreaterThanOrEqual(25);
      expect(a.drEndPct, JSON.stringify(h)).toBeGreaterThanOrEqual(25);
      expect(b.drWinPct, JSON.stringify(h)).toBeGreaterThanOrEqual(25);
      expect(b.drEndPct, JSON.stringify(h)).toBeGreaterThan(100);
    }
  });
  it('T10 awd mild power oversteer: r shrinks ≥ 2 % (window; band -3…-13 %), β reaches 15-22° by 1 s; steer 0.6: |Δr| < 15 %', () => {
    for (const h of HISTORIES) {
      const a = powerStep({ car: 'awd_wrc' }, 0.45, 'power', h);
      expect(a.drWinPct, JSON.stringify(h)).toBeLessThanOrEqual(-2);
      inRange(a.betaMax, 15, 22);
      const b = powerStep({ car: 'awd_wrc' }, 0.6, 'power', h);
      expect(Math.abs(b.drWinPct), JSON.stringify(h)).toBeLessThan(15);
    }
  });
  it('T11 lift-off rotation: awd |β| 5-8° → > 40°, yaw-rate peak ≥ 1.55× (band 1.6-1.8); fwd no snap (ratio ≈ 1, β unchanged)', () => {
    for (const h of HISTORIES) {
      const a = powerStep({ car: 'awd_wrc' }, 0.45, 'lift', h);
      inRange(a.beta0, 5, 8);
      expect(a.betaMax, JSON.stringify(h)).toBeGreaterThan(40);
      expect(a.yawRatio, JSON.stringify(h)).toBeGreaterThanOrEqual(1.55);
      const f = powerStep({ car: 'fwd_hatch' }, 0.45, 'lift', h);
      inRange(f.yawRatio, 0.9, 1.1);
      expect(Math.abs(f.betaMax - f.beta0)).toBeLessThan(3);
    }
  });
  it('T9-T11 spec-literal v1.1 protocol (reference: no steady straight): awd -18 % / 1.96×, fwd +27 % / +224 % at 1 s', () => {
    const t10 = powerStep({ car: 'awd_wrc' }, 0.45, 'power', { start: 'spec' });
    expect(t10.drWinPct).toBeLessThanOrEqual(-10);
    inRange(t10.betaMax, 12, 20);
    const t11 = powerStep({ car: 'awd_wrc' }, 0.45, 'lift', { start: 'spec' });
    expect(t11.yawRatio).toBeGreaterThanOrEqual(1.8);
    const t9 = powerStep({ car: 'fwd_hatch' }, 0.6, 'power', { start: 'spec' });
    expect(t9.drEndPct).toBeGreaterThan(100);
  });
  const T12: [SurfaceId, [number, number], [number, number]][] = [
    ['tarmac', [0.11, 0.17], [0.51, 0.54]],
    ['gravel', [0.12, 0.17], [0.46, 0.49]],
    ['snow', [0.12, 0.17], [0.4, 0.43]],
  ];
  for (const [surface, t63, yaw] of T12) {
    it(`T12 awd ${surface}: t63 ${t63.join('-')} s, yaw rate at 1 s ${yaw.join('-')} rad/s`, () => {
      const r = t12Step({ surface });
      inRange(r.t63, t63[0], t63[1]);
      inRange(r.yaw1s, yaw[0], yaw[1]);
    });
  }
  it('T12 fwd / rwd: t63 ≤ 0.4 s on every surface', () => {
    for (const car of ['fwd_hatch', 'rwd_classic'] as const) for (const [surface] of T12) expect(t12Step({ car, surface }).t63).toBeLessThanOrEqual(0.4);
  });
});

// =====================================================================================================
describe('§7 T13-T15 crests and jumps', () => {
  // Crest profile (the spec gives only "flat, convex arc R 40 m spanning 15 m, then a 5 % downslope"): flat road, a
  // concave 20 m blend up into the convex 40 m arc (15 m span, apex in the middle), a concave 20 m blend into the 5 %
  // downslope. With this reading the car rises after take-off, as T14's "rising / falling" accelerations imply.
  const hill = hillProfile(40, 15, 0.05, 20);
  const crest = () => createProfileWorld(hill.profile);

  it('T13 crest at 60 km/h, throttle 0.5: ≥ 3 wheels in contact throughout, airMul 1, loads near the static split, heading < 2°', () => {
    const { samples, reached } = profileRun(crest(), { vT: 60, throttle: 0.5, zSpawn: -200, zCruise: -10, zEnd: 50 });
    expect(reached).toBe(true);
    const onCrest = samples.filter((s) => s.z >= -5 && s.z <= 40);
    expect(Math.min(...onCrest.map((s) => s.nContacts))).toBeGreaterThanOrEqual(3);
    expect(Math.max(...onCrest.map((s) => s.airMul))).toBe(1);
    // static split ≈ 3850 / 3530 N; no crest unloading while the wheels touch (slope cos factor allowed)
    for (const s of onCrest) for (const l of s.loads) inRange(l, 0.8 * 3530, 1.2 * 3850);
    expect(Math.max(...samples.map((s) => Math.abs(s.heading)))).toBeLessThan(2);
  });

  it('T14 crest at 110 km/h: take-off within the arc, airMul 1.45 within 6 steps, fall accel ≈ -16.8 m/s², rates decay 1 rad/s², no bounce', () => {
    const { samples, reached } = profileRun(crest(), { vT: 110, throttle: 0.5, zSpawn: -450, zCruise: -10, zEnd: 60 });
    expect(reached).toBe(true);
    const ph = airPhases(samples);
    expect(ph.length).toBeGreaterThanOrEqual(1);
    const [a, b] = ph[0];
    // all wheels leave the ground within the arc
    inRange(samples[a].z, hill.zArc0, hill.zArc1);
    // airMul reaches 1.45 within 6 steps of fewer than 3 contacts
    const i3 = samples.findIndex((s) => s.nContacts < 3);
    expect(samples[i3 + 5].airMul).toBeCloseTo(1.45, 6);
    // free-flight vertical acceleration 1.45·(12 + AirKZY·v²/m) ± 2: ≈ -20.8 rising / -16.8 falling (± 0.5) at 110 km/h
    const air = samples.slice(a + 2, b - 1);
    const rise = air.filter((s) => s.vy > 0.3);
    const fall = air.filter((s) => s.vy < -0.3);
    const mean = (x: number[]) => x.reduce((u, v) => u + v, 0) / x.length;
    expect(rise.length).toBeGreaterThan(5);
    expect(fall.length).toBeGreaterThan(5);
    inRange(mean(rise.map((s) => s.ay)), -20.8 - 0.5, -20.8 + 0.5);
    inRange(mean(fall.map((s) => s.ay)), -16.8 - 0.5, -16.8 + 0.5);
    for (const s of [...rise, ...fall]) expect(Math.abs(s.ay - s.ayExpected)).toBeLessThan(0.5);
    // body rates decay at 1 rad/s²
    const w0 = air[0];
    const w1 = air[Math.min(air.length - 1, 24)];
    const dt = w1.t - w0.t;
    if (Math.abs(w0.wx) > dt) near((Math.abs(w0.wx) - Math.abs(w1.wx)) / dt, 1, 0.1);
    // horizontal speed decays at ≈ 2 m/s² plus drag (×airMul)
    const decel = -(air[air.length - 1].vz - air[0].vz) / (air[air.length - 1].t - air[0].t);
    inRange(decel, 2, 5);
    // airtime 0.2-0.5 s [E] (±12 %: the blends into and out of the arc are not specified)
    inRange((b - a) * DT, 0.2, 0.5 * 1.12);
    // no second airborne phase longer than 0.05 s after landing (anti-pogo)
    for (const [c, d] of ph.slice(1)) expect((d - c) * DT).toBeLessThanOrEqual(0.05);
  });

  it('T15 10° ramp at 100 km/h onto flat ground at ramp-top height: CG flight 0.45-0.6 s, ≈ 14 m, ≈ 7 km/h loss, rise/fall accel per §2.10', () => {
    const rp = rampProfile(10, 20, 30);
    const { samples } = profileRun(createProfileWorld(rp.profile), { vT: 100, throttle: 0.5, zSpawn: -450, zCruise: -10, zEnd: rp.zTop + 60 });
    const edge = samples.find((s) => s.z >= rp.zTop)!;
    const land = samples.find((s) => s.z > rp.zTop && s.vy < 0 && s.y <= edge.y)!;
    expect(land).toBeDefined();
    // [E] values are for the body's ballistic flight; the wheels hang ≈ 0.1 m below ride height at both ends, so
    // wheel-contact airtime is ≈ 0.1 s shorter (checked below)
    inRange(land.t - edge.t, 0.45, 0.6);
    near(land.z - rp.zTop, 14);
    const ph = airPhases(samples);
    const [a, b] = ph[0];
    inRange((b - a) * DT, 0.35, 0.6);
    // speed loss in the air ≈ 7 km/h [E] (2 m/s² + drag ×1.45): edge → wheel landing
    inRange(edge.kmh - samples[Math.min(b, samples.length - 1)].kmh, 5, 9);
    const air = samples.slice(a + 2, b - 1);
    const rise = air.filter((s) => s.vy > 0.3);
    const fall = air.filter((s) => s.vy < -0.3);
    expect(rise.length).toBeGreaterThan(5);
    expect(fall.length).toBeGreaterThan(5);
    for (const s of [...rise, ...fall]) expect(Math.abs(s.ay - s.ayExpected)).toBeLessThan(0.5);
    // wheel-contact airtime: one airborne phase, no bounce on landing
    for (const [c, d] of ph.slice(1)) expect((d - c) * DT).toBeLessThanOrEqual(0.05);
  });
});

// =====================================================================================================
describe('§7 T16 gearbox', () => {
  const UP: Record<ArchetypeId, number[]> = {
    awd_wrc: [40.4, 62.9, 87.3, 110.9, 139.5],
    fwd_hatch: [40.4, 62.9, 87.3, 110.9, 139.5],
    rwd_classic: [39.6, 62.9, 89.0, 115.6],
  };
  for (const car of ARCH) {
    it(`T16 ${car}: full-throttle upshifts trigger at ${UP[car].join(', ')} km/h (±1, world speed), 18 (±1) zero-drive steps each`, () => {
      const c = makeCar({ car });
      const trig: number[] = [];
      const zero: number[] = [];
      let was = false;
      let zr = 0;
      run(
        c,
        14,
        () => ctl({ throttle: 1 }),
        () => {
          const t = c.telemetry();
          if (t.shifting && !was && t.gear >= 1) trig.push(t.speedWorldKmh);
          if (t.shifting && t.wheels.every((w) => w.driveT <= 1e-9)) zr++;
          else if (zr) {
            zero.push(zr);
            zr = 0;
          }
          was = t.shifting;
        },
      );
      expect(trig.length).toBe(UP[car].length);
      trig.forEach((v, i) => expect(Math.abs(v - UP[car][i])).toBeLessThanOrEqual(1));
      for (const z of zero) inRange(z, 17, 19);
    });
  }
  it('T16 awd coast from 140 km/h: 6→5→4 back-to-back ≈ 96, then 4→3 ≈ 66, 3→2 ≈ 52, 2→1 ≈ 36 km/h', () => {
    const log = t16Coast();
    expect(log.map((l) => `${l.from}>${l.to}`)).toEqual(['6>5', '5>4', '4>3', '3>2', '2>1']);
    const exp = [96, 96, 66, 52, 36];
    log.forEach((l, i) => expect(Math.abs(l.kmhWorld - exp[i])).toBeLessThanOrEqual(2));
    expect(Math.abs(log[0].kmhWorld - log[1].kmhWorld)).toBeLessThan(1); // back-to-back
  });
  it('T16 auto reverse: brake from 30 km/h → 1st below 5 km/h, then R after 0.225 s; held brake drives backwards, throttle brakes', () => {
    const c = makeCar({});
    reachSpeed(c, 30);
    let t = 0;
    let tShift: number | null = null;
    let tR: number | null = null;
    while (t < 4) {
      c.step(ctl({ brake: 1 }), DT);
      t += DT;
      const tel = c.telemetry();
      if (tShift === null && tel.shifting) {
        tShift = t;
        expect(tel.gear).toBe(1);
        expect(tel.speedKmh).toBeLessThan(5);
      }
      if (tR === null && tel.gear === 0) tR = t;
    }
    expect(tShift).not.toBeNull();
    expect(tR).not.toBeNull();
    inRange(tR! - tShift!, 0.225 - 2 * DT, 0.225 + 2 * DT);
    const back = c.telemetry();
    expect(back.gear).toBe(0);
    expect(back.velLocal.z).toBeLessThan(-5); // the held BRAKE pedal drives backwards (pedal swap)
    expect(back.throttle).toBe(1); // effective throttle = brake pedal in auto reverse
    // the throttle pedal brakes in R: stopped within 1 s, then R→1 (swapped brake input > 0.3, stopped) and forward
    let tStop: number | null = null;
    let tFwd: number | null = null;
    run(
      c,
      3,
      () => ctl({ throttle: 1 }),
      (tt) => {
        const tl = c.telemetry();
        if (tStop === null && tl.velLocal.z > -0.5) {
          tStop = tt;
          expect(tl.gear).toBe(0);
          expect(tl.brake).toBe(1);
        }
        if (tFwd === null && tl.gear === 1 && tl.velLocal.z > 1) tFwd = tt;
      },
    );
    expect(tStop).not.toBeNull();
    expect(tStop!).toBeLessThan(1);
    expect(tFwd).not.toBeNull();
    expect(tFwd!).toBeGreaterThan(tStop!);
  });
  it('T16 manual: upshift takes 0.10 s, no auto shifting', () => {
    const c = makeCar({ params: { transmission: 'manual' } });
    run(c, 1, () => ctl({ throttle: 1 }));
    expect(c.telemetry().gear).toBe(1);
    c.step(ctl({ throttle: 1, gearUp: true }), DT);
    let n = 0;
    while (c.telemetry().shifting && n < 100) {
      c.step(ctl({ throttle: 1 }), DT);
      n++;
    }
    expect(c.telemetry().gear).toBe(2);
    inRange(n * DT, 0.1 - 2 * DT, 0.1 + 2 * DT);
    run(c, 4, () => ctl({ throttle: 1 }));
    expect(c.telemetry().gear).toBe(2);
    c.step(ctl({ gearDown: true }), DT);
    run(c, 0.2, () => ctl());
    expect(c.telemetry().gear).toBe(1);
  });
});

// =====================================================================================================
describe('§7 T17 input filter (§5.1)', () => {
  const kb = (o: object) => ({ ...neutralRawInput(), device: 'keyboard' as const, throttleDigital: true, brakeDigital: true, handbrakeDigital: true, steerDigital: true, ...o });
  it('keyboard throttle: 0.10 at the first substep, 1.0 at 0.45 s (±1 step), 0 on release', () => {
    const f = new InputFilter();
    const raw = kb({ throttle: 1 });
    expect(f.update(raw, DT).throttle).toBeCloseTo(0.1, 9);
    let n = 1;
    while (f.update(raw, DT).throttle < 1) n++;
    expect(Math.abs(n * DT - 0.45)).toBeLessThanOrEqual(DT * 1.01);
    expect(f.update(kb({}), DT).throttle).toBe(0);
  });
  it('keyboard brake 0.20 → 1.0 in 0.53 s, handbrake 0.50 → 1.0 in 0.50 s', () => {
    const f = new InputFilter();
    expect(f.update(kb({ brake: 1, handbrake: 1 }), DT).brake).toBeCloseTo(0.2, 9);
    let nb = 1;
    let nh = 1;
    for (let i = 0; i < 200; i++) {
      const c = f.update(kb({ brake: 1, handbrake: 1 }), DT);
      if (c.brake < 1) nb++;
      if (c.handbrake < 1) nh++;
    }
    expect(Math.abs(nb * DT - 0.533)).toBeLessThanOrEqual(DT * 1.5);
    expect(Math.abs(nh * DT - 0.5)).toBeLessThanOrEqual(DT * 1.5);
  });
  it('steer keys: ±0.05 then 1.0 at 0.475 s; release → 0 next substep; opposite key at +0.6 → -0.05 next substep', () => {
    const f = new InputFilter();
    expect(f.update(kb({ right: true }), DT).steer).toBeCloseTo(0.05, 9);
    let n = 1;
    while (f.update(kb({ right: true }), DT).steer < 1) n++;
    expect(Math.abs(n * DT - 0.475)).toBeLessThanOrEqual(DT * 1.01);
    expect(f.update(kb({}), DT).steer).toBe(0);
    expect(f.update(kb({ left: true }), DT).steer).toBeCloseTo(-0.05, 9);
    f.reset();
    let c = f.update(kb({ right: true }), DT);
    while (c.steer < 0.6) c = f.update(kb({ right: true }), DT);
    expect(f.update(kb({ left: true }), DT).steer).toBeCloseTo(-0.05, 9);
  });
});

// =====================================================================================================
describe('§7 T18 deep surfaces, T19 reset (sim part), T20 determinism', () => {
  it('T18 awd gravelDeep: coast 1 s from 80 km/h decelerates 8-11 m/s²', () => {
    inRange(t18Deep(), 8, 11);
  });
  it('T18 grass (DEEP, tarmac tyres): μ 0.34 of tarmac, ×1.4 lateral factor → lateral grip 0.34-0.48 of tarmac', () => {
    const tar = t4Lateral({ surface: 'tarmac', tyre: 0 }, 60, [0.3, 0.45, 0.6]).unfiltered;
    const g = t4Lateral({ surface: 'grass', tyre: 0 }, 60, [0.3, 0.45, 0.6, 0.8]);
    const gNoDeep = t4Lateral({ surface: 'grass', tyre: 0, params: { useSideFriction: false } }, 60, [0.3, 0.45, 0.6, 0.8]);
    inRange(g.unfiltered / tar, 0.34, 0.34 * 1.4);
    // the ×1.4 is partly offset by the W18 side fill (head = μFz - |Fy| goes negative), but it is a net gain. The
    // grass runs spin (β 7-38°, speed 20-60 km/h), so a single run's maximum is chaotic (a 2 mm different start
    // height flips it); compare the mean over the steer set instead.
    const meanA = (r: typeof g) => r.runs.reduce((s, x) => s + Math.abs(x.aLat), 0) / r.runs.length;
    expect(meanA(g)).toBeGreaterThan(meanA(gNoDeep));
  });
  it('T19 (sim part): reset +1.5 m above the line, aligned: settles in 100 steps, at rest, heading kept', () => {
    const c = makeCar({});
    run(c, 3, () => ctl({ throttle: 1, steer: 0.4 }));
    c.reset({ pos: { x: 5, y: 1.5, z: 20 }, q: qYawSim(0.7) });
    const t = c.telemetry();
    expect(t.speedKmh).toBeLessThan(1);
    expect(t.nContacts).toBe(4);
    inRange(t.posSim.y, 0.35, 0.5);
    expect(Math.abs(Math.atan2(2 * (t.quatSim.x * t.quatSim.z + t.quatSim.w * t.quatSim.y), 1 - 2 * (t.quatSim.x ** 2 + t.quatSim.y ** 2)) - 0.7)).toBeLessThan(0.01);
    for (const w of t.wheels) expect(Math.abs(w.omega)).toBeLessThan(1);
  });
  it('T20 two identical T1 runs are bit-identical (every step)', () => {
    const trace = () => {
      const c = makeCar({ surface: 'gravel', seed: 7 });
      const out: string[] = [];
      run(
        c,
        12,
        (t) => (t < 6 ? ctl({ throttle: 1 }) : cornering(c, 120, 0.3)),
        () => out.push(JSON.stringify(c.telemetry())),
      );
      return out.join('\n');
    };
    expect(trace()).toBe(trace());
  });
});
