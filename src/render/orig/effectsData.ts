/**
 * src/render/orig/effectsData.ts — the original car-effect definitions (effects builder; no three.js).
 *
 * Data: stages/<id>/effects.json (+ effects.bin, the particle light grid), cars/<Name>/effects.json, written by
 * tools/assets/parts/effects.py. Semantics: research/formats/effects.md (exe addresses there).
 *
 *   loadStageEffects(stageId)   → StageEffects | null   (null: no manifest / part absent / ?orig=0; never rejects
 *                                                         except on a real fetch / parse failure)
 *   loadCarEffects(car)         → CarEffectsDef | null
 *   overTimeTable(keys, comps)  → the 101-entry table of an OverTimeDistribution (FUN_0076b110)
 *   sampleRD(rd, rng)           → one RandomDistribution sample (FUN_00576620 / FUN_007879a0 sign rule)
 *   evalOT(table, t)            → lerp of the table at life fraction t (0..1), the original's i/frac split
 *   lightAt(light, xSim, zSim)  → the particle light RGB 0..1 at a sim position (effects.md §6.4)
 */
import {
  carPartPath,
  fetchArrayBuffer,
  fetchJson,
  getAssetManifest,
  isPortedStageId,
  manifestHasStagePart,
  stagePartPath,
} from '../../core/assets';

export const EFFECTS_PART = 'effects';
export const EFFECTS_VERSION = 1;

/** RandomDistribution: [type 0 NONE | 1 UNIFORM | 2 EXPONENTIAL | 3 NORMAL, a, b, symmetric]. */
export type RD = readonly [number, number, number, boolean];
/** OverTimeDistribution keys: [t percent 0..100, value...]. */
export type OTKeys = readonly (readonly number[])[];

export interface EmitterDef {
  type: 'Emitter';
  template: string;
  looping: boolean;
  removeWhenFinished: boolean;
  startAtCreation: boolean;
  addEmitterSpeed: boolean;
  emitterSpeedScale: number;
  interpolatePosition: boolean;
  predictePosition: boolean;
  startProbability: number;
  useCameraOrientation: boolean;
  timeToLive: RD;
  intensity: RD;
  intensityOverTime: OTKeys;
  /** [Dof, Up, Right] each. */
  relativePositionIn: readonly [RD, RD, RD];
  positionalSpeedIn: readonly [RD, RD, RD];
  rotationalSpeedIn: readonly [RD, RD, RD];
}

export interface SpriteDef {
  type: 'SpriteParticle';
  hasCollisionPhysics: boolean;
  collisionElasticConstant: number;
  collisionOffset: number;
  attatchToEmitter: boolean;
  closeDistCullConst: number;
  closeDistCullFadeConst: number;
  alphaCull: number;
  scaleWithSpeedFactor: number;
  maxParticlesPercentage: number;
  timeToLive: RD;
  size: RD;
  gravityModifier: RD;
  dragInDof: RD;
  XYSizeRatio: RD;
  rotationSpeed: RD;
  initRotation: RD;
  varianceColor: RD;
  alphaTestRef: RD;
  initAnimationFrame: RD;
  animationSpeed: RD;
  useUVRotation: boolean;
  useShimmer: boolean;
  useGradiantLighting: boolean;
  useProjectedLightmaps: boolean;
  usePointSprites: boolean;
  turnsInMovingDirection: boolean;
  /** D3DBLEND values (5 SRCALPHA, 6 INVSRCALPHA, 2 ONE, …). */
  srcBlendMode: number;
  destBlendMode: number;
  sizeOverTime: OTKeys;
  gravityModifierOverTime: OTKeys;
  dragInDofOverTime: OTKeys;
  XYSizeRatioOverTime: OTKeys;
  rotationSpeedOverTime: OTKeys;
  alphaTestRefOverTime: OTKeys;
  animationSpeedOverTime: OTKeys;
  colorRGBAOverTime: OTKeys;
  texture: string;
  tex: string | null;
}

export interface CarFxChild {
  template: string;
  /** Child placement in the CarFx frame (sim, metres / degrees yaw/pitch/roll). */
  pos: readonly [number, number, number];
  rot: readonly [number, number, number];
  isActive: boolean;
  /** Original material byte (gcm / PhysicsParam row), −1 = any. */
  trigOnMaterial: number;
  /** c_Body 0 … c_RearLeftWheel 10; 12 backfire, 13 blow-out, 14 exhaust speed fade (effects.md §3.2). */
  attachedMode: number;
  /** c_CarThrottle 0 … c_WheelXSlipNeg 16 (effects.md §3.3). */
  trigOnPhyVar: number;
  startFade: number;
  doneFade: number;
}

export interface CarFxDef {
  type: 'CarFx';
  children: readonly CarFxChild[];
}

export type FxTemplate = EmitterDef | SpriteDef | CarFxDef;

export interface SkidDef {
  /** Per original material byte (32): [xSlipMin, zSlipMin, lateralSpeedMin, longSpeedMin]. */
  trig: readonly (readonly number[])[];
  extraWidth: readonly number[];
  intensityClamp: readonly number[];
  color: readonly (readonly number[])[];
  texture: string | null;
  atlasColumns: number;
  halfWidth: number;
  lift: number;
  minSegment: number;
  maxSegments: number;
  activeStrips: number;
  finishedStrips: number;
}

export interface EffectsSettings {
  enableParticles: boolean;
  globalParticleColor: readonly number[];
  maxParticles: number;
  particleLightmapMin: readonly number[];
  particleLightmapMax: readonly number[];
  particleLightmapClamp: readonly number[];
  dropShadowColor: readonly number[];
  dropShadowFadeOffset: number;
  dropShadowFadeScale: number;
  drawSkidMarks: boolean;
  dynamicShadows: boolean;
  cullDistCars: number;
}

export interface LightGridMeta {
  cell: number;
  tile: number;
  tiles: readonly (readonly [number, number])[];
  bin: string;
  bytes: number;
}

export interface TexInfo {
  id: string;
  depth?: number;
  volume?: boolean;
  width?: number;
  height?: number;
}

export interface StageEffectsJson {
  version: number;
  stageId: string;
  settings: EffectsSettings;
  /** The CarFx bases a car gets on this stage (PFX_Template order, duplicates kept) with their placement in the
   *  car frame (sim; rot = yaw/pitch/roll degrees — 180 yaw on all but Asphalt). */
  carFx: readonly { name: string; pos: readonly [number, number, number]; rot: readonly [number, number, number] }[];
  pipeFx: readonly string[];
  templates: Readonly<Record<string, FxTemplate>>;
  skid: SkidDef;
  lut: readonly (readonly number[])[];
  light: LightGridMeta | null;
  textures: Readonly<Record<string, TexInfo>>;
}

/** A loaded light grid: tile key → byte offset of its RGB8 cells. */
export interface LightGrid {
  cell: number;
  tile: number;
  index: Map<number, number>;
  data: Uint8Array;
}

export interface StageEffects {
  json: StageEffectsJson;
  light: LightGrid | null;
  /** The LUT maximum (unlit / outside the grid). */
  lightMax: readonly [number, number, number];
}

export interface CarEffectsDef {
  version: number;
  car: string;
  exhaust: readonly { template: string; pos: readonly [number, number, number]; rot: readonly [number, number, number] }[];
  dropShadow: { tex: string | null; carTexture: boolean; scale: readonly number[] | null; bbox: readonly (readonly number[])[] | null };
}

// ------------------------------------------------------------------------------------------- loading

const tileKey = (tx: number, tz: number) => (tx + 32768) * 65536 + (tz + 32768);

export function parseLightGrid(meta: LightGridMeta, buf: ArrayBuffer): LightGrid {
  const data = new Uint8Array(buf);
  const per = meta.tile * meta.tile * 3;
  if (data.length < meta.tiles.length * per) throw new Error(`effects light grid: ${data.length} bytes < ${meta.tiles.length * per}`);
  const index = new Map<number, number>();
  meta.tiles.forEach(([tx, tz], i) => index.set(tileKey(tx, tz), i * per));
  return { cell: meta.cell, tile: meta.tile, index, data };
}

export async function loadStageEffects(stageId: string): Promise<StageEffects | null> {
  if (!isPortedStageId(stageId)) return null;
  const m = await getAssetManifest();
  if (!manifestHasStagePart(m, stageId, EFFECTS_PART)) return null;
  const json = await fetchJson<StageEffectsJson>(stagePartPath(stageId, EFFECTS_PART));
  if (!json || json.version !== EFFECTS_VERSION || !json.templates) throw new Error(`effects.json of ${stageId}: bad version`);
  let light: LightGrid | null = null;
  if (json.light) light = parseLightGrid(json.light, await fetchArrayBuffer(stagePartPath(stageId, EFFECTS_PART, 'bin')));
  const max = json.lut?.[255] ?? [255, 255, 255];
  return { json, light, lightMax: [max[0] / 255, max[1] / 255, max[2] / 255] };
}

export async function loadCarEffects(car: string): Promise<CarEffectsDef | null> {
  const m = await getAssetManifest();
  if (!m || !m.carParts?.[car]?.includes(EFFECTS_PART)) return null;
  const j = await fetchJson<CarEffectsDef>(carPartPath(car, EFFECTS_PART));
  return j && j.version === EFFECTS_VERSION ? j : null;
}

// ------------------------------------------------------------------------------------------- distributions

/** The original's RNG (FUN_004a6c80, two Park–Miller style steps) — any good uniform works; this one is the
 *  same generator so a seeded run reproduces the original's sequence shape. Returns u in (0, 1]. */
export class FxRng {
  state: number;
  constructor(seed = 0x2545f491) {
    this.state = seed & 0x7fffffff || 1;
  }
  private step(): number {
    let s = this.state;
    for (const m of [0x5e30, 0x661f]) {
      const lo = (s & 0xffff) * m;
      let hi = (s >> 16) * m + (lo >> 16);
      hi = ((hi & 0x7fff) << 16) + (hi >> 15) - 0x7fffffff + (lo & 0xffff);
      if (hi < 0) hi += 0x7fffffff;
      s = hi | 0;
    }
    this.state = s;
    return s;
  }
  /** (((r | 0x80) >> 7) + 1) · 2^-24 ∈ (0, 1]. */
  next(): number {
    return (((this.step() | 0x80) >> 7) + 1) * 5.9604645e-8;
  }
  private spare: number | null = null;
  /** Polar Box–Muller with the cached spare (FUN_00787d30). */
  gauss(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let a: number, b: number, r: number;
    do {
      a = this.next() * 2 - 1;
      b = this.next() * 2 - 1;
      r = a * a + b * b;
    } while (r > 1 || r === 0);
    const f = Math.sqrt((-2 * Math.log(r)) / r);
    this.spare = b * f;
    return a * f;
  }
}

/** One sample of a RandomDistribution (FUN_00576620; the symmetric flag draws a random sign first, u ≤ 0.5 → −1). */
export function sampleRD(rd: RD, rng: FxRng): number {
  const sign = rd[3] ? (rng.next() <= 0.5 ? -1 : 1) : 1;
  const a = rd[1], b = rd[2];
  let v: number;
  switch (rd[0]) {
    case 0:
      v = a;
      break;
    case 1:
      v = (b - a) * rng.next() + a;
      break;
    case 2:
      v = -Math.log(rng.next()) * a;
      break;
    case 3:
      v = rng.gauss() * b + a;
      break;
    default:
      v = 0;
  }
  return v * sign;
}

/**
 * OverTimeDistribution → 101 entries (FUN_0076b110): entry i = value at life percent i. Keys are linearly
 * interpolated; before the first key the table keeps its default (`def`), after the last key the last value
 * repeats. No keys → all `def` (the ctor fills every table with its default value, 1 for the scalar tables).
 */
export function overTimeTable(keys: OTKeys, comps = 1, def: readonly number[] = [1]): Float32Array {
  const out = new Float32Array(101 * comps);
  for (let i = 0; i <= 100; i++) for (let c = 0; c < comps; c++) out[i * comps + c] = def[c] ?? def[0] ?? 1;
  if (!keys.length) return out;
  const ks = [...keys].sort((p, q) => p[0] - q[0]);
  let prevT = 0;
  let prev: number[] = ks[0][0] === 0 ? ks[0].slice(1) : Array.from({ length: comps }, (_, c) => out[c]);
  for (const k of ks) {
    const t = Math.max(0, Math.min(100, Math.round(k[0])));
    const v = k.slice(1);
    const n = t - prevT;
    for (let i = 0; i <= n; i++)
      for (let c = 0; c < comps; c++) out[(prevT + i) * comps + c] = n === 0 ? v[c] : (i * v[c] + (n - i) * prev[c]) / n;
    prevT = t;
    prev = v;
  }
  for (let i = prevT + 1; i <= 100; i++) for (let c = 0; c < comps; c++) out[i * comps + c] = prev[c];
  return out;
}

/** Table lookup at life fraction t (0..1): i = trunc(100·t), linear to i+1 (the original reads entry 101 = 0
 *  weight at t = 1). */
export function evalOT(table: Float32Array, t: number, comps = 1, c = 0): number {
  const x = Math.max(0, Math.min(1, t)) * 100;
  const i = Math.min(100, Math.floor(x));
  const f = x - i;
  const a = table[i * comps + c];
  const b = i < 100 ? table[(i + 1) * comps + c] : a;
  return a + (b - a) * f;
}

/** Particle light (RGB 0..1) at a SIM-space position from the light grid; `max` outside it. */
export function lightAt(g: LightGrid | null, x: number, z: number, max: readonly number[], out: number[]): number[] {
  if (!g) {
    out[0] = max[0]; out[1] = max[1]; out[2] = max[2];
    return out;
  }
  const ts = g.cell * g.tile;
  const tx = Math.floor(x / ts), tz = Math.floor(z / ts);
  const off = g.index.get(tileKey(tx, tz));
  if (off === undefined) {
    out[0] = max[0]; out[1] = max[1]; out[2] = max[2];
    return out;
  }
  const cx = Math.min(g.tile - 1, Math.max(0, Math.floor((x - tx * ts) / g.cell)));
  const cz = Math.min(g.tile - 1, Math.max(0, Math.floor((z - tz * ts) / g.cell)));
  const o = off + (cz * g.tile + cx) * 3;
  out[0] = g.data[o] / 255; out[1] = g.data[o + 1] / 255; out[2] = g.data[o + 2] / 255;
  return out;
}

/** Car physics variable for a CarFx child (FUN_00757260 / FUN_00757160; effects.md §3.3). */
export interface PhyVarInput {
  throttle: number;
  brake: number;
  gear: number;
  rpm: number;
  /** m/s (car vt+0x118). */
  speed: number;
  /** |v| m/s. */
  vel: number;
  /** Car slip angle rad. */
  slipAngle: number;
  /** Wheel getters (S+0x10..+0x20, …): longitudinal / lateral contact speed m/s, rotational speed, slips. */
  wheelVel: number;
  wheelVelX: number;
  wheelRotVel: number;
  xSlip: number;
  zSlip: number;
  wheelWorldVel: number;
}

export function phyVar(index: number, v: PhyVarInput): number {
  switch (index) {
    case 0: return v.throttle;
    case 1: return v.brake;
    case 2: return v.gear;
    case 3: return v.rpm;
    case 4: return v.speed;
    case 5: return v.vel;
    case 6: return v.slipAngle;
    case 7: return v.wheelVel;
    case 8: return v.wheelVelX;
    case 9: return v.wheelRotVel;
    case 10: return v.xSlip;
    case 11: return v.zSlip;
    case 12: return v.wheelWorldVel;
    case 13: return Math.max(0, v.zSlip);
    case 14: return Math.min(0, v.zSlip);
    case 15: return v.slipAngle >= 0 ? v.xSlip : 0;
    case 16: return v.slipAngle <= 0 ? v.xSlip : 0;
    default: return 0;
  }
}

/** CarFx fade (0x7587da…0x75958c): |value| through [start, done]; inactive → 0; car modes (< 11) need
 *  speed ≥ 1.1111 m/s (4 km/h). */
export function carFxFade(child: CarFxChild, value: number, speed: number): number {
  const v = Math.abs(value);
  let f: number;
  if (v <= child.startFade) f = 0;
  else if (v >= child.doneFade) f = 1;
  else f = (v - child.startFade) / (child.doneFade - child.startFade);
  if (!child.isActive) f = 0;
  if (child.attachedMode < 11 && speed < 1.1111111640930176) f = 0;
  return f;
}
