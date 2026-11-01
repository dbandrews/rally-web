/**
 * src/audio/orig/preload.ts — OWNED BY THE AUDIO BUILDER.
 *
 * Which bank samples a race will play, known before the race starts (AudioEngine.preloadRace): the same key sets the
 * live objects ask for later (OriginalAudio's constructor for the UI / menu / co-driver words, CarSoundPlayer.sampleKeys
 * for a car's scripts, EnvSoundManager.sampleKeys for the stage ambience), computed straight from the bank JSON.
 * The surface and collision tables (materialSlot / collision) hold slot numbers, not samples: their sounds are scripts in
 * the car's slots (WheelSlipX / WheelSlipZ / WheelFriction / Collision), so they come with the car.
 */
import type { AudioBankJson } from './bankTypes';
import { scriptSampleKeys } from './index';

/** What a race will play (the same ids as FrameContext.stage.id / origCar / others[i].origCar). */
export interface RaceAudioSpec {
  stageId: string;
  /** The player's original car (null: an archetype car; its default car loads when the race first needs it). */
  car: string | null;
  /** The AI opponents' original cars. */
  aiCars: readonly string[];
}

/** Fetch priority of a group (Bank.load): the player's own car first, then the field, the stage, the UI. */
export const PRELOAD_PRIORITY = { player: 4, ai: 3, env: 2, ui: 1 } as const;

export interface SampleGroup {
  name: keyof typeof PRELOAD_PRIORITY;
  priority: number;
  keys: string[];
}

/** UI scripts, menu meme sounds and co-driver words: always needed (OriginalAudio's constructor loads the same set). */
export function uiSampleKeys(bank: AudioBankJson): string[] {
  const out = new Set<string>(scriptSampleKeys(bank, Object.values(bank.ui)));
  for (const k of Object.values(bank.menu)) out.add(k);
  for (const w of Object.values(bank.coDriver.words)) out.add(w.s);
  return [...out];
}

/** Every sample the stage's environment objects use (EnvSoundManager.sampleKeys). */
export function envSampleKeys(bank: AudioBankJson, stageId: string): string[] {
  const scripts: string[] = [];
  for (const [template] of bank.env.placements[stageId] ?? []) {
    const key = bank.env.templates[template];
    if (key) scripts.push(key);
  }
  return scriptSampleKeys(bank, scripts);
}

/** Every sample of a car's script slots: the human set (SoundPlayer.con) or the AI "Simple" set (SoundAI.con). */
export function carSampleKeys(bank: AudioBankJson, car: string, human: boolean): string[] {
  const def = bank.cars[car];
  return def ? scriptSampleKeys(bank, human ? def.player : def.ai) : [];
}

/** The sample groups of a race, most urgent first, without a key twice (a sample shared with a more urgent group stays there). */
export function raceSampleGroups(bank: AudioBankJson, spec: Readonly<RaceAudioSpec>): SampleGroup[] {
  const seen = new Set<string>();
  const group = (name: SampleGroup['name'], all: string[]): SampleGroup => {
    const keys = all.filter((k) => !seen.has(k));
    for (const k of keys) seen.add(k);
    return { name, priority: PRELOAD_PRIORITY[name], keys };
  };
  const ai = new Set<string>();
  for (const c of spec.aiCars) for (const k of carSampleKeys(bank, c, false)) ai.add(k);
  return [
    group('player', spec.car ? carSampleKeys(bank, spec.car, true) : []),
    group('ai', [...ai]),
    group('env', envSampleKeys(bank, spec.stageId)),
    group('ui', uiSampleKeys(bank)),
  ];
}
