/**
 * tests/sim/flatworld.ts — ARCHITECT-PROVIDED test helper (read-only for builders; add your own helpers
 * next to it instead of changing this API).
 *
 * The §7.1 harness world: an infinite plane, uniform material, SIM space. Default normal (0, 1, 0) at
 * y = 0. Optional tilt (for slope tests) and an optional material function for split-surface tests.
 *
 *   const world = createFlatWorld({ surface: 'gravel' });
 *   const car = new CarSim({ params: makeCarParams('awd_wrc', { tyreType: MATCHED_TYRE.gravel }), world });
 *   car.reset(flatSpawnPose());            // 100 settle steps (§1.2)
 */
import { MATERIAL, MATERIAL_SOLID_MIN, surfaceFromMaterial } from '../../src/core/constants';
import { dot, normalize, qIdentity, qYawSim } from '../../src/core/math';
import type { Obstacle, RayHit, SimPose, SimV3, SurfaceId, WorldQuery } from '../../src/core/types';
import { segmentViaRaycast } from '../../src/core/worldQuery';

export interface FlatWorldOptions {
  /** Uniform surface (default 'tarmac'). Ignored if `materialAt` is given. */
  surface?: SurfaceId;
  /** Raw material id override (e.g. 32 = non-ground solid). */
  material?: number;
  /** Per-point material (sim x, z) for split-surface tests. */
  materialAt?: (x: number, z: number) => number;
  /** Plane height at the origin (sim y). Default 0. */
  height?: number;
  /** Plane normal (sim space; normalised). Default (0, 1, 0). */
  normal?: SimV3;
}

export interface FlatWorld extends WorldQuery {
  readonly normal: SimV3;
  readonly height: number;
  /** Number of raycast() calls so far (perf / sanity checks). */
  rayCount: number;
}

export function createFlatWorld(opts: FlatWorldOptions = {}): FlatWorld {
  const n = normalize(opts.normal ?? { x: 0, y: 1, z: 0 });
  if (n.y <= 0.05) throw new Error('flatworld: normal must point up');
  const h = opts.height ?? 0;
  const fixed = opts.material ?? MATERIAL[opts.surface ?? 'tarmac'];
  const matAt = opts.materialAt ?? (() => fixed);
  // plane: dot(n, p - (0, h, 0)) = 0  ->  y(x, z) = h - (n.x·x + n.z·z) / n.y
  const heightAt = (x: number, z: number) => h - (n.x * x + n.z * z) / n.y;
  const world: FlatWorld = {
    normal: n,
    height: h,
    rayCount: 0,
    raycast(o, d, maxDist): RayHit | null {
      world.rayCount++;
      const side = dot(n, { x: o.x, y: o.y - h, z: o.z }); // > 0 above the plane
      const material = matAt(o.x, o.z);
      if (side <= 0) {
        return { dist: 0, normal: { ...n }, material, point: { x: o.x, y: heightAt(o.x, o.z), z: o.z } };
      }
      const denom = dot(n, d);
      if (denom >= 0) return null;
      const t = -side / denom;
      if (t > maxDist) return null;
      const p = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
      return { dist: t, normal: { ...n }, material: matAt(p.x, p.z), point: p };
    },
    // the original's segment query (start below the plane = miss, one-sided), via the shared adapter
    segment: (o, ray, slot) => segmentViaRaycast(world, o, ray, slot),
    heightAt,
    normalAt: () => ({ ...n }),
    materialAt: (x, z) => matAt(x, z),
    surfaceAt: (x, z) => {
      const m = matAt(x, z);
      return m < MATERIAL_SOLID_MIN ? surfaceFromMaterial(m) : null;
    },
    obstaclesNear: (_p, _r, out?: Obstacle[]) => {
      const o = out ?? [];
      o.length = 0;
      return o;
    },
  };
  return world;
}

/**
 * Spawn pose for the harness: body origin `raise` m above the plane at (x, z), heading `heading` rad
 * (0 = +z forward, + = toward +x / right). Default raise 0.6 m: wheels touch within the settle steps.
 */
export function flatSpawnPose(world: WorldQuery = createFlatWorld(), x = 0, z = 0, heading = 0, raise = 0.6): SimPose {
  return { pos: { x, y: world.heightAt(x, z) + raise, z }, q: heading === 0 ? qIdentity() : qYawSim(heading) };
}
