/**
 * tests/contracts/game.test.ts — ARCHITECT-OWNED cross-module contract for the DOM-free parts of src/game
 * (RaceController, Autopilot). Runs on the real world + sim modules.
 */
import { describe, expect, it } from 'vitest';
import { DT } from '../../src/core/constants';
import type { Controls } from '../../src/core/types';
import { Autopilot } from '../../src/game/autopilot';
import { RaceController } from '../../src/game/race';
import { CarSim } from '../../src/sim/car';
import { makeCarParams } from '../../src/sim/params';
import { buildStage, listStages } from '../../src/world/stages';

function setup(stageId = 'testpad') {
  const { stage, world } = buildStage(stageId, 1);
  const car = new CarSim({ params: makeCarParams('awd_wrc', { tyreType: stage.defaultTyre }), world, seed: 1 });
  const race = new RaceController();
  return { stage, world, car, race };
}

describe('RaceController', () => {
  it('begin → idle & parked at the start; startNow → running & controllable; clock in sim time', () => {
    const { stage, car, race } = setup();
    race.begin(stage, car, { countdown: false });
    expect(race.state.phase).toBe('idle');
    expect(race.isControllable()).toBe(false);
    expect(car.telemetry().resetCount).toBeGreaterThanOrEqual(1);
    const p = stage.project(car.telemetry().pos);
    expect(Math.abs(p.s - stage.startS)).toBeLessThan(3);
    race.startNow();
    expect(race.state.phase).toBe('running');
    expect(race.isControllable()).toBe(true);
    for (let i = 0; i < 120; i++) {
      car.step({ steer: 0, throttle: 1, brake: 0, handbrake: 0, gearUp: false, gearDown: false }, DT);
      race.fixedUpdate(DT, car.telemetry());
    }
    expect(race.state.time).toBeCloseTo(1, 6);
    expect(race.state.s).toBeGreaterThan(stage.startS);
    expect(race.drainEvents().some((e) => e.type === 'go')).toBe(true);
    expect(race.drainEvents()).toEqual([]);
  });

  it('countdown runs in sim time and ends in running', () => {
    const { stage, car, race } = setup();
    race.begin(stage, car, { countdown: true });
    expect(race.isControllable()).toBe(false);
    let n = 0;
    while (race.state.phase !== 'running' && n < 120 * 10) {
      car.step({ steer: 0, throttle: 0, brake: 0, handbrake: 1, gearUp: false, gearDown: false }, DT);
      race.fixedUpdate(DT, car.telemetry());
      n++;
    }
    expect(race.state.phase).toBe('running');
    expect(n * DT).toBeGreaterThan(1);
    expect(n * DT).toBeLessThan(6);
  });

  it("'api' reset and teleport place the car on the spline immediately", () => {
    const { stage, car, race } = setup();
    race.begin(stage, car, { countdown: false });
    race.startNow();
    const before = car.telemetry().resetCount;
    race.teleport(stage.startS + 100, 2);
    const t = car.telemetry();
    expect(t.resetCount).toBe(before + 1);
    const pr = stage.project(t.pos, stage.startS + 100);
    expect(Math.abs(pr.s - (stage.startS + 100))).toBeLessThan(2);
    expect(pr.lateral).toBeCloseTo(2, 0);
    race.requestReset('api');
    expect(car.telemetry().resetCount).toBe(before + 2);
    expect(race.state.resets).toBeGreaterThanOrEqual(1);
  });
});

describe('Autopilot', () => {
  it.each(listStages().map((s) => [s.id]))('makes progress on %s within 20 s and returns valid controls', (id) => {
    const { stage, car, race } = setup(id);
    const ap = new Autopilot();
    race.begin(stage, car, { countdown: false });
    race.startNow();
    const s0 = race.state.s;
    for (let i = 0; i < 120 * 20; i++) {
      const c: Controls = ap.update(DT, car.telemetry(), stage, race.state);
      expect(c.steer).toBeGreaterThanOrEqual(-1);
      expect(c.steer).toBeLessThanOrEqual(1);
      expect(c.throttle).toBeGreaterThanOrEqual(0);
      expect(c.throttle).toBeLessThanOrEqual(1);
      car.step(c, DT);
      race.fixedUpdate(DT, car.telemetry());
      if (race.state.phase === 'finished') break;
    }
    const progressed = stage.closed ? race.state.lap > 1 || race.state.s !== s0 : race.state.s - s0;
    expect(progressed).toBeTruthy();
    if (!stage.closed) expect(race.state.s - s0).toBeGreaterThan(100);
  });
});
