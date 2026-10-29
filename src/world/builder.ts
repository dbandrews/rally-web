/**
 * src/world/builder.ts — the procedural stage pipeline shared by every stage:
 *
 *   layout (control points, retried until clearance / curvature / size limits pass)
 *   → centre line (centripetal Catmull-Rom, ≈1 m resampling)
 *   → elevation (natural terrain under the line, smoothed, grade-limited, + crests / jumps / dips)
 *   → cross-sections (width, crown, bank, surface) → road ribbon + physics surface
 *   → heightfield (noise terrain carved to the road) + materials
 *   → corners → scenery (+ obstacles) → pacenotes → Stage (THREE space) + WorldQuery (SIM space)
 */
import { MATERIAL, surfaceFromMaterial } from '../core/constants';
import { hashSeed, Rng } from '../core/rng';
import type {
  BuiltStage,
  Discipline,
  Pacenote,
  RoadSample,
  SceneryInstance,
  Stage,
  StagePose,
  StageProjection,
  SurfaceId,
  ThreeV3,
  TyreType,
  StageLabel,
} from '../core/types';
import { Centerline } from './centerline';
import { analyzeCorners, type Corner } from './corners';
import { environmentFor, type WorldEnvironment } from './environments';
import { Ground, makeWorldQuery, ObstacleSet } from './ground';
import { Noise1D } from './noise';
import { generatePacenotes, NOTE_GRIP_G, type PacenoteHazard } from './pacenotes';
import { featureOffset, gaussianSmooth, gradeLimit, type ElevationFeature } from './profile';
import { RoadModel, type CrossSection } from './road';
import { SceneryPlacer, type SceneryEnv } from './scenery';
import type { LayoutOut } from './layouts';
import { Terrain } from './terrain';
import { buildTerrain, type CarveOptions, type MaterialContext, type TerrainResult } from './terrainGen';

export interface StageMeta {
  id: string;
  name: string;
  discipline: Discipline;
  description: string;
  closed: boolean;
  laps: number;
  defaultTyre: TyreType;
  approxLength: number;
  env: string;
}

/** A text label placed in the world (testpad patch names): Stage.labels of the contract. */
export type { StageLabel };

/** Everything a stage recipe can read while placing features, surfaces and scenery. */
export interface BuildContext {
  seed: number;
  rng: Rng;
  cl: Centerline;
  /** Marks of the chosen layout (path arc lengths, pairs [s0, s1] per tagged feature). */
  marks: Record<string, number[]>;
  natural: (x: number, z: number) => number;
  corners: Corner[];
  features: ElevationFeature[];
  /** Material per centre-line point (after surfaces()). */
  material: Uint8Array;
  width: Float64Array;
  hwAt: (s: number) => number;
  fastAt: (s: number) => number;
  startS: number;
  finishS: number;
  /** Set after the terrain exists. */
  ground?: Ground;
  terrain?: TerrainResult;
}

export interface ProcRecipe {
  meta: StageMeta;
  /** Control points (THREE xz) + named marks for one layout attempt. */
  layout: (rng: Rng) => LayoutOut;
  layoutLimits: { minRadius: number; farClear: number; maxArea: number; attempts?: number };
  natural: (seed: number, cl: Centerline) => (x: number, z: number) => number;
  /** Road elevation from the natural terrain: smoothing sigma (m), grade limit, grade limit in hairpins. */
  profile: { sigma: number; gradeMax: number; hairpinGrade: number; base?: (x: number, z: number, s: number) => number };
  width: { base: number; vary: number; hairpinWiden: number };
  crown: (surface: SurfaceId) => number;
  bank: { gain: number; max: number };
  /** Elevation features placed on the centre line. */
  features: (ctx: BuildContext) => ElevationFeature[];
  /** Road surface per centre-line point. */
  surfaces: (ctx: BuildContext) => Uint8Array;
  carve: (cellSize: number) => CarveOptions | null;
  margin: number;
  minCell?: number;
  material: (c: MaterialContext, ctx: BuildContext) => number;
  scenery: (p: SceneryPlacer, ctx: BuildContext) => void;
  pacenotes: boolean;
  /** Drop on the given side at s (Col du Vent): adds "caution" notes. */
  exposed?: (s: number, side: number, ctx: BuildContext) => boolean;
  /** Open stages: start / finish distances from the ends. */
  startS?: number;
  finishBeforeEnd?: number;
  /** Extra hazards for notes (beyond crest/jump/dip features). */
  hazards?: (ctx: BuildContext) => PacenoteHazard[];
  labels?: (ctx: BuildContext) => StageLabel[];
}

const MAX_VERTS = 400_000;

/** Concrete Stage (THREE space). Extra (non-contract) field: labels. */
export class ProcStage implements Stage {
  readonly id: string;
  readonly name: string;
  readonly discipline: Discipline;
  readonly description: string;
  readonly seed: number;
  readonly closed: boolean;
  readonly laps: number;
  readonly length: number;
  readonly defaultTyre: TyreType;
  readonly startS: number;
  readonly startPose: StagePose;
  readonly checkpoints: number[];
  readonly finishS: number;
  readonly validRange: [number, number];
  readonly environment: WorldEnvironment;
  readonly heightfield: TerrainResult['hf'];
  readonly road: RoadSample[];
  readonly scenery: SceneryInstance[];
  readonly pacenotes: Pacenote[];
  readonly labels: StageLabel[];
  private readonly cl: Centerline;
  private readonly rm: RoadModel;

  constructor(o: {
    meta: StageMeta; seed: number; cl: Centerline; road: RoadModel; startS: number; finishS: number; checkpoints: number[];
    validRange: [number, number]; environment: WorldEnvironment; terrain: TerrainResult; scenery: SceneryInstance[];
    pacenotes: Pacenote[]; labels: StageLabel[];
  }) {
    this.id = o.meta.id;
    this.name = o.meta.name;
    this.discipline = o.meta.discipline;
    this.description = o.meta.description;
    this.seed = o.seed;
    this.closed = o.meta.closed;
    this.laps = o.meta.laps;
    this.defaultTyre = o.meta.defaultTyre;
    this.cl = o.cl;
    this.rm = o.road;
    this.length = o.cl.length;
    this.startS = o.startS;
    this.finishS = o.finishS;
    this.checkpoints = o.checkpoints;
    this.validRange = o.validRange;
    this.environment = o.environment;
    this.heightfield = o.terrain.hf;
    this.road = o.road.samples;
    this.scenery = o.scenery;
    this.pacenotes = o.pacenotes;
    this.labels = o.labels;
    this.startPose = { pos: this.pointAt(o.startS), dir: this.tangentAt(o.startS) };
  }
  pointAt(s: number): ThreeV3 {
    return this.cl.pointAt(s);
  }
  tangentAt(s: number): ThreeV3 {
    return this.cl.tangentAt(s);
  }
  roadAt(s: number): RoadSample {
    return this.rm.roadAt(this.cl.normS(s));
  }
  project(posThree: ThreeV3, hintS?: number): StageProjection {
    return this.cl.project(posThree, hintS);
  }
}

// ------------------------------------------------------------------------------------------- helpers

/** Layout quality: curvature, self-clearance and size. Returns 0 when valid (else a violation score). */
export function layoutViolation(cl: Centerline, halfWidth: number, lim: ProcRecipe['layoutLimits']): number {
  let v = 0;
  const kMax = 1 / lim.minRadius;
  for (let i = 0; i < cl.n; i++) {
    const over = Math.abs(cl.kappa[i]) - kMax * 1.25;
    if (over > 0) v += over * 50;
  }
  const near = 2 * halfWidth + 8;
  const far = lim.farClear;
  const step = Math.max(1, Math.round(3 / cl.ds));
  const L = cl.length;
  let worst = 0;
  for (let i = 0; i < cl.n; i += step) {
    const si = i * cl.ds;
    cl.forSegmentsNear(cl.x[i], cl.z[i], far + 2, (k, d) => {
      let gap = Math.abs(si - k * cl.ds);
      if (cl.closed) gap = Math.min(gap, L - gap);
      if (gap < 40) return;
      const t = Math.min(1, Math.max(0, (gap - 40) / 360));
      const req = near + (far - near) * t * t * (3 - 2 * t);
      if (req - d > worst) worst = req - d;
    });
  }
  v += worst;
  const area = (cl.maxX - cl.minX) * (cl.maxZ - cl.minZ);
  if (area > lim.maxArea) v += (area - lim.maxArea) / 10000;
  return v;
}

/** s positions where the line is straight (|κ| < kLim) for ±half metres, inside [from, to]. */
export function straightSpots(cl: Centerline, half: number, from: number, to: number, kLim = 1 / 450): number[] {
  const out: number[] = [];
  const w = Math.round(half / cl.ds);
  for (let i = 0; i < cl.n; i++) {
    const s = i * cl.ds;
    if (s < from || s > to) continue;
    let ok = true;
    for (let j = i - w; j <= i + w; j++) {
      if (!cl.closed && (j < 0 || j >= cl.n)) {
        ok = false;
        break;
      }
      if (Math.abs(cl.kappa[cl.idx(j)]) > kLim) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(s);
  }
  return out;
}

/** Pick up to n positions from candidates, at least `gap` apart, spread along the stage. */
export function pickSpread(rng: Rng, cands: number[], n: number, gap: number, avoid: number[] = []): number[] {
  const picked: number[] = [];
  const pool = cands.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }
  for (const s of pool) {
    if (picked.length >= n) break;
    if (picked.every((p) => Math.abs(p - s) >= gap) && avoid.every((p) => Math.abs(p - s) >= gap * 0.5)) picked.push(s);
  }
  return picked.sort((a, b) => a - b);
}

/**
 * Coarse horizontal distance to the centre line (bilinear on a `cell` m grid, exact within ~cell/2),
 * saturating at maxDist. Cheap enough for natural-terrain functions that want to keep features away
 * from (or near) the road.
 */
export function centerlineDistanceField(cl: Centerline, cell: number, maxDist: number): (x: number, z: number) => number {
  const pad = maxDist + cell;
  const ox = cl.minX - pad;
  const oz = cl.minZ - pad;
  const nx = Math.ceil((cl.maxX - cl.minX + 2 * pad) / cell) + 1;
  const nz = Math.ceil((cl.maxZ - cl.minZ + 2 * pad) / cell) + 1;
  const d = new Float32Array(nx * nz).fill(maxDist);
  const step = Math.max(1, Math.round(Math.min(cell, 4) / cl.ds));
  const r = Math.ceil(maxDist / cell);
  for (let i = 0; i < cl.n; i += step) {
    const px = cl.x[i];
    const pz = cl.z[i];
    const cx = Math.round((px - ox) / cell);
    const cz = Math.round((pz - oz) / cell);
    for (let iz = Math.max(0, cz - r); iz <= Math.min(nz - 1, cz + r); iz++) {
      for (let ix = Math.max(0, cx - r); ix <= Math.min(nx - 1, cx + r); ix++) {
        const v = Math.hypot(ox + ix * cell - px, oz + iz * cell - pz);
        const k = iz * nx + ix;
        if (v < d[k]) d[k] = v;
      }
    }
  }
  return (x: number, z: number): number => {
    const gx = (x - ox) / cell;
    const gz = (z - oz) / cell;
    if (gx < 0 || gz < 0 || gx >= nx - 1 || gz >= nz - 1) return maxDist;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const k = iz * nx + ix;
    const a = d[k] + (d[k + 1] - d[k]) * fx;
    const b = d[k + nx] + (d[k + nx + 1] - d[k + nx]) * fx;
    return a + (b - a) * fz;
  };
}

/** Material array from a base surface and [from, to) sections (m). */
export function sectionMaterials(cl: Centerline, base: SurfaceId, sections: { from: number; to: number; surface: SurfaceId }[]): Uint8Array {
  const m = new Uint8Array(cl.n).fill(MATERIAL[base]);
  for (const sec of sections) {
    for (let i = 0; i < cl.n; i++) {
      const s = i * cl.ds;
      if (s >= sec.from && s < sec.to) m[i] = MATERIAL[sec.surface];
    }
  }
  return m;
}

// ------------------------------------------------------------------------------------------- pipeline

export function buildProcStage(recipe: ProcRecipe, seed: number): BuiltStage {
  const meta = recipe.meta;
  const base = (hashSeed(meta.id) ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0;
  const sub = (tag: string): number => (hashSeed(tag) ^ base) >>> 0;

  // ---- 1. layout with retries
  const attempts = recipe.layoutLimits.attempts ?? 60;
  let cl: Centerline | null = null;
  let marks: Record<string, number[]> = {};
  let bestV = Infinity;
  for (let a = 0; a < attempts; a++) {
    const rng = new Rng(sub(`layout:${a}`));
    const lo = recipe.layout(rng);
    const cand = new Centerline(lo.control, meta.closed, 1);
    const v = layoutViolation(cand, recipe.width.base / 2 + 1, recipe.layoutLimits);
    if (v < bestV) {
      bestV = v;
      cl = cand;
      marks = lo.marks;
    }
    if (v <= 0) break;
  }
  if (!cl) throw new Error(`stage ${meta.id}: no layout`);
  const n = cl.n;
  const ds = cl.ds;
  const L = cl.length;

  // ---- 2. elevation
  const natural = recipe.natural(sub('terrain'), cl);
  const y0 = new Float64Array(n);
  for (let i = 0; i < n; i++) y0[i] = recipe.profile.base ? recipe.profile.base(cl.x[i], cl.z[i], i * ds) : natural(cl.x[i], cl.z[i]);
  const ks = gaussianSmooth(cl.kappa, 6 / ds, cl.closed);
  const gmax = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hp = Math.min(1, Math.max(0, (Math.abs(ks[i]) - 1 / 60) / (1 / 20 - 1 / 60)));
    gmax[i] = recipe.profile.gradeMax + (recipe.profile.hairpinGrade - recipe.profile.gradeMax) * hp;
  }
  let y = gaussianSmooth(y0, recipe.profile.sigma / ds, cl.closed);
  y = gradeLimit(y, gaussianSmooth(gmax, 10 / ds, cl.closed), ds, cl.closed);
  y = gaussianSmooth(y, 3 / ds, cl.closed);
  cl.setElevation(y);

  const startS = meta.closed ? 0 : (recipe.startS ?? 40);
  const finishS = meta.closed ? 0 : L - (recipe.finishBeforeEnd ?? 80);
  // timing: rally stages split into quarters, circuits into lap thirds
  let checkpoints: number[];
  let validRange: [number, number];
  if (meta.closed) {
    checkpoints = [L / 3, (2 * L) / 3];
    validRange = [0, L];
  } else {
    const span = finishS - startS;
    checkpoints = [0.25, 0.5, 0.75].map((f) => Math.round(startS + span * f));
    validRange = [Math.max(0, startS - 30), L];
  }

  // corners on the final horizontal geometry
  const corners = analyzeCorners(cl);

  // width
  const wn = new Noise1D(sub('width'));
  const ksW = gaussianSmooth(cl.kappa, 8 / ds, cl.closed);
  const width = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(ksW[i]);
    const hp = Math.min(1, Math.max(0, (k - 1 / 45) / (1 / 12 - 1 / 45)));
    width[i] = recipe.width.base + recipe.width.vary * wn.at((i * ds) / 70) + recipe.width.hairpinWiden * hp;
  }
  const hwAt = (s: number): number => cl.sample(width, s) / 2;
  // fast factor: local max curvature within ±50 m
  const fast = new Float64Array(n);
  {
    const w = Math.round(50 / ds);
    for (let i = 0; i < n; i++) {
      let km = 0;
      for (let j = i - w; j <= i + w; j += 2) km = Math.max(km, Math.abs(ks[cl.idx(j)]));
      const r = km > 1e-9 ? 1 / km : 1e9;
      fast[i] = Math.min(1, Math.max(0, (r - 60) / 140));
    }
  }
  const fastAt = (s: number): number => cl.sample(fast, s);

  const ctx: BuildContext = {
    seed,
    rng: new Rng(sub('features')),
    cl,
    marks,
    natural,
    corners,
    features: [],
    material: new Uint8Array(n),
    width,
    hwAt,
    fastAt,
    startS,
    finishS,
  };

  // ---- 3. elevation features
  ctx.features = recipe.features(ctx);
  if (ctx.features.length) {
    const yf = Float64Array.from(cl.y);
    for (const f of ctx.features) {
      const i0 = Math.floor((f.s - f.before) / ds);
      const i1 = Math.ceil((f.s + f.after) / ds);
      for (let i = i0; i <= i1; i++) {
        const ii = cl.idx(i);
        if (!cl.closed && (i < 0 || i >= n)) continue;
        let u = i * ds - f.s;
        if (cl.closed) u = ((u + L / 2) % L + L) % L - L / 2;
        yf[ii] += featureOffset(f, u);
      }
    }
    cl.setElevation(yf);
  }

  // ---- 4. cross-sections
  ctx.rng = new Rng(sub('surfaces'));
  ctx.material = recipe.surfaces(ctx);
  const ksB = gaussianSmooth(cl.kappa, 12 / ds, cl.closed);
  const cs: CrossSection = {
    width,
    bank: new Float64Array(n),
    crown: new Float64Array(n),
    material: ctx.material,
  };
  for (let i = 0; i < n; i++) {
    cs.bank[i] = Math.max(-recipe.bank.max, Math.min(recipe.bank.max, recipe.bank.gain * ksB[i]));
    cs.crown[i] = recipe.crown(surfaceOf(ctx.material[i]));
  }
  // forced samples: jump lips, crest tops, surface boundaries
  const forced = new Set<number>();
  for (const f of ctx.features) forced.add(cl.idx(Math.round(f.s / ds)));
  for (let i = 1; i < n; i++) if (ctx.material[i] !== ctx.material[i - 1]) forced.add(i);
  const road = new RoadModel(cl, cs, forced);

  // ---- 5. heightfield
  const margin = recipe.margin;
  const minX = road.minX - margin, maxX = road.maxX + margin;
  const minZ = road.minZ - margin, maxZ = road.maxZ + margin;
  const area = (maxX - minX) * (maxZ - minZ);
  let cell = Math.max(recipe.minCell ?? 2, Math.sqrt(area / MAX_VERTS));
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
      carve: recipe.carve(cell),
      material: (c) => recipe.material(c, ctx),
    },
    road,
  );
  const terrain = new Terrain(tr.hf);
  const ground = new Ground(terrain, road);
  ctx.ground = ground;
  ctx.terrain = tr;

  // ---- 6. scenery
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
  ctx.rng = new Rng(sub('scenery-script'));
  recipe.scenery(placer, ctx);
  // split gates over the timed checkpoints of point-to-point stages (the renderer draws gates from these)
  if (!meta.closed) for (const c of checkpoints) placer.gate('checkpointGate', c);
  const scenery = placer.out;
  const obstacles = new ObstacleSet(scenery);

  // ---- 7. pacenotes (timing was computed with the start / finish above)
  let pacenotes: Pacenote[] = [];
  if (recipe.pacenotes && !meta.closed) {
    const hazards: PacenoteHazard[] = [];
    for (const f of ctx.features) {
      if (f.kind === 'crest') hazards.push({ s: f.s, kind: 'crest' });
      else if (f.kind === 'jump' || f.kind === 'tabletop') hazards.push({ s: f.s, kind: 'jump' });
      else if (f.kind === 'dip' && f.tag === 'water') hazards.push({ s: f.s, kind: 'water' });
    }
    if (recipe.hazards) hazards.push(...recipe.hazards(ctx));
    const surfaceChanges: { s: number; to: SurfaceId }[] = [];
    for (let i = 1; i < n; i++) {
      if (ctx.material[i] !== ctx.material[i - 1]) {
        const to = surfaceOf(ctx.material[i]);
        // the water splash is called as "water", not as a surface change
        if (to === 'water' || surfaceOf(ctx.material[i - 1]) === 'water') continue;
        surfaceChanges.push({ s: i * ds, to });
      }
    }
    pacenotes = generatePacenotes({
      cl,
      gripG: (s) => NOTE_GRIP_G[surfaceOf(ctx.material[Math.min(n - 1, Math.max(0, Math.round(s / ds)))])] ?? 1.45,
      corners,
      startS,
      finishS,
      hazards,
      surfaceChanges,
      exposed: recipe.exposed ? (s, side) => recipe.exposed!(s, side, ctx) : undefined,
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
    labels: recipe.labels ? recipe.labels(ctx) : [],
  });
  return { stage, world: makeWorldQuery(ground, obstacles) };
}

export const surfaceOf = (m: number): SurfaceId => surfaceFromMaterial(m) ?? 'tarmac';
