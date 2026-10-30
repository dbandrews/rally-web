// tests/render/origIntegrate.test.ts — the shared pieces of the original view (integration of the render parts):
// the HotSpot regulator (hotspots.ts, FUN_004e1240) used by track / environment / objects, the lightmap palette
// (common.ts lightmapLut, FUN_004e0780) and the projected lightmap (lightmap.ts), the P8 palette override of the
// texture store, child texture scopes, and the procedural environment → original uniforms mapping.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { EnvironmentPreset } from '../../src/core/types';
import { ORIG_DEFAULTS, ORIG_SKY_LAYER as COMMON_SKY_LAYER, createOrigUniforms, lightmapLut, resetOrigUniforms } from '../../src/render/orig/common';
import { ORIG_SKY_LAYER, PROC_AMBIENT_SCALE, PROC_SUN_REF, applyProceduralAtmosphere } from '../../src/render/orig/environment';
import { hotspotTrackViewDistance, type OrigEnvironmentData } from '../../src/render/orig/environmentData';
import { hotspotWeight, maxHotspotValue, regulateHotspot } from '../../src/render/orig/hotspots';
import { LightmapPatches, fitLightmapProjection, projectLightmapUv, sampleIndex, type LightmapPatch } from '../../src/render/orig/lightmap';
import { HOTSPOT_KEYS, hotspotSettings, type HotSpot, type ObjectsSettings } from '../../src/render/orig/objectsData';
import { RTEX_FORMAT, rtexLevelRGBA, type RtexImage } from '../../src/render/orig/rtex';
import { TextureStore } from '../../src/render/orig/textures';
import { trackViewDistance, type TrackSettingsJson } from '../../src/render/orig/trackData';
import { BUILT_ASSETS_DIR, builtAssetsPresent } from '../assets/builtAssetFetch';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: string): string;
  readdirSync(p: string): string[];
}
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;

// ------------------------------------------------------------------------------------------- HotSpot regulator

/** FUN_004e1240 transcribed literally (decomp @0x4e1240, float32 aside): the reference the shared code must match. */
function regulatorReference(global: number, spots: { sd: number; w: number; fade: number; v: number }[], s: number): number {
  let neg = 0;
  let pos = 0;
  for (const h of spots) {
    const f1 = Math.abs(s - h.sd);
    if (!(f1 <= h.w)) continue;
    const f3 = (1 - h.fade) * h.w;
    let f2 = 0;
    if (f3 < f1) f2 = (f1 - f3) / (h.fade * h.w);
    if (h.v !== 0) {
      const d = (1 - f2) * (h.v - global);
      if (d <= 0) neg = d <= neg ? d : neg;
      else pos = pos < d ? d : pos;
    }
  }
  return neg + pos + global;
}

describe('HotSpot regulator (hotspots.ts = FUN_004e1240)', () => {
  const spots = [
    { name: 'a', splineDistance: 1000, width: 200, fade: 0.5, v: 600 },
    { name: 'b', splineDistance: 1100, width: 100, fade: 0.25, v: 1500 },
    { name: 'c', splineDistance: 1150, width: 50, fade: 0, v: 800 },
    { name: 'off', splineDistance: 1050, width: 300, fade: 0.5, v: 0 },
  ];
  const ref = spots.map((h) => ({ sd: h.splineDistance, w: h.width, fade: h.fade, v: h.v }));

  it('weight: 1 in the core, linear to 0 at the half width, −1 outside (inclusive edge)', () => {
    expect(hotspotWeight({ splineDistance: 1000, width: 200, fade: 0.5 }, 1000)).toBe(1);
    expect(hotspotWeight({ splineDistance: 1000, width: 200, fade: 0.5 }, 1100)).toBe(1);
    expect(hotspotWeight({ splineDistance: 1000, width: 200, fade: 0.5 }, 1150)).toBeCloseTo(0.5, 12);
    expect(hotspotWeight({ splineDistance: 1000, width: 200, fade: 0.5 }, 800)).toBeCloseTo(0, 12);
    expect(hotspotWeight({ splineDistance: 1000, width: 200, fade: 0.5 }, 1200.001)).toBe(-1);
    expect(hotspotWeight({ splineDistance: 1000, width: 200, fade: 0 }, 1200)).toBe(1); // no fade: hard edge
    expect(hotspotWeight({ width: 200, fade: 0.5 }, 0)).toBe(-1); // no window (the Global spot)
  });

  it('Global + the most negative + the most positive delta, matching the decompiled loop', () => {
    for (let s = 700; s <= 1400; s += 3.7) {
      const want = regulatorReference(1000, ref, s);
      expect(regulateHotspot(1000, spots, s, (h) => h.v)).toBeCloseTo(want, 9);
    }
    // inside a and b's cores: 1000 + (600 − 1000) + (1500 − 1000), not a sequential blend
    expect(regulateHotspot(1000, spots, 1060, (h) => h.v)).toBeCloseTo(1100, 9);
    expect(regulateHotspot(1000, spots, Number.NaN, (h) => h.v)).toBe(1000);
    expect(maxHotspotValue(1000, spots, (h) => h.v)).toBe(1500);
  });

  it('track, environment and objects all regulate through it', () => {
    const st: TrackSettingsJson = {
      viewDistance: 900,
      hotspots: {
        enabled: true,
        global: { name: 'Global', trackViewDistance: 1000 },
        spots: spots.map((h) => ({ name: h.name, splineDistance: h.splineDistance, width: h.width, fade: h.fade, trackViewDistance: h.v })),
      },
      bumpEnable: false,
      bumpHeight: 1,
      specularColor: [1, 1, 1],
      drawWorld: true,
      passes: { worldNear: 10, worldFar: 100010, trackNear: 0.1 },
    };
    const view: Pick<OrigEnvironmentData['view'], 'trackViewDistance' | 'hotspotsEnabled' | 'hotspots'> = {
      trackViewDistance: 900,
      hotspotsEnabled: true,
      hotspots: [{ name: 'Global', trackViewDistance: 1000 }, ...spots.map((h) => ({ name: h.name, splineDistance: h.splineDistance, width: h.width, fade: h.fade, trackViewDistance: h.v }))],
    };
    const base = { viewDistance: 1000 } as ObjectsSettings;
    for (const k of HOTSPOT_KEYS) (base as unknown as Record<string, number>)[k] = 1000;
    const objSpots: HotSpot[] = [{ name: 'Global' }, ...spots.map((h) => ({ name: h.name, splineDistance: h.splineDistance, width: h.width, fade: h.fade, viewDistance: h.v }))];
    for (let s = 700; s <= 1400; s += 11.3) {
      const want = regulatorReference(1000, ref, s);
      expect(trackViewDistance(st, s)).toBeCloseTo(want, 9);
      expect(hotspotTrackViewDistance(view, s)).toBeCloseTo(want, 9);
      expect(hotspotSettings(base, objSpots, s).viewDistance).toBeCloseTo(want, 9);
      // a field no spot sets stays Global
      expect(hotspotSettings(base, objSpots, s).cullConst).toBe(1000);
    }
  });

  it.skipIf(!builtAssetsPresent)('real stages: the three parts agree with each other at every spline distance', () => {
    for (const id of fs.readdirSync(`${BUILT_ASSETS_DIR}/stages`)) {
      const tj = `${BUILT_ASSETS_DIR}/stages/${id}/track.json`;
      const ej = `${BUILT_ASSETS_DIR}/stages/${id}/environment.json`;
      if (!fs.existsSync(tj) || !fs.existsSync(ej)) continue;
      const t = JSON.parse(fs.readFileSync(tj, 'utf8')) as { settings: TrackSettingsJson };
      const e = JSON.parse(fs.readFileSync(ej, 'utf8')) as OrigEnvironmentData;
      if (!t.settings.hotspots.enabled || !e.view.hotspotsEnabled) continue;
      for (let s = 0; s < 8000; s += 25) expect(trackViewDistance(t.settings, s)).toBeCloseTo(hotspotTrackViewDistance(e.view, s), 6);
    }
  });
});

// ------------------------------------------------------------------------------------------- lightmap palette

describe('lightmap palette (common.ts lightmapLut = FUN_004e0780)', () => {
  it('min below clamp.x, max above clamp.y, linear between, ⌊v·255⌋, alpha 255', () => {
    const lut = lightmapLut([0.2, 0.2, 0.2], [1, 1, 1], [0, 0.5]);
    expect(lut.length).toBe(1024);
    expect([...lut.subarray(0, 4)]).toEqual([51, 51, 51, 255]);
    expect(lut[4 * 127]).toBe(255); // c1 = ⌊0.5·255⌋ = 127
    expect(lut[4 * 255]).toBe(255);
    expect(lut[4 * 64]).toBe(Math.floor((0.2 + 0.8 * (64 / 127)) * 255));
    const lut2 = lightmapLut([0.3, 0.3, 0.3], [0.9, 0.9, 0.9], [0.3, 0.6]);
    expect(lut2[4 * 10]).toBe(Math.floor(0.3 * 255));
    expect(lut2[4 * 200]).toBe(Math.floor(0.9 * 255));
  });

  it.skipIf(!builtAssetsPresent)('equals the particle LUT the effects part built for every stage', () => {
    let n = 0;
    for (const id of fs.readdirSync(`${BUILT_ASSETS_DIR}/stages`)) {
      const p = `${BUILT_ASSETS_DIR}/stages/${id}/effects.json`;
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { lut?: number[][]; settings: Record<string, number[]> };
      if (!j.lut) continue;
      const s = j.settings;
      const lut = lightmapLut(s.particleLightmapMin, s.particleLightmapMax, s.particleLightmapClamp);
      for (let i = 0; i < 256; i++) expect([lut[4 * i], lut[4 * i + 1], lut[4 * i + 2]]).toEqual(j.lut[i]);
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------------------- projected lightmap

describe('projected lightmap (lightmap.ts)', () => {
  it('fits u = a·x + b, v = c·z + d exactly on an axis-aligned patch', () => {
    // stride 6: x y z u v pad ; patch over x 100..164, z −50..14 → u = (x − 100)/64, v = (z + 50)/64
    const v = new Float32Array(6 * 9);
    let k = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const x = 100 + 32 * i, z = -50 + 32 * j;
      v.set([x, 7 + i - j, z, (x - 100) / 64, (z + 50) / 64, 0], 6 * k++);
    }
    const f = fitLightmapProjection(v, 6, 0, 3, 0, 9)!;
    expect(f.residual).toBeLessThan(1e-6);
    expect(f.proj[0]).toBeCloseTo(1 / 64, 9);
    expect(f.proj[1]).toBeCloseTo(-100 / 64, 6);
    expect(f.proj[2]).toBeCloseTo(1 / 64, 9);
    expect(f.proj[3]).toBeCloseTo(50 / 64, 6);
    expect(projectLightmapUv(f.proj, 132, -18)).toEqual([expect.closeTo(0.5, 6), expect.closeTo(0.5, 6)]);
    expect(projectLightmapUv(f.proj, 0, 1e4)).toEqual([0, 1]); // CLAMP
    expect(fitLightmapProjection(v, 6, 0, 3, 0, 1)).toBeNull();
  });

  it('finds the patch under a point, the height range picking between stacked patches', () => {
    const p = (x0: number, z0: number, y0: number, y1: number, id: string): LightmapPatch => ({ x0, x1: x0 + 64, z0, z1: z0 + 64, y0, y1, proj: [1, 0, 1, 0], lightmap: id });
    const lp = new LightmapPatches([p(0, 0, 0, 5, 'a'), p(64, 0, 0, 5, 'b'), p(64, 0, 20, 25, 'bridge')]);
    expect(lp.find(10, 2, 10)).toBe(0);
    expect(lp.find(70, 2, 10)).toBe(1);
    expect(lp.find(70, 22, 10)).toBe(2);
    expect(lp.find(70, 22, 10, 1)).toBe(2); // a wrong hint is not kept
    expect(lp.find(70, 12, 10)).toBe(1); // between: the nearest height range
    expect(lp.find(-5, 0, 10)).toBe(-1);
  });

  it('samples the nearest texel of an index plane (row 0 = top)', () => {
    const d = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]); // 4 × 2
    expect(sampleIndex(d, 4, 2, 0, 0)).toBe(0);
    expect(sampleIndex(d, 4, 2, 0.99, 0.99)).toBe(7);
    expect(sampleIndex(d, 4, 2, 0.5, 0)).toBe(2);
    expect(sampleIndex(d, 4, 2, 1, 1)).toBe(7);
  });
});

// ------------------------------------------------------------------------------------------- textures

describe('texture store: P8 palette override and child scopes', () => {
  const img: RtexImage = {
    format: RTEX_FORMAT.P8,
    flags: 0,
    width: 2,
    height: 1,
    depth: 1,
    levels: [{ width: 2, height: 1, depth: 1, data: new Uint8Array([0, 255]) }],
    palette: new Uint8Array(1024).fill(9),
    source: 10,
    sourceKind: 0,
  } as unknown as RtexImage;

  it('rtexLevelRGBA expands P8 through the given palette instead of the file palette', () => {
    expect([...rtexLevelRGBA(img, 0)]).toEqual([9, 9, 9, 9, 9, 9, 9, 9]);
    const lut = lightmapLut([0.2, 0.2, 0.2], [1, 1, 1], [0, 0.5]);
    expect([...rtexLevelRGBA(img, 0, lut)]).toEqual([51, 51, 51, 255, 255, 255, 255, 255]);
  });

  it('a palette is part of the cache key; a child scope is released with its parent', async () => {
    const loads: string[] = [];
    const store = new TextureStore({ extensions: { has: () => false } } as unknown as THREE.WebGLRenderer, {
      s3tc: false,
      load: async (id) => {
        loads.push(id);
        throw new Error('no data in this test');
      },
    });
    const parent = store.scope();
    const child = parent.scope();
    const a = child.get('x', { palette: { key: 'p1', rgba: new Uint8Array(1024) } }).catch(() => null);
    const b = parent.get('x').catch(() => null);
    await Promise.all([a, b]);
    expect(loads).toEqual(['x']); // one file, two textures (keys differ by the palette)
    parent.dispose();
    await expect(child.get('y')).rejects.toThrow(/disposed/);
    await expect(parent.scope().get('z')).rejects.toThrow(/disposed/);
    store.dispose();
  });
});

// ------------------------------------------------------------------------------------------- uniforms

describe('shared original uniforms', () => {
  it('the sky layer lives in common.ts (environment re-exports it)', () => {
    expect(ORIG_SKY_LAYER).toBe(COMMON_SKY_LAYER);
  });

  it('reset restores the car / particle lightmap defaults', () => {
    const u = createOrigUniforms();
    u.carLightmapMin.value.set(0.5, 0.5, 0.5);
    u.carLightmapClamp.value.set(0.3, 0.6);
    u.particleLightmapMin.value.set(0.6, 0.5, 0.4);
    resetOrigUniforms(u);
    expect(u.carLightmapMin.value.toArray()).toEqual([...ORIG_DEFAULTS.lightmapMin]);
    expect(u.carLightmapClamp.value.toArray()).toEqual([...ORIG_DEFAULTS.lightmapClamp]);
    expect(u.particleLightmapMin.value.toArray()).toEqual([...ORIG_DEFAULTS.lightmapMin]);
  });

  it('a procedural preset maps onto the car light, ambient, sun and track fog', () => {
    const env = {
      name: 't',
      timeOfDay: 12,
      skyTop: 0,
      skyHorizon: 0,
      fogColor: 0xc9dcef,
      fogNear: 200,
      fogFar: 1600,
      sunColor: 0xffffff,
      sunIntensity: 2.4,
      sunDir: { x: 0, y: 2, z: 0 },
      ambientSky: 0x808080,
      ambientGround: 0,
      ambientIntensity: 1,
      weather: 'clear',
      exposure: 1,
    } as EnvironmentPreset;
    const u = createOrigUniforms();
    applyProceduralAtmosphere(env, u);
    expect(u.sunDir.value.toArray()).toEqual([0, 1, 0]);
    expect(u.carLight.value.x).toBeCloseTo(2.4 / PROC_SUN_REF, 9);
    expect(u.carAmbient.value.x).toBeCloseTo((128 / 255) * PROC_AMBIENT_SCALE, 9);
    expect(u.trackFog.enabled.value).toBe(1);
    expect(u.trackFog.color.value.x).toBeCloseTo(0xc9 / 255, 9);
    expect(u.trackFog.start.value).toBe(200);
    expect(u.trackFog.end.value).toBe(1600);
    expect(u.trackFog.clamp.value).toBe(ORIG_DEFAULTS.fogClamp);
  });
});
