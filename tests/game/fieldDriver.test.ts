/**
 * tests/game/fieldDriver.test.ts — OWNED BY THE AI-RACE BUILDER. CarField with the REAL AI controller (ai-brain's
 * createAiDriver) on a real (procedural-world) ported stage, the cars being the kinematic bicycle model of fakes.ts glued to the
 * road height: the field↔driver contract end to end without a browser (parked until GO, the grid, steering along the road,
 * laps / finish, standings, no automatic resets). The physics itself is covered by the browser run (tools/ai-race.mjs).
 */
import { describe, expect, it } from 'vitest';
import { DT } from '../../src/core/constants';
import type { AiOpponentSpec, FieldHost, FieldStepContext } from '../../src/core/field';
import type { ICarSim, RaceSelection, RaceState, Stage } from '../../src/core/types';
import { CarField } from '../../src/game/field';
import { RaceController } from '../../src/game/race';
import { MemoryStore } from '../../src/game/storage';
import { buildStage } from '../../src/world/stages';
import { FakeCar } from './fakes';

/** A FakeCar that stays on the road surface (the fake world has no ground). */
class RoadCar extends FakeCar {
  stage: Stage | null = null;
  override step(c: Parameters<FakeCar['step']>[0], dt: number): void {
    super.step(c, dt);
    if (this.stage) this.pos.y = this.stage.project(this.pos, undefined).point.y + 0.4;
  }
  override reset(pose: Parameters<FakeCar['reset']>[0]): void {
    super.reset(pose);
  }
}

const SPEC = (i: number, car: string): AiOpponentSpec => ({ id: `ai${i}`, origCar: car, archetype: 'awd_wrc', name: car, skill: 1, tyreScale: 1, gridIndex: i, slotBase: 24 * i });

async function field(stageId: string, n: number) {
  const { stage, world } = buildStage(stageId, 1);
  const cars: RoadCar[] = [];
  const host: FieldHost = {
    createCar(sp: AiOpponentSpec): ICarSim {
      const c = new RoadCar();
      c.stage = stage;
      Object.defineProperty(c, 'id', { value: sp.id });
      cars.push(c);
      return c;
    },
  };
  const f = new CarField({ specs: [SPEC(1, 'AudiS1'), SPEC(2, 'Metro6R4'), SPEC(3, 'DeltaS4')] });
  const sel: RaceSelection = { stageId, archetype: 'awd_wrc', tyre: 0, transmission: 'auto', setup: {}, steerSensFast: true, seed: 1, opponents: n };
  await f.prepare(sel, stage, world, host);
  const race: RaceState = { ...new RaceController({ store: new MemoryStore() }).state, phase: 'countdown', stageId, s: (stage as unknown as { spawnS: number }).spawnS };
  f.begin(race);
  const player = new FakeCar();
  const ctx: FieldStepContext = { player: { sim: player, telemetry: player.telemetry() }, race };
  return { stage, f, cars, race, ctx };
}

describe('CarField with the real AiDriver (kinematic cars)', () => {
  it('the real driver is in use, the cars stay parked until GO, then drive the stage along the road and finish', async () => {
    const { stage, f, cars, race, ctx } = await field('hillclimb-1a-f', 2);
    const snap0 = f.snapshot();
    expect(snap0.cars.every((c) => c.ai?.placeholder === false)).toBe(true);
    for (let i = 0; i < 240; i++) {
      f.step(DT, ctx);
      f.afterStep(DT, ctx);
    }
    expect(cars.every((c) => c.speed === 0)).toBe(true); // the countdown: parked
    race.phase = 'running';
    let t = 0;
    let maxLat = 0;
    for (let i = 0; i < 120 * 400 && !f.snapshot().cars.every((c) => c.finished); i++) {
      t = i * DT;
      race.time = t;
      f.step(DT, ctx);
      f.afterStep(DT, ctx);
      if (i % 60 === 0) for (const c of f.snapshot().cars) maxLat = Math.max(maxLat, Math.abs(c.lateral));
    }
    const s = f.snapshot();
    expect(s.cars.every((c) => c.finished), JSON.stringify(s.cars.map((c) => [c.id, c.s, c.speedKmh, c.resets, c.ai?.state]))).toBe(true);
    expect(s.cars.every((c) => c.resets === 0)).toBe(true);
    expect(maxLat).toBeLessThan(stage.roadAt(0).width);
    // a plausible race: the stage's length covered in a sensible time, one car at a time at the line
    for (const c of s.cars) {
      expect(c.finishTime!).toBeGreaterThan(stage.length / 90); // not faster than 324 km/h average
      expect(c.finishTime!).toBeLessThan(stage.length / 5);
    }
    expect(s.standings.map((e) => e.position)).toEqual([1, 2, 3]);
  }, 120000);
});
