/**
 * src/render/orig/car.ts — the ORIGINAL cars (OWNED BY THE CARS BUILDER): real meshes, liveries, wheels, lights.
 *
 * REQUIRED EXPORTS (keep the signatures):
 *   interface OriginalCarVisual, interface OriginalCarOptions
 *   loadOriginalCar(carName: string, opts?: OriginalCarOptions): Promise<OriginalCarVisual | null>
 * Extras: loadCarInfo(name) (cars.json: display name, specs, menu icon …), CarInfo, carIconUrl(name), clearCarCache(),
 *   carCameraTuning(info) (the car's own CarCamera positions as a CameraTuning patch; the renderer applies it for the
 *   player car).
 *
 * Data (tools/assets/parts/cars.py, research/formats/cars.md + Verification):
 *   cars/<Name>/cars.json          names (LocaleEnglish), specs, wheels (bundle B, camber / toe / yaw, spring data),
 *                                  lens flares, exhaust, drivers, hull, drop shadow, menu env cube, icon, camera
 *                                  (the 25 <Car>CarCamera setCamPosition entries)
 *   cars/<Name>/cars/meshes.json   per LOD set (Mesh/Cars, Cars_1..3) Body + Interior materials; the two wheel meshes
 *   cars/<Name>/cars/lod<N>.bin, wheels.bin   THREE-space vertex / index blocks
 *   stages/<id>/cars.json          per-stage CarEnvmap cube, CarDirtmap, car.* material settings
 *   No stageId (menu, procedural stage, stage without the part) → the menu cube `menu/texture/carenvmap`.
 *
 * Assembly (cars.md §4): root = the physics body origin (centre of mass) in the three car frame (forward −Z); Body
 * and Interior at the origin, no offset. Wheel w (0 FL, 1 FR, 2 RR, 3 RL) per frame, FUN_006c8ef0 [V]:
 *   ext'  = max(0.85, ext + jitter),  jitter = amp(material)·speed·0.0002·sin²(35·t_w)   (contact only)
 *   hub   = (B.x + steerOffX, B.y − ext'·L, B.z + steerOffZ)  SIM;  steerOff = ((1 − cos s)·k, sin s·k),
 *           k = ±steerTweak on the fronts (MECHANICS_SPEC §2.6 W3)
 *   rot   = camber (about body z, outermost) · yaw (toe + visual steer + template yaw 180° on the right) · spin
 *           (about the axle x, innermost); three form (S·M·S, S = diag(1,1,−1)): Rz(a1)·Ry(−a2)·Rx(−a3) with
 *           a1 = camberRad, a2 = toeRad + steer + yaw, a3 = −cornerSign·spinAngle.
 *   The tyre mesh keeps its 0.33 m radius over the 0.30 m physics radius (cars.md §4.5, not "fixed").
 * Wheel geometry: tarmac wheel for tyre types 0/1, gravel wheel for 2/3/4 (cars.md §8 recommendation; Astra's
 * undefined gravel wheel → tarmac).
 * LOD: the original fixes one LOD set per car from the video-quality table (playercarlodlevel / othercarlodlevel,
 * FUN_00491ce0; the table is not in the archives). Here: by camera distance (LOD_DIST), the wheel meshes switch their
 * internal LODs with the same index. DEVIATION documented in docs/orig/cars.md.
 * Lights: LampBack materials switch to the unlit TexSimple program while braking (cars.md §6); CarFlareRear sprites
 * while braking, CarFlareBack in reverse, CarFlare (headlights) at night (Lensflares.con positions, FX_CarFlare*.con
 * textures / colours; the screen-size law of the LensFlare object is [I]: size·min(distance, flareScaleDistance)).
 * Ghost: every material drawn with the Car/Ghost program (env reflection only, translucent [I]).
 * Track lightmap under the car (t3): setLightmap(texture, projection) per frame from the stage view's carLightmapAt
 * (renderer.ts; the patch lightmap through the car palette, carShader.ts); white until set / off the track.
 * Not ported: drivers (skeleton bind convention open, cars.md §12 Q4), damage law (uDamage morph exists, stays 0),
 * dirt accumulation law (c0 stays 0), dynamic / drop shadows (three's sun shadow map is used instead: the body casts).
 */
import * as THREE from 'three';
import { carPartPath, fetchArrayBuffer, fetchJson, getAssetManifest, manifestHasStagePart, stagePartPath, assetUrl } from '../../core/assets';
import { SURFACE_INFO } from '../../core/constants';
import { applyThreeQuat } from '../../core/space';
import type { CameraTuning, CarRenderState, ChaseCamEntry, DeepPartial, TetherCamEntry } from '../../core/types';
import { createCarVisualUniforms, makeCarMaterial, whiteLightmap, type CarShaderDef, type CarVisualUniforms } from './carShader';
import type { TextureScope } from './textures';

export const CARS_PART = 'cars';

/** Camera distance (m) at which LOD set i+1 takes over from i (Mesh/Cars → Cars_1 → Cars_2 → Cars_3). */
export const LOD_DIST: readonly number[] = [22, 50, 110];
/** Visual steer follows the physics angle at ≤ 4 rad/s (MECHANICS_SPEC §5.2, FUN_006c8ef0). */
const STEER_RATE = 4;

// ------------------------------------------------------------------------------------------- data types

type V3 = [number, number, number];

export interface CarWheelInfo {
  index: number;
  name: string;
  front: boolean;
  /** CarWheel setPosition in its bundle (SIM body frame). */
  bundle: V3;
  /** TemplatesMenu.con bundle (garage: +0.05…0.105 m higher). */
  menuBundle: V3;
  mount: V3;
  /** Template setRotation yaw, degrees (180 on the right wheels). */
  yawDeg: number;
  cornerSign: number;
  camberRad: number;
  toeRad: number;
  springLength: number;
  springK: number;
  steerTweak: number;
  rest?: { load: number; ext: number; visualExt: number; contactY: number; centreY: number };
}

export interface FlareEntry {
  tex: string | null;
  size: number[] | null;
  size2: number[] | null;
  rot: number;
  color: number[] | null;
  color2: number[] | null;
  fadeAngleFactor: number;
}

export interface FlareTemplate {
  scaleDistance: number | null;
  flares: FlareEntry[];
  coronas: FlareEntry[];
}

/** One entry of the car's CarCamera template: Templates.con `setCamPosition <i> <enabled> <flag> <posA> <posB>
 *  <param>`, positions in the ORIGINAL car frame (sim body: x right, y up, z forward). */
export interface CarCameraEntry {
  i: number;
  /** In the camera cycle (MECHANICS_SPEC §5.3: entries 0, 1, 5-8, 10, 12 on every car). */
  enabled: boolean;
  /** Second flag, raw (0 on entries 0-4, 1 after; meaning not traced). */
  flag: number;
  posA: V3;
  posB: V3;
  param: V3;
}

/** cars.json `camera`: the car's own <Car>CarCamera (attached by Player.con at `attach`). */
export interface CarCameraInfo {
  template: string;
  attach: V3 | null;
  entries: CarCameraEntry[];
}

/** cars/<Name>/cars.json */
export interface CarInfo {
  version: number;
  car: string;
  /** Menu display name (LocaleEnglish, one line). */
  name: string;
  nameLines: string[];
  shortName: string | null;
  /** Spec lines ("247 hp 331 Nm", "1340 kg 4WD 6"). */
  specs: string[];
  /** The same, one value per line ("247 hp", "331 Nm", "1340 kg", "4WD", "6"), and the car select screen's labels
   *  for them (LocaleEnglish 50: "HP", "Torque", "Weight", "Wheeldrive", "Gears"). */
  specLines: string[];
  specLabels: string[];
  /** The three menu bars 0..1 and their labels (LocaleEnglish 51: "Speed", "Handling", "Accel"). */
  sliders: number[] | null;
  sliderLabels: string[];
  icon: { path: string; width: number; height: number } | null;
  /** 0 FWD, 1 RWD, 2 AWD. */
  drive: number;
  mass: number;
  wheelRadius: number;
  wheelWidth: number;
  wheels: CarWheelInfo[];
  wheelMeshes: { tarmac: string; gravel: string; gravelTyres: number[] };
  lodTriangles: number[];
  meshes: string;
  lensflares: { template: string; pos: V3; yawDeg: number }[];
  flareTemplates: Record<string, FlareTemplate>;
  exhaust: { template: string; pos: V3; rot: V3 }[];
  drivers: { role: string; pos: V3; characterHeight: number | null }[];
  hull: { points: V3[]; extraPoints: V3[]; min: V3; max: V3 };
  dropShadow: { tex: string | null; scale: number[] | null };
  /** The car's own camera table (absent in packs built before it was emitted → the generic §5.3 table). */
  camera?: CarCameraInfo | null;
  menuEnvCube: string[] | null;
  missing: string[];
}

interface MatRec {
  name: string;
  sub: string;
  group: number;
  nv: number;
  ni: number;
  shader: CarShaderDef;
  off: { pos: number; nrm: number; col: number; uv0: number; uv1?: number; dpos?: number; dnrm?: number; idx: number };
  bbox: number[];
}

interface MeshesJson {
  version: number;
  car: string;
  lods: { dir: string; bin: string; triangles: number; meshes: { role: string; file: string; bbox: number[]; materials: MatRec[] }[] }[];
  wheels: Record<string, { file: string; bbox: number[]; lods: { materials: MatRec[] }[] }>;
  wheelsBin: string;
}

/** stages/<id>/cars.json */
export interface StageCarInputs {
  version: number;
  stage: string;
  envCube: string[] | null;
  dirtMap: string | null;
  settings: { specularColor: V3; specularHighlightsEnable: boolean; envmapColorScale: V3; metallicSpecularScale: number };
  lightColor: V3 | null;
  ambient: V3 | null;
}

// ------------------------------------------------------------------------------------------- data cache

const infoCache = new Map<string, Promise<CarInfo>>();
const dataCache = new Map<string, Promise<{ meshes: MeshesJson; lods: ArrayBuffer[]; wheels: ArrayBuffer }>>();
const stageCache = new Map<string, Promise<StageCarInputs>>();
const DATA_CACHE_MAX = 3;

function cached<T>(m: Map<string, Promise<T>>, key: string, make: () => Promise<T>, max = Infinity): Promise<T> {
  let p = m.get(key);
  if (p) {
    m.delete(key); // LRU order
    m.set(key, p);
    return p;
  }
  p = make();
  p.catch(() => m.get(key) === p && m.delete(key));
  m.set(key, p);
  while (m.size > max) m.delete(m.keys().next().value as string);
  return p;
}

/** Forget fetched car data (tests). */
export function clearCarCache(): void {
  infoCache.clear();
  dataCache.clear();
  stageCache.clear();
}

/** cars/<Name>/cars.json (rejects when absent; check the manifest first). */
export function loadCarInfo(carName: string): Promise<CarInfo> {
  return cached(infoCache, carName, () => fetchJson<CarInfo>(carPartPath(carName, CARS_PART)));
}

/** CarCamera entry → CameraTuning key (MECHANICS_SPEC §5.3 entry numbers). */
const CHASE_ENTRIES: readonly [number, keyof CameraTuning['chase']][] = [[5, 'chaseNear'], [6, 'chase'], [7, 'chaseFar'], [8, 'chaseHigh']];
const TETHER_ENTRIES: readonly [number, keyof CameraTuning['tether']][] = [[10, 'tetherHigh'], [12, 'tetherLow']];

/**
 * The car's own camera positions as a CameraTuning patch (null when its cars.json has none). The original reads
 * every view from the player car's <Car>CarCamera entries (template +0x248, stride 0x30: FUN_0075e390 entry 0,
 * FUN_0075e790 entry 1, FUN_0075fca0..ffa0 entries 5-8, FUN_007601a0 / 00760980 entries 10 / 12); the §5.3 table
 * (makeCameraTuning) is ImprezaWRX's. Mapping: 0 → bumperPos, 1 → bonnetPos, 5-8 → chase posA / posB / p0 p1 =
 * param.xy, 10 / 12 → tether p0 p1 = posA.xy, d = posB, 24 → lookBackPos. Same frame as CameraTuning (original car
 * frame); FOV, lerp rates and the bumper pitch / shake are global (not in the template).
 */
export function carCameraTuning(info: Pick<CarInfo, 'camera'>): DeepPartial<CameraTuning> | null {
  const entries = info.camera?.entries;
  if (!entries?.length) return null;
  const by = new Map(entries.map((e) => [e.i, e]));
  const v3 = (a: V3) => ({ x: a[0], y: a[1], z: a[2] });
  const out: DeepPartial<CameraTuning> = {};
  const chase: Partial<Record<keyof CameraTuning['chase'], ChaseCamEntry>> = {};
  const tether: Partial<Record<keyof CameraTuning['tether'], TetherCamEntry>> = {};
  const e0 = by.get(0), e1 = by.get(1), e24 = by.get(24);
  if (e0) out.bumperPos = v3(e0.posA);
  if (e1) out.bonnetPos = v3(e1.posA);
  if (e24) out.lookBackPos = v3(e24.posA);
  for (const [i, k] of CHASE_ENTRIES) {
    const e = by.get(i);
    if (e) chase[k] = { posA: v3(e.posA), posB: v3(e.posB), p0: e.param[0], p1: e.param[1] };
  }
  for (const [i, k] of TETHER_ENTRIES) {
    const e = by.get(i);
    if (e) tether[k] = { p0: e.posA[0], p1: e.posA[1], d: v3(e.posB) };
  }
  if (Object.keys(chase).length) out.chase = chase;
  if (Object.keys(tether).length) out.tether = tether;
  return out;
}

/** URL of the car's original menu icon (Menu/menu/Texture/Icon<Name>.tga as PNG), or null. */
export function carIconUrl(info: CarInfo): string | null {
  return info.icon ? assetUrl(`cars/${info.car}/${info.icon.path}`) : null;
}

function loadCarData(carName: string, info: CarInfo) {
  return cached(
    dataCache,
    carName,
    async () => {
      const base = `cars/${carName}/`;
      const meshes = await fetchJson<MeshesJson>(base + info.meshes);
      const [lods, wheels] = await Promise.all([
        Promise.all(meshes.lods.map((l) => fetchArrayBuffer(base + l.bin))),
        fetchArrayBuffer(base + meshes.wheelsBin),
      ]);
      return { meshes, lods, wheels };
    },
    DATA_CACHE_MAX,
  );
}

function loadStageInputs(stageId: string): Promise<StageCarInputs> {
  return cached(stageCache, stageId, () => fetchJson<StageCarInputs>(stagePartPath(stageId, CARS_PART)));
}

// ------------------------------------------------------------------------------------------- public API

export interface OriginalCarVisual {
  /** Car body root in the three car frame (forward −Z), origin = centre of mass. */
  readonly root: THREE.Object3D;
  /** Wheel objects, order 0 FL, 1 FR, 2 RR, 3 RL. */
  readonly wheels: readonly THREE.Object3D[];
  /** Original car name and its cars.json. */
  readonly carName: string;
  readonly info: CarInfo;
  /** LOD set shown (0 = Mesh/Cars … 3 = Mesh/Cars_3). */
  readonly lod: number;
  /** Ported stage whose stages/<id>/cars.json (env cube, dirt map, car.* settings) the car uses; null = menu inputs. */
  readonly stageId: string | null;
  /** Advance the visual timers only (wheel jitter); `apply` does it too. */
  update(dt: number): void;
  /** Pose, wheels, lights and LOD from one frame's render state (renderer, every frame). */
  apply(state: CarRenderState, frameDt: number, camera?: THREE.Camera | null): void;
  setVisible(on: boolean): void;
  setNight(on: boolean): void;
  /** Force a LOD set (0..3) or null = by camera distance. */
  setLod(lod: number | null): void;
  /** Crash morph 0..1 (cars.md §9; the original's damage law is not ported). */
  setDamage(amount: number): void;
  /** Dirt factor c0 0..1 (the accumulation law is not ported; starts clean). */
  setDirt(amount: number): void;
  /** t3: the projected track lightmap under the car (through the car palette) and its projection u = x·p[0] + p[1],
   *  v = z·p[2] + p[3] (three world space); null = none (white). */
  setLightmap(texture: THREE.Texture | null, proj?: readonly number[] | null): void;
  /** Static pose without telemetry (showroom / menu): wheels at rest, no steer. */
  restPose(): void;
  dispose(): void;
}

export interface OriginalCarOptions {
  /** Where the car's textures come from: the caller (GameRenderer) passes `this.textureStore.scope()` and
   *  disposes that scope after visual.dispose(). Required (no scope → null). */
  textures?: TextureScope;
  /** Ported stage the car is shown on (per-stage env cube / dirt map: stages/<id>/cars.json); null = menu. */
  stageId?: string | null;
  /** Ghost car (translucent env-only material, no flares, no shadows). */
  ghost?: boolean;
  /** Garage pose: the TemplatesMenu.con wheel bundles. */
  menu?: boolean;
  /** Fixed LOD set (default: by camera distance). */
  lod?: number;
}

/**
 * The original car's visual, or null when the manifest has no such car (absent assets, `?orig=0`) or no texture
 * scope was given. Throws on real failures (the caller warns once and keeps the procedural car).
 */
export async function loadOriginalCar(carName: string, opts: OriginalCarOptions = {}): Promise<OriginalCarVisual | null> {
  const m = await getAssetManifest();
  if (!m || !(m.carParts[carName] ?? []).includes(CARS_PART) || !opts.textures) return null;
  const scope = opts.textures;
  const info = await loadCarInfo(carName);
  const stageId = opts.stageId && manifestHasStagePart(m, opts.stageId, CARS_PART) ? opts.stageId : null;
  const [data, stage] = await Promise.all([loadCarData(carName, info), stageId ? loadStageInputs(stageId) : Promise.resolve(null)]);
  const shared = createCarVisualUniforms();
  const cubeIds = stage?.envCube ?? info.menuEnvCube;
  const [env, dirt] = await Promise.all([
    cubeIds && cubeIds.length === 6 ? scope.getCube(cubeIds) : Promise.resolve(null),
    stage?.dirtMap ? scope.get(stage.dirtMap) : Promise.resolve(null),
  ]);
  shared.env.value = env;
  shared.dirtMap.value = dirt;
  if (stage) {
    const s = stage.settings;
    shared.specColor.value.set(...s.specularColor);
    if (s.specularHighlightsEnable === false) shared.specColor.value.set(0, 0, 0);
    shared.envScale.value.set(...s.envmapColorScale);
    shared.specScaleMul.value = s.metallicSpecularScale;
  }
  // every base texture of every LOD + wheel material
  const texIds = new Set<string>();
  for (const l of data.meshes.lods) for (const mesh of l.meshes) for (const mat of mesh.materials) if (mat.shader.tex) texIds.add(mat.shader.tex);
  for (const w of Object.values(data.meshes.wheels)) for (const l of w.lods) for (const mat of l.materials) if (mat.shader.tex) texIds.add(mat.shader.tex);
  const flareIds = new Set<string>();
  if (!opts.ghost) for (const t of Object.values(info.flareTemplates)) for (const e of [...t.flares, ...t.coronas]) if (e.tex) flareIds.add(e.tex);
  const texMap = new Map<string, THREE.Texture>();
  await Promise.all(
    [...texIds, ...flareIds].map(async (id) => {
      texMap.set(id, await scope.get(id, flareIds.has(id) && !texIds.has(id) ? { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping } : {}));
    }),
  );
  return new OrigCarVisualImpl(carName, info, data, shared, texMap, { ...opts, stageId });
}

// ------------------------------------------------------------------------------------------- geometry

function buildGeometry(buf: ArrayBuffer, m: MatRec): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const o = m.off;
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, o.pos, m.nv * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(buf, o.nrm, m.nv * 3), 3));
  g.setAttribute('aCol', new THREE.BufferAttribute(new Uint8Array(buf, o.col, m.nv * 4), 4, true));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, o.uv0, m.nv * 2), 2));
  if (o.uv1 !== undefined) g.setAttribute('aUv1', new THREE.BufferAttribute(new Float32Array(buf, o.uv1, m.nv * 2), 2));
  if (o.dpos !== undefined && o.dnrm !== undefined) {
    g.setAttribute('aDpos', new THREE.BufferAttribute(new Float32Array(buf, o.dpos, m.nv * 3), 3));
    g.setAttribute('aDnrm', new THREE.BufferAttribute(new Float32Array(buf, o.dnrm, m.nv * 3), 3));
  }
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(buf, o.idx, m.ni), 1));
  const b = m.bbox;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  if (o.dpos !== undefined) g.boundingSphere.radius += 0.4; // crash morph moves vertices by ≤ 0.34 m (cars.md §5.3)
  return g;
}

interface WheelRig {
  info: CarWheelInfo;
  root: THREE.Group;
  camber: THREE.Group;
  yaw: THREE.Group;
  spin: THREE.Group;
  /** [tarmac | gravel][lod] groups. */
  sets: THREE.Group[][];
  steer: number;
  steerOffX: number;
  steerOffZ: number;
  timer: number;
}

interface FlareSprite {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  kind: 'head' | 'rear' | 'back';
  /** Light position (three car-local) and facing (three car-local unit vector). */
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  entry: FlareEntry;
  scaleDistance: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _d = new THREE.Vector3();
const FLARE_WHITE: readonly number[] = [255, 255, 255, 255];
/** Toward-eye offset of a lens flare sprite, m (= the original's occlusion quad size 0.3, FX_CarFlare*.con). */
const FLARE_PULL = 0.3;

class OrigCarVisualImpl implements OriginalCarVisual {
  readonly root = new THREE.Group();
  readonly wheels: THREE.Group[] = [];
  readonly carName: string;
  readonly info: CarInfo;
  readonly stageId: string | null;
  lod = 0;
  private fixedLod: number | null;
  private readonly lodGroups: THREE.Group[] = [];
  private readonly rigs: WheelRig[] = [];
  private readonly flares: FlareSprite[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly shared: CarVisualUniforms;
  private readonly ghost: boolean;
  private readonly menu: boolean;
  private tyreSet = 0;
  private night = false;
  private disposed = false;

  constructor(
    carName: string,
    info: CarInfo,
    data: { meshes: MeshesJson; lods: ArrayBuffer[]; wheels: ArrayBuffer },
    shared: CarVisualUniforms,
    tex: Map<string, THREE.Texture>,
    opts: OriginalCarOptions,
  ) {
    this.carName = carName;
    this.info = info;
    this.stageId = opts.stageId ?? null;
    this.shared = shared;
    this.ghost = !!opts.ghost;
    this.menu = !!opts.menu;
    this.fixedLod = opts.lod ?? null;
    this.root.name = `orig-car:${carName}`;
    const matFor = (m: MatRec, deform: boolean) => {
      const out: THREE.ShaderMaterial[] = [];
      const base = m.shader.tex ? (tex.get(m.shader.tex) ?? null) : null;
      if (this.ghost) out.push(makeCarMaterial(m.shader, 'ghost', shared, { base, deform }));
      else {
        out.push(makeCarMaterial(m.shader, 'main', shared, { base, deform }));
        if (m.shader.envPass && shared.env.value) out.push(makeCarMaterial(m.shader, 'envPass', shared, { base, deform }));
      }
      this.materials.push(...out);
      return out;
    };
    const addMeshes = (parent: THREE.Group, buf: ArrayBuffer, mats: MatRec[], castShadow: boolean, label: string) => {
      for (const m of mats) {
        const g = buildGeometry(buf, m);
        this.geometries.push(g);
        const deform = !!g.getAttribute('aDpos');
        matFor(m, deform).forEach((mat, pass) => {
          const mesh = new THREE.Mesh(g, mat);
          mesh.name = `${label}:${m.name}${pass ? ':envPass' : ''}`;
          mesh.castShadow = castShadow && !this.ghost && m.shader.blend === 'opaque';
          mesh.receiveShadow = false;
          // transparent parts after the opaque body (windows, lamp glass; the env pass after its base pass)
          mesh.renderOrder = m.shader.blend === 'opaque' ? 0 : 1 + pass;
          parent.add(mesh);
        });
      }
    };
    // ---- body + interior per LOD set
    data.meshes.lods.forEach((l, li) => {
      const grp = new THREE.Group();
      grp.name = `lod${li}`;
      for (const mesh of l.meshes) addMeshes(grp, data.lods[li], mesh.materials, mesh.role === 'body', `${mesh.role}${li}`);
      grp.visible = li === 0;
      this.lodGroups.push(grp);
      this.root.add(grp);
    });
    // ---- wheels
    const wheelSets = [info.wheelMeshes.tarmac, info.wheelMeshes.gravel].map((name) => data.meshes.wheels[name] ?? data.meshes.wheels[info.wheelMeshes.tarmac]);
    for (const wi of info.wheels) {
      const root = new THREE.Group();
      const camber = new THREE.Group();
      const yaw = new THREE.Group();
      const spin = new THREE.Group();
      root.name = `wheel${wi.index}`;
      root.add(camber);
      camber.add(yaw);
      yaw.add(spin);
      const sets: THREE.Group[][] = [];
      wheelSets.forEach((ws, si) => {
        const lods: THREE.Group[] = [];
        ws.lods.forEach((l, li) => {
          const g = new THREE.Group();
          g.name = `wheel${wi.index}:${si ? 'gravel' : 'tarmac'}:lod${li}`;
          addMeshes(g, data.wheels, l.materials, false, `wheel${wi.index}`);
          g.visible = si === 0 && li === 0;
          spin.add(g);
          lods.push(g);
        });
        sets.push(lods);
      });
      camber.rotation.z = wi.camberRad;
      this.root.add(root);
      this.wheels.push(root);
      this.rigs.push({ info: wi, root, camber, yaw, spin, sets, steer: 0, steerOffX: 0, steerOffZ: 0, timer: 0 });
    }
    this.wheels.sort((a, b) => a.name.localeCompare(b.name));
    // ---- lens flares (not on the ghost)
    if (!this.ghost) {
      for (const lf of info.lensflares) {
        const tpl = info.flareTemplates[lf.template];
        if (!tpl) continue;
        const kind = lf.template === 'CarFlareRear' ? 'rear' : lf.template === 'CarFlareBack' ? 'back' : 'head';
        const yaw = (lf.yawDeg * Math.PI) / 180;
        // facing: the template's yaw about y in the SIM frame (180 = backwards), mirrored to three (z negated)
        const dir = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
        for (const e of [...tpl.flares, ...tpl.coronas]) {
          const map = e.tex ? (tex.get(e.tex) ?? null) : null;
          if (!map || !e.color || (e.color[3] ?? 0) <= 0) continue;
          const mat = new THREE.SpriteMaterial({ map, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
          mat.name = `orig-car:flare:${lf.template}`;
          const sprite = new THREE.Sprite(mat);
          sprite.name = `flare:${lf.template}`;
          sprite.visible = false;
          sprite.renderOrder = 3;
          sprite.position.set(lf.pos[0], lf.pos[1], -lf.pos[2]);
          this.root.add(sprite);
          this.materials.push(mat);
          this.flares.push({ sprite, mat, kind, pos: sprite.position.clone(), dir, entry: e, scaleDistance: tpl.scaleDistance ?? 100 });
        }
      }
    }
    this.restPose();
  }

  // --------------------------------------------------------------------------------------- state

  update(dt: number): void {
    for (const r of this.rigs) r.timer += dt;
  }

  setVisible(on: boolean): void {
    this.root.visible = on;
  }

  setNight(on: boolean): void {
    this.night = on;
  }

  setLod(lod: number | null): void {
    this.fixedLod = lod === null ? null : Math.max(0, Math.min(this.lodGroups.length - 1, Math.round(lod)));
    if (this.fixedLod !== null) this.showLod(this.fixedLod);
  }

  setDamage(amount: number): void {
    this.shared.damage.value = Math.max(0, Math.min(1, amount));
  }

  setDirt(amount: number): void {
    this.shared.dirtFactor.value = Math.max(0, Math.min(1, amount));
  }

  setLightmap(texture: THREE.Texture | null, proj?: readonly number[] | null): void {
    if (!texture || !proj) {
      this.shared.lightmap.value = whiteLightmap();
      this.shared.lightmapProj.value.set(0, 0, 0, 0);
      return;
    }
    this.shared.lightmap.value = texture;
    this.shared.lightmapProj.value.set(proj[0], proj[1], proj[2], proj[3]);
  }

  private showLod(lod: number): void {
    if (lod === this.lod && this.lodGroups[lod]?.visible) return;
    this.lod = lod;
    this.lodGroups.forEach((g, i) => (g.visible = i === lod));
    this.showWheelSets();
  }

  private showWheelSets(): void {
    for (const r of this.rigs) {
      r.sets.forEach((set, si) => set.forEach((g, li) => (g.visible = si === this.tyreSet && li === Math.min(this.lod, set.length - 1))));
    }
  }

  /** Hub transform of wheel r for extension ext (SIM metres → three), FUN_006c8ef0. */
  private placeWheel(r: WheelRig, ext: number, steer: number, spinAngle: number): void {
    const w = r.info;
    const B = this.menu ? w.menuBundle : w.bundle;
    const L = w.springLength;
    const x = B[0] + (w.front ? r.steerOffX : 0);
    const y = B[1] - Math.max(0.85, ext) * L;
    const z = B[2] + (w.front ? r.steerOffZ : 0);
    r.root.position.set(x, y, -z);
    const a2 = w.toeRad + steer + (w.yawDeg * Math.PI) / 180;
    r.yaw.rotation.y = -a2;
    r.spin.rotation.x = Number.isFinite(spinAngle) ? w.cornerSign * (spinAngle % (Math.PI * 40)) : 0;
  }

  restPose(): void {
    for (const r of this.rigs) {
      r.steer = 0;
      r.steerOffX = r.steerOffZ = 0;
      this.placeWheel(r, r.info.rest?.ext ?? 0.88, 0, 0);
    }
    this.showWheelSets();
  }

  apply(state: CarRenderState, frameDt: number, camera?: THREE.Camera | null): void {
    this.root.position.set(state.pos.x, state.pos.y, state.pos.z);
    applyThreeQuat(this.root.quaternion, state.quat);
    const tel = state.telemetry;
    // tyre type → wheel geometry (cars.md §8)
    const set = this.info.wheelMeshes.gravelTyres.includes(tel.tyreType) ? 1 : 0;
    if (set !== this.tyreSet) {
      this.tyreSet = set;
      this.showWheelSets();
    }
    // LOD by camera distance (or fixed)
    if (this.fixedLod !== null) this.showLod(this.fixedLod);
    else if (camera) {
      const d = camera.getWorldPosition(_v).distanceTo(this.root.position);
      let lod = 0;
      while (lod < LOD_DIST.length && d > LOD_DIST[lod]) lod++;
      this.showLod(Math.min(lod, this.lodGroups.length - 1));
    }
    // wheels (FUN_006c8ef0)
    const speed = Math.abs(tel.speedKmh) / 3.6;
    const maxStep = STEER_RATE * Math.max(frameDt, 0);
    for (let i = 0; i < this.rigs.length; i++) {
      const r = this.rigs[i];
      const wt = tel.wheels[r.info.index];
      if (!wt) continue;
      r.timer += frameDt;
      const vis = wt.visual;
      const L = r.info.springLength;
      let ext = 1;
      let jitter = 0;
      if (wt.contact) {
        ext = 1 - (Number.isFinite(vis.suspensionOffset) ? vis.suspensionOffset : 0) / L;
        if (wt.surface) {
          const s = Math.sin(35 * r.timer);
          jitter = SURFACE_INFO[wt.surface].wheelJitterAmp * speed * 0.0002 * s * s;
        }
      }
      const target = Number.isFinite(vis.steerAngle) ? vis.steerAngle : 0;
      if (state.justReset || frameDt <= 0) r.steer = target;
      else r.steer += Math.max(-maxStep, Math.min(maxStep, target - r.steer));
      if (r.info.front && wt.contact) {
        // kingpin offset of the contact point (MECHANICS_SPEC §2.6 W3, physics steer; kept while airborne)
        const k = r.info.steerTweak * (r.info.index === 1 ? -1 : 1);
        r.steerOffX = (1 - Math.cos(target)) * k;
        r.steerOffZ = Math.sin(target) * k;
      }
      this.placeWheel(r, ext + jitter, r.steer, vis.spinAngle);
    }
    // lights
    if (!this.ghost) {
      const braking = tel.brake > 0.05;
      this.shared.brake.value = braking ? 1 : 0;
      if (this.flares.length) this.updateFlares(camera ?? null, braking, tel.gear === 0);
    }
  }

  private updateFlares(camera: THREE.Camera | null, braking: boolean, reverse: boolean): void {
    if (!camera || !this.root.visible) {
      for (const f of this.flares) f.sprite.visible = false;
      return;
    }
    const cam = camera.getWorldPosition(_v);
    this.root.updateMatrixWorld();
    const q = this.root.getWorldQuaternion(_q);
    const qInv = _qi.copy(q).invert();
    for (const f of this.flares) {
      const on = f.kind === 'rear' ? braking : f.kind === 'back' ? reverse : this.night;
      if (!on) {
        f.sprite.visible = false;
        continue;
      }
      // unit vector from the lamp toward the camera, and how squarely the lamp faces it
      const toCam = _w.copy(f.pos).applyMatrix4(this.root.matrixWorld).sub(cam).negate();
      const dist = toCam.length();
      toCam.divideScalar(Math.max(dist, 1e-6));
      const facing = _d.copy(f.dir).applyQuaternion(q).dot(toCam);
      if (facing <= 0) {
        f.sprite.visible = false;
        continue;
      }
      const e = f.entry;
      const fa = e.fadeAngleFactor;
      const k = fa >= 1 ? 1 : Math.max(0, Math.min(1, (facing - fa) / (1 - fa)));
      const c1 = e.color ?? FLARE_WHITE;
      const c2 = e.color2 ?? c1;
      const lerp = (a: number, b: number) => (b + (a - b) * k) / 255;
      // raw 0..255 bytes like the original's vertex colour (gamma-space pipeline, no colour-space conversion)
      f.mat.color.setRGB(lerp(c1[0], c2[0]), lerp(c1[1], c2[1]), lerp(c1[2], c2[2]));
      f.mat.opacity = lerp(c1[3] ?? 255, c2[3] ?? 255);
      const s1 = e.size?.[0] ?? 0.01;
      const s2 = e.size2?.[0] ?? s1;
      // [I] screen-constant up to flareScaleDistance, then world-constant (CarFlareShader.vs gets metres)
      const size = (s2 + (s1 - s2) * k) * Math.min(dist, f.scaleDistance) * 2;
      f.sprite.scale.set(size, size, 1);
      // The original tests a 0.3 × 0.3 m quad at the lamp with an occlusion query (setOcclusionQuadWidthHeight,
      // CarFlareOcclusionShader.vs) and draws the flare moved toward the eye (CarFlareShader.vs, c9.z), so the lamp's
      // own housing never hides it. Here: the sprite is pulled FLARE_PULL toward the camera and depth-tested (terrain
      // / other cars still hide it); facing <= 0 (lamp turned away) stands in for the query [I].
      f.sprite.position.copy(f.pos).addScaledVector(toCam.applyQuaternion(qInv), Math.min(FLARE_PULL, dist * 0.5));
      f.sprite.visible = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.root.removeFromParent();
  }
}
