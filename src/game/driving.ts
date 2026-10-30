/**
 * src/game/driving.ts — game builder. Pure driving math for the autopilot (testable without a sim).
 *
 *  - pursuitSteer: pure-pursuit steering toward a target point given in the CAR frame
 *    (x right, z forward, metres), returning the physics steer input -1..1 (+ = right) for the §2.1 steer
 *    lock (0.40 rad + 0.005 rad per km/h below 40 km/h).
 *  - SpeedProfile: per-stage speed limit along s from centre-line curvature × surface grip, with a
 *    backward braking pass so the car brakes before bends (point-to-point and closed stages).
 *  - runOutControls: the post-finish run-out (steer along the road on the line the car finished on, progressive
 *    brake that stops short of the first object on that line, park below 10 km/h).
 *  - obstacleAtCarHeight: the sim's vertical test of an obstacle against a car on the road (car.ts).
 */
import type { CarTelemetry, Controls, Obstacle, RaceState, Stage, SurfaceId, WorldQuery } from '../core/types';
import { curvatureAt, forwardOfThree, rightOfQuat } from './stageMath';

/** §2.1 steer lock (rad) at a forward speed (km/h). */
export const steerLock = (kmh: number, wheelScale = 0.4, lockKmh = 40, lockGain = 0.005): number =>
  wheelScale + Math.max(0, lockKmh - Math.abs(kmh)) * lockGain;

/**
 * Pure pursuit. (lx, lz): target in the car frame (x right, z forward). Returns the front wheel angle (rad,
 * + = right) that puts the car on the circular arc through the target.
 */
export function pursuitAngle(lx: number, lz: number, wheelbase: number): number {
  const ld2 = lx * lx + lz * lz;
  if (ld2 < 1e-6) return 0;
  // curvature of the arc tangent to the heading through the target: k = 2·x / ld²
  const k = (2 * lx) / ld2;
  let a = Math.atan(k * wheelbase);
  // target behind the car: steer fully toward its side
  if (lz < 0) a = Math.sign(lx || 1) * Math.PI / 2;
  return a;
}

/** Steer input -1..1 for a wheel angle (rad) at speed kmh. */
export function steerInputFor(angle: number, kmh: number, wheelScale = 0.4): number {
  const lock = steerLock(kmh, wheelScale);
  return Math.max(-1, Math.min(1, angle / lock));
}

/** Combined helper: target in the car frame → steer input. */
export function pursuitSteer(lx: number, lz: number, kmh: number, wheelbase = 2.5, wheelScale = 0.4): number {
  return steerInputFor(pursuitAngle(lx, lz, wheelbase), kmh, wheelScale);
}

/**
 * Approximate usable lateral grip (g = 9.81 m/s² units) per surface for the speed planner.
 * Appended original materials: the family's value scaled like src/world/pacenotes.ts NOTE_GRIP_G (× T4(surface)
 * / T4(family); DEEP verges × gravelDeep / gravel = 0.72 / 0.85; wood ≈ 0.58 × its note grip, the mean ratio).
 */
export const SURFACE_GRIP_G: Readonly<Record<SurfaceId, number>> = Object.freeze({
  tarmac: 1.05,
  cobbles: 0.9,
  water: 0.8,
  gravel: 0.85,
  gravelDeep: 0.72,
  mud: 0.68,
  sand: 0.7,
  grass: 0.62,
  snow: 0.6,
  ice: 0.38,
  wood: 0.7,
  snowChunky: 0.6,
  snowDeep: 0.5,
  snowAsphalt: 0.6,
  snowDitch: 0.5,
  leaf: 0.72,
  asphaltGrass: 0.75,
  gravelGrass: 0.69,
  mudGrass: 0.69,
  mudDitch: 0.58,
  sandDeep: 0.59,
  sandDark: 0.7,
  sandDarkDeep: 0.59,
});

export interface SpeedProfileOptions {
  /** Sample spacing (m). */
  ds?: number;
  /** Scale on all grip values (autopilot aggression). */
  gripScale?: number;
  /** Fraction of the lateral grip available for braking. */
  brakeFrac?: number;
  /** Absolute cap (m/s). */
  vMax?: number;
  /** Lowest corner speed (m/s). */
  vMin?: number;
}

/** Speed limit profile along the stage (m/s), precomputed once per stage. */
export class SpeedProfile {
  readonly ds: number;
  readonly v: Float32Array;
  readonly kappa: Float32Array;
  readonly closed: boolean;
  readonly length: number;

  constructor(stage: Stage, o: SpeedProfileOptions = {}) {
    const ds = (this.ds = o.ds ?? 2);
    const grip = o.gripScale ?? 1;
    const brakeFrac = o.brakeFrac ?? 0.75;
    const vMax = o.vMax ?? 58;
    const vMin = o.vMin ?? 7;
    this.closed = stage.closed;
    this.length = stage.length;
    const n = Math.max(2, Math.ceil(stage.length / ds) + 1);
    const kap = (this.kappa = new Float32Array(n));
    const v = (this.v = new Float32Array(n));
    const mu = new Float32Array(n);
    // road surface along s (road samples are ordered by s)
    const road = stage.road ?? [];
    let ri = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.min(stage.length, i * ds);
      kap[i] = Math.max(curvatureAt(stage, s, 4), curvatureAt(stage, s, 9) * 0.9);
      while (ri + 1 < road.length && road[ri + 1].s <= s) ri++;
      const surf = road.length ? road[ri].surface : 'tarmac';
      mu[i] = (SURFACE_GRIP_G[surf] ?? 0.8) * grip;
    }
    // widen curvature peaks a little (corner entry / exit)
    const k2 = new Float32Array(kap);
    const w = Math.max(1, Math.round(6 / ds));
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = -w; j <= w; j++) {
        let idx = i + j;
        if (this.closed) idx = ((idx % n) + n) % n;
        else if (idx < 0 || idx >= n) continue;
        m = Math.max(m, kap[idx]);
      }
      k2[i] = m;
    }
    for (let i = 0; i < n; i++) {
      const aLat = mu[i] * 9.81;
      const vc = k2[i] > 1e-5 ? Math.sqrt(aLat / k2[i]) : vMax;
      v[i] = Math.max(vMin, Math.min(vMax, vc));
    }
    // backward pass: v[i]² ≤ v[i+1]² + 2·a_brake·ds (twice round for closed loops)
    // (closed: sample n-1 is s = length ≡ sample 0)
    const passes = this.closed ? 2 : 1;
    for (let p = 0; p < passes; p++) {
      if (this.closed) v[n - 1] = Math.min(v[n - 1], v[0]);
      for (let i = n - 2; i >= 0; i--) {
        const lim = Math.sqrt(v[i + 1] * v[i + 1] + 2 * mu[i] * 9.81 * brakeFrac * ds);
        if (v[i] > lim) v[i] = lim;
      }
      if (this.closed) v[n - 1] = Math.min(v[n - 1], v[0]);
    }
  }

  /** Speed limit (m/s) at s (interpolated; wraps when closed). */
  at(s: number): number {
    const n = this.v.length;
    let x = s / this.ds;
    if (this.closed) x = ((x % (n - 1)) + (n - 1)) % (n - 1);
    else x = Math.min(n - 1, Math.max(0, x));
    const i = Math.min(n - 2, Math.floor(x));
    const f = x - i;
    return this.v[i] + (this.v[i + 1] - this.v[i]) * f;
  }

  /** Minimum limit over [s, s + ahead]. */
  minAhead(s: number, ahead: number): number {
    let m = this.at(s);
    for (let d = this.ds; d <= ahead; d += this.ds) m = Math.min(m, this.at(s + d));
    return m;
  }

  curvature(s: number): number {
    const n = this.kappa.length;
    let x = Math.round(s / this.ds);
    if (this.closed) x = ((x % n) + n) % n;
    else x = Math.min(n - 1, Math.max(0, x));
    return this.kappa[x];
  }
}

/** Assumed braking deceleration (m/s²) for the post-finish run-out (ice-safe: shipped ice/ice ≈ 13 m/s²). */
const RUNOUT_DECEL = 12;
/** Below this speed the run-out parks the car (handbrake). */
const RUNOUT_PARK_KMH = 10;
/** The run-out line stays this far (m) inside the road edge. */
const RUNOUT_EDGE_M = 1;
/** The run-out stops this far (m) before the first object on its line; it looks this far (m) for one at most. */
const RUNOUT_OBJECT_GAP_M = 3;
const RUNOUT_SCAN_M = 80;
/** Car centre of mass over the road (m) for the vertical test of obstacles. */
const CAR_COM_Y = 0.45;

/**
 * The sim's vertical test (src/sim/car.ts: a car whose COM is more than 0.6 m above an obstacle's top or 1.2 m below
 * its base never touches it), for a car on the road at height `roadY` (sim y): walkways and gantries over the road
 * do not block it.
 */
export function obstacleAtCarHeight(o: Obstacle, roadY: number): boolean {
  const com = roadY + CAR_COM_Y;
  return !(com - 0.6 > o.pos.y + (o.height > 0 ? o.height : 2) || com + 1.2 < o.pos.y);
}

/** Distance (m) along the centre line from `s` to the near edge of the first hard object on the line `lat` (m, +
 *  right of travel) within `maxD`, or null. */
function firstObjectOnLine(stage: Pick<Stage, 'closed' | 'length' | 'pointAt' | 'tangentAt'>, world: Pick<WorldQuery, 'obstaclesNear'>, s: number, lat: number, maxD: number): number | null {
  const out: Obstacle[] = [];
  for (let d = 1; d <= maxD; d += 2) {
    const x = s + d;
    if (!stage.closed && x > stage.length) break;
    const sd = stage.closed ? ((x % stage.length) + stage.length) % stage.length : x;
    const p = stage.pointAt(sd);
    const t = stage.tangentAt(sd);
    const tl = Math.hypot(t.x, t.z) || 1;
    const tx = t.x / tl;
    const tz = t.z / tl;
    world.obstaclesNear({ x: p.x, y: p.y, z: -p.z }, Math.abs(lat) + 5, out);
    for (const o of out) {
      const ox = o.pos.x - p.x;
      const oz = -o.pos.z - p.z; // sim → three
      if (Math.abs(ox * tx + oz * tz) > 1.1 || !obstacleAtCarHeight(o, p.y)) continue;
      if (Math.abs(ox * -tz + oz * tx - lat) < o.radius + 1.1) return Math.max(0, d - o.radius);
    }
  }
  return null;
}

/**
 * Controls after the finish line (§5.1 "not controllable" otherwise parks the car with a full handbrake,
 * which stops a 100+ km/h car in about 20 m): throttle off, steer along the road (pure pursuit) on the line the car
 * is on (`race.lateral`, kept inside the road; the centre line without it: a car that crossed the finish beside a
 * service-park tent must not swerve back into it), and a brake pressure that stops the car within the run-out left
 * on the spline (open stages) or about 100 m (circuits), and with `world` short of the first object on that line;
 * the handbrake only below 10 km/h.
 */
export function runOutControls(
  tel: Pick<CarTelemetry, 'pos' | 'quat' | 'speedKmh' | 'velLocal'>,
  stage: Pick<Stage, 'closed' | 'length' | 'pointAt'> & Partial<Pick<Stage, 'tangentAt' | 'roadAt'>>,
  race: Pick<RaceState, 's'> & Partial<Pick<RaceState, 'lateral'>>,
  world?: Pick<WorldQuery, 'obstaclesNear'> | null,
): Controls {
  const kmh = Math.abs(tel.speedKmh);
  const v = kmh / 3.6;
  const look = Math.min(30, Math.max(6, 5 + v * 0.6));
  const sAhead = stage.closed ? (((race.s + look) % stage.length) + stage.length) % stage.length : Math.min(stage.length, race.s + look);
  let target = stage.pointAt(sAhead);
  let lat = 0;
  const lined = race.lateral !== undefined && Number.isFinite(race.lateral) && !!stage.tangentAt && !!stage.roadAt;
  if (lined) {
    let hw = 4;
    try {
      const w = stage.roadAt!(race.s).width;
      if (Number.isFinite(w) && w > 0) hw = w / 2;
    } catch {
      /* fallback width */
    }
    const lim = Math.max(0, hw - RUNOUT_EDGE_M);
    lat = Math.max(-lim, Math.min(lim, race.lateral!));
    const t = stage.tangentAt!(sAhead);
    const tl = Math.hypot(t.x, t.z) || 1;
    target = { x: target.x - (t.z / tl) * lat, y: target.y, z: target.z + (t.x / tl) * lat }; // right = (-tz, tx)
  }
  const f = forwardOfThree(tel.quat);
  const r = rightOfQuat(tel.quat);
  const dx = target.x - tel.pos.x;
  const dz = target.z - tel.pos.z;
  const lx = dx * r.x + dz * r.z;
  const lz = dx * f.x + dz * f.z;
  const steer = lz > 0.5 && (tel.velLocal?.z ?? 1) >= 0 ? Math.max(-0.6, Math.min(0.6, pursuitSteer(lx, lz, kmh))) : 0;
  let room = stage.closed ? 100 : Math.max(15, stage.length - race.s - 12);
  if (world && lined) {
    const d = firstObjectOnLine(stage as Pick<Stage, 'closed' | 'length' | 'pointAt' | 'tangentAt'>, world, race.s, lat, Math.min(RUNOUT_SCAN_M, room + 12));
    if (d !== null) room = Math.max(0.5, Math.min(room, d - RUNOUT_OBJECT_GAP_M));
  }
  const park = kmh < RUNOUT_PARK_KMH;
  const brake = park ? 0 : Math.min(1, Math.max(0.25, (v * v) / (2 * room * RUNOUT_DECEL)));
  return { steer, throttle: 0, brake, handbrake: park ? 1 : 0, gearUp: false, gearDown: false };
}
