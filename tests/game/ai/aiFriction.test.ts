/**
 * AI friction mode (CarSimOptions.aiFriction; MECHANICS_SPEC §4.2, research/formats/ai.md §10 [E 0x6c4978-0x6c49ac,
 * 0x6cb6cb]): the tarmac tyre rows on every surface and frictionLevel = min(FL, 0), on a private copy of the table.
 * With the option off the car is bit-identical to a car built without it.
 */
import { describe, expect, it } from 'vitest';
import { DT, MATCHED_TYRE } from '../../../src/core/constants';
import type { Controls, SurfaceId } from '../../../src/core/types';
import { aiFrictionTable, CarSim } from '../../../src/sim/car';
import { makeCarParams, makeSurfaceTable } from '../../../src/sim/params';
import { createFlatWorld, flatSpawnPose } from '../../sim/flatworld';

const ctl = (c: Partial<Controls>): Controls => ({ steer: 0, throttle: 0, brake: 0, handbrake: 0, gearUp: false, gearDown: false, ...c });

function drive(surface: SurfaceId, opts: { aiFriction?: boolean; surfaces?: ReturnType<typeof makeSurfaceTable> }, steps: number) {
  const world = createFlatWorld({ surface });
  const car = new CarSim({ params: makeCarParams('awd_wrc', { tyreType: MATCHED_TYRE[surface] }), world, surfaces: opts.surfaces ?? makeSurfaceTable(), seed: 1, ...(opts.aiFriction === undefined ? {} : { aiFriction: opts.aiFriction }) });
  car.reset(flatSpawnPose(world, 0, 0, 0, 0.4225), 100);
  const log: number[] = [];
  for (let i = 0; i < steps; i++) {
    car.step(ctl({ throttle: i < 360 ? 1 : 0, brake: i >= 360 ? 1 : 0, steer: i > 120 && i < 240 ? 0.3 : 0 }), DT);
    const t = car.telemetry();
    log.push(t.posSim.x, t.posSim.z, t.speedKmh, t.yawRate);
  }
  return log;
}

describe('AI friction mode', () => {
  it('aiFrictionTable: tarmac rows on every surface, FL = min(FL, 0), a private copy', () => {
    const src = makeSurfaceTable();
    const before = JSON.stringify(src);
    const ai = aiFrictionTable(src);
    expect(JSON.stringify(src)).toBe(before); // the source is untouched
    expect(ai).not.toBe(src);
    for (const k of Object.keys(src) as SurfaceId[]) {
      expect(ai[k]).not.toBe(src[k]);
      expect(ai[k].frictionLevel).toBe(Math.min(src[k].frictionLevel, 0));
      for (let t = 0; t < 5; t++) {
        const r = ai[k].tyre[t];
        const a = src.tarmac.tyre[t];
        expect([r.bestStatic, r.diffStatic, r.scaleKinetic, r.bestRollK]).toEqual([a.bestStatic, a.diffStatic, a.scaleKinetic, a.bestRollK]);
        // every other tyre-row field and the surface's non-friction data survive
        expect({ ...r, bestStatic: 0, diffStatic: 0, scaleKinetic: 0, bestRollK: 0 }).toEqual({ ...src[k].tyre[t], bestStatic: 0, diffStatic: 0, scaleKinetic: 0, bestRollK: 0 });
      }
      expect({ ...ai[k], tyre: 0, frictionLevel: 0 }).toEqual({ ...src[k], tyre: 0, frictionLevel: 0 });
    }
    // the table has surfaces whose FL was positive or whose rows differ, so the test is not vacuous
    expect(Object.values(src).some((d) => d.frictionLevel !== Math.min(d.frictionLevel, 0))).toBe(true);
    expect(Object.keys(src).some((k) => src[k as SurfaceId].tyre[2].bestStatic !== src.tarmac.tyre[2].bestStatic)).toBe(true);
  });

  it('off: bit-identical telemetry to a car built without the option (tarmac and gravel, 600 steps)', () => {
    for (const surface of ['tarmac', 'gravel'] as SurfaceId[]) {
      const a = drive(surface, {}, 600);
      const b = drive(surface, { aiFriction: false }, 600);
      expect(b).toEqual(a);
    }
  });

  it('on: a car on gravel behaves exactly like the same car on a table whose every row is the tarmac row', () => {
    const t = makeSurfaceTable();
    const allTarmac = aiFrictionTable(t); // the same transformation applied by hand
    const ai = drive('gravel', { aiFriction: true }, 600);
    const manual = drive('gravel', { surfaces: allTarmac }, 600);
    expect(ai).toEqual(manual);
    const normal = drive('gravel', {}, 600);
    expect(ai).not.toEqual(normal); // and it differs from the real gravel car (the grip is the tarmac grip)
    // tarmac grip on gravel: the full-throttle phase accelerates harder, so the car is further along after 360 steps
    const zAt = (log: number[], step: number) => log[4 * step + 1];
    expect(zAt(ai, 359)).toBeGreaterThan(zAt(normal, 359));
  });

  it('does not touch the table it was given (the player keeps the real surfaces)', () => {
    const shared = makeSurfaceTable();
    const before = JSON.stringify(shared);
    drive('gravel', { aiFriction: true, surfaces: shared }, 50);
    expect(JSON.stringify(shared)).toBe(before);
  });
});
