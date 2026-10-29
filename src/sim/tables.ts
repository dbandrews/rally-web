/**
 * src/sim/tables.ts — OWNED BY THE SIM BUILDER.
 *
 * Fixed numeric tables of docs/MECHANICS_SPEC.md and the pure functions that read them:
 *   - TORQUE_CURVE (§2.3.2, 124 entries, 78.125 rpm per entry) and torqueCurveAt(rpm)
 *   - LOAD_TABLE (§2.6.1, rows every 500 N, [Palpha, Pkappa, Dy, Dx]) and buildLoadTable() (closed form)
 *   - tyreForce() (§2.6.1 combined-slip tyre force, allocation free)
 * No three.js, no DOM.
 */
import type { WheelParams } from '../core/types';

/** §2.3.2 shared normalised torque curve [V int16/16384 table]. */
export const TORQUE_CURVE: readonly number[] = [
  0.1953, 0.1953, 0.1953, 0.1953, 0.1953, 0.1953, 0.1953, 0.1953, 0.1953, 0.1953, 0.1953, 0.1953, 0.1953, 0.1953, 0.1953, 0.1953,
  0.1953, 0.1953, 0.1953, 0.1953, 0.2026, 0.2054, 0.2065, 0.2063, 0.2055, 0.2046, 0.2041, 0.2047, 0.2067, 0.2109, 0.2178, 0.2279,
  0.2418, 0.2599, 0.2821, 0.3079, 0.3369, 0.3687, 0.4029, 0.439, 0.4767, 0.5156, 0.5552, 0.5952, 0.635, 0.6766, 0.7366, 0.8039,
  0.8602, 0.8912, 0.9135, 0.9318, 0.9467, 0.9584, 0.9675, 0.9745, 0.9798, 0.9838, 0.9872, 0.9904, 0.993, 0.9954, 0.9975, 0.9992,
  1.0005, 1.0016, 1.0023, 1.0027, 1.0028, 1.0026, 1.002, 1.0011, 0.9999, 0.9985, 0.9966, 0.9946, 0.9922, 0.9896, 0.9866, 0.9836,
  0.9806, 0.9776, 0.9745, 0.9714, 0.9681, 0.9647, 0.9611, 0.9573, 0.9534, 0.9491, 0.9445, 0.9396, 0.9343, 0.9287, 0.9226, 0.9161,
  0.9091, 0.9016, 0.8935, 0.8848, 0.8755, 0.8656, 0.855, 0.8438, 0.8317, 0.8187, 0.8047, 0.7898, 0.7737, 0.7564, 0.7379, 0.718,
  0.6967, 0.6738, 0.6495, 0.6235, 0.5958, 0.5663, 0.535, 0.5017, 0.4502, 0.3759, 0.2908, 0.2073,
];

/** §2.3.2 torqueCurve(): linear interpolation, 0 above 9500 rpm, last entry from index 123 on. */
export function torqueCurveAt(rpm: number): number {
  const r = Math.abs(rpm);
  if (r > 9500) return 0;
  const f = r * 0.0128;
  const i = Math.floor(f);
  if (i >= 123) return TORQUE_CURVE[123];
  return TORQUE_CURVE[i] + (TORQUE_CURVE[i + 1] - TORQUE_CURVE[i]) * (f - i);
}

/** §2.6.1 shipped LOAD_TABLE, row j at Fz = 500·j N: [Palpha, Pkappa, Dy, Dx] [V table at 0x859fa8]. */
export const LOAD_TABLE_SHIPPED: readonly (readonly [number, number, number, number])[] = [
  [0.4033, 0.3049, 1.0262, 1.0707], [0.4095, 0.3094, 1.0266, 1.0719], [0.4158, 0.314, 1.027, 1.0731], [0.4223, 0.3188, 1.0275, 1.0744],
  [0.4291, 0.3238, 1.028, 1.0757], [0.4361, 0.3289, 1.0285, 1.0771], [0.4433, 0.3342, 1.029, 1.0785], [0.4508, 0.3397, 1.0295, 1.0799],
  [0.4586, 0.3454, 1.03, 1.0815], [0.4667, 0.3513, 1.0306, 1.0831], [0.4752, 0.3574, 1.0312, 1.0847], [0.4839, 0.3638, 1.0318, 1.0865],
  [0.493, 0.3704, 1.0324, 1.0883], [0.5025, 0.3773, 1.0331, 1.0902], [0.5124, 0.3845, 1.0338, 1.0922], [0.5228, 0.392, 1.0345, 1.0943],
  [0.5336, 0.3999, 1.0353, 1.0965], [0.5449, 0.4081, 1.0361, 1.0988], [0.5568, 0.4167, 1.037, 1.1013], [0.5692, 0.4257, 1.0378, 1.1039],
];

/** Shipped Pos/Neg K values the shipped LOAD_TABLE was computed from (§3.1). */
export const SHIPPED_CURVE_K = Object.freeze({ latPosK: 5.00238, latNegK: 0.053606, longPosK: 5.39649, longNegK: 0.176533 });

/** One curve's peak location and reciprocal peak (§2.6.1 closed form). */
function curvePeak(Fz: number, posK: number, negK: number): [number, number] {
  const B = Math.max(1, (1.75 - 1e-4 * Fz) * posK + 5);
  if (negK <= 1e-9) {
    // no post-peak slope: the curve saturates at 1 (peak "at infinity"); use a large but finite location
    return [Math.PI / 2, 1];
  }
  const peak = Math.log(B / negK) / B;
  const D = 1 / (1 - negK / B - peak * negK);
  return [peak, D];
}

/**
 * LOAD_TABLE as a flat Float64Array (20 rows × 4). Uses the shipped table verbatim when the wheel's
 * Pos/Neg K equal the shipped values (or rebuild is off), else rebuilds it with the §2.6.1 closed form.
 * `scale` multiplies Palpha and Pkappa (§6 loadTableScale).
 */
export function buildLoadTable(wp: Readonly<WheelParams>, rebuild: boolean, scale: number, out?: Float64Array): Float64Array {
  const t = out ?? new Float64Array(80);
  const shipped =
    !rebuild ||
    (wp.latPosK === SHIPPED_CURVE_K.latPosK &&
      wp.latNegK === SHIPPED_CURVE_K.latNegK &&
      wp.longPosK === SHIPPED_CURVE_K.longPosK &&
      wp.longNegK === SHIPPED_CURVE_K.longNegK);
  for (let j = 0; j < 20; j++) {
    let pa: number, pk: number, dy: number, dx: number;
    if (shipped) {
      [pa, pk, dy, dx] = LOAD_TABLE_SHIPPED[j];
    } else {
      const Fz = 500 * j;
      [pa, dy] = curvePeak(Fz, wp.latPosK, wp.latNegK);
      [pk, dx] = curvePeak(Fz, wp.longPosK, wp.longNegK);
    }
    t[j * 4] = pa * scale;
    t[j * 4 + 1] = pk * scale;
    t[j * 4 + 2] = dy;
    t[j * 4 + 3] = dx;
  }
  return t;
}

/** Result slots of tyreForce (reused; read immediately). */
export interface TyreForceOut {
  Fx: number;
  Fy: number;
  Mz: number;
  aEq: number;
}

/**
 * §2.6.1 combined-slip tyre force [V FUN_006d0410], written allocation free.
 * `mult` = sideFrictionFactor on DEEP surfaces (if useSideFriction), else 1.
 */
export function tyreForce(
  out: TyreForceOut,
  table: Float64Array,
  wp: Readonly<WheelParams>,
  tanA: number,
  kappa: number,
  Fz: number,
  muFz: number,
  mult: number,
): TyreForceOut {
  const neg = kappa < 0;
  const k = Math.abs(kappa);
  const sx = -k / (1 + k);
  const sy = tanA / (1 + k);
  let pa: number, pk: number, Dy: number, Dx: number;
  if (Fz >= 9500) {
    pa = table[76];
    pk = table[77];
    Dy = table[78];
    Dx = table[79];
  } else {
    const f = Fz * 0.002;
    const j = Math.floor(f);
    const t = f - j;
    const a = j * 4;
    const b = a + 4;
    pa = table[a] + (table[b] - table[a]) * t;
    pk = table[a + 1] + (table[b + 1] - table[a + 1]) * t;
    Dy = table[a + 2] + (table[b + 2] - table[a + 2]) * t;
    Dx = table[a + 3] + (table[b + 3] - table[a + 3]) * t;
  }
  const cx = -pk / (pk + 1);
  const cy = pa / (pk + 1);
  const nx = sx / cx;
  const ny = sy / cy;
  let sMag = Math.hypot(sx, sy);
  let rho = Math.hypot(nx, ny);
  let kEq = (rho * pk) / (pk + 1);
  kEq = kEq / (kEq + 1);
  const aEq = Math.atan(sy > 0 ? cy * rho : -cy * rho);
  const B_lat = Math.max(1, (1.75 - Fz * 1e-4) * wp.latPosK + 5);
  const B_lon = Math.max(1, (1.75 - Fz * 1e-4) * wp.longPosK + 5);
  const absA = Math.abs(aEq);
  const lat = Fz > 0 ? (1 - Math.exp(-B_lat * absA) - absA * wp.latNegK) * Dy : 0;
  const lon = Fz > 0 ? Math.max(0, (1 - Math.exp(-B_lon * kEq) - kEq * wp.longNegK) * Dx) : 0;
  const Fy0 = mult * muFz * lat;
  const Fx0 = muFz * lon;
  const rc = Math.min(rho, 1);
  if (sMag === 0) sMag = 1e-4;
  if (rho === 0) rho = 1e-4;
  const nyr = ny / rho;
  const nxr = nx / rho;
  let Fx = (-sx / sMag) * (Fx0 - (Fx0 - Fy0) * nyr * nyr * rc);
  const Fy = (sy / sMag) * (Fy0 - (Fy0 - Fx0) * nxr * nxr * rc);
  if (neg) Fx = -Fx;
  let Mz = Fz < 0 ? 0 : -(aEq > 0 ? 1 : aEq < 0 ? -1 : 0) * aEq * aEq * Fz * 0.5 * wp.alignMomScale;
  if (Fy0 !== 0) Mz *= Math.abs(Fy) / Fy0;
  out.Fx = Fx;
  out.Fy = Fy;
  out.Mz = Mz;
  out.aEq = aEq;
  return out;
}
