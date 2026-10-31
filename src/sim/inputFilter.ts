/**
 * src/sim/inputFilter.ts — OWNED BY THE SIM BUILDER.
 *
 * RawInput -> Controls filter of §5.1, run once per physics substep (dt = 1/120).
 * Verified against §5.1 / §7 T17 (tests/sim/feel.test.ts T17, tests/sim/inputFilter.test.ts): digital ramps
 * (first-substep jump, rate, instant release, opposite-lock jump to ±start), analog device presets
 * (pad: 0.1 rescaled dead zone + sqrtCurve 1; wheel: sqrtCurve 0), squared response with the original's
 * centre quirk, rate-limited type 0, [D] analog pedal dead zone 0.08.
 *
 * REQUIRED EXPORTS (keep these signatures):
 *   class InputFilter implements IInputFilter
 *     constructor(cfg?: Partial<InputFilterConfig>)
 *     readonly config: InputFilterConfig
 *     setConfig(partial: Partial<InputFilterConfig>): void
 *     reset(): void
 *     update(raw: Readonly<RawInput>, dt: number): Controls      // returns an internal reused object
 *   makeInputFilterConfig(): InputFilterConfig                    // §5.1 / §6 defaults
 */
import { clamp, sgn, towardZero } from '../core/math';
import type { Controls, IInputFilter, InputFilterConfig, RawInput } from '../core/types';

export function makeInputFilterConfig(): InputFilterConfig {
  return {
    keySteerStart: 0.05,
    keySteerRate: 2.0,
    keyThrottleStart: 0.1,
    keyThrottleRate: 2.0,
    keyBrakeStart: 0.2,
    keyBrakeRate: 1.5,
    keyHandbrakeStart: 0.5,
    keyHandbrakeRate: 1.0,
    steeringType: 1,
    sqrtCurvePad: 1,
    sqrtCurveWheel: 0,
    steerSensitivity: 1.0,
    padDeadzone: 0.1,
    wheelDeadzone: 0,
    pedalDeadzone: 0.08, // [D] v1.2 (was 0.05): a trigger resting at 0.06 kept the car awake (creep, body bob)
  };
}

export class InputFilter implements IInputFilter {
  readonly config: InputFilterConfig;
  private readonly c: Controls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, gearUp: false, gearDown: false };

  constructor(cfg?: Partial<InputFilterConfig>) {
    this.config = { ...makeInputFilterConfig(), ...cfg };
  }

  setConfig(partial: Partial<InputFilterConfig>): void {
    Object.assign(this.config, partial);
  }

  reset(): void {
    const c = this.c;
    c.steer = c.throttle = c.brake = c.handbrake = 0;
    c.gearUp = c.gearDown = false;
  }

  update(raw: Readonly<RawInput>, dt: number): Controls {
    const cfg = this.config;
    const C = this.c;
    const dz = cfg.pedalDeadzone;
    const pedal = (v: number) => (v < dz ? 0 : (v - dz) / (1 - dz));
    // Digital ramp: first substep jumps to `start`, then +rate/s; release -> 0 instantly (§5.1).
    const ramp = (cur: number, pressed: boolean, start: number, rate: number) =>
      pressed ? (cur <= start - 0.01 ? start : cur + rate * dt) : 0;

    C.throttle = raw.throttleDigital
      ? ramp(C.throttle, raw.throttle > 0, cfg.keyThrottleStart, cfg.keyThrottleRate)
      : pedal(raw.throttle);
    C.brake = raw.brakeDigital ? ramp(C.brake, raw.brake > 0, cfg.keyBrakeStart, cfg.keyBrakeRate) : pedal(raw.brake);
    C.handbrake = raw.handbrakeDigital
      ? ramp(C.handbrake, raw.handbrake > 0, cfg.keyHandbrakeStart, cfg.keyHandbrakeRate)
      : pedal(raw.handbrake);

    if (raw.steerDigital) {
      // both keys held: Right wins (FUN_005b65b0 tests the positive key first), it does not cancel to centre
      const dir = raw.right ? 1 : raw.left ? -1 : 0;
      const st = cfg.keySteerStart;
      if (dir === 0) C.steer = 0;
      else if (dir > 0) C.steer = C.steer <= st - 0.01 ? st : C.steer + cfg.keySteerRate * dt;
      else C.steer = C.steer >= -(st - 0.01) ? -st : C.steer - cfg.keySteerRate * dt;
    } else {
      // touch steering shapes its own axis (src/input/touch.ts): the wheel preset, no dead zone or sqrt curve
      const isWheel = raw.device === 'wheel' || raw.device === 'touch';
      const deadzone = isWheel ? cfg.wheelDeadzone : cfg.padDeadzone;
      const curve = isWheel ? cfg.sqrtCurveWheel : cfg.sqrtCurvePad;
      const a0 = Math.abs(raw.steer);
      let x = a0 <= deadzone ? 0 : (sgn(raw.steer) * (a0 - deadzone)) / (1 - deadzone);
      if (curve === 1) x = sgn(x) * Math.sqrt(Math.abs(x));
      else if (curve === 2) x = sgn(x) * Math.sqrt(Math.sqrt(Math.abs(x)));
      if (cfg.steeringType === 1) {
        if (Math.abs(x) < 0.002) C.steer = 0;
        else {
          const a = cfg.steerSensitivity * Math.abs(x);
          C.steer = sgn(x) * (a * a - 0.002) * 1.002004;
        }
      } else {
        if (x === 0) {
          C.steer = towardZero(C.steer, 4.0 * dt);
          if (Math.abs(C.steer) < 0.01) C.steer = 0;
        } else {
          const r = (x * x + 0.5) * 3 * dt;
          C.steer += clamp(x - C.steer, -r, r);
        }
      }
    }

    C.throttle = clamp(C.throttle, 0, 1);
    C.brake = clamp(C.brake, 0, 1);
    C.handbrake = clamp(C.handbrake, 0, 1);
    C.steer = clamp(C.steer, -1, 1);
    C.gearUp = raw.gearUp;
    C.gearDown = raw.gearDown;
    return C;
  }
}
