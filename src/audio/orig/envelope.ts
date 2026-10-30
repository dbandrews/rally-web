/**
 * src/audio/orig/envelope.ts — OWNED BY THE AUDIO BUILDER.
 *
 * The original's effect envelopes (research/formats/sound.md §3.2 + Verification §2):
 *   Linear (FUN_00605d70): y = p0 + p1·x
 *   Ramp   (FUN_00605e50, hand-decoded from the disassembly): params x0 x1 y0 dy curve exp
 *     x1 = max(x1, x0); x <= x0 → y0 (except the step x0 == x1 → y0 + dy at x >= x0); x >= x1 → y0 + dy;
 *     else t = (x − x0)/(x1 − x0) and trunc(curve) 0 linear, 1 ease-out 1 − (1 − t)^exp, 2 ease-in t^exp,
 *     any other value y0 + y0 (a bug in the original, unused by the data). The output is not clamped.
 * No three.js / Web Audio here (vitest).
 */
import type { EffectJson } from './bankTypes';

export const DEST_VOLUME = 0;
export const DEST_PITCH = 1;

export const SRC_DEFAULT = 0;
export const SRC_EXTERN = 1;
export const SRC_SPEED = 2;
export const SRC_ACCELERATION = 3;
export const SRC_DISTANCE = 4;
export const SRC_ALTITUDE = 5;
export const SRC_TIME = 6;
export const SRC_TIME_RELEASE = 7;

export const ENV_LINEAR = 0;
export const ENV_RAMP = 1;

/** Ramp envelope, FUN_00605e50 (compare order of the x87 code reproduced). */
export function ramp(p: readonly number[], x: number): number {
  const x0 = p[0];
  let x1 = p[1];
  const y0 = p[2];
  const dy = p[3];
  if (x1 < x0) x1 = x0;
  if (x <= x0) return x0 === x1 && x >= x0 ? y0 + dy : y0;
  if (x >= x1) return y0 + dy;
  const t = (x - x0) / (x1 - x0);
  switch (Math.trunc(p[4])) {
    case 0:
      return y0 + dy * t;
    case 1:
      return y0 + dy * (1 - Math.pow(1 - t, p[5]));
    case 2:
      return y0 + dy * Math.pow(t, p[5]);
    default:
      return y0 + y0; // the original's default branch (unused)
  }
}

/** Linear envelope, FUN_00605d70. */
export const linear = (p: readonly number[], x: number): number => p[0] + p[1] * x;

/** Inputs of one layer evaluation (FUN_007eb460 fills them per layer, FUN_00606480 picks one). */
export interface EffectSources {
  /** Patch externs (Car:: map, Collision::Volume = 0). */
  ext: ArrayLike<number>;
  /** |emitter velocity| m/s. */
  speed: number;
  /** |Δvelocity / dt|. */
  acceleration: number;
  /** |emitter − listener| m (0 without a listener). */
  distance: number;
  altitude: number;
  /** s since play(). */
  time: number;
  /** −1 until release(), then s since release. */
  timeRelease: number;
}

/** Source value x of an effect (FUN_00606480: Default = extern[0]). */
export function effectInput(e: EffectJson, s: EffectSources): number {
  switch (e.s) {
    case SRC_DEFAULT:
      return s.ext.length ? s.ext[0] : 0;
    case SRC_EXTERN:
      return e.x >= 0 && e.x < s.ext.length ? s.ext[e.x] : 0;
    case SRC_SPEED:
      return s.speed;
    case SRC_ACCELERATION:
      return s.acceleration;
    case SRC_DISTANCE:
      return s.distance;
    case SRC_ALTITUDE:
      return s.altitude;
    case SRC_TIME:
      return s.time;
    case SRC_TIME_RELEASE:
      return s.timeRelease;
    default:
      return 0;
  }
}

/** Output of one effect for its source value. */
export const evalEffect = (e: EffectJson, x: number): number => (e.e === ENV_LINEAR ? linear(e.p, x) : ramp(e.p, x));

/**
 * Volume and pitch of one layer (sound.md §3.3): vol = clamp(layer.volume ≤ 1, ≤ 0 → 0) · Π Volume effects ·
 * patchVolume; pitch = 1 · Π Pitch effects (the per-voice random start offset is added by the caller).
 * Matches fmt_sound.layer_eval for patchVolume 1 (the research tool clamps the product at 0; the original only
 * tests vol <= 0 → stop, so the raw product is returned here and the caller does the same test).
 */
export function layerVolumePitch(
  layer: { volume: number; fx: readonly EffectJson[] },
  s: EffectSources,
  patchVolume = 1,
): { volume: number; pitch: number } {
  let v = layer.volume > 1 ? 1 : layer.volume;
  let pitch = 1;
  if (v <= 0) v = 0;
  for (const e of layer.fx) {
    const y = evalEffect(e, effectInput(e, s));
    if (e.d === DEST_VOLUME) v *= y;
    else if (e.d === DEST_PITCH) pitch *= y;
  }
  return { volume: v * patchVolume, pitch };
}

/** Does the layer have a `Volume ← TimeRelease` effect (release() keeps such a loop fading, test 0x7ecbb0)? */
export const hasTimeReleaseVolume = (fx: readonly EffectJson[]): boolean =>
  fx.some((e) => e.d === DEST_VOLUME && e.s === SRC_TIME_RELEASE);
