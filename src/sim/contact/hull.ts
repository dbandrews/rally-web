/**
 * src/sim/contact/hull.ts - OWNED BY THE SIM-CONTACT BUILDER.
 *
 * The collision hull of a body for the body-body contact FUN_006d4390 (research/formats/dynamics.md sec. 6-7): the
 * `.col` file's points (body frame) and the planes of its quads (FUN_006d68e0), the radius B+0x18 = max |p|
 * (FUN_006ca5e0). A car's hull is ALL 18 points and 10 quads of `Car_<Name>.col` (carHulls.ts), not the 12 ground-probe
 * points of origHulls.ts.
 */
import { CAR_COL } from './carHulls';

/** Points and planes in flat typed arrays (no per-call allocation in the contact). */
export interface ContactHull {
  /** Point count and planes count. */
  readonly nPts: number;
  readonly nPl: number;
  /** Body-frame points, float32-rounded like the loader's sscanf("%f"). */
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  /** Plane normals (unit, outward on the shipped car hulls) and offsets d = dot(P[a], n); "inside" = n.q - d <= 0. */
  readonly nx: Float64Array;
  readonly ny: Float64Array;
  readonly nz: Float64Array;
  readonly nd: Float64Array;
  /** max |p| over all points (B+0x18). */
  readonly radius: number;
}

const f32 = Math.fround;

/**
 * FUN_006d68e0: quad (a, b, c, d) -> the plane through P[a], P[b], P[d]; n = normalize((P[b]-P[a]) x (P[d]-P[a])),
 * left alone when |n.n - 1| < 1e-12 (the exe's epsilon at 0x93531c), zero for a degenerate quad; d = dot(P[a], n).
 * The exe stores normals and offsets as float32.
 */
export function buildContactHull(points: ArrayLike<number>, quads: ArrayLike<number>): ContactHull {
  const nPts = Math.floor(points.length / 3);
  const nPl = Math.floor(quads.length / 4);
  const px = new Float64Array(nPts);
  const py = new Float64Array(nPts);
  const pz = new Float64Array(nPts);
  let r2 = 0;
  for (let i = 0; i < nPts; i++) {
    px[i] = f32(points[3 * i]);
    py[i] = f32(points[3 * i + 1]);
    pz[i] = f32(points[3 * i + 2]);
    r2 = Math.max(r2, px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i]);
  }
  const nx = new Float64Array(nPl);
  const ny = new Float64Array(nPl);
  const nz = new Float64Array(nPl);
  const nd = new Float64Array(nPl);
  for (let k = 0; k < nPl; k++) {
    const a = quads[4 * k];
    const b = quads[4 * k + 1];
    const d = quads[4 * k + 3];
    const ux = px[b] - px[a];
    const uy = py[b] - py[a];
    const uz = pz[b] - pz[a];
    const wx = px[d] - px[a];
    const wy = py[d] - py[a];
    const wz = pz[d] - pz[a];
    let x = uy * wz - uz * wy;
    let y = uz * wx - ux * wz;
    let z = ux * wy - uy * wx;
    const l2 = x * x + y * y + z * z;
    if (Math.abs(l2 - 1) >= 1e-12) {
      if (l2 > 0) {
        const s = 1 / Math.sqrt(l2);
        x *= s;
        y *= s;
        z *= s;
      } else {
        x = y = z = 0;
      }
    }
    nx[k] = f32(x);
    ny[k] = f32(y);
    nz[k] = f32(z);
    nd[k] = f32(px[a] * nx[k] + py[a] * ny[k] + pz[a] * nz[k]);
  }
  return { nPts, nPl, px, py, pz, nx, ny, nz, nd, radius: f32(Math.sqrt(r2)) };
}

const carCache = new Map<string, ContactHull>();

/** The full Car_<Name>.col hull of an original car (cached), or null for an unknown name. */
export function carContactHull(name: string | null | undefined): ContactHull | null {
  if (!name) return null;
  let h = carCache.get(name);
  if (!h) {
    const c = CAR_COL[name];
    if (!c) return null;
    h = buildContactHull(c.points, c.quads);
    carCache.set(name, h);
  }
  return h;
}

/**
 * A stand-in hull for cars without an original `.col` (the archetype cars of src/sim/car.ts, which race only in
 * tests): the axis-aligned box of their ground-probe points as 8 points and 6 outward quads.
 */
export function boxContactHull(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): ContactHull {
  const pts: number[] = [];
  for (let i = 0; i < 8; i++) pts.push(i & 1 ? maxX : minX, i & 2 ? maxY : minY, i & 4 ? maxZ : minZ);
  // corner index = x | y<<1 | z<<2; quads wound so that (P[b]-P[a]) x (P[d]-P[a]) points outward
  const quads = [
    1, 0, 2, 3, // z = min face ... orientation fixed below by the centroid test
    4, 5, 7, 6,
    0, 1, 5, 4,
    3, 2, 6, 7,
    0, 4, 6, 2,
    1, 3, 7, 5,
  ];
  const h = buildContactHull(pts, quads);
  // make every plane outward (the centroid is the origin of the box centre)
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  for (let k = 0; k < h.nPl; k++) {
    if (h.nx[k] * cx + h.ny[k] * cy + h.nz[k] * cz - h.nd[k] > 0) {
      h.nx[k] = -h.nx[k];
      h.ny[k] = -h.ny[k];
      h.nz[k] = -h.nz[k];
      h.nd[k] = -h.nd[k];
    }
  }
  return h;
}
