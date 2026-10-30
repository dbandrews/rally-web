// tests/render/origEnvironment.test.ts — the environment part (tools/assets/parts/environment.py +
// src/render/orig/environment*.ts).
//
// Pure maths always (gamma ramp V3, HotSpot view distance, flare layout / corners / on-screen rule, sky box and
// cloud geometry, weather point size + particle wrap, the procedural-content material hook). Real data when the
// packs are built (`npm run assets -- --parts environment`): every stage's json against an INDEPENDENT read of the
// verified dump (.cache/dumps/environment_dump.json, research/tools/fmt_environment.py) with the FUN_0040e650
// defaults for every unset field, the uniforms the loader writes, and loadEnvironment building real stages (sky
// box on the sky layer, clouds with the D3D blend factors, flare elements, snow / rain particle batches).
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { ORIG_DEFAULTS, createOrigUniforms, origUniforms, type OrigLoadContext } from '../../src/render/orig/common';
import { ORIG_SKY_LAYER, OrigEnvironment, findOrigEnvironment, loadEnvironment, origPassOptions } from '../../src/render/orig/environment';
import {
  CLOUD_HALF_SIZE,
  CLOUD_QUAD,
  FLARE_C9,
  FLARE_SIZE_UNIT,
  WeatherSim,
  applyEnvironmentUniforms,
  flareCentreWeight,
  flareCorners,
  flareOnScreen,
  gammaRampExponents,
  gammaRampValue,
  hotspotTrackViewDistance,
  layoutFlare,
  maxHotspotTrackViewDistance,
  skyBoxQuads,
  skyRotationY,
  validateEnvironmentData,
  weatherPointParams,
  weatherPointSize,
  type FlareQuad,
  type OrigEnvironmentData,
  type OrigWeatherData,
} from '../../src/render/orig/environmentData';
import { origBuiltinHookInstalled, origBuiltinMode, setOrigBuiltinMode } from '../../src/render/orig/environmentFog';
import { TextureStore } from '../../src/render/orig/textures';
import { WORLD_RENDER_ORDER } from '../../src/render/orig/track';
import { BUILT_ASSETS_DIR, builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc?: string): string | Uint8Array;
}
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8') as string) as T;

const DUMP = '.cache/dumps/environment_dump.json';
const manifest = builtAssetsPresent ? readJson<{ stages: Record<string, string[]> }>(`${BUILT_ASSETS_DIR}/manifest.json`) : null;
const envStages = manifest ? Object.keys(manifest.stages).filter((id) => manifest.stages[id].includes('environment')) : [];
const envBuilt = envStages.length > 0;

const close = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);

// ------------------------------------------------------------------------------------------- pure maths

describe('gamma ramp (environment.md V3)', () => {
  it('defaults (gfxGamma 0.5, delta 0, enabled) are R^0.9 G^0.95 B^1.0', () => {
    const e = gammaRampExponents();
    expect(e[0]).toBeCloseTo(0.9, 12);
    expect(e[1]).toBeCloseTo(0.95, 12);
    expect(e[2]).toBeCloseTo(1.0, 12);
    // 0.5 → 0.536 / 0.518 / 0.5 (V3 "slight warm lift of mid-tones")
    expect(gammaRampValue(128, e[0])).toBeCloseTo(Math.pow(0.5, 0.9), 12);
    expect(gammaRampValue(128, e[2])).toBe(0.5);
    expect(gammaRampValue(0, e[0])).toBe(0);
  });
  it('the disabled ramp is the identity exponent; script deltas lower the exponents; y is floored at 0.01', () => {
    expect(gammaRampExponents(0.5, 0.2, false)).toEqual([1, 1, 1]);
    const e = gammaRampExponents(0.5, 0.2, true);
    // x = 0.7, y = 0.3, e = 2·0.09 + 0.5 = 0.68
    expect(e[2]).toBeCloseTo(0.68, 12);
    expect(e[0]).toBeCloseTo(0.58, 12);
    expect(gammaRampExponents(1.5, 0, false)[2]).toBeCloseTo(2 * 0.01 * 0.01 + 0.5, 12);
  });
});

describe('HotSpot view distance (FUN_004e1240 / FUN_0049c770)', () => {
  const view = {
    trackViewDistance: 1000,
    hotspotsEnabled: true,
    hotspots: [
      { name: 'Global', trackViewDistance: 1050 },
      { name: 'a', splineDistance: 1000, width: 100, fade: 0.5, trackViewDistance: 600 },
      { name: 'b', splineDistance: 1020, width: 100, fade: 0.5, trackViewDistance: 1200 },
      { name: 'c', splineDistance: 3000, width: 50, fade: 0.2, objectViewDistance: 800 },
    ],
  };
  it('Global outside every spot, full delta inside, linear in the fade band, most negative + most positive', () => {
    expect(hotspotTrackViewDistance(view, 5000)).toBe(1050);
    expect(hotspotTrackViewDistance({ ...view, hotspotsEnabled: false }, 1000)).toBe(1000);
    // s = 1000: a full (−450), b at d = 20 inside (1 − 0.5)·100 → full (+150)
    expect(hotspotTrackViewDistance(view, 1000)).toBeCloseTo(1050 - 450 + 150, 9);
    // s = 925: a at d = 75 → t = (75 − 50)/50 = 0.5 → −225; b at d = 95 → t = 0.9 → +15
    expect(hotspotTrackViewDistance(view, 925)).toBeCloseTo(1050 - 225 + 15, 9);
    // a spot without trackViewDistance leaves it alone
    expect(hotspotTrackViewDistance(view, 3000)).toBe(1050);
    expect(maxHotspotTrackViewDistance(view)).toBe(1200);
  });
});

describe('lens flare (FUN_0078ca00 / FUN_0078d510 / FlareShader.vs)', () => {
  const sun = {
    lensFlareCount: 2,
    elements: [
      { kind: 'flare' as const, tex: 'a', size: [10, 10] as [number, number], size2: [2, 2] as [number, number], rot: 0, color: [255, 255, 255, 100] as [number, number, number, number], color2: [255, 255, 255, 0] as [number, number, number, number] },
      { kind: 'flare' as const, tex: 'a', size: [4, 4] as [number, number], size2: [4, 4] as [number, number], rot: 0.5, color: [10, 20, 30, 40] as [number, number, number, number], color2: [10, 20, 30, 40] as [number, number, number, number] },
      { kind: 'corona' as const, tex: 'b', size: [3, 3] as [number, number], size2: [3, 3] as [number, number], rot: 0, color: [255, 255, 255, 200] as [number, number, number, number], color2: [255, 255, 255, 200] as [number, number, number, number] },
      { kind: 'corona' as const, tex: 'c', size: [1, 1] as [number, number], size2: [1, 1] as [number, number], rot: 0, color: [255, 255, 255, 255] as [number, number, number, number], color2: [255, 255, 255, 255] as [number, number, number, number] },
    ],
  };
  it('centre weight is a tent (1 at the centre, 0 at the edges)', () => {
    expect(flareCentreWeight(320, 240, 320, 240)).toBe(1);
    expect(flareCentreWeight(0, 240, 320, 240)).toBe(0);
    expect(flareCentreWeight(480, 240, 320, 240)).toBeCloseTo(0.5, 12);
    expect(flareCentreWeight(-10, 240, 320, 240)).toBe(0);
  });
  it('flares lie on the line from the mirrored point to the sun, coronas on the sun; the last one at clip z = 1', () => {
    const out: FlareQuad[] = [];
    layoutFlare(sun, { sx: 480, sy: 120, width: 640, height: 480 }, 0.8, 1, out);
    // m = (160, 360); flare 0 at m, flare 1 at m + (s − m)/2 = (320, 240) = the centre
    expect(out[0].x).toBeCloseTo((2 * 160) / 640 - 1, 12);
    expect(out[0].y).toBeCloseTo(1 - (2 * 360) / 480, 12);
    expect(out[1].x).toBeCloseTo(0, 12);
    expect(out[1].y).toBeCloseTo(0, 12);
    // flare 1 is at the screen centre: weight 1 → size / colour, alpha × facing
    expect(out[1].w).toBe(4 * FLARE_SIZE_UNIT);
    expect(out[0].color[3]).toBeCloseTo(0.8 * (0.5 * 100), 9); // m = (160, 360): weight 0.5 in both axes
    expect(out[2].x).toBeCloseTo(0.5, 12);
    expect(out[2].z).toBeCloseTo(0.05, 12);
    expect(out[3].z).toBe(1);
    // rotation (x + W)/2W · rot · 2π
    expect(out[1].angle).toBeCloseTo(((320 + 640) / 1280) * 0.5 * 2 * Math.PI, 12);
    // the second-to-last element hides below visibility 0.3
    layoutFlare(sun, { sx: 480, sy: 120, width: 640, height: 480 }, 0.8, 0.2, out);
    expect(out[2].visible).toBe(false);
  });
  it('corners follow the shader (c9 scale, rotation, +y screen-down) and the on-screen rule uses the 8×8 block', () => {
    const q: FlareQuad = { x: 0.1, y: -0.2, z: 0.05, w: 30, h: 30, angle: 0, color: [0, 0, 0, 0], visible: true };
    const p = new Float32Array(12);
    flareCorners(q, 1, p);
    // TL: wh = (−w, −h) → x = 0.1 − 30/300, y = −0.2 + 0.0043333·30 (c9.y < 0 flips)
    expect(p[0]).toBeCloseTo(0.1 - 30 * FLARE_C9.x, 6);
    expect(p[1]).toBeCloseTo(-0.2 - 30 * FLARE_C9.y, 6);
    expect(p[2]).toBeCloseTo(0.05, 6);
    // BR
    expect(p[6]).toBeCloseTo(0.1 + 30 * FLARE_C9.x, 6);
    expect(p[7]).toBeCloseTo(-0.2 + 30 * FLARE_C9.y, 6);
    // a quarter turn maps (−w, −h) to (−w, +h) in WIDTH_HEIGHT space: r9 = (wx·c + wy·s, wy·c − wx·s)
    flareCorners({ ...q, angle: Math.PI / 2 }, 1, p);
    expect(p[0]).toBeCloseTo(0.1 - 30 * FLARE_C9.x, 6);
    expect(p[1]).toBeCloseTo(-0.2 + 30 * FLARE_C9.y, 6);
    expect(flareOnScreen(320, 240, 640, 480, 0.5)).toBe(true);
    expect(flareOnScreen(320, 240, 640, 480, -0.01)).toBe(false);
    expect(flareOnScreen(-3, 240, 640, 480, 1)).toBe(true); // block [−7, 1) still overlaps column 0
    expect(flareOnScreen(-4, 240, 640, 480, 1)).toBe(false);
    expect(flareOnScreen(643, 240, 640, 480, 1)).toBe(true);
    expect(flareOnScreen(644, 240, 640, 480, 1)).toBe(false);
  });
});

describe('sky box and clouds (FUN_00547ee0 / FUN_00549130)', () => {
  it('FRT faces +z SIM (−z three), TOP is up, UVs are the D3D strip v0 (0,1) v1 (1,1) v2 (0,0) v3 (1,0)', () => {
    const q = skyBoxQuads(3000);
    const centre = (i: number) => q[i].pos.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]);
    expect(centre(0)).toEqual([0, 3000, 0]); // TOP
    expect(centre(1)).toEqual([-3000, 0, 0]); // LFT
    expect(centre(2)).toEqual([3000, 0, 0]); // RGT
    expect(centre(3)).toEqual([0, 0, -3000]); // FRT (SIM +z)
    expect(centre(4)).toEqual([0, 0, 3000]); // BAK
    expect(q[3].uv).toEqual([[0, 1], [1, 1], [0, 0], [1, 0]]);
    // FRT: v = 0 (texture top row) at the top, u from −x to +x
    expect(q[3].pos[2][1]).toBe(3000);
    expect(q[3].pos[0][0]).toBe(-3000);
    // a positive Sky.setRotAngle turns FRT from SIM +z toward +x: three θ = −a, FRT centre → (sin a, 0, −cos a)
    const v = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), skyRotationY(90));
    expect(v.x).toBeCloseTo(1, 12);
  });
  it('the cloud plane is ±2048 · 20 m with the base UVs (1,−1)…(0,0)', () => {
    expect(CLOUD_HALF_SIZE).toBe(40960);
    expect(CLOUD_QUAD.uv).toEqual([[1, -1], [1, 0], [0, -1], [0, 0]]);
  });
});

describe('weather (FUN_0054a830 / FUN_0054b1c0)', () => {
  const w: OrigWeatherData = {
    type: 0, radius: 20, partSize: [0.1, 1], speed: [0, -4, 0], random: 1, numParticles: 500, pointSpriteMinSize: 3, pointSpriteMaxSize: 10,
    displacement: [0, 2, 15], color: [0.3, 0.3, 0.3, 1], scale: [1, 0.55, 0.8], textures: ['a'], unused: { fadeZ: 20, fadeInValue: 1e8, acceleration: 2 },
  };
  it('point size = Vh·Si·sqrt(1/(1 + De)) clamped to width/640 · [min, max]; Si = partSize.x/4 (snow), /2 (rain)', () => {
    const p = weatherPointParams(w, 1280);
    expect(p.si).toBeCloseTo(0.025, 12);
    expect(p.minPx).toBeCloseTo(6, 12);
    expect(p.maxPx).toBeCloseTo(20, 12);
    expect(weatherPointSize(720, p.si, 3, p.minPx, p.maxPx)).toBeCloseTo(720 * 0.025 * 0.5, 12);
    expect(weatherPointSize(720, p.si, 1000, p.minPx, p.maxPx)).toBe(6);
    expect(weatherPointParams({ ...w, type: 1, partSize: [0.6, 0.6] }, 640).si).toBeCloseTo(0.3, 12);
  });
  it('spawns inside the scaled ellipsoid, falls with speed + jitter, wraps to −p_old when it leaves', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const sim = new WeatherSim(w, 500, rand);
    const inside = (i: number) => {
      const x = sim.pos[i * 3] * w.scale[0], y = sim.pos[i * 3 + 1] * w.scale[1], z = sim.pos[i * 3 + 2] * w.scale[2];
      return x * x + y * y + z * z <= w.radius * w.radius + 1e-6;
    };
    for (let i = 0; i < sim.n; i++) expect(inside(i)).toBe(true);
    const y0 = Array.from({ length: sim.n }, (_, i) => sim.pos[i * 3 + 1]);
    sim.update(0.1, { x: 0, y: 0, z: 0 });
    sim.update(0.1, { x: 0, y: 0, z: 0 });
    let fell = 0;
    for (let i = 0; i < sim.n; i++) if (sim.pos[i * 3 + 1] < y0[i]) fell++;
    expect(fell).toBeGreaterThan(sim.n * 0.8);
    // a camera jump moves every particle by −Δsys (or wraps it to the far side)
    for (let k = 0; k < 50; k++) sim.update(0.05, { x: k * 3, y: 0, z: 0 });
    for (let i = 0; i < sim.n; i++) expect(inside(i)).toBe(true);
  });
});

describe('procedural content inside an original view (environmentFog.ts, ASSETS.md §10 gap 4)', () => {
  const compile = (m: THREE.Material, fragment: string) => {
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: 'void main() {}', fragmentShader: fragment };
    m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    return shader;
  };
  const FRAG = 'void main() {\n#include <colorspace_fragment>\n#include <fog_fragment>\n}';
  it('is installed at import; built-ins get the original track fog by identity and the sRGB encode', () => {
    expect(origBuiltinHookInstalled()).toBe(true);
    const s = compile(new THREE.MeshLambertMaterial(), FRAG);
    expect(s.uniforms.uOrigBiMode).toBe(origBuiltinMode);
    expect(s.uniforms.uOrigBiFogColor).toBe(origUniforms.trackFog.color);
    expect(s.uniforms.uOrigBiFogClamp).toBe(origUniforms.trackFog.clamp);
    expect(s.uniforms.uOrigBiEncode.value).toBe(1);
    expect(s.fragmentShader).toContain(THREE.ShaderChunk.fog_fragment); // procedural stages: three's fog, unchanged
    expect(s.fragmentShader).toContain('(uOrigBiFogEnd - uOrigBiFogClamp)');
    expect(s.fragmentShader).not.toContain('#include <fog_fragment>');
    setOrigBuiltinMode(true);
    expect(origBuiltinMode.value).toBe(1);
    setOrigBuiltinMode(false);
    expect(origBuiltinMode.value).toBe(0);
  });
  it('raw original textures, ShaderMaterials and RawShaderMaterials are not encoded / not touched', () => {
    const map = new THREE.Texture();
    map.colorSpace = THREE.NoColorSpace;
    expect(compile(new THREE.SpriteMaterial({ map }), FRAG).uniforms.uOrigBiEncode.value).toBe(0);
    const sm = new THREE.ShaderMaterial({ uniforms: { a: { value: 1 } } });
    const s = compile(sm, FRAG);
    expect(s.uniforms.uOrigBiEncode.value).toBe(0);
    expect(s.fragmentShader).not.toContain('gl_FragColor.rgb = origBiOETF('); // no encode added
    const raw = compile(new THREE.RawShaderMaterial(), FRAG);
    expect(raw.fragmentShader).toBe(FRAG);
  });
  it('an instance onBeforeCompile is chained (runs first) and keeps a distinct program cache key', () => {
    const m = new THREE.MeshLambertMaterial();
    const plain = new THREE.MeshLambertMaterial();
    let ran = 0;
    m.onBeforeCompile = (sh) => {
      ran++;
      sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'void main() { /*user*/');
    };
    const s = compile(m, FRAG);
    expect(ran).toBe(1);
    expect(s.fragmentShader).toContain('/*user*/');
    expect(s.uniforms.uOrigBiMode).toBe(origBuiltinMode);
    expect(m.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey());
    // assigning the wrapper to another material does not chain the hook twice
    const other = new THREE.MeshLambertMaterial();
    other.onBeforeCompile = m.onBeforeCompile;
    const s2 = compile(other, FRAG);
    expect(s2.fragmentShader.match(/uniform float uOrigBiMode;/g)?.length).toBe(1);
    expect(s2.fragmentShader).toContain('/*user*/');
  });
});

// ------------------------------------------------------------------------------------------- real data

interface DumpStage {
  id: string;
  env: {
    fogEffective: { track: { enable: boolean | null; color: number[] | null; start: number | null; end: number | null; clampDistance: number | null }; world: { enable: boolean | null; color: number[] | null; start: number | null; end: number | null } };
    game: { lightColor: number[] | null; shadowColor: number[] | null; trackGammaDelta: number | null };
    car: { lightColor: number[] | null; ambient: number[] | null };
    sky: { initialised: boolean; sunLightDirThree: number[] | null; clouds: unknown[]; sunFlareTemplate: string | null; rotAngleDeg: number | null; ofsSkyHeight: number | null };
    objectTemplates: Record<string, { class?: string; lensFlareCount?: number; coronaCount?: number }>;
    weather: { type?: number } | null;
  };
}

const dumpPresent = fs.existsSync(DUMP);
const dump = dumpPresent ? readJson<{ settingsDefaults: { values: Record<string, unknown> }; stages: DumpStage[] }>(DUMP) : null;
const vec3 = (v: number[] | null | undefined, d: readonly number[]): number[] => {
  const a = v ?? [...d];
  return [a[0], a[1] ?? a[a.length - 1], a[2] ?? a[a.length - 1]];
};

describe.skipIf(!envBuilt)('environment part on real data', () => {
  it('builds every ported stage (48) with a valid json and resolvable textures', () => {
    expect(envStages.length).toBe(48);
    for (const id of envStages) {
      const d = validateEnvironmentData(readJson(`${BUILT_ASSETS_DIR}/stages/${id}/environment.json`));
      expect(d.stage).toBe(id);
      for (const t of d.textures) expect(fs.existsSync(`${BUILT_ASSETS_DIR}/tex/${t}.rtex`)).toBe(true);
      expect(d.sky?.faces.every((f) => typeof f === 'string')).toBe(true);
    }
  });

  it.skipIf(!dumpPresent)('uniform values per stage = the evaluated scripts (dump), FUN_0040e650 defaults when unset', () => {
    const D = dump!.settingsDefaults.values as Record<string, number[] | number | boolean>;
    let checked = 0;
    for (const st of dump!.stages) {
      if (!envStages.includes(st.id)) continue;
      const d = validateEnvironmentData(readJson(`${BUILT_ASSETS_DIR}/stages/${st.id}/environment.json`));
      const u = createOrigUniforms();
      const keep = { tf: u.trackFog.color, wf: u.worldFog.color, sun: u.sunDir, ol: u.objectLight };
      applyEnvironmentUniforms(d, u);
      // identity is kept (every original material holds these objects)
      expect(u.trackFog.color).toBe(keep.tf);
      expect(u.worldFog.color).toBe(keep.wf);
      expect(u.sunDir).toBe(keep.sun);
      expect(u.objectLight).toBe(keep.ol);
      const ft = st.env.fogEffective.track;
      const fw = st.env.fogEffective.world;
      expect(u.trackFog.enabled.value).toBe((ft.enable ?? D['Track.fogEnable']) ? 1 : 0);
      expect(close(u.trackFog.color.value.toArray(), vec3(ft.color, D['Track.fogColor'] as number[]))).toBe(true);
      expect(u.trackFog.start.value).toBe(ft.start ?? (D['Track.fogRange'] as number[])[0]);
      expect(u.trackFog.end.value).toBe(ft.end ?? (D['Track.fogRange'] as number[])[1]);
      expect(u.trackFog.clamp.value).toBe(ft.clampDistance ?? (D['Track.fogClamp'] as number));
      expect(u.worldFog.enabled.value).toBe((fw.enable ?? D['World.fogEnable']) ? 1 : 0);
      expect(close(u.worldFog.color.value.toArray(), vec3(fw.color, D['World.fogColor'] as number[]))).toBe(true);
      expect(u.worldFog.start.value).toBe(fw.start ?? (D['World.fogRange'] as number[])[0]);
      expect(u.worldFog.end.value).toBe(fw.end ?? (D['World.fogRange'] as number[])[1]);
      expect(u.worldFog.clamp.value).toBe(ORIG_DEFAULTS.fogClamp);
      const s = st.env.sky.sunLightDirThree ?? [0, Math.SQRT1_2, -Math.SQRT1_2];
      const n = Math.hypot(s[0], s[1], s[2]);
      expect(close(u.sunDir.value.toArray(), [s[0] / n, s[1] / n, s[2] / n], 1e-9)).toBe(true);
      expect(close(u.objectLight.value.toArray(), vec3(st.env.game.lightColor, D['game.lightColor'] as number[]))).toBe(true);
      expect(close(u.objectShadow.value.toArray(), vec3(st.env.game.shadowColor, D['game.shadowColor'] as number[]))).toBe(true);
      expect(close(u.carLight.value.toArray(), vec3(st.env.car.lightColor, D['car.lightColor'] as number[]))).toBe(true);
      expect(close(u.carAmbient.value.toArray(), vec3(st.env.car.ambient, D['car.ambient'] as number[]))).toBe(true);
      // the rest of the stage's environment
      expect(d.sky!.clouds.length).toBe(st.env.sky.clouds.length);
      expect(d.sky!.rotationDeg).toBe(st.env.sky.rotAngleDeg ?? 0);
      expect(d.sky!.offsetY).toBe(st.env.sky.ofsSkyHeight ?? 0);
      const tmpl = st.env.sky.sunFlareTemplate ? st.env.objectTemplates[st.env.sky.sunFlareTemplate] : undefined;
      if (tmpl && tmpl.class === 'LensFlare') expect(d.sun!.elements.length).toBe((tmpl.lensFlareCount ?? 0) + (tmpl.coronaCount ?? 0));
      else expect(d.sun).toBeNull();
      expect(d.weather?.type ?? null).toBe(st.env.weather ? (st.env.weather.type ?? 0) : null);
      expect(d.gamma.trackGammaDeltaScript).toBe(st.env.game.trackGammaDelta ?? 0);
      checked++;
    }
    expect(checked).toBe(48);
  });

  it('known stages: rallycross-1-r has no World fog (defaults), corsica-1-r no clouds, 7 stages no sun flare', () => {
    const rd = (id: string) => validateEnvironmentData(readJson(`${BUILT_ASSETS_DIR}/stages/${id}/environment.json`));
    const r1r = rd('rallycross-1-r');
    expect(r1r.fog.world).toMatchObject({ enabled: false, color: [1, 1, 1], start: 0, end: 1024, clamp: 1e8 });
    expect(rd('corsica-1-r').sky!.clouds.length).toBe(0);
    // 6 stages never call Sky.setSun; rallycross-2-f binds `sun` but never creates that object (no Lenz*.con)
    expect(envStages.filter((id) => rd(id).sun === null).length).toBe(7);
    expect(rd('rallycross-2-f').sun).toBeNull();
    const weather = envStages.filter((id) => rd(id).weather).sort();
    expect(weather).toEqual(['corsica-2-r', 'corsica-3-f', 'hillclimb-3b-f', 'hillclimb-3c-f', 'iceracing-1-r', 'iceracing-3-f', 'newzealand-1-r', 'newzealand-2-r', 'newzealand-3-f', 'rallycross-2-f']);
    expect(rd('corsica-1-f').view.skyPassFar).toBe(100010);
  });

  it('in-race gamma ramp per stage: the live delta is the RenderSettings.con Game.trackGammaDelta', () => {
    // RenderSettings.con runs inside Game.createTrack (0x428710 → 0x494c00 → 0x4963e7) while the race loader runs
    // the play script, before it reads Game+0x78 at 0x494a6d (environment.md V3 note 2026-10-30). Each stage's
    // script value (RenderSettings.con, last line) and the 0x68dd70 exponents at gfxGamma 0.5, written out:
    const rampAt: Record<string, number[]> = {
      '0': [0.9, 0.95, 1.0],
      '0.05': [0.805, 0.855, 0.905],
      '0.1': [0.72, 0.77, 0.82],
      '0.15': [0.645, 0.695, 0.745],
      '0.2': [0.58, 0.63, 0.68],
    };
    const scriptDelta: Record<string, string[]> = {
      '0': ['corsica-1-f', 'iceracing-3-f'],
      '0.05': ['hillclimb-2b-r', 'hillclimb-2c-r', 'iceracing-1-f', 'iceracing-2-f', 'iceracing-2-r', 'iceracing-3-r', 'kenya-1-f', 'kenya-1-r', 'kenya-2-f'],
      '0.15': ['hillclimb-1b-r', 'newzealand-2-r'],
      '0.2': ['hillclimb-1a-f', 'hillclimb-1a-r', 'hillclimb-3c-r', 'newzealand-1-f', 'newzealand-3-f', 'rallycross-1-f', 'rallycross-1-r', 'rallycross-2-f', 'rallycross-2-r'],
    };
    const deltaOf = (id: string) => Object.keys(scriptDelta).find((k) => scriptDelta[k].includes(id)) ?? '0.1'; // 26 stages at 0.1
    const rd = (id: string) => validateEnvironmentData(readJson(`${BUILT_ASSETS_DIR}/stages/${id}/environment.json`));
    expect(envStages.length).toBe(48);
    const count: Record<string, number> = {};
    for (const id of envStages) {
      const g = rd(id).gamma;
      const k = deltaOf(id);
      count[k] = (count[k] ?? 0) + 1;
      expect(g.trackGammaDeltaScript, id).toBeCloseTo(Number(k), 9);
      expect(g.trackGammaDeltaLive, id).toBe(g.trackGammaDeltaScript);
      expect(g.gfxGammaDefault).toBe(0.5);
      const e = gammaRampExponents(g.gfxGammaDefault, g.trackGammaDeltaLive, true);
      expect(close(e, rampAt[k], 1e-6), `${id}: ${e.join(' ')}`).toBe(true);
    }
    expect(count).toEqual({ '0': 2, '0.05': 9, '0.1': 26, '0.15': 2, '0.2': 9 });
  });
});

describe.skipIf(!envBuilt)('loadEnvironment on real data (JS texture path, no GL)', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => _setAssetFetchForTests(null));

  const load = async (id: string): Promise<{ env: OrigEnvironment; data: OrigEnvironmentData; uniforms: ReturnType<typeof createOrigUniforms> }> => {
    const store = new TextureStore({} as THREE.WebGLRenderer, { s3tc: false });
    const scope = store.scope();
    const uniforms = createOrigUniforms();
    const { fetchArrayBuffer, fetchJson, stagePartPath } = await import('../../src/core/assets');
    const ctx: OrigLoadContext = {
      stage: { id, project: () => ({ s: 400, lateral: 0, heightOffset: 0, point: { x: 0, y: 0, z: 0 } }) } as unknown as OrigLoadContext['stage'],
      stageId: id,
      manifest: { version: 1, stages: {}, cars: [], carParts: {}, global: [], audio: false, textures: 0 } as unknown as OrigLoadContext['manifest'],
      parts: ['environment'],
      renderer: {} as THREE.WebGLRenderer,
      textures: scope,
      uniforms,
      partPath: (part, ext = 'json') => stagePartPath(id, part, ext),
      fetchPartJson: <T>(part: string, ext = 'json') => fetchJson<T>(stagePartPath(id, part, ext)),
      fetchPartBuffer: (part, ext = 'bin') => fetchArrayBuffer(stagePartPath(id, part, ext)),
    };
    const c = await loadEnvironment(ctx);
    expect(c).toBeInstanceOf(OrigEnvironment);
    const data = validateEnvironmentData(readJson(`${BUILT_ASSETS_DIR}/stages/${id}/environment.json`));
    return { env: c as OrigEnvironment, data, uniforms };
  };

  it('corsica-1-f: sky box on the sky layer, clouds with their D3D blends, flare elements, uniforms filled', async () => {
    const { env, data, uniforms } = await load('corsica-1-f');
    expect(env.replacesSky).toBe(true);
    expect(findOrigEnvironment(new THREE.Group().add(env.object3D))).toBe(env);
    const sky = env.object3D.getObjectByName('orig:sky')!;
    expect(sky.children.length).toBe(5);
    for (const m of sky.children) {
      expect(m.layers.isEnabled(ORIG_SKY_LAYER)).toBe(true);
      expect(m.layers.isEnabled(0)).toBe(false);
      const mat = (m as THREE.Mesh).material as THREE.ShaderMaterial;
      expect(mat.side).toBe(THREE.DoubleSide);
      expect(mat.depthTest).toBe(false);
      expect((mat.uniforms.map.value as THREE.Texture).wrapS).toBe(THREE.ClampToEdgeWrapping);
      expect((mat.uniforms.map.value as THREE.Texture).minFilter).toBe(THREE.LinearMipmapNearestFilter);
    }
    const clouds = env.object3D.children.filter((o) => o.name.startsWith('orig:cloud:')) as THREE.Mesh[];
    expect(clouds.length).toBe(data.sky!.clouds.length);
    const cm = clouds[0].material as THREE.ShaderMaterial;
    expect(cm.blendSrc).toBe(THREE.SrcAlphaFactor); // corsica-1-f cloud0: BMSourceAlpha / BMInvSourceAlpha
    expect(cm.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    // sky pass order sky box → clouds → World.qm, all in three's opaque list (renderOrder decides; the blend stays)
    expect(cm.transparent).toBe(false);
    expect(cm.blending).toBe(THREE.CustomBlending);
    clouds.forEach((c, i) => {
      expect(c.renderOrder).toBeGreaterThan(sky.children[0].renderOrder);
      expect(c.renderOrder).toBeLessThan(WORLD_RENDER_ORDER);
      if (i) expect(c.renderOrder).toBeGreaterThan(clouds[i - 1].renderOrder);
    });
    expect(uniforms.trackFog.end.value).toBe(1800);
    expect(uniforms.objectLight.value.toArray()).toEqual([0.4, 0.38, 0.35]);
    // update: the box follows the camera (+ ofsSkyHeight), the clouds sit at camera.y + height and scroll
    const cam = new THREE.PerspectiveCamera(70, 4 / 3, 0.1, 1000);
    cam.position.set(100, 50, -200);
    cam.updateMatrixWorld();
    env.update(cam, 2);
    expect(sky.position.toArray()).toEqual([100, 50 + data.sky!.offsetY, -200]);
    expect(clouds[0].position.y).toBe(50 + data.sky!.clouds[0].height);
    const off = (cm.uniforms.uOffset.value as THREE.Vector2).toArray();
    expect(off[0]).toBeCloseTo((data.sky!.clouds[0].speed[0] * 2) % 1, 9);
    expect(env.viewDistance(cam)).toBe(hotspotTrackViewDistance(data.view, 400));
    env.dispose();
    expect(env.object3D.parent).toBeNull();
  });

  it('hillclimb-1a-f clouds darken (BMZero / BMInvSourceAlpha); hillclimb-3b-f snow and corsica-2-r rain build their batches', async () => {
    const h = await load('hillclimb-1a-f');
    const c = h.env.object3D.children.find((o) => o.name.startsWith('orig:cloud:')) as THREE.Mesh;
    expect((c.material as THREE.ShaderMaterial).blendSrc).toBe(THREE.ZeroFactor);
    h.env.dispose();
    for (const [id, kind] of [['hillclimb-3b-f', 'snow'], ['corsica-2-r', 'rain']] as const) {
      const { env, data } = await load(id);
      const g = env.object3D.getObjectByName(`orig:weather:${kind}`)!;
      expect(g).toBeTruthy();
      const pts = g.children as THREE.Points[];
      expect(pts.length).toBe(data.weather!.textures.length);
      expect(pts.reduce((a, p) => a + p.geometry.drawRange.count, 0)).toBe(data.weather!.numParticles);
      const m = pts[0].material as THREE.ShaderMaterial;
      expect(m.blendSrc).toBe(THREE.SrcAlphaFactor);
      expect(m.blendDst).toBe(THREE.OneFactor);
      expect(m.depthWrite).toBe(false);
      // sprites sampled at mip level 0 (no point-sprite mip selection; see loadEnvironment)
      expect((m.uniforms.map.value as THREE.Texture).minFilter).toBe(THREE.LinearFilter);
      expect(pts[0].layers.isEnabled(0)).toBe(true); // main pass (after the objects), not the sky pass
      env.dispose();
    }
  });

  it('pass options: only meshes outside the environment on the sky layer count as World.qm in the sky pass', async () => {
    const { env } = await load('kenya-1-f');
    const view = new THREE.Group();
    view.add(env.object3D);
    expect(origPassOptions(view, 5207)).toEqual({ worldInSkyPass: false, minMainFar: 5207 });
    const world = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    world.layers.set(ORIG_SKY_LAYER);
    view.add(world);
    expect(origPassOptions(view, 5207).worldInSkyPass).toBe(true);
    env.dispose();
  });

  it('gammaExponents(): the ramp the pipeline blits uses the stage script delta (rallycross-1-f 0.2, corsica-1-f 0)', async () => {
    for (const [id, want] of [['rallycross-1-f', [0.58, 0.63, 0.68]], ['corsica-1-f', [0.9, 0.95, 1.0]]] as const) {
      const { env } = await load(id);
      const e = env.gammaExponents();
      expect(e).not.toBeNull();
      expect(close(e!, want, 1e-9), `${id}: ${e!.join(' ')}`).toBe(true);
      env.dispose();
    }
  });
});
