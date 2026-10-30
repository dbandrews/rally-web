/**
 * src/game/carFlags.ts — the ONE backfire / blow-out flag source of a car (CarFlags in src/core/types.ts).
 *
 * The original computes both flags in the car update FUN_0074fee0 (vt+0x248, frame-driven; its dt is the time
 * accumulated at +0x178 since the last update) through car vt+0x124 / vt+0x128, before the sound player and the
 * effects read them (sound.md §4.3) [V]:
 *   backfire 0x753410  timer +0x88 −= dt; at ≤ 0, with the throttle closed (vt+0x28 ≤ 0) and rpm > 1100: timer = 0;
 *                      no bang while a pedal (brake vt+0x2c or throttle) is pressed in gear 0 (reverse);
 *                      n = trunc(rpm·0.001 + 1.5); rand() % n ≠ 0 → flag +0x84 = 1 and
 *                      timer = (rand() % 100 − 50) / (rpm·0.0001·400) + 0.15; otherwise the flag is 0.
 *   blow-out 0x753550  timer +0x90 += dt; at ≥ 0.2 s with speed (vt+0x118) > 1.3888889 m/s: timer = 0; a gear change
 *                      since the last check (+0x94) sets flag +0x8c with rand() % 6 + 1 ≤ 3 (50 %); past this gate the
 *                      gear is stored either way (before it, never); otherwise the flag is 0.
 * Both timers are f32 car fields (fst / fstp DWORD) while each test compares the unrounded x87 value; dt is the f32
 * argument and the constants are the exe's f32 literals (0x7fc78c 0.2, 0x82fa4c 1.3888889, 0x806614 1100, 0x8080ac
 * 0.001, 0x8070d0 1.5, 0x7fc790 0.0001, 0x82fa48 400, 0x81b51c 0.15); n is _ftol (truncation).
 * main.ts runs update() once per rendered frame for the player car and hands the same flags to the audio
 * (FrameContext.carFlags: PipeBoom / PipeBlowOut) and the renderer (CarRenderState.carFlags: the pipe flames), so a
 * bang and its flame fire on the same frame. rand() is the MSVC CRT generator (the original seeds it from the clock).
 */
import type { CarFlags, CarTelemetry } from '../core/types';

/** MSVC rand(): state = state·214013 + 2531011; (state >> 16) & 0x7fff. */
class CrtRand {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (Math.imul(this.state, 214013) + 2531011) >>> 0;
    return (this.state >>> 16) & 0x7fff;
  }
}

const f32 = Math.fround;
/** At or below this rpm no backfire (0x753410, 0x806614). */
const BACKFIRE_MIN_RPM = 1100;
/** n = trunc(rpm · 0.001 + 1.5) (0x8080ac, 0x8070d0); the next bang after (rand % 100 − 50) / (rpm · 0.0001 · 400)
 *  + 0.15 s (0x7fc790, 0x82fa48, 0x81b51c). */
const BACKFIRE_N_K = f32(0.001);
const BACKFIRE_N_0 = 1.5;
const BACKFIRE_T_K = f32(0.0001);
const BACKFIRE_T_K2 = 400;
const BACKFIRE_T_0 = f32(0.15);
/** Blow-out check period (s, 0x7fc78c) and minimum speed (m/s, 0x82fa4c = 5 km/h) (0x753550). */
const BLOWOUT_PERIOD_S = f32(0.2);
const BLOWOUT_MIN_SPEED = f32(1.3888889);

export class CarFlagSource {
  /** This update's flags (one object, updated in place; consumers read it within the frame). */
  readonly flags: CarFlags = { backfire: false, blowOut: false };
  private readonly rand: CrtRand;
  private backfireT = 0; // +0x88
  private blowT = 0; // +0x90
  private blowGear = 1; // +0x94

  constructor(seed = 1) {
    this.rand = new CrtRand(seed);
  }

  /** Back to the state of a new car (race start). */
  reset(): void {
    this.backfireT = 0;
    this.blowT = 0;
    this.blowGear = 1;
    this.flags.backfire = this.flags.blowOut = false;
  }

  /** One car update with `dt` s since the last one (0 = no update: both flags clear). */
  update(dt: number, tel: Readonly<CarTelemetry>): Readonly<CarFlags> {
    const f = this.flags;
    f.backfire = f.blowOut = false;
    if (!(dt > 0)) return f;
    const dtf = f32(dt);
    const rpm = tel.rpm;
    const thr = tel.throttle;
    const bt = this.backfireT - dtf; // the x87 value the test sees; the field keeps it as f32
    this.backfireT = f32(bt);
    if (bt <= 0 && thr <= 0 && rpm > BACKFIRE_MIN_RPM) {
      this.backfireT = 0;
      const pedalInReverse = tel.gear === 0 && (tel.brake > 0 || thr > 0);
      if (!pedalInReverse) {
        const n = Math.trunc(rpm * BACKFIRE_N_K + BACKFIRE_N_0);
        if (this.rand.next() % n !== 0) {
          f.backfire = true;
          this.backfireT = f32(((this.rand.next() % 100) - 50) / (rpm * BACKFIRE_T_K * BACKFIRE_T_K2) + BACKFIRE_T_0);
        }
      }
    }
    const wt = this.blowT + dtf;
    this.blowT = f32(wt);
    if (wt >= BLOWOUT_PERIOD_S && Math.abs(tel.speedKmh) / 3.6 > BLOWOUT_MIN_SPEED) {
      this.blowT = 0;
      if (tel.gear !== this.blowGear && (this.rand.next() % 6) + 1 <= 3) f.blowOut = true;
      this.blowGear = tel.gear;
    }
    return f;
  }
}
