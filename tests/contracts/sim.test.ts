/**
 * tests/contracts/sim.test.ts — ARCHITECT-OWNED cross-module contract for src/sim (ICarSim, InputFilter).
 * Feel/physics validation (§7) lives in tests/sim/ (sim builder); this file checks what the other modules
 * rely on: telemetry completeness, determinism (§7 T20), reset/settle, params, freeze, filter edges.
 */
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_IDS, DT, neutralRawInput } from '../../src/core/constants';
import type { Controls } from '../../src/core/types';
import { CarSim } from '../../src/sim/car';
import { InputFilter } from '../../src/sim/inputFilter';
import { makeCarParams, makeSurfaceTable } from '../../src/sim/params';
import { jsonSafetyIssue } from '../helpers/json';
import { createFlatWorld, flatSpawnPose } from '../sim/flatworld';

const ctl = (c: Partial<Controls>): Controls => ({ steer: 0, throttle: 0, brake: 0, handbrake: 0, gearUp: false, gearDown: false, ...c });

function drive(car: CarSim, steps: number, f: (i: number) => Partial<Controls>) {
  for (let i = 0; i < steps; i++) car.step(ctl(f(i)), DT);
}

describe.each(ARCHETYPE_IDS.map((id) => [id]))('CarSim %s', (id) => {
  it('reset settles on the ground and telemetry is complete and JSON-safe', () => {
    const world = createFlatWorld({ surface: 'gravel' });
    const car = new CarSim({ params: makeCarParams(id, { tyreType: 2 }), world, surfaces: makeSurfaceTable(), seed: 3 });
    expect(car.archetype).toBe(id);
    car.reset(flatSpawnPose(world));
    const t = car.telemetry();
    expect(t.resetCount).toBe(1);
    expect(t.archetype).toBe(id);
    expect(t.wheels).toHaveLength(4);
    expect(t.simTime).toBeCloseTo(t.stepCount * DT, 9);
    expect(t.speedKmh).toBeLessThan(1);
    expect(t.nContacts).toBeGreaterThanOrEqual(3);
    expect(t.posSim.y).toBeGreaterThan(0.2);
    expect(t.posSim.y).toBeLessThan(0.8);
    expect(t.pos.z).toBeCloseTo(-t.posSim.z, 9); // three = mirror(sim)
    for (const w of t.wheels) {
      expect(w.contact).toBe(true);
      expect(w.surface).toBe('gravel');
      expect(w.load).toBeGreaterThan(0);
      expect(w.visual.centreLocal.y).toBeLessThan(0.3);
    }
    expect(jsonSafetyIssue(t)).toBeNull();
  });

  it('drives forward (+z sim) under throttle and steers right with +steer', () => {
    const world = createFlatWorld();
    const car = new CarSim({ params: makeCarParams(id), world, seed: 1 });
    car.reset(flatSpawnPose(world));
    drive(car, 360, () => ({ throttle: 1 }));
    const a = car.telemetry();
    expect(a.posSim.z).toBeGreaterThan(5);
    expect(a.speedKmh).toBeGreaterThan(30);
    drive(car, 120, () => ({ throttle: 0.5, steer: 0.5 }));
    const b = car.telemetry();
    expect(b.posSim.x).toBeGreaterThan(a.posSim.x); // turned toward +x = right
    expect(b.yawRate).toBeGreaterThan(0);
  });

  it('is deterministic for identical inputs and seed (§7 T20)', () => {
    const run = () => {
      const world = createFlatWorld({ surface: 'tarmac' });
      const car = new CarSim({ params: makeCarParams(id), world, seed: 42 });
      car.reset(flatSpawnPose(world));
      drive(car, 900, (i) => ({ throttle: 1, steer: i > 400 ? 0.3 : 0, handbrake: i > 600 && i < 650 ? 1 : 0 }));
      return JSON.stringify(car.telemetry());
    };
    expect(run()).toBe(run());
  });

  it('setParams, archetype switch, freeze and reset behave', () => {
    const world = createFlatWorld();
    const car = new CarSim({ params: makeCarParams(id), world });
    car.reset(flatSpawnPose(world));
    car.setParams({ mass: 1111, wheel: { front: { springK: 40000 } } });
    expect(car.params.mass).toBe(1111);
    expect(car.params.wheel.front.springK).toBe(40000);
    expect(car.params.wheel.rear.springK).toBe(35000);
    const other = id === 'rwd_classic' ? 'awd_wrc' : 'rwd_classic';
    car.setParams(makeCarParams(other));
    drive(car, 10, () => ({}));
    expect(car.telemetry().archetype).toBe(other);
    expect(car.telemetry().nGears).toBe(makeCarParams(other).nGears);
    car.setFrozen(true);
    const n = car.telemetry().stepCount;
    drive(car, 10, () => ({ throttle: 1 }));
    expect(car.telemetry().stepCount).toBe(n);
    car.setFrozen(false);
    drive(car, 240, () => ({ throttle: 1 }));
    car.reset(flatSpawnPose(world, 10, 10, Math.PI / 2));
    const t = car.telemetry();
    expect(t.resetCount).toBe(2);
    expect(t.speedKmh).toBeLessThan(1);
    expect(t.posSim.x).toBeCloseTo(10, 0);
  });
});

describe('InputFilter contract', () => {
  it('passes gear edges through for exactly the substep they are given', () => {
    const f = new InputFilter();
    const raw = { ...neutralRawInput(), gearUp: true };
    expect(f.update(raw, DT).gearUp).toBe(true);
    expect(f.update({ ...raw, gearUp: false }, DT).gearUp).toBe(false);
  });
  it('keyboard throttle ramps 0.10 → 1.0 in ~0.45 s and drops to 0 on release (§5.1, T17)', () => {
    const f = new InputFilter();
    const raw = { ...neutralRawInput(), device: 'keyboard' as const, throttleDigital: true, throttle: 1 };
    expect(f.update(raw, DT).throttle).toBeCloseTo(0.1, 9);
    let n = 1;
    while (f.update(raw, DT).throttle < 1 && n < 200) n++;
    expect(Math.abs(n * DT - 0.45)).toBeLessThanOrEqual(DT * 1.5);
    expect(f.update({ ...raw, throttle: 0 }, DT).throttle).toBe(0);
  });
});
