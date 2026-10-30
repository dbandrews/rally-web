/**
 * src/audio/orig/rand.ts — OWNED BY THE AUDIO BUILDER.
 *
 * The two random generators the original sound code uses (deterministic here; the original seeds both from the
 * clock, so its sequences cannot be reproduced anyway):
 *   MsvcRand   the C runtime rand() (MSVC LCG, 15-bit): randomStartPitch, randomPlay bags, backfire / blow-out
 *              flags, the env-sound start roll.
 *   ParkMiller the shared generator DAT_008e959c (sound rpm jitter FUN_00746a00, whine drop-outs FUN_00747b10):
 *              state·24112 then ·26143 mod 2^31 − 1 (two Schrage steps = ×630360016).
 */

/** MSVC rand(): state = state·214013 + 2531011; return (state >> 16) & 0x7fff. */
export class MsvcRand {
  private state: number;
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }
  /** 0..32767 */
  next(): number {
    this.state = (Math.imul(this.state, 214013) + 2531011) >>> 0;
    return (this.state >>> 16) & 0x7fff;
  }
}

const M31 = 2147483647;

/** Park–Miller minimal standard with multiplier 630360016, as the original's two-step update. */
export class ParkMiller {
  private state: number;
  constructor(seed = 1) {
    this.state = seed % M31 || 1;
  }
  /** Next state 1..2^31 − 2 (the original uses `state % n`). */
  next(): number {
    this.state = (this.state * 24112) % M31; // exact in doubles: < 2^46
    this.state = (this.state * 26143) % M31;
    return this.state;
  }
}
