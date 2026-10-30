// src/game/carFlags.ts against a literal transcription of the exe's backfire (0x753410) and blow-out (0x753550)
// routines (objdump of original_desktop_version.exe; f32 literals 0x7fc78c 0.2, 0x82fa4c 1.3888889, 0x806614 1100,
// 0x8080ac 0.001, 0x8070d0 1.5, 0x7fc790 0.0001, 0x82fa48 400, 0x81b51c 0.15). The reference keeps the car fields
// by their offsets and follows the asm branch by branch, so a regression in the port shows up as a diverging flag.
import { describe, expect, it } from 'vitest';
import type { CarTelemetry } from '../../src/core/types';
import { CarFlagSource } from '../../src/game/carFlags';

const f32 = Math.fround;

/** MSVC rand() (0x79fd34). */
function crt(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 214013) + 2531011) >>> 0;
    return (s >>> 16) & 0x7fff;
  };
}

/** The car fields the two routines touch, by offset, and the car's virtuals they call. */
class ExeCar {
  f84 = 0; // backfire flag
  f88 = 0; // backfire timer (f32)
  f8c = 0; // blow-out flag
  f90 = 0; // blow-out timer (f32)
  f94 = 1; // gear at the last blow-out check
  readonly rand: () => number;
  constructor(rand: () => number) {
    this.rand = rand;
  }

  /** 0x753410 (this = car, arg = dt as f32). vt+0x28 throttle, vt+0x2c brake, vt+0x34 gear, vt+0x10c rpm. */
  backfire(dt: number, v: { thr: number; brake: number; gear: number; rpm: number }): void {
    const st = this.f88 - f32(dt); // fld [+0x88]; fsub [esp+8]
    this.f88 = f32(st); // fst [+0x88]
    if (st > 0) return void (this.f84 = 0); // fcomp 0; test ah,0x41; je → skip
    if (v.thr > 0) return void (this.f84 = 0);
    if (!(v.rpm > 1100 || Number.isNaN(v.rpm))) return void (this.f84 = 0); // test ah,0x41; jnp → skip
    this.f88 = 0;
    if (v.brake > 0 && v.gear === 0) return void (this.f84 = 0);
    if (v.thr > 0 && v.gear === 0) return void (this.f84 = 0);
    const n = Math.trunc(v.rpm * f32(0.001) + 1.5); // fmul 0x8080ac; fadd 0x8070d0; _ftol
    const r = this.rand();
    if (r % n === 0) return void (this.f84 = 0); // cdq; idiv ebx; test edx; je → skip
    const k = (this.rand() % 100) - 50; // idiv 100; sub 0x32; fild
    this.f84 = 1;
    this.f88 = f32(k / (v.rpm * f32(0.0001) * 400) + f32(0.15)); // fmul; fmul; fdivr; fadd; fstp [+0x88]
  }

  /** 0x753550 (arg = dt as f32). vt+0x118 speed (m/s), vt+0x34 gear. */
  blowOut(dt: number, v: { speed: number; gear: number }): void {
    const st = this.f90 + f32(dt); // fld [esp+4]; fadd [+0x90]
    this.f90 = f32(st); // fst [+0x90]
    if (st < f32(0.2)) return void (this.f8c = 0); // test ah,5; jnp → skip
    if (!(v.speed > f32(1.3888889))) return void (this.f8c = 0); // test ah,0x41; jnp → skip
    this.f90 = 0;
    if (v.gear !== this.f94) {
      if ((this.rand() % 6) + 1 <= 3) {
        this.f8c = 1;
        this.f94 = v.gear;
        return;
      }
    }
    this.f94 = v.gear;
    this.f8c = 0;
  }
}

/** A CarTelemetry with the fields the flag source reads. */
const tel = (o: { rpm: number; throttle: number; brake: number; gear: number; kmh: number }): CarTelemetry =>
  ({ rpm: o.rpm, throttle: o.throttle, brake: o.brake, gear: o.gear, speedKmh: o.kmh }) as unknown as CarTelemetry;

/** A drive: throttle blips and lifts, up / down shifts, reverse with the brake held, a stop; frame dt jitter. */
function* script(frames: number): Generator<{ dt: number; t: CarTelemetry; v: { thr: number; brake: number; gear: number; rpm: number; speed: number } }> {
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  let gear = 1;
  for (let i = 0; i < frames; i++) {
    const phase = Math.floor(i / 90) % 8;
    const thr = phase === 1 || phase === 3 || phase === 5 ? 0 : 0.2 + 0.8 * rnd();
    const brake = phase === 6 ? 0.6 : phase === 3 && rnd() < 0.3 ? 0.4 : 0;
    if (i % 150 === 75) gear = gear >= 5 ? 2 : gear + 1;
    if (phase === 6) gear = 0; // reverse with the brake held
    else if (gear === 0) gear = 1;
    const rpm = phase === 7 ? 900 + 150 * rnd() : 1000 + 7000 * rnd();
    const kmh = phase === 7 ? 3 * rnd() : 20 + 150 * rnd();
    const dt = 1 / 60 + (rnd() - 0.5) * 0.012;
    yield { dt, t: tel({ rpm, throttle: thr, brake, gear, kmh }), v: { thr, brake, gear, rpm, speed: kmh / 3.6 } };
  }
}

describe('CarFlagSource = the exe routines 0x753410 / 0x753550', () => {
  it('matches the literal transcription frame by frame (same CRT seed, same rand() draw order)', () => {
    for (const seed of [1, 7, 0xbeef]) {
      const port = new CarFlagSource(seed);
      const exe = new ExeCar(crt(seed));
      let bangs = 0;
      let blows = 0;
      for (const { dt, t, v } of script(6000)) {
        const f = port.update(dt, t);
        exe.backfire(dt, v);
        exe.blowOut(dt, v);
        expect([f.backfire, f.blowOut]).toEqual([exe.f84 === 1, exe.f8c === 1]);
        if (f.backfire) bangs++;
        if (f.blowOut) blows++;
      }
      // the script exercises both paths
      expect(bangs).toBeGreaterThan(20);
      expect(blows).toBeGreaterThan(5);
    }
  });

  it('backfire: n = trunc(rpm·0.001 + 1.5), only with the throttle closed above 1100 rpm, never with a pedal in reverse', () => {
    // rpm 2600: n = trunc(4.1) = 4 → bang unless rand() % 4 == 0
    const seed = 3;
    const r = crt(seed);
    const first = r();
    const src = new CarFlagSource(seed);
    expect(src.update(0.02, tel({ rpm: 2600, throttle: 0, brake: 0, gear: 3, kmh: 80 })).backfire).toBe(first % 4 !== 0);
    // throttle open / at 1100 rpm / brake in reverse: no bang and no rand() draw
    for (const t of [
      tel({ rpm: 5000, throttle: 0.1, brake: 0, gear: 3, kmh: 80 }),
      tel({ rpm: 1100, throttle: 0, brake: 0, gear: 3, kmh: 80 }),
      tel({ rpm: 5000, throttle: 0, brake: 0.5, gear: 0, kmh: 10 }),
    ]) {
      const a = new CarFlagSource(9);
      const b = new CarFlagSource(9);
      for (let i = 0; i < 50; i++) expect(a.update(0.02, t).backfire).toBe(false);
      // the generator did not advance: a fresh source with the same seed draws the same as the used one
      const lift = tel({ rpm: 5000, throttle: 0, brake: 0, gear: 3, kmh: 80 });
      expect(a.update(0.02, lift).backfire).toBe(b.update(0.02, lift).backfire);
    }
  });

  it('blow-out: checked every 0.2 s above 1.3888889 m/s; the gear is stored only past that gate', () => {
    const src = new CarFlagSource(5);
    const exe = new ExeCar(crt(5));
    // a gear change below 5 km/h: no check, the gear is NOT stored, so the change still counts once moving
    const steps: [number, number][] = [
      [3, 1], [3, 2], [3, 2], [3, 2], [3, 2], [3, 2], [3, 2], [3, 2], [3, 2], [3, 2], [3, 2], [3, 2], [3, 2],
      [30, 2], [30, 2], [30, 2], [30, 2], [30, 2], [30, 2], [30, 2], [30, 2], [30, 2], [30, 2], [30, 2], [30, 2], [30, 2],
    ];
    let blown = false;
    for (const [kmh, gear] of steps) {
      const f = src.update(1 / 60, tel({ rpm: 4000, throttle: 1, brake: 0, gear, kmh }));
      exe.backfire(1 / 60, { thr: 1, brake: 0, gear, rpm: 4000 });
      exe.blowOut(1 / 60, { speed: kmh / 3.6, gear });
      expect(f.blowOut).toBe(exe.f8c === 1);
      blown ||= f.blowOut;
    }
    expect(exe.f94).toBe(2);
    // 5 km/h exactly (the f32 1.3888889 m/s) is not above the gate
    const at = new CarFlagSource(1);
    for (let i = 0; i < 30; i++) expect(at.update(0.05, tel({ rpm: 4000, throttle: 1, brake: 0, gear: i % 2 ? 2 : 3, kmh: f32(1.3888889) * 3.6 - 1e-9 })).blowOut).toBe(false);
    void blown;
  });

  it('dt 0 (paused): both flags clear, the timers and the generator do not move', () => {
    const a = new CarFlagSource(11);
    const b = new CarFlagSource(11);
    const t = tel({ rpm: 6000, throttle: 0, brake: 0, gear: 3, kmh: 100 });
    for (let i = 0; i < 20; i++) expect(a.update(0, t)).toEqual({ backfire: false, blowOut: false });
    for (let i = 0; i < 40; i++) expect(a.update(1 / 60, t)).toEqual(b.update(1 / 60, t));
  });
});
