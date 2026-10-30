/**
 * src/audio/orig/index.ts — OWNED BY THE AUDIO BUILDER.
 *
 * The original sound bank: public/assets/global/audio.json (+ global/audio/… PCM16 WAVs) written by
 * tools/assets/parts/audio.py from Audio.rff (sound/44khz/…), the `.ssc` scripts in Cars.rff / Misc.rff /
 * Menu.rff and the co-driver words in LocaleEnglish.rff (research/formats/sound.md, Verification overrides).
 *
 *   loadOriginalSoundBank(ctx) → OriginalSoundBank | null
 *     null (the synthesised AudioEngine stays in use) without an asset manifest (absent assets, `?orig=0`,
 *     node / vitest) or when manifest.audio is false. Throws for real failures (the caller warns once and keeps
 *     the synth). Samples are fetched lazily: `load(keys)` fetches + decodes them (deduped, cached; a failing
 *     sample warns once and stays silent, as the original's failed `load`), `sample(key)` returns the buffer or
 *     null while it is not loaded.
 *
 * Decoding: the WAV is parsed here (wav.ts) instead of decodeAudioData, so the AudioBuffer holds exactly the
 * original frames at the file's native rate (sample-exact loops over the WHOLE buffer, sound.md §12; the
 * playback rate is pitch × native rate, as DirectSound's SetFrequency 0x6b52a0).
 *
 * The licensed music tracks (14 WAVs in original_version/Sound/Music/) are NOT part of the bank (music.ts reads the
 * gitignored public/sound/music/ only behind ?music=1).
 */
import { fetchArrayBuffer, fetchJson, getAssetManifest, globalPartPath, warnOnce } from '../../core/assets';
import type { AudioBankJson } from './bankTypes';
import { parseWav } from './wav';

export const AUDIO_PART = 'audio';
/** global/audio.json version this runtime reads (parts/audio.py VERSION). */
export const AUDIO_BANK_VERSION = 1;

export interface OriginalSoundBank {
  /** Decoded sample by bank key (the research path, e.g. `Audio/sound/44khz/Cars/Subaruimpreza/Engine1.wav`;
   *  case-insensitive), or null when unknown / not loaded yet / failed. */
  sample(path: string): AudioBuffer | null;
  /** The parsed `.ssc` scripts by research path (bankTypes.ts ScriptJson). */
  readonly patches: Readonly<Record<string, unknown>>;
  /** The whole bank (scripts, sample table, car templates, surface / collision tables, env, UI, co-driver). */
  readonly json: AudioBankJson;
  /** Fetch + decode these sample keys (deduped; resolves when all settled, never rejects). */
  load(keys: Iterable<string>): Promise<void>;
  /** Keys whose fetch / decode is still running. */
  readonly pending: number;
  dispose(): void;
}

/** Minimal buffer factory (BaseAudioContext.createBuffer); a stub in the tests. */
export interface BufferFactory {
  createBuffer(channels: number, frames: number, sampleRate: number): AudioBuffer;
}

/** Validate the bank JSON (shape checks only; the build step owns the content). */
export function parseBankJson(v: unknown): AudioBankJson | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Partial<AudioBankJson>;
  if (b.version !== AUDIO_BANK_VERSION) return null;
  if (!b.scripts || !b.samples || !b.cars || !Array.isArray(b.materialSlot) || !b.coDriver || !b.env || !b.ui) return null;
  return b as AudioBankJson;
}

/** Fetch global/audio.json (null without a manifest / audio part). Throws on fetch / format errors. */
export async function loadBankJson(): Promise<AudioBankJson | null> {
  const m = await getAssetManifest();
  if (!m || !m.audio) return null;
  const json = parseBankJson(await fetchJson(globalPartPath(AUDIO_PART)));
  if (!json) throw new Error('audio: global/audio.json has an unsupported version / shape');
  return json;
}

/** Asset path of a sample file (`SampleJson.f` is relative to global/). */
export const samplePath = (f: string): string => `global/${f}`;

/** Sample keys of a list of scripts (every layer's `s`). */
export function scriptSampleKeys(bank: AudioBankJson, scripts: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const k of scripts) {
    const s = k ? bank.scripts[k] : undefined;
    for (const p of s?.patches ?? []) for (const l of p.layers) if (l.s) out.add(l.s);
  }
  return [...out];
}

/** Parallel sample fetches (the bank has ~580 small files; keep the request count bounded). */
const MAX_INFLIGHT = 6;

class Bank implements OriginalSoundBank {
  readonly patches: Readonly<Record<string, unknown>>;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly lower = new Map<string, string>();
  private readonly queue: (() => void)[] = [];
  private inflight = 0;
  private disposed = false;
  pending = 0;

  readonly json: AudioBankJson;
  private readonly ctx: BufferFactory;

  constructor(json: AudioBankJson, ctx: BufferFactory) {
    this.json = json;
    this.ctx = ctx;
    this.patches = json.scripts;
    for (const k of Object.keys(json.samples)) this.lower.set(k.toLowerCase(), k);
  }

  private key(path: string): string | null {
    if (path in this.json.samples) return path;
    return this.lower.get(path.toLowerCase()) ?? null;
  }

  sample(path: string): AudioBuffer | null {
    const k = this.key(path);
    return k ? (this.buffers.get(k) ?? null) : null;
  }

  load(keys: Iterable<string>): Promise<void> {
    const all: Promise<void>[] = [];
    for (const p of keys) {
      const k = this.key(p);
      if (!k) continue;
      let j = this.jobs.get(k);
      if (!j) {
        j = this.fetchOne(k);
        this.jobs.set(k, j);
      }
      all.push(j);
    }
    return Promise.all(all).then(() => undefined);
  }

  private async slot(): Promise<void> {
    if (this.inflight < MAX_INFLIGHT) {
      this.inflight++;
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
    this.inflight++;
  }

  private release(): void {
    this.inflight--;
    this.queue.shift()?.();
  }

  private async fetchOne(k: string): Promise<void> {
    const e = this.json.samples[k];
    this.pending++;
    await this.slot();
    try {
      if (this.disposed) return;
      const pcm = parseWav(await fetchArrayBuffer(samplePath(e.f)));
      if (pcm.frames !== e.frames || pcm.rate !== e.rate || pcm.channels !== e.ch) {
        throw new Error(`${e.f}: ${pcm.frames} frames @ ${pcm.rate} Hz × ${pcm.channels}, table says ${e.frames} @ ${e.rate} × ${e.ch}`);
      }
      if (this.disposed || pcm.frames === 0) return;
      const buf = this.ctx.createBuffer(pcm.channels, pcm.frames, pcm.rate);
      for (let c = 0; c < pcm.channels; c++) buf.copyToChannel(pcm.data[c], c);
      this.buffers.set(k, buf);
    } catch (err) {
      // a failed sample stays silent (the original's failed load), one warning per file
      warnOnce(`audio-sample:${k}`, `audio: sample ${k} unavailable (${String(err)}); that layer stays silent`);
    } finally {
      this.pending--;
      this.release();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.buffers.clear();
    this.jobs.clear();
  }
}

/** Build a bank over an already-fetched JSON (tests, tools). */
export function createSoundBank(json: AudioBankJson, ctx: BufferFactory): OriginalSoundBank {
  return new Bank(json, ctx);
}

export async function loadOriginalSoundBank(ctx: BaseAudioContext): Promise<OriginalSoundBank | null> {
  const json = await loadBankJson();
  if (!json) return null;
  return new Bank(json, ctx);
}
