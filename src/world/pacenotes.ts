/**
 * src/world/pacenotes.ts — co-driver notes generated from the stage geometry (our own vocabulary).
 *
 * Severity ladder (classic 1-6, 6 = fastest): 6 (R ≥ 200 m), 5 (125-200), 4 (80-125), 3 (50-80),
 * 2 (28-50), 1 (< 28 m); "hairpin" (≥ 130° and R < 35 m, severity 1) and "square" (~90°, R < 32 m).
 * Modifiers: long, tightens, opens, into (chained corners), over crest, over jump, don't cut, caution,
 * narrows, water, onto <surface>, flat over finish. Each note sits at its feature (cornerS = corner entry)
 * and triggers `lead` metres earlier, §5.7: purely positional, fired once when the player's s passes note.s.
 * The lead is authored from the expected approach speed: a fast-driver speed profile along the centre line
 * (curvature × road grip, 5 m/s² acceleration and 10 m/s² braking passes, 190 km/h cap) gives the fastest speed
 * in the 150 m before the feature, and lead = clamp(v · 2.5 s, 45 m, 170 m). Back-to-back features keep their
 * order (triggers ≥ 6 m apart), so a chained call can come early rather than late.
 */
import { SURFACE_INFO } from '../core/constants';
import type { Pacenote, PacenoteModifier, SurfaceId } from '../core/types';
import type { Centerline } from './centerline';
import type { Corner } from './corners';

export interface PacenoteHazard {
  s: number;
  kind: 'crest' | 'jump' | 'water' | 'narrows' | 'caution';
}

/**
 * Lateral grip (g) a fast driver uses per road surface for the approach-speed profile (≈ 75 % of §7 T4).
 * Appended original materials: the family's value × T4(surface) / T4(family) (tests/sim/harness.ts t4Lateral,
 * awd_wrc, matched tyre, best of 60 / 100 km/h: tarmac 2.76, gravel 1.90, mud 1.45, snow 1.43, sand 1.51;
 * asphaltGrass 1.98, leaf 1.90, gravelGrass 1.54, mudGrass 1.47, snowChunky 1.41, snowAsphalt = snow,
 * sandDark 1.51; wood 1.60 has no measurable family → 0.75 × T4). DEEP verges that cannot reach 60 km/h
 * (snowDeep, snowDitch, mudDitch, sandDeep, sandDarkDeep): family × gravelDeep / gravel (1.2 / 1.45).
 */
export const NOTE_GRIP_G: Readonly<Record<SurfaceId, number>> = Object.freeze({
  tarmac: 1.95,
  cobbles: 1.6,
  water: 1.2,
  gravel: 1.45,
  gravelDeep: 1.2,
  mud: 1.15,
  sand: 1.2,
  grass: 1.0,
  snow: 1.1,
  ice: 1.05,
  wood: 1.2,
  snowChunky: 1.1,
  snowDeep: 0.9,
  snowAsphalt: 1.1,
  snowDitch: 0.9,
  leaf: 1.35,
  asphaltGrass: 1.4,
  gravelGrass: 1.2,
  mudGrass: 1.15,
  mudDitch: 0.95,
  sandDeep: 1.0,
  sandDark: 1.2,
  sandDarkDeep: 1.0,
});
/** Warning time a call gets at the expected approach speed (s), and its bounds (m). */
export const NOTE_LEAD_S = 2.5;
export const NOTE_LEAD_MIN = 45;
export const NOTE_LEAD_MAX = 170;
const PROFILE_VMAX = 190 / 3.6;
const PROFILE_ACC = 5;
const PROFILE_BRAKE = 10;
const APPROACH_WINDOW = 150;

/**
 * Expected approach speed (m/s) along the centre line: v ≤ √(grip·9.81 / |κ|) (κ = max over ±6 m), then a
 * forward acceleration pass and a backward braking pass. Index i ↔ s = i·cl.ds.
 */
export function approachProfile(cl: Centerline, gripG: (s: number) => number = () => 1.45): Float64Array {
  const n = cl.n;
  const v = new Float64Array(n);
  const w = Math.max(1, Math.round(6 / cl.ds));
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let j = i - w; j <= i + w; j++) {
      const jj = cl.closed ? ((j % n) + n) % n : Math.min(n - 1, Math.max(0, j));
      k = Math.max(k, Math.abs(cl.kappa[jj]));
    }
    const a = 9.81 * Math.max(0.3, gripG(i * cl.ds));
    v[i] = k > 1e-6 ? Math.min(PROFILE_VMAX, Math.sqrt(a / k)) : PROFILE_VMAX;
  }
  const passes = cl.closed ? 2 : 1;
  for (let p = 0; p < passes; p++) {
    for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * PROFILE_ACC * cl.ds));
    if (cl.closed) v[0] = Math.min(v[0], Math.sqrt(v[n - 1] * v[n - 1] + 2 * PROFILE_ACC * cl.ds));
  }
  for (let p = 0; p < passes; p++) {
    for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * PROFILE_BRAKE * cl.ds));
    if (cl.closed) v[n - 1] = Math.min(v[n - 1], Math.sqrt(v[0] * v[0] + 2 * PROFILE_BRAKE * cl.ds));
  }
  return v;
}

/** Fastest profile speed over [s - window, s] (m/s). */
function approachSpeed(cl: Centerline, prof: Float64Array, s: number, window = APPROACH_WINDOW): number {
  const i1 = Math.min(prof.length - 1, Math.max(0, Math.round(s / cl.ds)));
  const i0 = Math.max(0, Math.round((s - window) / cl.ds));
  let m = 0;
  for (let i = i0; i <= i1; i++) m = Math.max(m, prof[i]);
  return m;
}

/** Trigger lead (m) for a feature at s: NOTE_LEAD_S of warning at the expected approach speed. */
export function noteLead(cl: Centerline, prof: Float64Array, s: number): number {
  return Math.min(NOTE_LEAD_MAX, Math.max(NOTE_LEAD_MIN, approachSpeed(cl, prof, s) * NOTE_LEAD_S));
}

export interface PacenoteInput {
  cl: Centerline;
  /** Road grip (g) at s for the approach-speed profile (default: gravel-like 1.45 g). */
  gripG?: (s: number) => number;
  corners: readonly Corner[];
  startS: number;
  finishS: number;
  /** Designed features (crests, jumps, water splash, narrows). Natural crests are detected here too. */
  hazards: readonly PacenoteHazard[];
  surfaceChanges: readonly { s: number; to: SurfaceId }[];
  /** Exposed (drop) side at s: corners whose outside is a drop get "caution". */
  exposed?: (s: number, side: number) => boolean;
}

interface NoteDraft {
  cornerS: number;
  /** End of the described feature (for the gap to the next one). */
  endS: number;
  corner: Corner | null;
  next: Corner | null;
  mods: Set<PacenoteModifier>;
  surface: SurfaceId | null;
  kind: 'corner' | 'crest' | 'jump' | 'water' | 'narrows' | 'caution' | 'surface' | 'finish';
}

const dirWord = (d: number): string => (d > 0 ? 'right' : 'left');
const sevWord = (c: Corner): string => (c.hairpin ? 'hairpin' : c.square ? 'square' : String(c.severity));

/** Natural crests: local maxima of the profile with strong convex curvature, away from designed ones. */
function naturalCrests(cl: Centerline, from: number, to: number): number[] {
  const out: number[] = [];
  const w = Math.max(1, Math.round(15 / cl.ds));
  for (let i = w; i < cl.n - w; i++) {
    const s = i * cl.ds;
    if (s < from || s > to) continue;
    const y = cl.y[i];
    let isMax = true;
    for (let j = i - w; j <= i + w; j++)
      if (cl.y[j] > y) {
        isMax = false;
        break;
      }
    if (!isMax) continue;
    const curv = (cl.grade[i + w] - cl.grade[i - w]) / (2 * w * cl.ds);
    if (curv < -1 / 160) out.push(s);
  }
  return out;
}

export function generatePacenotes(input: PacenoteInput): Pacenote[] {
  const { cl, startS, finishS } = input;
  const corners = input.corners.filter((c) => c.s1 > startS - 30 && c.s0 < finishS);
  const drafts: NoteDraft[] = [];
  // ---- corners, chained with "into" when the next one follows within 25 m
  const consumed = new Set<number>();
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    if (consumed.has(c.id)) continue;
    const mods = new Set<PacenoteModifier>();
    if (!c.hairpin && (c.angle > (100 * Math.PI) / 180 || (c.s1 - c.s0 > 90 && c.angle > (45 * Math.PI) / 180))) mods.add('long');
    if (c.kExit > c.kEntry * 1.6) mods.add('tightens');
    else if (c.kEntry > c.kExit * 1.6) mods.add('opens');
    if (c.dontCut) mods.add('dontCut');
    const prevEnd = i > 0 ? corners[i - 1].s1 : startS - 200;
    if ((c.severity <= 2 || c.hairpin) && c.s0 - prevEnd > 220) mods.add('caution');
    if (mods.has('tightens') && c.severity <= 2) mods.add('caution');
    if (input.exposed && input.exposed(0.5 * (c.s0 + c.s1), -c.dir)) mods.add('caution');
    let next: Corner | null = null;
    const n = corners[i + 1];
    if (n && n.s0 - c.s1 < 25) {
      next = n;
      mods.add('into');
      consumed.add(n.id);
    }
    drafts.push({ cornerS: c.s0, endS: next ? next.s1 : c.s1, corner: c, next, mods, surface: null, kind: 'corner' });
  }
  // ---- hazards: attach to a corner they fall in, else standalone notes
  const designedCrests = input.hazards.filter((h) => h.kind === 'crest' || h.kind === 'jump').map((h) => h.s);
  const hazards: PacenoteHazard[] = [...input.hazards];
  for (const s of naturalCrests(cl, startS + 20, finishS - 20)) {
    if (designedCrests.every((d) => Math.abs(d - s) > 40)) hazards.push({ s, kind: 'crest' });
  }
  hazards.sort((a, b) => a.s - b.s);
  for (const h of hazards) {
    if (h.s < startS + 5 || h.s > finishS) continue;
    const host = drafts.find((d) => d.kind === 'corner' && h.s >= d.cornerS - 25 && h.s <= d.endS);
    const mod: PacenoteModifier = h.kind === 'caution' ? 'caution' : h.kind;
    if (host && (h.kind === 'crest' || h.kind === 'jump' || h.kind === 'narrows' || h.kind === 'caution')) {
      host.mods.add(mod);
      continue;
    }
    const near = drafts.find((d) => d.kind === h.kind && Math.abs(d.cornerS - h.s) < 30);
    if (near) continue;
    drafts.push({ cornerS: h.s - (h.kind === 'crest' || h.kind === 'jump' ? 8 : 15), endS: h.s, corner: null, next: null, mods: new Set([mod]), surface: null, kind: h.kind });
  }
  // ---- surface changes
  for (const sc of input.surfaceChanges) {
    if (sc.s < startS + 5 || sc.s > finishS) continue;
    const host = drafts.find((d) => d.kind === 'corner' && sc.s >= d.cornerS - 30 && sc.s <= d.endS);
    if (host) {
      // keep the first change (entering the new surface is the call that matters)
      if (!host.surface) {
        host.mods.add('surfaceChange');
        host.surface = sc.to;
      }
    } else if (!drafts.some((d) => d.kind === 'surface' && Math.abs(d.cornerS - sc.s) < 40)) drafts.push({ cornerS: sc.s, endS: sc.s, corner: null, next: null, mods: new Set(['surfaceChange']), surface: sc.to, kind: 'surface' });
  }
  // ---- finish
  drafts.push({ cornerS: finishS, endS: finishS, corner: null, next: null, mods: new Set(['overFinish']), surface: null, kind: 'finish' });
  drafts.sort((a, b) => a.cornerS - b.cornerS);

  // ---- triggers (monotonic) and text
  const prof = approachProfile(cl, input.gripG);
  const notes: Pacenote[] = [];
  let prevS = -Infinity;
  for (const d of drafts) {
    const lead = noteLead(cl, prof, d.cornerS);
    let s = d.cornerS - lead;
    if (s < prevS + 6) s = Math.min(d.cornerS - 4, prevS + 6);
    if (s <= prevS) s = prevS + 0.5;
    s = Math.max(0, s);
    if (s <= prevS) s = prevS + 0.5;
    prevS = s;
    notes.push(toNote(d, s));
  }
  return notes;
}

function toNote(d: NoteDraft, s: number): Pacenote {
  const order: PacenoteModifier[] = ['long', 'tightens', 'opens', 'crest', 'jump', 'narrows', 'water', 'dontCut', 'into', 'surfaceChange', 'overFinish'];
  const mods = [...d.mods];
  mods.sort((a, b) => {
    const ia = a === 'caution' ? -1 : order.indexOf(a);
    const ib = b === 'caution' ? -1 : order.indexOf(b);
    return ia - ib;
  });
  const words: string[] = [];
  if (d.mods.has('caution')) words.push('caution');
  let direction: Pacenote['direction'] = 'straight';
  let severity: Pacenote['severity'] = 0;
  const c = d.corner;
  if (c) {
    words.push(`${sevWord(c)} ${dirWord(c.dir)}`);
    direction = c.dir > 0 ? 'right' : 'left';
    severity = c.hairpin ? 1 : c.square ? (Math.min(2, c.severity) as 1 | 2) : c.severity;
    if (d.mods.has('long')) words.push('long');
    if (d.mods.has('tightens')) words.push('tightens');
    if (d.mods.has('opens')) words.push('opens');
    if (d.mods.has('crest')) words.push('over crest');
    if (d.mods.has('jump')) words.push('over jump');
    if (d.mods.has('narrows')) words.push('narrows');
    if (d.mods.has('dontCut')) words.push("don't cut");
    if (d.next) words.push(`into ${sevWord(d.next)} ${dirWord(d.next.dir)}`);
  } else {
    switch (d.kind) {
      case 'crest':
        words.push('crest');
        break;
      case 'jump':
        words.push('jump', 'keep straight');
        break;
      case 'water':
        words.push('water splash');
        break;
      case 'narrows':
        words.push('narrows');
        break;
      case 'finish':
        words.push('flat over finish');
        break;
      default:
        break;
    }
  }
  if (d.surface) words.push(`onto ${SURFACE_INFO[d.surface].name.toLowerCase()}`);
  return { s, cornerS: d.cornerS, text: words.join(' ').trim() || 'caution', direction, severity, modifiers: mods };
}
