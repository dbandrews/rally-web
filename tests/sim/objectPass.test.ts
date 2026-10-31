/**
 * tests/sim/objectPass.test.ts — the original's object pass on worlds that carry the objects' own collision meshes
 * (WorldQuery.objectCollidersNear; src/sim/car.ts objectPass, docs/orig/collision.md §4):
 *   - the object contacts' body solver FUN_006d21c0 against the original run in unicorn (fixtures/bodySolverObjCases.json,
 *     generator fixtures/gen_body_obj_cases.py): the ground solver with its own anchor timer and the ±1000 friction clamp;
 *   - FUN_006d1a80 hull segments through synthetic box meshes on a flat world: a head-on hit, a thin fence panel beside
 *     the car (no invisible wall), the two gates (a TreeMesh's trunk gate 0.2·radius + 1.5 around its origin 0x4a8008;
 *     any other object's bounding sphere around its centre 0x4a8049), the 16-step candidate refresh and the car-index
 *     limit;
 *   - the gate on a real BUILT stage (public/assets): a Micra driven into the MIDDLE of a railing panel is held at its
 *     face — the reported bug (before the two-branch gate the panel's middle was never tested: its origin sits at one
 *     end, beyond 0.2·radius + 1.5). The packs are tracked in git: when they are missing the suite FAILS (no silent skip).
 */
import { describe, expect, it } from 'vitest';
import { DT } from '../../src/core/constants';
import { qYawSim } from '../../src/core/math';
import type { Controls, ObjectCollider, SimV3, WorldQuery } from '../../src/core/types';
import { CarSim } from '../../src/sim/car';
import { makeCarParams, makeSurfaceTable } from '../../src/sim/params';
import { origCarParams } from '../../src/sim/presets';
import { OrigObjectMeshes } from '../../src/world/orig/objectMeshes';
import { INST, INST_COLOUR, MESH_STRIDE, parseRcol, type RcolData } from '../../src/world/orig/rcol';
import { OrigWorld } from '../../src/world/orig/world';
import { createFlatWorld, flatSpawnPose } from './flatworld';

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as {
  readFileSync(p: string, e: string): string;
  readFileSync(p: string): Uint8Array;
  existsSync(p: string): boolean;
};

type V = [number, number, number];
const STRIDE = 28;

interface Box {
  /** Box centre and half extents (sim), axis-aligned; the instance origin (transform translation). */
  c: V;
  h: V;
  origin?: V;
  /** Bounding radius override (object +8); default the box's half diagonal. */
  radius?: number;
  /** The geometry answers the colour interface (a TreeMesh instance): the trunk gate applies. */
  tree?: boolean;
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
    r[INST.FLAGS] = b.tree ? INST_COLOUR : 0;
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

  it('the gate, tree branch: a TreeMesh is only tested while its origin is within 0.2·radius + 1.5 of the car (0x4a8008)', () => {
    // the same block, but its origin 6 m behind its face and a 20 m bounding radius: 0.2·20 + 1.5 = 5.5 m < 6 m
    const world = boxWorld([{ c: [0, 1, 20.8], h: [1.5, 1, 0.8], origin: [0, 1, 26], radius: 20, tree: true }]);
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

  it('the gate, sphere branch: any other object is tested while its centre is within radius + car radius (0x4a8049)', () => {
    // the same geometry without the colour component (a StandardMesh instance, e.g. a railing): the gate is the
    // bounding sphere |centre − car| ≤ 20 + car radius, open from the start — the car is stopped at its face
    const world = boxWorld([{ c: [0, 1, 20.8], h: [1.5, 1, 0.8], origin: [0, 1, 26], radius: 20 }]);
    const c = car(world);
    c.reset(flatSpawnPose(world));
    launch(c, 30);
    let hitAt = NaN;
    for (let i = 0; i < 360 && Number.isNaN(hitAt); i++) {
      c.step(drive(0.3), DT);
      if (c.telemetry().collision.objectHits > 0) hitAt = c.telemetry().posSim.z;
    }
    // the object is tested long before the car's centre is anywhere near its origin: the hit comes at the face
    expect(hitAt).toBeLessThan(19);
    const t = c.telemetry();
    expect(t.collision.objectHits).toBeGreaterThan(0);
    expect(t.posSim.z).toBeLessThan(20); // held at the face, never through it
    expect(Math.abs(t.velSim.z)).toBeLessThan(3);
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

// ---- the gate on a real BUILT stage (public/assets): the reported bug, a car through a railing panel ----
const RAIL_STAGES: [string, RegExp][] = [
  ['hillclimb-3a-f', /^NZFence5$/],
  ['kenya-1-f', /^(kn_riotfence_01|NZFence4|NZFence5)$/],
  // the other families (verifier): wire fence, concrete sign wall, ice-track fence (origin at 0, world-space mesh), stage-3 fence
  ['newzealand-1-f', /^NZFence3$/],
  ['rallycross-1-f', /^RC_Sign_ConcreteLong_/],
  ['iceracing-3-f', /^(ir3fence\d+|RC_Sign_ConcreteLong_)/],
  ['corsica-3-r', /^NZFence4$/],
];
const railAsset = (id: string) => `public/assets/stages/${id}/collision`;

interface RailTarget {
  world: OrigWorld;
  /** A point on the panel's face at ground + 0.45 and the face's horizontal outward normal. */
  P: V;
  n: V;
  /** The instance origin (transform translation) and bounding radius (object +8). */
  origin: V;
  radius: number;
  /** The face's along-extent from the target point (m): the car may slide around the panel's END (s < 0 there). */
  span: number;
}

/** The stage's first railing instance with a drivable wall face at the panel's MIDDLE: vertical, spanning the car's
 *  hull heights, a level 5 m approach on the mesh, and farther from the instance's origin than the OLD single-branch
 *  trunk gate (0.2·radius + 1.5, 0x4a8008) reached — the exact drive that passed through before the two-branch gate. */
function findRailingTarget(id: string, tpl: RegExp): RailTarget | null {
  const meta = JSON.parse(fs.readFileSync(`${railAsset(id)}.json`, 'utf8')) as {
    obstacles: { kinds: string[]; templates: string[] };
  };
  const d = parseRcol(fs.readFileSync(`${railAsset(id)}.bin`).slice().buffer as ArrayBuffer);
  const world = new OrigWorld(d, createFlatWorld() as unknown as WorldQuery, { kinds: meta.obstacles.kinds });
  for (let k = 0; k < d.nInst; k++) {
    const bi = k * d.instStride;
    if (!tpl.test(meta.obstacles.templates[d.inst[bi + INST.TEMPLATE]] ?? '')) continue;
    const M = Array.from(d.inst.subarray(bi + INST.M, bi + INST.M + 9));
    const T = Array.from(d.inst.subarray(bi + INST.T, bi + INST.T + 3)) as V;
    const radius = d.inst[bi + INST.RADIUS];
    const mi = d.inst[bi + INST.MESH] * MESH_STRIDE;
    const t0 = d.mesh[mi], nt = d.mesh[mi + 1];
    const verts = new Map<number, V>();
    const xf = (i: number): V => {
      let v = verts.get(i);
      if (!v) {
        const x = d.mV[3 * i], y = d.mV[3 * i + 1], z = d.mV[3 * i + 2];
        v = [x * M[0] + y * M[3] + z * M[6] + T[0], x * M[1] + y * M[4] + z * M[7] + T[1], x * M[2] + y * M[5] + z * M[8] + T[2]];
        verts.set(i, v);
      }
      return v;
    };
    const tris: V[][] = [], nOut: V[] = [];
    for (let t = t0; t < t0 + nt; t++) {
      tris.push([d.mTI[4 * t], d.mTI[4 * t + 1], d.mTI[4 * t + 2]].map(xf));
      const n = [-d.mTN[3 * t], -d.mTN[3 * t + 1], -d.mTN[3 * t + 2]];
      const r: V = [
        n[0] * M[0] + n[1] * M[3] + n[2] * M[6],
        n[0] * M[1] + n[1] * M[4] + n[2] * M[7],
        n[0] * M[2] + n[1] * M[5] + n[2] * M[8],
      ];
      const rl = Math.hypot(...r) || 1;
      nOut.push([r[0] / rl, r[1] / rl, r[2] / rl]);
    }
    const seen: V[] = [];
    for (let t = 0; t < tris.length; t++) {
      const n0 = nOut[t];
      if (Math.abs(n0[1]) > 0.25) continue; // a wall face, not the ground / roof
      const nl = Math.hypot(n0[0], n0[2]) || 1;
      const n: V = [n0[0] / nl, 0, n0[2] / nl];
      if (seen.some((s) => s[0] * n[0] + s[2] * n[2] > 0.98)) continue; // one face per direction
      seen.push(n);
      const c: V = [(tris[t][0][0] + tris[t][1][0] + tris[t][2][0]) / 3, (tris[t][0][1] + tris[t][1][1] + tris[t][2][1]) / 3, (tris[t][0][2] + tris[t][1][2] + tris[t][2][2]) / 3];
      const L: V = [n[2], 0, -n[0]]; // cross(up, n)
      // the coplanar triangles of this face
      const cop: number[] = [];
      for (let q = 0; q < tris.length; q++) {
        if (nOut[q][0] * n0[0] + nOut[q][1] * n0[1] + nOut[q][2] * n0[2] < 0.995) continue;
        const w = tris[q][0];
        if (Math.abs((w[0] - c[0]) * n0[0] + (w[1] - c[1]) * n0[1] + (w[2] - c[2]) * n0[2]) < 0.03) cop.push(q);
      }
      let uMin = Infinity, uMax = -Infinity;
      for (const q of cop) for (const w of tris[q]) {
        const u = (w[0] - c[0]) * L[0] + (w[2] - c[2]) * L[2];
        uMin = Math.min(uMin, u);
        uMax = Math.max(uMax, u);
      }
      if (uMax - uMin < 1.2) continue; // a panel, not a post edge
      const u = 0.5 * (uMin + uMax); // the panel's middle along the face
      const Pg: V = [c[0] + L[0] * u, c[1], c[2] + L[2] * u];
      const gy = world.heightAt(Pg[0], Pg[2], c[1] + 1);
      if (!world.onMesh(Pg[0], Pg[2]) || !Number.isFinite(gy)) continue;
      // the face covers the car's hull heights at the middle (ground + 0.3 .. + 0.7)
      let lo = Infinity, hi = -Infinity;
      for (const q of cop) {
        const pts = tris[q].map((w) => [(w[0] - c[0]) * L[0] + (w[2] - c[2]) * L[2], w[1]] as [number, number]);
        for (let e = 0; e < 3; e++) {
          const [u0, y0] = pts[e], [u1, y1] = pts[(e + 1) % 3];
          if ((u0 - u) * (u1 - u) > 0 || u0 === u1) continue;
          const y = y0 + ((u - u0) / (u1 - u0)) * (y1 - y0);
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
      }
      if (!(lo <= gy + 0.3 && hi >= gy + 0.7)) continue;
      // a level 5 m approach on the mesh: along the face's outward normal (the side a car comes from), 0.5 m steps
      let clear = true;
      for (let a = 0; a <= 5.001 && clear; a += 0.5) {
        const x = Pg[0] + n[0] * a, z = Pg[2] + n[2] * a;
        clear = world.onMesh(x, z) && Math.abs(world.heightAt(x, z, gy + 1) - gy) <= 2.5;
      }
      if (!clear) continue;
      const P: V = [Pg[0], gy + 0.45, Pg[2]];
      const mid = Math.hypot(P[0] - T[0], P[1] - T[1], P[2] - T[2]);
      if (mid <= radius * 0.2 + 1.5 + 0.8) continue; // not the mid-panel case
      return { world, P, n, origin: T, radius, span: Math.min(u - uMin, uMax - u) };
    }
  }
  return null;
}

describe('the gate on a BUILT stage railing (docs/orig/collision.md §4.1)', () => {
  // The packs ship in git (public/assets, deployed by CI): a checkout without them must fail loudly, never skip.
  it('the built stage packs for every railing family are present', () => {
    const missing = RAIL_STAGES.map(([id]) => id).filter((id) => !fs.existsSync(`${railAsset(id)}.bin`) || !fs.existsSync(`${railAsset(id)}.json`));
    expect(missing, 'missing public/assets/stages/<id>/collision.{bin,json}: run npm run assets').toEqual([]);
  });
  for (const kmh of [40, 140]) for (const [id, tpl] of RAIL_STAGES) {
    it(`${id}: a Micra into the MIDDLE of a railing panel at ${kmh} km/h is held at its face`, () => {
      const t = findRailingTarget(id, tpl);
      expect(t, 'a mid-panel railing face').not.toBeNull();
      if (!t) return;
      const { world: w, P, n, origin, radius, span } = t;
      // the panel's middle is beyond the old single-branch trunk gate: before the fix this drive passed through it
      expect(Math.hypot(P[0] - origin[0], P[1] - origin[1], P[2] - origin[2])).toBeGreaterThan(radius * 0.2 + 1.5);
      // a real Micra on the real stage, head-on into the face from 5 m out
      const d: V = [-n[0], 0, -n[2]];
      const S: V = [P[0] - d[0] * 5, 0, P[2] - d[2] * 5];
      const c = new CarSim({
        params: origCarParams('Micra'), world: w, surfaces: makeSurfaceTable(), origCar: 'Micra', slotBase: 0,
      });
      w.resetFaceCache();
      c.reset({ pos: { x: S[0], y: w.heightAt(S[0], S[2], P[1] + 1) + 0.6, z: S[2] }, q: qYawSim(Math.atan2(d[0], d[2])) });
      const A = c as unknown as { vW: { x: number; z: number }; W: { omega: number }[] };
      const v = kmh / 3.6;
      A.vW.x = d[0] * v;
      A.vW.z = d[2] * v;
      for (const wh of A.W) wh.omega = v / c.params.wheelRadius;
      const sOf = (p: { x: number; z: number }) => (p.x - P[0]) * n[0] + (p.z - P[2]) * n[2];
      const uOf = (p: { x: number; z: number }) => Math.abs((p.x - P[0]) * n[2] - (p.z - P[2]) * n[0]);
      let minS = Infinity;
      let lastOverS = NaN; // the face distance at the last step with the centre over the panel
      let held = 0; // steps with the centre over the panel and pressed against its face (the centre 0 .. 4 m in front of the plane: the hull reaches ~2 m ahead of it)
      for (let i = 0; i < 600; i++) {
        c.step(drive(0.4), DT);
        const p = c.telemetry().posSim;
        // while the centre is over the panel (a car scraping along the face may slide around its END)
        if (uOf(p) < span - 0.5) {
          const s = sOf(p);
          minS = Math.min(minS, s);
          lastOverS = s;
          if (s > -0.6 && s < 4) held++;
        }
      }
      const tel = c.telemetry();
      expect(tel.collision.objectHits).toBeGreaterThan(0); // the gate opened at the panel's middle
      expect(minS).toBeGreaterThan(-0.6); // the car's centre never crosses the face plane over the panel
      expect(Number.isFinite(lastOverS), 'the car reached the panel').toBe(true);
      expect(lastOverS).toBeGreaterThan(-0.6); // and was in front of the face on its last step over the panel
      expect(held).toBeGreaterThan(0); // it stayed pressed against the face (not a drive that never arrived)
    });
  }
});
