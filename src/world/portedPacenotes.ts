/**
 * src/world/portedPacenotes.ts — the ORIGINAL co-driver notes of the ported stages (race builder).
 *
 * Data: each archive's PaceNotes.con (`race.addPaceNote <kind 0> w1 … w8 <distance>`), ported verbatim into
 * src/world/ports/<id>.ts PACENOTES by research/tools/port_tracks.py (file order, −1 words dropped). The word
 * ids 1..41 are the original co-driver vocabulary (Misc/object/Sound_PaceNotes.con `race.loadPaceNote <id>
 * audio/PaceNotes/<Phrase>.wav`, research/formats/sound.md §10); Pacenote.origWords carries them for the
 * sample player, `text` is the same call written out (the synthesized-voice fallback and the HUD line).
 *
 * Runtime semantics ported (FUN_0074b620, called from the race HUD update 0x4b0415): each frame the LAST note
 * in LIST order whose distance ≤ the player's spline distance fires once (marked played even when the car is
 * ≥ 20 m off the centre line, then not spoken). The scan runs backwards over the file order, so a note followed
 * by an earlier-distance note can never fire (newzealand3f: 2237.6 before 2136.67). `effectiveOrder` drops
 * exactly those unreachable notes; the remaining list is strictly increasing, and the "last note with s ≤ pos"
 * lookup over it (src/game/pacenotes.ts) is then identical to the original's backward scan over the file.
 *
 * Derived (not in the data, for the HUD only): `cornerS`, where the called bend begins. The original only
 * stores the call point; its bend lies ≈ 100-125 m further on (sound.md §10, measured over 774 notes). The
 * first bend word is matched to the first analysed corner of the same direction that begins 15-260 m after
 * the call; without one (or for hazard-only calls) cornerS = s + ORIG_NOTE_LEAD_M.
 */
import type { Pacenote, PacenoteDirection, PacenoteModifier } from '../core/types';
import type { Corner } from './corners';

/** Phrase (sample) names by word id (sound.md §10 table; index 0 unused). */
export const ORIG_PACENOTE_PHRASES: readonly string[] = Object.freeze([
  '',
  'EasyLeft', 'EasyRight', 'MediumLeft', 'MediumRight', 'HardLeft', 'HardRight',
  'HairpinLeft', 'HairpinRight', 'TightHairpinLeft', 'TightHairpinRight', 'SquareLeft', 'SquareRight',
  'Narrows', 'OverCrest', 'OverBridge', 'Caution', 'Long', 'Into', 'Onto', 'OverFinish', 'Tightens', 'OverJump',
  'Rocks', 'Trees', 'Fence', 'Exposure', 'Bank', 'Banks', 'Bumps', 'Ditch',
  'Tarmac', 'Mud', 'Gravel', 'Sand', 'Dontcut', 'Opens', 'Careful', 'Inside', 'Outside', 'Bump', 'LongStraight',
]);

/** Spoken form of each word id (the readable call; index 0 unused). */
const SPOKEN: readonly string[] = Object.freeze([
  '',
  'easy left', 'easy right', 'medium left', 'medium right', 'hard left', 'hard right',
  'hairpin left', 'hairpin right', 'tight hairpin left', 'tight hairpin right', 'square left', 'square right',
  'narrows', 'over crest', 'over bridge', 'caution', 'long', 'into', 'onto', 'over finish', 'tightens', 'over jump',
  'rocks', 'trees', 'fence', 'exposure', 'bank', 'banks', 'bumps', 'ditch',
  'tarmac', 'mud', 'gravel', 'sand', "don't cut", 'opens', 'careful', 'inside', 'outside', 'bump', 'long straight',
]);

/**
 * Bend words 1..12 → rally-web severity (6 = fastest … 1 = hairpin): the original's six grades in order
 * easy / medium / hard / square / hairpin / tight hairpin.
 */
const BEND_SEVERITY: Readonly<Record<string, 1 | 2 | 3 | 4 | 5>> = Object.freeze({
  Easy: 5, Medium: 4, Hard: 3, Square: 2, Hairpin: 1, TightHairpin: 1,
});

/** Word id → note modifier (rally-web PacenoteModifier) where one exists. */
const WORD_MODIFIER: Readonly<Record<number, PacenoteModifier>> = Object.freeze({
  13: 'narrows', 14: 'crest', 15: 'bridge', 16: 'caution', 17: 'long', 18: 'into', 20: 'overFinish',
  21: 'tightens', 22: 'jump', 29: 'bump', 31: 'surfaceChange', 32: 'surfaceChange', 33: 'surfaceChange',
  34: 'surfaceChange', 35: 'dontCut', 36: 'opens', 37: 'caution', 40: 'bump',
});

/** Median distance from an original call point to its bend (sound.md §10: agreement peaks at +100..+125 m). */
export const ORIG_NOTE_LEAD_M = 100;
/** Window after the call point in which the called bend's analysed corner may begin (m). */
const MATCH_MIN_M = 15;
const MATCH_MAX_M = 260;

/** Is `id` a bend word (1..12)? Odd = left, even = right. */
export const isBendWord = (id: number): boolean => id >= 1 && id <= 12;

/** The readable call of a word list, e.g. [14, 18, 4] → "over crest into medium right". */
export function origPacenoteText(words: readonly number[]): string {
  return words.map((w) => SPOKEN[w] ?? '').filter(Boolean).join(' ');
}

/**
 * Indices (file order) of the notes the original's backward scan can ever fire: note i is reachable iff every
 * later note lies strictly further along (d_j > d_i for all j > i). The result is strictly increasing in d.
 */
export function effectiveOrder(dists: readonly number[]): number[] {
  const keep: number[] = [];
  let minAfter = Infinity;
  for (let i = dists.length - 1; i >= 0; i--) {
    if (dists[i] < minAfter) keep.push(i);
    minAfter = Math.min(minAfter, dists[i]);
  }
  return keep.reverse();
}

/**
 * Stage.pacenotes of a ported stage from the archive notes. `shift` is the race-distance shift of the stage
 * (portedRaceSettings, 0 for a verbatim port); `corners` (three space, +1 = right-hander) only place cornerS.
 */
export function portedPacenotes(
  notes: readonly (readonly [number, readonly number[]])[],
  shift: number,
  corners: readonly Corner[],
  length: number,
): Pacenote[] {
  const order = effectiveOrder(notes.map((n) => n[0]));
  const out: Pacenote[] = [];
  for (const i of order) {
    const [d, words] = notes[i];
    const s = Math.min(length, Math.max(0, d + shift));
    const bend = words.find(isBendWord);
    let direction: PacenoteDirection = 'straight';
    let severity: Pacenote['severity'] = 0;
    if (bend !== undefined) {
      direction = bend % 2 === 1 ? 'left' : 'right';
      const grade = ORIG_PACENOTE_PHRASES[bend].replace(/(Left|Right)$/, '');
      severity = BEND_SEVERITY[grade] ?? 3;
    }
    const modifiers: PacenoteModifier[] = [];
    for (const w of words) {
      const m = WORD_MODIFIER[w];
      if (m && !modifiers.includes(m)) modifiers.push(m);
    }
    let cornerS = s + ORIG_NOTE_LEAD_M;
    if (bend !== undefined) {
      const want = direction === 'left' ? -1 : 1;
      const c = corners.find((k) => k.dir === want && k.s0 >= s + MATCH_MIN_M && k.s0 <= s + MATCH_MAX_M);
      if (c) cornerS = c.s0;
    }
    out.push({
      s,
      cornerS: Math.min(length, Math.max(s, cornerS)),
      text: origPacenoteText(words),
      direction,
      severity,
      modifiers,
      origWords: [...words],
    });
  }
  return out;
}
