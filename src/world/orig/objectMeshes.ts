/**
 * src/world/orig/objectMeshes.ts — the static objects' own collision meshes of a ported stage (RCOL v2, built by
 * tools/assets/parts/collision.py from each template mesh's CollisionMesh.Simple, research/formats/standardmesh.md
 * §2.2) and a literal port of the original's query on them. SIM space.
 *
 * The original collides a car with a static object by sending the car's hull segments through the object's mesh
 * (object pass FUN_004a7bc0 → FUN_006d1a80 → physics callback 0x677c30 → mesh-instance query 0x5912a0, which
 * composes diag(Object.geometry.scale)·R + pos at 0x591c20 and calls CollisionMesh.Simple's query 0x597810;
 * docs/orig/collision.md §4). The car side (gate, hull loop, body solver) is src/sim/car.ts objectPass.
 *
 * 0x597810 (asm, this file's `query`), the segment o → o + ray against one mesh under the 4×4 transform M:
 *   1. local frame: O = (o − T)·M⁻¹ (general inverse 0x5d53b0), E = O + ray·M⁻¹ (3×3 rows only, 0x5d5270), D = E − O;
 *   2. the segment's AABB against the mesh's vertex AABB (both closed): no overlap → miss before any triangle;
 *   3. every candidate triangle (the BSP's leaf list for the segment; here all triangles, the same set for a
 *      conservative BSP) with n = −(stored normal) (the records store inward normals):
 *        dE = (E − v0)·n > 0 → skip;  d0 = (O − v0)·n ≤ 0 → skip (a start on the plane misses);  da = D·n ≥ 0 → skip;
 *        t = −d0/da; the axis pair by |n.y| ≥ 0.7 → (x, z), else |n.z| > 0.3 → (x, y), else (y, z) (0x8066f4/f8);
 *        edge cross products c1..c3, c2 and c3 compared ONLY with c1 (c1 == 0 accepts), as the Grid's FUN_00595020;
 *   4. of the accepted triangles the one with the SMALLEST dE wins (the deepest end, strict <, best starts at 1e9)
 *      — not the first and not the nearest;
 *   5. out: normal = n·M (3×3, NOT re-normalised: a scaled object returns a scaled normal), point = H·M + T,
 *      depth = dE in the LOCAL frame, material = the record's pad (0x677c30 replaces it by its own 1 anyway).
 * Deviation: candidates are visited in triangle order, not BSP-leaf order (only an exact dE tie can differ).
 *
 * `mirrorZ` (stage-frame workaround, world.ts): inputs and outputs have z negated at the boundary, the exposed
 * transform is m·diag(1, 1, −1) and the origin / centre are mirrored; the query itself runs unmirrored.
 */
import type { ObjectCollider, ObjectSegmentHit, SceneryKind, SimV3 } from '../../core/types';
import { ProxyGrid } from './obstacles';
import { INST, INST_COLOUR, MESH_STRIDE, type RcolData } from './rcol';

/** The query's initial best depth (0x597aae: 0x4e6e6b28 = 1e9). */
const BEST0 = 1e9;
/** Axis selection of the triangle test (0x8066f4 / 0x8066f8, f32). */
const AXIS_Y = Math.fround(0.7);
const AXIS_Z = Math.fround(0.3);

/** The stage's object colliders and the shared mesh arrays. */
export class OrigObjectMeshes {
  readonly list: OrigObjectCollider[];
  readonly grid: ProxyGrid<OrigObjectCollider>;
  /** Shared mesh data (rcol.ts). */
  readonly V: Float32Array;
  readonly TN: Float32Array;
  readonly TI: Uint32Array;

  constructor(d: RcolData, kinds: readonly string[], mirrorZ = false) {
    this.V = d.mV;
    this.TN = d.mTN;
    this.TI = d.mTI;
    const list: OrigObjectCollider[] = [];
    for (let k = 0; k < d.nInst; k++) {
      const c = new OrigObjectCollider(this, d, k, kinds, mirrorZ);
      if (c.valid) list.push(c);
    }
    this.list = list;
    this.grid = new ProxyGrid(list);
  }

  /** Colliders whose bounding sphere comes within `radius` of p (horizontal). */
  near(p: SimV3, radius: number, out: ObjectCollider[]): ObjectCollider[] {
    return this.grid.near(p.x, p.z, radius, out);
  }
}

/** One hard object part: its mesh under its transform. */
export class OrigObjectCollider implements ObjectCollider {
  readonly object: number;
  readonly kind: SceneryKind;
  readonly material: number;
  readonly origin: SimV3;
  readonly pos: SimV3;
  readonly radius: number;
  readonly boxMin: SimV3;
  readonly boxMax: SimV3;
  readonly m: Float64Array;
  /** The instance's flags (rcol.ts INST_COLOUR: a TreeMesh geometry, the object pass's trunk gate applies). */
  readonly flags: number;
  readonly treeMesh: boolean;
  readonly valid: boolean;
  private readonly set: OrigObjectMeshes;
  /** Unmirrored transform (query frame) and its inverse, rows. */
  private readonly qm: Float64Array;
  private readonly qt: Float64Array;
  private readonly inv: Float64Array;
  private readonly t0: number;
  private readonly nt: number;
  /** Mesh vertex AABB (local). */
  private readonly bb: Float64Array;
  private readonly zs: number;

  constructor(set: OrigObjectMeshes, d: RcolData, k: number, kinds: readonly string[], mirrorZ: boolean) {
    this.set = set;
    const A = d.inst, b = k * d.instStride;
    const zs = mirrorZ ? -1 : 1;
    this.zs = zs;
    this.object = A[b + INST.OBJECT];
    this.kind = (kinds[A[b + INST.KIND]] ?? 'barrier') as SceneryKind;
    this.material = A[b + INST.MATERIAL];
    this.flags = A[b + INST.FLAGS];
    this.treeMesh = (this.flags & INST_COLOUR) !== 0;
    this.radius = A[b + INST.RADIUS];
    this.qm = Float64Array.from(A.subarray(b + INST.M, b + INST.M + 9));
    this.qt = Float64Array.from(A.subarray(b + INST.T, b + INST.T + 3));
    this.m = Float64Array.from(this.qm);
    if (mirrorZ) for (let i = 2; i < 9; i += 3) this.m[i] = -this.m[i];
    this.origin = { x: this.qt[0], y: this.qt[1], z: zs * this.qt[2] };
    this.pos = { x: A[b + INST.CENTRE], y: A[b + INST.CENTRE + 1], z: zs * A[b + INST.CENTRE + 2] };
    this.boxMin = { x: A[b + INST.BOXMIN], y: A[b + INST.BOXMIN + 1], z: A[b + INST.BOXMIN + 2] };
    this.boxMax = { x: A[b + INST.BOXMAX], y: A[b + INST.BOXMAX + 1], z: A[b + INST.BOXMAX + 2] };
    const mi = A[b + INST.MESH] * MESH_STRIDE;
    this.t0 = d.mesh[mi];
    this.nt = d.mesh[mi + 1];
    this.bb = Float64Array.from(d.mesh.subarray(mi + 2, mi + 8));
    this.inv = invert3(this.qm);
    this.valid = Number.isFinite(this.inv[0] + this.inv[4] + this.inv[8] + this.qt[0] + this.qt[1] + this.qt[2]) &&
      this.radius > 0 && this.nt > 0;
  }

  segment(o: SimV3, ray: SimV3, out: ObjectSegmentHit): boolean {
    const zs = this.zs, M = this.qm, T = this.qt, iv = this.inv;
    // 1. local frame (row vectors: v·M⁻¹)
    const ax = o.x - T[0], ay = o.y - T[1], az = zs * o.z - T[2];
    const rx = ray.x, ry = ray.y, rz = zs * ray.z;
    const Ox = ax * iv[0] + ay * iv[3] + az * iv[6];
    const Oy = ax * iv[1] + ay * iv[4] + az * iv[7];
    const Oz = ax * iv[2] + ay * iv[5] + az * iv[8];
    const Ex = Ox + (rx * iv[0] + ry * iv[3] + rz * iv[6]);
    const Ey = Oy + (rx * iv[1] + ry * iv[4] + rz * iv[7]);
    const Ez = Oz + (rx * iv[2] + ry * iv[5] + rz * iv[8]);
    // 2. segment AABB vs the mesh AABB (closed)
    const bb = this.bb;
    if (bb[0] > Math.max(Ox, Ex) || bb[1] > Math.max(Oy, Ey) || bb[2] > Math.max(Oz, Ez)) return false;
    if (bb[3] < Math.min(Ox, Ex) || bb[4] < Math.min(Oy, Ey) || bb[5] < Math.min(Oz, Ez)) return false;
    const Dx = Ex - Ox, Dy = Ey - Oy, Dz = Ez - Oz;
    const V = this.set.V, TN = this.set.TN, TI = this.set.TI;
    let best = BEST0;
    let hit = false;
    let hx = 0, hy = 0, hz = 0, nX = 0, nY = 0, nZ = 0;
    const H = HP;
    const Ov = OV;
    const Dv = DV;
    Ov[0] = Ox; Ov[1] = Oy; Ov[2] = Oz;
    Dv[0] = Dx; Dv[1] = Dy; Dv[2] = Dz;
    for (let t = this.t0, t1 = this.t0 + this.nt; t < t1; t++) {
      const nx = -TN[3 * t], ny = -TN[3 * t + 1], nz = -TN[3 * t + 2];
      const i0 = 3 * TI[4 * t], i1 = 3 * TI[4 * t + 1], i2 = 3 * TI[4 * t + 2];
      const v0x = V[i0], v0y = V[i0 + 1], v0z = V[i0 + 2];
      // 3. plane tests: end behind (dE ≤ 0), start strictly in front (d0 > 0), moving into the face (da < 0)
      const dE = (Ex - v0x) * nx + (Ey - v0y) * ny + (Ez - v0z) * nz;
      if (dE > 0) continue;
      const d0 = (Ox - v0x) * nx + (Oy - v0y) * ny + (Oz - v0z) * nz;
      if (!(d0 > 0)) continue;
      const da = Dx * nx + Dy * ny + Dz * nz;
      if (!(da < 0)) continue;
      const tt = -(d0 / da);
      // axis pair (a, b) and the dropped axis
      let a: number, c: number, drop: number;
      if (Math.abs(ny) >= AXIS_Y) {
        a = 0; c = 2; drop = 1;
      } else if (Math.abs(nz) > AXIS_Z) {
        a = 0; c = 1; drop = 2;
      } else {
        a = 1; c = 2; drop = 0;
      }
      const ha = Ov[a] + tt * Dv[a], hc = Ov[c] + tt * Dv[c];
      const p0a = V[i0 + a], p0c = V[i0 + c], p1a = V[i1 + a], p1c = V[i1 + c], p2a = V[i2 + a], p2c = V[i2 + c];
      const c1 = (ha - p0a) * (p1c - p0c) - (hc - p0c) * (p1a - p0a);
      const c2 = (ha - p1a) * (p2c - p1c) - (hc - p1c) * (p2a - p1a);
      if (c1 < 0) {
        if (c2 > 0) continue;
      } else if (c1 > 0) {
        if (c2 < 0) continue;
      }
      if (c1 !== 0) {
        const c3 = (ha - p2a) * (p0c - p2c) - (hc - p2c) * (p0a - p2a);
        if (c1 < 0 ? c3 > 0 : c3 < 0) continue;
      }
      // 4. accepted: keep the deepest end
      if (!(dE < best)) continue;
      best = dE;
      hit = true;
      H[a] = ha;
      H[c] = hc;
      H[drop] = Ov[drop] + tt * Dv[drop];
      hx = H[0]; hy = H[1]; hz = H[2];
      nX = nx; nY = ny; nZ = nz;
    }
    if (!hit) return false;
    // 5. back to SIM: n·M (rows, no translation, not re-normalised), H·M + T
    const n = out.normal, p = out.point;
    n.x = nX * M[0] + nY * M[3] + nZ * M[6];
    n.y = nX * M[1] + nY * M[4] + nZ * M[7];
    n.z = zs * (nX * M[2] + nY * M[5] + nZ * M[8]);
    p.x = hx * M[0] + hy * M[3] + hz * M[6] + T[0];
    p.y = hx * M[1] + hy * M[4] + hz * M[7] + T[1];
    p.z = zs * (hx * M[2] + hy * M[5] + hz * M[8] + T[2]);
    out.depth = best;
    return true;
  }
}

const HP = new Float64Array(3);
const OV = new Float64Array(3);
const DV = new Float64Array(3);

/** Inverse of a 3×3 (rows); NaN entries when singular. */
function invert3(m: Float64Array): Float64Array {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const r = 1 / det;
  return Float64Array.of(
    A * r, -(b * i - c * h) * r, (b * f - c * e) * r,
    B * r, (a * i - c * g) * r, -(a * f - c * d) * r,
    C * r, -(a * h - b * g) * r, (a * e - b * d) * r,
  );
}

