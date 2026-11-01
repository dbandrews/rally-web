/**
 * src/render/renderer.ts — OWNED BY THE RENDER BUILDER.
 *
 * Three.js presentation: scene, sky/fog/lights from stage.environment, terrain mesh from
 * stage.heightfield, road ribbon from stage.road, instanced scenery, car meshes (original designs and
 * liveries, constants.ts ARCHETYPES colours), wheel animation, the §5.3 camera rig (8 views + look-back +
 * flipped-car follow), and effects (dust, skid marks).
 *
 * REQUIRED EXPORTS (keep these signatures; contract in src/core/types.ts IGameRenderer):
 *   class GameRenderer implements IGameRenderer
 *     constructor(container: HTMLElement)             // creates and appends its own <canvas>
 *     readonly domElement: HTMLCanvasElement
 *     readonly cameraTuning: CameraTuning             // live; defaults from §5.3 / §6 Camera
 *     loadStage(stage: Stage): void | Promise<void>
 *     addCar(id: string, archetype: ArchetypeId, opts?: AddCarOptions): Promise<void>   // resolves with the final visual
 *     removeCar(id: string): void
 *     update(frameDt: number, alpha: number, cars: readonly CarRenderState[]): void   // renders a frame
 *     setCameraMode(mode: CameraMode): void; nextCamera(): CameraMode; getCameraMode(): CameraMode
 *     lookBack(on: boolean): void
 *     setCameraTuning(partial: DeepPartial<CameraTuning>): void
 *     resize(): void; stats(): RenderStats; dispose(): void
 *   makeCameraTuning(): CameraTuning                  // §5.3 defaults = ImprezaWRX's table (archetype cars)
 *   defaultCameraTuning(): CameraTuning               // + the player car's own CarCamera (main.ts "reset to original")
 *
 * Inputs are THREE space already (CarRenderState.pos/quat are interpolated by main.ts). Car mesh faces -Z.
 * Wheel conventions: src/core/space.ts (rotation.y = -steerAngle, rotation.x = -spinAngle).
 * Camera constants are "per 60 Hz frame": use perFrameK(k, frameDt) from src/core/math.ts.
 *
 * Extras (optional for the integrator): setQuality('low'|'medium'|'high'), getQuality(), setAutoQuality(on),
 * getAutoQuality(), debugInfo(), setDebugCamera(); window.__rallyRenderer points at the instance (tools).
 * URL: ?quality=low|medium|high pins a preset; default on a real GPU is adaptive (start 'high', 'medium' on a
 * touch-first device, step down while
 * the smoothed frame rate stays < 50 fps); CPU rasterisers (headless SwiftShader) default to 'low', pr 0.6.
 * ?pr=<pixel ratio>, ?aa=0|1 (MSAA).
 *
 * Module map (src/render/): cameraRig (§5.3), sky (dome + env map), terrain, road, scenery (+ gates),
 * sceneryModels, carModel (lofted bodies), livery (canvas liveries), carVisual (wheels / lights),
 * effects (particles, skid marks, per-car emitters), weather, textures (procedural canvases), geomUtil,
 * heightSampler; orig/ = the ORIGINAL-asset look (docs/ASSETS.md).
 *
 * Original assets: for a ported stage whose asset manifest lists render parts (track / objects /
 * environment), loadStage awaits OriginalStageView (src/render/orig/index.ts) and shows it INSTEAD of the
 * procedural terrain / road / scenery, with the original's gamma-space output (NoToneMapping +
 * LinearSRGBColorSpace); procedural stages keep ACES + sRGB. No manifest, `?orig=0` or any load failure →
 * the procedural stage (one console warning at most). The TextureStore (orig/textures.ts) lives as long as
 * the renderer; `?s3tc=0` forces its JS DXT decoder.
 * Original cars: each frame the projected track lightmap under the car (OriginalStageView.carLightmapAt, through
 * the car palette) is handed to its visual (t3; `?carlm=0` keeps it white for A/B comparisons); on a procedural
 * stage the stage's preset is mapped onto the shared original uniforms (orig/environment.ts
 * applyProceduralAtmosphere) so the original car matches the scene. addCar's promise settles once the original
 * visual is attached (the procedural car is hidden meanwhile and shows only as the fallback); the player car's own
 * CarCamera positions (cars.json `camera`, orig/car.ts carCameraTuning) replace the generic §5.3 table.
 */
import * as THREE from 'three';
import { isPortedStageId, warnOnce } from '../core/assets';
import { DT } from '../core/constants';
import { deepMergeInto } from '../core/paths';
import { applyThreeQuat } from '../core/space';
import type {
  AddCarOptions,
  ArchetypeId,
  CameraMode,
  CameraTuning,
  CarRenderState,
  DeepPartial,
  EnvironmentPreset,
  IGameRenderer,
  RenderStats,
  Stage,
} from '../core/types';
import { CameraRig, makeCameraTuning } from './cameraRig';
import { CarVisual } from './carVisual';
import { CarEffects, ParticleSystem, SkidMarks } from './effects';
import { OriginalStageView, TextureStore, resetOrigUniforms, type TextureScope } from './orig';
import { carCameraTuning, loadOriginalCar } from './orig/car';
import { origUniforms } from './orig/common';
import { OrigEnvironment, OrigFramePipeline, applyOrigAtmosphere, applyProceduralAtmosphere, origPassOptions } from './orig/environment';
import { setOrigBuiltinMode } from './orig/environmentFog';
import { buildRoad } from './road';
import { buildScenery, buildStageLabels, updateSceneryLod, type SceneryBatch } from './scenery';
import { capped, yieldToBrowser } from './loadCap';
import { SkyDome } from './sky';
import { buildTerrain, updateTerrainLod, type TerrainChunk } from './terrain';
import { Precipitation } from './weather';

export { makeCameraTuning } from './cameraRig';

export type RenderQuality = 'low' | 'medium' | 'high';

interface QualityPreset {
  shadows: boolean;
  shadowMap: number;
  shadowBox: number;
  pixelRatio: number;
  particles: number;
  /** Multiplies terrain / scenery LOD distances. */
  lod: number;
}

/** Adaptive quality: step down when the smoothed frame rate stays below this for AUTO_SLOW_S seconds. The step is
 *  only DECIDED while racing; it is applied at a safe point (applyPendingQuality: countdown, pause / menu, results,
 *  restart, stage load), never while the race is running. */
const AUTO_MIN_FPS = 50;
const AUTO_SLOW_S = 2.5;
/** No adaptive decisions for this long after a stage load / quality change (shader + upload hitches). */
const AUTO_WARMUP_S = 3;
/** Frames longer than this are stalls (GC, a load, a tab switch), not the GPU speed: left out of the average, unless this
 *  many in a row (a device that really renders at < 20 fps), which then count as 50 ms frames. */
const AUTO_STALL_DT = 0.05;
const AUTO_STALL_RUN = 20;
/** The original effects (data + textures, per-car drop shadows) are part of the load, but a stalled connection must not
 *  hold the start: the procedural effects run until / unless they arrive. */
const EFFECTS_LOAD_CAP_MS = 8000;
/** warmUp: the longest wait for the parallel shader compile (the hidden draw then links whatever is left). */
const WARM_COMPILE_CAP_MS = 10000;
/** warmUp: main-thread slice between yields while uploading textures. */
const WARM_SLICE_MS = 12;

const QUALITY: Record<RenderQuality, QualityPreset> = {
  high: { shadows: true, shadowMap: 2048, shadowBox: 60, pixelRatio: 1.5, particles: 1, lod: 1 },
  medium: { shadows: true, shadowMap: 1024, shadowBox: 48, pixelRatio: 1.25, particles: 0.75, lod: 0.85 },
  low: { shadows: false, shadowMap: 512, shadowBox: 40, pixelRatio: 0.85, particles: 0.5, lod: 0.65 },
};

const ORIGIN = new THREE.Vector3(0, 0, 0);
const Y_UP = new THREE.Vector3(0, 1, 0);

interface CarEntry {
  visual: CarVisual;
  effects: CarEffects | null;
  ghost: boolean;
  player: boolean;
  /** PHASE 2: an AI opponent (AddCarOptions.ai), its grid index (render slots 24·carIndex + wheel) and the model LOD
   *  level forced for it (null = the renderer's distance LOD; the original's othercarlodlevel / playercarlodlevel,
   *  ai.md §9). The ai-race builder owns the LOD behaviour (setCarLod). */
  ai: boolean;
  carIndex: number;
  lodLevel: number | null;
  /** Texture scope of the original car visual (cars builder, loadOriginalCar); disposed after the visual. */
  origScope: TextureScope | null;
  /** Projected track lightmap under the original car (OriginalStageView.carLightmapAt): last patch + texture. */
  lmPatch: number;
  lmTex: THREE.Texture | null;
  /** The renderer frame this car was last given a state in (a ghost without one is hidden). */
  seen: number;
}

const isNight = (env: EnvironmentPreset) => env.timeOfDay < 6.5 || env.timeOfDay > 19.5 || env.sunDir.y < 0.05;

/** True when WebGL runs on a CPU rasteriser (headless SwiftShader / llvmpipe): pick cheap defaults there. */
export function isSoftwareGL(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|software|softpipe/i.test(name);
  } catch {
    return false;
  }
}

/** Every texture the materials of `root` reference: material maps and ShaderMaterial uniform values (single or arrays). */
function collectTextures(root: THREE.Object3D, out: Set<THREE.Texture>): void {
  const add = (v: unknown) => {
    const t = v as THREE.Texture | null | undefined;
    if (t?.isTexture && !t.isRenderTargetTexture && !(t as THREE.DepthTexture).isDepthTexture) out.add(t);
  };
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      for (const k in mat) add((mat as unknown as Record<string, unknown>)[k]);
      const u = (mat as THREE.ShaderMaterial).uniforms as Record<string, { value: unknown }> | undefined;
      if (!u) continue;
      for (const k in u) {
        const v = u[k]?.value;
        if (Array.isArray(v)) v.forEach(add);
        else add(v);
      }
    }
  });
}

function urlParam(name: string): string | null {
  try {
    return typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get(name) : null;
  } catch {
    return null;
  }
}

export class GameRenderer implements IGameRenderer {
  readonly domElement: HTMLCanvasElement;
  readonly cameraTuning: CameraTuning = makeCameraTuning();
  /** Original car whose CarCamera positions are in cameraTuning (null = the generic §5.3 table) and its patch. */
  private cameraCar: string | null = null;
  private cameraPatch: DeepPartial<CameraTuning> | null = null;
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly rig: CameraRig;
  private readonly sky = new SkyDome();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.5);
  private readonly hemi = new THREE.HemisphereLight(0xbcd4f0, 0x6b6250, 1.0);
  private readonly headlight = new THREE.SpotLight(0xfff1d6, 0, 90, 0.5, 0.45, 1.2);
  private readonly particles = new ParticleSystem(3200);
  private readonly skids = new SkidMarks(7000);
  private stageRoot: THREE.Group | null = null;
  /** Original-asset look of the current stage (null = procedural). */
  private origView: OriginalStageView | null = null;
  /** The original's frame for an original view (sky pass, main pass, flares, gamma ramp; orig/environment.ts). */
  private origPipeline: OrigFramePipeline | null = null;
  /** Original textures (shared across stage loads; each view holds a scope). */
  readonly textureStore: TextureStore;
  private loadSeq = 0;
  /** The OriginalStageView.load in flight. View loads run one at a time: a superseded load must settle (its
   *  components may still write the shared origUniforms) before a newer stage load resets them. */
  private viewLoad: Promise<OriginalStageView | null> | null = null;
  private terrainChunks: TerrainChunk[] = [];
  private sceneryBatches: SceneryBatch[] = [];
  private stage: Stage | null = null;
  private envMap: THREE.WebGLRenderTarget | null = null;
  private precip: Precipitation | null = null;
  private night = false;
  private readonly cars = new Map<string, CarEntry>();
  private quality: RenderQuality = 'high';
  /** Adaptive quality: steps high → medium → low while the smoothed frame rate stays below AUTO_MIN_FPS. */
  private autoQuality = false;
  private slowTime = 0;
  /** Smoothed real frame time (s) and warm-up left before the adaptive check runs (after loads / changes). */
  private frameEma = 1 / 60;
  private warmup = AUTO_WARMUP_S;
  private pixelRatioOverride: number | null = null;
  private frame = 0;
  private fps = 60;
  private cpuMs = 0;
  private lastPlayerStep = -1;
  private readonly onResize = () => this.queueResize();
  private readonly resizeObs: ResizeObserver | null = null;
  /** A window resize / container resize is waiting for the next frame (one resize pass per frame, resize()). */
  private resizePending = false;
  private sizeW = -1;
  private sizeH = -1;
  private sizePr = -1;
  private disposed = false;
  /** Shadow state the materials were last compiled for (applyQuality recompiles only when it changes). */
  private shadowKey = '';
  /** An adaptive step-down waiting for a safe point (applyPendingQuality). */
  private pendingQuality: RenderQuality | null = null;
  private pendingFps = 0;
  private stallRun = 0;
  /** warmUp(): runs one at a time; the small offscreen target its hidden draws go to; its last cost (ms). */
  private warmJob: Promise<void> = Promise.resolve();
  private warmRt: THREE.WebGLRenderTarget | null = null;
  private warmMs = 0;
  /** An effects load hit its cap (a stalled connection): warmUp does not wait for it a second time. */
  private effectsStalled = false;
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly carVel = new THREE.Vector3();
  // followShadow scratch
  private readonly sFwd = new THREE.Vector3();
  private readonly sCentre = new THREE.Vector3();
  private readonly sNeg = new THREE.Vector3();
  private readonly sRot = new THREE.Matrix4();
  private readonly sInv = new THREE.Matrix4();
  private debugCam: { pos: THREE.Vector3; target: THREE.Vector3; relative: boolean } | null = null;

  /** CPU rasteriser detected (headless tooling): defaults to 'low' quality, no MSAA. */
  readonly softwareGL: boolean;
  /** The track lightmap under original cars (`?carlm=0`: off, t3 = white; diagnostics). */
  private readonly carLightmaps = !/^(0|false|no|off)$/i.test(urlParam('carlm') ?? '');

  constructor(container: HTMLElement) {
    this.container = container;
    this.softwareGL = isSoftwareGL();
    const aaQ = urlParam('aa');
    const antialias = aaQ !== null ? aaQ !== '0' : !this.softwareGL;
    this.renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.textureStore = new TextureStore(this.renderer);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.domElement = this.renderer.domElement;
    this.domElement.style.display = 'block';
    this.domElement.style.width = '100%';
    this.domElement.style.height = '100%';
    container.appendChild(this.domElement);

    this.rig = new CameraRig(this.cameraTuning);
    this.scene.add(this.sky.mesh);
    this.scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 2.5;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.headlight.visible = false;
    this.scene.add(this.headlight);
    this.scene.add(this.headlight.target);
    this.scene.add(this.particles.mesh);
    this.scene.add(this.skids.mesh);
    this.scene.background = new THREE.Color(0xc9dcef);

    // ?quality=low|medium|high pins a preset; default (or ?quality=auto) on a real GPU starts at 'high' and
    // steps down while the frame rate stays low; a CPU rasteriser (headless tooling) gets a fixed 'low'.
    const q = urlParam('quality');
    if (q === 'low' || q === 'medium' || q === 'high') this.quality = q;
    else if (q === 'auto' || !this.softwareGL) {
      this.autoQuality = true;
      // phones / tablets (coarse primary pointer): start one step down, mobile GPUs rarely hold 'high'
      if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) this.quality = 'medium';
    } else this.quality = 'low';
    const pr = Number(urlParam('pr'));
    if (Number.isFinite(pr) && pr > 0.25 && pr <= 3) this.pixelRatioOverride = pr;
    else if (this.softwareGL && !q) this.pixelRatioOverride = 0.6; // headless tooling: favour frame rate
    this.applyQuality();

    // tooling hook (render diagnostics from Playwright: stats(), debugInfo(), setQuality(), setDebugCamera())
    (window as unknown as { __rallyRenderer?: GameRenderer }).__rallyRenderer = this;
    window.addEventListener('resize', this.onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.queueResize());
      this.resizeObs.observe(container);
    }
    this.resize();
  }

  // ----------------------------------------------------------------------------------------- quality

  /** Pin a quality preset (turns adaptive quality off unless `keepAuto`). */
  setQuality(q: RenderQuality, keepAuto = false): void {
    this.quality = q;
    if (!keepAuto) this.autoQuality = false;
    this.pendingQuality = null;
    this.warmup = AUTO_WARMUP_S;
    this.slowTime = 0;
    this.applyQuality();
  }

  getQuality(): RenderQuality {
    return this.quality;
  }

  /** Adaptive quality on/off (default on for hardware GL without ?quality=). */
  setAutoQuality(on: boolean): void {
    this.autoQuality = on;
    if (!on) this.pendingQuality = null;
    this.warmup = AUTO_WARMUP_S;
    this.slowTime = 0;
  }

  getAutoQuality(): boolean {
    return this.autoQuality;
  }

  /** The drawing-buffer pixel ratio of the current preset (or ?pr=), at the display's current devicePixelRatio. */
  private targetPixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return this.pixelRatioOverride ?? Math.min(dpr, QUALITY[this.quality].pixelRatio);
  }

  private applyQuality(): void {
    const p = QUALITY[this.quality];
    this.renderer.shadowMap.enabled = p.shadows;
    this.sun.castShadow = this.sunShadowWanted();
    if (this.sun.shadow.mapSize.x !== p.shadowMap) {
      this.sun.shadow.mapSize.set(p.shadowMap, p.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    const cam = this.sun.shadow.camera;
    cam.left = -p.shadowBox;
    cam.right = p.shadowBox;
    cam.top = p.shadowBox;
    cam.bottom = -p.shadowBox;
    cam.near = 1;
    cam.far = 500;
    cam.updateProjectionMatrix();
    this.particles.density = p.particles;
    this.particles.orig.density = p.particles; // the original effects' particle cap (1 on 'high' = the original's)
    // materials need a recompile only when the shadow state toggles (pixel ratio / LOD / shadow map size do not touch a program)
    const key = `${p.shadows ? 1 : 0}${this.sun.castShadow ? 1 : 0}`;
    if (key !== this.shadowKey) {
      this.shadowKey = key;
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (!m) return;
        for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
      });
    }
    this.resize(); // the pixel ratio is applied there, when it changed
  }

  /** An adaptive step-down is waiting for a safe point (applyPendingQuality). */
  get hasPendingQuality(): boolean {
    return this.pendingQuality !== null;
  }

  /**
   * Apply the adaptive step-down decided while racing, at a point where a hitch is harmless (main.ts: countdown, pause /
   * menu, results, restart; warmUp does it for a stage load), then warm up for the new pipeline state (shadow programs,
   * frame target). No-op without a pending step. Never rejects.
   */
  async applyPendingQuality(): Promise<boolean> {
    if (!this.stepPendingQuality()) return false;
    await this.warmUp();
    return true;
  }

  private stepPendingQuality(): boolean {
    const q = this.pendingQuality;
    this.pendingQuality = null;
    if (!q || q === this.quality || !this.autoQuality) return false;
    this.setQuality(q, true);
    console.info(`[render] ${this.pendingFps} fps → quality ${q}`);
    return true;
  }

  // ----------------------------------------------------------------------------------------- stage

  async loadStage(stage: Stage): Promise<void> {
    const seq = ++this.loadSeq;
    // textures released from here on (this view, the cars re-added with it) stay idle for reuse until the next load
    const texGen = this.textureStore.beginGeneration();
    this.disposeStage();
    this.origPipeline?.setEnvironment(null); // its environment went with the view
    this.stage = stage;
    const env = stage.environment;
    // original-asset look for ported stages with built render parts (null → procedural, see header)
    let view: OriginalStageView | null = null;
    if (this.viewLoad) {
      // an older ported load is still running: let it finish first (procedural loads stay synchronous otherwise)
      await this.viewLoad;
      if (seq !== this.loadSeq) return;
    }
    if (isPortedStageId(stage.id)) {
      const p = OriginalStageView.load(stage, this.renderer, this.textureStore).catch((e) => {
        warnOnce(`render-orig:${stage.id}`, `[render] original view of ${stage.id} failed: ${(e as Error)?.message ?? e}`);
        return null;
      });
      this.viewLoad = p;
      try {
        view = await p;
      } finally {
        if (this.viewLoad === p) this.viewLoad = null;
      }
      if (seq !== this.loadSeq) {
        view?.dispose(); // a newer loadStage() started while this one was loading
        return;
      }
    }
    // no original view: the shared original uniforms back to the defaults, then the procedural preset mapped onto
    // the ones an original car reads (light, ambient, sun, fog)
    if (!view) {
      resetOrigUniforms();
      applyProceduralAtmosphere(env, origUniforms);
    }
    const root = new THREE.Group();
    root.name = `stage:${stage.id}`;
    let groundAt: (x: number, z: number) => number;
    if (view) {
      const v = view;
      root.add(v.group);
      groundAt = (x, z) => v.groundAt(x, z);
    } else {
      const terrain = buildTerrain(stage);
      root.add(terrain.group);
      this.terrainChunks = terrain.chunks;
      root.add(buildRoad(stage, terrain.sampler));
      const scenery = buildScenery(stage, terrain.sampler);
      this.sceneryBatches = scenery.batches;
      root.add(scenery.group);
      if (stage.labels?.length) root.add(buildStageLabels(stage, terrain.sampler));
      const sampler = terrain.sampler;
      groundAt = (x, z) => sampler.heightAt(x, z);
    }
    this.origView = view;
    // what the previous loads released and this one did not take back (TextureStore idle pool)
    this.textureStore.flushIdle(texGen);
    // no sun shadow map over an original track: none of its materials receives shadows (the original has none)
    this.sun.castShadow = this.sunShadowWanted();
    this.setOriginalOutput(view !== null);
    this.sky.mesh.visible = !view?.replacesSky;
    this.scene.add(root);
    this.stageRoot = root;

    // atmosphere
    this.scene.fog = new THREE.Fog(env.fogColor, env.fogNear, env.fogFar);
    (this.scene.background as THREE.Color).setHex(env.fogColor);
    this.sky.setEnvironment(env);
    this.renderer.toneMappingExposure = env.exposure;
    this.hemi.color.setHex(env.ambientSky);
    this.hemi.groundColor.setHex(env.ambientGround);
    this.hemi.intensity = env.ambientIntensity * 0.95;
    this.sun.color.setHex(env.sunColor);
    this.sun.intensity = env.sunIntensity * 1.0;
    this.night = isNight(env);
    this.headlight.visible = this.night;
    this.headlight.intensity = this.night ? 60 : 0;
    this.envMap = this.sky.makeEnvMap(this.renderer, env);
    this.scene.environment = this.envMap?.texture ?? null;
    this.scene.environmentIntensity = 0.9;
    // procedural particles inside an original view: the original track fog and projected-lightmap light
    this.particles.setOriginal(view !== null, view ? (x, y, z, out, hint) => view.particleLightAt(x, y, z, out, hint) : null);
    this.particles.setEnvironment(env);
    this.particles.clear();
    this.skids.clear();
    // original car effects of this stage (effects builder; procedural effects until / unless they load): awaited below
    this.effectsStalled = false;
    const effectsLoad = this.particles.setStage(stage.id, view !== null, this.textureStore);
    // an original view: the original fog / lights for the procedural content in it (gap 4, orig/environment*.ts);
    // its weather is the original's (environment component), never the procedural precipitation
    setOrigBuiltinMode(view !== null);
    if (view) applyOrigAtmosphere(this.scene, this.hemi, this.sun, origUniforms);
    if (!view && (env.weather === 'snow' || env.weather === 'rain' || env.weather === 'dust')) {
      this.precip = new Precipitation(env.weather, QUALITY[this.quality].particles);
      this.scene.add(this.precip.object);
    }

    // camera range: everything past the fog is invisible anyway (an original sky box may need more); with the
    // original environment the frame pipeline sets the sky / main pass ranges per frame (orig/environment.ts)
    const cam = this.rig.camera;
    cam.far = Math.max(400, env.fogFar * 1.08 + 50, view?.cameraFar ?? 0);
    cam.near = 0.1;
    cam.updateProjectionMatrix();
    const envC = view?.component('environment');
    const origEnv = envC instanceof OrigEnvironment ? envC : null;
    if (view && origEnv) {
      this.origPipeline ??= new OrigFramePipeline(this.renderer);
      this.origPipeline.setEnvironment(origEnv, origPassOptions(view.group, view.cameraFar));
    }
    this.rig.groundAt = groundAt;
    this.rig.invalidate();
    for (const e of this.cars.values()) {
      e.visual.setNight(this.night);
      e.effects?.reset();
      this.clearCarLightmap(e);
    }
    this.lastPlayerStep = -1;
    this.warmup = AUTO_WARMUP_S;
    this.slowTime = 0;
    // the effects (data, sprite / skid textures) are part of the load, not something that lands in the countdown or the
    // race; the programs, textures and buffers are warmed by warmUp() once the cars exist
    if (!(await capped(effectsLoad, EFFECTS_LOAD_CAP_MS))) this.effectsStalled = true;
  }

  /**
   * A restart of the loaded stage (main.ts restarts the race in place): clears what the last run left behind (dust /
   * spray particles, skid marks, the cars' emitter state) and re-snaps the camera, as loadStage() does, while the
   * stage view, its textures and the car visuals stay loaded.
   */
  resetStageEffects(): void {
    this.particles.clear();
    this.skids.clear();
    for (const e of this.cars.values()) e.effects?.reset();
    this.rig.invalidate();
    this.lastPlayerStep = -1;
  }

  /** The sun casts three's shadow map only where something receives it: the quality preset allows shadows and the
   *  stage is not an original view with its track (track, objects, effects and the original car are custom shaders
   *  without shadow chunks; the original's drop shadow comes from OrigCarFx). */
  private sunShadowWanted(): boolean {
    return QUALITY[this.quality].shadows && !this.origView?.hasTrack;
  }

  /** Gamma-space output for the original look (bytes in = bytes out, like D3D8), ACES + sRGB otherwise. */
  private setOriginalOutput(original: boolean): void {
    this.renderer.toneMapping = original ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = original ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
  }

  private disposeStage(): void {
    // the original view owns (and disposes) its own subtree; detach it before the generic traversal (its car
    // lightmaps go with it: unbind them from the cars first)
    for (const e of this.cars.values()) this.clearCarLightmap(e);
    this.origView?.dispose();
    this.origView = null;
    if (this.stageRoot) {
      this.scene.remove(this.stageRoot);
      const mats = new Set<THREE.Material>();
      this.stageRoot.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        // scenery geometry is cached module-wide (instanced): release only the instance buffers
        if (o.name.startsWith('scenery:')) (o as THREE.InstancedMesh).dispose();
        else mesh.geometry?.dispose();
        const m = mesh.material;
        for (const mm of Array.isArray(m) ? m : [m]) if (mm && !mm.name.startsWith('shared:')) mats.add(mm);
      });
      for (const m of mats) m.dispose();
      this.stageRoot = null;
    }
    this.terrainChunks = [];
    this.sceneryBatches = [];
    this.precip?.dispose();
    this.precip = null;
    this.envMap?.dispose();
    this.envMap = null;
    this.scene.environment = null;
  }

  // ----------------------------------------------------------------------------------------- cars

  /**
   * Add a car. The promise resolves once the car's final visual is in place (the original car attached, or the
   * procedural fallback decided: no assets, `?orig=0`, a failed load, the car removed meanwhile); it never rejects.
   * main.ts awaits it with the stage load, as the original loads the car with the race.
   */
  addCar(id: string, archetype: ArchetypeId, opts: AddCarOptions = {}): Promise<void> {
    this.removeCar(id);
    const ghost = !!opts.ghost;
    const visual = new CarVisual(archetype, { ghost, livery: opts.livery, night: this.night });
    this.scene.add(visual.root);
    const player = opts.player ?? ![...this.cars.values()].some((c) => c.player);
    if (player) for (const c of this.cars.values()) c.player = false;
    const effects = ghost ? null : new CarEffects(this.particles, this.skids, opts.origCar);
    const entry: CarEntry = { visual, effects, ghost, player, ai: !!opts.ai, carIndex: opts.carIndex ?? 0, lodLevel: null, origScope: null, lmPatch: -1, lmTex: null, seen: -1 };
    this.cars.set(id, entry);
    if (player) this.rig.invalidate();
    // the car's own effects data + drop shadow are part of the car: it is not ready before they are (capped)
    const fx = effects
      ? capped(effects.whenReady(), EFFECTS_LOAD_CAP_MS).then((ok) => {
          if (!ok) this.effectsStalled = true;
        })
      : Promise.resolve();
    if (opts.origCar) return Promise.all([this.loadOrigCar(id, entry, opts.origCar), fx]).then(() => undefined);
    if (player) this.applyCarCamera(null, null); // an archetype car: the generic §5.3 positions
    return fx;
  }

  /** docs/ASSETS.md §10 gap 2: the original car replaces the procedural one once loaded (cars builder). The
   *  procedural CarVisual stays hidden until then and shows only as the fallback; a result for a car removed /
   *  re-added meanwhile is dropped. The player car brings its own camera positions (carCameraTuning). */
  private loadOrigCar(id: string, entry: CarEntry, carName: string): Promise<void> {
    const scope = this.textureStore.scope();
    const stageId = this.stage && isPortedStageId(this.stage.id) ? this.stage.id : null;
    entry.visual.setOriginalPending(true);
    return loadOriginalCar(carName, { stageId, textures: scope, ghost: entry.ghost })
      .catch((e) => {
        warnOnce(`render-orig-car:${carName}`, `[render] original car ${carName} failed: ${(e as Error)?.message ?? e}`);
        return null;
      })
      .then((orig) => {
        const current = this.cars.get(id) === entry;
        if (current) entry.visual.setOriginalPending(false);
        if (!orig || !current) {
          orig?.dispose();
          scope.dispose();
          if (current && entry.player) this.applyCarCamera(null, null); // the procedural stand-in: generic camera
          return;
        }
        orig.setNight(this.night);
        if (entry.lodLevel !== null) orig.setLod(entry.lodLevel); // PHASE 2: a level forced before the visual arrived
        entry.visual.setOriginal(orig, this.rig.camera);
        entry.origScope = scope;
        if (entry.player) this.applyCarCamera(carName, carCameraTuning(orig.info));
      });
  }

  /**
   * The player car's camera positions (MECHANICS_SPEC §5.3): the original reads every view from the player car's
   * own <Car>CarCamera entries; makeCameraTuning() holds ImprezaWRX's, used for the archetype cars. Only the
   * per-car fields change (bumper / bonnet / look-back / chase / tether); FOV, rates and other tuning stay. A
   * reload of the same car keeps the (possibly tuned) positions.
   */
  private applyCarCamera(carName: string | null, patch: DeepPartial<CameraTuning> | null): void {
    if (carName === this.cameraCar) return;
    const base = makeCameraTuning();
    deepMergeInto(this.cameraTuning, {
      bumperPos: base.bumperPos,
      bonnetPos: base.bonnetPos,
      lookBackPos: base.lookBackPos,
      chase: base.chase,
      tether: base.tether,
    });
    if (patch) deepMergeInto(this.cameraTuning, patch);
    this.cameraCar = carName;
    this.cameraPatch = patch;
  }

  /** The untuned camera of the current player car (§5.3 defaults + its own CarCamera positions): main.ts "reset to
   *  original". */
  defaultCameraTuning(): CameraTuning {
    const t = makeCameraTuning();
    if (this.cameraPatch) deepMergeInto(t, this.cameraPatch);
    return t;
  }

  /**
   * PHASE 2 (ai-race builder): force the model LOD level of a car (the original's `othercarlodlevel` for opponents,
   * `playercarlodlevel` for the player, console vars of FUN_00694f50; ai.md §9); null = the renderer's own choice.
   * Forces the original car's LOD set (0 = Mesh/Cars … 3 = Mesh/Cars_3; wheels switch with it) now, or as soon as its
   * visual is attached. The levels themselves (video-quality table, FUN_00694f50 → FUN_00491ce0) are not in the
   * archives, so nothing sets them by default: every car, AI included, keeps the camera-distance LOD (docs/orig/cars.md).
   */
  setCarLod(id: string, level: number | null): void {
    const e = this.cars.get(id);
    if (!e) return;
    e.lodLevel = level;
    e.visual.original?.setLod(level);
  }

  removeCar(id: string): void {
    const e = this.cars.get(id);
    if (!e) return;
    e.visual.dispose(); // disposes the original visual too (then its texture scope)
    e.origScope?.dispose();
    e.effects?.dispose();
    this.cars.delete(id);
  }

  // ----------------------------------------------------------------------------------------- warm-up

  /**
   * GPU warm-up behind the loading screen (main.ts awaits it after the stage, every car and the effects exist, before the
   * race can start), so nothing is compiled, uploaded or allocated for the first time while driving:
   *   1. the effects / drop shadows requested so far have landed (capped);
   *   2. every texture any material references, in the stage scene and in the extra scenes of the original frame
   *      (gamma blit, flare quads, flare mask), is uploaded (initTexture, in slices);
   *   3. every program is compiled for the state the real pass uses (the original frame renders into a render target:
   *      the same kind of target is bound), invisible objects included (car LODs / wheel sets, ghost variant, flare
   *      sprites, particle batches, flare meshes), in parallel where KHR_parallel_shader_compile exists;
   *   4. one hidden draw of the whole scene (everything shown, nothing culled, the original frame's passes) into a tiny
   *      offscreen target creates the geometry buffers / VAOs, the shadow map and the frame targets; the visibility
   *      and culling flags are restored before anything else can see them.
   * The next rendered frame is unchanged by it. An adaptive step-down that was waiting (applyPendingQuality) is applied
   * first. Procedural stages (no original view) only get steps 1-3: their programs use the screen's tone mapping, which no
   * offscreen draw can reproduce. Never rejects; `debugInfo().warmUpMs` is its last cost.
   */
  warmUp(): Promise<void> {
    const job = this.warmJob
      .then(() => this.runWarmUp())
      .catch((e) => warnOnce('render-warmup', `[render] GPU warm-up failed: ${(e as Error)?.message ?? e}`));
    this.warmJob = job;
    return job;
  }

  private async runWarmUp(): Promise<void> {
    if (!this.stage || this.disposed) return;
    const t0 = performance.now();
    const seq = this.loadSeq;
    this.stepPendingQuality();
    if (!this.effectsStalled) await capped(this.particles.settled(), EFFECTS_LOAD_CAP_MS);
    if (seq !== this.loadSeq) return;
    await this.warmTextures(seq);
    if (seq !== this.loadSeq) return;
    await this.warmPrograms();
    if (seq !== this.loadSeq) return;
    this.warmDraw();
    this.warmMs = performance.now() - t0;
  }

  /** The scenes a frame renders: the stage scene, and with the original frame its extra scenes (blit, flares, mask). */
  private frameScenes(): THREE.Object3D[] {
    return this.origPipeline?.active ? [this.scene, ...this.origPipeline.extraScenes] : [this.scene];
  }

  private warmTarget(): THREE.WebGLRenderTarget {
    return (this.warmRt ??= new THREE.WebGLRenderTarget(16, 16, { depthBuffer: true, stencilBuffer: false }));
  }

  private async warmTextures(seq: number): Promise<void> {
    const textures = new Set<THREE.Texture>();
    for (const sc of this.frameScenes()) collectTextures(sc, textures);
    let sliceStart = performance.now();
    for (const t of textures) {
      // never uploaded textures (version 0) and ones without data have nothing to upload yet
      if (!t.version || (!t.image && !(t as THREE.CompressedTexture).mipmaps?.length)) continue;
      try {
        this.renderer.initTexture(t);
      } catch {
        /* uploaded on first use as before */
      }
      if (performance.now() - sliceStart > WARM_SLICE_MS) {
        await yieldToBrowser();
        if (seq !== this.loadSeq || this.disposed) return;
        sliceStart = performance.now();
      }
    }
  }

  private async warmPrograms(): Promise<void> {
    const r = this.renderer;
    const cam = this.rig.camera;
    const prev = r.getRenderTarget();
    const jobs: Promise<unknown>[] = [];
    try {
      // an original view renders into a render target (the frame pipeline), a procedural stage to the screen
      r.setRenderTarget(this.origView ? this.warmTarget() : null);
      for (const sc of this.frameScenes()) {
        try {
          // without KHR_parallel_shader_compile, compileAsync only polls a blocking compile (and three warns): compile directly
          const parallel = typeof r.compileAsync === 'function' && r.extensions.has('KHR_parallel_shader_compile');
          jobs.push(parallel ? r.compileAsync(sc, cam).catch(() => undefined) : Promise.resolve(r.compile(sc, cam)));
        } catch {
          /* compiled on first use as before */
        }
      }
    } finally {
      r.setRenderTarget(prev);
    }
    await capped(Promise.all(jobs), WARM_COMPILE_CAP_MS);
  }

  private warmDraw(): void {
    if (!this.origView) return;
    const r = this.renderer;
    const rt = this.warmTarget();
    const cam = this.rig.camera;
    const shown: { o: THREE.Object3D; visible: boolean; culled: boolean }[] = [];
    this.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) return; // the light set decides the programs: leave it as the frame has it
      shown.push({ o, visible: o.visible, culled: o.frustumCulled });
      o.visible = true;
      o.frustumCulled = false;
    });
    const prev = r.getRenderTarget();
    try {
      if (this.origPipeline?.active) this.origPipeline.warm(this.scene, cam, rt);
      else {
        r.setRenderTarget(rt);
        r.render(this.scene, cam);
      }
      r.getContext().finish(); // the work lands now, not in the first frames
    } catch (e) {
      warnOnce('render-warmdraw', `[render] GPU warm-up draw failed: ${(e as Error)?.message ?? e}`);
    } finally {
      for (const x of shown) {
        x.o.visible = x.visible;
        x.o.frustumCulled = x.culled;
      }
      r.setRenderTarget(prev);
    }
  }

  // ----------------------------------------------------------------------------------------- frame

  update(frameDt: number, _alpha: number, cars: readonly CarRenderState[]): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    if (this.resizePending) this.resize();
    this.frame++;
    if (frameDt > 0) this.fps += (1 / frameDt - this.fps) * 0.05;
    let target: CarRenderState | null = null;
    let simDt = 0;
    for (const c of cars) {
      const e = this.cars.get(c.id);
      if (!e) continue;
      e.seen = this.frame;
      e.visual.update(c, frameDt);
      if (!e.ghost) this.updateCarLightmap(e, c);
      e.effects?.update(c.telemetry, c);
      if (c.player || (!target && e.player)) {
        target = c;
        const sc = c.telemetry.stepCount;
        simDt = this.lastPlayerStep < 0 || c.justReset ? 0 : Math.max(0, Math.min(0.25, (sc - this.lastPlayerStep) * DT));
        this.lastPlayerStep = sc;
      }
    }
    if (!target) simDt = frameDt;

    // camera
    if (target) {
      const pe = this.cars.get(target.id);
      this.tmpV.set(target.pos.x, target.pos.y, target.pos.z);
      applyThreeQuat(this.tmpQ, target.quat);
      this.rig.update(frameDt, { pos: this.tmpV, quat: this.tmpQ, tel: target.telemetry, justReset: target.justReset });
      pe?.visual.setVisible(!this.rig.hideCar);
      // a ghost car added ahead of its first state (main.ts loads it with the race) stays hidden until it has one
      for (const e of this.cars.values()) if (e !== pe) e.visual.setVisible(!e.ghost || e.seen === this.frame);
      const v = target.telemetry.vel;
      this.carVel.set(v?.x ?? 0, v?.y ?? 0, v?.z ?? 0);
      this.followShadow(this.tmpV, this.tmpQ);
      if (this.night) this.followHeadlight(this.tmpV, this.tmpQ);
    }
    const cam = this.rig.camera;
    if (this.debugCam) {
      const d = this.debugCam;
      if (d.relative && target) {
        // offset in the player car's local frame (three: forward -Z), looking at the car + target offset
        const base = this.tmpV.set(target.pos.x, target.pos.y, target.pos.z);
        applyThreeQuat(this.tmpQ, target.quat);
        cam.position.copy(d.pos).applyQuaternion(this.tmpQ).add(base);
        cam.lookAt(this.tmpV2.copy(d.target).applyQuaternion(this.tmpQ).add(base));
      } else {
        cam.position.copy(d.pos);
        cam.lookAt(d.target);
      }
      this.cars.get(target?.id ?? '')?.visual.setVisible(true);
    }
    this.sky.follow(cam);
    const lod = QUALITY[this.quality].lod;
    updateTerrainLod(this.terrainChunks, cam.position, lod);
    updateSceneryLod(this.sceneryBatches, cam.position, lod);
    this.origView?.update(cam, frameDt, lod);
    this.particles.update(simDt, cam);
    this.skids.flush();
    this.precip?.update(frameDt, cam.position, this.carVel);
    // an original environment: its pass order + gamma ramp (orig/environment.ts OrigFramePipeline)
    if (this.origPipeline?.active) this.origPipeline.render(this.scene, cam);
    else this.renderer.render(this.scene, cam);
    if (typeof performance !== 'undefined') this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.1;
    if (this.autoQuality && frameDt > 0) this.adaptQuality(frameDt);
  }

  /** t3 of an original car: the projected lightmap of the track patch under it (white off the track / without an
   *  original view). While a newly entered patch's texture loads, the previous patch's stays bound. */
  private updateCarLightmap(e: CarEntry, c: CarRenderState): void {
    const o = e.visual.original;
    if (!o) return;
    const smp = this.carLightmaps ? (this.origView?.carLightmapAt(c.pos.x, c.pos.y, c.pos.z, e.lmPatch) ?? null) : null;
    if (!smp) {
      if (e.lmPatch !== -1 || e.lmTex) this.clearCarLightmap(e);
      return;
    }
    e.lmPatch = smp.patch;
    if (smp.texture) {
      e.lmTex = smp.texture;
      o.setLightmap(smp.texture, smp.proj);
    }
  }

  private clearCarLightmap(e: CarEntry): void {
    e.lmPatch = -1;
    e.lmTex = null;
    e.visual.original?.setLightmap(null);
  }

  private followShadow(pos: THREE.Vector3, quat: THREE.Quaternion): void {
    if (!this.sun.castShadow && !this.stage) return;
    const env = this.stage?.environment;
    // an original view lights its procedural content with the original sun (origUniforms.sunDir, three space)
    const sd = this.origView ? this.tmpV2.copy(origUniforms.sunDir.value) : env ? this.tmpV2.set(env.sunDir.x, env.sunDir.y, env.sunDir.z) : this.tmpV2.set(0.45, 0.8, 0.4);
    if (sd.lengthSq() < 1e-6) sd.set(0, 1, 0);
    sd.normalize();
    if (sd.y < 0.15) sd.y = 0.15; // keep shadows sane for very low suns
    sd.normalize();
    // centre the shadow box a little ahead of the car (where the camera looks)
    const fwd = this.sFwd.set(0, 0, -1).applyQuaternion(quat);
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) fwd.normalize();
    const box = QUALITY[this.quality].shadowBox;
    const c = this.sCentre.copy(pos).addScaledVector(fwd, box * 0.35);
    // texel snapping in light space to stop shadow shimmering (lightRot is a pure rotation: inverse = transpose)
    const texel = (2 * box) / this.sun.shadow.mapSize.x;
    const lightRot = this.sRot.lookAt(ORIGIN, this.sNeg.copy(sd).negate(), Y_UP);
    c.applyMatrix4(this.sInv.copy(lightRot).transpose());
    c.x = Math.round(c.x / texel) * texel;
    c.y = Math.round(c.y / texel) * texel;
    c.applyMatrix4(lightRot);
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(sd, 200);
    this.sun.target.updateMatrixWorld();
  }

  private followHeadlight(pos: THREE.Vector3, quat: THREE.Quaternion): void {
    this.headlight.position.set(0, 0.35, -1.6).applyQuaternion(quat).add(pos);
    this.headlight.target.position.set(0, -1.2, -22).applyQuaternion(quat).add(pos);
    this.headlight.target.updateMatrixWorld();
  }

  private adaptQuality(frameDt: number): void {
    if (this.pendingQuality) return; // decided; waits for a safe point
    if (frameDt > AUTO_STALL_DT) {
      // a stall (GC, a load, a tab switch) says nothing about the GPU: out of the average, unless the device is slow throughout
      if (++this.stallRun < AUTO_STALL_RUN) return;
      frameDt = AUTO_STALL_DT;
    } else this.stallRun = 0;
    // ~0.5 s EMA of the real frame time; single hitches barely move it
    this.frameEma += (Math.min(frameDt, 0.1) - this.frameEma) * Math.min(1, frameDt * 2);
    if (this.warmup > 0) {
      this.warmup -= frameDt;
      return;
    }
    if (this.frameEma > 1 / AUTO_MIN_FPS) this.slowTime += frameDt;
    else this.slowTime = Math.max(0, this.slowTime - frameDt);
    if (this.slowTime > AUTO_SLOW_S && this.quality !== 'low') {
      // never switch the pipeline (pixel ratio, shadow programs, targets) under a running race: applyPendingQuality
      this.pendingFps = Math.round(1 / this.frameEma);
      this.pendingQuality = this.quality === 'high' ? 'medium' : 'low';
      this.slowTime = 0;
    }
  }

  // ----------------------------------------------------------------------------------------- cameras

  /** Read-only three.js resource counters for profiling (tools/frame-profile.mjs via the test API, window.__rally.getRenderInfo). */
  renderInfo(names = false): { programs: number; textures: number; geometries: number; calls: number; triangles: number; programNames?: string[] } {
    const i = this.renderer.info;
    return {
      ...(names ? { programNames: (i.programs ?? []).map((p) => `${p.name}#${p.id}`) } : {}),
      programs: i.programs?.length ?? 0,
      textures: i.memory.textures,
      geometries: i.memory.geometries,
      calls: i.render.calls,
      triangles: i.render.triangles,
    };
  }

  /** The render camera (read-only; e.g. the audio listener, CamListener.con). */
  get camera(): THREE.PerspectiveCamera {
    return this.rig.camera;
  }

  setCameraMode(mode: CameraMode): void {
    this.rig.setMode(mode);
  }

  nextCamera(): CameraMode {
    return this.rig.next();
  }

  getCameraMode(): CameraMode {
    return this.rig.mode;
  }

  lookBack(on: boolean): void {
    this.rig.lookingBack = on;
  }

  setCameraTuning(partial: DeepPartial<CameraTuning>): void {
    deepMergeInto(this.cameraTuning, partial);
    const cam = this.rig.camera;
    cam.fov = this.cameraTuning.fov;
    cam.updateProjectionMatrix();
  }

  // ----------------------------------------------------------------------------------------- misc

  /** Window resize / ResizeObserver: one pass per frame (update() or the next animation frame), however many fire. */
  private queueResize(): void {
    if (this.resizePending || this.disposed) return;
    this.resizePending = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this.resizePending && !this.disposed && this.resize());
    else this.resize();
  }

  /** Re-read the container size and the display's pixel ratio; nothing happens (no drawing-buffer reallocation) when
   *  neither changed. */
  resize(): void {
    this.resizePending = false;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const pr = this.targetPixelRatio();
    if (w === this.sizeW && h === this.sizeH && pr === this.sizePr) return;
    if (pr !== this.sizePr) this.renderer.setPixelRatio(pr);
    this.sizeW = w;
    this.sizeH = h;
    this.sizePr = pr;
    this.renderer.setSize(w, h, false);
    const cam = this.rig.camera;
    cam.aspect = w / Math.max(1, h);
    cam.updateProjectionMatrix();
  }

  stats(): RenderStats {
    const info = this.renderer.info.render;
    return { fps: this.fps, drawCalls: info.calls, triangles: info.triangles, frame: this.frame };
  }

  /**
   * Tools only (not part of the contract): override the camera. relative = true → `pos` / `target` are in the
   * player car's local frame (three: x right, y up, forward -Z). null restores the normal rig.
   */
  setDebugCamera(pos: { x: number; y: number; z: number } | null, target?: { x: number; y: number; z: number }, relative = true): void {
    if (!pos) {
      this.debugCam = null;
      this.rig.invalidate();
      return;
    }
    const t = target ?? { x: 0, y: 0, z: 0 };
    this.debugCam = { pos: new THREE.Vector3(pos.x, pos.y, pos.z), target: new THREE.Vector3(t.x, t.y, t.z), relative };
  }

  /** Extra diagnostics (not part of the contract). */
  debugInfo(): Record<string, unknown> {
    const cam = this.rig.camera;
    return {
      quality: this.quality,
      autoQuality: this.autoQuality,
      pendingQuality: this.pendingQuality,
      warmUpMs: +this.warmMs.toFixed(1),
      pixelRatio: this.renderer.getPixelRatio(),
      cpuMs: +this.cpuMs.toFixed(2),
      particles: this.particles.alive,
      skidSegments: this.skids.segments,
      cameraMode: this.rig.mode,
      // original car whose own CarCamera positions the rig uses (null = the generic §5.3 table)
      cameraCar: this.cameraCar,
      flipped: this.rig.flipped,
      camera: { x: +cam.position.x.toFixed(2), y: +cam.position.y.toFixed(2), z: +cam.position.z.toFixed(2), fov: cam.fov },
      programs: this.renderer.info.programs?.length ?? 0,
      // loaded original parts (+ 'effects' while the original car effects are active) and the shared uniforms
      orig: this.origView ? { parts: [...this.origView.parts, ...(this.particles.orig.active ? ['effects'] : [])], hasTrack: this.origView.hasTrack } : null,
      origUniforms: this.origUniformsInfo(),
      s3tc: this.textureStore.s3tc,
      // original car visuals (cars builder): id → original car name (null = procedural archetype car) + LOD set
      // (+ the stage whose cars.json it uses, and the track patch whose lightmap it is lit by; −1 = none / white)
      origCars: [...this.cars].map(([id, e]) => ({
        id,
        car: e.visual.original?.carName ?? null,
        lod: e.visual.original?.lod ?? null,
        stage: e.visual.original?.stageId ?? null,
        lightmapPatch: e.lmTex ? e.lmPatch : -1,
      })),
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
    };
  }

  /** The shared original uniforms (what an original car / material is lit and fogged with), rounded. */
  private origUniformsInfo(): Record<string, unknown> {
    const u = origUniforms;
    const v = (x: THREE.Vector2 | THREE.Vector3) => x.toArray().map((n) => +n.toFixed(4));
    const f = u.trackFog;
    return {
      carLight: v(u.carLight.value),
      carAmbient: v(u.carAmbient.value),
      sunDir: v(u.sunDir.value),
      trackFog: { enabled: f.enabled.value, color: v(f.color.value), start: f.start.value, end: f.end.value, clamp: f.clamp.value },
      carLightmap: { min: v(u.carLightmapMin.value), max: v(u.carLightmapMax.value), clamp: v(u.carLightmapClamp.value) },
      particleLightmapMin: v(u.particleLightmapMin.value),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.warmRt?.dispose();
    this.warmRt = null;
    window.removeEventListener('resize', this.onResize);
    this.resizeObs?.disconnect();
    for (const id of [...this.cars.keys()]) this.removeCar(id);
    this.disposeStage();
    this.origPipeline?.dispose();
    this.textureStore.dispose();
    this.particles.dispose();
    this.skids.dispose();
    this.sky.dispose();
    this.renderer.dispose();
    this.domElement.remove();
  }
}
