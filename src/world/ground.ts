/**
 * src/world/ground.ts — the physical ground of a stage (road ribbon over the carved heightfield) and the
 * obstacle set, plus the SIM-space WorldQuery adapter.
 *
 * Internally everything is THREE space; the WorldQuery converts at the boundary (sim z = -three z). The
 * ground is single-valued: on the ribbon footprint the ribbon is the surface, elsewhere the heightfield.
 */
import { MATERIAL_SOLID_MIN, surfaceFromMaterial } from '../core/constants';
import type { Obstacle, RayHit, SceneryInstance, SimV3, SurfaceId, WorldQuery } from '../core/types';
import type { RoadHit, RoadModel } from './road';
import type { Terrain, TerrainHit } from './terrain';

export interface GroundHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
  px: number;
  py: number;
  pz: number;
  material: number;
}

export class Ground {
  private readonly rh: RoadHit = { t: 0, nx: 0, ny: 1, nz: 0, px: 0, py: 0, pz: 0, material: 0 };
  private readonly th: TerrainHit = { t: 0, nx: 0, ny: 1, nz: 0, px: 0, py: 0, pz: 0, material: 0 };
  private readonly n3 = new Float64Array(3);
  readonly terrain: Terrain;
  readonly road: RoadModel;
  constructor(terrain: Terrain, road: RoadModel) {
    this.terrain = terrain;
    this.road = road;
  }

  /** Ground height (THREE y) at THREE (x, z). */
  height(x: number, z: number): number {
    const r = this.road.heightAt(x, z);
    return r === r ? r : this.terrain.heightAt(x, z);
  }

  /** Unit ground normal (THREE space) into out. */
  normal(x: number, z: number, out: Float64Array): void {
    const r = this.road.heightAt(x, z);
    if (r === r) this.road.triNormal(this.road.lastTri, out);
    else this.terrain.normalAt(x, z, out);
  }

  material(x: number, z: number): number {
    const r = this.road.heightAt(x, z);
    if (r === r) return this.road.materialInSeg(this.road.lastSeg, x, z);
    return this.terrain.materialAt(x, z);
  }

  /** On the ribbon footprint? */
  onRoad(x: number, z: number): boolean {
    const r = this.road.heightAt(x, z);
    return r === r;
  }

  /** First hit along origin + t·dir, t ∈ [0, maxT]. Origin under the ground → t = 0. THREE space. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, hit: GroundHit): boolean {
    if (!(maxT >= 0) || !Number.isFinite(ox + oy + oz + dx + dy + dz)) return false;
    // origin under the ground?
    const rr = this.road.heightAt(ox, oz);
    const onRoad = rr === rr;
    const g = onRoad ? rr : this.terrain.heightAt(ox, oz);
    if (oy <= g) {
      hit.t = 0;
      hit.px = ox;
      hit.py = g;
      hit.pz = oz;
      if (onRoad) {
        this.road.triNormal(this.road.lastTri, this.n3);
        hit.material = this.road.materialInSeg(this.road.lastSeg, ox, oz);
      } else {
        this.terrain.normalAt(ox, oz, this.n3);
        hit.material = this.terrain.materialAt(ox, oz);
      }
      hit.nx = this.n3[0];
      hit.ny = this.n3[1];
      hit.nz = this.n3[2];
      return true;
    }
    if (maxT === 0) return false;
    const roadHit = this.road.raycast(ox, oy, oz, dx, dy, dz, maxT, this.rh);
    const limit = roadHit ? this.rh.t : maxT;
    const terrHit = this.terrain.raycast(ox, oy, oz, dx, dy, dz, limit, this.th);
    const src = terrHit && (!roadHit || this.th.t < this.rh.t - 1e-6) ? this.th : roadHit ? this.rh : null;
    if (!src) return false;
    hit.t = src.t;
    hit.nx = src.nx;
    hit.ny = src.ny;
    hit.nz = src.nz;
    hit.px = src.px;
    hit.py = src.py;
    hit.pz = src.pz;
    hit.material = src.material;
    return true;
  }
}

/** Obstacles (scenery with a collision radius) in a uniform grid, stored in SIM space for the WorldQuery. */
export class ObstacleSet {
  readonly list: Obstacle[];
  private readonly cell = 16;
  private ox = 0;
  private oz = 0;
  private gnx = 1;
  private gnz = 1;
  private start!: Int32Array;
  private items!: Int32Array;
  private maxR = 0;

  constructor(scenery: readonly SceneryInstance[]) {
    this.list = [];
    for (const sc of scenery) {
      if (!(sc.radius > 0)) continue;
      this.list.push({ kind: sc.kind, pos: { x: sc.pos.x, y: sc.pos.y, z: -sc.pos.z }, radius: sc.radius, height: sc.height });
      this.maxR = Math.max(this.maxR, sc.radius);
    }
    this.build();
  }

  private build(): void {
    const L = this.list;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const o of L) {
      minX = Math.min(minX, o.pos.x);
      maxX = Math.max(maxX, o.pos.x);
      minZ = Math.min(minZ, o.pos.z);
      maxZ = Math.max(maxZ, o.pos.z);
    }
    if (!L.length) {
      minX = maxX = minZ = maxZ = 0;
    }
    this.ox = minX - 1;
    this.oz = minZ - 1;
    this.gnx = Math.max(1, Math.ceil((maxX - minX + 2) / this.cell));
    this.gnz = Math.max(1, Math.ceil((maxZ - minZ + 2) / this.cell));
    const cells = this.gnx * this.gnz;
    const counts = new Int32Array(cells + 1);
    const cellOf = (o: Obstacle): number => {
      const cx = Math.min(this.gnx - 1, Math.max(0, Math.floor((o.pos.x - this.ox) / this.cell)));
      const cz = Math.min(this.gnz - 1, Math.max(0, Math.floor((o.pos.z - this.oz) / this.cell)));
      return cz * this.gnx + cx;
    };
    for (const o of L) counts[cellOf(o) + 1]++;
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const items = new Int32Array(L.length);
    const fill = counts.slice(0, cells);
    L.forEach((o, i) => (items[fill[cellOf(o)]++] = i));
    this.start = counts;
    this.items = items;
  }

  /** SIM space query: obstacles whose cylinder comes within r of (x, z). */
  near(x: number, z: number, r: number, out: Obstacle[]): Obstacle[] {
    out.length = 0;
    if (!this.list.length) return out;
    const reach = r + this.maxR;
    const cx0 = Math.max(0, Math.floor((x - reach - this.ox) / this.cell));
    const cx1 = Math.min(this.gnx - 1, Math.floor((x + reach - this.ox) / this.cell));
    const cz0 = Math.max(0, Math.floor((z - reach - this.oz) / this.cell));
    const cz1 = Math.min(this.gnz - 1, Math.floor((z + reach - this.oz) / this.cell));
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * this.gnx + cx;
        for (let q = this.start[c]; q < this.start[c + 1]; q++) {
          const o = this.list[this.items[q]];
          const lim = r + o.radius;
          const ddx = o.pos.x - x;
          const ddz = o.pos.z - z;
          if (ddx * ddx + ddz * ddz < lim * lim) out.push(o);
        }
      }
    }
    return out;
  }
}

/** SIM-space WorldQuery over a Ground + ObstacleSet. */
export function makeWorldQuery(ground: Ground, obstacles: ObstacleSet): WorldQuery {
  const H: GroundHit = { t: 0, nx: 0, ny: 1, nz: 0, px: 0, py: 0, pz: 0, material: 0 };
  const n3 = new Float64Array(3);
  return {
    raycast(o: SimV3, d: SimV3, maxDist: number): RayHit | null {
      if (!ground.raycast(o.x, o.y, -o.z, d.x, d.y, -d.z, maxDist, H)) return null;
      return {
        dist: H.t,
        normal: { x: H.nx, y: H.ny, z: -H.nz },
        material: H.material,
        point: { x: H.px, y: H.py, z: -H.pz },
      };
    },
    heightAt(x: number, z: number): number {
      const h = ground.height(x, -z);
      return Number.isFinite(h) ? h : 0;
    },
    normalAt(x: number, z: number): SimV3 {
      ground.normal(x, -z, n3);
      return { x: n3[0], y: n3[1], z: -n3[2] };
    },
    materialAt(x: number, z: number): number {
      return ground.material(x, -z);
    },
    surfaceAt(x: number, z: number): SurfaceId | null {
      const m = ground.material(x, -z);
      return m < MATERIAL_SOLID_MIN ? surfaceFromMaterial(m) : null;
    },
    obstaclesNear(p: SimV3, radius: number, out?: Obstacle[]): Obstacle[] {
      return obstacles.near(p.x, p.z, radius, out ?? []);
    },
  };
}
