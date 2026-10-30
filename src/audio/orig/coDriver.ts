/**
 * src/audio/orig/coDriver.ts — OWNED BY THE AUDIO BUILDER.
 *
 * The original co-driver (research/formats/sound.md §10): `Misc/object/Sound_PaceNotes.con` loads word samples
 * 1..41 (`race.loadPaceNote <id> audio/PaceNotes/<Phrase>.wav`, LocaleEnglish, 11025 Hz mono) at
 * `race.setPaceNoteMasterVolume 0.92`; a stage note `race.addPaceNote 0 w1 … w8 <d>` (Pacenote.origWords, −1
 * dropped) is spoken word by word. Read from the decomp (sound.md §15 Q3 called this untraced):
 *
 *   word object FUN_0067bd20: a patch instance (vtable 0x83bd70, FUN_007e9aa0) loaded from the WAV
 *     (vt+4(path, 0, 0, 0)), vt+0x2c(10) on its layers; play = FUN_0067bce0: setVolume(DAT_00857fc8 = options
 *     slider 4, the co-driver volume) + play(); "still speaking" = FUN_0067bd80: isActive() (vt+0x18).
 *   new note FUN_0067a190 (the race HUD update 0x4b0415 → FUN_0074b620 fired a note): nothing if the FIRST word
 *     has no sample; else the 8 slots get the words' objects (an unknown / −1 word = 0, which ends the note there),
 *     the cursor goes to slot 0 and word 0 plays (unless +0x38 is set). There is NO queue: a new note replaces the
 *     one being spoken at once (the word still sounding is not stopped and plays out).
 *   per frame without a new note FUN_0067a250: if the cursor word is no longer active → cursor + 1 and play that
 *     word (unless +0x38); if it is active while +0x38 is set → release(0) it and cursor + 1.
 * So consecutive words are separated by the frame on which the update notices the end plus the next 15 Hz sound
 * tick that starts the voice (patch.ts), exactly as the original. +0x38 is mapped to the game pause [?]; the
 * word layer is treated as 2-D (`stereo`) — the loader's layer setup (vt+4 args 0, 0, 0) is not decoded [?].
 *
 * voice.ts (CoDriverVoice, used by the HUD) finds the active output through getCoDriverOutput(); without one (no
 * assets / not loaded) it falls back to the synthesized voice on the note text.
 */
import type { LayerJson } from './bankTypes';
import { PatchInstance, type SoundSystem } from './patch';

/** Note slots of the player (`addPaceNote` w1 … w8). */
export const NOTE_SLOTS = 8;

export interface CoDriverOutput {
  /** The note's first word has a loaded sample (else the caller falls back to the synthesized voice). */
  canSay(words: readonly number[]): boolean;
  say(words: readonly number[]): void;
  setPaused(paused: boolean): void;
  stop(): void;
  /** Debug: the words left in the note being spoken (from the cursor), null when idle. */
  readonly speaking: readonly number[] | null;
}

let active: CoDriverOutput | null = null;

/** The registered original co-driver (OriginalAudio registers it). */
export function getCoDriverOutput(): CoDriverOutput | null {
  return active;
}
export function setCoDriverOutput(o: CoDriverOutput | null): void {
  active = o;
}

/** The race's pacenote player (FUN_0067a190 / FUN_0067a250) on the shared sound system. */
export class CoDriverPlayer implements CoDriverOutput {
  /** Options slider 4 (DAT_00857fc8): the co-driver volume, pushed by every play (patch.volume). */
  volume = 1;
  /** Debug: notes started since construction. */
  notes = 0;
  private readonly sys: SoundSystem;
  /** word id → sample key (Sound_PaceNotes.con) and "is it loaded". */
  private readonly sampleOf: (id: number) => string | null;
  private readonly loaded: (key: string) => boolean;
  private readonly masterVolume: number;
  private readonly patches = new Map<number, PatchInstance>();
  /** The 8 slots (0 = end) and the cursor (+0x34). */
  private slots: number[] = [];
  private cursor = 0;
  /** +0x38 (no new word starts; a sounding one is released). */
  private paused = false;

  constructor(sys: SoundSystem, sampleOf: (id: number) => string | null, loaded: (key: string) => boolean, masterVolume: number) {
    this.sys = sys;
    this.sampleOf = sampleOf;
    this.loaded = loaded;
    this.masterVolume = masterVolume;
  }

  /** The word's patch: one 2-D one-shot layer at the pacenote master volume. */
  private word(id: number): PatchInstance | null {
    let p = this.patches.get(id);
    if (p) return p;
    const s = this.sampleOf(id);
    if (!s) return null;
    const l: LayerJson = {
      s, path: s, loop: false, is3d: false, volume: this.masterVolume, pan: 0, minDistance: 1, priority: 10, trigger: 0,
      stop: 2, rsp: [0, 0], rel: [0, 0, 0], doppler: false, fx: [],
    };
    p = new PatchInstance(this.sys, { comment: `pacenote ${id}`, randomPlay: 0, layers: [l] }, `PaceNote#${id}`);
    this.patches.set(id, p);
    return p;
  }

  private playWord(id: number): void {
    const p = this.word(id);
    if (!p) return;
    p.volume = this.volume; // FUN_0067bce0: setVolume(DAT_00857fc8)
    p.play();
  }

  canSay(words: readonly number[]): boolean {
    const s = words.length ? this.sampleOf(words[0]) : null;
    return !!s && this.loaded(s);
  }

  get speaking(): readonly number[] | null {
    const left = this.slots.slice(this.cursor);
    const end = left.indexOf(0);
    const w = end < 0 ? left : left.slice(0, end);
    return w.length ? w : null;
  }

  /** FUN_0067a190: a new note replaces the current one. */
  say(words: readonly number[]): void {
    if (!words.length || !this.sampleOf(words[0])) return;
    const slots: number[] = [];
    for (let k = 0; k < NOTE_SLOTS; k++) {
      const w = words[k];
      slots.push(w !== undefined && w > 0 && this.sampleOf(w) ? w : 0);
    }
    this.slots = slots;
    this.cursor = 0;
    this.notes++;
    if (!this.paused) this.playWord(slots[0]);
  }

  /** FUN_0067a250, once per frame (after the HUD may have fired a note). */
  update(): void {
    const id = this.slots[this.cursor] ?? 0;
    if (!id) return;
    const p = this.word(id);
    if (!p || !p.isActive()) {
      this.cursor++;
      const next = this.slots[this.cursor] ?? 0;
      if (next && !this.paused) this.playWord(next);
    } else if (this.paused) {
      p.release();
      this.cursor++;
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Stage change / restart: drop the note and silence its words. */
  stop(): void {
    this.slots = [];
    this.cursor = 0;
    for (const p of this.patches.values()) p.kill();
  }

  dispose(): void {
    this.stop();
    this.patches.clear();
    if (active === this) active = null;
  }
}
