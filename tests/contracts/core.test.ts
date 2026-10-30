/**
 * tests/contracts/core.test.ts — ARCHITECT-OWNED. Checks the shared math / space / loop / path contracts.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ARCHETYPE_IDS,
  DT,
  isOrigCarId,
  MATCHED_TYRE,
  MATERIAL,
  MATERIAL_NONE,
  MATERIAL_SOLID_MIN,
  materialFromOrig,
  ORIG_CAR_IDS,
  ORIG_MATERIAL_NAMES,
  ORIG_MATERIAL_TO_MATERIAL,
  origFromMaterial,
  SURFACE_IDS,
  SURFACE_INFO,
  SURFACE_ORIG_ID,
} from '../../src/core/constants';
import {
  GROUND_HINT_ABOVE_M,
  hullSlot,
  isCacheSlot,
  MAX_FACE_SLOTS,
  NO_SLOT,
  pickGroundLevel,
  pickGroundY,
  raycastViaSegment,
  segmentViaRaycast,
  slotBaseOf,
  SLOTS_PER_CAR,
  wheelSlot,
} from '../../src/core/worldQuery';
import { ORIG_CARS } from '../../src/sim/origCars';

// node:fs through a computed specifier: the project has no Node typings
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string };
import { FixedStepLoop } from '../../src/core/loop';
import { cross, qAxes, qFromBasis, qIntegrate, qLookSim, qRotate, qYawSim, type V3 } from '../../src/core/math';
import { getPath, partialFromPath, setPath, deepMergeInto } from '../../src/core/paths';
import { mirror, mirrorQuat, setThreeQuat } from '../../src/core/space';
import { ARCHETYPE_PARAMS, DEFAULT_SURFACE_TABLE, makeCarParams, muStatic } from '../../src/sim/params';

const close = (a: V3, b: V3) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
  expect(a.z).toBeCloseTo(b.z, 9);
};

describe('math (sim space, §1.1/§2.5.0)', () => {
  it('cross(up, fwd) = right and cross(fwd, right) = up', () => {
    close(cross({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }), { x: 1, y: 0, z: 0 });
    close(cross({ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }), { x: 0, y: 1, z: 0 });
  });
  it('positive yaw rate turns the nose right (+x)', () => {
    let q = qYawSim(0);
    for (let i = 0; i < 120; i++) q = qIntegrate(q, { x: 0, y: 0.5, z: 0 }, DT);
    const f = qAxes(q).fwd;
    expect(f.x).toBeGreaterThan(0.4);
    expect(Math.atan2(f.x, f.z)).toBeCloseTo(0.5, 5);
  });
  it('qFromBasis inverts qAxes', () => {
    const q0 = qLookSim({ x: 0.3, y: -0.2, z: 0.9 });
    const ax = qAxes(q0);
    const q1 = qFromBasis(ax.right, ax.up, ax.fwd);
    close(qAxes(q1).fwd, ax.fwd);
    close(qAxes(q1).up, ax.up);
    expect(Math.abs(ax.right.y)).toBeLessThan(1e-12); // zero roll
  });
});

describe('space mirror (§1.1)', () => {
  it('rotating in sim then mirroring equals mirroring then rotating in three', () => {
    const qSim = qLookSim({ x: 0.5, y: 0.1, z: -0.4 });
    const vBody = { x: 0.3, y: -0.7, z: 1.9 };
    const a = mirror(qRotate(qSim, vBody));
    const tq = setThreeQuat(new THREE.Quaternion(), qSim);
    const b = new THREE.Vector3(vBody.x, vBody.y, -vBody.z).applyQuaternion(tq);
    close(a, { x: b.x, y: b.y, z: b.z });
    const mq = mirrorQuat(qSim);
    expect([mq.x, mq.y, mq.z, mq.w]).toEqual([tq.x, tq.y, tq.z, tq.w]);
  });
  it('sim forward (+z) is three -Z', () => {
    const tq = setThreeQuat(new THREE.Quaternion(), qYawSim(0));
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(tq);
    expect(f.z).toBeCloseTo(-1, 12);
  });
});

describe('FixedStepLoop (§1.2)', () => {
  it('120 Hz accumulator with 0.2 s clamp and timeScale', () => {
    const l = new FixedStepLoop();
    expect(l.advance(1 / 60).steps).toBe(2);
    expect(l.advance(1.0).steps).toBe(24); // clamped to 0.2 s
    l.timeScale = 0.5;
    let n = 0;
    for (let i = 0; i < 60; i++) n += l.advance(1 / 60).steps;
    expect(n).toBe(60);
    l.paused = true;
    expect(l.advance(1 / 60).steps).toBe(0);
    l.requestSteps(3);
    expect(l.advance(1 / 60).steps).toBe(3);
  });
});

describe('paths', () => {
  it('get/set/partial', () => {
    const p = makeCarParams('awd_wrc');
    expect(getPath(p, 'wheel.front.springK')).toBe(35000);
    setPath(p, 'wheel.front.springK', 40000);
    expect(p.wheel.front.springK).toBe(40000);
    expect(() => setPath(p, 'wheel.front.nope', 1)).toThrow();
    const part = partialFromPath('gearRatio.2', 2.0, p);
    deepMergeInto(p, part);
    expect(p.gearRatio).toEqual([-3.3, 3.35, 2.0, 1.55, 1.22, 0.97, 0.84]);
    expect(ARCHETYPE_PARAMS.awd_wrc.gearRatio[2]).toBe(2.15); // originals untouched
  });
});

describe('parameter data (§3, §4)', () => {
  it('archetypes are complete and consistent', () => {
    for (const id of ARCHETYPE_IDS) {
      const p = ARCHETYPE_PARAMS[id];
      expect(p.archetype).toBe(id);
      expect(p.gearRatio).toHaveLength(p.nGears + 1);
      expect(p.gearRatio[0]).toBeLessThan(0);
    }
  });
  it('surface table matches §4.3 static mu values', () => {
    expect(SURFACE_IDS.map((s) => DEFAULT_SURFACE_TABLE[s].material)).toEqual(SURFACE_IDS.map((s) => MATERIAL[s]));
    expect(muStatic(DEFAULT_SURFACE_TABLE.tarmac, 0)).toBeCloseTo(2.407, 3);
    expect(muStatic(DEFAULT_SURFACE_TABLE.snow, 0)).toBeCloseTo(0.34, 2);
    expect(muStatic(DEFAULT_SURFACE_TABLE.ice, 0)).toBeCloseTo(0.095, 3);
    expect(muStatic(DEFAULT_SURFACE_TABLE.water, 0)).toBeCloseTo(1.895, 3);
    expect(muStatic(DEFAULT_SURFACE_TABLE.gravel, 2)).toBeCloseTo(1.775, 3);
  });
});

describe('key bindings (constants mirror src/input/bindings.ts)', () => {
  it('DEFAULT_KEYS equals the input module GAME_KEYS and UI_KEYS lists the UI bindings', async () => {
    const { DEFAULT_KEYS, UI_KEYS } = await import('../../src/core/constants');
    const { GAME_KEYS, UI_BINDINGS } = await import('../../src/input/bindings');
    expect(DEFAULT_KEYS).toEqual(GAME_KEYS);
    const ui = UI_KEYS as Record<string, readonly string[]>;
    const map: Record<string, string> = { menu: 'menu', restart: 'restart', tuning: 'toggleTuning', overlay: 'toggleOverlay', help: 'help', step: 'step', slower: 'slower', faster: 'faster', autopilot: 'autopilot', voice: 'voice' };
    for (const [k, codes] of Object.entries(UI_BINDINGS)) expect(ui[map[k]], k).toEqual(codes);
    // no key is bound twice across driving and UI
    const all = [...Object.values(GAME_KEYS).flat(), ...Object.values(UI_KEYS).flat()];
    expect(new Set(all).size).toBe(all.length);
  });
});

// ------------------------------------------------------------------------------------------- original-port contracts

describe('surfaces = one per original material (§4.3 / §4.4, gcm.md §4)', () => {
  it('23 surfaces; the original ten keep ids 0..9; every Record<SurfaceId> table is complete', () => {
    expect(SURFACE_IDS).toHaveLength(23);
    expect(SURFACE_IDS.slice(0, 10)).toEqual(['tarmac', 'gravel', 'gravelDeep', 'mud', 'snow', 'ice', 'grass', 'sand', 'cobbles', 'water']);
    expect(new Set(SURFACE_IDS).size).toBe(23);
    for (const s of SURFACE_IDS) {
      for (const [name, t] of Object.entries({ MATCHED_TYRE, SURFACE_INFO, SURFACE_ORIG_ID, DEFAULT_SURFACE_TABLE })) {
        expect((t as Record<string, unknown>)[s], `${name}.${s}`).toBeDefined();
      }
    }
  });
  it('ORIG_MATERIAL_TO_MATERIAL maps the 23 bytes one-to-one; DUMMY, −1 and the rest → MATERIAL_NONE', () => {
    expect(ORIG_MATERIAL_TO_MATERIAL).toHaveLength(256);
    expect(new Set(SURFACE_IDS.map((s) => SURFACE_ORIG_ID[s]))).toEqual(new Set(Array.from({ length: 23 }, (_, i) => i)));
    for (let b = 0; b < 256; b++) {
      const m = materialFromOrig(b);
      if (b <= 22) {
        expect(SURFACE_ORIG_ID[SURFACE_IDS[m]], `byte ${b}`).toBe(b);
        expect(origFromMaterial(m)).toBe(b);
      } else expect(m, `byte ${b}`).toBe(MATERIAL_NONE);
    }
    // the numbering trap: gcm 0 = GRASS, gcm 1 = ASPHALT
    expect(materialFromOrig(0)).toBe(MATERIAL.grass);
    expect(materialFromOrig(1)).toBe(MATERIAL.tarmac);
    expect(materialFromOrig(-1)).toBe(MATERIAL_NONE);
    expect(materialFromOrig(23)).toBe(MATERIAL_NONE);
    expect(origFromMaterial(MATERIAL_NONE)).toBe(255);
    expect(origFromMaterial(MATERIAL_SOLID_MIN)).toBe(255);
    expect(ORIG_MATERIAL_NAMES[SURFACE_ORIG_ID.snowAsphalt]).toBe('SNOWASPHALT');
    expect(ORIG_MATERIAL_NAMES).toHaveLength(24);
  });
  it('the physics table carries the orig ids, the DEEP set and the visual columns of SURFACE_INFO', () => {
    for (const s of SURFACE_IDS) {
      const d = DEFAULT_SURFACE_TABLE[s];
      expect(d.id).toBe(s);
      expect(d.material).toBe(MATERIAL[s]);
      expect(d.origId, s).toBe(SURFACE_ORIG_ID[s]);
      expect(d.deep, s).toBe(SURFACE_INFO[s].deep);
      expect(d.wheelJitterAmp, s).toBe(SURFACE_INFO[s].wheelJitterAmp);
      expect(d.cameraRoughness, s).toBe(SURFACE_INFO[s].cameraRoughness);
    }
    // FUN_006d0410 DEEP switch: orig {0, 9, 11, 12, 18, 19, 22}
    expect(SURFACE_IDS.filter((s) => DEFAULT_SURFACE_TABLE[s].deep).map((s) => SURFACE_ORIG_ID[s]).sort((a, b) => a - b)).toEqual([0, 9, 11, 12, 18, 19, 22]);
  });
  const PP = ['.cache/original/Misc/physicsfiles/PhysicsParam.con', 'research/full/Misc/physicsfiles/PhysicsParam.con'].find((p) => fs.existsSync(p));
  it.skipIf(!PP)('DEFAULT_SURFACE_TABLE equals the original PhysicsParam.con rows (when extracted)', () => {
    const lines = fs.readFileSync(PP!, 'latin1').split(/\r?\n/).map((l: string) => l.trim());
    const nums = (cmd: string) => lines.filter((l) => l.startsWith(cmd)).map((l) => l.split(/\s+/).slice(1).map(Number));
    const tyre = nums('physics.addCarTyrePhysicsValue');
    const surf = nums('physics.addPhySurfacePhysicsValue');
    expect(surf).toHaveLength(24);
    expect(tyre).toHaveLength(120);
    for (const s of SURFACE_IDS) {
      const d = DEFAULT_SURFACE_TABLE[s];
      const o = d.origId;
      expect([d.bodyK, d.bodyKScale, d.maxDepth, d.epsilon, d.frictionLevel, d.bump, d.bumpFlag], s).toEqual(surf[o]);
      for (let t = 0; t < 5; t++) {
        const r = d.tyre[t];
        expect([r.bestStatic, r.diffStatic, r.scaleKinetic, r.bestRollK, r.diffRollK], `${s} tyre ${t}`).toEqual(tyre[o * 5 + t]);
      }
    }
  });
});

describe('original car identity', () => {
  it('ORIG_CAR_IDS = the 29 car folders = src/sim/origCars.ts archive names', () => {
    expect(ORIG_CAR_IDS).toHaveLength(29);
    expect([...ORIG_CARS.map((c) => c.archive)].sort()).toEqual([...ORIG_CAR_IDS].sort());
    expect(isOrigCarId('AudiS1')).toBe(true);
    expect(isOrigCarId('awd_wrc')).toBe(false);
    expect(isOrigCarId(null)).toBe(false);
  });
});

describe('src/core/worldQuery.ts', () => {
  // a plane y = 0 answering raycast with the legacy procedural semantics (dist 0 below the ground)
  const plane = {
    raycast(o: V3, d: V3, maxDist: number) {
      if (o.y <= 0) return { dist: 0, normal: { x: 0, y: 1, z: 0 }, material: MATERIAL.gravel, point: { x: o.x, y: 0, z: o.z } };
      if (d.y >= 0) return null;
      const t = -o.y / d.y;
      return t > maxDist ? null : { dist: t, normal: { x: 0, y: 1, z: 0 }, material: MATERIAL.gravel, point: { x: o.x + d.x * t, y: 0, z: o.z + d.z * t } };
    },
  };
  it('segmentViaRaycast: full segment vector, t / depth / cos / origMaterial, original miss rules', () => {
    const h = segmentViaRaycast(plane, { x: 1, y: 0.5, z: 2 }, { x: 0, y: -0.75, z: 0 }, wheelSlot(0, 1))!;
    expect(h.dist).toBeCloseTo(0.5, 12);
    expect(h.t).toBeCloseTo(0.5 / 0.75, 12);
    expect(h.depth).toBeCloseTo(-0.25, 12); // the segment end lies 0.25 m below the plane
    expect(h.cos).toBeCloseTo(-0.75, 12); // dot(n, ray), unnormalised
    expect(h.origMaterial).toBe(SURFACE_ORIG_ID.gravel);
    expect(h.material).toBe(MATERIAL.gravel);
    expect(h.face).toBe(-1);
    // tilted segment: depth along the normal, cos with the unnormalised ray
    const k = segmentViaRaycast(plane, { x: 0, y: 1, z: 0 }, { x: 1, y: -2, z: 0 })!;
    expect(k.t).toBeCloseTo(0.5, 12);
    expect(k.depth).toBeCloseTo(-1, 12);
    expect(k.cos).toBeCloseTo(-2, 12);
    expect(segmentViaRaycast(plane, { x: 0, y: -0.1, z: 0 }, { x: 0, y: -1, z: 0 })).toBeNull(); // start below
    expect(segmentViaRaycast(plane, { x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })).toBeNull(); // start ON the plane (d0 = 0)
    expect(segmentViaRaycast(plane, { x: 0, y: 1, z: 0 }, { x: 0, y: -0.5, z: 0 })).toBeNull(); // too short
    expect(segmentViaRaycast(plane, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 })).toBeNull(); // zero ray
  });
  it('raycastViaSegment passes dir·maxDist with no cache slot', () => {
    let seen: { o: V3; r: V3; slot?: number } | null = null;
    const w = { segment: (o: V3, r: V3, slot?: number) => ((seen = { o, r: { ...r }, slot }), null) };
    expect(raycastViaSegment(w, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, 0.75)).toBeNull();
    expect(seen!.r).toEqual({ x: 0, y: -0.75, z: 0 });
    expect(seen!.slot).toBe(NO_SLOT);
  });
  it('face-cache slots follow the original layout (wheel + 24·car, 8 + hull + 24·car, < 5000)', () => {
    expect(SLOTS_PER_CAR).toBe(24);
    expect(wheelSlot(slotBaseOf(2), 3)).toBe(51);
    expect(hullSlot(slotBaseOf(1), 11)).toBe(43);
    expect(isCacheSlot(-1)).toBe(false);
    expect(isCacheSlot(undefined)).toBe(false);
    expect(isCacheSlot(4999)).toBe(true);
    expect(isCacheSlot(MAX_FACE_SLOTS)).toBe(false);
  });
  it('pickGroundLevel: highest without a hint; with one the highest ≤ yHint + 1 m, else the lowest above', () => {
    const ys = [0, 6, 12.5];
    expect(pickGroundY(ys, 3)).toBe(12.5);
    expect(pickGroundY(ys, 3, 6.4)).toBe(6); // on the bridge deck
    expect(pickGroundY(ys, 3, 5.2)).toBe(6); // 0.8 m below the deck still counts (wheel ray start)
    expect(pickGroundY(ys, 3, 4.9)).toBe(0); // under the bridge
    expect(pickGroundY(ys, 3, -3)).toBe(0); // below everything: the lowest above
    expect(pickGroundY(ys, 3, 100)).toBe(12.5);
    expect(pickGroundLevel(ys, 0, 1)).toBe(-1);
    expect(pickGroundY([], 0)).toBeNaN();
    expect(GROUND_HINT_ABOVE_M).toBe(1);
  });
});
