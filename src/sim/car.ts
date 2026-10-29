/**
 * src/sim/car.ts — OWNED BY THE SIM BUILDER.
 *
 * The car physics of docs/MECHANICS_SPEC.md §1-§2 (step order §1.5), implemented in SIM space
 * (left-handed, x right, y up, z forward; the original's frame, §1.1). Every formula of §2 is written in
 * that frame verbatim; tools/reference/spec_sim_check.py is the literal Python port this file was
 * checked against.
 *
 * REQUIRED EXPORTS (keep these signatures; contract in src/core/types.ts ICarSim):
 *   class CarSim implements ICarSim
 *     constructor(opts: CarSimOptions)          // { id?, params, world, surfaces?, seed? }
 *     readonly id: string; readonly archetype: ArchetypeId; readonly params: Readonly<CarParams>
 *     reset(pose: SimPose, settleSteps = 100): void
 *     step(controls: Readonly<Controls>, dt: number): void      // dt is always DT = 1/120
 *     telemetry(): CarTelemetry                                  // fresh object per physics step (cached)
 *     pose(): SimPose
 *     setParams(partial: DeepPartial<CarParams>): void           // rebuild derived values
 *     setSurfaces(table: SurfaceTable): void
 *     setWorld(world: WorldQuery): void
 *     setParked(parked: boolean): void
 *     setFrozen(frozen: boolean): void
 *
 * Extra (sim-internal / tests): debug(), damageState(), repair(). (telemetry().simFaults is in the contract.)
 *
 * Implementation notes
 *  - Wheel order 0 FL, 1 FR, 2 RR, 3 RL. wheel.front params apply to 0/1, wheel.rear to 2/3.
 *  - Every literal constant of §2 that has a §6 tuning key reads that key from `params`; at shipped
 *    values the arithmetic is identical to the spec / reference.
 *  - §2.9 chassis-ground collision uses hull points against world.heightAt/normalAt (the spec's "or a
 *    height query"), so it is correct for any body orientation. Obstacles (trees, rocks, posts) are
 *    vertical cylinders from world.obstaclesNear(), resolved against the hull footprint rectangle with a
 *    forgiving impulse (low restitution, contact at CG height so hits yaw the car but never flip it).
 *  - NaN / explosion guard: the state is snapshotted before every step; a non-finite or absurd state is
 *    rolled back, velocities are zeroed and telemetry.simFaults is incremented.
 *  - telemetry() builds a fresh plain object once per physics step (cached until the next step), so a
 *    reference kept by a caller is never mutated later.
 */
import { DT, MATERIAL_SOLID_MIN, SETTLE_STEPS, surfaceFromMaterial } from '../core/constants';

/** DEV-9 settle: steps with sleep enabled at the end, vertical-calm steps needed, cap on the sleep-free part. */
const SETTLE_SLEEP_STEPS = 15;
const SETTLE_CALM_STEPS = 10;
const SETTLE_EXTRA_MAX = 240;
import { clamp, qCopy, qNormalize, sgn, towardZero, v3, type V3 } from '../core/math';
import { deepMergeInto } from '../core/paths';
import { Rng } from '../core/rng';
import type {
  ArchetypeId,
  CarParams,
  CarSimOptions,
  CarTelemetry,
  Controls,
  DeepPartial,
  ICarSim,
  Obstacle,
  Quad,
  SimPose,
  SurfaceDef,
  SurfaceId,
  SurfaceTable,
  WheelParams,
  WheelTelemetry,
  WorldQuery,
} from '../core/types';
import { makeSurfaceTable } from './params';
import { buildLoadTable, torqueCurveAt, tyreForce, type TyreForceOut } from './tables';

// ------------------------------------------------------------------------------------------- types

/** Kept for older imports: simFaults is now part of the CarTelemetry contract. */
export type SimTelemetry = CarTelemetry;

/** §5.6 damage state (only used when params.damage.physical). */
export interface DamageState {
  /** Steer offset per front wheel, rad, |.| ≤ 0.05. */
  steer: [number, number];
  /** Suspension damage per wheel ≤ 0.25 (SpringK, DampK × (1 - d)). */
  suspension: Quad<number>;
  /** Brake damage per wheel ≤ 0.25 (capacity × (1 - d)). */
  brakes: Quad<number>;
  /** Engine damage ≤ 0.25 (TorqueScale × (1 - d); misfire at the cap). */
  engine: number;
  /** Gearbox damaged: 1st/3rd × 0.9, 2nd/4th × 1.1 ratios. */
  gearbox: boolean;
}

/** Internal per-step values for tests and debugging (fresh object per call). */
export interface SimDebug {
  /** Total world force integrated in the last step (N), incl. gravity·airMul. */
  forceWorld: V3;
  /** Body axes (world). */
  right: V3;
  up: V3;
  fwd: V3;
  beta: number;
  /** Assist speed factor s (§2.5.0). */
  speedFactor: number;
  /** B.vL state of §1.4 (local velocity computed at B2, before this step's velocity update). §7.1 bots read |vL.z|·3.6. */
  vL: V3;
  angMomLocal: V3;
  inertia: V3;
  mass: number;
  frontShare2: number;
  shiftSpeed: number[];
  ratio: number[];
  shiftDir: number;
  clutch: boolean;
  slept: boolean;
  wheels: { mode: 1 | 2; Fz: number; load: number; ext: number; Fsusp: number; omega: number; driveT: number; brakeT: number; brakeCap: number; mu: number; tanA: number; kappa: number }[];
}

// ------------------------------------------------------------------------------------------- constants

/** "Missing row → all columns 1.0" (§4.2) for ground material ids that have no surface (10..31). */
const FALLBACK_SURFACE: SurfaceDef = {
  id: 'tarmac',
  material: -1,
  origId: -1,
  deep: false,
  bodyK: 1,
  bodyKScale: 1,
  maxDepth: 1,
  epsilon: 1,
  frictionLevel: 1,
  bump: 1,
  bumpFlag: 0,
  wheelJitterAmp: 0,
  cameraRoughness: 0,
  tyre: [0, 1, 2, 3, 4].map(() => ({ bestStatic: 1, diffStatic: 1, scaleKinetic: 1, bestRollK: 1, diffRollK: 1 })) as SurfaceDef['tyre'],
};
// maxDepth 1.0 would sink the car by a metre: clamp the fallback's physical sink to 0 (documented deviation).
FALLBACK_SURFACE.maxDepth = 0;
FALLBACK_SURFACE.bump = 0;

/**
 * §2.9 chassis friction μ_body = BODY_FRICTION_K · BodyK. The spec's starting guess is 0.5 [G]; it is tuned
 * to the §2.9 target "slides on its roof with about 0.4-0.6 g on gravel": while sliding on the roof the spec's
 * own rules already apply air gravity ×1.45 (< 3 wheel contacts above 10 km/h, §2.10), the 2 m/s² free-flight
 * damping and the §2.7 chassis drag, so 0.5 gives ≈ 1.05 g. 0.12 gives ≈ 0.5 g.
 */
export const BODY_FRICTION_K = 0.12;
/** §2.9 restitution e = BODY_RESTITUTION_K · Epsilon [G]. */
export const BODY_RESTITUTION_K = 0.1;

/** Chassis contact columns for non-ground solids (material ≥ 32: rock walls, buildings). [D] */
const SOLID_BODY = { bodyK: 0.9, epsilon: 0.5 };

/** Obstacle (tree / rock / post) impulse model [D]: forgiving. */
const OBSTACLE_RESTITUTION = 0.15;
const OBSTACLE_FRICTION = 0.25;
/** Fraction of the rigid-body angular response used for obstacle hits (< 1 = forgiving, less spin). */
const OBSTACLE_ANGULAR = 0.5;
const OBSTACLE_PUSH = 0.8;
/** Hull half width for obstacles and the hull points (§3.4). */
const HULL_HALF_WIDTH = 0.85;

/** NaN guard bounds. */
const MAX_SPEED = 250; // m/s
const MAX_ANG = 60; // rad/s, body rates
const MAX_WHEEL_OMEGA = 3000; // rad/s
const MAX_COORD = 1e6;

const SNAP_SIZE = 32 + 4 * 14;

// ------------------------------------------------------------------------------------------- wheel state

class WheelState {
  readonly index: number;
  readonly front: boolean;
  /** Body-frame ray start = bundle position with y reduced by wheelRadius (§1.4). */
  readonly mount: V3 = v3();
  otherAxleZ = 0;
  omega = 0;
  driveT = 0;
  brakeT = 0;
  brakeCap = 0;
  /** SIGNED: -normal load (negative when loaded), §2.5.5. */
  load = 0;
  tanA = 0;
  ext = 1;
  dampV = 0;
  kappa = 0;
  Fsusp = 0;
  mu = 0;
  contact = false;
  /** Material id of the last hit (-1 if none). */
  material = -1;
  surf: SurfaceDef | null = null;
  surfId: SurfaceId | null = null;
  hitDist = 0;
  /** World x/z of this step's ray END point (mount - up·springLength, W+0x94/+0x9c): the washboard bump
   *  pattern is sampled here [runtime-verified, Frida trace]. */
  hitX = 0;
  hitZ = 0;
  readonly normalW: V3 = v3(0, 1, 0);
  readonly contactW: V3 = v3();
  steerOffX = 0;
  steerOffZ = 0;
  ny = 0;
  mode: 1 | 2 = 1;
  // telemetry / diagnostics
  Fx = 0;
  Fy = 0;
  Fz = 0;
  spin = 0;
  readonly r: V3 = v3();

  constructor(index: number) {
    this.index = index;
    this.front = index < 2;
  }

  resetState(): void {
    this.omega = 0;
    this.driveT = 0;
    this.brakeT = 0;
    this.load = 0;
    this.tanA = 0;
    this.ext = 1;
    this.dampV = 0;
    this.kappa = 0;
    this.Fsusp = 0;
    this.mu = 0;
    this.contact = false;
    this.material = -1;
    this.surf = null;
    this.surfId = null;
    this.hitDist = 0;
    this.normalW.x = 0;
    this.normalW.y = 1;
    this.normalW.z = 0;
    this.steerOffX = 0;
    this.steerOffZ = 0;
    this.ny = 0;
    this.mode = 1;
    this.Fx = this.Fy = this.Fz = 0;
  }
}

// ------------------------------------------------------------------------------------------- CarSim

export class CarSim implements ICarSim {
  readonly id: string;
  readonly params: CarParams;
  private world: WorldQuery;
  private surfaces: SurfaceTable;
  private readonly rng: Rng;

  // ---- body (§1.4 Body) ----
  private mass = 1;
  private invMass = 1;
  private readonly I: V3 = v3(1, 1, 1);
  private readonly invI: V3 = v3(1, 1, 1);
  private readonly pos: V3 = v3();
  private readonly vW: V3 = v3();
  private readonly q = { w: 1, x: 0, y: 0, z: 0 };
  private readonly right: V3 = v3(1, 0, 0);
  private readonly up: V3 = v3(0, 1, 0);
  private readonly fwd: V3 = v3(0, 0, 1);
  private readonly vL: V3 = v3();
  private readonly L: V3 = v3();
  private readonly w: V3 = v3();
  private readonly Fext: V3 = v3();
  private readonly loadMoment: V3 = v3();
  private airMul = 1;
  private bodyOnGround = false;

  // ---- car state (§1.4 CarState) ----
  private speedKmh = 0;
  private thr = 0;
  private brk = 0;
  private readonly steerA: [number, number] = [0, 0];
  private gear = 1;
  private shiftDir: 0 | 1 | 2 = 0;
  private shiftTimer = 0;
  private clutch = false;
  private rpm = 1000;
  private boost = 0.1;
  private ratio: number[] = [];
  private shiftSpeed: number[] = [];
  private reverseAllowed = true;
  private thrRamp = 0;
  private flipTimer = 0;
  private nContacts = 0;
  private parked = false;
  private stepParity = 0;
  private frontShare2 = 1;

  // ---- controls of the current step ----
  private readonly C: Controls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, gearUp: false, gearDown: false };

  // ---- wheels ----
  private readonly W: [WheelState, WheelState, WheelState, WheelState] = [
    new WheelState(0),
    new WheelState(1),
    new WheelState(2),
    new WheelState(3),
  ];
  private loadTableF = new Float64Array(80);
  private loadTableR = new Float64Array(80);
  private hull: V3[] = [];

  // ---- bookkeeping / telemetry ----
  private frozen = false;
  private steps = 0;
  private resets = 0;
  private faults = 0;
  private beta = 0;
  private sf = 0;
  private yawCap = false;
  private yawRateCap = false;
  private slept = false;
  /** DEV-9: inside the sleep-free part of the reset settle. */
  private settling = false;
  private impact = 0;
  private readonly Facc: V3 = v3();
  private readonly Tacc: V3 = v3();
  private readonly Fworld: V3 = v3();
  /** World velocities after the last 3 steps (for 2-step Δv accelerations). */
  private readonly vHist: [V3, V3, V3] = [v3(), v3(), v3()];
  private vHistN = 0;
  private readonly aLocal: V3 = v3();
  private telCache: SimTelemetry | null = null;
  private readonly dmg: DamageState = { steer: [0, 0], suspension: [0, 0, 0, 0], brakes: [0, 0, 0, 0], engine: 0, gearbox: false };
  private gearboxDamageApplied = false;

  // ---- scratch ----
  private readonly tf: TyreForceOut = { Fx: 0, Fy: 0, Mz: 0, aEq: 0 };
  private readonly tmpO: V3 = v3();
  private readonly tmpD: V3 = v3();
  private readonly cRW: V3 = v3();
  private readonly cVP: V3 = v3();
  private readonly cN: V3 = v3();
  private readonly cT: V3 = v3();
  private obsBuf: Obstacle[] = [];
  private readonly snap = new Float64Array(SNAP_SIZE);
  private readonly snapModes: (1 | 2)[] = [1, 1, 1, 1];
  private snapGear = 1;
  private snapShiftDir: 0 | 1 | 2 = 0;

  constructor(opts: CarSimOptions) {
    this.id = opts.id ?? 'player';
    this.params = opts.params;
    this.world = opts.world;
    this.surfaces = opts.surfaces ?? makeSurfaceTable();
    this.rng = new Rng(opts.seed ?? 1);
    this.rebuildDerived();
    this.rpm = this.params.minRpm;
    this.boost = this.params.turboIdle;
    this.rebuildAxes();
  }

  get archetype(): ArchetypeId {
    return this.params.archetype;
  }

  // =================================================================================== public API

  reset(pose: SimPose, settleSteps = SETTLE_STEPS): void {
    const p = this.params;
    this.rebuildDerived();
    this.pos.x = pose.pos.x;
    this.pos.y = pose.pos.y;
    this.pos.z = pose.pos.z;
    const qn = qNormalize(pose.q);
    this.q.w = qn.w;
    this.q.x = qn.x;
    this.q.y = qn.y;
    this.q.z = qn.z;
    this.rebuildAxes();
    zero(this.vW);
    zero(this.vL);
    zero(this.L);
    zero(this.w);
    zero(this.Fext);
    zero(this.loadMoment);
    zero(this.Fworld);
    this.airMul = 1;
    this.bodyOnGround = false;
    this.speedKmh = 0;
    this.thr = this.brk = 0;
    this.steerA[0] = this.steerA[1] = 0;
    this.gear = 1;
    this.shiftDir = 0;
    this.shiftTimer = 0;
    this.clutch = false;
    this.rpm = p.minRpm;
    this.boost = p.turboSize !== 0 ? p.turboIdle : -1;
    this.reverseAllowed = true;
    this.thrRamp = 0;
    this.flipTimer = 0;
    this.nContacts = 0;
    this.stepParity = 0;
    this.beta = 0;
    this.sf = 0;
    for (const w of this.W) {
      w.resetState();
      // contactW: below the mount (bump pattern reads last step's contact point)
      this.toWorldTo(this.tmpO, w.mount);
      w.contactW.x = this.pos.x + this.tmpO.x;
      w.contactW.y = this.pos.y + this.tmpO.y;
      w.contactW.z = this.pos.z + this.tmpO.z;
    }
    this.vHistN = 0;
    zero(this.aLocal);
    this.resets++;
    this.telCache = null;
    const hold: Controls = { steer: 0, throttle: 0, brake: 0, handbrake: 1, gearUp: false, gearDown: false };
    if (p.assist.settleToEquilibrium === false) {
      for (let i = 0; i < settleSteps; i++) this.step(hold, DT); // original §1.2 settle
    } else {
      // DEV-9: no sleep while the body drops onto its springs and the bounce dies out (it would freeze the body
      // wherever |v| first dips under √0.1 m/s), then sleep as usual so the low-speed chatter cannot creep. At least
      // `settleSteps` steps in total (§1.2); the sleep-free part stops once the body has been vertically still for
      // SETTLE_CALM_STEPS steps (typically ≈ 20 steps after landing), capped at settleSteps + SETTLE_EXTRA_MAX.
      this.settling = true;
      let i = 0;
      let calm = 0;
      while (i < settleSteps + SETTLE_EXTRA_MAX) {
        this.step(hold, DT);
        i++;
        calm = this.verticallyStill() ? calm + 1 : 0;
        if (calm >= SETTLE_CALM_STEPS) break;
      }
      this.settling = false;
      for (let k = 0; k < SETTLE_SLEEP_STEPS || i < settleSteps; k++, i++) this.step(hold, DT);
    }
    this.telCache = null;
  }

  /** DEV-9 settle: wheels down and no vertical / pitch-bounce motion left (≤ 2 mm/s). */
  private verticallyStill(): boolean {
    return this.nContacts >= 3 && Math.abs(this.vW.y) < 0.002 && Math.abs(this.up.y) > 0.5;
  }

  step(controls: Readonly<Controls>, dt: number): void {
    if (dt === 0 || this.frozen) return;
    const C = this.C;
    C.steer = Number.isFinite(controls.steer) ? controls.steer : 0;
    C.throttle = Number.isFinite(controls.throttle) ? clamp(controls.throttle, 0, 1) : 0;
    C.brake = Number.isFinite(controls.brake) ? clamp(controls.brake, 0, 1) : 0;
    C.handbrake = Number.isFinite(controls.handbrake) ? clamp(controls.handbrake, 0, 1) : 0;
    C.gearUp = !!controls.gearUp;
    C.gearDown = !!controls.gearDown;
    this.saveGood();
    this.impact = 0;
    this.stepA(dt);
    this.stepB(dt);
    this.steps++;
    if (!this.isSane()) this.restoreGood();
    this.updateAccel(dt);
    this.telCache = null;
  }

  telemetry(): SimTelemetry {
    if (!this.telCache) this.telCache = this.buildTelemetry();
    return this.telCache;
  }

  pose(): SimPose {
    return { pos: { x: this.pos.x, y: this.pos.y, z: this.pos.z }, q: qCopy(this.q) };
  }

  setParams(partial: DeepPartial<CarParams>): void {
    deepMergeInto(this.params, partial);
    this.rebuildDerived();
    this.telCache = null;
  }

  setSurfaces(table: SurfaceTable): void {
    this.surfaces = table;
  }

  setWorld(world: WorldQuery): void {
    this.world = world;
  }

  setParked(parked: boolean): void {
    this.parked = parked;
    this.telCache = null;
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  /** §5.6 damage state (copy). */
  damageState(): DamageState {
    const d = this.dmg;
    return { steer: [d.steer[0], d.steer[1]], suspension: [...d.suspension] as Quad<number>, brakes: [...d.brakes] as Quad<number>, engine: d.engine, gearbox: d.gearbox };
  }

  /** Clear all §5.6 damage. */
  repair(): void {
    const d = this.dmg;
    d.steer[0] = d.steer[1] = 0;
    d.suspension.fill(0);
    d.brakes.fill(0);
    d.engine = 0;
    d.gearbox = false;
    this.rebuildDerived();
  }

  /** Internal values (tests, debug overlay). Fresh object. */
  debug(): SimDebug {
    return {
      forceWorld: { ...this.Fworld },
      right: { ...this.right },
      up: { ...this.up },
      fwd: { ...this.fwd },
      beta: this.beta,
      speedFactor: this.sf,
      vL: { ...this.vL },
      angMomLocal: { ...this.L },
      inertia: { ...this.I },
      mass: this.mass,
      frontShare2: this.frontShare2,
      shiftSpeed: [...this.shiftSpeed],
      ratio: [...this.ratio],
      shiftDir: this.shiftDir,
      clutch: this.clutch,
      slept: this.slept,
      wheels: this.W.map((w) => ({
        mode: w.mode,
        Fz: w.Fz,
        load: w.load,
        ext: w.ext,
        Fsusp: w.Fsusp,
        omega: w.omega,
        driveT: w.driveT,
        brakeT: w.brakeT,
        brakeCap: w.brakeCap,
        mu: w.mu,
        tanA: w.tanA,
        kappa: w.kappa,
      })),
    };
  }

  /**
   * Test helper (§7 T3 ice-on-tarmac-tyres row): set the forward speed directly, all ω = v/R, and a gear.
   * Not used by the game.
   */
  setForwardSpeed(v: number, gear?: number): void {
    this.vW.x = this.fwd.x * v;
    this.vW.y = this.fwd.y * v;
    this.vW.z = this.fwd.z * v;
    this.toLocalTo(this.vL, this.vW);
    for (const w of this.W) w.omega = v / this.params.wheelRadius;
    if (gear !== undefined) this.gear = clamp(Math.round(gear), 0, this.params.nGears);
    this.telCache = null;
  }

  // =================================================================================== derived values

  /** Rebuild everything derived from params (§6: brake caps, ratios, shift speeds, inertia, frontShare2, load table). */
  private rebuildDerived(): void {
    const p = this.params;
    // body
    this.mass = p.mass * p.upgrade.weight;
    this.invMass = 1 / this.mass;
    this.I.x = p.inertia.x * this.mass;
    this.I.y = p.inertia.y * this.mass;
    this.I.z = p.inertia.z * this.mass;
    this.invI.x = 1 / this.I.x;
    this.invI.y = 1 / this.I.y;
    this.invI.z = 1 / this.I.z;
    // wheels (§1.4 mount = bundle with y - wheelRadius; FR/RR mirror x)
    const R = p.wheelRadius;
    const fl = p.wheelFL;
    const rl = p.wheelRL;
    setV(this.W[0].mount, fl.x, fl.y - R, fl.z);
    setV(this.W[1].mount, -fl.x, fl.y - R, fl.z);
    setV(this.W[2].mount, -rl.x, rl.y - R, rl.z);
    setV(this.W[3].mount, rl.x, rl.y - R, rl.z);
    this.W[0].otherAxleZ = this.W[3].mount.z;
    this.W[1].otherAxleZ = this.W[2].mount.z;
    this.W[2].otherAxleZ = this.W[1].mount.z;
    this.W[3].otherAxleZ = this.W[0].mount.z;
    // §2.5.4 static front share
    const dzAxle = this.W[0].mount.z - this.W[3].mount.z;
    this.frontShare2 = dzAxle !== 0 ? (2 * Math.abs(this.W[3].mount.z)) / dzAxle : 1;
    // §2.3.6 brake capacity
    const f = p.brakeBalance * p.setup.brake;
    const base = p.brakeTorque * p.upgrade.brakes;
    for (let i = 0; i < 4; i++) this.W[i].brakeCap = base * (i < 2 ? f : 2 - f) * (1 - this.dmg.brakes[i]);
    // §2.3.1 ratios (+ §5.6 gearbox damage factors) and §2.2 shift speeds
    const m = p.setup.gearRatio;
    const n = Math.max(1, Math.round(p.nGears));
    this.ratio = new Array(n + 1);
    for (let g = 0; g <= n; g++) {
      const r0 = p.gearRatio[g] ?? p.gearRatio[p.gearRatio.length - 1] ?? 1;
      let k = 1;
      if (this.dmg.gearbox) k = g === 1 || g === 3 ? 0.9 : g === 2 || g === 4 ? 1.1 : 1;
      this.ratio[g] = r0 * (g <= 4 ? m : 2 - m) * k;
    }
    this.gearboxDamageApplied = this.dmg.gearbox;
    const rpmRef = p.turboSize !== 0 ? p.maxTurboTorqueRpm : p.maxTorqueRpm;
    const circ = 2 * Math.PI * p.wheelRadius;
    this.shiftSpeed = new Array(n);
    for (let i = 0; i < n; i++) {
      this.shiftSpeed[i] = p.useGearSpeedValues
        ? (p.gearSpeed[i] ?? 0)
        : ((rpmRef - 50) * (circ * 3.6)) / (p.finalDrive * 60) / this.ratio[i + 1];
    }
    if (this.gear > n) this.gear = n;
    // §2.6.1 load tables per axle
    buildLoadTable(p.wheel.front, p.rebuildLoadTable, p.loadTableScale, this.loadTableF);
    buildLoadTable(p.wheel.rear, p.rebuildLoadTable, p.loadTableScale, this.loadTableR);
    // §3.4 hull points
    const zf = p.hullFrontZ;
    const zr = p.hullRearZ;
    const yb = p.hullBottomY;
    const yt = -p.hullBottomY;
    const hw = HULL_HALF_WIDTH;
    this.hull = [
      // bottom 4 (always probed)
      v3(-hw, yb, zf), v3(hw, yb, zf), v3(hw, yb, zr), v3(-hw, yb, zr),
      // mid 4 (the "8 points" set)
      v3(-hw, yt, zf), v3(hw, yt, zf), v3(hw, yt, zr), v3(-hw, yt, zr),
      // roof 4 (only when < 3 wheels touch)
      v3(-0.5, 1.0, 0.12), v3(0.5, 1.0, 0.12), v3(0.48, 1.0, -1.06), v3(-0.48, 1.0, -1.06),
    ];
  }

  // =================================================================================== step A (§2.1-§2.4)

  private stepA(dt: number): void {
    const p = this.params;
    const C = this.C;
    // A1
    this.speedKmh = Math.abs(this.vL.z) * 3.6;
    // A2 inputs and steering (§2.1)
    if (p.transmission === 'auto' && this.gear === 0) {
      this.thr = C.brake;
      this.brk = C.throttle;
    } else {
      this.thr = C.throttle;
      this.brk = C.brake;
    }
    this.clutch = this.parked;
    const kmh = this.speedKmh;
    const lock = p.wheelScale + (kmh < p.lowSpeedLockKmh ? (p.lowSpeedLockKmh - kmh) * p.lowSpeedLockGain : 0);
    const st = clamp(C.steer, -1, 1);
    this.steerA[0] = this.steerA[1] = lock * st;
    // A4 damage effects (§5.6), only if physical
    if (p.damage.physical) {
      this.steerA[0] += this.dmg.steer[0];
      this.steerA[1] += this.dmg.steer[1];
      if (this.dmg.gearbox !== this.gearboxDamageApplied) this.rebuildDerived();
    }
    // A3 gearbox (§2.2)
    this.gearbox(dt);
    // A5 engine, rpm, turbo, differentials, brakes (§2.3)
    this.drivetrain(C.handbrake, dt);
    // A6 gravity + aero (§2.4)
    const qd = -p.airKZY * this.vL.z * this.vL.z;
    const vW = this.vW;
    const k = p.airKZZ;
    this.Fext.x = qd * this.up.x - Math.abs(vW.x) * vW.x * k;
    this.Fext.y = qd * this.up.y - p.gravity * this.mass - Math.abs(vW.y) * vW.y * k;
    this.Fext.z = qd * this.up.z - Math.abs(vW.z) * vW.z * k;
  }

  /** §2.2 [V FUN_006c6c60]. */
  private gearbox(dt: number): void {
    const p = this.params;
    const C = this.C;
    const mul = p.autoShiftTimeMul;
    if (this.shiftDir !== 0) {
      this.shiftTimer -= dt;
      this.clutch = true;
      if (this.shiftTimer >= 0) return;
      this.gear += this.shiftDir === 1 ? 1 : -1;
      this.gear = clamp(this.gear, 0, this.ratio.length - 1);
      this.shiftDir = 0;
      return;
    }
    const nG = this.ratio.length - 1;
    if (p.transmission === 'auto') {
      if (this.clutch) return;
      const v = len3(this.vW) * 3.6;
      const g = this.gear;
      if (g === 0) {
        if (this.brk > 0.3 && (this.speedKmh < 0.25 || this.vL.z > 0)) {
          this.shiftDir = 1;
          this.shiftTimer = p.timeChangeGearFR * mul;
        }
        return;
      }
      if (v > this.shiftSpeed[g - 1] && g < nG) {
        this.shiftDir = 1;
        this.shiftTimer = p.timeChangeGear * mul;
      }
      if (this.thr <= p.throttleMinLimit) {
        if (this.brk <= 0.3 || this.speedKmh >= 5) {
          const th = this.shiftSpeed[g - 1] * p.downGearFactor;
          if (v < th && this.rpm < p.minRpmGearChange && ((g === 2 && v < 0.75 * th) || (g > 2 && v < 0.95 * th))) {
            this.shiftDir = 2;
            this.shiftTimer = Math.min(this.shiftTimer, 0); // not reloaded: completes next step [V]
          }
        } else {
          this.gear = 1;
          if (this.reverseAllowed) {
            this.shiftDir = 2;
            this.shiftTimer = p.timeChangeGearFR * mul;
          }
        }
      } else if (g > 1 && v < this.shiftSpeed[g - 2] * p.downGearFactor) {
        // on-throttle kick-down: instant, no clutch
        let u = g - 1;
        while (u > 1 && v < this.shiftSpeed[u - 2] * p.downGearFactor) {
          this.gear--;
          u--;
        }
        this.gear--;
      }
    } else {
      if (!C.gearDown) {
        if (C.gearUp && this.gear < nG) {
          if (this.gear === 0) {
            if (!(this.speedKmh >= 100 && this.vL.z <= 0)) {
              this.shiftDir = 1;
              this.shiftTimer = p.timeChangeGearFR * mul;
            }
          } else {
            this.shiftDir = 1;
            this.shiftTimer = p.timeChangeGear;
          }
        }
      } else if (this.gear !== 0) {
        if (this.gear === 1) {
          if (this.speedKmh < 30) {
            this.shiftDir = 2;
            this.shiftTimer = p.timeChangeGearFR * mul;
          }
        } else {
          this.shiftDir = 2;
          this.shiftTimer = p.timeChangeGear;
        }
      }
    }
  }

  private torqueCurve(): number {
    return torqueCurveAt(this.rpm);
  }

  /** §2.3.2 per-wheel base torque [V FUN_006c8050]. */
  private engineTorque(): number {
    const p = this.params;
    const rpm = this.rpm;
    const ts = p.torqueScale * (p.damage.physical ? 1 - this.dmg.engine : 1);
    let t = rpm >= 10000 ? 0 : this.torqueCurve() * p.torqueScaleFactor;
    t *= ts;
    if (this.gear < 3 && rpm < 5500) {
      const f = (6000 - rpm) * p.lowGearFill * ts;
      if (f > 0) t += f;
      if (p.useSpinTorque && this.thr > 0.5 && (this.gear === 0 || this.gear === 1)) t += Math.abs(this.thr) * p.spinTorqueScaleValue * f;
    }
    if (p.turboSize !== 0) t *= 1 + (p.turboMaxGain / p.turboWasteGate) * p.turboSize * this.boost;
    if (p.damage.physical && this.dmg.engine >= 0.25) t *= 1 - (this.rng.int(0, 127) / 256) * this.dmg.engine; // misfire
    t *= p.upgrade.engine;
    if (this.gear === 0) t = -t;
    return t;
  }

  /** §2.3.3 rpm and turbo [V FUN_006c7e70]. */
  private updateRpm(wMean: number, thr: number, dt: number): void {
    const p = this.params;
    if (!this.clutch) {
      this.rpm = wMean * 9.549296 * this.ratio[this.gear] * p.finalDrive;
      if (this.rpm > p.cutRpm) this.rpm -= 2 * this.rpm * dt;
    } else {
      this.rpm = this.rpm - (2 - thr * 1.95) * this.rpm * dt * 0.75 + dt * 15000 * thr * 2.5 * this.torqueCurve();
    }
    if (p.turboSize === 0) {
      this.boost = -1;
      return;
    }
    // spool threshold T = 0.5 [V]; (T - thr) / T is bit-identical to the original's (0.5 - thr)·2 at T = 0.5
    const T = p.turboSpoolThrottle ?? 0.5;
    if (thr <= T || this.rpm <= p.turboSize * 1500 - 800) {
      this.boost -= (p.turboSize * Math.max(0, (T - thr) / Math.max(1e-6, T)) * this.boost) / (p.turboSpinup * 40); // per STEP
    } else {
      this.boost += (this.boost * thr) / (p.turboSpinup * 40); // per STEP
    }
    this.boost = clamp(this.boost, p.turboIdle, p.turboWasteGate);
  }

  /** §2.3.4-§2.3.6 [V FUN_006c7170]. */
  private drivetrain(hb: number, dt: number): void {
    const p = this.params;
    const W = this.W;
    const rpmAtStepStart = this.rpm;
    for (const w of W) {
      w.driveT = 0;
      w.brakeT = 0;
    }
    const shifting = this.shiftDir !== 0 || this.clutch;
    if (shifting) {
      if (p.useEngineBrakeConstant && ((this.shiftDir === 1 && this.gear === 0) || (this.shiftDir === 2 && this.gear === 1))) {
        for (const w of W) w.brakeT = p.engineBrakeConstant; // R<->1 change: hold the car
      }
      const wAll = (W[0].omega + W[1].omega + W[2].omega + W[3].omega) * 0.25;
      if (this.shiftDir !== 0) {
        if (p.turboSize !== 0 && this.boost > 0.25 * p.turboWasteGate) this.boost = 0.25 * p.turboWasteGate;
        this.updateRpm(wAll, 0, dt); // throttle ignored while shifting
      } else this.updateRpm(wAll, this.thr, dt);
    } else {
      const rev = this.gear === 0;
      const f = (o: number) => (rev ? Math.min(o, 0) : Math.max(o, 0));
      const lo = 1 - p.lsdClamp;
      const hi = 1 + p.lsdClamp;
      let kF = 1;
      let kR = 1;
      let kC = 1;
      let wMean = 0;
      if (p.wheelDrive === 0) {
        const a = f(W[0].omega);
        const b = f(W[1].omega);
        wMean = (a + b) / 2;
        if (wMean !== 0) kF = clamp(b / wMean, lo, hi);
      } else if (p.wheelDrive === 1) {
        const a = f(W[3].omega);
        const b = f(W[2].omega);
        wMean = (a + b) / 2;
        if (wMean !== 0) kR = clamp(b / wMean, lo, hi);
      } else {
        const a = f(W[0].omega);
        const b = f(W[1].omega);
        const fm = (a + b) / 2;
        if (fm !== 0) kF = clamp(b / fm, lo, hi);
        const c = f(W[3].omega);
        const d = f(W[2].omega);
        const rm = (c + d) / 2;
        if (rm !== 0) kR = clamp(d / rm, lo, hi);
        wMean = (fm + rm) / 2;
        if (wMean !== 0) kC = clamp(fm / wMean, lo, hi);
      }
      this.updateRpm(wMean, this.thr, dt);
      let T: number;
      if (this.thr <= p.throttleMinLimit) {
        // off throttle: engine braking (NOT EngineBrakeConstant)
        T = (this.thr - p.throttleMinLimit) * (p.engineBrakeBase - p.engineBrakePerGear * this.gear + this.rpm) * p.engineBrakeGain;
        if (Math.abs(wMean) < 1) T *= Math.abs(wMean);
        if (this.gear === 0) T = -T;
      } else {
        T = this.engineTorque();
        if (p.useAntiSpin && this.gear < 3 && W.some((w) => Math.abs(w.kappa) > 0.05)) T /= p.antiSpinFactor;
        T *= this.thr;
      }
      if (p.wheelDrive === 0) {
        const fb = p.fwdFrontBias;
        const rb = 2 - fb;
        W[0].driveT = fb * T * kF;
        W[1].driveT = fb * T * (2 - kF);
        W[2].driveT = rb * T * kF;
        W[3].driveT = rb * T * (2 - kF);
      } else if (p.wheelDrive === 1) {
        const rb = p.rwdRearBias;
        const fb = 2 - rb;
        W[0].driveT = fb * T * kR;
        W[1].driveT = fb * T * (2 - kR);
        W[2].driveT = rb * T * (2 - kR);
        W[3].driveT = rb * T * kR;
      } else {
        const fs = p.setup.awdBaseSplit * p.setup.powerRatio;
        W[0].driveT = (2 - kC) * kF * fs * T;
        W[1].driveT = (2 - kC) * (2 - kF) * fs * T;
        W[2].driveT = (2 - kR) * kC * (2 - fs) * T;
        W[3].driveT = kR * kC * (2 - fs) * T;
      }
    }
    // §2.3.5 hill-hold, stall drag, park
    if (p.useEngineBrakeConstant) {
      const EBC = p.engineBrakeConstant;
      if (this.parked) {
        for (const w of W) w.brakeT = EBC;
      } else if (this.thr < p.throttleMinLimit || this.shiftDir !== 0) {
        if (this.rpm <= p.minRpm) {
          const x = Math.min(p.minRpm - this.rpm, p.minRpm) / p.minRpm;
          for (const w of W) w.brakeT = x * x * EBC * 0.2;
        }
      } else if (this.gear === 0) {
        for (const w of W) if (w.omega > 0.3) w.brakeT = EBC;
      } else {
        for (const w of W) if (w.omega < -0.3) w.brakeT = EBC;
      }
    }
    // idle and limiter (written AFTER this step's torque lookup)
    if (this.rpm < p.minRpm) {
      if (this.thr >= p.throttleMinLimit) this.rpm = p.minRpm;
      else this.rpm = clamp(rpmAtStepStart, p.minRpm - 184, p.minRpm - 16) + this.rng.int(-15, 16);
    }
    if (this.rpm > p.cutRpm) this.rpm = p.cutRpm + 512 + this.rng.int(-511, 512);
    // §2.3.6 rolling resistance (LAST step's tyre loads)
    const tt = p.tyreType;
    let pool = 0;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      let c = 0;
      if (w.contact && w.surf) {
        const row = w.surf.tyre[tt];
        const rr = row.bestRollK + row.diffRollK * p.rollLevel;
        const t = (-w.load / 2048) * rr;
        c = 0.25 * t;
        pool += 0.75 * t;
      }
      const driven = p.wheelDrive === 2 || (p.wheelDrive === 0 && i < 2) || (p.wheelDrive === 1 && i >= 2);
      if (driven) c += (i < 2 ? p.wheel.front : p.wheel.rear).rollK;
      w.driveT -= w.omega * c;
    }
    for (const w of W) w.driveT -= w.omega * 0.25 * pool;
    // service brakes, ABS, handbrake
    const brk = this.brk;
    if (brk > p.brakeMinLimit) {
      for (const w of W) {
        if (brk < p.brakeHalfZone) w.brakeT = 0.5 * brk * brk * w.brakeCap;
        else if (!p.useAbs || Math.abs(w.kappa) < p.absFactor) w.brakeT = brk * brk * w.brakeCap;
        else w.brakeT = 0; // ABS release
      }
    }
    if (hb > p.brakeMinLimit) {
      for (let i = 0; i < 4; i++) W[i].brakeT = hb * p.handBrakeTorque * (i < 2 ? p.hbFront : p.hbRear);
    }
  }

  // =================================================================================== step B (§2.5-§2.10)

  private stepB(dt: number): void {
    const p = this.params;
    const W = this.W;
    const B_up = this.up;
    this.yawCap = this.yawRateCap = false;
    this.slept = false;
    // B1 speed factor, slip-ratio threshold
    const kmh = this.speedKmh;
    const sf = kmh <= p.assistSpeedLo ? 0 : Math.min(1, (kmh - p.assistSpeedLo) * p.assistSpeedSlope);
    this.sf = sf;
    const kappaThr = p.slipRatioThreshold * (1 + sf);
    // B2 integrate pose with last step's velocities (symplectic Euler)
    this.pos.x += this.vW.x * dt;
    this.pos.y += this.vW.y * dt;
    this.pos.z += this.vW.z * dt;
    {
      const q = this.q;
      const wx = this.w.x;
      const wy = this.w.y;
      const wz = this.w.z;
      const dw = -q.x * wx - q.y * wy - q.z * wz;
      const dx = q.w * wx + q.y * wz - q.z * wy;
      const dy = q.w * wy + q.z * wx - q.x * wz;
      const dz = q.w * wz + q.x * wy - q.y * wx;
      const h = 0.5 * dt;
      let nw = q.w + dw * h;
      let nx = q.x + dx * h;
      let ny = q.y + dy * h;
      let nz = q.z + dz * h;
      const l = Math.sqrt(nw * nw + nx * nx + ny * ny + nz * nz);
      if (l > 0) {
        nw /= l;
        nx /= l;
        ny /= l;
        nz /= l;
      } else {
        nw = 1;
        nx = ny = nz = 0;
      }
      q.w = nw;
      q.x = nx;
      q.y = ny;
      q.z = nz;
    }
    this.rebuildAxes();
    this.toLocalTo(this.vL, this.vW);
    // B3 body slip angle
    const vL = this.vL;
    const beta = vL.z === 0 ? 0 : Math.atan(-vL.x / vL.z);
    this.beta = beta;
    const absBeta = Math.abs(beta);
    this.stepParity ^= 1;

    // B4 wheel raycasts (§2.5.1)
    const dir = this.tmpD;
    dir.x = -B_up.x;
    dir.y = -B_up.y;
    dir.z = -B_up.z;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      const wp = i < 2 ? p.wheel.front : p.wheel.rear;
      const o = this.tmpO;
      this.toWorldTo(o, w.mount);
      o.x += this.pos.x;
      o.y += this.pos.y;
      o.z += this.pos.z;
      const hit = this.world.raycast(o, dir, wp.springLength);
      const hn = hit ? hit.normal : null;
      if (!hit || !hn || !(hit.material < MATERIAL_SOLID_MIN) || !Number.isFinite(hit.dist) || !(hn.y > 0.01) || !Number.isFinite(hn.x + hn.z)) {
        w.contact = false;
        w.material = -1;
        w.surf = null;
        w.surfId = null;
        w.normalW.x = 0;
        w.normalW.y = 1;
        w.normalW.z = 0;
      } else {
        w.contact = true;
        w.material = hit.material;
        const sid = surfaceFromMaterial(hit.material);
        w.surfId = sid;
        w.surf = sid ? this.surfaces[sid] : FALLBACK_SURFACE;
        w.hitDist = Math.max(0, hit.dist);
        w.hitX = o.x + dir.x * wp.springLength;
        w.hitZ = o.z + dir.z * wp.springLength;
        const nl = Math.hypot(hn.x, hn.y, hn.z);
        w.normalW.x = hn.x / nl;
        w.normalW.y = hn.y / nl;
        w.normalW.z = hn.z / nl;
      }
    }

    // B5 suspension (§2.5.3)
    let n = 0;
    const k = p.setup.suspension;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      if (!w.contact) {
        w.dampV = 0;
        w.ext = 1;
        w.Fsusp = 0;
        continue;
      }
      n++;
      const wp = i < 2 ? p.wheel.front : p.wheel.rear;
      const SL = wp.springLength;
      const comp = SL - w.hitDist;
      // Runtime-verified (Frida trace): x = 1 - (sink + c0) / (c4·SL) with c0 = comp·c4, c4 = -SL·(up·n), so the
      // surface sink REDUCES compression by sink / (SL·cosθ): the wheel sinks in and the body rides lower.
      const cosT = Math.max(0.05, B_up.x * w.normalW.x + B_up.y * w.normalW.y + B_up.z * w.normalW.z);
      const x = clamp(1 - (comp - this.surfaceSink(w) / (SL * cosT)) / SL, 0, 1);
      const xPrev = w.ext === 1 ? x : w.ext;
      w.ext = x;
      const e = 1 - (xPrev + x) / 2;
      const kd = k * (p.damage.physical ? 1 - this.dmg.suspension[i] : 1);
      const dx = clamp((xPrev - x) * SL, -0.5, 0.5);
      const vOld = w.dampV;
      const vNew = (2 / dt) * (dx - dt * vOld) + vOld;
      w.dampV = vNew;
      const Fd = Math.min(p.damperCap, 0.5 * (vNew + vOld) * (1 + e) * kd * wp.dampK);
      const Fs = kd * wp.springK * SL * e * (1 + 0.5 * e);
      let F = Fd + Fs;
      if (p.antiPogo) {
        const vn = this.vW.x * w.normalW.x + this.vW.y * w.normalW.y + this.vW.z * w.normalW.z;
        if (vn > 2) F = Math.min(F, Math.max(0, 32000 - 5000 * vn));
      }
      w.Fsusp = Math.max(0, F);
    }
    this.nContacts = n;

    // B6 tyre normal loads (§2.5.5)
    {
      const Fup = this.Fext.x * B_up.x + this.Fext.y * B_up.y + this.Fext.z * B_up.z;
      const nb = this.bodyOnGround ? p.bodyGroundShare : 0;
      const Tx = this.loadMoment.x;
      const Tz = this.loadMoment.z;
      if (n === 1) {
        for (let i = 0; i < 4; i++) {
          const w = W[i];
          if (!w.contact) continue;
          this.toWorldTo(this.tmpO, w.mount);
          const l = len3(this.tmpO);
          w.load = l > 0 ? (-(this.tmpO.y / l) * Fup) / (nb + 1) : 0;
          break;
        }
      } else if (n >= 2) {
        const base = Fup / (nb + 4);
        for (let i = 0; i < 4; i++) {
          const w = W[i];
          if (!w.contact) continue;
          const wp = i < 2 ? p.wheel.front : p.wheel.rear;
          const share = n === 2 ? base : base * (i < 2 ? this.frontShare2 : 2 - this.frontShare2);
          const kx = n === 2 ? 2 : n === 3 && !W[SAME_SIDE[i]].contact ? 2 : 1;
          const kz = n === 2 ? 2 : n === 3 && !W[SAME_AXLE[i]].contact ? 2 : 1;
          w.load = share + SX[i] * kx * wp.momentXDist * Tx + SZ[i] * kz * wp.momentZDist * Tz;
        }
      }
    }

    // B7 per-wheel loop (§2.6)
    const Facc = this.Facc;
    const Tacc = this.Tacc;
    zero(Facc);
    zero(Tacc);
    let lmx = 0;
    let lmz = 0;
    const R = p.wheelRadius;
    const tt = p.tyreType;
    const Iy = this.I.y;
    const bw = this.w;
    const speedWorld = len3(this.vW);
    const assist = p.assist;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      const wp: WheelParams = i < 2 ? p.wheel.front : p.wheel.rear;
      const inv = wp.wheelInertia;
      let FwX = 0;
      let FwY = 0;
      let FwZ = 0;
      let Fx = 0;
      let Fy = 0;
      let Vy = 0;
      let head = 0;
      let FxWheel = 0;
      w.Fx = w.Fy = w.Fz = 0;
      // W1 wheel spin from drive and brake torque
      if (w.omega > 0) w.omega = Math.max(0, w.omega - w.brakeT * inv * dt);
      else if (w.omega < 0) w.omega = Math.min(0, w.omega + w.brakeT * inv * dt);
      let launch = 1;
      if (p.launchAssist && this.gear <= 1 && this.thr > 0.1) {
        const ao = Math.abs(w.omega);
        let raw: number;
        let sc: number;
        if (p.wheelDrive === 2) {
          raw = Math.max(1, (25 - ao) * 0.2);
          sc = p.launchScaleAwd;
        } else if (i < 2) {
          raw = Math.max(1, 4 - ao);
          sc = p.launchScaleFront;
        } else {
          raw = Math.max(1, (20 - ao) * 0.2);
          sc = p.launchScaleRear;
        }
        launch = 1 + (raw - 1) * sc;
      }
      w.omega += launch * w.driveT * inv * dt; // wheelInertia is an INVERSE inertia
      // W2 lock
      if (Math.abs(w.omega) < p.lockOmega && w.brakeT > p.lockTorque) w.omega = 0;
      // W3 contact point (body frame)
      let rx = w.mount.x;
      let ry = w.mount.y;
      let rz = w.mount.z;
      const stI = i < 2 ? this.steerA[i] : 0;
      if (w.contact && w.surf) {
        const sd = w.surf;
        ry = w.mount.y - wp.springLength * w.ext;
        if (w.front) {
          const kk = wp.steerTweak * (i === 1 ? -1 : 1);
          w.steerOffX = (1 - Math.cos(stI)) * kk;
          w.steerOffZ = Math.sin(stI) * kk;
          rx += w.steerOffX;
          rz += w.steerOffZ;
        }
        // W4 contact velocity, normal, suspension force
        const vx = vL.x + (bw.y * rz - bw.z * ry);
        const vy = vL.y + (bw.z * rx - bw.x * rz);
        const vz = vL.z + (bw.x * ry - bw.y * rx);
        let Fz = Math.max(0, -w.load);
        const nW = w.normalW;
        const nlx = this.right.x * nW.x + this.right.y * nW.y + this.right.z * nW.z;
        const nly = B_up.x * nW.x + B_up.y * nW.y + B_up.z * nW.z;
        const nlz = this.fwd.x * nW.x + this.fwd.y * nW.y + this.fwd.z * nW.z;
        FwX = nlx * w.Fsusp;
        FwY = nly * w.Fsusp;
        FwZ = nlz * w.Fsusp;
        // W5 wheel axes (Ackermann on the front axle)
        let ax = 1;
        let az = 0;
        if (w.front && stI !== 0) {
          const t = Math.tan(stI);
          const c = t === 0 ? 1 : 1 / t;
          const dzA = rz - w.otherAxleZ;
          const X = (dzA - w.steerOffZ) * c - rx;
          if (X <= 0) {
            ax = -X;
            az = dzA;
          } else {
            ax = X;
            az = -dzA;
          }
        }
        const adn = ax * nlx + az * nlz;
        let dX = ax - nlx * adn;
        let dY = -nly * adn;
        let dZ = az - nlz * adn;
        const dl = Math.sqrt(dX * dX + dY * dY + dZ * dZ);
        if (dl > 0) {
          dX /= dl;
          dY /= dl;
          dZ /= dl;
        }
        const fwX = dY * nlz - dZ * nly;
        const fwY = dZ * nlx - dX * nlz;
        const fwZ = dX * nly - dY * nlx;
        Vy = vx * dX + vy * dY + vz * dZ;
        const Vx = vx * fwX + vy * fwY + vz * fwZ;
        w.ny = nly;
        // W6 slope load reduction
        if (nly < 0.9635) Fz *= Math.max(0.25, nly * nly);
        // W7 slip angle with relaxation
        const aVx = Math.abs(Vx);
        if (aVx > 3) w.tanA += wp.tireRelaxK * (-Vy - aVx * w.tanA) * dt;
        else if (aVx > 0.1) w.tanA = -Vy / aVx;
        else if (Math.abs(Vy) > 0.01) w.tanA = -Vy * 10;
        else w.tanA = Vy >= 0 ? -1e-5 : 1e-5;
        const alpha = Math.atan(w.tanA);
        // W8 slip ratio
        w.kappa = aVx === 0 ? (R * w.omega - Vx) * 100 : (R * w.omega - Vx) / aVx;
        // W9 friction coefficient (live table)
        const row = sd.tyre[tt];
        const muS = row.bestStatic + row.diffStatic * 0.7 * sd.frictionLevel;
        let mu = (w.mode === 1 ? muS : muS * row.scaleKinetic) * p.muGlobalScale;
        // W10 drift grip bonuses
        if (absBeta > p.driftGripBeta) mu *= 1 + absBeta * this.thr * p.driftGripGain;
        const bb = assist.bigBetaSymmetric ? absBeta : beta; // DEV-1
        if (bb > p.bigBetaThreshold) mu *= 1 + (absBeta - p.bigBetaThreshold) * p.bigBetaGain;
        w.mu = mu;
        const muFz = Fz * mu;
        // W11 grip/slide state machine (new mode takes effect next step)
        const ssa = (p.steerSensFast ? wp.staticSlipAngleFast : wp.staticSlipAngleSlow) * p.upgrade.handling;
        const thrA = (Fz / 2048) * ssa;
        let newMode = w.mode;
        const aOm = Math.abs(w.omega);
        const aVy = Math.abs(Vy);
        const aK = Math.abs(w.kappa);
        if (w.mode === 1) {
          if ((aOm > 0.05 || aVy > 0.05) && (Math.abs(alpha) > thrA || aK > kappaThr)) newMode = 2;
        } else if ((Math.abs(alpha) < thrA || aVy < 0.1) && (aK < kappaThr || aVx < 0.1)) newMode = 1;
        // W12 tyre force
        const mult = sd.deep && p.useSideFriction ? p.sideFrictionFactor : 1;
        const tf = tyreForce(this.tf, i < 2 ? this.loadTableF : this.loadTableR, wp, w.tanA, w.kappa, Fz, muFz, mult);
        Fy = tf.Fy;
        Fx = tf.Fx;
        // W13 yaw assists
        let M: number;
        if (w.mode === 1) {
          M = assist.smoothYawFrictionSign
            ? -wp.twStaMy * Iy * mu * clamp(this.L.y / (0.05 * Iy), -1, 1) // DEV-3
            : wp.twStaMy * Iy * mu * (this.L.y >= 0 ? -1 : 1);
          if (w.front) {
            const m2 = wp.twStaSteer * Iy * mu * stI;
            M += vL.z <= 0 ? -m2 : m2;
          }
        } else {
          M = tf.Mz;
          if (w.front) {
            const m2 = (absBeta + 0.25) * Iy * wp.twKinSteer * mu * stI;
            M += vL.z <= 0 ? -m2 : m2;
          }
          if (aOm < 0.05 && aVy < 0.05) newMode = 1;
        }
        Tacc.y += M * sf;
        // W14 low-speed fades
        if (aOm < 0.1 && aVx < 0.1) Fx *= aVx * 10;
        if (aVy < 0.0625) Fy *= aVy * 16;
        head = muFz - Math.abs(Fy);
        FxWheel = Fx; // the wheel reaction uses Fx before W15 [V]
        // W15 sliding wheelspin limiter (body force only)
        if (
          p.wheelspinLimiter &&
          w.mode === 2 &&
          (this.gear > 1 || p.wheelDrive === 2) &&
          sf === 0 &&
          aK > 0.15 &&
          sgn(w.kappa) === sgn(w.omega) &&
          w.omega !== 0
        ) {
          const f1 = Math.min(1, 0.15 / aK + 0.25);
          const g1 = Math.max(0, 1.5 - mu);
          Fx *= Math.max(f1, g1);
        }
        w.mode = newMode;
        FwX += fwX * Fx + dX * Fy;
        FwY += fwY * Fx + dY * Fy;
        FwZ += fwZ * Fx + dZ * Fy;
        w.Fx = Fx;
        w.Fy = Fy;
        w.Fz = Fz;
      } else {
        w.ny = 0;
      }
      // W16 drift drive boost and wheel reaction
      const extra = Math.abs(w.omega) > 1 ? FxWheel * p.driftDriveBoost * absBeta * sf : 0;
      if (w.brakeT < p.lockTorque || Math.abs(w.omega) < p.lockOmega) w.omega += -(extra + FxWheel) * R * inv * dt;
      // W17 spin-torque damping (shipped OFF)
      if (p.useSpinTorqueDamping && this.speedKmh < 40 && this.thr > 0.5 && this.gear === 1 && Math.abs(w.kappa) > 0.05) {
        Facc.z /= p.spinTorqueDampingValue;
      }
      Facc.z += extra;
      // W18 side fill
      if (head !== 0 && Math.abs(Vy) > 0.0625) {
        const f2 = Math.min(1, absBeta + p.sideFillBase);
        const gate = assist.smoothSideFillGate ? clamp((Math.abs(Vy) - 0.0625) / 0.0625, 0, 1) : 1; // DEV-8
        Facc.x += (Fy > 0 ? 1 : -1) * f2 * Math.min(head, p.sideFillCap) * gate;
      }
      // W19 flip assist (timer runs once PER WHEEL: 4·dt per step [V])
      if (p.flipAssist && speedWorld * 3.6 < 5) {
        if (B_up.y >= 0.125) this.flipTimer = 0;
        else this.flipTimer += dt;
        if (this.flipTimer > 4 && Math.abs(this.fwd.y) < 0.5 && B_up.y < 0.25 && this.nContacts === 0) {
          const push = this.mass * this.thrRamp * -p.gravity;
          if (this.right.y >= 0.5) {
            if (i === 1 || i === 2) FwY += push; // lying on its left side
          } else if (i === 0 || i === 3) FwY += push; // lying on its right side
        }
      }
      // W20 accumulate
      Facc.x += FwX;
      Facc.y += FwY;
      Facc.z += FwZ;
      Tacc.x += ry * FwZ - rz * FwY;
      Tacc.y += rz * FwX - rx * FwZ;
      Tacc.z += rx * FwY - ry * FwX;
      lmx += -ry * FwX;
      lmz += -ry * FwZ;
      w.r.x = rx;
      w.r.y = ry;
      w.r.z = rz;
      this.toWorldTo(this.tmpO, w.r);
      w.contactW.x = this.pos.x + this.tmpO.x;
      w.contactW.y = this.pos.y + this.tmpO.y;
      w.contactW.z = this.pos.z + this.tmpO.z;
    }
    this.loadMoment.x = lmx;
    this.loadMoment.y = 0;
    this.loadMoment.z = lmz;

    // B8 throttle ramp; body friction damping (§2.7)
    this.thrRamp = this.thr > 0 ? Math.min(2.25, this.thrRamp + 2.25 * dt) : 0;
    if (p.useBodyFrictionDamping) {
      const vmag = len3(vL);
      let gain = 0;
      if (this.nContacts === 0 && this.bodyOnGround) {
        gain = vmag * 0.25 * p.bodyContactFactor * this.Fext.y; // sliding on the chassis
      } else if (this.nContacts > 0) {
        let sumDiff = 0;
        let K = 0;
        for (const w of W) {
          if (w.contact && w.surf && w.surf.deep) {
            sumDiff += w.surf.tyre[tt].diffRollK;
            K += 0.5 * p.wheelContactFactor;
          }
        }
        gain = (sumDiff / this.nContacts) * vmag * K * this.Fext.y; // bogging on DEEP surfaces
      }
      if (gain !== 0 && vmag > 0) {
        const s = gain / vmag;
        const Fx = vL.x * s;
        const Fy = vL.y * s;
        const Fz = vL.z * s;
        Facc.x += Fx;
        Facc.y += Fy;
        Facc.z += Fz;
        const ay = p.hullBottomY; // application point (0, hullBottomY, 0)
        Tacc.x += ay * Fz;
        Tacc.z += -ay * Fx;
      }
    }
    // B9 anti-roll torque (§2.7)
    {
      const fp = p.wheel.front;
      const rp = p.wheel.rear;
      const x0 = W[0].mount.x;
      const x1 = W[1].mount.x;
      const x2 = W[2].mount.x;
      const x3 = W[3].mount.x;
      if (x1 - x0 !== 0) {
        // 0.5·(RS[0] + RS[1]): both wheels of an axle share one parameter set
        Tacc.z += (fp.rollStiffness * ((W[0].ext - W[1].ext) * fp.springLength * 2 * (W[0].ny + W[1].ny))) / (x1 - x0);
      }
      if (x2 - x3 !== 0) {
        Tacc.z += (rp.rollStiffness * ((W[3].ext - W[2].ext) * rp.springLength * 2 * (W[3].ny + W[2].ny))) / (x2 - x3);
      }
    }
    // B10 chassis-ground collision (every other step, or every step while touching) + obstacles
    if (this.stepParity === 0 || this.bodyOnGround) this.chassisCollision();
    this.obstacleCollision();
    // B11 yaw caps (§2.8)
    if (this.nContacts >= 2) {
      const lim = (2.75 - sf - absBeta) * p.twMaxMom * Iy;
      const t0 = Tacc.y;
      Tacc.y = Math.min(Tacc.y, lim);
      Tacc.y = Math.max(Tacc.y, -lim);
      this.yawCap = Tacc.y !== t0;
      const limL = Iy * ((2 - sf) * p.twMomLimStart + absBeta * p.twMomLimScale);
      const l0 = this.L.y;
      this.L.y = clamp(this.L.y, -limL, limL);
      this.yawRateCap = this.L.y !== l0;
    }
    // B12 air gravity multiplier (per STEP)
    if (this.speedKmh <= 10) this.airMul = 1;
    else if (this.nContacts < 3) this.airMul = Math.min(p.airGravityMax, this.airMul * p.airGravityGrowth);
    else if (Math.abs(this.fwd.y) <= 0.25) this.airMul = 1;
    // B13 integrate (symplectic Euler, one-step angular lag)
    {
      const r = this.right;
      const u = B_up;
      const f = this.fwd;
      const am = this.airMul;
      const FwX = r.x * Facc.x + u.x * Facc.y + f.x * Facc.z + this.Fext.x * am;
      const FwY = r.y * Facc.x + u.y * Facc.y + f.y * Facc.z + this.Fext.y * am;
      const FwZ = r.z * Facc.x + u.z * Facc.y + f.z * Facc.z + this.Fext.z * am;
      this.Fworld.x = FwX;
      this.Fworld.y = FwY;
      this.Fworld.z = FwZ;
      const s = this.invMass * dt;
      this.vW.x += FwX * s;
      this.vW.y += FwY * s;
      this.vW.z += FwZ * s;
      this.w.x = this.invI.x * this.L.x;
      this.w.y = this.invI.y * this.L.y;
      this.w.z = this.invI.z * this.L.z;
      this.L.x += Tacc.x * dt;
      this.L.y += Tacc.y * dt;
      this.L.z += Tacc.z * dt;
      if (this.nContacts === 0) {
        const ad = p.airAngDamp * dt;
        const ld = p.airLinDamp * dt;
        this.L.x = towardZero(this.L.x, this.I.x * ad);
        this.L.y = towardZero(this.L.y, this.I.y * ad);
        this.L.z = towardZero(this.L.z, this.I.z * ad);
        this.vW.x = towardZero(this.vW.x, ld);
        this.vW.y = towardZero(this.vW.y, ld);
        this.vW.z = towardZero(this.vW.z, ld);
      }
    }
    // sleep (§2.10)
    {
      const pedals = assist.sleepPedalThreshold
        ? this.thr > p.throttleMinLimit || this.brk > p.brakeMinLimit // DEV-6
        : this.thr !== 0 || this.brk !== 0;
      const springCap = assist.heavyCarSleep
        ? Math.max(4500, (1.25 * p.gravity * this.mass * Math.max(this.frontShare2, 2 - this.frontShare2)) / 4) // DEV-7
        : 4500;
      let hardSpring = false;
      for (const w of W) if (w.Fsusp > springCap) hardSpring = true;
      const v2 = this.vW.x * this.vW.x + this.vW.y * this.vW.y + this.vW.z * this.vW.z;
      const w2 = this.w.x * this.w.x + this.w.y * this.w.y + this.w.z * this.w.z;
      if (v2 < 0.1 && w2 < 0.1 && this.nContacts >= 3 && !hardSpring && (!pedals || this.parked) && !this.settling) {
        zero(this.vW);
        this.L.y = 0;
        for (const w of W) w.omega = 0;
        this.slept = true;
      }
    }
    // visual wheel spin (rendered angle, + = rolling forward)
    for (const w of W) {
      w.spin += w.omega * dt;
      if (w.spin > TWO_PI || w.spin < -TWO_PI) w.spin %= TWO_PI;
    }
  }

  /** §2.5.2 surface sink and washboard bump [V FUN_006cf860]. */
  private surfaceSink(w: WheelState): number {
    const sf = w.surf;
    if (!sf) return 0;
    let sink = sf.maxDepth;
    if (sf.bumpFlag & 1) {
      let b = 0;
      const cx = w.hitX;
      const cz = w.hitZ;
      let u = ((cx % 0.2) + 0.2) % 0.2;
      if (u > 0.025 && u < 0.175) b += Math.cos((u - 0.1) * 16) - 0.36;
      u = ((cz % 0.2) + 0.2) % 0.2;
      if (u > 0.025 && u < 0.175) b += Math.cos((u - 0.1) * 16) - 0.36;
      const A = sf.bump * (1 - this.speedKmh / 512);
      sink += A * (0.64 - 0.5 * b);
    }
    return sink;
  }

  // =================================================================================== §2.9 collisions

  /** Rigid-body inverse effective mass along unit world direction n at world offset rW (body-frame inertia). */
  private effMassInv(rW: V3, n: V3, angScale = 1): number {
    // body frame
    const rx = this.dotR(rW);
    const ry = this.dotU(rW);
    const rz = this.dotF(rW);
    const nx = this.dotR(n);
    const ny = this.dotU(n);
    const nz = this.dotF(n);
    // c = cross(r, n)
    const cx = ry * nz - rz * ny;
    const cy = rz * nx - rx * nz;
    const cz = rx * ny - ry * nx;
    // a = invI ⊙ c ; k = dot(cross(a, r), n)
    const ax = this.invI.x * cx;
    const ay = this.invI.y * cy;
    const az = this.invI.z * cz;
    const kx = ay * rz - az * ry;
    const ky = az * rx - ax * rz;
    const kz = ax * ry - ay * rx;
    return this.invMass + angScale * (kx * nx + ky * ny + kz * nz);
  }

  /** Apply world impulse J at world offset rW (vW and body-frame angular momentum; ω refreshed). */
  private applyImpulse(Jx: number, Jy: number, Jz: number, rW: V3, angScale = 1): void {
    this.vW.x += Jx * this.invMass;
    this.vW.y += Jy * this.invMass;
    this.vW.z += Jz * this.invMass;
    // torque impulse world = cross(rW, J), to body frame
    const tx = rW.y * Jz - rW.z * Jy;
    const ty = rW.z * Jx - rW.x * Jz;
    const tz = rW.x * Jy - rW.y * Jx;
    const r = this.right;
    const u = this.up;
    const f = this.fwd;
    this.L.x += angScale * (r.x * tx + r.y * ty + r.z * tz);
    this.L.y += angScale * (u.x * tx + u.y * ty + u.z * tz);
    this.L.z += angScale * (f.x * tx + f.y * ty + f.z * tz);
    const mag = Math.hypot(Jx, Jy, Jz);
    if (mag > this.impact) this.impact = mag;
  }

  /** World velocity of the body point at world offset rW (current L, not the lagged ω). */
  private pointVel(out: V3, rW: V3): V3 {
    const wx = this.invI.x * this.L.x;
    const wy = this.invI.y * this.L.y;
    const wz = this.invI.z * this.L.z;
    // world ω
    const Wx = this.right.x * wx + this.up.x * wy + this.fwd.x * wz;
    const Wy = this.right.y * wx + this.up.y * wy + this.fwd.y * wz;
    const Wz = this.right.z * wx + this.up.z * wy + this.fwd.z * wz;
    out.x = this.vW.x + (Wy * rW.z - Wz * rW.y);
    out.y = this.vW.y + (Wz * rW.x - Wx * rW.z);
    out.z = this.vW.z + (Wx * rW.y - Wy * rW.x);
    return out;
  }

  /** §2.9 hull points vs ground (DEV-4 impulse model [D]). */
  private chassisCollision(): void {
    const nPts = this.nContacts < 3 ? 12 : 8;
    const world = this.world;
    let touched = false;
    let maxDepth = 0;
    let cnx = 0;
    let cny = 1;
    let cnz = 0;
    const rW = this.cRW;
    const vP = this.cVP;
    const n = this.cN;
    for (let k = 0; k < nPts && k < this.hull.length; k++) {
      this.toWorldTo(rW, this.hull[k]);
      const Px = this.pos.x + rW.x;
      const Py = this.pos.y + rW.y;
      const Pz = this.pos.z + rW.z;
      const h = world.heightAt(Px, Pz);
      if (!Number.isFinite(h) || Py >= h) continue;
      const nn = world.normalAt(Px, Pz);
      const nl = nn ? Math.hypot(nn.x, nn.y, nn.z) : 0;
      if (nl > 0 && Number.isFinite(nl)) setV(n, nn.x / nl, nn.y / nl, nn.z / nl);
      else setV(n, 0, 1, 0);
      const depth = (h - Py) * Math.max(0.05, n.y);
      if (depth <= 0) continue;
      touched = true;
      const mat = world.materialAt(Px, Pz);
      const sid = mat < MATERIAL_SOLID_MIN ? surfaceFromMaterial(mat) : null;
      const sd = sid ? this.surfaces[sid] : null;
      const bodyK = sd ? sd.bodyK : SOLID_BODY.bodyK;
      const eps = sd ? sd.epsilon : SOLID_BODY.epsilon;
      this.pointVel(vP, rW);
      const vn = vP.x * n.x + vP.y * n.y + vP.z * n.z;
      if (vn < 0) {
        const e = BODY_RESTITUTION_K * eps; // [G] restitution
        const jn = (-(1 + e) * vn) / this.effMassInv(rW, n);
        this.applyImpulse(n.x * jn, n.y * jn, n.z * jn, rW);
        this.damageFromImpulse(jn, rW);
        // Coulomb friction, mu_body = BODY_FRICTION_K·BodyK (spec guess 0.5 [G], tuned, see BODY_FRICTION_K)
        this.pointVel(vP, rW);
        const vn2 = vP.x * n.x + vP.y * n.y + vP.z * n.z;
        const vtx = vP.x - n.x * vn2;
        const vty = vP.y - n.y * vn2;
        const vtz = vP.z - n.z * vn2;
        const vtl = Math.hypot(vtx, vty, vtz);
        if (vtl > 1e-4) {
          const t = this.cT;
          setV(t, vtx / vtl, vty / vtl, vtz / vtl);
          const jt = Math.min(BODY_FRICTION_K * bodyK * jn, vtl / this.effMassInv(rW, t));
          this.applyImpulse(-t.x * jt, -t.y * jt, -t.z * jt, rW);
        }
      }
      if (depth > maxDepth) {
        maxDepth = depth;
        cnx = n.x;
        cny = n.y;
        cnz = n.z;
      }
    }
    this.bodyOnGround = touched;
    if (maxDepth > 0) {
      // positional correction, 50 %/step [G] (deepest point; avoids over-correcting with many points)
      const c = Math.min(maxDepth, 0.5) * 0.5;
      this.pos.x += cnx * c;
      this.pos.y += cny * c;
      this.pos.z += cnz * c;
    }
  }

  /** Vertical-cylinder obstacles (trees, rocks, posts) vs the hull footprint rectangle. [D] forgiving. */
  private obstacleCollision(): void {
    const p = this.params;
    const zf = p.hullFrontZ;
    const zr = p.hullRearZ;
    const reach = Math.max(Math.abs(zf), Math.abs(zr)) + HULL_HALF_WIDTH;
    const list = this.world.obstaclesNear(this.pos, reach + 0.5, this.obsBuf);
    if (!list || list.length === 0) return;
    this.obsBuf = list;
    // horizontal heading frame
    let fx = this.fwd.x;
    let fz = this.fwd.z;
    let fl = Math.hypot(fx, fz);
    if (fl < 1e-3) {
      // nose straight up/down: use the up axis projection instead
      fx = this.up.x;
      fz = this.up.z;
      fl = Math.hypot(fx, fz) || 1;
    }
    fx /= fl;
    fz /= fl;
    const rx = fz; // right = cross(up, fwd) = (fz, 0, -fx)
    const rz = -fx;
    const hw = HULL_HALF_WIDTH;
    const rW = this.cRW;
    const vP = this.cVP;
    const n = this.cN;
    for (const ob of list) {
      if (!(ob.radius > 0)) continue;
      // vertical overlap
      const top = ob.pos.y + (ob.height > 0 ? ob.height : 2);
      if (this.pos.y - 0.6 > top || this.pos.y + 1.2 < ob.pos.y) continue;
      const dx = ob.pos.x - this.pos.x;
      const dz = ob.pos.z - this.pos.z;
      const lx = dx * rx + dz * rz;
      const lz = dx * fx + dz * fz;
      const cx = clamp(lx, -hw, hw);
      const cz = clamp(lz, zr, zf);
      let ddx = cx - lx;
      let ddz = cz - lz;
      const d = Math.hypot(ddx, ddz);
      let depth: number;
      let nlx: number;
      let nlz: number;
      if (d > 1e-6) {
        if (d >= ob.radius) continue;
        depth = ob.radius - d;
        nlx = ddx / d;
        nlz = ddz / d;
      } else {
        // centre inside the footprint: push out along the shallowest axis
        const px = hw - Math.abs(lx);
        const pzF = zf - lz;
        const pzR = lz - zr;
        if (px <= Math.min(pzF, pzR)) {
          nlx = lx >= 0 ? -1 : 1;
          nlz = 0;
          depth = px + ob.radius;
        } else if (pzF < pzR) {
          nlx = 0;
          nlz = -1;
          depth = pzF + ob.radius;
        } else {
          nlx = 0;
          nlz = 1;
          depth = pzR + ob.radius;
        }
        ddx = ddz = 0;
      }
      // world normal (from obstacle toward the car), horizontal
      n.x = rx * nlx + fx * nlz;
      n.y = 0;
      n.z = rz * nlx + fz * nlz;
      // contact point at CG height (yaw only, never flips the car)
      rW.x = rx * cx + fx * cz;
      rW.y = 0;
      rW.z = rz * cx + fz * cz;
      this.pointVel(vP, rW);
      const vn = vP.x * n.x + vP.z * n.z;
      if (vn < 0) {
        const jn = (-(1 + OBSTACLE_RESTITUTION) * vn) / this.effMassInv(rW, n, OBSTACLE_ANGULAR);
        this.applyImpulse(n.x * jn, 0, n.z * jn, rW, OBSTACLE_ANGULAR);
        this.damageFromImpulse(jn, rW);
        this.pointVel(vP, rW);
        const vn2 = vP.x * n.x + vP.z * n.z;
        const vtx = vP.x - n.x * vn2;
        const vtz = vP.z - n.z * vn2;
        const vtl = Math.hypot(vtx, vtz);
        if (vtl > 1e-4) {
          const t = this.cT;
          setV(t, vtx / vtl, 0, vtz / vtl);
          const jt = Math.min(OBSTACLE_FRICTION * jn, vtl / this.effMassInv(rW, t, OBSTACLE_ANGULAR));
          this.applyImpulse(-t.x * jt, 0, -t.z * jt, rW, OBSTACLE_ANGULAR);
        }
      }
      const c = Math.min(depth, 1) * OBSTACLE_PUSH;
      this.pos.x += n.x * c;
      this.pos.z += n.z * c;
    }
  }

  /** §5.6 damage from a collision impulse (only when damage.physical). [D] mapping. */
  private damageFromImpulse(j: number, rW: V3): void {
    if (!this.params.damage.physical) return;
    const dv = j * this.invMass;
    if (dv < 3) return;
    const amt = (dv - 3) * 0.01;
    const lx = this.dotR(rW);
    const lz = this.dotF(rW);
    const front = lz >= 0;
    const left = lx < 0;
    const i = front ? (left ? 0 : 1) : left ? 3 : 2;
    const d = this.dmg;
    d.suspension[i] = Math.min(0.25, d.suspension[i] + amt);
    d.brakes[i] = Math.min(0.25, d.brakes[i] + amt * 0.5);
    if (front) {
      const s = i === 0 ? 0 : 1;
      d.steer[s] = clamp(d.steer[s] + (left ? 1 : -1) * amt * 0.05, -0.05, 0.05);
      d.engine = Math.min(0.25, d.engine + amt * 0.5);
    }
    if (dv > 12) d.gearbox = true;
    // brake capacity depends on damage
    const p = this.params;
    const f = p.brakeBalance * p.setup.brake;
    const base = p.brakeTorque * p.upgrade.brakes;
    this.W[i].brakeCap = base * (i < 2 ? f : 2 - f) * (1 - d.brakes[i]);
  }

  // =================================================================================== frame helpers

  private rebuildAxes(): void {
    const { w, x, y, z } = this.q;
    setV(this.right, 1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y));
    setV(this.up, 2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x));
    setV(this.fwd, 2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y));
  }

  private dotR(v: V3): number {
    return this.right.x * v.x + this.right.y * v.y + this.right.z * v.z;
  }
  private dotU(v: V3): number {
    return this.up.x * v.x + this.up.y * v.y + this.up.z * v.z;
  }
  private dotF(v: V3): number {
    return this.fwd.x * v.x + this.fwd.y * v.y + this.fwd.z * v.z;
  }

  private toLocalTo(out: V3, v: V3): V3 {
    const x = this.dotR(v);
    const y = this.dotU(v);
    const z = this.dotF(v);
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }

  private toWorldTo(out: V3, l: V3): V3 {
    const r = this.right;
    const u = this.up;
    const f = this.fwd;
    const x = r.x * l.x + u.x * l.y + f.x * l.z;
    const y = r.y * l.x + u.y * l.y + f.y * l.z;
    const z = r.z * l.x + u.z * l.y + f.z * l.z;
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }

  // =================================================================================== accelerations

  /** a = Δv over the last 2 steps (body frame), per the §2.6 low-speed note. */
  private updateAccel(dt: number): void {
    const h = this.vHist;
    // shift history: h[2] <- h[1] <- h[0] <- vW
    copyV(h[2], h[1]);
    copyV(h[1], h[0]);
    copyV(h[0], this.vW);
    if (this.vHistN < 3) this.vHistN++;
    if (this.vHistN < 3) {
      zero(this.aLocal);
      return;
    }
    const k = 1 / (2 * dt);
    const ax = (h[0].x - h[2].x) * k;
    const ay = (h[0].y - h[2].y) * k;
    const az = (h[0].z - h[2].z) * k;
    this.aLocal.x = this.right.x * ax + this.right.y * ay + this.right.z * az;
    this.aLocal.y = this.up.x * ax + this.up.y * ay + this.up.z * az;
    this.aLocal.z = this.fwd.x * ax + this.fwd.y * ay + this.fwd.z * az;
  }

  // =================================================================================== NaN guard

  private saveGood(): void {
    const s = this.snap;
    let k = 0;
    s[k++] = this.pos.x; s[k++] = this.pos.y; s[k++] = this.pos.z;
    s[k++] = this.q.w; s[k++] = this.q.x; s[k++] = this.q.y; s[k++] = this.q.z;
    s[k++] = this.vW.x; s[k++] = this.vW.y; s[k++] = this.vW.z;
    s[k++] = this.L.x; s[k++] = this.L.y; s[k++] = this.L.z;
    s[k++] = this.w.x; s[k++] = this.w.y; s[k++] = this.w.z;
    s[k++] = this.vL.x; s[k++] = this.vL.y; s[k++] = this.vL.z;
    s[k++] = this.loadMoment.x; s[k++] = this.loadMoment.z;
    s[k++] = this.airMul; s[k++] = this.rpm; s[k++] = this.boost; s[k++] = this.shiftTimer;
    s[k++] = this.thrRamp; s[k++] = this.flipTimer; s[k++] = this.speedKmh;
    k = 32;
    for (const w of this.W) {
      s[k++] = w.omega; s[k++] = w.tanA; s[k++] = w.ext; s[k++] = w.dampV; s[k++] = w.kappa;
      s[k++] = w.load; s[k++] = w.Fsusp; s[k++] = w.contactW.x; s[k++] = w.contactW.y; s[k++] = w.contactW.z;
      s[k++] = w.spin; s[k++] = w.mu; s[k++] = w.Fz; s[k++] = w.driveT;
    }
    for (let i = 0; i < 4; i++) this.snapModes[i] = this.W[i].mode;
    this.snapGear = this.gear;
    this.snapShiftDir = this.shiftDir;
  }

  private isSane(): boolean {
    const fin = Number.isFinite;
    const p = this.pos;
    const v = this.vW;
    const L = this.L;
    if (!(fin(p.x) && fin(p.y) && fin(p.z) && fin(this.q.w) && fin(this.q.x) && fin(this.q.y) && fin(this.q.z))) return false;
    if (!(fin(v.x) && fin(v.y) && fin(v.z) && fin(L.x) && fin(L.y) && fin(L.z) && fin(this.rpm) && fin(this.boost))) return false;
    if (Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD || Math.abs(p.z) > MAX_COORD) return false;
    if (v.x * v.x + v.y * v.y + v.z * v.z > MAX_SPEED * MAX_SPEED) return false;
    if (Math.abs(L.x * this.invI.x) > MAX_ANG || Math.abs(L.y * this.invI.y) > MAX_ANG || Math.abs(L.z * this.invI.z) > MAX_ANG) return false;
    for (const w of this.W) {
      if (!(fin(w.omega) && fin(w.tanA) && fin(w.ext) && fin(w.kappa) && fin(w.load) && fin(w.Fsusp) && fin(w.dampV))) return false;
      if (Math.abs(w.omega) > MAX_WHEEL_OMEGA) return false;
    }
    return true;
  }

  private restoreGood(): void {
    const s = this.snap;
    let k = 0;
    this.pos.x = s[k++]; this.pos.y = s[k++]; this.pos.z = s[k++];
    this.q.w = s[k++]; this.q.x = s[k++]; this.q.y = s[k++]; this.q.z = s[k++];
    k += 3 + 3 + 3 + 3; // velocities are zeroed below
    this.loadMoment.x = s[k++]; this.loadMoment.z = s[k++];
    this.airMul = s[k++]; this.rpm = s[k++]; this.boost = s[k++]; this.shiftTimer = s[k++];
    this.thrRamp = s[k++]; this.flipTimer = s[k++]; this.speedKmh = s[k++];
    k = 32;
    for (let i = 0; i < 4; i++) {
      const w = this.W[i];
      k++; // omega -> 0
      k++; // tanA -> 0
      w.ext = s[k++]; k++; // dampV -> 0
      k++; // kappa -> 0
      w.load = s[k++]; w.Fsusp = s[k++]; w.contactW.x = s[k++]; w.contactW.y = s[k++]; w.contactW.z = s[k++];
      w.spin = s[k++]; w.mu = s[k++]; w.Fz = s[k++]; w.driveT = s[k++];
      w.omega = 0;
      w.tanA = 0;
      w.dampV = 0;
      w.kappa = 0;
      w.mode = this.snapModes[i];
      if (!Number.isFinite(w.ext)) w.ext = 1;
      if (!Number.isFinite(w.load)) w.load = 0;
    }
    // sanitise the restored pose itself (in case the snapshot was already bad)
    if (!Number.isFinite(this.pos.x + this.pos.y + this.pos.z)) setV(this.pos, 0, 1, 0);
    const qn = qNormalize(this.q);
    if (!Number.isFinite(qn.w + qn.x + qn.y + qn.z)) {
      this.q.w = 1;
      this.q.x = this.q.y = this.q.z = 0;
    } else {
      this.q.w = qn.w;
      this.q.x = qn.x;
      this.q.y = qn.y;
      this.q.z = qn.z;
    }
    if (!Number.isFinite(this.rpm)) this.rpm = this.params.minRpm;
    if (!Number.isFinite(this.boost)) this.boost = this.params.turboIdle;
    this.gear = this.snapGear;
    this.shiftDir = this.snapShiftDir;
    zero(this.vW);
    zero(this.vL);
    zero(this.L);
    zero(this.w);
    zero(this.Fworld);
    this.rebuildAxes();
    this.vHistN = 0;
    this.faults++;
  }

  // =================================================================================== telemetry

  private buildTelemetry(): SimTelemetry {
    const p = this.params;
    const R = p.wheelRadius;
    const wheels = this.W.map((w, i): WheelTelemetry => {
      const wp = i < 2 ? p.wheel.front : p.wheel.rear;
      const ext = w.contact ? w.ext : 1;
      // wheel centre in the sim body frame: contact point (mount - SL·ext) + R up; visual uses mount x/z
      const cySim = w.mount.y - wp.springLength * ext + R;
      const cp = { x: fin(w.contactW.x), y: fin(w.contactW.y), z: fin(w.contactW.z) };
      return {
        slipAngle: fin(Math.atan(w.tanA)),
        kappa: fin(w.kappa),
        load: fin(w.contact ? w.Fz : 0),
        mode: w.mode,
        surface: w.contact ? w.surfId : null,
        material: w.contact ? w.material : -1,
        contact: w.contact,
        omega: fin(w.omega),
        Fsusp: fin(w.Fsusp),
        Fx: fin(w.Fx),
        Fy: fin(w.Fy),
        mu: fin(w.mu),
        driveT: fin(w.driveT),
        brakeT: fin(w.brakeT),
        contactPoint: cp,
        contactPointThree: { x: cp.x, y: cp.y, z: -cp.z },
        visual: {
          steerAngle: i < 2 ? fin(this.steerA[i]) : 0,
          spinAngle: fin(w.spin),
          suspensionOffset: w.contact ? fin(wp.springLength * (1 - w.ext)) : 0,
          centreLocal: { x: w.mount.x, y: fin(cySim), z: -w.mount.z },
        },
      };
    }) as Quad<WheelTelemetry>;
    const velLocal = { x: fin(this.dotR(this.vW)), y: fin(this.dotU(this.vW)), z: fin(this.dotF(this.vW)) };
    const turbo = p.turboSize !== 0;
    const boostFrac = turbo ? clamp((this.boost - p.turboIdle) / Math.max(1e-9, p.turboWasteGate - p.turboIdle), 0, 1) : 0;
    const q = this.q;
    return {
      id: this.id,
      archetype: p.archetype,
      stepCount: this.steps,
      simTime: this.steps * DT,
      resetCount: this.resets,
      speedKmh: fin(Math.abs(velLocal.z) * 3.6),
      speedWorldKmh: fin(len3(this.vW) * 3.6),
      rpm: fin(Math.max(0, Math.min(this.rpm, p.maxRpm))),
      rpmRedline: p.cutRpm,
      rpmMax: p.maxRpm,
      gear: this.gear,
      nGears: this.ratio.length - 1,
      shifting: this.shiftDir !== 0,
      boost: fin(this.boost),
      boostFrac: fin(boostFrac),
      transmission: p.transmission,
      tyreType: p.tyreType,
      throttle: fin(this.thr),
      brake: fin(this.brk),
      handbrake: fin(this.C.handbrake),
      steer: fin(clamp(this.C.steer, -1, 1)),
      steerAngle: fin(this.steerA[0]),
      beta: fin(this.beta),
      yawRate: fin(this.w.y),
      aLat: fin(this.aLocal.x),
      aLong: fin(this.aLocal.z),
      aVert: fin(this.aLocal.y),
      nContacts: this.nContacts,
      airborne: this.nContacts === 0,
      airMul: fin(this.airMul),
      bodyOnGround: this.bodyOnGround,
      yawCapActive: this.yawCap,
      yawRateCapActive: this.yawRateCap,
      parked: this.parked,
      impactImpulse: fin(this.impact),
      posSim: { x: fin(this.pos.x), y: fin(this.pos.y), z: fin(this.pos.z) },
      quatSim: { w: fin(q.w), x: fin(q.x), y: fin(q.y), z: fin(q.z) },
      velSim: { x: fin(this.vW.x), y: fin(this.vW.y), z: fin(this.vW.z) },
      velLocal,
      angVelLocal: { x: fin(this.w.x), y: fin(this.w.y), z: fin(this.w.z) },
      pos: { x: fin(this.pos.x), y: fin(this.pos.y), z: -fin(this.pos.z) },
      quat: { w: fin(q.w), x: -fin(q.x), y: -fin(q.y), z: fin(q.z) },
      vel: { x: fin(this.vW.x), y: fin(this.vW.y), z: -fin(this.vW.z) },
      wheels,
      simFaults: this.faults,
    };
  }
}

// ------------------------------------------------------------------------------------------- helpers

const TWO_PI = Math.PI * 2;
/** §2.5.5 sign tables and neighbour indices. */
const SX = [-1, 1, 1, -1];
const SZ = [1, 1, -1, -1];
const SAME_SIDE = [3, 2, 1, 0];
const SAME_AXLE = [1, 0, 3, 2];

function zero(v: V3): void {
  v.x = 0;
  v.y = 0;
  v.z = 0;
}
function setV(v: V3, x: number, y: number, z: number): void {
  v.x = x;
  v.y = y;
  v.z = z;
}
function copyV(o: V3, a: V3): void {
  o.x = a.x;
  o.y = a.y;
  o.z = a.z;
}
function len3(v: V3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
/** Finite or 0 (telemetry is JSON-safe even if a value went bad between guard checks). */
function fin(x: number): number {
  return Number.isFinite(x) ? x : 0;
}
