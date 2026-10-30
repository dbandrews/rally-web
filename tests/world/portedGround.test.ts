/**
 * tests/world/portedGround.test.ts — the procedural world of the ported stages at a grade separation
 * (corsica 3: the road passes 8 m under itself, docs/orig/race.md §6): multi-level answers inside the
 * crossing zones only, the legacy single-valued ground everywhere else.
 */
import { describe, expect, it } from 'vitest';
import type { Stage, WorldQuery } from '../../src/core/types';
import { buildStage } from '../../src/world/stages';
import { PORTED_ORDER } from '../../src/world/ports';
import { origCentreFacts } from './portedBounds';

/** The lower and upper leg s of the stage's overpass with the largest drop (three space). */
function overpass(id: string): { sLow: number; sHigh: number } {
  const ops = origCentreFacts(id).overpasses;
  expect(ops.length).toBeGreaterThan(0);
  return ops.reduce((a, b) => (b.dy > a.dy ? b : a));
}

/** Sample of the lower leg near the overpass whose plan position is closest to the upper leg. */
function under(stage: Stage, sLow: number, sHigh: number): { s: number; xs: number; zs: number; y: number; deck: number } {
  let best = { d: Infinity, s: sLow };
  for (let a = sLow - 25; a <= sLow + 25; a += 0.5) {
    const p = stage.pointAt(a);
    for (let b = sHigh - 25; b <= sHigh + 25; b += 0.5) {
      const q = stage.pointAt(b);
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < best.d) best = { d, s: a };
    }
  }
  const p = stage.pointAt(best.s);
  let deck = -Infinity;
  for (let b = sHigh - 25; b <= sHigh + 25; b += 0.5) deck = Math.max(deck, stage.pointAt(b).y);
  return { s: best.s, xs: p.x, zs: -p.z, y: p.y, deck };
}

describe('ported grade separation (corsica-3-f overpass)', () => {
  const { stage, world } = buildStage('corsica-3-f', 1);
  const op = overpass('corsica-3-f');
  const u = under(stage, op.sLow, op.sHigh);

  it('point queries pick the level by yHint; no hint = the topmost (deck)', () => {
    expect(u.deck - u.y).toBeGreaterThan(5);
    const top = world.heightAt(u.xs, u.zs);
    expect(top).toBeGreaterThan(u.y + 5);
    expect(Math.abs(world.heightAt(u.xs, u.zs, u.y + 0.5) - u.y)).toBeLessThan(0.3);
    expect(Math.abs(world.heightAt(u.xs, u.zs, top + 0.5) - top)).toBeLessThan(1e-9);
    expect(world.normalAt(u.xs, u.zs, u.y + 0.5).y).toBeGreaterThan(0.9);
    expect(world.surfaceAt(u.xs, u.zs, u.y + 0.5)).not.toBeNull();
  });

  it('wheel rays under the deck hit the lower road (not "underground" against the deck)', () => {
    const o = { x: u.xs, y: u.y + 1.5, z: u.zs };
    const h = world.raycast(o, { x: 0, y: -1, z: 0 }, 3);
    expect(h).not.toBeNull();
    expect(Math.abs(h!.dist - 1.5)).toBeLessThan(0.3);
    const seg = world.segment(o, { x: 0, y: -3, z: 0 }, 0);
    expect(seg).not.toBeNull();
    expect(seg!.depth!).toBeLessThan(0);
    // a start just below the lower road is still underground (the original's d0 ≤ 0 miss)
    expect(world.segment({ x: u.xs, y: u.y - 0.3, z: u.zs }, { x: 0, y: -1, z: 0 })).toBeNull();
  });

  it('the deck hangs no kerb wall across the lower road: a level ray along it passes under the deck', () => {
    const a = stage.pointAt(u.s - 15);
    const b = stage.pointAt(u.s + 15);
    const y = u.y + 0.6;
    const o = { x: a.x, y, z: -a.z };
    const d = { x: b.x - a.x, y: 0, z: -(b.z - a.z) };
    const L = Math.hypot(d.x, d.z);
    const h = world.raycast(o, { x: d.x / L, y: 0, z: d.z / L }, L);
    // nothing hit, or only the lower road itself rising into the ray at the far end
    if (h) expect(h.dist).toBeGreaterThan(0.8 * L);
  });

  it('on the deck the deck is the ground', () => {
    const q = stage.pointAt(op.sHigh);
    const h = world.raycast({ x: q.x, y: q.y + 1.5, z: -q.z }, { x: 0, y: -1, z: 0 }, 3);
    expect(h).not.toBeNull();
    expect(Math.abs(h!.dist - 1.5)).toBeLessThan(0.3);
  });
});

describe('ported worlds without a grade separation are the single-valued ground', () => {
  it('yHint changes nothing away from crossings', () => {
    const ids = PORTED_ORDER.filter((id) => origCentreFacts(id).overpasses.length === 0).slice(0, 4);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const { stage, world } = buildStage(id, 1) as { stage: Stage; world: WorldQuery };
      for (let i = 0; i < stage.road.length; i += Math.max(1, Math.floor(stage.road.length / 40))) {
        const r = stage.road[i];
        const g = world.heightAt(r.pos.x, -r.pos.z);
        expect(world.heightAt(r.pos.x, -r.pos.z, g - 3)).toBe(g);
        expect(world.heightAt(r.pos.x, -r.pos.z, g + 20)).toBe(g);
      }
    }
  });
});
