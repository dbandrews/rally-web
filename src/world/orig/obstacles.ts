/**
 * src/world/orig/obstacles.ts — object collision proxies of a ported stage (research/formats/objects.md §7.3 /
 * §8, built by tools/assets/parts/collision.py from Objects.con + the object library, SIM space).
 *
 * Three classes of placed object collide in the original:
 *   - HARD: static objects whose mesh carries a CollisionMesh.Simple (trees, rocks, signs, walls / curb
 *     barriers, spectator boxes). A compact footprint (aspect ≤ 1.25, half ≤ 6 m) is one vertical cylinder of its
 *     larger half extent; every other footprint above 0.6 m (fence panels, barriers, boards, curb walls, gantries, houses)
 *     a chain of 0.3 m cylinders along the mesh's footprint, each with its own y span (cars pass under walkway
 *     bridges). On RCOL v2 worlds the car collides with the objects' own meshes (objectMeshes.ts, the original's
 *     object pass in src/sim/car.ts) and these cylinders are hints only (the autopilot's avoidance).
 *   - DYNAMIC: PhyObjects (cones, plastic road walls, sign boards, barrels): light bodies with a `.col` hull
 *     and a mass that the original knocks over. Kept with their hull points (sim space) but NOT returned by
 *     obstaclesNear: an immovable cylinder would stop the car dead at a 10 kg cone (docs/orig/collision.md).
 *   - SOFT: `hasCollision 1` without collision geometry (bushes): no hard hit in the original; informational.
 * WorldQuery.obstaclesNear returns the HARD cylinders only (the Obstacle contract: vertical cylinders).
 */
import type { Obstacle, SceneryKind, SimV3 } from '../../core/types';
import { OBST, OBST_DYNAMIC, OBST_HARD, OBST_SOFT, type RcolData } from './rcol';

/** An obstacle proxy with the original data behind it (extra fields beyond the Obstacle contract). */
export interface OrigObstacle extends Obstacle {
  /** OBST_HARD | OBST_DYNAMIC | OBST_SOFT. */
  flags: number;
  /** ObjectTemplate.collisionMaterial (6 = wood) or −1. */
  material: number;
  /** part_mass (kg) of a dynamic part, 0 for static objects. */
  mass: number;
  /** Placement index in Objects.con order (shared key with the objects render part). */
  object: number;
  /** 0 = one cylinder for the object, 1 = one link of a chain. */
  shape: number;
  /** Object yaw (rad, sim). */
  yaw: number;
  /** Dynamic parts: the .col hull points, sim space (xyz triples); empty otherwise. */
  hull: Float32Array;
}

const CELL = 16;
/** Proxies farther than this from the sim origin are never indexed (the build already drops editor debris). */
const FAR = 1e6;

/**
 * A spatial hash of proxies (anything with a centre `pos` and a `radius`) over 16 m xz cells (objects.md §8: "a
 * uniform 2-D grid … 16 m works"); `near` returns the items whose circle comes within r of (x, z). Hashed
 * rather than a dense bbox grid so that stray coordinates cannot blow up the allocation; each item keeps its
 * cell so a query never returns an item twice when two of its cells share a bucket.
 */
export class ProxyGrid<T extends { pos: SimV3; radius: number } = OrigObstacle> {
  readonly list: T[];
  private readonly mask: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly cellX: Int32Array;
  private readonly cellZ: Int32Array;
  private readonly maxR: number;

  constructor(all: T[]) {
    const list = all.filter((o) => Math.abs(o.pos.x) < FAR && Math.abs(o.pos.z) < FAR);
    this.list = list;
    let maxR = 0;
    for (const o of list) maxR = Math.max(maxR, o.radius);
    this.maxR = maxR;
    let size = 16;
    while (size < 2 * list.length) size *= 2;
    this.mask = size - 1;
    const n = list.length;
    this.cellX = new Int32Array(n);
    this.cellZ = new Int32Array(n);
    const bucket = new Int32Array(n);
    const counts = new Int32Array(size + 1);
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(list[i].pos.x / CELL), cz = Math.floor(list[i].pos.z / CELL);
      this.cellX[i] = cx;
      this.cellZ[i] = cz;
      bucket[i] = this.hash(cx, cz);
      counts[bucket[i] + 1]++;
    }
    for (let b = 0; b < size; b++) counts[b + 1] += counts[b];
    const fill = counts.slice(0, size);
    const items = new Int32Array(n);
    for (let i = 0; i < n; i++) items[fill[bucket[i]]++] = i;
    this.start = counts;
    this.items = items;
  }

  private hash(cx: number, cz: number): number {
    return ((Math.imul(cx, 0x9e3779b1) ^ Math.imul(cz, 0x85ebca77)) >>> 0) & this.mask;
  }

  near<U = Obstacle>(x: number, z: number, r: number, out: U[]): U[] {
    out.length = 0;
    if (!this.list.length || !(Math.abs(x) < FAR && Math.abs(z) < FAR) || !(r >= 0)) return out;
    const reach = Math.min(r + this.maxR, 4096);
    const cx0 = Math.floor((x - reach) / CELL), cx1 = Math.floor((x + reach) / CELL);
    const cz0 = Math.floor((z - reach) / CELL), cz1 = Math.floor((z + reach) / CELL);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const b = this.hash(cx, cz);
        for (let q = this.start[b]; q < this.start[b + 1]; q++) {
          const i = this.items[q];
          if (this.cellX[i] !== cx || this.cellZ[i] !== cz) continue; // another cell in the same bucket
          const o = this.list[i];
          const lim = r + o.radius;
          const dx = o.pos.x - x, dz = o.pos.z - z;
          if (dx * dx + dz * dz < lim * lim) out.push(o as unknown as U);
        }
      }
    }
    return out;
  }
}

/** The stage's proxies: hard (obstaclesNear), dynamic parts and soft bushes. */
export class OrigObstacles {
  readonly hard: ProxyGrid;
  readonly dynamic: ProxyGrid;
  readonly soft: ProxyGrid;

  /** `mirrorZ`: serve the proxies z-mirrored (OrigWorld's stage-frame workaround, see world.ts). */
  constructor(d: RcolData, kinds: readonly string[], mirrorZ = false) {
    const hard: OrigObstacle[] = [], dyn: OrigObstacle[] = [], soft: OrigObstacle[] = [];
    const s = d.obstStride, A = d.obst;
    const zs = mirrorZ ? -1 : 1;
    for (let k = 0; k < d.nObst; k++) {
      const b = k * s;
      const flags = A[b + OBST.FLAGS];
      const h0 = A[b + OBST.HULL0], hn = A[b + OBST.HULLN];
      let hull = hn > 0 ? d.hull.subarray(3 * h0, 3 * (h0 + hn)) : EMPTY;
      if (mirrorZ && hn > 0) {
        hull = hull.slice();
        for (let i = 2; i < hull.length; i += 3) hull[i] = -hull[i];
      }
      const o: OrigObstacle = {
        kind: (kinds[A[b + OBST.KIND]] ?? 'barrier') as SceneryKind,
        pos: { x: A[b + OBST.X], y: A[b + OBST.Y], z: zs * A[b + OBST.Z] },
        radius: A[b + OBST.RADIUS],
        height: A[b + OBST.HEIGHT],
        flags,
        material: A[b + OBST.MATERIAL],
        mass: A[b + OBST.MASS],
        object: A[b + OBST.OBJECT],
        shape: A[b + OBST.SHAPE],
        yaw: mirrorZ ? Math.PI - A[b + OBST.YAW] : A[b + OBST.YAW],
        hull,
      };
      if (!(o.radius > 0) || !Number.isFinite(o.pos.x + o.pos.y + o.pos.z)) continue;
      if (flags & OBST_HARD) hard.push(o);
      else if (flags & OBST_DYNAMIC) dyn.push(o);
      else if (flags & OBST_SOFT) soft.push(o);
    }
    this.hard = new ProxyGrid(hard);
    this.dynamic = new ProxyGrid(dyn);
    this.soft = new ProxyGrid(soft);
  }

  /** HARD obstacles whose cylinder comes within `radius` of posSim (horizontal), the WorldQuery contract. */
  near(p: SimV3, radius: number, out: Obstacle[]): Obstacle[] {
    return this.hard.near(p.x, p.z, radius, out);
  }

  /** Loose dynamic parts (PhyObjects) within `radius` (their hull + mass ride on the OrigObstacle). */
  partsNear(p: SimV3, radius: number, out: Obstacle[]): Obstacle[] {
    return this.dynamic.near(p.x, p.z, radius, out);
  }

  /** Flag-only collision objects (bushes: `hasCollision 1` without geometry) within `radius` (FX, no hard hit). */
  softNear(p: SimV3, radius: number, out: Obstacle[]): Obstacle[] {
    return this.soft.near(p.x, p.z, radius, out);
  }
}

const EMPTY = new Float32Array(0);
