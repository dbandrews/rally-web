/**
 * tests/sim/objectPass.test.ts — the original's object pass on worlds that carry the objects' own collision meshes
 * (WorldQuery.objectCollidersNear; src/sim/car.ts objectPass, docs/orig/collision.md §4):
 *   - the object contacts' body solver FUN_006d21c0 against the original run in unicorn (fixtures/bodySolverObjCases.json,
 *     generator fixtures/gen_body_obj_cases.py): the ground solver with its own anchor timer and the ±1000 friction clamp;
 *   - FUN_006d1a80 hull segments through synthetic box meshes on a flat world: a head-on hit, a thin fence panel beside
 *     the car (no invisible wall), the 0.2·radius + 1.5 gate, the 16-step candidate refresh and the car-index limit.
 */
import { describe, expect, it } from 'vitest';
import { DT } from '../../src/core/constants';
import type { Controls, ObjectCollider, SimV3, WorldQuery } from '../../src/core/types';
import { CarSim } from '../../src/sim/car';
import { makeCarParams, makeSurfaceTable } from '../../src/sim/params';
import { OrigObjectMeshes } from '../../src/world/orig/objectMeshes';
import { INST, type RcolData } from '../../src/world/orig/rcol';
import { createFlatWorld, flatSpawnPose } from './flatworld';

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync(p: string, e: string): string };

type V = [number, number, number];
const STRIDE = 28;

interface Box {
  /** Box centre and half extents (sim), axis-aligned; the instance origin (transform translation). */
  c: V;
  h: V;
  origin?: V;
  /** Bounding radius override (object +8); default the box's half diagonal. */
  radius?: number;
  material?: number;
}

/** Closed axis-aligned box meshes as RCOL v2 object meshes (stored normals point INTO the box, as the originals). */
function boxWorld(boxes: Box[], base: WorldQuery = createFlatWorld()) {
  const mV: number[] = [], mTN: number[] = [], mTI: number[] = [], mesh: number[] = [], inst: number[] = [];
  boxes.forEach((b, k) => {
    const o = b.origin ?? b.c;
    const lo = b.c.map((x, j) => x - b.h[j] - o[j]), hi = b.c.map((x, j) => x + b.h[j] - o[j]);
    const v0 = mV.length / 3;
    for (let i = 0; i < 8; i++) mV.push(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
    // faces: [corner indices], outward normal
    const faces: [number[], V][] = [
      [[0, 2, 6, 4], [-1, 0, 0]], [[1, 5, 7, 3], [1, 0, 0]], [[0, 4, 5, 1], [0, -1, 0]],
      [[2, 3, 7, 6], [0, 1, 0]], [[0, 1, 3, 2], [0, 0, -1]], [[4, 6, 7, 5], [0, 0, 1]],
    ];
    const t0 = mTN.length / 3;
    for (const [q, n] of faces) {
      for (const tri of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
        mTN.push(-n[0], -n[1], -n[2]);
        mTI.push(v0 + tri[0], v0 + tri[1], v0 + tri[2], 0);
      }
    }
    mesh.push(t0, 12, ...lo, ...hi);
    const r = new Array(STRIDE).fill(0);
    r.splice(INST.M, 9, 1, 0, 0, 0, 1, 0, 0, 0, 1);
    r.splice(INST.T, 3, ...o);
    r[INST.MESH] = k;
    r[INST.MATERIAL] = b.material ?? -1;
    r[INST.RADIUS] = b.radius ?? Math.hypot(...b.h);
    r[INST.OBJECT] = k;
    r.splice(INST.BOXMIN, 3, ...lo);
    r.splice(INST.BOXMAX, 3, ...hi);
    r.splice(INST.CENTRE, 3, ...b.c);
    inst.push(...r);
  });
  const d = {
    mV: Float32Array.from(mV), mTN: Float32Array.from(mTN), mTI: Uint32Array.from(mTI), mesh: Float32Array.from(mesh),
    nMesh: boxes.length, nInst: boxes.length, instStride: STRIDE, inst: Float32Array.from(inst), version: 2,
  } as unknown as RcolData;
  const om = new OrigObjectMeshes(d, ['barrier']);
  let queries = 0;
  const world: WorldQuery & { queries: () => number } = {
    ...base,
    objectCollidersNear: (p: SimV3, r: number, out?: ObjectCollider[]) => {
      queries++;
      return om.near(p, r, out ?? []);
    },
    queries: () => queries,
  };
  return world;
}

const drive = (throttle: number, steer = 0): Controls => ({ steer, throttle, brake: 0, handbrake: 0, gearUp: false, gearDown: false });
const hold: Controls = { steer: 0, throttle: 0, brake: 1, handbrake: 1, gearUp: false, gearDown: false };

function car(world: WorldQuery, slotBase = 0) {
  return new CarSim({ params: makeCarParams('awd_wrc'), world, surfaces: makeSurfaceTable(), slotBase });
}

/** Give the car a forward speed (sim +z) after the settle. */
function launch(c: CarSim, kmh: number) {
  const S = c as any;
  S.vW.z = kmh / 3.6;
  for (const w of S.W) w.omega = S.vW.z / c.params.wheelRadius;
}

describe('FUN_006d21c0, the object contacts\' body solver (unicorn)', () => {
  type V3 = [number, number, number];
  const cases = JSON.parse(fs.readFileSync('tests/sim/fixtures/bodySolverObjCases.json', 'utf8')) as {
    in: { mass: number; I: V3; R: [V3, V3, V3]; Rp: [V3, V3, V3]; pos: V3; vW: V3; vL: V3; w: V3; L: V3; Fext: V3; n: V3; nPrev: V3; c: V3; cPrev: V3; prevPos: V3; T: number; depth: number; share: number; mat: number; flags: number; dt: number };
    out: { vW: V3; L: V3; pos: V3; T: number; prevN: V3; prevC: V3; vWGround: V3 };
  }[];
  it(`${cases.length} cases agree with the original (vW, L, pos, the B+0x138 timer, the shared anchor memory), incl. the ±1000 clamp`, () => {
    const c = car(createFlatWorld());
    const S = c as any;
    const set = (t: { x: number; y: number; z: number }, v: V3) => { t.x = v[0]; t.y = v[1]; t.z = v[2]; };
    const d = (a: { x: number; y: number; z: number }, b: V3) => Math.hypot(a.x - b[0], a.y - b[1], a.z - b[2]);
    let clamped = 0;
    for (const k of cases) {
      const i = k.in;
      S.mass = i.mass; S.invMass = 1 / i.mass;
      set(S.I, i.I); S.invI.x = 1 / i.I[0]; S.invI.y = 1 / i.I[1]; S.invI.z = 1 / i.I[2];
      set(S.right, i.R[0]); set(S.up, i.R[1]); set(S.fwd, i.R[2]);
      set(S.pos, i.pos); set(S.vW, i.vW); set(S.vL, i.vL); set(S.w, i.w); set(S.L, i.L); set(S.Fext, i.Fext);
      set(S.objDir, i.n); set(S.bsPrevN, i.nPrev); set(S.objPt, i.c); set(S.bsPrevC, i.cPrev); set(S.bsPrevPos, i.prevPos);
      S.bsPrevR.set([...i.Rp[0], ...i.Rp[1], ...i.Rp[2]]);
      S.objT = i.T; S.bsT = 0.123; S.objDepth = i.depth; S.bodyShare = i.share; S.objMat = i.mat; S.objFlags = i.flags;
      S.bodySolver(i.dt, true);
      const o = k.out;
      expect(d(S.vW, o.vW) / Math.max(1, Math.hypot(...o.vW))).toBeLessThan(1e-4);
      expect(d(S.L, o.L) / Math.max(10, Math.hypot(...o.L))).toBeLessThan(1e-4);
      expect(d(S.pos, o.pos)).toBeLessThan(1e-4);
      expect(Math.abs(S.objT - o.T)).toBeLessThan(1e-6);
      expect(S.bsT).toBe(0.123); // the ground solver's timer (B+0x134) is not touched
      expect(d(S.bsPrevN, o.prevN)).toBe(0);
      expect(d(S.bsPrevC, o.prevC)).toBe(0);
      if (Math.hypot(o.vW[0] - o.vWGround[0], o.vW[1] - o.vWGround[1], o.vW[2] - o.vWGround[2]) > 1e-3) clamped++;
    }
    expect(clamped).toBeGreaterThan(5); // cases where the ±1000 friction clamp changes the result
  });
});

describe('the object pass (FUN_004a7bc0 / FUN_006d1a80) on object meshes', () => {
  it('a head-on hit on a block stops the car at its face and sets the object record', () => {
    // a 3 m wide, 1.6 m deep, 2 m tall block; its origin at the near face's foot so the gate opens in time
    const world = boxWorld([{ c: [0, 1, 20.8], h: [1.5, 1, 0.8], origin: [0, 0, 20], radius: 2, material: 6 }]);
    const c = car(world);
    c.reset(flatSpawnPose(world));
    launch(c, 40);
    let minFront = Infinity;
    for (let i = 0; i < 360; i++) {
      c.step(drive(0.3), DT);
      minFront = Math.min(minFront, 20 - c.telemetry().posSim.z);
    }
    const t = c.telemetry();
    expect(t.collision.objectHits).toBeGreaterThan(0);
    expect(t.collision.objectType).toBe(6);
    // the car is held at the face: its centre stays about half a car length before z = 20, never past it
    expect(t.posSim.z).toBeLessThan(20);
    expect(t.posSim.z).toBeGreaterThan(16);
    expect(Math.abs(t.velSim.z)).toBeLessThan(3);
    expect(minFront).toBeGreaterThan(0.5);
  });

  it('a thin fence panel 0.3 m beside the car is not an invisible wall (no contact, no push)', () => {
    // kn_riotfence_01-like: a 0.16 m slab, 2.9 m long, 3.6 m tall, its face 0.3 m right of the hull's side
    const hw = 0.85;
    const world = boxWorld([{ c: [hw + 0.3 + 0.08, 1.8, 0], h: [0.08, 1.8, 1.45], radius: 1.37 }]);
    const c = car(world);
    c.reset(flatSpawnPose(world));
    const x0 = c.telemetry().posSim.x;
    for (let i = 0; i < 120; i++) c.step(hold, DT);
    const t = c.telemetry();
    expect(t.collision.objectHits).toBe(0);
    expect(Math.abs(t.posSim.x - x0)).toBeLessThan(1e-3);
  });

  it('the car drives along the panel and only touches it when it steers into it', () => {
    // the panel's origin sits 0.6 m above the ground (the riot fence's render box is centred on it, y ±0.59)
    const world = boxWorld([{ c: [1.4, 2.1, 30], h: [0.08, 2.1, 1.45], origin: [1.4, 0.6, 30], radius: 1.37 }]);
    const c = car(world);
    c.reset(flatSpawnPose(world));
    launch(c, 30);
    for (let i = 0; i < 480; i++) c.step(drive(0.2), DT);
    expect(c.telemetry().collision.objectHits).toBe(0);
    expect(c.telemetry().posSim.z).toBeGreaterThan(32);
    // now aimed into it from the side
    const c2 = car(world);
    c2.reset(flatSpawnPose(world, -1.5, 26, 0.6));
    launch(c2, 25);
    const S = c2 as any;
    S.vW.x = Math.sin(0.6) * S.vW.z;
    S.vW.z = Math.cos(0.6) * S.vW.z;
    let maxX = -Infinity;
    for (let i = 0; i < 240; i++) {
      c2.step(drive(0.2), DT);
      const p = c2.telemetry().posSim;
      if (p.z > 28.55 && p.z < 31.45) maxX = Math.max(maxX, p.x);
    }
    expect(c2.telemetry().collision.objectHits).toBeGreaterThan(0);
    // deflected along the slab (x = 1.32 is its near face): the centre stays on the near side over the panel's length
    expect(maxX).toBeLessThan(1.32 - 0.5);
    expect(c2.telemetry().posSim.z).toBeGreaterThan(31.45); // and slides on past its end
  });

  it('the gate: an object is only tested while the car is within 0.2·radius + 1.5 of its origin (0x4a8008)', () => {
    // the same block, but its origin 6 m behind its face and a 20 m bounding radius: 0.2·20 + 1.5 = 5.5 m < 6 m
    const world = boxWorld([{ c: [0, 1, 20.8], h: [1.5, 1, 0.8], origin: [0, 1, 26], radius: 20 }]);
    const c = car(world);
    c.reset(flatSpawnPose(world));
    launch(c, 30);
    let hitAt = NaN;
    for (let i = 0; i < 360 && Number.isNaN(hitAt); i++) {
      c.step(drive(0.3), DT);
      if (c.telemetry().collision.objectHits > 0) hitAt = c.telemetry().posSim.z;
    }
    // the car's centre reaches 26 − 5.5 = 20.5 m (past the face at 20) before the object is tested at all
    expect(hitAt).toBeGreaterThan(20.4);
  });

  it('candidates refresh every 16 substeps (car k at 4k), cars ≥ 4 never; the cylinder stand-in is off', () => {
    const world = boxWorld([{ c: [0, 1, 6], h: [1, 1, 0.5], radius: 1.5 }]);
    const c0 = car(world, 0);
    c0.reset(flatSpawnPose(world));
    const q0 = world.queries();
    for (let i = 0; i < 64; i++) c0.step(hold, DT);
    expect(world.queries() - q0).toBe(4);
    const c5 = car(world, 5 * 24);
    c5.reset(flatSpawnPose(world));
    const q5 = world.queries();
    for (let i = 0; i < 64; i++) c5.step(hold, DT);
    expect(world.queries() - q5).toBe(0);
    // obstaclesNear is not consulted when the world has object meshes
    let cyl = 0;
    const w2 = { ...world, obstaclesNear: (p: SimV3, r: number, out: any[] = []) => { cyl++; out.length = 0; return out; } };
    const c1 = car(w2 as WorldQuery);
    c1.reset(flatSpawnPose(w2 as WorldQuery));
    for (let i = 0; i < 30; i++) c1.step(hold, DT);
    expect(cyl).toBe(0);
  });
});
