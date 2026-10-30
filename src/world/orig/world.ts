/**
 * src/world/orig/world.ts — the MESH WorldQuery of a ported stage: the original Track.gcm (gcm.ts) for every
 * ground query, the object proxies (obstacles.ts) for obstaclesNear, and the procedural world as the point-query
 * fallback off the mesh (contract: src/core/types.ts WorldQuery; research/formats/gcm.md §3, §9).
 *
 *   segment(o, ray, slot)  literal port of the original (first hit in traversal order, per-slot face cache,
 *                          one-sided, start strictly above the plane); every RayHit field filled.
 *   raycast(o, dir, max)   = segment(o, dir·max, −1) (src/core/worldQuery.ts raycastViaSegment): an origin below
 *                          the ground is a MISS here, never a dist-0 hit. Off the mesh nothing is hit.
 *   heightAt / normalAt / materialAt / surfaceAt (x, z, yHint?)   the front-facing faces over (x, z), level by
 *                          pickGroundLevel (highest; with yHint the highest at or below yHint + 1 m, else the
 *                          lowest above); off the mesh the procedural world's answer (never NaN).
 *   obstaclesNear          the HARD object proxies (vertical cylinders): hints (autopilot) once object meshes exist.
 *   objectCollidersNear    (RCOL v2 only) the static objects' own collision meshes (objectMeshes.ts): the car
 *                          collides with these like the original's object pass (src/sim/car.ts objectPass).
 *
 * Sim space = the gcm's local frame (gcm.md, frame note): the original subtracts the track object's translation
 * (2048, H, 2048) before querying; rally-web sim coordinates already are that local frame, so nothing is added.
 *
 * `mirrorZ` (stage-frame workaround, docs/orig/collision.md §5): when the ported Stage was built z-mirrored
 * against the original (three = the spline's raw (x, y, z) instead of (x, y, −z)), the stage's sim frame is
 * the original's mirrored in z. The world then answers every query in that mirrored frame: inputs and outputs
 * have z negated at this boundary. A reflection keeps every dot product, so the one-sided test, t, depth, cos,
 * the traversal order and the face cache are exactly those of the original query on the mirrored segment.
 */
import { MATERIAL_SOLID_MIN, materialFromOrig, surfaceFromMaterial } from '../../core/constants';
import type { ObjectCollider, Obstacle, RayHit, SimV3, SurfaceId, WorldQuery } from '../../core/types';
import { isCacheSlot, pickGroundLevel, raycastViaSegment, setRayHit } from '../../core/worldQuery';
import { GcmGrid } from './gcm';
import { OrigObjectMeshes } from './objectMeshes';
import { OrigObstacles } from './obstacles';
import type { RcolData } from './rcol';

/** Most faces ever stacked over one point that the level queries consider. */
const MAX_LEVELS = 32;

export interface OrigWorldOptions {
  /** Obstacle kind names (collision.json obstacles.kinds), indexed by the record's KIND. */
  kinds?: readonly string[];
  /** Serve the mesh z-mirrored (the stage was built mirrored against the original; see the header). */
  mirrorZ?: boolean;
}

export class OrigWorld implements WorldQuery {
  readonly grid: GcmGrid;
  readonly obstacles: OrigObstacles;
  /** The static objects' collision meshes (empty for an RCOL v1 file). */
  readonly objectMeshes: OrigObjectMeshes;
  /** Present only when the file carries object meshes (RCOL v2): the sim then uses them instead of the cylinders. */
  readonly objectCollidersNear?: (p: SimV3, radius: number, out?: ObjectCollider[]) => ObjectCollider[];
  /** Procedural world answering point queries off the mesh. */
  readonly fallback: WorldQuery;
  /** True when queries are mirrored in z (stage-frame workaround). */
  readonly mirrorZ: boolean;
  /** −1 when mirrored, else 1: gcm z = zs · sim z. */
  private readonly zs: number;
  // last point query (heightAt → normalAt → materialAt usually ask the same point)
  private qx = NaN;
  private qz = NaN;
  private qh: number | undefined = undefined;
  private qFace = -1;
  private qY = NaN;
  private readonly ys = new Float64Array(MAX_LEVELS);
  private readonly faces = new Int32Array(MAX_LEVELS);

  constructor(data: RcolData, fallback: WorldQuery, opts: OrigWorldOptions = {}) {
    this.grid = new GcmGrid(data);
    this.mirrorZ = !!opts.mirrorZ;
    this.zs = this.mirrorZ ? -1 : 1;
    this.obstacles = new OrigObstacles(data, opts.kinds ?? [], this.mirrorZ);
    this.objectMeshes = new OrigObjectMeshes(data, opts.kinds ?? [], this.mirrorZ);
    if (this.objectMeshes.list.length > 0) {
      const om = this.objectMeshes;
      this.objectCollidersNear = (p, radius, out) => om.near(p, radius, out ?? []);
    }
    this.fallback = fallback;
  }

  /** The original's segment query (gcm.ts); `out` is filled in place when given (no allocation), else a fresh hit. */
  segment(o: SimV3, ray: SimV3, slot?: number, out?: RayHit): RayHit | null {
    const g = this.grid, zs = this.zs;
    if (!g.segment(o.x, o.y, zs * o.z, ray.x, ray.y, zs * ray.z, isCacheSlot(slot) ? slot : -1)) return null;
    const h = g.hit;
    const len = Math.sqrt(ray.x * ray.x + ray.y * ray.y + ray.z * ray.z);
    if (out) {
      return setRayHit(out, h.t * len, h.nx, h.ny, zs * h.nz, materialFromOrig(h.material), h.px, h.py, zs * h.pz,
        h.t, h.depth, h.cos, h.material, h.face);
    }
    return {
      dist: h.t * len,
      normal: { x: h.nx, y: h.ny, z: zs * h.nz },
      material: materialFromOrig(h.material),
      point: { x: h.px, y: h.py, z: zs * h.pz },
      t: h.t,
      depth: h.depth,
      cos: h.cos,
      origMaterial: h.material,
      face: h.face,
    };
  }

  raycast(o: SimV3, dir: SimV3, maxDist: number, out?: RayHit): RayHit | null {
    return raycastViaSegment(this, o, dir, maxDist, out);
  }

  /** Face of the ground level at (x, z) per the yHint rule, −1 off the mesh (memoised for one point). */
  private level(x: number, z: number, yHint?: number): number {
    const h = yHint !== undefined && Number.isFinite(yHint) ? yHint : undefined;
    if (x === this.qx && z === this.qz && h === this.qh) return this.qFace;
    const n = this.grid.facesAt(x, this.zs * z, this.ys, this.faces);
    const k = pickGroundLevel(this.ys, n, h);
    this.qx = x;
    this.qz = z;
    this.qh = h;
    this.qFace = k < 0 ? -1 : this.faces[k];
    this.qY = k < 0 ? NaN : this.ys[k];
    return this.qFace;
  }

  heightAt(x: number, z: number, yHint?: number): number {
    return this.level(x, z, yHint) >= 0 ? this.qY : this.fallback.heightAt(x, z, yHint);
  }

  normalAt(x: number, z: number, yHint?: number): SimV3 {
    const f = this.level(x, z, yHint);
    if (f < 0) return this.fallback.normalAt(x, z, yHint);
    const FN = this.grid.d.FN;
    return { x: FN[3 * f], y: FN[3 * f + 1], z: this.zs * FN[3 * f + 2] };
  }

  materialAt(x: number, z: number, yHint?: number): number {
    const f = this.level(x, z, yHint);
    return f < 0 ? this.fallback.materialAt(x, z, yHint) : materialFromOrig(this.grid.d.M[f]);
  }

  /** Raw original material byte of the ground at (x, z) (255 off the mesh). */
  origMaterialAt(x: number, z: number, yHint?: number): number {
    const f = this.level(x, z, yHint);
    return f < 0 ? 255 : this.grid.d.M[f];
  }

  /** Is (x, z) over the collision mesh (any front-facing face)? */
  onMesh(x: number, z: number): boolean {
    return this.level(x, z) >= 0;
  }

  surfaceAt(x: number, z: number, yHint?: number): SurfaceId | null {
    const f = this.level(x, z, yHint);
    if (f < 0) return this.fallback.surfaceAt(x, z, yHint);
    const m = materialFromOrig(this.grid.d.M[f]);
    return m < MATERIAL_SOLID_MIN ? surfaceFromMaterial(m) : null;
  }

  obstaclesNear(p: SimV3, radius: number, out?: Obstacle[]): Obstacle[] {
    return this.obstacles.near(p, radius, out ?? []);
  }

  /** Loose PhyObject parts near p (not part of the WorldQuery contract yet; see obstacles.ts). */
  partsNear(p: SimV3, radius: number, out?: Obstacle[]): Obstacle[] {
    return this.obstacles.partsNear(p, radius, out ?? []);
  }

  /** Flag-only collision objects (bushes) near p (no hard hit in the original; FX hooks only). */
  softNear(p: SimV3, radius: number, out?: Obstacle[]): Obstacle[] {
    return this.obstacles.softNear(p, radius, out ?? []);
  }

  /** Forget every slot's cached block / face (e.g. on a stage restart; the original keeps them). */
  resetFaceCache(): void {
    this.grid.resetCache();
  }
}
