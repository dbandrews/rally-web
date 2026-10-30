/**
 * src/render/orig/trackData.ts — the `stages/<id>/track.json` (+ track.bin) layout written by
 * tools/assets/parts/track.py, and the pure (three-free) helpers of the track component: the original's view
 * distance (Track.viewDistance / HotSpot regulator) and the binary views. docs/orig/track.md.
 */
import { maxHotspotValue, regulateHotspot } from './hotspots';

/** One .rs subshader (research/formats/quadmesh.md §4.1). */
export interface TrackMaterialJson {
  name: string;
  /** Which .qm the subshader belongs to. */
  mesh: TrackMeshKind;
  /** `Track/<type>`. */
  type: 'Mask' | 'Single' | 'Water';
  lightmapped: boolean;
  doubleIntensity: boolean;
  vertexPaint: boolean;
  /** Stage textures: base1 (stage 0; `texture` for Single), mask (1), base2 (2), bump (SpecBump pass). */
  tex: Partial<Record<'base1' | 'mask' | 'base2' | 'bump', TrackTexRef>>;
}

export interface TrackTexRef {
  name: string;
  /** null = resolves nowhere (drawn black, see docs/orig/track.md). */
  id: string | null;
  clampU: boolean;
  clampV: boolean;
}

export type TrackMeshKind = 'track' | 'world' | 'water';

/** AABB in THREE space: [minX, minY, minZ, maxX, maxY, maxZ]. */
export type Bounds6 = [number, number, number, number, number, number];

export interface TrackGroupJson {
  /** Index into TrackJson.materials. */
  material: number;
  /** Range in the mesh's index buffer (u32 triangle list). */
  start: number;
  count: number;
}

export interface TrackPatchJson {
  /** "001"…: the lightmap name `Lightmaps/Track<name>`. */
  name: string;
  vertexStart: number;
  vertexCount: number;
  /** Recomputed from the vertices (the file's cell AABB can be smaller). */
  bounds: Bounds6;
  groups: TrackGroupJson[];
  /** Lightmap texId (P8 .rtex through Track.pal); null → the engine's texture/white. */
  lightmap: string | null;
}

export interface TrackNodeJson {
  /** Union of the file AABB and everything below (THREE space). */
  bounds: Bounds6;
  children: number[];
  patches: number[];
}

export interface TrackMeshJson {
  kind: TrackMeshKind;
  file: string;
  vertexFormat: number;
  /** Header `lightmapped` flag (Track.qm 1, World / Water 0). */
  lightmappedFile: boolean;
  /** Floats per vertex in the interleaved vertex block. */
  floatStride: number;
  /** Float offsets of the attributes present: position always, uv0..uv3 as the format has them. */
  layout: Partial<Record<'position' | 'uv0' | 'uv1' | 'uv2' | 'uv3', number>>;
  vertexCount: number;
  indexCount: number;
  /** Byte offsets into track.bin: f32 vertices, u8x4 RGBA colours, u32 indices. */
  vertices: number;
  colors: number;
  indices: number;
  /** Quadtree, pre-order (node 0 = root). */
  nodes: TrackNodeJson[];
  patches: TrackPatchJson[];
  /** World.qm: the object placement (Object.absolutePosition / object.rotation, converted to THREE). */
  transform?: { position: [number, number, number]; rotationYXZ: [number, number, number]; worldPosition: number[]; rotationYawPitchRollDeg: number[] };
  /** Counts as fmt_quadmesh reports them (triangles: strips expanded, degenerates dropped); groups = draw ranges. */
  stats: { patches: number; vertices: number; triangles: number; submeshes: number; groups: number; indexCountSource: number };
}

export interface HotSpotJson {
  name: string;
  splineDistance: number;
  /** Half-width of the window (FUN_004e1240: |s − splineDistance| ≤ width). */
  width: number;
  fade: number;
  /** 0 = not set by this spot. */
  trackViewDistance: number;
}

export interface TrackSettingsJson {
  /** Track.viewDistance (settings +0x38; default 1000). */
  viewDistance: number;
  hotspots: { enabled: boolean; global: { name: string; trackViewDistance: number } | null; spots: HotSpotJson[] };
  bumpEnable: boolean;
  bumpHeight: number;
  /** track.specularColor (SpecBump c0). */
  specularColor: [number, number, number];
  drawWorld: boolean;
  passes: { worldNear: number; worldFar: number; trackNear: number };
}

export interface TrackWaterJson {
  baseTile: number;
  baseScrollSpeed: number;
  baseScrollDirection: [number, number];
  bumpTile: number;
  bumpScrollSpeed: number;
  bumpScrollDirection: [number, number];
  animationSpeed: number;
  envIntensity: number;
  specularColor: [number, number, number];
  baseTex: string | null;
  bumpTex: string | null;
  /** Depth of the bump volume (the animation frame count, renderer +0x88). */
  bumpDepth: number;
  /** Six face texIds +X…−Z (SIM frame) or null. */
  envTex: string[] | null;
  baseTexName?: string;
  bumpTexName?: string;
  envTexName?: string;
}

export interface TrackJson {
  version: 1;
  stage: { id: string; archive: string; height: number };
  binBytes: number;
  /** texture/white (the missing-lightmap texture, renderer +0x220). */
  white: string;
  materials: TrackMaterialJson[];
  meshes: TrackMeshJson[];
  settings: TrackSettingsJson;
  water: TrackWaterJson | null;
  missingTextures: string[];
  lightmaps: { patches: number; present: number; fallback: string };
}

/** Typed views of one mesh inside track.bin. */
export interface TrackMeshArrays {
  vertices: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
}

export function meshArrays(bin: ArrayBuffer, m: TrackMeshJson): TrackMeshArrays {
  const nf = m.vertexCount * m.floatStride;
  if (m.vertices % 4 || m.indices % 4 || m.vertices + nf * 4 > bin.byteLength || m.colors + m.vertexCount * 4 > bin.byteLength || m.indices + m.indexCount * 4 > bin.byteLength) {
    throw new Error(`track.bin: ${m.kind} block out of range`);
  }
  return {
    vertices: new Float32Array(bin, m.vertices, nf),
    colors: new Uint8Array(bin, m.colors, m.vertexCount * 4),
    indices: new Uint32Array(bin, m.indices, m.indexCount),
  };
}

export function validateTrackJson(j: unknown): TrackJson {
  const t = j as TrackJson;
  if (!t || t.version !== 1 || !Array.isArray(t.meshes) || !Array.isArray(t.materials) || !t.settings) throw new Error('track.json: unsupported layout');
  if (!t.meshes.length || t.meshes[0].kind !== 'track') throw new Error('track.json: no Track.qm mesh');
  return t;
}

// ------------------------------------------------------------------------------------------- view distance

/**
 * The track pass's far plane (race +0x740) for a camera at spline distance `s`.
 *  * HotSpot regulator enabled (FUN_004e1210): FUN_0049c770 sets it every frame to 1.0 · the regulator's
 *    current trackViewDistance (FUN_004e1240, hotspots.ts regulateHotspot): the `Global` value plus the strongest
 *    positive and the strongest negative spot delta.
 *  * otherwise: Track.viewDistance (settings event 0xb → race +0x740).
 * The 1.0 factor is the profile's detail scale (FUN_004c9450, 1 at full detail).
 */
export function trackViewDistance(st: TrackSettingsJson, s: number): number {
  const hs = st.hotspots;
  if (!hs.enabled || !hs.global) return st.viewDistance;
  return regulateHotspot(hs.global.trackViewDistance, hs.spots, s, (h) => h.trackViewDistance);
}

/** The largest far plane the stage can ask for (camera.far must cover it). */
export function maxTrackViewDistance(st: TrackSettingsJson): number {
  const hs = st.hotspots;
  if (!hs.enabled || !hs.global) return st.viewDistance;
  return maxHotspotValue(hs.global.trackViewDistance, hs.spots, (h) => h.trackViewDistance);
}

/** Bump light direction (SIM): normalize(sun.x, sun.y·track.bumpHeight, sun.z) (FUN_0049a680 → renderer vtbl+0x4c). */
export function bumpLightDir(sunSim: readonly [number, number, number], bumpHeight: number): [number, number, number] {
  const x = sunSim[0];
  const y = sunSim[1] * bumpHeight;
  const z = sunSim[2];
  const l = Math.hypot(x, y, z);
  return l > 1e-12 ? [x / l, y / l, z / l] : [0, 0, 0];
}

/**
 * Water animation constants at time t (s since load) [V water constant setup @0x669225–0x66936d]:
 *   both scroll accumulators advance by speed·dt while either speed is non-zero; the bump volume phase
 *   advances by AnimationSpeed·dt / depth and wraps (only when the volume has more than one slice).
 *   c21.xy = sBase·normalize(BaseScrollDirection), c21.zw = sBump·normalize(BumpScrollDirection), c15.x = phase.
 */
export function waterAnimation(w: TrackWaterJson, t: number): { baseScroll: [number, number]; bumpScroll: [number, number]; phase: number } {
  const moving = w.baseScrollSpeed !== 0 || w.bumpScrollSpeed !== 0;
  const sb = moving ? w.baseScrollSpeed * t : 0;
  const sp = moving ? w.bumpScrollSpeed * t : 0;
  const nb = norm2(w.baseScrollDirection);
  const np = norm2(w.bumpScrollDirection);
  const phase = w.bumpDepth > 1 ? fract((w.animationSpeed * t) / w.bumpDepth) : 0;
  return { baseScroll: [sb * nb[0], sb * nb[1]], bumpScroll: [sp * np[0], sp * np[1]], phase };
}

function fract(x: number): number {
  return x - Math.floor(x);
}

/** The Water direction setters (vtbl+0xb4 / +0xbc): normalised, (0, 0) when |d|² is ~0. */
function norm2(d: readonly [number, number]): [number, number] {
  const l2 = d[0] * d[0] + d[1] * d[1];
  if (Math.abs(l2 - 1) <= 1e-6) return [d[0], d[1]];
  if (l2 < 1e-12) return [0, 0];
  const k = 1 / Math.sqrt(l2);
  return [d[0] * k, d[1] * k];
}

// ------------------------------------------------------------------------------------------- height grid

/**
 * Ground height under THREE-space (x, z) from the rendered meshes (camera ground sampler): the highest
 * up-facing triangle; NaN where no triangle covers the point. Uniform XZ grid of triangle lists (CSR).
 */
export class TrackHeightGrid {
  readonly cell: number;
  readonly minX: number;
  readonly minZ: number;
  readonly nx: number;
  readonly nz: number;
  private readonly start: Uint32Array;
  private readonly items: Uint32Array;
  /** Per triangle: x0 z0 y0 x1 z1 y1 x2 z2 y2. */
  private readonly tri: Float32Array;

  constructor(sources: readonly { arrays: TrackMeshArrays; stride: number; ranges: readonly { start: number; count: number }[] }[], cell = 16) {
    let nt = 0;
    for (const s of sources) for (const r of s.ranges) nt += Math.floor(r.count / 3);
    const tri = new Float32Array(nt * 9);
    let k = 0;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const s of sources) {
      const v = s.arrays.vertices;
      const ix = s.arrays.indices;
      for (const r of s.ranges) {
        for (let i = r.start; i + 2 < r.start + r.count; i += 3) {
          const a = ix[i] * s.stride;
          const b = ix[i + 1] * s.stride;
          const c = ix[i + 2] * s.stride;
          // up-facing in THREE (CCW seen from above = front faces +y): cross((b−a), (c−a)).y > 0
          const e1x = v[b] - v[a];
          const e1z = v[b + 2] - v[a + 2];
          const e2x = v[c] - v[a];
          const e2z = v[c + 2] - v[a + 2];
          const ny = e1z * e2x - e1x * e2z;
          if (!(ny > 1e-9)) continue;
          tri[k++] = v[a];
          tri[k++] = v[a + 2];
          tri[k++] = v[a + 1];
          tri[k++] = v[b];
          tri[k++] = v[b + 2];
          tri[k++] = v[b + 1];
          tri[k++] = v[c];
          tri[k++] = v[c + 2];
          tri[k++] = v[c + 1];
          minX = Math.min(minX, v[a], v[b], v[c]);
          maxX = Math.max(maxX, v[a], v[b], v[c]);
          minZ = Math.min(minZ, v[a + 2], v[b + 2], v[c + 2]);
          maxZ = Math.max(maxZ, v[a + 2], v[b + 2], v[c + 2]);
        }
      }
    }
    this.tri = tri.subarray(0, k);
    const n = k / 9;
    this.cell = cell;
    if (!n) {
      this.minX = this.minZ = 0;
      this.nx = this.nz = 1;
      this.start = new Uint32Array(2);
      this.items = new Uint32Array(0);
      return;
    }
    this.minX = minX;
    this.minZ = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
    const cells = this.nx * this.nz;
    const counts = new Uint32Array(cells + 1);
    const span = (t: number, f: (c: number) => void): void => {
      const o = t * 9;
      const T = this.tri;
      const x0 = Math.min(T[o], T[o + 3], T[o + 6]);
      const x1 = Math.max(T[o], T[o + 3], T[o + 6]);
      const z0 = Math.min(T[o + 1], T[o + 4], T[o + 7]);
      const z1 = Math.max(T[o + 1], T[o + 4], T[o + 7]);
      const cx0 = Math.floor((x0 - this.minX) / cell);
      const cx1 = Math.floor((x1 - this.minX) / cell);
      const cz0 = Math.floor((z0 - this.minZ) / cell);
      const cz1 = Math.floor((z1 - this.minZ) / cell);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) f(cz * this.nx + cx);
    };
    for (let t = 0; t < n; t++) span(t, (c) => counts[c + 1]++);
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const items = new Uint32Array(counts[cells]);
    const fill = counts.slice(0, cells);
    for (let t = 0; t < n; t++) span(t, (c) => (items[fill[c]++] = t));
    this.start = counts;
    this.items = items;
  }

  get triangleCount(): number {
    return this.tri.length / 9;
  }

  heightAt(x: number, z: number): number {
    const cx = Math.floor((x - this.minX) / this.cell);
    const cz = Math.floor((z - this.minZ) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) return NaN;
    const c = cz * this.nx + cx;
    const T = this.tri;
    let best = NaN;
    for (let i = this.start[c]; i < this.start[c + 1]; i++) {
      const o = this.items[i] * 9;
      const ax = T[o];
      const az = T[o + 1];
      const bx = T[o + 3];
      const bz = T[o + 4];
      const qx = T[o + 6];
      const qz = T[o + 7];
      const d = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz);
      if (Math.abs(d) < 1e-12) continue;
      const w0 = ((bz - qz) * (x - qx) + (qx - bx) * (z - qz)) / d;
      const w1 = ((qz - az) * (x - qx) + (ax - qx) * (z - qz)) / d;
      const w2 = 1 - w0 - w1;
      const e = -1e-6;
      if (w0 < e || w1 < e || w2 < e) continue;
      const y = w0 * T[o + 2] + w1 * T[o + 5] + w2 * T[o + 8];
      if (!(y <= best)) best = y;
    }
    return best;
  }
}
