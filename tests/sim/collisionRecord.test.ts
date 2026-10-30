// CarTelemetry.collision — the original's collision record for the impact / bush sounds (research/formats/sound.md §7,
// verified on the exe: FUN_00746c80 reads the object record +0x30/+0x34/+0x38, else the body flag B+4 bit 0 with
// B+0x144 / B+0x19c; the object pass FUN_004a7bc0 writes the record (type = collisionMaterial raw) and the bush flag).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { DT } from '../../src/core/constants';
import { qFromAxisAngle } from '../../src/core/math';
import type { Obstacle, WorldQuery } from '../../src/core/types';
import { CarSim } from '../../src/sim/car';
import { makeCarParams } from '../../src/sim/params';
import { loadOrigWorld, type OrigWorld } from '../../src/world/orig';
import { buildStage } from '../../src/world/stages';
import { builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';
import { createFlatWorld } from './flatworld';
import { ctl, makeCar, run } from './harness';
import { createProfileWorld, flatProfile } from './profileworld';

/** Drive at `kmh` toward an obstacle 40 m ahead and record the collision record over the run. */
function hit(ob: Obstacle, kmh = 40) {
  const world = createProfileWorld(flatProfile(), 'tarmac', [ob]);
  const c = makeCar({ world, z: 0 });
  let maxStrength = 0;
  let hits = 0;
  let type = -2;
  run(
    c,
    8,
    () => ctl({ throttle: c.telemetry().speedKmh < kmh ? 1 : 0 }),
    () => {
      const r = c.telemetry().collision;
      if (r.objectHits > hits) {
        hits = r.objectHits;
        type = r.objectType;
        maxStrength = Math.max(maxStrength, r.objectStrength);
      }
    },
  );
  return { c, hits, type, maxStrength };
}

describe('CarTelemetry.collision (the original collision record)', () => {
  it('starts empty', () => {
    const r = makeCar({}).telemetry().collision;
    expect(r).toEqual({ hull: false, hullMaterial: 0, hullStrength: 0, objectHits: 0, objectType: -1, objectStrength: 0, bush: false });
  });

  it('a tree hit records type 6 (WOOD, the Tree patch) with strength = impulse − 100', () => {
    const { hits, type, maxStrength } = hit({ kind: 'tree', pos: { x: 0, y: 0, z: 40 }, radius: 0.35, height: 8 });
    expect(hits).toBeGreaterThan(0);
    expect(type).toBe(6);
    expect(maxStrength).toBeGreaterThan(165); // a 40 km/h hit is far past the Hard threshold
  });

  it('a rock records 1 (Hard); an original proxy carries its own collisionMaterial (−1 = silent)', () => {
    expect(hit({ kind: 'rock', pos: { x: 0, y: 0, z: 40 }, radius: 0.6, height: 2 }).type).toBe(1);
    const proxy = { kind: 'rock', pos: { x: 0, y: 0, z: 40 }, radius: 0.6, height: 2, material: -1 } as Obstacle;
    expect(hit(proxy).type).toBe(-1);
  });

  it('the hull contact: on its roof, B+4 bit 0 with the ground byte; B+0x19c = jn − 100 only for real hits', () => {
    const c = new CarSim({ params: makeCarParams('awd_wrc', { tyreType: 2 }), world: createFlatWorld({ surface: 'gravel' }) });
    c.reset({ pos: { x: 0, y: 2.0, z: 0 }, q: qFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI) }, 0);
    run(c, 0.5, () => ctl());
    const rest = c.telemetry().collision;
    expect(rest.hull).toBe(true);
    expect(rest.hullMaterial).toBe(2); // GRAVEL
    expect(rest.hullStrength).toBe(0); // resting: the per-step impulse (≈ 50 N·s) stays below the 100 floor
    expect(c.telemetry().bodyOnGround).toBe(rest.hull);
    // slam it into the ground at 6 m/s (the body solver's literal impulse; no new state, only the velocity)
    (c as unknown as { vW: { y: number } }).vW.y = -6;
    let maxStrength = 0;
    run(c, 0.2, () => ctl(), () => (maxStrength = Math.max(maxStrength, c.telemetry().collision.hullStrength)));
    expect(maxStrength).toBeGreaterThan(165); // past the Hard threshold
  });

  it('bush: the car centre inside a soft object (WorldQuery.softNear) within 2 m', () => {
    const bush: Obstacle = { kind: 'bush', pos: { x: 0, y: 0, z: 0 }, radius: 1.5, height: 1.5 };
    const base = createFlatWorld();
    const world: WorldQuery = {
      ...base,
      raycast: base.raycast,
      segment: base.segment,
      softNear(p, r, out = []) {
        out.length = 0;
        if (Math.hypot(p.x - bush.pos.x, p.z - bush.pos.z) < r + bush.radius) out.push(bush);
        return out;
      },
    };
    const inBush = makeCar({ world, z: 0 });
    inBush.step(ctl(), DT);
    expect(inBush.telemetry().collision.bush).toBe(true);
    const outside = makeCar({ world, z: 3 });
    outside.step(ctl(), DT);
    expect(outside.telemetry().collision.bush).toBe(false);
    const noSoft = makeCar({ z: 0 });
    noSoft.step(ctl(), DT);
    expect(noSoft.telemetry().collision.bush).toBe(false);
  });
});

describe.skipIf(!builtAssetsPresent)('collision record on the original collision mesh (built assets)', () => {
  let world: OrigWorld;
  beforeAll(async () => {
    useBuiltAssets();
    world = await loadOrigWorld('newzealand-1-f', buildStage('newzealand-1-f', 1).world);
  }, 120_000); // a built stage + its collision part: well past vitest's 10 s hook default in a parallel run
  afterAll(() => _setAssetFetchForTests(null));

  it('a car parked on a bush (OrigWorld.softNear) reports the bush flag; on the road it does not', () => {
    // a soft proxy that stands on the collision mesh (many sit off it, where a car would fall)
    const near = world.softNear({ x: 0, y: 0, z: 0 }, 4096, []);
    expect(near.length).toBeGreaterThan(0);
    const bush = near.find(
      (o) => o.radius >= 0.8 && world.onMesh(o.pos.x, o.pos.z) && Math.abs(world.heightAt(o.pos.x, o.pos.z, o.pos.y + 1) - o.pos.y) < 1,
    )!;
    expect(bush).toBeDefined();
    const c = new CarSim({ params: makeCarParams('awd_wrc'), world, origCar: 'ImprezaWRX' });
    const g = world.heightAt(bush.pos.x, bush.pos.z, bush.pos.y + 1);
    c.reset({ pos: { x: bush.pos.x, y: g + 0.6, z: bush.pos.z }, q: { w: 1, x: 0, y: 0, z: 0 } });
    c.step(ctl(), DT);
    expect(c.telemetry().collision.bush).toBe(true);
    const st = buildStage('newzealand-1-f', 1).stage;
    const p = st.pointAt(st.startS + 50);
    const road = new CarSim({ params: makeCarParams('awd_wrc'), world });
    road.reset({ pos: { x: p.x, y: p.y + 0.6, z: -p.z }, q: { w: 1, x: 0, y: 0, z: 0 } });
    road.step(ctl(), DT);
    expect(world.softNear(road.telemetry().posSim, 0, []).length).toBe(0); // no bush on the road 50 m past the start
    expect(road.telemetry().collision.bush).toBe(false);
  });
});
