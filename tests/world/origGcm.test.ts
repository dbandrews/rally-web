// tests/world/origGcm.test.ts — the literal Track.gcm query port (src/world/orig/gcm.ts) and the mesh
// WorldQuery (src/world/orig/world.ts) on a small hand-built RCOL file: one-sidedness, the d0 = 0 miss, the
// e1 == 0 quirk, first hit (not nearest), the per-slot face cache and its block-change reset, the Bresenham
// path across blocks, the yHint level rule, the off-mesh fallback and the obstacle classes. Runs without
// built assets (the real-data goldens are in origCollision.test.ts).
import { describe, expect, it } from 'vitest';
import { MATERIAL, materialFromOrig } from '../../src/core/constants';
import type { Obstacle, SimV3, Stage, WorldQuery } from '../../src/core/types';
import { BRESENHAM_LIMIT2, GcmGrid } from '../../src/world/orig/gcm';
import { stageFrameFit } from '../../src/world/orig';
import { OBST_DYNAMIC, OBST_HARD, OBST_SOFT, parseRcol } from '../../src/world/orig/rcol';
import { OrigWorld } from '../../src/world/orig/world';
import { makeRayHit, segmentViaRaycast } from '../../src/core/worldQuery';
import { buildStage } from '../../src/world/stages';

interface Face {
  v: [number, number, number][];
  n: [number, number, number];
  m: number;
}

/** Write an RCOL v1 file (layout: tools/assets/parts/collision.py) from faces + blocks. */
function buildRcol(opts: {
  faces: Face[];
  bbox: [number, number, number, number];
  dim: number;
  cellBlocks: (i: number, j: number) => number[];
  blocks: { min: [number, number, number]; max: [number, number, number]; dim: number; cells: number[][] }[];
  obst?: number[][];
  hull?: number[];
}): ArrayBuffer {
  const V: number[] = [], I: number[] = [], M: number[] = [], FN: number[] = [];
  for (const f of opts.faces) {
    for (const p of f.v) {
      I.push(V.length / 3);
      V.push(...p);
    }
    FN.push(...f.n);
    M.push(f.m);
  }
  const cellList: number[] = [];
  for (let i = 0; i < opts.dim; i++) for (let j = 0; j < opts.dim; j++) cellList.push(...opts.cellBlocks(i, j), 0xffff);
  const blkF: number[] = [], blkU: number[] = [], off: number[] = [], list16: number[] = [];
  for (const b of opts.blocks) {
    blkF.push(...b.min, ...b.max, Math.fround(b.dim / (b.max[0] - b.min[0])), Math.fround(b.dim / (b.max[2] - b.min[2])));
    blkU.push(b.dim, 1, 0, off.length, list16.length);
    const base = list16.length;
    for (const c of b.cells) {
      off.push(list16.length - base);
      list16.push(...c, 0xffff);
    }
  }
  const obst = opts.obst ?? [];
  const hull = opts.hull ?? [];
  const secs: [ArrayLike<number>, 'f32' | 'u16' | 'u32' | 'u8'][] = [
    [V, 'f32'], [I, 'u16'], [M, 'u8'], [FN, 'f32'], [cellList, 'u16'], [blkF, 'f32'], [blkU, 'u32'], [off, 'u16'],
    [list16, 'u16'], [[], 'u32'], [obst.flat(), 'f32'], [hull, 'f32'],
  ];
  const size = (a: ArrayLike<number>, t: string) => ((a.length * (t === 'u8' ? 1 : t === 'u16' ? 2 : 4) + 3) & ~3);
  const total = 96 + secs.reduce((s, [a, t]) => s + size(a, t), 0);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  'RCOL'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  const hdr = [1, V.length / 3, M.length];
  hdr.forEach((v, i) => dv.setUint32(4 + 4 * i, v, true));
  opts.bbox.forEach((v, i) => dv.setFloat32(16 + 4 * i, v, true));
  [opts.dim, cellList.length, opts.blocks.length, off.length, list16.length, 0, 1, obst.length, hull.length / 3, 16]
    .forEach((v, i) => dv.setUint32(32 + 4 * i, v, true));
  let o = 96;
  for (const [a, t] of secs) {
    for (let k = 0; k < a.length; k++) {
      if (t === 'f32') dv.setFloat32(o + 4 * k, a[k], true);
      else if (t === 'u32') dv.setUint32(o + 4 * k, a[k], true);
      else if (t === 'u16') dv.setUint16(o + 2 * k, a[k], true);
      else dv.setUint8(o + k, a[k]);
    }
    o += size(a, t);
  }
  return buf;
}

const UP: [number, number, number] = [0, 1, 0];
// ground y = 0 over [0,10]², split at x = 5 into block A (x < 5) and block B; a "bridge" deck at y = 5 over
// x ∈ [3, 5), z ∈ [0, 10] listed AFTER the ground in block A; a small tilted-free triangle T at y = 2 whose
// v0→v1 edge lies on z = 1 (for the e1 == 0 quirk).
const faces: Face[] = [
  { v: [[0, 0, 0], [0, 0, 10], [5, 0, 10]], n: UP, m: 1 }, // 0 ground A (ASPHALT)
  { v: [[0, 0, 0], [5, 0, 10], [5, 0, 0]], n: UP, m: 1 }, // 1 ground A
  { v: [[5, 0, 0], [5, 0, 10], [10, 0, 10]], n: UP, m: 2 }, // 2 ground B (GRAVEL)
  { v: [[5, 0, 0], [10, 0, 10], [10, 0, 0]], n: UP, m: 2 }, // 3 ground B
  { v: [[3, 5, 0], [3, 5, 10], [5, 5, 10]], n: UP, m: 0 }, // 4 bridge (GRASS)
  { v: [[3, 5, 0], [5, 5, 10], [5, 5, 0]], n: UP, m: 0 }, // 5 bridge
  { v: [[1, 2, 1], [2, 2, 1], [1.5, 2, 2]], n: UP, m: 16 }, // 6 T (GRAVELGRASS), e1 = 0 along z = 1
  { v: [[0, 0, 0], [0, 3, 0], [0, 0, 3]], n: [0, 0, 0], m: 5 }, // 7 inert zero normal
];
const rcol = buildRcol({
  faces,
  bbox: [0, 0, 10, 10],
  dim: 2,
  cellBlocks: (i) => (i === 0 ? [0] : [1]),
  blocks: [
    { min: [0, 0, 0], max: [5, 5, 10], dim: 1, cells: [[0, 1, 4, 5, 6, 7]] },
    { min: [5, 0, 0], max: [10, 0, 10], dim: 1, cells: [[2, 3]] },
  ],
  obst: [
    [7, 0, 2, 0.5, 3, 0, OBST_HARD, 6, 0, 0, 0, 0, 0, 0, 0, 0], // tree
    [7, 0, 4, 0.3, 1, 10, OBST_DYNAMIC, -1, 10, 1, 0, 0, 1, 0, 0, 0], // cone (hull 1 point)
    [7, 0, 6, 2.0, 2, 2, OBST_SOFT, -1, 0, 2, 0, 0, 0, 0, 0, 0], // bush
  ],
  hull: [7, 0.5, 4],
});

const FALLBACK_Y = -42;
const fallback: WorldQuery = {
  raycast: () => null,
  segment: () => null,
  heightAt: () => FALLBACK_Y,
  normalAt: () => ({ x: 0, y: 1, z: 0 }),
  materialAt: () => MATERIAL.grass,
  surfaceAt: () => 'grass',
  obstaclesNear: (_p: SimV3, _r: number, out: Obstacle[] = []) => ((out.length = 0), out),
};
const world = () => new OrigWorld(parseRcol(rcol), fallback, { kinds: ['tree', 'pine', 'bush', 'rock', 'boulder', 'post', 'sign', 'barrier', 'fence', 'tyreStack', 'cone'] });

describe('RCOL reader', () => {
  it('parses the sections and rebuilds cellStart from the terminators', () => {
    const d = parseRcol(rcol);
    expect(d.nF).toBe(faces.length);
    expect(Array.from(d.cellStart)).toEqual([0, 2, 4, 6, 8]);
    expect(d.nB).toBe(2);
    expect(d.nObst).toBe(3);
    expect(() => parseRcol(rcol.slice(0, 100))).toThrow();
  });
});

describe('segment (literal original query)', () => {
  it('hits the ground with every field filled (t, depth = d1, cos = n·ray, raw material)', () => {
    const h = world().segment({ x: 2, y: 1, z: 6 }, { x: 0, y: -2, z: 0 }, 0)!;
    expect(h.face).toBe(0);
    expect(h.t).toBe(0.5);
    expect(h.dist).toBe(1);
    expect(h.depth).toBe(-1);
    expect(h.cos).toBe(-2);
    expect(h.point).toEqual({ x: 2, y: 0, z: 6 });
    expect(h.origMaterial).toBe(1);
    expect(h.material).toBe(MATERIAL.tarmac);
    expect(h.material).toBe(materialFromOrig(1));
  });

  it('is one-sided: start on the plane, start below, upward and too-short segments miss', () => {
    const w = world();
    expect(w.segment({ x: 2, y: 0, z: 6 }, { x: 0, y: -1, z: 0 })).toBeNull(); // d0 = 0 → miss
    expect(w.segment({ x: 2, y: -0.5, z: 6 }, { x: 0, y: -1, z: 0 })).toBeNull();
    expect(w.segment({ x: 2, y: -0.5, z: 6 }, { x: 0, y: 2, z: 0 })).toBeNull(); // back face
    expect(w.segment({ x: 2, y: 2, z: 6 }, { x: 0, y: -1, z: 0 })).toBeNull();
    expect(w.segment({ x: 2, y: 1, z: 6 }, { x: 0, y: -1, z: 0 })).not.toBeNull(); // end ON the plane hits
    expect(w.raycast({ x: 2, y: -0.5, z: 6 }, { x: 0, y: -1, z: 0 }, 5)).toBeNull(); // mesh raycast: no dist 0
    expect(w.segment({ x: 20, y: 1, z: 6 }, { x: 0, y: -2, z: 0 })).toBeNull(); // off the mesh
  });

  it('returns the FIRST face in list order, not the nearest (ground before the bridge deck)', () => {
    const h = world().segment({ x: 4, y: 6, z: 9 }, { x: 0, y: -10, z: 0 })!;
    expect(h.face).toBe(0);
    expect(h.point.y).toBe(0);
    // the deck alone when the segment ends above the ground
    expect(world().segment({ x: 4, y: 6, z: 9 }, { x: 0, y: -1.5, z: 0 })!.face).toBe(4);
  });

  it('per-slot face cache: the cached face wins, a block change forgets it, slot −1 has none', () => {
    const w = world();
    expect(w.segment({ x: 4, y: 6, z: 9 }, { x: 0, y: -1.5, z: 0 }, 7)!.face).toBe(4); // deck cached
    expect(w.segment({ x: 4, y: 6, z: 9 }, { x: 0, y: -10, z: 0 }, 7)!.face).toBe(4); // cache first
    expect(w.segment({ x: 4, y: 6, z: 9 }, { x: 0, y: -10, z: 0 }, 8)!.face).toBe(0); // other slot
    expect(w.segment({ x: 4, y: 6, z: 9 }, { x: 0, y: -10, z: 0 }, -1)!.face).toBe(0); // no cache
    expect(w.segment({ x: 7, y: 1, z: 5 }, { x: 0, y: -2, z: 0 }, 7)!.face).toBe(2); // block B
    expect(w.segment({ x: 4, y: 6, z: 9 }, { x: 0, y: -10, z: 0 }, 7)!.face).toBe(0); // forgotten
    expect(w.grid.lastBlock[7]).toBe(0);
    w.resetFaceCache();
    expect(w.grid.lastBlock[7]).toBe(-1);
    // a miss forgets the block (0x595f32)
    w.segment({ x: 4, y: 6, z: 9 }, { x: 0, y: -1.5, z: 0 }, 9);
    expect(w.grid.lastBlock[9]).toBe(0);
    w.segment({ x: 4, y: 9, z: 9 }, { x: 0, y: -1, z: 0 }, 9);
    expect(w.grid.lastBlock[9]).toBe(-1);
    expect(w.grid.lastFace[9]).toBe(-1);
  });

  it('accepts e1 == 0 outside the triangle (edge tests compared only with e1)', () => {
    const w = world();
    // (3.5, z = 1) lies on T's v0→v1 line beyond v1: e1 = 0 → T accepted although outside it
    const h = w.segment({ x: 2.5, y: 3, z: 1 }, { x: 0, y: -2, z: 0 })!;
    expect(h.face).toBe(6);
    expect(h.origMaterial).toBe(16);
    expect(w.segment({ x: 2.5, y: 3, z: 1.2 }, { x: 0, y: -2, z: 0 })).toBeNull();
  });

  it('never hits a zero-normal face', () => {
    expect(world().segment({ x: 0.2, y: 1, z: 0.2 }, { x: 0, y: -0.5, z: 0 })).toBeNull();
  });

  it('walks blocks along a tilted segment (Bresenham path, clip, unclipped end)', () => {
    const w = world();
    // crosses x = 5 before reaching the ground: A's faces stop at x = 5, B's ground is hit
    const h = w.segment({ x: 4.8, y: 1, z: 5 }, { x: 0.6, y: -2, z: 0 }, 3)!;
    expect(0.6 * 0.6).toBeGreaterThan(BRESENHAM_LIMIT2);
    expect(h.face).toBeGreaterThanOrEqual(2);
    expect(h.face).toBeLessThanOrEqual(3);
    expect(h.t).toBe(0.5);
    expect(h.point.x).toBeCloseTo(5.1, 12);
    expect(w.grid.lastBlock[3]).toBe(1);
    // the same segment reversed in x starts in B and ends over A
    const g = w.segment({ x: 5.2, y: 1, z: 5 }, { x: -0.6, y: -2, z: 0 })!;
    expect(g.point.x).toBeCloseTo(4.9, 12);
    expect(g.face).toBeLessThanOrEqual(1);
  });

  it('uses the exe constant f32(0.05f·0.05f) for the vertical / Bresenham split', () => {
    expect(BRESENHAM_LIMIT2).toBe(Math.fround(0.0025000000745058065));
    expect(BRESENHAM_LIMIT2).toBeGreaterThan(0.05 * 0.05);
  });

  it('rejects non-finite input and supports a fresh grid per world', () => {
    const w = world();
    expect(w.segment({ x: NaN, y: 1, z: 5 }, { x: 0, y: -2, z: 0 })).toBeNull();
    expect(w.segment({ x: 2, y: 1, z: 5 }, { x: 0, y: -Infinity, z: 0 })).toBeNull();
    expect(new GcmGrid(parseRcol(rcol)).segment(2, 1, 5, 0, -2, 0, 0)).toBe(true);
  });

  it('`out` is filled in place (every field, normal / point objects kept) and returned; without it a fresh hit', () => {
    const w = world();
    const out = makeRayHit();
    const n0 = out.normal, p0 = out.point;
    const fresh = w.segment({ x: 2, y: 1, z: 6 }, { x: 0, y: -2, z: 0 }, 0)!;
    const h = w.segment({ x: 2, y: 1, z: 6 }, { x: 0, y: -2, z: 0 }, 0, out)!;
    expect(h).toBe(out);
    expect(h.normal).toBe(n0);
    expect(h.point).toBe(p0);
    expect({ ...h, normal: { ...h.normal }, point: { ...h.point } }).toEqual(fresh);
    expect(w.raycast({ x: 2, y: 1, z: 6 }, { x: 0, y: -1, z: 0 }, 2, out)).toBe(out);
    expect(w.segment({ x: 2, y: 1, z: 6 }, { x: 0, y: -2, z: 0 }, 0)).not.toBe(out);
    // the procedural adapter: the same, and a world whose raycast ignores `out` still answers through the return value
    const pw = buildStage('testpad', 1).world;
    const pf = pw.segment({ x: 0, y: 5, z: 10 }, { x: 0, y: -10, z: 0 })!;
    const ph = pw.segment({ x: 0, y: 5, z: 10 }, { x: 0, y: -10, z: 0 }, -1, out)!;
    expect(ph).toBe(out);
    expect({ ...ph, normal: { ...ph.normal }, point: { ...ph.point } }).toEqual(pf);
    const plain: Pick<WorldQuery, 'raycast'> = { raycast: (o, d, m) => pw.raycast(o, d, m) };
    expect(segmentViaRaycast(plain, { x: 0, y: 5, z: 10 }, { x: 0, y: -10, z: 0 }, -1, out)).toEqual(pf);
  });
});

describe('point queries (mesh world)', () => {
  it('heightAt / normalAt / materialAt / surfaceAt follow the yHint level rule', () => {
    const w = world();
    expect(w.heightAt(4, 5)).toBe(5); // highest
    expect(w.materialAt(4, 5)).toBe(MATERIAL.grass);
    expect(w.surfaceAt(4, 5)).toBe('grass');
    expect(w.heightAt(4, 5, 0.4)).toBe(0); // highest at or below yHint + 1
    expect(w.surfaceAt(4, 5, 0.4)).toBe('tarmac');
    expect(w.heightAt(4, 5, 4.2)).toBe(5);
    expect(w.heightAt(4, 5, -3)).toBe(0); // nothing below → lowest above
    expect(w.normalAt(4, 5)).toEqual({ x: 0, y: 1, z: 0 });
    expect(w.heightAt(7, 5)).toBe(0);
    expect(w.surfaceAt(7, 5)).toBe('gravel');
    expect(w.origMaterialAt(7, 5)).toBe(2);
  });

  it('falls back to the procedural world off the mesh (never NaN)', () => {
    const w = world();
    expect(w.heightAt(-5, 5)).toBe(FALLBACK_Y);
    expect(w.heightAt(5, 50)).toBe(FALLBACK_Y);
    expect(w.materialAt(-5, 5)).toBe(MATERIAL.grass);
    expect(w.onMesh(-5, 5)).toBe(false);
    expect(w.onMesh(2, 5)).toBe(true);
  });
});

describe('obstacles', () => {
  it('obstaclesNear returns the hard proxies only; dynamic parts via partsNear', () => {
    const w = world();
    const near = w.obstaclesNear({ x: 7, y: 0, z: 4 }, 3);
    expect(near.length).toBe(1);
    expect(near[0].kind).toBe('tree');
    expect(near[0].radius).toBeCloseTo(0.5, 6);
    const parts = w.partsNear({ x: 7, y: 0, z: 4 }, 3);
    expect(parts.length).toBe(1);
    expect(parts[0].kind).toBe('cone');
    expect(Array.from((parts[0] as unknown as { hull: Float32Array }).hull)).toEqual([7, 0.5, 4]);
    expect(w.obstaclesNear({ x: 50, y: 0, z: 50 }, 3)).toEqual([]);
  });
});

describe('obstacles: soft bushes, robustness', () => {
  it('softNear returns the flag-only bushes; stray coordinates never break the index', () => {
    const w = world();
    const soft = w.softNear({ x: 7, y: 0, z: 6 }, 1);
    expect(soft.length).toBe(1);
    expect(soft[0].kind).toBe('bush');
    expect(w.obstaclesNear({ x: 7, y: 0, z: 6 }, 0.5)).toEqual([]);
    expect(w.obstaclesNear({ x: NaN, y: 0, z: 0 }, 3)).toEqual([]);
    expect(w.obstaclesNear({ x: 1e9, y: 0, z: -1e9 }, 3)).toEqual([]);
    // a record at ±3e7 m (editor debris) next to a normal one: indexed without a huge allocation
    const far = buildRcol({
      faces: faces.slice(0, 2), bbox: [0, 0, 10, 10], dim: 1, cellBlocks: () => [0],
      blocks: [{ min: [0, 0, 0], max: [5, 0, 10], dim: 1, cells: [[0, 1]] }],
      obst: [
        [-3.3e7, -2.9e7, -2.7e7, 0.3, 3, 7, OBST_HARD, -1, 0, 0, 1, 0, 0, 0, 0, 0],
        [2, 0, 2, 0.5, 3, 0, OBST_HARD, -1, 0, 1, 0, 0, 0, 0, 0, 0],
      ],
    });
    const wf = new OrigWorld(parseRcol(far), fallback, { kinds: ['tree'] });
    expect(wf.obstaclesNear({ x: 2, y: 0, z: 2.5 }, 1).length).toBe(1);
  });
});

describe('mirrorZ (stage-frame workaround)', () => {
  it('answers every query in the z-mirrored frame with the same faces, t, depth and cos', () => {
    const w = world();
    const m = new OrigWorld(parseRcol(rcol), fallback, { kinds: ['tree', 'pine', 'bush', 'rock', 'boulder', 'post', 'sign', 'barrier', 'fence', 'tyreStack', 'cone'], mirrorZ: true });
    expect(m.mirrorZ).toBe(true);
    // tilted segment crossing blocks, with a z component
    const a = w.segment({ x: 4.8, y: 1, z: 5 }, { x: 0.6, y: -2, z: 0.4 }, 3)!;
    const b = m.segment({ x: 4.8, y: 1, z: -5 }, { x: 0.6, y: -2, z: -0.4 }, 3)!;
    expect(b.face).toBe(a.face);
    expect(b.t).toBe(a.t);
    expect(b.depth).toBe(a.depth);
    expect(b.cos).toBe(a.cos);
    expect(b.point).toEqual({ x: a.point.x, y: a.point.y, z: -a.point.z });
    expect(b.normal).toEqual({ x: a.normal.x, y: a.normal.y, z: -a.normal.z });
    expect(m.heightAt(4, -5, 0.4)).toBe(w.heightAt(4, 5, 0.4));
    expect(m.surfaceAt(7, -5)).toBe('gravel');
    expect(m.heightAt(5, 50)).toBe(FALLBACK_Y); // off the mesh: the fallback gets the caller's own coordinates
    const near = m.obstaclesNear({ x: 7, y: 0, z: -2 }, 1);
    expect(near.length).toBe(1);
    expect(near[0].pos.z).toBe(-2);
    const part = m.partsNear({ x: 7, y: 0, z: -4 }, 1)[0] as unknown as { hull: Float32Array };
    expect(Array.from(part.hull)).toEqual([7, 0.5, -4]);
    // the original world's record is untouched (the mirrored hull is a copy)
    expect(Array.from((w.partsNear({ x: 7, y: 0, z: 4 }, 1)[0] as unknown as { hull: Float32Array }).hull)).toEqual([7, 0.5, 4]);
  });
});

describe('stageFrameFit', () => {
  const fakeStage = (zSign: number) =>
    ({
      closed: true, startS: 0, finishS: 0,
      road: Array.from({ length: 40 }, (_, i) => ({ s: i, pos: { x: 6 + 0.1 * i, y: 0, z: zSign * (1 + 0.2 * i) } })),
    }) as unknown as Stage;
  it('detects the contract frame (sim = three with z negated) and a z-mirrored stage', () => {
    const d = parseRcol(rcol);
    const ok = stageFrameFit(fakeStage(-1), d);
    expect(ok.sim).toBe(1);
    expect(ok.mirrorZ).toBe(false);
    const mir = stageFrameFit(fakeStage(1), d);
    expect(mir.mirrored).toBe(1);
    expect(mir.sim).toBe(0);
    expect(mir.mirrorZ).toBe(true);
  });
});
