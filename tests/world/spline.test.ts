/**
 * tests/world/spline.test.ts — centre line, road ribbon and projection: round trips, closed-loop wrap,
 * continuity, curvature / clearance limits, lateral sign, road surface on top of the terrain.
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import type { BuiltStage, Heightfield } from '../../src/core/types';
import { buildStage, listStages } from '../../src/world/stages';

const cache = new Map<string, BuiltStage>();
const get = (id: string): BuiltStage => {
  let b = cache.get(id);
  if (!b) cache.set(id, (b = buildStage(id, 5)));
  return b;
};

/** Height of the heightfield triangle mesh alone at three-space (x, z) (same split as src/world/terrain.ts). */
function terrainHeight(hf: Heightfield, x: number, z: number): number {
  const gx = Math.min(hf.nx - 1, Math.max(0, (x - hf.originX) / hf.cellSize));
  const gz = Math.min(hf.nz - 1, Math.max(0, (z - hf.originZ) / hf.cellSize));
  const ix = Math.min(hf.nx - 2, Math.floor(gx));
  const iz = Math.min(hf.nz - 2, Math.floor(gz));
  const u = gx - ix, v = gz - iz;
  const i = iz * hf.nx + ix;
  const h00 = hf.heights[i], h10 = hf.heights[i + 1], h01 = hf.heights[i + hf.nx], h11 = hf.heights[i + hf.nx + 1];
  return u >= v ? h00 + (h10 - h00) * u + (h11 - h10) * v : h00 + (h11 - h01) * u + (h01 - h00) * v;
}

describe.each(listStages().map((s) => [s.id]))('spline %s', (id) => {
  it('project() round-trips points beside the road (with and without hint)', () => {
    const { stage } = get(id);
    const rng = new Rng(21);
    for (let i = 0; i < 400; i++) {
      const s = rng.next() * stage.length;
      const p = stage.pointAt(s);
      const t = stage.tangentAt(s);
      const l = Math.hypot(t.x, t.z);
      const hw = stage.roadAt(s).width / 2;
      const lat = rng.range(-(hw + 4), hw + 4);
      const q = { x: p.x + (-t.z / l) * lat, y: p.y + 0.5, z: p.z + (t.x / l) * lat };
      for (const pr of [stage.project(q, s + rng.range(-20, 20)), stage.project(q)]) {
        let ds = Math.abs(pr.s - s);
        if (stage.closed) ds = Math.min(ds, stage.length - ds);
        expect(ds).toBeLessThan(0.6);
        expect(Math.abs(pr.lateral - lat)).toBeLessThan(0.08);
        expect(pr.heightOffset).toBeCloseTo(0.5, 1);
      }
    }
  });

  it('follows a moving car with hinted projection (no jumps between sections)', () => {
    const { stage } = get(id);
    let hint = stage.startS;
    for (let s = stage.startS; s < (stage.closed ? stage.length * 2 : stage.finishS); s += 0.8) {
      const p = stage.pointAt(s);
      const pr = stage.project(p, hint);
      const want = stage.closed ? s % stage.length : s;
      let ds = Math.abs(pr.s - want);
      if (stage.closed) ds = Math.min(ds, stage.length - ds);
      expect(ds).toBeLessThan(0.6);
      hint = pr.s;
    }
  });

  it('is continuous, with bounded curvature and a stable tangent', () => {
    const { stage } = get(id);
    const step = 1;
    let prev = stage.pointAt(0);
    let prevT = stage.tangentAt(0);
    let maxK = 0;
    for (let s = step; s <= stage.length; s += step) {
      const p = stage.pointAt(s);
      const t = stage.tangentAt(s);
      const d = Math.hypot(p.x - prev.x, p.z - prev.z);
      expect(d).toBeLessThan(step * 1.02);
      expect(d).toBeGreaterThan(step * 0.95);
      expect(Math.abs(p.y - prev.y)).toBeLessThan(0.35 * step);
      const dot = (t.x * prevT.x + t.z * prevT.z) / (Math.hypot(t.x, t.z) * Math.hypot(prevT.x, prevT.z));
      maxK = Math.max(maxK, Math.acos(Math.min(1, dot)) / step);
      prev = p;
      prevT = t;
    }
    expect(maxK).toBeLessThan(1 / 8); // tightest hairpins are ≈ 10-14 m
    if (stage.closed) {
      const a = stage.pointAt(0), b = stage.pointAt(stage.length);
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(1e-6);
      const ta = stage.tangentAt(0.5), tb = stage.tangentAt(stage.length - 0.5);
      expect(ta.x * tb.x + ta.y * tb.y + ta.z * tb.z).toBeGreaterThan(0.99);
      expect(stage.road[0].pos).toEqual(stage.road[stage.road.length - 1].pos);
    }
  });

  it('keeps separate sections of the road apart', () => {
    const { stage } = get(id);
    const pts: { s: number; x: number; z: number }[] = [];
    for (let s = 0; s < stage.length; s += 4) {
      const p = stage.pointAt(s);
      pts.push({ s, x: p.x, z: p.z });
    }
    const w = Math.max(...stage.road.map((r) => r.width));
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        let gap = pts[j].s - pts[i].s;
        if (stage.closed) gap = Math.min(gap, stage.length - gap);
        if (gap < 60) continue;
        expect(Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z)).toBeGreaterThan(w + 6);
      }
    }
  });

  it('road samples are 1-4 m apart, well formed, and the ribbon lies on top of the terrain', () => {
    const { stage, world } = get(id);
    const road = stage.road;
    for (let i = 1; i < road.length; i++) {
      const d = road[i].s - road[i - 1].s;
      expect(d).toBeGreaterThan(0.5);
      expect(d).toBeLessThan(4.01);
    }
    for (const r of road) {
      const hw = r.width / 2;
      expect(Math.hypot(r.left.x - r.pos.x, r.left.z - r.pos.z)).toBeCloseTo(hw, 3);
      expect(Math.hypot(r.right.x - r.pos.x, r.right.z - r.pos.z)).toBeCloseTo(hw, 3);
      // the right edge is to the right of travel
      const t = stage.tangentAt(r.s);
      expect((r.right.x - r.pos.x) * -t.z + (r.right.z - r.pos.z) * t.x).toBeGreaterThan(0);
      // bank sign: + = right edge lower (crown removed)
      if (Math.abs(r.bank) > 0.01) expect(Math.sign(r.left.y - r.right.y)).toBe(Math.sign(r.bank));
      // terrain stays under the ribbon at the centre and just inside the edges
      for (const f of [0, 0.45, 0.95]) {
        for (const e of [r.left, r.right]) {
          const x = r.pos.x + (e.x - r.pos.x) * f;
          const z = r.pos.z + (e.z - r.pos.z) * f;
          const y = r.pos.y + (e.y - r.pos.y) * f;
          expect(terrainHeight(stage.heightfield, x, z)).toBeLessThan(y + 1e-3);
          expect(Math.abs(world.heightAt(x, -z) - y)).toBeLessThan(0.05);
        }
      }
    }
  });

  it('roadAt interpolates between samples and wraps / clamps s', () => {
    const { stage } = get(id);
    const r = stage.roadAt(stage.length * 0.37);
    expect(r.width).toBeGreaterThan(5);
    const p = stage.pointAt(stage.length * 0.37);
    expect(Math.hypot(r.pos.x - p.x, r.pos.z - p.z)).toBeLessThan(0.05);
    const a = stage.roadAt(-5);
    const b = stage.roadAt(stage.length + 5);
    if (stage.closed) {
      expect(a.pos.x).toBeCloseTo(stage.roadAt(stage.length - 5).pos.x, 3);
      expect(b.pos.x).toBeCloseTo(stage.roadAt(5).pos.x, 3);
    } else {
      expect(a.pos).toEqual(stage.roadAt(0).pos);
      expect(b.pos).toEqual(stage.roadAt(stage.length).pos);
    }
  });
});
