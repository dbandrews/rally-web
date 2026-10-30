/**
 * src/render/cameraRig.ts — the §5.3 camera system (render builder).
 *
 * Offsets in CameraTuning are in the ORIGINAL car frame (sim body: x right, y up, z forward) and are
 * mirrored to the THREE car-local frame (x, y, -z) before use (src/core/space.ts convention). All "per
 * frame" constants are converted with perFrameK(k, frameDt) (60 Hz reference).
 *
 *   chaseNear/chase/chaseFar/chaseHigh  string camera: leash at |lerp(posA, posB, blend)|, slow horizontal
 *                                       follow (0.04/frame), fast vertical (0.42/frame), level horizon,
 *                                       look-at car + (0, 1.5, 0), speed blend posA→posB at ≤ 0.025/frame
 *   bumper                              rigid at bumperPos + G-sway, pitched down 0.1 rad + surface shake
 *   bonnet                              rigid at bonnetPos
 *   tetherHigh/tetherLow                distance kept in [min·s, …], pulled toward target·s at p1·dt beyond
 *                                       max·s², height only rises; looks at the car
 *   look-back (held)                    rigid at lookBackPos facing backwards
 *   flipped car (up.y < 0)              free follow 4-8 m, rises to car.y + 0.25·dist, ≥ 2 m above ground,
 *                                       FOV = 85.943665·atan(3.5/dist); clears after ≥ 3 wheels touch 0.5 s
 */
import * as THREE from 'three';
import { CAMERA_MODES, DEFAULT_CAMERA, SURFACE_INFO } from '../core/constants';
import { clamp, perFrameK } from '../core/math';
import { mirror } from '../core/space';
import type { CameraMode, CameraTuning, CarTelemetry, ChaseCamEntry, V3 } from '../core/types';

/** §5.3 / §6 Camera defaults. The positions are ImprezaWRX's CarCamera table (the archetype cars use them); an
 *  original player car brings its own (cars.json `camera`, orig/car.ts carCameraTuning, renderer applyCarCamera). */
export function makeCameraTuning(): CameraTuning {
  return {
    fov: 70,
    chase: {
      chaseNear: { posA: { x: 0, y: 1.15, z: -3.1 }, posB: { x: 0, y: 1.35, z: -3.2 }, p0: 10, p1: 0.5 },
      chase: { posA: { x: 0, y: 1.15, z: -3.5 }, posB: { x: 0, y: 1.35, z: -4.0 }, p0: 10, p1: 0.5 },
      chaseFar: { posA: { x: 0, y: 1.15, z: -4.25 }, posB: { x: 0, y: 1.45, z: -4.75 }, p0: 10, p1: 0.5 },
      chaseHigh: { posA: { x: 0, y: 1.45, z: -5.0 }, posB: { x: 0, y: 2.5, z: -7.0 }, p0: 11, p1: 0.75 },
    },
    chaseHorizLerp: 0.04,
    chaseVertLerp: 0.42,
    chaseBlendRate: 0.025,
    chaseLookAtHeight: 1.5,
    bumperPos: { x: 0, y: 0.45, z: 1.4 },
    bonnetPos: { x: 0, y: 0.65, z: 0.9 },
    lookBackPos: { x: 0, y: 0.4, z: -1.5 },
    bumperPitch: 0.1,
    bumperShakeGain: 2.4615e-5,
    tether: {
      tetherHigh: { p0: 0.125, p1: 32, d: { x: 4, y: 4.3, z: 4.2 } },
      tetherLow: { p0: 0.125, p1: 8, d: { x: 5, y: 8.3, z: 8.2 } },
    },
  };
}

/** Chase blend target f(v) of §5.3 (v = forward speed m/s). */
export function chaseBlendTarget(v: number): number {
  const f = v <= 0 ? v / 55 + 0.2 : v < 2 ? 0.2 : v < 19.5 ? 0.2 + (v - 2) * 0.0342936 : 0.8 + (v - 19.5) * 0.01;
  return clamp(f, 0, 1);
}

/** Nose-down extra height of §5.3 (fwd = car forward, world space). */
export function chaseExtraHeight(fwd: V3, p0: number, p1: number): number {
  if (fwd.y >= 0) return 0;
  const a = -Math.asin(Math.min(1, Math.hypot(fwd.x, fwd.z)));
  return Math.min(p0 * 1.125 * a * a, p1);
}

export interface RigTarget {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  tel: Readonly<CarTelemetry>;
  justReset: boolean;
}

const isChase = (m: CameraMode): m is keyof CameraTuning['chase'] =>
  m === 'chaseNear' || m === 'chase' || m === 'chaseFar' || m === 'chaseHigh';
const isTether = (m: CameraMode): m is keyof CameraTuning['tether'] => m === 'tetherHigh' || m === 'tetherLow';

/** Original car frame (sim body) offset → THREE car-local, via the space.ts mirror M = diag(1, 1, -1). */
const simToLocal = (v: V3, out: THREE.Vector3) => {
  const m = mirror(v);
  return out.set(m.x, m.y, m.z);
};

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly tuning: CameraTuning;
  mode: CameraMode = DEFAULT_CAMERA;
  lookingBack = false;
  /**
   * Render-side guard (not in the spec): the original's nose-down extra height is a step (0 → p1 as soon as
   * fwd.y < 0), which makes the chase cam bob when the pitch hovers around zero. The step is ramped in over
   * this much -fwd.y. 0 = exact original behaviour.
   */
  extraHeightRamp = 0.02;
  /** Keep the camera at least this far above the rendered ground (render-side guard; 0 = off). */
  groundClearance = 0.35;
  /** THREE-space ground height lookup (set by the renderer per stage). */
  groundAt: ((x: number, z: number) => number) | null = null;
  /** True while the player car should be hidden (bumper / look-back views). */
  hideCar = false;
  /** Flipped-car camera active (debug / tests). */
  flipped = false;

  private readonly chasePos = new THREE.Vector3();
  private chaseValid = false;
  private blend = 0.2;
  private readonly tetherPos = new THREE.Vector3();
  private tetherValid = false;
  private readonly flipPos = new THREE.Vector3();
  private flipClear = 0;
  private readonly sway = new THREE.Vector3();

  // scratch
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly q1 = new THREE.Quaternion();
  private readonly e1 = new THREE.Euler();

  constructor(tuning: CameraTuning = makeCameraTuning()) {
    this.tuning = tuning;
    this.camera = new THREE.PerspectiveCamera(tuning.fov, 16 / 9, 0.1, 3000);
    this.camera.position.set(0, 5, 10);
  }

  setMode(m: CameraMode): void {
    if (!(CAMERA_MODES as readonly string[]).includes(m)) return;
    this.mode = m;
  }

  next(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    return this.mode;
  }

  /** Forget follow state (stage load): the next update snaps behind the car. */
  invalidate(): void {
    this.chaseValid = false;
    this.tetherValid = false;
    this.flipped = false;
    this.flipClear = 0;
    this.sway.set(0, 0, 0);
  }

  private ground(x: number, z: number): number {
    return this.groundAt ? this.groundAt(x, z) : -Infinity;
  }

  update(frameDt: number, t: RigTarget | null): void {
    const cam = this.camera;
    if (!t) return;
    const dt = Math.max(0, frameDt);
    const { pos, quat, tel } = t;
    this.fwd.set(0, 0, -1).applyQuaternion(quat);
    this.up.set(0, 1, 0).applyQuaternion(quat);
    if (t.justReset) {
      this.flipped = false;
      this.flipClear = 0;
      this.chaseValid = false;
      this.tetherValid = false;
      this.sway.set(0, 0, 0);
    }

    // ---- flipped-car detection (§5.3): up.y < 0 → free follow until ≥3 wheels touch for 0.5 s
    if (!this.flipped && this.up.y < 0 && !t.justReset) {
      this.flipped = true;
      this.flipClear = 0;
      this.flipPos.copy(cam.position);
    } else if (this.flipped) {
      if (tel.nContacts >= 3 && this.up.y > 0) {
        this.flipClear += dt;
        if (this.flipClear > 0.5) {
          this.flipped = false;
          // resume the chase leash from where the free camera is
          this.chasePos.copy(cam.position);
          this.chaseValid = true;
          this.tetherPos.copy(cam.position);
          this.tetherValid = true;
        }
      } else this.flipClear = 0;
    }

    let fov = this.tuning.fov;
    this.hideCar = false;
    cam.up.set(0, 1, 0);

    if (this.flipped) {
      fov = this.updateFlipped(dt, pos);
    } else if (this.lookingBack) {
      this.rigid(pos, quat, this.tuning.lookBackPos, Math.PI, 0);
      this.hideCar = true;
      this.chaseValid = false;
      this.tetherValid = false;
    } else if (isChase(this.mode)) {
      this.updateChase(dt, t, this.tuning.chase[this.mode]);
      this.tetherValid = false;
    } else if (isTether(this.mode)) {
      this.updateTether(dt, t);
      this.chaseValid = false;
    } else if (this.mode === 'bumper') {
      this.updateBumper(dt, t);
      this.hideCar = true;
      this.chaseValid = false;
      this.tetherValid = false;
    } else {
      // bonnet
      this.rigid(pos, quat, this.tuning.bonnetPos, 0, 0);
      this.chaseValid = false;
      this.tetherValid = false;
    }
    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  // ------------------------------------------------------------------------------------------ chase

  private updateChase(dt: number, t: RigTarget, e: ChaseCamEntry): void {
    const cam = this.camera;
    const { pos, quat, tel } = t;
    const tu = this.tuning;
    const snap = !this.chaseValid;
    const v = tel.velLocal ? tel.velLocal.z : tel.speedKmh / 3.6;
    const f = chaseBlendTarget(v);
    if (snap) this.blend = f;
    else {
      const maxD = tu.chaseBlendRate * 60 * dt;
      this.blend += clamp(f - this.blend, -maxD, maxD);
    }
    const b = this.blend;
    // offset in the original car frame → three car-local
    const ox = e.posA.x + (e.posB.x - e.posA.x) * b;
    const oy = e.posA.y + (e.posB.y - e.posA.y) * b;
    const oz = e.posA.z + (e.posB.z - e.posA.z) * b;
    const dist = Math.hypot(ox, oy, oz);
    // leash: keep the camera-from-car direction, fix the distance (on reset: straight behind)
    const dir = this.v1;
    if (snap) dir.copy(this.fwd).negate();
    else {
      dir.subVectors(this.chasePos, pos);
      if (dir.lengthSq() < 1e-8) dir.copy(this.fwd).negate();
      dir.normalize();
    }
    this.chasePos.copy(pos).addScaledVector(dir, dist);
    let extra = chaseExtraHeight(this.fwd, e.p0, e.p1);
    if (this.extraHeightRamp > 0) extra *= clamp(-this.fwd.y / this.extraHeightRamp, 0, 1);
    const ideal = simToLocal({ x: ox, y: oy, z: oz }, this.v2).applyQuaternion(quat).add(pos);
    const targetY = pos.y + oy - 3.0 * this.fwd.y + extra;
    if (snap) {
      this.chasePos.x = ideal.x;
      this.chasePos.z = ideal.z;
      this.chasePos.y = targetY;
    } else {
      const kh = perFrameK(tu.chaseHorizLerp, dt);
      const kv = perFrameK(tu.chaseVertLerp, dt);
      this.chasePos.x += (ideal.x - this.chasePos.x) * kh;
      this.chasePos.z += (ideal.z - this.chasePos.z) * kh;
      this.chasePos.y += (targetY - this.chasePos.y) * kv;
    }
    this.clampToGround(this.chasePos);
    this.chaseValid = true;
    cam.position.copy(this.chasePos);
    cam.lookAt(pos.x, pos.y + tu.chaseLookAtHeight, pos.z);
  }

  // ------------------------------------------------------------------------------------------ tether

  private updateTether(dt: number, t: RigTarget): void {
    const cam = this.camera;
    const { pos, tel } = t;
    const e = this.tuning.tether[this.mode as keyof CameraTuning['tether']];
    const s = clamp(0.8 + Math.abs(tel.speedKmh) / 500, 0.8, 1.0); // speed factor [I]
    const dMin = e.d.x * s, dTarget = e.d.y * s, dMax = e.d.z * s * s;
    const k = Math.min(1, e.p1 * dt);
    const pitch = this.fwd.y;
    if (!this.tetherValid) {
      this.tetherPos.copy(pos).addScaledVector(this.fwd, -dTarget);
      this.tetherPos.y = pos.y + 2 * e.p0 + (dTarget + 0.5) / 4 - 1.5 * pitch + (1 - s);
      this.tetherValid = true;
    }
    const d = this.v1.subVectors(this.tetherPos, pos);
    let dist = d.length();
    if (dist < 1e-4) {
      d.copy(this.fwd).negate();
      dist = 1e-4;
    }
    d.divideScalar(dist);
    if (dist < dMin) dist = dMin;
    else if (dist > dMax) dist += (dTarget - dist) * k;
    this.tetherPos.copy(pos).addScaledVector(d, dist);
    const targetY = pos.y + 2 * e.p0 + (dist + 0.5) / 4 - 1.5 * pitch + (1 - s);
    if (this.tetherPos.y < targetY) this.tetherPos.y += (targetY - this.tetherPos.y) * k;
    this.clampToGround(this.tetherPos);
    cam.position.copy(this.tetherPos);
    cam.lookAt(pos.x, pos.y, pos.z);
  }

  // ------------------------------------------------------------------------------------------ rigid views

  /** Camera rigidly attached at `offSim` (original car frame), yawed by `yaw` and pitched by `pitch` (down +). */
  private rigid(pos: THREE.Vector3, quat: THREE.Quaternion, offSim: V3, yaw: number, pitch: number, extraLocal?: THREE.Vector3): void {
    const cam = this.camera;
    const o = simToLocal(offSim, this.v1);
    if (extraLocal) o.add(extraLocal);
    cam.position.copy(o.applyQuaternion(quat).add(pos));
    this.e1.set(-pitch, yaw, 0, 'YXZ');
    this.q1.setFromEuler(this.e1);
    cam.quaternion.copy(quat).multiply(this.q1);
  }

  private updateBumper(dt: number, t: RigTarget): void {
    const tel = t.tel;
    const tu = this.tuning;
    // G-sway: d = clamp(-8·dt·Δv_local) with Δv over one 60 Hz frame = a/60 (a from the 2-step telemetry)
    const k8 = -8 / 3600;
    const dx = clamp(k8 * (tel.aLat ?? 0), -0.15, 0.15);
    const dy = clamp(k8 * (tel.aVert ?? 0), -0.1, 0.1);
    const dz = clamp(k8 * (tel.aLong ?? 0), -0.15, 0.15);
    const ks = perFrameK(0.15, dt);
    // sim body (x, y, z) → three local (x, y, -z)
    this.sway.x += (dx - this.sway.x) * ks;
    this.sway.y += (dy - this.sway.y) * ks;
    this.sway.z += (-dz - this.sway.z) * ks;
    let rough = 0;
    for (const w of tel.wheels) if (w.contact && w.surface) rough += SURFACE_INFO[w.surface].cameraRoughness;
    const st = Math.sin(25 * (tel.simTime ?? 0));
    const pitch = tu.bumperPitch + st * st * Math.abs(tel.speedKmh) * rough * tu.bumperShakeGain;
    this.rigid(t.pos, t.quat, tu.bumperPos, 0, pitch, this.v2.copy(this.sway));
  }

  // ------------------------------------------------------------------------------------------ flipped

  private updateFlipped(dt: number, pos: THREE.Vector3): number {
    const cam = this.camera;
    const d = this.v1.subVectors(this.flipPos, pos);
    let dist = d.length();
    if (dist < 1e-3) {
      d.set(0, 0.5, 1);
      dist = 1e-3;
    }
    d.normalize();
    if (dist < 4) dist = 4;
    else if (dist > 8) dist += (8 - dist) * Math.min(1, 4 * dt);
    this.flipPos.copy(pos).addScaledVector(d, dist);
    const targetY = pos.y + 0.25 * dist;
    this.flipPos.y += (targetY - this.flipPos.y) * Math.min(1, 0.25 * dt);
    const g = this.ground(this.flipPos.x, this.flipPos.z);
    if (this.flipPos.y < g + 2) this.flipPos.y = g + 2;
    cam.position.copy(this.flipPos);
    cam.lookAt(pos);
    return 85.943665 * Math.atan(3.5 / dist);
  }

  private clampToGround(p: THREE.Vector3): void {
    if (this.groundClearance <= 0) return;
    const g = this.ground(p.x, p.z);
    if (p.y < g + this.groundClearance) p.y = g + this.groundClearance;
  }
}
