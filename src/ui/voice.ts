/**
 * src/ui/voice.ts — OWNED BY THE AUDIO BUILDER. The co-driver voice (the HUD calls say() on 'pacenote' events).
 *
 * With the original sound bank loaded, a note that carries its original word ids (Pacenote.origWords, from the
 * stage's Pacenotes.con) is spoken with the original word samples (src/audio/orig/coDriver.ts: words back to back,
 * notes queued, research/formats/sound.md §10). Otherwise (no assets, a procedural stage, a note without words or
 * a word sample not loaded yet) it falls back to the browser's speechSynthesis on the note text, keeping the queue
 * short so calls never lag behind the car.
 */
import { getCoDriverOutput } from '../audio/orig/coDriver';
import type { Pacenote } from '../core/types';

const SPOKEN: Readonly<Record<string, string>> = Object.freeze({
  dontCut: "don't cut",
  surfaceChange: 'surface change',
  overFinish: 'over finish',
});

/** Words dropped from a call that has to follow the previous one immediately (keeps the voice on time). */
const SHORT_DROP = /\b(caution|long|opens|keep straight)\b/g;

export function spokenText(note: Pacenote, short = false): string {
  let t = note.text || '';
  for (const [k, v] of Object.entries(SPOKEN)) t = t.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
  if (short) {
    const s = t.replace(SHORT_DROP, ' ').replace(/\s+/g, ' ').trim();
    if (s) t = s;
  }
  return t.replace(/\s+/g, ' ').trim();
}

export class CoDriverVoice {
  private queued = 0;
  private voice: SpeechSynthesisVoice | null = null;
  private pausedState = false;

  /** Speech output exists: the original co-driver samples or speechSynthesis. */
  get available(): boolean {
    return getCoDriverOutput() !== null || this.speechAvailable;
  }

  private get speechAvailable(): boolean {
    return typeof globalThis.speechSynthesis !== 'undefined' && typeof globalThis.SpeechSynthesisUtterance !== 'undefined';
  }

  private pickVoice(): void {
    if (this.voice || !this.speechAvailable) return;
    try {
      const vs = speechSynthesis.getVoices();
      this.voice = vs.find((v) => /^en(-|_)GB/i.test(v.lang)) ?? vs.find((v) => /^en/i.test(v.lang)) ?? null;
    } catch {
      this.voice = null;
    }
  }

  say(note: Pacenote): void {
    const orig = getCoDriverOutput();
    const words = note.origWords;
    if (orig && words && words.length && orig.canSay(words)) {
      orig.say(words);
      return;
    }
    if (!this.speechAvailable) return;
    // the previous call is still being spoken: say the short form (back-to-back notes)
    const text = spokenText(note, this.queued > 0);
    if (!text) return;
    try {
      this.pickVoice();
      if (this.queued >= 2) {
        speechSynthesis.cancel();
        this.queued = 0;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.25;
      u.pitch = 1.0;
      u.volume = 1.0;
      if (this.voice) u.voice = this.voice;
      u.onend = u.onerror = () => {
        this.queued = Math.max(0, this.queued - 1);
      };
      this.queued++;
      speechSynthesis.speak(u);
    } catch {
      /* speech unavailable */
    }
  }

  setPaused(p: boolean): void {
    if (p === this.pausedState) return;
    this.pausedState = p;
    getCoDriverOutput()?.setPaused(p);
    if (!this.speechAvailable) return;
    try {
      if (p) speechSynthesis.pause();
      else speechSynthesis.resume();
    } catch {
      /* ignore */
    }
  }

  stop(): void {
    getCoDriverOutput()?.stop();
    if (!this.speechAvailable) return;
    try {
      speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    this.queued = 0;
  }
}
