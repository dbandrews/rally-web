// tests/render/origCar.test.ts — the cars part (tools/assets/parts/cars.py + src/render/orig/car*.ts).
//
// Without built packs: loadOriginalCar returns null (procedural car), never throws. With the packs
// (`npm run assets -- --parts cars`) and the extracted archives (.cache/original):
//   * all 29 cars + all 48 stage inputs are built, every texId of every car / stage file resolves to tex/<id>.rtex;
//   * names, wheel bundles, rest hub heights and wheel meshes = research/formats/cars.md §4.4 / §10 tables;
//   * materials / vertex counts per LOD set = the verified parser's dump (.cache/dumps/cars_dump.json, fmt_cars);
//   * every vertex attribute and triangle of 3 cars (all LOD sets + both wheel meshes, 4 internal LODs) = an
//     independent TypeScript reader of the .cm format written from cars.md §5 (strips → lists, three space);
//   * the runtime visual: wheel matrices = the FUN_006c8ef0 row operations (decomp, cars.md §4.2) under S·M·S,
//     LOD by camera distance, brake light / ghost materials;
//   * every car's camera table = its own Templates.con <Car>CarCamera setCamPosition lines (MECHANICS_SPEC §5.3: the
//     exe reads each view from the player car's template); ImprezaWRX's = the generic §5.3 table (makeCameraTuning).
// Without assets: the camera mapping (carCameraTuning) and the hidden procedural stand-in while an original loads.
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { ORIG_CAR_IDS } from '../../src/core/constants';
import type { CarRenderState } from '../../src/core/types';
import { makeCameraTuning } from '../../src/render/cameraRig';
import { CarVisual } from '../../src/render/carVisual';
import { LOD_DIST, carCameraTuning, clearCarCache, loadOriginalCar, type CarCameraEntry, type CarInfo, type OriginalCarVisual } from '../../src/render/orig/car';
import { TextureStore } from '../../src/render/orig/textures';
import { listStages } from '../../src/world/stages';
import { BUILT_ASSETS_DIR, builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
}
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;
const ORIG = '.cache/original';
const DUMP = '.cache/dumps/cars_dump.json';

const a3 = (a: number[]) => ({ x: a[0], y: a[1], z: a[2] });
const readJson = <T>(p: string): T => JSON.parse(new TextDecoder().decode(fs.readFileSync(p))) as T;
const carsBuilt = builtAssetsPresent && fs.existsSync(`${BUILT_ASSETS_DIR}/cars/ImprezaWRX/cars.json`);
const origPresent = fs.existsSync(`${ORIG}/Misc/mesh/Cars/ImprezaWRX/Body.cm`);

// ------------------------------------------------------------------------------------------- reference tables

/** cars.md §4.4: FL bundle B (x, y, z), RL B.z, rest hub y F/R, tarmac / gravel wheel. */
const TABLE_44: Record<string, [number, number, number, number, number, number, string, string]> = {
  Astra: [-0.814, 0.52, 1.292, -1.303, -0.139, -0.14, 'Tarmac5Grey', 'Gravel6Grey'],
  AudiS1: [-0.827, 0.47, 1.036, -1.119, -0.172, -0.18, 'GroupB5Red', 'Gravel8Orange'],
  AudiS1HC: [-0.827, 0.47, 1.036, -1.119, -0.172, -0.18, 'GroupB5White', 'Gravel8White'],
  Beetle: [-0.757, 0.48, 1.249, -1.252, -0.189, -0.189, 'Tarmac16White', 'Gravel6White'],
  CitroenXsara: [-0.801, 0.54, 1.134, -1.393, -0.124, -0.14, 'Tarmac16White', 'Gravel8White'],
  CitroenXsaraRC: [-0.801, 0.54, 1.134, -1.393, -0.111, -0.128, 'Tarmac6White', 'Gravel6White'],
  Corolla: [-0.761, 0.54, 1.185, -1.272, -0.108, -0.114, 'Tarmac6White', 'Gravel8White'],
  DeltaIntergrale: [-0.698, 0.47, 1.127, -1.405, -0.178, -0.197, 'Tarmac6Orange', 'Gravel8Orange'],
  DeltaS4: [-0.698, 0.59, 1.077, -1.442, -0.07, -0.092, 'GroupB5Silver', 'Gravel5Silver'],
  Escudo: [-0.819, 0.522, 1.006, -1.53, -0.149, -0.175, 'GroupB5White', 'Gravel5White'],
  FordEscort: [-0.786, 0.51, 1.327, -1.281, -0.143, -0.14, 'Tarmac5White', 'Gravel18White'],
  FordFocus: [-0.745, 0.55, 1.327, -1.238, -0.112, -0.106, 'Tarmac5White', 'Gravel8White'],
  FordFocusCosworth: [-0.755, 0.55, 1.325, -1.225, -0.105, -0.097, 'Tarmac5White', 'Gravel18White'],
  FordRS200: [-0.759, 0.64, 1.049, -1.491, 0.001, -0.031, 'Tarmac5White', 'Gravel8White'],
  ImprezaHC: [-0.781, 0.5, 1.229, -1.318, -0.148, -0.154, 'Tarmac16Bronze', 'Gravel18Bronze'],
  ImprezaWRX: [-0.755, 0.56, 1.175, -1.392, -0.083, -0.099, 'Tarmac16Bronze', 'Gravel6Bronze'],
  Lancer: [-0.755, 0.52, 1.305, -1.197, -0.135, -0.127, 'Tarmac5Silver', 'Gravel5Silver'],
  LancerEVO: [-0.755, 0.52, 1.305, -1.197, -0.135, -0.127, 'Tarmac5White', 'Gravel18White'],
  Metro6R4: [-0.698, 0.56, 1.118, -1.323, -0.1, -0.113, 'GroupB5White', 'Gravel5White'],
  Micra: [-0.773, 0.62, 1.268, -1.333, -0.064, -0.067, 'Tarmac6White', 'Gravel8White'],
  NissanSkyline: [-0.749, 0.645, 1.378, -1.325, 0.007, 0.007, 'Tarmac6DarkGrey', 'Gravel5DarkGrey'],
  Peugeot205: [-0.698, 0.54, 1.418, -1.24, -0.14, -0.131, 'Tarmac5White', 'Gravel8White'],
  Peugeot206: [-0.752, 0.5, 1.029, -1.461, -0.138, -0.167, 'Tarmac5White', 'Gravel18White'],
  Peugeot306: [-0.73, 0.6, 1.335, -1.227, -0.075, -0.069, 'Tarmac16White', 'Gravel6White'],
  Peugeot405: [-0.745, 0.61, 1.414, -1.481, -0.066, -0.07, 'GroupB5White', 'Gravel8White'],
  Renault5: [-0.656, 0.48, 1.26, -1.187, -0.19, -0.185, 'GroupB5Silver', 'Gravel8Grey'],
  Saab93: [-0.736, 0.57, 1.333, -1.381, -0.089, -0.092, 'Tarmac5Grey', 'Gravel8Grey'],
  SaabViggen: [-0.736, 0.56, 1.341, -1.392, -0.111, -0.114, 'Tarmac5Grey', 'Gravel5Grey'],
  ToyotaTacoma: [-0.886, 0.5, 1.13, -1.598, -0.166, -0.19, 'Tarmac6Silver', 'Gravel5Silver'],
};

/** cars.md §10: menu display name (LocaleEnglish, one line) and short name. */
const NAMES: Record<string, [string, string]> = {
  Astra: ['Opel Astra T16 4x4', 'Opel Astra T16'],
  AudiS1: ['Audi Quattro S1', 'Quattro S1'],
  AudiS1HC: ['Audi Quattro S1 Hill Climb', 'Quattro S1 HC'],
  Beetle: ['Volkswagen Beetle', 'VW Beetle'],
  CitroenXsara: ['Citroen Xsara Kit Car', 'Xsara Kit-Car'],
  CitroenXsaraRC: ['Citroen Xsara Rallycross', 'Citroen Xsara RC'],
  Corolla: ['Toyota Corolla Ice Racing', 'Toyota Corolla'],
  DeltaIntergrale: ['Lancia Delta Integrale', 'Delta Integrale'],
  DeltaS4: ['Lancia Delta S4', 'Delta S4'],
  Escudo: ['Suzuki Grand Vitara Hill Climb', 'Grand Vitara PP SP'],
  FordEscort: ['Ford Escort Cosworth Rally', 'Escort Cosworth'],
  FordFocus: ['Ford Focus Rallycross', 'Ford Focus RC'],
  FordFocusCosworth: ['Ford Focus Cosworth', 'Focus Cosworth'],
  FordRS200: ['Ford RS200', 'Ford RS 200'],
  ImprezaHC: ['Subaru Impreza Hill Climb', 'Impreza HC'],
  ImprezaWRX: ['Subaru Impreza WRX', 'Impreza WRX'],
  Lancer: ['Mitsubishi Lancer EVO 6.5b', 'Lancer Evo 6.5'],
  LancerEVO: ['Mitsubishi Lancer EVO VI', 'Lancer Evo VI'],
  Metro6R4: ['Metro 6R4', 'Metro 6R4'],
  Micra: ['Nissan Micra', 'Nissan Micra'],
  NissanSkyline: ['Nissan Skyline', 'Nissan Skyline'],
  Peugeot205: ['Peugeot 205 T16 Rally', 'Peugeot 205'],
  Peugeot206: ['Peugeot 206', 'Peugeot 206'],
  Peugeot306: ['Peugeot 306 Ice Racing', 'Peugeot 306'],
  Peugeot405: ['Peugeot 405 T16 Hill Climb', 'Peugeot 405'],
  Renault5: ['Renault 5 Turbo', 'Renault 5 Turbo'],
  Saab93: ['Saab 9-3 T16 4x4', 'Saab 9-3 T16'],
  SaabViggen: ['Saab 93 Viggen Hill Climb', 'Saab 9-3 Viggen'],
  ToyotaTacoma: ['Toyota Tacoma Hill Climb', 'Toyota Tacoma'],
};

// ------------------------------------------------------------------------------------------- independent .cm reader

interface CmMat {
  name: string;
  fmt: number;
  stride: number;
  nv: number;
  group: number;
  verts: DataView;
  strip: Uint16Array;
  deform: Float32Array | null;
}

/** CarMesh v8 (cars.md §5), written from the spec text: header, LOD records, per-material headers then data. */
function readCm(bytes: Uint8Array): CmMat[][] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u32 = () => ((o += 4), dv.getUint32(o - 4, true));
  const u8 = () => dv.getUint8(o++);
  expect(u32()).toBe(8); // version
  u32(); // discarded
  o += 24; // AABB
  expect(u32()).toBe(0); // extras flag
  const nLod = u32();
  const lods: CmMat[][] = [];
  for (let l = 0; l < nLod; l++) {
    const keep = u8();
    const nMat = u32();
    const heads: { name: string; fmt: number; stride: number; nv: number; ni: number; group: number }[] = [];
    for (let m = 0; m < nMat; m++) {
      const len = u32();
      const name = new TextDecoder('latin1').decode(bytes.subarray(o, o + len)).replace(/\0+$/, '');
      o += len + 12; // name + exporter garbage
      expect(u32()).toBe(5); // triangle strip
      const fmt = u32();
      const stride = u32();
      const nv = u32();
      const ni = u32();
      u32();
      const group = u32();
      heads.push({ name: name.slice(name.lastIndexOf('/') + 1), fmt, stride, nv, ni, group });
    }
    lods.push(
      heads.map((h) => {
        const verts = new DataView(bytes.buffer, bytes.byteOffset + o, h.nv * h.stride);
        o += h.nv * h.stride;
        const strip = new Uint16Array(h.ni);
        for (let i = 0; i < h.ni; i++) strip[i] = dv.getUint16(o + 2 * i, true);
        o += 2 * h.ni;
        let deform: Float32Array | null = null;
        if (keep) {
          deform = new Float32Array(h.nv * 6);
          for (let i = 0; i < h.nv * 6; i++) deform[i] = dv.getFloat32(o + 4 * i, true);
          o += 24 * h.nv;
        }
        return { name: h.name, fmt: h.fmt, stride: h.stride, nv: h.nv, group: h.group, verts, strip, deform };
      }),
    );
  }
  expect(o).toBe(bytes.byteLength); // consumed to the last byte
  return lods;
}

/** cars.md §5.2 strip → list (odd triangles re-wound, degenerates dropped), then §5.4 winding swap (a, c, b). */
function stripToThreeTris(s: Uint16Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < s.length; i++) {
    const [a, b, c] = i % 2 === 0 ? [s[i], s[i + 1], s[i + 2]] : [s[i + 1], s[i], s[i + 2]];
    if (a === b || b === c || a === c) continue;
    out.push(a, c, b);
  }
  return out;
}

interface BuiltMat {
  name: string;
  sub: string;
  group: number;
  nv: number;
  ni: number;
  shader: { tex: string | null; dirt: boolean; kind: string; blend: string; lampBack: boolean };
  off: { pos: number; nrm: number; col: number; uv0: number; uv1?: number; dpos?: number; dnrm?: number; idx: number };
}
interface MeshesJson {
  lods: { dir: string; bin: string; triangles: number; meshes: { role: string; file: string; materials: BuiltMat[] }[] }[];
  wheels: Record<string, { file: string; lods: { materials: BuiltMat[] }[] }>;
  wheelsBin: string;
}

/** Built material ≡ .cm material: positions / normals (x, y, −z), BGRA → RGBA, uv0, uv1, deform, triangles. */
function compareMaterial(bin: ArrayBuffer, b: BuiltMat, c: CmMat, label: string): void {
  expect(b.nv, label).toBe(c.nv);
  expect(b.group, label).toBe(c.group);
  const pos = new Float32Array(bin, b.off.pos, b.nv * 3);
  const nrm = new Float32Array(bin, b.off.nrm, b.nv * 3);
  const col = new Uint8Array(bin, b.off.col, b.nv * 4);
  const uv0 = new Float32Array(bin, b.off.uv0, b.nv * 2);
  const uv1 = b.off.uv1 !== undefined ? new Float32Array(bin, b.off.uv1, b.nv * 2) : null;
  const hasCol = (c.fmt & 0x40) !== 0;
  const uvAt = 28 + (hasCol ? 0 : -4);
  let bad = 0;
  for (let i = 0; i < c.nv; i++) {
    const v = i * c.stride;
    const f = (k: number) => c.verts.getFloat32(v + k, true);
    if (pos[3 * i] !== f(0) || pos[3 * i + 1] !== f(4) || pos[3 * i + 2] !== -f(8)) bad++;
    if (nrm[3 * i] !== f(12) || nrm[3 * i + 1] !== f(16) || nrm[3 * i + 2] !== -f(20)) bad++;
    if (hasCol) {
      const bgra = [0, 1, 2, 3].map((k) => c.verts.getUint8(v + 24 + k));
      if (col[4 * i] !== bgra[2] || col[4 * i + 1] !== bgra[1] || col[4 * i + 2] !== bgra[0] || col[4 * i + 3] !== bgra[3]) bad++;
    }
    if (c.fmt & 0x400 && (uv0[2 * i] !== f(uvAt) || uv0[2 * i + 1] !== f(uvAt + 4))) bad++;
    if (uv1 && (uv1[2 * i] !== f(uvAt + 8) || uv1[2 * i + 1] !== f(uvAt + 12))) bad++;
  }
  expect(bad, `${label} vertex attributes`).toBe(0);
  if (b.off.dpos !== undefined) {
    expect(c.deform, label).not.toBeNull();
    const dp = new Float32Array(bin, b.off.dpos, b.nv * 3);
    const dn = new Float32Array(bin, b.off.dnrm!, b.nv * 3);
    for (let i = 0; i < c.nv; i++) {
      const d = c.deform!;
      if (dp[3 * i] !== d[6 * i] || dp[3 * i + 1] !== d[6 * i + 1] || dp[3 * i + 2] !== -d[6 * i + 2]) bad++;
      if (dn[3 * i] !== d[6 * i + 3] || dn[3 * i + 1] !== d[6 * i + 4] || dn[3 * i + 2] !== -d[6 * i + 5]) bad++;
    }
    expect(bad, `${label} deform`).toBe(0);
  } else expect(c.deform, label).toBeNull();
  const idx = new Uint16Array(bin, b.off.idx, b.ni);
  expect([...idx], `${label} triangles`).toEqual(stripToThreeTris(c.strip));
}

// ------------------------------------------------------------------------------------------- FUN_006c8ef0 reference

/** The wheel matrix exactly as FUN_006c8ef0 builds it (D3D rows R0..R2 + translation R3), SIM frame:
 *  translation on the identity basis; camber (rows 0/1, angle side·0.25·CAMBER[idx]); toe + steer + wheel[+0xd4]
 *  (rows 0/2); spin (rows 1/2, angle side·spinVar). `side` = +1 right, −1 left; spinVar = −∫ω dt. */
function origWheelMatrix(t: [number, number, number], side: number, camber: number, yaw: number, spinVar: number): number[][] {
  const R = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let c = Math.cos(camber);
  let s = Math.sin(camber);
  const r0 = R[0].map((v, k) => v * c + R[1][k] * s);
  const r1 = R[1].map((v, k) => v * c - R[0][k] * s);
  R[0] = r0;
  R[1] = r1;
  c = Math.cos(yaw);
  s = Math.sin(yaw);
  const q0 = R[0].map((v, k) => v * c - R[2][k] * s);
  const q2 = R[0].map((v, k) => v * s + R[2][k] * c);
  R[0] = q0;
  R[2] = q2;
  c = Math.cos(side * spinVar);
  s = Math.sin(side * spinVar);
  const p1 = R[1].map((v, k) => v * c + R[2][k] * s);
  const p2 = R[2].map((v, k) => v * c - R[1][k] * s);
  R[1] = p1;
  R[2] = p2;
  return [...R, t];
}

/** Column-form THREE matrix of a D3D row matrix in the sim frame: S·Mᵀ·S, S = diag(1, 1, −1). */
function toThree(rows: number[][]): THREE.Matrix4 {
  const S = [1, 1, -1];
  const m = new THREE.Matrix4();
  const e: number[] = [];
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) e.push(S[row] * rows[col][row] * S[col]);
  m.set(e[0], e[3], e[6], rows[3][0], e[1], e[4], e[7], rows[3][1], e[2], e[5], e[8], -rows[3][2], 0, 0, 0, 1);
  return m;
}

function fakeState(info: CarInfo, o: { steer?: number; spin?: number; brake?: number; tyre?: number; ghost?: boolean } = {}): CarRenderState {
  const wheels = info.wheels.map((w) => ({
    contact: true,
    surface: null,
    visual: {
      steerAngle: w.front ? (o.steer ?? 0) : 0,
      spinAngle: o.spin ?? 0,
      suspensionOffset: w.springLength * (1 - (w.rest?.ext ?? 0.88)),
      centreLocal: { x: 0, y: 0, z: 0 },
    },
  }));
  const telemetry = { speedKmh: 0, brake: o.brake ?? 0, gear: 1, tyreType: o.tyre ?? 0, wheels };
  return {
    id: 'p',
    archetype: 'awd_wrc',
    ghost: !!o.ghost,
    player: true,
    pos: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    telemetry: telemetry as unknown as CarRenderState['telemetry'],
    justReset: true,
  };
}

// ------------------------------------------------------------------------------------------- tests

describe('original cars without assets', () => {
  it('loadOriginalCar resolves null (procedural car) when no manifest is served', async () => {
    _setAssetFetchForTests(async () => new Response('not found', { status: 404 }));
    clearCarCache();
    const store = new TextureStore({} as THREE.WebGLRenderer, { s3tc: false });
    await expect(loadOriginalCar('ImprezaWRX', { textures: store.scope() })).resolves.toBeNull();
    _setAssetFetchForTests(null);
    store.dispose();
  });
});

describe('car camera table (cars.json camera → CameraTuning)', () => {
  const ent = (i: number, posA: number[], posB: number[] = [0, 0, 0], param: number[] = [0, 0, 0]): CarCameraEntry => ({
    i,
    enabled: true,
    flag: i < 5 ? 0 : 1,
    posA: posA as [number, number, number],
    posB: posB as [number, number, number],
    param: param as [number, number, number],
  });

  it('maps entries 0 / 1 / 5-8 / 10 / 12 / 24 onto the §5.3 views; none → null', () => {
    expect(carCameraTuning({})).toBeNull();
    expect(carCameraTuning({ camera: null })).toBeNull();
    expect(carCameraTuning({ camera: { template: 'X', attach: null, entries: [] } })).toBeNull();
    const t = carCameraTuning({
      camera: {
        template: 'XCarCamera',
        attach: [0, 1, 0.25],
        entries: [
          ent(0, [0, 0.45, 1.8]),
          ent(1, [0, 0.7, 1.05]),
          ent(2, [-0.4, 0.7, -0.55]),
          ent(5, [0, 1.3, -3.1], [0, 1.4, -3.2], [10, 0.5, 0]),
          ent(6, [0, 1.3, -3.5], [0, 1.4, -4], [10, 0.5, 0]),
          ent(7, [0, 1.3, -4.25], [0, 1.5, -4.75], [10, 0.5, 0]),
          ent(8, [0, 1.45, -5], [0, 2.5, -7], [11, 0.75, 0]),
          ent(10, [0.125, 32, 0], [4, 4.3, 4.2]),
          ent(12, [0.125, 8, 0], [5, 8.3, 8.2]),
          ent(24, [0, 0.4, -1.5]),
        ],
      },
    })!;
    expect(t.bumperPos).toEqual({ x: 0, y: 0.45, z: 1.8 });
    expect(t.bonnetPos).toEqual({ x: 0, y: 0.7, z: 1.05 });
    expect(t.lookBackPos).toEqual({ x: 0, y: 0.4, z: -1.5 });
    expect(t.chase?.chase).toEqual({ posA: { x: 0, y: 1.3, z: -3.5 }, posB: { x: 0, y: 1.4, z: -4 }, p0: 10, p1: 0.5 });
    expect(t.chase?.chaseHigh).toEqual({ posA: { x: 0, y: 1.45, z: -5 }, posB: { x: 0, y: 2.5, z: -7 }, p0: 11, p1: 0.75 });
    expect(t.tether?.tetherHigh).toEqual({ p0: 0.125, p1: 32, d: { x: 4, y: 4.3, z: 4.2 } });
    expect(t.tether?.tetherLow).toEqual({ p0: 0.125, p1: 8, d: { x: 5, y: 8.3, z: 8.2 } });
    // the global parts of the tuning are not per car
    expect(t.fov).toBeUndefined();
    expect(t.chaseHorizLerp).toBeUndefined();
    expect(t.bumperPitch).toBeUndefined();
  });

  it('the procedural stand-in stays hidden while an original car loads; it shows as the fallback', () => {
    const v = new CarVisual('awd_wrc');
    expect(v.root.visible).toBe(true);
    v.setOriginalPending(true);
    expect(v.root.visible).toBe(false);
    v.setVisible(true); // the renderer's per-frame visibility does not reveal it
    expect(v.root.visible).toBe(false);
    v.setOriginalPending(false); // load settled without an original (no assets / failure)
    expect(v.root.visible).toBe(true);
    v.setVisible(false); // bumper / look-back view
    expect(v.root.visible).toBe(false);
    v.dispose();
  });
});

describe.skipIf(!carsBuilt)('cars part on real data', () => {
  const tex = (id: string | null | undefined) => !!id && fs.existsSync(`${BUILT_ASSETS_DIR}/tex/${id}.rtex`);
  const info = (car: string) => readJson<CarInfo & { nameId: number }>(`${BUILT_ASSETS_DIR}/cars/${car}/cars.json`);
  const meshes = (car: string) => readJson<MeshesJson>(`${BUILT_ASSETS_DIR}/cars/${car}/cars/meshes.json`);

  it('all 29 cars and all 48 stage inputs are built (manifest)', () => {
    const m = readJson<{ cars: string[]; carParts: Record<string, string[]>; stages: Record<string, string[]> }>(`${BUILT_ASSETS_DIR}/manifest.json`);
    expect([...m.cars].sort()).toEqual([...ORIG_CAR_IDS]);
    for (const c of ORIG_CAR_IDS) expect(m.carParts[c], c).toContain('cars');
    const ported = listStages().filter((s) => /-(f|r)$/.test(s.id) && /^(corsica|hillclimb|iceracing|kenya|newzealand|rallycross)/.test(s.id));
    expect(ported.length).toBe(48);
    for (const s of ported) expect(m.stages[s.id] ?? [], s.id).toContain('cars');
  });

  it('names, wheel bundles, rest hub heights and wheel meshes = cars.md §4.4 / §10', () => {
    for (const car of ORIG_CAR_IDS) {
      const d = info(car);
      const [x, y, z, rlz, hubF, hubR, tarmac, gravel] = TABLE_44[car];
      expect(d.name, car).toBe(NAMES[car][0]);
      expect(d.shortName, car).toBe(NAMES[car][1]);
      expect(d.specs.length, car).toBe(2);
      expect(d.sliders?.length, car).toBe(3);
      expect(d.wheels.map((w) => w.index)).toEqual([0, 1, 2, 3]);
      const [fl, fr, rr, rl] = d.wheels;
      expect(fl.bundle, car).toEqual([x, y, z]);
      expect(fr.bundle, car).toEqual([-x, y, z]); // FR mirrors FL
      expect(rl.bundle[2], car).toBe(rlz);
      expect(rr.bundle, car).toEqual([-rl.bundle[0], rl.bundle[1], rl.bundle[2]]);
      expect(d.wheels.map((w) => w.yawDeg), car).toEqual([0, 180, 180, 0]);
      expect(d.wheels.map((w) => w.cornerSign), car).toEqual([-1, 1, 1, -1]);
      // camber = side·0.25·CAMBER[3 front | 4 rear], toe 0 (cars.md §4.2 Verification)
      d.wheels.forEach((w, i) => expect(w.camberRad, car).toBeCloseTo([-0.0125, 0.0125, 0.01675, -0.01675][i], 12));
      for (const w of d.wheels) expect(Math.abs(w.toeRad), car).toBe(0);
      // rest hub y = B.y − max(0.85, ext)·L (§4.3)
      const hub = (w: (typeof d.wheels)[number]) => w.bundle[1] - Math.max(0.85, w.rest!.ext) * w.springLength;
      expect(Math.abs(hub(fl) - hubF), `${car} front hub`).toBeLessThan(0.0011);
      expect(Math.abs(hub(rl) - hubR), `${car} rear hub`).toBeLessThan(0.0011);
      // garage bundles: +0.05…0.105 m on every wheel, x / z unchanged (TemplatesMenu.con, §3)
      const dy = fl.menuBundle[1] - fl.bundle[1];
      expect(dy, car).toBeGreaterThanOrEqual(0.05 - 1e-9);
      expect(dy, car).toBeLessThanOrEqual(0.105 + 1e-9);
      for (const w of d.wheels) expect([w.menuBundle[0], w.menuBundle[1] - w.bundle[1], w.menuBundle[2]], car).toEqual([w.bundle[0], expect.closeTo(dy, 9), w.bundle[2]]);
      expect(d.wheelMeshes.tarmac, car).toBe(`Wheel${tarmac}`);
      // Astra's WheelGravel6Grey is undefined in Wheels.con (original data bug) → its tarmac wheel
      expect(d.wheelMeshes.gravel, car).toBe(car === 'Astra' ? `Wheel${tarmac}` : `Wheel${gravel}`);
      expect(d.missing, car).toEqual(car === 'Astra' ? ['wheelGeometry:WheelGravel6Grey'] : []);
    }
  });

  it.skipIf(!fs.existsSync(`${ORIG}/Cars/cars/ImprezaWRX/Templates.con`))(
    'camera table = each car\'s own Templates.con <Car>CarCamera; ImprezaWRX = the generic §5.3 table',
    () => {
      const gen = makeCameraTuning();
      let own = 0;
      for (const car of ORIG_CAR_IDS) {
        const cam = info(car).camera;
        expect(cam?.template, car).toBe(`${car}CarCamera`);
        expect(cam?.attach, car).toEqual([0, 1, 0.25]);
        // independent read of the script lines (`rem` lines skipped)
        const text = new TextDecoder('latin1').decode(fs.readFileSync(`${ORIG}/Cars/cars/${car}/Templates.con`));
        const want = new Map<number, number[][]>();
        let inCam = false;
        for (const raw of text.split(/\r?\n/)) {
          const t = raw.trim().split(/\s+/);
          if (t[0] === 'ObjectTemplate.create') inCam = t[1] === 'CarCamera' && t[2] === `${car}CarCamera`;
          else if (inCam && t[0] === 'ObjectTemplate.setCamPosition') {
            want.set(+t[1], [[+t[2], +t[3]], ...t.slice(4, 7).map((v) => v.split('/').map(Number))]);
          }
        }
        expect(want.size, car).toBe(25);
        expect(cam!.entries.map((e) => e.i), car).toEqual([...want.keys()].sort((a, b) => a - b));
        for (const e of cam!.entries) {
          const [[en, fl], a, b, p] = want.get(e.i)!;
          expect([e.enabled ? 1 : 0, e.flag, e.posA, e.posB, e.param], `${car} entry ${e.i}`).toEqual([en, fl, a, b, p]);
        }
        // the 8 cycle views of §5.3 are enabled on every car
        expect(cam!.entries.filter((e) => e.enabled).map((e) => e.i), car).toEqual([0, 1, 5, 6, 7, 8, 10, 12]);
        const t = carCameraTuning(info(car))!;
        expect(t.bonnetPos, car).toEqual({ x: a3(want.get(1)![1]).x, y: a3(want.get(1)![1]).y, z: a3(want.get(1)![1]).z });
        if (JSON.stringify(t.bonnetPos) !== JSON.stringify(gen.bonnetPos) || JSON.stringify(t.chase) !== JSON.stringify(gen.chase)) own++;
        if (car === 'ImprezaWRX') {
          const { bumperPos, bonnetPos, lookBackPos, chase, tether } = gen;
          expect(t).toEqual({ bumperPos, bonnetPos, lookBackPos, chase, tether });
        }
      }
      // 20 cars have their own bonnet, 15 their own bumper, 8 their own chase (the rest = ImprezaWRX = the generic)
      expect(own).toBeGreaterThanOrEqual(20);
      const ff = carCameraTuning(info('FordFocus'))!;
      expect(ff.bonnetPos).toEqual({ x: 0, y: 0.7, z: 1.05 });
      expect(ff.bumperPos).toEqual({ x: 0, y: 0.45, z: 1.8 });
      const esc = carCameraTuning(info('Escudo'))!;
      expect(esc.chase?.chase).toEqual({ posA: { x: 0, y: 1.3, z: -3.5 }, posB: { x: 0, y: 1.5, z: -4 }, p0: 10, p1: 0.5 });
    },
  );

  it('every texId of every car and stage file resolves to tex/<id>.rtex', () => {
    const ids = new Set<string>();
    const walk = (v: unknown): void => {
      if (typeof v === 'string' && /^[0-9a-f]{20}$/.test(v)) ids.add(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    for (const car of ORIG_CAR_IDS) {
      walk(info(car));
      const m = meshes(car);
      walk(m);
      for (const l of m.lods) for (const mesh of l.meshes) for (const mat of mesh.materials) if (mat.sub !== 'lambert1') expect(mat.shader.tex === null || tex(mat.shader.tex), `${car} ${mat.name}`).toBe(true);
      const d = info(car);
      expect(d.menuEnvCube?.length, car).toBe(6);
      expect(tex(d.dropShadow.tex), car).toBe(true);
    }
    const stages = listStages().filter((s) => fs.existsSync(`${BUILT_ASSETS_DIR}/stages/${s.id}/cars.json`));
    expect(stages.length).toBe(48);
    for (const s of stages) {
      const j = readJson<{ envCube: string[]; dirtMap: string }>(`${BUILT_ASSETS_DIR}/stages/${s.id}/cars.json`);
      expect(j.envCube.length, s.id).toBe(6);
      expect(tex(j.dirtMap), s.id).toBe(true);
      walk(j);
    }
    const missing = [...ids].filter((id) => !tex(id));
    expect(missing).toEqual([]);
    expect(ids.size).toBeGreaterThan(200);
  });

  it.skipIf(!fs.existsSync(DUMP))('materials and vertex counts per LOD set = the verified parser (fmt_cars dump)', () => {
    type DM = { material: string; subshader: string | null; nv: number; ni: number; group: number; texture?: string | null };
    const dump = readJson<{ cars: Record<string, { parts: { role: string; lodSets: Record<string, { lods: { materials: DM[] }[] }> }[] }> }>(DUMP);
    for (const car of ORIG_CAR_IDS) {
      const m = meshes(car);
      expect(m.lods.map((l) => l.dir), car).toEqual(['Cars', 'Cars_1', 'Cars_2', 'Cars_3']);
      for (const l of m.lods) {
        let tris = 0;
        for (const part of dump.cars[car].parts) {
          const ls = part.lodSets[l.dir];
          const built = l.meshes.find((x) => x.role === part.role);
          if (!ls) {
            expect(built, `${car} ${l.dir} ${part.role}`).toBeUndefined(); // Cars_3 has no Interior
            continue;
          }
          const lod0 = part.lodSets.Cars.lods[0].materials;
          // drawn = has a subshader, or its LOD0 set has one (ImprezaWRX Cars_1 `accesories`); `lambert1` never
          const drawn = ls.lods[0].materials.filter((x) => x.subshader !== null || lod0.some((y) => y.material === x.material && y.subshader !== null));
          expect(built!.materials.map((x) => [x.name, x.nv, x.group]), `${car} ${l.dir} ${part.role}`).toEqual(drawn.map((x) => [x.material, x.nv, x.group]));
          built!.materials.forEach((b, i) => {
            expect(b.ni % 3).toBe(0);
            expect(b.ni / 3, `${car} ${b.name}`).toBeLessThanOrEqual(drawn[i].ni - 2);
            expect(b.shader.tex !== null, `${car} ${b.name} texture`).toBe(!!(drawn[i].texture ?? lod0.find((y) => y.material === b.name)?.texture));
            tris += b.ni / 3;
          });
        }
        expect(l.triangles, `${car} ${l.dir}`).toBe(tris);
      }
    }
  });

  it.skipIf(!origPresent)('3 cars, every LOD set + both wheels (4 LODs): every vertex and triangle = an independent .cm reader', async () => {
    for (const car of ['ImprezaWRX', 'Peugeot206', 'ToyotaTacoma']) {
      const m = meshes(car);
      for (const l of m.lods) {
        const bin = fs.readFileSync(`${BUILT_ASSETS_DIR}/cars/${car}/${l.bin}`);
        const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
        for (const mesh of l.meshes) {
          const cm = readCm(fs.readFileSync(`${ORIG}/${mesh.file}`));
          expect(cm.length).toBe(1);
          let j = 0;
          for (const b of mesh.materials) {
            while (cm[0][j].name !== b.name) j++; // skipped (lambert1) materials
            compareMaterial(buf, b, cm[0][j++], `${car} ${l.dir} ${mesh.role} ${b.name}`);
          }
        }
      }
      const wbin = fs.readFileSync(`${BUILT_ASSETS_DIR}/cars/${car}/${m.wheelsBin}`);
      const wbuf = wbin.buffer.slice(wbin.byteOffset, wbin.byteOffset + wbin.byteLength) as ArrayBuffer;
      for (const [name, w] of Object.entries(m.wheels)) {
        const cm = readCm(fs.readFileSync(`${ORIG}/${w.file}`));
        expect(cm.length, name).toBe(4);
        w.lods.forEach((lod, li) => {
          let j = 0;
          for (const b of lod.materials) {
            while (cm[li][j].name !== b.name) j++;
            compareMaterial(wbuf, b, cm[li][j++], `${name} lod${li} ${b.name}`);
          }
        });
        // tyre radius 0.330 at every internal LOD (cars.md §4.5), axle = x
        for (const lod of cm) {
          const tire = lod.find((x) => x.name === 'tire');
          if (!tire) continue;
          let r = 0;
          for (let i = 0; i < tire.nv; i++) r = Math.max(r, Math.hypot(tire.verts.getFloat32(i * tire.stride + 4, true), tire.verts.getFloat32(i * tire.stride + 8, true)));
          expect(r, name).toBeCloseTo(0.33, 2);
        }
      }
    }
  }, 120000);

  describe('runtime visual (JS texture path, no GL)', () => {
    let store: TextureStore;
    let vis: OriginalCarVisual;
    beforeAll(async () => {
      useBuiltAssets();
      clearCarCache();
      store = new TextureStore({} as THREE.WebGLRenderer, { s3tc: false });
      const v = await loadOriginalCar('ImprezaWRX', { textures: store.scope(), stageId: 'corsica-1-f' });
      expect(v).not.toBeNull();
      vis = v!;
    }, 60000);
    afterAll(() => {
      vis?.dispose();
      store?.dispose();
      _setAssetFetchForTests(null);
    });

    it('wheel matrices = FUN_006c8ef0 (camber outermost, toe + steer + template yaw, spin innermost) under S·M·S', () => {
      const steer = 0.3;
      const spin = 1.234;
      vis.apply(fakeState(vis.info, { steer, spin }), 0, null);
      vis.root.updateMatrixWorld(true);
      for (const w of vis.info.wheels) {
        const root = vis.wheels[w.index];
        expect(root.name).toBe(`wheel${w.index}`);
        // the wheel mesh group (child of the spin group) relative to the body root
        const meshGroup = root.children[0].children[0].children[0].children[0];
        const got = meshGroup.matrixWorld.clone();
        const ext = Math.max(0.85, w.rest!.ext);
        const k = w.steerTweak * (w.index === 1 ? -1 : 1);
        const t: [number, number, number] = w.front
          ? [w.bundle[0] + (1 - Math.cos(steer)) * k, w.bundle[1] - ext * w.springLength, w.bundle[2] + Math.sin(steer) * k]
          : [w.bundle[0], w.bundle[1] - ext * w.springLength, w.bundle[2]];
        const yaw = w.toeRad + (w.front ? steer : 0) + (w.yawDeg * Math.PI) / 180;
        const want = toThree(origWheelMatrix(t, w.cornerSign, w.camberRad, yaw, -spin));
        for (let i = 0; i < 16; i++) expect(got.elements[i], `wheel ${w.index} [${i}]`).toBeCloseTo(want.elements[i], 6);
      }
      // the rim face (mesh −x) points outward on both sides
      const out = (i: number) => new THREE.Vector3(-1, 0, 0).transformDirection(vis.wheels[i].children[0].children[0].children[0].children[0].matrixWorld).x;
      expect(out(0)).toBeLessThan(-0.9);
      expect(out(1)).toBeGreaterThan(0.9);
    });

    it('LOD set by camera distance; gravel wheel for tyre types 2..4', () => {
      const cam = new THREE.PerspectiveCamera();
      const lodAt = (d: number) => {
        cam.position.set(0, 1, d);
        cam.updateMatrixWorld();
        vis.apply(fakeState(vis.info), 1 / 60, cam);
        return vis.lod;
      };
      expect(lodAt(5)).toBe(0);
      expect(lodAt(LOD_DIST[0] + 1)).toBe(1);
      expect(lodAt(LOD_DIST[1] + 1)).toBe(2);
      expect(lodAt(LOD_DIST[2] + 1)).toBe(3);
      expect(lodAt(5)).toBe(0);
      const visibleSet = () => vis.wheels[0].children[0].children[0].children[0].children.findIndex((g) => g.visible);
      vis.apply(fakeState(vis.info, { tyre: 0 }), 1 / 60, cam);
      const tarmac = visibleSet();
      vis.apply(fakeState(vis.info, { tyre: 3 }), 1 / 60, cam);
      expect(visibleSet()).not.toBe(tarmac);
      vis.apply(fakeState(vis.info, { tyre: 1 }), 1 / 60, cam);
      expect(visibleSet()).toBe(tarmac);
    });

    it('LampBack materials switch to TexSimple while braking; materials bind the stage env cube', () => {
      const lamps: THREE.ShaderMaterial[] = [];
      vis.root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
        if (m?.defines && 'LAMPBACK' in m.defines) lamps.push(m);
      });
      expect(lamps.length).toBeGreaterThan(0);
      vis.apply(fakeState(vis.info, { brake: 1 }), 1 / 60, null);
      expect(lamps.every((m) => m.uniforms.uBrake.value === 1)).toBe(true);
      vis.apply(fakeState(vis.info, { brake: 0 }), 1 / 60, null);
      expect(lamps.every((m) => m.uniforms.uBrake.value === 0)).toBe(true);
      expect(lamps[0].uniforms.tEnv.value).toBeInstanceOf(THREE.CompressedCubeTexture);
    });

    it('ghost car: every material translucent, no lens flares', async () => {
      const g = await loadOriginalCar('ImprezaWRX', { textures: store.scope(), ghost: true });
      expect(g).not.toBeNull();
      let n = 0;
      g!.root.traverse((o) => {
        if ((o as THREE.Sprite).isSprite) throw new Error('ghost has a flare');
        const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
        if (!m) return;
        n++;
        expect(m.transparent).toBe(true);
        expect('GHOST' in m.defines).toBe(true);
      });
      expect(n).toBeGreaterThan(20);
      g!.dispose();
    });
  });
});
