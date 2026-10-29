/**
 * src/core/math.ts — ARCHITECT-OWNED CONTRACT. Builders: import, do not edit.
 *
 * Small vector / quaternion helpers used by the spec (docs/MECHANICS_SPEC.md §1.1, §2 "Helpers").
 *
 * Space-agnostic: these functions are pure formulas. The SAME formulas are used in sim space
 * (left-handed, x right, y up, z forward; §1.1) and in Three.js space (right-handed, y up). The cross
 * product formula is the one quoted in §1.1:
 *     cross(a,b) = (a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x)
 * In sim space this gives cross(up, fwd) = right and cross(fwd, right) = up.
 *
 * Quaternions are {w, x, y, z} with the standard (Hamilton) product and the standard rotation matrix
 * (§2.5.0). In sim space a positive rotation about +y turns +z (forward) toward +x (right): positive yaw
 * rate = nose right, as in the original.
 *
 * Conventions:
 *  - Functions without a suffix allocate and return a new object (convenient, fine at 120 Hz).
 *  - Functions ending in `To` write into `out` and return it (for hot loops).
 *  - Nothing here mutates its inputs unless it is a `To` function writing to `out`.
 */

export type V3 = { x: number; y: number; z: number };
export type Quat = { w: number; x: number; y: number; z: number };

// ------------------------------------------------------------------------------------------- scalars

/** clamp(x, a, b) = min(b, max(a, x)) (§2 helpers). */
export const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
/** sgn(x): 1, -1 or 0 (§2 helpers). */
export const sgn = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
/** towardZero(v, d) = v > 0 ? max(0, v - d) : min(0, v + d) (§2.10). */
export const towardZero = (v: number, d: number): number => (v > 0 ? Math.max(0, v - d) : Math.min(0, v + d));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const DEG = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const KMH = 3.6; // m/s -> km/h factor
/** Wrap an angle to (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
};
/** Frame-rate independent per-frame lerp factor (§5.3): kdt = 1 - (1 - k)^(60·frameDt). */
export const perFrameK = (k: number, frameDt: number): number => 1 - Math.pow(1 - k, 60 * frameDt);

// ------------------------------------------------------------------------------------------- vectors

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const ZERO3: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 0 });
export const UP3: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 });
export const copy3 = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
export const set3 = (out: V3, x: number, y: number, z: number): V3 => {
  out.x = x; out.y = y; out.z = z;
  return out;
};
export const copy3To = (out: V3, a: V3): V3 => set3(out, a.x, a.y, a.z);
export const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
/** a + b*k */
export const madd = (a: V3, b: V3, k: number): V3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
export const neg = (a: V3): V3 => ({ x: -a.x, y: -a.y, z: -a.z });
/** Component-wise product (e.g. invI ⊙ L, §2.10). */
export const mul3 = (a: V3, b: V3): V3 => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z });
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
/** Cross product, formula of §1.1 (identical in both spaces; see file header). */
export const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const lenSq = (a: V3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const len = (a: V3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Unit vector; returns a copy of `a` unchanged if its length is 0 (as the reference implementation). */
export const normalize = (a: V3): V3 => {
  const l = len(a);
  return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: a.x, y: a.y, z: a.z };
};
export const lerp3 = (a: V3, b: V3, t: number): V3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
export const addTo = (out: V3, a: V3, b: V3): V3 => set3(out, a.x + b.x, a.y + b.y, a.z + b.z);
export const subTo = (out: V3, a: V3, b: V3): V3 => set3(out, a.x - b.x, a.y - b.y, a.z - b.z);
export const scaleTo = (out: V3, a: V3, k: number): V3 => set3(out, a.x * k, a.y * k, a.z * k);
export const maddTo = (out: V3, a: V3, b: V3, k: number): V3 => set3(out, a.x + b.x * k, a.y + b.y * k, a.z + b.z * k);
export const crossTo = (out: V3, a: V3, b: V3): V3 =>
  set3(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

// ------------------------------------------------------------------------------------------- quaternions

export const quat = (w = 1, x = 0, y = 0, z = 0): Quat => ({ w, x, y, z });
export const qIdentity = (): Quat => ({ w: 1, x: 0, y: 0, z: 0 });
export const qCopy = (q: Quat): Quat => ({ w: q.w, x: q.x, y: q.y, z: q.z });
export const qCopyTo = (out: Quat, q: Quat): Quat => {
  out.w = q.w; out.x = q.x; out.y = q.y; out.z = q.z;
  return out;
};
export const qConj = (q: Quat): Quat => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });
export const qDot = (a: Quat, b: Quat): number => a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;

/** Hamilton product a ⊗ b. */
export const qMul = (a: Quat, b: Quat): Quat => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});

export const qNormalize = (q: Quat): Quat => {
  const l = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
  return l > 0 ? { w: q.w / l, x: q.x / l, y: q.y / l, z: q.z / l } : qIdentity();
};

/**
 * Quaternion integration of §2.5.0: q ← normalize(q + ½·dt·q⊗(0, ω_body)).
 * `wBody` is the angular velocity in the BODY frame (B.w in §1.4).
 */
export const qIntegrate = (q: Quat, wBody: V3, dt: number): Quat => {
  const h = 0.5 * dt;
  const d = qMul(q, { w: 0, x: wBody.x, y: wBody.y, z: wBody.z });
  return qNormalize({ w: q.w + d.w * h, x: q.x + d.x * h, y: q.y + d.y * h, z: q.z + d.z * h });
};

/** Rotation about a unit axis by `angle` rad (standard formula). */
export const qFromAxisAngle = (axis: V3, angle: number): Quat => {
  const s = Math.sin(angle / 2);
  return { w: Math.cos(angle / 2), x: axis.x * s, y: axis.y * s, z: axis.z * s };
};

/**
 * World-space body axes from q (§2.5.0, verbatim formulas):
 *   right = (1-2(y²+z²), 2(xy+wz), 2(xz-wy))
 *   up    = (2(xy-wz), 1-2(x²+z²), 2(yz+wx))
 *   fwd   = (2(xz+wy), 2(yz-wx), 1-2(x²+y²))
 * They are the columns of the body→world rotation matrix R (R·v = right·v.x + up·v.y + fwd·v.z).
 */
export const qAxes = (q: Quat): { right: V3; up: V3; fwd: V3 } => {
  const { w, x, y, z } = q;
  return {
    right: { x: 1 - 2 * (y * y + z * z), y: 2 * (x * y + w * z), z: 2 * (x * z - w * y) },
    up: { x: 2 * (x * y - w * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + w * x) },
    fwd: { x: 2 * (x * z + w * y), y: 2 * (y * z - w * x), z: 1 - 2 * (x * x + y * y) },
  };
};

/** Same as qAxes, writing into existing vectors (hot path). */
export const qAxesTo = (q: Quat, right: V3, up: V3, fwd: V3): void => {
  const { w, x, y, z } = q;
  set3(right, 1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y));
  set3(up, 2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x));
  set3(fwd, 2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y));
};

/** Rotate a body-frame vector to world: R·v ("toWorld" in §2). */
export const qRotate = (q: Quat, v: V3): V3 => {
  const { right, up, fwd } = qAxes(q);
  return {
    x: right.x * v.x + up.x * v.y + fwd.x * v.z,
    y: right.y * v.x + up.y * v.y + fwd.y * v.z,
    z: right.z * v.x + up.z * v.y + fwd.z * v.z,
  };
};

/** Rotate a world vector into the body frame: Rᵀ·v ("toLocal" in §2: (right·v, up·v, fwd·v)). */
export const qRotateInv = (q: Quat, v: V3): V3 => {
  const { right, up, fwd } = qAxes(q);
  return { x: dot(right, v), y: dot(up, v), z: dot(fwd, v) };
};

/**
 * Quaternion from an orthonormal basis given as the world images of the body axes
 * (columns of R: right = R·x̂, up = R·ŷ, fwd = R·ẑ). Inverse of qAxes. Shepperd's method.
 */
export const qFromBasis = (right: V3, up: V3, fwd: V3): Quat => {
  const m00 = right.x, m10 = right.y, m20 = right.z;
  const m01 = up.x, m11 = up.y, m21 = up.z;
  const m02 = fwd.x, m12 = fwd.y, m22 = fwd.z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = { w: 0.25 * s, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
  }
  return qNormalize(q);
};

/**
 * SIM SPACE ONLY: orientation whose forward axis is `fwd` (need not be unit) with zero roll
 * (right axis horizontal). Used for spawn / reset poses (§5.4: heading toward the next spline point,
 * roll 0). Falls back to identity heading if `fwd` is vertical.
 * Uses the sim-space identities right = cross(up, fwd), up = cross(fwd, right).
 */
export const qLookSim = (fwd: V3): Quat => {
  const f = normalize(fwd);
  let r = cross(UP3, f);
  if (lenSq(r) < 1e-10) r = { x: 1, y: 0, z: 0 };
  r = normalize(r);
  const u = cross(f, r);
  return qFromBasis(r, u, f);
};

/** SIM SPACE ONLY: pure yaw rotation; heading 0 faces +z, positive heading turns toward +x (right). */
export const qYawSim = (heading: number): Quat => ({ w: Math.cos(heading / 2), x: 0, y: Math.sin(heading / 2), z: 0 });

/** Spherical interpolation (shortest arc). */
export const qSlerp = (a: Quat, b: Quat, t: number): Quat => {
  let cos = qDot(a, b);
  let bw = b.w, bx = b.x, by = b.y, bz = b.z;
  if (cos < 0) { cos = -cos; bw = -bw; bx = -bx; by = -by; bz = -bz; }
  if (cos > 0.9995) {
    return qNormalize({ w: a.w + (bw - a.w) * t, x: a.x + (bx - a.x) * t, y: a.y + (by - a.y) * t, z: a.z + (bz - a.z) * t });
  }
  const th = Math.acos(cos), s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return { w: a.w * ka + bw * kb, x: a.x * ka + bx * kb, y: a.y * ka + by * kb, z: a.z * ka + bz * kb };
};

/** Heading (yaw) of a forward vector in SIM space: atan2(fwd.x, fwd.z); 0 = +z, + = toward +x (right). */
export const headingSim = (fwd: V3): number => Math.atan2(fwd.x, fwd.z);
