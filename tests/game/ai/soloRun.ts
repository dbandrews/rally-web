/**
 * tests/game/ai/soloRun.ts — a solo AI car (no player, no other cars) driven by the ported original AI through a stage on
 * the ORIGINAL collision mesh, stepped at 120 Hz. Shared by solo.test.ts and tools/ai-stages.mjs (via soloTable.test.ts).
 * The race logic here is the minimum a solo run needs (route tracking, finish, a simple stuck reset): the real field
 * (src/game/field.ts, ai-race) owns the production versions.
 */
import { DT } from '../../../src/core/constants';
import { simStartPose, simPoseOnStage } from '../../../src/core/stageUtil';
import { liftAboveGround } from '../../../src/game/stageMath';
import { createAiDriver } from '../../../src/game/ai/driver';
import { loadAiSchedule, loadAiStageData } from '../../../src/game/ai/aidata';
import { CarSim } from '../../../src/sim/car';
import { origCarParams } from '../../../src/sim/presets';
import { loadOrigWorld } from '../../../src/world/orig';
import { buildStage } from '../../../src/world/stages';

export interface SoloOptions {
  car?: string;
  /** Career event code for the AiTimes lookup (null = the single-race tree). */
  event?: string | null;
  schedule?: boolean;
  /** Give up after this many seconds of race time. */
  maxSeconds?: number;
  skill?: number;
  tyreScale?: number;
  /** Per-step hook (tests). */
  onStep?: (info: { step: number; s: number; lateral: number; speedKmh: number; state: Record<string, number | string | boolean> }) => void;
}

export interface SoloResult {
  stage: string;
  car: string;
  finished: boolean;
  finishTime: number;
  resets: number;
  seconds: number;
  maxLateral: number;
  meanAbsLateral: number;
  maxSpeedKmh: number;
  distance: number;
  schedule: { laps: number; total: number } | null;
  simFaults: number;
  wallMs: number;
}

export async function runSolo(stageId: string, o: SoloOptions = {}): Promise<SoloResult> {
  const t0 = performance.now();
  const carName = o.car ?? 'ImprezaWRX';
  const built = buildStage(stageId, 1);
  const stage = built.stage;
  const world = await loadOrigWorld(stageId, built.world);
  const data = await loadAiStageData(stageId);
  const schedule = o.schedule === false ? null : await loadAiSchedule(stageId, carName, o.event ?? null);
  const car = new CarSim({
    params: origCarParams(carName, { tyreType: stage.defaultTyre }),
    world,
    origCar: carName,
    aiFriction: true,
    slotBase: 0,
    id: 'ai1',
  });
  car.reset(liftAboveGround(stage, simStartPose(stage, world), 0.6, world));
  const driver = createAiDriver({
    spec: { id: 'ai1', origCar: carName, archetype: 'awd_wrc', name: carName, skill: o.skill ?? 1, tyreScale: o.tyreScale ?? 1, gridIndex: 1, slotBase: 0 },
    stage,
    world,
    data,
    schedule,
  });
  const L = stage.length;
  const laps = stage.laps;
  const finishDist = stage.closed ? laps * L : stage.finishS - stage.startS;
  const maxSteps = Math.round((o.maxSeconds ?? 900) / DT);
  let hint = stage.startS;
  let prevS = stage.startS;
  let progress = 0; // distance travelled along the centre line since the start (continuous over laps)
  let resets = 0;
  let stuck = 0;
  let maxLat = 0;
  let sumLat = 0;
  let maxSpeed = 0;
  let finishStep = -1;
  let n = 0;
  for (let step = 0; step < maxSteps; step++) {
    const tel = car.telemetry();
    const pr = stage.project(tel.pos, hint);
    hint = pr.s;
    let ds = pr.s - prevS;
    if (stage.closed) {
      if (ds < -L / 2) ds += L;
      else if (ds > L / 2) ds -= L;
    }
    progress += ds;
    prevS = pr.s;
    const ctl = driver.update({
      dt: DT,
      self: tel,
      s: pr.s,
      lateral: pr.lateral,
      lapDist: progress, // metres from the start line (the field's convention)
      others: [],
      raceTime: step * DT,
      running: true,
    });
    o.onStep?.({ step, s: pr.s, lateral: pr.lateral, speedKmh: tel.speedKmh, state: driver.debug() });
    car.step(ctl, DT);
    maxLat = Math.max(maxLat, Math.abs(pr.lateral));
    sumLat += Math.abs(pr.lateral);
    n++;
    maxSpeed = Math.max(maxSpeed, tel.speedKmh);
    if (progress >= finishDist) {
      finishStep = step;
      break;
    }
    // minimal stuck rule (the field owns the real one): 6 s below 3 km/h after the first 10 s -> back on the road
    stuck = tel.speedKmh < 3 && step > 10 / DT ? stuck + 1 : 0;
    if (stuck > 6 / DT || Math.abs(pr.lateral) > 40) {
      resets++;
      const s = Math.max(stage.startS, stage.closed ? pr.s : pr.s - 5);
      car.reset(liftAboveGround(stage, simPoseOnStage(stage, s, 0, 0.6, world), 0.6, world));
      driver.reset();
      hint = s;
      stuck = 0;
      if (resets > 12) break;
    }
  }
  let total = 0;
  if (schedule) total = schedule.splits[schedule.splits.length - 1];
  return {
    stage: stageId,
    car: carName,
    finished: finishStep >= 0,
    finishTime: finishStep >= 0 ? (finishStep + 1) * DT : NaN,
    resets,
    seconds: n * DT,
    maxLateral: maxLat,
    meanAbsLateral: n ? sumLat / n : 0,
    maxSpeedKmh: maxSpeed,
    distance: progress,
    schedule: schedule ? { laps: schedule.laps, total } : null,
    simFaults: car.telemetry().simFaults,
    wallMs: performance.now() - t0,
  };
}
