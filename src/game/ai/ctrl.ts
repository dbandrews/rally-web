/**
 * src/game/ai/ctrl.ts — the original AI's low-level "drive to a point at a speed" controller, FUN_007e0540
 * (research/formats/ai.md section 5.6, docs/orig/ai.md section 2). Transcribed from `ref_controller` in
 * research/tools/ai_ctrl_emu.py, which is proven against the ORIGINAL x87 code executed in unicorn (20 000 random
 * cases, worst |delta| 2.4e-7); this port is proven against the same code on the committed 6 000-vector fixture
 * `tests/game/ai/fixtures/ctrl.json` (tests/game/ai/ctrl.test.ts; max |delta| <= 1e-6).
 *
 * Float32 discipline: every value the exe keeps in a float32 object field or local is rounded with Math.fround at the
 * same place; intermediates are float64 (the exe computes them in the x87 extended registers).
 *
 * The state block is the car's object at +0x1b4 (`state`, `sub`, `timer`, `prev`, `v`, `p`, `h`); FUN_007e0500 loads
 * `v` (signed forward speed, m/s), `p` (position) and `h` (heading, horizontal) before every call (`setInputs`).
 */
const f32 = Math.fround;
// x87 at the game's 24-bit precision control: every FADD/FSUB/FMUL/FDIV/FSQRT result is rounded to float32 (docs/orig/ai.md section 1).
const mul = (a: number, b: number): number => f32(a * b);
const add = (a: number, b: number): number => f32(a + b);
const sub = (a: number, b: number): number => f32(a - b);
const div = (a: number, b: number): number => f32(a / b);

/** FUN_007e0540 static constant 0x946ddc = (1e-12f)^2 (static initialiser 0x7e03c0). */
const TINY2 = f32(f32(1e-12) * f32(1e-12));
/** float32 immediates the exe compares/multiplies with (fcomp/fmul DWORD PTR): 0x83b8d0, 0x83b900, 0x83b904, 0x83b8f4, 0x8070cc, 0x81b51c. */
const EPS1 = f32(1e-12);
const V_STOP = f32(0.03);
const V_SLOW = f32(1.4);
const K_SPD = f32(0.00045);
const K_NEAR = f32(0.05);
const K_FAR = f32(0.15);

/** The in/out pedal values the controller edits in place (the exe passes three float pointers). */
export interface CtrlIo {
  steer: number;
  thr: number;
  brk: number;
}

export class AiController {
  /** 0 drive, 1 three-point turn, 2 stop, 5 stopped (3 and 4 fall through the exe's switch: outputs unchanged). */
  state = 0;
  sub = 0;
  timer = 0;
  prev = 0;
  v = 0;
  px = 0;
  py = 0;
  pz = 0;
  hx = 0;
  hy = 0;
  hz = 0;

  /** FUN_007e0500: speed, position and heading of the car for the next call. */
  setInputs(v: number, px: number, py: number, pz: number, hx: number, hy: number, hz: number): void {
    this.v = f32(v);
    this.px = f32(px);
    this.py = f32(py);
    this.pz = f32(pz);
    this.hx = f32(hx);
    this.hy = f32(hy);
    this.hz = f32(hz);
  }

  /** FUN_007e04d0: zero the whole 11-word state block (state, sub, timer, prev, v, p, h). */
  reset(): void {
    this.state = 0;
    this.sub = 0;
    this.timer = 0;
    this.prev = 0;
    this.v = this.px = this.py = this.pz = this.hx = this.hy = this.hz = 0;
  }

  /**
   * FUN_007e0540(&steer, &throttle, &brake, targetSpeed (m/s), reverse, tx,ty,tz (target point), dx,dy,dz (heading
   * direction), dt, &outByte). Returns the out byte (1 when braking-to-reverse: targetSpeed < 0 or state 1/2).
   */
  update(io: CtrlIo, targetSpeed: number, reverse: number, tx: number, _ty: number, tz: number, dx: number, _dy: number, dz: number, dt: number): number {
    targetSpeed = f32(targetSpeed);
    tx = f32(tx);
    tz = f32(tz);
    dx = f32(dx);
    dz = f32(dz);
    dt = f32(dt);
    const ex = sub(tx, this.px);
    const ez = sub(tz, this.pz);
    const n2 = add(mul(ex, ex), mul(ez, ez));
    let ux = ex;
    let uz = ez;
    if (Math.abs(sub(n2, 1.0)) >= EPS1) {
      if (Math.abs(n2) >= TINY2) {
        const inv = div(1.0, f32(Math.sqrt(n2)));
        ux = mul(ex, inv);
        uz = mul(ez, inv);
      } else {
        ux = 0;
        uz = 0;
      }
    }
    const accel = dt > 0 ? div(sub(this.v, this.prev), dt) : 0;
    let band = 0;
    this.prev = this.v;
    let err = sub(targetSpeed, add(mul(accel, 0.25), this.v));
    const av = Math.abs(this.v);
    if (this.v < 0.5 && targetSpeed === 0) {
      err = 0;
      band = 6;
    }
    const dotDirH = add(mul(ux, this.hx), mul(uz, this.hz)); // FUN_007e1130(u, h)
    const st = this.state;
    if (st === 0) {
      if (targetSpeed <= av || V_SLOW <= av) this.timer = 0;
      else this.timer = add(dt, this.timer);
      if (3.0 <= this.timer) {
        this.state = 2;
        this.timer = 0;
      } else if (dotDirH < 0) {
        this.state = 1;
        this.timer = 0;
        this.sub = 0;
      }
    } else if (st === 1) {
      this.timer = add(dt, this.timer);
      if (dotDirH < 0.125) {
        if (1.0 < this.timer && this.sub !== 0) {
          if (this.sub === 1) {
            this.sub = 2;
            this.timer = 0;
          } else {
            if (this.sub === 3) {
              this.state = 5;
              this.sub = 0;
            }
            this.timer = 0;
          }
        }
      } else {
        this.state = 5;
        this.timer = 0;
        this.sub = 0;
      }
    } else if (st === 2) {
      if (2.0 <= this.timer) {
        this.state = 5;
        this.timer = 0;
      } else this.timer = add(dt, this.timer);
    } else if (st === 5 && av < V_STOP) {
      this.state = 0;
    }
    const out = targetSpeed < 0 || this.state === 1 || this.state === 2 ? 1 : 0;

    const s2 = this.state;
    if (s2 === 0) {
      if (reverse === 0) {
        const cr = sub(mul(ux, this.hz), mul(uz, this.hx)); // FUN_007e1110(u, h)
        let d: number;
        if (cr >= 0) d = cr > 0 ? mul(Math.abs(mul(cr, 800.0)), dt) : 0;
        else d = -mul(Math.abs(mul(cr, 800.0)), dt);
        const diff = Math.abs(sub(d, io.steer));
        let k: number;
        if (diff < 0.05) k = add(dt, dt);
        else if (diff < 0.15) k = mul(mul(sub(K_NEAR, mul(av, K_SPD)), 200.0), dt);
        else k = mul(mul(sub(K_FAR, mul(av, K_SPD)), 200.0), dt);
        if (d > io.steer) io.steer = add(k, io.steer);
        else if (d < io.steer) io.steer = sub(io.steer, k);
      } else if (reverse === 1) {
        const cr = sub(mul(this.hx, dz), mul(this.hz, dx)); // FUN_007e1110(h, dir)
        io.steer = cr >= 0 ? -Math.abs(mul(mul(cr, dt), 800.0)) : Math.abs(mul(mul(cr, dt), 800.0));
      }
      if (err <= 0) {
        if (err >= 0) {
          if (band > 6) return out;
        } else if (accel > 0 || err < -16.0) band = 0;
        else if (err >= -8.0) band = 4;
        else band = 2;
      } else if (accel < 0 || err > 16.0) band = 1;
      else if (err <= 8.0) band = 5;
      else band = 3;
      if (band === 6) {
        io.thr = 0;
        io.brk = 0;
        return out;
      }
      if (band === 1 || band === 3 || band === 5) {
        const k = band === 1 ? dt * 4.0 : band === 3 ? dt + dt : dt * 0.5;
        io.thr = add(k, io.thr);
        io.brk = 0;
        return out;
      }
      const k = band === 0 ? dt * 4.0 : band === 2 ? dt + dt : dt * 0.5;
      io.thr = sub(io.thr, k);
      io.brk = add(k, io.brk);
      return out;
    }
    if (s2 === 1) {
      const ss = this.sub;
      if (ss === 0 || ss === 2) {
        if (av >= V_STOP) {
          if (this.v >= 0) {
            io.steer = 0;
            io.thr = 0;
            io.brk = 0.5;
          } else {
            io.steer = 0;
            io.thr = 0.5;
            io.brk = 0;
          }
          return out;
        }
        this.sub = ss === 0 ? 1 : 3;
        this.timer = 0;
        const cr = sub(mul(ex, this.hz), mul(ez, this.hx)); // FUN_007e1110((ex,0,ez), h), unnormalised
        io.steer = ss === 0 ? (cr < 0 ? 1.0 : -1.0) : cr < 0 ? -1.0 : 1.0;
        return out;
      }
      if (ss === 1) {
        io.thr = 0;
        io.brk = 1.0;
        return out;
      }
      if (ss === 3) {
        io.thr = 1.0;
        io.brk = 0;
        return out;
      }
      return out;
    }
    if (s2 === 2) {
      io.steer = 0;
      io.thr = 0;
      io.brk = 1.0;
      return out;
    }
    if (s2 === 5) {
      io.steer = 0;
      if (this.v >= 0) {
        io.thr = 0;
        io.brk = 0.5;
      } else {
        io.thr = 0.5;
        io.brk = 0;
      }
      return out;
    }
    return out;
  }
}
