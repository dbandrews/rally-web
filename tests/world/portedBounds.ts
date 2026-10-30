/**
 * tests/world/portedBounds.ts — per-stage geometric facts of the ORIGINAL road, computed straight from
 * the archive control points (src/world/ports/*, PORTED_DATA) for the shared per-stage suites.
 *
 * The shared suites' fixed bounds (curvature ≤ 1/8, grade ≤ 0.35, legs ≥ max width + 6 m apart, …) are
 * design limits of the PROCEDURAL layouts. The ported stages follow the original's real roads, which
 * legitimately go beyond them (4 m hairpins, 47 % snow-climb ramps, hairpin legs stacked tighter, an
 * overpass). Their bounds are therefore the original's own numbers: the port may not be sharper,
 * steeper or closer than the archive's centre spline says.
 *
 * Independent of the runtime evaluation (src/world/portSpline.ts, de Boor): the analytic uniform cubic
 * B-spline basis with its exact first / second derivatives, over the archive convention — open splines
 * on the full uniform domain t ∈ [3, numCVs], lap circuits periodic over the numCVs - 1 distinct CVs
 * (the last CV duplicates the first), s = 0 at t = 3, s = 3-D arc length. Positions, tangents and turn
 * signs are THREE space = (x, y, −z) of the archive (sim-frame) CVs, like the stages.
 */
import { PORTED_DATA } from '../../src/world/ports';

export interface OrigSplineFacts {
  /** 3-D arc length of the original centre spline (m). */
  readonly length: number;
  /** Peak horizontal curvature (1/m), analytic. */
  readonly kMax: number;
  /** Peak |dy / dhorizontal|, analytic. */
  readonly gradeMax: number;
  /** Smallest horizontal distance between points ≥ 60 m apart along the road (4 m sampling). */
  readonly sepMin60: number;
  /**
   * Grade-separated crossings: lower-leg / upper-leg s of far-apart sections (≥ 60 m along the road)
   * that pass within 12 m horizontally of each other at least 4 m apart vertically (an overpass).
   */
  readonly overpasses: readonly { sLow: number; sHigh: number; dy: number }[];
  /** Peak analytic horizontal curvature (1/m) of the original within ±r m (arc length) of s. */
  kMaxNear(s: number, r: number): number;
  /**
   * Peak analytic horizontal curvature (1/m) of the original within ±r m of s, counting only bends that
   * turn toward `side` (+1 = right of travel, -1 = left; THREE space, the stages' lateral sign): the
   * curvature that puts a probe at that side's lateral offset near or past its centre of curvature.
   */
  kInsideNear(s: number, r: number, side: number): number;
  /** Unit horizontal tangent (THREE x, z) of the original at 3-D arc length s (wraps on lap circuits). */
  tangentAt(s: number): { x: number; z: number };
}

const PER_SEG = 64;
const cache = new Map<string, OrigSplineFacts>();

/** Facts of a ported stage's original centre spline (cached per stage id). */
export function origCentreFacts(id: string): OrigSplineFacts {
  const hit = cache.get(id);
  if (hit) return hit;
  const d = PORTED_DATA[id];
  const cv = d.center;
  const ncv = cv.length / 3;
  const m = d.closed ? ncv - 1 : ncv;
  const segs = d.closed ? m : ncv - 3;
  // archive CVs are original = sim frame; THREE = (x, y, −z) (src/world/portSpline.ts origToThree)
  const P = (k: number, c: number): number => (c === 2 ? -1 : 1) * cv[(d.closed ? ((k % m) + m) % m : k) * 3 + c];
  const N = segs * PER_SEG;
  const X = new Float64Array(N + 1);
  const Y = new Float64Array(N + 1);
  const Z = new Float64Array(N + 1);
  const K = new Float64Array(N + 1);
  /** Signed horizontal curvature, + = right turn (THREE space: cross(t, dt) in x-z > 0). */
  const KS = new Float64Array(N + 1);
  const TX = new Float64Array(N + 1);
  const TZ = new Float64Array(N + 1);
  let kMax = 0;
  let gradeMax = 0;
  for (let q = 0; q <= N; q++) {
    let seg = Math.floor(q / PER_SEG);
    let u = (q - seg * PER_SEG) / PER_SEG;
    if (seg >= segs) {
      seg = segs - 1;
      u = 1;
    }
    const i = seg + 3; // segment i uses CVs i-3 .. i
    const u2 = u * u;
    const u3 = u2 * u;
    const b = [(1 - u) ** 3 / 6, (3 * u3 - 6 * u2 + 4) / 6, (-3 * u3 + 3 * u2 + 3 * u + 1) / 6, u3 / 6];
    const db = [-((1 - u) ** 2) / 2, (3 * u2 - 4 * u) / 2, (-3 * u2 + 2 * u + 1) / 2, u2 / 2];
    const ddb = [1 - u, 3 * u - 2, -3 * u + 1, u];
    const v = [0, 0, 0];
    const v1 = [0, 0, 0];
    const v2 = [0, 0, 0];
    for (let j = 0; j < 4; j++) {
      for (let c = 0; c < 3; c++) {
        const p = P(i - 3 + j, c);
        v[c] += b[j] * p;
        v1[c] += db[j] * p;
        v2[c] += ddb[j] * p;
      }
    }
    X[q] = v[0];
    Y[q] = v[1];
    Z[q] = v[2];
    const h2 = v1[0] * v1[0] + v1[2] * v1[2];
    if (h2 > 1e-12) {
      KS[q] = (v1[0] * v2[2] - v1[2] * v2[0]) / h2 ** 1.5;
      K[q] = Math.abs(KS[q]);
      TX[q] = v1[0] / Math.sqrt(h2);
      TZ[q] = v1[2] / Math.sqrt(h2);
      kMax = Math.max(kMax, K[q]);
      gradeMax = Math.max(gradeMax, Math.abs(v1[1]) / Math.sqrt(h2));
    }
  }
  // 3-D arc length + 4 m resampling (closed: the last point repeats the first)
  const S = new Float64Array(N + 1);
  for (let q = 1; q <= N; q++) S[q] = S[q - 1] + Math.hypot(X[q] - X[q - 1], Y[q] - Y[q - 1], Z[q] - Z[q - 1]);
  const length = S[N];
  const pts: { s: number; x: number; y: number; z: number }[] = [];
  let q = 0;
  for (let s = 0; s < length; s += 4) {
    while (q < N - 1 && S[q + 1] < s) q++;
    const f = (s - S[q]) / Math.max(1e-12, S[q + 1] - S[q]);
    pts.push({ s, x: X[q] + (X[q + 1] - X[q]) * f, y: Y[q] + (Y[q + 1] - Y[q]) * f, z: Z[q] + (Z[q + 1] - Z[q]) * f });
  }
  let sepMin60 = Infinity;
  const overpasses: { sLow: number; sHigh: number; dy: number }[] = [];
  for (let a = 0; a < pts.length; a++) {
    for (let b2 = a + 1; b2 < pts.length; b2++) {
      let gap = pts[b2].s - pts[a].s;
      if (d.closed) gap = Math.min(gap, length - gap);
      if (gap < 60) continue;
      const h = Math.hypot(pts[a].x - pts[b2].x, pts[a].z - pts[b2].z);
      sepMin60 = Math.min(sepMin60, h);
      const dy = pts[b2].y - pts[a].y;
      if (h < 12 && Math.abs(dy) >= 4) {
        const lo = dy > 0 ? pts[a] : pts[b2];
        const hi = dy > 0 ? pts[b2] : pts[a];
        overpasses.push({ sLow: lo.s, sHigh: hi.s, dy: Math.abs(dy) });
      }
    }
  }
  const kMaxNear = (s0: number, r: number): number => {
    let k = 0;
    for (let i = 0; i <= N; i++) {
      let ds = Math.abs(S[i] - s0);
      if (d.closed) ds = Math.min(ds, length - ds);
      if (ds <= r) k = Math.max(k, K[i]);
    }
    return k;
  };
  const kInsideNear = (s0: number, r: number, side: number): number => {
    let k = 0;
    for (let i = 0; i <= N; i++) {
      let ds = Math.abs(S[i] - s0);
      if (d.closed) ds = Math.min(ds, length - ds);
      if (ds <= r) k = Math.max(k, side * KS[i]);
    }
    return k;
  };
  const tangentAt = (s0: number): { x: number; z: number } => {
    const s = d.closed ? ((s0 % length) + length) % length : Math.min(length, Math.max(0, s0));
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid;
    }
    const f = (s - S[lo]) / Math.max(1e-12, S[hi] - S[lo]);
    const x = TX[lo] + (TX[hi] - TX[lo]) * f;
    const z = TZ[lo] + (TZ[hi] - TZ[lo]) * f;
    const l = Math.hypot(x, z) || 1;
    return { x: x / l, z: z / l };
  };
  const facts: OrigSplineFacts = { length, kMax, gradeMax, sepMin60, overpasses, kMaxNear, kInsideNear, tangentAt };
  cache.set(id, facts);
  return facts;
}
