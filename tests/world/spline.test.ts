/**
 * tests/world/spline.test.ts — centre line, road ribbon and projection: round trips, closed-loop wrap,
 * continuity, curvature / clearance limits, lateral sign, road surface on top of the terrain.
 *
 * The fixed limits (curvature ≤ 1/8, grade ≤ 0.35, legs ≥ max width + 6 m apart, every point within
 * hw + 4 m of the road owned by its own section) are the PROCEDURAL layouts' design limits and stay
 * exactly as they are for those stages. The ported originals (src/world/ports) follow the real roads:
 * their bounds are the original centre spline's own numbers (tests/world/portedBounds.ts, straight from
 * the archive control points) — the port may not be sharper, steeper or closer than the original.
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import type { BuiltStage, Heightfield, Stage } from '../../src/core/types';
import { PORTED_DATA } from '../../src/world/ports';
import { buildStage, listStages } from '../../src/world/stages';
import { origCentreFacts } from './portedBounds';

/** True for a PORTED original stage (src/world/ports). */
const isPorted = (id: string): boolean => id in PORTED_DATA;

/** Step of a ported stage's dense centre line (m): portedRoadSection resamples the original at 1 m. */
const PORT_DS = 1;
/** Along-road tolerance (m) within which a probe counts as owned by its own section. */
const OWN_DS = 0.3;

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

/** Brute-force closest point (horizontal) of the centre line: 0.5 m chords of pointAt over the whole road. */
function bruteNearest(stage: Stage, x: number, z: number): { s: number; d: number } {
  const L = stage.length;
  const n = Math.ceil(L / 0.5);
  let best = Infinity;
  let bs = 0;
  let a = stage.pointAt(0);
  for (let k = 1; k <= n; k++) {
    const sb = Math.min(L, k * 0.5);
    const b = stage.pointAt(sb);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
    const d2 = (a.x + dx * t - x) ** 2 + (a.z + dz * t - z) ** 2;
    if (d2 < best) {
      best = d2;
      bs = (k - 1 + t) * 0.5;
    }
    a = b;
  }
  return { s: bs, d: Math.sqrt(best) };
}

describe.each(listStages().map((s) => [s.id]))('spline %s', (id) => {
  it('project() round-trips points beside the road (with and without hint)', () => {
    const { stage } = get(id);
    const ported = isPorted(id);
    const rng = new Rng(21);
    for (let i = 0; i < 400; i++) {
      const s = rng.next() * stage.length;
      const p = stage.pointAt(s);
      const t = stage.tangentAt(s);
      const l = Math.hypot(t.x, t.z);
      const hw = stage.roadAt(s).width / 2;
      const lat = rng.range(-(hw + 4), hw + 4);
      const q = { x: p.x + (-t.z / l) * lat, y: p.y + 0.5, z: p.z + (t.x / l) * lat };
      const hinted = stage.project(q, s + rng.range(-20, 20));
      const global = stage.project(q);
      if (!ported) {
        for (const pr of [hinted, global]) {
          let ds = Math.abs(pr.s - s);
          if (stage.closed) ds = Math.min(ds, stage.length - ds);
          expect(ds).toBeLessThan(0.6);
          expect(Math.abs(pr.lateral - lat)).toBeLessThan(0.08);
          expect(pr.heightOffset).toBeCloseTo(0.5, 1);
        }
        continue;
      }
      // Ported: the original's hairpins are tighter than hw + 4 m on wide roads, so a probe that far
      // inside the bend is past its centre of curvature and genuinely closer to ANOTHER part of the road.
      // Whether the probe is owned by its own section comes from the geometry (brute force over the
      // whole centre line); owned probes must round-trip exactly as above, the rest must find the true
      // closest point (global) / a point at least as close as their own (hinted).
      const bf = bruteNearest(stage, q.x, q.z);
      let dsb = Math.abs(bf.s - s);
      if (stage.closed) dsb = Math.min(dsb, stage.length - dsb);
      const isOwned = dsb < OWN_DS && Math.abs(bf.d - Math.abs(lat)) < 0.05;
      const orig = origCentreFacts(id);
      const gradeMax = orig.gradeMax;
      if (!isOwned && dsb < 60) {
        // Not owned, and no separate section (≥ 60 m along the road: a stacked leg, corsica 3's overpass)
        // is the nearer one: only the tightness of the original's own bend may explain that. Beside a
        // bend of curvature k, the nearest point of the PORT_DS centre-line polyline to a probe at offset
        // |lat| slides along the road by up to |lat|·k·PORT_DS/2 (each vertex turns by k·PORT_DS), and
        // with |lat|·k ≥ 1 the probe is past the centre of curvature (a genuinely other point is nearer)
        // — both need |lat|·k·PORT_DS/2 ≥ OWN_DS, with k the ARCHIVE spline's curvature over that arc.
        expect(Math.abs(lat) * orig.kMaxNear(s, dsb + 2) * PORT_DS / 2).toBeGreaterThanOrEqual(OWN_DS);
      }
      for (const pr of [hinted, global]) {
        // heightOffset is measured against the centre point the projection reports
        expect(Math.abs(pr.heightOffset - (q.y - pr.point.y))).toBeLessThan(1e-9);
        const dq = Math.hypot(pr.point.x - q.x, pr.point.z - q.z);
        if (isOwned) {
          let ds = Math.abs(pr.s - s);
          if (stage.closed) ds = Math.min(ds, stage.length - ds);
          expect(ds).toBeLessThan(0.6);
          expect(Math.abs(pr.lateral - lat)).toBeLessThan(0.08);
          // the probe sits 0.5 m above its own centre point; a sub-0.6 m slip in s moves the reported
          // centre point along the original's real grade
          expect(Math.abs(pr.heightOffset - 0.5)).toBeLessThan(0.05 + gradeMax * ds);
        } else if (pr === global) {
          expect(Math.abs(dq - bf.d)).toBeLessThan(0.02);
        } else {
          expect(dq).toBeLessThan(Math.abs(lat) + 0.02);
        }
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
    // Ported stages: s is the original's 3-D arc length (its race distances are metres along the
    // spline including the climb), so the step is 3-D; grade and curvature may reach — never exceed —
    // the original centre spline's own peaks (snow-climb ramps, 4 m hairpins, kenya 3's junction kinks).
    const orig = isPorted(id) ? origCentreFacts(id) : null;
    let prev = stage.pointAt(0);
    let prevT = stage.tangentAt(0);
    let maxK = 0;
    for (let s = step; s <= stage.length; s += step) {
      const p = stage.pointAt(s);
      const t = stage.tangentAt(s);
      const d = Math.hypot(p.x - prev.x, p.z - prev.z);
      const dStep = orig ? Math.hypot(d, p.y - prev.y) : d;
      expect(dStep).toBeLessThan(step * 1.02);
      expect(dStep).toBeGreaterThan(step * 0.95);
      if (orig) expect(Math.abs(p.y - prev.y) / d).toBeLessThan(orig.gradeMax * 1.02 + 0.005);
      else expect(Math.abs(p.y - prev.y)).toBeLessThan(0.35 * step);
      const dot = (t.x * prevT.x + t.z * prevT.z) / (Math.hypot(t.x, t.z) * Math.hypot(prevT.x, prevT.z));
      maxK = Math.max(maxK, Math.acos(Math.min(1, dot)) / step);
      prev = p;
      prevT = t;
    }
    if (orig) expect(maxK).toBeLessThan(orig.kMax * 1.02 + 1e-3);
    else expect(maxK).toBeLessThan(1 / 8); // tightest hairpins are ≈ 10-14 m
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
    const pts: { s: number; x: number; y: number; z: number; hw: number }[] = [];
    for (let s = 0; s < stage.length; s += 4) {
      const p = stage.pointAt(s);
      pts.push({ s, x: p.x, y: p.y, z: p.z, hw: stage.roadAt(s).width / 2 });
    }
    const w = Math.max(...stage.road.map((r) => r.width));
    const orig = isPorted(id) ? origCentreFacts(id) : null;
    let sepMin = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        let gap = pts[j].s - pts[i].s;
        if (stage.closed) gap = Math.min(gap, stage.length - gap);
        if (gap < 60) continue;
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
        if (!orig) {
          expect(d).toBeGreaterThan(w + 6);
          continue;
        }
        sepMin = Math.min(sepMin, d);
        // ported: the real hairpin legs stack closer than the procedural "max width + 6 m"; their
        // ribbons still never overlap — except at the original's grade-separated crossings (overpass)
        if (d <= pts[i].hw + pts[j].hw) {
          const dy = Math.abs(pts[i].y - pts[j].y);
          expect(dy).toBeGreaterThan(4);
          const lo = pts[i].y < pts[j].y ? pts[i].s : pts[j].s;
          expect(orig.overpasses.some((o) => Math.abs(o.sLow - lo) < 30 && o.dy > dy - 1)).toBe(true);
        }
      }
    }
    // and no section comes closer to another than on the original spline
    if (orig) expect(sepMin).toBeGreaterThan(orig.sepMin60 - 0.5);
  });

  it('road samples are 1-4 m apart, well formed, and the ribbon lies on top of the terrain', () => {
    const { stage, world } = get(id);
    const road = stage.road;
    const orig = isPorted(id) ? origCentreFacts(id) : null;
    for (let i = 1; i < road.length; i++) {
      const d = road[i].s - road[i - 1].s;
      expect(d).toBeGreaterThan(0.5);
      expect(d).toBeLessThan(4.01);
      // the ribbon never folds: both edges advance with the centre (consecutive cross-sections don't
      // cross). Ported: except at a kink of the original centre spline itself that is tighter than a
      // 5 m road can follow with normal cross-sections (kenya 3's junction corners, R ≈ 1.8 m)
      const a = road[i - 1], b = road[i];
      const tx = b.pos.x - a.pos.x, tz = b.pos.z - a.pos.z;
      for (const [ea, eb] of [[a.left, b.left], [a.right, b.right]]) {
        const adv = (eb.x - ea.x) * tx + (eb.z - ea.z) * tz;
        if (adv > 0) continue;
        expect(orig).not.toBeNull();
        expect(a.width / 2).toBeGreaterThan(0.8 / orig!.kMaxNear(a.s, 4));
        expect(a.width).toBeLessThan(5.001);
      }
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
          const wh = world.heightAt(x, -z);
          if (orig && Math.abs(wh - y) >= 0.05) {
            // ported: the original has a grade-separated crossing (corsica 3: an overpass, 8 m between
            // the decks). The ground is single-valued (WorldQuery contract: heightAt has no height
            // reference), so under the upper deck it consistently IS the upper deck — the lower ribbon
            // there is not reachable through the WorldQuery until the contract grows a level reference.
            const op = orig.overpasses.filter((o) => Math.abs(o.sLow - r.s) < 30);
            expect(op.length).toBeGreaterThan(0);
            expect(wh - y).toBeGreaterThan(Math.min(...op.map((o) => o.dy)) - 1);
            const hit = world.raycast({ x, y: wh + 1, z: -z }, { x: 0, y: -1, z: 0 }, 3);
            expect(Math.abs(hit!.point.y - wh)).toBeLessThan(1e-3);
            continue;
          }
          expect(Math.abs(wh - y)).toBeLessThan(0.05);
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
