/**
 * tests/sim/inputFilter.test.ts — OWNED BY THE SIM BUILDER.
 * §5.1 input filter: analog device presets, squared steering response, rate-limited type 0, pedal dead
 * zone, config/reset. (Digital ramps = §7 T17, in feel.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { DT, neutralRawInput } from '../../src/core/constants';
import type { RawInput } from '../../src/core/types';
import { InputFilter, makeInputFilterConfig } from '../../src/sim/inputFilter';

const pad = (o: Partial<RawInput>): RawInput => ({ ...neutralRawInput(), device: 'gamepad', ...o });
const wheel = (o: Partial<RawInput>): RawInput => ({ ...neutralRawInput(), device: 'wheel', ...o });

describe('§5.1 input filter (analog)', () => {
  it('defaults match §5.1 / §6', () => {
    expect(makeInputFilterConfig()).toEqual({
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
      pedalDeadzone: 0.08,
    });
  });
  it('gamepad: 0.1 rescaled dead zone, sqrtCurve 1 + squared response = net linear, no rate limit', () => {
    const f = new InputFilter();
    expect(f.update(pad({ steer: 0.09 }), DT).steer).toBe(0);
    const s = f.update(pad({ steer: 0.55 }), DT).steer; // x = 0.5 → sqrt → square → 0.5
    expect(s).toBeCloseTo((0.5 - 0.002) * 1.002004, 9);
    expect(f.update(pad({ steer: -1 }), DT).steer).toBeCloseTo(-1, 6); // instantly, both directions
    expect(f.update(pad({ steer: 1 }), DT).steer).toBeCloseTo(1, 6);
  });
  it('wheel: no dead zone, sqrtCurve 0 → squared response', () => {
    const f = new InputFilter();
    expect(f.update(wheel({ steer: 0.5 }), DT).steer).toBeCloseTo((0.25 - 0.002) * 1.002004, 9);
    expect(f.update(wheel({ steer: -0.5 }), DT).steer).toBeCloseTo(-(0.25 - 0.002) * 1.002004, 9);
  });
  it('centre quirk: |x| < 0.002 → 0; 0.002 ≤ |x| < 0.045 gives a tiny opposite-sign output (≤ 0.002), as the original', () => {
    const f = new InputFilter();
    expect(f.update(wheel({ steer: 0.001 }), DT).steer).toBe(0);
    const s = f.update(wheel({ steer: 0.01 }), DT).steer;
    expect(s).toBeLessThan(0);
    expect(Math.abs(s)).toBeLessThanOrEqual(0.002);
  });
  it('steeringType 0: rate-limited toward the target, returns to centre at 4/s', () => {
    const f = new InputFilter({ steeringType: 0 });
    let s = 0;
    for (let i = 0; i < 12; i++) s = f.update(wheel({ steer: 1 }), DT).steer;
    // rate (x² + 0.5)·3 = 4.5/s for x = 1 → 12 steps ≈ 0.45
    expect(s).toBeCloseTo(0.45, 6);
    for (let i = 0; i < 60; i++) s = f.update(wheel({ steer: 0 }), DT).steer;
    expect(s).toBe(0);
  });
  it('analog pedals: 0.08 dead zone (a trigger resting at 0.06 reads 0), rescaled; clamp to [0, 1]', () => {
    const f = new InputFilter();
    expect(f.update(pad({ throttle: 0.07, brake: 0.06, handbrake: 0.04 }), DT)).toMatchObject({ throttle: 0, brake: 0, handbrake: 0 });
    const c = f.update(pad({ throttle: 0.54, brake: 1, handbrake: 2 }), DT);
    expect(c.throttle).toBeCloseTo(0.5, 9);
    expect(c.brake).toBe(1);
    expect(c.handbrake).toBe(1);
  });
  it('setConfig is live; steerSensitivity scales before squaring; reset zeroes the ramps', () => {
    const f = new InputFilter();
    f.setConfig({ steerSensitivity: 2 });
    expect(f.update(wheel({ steer: 0.5 }), DT).steer).toBeCloseTo(1, 2); // (2·0.5)² - 0.002 → clamped ≈ 0.998
    f.setConfig({ keyThrottleStart: 0.3 });
    const kb = { ...neutralRawInput(), device: 'keyboard' as const, throttleDigital: true, throttle: 1 };
    expect(f.update(kb, DT).throttle).toBeCloseTo(0.3, 9);
    f.update(kb, DT);
    f.reset();
    expect(f.update(kb, DT).throttle).toBeCloseTo(0.3, 9);
  });
});
