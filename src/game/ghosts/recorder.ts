/**
 * src/game/ghosts/recorder.ts — GHOSTS BUILDER. Tick-exact ghost recording: FUN_004db540, called once per physics tick
 * while the race runs (docs: research/formats/ghosts.md §3.1).
 *
 * The recorder is a 15 Hz delta coder on the 120 Hz tick: the first call stores the state as the initial state and as
 * "previous" (tick 0); on every 8th call (ticks 7, 15, 23, ... = frame k at tick 8k + 7) the new state is encoded
 * against the previous one (FUN_004dc7b0), DECODED again (FUN_004dccb0) and the decoded state becomes the new previous
 * state, so the quantisation error never accumulates. A frame whose nine s16 deltas are all zero is not stored: it
 * creates or extends a HOLD frame (count 1, then +1 per further period) in the slot at the record index, and the index
 * only moves on when a non-hold frame follows. Recording stops after the record index passes 0x1434, i.e. at most 5173
 * frames. `frameCount` (G+4) is the record index, so a trailing hold slot is not counted.
 *
 * Quirk reproduced [E by reading the code]: the first-call branch tests `index == 0 && sub == 0`, which is also true after
 * a hold in slot 0 (the car stood still for a whole period), so while the car has not moved yet every period re-samples
 * the initial state and clears the slot's hold flag: a stationary start is trimmed to the first period with movement.
 */
import {
  GHOST_FRAME_BYTES,
  MAX_GHOST_FRAMES,
  TICKS_PER_FRAME,
  decodeFrame,
  encodeFrame,
  fileTimeBytes,
  type GhostFile,
} from './format';

const f32 = Math.fround;

export class GhostRecorder15 {
  /** G+0x78: the record index (slot being written). */
  index = 0;
  /** G+0x7c: ticks since the last frame (0..7). */
  sub = 0;
  /** G+4: the number of frames the file will hold. */
  frameCount = 0;
  /** G+0x80 / G+0xa4. */
  readonly initial = new Float32Array(9);
  private readonly prev = new Float32Array(9);
  private readonly enc = new Uint8Array(GHOST_FRAME_BYTES);
  private readonly dec = new Float32Array(9);
  private readonly cur = new Float32Array(9);
  /** Frame slots; one spare for the slot being written when the cap is reached. */
  readonly frames = new Uint8Array((MAX_GHOST_FRAMES + 1) * GHOST_FRAME_BYTES);
  private active = false;

  get recording(): boolean {
    return this.active;
  }

  /** Begin a new recording (the exe resets the slot at race start: FUN_004db450 / FUN_004db210). */
  start(): void {
    this.index = 0;
    this.sub = 0;
    this.frameCount = 0;
    this.frames.fill(0);
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  /** One tick with the car's state (9 values: px py pz qx qy qz qw steerDeg spinDeg). Returns false when not recording. */
  sample(state: ArrayLike<number>): boolean {
    if (!this.active) return false;
    const cur = this.cur;
    for (let i = 0; i < 9; i++) cur[i] = f32(state[i]);
    const fr = this.frames;
    if (this.index === 0 && this.sub === 0) {
      this.initial.set(cur);
      this.prev.set(cur);
      fr[0] = 0; // **(G+200) = 0: clears slot 0's flags (and any hold on it)
    }
    if (this.index > 0x1434) return true; // the cap: nothing more is recorded (the call still returns true)
    if (this.sub < TICKS_PER_FRAME - 1) {
      this.sub++;
      return true;
    }
    const enc = this.enc;
    encodeFrame(this.prev, cur, enc, 0);
    decodeFrame(this.prev, enc, 0, this.dec);
    let allZero = true;
    for (let i = 1; i < GHOST_FRAME_BYTES; i++) {
      if (enc[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      const o = this.index * GHOST_FRAME_BYTES;
      if ((fr[o] & 1) === 0) {
        fr[o] |= 1;
        fr[o + 1] = 1;
        fr[o + 2] = fr[o + 3] = fr[o + 4] = 0;
      } else {
        const n = (fr[o + 1] | (fr[o + 2] << 8) | (fr[o + 3] << 16) | (fr[o + 4] << 24)) + 1;
        fr[o + 1] = n & 255;
        fr[o + 2] = (n >>> 8) & 255;
        fr[o + 3] = (n >>> 16) & 255;
        fr[o + 4] = (n >>> 24) & 255;
      }
    } else {
      if ((fr[this.index * GHOST_FRAME_BYTES] & 1) !== 0) this.index++;
      fr.set(enc, this.index * GHOST_FRAME_BYTES);
      this.index++;
    }
    this.prev.set(this.dec);
    this.frameCount = this.index;
    this.sub = 0;
    return true;
  }

  /**
   * The recording as a 3.0 file (what SAVE GHOST writes, FUN_004dbdd0: no trailer). `splits` are the run's cumulative
   * split times, the last one the total time.
   */
  toFile(opts: { car: string; name: string; profile?: string; splits: readonly number[]; date?: number }): GhostFile {
    const n = this.frameCount;
    return {
      version: '3.0',
      carTemplate: `${opts.car}Ghost`,
      ghostName: opts.name,
      // the second pair: FUN_004dbc80 stores the typed name narrow (G+0x2c) as well as wide [E]; the wide one is [I]
      profileTemplate: opts.name,
      profileName: opts.profile ?? opts.name,
      date: fileTimeBytes(opts.date ?? Date.now()),
      splits: opts.splits.map(f32),
      initial: new Float32Array(this.initial),
      frames: this.frames.slice(0, n * GHOST_FRAME_BYTES),
      frameCount: n,
      trailer: new Uint8Array(0),
    };
  }
}
