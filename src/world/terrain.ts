/**
 * src/world/terrain.ts — exact queries on the stage heightfield (THREE space).
 *
 * Triangulation (the renderer should use the same split): cell (ix, iz) with corners
 *   v00 = (ix, iz), v10 = (ix+1, iz), v01 = (ix, iz+1), v11 = (ix+1, iz+1)
 * is cut along the diagonal v00–v11 into triangle A = (v00, v10, v11) (where fx ≥ fz) and
 * triangle B = (v00, v11, v01) (where fz > fx), fx/fz being the fractional position inside the cell.
 * Outside the grid, heights clamp to the nearest edge (an extruded skirt).
 * Materials are per vertex; a point takes the material of its nearest vertex.
 */
import type { Heightfield } from '../core/types';

export interface TerrainHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
  px: number;
  py: number;
  pz: number;
  material: number;
}

export class Terrain {
  readonly ox: number;
  readonly oz: number;
  readonly cs: number;
  readonly nx: number;
  readonly nz: number;
  readonly heights: Float32Array;
  readonly materials: Uint8Array;
  readonly maxX: number;
  readonly maxZ: number;
  private readonly inv: number;

  constructor(hf: Heightfield) {
    this.ox = hf.originX;
    this.oz = hf.originZ;
    this.cs = hf.cellSize;
    this.nx = hf.nx;
    this.nz = hf.nz;
    this.heights = hf.heights;
    this.materials = hf.materials;
    this.inv = 1 / hf.cellSize;
    this.maxX = this.ox + (this.nx - 1) * this.cs;
    this.maxZ = this.oz + (this.nz - 1) * this.cs;
  }

  /** Height at (x, z), exact on the triangle mesh; edge clamp outside. */
  heightAt(x: number, z: number): number {
    let gx = (x - this.ox) * this.inv;
    let gz = (z - this.oz) * this.inv;
    const mx = this.nx - 1;
    const mz = this.nz - 1;
    if (!(gx > 0)) gx = 0;
    else if (gx > mx) gx = mx;
    if (!(gz > 0)) gz = 0;
    else if (gz > mz) gz = mz;
    let ix = Math.floor(gx);
    let iz = Math.floor(gz);
    if (ix >= mx) ix = mx - 1;
    if (iz >= mz) iz = mz - 1;
    const u = gx - ix;
    const v = gz - iz;
    const h = this.heights;
    const i00 = iz * this.nx + ix;
    const h00 = h[i00];
    const h10 = h[i00 + 1];
    const h01 = h[i00 + this.nx];
    const h11 = h[i00 + this.nx + 1];
    if (u >= v) return h00 + (h10 - h00) * u + (h11 - h10) * v;
    return h00 + (h11 - h01) * u + (h01 - h00) * v;
  }

  /** Unit face normal at (x, z) into out[0..2]. */
  normalAt(x: number, z: number, out: Float64Array): void {
    let gx = (x - this.ox) * this.inv;
    let gz = (z - this.oz) * this.inv;
    const mx = this.nx - 1;
    const mz = this.nz - 1;
    const outside = !(gx >= 0 && gx <= mx && gz >= 0 && gz <= mz);
    if (outside) {
      out[0] = 0;
      out[1] = 1;
      out[2] = 0;
      return;
    }
    let ix = Math.floor(gx);
    let iz = Math.floor(gz);
    if (ix >= mx) ix = mx - 1;
    if (iz >= mz) iz = mz - 1;
    const u = gx - ix;
    const v = gz - iz;
    this.cellNormal(ix, iz, u >= v, out);
  }

  private cellNormal(ix: number, iz: number, triA: boolean, out: Float64Array): void {
    const h = this.heights;
    const i00 = iz * this.nx + ix;
    const h00 = h[i00];
    const h10 = h[i00 + 1];
    const h01 = h[i00 + this.nx];
    const h11 = h[i00 + this.nx + 1];
    let a: number;
    let b: number;
    if (triA) {
      a = (h10 - h00) * this.inv;
      b = (h11 - h10) * this.inv;
    } else {
      a = (h11 - h01) * this.inv;
      b = (h01 - h00) * this.inv;
    }
    const l = Math.sqrt(a * a + 1 + b * b);
    out[0] = -a / l;
    out[1] = 1 / l;
    out[2] = -b / l;
  }

  /** Material of the nearest vertex. */
  materialAt(x: number, z: number): number {
    let ix = Math.round((x - this.ox) * this.inv);
    let iz = Math.round((z - this.oz) * this.inv);
    if (ix < 0) ix = 0;
    else if (ix >= this.nx) ix = this.nx - 1;
    if (iz < 0) iz = 0;
    else if (iz >= this.nz) iz = this.nz - 1;
    return this.materials[iz * this.nx + ix];
  }

  private readonly nTmp = new Float64Array(3);

  /** Exact intersection of the ray with the cell triangles (DDA over cells). */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, hit: TerrainHit): boolean {
    // clip the ray to the grid box in xz
    let t0 = 0;
    let t1 = maxT;
    const x0 = this.ox, x1 = this.maxX, z0 = this.oz, z1 = this.maxZ;
    if (Math.abs(dx) < 1e-12) {
      if (ox < x0 || ox > x1) t1 = -1;
    } else {
      let ta = (x0 - ox) / dx;
      let tb = (x1 - ox) / dx;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
    }
    if (Math.abs(dz) < 1e-12) {
      if (oz < z0 || oz > z1) t1 = -1;
    } else {
      let ta = (z0 - oz) / dz;
      let tb = (z1 - oz) / dz;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
    }
    if (t1 < t0) return this.marchRange(ox, oy, oz, dx, dy, dz, 0, maxT, hit);
    if (t0 > 0 && this.marchRange(ox, oy, oz, dx, dy, dz, 0, t0, hit)) return true;
    if (this.gridRay(ox, oy, oz, dx, dy, dz, maxT, t0, t1, hit)) return true;
    return t1 < maxT && this.marchRange(ox, oy, oz, dx, dy, dz, t1, maxT, hit);
  }

  private gridRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, t0: number, t1: number, hit: TerrainHit): boolean {
    const inv = this.inv;
    const mx = this.nx - 1;
    const mz = this.nz - 1;

    const gx = (ox + dx * t0 - this.ox) * inv;
    const gz = (oz + dz * t0 - this.oz) * inv;
    let ix = Math.min(mx - 1, Math.max(0, Math.floor(gx)));
    let iz = Math.min(mz - 1, Math.max(0, Math.floor(gz)));
    const du = dx * inv;
    const dv = dz * inv;
    const stepX = du > 0 ? 1 : du < 0 ? -1 : 0;
    const stepZ = dv > 0 ? 1 : dv < 0 ? -1 : 0;
    // parametric distance to the next cell boundary
    const gx0 = (ox - this.ox) * inv;
    const gz0 = (oz - this.oz) * inv;
    let tMaxX = stepX > 0 ? (ix + 1 - gx0) / du : stepX < 0 ? (ix - gx0) / du : Infinity;
    let tMaxZ = stepZ > 0 ? (iz + 1 - gz0) / dv : stepZ < 0 ? (iz - gz0) / dv : Infinity;
    const tDeltaX = stepX !== 0 ? Math.abs(1 / du) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dv) : Infinity;
    let tEnter = t0;
    const h = this.heights;
    const nx = this.nx;
    for (let guard = 0; guard < 100000; guard++) {
      const tExit = Math.min(tMaxX, tMaxZ, t1);
      // test the two triangles of cell (ix, iz) for t in [tEnter, tExit]
      const i00 = iz * nx + ix;
      const h00 = h[i00];
      const h10 = h[i00 + 1];
      const h01 = h[i00 + nx];
      const h11 = h[i00 + nx + 1];
      const u0 = gx0 - ix;
      const v0 = gz0 - iz;
      let bestT = Infinity;
      let bestA = true;
      // triangle A: u >= v, h = h00 + a1 u + a2 v
      {
        const a1 = h10 - h00;
        const a2 = h11 - h10;
        const c0 = oy - h00 - a1 * u0 - a2 * v0;
        const c1 = dy - a1 * du - a2 * dv;
        if (Math.abs(c1) > 1e-14) {
          const t = -c0 / c1;
          if (t >= tEnter - 1e-9 && t <= tExit + 1e-9) {
            const u = u0 + du * t;
            const v = v0 + dv * t;
            if (u - v >= -1e-9 && u <= 1 + 1e-9 && v >= -1e-9) {
              bestT = t;
              bestA = true;
            }
          }
        } else if (Math.abs(c0) < 1e-9) {
          bestT = tEnter;
        }
      }
      {
        const b1 = h11 - h01;
        const b2 = h01 - h00;
        const c0 = oy - h00 - b1 * u0 - b2 * v0;
        const c1 = dy - b1 * du - b2 * dv;
        if (Math.abs(c1) > 1e-14) {
          const t = -c0 / c1;
          if (t >= tEnter - 1e-9 && t <= tExit + 1e-9 && t < bestT) {
            const u = u0 + du * t;
            const v = v0 + dv * t;
            if (v - u >= -1e-9 && v <= 1 + 1e-9 && u >= -1e-9) {
              bestT = t;
              bestA = false;
            }
          }
        }
      }
      if (bestT !== Infinity) {
        const t = Math.max(0, Math.min(maxT, bestT));
        hit.t = t;
        hit.px = ox + dx * t;
        hit.py = oy + dy * t;
        hit.pz = oz + dz * t;
        this.cellNormal(ix, iz, bestA, this.nTmp);
        hit.nx = this.nTmp[0];
        hit.ny = this.nTmp[1];
        hit.nz = this.nTmp[2];
        hit.material = this.materialAt(hit.px, hit.pz);
        return true;
      }
      if (tExit >= t1) return false;
      if (tMaxX < tMaxZ) {
        ix += stepX;
        tEnter = tMaxX;
        tMaxX += tDeltaX;
      } else {
        iz += stepZ;
        tEnter = tMaxZ;
        tMaxZ += tDeltaZ;
      }
      if (ix < 0 || iz < 0 || ix >= mx || iz >= mz) return false;
    }
    return false;
  }

  /** Coarse march + bisection on the edge-clamped skirt for a part of a ray outside the grid (rare). */
  private marchRange(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, a: number, b: number, hit: TerrainHit): boolean {
    const f = (t: number): number => oy + dy * t - this.heightAt(ox + dx * t, oz + dz * t);
    let tp = a;
    if (f(tp) <= 0) return this.fillOutside(hit, ox, oy, oz, dx, dy, dz, tp);
    const n = Math.max(1, Math.ceil((b - a) / (this.cs * 0.5)));
    for (let i = 1; i <= n; i++) {
      const t = a + ((b - a) * i) / n;
      if (f(t) <= 0) {
        let lo = tp;
        let hi = t;
        for (let k = 0; k < 30; k++) {
          const m = 0.5 * (lo + hi);
          if (f(m) > 0) lo = m;
          else hi = m;
        }
        return this.fillOutside(hit, ox, oy, oz, dx, dy, dz, hi);
      }
      tp = t;
    }
    return false;
  }

  private fillOutside(hit: TerrainHit, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, t: number): boolean {
    hit.t = t;
    hit.px = ox + dx * t;
    hit.pz = oz + dz * t;
    hit.py = this.heightAt(hit.px, hit.pz);
    this.normalAt(hit.px, hit.pz, this.nTmp);
    hit.nx = this.nTmp[0];
    hit.ny = this.nTmp[1];
    hit.nz = this.nTmp[2];
    hit.material = this.materialAt(hit.px, hit.pz);
    return true;
  }
}
