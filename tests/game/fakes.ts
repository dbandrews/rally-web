/**
 * tests/game/fakes.ts — game builder test helpers: synthetic stages (straight line, circle) implementing the
 * Stage contract in THREE space, and a kinematic fake car implementing ICarSim, so the race controller and
 * autopilot logic can be tested without the (work-in-progress) sim and world modules.
 */
import { neutralControls } from '../../src/core/constants';
import type {
  ArchetypeId,
  CarParams,
  CarTelemetry,
  Controls,
  Discipline,
  Heightfield,
  ICarSim,
  Pacenote,
  RoadSample,
  SimPose,
  Stage,
  StageProjection,
  SurfaceId,
  ThreeV3,
  WheelTelemetry,
} from '../../src/core/types';

const ENV = {
  name: 'test',
  timeOfDay: 12,
  skyTop: 0,
  skyHorizon: 0,
  fogColor: 0,
  fogNear: 100,
  fogFar: 1000,
  sunColor: 0xffffff,
  sunIntensity: 1,
  sunDir: { x: 0, y: 1, z: 0 },
  ambientSky: 0,
  ambientGround: 0,
  ambientIntensity: 1,
  weather: 'clear' as const,
  exposure: 1,
};

function flatHeightfield(size = 4000, y = 0): Heightfield {
  const nx = 3;
  const nz = 3;
  return {
    originX: -size / 2,
    originZ: -size / 2,
    cellSize: size / 2,
    nx,
    nz,
    heights: new Float32Array(nx * nz).fill(y),
    materials: new Uint8Array(nx * nz).fill(6),
  };
}

export interface LineStageOpts {
  length?: number;
  startS?: number;
  finishS?: number;
  checkpoints?: number[];
  discipline?: Discipline;
  pacenotes?: Pacenote[];
  surface?: SurfaceId;
  width?: number;
  validRange?: [number, number];
}

/** Straight stage along THREE -Z from the origin: pointAt(s) = (0, 0, -s); lateral = +x. */
export function makeLineStage(o: LineStageOpts = {}): Stage {
  const length = o.length ?? 1000;
  const startS = o.startS ?? 10;
  const finishS = o.finishS ?? length - 10;
  const width = o.width ?? 8;
  const surface = o.surface ?? 'gravel';
  const clampS = (s: number) => Math.min(length, Math.max(0, s));
  const pointAt = (s: number): ThreeV3 => ({ x: 0, y: 0, z: -clampS(s) });
  const roadAt = (s: number): RoadSample => ({
    s: clampS(s),
    pos: pointAt(s),
    left: { x: -width / 2, y: 0, z: -clampS(s) },
    right: { x: width / 2, y: 0, z: -clampS(s) },
    width,
    bank: 0,
    surface,
  });
  const road: RoadSample[] = [];
  for (let s = 0; s <= length; s += 2) road.push(roadAt(s));
  return {
    id: 'line',
    name: 'Line Test',
    discipline: o.discipline ?? 'rally',
    description: 'straight',
    seed: 1,
    closed: false,
    laps: 1,
    length,
    defaultTyre: 2,
    pointAt,
    tangentAt: () => ({ x: 0, y: 0, z: -1 }),
    roadAt,
    project(p: ThreeV3): StageProjection {
      const s = clampS(-p.z);
      return { s, lateral: p.x, heightOffset: p.y, point: pointAt(s) };
    },
    startS,
    startPose: { pos: pointAt(startS), dir: { x: 0, y: 0, z: -1 } },
    checkpoints: o.checkpoints ?? [250, 500, 750],
    finishS,
    validRange: o.validRange ?? [0, length],
    environment: ENV,
    heightfield: flatHeightfield(),
    road,
    scenery: [],
    pacenotes: o.pacenotes ?? [],
  };
}

export interface CircleStageOpts {
  radius?: number;
  laps?: number;
  checkpoints?: number[];
  startS?: number;
  finishS?: number;
}

/**
 * Closed circular stage of radius R centred on the origin: pointAt(s) = (R cos θ, 0, R sin θ), θ = s / R.
 * Travel direction (-sin θ, 0, cos θ); right = toward the centre, so lateral = R - r.
 */
export function makeCircleStage(o: CircleStageOpts = {}): Stage {
  const R = o.radius ?? 100;
  const L = 2 * Math.PI * R;
  const wrap = (s: number) => ((s % L) + L) % L;
  const pointAt = (s: number): ThreeV3 => {
    const th = wrap(s) / R;
    return { x: R * Math.cos(th), y: 0, z: R * Math.sin(th) };
  };
  const tangentAt = (s: number): ThreeV3 => {
    const th = wrap(s) / R;
    return { x: -Math.sin(th), y: 0, z: Math.cos(th) };
  };
  const roadAt = (s: number): RoadSample => {
    const p = pointAt(s);
    return { s: wrap(s), pos: p, left: p, right: p, width: 10, bank: 0, surface: 'tarmac' };
  };
  const road: RoadSample[] = [];
  for (let s = 0; s < L; s += 2) road.push(roadAt(s));
  const startS = o.startS ?? 0;
  return {
    id: 'circle',
    name: 'Circle Test',
    discipline: 'rallycross',
    description: 'loop',
    seed: 1,
    closed: true,
    laps: o.laps ?? 3,
    length: L,
    defaultTyre: 0,
    pointAt,
    tangentAt,
    roadAt,
    project(p: ThreeV3): StageProjection {
      const th = Math.atan2(p.z, p.x);
      const s = wrap(th * R);
      const r = Math.hypot(p.x, p.z);
      return { s, lateral: R - r, heightOffset: p.y, point: pointAt(s) };
    },
    startS,
    startPose: { pos: pointAt(startS), dir: tangentAt(startS) },
    checkpoints: o.checkpoints ?? [L / 3, (2 * L) / 3],
    finishS: o.finishS ?? startS,
    validRange: [0, L],
    environment: ENV,
    heightfield: flatHeightfield(),
    road,
    scenery: [],
    pacenotes: [],
  };
}

function wheel(): WheelTelemetry {
  return {
    slipAngle: 0,
    kappa: 0,
    load: 3000,
    mode: 1,
    surface: 'gravel',
    material: 1,
    contact: true,
    omega: 0,
    Fsusp: 3000,
    Fx: 0,
    Fy: 0,
    mu: 1,
    driveT: 0,
    brakeT: 0,
    contactPoint: { x: 0, y: 0, z: 0 },
    contactPointThree: { x: 0, y: 0, z: 0 },
    visual: { steerAngle: 0, spinAngle: 0, suspensionOffset: 0.1, centreLocal: { x: 0.75, y: -0.12, z: -1.2 } },
  };
}

/**
 * Kinematic car in THREE space: heading (rad, 0 = facing -Z, + = turning right / toward +X), forward speed.
 * step(): simple bicycle model; tests may also place it directly with `place()`.
 */
export class FakeCar implements ICarSim {
  readonly id = 'player';
  readonly archetype: ArchetypeId = 'awd_wrc';
  readonly params = { archetype: 'awd_wrc', transmission: 'auto' } as unknown as CarParams;
  pos: ThreeV3 = { x: 0, y: 0.4, z: 0 };
  heading = 0;
  speed = 0;
  /** Lateral velocity (m/s, + right) for slide tests. */
  vLat = 0;
  parked = false;
  frozen = false;
  resets = 0;
  steps = 0;
  lastPose: SimPose | null = null;
  lastControls: Controls = neutralControls();
  transmission: 'auto' | 'manual' = 'auto';
  gear = 1;
  rpm = 3000;
  yawRate = 0;
  /** CarSim.setTrackBraking (post-finish phys+0x44 braking factor; 0 = off, reset clears it). */
  trackBraking = 0;

  setTrackBraking(factor: number): void {
    this.trackBraking = Number.isFinite(factor) && factor > 0 ? factor : 0;
  }

  reset(pose: SimPose): void {
    this.lastPose = pose;
    this.trackBraking = 0;
    // sim → three: (x, y, -z); heading from the sim quaternion's forward (+z sim)
    this.pos = { x: pose.pos.x, y: pose.pos.y, z: -pose.pos.z };
    const q = pose.q;
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    // sim forward (fx, fz) → three (fx, -fz); heading 0 faces three -Z
    this.heading = Math.atan2(fx, fz);
    this.speed = 0;
    this.vLat = 0;
    this.yawRate = 0;
    this.resets++;
  }

  place(x: number, z: number, heading = this.heading, speed = this.speed, y = 0.4): void {
    this.pos = { x, y, z };
    this.heading = heading;
    this.speed = speed;
  }

  step(c: Readonly<Controls>, dt: number): void {
    if (this.frozen || dt === 0) return;
    this.lastControls = { ...c };
    this.steps++;
    const a = this.parked ? -this.speed * 5 : c.throttle * 8 - c.brake * 12 * Math.sign(this.speed);
    this.speed += a * dt;
    if (c.handbrake > 0.5) this.speed *= 0.99;
    this.yawRate = (this.speed * Math.tan(c.steer * 0.4)) / 2.5;
    this.heading += this.yawRate * dt;
    const fx = Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    this.pos.x += (fx * this.speed - fz * 0 + Math.cos(this.heading) * this.vLat) * dt;
    this.pos.z += (fz * this.speed + Math.sin(this.heading) * this.vLat) * dt;
  }

  telemetry(): CarTelemetry {
    const h = this.heading;
    // three quaternion for yaw h (turning right = negative rotation about +Y)
    const qy = { w: Math.cos(-h / 2), x: 0, y: Math.sin(-h / 2), z: 0 };
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const rx = Math.cos(h);
    const rz = Math.sin(h);
    const vel = { x: fx * this.speed + rx * this.vLat, y: 0, z: fz * this.speed + rz * this.vLat };
    const kmh = Math.abs(this.speed) * 3.6;
    return {
      id: this.id,
      archetype: this.archetype,
      stepCount: this.steps,
      simTime: this.steps / 120,
      resetCount: this.resets,
      speedKmh: kmh,
      speedWorldKmh: Math.hypot(vel.x, vel.z) * 3.6,
      rpm: this.rpm,
      rpmRedline: 8250,
      rpmMax: 8750,
      gear: this.gear,
      nGears: 6,
      shifting: false,
      boost: 0,
      boostFrac: 0,
      transmission: this.transmission,
      tyreType: 2,
      throttle: this.lastControls.throttle,
      brake: this.lastControls.brake,
      handbrake: this.lastControls.handbrake,
      steer: this.lastControls.steer,
      steerAngle: this.lastControls.steer * 0.4,
      beta: 0,
      yawRate: this.yawRate,
      aLat: 0,
      aLong: 0,
      aVert: 0,
      nContacts: 4,
      airborne: false,
      airMul: 1,
      bodyOnGround: false,
      yawCapActive: false,
      yawRateCapActive: false,
      parked: this.parked,
      impactImpulse: 0,
      collision: { hull: false, hullMaterial: 0, hullStrength: 0, objectHits: 0, objectType: -1, objectStrength: 0, bush: false },
      simFaults: 0,
      posSim: { x: this.pos.x, y: this.pos.y, z: -this.pos.z },
      quatSim: { w: qy.w, x: -qy.x, y: -qy.y, z: qy.z },
      velSim: { x: vel.x, y: 0, z: -vel.z },
      velLocal: { x: this.vLat, y: 0, z: this.speed },
      angVelLocal: { x: 0, y: this.yawRate, z: 0 },
      pos: { ...this.pos },
      quat: qy,
      vel,
      wheels: [wheel(), wheel(), wheel(), wheel()],
    };
  }

  pose(): SimPose {
    const t = this.telemetry();
    return { pos: t.posSim, q: t.quatSim };
  }
  setParams(): void {}
  setSurfaces(): void {}
  setWorld(): void {}
  setParked(p: boolean): void {
    this.parked = p;
  }
  setFrozen(f: boolean): void {
    this.frozen = f;
  }
}

/** A pacenote at s with defaults. */
export const note = (s: number, text = '4 right', over: Partial<Pacenote> = {}): Pacenote => ({
  s,
  cornerS: s + 60,
  text,
  direction: 'right',
  severity: 4,
  modifiers: [],
  ...over,
});
