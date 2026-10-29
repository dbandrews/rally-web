/**
 * src/world/corners.ts — corner detection on the centre-line curvature profile (shared by pacenotes and
 * scenery: don't-cut rocks, hairpin signs, tyre walls on the outside of rallycross bends).
 */
import type { Centerline } from './centerline';
import { gaussianSmooth } from './profile';

export interface Corner {
  id: number;
  /** +1 = right-hander, -1 = left-hander. */
  dir: 1 | -1;
  /** Entry / exit / apex arc length (m). s1 may exceed the lap length on closed lines (unwrapped). */
  s0: number;
  s1: number;
  apexS: number;
  /** Total turn (rad, > 0). */
  angle: number;
  /** Tightest radius (m). */
  minR: number;
  /** Mean curvature of the first and last 35 % (1/m). */
  kEntry: number;
  kExit: number;
  /** Classic scale: 6 = fastest ... 1 = hairpin-tight. */
  severity: 1 | 2 | 3 | 4 | 5 | 6;
  hairpin: boolean;
  square: boolean;
  /** Filled in by scenery placement: hidden rocks on the inside. */
  dontCut: boolean;
}

const K_ON = 1 / 320;
const MIN_ANGLE = (12 * Math.PI) / 180;

export function severityFor(minR: number, angle: number): 1 | 2 | 3 | 4 | 5 | 6 {
  let sev: number;
  if (minR >= 200) sev = 6;
  else if (minR >= 125) sev = 5;
  else if (minR >= 80) sev = 4;
  else if (minR >= 50) sev = 3;
  else if (minR >= 28) sev = 2;
  else sev = 1;
  // short kinks are faster than their radius suggests
  if (angle < (25 * Math.PI) / 180 && sev < 6) sev++;
  return sev as 1 | 2 | 3 | 4 | 5 | 6;
}

export function analyzeCorners(cl: Centerline): Corner[] {
  const n = cl.n;
  const ds = cl.ds;
  const k = gaussianSmooth(cl.kappa, 3 / ds, cl.closed);
  const on = (i: number): number => {
    const v = k[cl.idx(i)];
    return v > K_ON ? 1 : v < -K_ON ? -1 : 0;
  };
  // closed lines: start scanning at a straight point so no corner wraps the seam
  let start = 0;
  if (cl.closed) {
    for (let i = 0; i < n; i++)
      if (on(i) === 0) {
        start = i;
        break;
      }
  }
  const end = cl.closed ? start + n : n;
  type Run = { a: number; b: number; dir: number };
  const runs: Run[] = [];
  let i = start;
  while (i < end) {
    const d = on(i);
    if (d === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < end && on(j + 1) === d) j++;
    runs.push({ a: i, b: j, dir: d });
    i = j + 1;
  }
  // merge same-direction runs separated by short gaps
  const merged: Run[] = [];
  const gapMax = Math.round(10 / ds);
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.dir === r.dir && r.a - last.b <= gapMax) last.b = r.b;
    else merged.push({ ...r });
  }
  const corners: Corner[] = [];
  for (const r of merged) {
    let angle = 0;
    let kmax = 0;
    let apex = r.a;
    for (let q = r.a; q <= r.b; q++) {
      const v = Math.abs(k[cl.idx(q)]);
      angle += v * ds;
      if (v > kmax) {
        kmax = v;
        apex = q;
      }
    }
    if (angle < MIN_ANGLE) continue;
    const len = r.b - r.a + 1;
    const third = Math.max(1, Math.floor(len * 0.35));
    let kin = 0;
    let kout = 0;
    for (let q = 0; q < third; q++) {
      kin += Math.abs(k[cl.idx(r.a + q)]);
      kout += Math.abs(k[cl.idx(r.b - q)]);
    }
    kin /= third;
    kout /= third;
    const minR = 1 / Math.max(kmax, 1e-9);
    const hairpin = angle >= (130 * Math.PI) / 180 && minR < 35;
    const square = !hairpin && angle >= (70 * Math.PI) / 180 && angle <= (115 * Math.PI) / 180 && minR < 32 && len * ds < 1.5 * minR * angle;
    corners.push({
      id: corners.length,
      dir: r.dir > 0 ? 1 : -1,
      s0: r.a * ds,
      s1: (r.b + 1) * ds,
      apexS: apex * ds,
      angle,
      minR,
      kEntry: kin,
      kExit: kout,
      severity: hairpin ? 1 : severityFor(minR, angle),
      hairpin,
      square,
      dontCut: false,
    });
  }
  corners.sort((a, b) => a.s0 - b.s0);
  corners.forEach((c, idx) => (c.id = idx));
  return corners;
}
