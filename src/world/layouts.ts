/**
 * src/world/layouts.ts — control-point generators for the stage centre lines (THREE xz).
 *
 *  - rallyLayout: point-to-point "turtle" walk of straights and constant-radius corners whose heading
 *    follows a slowly drifting / meandering target (keeps the stage compact and non-crossing), with
 *    optional switchback pairs (two opposite hairpins whose legs diverge).
 *  - hillclimbLayout: zig-zag legs across a slope (uphill = -Z) joined by hairpins.
 *  - loopLayout: closed circuit from a corner template; two free straights are solved so the loop closes
 *    exactly (position and heading).
 * The pipeline (builder.ts) validates every attempt (curvature, self-clearance, size) and retries.
 */
import type { Rng } from '../core/rng';
import {
  closeLoop,
  controlPointsFromPath,
  integrateTurtle,
  totalTurn,
  type P2,
  type PathFeature,
} from './spline';

const DEG = Math.PI / 180;
const wrap = (a: number): number => {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  else if (r < -Math.PI) r += 2 * Math.PI;
  return r;
};

export interface LayoutOut {
  control: P2[];
  /** Named arc-length marks along the generating path (approximate s on the final line). */
  marks: Record<string, number[]>;
}

export interface CornerKind {
  w: number;
  R: [number, number];
  /** Degrees. */
  ang: [number, number];
}

export interface RallyStyle {
  length: number;
  runIn: number;
  runOut: number;
  straight: [number, number];
  longStraightProb: number;
  longStraight: [number, number];
  corners: CornerKind[];
  chicaneProb: number;
  intoProb: number;
  switchbacks: number;
  hairpinR: [number, number];
  switchLeg: [number, number];
  /** Leg divergence of a switchback (deg). */
  switchDiverge: [number, number];
  /** Drift of the target heading over the whole stage (deg, sign random). */
  totalTurn: [number, number];
  meanderAmp: number;
  meanderPeriod: number;
  /** Max deviation from the target heading before corners are forced back (deg). */
  maxDev: number;
}

const straight = (len: number, tag?: string): PathFeature => ({ kind: 'straight', len, tag });
const arc = (radius: number, angleRad: number, dir: 1 | -1, tag?: string): PathFeature => ({ kind: 'arc', radius, angle: angleRad, dir, tag });

function pickKind(rng: Rng, kinds: readonly CornerKind[]): CornerKind {
  let tot = 0;
  for (const k of kinds) tot += k.w;
  let r = rng.next() * tot;
  for (const k of kinds) {
    r -= k.w;
    if (r <= 0) return k;
  }
  return kinds[kinds.length - 1];
}

function marksFrom(feats: PathFeature[], step = 1): { path: ReturnType<typeof integrateTurtle>; marks: Record<string, number[]> } {
  const path = integrateTurtle(feats, { x: 0, z: 0, heading: 0 }, step);
  const marks: Record<string, number[]> = {};
  for (const sp of path.spans) {
    const t = sp.feature.tag;
    if (!t) continue;
    (marks[t] ??= []).push(sp.s0, sp.s1);
  }
  return { path, marks };
}

export function rallyLayout(rng: Rng, st: RallyStyle): LayoutOut {
  const feats: PathFeature[] = [];
  const total = rng.range(st.totalTurn[0], st.totalTurn[1]) * DEG * (rng.next() < 0.5 ? -1 : 1);
  const phase = rng.next() * Math.PI * 2;
  const desired = (s: number): number =>
    total * (s / st.length) + st.meanderAmp * DEG * Math.sin((2 * Math.PI * s) / st.meanderPeriod + phase);
  let s = 0;
  let h = 0;
  const push = (f: PathFeature): void => {
    feats.push(f);
    if (f.kind === 'straight') s += f.len;
    else {
      s += f.radius * f.angle;
      h += f.dir * f.angle;
    }
  };
  push(straight(st.runIn, 'runIn'));
  const sbAt: number[] = [];
  for (let k = 0; k < st.switchbacks; k++) sbAt.push(st.length * (0.2 + (0.6 * (k + 0.25 + rng.next() * 0.5)) / st.switchbacks));
  let nextSb = 0;
  while (s < st.length - st.runOut) {
    if (nextSb < sbAt.length && s >= sbAt[nextSb]) {
      nextSb++;
      push(straight(rng.range(40, 80)));
      // turn toward the target heading first so the pair continues the stage's general direction
      const dev = wrap(h - desired(s));
      const d: 1 | -1 = dev > 0 ? -1 : 1;
      const div = rng.range(st.switchDiverge[0], st.switchDiverge[1]) * DEG;
      push(arc(rng.range(st.hairpinR[0], st.hairpinR[1]), Math.PI - div, d, 'hairpin'));
      push(straight(rng.range(st.switchLeg[0], st.switchLeg[1]), 'switchLeg'));
      push(arc(rng.range(st.hairpinR[0], st.hairpinR[1]), Math.PI - div, d === 1 ? -1 : 1, 'hairpin'));
      push(straight(rng.range(50, 90)));
      continue;
    }
    const prevArc = feats[feats.length - 1].kind === 'arc';
    if (!prevArc || rng.next() >= st.intoProb) {
      const L = rng.next() < st.longStraightProb ? rng.range(st.longStraight[0], st.longStraight[1]) : rng.range(st.straight[0], st.straight[1]);
      push(straight(L, L > 150 ? 'longStraight' : undefined));
    }
    const ck = pickKind(rng, st.corners);
    const R = rng.range(ck.R[0], ck.R[1]);
    const ang = rng.range(ck.ang[0], ck.ang[1]) * DEG;
    const dev = wrap(h - desired(s));
    let dir: 1 | -1;
    if (Math.abs(dev) > st.maxDev * DEG) dir = dev > 0 ? -1 : 1;
    else if (Math.abs(dev) < 10 * DEG) dir = rng.next() < 0.5 ? 1 : -1;
    else dir = rng.next() < 0.72 ? (dev > 0 ? -1 : 1) : dev > 0 ? 1 : -1;
    push(arc(R, ang, dir));
    if (rng.next() < st.chicaneProb) {
      push(straight(rng.range(0, 15)));
      push(arc(R * rng.range(0.8, 1.3), ang * rng.range(0.7, 1.1), dir === 1 ? -1 : 1));
    }
  }
  push(straight(st.runOut + 20, 'runOut'));
  const { path, marks } = marksFrom(feats);
  return { control: controlPointsFromPath(path, false), marks };
}

export interface HillStyle {
  legs: number;
  legLen: [number, number];
  /** Leg angle above the contour (deg). */
  alpha: number;
  hairpinR: [number, number];
  bendsPerLeg: number;
  bendR: [number, number];
  bendAng: [number, number];
  runIn: number;
  runOut: number;
}

/** Zig-zag climb toward -Z: legs head ±(90° - alpha) and are joined by hairpins. */
export function hillclimbLayout(rng: Rng, st: HillStyle): LayoutOut {
  const a = st.alpha * DEG;
  const target = (leg: number): number => (leg % 2 === 0 ? Math.PI / 2 - a : -(Math.PI / 2 - a));
  const feats: PathFeature[] = [];
  let h = target(0);
  const push = (f: PathFeature): void => {
    feats.push(f);
    if (f.kind === 'arc') h += f.dir * f.angle;
  };
  push(straight(st.runIn, 'runIn'));
  for (let leg = 0; leg < st.legs; leg++) {
    const len = rng.range(st.legLen[0], st.legLen[1]) - (leg === 0 ? st.runIn * 0.5 : 0);
    let used = 0;
    // a symmetric wiggle (+a, -2a, +a) so the leg's average heading stays on target (constant climb rate)
    for (let b = 0; b < st.bendsPerLeg; b++) {
      const a1 = rng.range(st.bendAng[0], st.bendAng[1]) * DEG * 0.5;
      const d: 1 | -1 = rng.next() < 0.5 ? 1 : -1;
      const R = rng.range(st.bendR[0], st.bendR[1]);
      const s1 = (len / (st.bendsPerLeg + 1)) * rng.range(0.4, 0.7);
      const s2 = rng.range(20, 45);
      push(straight(s1));
      push(arc(R, a1, d));
      push(straight(s2));
      push(arc(R, 2 * a1, d === 1 ? -1 : 1));
      push(straight(s2));
      push(arc(R, a1, d));
      used += s1 + 2 * s2 + 4 * R * a1;
    }
    // straighten to the leg heading before the hairpin (numerical drift only)
    const dev = wrap(h - target(leg));
    if (Math.abs(dev) > 0.5 * DEG) {
      const R = 120;
      push(straight(10));
      push(arc(R, Math.abs(dev), dev > 0 ? -1 : 1));
      used += 10 + R * Math.abs(dev);
    }
    if (leg === st.legs - 1) {
      push(straight(Math.max(30, len - used) + st.runOut, 'runOut'));
      break;
    }
    push(straight(Math.max(25, len - used)));
    // hairpin: even legs end with a left (toward -Z), odd legs with a right
    const hd: 1 | -1 = leg % 2 === 0 ? -1 : 1;
    const ang = Math.abs(wrap(target(leg + 1) - h)) || Math.PI - 2 * a;
    const angle = Math.min(Math.PI - 2 * a + 25 * DEG, Math.max(Math.PI - 2 * a - 25 * DEG, ang));
    push(arc(rng.range(st.hairpinR[0], st.hairpinR[1]), angle, hd, 'hairpin'));
    push(straight(rng.range(15, 30)));
  }
  const path = integrateTurtle(feats, { x: 0, z: 0, heading: target(0) }, 1);
  const marks: Record<string, number[]> = {};
  for (const sp of path.spans) if (sp.feature.tag) (marks[sp.feature.tag] ??= []).push(sp.s0, sp.s1);
  return { control: controlPointsFromPath(path, false), marks };
}

/** Closed-loop template element. Straights with free=true get solved for closure (exactly two). */
export type LoopItem =
  | { kind: 'straight'; len: number; free?: boolean; tag?: string }
  | { kind: 'arc'; R: number; ang: number; dir: 1 | -1; adjust?: boolean; tag?: string };

export interface LoopTemplate {
  items: LoopItem[];
  /** Total signed turn: +1 = clockwise from above with right turns (+360°), -1 = left (-360°). */
  sense: 1 | -1;
  jitterR: number;
  jitterAng: number;
  jitterLen: number;
  minFree: number;
}

export function loopLayout(rng: Rng, tpl: LoopTemplate, startHeading = Math.PI / 2): LayoutOut {
  for (let tries = 0; tries < 40; tries++) {
    const feats: PathFeature[] = [];
    let adjustIdx = -1;
    const free: number[] = [];
    for (const it of tpl.items) {
      if (it.kind === 'straight') {
        if (it.free) free.push(feats.length);
        feats.push(straight(it.free ? 0 : it.len * (1 + (rng.next() * 2 - 1) * tpl.jitterLen), it.tag));
      } else {
        if (it.adjust) adjustIdx = feats.length;
        const R = it.R * (1 + (rng.next() * 2 - 1) * tpl.jitterR);
        const ang = it.ang * DEG * (it.adjust ? 1 : 1 + (rng.next() * 2 - 1) * tpl.jitterAng);
        feats.push(arc(R, ang, it.dir, it.tag));
      }
    }
    if (adjustIdx >= 0) {
      const f = feats[adjustIdx] as Extract<PathFeature, { kind: 'arc' }>;
      f.angle = 0;
      const rest = totalTurn(feats);
      const need = (tpl.sense * 2 * Math.PI - rest) * f.dir;
      if (need < 15 * DEG || need > 200 * DEG) continue;
      f.angle = need;
    }
    if (free.length !== 2) throw new Error('loopLayout: template needs exactly two free straights');
    if (!closeLoop(feats, free[0], free[1], tpl.minFree)) continue;
    // closure is rotation invariant: solved with heading 0, built with the requested start heading
    const path = integrateTurtle(feats, { x: 0, z: 0, heading: startHeading }, 1);
    const marks: Record<string, number[]> = {};
    for (const sp of path.spans) if (sp.feature.tag) (marks[sp.feature.tag] ??= []).push(sp.s0, sp.s1);
    return { control: controlPointsFromPath(path, true), marks };
  }
  throw new Error('loopLayout: could not close the template');
}

/** Exact loop from explicit features (testpad). */
export function loopFromFeatures(feats: PathFeature[], start: { x: number; z: number; heading: number }): LayoutOut {
  const path = integrateTurtle(feats, start, 1);
  const marks: Record<string, number[]> = {};
  for (const sp of path.spans) if (sp.feature.tag) (marks[sp.feature.tag] ??= []).push(sp.s0, sp.s1);
  return { control: controlPointsFromPath(path, true), marks };
}
