/**
 * src/game/ghosts/format.ts — GHOSTS BUILDER. The original game's ghost file format (versions "2.0" = the shipped team
 * ghosts, "3.0" = what the game saves): parser, serializer and the 19-byte delta-frame codec. Spec and proofs:
 * research/formats/ghosts.md §2 and docs/orig/ghosts.md. No DOM, no three.js.
 *
 * Layout (little endian) [E load FUN_004dc1a0, save FUN_004dbdd0; D all 30 shipped files]:
 *   char[4]  version            "2.0\0" | "3.0\0"
 *   u32      frameCount
 *   str      carTemplate        u32 n + n bytes     ("Peugeot206Ghost")
 *   wstr     ghostName          u32 n + 2n bytes UTF-16LE
 *   [3.0]    str + wstr         second name pair (the saving profile) + 8 bytes date (a Windows FILETIME)
 *   u32      nSplits ; f32[nSplits]     split times (s); the last one is the ghost's total time
 *   f32[9]   initial state      px py pz qx qy qz qw steerDeg spinDeg
 *   u8[19]   frames[frameCount]
 *   [2.0 shipped] u8[20] trailer: never read by the loader [E]; kept opaque
 *
 * Frame (19 bytes) [E decode FUN_004dccb0, encode FUN_004dc7b0; executed under unicorn, see "Arithmetic" below]:
 *   u8 flags, s16 d[9]
 *   flags bit0 = HOLD: bytes 1..4 = u32 holdCount (the state stays for holdCount + 1 periods)
 *   flags bit(k+1), k = 0..6 = FINE (the delta was < 2^-15 of its range; encoded x 32768, decoded / 32768)
 *   value = prev + RANGE[k] * (FINE ? 2^-15 : 1) * d[k] / 32766.5
 *   RANGE = 32, 16, 32, 32, 32, 32, 32 (px py pz qx qy qz qw) , 128 (steer), 256 (spin)
 *
 * Arithmetic [E, corrected in this round]: the running game executes its x87 code with the FPU in SINGLE precision
 * (Direct3D 8 CreateDevice is called without D3DCREATE_FPU_PRESERVE: the behaviour flags at 0x68cf5e are 0x20 / 0x40 /
 * 0x50 / 0x80), so every x87 add / sub / mul / div result is rounded to float32 = Math.fround after every operation.
 * This is bit-exact against the functions executed under unicorn with the control word set to 0x7f (research/tools/
 * ghost_exe_fixtures.py; tests/game/ghosts/*). tools/assets/lib/formats/fmt_ghost.py mirrors it (decode_frame /
 * encode_frame; the older float64 "80-bit" model is kept there as *_x80 and differs by 1 ulp in ~8 % of components).
 */

export const GHOST_FRAME_BYTES = 19;
/** Recording rate: tickRate / (tickRate / 15) = 15 Hz at the 120 Hz tick [E FUN_004dcee0, 0x486ae4]. */
export const GHOST_HZ = 15;
/** Physics ticks per frame period (DAT_00876278 = 120 / 15). */
export const TICKS_PER_FRAME = 8;
/** Frames are recorded while the record index is <= 0x1434 (5172): at most 5173 frames (FUN_004db540). */
export const MAX_GHOST_FRAMES = 0x1434 + 1;
export const STATE_FLOATS = 9;

/** px py pz qx qy qz qw steerDeg spinDeg. */
export const RANGE: readonly number[] = [32, 16, 32, 32, 32, 32, 32, 128, 256];
const f32 = Math.fround;
/** Decode multiplier: float32(1 / 32766.5). */
const INV_Q = f32(1 / 32766.5);
/** 2^-15: the FINE threshold and scale (exact in float32). */
const FINE = 1 / 32768;
const ENC_Q = 32766.5;

export class GhostFormatError extends Error {}

export type GhostVersion = '2.0' | '3.0';

export interface GhostFile {
  version: GhostVersion;
  /** `<Car>Ghost` (the exe's template name). */
  carTemplate: string;
  ghostName: string;
  /** 3.0 only: the saving profile's name pair, as written. */
  profileTemplate?: string;
  profileName?: string;
  /** 3.0 only: the 8-byte date block (a Windows FILETIME, little endian). */
  date?: Uint8Array;
  /** Cumulative split times (s, float32); the last one is the total time. */
  splits: number[];
  /** px py pz qx qy qz qw steerDeg spinDeg (float32 values). */
  initial: Float32Array;
  /** frameCount * 19 bytes. */
  frames: Uint8Array;
  frameCount: number;
  /** Bytes after the frames (the shipped files carry 20 opaque bytes; saved 3.0 files none). */
  trailer: Uint8Array;
}

/** The ghost's car: `<Car>Ghost` minus "Ghost". */
export function ghostCarOf(template: string): string {
  return template.endsWith('Ghost') ? template.slice(0, -5) : template;
}

export const ghostTotalTime = (g: Pick<GhostFile, 'splits'>): number => (g.splits.length ? g.splits[g.splits.length - 1] : Infinity);

// ------------------------------------------------------------------------------------------------------- codec

/**
 * FUN_004dccb0: decode frame `fr[off .. off+19)` onto `prev` -> `out` (9 float32 values). `out` may alias `prev`.
 * Single-precision x87 (see the header): out[k] = f32(f32(f32(RANGE * fine * d) * INV_Q) + prev[k]); the spin sum is
 * wrapped to +-180 afterwards (compare the stored float32 with +180, then with -180).
 */
export function decodeFrame(prev: ArrayLike<number>, fr: Uint8Array, off: number, out: Float32Array | Float64Array | number[]): void {
  const flags = fr[off];
  const dv = new DataView(fr.buffer, fr.byteOffset + off + 1, 18);
  for (let k = 0; k < 9; k++) {
    const fine = k < 7 && flags & (2 << k) ? FINE : 1;
    out[k] = f32(f32(f32(RANGE[k] * fine * dv.getInt16(2 * k, true)) * INV_Q) + prev[k]);
  }
  if (out[8] > 180) out[8] = f32(out[8] - 360);
  if (out[8] < -180) out[8] = f32(out[8] + 360);
}

/**
 * FUN_004dc7b0: encode the change prev -> cur into 19 bytes at `out[off ..]`. Single-precision x87: d[k] =
 * clamp(f32(f32(cur - prev) / RANGE), -1, 1); FINE components (k < 7, |d| < 2^-15) are pre-scaled by 32768 (exact);
 * the int16 is trunc(f32(d * 32766.5)) (the product is rounded to float32 before __ftol truncates). The spin delta
 * is wrapped to +-180 first (4dca53..4dcaa1).
 */
export function encodeFrame(prev: ArrayLike<number>, cur: ArrayLike<number>, out: Uint8Array, off: number): void {
  let flags = 0;
  const dv = new DataView(out.buffer, out.byteOffset + off + 1, 18);
  for (let k = 0; k < 9; k++) {
    let dk: number;
    if (k === 8) {
      const s = f32(cur[8] - prev[8]);
      let w = s > 180 ? f32(s - 360) : s;
      if (w < -180) w = f32(w + 360);
      dk = f32(w / RANGE[8]);
    } else dk = f32(f32(cur[k] - prev[k]) / RANGE[k]);
    if (dk > 1) dk = 1;
    else if (dk < -1) dk = -1;
    if (k < 7 && Math.abs(dk) < FINE) {
      flags |= 2 << k;
      dk *= 32768;
    }
    const i = Math.trunc(f32(dk * ENC_Q));
    dv.setInt16(2 * k, i < -32768 ? -32768 : i > 32767 ? 32767 : i, true);
  }
  out[off] = flags;
}

export const isHoldFrame = (fr: Uint8Array, off: number): boolean => (fr[off] & 1) !== 0;
export const holdCountOf = (fr: Uint8Array, off: number): number =>
  (fr[off + 1] | (fr[off + 2] << 8) | (fr[off + 3] << 16) | (fr[off + 4] << 24)) >>> 0;

/**
 * The state at every recording period (hold frames expanded): states[0] = initial, states[i] = the state reached at
 * period i (a hold frame of count n adds n + 1 repeats of the previous state). Mirrors fmt_ghost.py key_states.
 */
export function keyStates(g: GhostFile): Float32Array[] {
  const out: Float32Array[] = [new Float32Array(g.initial)];
  let prev = new Float32Array(g.initial);
  for (let i = 0; i < g.frameCount; i++) {
    const off = i * GHOST_FRAME_BYTES;
    if (isHoldFrame(g.frames, off)) {
      const n = holdCountOf(g.frames, off);
      for (let r = 0; r <= n; r++) out.push(new Float32Array(prev));
    } else {
      const next = new Float32Array(9);
      decodeFrame(prev, g.frames, off, next);
      out.push(next);
      prev = next;
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------------------- parse / write

class Reader {
  o = 0;
  readonly b: Uint8Array;
  readonly dv: DataView;
  constructor(b: Uint8Array) {
    this.b = b;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  need(n: number): void {
    if (n < 0 || this.o + n > this.b.length) throw new GhostFormatError(`read past end (${this.o}+${n} > ${this.b.length})`);
  }
  take(n: number): Uint8Array {
    this.need(n);
    const v = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.dv.getFloat32(this.o, true);
    this.o += 4;
    return v;
  }
  str(): string {
    const n = this.u32();
    if (n > 4096) throw new GhostFormatError('string too long');
    let s = '';
    for (const c of this.take(n)) s += String.fromCharCode(c);
    return s;
  }
  wstr(): string {
    const n = this.u32();
    if (n > 4096) throw new GhostFormatError('string too long');
    const v = this.take(2 * n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(v[2 * i] | (v[2 * i + 1] << 8));
    return s;
  }
}

/** Parse a ghost file (FUN_004dc1a0). Throws GhostFormatError for anything the exe's loader would refuse. */
export function parseGhost(bytes: Uint8Array): GhostFile {
  const r = new Reader(bytes);
  const v = r.take(4);
  const version = String.fromCharCode(v[0], v[1], v[2]);
  if ((version !== '2.0' && version !== '3.0') || v[3] !== 0) throw new GhostFormatError(`unknown ghost version ${JSON.stringify(version)}`);
  const frameCount = r.u32();
  if (frameCount > MAX_GHOST_FRAMES + 1) throw new GhostFormatError(`frame count ${frameCount} too large`);
  const g: GhostFile = {
    version,
    frameCount,
    carTemplate: r.str(),
    ghostName: r.wstr(),
    splits: [],
    initial: new Float32Array(9),
    frames: new Uint8Array(0),
    trailer: new Uint8Array(0),
  };
  if (version === '3.0') {
    g.profileTemplate = r.str();
    g.profileName = r.wstr();
    g.date = new Uint8Array(r.take(8));
  }
  const n = r.u32();
  if (n > 4096) throw new GhostFormatError('too many splits');
  for (let i = 0; i < n; i++) g.splits.push(r.f32());
  for (let i = 0; i < 9; i++) g.initial[i] = r.f32();
  g.frames = new Uint8Array(r.take(frameCount * GHOST_FRAME_BYTES));
  g.trailer = new Uint8Array(bytes.subarray(r.o));
  for (let i = 0; i < 9; i++) if (!Number.isFinite(g.initial[i])) throw new GhostFormatError('non-finite initial state');
  return g;
}

function putU32(out: number[], v: number): void {
  out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
}

/** Serialize in the file's own version (a 2.0 file keeps its trailer; 3.0 gets the profile pair and the date). */
export function writeGhost(g: GhostFile): Uint8Array {
  const head: number[] = [g.version.charCodeAt(0), g.version.charCodeAt(1), g.version.charCodeAt(2), 0];
  const putStr = (s: string) => {
    putU32(head, s.length);
    for (let i = 0; i < s.length; i++) head.push(s.charCodeAt(i) & 255); // narrow strings are latin-1 (see Reader.str)
  };
  const putW = (s: string) => {
    putU32(head, s.length);
    for (let i = 0; i < s.length; i++) head.push(s.charCodeAt(i) & 255, s.charCodeAt(i) >> 8);
  };
  putU32(head, g.frameCount);
  putStr(g.carTemplate);
  putW(g.ghostName);
  if (g.version === '3.0') {
    putStr(g.profileTemplate ?? g.carTemplate);
    putW(g.profileName ?? g.ghostName);
    const d = g.date ?? new Uint8Array(8);
    for (let i = 0; i < 8; i++) head.push(d[i] ?? 0);
  }
  putU32(head, g.splits.length);
  const f = new DataView(new ArrayBuffer(4));
  for (const s of g.splits) {
    f.setFloat32(0, s, true);
    for (let i = 0; i < 4; i++) head.push(f.getUint8(i));
  }
  for (let i = 0; i < 9; i++) {
    f.setFloat32(0, g.initial[i], true);
    for (let j = 0; j < 4; j++) head.push(f.getUint8(j));
  }
  const body = g.frames.subarray(0, g.frameCount * GHOST_FRAME_BYTES);
  const out = new Uint8Array(head.length + body.length + g.trailer.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(g.trailer, head.length + body.length);
  return out;
}

/** A Windows FILETIME (100 ns ticks since 1601-01-01 UTC, little endian) for a ms-since-epoch time. */
export function fileTimeBytes(ms: number): Uint8Array {
  const t = BigInt(Math.round(ms)) * 10000n + 116444736000000000n;
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, t, true);
  return out;
}

/** Inverse of fileTimeBytes (ms since epoch), or null for a zero / nonsensical date. */
export function fileTimeToMs(b: Uint8Array | undefined): number | null {
  if (!b || b.length < 8) return null;
  const t = new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  if (t === 0n) return null;
  const ms = Number((t - 116444736000000000n) / 10000n);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
