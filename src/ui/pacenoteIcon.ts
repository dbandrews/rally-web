/**
 * src/ui/pacenoteIcon.ts — game builder. Original pacenote glyphs: a curved arrow whose bend follows the
 * severity ladder (6 = barely bending … 1 = hairpin), mirrored for left/right; hazard glyphs for straight /
 * crest / jump notes.
 */
import type { Pacenote } from '../core/types';

/** Turn angle (deg) and radius per severity 1..6. */
const BEND: Record<number, [number, number]> = {
  1: [178, 12],
  2: [135, 14],
  3: [100, 17],
  4: [72, 22],
  5: [48, 29],
  6: [28, 38],
};

const fmt = (n: number) => n.toFixed(1);

function arrowPath(dirSign: number, severity: number): { d: string; tip: [number, number]; heading: number } {
  const [deg, R] = BEND[severity] ?? BEND[4];
  const th = (deg * Math.PI) / 180;
  const x0 = 50 - dirSign * (severity <= 2 ? 14 : 6);
  const y0 = 92;
  const y1 = severity <= 2 ? 52 : 58;
  // circle centre to the turning side of the upward heading
  const cx = x0 + dirSign * R;
  const cy = y1;
  const ex = cx - dirSign * R * Math.cos(th);
  const ey = cy - R * Math.sin(th);
  const large = deg > 180 ? 1 : 0;
  const sweep = dirSign > 0 ? 1 : 0;
  const d = `M${fmt(x0)} ${y0} L${fmt(x0)} ${y1} A${R} ${R} 0 ${large} ${sweep} ${fmt(ex)} ${fmt(ey)}`;
  // heading at the end (screen coords): (dirSign·sinθ, -cosθ)
  const heading = Math.atan2(-Math.cos(th), dirSign * Math.sin(th));
  return { d, tip: [ex, ey], heading };
}

function head(tip: [number, number], heading: number): string {
  const [x, y] = tip;
  const L = 15;
  const W = 12;
  const hx = Math.cos(heading);
  const hy = Math.sin(heading);
  const px = -hy;
  const py = hx;
  const ax = x + hx * L * 0.75;
  const ay = y + hy * L * 0.75;
  const bx = x - hx * L * 0.25 + px * W;
  const by = y - hy * L * 0.25 + py * W;
  const cx = x - hx * L * 0.25 - px * W;
  const cy = y - hy * L * 0.25 - py * W;
  return `<path d="M${fmt(ax)} ${fmt(ay)} L${fmt(bx)} ${fmt(by)} L${fmt(cx)} ${fmt(cy)} Z" fill="currentColor"/>`;
}

/** Inline SVG (viewBox 0 0 100 100) for a note. */
export function pacenoteSvg(note: Pick<Pacenote, 'direction' | 'severity' | 'modifiers'>): string {
  const mods = note.modifiers ?? [];
  const open = '<svg viewBox="0 0 100 100" aria-hidden="true" style="color:#fff">';
  if (note.direction === 'straight' || note.severity === 0) {
    if (mods.includes('jump') || mods.includes('crest') || mods.includes('bump')) {
      const jump = mods.includes('jump');
      return (
        open +
        `<path d="M8 80 Q50 ${jump ? 18 : 34} 92 80" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>` +
        (jump ? '<path d="M50 30 L50 8 M40 18 L50 6 L60 18" fill="none" stroke="#ffb81c" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>' : '') +
        '</svg>'
      );
    }
    if (mods.includes('caution') || mods.includes('narrows') || mods.includes('water') || mods.includes('bridge')) {
      return (
        open +
        '<path d="M50 10 L92 86 L8 86 Z" fill="none" stroke="#ffb81c" stroke-width="8" stroke-linejoin="round"/>' +
        '<path d="M50 38 L50 62" stroke="currentColor" stroke-width="9" stroke-linecap="round"/><circle cx="50" cy="75" r="5" fill="currentColor"/></svg>'
      );
    }
    return open + '<path d="M50 92 L50 30" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>' + head([50, 30], -Math.PI / 2) + '</svg>';
  }
  const sign = note.direction === 'right' ? 1 : -1;
  const sev = Math.max(1, Math.min(6, note.severity));
  const a = arrowPath(sign, sev);
  return (
    open +
    `<path d="${a.d}" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>` +
    head(a.tip, a.heading) +
    '</svg>'
  );
}

/** Short display labels for modifiers (our own wording). */
export const MODIFIER_LABEL: Readonly<Record<string, string>> = Object.freeze({
  long: 'long',
  short: 'short',
  tightens: 'tightens',
  opens: 'opens',
  into: 'into',
  dontCut: "don't cut",
  cut: 'cut',
  crest: 'crest',
  jump: 'jump',
  bump: 'bump',
  caution: 'caution',
  narrows: 'narrows',
  bridge: 'bridge',
  water: 'water',
  surfaceChange: 'surface',
  overFinish: 'finish',
});

export const WARN_MODIFIERS: ReadonlySet<string> = new Set(['dontCut', 'caution', 'jump', 'crest', 'narrows', 'tightens']);
