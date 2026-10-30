/**
 * src/core/worldQuery.ts — ARCHITECT-OWNED CONTRACT HELPERS (no three.js). Builders: import, do not edit.
 *
 * Shared pieces of the WorldQuery contract (src/core/types.ts, research/formats/gcm.md §3):
 *   - segmentViaRaycast: WorldQuery.segment for PROCEDURAL worlds (single-valued ground answered by raycast)
 *   - raycastViaSegment: WorldQuery.raycast for MESH worlds (the original's segment query is the primitive)
 *   - face-cache slot numbering (the original's car+0xa4·24 layout) and the multi-level `yHint` rule
 */
import { origFromMaterial } from './constants';
import type { RayHit, SimV3, WorldQuery } from './types';

// ------------------------------------------------------------------------------------------- slots

/** Face-cache slots per car (the original: slot = index + 24·carIndex, gcm.md §3.5 / §3.6). */
export const SLOTS_PER_CAR = 24;
/** Hull point i of a car uses slot 8 + i (+ 24·carIndex); wheels use 0..3. */
export const HULL_SLOT_OFFSET = 8;
/** The original's lastBlock / lastFace arrays hold 5000 slots (0x916be8 / 0x911dc8); slots must be < this. */
export const MAX_FACE_SLOTS = 5000;
/** "No face cache" slot (the original's −1; also what WorldQuery.raycast uses on mesh worlds). */
export const NO_SLOT = -1;

/** CarSimOptions.slotBase of car `carIndex` (0 = player). */
export const slotBaseOf = (carIndex: number): number => SLOTS_PER_CAR * carIndex;
/** Face-cache slot of wheel `wheel` (0 FL, 1 FR, 2 RR, 3 RL) for a car with `slotBase` (= 24·carIndex). */
export const wheelSlot = (slotBase: number, wheel: number): number => slotBase + wheel;
/** Face-cache slot of hull point `i` (0..11) for a car with `slotBase`. */
export const hullSlot = (slotBase: number, i: number): number => slotBase + HULL_SLOT_OFFSET + i;
/** Is `slot` a cache slot (0 ≤ slot < MAX_FACE_SLOTS, integer)? −1 / undefined / out of range = no cache. */
export const isCacheSlot = (slot: number | undefined): slot is number =>
  slot !== undefined && slot >= 0 && slot < MAX_FACE_SLOTS && (slot | 0) === slot;

// ------------------------------------------------------------------------------------------- procedural adapter

const scratchDir: SimV3 = { x: 0, y: 0, z: 0 };
/** The raycast result segmentViaRaycast reads (copied out at once, so a world may fill it in place). */
const scratchCast: RayHit = { dist: 0, normal: { x: 0, y: 1, z: 0 }, material: 0, point: { x: 0, y: 0, z: 0 } };

/** A RayHit with its own normal / point objects, for the `out` argument of WorldQuery.segment / raycast. */
export function makeRayHit(): RayHit {
  return { dist: 0, normal: { x: 0, y: 1, z: 0 }, material: 0, point: { x: 0, y: 0, z: 0 }, t: 0, depth: 0, cos: 0, origMaterial: 0, face: -1 };
}

/** Write a hit into `out` (every field; normal / point in place) and return it. */
export function setRayHit(
  out: RayHit, dist: number, nx: number, ny: number, nz: number, material: number, px: number, py: number, pz: number,
  t: number, depth: number, cos: number, origMaterial: number, face: number,
): RayHit {
  out.dist = dist;
  out.normal.x = nx;
  out.normal.y = ny;
  out.normal.z = nz;
  out.material = material;
  out.point.x = px;
  out.point.y = py;
  out.point.z = pz;
  out.t = t;
  out.depth = depth;
  out.cos = cos;
  out.origMaterial = origMaterial;
  out.face = face;
  return out;
}

/**
 * WorldQuery.segment for procedural worlds, through `world.raycast` (contract: src/core/types.ts WorldQuery):
 * normalises `raySim`, casts over its length and fills t / depth / cos / origMaterial (face = −1). The original's
 * semantics on a single-valued ground: an origin ON or BELOW the ground (raycast dist 0) is a MISS, a hit whose
 * normal faces along the ray (back face, dot(n, ray) ≥ 0) is a MISS; depth is clamped to ≤ 0. `slot` is
 * ignored (no face cache: a procedural ground has one face per point). Returns `out` filled in place when given
 * (WorldQuery.segment's hot-path form; the world's raycast is asked to fill a module scratch), else a fresh RayHit.
 */
export function segmentViaRaycast(
  world: Pick<WorldQuery, 'raycast'>,
  originSim: SimV3,
  raySim: SimV3,
  _slot?: number,
  out?: RayHit,
): RayHit | null {
  const rx = raySim.x, ry = raySim.y, rz = raySim.z;
  const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  const inv = 1 / len;
  scratchDir.x = rx * inv;
  scratchDir.y = ry * inv;
  scratchDir.z = rz * inv;
  // a world that fills only the required fields must not leave another world's optional ones behind
  scratchCast.origMaterial = scratchCast.face = scratchCast.t = scratchCast.depth = scratchCast.cos = undefined;
  const h = world.raycast(originSim, scratchDir, len, scratchCast);
  if (!h || !(h.dist > 0)) return null; // start on / below the ground plane: d0 ≤ 0 → miss (gcm.md §3.4)
  const n = h.normal;
  const cos = n.x * rx + n.y * ry + n.z * rz;
  if (!(cos < 0)) return null; // one-sided: back faces and parallel rays never hit
  const ex = originSim.x + rx - h.point.x;
  const ey = originSim.y + ry - h.point.y;
  const ez = originSim.z + rz - h.point.z;
  const depth = Math.min(0, n.x * ex + n.y * ey + n.z * ez);
  const om = h.origMaterial ?? origFromMaterial(h.material);
  if (out) {
    return setRayHit(out, h.dist, n.x, n.y, n.z, h.material, h.point.x, h.point.y, h.point.z, Math.min(1, h.dist * inv), depth, cos, om, h.face ?? -1);
  }
  return {
    dist: h.dist,
    normal: { x: n.x, y: n.y, z: n.z },
    material: h.material,
    point: { x: h.point.x, y: h.point.y, z: h.point.z },
    t: Math.min(1, h.dist * inv),
    depth,
    cos,
    origMaterial: om,
    face: h.face ?? -1,
  };
}

// ------------------------------------------------------------------------------------------- mesh adapter

const scratchRay: SimV3 = { x: 0, y: 0, z: 0 };

/**
 * WorldQuery.raycast for mesh worlds: segment(o, dir·maxDist, NO_SLOT); with a unit `dir` the segment's
 * dist = t·|ray| is t·maxDist. An origin below the ground is a miss (the original), never a dist-0 hit.
 * `segment` must not keep a reference to its ray argument (a scratch vector is passed). `out` is passed through.
 */
export function raycastViaSegment(
  world: Pick<WorldQuery, 'segment'>,
  originSim: SimV3,
  dirSim: SimV3,
  maxDist: number,
  out?: RayHit,
): RayHit | null {
  if (!(maxDist > 0)) return null;
  scratchRay.x = dirSim.x * maxDist;
  scratchRay.y = dirSim.y * maxDist;
  scratchRay.z = dirSim.z * maxDist;
  return world.segment(originSim, scratchRay, NO_SLOT, out);
}

// ------------------------------------------------------------------------------------------- multi-level ground

/** The `yHint` window: ground up to this far ABOVE the hint still counts as "below" it (m). */
export const GROUND_HINT_ABOVE_M = 1;

/**
 * The WorldQuery `yHint` rule over the candidate ground heights at one (x, z) (e.g. every front face under a
 * vertical line): without a hint the highest; with one the highest at or below yHint + GROUND_HINT_ABOVE_M,
 * else the lowest above it. Returns the INDEX into `ys[0..n)` (−1 when n = 0), so callers can fetch the
 * matching normal / material.
 */
export function pickGroundLevel(ys: ArrayLike<number>, n: number, yHint?: number): number {
  let best = -1;
  if (yHint === undefined || !Number.isFinite(yHint)) {
    for (let i = 0; i < n; i++) if (best < 0 || ys[i] > ys[best]) best = i;
    return best;
  }
  const lim = yHint + GROUND_HINT_ABOVE_M;
  let lowestAbove = -1;
  for (let i = 0; i < n; i++) {
    const y = ys[i];
    if (y <= lim) {
      if (best < 0 || y > ys[best]) best = i;
    } else if (lowestAbove < 0 || y < ys[lowestAbove]) lowestAbove = i;
  }
  return best >= 0 ? best : lowestAbove;
}

/** pickGroundLevel returning the height itself (NaN when n = 0). */
export function pickGroundY(ys: ArrayLike<number>, n: number, yHint?: number): number {
  const i = pickGroundLevel(ys, n, yHint);
  return i < 0 ? NaN : ys[i];
}
