/**
 * src/audio/orig/ds.ts — OWNED BY THE AUDIO BUILDER.
 *
 * The original's DirectSound / DS3D setters as pure functions (research/formats/sound.md §3.3, §3.5, §14.2 and the
 * Verification): the volume law, the frequency clamp, the listener constants and the doppler shift that Web Audio
 * no longer does by itself. No Web Audio here (vitest).
 */
import type { SimV3 } from '../../core/types';

/** DS3D listener (Misc/object/CamListener.con): RollOffFactor 1, DopplerFactor 1.4, DistanceFactor 1. */
export const DS_ROLLOFF = 1;
export const DS_DOPPLER_FACTOR = 1.4;
/** DS3D speed of sound, m/s (DS3D_DEFAULTDOPPLERFACTOR scaling = 343.3 m/s per distance unit). */
export const DS_SPEED_OF_SOUND = 343.3;
/** Secondary-buffer frequency range of DirectSound 8 (DSBFREQUENCY_MIN / _MAX), Hz. */
export const DS_FREQ_MIN = 100;
export const DS_FREQ_MAX = 200000;
/** Max distance set explicitly at voice creation (1e9 m, 0x6024e4). Web Audio's PannerNode only needs a value
 *  past every audible distance; its inverse model then equals DS3D's minDistance / max(d, minDistance). */
export const DS_MAX_DISTANCE = 1e9;

/**
 * Voice volume → linear gain (3-D voice vt slot 7 0x6b5210, 2-D 0x6b3d90): v > 1 → 1, v ≤ 0 → silent,
 * mB = trunc(865.617·ln v) clamped to [−10000, 0], gain = 10^(mB / 2000) (≈ v^0.99658).
 */
export function dsGain(v: number): number {
  if (!(v > 0)) return 0;
  if (v > 1) v = 1;
  let mb = Math.trunc(865.617 * Math.log(v));
  if (mb < -10000) mb = -10000;
  if (mb > 0) mb = 0;
  return Math.pow(10, mb / 2000);
}

/**
 * Pitch → playback-rate multiplier (0x6b52a0): p = max(p, 0.001), freq = trunc(2^(log2 p) · nativeRate) clamped to
 * the device range, then SetFrequency. Returned as freq / nativeRate (Web Audio's playbackRate).
 */
export function dsPlaybackRate(pitch: number, nativeRate: number): number {
  const p = pitch > 0.001 ? pitch : 0.001;
  let f = Math.trunc(Math.pow(2, Math.log2(p)) * nativeRate);
  if (f < DS_FREQ_MIN) f = DS_FREQ_MIN;
  if (f > DS_FREQ_MAX) f = DS_FREQ_MAX;
  return f / nativeRate;
}

/**
 * DS3D doppler (DopplerFactor 1.4) as a playback-rate factor: f' / f = (c − k·vL) / (c − k·vS), with vS / vL the
 * source / listener velocity components along the source → listener direction (positive = moving toward the
 * listener's side). `dopplerOff` layers pass the listener velocity as the source velocity (FUN_007eab60), which
 * gives exactly 1. Positions / velocities in any one frame (SIM here). Clamped to [0.25, 4].
 */
export function dopplerFactor(srcPos: SimV3, srcVel: SimV3, lisPos: SimV3, lisVel: SimV3, k = DS_DOPPLER_FACTOR): number {
  const dx = lisPos.x - srcPos.x;
  const dy = lisPos.y - srcPos.y;
  const dz = lisPos.z - srcPos.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) return 1;
  const vs = (srcVel.x * dx + srcVel.y * dy + srcVel.z * dz) / d;
  const vl = (lisVel.x * dx + lisVel.y * dy + lisVel.z * dz) / d;
  const c = DS_SPEED_OF_SOUND;
  const den = Math.max(c * 0.05, c - k * vs);
  const num = Math.max(c * 0.05, c - k * vl);
  const r = num / den;
  return r < 0.25 ? 0.25 : r > 4 ? 4 : r;
}
