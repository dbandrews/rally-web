/**
 * src/audio/orig/music.ts — OWNED BY THE AUDIO BUILDER.
 *
 * The original soundtrack player, OFF by default. The tracks (original_version/Sound/Music/, licensed third-party
 * music, PROGRESS.md) are NEVER part of public/assets or the build: this player only streams files the user put
 * into the gitignored `public/sound/music/` folder (same `<Artist> - <Title>.wav` names), and only with the
 * explicit opt-in flag `?music=1`.
 *
 * Playlists (research/formats/sound.md §11, static tables in the decomp):
 *   in-game  FUN_004e8aa0: the 10 tracks below in table order
 *   menu     FUN_004e8f50: G-Force, Cold Fission, Back Up
 *   pre-race FUN_004e8e00: Foetus – Quick Fix (CC Mix)
 *   (the three Big Idea tracks are in the exe strings but referenced by no table)
 * The order inside a playlist (sequential vs shuffled) is not traced; sequential, looping. Volume =
 * sfxMaster × music slider through the DS law (FUN_004e9ae0 / FUN_006b36d0, 600·log2 v mB); streamed with an
 * <audio> element as the original's DirectShow stream.
 */
import { urlParam, warnOnce } from '../../core/assets';
import { dsGain } from './ds';

export const INGAME_PLAYLIST: readonly string[] = Object.freeze([
  'Soundmine - G-Force',
  'Soundmine - Cold Fission',
  'Soundmine - Back Up',
  'Hardknox - Come In Hard',
  'Frontside - L.B.P.',
  'Fear Factory - Cyberdyne',
  'Dub Pistols - Kill The DJ',
  'Ball Of Waxx - Infrared',
  'Androyd - Tech-Head',
  'Androyd - Spellbinder',
]);
export const MENU_PLAYLIST: readonly string[] = Object.freeze(['Soundmine - G-Force', 'Soundmine - Cold Fission', 'Soundmine - Back Up']);
export const PRERACE_PLAYLIST: readonly string[] = Object.freeze(['Foetus - Quick Fix (CC Mix)']);

/** `?music=1` (explicit opt-in; anything else = off). */
export function musicEnabled(): boolean {
  const v = urlParam('music');
  return v !== null && /^(1|true|yes|on)$/i.test(v);
}

/** URL of a track in the user's gitignored public/sound/music/ folder. */
export function musicUrl(name: string): string {
  let base = '/';
  try {
    base = import.meta.env?.BASE_URL ?? '/';
  } catch {
    /* non-Vite runtime */
  }
  return (base.endsWith('/') ? base : base + '/') + 'sound/music/' + encodeURIComponent(name + '.wav');
}

export class MusicPlayer {
  private el: HTMLAudioElement | null = null;
  private index = 0;
  private failures = 0;
  private playing = false;
  /** Options slider 2 (DAT_00849e78), 0..1. */
  musicVolume = 1;

  readonly playlist: readonly string[];

  constructor(playlist: readonly string[] = INGAME_PLAYLIST) {
    this.playlist = playlist;
  }

  private element(): HTMLAudioElement | null {
    if (this.el || typeof Audio === 'undefined') return this.el;
    const el = new Audio();
    el.preload = 'auto';
    el.addEventListener('ended', () => this.advance(true));
    el.addEventListener('error', () => {
      warnOnce(`music:${this.playlist[this.index]}`, `music: ${this.playlist[this.index]}.wav not found in public/sound/music/ (skipped)`);
      this.advance(false);
    });
    this.el = el;
    return el;
  }

  private advance(ok: boolean): void {
    this.failures = ok ? 0 : this.failures + 1;
    if (this.failures >= this.playlist.length) {
      this.playing = false; // nothing playable
      return;
    }
    this.index = (this.index + 1) % this.playlist.length;
    if (this.playing) this.load();
  }

  private load(): void {
    const el = this.element();
    if (!el) return;
    el.src = musicUrl(this.playlist[this.index]);
    void el.play().catch(() => {
      /* autoplay blocked until a gesture / file missing (the error event handles it) */
    });
  }

  play(): void {
    if (this.playing || this.failures >= this.playlist.length) return;
    this.playing = true;
    const el = this.element();
    if (!el) return;
    if (el.src) void el.play().catch(() => {});
    else this.load();
  }

  pause(): void {
    this.playing = false;
    this.el?.pause();
  }

  /** sfxMaster × music slider (the SFX slider also scales the music, FUN_004e9ae0). */
  setVolume(sfxMaster: number): void {
    if (this.el) this.el.volume = dsGain(sfxMaster * this.musicVolume);
  }

  dispose(): void {
    this.pause();
    if (this.el) {
      this.el.removeAttribute('src');
      this.el.load();
    }
    this.el = null;
  }
}
