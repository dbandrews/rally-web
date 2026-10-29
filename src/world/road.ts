/**
 * src/world/road.ts — the road ribbon: cross-sections sampled from the centre line (left / centre / right
 * points with width, crown and bank), exported as Stage.road, plus the exact physics surface built from
 * the SAME points (THREE space).
 *
 * Physics surface: between consecutive samples a and b the ribbon is four triangles (the same points the
 * renderer gets in RoadSample.left / pos / right):
 *     [L_a, C_a, C_b], [L_a, C_b, L_b]   (left half)
 *     [C_a, R_a, R_b], [C_a, R_b, C_b]   (right half)
 * The material of a point between samples a and b is the surface of the nearer sample.
 */
import { SURFACE_IDS } from '../core/constants';
import type { RoadSample, SurfaceId } from '../core/types';
import type { Centerline } from './centerline';

/** Per centre-line point cross-section parameters. */
export interface CrossSection {
  /** Edge-to-edge width, m. */
  width: Float64Array;
  /** Bank angle rad, + = tilts down toward the right edge. */
  bank: Float64Array;
  /** Crown height of the centre above the edges, m. */
  crown: Float64Array;
  /** Material id (SURFACE_IDS index). */
  material: Uint8Array;
}

const TRI_STRIDE = 10;
const EPS_BARY = 1e-9;
/**
 * Depth of the vertical "kerb" faces hanging under both ribbon edges (m). Everything under the ribbon
 * footprint counts as solid (heightAt returns the ribbon there), while the terrain beside the road is a
 * few cm (on fills: more) lower than the ribbon edge. The kerb faces close that slot down to the terrain,
 * so a slanted ray coming from beside the road hits the side of the road bed instead of slipping under
 * the ribbon. (The terrain wins wherever it is above the ray, so the depth only needs to be "enough".)
 */
export const KERB_DEPTH = 50;
/** Rays steeper than this (|dir.y|) ignore the kerb faces. */
export const KERB_MAX_DY = 0.7;

export interface RoadHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
  px: number;
  py: number;
  pz: number;
  material: number;
}

export class RoadModel {
  readonly samples: RoadSample[];
  readonly count: number;
  /** Dense centre-line index of each sample (closed: the last sample has index n, i.e. s = length). */
  readonly denseIndex: Int32Array;
  readonly s: Float64Array;
  readonly cx: Float64Array;
  readonly cy: Float64Array;
  readonly cz: Float64Array;
  readonly lx: Float64Array;
  readonly ly: Float64Array;
  readonly lz: Float64Array;
  readonly rx: Float64Array;
  readonly ry: Float64Array;
  readonly rz: Float64Array;
  readonly hw: Float64Array;
  readonly mat: Uint8Array;
  readonly segCount: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;

  private readonly tri: Float64Array;
  private readonly triOk: Uint8Array;
  private readonly segBox: Float64Array; // minx maxx minz maxz miny maxy
  private gOx = 0;
  private gOz = 0;
  private readonly gCell = 8;
  private gNx = 1;
  private gNz = 1;
  private gStart!: Int32Array;
  private gItems!: Int32Array;
  private readonly stamp: Int32Array;
  private stampId = 0;
  private readonly kerbN = new Float64Array(2);
  /** Segment / triangle of the last successful heightAt(). */
  lastSeg = -1;
  lastTri = -1;

  constructor(cl: Centerline, cs: CrossSection, forced: ReadonlySet<number> = new Set()) {
    // ---- choose sample indices (adaptive spacing 1-3 m by horizontal and vertical curvature)
    const n = cl.n;
    const last = cl.closed ? n : n - 1;
    const idx: number[] = [0];
    const spacingAt = (i: number): number => {
      const ii = cl.idx(i);
      const kh = Math.abs(cl.kappa[ii]);
      const a = cl.idx(i - 1);
      const b = cl.idx(i + 1);
      const kv = Math.abs(cl.grade[b] - cl.grade[a]) / (2 * cl.ds);
      const rh = kh > 1e-9 ? 1 / kh : 1e9;
      const rv = kv > 1e-9 ? 1 / kv : 1e9;
      return Math.min(3, Math.max(1, Math.sqrt(0.08 * Math.min(rh, rv))));
    };
    let i = 0;
    while (i < last) {
      let next = i + 1;
      let span = cl.ds;
      // advance while the spacing allowed by every point in between permits it
      while (next < last) {
        let allowed = Infinity;
        for (let j = i; j <= next + 1 && j <= last; j++) allowed = Math.min(allowed, spacingAt(j));
        if (span + cl.ds > allowed + 1e-9) break;
        if (forced.has(next)) break;
        next++;
        span += cl.ds;
      }
      i = next;
      idx.push(i);
    }
    this.count = idx.length;
    const N = this.count;
    this.denseIndex = Int32Array.from(idx);
    this.s = new Float64Array(N);
    this.cx = new Float64Array(N);
    this.cy = new Float64Array(N);
    this.cz = new Float64Array(N);
    this.lx = new Float64Array(N);
    this.ly = new Float64Array(N);
    this.lz = new Float64Array(N);
    this.rx = new Float64Array(N);
    this.ry = new Float64Array(N);
    this.rz = new Float64Array(N);
    this.hw = new Float64Array(N);
    this.mat = new Uint8Array(N);
    this.samples = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < N; k++) {
      const di = idx[k];
      const p = cl.idx(di);
      const s = cl.closed && di === n ? cl.length : di * cl.ds;
      const x = cl.x[p], y = cl.y[p], z = cl.z[p];
      const rxh = -cl.hz[p];
      const rzh = cl.hx[p];
      const hw = cs.width[p] / 2;
      const tb = Math.tan(cs.bank[p]);
      const crown = cs.crown[p];
      const yl = y - crown + tb * hw;
      const yr = y - crown - tb * hw;
      this.s[k] = s;
      this.cx[k] = x; this.cy[k] = y; this.cz[k] = z;
      this.lx[k] = x - rxh * hw; this.ly[k] = yl; this.lz[k] = z - rzh * hw;
      this.rx[k] = x + rxh * hw; this.ry[k] = yr; this.rz[k] = z + rzh * hw;
      this.hw[k] = hw;
      this.mat[k] = cs.material[p];
      minX = Math.min(minX, this.lx[k], this.rx[k]);
      maxX = Math.max(maxX, this.lx[k], this.rx[k]);
      minZ = Math.min(minZ, this.lz[k], this.rz[k]);
      maxZ = Math.max(maxZ, this.lz[k], this.rz[k]);
      this.samples.push({
        s,
        pos: { x, y, z },
        left: { x: this.lx[k], y: yl, z: this.lz[k] },
        right: { x: this.rx[k], y: yr, z: this.rz[k] },
        width: hw * 2,
        bank: cs.bank[p],
        surface: SURFACE_IDS[cs.material[p]] as SurfaceId,
      });
    }
    this.minX = minX; this.maxX = maxX; this.minZ = minZ; this.maxZ = maxZ;

    // ---- triangles
    this.segCount = N - 1;
    const S = this.segCount;
    this.tri = new Float64Array(S * 4 * TRI_STRIDE);
    this.triOk = new Uint8Array(S * 4);
    this.segBox = new Float64Array(S * 6);
    for (let k = 0; k < S; k++) {
      const a = k, b = k + 1;
      this.setTri(k * 4 + 0, this.lx[a], this.ly[a], this.lz[a], this.cx[a], this.cy[a], this.cz[a], this.cx[b], this.cy[b], this.cz[b]);
      this.setTri(k * 4 + 1, this.lx[a], this.ly[a], this.lz[a], this.cx[b], this.cy[b], this.cz[b], this.lx[b], this.ly[b], this.lz[b]);
      this.setTri(k * 4 + 2, this.cx[a], this.cy[a], this.cz[a], this.rx[a], this.ry[a], this.rz[a], this.rx[b], this.ry[b], this.rz[b]);
      this.setTri(k * 4 + 3, this.cx[a], this.cy[a], this.cz[a], this.rx[b], this.ry[b], this.rz[b], this.cx[b], this.cy[b], this.cz[b]);
      const xs = [this.lx[a], this.rx[a], this.cx[a], this.lx[b], this.rx[b], this.cx[b]];
      const ys = [this.ly[a], this.ry[a], this.cy[a], this.ly[b], this.ry[b], this.cy[b]];
      const zs = [this.lz[a], this.rz[a], this.cz[a], this.lz[b], this.rz[b], this.cz[b]];
      const o = k * 6;
      this.segBox[o] = Math.min(...xs) - 1e-6;
      this.segBox[o + 1] = Math.max(...xs) + 1e-6;
      this.segBox[o + 2] = Math.min(...zs) - 1e-6;
      this.segBox[o + 3] = Math.max(...zs) + 1e-6;
      this.segBox[o + 4] = Math.min(...ys) - KERB_DEPTH - 1e-6;
      this.segBox[o + 5] = Math.max(...ys) + 1e-6;
    }
    this.stamp = new Int32Array(Math.max(1, S));
    this.buildGrid();
  }

  private setTri(t: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    const o = t * TRI_STRIDE;
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const det = e1x * e2z - e1z * e2x;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz);
    if (Math.abs(det) < 1e-9 || nl < 1e-12) {
      this.triOk[t] = 0;
      return;
    }
    nx /= nl; ny /= nl; nz /= nl;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    this.triOk[t] = 1;
    const tri = this.tri;
    tri[o] = ax;
    tri[o + 1] = az;
    tri[o + 2] = e2z / det;
    tri[o + 3] = -e2x / det;
    tri[o + 4] = -e1z / det;
    tri[o + 5] = e1x / det;
    tri[o + 6] = nx;
    tri[o + 7] = ny;
    tri[o + 8] = nz;
    tri[o + 9] = nx * ax + ny * ay + nz * az;
  }

  private buildGrid(): void {
    const C = this.gCell;
    this.gOx = this.minX - 1;
    this.gOz = this.minZ - 1;
    this.gNx = Math.max(1, Math.ceil((this.maxX - this.minX + 2) / C));
    this.gNz = Math.max(1, Math.ceil((this.maxZ - this.minZ + 2) / C));
    const cells = this.gNx * this.gNz;
    const counts = new Int32Array(cells + 1);
    const each = (k: number, fn: (c: number) => void): void => {
      const o = k * 6;
      const cx0 = Math.max(0, Math.floor((this.segBox[o] - this.gOx) / C));
      const cx1 = Math.min(this.gNx - 1, Math.floor((this.segBox[o + 1] - this.gOx) / C));
      const cz0 = Math.max(0, Math.floor((this.segBox[o + 2] - this.gOz) / C));
      const cz1 = Math.min(this.gNz - 1, Math.floor((this.segBox[o + 3] - this.gOz) / C));
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) fn(cz * this.gNx + cx);
    };
    for (let k = 0; k < this.segCount; k++) each(k, (c) => counts[c + 1]++);
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const items = new Int32Array(counts[cells]);
    const fill = counts.slice(0, cells);
    for (let k = 0; k < this.segCount; k++) each(k, (c) => (items[fill[c]++] = k));
    this.gStart = counts;
    this.gItems = items;
  }

  /** Is the triangle's xz projection containing (px, pz)? */
  private inTri(t: number, px: number, pz: number): boolean {
    const o = t * TRI_STRIDE;
    const tri = this.tri;
    const qx = px - tri[o];
    const qz = pz - tri[o + 1];
    const u = tri[o + 2] * qx + tri[o + 3] * qz;
    const v = tri[o + 4] * qx + tri[o + 5] * qz;
    return u >= -EPS_BARY && v >= -EPS_BARY && u + v <= 1 + EPS_BARY;
  }

  private triHeight(t: number, x: number, z: number): number {
    const o = t * TRI_STRIDE;
    const tri = this.tri;
    return (tri[o + 9] - tri[o + 6] * x - tri[o + 8] * z) / tri[o + 7];
  }

  /** Road surface height at (x, z) (THREE space) or NaN when (x, z) is not on the ribbon. */
  heightAt(x: number, z: number): number {
    this.lastSeg = -1;
    this.lastTri = -1;
    const C = this.gCell;
    const cx = Math.floor((x - this.gOx) / C);
    const cz = Math.floor((z - this.gOz) / C);
    if (cx < 0 || cz < 0 || cx >= this.gNx || cz >= this.gNz) return NaN;
    const c = cz * this.gNx + cx;
    let best = NaN;
    for (let q = this.gStart[c]; q < this.gStart[c + 1]; q++) {
      const k = this.gItems[q];
      const o = k * 6;
      const sb = this.segBox;
      if (x < sb[o] || x > sb[o + 1] || z < sb[o + 2] || z > sb[o + 3]) continue;
      for (let j = 0; j < 4; j++) {
        const t = k * 4 + j;
        if (!this.triOk[t] || !this.inTri(t, x, z)) continue;
        const h = this.triHeight(t, x, z);
        if (!(h <= best)) {
          best = h;
          this.lastSeg = k;
          this.lastTri = t;
        }
      }
    }
    return best;
  }

  /** Normal of triangle `t` (THREE space) written into out[0..2]. */
  triNormal(t: number, out: Float64Array): void {
    const o = t * TRI_STRIDE;
    out[0] = this.tri[o + 6];
    out[1] = this.tri[o + 7];
    out[2] = this.tri[o + 8];
  }

  /** Material of a point inside segment k (surface of the nearer sample). */
  materialInSeg(k: number, px: number, pz: number): number {
    const a = k, b = k + 1;
    const dx = this.cx[b] - this.cx[a];
    const dz = this.cz[b] - this.cz[a];
    const l2 = dx * dx + dz * dz;
    const f = l2 > 0 ? ((px - this.cx[a]) * dx + (pz - this.cz[a]) * dz) / l2 : 0;
    return f < 0.5 ? this.mat[a] : this.mat[b];
  }

  /** Nearest ray hit with the ribbon within [0, maxT] (THREE space). */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, hit: RoadHit): boolean {
    const ex = ox + dx * maxT;
    const ey = oy + dy * maxT;
    const ez = oz + dz * maxT;
    const bx0 = Math.min(ox, ex), bx1 = Math.max(ox, ex);
    const bz0 = Math.min(oz, ez), bz1 = Math.max(oz, ez);
    const by0 = Math.min(oy, ey), by1 = Math.max(oy, ey);
    if (bx1 < this.minX || bx0 > this.maxX || bz1 < this.minZ || bz0 > this.maxZ) return false;
    const C = this.gCell;
    const cx0 = Math.max(0, Math.floor((bx0 - this.gOx) / C));
    const cx1 = Math.min(this.gNx - 1, Math.floor((bx1 - this.gOx) / C));
    const cz0 = Math.max(0, Math.floor((bz0 - this.gOz) / C));
    const cz1 = Math.min(this.gNz - 1, Math.floor((bz1 - this.gOz) / C));
    if (cx1 < cx0 || cz1 < cz0) return false;
    const sid = ++this.stampId;
    let best = maxT;
    let found = false;
    let bestTri = -1;
    let bestSeg = -1;
    const tri = this.tri;
    const sb = this.segBox;
    const hasHz = Math.abs(dx) + Math.abs(dz) > 1e-9;
    // steep (wheel / hull) rays that clip a kerb report the road surface normal of that edge instead of
    // a horizontal one, so suspensions never see sideways "ground"
    const steep = Math.abs(dy) >= KERB_MAX_DY;
    let kerbTri = -1;
    const kerbN = this.kerbN;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * this.gNx + cx;
        for (let q = this.gStart[c]; q < this.gStart[c + 1]; q++) {
          const k = this.gItems[q];
          if (this.stamp[k] === sid) continue;
          this.stamp[k] = sid;
          const o6 = k * 6;
          if (bx1 < sb[o6] || bx0 > sb[o6 + 1] || bz1 < sb[o6 + 2] || bz0 > sb[o6 + 3] || by1 < sb[o6 + 4] || by0 > sb[o6 + 5]) continue;
          for (let j = 0; j < 4; j++) {
            const t = k * 4 + j;
            if (!this.triOk[t]) continue;
            const o = t * TRI_STRIDE;
            const nx = tri[o + 6], ny = tri[o + 7], nz = tri[o + 8];
            const denom = nx * dx + ny * dy + nz * dz;
            if (Math.abs(denom) < 1e-12) continue;
            const tt = (tri[o + 9] - (nx * ox + ny * oy + nz * oz)) / denom;
            if (tt < 0 || tt > best) continue;
            if (!this.inTri(t, ox + dx * tt, oz + dz * tt)) continue;
            best = tt;
            found = true;
            bestTri = t;
            bestSeg = k;
          }
          // kerb faces under the left and right edges (only rays with a horizontal component)
          if (hasHz) {
            for (let side = 0; side < 2; side++) {
              const a = k, b = k + 1;
              const ax = side ? this.rx[a] : this.lx[a];
              const az = side ? this.rz[a] : this.lz[a];
              const ay = side ? this.ry[a] : this.ly[a];
              const ex2 = (side ? this.rx[b] : this.lx[b]) - ax;
              const ez2 = (side ? this.rz[b] : this.lz[b]) - az;
              const ey2 = (side ? this.ry[b] : this.ly[b]) - ay;
              // solve (ox, oz) + t·(dx, dz) = (ax, az) + u·(ex2, ez2)
              const den = dx * ez2 - dz * ex2;
              if (Math.abs(den) < 1e-12) continue;
              const qx = ax - ox, qz = az - oz;
              const tt = (qx * ez2 - qz * ex2) / den;
              if (tt < 0 || tt > best) continue;
              const u = (qx * dz - qz * dx) / den;
              if (u < 0 || u > 1) continue;
              const top = ay + ey2 * u;
              const yr = oy + dy * tt;
              if (yr > top || yr < top - KERB_DEPTH) continue;
              best = tt;
              found = true;
              bestTri = -1;
              bestSeg = k;
              kerbTri = side ? k * 4 + 2 : k * 4 + 1;
              // horizontal normal facing the incoming ray
              const el = Math.hypot(ex2, ez2) || 1;
              let nx = -ez2 / el, nz = ex2 / el;
              if (nx * dx + nz * dz > 0) { nx = -nx; nz = -nz; }
              kerbN[0] = nx;
              kerbN[1] = nz;
            }
          }
        }
      }
    }
    if (!found) return false;
    hit.t = best;
    if (bestTri < 0 && steep && kerbTri >= 0 && this.triOk[kerbTri]) bestTri = kerbTri;
    if (bestTri < 0) {
      hit.nx = kerbN[0];
      hit.ny = 0;
      hit.nz = kerbN[1];
      hit.px = ox + dx * best;
      hit.py = oy + dy * best;
      hit.pz = oz + dz * best;
      hit.material = this.materialInSeg(bestSeg, hit.px, hit.pz);
      return true;
    }
    const o = bestTri * TRI_STRIDE;
    hit.nx = tri[o + 6];
    hit.ny = tri[o + 7];
    hit.nz = tri[o + 8];
    hit.px = ox + dx * best;
    hit.py = oy + dy * best;
    hit.pz = oz + dz * best;
    hit.material = this.materialInSeg(bestSeg, hit.px, hit.pz);
    return true;
  }

  /** Index of the last sample with s <= query (binary search). */
  sampleIndexAt(s: number): number {
    let lo = 0;
    let hi = this.count - 1;
    if (s <= this.s[0]) return 0;
    if (s >= this.s[hi]) return hi;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.s[m] <= s) lo = m;
      else hi = m;
    }
    return lo;
  }

  /** Interpolated cross-section at s (s already wrapped/clamped by the caller). */
  roadAt(s: number): RoadSample {
    const a = this.sampleIndexAt(s);
    const b = Math.min(this.count - 1, a + 1);
    const span = this.s[b] - this.s[a];
    const f = span > 1e-9 ? Math.min(1, Math.max(0, (s - this.s[a]) / span)) : 0;
    const L = (u: Float64Array): number => u[a] + (u[b] - u[a]) * f;
    const sa = this.samples[a];
    const sbb = this.samples[b];
    return {
      s,
      pos: { x: L(this.cx), y: L(this.cy), z: L(this.cz) },
      left: { x: L(this.lx), y: L(this.ly), z: L(this.lz) },
      right: { x: L(this.rx), y: L(this.ry), z: L(this.rz) },
      width: 2 * L(this.hw),
      bank: sa.bank + (sbb.bank - sa.bank) * f,
      surface: f < 0.5 ? sa.surface : sbb.surface,
    };
  }
}
