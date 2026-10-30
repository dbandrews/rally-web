/**
 * tests/sim/profileworld.ts — OWNED BY THE SIM BUILDER.
 *
 * A WorldQuery (SIM space) whose ground is a vertical profile y = h(z), uniform in x, for the §7 crest and
 * jump tests (T13-T15). Also a cylinder-obstacle world wrapper for collision tests.
 */
import { MATERIAL } from '../../src/core/constants';
import type { Obstacle, RayHit, SimV3, SurfaceId, WorldQuery } from '../../src/core/types';
import { segmentViaRaycast } from '../../src/core/worldQuery';

export interface Profile {
  /** Ground height at z. */
  h(z: number): number;
  /** dh/dz at z. */
  dh(z: number): number;
}

export interface ProfileWorld extends WorldQuery {
  readonly profile: Profile;
}

export function createProfileWorld(profile: Profile, surface: SurfaceId = 'tarmac', obstacles: Obstacle[] = []): ProfileWorld {
  const mat = MATERIAL[surface];
  const below = (x: number, y: number, z: number) => y - profile.h(z) <= 0;
  const normal = (z: number): SimV3 => {
    const s = profile.dh(z);
    const l = Math.hypot(1, s);
    return { x: 0, y: 1 / l, z: -s / l };
  };
  const world: ProfileWorld = {
    profile,
    raycast(o, d, maxDist): RayHit | null {
      if (below(o.x, o.y, o.z)) return { dist: 0, normal: normal(o.z), material: mat, point: { x: o.x, y: profile.h(o.z), z: o.z } };
      const stepLen = 0.02;
      let t0 = 0;
      for (let t = stepLen; t <= maxDist + 1e-9; t += stepLen) {
        const tt = Math.min(t, maxDist);
        if (below(o.x + d.x * tt, o.y + d.y * tt, o.z + d.z * tt)) {
          let a = t0;
          let b = tt;
          for (let k = 0; k < 30; k++) {
            const m = 0.5 * (a + b);
            if (below(o.x + d.x * m, o.y + d.y * m, o.z + d.z * m)) b = m;
            else a = m;
          }
          const p = { x: o.x + d.x * b, y: o.y + d.y * b, z: o.z + d.z * b };
          return { dist: b, normal: normal(p.z), material: mat, point: p };
        }
        t0 = tt;
      }
      return null;
    },
    segment: (o, ray, slot) => segmentViaRaycast(world, o, ray, slot),
    heightAt: (_x, z) => profile.h(z),
    normalAt: (_x, z) => normal(z),
    materialAt: () => mat,
    surfaceAt: () => surface,
    obstaclesNear(pos, r, out?: Obstacle[]) {
      const o = out ?? [];
      o.length = 0;
      for (const ob of obstacles) if (Math.hypot(ob.pos.x - pos.x, ob.pos.z - pos.z) <= r + ob.radius) o.push(ob);
      return o;
    },
  };
  return world;
}

/** Piecewise profile from segments; each segment covers [z0, z1) with its own h/dh. Before the first: flat at h(z0). */
interface Seg {
  z0: number;
  z1: number;
  h: (z: number) => number;
  dh: (z: number) => number;
}
function piecewise(segs: Seg[]): Profile {
  const first = segs[0];
  const last = segs[segs.length - 1];
  const find = (z: number) => segs.find((s) => z >= s.z0 && z < s.z1);
  return {
    h(z) {
      if (z < first.z0) return first.h(first.z0);
      const s = find(z);
      if (s) return s.h(z);
      // beyond: continue the last segment's slope
      return last.h(last.z1) + last.dh(last.z1) * (z - last.z1);
    },
    dh(z) {
      if (z < first.z0) return 0;
      const s = find(z);
      return s ? s.dh(z) : last.dh(last.z1);
    },
  };
}

/**
 * Alternative reading of the §7 T13/T14 crest (NOT used by the tests: the car never rises after take-off, so
 * T14's "rising" acceleration cannot be checked; see hillProfile): a flat plateau (y = 0) up to z = 0, then a
 * CONVEX vertical arc of radius R (40 m) spanning
 * `span` (15 m) of horizontal distance (it starts tangent to the flat and curves down), then a concave blend
 * (radius 20 m) into a 5 % downslope.
 */
export function crestProfile(R = 40, span = 15, downSlope = 0.05, blendR = 20): Profile {
  const arcH = (z: number) => -(R - Math.sqrt(R * R - z * z));
  const arcDh = (z: number) => -z / Math.sqrt(R * R - z * z);
  const s1 = arcDh(span); // slope at arc end (negative)
  const h1 = arcH(span);
  // concave blend: circle of radius blendR tangent to slope s1 at z=span, ending at slope -downSlope
  const a1 = Math.atan(s1);
  const a2 = Math.atan(-downSlope);
  // centre above the curve: for slope angle a, point on circle = c + blendR·(sin a, -cos a) in (z, y)
  const cz = span - blendR * Math.sin(a1);
  const cy = h1 + blendR * Math.cos(a1);
  const zB = cz + blendR * Math.sin(a2);
  const blendH = (z: number) => cy - Math.sqrt(Math.max(0, blendR * blendR - (z - cz) * (z - cz)));
  const blendDh = (z: number) => (z - cz) / Math.sqrt(Math.max(1e-9, blendR * blendR - (z - cz) * (z - cz)));
  const hB = blendH(zB);
  return piecewise([
    { z0: 0, z1: span, h: arcH, dh: arcDh },
    { z0: span, z1: zB, h: blendH, dh: blendDh },
    { z0: zB, z1: zB + 1000, h: (z) => hB - downSlope * (z - zB), dh: () => -downSlope },
  ]);
}

/**
 * §7 T15 ramp: flat (y = 0) to z = 0, concave blend (radius 30 m) up to a straight ramp at `deg` (10°)
 * that ends at z = zTop, then flat ground at the ramp-top height (sharp edge).
 */
export function rampProfile(deg = 10, rampLen = 8, blendR = 30): { profile: Profile; zTop: number; hTop: number } {
  const a = (deg * Math.PI) / 180;
  const zb = blendR * Math.sin(a); // blend horizontal span
  const hb = blendR * (1 - Math.cos(a));
  const blendH = (z: number) => blendR - Math.sqrt(blendR * blendR - z * z);
  const blendDh = (z: number) => z / Math.sqrt(blendR * blendR - z * z);
  const s = Math.tan(a);
  const zTop = zb + rampLen * Math.cos(a);
  const hTop = hb + rampLen * Math.sin(a);
  const profile = piecewise([
    { z0: 0, z1: zb, h: blendH, dh: blendDh },
    { z0: zb, z1: zTop, h: (z) => hb + s * (z - zb), dh: () => s },
    { z0: zTop, z1: zTop + 2000, h: () => hTop, dh: () => 0 },
  ]);
  return { profile, zTop, hTop };
}

export const flatProfile = (): Profile => ({ h: () => 0, dh: () => 0 });

/**
 * §7 T13/T14 crest, symmetric-hill reading: flat road (y = 0), a concave blend (radius blendR) up into a
 * CONVEX vertical arc of radius R spanning `span` m (apex in the middle, slopes ±tan(asin(span/2R)) at its
 * ends), then a concave blend into a `downSlope` (5 %) downslope. Starts at z = 0; the convex arc starts at
 * z = zArc0 and ends at z = zArc1 (returned).
 */
export function hillProfile(R = 40, span = 15, downSlope = 0.05, blendR = 40): { profile: Profile; zArc0: number; zArc1: number; zApex: number } {
  const a0 = Math.asin(span / 2 / R); // slope angle at the arc ends
  // 1) concave blend from slope 0 to +a0: circle centre (0, blendR)
  const z1 = blendR * Math.sin(a0);
  const h1 = blendR * (1 - Math.cos(a0));
  const b1H = (z: number) => blendR - Math.sqrt(blendR * blendR - z * z);
  const b1D = (z: number) => z / Math.sqrt(blendR * blendR - z * z);
  // 2) convex arc: centre below, at (zc, yc), tangent at z1 with angle a0
  const zc = z1 + R * Math.sin(a0);
  const yc = h1 - R * Math.cos(a0);
  const z2 = zc + R * Math.sin(a0);
  const arcH = (z: number) => yc + Math.sqrt(Math.max(0, R * R - (z - zc) * (z - zc)));
  const arcD = (z: number) => -(z - zc) / Math.sqrt(Math.max(1e-9, R * R - (z - zc) * (z - zc)));
  const h2 = arcH(z2);
  // 3) concave blend from angle -a0 to -atan(downSlope): centre above
  const a2 = -a0;
  const a3 = -Math.atan(downSlope);
  const cz = z2 - blendR * Math.sin(a2);
  const cy = h2 + blendR * Math.cos(a2);
  const z3 = cz + blendR * Math.sin(a3);
  const b3H = (z: number) => cy - Math.sqrt(Math.max(0, blendR * blendR - (z - cz) * (z - cz)));
  const b3D = (z: number) => (z - cz) / Math.sqrt(Math.max(1e-9, blendR * blendR - (z - cz) * (z - cz)));
  const h3 = b3H(z3);
  const profile = piecewise([
    { z0: 0, z1, h: b1H, dh: b1D },
    { z0: z1, z1: z2, h: arcH, dh: arcD },
    { z0: z2, z1: z3, h: b3H, dh: b3D },
    { z0: z3, z1: z3 + 2000, h: (z) => h3 - downSlope * (z - z3), dh: () => -downSlope },
  ]);
  return { profile, zArc0: z1, zArc1: z2, zApex: zc };
}
