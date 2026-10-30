/**
 * tests/render/fixtures/synthStage.ts — synthetic Stage for render tests and the render preview page
 * (tools/render-preview/). Render builder owned. Not a real stage: no WorldQuery, brute-force project().
 *
 * A ~2 km winding, hilly road cycling through the requested surfaces in 200 m sections, a 4 m
 * heightfield with the road bed carved in, every scenery kind placed along the road, start / split /
 * finish, and a selectable environment.
 */
import { MATERIAL } from '../../../src/core/constants';
import { Rng } from '../../../src/core/rng';
import type {
  EnvironmentPreset,
  Heightfield,
  RoadSample,
  SceneryInstance,
  SceneryKind,
  Stage,
  StageProjection,
  SurfaceId,
  ThreeV3,
} from '../../../src/core/types';

export type SynthEnv = 'day' | 'dusk' | 'snow' | 'overcast' | 'night' | 'desert';

export const SYNTH_ENVS: Record<SynthEnv, EnvironmentPreset> = {
  day: {
    name: 'Clear day', timeOfDay: 13, skyTop: 0x4f86d4, skyHorizon: 0xc4d9ee, fogColor: 0xc8dbeb, fogNear: 180, fogFar: 1100,
    sunColor: 0xfff1dc, sunIntensity: 2.4, sunDir: { x: 0.42, y: 0.78, z: 0.46 }, ambientSky: 0xbcd4f0, ambientGround: 0x6b6250,
    ambientIntensity: 0.95, weather: 'clear', exposure: 1.0,
  },
  dusk: {
    name: 'Late sun', timeOfDay: 18.5, skyTop: 0x3c5c9a, skyHorizon: 0xf0b48a, fogColor: 0xdeb595, fogNear: 140, fogFar: 900,
    sunColor: 0xffc890, sunIntensity: 2.6, sunDir: { x: -0.75, y: 0.22, z: 0.62 }, ambientSky: 0x9cb0d8, ambientGround: 0x6a5040,
    ambientIntensity: 0.75, weather: 'clear', exposure: 1.05,
  },
  snow: {
    name: 'Snowfall', timeOfDay: 11, skyTop: 0x9aa9bc, skyHorizon: 0xd6dde6, fogColor: 0xd2d9e2, fogNear: 60, fogFar: 520,
    sunColor: 0xf2f4ff, sunIntensity: 1.2, sunDir: { x: 0.3, y: 0.7, z: -0.6 }, ambientSky: 0xd8e2f0, ambientGround: 0x9aa2ac,
    ambientIntensity: 1.25, weather: 'snow', exposure: 1.0,
  },
  overcast: {
    name: 'Overcast rain', timeOfDay: 15, skyTop: 0x7b8794, skyHorizon: 0xaeb6bf, fogColor: 0xa9b1ba, fogNear: 80, fogFar: 650,
    sunColor: 0xe8ecf2, sunIntensity: 1.0, sunDir: { x: 0.2, y: 0.85, z: 0.3 }, ambientSky: 0xc0c8d2, ambientGround: 0x5a5a52,
    ambientIntensity: 1.2, weather: 'rain', exposure: 1.05,
  },
  night: {
    name: 'Night', timeOfDay: 22, skyTop: 0x060a16, skyHorizon: 0x1a2236, fogColor: 0x141a28, fogNear: 40, fogFar: 420,
    sunColor: 0x8ea4d8, sunIntensity: 0.35, sunDir: { x: 0.3, y: 0.6, z: 0.5 }, ambientSky: 0x3a4a6a, ambientGround: 0x14161c,
    ambientIntensity: 0.4, weather: 'clear', exposure: 1.2,
  },
  desert: {
    name: 'Desert haze', timeOfDay: 16, skyTop: 0x5d8fcc, skyHorizon: 0xe6d6b8, fogColor: 0xe2d2b4, fogNear: 150, fogFar: 1000,
    sunColor: 0xffe7c4, sunIntensity: 2.6, sunDir: { x: -0.5, y: 0.6, z: 0.6 }, ambientSky: 0xc8d4e4, ambientGround: 0x8a7458,
    ambientIntensity: 0.9, weather: 'dust', exposure: 1.0,
  },
};

const TERRAIN_FOR: Record<SurfaceId, SurfaceId> = {
  tarmac: 'grass', gravel: 'grass', gravelDeep: 'gravel', mud: 'grass', snow: 'snow', ice: 'snow', grass: 'grass',
  sand: 'sand', cobbles: 'grass', water: 'grass', wood: 'grass', snowChunky: 'snow', snowDeep: 'snow',
  snowAsphalt: 'snow', snowDitch: 'snow', leaf: 'grass', asphaltGrass: 'grass', gravelGrass: 'grass',
  mudGrass: 'grass', mudDitch: 'mud', sandDeep: 'sand', sandDark: 'sand', sandDarkDeep: 'sand',
};

export interface SynthOptions {
  surfaces?: SurfaceId[];
  env?: SynthEnv;
  seed?: number;
  length?: number;
  width?: number;
  flat?: boolean;
}

export function synthStage(o: SynthOptions = {}): Stage {
  const surfaces = o.surfaces ?? ['gravel', 'tarmac', 'snow', 'mud', 'ice', 'sand', 'grass', 'gravelDeep', 'cobbles', 'water'];
  const env = SYNTH_ENVS[o.env ?? 'day'];
  const rng = new Rng(o.seed ?? 3);
  const L = o.length ?? 2000;
  const W = o.width ?? 8;
  const step = 2;
  // ---- centre line (three space): heading from summed sines, start heading -Z
  const pts: { x: number; y: number; z: number; h: number; k: number }[] = [];
  let x = 0, z = 0, h = 0;
  for (let s = 0; s <= L + 1e-6; s += step) {
    const k = s < 60 ? 0 : 0.011 * Math.sin(s / 95) + 0.007 * Math.sin(s / 41 + 1.3) + 0.004 * Math.sin(s / 23);
    const y = 9 * Math.sin(s / 260) + 3.5 * Math.sin(s / 77 + 0.6);
    pts.push({ x, y: o.flat ? 0 : y - 3.5 * Math.sin(0.6), z, h, k });
    h += k * step;
    x += -Math.sin(h) * step;
    z += -Math.cos(h) * step;
  }
  const N = pts.length;
  const surfaceAt = (s: number): SurfaceId => surfaces[Math.min(surfaces.length - 1, Math.floor(s / 200)) % surfaces.length] ?? 'gravel';
  const idx = (s: number) => Math.min(N - 1.000001, Math.max(0, s / step));
  const pointAt = (s: number): ThreeV3 => {
    const f = idx(s), i = Math.floor(f), t = f - i;
    const a = pts[i], b = pts[Math.min(N - 1, i + 1)];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  };
  const tangentAt = (s: number): ThreeV3 => {
    const a = pointAt(Math.max(0, s - 1)), b = pointAt(Math.min(L, s + 1));
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    return { x: dx / l, y: dy / l, z: dz / l };
  };
  const roadAt = (s: number): RoadSample => {
    const p = pointAt(s);
    const t = tangentAt(s);
    const f = idx(s);
    const k = pts[Math.floor(f)].k;
    const bank = Math.max(-0.08, Math.min(0.08, -k * 6)); // k > 0 = left bend; + bank = tilts down to the right
    const rx = -t.z, rz = t.x;
    const rl = Math.hypot(rx, rz) || 1;
    const ux = rx / rl, uz = rz / rl;
    const hw = W / 2;
    return {
      s,
      pos: p,
      left: { x: p.x - ux * hw, y: p.y + Math.sin(bank) * hw, z: p.z - uz * hw },
      right: { x: p.x + ux * hw, y: p.y - Math.sin(bank) * hw, z: p.z + uz * hw },
      width: W,
      bank,
      surface: surfaceAt(s),
    };
  };
  const road: RoadSample[] = [];
  for (let s = 0; s <= L; s += 3) road.push(roadAt(s));

  // ---- heightfield
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const margin = 260, cell = 4;
  const originX = Math.floor((minX - margin) / cell) * cell, originZ = Math.floor((minZ - margin) / cell) * cell;
  const nx = Math.ceil((maxX - originX + margin) / cell) + 1, nz = Math.ceil((maxZ - originZ + margin) / cell) + 1;
  const heights = new Float32Array(nx * nz);
  const materials = new Uint8Array(nx * nz);
  // coarse nearest-sample grid for distance-to-road
  const hill = (px: number, pz: number) =>
    o.flat ? 0 : 7 * Math.sin(px / 83) * Math.cos(pz / 97) + 4 * Math.sin(px / 31 + pz / 47) + 2.2 * Math.cos(pz / 19 - px / 23);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const px = originX + ix * cell, pz = originZ + iz * cell;
      // nearest road sample (sparse scan)
      let best = Infinity, bi = 0;
      for (let i = 0; i < road.length; i += 4) {
        const r = road[i];
        const d = (r.pos.x - px) ** 2 + (r.pos.z - pz) ** 2;
        if (d < best) {
          best = d;
          bi = i;
        }
      }
      for (let i = Math.max(0, bi - 4); i < Math.min(road.length, bi + 5); i++) {
        const r = road[i];
        const d = (r.pos.x - px) ** 2 + (r.pos.z - pz) ** 2;
        if (d < best) {
          best = d;
          bi = i;
        }
      }
      const r = road[bi];
      const d = Math.sqrt(best);
      // height of the (banked) road plane at this point
      const ex = r.right.x - r.left.x, ez = r.right.z - r.left.z;
      const fl = Math.max(0, Math.min(1, ((px - r.left.x) * ex + (pz - r.left.z) * ez) / (ex * ex + ez * ez)));
      const roadY = r.left.y + (r.right.y - r.left.y) * fl;
      const natural = r.pos.y + hill(px, pz) * Math.min(1, d / 60) + (d > 20 ? (d - 20) * 0.05 : 0);
      const tB = Math.max(0, Math.min(1, (d - W / 2 - 1) / 14));
      const sm = tB * tB * (3 - 2 * tB);
      heights[iz * nx + ix] = roadY + (natural - roadY) * sm;
      const sec = TERRAIN_FOR[r.surface];
      materials[iz * nx + ix] = MATERIAL[sec];
    }
  }
  const hf: Heightfield = { originX, originZ, cellSize: cell, nx, nz, heights, materials };
  const hAt = (px: number, pz: number) => {
    const fx = Math.max(0, Math.min(nx - 1.001, (px - originX) / cell)), fz = Math.max(0, Math.min(nz - 1.001, (pz - originZ) / cell));
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const a = heights[iz * nx + ix], b = heights[iz * nx + ix + 1], c = heights[(iz + 1) * nx + ix], d = heights[(iz + 1) * nx + ix + 1];
    return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
  };

  // ---- scenery
  const scenery: SceneryInstance[] = [];
  const put = (kind: SceneryKind, s: number, lat: number, rotY?: number, scale = 1, height = 0) => {
    const p = pointAt(s), t = tangentAt(s);
    const rx = -t.z, rz = t.x;
    const rl = Math.hypot(rx, rz) || 1;
    const px = p.x + (rx / rl) * lat, pz = p.z + (rz / rl) * lat;
    scenery.push({ kind, pos: { x: px, y: hAt(px, pz), z: pz }, rotY: rotY ?? Math.atan2(-t.x, -t.z), scale, radius: 0.5, height });
  };
  for (let s = 10; s < L; s += 25) {
    put('post', s, -(W / 2 + 1.2));
    put('post', s + 12, W / 2 + 1.2);
  }
  for (let s = 30; s < L; s += 7) {
    const surf = surfaceAt(s);
    for (const side of [-1, 1]) {
      if (rng.next() < 0.55) {
        const lat = side * (W / 2 + 7 + rng.next() * 45);
        const kind: SceneryKind =
          surf === 'sand' ? (rng.next() < 0.5 ? 'cactus' : 'rock') : surf === 'snow' || surf === 'ice' ? 'pine' : rng.next() < 0.45 ? 'pine' : rng.next() < 0.6 ? 'tree' : rng.next() < 0.5 ? 'bush' : 'rock';
        put(kind, s + rng.next() * 6, lat, rng.next() * 6.28, 0.7 + rng.next() * 0.6);
      }
    }
  }
  // corner chevrons, snowbanks, spectators and props
  for (let s = 80; s < L; s += 40) {
    const k = pts[Math.floor(idx(s))].k;
    if (Math.abs(k) > 0.012) {
      const outside = k > 0 ? 1 : -1; // k > 0 = left bend: outside is the right
      const t = tangentAt(s);
      put('marker', s, outside * (W / 2 + 2.2), Math.atan2(-t.x, -t.z) + Math.PI);
    }
  }
  for (let s = 0; s < L; s += 200) {
    const surf = surfaceAt(s + 10);
    if (surf === 'snow' || surf === 'ice') for (let q = s; q < s + 200; q += 7) for (const side of [-1, 1]) put('snowbank', q, side * (W / 2 + 1.6), undefined, 0.8 + rng.next() * 0.4);
  }
  const props: [SceneryKind, number, number][] = [
    ['spectator', 130, -9], ['spectator', 131, -9.8], ['spectator', 132.5, -9.2], ['spectator', 134, -10], ['spectator', 129, -10.5],
    ['tent', 140, -14], ['banner', 120, -6.5], ['hayBale', 150, 6.5], ['hayBale', 152, 6.8], ['tyreStack', 170, -6.2], ['tyreStack', 171.2, -6.2],
    ['cone', 60, 4.5], ['cone', 64, 4.5], ['cone', 68, 4.5], ['sign', 90, 6], ['fence', 260, -8], ['fence', 264, -8], ['barrier', 300, 5.2],
    ['barrier', 303.1, 5.2], ['house', 420, -30], ['barn', 460, 34], ['pole', 30, -8], ['grandstand', 40, 16], ['deadTree', 520, 14],
    ['boulder', 560, -12], ['boulder', 620, 13],
  ];
  for (const [kind, s, lat] of props) put(kind, s, lat);
  return {
    id: 'synth',
    name: 'Synthetic render test',
    discipline: 'rally',
    description: 'Render-builder fixture',
    seed: o.seed ?? 3,
    closed: false,
    laps: 1,
    length: L,
    defaultTyre: 2,
    pointAt,
    tangentAt,
    roadAt,
    project(pos: ThreeV3, hintS?: number): StageProjection {
      let best = Infinity, bs = 0;
      const lo = hintS !== undefined ? Math.max(0, hintS - 60) : 0, hi = hintS !== undefined ? Math.min(L, hintS + 60) : L;
      for (let s = lo; s <= hi; s += 1) {
        const p = pointAt(s);
        const d = (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2;
        if (d < best) {
          best = d;
          bs = s;
        }
      }
      const p = pointAt(bs), t = tangentAt(bs);
      const lateral = (pos.x - p.x) * -t.z + (pos.z - p.z) * t.x;
      return { s: bs, lateral, heightOffset: pos.y - p.y, point: p };
    },
    startS: 20,
    startPose: { pos: pointAt(20), dir: tangentAt(20) },
    checkpoints: [700, 1400].filter((c) => c < L - 100),
    finishS: L - 40,
    validRange: [0, L],
    environment: env,
    heightfield: hf,
    road,
    scenery,
    pacenotes: [],
  };
}
