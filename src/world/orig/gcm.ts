/**
 * src/world/orig/gcm.ts — the original's collision query on Track.gcm, ported literally
 * (research/formats/gcm.md §3.2-3.4 + Verification; reference: tools/assets/lib/formats/fmt_gcm.py Gcm.raycast).
 *
 *   segment()     Grid query, primary vtbl+0xc = 0x595c50: top-cell walk (one cell for a near-vertical ray,
 *                 else Cohen-Sutherland clip to the bbox + supercover Bresenham over the 256² top cells), block
 *                 ids in each cell's list order, per-slot lastBlock / lastFace cache (0x916be8 / 0x911dc8).
 *   blockQuery()  FUN_00594330: half-open box (vertical) or clip + Bresenham over the block's sub-grid, the
 *                 slot's cached face first in every visited sub-cell, then the sub-cell list; FIRST hit wins.
 *   tri()         FUN_00595020: one-sided segment / triangle test, dominant-axis 2-D edge tests (0.7 / 0.3
 *                 axis choice; e2 and e3 compared only with e1, so e1 == 0 accepts).
 *
 * All arithmetic is float64 on the file's float32 values, in the operation order of the reference port (which
 * reproduces 1.2 M recorded wheel rays of the running original, gcm.md §8.2). Constants are the exe's float32
 * literals: 0.7f / 0.3f (0x8066f4 / 0x8066f8) and bresenhamLimit² = f32(0.05f · 0.05f) (0x593a70 → 0x91ba1c).
 * No allocation per query: the cell walks use preallocated buffers, the hit goes into a reused GcmHit.
 */
import type { RcolData } from './rcol';

/** bresenhamLimit (cvar, 0.05f at 0x84cc90), squared and stored as float32 by the static init 0x593a70. */
export const BRESENHAM_LIMIT2 = Math.fround(Math.fround(0.05) * Math.fround(0.05));
/** Axis-choice constants of FUN_00595020 (float32 literals 0x8066f4 / 0x8066f8). */
const AXIS_Y = Math.fround(0.7);
const AXIS_Z = Math.fround(0.3);
/** The original's lastBlock / lastFace arrays have 5000 slots. */
export const GCM_SLOTS = 5000;

/** Result of a hit (reused; copy what you keep). */
export interface GcmHit {
  face: number;
  /** Segment parameter 0..1. */
  t: number;
  /** dot(end − v0, n) ≤ 0 (the original's *outDepth). */
  depth: number;
  /** dot(n, ray) with the unnormalised ray (the original's *outCos). */
  cos: number;
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
  /** Raw material byte (u8; the original reads it sign-extended, 255 = −1). */
  material: number;
  /** Block id the hit came from. */
  block: number;
}

export const newGcmHit = (): GcmHit => ({
  face: -1, t: 0, depth: 0, cos: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, material: 255, block: -1,
});

/** Cohen-Sutherland 2-D clip result (FUN_00593be0). */
const clipOut = new Float64Array(4);

/** Cohen-Sutherland outcode (FUN_00593ac0: 1 z > maxZ, 8 z < minZ, 4 x > maxX, 2 x < minX). */
function outcode(x: number, z: number, minx: number, maxx: number, minz: number, maxz: number): number {
  let c = 0;
  if (z > maxz) c = 1;
  else if (z < minz) c = 8;
  if (x > maxx) return c | 4;
  if (x < minx) c |= 2;
  return c;
}

/** FUN_00593be0: clip (x0, z0)-(x1, z1) to the rectangle; writes clipOut, false when nothing is left. */
function clip2d(
  x0: number, z0: number, x1: number, z1: number, minx: number, maxx: number, minz: number, maxz: number,
): boolean {
  let c0 = outcode(x0, z0, minx, maxx, minz, maxz);
  let c1 = outcode(x1, z1, minx, maxx, minz, maxz);
  for (let it = 0; it < 16; it++) {
    if (c0 === 0 && c1 === 0) {
      clipOut[0] = x0;
      clipOut[1] = z0;
      clipOut[2] = x1;
      clipOut[3] = z1;
      return true;
    }
    if (c0 & c1) return false;
    const c = c0 ? c0 : c1;
    let x: number, z: number;
    if (c & 1) {
      x = ((x1 - x0) * (maxz - z0)) / (z1 - z0) + x0;
      z = maxz;
    } else if (c & 8) {
      x = ((x1 - x0) * (minz - z0)) / (z1 - z0) + x0;
      z = minz;
    } else if (c & 4) {
      z = ((z1 - z0) * (maxx - x0)) / (x1 - x0) + z0;
      x = maxx;
    } else {
      z = ((z1 - z0) * (minx - x0)) / (x1 - x0) + z0;
      x = minx;
    }
    if (c === c0) {
      x0 = x;
      z0 = z;
      c0 = outcode(x0, z0, minx, maxx, minz, maxz);
    } else {
      x1 = x;
      z1 = z;
      c1 = outcode(x1, z1, minx, maxx, minz, maxz);
    }
  }
  return false;
}

/**
 * FUN_00593e10: supercover Bresenham from cell (x0, z0) to (x1, z1) in start → end order, plus the corner
 * cell(s) where the line passes a corner (both on an exact tie). Writes (i, j) pairs into `out`, returns the
 * pair count. `out` must hold 2·(1 + 3·max(|dx|, |dz|)) entries.
 */
function bresenham(x0: number, z0: number, x1: number, z1: number, out: Int32Array): number {
  let n = 0;
  out[n++] = x0;
  out[n++] = z0;
  let dx = x1 - x0, dz = z1 - z0;
  const sx = dx < 0 ? -1 : 1;
  const sz = dz < 0 ? -1 : 1;
  dx = Math.abs(dx);
  dz = Math.abs(dz);
  let ix = x0, iz = z0;
  if (2 * dz < 2 * dx) {
    let err = dx;
    for (let s = 0; s < dx; s++) {
      ix += sx;
      let e = err + 2 * dz;
      if (2 * dx < e) {
        e -= 2 * dx;
        iz += sz;
        if (err + e < 2 * dx) {
          out[n++] = ix;
          out[n++] = iz - sz;
        } else if (2 * dx < err + e) {
          out[n++] = ix - sx;
          out[n++] = iz;
        } else {
          out[n++] = ix;
          out[n++] = iz - sz;
          out[n++] = ix - sx;
          out[n++] = iz;
        }
      }
      out[n++] = ix;
      out[n++] = iz;
      err = e;
    }
  } else if (dz > 0) {
    let err = dz;
    for (let s = 0; s < dz; s++) {
      iz += sz;
      let e = err + 2 * dx;
      if (2 * dz < e) {
        e -= 2 * dz;
        ix += sx;
        if (e + err < 2 * dz) {
          out[n++] = ix - sx;
          out[n++] = iz;
        } else if (2 * dz < e + err) {
          out[n++] = ix;
          out[n++] = iz - sz;
        } else {
          out[n++] = ix - sx;
          out[n++] = iz;
          out[n++] = ix;
          out[n++] = iz - sz;
        }
      }
      out[n++] = ix;
      out[n++] = iz;
      err = e;
    }
  }
  return n >> 1;
}

/** Capacity (pairs) of a cell walk over a dim-wide grid; clipped endpoints give cells in [0, dim]. */
const walkPairs = (dim: number) => 1 + 3 * (dim + 2);

/**
 * The Track.gcm CollisionMesh.Grid with the original's query. One instance per stage (the original keeps
 * lastBlock / lastFace as globals shared by every query; one track mesh exists per race).
 */
export class GcmGrid {
  readonly d: RcolData;
  /** f32(dim / (maxX − minX)), f32(dim / (maxZ − minZ)) (0x595c67..0x595c8f). */
  readonly invX: number;
  readonly invZ: number;
  /** Per-slot caches (0x916be8 lastBlock, 0x911dc8 lastFace), −1 = none. */
  readonly lastBlock = new Int32Array(GCM_SLOTS).fill(-1);
  readonly lastFace = new Int32Array(GCM_SLOTS).fill(-1);
  private readonly topCells: Int32Array;
  private readonly blkCells: Int32Array;
  /** Scratch hit of the last successful query. */
  readonly hit: GcmHit = newGcmHit();

  constructor(d: RcolData) {
    this.d = d;
    const dimf = Math.fround(d.dim);
    this.invX = Math.fround(dimf / (d.maxX - d.minX));
    this.invZ = Math.fround(dimf / (d.maxZ - d.minZ));
    let maxDim = 1;
    for (let b = 0; b < d.nB; b++) maxDim = Math.max(maxDim, d.blkU[5 * b]);
    this.topCells = new Int32Array(2 * walkPairs(d.dim));
    this.blkCells = new Int32Array(2 * walkPairs(maxDim));
  }

  /** Forget every slot's cached block / face (the ctor's −1 fill). */
  resetCache(): void {
    this.lastBlock.fill(-1);
    this.lastFace.fill(-1);
  }

  /**
   * 0x595c50: the segment (ox, oy, oz) → (ox, oy, oz) + (rx, ry, rz) in the gcm frame (= sim space; the
   * caller has already removed the object translation). `slot` −1 (or anything outside 0..4999) = no cache.
   * Returns true on a hit (details in this.hit), false on a miss.
   */
  segment(ox: number, oy: number, oz: number, rx: number, ry: number, rz: number, slot: number): boolean {
    if (!(Number.isFinite(ox) && Number.isFinite(oy) && Number.isFinite(oz))) return false;
    if (!(Number.isFinite(rx) && Number.isFinite(ry) && Number.isFinite(rz))) return false;
    const d = this.d;
    const minx = d.minX, minz = d.minZ, maxx = d.maxX, maxz = d.maxZ;
    const invx = this.invX, invz = this.invZ;
    const dim = d.dim;
    const cache = slot >= 0 && slot < GCM_SLOTS && (slot | 0) === slot;
    const cells = this.topCells;
    let nCells: number;
    if (rx * rx + rz * rz <= BRESENHAM_LIMIT2) {
      cells[0] = Math.trunc((ox - minx) * invx); // __ftol: truncation toward zero
      cells[1] = Math.trunc((oz - minz) * invz);
      nCells = 1;
    } else {
      if (!clip2d(ox, oz, ox + rx, oz + rz, minx, maxx, minz, maxz)) return false;
      const ax = clipOut[0], az = clipOut[1], bx = clipOut[2], bz = clipOut[3];
      nCells = bresenham(
        Math.trunc((ax - minx) * invx), Math.trunc((az - minz) * invz),
        Math.trunc((bx - minx) * invx), Math.trunc((bz - minz) * invz), cells,
      );
    }
    const cs = d.cellStart, cl = d.cellList;
    const lastBlock = cache ? this.lastBlock[slot] : -1;
    for (let c = 0; c < nCells; c++) {
      const i = cells[2 * c], j = cells[2 * c + 1];
      if (!(i >= 0 && i < dim && j >= 0 && j < dim)) continue;
      for (let k = cs[i * dim + j]; ; k++) {
        const bid = cl[k];
        if (bid === 0xffff) break;
        if (cache && lastBlock !== bid) this.lastFace[slot] = -1; // 0x595eb5: another block → forget the face
        if (this.blockQuery(bid, ox, oy, oz, rx, ry, rz, cache ? slot : -1)) {
          if (cache) this.lastBlock[slot] = bid;
          this.hit.block = bid;
          return true;
        }
      }
    }
    if (cache) this.lastBlock[slot] = -1; // 0x595f32
    return false;
  }

  /** FUN_00594330: the block's sub-cells along the segment, cached face first, first hit in list order. */
  private blockQuery(
    bid: number, ox: number, oy: number, oz: number, rx: number, ry: number, rz: number, slot: number,
  ): boolean {
    const d = this.d;
    const f = 8 * bid, u = 5 * bid;
    const bminx = d.blkF[f], bminz = d.blkF[f + 2], bmaxx = d.blkF[f + 3], bmaxz = d.blkF[f + 5];
    const ibx = d.blkF[f + 6], ibz = d.blkF[f + 7];
    const bdim = d.blkU[u], use16 = d.blkU[u + 1] !== 0, base = d.blkU[u + 2];
    const offBase = d.blkU[u + 3], listBase = d.blkU[u + 4];
    const cells = this.blkCells;
    let nCells: number;
    if (rx * rx + rz * rz <= BRESENHAM_LIMIT2) {
      // half-open xz box test (0x594477..0x5944bf); y is not tested
      if (!(bminx <= ox && ox < bmaxx && bminz <= oz && oz < bmaxz)) return false;
      cells[0] = Math.trunc((ox - bminx) * ibx);
      cells[1] = Math.trunc((oz - bminz) * ibz);
      nCells = 1;
    } else {
      if (!clip2d(ox, oz, ox + rx, oz + rz, bminx, bmaxx, bminz, bmaxz)) return false;
      const ax = clipOut[0], az = clipOut[1], bx = clipOut[2], bz = clipOut[3];
      nCells = bresenham(
        Math.trunc((ax - bminx) * ibx), Math.trunc((az - bminz) * ibz),
        Math.trunc((bx - bminx) * ibx), Math.trunc((bz - bminz) * ibz), cells,
      );
    }
    const ex = ox + rx, ey = oy + ry, ez = oz + rz; // segment end = origin + ray (unclipped)
    const cached = slot >= 0 ? this.lastFace[slot] : -1;
    const off = d.off;
    for (let c = 0; c < nCells; c++) {
      const i = cells[2 * c], j = cells[2 * c + 1];
      if (!(i >= 0 && i < bdim && j >= 0 && j < bdim)) continue;
      // the slot's cached face first, in every visited sub-cell (0x594664..0x594a2a)
      if (cached !== -1 && this.tri(cached, ox, oy, oz, ex, ey, ez, rx, ry, rz)) return true;
      let k = listBase + off[offBase + i * bdim + j];
      if (use16) {
        const lst = d.list16;
        for (let fi = lst[k]; fi !== 0xffff; fi = lst[++k]) {
          if (this.tri(fi + base, ox, oy, oz, ex, ey, ez, rx, ry, rz)) {
            if (slot >= 0) this.lastFace[slot] = fi + base;
            return true;
          }
        }
      } else {
        const lst = d.list32;
        for (let fi = lst[k]; fi !== 0xffffffff; fi = lst[++k]) {
          if (this.tri(fi, ox, oy, oz, ex, ey, ez, rx, ry, rz)) {
            if (slot >= 0) this.lastFace[slot] = fi;
            return true;
          }
        }
      }
    }
    if (slot >= 0) this.lastFace[slot] = -1; // 0x594b41
    return false;
  }

  /** FUN_00595020: one-sided segment o → e against face f; on a hit fills this.hit. */
  private tri(
    f: number, ox: number, oy: number, oz: number, ex: number, ey: number, ez: number,
    rx: number, ry: number, rz: number,
  ): boolean {
    const d = this.d;
    const V = d.V, I = d.I, FN = d.FN;
    const a0 = 3 * I[3 * f], a1 = 3 * I[3 * f + 1], a2 = 3 * I[3 * f + 2];
    const nx = FN[3 * f], ny = FN[3 * f + 1], nz = FN[3 * f + 2];
    const v0x = V[a0], v0y = V[a0 + 1], v0z = V[a0 + 2];
    const d1 = (ex - v0x) * nx + (ey - v0y) * ny + (ez - v0z) * nz; // end vs plane
    if (d1 > 0) return false; // the segment end must be on / below the plane
    const d0 = (ox - v0x) * nx + (oy - v0y) * ny + (oz - v0z) * nz; // start vs plane
    if (!(d0 > 0)) return false; // start STRICTLY above (0x59511f `test ah,0x41; jp`: d0 = 0 is a miss)
    const ax = ex - ox, ay = ey - oy, az = ez - oz;
    const da = ax * nx + ay * ny + az * nz;
    if (da >= 0) return false; // one-sided: back faces and parallel segments never hit
    const t = -(d0 / da);
    // dominant-axis projection (i, j | k): |n.y| ≥ 0.7 → (x, z | y), |n.z| > 0.3 → (x, y | z), else (y, z | x)
    let oi: number, oj: number, ai: number, aj: number;
    let v0i: number, v0j: number, v1i: number, v1j: number, v2i: number, v2j: number;
    let mode: number;
    if (Math.abs(ny) >= AXIS_Y) {
      mode = 0;
      oi = ox; oj = oz; ai = ax; aj = az;
      v0i = v0x; v0j = v0z; v1i = V[a1]; v1j = V[a1 + 2]; v2i = V[a2]; v2j = V[a2 + 2];
    } else if (Math.abs(nz) > AXIS_Z) {
      mode = 1;
      oi = ox; oj = oy; ai = ax; aj = ay;
      v0i = v0x; v0j = v0y; v1i = V[a1]; v1j = V[a1 + 1]; v2i = V[a2]; v2j = V[a2 + 1];
    } else {
      mode = 2;
      oi = oy; oj = oz; ai = ay; aj = az;
      v0i = v0y; v0j = v0z; v1i = V[a1 + 1]; v1j = V[a1 + 2]; v2i = V[a2 + 1]; v2j = V[a2 + 2];
    }
    const hi = t * ai + oi;
    const hj = t * aj + oj;
    const e1 = (v1j - v0j) * (hi - v0i) - (hj - v0j) * (v1i - v0i);
    const e2 = (v2j - v1j) * (hi - v1i) - (v2i - v1i) * (hj - v1j);
    if ((e1 < 0 && e2 > 0) || (e1 > 0 && e2 < 0)) return false;
    const e3 = (v0j - v2j) * (hi - v2i) - (hj - v2j) * (v0i - v2i);
    if ((e1 < 0 && e3 > 0) || (e1 > 0 && e3 < 0)) return false;
    const h = this.hit;
    if (mode === 0) {
      h.px = hi; h.pz = hj; h.py = t * ay + oy;
    } else if (mode === 1) {
      h.px = hi; h.py = hj; h.pz = t * az + oz;
    } else {
      h.py = hi; h.pz = hj; h.px = t * ax + ox;
    }
    h.face = f;
    h.t = t;
    h.depth = d1; // *outDepth = dot(end − v0, n)
    h.cos = nx * rx + ny * ry + nz * rz; // *outCos = dot(n, ray), unnormalised (0x594fd4)
    h.nx = nx;
    h.ny = ny;
    h.nz = nz;
    h.material = d.M[f];
    return true;
  }

  // --------------------------------------------------------------------------------------- point queries

  /**
   * Every front-facing face over the vertical line at (x, z): writes their surface heights to `ys` and face
   * ids to `faces` (at most `ys.length`), returns the count. Not the physics primitive (that is segment's
   * first hit); this is the "ground under a point" for heightAt & co: the faces of the block whose half-open
   * box holds (x, z), its sub-cell list, an edge-inclusive xz containment test (no e1 == 0 quirk) and the
   * face plane through v0 with the stored normal (the same plane segment() hits). Faces with n.y ≤ 0 (walls,
   * back faces, zero normals) never count.
   */
  facesAt(x: number, z: number, ys: Float64Array, faces: Int32Array): number {
    const d = this.d;
    if (!(Number.isFinite(x) && Number.isFinite(z))) return 0;
    const i = Math.trunc((x - d.minX) * this.invX), j = Math.trunc((z - d.minZ) * this.invZ);
    const dim = d.dim;
    if (!(i >= 0 && i < dim && j >= 0 && j < dim)) return 0;
    let n = 0;
    const cap = ys.length;
    for (let k = d.cellStart[i * dim + j]; ; k++) {
      const bid = d.cellList[k];
      if (bid === 0xffff) break;
      const f8 = 8 * bid, u = 5 * bid;
      const bminx = d.blkF[f8], bminz = d.blkF[f8 + 2], bmaxx = d.blkF[f8 + 3], bmaxz = d.blkF[f8 + 5];
      if (!(bminx <= x && x < bmaxx && bminz <= z && z < bmaxz)) continue;
      const bdim = d.blkU[u], use16 = d.blkU[u + 1] !== 0, base = d.blkU[u + 2];
      const bi = Math.trunc((x - bminx) * d.blkF[f8 + 6]), bj = Math.trunc((z - bminz) * d.blkF[f8 + 7]);
      if (!(bi >= 0 && bi < bdim && bj >= 0 && bj < bdim)) continue;
      let q = d.blkU[u + 4] + d.off[d.blkU[u + 3] + bi * bdim + bj];
      for (;;) {
        let fi: number;
        if (use16) {
          const v = d.list16[q++];
          if (v === 0xffff) break;
          fi = v + base;
        } else {
          const v = d.list32[q++];
          if (v === 0xffffffff) break;
          fi = v;
        }
        const y = this.planeYAt(fi, x, z);
        if (y === y && n < cap) {
          let dup = false;
          for (let m = 0; m < n; m++) if (faces[m] === fi) dup = true;
          if (!dup) {
            ys[n] = y;
            faces[n++] = fi;
          }
        }
      }
    }
    return n;
  }

  /** Height of face f's plane at (x, z) when the face is front-facing upward and covers (x, z) in xz; NaN else. */
  planeYAt(f: number, x: number, z: number): number {
    const d = this.d;
    const V = d.V, I = d.I, FN = d.FN;
    const ny = FN[3 * f + 1];
    if (!(ny > 0)) return NaN;
    const a0 = 3 * I[3 * f], a1 = 3 * I[3 * f + 1], a2 = 3 * I[3 * f + 2];
    const x0 = V[a0], z0 = V[a0 + 2], x1 = V[a1], z1 = V[a1 + 2], x2 = V[a2], z2 = V[a2 + 2];
    const e1 = (z1 - z0) * (x - x0) - (z - z0) * (x1 - x0);
    const e2 = (z2 - z1) * (x - x1) - (z - z1) * (x2 - x1);
    const e3 = (z0 - z2) * (x - x2) - (z - z2) * (x0 - x2);
    const neg = e1 < 0 || e2 < 0 || e3 < 0;
    const pos = e1 > 0 || e2 > 0 || e3 > 0;
    if (neg && pos) return NaN;
    const nx = FN[3 * f], nz = FN[3 * f + 2];
    return V[a0 + 1] - (nx * (x - x0) + nz * (z - z0)) / ny;
  }
}
