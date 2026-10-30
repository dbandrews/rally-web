/**
 * src/sim/params.ts — OWNED BY THE SIM BUILDER.
 *
 * Archetype parameter sets (§3.1 shared + §3.2 per archetype), the live surface/tyre table (§4.3/§4.4: 23 rows,
 * one per original material 0..22, values = PhysicsParam.con),
 * and friction helpers (§4.2). Every value was re-verified against docs/MECHANICS_SPEC.md §3/§4
 * (tests/sim/car.test.ts checks §3.2 and all 115 μs/μk cells of the §4.3 table).
 * muStatic/muKinetic are the pure §4.2 formulas; the sim additionally multiplies by params.muGlobalScale [D].
 *
 * REQUIRED EXPORTS (used by main.ts / other modules — keep these signatures):
 *   ARCHETYPE_PARAMS: Readonly<Record<ArchetypeId, CarParams>>   shipped values, never mutate
 *   makeCarParams(id: ArchetypeId, overrides?: DeepPartial<CarParams>): CarParams   fresh deep copy
 *   DEFAULT_SURFACE_TABLE: Readonly<SurfaceTable>                 shipped values, never mutate
 *   makeSurfaceTable(): SurfaceTable                              fresh deep copy (the live table)
 *   muStatic(def: SurfaceDef, tyre: TyreType): number             §4.2
 *   muKinetic(def: SurfaceDef, tyre: TyreType): number            §4.2
 */
import { deepClone, deepMergeInto } from '../core/paths';
import type {
  ArchetypeId,
  CarParams,
  DeepPartial,
  SurfaceDef,
  SurfaceId,
  SurfaceTable,
  TyreRow,
  TyreType,
  WheelParams,
} from '../core/types';
import { MATERIAL } from '../core/constants';

// ------------------------------------------------------------------------------------------- §3.1 wheels

const FRONT_WHEEL: WheelParams = {
  springK: 35000,
  dampK: 5000,
  springLength: 0.75,
  rollStiffness: 14200,
  rollK: 1.00596,
  wheelInertia: 0.050027,
  momentXDist: 0.060145,
  momentZDist: 0.080006,
  twStaSteer: 2.2428,
  twKinSteer: 1.7045,
  twStaMy: 0.418,
  staticSlipAngleFast: 0.12,
  staticSlipAngleSlow: 0.08,
  steerTweak: 0.05,
  tireRelaxK: 1.60723,
  alignMomScale: 0.126552,
  latPosK: 5.00238,
  latNegK: 0.053606,
  longPosK: 5.39649,
  longNegK: 0.176533,
};

/** Rear: rollStiffness 15000, static slip angles 0.06 / 0.10; TW steer gains unused on the rear. */
const REAR_WHEEL: WheelParams = {
  ...FRONT_WHEEL,
  rollStiffness: 15000,
  staticSlipAngleFast: 0.06,
  staticSlipAngleSlow: 0.1,
};

// ------------------------------------------------------------------------------------------- §3.1 shared

type ArchetypeSpecific = Pick<
  CarParams,
  | 'archetype'
  | 'mass'
  | 'torqueScale'
  | 'wheelDrive'
  | 'turboSize'
  | 'nGears'
  | 'gearRatio'
  | 'wheelFL'
  | 'wheelRL'
  | 'hullFrontZ'
  | 'hullRearZ'
>;

function shared(a: ArchetypeSpecific): CarParams {
  return {
    ...a,
    // Simulation
    gravity: 12.0,
    airGravityGrowth: 1.065,
    airGravityMax: 1.45,
    airLinDamp: 2.0,
    airAngDamp: 1.0,
    // Body
    inertia: { x: 1.25, y: 1.45, z: 0.5 },
    airKZY: 1.25,
    airKZZ: 2.0,
    hullBottomY: -0.33,
    // unused since v1.5: the tyre loads take nb from the hull push direction (B+0x14c, MECHANICS_SPEC §2.5.5)
    bodyGroundShare: 0,
    // Engine
    torqueScaleFactor: 1.0,
    minRpm: 1000,
    cutRpm: 8250,
    maxRpm: 8750,
    maxTorqueRpm: 6500,
    maxTurboTorqueRpm: 6750,
    lowGearFill: 1e-4,
    useSpinTorque: true,
    spinTorqueScaleValue: 10,
    turboIdle: 0.1,
    turboWasteGate: 100,
    turboSpinup: 1.0,
    turboSpoolThrottle: 0.5,
    turboMaxGain: 0.75,
    engineBrakeGain: 0.75,
    engineBrakeBase: 5000,
    engineBrakePerGear: 700,
    throttleMinLimit: 0.1,
    useAntiSpin: false,
    antiSpinFactor: 8,
    useSpinTorqueDamping: false,
    spinTorqueDampingValue: 1,
    // Gearbox
    transmission: 'auto',
    finalDrive: 5.6,
    wheelRadius: 0.3,
    timeChangeGear: 0.1,
    timeChangeGearFR: 0.15,
    autoShiftTimeMul: 1.5,
    downGearFactor: 0.775,
    minRpmGearChange: 4000,
    useGearSpeedValues: false,
    gearSpeed: new Array(a.nGears).fill(0),
    // Drivetrain
    fwdFrontBias: 1.5,
    rwdRearBias: 1.25,
    lsdClamp: 0.5,
    launchAssist: true,
    launchScaleFront: 1,
    launchScaleRear: 1,
    launchScaleAwd: 1,
    rollLevel: 0,
    // Brakes
    brakeTorque: 4000,
    brakeBalance: 1.25,
    brakeMinLimit: 0.1,
    brakeHalfZone: 0.75,
    handBrakeTorque: 3500,
    hbFront: 0.3,
    hbRear: 1.3,
    useAbs: true,
    absFactor: 0.75,
    useEngineBrakeConstant: true,
    engineBrakeConstant: 4000,
    lockTorque: 1000,
    lockOmega: 3.14,
    // Suspension
    damperCap: 60000,
    antiPogo: true,
    // Steering
    wheelScale: 0.4,
    lowSpeedLockKmh: 40,
    lowSpeedLockGain: 0.005,
    // Tyres
    tyreType: 0,
    steerSensFast: true,
    slipRatioThreshold: 0.075,
    rebuildLoadTable: true,
    loadTableScale: 1.0,
    muGlobalScale: 1.0,
    // Assists
    twMaxMom: 5.7039,
    twMomLimStart: 1.1242,
    twMomLimScale: 1.5147,
    assistSpeedLo: 25,
    assistSpeedSlope: 0.02,
    driftGripBeta: 0.125,
    driftGripGain: 0.2,
    bigBetaThreshold: 0.75,
    bigBetaGain: 0.3,
    sideFillBase: 0.25,
    sideFillCap: 10000,
    driftDriveBoost: 0.5,
    useSideFriction: true,
    sideFrictionFactor: 1.4,
    useBodyFrictionDamping: true,
    wheelContactFactor: 0.003125,
    bodyContactFactor: 0.05,
    wheelspinLimiter: true,
    flipAssist: true,
    // Groups
    wheel: { front: { ...FRONT_WHEEL }, rear: { ...REAR_WHEEL } },
    assist: {
      bigBetaSymmetric: true, // DEV-1 on
      smoothYawFrictionSign: false, // DEV-3 off
      sleepPedalThreshold: false, // DEV-6 off
      heavyCarSleep: false, // DEV-7 off
      smoothSideFillGate: false, // DEV-8 off
      settleToEquilibrium: true, // DEV-9 on
    },
    damage: { physical: false }, // DEV-5
    setup: { brake: 1, powerRatio: 1, suspension: 1, gearRatio: 1, awdBaseSplit: 1 },
    upgrade: { engine: 1, weight: 1, brakes: 1, handling: 1 },
  };
}

// ------------------------------------------------------------------------------------------- §3.2 archetypes

const AWD_RATIOS = [-3.3, 3.35, 2.15, 1.55, 1.22, 0.97, 0.84];

export const ARCHETYPE_PARAMS: Readonly<Record<ArchetypeId, CarParams>> = Object.freeze({
  awd_wrc: shared({
    archetype: 'awd_wrc',
    mass: 1230,
    torqueScale: 935,
    wheelDrive: 2,
    turboSize: 1,
    nGears: 6,
    gearRatio: [...AWD_RATIOS],
    wheelFL: { x: -0.755, y: 0.53, z: 1.21 },
    wheelRL: { x: -0.76, y: 0.53, z: -1.32 },
    hullFrontZ: 2.07,
    hullRearZ: -2.3,
  }),
  fwd_hatch: shared({
    archetype: 'fwd_hatch',
    mass: 960,
    torqueScale: 930,
    wheelDrive: 0,
    turboSize: 1,
    nGears: 6,
    gearRatio: [...AWD_RATIOS],
    wheelFL: { x: -0.765, y: 0.57, z: 1.235 },
    wheelRL: { x: -0.765, y: 0.57, z: -1.31 },
    hullFrontZ: 1.95,
    hullRearZ: -2.05,
  }),
  rwd_classic: shared({
    archetype: 'rwd_classic',
    mass: 1010,
    torqueScale: 1350,
    wheelDrive: 1,
    turboSize: 1,
    nGears: 5,
    gearRatio: [-3.3, 3.42, 2.15, 1.52, 1.17, 0.75],
    wheelFL: { x: -0.655, y: 0.48, z: 1.26 },
    wheelRL: { x: -0.73, y: 0.48, z: -1.19 },
    hullFrontZ: 1.8,
    hullRearZ: -1.9,
  }),
});

/** Fresh, independent copy of an archetype's shipped parameters, optionally deep-merged with overrides. */
export function makeCarParams(id: ArchetypeId, overrides?: DeepPartial<CarParams>): CarParams {
  const base = ARCHETYPE_PARAMS[id];
  if (!base) throw new Error(`unknown archetype '${id}'`);
  const p = deepClone(base) as CarParams;
  if (overrides) deepMergeInto(p, overrides);
  return p;
}

// ------------------------------------------------------------------------------------------- §4 surfaces

const row = (bestStatic: number, diffStatic: number, scaleKinetic: number, bestRollK: number, diffRollK: number): TyreRow => ({
  bestStatic,
  diffStatic,
  scaleKinetic,
  bestRollK,
  diffRollK,
});
const same5 = (r: TyreRow): SurfaceDef['tyre'] => [{ ...r }, { ...r }, { ...r }, { ...r }, { ...r }];

/** [BodyK, BodyKScale, MaxDepth, Epsilon, FrictionLevel, Bump, BumpFlag] (§4.4) + visual columns (§4.3). */
function surf(
  id: SurfaceId,
  origId: number,
  deep: boolean,
  s: [number, number, number, number, number, number, 0 | 1],
  wheelJitterAmp: number,
  cameraRoughness: number,
  tyre: SurfaceDef['tyre'],
): SurfaceDef {
  return {
    id,
    material: MATERIAL[id],
    origId,
    deep,
    bodyK: s[0],
    bodyKScale: s[1],
    maxDepth: s[2],
    epsilon: s[3],
    frictionLevel: s[4],
    bump: s[5],
    bumpFlag: s[6],
    wheelJitterAmp,
    cameraRoughness,
    tyre,
  };
}

const ASPHALT_TYRES = (): SurfaceDef['tyre'] => [
  row(2.151, -0.366, 0.856, 1.0, 1.0),
  row(2.025, -0.344, 0.84, 1.0, 1.0),
  row(1.9, -0.323, 0.8, 1.0, 1.0),
  row(1.7, -0.289, 0.8, 1.0, 1.0),
  row(1.6, -0.272, 0.8, 1.0, 1.0),
];

export const DEFAULT_SURFACE_TABLE: Readonly<SurfaceTable> = Object.freeze({
  tarmac: surf('tarmac', 1, false, [0.9, 0.9, 0.0, 1.0, -1.0, 0.0, 0], 0.125, 0.03125, ASPHALT_TYRES()),
  gravel: surf('gravel', 2, false, [0.92, 0.8, 0.005, 0.5, 0.0, 0.025, 0], 0.75, 0.25, [
    row(1.55, -0.264, 0.8, 1.1, 1.1),
    row(1.71, -0.282, 0.8, 1.1, 1.1),
    row(1.775, -0.302, 0.8, 1.1, 1.1),
    row(1.35, -0.23, 0.8, 1.1, 1.1),
    row(1.305, -0.222, 0.8, 1.1, 1.1),
  ]),
  gravelDeep: surf('gravelDeep', 12, true, [1.0, 0.25, 0.04, 0.4, 0.0, 0.02, 1], 1.5, 0.275, same5(row(1.55, -0.264, 0.8, 5.01, 1.3))),
  mud: surf('mud', 4, false, [0.85, 0.75, 0.02, 0.45, 0.0, 0.015, 0], 1.0, 0.25, [
    row(1.15, -0.196, 0.8, 1.3, 1.3),
    row(1.28, -0.218, 0.8, 1.3, 1.3),
    row(1.38, -0.235, 0.8, 1.3, 1.3),
    row(1.25, -0.213, 0.8, 1.3, 1.3),
    row(1.407, -0.239, 0.8, 1.3, 1.3),
  ]),
  snow: surf('snow', 7, false, [0.72, 0.5, 0.02, 0.3, 0.25, 0.005, 0], 0.25, 0.0625, [
    row(0.35, -0.06, 0.8, 1.2, 1.2),
    row(0.45, -0.076, 0.8, 1.2, 1.2),
    row(0.45, -0.076, 0.8, 1.2, 1.2),
    row(1.35, -0.23, 0.8, 1.2, 1.2),
    row(1.45, -0.247, 0.8, 1.2, 1.2),
  ]),
  ice: surf('ice', 20, false, [0.7, 0.9, 0.0, 0.5, 2.0, 0.01, 0], 0.25, 0.0625, [
    row(0.5, -0.289, 0.8, 1.1, 1.1),
    row(0.75, -0.289, 0.8, 1.1, 1.1),
    row(1.0, -0.289, 0.8, 1.1, 1.1),
    row(1.6, -0.289, 0.8, 1.1, 1.1),
    row(1.7, -0.289, 0.8, 1.1, 1.1),
  ]),
  grass: surf('grass', 0, true, [0.85, 0.25, 0.02, 0.35, 0.0, 0.035, 1], 2.0, 0.3125, [
    row(0.808, -0.137, 0.8, 1.204, 1.006),
    row(1.203, -0.205, 0.8, 1.204, 1.006),
    row(1.502, -0.255, 0.8, 1.204, 1.006),
    row(1.35, -0.23, 0.8, 1.204, 1.006),
    row(1.449, -0.246, 0.8, 1.204, 1.006),
  ]),
  sand: surf('sand', 5, false, [0.85, 0.75, 0.0, 0.45, 0.0, 0.01, 0], 0.5, 0.125, [
    row(0.899, -0.136, 0.8, 1.15, 1.15),
    row(1.28, -0.201, 0.8, 1.15, 1.15),
    row(1.449, -0.229, 0.8, 1.15, 1.15),
    row(1.35, -0.213, 0.8, 1.15, 1.15),
    row(1.35, -0.213, 0.8, 1.15, 1.15),
  ]),
  cobbles: surf('cobbles', 13, false, [0.9, 0.8, 0.0, 1.0, 0.0, 0.075, 1], 2.5, 0.375, same5(row(1.75, -0.298, 0.8, 3.1, 1.1))),
  water: surf('water', 3, false, [0.9, 0.9, 0.0, 1.0, 1.0, 0.0, 0], 0.125, 0.03125, ASPHALT_TYRES()),
  // ---- appended original materials (rally-web ids 10..22), PhysicsParam.con rows verbatim (§4.4). DEEP = the
  // FUN_006d0410 switch {0, 9, 11, 12, 18, 19, 22}; jitter / roughness = FUN_006c8ef0 / FUN_0075e210 per orig id.
  wood: surf('wood', 6, false, [0.8, 0.9, 0.0, 0.4, 0.0, 0.05, 1], 2.5, 0.375, [
    row(1.526, -0.259, 0.8, 1.0, 1.0),
    row(1.6, -0.272, 0.8, 1.0, 1.0),
    row(1.6, -0.272, 0.8, 1.0, 1.0),
    row(1.6, -0.272, 0.8, 1.0, 1.0),
    row(1.6, -0.272, 0.8, 1.0, 1.0),
  ]),
  snowChunky: surf('snowChunky', 8, false, [0.72, 0.5, 0.02, 0.3, 0.25, 0.01, 0], 0.25, 0.0625, [
    row(0.25, -0.043, 0.8, 2.002, 1.2),
    row(0.35, -0.06, 0.8, 2.002, 1.2),
    row(0.35, -0.06, 0.8, 2.002, 1.2),
    row(1.35, -0.23, 0.8, 2.002, 1.2),
    row(1.55, -0.264, 0.8, 2.002, 1.2),
  ]),
  snowDeep: surf('snowDeep', 9, true, [0.8, 0.25, 0.04, 0.2, 0.0, 0.015, 1], 0.5, 0.125, [
    row(0.25, -0.043, 0.8, 10.075, 1.5),
    row(0.35, -0.06, 0.8, 10.075, 1.5),
    row(0.35, -0.06, 0.8, 10.075, 1.5),
    row(1.35, -0.23, 0.8, 10.075, 1.5),
    row(1.55, -0.264, 0.8, 10.075, 1.5),
  ]),
  // the exe's SNOWWET; rows equal to SNOW (7)
  snowAsphalt: surf('snowAsphalt', 10, false, [0.72, 0.5, 0.02, 0.3, 0.25, 0.005, 0], 0.25, 0.0625, [
    row(0.35, -0.06, 0.8, 1.2, 1.2),
    row(0.45, -0.076, 0.8, 1.2, 1.2),
    row(0.45, -0.076, 0.8, 1.2, 1.2),
    row(1.35, -0.23, 0.8, 1.2, 1.2),
    row(1.45, -0.247, 0.8, 1.2, 1.2),
  ]),
  snowDitch: surf('snowDitch', 11, true, [0.8, 0.25, 0.04, 0.3, 0.0, 0.02, 1], 0.5, 0.125, [
    row(0.25, -0.043, 0.8, 10.068, 1.5),
    row(0.35, -0.06, 0.8, 10.068, 1.5),
    row(0.35, -0.06, 0.8, 10.068, 1.5),
    row(1.35, -0.23, 0.8, 10.068, 1.5),
    row(1.55, -0.264, 0.8, 10.068, 1.5),
  ]),
  leaf: surf('leaf', 14, false, [0.45, 0.9, 0.02, 0.35, 0.0, 0.02, 1], 0.125, 0.03125, [
    row(1.75, -0.213, 0.8, 1.0, 1.0),
    row(1.7, -0.213, 0.8, 1.0, 1.0),
    row(1.6, -0.213, 0.8, 1.0, 1.0),
    row(1.5, -0.213, 0.8, 1.0, 1.0),
    row(1.4, -0.213, 0.8, 1.0, 1.0),
  ]),
  asphaltGrass: surf('asphaltGrass', 15, false, [0.72, 0.8, 0.01, 0.4, 0.0, 0.015, 0], 0.125, 0.03125, [
    row(1.825, -0.276, 0.8, 1.116, 1.2),
    row(1.725, -0.276, 0.8, 1.116, 1.2),
    row(1.7, -0.276, 0.8, 1.116, 1.2),
    row(1.65, -0.276, 0.8, 1.116, 1.2),
    row(1.625, -0.276, 0.8, 1.116, 1.2),
  ]),
  // DiffRollK 2.51 on tyres 0 and 4, 1.51 on 1..3 (as shipped)
  gravelGrass: surf('gravelGrass', 16, false, [0.7, 0.8, 0.02, 0.4, 0.0, 0.017, 0], 1.0, 0.25, [
    row(1.4, -0.238, 0.8, 1.35, 2.51),
    row(1.45, -0.238, 0.8, 1.35, 1.51),
    row(1.5, -0.238, 0.8, 1.35, 1.51),
    row(1.45, -0.238, 0.8, 1.35, 1.51),
    row(1.4, -0.238, 0.8, 1.35, 2.51),
  ]),
  mudGrass: surf('mudGrass', 17, false, [0.7, 0.8, 0.02, 0.35, 0.0, 0.017, 0], 1.0, 0.25, [
    row(1.3, -0.221, 0.8, 1.505, 1.4),
    row(1.35, -0.221, 0.8, 1.505, 1.4),
    row(1.4, -0.221, 0.8, 1.505, 1.4),
    row(1.35, -0.221, 0.8, 1.505, 1.4),
    row(1.3, -0.221, 0.8, 1.505, 1.4),
  ]),
  // DiffRollK 20.905 on tyres 0 and 4, 1.905 on 1..3 (as shipped)
  mudDitch: surf('mudDitch', 18, true, [0.65, 0.25, 0.04, 0.4, 0.0, 0.02, 1], 1.25, 0.275, [
    row(1.45, -0.247, 0.8, 10.064, 20.905),
    row(1.45, -0.247, 0.8, 10.064, 1.905),
    row(1.45, -0.247, 0.8, 10.064, 1.905),
    row(1.45, -0.247, 0.8, 10.064, 1.905),
    row(1.45, -0.247, 0.8, 10.064, 20.905),
  ]),
  sandDeep: surf('sandDeep', 19, true, [0.9, 0.25, 0.04, 0.55, 0.0, 0.01, 1], 1.25, 0.1875, same5(row(1.65, -0.28, 0.8, 5.024, 1.5))),
  // tyre rows equal to SAND (5)
  sandDark: surf('sandDark', 21, false, [0.85, 0.75, 0.02, 0.45, 0.0, 0.01, 0], 0.5, 0.125, [
    row(0.899, -0.136, 0.8, 1.15, 1.15),
    row(1.28, -0.201, 0.8, 1.15, 1.15),
    row(1.449, -0.229, 0.8, 1.15, 1.15),
    row(1.35, -0.213, 0.8, 1.15, 1.15),
    row(1.35, -0.213, 0.8, 1.15, 1.15),
  ]),
  sandDarkDeep: surf('sandDarkDeep', 22, true, [0.9, 0.75, 0.04, 0.25, 0.0, 0.01, 1], 1.25, 0.1875, same5(row(1.65, -0.28, 0.8, 5.024, 1.5))),
});

/** Fresh live surface table (the sim and tuning panel share this object). */
export function makeSurfaceTable(): SurfaceTable {
  return deepClone(DEFAULT_SURFACE_TABLE) as SurfaceTable;
}

/** §4.2: μs = BestStatic + DiffStatic·0.7·FrictionLevel. */
export function muStatic(def: SurfaceDef, tyre: TyreType): number {
  const r = def.tyre[tyre];
  return r.bestStatic + r.diffStatic * 0.7 * def.frictionLevel;
}
/** §4.2: μk = μs·ScaleKinetic. */
export function muKinetic(def: SurfaceDef, tyre: TyreType): number {
  return muStatic(def, tyre) * def.tyre[tyre].scaleKinetic;
}
