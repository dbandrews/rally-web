// tests/world/origCollision.test.ts — the mesh WorldQuery on the BUILT collision part (public/assets, `npm run
// assets -- --parts collision`) against
//   * the golden rays of the faithful Python reference (tests/world/fixtures/orig/gcm_golden_<stage>.bin,
//     gen_gcm_golden.py): hit/miss, face, t, depth, cos, raw material and hit point bit-identical, incl. tilted
//     wheel rays (Bresenham path), hull segments, long rays, e1 == 0 / d0 == 0 starts and face-cache sequences;
//   * the wheel rays recorded from the RUNNING original (gcm_trace_rallycross1.bin, research/formats/gcm.md §8.2):
//     hit/miss and material equal, depth (c0) / cos (c4) / normal within the recorded float precision;
//   * a speed budget (< 5 µs per wheel ray) and the attachOriginalWorld wiring.
// Skipped when the packs are absent (CI, fresh clones).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests, getAssetManifest, isPortedStageId, manifestHasStagePart } from '../../src/core/assets';
import { MATERIAL_NONE, materialFromOrig } from '../../src/core/constants';
import type { WorldQuery } from '../../src/core/types';
import { wheelSlot } from '../../src/core/worldQuery';
import { attachOriginalWorld, loadOrigWorld, OrigWorld, parseRcol, stageFrameFit } from '../../src/world/orig';
import { buildStage, listStages } from '../../src/world/stages';
import { builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
}
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;
const FIX = 'tests/world/fixtures/orig';
const GOLDEN = ['corsica-2-f', 'hillclimb-1c-f', 'newzealand-3-f', 'kenya-1-f', 'rallycross-1-f', 'iceracing-3-f'];
const hasPart = (id: string) => fs.existsSync(`public/assets/stages/${id}/collision.json`);
const ready = builtAssetsPresent && GOLDEN.every(hasPart);
const BUILT = listStages().map((s) => s.id).filter((id) => isPortedStageId(id) && hasPart(id));

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

interface GoldenRay {
  o: { x: number; y: number; z: number };
  r: { x: number; y: number; z: number };
  slot: number;
  cat: number;
  hit: boolean;
  mat: number;
  flags: number;
  face: number;
  t: number;
  depth: number;
  cos: number;
  p: [number, number, number];
}

function readGolden(id: string): GoldenRay[] {
  const b = fs.readFileSync(`${FIX}/gcm_golden_${id}.bin`);
  const dv = view(b);
  expect(String.fromCharCode(b[0], b[1], b[2], b[3])).toBe('GGLD');
  const n = dv.getUint32(8, true);
  const out: GoldenRay[] = [];
  for (let k = 0, o = 44; k < n; k++, o += 84) {
    const f = (i: number) => dv.getFloat32(o + 4 * i, true);
    const d = (i: number) => dv.getFloat64(o + 36 + 8 * i, true);
    out.push({
      o: { x: f(0), y: f(1), z: f(2) },
      r: { x: f(3), y: f(4), z: f(5) },
      slot: dv.getInt32(o + 24, true),
      cat: dv.getUint8(o + 28),
      hit: dv.getUint8(o + 29) === 1,
      mat: dv.getUint8(o + 30),
      flags: dv.getUint8(o + 31),
      face: dv.getInt32(o + 32, true),
      t: d(0),
      depth: d(1),
      cos: d(2),
      p: [d(3), d(4), d(5)],
    });
  }
  return out;
}

/** The hook below builds and loads every GOLDEN stage (≈ 70 s alone, more in a parallel run): far past vitest's 10 s
 *  hook default (vite.config.ts sets only testTimeout). */
const LOAD_TIMEOUT_MS = 300_000;

describe.skipIf(!ready)('original collision mesh (built assets)', () => {
  const worlds = new Map<string, OrigWorld>();
  beforeAll(async () => {
    useBuiltAssets();
    for (const id of GOLDEN) worlds.set(id, await loadOrigWorld(id, buildStage(id, 1).world));
  }, LOAD_TIMEOUT_MS);
  afterAll(() => _setAssetFetchForTests(null));

  describe.each(GOLDEN)('%s', (id) => {
    it('reproduces the Python reference rays exactly (hit, face, t, depth, cos, material, point)', () => {
      const w = worlds.get(id)!;
      w.resetFaceCache();
      const rays = readGolden(id);
      expect(rays.length).toBeGreaterThan(3000);
      const bad: string[] = [];
      const cats = new Array(7).fill(0);
      for (let k = 0; k < rays.length; k++) {
        const g = rays[k];
        cats[g.cat]++;
        const h = w.segment(g.o, g.r, g.slot);
        if (!!h !== g.hit) {
          bad.push(`#${k} cat ${g.cat}: hit ${!!h} != ${g.hit}`);
          continue;
        }
        if (!h) continue;
        if (h.face !== g.face || h.t !== g.t || h.depth !== g.depth || h.cos !== g.cos || h.origMaterial !== g.mat ||
          h.point.x !== g.p[0] || h.point.y !== g.p[1] || h.point.z !== g.p[2]) {
          bad.push(`#${k} cat ${g.cat}: face ${h.face}/${g.face} t ${h.t}/${g.t} depth ${h.depth}/${g.depth}`);
        }
        expect(h.material).toBe(materialFromOrig(g.mat));
        expect(h.dist).toBeCloseTo(h.t! * Math.hypot(g.r.x, g.r.y, g.r.z), 9);
      }
      expect(bad.slice(0, 10)).toEqual([]);
      // every ray family is present (vertical, cliffs, tilted wheels, hulls, long, vertex quirks)
      for (let c = 0; c < 6; c++) expect(cats[c]).toBeGreaterThan(100);
    });
  });

  it('the fixtures exercise first ≠ nearest and cache-decided hits', () => {
    let firstNotNearest = 0, cacheDecided = 0, nonVertical = 0;
    for (const id of GOLDEN) {
      for (const g of readGolden(id)) {
        if (g.flags & 1) firstNotNearest++;
        if (g.flags & 2) cacheDecided++;
        if (g.r.x * g.r.x + g.r.z * g.r.z > 0.0025) nonVertical++;
      }
    }
    expect(firstNotNearest).toBeGreaterThan(100);
    expect(cacheDecided).toBeGreaterThan(50);
    expect(nonVertical).toBeGreaterThan(5000);
  });

  it('agrees with the wheel rays recorded from the running original (rallycross1, gcm.md §8.2)', () => {
    const w = worlds.get('rallycross-1-f')!;
    w.resetFaceCache();
    const b = fs.readFileSync(`${FIX}/gcm_trace_rallycross1.bin`);
    const dv = view(b);
    expect(String.fromCharCode(b[0], b[1], b[2], b[3])).toBe('GTRC');
    const n = dv.getUint32(8, true);
    const off = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)];
    let hits = 0, misses = 0, tilted = 0, maxDc0 = 0, maxDc4 = 0, maxDn = 0;
    const bad: string[] = [];
    for (let k = 0, o = 24; k < n; k++, o += 64) {
      const f = (i: number) => dv.getFloat32(o + 4 * i, true);
      const end = [f(0), f(1), f(2)], vec = [f(3), f(4), f(5)];
      const car = dv.getUint8(o + 24), wheel = dv.getUint8(o + 25), refHit = dv.getUint8(o + 26) === 1;
      const mat = dv.getInt32(o + 28, true);
      const nrm = [dv.getFloat32(o + 32, true), dv.getFloat32(o + 36, true), dv.getFloat32(o + 40, true)];
      const c0 = dv.getFloat32(o + 44, true), c4 = dv.getFloat32(o + 48, true);
      const refFace = dv.getInt32(o + 52, true), refDepth = dv.getFloat64(o + 56, true);
      // origin = end − ray − track translation (the original's W+0x94 − W+0xa0, 0x595c91)
      const origin = { x: end[0] - vec[0] - off[0], y: end[1] - vec[1] - off[1], z: end[2] - vec[2] - off[2] };
      let h = w.segment(origin, { x: vec[0], y: vec[1], z: vec[2] }, wheelSlot(24 * car, wheel));
      if (h && h.origMaterial! >= 0x20) h = null; // the wheel cut (FUN_006cea90)
      if (vec[0] * vec[0] + vec[2] * vec[2] > 0.0025) tilted++;
      if (!!h !== (mat !== -1) || !!h !== refHit) {
        bad.push(`#${k}: port ${!!h} orig ${mat !== -1} ref ${refHit}`);
        continue;
      }
      if (!h) {
        misses++;
        continue;
      }
      hits++;
      if (h.origMaterial !== mat) bad.push(`#${k}: material ${h.origMaterial} != ${mat}`);
      if (h.face !== refFace || h.depth !== refDepth) bad.push(`#${k}: reference face ${h.face}/${refFace}`);
      maxDc0 = Math.max(maxDc0, Math.abs(h.depth! - c0));
      maxDc4 = Math.max(maxDc4, Math.abs(h.cos! - c4));
      maxDn = Math.max(maxDn, Math.abs(h.normal.x - nrm[0]), Math.abs(h.normal.y - nrm[1]), Math.abs(h.normal.z - nrm[2]));
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(hits + misses).toBe(n);
    expect(misses).toBeGreaterThan(100);
    expect(tilted).toBeGreaterThan(1000);
    // the original runs x87 single-precision intermediates: c0 / c4 agree to the recorded float precision
    expect(maxDc0).toBeLessThan(1e-4);
    expect(maxDc4).toBeLessThan(1e-3);
    expect(maxDn).toBeLessThan(0.03);
  });

  it('raycast = segment(o, dir·max, −1): an origin below the ground misses', async () => {
    const built = buildStage('rallycross-1-f', 1);
    const w = (await attachOriginalWorld(built)).world as OrigWorld;
    const st = built.stage;
    let n = 0;
    for (let i = 0; i < st.road.length; i += 25) {
      const r = st.road[i];
      const x = r.pos.x, z = -r.pos.z;
      const y = w.heightAt(x, z);
      const hit = w.raycast({ x, y: y + 2, z }, { x: 0, y: -1, z: 0 }, 5);
      if (!hit) continue;
      n++;
      expect(Math.abs(hit.dist - 2)).toBeLessThan(1e-4);
      expect(hit.t).toBeCloseTo(hit.dist / 5, 9);
      expect(hit.material).not.toBe(MATERIAL_NONE);
      expect(w.raycast({ x, y: y - 0.3, z }, { x: 0, y: -1, z: 0 }, 5)).toBeNull();
      // heightAt is the surface the vertical segment hits (single level here)
      expect(Math.abs(hit.point.y - y)).toBeLessThan(1e-9);
    }
    expect(n).toBeGreaterThan(20);
  });

  it('every built stage: the raced road lies on the mesh in the contract frame (sim = three with z negated)', () => {
    const rows: string[] = [];
    let mirrored = 0;
    for (const id of BUILT) {
      const b = fs.readFileSync(`public/assets/stages/${id}/collision.bin`);
      const data = parseRcol(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      const fit = stageFrameFit(buildStage(id, 1).stage, data);
      if (fit.mirrorZ) mirrored++;
      rows.push(`${id} ${(100 * fit.sim).toFixed(0)}/${(100 * fit.mirrored).toFixed(0)}`);
      expect(fit.sim, id).toBeGreaterThan(0.95);
      expect(fit.mirrorZ, id).toBe(false);
    }
    console.info(`[collision] road on the mesh % (sim / mirrored), ${mirrored} of ${BUILT.length} stages mirrored: ${rows.join(', ')}`);
  });

  it('point queries on the road: the ground under the race line is on the mesh with a road material', async () => {
    for (const id of GOLDEN) {
      const built = buildStage(id, 1);
      const w = (await attachOriginalWorld(built)).world as OrigWorld;
      expect(w).toBeInstanceOf(OrigWorld);
      const st = built.stage;
      let on = 0, total = 0, sumDy = 0, slip = 0;
      for (let i = 0; i < st.road.length; i += 10) {
        const r = st.road[i];
        if (!st.closed && (r.s < st.startS || r.s > st.finishS)) continue;
        total++;
        const x = r.pos.x, z = -r.pos.z;
        if (!w.onMesh(x, z)) continue;
        on++;
        const y = w.heightAt(x, z, r.pos.y);
        sumDy += Math.abs(y - r.pos.y);
        expect(Number.isFinite(y)).toBe(true);
        expect(w.surfaceAt(x, z, r.pos.y)).not.toBeNull();
        expect(w.normalAt(x, z, r.pos.y).y).toBeGreaterThan(0);
        // a wheel ray from 0.5 m above the surface finds the same ground (first hit = the level picked)
        const h = w.segment({ x, y: y + 0.5, z }, { x: 0, y: -0.75, z: 0 }, -1);
        if (!h || Math.abs(h.point.y - y) > 1e-6) slip++;
      }
      expect(on / total, id).toBeGreaterThan(0.97);
      expect(sumDy / Math.max(1, on), id).toBeLessThan(1.0); // the ported spline lies on the mesh (gcm.md §8.3)
      expect(slip / Math.max(1, on), id).toBeLessThan(0.02);
    }
  });

  it('query cost: wheel / hull segments well under 5 µs on every golden stage', () => {
    const rows: string[] = [];
    const time = (rays: GoldenRay[], useSlot: boolean, w: OrigWorld) => {
      const N = Math.max(100_000, rays.length);
      for (let k = 0; k < 20_000; k++) w.segment(rays[k % rays.length].o, rays[k % rays.length].r, useSlot ? rays[k % rays.length].slot : -1);
      const t0 = performance.now();
      for (let k = 0; k < N; k++) {
        const g = rays[k % rays.length];
        w.segment(g.o, g.r, useSlot ? g.slot : -1);
      }
      return ((performance.now() - t0) * 1e6) / N; // ns
    };
    for (const id of GOLDEN) {
      const w = worlds.get(id)!;
      w.resetFaceCache();
      const all = readGolden(id);
      const vertical = time(all.filter((g) => g.cat === 0), false, w);
      const tilted = time(all.filter((g) => g.cat === 2), true, w); // moving 4-wheel sequences, per-wheel slots
      const hull = time(all.filter((g) => g.cat === 3), true, w); // COM → 12 hull points, slots 8..19
      const d = w.grid.d;
      const t0 = performance.now();
      let acc = 0;
      for (let k = 0; k < 100_000; k++) acc += w.heightAt(d.minX + ((k * 0.618034) % 1) * (d.maxX - d.minX), d.minZ + ((k * 0.414214) % 1) * (d.maxZ - d.minZ));
      const height = ((performance.now() - t0) * 1e6) / 100_000;
      expect(Number.isFinite(acc)).toBe(true);
      rows.push(`${id} vertical ${vertical.toFixed(0)} / tilted ${tilted.toFixed(0)} / hull ${hull.toFixed(0)} / heightAt ${height.toFixed(0)} ns`);
      for (const ns of [vertical, tilted, hull]) expect(ns).toBeLessThan(5000);
    }
    console.info(`[collision] query cost: ${rows.join('; ')}`);
  });

  it('obstacle proxies: hard cylinders near the road, dynamic parts kept apart', async () => {
    for (const id of GOLDEN) {
      const built = buildStage(id, 1);
      const w = (await attachOriginalWorld(built)).world as OrigWorld;
      const hard = w.obstacles.hard.list.length;
      expect(hard).toBeGreaterThan(0);
      const p = built.stage.startPose.pos;
      const near = w.obstaclesNear({ x: p.x, y: p.y, z: -p.z }, 400);
      expect(near.length, id).toBeGreaterThan(0);
      for (const o of near) {
        expect(o.radius).toBeGreaterThan(0);
        expect(Number.isFinite(o.pos.x + o.pos.y + o.pos.z + o.height)).toBe(true);
        expect(Math.hypot(o.pos.x - p.x, o.pos.z + p.z)).toBeLessThan(400 + o.radius);
      }
      // no proxy is returned twice, and a far query returns nothing
      expect(new Set(near).size).toBe(near.length);
      expect(w.obstaclesNear({ x: 1e7, y: 0, z: 1e7 }, 50)).toEqual([]);
      // loose parts (cones, signs, barrels) carry their .col hull, never in obstaclesNear
      for (const o of w.partsNear({ x: p.x, y: p.y, z: -p.z }, 5000)) {
        expect(near.includes(o)).toBe(false);
      }
    }
  });

  it('attachOriginalWorld returns the mesh world for a built stage and keeps procedural stages', async () => {
    const m = await getAssetManifest();
    expect(manifestHasStagePart(m, 'kenya-1-f', 'collision')).toBe(true);
    const built = buildStage('kenya-1-f', 1);
    const att = await attachOriginalWorld(built);
    expect(att.stage).toBe(built.stage);
    expect(att.world).toBeInstanceOf(OrigWorld);
    const proc = buildStage('testpad', 1);
    expect((await attachOriginalWorld(proc)).world).toBe(proc.world);
    const wq: WorldQuery = att.world;
    expect(Number.isFinite(wq.heightAt(1e6, 1e6))).toBe(true); // off the mesh: procedural fallback
  });
});
