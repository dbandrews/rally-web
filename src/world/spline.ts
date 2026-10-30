/**
 * src/world/spline.ts — horizontal road geometry: centripetal Catmull-Rom splines, arc-length resampling,
 * and the "turtle" path builder (straights + constant-radius arcs) used to generate control points.
 *
 * Everything here is 2-D in THREE space (x, z). Heading convention: direction = (sin ψ, -cos ψ), so ψ = 0
 * travels toward -Z and increasing ψ turns RIGHT (toward +X when facing -Z). Signed curvature κ > 0 = right.
 */

export interface P2 {
  x: number;
  z: number;
}

/**
 * Centripetal (α = 0.5) Catmull-Rom spline through `pts`, returned as a fine polyline (step ≤ maxStep m).
 * Open curves use reflected phantom end points; closed curves wrap (do not repeat the first point).
 */
export function catmullRom(pts: readonly P2[], closed: boolean, maxStep = 0.25): { x: number[]; z: number[] } {
  const n = pts.length;
  if (n < 2) throw new Error('catmullRom: need >= 2 points');
  const get = (i: number): P2 => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return { x: 2 * pts[0].x - pts[1].x, z: 2 * pts[0].z - pts[1].z };
    if (i >= n) return { x: 2 * pts[n - 1].x - pts[n - 2].x, z: 2 * pts[n - 1].z - pts[n - 2].z };
    return pts[i];
  };
  const xs: number[] = [];
  const zs: number[] = [];
  const segs = closed ? n : n - 1;
  const knot = (a: P2, b: P2): number => Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)));
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const chord = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const m = Math.max(4, Math.ceil(chord / maxStep));
    const j0 = i === 0 ? 0 : 1;
    for (let j = j0; j <= m; j++) {
      if (closed && i === segs - 1 && j === m) break; // the loop closes on the first point
      const t = t1 + ((t2 - t1) * j) / m;
      const a1x = ((t1 - t) / (t1 - t0)) * p0.x + ((t - t0) / (t1 - t0)) * p1.x;
      const a1z = ((t1 - t) / (t1 - t0)) * p0.z + ((t - t0) / (t1 - t0)) * p1.z;
      const a2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x;
      const a2z = ((t2 - t) / (t2 - t1)) * p1.z + ((t - t1) / (t2 - t1)) * p2.z;
      const a3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x;
      const a3z = ((t3 - t) / (t3 - t2)) * p2.z + ((t - t2) / (t3 - t2)) * p3.z;
      const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x;
      const b1z = ((t2 - t) / (t2 - t0)) * a1z + ((t - t0) / (t2 - t0)) * a2z;
      const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
      const b2z = ((t3 - t) / (t3 - t1)) * a2z + ((t - t1) / (t3 - t1)) * a3z;
      xs.push(((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x);
      zs.push(((t2 - t) / (t2 - t1)) * b1z + ((t - t1) / (t2 - t1)) * b2z);
    }
  }
  return { x: xs, z: zs };
}

/**
 * Resample a polyline at uniform arc-length spacing ≈ ds. Open: n points from start to end inclusive.
 * Closed: n points, the closing segment n-1 → 0 has the same spacing (the first point is not repeated).
 */
export function resampleUniform(
  xs: ArrayLike<number>,
  zs: ArrayLike<number>,
  closed: boolean,
  ds: number,
): { x: Float64Array; z: Float64Array; length: number; step: number } {
  const m = xs.length;
  const cum = new Float64Array(m + 1);
  for (let i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  let total = cum[m - 1];
  if (closed) {
    total += Math.hypot(xs[0] - xs[m - 1], zs[0] - zs[m - 1]);
    cum[m] = total;
  }
  const n = closed ? Math.max(8, Math.round(total / ds)) : Math.max(2, Math.round(total / ds) + 1);
  const step = closed ? total / n : total / (n - 1);
  const ox = new Float64Array(n);
  const oz = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const target = Math.min(total, i * step);
    const last = closed ? m : m - 1;
    while (k < last - 1 && cum[k + 1] < target) k++;
    const a = k;
    const b = closed ? (k + 1) % m : Math.min(m - 1, k + 1);
    const seg = cum[k + 1] - cum[k];
    const f = seg > 1e-12 ? (target - cum[k]) / seg : 0;
    ox[i] = xs[a] + (xs[b] - xs[a]) * f;
    oz[i] = zs[a] + (zs[b] - zs[a]) * f;
  }
  return { x: ox, z: oz, length: total, step };
}

// ------------------------------------------------------------------------------------------- turtle

export type PathFeature =
  | { kind: 'straight'; len: number; tag?: string }
  | { kind: 'arc'; radius: number; angle: number; dir: 1 | -1; tag?: string }; // angle rad, dir +1 = right

export interface TurtleStart {
  x: number;
  z: number;
  heading: number;
}

export interface TurtlePath {
  x: number[];
  z: number[];
  /** Signed curvature at each point (κ > 0 = right). */
  k: number[];
  /** Arc length at each point. */
  s: number[];
  /** Arc-length span of every feature (for tagging, e.g. jumps on a specific straight). */
  spans: { feature: PathFeature; s0: number; s1: number }[];
  endHeading: number;
}

/** Integrate straights and arcs (exact circular arcs) from `start`, emitting a point every ≤ step m. */
export function integrateTurtle(features: readonly PathFeature[], start: TurtleStart, step = 1): TurtlePath {
  let x = start.x;
  let z = start.z;
  let h = start.heading;
  let s = 0;
  const out: TurtlePath = { x: [x], z: [z], k: [0], s: [0], spans: [], endHeading: h };
  for (const f of features) {
    const s0 = s;
    if (f.kind === 'straight') {
      const m = Math.max(1, Math.ceil(f.len / step));
      const d = f.len / m;
      for (let i = 0; i < m; i++) {
        x += Math.sin(h) * d;
        z -= Math.cos(h) * d;
        s += d;
        out.x.push(x);
        out.z.push(z);
        out.k.push(0);
        out.s.push(s);
      }
    } else {
      const len = f.radius * f.angle;
      const m = Math.max(2, Math.ceil(len / step));
      const d = len / m;
      const kappa = f.dir / f.radius;
      for (let i = 0; i < m; i++) {
        // exact chord of a circular arc: rotate by half the angle, advance the chord, rotate again
        const dpsi = kappa * d;
        const chord = Math.abs(dpsi) > 1e-9 ? (2 * Math.sin(dpsi / 2)) / kappa : d;
        const hm = h + dpsi / 2;
        x += Math.sin(hm) * chord;
        z -= Math.cos(hm) * chord;
        h += dpsi;
        s += d;
        out.x.push(x);
        out.z.push(z);
        out.k.push(kappa);
        out.s.push(s);
      }
    }
    out.spans.push({ feature: f, s0, s1: s });
  }
  out.endHeading = h;
  return out;
}

/** Signed heading change of a feature list (rad). */
export function totalTurn(features: readonly PathFeature[]): number {
  let t = 0;
  for (const f of features) if (f.kind === 'arc') t += f.dir * f.angle;
  return t;
}

/**
 * Pick spline control points from a turtle path: dense on tight arcs (spacing ≈ 0.5·R), sparse on
 * straights (≤ maxSpacing). Endpoints are always included (open); closed paths drop the duplicate end.
 */
export function controlPointsFromPath(path: TurtlePath, closed: boolean, maxSpacing = 22, minSpacing = 3.5): P2[] {
  const pts: P2[] = [{ x: path.x[0], z: path.z[0] }];
  let acc = 0;
  const n = path.x.length;
  for (let i = 1; i < n; i++) {
    acc += path.s[i] - path.s[i - 1];
    const k = Math.max(Math.abs(path.k[i]), Math.abs(path.k[i - 1]));
    const spacing = k > 1e-6 ? Math.min(maxSpacing, Math.max(minSpacing, 0.5 / k)) : maxSpacing;
    if (acc >= spacing) {
      pts.push({ x: path.x[i], z: path.z[i] });
      acc = 0;
    }
  }
  const lastX = path.x[n - 1];
  const lastZ = path.z[n - 1];
  const tail = pts[pts.length - 1];
  if (closed) {
    // drop points that coincide with the start (the loop closes there)
    while (pts.length > 3) {
      const p = pts[pts.length - 1];
      if (Math.hypot(p.x - pts[0].x, p.z - pts[0].z) < minSpacing) pts.pop();
      else break;
    }
  } else if (Math.hypot(tail.x - lastX, tail.z - lastZ) > 0.5) {
    if (Math.hypot(tail.x - lastX, tail.z - lastZ) < minSpacing && pts.length > 2) pts.pop();
    pts.push({ x: lastX, z: lastZ });
  }
  return pts;
}

/**
 * Solve the lengths of two straights (indices ia, ib in `features`) so that the turtle path closes
 * exactly (end position = start). The total turn must already be ±2π. Returns false if no solution with
 * both lengths >= minLen exists.
 */
export function closeLoop(features: PathFeature[], ia: number, ib: number, minLen: number): boolean {
  const fa = features[ia];
  const fb = features[ib];
  if (fa.kind !== 'straight' || fb.kind !== 'straight') throw new Error('closeLoop: free features must be straights');
  fa.len = 0;
  fb.len = 0;
  const p = integrateTurtle(features, { x: 0, z: 0, heading: 0 }, 2);
  const ex = p.x[p.x.length - 1];
  const ez = p.z[p.z.length - 1];
  // headings at the free straights
  const headingAt = (idx: number): number => {
    let h = 0;
    for (let i = 0; i < idx; i++) {
      const f = features[i];
      if (f.kind === 'arc') h += f.dir * f.angle;
    }
    return h;
  };
  const ha = headingAt(ia);
  const hb = headingAt(ib);
  const ax = Math.sin(ha), az = -Math.cos(ha);
  const bx = Math.sin(hb), bz = -Math.cos(hb);
  // la·a + lb·b = -e
  const det = ax * bz - az * bx;
  if (Math.abs(det) < 1e-3) return false;
  const la = (-ex * bz + ez * bx) / det;
  const lb = (ax * -ez - az * -ex) / det;
  if (!(la >= minLen && lb >= minLen)) return false;
  fa.len = la;
  fb.len = lb;
  return true;
}
