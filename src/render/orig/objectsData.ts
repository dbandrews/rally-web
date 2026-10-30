/**
 * src/render/orig/objectsData.ts — the objects part's data contract (stages/<id>/objects.json + objects.bin,
 * written by tools/assets/parts/objects.py) and the pure per-instance maths of the original's object drawing:
 * ObjectDrawer view-distance / size culling and fades, StandardMesh LOD choice, TreeMesh sort-copy choice, the
 * HotSpot regulator. No three.js here (unit-tested in tests/render/origObjects*.test.ts).
 *
 * Sources: research/formats/objects.md, standardmesh.md (§2.5 LOD, §3 sort variants), environment.md §3.6;
 * the ObjectDrawer.Standard cull routine 0x6f2970 (decoded for this port, docs/orig/objects.md §Culling).
 */
import { regulateHotspot } from './hotspots';

/** Floats per instance in objects.bin (objects.py INST_*). */
export const INST_STRIDE = 24;
export const INST = {
  /** 3x4 THREE-space world matrix, row-major: row i = (L[i][0], L[i][1], L[i][2], t[i]). */
  ROW0: 0,
  ROW1: 4,
  ROW2: 8,
  /** TreeMesh colour byte/255 (r, g, b); 0.5 for other geometry. */
  COLOR: 12,
  SHADOW: 15,
  /** SIM local +Z on xz (normalised) and local +X on xz: tree sort-copy selection (standardmesh.md §3). */
  SORT_Z: 16,
  SORT_X: 18,
  /** Bounding radius of the scaled mesh bbox (radiusFromOrigin). */
  RADIUS: 20,
  MAX_SCALE: 21,
  /** Per-object random [0, 1) for objectDistanceVariation. */
  RND: 22,
} as const;

export interface ObjectsSettings {
  viewDistance: number;
  distanceFade: number;
  cullFade: number;
  cullConst: number;
  minCullDistance: number;
  variation: number;
  billboardLODScale: number;
  billboardFadeScale: number;
  mergeMeshViewDistance: number;
  lodDistanceScale: number;
  billboardLightScale: number;
  constantLightScale: number;
  /** True when the HotSpot regulator drives these values (then Global's unset fields are 0, like the engine). */
  regulated?: boolean;
  /** game.lightColor / game.shadowColor of the stage (diagnostics; the shaders read origUniforms). */
  lightColor?: number[];
  shadowColor?: number[];
}

/** Keys a HotSpot may override (objects.py HOTSPOT_FIELDS). */
export const HOTSPOT_KEYS = [
  'viewDistance',
  'distanceFade',
  'cullFade',
  'cullConst',
  'minCullDistance',
  'variation',
  'billboardLODScale',
  'billboardFadeScale',
  'mergeMeshViewDistance',
] as const;
export type HotspotKey = (typeof HOTSPOT_KEYS)[number];

export interface HotSpot extends Partial<Record<HotspotKey, number>> {
  name: string;
  splineDistance?: number;
  width?: number;
  fade?: number;
}

export interface SmMaterial {
  name: string;
  /** Index range in the LOD's index buffer. */
  start: number;
  count: number;
  transparent: boolean;
  twosided: boolean;
  hasShader: boolean;
}

export interface SmLod {
  vOffset: number;
  vCount: number;
  iOffset: number;
  iCount: number;
  iType: 'u16' | 'u32';
  materials: SmMaterial[];
}

export interface SmMesh {
  type: 'sm';
  file: string;
  animated: boolean;
  bboxSim: [number[], number[]];
  lods: (SmLod | null)[];
  windingAgreement: number;
  triangles: number[];
}

export interface TmEntry {
  /** First index (u16/u32 units) of copy 0; copy k starts at start + triCount·3·k (lists 0 and 2). */
  start: number;
  triCount: number;
}

export interface TmMesh {
  type: 'tm';
  file: string;
  bboxSim: [number[], number[]];
  vOffset: number;
  vCount: number;
  iOffset: number;
  iCount: number;
  iType: 'u16' | 'u32';
  sortDirections: number;
  /** [branches, trunk, sprites, facing] (standardmesh.md §3). */
  groups: [TmEntry[], TmEntry[], TmEntry[], TmEntry[]];
  /** THREE space. */
  crownCenter: [number, number, number];
  crownRadius: number;
  triangles: number[];
}

export type ObjMesh = SmMesh | TmMesh;

export interface ObjTemplate {
  name: string;
  kind: string;
  geometry: string | null;
  geometryType: string | null;
  mesh: number;
  skip?: string;
  /** GeometryTemplate `lighting` (library + lighting.con). */
  lighting: boolean;
  /** geometryTemplate.lightColor / shadowColor multipliers (lighting.con, default 1). */
  lightMul: [number, number, number];
  shadowMul: [number, number, number];
  lodDistances?: number[];
  sideScreen?: boolean;
  mergeable?: boolean;
  depthWrite?: boolean;
  trilinear?: boolean;
  gradiantFactor?: number;
  /** Billboard impostor (GeometryTemplate billboard 1): atlas Billboards/<geometry>.dds with `frames` (= n of
   *  billboardResolution w/h/n) side by side; `dirs` = the .tm sortDirections (the frame selector's N); quad extents of
   *  the template ctor 0x57b677: halfWidth = max |bbox x/z|, height = bbox.max.y − bbox.min.y, minY = bbox.min.y. */
  billboard?: {
    distance: number;
    resolution: number[];
    tex: string | null;
    frames?: number;
    dirs?: number;
    halfWidth?: number;
    minY?: number;
    height?: number;
  };
  /** StandardMesh: texId per LOD per material. */
  materialTex?: (string | null)[][];
  /** TreeMesh: texId per group list per entry. */
  groupTex?: (string | null)[][];
  instOffset: number;
  instCount: number;
}

export interface ObjectsJson {
  version: number;
  stage: { id: string; height: number; worldOffset: number[] };
  instStride: number;
  instOffset: number;
  instCount: number;
  binBytes: number;
  settings: ObjectsSettings;
  hotspots: HotSpot[];
  meshes: ObjMesh[];
  templates: ObjTemplate[];
  /** Mip level count of every texId the templates use (one-level textures must not use a mip filter). */
  texLevels: Record<string, number>;
  stats: { placements: number; templates: number; meshes: number; kinds: Record<string, number>; missingTextures: string[] };
}

export const OBJECTS_VERSION = 2;

export function validateObjectsJson(j: unknown): ObjectsJson {
  const o = j as ObjectsJson;
  if (!o || typeof o !== 'object') throw new Error('objects.json: not an object');
  if (o.version !== OBJECTS_VERSION) throw new Error(`objects.json: version ${o.version} (want ${OBJECTS_VERSION})`);
  if (o.instStride !== INST_STRIDE) throw new Error(`objects.json: instStride ${o.instStride}`);
  if (!Array.isArray(o.meshes) || !Array.isArray(o.templates)) throw new Error('objects.json: meshes/templates missing');
  return o;
}

// ------------------------------------------------------------------------------------------------ culling

const F32 = new Float32Array(1);
const I32 = new Int32Array(F32.buffer);

/**
 * The ObjectDrawer's square-root approximation (0x6f2abf, 0x6f2b53, 0x6f2b93, 0x6f2cde): the float bits shifted right
 * by one plus 0x1fc00000 (exact at even powers of two, up to ≈ 6 % high in between). The fades and the distance
 * slice use it; the view-distance and size culls compare squares (exact).
 */
export function fastSqrt(x: number): number {
  F32[0] = x;
  I32[0] = (I32[0] >> 1) + 0x1fc00000;
  return F32[0];
}

export interface CullParams {
  viewDistance: number;
  distanceFade: number;
  cullFade: number;
  cullConst: number;
  minCullDistance: number;
  variation: number;
}

/**
 * The ObjectDrawer constants of one frame, derived exactly like the engine derives them from the settings:
 *   kC2       0x936954 = 10·cot²(fov/2)·C²  recomputed at every traversal start from the camera FOV (0x6f2f90,
 *             called by 0x6f26a0 / 0x6f27a0), so the size cull is a projected-size test: d > √10·cot(fov/2)·C·r
 *   m2        0x936958 = M²                 (HotSpot push 0x49c807)
 *   invSpan   +0xc03c  = 1/(V − V·df), 1 when equal                      (setter 0x6f30a0)
 *   cfC       +0xc04c  = √(cf²·kC2)           invCfC +0xc048 = 1/(√kC2 − √kC2·cf)   (setter 0x6f3110)
 *   cfM       +0xc054  = √M²·cf               invCfM +0xc050 = 1/(√M² − √M²·cf)
 * (√ = fastSqrt everywhere the engine uses it).
 */
export interface CullFrame {
  viewDistance: number;
  distanceFade: number;
  variation: number;
  cullFade: number;
  kC2: number;
  m2: number;
  invSpan: number;
  cfC: number;
  invCfC: number;
  cfM: number;
  invCfM: number;
}

/** Size-cull camera factor 10·cot²(fov/2) (0x6f2f90; fov = the camera's field of view in radians). */
export function sizeCullFactor(fovRad: number): number {
  const x = fovRad * 0.5;
  const c = Math.cos(x) / Math.sin(x);
  return c * c * 10;
}

export function cullFrame(s: CullParams, fovRad: number, out?: CullFrame): CullFrame {
  const o = out ?? ({} as CullFrame);
  const V = s.viewDistance;
  const df = s.distanceFade;
  const cf = s.cullFade;
  const kC2 = sizeCullFactor(fovRad) * s.cullConst * s.cullConst;
  const m2 = s.minCullDistance * s.minCullDistance;
  o.viewDistance = V;
  o.distanceFade = df;
  o.variation = s.variation;
  o.cullFade = cf;
  o.kC2 = kC2;
  o.m2 = m2;
  o.invSpan = V * df === V ? 1 : 1 / (V - V * df);
  const sk = fastSqrt(kC2);
  o.cfC = fastSqrt(cf * kC2 * cf);
  o.invCfC = 1 / (sk - sk * cf);
  const sm = fastSqrt(m2);
  o.cfM = sm * cf;
  o.invCfM = 1 / (sm - sm * cf);
  return o;
}

/**
 * Per-object visibility of ObjectDrawer.Standard (0x6f2970), d² = |node centre − camera|² (3-D), r = node radius:
 *   a        = 1 − rnd·variation                                     (node+0x18 · objectDistanceVariation)
 *   culled when d² > (a·V + r)²                                      (view distance)
 *   culled when d² > kC2·r² and d² > M²                              (projected-size cull, see CullFrame)
 *   distFade = (√d² − (a·V·df + r))·invSpan/a           when d² > (a·V·df + r)²
 *   cullFade = (√(d²/r²) − cfC)·invCfC                  when d² > cf²·kC2·r²; when d² < M² also
 *              min(·, (√d² − cfM)·invCfM)
 *   both clamped 0..1, fade = max(distFade, cullFade); drawn with alpha (1 − fade) (TFACTOR alpha / inst+0x54)
 * √ = fastSqrt (the original's bit trick). Returns the alpha (0 = culled).
 */
export function objectAlpha(d2: number, r: number, rnd: number, f: CullFrame): number {
  const a = 1 - rnd * f.variation;
  const v = a * f.viewDistance;
  if (d2 > (v + r) * (v + r)) return 0;
  const r2 = r * r;
  if (!(f.kC2 * r2 >= d2) && d2 > f.m2) return 0;
  let fade = 0;
  const fs = v * f.distanceFade + r;
  if (d2 > fs * fs) fade = clamp01((fastSqrt(d2) - fs) * (f.invSpan / a));
  const cf = f.cullFade;
  if (d2 > cf * cf * f.kC2 * r2) {
    let c = (fastSqrt(d2 / r2) - f.cfC) * f.invCfC;
    if (d2 < f.m2) {
      const c2 = (fastSqrt(d2) - f.cfM) * f.invCfM;
      if (!(c2 > c)) c = c2;
    }
    c = clamp01(c);
    if (!(c < fade)) fade = c;
  }
  return 1 - fade;
}

function clamp01(x: number): number {
  // NaN → 1 like the x87 compare chains (unordered takes the "≥ 1" branch)
  return x > 0 ? (x < 1 ? x : 1) : x <= 0 ? 0 : 1;
}

/** float → byte the engine way (×255, __ftol truncation), back to 0..1. */
export function byteQ(x: number): number {
  const b = Math.trunc(x * 255);
  return (b < 0 ? 0 : b > 255 ? 255 : b) / 255;
}

/** Largest distance at which an object of radius r can be visible (cell skipping; ≥ the exact rule). */
export function maxVisibleDistance(r: number, f: CullFrame): number {
  return Math.min(f.viewDistance + r, Math.max(Math.sqrt(f.kC2) * r, Math.sqrt(f.m2)));
}

/**
 * StandardMesh LOD (FUN_00580160 @0x580186–0x580212): e = S·d²/maxScale − radius², the drawn LOD is the highest
 * i < lodCount with lodDist[i]² < e (strict), else 0. LODs the .con never configures draw LOD 0.
 */
export function smLod(d2: number, radius: number, maxScale: number, lodDist: readonly number[] | undefined, lodCount: number, scale = 1): number {
  if (!lodDist || lodCount <= 1) return 0;
  const e = (scale * d2) / (maxScale > 0 ? maxScale : 1) - radius * radius;
  for (let i = Math.min(lodCount, lodDist.length) - 1; i >= 0; i--) {
    const l = lodDist[i];
    if (l * l < e) return i;
  }
  return 0;
}

/**
 * The continuous sort parameter of FUN_00591d50, all in the SIM frame: d = normalize(cam.xz − tree.xz) (left as is
 * when |d|² is within 1e-12 of 1, (0, 0) when ≤ 0x911c3c ≈ 0), u = 0.25 − 0.249975·dot(d, Zxz); if dot(d, Xxz) < 0:
 * u = 1 − u. (dxSim, dzSim) = camera − tree in sim (three z negated). Used by the tree sort copy and the billboard
 * frame (FUN_00573530).
 */
export function treeSortU(dxSim: number, dzSim: number, zx: number, zz: number, xx: number, xz: number): number {
  let l2 = dxSim * dxSim + dzSim * dzSim;
  let dx = dxSim;
  let dz = dzSim;
  if (Math.abs(l2 - 1) >= 1e-12) {
    if (l2 > 0) {
      l2 = 1 / Math.sqrt(l2);
      dx *= l2;
      dz *= l2;
    } else {
      dx = 0;
      dz = 0;
    }
  }
  const u = 0.25 - (dx * zx + dz * zz) * 0.249975;
  return dx * xx + dz * xz < 0 ? 1 - u : u;
}

/** Tree sort copy k = min(floor(u·N), N − 1) (FUN_00591e30: fimul + __ftol). */
export function treeSortVariant(dxSim: number, dzSim: number, zx: number, zz: number, xx: number, xz: number, n = 8): number {
  const k = Math.floor(treeSortU(dxSim, dzSim, zx, zz, xx, xz) * n);
  return k < 0 ? 0 : k > n - 1 ? n - 1 : k;
}

/**
 * HotSpot regulator (evaluate 0x4e1240, pushed every frame by 0x49c770), per field through the shared
 * implementation (hotspots.ts regulateHotspot): Global + the most negative + the most positive spot delta. Global is
 * `base` (the Global spot's values when the regulator drives the objects; its unset fields ARE 0 — spot ctor 0x4e0e30 —
 * and are pushed as 0). The view-distance option factor q that the push applies to objectViewDistance / cullConst /
 * minCullDistance is 1 (the highest setting). `s` null / non-finite → `base`.
 */
export function hotspotSettings(base: ObjectsSettings, spots: readonly HotSpot[], s: number | null, out: ObjectsSettings = { ...base }): ObjectsSettings {
  Object.assign(out, base);
  if (s === null || !Number.isFinite(s)) return out;
  for (const k of HOTSPOT_KEYS) out[k] = regulateHotspot(base[k], spots, s, (h) => h[k]);
  return out;
}

// ------------------------------------------------------------------------------------------------ billboards

/**
 * Billboard-tree LOD of TreeRenderer::queue (0x574590, treeMesh.enable3D on), dist = horizontal |camera − tree|:
 *   D = billboardDistance·billboardLODScale·maxScale,  F = D·billboardFadeScale
 *   D = 0          → impostor only, w = 1
 *   dist < D − F   → mesh only (w = 0)
 *   else           w = clamp((dist − (D − F))/F, 0, 1) (F = 0 → 1): impostor with alpha w·a, and the mesh too while
 *                  dist < D with alpha (1 − w⁴)·a   (a = 1 − ObjectDrawer fade, inst+0x54)
 * Returns w, or −1 for "mesh only".
 */
export function billboardWeight(dist: number, D: number, F: number): number {
  if (D === 0) return 1;
  if (dist < D - F) return -1;
  const w = (dist - (D - F)) / F;
  return w >= 1 || Number.isNaN(w) ? 1 : w >= 0 ? w : 0;
}

/**
 * Impostor frame pair of the billboard pass (FUN_00573530 @0x573dd8–0x573e64): p = N·u with N = the .tm
 * sortDirections (8, NOT the atlas frame count n) and u = treeSortU; fr = p − floor(p);
 *   fr ≤ 0.5: i0 = floor(p) − 1, t = 0.5 − fr      else: i0 = floor(p), t = 1.5 − fr
 * The quad samples frame i0 (weight t, quantised to a byte) and frame i0 + 1; frame i spans u ∈ [i/n, (i+1)/n] with
 * WRAP addressing in u (ADDRESSU 1, ADDRESSV 3 on both stages), so atlases with n < 8 frames repeat around the tree.
 */
export function billboardFrame(u: number, nDirs: number, out: { i0: number; t: number } = { i0: 0, t: 0 }): { i0: number; t: number } {
  const p = nDirs * u;
  const fl = Math.floor(p);
  const fr = p - fl;
  if (fr <= 0.5) {
    out.i0 = fl - 1;
    out.t = 0.5 - fr;
  } else {
    out.i0 = fl;
    out.t = 1.5 - fr;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ tint

/**
 * TFACTOR of a `lighting 0` TreeMesh (FUN_00591950):
 *   c = S⊙tS + (L⊙tL − S⊙tS)·((1 − shadowFactor)·f),  f = billboard ? billboardLightScale : constantLightScale
 *   TF.rgb = sat(c · 2·colourByte/255) → bytes (×255, truncated)
 * Equal to the MergeMesh baked colour of objects.md §5.5 for f = 0.5. CPU mirror of the shader (tests).
 */
export function litOffTreeTint(
  light: readonly number[],
  shadow: readonly number[],
  lightMul: readonly number[],
  shadowMul: readonly number[],
  colorQ: readonly number[],
  shadowFactor: number,
  f: number,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const S = shadow[i] * shadowMul[i];
    const L = light[i] * lightMul[i];
    const c = S + (L - S) * ((1 - shadowFactor) * f);
    const v = Math.min(1, Math.max(0, c * 2 * colorQ[i]));
    out[i] = Math.floor(v * 255) / 255;
  }
  return out;
}
