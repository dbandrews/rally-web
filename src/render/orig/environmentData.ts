/**
 * src/render/orig/environmentData.ts — the environment part's data (stages/<id>/environment.json written by
 * tools/assets/parts/environment.py) and the pure maths of the original's sky / sun / weather / gamma code, kept
 * free of WebGL so vitest can check it against the evaluated scripts.
 *
 * Spec: research/formats/environment.md (§3.1–§3.8, §4, Verification V2 / V3) and the exe addresses cited
 * per function. docs/orig/environment.md lists what is ported and every deviation.
 */
import { ORIG_DEFAULTS, type OrigSharedUniforms } from './common';
import { maxHotspotValue, regulateHotspot } from './hotspots';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

export interface OrigFogData {
  enabled: boolean;
  color: Vec3;
  start: number;
  end: number;
  /** Track: `Track.fogClamp` (1e8 = no clamp); World: always 1e8. */
  clamp: number;
  /** `fogRangeFixed` (fogzor TrackFogSettings): used by the original only below track detail "high". */
  rangeFixed: Vec2;
  /** Fields the stage leaves unset (filled from FUN_0040e650). */
  defaulted: string[];
}

export interface OrigCloudData {
  name: string;
  tex: string | null;
  /** D3DBLEND enums (BMZero 1 … BMSourceAlphaSaturate 11, FUN_00548df0). */
  srcBlend: number;
  dstBlend: number;
  texScale: number;
  /** UV scroll per second (`Cloud.setSpeed du dv`). */
  speed: Vec2;
  /** Plane height above the camera (m). */
  height: number;
}

export interface OrigSkyData {
  /** texIds: TOP, LFT, RGT, FRT, BAK (FUN_00547c40; no bottom face). */
  faces: (string | null)[];
  rotationDeg: number;
  offsetY: number;
  halfSize: number;
  clouds: OrigCloudData[];
  rndTexPos: number;
}

export interface OrigFlareElement {
  kind: 'flare' | 'corona';
  tex: string | null;
  /** Values at the screen centre (`setFlareSize` / `setFlareColor`, colour 0..255). */
  size: Vec2;
  color: Vec4;
  /** Values at the screen edge (`setFlareSize2` / `setFlareColor2`). */
  size2: Vec2;
  color2: Vec4;
  /** Turns per screen-x sweep (FUN_0078d510: angle = (x + W) / 2W · rot · 2π). */
  rot: number;
}

export interface OrigSunData {
  object: string | null;
  template: string;
  lensFlareCount: number;
  coronaCount: number;
  occlusion: Vec2;
  isSun: boolean;
  enabled: boolean;
  /** Sun object distance from the camera (FUN_005485b0: 4096 m). */
  distance: number;
  /** Flares first, then coronas (element order of FUN_0078d460). */
  elements: OrigFlareElement[];
}

export interface OrigWeatherData {
  /** 0 snow, 1 rain (FUN_0054a770 accepts 0 and 1 only). */
  type: number;
  radius: number;
  partSize: Vec2;
  speed: Vec3;
  random: number;
  numParticles: number;
  pointSpriteMinSize: number;
  pointSpriteMaxSize: number;
  displacement: Vec3;
  color: Vec4;
  scale: Vec3;
  textures: string[];
  unused: { fadeZ: number; fadeInValue: number; acceleration: number };
}

export interface OrigHotSpot {
  name: string;
  splineDistance?: number;
  width?: number;
  fade?: number;
  trackViewDistance?: number;
  objectViewDistance?: number;
  [k: string]: unknown;
}

export interface OrigEnvironmentData {
  version: number;
  stage: string;
  variant: string;
  fog: { track: OrigFogData; world: OrigFogData };
  light: {
    sunDirSim: Vec3;
    sunDirThree: Vec3;
    sunDirSet: boolean;
    objectLight: Vec3;
    objectShadow: Vec3;
    carLight: Vec3;
    carAmbient: Vec3;
    carShadow: Vec3;
    carDropShadow: Vec3;
    carLightmapMin: Vec3;
    carLightmapMax: Vec3;
    carLightmapClamp: Vec2;
    carShadowHeightScale: number;
    trackBumpHeight: number;
    trackSpecularColor: Vec3;
    particleLightmapMin: Vec3;
  };
  sky: OrigSkyData | null;
  sun: OrigSunData | null;
  weather: OrigWeatherData | null;
  view: {
    trackViewDistance: number;
    objectViewDistance: number;
    hotspotsEnabled: boolean;
    hotspots: OrigHotSpot[];
    fieldOfView: number;
    skyPassNear: number;
    skyPassFar: number;
    mainPassNear: number;
    mainPassFarDefault: number;
    cameraFar: number;
  };
  gamma: { trackGammaDeltaScript: number; trackGammaDeltaLive: number; gfxGammaDefault: number };
  templates: Record<string, { lightColor?: Vec3; shadowColor?: Vec3; lighting?: boolean }>;
  defaultsApplied: Record<string, unknown>;
  textures: string[];
}

export const ENVIRONMENT_DATA_VERSION = 1;

/** Minimal shape check (a malformed part throws → the view warns once and keeps the procedural environment). */
export function validateEnvironmentData(d: unknown): OrigEnvironmentData {
  const e = d as OrigEnvironmentData;
  if (!e || typeof e !== 'object') throw new Error('environment.json is not an object');
  if (e.version !== ENVIRONMENT_DATA_VERSION) throw new Error(`environment.json version ${String(e.version)}`);
  for (const f of [e.fog?.track, e.fog?.world]) {
    if (!f || f.color?.length !== 3 || !Number.isFinite(f.start) || !Number.isFinite(f.end)) throw new Error('environment.json: bad fog');
  }
  const l = e.light;
  if (!l || l.sunDirThree?.length !== 3 || l.objectLight?.length !== 3 || l.carLight?.length !== 3) throw new Error('environment.json: bad light');
  return e;
}

/**
 * Write the stage's evaluated values into the shared uniforms IN PLACE (identity kept; OriginalStageView.load
 * has already reset them to ORIG_DEFAULTS). Every field is present in the json (the build applies the
 * FUN_0040e650 defaults), so this is a plain copy:
 *   trackFog / worldFog ← Track.* / World.* fog (high-detail fogRange, §3.4); World has no clamp (V6.3 open)
 *   sunDir              ← Sky.sunLightDirectionVec, normalised, three space (FUN_0049a680)
 *   objectLight/Shadow  ← game.lightColor / game.shadowColor;  carLight / carAmbient ← car.lightColor / car.ambient
 *   carLightmapMin/Max/Clamp ← Car.lightmapMin/Max/Clamp (the car palette); particleLightmapMin ← game.particleLightmapMin
 */
export function applyEnvironmentUniforms(d: OrigEnvironmentData, u: OrigSharedUniforms): void {
  const fogs: [OrigFogData, OrigSharedUniforms['trackFog']][] = [
    [d.fog.track, u.trackFog],
    [d.fog.world, u.worldFog],
  ];
  for (const [src, dst] of fogs) {
    dst.enabled.value = src.enabled ? 1 : 0;
    dst.color.value.set(src.color[0], src.color[1], src.color[2]);
    dst.start.value = src.start;
    dst.end.value = src.end;
    dst.clamp.value = Number.isFinite(src.clamp) ? src.clamp : ORIG_DEFAULTS.fogClamp;
  }
  u.worldFog.clamp.value = ORIG_DEFAULTS.fogClamp;
  const s = d.light.sunDirThree;
  u.sunDir.value.set(s[0], s[1], s[2]);
  if (u.sunDir.value.lengthSq() > 1e-12) u.sunDir.value.normalize();
  u.objectLight.value.set(...d.light.objectLight);
  u.objectShadow.value.set(...d.light.objectShadow);
  u.carLight.value.set(...d.light.carLight);
  u.carAmbient.value.set(...d.light.carAmbient);
  const l = d.light;
  if (l.carLightmapMin?.length === 3) u.carLightmapMin.value.set(...l.carLightmapMin);
  if (l.carLightmapMax?.length === 3) u.carLightmapMax.value.set(...l.carLightmapMax);
  if (l.carLightmapClamp?.length === 2) u.carLightmapClamp.value.set(...l.carLightmapClamp);
  if (l.particleLightmapMin?.length === 3) u.particleLightmapMin.value.set(...l.particleLightmapMin);
}

// ------------------------------------------------------------------------------------------- sky box

/**
 * The 5 sky quads of FUN_00547ee0 (environment.md §3.1 table, confirmed by the seam test §6.2 and the glow test
 * V4) in THREE space (z negated): per face 4 vertices (D3D strip order v0 v1 v2 v3) with the D3D UVs
 * v0 (0,1) v1 (1,1) v2 (0,0) v3 (1,0) (textures are stored top row first and sampled with flipY = false).
 * Order of faces = OrigSkyData.faces (TOP, LFT, RGT, FRT, BAK).
 */
export function skyBoxQuads(S: number): { pos: Vec3[]; uv: Vec2[] }[] {
  const sim: Vec3[][] = [
    [[+S, +S, -S], [-S, +S, -S], [+S, +S, +S], [-S, +S, +S]], // TOP
    [[-S, -S, -S], [-S, -S, +S], [-S, +S, -S], [-S, +S, +S]], // LFT
    [[+S, -S, +S], [+S, -S, -S], [+S, +S, +S], [+S, +S, -S]], // RGT
    [[-S, -S, +S], [+S, -S, +S], [-S, +S, +S], [+S, +S, +S]], // FRT
    [[+S, -S, -S], [-S, -S, -S], [+S, +S, -S], [-S, +S, -S]], // BAK
  ];
  const uv: Vec2[] = [[0, 1], [1, 1], [0, 0], [1, 0]];
  return sim.map((q) => ({ pos: q.map(([x, y, z]) => [x, y, -z] as Vec3), uv }));
}

/** Sky / cloud rotation about +Y in three space for `Sky.setRotAngle a` (degrees; SIM x' = x·c + z·s ⇒ θ = −a). */
export function skyRotationY(rotationDeg: number): number {
  return (-rotationDeg * Math.PI) / 180;
}

// ------------------------------------------------------------------------------------------- clouds

/** Cloud plane half size in m: vertices ±2048 scaled by the world matrix diag(20, 0, 20) (FUN_00549130 with
 *  FUN_005d52d0(&DAT_008eec78 = (20, 0, 20))). The plane follows the camera (x, z) at camera.y + height. */
export const CLOUD_HALF_SIZE = 2048 * 20;

/** Cloud quad (FUN_00549130 vertex table, SIM → three): positions (unit = CLOUD_HALF_SIZE) and base UVs. */
export const CLOUD_QUAD: { pos: Vec3[]; uv: Vec2[] } = {
  // SIM (-1,0,+1) (1,-1); (-1,0,-1) (1,0); (+1,0,+1) (0,-1); (+1,0,-1) (0,0)   — strip order
  pos: [[-1, 0, -1], [-1, 0, 1], [1, 0, -1], [1, 0, 1]],
  uv: [[1, -1], [1, 0], [0, -1], [0, 0]],
};

/** Initial random UV offset of a cloud: (rand() % 1000) · ofsRndTexPos · 0.001 per axis (FUN_00549060). */
export function cloudInitialOffset(rndTexPos: number, rand: () => number = Math.random): Vec2 {
  const r = () => Math.floor(rand() * 32768) % 1000;
  return [r() * rndTexPos * 0.001, r() * rndTexPos * 0.001];
}

// ------------------------------------------------------------------------------------------- lens flare

/** FlareShader c9.xy (FUN_0078a6a0: SetVertexShaderConstant(9, (1/300, −0.0043333, 0, 1))): quad half extents in
 *  clip space per WIDTH_HEIGHT unit, authored for 4:3. The web keeps the vertical scale and corrects x for the
 *  viewport aspect so the sprites keep the original's on-screen shape at any aspect (deviation, docs). */
export const FLARE_C9 = { x: 1 / 300, y: -0.0043333331 } as const;
/** WIDTH_HEIGHT = size · 25 (FUN_0078d510, constant 0x808554). */
export const FLARE_SIZE_UNIT = 25;
/** Clip z of the flare quads (FUN_0078ca00 0x3d4ccccd) and of the depth-tested last corona (FUN_0078d510). */
export const FLARE_Z_NEAR = 0.05;
export const FLARE_Z_SUN = 1.0;
/** The second-to-last element is scaled by the occlusion visibility, or hidden below this (FUN_0078d510, 0x8066f8). */
export const FLARE_VIS_MIN = 0.3;
/**
 * The visibility FUN_0078baa0 returns (+0xf0[viewport]) in this build: the draw method 0x78a990 writes
 * counter[+0x74] / counter[+0x64] with both counters set to 1 on every path (0x78b589–0x78b5df), so it is
 * always 1. The real occlusion is per pixel: the OCCLUSION MASK below.
 */
export const FLARE_VISIBILITY = 1;
/**
 * Occlusion mask (0x78a990): the SunOcclusionShader quad (white, alpha-only colour writes, z-tested against
 * the main pass) is drawn at the sun, then the 8×8 back-buffer block centred on the sun's pixel is copied
 * (CopyRects, rect clipped to the screen, the rest of the 8×8 "occlusion-texture" zero-filled first) and bound
 * on texture stage 1 of every flare element but the last one (COLOROP MODULATE, CURRENT × TEXTURE|
 * ALPHAREPLICATE): each sprite is multiplied by that 8×8 alpha block, stretched over its UVs (bilinear).
 * A sun whose block lies completely off screen draws no flare at all.
 */
export const FLARE_OCCLUSION_BLOCK = 8;

/**
 * Corners of one flare quad in clip space, FlareShader.vs literally:
 *   r9 = (wh.x·cos + wh.y·sin, wh.y·cos − wh.x·sin);  oPos.xy = c9.xy · r9 + centre.xy;  oPos.z = z;  oPos.w = 1
 * with wh = (±w, ±h) per corner (WIDTH_HEIGHT; +y is screen-down because c9.y < 0). Corner / UV order:
 * TL (−w,−h) uv (0,0), TR (+w,−h) (1,0), BR (+w,+h) (1,1), BL (−w,+h) (0,1).
 * `xScale` corrects c9.x for the viewport aspect (the original assumes 4:3: xScale = (4/3) / (W/H); 1 at 4:3).
 * Writes 4 × (x, y, z) into `out` at `offset`.
 */
export function flareCorners(q: FlareQuad, xScale: number, out: Float32Array, offset = 0): void {
  const s = Math.sin(q.angle);
  const c = Math.cos(q.angle);
  const cx = FLARE_C9.x * xScale;
  const cy = FLARE_C9.y;
  for (let k = 0; k < 4; k++) {
    const wx = (k === 0 || k === 3 ? -1 : 1) * q.w;
    const wy = (k < 2 ? -1 : 1) * q.h;
    const rx = wx * c + wy * s;
    const ry = wy * c - wx * s;
    out[offset + k * 3] = cx * rx + q.x;
    out[offset + k * 3 + 1] = cy * ry + q.y;
    out[offset + k * 3 + 2] = q.z;
  }
}

/** UVs of the 4 corners of flareCorners (TL, TR, BR, BL; v = 0 is the texture's top row, flipY = false). */
export const FLARE_CORNER_UV: readonly Vec2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** Is the sun drawn at all this frame? FUN_0078a6a0: dot(sunDir, camera forward) ≥ 0; 0x78a990: the 8×8
 *  occlusion block must overlap the screen (its clipped rect non-empty). */
export function flareOnScreen(sx: number, sy: number, width: number, height: number, facing: number): boolean {
  if (!(facing >= 0)) return false;
  const half = FLARE_OCCLUSION_BLOCK / 2;
  const x0 = Math.floor(sx) - half;
  const y0 = Math.floor(sy) - half;
  return x0 + FLARE_OCCLUSION_BLOCK > 0 && y0 + FLARE_OCCLUSION_BLOCK > 0 && x0 < width && y0 < height;
}

// ------------------------------------------------------------------------------------------- view distance

/**
 * The main (track) pass's view distance for a camera at spline distance `s` (race +0x740, regulated per frame
 * by FUN_0049c770 through the HotSpot regulator FUN_004e1240 when `HotSpot.enable 1`): the `Global` spot's
 * trackViewDistance adjusted by every named spot (hotspots.ts regulateHotspot: Global + the most negative delta +
 * the most positive delta). Without hot spots (or without a Global spot): Track.viewDistance. The main pass
 * far = near + this.
 */
export function hotspotTrackViewDistance(view: Pick<OrigEnvironmentData['view'], 'trackViewDistance' | 'hotspotsEnabled' | 'hotspots'>, s: number): number {
  if (!view.hotspotsEnabled) return view.trackViewDistance;
  const global = view.hotspots.find((h) => h.name === 'Global');
  const g = global?.trackViewDistance;
  if (typeof g !== 'number') return view.trackViewDistance;
  return regulateHotspot(g, view.hotspots, s, (h) => (h === global ? undefined : h.trackViewDistance));
}

/** The largest main-pass view distance the stage can ask for. */
export function maxHotspotTrackViewDistance(view: Pick<OrigEnvironmentData['view'], 'trackViewDistance' | 'hotspotsEnabled' | 'hotspots'>): number {
  if (!view.hotspotsEnabled) return view.trackViewDistance;
  const global = view.hotspots.find((h) => h.name === 'Global');
  if (typeof global?.trackViewDistance !== 'number') return view.trackViewDistance;
  return maxHotspotValue(global.trackViewDistance, view.hotspots, (h) => h.trackViewDistance);
}

/** Screen-centre weight of FUN_0078c4e0: a tent, 1 at the centre, 0 at (and beyond) the edges, min over x / y. */
export function flareCentreWeight(x: number, y: number, halfW: number, halfH: number): number {
  const tx = x >= halfW ? 1 - (x - halfW) / halfW : x / halfW;
  const ty = y >= halfH ? 1 - (y - halfH) / halfH : y / halfH;
  return Math.min(Math.max(0, tx), Math.max(0, ty));
}

export interface FlareQuad {
  /** Clip-space centre (x, y), clip z (w = 1). */
  x: number;
  y: number;
  z: number;
  /** WIDTH_HEIGHT half extents (size · 25 · scale), before c9. */
  w: number;
  h: number;
  /** Rotation (radians). */
  angle: number;
  /** Colour 0..255 (RGBA), vertex colour of all 4 corners. */
  color: Vec4;
  visible: boolean;
}

/**
 * Lay out the lens-flare elements for one frame, literally FUN_0078ca00 (sun branch) + FUN_0078d510:
 *   (sx, sy) = the sun object's screen position (pixels, y down); m = 2·centre − s (mirror through the centre);
 *   flare i (i < lensFlareCount) at m + (s − m)·i / lensFlareCount, coronas at s;
 *   t = flareCentreWeight(element), size = t·size + (1−t)·size2, colour = t·color + (1−t)·color2;
 *   size scale = min(vpW / resW, vpH / resH) (1 for a full-screen view);
 *   elements before the last two: alpha ·= dot(dirToSun, cameraForward) (+0xf8);
 *   element count−2: size ·= visibility when visibility ≥ 0.3, else hidden;
 *   element count−1 (the sun disc): clip z = 1 (depth-tested against the scene; everything else z = 0.05).
 *   rotation = (x + W) / 2W · rot · 2π (0x945718 = π/180 times 360).
 */
export function layoutFlare(
  sun: Pick<OrigSunData, 'lensFlareCount' | 'elements'>,
  screen: { sx: number; sy: number; width: number; height: number },
  facing: number,
  visibility: number,
  out: FlareQuad[],
): FlareQuad[] {
  const { sx, sy, width: W, height: H } = screen;
  const n = sun.elements.length;
  const nf = Math.min(sun.lensFlareCount, n);
  const mx = W - sx; // 2·vpX + vpW − sx with vpX = 0
  const my = H - sy;
  out.length = n;
  for (let i = 0; i < n; i++) {
    const e = sun.elements[i];
    let x: number, y: number;
    if (i < nf) {
      x = mx + ((sx - mx) * i) / nf;
      y = my + ((sy - my) * i) / nf;
    } else {
      x = sx;
      y = sy;
    }
    const t = flareCentreWeight(x, y, W * 0.5, H * 0.5);
    let w = (t * e.size[0] + (1 - t) * e.size2[0]) * FLARE_SIZE_UNIT;
    let h = (t * e.size[1] + (1 - t) * e.size2[1]) * FLARE_SIZE_UNIT;
    const c: Vec4 = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) c[k] = t * e.color[k] + (1 - t) * e.color2[k];
    let z = FLARE_Z_NEAR;
    let visible = true;
    if (i < n - 2) {
      c[3] *= facing;
    } else if (i === n - 2) {
      if (visibility >= FLARE_VIS_MIN) {
        w *= visibility;
        h *= visibility;
      } else {
        w = h = 0;
        visible = false;
      }
    } else {
      z = FLARE_Z_SUN;
    }
    const angle = ((x + W) / (W + W)) * e.rot * 2 * Math.PI;
    const q = out[i] ?? (out[i] = { x: 0, y: 0, z: 0, w: 0, h: 0, angle: 0, color: [0, 0, 0, 0], visible: true });
    q.x = (2 * x) / W - 1;
    q.y = 1 - (2 * y) / H;
    q.z = z;
    q.w = w;
    q.h = h;
    q.angle = angle;
    q.color[0] = Math.min(255, Math.max(0, c[0]));
    q.color[1] = Math.min(255, Math.max(0, c[1]));
    q.color[2] = Math.min(255, Math.max(0, c[2]));
    q.color[3] = Math.min(255, Math.max(0, c[3]));
    q.visible = visible && (w !== 0 || h !== 0) && q.color[3] > 0;
  }
  return out;
}

// ------------------------------------------------------------------------------------------- weather

/** D3D fixed-function point size with POINTSCALEENABLE, A = 1, B = 1, C = 0 (FUN_0054ac20 + the state reset
 *  FUN_00685700(0)): S = Vh · Si · sqrt(1 / (A + B·De + C·De²)), clamped to [min, max] (all in pixels). */
export function weatherPointSize(viewportH: number, si: number, eyeDist: number, minPx: number, maxPx: number): number {
  const s = viewportH * si * Math.sqrt(1 / (1 + eyeDist));
  return Math.min(maxPx, Math.max(minPx, s));
}

/** POINTSIZE = partSize.x · 0.25 (snow) / · 0.5 (rain); POINTSIZE_MIN/MAX = width / 640 · pointSpriteMin/MaxSize
 *  (FUN_0054b1c0, constants 0x8061d0 / 0x8061c4 / 0x808464). */
export function weatherPointParams(w: OrigWeatherData, viewportW: number): { si: number; minPx: number; maxPx: number } {
  const si = w.partSize[0] * (w.type === 0 ? 0.25 : 0.5);
  const k = viewportW * 0.0015625;
  return { si, minPx: k * w.pointSpriteMinSize, maxPx: k * w.pointSpriteMaxSize };
}

/**
 * One weather system as FUN_0054a830 (spawn) / FUN_0054aa60 (system position) / FUN_0054b1c0 (update) do it.
 * Particle positions live in a camera-centred, world-axis frame (drawn with the view rotation only):
 *   spawn:   rejection-sample p in the ball |p| ≤ radius, then p /= scale (per axis);
 *            velocity = (U(−1,1)·random) per axis (vtbl 0x54a110 when random ≠ 0)
 *   frame:   sys = camera transform · displacement (camera-local offset); Δsys = sys − sys_prev;
 *            p_new = p + (speed + v)·dt − Δsys;  |scale ⊙ p_new|² > radius² → p = −p_old (wrap to the far side)
 * Positions are a flat Float32Array (x, y, z per particle) in THREE space (the SIM z axis is negated).
 */
export class WeatherSim {
  readonly n: number;
  readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly prevSys = { x: 0, y: 0, z: 0, valid: false };
  readonly w: OrigWeatherData;
  private readonly rand: () => number;

  constructor(w: OrigWeatherData, count = w.numParticles, rand: () => number = Math.random) {
    this.w = w;
    this.rand = rand;
    this.n = Math.max(0, Math.floor(count));
    this.pos = new Float32Array(this.n * 3);
    this.vel = new Float32Array(this.n * 3);
    for (let i = 0; i < this.n; i++) this.spawn(i);
  }

  private spawn(i: number): void {
    const r = this.w.radius;
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 64; k++) {
      x = (this.rand() * 2 - 1) * r;
      y = (this.rand() * 2 - 1) * r;
      z = (this.rand() * 2 - 1) * r;
      if (x * x + y * y + z * z <= r * r) break;
    }
    const s = this.w.scale;
    this.pos[i * 3] = x / (s[0] || 1);
    this.pos[i * 3 + 1] = y / (s[1] || 1);
    this.pos[i * 3 + 2] = -(z / (s[2] || 1));
    const rnd = this.w.random;
    this.vel[i * 3] = rnd ? (this.rand() * 2 - 1) * rnd : 0;
    this.vel[i * 3 + 1] = rnd ? (this.rand() * 2 - 1) * rnd : 0;
    this.vel[i * 3 + 2] = rnd ? -(this.rand() * 2 - 1) * rnd : 0;
  }

  /** Advance by dt; `sys` = the system position (camera + rotated displacement), THREE space. */
  update(dt: number, sys: { x: number; y: number; z: number }): void {
    let dx = 0, dy = 0, dz = 0;
    if (this.prevSys.valid) {
      dx = sys.x - this.prevSys.x;
      dy = sys.y - this.prevSys.y;
      dz = sys.z - this.prevSys.z;
    }
    this.prevSys.x = sys.x;
    this.prevSys.y = sys.y;
    this.prevSys.z = sys.z;
    this.prevSys.valid = true;
    const { speed, scale, radius } = this.w;
    const r2 = radius * radius;
    const sx = speed[0], sy = speed[1], sz = -speed[2];
    const p = this.pos, v = this.vel;
    for (let i = 0; i < this.n * 3; i += 3) {
      const ox = p[i], oy = p[i + 1], oz = p[i + 2];
      const nx = ox + (sx + v[i]) * dt - dx;
      const ny = oy + (sy + v[i + 1]) * dt - dy;
      const nz = oz + (sz + v[i + 2]) * dt - dz;
      const qx = scale[0] * nx, qy = scale[1] * ny, qz = scale[2] * nz;
      if (qx * qx + qy * qy + qz * qz > r2) {
        p[i] = -ox;
        p[i + 1] = -oy;
        p[i + 2] = -oz;
      } else {
        p[i] = nx;
        p[i + 1] = ny;
        p[i + 2] = nz;
      }
    }
  }
}

// ------------------------------------------------------------------------------------------- gamma ramp

/**
 * The in-race hardware gamma ramp (environment.md V3; 0x68dd70 → IDirect3DDevice8::SetGammaRamp):
 *   x = gfxGamma + (enable ? delta : 0);  y = max(1 − x, 0.01);  e = 2·y² + 0.5
 *   R[i] = (i/256)^(e − 0.1·enable), G[i] = (i/256)^(e − 0.05·enable), B[i] = (i/256)^e   (× 65535)
 * The race loader (0x493230) applies it at 0x494a6d with enable = true and delta = Game.trackGammaDelta as the
 * stage's RenderSettings.con set it: that script runs inside Game.createTrack (0x428710 → 0x494c00 → 0x4963e7)
 * while the loader runs the stage's play script, before the read (environment.md V3 note 2026-10-30). At the
 * default gfxGamma 0.5: delta 0 → R^0.9 G^0.95 B^1.0, 0.1 → R^0.72 G^0.77 B^0.82, 0.2 → R^0.58 G^0.63 B^0.68.
 * Race teardown (0x486530) sets (0, false): the identity ramp at gfxGamma 0.5.
 */
export function gammaRampExponents(gfxGamma = 0.5, delta = 0, enable = true): Vec3 {
  const x = gfxGamma + (enable ? delta : 0);
  const y = Math.max(1 - x, 0.01);
  const e = 2 * y * y + 0.5;
  return [e - (enable ? 0.1 : 0), e - (enable ? 0.05 : 0), e];
}

/** One ramp entry as the 0..1 output for input byte i (0..255): (i / 256)^exp. */
export function gammaRampValue(i: number, exp: number): number {
  return Math.pow(i / 256, exp);
}
