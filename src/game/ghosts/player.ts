/**
 * src/game/ghosts/player.ts — GHOSTS BUILDER. Tick-exact ghost playback: FUN_004db730 (the playback step the ghost
 * manager FUN_004a7390 calls once per physics tick while the race runs) with the manager's hold counter (this+0x284).
 * Spec: research/formats/ghosts.md §3.2/§3.3.
 *
 * One call to step() = one 120 Hz tick from GO. A frame covers 8 ticks (15 Hz); tick 0 shows the initial state; frame k
 * is reached at tick 8k + 7; between two frames the position is linear, steer / spin linear, the orientation a
 * sign-aware slerp whose output is NOT unit length (the weights carry 1/sqrt(|R^2 - 1|); the consumer FUN_0049bb90
 * divides by |q|^2, so only the direction matters: use `normalizeQuat`). A HOLD frame repeats the previous state for
 * holdCount + 1 periods. The last frame is never shown: the call returns false once `k >= frameCount - 1` and the caller
 * keeps the last applied pose (7/8 of the way into the last segment).
 *
 * Arithmetic: the game's x87 runs in single precision (format.ts header), so every operation rounds to float32; the
 * transcendentals (acos, sin) run at full precision. Positions / steer / spin reproduce the unicorn execution of
 * FUN_004db730 bit for bit (tests/game/ghosts/player.test.ts, fixtures from research/tools/ghost_exe_fixtures.py).
 */
import { GHOST_FRAME_BYTES, TICKS_PER_FRAME, decodeFrame, holdCountOf, isHoldFrame, type GhostFile } from './format';

const f32 = Math.fround;

/** CRT acos (0x7a0770): fpatan(sqrt((1 + x)(1 - x)), x); the transcendental runs at full precision. */
function acosX87(x: number): number {
  return Math.atan2(Math.sqrt(f32(1 + x) * f32(1 - x)), x);
}

export class GhostPlayer {
  readonly file: GhostFile;
  /** G+0x78: the segment (frame) index. */
  k = 0;
  /** G+0x7c: the tick inside the segment, 0..7. */
  c = 0;
  /** this+0x284: the hold counter. */
  hold = 0;
  /** step() calls so far that returned true (= the exe's applied ticks). */
  ticks = 0;
  /** step() returned false: frozen at the last applied pose. */
  finished = false;
  /** G+0xa4: the previous state (the exe keeps the decoded frame state, not the interpolated one). */
  private readonly prev = new Float32Array(9);
  private readonly dec = new Float32Array(9);

  constructor(file: GhostFile) {
    this.file = file;
    this.rewind();
  }

  rewind(): void {
    this.k = this.c = 0;
    this.hold = 0;
    this.ticks = 0;
    this.finished = false;
    this.prev.set(this.file.initial);
  }

  /**
   * One tick. Writes the 9-float state (px py pz qx qy qz qw steerDeg spinDeg; the quaternion is the exe's raw,
   * non-normalised slerp output) into `out` and returns true; returns false (out untouched) at the end.
   */
  step(out: Float32Array | Float64Array | number[]): boolean {
    const g = this.file;
    if (g.frameCount - 1 <= this.k) {
      this.finished = true;
      return false;
    }
    const prev = this.prev;
    if (this.k === 0 && this.c === 0) {
      prev.set(g.initial);
      // [E, unicorn] the exe re-enters this start branch at k = 0, c = 0 and clears the counter there, so a HOLD at frame 0
      // lasts ONE period whatever its count (the count is only loaded at the end of a period, when the counter is < 0).
      // Not a bug to "fix": format.ts keyStates (the logical n + 1) differs for that case only; recorded files never have it.
      this.hold = 0;
    }
    const off = this.k * GHOST_FRAME_BYTES;
    const hold = isHoldFrame(g.frames, off);
    const dec = this.dec;
    if (!hold) {
      decodeFrame(prev, g.frames, off, dec);
      // single-precision x87: every operation rounds to float32 (format.ts header)
      const f = f32(this.c / TICKS_PER_FRAME); // fVar5
      const a = f32(1 - f); // fVar4
      const z = f32(dec[2] * f);
      const py = f32(a * prev[1]);
      const pz = f32(a * prev[2]);
      out[0] = f32(f32(a * prev[0]) + f32(dec[0] * f));
      out[1] = f32(py + f32(dec[1] * f));
      out[2] = f32(pz + z);
      // dot = prev.w * next.w + (FUN_004076d0: z, then y, then x products summed)
      const dxyz = f32(f32(f32(dec[5] * prev[5]) + f32(dec[4] * prev[4])) + f32(dec[3] * prev[3]));
      const dot = f32(f32(dec[6] * prev[6]) + dxyz);
      let wa = a;
      let wb = f;
      const neg = dot < 0;
      const cs = neg ? -dot : dot; // the sign branch of 0x4db920: acos(|dot|), `1e-6 < 1 - |dot|`
      if (1e-6 < f32(1 - cs)) {
        const r = acosX87(cs);
        const k = f32(1 / f32(Math.sqrt(Math.abs(f32(f32(r * r) - 1)))));
        wa = f32(Math.sin(f32(a * r)) * k);
        wb = f32(Math.sin(f32(r * f)) * k);
      }
      if (!neg) {
        out[6] = f32(f32(dec[6] * wb) + f32(wa * prev[6]));
        for (let i = 3; i < 6; i++) out[i] = f32(f32(prev[i] * wa) + f32(dec[i] * wb));
      } else {
        out[6] = f32(f32(wa * prev[6]) - f32(dec[6] * wb));
        for (let i = 3; i < 6; i++) out[i] = f32(f32(prev[i] * wa) - f32(dec[i] * wb));
      }
      out[7] = f32(f32(dec[7] * f) + f32(a * prev[7]));
      out[8] = f32(f32(dec[8] * f) + f32(a * prev[8]));
    } else {
      for (let i = 0; i < 9; i++) out[i] = prev[i];
    }
    this.ticks++;
    this.c++;
    if (this.c >= TICKS_PER_FRAME) {
      this.c = 0;
      if (hold && this.hold < 0) this.hold = holdCountOf(g.frames, off);
      this.hold--;
      if (this.hold < 0) {
        this.k++;
        if (!hold) prev.set(dec);
      }
    }
    return true;
  }

  /** Run the first `n` ticks (a late-loaded ghost catching up with the race clock). `out` receives the last pose. */
  seek(n: number, out: Float32Array | Float64Array | number[]): boolean {
    this.rewind();
    let ok = false;
    for (let i = 0; i < n; i++) ok = this.step(out) || ok;
    return ok;
  }
}

/** Normalise the quaternion part (indices 3..6) in place; the exe's consumer scales by 2/|q|^2 (FUN_0049bb90). */
export function normalizeQuat(s: Float32Array | Float64Array | number[]): void {
  const n = Math.hypot(s[3], s[4], s[5], s[6]);
  if (n > 0) {
    s[3] /= n;
    s[4] /= n;
    s[5] /= n;
    s[6] /= n;
  } else {
    s[3] = s[4] = s[5] = 0;
    s[6] = 1;
  }
}
