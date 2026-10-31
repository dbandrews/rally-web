/**
 * src/sim/contact/solve.ts - OWNED BY THE SIM-CONTACT BUILDER.
 *
 * FUN_006d4390(flag, A, B, dt) with its overlap test FUN_006d4fd0 and the point-against-planes test FUN_006d5240 for two
 * rigid bodies (research/formats/dynamics.md sec. 6.2-6.3), a line-by-line port of research/tools/dyn_ref.py
 * (`contact` / `overlap` / `hull_in`), which tests/sim/contact.fixtures.test.ts replays against the ORIGINAL function
 * executed in unicorn (research/tools/contact_emu.py). Float64, SIM frame (the physics is translation invariant).
 *
 * Conventions (as the exe): rotation ROWS R[0..2] = the body axes in world (`right`, `up`, `fwd` of a car);
 * world = local . R + pos; L and w are in the BODY frame; `toBody(R, v)` = (R0.v, R1.v, R2.v).
 */
import type { ContactHull } from './hull';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** The 1.5 marker (0x3fc00000) FUN_006d4fd0 writes to the penetrating body's anchor normal x. */
export const CONTACT_MARK = 1.5;
/** "no depth found" sentinel (0x461c4000). */
const NO_DEPTH = 10000;
/** Impulse caps: 30000 N.s, 10000 with the `-multiplayer` command-line flag (*(*0x8e4e14), FUN_004e7f60). */
export const CONTACT_CAP = 30000;
export const CONTACT_CAP_MULTIPLAYER = 10000;
/** 0x825f38: restitution factor of the contact (j = -0.8 . v_rel . n / ...). */
const RESTITUTION = 0.8;
/** 0x8061d0: the body-y component of the torque arm is quartered. */
const TORQUE_Y = 0.25;
/** Impact record class / material written by a body-body contact (B+0x144 = 0x40, B+0x1c8 = 2). */
export const CONTACT_MAT = 0x40;

/**
 * A rigid body as the contact sees it (the fields of the exe's 0x210-byte body that FUN_006d4390 reads or writes, named
 * by their offsets in dyn_ref.BODY_FIELDS). Vectors are shared by reference with the owner (a CarSim updates them in
 * place), scalars are copied in/out by the owner (`CarSim.contactBody()` pulls, `commit()` pushes).
 */
export interface ContactBody {
  hull: ContactHull;
  /** Centre of mass (B+0xc8), SIM space. Only x and z are pushed by the overlap. */
  pos: V3;
  /** Linear velocity (B+0x20), world. */
  v: V3;
  /** Angular momentum (B+0x50) and the lagged angular velocity (B+0x44), BODY frame. */
  L: V3;
  w: V3;
  /** 1 / inertia (B+0x8c), body axes. */
  invI: V3;
  /** Rotation rows (B+0x98, 0xa8, 0xb8) = the body axes in world. */
  right: V3;
  up: V3;
  fwd: V3;
  mass: number;
  invMass: number;
  /** B+0x18. */
  radius: number;
  /** B+0x20c: a sleeping body (a car body never sleeps). */
  sleep: number;
  /** B+0x134: the anchor timer. The overlap sets it to 0.2: the next ground solve expires the anchor. */
  T: number;
  /** B+0x154 (anchor normal; x = CONTACT_MARK on the penetrating body) and B+0x16c (contact point). */
  prevN: V3;
  prevC: V3;
  /** B+4 (bit 0x400 = car-car), B+0x144 material, B+0x1c8 class. */
  flags: number;
  mat: number;
  cls: number;
  /** The impact record: B+0x19c strength / 0x1a0, 0x190 / 0x194 (maxima), points 0x1b0 / 0x1a4 / 0x1bc. */
  imp19c: number;
  imp1a0: number;
  imp190: number;
  imp194: number;
  pt1b0: V3;
  pt1a4: V3;
  pt1bc: V3;
  /** B+0x1d0: the other body of the latest contact. */
  other: ContactBody | null;
  /** Contacts disabled when false (car+0x161, FUN_004a7980's `collidable`). */
  collidable: boolean;
  /** The car-car record (car record +0x3c / +0x40): contact count and this body's B+0x19c after the latest. */
  carHits: number;
  carStrength: number;
  /** Set by contact() when it changed this body; stepCarContacts then calls commit() (owner write-back) and clears it. */
  dirty: boolean;
  commit: (() => void) | null;
}

export function v3(x = 0, y = 0, z = 0): V3 {
  return { x, y, z };
}

/** A plain body (tests, bodies not owned by a CarSim). Vectors and scalars are fresh. */
export function makeContactBody(hull: ContactHull, mass: number, inertia: V3): ContactBody {
  return {
    hull,
    pos: v3(),
    v: v3(),
    L: v3(),
    w: v3(),
    invI: v3(1 / inertia.x, 1 / inertia.y, 1 / inertia.z),
    right: v3(1, 0, 0),
    up: v3(0, 1, 0),
    fwd: v3(0, 0, 1),
    mass,
    invMass: 1 / mass,
    radius: hull.radius,
    sleep: 0,
    T: 0,
    prevN: v3(),
    prevC: v3(),
    flags: 0,
    mat: 0,
    cls: 0,
    imp19c: 0,
    imp1a0: 0,
    imp190: 0,
    imp194: 0,
    pt1b0: v3(),
    pt1a4: v3(),
    pt1bc: v3(),
    other: null,
    collidable: true,
    carHits: 0,
    carStrength: 0,
    dirty: false,
    commit: null,
  };
}

// ---------------------------------------------------------------------------------------------------- scratch (no allocation)
/** FUN_006d4fd0's scratch (written on `this`, the car body, in the exe): per slot depth, mean point, direction. */
let depth0 = 0;
let depth1 = 0;
let c0x = 0, c0y = 0, c0z = 0, c1x = 0, c1y = 0, c1z = 0;
let d0x = 0, d0y = 0, d0z = 0, d1x = 0, d1y = 0, d1z = 0;

/** Normal impulse |j| of the latest successful contact() (tests, CarContactResult.maxImpulse). */
export let lastImpulse = 0;
/** Which slot the latest overlap used (0: A penetrates B's planes; 1: B penetrates A's) (tests). */
export let lastSlot = 0;

/**
 * FUN_006d5240: the points of X (all of them) taken into Y's frame against Y's planes; up to 4 inside points are
 * averaged. Writes the slot's depth / mean point / direction; sets Y.prevN to the exit plane's world normal.
 */
function hullIn(X: ContactBody, Y: ContactBody, slot: 0 | 1): void {
  const xh = X.hull;
  const yh = Y.hull;
  const yr = Y.right, yu = Y.up, yf = Y.fwd;
  const xr = X.right, xu = X.up, xf = X.fwd;
  // t = toBody(Y.R, X.pos - Y.pos)
  const dx = X.pos.x - Y.pos.x;
  const dy = X.pos.y - Y.pos.y;
  const dz = X.pos.z - Y.pos.z;
  const tx = yr.x * dx + yr.y * dy + yr.z * dz;
  const ty = yu.x * dx + yu.y * dy + yu.z * dz;
  const tz = yf.x * dx + yf.y * dy + yf.z * dz;
  let ax = 0, ay = 0, az = 0;
  let cnt = 0;
  const nPl = yh.nPl;
  for (let i = 0; i < xh.nPts; i++) {
    const p0 = xh.px[i], p1 = xh.py[i], p2 = xh.pz[i];
    // toWorld(X.R, p) = p0 . R0 + p1 . R1 + p2 . R2
    const wx = p0 * xr.x + p1 * xu.x + p2 * xf.x;
    const wy = p0 * xr.y + p1 * xu.y + p2 * xf.y;
    const wz = p0 * xr.z + p1 * xu.z + p2 * xf.z;
    // q = toBody(Y.R, w) + t
    const qx = yr.x * wx + yr.y * wy + yr.z * wz + tx;
    const qy = yu.x * wx + yu.y * wy + yu.z * wz + ty;
    const qz = yf.x * wx + yf.y * wy + yf.z * wz + tz;
    let ok = true;
    for (let k = 0; k < nPl; k++) {
      if (yh.nx[k] * qx + yh.ny[k] * qy + yh.nz[k] * qz - yh.nd[k] > 0) {
        ok = false;
        break;
      }
    }
    if (ok) {
      ax += qx;
      ay += qy;
      az += qz;
      cnt++;
    }
    if (cnt > 3) break;
  }
  let depth = NO_DEPTH;
  let cx = ax, cy = ay, cz = az;
  let ex = 0, ey = 0, ez = 0;
  if (cnt > 0) {
    // 0x8..: [1, 0.5, 0.3333333, 0.25][cnt - 1] (float32 constants of the exe, 0.3333333 as written)
    const f = cnt === 1 ? 1 : cnt === 2 ? 0.5 : cnt === 3 ? 0.3333333 : 0.25;
    cx = ax * f;
    cy = ay * f;
    cz = az * f;
    // dr = normalize(c - t): X's centre toward the mean penetrating point, Y frame
    let rx = cx - tx, ry = cy - ty, rz = cz - tz;
    const il = 1 / Math.sqrt(rx * rx + ry * ry + rz * rz);
    rx *= il;
    ry *= il;
    rz *= il;
    ex = rx;
    ey = ry;
    ez = rz;
    let best = -1;
    for (let k = 0; k < nPl; k++) {
      const nx = yh.nx[k], ny = yh.ny[k], nz = yh.nz[k];
      const den = -(nx * rx + ny * ry + nz * rz);
      if (den > 0) {
        const dist = nx * cx + ny * cy + nz * cz - yh.nd[k];
        if (dist < 0) {
          const tt = -(dist / den);
          if (tt < depth) {
            depth = tt;
            best = k;
          }
        }
      }
    }
    if (depth !== NO_DEPTH) {
      // Y.prevN = toWorld(Y.R, n_best)
      const nx = yh.nx[best], ny = yh.ny[best], nz = yh.nz[best];
      Y.prevN.x = nx * yr.x + ny * yu.x + nz * yf.x;
      Y.prevN.y = nx * yr.y + ny * yu.y + nz * yf.y;
      Y.prevN.z = nx * yr.z + ny * yu.z + nz * yf.z;
    }
  }
  if (slot === 0) {
    depth0 = depth;
    c0x = cx; c0y = cy; c0z = cz;
    d0x = ex; d0y = ey; d0z = ez;
  } else {
    depth1 = depth;
    c1x = cx; c1y = cy; c1z = cz;
    d1x = ex; d1y = ey; d1z = ez;
  }
}

/**
 * FUN_006d4fd0: hull-vs-hull. P = the plane owner (the body whose planes the other's points crossed with the smaller exit
 * depth), Q = the penetrating body. Writes P.prevC, pushes both bodies apart in x / z by the mass ratio,
 * marks Q.prevN.x with 1.5, sets both anchor timers to 0.2. False when neither slot found a depth.
 */
function overlap(A: ContactBody, B: ContactBody): boolean {
  hullIn(A, B, 0);
  hullIn(B, A, 1);
  let P: ContactBody, Q: ContactBody;
  let dep: number, cx: number, cy: number, cz: number, ex: number, ey: number, ez: number;
  if (depth0 < depth1) {
    if (depth0 === NO_DEPTH) return false;
    lastSlot = 0;
    P = B;
    Q = A;
    dep = depth0; cx = c0x; cy = c0y; cz = c0z; ex = d0x; ey = d0y; ez = d0z;
  } else {
    if (depth1 === NO_DEPTH) return false;
    lastSlot = 1;
    P = A;
    Q = B;
    dep = depth1; cx = c1x; cy = c1y; cz = c1z; ex = d1x; ey = d1y; ez = d1z;
  }
  // off = dir * -depth; contact point (P frame) = off + c
  const offx = ex * -dep, offy = ey * -dep, offz = ez * -dep;
  const cpx = offx + cx, cpy = offy + cy, cpz = offz + cz;
  const pr = P.right, pu = P.up, pf = P.fwd;
  // P.prevC = toWorld(P.R, cpt)
  P.prevC.x = cpx * pr.x + cpy * pu.x + cpz * pf.x;
  P.prevC.y = cpx * pr.y + cpy * pu.y + cpz * pf.y;
  P.prevC.z = cpx * pr.z + cpy * pu.z + cpz * pf.z;
  // push = toWorld(P.R, off)
  const pushx = offx * pr.x + offy * pu.x + offz * pf.x;
  const pushz = offx * pr.z + offy * pu.z + offz * pf.z;
  const ms = P.mass + Q.mass;
  const inv = ms > 0 ? 1 / ms : ms;
  const fq = inv * Q.mass;
  P.pos.x = P.pos.x - pushx * fq;
  P.pos.z = P.pos.z - pushz * fq;
  const fp = inv * P.mass;
  Q.pos.x = pushx * fp + Q.pos.x;
  Q.pos.z = pushz * fp + Q.pos.z;
  Q.prevN.x = CONTACT_MARK;
  Q.prevC.x = P.prevC.x + P.pos.x - Q.pos.x;
  Q.prevC.y = P.prevC.y + P.pos.y - Q.pos.y;
  Q.prevC.z = P.prevC.z + P.pos.z - Q.pos.z;
  P.T = 0.2;
  Q.T = 0.2;
  return true;
}

/**
 * FUN_006d4390(flag, A, B): the body-body contact. Returns true when the hulls overlap and the impulse was applied to
 * both bodies (v, L, pos x/z, anchor memory, impact records). `multiplayer` selects the 10000 N.s cap (else 30000).
 * Does not touch the angular velocities w (both bodies refresh w = I^-1 L at their next step).
 */
export function contactBodies(flag: number, A: ContactBody, B: ContactBody, multiplayer: boolean): boolean {
  A.flags &= ~0x400;
  B.flags &= ~0x400;
  if (A.sleep && B.sleep) return false;
  const dpx = A.pos.x - B.pos.x;
  const dpy = A.pos.y - B.pos.y;
  const dpz = A.pos.z - B.pos.z;
  const rr = A.radius + B.radius;
  if (dpx * dpx + dpy * dpy + dpz * dpz - rr * rr > 0) return false;
  if (!overlap(A, B)) return false;
  A.sleep = 0;
  B.sleep = 0;
  A.dirty = true;
  B.dirty = true;
  const aIsQ = A.prevN.x === CONTACT_MARK;
  // n = the plane owner's world normal
  const nx = aIsQ ? B.prevN.x : A.prevN.x;
  const ny = aIsQ ? B.prevN.y : A.prevN.y;
  const nz = aIsQ ? B.prevN.z : A.prevN.z;
  const rAx = A.prevC.x, rAy = A.prevC.y, rAz = A.prevC.z;
  const rBx = B.prevC.x, rBy = B.prevC.y, rBz = B.prevC.z;
  const ar = A.right, au = A.up, af = A.fwd;
  const br = B.right, bu = B.up, bf = B.fwd;
  // rAb = toBody(A.R, rA)
  const rAbx = ar.x * rAx + ar.y * rAy + ar.z * rAz;
  const rAby = au.x * rAx + au.y * rAy + au.z * rAz;
  const rAbz = af.x * rAx + af.y * rAy + af.z * rAz;
  const rBbx = br.x * rBx + br.y * rBy + br.z * rBz;
  const rBby = bu.x * rBx + bu.y * rBy + bu.z * rBz;
  const rBbz = bf.x * rBx + bf.y * rBy + bf.z * rBz;
  // vA = v + toWorld(R, w x rAb)
  const aw = A.w, bw = B.w;
  const cAx = aw.y * rAbz - aw.z * rAby;
  const cAy = aw.z * rAbx - aw.x * rAbz;
  const cAz = aw.x * rAby - aw.y * rAbx;
  const cBx = bw.y * rBbz - bw.z * rBby;
  const cBy = bw.z * rBbx - bw.x * rBbz;
  const cBz = bw.x * rBby - bw.y * rBbx;
  const vAx = cAx * ar.x + cAy * au.x + cAz * af.x + A.v.x;
  const vAy = cAx * ar.y + cAy * au.y + cAz * af.y + A.v.y;
  const vAz = cAx * ar.z + cAy * au.z + cAz * af.z + A.v.z;
  const vBx = cBx * br.x + cBy * bu.x + cBz * bf.x + B.v.x;
  const vBy = cBx * br.y + cBy * bu.y + cBz * bf.y + B.v.y;
  const vBz = cBx * br.z + cBy * bu.z + cBz * bf.z + B.v.z;
  let j = ((vAx - vBx) * nx + (vAy - vBy) * ny + (vAz - vBz) * nz) * -RESTITUTION;
  if (!aIsQ) j = -j;
  // XA = (rA x n) . (sum_k A.R[k] . invI[k])   (as coded)
  const sAx = ar.x * A.invI.x + au.x * A.invI.y + af.x * A.invI.z;
  const sAy = ar.y * A.invI.x + au.y * A.invI.y + af.y * A.invI.z;
  const sAz = ar.z * A.invI.x + au.z * A.invI.y + af.z * A.invI.z;
  const sBx = br.x * B.invI.x + bu.x * B.invI.y + bf.x * B.invI.z;
  const sBy = br.y * B.invI.x + bu.y * B.invI.y + bf.y * B.invI.z;
  const sBz = br.z * B.invI.x + bu.z * B.invI.y + bf.z * B.invI.z;
  const XAx = (rAy * nz - rAz * ny) * sAx;
  const XAy = (rAz * nx - rAx * nz) * sAy;
  const XAz = (rAx * ny - rAy * nx) * sAz;
  const XBx = (rBy * nz - rBz * ny) * sBx;
  const XBy = (rBz * nx - rBx * nz) * sBy;
  const XBz = (rBx * ny - rBy * nx) * sBz;
  // cross(XA, rA) + cross(XB, rB), dotted with n
  const kx = XAy * rAz - XAz * rAy + (XBy * rBz - XBz * rBy);
  const ky = XAz * rAx - XAx * rAz + (XBz * rBx - XBx * rBz);
  const kz = XAx * rAy - XAy * rAx + (XBx * rBy - XBy * rBx);
  const den = Math.abs(kx * nx + ky * ny + kz * nz) + A.invMass + B.invMass;
  j = j / den;
  if (j < 0) j = 0;
  const cap = multiplayer ? CONTACT_CAP_MULTIPLAYER : CONTACT_CAP;
  if (j > cap) j = cap;
  if (A.imp19c < j) {
    A.imp19c = j;
    A.imp1a0 = 0;
    if (flag === 1) A.flags |= 0x400;
    A.mat = CONTACT_MAT;
    A.cls = 2;
    A.pt1b0.x = A.pos.x + rAx;
    A.pt1b0.y = A.pos.y + rAy;
    A.pt1b0.z = A.pos.z + rAz;
    A.pt1a4.x = rAbx; A.pt1a4.y = rAby; A.pt1a4.z = rAbz;
    A.other = B;
  }
  if (A.imp190 < j) {
    A.imp190 = j;
    A.imp194 = 0;
    A.pt1bc.x = rAbx; A.pt1bc.y = rAby; A.pt1bc.z = rAbz;
  }
  if (B.prevN.x === CONTACT_MARK) j = -j;
  // A: J = n.j; torque arm toBody(A.R, J) with the body-y component quartered
  let Jx = nx * j, Jy = ny * j, Jz = nz * j;
  let jbx = ar.x * Jx + ar.y * Jy + ar.z * Jz;
  let jby = (au.x * Jx + au.y * Jy + au.z * Jz) * TORQUE_Y;
  let jbz = af.x * Jx + af.y * Jy + af.z * Jz;
  A.L.x += rAby * jbz - rAbz * jby;
  A.L.y += rAbz * jbx - rAbx * jbz;
  A.L.z += rAbx * jby - rAby * jbx;
  A.v.x += Jx * A.invMass;
  A.v.y += Jy * A.invMass;
  A.v.z += Jz * A.invMass;
  const aj = Math.abs(j);
  if (B.imp19c < aj) {
    B.imp19c = aj;
    B.imp1a0 = 0;
    B.mat = CONTACT_MAT;
    B.cls = 2;
    B.flags |= 0x400;
    B.pt1b0.x = B.pos.x + rBx;
    B.pt1b0.y = B.pos.y + rBy;
    B.pt1b0.z = B.pos.z + rBz;
    B.pt1a4.x = rBbx; B.pt1a4.y = rBby; B.pt1a4.z = rBbz;
    B.other = A;
  }
  if (aj > B.imp190) {
    B.imp190 = aj;
    B.imp194 = 0;
    B.pt1bc.x = rBbx; B.pt1bc.y = rBby; B.pt1bc.z = rBbz;
  }
  Jx = nx * -j;
  Jy = ny * -j;
  Jz = nz * -j;
  jbx = br.x * Jx + br.y * Jy + br.z * Jz;
  jby = (bu.x * Jx + bu.y * Jy + bu.z * Jz) * TORQUE_Y;
  jbz = bf.x * Jx + bf.y * Jy + bf.z * Jz;
  B.L.x += rBby * jbz - rBbz * jby;
  B.L.y += rBbz * jbx - rBbx * jbz;
  B.L.z += rBbx * jby - rBby * jbx;
  B.v.x += Jx * B.invMass;
  B.v.y += Jy * B.invMass;
  B.v.z += Jz * B.invMass;
  lastImpulse = aj;
  return true;
}
