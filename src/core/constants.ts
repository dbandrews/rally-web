/**
 * src/core/constants.ts — ARCHITECT-OWNED CONTRACT. Builders: import, do not edit.
 *
 * Shared identifiers, id <-> material mappings (incl. the original's material bytes), display metadata and
 * neutral input values. The archetype names / liveries below are rally-web's own; the original game's names
 * and assets are ours too and in scope (AGENTS.md, PROGRESS.md: full faithful port), e.g. ORIG_CAR_IDS.
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

/**
 * The 23 surfaces, one per original material (§4.3 / §4.4); MATERIAL ID = index in this array. Indices 0..9
 * are the original ten rally-web surfaces (unchanged), 10..22 the appended original materials (orig id order).
 *
 * NUMBERING TRAP: this index is NOT the original's material byte (gcm face byte, PhysicsParam.con row):
 * gcm 0 = GRASS but rally-web 0 = tarmac. Raw bytes go through materialFromOrig() first.
 */
export const SURFACE_IDS: readonly SurfaceId[] = [
  'tarmac', // 0
  'gravel', // 1
  'gravelDeep', // 2
  'mud', // 3
  'snow', // 4
  'ice', // 5
  'grass', // 6
  'sand', // 7
  'cobbles', // 8
  'water', // 9
  'wood', // 10
  'snowChunky', // 11
  'snowDeep', // 12
  'snowAsphalt', // 13
  'snowDitch', // 14
  'leaf', // 15
  'asphaltGrass', // 16
  'gravelGrass', // 17
  'mudGrass', // 18
  'mudDitch', // 19
  'sandDeep', // 20
  'sandDark', // 21
  'sandDarkDeep', // 22
] as const;

/** Material id helpers. */
export const MATERIAL: Readonly<Record<SurfaceId, number>> = Object.freeze(
  Object.fromEntries(SURFACE_IDS.map((id, i) => [id, i])) as Record<SurfaceId, number>,
);
/** Material ids >= this are solid but not ground: wheels get no contact (§2.5.1; the original's wheel cut
 *  `(unsigned)mat >= 0x20 → -1`, FUN_006cea90, so MATERIAL_NONE and the original's −1 byte are cut too). */
export const MATERIAL_SOLID_MIN = 32;
/** Generic non-drivable solid (rock walls, buildings). */
export const MATERIAL_SOLID = 32;
/** "No material" marker in Heightfield.materials and RayHit.material (= the original's −1 / byte 255). */
export const MATERIAL_NONE = 255;

/** Surface of a rally-web material id (SURFACE_IDS index), null otherwise. NOT for raw gcm bytes (materialFromOrig). */
export const surfaceFromMaterial = (m: number): SurfaceId | null =>
  m >= 0 && m < SURFACE_IDS.length ? SURFACE_IDS[m] : null;

// ------------------------------------------------------------------------------------------- original materials

/**
 * The original's material id (`c_MATERIAL_ROAD_*` enum = gcm face byte = PhysicsParam.con row, gcm.md §4) of
 * every rally-web surface. One surface per original id 0..22; DUMMY (23) has no surface.
 */
export const SURFACE_ORIG_ID: Readonly<Record<SurfaceId, number>> = Object.freeze({
  tarmac: 1, // ASPHALT
  gravel: 2, // GRAVEL
  gravelDeep: 12, // GRAVELDEEP
  mud: 4, // MUD
  snow: 7, // SNOW
  ice: 20, // ICEASPHALT
  grass: 0, // GRASS
  sand: 5, // SAND
  cobbles: 13, // COBBLES
  water: 3, // WATERASPHALT
  wood: 6, // WOOD
  snowChunky: 8, // SNOWCHUNKY
  snowDeep: 9, // SNOWDEEP
  snowAsphalt: 10, // SNOWASPHALT (exe string SNOWWET)
  snowDitch: 11, // SNOWDITCH
  leaf: 14, // LEAF
  asphaltGrass: 15, // ASPHALTGRASS
  gravelGrass: 16, // GRAVELGRASS
  mudGrass: 17, // MUDGRASS
  mudDitch: 18, // MUDDITCH
  sandDeep: 19, // SANDDEEP
  sandDark: 21, // SANDDARK
  sandDarkDeep: 22, // SANDDARKDEEP
});

/** The original's material names by id 0..23 (PhysicsParam.con order; debugging / tools). */
export const ORIG_MATERIAL_NAMES: readonly string[] = Object.freeze([
  'GRASS', 'ASPHALT', 'GRAVEL', 'WATERASPHALT', 'MUD', 'SAND', 'WOOD', 'SNOW', 'SNOWCHUNKY', 'SNOWDEEP',
  'SNOWASPHALT', 'SNOWDITCH', 'GRAVELDEEP', 'COBBLES', 'LEAF', 'ASPHALTGRASS', 'GRAVELGRASS', 'MUDGRASS',
  'MUDDITCH', 'SANDDEEP', 'ICEASPHALT', 'SANDDARK', 'SANDDARKDEEP', 'DUMMY',
]);

/**
 * Raw original material byte (0..255) → rally-web material id. 256 entries: bytes 0..22 → their surface's
 * MATERIAL id; 23 (DUMMY, in no Track.gcm), 255 (the original's −1, TrackFull only) and every other byte →
 * MATERIAL_NONE (no wheel contact, like the original's `(unsigned)mat >= 0x20` cut).
 *
 * NUMBERING TRAP: index with the RAW byte, never with a rally-web id (ORIG_MATERIAL_TO_MATERIAL[0] = grass = 6,
 * MATERIAL.tarmac = 0 ↔ orig 1). Every mesh-world query result goes through this table.
 */
export const ORIG_MATERIAL_TO_MATERIAL: readonly number[] = Object.freeze(
  (() => {
    const t: number[] = new Array(256).fill(MATERIAL_NONE);
    SURFACE_IDS.forEach((id, i) => (t[SURFACE_ORIG_ID[id]] = i));
    return t;
  })(),
);

/** rally-web material id of a raw original material byte (`byte & 255`, so the int8 −1 works too). */
export const materialFromOrig = (byte: number): number => ORIG_MATERIAL_TO_MATERIAL[byte & 255];

/** Original material byte (0..22) of a rally-web material id; 255 (the original's −1) for any non-surface id. */
export const origFromMaterial = (id: number): number => {
  const s = surfaceFromMaterial(id);
  return s ? SURFACE_ORIG_ID[s] : 255;
};

/** Tyre type names, indexed by TyreType (§4.1). */
export const TYRE_NAMES: readonly string[] = ['tarmac', 'intermediate', 'gravel', 'snow', 'ice'] as const;
export const TYRE_TYPES: readonly TyreType[] = [0, 1, 2, 3, 4] as const;

/** Tyre matched to a surface (§7.1 harness defaults; the appended surfaces take their family's tyre). */
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
  wood: 0,
  snowChunky: 3,
  snowDeep: 3,
  snowAsphalt: 3,
  snowDitch: 3,
  leaf: 0,
  asphaltGrass: 0,
  gravelGrass: 2,
  mudGrass: 2,
  mudDitch: 2,
  sandDeep: 2,
  sandDark: 2,
  sandDarkDeep: 2,
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

/**
 * Display / effects metadata per surface (non-physics; the physics table lives in src/sim/params.ts).
 * wheelJitterAmp / cameraRoughness are the original's per-material values (FUN_006c8ef0 / FUN_0075e210
 * switches on the orig id, research/decomp/all.c); colours of the appended surfaces are stand-ins
 * (the original's look comes from the track textures).
 */
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
  wood: { name: 'Wood', color: 0x7a5a3a, dust: false, dustColor: 0x9a8a74, deep: false, wheelJitterAmp: 2.5, cameraRoughness: 0.375, skidMarks: true },
  snowChunky: { name: 'Chunky snow', color: 0xdfe6ee, dust: true, dustColor: 0xf4f8fc, deep: false, wheelJitterAmp: 0.25, cameraRoughness: 0.0625, skidMarks: true },
  snowDeep: { name: 'Deep snow', color: 0xf0f4f8, dust: true, dustColor: 0xf8fbfd, deep: true, wheelJitterAmp: 0.5, cameraRoughness: 0.125, skidMarks: true },
  snowAsphalt: { name: 'Snowy tarmac', color: 0xc9d1da, dust: true, dustColor: 0xeef3f8, deep: false, wheelJitterAmp: 0.25, cameraRoughness: 0.0625, skidMarks: true },
  snowDitch: { name: 'Snow ditch', color: 0xe9eef4, dust: true, dustColor: 0xf8fbfd, deep: true, wheelJitterAmp: 0.5, cameraRoughness: 0.125, skidMarks: true },
  leaf: { name: 'Leaves', color: 0x7a5a2a, dust: true, dustColor: 0x8a6a3a, deep: false, wheelJitterAmp: 0.125, cameraRoughness: 0.03125, skidMarks: true },
  asphaltGrass: { name: 'Grassy tarmac', color: 0x4a5a40, dust: false, dustColor: 0x8a8a7a, deep: false, wheelJitterAmp: 0.125, cameraRoughness: 0.03125, skidMarks: true },
  gravelGrass: { name: 'Grassy gravel', color: 0x7a7a52, dust: true, dustColor: 0xa89a7a, deep: false, wheelJitterAmp: 1.0, cameraRoughness: 0.25, skidMarks: true },
  mudGrass: { name: 'Grassy mud', color: 0x56583a, dust: true, dustColor: 0x5a4a34, deep: false, wheelJitterAmp: 1.0, cameraRoughness: 0.25, skidMarks: true },
  mudDitch: { name: 'Mud ditch', color: 0x4a3828, dust: true, dustColor: 0x3e2e20, deep: true, wheelJitterAmp: 1.25, cameraRoughness: 0.275, skidMarks: true },
  sandDeep: { name: 'Deep sand', color: 0xd9bc86, dust: true, dustColor: 0xe6d0a2, deep: true, wheelJitterAmp: 1.25, cameraRoughness: 0.1875, skidMarks: true },
  sandDark: { name: 'Dark sand', color: 0xa8875a, dust: true, dustColor: 0xc0a274, deep: false, wheelJitterAmp: 0.5, cameraRoughness: 0.125, skidMarks: true },
  sandDarkDeep: { name: 'Deep dark sand', color: 0x9c7c50, dust: true, dustColor: 0xb8996c, deep: true, wheelJitterAmp: 1.25, cameraRoughness: 0.1875, skidMarks: true },
});

// ------------------------------------------------------------------------------------------- cars

export const ARCHETYPE_IDS: readonly ArchetypeId[] = ['awd_wrc', 'fwd_hatch', 'rwd_classic'] as const;

/**
 * The 29 original car names (RaceSelection.car / AddCarOptions.origCar / CarListEntry.id): the
 * `Cars/cars/<Name>` folders of the original (research/formats/cars.md §1), = the asset manifest's `cars` keys
 * and src/sim/origCars.ts `archive` (contract test). Alphabetical; not the menu order.
 */
export const ORIG_CAR_IDS: readonly string[] = Object.freeze([
  'Astra', 'AudiS1', 'AudiS1HC', 'Beetle', 'CitroenXsara', 'CitroenXsaraRC', 'Corolla', 'DeltaIntergrale',
  'DeltaS4', 'Escudo', 'FordEscort', 'FordFocus', 'FordFocusCosworth', 'FordRS200', 'ImprezaHC', 'ImprezaWRX',
  'Lancer', 'LancerEVO', 'Metro6R4', 'Micra', 'NissanSkyline', 'Peugeot205', 'Peugeot206', 'Peugeot306',
  'Peugeot405', 'Renault5', 'Saab93', 'SaabViggen', 'ToyotaTacoma',
]);

/**
 * The 29 original cars in the ORIGINAL car-select order (Menu.rff menu/Car/SelectCarFrame: the RallyCarButtonNode
 * list, each button's SetStringAction playerCarName <Name>). FordEscort, CitroenXsara, FordRS200, Renault5 and
 * SaabViggen are the original's unlockable bonus cars (the unlock<Name> variables, FUN_006176f0); rally-web offers
 * all of them.
 */
export const ORIG_CAR_MENU_ORDER: readonly string[] = Object.freeze([
  'FordEscort', 'Beetle', 'Corolla', 'Peugeot306', 'LancerEVO', 'ImprezaWRX', 'FordFocusCosworth', 'Peugeot206',
  'CitroenXsara', 'Micra', 'Saab93', 'Astra', 'FordFocus', 'CitroenXsaraRC', 'Lancer', 'ImprezaHC', 'DeltaIntergrale',
  'NissanSkyline', 'Metro6R4', 'Peugeot205', 'AudiS1', 'DeltaS4', 'FordRS200', 'Renault5', 'Peugeot405', 'AudiS1HC',
  'Escudo', 'ToyotaTacoma', 'SaabViggen',
]);

/**
 * The car selected when the game starts with the original assets built and no `?car=`: the original's default
 * `playerCarName`. The menu flow (Menu.rff menu/Navigation, offset 0x12a1) sets playerCarName through an IndexData
 * over a DataListData of the 29 car names whose element 0 is Micra, while the car-select grid starts with the locked
 * bonus car FordEscort [I: the index variable's initial value is not decoded]. Without assets the archetype car stays.
 */
export const ORIG_DEFAULT_CAR = 'Micra';

/** Is `name` one of the 29 original car names (case-sensitive)? */
export const isOrigCarId = (name: string | null | undefined): name is string =>
  !!name && ORIG_CAR_IDS.includes(name);

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
