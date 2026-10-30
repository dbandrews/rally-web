/**
 * src/audio/orig/bankTypes.ts — OWNED BY THE AUDIO BUILDER.
 *
 * Shape of public/assets/global/audio.json, written by tools/assets/parts/audio.py from the original
 * `.ssc` sound scripts (research/formats/sound.md §1-§2) and WAVs (§12). Keys of `scripts` / `samples` are the
 * research paths (`Cars/cars/ImprezaWRX/Sound/Engine.ssc`, `Audio/sound/44khz/Cars/Subaruimpreza/Engine1.wav`),
 * the same keys as research/formats/sound_dump.json.
 */

/** One `beginEffect … endEffect` block with the decomp defaults applied (FUN_00605df0 / FUN_00605d70). */
export interface EffectJson {
  /** Destination: 0 Volume, 1 Pitch, … (FUN_00602f00; the data uses only 0 and 1). */
  d: number;
  /** Source: 0 Default, 1 Extern, 2 Speed, 3 Acceleration, 4 Distance, 5 Altitude, 6 Time, 7 TimeRelease (FUN_00603490). */
  s: number;
  /** Extern index (`controlSource Extern n`, atoi of the rest). */
  x: number;
  /** Envelope: 0 Linear (2 params), 1 Ramp (6 params x0 x1 y0 dy curve exp). */
  e: number;
  /** Effective parameters (Ramp: 6, Linear: 2). */
  p: number[];
}

/** One `load` layer (0x50-byte description, ctor FUN_00604350 defaults). */
export interface LayerJson {
  /** Sample key into AudioBankJson.samples, null when the original's load fails (NissanSkyline Idleoutside typo). */
  s: string | null;
  /** The `load` argument as written. */
  path: string;
  loop: boolean;
  /** false = `stereo` (plain 2-D buffer, no 3-D attenuation). */
  is3d: boolean;
  volume: number;
  pan: number;
  minDistance: number;
  priority: number;
  /** 0 Default, 1 Release, 2 Volume (FUN_00603890). */
  trigger: number;
  /** 1 Immediate, 2 ImmediateReset, 3 FinishSample. */
  stop: number;
  /** randomStartPitch a / b: pitch += uniform(−a, +b) per voice start. */
  rsp: [number, number];
  /** Emitter offset in the parent's local SIM frame (x right, y up, z forward), metres. */
  rel: [number, number, number];
  /** false = `dopplerOff`. */
  doppler: boolean;
  fx: EffectJson[];
}

export interface PatchJson {
  comment: string;
  /** Play only n random layers per play() (shuffle bag FUN_007eb5c0); 0 = all. Already validated n < layers. */
  randomPlay: number;
  layers: LayerJson[];
}

export interface ScriptJson {
  patches: PatchJson[];
}

export interface SampleJson {
  /** File under global/ (e.g. `audio/audio/sound/44khz/cars/subaruimpreza/engine1.wav`): canonical PCM16 WAV. */
  f: string;
  rate: number;
  ch: number;
  frames: number;
  /** The region the original loops: the WHOLE buffer [0, frames] (DirectSound Play(DSBPLAY_LOOPING), 0x6b3d30). */
  loop: [number, number];
  /** Authored `smpl` loops (ignored by the original; reference only). */
  smpl?: [number, number][];
}

export interface CarSoundJson {
  template: string;
  /** The 20 SoundPlayer.con loadSoundScript slots (null = missing file, the slot stays empty). */
  player: (string | null)[];
  /** The 20 SoundAI.con slots (opponents; 14 of 20 missing for every car, sound.md §12). */
  ai: (string | null)[];
  engineDeltaDistance: number | null;
  pipeDeltaDistance: number | null;
  sampleFolder: string | null;
}

export interface WordJson {
  s: string;
  phrase: string;
}

export interface AudioBankJson {
  version: number;
  tier: string;
  scripts: Record<string, ScriptJson>;
  samples: Record<string, SampleJson>;
  /** By original car name (ORIG_CAR_IDS). */
  cars: Record<string, CarSoundJson>;
  carScriptRoles: string[];
  /** Original material byte 0..22 → surface patch slot 0..18 or null (silent), jump table 0x7473e8. */
  materialSlot: (number | null)[];
  materialNames: string[];
  /** Collision type (material byte, +100 for objects) → Collision.ssc patch (table 0x746e3c). */
  collision: { hard: number[]; snow: number[]; tree: number[] };
  env: {
    /** WorldEnvironmentSound template name → script key. */
    templates: Record<string, string>;
    /** WorldObjectCollisionSound template name → script key. */
    objectSounds: Record<string, string>;
    /** rally-web stage id → [template, x, y, z] in SIM space (Objects.con world − (2048, H, 2048)). */
    placements: Record<string, [string, number, number, number][]>;
  };
  ui: { CountDown: string; CheckPoint: string; Error: string };
  /** Menu meme sounds (Menu.rff menu/sound/<Name>.wav) → sample key. */
  menu: Record<string, string>;
  coDriver: {
    masterVolume: number;
    /** Word id 1..41 → sample (Sound_PaceNotes.con). */
    words: Record<string, WordJson>;
    coachVolume: number;
    /** Team coach 42..92 (Sound_TeamCoach.con; trigger events untraced). */
    coach: Record<string, WordJson>;
  };
}

/** The CarMap.ssc `Car` map (sound.md §1.4). */
export const CAR_EXT = {
  Rpm: 0,
  Gear: 1,
  Throttle: 2,
  SlipX: 3,
  SlipZ: 4,
  Whine: 5,
  Speed: 6,
  Impulse: 7,
  Wheels: 8,
  Ouside: 9,
} as const;

/** CarSoundPlayer script slots = the loadSoundScript order (sound.md §4.3). */
export const CAR_SLOT = {
  Engine: 0,
  Pipe: 1,
  PipeReleaseBoost1: 2,
  PipeReleaseBoost2: 3,
  PipeReleaseBoost3: 4,
  PipeBoost1: 5,
  PipeBoost2: 6,
  PipeBoost3: 7,
  EngineThrottle: 8,
  GearShift: 9,
  HandBrake: 10,
  WheelSlipX: 11,
  WheelSlipZ: 12,
  Weather: 13,
  Glassbreak: 14,
  PipeBoom: 15,
  PipeBlowOut: 16,
  Whine: 17,
  Collision: 18,
  WheelFriction: 19,
} as const;
