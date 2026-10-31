/**
 * src/game/ghosts/frame.ts — GHOSTS BUILDER. Coordinate frames between the ghost file's 9-float state and the port.
 *
 * A ghost state is what FUN_0049bf20 reads from the player car [E]: position = the car's world position, orientation =
 * the quaternion of the car's 4x4 matrix (row-vector D3D convention: the quaternion extraction reads (m21 - m12) / 4w etc.,
 * and FUN_0049bb90 rebuilds M = R(q) with the standard column formulas, so M's ROWS are the car's local axes in the
 * world), steer = the front steering angle in degrees, spin = wheel 0's rolling angle in degrees wrapped to +-180.
 *
 *   world frame = sim frame + (2048, H, 2048)         (Game.createTrack's H: 424 on most stages, docs/ASSETS.md §3)
 *   file quaternion q_f = conj(q_sim)                  (the port's quatSim is the column-convention rotation: R(q_sim) = M^T)
 *   three = sim with z negated; quat three = (w, x_f, y_f, -z_f) for q_f = (x_f, y_f, z_f, w)
 *   spin: the file's angle runs NEGATIVE while the car rolls forward [D: 160 vs 15 of the slow forward segments of the
 *         30 team ghosts]; the port's WheelVisual.spinAngle is + forward, so spin_file = -spinAngle (in degrees)
 *   steer: + = turning right in both [D: 84 % sign agreement with the heading change of the 30 team ghosts]
 *
 * Verified in tests/game/ghosts/frame.test.ts: all 30 team ghosts start on their stage's spawn grid, facing along the road,
 * and pass their split gates at their split times.
 */
import type { CarTelemetry, ThreeQuat, ThreeV3 } from '../../core/types';

export const WORLD_XZ = 2048;
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const f32 = Math.fround;

/**
 * H of a stage (Game.createTrack's third argument, tools/assets/lib/stages.py `height`): 424 by default; iceracing-1 24,
 * kenya 124, newzealand-1 100, newzealand-2/3 200, rallycross-1 10. Procedural and unknown stages use 0.
 */
export function stageWorldHeight(stageId: string): number {
  const m = /^(corsica|hillclimb|iceracing|kenya|newzealand|rallycross)-(\d)[abc]?-[fr]$/.exec(stageId);
  if (!m) return 0;
  const [, fam, n] = m;
  if (fam === 'iceracing' && n === '1') return 24;
  if (fam === 'kenya') return 124;
  if (fam === 'newzealand') return n === '1' ? 100 : 200;
  if (fam === 'rallycross' && n === '1') return 10;
  return 424;
}

/** Wrap an angle in degrees to [-180, 180]. */
export function wrapDeg(a: number): number {
  let v = a;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

/** Fill `out` (9 float32 values) from the player's telemetry: the state the exe's FUN_0049bf20 hands to the recorder. */
export function stateFromTelemetry(tel: Readonly<CarTelemetry>, height: number, out: Float32Array): void {
  const p = tel.posSim;
  const q = tel.quatSim;
  out[0] = p.x + WORLD_XZ;
  out[1] = p.y + height;
  out[2] = p.z + WORLD_XZ;
  out[3] = -q.x;
  out[4] = -q.y;
  out[5] = -q.z;
  out[6] = q.w;
  out[7] = Number.isFinite(tel.steerAngle) ? tel.steerAngle * DEG : 0;
  const spin = tel.wheels[0].visual.spinAngle;
  out[8] = Number.isFinite(spin) ? wrapDeg(-spin * DEG) : 0;
  for (let i = 0; i < 9; i++) if (!Number.isFinite(out[i])) out[i] = 0;
  if (out[3] === 0 && out[4] === 0 && out[5] === 0 && out[6] === 0) out[6] = f32(1);
}

/** The THREE-space pose of a playback state (the quaternion is normalised here, as the exe's consumer does). */
export interface GhostPose {
  pos: ThreeV3;
  quat: ThreeQuat;
  steerAngle: number;
  /** Rolling angle of the wheels, rad, + = rolling forward (WheelVisual.spinAngle). */
  spinAngle: number;
}

export function newGhostPose(): GhostPose {
  return { pos: { x: 0, y: 0, z: 0 }, quat: { w: 1, x: 0, y: 0, z: 0 }, steerAngle: 0, spinAngle: 0 };
}

/** Playback state (raw exe output, quaternion not normalised) -> THREE pose. False when the state is not finite. */
export function poseFromState(s: ArrayLike<number>, height: number, out: GhostPose): boolean {
  const n = Math.hypot(s[3], s[4], s[5], s[6]);
  if (!(n > 1e-9) || !Number.isFinite(n) || !Number.isFinite(s[0] + s[1] + s[2] + s[7] + s[8])) return false;
  out.pos.x = s[0] - WORLD_XZ;
  out.pos.y = s[1] - height;
  out.pos.z = -(s[2] - WORLD_XZ);
  out.quat.w = s[6] / n;
  out.quat.x = s[3] / n;
  out.quat.y = s[4] / n;
  out.quat.z = -s[5] / n;
  out.steerAngle = s[7] * RAD;
  out.spinAngle = -s[8] * RAD;
  return true;
}

export function copyPose(a: Readonly<GhostPose>, b: GhostPose): void {
  b.pos.x = a.pos.x;
  b.pos.y = a.pos.y;
  b.pos.z = a.pos.z;
  b.quat.w = a.quat.w;
  b.quat.x = a.quat.x;
  b.quat.y = a.quat.y;
  b.quat.z = a.quat.z;
  b.steerAngle = a.steerAngle;
  b.spinAngle = a.spinAngle;
}

/** Interpolate two render poses (position lerp, shorter-arc nlerp) by `t` in [0, 1] -> `out`. */
export function lerpPose(a: Readonly<GhostPose>, b: Readonly<GhostPose>, t: number, out: GhostPose): void {
  out.pos.x = a.pos.x + (b.pos.x - a.pos.x) * t;
  out.pos.y = a.pos.y + (b.pos.y - a.pos.y) * t;
  out.pos.z = a.pos.z + (b.pos.z - a.pos.z) * t;
  let bw = b.quat.w;
  let bx = b.quat.x;
  let by = b.quat.y;
  let bz = b.quat.z;
  if (a.quat.w * bw + a.quat.x * bx + a.quat.y * by + a.quat.z * bz < 0) {
    bw = -bw;
    bx = -bx;
    by = -by;
    bz = -bz;
  }
  const w = a.quat.w + (bw - a.quat.w) * t;
  const x = a.quat.x + (bx - a.quat.x) * t;
  const y = a.quat.y + (by - a.quat.y) * t;
  const z = a.quat.z + (bz - a.quat.z) * t;
  const l = Math.hypot(w, x, y, z) || 1;
  out.quat.w = w / l;
  out.quat.x = x / l;
  out.quat.y = y / l;
  out.quat.z = z / l;
  out.steerAngle = a.steerAngle + (b.steerAngle - a.steerAngle) * t;
  let ds = b.spinAngle - a.spinAngle;
  if (ds > Math.PI) ds -= 2 * Math.PI;
  else if (ds < -Math.PI) ds += 2 * Math.PI;
  out.spinAngle = a.spinAngle + ds * t;
}
