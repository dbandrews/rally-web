/**
 * src/game/grid.ts — OWNED BY THE AI-RACE BUILDER (phase 2, docs/PHASE2_AI.md). Start-grid slots of a multi-car race.
 *
 * The original's placement loop (FUN_00484640, loop 0x4847e0-0x484cff, docs/orig/race.md §1 "multi-car grid") creates one
 * SpawnPoint per participant (ghosts excluded) from race.spawnGrid {s, lateral, spacing}:
 *   car i stands on the centre spline at  s_i = s - floor(i / 2) · spacing   (+ spline length when that goes below 0),
 *   heading to the spline point s_i + 1 m (the same heading as the solo start), displaced by  ± lateral · T,  where
 *   T = (d.z, d.y, -d.x) is the unit "right" of the travel direction d (sim space; it keeps the climb term d.y) and the sign
 *   is  −  for even i (the LEFT column) and  +  for odd i (the RIGHT column). With one car there is no displacement.
 * [E] executed: research/tools/grid_emu.py runs the real machine code in unicorn (220 random splines/grids, 546 slots,
 * worst |Δpos| 4.8e-4 m = float32 ulp at 2000 m) and tests/game/grid.test.ts replays the fixture through this file.
 * Index 0 is the first participant record (race+0x118): the human player (the player list is built first, FUN_00488590
 * 0x488795-0x4887fd), so the player stands on the LEFT column of the FRONT row [I: record order = grid index].
 * Used by RaceController.gridPose (the player: gridIndex 0) and CarField.begin (the AI cars).
 */
import { mirror } from '../core/space';
import { len, normalize, sub, type V3 } from '../core/math';
import { normS, simPoseOnStage } from '../core/stageUtil';
import type { SimPose, Stage, WorldQuery } from '../core/types';

/** race.spawnGrid verbatim: [s, column lateral offset, row spacing] (m). */
export type SpawnGrid = readonly [number, number, number];

export interface GridSlot {
  /** Spline distance (m, the stage's 3-D arc length) of the slot. */
  s: number;
  /** Signed lateral offset from the centre line (m, + right): −lateral on even slots, +lateral on odd ones, 0 solo. */
  lateral: number;
}

/** The stage's race.spawnGrid (ported stages carry it, world/portedBuilder.ts withSpawn); null on procedural stages. */
export function stageSpawnGrid(stage: Stage): SpawnGrid | null {
  const g = (stage as Stage & { spawnGrid?: SpawnGrid }).spawnGrid;
  return g && g.length === 3 && g.every(Number.isFinite) ? g : null;
}

/** The grid of any stage: the ported archive's race.spawnGrid, else a synthetic one `startGridBack` m behind the start
 *  line (procedural stages: [s, 2, 6], the ported stages' typical column offset / row spacing). */
export function stageGrid(stage: Stage, startGridBack: number): SpawnGrid {
  const g = stageSpawnGrid(stage);
  if (g) return g;
  const L = stage.length;
  const s0 = stage.closed ? (((stage.startS - startGridBack) % L) + L) % L : Math.max(0, stage.startS - startGridBack);
  return [s0, 2, 6];
}

/**
 * Slot of car `index` (0 = the player) of `count` cars on `grid` [E 0x4847e0-0x484cff]. `stage` supplies the spline length
 * for the original's `if (s < 0) s += length` row wrap; an open stage clamps at 0 instead [I: the original adds the
 * length on open splines too, which would put the row at the finish; no ported stage starts within one row spacing of 0
 * (grid test), the one spawn below 6 m is the closed iceracing-2-f].
 */
export function gridSlot(grid: SpawnGrid, index: number, count: number, stage?: Pick<Stage, 'closed' | 'length'>): GridSlot {
  const [s0, lateral, spacing] = grid;
  if (count <= 1) return { s: s0, lateral: 0 };
  const i = Math.max(0, Math.floor(index));
  let s = s0 - Math.floor(i / 2) * spacing;
  if (s < 0) s = stage ? (stage.closed ? s + stage.length : 0) : s;
  return { s, lateral: i % 2 === 0 ? -lateral : lateral };
}

const T_OUT: V3 = { x: 0, y: 0, z: 0 };

/**
 * Sim-space start pose of grid slot `index` of `count`: the solo start pose at the slot's spline distance (heading to
 * s + 1 m, `raise` above the road) moved sideways by `lateral · T` where T keeps the original's climb term (see header):
 * horizontal part `lateral · cos(pitch)`, vertical part `lateral · d.y`. The ground lift (liftAboveGround) is the
 * caller's, exactly as for the solo start.
 */
export function gridSimPose(stage: Stage, grid: SpawnGrid, index: number, count: number, raise: number, world?: WorldQuery): SimPose {
  const slot = gridSlot(grid, index, count, stage);
  const pose = simPoseOnStage(stage, slot.s, 0, raise, world);
  if (slot.lateral === 0) return pose;
  const s0 = normS(stage, slot.s);
  // the travel direction exactly as simPoseOnStage takes it (three space), then the original's T in sim space
  let a = stage.pointAt(s0);
  let b: V3;
  if (stage.closed || s0 + 1 <= stage.length) b = stage.pointAt(normS(stage, s0 + 1));
  else {
    b = a;
    a = stage.pointAt(s0 - 1);
  }
  let d = sub(b, a);
  if (len(d) < 1e-6) d = stage.tangentAt(s0);
  d = normalize(d);
  // three → sim is the z mirror: d_sim = (dx, dy, -dz); T_sim = (d_sim.z, d_sim.y, -d_sim.x)
  const ts = mirror(d);
  T_OUT.x = ts.z;
  T_OUT.y = ts.y;
  T_OUT.z = -ts.x;
  pose.pos.x += slot.lateral * T_OUT.x;
  pose.pos.y += slot.lateral * T_OUT.y;
  pose.pos.z += slot.lateral * T_OUT.z;
  return pose;
}
