/**
 * src/world/environments.ts — lighting / atmosphere presets per stage (THREE space directions,
 * colours 0xRRGGBB), plus a ground/foliage palette for the renderer.
 *
 * `palette` is the optional EnvironmentPreset.palette of the contract (core/types.ts EnvironmentPalette);
 * WorldEnvironment makes it required for the world's own presets. Renderers fall back to SURFACE_INFO
 * colours when absent.
 */
import type { EnvironmentPalette, EnvironmentPreset, ThreeV3 } from '../core/types';

export type { EnvironmentPalette } from '../core/types';

export interface WorldEnvironment extends EnvironmentPreset {
  palette: EnvironmentPalette;
}

const dir = (x: number, y: number, z: number): ThreeV3 => {
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
};

export const ENVIRONMENTS: Readonly<Record<string, WorldEnvironment>> = Object.freeze({
  testpad: {
    name: 'Proving ground, clear noon',
    timeOfDay: 12,
    skyTop: 0x5d8fd6,
    skyHorizon: 0xc9dcef,
    fogColor: 0xc9dcef,
    fogNear: 200,
    fogFar: 1600,
    sunColor: 0xfff2dd,
    sunIntensity: 2.2,
    sunDir: dir(0.45, 0.8, 0.4),
    ambientSky: 0xbcd4f0,
    ambientGround: 0x6b6250,
    ambientIntensity: 0.9,
    weather: 'clear',
    exposure: 1,
    palette: { ground: {}, rock: 0x8a8580, foliage: 0x3f6b35, foliageDry: 0x7a7a3a, trunk: 0x5b4330, snowCover: 0, horizon: 0x8fa3b5 },
  },
  pineRidge: {
    name: 'Pine forest, late afternoon',
    timeOfDay: 16.5,
    skyTop: 0x4a78c0,
    skyHorizon: 0xdcc9a2,
    fogColor: 0xbdb9a0,
    fogNear: 110,
    fogFar: 950,
    sunColor: 0xffd49a,
    sunIntensity: 2.4,
    sunDir: dir(-0.62, 0.42, 0.66),
    ambientSky: 0xa9c0da,
    ambientGround: 0x4b4a33,
    ambientIntensity: 0.8,
    weather: 'clear',
    exposure: 1.05,
    palette: { ground: { grass: 0x55692f, gravel: 0x9c8462, mud: 0x5a4430 }, rock: 0x7d776d, foliage: 0x29462a, foliageDry: 0x6b6a38, trunk: 0x58402c, snowCover: 0, horizon: 0x52664a },
  },
  colDuVent: {
    name: 'Mountain pass, crisp morning',
    timeOfDay: 9.5,
    skyTop: 0x2d6bd4,
    skyHorizon: 0xbfdaf3,
    fogColor: 0xc8ddf0,
    fogNear: 260,
    fogFar: 2400,
    sunColor: 0xfff3df,
    sunIntensity: 2.6,
    sunDir: dir(0.55, 0.58, -0.6),
    ambientSky: 0xc4d9f4,
    ambientGround: 0x6b6450,
    ambientIntensity: 0.9,
    weather: 'clear',
    exposure: 1,
    palette: { ground: { grass: 0x6c8744, gravel: 0x938b7c }, rock: 0x8d8882, foliage: 0x355733, foliageDry: 0x8a8448, trunk: 0x5d4a38, snowCover: 0, horizon: 0x8798ad },
  },
  frostvale: {
    name: 'Snowy valley, overcast',
    timeOfDay: 14,
    skyTop: 0x8a98aa,
    skyHorizon: 0xd6dee7,
    fogColor: 0xd4dce5,
    fogNear: 70,
    fogFar: 700,
    sunColor: 0xe8eef8,
    sunIntensity: 1.2,
    sunDir: dir(0.3, 0.38, 0.87),
    ambientSky: 0xdce7f3,
    ambientGround: 0x9da7b1,
    ambientIntensity: 1.25,
    weather: 'snow',
    exposure: 1,
    palette: { ground: { snow: 0xe9eef4, ice: 0xbcd6e6 }, rock: 0x6b6e73, foliage: 0x2d4a3d, foliageDry: 0x55604f, trunk: 0x4a3b31, snowCover: 0.6, horizon: 0xaab6c4 },
  },
  redBasin: {
    name: 'Desert basin, hot midday',
    timeOfDay: 13,
    skyTop: 0x3b7bc8,
    skyHorizon: 0xe9d0a8,
    fogColor: 0xddc39d,
    fogNear: 220,
    fogFar: 1800,
    sunColor: 0xfff0d4,
    sunIntensity: 3.0,
    sunDir: dir(0.22, 0.92, 0.32),
    ambientSky: 0xcad7e6,
    ambientGround: 0x9c7a52,
    ambientIntensity: 0.85,
    weather: 'dust',
    exposure: 0.95,
    palette: { ground: { sand: 0xd8a868, gravel: 0xb08a63, gravelDeep: 0xa47d55 }, rock: 0xa65a3c, foliage: 0x6d7a3c, foliageDry: 0x9a8a55, trunk: 0x6a5240, snowCover: 0, horizon: 0xb4785a },
  },
  kettlePark: {
    name: 'Circuit park, evening',
    timeOfDay: 18,
    skyTop: 0x5a6f90,
    skyHorizon: 0xd2b9a3,
    fogColor: 0xbab0a5,
    fogNear: 140,
    fogFar: 1000,
    sunColor: 0xffc58c,
    sunIntensity: 1.9,
    sunDir: dir(-0.72, 0.3, 0.62),
    ambientSky: 0xaab9cd,
    ambientGround: 0x4f5a3a,
    ambientIntensity: 0.95,
    weather: 'overcast',
    exposure: 1.05,
    palette: { ground: { grass: 0x4d7b33, gravel: 0x9a8566, tarmac: 0x3a3d42 }, rock: 0x7e7a74, foliage: 0x355c2f, foliageDry: 0x6f7340, trunk: 0x5b4330, snowCover: 0, horizon: 0x5d6c55 },
  },
  lakeSkoga: {
    name: 'Frozen lake, winter dusk',
    timeOfDay: 15.5,
    skyTop: 0x33507f,
    skyHorizon: 0xf0b48e,
    fogColor: 0xcab7b2,
    fogNear: 160,
    fogFar: 1300,
    sunColor: 0xffb27c,
    sunIntensity: 1.6,
    sunDir: dir(0.8, 0.13, -0.58),
    ambientSky: 0xb5c3e1,
    ambientGround: 0xd8dde8,
    ambientIntensity: 1.1,
    weather: 'clear',
    exposure: 1,
    palette: { ground: { ice: 0xa9c9dc, snow: 0xe8edf5 }, rock: 0x6e7076, foliage: 0x2b4536, foliageDry: 0x56604f, trunk: 0x45372d, snowCover: 0.7, horizon: 0x6b7894 },
  },
});

/** Fresh copy (the stage owns its environment object). */
export function environmentFor(key: string): WorldEnvironment {
  const e = ENVIRONMENTS[key];
  if (!e) throw new Error(`no environment '${key}'`);
  return { ...e, sunDir: { ...e.sunDir }, palette: { ...e.palette, ground: { ...e.palette.ground } } };
}
