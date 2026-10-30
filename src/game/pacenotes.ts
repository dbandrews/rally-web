/**
 * src/game/pacenotes.ts — game builder. §5.7 pacenote triggering.
 *
 * Each physics step the LAST note with note.s ≤ playerS fires once if it has not been played; it is marked
 * played first and only spoken when the car is within |lateral| < 20 m of the centre line (FUN_0074b620: a
 * note passed 20 m+ off the road is lost, not deferred). Purely positional (no speed look-ahead). Notes are
 * never replayed after a reset: a reset keeps the played flags (only a restart clears them, FUN_0074b680) and
 * every note the car passed was marked when it became the last passed one. Stage notes are
 * sorted by s (the ported original lists are reduced to their reachable notes, src/world/portedPacenotes.ts,
 * so the binary search equals the original's backward scan over the file order).
 */
import { PACENOTE_LATERAL_M } from '../core/constants';
import type { Pacenote } from '../core/types';

export class PacenoteCaller {
  private notes: readonly Pacenote[] = [];
  private played: boolean[] = [];
  /** Optional extra look-ahead in metres added to the player's s (0 = spec behaviour). */
  leadM = 0;

  reset(notes: readonly Pacenote[]): void {
    this.notes = [...notes].sort((a, b) => a.s - b.s);
    this.played = this.notes.map(() => false);
  }

  get count(): number {
    return this.notes.length;
  }

  /** Index of the last note with note.s ≤ s, or -1. */
  lastIndexAt(s: number): number {
    const n = this.notes;
    let lo = 0;
    let hi = n.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (n[mid].s <= s) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Mark every note with note.s ≤ s as played (reset rule). */
  markPlayedUpTo(s: number): void {
    const last = this.lastIndexAt(s);
    for (let i = 0; i <= last; i++) this.played[i] = true;
  }

  isPlayed(i: number): boolean {
    return this.played[i] === true;
  }

  /** One step. Returns the note that fires now, or null. */
  update(s: number, lateral: number): Pacenote | null {
    if (this.notes.length === 0) return null;
    const i = this.lastIndexAt(s + this.leadM);
    if (i < 0 || this.played[i]) return null;
    this.played[i] = true;
    if (Math.abs(lateral) >= PACENOTE_LATERAL_M) return null;
    return this.notes[i];
  }

  /** Next notes ahead of s that have not fired yet (for previews / tests). */
  upcoming(s: number, n = 3): Pacenote[] {
    const out: Pacenote[] = [];
    for (let i = this.lastIndexAt(s) + 1; i < this.notes.length && out.length < n; i++) out.push(this.notes[i]);
    return out;
  }
}

/** Spoken form of a note for the co-driver voice (our own vocabulary). */
export function pacenoteSpeech(note: Pacenote): string {
  return note.text.replace(/\bdontCut\b/g, "don't cut").replace(/\s+/g, ' ').trim();
}
