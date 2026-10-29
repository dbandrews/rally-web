/**
 * src/game/ghost.ts — game builder. Ghost of the best run: the race controller records the player's render
 * pose (THREE space) at 30 Hz of race time and replays it on the next run of the same stage + car.
 *
 * Storage format: Float32 samples [px, py, pz, qw, qx, qy, qz, steerAngle] at GHOST_HZ, encoded base64
 * (≈ 32 B per sample: a 3-minute stage ≈ 230 kB of text in localStorage).
 */
import { DT } from '../core/constants';
import type { ThreeQuat, ThreeV3 } from '../core/types';

export const GHOST_HZ = 30;
/** Physics steps per ghost sample (120 / 30 = 4, exact). */
export const GHOST_STEP_DIV = Math.round(1 / (DT * GHOST_HZ));
const STRIDE = 8;
/** Hard cap: 20 minutes of samples. */
const MAX_SAMPLES = GHOST_HZ * 60 * 20;

export interface GhostTrack {
  hz: number;
  /** Number of samples. */
  count: number;
  /** count × STRIDE floats. */
  data: Float32Array;
}

export interface GhostPose {
  pos: ThreeV3;
  quat: ThreeQuat;
  steerAngle: number;
}

export const ghostDuration = (g: GhostTrack): number => (g.count > 0 ? (g.count - 1) / g.hz : 0);

export class GhostRecorder {
  private buf = new Float32Array(GHOST_HZ * 60 * 4 * STRIDE);
  private n = 0;
  private active = false;

  get recording(): boolean {
    return this.active;
  }
  get count(): number {
    return this.n;
  }

  /** Start a new recording (sample 0 = the pose at GO). */
  start(): void {
    this.n = 0;
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  /** Append one sample. Call at time = k / GHOST_HZ (every GHOST_STEP_DIV physics steps). */
  push(pos: ThreeV3, quat: ThreeQuat, steerAngle: number): void {
    if (!this.active || this.n >= MAX_SAMPLES) return;
    if ((this.n + 1) * STRIDE > this.buf.length) {
      const nb = new Float32Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    const o = this.n * STRIDE;
    const b = this.buf;
    b[o] = pos.x;
    b[o + 1] = pos.y;
    b[o + 2] = pos.z;
    b[o + 3] = quat.w;
    b[o + 4] = quat.x;
    b[o + 5] = quat.y;
    b[o + 6] = quat.z;
    b[o + 7] = Number.isFinite(steerAngle) ? steerAngle : 0;
    this.n++;
  }

  /** Snapshot of what has been recorded so far. */
  track(): GhostTrack {
    return { hz: GHOST_HZ, count: this.n, data: this.buf.slice(0, this.n * STRIDE) };
  }
}

/**
 * Interpolated ghost pose at race time t (s). Before 0 → first sample; after the end → last sample
 * (the ghost waits at the finish). Writes into `out` and returns it, or null for an empty track.
 */
export function sampleGhost(g: GhostTrack, t: number, out?: GhostPose): GhostPose | null {
  if (g.count === 0) return null;
  const o: GhostPose = out ?? { pos: { x: 0, y: 0, z: 0 }, quat: { w: 1, x: 0, y: 0, z: 0 }, steerAngle: 0 };
  const f = Math.max(0, Math.min(g.count - 1, t * g.hz));
  const i0 = Math.min(g.count - 1, Math.floor(f));
  const i1 = Math.min(g.count - 1, i0 + 1);
  const a = f - i0;
  const d = g.data;
  const p = i0 * STRIDE;
  const q = i1 * STRIDE;
  o.pos.x = d[p] + (d[q] - d[p]) * a;
  o.pos.y = d[p + 1] + (d[q + 1] - d[p + 1]) * a;
  o.pos.z = d[p + 2] + (d[q + 2] - d[p + 2]) * a;
  // nlerp along the shorter arc
  let qw = d[q + 3];
  let qx = d[q + 4];
  let qy = d[q + 5];
  let qz = d[q + 6];
  if (d[p + 3] * qw + d[p + 4] * qx + d[p + 5] * qy + d[p + 6] * qz < 0) {
    qw = -qw;
    qx = -qx;
    qy = -qy;
    qz = -qz;
  }
  let w = d[p + 3] + (qw - d[p + 3]) * a;
  let x = d[p + 4] + (qx - d[p + 4]) * a;
  let y = d[p + 5] + (qy - d[p + 5]) * a;
  let z = d[p + 6] + (qz - d[p + 6]) * a;
  const l = Math.hypot(w, x, y, z) || 1;
  w /= l;
  x /= l;
  y /= l;
  z /= l;
  o.quat.w = w;
  o.quat.x = x;
  o.quat.y = y;
  o.quat.z = z;
  o.steerAngle = d[p + 7] + (d[q + 7] - d[p + 7]) * a;
  return o;
}

// ------------------------------------------------------------------------------------------- encoding

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeGhost(g: GhostTrack): string {
  const data = g.data.slice(0, g.count * STRIDE);
  return JSON.stringify({ v: 1, hz: g.hz, count: g.count, stride: STRIDE, b64: bytesToBase64(new Uint8Array(data.buffer)) });
}

export function decodeGhost(text: string | null): GhostTrack | null {
  if (!text) return null;
  try {
    const o = JSON.parse(text) as { v: number; hz: number; count: number; stride: number; b64: string };
    if (o.v !== 1 || o.stride !== STRIDE || !(o.count > 0)) return null;
    const bytes = base64ToBytes(o.b64);
    if (bytes.byteLength !== o.count * STRIDE * 4) return null;
    const data = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { hz: o.hz, count: o.count, data };
  } catch {
    return null;
  }
}
