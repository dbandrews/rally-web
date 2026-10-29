/**
 * tests/sim/presets.test.ts — OWNED BY THE SIM BUILDER.
 *
 * The built-in, NON-default tuning presets of src/sim/presets.ts (docs/MECHANICS_SPEC.md §6.1, v1.3):
 *  - structure: every override path exists in the shipped parameters, values sit inside the §6 panel ranges, the
 *    shipped ARCHETYPE_PARAMS are never mutated;
 *  - "Arcade drift" (DEVIATION): awd_wrc / fwd_hatch hold power slides (spec §7 drift-hold probe), with bounded side
 *    effects on the §7 tests (values re-derived by running the model, artifacts/audit/preset_side.audit.ts);
 *  - "orig: class-4 AWD car": the original's high-power 4WD class medians (spec §3.2 v1.3).
 */
import { describe, expect, it } from 'vitest';
import { deepClone, getPath } from '../../src/core/paths';
import type { ArchetypeId, CarParams, DeepPartial } from '../../src/core/types';
import { TUNING_SCHEMA } from '../../src/debug/tuningSchema';
import { ARCHETYPE_PARAMS, makeCarParams } from '../../src/sim/params';
import { presetCarParams, presetOverrides, TUNING_PRESETS } from '../../src/sim/presets';
import { driftHold, makeCar, maxHoldableBeta, powerStep, t1Accel, t3Brake, t4Lateral, t6Recovery, t8Power } from './harness';

const ARCH: ArchetypeId[] = ['awd_wrc', 'fwd_hatch', 'rwd_classic'];
const ARCADE = TUNING_PRESETS.find((p) => p.id === 'arcade-drift')!;
const CLASS4 = TUNING_PRESETS.find((p) => p.id === 'orig-class4-awd')!;

function leaves(o: unknown, prefix = ''): [string, unknown][] {
  if (Array.isArray(o) || o === null || typeof o !== 'object') return [[prefix, o]];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe('built-in presets: structure', () => {
  it('two presets: "Arcade drift" is labelled a DEVIATION, the class-4 car is original data', () => {
    expect(ARCADE.kind).toBe('deviation');
    expect(ARCADE.label).toContain('DEVIATION');
    expect(CLASS4.kind).toBe('original');
    expect(CLASS4.archetype).toBe('awd_wrc');
  });

  it('every override path exists in the shipped parameters with the same value type; values inside the §6 panel ranges', () => {
    const ranges = new Map<string, [number, number]>();
    // (derived specs, e.g. mountY = wheel y − wheelRadius, have ranges in their own units: skipped)
    for (const f of TUNING_SCHEMA) for (const s of f.params) if (!s.derived && s.min !== undefined && s.max !== undefined) for (const p of s.paths) ranges.set(p, [s.min, s.max]);
    for (const pr of TUNING_PRESETS) {
      for (const car of pr.archetype ? [pr.archetype] : ARCH) {
        const shipped = ARCHETYPE_PARAMS[car];
        for (const [path, v] of leaves(presetOverrides(pr, car))) {
          const sv = getPath(shipped, path);
          expect(sv, `${pr.id}/${car}: ${path} exists`).not.toBeUndefined();
          expect(Array.isArray(v) ? 'array' : typeof v, `${pr.id}/${car}: ${path} type`).toBe(Array.isArray(sv) ? 'array' : typeof sv);
          const r = ranges.get(path);
          if (r && typeof v === 'number') {
            expect(v, `${pr.id}: ${path} ≥ ${r[0]}`).toBeGreaterThanOrEqual(r[0]);
            expect(v, `${pr.id}: ${path} ≤ ${r[1]}`).toBeLessThanOrEqual(r[1]);
          }
        }
      }
    }
  });

  it('applying a preset never mutates the shipped parameters and keeps the race-selection choices', () => {
    const before = deepClone(ARCHETYPE_PARAMS);
    const keep: DeepPartial<CarParams> = { tyreType: 2, transmission: 'manual', steerSensFast: false, setup: { brake: 1.2, powerRatio: 0.8 } };
    for (const car of ARCH) {
      const p = presetCarParams(ARCADE, car, keep);
      expect(p.archetype).toBe(car);
      expect(p.tyreType).toBe(2);
      expect(p.transmission).toBe('manual');
      expect(p.steerSensFast).toBe(false);
      expect(p.setup.brake).toBe(1.2);
      expect(p.wheel.front.twKinSteer).toBe(2.5);
      expect(p.turboSpinup).toBe(0.5);
    }
    expect(presetCarParams(ARCADE, 'awd_wrc').setup.awdBaseSplit).toBe(0.8);
    expect(presetCarParams(ARCADE, 'fwd_hatch').fwdFrontBias).toBe(1.1);
    expect(presetCarParams(ARCADE, 'rwd_classic').rwdRearBias).toBe(ARCHETYPE_PARAMS.rwd_classic.rwdRearBias);
    // the class-4 preset switches to the awd body whatever the current archetype is
    expect(presetCarParams(CLASS4, 'fwd_hatch').archetype).toBe('awd_wrc');
    expect(ARCHETYPE_PARAMS).toEqual(before);
    expect(makeCarParams('awd_wrc')).toEqual(before.awd_wrc);
  });
});

// =====================================================================================================
describe('"Arcade drift" (DEVIATION): holdable AWD / FWD slides, bounded side effects', () => {
  const params = (car: ArchetypeId) => presetOverrides(ARCADE, car);
  it('gravel max holdable β (counter-steer controller, §7 probe): awd ≥ 35° (sim 40°), fwd ≥ 35° (sim 40°; shipped 0°), rwd ≥ 40° (sim 45°)', () => {
    expect(maxHoldableBeta({ car: 'awd_wrc', surface: 'gravel', params: params('awd_wrc') }).maxHeld).toBeGreaterThanOrEqual(35);
    expect(maxHoldableBeta({ car: 'fwd_hatch', surface: 'gravel', params: params('fwd_hatch') }).maxHeld).toBeGreaterThanOrEqual(35);
    expect(maxHoldableBeta({ car: 'rwd_classic', surface: 'gravel', params: params('rwd_classic') }).maxHeld).toBeGreaterThanOrEqual(40);
  });
  it('a 30° awd drift needs far less steer into the turn (sim +0.20 against +0.68 shipped); fwd holds 30° in band', () => {
    const a = driftHold({ car: 'awd_wrc', params: params('awd_wrc') }, 30);
    const s = driftHold({ car: 'awd_wrc' }, 30);
    expect(a.held).toBe(true);
    expect(a.meanSteer).toBeLessThanOrEqual(0.35);
    expect(s.meanSteer).toBeGreaterThanOrEqual(0.55);
    const f = driftHold({ car: 'fwd_hatch', params: params('fwd_hatch') }, 30);
    expect(f.held).toBe(true);
    expect(f.inBandPct).toBeGreaterThanOrEqual(90);
  });
  it('the original loose rally surfaces too: awd ≥ 35° on sand and mud (sim 45° / 40°), fwd ≥ 35° (sim 40° / 40°)', () => {
    for (const surface of ['sand', 'mud'] as const) {
      expect(maxHoldableBeta({ car: 'awd_wrc', surface, params: params('awd_wrc') }).maxHeld, surface).toBeGreaterThanOrEqual(35);
      expect(maxHoldableBeta({ car: 'fwd_hatch', surface, params: params('fwd_hatch') }).maxHeld, surface).toBeGreaterThanOrEqual(35);
    }
  });
  it('still safe on tarmac: T6 recovery < 1 s (sim 0.45-0.52 s), T7 max |β| ≤ 4° from every start state (sim 3.0-3.4°)', () => {
    for (const car of ARCH) {
      const r = t6Recovery({ car, params: params(car) });
      expect(r.tBelow5, car).not.toBeNull();
      expect(r.tBelow5!, car).toBeLessThan(1);
      for (const start of ['spec', 'steady', 'spooled'] as const) expect(t8Power({ car, surface: 'tarmac', params: params(car) }, 100, start, 3).maxBeta, `${car} ${start}`).toBeLessThanOrEqual(4);
    }
  });
  it('fwd keeps its power understeer on corner entry (T9 window ≥ +25 %, sim +58 %); awd no longer tightens on power (T10 sim +4 %)', () => {
    expect(powerStep({ car: 'fwd_hatch', params: params('fwd_hatch') }, 0.45, 'power').drWinPct).toBeGreaterThanOrEqual(25);
    expect(powerStep({ car: 'awd_wrc', params: params('awd_wrc') }, 0.45, 'power').drWinPct).toBeGreaterThan(-2);
  });
  it('brakes and tarmac grip unchanged (T3 gravel ±3 %, T4 tarmac unfiltered ±6 %); 0-100 km/h quicker because the boost spools 2× faster (×0.84-0.92)', () => {
    for (const car of ARCH) {
      const b0 = t3Brake({ car, surface: 'gravel' })!.dist;
      const b1 = t3Brake({ car, surface: 'gravel', params: params(car) })!.dist;
      expect(Math.abs(b1 / b0 - 1), car).toBeLessThanOrEqual(0.03);
      const g = (p?: DeepPartial<CarParams>) => Math.max(t4Lateral({ car, surface: 'tarmac', params: p }, 60).unfiltered, t4Lateral({ car, surface: 'tarmac', params: p }, 100).unfiltered);
      expect(Math.abs(g(params(car)) / g() - 1), car).toBeLessThanOrEqual(0.06);
      const r = t1Accel({ car, surface: 'tarmac', params: params(car) }, 12).t100! / t1Accel({ car, surface: 'tarmac' }, 12).t100!;
      expect(r, car).toBeGreaterThanOrEqual(0.8);
      expect(r, car).toBeLessThanOrEqual(0.95);
    }
  });
});

// =====================================================================================================
describe('"orig: class-4 AWD car" (original data, spec §3.2 v1.3)', () => {
  const params = presetOverrides(CLASS4, 'awd_wrc');
  it('class-4 4WD medians: 1030 kg, TorqueScale 1340, 5 gears, front axle 55.1 % (frontShare2 1.1025)', () => {
    const car = makeCar({ params, surface: 'tarmac' });
    expect(car.params.mass).toBe(1030);
    expect(car.params.torqueScale).toBe(1340);
    expect(car.params.nGears).toBe(5);
    expect(car.debug().frontShare2).toBeCloseTo(1.1025, 4);
  });
  it('holds bigger slides than awd_wrc with less steer: max holdable ≥ 40° (sim 45°), 30° at steer +0.51 (awd_wrc +0.68)', () => {
    expect(maxHoldableBeta({ car: 'awd_wrc', surface: 'gravel', params }).maxHeld).toBeGreaterThanOrEqual(40);
    const c4 = driftHold({ car: 'awd_wrc', params }, 30);
    const s = driftHold({ car: 'awd_wrc' }, 30);
    expect(c4.held).toBe(true);
    expect(c4.meanSteer).toBeLessThan(s.meanSteer - 0.1);
  });
  it('0-100 km/h on tarmac 3.5 s ±12 % (awd_wrc 4.5 s), no tarmac power slide (T7 ≤ 4°)', () => {
    const t = t1Accel({ car: 'awd_wrc', surface: 'tarmac', params }, 12).t100!;
    expect(Math.abs(t - 3.51)).toBeLessThanOrEqual(3.51 * 0.12);
    expect(t8Power({ car: 'awd_wrc', surface: 'tarmac', params }, 100, 'spooled', 3).maxBeta).toBeLessThanOrEqual(4);
  });
});
