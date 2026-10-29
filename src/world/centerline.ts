/**
 * src/world/centerline.ts — the dense (≈1 m) centre line of a stage in THREE space, with arc-length
 * lookup, signed curvature, elevation and a fast closest-point projection (segment grid + local window).
 *
 * s is the HORIZONTAL arc length (m). Open lines: points 0..n-1, s ∈ [0, length]. Closed lines: points
 * 0..n-1 plus the implicit closing segment n-1 → 0, s ∈ [0, length) (wrapped).
 */
import type { StageProjection, ThreeV3 } from '../core/types';
import { catmullRom, resampleUniform, type P2 } from './spline';

const PROJECT_WINDOW = 60;

export class Centerline {
  readonly closed: boolean;
  readonly n: number;
  readonly ds: number;
  readonly length: number;
  readonly x: Float64Array;
  readonly z: Float64Array;
  /** Elevation (three y) of the road centre; set via setElevation(). */
  readonly y: Float64Array;
  /** dy/ds. */
  readonly grade: Float64Array;
  /** Unit horizontal tangent. */
  readonly hx: Float64Array;
  readonly hz: Float64Array;
  /** Signed horizontal curvature, + = right turn (1/m). */
  readonly kappa: Float64Array;
  /** Unwrapped heading ψ (direction = (sin ψ, -cos ψ)). */
  readonly heading: Float64Array;

  // segment grid for global projection
  private gOx = 0;
  private gOz = 0;
  private gCell = 24;
  private gNx = 1;
  private gNz = 1;
  private gStart!: Int32Array;
  private gItems!: Int32Array;
  private stamp!: Int32Array;
  private stampId = 0;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;

  constructor(control: readonly P2[], closed: boolean, ds = 1) {
    const fine = catmullRom(control, closed, 0.2);
    const r = resampleUniform(fine.x, fine.z, closed, ds);
    this.closed = closed;
    this.x = r.x;
    this.z = r.z;
    this.n = r.x.length;
    this.ds = r.step;
    this.length = r.length;
    const n = this.n;
    this.y = new Float64Array(n);
    this.grade = new Float64Array(n);
    this.hx = new Float64Array(n);
    this.hz = new Float64Array(n);
    this.kappa = new Float64Array(n);
    this.heading = new Float64Array(n);
    // tangents (central differences)
    for (let i = 0; i < n; i++) {
      const a = this.idx(i - 1);
      const b = this.idx(i + 1);
      let dx = this.x[b] - this.x[a];
      let dz = this.z[b] - this.z[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      this.hx[i] = dx;
      this.hz[i] = dz;
    }
    // unwrapped heading
    let prev = 0;
    for (let i = 0; i < n; i++) {
      let h = Math.atan2(this.hx[i], -this.hz[i]);
      if (i > 0) {
        while (h - prev > Math.PI) h -= 2 * Math.PI;
        while (h - prev < -Math.PI) h += 2 * Math.PI;
      }
      this.heading[i] = h;
      prev = h;
    }
    // curvature from heading change over ±2 samples
    for (let i = 0; i < n; i++) {
      const a = this.idx(i - 2);
      const b = this.idx(i + 2);
      let dh = this.heading[b] - this.heading[a];
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      const span = this.closed ? 4 * this.ds : (b - a) * this.ds;
      this.kappa[i] = span > 0 ? dh / span : 0;
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, this.x[i]);
      maxX = Math.max(maxX, this.x[i]);
      minZ = Math.min(minZ, this.z[i]);
      maxZ = Math.max(maxZ, this.z[i]);
    }
    this.minX = minX;
    this.maxX = maxX;
    this.minZ = minZ;
    this.maxZ = maxZ;
    this.buildGrid();
  }

  /** Index helper: wraps when closed, clamps when open. */
  idx(i: number): number {
    const n = this.n;
    if (this.closed) return ((i % n) + n) % n;
    return i < 0 ? 0 : i >= n ? n - 1 : i;
  }

  get segmentCount(): number {
    return this.closed ? this.n : this.n - 1;
  }

  sAtIndex(i: number): number {
    return i * this.ds;
  }

  /** Wrap (closed) or clamp (open) s. */
  normS(s: number): number {
    const L = this.length;
    if (this.closed) return ((s % L) + L) % L;
    return s < 0 ? 0 : s > L ? L : s;
  }

  /** Fractional position: index i, next index j, fraction f. */
  locate(s: number): { i: number; j: number; f: number } {
    const ss = this.normS(s);
    const u = ss / this.ds;
    let i = Math.floor(u);
    if (this.closed) {
      if (i >= this.n) i = this.n - 1;
      return { i, j: (i + 1) % this.n, f: u - i };
    }
    if (i >= this.n - 1) i = this.n - 2;
    if (i < 0) i = 0;
    return { i, j: i + 1, f: Math.min(1, Math.max(0, u - i)) };
  }

  /** Linear interpolation of a per-point array at s. */
  sample(arr: Float64Array, s: number): number {
    const { i, j, f } = this.locate(s);
    return arr[i] + (arr[j] - arr[i]) * f;
  }

  pointAt(s: number): ThreeV3 {
    const { i, j, f } = this.locate(s);
    return {
      x: this.x[i] + (this.x[j] - this.x[i]) * f,
      y: this.y[i] + (this.y[j] - this.y[i]) * f,
      z: this.z[i] + (this.z[j] - this.z[i]) * f,
    };
  }

  /** Unit 3-D travel direction (includes the gradient). */
  tangentAt(s: number): ThreeV3 {
    const { i, j, f } = this.locate(s);
    const tx = this.hx[i] + (this.hx[j] - this.hx[i]) * f;
    const tz = this.hz[i] + (this.hz[j] - this.hz[i]) * f;
    const hl = Math.hypot(tx, tz) || 1;
    const g = this.grade[i] + (this.grade[j] - this.grade[i]) * f;
    const l = Math.hypot(1, g);
    return { x: tx / hl / l, y: g / l, z: tz / hl / l };
  }

  /** Set the centre elevation (three y) per point and derive the grade. */
  setElevation(y: Float64Array): void {
    const n = this.n;
    this.y.set(y);
    for (let i = 0; i < n; i++) {
      const a = this.idx(i - 1);
      const b = this.idx(i + 1);
      const span = this.closed ? 2 * this.ds : (b - a) * this.ds;
      this.grade[i] = span > 0 ? (this.y[b] - this.y[a]) / span : 0;
    }
  }

  // ----------------------------------------------------------------------------------------- projection

  private buildGrid(): void {
    const pad = 1;
    this.gOx = this.minX - pad;
    this.gOz = this.minZ - pad;
    this.gNx = Math.max(1, Math.ceil((this.maxX - this.minX + 2 * pad) / this.gCell));
    this.gNz = Math.max(1, Math.ceil((this.maxZ - this.minZ + 2 * pad) / this.gCell));
    const cells = this.gNx * this.gNz;
    const counts = new Int32Array(cells + 1);
    const segs = this.segmentCount;
    const forEachCell = (k: number, fn: (c: number) => void): void => {
      const a = k;
      const b = (k + 1) % this.n;
      const x0 = Math.min(this.x[a], this.x[b]);
      const x1 = Math.max(this.x[a], this.x[b]);
      const z0 = Math.min(this.z[a], this.z[b]);
      const z1 = Math.max(this.z[a], this.z[b]);
      const cx0 = Math.max(0, Math.floor((x0 - this.gOx) / this.gCell));
      const cx1 = Math.min(this.gNx - 1, Math.floor((x1 - this.gOx) / this.gCell));
      const cz0 = Math.max(0, Math.floor((z0 - this.gOz) / this.gCell));
      const cz1 = Math.min(this.gNz - 1, Math.floor((z1 - this.gOz) / this.gCell));
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) fn(cz * this.gNx + cx);
    };
    for (let k = 0; k < segs; k++) forEachCell(k, (c) => counts[c + 1]++);
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const items = new Int32Array(counts[cells]);
    const fill = counts.slice(0, cells);
    for (let k = 0; k < segs; k++) forEachCell(k, (c) => (items[fill[c]++] = k));
    this.gStart = counts;
    this.gItems = items;
    this.stamp = new Int32Array(segs);
  }

  /** Squared horizontal distance from (px, pz) to segment k, with the segment fraction in `out[0]`. */
  private segDist2(k: number, px: number, pz: number, out: Float64Array): number {
    const a = k;
    const b = k + 1 >= this.n ? 0 : k + 1;
    const ax = this.x[a];
    const az = this.z[a];
    const dx = this.x[b] - ax;
    const dz = this.z[b] - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    out[0] = t;
    const ex = ax + dx * t - px;
    const ez = az + dz * t - pz;
    return ex * ex + ez * ez;
  }

  private readonly tmp = new Float64Array(1);

  /** Closest segment over the whole line (exact). Returns [segment, t, d²]. */
  private nearestGlobal(px: number, pz: number): [number, number, number] {
    const sid = ++this.stampId;
    let best = -1;
    let bestT = 0;
    let bestD2 = Infinity;
    const C = this.gCell;
    let cx = Math.floor((px - this.gOx) / C);
    let cz = Math.floor((pz - this.gOz) / C);
    cx = Math.min(this.gNx - 1, Math.max(0, cx));
    cz = Math.min(this.gNz - 1, Math.max(0, cz));
    const maxR = Math.max(this.gNx, this.gNz);
    for (let r = 0; r <= maxR; r++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        if (iz < 0 || iz >= this.gNz) continue;
        const edgeRow = iz === cz - r || iz === cz + r;
        for (let ix = cx - r; ix <= cx + r; ix++) {
          if (ix < 0 || ix >= this.gNx) continue;
          if (!edgeRow && ix !== cx - r && ix !== cx + r) continue;
          const c = iz * this.gNx + ix;
          for (let q = this.gStart[c]; q < this.gStart[c + 1]; q++) {
            const k = this.gItems[q];
            if (this.stamp[k] === sid) continue;
            this.stamp[k] = sid;
            const d2 = this.segDist2(k, px, pz, this.tmp);
            if (d2 < bestD2) {
              bestD2 = d2;
              best = k;
              bestT = this.tmp[0];
            }
          }
        }
      }
      if (best >= 0) {
        // distance from p to the outside of the examined (2r+1)² block
        const xlo = this.gOx + (cx - r) * C;
        const xhi = this.gOx + (cx + r + 1) * C;
        const zlo = this.gOz + (cz - r) * C;
        const zhi = this.gOz + (cz + r + 1) * C;
        const m = Math.min(px - xlo, xhi - px, pz - zlo, zhi - pz);
        if (m > 0 && m * m >= bestD2) break;
      }
    }
    if (best < 0) return [0, 0, Infinity];
    return [best, bestT, bestD2];
  }

  /** Closest segment searching outward from the hint, following the line (no jumps to other sections). */
  private nearestLocal(px: number, pz: number, hintS: number): [number, number, number] {
    const segs = this.segmentCount;
    const hs = this.normS(hintS);
    const w = Math.ceil(PROJECT_WINDOW / this.ds);
    let c = Math.floor(hs / this.ds);
    if (!this.closed) c = Math.min(segs - 1, Math.max(0, c));
    let lo = c - w;
    let hi = c + w;
    let best = -1;
    let bestT = 0;
    let bestD2 = Infinity;
    const scan = (a: number, b: number): void => {
      for (let i = a; i <= b; i++) {
        let k = i;
        if (this.closed) k = ((i % segs) + segs) % segs;
        else if (k < 0 || k >= segs) continue;
        const d2 = this.segDist2(k, px, pz, this.tmp);
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
          bestT = this.tmp[0];
        }
      }
    };
    scan(lo, hi);
    // extend while the minimum sits on the window boundary (car moved far since the hint)
    for (let guard = 0; guard < 40; guard++) {
      if (best <= lo + 1 && (this.closed || lo > 0)) {
        const nlo = lo - w;
        scan(nlo, lo - 1);
        lo = nlo;
      } else if (best >= hi - 1 && (this.closed || hi < segs - 1)) {
        const nhi = hi + w;
        scan(hi + 1, nhi);
        hi = nhi;
      } else break;
      if (this.closed && hi - lo > segs) break;
    }
    let k = best;
    if (this.closed) k = ((k % segs) + segs) % segs;
    return [k, bestT, bestD2];
  }

  /** Calls fn(segment, distance) for every segment within r (horizontal) of (px, pz). */
  forSegmentsNear(px: number, pz: number, r: number, fn: (k: number, d: number) => void): void {
    const C = this.gCell;
    const cx0 = Math.max(0, Math.floor((px - r - this.gOx) / C));
    const cx1 = Math.min(this.gNx - 1, Math.floor((px + r - this.gOx) / C));
    const cz0 = Math.max(0, Math.floor((pz - r - this.gOz) / C));
    const cz1 = Math.min(this.gNz - 1, Math.floor((pz + r - this.gOz) / C));
    const sid = ++this.stampId;
    const r2 = r * r;
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * this.gNx + cx;
        for (let q = this.gStart[c]; q < this.gStart[c + 1]; q++) {
          const k = this.gItems[q];
          if (this.stamp[k] === sid) continue;
          this.stamp[k] = sid;
          const d2 = this.segDist2(k, px, pz, this.tmp);
          if (d2 <= r2) fn(k, Math.sqrt(d2));
        }
      }
  }

  /** Closest centre-line point (horizontal distance). With a hint: local search around it. */
  project(p: ThreeV3, hintS?: number): StageProjection {
    let res: [number, number, number];
    if (hintS !== undefined && Number.isFinite(hintS)) {
      res = this.nearestLocal(p.x, p.z, hintS);
      if (res[2] > 45 * 45) {
        const g = this.nearestGlobal(p.x, p.z);
        if (g[2] < res[2]) res = g;
      }
    } else res = this.nearestGlobal(p.x, p.z);
    const [k, t] = res;
    return this.projectionFrom(k, t, p);
  }

  /** Horizontal distance to the closest centre-line point and its s (global). */
  nearest(px: number, pz: number): { s: number; dist: number; lateral: number } {
    const [k, t, d2] = this.nearestGlobal(px, pz);
    const a = k;
    const b = k + 1 >= this.n ? 0 : k + 1;
    const dx = this.x[b] - this.x[a];
    const dz = this.z[b] - this.z[a];
    const l = Math.hypot(dx, dz) || 1;
    const cx = this.x[a] + dx * t;
    const cz = this.z[a] + dz * t;
    const lateral = (px - cx) * (-dz / l) + (pz - cz) * (dx / l);
    let s = (k + t) * this.ds;
    if (!this.closed) s = Math.min(this.length, s);
    else if (s >= this.length) s -= this.length;
    return { s, dist: Math.sqrt(d2), lateral };
  }

  private projectionFrom(k: number, t: number, p: ThreeV3): StageProjection {
    const a = k;
    const b = k + 1 >= this.n ? 0 : k + 1;
    const dx = this.x[b] - this.x[a];
    const dz = this.z[b] - this.z[a];
    const l = Math.hypot(dx, dz) || 1;
    const cx = this.x[a] + dx * t;
    const cz = this.z[a] + dz * t;
    const cy = this.y[a] + (this.y[b] - this.y[a]) * t;
    // right = cross(tangent, up) = (-tz, 0, tx)
    const lateral = (p.x - cx) * (-dz / l) + (p.z - cz) * (dx / l);
    let s = (k + t) * this.ds;
    if (this.closed) {
      if (s >= this.length) s -= this.length;
    } else s = Math.min(this.length, Math.max(0, s));
    return { s, lateral, heightOffset: p.y - cy, point: { x: cx, y: cy, z: cz } };
  }
}
