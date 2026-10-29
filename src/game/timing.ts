/**
 * src/game/timing.ts — game builder. Pure timing helpers for the race controller (no DOM, no three).
 *
 * Timing gates unify point-to-point stages and lap circuits: every timed line (intermediate checkpoint, lap
 * line, finish) becomes a gate at a route distance `dist` measured along the centre spline from the start
 * line. The race controller tracks the car's route distance (wrapping across the lap line on closed stages)
 * and crosses gates in order. The crossing time is interpolated inside the physics step (ms resolution).
 */
import type { Stage } from '../core/types';

export type GateKind = 'checkpoint' | 'lap' | 'finish';

export interface TimingGate {
  /** Route distance from the start line (m), increasing over the gate list. */
  dist: number;
  kind: GateKind;
  /** 1-based lap the gate belongs to. */
  lap: number;
  /** Index within the lap: 0..checkpoints.length-1 for checkpoints, checkpoints.length for lap/finish lines. */
  index: number;
}

type GateStage = Pick<Stage, 'closed' | 'length' | 'laps' | 'startS' | 'finishS' | 'checkpoints' | 'discipline'>;

const mod = (a: number, m: number): number => ((a % m) + m) % m;

/** Signed shortest difference b - a on a loop of length L. */
export function wrapDelta(ds: number, L: number): number {
  if (!(L > 0)) return ds;
  let d = mod(ds, L);
  if (d > L / 2) d -= L;
  return d;
}

/**
 * Build the ordered gate list for a stage. Testpads have no gates (no finish, §5.4 note).
 *  - point-to-point: checkpoints (s > startS) then the finish at finishS.
 *  - closed: per lap the checkpoints (relative to the lap line) then the lap line; the last lap line is the
 *    finish. When the start grid sits shortly behind the lap line (< half a lap), the first crossing only
 *    starts lap 1 and is not a gate.
 */
export function buildGates(stage: GateStage): TimingGate[] {
  const gates: TimingGate[] = [];
  if (stage.discipline === 'testpad') return gates;
  const cps = [...stage.checkpoints].sort((a, b) => a - b);
  if (!stage.closed) {
    cps.forEach((s, i) => {
      const d = s - stage.startS;
      if (d > 0.5 && s < stage.finishS) gates.push({ dist: d, kind: 'checkpoint', lap: 1, index: i });
    });
    gates.push({ dist: Math.max(0.5, stage.finishS - stage.startS), kind: 'finish', lap: 1, index: cps.length });
    return gates;
  }
  const L = stage.length;
  const laps = Math.max(1, Math.floor(stage.laps || 1));
  const df = mod(stage.finishS - stage.startS, L);
  // route distance of the first lap COMPLETION
  const base = df < 1e-6 ? L : df < 0.5 * L ? df + L : df;
  for (let lap = 1; lap <= laps; lap++) {
    const end = base + (lap - 1) * L;
    const lapStart = end - L;
    cps.forEach((s, i) => {
      const rel = mod(s - stage.finishS, L);
      const d = lapStart + rel;
      if (rel > 0.5 && rel < L - 0.5 && d > 0.5) gates.push({ dist: d, kind: 'checkpoint', lap, index: i });
    });
    gates.push({ dist: end, kind: lap === laps ? 'finish' : 'lap', lap, index: cps.length });
  }
  gates.sort((a, b) => a.dist - b.dist);
  return gates;
}

/**
 * Time at which `gateDist` was crossed, interpolated linearly between the previous step (prevDist at
 * time - dt) and this step (dist at time).
 */
export function crossingTime(time: number, dt: number, prevDist: number, dist: number, gateDist: number): number {
  const span = dist - prevDist;
  if (!(span > 1e-9)) return time;
  const f = Math.min(1, Math.max(0, (dist - gateDist) / span));
  return time - f * dt;
}

/** Round to whole milliseconds (all displayed and stored times). */
export const roundMs = (t: number): number => Math.round(t * 1000) / 1000;

/** "m:ss.mmm" (or "h:mm:ss.mmm"). Negative values get a leading "-". */
export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return '-:--.---';
  const neg = t < 0;
  let ms = Math.round(Math.abs(t) * 1000);
  const h = Math.floor(ms / 3600000);
  ms -= h * 3600000;
  const m = Math.floor(ms / 60000);
  ms -= m * 60000;
  const s = Math.floor(ms / 1000);
  ms -= s * 1000;
  const core = `${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${core}` : `${m}:${core}`;
  return neg ? `-${body}` : body;
}

/** Split delta "+1.234" / "-0.456" (seconds, ms precision). */
export function formatDelta(d: number | null | undefined): string {
  if (d === null || d === undefined || !Number.isFinite(d)) return '';
  const ms = Math.round(d * 1000);
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : '±';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}`;
}
