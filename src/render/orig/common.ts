/**
 * src/render/orig/common.ts — what every original-asset render module shares:
 *
 *   1. `origUniforms`: the SHARED per-stage uniform objects. loadEnvironment (environment.ts) fills them
 *      from the stage's Sky.con / lighting.con / RenderSettings*.con; the track, object and car shaders put
 *      the very same `{ value }` objects into their ShaderMaterial uniforms (by identity — never copy the
 *      values), so one write updates every material. OriginalStageView.load resets them to the original's
 *      settings defaults (FUN_0040e650, environment.md §V2) before the components load.
 *      Colours are raw 0..1 floats in THREE.Vector3 (gamma-space maths like the D3D8 original): never
 *      THREE.Color / setHex / setStyle (colour management would convert them).
 *   2. The original fog in GLSL (ORIG_FOG_PARS): D3D linear per-vertex fog with the engine's clamp term
 *        oFog = clamp(max((end − z)/(end − start), (end − clampDist)/(end − start)), 0, 1)   (1 = no fog)
 *        pixel = mix(fogColor, colour, oFog)                      environment.md §3.4, quadmesh.md §4.3
 *      z = view-space depth (−mvPosition.z). fogEnable 0 → oFog = 1. Track, objects, trees, cars, water and
 *      particles use the TRACK fog; World.qm uses the WORLD fog (clamp 1e8). Bind one or the other with
 *      fogUniformMap(origUniforms.trackFog | .worldFog).
 *   3. The component contract (OrigLoadContext → OrigComponent) used by track.ts / objects.ts /
 *      environment.ts and composed by index.ts (OriginalStageView).
 *   4. disposeTree(): geometry/material disposal with the renderer's sharing rules.
 *
 * Output pipeline while an original view is shown (renderer.ts): toneMapping = NoToneMapping and
 * outputColorSpace = LinearSRGBColorSpace (bytes in = bytes out). Textures are NoColorSpace (textures.ts).
 */
import * as THREE from 'three';
import type { AssetManifest } from '../../core/assets';
import type { Stage } from '../../core/types';
import type { TextureScope } from './textures';

// ------------------------------------------------------------------------------------------- uniforms

export interface OrigUniform<T> {
  value: T;
}

export interface FogUniforms {
  /** 1 = fog on (`fogEnable 1`), 0 = off. */
  enabled: OrigUniform<number>;
  /** Fog colour, raw 0..1 (`fogColor r/g/b`). */
  color: OrigUniform<THREE.Vector3>;
  /** Linear fog range in m of view-space depth (`fogRange start/end`; negative starts are legal). */
  start: OrigUniform<number>;
  end: OrigUniform<number>;
  /** `Track.fogClamp` distance in m: fog never exceeds its value at this depth. 1e8 = no clamp. */
  clamp: OrigUniform<number>;
}

export interface OrigSharedUniforms {
  /** Track / objects / trees / cars / water / particles. */
  readonly trackFog: FogUniforms;
  /** World.qm backdrop terrain (clamp stays 1e8). */
  readonly worldFog: FogUniforms;
  /** Unit vector in THREE space from the ground TOWARD the sun (dump: sky.sunLightDirThree). */
  readonly sunDir: OrigUniform<THREE.Vector3>;
  /** `game.lightColor` / `game.shadowColor` (StandardMesh + tree lighting, before template multipliers). */
  readonly objectLight: OrigUniform<THREE.Vector3>;
  readonly objectShadow: OrigUniform<THREE.Vector3>;
  /** `car.lightColor` (sun diffuse) / `car.ambient`. */
  readonly carLight: OrigUniform<THREE.Vector3>;
  readonly carAmbient: OrigUniform<THREE.Vector3>;
  /** `Car.lightmapMin / Max / Clamp`: the car's palette for the track lightmap under it (lightmapLut, race +0x948). */
  readonly carLightmapMin: OrigUniform<THREE.Vector3>;
  readonly carLightmapMax: OrigUniform<THREE.Vector3>;
  readonly carLightmapClamp: OrigUniform<THREE.Vector2>;
  /** `game.particleLightmapMin` (the particle lighting floor; Max / Clamp are never scripted: PARTICLE_LIGHTMAP_*). */
  readonly particleLightmapMin: OrigUniform<THREE.Vector3>;
  /** Seconds since the stage view loaded (animated water, sway, clouds); advanced by OriginalStageView.update. */
  readonly time: OrigUniform<number>;
}

/** The original's settings defaults (FUN_0040e650; environment.md §V2) for everything a stage leaves unset. */
export const ORIG_DEFAULTS = Object.freeze({
  fogEnable: 0,
  fogColor: [1, 1, 1] as const,
  fogStart: 0,
  fogEnd: 1024,
  fogClamp: 1e8,
  /** Default sun (0, 0.707, 0.707) in SIM space, normalised (FUN_005477a0 + FUN_0049a680) → three z negated. */
  sunDirThree: [0, Math.SQRT1_2, -Math.SQRT1_2] as const,
  lightColor: [0.6, 0.6, 0.6] as const,
  shadowColor: [0.2, 0.2, 0.2] as const,
  carLightColor: [0.5, 0.5, 0.5] as const,
  carAmbient: [0.3, 0.3, 0.3] as const,
  /** Car.lightmapMin / Max / Clamp and game.particleLightmapMin / Max / Clamp (settings +0x130.., +0x1b8..). */
  lightmapMin: [0.2, 0.2, 0.2] as const,
  lightmapMax: [1, 1, 1] as const,
  lightmapClamp: [0, 0.5] as const,
});

/** game.particleLightmapMax / Clamp: no shipped script sets them (only particleLightmapMin), so the defaults. */
export const PARTICLE_LIGHTMAP_MAX = ORIG_DEFAULTS.lightmapMax;
export const PARTICLE_LIGHTMAP_CLAMP = ORIG_DEFAULTS.lightmapClamp;

/**
 * three.js layer of the original's SKY pass (near 10 / far 100010, depth cleared afterwards): the sky box, the
 * clouds and World.qm (`mesh.layers.set(ORIG_SKY_LAYER)`). The pipeline's sky camera enables ONLY this layer (layer 0
 * off): the track's World mesh detects the sky pass by that. Objects on this layer only are invisible to the main
 * camera.
 */
export const ORIG_SKY_LAYER = 1;

function fogUniforms(): FogUniforms {
  return {
    enabled: { value: ORIG_DEFAULTS.fogEnable },
    color: { value: new THREE.Vector3(...ORIG_DEFAULTS.fogColor) },
    start: { value: ORIG_DEFAULTS.fogStart },
    end: { value: ORIG_DEFAULTS.fogEnd },
    clamp: { value: ORIG_DEFAULTS.fogClamp },
  };
}

export function createOrigUniforms(): OrigSharedUniforms {
  return {
    trackFog: fogUniforms(),
    worldFog: fogUniforms(),
    sunDir: { value: new THREE.Vector3(...ORIG_DEFAULTS.sunDirThree) },
    objectLight: { value: new THREE.Vector3(...ORIG_DEFAULTS.lightColor) },
    objectShadow: { value: new THREE.Vector3(...ORIG_DEFAULTS.shadowColor) },
    carLight: { value: new THREE.Vector3(...ORIG_DEFAULTS.carLightColor) },
    carAmbient: { value: new THREE.Vector3(...ORIG_DEFAULTS.carAmbient) },
    carLightmapMin: { value: new THREE.Vector3(...ORIG_DEFAULTS.lightmapMin) },
    carLightmapMax: { value: new THREE.Vector3(...ORIG_DEFAULTS.lightmapMax) },
    carLightmapClamp: { value: new THREE.Vector2(...ORIG_DEFAULTS.lightmapClamp) },
    particleLightmapMin: { value: new THREE.Vector3(...ORIG_DEFAULTS.lightmapMin) },
    time: { value: 0 },
  };
}

/** The app-wide shared instance (one stage is shown at a time). Reference these objects, never copy them. */
export const origUniforms: OrigSharedUniforms = createOrigUniforms();

/** Restore the settings defaults in place (keeps every object identity). */
export function resetOrigUniforms(u: OrigSharedUniforms = origUniforms): void {
  for (const f of [u.trackFog, u.worldFog]) {
    f.enabled.value = ORIG_DEFAULTS.fogEnable;
    f.color.value.set(...ORIG_DEFAULTS.fogColor);
    f.start.value = ORIG_DEFAULTS.fogStart;
    f.end.value = ORIG_DEFAULTS.fogEnd;
    f.clamp.value = ORIG_DEFAULTS.fogClamp;
  }
  u.sunDir.value.set(...ORIG_DEFAULTS.sunDirThree);
  u.objectLight.value.set(...ORIG_DEFAULTS.lightColor);
  u.objectShadow.value.set(...ORIG_DEFAULTS.shadowColor);
  u.carLight.value.set(...ORIG_DEFAULTS.carLightColor);
  u.carAmbient.value.set(...ORIG_DEFAULTS.carAmbient);
  u.carLightmapMin.value.set(...ORIG_DEFAULTS.lightmapMin);
  u.carLightmapMax.value.set(...ORIG_DEFAULTS.lightmapMax);
  u.carLightmapClamp.value.set(...ORIG_DEFAULTS.lightmapClamp);
  u.particleLightmapMin.value.set(...ORIG_DEFAULTS.lightmapMin);
  u.time.value = 0;
}

/**
 * The 256-entry lightmap palette of FUN_004e0780 (built by FUN_0049ac30 for the cars, race +0x948, and for the
 * particles, +0x94c; the car renderer binds its palette before the cars draw, 0x48f8b8): with c0 = ⌊clamp.x·255⌋,
 * c1 = ⌊clamp.y·255⌋, index i → min below c0, max above c1, min + (max − min)·(i − c0)/(c1 − c0) between;
 * bytes ⌊v·255⌋, alpha 255. RGBA8 × 256 (the `.rtex` P8 palette layout).
 */
export function lightmapLut(min: ArrayLike<number>, max: ArrayLike<number>, clamp: ArrayLike<number>): Uint8Array {
  const c0 = Math.trunc(clamp[0] * 255);
  const c1 = Math.trunc(clamp[1] * 255);
  const span = Math.max(1, c1 - c0);
  const out = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    const t = i < c0 ? 0 : i > c1 ? 1 : (i - c0) / span;
    for (let k = 0; k < 3; k++) out[4 * i + k] = Math.min(255, Math.max(0, Math.floor((min[k] + (max[k] - min[k]) * t) * 255)));
    out[4 * i + 3] = 255;
  }
  return out;
}

/** The fog uniforms under the names ORIG_FOG_PARS uses (spread into ShaderMaterial.uniforms). */
export function fogUniformMap(f: FogUniforms): {
  uFogEnabled: OrigUniform<number>;
  uFogColor: OrigUniform<THREE.Vector3>;
  uFogStart: OrigUniform<number>;
  uFogEnd: OrigUniform<number>;
  uFogClamp: OrigUniform<number>;
} {
  return { uFogEnabled: f.enabled, uFogColor: f.color, uFogStart: f.start, uFogEnd: f.end, uFogClamp: f.clamp };
}

// ------------------------------------------------------------------------------------------- GLSL

/**
 * Declarations + the fog factor, for vertex AND fragment shaders (identical text in both is fine):
 *   vertex:   vOrigFog = origFogFactor(-mvPosition.z);           (declare `varying float vOrigFog;`)
 *   fragment: colour.rgb = mix(uFogColor, colour.rgb, vOrigFog);
 * Uniforms: fogUniformMap(origUniforms.trackFog) (or .worldFog for World.qm). Per-vertex like the original
 * (perspective-correct interpolation of oFog); evaluate per pixel instead if you prefer (identical except
 * where the clamp kicks in inside one triangle).
 */
export const ORIG_FOG_PARS = /* glsl */ `
uniform float uFogEnabled;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
uniform float uFogClamp;
float origFogFactor(float viewZ) {
  if (uFogEnabled < 0.5) return 1.0;
  float span = uFogEnd - uFogStart;
  if (abs(span) < 1e-6) span = 1e-6;
  float f = (uFogEnd - viewZ) / span;
  float fc = (uFogEnd - uFogClamp) / span;
  return clamp(max(f, fc), 0.0, 1.0);
}
`;

/** CPU mirror of origFogFactor (tests, tools, CPU-side culling). */
export function origFogFactor(viewZ: number, f: { enabled: number; start: number; end: number; clamp: number }): number {
  if (f.enabled < 0.5) return 1;
  let span = f.end - f.start;
  if (Math.abs(span) < 1e-6) span = 1e-6;
  const v = Math.max((f.end - viewZ) / span, (f.end - f.clamp) / span);
  return Math.min(1, Math.max(0, v));
}

// ------------------------------------------------------------------------------------------- components

/** What a component loader (loadTrack / loadObjects / loadEnvironment) gets. */
export interface OrigLoadContext {
  /** The built stage (three space): spline, road, environment preset (procedural values), … */
  readonly stage: Stage;
  readonly stageId: string;
  readonly manifest: AssetManifest;
  /** Parts the manifest lists for this stage. */
  readonly parts: readonly string[];
  readonly renderer: THREE.WebGLRenderer;
  /** Texture scope of this view (released by the view's dispose()). */
  readonly textures: TextureScope;
  /** origUniforms (shared by identity). */
  readonly uniforms: OrigSharedUniforms;
  /** Asset-relative path of a part file: `stages/<id>/<part>.<ext>` (default ext json). */
  partPath(part: string, ext?: string): string;
  fetchPartJson<T = unknown>(part: string, ext?: string): Promise<T>;
  fetchPartBuffer(part: string, ext?: string): Promise<ArrayBuffer>;
}

/** One loaded piece of the original stage view. */
export interface OrigComponent {
  readonly object3D: THREE.Object3D;
  /** Per rendered frame, before the render (camera = the frame's camera, dt = frame seconds). */
  update(camera: THREE.Camera, dt: number): void;
  dispose(): void;
  /** Track: ground height (three y) at three-space (x, z) for the camera rig; NaN when off the mesh. */
  heightAt?(x: number, z: number): number;
  /** Environment: draws its own sky (the procedural sky dome is hidden). */
  readonly replacesSky?: boolean;
  /** Minimum camera far plane (m) this component needs (sky box: ≥ 3000·√3 ≈ 5200). */
  readonly cameraFar?: number;
  /** Track: the projected terrain lightmap under three-space (x, y, z) for a car (oT3 through the car palette,
   *  lightmap.ts), or null (no patch / no lightmap there → white). `hint` = the previous sample's patch. */
  carLightmapAt?(x: number, y: number, z: number, hint?: number): OrigLightmapSample | null;
  /** Track: the particle light (RGB 0..1, the projected lightmap through the particle palette) at (x, y, z) into
   *  `out`; returns the patch index (a hint for the next call) or −1 when no lightmap covers the point. */
  particleLightAt?(x: number, y: number, z: number, out: number[], hint?: number): number;
}

/** A car's projected lightmap (OrigComponent.carLightmapAt). */
export interface OrigLightmapSample {
  /** Track.qm patch index (pass back as the next call's hint). */
  readonly patch: number;
  /** The patch lightmap expanded through the car palette; null while it loads (keep the previous one). */
  readonly texture: THREE.Texture | null;
  /** u = proj[0]·x + proj[1], v = proj[2]·z + proj[3] (three world space; C_LIGHTMAP_OFFSET / INVSIZE). */
  readonly proj: readonly [number, number, number, number];
}

/** null = the part is absent for this stage (or deliberately skipped); throw on real failures. */
export type OrigComponentLoader = (ctx: OrigLoadContext) => Promise<OrigComponent | null>;

// ------------------------------------------------------------------------------------------- utils

/**
 * Dispose geometries and materials under `root` (not textures: those belong to a TextureScope). Follows
 * the renderer's sharing rules: objects named `scenery:*` are InstancedMeshes over module-cached geometry
 * (only their instance buffers are released) and materials named `shared:*` are kept.
 */
export function disposeTree(root: THREE.Object3D): void {
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) return;
    if (o.name.startsWith('scenery:') && (o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    else mesh.geometry?.dispose();
    const m = mesh.material;
    for (const mm of Array.isArray(m) ? m : [m]) if (mm && !mm.name.startsWith('shared:')) mats.add(mm);
  });
  for (const m of mats) m.dispose();
}
