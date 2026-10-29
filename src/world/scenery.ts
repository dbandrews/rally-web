/**
 * src/world/scenery.ts — scenery placement (THREE space) around the road: scattered forests / rocks /
 * cacti with collision radii, and lines of posts, snowbank lumps, tyre walls, gates and crowds.
 *
 * Rules: every instance with a collision radius keeps its cylinder ≥ `clear` (default 3 m) beyond the
 * nearest road edge, more on fast sections (`fastExtra` × fast factor). Non-colliding decoration stays
 * ≥ 0.6 m off the ribbon. Instances do not overlap (radius + spacing).
 *
 * Nominal sizes (scale = height / nominal): pine 14 m, tree 10 m, deadTree 8 m, bush 1.6 m, rock 1.2 m,
 * boulder 2.6 m, cactus 4 m, post/marker 1.2 m, sign 2 m, cone 0.5 m, snowbank 1 m (length 6 m),
 * tyreStack 1.0 m, hayBale 1.2 m, spectator 1.75 m, tent 3 m, house 7 m, barn 9 m, banner 2.5 m,
 * gates 6 m tall (scale = (road width + 4) / 12 across the road), pole 8 m, fence/barrier 1.1 m (4 m long),
 * grandstand 6 m.
 */
import type { Rng } from '../core/rng';
import type { SceneryInstance, SceneryKind } from '../core/types';
import type { Centerline } from './centerline';
import type { Ground } from './ground';

/**
 * Orientation conventions shared with the renderer's models (THREE rotation.y; a model's front faces local
 * -Z, linear props - fence, barrier, banner, snowbank, grandstand - have their long axis along local X):
 *
 *   alongRoadRotY: long axis along the road (tangent (hx, hz)), front facing the road from `side`
 *                  (+1 = prop right of travel, -1 = left).
 *   chevronRotY:   board across the road (local Z along travel) with local +X pointing to the right of
 *                  travel for a right-hander (turn = +1) or to the left (turn = -1), so chevron arrows
 *                  (+X) point into the bend as seen by the approaching driver.
 */
export function alongRoadRotY(hx: number, hz: number, side: number): number {
  return Math.atan2(-hz, hx) + (side < 0 ? Math.PI : 0);
}
export function chevronRotY(hx: number, hz: number, turn: number): number {
  return Math.atan2(-hx, -hz) + (turn < 0 ? Math.PI : 0);
}

export const NOMINAL_HEIGHT: Readonly<Record<SceneryKind, number>> = Object.freeze({
  tree: 10, pine: 14, deadTree: 8, bush: 1.6, rock: 1.2, boulder: 2.6, cactus: 4, post: 1.2, marker: 1.2,
  sign: 2, barrier: 1.1, fence: 1.1, tyreStack: 1.0, hayBale: 1.2, cone: 0.5, snowbank: 1, spectator: 1.75,
  tent: 3, house: 7, barn: 9, banner: 2.5, startGate: 6, checkpointGate: 6, finishGate: 6, pole: 8, grandstand: 6,
});

export interface KindSpec {
  kind: SceneryKind;
  w: number;
  /** Collision radius range (0 = decoration). */
  radius: [number, number];
  height: [number, number];
}

export interface ScatterRule {
  kinds: KindSpec[];
  /** Instances per 1000 m² at the inner edge of the band. */
  density: number;
  /** Edge-distance band (m beyond the road edge). */
  band: [number, number];
  /** Density multiplier at the outer edge of the band (linear in between). Default 1. */
  outer?: number;
  /** Extra gap between instances (m). Default 1. */
  spacing?: number;
  /** Min clearance of colliding cylinders from the road edge. Default 3. */
  clear?: number;
  /** Extra clearance on fast sections (× fast factor 0..1). Default 3. */
  fastExtra?: number;
  /** Max ground slope (rise per metre). Default 1.2. */
  maxSlope?: number;
  sRange?: [number, number];
  /** Only one side (+1 right / -1 left of travel) or a per-s chooser. */
  side?: number | ((s: number) => number);
  accept?: (x: number, z: number, s: number, side: number, e: number) => boolean;
}

export interface SceneryEnv {
  cl: Centerline;
  ground: Ground;
  /** Half width at s. */
  hwAt: (s: number) => number;
  /** 0..1, 1 = fast (open) section at s. */
  fastAt: (s: number) => number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Per heightfield vertex edge distance (approximate pre-filter), see terrainGen. */
  edgeDistApprox: (x: number, z: number) => number;
}

/** Spatial hash for non-overlap checks. */
class Hash {
  private readonly cell = 6;
  private readonly map = new Map<number, number[]>();
  readonly xs: number[] = [];
  readonly zs: number[] = [];
  readonly rs: number[] = [];
  private key(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }
  add(x: number, z: number, r: number): void {
    const i = this.xs.length;
    this.xs.push(x);
    this.zs.push(z);
    this.rs.push(r);
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let l = this.map.get(k);
    if (!l) this.map.set(k, (l = []));
    l.push(i);
  }
  free(x: number, z: number, r: number, gap: number): boolean {
    const reach = r + gap + 8; // largest radius we place is ~8 m
    const c0x = Math.floor((x - reach) / this.cell), c1x = Math.floor((x + reach) / this.cell);
    const c0z = Math.floor((z - reach) / this.cell), c1z = Math.floor((z + reach) / this.cell);
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        const l = this.map.get(this.key(cx, cz));
        if (!l) continue;
        for (const i of l) {
          const lim = r + this.rs[i] + gap;
          const dx = this.xs[i] - x, dz = this.zs[i] - z;
          if (dx * dx + dz * dz < lim * lim) return false;
        }
      }
    return true;
  }
}

export class SceneryPlacer {
  readonly out: SceneryInstance[] = [];
  private readonly hash = new Hash();
  private readonly env: SceneryEnv;
  private readonly rng: Rng;
  private readonly n3 = new Float64Array(3);

  constructor(env: SceneryEnv, rng: Rng) {
    this.env = env;
    this.rng = rng;
  }

  /**
   * Exact signed distance beyond the nearest road edge (global). Beyond the ends of an open stage the
   * lateral offset is used instead (the corridor straight ahead of the start / finish stays clear, which
   * is also what Stage.project() reports as the lateral there).
   */
  edgeDistance(x: number, z: number): number {
    const cl = this.env.cl;
    const nr = cl.nearest(x, z);
    let d = nr.dist;
    if (!cl.closed && (nr.s < 0.5 || nr.s > cl.length - 0.5)) d = Math.min(d, Math.abs(nr.lateral));
    return d - this.env.hwAt(nr.s);
  }

  /** Inside the straight-ahead corridor beyond an open stage's ends (cheap test on the end tangents). */
  private nearEnds(x: number, z: number, need: number): boolean {
    const cl = this.env.cl;
    if (cl.closed) return false;
    for (const i of [0, cl.n - 1]) {
      const dx = x - cl.x[i];
      const dz = z - cl.z[i];
      const along = (dx * cl.hx[i] + dz * cl.hz[i]) * (i === 0 ? -1 : 1);
      if (along <= 0) continue;
      const lat = Math.abs(dx * -cl.hz[i] + dz * cl.hx[i]);
      if (lat < this.env.hwAt(i * cl.ds) + need + 2) return true;
    }
    return false;
  }

  /** Place one instance if it passes the road clearance, bounds, slope and overlap checks. */
  tryPlace(
    kind: SceneryKind, x: number, z: number, radius: number, height: number, rotY: number,
    opts: {
      clear?: number; spacing?: number; maxSlope?: number; force?: boolean; visualR?: number;
      /** Decoration only: minimum distance beyond every road edge (default 0.6 m + visual radius). */
      minEdge?: number;
    } = {},
  ): boolean {
    const b = this.env.bounds;
    if (x < b.minX + 3 || x > b.maxX - 3 || z < b.minZ + 3 || z > b.maxZ - 3) return false;
    const vr = Math.max(radius, opts.visualR ?? (radius > 0 ? radius : 0.3));
    if (!opts.force) {
      const need = radius > 0 ? (opts.clear ?? 3) + radius : Math.max(0.6 + vr, opts.minEdge ?? 0);
      const approx = this.env.edgeDistApprox(x, z);
      if (!(approx > need + 6) || this.nearEnds(x, z, need)) {
        const e = this.edgeDistance(x, z);
        if (e < need) return false;
      }
      if (this.env.ground.onRoad(x, z)) return false;
      if (!this.hash.free(x, z, vr, opts.spacing ?? 0.8)) return false;
      if (opts.maxSlope !== undefined) {
        this.env.ground.terrain.normalAt(x, z, this.n3);
        const slope = Math.sqrt(Math.max(0, 1 - this.n3[1] * this.n3[1])) / Math.max(1e-6, this.n3[1]);
        if (slope > opts.maxSlope) return false;
      }
    }
    const y = this.env.ground.height(x, z);
    this.hash.add(x, z, vr);
    this.out.push({
      kind,
      pos: { x, y, z },
      rotY,
      scale: height / NOMINAL_HEIGHT[kind],
      radius,
      height,
    });
    return true;
  }

  private pickKind(kinds: readonly KindSpec[]): KindSpec {
    let tot = 0;
    for (const k of kinds) tot += k.w;
    let r = this.rng.next() * tot;
    for (const k of kinds) {
      r -= k.w;
      if (r <= 0) return k;
    }
    return kinds[kinds.length - 1];
  }

  /** Point at edge distance e on `side` of the road at s. */
  sidePoint(s: number, side: number, e: number): { x: number; z: number; hx: number; hz: number } {
    const cl = this.env.cl;
    const p = cl.pointAt(s);
    const hx = cl.sample(cl.hx, s);
    const hz = cl.sample(cl.hz, s);
    const l = Math.hypot(hx, hz) || 1;
    const rx = -hz / l, rz = hx / l;
    const off = this.env.hwAt(s) + e;
    return { x: p.x + rx * off * side, z: p.z + rz * off * side, hx: hx / l, hz: hz / l };
  }

  /** Random scatter in a band along the whole road. */
  scatter(rule: ScatterRule): void {
    const cl = this.env.cl;
    const [b0, b1] = rule.band;
    const outer = rule.outer ?? 1;
    const step = 8;
    const s0 = rule.sRange ? rule.sRange[0] : 0;
    const s1 = rule.sRange ? rule.sRange[1] : cl.length;
    const area = step * (b1 - b0);
    const expected = (rule.density / 1000) * area * (0.5 * (1 + outer));
    const maxW = Math.max(1, outer);
    for (let s = s0; s < s1; s += step) {
      for (const side of [-1, 1]) {
        if (rule.side !== undefined) {
          const want = typeof rule.side === 'function' ? rule.side(s) : rule.side;
          if (want !== 0 && want !== side) continue;
          if (want === 0) continue;
        }
        let count = Math.floor(expected);
        if (this.rng.next() < expected - count) count++;
        let placed = 0;
        for (let c = 0; c < count * 2 && placed < count; c++) {
          // rejection sampling of the linear density profile; up to 2× attempts per expected instance
          const u = this.rng.next();
          if (this.rng.next() * maxW > 1 + (outer - 1) * u) continue;
          const e = b0 + (b1 - b0) * u;
          const ss = s + this.rng.next() * step;
          if (ss > cl.length) continue;
          const k = this.pickKind(rule.kinds);
          const radius = k.radius[1] > 0 ? this.rng.range(k.radius[0], k.radius[1]) : 0;
          const height = this.rng.range(k.height[0], k.height[1]);
          const p = this.sidePoint(ss, side, e);
          if (rule.accept && !rule.accept(p.x, p.z, ss, side, e)) continue;
          const clear = (rule.clear ?? 3) + (rule.fastExtra ?? 3) * this.env.fastAt(ss);
          const rot = this.rng.next() * Math.PI * 2;
          if (this.tryPlace(k.kind, p.x, p.z, radius, height, rot, { clear, spacing: rule.spacing ?? 1, maxSlope: rule.maxSlope ?? 1.2 })) placed++;
        }
      }
    }
  }

  /** Regular line of instances along the road (posts, berm lumps, tyre walls, barriers). */
  line(o: {
    kind: SceneryKind; from: number; to: number; every: number; e: number; side: number | 'alternate';
    radius?: number; height: number; jitter?: number; clear?: number;
    /** Linear prop: long axis along the road, front facing it (alongRoadRotY). Else random rotation. */
    along?: boolean; force?: boolean;
  }): void {
    const cl = this.env.cl;
    let alt = 1;
    for (let s = o.from; s <= o.to; s += o.every) {
      const ss = cl.closed ? cl.normS(s) : s;
      if (!cl.closed && (ss < 0 || ss > cl.length)) continue;
      const sides = o.side === 'alternate' ? [(alt = -alt)] : [o.side];
      for (const side of sides) {
        const j = o.jitter ? (this.rng.next() - 0.5) * o.jitter : 0;
        const p = this.sidePoint(ss, side, o.e + j);
        if (!o.force && !this.belongsTo(p.x, p.z, ss, o.e + j)) continue;
        const rot = o.along ? alongRoadRotY(p.hx, p.hz, side) : this.rng.next() * Math.PI * 2;
        this.tryPlace(o.kind, p.x, p.z, o.radius ?? 0, o.height, rot, { clear: o.clear ?? 3, spacing: 0.05, force: o.force });
      }
    }
  }

  /**
   * Is (x, z) still closest to the centre line near s? False beyond the centre of a tight bend (an offset
   * larger than the bend radius on its inside) or when another section of the road is nearer: props of a
   * line placed there would stand beside the wrong part of the road, facing the wrong way.
   */
  belongsTo(x: number, z: number, s: number, e: number): boolean {
    const cl = this.env.cl;
    const nr = cl.nearest(x, z);
    let d = Math.abs(nr.s - s);
    if (cl.closed) d = Math.min(d, cl.length - d);
    return d <= Math.max(3, 0.35 * (e + this.env.hwAt(s)));
  }

  /** A crowd of spectators facing the road, at least `e0 - 2` m (≥ 5 m) beyond every road edge. */
  crowd(s: number, side: number, n: number, e0 = 9, e1 = 15): void {
    for (let i = 0; i < n * 3 && n > 0; i++) {
      const ss = s + (this.rng.next() - 0.5) * 30;
      const e = this.rng.range(e0, e1);
      const p = this.sidePoint(ss, side, e);
      const c = this.env.cl.pointAt(ss);
      const rot = Math.atan2(-(c.x - p.x), -(c.z - p.z));
      if (this.tryPlace('spectator', p.x, p.z, 0, this.rng.range(1.6, 1.9), rot, { spacing: 0.5, visualR: 0.35, minEdge: Math.max(5, e0 - 2) })) n--;
    }
  }

  /** Gate across the road (start / checkpoint / finish), decoration only. */
  gate(kind: 'startGate' | 'finishGate' | 'checkpointGate', s: number): void {
    const cl = this.env.cl;
    const p = cl.pointAt(s);
    const t = cl.tangentAt(s);
    const w = this.env.hwAt(s) * 2;
    this.out.push({ kind, pos: { x: p.x, y: p.y, z: p.z }, rotY: Math.atan2(-t.x, -t.z), scale: (w + 4) / 12, radius: 0, height: 6 });
  }
}
