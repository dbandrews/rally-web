/**
 * src/render/terrain.ts — terrain mesh from Stage.heightfield (render builder).
 *
 *  - Chunked (frustum culling), indexed, smooth normals; vertex colours per material (SURFACE_INFO colour
 *    with macro noise, slope → rock blend) and a per-vertex detail weight that picks the procedural detail
 *    channel in the fragment shader (pebbles / grass streaks / soft blotches).
 *  - Render-only: vertices under the road ribbon are pushed below the road surface so the ribbon never
 *    z-fights or gets poked through (physics heights are untouched).
 *  - A large flat skirt beyond the heightfield hides the edge of the world in the fog.
 */
import * as THREE from 'three';
import { MATERIAL_NONE, MATERIAL_SOLID_MIN, SURFACE_INFO, surfaceFromMaterial } from '../core/constants';
import type { Stage, SurfaceId } from '../core/types';
import { HeightSampler } from './heightSampler';
import { terrainDetail } from './textures';

/** Road ribbon lift above the road samples (road.ts uses the same value). */
export const ROAD_LIFT = 0.03;
/** Terrain is pushed this far below the road surface inside the road (render-only). */
const UNDER_ROAD_DROP = 0.14;

// ------------------------------------------------------------------------------------------- noise

function hash2(x: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth value noise in [0, 1] at world scale `cell` metres. */
export function vnoise(x: number, z: number, cell: number): number {
  const fx = x / cell, fz = z / cell;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  let tx = fx - ix, tz = fz - iz;
  tx = tx * tx * (3 - 2 * tx);
  tz = tz * tz * (3 - 2 * tz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

// ------------------------------------------------------------------------------------------- per-material look

interface TerrainLook {
  color: THREE.Color;
  dry: THREE.Color;
  /** Detail weights: pebbles, grass, blotch (contrast). */
  detail: [number, number, number];
  rocky: boolean;
}

const ROCK = new THREE.Color().setHex(0x7d766c);
const SNOW_ROCK = new THREE.Color().setHex(0x6c6a68);

function lookFor(surface: SurfaceId | null): TerrainLook {
  const base = new THREE.Color().setHex(surface ? SURFACE_INFO[surface].color : 0x6c665e);
  const dry = base.clone();
  let detail: [number, number, number] = [0.3, 0.3, 0.4];
  let rocky = true;
  switch (surface) {
    case 'grass':
      base.lerp(new THREE.Color().setHex(0x6a6c48), 0.22);
      dry.setHex(0x7d8446);
      detail = [0.1, 0.75, 0.35];
      break;
    case 'gravel':
    case 'gravelDeep':
      dry.setHex(0xb09a78);
      detail = [0.8, 0.0, 0.35];
      break;
    case 'sand':
      dry.setHex(0xe0c896);
      detail = [0.45, 0.0, 0.3];
      break;
    case 'mud':
      dry.setHex(0x6e5a40);
      detail = [0.35, 0.15, 0.5];
      break;
    case 'snow':
      dry.setHex(0xf6f9fc);
      detail = [0.0, 0.0, 0.22];
      break;
    case 'ice':
      dry.setHex(0xd8e8f2);
      detail = [0.0, 0.0, 0.25];
      break;
    case 'cobbles':
    case 'tarmac':
    case 'water':
      detail = [0.6, 0.0, 0.3];
      rocky = false;
      break;
    default:
      detail = [0.6, 0.0, 0.4];
  }
  return { color: base, dry, detail, rocky };
}

// ------------------------------------------------------------------------------------------- material

export function makeTerrainMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const detail = terrainDetail();
  if (!detail) return mat;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detail };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 detailW;\nvarying vec3 vDetailW;\nvarying vec2 vWorldXZ;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDetailW = detailW;\nvWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D uDetail;\nvarying vec3 vDetailW;\nvarying vec2 vWorldXZ;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 t1 = texture2D(uDetail, vWorldXZ * 0.21).rgb - 0.5;
          vec3 t2 = texture2D(uDetail, vWorldXZ * 0.031 + vec2(0.37, 0.71)).rgb - 0.5;
          float d = 1.0 + dot(t1, vDetailW) * 1.3 + (t2.b * 0.55 + t2.g * 0.2 * vDetailW.g);
          diffuseColor.rgb *= clamp(d, 0.45, 1.6);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'rally-terrain-v1';
  return mat;
}

// ------------------------------------------------------------------------------------------- build

export interface TerrainChunk {
  /** Meshes for stride 1, 2, 4 (one visible at a time). */
  levels: THREE.Mesh[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  level: number;
}

export interface TerrainBuild {
  group: THREE.Group;
  sampler: HeightSampler;
  /** Render heights (with the under-road drop). */
  heights: Float32Array;
  chunks: TerrainChunk[];
}

const SKIRT_DROP = 2.5;
/** Chunk LOD switch distances (m, from the camera to the chunk's footprint). */
export const TERRAIN_LOD_DIST: [number, number] = [150, 420];

/** Choose a level per chunk from the camera position (scale < 1 = coarser sooner). */
export function updateTerrainLod(chunks: readonly TerrainChunk[], cam: THREE.Vector3, scale = 1): void {
  const d0 = TERRAIN_LOD_DIST[0] * scale, d1 = TERRAIN_LOD_DIST[1] * scale;
  for (const c of chunks) {
    const dx = Math.max(c.minX - cam.x, 0, cam.x - c.maxX);
    const dz = Math.max(c.minZ - cam.z, 0, cam.z - c.maxZ);
    const d = Math.hypot(dx, dz);
    const lv = d < d0 ? 0 : d < d1 ? 1 : 2;
    if (lv !== c.level) {
      c.levels[c.level].visible = false;
      c.levels[lv].visible = true;
      c.level = lv;
    }
  }
}

/** Index buffer for a w×d vertex chunk sampled every `stride` vertices (last row / column always kept),
 *  plus double-sided skirt quads along the four edges. */
function lodIndex(w: number, d: number, stride: number, skirtOf: Map<number, number>, total: number): THREE.BufferAttribute {
  const cols: number[] = [], rows: number[] = [];
  for (let i = 0; i < w - 1; i += stride) cols.push(i);
  cols.push(w - 1);
  for (let j = 0; j < d - 1; j += stride) rows.push(j);
  rows.push(d - 1);
  const out: number[] = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < cols.length - 1; c++) {
      const a = rows[r] * w + cols[c], b = rows[r] * w + cols[c + 1];
      const cc = rows[r + 1] * w + cols[c], e = rows[r + 1] * w + cols[c + 1];
      out.push(a, e, b, a, cc, e);
    }
  }
  const edge = (vs: number[]) => {
    for (let k = 0; k < vs.length - 1; k++) {
      const p = vs[k], q = vs[k + 1];
      const ps = skirtOf.get(p)!, qs = skirtOf.get(q)!;
      out.push(p, ps, q, q, ps, qs); // one winding
      out.push(p, q, ps, q, qs, ps); // and the other
    }
  };
  edge(cols.map((i) => i));
  edge(cols.map((i) => (d - 1) * w + i));
  edge(rows.map((j) => j * w));
  edge(rows.map((j) => j * w + w - 1));
  return new THREE.BufferAttribute(total > 65535 ? new Uint32Array(out) : new Uint16Array(out), 1);
}

/** Lower render heights under the road ribbon (centre part), never above the road surface - drop. */
function carveUnderRoad(stage: Stage, heights: Float32Array): void {
  const hf = stage.heightfield;
  const { originX, originZ, cellSize, nx, nz } = hf;
  const road = stage.road;
  const n = road.length;
  const segs = stage.closed && n > 2 ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = road[i], b = road[(i + 1) % n];
    const ax = a.pos.x, az = a.pos.z, bx = b.pos.x, bz = b.pos.z;
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz;
    if (L2 < 1e-6 || L2 > 400) continue; // degenerate or wrap gap
    const halfMax = Math.max(a.width, b.width) / 2 + cellSize;
    const minX = Math.min(ax, bx) - halfMax, maxX = Math.max(ax, bx) + halfMax;
    const minZ = Math.min(az, bz) - halfMax, maxZ = Math.max(az, bz) + halfMax;
    const ix0 = Math.max(0, Math.floor((minX - originX) / cellSize)), ix1 = Math.min(nx - 1, Math.ceil((maxX - originX) / cellSize));
    const iz0 = Math.max(0, Math.floor((minZ - originZ) / cellSize)), iz1 = Math.min(nz - 1, Math.ceil((maxZ - originZ) / cellSize));
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = originZ + iz * cellSize;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = originX + ix * cellSize;
        let t = ((x - ax) * dx + (z - az) * dz) / L2;
        if (t < -0.05 || t > 1.05) continue;
        t = Math.min(1, Math.max(0, t));
        // edges at t
        const lx = a.left.x + (b.left.x - a.left.x) * t, lz = a.left.z + (b.left.z - a.left.z) * t, ly = a.left.y + (b.left.y - a.left.y) * t;
        const rx = a.right.x + (b.right.x - a.right.x) * t, rz = a.right.z + (b.right.z - a.right.z) * t, ry = a.right.y + (b.right.y - a.right.y) * t;
        const ex = rx - lx, ez = rz - lz;
        const W2 = ex * ex + ez * ez;
        if (W2 < 1e-6) continue;
        const f = ((x - lx) * ex + (z - lz) * ez) / W2; // 0 = left edge, 1 = right edge
        const W = Math.sqrt(W2);
        const margin = 0.45 / W;
        if (f < margin || f > 1 - margin) continue;
        // also require the point to be close to the cross-section line (not just inside its span)
        const px = lx + ex * f, pz = lz + ez * f;
        const off = Math.hypot(x - px, z - pz);
        if (off > Math.sqrt(L2) * 0.75 + 0.5) continue;
        const roadY = ly + (ry - ly) * f;
        const k = iz * nx + ix;
        const target = roadY - UNDER_ROAD_DROP;
        if (heights[k] > target) heights[k] = target;
      }
    }
  }
}

export function buildTerrain(stage: Stage): TerrainBuild {
  const hf = stage.heightfield;
  const { originX, originZ, cellSize, nx, nz, materials } = hf;
  const heights = new Float32Array(hf.heights);
  if (stage.road.length > 1) carveUnderRoad(stage, heights);
  const sampler = new HeightSampler(hf, heights);
  const group = new THREE.Group();
  group.name = 'terrain';
  if (nx < 2 || nz < 2) return { group, sampler, heights, chunks: [] };

  // decimate very large heightfields (keeps vertex count sane)
  const step = Math.max(1, Math.ceil(Math.sqrt((nx * nz) / 1.6e6)));
  const gx = Math.floor((nx - 1) / step) + 1;
  const gz = Math.floor((nz - 1) / step) + 1;

  // per-material looks
  const pal = stage.environment.palette;
  const looks = new Map<number, TerrainLook>();
  const getLook = (m: number): TerrainLook => {
    let l = looks.get(m);
    if (!l) {
      const s = m === MATERIAL_NONE ? 'grass' : m >= MATERIAL_SOLID_MIN ? null : surfaceFromMaterial(m);
      l = lookFor(s);
      // per-stage palette (EnvironmentPreset.palette): blend the stage's ground / rock tint in
      const pc = s ? pal?.ground[s] : pal?.rock;
      if (pc !== undefined) {
        const c = new THREE.Color().setHex(pc);
        l.color.lerp(c, 0.55);
        l.dry.lerp(c, 0.35);
      }
      looks.set(m, l);
    }
    return l;
  };

  const H = (ix: number, iz: number) => heights[Math.min(nz - 1, iz) * nx + Math.min(nx - 1, ix)];
  const mat = makeTerrainMaterial();

  const CH = Math.max(16, Math.min(96, Math.ceil(Math.max(gx, gz) / 8 / 4) * 4));
  const tmp = new THREE.Color();
  const nrm = new THREE.Vector3();
  const chunks: TerrainChunk[] = [];
  for (let cz = 0; cz < gz - 1; cz += CH) {
    for (let cx = 0; cx < gx - 1; cx += CH) {
      const w = Math.min(CH, gx - 1 - cx) + 1;
      const d = Math.min(CH, gz - 1 - cz) + 1;
      const count = w * d;
      // perimeter (skirt) vertices follow the grid vertices: dropped copies that hide LOD seams
      const perim: number[] = [];
      for (let i = 0; i < w; i++) perim.push(i);
      for (let j = 1; j < d; j++) perim.push(j * w + w - 1);
      for (let i = w - 2; i >= 0; i--) perim.push((d - 1) * w + i);
      for (let j = d - 2; j >= 1; j--) perim.push(j * w);
      const total = count + perim.length;
      const pos = new Float32Array(total * 3);
      const nor = new Float32Array(total * 3);
      const col = new Float32Array(total * 3);
      const det = new Float32Array(total * 3);
      let k = 0;
      for (let j = 0; j < d; j++) {
        const iz = Math.min(nz - 1, (cz + j) * step);
        for (let i = 0; i < w; i++, k++) {
          const ix = Math.min(nx - 1, (cx + i) * step);
          const x = originX + ix * cellSize, z = originZ + iz * cellSize;
          const y = heights[iz * nx + ix];
          pos[k * 3] = x;
          pos[k * 3 + 1] = y;
          pos[k * 3 + 2] = z;
          // central-difference normal (three space: +x, +z axes)
          const s = step;
          const hl = H(Math.max(0, ix - s), iz), hr = H(ix + s, iz);
          const hd = H(ix, Math.max(0, iz - s)), hu = H(ix, iz + s);
          nrm.set(hl - hr, 2 * s * cellSize, hd - hu).normalize();
          nor[k * 3] = nrm.x;
          nor[k * 3 + 1] = nrm.y;
          nor[k * 3 + 2] = nrm.z;
          // colour
          const m = materials[iz * nx + ix];
          const look = getLook(m);
          const n1 = vnoise(x, z, 37), n2 = vnoise(x + 311, z - 97, 9);
          tmp.copy(look.color).lerp(look.dry, Math.min(1, Math.max(0, (n1 - 0.35) * 1.6)));
          const bright = 0.86 + n2 * 0.24;
          tmp.multiplyScalar(bright);
          const steep = Math.min(1, Math.max(0, (0.8 - nrm.y) / 0.2));
          if (look.rocky && steep > 0) tmp.lerp(m === 4 ? SNOW_ROCK : ROCK, steep * 0.85);
          col[k * 3] = tmp.r;
          col[k * 3 + 1] = tmp.g;
          col[k * 3 + 2] = tmp.b;
          det[k * 3] = look.detail[0] * (1 - steep) + 0.7 * steep;
          det[k * 3 + 1] = look.detail[1] * (1 - steep);
          det[k * 3 + 2] = look.detail[2];
        }
      }
      // skirt copies
      const skirtOf = new Map<number, number>();
      perim.forEach((v, n) => {
        const t = count + n;
        skirtOf.set(v, t);
        pos[t * 3] = pos[v * 3];
        pos[t * 3 + 1] = pos[v * 3 + 1] - SKIRT_DROP;
        pos[t * 3 + 2] = pos[v * 3 + 2];
        for (let c = 0; c < 3; c++) {
          nor[t * 3 + c] = nor[v * 3 + c];
          col[t * 3 + c] = col[v * 3 + c] * 0.9;
          det[t * 3 + c] = det[v * 3 + c];
        }
      });
      const aPos = new THREE.BufferAttribute(pos, 3);
      const aNor = new THREE.BufferAttribute(nor, 3);
      const aCol = new THREE.BufferAttribute(col, 3);
      const aDet = new THREE.BufferAttribute(det, 3);
      const levels: THREE.Mesh[] = [];
      for (const stride of [1, 2, 4]) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', aPos);
        g.setAttribute('normal', aNor);
        g.setAttribute('color', aCol);
        g.setAttribute('detailW', aDet);
        g.setIndex(lodIndex(w, d, stride, skirtOf, total));
        g.computeBoundingSphere();
        g.computeBoundingBox();
        const mesh = new THREE.Mesh(g, mat);
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.visible = stride === 1;
        mesh.name = `terrain:${stride}`;
        group.add(mesh);
        levels.push(mesh);
      }
      const bb = levels[0].geometry.boundingBox!;
      chunks.push({ levels, minX: bb.min.x, maxX: bb.max.x, minZ: bb.min.z, maxZ: bb.max.z, level: 0 });
    }
  }

  // skirt: flat ground far beyond the heightfield, below everything, dominant colour
  let minH = Infinity, sumR = 0, sumG = 0, sumB = 0, nS = 0;
  for (let i = 0; i < heights.length; i++) if (heights[i] < minH) minH = heights[i];
  for (let i = 0; i < materials.length; i += 97) {
    const l = getLook(materials[i]);
    sumR += l.color.r; sumG += l.color.g; sumB += l.color.b; nS++;
  }
  const skirtCol = new THREE.Color(sumR / nS, sumG / nS, sumB / nS).multiplyScalar(0.92);
  const W = (nx - 1) * cellSize, D = (nz - 1) * cellSize;
  const span = Math.max(W, D) + stage.environment.fogFar * 3;
  const skirt = new THREE.Mesh(
    new THREE.PlaneGeometry(span, span).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: skirtCol }),
  );
  skirt.position.set(originX + W / 2, minH - 1.5, originZ + D / 2);
  skirt.receiveShadow = false;
  skirt.name = 'skirt';
  group.add(skirt);
  return { group, sampler, heights, chunks };
}
