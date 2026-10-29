/**
 * src/core/stageUtil.ts — ARCHITECT-OWNED CONTRACT. Builders: import, do not edit.
 *
 * Helpers that turn a stage-spline location into a sim-space car pose (§5.4 reset placement, race start,
 * test-API teleport). Used by main.ts, the race controller and tests.
 */
import { RESET_RAISE } from './constants';
import { cross, len, normalize, qLookSim, sub, type V3 } from './math';
import { mirror } from './space';
import type { SimPose, Stage, WorldQuery } from './types';

/** Raise used at race start (lands softly within the 100 settle steps). */
export const START_RAISE = 0.6;

/** Horizontal unit "right" vector (three space) for a three-space travel direction: cross(dir, up). */
export function rightOfThree(dir: V3): V3 {
  const r = cross({ x: dir.x, y: 0, z: dir.z }, { x: 0, y: 1, z: 0 });
  const l = len(r);
  return l > 1e-9 ? { x: r.x / l, y: 0, z: r.z / l } : { x: 1, y: 0, z: 0 };
}

/** Wrap / clamp s into the stage's range. */
export function normS(stage: Stage, s: number): number {
  if (stage.closed) {
    const L = stage.length;
    return ((s % L) + L) % L;
  }
  return Math.min(stage.length, Math.max(0, s));
}

/**
 * Sim-space pose at spline distance `s`, `lateral` metres to the right, body origin `raise` metres above the
 * road (§5.4: +1.5 m, heading toward the spline point 1 m further on, roll 0). If `world` is given the
 * height is max(spline height, ground height at the offset point) so lateral spawns never start underground.
 */
export function simPoseOnStage(stage: Stage, s: number, lateral = 0, raise = RESET_RAISE, world?: WorldQuery): SimPose {
  const s0 = normS(stage, s);
  let a = stage.pointAt(s0);
  let b: V3;
  if (stage.closed || s0 + 1 <= stage.length) b = stage.pointAt(normS(stage, s0 + 1));
  else {
    b = a;
    a = stage.pointAt(s0 - 1);
  }
  let dir = sub(b, a);
  if (len(dir) < 1e-6) dir = stage.tangentAt(s0);
  dir = normalize(dir);
  const right = rightOfThree(dir);
  const p = stage.pointAt(s0);
  const pos = { x: p.x + right.x * lateral, y: p.y, z: p.z + right.z * lateral };
  if (world) {
    const g = world.heightAt(pos.x, -pos.z); // sim z = -three z
    if (Number.isFinite(g)) pos.y = Math.max(pos.y, g);
  }
  pos.y += raise;
  return { pos: mirror(pos), q: qLookSim(mirror(dir)) };
}

/** Sim pose at the stage's start line. */
export function simStartPose(stage: Stage, world?: WorldQuery): SimPose {
  const d = normalize(stage.startPose.dir);
  const p = stage.startPose.pos;
  let y = p.y;
  if (world) {
    const g = world.heightAt(p.x, -p.z);
    if (Number.isFinite(g)) y = Math.max(y, g);
  }
  return { pos: mirror({ x: p.x, y: y + START_RAISE, z: p.z }), q: qLookSim(mirror(d)) };
}
