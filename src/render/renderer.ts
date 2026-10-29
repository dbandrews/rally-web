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
 *     addCar(id: string, archetype: ArchetypeId, opts?: AddCarOptions): void
 *     removeCar(id: string): void
 *     update(frameDt: number, alpha: number, cars: readonly CarRenderState[]): void   // renders a frame
 *     setCameraMode(mode: CameraMode): void; nextCamera(): CameraMode; getCameraMode(): CameraMode
 *     lookBack(on: boolean): void
 *     setCameraTuning(partial: DeepPartial<CameraTuning>): void
 *     resize(): void; stats(): RenderStats; dispose(): void
 *   makeCameraTuning(): CameraTuning                  // §5.3 defaults (used by main.ts "reset to original")
 *
 * Inputs are THREE space already (CarRenderState.pos/quat are interpolated by main.ts). Car mesh faces -Z.
 * Wheel conventions: src/core/space.ts (rotation.y = -steerAngle, rotation.x = -spinAngle).
 * Camera constants are "per 60 Hz frame": use perFrameK(k, frameDt) from src/core/math.ts.
 *
 * Extras (optional for the integrator): setQuality('low'|'medium'|'high'), getQuality(), setAutoQuality(on),
 * getAutoQuality(), debugInfo(), setDebugCamera(); window.__rallyRenderer points at the instance (tools).
 * URL: ?quality=low|medium|high pins a preset; default on a real GPU is adaptive (start 'high', step down while
 * the smoothed frame rate stays < 50 fps); CPU rasterisers (headless SwiftShader) default to 'low', pr 0.6.
 * ?pr=<pixel ratio>, ?aa=0|1 (MSAA).
 *
 * Module map (src/render/): cameraRig (§5.3), sky (dome + env map), terrain, road, scenery (+ gates),
 * sceneryModels, carModel (lofted bodies), livery (canvas liveries), carVisual (wheels / lights),
 * effects (particles, skid marks, per-car emitters), weather, textures (procedural canvases), geomUtil,
 * heightSampler.
 */
import * as THREE from 'three';
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
import { buildRoad } from './road';
import { buildScenery, buildStageLabels, updateSceneryLod, type SceneryBatch } from './scenery';
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

/** Adaptive quality: step down when the smoothed frame rate stays below this for AUTO_SLOW_S seconds. */
const AUTO_MIN_FPS = 50;
const AUTO_SLOW_S = 2.5;
/** No adaptive decisions for this long after a stage load / quality change (shader + upload hitches). */
const AUTO_WARMUP_S = 3;

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
  private readonly onResize = () => this.resize();
  private readonly resizeObs: ResizeObserver | null = null;
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

  constructor(container: HTMLElement) {
    this.container = container;
    this.softwareGL = isSoftwareGL();
    const aaQ = urlParam('aa');
    const antialias = aaQ !== null ? aaQ !== '0' : !this.softwareGL;
    this.renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
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
    else if (q === 'auto' || !this.softwareGL) this.autoQuality = true;
    else this.quality = 'low';
    const pr = Number(urlParam('pr'));
    if (Number.isFinite(pr) && pr > 0.25 && pr <= 3) this.pixelRatioOverride = pr;
    else if (this.softwareGL && !q) this.pixelRatioOverride = 0.6; // headless tooling: favour frame rate
    this.applyQuality();

    // tooling hook (render diagnostics from Playwright: stats(), debugInfo(), setQuality(), setDebugCamera())
    (window as unknown as { __rallyRenderer?: GameRenderer }).__rallyRenderer = this;
    window.addEventListener('resize', this.onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.resize());
      this.resizeObs.observe(container);
    }
    this.resize();
  }

  // ----------------------------------------------------------------------------------------- quality

  /** Pin a quality preset (turns adaptive quality off unless `keepAuto`). */
  setQuality(q: RenderQuality, keepAuto = false): void {
    this.quality = q;
    if (!keepAuto) this.autoQuality = false;
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
    this.warmup = AUTO_WARMUP_S;
    this.slowTime = 0;
  }

  getAutoQuality(): boolean {
    return this.autoQuality;
  }

  private applyQuality(): void {
    const p = QUALITY[this.quality];
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.renderer.setPixelRatio(this.pixelRatioOverride ?? Math.min(dpr, p.pixelRatio));
    this.renderer.shadowMap.enabled = p.shadows;
    this.sun.castShadow = p.shadows;
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
    // materials need a recompile when shadows toggle
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
    });
    this.resize();
  }

  // ----------------------------------------------------------------------------------------- stage

  loadStage(stage: Stage): void {
    this.disposeStage();
    this.stage = stage;
    const env = stage.environment;
    const root = new THREE.Group();
    root.name = `stage:${stage.id}`;
    const terrain = buildTerrain(stage);
    root.add(terrain.group);
    this.terrainChunks = terrain.chunks;
    root.add(buildRoad(stage, terrain.sampler));
    const scenery = buildScenery(stage, terrain.sampler);
    this.sceneryBatches = scenery.batches;
    root.add(scenery.group);
    if (stage.labels?.length) root.add(buildStageLabels(stage, terrain.sampler));
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
    this.particles.setEnvironment(env);
    this.particles.clear();
    this.skids.clear();
    if (env.weather === 'snow' || env.weather === 'rain' || env.weather === 'dust') {
      this.precip = new Precipitation(env.weather, QUALITY[this.quality].particles);
      this.scene.add(this.precip.object);
    }

    // camera range: everything past the fog is invisible anyway
    const cam = this.rig.camera;
    cam.far = Math.max(400, env.fogFar * 1.08 + 50);
    cam.near = 0.1;
    cam.updateProjectionMatrix();
    const sampler = terrain.sampler;
    this.rig.groundAt = (x, z) => sampler.heightAt(x, z);
    this.rig.invalidate();
    for (const e of this.cars.values()) {
      e.visual.setNight(this.night);
      e.effects?.reset();
    }
    this.lastPlayerStep = -1;
    this.warmup = AUTO_WARMUP_S;
    this.slowTime = 0;
    // compile shaders now rather than on the first driving frame
    try {
      this.renderer.compile(this.scene, cam);
    } catch {
      /* optional */
    }
  }

  private disposeStage(): void {
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

  addCar(id: string, archetype: ArchetypeId, opts: AddCarOptions = {}): void {
    this.removeCar(id);
    const ghost = !!opts.ghost;
    const visual = new CarVisual(archetype, { ghost, livery: opts.livery, night: this.night });
    this.scene.add(visual.root);
    const player = opts.player ?? ![...this.cars.values()].some((c) => c.player);
    if (player) for (const c of this.cars.values()) c.player = false;
    const effects = ghost ? null : new CarEffects(this.particles, this.skids);
    this.cars.set(id, { visual, effects, ghost, player });
    if (player) this.rig.invalidate();
  }

  removeCar(id: string): void {
    const e = this.cars.get(id);
    if (!e) return;
    e.visual.dispose();
    this.cars.delete(id);
  }

  // ----------------------------------------------------------------------------------------- frame

  update(frameDt: number, _alpha: number, cars: readonly CarRenderState[]): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.frame++;
    if (frameDt > 0) this.fps += (1 / frameDt - this.fps) * 0.05;
    let target: CarRenderState | null = null;
    let simDt = 0;
    for (const c of cars) {
      const e = this.cars.get(c.id);
      if (!e) continue;
      e.visual.update(c, frameDt);
      e.effects?.update(c.telemetry);
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
      for (const e of this.cars.values()) if (e !== pe) e.visual.setVisible(true);
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
    this.particles.update(simDt);
    this.skids.flush();
    this.precip?.update(frameDt, cam.position, this.carVel);
    this.renderer.render(this.scene, cam);
    if (typeof performance !== 'undefined') this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.1;
    if (this.autoQuality && frameDt > 0) this.adaptQuality(frameDt);
  }

  private followShadow(pos: THREE.Vector3, quat: THREE.Quaternion): void {
    if (!this.sun.castShadow && !this.stage) return;
    const env = this.stage?.environment;
    const sd = env ? this.tmpV2.set(env.sunDir.x, env.sunDir.y, env.sunDir.z) : this.tmpV2.set(0.45, 0.8, 0.4);
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
    // ~0.5 s EMA of the real frame time; single hitches (GC, tab switch: frameDt is clamped to 0.2) barely move it
    this.frameEma += (Math.min(frameDt, 0.1) - this.frameEma) * Math.min(1, frameDt * 2);
    if (this.warmup > 0) {
      this.warmup -= frameDt;
      return;
    }
    if (this.frameEma > 1 / AUTO_MIN_FPS) this.slowTime += frameDt;
    else this.slowTime = Math.max(0, this.slowTime - frameDt);
    if (this.slowTime > AUTO_SLOW_S && this.quality !== 'low') {
      const fps = Math.round(1 / this.frameEma);
      this.setQuality(this.quality === 'high' ? 'medium' : 'low', true);
      console.info(`[render] ${fps} fps → quality ${this.quality}`);
    }
  }

  // ----------------------------------------------------------------------------------------- cameras

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

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
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
      pixelRatio: this.renderer.getPixelRatio(),
      cpuMs: +this.cpuMs.toFixed(2),
      particles: this.particles.alive,
      skidSegments: this.skids.segments,
      cameraMode: this.rig.mode,
      flipped: this.rig.flipped,
      camera: { x: +cam.position.x.toFixed(2), y: +cam.position.y.toFixed(2), z: +cam.position.z.toFixed(2), fov: cam.fov },
      programs: this.renderer.info.programs?.length ?? 0,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
    };
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.resizeObs?.disconnect();
    for (const id of [...this.cars.keys()]) this.removeCar(id);
    this.disposeStage();
    this.particles.dispose();
    this.skids.dispose();
    this.sky.dispose();
    this.renderer.dispose();
    this.domElement.remove();
  }
}
