/**
 * src/core/space.ts — ARCHITECT-OWNED CONTRACT. Builders: import, do not edit.
 *
 * Sim space <-> Three.js space, docs/MECHANICS_SPEC.md §1.1.
 *
 *   SIM SPACE  (left-handed, = the original's frame): x = right, y = up, z = FORWARD.
 *              All physics (src/sim) and every WorldQuery call run in sim space.
 *   THREE SPACE (right-handed, Y-up, Three.js world). All rendering, the Stage geometry
 *              (spline, heightfield, road ribbon, scenery) and the cameras use Three space.
 *
 * The mirror M = diag(1, 1, -1) maps one to the other and is its own inverse:
 *
 *   | quantity                         | sim            | three                         |
 *   | world position / direction / n   | (x, y, z)      | (x, y, -z)                    |
 *   | car body axes                    | fwd = +z       | car object local fwd = -Z     |
 *   | orientation quaternion (w,x,y,z) | q              | (w, -x, -y, z)  [THREE.Quaternion(-q.x, -q.y, q.z, q.w)] |
 *   | heightfield query                | heightAt(x, z) | = threeHeight(x, -z)          |
 *
 * A car mesh must face -Z in its local frame (glTF assets face +Z: wrap them in a group rotated π about Y).
 * Body-frame (local) vectors map the same way: a sim body-frame point (x, y, z) is the three car-local
 * point (x, y, -z).
 *
 * This file has NO runtime dependency on three (type-only import), so the sim and vitest can use it.
 */
import type { Quaternion as ThreeQuaternion, Vector3 as ThreeVector3 } from 'three';
import type { Quat, V3 } from './math';

/** Documentation aliases. Both are plain {x,y,z}; the name says which space a value lives in. */
export type SimV3 = V3;
export type ThreeV3 = V3;
/** Quaternion in sim space (body -> world, §1.4 B.q). */
export type SimQuat = Quat;
/** Quaternion in Three space ({w,x,y,z} plain object; feed to THREE.Quaternion.set(x, y, z, w)). */
export type ThreeQuat = Quat;

/** Mirror a point / direction / normal / velocity (works both ways: M is its own inverse). */
export const mirror = (v: V3): V3 => ({ x: v.x, y: v.y, z: -v.z });
export const mirrorTo = (out: V3, v: V3): V3 => {
  out.x = v.x; out.y = v.y; out.z = -v.z;
  return out;
};

export const simToThreePos = mirror;
export const threeToSimPos = mirror;
export const simToThreeDir = mirror;
export const threeToSimDir = mirror;

/** Sim orientation -> Three orientation: (w, x, y, z) -> (w, -x, -y, z). Also maps three -> sim (involution). */
export const mirrorQuat = (q: Quat): Quat => ({ w: q.w, x: -q.x, y: -q.y, z: q.z });
export const simToThreeQuat = mirrorQuat;
export const threeToSimQuat = mirrorQuat;

/** Write a sim position/direction into a THREE.Vector3 (mirrored). */
export function setThreeVec(out: ThreeVector3, simV: V3): ThreeVector3 {
  return out.set(simV.x, simV.y, -simV.z);
}
/** Write a sim quaternion into a THREE.Quaternion (mirrored). */
export function setThreeQuat(out: ThreeQuaternion, simQ: Quat): ThreeQuaternion {
  return out.set(-simQ.x, -simQ.y, simQ.z, simQ.w);
}
/** Write an already-THREE-space plain quaternion into a THREE.Quaternion (no mirroring). */
export function applyThreeQuat(out: ThreeQuaternion, threeQ: Quat): ThreeQuaternion {
  return out.set(threeQ.x, threeQ.y, threeQ.z, threeQ.w);
}

/** Heading of a THREE-space horizontal direction as a THREE rotation.y such that an object facing -Z
 *  is rotated to face `dir`: rotY = atan2(-dir.x, -dir.z). */
export const threeYawFromDir = (dir: V3): number => Math.atan2(-dir.x, -dir.z);

/**
 * Wheel visual conventions in Three space (for the renderer; values come from WheelVisual, types.ts):
 *  - front-wheel steer: sim steerAngle + = turn right. In the three car-local frame (fwd -Z) a right turn is
 *    a NEGATIVE rotation about +Y:   wheelPivot.rotation.y = -steerAngle
 *  - wheel spin: spinAngle + = rolling forward. Rolling forward is a NEGATIVE rotation about +X:
 *    wheelMesh.rotation.x = -spinAngle
 */
export const THREE_WHEEL_CONVENTION = 'rotation.y = -steerAngle; rotation.x = -spinAngle' as const;
