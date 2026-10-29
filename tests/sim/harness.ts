/**
 * tests/sim/harness.ts — OWNED BY THE SIM BUILDER.
 *
 * §7.1 feel-validation harness: car factory on the flat world, the speed-hold and cornering bots, and one
 * scenario function per §7 test. Mirrors tools/reference/spec_sim_check.py (spawn at rest with wheels
 * touching, 100 settle steps with handbrake 1.0, inputs straight into Controls, 120 Hz).
 * Used by tests/sim/feel.test.ts.
 */
import { DT, G_REPORT, MATCHED_TYRE } from '../../src/core/constants';
import { clamp, qAxes } from '../../src/core/math';
import type { ArchetypeId, CarParams, Controls, DeepPartial, SurfaceId, TyreType, WorldQuery } from '../../src/core/types';
import { CarSim } from '../../src/sim/car';
import { makeCarParams, makeSurfaceTable } from '../../src/sim/params';
import { createFlatWorld, flatSpawnPose } from './flatworld';

export const ctl = (c: Partial<Controls> = {}): Controls => ({
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: 0,
  gearUp: false,
  gearDown: false,
  ...c,
});

export interface CarOpts {
  car?: ArchetypeId;
  surface?: SurfaceId;
  /** Default: matched to the surface (§7.1). */
  tyre?: TyreType;
  params?: DeepPartial<CarParams>;
  world?: WorldQuery;
  /** Body origin height above the plane at spawn (reference: 0.4225 m, wheels touching). */
  raise?: number;
  heading?: number;
  x?: number;
  z?: number;
  seed?: number;
  settle?: number;
}

/** Spawn + 100 settle steps (§7.1). */
export function makeCar(o: CarOpts = {}): CarSim {
  const surface = o.surface ?? 'tarmac';
  const world = o.world ?? createFlatWorld({ surface });
  const params = makeCarParams(o.car ?? 'awd_wrc', { tyreType: o.tyre ?? MATCHED_TYRE[surface], ...(o.params ?? {}) });
  const car = new CarSim({ params, world, surfaces: makeSurfaceTable(), seed: o.seed ?? 1 });
  car.reset(flatSpawnPose(world, o.x ?? 0, o.z ?? 0, o.heading ?? 0, o.raise ?? 0.4225), o.settle ?? 100);
  return car;
}

/** Forward speed km/h = |vL.z|·3.6 (§7.1), vL = the §1.4 B.vL state (as the reference bots read it). */
export const kmh = (car: CarSim): number => Math.abs(car.debug().vL.z) * 3.6;
export const kmhWorld = (car: CarSim): number => car.telemetry().speedWorldKmh;

/** Heading (sim yaw) of the car, rad. */
export function heading(car: CarSim): number {
  const f = qAxes(car.telemetry().quatSim).fwd;
  return Math.atan2(f.x, f.z);
}

export function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** §7.1 metric: body-frame x of total world force / mass, in g (9.81). */
export function aLatG(car: CarSim): number {
  const d = car.debug();
  const f = d.forceWorld;
  return (d.right.x * f.x + d.right.y * f.y + d.right.z * f.z) / d.mass / G_REPORT;
}

/** §7.1 speed-hold bot. */
export function speedHold(car: CarSim, vT: number): Controls {
  const v = kmh(car);
  return ctl({ throttle: v < vT ? clamp((vT - v) * 0.2 + 0.3, 0, 1) : 0 });
}

/** §7.1 cornering bot (constant steer). */
export function cornering(car: CarSim, vT: number, steer: number): Controls {
  return ctl({ steer, throttle: clamp((vT - kmhWorld(car)) * 0.15 + 0.35, 0, 1) });
}

/** Run the speed-hold bot until |v - vT| < 0.5 after ≥ 3 s. */
export function reachSpeed(car: CarSim, vT: number, tmax = 40): boolean {
  let t = 0;
  while (t < tmax) {
    car.step(speedHold(car, vT), DT);
    t += DT;
    if (t >= 3 && Math.abs(kmh(car) - vT) < 0.5) return true;
  }
  return false;
}

/**
 * Start states for the power tests (§7.1 "power-test start"). The turbo state at the throttle step decides the
 * outcome (§2.3.3: ×(1 + thr/40) per step above half throttle, decay below), so it is made explicit:
 *  - 'spec':    the literal §7.1 protocol (the first |v - vT| < 0.5 crossing after ≥ 3 s); the boost is whatever
 *               the speed-hold bot left (0.1-1.0 depending on car and surface).
 *  - 'steady':  then 3 s more of the speed-hold bot: a steady cruise, the turbo has decayed to idle.
 *  - 'spooled': 'steady', then 3 s of left-foot braking (throttle 1, brake holding vT): turbo at the waste gate.
 */
export type PowerStart = 'spec' | 'steady' | 'spooled';
export const STEADY_HOLD_S = 3;

/** Reach vT and put the car in the given power-test start state. Returns the boost fraction at the end. */
export function powerStart(car: CarSim, vT: number, start: PowerStart = 'steady'): number {
  reachSpeed(car, vT);
  if (start !== 'spec') run(car, STEADY_HOLD_S, () => speedHold(car, vT));
  if (start === 'spooled') run(car, STEADY_HOLD_S, () => ctl({ throttle: 1, brake: clamp((kmh(car) - vT) * 0.25 + 0.3, 0, 1) }));
  return car.telemetry().boostFrac;
}

/** Run `T` seconds; ctrl(t) gives the controls for the step starting at t; rec(t) after each step (t = end). */
export function run(car: CarSim, T: number, ctrl: (t: number) => Controls, rec?: (t: number) => void): void {
  const n = Math.round(T / DT);
  for (let k = 0; k < n; k++) {
    car.step(ctrl(k * DT), DT);
    rec?.((k + 1) * DT);
  }
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

// ------------------------------------------------------------------------------------------- scenarios

export interface T1Result {
  t60: number | null;
  t100: number | null;
  t160: number | null;
  vtop: number;
  gear: number;
  shifts: { from: number; to: number; kmhWorld: number; t: number }[];
  /** Steps with zero drive torque on all wheels during each upshift. */
  shiftZeroSteps: number[];
}

/** T1 / T2 / T16 full throttle from rest. */
export function t1Accel(o: CarOpts, T = 20): T1Result {
  const car = makeCar(o);
  const marks: Record<number, number | null> = { 60: null, 100: null, 160: null };
  const shifts: T1Result['shifts'] = [];
  const shiftZeroSteps: number[] = [];
  let lastGear = car.telemetry().gear;
  let zeroRun = 0;
  run(
    car,
    T,
    () => ctl({ throttle: 1 }),
    (t) => {
      const tel = car.telemetry();
      for (const m of [60, 100, 160]) if (marks[m] === null && tel.speedKmh >= m) marks[m] = t;
      if (tel.shifting && tel.wheels.every((w) => w.driveT <= 0)) zeroRun++;
      if (tel.gear !== lastGear) {
        shifts.push({ from: lastGear, to: tel.gear, kmhWorld: tel.speedWorldKmh, t });
        if (tel.gear > lastGear) shiftZeroSteps.push(zeroRun);
        zeroRun = 0;
        lastGear = tel.gear;
      }
    },
  );
  const tel = car.telemetry();
  return { t60: marks[60], t100: marks[100], t160: marks[160], vtop: tel.speedKmh, gear: tel.gear, shifts, shiftZeroSteps };
}

/** T3 braking from steady 100 km/h (or an initialised speed). Distance / time to < 0.2 km/h. */
export function t3Brake(o: CarOpts, init?: { kmh: number; gear: number }): { v0: number; dist: number; time: number } | null {
  const car = makeCar(o);
  if (init) car.setForwardSpeed(init.kmh / 3.6, init.gear);
  else if (!reachSpeed(car, 100)) return null;
  const p0 = car.telemetry().posSim;
  const v0 = kmh(car);
  let t = 0;
  while (t < 40) {
    car.step(ctl({ brake: 1 }), DT);
    t += DT;
    if (kmh(car) < 0.2) break;
  }
  const p1 = car.telemetry().posSim;
  return { v0, dist: Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z), time: t };
}

/** T3b coast-down 1 s from 100 km/h: mean deceleration m/s². */
export function t3bCoast(o: CarOpts, vT = 100): number | null {
  const car = makeCar(o);
  if (!reachSpeed(car, vT)) return null;
  const v0 = kmh(car) / 3.6;
  run(car, 1, () => ctl());
  return v0 - kmh(car) / 3.6;
}

export interface T4Run {
  steer: number;
  aLat: number;
  beta: number;
  kmh: number;
  kept: boolean;
}

/** T4 peak steady-state lateral acceleration with the steady-state filter. */
export function t4Lateral(
  o: CarOpts,
  vT: number,
  steers = [0.05, 0.1, 0.15, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0],
): { filtered: number; unfiltered: number; runs: T4Run[] } {
  const runs: T4Run[] = [];
  for (const st of steers) {
    const car = makeCar(o);
    if (!reachSpeed(car, vT)) continue;
    const acc: number[] = [];
    const bet: number[] = [];
    const spd: number[] = [];
    run(
      car,
      6,
      () => cornering(car, vT, st),
      (t) => {
        if (t > 4) {
          acc.push(aLatG(car));
          bet.push(Math.abs(car.telemetry().beta));
          spd.push(kmhWorld(car));
        }
      },
    );
    const a = mean(acc);
    const b = (mean(bet) * 180) / Math.PI;
    const v = mean(spd);
    runs.push({ steer: st, aLat: a, beta: b, kmh: v, kept: b <= 30 && v >= 0.85 * vT });
  }
  const filtered = Math.max(0, ...runs.filter((r) => r.kept).map((r) => Math.abs(r.aLat)));
  const unfiltered = Math.max(0, ...runs.map((r) => Math.abs(r.aLat)));
  return { filtered, unfiltered, runs };
}

/** Heading change (deg, unwrapped) and world speed at given marks. */
export function t5Handbrake(
  o: CarOpts,
  opt: { hbTime?: number; steer?: number; thrAfter?: number; useHb?: boolean; vT?: number; T?: number } = {},
): { marks: Record<string, { heading: number; kmh: number }>; trace: { t: number; heading: number; kmh: number }[] } | null {
  const hbTime = opt.hbTime ?? 0.5;
  const steer = opt.steer ?? 1;
  const thrAfter = opt.thrAfter ?? 1;
  const useHb = opt.useHb ?? true;
  const car = makeCar(o);
  if (!reachSpeed(car, opt.vT ?? 60)) return null;
  let last = heading(car);
  let total = 0;
  const marks: Record<string, { heading: number; kmh: number }> = {};
  const trace: { t: number; heading: number; kmh: number }[] = [];
  run(
    car,
    opt.T ?? 2,
    (t) => (t < hbTime ? ctl({ steer, handbrake: useHb ? 1 : 0 }) : ctl({ steer, throttle: thrAfter })),
    (t) => {
      const h = heading(car);
      total += wrap(h - last);
      last = h;
      const v = kmhWorld(car);
      trace.push({ t, heading: (total * 180) / Math.PI, kmh: v });
      for (const m of [0.5, 1.0, 1.5, 2.0]) if (Math.abs(t - m) < DT / 2) marks[m.toFixed(1)] = { heading: (total * 180) / Math.PI, kmh: v };
    },
  );
  return { marks, trace };
}

/** T6 tarmac slide recovery. */
export function t6Recovery(o: CarOpts = {}): { peakBeta: number; tPeak: number; tBelow5: number | null } {
  const car = makeCar({ surface: 'tarmac', ...o });
  reachSpeed(car, 80);
  const betas: [number, number][] = [];
  run(
    car,
    2,
    (t) => (t < 0.4 ? ctl({ steer: 1, handbrake: 1 }) : ctl({ throttle: 0.3 })),
    (t) => betas.push([t, Math.abs((car.telemetry().beta * 180) / Math.PI)]),
  );
  let peak = betas[0];
  for (const b of betas) if (b[1] > peak[1]) peak = b;
  const after = betas.find(([t, b]) => t > peak[0] && b < 5);
  return { peakBeta: peak[1], tPeak: peak[0], tBelow5: after ? after[0] - 0.4 : null };
}

/** T7 / T8 max |β| (deg) under full throttle at steer 0.3 for 3 s from steady speed (spec-literal start). */
export function t7MaxBeta(o: CarOpts, vT: number): number {
  return t8Power(o, vT, 'spec', 3).maxBeta;
}

export interface PowerSlideResult {
  /** Turbo boost fraction at the throttle step. */
  boost0: number;
  /** max |β| (deg) over the whole run and over the first 3 s. */
  maxBeta: number;
  maxBeta3: number;
  /** First time (s after the step) |β| exceeds 10° / 30°, or null. */
  t10: number | null;
  t30: number | null;
}

/** T7 / T8: steer 0.3 + full throttle for T seconds from a defined start state. */
export function t8Power(o: CarOpts, vT: number, start: PowerStart, T = 6): PowerSlideResult {
  const car = makeCar(o);
  const boost0 = powerStart(car, vT, start);
  const r: PowerSlideResult = { boost0, maxBeta: 0, maxBeta3: 0, t10: null, t30: null };
  run(
    car,
    T,
    () => ctl({ steer: 0.3, throttle: 1 }),
    (t) => {
      const b = Math.abs((car.telemetry().beta * 180) / Math.PI);
      r.maxBeta = Math.max(r.maxBeta, b);
      if (t <= 3 + 1e-9) r.maxBeta3 = Math.max(r.maxBeta3, b);
      if (r.t10 === null && b > 10) r.t10 = t;
      if (r.t30 === null && b > 30) r.t30 = t;
    },
  );
  return r;
}

const pathRadius = (car: CarSim) => {
  const t = car.telemetry();
  return t.speedWorldKmh / 3.6 / Math.max(1e-6, Math.abs(t.yawRate));
};

/** Entry history before the T9-T11 corner: a 2 s turn at steer ±0.3 before the steady straight, or none. */
export type EntryHistory = 'none' | 'left' | 'right';

export interface PowerStepResult {
  r0: number;
  rWin: number;
  rEnd: number;
  drWinPct: number;
  drEndPct: number;
  beta0: number;
  betaMax: number;
  betaEnd: number;
  yawRatio: number;
  /** Turbo boost fraction at the throttle step. */
  boost0: number;
}

/**
 * T9 / T10 / T11 power / lift-off from a held corner at 80 km/h on gravel. Default start ('steady', §7.1 v1.2):
 * reach 80 km/h, optional entry turn, a steady straight of `hold` s (turbo at idle), then the 4 s cornering bot,
 * then the step. start 'spec' = the literal v1.1 protocol (reach speed, straight into the 4 s corner).
 */
export function powerStep(
  o: CarOpts,
  steer: number,
  mode: 'power' | 'lift',
  opt: { start?: 'spec' | 'steady'; entry?: EntryHistory; hold?: number } = {},
): PowerStepResult {
  const car = makeCar({ surface: 'gravel', ...o });
  reachSpeed(car, 80);
  if ((opt.start ?? 'steady') === 'steady') {
    if (opt.entry === 'left' || opt.entry === 'right') run(car, 2, () => cornering(car, 80, opt.entry === 'left' ? -0.3 : 0.3));
    run(car, opt.hold ?? STEADY_HOLD_S, () => speedHold(car, 80));
  }
  run(car, 4, () => cornering(car, 80, steer));
  const boost0 = car.telemetry().boostFrac;
  const r0 = pathRadius(car);
  const beta0 = Math.abs((car.telemetry().beta * 180) / Math.PI);
  const y0 = Math.abs(car.telemetry().yawRate);
  let betaMax = 0;
  let yMax = 0;
  const win: number[] = [];
  run(
    car,
    mode === 'power' ? 1 : 1.5,
    () => ctl({ steer, throttle: mode === 'power' ? 1 : 0 }),
    (t) => {
      const tel = car.telemetry();
      betaMax = Math.max(betaMax, Math.abs((tel.beta * 180) / Math.PI));
      yMax = Math.max(yMax, Math.abs(tel.yawRate));
      if (t >= 0.2 - 1e-9 && t <= 0.5 + 1e-9) win.push(pathRadius(car));
    },
  );
  const rWin = mean(win);
  const rEnd = pathRadius(car);
  return {
    r0,
    rWin,
    rEnd,
    drWinPct: 100 * (rWin / r0 - 1),
    drEndPct: 100 * (rEnd / r0 - 1),
    beta0,
    betaMax,
    betaEnd: Math.abs((car.telemetry().beta * 180) / Math.PI),
    yawRatio: yMax / Math.max(1e-9, y0),
    boost0,
  };
}

export interface DriftHoldResult {
  /** Turbo boost and world speed at the flick. */
  boostFlick: number;
  kmhFlick: number;
  /** Over 1-4 s after the flick: mean β (deg, + = the flick side), share of steps within ±8° of the target, mean
   *  world speed, mean steer input (+ = into the turn, − = opposite lock), share of steps at full lock. */
  meanBeta: number;
  inBandPct: number;
  meanKmh: number;
  meanSteer: number;
  steerSatPct: number;
  /** ≥ 80 % of the steps within ±8° of the target and |mean β − target| ≤ 4°. */
  held: boolean;
}

/**
 * Drift-hold measurement (not a §7 [M] test; a regression probe for design targets S2 / F1 "throttle-held
 * drift", spec §7 v1.3). Reach 40 km/h, 2.5 s of full throttle (turbo spooling), a 0.35 s right handbrake flick
 * with the throttle held, then 4 s of full throttle with a counter-steer controller holding β at `betaT`:
 * steer = 0.06·e − 0.006·dβ/dt + ki·∫e dt, e = βT − β (deg), clamped to ±1 with anti-windup (the integral stops
 * while the output is saturated in the direction of e). Default ki = 0.1 (P-I-D). ki = 0 is the v1.2 P-D probe,
 * whose steady-state error under-reported the holdable angle (AWD "12-20°"; spec Appendix C v1.3).
 */
export function driftHold(o: CarOpts, betaT: number, opt: { ki?: number; throttle?: number } = {}): DriftHoldResult {
  const D = 180 / Math.PI;
  const ki = opt.ki ?? 0.1;
  const thr = opt.throttle ?? 1;
  const car = makeCar({ surface: 'gravel', ...o });
  reachSpeed(car, 40);
  run(car, 2.5, () => ctl({ throttle: 1 }));
  const t0 = car.telemetry();
  const boostFlick = t0.boostFrac;
  const kmhFlick = t0.speedWorldKmh;
  run(car, 0.35, () => ctl({ steer: 1, handbrake: 1, throttle: 1 }));
  let prev = car.telemetry().beta * D;
  let I = 0;
  const rows: { b: number; v: number; s: number }[] = [];
  run(
    car,
    4,
    () => {
      const b = car.telemetry().beta * D;
      const db = (b - prev) / DT;
      prev = b;
      const e = betaT - b;
      const u = 0.06 * e - 0.006 * db + ki * I;
      if ((u > -1 && u < 1) || (u >= 1 && e < 0) || (u <= -1 && e > 0)) I += e * DT;
      return ctl({ throttle: thr, steer: clamp(0.06 * e - 0.006 * db + ki * I, -1, 1) });
    },
    (t) => {
      const tl = car.telemetry();
      if (t >= 1) rows.push({ b: tl.beta * D, v: tl.speedWorldKmh, s: tl.steer });
    },
  );
  const meanBeta = mean(rows.map((r) => r.b));
  const inBandPct = (100 * rows.filter((r) => Math.abs(r.b - betaT) <= 8).length) / Math.max(1, rows.length);
  return {
    boostFlick,
    kmhFlick,
    meanBeta,
    inBandPct,
    meanKmh: mean(rows.map((r) => r.v)),
    meanSteer: mean(rows.map((r) => r.s)),
    steerSatPct: (100 * rows.filter((r) => Math.abs(r.s) >= 0.999).length) / Math.max(1, rows.length),
    held: inBandPct >= 80 && Math.abs(meanBeta - betaT) <= 4,
  };
}

/**
 * Max holdable slip angle: the largest target of the series 10, 15, … 50° up to which EVERY target is held (`held`)
 * by the counter-steer controller. Each target is tried with the integral gains in `kis` (default P-I-D 0.1, then
 * P-D 0: no single gain set suits every car and surface, the P-I-D one oscillates on some sand / mud rows); the
 * first controller that holds it is kept. Rows carry `ki`.
 */
export function maxHoldableBeta(
  o: CarOpts,
  opt: { kis?: number[] } = {},
): { maxHeld: number; rows: (DriftHoldResult & { target: number; ki: number })[] } {
  const kis = opt.kis ?? [0.1, 0];
  const rows: (DriftHoldResult & { target: number; ki: number })[] = [];
  for (let bT = 10; bT <= 50; bT += 5) {
    let best: (DriftHoldResult & { target: number; ki: number }) | null = null;
    for (const ki of kis) {
      const r = { target: bT, ki, ...driftHold(o, bT, { ki }) };
      if (!best) best = r;
      if (r.held) {
        best = r;
        break;
      }
    }
    rows.push(best!);
  }
  let maxHeld = 0;
  for (const r of rows) {
    if (!r.held) break;
    maxHeld = r.target;
  }
  return { maxHeld, rows };
}

/** T12 yaw step response: steady 80 km/h, throttle 0.4, steer 0 → 0.2. */
export function t12Step(o: CarOpts): { t63: number; yaw1s: number } {
  const car = makeCar(o);
  reachSpeed(car, 80);
  run(car, 1, () => ctl({ throttle: 0.4 }));
  const yr: [number, number][] = [];
  run(
    car,
    1,
    () => ctl({ steer: 0.2, throttle: 0.4 }),
    (t) => yr.push([t, car.telemetry().yawRate]),
  );
  const y1 = yr[yr.length - 1][1];
  const t63 = yr.find(([, y]) => y >= 0.632 * y1)?.[0] ?? Infinity;
  return { t63, yaw1s: y1 };
}

/** T16 coast-down gear sequence from 140 km/h. */
export function t16Coast(o: CarOpts = {}): { from: number; to: number; kmhWorld: number; rpm: number }[] {
  const car = makeCar({ surface: 'tarmac', ...o });
  reachSpeed(car, 140, 60);
  const log: { from: number; to: number; kmhWorld: number; rpm: number }[] = [];
  let last = car.telemetry().gear;
  run(
    car,
    25,
    () => ctl(),
    () => {
      const t = car.telemetry();
      if (t.gear !== last) {
        log.push({ from: last, to: t.gear, kmhWorld: t.speedWorldKmh, rpm: t.rpm });
        last = t.gear;
      }
    },
  );
  return log;
}

/** T18 deep-surface coast 1 s from steady 80 km/h: deceleration m/s². */
export function t18Deep(o: CarOpts = {}): number {
  const car = makeCar({ surface: 'gravelDeep', ...o });
  reachSpeed(car, 80);
  const v0 = kmh(car) / 3.6;
  run(car, 1, () => ctl());
  return v0 - kmh(car) / 3.6;
}

// ------------------------------------------------------------------------------------------- crests and jumps

export interface AirSample {
  t: number;
  z: number;
  y: number;
  vy: number;
  ay: number;
  vz: number;
  nContacts: number;
  airMul: number;
  /** Expected free-flight vertical acceleration 1.45·(12 + AirKZY·vLz²/m) ∓ 2 (§2.10). */
  ayExpected: number;
  wx: number;
  wy: number;
  wz: number;
  loads: number[];
  heading: number;
  kmh: number;
}

/**
 * Drive across a profile: speed-hold bot to vT until z ≥ zCruise, then `throttle` (no steering) until z ≥ zEnd.
 * Records every step after zCruise.
 */
export function profileRun(
  world: WorldQuery,
  o: { car?: ArchetypeId; vT: number; throttle: number; zSpawn: number; zCruise: number; zEnd: number; tmax?: number },
): { samples: AirSample[]; reached: boolean } {
  const car = makeCar({ car: o.car, world, z: o.zSpawn, raise: 0.4225 });
  const p = car.params;
  const samples: AirSample[] = [];
  let t = 0;
  let reached = false;
  let vyPrev = car.telemetry().velSim.y;
  let h0 = heading(car);
  let cruising = false;
  while (t < (o.tmax ?? 60)) {
    const tel0 = car.telemetry();
    const z = tel0.posSim.z;
    if (z >= o.zEnd) break;
    if (!cruising && z >= o.zCruise) {
      cruising = true;
      h0 = heading(car);
    }
    let c: Controls;
    if (!cruising) {
      c = speedHold(car, o.vT);
      if (t > 3 && Math.abs(kmh(car) - o.vT) < 1) reached = true;
    } else c = ctl({ throttle: o.throttle });
    car.step(c, DT);
    t += DT;
    const tel = car.telemetry();
    const vy = tel.velSim.y;
    const ay = (vy - vyPrev) / DT;
    vyPrev = vy;
    if (!cruising) continue;
    const vz = tel.velLocal.z;
    const base = p.airGravityMax * (p.gravity + (p.airKZY * vz * vz) / p.mass);
    samples.push({
      t,
      z: tel.posSim.z,
      y: tel.posSim.y,
      vy,
      ay,
      vz: tel.velSim.z,
      nContacts: tel.nContacts,
      airMul: tel.airMul,
      ayExpected: vy > 0 ? -(base + p.airLinDamp) : -(base - p.airLinDamp),
      wx: tel.angVelLocal.x,
      wy: tel.angVelLocal.y,
      wz: tel.angVelLocal.z,
      loads: car.debug().wheels.map((w) => -w.load),
      heading: (wrap(heading(car) - h0) * 180) / Math.PI,
      kmh: tel.speedKmh,
    });
  }
  return { samples, reached };
}

/** Airborne phases (runs of nContacts === 0) as [startIndex, endIndex) over samples. */
export function airPhases(s: AirSample[]): [number, number][] {
  const out: [number, number][] = [];
  let st = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i].nContacts === 0) {
      if (st < 0) st = i;
    } else if (st >= 0) {
      out.push([st, i]);
      st = -1;
    }
  }
  if (st >= 0) out.push([st, s.length]);
  return out;
}
