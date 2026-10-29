/**
 * tests/world/ground.test.ts — WorldQuery (SIM space) correctness: raycast vs heightAt agreement, no
 * tunnelling, unit normals, underground origins, materials, obstacles, throughput.
 */
import { describe, expect, it } from 'vitest';
import { MATERIAL_SOLID_MIN, SURFACE_IDS } from '../../src/core/constants';
import { Rng } from '../../src/core/rng';
import type { BuiltStage, SimV3 } from '../../src/core/types';
import { buildStage, listStages } from '../../src/world/stages';

const built = new Map<string, BuiltStage>();
const get = (id: string): BuiltStage => {
  let b = built.get(id);
  if (!b) built.set(id, (b = buildStage(id, 3)));
  return b;
};

/** Random sim-space (x, z) inside the heightfield, half of them near the road. */
function randomPoint(b: BuiltStage, rng: Rng): { x: number; z: number } {
  const hf = b.stage.heightfield;
  if (rng.next() < 0.5) {
    const r = b.stage.road[Math.floor(rng.next() * b.stage.road.length)];
    const off = rng.range(-r.width, r.width);
    const t = b.stage.tangentAt(r.s);
    const l = Math.hypot(t.x, t.z) || 1;
    const x = r.pos.x + (-t.z / l) * off + rng.range(-1, 1);
    const z = r.pos.z + (t.x / l) * off + rng.range(-1, 1);
    return { x, z: -z };
  }
  const x = hf.originX + rng.next() * (hf.nx - 1) * hf.cellSize;
  const z = hf.originZ + rng.next() * (hf.nz - 1) * hf.cellSize;
  return { x, z: -z };
}

describe.each(listStages().map((s) => [s.id]))('ground %s', (id) => {
  it('vertical raycasts agree with heightAt everywhere (road and terrain)', () => {
    const { world } = get(id);
    const rng = new Rng(11);
    for (let i = 0; i < 3000; i++) {
      const p = randomPoint(get(id), rng);
      const h = world.heightAt(p.x, p.z);
      expect(Number.isFinite(h)).toBe(true);
      const hit = world.raycast({ x: p.x, y: h + 5, z: p.z }, { x: 0, y: -1, z: 0 }, 10);
      expect(hit).not.toBeNull();
      expect(Math.abs(hit!.dist - 5)).toBeLessThan(2e-3);
      expect(Math.abs(hit!.point.y - h)).toBeLessThan(2e-3);
      expect(hit!.material).toBe(world.materialAt(hit!.point.x, hit!.point.z));
    }
  });

  it('slanted rays land on the surface without tunnelling through it', () => {
    const { world } = get(id);
    const rng = new Rng(12);
    let hits = 0;
    for (let i = 0; i < 600; i++) {
      const p = randomPoint(get(id), rng);
      const h = world.heightAt(p.x, p.z);
      const o: SimV3 = { x: p.x, y: h + rng.range(0.3, 3), z: p.z };
      const a = rng.next() * Math.PI * 2;
      const down = rng.range(0.15, 1);
      const hor = Math.sqrt(1 - down * down);
      const d: SimV3 = { x: Math.cos(a) * hor, y: -down, z: Math.sin(a) * hor };
      const maxDist = 25;
      const hit = world.raycast(o, d, maxDist);
      const end = hit ? hit.dist : maxDist;
      const tol = 2e-3;
      // march the ray: it must stay above the ground before the reported hit
      for (let t = 0; t < end - 0.02; t += 0.05) {
        const q = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
        expect(q.y).toBeGreaterThan(world.heightAt(q.x, q.z) - tol);
      }
      if (hit) {
        hits++;
        const g = world.heightAt(hit.point.x, hit.point.z);
        if (Math.abs(hit.point.y - g) > 3e-3 || Math.abs(hit.normal.y) < 1e-9) {
          // kerb face under a ribbon edge: the hit is on the side of the road bed, below the ribbon
          expect(hit.point.y).toBeLessThan(g + 3e-3);
          const pr = get(id).stage.project({ x: hit.point.x, y: hit.point.y, z: -hit.point.z });
          expect(Math.abs(Math.abs(pr.lateral) - get(id).stage.roadAt(pr.s).width / 2)).toBeLessThan(0.05);
          // only shallow rays get the horizontal kerb normal; steep (wheel-like) rays get the road normal
          if (down >= 0.7) expect(hit.normal.y).toBeGreaterThan(0.8);
          else expect(Math.abs(hit.normal.y)).toBeLessThan(1e-9);
        }
        expect(Math.abs(hit.point.x - (o.x + d.x * hit.dist))).toBeLessThan(1e-6);
        expect(Math.abs(hit.point.z - (o.z + d.z * hit.dist))).toBeLessThan(1e-6);
      }
    }
    expect(hits).toBeGreaterThan(300);
  });

  it('returns unit, upward normals that match the local slope', () => {
    const { world } = get(id);
    const rng = new Rng(13);
    for (let i = 0; i < 1500; i++) {
      const p = randomPoint(get(id), rng);
      const n = world.normalAt(p.x, p.z);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
      expect(n.y).toBeGreaterThan(0.1); // cut faces can be near-vertical rock walls
      const hit = world.raycast({ x: p.x, y: world.heightAt(p.x, p.z) + 1, z: p.z }, { x: 0, y: -1, z: 0 }, 3)!;
      expect(Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z)).toBeCloseTo(1, 6);
      // the normal is perpendicular to tiny steps on the same facet (sim-space gradient check)
      const e = 0.01;
      const h0 = world.heightAt(p.x, p.z);
      const hx = world.heightAt(p.x + e, p.z);
      const hz = world.heightAt(p.x, p.z + e);
      const n2 = world.normalAt(p.x + e, p.z);
      const n3 = world.normalAt(p.x, p.z + e);
      const same = (a: SimV3, b: SimV3): boolean => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) < 1e-9;
      if (same(n, n2) && same(n, n3)) {
        expect(Math.abs(n.x * e + n.y * (hx - h0))).toBeLessThan(1e-6);
        expect(Math.abs(n.z * e + n.y * (hz - h0))).toBeLessThan(1e-6);
      }
    }
  });

  it('reports dist 0 for origins under the ground and null for misses', () => {
    const { world } = get(id);
    const rng = new Rng(14);
    for (let i = 0; i < 300; i++) {
      const p = randomPoint(get(id), rng);
      const h = world.heightAt(p.x, p.z);
      const hit = world.raycast({ x: p.x, y: h - 0.2, z: p.z }, { x: 0, y: -1, z: 0 }, 0.75);
      expect(hit).not.toBeNull();
      expect(hit!.dist).toBe(0);
      expect(hit!.normal.y).toBeGreaterThan(0);
      expect(world.raycast({ x: p.x, y: h + 2, z: p.z }, { x: 0, y: -1, z: 0 }, 1.5)).toBeNull();
      expect(world.raycast({ x: p.x, y: h + 2, z: p.z }, { x: 0, y: 1, z: 0 }, 50)).toBeNull();
    }
  });

  it('materials are ground surfaces and surfaceAt agrees', () => {
    const { world } = get(id);
    const rng = new Rng(15);
    for (let i = 0; i < 2000; i++) {
      const p = randomPoint(get(id), rng);
      const m = world.materialAt(p.x, p.z);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThan(SURFACE_IDS.length);
      expect(m < MATERIAL_SOLID_MIN).toBe(true);
      expect(world.surfaceAt(p.x, p.z)).toBe(SURFACE_IDS[m]);
    }
  });

  it('obstaclesNear matches a brute-force search', () => {
    const { stage, world } = get(id);
    const obs = stage.scenery.filter((s) => s.radius > 0);
    const rng = new Rng(16);
    const out: ReturnType<typeof world.obstaclesNear> = [];
    for (let i = 0; i < 200; i++) {
      const base = obs.length && rng.next() < 0.7 ? obs[Math.floor(rng.next() * obs.length)].pos : stage.road[Math.floor(rng.next() * stage.road.length)].pos;
      const p = { x: base.x + rng.range(-6, 6), y: base.y, z: -(base.z + rng.range(-6, 6)) };
      const r = rng.range(0.5, 6);
      const got = world.obstaclesNear(p, r, out);
      expect(got).toBe(out);
      const want = obs.filter((o) => Math.hypot(o.pos.x - p.x, -o.pos.z - p.z) < r + o.radius);
      expect(got.length).toBe(want.length);
      for (const o of got) {
        expect(Math.hypot(o.pos.x - p.x, o.pos.z - p.z)).toBeLessThan(r + o.radius);
        expect(o.radius).toBeGreaterThan(0);
      }
    }
  });

  it('casts at least 50k wheel-style rays per second', () => {
    const { stage, world } = get(id);
    const N = 40000;
    const pts: SimV3[] = [];
    const rng = new Rng(17);
    for (let i = 0; i < 512; i++) {
      const r = stage.road[Math.floor(rng.next() * stage.road.length)];
      const x = r.pos.x + rng.range(-3, 3);
      const z = -(r.pos.z + rng.range(-3, 3));
      pts.push({ x, y: world.heightAt(x, z) + 0.6, z });
    }
    const d = { x: 0.05, y: -0.998, z: 0.03 };
    let hits = 0;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) if (world.raycast(pts[i & 511], d, 0.75)) hits++;
    const dt = (performance.now() - t0) / 1000;
    expect(hits).toBeGreaterThan(N * 0.9);
    expect(N / dt).toBeGreaterThan(50000);
  });
});
