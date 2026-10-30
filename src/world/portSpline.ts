/**
 * src/world/portSpline.ts — evaluation of the ORIGINAL road splines ported into
 * src/world/ports/*.ts (research reference in each module header; PROGRESS.md rules).
 *
 * The original's AiFiles/*.spl files are degree-3 uniform B-splines: control points
 * cv[i] = (x, y, z) (y = elevation) over integer knots 0 … numCVs + degree, evaluated with
 * de Boor. Point-to-point stages use the FULL uniform domain t ∈ [degree, numCVs] (numCVs -
 * degree segments). The lap circuits (rallycross, iceracing) carry one duplicated control point
 * at the end (cv[n-1] == cv[0]): they are CLOSED, periodic over the m = numCVs - 1 distinct CVs
 * (m segments, CV index mod m), t ∈ [degree, degree + m) and wrapping. s = 0 (the origin of
 * every race distance) is t = degree in both cases.
 *
 * Pinned against the archives themselves (research/tools/port_tracks.py mirrors it):
 *  - every reverse archive's centre.spl is EXACTLY the forward one's CVs reversed; only the
 *    full domain [degree, numCVs] gives both directions the same curve (equal lengths to
 *    0.1 m, coincident end points). The earlier [degree, numCVs-1] dropped the last segment
 *    (up to 42 m of road; forward/reverse lengths then differed by up to 38 m);
 *  - the circuits' periodic closure: on rallycross1f/3f (the two layouts whose closure is
 *    not on a straight) the original's roadside objects (Objects.con) follow the periodic
 *    curve, not a chord across the three wrap segments (which left a 19-24° kink);
 *  - the open stages' checkpoint banners sit within metres of their trigger distances
 *    measured as 3-D arc length from t = degree.
 */

export interface PortedPoints {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly count: number;
}

/**
 * Evaluate one B-spline point. `cycle` = number of distinct CVs of a closed (periodic) curve,
 * or 0 for an open curve. Open: t ∈ [degree, numCVs] (clamped). Closed: t wraps modulo
 * `cycle` into [degree, degree + cycle).
 */
export function evalBspline(
  cvs: readonly number[],
  degree: number,
  t: number,
  cycle: number,
  out: Float64Array,
  o: number,
): void {
  const n = (cvs.length / 3) | 0;
  let tt = t;
  let i: number;
  if (cycle) {
    tt = degree + (((t - degree) % cycle) + cycle) % cycle;
    i = Math.floor(tt);
    if (i >= degree + cycle) i = degree + cycle - 1;
  } else {
    i = Math.floor(tt);
    if (i < degree) i = degree;
    else if (i > n - 1) i = n - 1; // t = numCVs evaluates the end of the last segment
  }
  const p = degree + 1;
  const d = new Float64Array(p * 3);
  for (let j = 0; j < p; j++) {
    let k = i - degree + j;
    if (cycle) k = ((k % cycle) + cycle) % cycle;
    for (let c = 0; c < 3; c++) d[j * 3 + c] = cvs[k * 3 + c];
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const alpha = (tt - (i - degree + j)) / (degree + 1 - r);
      const a = (j - 1) * 3;
      const b = j * 3;
      for (let c = 0; c < 3; c++) d[b + c] = (1 - alpha) * d[a + c] + alpha * d[b + c];
    }
  }
  out[o] = d[degree * 3];
  out[o + 1] = d[degree * 3 + 1];
  out[o + 2] = d[degree * 3 + 2];
}

/**
 * Dense samples of a ported spline (n + 1 points over the whole domain). Open curves: t over
 * [degree, numCVs]. Closed curves: t over one period [degree, degree + m) (m = numCVs - 1
 * distinct CVs); the LAST point repeats the first (t = degree + m wraps to t = degree), so
 * `resampleXYZ` can drop it and close the loop.
 */
export function sampleBspline(
  cvs: readonly number[],
  degree: number,
  closed: boolean,
  n: number,
): PortedPoints {
  const ncv = (cvs.length / 3) | 0;
  const cyc = closed ? ncv - 1 : 0;
  const lo = degree;
  const hi = closed ? degree + cyc : ncv;
  const tmp = new Float64Array(3);
  const x = new Float64Array(n + 1);
  const y = new Float64Array(n + 1);
  const z = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    evalBspline(cvs, degree, lo + ((hi - lo) * i) / n, cyc, tmp, 0);
    x[i] = tmp[0];
    y[i] = tmp[1];
    z[i] = tmp[2];
  }
  return { x, y, z, count: n + 1 };
}

/**
 * The ported splines' points in THREE space. The archive CVs are in the original's frame, which is the
 * rally-web SIM frame (docs/ASSETS.md §3 "Frames": the gcm, the AI splines and Objects.con share it), and
 * three = (x, y, −z) of sim. Feeding the raw (x, z) into the three-space centre line instead mirrors the
 * whole stage (left and right turns swap, the original collision / track / object meshes no longer line
 * up: docs/orig/collision.md §5). In place; returns `pts`.
 */
export function origToThree(pts: PortedPoints): PortedPoints {
  for (let i = 0; i < pts.count; i++) pts.z[i] = -pts.z[i];
  return pts;
}

/**
 * Uniform arc-length resampling of a 3-D polyline (the ported s parameter: metres along the
 * ROAD INCLUDING elevation — the original's race distances are 3-D along its splines; the
 * steep hillclimbs only fit that way). Open: n points start → end inclusive. Closed: the
 * input's last point must repeat the first; it is dropped, n points cover the loop once.
 */
export function resampleXYZ(
  pts: PortedPoints,
  closed: boolean,
  ds: number,
): PortedPoints & { length: number; step: number } {
  const m = pts.count - (closed ? 1 : 0); // drop the duplicated closing point
  const cum = new Float64Array(m + 1);
  for (let i = 1; i < m; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts.x[i] - pts.x[i - 1], pts.y[i] - pts.y[i - 1], pts.z[i] - pts.z[i - 1]);
  }
  let total = cum[m - 1];
  if (closed) {
    total += Math.hypot(pts.x[0] - pts.x[m - 1], pts.y[0] - pts.y[m - 1], pts.z[0] - pts.z[m - 1]);
    cum[m] = total;
  }
  const n = closed ? Math.max(16, Math.round(total / ds)) : Math.max(2, Math.round(total / ds) + 1);
  const step = closed ? total / n : total / (n - 1);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  let k = 0;
  const at = (i: number): number => {
    const j = closed ? ((i % m) + m) % m : Math.min(m - 1, Math.max(0, i));
    return j;
  };
  for (let i = 0; i < n; i++) {
    const target = Math.min(total, i * step);
    const last = closed ? m : m - 1;
    while (k < last - 1 && cum[k + 1] < target) k++;
    const a = at(k);
    const b = at(k + 1);
    const seg = cum[k + 1] - cum[k];
    const f = seg > 1e-12 ? (target - cum[k]) / seg : 0;
    x[i] = pts.x[a] + (pts.x[b] - pts.x[a]) * f;
    y[i] = pts.y[a] + (pts.y[b] - pts.y[a]) * f;
    z[i] = pts.z[a] + (pts.z[b] - pts.z[a]) * f;
  }
  return { x, y, z, count: n, length: total, step };
}

/** Median filter (window = 2r+1 samples), edges kept as-is (open) / wrapped (closed). */
export function medianFilter(src: Float64Array, r: number, closed: boolean): Float64Array {
  const n = src.length;
  const w = 2 * r + 1;
  const buf = new Float64Array(w);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let k = -r; k <= r; k++) {
      let j = i + k;
      if (closed) j = ((j % n) + n) % n;
      else j = j < 0 ? 0 : j >= n ? n - 1 : j;
      buf[k + r] = src[j];
    }
    // insertion sort (w is small)
    for (let a = 1; a < w; a++) {
      const v = buf[a];
      let b = a - 1;
      while (b >= 0 && buf[b] > v) {
        buf[b + 1] = buf[b];
        b--;
      }
      buf[b + 1] = v;
    }
    out[i] = buf[r];
  }
  return out;
}