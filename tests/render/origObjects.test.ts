// tests/render/origObjects.test.ts — the objects part (tools/assets/parts/objects.py + src/render/orig/objects*.ts).
//
// Pure maths always (ObjectDrawer cull 0x6f2970 with the engine's bit-trick sqrt and FOV size factor, the HotSpot
// regulator 0x4e1240, the billboard-tree LOD 0x574590 and impostor frames 0x573530, tree sort copies, StandardMesh
// LOD); real-data checks when the packs are built (`npm run assets -- --parts objects`) and the extracted original
// archives are present (.cache/original): placement counts = Objects.con, every mesh / texture resolves, instance
// matrices = an independent Objects.con transform (objects.md §1.3) AND the verified MergeObjects.dat matrices, the
// lit-off tree tint = the MergeMesh.dat baked colours (objects.md §5.5), impostor atlases match billboardResolution,
// and the runtime loader builds + culls a real stage (meshes, LODs, sort copies, impostors).
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { createOrigUniforms, type OrigLoadContext } from '../../src/render/orig/common';
import { loadObjects } from '../../src/render/orig/objects';
import { createObjMaterial, objAlphaRef } from '../../src/render/orig/objectsShaders';
import {
  INST,
  INST_STRIDE,
  billboardFrame,
  billboardWeight,
  byteQ,
  cullFrame,
  fastSqrt,
  hotspotSettings,
  litOffTreeTint,
  maxVisibleDistance,
  objectAlpha,
  sizeCullFactor,
  smLod,
  treeSortU,
  treeSortVariant,
  validateObjectsJson,
  type ObjectsJson,
  type ObjectsSettings,
} from '../../src/render/orig/objectsData';
import { TextureStore } from '../../src/render/orig/textures';
import { BUILT_ASSETS_DIR, builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
  readdirSync(p: string): string[];
}
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;

const ORIG = '.cache/original';
const S: ObjectsSettings = {
  viewDistance: 950,
  distanceFade: 0.75,
  cullFade: 0.75,
  cullConst: 10,
  minCullDistance: 75,
  variation: 0.3,
  billboardLODScale: 2,
  billboardFadeScale: 0.3,
  mergeMeshViewDistance: 60,
  lodDistanceScale: 1,
  billboardLightScale: 0.5,
  constantLightScale: 0.5,
};

// ------------------------------------------------------------------------------------------------ pure maths

describe('objects maths (pure)', () => {
  it('tree sort copy = FUN_00591d50 + FUN_00591e30 (fmt_standardmesh.tm_sort_variant)', () => {
    // identity tree (Z = +z, X = +x): camera straight ahead on +z -> u = 0.25 - 0.249975 = 0.000025 -> k 0
    expect(treeSortVariant(0, 1, 0, 1, 1, 0)).toBe(0);
    // camera on -z -> u = 0.499975 -> k 3 (dot(d, X) = 0 is not < 0)
    expect(treeSortVariant(0, -1, 0, 1, 1, 0)).toBe(3);
    // camera on +x -> u = 0.25 -> k 2; on -x -> u = 0.75 -> k 6
    expect(treeSortVariant(1, 0, 0, 1, 1, 0)).toBe(2);
    expect(treeSortVariant(-1, 0, 0, 1, 1, 0)).toBe(6);
    // un-normalised input is normalised first; degenerate (0, 0) -> u = 0.25 -> k 2
    expect(treeSortVariant(10, 0, 0, 1, 1, 0)).toBe(2);
    expect(treeSortVariant(0, 0, 0, 1, 1, 0)).toBe(2);
    // the bins are uniform in cos (not angle): 60° off +z on the +x side -> u = 0.25 - 0.1249875 -> k 1
    expect(treeSortVariant(Math.sin(Math.PI / 3), Math.cos(Math.PI / 3), 0, 1, 1, 0)).toBe(1);
    expect(treeSortVariant(Math.sin(Math.PI / 4), Math.cos(Math.PI / 4), 0, 1, 1, 0)).toBe(0);
    for (let a = 0; a < 360; a += 7) {
      const k = treeSortVariant(Math.sin((a * Math.PI) / 180), Math.cos((a * Math.PI) / 180), 0, 1, 1, 0);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(7);
    }
  });

  it('StandardMesh LOD = highest i < lodCount with lodDist[i]² < S·d²/maxScale − r² (FUN_00580160)', () => {
    expect(smLod(49 * 49, 1, 1, [0, 50], 2)).toBe(0); // e = 2401 - 1 = 2400 < 50² = 2500
    expect(smLod(51 * 51, 1, 1, [0, 50], 2)).toBe(1);
    expect(smLod(50 * 50, 1, 1, [0, 50], 2)).toBe(0);
    expect(smLod(100 * 100, 1, 4, [0, 50], 2)).toBe(0); // scaled ×4: e = 2500 - 1
    expect(smLod(1e8, 1, 1, [0, 50], 1)).toBe(0); // one LOD in the mesh: never beyond it (loop from lodCount-1)
    expect(smLod(1e8, 1, 1, undefined, 2)).toBe(0); // no setLodDistance: LOD 0
  });

  it('fastSqrt = the ObjectDrawer bit trick ((bits >> 1) + 0x1fc00000)', () => {
    expect(fastSqrt(1)).toBe(1);
    expect(fastSqrt(4)).toBe(2);
    expect(fastSqrt(16)).toBe(4);
    expect(fastSqrt(0.25)).toBe(0.5);
    expect(fastSqrt(2)).toBe(1.5); // 0x40000000 -> 0x3fc00000
    expect(fastSqrt(3)).toBe(1.75); // 0x40400000 -> 0x3fe00000
    for (let x = 1e-3; x < 1e7; x *= 1.37) {
      const q = fastSqrt(x) / Math.sqrt(x);
      expect(q).toBeGreaterThan(1 - 1e-6);
      expect(q).toBeLessThan(1.0607);
    }
  });

  it('size-cull factor = 10·cot²(fov/2), recomputed per frame from the camera (0x6f2f90)', () => {
    expect(sizeCullFactor((70 * Math.PI) / 180)).toBeCloseTo(10 / Math.tan((35 * Math.PI) / 180) ** 2, 9);
    expect(sizeCullFactor(2 * Math.atan(Math.sqrt(10)))).toBeCloseTo(1, 9);
    const f = cullFrame(S, (70 * Math.PI) / 180);
    expect(f.kC2).toBeCloseTo(sizeCullFactor((70 * Math.PI) / 180) * 100, 6);
    expect(f.m2).toBe(5625);
    expect(f.invSpan).toBeCloseTo(1 / (950 - 950 * 0.75), 12);
    expect(f.cfC).toBe(fastSqrt(0.75 * f.kC2 * 0.75));
    expect(f.invCfC).toBe(1 / (fastSqrt(f.kC2) - fastSqrt(f.kC2) * 0.75));
    expect(f.cfM).toBe(fastSqrt(5625) * 0.75);
  });

  it('ObjectDrawer culling and fades (0x6f2970): exact squared culls, bit-trick fades', () => {
    const f = cullFrame(S, 2 * Math.atan(Math.sqrt(10))); // k = 1: size cull at C·r
    // small object (r = 1): size cull at max(C·r, M) = 75 m (d² > M², strict); inside M the min-distance fade rules
    expect(objectAlpha(10 * 10, 1, 0, f)).toBe(1);
    expect(objectAlpha(74.9 * 74.9, 1, 0, f)).toBeGreaterThan(0);
    expect(objectAlpha(75 * 75, 1, 0, f)).toBeGreaterThanOrEqual(0);
    expect(objectAlpha(75.01 * 75.01, 1, 0, f)).toBe(0);
    const d = 70;
    const cM = (fastSqrt(d * d) - fastSqrt(5625) * 0.75) / (fastSqrt(5625) - fastSqrt(5625) * 0.75);
    expect(objectAlpha(d * d, 1, 0, f)).toBeCloseTo(1 - Math.min(1, Math.max(0, cM)), 12);
    // big object (r = 20): size limit C·r = 200 m; the cull fade starts past cullFade·C·r = 150 m
    expect(objectAlpha(140 * 140, 20, 0, f)).toBe(1);
    const c180 = (fastSqrt((180 * 180) / 400) - f.cfC) * f.invCfC;
    expect(objectAlpha(180 * 180, 20, 0, f)).toBeCloseTo(1 - Math.min(1, Math.max(0, c180)), 12);
    expect(objectAlpha(201 * 201, 20, 0, f)).toBe(0);
    // huge object (r = 200): view distance V + r with the distance fade from V·0.75 + r
    expect(objectAlpha(900 * 900, 200, 0, f)).toBe(1);
    const fd = (fastSqrt(1e6) - (950 * 0.75 + 200)) / (950 * 0.25);
    expect(objectAlpha(1e6, 200, 0, f)).toBeCloseTo(1 - fd, 6);
    expect(objectAlpha(1151 * 1151, 200, 0, f)).toBe(0);
    // variation shortens the view distance: a = 1 - rnd·0.3
    expect(objectAlpha(1100 * 1100, 200, 1, f)).toBe(0);
    expect(maxVisibleDistance(1, f)).toBeCloseTo(75, 9);
    expect(maxVisibleDistance(20, f)).toBeCloseTo(200, 6);
    expect(maxVisibleDistance(200, f)).toBeCloseTo(1150, 9);
    // at the in-game 70° FOV the projected-size cull reaches ≈ 4.5·C·r
    const g = cullFrame(S, (70 * Math.PI) / 180);
    expect(objectAlpha(400 * 400, 20, 0, g)).toBeGreaterThan(0);
    expect(objectAlpha(950 * 950, 20, 0, g)).toBe(0);
    expect(byteQ(0.5)).toBe(127 / 255);
    expect(byteQ(1)).toBe(1);
  });

  it('HotSpot regulator (0x4e1240): Global + largest positive + most negative delta, zero fields ignored', () => {
    const spots = [{ name: 'start', splineDistance: 400, width: 300, fade: 0.2, viewDistance: 500, billboardLODScale: 1.5 }];
    expect(hotspotSettings(S, spots, 0).viewDistance).toBe(950); // |s − sd| = 400 > width
    expect(hotspotSettings(S, spots, 400).viewDistance).toBe(500);
    expect(hotspotSettings(S, spots, 400).billboardLODScale).toBe(1.5);
    expect(hotspotSettings(S, spots, 400).cullConst).toBe(10);
    // core = (1 − fade)·width = 240 m; at 270 m f = 30/60 = 0.5
    expect(hotspotSettings(S, spots, 670).viewDistance).toBeCloseTo(725, 9);
    expect(hotspotSettings(S, spots, 700).viewDistance).toBe(950); // f = 1 at the window edge
    expect(hotspotSettings(S, spots, null).viewDistance).toBe(950);
    const two = [
      { name: 'a', splineDistance: 100, width: 100, fade: 0, viewDistance: 1200 },
      { name: 'b', splineDistance: 120, width: 100, fade: 0, viewDistance: 500, cullConst: 0 },
      { name: 'c', splineDistance: 110, width: 100, fade: 0, viewDistance: 700 },
    ];
    // +250 (a) and min(−450, −250) (b, c) → 950 + 250 − 450; cullConst 0 is "not set"
    expect(hotspotSettings(S, two, 110).viewDistance).toBe(750);
    expect(hotspotSettings(S, two, 110).cullConst).toBe(10);
  });

  it('billboard-tree LOD (TreeRenderer::queue 0x574590) and impostor frames (FUN_00573530)', () => {
    expect(billboardWeight(10, 60, 36)).toBe(-1); // mesh only before D − F
    expect(billboardWeight(24, 60, 36)).toBe(0);
    expect(billboardWeight(42, 60, 36)).toBeCloseTo(0.5, 12);
    expect(billboardWeight(60, 60, 36)).toBe(1);
    expect(billboardWeight(500, 60, 36)).toBe(1);
    expect(billboardWeight(5, 0, 0)).toBe(1); // D = 0: always the impostor
    expect(billboardWeight(59.9, 60, 0)).toBe(-1); // F = 0: hard switch at D (0/0 → 1 like the x87 chain)
    expect(billboardWeight(60, 60, 0)).toBe(1);
    // frame k is centred at p = 8u = k + 0.5; t = weight of frame i0, 1 − t of i0 + 1
    expect(billboardFrame(0.5 / 8, 8)).toEqual({ i0: -1, t: 0 });
    expect(billboardFrame(3.5 / 8, 8)).toEqual({ i0: 2, t: 0 });
    expect(billboardFrame(3.75 / 8, 8)).toEqual({ i0: 3, t: 0.75 });
    expect(billboardFrame(3 / 8, 8)).toEqual({ i0: 2, t: 0.5 });
    expect(treeSortU(1, 0, 0, 1, 1, 0)).toBeCloseTo(0.25, 12);
    expect(treeSortU(-1, 0, 0, 1, 1, 0)).toBeCloseTo(0.75, 12);
    expect(treeSortU(0, 0, 0, 1, 1, 0)).toBe(0.25);
  });

  it('lit-off tree TFACTOR (FUN_00591950) = the MergeMesh bake formula (objects.md §5.5)', () => {
    const cq = 126 * 0.003921569;
    const t = litOffTreeTint([0.4, 0.38, 0.35], [0.14, 0.14, 0.14], [1, 1, 1], [1, 1, 1], [cq, cq, cq], 0.2, 0.5);
    for (let i = 0; i < 3; i++) {
      const L = [0.4, 0.38, 0.35][i];
      const want = Math.floor(255 * Math.min(1, cq * (0.14 * 1.2 + L * 0.8)));
      expect(Math.round(t[i] * 255)).toBe(want);
    }
  });

  it('alpha test: GREATER 0 on every object pass (no pass sets ALPHAREF); leaves split into a depth core + soft edge', () => {
    for (const p of ['mesh', 'trunk', 'branches', 'facing', 'sprites'] as const) expect(objAlphaRef(p)).toBe(0);
    const u = createOrigUniforms();
    const base = { map: null, uniforms: u, lighting: true, lightMul: [1, 1, 1], shadowMul: [1, 1, 1] };
    const mesh = createObjMaterial({ ...base, pass: 'mesh' });
    expect(mesh.defines.ALPHA_REF).toBe('0.0');
    expect(mesh.depthWrite).toBe(true);
    expect(createObjMaterial({ ...base, pass: 'mesh', transparent: true }).depthWrite).toBe(false);
    const trunk = createObjMaterial({ ...base, pass: 'trunk' });
    expect(trunk.defines.ALPHA_REF).toBe('0.0');
    expect(trunk.depthWrite).toBe(true);
    const core = createObjMaterial({ ...base, pass: 'branches', edge: 'core' });
    const soft = createObjMaterial({ ...base, pass: 'branches', edge: 'soft' });
    // together the two leaf sub-passes cover exactly alpha > 0 (GREATER 0): core > 0x7F, soft 1..0x7F
    expect(core.defines.ALPHA_REF).toBe('127.0');
    expect(core.defines.ALPHA_MAX).toBeUndefined();
    expect(core.depthWrite).toBe(true);
    expect(soft.defines.ALPHA_REF).toBe('0.0');
    expect(soft.defines.ALPHA_MAX).toBe('127.0');
    expect(soft.depthWrite).toBe(false);
    for (const m of [mesh, trunk, core, soft]) m.dispose();
  });
});

// ------------------------------------------------------------------------------------------------ real data

function readJson<T>(p: string): T {
  return JSON.parse(new TextDecoder().decode(fs.readFileSync(p))) as T;
}

function ciFile(dir: string, name: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase());
  return hit ? `${dir}/${hit}` : null;
}

interface StageDirs {
  id: string;
  archive: string;
  dir: string;
}

function stageDirs(id: string): StageDirs {
  const m = /^([a-z]+)-(\d[a-c]?)-([fr])$/.exec(id)!;
  const archive = `${m[1]}${m[2]}${m[3]}`;
  return { id, archive, dir: `${ORIG}/${archive}/track/${m[1]}${m[2]}/${m[3] === 'f' ? 'forward' : 'reverse'}` };
}

interface Placement {
  template: string;
  pos: number[];
  rot: number[];
  scale: number[] | null;
  color: number[] | null;
  shadow: number | null;
}

function vec(s: string): number[] {
  const v = s
    .split('/')
    .filter((x) => x !== '')
    .map(Number);
  while (v.length < 3) v.push(v[v.length - 1]);
  return v.slice(0, 3);
}

/** Independent Objects.con reader (objects.md §2.2/§3: the four commands, geometry.* apply to the last create). */
function parseObjectsCon(path: string): Placement[] {
  const out: Placement[] = [];
  let cur: Placement | null = null;
  for (const raw of new TextDecoder('latin1').decode(fs.readFileSync(path)).split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/);
    if (!t[0]) continue;
    const c = t[0].toLowerCase();
    if (c === 'object.create') {
      cur = { template: t[1], pos: t[2] ? vec(t[2]) : [0, 0, 0], rot: t[3] ? vec(t[3]) : [0, 0, 0], scale: null, color: null, shadow: null };
      out.push(cur);
    } else if (cur && c === 'object.geometry.scale') cur.scale = vec(t[1]);
    else if (cur && c === 'object.geometry.color') cur.color = vec(t[1]);
    else if (cur && c === 'object.geometry.shadowfactor') cur.shadow = Number(t[1]);
  }
  return out;
}

/** Row-vector R = Rz(roll)·Rx(pitch)·Ry(yaw) (objects.md §1.3), written out independently of the build step. */
function rotRows(yaw: number, pitch: number, roll: number): number[][] {
  const [a, b, c] = [yaw, pitch, roll].map((x) => (x * Math.PI) / 180);
  const Ry = [
    [Math.cos(a), 0, -Math.sin(a)],
    [0, 1, 0],
    [Math.sin(a), 0, Math.cos(a)],
  ];
  const Rx = [
    [1, 0, 0],
    [0, Math.cos(b), Math.sin(b)],
    [0, -Math.sin(b), Math.cos(b)],
  ];
  const Rz = [
    [Math.cos(c), Math.sin(c), 0],
    [-Math.sin(c), Math.cos(c), 0],
    [0, 0, 1],
  ];
  const mm = (A: number[][], B: number[][]) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  return mm(mm(Rz, Rx), Ry);
}

/** THREE-space 3x4 (row-major) from row-vector sim rows A = diag(s)·R and a world position. */
function threeMatrix(A: number[][], pos: number[], H: number): number[] {
  const F = [1, 1, -1];
  const out: number[] = [];
  const t = [(pos[0] - 2048) * F[0], (pos[1] - H) * F[1], (pos[2] - 2048) * F[2]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out.push(F[i] * A[j][i] * F[j]); // L = F·Aᵀ·F
    out.push(t[i]);
  }
  return out;
}

class Rd {
  o = 0;
  readonly b: Uint8Array;
  readonly v: DataView;
  constructor(b: Uint8Array) {
    this.b = b;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u32(): number {
    const x = this.v.getUint32(this.o, true);
    this.o += 4;
    return x;
  }
  f32(): number {
    const x = this.v.getFloat32(this.o, true);
    this.o += 4;
    return x;
  }
  u8(): number {
    return this.b[this.o++];
  }
  str(): string {
    const n = this.u32();
    const s = new TextDecoder('latin1').decode(this.b.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
}

/** MergeObjects.dat records (objects.md §4): template name, 16 matrix floats, scale. */
function parseMergeObjects(path: string): { template: string; m: number[]; scale: number[] }[] {
  const r = new Rd(fs.readFileSync(path));
  if (r.str() !== 'Ver 0.7') throw new Error('MergeObjects version');
  r.u32();
  const out: { template: string; m: number[]; scale: number[] }[] = [];
  for (;;) {
    const name = r.str();
    if (name === 'END OF FILE') break;
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      r.u32();
      const m = Array.from({ length: 16 }, () => r.f32());
      const scale = [r.f32(), r.f32(), r.f32()];
      r.o += 16; // colour, shadowFactor
      out.push({ template: name, m, scale });
    }
  }
  return out;
}

/** MergeMesh.dat instances (objects.md §5): template name, world position, baked BGRA colour. */
function parseMergeMesh(path: string): { template: string; pos: number[]; bgra: number[] }[] {
  const r = new Rd(fs.readFileSync(path));
  if (r.u32() !== 4) throw new Error('MergeMesh version');
  const nt = r.u32();
  const names: string[] = [];
  for (let i = 0; i < nt; i++) {
    r.o += 40;
    names.push(r.str());
    r.str();
    r.o += 12 + 24 + 1;
  }
  const out: { template: string; pos: number[]; bgra: number[] }[] = [];
  for (let list = 0; list < 2; list++) {
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      const m = Array.from({ length: 16 }, () => r.f32());
      r.o += 12;
      const bgra = [r.u8(), r.u8(), r.u8(), r.u8()];
      r.f32();
      const ti = r.u32();
      out.push({ template: names[ti], pos: [m[12], m[13], m[14]], bgra });
    }
  }
  return out;
}


/** Instances of a stage keyed by (template, 1 m cell) for nearest-position matching (no rounding-boundary misses). */
class PosIndex<T> {
  private readonly m = new Map<string, { x: number; y: number; z: number; v: T }[]>();
  add(name: string, x: number, y: number, z: number, v: T): void {
    const k = `${name.toLowerCase()}|${Math.floor(x)}|${Math.floor(z)}`;
    if (!this.m.has(k)) this.m.set(k, []);
    this.m.get(k)!.push({ x, y, z, v });
  }
  near(name: string, x: number, y: number, z: number, tol: number): T[] {
    const out: T[] = [];
    const n = name.toLowerCase();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const e of this.m.get(`${n}|${Math.floor(x) + dx}|${Math.floor(z) + dz}`) ?? []) {
          if (Math.abs(e.x - x) <= tol && Math.abs(e.y - y) <= tol && Math.abs(e.z - z) <= tol) out.push(e.v);
        }
      }
    }
    return out;
  }
}

const objectsBuilt = builtAssetsPresent && fs.existsSync(`${BUILT_ASSETS_DIR}/stages/corsica-1-f/objects.json`) && fs.existsSync(ORIG);

function loadStage(id: string): { json: ObjectsJson; inst: Float32Array } | null {
  const jp = `${BUILT_ASSETS_DIR}/stages/${id}/objects.json`;
  if (!fs.existsSync(jp)) return null;
  const json = validateObjectsJson(readJson(jp));
  const bin = fs.readFileSync(`${BUILT_ASSETS_DIR}/stages/${id}/objects.bin`);
  const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
  return { json, inst: new Float32Array(ab, json.instOffset, json.instCount * INST_STRIDE) };
}

function builtStageIds(): string[] {
  const m = readJson<{ stages: Record<string, string[]> }>(`${BUILT_ASSETS_DIR}/manifest.json`);
  return Object.keys(m.stages)
    .filter((id) => m.stages[id].includes('objects'))
    .sort();
}

describe.skipIf(!objectsBuilt)('objects part on real data', () => {
  it('every stage: placements = Objects.con, meshes / textures resolve, only the SoundPole proxies are skipped', () => {
    const ids = builtStageIds();
    expect(ids.length).toBe(48);
    for (const id of ids) {
      const s = loadStage(id)!;
      const sd = stageDirs(id);
      const con = parseObjectsCon(ciFile(sd.dir, 'Objects.con')!);
      expect(s.json.stats.placements, id).toBe(con.length);
      expect(s.json.instCount, id).toBe(con.length);
      expect(s.json.templates.reduce((a, t) => a + t.instCount, 0), id).toBe(con.length);
      for (const t of s.json.templates) {
        if (t.mesh < 0) {
          expect(t.kind, `${id} ${t.name}`).toBe('sound'); // Mesh/SoundPole.sm is absent from the archives
          continue;
        }
        const m = s.json.meshes[t.mesh];
        expect(m, `${id} ${t.name}`).toBeTruthy();
        const ids2 = [...(t.materialTex ?? []).flat(), ...(t.groupTex ?? []).flat()];
        for (const tid of ids2) if (tid) expect(fs.existsSync(`${BUILT_ASSETS_DIR}/tex/${tid}.rtex`), `${id} ${tid}`).toBe(true);
        // winding is mapped exactly (mirror + swap), so culling matches the original even where the authored winding
        // disagrees with the normals (standardmesh.md §0: 1.1 % of the triangles, in these two meshes)
        if (m.type === 'sm' && !/ir_sign1\.sm$|rc2_curb_08\.sm$/.test(m.file)) expect(m.windingAgreement, `${id} ${m.file}`).toBeGreaterThan(0.9);
      }
      // a null texId = a material without a `texture` key (IR_Pine01's empty group, Co_Short_bridge_MF's lambert1)
      // or the one name absent from the archives (objects.md §0)
      for (const miss of s.json.stats.missingTextures) expect(miss, id).toBe('texture/Spec_SkinFW_04_JH');
    }
  });

  it('every billboard tree has its impostor atlas: n frames of billboardResolution w × h side by side', () => {
    let n = 0;
    let exact = 0;
    for (const id of builtStageIds()) {
      const s = loadStage(id)!;
      for (const t of s.json.templates) {
        if (!t.billboard || t.mesh < 0) continue;
        const bb = t.billboard;
        expect(bb.tex, `${id} ${t.name}`).toBeTruthy();
        const head = fs.readFileSync(`${BUILT_ASSETS_DIR}/tex/${bb.tex}.rtex`).subarray(0, 24);
        const dv = new DataView(head.buffer, head.byteOffset, 24);
        const [w, h] = [dv.getUint32(8, true), dv.getUint32(12, true)];
        const [rw, rh, rn] = bb.resolution;
        expect(bb.frames, `${id} ${t.name}`).toBe(rn);
        // the runtime samples frame i at [i/n, (i+1)/n] of the width whatever the bake resolution was (a few stage
        // atlases were baked at another size, e.g. rallycross-3-f's nzleaftree1d is 8 × 128² for a 64/128/8 template)
        expect(w % rn, `${id} ${t.name}`).toBe(0);
        if (w === rw * rn && h === rh) exact++;
        expect(bb.dirs).toBe(8);
        expect(bb.halfWidth!).toBeGreaterThan(0);
        expect(bb.height!).toBeGreaterThan(0);
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
    expect(exact / n).toBeGreaterThan(0.9);
  });

  it('instance matrices = an independent Objects.con transform (3 stages, every placement)', () => {
    for (const id of ['corsica-1-f', 'hillclimb-3a-r', 'iceracing-1-f']) {
      const s = loadStage(id)!;
      const con = parseObjectsCon(ciFile(stageDirs(id).dir, 'Objects.con')!);
      const H = s.json.stage.height;
      // the build groups placements by template (first-use order), Objects.con order inside a template
      const byTpl = new Map<string, Placement[]>();
      for (const p of con) {
        const k = p.template.toLowerCase();
        if (!byTpl.has(k)) byTpl.set(k, []);
        byTpl.get(k)!.push(p);
      }
      let worst = 0;
      for (const t of s.json.templates) {
        const ps = byTpl.get(t.name.toLowerCase())!;
        expect(ps.length).toBe(t.instCount);
        ps.forEach((p, i) => {
          const sc = p.scale ?? [1, 1, 1];
          const R = rotRows(p.rot[0], p.rot[1], p.rot[2]);
          const A = R.map((row, r) => row.map((x) => x * sc[r]));
          const want = threeMatrix(A, p.pos, H);
          const o = (t.instOffset + i) * INST_STRIDE;
          for (let c = 0; c < 12; c++) {
            const err = Math.abs(s.inst[o + c] - want[c]) / Math.max(1, Math.abs(want[c]));
            worst = Math.max(worst, err);
          }
          expect(s.inst[o + INST.SHADOW]).toBeCloseTo(p.shadow ?? 0, 5);
        });
      }
      expect(worst, id).toBeLessThan(1e-5);
    }
  });

  it('instance matrices = the verified MergeObjects.dat matrices (row-vector R, scale separate)', () => {
    let matched = 0;
    for (const id of ['corsica-1-f', 'kenya-2-r', 'newzealand-2-f', 'rallycross-1-r']) {
      const s = loadStage(id)!;
      const mo = ciFile(stageDirs(id).dir, 'MergeObjects.dat');
      if (!mo) continue;
      const H = s.json.stage.height;
      const index = new PosIndex<number>();
      for (const t of s.json.templates) {
        for (let i = 0; i < t.instCount; i++) {
          const o = (t.instOffset + i) * INST_STRIDE;
          index.add(t.name, s.inst[o + 3], s.inst[o + 7], s.inst[o + 11], o);
        }
      }
      for (const r of parseMergeObjects(mo)) {
        const A = [0, 1, 2].map((row) => [0, 1, 2].map((c) => r.m[row * 4 + c] * r.scale[row]));
        const want = threeMatrix(A, [r.m[12], r.m[13], r.m[14]], H);
        const cands = index.near(r.template, want[3], want[7], want[11], 0.01);
        expect(cands.length, `${id} ${r.template}`).toBeGreaterThan(0);
        const best = Math.min(
          ...cands.map((o) => Math.max(...want.map((w, c) => Math.abs(s.inst[o + c] - w) / Math.max(1, Math.abs(w))))),
        );
        // objects.md §0: MergeObjects positions match Objects.con to ≤ 2.3e-4 m (text precision)
        expect(best, `${id} ${r.template}`).toBeLessThan(3e-4);
        matched++;
      }
    }
    expect(matched).toBeGreaterThan(5000);
  });

  it('lit-off tree TFACTOR (FUN_00591950, f = 0.5) reproduces the MergeMesh.dat baked colours', () => {
    let total = 0;
    let exact = 0;
    for (const id of ['corsica-1-f', 'hillclimb-1b-r', 'newzealand-2-f', 'iceracing-2-r', 'kenya-2-r', 'hillclimb-3c-r']) {
      const s = loadStage(id)!;
      const mm = ciFile(stageDirs(id).dir, 'MergeMesh.dat');
      if (!mm) continue;
      const H = s.json.stage.height;
      const light = s.json.settings.lightColor!;
      const shadow = s.json.settings.shadowColor!;
      const index = new PosIndex<{ o: number; t: (typeof s.json.templates)[number] }>();
      for (const t of s.json.templates) {
        for (let i = 0; i < t.instCount; i++) {
          const o = (t.instOffset + i) * INST_STRIDE;
          index.add(t.name, s.inst[o + 3], s.inst[o + 7], s.inst[o + 11], { o, t });
        }
      }
      for (const r of parseMergeMesh(mm)) {
        const cands = index.near(r.template, r.pos[0] - 2048, r.pos[1] - H, -(r.pos[2] - 2048), 0.01);
        expect(cands.length, `${id} ${r.template}`).toBeGreaterThan(0);
        const want = [r.bgra[2], r.bgra[1], r.bgra[0]];
        let ok = false;
        for (const { o, t } of cands) {
          const cq = [s.inst[o + INST.COLOR], s.inst[o + INST.COLOR + 1], s.inst[o + INST.COLOR + 2]];
          const got = litOffTreeTint(light, shadow, t.lightMul, t.shadowMul, cq, s.inst[o + INST.SHADOW], 0.5).map((x) => Math.round(x * 255));
          if (got.every((g, i) => g === want[i])) ok = true;
        }
        total++;
        if (ok) exact++;
      }
    }
    expect(total).toBeGreaterThan(10000);
    expect(exact / total).toBeGreaterThan(0.9995);
  });
});

describe.skipIf(!objectsBuilt)('loadObjects on real data (JS texture path, no GL)', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => _setAssetFetchForTests(null));

  it('builds corsica-1-f, culls by distance and picks LODs / sort copies', async () => {
    const id = 'corsica-1-f';
    const json = validateObjectsJson(readJson(`${BUILT_ASSETS_DIR}/stages/${id}/objects.json`));
    const store = new TextureStore({} as THREE.WebGLRenderer, { s3tc: false });
    const scope = store.scope();
    const uniforms = createOrigUniforms();
    const { fetchArrayBuffer, fetchJson, stagePartPath } = await import('../../src/core/assets');
    const ctx: OrigLoadContext = {
      stage: { id, project: () => ({ s: 400, lateral: 0, heightOffset: 0, point: { x: 0, y: 0, z: 0 } }) } as unknown as OrigLoadContext['stage'],
      stageId: id,
      manifest: { version: 1, stages: {}, cars: [], carParts: {}, global: [], audio: false, textures: 0 } as unknown as OrigLoadContext['manifest'],
      parts: ['objects'],
      renderer: {} as THREE.WebGLRenderer,
      textures: scope,
      uniforms,
      partPath: (part, ext = 'json') => stagePartPath(id, part, ext),
      fetchPartJson: <T>(part: string, ext = 'json') => fetchJson<T>(stagePartPath(id, part, ext)),
      fetchPartBuffer: (part, ext = 'bin') => fetchArrayBuffer(stagePartPath(id, part, ext)),
    };
    const c = await loadObjects(ctx);
    expect(c).not.toBeNull();
    const meshes = c!.object3D.children.length;
    expect(meshes).toBeGreaterThan(json.templates.length);
    // camera at the first spectator, looking along -z
    const t = json.templates.find((x) => x.kind === 'spectator')!;
    const s = loadStage(id)!;
    const o = t.instOffset * INST_STRIDE;
    const cam = new THREE.PerspectiveCamera(70, 4 / 3, 0.5, 5000);
    cam.position.set(s.inst[o + 3], s.inst[o + 7] + 2, s.inst[o + 11] + 5);
    cam.updateMatrixWorld();
    c!.update(cam, 1 / 60);
    const stats = (c as unknown as { lastStats: { visible: number; drawn: number; instances: number; billboards: number } }).lastStats;
    expect(stats.visible).toBeGreaterThan(0);
    expect(stats.visible).toBeLessThan(stats.instances);
    expect(stats.drawn).toBeGreaterThan(0);
    // a billboard tree seen from 3·D (horizontal) away: its impostor is drawn; from 2 m it is a mesh
    let bt = json.templates[0];
    let bo = -1;
    for (const x of json.templates) {
      if (!x.billboard?.tex || x.mesh < 0) continue;
      for (let i = 0; i < x.instCount; i++) {
        const o = (x.instOffset + i) * INST_STRIDE;
        const D = x.billboard.distance * s.inst[o + INST.MAX_SCALE];
        if (bo < 0 || D < bt.billboard!.distance * s.inst[bo + INST.MAX_SCALE]) [bt, bo] = [x, o];
      }
    }
    const [tx, ty, tz] = [s.inst[bo + 3], s.inst[bo + 7], s.inst[bo + 11]];
    const far = 1.5 * bt.billboard!.distance * 2 * s.inst[bo + INST.MAX_SCALE]; // past D for billboardLODScale ≤ 2
    cam.position.set(tx + far, ty + 3, tz);
    cam.lookAt(tx, ty + 3, tz);
    cam.updateMatrixWorld();
    c!.update(cam, 1 / 60);
    expect(stats.billboards).toBeGreaterThan(0);
    // leaf buckets carry their soft-edge sibling (same geometry, drawn after every core, no depth write)
    const softs = c!.object3D.children.filter((m) => m.name.endsWith(':soft')) as THREE.Mesh[];
    expect(softs.length).toBeGreaterThan(0);
    for (const m of softs) {
      const core = c!.object3D.children.find((x) => x.name === m.name.slice(0, -5)) as THREE.Mesh;
      expect(core.geometry).toBe(m.geometry);
      expect(m.visible).toBe(core.visible);
      expect(m.renderOrder).toBeGreaterThan(3);
      for (const mat of m.material as THREE.ShaderMaterial[]) expect(mat.depthWrite).toBe(false);
    }
    const bbMesh = c!.object3D.children.find((m) => m.name === `orig-objects:${bt.name}:billboard`)!;
    expect(bbMesh.visible).toBe(true);
    // three draws a non-indexed geometry with position.count vertices: the 6 corners of the two impostor triangles
    expect((bbMesh as THREE.Mesh).geometry.getAttribute('position').count).toBe(6);
    const bbCount = ((bbMesh as THREE.Mesh).geometry as THREE.InstancedBufferGeometry).instanceCount;
    expect(bbCount).toBeGreaterThan(0);
    expect(bbCount).toBeLessThanOrEqual(stats.billboards);
    cam.position.set(tx + 2, ty + 3, tz);
    cam.lookAt(tx, ty + 3, tz);
    cam.updateMatrixWorld();
    c!.update(cam, 1 / 60);
    expect((c as unknown as { lastStats: { drawCalls: number; triangles: number } }).lastStats.drawCalls).toBeGreaterThan(0);
    // far away: nothing visible
    cam.position.set(1e6, 0, 1e6);
    cam.updateMatrixWorld();
    c!.update(cam, 1 / 60);
    expect(stats.visible).toBe(0);
    expect(c!.object3D.children.every((m) => !m.visible)).toBe(true);
    c!.dispose();
    scope.dispose();
    store.dispose();
  }, 60000);

  it('every instanced geometry addresses a valid sub-range of its template buffer', async () => {
    // smLod / treeSortVariant keys must stay inside the bucket table (no out-of-range instance reads)
    for (let k = 0; k < 1000; k++) {
      const v = treeSortVariant(Math.cos(k), Math.sin(k * 1.3), Math.cos(k * 0.7), Math.sin(k * 0.7), Math.sin(k), Math.cos(k));
      expect(v >= 0 && v < 8).toBe(true);
    }
    expect(smLod(1e12, 0, 1, [0, 10, 20, 30], 2)).toBe(1);
  });
});
