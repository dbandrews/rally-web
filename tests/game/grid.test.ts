/**
 * tests/game/grid.test.ts — OWNED BY THE AI-RACE BUILDER. The multi-car start grid (src/game/grid.ts).
 *
 * 1. The original's placement loop (FUN_00484640, 0x4847e0-0x484cff) EXECUTED in unicorn (research/tools/grid_emu.py:
 *    220 random splines / spawnGrids / car counts, 546 slots, real x87 machine code for the vector maths) against
 *    gridSimPose: worst |Δpos| 4.8e-4 m (float32 ulp at 2000 m).
 * 2. All 48 ported stages x 1..4 cars: every slot on the road, no overlaps, behind the first row, inside the spline range.
 */
import { describe, expect, it } from 'vitest';
import { mirror } from '../../src/core/space';
import type { RoadSample, Stage, StageProjection, ThreeV3 } from '../../src/core/types';
import { gridSimPose, gridSlot, stageGrid, stageSpawnGrid, type SpawnGrid } from '../../src/game/grid';
import { wrapDelta } from '../../src/game/timing';
import { PORTED_ORDER } from '../../src/world/ports';
import { buildStage } from '../../src/world/stages';

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync(p: string, e: string): string };

type V3 = [number, number, number];
interface EmuCase {
  count: number;
  grid: V3;
  length: number;
  curve: [number, number, number, number];
  slots: { index: number; pos: V3; sCentre: number }[];
}

/** grid_emu.py's analytic test spline (sim space). */
function curve(s: number, k: EmuCase['curve']): V3 {
  const [a, b, c, h] = k;
  return [a * Math.sin(s / a) + b * Math.sin(s / (2.7 * b)), h * s + 3.0 * Math.sin(s / c), a * (1 - Math.cos(s / a)) + 0.5 * s];
}

/** A closed Stage over that curve (THREE space = the z mirror of the sim curve): only what simPoseOnStage / gridSimPose read. */
function curveStage(c: EmuCase): Stage {
  const L = c.length;
  const wrap = (s: number) => ((s % L) + L) % L;
  const pointAt = (s: number): ThreeV3 => {
    const p = curve(wrap(s), c.curve);
    return mirror({ x: p[0], y: p[1], z: p[2] });
  };
  return {
    closed: true,
    length: L,
    pointAt,
    tangentAt: (s: number) => {
      const a = pointAt(s);
      const b = pointAt(s + 0.1);
      const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
      return { x: (b.x - a.x) / d, y: (b.y - a.y) / d, z: (b.z - a.z) / d };
    },
  } as unknown as Stage;
}

describe('grid slots = the original placement loop executed in unicorn', () => {
  const fx = JSON.parse(fs.readFileSync('tests/game/fixtures/gridEmu.json', 'utf8')) as { cases: EmuCase[] };

  it('the fixture covers 1..4 cars, row wraps and 500+ slots', () => {
    expect(fx.cases.length).toBeGreaterThanOrEqual(200);
    const counts = new Set(fx.cases.map((c) => c.count));
    expect([...counts].sort()).toEqual([1, 2, 3, 4]);
    expect(fx.cases.reduce((n, c) => n + c.slots.length, 0)).toBeGreaterThanOrEqual(500);
    expect(fx.cases.some((c) => c.grid[0] < c.grid[2])).toBe(true); // s < spacing: the row wraps by +length
  });

  it('gridSimPose reproduces every executed slot (≤ 2 mm = float32 resolution at these magnitudes)', () => {
    let worst = 0;
    for (const c of fx.cases) {
      const stage = curveStage(c);
      for (const sl of c.slots) {
        let sCentre = c.grid[0] - Math.floor(sl.index / 2) * c.grid[2];
        if (sCentre < 0) sCentre += c.length;
        // the executed curve is not periodic: P(L) != P(0), so a heading taken across the seam (s + 1 m = L) cannot match
        if (Math.abs(sCentre + 1 - c.length) < 1e-3) continue;
        const pose = gridSimPose(stage, c.grid, sl.index, c.count, 0);
        const e = Math.max(Math.abs(pose.pos.x - sl.pos[0]), Math.abs(pose.pos.y - sl.pos[1]), Math.abs(pose.pos.z - sl.pos[2]));
        worst = Math.max(worst, e);
        expect(e, `case grid ${c.grid} count ${c.count} slot ${sl.index}`).toBeLessThan(2e-3);
        // the slot's centre-line distance is the original's s - floor(i/2)·spacing (+L)
        expect(gridSlot(c.grid, sl.index, c.count, stage).s).toBeCloseTo(sCentre, 4);
        expect(Math.abs(sCentre - sl.sCentre)).toBeLessThan(2e-3);
      }
    }
    expect(worst).toBeLessThan(2e-3);
  });
});

describe('gridSlot rules', () => {
  const g: SpawnGrid = [100, 2, 6];
  it('one car: the centre line; several: even slots left, odd right, a new row every second car', () => {
    expect(gridSlot(g, 0, 1)).toEqual({ s: 100, lateral: 0 });
    expect(gridSlot(g, 0, 4)).toEqual({ s: 100, lateral: -2 });
    expect(gridSlot(g, 1, 4)).toEqual({ s: 100, lateral: 2 });
    expect(gridSlot(g, 2, 4)).toEqual({ s: 94, lateral: -2 });
    expect(gridSlot(g, 3, 4)).toEqual({ s: 94, lateral: 2 });
  });
  it('the row wraps by the spline length on a circuit and clamps on an open stage', () => {
    expect(gridSlot([5, 1.5, 6], 2, 4, { closed: true, length: 1000 }).s).toBe(999);
    expect(gridSlot([5, 1.5, 6], 2, 4, { closed: false, length: 1000 }).s).toBe(0);
  });
});

describe('every ported stage, 1..4 cars', () => {
  const CAR_LEN = 4.4;
  const CAR_WID = 1.85;
  for (const id of PORTED_ORDER) {
    it(id, () => {
      const { stage } = buildStage(id, 1);
      const grid = stageSpawnGrid(stage)!;
      expect(grid, 'spawn grid').not.toBeNull();
      expect(stageGrid(stage, 8)).toEqual(grid);
      for (let count = 1; count <= 4; count++) {
        const slots = Array.from({ length: count }, (_, i) => gridSlot(grid, i, count, stage));
        const road: RoadSample[] = slots.map((sl) => stage.roadAt(sl.s));
        const proj: StageProjection[] = [];
        slots.forEach((sl, i) => {
          // on the road: |lateral| <= half the road width at the slot (the ported stages' narrowest: 6 m)
          expect(Math.abs(sl.lateral), `${id} ${count}/${i}`).toBeLessThanOrEqual(road[i].width / 2 - CAR_WID / 2);
          if (!stage.closed) {
            expect(sl.s).toBeGreaterThanOrEqual(stage.validRange[0] - 1e-9);
            expect(sl.s).toBeLessThanOrEqual(stage.validRange[1]);
          }
          const pose = gridSimPose(stage, grid, i, count, 0);
          const p = mirror(pose.pos);
          const pr = stage.project(p, sl.s);
          proj.push(pr);
          // the pose really is where the slot says (the projection finds the same s, lateral within the climb term)
          expect(Math.abs(pr.s - sl.s) < 1.5 || (stage.closed && Math.abs(Math.abs(pr.s - sl.s) - stage.length) < 1.5), `${id} slot ${i} s`).toBe(true);
          expect(Math.abs(pr.lateral - sl.lateral)).toBeLessThan(0.15);
        });
        // no overlaps: any two slots differ by a car length along the road or a car width across it
        for (let i = 0; i < count; i++) {
          for (let j = i + 1; j < count; j++) {
            const ds = Math.abs(slots[i].s - slots[j].s);
            const dl = Math.abs(slots[i].lateral - slots[j].lateral);
            expect(ds >= CAR_LEN || dl >= CAR_WID, `${id} ${count}: ${i}/${j}`).toBe(true);
          }
        }
        // the player (0) is on the front row; nobody is ahead of it
        for (let i = 1; i < count; i++) {
          const behind = stage.closed ? wrapDelta(slots[0].s - slots[i].s, stage.length) : slots[0].s - slots[i].s;
          expect(behind).toBeGreaterThanOrEqual(-1e-9);
        }
        if (count === 1) expect(slots[0].lateral).toBe(0);
      }
    });
  }
});
