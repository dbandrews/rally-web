/**
 * src/world/portedBuilder.ts — the stage pipeline for the PORTED original tracks
 * (src/world/ports/*.ts): real road geometry instead of a generated layout.
 *
 *   ported spline data (centre / left / right CVs, Play.con race settings)
 *   → centre line (de Boor evaluation, ≈1 m arc-length resampling, REAL elevation)
 *   → road widths + cross-fall (lateral nearest points of the left/right splines,
 *     median + Gaussian cleaned)
 *   → road surfaces (the original's Track.gcm material under the centre line, ports ROAD_MATERIAL;
 *     the family mix only for an archive without it)
 *   → road ribbon + physics surface (RoadModel)
 *   → procedural terrain draped to the real road elevation + family carve
 *   → family scenery (procedural, neutral) → the original's pacenotes (PaceNotes.con words)
 *   → Stage (THREE space) + WorldQuery (SIM space; multi-level at the grade separations)
 *
 * Everything that drives how the stage drives, sounds and is timed is ported exactly:
 * centre line, elevation, widths, cross-fall, road material, checkpoints (event triggers), spawn
 * grid, valid range, default tyre, laps, co-driver notes, post-finish braking factor. Scenery/terrain are procedural around the
 * real road (PROGRESS.md rules). Frame: the archive CVs are original = sim coordinates, the
 * stage is built in three space = (x, y, −z) (portSpline.origToThree).
 */
import { MATERIAL, MATERIAL_NONE, MATERIAL_SOLID_MIN, materialFromOrig, surfaceFromMaterial } from '../core/constants';
import { hashSeed, Rng } from '../core/rng';
import type { BuiltStage, Pacenote, RayHit, SimV3, SurfaceId, WorldQuery } from '../core/types';
import { GROUND_HINT_ABOVE_M, segmentViaRaycast } from '../core/worldQuery';
import { Centerline } from './centerline';
import { analyzeCorners, type Corner } from './corners';
import { environmentFor } from './environments';
import { Ground, makeWorldQuery, ObstacleSet, type GroundHit } from './ground';
import { Noise2D } from './noise';
import { generatePacenotes, NOTE_GRIP_G, type PacenoteHazard } from './pacenotes';
import { portedPacenotes } from './portedPacenotes';
import { medianFilter, origToThree, resampleXYZ, sampleBspline, type PortedPoints } from './portSpline';
import type { PortedTrackData } from './ports';
import { ProcStage, centerlineDistanceField, surfaceOf, type StageMeta } from './builder';
import { gaussianSmooth } from './profile';
import { RoadModel, type RoadHit } from './road';
import { SceneryPlacer, type SceneryEnv } from './scenery';
import { buildTerrain, type CarveOptions, type MaterialContext } from './terrainGen';
import { Terrain, type TerrainHit } from './terrain';

export type { PortedTrackData } from './ports';

/** Per-family look & feel around the ported real road (all procedural, neutral). */
export interface PortedFamily {
  /** environments.ts key. */
  readonly env: string;
  /** Road surface mix per layout number (the original's per-stage material shares, spec §4.3.1); only used for an
   *  archive without ROAD_MATERIAL runs (every shipped archive has them). */
  readonly mix: Readonly<Record<string, SurfaceMix>>;
  /** Default when the layout has no explicit mix entry. */
  readonly mixDefault: SurfaceMix;
  /** Terrain undulation amplitude (m) and noise scales. */
  readonly terrain: { amp: number; big: number; small: number };
  /** Earthworks around the road. */
  readonly carve: (cell: number) => CarveOptions;
  /** Crown height per road surface (m). */
  readonly crown: (surface: SurfaceId) => number;
  /** Terrain material per heightfield vertex (procedural, neutral). */
  readonly groundMat: (c: MaterialContext, noise: Noise2D) => number;
  /** Scenery script (procedural, neutral kinds). */
  readonly scenery: (p: SceneryPlacer, ctx: PortedSceneryCtx) => void;
}

/** What a family scenery script may read. */
export interface PortedSceneryCtx {
  readonly cl: Centerline;
  /** One corner analysis pass, shared with the pacenote generator. */
  readonly corners: readonly Corner[];
  readonly startS: number;
  readonly finishS: number;
  readonly closed: boolean;
  readonly rng: Rng;
}

export interface PortedRecipe {
  readonly meta: StageMeta;
  readonly data: PortedTrackData;
  readonly family: PortedFamily;
}

// ------------------------------------------------------------------------------------------- geometry

/** Dense point cloud of one road edge spline with a uniform grid index. */
class EdgeCloud {
  private readonly cell = 4;
  private readonly grid = new Map<number, number[]>();
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  constructor(pts: PortedPoints) {
    this.px = pts.x;
    this.py = pts.y;
    this.pz = pts.z;
    for (let i = 0; i < pts.count; i++) {
      const k = this.key(Math.floor(pts.x[i] / this.cell), Math.floor(pts.z[i] / this.cell));
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(i);
    }
  }
  private key(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }
  /**
   * Point of this edge least offset LATERALLY from (x, z): the road edge beside the centre
   * line sample, ignoring edge points that mainly sit along the road (another leg of a
   * hairpin or the far side of a crossing). Returns [lateral offset, edge y].
   */
  nearestLateral(x: number, z: number, hx: number, hz: number, maxR: number): { lat: number; y: number } | null {
    const c = this.cell;
    const kx = Math.floor(x / c);
    const kz = Math.floor(z / c);
    let best = Infinity;
    let bestY = 0;
    const rings = Math.ceil(maxR / c);
    for (let r = 1; r <= rings; r++) {
      let found = false;
      for (let iz = kz - r; iz <= kz + r; iz++) {
        const edgeRow = iz === kz - r || iz === kz + r;
        for (let ix = kx - r; ix <= kx + r; ix++) {
          if (!edgeRow && ix !== kx - r && ix !== kx + r) continue;
          const l = this.grid.get(this.key(ix, iz));
          if (!l) continue;
          for (const i of l) {
            const d = Math.hypot(this.px[i] - x, this.pz[i] - z);
            if (d > maxR) continue;
            found = true;
            // right of travel = (-hz, hx); along = (hx, hz)
            const ux = this.px[i] - x;
            const uz = this.pz[i] - z;
            const along = Math.abs(ux * hx + uz * hz);
            if (along > 28) continue;
            const lat = Math.abs(ux * -hz + uz * hx);
            if (lat < best) {
              best = lat;
              bestY = this.py[i];
            }
          }
        }
      }
      if (best < Infinity) return { lat: best, y: bestY };
      if (found) break; // points exist in this ring but none lateral enough: give up
    }
    return best < Infinity ? { lat: best, y: bestY } : null;
  }
}

export interface RoadSection {
  /** Centre line (dense, 1 m) with the real elevation set. */
  readonly cl: Centerline;
  readonly y: Float64Array;
  /** Cleaned half widths / edge elevations per centre sample. */
  readonly halfL: Float64Array;
  readonly halfR: Float64Array;
  readonly edgeYL: Float64Array;
  readonly edgeYR: Float64Array;
}

/** Evaluate the ported splines into the dense centre line + per-sample road widths. */
/** Road the ported centre line keeps past the stage's last race distance (finish, last note), m. */
export const RUNOFF_M = 60;

/**
 * The race distance the ported road must reach: an open archive's last trigger / pacenote + RUNOFF_M.
 * A few archives time their finish at or past the END of their AI centre spline (hillclimb1cr finish 3631
 * on a 3520 m spline, hillclimb2ar 4035 / 4027 m; their collision-mesh road runs on). The original's
 * distances are nevertheless on that spline's arc length: the co-driver calls match the bends only
 * unshifted (hillclimb-1c-r direction agreement 0.80 at its archive distances vs 0.30 shifted back 156 m,
 * docs/orig/race.md §2), so the distances are kept and the centre line is EXTENDED instead.
 */
export function portedReach(data: PortedTrackData): number {
  if (data.closed) return 0;
  let last = data.triggers[data.triggers.length - 1] ?? 0;
  for (const [d] of data.pacenotes) last = Math.max(last, d);
  return last + RUNOFF_M;
}

/**
 * Extend an open dense centre line straight on along its end tangent (horizontal heading of the last
 * 10 m, its grade clamped to ±8 %) until `reach` metres (3-D arc length, same step). Unchanged when the
 * spline is long enough.
 */
function extendEnd(p: PortedPoints & { length: number; step: number }, reach: number): PortedPoints & { length: number; step: number } {
  const extra = reach - p.length;
  if (!(extra > 0)) return p;
  const n = p.count;
  const k = Math.max(1, Math.min(n - 1, Math.round(10 / p.step)));
  const hx = p.x[n - 1] - p.x[n - 1 - k];
  const hz = p.z[n - 1] - p.z[n - 1 - k];
  const h = Math.hypot(hx, hz) || 1;
  const g = Math.max(-0.08, Math.min(0.08, (p.y[n - 1] - p.y[n - 1 - k]) / h));
  const m = Math.ceil(extra / p.step);
  const dh = p.step / Math.sqrt(1 + g * g); // horizontal advance per 3-D step
  const x = new Float64Array(n + m);
  const y = new Float64Array(n + m);
  const z = new Float64Array(n + m);
  x.set(p.x);
  y.set(p.y);
  z.set(p.z);
  for (let i = 1; i <= m; i++) {
    x[n - 1 + i] = p.x[n - 1] + (hx / h) * dh * i;
    z[n - 1 + i] = p.z[n - 1] + (hz / h) * dh * i;
    y[n - 1 + i] = p.y[n - 1] + g * dh * i;
  }
  return { x, y, z, count: n + m, length: p.length + m * p.step, step: p.step };
}

export function portedRoadSection(data: PortedTrackData): RoadSection {
  const closed = data.closed;
  // centre dense enough for ~0.5 m chords (its length is unknown before evaluation)
  const nC = 6000;
  // archive CVs are original = sim frame; the centre line is three space: (x, y, −z) (no mirrored stages)
  const centre = origToThree(sampleBspline(data.center, 3, closed, nC));
  const left = origToThree(sampleBspline(data.left, 3, closed, nC));
  const right = origToThree(sampleBspline(data.right, 3, closed, nC));
  const clpts = closed ? resampleXYZ(centre, closed, 1) : extendEnd(resampleXYZ(centre, closed, 1), portedReach(data));
  const cl = Centerline.fromDense(clpts.x, clpts.z, closed, clpts.step, clpts.length);
  const n = cl.n;
  const ds = cl.ds;

  // ---- per-sample widths from the left / right splines
  const gl = new EdgeCloud(left);
  const gr = new EdgeCloud(right);
  const rawL = new Float64Array(n);
  const rawR = new Float64Array(n);
  const rawYL = new Float64Array(n);
  const rawYR = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = cl.x[i];
    const z = cl.z[i];
    const hx = cl.hx[i];
    const hz = cl.hz[i];
    const l = gl.nearestLateral(x, z, hx, hz, 40);
    const r = gr.nearestLateral(x, z, hx, hz, 40);
    rawL[i] = l?.lat ?? r?.lat ?? 6;
    rawR[i] = r?.lat ?? l?.lat ?? 6;
    rawYL[i] = l?.y ?? clpts.y[i];
    rawYR[i] = r?.y ?? clpts.y[i];
  }
  // robust cleaning: median filter kills single-sample artifacts (crossings, sparse CVs),
  // the Gaussian pass restores smooth edges; hard clamp keeps the road physical.
  const clean = (src: Float64Array, lo: number, hi: number): Float64Array => {
    const med = medianFilter(src, 3, closed);
    const g = gaussianSmooth(med, 6, closed);
    const out = new Float64Array(src.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.min(hi, Math.max(lo, g[i]));
    return out;
  };
  const halfL = clean(rawL, 2.4, 34);
  const halfR = clean(rawR, 2.4, 34);
  const edgeYL = gaussianSmooth(medianFilter(rawYL, 3, closed), 6, closed);
  const edgeYR = gaussianSmooth(medianFilter(rawYR, 3, closed), 6, closed);
  void ds;
  return { cl, y: clpts.y, halfL, halfR, edgeYL, edgeYR };
}

/** Fraction of the local centre-line radius a half-width may reach (inner edge keeps advancing). */
export const FOLD_MARGIN = 0.9;
/** The narrowest the fold cap may make a ported road (m): a drivable single-lane rally road. */
export const FOLD_MIN_WIDTH = 5;

/**
 * Edge-to-edge widths whose ribbon does not FOLD. The road cross-sections are normals of the centre
 * line (src/world/road.ts), so wherever a half-width exceeds the local centre-line radius R the
 * inner edge runs backwards: consecutive cross-sections cross, the ribbon triangles overlap and the
 * physics surface (topmost triangle) no longer matches the drawn road — up to 0.8 m steps at the
 * apex of the original's wide hairpins (hillclimb 1b, kenya 3). The original's own inner edge there
 * is a tight arc, which a normal-offset cross-section can only reach up to R; so the half-width is
 * capped at FOLD_MARGIN·R (R from the peak per-segment turn within ±3 m, the quantity that decides
 * whether two consecutive cross-sections cross) and the cut is eased in over 8 m on both sides (no
 * width steps). Never narrower than FOLD_MIN_WIDTH: the original's AI spline has a few junction
 * corners (kenya 3: 80° within 4 m) tighter than any drivable road can follow with normal
 * cross-sections; those keep a small, same-height overlap. Unchanged wherever the real road fits.
 */
export function foldFreeWidths(cl: Centerline, width: Float64Array): Float64Array {
  const n = cl.n;
  const win = Math.max(1, Math.round(3 / cl.ds));
  // per-segment turn rate of the cross-section normals (heading = central-difference tangent)
  const segK = new Float64Array(n);
  const segs = cl.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    let dh = cl.heading[cl.idx(i + 1)] - cl.heading[i];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    segK[i] = Math.abs(dh) / cl.ds;
  }
  const cut = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    let km = 0;
    for (let j = i - win; j <= i + win; j++) km = Math.max(km, segK[cl.idx(j)], Math.abs(cl.kappa[cl.idx(j)]));
    const cap = Math.max(FOLD_MIN_WIDTH, km > 1e-9 ? (2 * FOLD_MARGIN) / km : Infinity);
    if (width[i] > cap) {
      cut[i] = width[i] - cap;
      any = true;
    }
  }
  if (!any) return width;
  // triangular dilation of the cut: ≥ the cut everywhere (keeps the cap), linear ease over `ease` m
  const ease = Math.max(1, Math.round(8 / cl.ds));
  const spread = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!(cut[i] > 0)) continue;
    for (let k = -ease; k <= ease; k++) {
      const j = cl.closed ? cl.idx(i + k) : i + k;
      if (j < 0 || j >= n) continue;
      const v = cut[i] * (1 - Math.abs(k) / (ease + 1));
      if (v > spread[j]) spread[j] = v;
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(width[i], Math.max(FOLD_MIN_WIDTH, width[i] - spread[i]));
  return out;
}

// ------------------------------------------------------------------------------------------- surfaces

export interface SurfaceMix {
  readonly base: SurfaceId;
  readonly accents: readonly { surface: SurfaceId; share: number }[];
}

/**
 * Per-sample road material: the family's base surface with accent sections laid out by a
 * seeded RNG to hit the original's per-stage material shares (e.g. the desert rally's
 * ≈ 78 % sand / 14 % asphalt / 8 % gravel; the actual face layout lives in the original's
 * collision meshes, which are not ported — the shares are).
 */
export function portedMaterials(
  mix: SurfaceMix,
  seedBase: number,
  n: number,
  closed: boolean,
  keepClear: readonly number[],
): Uint8Array {
  const m = new Uint8Array(n).fill(MATERIAL[mix.base]);
  const rng = new Rng(seedBase);
  const near = (i: number): boolean => keepClear.some((s) => Math.abs(i - s) < 18);
  for (const acc of mix.accents) {
    let want = Math.round(acc.share * n);
    let guard = 0;
    while (want > 0 && guard++ < 400) {
      const len = Math.min(want, Math.round(rng.range(60, 220)));
      let i0 = Math.round(rng.next() * (n - len));
      if (near(i0) || near(i0 + len)) i0 = (i0 + 40) % n;
      for (let i = 0; i < len; i++) {
        const j = closed ? (i0 + i) % n : Math.min(n - 1, i0 + i);
        m[j] = MATERIAL[acc.surface];
      }
      want -= len;
    }
  }
  return m;
}

/**
 * The road material per centre-line sample from the ORIGINAL collision mesh: `runs` = the archive's
 * PortedTrackData.roadMaterial (research/tools/port_tracks.py road_material_runs: the Track.gcm face under the AI
 * centre line every 2 m of 3-D arc length, as run starts [s, gcm byte]). Sample i (s = i·ds) takes the last run
 * starting at or before s, before the first run the first one (the spline beyond the original's corridor). Bytes
 * mapped through materialFromOrig (never a raw byte as a rally-web id); one with no surface keeps `fallback`.
 */
export function origRoadMaterials(runs: readonly (readonly [number, number])[], n: number, ds: number, fallback: number): Uint8Array {
  const m = new Uint8Array(n).fill(fallback);
  if (runs.length === 0) return m;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    while (k + 1 < runs.length && runs[k + 1][0] <= s) k++;
    const id = materialFromOrig(runs[k][1]);
    if (id !== MATERIAL_NONE) m[i] = id;
  }
  return m;
}

// ------------------------------------------------------------------------------------------- terrain

/**
 * Natural terrain draped to the real road elevation, in two parts:
 *
 *  1. a least-squares plane over the road heights — the mountain's overall tilt (a hairclimb
 *     corridor climbs along its axis; the plane ramps smoothly where the road legs stack and
 *     an elevation-drape would cliff between them), and
 *  2. an inverse-distance blend of the road-height RESIDUALS against that plane (fixed 720 m
 *     radius, weight 1/(d² + 60²), clamped to ± 60 m: beside the road its own leg dominates,
 *     and stacked hairpin legs — tens of metres apart horizontally, a hundred-plus in
 *     elevation — blend over their separation instead of cliffing), bilinear over a padded
 *     node grid,
 *
 * plus family noise ramping in with distance from the road.
 */
export function drapedNatural(
  cl: Centerline,
  y: Float64Array,
  family: PortedFamily,
  seedBase: number,
): (x: number, z: number) => number {
  const step = Math.max(8, Math.round(24 / cl.ds));
  const sx: number[] = [];
  const sz: number[] = [];
  const sr: number[] = [];
  // ---- least-squares plane y = a·x + b·z + c over the road samples
  let n = 0;
  let sx0 = 0;
  let sz0 = 0;
  let sy0 = 0;
  for (let i = 0; i < cl.n; i += step) {
    sx0 += cl.x[i];
    sz0 += cl.z[i];
    sy0 += y[i];
    n++;
  }
  const mx = sx0 / n;
  const mz = sz0 / n;
  const my = sy0 / n;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  let sxy = 0;
  let szy = 0;
  for (let i = 0; i < cl.n; i += step) {
    const dx = cl.x[i] - mx;
    const dz = cl.z[i] - mz;
    const dy = y[i] - my;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
    sxy += dx * dy;
    szy += dz * dy;
  }
  const det = sxx * szz - sxz * sxz;
  let a = 0;
  let b = 0;
  if (Math.abs(det) > 1e-6) {
    a = (sxy * szz - sxz * szy) / det;
    b = (sxx * szy - sxz * sxy) / det;
  }
  const c = my - a * mx - b * mz;
  const plane = (x: number, z: number): number => a * x + b * z + c;
  for (let i = 0; i < cl.n; i += step) {
    sx.push(cl.x[i]);
    sz.push(cl.z[i]);
    sr.push(y[i] - plane(cl.x[i], cl.z[i]));
  }
  // ---- IDW of the residuals (grid + fixed-radius search)
  const sc = 48;
  const sgrid = new Map<number, number[]>();
  for (let i = 0; i < sr.length; i++) {
    const k = (Math.floor(sx[i] / sc) + 32768) * 65536 + (Math.floor(sz[i] / sc) + 32768);
    let l = sgrid.get(k);
    if (!l) sgrid.set(k, (l = []));
    l.push(i);
  }
  const SIG2 = 30 * 30;
  const R = 720;
  const RINGS = Math.ceil(R / sc);
  const idw = (x: number, z: number): number => {
    const kx = Math.floor(x / sc);
    const kz = Math.floor(z / sc);
    let sum = 0;
    let wsum = 0;
    let nearest = -1;
    let nearestD2 = Infinity;
    for (let r = 0; r <= RINGS; r++) {
      for (let iz = kz - r; iz <= kz + r; iz++) {
        const edgeRow = iz === kz - r || iz === kz + r;
        for (let ix = kx - r; ix <= kx + r; ix++) {
          if (r > 0 && !edgeRow && ix !== kx - r && ix !== kx + r) continue;
          const l = sgrid.get((ix + 32768) * 65536 + (iz + 32768));
          if (!l) continue;
          for (const i of l) {
            const d2 = (sx[i] - x) ** 2 + (sz[i] - z) ** 2;
            if (d2 < nearestD2) {
              nearestD2 = d2;
              nearest = i;
            }
            if (d2 <= R * R) {
              const w = 1 / (d2 + SIG2);
              sum += w * sr[i];
              wsum += w;
            }
          }
        }
      }
    }
    if (wsum > 0) return sum / wsum;
    return nearest >= 0 ? sr[nearest] : 0;
  };
  // ---- padded node grid → bilinear
  const pad = 96;
  const cell = 32;
  const gx0 = cl.minX - pad;
  const gz0 = cl.minZ - pad;
  const gnx = Math.ceil((cl.maxX + pad - gx0) / cell) + 1;
  const gnz = Math.ceil((cl.maxZ + pad - gz0) / cell) + 1;
  const nodes = new Float64Array(gnx * gnz);
  for (let j = 0; j < gnz; j++) {
    for (let i = 0; i < gnx; i++) nodes[j * gnx + i] = idw(gx0 + i * cell, gz0 + j * cell);
  }
  // ---- slope limiter: clamp each node into its neighbours' ± lim envelope until stable, so
  // the draped field never exceeds `lim / cell` rise per metre anywhere. Stacked hairpin legs
  // (tens of metres apart horizontally, 100+ in elevation) would otherwise leave near-vertical
  // walls between them in the interior; the limiter turns those into the steep ramps a real
  // hairpin mountainside has. Gauss-Seidel sweeps from both corners converge fast.
  const lim = 1.6 * cell;
  for (let it = 0; it < 80; it++) {
    let changed = 0;
    const order = it % 2 === 0 ? 1 : -1;
    for (let jj = 0; jj < gnz; jj++) {
      const j = order > 0 ? jj : gnz - 1 - jj;
      for (let ii = 0; ii < gnx; ii++) {
        const i = order > 0 ? ii : gnx - 1 - ii;
        const k = j * gnx + i;
        let lo = -Infinity;
        let hi = Infinity;
        if (i > 0) {
          lo = Math.max(lo, nodes[k - 1] - lim);
          hi = Math.min(hi, nodes[k - 1] + lim);
        }
        if (i < gnx - 1) {
          lo = Math.max(lo, nodes[k + 1] - lim);
          hi = Math.min(hi, nodes[k + 1] + lim);
        }
        if (j > 0) {
          lo = Math.max(lo, nodes[k - gnx] - lim);
          hi = Math.min(hi, nodes[k - gnx] + lim);
        }
        if (j < gnz - 1) {
          lo = Math.max(lo, nodes[k + gnx] - lim);
          hi = Math.min(hi, nodes[k + gnx] + lim);
        }
        const v = Math.max(lo, Math.min(hi, nodes[k]));
        if (v !== nodes[k]) {
          if (Math.abs(v - nodes[k]) > 1e-9) changed++;
          nodes[k] = v;
        }
      }
    }
    if (!changed) break;
  }
  const distRoad = centerlineDistanceField(cl, 8, 260);
  const noise = new Noise2D(seedBase);
  const { amp, big, small } = family.terrain;
  const at = (x: number, z: number): number => {
    const u = Math.min(gnx - 1.001, Math.max(0, (x - gx0) / cell));
    const v = Math.min(gnz - 1.001, Math.max(0, (z - gz0) / cell));
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const n00 = nodes[j * gnx + i];
    const n10 = nodes[j * gnx + i + 1];
    const n01 = nodes[(j + 1) * gnx + i];
    const n11 = nodes[(j + 1) * gnx + i + 1];
    const res = (n00 * (1 - fu) + n10 * fu) * (1 - fv) + (n01 * (1 - fu) + n11 * fu) * fv;
    const d = distRoad(x, z);
    const ramp = Math.min(1, Math.max(0.12, (d - 8) / 70));
    const n = amp * (noise.fbm(x / big, z / big, 4) * 0.8 + noise.fbm(x / small, z / small, 3) * 0.35);
    return plane(x, z) + res + n * ramp;
  };
  return at;
}

// ------------------------------------------------------------------------------------------- pacenote hazards

/** Crests and dips of the REAL elevation profile (visibility breaks), for the co-driver. */
export function portedHazards(cl: Centerline): PacenoteHazard[] {
  const n = cl.n;
  const ds = cl.ds;
  const out: PacenoteHazard[] = [];
  const grade = (i: number): number => cl.grade[cl.idx(i)];
  let last = -1e9;
  for (let i = 0; i < n; i++) {
    const g0 = grade(i);
    let minAhead = Infinity;
    let maxAhead = -Infinity;
    for (let j = i + 8; j < i + 70; j += 2) {
      const g = grade(j);
      minAhead = Math.min(minAhead, g);
      maxAhead = Math.max(maxAhead, g);
    }
    const s = i * ds;
    if (g0 > 0.045 && minAhead < g0 - 0.05 && s - last > 60) {
      out.push({ s, kind: 'crest' });
      last = s;
    } else if (g0 < -0.05 && maxAhead > -g0 + 0.05 && s - last > 60) {
      // rising ground ahead over a dip: a double-caution bump, not a water splash
      out.push({ s, kind: 'caution' });
      last = s;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------- race settings

export interface PortedRaceSettings {
  /** Trigger 0: the start event line (no timing effect in the original, docs/orig/race.md §1). */
  readonly startS: number;
  readonly finishS: number;
  readonly checkpoints: readonly number[];
  /**
   * The archive's race.splineRange VERBATIM (point-to-point): the race controller's out-of-range check and reset
   * floor (FUN_004b3e50: s < +0x174 / s > +0x178, FUN_0074d980(20, lo + 1)). Its minimum may lie past the start
   * line (corsica2f 550 vs trigger 0 at 545); the spawn grid is always inside. Lap circuits: [0, length] (no
   * splineRange: the original's ±FLT_MAX, never out of range).
   */
  readonly validRange: readonly [number, number];
  /** race.spawnGrid distance: where the car waits at GO (on the centre line, single player). */
  readonly spawnS: number;
  /** Physics.bodyBrakingFactorForTrack: the post-finish track braking factor (0.4; hillclimb3cf 0.1). */
  readonly trackBraking: number;
  /** Distance shift applied to the archive numbers (0 = ported verbatim). */
  readonly shift: number;
}

/**
 * The archive's race settings on the ported road, VERBATIM (shift 0): the original's distances are
 * 3-D arc length along the same evaluated spline, which portedRoadSection extends past its end where an
 * archive's finish runs on beyond it (portedReach). `shift` stays in the interface (always 0).
 *
 * The car spawns at race.spawnGrid (0x484769: spline point at spawnGrid.s, heading to s + 1 m),
 * which three archives put PAST trigger 0 (corsica2f 559 vs 545, hillclimb3af 54 vs 40,
 * hillclimb3br 237 vs 200); `validRange` is the archive's race.splineRange verbatim (the race
 * controller's range check and reset floor). On those three archives its minimum lies past trigger 0
 * (550 / 48 / 220, docs/orig/race.md §3) but before the spawn grid, which the Stage contract accepts
 * (the spawn pose inside the range). Lap circuits have no splineRange (the original's default
 * ±FLT_MAX, 0x4a2a98): [0, length], never out of range.
 */
export function portedRaceSettings(data: PortedTrackData, length: number): PortedRaceSettings {
  const first = data.triggers[0] ?? data.spawnS;
  const last = data.triggers[data.triggers.length - 1] ?? first;
  if (data.closed) {
    const mod = (t: number): number => ((t % length) + length) % length;
    return {
      startS: first,
      finishS: first,
      checkpoints: data.triggers.slice(1).map(mod),
      validRange: [0, length],
      spawnS: mod(data.spawnS),
      trackBraking: data.bodyBraking,
      shift: 0,
    };
  }
  const shift = 0;
  const startS = first + shift;
  const finishS = last + shift;
  const spawnS = data.spawnS + shift;
  const checkpoints = data.triggers.slice(1, -1).map((t) => t + shift);
  const validRange: [number, number] = [data.validRange[0] + shift, data.validRange[1] + shift];
  return { startS, finishS, checkpoints, validRange, spawnS, trackBraking: data.bodyBraking, shift };
}

/**
 * The ProcStage of a ported stage with the original's spawn: `startPose` sits at the spawn grid
 * (Stage contract: "the spawn pose, car placed here at race start"), `startS` stays the start line
 * (trigger 0). `spawnS` is read by the race controller (src/game/race.ts gridPose): a stage that
 * carries it places the car there instead of the procedural stages' grid spot behind the line.
 * `trackBraking` (Physics.bodyBrakingFactorForTrack) is what the race controller hands the car at the
 * finish (CarSim.setTrackBraking: the original's phys+0x44 braking from player state 4, MECHANICS_SPEC §2.7).
 */
export interface PortedStage {
  readonly spawnS: number;
  readonly trackBraking: number;
}

function withSpawn(stage: ProcStage, rs: PortedRaceSettings): ProcStage & PortedStage {
  const s = stage as ProcStage & { spawnS: number; trackBraking: number; startPose: ProcStage['startPose'] };
  s.spawnS = rs.spawnS;
  s.trackBraking = rs.trackBraking;
  s.startPose = { pos: stage.pointAt(rs.spawnS), dir: stage.tangentAt(rs.spawnS) };
  return s;
}

// ------------------------------------------------------------------------------------------- grade separations

/** Two road sections closer than this vertically are one level (m). */
const LEVEL_SEP_M = 2.5;
/** A kerb face hit more than this below the ribbon edge above it belongs to an upper deck (m). */
const DECK_KERB_M = 2.5;

/**
 * Where the ported road passes over / under itself (corsica 3: an 8 m overpass). The procedural
 * ground (src/world/ground.ts) is single-valued: on the ribbon footprint the TOPMOST ribbon is the
 * surface, and the ribbon edges hang 50 m kerb faces. Under a deck both are wrong (the lower road's
 * wheel rays start "underground", the deck's kerbs wall the lower road off). Grade-separated road
 * samples (far apart along the road, footprints within 6 m in plan, > LEVEL_SEP_M apart vertically)
 * mark 4 m cells; only there does PortedGround answer by level (the WorldQuery yHint rule).
 */
export class CrossingZones {
  readonly any: boolean;
  private readonly cells = new Set<number>();
  private readonly cell = 4;
  constructor(road: RoadModel, closed: boolean, length: number) {
    const n = road.count;
    const G = 16;
    const key = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);
    const grid = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const k = key(Math.floor(road.cx[i] / G), Math.floor(road.cz[i] / G));
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(i);
    }
    let maxHw = 0;
    for (let i = 0; i < n; i++) maxHw = Math.max(maxHw, road.hw[i]);
    const reach = Math.ceil((2 * maxHw + 6) / G);
    const marked = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(road.cx[i] / G);
      const gz = Math.floor(road.cz[i] / G);
      for (let a = gx - reach; a <= gx + reach; a++) {
        for (let b = gz - reach; b <= gz + reach; b++) {
          const l = grid.get(key(a, b));
          if (!l) continue;
          for (const j of l) {
            if (j <= i) continue;
            let ds = Math.abs(road.s[j] - road.s[i]);
            if (closed) ds = Math.min(ds, length - ds);
            if (ds < 40 || Math.abs(road.cy[j] - road.cy[i]) <= LEVEL_SEP_M) continue;
            const h = Math.hypot(road.cx[j] - road.cx[i], road.cz[j] - road.cz[i]);
            if (h < road.hw[i] + road.hw[j] + 6) marked[i] = marked[j] = 1;
          }
        }
      }
    }
    const c = this.cell;
    let any = false;
    for (let i = 0; i < n; i++) {
      if (!marked[i]) continue;
      any = true;
      const r = road.hw[i] + 8;
      for (let x = Math.floor((road.cx[i] - r) / c); x <= Math.floor((road.cx[i] + r) / c); x++) {
        for (let z = Math.floor((road.cz[i] - r) / c); z <= Math.floor((road.cz[i] + r) / c); z++) this.cells.add(key(x, z));
      }
    }
    this.any = any;
  }
  /** THREE (x, z) inside a grade-separation zone? */
  has(x: number, z: number): boolean {
    return this.any && this.cells.has((Math.floor(x / this.cell) + 32768) * 65536 + (Math.floor(z / this.cell) + 32768));
  }
}

/** One ground level at a point (THREE space). */
interface Level {
  y: number;
  nx: number;
  ny: number;
  nz: number;
  material: number;
}

/**
 * The procedural ground of a ported stage: exactly src/world/ground.ts Ground everywhere except in the
 * grade-separation zones, where it is multi-level — point queries pick the level by the WorldQuery yHint
 * rule (highest ground at or below yHint + 1 m, else the lowest above; no hint = the topmost, unchanged),
 * a ray origin is underground only against the level of its own height, the terrain only counts for rays
 * that start above it, and kerb faces hit deeper than DECK_KERB_M below their ribbon edge (an upper deck's,
 * hanging over the lower road) are passed through.
 */
export class PortedGround extends Ground {
  readonly zones: CrossingZones;
  private readonly lv: Level = { y: 0, nx: 0, ny: 1, nz: 0, material: 0 };
  private readonly ra: RoadHit = { t: 0, nx: 0, ny: 1, nz: 0, px: 0, py: 0, pz: 0, material: 0 };
  private readonly rb: RoadHit = { t: 0, nx: 0, ny: 1, nz: 0, px: 0, py: 0, pz: 0, material: 0 };
  private readonly tb: TerrainHit = { t: 0, nx: 0, ny: 1, nz: 0, px: 0, py: 0, pz: 0, material: 0 };
  private readonly nn = new Float64Array(3);
  constructor(terrain: Terrain, road: RoadModel, zones: CrossingZones) {
    super(terrain, road);
    this.zones = zones;
  }

  /** The ground level at THREE (x, z) for a sim/three height hint, into this.lv. */
  private level(x: number, z: number, yHint: number): boolean {
    const road = this.road;
    const terr = this.terrain;
    const Y0 = yHint + GROUND_HINT_ABOVE_M;
    const lv = this.lv;
    const ht = terr.heightAt(x, z);
    const hasT = Number.isFinite(ht);
    if (road.raycast(x, Y0, z, 0, -1, 0, 1e4, this.ra)) {
      let yr = Y0 - this.ra.t;
      // the topmost ribbon: its exact triangle height (as Ground.height), not the ray's rounding
      const top = road.heightAt(x, z);
      if (Math.abs(top - yr) < 1e-6) yr = top;
      // the terrain is a different level only where it rises clearly above this ribbon (a hillside)
      if (!(hasT && ht <= Y0 && ht > yr + 0.5)) return this.setLevelRoad(yr, this.ra);
    }
    if (hasT && ht <= Y0) return this.setLevelTerrain(x, z, ht);
    // nothing at or below the hint: the lowest ground above it
    const up = road.raycast(x, Y0, z, 0, 1, 0, 1e4, this.ra) ? Y0 + this.ra.t : Infinity;
    if (hasT && ht < up) return this.setLevelTerrain(x, z, ht);
    if (up < Infinity) return this.setLevelRoad(up, this.ra);
    lv.y = NaN;
    return false;
  }
  private setLevelRoad(y: number, h: RoadHit): boolean {
    const lv = this.lv;
    lv.y = y;
    // vertical rays report the ribbon triangle normal (kerbs are skipped for rays without a horizontal part)
    lv.nx = h.nx;
    lv.ny = h.ny;
    lv.nz = h.nz;
    lv.material = h.material;
    return true;
  }
  private setLevelTerrain(x: number, z: number, y: number): boolean {
    const lv = this.lv;
    lv.y = y;
    this.terrain.normalAt(x, z, this.nn);
    lv.nx = this.nn[0];
    lv.ny = this.nn[1];
    lv.nz = this.nn[2];
    lv.material = this.terrain.materialAt(x, z);
    return true;
  }

  heightAtLevel(x: number, z: number, yHint?: number): number {
    if (yHint === undefined || !Number.isFinite(yHint) || !this.zones.has(x, z)) return this.height(x, z);
    return this.level(x, z, yHint) ? this.lv.y : this.height(x, z);
  }
  normalAtLevel(x: number, z: number, out: Float64Array, yHint?: number): void {
    if (yHint !== undefined && Number.isFinite(yHint) && this.zones.has(x, z) && this.level(x, z, yHint)) {
      out[0] = this.lv.nx;
      out[1] = this.lv.ny;
      out[2] = this.lv.nz;
    } else this.normal(x, z, out);
  }
  materialAtLevel(x: number, z: number, yHint?: number): number {
    if (yHint !== undefined && Number.isFinite(yHint) && this.zones.has(x, z) && this.level(x, z, yHint)) return this.lv.material;
    return this.material(x, z);
  }

  /** A kerb-face hit (no ribbon surface at the point) deeper than DECK_KERB_M below the ribbon above it. */
  private deckKerb(h: RoadHit): boolean {
    const road = this.road;
    if (road.raycast(h.px, h.py + 0.05, h.pz, 0, -1, 0, 0.1, this.rb)) return false;
    let top = Infinity;
    for (const [ex, ez] of [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]] as const) {
      if (road.raycast(h.px + ex, h.py, h.pz + ez, 0, 1, 0, 60, this.rb)) top = Math.min(top, this.rb.t);
    }
    return top < Infinity && top > DECK_KERB_M;
  }

  override raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, hit: GroundHit): boolean {
    const zs = this.zones;
    if (!zs.any || !(maxT >= 0) || !Number.isFinite(ox + oy + oz + dx + dy + dz)) return super.raycast(ox, oy, oz, dx, dy, dz, maxT, hit);
    if (!zs.has(ox, oz) && !zs.has(ox + dx * maxT, oz + dz * maxT)) return super.raycast(ox, oy, oz, dx, dy, dz, maxT, hit);
    // underground only against the level of the origin's own height
    if (this.level(ox, oz, oy) && oy <= this.lv.y) {
      const lv = this.lv;
      hit.t = 0;
      hit.px = ox;
      hit.py = lv.y;
      hit.pz = oz;
      hit.nx = lv.nx;
      hit.ny = lv.ny;
      hit.nz = lv.nz;
      hit.material = lv.material;
      return true;
    }
    if (maxT === 0) return false;
    // nearest ribbon hit, passing through an upper deck's kerb faces
    const road = this.road;
    const rh = this.ra;
    let t0 = 0;
    let roadHit = false;
    for (let k = 0; k < 4 && t0 < maxT; k++) {
      if (!road.raycast(ox + dx * t0, oy + dy * t0, oz + dz * t0, dx, dy, dz, maxT - t0, rh)) break;
      if (!this.deckKerb(rh)) {
        rh.t += t0;
        roadHit = true;
        break;
      }
      t0 += rh.t + 1e-3;
    }
    const limit = roadHit ? rh.t : maxT;
    // the single-valued terrain is one level: it only counts for rays that start above it
    const ht = this.terrain.heightAt(ox, oz);
    const terrHit = !(oy < ht) && this.terrain.raycast(ox, oy, oz, dx, dy, dz, limit, this.tb);
    const src = terrHit && (!roadHit || this.tb.t < rh.t - 1e-6) ? this.tb : roadHit ? rh : null;
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

/**
 * The SIM-space WorldQuery of a ported stage: ground.ts makeWorldQuery, with the point queries honouring
 * `yHint` inside the grade-separation zones (PortedGround). Identical to makeWorldQuery without zones.
 */
export function makePortedWorldQuery(ground: PortedGround, obstacles: ObstacleSet): WorldQuery {
  const base = makeWorldQuery(ground, obstacles);
  if (!ground.zones.any) return base;
  const n3 = new Float64Array(3);
  const wq: WorldQuery = {
    raycast: base.raycast,
    segment(o: SimV3, ray: SimV3, slot?: number, out?: RayHit): RayHit | null {
      return segmentViaRaycast(wq, o, ray, slot, out);
    },
    heightAt(x: number, z: number, yHint?: number): number {
      const h = ground.heightAtLevel(x, -z, yHint);
      return Number.isFinite(h) ? h : 0;
    },
    normalAt(x: number, z: number, yHint?: number): SimV3 {
      ground.normalAtLevel(x, -z, n3, yHint);
      return { x: n3[0], y: n3[1], z: -n3[2] };
    },
    materialAt(x: number, z: number, yHint?: number): number {
      return ground.materialAtLevel(x, -z, yHint);
    },
    surfaceAt(x: number, z: number, yHint?: number): SurfaceId | null {
      const m = ground.materialAtLevel(x, -z, yHint);
      return m < MATERIAL_SOLID_MIN ? surfaceFromMaterial(m) : null;
    },
    obstaclesNear: base.obstaclesNear,
  };
  return wq;
}

// ------------------------------------------------------------------------------------------- pipeline

export function buildPortedStage(recipe: PortedRecipe, seed: number): BuiltStage {
  const { meta, data, family } = recipe;
  const base = (hashSeed(meta.id) ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0;
  const sub = (tag: string): number => (hashSeed(tag) ^ base) >>> 0;

  // ---- 1. real road geometry
  const sec = portedRoadSection(data);
  const cl = sec.cl;
  const n = cl.n;
  const ds = cl.ds;
  const L = cl.length;

  // ---- 2. race settings (ported verbatim; the centre line runs on past an archive finish beyond its end)
  const rs = portedRaceSettings(data, L);
  const startS = rs.startS;
  const finishS = rs.finishS;
  const checkpoints = [...rs.checkpoints];
  const validRange: [number, number] = [rs.validRange[0], rs.validRange[1]];

  // ---- 3. surfaces + cross-section (real widths + cross-fall from the edge splines)
  const mix = family.mix[layoutKey(data.archive)] ?? family.mixDefault;
  // the original's road material under the centre line (Track.gcm runs); the family mix only without them
  const material =
    data.roadMaterial.length > 0
      ? origRoadMaterials(data.roadMaterial, n, ds, MATERIAL[mix.base])
      : portedMaterials(mix, sub('surfaces'), n, data.closed, [startS]);
  const realWidth = new Float64Array(n);
  for (let i = 0; i < n; i++) realWidth[i] = sec.halfL[i] + sec.halfR[i];
  // the real widths, capped only where a cross-section would fold over the next (hairpin apexes)
  const width = foldFreeWidths(cl, realWidth);
  const bank = new Float64Array(n);
  const crown = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // cross-fall from the edge elevations, measured at the REAL edges
    const w = Math.max(2, realWidth[i]);
    const b = Math.atan2(sec.edgeYL[i] - sec.edgeYR[i], w);
    bank[i] = Math.max(-0.14, Math.min(0.14, b));
    crown[i] = family.crown(surfaceOf(material[i]));
  }
  const bankS = gaussianSmooth(bank, 12, data.closed);
  cl.setElevation(sec.y);

  // forced road samples: surface boundaries (and the start / finish lines)
  const forced = new Set<number>();
  for (let i = 1; i < n; i++) if (material[i] !== material[i - 1]) forced.add(i);
  const cs = { width, bank: bankS, crown, material };
  const road = new RoadModel(cl, cs, forced);

  // ---- 4. terrain draped to the real road
  const natural = drapedNatural(cl, sec.y, family, sub('terrain'));
  const gnoise = new Noise2D(sub('groundmat'));
  const margin = 40;
  const minX = road.minX - margin, maxX = road.maxX + margin;
  const minZ = road.minZ - margin, maxZ = road.maxZ + margin;
  const MAX_VERTS = 400_000;
  let cell = Math.max(2, Math.sqrt(((maxX - minX) * (maxZ - minZ)) / MAX_VERTS));
  cell = Math.ceil(cell * 4) / 4;
  while ((Math.ceil((maxX - minX) / cell) + 1) * (Math.ceil((maxZ - minZ) / cell) + 1) > MAX_VERTS) cell += 0.25;
  const nx = Math.ceil((maxX - minX) / cell) + 1;
  const nz = Math.ceil((maxZ - minZ) / cell) + 1;
  const tr = buildTerrain(
    {
      originX: Math.floor(minX),
      originZ: Math.floor(minZ),
      cellSize: cell,
      nx,
      nz,
      natural,
      carve: family.carve(cell),
      material: (c: MaterialContext) => family.groundMat(c, gnoise),
    },
    road,
  );
  const terrain = new Terrain(tr.hf);
  const ground = new PortedGround(terrain, road, new CrossingZones(road, data.closed, L));

  // ---- 5. scenery (procedural, neutral) + pacenotes (real corners + crest hazards)
  const corners = analyzeCorners(cl);
  const fast = new Float64Array(n);
  {
    const w = Math.round(50 / ds);
    for (let i = 0; i < n; i++) {
      let km = 0;
      for (let j = i - w; j <= i + w; j += 2) km = Math.max(km, Math.abs(cl.kappa[cl.idx(j)]));
      const r = km > 1e-9 ? 1 / km : 1e9;
      fast[i] = Math.min(1, Math.max(0, (r - 60) / 140));
    }
  }
  const fastAt = (s: number): number => cl.sample(fast, s);
  const hwAt = (s: number): number => cl.sample(width, s) / 2;
  const env: SceneryEnv = {
    cl,
    ground,
    hwAt,
    fastAt,
    bounds: { minX: terrain.ox, maxX: terrain.maxX, minZ: terrain.oz, maxZ: terrain.maxZ },
    edgeDistApprox: (x, z) => {
      const ix = Math.round((x - terrain.ox) / terrain.cs);
      const iz = Math.round((z - terrain.oz) / terrain.cs);
      if (ix < 0 || iz < 0 || ix >= terrain.nx || iz >= terrain.nz) return 1e9;
      return tr.edgeDist[iz * terrain.nx + ix];
    },
  };
  const placer = new SceneryPlacer(env, new Rng(sub('scenery')));
  const sctx: PortedSceneryCtx = { cl, corners, startS, finishS, closed: data.closed, rng: new Rng(sub('scenery-script')) };
  family.scenery(placer, sctx);
  // gates over the ported timing lines
  placer.gate('startGate', startS);
  if (!data.closed) {
    for (const c of checkpoints) placer.gate('checkpointGate', c);
    placer.gate('finishGate', finishS);
  }
  const scenery = placer.out;
  const obstacles = new ObstacleSet(scenery);

  let pacenotes: Pacenote[] = [];
  if (data.pacenotes.length > 0) {
    // the original co-driver notes (PaceNotes.con, the rally / hill-climb archives)
    pacenotes = portedPacenotes(data.pacenotes, rs.shift, corners, L);
  } else if (!data.closed) {
    // fallback for an open archive without notes (none ship): generated from the real geometry
    const hazards = portedHazards(cl);
    const surfaceChanges: { s: number; to: SurfaceId }[] = [];
    for (let i = 1; i < n; i++) {
      if (material[i] !== material[i - 1]) surfaceChanges.push({ s: i * ds, to: surfaceOf(material[i]) });
    }
    pacenotes = generatePacenotes({
      cl,
      gripG: (s) => NOTE_GRIP_G[surfaceOf(material[Math.min(n - 1, Math.max(0, Math.round(s / ds)))])] ?? 1.45,
      corners,
      startS,
      finishS,
      hazards,
      surfaceChanges,
    });
  }

  const stage = new ProcStage({
    meta,
    seed,
    cl,
    road,
    startS,
    finishS,
    checkpoints,
    validRange,
    environment: environmentFor(meta.env),
    terrain: tr,
    scenery,
    pacenotes,
    labels: [],
  });
  return { stage: withSpawn(stage, rs), world: makePortedWorldQuery(ground, obstacles) };
}

function layoutKey(archive: string): string {
  const m = /^(?:corsica|hillclimb|iceracing|kenya|newzealand|rallycross)(\d+[a-c]?)/.exec(archive);
  return m ? m[1] : '';
}