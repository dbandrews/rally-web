/**
 * tests/render/fixtures/fakeCar.ts — kinematic stand-in for the sim, for render tests and the render
 * preview page. Drives along a Stage spline with a chosen speed, drift angle (β), wheelspin and brake,
 * and emits a complete CarTelemetry + CarRenderState in the contract's spaces.
 */
import { DT } from '../../../src/core/constants';
import { mirror, mirrorQuat } from '../../../src/core/space';
import type { ArchetypeId, CarRenderState, CarTelemetry, Quad, Stage, SurfaceId, WheelTelemetry } from '../../../src/core/types';

const CG: Record<ArchetypeId, number> = { awd_wrc: 0.42, fwd_hatch: 0.38, rwd_classic: 0.47 };
const WHEELS: Record<ArchetypeId, { fx: number; rx: number; fz: number; rz: number }> = {
  awd_wrc: { fx: 0.755, rx: 0.76, fz: 1.21, rz: -1.32 },
  fwd_hatch: { fx: 0.765, rx: 0.765, fz: 1.235, rz: -1.31 },
  rwd_classic: { fx: 0.655, rx: 0.73, fz: 1.26, rz: -1.19 },
};
const R = 0.3;

/** Minimal quaternion from Euler YXZ (three convention) as plain {w,x,y,z}. */
function quatYXZ(yaw: number, pitch: number, roll: number) {
  const c1 = Math.cos(yaw / 2), s1 = Math.sin(yaw / 2);
  const c2 = Math.cos(pitch / 2), s2 = Math.sin(pitch / 2);
  const c3 = Math.cos(roll / 2), s3 = Math.sin(roll / 2);
  // three.js Euler 'YXZ' → quaternion
  return {
    x: s2 * c1 * c3 + c2 * s1 * s3,
    y: c2 * s1 * c3 - s2 * c1 * s3,
    z: c2 * c1 * s3 - s2 * s1 * c3,
    w: c2 * c1 * c3 + s2 * s1 * s3,
  };
}
function rotate(q: { w: number; x: number; y: number; z: number }, v: { x: number; y: number; z: number }) {
  // v' = q v q*
  const { w, x, y, z } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}

export class FakeCar {
  readonly archetype: ArchetypeId;
  stage: Stage;
  s: number;
  lateral = 0;
  speed = 0;
  /** Body slip angle β (rad), + = nose right of the travel direction. */
  drift = 0;
  /** Extra wheel surface speed (m/s) from wheelspin (+) or locking (−) on driven wheels. */
  wheelspin = 0;
  brake = 0;
  steer = 0;
  gear = 2;
  /** Extra roll (rad) for flip tests. */
  extraRoll = 0;
  surfaceOverride: SurfaceId | null = null;
  private steps = 0;
  private resets = 0;
  private spin = [0, 0, 0, 0];
  private justReset = true;
  private readonly tel: CarTelemetry;

  constructor(stage: Stage, archetype: ArchetypeId = 'awd_wrc', s = stage.startS) {
    this.stage = stage;
    this.archetype = archetype;
    this.s = s;
    this.tel = this.blank();
    this.compute(0);
  }

  teleport(s: number, lateral = 0): void {
    this.s = s;
    this.lateral = lateral;
    this.resets++;
    this.justReset = true;
    this.compute(0);
  }

  advance(dt: number): void {
    const n = Math.max(0, Math.round(dt / DT));
    this.steps += n;
    const d = n * DT;
    this.s = Math.min(this.stage.length - 1, this.s + this.speed * Math.cos(this.drift) * d);
    this.compute(d);
  }

  renderState(): CarRenderState {
    const t = this.tel;
    const st: CarRenderState = {
      id: 'player',
      archetype: this.archetype,
      ghost: false,
      player: true,
      pos: { ...t.pos },
      quat: { ...t.quat },
      telemetry: t,
      justReset: this.justReset,
    };
    this.justReset = false;
    return st;
  }

  telemetry(): CarTelemetry {
    return this.tel;
  }

  private compute(dt: number): void {
    const st = this.stage;
    const r = st.roadAt(this.s);
    const dir = st.tangentAt(this.s);
    const rx = -dir.z, rz = dir.x;
    const rl = Math.hypot(rx, rz) || 1;
    const right = { x: rx / rl, y: 0, z: rz / rl };
    const px = r.pos.x + right.x * this.lateral, pz = r.pos.z + right.z * this.lateral;
    const f = Math.max(0, Math.min(1, (this.lateral + r.width / 2) / r.width));
    const groundY = r.left.y + (r.right.y - r.left.y) * f;
    const yaw = Math.atan2(-dir.x, -dir.z) - this.drift;
    const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const q = quatYXZ(yaw, pitch, -r.bank + this.extraRoll);
    const up = rotate(q, { x: 0, y: 1, z: 0 });
    const cg = CG[this.archetype];
    const pos = { x: px + up.x * cg, y: groundY + up.y * cg, z: pz + up.z * cg };
    const t = this.tel;
    t.stepCount = this.steps;
    t.simTime = this.steps * DT;
    t.resetCount = this.resets;
    const v = this.speed;
    t.speedKmh = Math.abs(v * Math.cos(this.drift)) * 3.6;
    t.speedWorldKmh = Math.abs(v) * 3.6;
    t.gear = this.gear;
    t.brake = this.brake;
    t.steer = this.steer;
    t.steerAngle = this.steer * 0.4;
    t.beta = this.drift;
    t.velLocal = { x: -Math.sin(this.drift) * v, y: 0, z: Math.cos(this.drift) * v };
    t.vel = { x: dir.x * v, y: dir.y * v, z: dir.z * v };
    t.velSim = mirror(t.vel);
    t.angVelLocal = { x: 0, y: 0, z: 0 };
    t.pos = pos;
    t.quat = { w: q.w, x: q.x, y: q.y, z: q.z };
    t.posSim = mirror(pos);
    t.quatSim = mirrorQuat(t.quat);
    t.rpm = 3000 + v * 80;
    t.nContacts = up.y > 0.3 ? 4 : 0;
    t.airborne = t.nContacts === 0;
    const surf: SurfaceId = this.surfaceOverride ?? (Math.abs(this.lateral) < r.width / 2 ? r.surface : 'grass');
    const g = WHEELS[this.archetype];
    for (let i = 0; i < 4; i++) {
      const front = i < 2, left = i === 0 || i === 3;
      const cl = { x: (front ? g.fx : g.rx) * (left ? -1 : 1), y: -cg + R + 0.02, z: -(front ? g.fz : g.rz) };
      const w = t.wheels[i];
      const driven = this.archetype === 'awd_wrc' || (this.archetype === 'fwd_hatch' ? front : !front);
      const vLong = v * Math.cos(this.drift);
      w.omega = (vLong + (driven ? this.wheelspin : 0)) / R;
      this.spin[i] += w.omega * dt;
      w.visual.spinAngle = this.spin[i];
      w.visual.steerAngle = front ? this.steer * 0.4 : 0;
      w.visual.centreLocal = cl;
      w.visual.suspensionOffset = 0.3;
      w.contact = t.nContacts > 0;
      w.surface = w.contact ? surf : null;
      w.material = w.contact ? 0 : -1;
      const c = rotate(q, { x: cl.x, y: cl.y - R, z: cl.z });
      w.contactPointThree = { x: pos.x + c.x, y: pos.y + c.y, z: pos.z + c.z };
      w.contactPoint = mirror(w.contactPointThree);
      w.slipAngle = this.drift;
      w.mode = Math.abs(this.drift) > 0.1 ? 2 : 1;
    }
  }

  private blank(): CarTelemetry {
    const wheel = (): WheelTelemetry => ({
      slipAngle: 0, kappa: 0, load: 3000, mode: 1, surface: 'gravel', material: 1, contact: true, omega: 0, Fsusp: 3000,
      Fx: 0, Fy: 0, mu: 1, driveT: 0, brakeT: 0, contactPoint: { x: 0, y: 0, z: 0 }, contactPointThree: { x: 0, y: 0, z: 0 },
      visual: { steerAngle: 0, spinAngle: 0, suspensionOffset: 0.3, centreLocal: { x: 0, y: -0.12, z: 0 } },
    });
    return {
      id: 'player', archetype: this.archetype, stepCount: 0, simTime: 0, resetCount: 0, speedKmh: 0, speedWorldKmh: 0, rpm: 1000,
      rpmRedline: 8250, rpmMax: 8750, gear: 1, nGears: 6, shifting: false, boost: 0, boostFrac: 0, transmission: 'auto', tyreType: 2,
      throttle: 0, brake: 0, handbrake: 0, steer: 0, steerAngle: 0, beta: 0, yawRate: 0, aLat: 0, aLong: 0, aVert: 0, nContacts: 4,
      airborne: false, airMul: 1, bodyOnGround: false, yawCapActive: false, yawRateCapActive: false, parked: false, impactImpulse: 0, simFaults: 0,
      posSim: { x: 0, y: 0, z: 0 }, quatSim: { w: 1, x: 0, y: 0, z: 0 }, velSim: { x: 0, y: 0, z: 0 }, velLocal: { x: 0, y: 0, z: 0 },
      angVelLocal: { x: 0, y: 0, z: 0 }, pos: { x: 0, y: 0, z: 0 }, quat: { w: 1, x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
      wheels: [wheel(), wheel(), wheel(), wheel()] as Quad<WheelTelemetry>,
    };
  }
}
