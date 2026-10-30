/**
 * src/game/stageMath.ts — game builder. Small geometry helpers shared by the race controller and the
 * autopilot (THREE space unless noted).
 */
import type { Heightfield, SimPose, Stage, ThreeQuat, ThreeV3, WorldQuery } from '../core/types';

/** Car forward (THREE world) for a THREE-space car quaternion (car local forward = -Z). */
export function forwardOfThree(q: ThreeQuat, out: ThreeV3 = { x: 0, y: 0, z: 0 }): ThreeV3 {
  out.x = -(2 * (q.x * q.z + q.w * q.y));
  out.y = -(2 * (q.y * q.z - q.w * q.x));
  out.z = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return out;
}

/** Car right (THREE world, local +X). */
export function rightOfQuat(q: ThreeQuat, out: ThreeV3 = { x: 0, y: 0, z: 0 }): ThreeV3 {
  out.x = 1 - 2 * (q.y * q.y + q.z * q.z);
  out.y = 2 * (q.x * q.y + q.w * q.z);
  out.z = 2 * (q.x * q.z - q.w * q.y);
  return out;
}

/** y component of the car's up axis (local +Y) in world space: 1 upright, < 0 upside down. */
export function upYOfQuat(q: ThreeQuat): number {
  return 1 - 2 * (q.x * q.x + q.z * q.z);
}

/** Bilinear heightfield height (THREE y) at THREE (x, z); NaN outside the grid. */
export function heightfieldAt(hf: Heightfield, x: number, z: number): number {
  if (!hf || hf.nx < 2 || hf.nz < 2 || !(hf.cellSize > 0)) return Number.NaN;
  const fx = (x - hf.originX) / hf.cellSize;
  const fz = (z - hf.originZ) / hf.cellSize;
  if (fx < 0 || fz < 0 || fx > hf.nx - 1 || fz > hf.nz - 1) return Number.NaN;
  const ix = Math.min(hf.nx - 2, Math.floor(fx));
  const iz = Math.min(hf.nz - 2, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const h = hf.heights;
  const i0 = iz * hf.nx + ix;
  const a = h[i0];
  const b = h[i0 + 1];
  const c = h[i0 + hf.nx];
  const d = h[i0 + hf.nx + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

/**
 * Make sure a SIM-space spawn pose is at least `raise` above the stage ground (terrain heightfield) at its
 * position, so lateral spawns never start underground. Mutates and returns the pose. The ground level is
 * the one at the pose's own height (WorldQuery yHint): under an overpass the road below, not the deck.
 */
export function liftAboveGround(stage: Stage, pose: SimPose, raise: number, world?: WorldQuery | null): SimPose {
  // the WorldQuery (road ribbon + terrain, sim space) is exact; the bilinear heightfield is the fallback
  const g = world ? world.heightAt(pose.pos.x, pose.pos.z, pose.pos.y) : heightfieldAt(stage.heightfield, pose.pos.x, -pose.pos.z); // sim z = -three z
  if (Number.isFinite(g)) pose.pos.y = Math.max(pose.pos.y, g + raise);
  return pose;
}

/** Horizontal heading (rad, atan2(x, z) convention) of a THREE direction. */
export const headingOf = (d: ThreeV3): number => Math.atan2(d.x, d.z);

/**
 * Horizontal curvature magnitude (1/m) of the centre line at s, from the heading change between s - h and
 * s + h. Uses pointAt differences (robust even if tangentAt is coarse).
 */
export function curvatureAt(stage: Stage, s: number, h = 4): number {
  const clampS = (x: number) => (stage.closed ? x : Math.min(stage.length, Math.max(0, x)));
  const s0 = clampS(s - h);
  const s1 = clampS(s);
  const s2 = clampS(s + h);
  if (s2 - s0 < 1e-3 && !stage.closed) return 0;
  const a = stage.pointAt(s0);
  const b = stage.pointAt(s1);
  const c = stage.pointAt(s2);
  const h1 = Math.atan2(b.x - a.x, b.z - a.z);
  const h2 = Math.atan2(c.x - b.x, c.z - b.z);
  let dh = h2 - h1;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  const len = Math.hypot(b.x - a.x, b.z - a.z) * 0.5 + Math.hypot(c.x - b.x, c.z - b.z) * 0.5;
  return len > 1e-6 ? Math.abs(dh) / len : 0;
}
