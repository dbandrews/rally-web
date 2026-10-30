/**
 * tests/sim/ground.test.ts — OWNED BY THE SIM BUILDER.
 *
 * The car's ground interface (MECHANICS_SPEC §2.5.1 / §2.5.3 / §2.9, research/formats/gcm.md §3.5 / §3.6):
 * wheel and hull SEGMENT queries with their face-cache slots, the suspension's compression fraction from the ray's
 * c0 / c4, the hull-probe schedule, the body solver against cases EXECUTED in the original exe
 * (research/frida/emu_body.py → fixtures/bodySolverCases.json), the original cars' hulls, the post-finish track
 * braking, and a drive on the ORIGINAL collision mesh (built collision part; skipped without assets).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DT, ORIG_CAR_IDS } from '../../src/core/constants';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { simStartPose } from '../../src/core/stageUtil';
import type { RayHit, SimV3, WorldQuery } from '../../src/core/types';
import { HULL_SLOT_OFFSET, SLOTS_PER_CAR } from '../../src/core/worldQuery';
import { liftAboveGround } from '../../src/game/stageMath';
import { CarSim } from '../../src/sim/car';
import { ORIG_HULLS, origHull } from '../../src/sim/origHulls';
import { makeCarParams, makeSurfaceTable } from '../../src/sim/params';
import { origCarParams } from '../../src/sim/presets';
import { loadOrigWorld, type OrigWorld } from '../../src/world/orig';
import { buildStage } from '../../src/world/stages';
import { builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';
import { createFlatWorld, flatSpawnPose } from './flatworld';
import { ctl, makeCar, run } from './harness';

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync(p: string, e: string): string; existsSync(p: string): boolean };

/** A world that records every segment query (origin, ray, slot) and forwards it. */
function spyWorld(inner: WorldQuery) {
  const calls: { o: SimV3; ray: SimV3; slot: number | undefined; hit: RayHit | null }[] = [];
  const w: WorldQuery = {
    ...inner,
    raycast: (o, d, m) => inner.raycast(o, d, m),
    segment: (o, ray, slot) => {
      const hit = inner.segment(o, ray, slot);
      calls.push({ o: { ...o }, ray: { ...ray }, slot, hit });
      return hit;
    },
  };
  return { w, calls };
}

describe('§2.5.1 / §2.5.3 wheel segments and the compression fraction', () => {
  it('wheels query the segment mount → mount − SL·up with slot wheel + 24·car; the spring reads x = 1 − (sink + c0)/(c4·SL)', () => {
    const { w, calls } = spyWorld(createFlatWorld());
    for (const slotBase of [0, 2 * SLOTS_PER_CAR]) {
      const c = new CarSim({ params: makeCarParams('awd_wrc'), world: w, surfaces: makeSurfaceTable(), slotBase });
      c.reset(flatSpawnPose(w, 0, 0, 0, 0.4225));
      calls.length = 0;
      c.step(ctl({ brake: 0.05 }), DT);
      const wheels = calls.filter((k) => k.slot !== undefined && k.slot - slotBase < HULL_SLOT_OFFSET);
      expect(wheels.map((k) => k.slot)).toEqual([slotBase, slotBase + 1, slotBase + 2, slotBase + 3]);
      const S = c as any;
      const SL = c.params.wheel.front.springLength;
      for (let i = 0; i < 4; i++) {
        const k = wheels[i];
        // the ray is the body's −up axis scaled by SL (not world down, not unit)
        expect(Math.hypot(k.ray.x, k.ray.y, k.ray.z)).toBeCloseTo(SL, 9);
        expect(k.ray.x / SL + S.up.x).toBeCloseTo(0, 9);
        const h = k.hit!;
        expect(h.depth).toBeLessThanOrEqual(0);
        expect(h.cos).toBeCloseTo(-SL * S.up.y, 6);
        // c0 / c4 = (SL − hitDist)/SL: a FRACTION (gcm.md §3.5, Frida-proven, MECHANICS_SPEC §2.5.3 v1.5)
        expect(h.depth! / h.cos!).toBeCloseTo((SL - h.dist) / SL, 9);
        const W = S.W[i];
        expect(W.c0).toBe(h.depth);
        expect(W.c4).toBe(h.cos);
        expect(W.ext).toBeCloseTo(Math.min(1, Math.max(0, 1 - h.depth! / (h.cos! * SL))), 12); // tarmac: sink 0
      }
    }
  });
  it('the static compression in metres is (1 − x)·SL²: the body rides at mount.y − hitDist ≈ 0.446 m (awd)', () => {
    const c = makeCar({});
    run(c, 2, () => ctl({ brake: 0.05 })); // a held pedal disables sleep: true spring equilibrium
    const S = c as any;
    const SL = c.params.wheel.front.springLength;
    const mean = S.W.reduce((a: number, w: any) => a + w.ext, 0) / 4;
    const hit = SL - (1 - mean) * SL * SL;
    const mountY = c.params.wheelFL.y - c.params.wheelRadius;
    expect(c.telemetry().posSim.y).toBeCloseTo(hit - mountY, 2);
    expect(c.telemetry().posSim.y).toBeGreaterThan(0.435);
    expect(c.telemetry().posSim.y).toBeLessThan(0.455);
  });
  it('a miss leaves c0 = 0, c4 = 1, no contact; an origin below the ground is a miss (one-sided segment)', () => {
    const c = new CarSim({ params: makeCarParams('awd_wrc'), world: createFlatWorld() });
    c.reset({ pos: { x: 0, y: 5, z: 0 }, q: { w: 1, x: 0, y: 0, z: 0 } }, 0);
    // settle runs during reset: lift it again and step once in the air
    const S = c as any;
    S.pos.y = 5;
    S.vW.y = 0;
    c.step(ctl(), DT);
    for (const w of S.W) {
      expect(w.contact).toBe(false);
      expect(w.c0).toBe(0);
      expect(w.c4).toBe(1);
      expect(w.normalW).toEqual({ x: 0, y: 1, z: 0 });
    }
    S.pos.y = -2; // every mount below the plane: start below → miss
    c.step(ctl(), DT);
    expect(S.W.every((w: any) => !w.contact)).toBe(true);
  });
});

describe('§2.9 hull probes [V FUN_006cea90 tail]', () => {
  it('upright on 4 wheels: only the 4 bottom corners every step (belt points need a raised corner state, roof needs < 3 wheels)', () => {
    const { w, calls } = spyWorld(createFlatWorld());
    const c = new CarSim({ params: makeCarParams('awd_wrc'), world: w });
    c.reset(flatSpawnPose(w, 0, 0, 0, 0.4225));
    for (let k = 0; k < 4; k++) {
      calls.length = 0;
      c.step(ctl(), DT);
      expect(calls.filter((q) => q.slot! >= HULL_SLOT_OFFSET).map((q) => q.slot! - HULL_SLOT_OFFSET)).toEqual([0, 1, 2, 3]);
    }
  });
  it('airborne: 12 points on the car\'s turn (parity == carIndex >> 1), else 0-3 plus the points that hit last time; segments start at the PREVIOUS step\'s COM', () => {
    for (const carIndex of [0, 2]) {
      const { w, calls } = spyWorld(createFlatWorld());
      const c = new CarSim({ params: makeCarParams('awd_wrc'), world: w, slotBase: carIndex * SLOTS_PER_CAR });
      c.reset(flatSpawnPose(w, 0, 0, 0, 0.4225));
      const S = c as any;
      S.pos.y = 6;
      S.vW.x = 3;
      const counts: number[] = [];
      for (let k = 0; k < 6; k++) {
        const prev = { ...S.pos };
        calls.length = 0;
        c.step(ctl(), DT);
        const hull = calls.filter((q) => q.slot! - carIndex * SLOTS_PER_CAR >= HULL_SLOT_OFFSET);
        counts.push(hull.length);
        for (const q of hull) expect(Math.hypot(q.o.x - prev.x, q.o.y - prev.y, q.o.z - prev.z)).toBeLessThan(1e-12);
        expect(S.stepParity === carIndex >> 1 ? hull.length : 4).toBe(hull.length);
      }
      expect(counts).toContain(12);
      expect(counts).toContain(4);
    }
  });
  it('the accumulation: push direction Σ(−depth·n), depth-weighted contact point, mean depth, smallest material', () => {
    // a 10° tilted plane under a car lying on its roof: every contact has the plane normal
    const n = { x: Math.sin(0.17), y: Math.cos(0.17), z: 0 };
    const world = createFlatWorld({ surface: 'gravel', normal: n });
    const c = new CarSim({ params: makeCarParams('awd_wrc', { tyreType: 2 }), world });
    c.reset({ pos: { x: 0, y: 1.4, z: 0 }, q: { w: 0, x: 0, y: 0, z: 1 } }, 0);
    const S = c as any;
    run(c, 0.25, () => ctl());
    expect(S.hullFlags & 1).toBe(1);
    expect(S.hullDir.x).toBeCloseTo(n.x, 6);
    expect(S.hullDir.y).toBeCloseTo(n.y, 6);
    expect(S.hullDepth).toBeLessThanOrEqual(0);
    expect(S.hullMat).toBe(2); // GRAVEL's original byte
    expect(S.hullPt.y).toBeCloseTo(1.0, 6); // the roof points (body y = 1.0) carry the contact
    expect(c.telemetry().bodyOnGround).toBe(true);
  });
});

describe('§2.9 body solver = the executed original FUN_006d0970', () => {
  type V = [number, number, number];
  const cases = JSON.parse(fs.readFileSync('tests/sim/fixtures/bodySolverCases.json', 'utf8')) as {
    in: { mass: number; I: V; R: [V, V, V]; Rp: [V, V, V]; pos: V; vW: V; vL: V; w: V; L: V; Fext: V; n: V; nPrev: V; c: V; cPrev: V; prevPos: V; T: number; depth: number; share: number; mat: number; flags: number; dt: number };
    out: { vW: V; L: V; pos: V; T: number; prevN: V; prevC: V; prevPos: V };
  }[];
  it(`${cases.length} cases run in the original exe (unicorn): vW, L, pos, anchor timer and memory agree to float32`, () => {
    const c = new CarSim({ params: makeCarParams('awd_wrc'), world: createFlatWorld(), surfaces: makeSurfaceTable() });
    const S = c as any;
    const set = (t: { x: number; y: number; z: number }, v: V) => { t.x = v[0]; t.y = v[1]; t.z = v[2]; };
    const d = (a: { x: number; y: number; z: number }, b: V) => Math.hypot(a.x - b[0], a.y - b[1], a.z - b[2]);
    const mats = new Set<number>();
    for (const k of cases) {
      const i = k.in;
      S.mass = i.mass; S.invMass = 1 / i.mass;
      set(S.I, i.I); S.invI.x = 1 / i.I[0]; S.invI.y = 1 / i.I[1]; S.invI.z = 1 / i.I[2];
      set(S.right, i.R[0]); set(S.up, i.R[1]); set(S.fwd, i.R[2]);
      set(S.pos, i.pos); set(S.vW, i.vW); set(S.vL, i.vL); set(S.w, i.w); set(S.L, i.L); set(S.Fext, i.Fext);
      set(S.hullDir, i.n); set(S.bsPrevN, i.nPrev); set(S.hullPt, i.c); set(S.bsPrevC, i.cPrev); set(S.bsPrevPos, i.prevPos);
      S.bsPrevR.set([...i.Rp[0], ...i.Rp[1], ...i.Rp[2]]);
      S.bsT = i.T; S.hullDepth = i.depth; S.bodyShare = i.share; S.hullMat = i.mat; S.hullFlags = i.flags;
      S.bodySolver(i.dt);
      const o = k.out;
      expect(d(S.vW, o.vW) / Math.max(1, Math.hypot(...o.vW))).toBeLessThan(1e-4);
      expect(d(S.L, o.L) / Math.max(10, Math.hypot(...o.L))).toBeLessThan(1e-4);
      expect(d(S.pos, o.pos)).toBeLessThan(1e-4);
      expect(Math.abs(S.bsT - o.T)).toBeLessThan(1e-6);
      expect(d(S.bsPrevN, o.prevN)).toBe(0);
      expect(d(S.bsPrevC, o.prevC)).toBe(0);
      mats.add(Math.min(i.mat, 24));
    }
    expect(mats.size).toBeGreaterThan(20); // ground materials, DUMMY and non-ground solids all covered
  });
});

describe('original car hulls (Car_<Name>.col) and the post-finish track braking', () => {
  it('every original car has its 12-point hull; CarSim uses it when given origCar, else the archetype box', () => {
    for (const id of ORIG_CAR_IDS) {
      const h = ORIG_HULLS[id];
      expect(h, id).toBeDefined();
      expect(h.length).toBe(12);
      // order: 0-3 bottom corners FL FR RR RL, 4-7 belt line, 8-11 roof
      expect(h[0][1]).toBe(h[3][1]);
      expect(h[0][0]).toBeLessThan(0);
      expect(h[1][0]).toBeGreaterThan(0);
      expect(h[0][2]).toBeGreaterThan(h[3][2]);
      expect(h[8][1]).toBeGreaterThan(h[4][1]);
    }
    const c = new CarSim({ params: origCarParams('FordEscort'), world: createFlatWorld(), origCar: 'FordEscort' });
    expect(c.hullCar).toBe('FordEscort');
    expect((c as any).hull).toEqual(origHull('FordEscort'));
    expect(new CarSim({ params: makeCarParams('awd_wrc'), world: createFlatWorld() }).hullCar).toBeNull();
  });
  it('setTrackBraking(0.4) adds F = 0.4·(km/h/240·0.125 + 0.15)·Fext.y·vL (P+0x44), cleared by reset', () => {
    const decel = (factor: number) => {
      const c = makeCar({});
      c.setForwardSpeed(25);
      run(c, 0.1, () => ctl());
      if (factor) c.setTrackBraking(factor);
      const v0 = c.telemetry().speedWorldKmh / 3.6;
      run(c, 0.25, () => ctl());
      return { a: (v0 - c.telemetry().speedWorldKmh / 3.6) / 0.25, c };
    };
    const off = decel(0).a;
    const on = decel(0.4);
    // the drag on the body at ≈ 85 km/h: 0.4·(85/240·0.125 + 0.15)·12·23.6 m/s ≈ 22 m/s²; the rolling wheels (inertia
    // 1/0.050027 = 20 kg·m² each, 4·20/0.3² ≈ 890 kg of equivalent mass) push back through the tyres, so the car slows
    // by ≈ 22·1230/(1230 + 890) ≈ 13 m/s² more than coasting (the Frida replay checks the force itself: run2, 360 steps)
    expect(on.a - off).toBeGreaterThan(11);
    expect(on.a - off).toBeLessThan(16);
    on.c.reset(flatSpawnPose(createFlatWorld(), 0, 0, 0, 0.4225));
    expect((on.c as any).trackBraking).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------- original mesh
const MESH_STAGE = 'rallycross-1-f';
const meshReady = builtAssetsPresent && fs.existsSync(`public/assets/stages/${MESH_STAGE}/collision.json`);

describe.skipIf(!meshReady)('on the ORIGINAL collision mesh (Track.gcm, built collision part)', () => {
  let world: OrigWorld;
  beforeAll(async () => {
    useBuiltAssets();
    world = await loadOrigWorld(MESH_STAGE, buildStage(MESH_STAGE, 1).world);
  }, 120_000); // a built stage + its collision part: well past vitest's 10 s hook default in a parallel run
  afterAll(() => _setAssetFetchForTests(null));

  it('the FordEscort (its own hull) settles on the start grid, drives 5 s on the real road, no faults; step cost', () => {
    const stage = buildStage(MESH_STAGE, 1).stage;
    const pose = liftAboveGround(stage, simStartPose(stage, world), 0.6, world);
    const c = new CarSim({ params: origCarParams('FordEscort', { tyreType: 1 }), world, origCar: 'FordEscort' });
    c.reset(pose);
    const t0 = c.telemetry();
    expect(t0.nContacts).toBe(4);
    expect(t0.wheels.every((w) => w.surface !== null)).toBe(true);
    let minContacts = 4;
    let steps = 0;
    const start = performance.now();
    run(c, 5, (t) => ctl({ throttle: t < 4 ? 0.8 : 0, brake: t < 4 ? 0 : 0.6 }), () => {
      minContacts = Math.min(minContacts, c.telemetry().nContacts);
      steps++;
    });
    const msPerStep = (performance.now() - start) / steps;
    const t = c.telemetry();
    expect(t.simFaults).toBe(0);
    expect(minContacts).toBeGreaterThanOrEqual(2);
    expect(Math.hypot(t.posSim.x - pose.pos.x, t.posSim.z - pose.pos.z)).toBeGreaterThan(20);
    // segment queries on the mesh: 4 wheel + 4..12 hull segments per step stay far below the 8.3 ms step
    expect(msPerStep).toBeLessThan(0.5);
  });
});
