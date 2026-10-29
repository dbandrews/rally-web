/**
 * src/core/constants.ts — ARCHITECT-OWNED CONTRACT. Builders: import, do not edit.
 *
 * Shared identifiers, id <-> material mappings, display metadata and neutral input values.
 * All names here are ORIGINAL to rally-web (content rule: no names/logos/assets of the original game or
 * of real car makers / rally events).
 */
import type {
  ArchetypeId,
  ArchetypeInfo,
  CameraMode,
  Controls,
  RawInput,
  SurfaceId,
  TyreType,
} from './types';

export const API_VERSION = '0.1.0';

/** Fixed physics rate (§1.2). Do not change. */
export const PHYSICS_HZ = 120;
export const DT = 1 / PHYSICS_HZ;
/** Settle steps at stage start and after each reset (§1.2). */
export const SETTLE_STEPS = 100;
/** §5.4 reset: raise above the spline point, look-back distance, fade length. */
export const RESET_RAISE = 1.5;
export const RESET_BACK_M = 20;
export const RESET_FADE_S = 1.0;
/** §5.4 auto-reset limits ("hand of god"). */
export const AUTO_RESET_LATERAL_M = 30;
export const AUTO_RESET_BELOW_M = -5;
/** §5.7 pacenote lateral gate. */
export const PACENOTE_LATERAL_M = 20;
/** Gravity used by the CAR physics (§2). The 9.81 constant is only for reporting g's (§7.1). */
export const CAR_GRAVITY = 12.0;
export const G_REPORT = 9.81;

// ------------------------------------------------------------------------------------------- surfaces

/** The ten surfaces; MATERIAL ID = index in this array (§4.3 order). */
export const SURFACE_IDS: readonly SurfaceId[] = [
  'tarmac',
  'gravel',
  'gravelDeep',
  'mud',
  'snow',
  'ice',
  'grass',
  'sand',
  'cobbles',
  'water',
] as const;

/** Material id helpers. */
export const MATERIAL: Readonly<Record<SurfaceId, number>> = Object.freeze(
  Object.fromEntries(SURFACE_IDS.map((id, i) => [id, i])) as Record<SurfaceId, number>,
);
/** Material ids >= this are solid but not ground: wheels get no contact (§2.5.1). */
export const MATERIAL_SOLID_MIN = 32;
/** Generic non-drivable solid (rock walls, buildings). */
export const MATERIAL_SOLID = 32;
/** "No material" marker in Heightfield.materials. */
export const MATERIAL_NONE = 255;

export const surfaceFromMaterial = (m: number): SurfaceId | null =>
  m >= 0 && m < SURFACE_IDS.length ? SURFACE_IDS[m] : null;

/** Tyre type names, indexed by TyreType (§4.1). */
export const TYRE_NAMES: readonly string[] = ['tarmac', 'intermediate', 'gravel', 'snow', 'ice'] as const;
export const TYRE_TYPES: readonly TyreType[] = [0, 1, 2, 3, 4] as const;

/** Tyre matched to a surface (§7.1 harness defaults). */
export const MATCHED_TYRE: Readonly<Record<SurfaceId, TyreType>> = Object.freeze({
  tarmac: 0,
  gravel: 2,
  gravelDeep: 2,
  mud: 2,
  snow: 3,
  ice: 4,
  grass: 2,
  sand: 2,
  cobbles: 0,
  water: 0,
});

export interface SurfaceInfo {
  name: string;
  /** Base render colour 0xRRGGBB. */
  color: number;
  /** Kicks up dust / spray particles, with this colour. */
  dust: boolean;
  dustColor: number;
  /** DEEP set (§4.3): ×1.4 lateral and bogging drag. Mirrors the physics table default. */
  deep: boolean;
  /** §4.3 visual columns (physics-table defaults; the renderer reads them from here). */
  wheelJitterAmp: number;
  cameraRoughness: number;
  /** Leaves visible skid marks when sliding. */
  skidMarks: boolean;
}

/** Display / effects metadata per surface (non-physics; the physics table lives in src/sim/params.ts). */
export const SURFACE_INFO: Readonly<Record<SurfaceId, SurfaceInfo>> = Object.freeze({
  tarmac: { name: 'Tarmac', color: 0x3b3e43, dust: false, dustColor: 0x9a9a9a, deep: false, wheelJitterAmp: 0.125, cameraRoughness: 0.03125, skidMarks: true },
  gravel: { name: 'Gravel', color: 0x9b8566, dust: true, dustColor: 0xb8a284, deep: false, wheelJitterAmp: 0.75, cameraRoughness: 0.25, skidMarks: true },
  gravelDeep: { name: 'Loose gravel', color: 0x8b7457, dust: true, dustColor: 0xa89274, deep: true, wheelJitterAmp: 1.5, cameraRoughness: 0.275, skidMarks: true },
  mud: { name: 'Mud', color: 0x5c4733, dust: true, dustColor: 0x4a3828, deep: false, wheelJitterAmp: 1.0, cameraRoughness: 0.25, skidMarks: true },
  snow: { name: 'Snow', color: 0xe6ecf2, dust: true, dustColor: 0xf4f8fc, deep: false, wheelJitterAmp: 0.25, cameraRoughness: 0.0625, skidMarks: true },
  ice: { name: 'Ice', color: 0xbad4e3, dust: true, dustColor: 0xe0eef6, deep: false, wheelJitterAmp: 0.25, cameraRoughness: 0.0625, skidMarks: true },
  grass: { name: 'Grass', color: 0x4e7834, dust: true, dustColor: 0x6d5a3e, deep: true, wheelJitterAmp: 2.0, cameraRoughness: 0.3125, skidMarks: true },
  sand: { name: 'Sand', color: 0xd3b47c, dust: true, dustColor: 0xe0c896, deep: false, wheelJitterAmp: 0.5, cameraRoughness: 0.125, skidMarks: true },
  cobbles: { name: 'Cobbles', color: 0x6f6b66, dust: false, dustColor: 0x888888, deep: false, wheelJitterAmp: 2.5, cameraRoughness: 0.375, skidMarks: true },
  water: { name: 'Wet tarmac', color: 0x2e3a45, dust: true, dustColor: 0xc8d4dc, deep: false, wheelJitterAmp: 0.125, cameraRoughness: 0.03125, skidMarks: false },
});

// ------------------------------------------------------------------------------------------- cars

export const ARCHETYPE_IDS: readonly ArchetypeId[] = ['awd_wrc', 'fwd_hatch', 'rwd_classic'] as const;

/** Original display names and liveries for the three archetypes (§3.2). */
export const ARCHETYPES: Readonly<Record<ArchetypeId, ArchetypeInfo>> = Object.freeze({
  awd_wrc: {
    id: 'awd_wrc',
    name: 'Corvane X4',
    drive: 'AWD',
    blurb: 'Modern four-wheel-drive stage car. Turbo, six speeds, planted and precise; rotates on lift-off.',
    colors: { body: 0x1f5fbf, accent: 0xf2f2f2, stripe: 0xf5b800 },
  },
  fwd_hatch: {
    id: 'fwd_hatch',
    name: 'Tessel F2',
    drive: 'FWD',
    blurb: 'Light front-drive hatch. Sharp on turn-in, pushes wide under power, quick off the line.',
    colors: { body: 0xd9452b, accent: 0x1c1c1c, stripe: 0xffffff },
  },
  rwd_classic: {
    id: 'rwd_classic',
    name: 'Ardent Classic',
    drive: 'RWD',
    blurb: 'Rear-drive turbo brute from another era. Huge power, slides on demand, needs a light right foot.',
    colors: { body: 0x2f7d3a, accent: 0xe9e2cf, stripe: 0xc22a2a },
  },
});

// ------------------------------------------------------------------------------------------- cameras

/** Camera cycle order (§5.3: entries 0, 1, 5, 6, 7, 8, 10, 12). */
export const CAMERA_MODES: readonly CameraMode[] = [
  'bumper',
  'bonnet',
  'chaseNear',
  'chase',
  'chaseFar',
  'chaseHigh',
  'tetherHigh',
  'tetherLow',
] as const;
/**
 * Default view for players: 'chaseFar' (the §5.3 'chase' entry is kept unchanged for validation, but there the car
 * fills about 40 % of the frame width and hides the apex of tight corners).
 */
export const DEFAULT_CAMERA: CameraMode = 'chaseFar';

// ------------------------------------------------------------------------------------------- input

/**
 * Keyboard bindings actually used by the game (KeyboardEvent.code). The live source of truth is
 * src/input/bindings.ts GAME_KEYS / UI_BINDINGS (the input module owns devices); these mirror them for
 * docs and tools. Deviation from the §5.1 original keymap: A steers here (WASD), so gear up moved from
 * A to E/Shift, look back from Left Ctrl to V, and reset from Enter to R (Enter confirms menus). Ctrl is not
 * bound at all: Ctrl+W (W = throttle) would close the browser tab and cannot be blocked by preventDefault.
 */
export const DEFAULT_KEYS = Object.freeze({
  steerLeft: ['ArrowLeft', 'KeyA'],
  steerRight: ['ArrowRight', 'KeyD'],
  throttle: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  handbrake: ['Space'],
  gearUp: ['KeyE', 'ShiftLeft', 'ShiftRight'],
  gearDown: ['KeyQ', 'KeyZ'],
  reset: ['KeyR'],
  cameraNext: ['KeyC'],
  lookBack: ['KeyV'],
  pause: ['KeyP'],
});

/** UI keys (not part of RawInput). Each UI module listens itself; M (mute) is handled by main.ts. */
export const UI_KEYS = Object.freeze({
  menu: ['Escape'],
  restart: ['Backspace'],
  toggleTuning: ['F1', 'Backquote'],
  toggleOverlay: ['F2', 'F4', 'KeyO'],
  help: ['KeyH'],
  step: ['Period'],
  slower: ['BracketLeft'],
  faster: ['BracketRight'],
  autopilot: ['F8'],
  voice: ['KeyN'],
  mute: ['KeyM'],
});

/** Neutral device input (nothing pressed). Fresh object each call. */
export const neutralRawInput = (): RawInput => ({
  device: 'none',
  steerDigital: false,
  left: false,
  right: false,
  steer: 0,
  throttleDigital: false,
  throttle: 0,
  brakeDigital: false,
  brake: 0,
  handbrakeDigital: false,
  handbrake: 0,
  gearUp: false,
  gearDown: false,
  reset: false,
  cameraNext: false,
  lookBack: false,
  pause: false,
});

/** Neutral physics controls. Fresh object each call. */
export const neutralControls = (): Controls => ({
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: 0,
  gearUp: false,
  gearDown: false,
});

/** "Not controllable" controls (§5.1: pre-start / finished / reset fade): handbrake 1.0. */
export const parkedControls = (): Controls => ({
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: 1,
  gearUp: false,
  gearDown: false,
});
