/**
 * src/game/autopilot.ts — OWNED BY THE GAME BUILDER.
 *
 * Drives the player car along the stage centre line. Used by ?autopilot=1, by tools/drive.mjs --autopilot
 * and by playtest agents / tests to verify a stage end to end. Writes physics Controls directly (bypasses
 * the input filter, like the §7 bots).
 *
 *  - Steering: pure pursuit on stage.pointAt(s + lookahead) in the car frame (lookahead grows with speed),
 *    plus yaw-rate damping toward the pursuit arc's yaw rate (catches slides: countersteers when the car
 *    rotates faster than the path).
 *  - Speed: a per-stage speed profile from centre-line curvature × road-surface grip with a braking pass
 *    (driving.ts SpeedProfile), scaled by `aggression`; slower when far off the road or sliding hard.
 *  - Recovery: when stuck (no progress under throttle) or facing the wrong way at low speed it reverses
 *    for a moment with opposite lock (auto box: hold brake → reverse; manual: shift to R), then carries on.
 *  - Manual gearbox: shifts up near the limiter and down at low rpm.
 *
 * REQUIRED EXPORTS (contract in src/core/types.ts IAutopilot):
 *   class Autopilot implements IAutopilot
 *     constructor()
 *     aggression: number                       // 0.3..1.2 target-speed scale
 *     reset(): void
 *     update(dt, tel, stage, race): Controls   // once per substep
 */
import { neutralControls } from '../core/constants';
import { clamp } from '../core/math';
import type { CarTelemetry, Controls, IAutopilot, RaceState, Stage } from '../core/types';
import { pursuitAngle, SpeedProfile, steerInputFor } from './driving';
import { forwardOfThree, rightOfQuat } from './stageMath';

type Mode = 'drive' | 'reverse';

export interface AutopilotDebug {
  mode: Mode;
  targetSpeed: number;
  lookahead: number;
  alpha: number;
}

export class Autopilot implements IAutopilot {
  /** 0.3..1.2 target-speed scale (1 = brisk but safe). */
  aggression = 1;
  /** Car wheelbase used by the pursuit geometry (m). */
  wheelbase = 2.5;
  readonly debug: AutopilotDebug = { mode: 'drive', targetSpeed: 0, lookahead: 0, alpha: 0 };

  private readonly c: Controls = neutralControls();
  private profile: SpeedProfile | null = null;
  private profileStage: Stage | null = null;
  private profileAggr = -1;
  private mode: Mode = 'drive';
  private modeT = 0;
  private stuckT = 0;
  private wrongT = 0;
  private shiftCooldown = 0;
  private lastResetCount = -1;
  private lastS = 0;
  private noProgressT = 0;
  private readonly f = { x: 0, y: 0, z: -1 };
  private readonly r = { x: 1, y: 0, z: 0 };

  reset(): void {
    Object.assign(this.c, neutralControls());
    this.mode = 'drive';
    this.modeT = this.stuckT = this.wrongT = this.noProgressT = this.shiftCooldown = 0;
    this.lastResetCount = -1;
  }

  update(dt: number, tel: Readonly<CarTelemetry>, stage: Stage, race: Readonly<RaceState>): Controls {
    const c = this.c;
    c.gearUp = c.gearDown = false;
    c.handbrake = 0;
    this.ensureProfile(stage);

    if (tel.resetCount !== this.lastResetCount) {
      this.lastResetCount = tel.resetCount;
      this.mode = 'drive';
      this.modeT = this.stuckT = this.wrongT = this.noProgressT = 0;
      this.lastS = race.s;
    }
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    this.modeT += dt;

    const vf = tel.velLocal ? tel.velLocal.z : tel.speedKmh / 3.6; // signed forward speed m/s
    const speed = Math.abs(vf);
    const kmh = speed * 3.6;

    // ---- geometry: target on the centre line, in the car frame
    const look = clamp(5 + speed * 0.62, 6, 34);
    const target = stage.pointAt(this.aheadS(stage, race.s, look));
    const f = forwardOfThree(tel.quat, this.f);
    const r = rightOfQuat(tel.quat, this.r);
    const dx = target.x - tel.pos.x;
    const dz = target.z - tel.pos.z;
    const lx = dx * r.x + dz * r.z;
    const lz = dx * f.x + dz * f.z;
    const alpha = Math.atan2(lx, lz); // + = target to the right
    this.debug.alpha = alpha;
    this.debug.lookahead = look;

    // ---- recovery state machine
    const throttleWanted = this.mode === 'drive' && c.throttle > 0.3;
    this.stuckT = throttleWanted && speed < 1.2 ? this.stuckT + dt : 0;
    this.wrongT = Math.abs(alpha) > 1.9 && speed < 6 ? this.wrongT + dt : 0;
    // progress watchdog: moving but not advancing along the stage (e.g. pushing along a wall)
    const ds = stage.closed ? 0 : race.s - this.lastS;
    this.noProgressT = this.mode === 'drive' && !stage.closed && ds < 0.4 * dt && kmh < 12 ? this.noProgressT + dt : 0;
    this.lastS = race.s;
    if (this.mode === 'drive' && (this.stuckT > 1.2 || this.wrongT > 1.0 || this.noProgressT > 3)) {
      this.mode = 'reverse';
      this.modeT = 0;
    } else if (this.mode === 'reverse' && (this.modeT > 2.2 || (this.modeT > 0.9 && Math.abs(alpha) < 0.5))) {
      this.mode = 'drive';
      this.modeT = 0;
      this.stuckT = this.wrongT = this.noProgressT = 0;
    }
    this.debug.mode = this.mode;

    const manual = tel.transmission === 'manual';
    if (this.mode === 'reverse') {
      this.reverse(tel, alpha, speed, manual);
      return c;
    }

    // ---- steering: pure pursuit + yaw damping
    const angle = pursuitAngle(lx, lz, this.wheelbase);
    const ld2 = Math.max(1, lx * lx + lz * lz);
    const kPath = (2 * lx) / ld2;
    const yawDes = vf * kPath; // rad/s, + = right
    let steer = steerInputFor(angle, kmh);
    steer += clamp((yawDes - tel.yawRate) * 0.18, -0.5, 0.5);
    c.steer = clamp(steer, -1, 1);

    // ---- speed
    const prof = this.profile!;
    const aheadS = this.aheadS(stage, race.s, speed * 0.35);
    let vT = prof.at(aheadS);
    const roadHalf = this.roadHalfWidth(stage, race.s);
    const off = Math.abs(race.lateral) - roadHalf;
    if (off > 2) vT = Math.min(vT, Math.max(8, 22 - off));
    if (Math.abs(alpha) > 0.6) vT = Math.min(vT, 12);
    const beta = Math.abs(tel.beta ?? 0);
    if (beta > 0.45) vT = Math.min(vT, speed * 0.97);
    this.debug.targetSpeed = vT;
    const err = vT - speed;
    if (vf < -0.5 && !manual) {
      // rolling backwards in a forward gear (or still in R): throttle exits R in the auto box
      c.throttle = 0.6;
      c.brake = 0;
    } else if (err > 0) {
      c.throttle = clamp(0.45 + 0.12 * err, 0, 1);
      if (beta > 0.35) c.throttle = Math.min(c.throttle, 0.55);
      c.brake = 0;
    } else if (err > -1.5) {
      c.throttle = clamp(0.35 + 0.2 * err, 0, 0.35);
      c.brake = 0;
    } else {
      c.throttle = 0;
      // never > 0.3 brake near standstill (auto box would select reverse)
      c.brake = speed < 3 ? 0.2 : clamp(-err * 0.14, 0.2, 1);
    }

    // ---- manual gearbox
    if (manual && !tel.shifting && this.shiftCooldown <= 0) {
      if (tel.gear === 0) this.shift(true);
      else if (tel.rpm > 7600 && tel.gear < tel.nGears) this.shift(true);
      else if (tel.rpm < 3600 && tel.gear > 1) this.shift(false);
    }
    return c;
  }

  // ------------------------------------------------------------------------------------------- helpers

  private reverse(tel: Readonly<CarTelemetry>, alpha: number, speed: number, manual: boolean): void {
    const c = this.c;
    // reversing: opposite lock swings the nose toward the target
    c.steer = alpha > 0 ? -1 : 1;
    if (manual) {
      if (tel.gear !== 0) {
        c.throttle = 0;
        c.brake = speed > 1 ? 0.8 : 0;
        if (speed < 5 && !tel.shifting && this.shiftCooldown <= 0) this.shift(false);
      } else {
        c.throttle = 0.6;
        c.brake = 0;
      }
    } else {
      // auto box: brake held below 5 km/h selects R; in R the brake pedal drives (§2.2)
      c.throttle = 0;
      c.brake = 0.75;
    }
  }

  private shift(up: boolean): void {
    if (up) this.c.gearUp = true;
    else this.c.gearDown = true;
    this.shiftCooldown = 0.45;
  }

  private aheadS(stage: Stage, s: number, d: number): number {
    const x = s + d;
    return stage.closed ? ((x % stage.length) + stage.length) % stage.length : Math.min(stage.length, x);
  }

  private roadHalfWidth(stage: Stage, s: number): number {
    try {
      const w = stage.roadAt(s).width;
      return Number.isFinite(w) && w > 0 ? w / 2 : 4;
    } catch {
      return 4;
    }
  }

  private ensureProfile(stage: Stage): void {
    const aggr = clamp(this.aggression, 0.3, 1.2);
    if (this.profile && this.profileStage === stage && this.profileAggr === aggr) return;
    this.profile = new SpeedProfile(stage, { gripScale: 0.8 * aggr, brakeFrac: 0.7, vMax: 55 * Math.min(1, aggr + 0.1) });
    this.profileStage = stage;
    this.profileAggr = aggr;
  }
}
