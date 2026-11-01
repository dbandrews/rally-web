/**
 * src/render/orig/environment.ts — the original's environment for a ported stage (environment builder):
 * sky box, clouds, sun lens flare (with the original's per-pixel occlusion), weather particles, the shared fog /
 * light uniforms, the view distances, and the frame pipeline that reproduces the original's pass order and its
 * in-race hardware gamma ramp.
 *
 * REQUIRED EXPORTS (composed by index.ts OriginalStageView; the pipeline is driven by renderer.ts):
 *   loadEnvironment(ctx: OrigLoadContext): Promise<OrigComponent | null>
 *   ORIG_SKY_LAYER (defined in common.ts), findOrigEnvironment(root), OrigEnvironment, OrigFramePipeline
 *   applyOrigAtmosphere (procedural content in an original view), applyProceduralAtmosphere (an original car on a
 *   procedural stage)
 *
 * Data: stages/<id>/environment.json (tools/assets/parts/environment.py; every value already defaulted with
 * FUN_0040e650 / the Sky and weather ctors). Pure maths + types: environmentData.ts. Notes and deviations:
 * docs/orig/environment.md. Spec: research/formats/environment.md (§3.1–§3.8, §4, Verification V2/V3),
 * textures.md §6.
 *
 * The original's frame (race view loop 0x49f0f0, environment.md §4.1), reproduced by OrigFramePipeline:
 *   1. sky pass, camera near 10 / far 10 + 100000 (race +0x734/+0x738): sky box (FUN_00547ee0), clouds
 *      (FUN_00549130), then World.qm (FUN_0048eb90). Here: every object on layer ORIG_SKY_LAYER.
 *   2. Clear(ZBUFFER | STENCIL) (0x49f19d).
 *   3. main pass, near 0.1 / far 0.1 + the HotSpot-regulated Track view distance (race +0x73c/+0x740):
 *      track, objects, cars, particles, weather (FUN_0048eb40), then the lens flares (0x78de70 → 0x78a990).
 *   4. the hardware gamma ramp (V3) on the finished frame, with the stage's RenderSettings.con
 *      Game.trackGammaDelta (V3 note 2026-10-30): R^0.9 G^0.95 B^1.0 at delta 0 … R^0.58 G^0.63 B^0.68 at 0.2.
 * The pipeline renders 1–3 into a render target (with a depth texture for the flare occlusion) and blits it to
 * the canvas through the gamma ramp (`?gamma=0` turns the ramp off, e.g. to compare with Screenshots/*.tga,
 * which carry no ramp; `?gfxgamma=<0..1>` sets the menu gamma, default 0.5).
 */
import * as THREE from 'three';
import { urlParam, warnOnce } from '../../core/assets';
import type { EnvironmentPreset, Stage } from '../../core/types';
import { ORIG_DEFAULTS, ORIG_SKY_LAYER, type OrigComponent, type OrigLoadContext, type OrigSharedUniforms } from './common';
import {
  CLOUD_HALF_SIZE,
  CLOUD_QUAD,
  FLARE_CORNER_UV,
  FLARE_OCCLUSION_BLOCK,
  FLARE_VISIBILITY,
  WeatherSim,
  applyEnvironmentUniforms,
  cloudInitialOffset,
  flareCorners,
  flareOnScreen,
  gammaRampExponents,
  hotspotTrackViewDistance,
  layoutFlare,
  skyBoxQuads,
  skyRotationY,
  validateEnvironmentData,
  weatherPointParams,
  type FlareQuad,
  type OrigCloudData,
  type OrigEnvironmentData,
  type OrigSunData,
  type OrigWeatherData,
  type Vec3,
} from './environmentData';
import type { TextureScope } from './textures';

export const ENVIRONMENT_PART = 'environment';

/** The sky-pass layer (common.ts; re-exported here for older imports). */
export { ORIG_SKY_LAYER };
/** Name + userData key of the environment component's object3D (findOrigEnvironment; the track checks for it). */
export const ORIG_ENVIRONMENT_NAME = 'orig:environment';

/**
 * Pass ranges. The race-level ctor (0x483e30) starts with sky near 10 / range 5000, but the level init overwrites
 * them (0x487a6f–0x487a8b, and the settings events 4 / 5 at 0x486ec2 / 0x486edc) with the settings singleton's
 * +0x0c / +0x10, whose FUN_0040e650 defaults are 10 and 100000 (0x40e6c7 / 0x40e6d3; no shipped script sets
 * either). The main pass: near = settings +0x34 = 0.1 (FUN_0040f1e0), range = Track.viewDistance (+0x38) as
 * regulated by the HotSpots. The far plane here is near + range (camera vtbl+0x2c takes the range).
 */
export const SKY_PASS_NEAR = 10;

/**
 * Sky-pass draw order (environment.md §4.1): sky box (FUN_00547ee0) → clouds (FUN_00549130, in their list order) →
 * World.qm (FUN_0048eb90, track.ts WORLD_RENDER_ORDER = −1.5). All three sit in three's opaque render list (the
 * clouds keep their blend factors), so renderOrder alone orders them.
 */
export const SKY_RENDER_ORDER = -2;
export const CLOUD_RENDER_ORDER = -1.9;
/** renderOrder of cloud layer i: between the sky box and World.qm for any cloud count. */
export function cloudRenderOrder(i: number): number {
  return CLOUD_RENDER_ORDER + Math.min(i, 30) * 0.01;
}
export const SKY_PASS_FAR = 10 + 100000;
export const MAIN_PASS_NEAR = 0.1;

/** D3DBLEND (1..11, FUN_00548df0) → three blend factors. */
const D3DBLEND: Record<number, THREE.BlendingSrcFactor> = {
  1: THREE.ZeroFactor,
  2: THREE.OneFactor,
  3: THREE.SrcColorFactor,
  4: THREE.OneMinusSrcColorFactor,
  5: THREE.SrcAlphaFactor,
  6: THREE.OneMinusSrcAlphaFactor,
  7: THREE.DstAlphaFactor,
  8: THREE.OneMinusDstAlphaFactor,
  9: THREE.DstColorFactor,
  10: THREE.OneMinusDstColorFactor,
  11: THREE.SrcAlphaSaturateFactor,
};

// ------------------------------------------------------------------------------------------- shaders

const SKY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Sky box face: the texel as stored (no fog: the sky pass never enables it, §4.1). */
const SKY_FRAG = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0);
}`;

/** Cloud plane: UV = base · texScale + scroll (texture matrix, FUN_00549080 / FUN_00549020). */
const CLOUD_VERT = /* glsl */ `
uniform float uScale;
uniform vec2 uOffset;
varying vec2 vUv;
void main() {
  vUv = uv * uScale + uOffset;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** The 8-bit cloud TGA (alpha bits 8) is coverage: white, alpha = texel (environment.md §3.2 / §8.3; the
 *  forced white 500–1000 m cloud fog would give white as well). */
const CLOUD_FRAG = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(1.0, 1.0, 1.0, texture2D(map, vUv).r);
}`;

/** FlareShader.vs: the quads arrive in clip space already (flareCorners), w = 1. */
const FLARE_VERT = /* glsl */ `
attribute float aAlpha;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vUv = uv;
  vAlpha = aAlpha;
  gl_Position = vec4(position, 1.0);
}`;

/** Stage 0 COLOROP SELECTARG1(TEXTURE) (0x78b798), stage 1 MODULATE(CURRENT, occlusion TEXTURE|ALPHAREPLICATE)
 *  (0x78b80f); alpha = texture × diffuse; SRCALPHA / ONE (0x78b69c). The last element skips stage 1. */
const FLARE_FRAG = /* glsl */ `
uniform sampler2D map;
uniform sampler2D uMask;
uniform float uUseMask;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 t = texture2D(map, vUv);
  float m = uUseMask > 0.5 ? texture2D(uMask, vUv).r : 1.0;
  gl_FragColor = vec4(t.rgb * m, t.a * vAlpha);
}`;

/** The 8×8 occlusion block: 1 where the main pass left the depth buffer clear around the sun's pixel (the
 *  occlusion quad passes the z test there), 0 where geometry covers it or the block leaves the screen. Row 0 of
 *  the mask = the block's top row (v = 0 at the top of each sprite, like the D3D texture). */
const MASK_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const MASK_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uSize;
uniform vec2 uOrigin;
void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 px = uOrigin + cell;                      // screen pixel, y down
  float m = 0.0;
  if (px.x >= 0.0 && px.y >= 0.0 && px.x < uSize.x && px.y < uSize.y) {
    float d = texture2D(tDepth, vec2((px.x + 0.5) / uSize.x, 1.0 - (px.y + 0.5) / uSize.y)).r;
    m = d < 1.0 ? 0.0 : 1.0;
  }
  gl_FragColor = vec4(m, m, m, 1.0);
}`;

/** Weather point sprites (FUN_0054ac20 / FUN_0054b1c0): D3D POINTSCALE A = B = 1, C = 0:
 *  size = Vh · Si · sqrt(1 / (1 + De)) clamped to [min, max] px; colour = texture × WPart.color; SRCALPHA / ONE;
 *  z test on, z write off, no fog. Positions are camera-relative in world axes (the view's rotation only). */
const WEATHER_VERT = /* glsl */ `
uniform float uVh;
uniform float uSi;
uniform float uMinPx;
uniform float uMaxPx;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uVh * uSi * inversesqrt(1.0 + length(mv.xyz)), uMinPx, uMaxPx);
}`;

const WEATHER_FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec4 uColor;
void main() {
  vec4 t = texture2D(map, gl_PointCoord);
  gl_FragColor = vec4(t.rgb * uColor.rgb, t.a * uColor.a);
}`;

/** The in-race gamma ramp on the finished 8-bit frame (V3: R[i] = (i/256)^eR …). */
const BLIT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BLIT_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform vec3 uExp;
uniform float uRamp;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tColor, vUv).rgb;
  if (uRamp > 0.5) c = pow(floor(c * 255.0 + 0.5) / 256.0, uExp);
  gl_FragColor = vec4(c, 1.0);
}`;

function fullScreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
}

// ------------------------------------------------------------------------------------------- pieces

interface CloudRuntime {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  data: OrigCloudData;
  offset: [number, number];
}

interface FlareElementRuntime {
  mesh: THREE.Mesh;
  pos: THREE.BufferAttribute;
  alpha: THREE.BufferAttribute;
}

interface WeatherRuntime {
  sim: WeatherSim;
  data: OrigWeatherData;
  group: THREE.Group;
  attr: THREE.BufferAttribute;
  mats: THREE.ShaderMaterial[];
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

/**
 * The loaded environment of one stage (the component's controller). Created by loadEnvironment; the renderer
 * takes it from view.component('environment') and drives it through OrigFramePipeline.
 */
export class OrigEnvironment implements OrigComponent {
  readonly object3D = new THREE.Group();
  readonly replacesSky: boolean;
  /** Single-camera fallback (renderer without the pipeline): the sky box corner at 3000·√3. */
  readonly cameraFar: number;
  /** Fog colour behind everything (raw, what the frame is cleared to). */
  readonly clearColor = new THREE.Color();
  private readonly sky: THREE.Group | null = null;
  private readonly clouds: CloudRuntime[] = [];
  private readonly flare: { sun: OrigSunData; elements: FlareElementRuntime[]; quads: FlareQuad[]; scene: THREE.Scene } | null = null;
  private readonly weather: WeatherRuntime | null = null;
  private readonly maskTarget: THREE.WebGLRenderTarget | null = null;
  private readonly maskScene: THREE.Scene | null = null;
  private readonly maskMat: THREE.ShaderMaterial | null = null;
  private readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly drawSize = new THREE.Vector2(640, 480);
  private hintS: number | undefined = undefined;
  private flareVisible = false;
  private disposed = false;

  readonly data: OrigEnvironmentData;
  private readonly stage: Stage;

  constructor(
    data: OrigEnvironmentData,
    stage: Stage,
    tex: { faces: (THREE.Texture | null)[]; clouds: (THREE.Texture | null)[]; flare: (THREE.Texture | null)[]; weather: THREE.Texture[] },
  ) {
    this.data = data;
    this.stage = stage;
    this.object3D.name = ORIG_ENVIRONMENT_NAME;
    this.object3D.userData.origEnvironment = this;
    const tf = data.fog.track.color;
    this.clearColor.setRGB(tf[0], tf[1], tf[2], THREE.LinearSRGBColorSpace);

    // ---- sky box (§3.1, FUN_00547ee0): 5 faces, cull NONE, z off, centred on the camera + ofsSkyHeight
    if (data.sky && tex.faces.some((t) => t)) {
      const sky = new THREE.Group();
      sky.name = 'orig:sky';
      const quads = skyBoxQuads(data.sky.halfSize);
      quads.forEach((q, i) => {
        const map = tex.faces[i];
        if (!map) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(q.pos.flat(), 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(q.uv.flat(), 2));
        g.setIndex([0, 1, 2, 2, 1, 3]); // the D3D triangle strip v0 v1 v2 v3
        const mat = new THREE.ShaderMaterial({
          name: 'orig:sky',
          uniforms: { map: { value: map } },
          vertexShader: SKY_VERT,
          fragmentShader: SKY_FRAG,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
          blending: THREE.NoBlending,
          fog: false,
          toneMapped: false,
        });
        const m = new THREE.Mesh(g, mat);
        m.name = `orig:sky:${i}`;
        m.frustumCulled = false;
        m.renderOrder = SKY_RENDER_ORDER;
        m.layers.set(ORIG_SKY_LAYER);
        sky.add(m);
      });
      sky.rotation.y = skyRotationY(data.sky.rotationDeg);
      this.sky = sky;
      this.object3D.add(sky);

      // ---- clouds (§3.2, FUN_00549130): one plane each, 81.92 km, camera.y + height, own blend, z off
      data.sky.clouds.forEach((c, i) => {
        const map = tex.clouds[i];
        if (!map) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(CLOUD_QUAD.pos.flat().map((v) => v * CLOUD_HALF_SIZE), 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(CLOUD_QUAD.uv.flat(), 2));
        g.setIndex([0, 1, 2, 2, 1, 3]);
        const mat = new THREE.ShaderMaterial({
          name: 'orig:cloud',
          uniforms: { map: { value: map }, uScale: { value: c.texScale }, uOffset: { value: new THREE.Vector2() } },
          vertexShader: CLOUD_VERT,
          fragmentShader: CLOUD_FRAG,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
          // opaque render list (three still applies CustomBlending): the sky pass draws sky box → clouds → World.qm
          // (FUN_00547ee0, FUN_00549130, FUN_0048eb90), and World.qm is opaque; in the transparent list the clouds
          // would be drawn after it, over the backdrop mountains
          transparent: false,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: D3DBLEND[c.srcBlend] ?? THREE.SrcAlphaFactor,
          blendDst: (c.dstBlend !== 11 ? D3DBLEND[c.dstBlend] : undefined) as THREE.BlendingDstFactor | undefined ?? THREE.OneMinusSrcAlphaFactor,
          fog: false,
          toneMapped: false,
        });
        const m = new THREE.Mesh(g, mat);
        m.name = `orig:cloud:${c.name}`;
        m.frustumCulled = false;
        m.renderOrder = cloudRenderOrder(i);
        m.layers.set(ORIG_SKY_LAYER);
        this.object3D.add(m);
        this.clouds.push({ mesh: m, mat, data: c, offset: cloudInitialOffset(data.sky!.rndTexPos) });
      });
    }
    this.replacesSky = this.sky !== null;
    this.cameraFar = this.sky ? Math.ceil(data.sky!.halfSize * Math.sqrt(3)) + 10 : 0;

    // ---- sun lens flare (§3.3): rendered by the pipeline after the main pass (needs the main depth)
    const sun = data.sun;
    if (sun && sun.enabled && sun.isSun && sun.elements.length) {
      const scene = new THREE.Scene();
      const elements: FlareElementRuntime[] = [];
      this.maskTarget = new THREE.WebGLRenderTarget(FLARE_OCCLUSION_BLOCK, FLARE_OCCLUSION_BLOCK, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        generateMipmaps: false,
      });
      this.maskTarget.texture.colorSpace = THREE.NoColorSpace;
      const last = sun.elements.length - 1;
      sun.elements.forEach((e, i) => {
        const map = tex.flare[i];
        const g = new THREE.BufferGeometry();
        const pos = new THREE.BufferAttribute(new Float32Array(12), 3).setUsage(THREE.DynamicDrawUsage);
        const alpha = new THREE.BufferAttribute(new Float32Array(4), 1).setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('position', pos);
        g.setAttribute('aAlpha', alpha);
        g.setAttribute('uv', new THREE.Float32BufferAttribute(FLARE_CORNER_UV.flat(), 2));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        const mat = new THREE.ShaderMaterial({
          name: `orig:flare:${e.kind}`,
          uniforms: { map: { value: map }, uMask: { value: this.maskTarget!.texture }, uUseMask: { value: i < last ? 1 : 0 } },
          vertexShader: FLARE_VERT,
          fragmentShader: FLARE_FRAG,
          transparent: true,
          depthWrite: false,
          // the last element sits at clip z = 1 and is z-tested (shows only where the main pass drew nothing)
          depthTest: i === last,
          depthFunc: THREE.LessEqualDepth,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.SrcAlphaFactor,
          blendDst: THREE.OneFactor,
          side: THREE.DoubleSide,
          fog: false,
          toneMapped: false,
        });
        const m = new THREE.Mesh(g, mat);
        m.frustumCulled = false;
        m.renderOrder = i;
        m.visible = false;
        if (map) scene.add(m);
        elements.push({ mesh: m, pos, alpha });
      });
      this.flare = { sun, elements, quads: [], scene };
      this.maskMat = new THREE.ShaderMaterial({
        name: 'orig:flare-mask',
        uniforms: { tDepth: { value: null }, uSize: { value: new THREE.Vector2(1, 1) }, uOrigin: { value: new THREE.Vector2() } },
        vertexShader: MASK_VERT,
        fragmentShader: MASK_FRAG,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
      });
      this.maskScene = new THREE.Scene();
      const tri = new THREE.Mesh(fullScreenTriangle(), this.maskMat);
      tri.frustumCulled = false;
      this.maskScene.add(tri);
    }

    // ---- weather (§3.8): Weather.initWeather + WPart
    const w = data.weather;
    if (w && w.numParticles > 0 && tex.weather.length && (w.type === 0 || w.type === 1)) {
      const sim = new WeatherSim(w);
      const geoAttr = new THREE.BufferAttribute(sim.pos, 3).setUsage(THREE.DynamicDrawUsage);
      const group = new THREE.Group();
      group.name = `orig:weather:${w.type === 0 ? 'snow' : 'rain'}`;
      const mats: THREE.ShaderMaterial[] = [];
      // the draw loop switches texture every count / textures particles (FUN_00687250 in FUN_0054b1c0)
      const nt = tex.weather.length;
      for (let k = 0; k < nt; k++) {
        const a = Math.floor((k * sim.n) / nt);
        const b = Math.floor(((k + 1) * sim.n) / nt);
        if (b <= a) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', geoAttr);
        g.setDrawRange(a, b - a);
        const mat = new THREE.ShaderMaterial({
          name: 'orig:weather',
          uniforms: {
            map: { value: tex.weather[k] },
            uColor: { value: new THREE.Vector4(w.color[0], w.color[1], w.color[2], w.color[3]) },
            uVh: { value: 480 },
            uSi: { value: 0 },
            uMinPx: { value: 1 },
            uMaxPx: { value: 64 },
          },
          vertexShader: WEATHER_VERT,
          fragmentShader: WEATHER_FRAG,
          transparent: true,
          depthWrite: false,
          depthTest: true,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.SrcAlphaFactor,
          blendDst: THREE.OneFactor,
          fog: false,
          toneMapped: false,
        });
        const p = new THREE.Points(g, mat);
        p.frustumCulled = false;
        p.renderOrder = 20;
        group.add(p);
        mats.push(mat);
      }
      this.weather = { sim, data: w, group, attr: geoAttr, mats };
      this.object3D.add(group);
    }
  }

  /** Per frame before the render: sky / clouds / weather follow the camera, clouds scroll, weather moves. */
  update(camera: THREE.Camera, dt: number): void {
    if (this.disposed) return;
    const cam = camera.position;
    if (this.sky && this.data.sky) this.sky.position.set(cam.x, cam.y + this.data.sky.offsetY, cam.z);
    for (const c of this.clouds) {
      c.offset[0] += c.data.speed[0] * dt;
      c.offset[1] += c.data.speed[1] * dt;
      // keep the scroll accumulator small (the texture wraps; float precision over long sessions)
      c.offset[0] -= Math.floor(c.offset[0]);
      c.offset[1] -= Math.floor(c.offset[1]);
      (c.mat.uniforms.uOffset.value as THREE.Vector2).set(c.offset[0], c.offset[1]);
      c.mesh.position.set(cam.x, cam.y + c.data.height, cam.z);
    }
    const w = this.weather;
    if (w) {
      // system position = camera transform · displacement (FUN_0054aa60; SIM camera-local → three: z negated)
      camera.updateMatrixWorld();
      const d = w.data.displacement;
      const sys = tmpV.set(d[0], d[1], -d[2]).applyMatrix4(camera.matrixWorld);
      w.sim.update(Math.min(dt, 0.25), sys);
      w.attr.needsUpdate = true;
      w.group.position.copy(cam);
      const p = weatherPointParams(w.data, this.drawSize.x);
      for (const m of w.mats) {
        m.uniforms.uVh.value = this.drawSize.y;
        m.uniforms.uSi.value = p.si;
        m.uniforms.uMinPx.value = p.minPx;
        m.uniforms.uMaxPx.value = p.maxPx;
      }
    }
  }

  /** Main-pass view distance (m) at the camera: HotSpot-regulated Track.viewDistance (FUN_0049c770). */
  viewDistance(camera: THREE.Camera): number {
    let s = 0;
    try {
      const p = this.stage.project(camera.position, this.hintS);
      if (Number.isFinite(p.s)) {
        s = p.s;
        this.hintS = s;
      }
    } catch {
      /* stage without a spline query: the Global value */
    }
    return hotspotTrackViewDistance(this.data.view, s);
  }

  /**
   * Gamma-ramp exponents (R, G, B) for this stage, or null when the ramp is off (`?gamma=0`). The delta is the
   * stage's script value: RenderSettings.con runs inside Game.createTrack during the play script, before the race
   * loader applies Game.trackGammaDelta at 0x494a6d (environment.md V3 note 2026-10-30).
   */
  gammaExponents(): Vec3 | null {
    const g = urlParam('gamma');
    if (g !== null && /^(0|false|no|off)$/i.test(g)) return null;
    const gg = Number(urlParam('gfxgamma'));
    const gfx = Number.isFinite(gg) && urlParam('gfxgamma') !== null ? Math.min(1, Math.max(0, gg)) : this.data.gamma.gfxGammaDefault;
    return gammaRampExponents(gfx, this.data.gamma.trackGammaDeltaScript, true);
  }

  /** Drawing-buffer size of the frame (weather point sizes, flare layout). */
  setDrawSize(w: number, h: number): void {
    this.drawSize.set(Math.max(1, w), Math.max(1, h));
  }

  /** True when the flare was drawn in the last frame (diagnostics). */
  get flareShown(): boolean {
    return this.flareVisible;
  }

  /**
   * After the main pass, into `target` (still bound for the flare draw): the occlusion mask from the main
   * depth, then the flare elements (0x78a990 + FUN_0078ca00 / FUN_0078d510).
   */
  renderFlare(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, camera: THREE.PerspectiveCamera): void {
    const f = this.flare;
    this.flareVisible = false;
    if (!f || !this.maskTarget || !this.maskMat || !this.maskScene || !target.depthTexture) return;
    const W = this.drawSize.x;
    const H = this.drawSize.y;
    const sd = this.data.light.sunDirThree;
    // the sun object at camera + 4096 · sunDir (FUN_005485b0), projected
    const sunPos = tmpV.set(sd[0], sd[1], sd[2]).multiplyScalar(f.sun.distance).add(camera.position);
    const ndc = sunPos.project(camera);
    const sx = ((ndc.x + 1) / 2) * W;
    const sy = ((1 - ndc.y) / 2) * H;
    const fwd = camera.getWorldDirection(tmpV2);
    const facing = fwd.x * sd[0] + fwd.y * sd[1] + fwd.z * sd[2];
    for (const e of f.elements) e.mesh.visible = false;
    if (!flareOnScreen(sx, sy, W, H, facing)) return;

    // occlusion block: 8×8 pixels from (round(s) − 4) (0x78b1a6–0x78b1b9)
    this.maskMat.uniforms.tDepth.value = target.depthTexture;
    (this.maskMat.uniforms.uSize.value as THREE.Vector2).set(W, H);
    (this.maskMat.uniforms.uOrigin.value as THREE.Vector2).set(Math.round(sx) - FLARE_OCCLUSION_BLOCK / 2, Math.round(sy) - FLARE_OCCLUSION_BLOCK / 2);
    renderer.setRenderTarget(this.maskTarget);
    renderer.render(this.maskScene, this.orthoCam);
    renderer.setRenderTarget(target);

    const quads = layoutFlare(f.sun, { sx, sy, width: W, height: H }, facing, FLARE_VISIBILITY, f.quads);
    const xScale = 4 / 3 / (W / H);
    f.elements.forEach((e, i) => {
      const q = quads[i];
      if (!q || !q.visible) return;
      flareCorners(q, xScale, e.pos.array as Float32Array);
      e.pos.needsUpdate = true;
      const a = q.color[3] / 255;
      (e.alpha.array as Float32Array).fill(a);
      e.alpha.needsUpdate = true;
      e.mesh.visible = true;
    });
    renderer.render(f.scene, this.orthoCam);
    this.flareVisible = true;
  }

  /** The scenes the pipeline renders besides the stage scene (flare quads, flare occlusion mask): GameRenderer.warmUp. */
  get extraScenes(): THREE.Scene[] {
    return this.flare && this.maskScene ? [this.flare.scene, this.maskScene] : [];
  }

  /**
   * GameRenderer.warmUp: the flare passes of renderFlare() once into `target` (the flare elements are shown for it and
   * restored), so the mask target, the programs and the geometry buffers exist before the sun first comes into view.
   * Draws nothing visible (the elements are degenerate until laid out); renderer state is restored.
   */
  warmFlare(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): void {
    const f = this.flare;
    if (!f || !this.maskTarget || !this.maskMat || !this.maskScene) return;
    const depth = this.maskMat.uniforms.tDepth.value;
    const prev = renderer.getRenderTarget();
    try {
      this.maskMat.uniforms.tDepth.value = null;
      renderer.setRenderTarget(this.maskTarget);
      renderer.render(this.maskScene, this.orthoCam);
      renderer.setRenderTarget(target);
      const shown = f.elements.map((e) => e.mesh.visible);
      for (const e of f.elements) e.mesh.visible = true;
      try {
        renderer.render(f.scene, this.orthoCam);
      } finally {
        f.elements.forEach((e, i) => (e.mesh.visible = shown[i]));
      }
    } finally {
      this.maskMat.uniforms.tDepth.value = depth;
      renderer.setRenderTarget(prev);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object3D.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
    if (this.flare) {
      for (const e of this.flare.elements) {
        e.mesh.geometry.dispose();
        (e.mesh.material as THREE.Material).dispose();
      }
    }
    this.maskScene?.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.maskMat?.dispose();
    this.maskTarget?.dispose();
    this.object3D.removeFromParent();
    delete this.object3D.userData.origEnvironment;
  }
}

/** The environment controller inside a view's group, found by name (null when the stage has none); tools / tests —
 *  the renderer uses OriginalStageView.component('environment'). */
export function findOrigEnvironment(root: THREE.Object3D | null | undefined): OrigEnvironment | null {
  const o = root?.getObjectByName(ORIG_ENVIRONMENT_NAME);
  const e = o?.userData.origEnvironment as OrigEnvironment | undefined;
  return e ?? null;
}

// ------------------------------------------------------------------------------------------- loader

async function loadTextures(
  scope: TextureScope,
  ids: (string | null | undefined)[],
  opts: Parameters<TextureScope['get']>[1],
): Promise<(THREE.Texture | null)[]> {
  return Promise.all(ids.map((id) => (id ? scope.get(id, opts) : Promise.resolve(null))));
}

export async function loadEnvironment(ctx: OrigLoadContext): Promise<OrigComponent | null> {
  if (!ctx.parts.includes(ENVIRONMENT_PART)) return null;
  const data = validateEnvironmentData(await ctx.fetchPartJson(ENVIRONMENT_PART));
  // the shared uniforms first (every original material reads them by identity)
  applyEnvironmentUniforms(data, ctx.uniforms);
  const clamp = THREE.ClampToEdgeWrapping;
  const repeat = THREE.RepeatWrapping;
  const [faces, clouds, flare, weather] = await Promise.all([
    // sky: clamp, min/mag linear, mip point (§3.1: 0x940..0x948 = 3, 0x9a0..0x9a8 = 2, 2, 1)
    loadTextures(ctx.textures, data.sky?.faces ?? [], { wrapS: clamp, wrapT: clamp, minFilter: THREE.LinearMipmapNearestFilter, magFilter: THREE.LinearFilter }),
    loadTextures(ctx.textures, data.sky?.clouds.map((c) => c.tex) ?? [], { wrapS: repeat, wrapT: repeat }),
    loadTextures(ctx.textures, data.sun?.elements.map((e) => e.tex) ?? [], { wrapS: clamp, wrapT: clamp }),
    // weather: min/mag linear (FUN_0054ac20 0x9a0..0x9a8 = 2, 2, 1, mip point), sampled at level 0: WebGL selects a
    // point sprite's mip from the gl_PointCoord derivatives (a 4–6 px flake reads level 2 of the 16² sprite and
    // averages the bright core away), which the original's D3D8 point sprites evidently did not — every 3b-f / 3c-f
    // Screenshot shows distinct white flakes (docs/orig/environment.md, assumption)
    loadTextures(ctx.textures, data.weather?.textures ?? [], { wrapS: clamp, wrapT: clamp, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }),
  ]);
  return new OrigEnvironment(data, ctx.stage, { faces, clouds, flare, weather: weather.filter((t): t is THREE.Texture => t !== null) });
}

// ------------------------------------------------------------------------------------------- renderer helpers

const powRgb = (v: THREE.Vector3, e: number, out: THREE.Color) =>
  out.setRGB(Math.pow(Math.max(0, v.x), e), Math.pow(Math.max(0, v.y), e), Math.pow(Math.max(0, v.z), e), THREE.LinearSRGBColorSpace);

/**
 * Scene fog + the three.js lights for PROCEDURAL content inside an original view (docs/ASSETS.md §10 gap 4;
 * the original materials use origUniforms and ignore all of this):
 *   * scene.fog = the track fog as a THREE.Fog (raw colour) — needed for `vFogDepth`; hooked built-in
 *     shaders replace three's smoothstep with the original linear + clamp fog (environmentFog.ts);
 *   * background = the track fog colour (raw);
 *   * lights = the original car lighting (environment.md §3.5: D = car.ambient + max(0, N·sun)·car.lightColor,
 *     gamma-space): a hemisphere light of car.ambient and a sun of car.lightColor along the original sun,
 *     both intensity π (three's Lambert BRDF divides by π, §8.4) and raised to 2.2 because the built-ins light
 *     in linear space and are sRGB-encoded afterwards (so the encoded result ≈ the gamma-space product).
 */
export function applyOrigAtmosphere(
  scene: THREE.Scene,
  hemi: THREE.HemisphereLight,
  sun: THREE.DirectionalLight,
  u: OrigSharedUniforms,
): void {
  const f = u.trackFog;
  const fogColor = new THREE.Color().setRGB(f.color.value.x, f.color.value.y, f.color.value.z, THREE.LinearSRGBColorSpace);
  scene.fog = f.enabled.value > 0.5 ? new THREE.Fog(fogColor, f.start.value, f.end.value) : new THREE.Fog(fogColor, 1e8, 1e9);
  if (scene.background instanceof THREE.Color) scene.background.copy(fogColor);
  else scene.background = fogColor;
  powRgb(u.carAmbient.value, 2.2, hemi.color);
  hemi.groundColor.copy(hemi.color);
  hemi.intensity = Math.PI;
  powRgb(u.carLight.value, 2.2, sun.color);
  sun.intensity = Math.PI;
}

/** Calibration of applyProceduralAtmosphere [I]: procedural sun intensity giving car.lightColor = sunColor, and the
 *  hemisphere-intensity → car.ambient scale. */
export const PROC_SUN_REF = 3;
export const PROC_AMBIENT_SCALE = 0.65;

/**
 * A PROCEDURAL stage with an original car (the reverse of applyOrigAtmosphere): the stage's EnvironmentPreset mapped
 * onto the shared original uniforms that the original car shader reads (carShader.ts: car light / ambient, sun
 * direction, track fog), so the car is lit and fogged like the procedural scene around it. No original data exists
 * for these stages, so the light levels are a calibration [I] that puts a clear procedural day (sun 2.2–3.0,
 * ambient 0.8–1.0) at the original's daylight stages (car.lightColor 0.7–1.0, car.ambient 0.5–0.7):
 *   sunDir     = env.sunDir (three space, toward the sun; below the horizon at night → no direct light)
 *   carLight   = sunColor bytes · min(1.2, sunIntensity / PROC_SUN_REF) · exposure
 *   carAmbient = ambientSky bytes · ambientIntensity · PROC_AMBIENT_SCALE · exposure
 *   trackFog   = on, fogColor bytes (raw), fogNear … fogFar, no clamp (the procedural fog is three's smoothstep)
 * Everything else keeps the original's defaults (call after resetOrigUniforms). Colours stay raw 0..1 bytes like the
 * original's (the car shader outputs gamma-space values with no colour-space conversion).
 */
export function applyProceduralAtmosphere(env: EnvironmentPreset, u: OrigSharedUniforms): void {
  const rgb = (hex: number, k: number, out: THREE.Vector3) => out.set((((hex >> 16) & 255) / 255) * k, (((hex >> 8) & 255) / 255) * k, ((hex & 255) / 255) * k);
  const exposure = Number.isFinite(env.exposure) ? env.exposure : 1;
  const sd = env.sunDir;
  u.sunDir.value.set(sd.x, sd.y, sd.z);
  if (u.sunDir.value.lengthSq() > 1e-12) u.sunDir.value.normalize();
  else u.sunDir.value.set(0, 1, 0);
  rgb(env.sunColor, Math.min(1.2, Math.max(0, env.sunIntensity) / PROC_SUN_REF) * exposure, u.carLight.value);
  rgb(env.ambientSky, Math.max(0, env.ambientIntensity) * PROC_AMBIENT_SCALE * exposure, u.carAmbient.value);
  const f = u.trackFog;
  f.enabled.value = 1;
  rgb(env.fogColor, 1, f.color.value);
  f.start.value = env.fogNear;
  f.end.value = env.fogFar;
  f.clamp.value = ORIG_DEFAULTS.fogClamp;
}

/** Pass options for a loaded view: is World.qm (any mesh outside the environment) on the sky layer? */
export function origPassOptions(viewGroup: THREE.Object3D, viewCameraFar: number): OrigPassOptions {
  let worldInSkyPass = false;
  const env = viewGroup.getObjectByName(ORIG_ENVIRONMENT_NAME);
  viewGroup.traverse((o) => {
    if (worldInSkyPass || !(o as THREE.Mesh).isMesh || !o.layers.isEnabled(ORIG_SKY_LAYER)) return;
    let p: THREE.Object3D | null = o;
    while (p && p !== env) p = p.parent;
    if (!p) worldInSkyPass = true;
  });
  return { worldInSkyPass, minMainFar: viewCameraFar };
}

// ------------------------------------------------------------------------------------------- frame pipeline

export interface OrigPassOptions {
  /** World.qm (or anything else besides the sky) is on ORIG_SKY_LAYER: the main pass may stop at the view
   *  distance like the original. Otherwise the main far stays ≥ `minMainFar` so nothing in the main pass
   *  that the original drew in the sky pass gets cut. */
  worldInSkyPass: boolean;
  minMainFar: number;
}

/**
 * The original's frame for an original view (see the module header). One per GameRenderer; bind the stage's
 * environment with setEnvironment (null → the renderer renders as usual).
 */
export class OrigFramePipeline {
  private env: OrigEnvironment | null = null;
  private opts: OrigPassOptions = { worldInSkyPass: false, minMainFar: 0 };
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly skyCam = new THREE.PerspectiveCamera();
  private readonly blitScene = new THREE.Scene();
  private readonly blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blitMat: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();
  private exps: Vec3 | null = null;
  /** Last main-pass far plane (diagnostics). */
  mainFar = 0;

  private readonly renderer: THREE.WebGLRenderer;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.blitMat = new THREE.ShaderMaterial({
      name: 'orig:gamma',
      uniforms: { tColor: { value: null }, uExp: { value: new THREE.Vector3(1, 1, 1) }, uRamp: { value: 0 } },
      vertexShader: BLIT_VERT,
      fragmentShader: BLIT_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const tri = new THREE.Mesh(fullScreenTriangle(), this.blitMat);
    tri.frustumCulled = false;
    this.blitScene.add(tri);
    (window as unknown as { __rallyOrigPipeline?: OrigFramePipeline }).__rallyOrigPipeline = this;
  }

  get active(): boolean {
    return this.env !== null;
  }

  get environment(): OrigEnvironment | null {
    return this.env;
  }

  /** Gamma exponents in use (null = ramp off). */
  get gamma(): Vec3 | null {
    return this.exps;
  }

  setEnvironment(env: OrigEnvironment | null, opts?: Partial<OrigPassOptions>): void {
    this.env = env;
    this.opts = { worldInSkyPass: false, minMainFar: 0, ...opts };
    this.exps = env ? env.gammaExponents() : null;
    const u = this.blitMat.uniforms;
    u.uRamp.value = this.exps ? 1 : 0;
    if (this.exps) (u.uExp.value as THREE.Vector3).set(this.exps[0], this.exps[1], this.exps[2]);
    if (!env) {
      this.target?.dispose();
      this.target = null;
    }
  }

  private ensureTarget(w: number, h: number): THREE.WebGLRenderTarget {
    let t = this.target;
    if (t && t.width === w && t.height === h) return t;
    t?.dispose();
    const gl = this.renderer.getContext();
    const aa = !!gl.getContextAttributes()?.antialias;
    const samples = aa ? Math.min(4, this.renderer.capabilities.maxSamples || 0) : 0;
    t = new THREE.WebGLRenderTarget(w, h, {
      samples,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType),
    });
    t.texture.colorSpace = THREE.NoColorSpace;
    this.target = t;
    return t;
  }

  /** The scenes besides the stage scene that a frame renders (gamma blit, flare quads, flare mask): GameRenderer.warmUp. */
  get extraScenes(): THREE.Scene[] {
    return [this.blitScene, ...(this.env?.extraScenes ?? [])];
  }

  /**
   * GameRenderer.warmUp: the passes of render() once into `rt` (a small offscreen target) with the scene as it is now —
   * sky pass, main pass, flare passes, gamma blit — so every program, geometry buffer and the flare mask target exist
   * before the first real frame; and the full-size frame target is allocated. Draws nothing to the canvas and changes
   * neither the camera nor the scene (the caller shows hidden objects for it). No environment: a plain render.
   */
  warm(scene: THREE.Scene, camera: THREE.PerspectiveCamera, rt: THREE.WebGLRenderTarget): void {
    const r = this.renderer;
    const env = this.env;
    if (!env) {
      r.render(scene, camera);
      return;
    }
    const sky = this.skyCam;
    sky.copy(camera, false);
    sky.near = env.data.view.skyPassNear || SKY_PASS_NEAR;
    sky.far = env.data.view.skyPassFar || SKY_PASS_FAR;
    sky.layers.set(ORIG_SKY_LAYER);
    sky.updateProjectionMatrix();
    sky.updateMatrixWorld();
    const prev = r.getRenderTarget();
    const tColor = this.blitMat.uniforms.tColor.value;
    try {
      r.setRenderTarget(rt);
      r.render(scene, sky);
      r.render(scene, camera);
      env.warmFlare(r, rt);
      r.setRenderTarget(rt);
      this.blitMat.uniforms.tColor.value = null;
      r.render(this.blitScene, this.blitCam);
    } finally {
      this.blitMat.uniforms.tColor.value = tColor;
      r.setRenderTarget(prev);
    }
    r.getDrawingBufferSize(this.size);
    r.initRenderTarget(this.ensureTarget(Math.max(1, Math.floor(this.size.x)), Math.max(1, Math.floor(this.size.y))));
  }

  /** Render one frame of `scene` seen by `camera` (the main camera; its near / far are set here). */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const env = this.env;
    const r = this.renderer;
    if (!env) {
      r.render(scene, camera);
      return;
    }
    r.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x));
    const h = Math.max(1, Math.floor(this.size.y));
    env.setDrawSize(w, h);
    const target = this.ensureTarget(w, h);

    // main pass range: near 0.1, far = near + the HotSpot-regulated Track view distance (race +0x73c/+0x740)
    const near = env.data.view.mainPassNear || MAIN_PASS_NEAR;
    let far = near + env.viewDistance(camera);
    if (!this.opts.worldInSkyPass) far = Math.max(far, this.opts.minMainFar);
    if (camera.near !== near || Math.abs(camera.far - far) > 1e-3) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    this.mainFar = far;
    camera.updateMatrixWorld();
    const sky = this.skyCam;
    sky.copy(camera, false);
    sky.near = env.data.view.skyPassNear || SKY_PASS_NEAR;
    sky.far = env.data.view.skyPassFar || SKY_PASS_FAR;
    sky.layers.set(ORIG_SKY_LAYER);
    sky.updateProjectionMatrix();
    sky.updateMatrixWorld();

    const autoClear = r.autoClear;
    const background = scene.background;
    const info = r.info;
    const autoReset = info.autoReset;
    r.autoClear = false;
    scene.background = null;
    info.autoReset = false;
    info.reset();
    try {
      r.setRenderTarget(target);
      r.setClearColor(env.clearColor, 1);
      r.clear(true, true, true);
      r.render(scene, sky); // 1. sky box, clouds (+ World.qm when it is on the sky layer)
      r.clearDepth(); // 2.
      r.render(scene, camera); // 3. the main pass
      env.renderFlare(r, target, camera); // lens flares (occlusion from the main depth)
      r.setRenderTarget(null);
      this.blitMat.uniforms.tColor.value = target.texture;
      r.render(this.blitScene, this.blitCam); // 4. the gamma ramp
    } catch (e) {
      warnOnce('orig-pipeline', `[orig] environment frame failed (${(e as Error)?.message ?? e}); rendering without it`);
      r.setRenderTarget(null);
      this.setEnvironment(null);
      r.autoClear = autoClear;
      scene.background = background;
      info.autoReset = autoReset;
      r.render(scene, camera);
      return;
    }
    r.autoClear = autoClear;
    scene.background = background;
    info.autoReset = autoReset;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.blitMat.dispose();
    this.blitScene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.env = null;
  }
}