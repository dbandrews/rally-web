// Autopilot obstacle planning (src/game/autopilot.ts) and the post-finish run-out's line / object stop
// (src/game/driving.ts runOutControls). QA: the autopilot drove into the hillclimb 1C service park at full speed
// (a truck and a tent on the road 20 m before the finish, 153 → 5 km/h) and the run-out swerved back to the centre
// line into the hillclimb 2B tent cluster. Synthetic cases on a kinematic car, then the real stages (built assets).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { DT, parkedControls } from '../../src/core/constants';
import type { Obstacle, SimV3, WorldQuery } from '../../src/core/types';
import { Autopilot } from '../../src/game/autopilot';
import { obstacleAtCarHeight, runOutControls } from '../../src/game/driving';
import { RaceController, START_GRID_BACK_M } from '../../src/game/race';
import { MemoryStore } from '../../src/game/storage';
import { CarSim } from '../../src/sim/car';
import { makeSurfaceTable } from '../../src/sim/params';
import { origCarParams } from '../../src/sim/presets';
import { attachOriginalWorld } from '../../src/world/orig';
import { buildStage } from '../../src/world/stages';
import { builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';
import { FakeCar, makeLineStage } from './fakes';

/** A WorldQuery that only answers obstaclesNear (the planner's and the run-out's only query). */
function obstacleWorld(list: Obstacle[]): WorldQuery {
  const near = (p: SimV3, r: number, out: Obstacle[] = []): Obstacle[] => {
    out.length = 0;
    for (const o of list) if (Math.hypot(o.pos.x - p.x, o.pos.z - p.z) < r + o.radius) out.push(o);
    return out;
  };
  return { obstaclesNear: near } as unknown as WorldQuery;
}

/** An obstacle at stage distance s, lateral lat (+ right) on makeLineStage (three (x, -s) = sim (x, s)). */
const ob = (s: number, lat: number, radius: number, kind: Obstacle['kind'] = 'barrier', y = 0, height = 3): Obstacle => ({
  kind,
  pos: { x: lat, y, z: s },
  radius,
  height,
});

/** The hillclimb 1C finish in miniature: road fences either side, then a truck (chain) left and a tent right of
 *  the centre line, a free lane only beyond the tent. */
function servicePark(): Obstacle[] {
  const list: Obstacle[] = [];
  for (let s = 600; s <= 612; s += 3) list.push(ob(s, -6.5, 1.6, 'fence'), ob(s, 6.5, 1.6, 'fence'));
  for (let s = 640; s <= 660; s += 0.5) list.push(ob(s, -1.5, 0.3), ob(s, -4, 0.3));
  list.push(ob(648, 2.5, 3.3, 'tent'));
  return list;
}

/** Drive the kinematic car with the autopilot from s0 at v0 (m/s) to s1; min clearance car centre → obstacle edge. */
function drive(world: WorldQuery | null, list: Obstacle[], s0: number, v0: number, s1: number) {
  const stage = makeLineStage({ length: 1200, finishS: 1100, checkpoints: [], width: 14 });
  const car = new FakeCar();
  const race = new RaceController({ store: new MemoryStore(), stuckReset: false });
  race.begin(stage, car, { countdown: false });
  race.startNow();
  car.place(0, -s0, 0, v0);
  race.fixedUpdate(DT, car.telemetry());
  const ap = new Autopilot();
  ap.world = world;
  let minClear = Infinity;
  let minKmh = Infinity;
  let latAtTent = NaN;
  for (let i = 0; i < 120 * 60 && race.state.s < s1; i++) {
    const k = ap.update(DT, car.telemetry(), stage, race.state);
    car.step(k, DT);
    race.fixedUpdate(DT, car.telemetry());
    for (const o of list) minClear = Math.min(minClear, Math.hypot(car.pos.x - o.pos.x, -car.pos.z - o.pos.z) - o.radius);
    if (race.state.s > s0 + 20) minKmh = Math.min(minKmh, car.speed * 3.6);
    if (Math.abs(race.state.s - 648) < 0.5) latAtTent = race.state.lateral;
  }
  return { race, minClear, minKmh, latAtTent, ap };
}

describe('autopilot obstacle planning (synthetic)', () => {
  it('threads the fences, then swings out past the truck and the tent, braking for the lane change', () => {
    const list = servicePark();
    const r = drive(obstacleWorld(list), list, 400, 30, 700);
    expect(r.race.state.s).toBeGreaterThan(700);
    // car half width ≈ 0.85 m: every obstacle stays clear of the body
    expect(r.minClear).toBeGreaterThan(0.95);
    // beyond the tent (right) or the truck (left: the wider lane here, the real stage has a boulder there)
    expect(r.latAtTent > 2.5 + 3.3 + 0.85 || r.latAtTent < -4 - 0.3 - 0.85).toBe(true);
    // the lane change from between the fences to beyond the tent is not made at 108 km/h
    expect(r.minKmh).toBeLessThan(80);
    expect(r.minKmh).toBeGreaterThan(15);
  });

  it('without a world the line and speed are the centre line and the profile (no plan)', () => {
    const list = servicePark();
    const r = drive(null, list, 400, 30, 700);
    expect(r.ap.debug.avoidClusters).toBe(0);
    expect(r.minClear).toBeLessThan(0); // drives straight through the proxies (the kinematic car has no collisions)
  });

  it('objects over the road (a walkway chain 3 m up) are no walls; the sim height test decides', () => {
    expect(obstacleAtCarHeight(ob(0, 0, 0.3, 'barrier', 3, 1), 0)).toBe(false);
    expect(obstacleAtCarHeight(ob(0, 0, 0.3, 'barrier', 0, 1), 0)).toBe(true);
    expect(obstacleAtCarHeight(ob(0, 0, 0.3, 'barrier', -3, 1), 0)).toBe(false); // below the road
    const list: Obstacle[] = [];
    for (let x = -8; x <= 8; x += 0.5) list.push(ob(520, x, 0.3, 'barrier', 3, 1));
    const r = drive(obstacleWorld(list), list, 400, 25, 600);
    expect(r.race.state.s).toBeGreaterThan(600);
    expect(Math.abs(r.race.state.lateral)).toBeLessThan(0.5);
    expect(r.minKmh).toBeGreaterThan(80);
  });
});

describe('post-finish run-out line', () => {
  const stage = makeLineStage({ startS: 10, finishS: 400, checkpoints: [], length: 600, width: 14 });
  const tel = (kmh: number, lateral: number) => ({ pos: { x: lateral, y: 0, z: -400 }, quat: { w: 1, x: 0, y: 0, z: 0 }, speedKmh: kmh, velLocal: { x: 0, y: 0, z: kmh / 3.6 } });

  it('keeps the line it finished on (inside the road) instead of swerving to the centre line', () => {
    expect(Math.abs(runOutControls(tel(60, -4), stage, { s: 400, lateral: -4 }).steer)).toBeLessThan(0.02);
    // off the road: back to 1 m inside the edge (half width 7)
    expect(runOutControls(tel(60, 9), stage, { s: 400, lateral: 9 }).steer).toBeLessThan(0);
    // no lateral given: the centre line, as before
    expect(runOutControls(tel(60, -4), stage, { s: 400 }).steer).toBeGreaterThan(0);
  });

  it('brakes to stop short of the first object on that line; an object beside the line changes nothing', () => {
    const world = obstacleWorld([ob(412, 0, 1)]);
    const onLine = runOutControls(tel(50, 0), stage, { s: 400, lateral: 0 }, world);
    const beside = runOutControls(tel(50, -4), stage, { s: 400, lateral: -4 }, world);
    const none = runOutControls(tel(50, 0), stage, { s: 400, lateral: 0 });
    expect(onLine.brake).toBe(1); // 50 km/h in (12 − 1 − 3) m needs ≈ 12 m/s²
    expect(beside.brake).toBeCloseTo(none.brake, 9);
    expect(none.brake).toBeLessThan(0.5);
  });
});

/** The real stage from s0 (teleport) to the finish and its run-out with an original car: object hits. */
async function realRun(id: string, s0: number, car = 'Micra') {
  const { stage, world } = await attachOriginalWorld(buildStage(id, 1));
  const params = origCarParams(car);
  params.tyreType = stage.defaultTyre;
  const sim = new CarSim({ id: 'player', params, world, surfaces: makeSurfaceTable(), seed: 1, origCar: car, slotBase: 0 });
  const race = new RaceController({ store: new MemoryStore(), startGridBack: START_GRID_BACK_M });
  race.begin(stage, sim, { countdown: false, world, origCar: car });
  race.startNow();
  race.teleport(s0, 0);
  const ap = new Autopilot();
  ap.world = world;
  const hits0 = sim.telemetry().collision.objectHits;
  let finishHits = -1;
  let stopped = 0;
  for (let i = 0; i < 120 * 120 && stopped < 60; i++) {
    const st = race.state;
    const t = sim.telemetry();
    const c = race.isControllable() ? ap.update(DT, t, stage, st) : st.phase === 'finished' ? runOutControls(t, stage, st, world) : parkedControls();
    sim.step(c, DT);
    race.fixedUpdate(DT, sim.telemetry());
    if (st.phase === 'finished' && finishHits < 0) finishHits = sim.telemetry().collision.objectHits - hits0;
    stopped = st.phase === 'finished' && sim.telemetry().speedKmh < 0.5 ? stopped + 1 : 0;
  }
  return { race, finishHits, runOutHits: sim.telemetry().collision.objectHits - hits0 - Math.max(0, finishHits), stopped: stopped >= 60 };
}

describe.skipIf(!builtAssetsPresent)('autopilot on the original service parks (built assets)', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => _setAssetFetchForTests(null));

  it('hillclimb-1c-f: past the truck and the tent to the finish without an object hit (was 153 → 5 km/h)', async () => {
    const r = await realRun('hillclimb-1c-f', 2950);
    expect(r.race.state.phase).toBe('finished');
    expect(r.finishHits).toBe(0);
    expect(r.runOutHits).toBe(0);
  });

  it('hillclimb-1c-r: past the truck3 chain on the centre line before the finish', async () => {
    const r = await realRun('hillclimb-1c-r', 3300);
    expect(r.race.state.phase).toBe('finished');
    expect(r.finishHits).toBe(0);
  });

  it('hillclimb-1a-f: the finish gate, not the barrier ring behind it, sets the line', async () => {
    const r = await realRun('hillclimb-1a-f', 3350);
    expect(r.race.state.phase).toBe('finished');
    expect(r.finishHits).toBe(0);
  });

  it('hillclimb-2b-f: the run-out stops short of the tent / fence cluster 6 m past the finish', async () => {
    const r = await realRun('hillclimb-2b-f', 3600);
    expect(r.race.state.phase).toBe('finished');
    expect(r.finishHits).toBe(0);
    expect(r.runOutHits).toBe(0);
    expect(r.stopped).toBe(true);
  });
});
