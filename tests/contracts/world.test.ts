/**
 * tests/contracts/world.test.ts — ARCHITECT-OWNED cross-module contract for src/world.
 * Every stage in listStages() must satisfy these (they guard the THREE-space Stage vs SIM-space
 * WorldQuery agreement that the sim, renderer and race controller all rely on).
 */
import { describe, expect, it } from 'vitest';
import { MATERIAL, SURFACE_IDS, SURFACE_ORIG_ID } from '../../src/core/constants';
import { len } from '../../src/core/math';
import { simPoseOnStage, simStartPose } from '../../src/core/stageUtil';
import { buildStage, listStages } from '../../src/world/stages';
import { jsonSafetyIssue } from '../helpers/json';

const stages = listStages();

describe('world catalogue', () => {
  it("has a 'testpad' stage and unique ids", () => {
    expect(stages.some((s) => s.id === 'testpad')).toBe(true);
    expect(new Set(stages.map((s) => s.id)).size).toBe(stages.length);
    expect(jsonSafetyIssue(stages)).toBeNull();
  });
  it('throws on unknown ids', () => {
    expect(() => buildStage('no-such-stage', 1)).toThrow();
  });
});

describe.each(stages.map((s) => [s.id, s] as const))('stage %s', (id, entry) => {
  const { stage, world } = buildStage(id, 7);

  it('matches its catalogue entry and is deterministic for (id, seed)', () => {
    expect(stage.id).toBe(id);
    expect(stage.discipline).toBe(entry.discipline);
    expect(stage.closed).toBe(entry.closed);
    expect(stage.length).toBeGreaterThan(0);
    const again = buildStage(id, 7).stage;
    expect(again.road.length).toBe(stage.road.length);
    expect(again.road[again.road.length >> 1].pos).toEqual(stage.road[stage.road.length >> 1].pos);
    expect(again.scenery.length).toBe(stage.scenery.length);
    expect(again.heightfield.heights.length).toBe(stage.heightfield.heights.length);
  });

  it('has consistent heightfield and road data', () => {
    const hf = stage.heightfield;
    expect(hf.cellSize).toBeGreaterThan(0);
    expect(hf.heights.length).toBe(hf.nx * hf.nz);
    expect(hf.materials.length).toBe(hf.nx * hf.nz);
    expect(stage.road.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < stage.road.length; i++) expect(stage.road[i].s).toBeGreaterThanOrEqual(stage.road[i - 1].s);
    for (const r of stage.road) {
      expect(SURFACE_IDS).toContain(r.surface);
      expect(r.width).toBeGreaterThan(2);
    }
  });

  it('spline API is self-consistent (pointAt / tangentAt / project)', () => {
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const s = (stage.length * i) / N;
      const p = stage.pointAt(s);
      const t = stage.tangentAt(s);
      expect(len(t)).toBeCloseTo(1, 3);
      const pr = stage.project(p, s);
      const ds = stage.closed ? Math.min(Math.abs(pr.s - s), stage.length - Math.abs(pr.s - s)) : Math.abs(pr.s - s);
      expect(ds).toBeLessThan(2);
      expect(Math.abs(pr.lateral)).toBeLessThan(0.5);
      // lateral sign: a point to the right of travel (cross(t, up) in three space) is positive
      const right = { x: -t.z, y: 0, z: t.x };
      const rl = Math.hypot(right.x, right.z) || 1;
      const q = { x: p.x + (right.x / rl) * 3, y: p.y, z: p.z + (right.z / rl) * 3 };
      expect(stage.project(q, s).lateral).toBeGreaterThan(2);
    }
  });

  it('WorldQuery (sim space) agrees with the Stage road (three space)', () => {
    const step = Math.max(1, Math.floor(stage.road.length / 60));
    for (let i = 0; i < stage.road.length; i += step) {
      const r = stage.road[i];
      const xs = r.pos.x, zs = -r.pos.z; // three -> sim
      expect(Math.abs(world.heightAt(xs, zs) - r.pos.y)).toBeLessThan(0.25);
      const hit = world.raycast({ x: xs, y: r.pos.y + 2, z: zs }, { x: 0, y: -1, z: 0 }, 5);
      expect(hit).not.toBeNull();
      expect(Math.abs(hit!.dist - 2)).toBeLessThan(0.3);
      expect(hit!.material).toBe(MATERIAL[r.surface]);
      expect(hit!.normal.y).toBeGreaterThan(0.5);
      expect(world.surfaceAt(xs, zs)).toBe(r.surface);
      // segment(): the original's query (full segment vector, every RayHit field filled)
      const seg = world.segment({ x: xs, y: r.pos.y + 2, z: zs }, { x: 0, y: -5, z: 0 }, 0);
      expect(seg).not.toBeNull();
      expect(Math.abs(seg!.dist - hit!.dist)).toBeLessThan(1e-6);
      expect(seg!.t).toBeCloseTo(seg!.dist / 5, 9);
      expect(seg!.cos).toBeCloseTo(-5 * seg!.normal.y, 9);
      expect(seg!.depth).toBeCloseTo(-(5 - seg!.dist) * seg!.normal.y, 6);
      expect(seg!.material).toBe(MATERIAL[r.surface]);
      expect(seg!.origMaterial).toBe(SURFACE_ORIG_ID[r.surface]);
      // one-sided, start strictly above the plane: a start below the ground or an upward segment misses
      const g = world.heightAt(xs, zs);
      expect(world.segment({ x: xs, y: g - 0.5, z: zs }, { x: 0, y: -1, z: 0 })).toBeNull();
      expect(world.segment({ x: xs, y: g - 0.5, z: zs }, { x: 0, y: 2, z: 0 }, -1)).toBeNull();
      // segment too short to reach the ground: miss
      expect(world.segment({ x: xs, y: g + 2, z: zs }, { x: 0, y: -1, z: 0 })).toBeNull();
      // yHint is accepted (procedural worlds are single-valued: same answer)
      expect(world.heightAt(xs, zs, g)).toBe(g);
    }
  });

  it('start, checkpoints, finish and pacenotes are well formed', () => {
    const [lo, hi] = stage.validRange;
    const sp = stage.project(stage.startPose.pos);
    // the range minimum may lie past the start line (a ported archive's splineRange verbatim, corsica-2-f 550 vs
    // trigger 0 at 545) as long as the car waiting at its spawn pose is inside the range
    if (lo > stage.startS) {
      expect(sp.s).toBeGreaterThanOrEqual(lo);
      expect(sp.s).toBeLessThanOrEqual(hi);
    }
    expect(stage.startS).toBeLessThanOrEqual(hi);
    for (let i = 1; i < stage.checkpoints.length; i++) expect(stage.checkpoints[i]).toBeGreaterThan(stage.checkpoints[i - 1]);
    for (const c of stage.checkpoints) expect(c).toBeGreaterThanOrEqual(lo);
    expect(stage.finishS).toBeLessThanOrEqual(hi);
    expect(Math.abs(sp.lateral)).toBeLessThan(stage.roadAt(sp.s).width / 2);
    for (let i = 1; i < stage.pacenotes.length; i++) expect(stage.pacenotes[i].s).toBeGreaterThanOrEqual(stage.pacenotes[i - 1].s);
    if (stage.discipline === 'rallycross' || stage.discipline === 'ice') expect(stage.pacenotes.length).toBe(0);
    const pose = simStartPose(stage, world);
    const reset = simPoseOnStage(stage, stage.startS + 10, 0, 1.5, world);
    for (const v of [pose.pos, reset.pos]) expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
    // start pose is above the ground
    expect(pose.pos.y).toBeGreaterThan(world.heightAt(pose.pos.x, pose.pos.z));
  });

  it('keeps colliding scenery off the road', () => {
    for (const sc of stage.scenery) {
      if (sc.radius <= 0) continue;
      const pr = stage.project(sc.pos);
      const half = stage.roadAt(pr.s).width / 2;
      expect(Math.abs(pr.lateral) + 1e-6).toBeGreaterThan(half);
    }
  });
});
