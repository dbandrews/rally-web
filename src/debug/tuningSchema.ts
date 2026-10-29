/**
 * src/debug/tuningSchema.ts — game builder. Every §6 live-tuning key as data: folder, display name, the
 * dotted parameter path(s) it writes (ITuningHost.setParam syntax), and the spec's min / max / step.
 *
 * Per-axle keys that §6 lists once (springK, twStaMy, …) write BOTH 'wheel.front.X' and 'wheel.rear.X'.
 * Keys §6 lists as "F / R" get one control per axle. `mountY` is derived: mount.y = wheel centre y -
 * wheelRadius (§3.2), written to wheelFL.y and wheelRL.y.
 * Gear ratios, surfaces and the camera chase entries are built by the panel (they depend on nGears or on
 * dropdown selections). Anything in GameTunables not listed here is added automatically to an "All other
 * parameters" folder by the panel, so every parameter is reachable.
 */

export interface ParamSpec {
  /** Label in the panel. */
  key: string;
  /** Paths written on change; paths[0] is read for display. */
  paths: string[];
  min?: number;
  max?: number;
  step?: number;
  /** Dropdown: label → value. */
  options?: Record<string, string | number | boolean>;
  readOnly?: boolean;
  /** Special derived key. */
  derived?: 'mountY';
}

export interface FolderSpec {
  title: string;
  params: ParamSpec[];
  closed?: boolean;
}

const n = (key: string, path: string, min: number, max: number, step: number): ParamSpec => ({ key, paths: [path], min, max, step });
const b = (key: string, path: string): ParamSpec => ({ key, paths: [path] });
/** One control writing both axles. */
const axle = (key: string, field: string, min: number, max: number, step: number): ParamSpec => ({
  key,
  paths: [`wheel.front.${field}`, `wheel.rear.${field}`],
  min,
  max,
  step,
});
/** Front and rear controls. */
const fr = (key: string, field: string, min: number, max: number, step: number): ParamSpec[] => [
  { key: `${key} F`, paths: [`wheel.front.${field}`], min, max, step },
  { key: `${key} R`, paths: [`wheel.rear.${field}`], min, max, step },
];

export const TUNING_SCHEMA: readonly FolderSpec[] = [
  {
    title: 'Simulation',
    params: [
      { key: 'physicsHz', paths: ['loop.physicsHz'], readOnly: true },
      n('timeScale', 'loop.timeScale', 0.1, 2, 0.05),
      n('gravity', 'gravity', 8, 16, 0.1),
      n('airGravityGrowth', 'airGravityGrowth', 1.0, 1.2, 0.005),
      n('airGravityMax', 'airGravityMax', 1.0, 2.0, 0.05),
      n('airLinDamp', 'airLinDamp', 0, 6, 0.1),
      n('airAngDamp', 'airAngDamp', 0, 4, 0.1),
    ],
  },
  {
    title: 'Body',
    params: [
      n('mass', 'mass', 600, 2000, 10),
      n('inertia.x (pitch)', 'inertia.x', 0.2, 3, 0.05),
      n('inertia.y (yaw)', 'inertia.y', 0.2, 3, 0.05),
      n('inertia.z (roll)', 'inertia.z', 0.2, 3, 0.05),
      n('airKZY (downforce)', 'airKZY', 0, 5, 0.05),
      n('airKZZ (drag)', 'airKZZ', 0, 6, 0.05),
      { key: 'mountY (all wheels)', paths: ['wheelFL.y', 'wheelRL.y'], min: 0, max: 0.5, step: 0.01, derived: 'mountY' },
    ],
    closed: true,
  },
  {
    title: 'Engine',
    params: [
      n('torqueScale', 'torqueScale', 300, 2500, 5),
      n('torqueScaleFactor', 'torqueScaleFactor', 0.5, 2, 0.01),
      n('minRpm', 'minRpm', 500, 2000, 50),
      n('cutRpm', 'cutRpm', 6000, 9400, 50),
      n('lowGearFill', 'lowGearFill', 0, 4e-4, 1e-5),
      b('useSpinTorque', 'useSpinTorque'),
      n('spinTorqueScaleValue', 'spinTorqueScaleValue', 0, 20, 0.5),
      n('turboSize', 'turboSize', 0, 2, 0.1),
      n('turboMaxGain', 'turboMaxGain', 0, 1.5, 0.05),
      n('turboSpinup', 'turboSpinup', 0.25, 4, 0.05),
      n('turboIdle (boost floor)', 'turboIdle', 0.01, 100, 0.01),
      n('turboWasteGate', 'turboWasteGate', 1, 200, 1),
      n('turboSpoolThrottle (lag)', 'turboSpoolThrottle', 0.05, 1, 0.01),
      n('engineBrakeGain', 'engineBrakeGain', 0, 2, 0.05),
      n('engineBrakeBase', 'engineBrakeBase', 0, 10000, 50),
      n('engineBrakePerGear', 'engineBrakePerGear', 0, 2000, 50),
      n('throttleMinLimit', 'throttleMinLimit', 0, 0.3, 0.01),
      b('useAntiSpin', 'useAntiSpin'),
      n('antiSpinFactor', 'antiSpinFactor', 1, 20, 0.5),
    ],
    closed: true,
  },
  {
    title: 'Gearbox',
    params: [
      { key: 'transmission', paths: ['transmission'], options: { auto: 'auto', manual: 'manual' } },
      // gearRatio.0..n are added by the panel (depends on nGears)
      n('finalDrive', 'finalDrive', 3, 8, 0.05),
      n('wheelRadius', 'wheelRadius', 0.25, 0.4, 0.005),
      n('timeChangeGear', 'timeChangeGear', 0, 0.6, 0.01),
      n('timeChangeGearFR', 'timeChangeGearFR', 0, 0.6, 0.01),
      n('autoShiftTimeMul', 'autoShiftTimeMul', 1, 3, 0.1),
      n('downGearFactor', 'downGearFactor', 0.5, 0.95, 0.005),
      n('minRpmGearChange', 'minRpmGearChange', 2000, 7000, 50),
      n('maxTorqueRpm', 'maxTorqueRpm', 4000, 9000, 50),
      n('maxTurboTorqueRpm', 'maxTurboTorqueRpm', 4000, 9000, 50),
    ],
    closed: true,
  },
  {
    title: 'Drivetrain',
    params: [
      { key: 'wheelDrive', paths: ['wheelDrive'], options: { 'FWD-biased (0)': 0, 'RWD-biased (1)': 1, 'AWD (2)': 2 } },
      n('fwdFrontBias', 'fwdFrontBias', 1.0, 2.0, 0.05),
      n('rwdRearBias', 'rwdRearBias', 1.0, 2.0, 0.05),
      n('awdSplit fs', 'setup.awdBaseSplit', 0.6, 1.4, 0.02),
      n('lsdClamp', 'lsdClamp', 0, 1, 0.05),
      axle('rollK', 'rollK', 0, 4, 0.01),
      axle('wheelInertia (inverse)', 'wheelInertia', 0.01, 0.2, 0.001),
      b('launchAssist (W1)', 'launchAssist'),
      n('launchMulFront', 'launchScaleFront', 0, 2, 0.05),
      n('launchMulRear', 'launchScaleRear', 0, 2, 0.05),
      n('launchMulAWD', 'launchScaleAwd', 0, 2, 0.05),
    ],
    closed: true,
  },
  {
    title: 'Brakes',
    params: [
      n('brakeTorque', 'brakeTorque', 1000, 8000, 50),
      n('brakeBalance', 'brakeBalance', 0.8, 1.6, 0.01),
      n('brakeHalfZone', 'brakeHalfZone', 0, 1, 0.05),
      n('handBrakeTorque', 'handBrakeTorque', 0, 8000, 50),
      n('hbFront', 'hbFront', 0, 1, 0.05),
      n('hbRear', 'hbRear', 0, 2, 0.05),
      b('useAbs', 'useAbs'),
      n('absFactor', 'absFactor', 0.05, 1, 0.01),
      b('useEngineBrakeConstant', 'useEngineBrakeConstant'),
      n('engineBrakeConstant', 'engineBrakeConstant', 0, 8000, 50),
      n('lockTorque', 'lockTorque', 0, 5000, 10),
      n('lockOmega', 'lockOmega', 0, 10, 0.1),
    ],
    closed: true,
  },
  {
    title: 'Suspension',
    params: [
      axle('springK', 'springK', 10000, 100000, 500),
      axle('dampK', 'dampK', 500, 20000, 100),
      axle('springLength', 'springLength', 0.3, 1.2, 0.01),
      ...fr('rollStiffness', 'rollStiffness', 0, 40000, 100),
      n('damperCap', 'damperCap', 10000, 100000, 1000),
      b('antiPogo', 'antiPogo'),
      n('setup.suspension', 'setup.suspension', 0.5, 1.5, 0.05),
    ],
    closed: true,
  },
  {
    title: 'Tyres',
    params: [
      { key: 'tyreType', paths: ['tyreType'], options: { tarmac: 0, intermediate: 1, gravel: 2, snow: 3, ice: 4 } },
      axle('latPosK', 'latPosK', 0.5, 15, 0.05),
      axle('longPosK', 'longPosK', 0.5, 15, 0.05),
      axle('latNegK', 'latNegK', 0, 0.6, 0.005),
      axle('longNegK', 'longNegK', 0, 0.6, 0.005),
      b('rebuildLoadTable', 'rebuildLoadTable'),
      axle('tireRelaxK', 'tireRelaxK', 0.2, 6, 0.05),
      axle('alignMomScale', 'alignMomScale', 0, 0.5, 0.005),
      ...fr('staticSlipAngleFast', 'staticSlipAngleFast', 0.01, 0.3, 0.005),
      ...fr('staticSlipAngleSlow', 'staticSlipAngleSlow', 0.01, 0.3, 0.005),
      b('steerSensFast (Agile)', 'steerSensFast'),
      n('slipRatioThreshold', 'slipRatioThreshold', 0.02, 0.3, 0.005),
      axle('momentXDist', 'momentXDist', 0, 0.4, 0.005),
      axle('momentZDist', 'momentZDist', 0, 0.4, 0.005),
      n('loadTableScale', 'loadTableScale', 0.5, 2, 0.05),
      n('muGlobalScale', 'muGlobalScale', 0.3, 1.5, 0.01),
    ],
    closed: true,
  },
  {
    title: 'Assists',
    params: [
      axle('twStaMy', 'twStaMy', 0, 2, 0.01),
      axle('twStaSteer', 'twStaSteer', 0, 6, 0.01),
      axle('twKinSteer', 'twKinSteer', 0, 6, 0.01),
      n('twMaxMom', 'twMaxMom', 0, 15, 0.05),
      n('twMomLimStart', 'twMomLimStart', 0.2, 4, 0.01),
      n('twMomLimScale', 'twMomLimScale', 0, 4, 0.01),
      n('assistSpeedLo', 'assistSpeedLo', 0, 80, 1),
      n('assistSpeedSlope', 'assistSpeedSlope', 0.005, 0.1, 0.001),
      n('driftGripBeta', 'driftGripBeta', 0, 1, 0.005),
      n('driftGripGain', 'driftGripGain', 0, 1, 0.01),
      n('bigBetaThreshold', 'bigBetaThreshold', 0, 1.5, 0.01),
      n('bigBetaGain', 'bigBetaGain', 0, 1, 0.01),
      b('bigBetaSymmetric (DEV-1)', 'assist.bigBetaSymmetric'),
      n('sideFillBase', 'sideFillBase', 0, 1, 0.01),
      n('sideFillCap', 'sideFillCap', 0, 30000, 500),
      n('driftDriveBoost', 'driftDriveBoost', 0, 2, 0.05),
      b('useSideFriction', 'useSideFriction'),
      n('sideFrictionFactor', 'sideFrictionFactor', 1, 3, 0.05),
      b('useBodyFrictionDamping', 'useBodyFrictionDamping'),
      n('wheelContactFactor', 'wheelContactFactor', 0, 0.02, 0.0005),
      n('bodyContactFactor', 'bodyContactFactor', 0, 0.3, 0.005),
      b('smoothYawFrictionSign (DEV-3)', 'assist.smoothYawFrictionSign'),
      b('sleepPedalThreshold (DEV-6)', 'assist.sleepPedalThreshold'),
      b('heavyCarSleep (DEV-7)', 'assist.heavyCarSleep'),
      b('smoothSideFillGate (DEV-8)', 'assist.smoothSideFillGate'),
      b('settleToEquilibrium (DEV-9)', 'assist.settleToEquilibrium'),
      b('wheelspinLimiter (W15)', 'wheelspinLimiter'),
      b('flipAssist (W19)', 'flipAssist'),
      b('physical damage (DEV-5)', 'damage.physical'),
    ],
    closed: true,
  },
  {
    title: 'Steering & input',
    params: [
      n('wheelScale (max lock)', 'wheelScale', 0.2, 0.8, 0.01),
      n('lowSpeedLockKmh', 'lowSpeedLockKmh', 0, 80, 1),
      n('lowSpeedLockGain', 'lowSpeedLockGain', 0, 0.02, 0.0005),
      axle('steerTweak', 'steerTweak', 0, 0.2, 0.005),
      n('keySteerStart', 'input.keySteerStart', 0, 0.3, 0.01),
      n('keySteerRate', 'input.keySteerRate', 0.5, 8, 0.1),
      n('keyThrottleStart', 'input.keyThrottleStart', 0, 1, 0.01),
      n('keyThrottleRate', 'input.keyThrottleRate', 0.5, 8, 0.1),
      n('keyBrakeStart', 'input.keyBrakeStart', 0, 1, 0.01),
      n('keyBrakeRate', 'input.keyBrakeRate', 0.5, 8, 0.1),
      n('keyHandbrakeStart', 'input.keyHandbrakeStart', 0, 1, 0.01),
      n('keyHandbrakeRate', 'input.keyHandbrakeRate', 0.5, 8, 0.1),
      { key: 'steeringType', paths: ['input.steeringType'], options: { 'rate-limited (0)': 0, 'squared (1)': 1 } },
      { key: 'sqrtCurve (pad)', paths: ['input.sqrtCurvePad'], options: { '0': 0, '1': 1, '2': 2 } },
      { key: 'sqrtCurve (wheel)', paths: ['input.sqrtCurveWheel'], options: { '0': 0, '1': 1, '2': 2 } },
      n('steerSensitivity', 'input.steerSensitivity', 0.5, 2, 0.05),
      n('padDeadzone', 'input.padDeadzone', 0, 0.4, 0.01),
      n('wheelDeadzone', 'input.wheelDeadzone', 0, 0.4, 0.01),
      n('pedalDeadzone', 'input.pedalDeadzone', 0, 0.2, 0.01),
    ],
    closed: true,
  },
  {
    title: 'Setup (§5.5)',
    params: [
      n('brake balance', 'setup.brake', 0.8, 1.2, 0.2),
      n('power ratio (AWD)', 'setup.powerRatio', 0.8, 1.2, 0.2),
      n('suspension', 'setup.suspension', 0.7, 1.3, 0.3),
      n('gear ratio m', 'setup.gearRatio', 0.8, 1.2, 0.2),
    ],
    closed: true,
  },
];

/** §6 "Surfaces" keys, relative to surfaces.<id>. (tyre.<t>. prefix for the tyre row). */
export const SURFACE_TYRE_KEYS: readonly ParamSpec[] = [
  n('bestStatic', 'bestStatic', 0, 3, 0.005),
  n('diffStatic', 'diffStatic', -0.6, 0.2, 0.005),
  n('scaleKinetic', 'scaleKinetic', 0.4, 1.0, 0.005),
  n('bestRollK', 'bestRollK', 0, 25, 0.01),
  n('diffRollK', 'diffRollK', 0, 25, 0.01),
];
export const SURFACE_KEYS: readonly ParamSpec[] = [
  n('frictionLevel', 'frictionLevel', -2, 3, 0.05),
  n('maxDepth', 'maxDepth', 0, 0.1, 0.001),
  n('bump', 'bump', 0, 0.1, 0.001),
  { key: 'bumpFlag', paths: ['bumpFlag'], options: { off: 0, on: 1 } },
  b('deep', 'deep'),
  n('bodyK', 'bodyK', 0, 5, 0.01),
  n('bodyKScale', 'bodyKScale', 0, 5, 0.01),
  n('epsilon', 'epsilon', 0, 1, 0.001),
];

/** §6 "Camera" keys (single values). The chase posA / posB / p0 / p1 entries are built per chase mode. */
export const CAMERA_KEYS: readonly ParamSpec[] = [
  n('fov', 'camera.fov', 50, 100, 1),
  n('chase.horizLerp', 'camera.chaseHorizLerp', 0.005, 0.3, 0.005),
  n('chase.vertLerp', 'camera.chaseVertLerp', 0.05, 1, 0.005),
  n('chase.blendRate', 'camera.chaseBlendRate', 0.005, 0.1, 0.005),
  n('chase.lookAtHeight', 'camera.chaseLookAtHeight', 0, 3, 0.05),
  n('bumper.pitch', 'camera.bumperPitch', 0, 0.3, 0.01),
  n('bumper.shakeGain', 'camera.bumperShakeGain', 0, 1e-4, 1e-6),
];

/** All paths covered by the explicit schema (for the "All other parameters" folder). */
export function coveredPaths(): Set<string> {
  const s = new Set<string>();
  for (const f of TUNING_SCHEMA) for (const p of f.params) for (const x of p.paths) s.add(x.startsWith('car.') ? x.slice(4) : x);
  for (const p of CAMERA_KEYS) for (const x of p.paths) s.add(x);
  return s;
}
