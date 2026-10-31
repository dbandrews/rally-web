/**
 * src/core/types.ts — ARCHITECT-OWNED CONTRACT. Builders: import, do not edit.
 * If a contract is missing something you need, report it (contract request); do not fork it.
 *
 * All shared types between the four builder modules (sim, world, render, game) and main.ts.
 * Normative mechanics: docs/MECHANICS_SPEC.md ("§" references below point there).
 *
 * SPACES (see src/core/space.ts, §1.1):
 *   - "sim"   = left-handed physics frame, x right, y up, z FORWARD. Field names ending in `Sim`, and every
 *               WorldQuery argument/result, are sim space. Car body frame: right +x, up +y, fwd +z.
 *   - "three" = Three.js world (right-handed, y up). Stage geometry and render poses are three space.
 *               Car object local frame in three: right +X, up +Y, forward -Z.
 *   - The mirror between them is M = diag(1, 1, -1).
 *
 * WHEEL ORDER everywhere (§1.1): 0 = front-left, 1 = front-right, 2 = rear-right, 3 = rear-left.
 */
import type { FieldEvent, FieldSnapshot, OtherCarFrame } from './field';
import type { GhostListEntry, GhostSelection } from './ghosts';
import type { V3 } from './math';
import type { SimQuat, SimV3, ThreeQuat, ThreeV3 } from './space';

export type { Quat, V3 } from './math';
export type { SimQuat, SimV3, ThreeQuat, ThreeV3 } from './space';

/** Recursive partial (for setParams / overrides). Arrays are replaced wholesale. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Four values in wheel order FL, FR, RR, RL (§1.1). */
export type Quad<T> = [T, T, T, T];

// =====================================================================================================
// Identifiers
// =====================================================================================================

/** The three archetype cars of §3.2 (ids are ours; display names in constants.ts ARCHETYPES). */
export type ArchetypeId = 'awd_wrc' | 'fwd_hatch' | 'rwd_classic';

/**
 * The 23 rally-web surfaces = ONE PER ORIGINAL MATERIAL (gcm face byte / PhysicsParam.con row 0..22, §4.3/§4.4).
 * The numeric MATERIAL id of a surface is its index in constants.ts SURFACE_IDS (0..22). WorldQuery hits carry
 * that material id. Material ids >= 32 are "solid but not ground" (walls, rocks, buildings): wheels treat them as
 * no contact (§2.5.1), the chassis collision may still use them. MATERIAL_NONE (255) = no material.
 *
 * NUMBERING TRAP: the rally-web material id is NOT the original byte (gcm 0 = GRASS, rally-web 0 = tarmac).
 * Convert with constants.ts materialFromOrig(byte) / origFromMaterial(id) (ORIG_MATERIAL_TO_MATERIAL), never by
 * passing the raw byte to surfaceFromMaterial / SURFACE_IDS.
 *
 * Indices 0..9 are the original ten (unchanged); 10..22 were appended (orig ids in brackets).
 */
export type SurfaceId =
  | 'tarmac' // 0  [1 ASPHALT]
  | 'gravel' // 1  [2 GRAVEL]
  | 'gravelDeep' // 2  [12 GRAVELDEEP]
  | 'mud' // 3  [4 MUD]
  | 'snow' // 4  [7 SNOW]
  | 'ice' // 5  [20 ICEASPHALT]
  | 'grass' // 6  [0 GRASS]
  | 'sand' // 7  [5 SAND]
  | 'cobbles' // 8  [13 COBBLES]
  | 'water' // 9  [3 WATERASPHALT]
  | 'wood' // 10 [6 WOOD]
  | 'snowChunky' // 11 [8 SNOWCHUNKY]
  | 'snowDeep' // 12 [9 SNOWDEEP]
  | 'snowAsphalt' // 13 [10 SNOWASPHALT, the exe's SNOWWET]
  | 'snowDitch' // 14 [11 SNOWDITCH]
  | 'leaf' // 15 [14 LEAF]
  | 'asphaltGrass' // 16 [15 ASPHALTGRASS]
  | 'gravelGrass' // 17 [16 GRAVELGRASS]
  | 'mudGrass' // 18 [17 MUDGRASS]
  | 'mudDitch' // 19 [18 MUDDITCH]
  | 'sandDeep' // 20 [19 SANDDEEP]
  | 'sandDark' // 21 [21 SANDDARK]
  | 'sandDarkDeep'; // 22 [22 SANDDARKDEEP]

/** Tyre type column of the tyre table (§4.1): 0 tarmac, 1 intermediate, 2 gravel, 3 snow, 4 ice. */
export type TyreType = 0 | 1 | 2 | 3 | 4;

export type Transmission = 'auto' | 'manual';

/** 0 = "FWD" (75 % front / 25 % rear!), 1 = "RWD" (37.5 % / 62.5 %), 2 = AWD (§2.3.4). */
export type WheelDrive = 0 | 1 | 2;

export type Discipline = 'rally' | 'hillclimb' | 'rallycross' | 'ice' | 'testpad';

/**
 * Camera views in cycle order (§5.3: entries 0, 1, 5, 6, 7, 8, 10, 12). `?cam=` accepts the index into
 * constants.ts CAMERA_MODES or the name. Look-back (entry 24) is a held modifier, not a mode.
 */
export type CameraMode =
  | 'bumper'
  | 'bonnet'
  | 'chaseNear'
  | 'chase'
  | 'chaseFar'
  | 'chaseHigh'
  | 'tetherHigh'
  | 'tetherLow';

// =====================================================================================================
// Car parameters (§3 shipped values + §6 tuning keys). One CarParams object per car.
// Body-frame positions are SIM body frame (x right, y up, z forward), metres.
// =====================================================================================================

/** Per-axle wheel parameters (§3.1 wheel table). `wheel.front` applies to wheels 0,1; `wheel.rear` to 2,3. */
export interface WheelParams {
  /** N/m, progressive spring (§2.5.3). Shipped 35000. */
  springK: number;
  /** N·s/m (§2.5.3). Shipped 5000. */
  dampK: number;
  /** m, ray length = full travel (§2.5.1, §2.5.3). Shipped 0.75. */
  springLength: number;
  /** Anti-roll gain (§2.7). Shipped F 14200 / R 15000. */
  rollStiffness: number;
  /** N·m per rad/s drivetrain drag on DRIVEN wheels (§2.3.6). Shipped 1.00596. */
  rollK: number;
  /** INVERSE spin inertia 1/(kg·m²) (§3.1, do not "fix"). Shipped 0.050027. */
  wheelInertia: number;
  /** Lateral load-transfer gain 1/m (§2.5.5). Shipped 0.060145. */
  momentXDist: number;
  /** Longitudinal load-transfer gain 1/m (§2.5.5). Shipped 0.080006. */
  momentZDist: number;
  /** Grip-mode steering yaw gain (§2.6 W13), front only. Shipped 2.2428. */
  twStaSteer: number;
  /** Slide-mode steering yaw gain (§2.6 W13), front only. Shipped 1.7045. */
  twKinSteer: number;
  /** Grip-mode yaw friction (§2.6 W13). Shipped 0.418. */
  twStaMy: number;
  /** rad per 2048 N, grip→slide threshold, "Agile" setup (§2.6 W11). Shipped F 0.12 / R 0.06. */
  staticSlipAngleFast: number;
  /** Same, "Stable" setup. Shipped F 0.08 / R 0.10. */
  staticSlipAngleSlow: number;
  /** m, kingpin (scrub) offset of the front contact point (§2.6 W3). Shipped 0.05. */
  steerTweak: number;
  /** 1/m slip-angle relaxation (§2.6 W7). Shipped 1.60723. */
  tireRelaxK: number;
  /** m, aligning moment scale (§2.6.1). Shipped 0.126552. */
  alignMomScale: number;
  /** Lateral curve rise gain / post-peak slope (§2.6.1). Shipped 5.00238 / 0.053606. */
  latPosK: number;
  latNegK: number;
  /** Longitudinal curve rise gain / post-peak slope (§2.6.1). Shipped 5.39649 / 0.176533. */
  longPosK: number;
  longNegK: number;
}

/** Deviation toggles of §0.3 (DEV-1, 3, 6, 7, 8, 9). DEV-2 withdrawn, DEV-4 n/a, DEV-5 is `damage.physical`. */
export interface AssistToggles {
  /** DEV-1: abs(beta) > 0.75 big-slip grip bonus (default TRUE; original: signed beta, right drifts only). */
  bigBetaSymmetric: boolean;
  /** DEV-3: smooth TWStaMy sign with 0.05 rad/s band (default false = original hard sign). */
  smoothYawFrictionSign: boolean;
  /** DEV-6: sleep pedal test uses throttleMinLimit/brakeMinLimit (default false = any non-zero pedal). */
  sleepPedalThreshold: boolean;
  /** DEV-7: hardSpring sleep threshold max(4500, 1.25 × static spring force) (default false = 4500 N). */
  heavyCarSleep: boolean;
  /** DEV-8: W18 side-fill gate ramp instead of hard gate (default false = original). */
  smoothSideFillGate: boolean;
  /**
   * DEV-9: the §1.2 settle (reset / stage start) suppresses sleep until its last steps and runs on (synchronously,
   * up to 2 s of sim time) until the body is at rest, so the car rests at its spring equilibrium instead of being
   * frozen 1-4 cm off it by the sleep rule (every launch then bobs). Default TRUE; false = original settle.
   * Optional in partial params; read as `!== false`.
   */
  settleToEquilibrium?: boolean;
}

/** §5.5 pre-race setup multipliers (+ setup.awdBaseSplit [G], §3.1). All default 1.0. */
export interface SetupParams {
  /** Brake balance option: 0.8 / 1.0 / 1.2 (front cap ×brakeBalance·brake, rear ×(2 - brakeBalance·brake)). */
  brake: number;
  /** AWD power ratio option: 0.8 / 1.0 / 1.2 (front factor fs = awdBaseSplit × powerRatio, §2.3.4). */
  powerRatio: number;
  /** Suspension option: 0.7 / 1.0 / 1.3 (multiplies SpringK and DampK, §2.5.3). */
  suspension: number;
  /** Gear ratio option m: 0.8 / 1.0 / 1.2 (R,1-4 × m; ≥5 × (2-m), §2.3.1). "Short" = 1.2 [D]. */
  gearRatio: number;
  /** AWD base split fs (1.0 = 50/50) [G]. Tuning panel "awdSplit fs". */
  awdBaseSplit: number;
}

/** §3.1 upgrade factors (no UI in the original; keep 1.0). */
export interface UpgradeParams {
  engine: number;
  weight: number;
  brakes: number;
  handling: number;
}

/**
 * Complete car parameter set. Every key of §3.1/§3.2 and every live key of §6 (except camera, input and
 * surface keys, which live in CameraTuning / InputFilterConfig / SurfaceTable, and timeScale/physicsHz,
 * which live in GameTunables.loop). Units are SI unless noted. Defaults: src/sim/params.ts.
 * Changing any key at runtime via ICarSim.setParams must rebuild derived values (brake caps, ratios,
 * shift speeds, inertia, frontShare2, load table) before the next substep (§6).
 */
export interface CarParams {
  archetype: ArchetypeId;

  // ---- Simulation (§6 "Simulation") ----
  /** m/s², car gravity (§2 GRAVITY = 12, NOT 9.81). */
  gravity: number;
  /** Air gravity multiplier growth per STEP (§2.10). 1.065. */
  airGravityGrowth: number;
  /** Air gravity multiplier cap (§2.10). 1.45. */
  airGravityMax: number;
  /** m/s² linear damping on every world axis in free flight (§2.10). 2.0. */
  airLinDamp: number;
  /** rad/s² angular damping on every body axis in free flight (§2.10). 1.0. */
  airAngDamp: number;

  // ---- Body (§3.1, §3.2, §3.4) ----
  /** kg (§3.2: 1230 / 960 / 1010). */
  mass: number;
  /** Per-kg inertia m² about (x pitch, y yaw, z roll): I = inertia ⊙ mass. (1.25, 1.45, 0.50). */
  inertia: V3;
  /** Downforce coeff kg/m along body up from forward speed² (§2.4). 1.25. */
  airKZY: number;
  /** Quadratic drag coeff kg/m per WORLD axis (§2.4). 2.0. */
  airKZZ: number;
  /** Front-left wheel CENTRE ("bundle") position, sim body frame (§3.2). FR mirrors x. mount = y - wheelRadius. */
  wheelFL: V3;
  /** Rear-left wheel centre, sim body frame. RR mirrors x. */
  wheelRL: V3;
  /** Hull box (§3.4): front / rear extent along z (m, front > 0 > rear), bottom y (-0.33). */
  hullFrontZ: number;
  hullRearZ: number;
  hullBottomY: number;
  /** Body ground share `nb` in tyre loads (§2.5.5, §8 #2) [G] 0. */
  bodyGroundShare: number;

  // ---- Engine (§2.3.2-§2.3.5, §6 "Engine") ----
  /** N·m per wheel at curve = 1 (§3.2: 935 / 930 / 1350). */
  torqueScale: number;
  /** Multiplies the curve. 1.0. */
  torqueScaleFactor: number;
  /** rpm: idle 1000, limiter 8250, display clamp 8750. */
  minRpm: number;
  cutRpm: number;
  maxRpm: number;
  /** rpm used only for auto-shift speeds (§2.2). 6500 / 6750. */
  maxTorqueRpm: number;
  maxTurboTorqueRpm: number;
  /** Low-rpm fill gain in gears R/1/2 (§2.3.2 `1e-4`). */
  lowGearFill: number;
  /** Launch torque bonus in R/1st (§2.3.2). true / 10. */
  useSpinTorque: boolean;
  spinTorqueScaleValue: number;
  /** 0 = no turbo. 1 for all archetypes. */
  turboSize: number;
  /** Boost range and per-step spool (§2.3.3). 0.1 / 100 / 1.0. */
  turboIdle: number;
  turboWasteGate: number;
  turboSpinup: number;
  /**
   * Throttle above which the turbo spools; at or below it boost decays at rate (T - thr)/T (§2.3.3). 0.5 [V: the
   * original's constant; exposed for tuning turbo lag after part throttle]. Optional in partial params.
   */
  turboSpoolThrottle?: number;
  /** Max turbo torque gain at the waste gate (§2.3.2 `0.75` → ×1.75). */
  turboMaxGain: number;
  /** Off-throttle engine braking T = (thr - thrMin)·((base - perGear·gear) + rpm)·gain (§2.3.4): 0.75 / 5000 / 700. */
  engineBrakeGain: number;
  engineBrakeBase: number;
  engineBrakePerGear: number;
  /** Throttle below this = engine-braking branch / coasting (§2.3.4). 0.1. */
  throttleMinLimit: number;
  /** Traction control (§2.3.4). false / 8. */
  useAntiSpin: boolean;
  antiSpinFactor: number;
  /** W17 spin-torque damping (shipped OFF). false / 1. */
  useSpinTorqueDamping: boolean;
  spinTorqueDampingValue: number;

  // ---- Gearbox (§2.2, §2.3.1, §6 "Gearbox") ----
  transmission: Transmission;
  /** 6 / 6 / 5. */
  nGears: number;
  /** Length nGears + 1. Index 0 = REVERSE (negative), 1..nGears forward (§3.2). */
  gearRatio: number[];
  /** Final drive (rpm only). 5.6. */
  finalDrive: number;
  /** m. 0.30. */
  wheelRadius: number;
  /** s. Manual shifts 0.10; R↔1 0.15 (×autoShiftTimeMul in auto). */
  timeChangeGear: number;
  timeChangeGearFR: number;
  /** Auto-box shift time multiplier (§2.2 `× 1.5`). */
  autoShiftTimeMul: number;
  /** 0.775 (§2.2). */
  downGearFactor: number;
  /** Auto coast downshift needs rpm below this (§2.2). 4000. */
  minRpmGearChange: number;
  /** Use explicit gearSpeed[] upshift speeds instead of computed ones (shipped false). */
  useGearSpeedValues: boolean;
  /** km/h, length nGears, only used if useGearSpeedValues. */
  gearSpeed: number[];

  // ---- Drivetrain (§2.3.4, §2.6 W1, §6 "Drivetrain") ----
  wheelDrive: WheelDrive;
  /** FWD front factor 1.5 (→ 75 % front). */
  fwdFrontBias: number;
  /** RWD rear factor 1.25 (→ 62.5 % rear). */
  rwdRearBias: number;
  /** LSD ratio clamp half-width: k = clamp(k, 1 - lsdClamp, 1 + lsdClamp). 0.5. */
  lsdClamp: number;
  /** W1 launch spin-up multiplier in R/1st (§2.6 W1) on/off and per-layout scales (1.0 = shipped). */
  launchAssist: boolean;
  launchScaleFront: number;
  launchScaleRear: number;
  launchScaleAwd: number;
  /** Selects DiffRollK weight in rolling resistance (§2.3.6). 0. */
  rollLevel: number;

  // ---- Brakes (§2.3.5, §2.3.6, §6 "Brakes") ----
  /** N·m per wheel before balance. 4000. */
  brakeTorque: number;
  /** Front factor 1.25 (→ 5000 / 3000 N·m per wheel). */
  brakeBalance: number;
  /** Pedal dead zone for brake and handbrake. 0.1. */
  brakeMinLimit: number;
  /** Below this pedal the service brake is half strength (§2.3.6). 0.75. */
  brakeHalfZone: number;
  /** N·m. 3500, ×hbFront (0.3) front, ×hbRear (1.3) rear. */
  handBrakeTorque: number;
  hbFront: number;
  hbRear: number;
  /** ABS releases a wheel at |kappa| ≥ absFactor (pedal ≥ brakeHalfZone only). true / 0.75. */
  useAbs: boolean;
  absFactor: number;
  /** Hill-hold / stall / park brake (§2.3.5). true / 4000. */
  useEngineBrakeConstant: boolean;
  engineBrakeConstant: number;
  /** W2 wheel lock: |ω| < lockOmega and brakeT > lockTorque → ω = 0. 1000 / 3.14. */
  lockTorque: number;
  lockOmega: number;

  // ---- Suspension extras (§2.5.3) ----
  /** Damper force cap N. 60000. */
  damperCap: number;
  /** Anti-pogo spring cap when leaving the ground fast (32000 - 5000·vn above 2 m/s). true. */
  antiPogo: boolean;

  // ---- Steering (§2.1, §6 "Steering & input") ----
  /** Max steer angle rad. 0.40. */
  wheelScale: number;
  /** Extra lock below this speed (km/h) at this gain (rad per km/h). 40 / 0.005. */
  lowSpeedLockKmh: number;
  lowSpeedLockGain: number;

  // ---- Tyres (§2.6, §4, §6 "Tyres") ----
  /** Tyre table column (§4.1). Setup option. */
  tyreType: TyreType;
  /** Setup "steering": true = StaticSlipAngleFast ("Agile", default), false = Slow ("Stable") (§5.5). */
  steerSensFast: boolean;
  /** Slip-ratio grip→slide threshold base (κ thr = base·(1 + s)). 0.075. */
  slipRatioThreshold: number;
  /** Rebuild LOAD_TABLE when Pos/Neg K change (§2.6.1). true. */
  rebuildLoadTable: boolean;
  /** Multiplies Palpha, Pkappa of the load table. 1.0. */
  loadTableScale: number;
  /** [D] global μ multiplier. 1.0. */
  muGlobalScale: number;

  // ---- Assists (§2.6-§2.8, §2.11, §6 "Assists") ----
  /** Yaw torque cap gain rad/s² (§2.8). 5.7039. */
  twMaxMom: number;
  /** Yaw rate cap base rad/s. 1.1242. */
  twMomLimStart: number;
  /** Yaw rate cap per rad of body slip. 1.5147. */
  twMomLimScale: number;
  /** Assist speed factor s = 0 below assistSpeedLo km/h, slope per km/h above (§2.5.0). 25 / 0.02. */
  assistSpeedLo: number;
  assistSpeedSlope: number;
  /** W10 drift grip bonus: above |β| driftGripBeta, μ ×(1 + |β|·thr·driftGripGain). 0.125 / 0.2. */
  driftGripBeta: number;
  driftGripGain: number;
  /** W10 big-angle bonus: above bigBetaThreshold, μ ×(1 + (|β| - thr)·bigBetaGain). 0.75 / 0.3. */
  bigBetaThreshold: number;
  bigBetaGain: number;
  /** W18 side fill: min(1, |β| + sideFillBase)·min(head, sideFillCap). 0.25 / 10000. */
  sideFillBase: number;
  sideFillCap: number;
  /** W16 drift drive boost gain. 0.5. */
  driftDriveBoost: number;
  /** Lateral ×sideFrictionFactor on DEEP surfaces (§2.6.1). true / 1.4. */
  useSideFriction: boolean;
  sideFrictionFactor: number;
  /** §2.7 body friction damping (deep-surface bogging, chassis sliding). true / 0.003125 / 0.05. */
  useBodyFrictionDamping: boolean;
  wheelContactFactor: number;
  bodyContactFactor: number;
  /** W15 sliding wheelspin limiter on/off. true. */
  wheelspinLimiter: boolean;
  /** W19 flip assist on/off. true. */
  flipAssist: boolean;

  // ---- Groups ----
  /** Per-axle wheel parameters. */
  wheel: { front: WheelParams; rear: WheelParams };
  /** Deviation toggles (§0.3). */
  assist: AssistToggles;
  /** DEV-5: physical damage (§5.6). Default false. */
  damage: { physical: boolean };
  /** §5.5 setup multipliers. */
  setup: SetupParams;
  /** §3.1 upgrades (keep 1.0). */
  upgrade: UpgradeParams;
}

// =====================================================================================================
// Surfaces (§4). Live-tunable table; the sim must read it every step (no stale caches without rebuild).
// =====================================================================================================

/** One tyre-table cell (§4.2): [BestStatic, DiffStatic, ScaleKinetic, BestRollK, DiffRollK]. */
export interface TyreRow {
  bestStatic: number;
  diffStatic: number;
  scaleKinetic: number;
  bestRollK: number;
  diffRollK: number;
}

/** One surface row (§4.3 + §4.4). μs = bestStatic + diffStatic·0.7·frictionLevel; μk = μs·scaleKinetic. */
export interface SurfaceDef {
  id: SurfaceId;
  /** Material id used by WorldQuery hits = index in SURFACE_IDS. */
  material: number;
  /** The original's material id = gcm face byte = PhysicsParam.con row (§4.3 "orig. id"); one surface per id,
   *  equal to constants.ts SURFACE_ORIG_ID[id] (origFromMaterial(material)). */
  origId: number;
  /** DEEP set membership: lateral ×sideFrictionFactor and bogging drag (§2.6.1, §2.7). */
  deep: boolean;
  bodyK: number;
  bodyKScale: number;
  /** m, suspension sink (§2.5.2). */
  maxDepth: number;
  epsilon: number;
  /** Wetness/iciness modifier (§4.2). */
  frictionLevel: number;
  /** m washboard amplitude, applied when bumpFlag = 1 (§2.5.2). */
  bump: number;
  bumpFlag: 0 | 1;
  /** Visual wheel bounce amplitude (§4.3, FUN_006c8ef0). */
  wheelJitterAmp: number;
  /** Bumper-cam shake contribution per wheel (§4.3, §5.3). */
  cameraRoughness: number;
  /** Indexed by TyreType 0..4. */
  tyre: [TyreRow, TyreRow, TyreRow, TyreRow, TyreRow];
}

export type SurfaceTable = Record<SurfaceId, SurfaceDef>;

// =====================================================================================================
// Input (§1.4, §5.1)
// =====================================================================================================

/** Physics controls written by the input filter each substep (§1.4). */
export interface Controls {
  /** -1..1, + = RIGHT. */
  steer: number;
  /** 0..1. */
  throttle: number;
  brake: number;
  handbrake: number;
  /** Edge-triggered (true for exactly ONE substep per press), manual box only. */
  gearUp: boolean;
  gearDown: boolean;
}

/** Steering device; selects the filter's dead zone / sqrtCurve preset (§5.1 device presets). */
export type InputDevice = 'keyboard' | 'gamepad' | 'wheel' | 'none';

/**
 * Device-level input, produced once per rendered frame by the input manager (src/input) or the test API.
 * The sim's InputFilter (§5.1) turns it into Controls once per substep.
 *
 * EDGE fields are true for one poll only; main.ts latches them until the first substep consumes them,
 * so a press is never lost on frames with zero physics steps.
 */
export interface RawInput {
  device: InputDevice;
  /** true: use left/right keys (§5.1 digital ramp); false: use the analog `steer` axis. */
  steerDigital: boolean;
  left: boolean;
  right: boolean;
  /** Analog steering axis -1..1, + = right (raw, before dead zone). */
  steer: number;
  /** true: throttle is a key/button (ramped, §5.1); false: analog pedal 0..1 (pedal dead zone). */
  throttleDigital: boolean;
  /** 0..1 (digital: > 0 = pressed). */
  throttle: number;
  brakeDigital: boolean;
  brake: number;
  handbrakeDigital: boolean;
  handbrake: number;
  /** EDGE: manual gear up / down (§5.1 A/Z). */
  gearUp: boolean;
  gearDown: boolean;
  /** LEVEL: reset button held (§5.4 manual reset fires on the rising edge, while running). */
  reset: boolean;
  /** EDGE: cycle camera (C). */
  cameraNext: boolean;
  /** LEVEL: look back while held (V; the original's Left Ctrl is not bound, see src/input/bindings.ts). */
  lookBack: boolean;
  /** EDGE: pause toggle (P). */
  pause: boolean;
}

/** §5.1 / §6 "Steering & input" filter configuration. Defaults: src/sim/inputFilter.ts. */
export interface InputFilterConfig {
  /** Digital ramps: first-substep value and rate per second (§5.1 table). */
  keySteerStart: number; // 0.05
  keySteerRate: number; // 2.0
  keyThrottleStart: number; // 0.10
  keyThrottleRate: number; // 2.0
  keyBrakeStart: number; // 0.20
  keyBrakeRate: number; // 1.5
  keyHandbrakeStart: number; // 0.50
  keyHandbrakeRate: number; // 1.0
  /** 1 = squared response, no rate limit (default); 0 = rate-limited. */
  steeringType: 0 | 1;
  /** sqrtCurve per analog device (§5.1): gamepad 1, wheel 0. */
  sqrtCurvePad: 0 | 1 | 2;
  sqrtCurveWheel: 0 | 1 | 2;
  /** Steering sensitivity (1.0). */
  steerSensitivity: number;
  /** Rescaled stick dead zones: gamepad 0.1, wheel 0. */
  padDeadzone: number;
  wheelDeadzone: number;
  /** [D] analog pedal dead zone 0.08 (§5.1; v1.1: 0.05). */
  pedalDeadzone: number;
}

/** RawInput → Controls filter (§5.1). Implemented by src/sim/inputFilter.ts `InputFilter`. */
export interface IInputFilter {
  readonly config: InputFilterConfig;
  setConfig(partial: Partial<InputFilterConfig>): void;
  /** Zero the ramp state (on reset / when control is taken away). */
  reset(): void;
  /** One substep (dt = 1/120). Returns the filter's Controls object (reused; valid until next update). */
  update(raw: Readonly<RawInput>, dt: number): Controls;
}

// =====================================================================================================
// World query (sim space). Implemented by src/world; used by src/sim every substep.
// =====================================================================================================

/**
 * A ray / segment hit (SIM space). `dist`, `normal`, `material`, `point` are always set. The optional fields
 * are always filled by `WorldQuery.segment` (every implementation) and by mesh worlds' `raycast`; a procedural
 * `raycast` may leave them out.
 */
export interface RayHit {
  /** Distance from origin along dir (m), 0 ≤ dist ≤ maxDist (segment(): dist = t·|raySim|). */
  dist: number;
  /** Unit surface normal at the hit, SIM space (mesh worlds: the stored flat face normal, gcm.md §3.1). */
  normal: SimV3;
  /** rally-web material id (SURFACE_IDS index, or ≥ 32 for non-ground solids, MATERIAL_NONE 255 = the
   *  original's −1; §2.5.1). Mesh worlds: materialFromOrig(origMaterial). */
  material: number;
  /** Hit point, SIM space. */
  point: SimV3;
  /** Segment parameter of the hit, 0..1 along the segment (raycast: dist / maxDist). */
  t?: number;
  /** dot(end − v0, n) ≤ 0, m: how far the segment END (origin + raySim) lies below the hit face's plane
   *  (the original's W+0xc0 / hull depth, gcm.md §3.4). */
  depth?: number;
  /** dot(n, raySim) with the UNnormalised ray (< 0 on a hit; the original's W+0xc4 = −SL·(n·up), gcm.md §3.5). */
  cos?: number;
  /** Raw original material byte 0..255 (gcm face byte; 255 = the original's −1). Procedural worlds:
   *  origFromMaterial(material). Hull contacts skip origMaterial 255 (gcm.md §3.6: "material ≠ −1"). */
  origMaterial?: number;
  /** Face index in the stage's collision mesh (debugging only; absent / −1 for procedural worlds). */
  face?: number;
}

/** Static obstacle approximated as a vertical cylinder (trees, rocks, posts, buildings). */
export interface Obstacle {
  kind: SceneryKind;
  /** Base centre on the ground, SIM space. */
  pos: SimV3;
  radius: number;
  height: number;
}

/** Result of ObjectCollider.segment (filled in place; valid until the next call with the same `out`). */
export interface ObjectSegmentHit {
  /** The hit face's normal mapped through the object transform (outward; NOT re-normalised when the object is
   *  scaled, exactly as the original returns it), SIM space. */
  normal: SimV3;
  /** Hit point, SIM space. */
  point: SimV3;
  /** dot(end − v0, n) in the mesh's LOCAL (unscaled) frame, ≤ 0: how far the segment end lies behind the face. */
  depth: number;
}

/**
 * A static object's own collision mesh (MESH worlds only: the object's CollisionMesh.Simple under its transform,
 * docs/orig/collision.md §4). The car collides with it like the original's object pass (FUN_004a7bc0 →
 * FUN_006d1a80): hull segments from the previous COM to each hull point, contacts into the body solver.
 */
export interface ObjectCollider {
  /** Placement index in Objects.con order. */
  readonly object: number;
  readonly kind: SceneryKind;
  /** ObjectTemplate.collisionMaterial (raw, −1 = none). */
  readonly material: number;
  /** The transform's translation (the object's origin), SIM space. */
  readonly origin: SimV3;
  /** Bounding sphere (centre SIM, radius m) of the scaled render box. */
  readonly pos: SimV3;
  readonly radius: number;
  /** The geometry is a TreeMesh (it answers the colour interface): the object pass tests it only while the car is
   *  within 0.2·radius + 1.5 of its ORIGIN (the trunk); otherwise (absent / false) while the bounding spheres
   *  overlap (docs/orig/collision.md §4.1). */
  readonly treeMesh?: boolean;
  /** Render box, local frame (unscaled), and the transform rows (local → SIM, row vectors v·m + origin, scale
   *  included): the box corners for the object pass's overlap test. */
  readonly boxMin: SimV3;
  readonly boxMax: SimV3;
  readonly m: ArrayLike<number>;
  /** The original's mesh query (0x597810): segment o → o + ray (SIM). Fills `out`; false on a miss. */
  segment(o: SimV3, ray: SimV3, out: ObjectSegmentHit): boolean;
}

/**
 * Physics view of a stage. ALL arguments and results are SIM space (sim z = -three z).
 * Must be fast: ~4 wheel rays + up to 12 hull rays per car per substep at 120 Hz.
 *
 * Two kinds of implementation:
 *   - PROCEDURAL worlds (src/world/ground.ts, the test worlds): a single-valued ground (road ribbon over the
 *     heightfield). `segment` goes through the shared adapter src/core/worldQuery.ts `segmentViaRaycast`.
 *   - MESH worlds (src/world/orig/**, the original Track.gcm collision mesh, research/formats/gcm.md):
 *     implement `segment` LITERALLY (gcm.md §3.2-3.4) and `raycast(o, dir, maxDist)` =
 *     `segment(o, dir·maxDist, -1)` with dist = t·maxDist (src/core/worldQuery.ts `raycastViaSegment`).
 *     An origin below the ground is a MISS there (the original misses; no dist-0 hit). Off the mesh nothing
 *     is hit (the car falls; the race's §5.4 "hand of god" reset catches it), while heightAt / normalAt /
 *     materialAt / surfaceAt fall back to the procedural terrain (never NaN).
 *
 * `yHint` (optional, sim y) on the point queries selects a level where the ground is multi-valued (bridges,
 * overpasses, overhangs): the HIGHEST ground at or below yHint + 1 m (GROUND_HINT_ABOVE_M), else the LOWEST
 * ground above it (src/core/worldQuery.ts `pickGroundY`). Without yHint: the highest ground (today's
 * behaviour). Procedural worlds are single-valued and may ignore it.
 */
export interface WorldQuery {
  /**
   * First intersection of the ray origin + t·dir with the drivable ground (terrain + road), t ∈ [0, maxDist].
   * `dir` is unit length. Returns null if nothing is hit within maxDist.
   * PROCEDURAL worlds: if the origin is already below the ground (e.g. a fully compressed wheel), returns
   * dist 0 with the ground normal at that point (legacy contract). MESH worlds: = segment(o, dir·maxDist, -1),
   * an origin below the ground is a miss (the original). Code that needs the original semantics calls segment().
   * `out` (optional): a RayHit (with its own normal / point objects) the hit is written into and returned, valid
   * until the next call with the same `out`; implementations may ignore it and return a fresh object, so callers
   * always use the RETURN value. Without `out` the result is a fresh object.
   */
  raycast(originSim: SimV3, dirSim: SimV3, maxDist: number, out?: RayHit): RayHit | null;
  /**
   * The original's collision query (gcm.md §3.2-3.4 + Verification): the SEGMENT originSim → originSim + raySim.
   *   - `raySim` is the full segment vector (NOT unit, not dir + length): wheels pass −springLength·bodyUp from
   *     the mount, hull points pass (hullPoint − previous-step COM) from that COM (gcm.md §3.5, §3.6).
   *   - ONE-SIDED: only front faces (dot(raySim, n) < 0); the start must lie STRICTLY above the face plane
   *     (d0 > 0) and the end on/below it (depth ≤ 0). Back faces, parallel rays and a start on/below the
   *     plane never hit.
   *   - The FIRST face in the original traversal order wins (cells along the ray, blocks in cell-list order,
   *     faces in sub-cell order, the slot's cached face first) — NOT the nearest. On cliffs / coplanar
   *     duplicates the two differ (gcm.md §3.4 "Which triangle wins").
   *   - `slot` selects the per-slot face cache: wheel rays `wheelIndex + 24·carIndex`, hull segments
   *     `8 + hullIndex + 24·carIndex` (src/core/worldQuery.ts wheelSlot / hullSlot; CarSimOptions.slotBase =
   *     24·carIndex); −1 / undefined = no cache; slots < 5000 (MAX_FACE_SLOTS).
   *   - The hit fills every RayHit field: dist = t·|raySim|, t, depth = dot(end − v0, n), cos = dot(n, raySim),
   *     origMaterial (raw byte), material = materialFromOrig(origMaterial), face. Returns null on a miss.
   * Mesh worlds implement it literally; procedural worlds return segmentViaRaycast(this, originSim, raySim, slot,
   * out) (src/core/worldQuery.ts: same fields, start below the ground → miss, slot ignored).
   *   - `out` (optional, the hot path: CarSim's 4 wheel + up to 12 hull segments per 120 Hz substep): a RayHit the
   *     hit is written into (every field, normal / point in place) and returned, valid until the next call with the
   *     same `out`. Implementations may ignore it and return a fresh object, so callers always use the RETURN value.
   *     Without `out` the result is a fresh object the caller may keep.
   */
  segment(originSim: SimV3, raySim: SimV3, slot?: number, out?: RayHit): RayHit | null;
  /** Ground height (sim y) at sim (x, z) (level per `yHint`, see above). Outside the stage / off the mesh: a
   *  sensible fallback (edge clamp / the procedural terrain), never NaN. */
  heightAt(xSim: number, zSim: number, yHint?: number): number;
  /** Unit ground normal (sim) at sim (x, z), of the same level as heightAt(x, z, yHint). */
  normalAt(xSim: number, zSim: number, yHint?: number): SimV3;
  /** Material id at sim (x, z) (road surface on the road, terrain material elsewhere), same level. */
  materialAt(xSim: number, zSim: number, yHint?: number): number;
  /** Surface id at sim (x, z), or null for non-ground materials, same level. */
  surfaceAt(xSim: number, zSim: number, yHint?: number): SurfaceId | null;
  /** Obstacles whose cylinder comes within `radius` of `posSim` (horizontal distance). May reuse `out`. */
  obstaclesNear(posSim: SimV3, radius: number, out?: Obstacle[]): Obstacle[];
  /**
   * Optional: SOFT objects (bushes: hasCollision without collision geometry; radius = the footprint's smallest half
   * extent, height = the box height) whose footprint comes within `radius` of `posSim` (horizontal, as
   * obstaclesNear). They never push the car; the sim reports a contact as CarTelemetry.collision.bush. Mesh worlds
   * (src/world/orig) implement it; procedural worlds have no soft objects.
   */
  softNear?(posSim: SimV3, radius: number, out?: Obstacle[]): Obstacle[];
  /**
   * Optional (MESH worlds with object meshes, RCOL v2): the static objects whose bounding sphere comes within
   * `radius` of `posSim` (3-D), each with its own collision mesh. When present the sim collides the car with these
   * meshes (the original's object pass) instead of the obstaclesNear cylinders, which then only serve as hints
   * (autopilot). May reuse `out`.
   */
  objectCollidersNear?(posSim: SimV3, radius: number, out?: ObjectCollider[]): ObjectCollider[];
}

// =====================================================================================================
// Car simulation (src/sim). One instance per car.
// =====================================================================================================

/** Rigid-body pose in SIM space: pos = body origin (centre of mass), q = body → world. */
export interface SimPose {
  pos: SimV3;
  q: SimQuat;
}

export interface CarSimOptions {
  /** Stable id, e.g. 'player'. Default 'player'. */
  id?: string;
  /** Full parameter set (ownership passes to the sim; use makeCarParams() to get a fresh copy). */
  params: CarParams;
  world: WorldQuery;
  /** Live surface table (shared object; tuning-panel edits mutate it in place). Default: a fresh copy. */
  surfaces?: SurfaceTable;
  /** Seed for the sim RNG (rpm wobble, §2.3.5; determinism T20). Default 1. */
  seed?: number;
  /**
   * Base of this car's face-cache slots for WorldQuery.segment = 24·carIndex (the original's car+0xa4·24;
   * player 0). Default 0. Wheel w uses slot slotBase + w, hull point i slot slotBase + 8 + i
   * (src/core/worldQuery.ts wheelSlot / hullSlot).
   */
  slotBase?: number;
  /**
   * Original car whose chassis hull the §2.9 probes use (its Car_<Name>.col, the first 12 points, src/sim/origHulls.ts):
   * an ORIG_CAR_IDS name (RaceSelection.car). Absent / null / unknown = the archetype's §3.4 box.
   */
  origCar?: string | null;
  /**
   * AI friction mode (MECHANICS_SPEC §4.2; research/formats/ai.md §10): the car is an AI opponent (the original's
   * RallyCar byte +0x17 = 1, phys+0xcc bit 0): the tarmac ASPHALT tyre rows on EVERY surface and
   * frictionLevel = min(FL, 0) (rows copied at 0x6c4978-0x6c49ac, the clamp at 0x6cb6cb). Default false (the player
   * and the ghost keep the real surface table). Implemented in src/sim/car.ts (region "AI friction (phase 2)"):
   * the car keeps a private copy of the surface table, so the player's table is never touched.
   */
  aiFriction?: boolean;
}

/** Per-wheel values for the renderer. */
export interface WheelVisual {
  /** Physics steer angle, rad, + = right (0 for rear wheels). Renderer: pivot.rotation.y = -steerAngle
   *  (and may rate-limit to 4 rad/s per §5.2). */
  steerAngle: number;
  /** Accumulated rolling angle, rad, + = rolling forward (integrated ω·dt). Renderer: rotation.x = -spinAngle. */
  spinAngle: number;
  /** Suspension compression from full droop, m: springLength·(1 - ext) (0 when airborne). */
  suspensionOffset: number;
  /** Wheel CENTRE in the THREE car-local frame (x right, y up, forward -Z), metres: place the wheel mesh here. */
  centreLocal: ThreeV3;
}

export interface WheelTelemetry {
  /** Relaxed slip angle, rad (atan(tanA), §2.6 W7). */
  slipAngle: number;
  /** Slip ratio (§2.6 W8). */
  kappa: number;
  /** Tyre normal load Fz used this step, N ≥ 0 (after slope factor, §2.6 W6). */
  load: number;
  /** 1 = GRIP (static μ), 2 = SLIDE (kinetic μ) (§2.6 W11). */
  mode: 1 | 2;
  /** Surface under the wheel, null if no contact. */
  surface: SurfaceId | null;
  /** Material id, -1 if no contact. */
  material: number;
  contact: boolean;
  /** Spin rad/s, + = rolling forward. */
  omega: number;
  /** Suspension force N along the contact normal (§2.5.3). */
  Fsusp: number;
  /** Tyre forces this step in the wheel frame, N: Fx longitudinal (+ forward), Fy lateral (+ right). */
  Fx: number;
  Fy: number;
  /** Friction coefficient used this step. */
  mu: number;
  /** Drive / brake torque this step, N·m. */
  driveT: number;
  brakeT: number;
  /** World contact point, SIM space (end of the wheel loop, §2.6 W20). */
  contactPoint: SimV3;
  /** Same point in THREE space (skid marks, dust). */
  contactPointThree: ThreeV3;
  visual: WheelVisual;
}

/**
 * The original's collision state of one car, as its CarSoundPlayer reads it (research/formats/sound.md §7;
 * FUN_00746c80 impacts, FUN_00746ec0 bush; verified on the exe, docs/orig/audio.md). Three sources, in the
 * reader's order:
 *   1. the OBJECT record (car record +0x30 flag / +0x34 type / +0x38 strength), written by the object pass
 *      FUN_004a7bc0 (0x4a81a3) when the car hits a static object's collision mesh: type = the object template's
 *      collisionMaterial RAW (shipped data: 6 = trees / wood, 1 = other hard objects; absent = −1, which plays
 *      nothing), strength = the body impulse − 100 (B+0x19c). The original's flag stays set until the sound reader
 *      clears it: rally-web counts the hits instead (`objectHits`), a consumer latches on a change.
 *   2. the BODY (hull-ground) contact (B+4 bit 0, type B+0x144 = the smallest raw material of the hull contacts,
 *      strength B+0x19c = jn − 100 when the §2.9 normal impulse jn > 100, else 0), read live.
 *   3. (car-car record +0x3c: no opponents in rally-web.)
 * The +100 types in the sound table (100..122) are not produced by any writer found in the exe.
 * `bush` mirrors record +0x28, set by the object pass (0x4a86b8) while the car centre lies within 2 m of a soft
 * object's origin and inside its box (hasCollision without a collision mesh, 0 < collisionElasticConstant < 1: the
 * bushes; the same pass sets the one-shot drag factor P+0x2c = collisionElasticConstant, MECHANICS_SPEC §2.7).
 */
export interface CollisionTelemetry {
  /** Hull-ground contact this step (= bodyOnGround; body flag bit 0). */
  hull: boolean;
  /** Raw original material byte of the latest hull contact (B+0x144; 0..22 ground, > 23 solids). 0 before any. */
  hullMaterial: number;
  /** B+0x19c of the latest body-solver run: jn − 100 N·s for a normal impulse jn > 100, else 0. */
  hullStrength: number;
  /** Object hits since the CarSim was constructed (every substep in which the object pass finds contacts with an object
   *  counts one per object, as the original sets the record each time; on worlds without object meshes every
   *  obstacle-cylinder impulse; a consumer latches on a change). */
  objectHits: number;
  /** Type (raw collisionMaterial, −1 = none) and strength (impulse − 100, ≥ 0) of the latest object hit. */
  objectType: number;
  objectStrength: number;
  /** Inside a bush this step (record +0x28). Mesh worlds with soft objects only (WorldQuery.softNear). */
  bush: boolean;
  /** PHASE 2 (car-car contact, dynamics.md §7): the car-car record +0x3c/+0x40. `carHits` counts the substeps in which
   *  FUN_006d4390 found a contact with another car (a consumer latches on a change, like `objectHits`); `carStrength`
   *  = this car's B+0x19c after the latest car-car contact (sound.md §7: type 1, threshold 5). Absent = never set
   *  (solo races). Written by src/sim/contact.ts (sim-contact builder); read by the audio mapper (ai-race builder). */
  carHits?: number;
  carStrength?: number;
}

/**
 * Backfire / blow-out flags of the latest car update (research/formats/sound.md §4.3: car +0x84 / +0x8c, set by
 * 0x753410 / 0x753550 from the car update FUN_0074fee0). ONE source per car (src/game/carFlags.ts, run once per
 * rendered frame by main.ts) feeds both the pipe sounds (FrameContext.carFlags) and the pipe flames
 * (CarRenderState.carFlags), so a bang and its flame fire on the same frame.
 */
export interface CarFlags {
  backfire: boolean;
  blowOut: boolean;
}

/**
 * Snapshot of one car after the latest physics step. ICarSim.telemetry() may return a reused object that
 * stays valid until the next step(); clone it (structuredClone) to keep it. Must be JSON-serialisable
 * (numbers, booleans, strings, null, arrays, plain objects only).
 *
 * NOTE (§2.6 low-speed notes): single-step lateral forces alternate at 10-45 km/h. aLat/aLong/aVert are
 * therefore derived from Δv over the last 2 steps; consumers (camera sway, audio) must not use a single
 * step's tyre force.
 */
export interface CarTelemetry {
  id: string;
  archetype: ArchetypeId;
  /** Physics steps run since construction (incl. settle steps) and sim time = steps·DT. */
  stepCount: number;
  simTime: number;
  /** Incremented by every reset(); main.ts snaps interpolation and the camera on change. */
  resetCount: number;

  // ---- speeds and drivetrain ----
  /** |vL.z|·3.6, forward component only (§1.4 CarState.speedKmh) — the HUD speed. */
  speedKmh: number;
  /** |vW|·3.6 (3-D world speed; what the auto box uses). */
  speedWorldKmh: number;
  /** Display rpm = min(rpm, maxRpm) (§5.2a). */
  rpm: number;
  /** Limiter rpm (cutRpm, HUD redline) and display clamp (maxRpm, gauge end). */
  rpmRedline: number;
  rpmMax: number;
  /** 0 = reverse, 1..nGears. No neutral (§1.4). */
  gear: number;
  nGears: number;
  /** A shift is in progress (clutch open). */
  shifting: boolean;
  /** Raw boost value (§2.3.3) and 0..1 fraction (boost - idle)/(wasteGate - idle); 0 without turbo. */
  boost: number;
  boostFrac: number;
  transmission: Transmission;
  /** Tyre type in use (§4.1). */
  tyreType: TyreType;

  // ---- effective controls this step (after the auto-reverse pedal swap, §2.1) ----
  throttle: number;
  brake: number;
  handbrake: number;
  /** Filtered steer -1..1 and resulting front steer angle (rad). */
  steer: number;
  steerAngle: number;

  // ---- dynamics ----
  /** Body slip angle rad (§2.5.0), + = velocity LEFT of heading. */
  beta: number;
  /** Body yaw rate ω.y, rad/s, + = nose RIGHT. */
  yawRate: number;
  /** Accelerations m/s² in the body frame from Δv over the last 2 steps: lateral (+ right), longitudinal
   *  (+ forward), vertical (+ up). §7 reports a_lat in g = 9.81 m/s². */
  aLat: number;
  aLong: number;
  aVert: number;
  /** Wheels in contact (§2.5.3). */
  nContacts: number;
  airborne: boolean;
  /** Air gravity multiplier (§2.10). */
  airMul: number;
  /** Any hull point touching (§2.9). */
  bodyOnGround: boolean;
  /** Yaw torque / yaw-rate caps active this step (§2.8; debug overlay). */
  yawCapActive: boolean;
  yawRateCapActive: boolean;
  /** Parked (pre-start hold) flag. */
  parked: boolean;
  /** Largest chassis/obstacle collision impulse this step, N·s (0 = none). For crash audio, camera
   *  shake and (optional) damage. Per physics STEP: per-frame consumers should read
   *  FrameContext.impactImpulseMax (max over the frame's substeps) so a crash on an intermediate substep
   *  is not missed. Resting chassis contact ≈ 200 N·s per step; real crashes are > 5000 N·s. */
  impactImpulse: number;
  /** The original's collision record of this car (impact / bush sounds, see CollisionTelemetry). */
  collision: CollisionTelemetry;
  /** NaN / explosion guard trips since the CarSim was constructed (state rolled back and velocities
   *  zeroed, §2 robustness). 0 normally. */
  simFaults: number;

  // ---- pose and velocity ----
  /** SIM space body origin, orientation, world velocity, body-frame velocity, body-frame angular velocity. */
  posSim: SimV3;
  quatSim: SimQuat;
  velSim: SimV3;
  velLocal: SimV3;
  angVelLocal: SimV3;
  /** RENDER POSE in THREE space (mirror of posSim/quatSim) at the latest step (not interpolated). */
  pos: ThreeV3;
  quat: ThreeQuat;
  /** THREE-space world velocity (camera / audio doppler). */
  vel: ThreeV3;

  /** Wheel order FL, FR, RR, RL. */
  wheels: Quad<WheelTelemetry>;
}

/**
 * The car simulation contract (§1, §2). Implemented by src/sim/car.ts `CarSim`
 * (constructor: `new CarSim(opts: CarSimOptions)`).
 */
export interface ICarSim {
  readonly id: string;
  readonly archetype: ArchetypeId;
  /** Live parameters. Treat as read-only; change through setParams(). */
  readonly params: Readonly<CarParams>;
  /**
   * Place the body origin at `pose` (sim space), zero linear/angular velocity and momentum, wheel spins,
   * slip states (modes → GRIP), suspension states; gear 1, rpm minRpm, boost turboIdle, airMul 1; then
   * run `settleSteps` (default 100, §1.2) physics steps with all inputs zero and handbrake 1.0.
   * Increments telemetry.resetCount.
   */
  reset(pose: SimPose, settleSteps?: number): void;
  /** One fixed physics step in §1.5 order. The game always passes dt = DT (1/120). No-op if dt == 0 or frozen. */
  step(controls: Readonly<Controls>, dt: number): void;
  /** Latest telemetry (may be a reused object, valid until the next step). */
  telemetry(): CarTelemetry;
  /** Current pose (fresh copy), sim space. */
  pose(): SimPose;
  /** Deep-merge a partial parameter set and rebuild derived values (§6). Arrays replace wholesale. */
  setParams(partial: DeepPartial<CarParams>): void;
  /** Replace the live surface table (the object may also be mutated in place between steps). */
  setSurfaces(table: SurfaceTable): void;
  /** Switch world (stage change without recreating the car). */
  setWorld(world: WorldQuery): void;
  /** Pre-start hold (§1.4 S.parked): clutch open, all wheels EngineBrakeConstant; sleep allowed. */
  setParked(parked: boolean): void;
  /**
   * Car-car contact (src/sim/contact.ts `stepCarContacts`): the live rigid-body view the contact solver reads and
   * writes (a `ContactBody`; typed `unknown` here because src/core must not import src/sim). A sim without it is
   * silently ignored by the contact step. CarSim implements it.
   */
  contactBody?(): unknown;
  /** Include / exclude this car from car-car contacts (the original's `collidable` flag; default true). */
  setCollidable?(on: boolean): void;
  /** Frozen cars skip step() entirely (§1.5). */
  setFrozen(frozen: boolean): void;
  /**
   * The original's post-finish track braking (phys+0x44, set by the player state machine FUN_004b3790 state 4 when
   * the race is over; MECHANICS_SPEC §2.7): a speed-proportional drag scaled by `factor` = the stage's
   * Physics.bodyBrakingFactorForTrack (Play.con: 0.4, hillclimb-3c-f 0.1). 0 switches it off; reset() clears it.
   * Optional: a car without it simply keeps rolling (the race controller calls it at the finish).
   */
  setTrackBraking?(factor: number): void;
}

// =====================================================================================================
// Stages (src/world). Stage geometry is THREE space; s = metres along the centre spline.
// =====================================================================================================

export interface Heightfield {
  /** THREE-space x / z of vertex (0, 0). Vertex (ix, iz) is at (originX + ix·cellSize, h, originZ + iz·cellSize). */
  originX: number;
  originZ: number;
  /** m between vertices. */
  cellSize: number;
  /** Vertex counts along x and z. */
  nx: number;
  nz: number;
  /** nx·nz heights (three y), row-major by z: index = iz·nx + ix. Includes the carved road bed. */
  heights: Float32Array;
  /** nx·nz material ids (SURFACE_IDS index; 255 = none), same indexing. Off-road terrain material
   *  (the road ribbon carries the road surface). */
  materials: Uint8Array;
}

/** Road ribbon sample, THREE space. Samples are ordered by s, spacing ≈ 1-4 m. */
export interface RoadSample {
  s: number;
  /** Centre point on the road surface. */
  pos: ThreeV3;
  /** Left / right edge points on the road surface (left/right relative to the travel direction). */
  left: ThreeV3;
  right: ThreeV3;
  /** Edge-to-edge width, m. */
  width: number;
  /** Bank angle rad, + = surface tilts down toward the RIGHT edge. */
  bank: number;
  surface: SurfaceId;
}

export type SceneryKind =
  | 'tree'
  | 'pine'
  | 'deadTree'
  | 'bush'
  | 'rock'
  | 'boulder'
  | 'cactus'
  | 'post'
  | 'marker'
  | 'sign'
  | 'barrier'
  | 'fence'
  | 'tyreStack'
  | 'hayBale'
  | 'cone'
  | 'snowbank'
  | 'spectator'
  | 'tent'
  | 'house'
  | 'barn'
  | 'banner'
  | 'startGate'
  | 'checkpointGate'
  | 'finishGate'
  | 'pole'
  | 'grandstand';

/**
 * One placed prop (THREE space). ORIENTATION CONVENTIONS (shared by src/world placement and
 * src/render/sceneryModels.ts; keep them in sync):
 *   - A model's FRONT is its local -Z (signs, boards, spectators, houses, gates face -Z).
 *   - Linear props (fence, barrier, banner, snowbank, grandstand) are LONG along local X; the world
 *     places them with X along the road and the front (-Z) toward the road.
 *   - 'marker' is a chevron board whose arrows point along local +X (the world rotates +X into the bend);
 *     'post' is a plain route marker post.
 *   - Gates (startGate / checkpointGate / finishGate) sit on the centre line with radius 0, spanning
 *     the road along local X.
 *   - `height` is the visual height; every instance with radius > 0 is also returned by
 *     WorldQuery.obstaclesNear (sim space) and stands ≥ 3 m beyond the road edge.
 */
export interface SceneryInstance {
  kind: SceneryKind;
  /** Base position on the ground, THREE space. */
  pos: ThreeV3;
  /** THREE rotation.y (rad). */
  rotY: number;
  /** Uniform scale (1 = nominal size for the kind). */
  scale: number;
  /** Collision cylinder radius m (0 = no collision) and height m. */
  radius: number;
  height: number;
}

export type PacenoteDirection = 'left' | 'right' | 'straight';
export type PacenoteModifier =
  | 'long'
  | 'short'
  | 'tightens'
  | 'opens'
  | 'into'
  | 'dontCut'
  | 'cut'
  | 'crest'
  | 'jump'
  | 'bump'
  | 'caution'
  | 'narrows'
  | 'bridge'
  | 'water'
  | 'surfaceChange'
  | 'overFinish';

export interface Pacenote {
  /** Trigger distance: fires once when the player's s passes it (§5.7). */
  s: number;
  /** Where the described feature begins. */
  cornerS: number;
  /** Rendered call, e.g. "4 right long", "crest", "2 left tightens into 3 right". Our own vocabulary. */
  text: string;
  direction: PacenoteDirection;
  /** 1..6, 6 = fastest/easiest bend, 1 = hairpin; 0 = not a bend (straight / hazard-only note). */
  severity: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  modifiers: PacenoteModifier[];
  /**
   * The original co-driver word ids of this note in playback order (research/formats/sound.md §10: stage
   * `Pacenotes.con` `race.addPaceNote <kind> w1 … w8 <distance>`, −1 entries dropped; ids 1..41 → the
   * `Sound_PaceNotes.con` samples). Present only when the note comes from the original data. The audio
   * builder plays these samples and falls back to the synthesized voice on `text` when absent / unloaded.
   */
  origWords?: number[];
}

/** Lighting / atmosphere preset (THREE space directions; colours 0xRRGGBB). */
export interface EnvironmentPreset {
  name: string;
  /** Hours 0..24. */
  timeOfDay: number;
  skyTop: number;
  skyHorizon: number;
  fogColor: number;
  /** Linear fog range, m. */
  fogNear: number;
  fogFar: number;
  sunColor: number;
  sunIntensity: number;
  /** Unit vector pointing TOWARD the sun, three space. */
  sunDir: ThreeV3;
  /** Hemisphere light sky / ground colours and intensity. */
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
  weather: 'clear' | 'overcast' | 'dust' | 'snow' | 'rain';
  /** Tone-mapping exposure (1 = neutral). */
  exposure: number;
  /** Optional per-stage ground / vegetation colours (0xRRGGBB). Renderers fall back to SURFACE_INFO
   *  colours for anything missing. */
  palette?: EnvironmentPalette;
}

/** Per-stage colour palette (EnvironmentPreset.palette). */
export interface EnvironmentPalette {
  /** Ground colour per surface (terrain vertex colours). */
  ground: Partial<Record<SurfaceId, number>>;
  rock: number;
  foliage: number;
  foliageDry: number;
  trunk: number;
  /** 0..1 snow dusting on rocks / foliage. */
  snowCover: number;
  /** Distant-terrain / horizon tint. */
  horizon: number;
}

/** A floating text label placed in the stage (THREE space), e.g. test-pad patch names on sign boards. */
export interface StageLabel {
  text: string;
  /** Centre of the text, THREE space (already at display height). */
  pos: ThreeV3;
  /** THREE rotation.y; the text reads on the label's local -Z (front) side. */
  rotY: number;
}

/** Pose on the stage, THREE space. `pos` is ON the road surface (spawn code raises the body above it). */
export interface StagePose {
  pos: ThreeV3;
  /** Unit travel direction (may include gradient). */
  dir: ThreeV3;
}

export interface StageProjection {
  /** Arc length of the closest centre-line point (wrapped to [0, length) when closed). */
  s: number;
  /** Signed horizontal offset from the centre line, m, + = RIGHT of the travel direction
   *  (right = cross(tangent, up) in three space). */
  lateral: number;
  /** pos.y - centre.y at s (negative = below the road), m. */
  heightOffset: number;
  /** Centre-line point at s. */
  point: ThreeV3;
}

export interface Stage {
  readonly id: string;
  readonly name: string;
  readonly discipline: Discipline;
  readonly description: string;
  /** Seed used to build it (deterministic). */
  readonly seed: number;
  /** Lap circuit (rallycross / ice) vs point-to-point. */
  readonly closed: boolean;
  /** Laps to race (1 for point-to-point). */
  readonly laps: number;
  /** Centre-spline length, m (one lap when closed). */
  readonly length: number;
  /** Recommended tyre (§4.1 stage defaults). */
  readonly defaultTyre: TyreType;

  // ---- centre spline API (THREE space). s is clamped to [0, length] (wrapped when closed). ----
  pointAt(s: number): ThreeV3;
  /** Unit travel direction at s. */
  tangentAt(s: number): ThreeV3;
  /** Interpolated road cross-section at s. */
  roadAt(s: number): RoadSample;
  /** Closest centre-line point to `posThree`. `hintS` (last known s) makes it fast and avoids jumping
   *  between nearby road sections: search locally around it when given (race controller, per substep).
   *  Without a hint: global search (exact but slower; used for scenery checks and teleports). */
  project(posThree: ThreeV3, hintS?: number): StageProjection;

  /** Start line s and the spawn pose (car placed here at race start). */
  readonly startS: number;
  readonly startPose: StagePose;
  /** Intermediate timed checkpoints (s, increasing; within one lap when closed), finish NOT included. */
  readonly checkpoints: number[];
  /** Finish line s (closed: the lap line, usually = startS). */
  readonly finishS: number;
  /** §5.4 auto-reset: s outside [min, max] counts as off-stage (point-to-point; closed: [0, length]). The minimum
   *  may lie past startS (a ported archive's splineRange verbatim) as long as the spawn pose is inside the range. */
  readonly validRange: [number, number];

  readonly environment: EnvironmentPreset;
  readonly heightfield: Heightfield;
  readonly road: RoadSample[];
  readonly scenery: SceneryInstance[];
  /** Sorted by s. Empty for rallycross / ice (§a.4: no pacenotes there). */
  readonly pacenotes: Pacenote[];
  /** Optional text labels (test-pad patch names). */
  readonly labels?: readonly StageLabel[];
}

/** Result of src/world/stages.ts buildStage(). `world` answers physics queries for `stage` (sim space). */
export interface BuiltStage {
  stage: Stage;
  world: WorldQuery;
}

export interface StageListEntry {
  id: string;
  name: string;
  discipline: Discipline;
  description: string;
  defaultTyre: TyreType;
  /** Approximate TIMED length in m: start line to finish, or one lap when closed (the HUD shows the same). */
  approxLength: number;
  closed: boolean;
  laps: number;
}

// =====================================================================================================
// Race (src/game)
// =====================================================================================================

export type RacePhase = 'idle' | 'intro' | 'countdown' | 'running' | 'finished';

export type ResetReason = 'manual' | 'offTrack' | 'belowTrack' | 'outOfRange' | 'stuck' | 'api' | 'restart';

export interface RaceState {
  phase: RacePhase;
  stageId: string;
  discipline: Discipline;
  /** Race clock s since GO (frozen at finish). Sim time: advances only in fixedUpdate. */
  time: number;
  /** Seconds left in the countdown (3 → 0) while phase = 'countdown'. */
  countdown: number;
  /** Player's projected spline distance (m) and lateral offset (m, + right). */
  s: number;
  lateral: number;
  /** Overall progress 0..1 (all laps). */
  progress: number;
  /** Current lap (1-based) / total laps. */
  lap: number;
  laps: number;
  /** Index of the next checkpoint to cross (0-based over stage.checkpoints, then finish). */
  nextCheckpoint: number;
  checkpointsTotal: number;
  /** Race time at each checkpoint passed this run (and each lap line for closed stages). NaN = a gate skipped
   *  by a debug teleport (no time). */
  splits: number[];
  /** Best previous run on this stage (session or localStorage), or null. */
  bestTime: number | null;
  bestSplits: number[] | null;
  finishTime: number | null;
  /** Inputs reach the car (false during intro/countdown/finished and during a reset fade). */
  controllable: boolean;
  wrongWay: boolean;
  /** §5.4 reset sequence state. fade = 0..1 black overlay opacity. */
  resetting: boolean;
  fade: number;
  resets: number;
  /** Most recent pacenotes to display (≤ 3, newest first, §5.7). */
  pacenotes: Pacenote[];
  topSpeedKmh: number;
  /** Big centre message ("3", "2", "1", "GO!", "FINISH", "WRONG WAY") or null. */
  message: string | null;
  /** The run no longer counts (a debug teleport happened): no best time / ghost; splits it jumped over are NaN. */
  untimed?: boolean;
}

export type RaceEvent =
  | { type: 'countdown'; n: number }
  | { type: 'go' }
  | { type: 'checkpoint'; index: number; time: number; delta: number | null }
  | { type: 'lap'; lap: number; time: number; lapTime: number }
  | { type: 'finish'; time: number; best: boolean }
  | { type: 'reset'; reason: ResetReason }
  | { type: 'pacenote'; note: Pacenote }
  | { type: 'wrongWay'; on: boolean };

/** Options of IRaceController.begin. */
export interface RaceBeginOptions {
  countdown: boolean;
  world?: WorldQuery;
  origCar?: string;
  /** PHASE 2: the player's grid slot (0) and the number of cars on the grid (player + AI; 1 = solo, the default).
   *  With gridCount 1 the car stands on the spawn grid's centre line exactly as before (src/game/grid.ts). */
  gridIndex?: number;
  gridCount?: number;
  /** PHASE 2: which ghost to race against (RaceSelection.ghost; absent = the stored best run, as before). */
  ghost?: GhostSelection;
}

/**
 * Race controller (src/game/race.ts `RaceController`, constructor `new RaceController()`).
 * Owns phases, clock, checkpoints/laps/finish, §5.4 resets (manual + auto "hand of god"), §5.7 pacenote
 * triggering, best times. All timing runs in fixedUpdate (sim time) so pause / timeScale / test stepping
 * apply uniformly.
 */
export interface IRaceController {
  readonly state: RaceState;
  /** Bind a freshly built stage and car; place the car at the start (car.reset with settle), set parked.
   *  countdown=true → 'intro'/'countdown' then 'running'; false → stays 'idle' until startNow().
   *  `world` (optional, the stage's WorldQuery): spawn / reset heights use world.heightAt when given.
   *  `origCar` (optional, RaceSelection.car): best times / the ghost are keyed by it when present (else by the
   *  archetype), and the ghost's CarRenderState carries it. */
  begin(stage: Stage, car: ICarSim, opts: RaceBeginOptions): void;
  /** Skip menu/intro/countdown: phase → 'running' now, clock 0, car unparked. */
  startNow(): void;
  /** Whether player inputs should reach the car this substep (§5.1 "not controllable" otherwise). */
  isControllable(): boolean;
  /** Once per physics substep, after car.step(). */
  fixedUpdate(dt: number, tel: Readonly<CarTelemetry>): void;
  /** Once per rendered frame (presentation-only timers; must not advance race logic). */
  frameUpdate(frameDt: number, tel: Readonly<CarTelemetry>): void;
  /** Start the §5.4 reset sequence (manual: only while running). 'api' resets immediately (no fade). */
  requestReset(reason: ResetReason): void;
  /** Place the car at spline distance s with a lateral offset (m, + right), heading along the spline,
   *  raised per §5.4, with settle steps. Updates s tracking. */
  teleport(s: number, lateral: number): void;
  /** Events since the last call (main.ts drains once per frame and forwards them in FrameContext). */
  drainEvents(): RaceEvent[];
}

/** Autopilot (src/game/autopilot.ts `Autopilot`, `new Autopilot()`): drives the car along the stage. */
export interface IAutopilot {
  /** 0.3..1.2 target-speed scale (1 = brisk but safe). */
  aggression: number;
  reset(): void;
  /** Once per substep. Returns physics Controls directly (bypasses the input filter, like the §7 bots). */
  update(dt: number, tel: Readonly<CarTelemetry>, stage: Stage, race: Readonly<RaceState>): Controls;
}

/** Input devices (src/input/input.ts `InputManager`, `new InputManager(target: Window)`). */
export interface IInputManager {
  /** Once per rendered frame: merged keyboard + gamepad state (§5.1 default bindings). */
  poll(): RawInput;
  /** Which device was used last ('keyboard' | 'gamepad' | ...). */
  readonly activeDevice: InputDevice;
  dispose(): void;
}

// =====================================================================================================
// Rendering (src/render) and audio (src/audio)
// =====================================================================================================

/** Chase camera table entry (§5.3), positions in the ORIGINAL car frame (sim body frame, z forward). */
export interface ChaseCamEntry {
  posA: V3;
  posB: V3;
  p0: number;
  p1: number;
}

/** Tether camera entry (§5.3 entries 10/12; field meaning [I]). */
export interface TetherCamEntry {
  p0: number;
  p1: number;
  /** (min, target, max) distances as listed in §5.3 `d`. */
  d: V3;
}

/** Live camera tuning (§5.3, §6 "Camera"). Owned by the renderer; defaults in src/render. */
export interface CameraTuning {
  /** Vertical FOV, degrees. 70 (fixed; no speed FOV). */
  fov: number;
  chase: { chaseNear: ChaseCamEntry; chase: ChaseCamEntry; chaseFar: ChaseCamEntry; chaseHigh: ChaseCamEntry };
  /** Per-60-Hz-frame lerp factors (§5.3), converted with kdt = 1 - (1 - k)^(60·frameDt). */
  chaseHorizLerp: number; // 0.04
  chaseVertLerp: number; // 0.42
  chaseBlendRate: number; // 0.025 per frame
  chaseLookAtHeight: number; // 1.5
  /** Rigid camera positions in the ORIGINAL car frame. */
  bumperPos: V3; // (0, 0.45, 1.40)
  bonnetPos: V3; // (0, 0.65, 0.90)
  lookBackPos: V3; // (0, 0.4, -1.5)
  bumperPitch: number; // 0.1 rad
  bumperShakeGain: number; // 2.4615e-5
  tether: { tetherHigh: TetherCamEntry; tetherLow: TetherCamEntry };
}

export interface AddCarOptions {
  /** Semi-transparent ghost car (no shadows/effects). */
  ghost?: boolean;
  /** The car the camera follows (exactly one). Default true for the first car added. */
  player?: boolean;
  /** Livery index (original liveries). */
  livery?: number;
  /** Original car name (RaceSelection.car, = `manifest.cars` key / `cars/<Name>` folder, e.g. 'AudiS1'):
   *  the renderer shows that car's original mesh + livery (loadOriginalCar); the procedural archetype visual
   *  is hidden while it loads and shows only when absent / not built / failed. The player car also brings its
   *  own camera positions (Templates.con <Car>CarCamera, MECHANICS_SPEC §5.3). */
  origCar?: string;
  /** PHASE 2: an AI opponent (src/core/field.ts): rendered at the original's `othercarlodlevel` (ai.md §9), never
   *  the camera target, with wheel effects. Not a ghost. */
  ai?: boolean;
  /** PHASE 2: the car's grid index (the player 0; render slots 24·carIndex + wheel, ai.md §9). */
  carIndex?: number;
}

/**
 * Per-car state handed to the renderer each frame by main.ts.
 * pos/quat are ALREADY interpolated between the previous and current physics step (§1.2 [D]).
 */
export interface CarRenderState {
  id: string;
  archetype: ArchetypeId;
  /** Original car name of this car (same value as AddCarOptions.origCar), absent = archetype car. */
  origCar?: string;
  ghost: boolean;
  player: boolean;
  /** PHASE 2: an AI opponent (AddCarOptions.ai). Absent = false. */
  ai?: boolean;
  /** PHASE 2: grid index (AddCarOptions.carIndex). */
  carIndex?: number;
  /** Interpolated THREE-space body origin and orientation. */
  pos: ThreeV3;
  quat: ThreeQuat;
  /** Latest-step telemetry (wheels, slip, surface, speeds) for wheels, effects and camera inputs. */
  telemetry: Readonly<CarTelemetry>;
  /** True on the first frame after a reset/teleport (camera snaps behind the car, §5.3 justReset). */
  justReset: boolean;
  /** This frame's backfire / blow-out flags of the car (the shared source, CarFlags; absent = the effects derive
   *  their own, e.g. the ghost). */
  carFlags?: Readonly<CarFlags>;
}

export interface RenderStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  frame: number;
}

/**
 * Renderer (src/render/renderer.ts `GameRenderer`, constructor `new GameRenderer(container: HTMLElement)`).
 * Owns the Three.js scene, the camera rig (§5.3), car meshes, terrain/road/scenery meshes, sky, effects.
 */
export interface IGameRenderer {
  readonly domElement: HTMLCanvasElement;
  /** Live camera tuning (mutable object; also via setCameraTuning). */
  readonly cameraTuning: CameraTuning;
  /** Build all stage meshes (replaces the previous stage). */
  loadStage(stage: Stage): void | Promise<void>;
  /** Add a car; a promise settles (never rejects) once its final visual is in place (the original car loaded, or
   *  the procedural fallback decided). main.ts awaits it with the stage load: no stand-in is ever shown. */
  addCar(id: string, archetype: ArchetypeId, opts?: AddCarOptions): void | Promise<void>;
  removeCar(id: string): void;
  /** PHASE 2: force a car's model LOD level (othercarlodlevel / playercarlodlevel, ai.md §9); null = renderer's choice. */
  setCarLod?(id: string, level: number | null): void;
  /** Render one frame. `alpha` = physics interpolation fraction (cars are already interpolated). */
  update(frameDt: number, alpha: number, cars: readonly CarRenderState[]): void;
  setCameraMode(mode: CameraMode): void;
  /** Cycle to the next mode (§5.3 order) and return it. */
  nextCamera(): CameraMode;
  getCameraMode(): CameraMode;
  /** Hold-to-look-back (§5.3 entry 24). */
  lookBack(on: boolean): void;
  setCameraTuning(partial: DeepPartial<CameraTuning>): void;
  /** Re-read the container size (also hooked to window resize internally). */
  resize(): void;
  stats(): RenderStats;
  dispose(): void;
}

/** Engine / surface / effects audio (src/audio/audio.ts `AudioEngine`, `new AudioEngine()`). Optional polish. */
export interface IAudioEngine {
  /** Must be called from a user gesture before sound can play (browser autoplay rules). */
  resume(): void;
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  /** Once per frame. */
  update(ctx: Readonly<FrameContext>): void;
  dispose(): void;
}

// =====================================================================================================
// UI (src/ui) and debug tools (src/debug)
// =====================================================================================================

/** Everything the per-frame UI needs; built by main.ts once per rendered frame. */
export interface FrameContext {
  /** Real frame time (clamped 0.2 s) and physics interpolation alpha. */
  frameDt: number;
  alpha: number;
  /** Physics steps run this frame. */
  steps: number;
  paused: boolean;
  timeScale: number;
  telemetry: Readonly<CarTelemetry>;
  race: Readonly<RaceState>;
  /** Race events since the previous frame. */
  events: readonly RaceEvent[];
  stage: Stage;
  cameraMode: CameraMode;
  autopilot: boolean;
  /** Smoothed render fps. */
  fps: number;
  /** Largest telemetry.impactImpulse over the physics substeps run since the previous frame (N·s). */
  impactImpulseMax: number;
  /** Audio on/off (M key / menu). */
  audioEnabled: boolean;
  /** Original car name of the player car (RaceSelection.car; absent = archetype car): the audio engine's
   *  per-car engine / turbo patches (research/formats/sound.md). main.ts sets it from the selection. */
  origCar?: string;
  /** The player car's backfire / blow-out flags of this frame (the shared source, CarFlags; the same object the
   *  renderer gets in CarRenderState.carFlags). Absent = consumers derive their own. */
  carFlags?: Readonly<CarFlags>;
  /** PHASE 2: the AI opponents' live per-frame views (audio: their Simple sound set; HUD). Absent / empty = solo. */
  others?: readonly OtherCarFrame[];
  /** PHASE 2: standings + AI car states (HUD position, results). Absent = solo. */
  field?: Readonly<FieldSnapshot>;
  /** PHASE 2: field events since the previous frame (an AI car finished, was reset, …). */
  fieldEvents?: readonly FieldEvent[];
}

/** HUD (src/ui/hud.ts `Hud`, `new Hud(root: HTMLElement)`): speed/rpm/gear/boost gauge, clock, progress bar
 *  with checkpoint sections, split deltas, pacenote icons, countdown/messages, reset fade (race.fade). */
export interface IHud {
  update(ctx: Readonly<FrameContext>): void;
  setVisible(on: boolean): void;
  dispose(): void;
}

/** What the player picked in the menu. */
export interface RaceSelection {
  stageId: string;
  /** Handling archetype (the physics layer; for an original car: its drive type's archetype). */
  archetype: ArchetypeId;
  /**
   * Original car name = the `cars/<Name>` folder of the asset manifest (`manifest.cars` key) = `archive` in
   * src/sim/origCars.ts = one of constants.ts ORIG_CAR_IDS (29 names, e.g. 'AudiS1', 'ImprezaWRX').
   * Absent = the procedural archetype car. With it: the car's handling preset (src/sim/presets.ts), mesh +
   * livery (renderer, AddCarOptions.origCar), engine sounds (FrameContext.origCar), best times / ghost keyed by it.
   */
  car?: string;
  tyre: TyreType;
  transmission: Transmission;
  /** Setup options (§5.5) as multipliers + steering choice. */
  setup: Partial<SetupParams>;
  steerSensFast: boolean;
  seed: number;
  /** PHASE 2: AI opponents on the grid, 0..MAX_OPPONENTS (src/core/field.ts). Absent = 0 (a solo race, as before). */
  opponents?: number;
  /** PHASE 2: the ghost to race against (src/core/ghosts.ts). Absent = the stored best run (`{ source: 'best' }`). */
  ghost?: GhostSelection;
}

export interface ArchetypeInfo {
  id: ArchetypeId;
  name: string;
  drive: 'AWD' | 'FWD' | 'RWD';
  blurb: string;
  /** Livery colours 0xRRGGBB. */
  colors: { body: number; accent: number; stripe: number };
}

/** One original car for the menu's car list (IMenuHost.listCars). */
export interface CarListEntry {
  /** Original car name (RaceSelection.car value, ORIG_CAR_IDS entry, e.g. 'AudiS1'). */
  id: string;
  /** Display name (the original's LocaleEnglish car name when the assets are built, else `id`). */
  name: string;
  /** Fallback visual / handling class (RaceSelection.archetype for this car). */
  archetype: ArchetypeId;
  drive: 'AWD' | 'FWD' | 'RWD';
  /** The car's asset pack is built (manifest.cars lists it): the original mesh / livery will show. */
  available: boolean;
}

/** Implemented by main.ts (App). Used by the menu. */
export interface IMenuHost {
  listStages(): StageListEntry[];
  listArchetypes(): ArchetypeInfo[];
  /** The original cars (all 29, ORIG_CAR_IDS order or the original's menu order). Optional until the cars
   *  builder implements it; the menu falls back to listArchetypes(). */
  listCars?(): CarListEntry[];
  /** Load the selection and start (with countdown). */
  startRace(sel: RaceSelection): Promise<void>;
  /** Restart the current stage with the same selection. */
  restart(): Promise<void>;
  /** Pause / resume the game. Also calls IMenu.showPause() (true) or IMenu.hide() (false), so the menu may
   *  call it from its own button/key handlers (showPause/hide must be idempotent). */
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  /** Current selection (stage, car, tyre, setup) — the menu's initial values. */
  getSelection(): RaceSelection;
  /** Camera view (menu "Camera" row; the C key cycles it in game). */
  setCamera(mode: CameraMode): void;
  getCameraMode(): CameraMode;
  /** Sound on/off (menu row; the M key toggles it in game). */
  setAudioEnabled(on: boolean): void;
  isAudioEnabled(): boolean;
  /** PHASE 2 ghost host (ghosts builder; main.ts delegates to RaceController). The selectable ghosts of a stage: the
   *  shipped team ghosts and the player's saved ones (the stored best run is `{ source: 'best' }`, not listed). */
  listGhosts?(stageId: string): Promise<GhostListEntry[]>;
  /** Save the session-best run of the loaded stage + car under `name` (the original's SAVE GHOST); false = refused
   *  (no best run yet, invalid name, storage full). */
  saveSessionGhost?(name: string): Promise<boolean>;
  /** Delete a saved (user) ghost. */
  deleteGhost?(id: string): Promise<void>;
  /** Is there a run to save (a finished valid run this session)? */
  canSaveGhost?(): boolean;
}

/** Main / pause / results menu (src/ui/menu.ts `Menu`, `new Menu(root: HTMLElement, host: IMenuHost)`). */
export interface IMenu {
  readonly visible: boolean;
  /** Main menu (stage + car + tyre + setup pickers). */
  showMain(): void;
  /** Pause menu (resume / restart / main menu). */
  showPause(): void;
  hide(): void;
  /** Per frame (react to 'finish' events with a results screen, Esc for pause, etc.). */
  update(ctx: Readonly<FrameContext>): void;
  dispose(): void;
}

/** Everything that can be tuned live (§6). setParam paths address this object (see testApi / ITuningHost). */
export interface GameTunables {
  car: CarParams;
  input: InputFilterConfig;
  camera: CameraTuning;
  surfaces: SurfaceTable;
  loop: { timeScale: number; physicsHz: number };
}

/** Implemented by main.ts (App). Used by the tuning panel. */
export interface ITuningHost {
  /** Live tunables (mutable objects; read for display). Write ONLY through setParam. */
  getTunables(): GameTunables;
  /**
   * Set one value by dotted path. The first segment selects the root: 'car.', 'input.', 'camera.',
   * 'surfaces.', 'loop.'; a path without a known root is a car path ('mass' ≡ 'car.mass').
   * Examples: 'mass', 'wheel.front.springK', 'assist.bigBetaSymmetric', 'setup.suspension',
   * 'gearRatio.2', 'input.keySteerRate', 'camera.fov', 'camera.chase.chase.posA.y',
   * 'surfaces.gravel.tyre.2.bestStatic', 'loop.timeScale'. Applies before the next substep.
   */
  setParam(path: string, value: unknown): void;
  getParam(path: string): unknown;
  /** Switch archetype (rebuilds the car at its current pose with the archetype's defaults). */
  setArchetype(id: ArchetypeId): void;
  /** Restore §3 shipped values for the current archetype (and default input/camera/surfaces). */
  resetToOriginal(): void;
  /** JSON of the current tunables ("Copy JSON", §6). */
  exportJson(): string;
  /** Apply a JSON produced by exportJson (partial allowed). */
  importJson(json: string): void;
  getTelemetry(): Readonly<CarTelemetry>;
  /** Autopilot on/off (drives the car along the stage; handy while tuning). */
  setAutopilot(on: boolean): void;
  getAutopilot(): boolean;
  /** Freeze / unfreeze the physics loop WITHOUT opening the pause menu (rendering and UI continue). */
  setFrozen(frozen: boolean): void;
  isFrozen(): boolean;
  /** Advance n physics substeps now (full pipeline incl. race logic) and render one frame. Use frozen. */
  stepPhysics(n: number): void;
  /** Place the car at spline distance s with a lateral offset (m, + right), with settle (debug jump). */
  teleport(s: number, lateral: number): void;
  /** Immediate race reset back onto the road (like R, without the fade). */
  resetCar(): void;
}

/** lil-gui tuning panel (src/debug/tuningPanel.ts `TuningPanel`, `new TuningPanel(host: ITuningHost)`).
 *  main.ts constructs it AFTER the first stage and car exist, so host.getTunables() is valid in the constructor.
 *  The car params object is replaced on stage loads / archetype switches: re-read via the host in refresh(). */
export interface ITuningPanel {
  readonly open: boolean;
  setOpen(open: boolean): void;
  toggle(): void;
  /** Re-read all displayed values (after archetype switch / reset / import). */
  refresh(): void;
  /** Per frame (e.g. read-only telemetry folder). */
  update(ctx: Readonly<FrameContext>): void;
  dispose(): void;
}

/** Debug telemetry overlay (src/debug/overlay.ts `TelemetryOverlay`, `new TelemetryOverlay(root)`):
 *  §6 "Debug overlay" fields, plus optional graphs. */
export interface ITelemetryOverlay {
  readonly visible: boolean;
  setVisible(on: boolean): void;
  toggle(): void;
  update(ctx: Readonly<FrameContext>): void;
  dispose(): void;
}

// =====================================================================================================
// Launch options and the test API (window.__rally, src/debug/testApi.ts, architect-owned)
// =====================================================================================================

/** Parsed URL parameters (main.ts). */
export interface LaunchOptions {
  /** ?stage= stage id (default: first listed stage). */
  stage: string | null;
  /** ?car= archetype id (for ?car=<original car name>: that car's archetype). */
  car: ArchetypeId;
  /** ?car=<original car name> (an ORIG_CAR_IDS entry, e.g. AudiS1) → RaceSelection.car; null / absent = none. */
  origCar?: string | null;
  /** ?tyre= 0..4 or tyre name; null = stage default. */
  tyre: TyreType | null;
  /** ?seed= number. */
  seed: number;
  /** ?cam= index or CameraMode name. */
  cam: CameraMode | null;
  /** ?autopilot=1 */
  autopilot: boolean;
  /** ?menu=0 skips the menu and starts with a countdown (or immediately with ?countdown=0). */
  menu: boolean;
  countdown: boolean;
  /** ?debug=1 shows the telemetry overlay; ?tune=1 opens the tuning panel. */
  debug: boolean;
  tune: boolean;
  /** ?timescale= 0.1..2 */
  timeScale: number;
  /** ?trans=manual|auto */
  transmission: Transmission;
  /** ?audio=0 disables audio. */
  audio: boolean;
  /** ?ghost=0 hides the best-run ghost car. */
  ghost: boolean;
  /** PHASE 2: ?ai=0..3 AI opponents on the grid (default 0 here; the menu's Opponents row has its own default). */
  opponents?: number;
}

/** Short stage description for the test API. */
export interface StageInfo extends StageListEntry {
  seed: number;
  length: number;
  startS: number;
  checkpoints: number[];
  finishS: number;
  validRange: [number, number];
  pacenoteCount: number;
  sceneryCount: number;
  roadSamples: number;
  heightfield: { nx: number; nz: number; cellSize: number; originX: number; originZ: number };
}

export interface LoadStageOptions {
  car?: ArchetypeId;
  /** Original car name (RaceSelection.car); its archetype replaces `car`. */
  origCar?: string;
  tyre?: TyreType;
  seed?: number;
  transmission?: Transmission;
  /** Start with countdown (default false for the API: phase stays 'idle' until startRace()). */
  countdown?: boolean;
  /** PHASE 2: AI opponents (0..3, default 0 = solo). */
  opponents?: number;
  /** PHASE 2: the ghost to race against (default: the stored best run). */
  ghost?: GhostSelection;
}

/** window.__rally.probe(): where the car is relative to the ground and the road (agent health checks). */
export interface ProbeInfo {
  /** THREE-space car origin. */
  pos: ThreeV3;
  /** WorldQuery.heightAt under the car origin (road surface or terrain), sim/three y. */
  groundY: number;
  /** Car origin height above that ground, m (≈ 0.3–0.6 on wheels; < 0 = below the ground surface). */
  clearance: number;
  /** Global stage projection of the car (no hint): s, lateral (+ right), height vs the centre line. */
  s: number;
  lateral: number;
  heightOffset: number;
  /** Body up-vector y (1 upright, < 0 upside down). */
  upY: number;
  /** Horizontal angle between the car's forward axis and the road tangent at s, degrees (0..180). */
  headingErrDeg: number;
  speedKmh: number;
}

/** window.__rally.getCarInfo(): which car the player drives (agent / tool checks). */
export interface CarInfo {
  /** Handling archetype of the live parameters. */
  archetype: ArchetypeId;
  /** Original car of the selection (RaceSelection.car), null = the archetype car. */
  origCar: string | null;
  /** Original car whose Car_<Name>.col hull the chassis probes use (§2.9), null = the archetype's §3.4 box. */
  hullCar: string | null;
  /** The co-driver voice setting (src/ui/settings.ts uiSettings.voice). */
  voice: boolean;
}

export interface FrameStats {
  frames: number;
  physicsSteps: number;
  simTime: number;
  fps: number;
  paused: boolean;
  timeScale: number;
}

/**
 * window.__rally — the headless test / agent API (architect-owned, src/debug/testApi.ts).
 * All return values are JSON-serialisable clones (safe for Playwright page.evaluate).
 */
export interface RallyTestApi {
  /** True once the first stage is loaded and the first frame rendered. */
  ready: boolean;
  version: string;
  getTelemetry(): CarTelemetry;
  getRaceState(): RaceState;
  getStageInfo(): StageInfo;
  listStages(): StageListEntry[];
  /** Override device input (merged over a neutral RawInput); null = back to the real devices.
   *  Edge fields (gearUp/gearDown/cameraNext/pause) fire once, then clear themselves. */
  setRawInput(partial: Partial<RawInput> | null): void;
  /** Bypass the input filter AND race gating with fixed Controls (merged over neutral); null = off. */
  setControls(partial: Partial<Controls> | null): void;
  /** Pause / resume the fixed-step loop (rendering continues). */
  pause(paused: boolean): void;
  /** Advance n physics substeps synchronously (race logic included) and render one frame. Use while paused. */
  step(n: number): CarTelemetry;
  /** Race reset (immediate, reason 'api'). */
  reset(): void;
  /** Place the car at spline distance s, lateral offset (m, + right), with settle. */
  teleport(s: number, lateral?: number): void;
  /** Load a stage (and optionally car/tyre/seed). Resolves when loaded and rendered. */
  loadStage(id: string, opts?: LoadStageOptions): Promise<StageInfo>;
  /** Same path syntax as ITuningHost.setParam. */
  setParam(path: string, value: unknown): void;
  getParams(): GameTunables;
  setAutopilot(on: boolean): void;
  /** Camera by index (CAMERA_MODES order) or name. */
  setCamera(mode: number | CameraMode): void;
  /** Skip menu and countdown: race running now. */
  startRace(): void;
  getFrameStats(): FrameStats;
  /** Car vs ground / road (clearance, heading error, upside down) for headless health checks. */
  probe(): ProbeInfo;
  /** The player car: archetype, original car and the hull in use (CarInfo). */
  getCarInfo(): CarInfo;
  /** The race events (RaceEvent: countdown, go, checkpoint, finish, reset with its reason, pacenote, ...) since the
   *  last call, oldest first; main.ts keeps at most the latest 1000 between calls. */
  getRaceEvents(): RaceEvent[];
  /** PHASE 2: the AI field: car states, standings, the player's position (empty when solo). */
  getField(): FieldSnapshot;
  /** PHASE 2: the ghost cars in play: id, original car, source, pose (THREE) and whether it is moving (empty = none). */
  getGhosts(): GhostInfo[];
}

/** window.__rally.getGhosts(): one ghost car in play (RaceController.ghostInfos). */
export interface GhostInfo {
  id: string;
  source: 'best' | 'team' | 'user';
  /** Ghost name (driver) and the original car it drives (the ghost file's template minus "Ghost"). */
  name: string;
  origCar: string | null;
  /** Total time of the ghost's run (s). */
  time: number;
  /** Frames (15 Hz grid for the exe layout) / the playback tick (120 Hz, from GO) / frozen at the end. */
  frames: number;
  tick: number;
  finished: boolean;
  pos: ThreeV3;
}
