/**
 * src/game/race.ts — OWNED BY THE GAME BUILDER.
 *
 * Race controller: phases (idle → countdown → running → finished; "paused" is the loop's state, ctx.paused),
 * the race clock (sim time, crossing times interpolated inside the step → ms resolution), timing gates for
 * checkpoints / laps / finish with split deltas against the best run (localStorage per stage + seed + car),
 * the §5.4 reset rules (manual reset on the rising edge while running; automatic "hand of god" when
 * |lateral| > 30 m, height < -5 m below the spline, or s outside stage.validRange (a ported stage's archive
 * splineRange verbatim, whose minimum may lie past the start line); 1.0 s fade with controls
 * disabled, teleport at 0.5 s to max(s - 20, validRange[0] + 1) raised 1.5 m, 100 settle steps, no time
 * penalty; FUN_004b3e50 → FUN_0074d980(20, lo + 1); lap circuits have no range, the original's ±FLT_MAX,
 * so they go back 20 m across the lap line). The checks use the stage spline only, so they work the same on
 * the original collision mesh (off the mesh nothing is hit, the car falls and the -5 m rule catches it),
 * a [D] player "stuck" rule (upside down for 2.5 s, or crawling < 3 km/h for 10 s with a pedal pressed →
 * reset in place),
 * §5.7 pacenote triggering (|lateral| < 20 m, fire once, never replayed after a reset), wrong-way detection,
 * top speed, and ghost recording / playback of the best run (30 Hz).
 * Testpad stages ('testpad' discipline) disable the automatic resets, wrong way and the finish.
 * Start (docs/orig/race.md §1): the clock runs from GO; trigger 0 (stage.startS) is the original's start
 * EVENT and times nothing (FUN_004b4170 has no case for it); a ported stage's car waits at its spawn grid
 * (stage `spawnS`, which may lie past trigger 0), a procedural one `startGridBack` m behind the line.
 * Best times and ghosts are keyed by the original car (begin opts.origCar) or else the archetype.
 * At the finish a ported stage's Physics.bodyBrakingFactorForTrack (stage `trackBraking`) goes to
 * CarSim.setTrackBraking (the original's post-finish phys+0x44 braking, MECHANICS_SPEC §2.7).
 *
 * REQUIRED EXPORTS (contract in src/core/types.ts IRaceController):
 *   class RaceController implements IRaceController
 *     constructor()                     // optional RaceControllerOptions (store, ghost) for tests
 *     readonly state: RaceState
 *     begin(stage, car, { countdown }): void
 *     startNow(): void
 *     isControllable(): boolean
 *     fixedUpdate(dt, tel): void        // ALL race timing here (sim time)
 *     frameUpdate(frameDt, tel): void   // presentation timers only
 *     requestReset(reason): void
 *     teleport(s, lateral): void
 *     drainEvents(): RaceEvent[]
 *
 * EXTRA API for the integrator (ghost car, see contract request in the game builder report):
 *   hasGhost: boolean; ghostPose(timeOffset?): GhostPose | null (THREE space);
 *   ghostRenderState(playerTel, alpha): CarRenderState | null  (id 'ghost', ghost: true)
 */
import {
  AUTO_RESET_BELOW_M,
  AUTO_RESET_LATERAL_M,
  DT,
  RESET_BACK_M,
  RESET_FADE_S,
  RESET_RAISE,
  SETTLE_STEPS,
} from '../core/constants';
import { normS, simPoseOnStage, simStartPose, START_RAISE } from '../core/stageUtil';
import type {
  ArchetypeId,
  CarRenderState,
  CarTelemetry,
  ICarSim,
  IRaceController,
  RaceEvent,
  RaceState,
  ResetReason,
  Stage,
  StageProjection,
  WheelTelemetry,
  WorldQuery,
} from '../core/types';
import { BestTimes, type BestRecord } from './bestTimes';
import { GHOST_STEP_DIV, GhostRecorder, sampleGhost, type GhostPose, type GhostTrack } from './ghost';
import { PacenoteCaller } from './pacenotes';
import { forwardOfThree, liftAboveGround, upYOfQuat } from './stageMath';
import { defaultStore, type KeyValueStore } from './storage';
import { buildGates, crossingTime, roundMs, wrapDelta, type TimingGate } from './timing';

export const COUNTDOWN_S = 3;
/** "GO!" stays on screen this long after the start. */
const GO_MESSAGE_S = 1.0;
/** Wrong way: travel direction against the spline for this long (s) / back with it for this long. */
const WRONG_WAY_ON_S = 1.0;
const WRONG_WAY_OFF_S = 0.4;
/** [D] player stuck rules (not in the original for the player, §5.4 allows adding them). */
const FLIPPED_S = 2.5;
const CRAWL_S = 10;
const CRAWL_KMH = 3;
/** Passed notes leave the HUD list this far after their corner. */
const PACENOTE_KEEP_M = 40;
/**
 * A timing trigger only counts while the car is within this lateral distance of the centre line; passed
 * further out it waits until the car comes back (FUN_00483470: `dist < pos && |lat| < 20`, else −1 and the
 * trigger index stays).
 */
export const TRIGGER_LATERAL_M = 20;
/**
 * [D] Grid spot the game uses (main.ts passes it as RaceControllerOptions.startGridBack): the car waits this far
 * behind the start line (stage.startS), so the start gantry stands in front of the countdown camera instead of
 * over it (its beam covered the top of the screen). The clock still starts at GO; route distance is measured from
 * the line (it starts slightly negative). The controller's default is 0 (car on the line, the contract).
 */
export const START_GRID_BACK_M = 8;

/**
 * §5.4 valid range of a point-to-point stage: stage.validRange (a ported stage's archive splineRange verbatim,
 * src/world/portedBuilder.ts; its minimum may lie past the start line, corsica-2-f 550 vs trigger 0 at 545).
 */
function rangeOf(stage: Stage): readonly [number, number] {
  return stage.validRange;
}

export function initialRaceState(): RaceState {
  return {
    phase: 'idle',
    stageId: '',
    discipline: 'testpad',
    time: 0,
    countdown: 0,
    s: 0,
    lateral: 0,
    progress: 0,
    lap: 1,
    laps: 1,
    nextCheckpoint: 0,
    checkpointsTotal: 1,
    splits: [],
    bestTime: null,
    bestSplits: null,
    finishTime: null,
    controllable: false,
    wrongWay: false,
    resetting: false,
    fade: 0,
    resets: 0,
    pacenotes: [],
    topSpeedKmh: 0,
    message: null,
    untimed: false,
  };
}

export interface RaceControllerOptions {
  /** Persistence for best times and ghosts (default: localStorage with memory fallback). */
  store?: KeyValueStore;
  /** Record and replay ghosts (default true). */
  ghost?: boolean;
  /** [D] stuck auto-resets for the player (default true). */
  stuckReset?: boolean;
  /** Metres behind the start line the car waits at the start (default 0; the game uses START_GRID_BACK_M). */
  startGridBack?: number;
}

export class RaceController implements IRaceController {
  readonly state: RaceState = initialRaceState();
  /** Countdown length (s). */
  countdownSeconds = COUNTDOWN_S;
  readonly best: BestTimes;
  readonly ghostEnabled: boolean;
  stuckResetEnabled: boolean;
  /** Pacenote caller (exposed for tests / tuning: caller.leadM). */
  readonly caller = new PacenoteCaller();

  private stage: Stage | null = null;
  private car: ICarSim | null = null;
  private world: WorldQuery | null = null;
  private archetype: ArchetypeId = 'awd_wrc';
  /** Original car name (begin opts.origCar), carried on the ghost's render state. */
  private origCar: string | undefined;
  /** Best-time / ghost key: the original car name, else the archetype. */
  private carKey = 'awd_wrc';
  private events: RaceEvent[] = [];
  private gates: TimingGate[] = [];
  private nextGate = 0;
  /** Route distance from the start line (m) and its value one step ago. */
  private dist = 0;
  private prevDist = 0;
  private prevS = 0;
  private lastProj: StageProjection | null = null;
  private runSteps = 0;
  private countdownSteps = 0;
  private lastCountN = 0;
  private lapStartTime = 0;
  private runValid = true;
  // reset sequence
  private resetSteps = 0;
  private resetTeleported = false;
  private resetReason: ResetReason = 'manual';
  private resetFromS = 0;
  private resetFromDist = 0;
  // detectors
  private wrongT = 0;
  private rightT = 0;
  private flipT = 0;
  private crawlT = 0;
  // ghost
  private readonly recorder = new GhostRecorder();
  private ghost: GhostTrack | null = null;
  private readonly ghostOut: GhostPose = { pos: { x: 0, y: 0, z: 0 }, quat: { w: 1, x: 0, y: 0, z: 0 }, steerAngle: 0 };
  private ghostRs: CarRenderState | null = null;
  private ghostSpin = 0;
  private readonly fwd = { x: 0, y: 0, z: -1 };
  private readonly startGridBack: number;

  constructor(opts: RaceControllerOptions = {}) {
    this.best = new BestTimes(opts.store ?? defaultStore());
    this.ghostEnabled = opts.ghost !== false;
    this.stuckResetEnabled = opts.stuckReset !== false;
    this.startGridBack = Math.max(0, opts.startGridBack ?? 0);
  }

  // =================================================================================== lifecycle

  begin(stage: Stage, car: ICarSim, opts: { countdown: boolean; world?: WorldQuery; origCar?: string }): void {
    this.stage = stage;
    this.car = car;
    this.world = opts.world ?? null;
    this.archetype = car.archetype ?? car.params.archetype;
    this.origCar = opts.origCar || undefined;
    this.carKey = this.origCar ?? this.archetype;
    this.ghostRs = null;
    this.events = [];
    this.gates = buildGates(stage);
    this.nextGate = 0;
    this.dist = this.prevDist = 0;
    this.prevS = stage.startS;
    this.lastProj = null;
    this.runSteps = 0;
    this.countdownSteps = 0;
    this.lastCountN = 0;
    this.lapStartTime = 0;
    this.runValid = true;
    this.resetSteps = 0;
    this.resetTeleported = false;
    this.wrongT = this.rightT = this.flipT = this.crawlT = 0;
    this.recorder.stop();
    this.caller.reset(stage.pacenotes ?? []);

    const st = this.state;
    Object.assign(st, initialRaceState(), {
      stageId: stage.id,
      discipline: stage.discipline,
      laps: stage.closed ? Math.max(1, stage.laps) : 1,
      checkpointsTotal: stage.checkpoints.length + 1,
      s: stage.startS,
    });
    st.splits = [];
    st.pacenotes = [];

    const rec = this.best.load(stage.id, stage.seed, this.carKey);
    st.bestTime = rec ? rec.time : null;
    st.bestSplits = rec ? [...rec.splits] : null;
    this.ghost = this.ghostEnabled && rec ? this.best.loadGhost(stage.id, stage.seed, this.carKey) : null;

    this.placeAtStart();
    car.setParked(true);
    if (opts.countdown) {
      st.phase = 'countdown';
      st.countdown = this.countdownSeconds;
      st.message = String(Math.ceil(this.countdownSeconds));
    }
    st.controllable = false;
  }

  startNow(): void {
    const st = this.state;
    if (!this.stage) return;
    st.phase = 'running';
    st.countdown = 0;
    st.time = 0;
    this.runSteps = 0;
    this.lapStartTime = 0;
    st.message = 'GO!';
    st.controllable = !st.resetting;
    this.car?.setParked(false);
    this.events.push({ type: 'go' });
    if (this.ghostEnabled && this.car) {
      this.recorder.start();
      const t = this.car.telemetry();
      this.recorder.push(t.pos, t.quat, t.steerAngle);
    }
  }

  isControllable(): boolean {
    return this.state.phase === 'running' && !this.state.resetting;
  }

  // =================================================================================== per step

  fixedUpdate(dt: number, tel: Readonly<CarTelemetry>): void {
    const st = this.state;
    const stage = this.stage;
    if (!stage) return;
    this.track(stage, tel);

    if (st.phase === 'countdown') {
      this.countdownSteps++;
      const remaining = this.countdownSeconds - this.countdownSteps * dt;
      st.countdown = Math.max(0, remaining);
      const n = Math.ceil(remaining - 1e-9);
      if (n > 0 && n !== this.lastCountN) {
        this.lastCountN = n;
        this.events.push({ type: 'countdown', n });
      }
      if (remaining <= 1e-9) this.startNow();
      this.updateMessage();
      st.controllable = this.isControllable();
      return;
    }

    if (st.phase === 'running') {
      this.runSteps++;
      st.time = this.runSteps * dt;
      st.topSpeedKmh = Math.max(st.topSpeedKmh, tel.speedKmh);
      if (st.resetting) this.advanceReset(dt);
      const settled = !st.resetting || this.resetTeleported;
      if (settled) this.crossGates(dt);
      if (st.phase === 'running') {
        if (!st.resetting) {
          this.pacenotes();
          this.autoResets(stage, tel, dt);
        }
        this.wrongWay(stage, tel, dt);
      }
      this.recordGhost(tel);
    } else if (st.phase === 'finished' && st.resetting) {
      this.advanceReset(dt);
    }

    const total = this.gates.length ? this.gates[this.gates.length - 1].dist : 0;
    st.progress = total > 0 ? Math.min(1, Math.max(0, this.dist / total)) : 0;
    this.updateMessage();
    st.controllable = this.isControllable();
  }

  frameUpdate(_frameDt: number, _tel: Readonly<CarTelemetry>): void {
    // all race logic runs in fixedUpdate (sim time); nothing frame-based is needed here
  }

  // =================================================================================== resets

  requestReset(reason: ResetReason): void {
    const st = this.state;
    if (!this.stage || !this.car) return;
    if (reason === 'api' || reason === 'restart') {
      st.resetting = false;
      st.fade = 0;
      if (reason === 'restart' || st.phase === 'idle' || st.phase === 'countdown') {
        if (reason === 'restart') this.caller.reset(this.stage.pacenotes ?? []); // resetPaceNotes (FUN_0074b680)
        this.placeAtStart();
      } else {
        this.resetFromS = st.s;
        this.resetFromDist = this.dist;
        this.resetReason = reason;
        this.teleportBack(RESET_BACK_M);
      }
      st.resets++;
      this.events.push({ type: 'reset', reason });
      st.controllable = this.isControllable();
      return;
    }
    if (st.phase !== 'running' || st.resetting) return;
    st.resetting = true;
    st.fade = 0;
    this.resetSteps = 0;
    this.resetTeleported = false;
    this.resetReason = reason;
    this.resetFromS = st.s;
    this.resetFromDist = this.dist;
    st.controllable = false;
  }

  teleport(s: number, lateral: number): void {
    const stage = this.stage;
    const car = this.car;
    if (!stage || !car) return;
    const st = this.state;
    const s0 = normS(stage, s);
    const pose = liftAboveGround(stage, simPoseOnStage(stage, s0, lateral, RESET_RAISE), RESET_RAISE, this.world);
    car.reset(pose, SETTLE_STEPS);
    if (stage.closed) this.dist += wrapDelta(s0 - st.s, stage.length);
    else this.dist = s0 - stage.startS;
    this.prevDist = this.dist;
    this.prevS = s0;
    this.lastProj = null;
    st.s = s0;
    st.lateral = lateral;
    st.resetting = false;
    st.fade = 0;
    this.clearDetectors();
    // a teleport is a debug jump: the run no longer counts for best times / ghosts
    this.runValid = false;
    st.untimed = true;
    this.skipGatesBehind();
    st.controllable = this.isControllable();
  }

  /**
   * After a debug teleport: gates the jump passed are marked as skipped (NaN split, no checkpoint / lap events,
   * no popups) so the next real crossing is timed against the right gate. The finish is never skipped.
   */
  private skipGatesBehind(): void {
    const st = this.state;
    if (st.phase === 'finished') return;
    while (this.nextGate < this.gates.length - 1 && this.dist >= this.gates[this.nextGate].dist) {
      const g = this.gates[this.nextGate++];
      st.splits.push(Number.NaN);
      if (g.kind === 'checkpoint') st.nextCheckpoint = g.index + 1;
      else if (g.kind === 'lap') {
        st.lap = Math.min(st.laps, g.lap + 1);
        st.nextCheckpoint = 0;
      }
    }
  }

  drainEvents(): RaceEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // =================================================================================== ghost

  /** A ghost of the best run is loaded for this stage + car. */
  get hasGhost(): boolean {
    return this.ghost !== null && this.ghost.count > 1;
  }

  /** Ghost pose (THREE space) at the current race time (+ offset, s), or null when there is no ghost or the
   *  race has not started. The returned object is reused. */
  ghostPose(timeOffset = 0): GhostPose | null {
    const st = this.state;
    if (!this.ghost || (st.phase !== 'running' && st.phase !== 'finished')) return null;
    return sampleGhost(this.ghost, st.time + timeOffset, this.ghostOut);
  }

  /**
   * Ready-made render state for the ghost car (id 'ghost', ghost: true) at the interpolated race time, or
   * null. Wheel visuals reuse the player's geometry (same archetype) with the ghost's recorded steer.
   * Returned object and its telemetry are reused between calls.
   */
  ghostRenderState(playerTel: Readonly<CarTelemetry>, alpha = 0): CarRenderState | null {
    const g = this.ghostPose(alpha * DT);
    if (!g) return null;
    if (!this.ghostRs) {
      const tel = structuredClone(playerTel) as CarTelemetry;
      tel.id = 'ghost';
      this.ghostRs = {
        id: 'ghost',
        archetype: this.archetype,
        ...(this.origCar ? { origCar: this.origCar } : {}),
        ghost: true,
        player: false,
        pos: { x: 0, y: 0, z: 0 },
        quat: { w: 1, x: 0, y: 0, z: 0 },
        telemetry: tel,
        justReset: true,
      };
    } else this.ghostRs.justReset = false;
    const rs = this.ghostRs;
    const tel = rs.telemetry as CarTelemetry;
    rs.archetype = this.archetype;
    if (this.origCar) rs.origCar = this.origCar;
    else delete rs.origCar;
    rs.pos.x = tel.pos.x = g.pos.x;
    rs.pos.y = tel.pos.y = g.pos.y;
    rs.pos.z = tel.pos.z = g.pos.z;
    rs.quat.w = tel.quat.w = g.quat.w;
    rs.quat.x = tel.quat.x = g.quat.x;
    rs.quat.y = tel.quat.y = g.quat.y;
    rs.quat.z = tel.quat.z = g.quat.z;
    tel.steerAngle = g.steerAngle;
    this.ghostSpin += 0.4;
    for (let i = 0; i < 4; i++) {
      const w = tel.wheels[i] as WheelTelemetry;
      const src = playerTel.wheels[i];
      w.contact = false;
      w.surface = null;
      w.mode = 1;
      w.visual.centreLocal.x = src.visual.centreLocal.x;
      w.visual.centreLocal.y = src.visual.centreLocal.y;
      w.visual.centreLocal.z = src.visual.centreLocal.z;
      w.visual.steerAngle = i < 2 ? g.steerAngle : 0;
      w.visual.spinAngle = this.ghostSpin;
      w.visual.suspensionOffset = src.visual.suspensionOffset;
    }
    return rs;
  }

  // =================================================================================== internals

  /** Project the car on the spline and update s / lateral / route distance. */
  private track(stage: Stage, tel: Readonly<CarTelemetry>): void {
    const st = this.state;
    const pr = stage.project(tel.pos, st.s);
    this.lastProj = pr;
    this.prevDist = this.dist;
    if (stage.closed) this.dist += wrapDelta(pr.s - this.prevS, stage.length);
    else this.dist = pr.s - stage.startS;
    this.prevS = pr.s;
    st.s = pr.s;
    st.lateral = pr.lateral;
  }

  private crossGates(dt: number): void {
    const st = this.state;
    const time = st.time;
    while (st.phase === 'running' && this.nextGate < this.gates.length && this.dist >= this.gates[this.nextGate].dist) {
      if (Math.abs(st.lateral) >= TRIGGER_LATERAL_M) break; // waits until back within 20 m
      const g = this.gates[this.nextGate++];
      // crossed during this step: interpolated; a trigger that waited counts now
      const t = roundMs(this.prevDist < g.dist ? crossingTime(time, dt, this.prevDist, this.dist, g.dist) : time);
      st.splits.push(t);
      const i = st.splits.length - 1;
      const delta = st.bestSplits && st.bestSplits.length > i ? roundMs(t - st.bestSplits[i]) : null;
      if (g.kind === 'checkpoint') {
        st.nextCheckpoint = g.index + 1;
        this.events.push({ type: 'checkpoint', index: g.index, time: t, delta });
      } else {
        const lapTime = roundMs(t - this.lapStartTime);
        this.lapStartTime = t;
        if (this.stage?.closed) this.events.push({ type: 'lap', lap: g.lap, time: t, lapTime });
        if (g.kind === 'lap') {
          st.lap = Math.min(st.laps, g.lap + 1);
          st.nextCheckpoint = 0;
        } else this.finish(t);
      }
    }
  }

  private finish(t: number): void {
    const st = this.state;
    const stage = this.stage!;
    st.phase = 'finished';
    st.finishTime = t;
    st.time = t;
    st.nextCheckpoint = st.checkpointsTotal;
    this.recorder.stop();
    // the race is over (FUN_004b4170 case 3 → player state 4, FUN_004b3790): the physics' track braking flag
    // phys+0x44 goes on with the stage's Physics.bodyBrakingFactorForTrack (MECHANICS_SPEC §2.7); a stage
    // without the factor (the procedural ones) keeps the car as it was. car.reset switches it off again.
    const braking = (stage as Stage & { trackBraking?: number }).trackBraking;
    if (typeof braking === 'number' && braking > 0) this.car?.setTrackBraking?.(braking);
    const isBest = this.runValid && (st.bestTime === null || t < st.bestTime);
    if (isBest) {
      const rec: BestRecord = {
        v: 1,
        time: t,
        splits: [...st.splits],
        archetype: this.archetype,
        ...(this.origCar ? { car: this.origCar } : {}),
        date: Date.now(),
        resets: st.resets,
      };
      this.best.save(stage.id, stage.seed, rec, this.carKey);
      if (this.ghostEnabled) {
        try {
          this.best.saveGhost(stage.id, stage.seed, this.carKey, this.recorder.track());
        } catch {
          /* storage full: keep the time, skip the ghost */
        }
      }
    }
    // state.bestTime / bestSplits keep the PREVIOUS best until the next begin() (results screen deltas)
    this.events.push({ type: 'finish', time: t, best: isBest });
  }

  private advanceReset(dt: number): void {
    const st = this.state;
    this.resetSteps++;
    const t = this.resetSteps * dt;
    const half = RESET_FADE_S / 2;
    if (!this.resetTeleported && t >= half - 1e-9) {
      this.resetTeleported = true;
      this.teleportBack(this.resetReason === 'stuck' ? 0 : RESET_BACK_M);
      st.resets++;
      this.events.push({ type: 'reset', reason: this.resetReason });
    }
    st.fade = t < half ? t / half : Math.max(0, (RESET_FADE_S - t) / half);
    if (t >= RESET_FADE_S - 1e-9) {
      st.resetting = false;
      st.fade = 0;
    }
  }

  /** §5.4 teleport: centre line at max(s - back, startS + 1), raised 1.5 m, settle. */
  private teleportBack(back: number): void {
    const stage = this.stage!;
    const car = this.car!;
    const st = this.state;
    let s: number;
    let d: number;
    if (stage.closed) {
      // no splineRange on the lap circuits (the original's ±FLT_MAX): straight back, across the lap line too
      d = this.resetFromDist - back;
      s = normS(stage, stage.startS + d);
    } else {
      // FUN_004b3e50: FUN_0074d980(20, validRangeMin + 1) — the range minimum, not the start line
      const range = rangeOf(stage);
      const lo = Math.max(0, range[0] + 1);
      const hi = Math.min(stage.length, range[1]);
      s = Math.min(hi, Math.max(lo, this.resetFromS - back));
      d = s - stage.startS;
    }
    car.reset(liftAboveGround(stage, simPoseOnStage(stage, s, 0, RESET_RAISE), RESET_RAISE, this.world), SETTLE_STEPS);
    this.dist = this.prevDist = d;
    this.prevS = s;
    this.lastProj = null;
    st.s = s;
    st.lateral = 0;
    st.wrongWay = false;
    this.clearDetectors();
    // §5.7: a reset leaves the played flags as they are (only restart / lap events clear them, FUN_0074b680 at
    // 0x4afdc7 / 0x4b0152): every note the car passed has fired, so none replays on the way back past it
  }

  private placeAtStart(): void {
    const stage = this.stage!;
    const s0 = this.gridS(stage);
    this.car!.reset(this.gridPose(stage), SETTLE_STEPS);
    this.dist = this.prevDist = stage.closed ? wrapDelta(s0 - stage.startS, stage.length) : s0 - stage.startS;
    this.prevS = s0;
    this.state.s = s0;
    this.state.lateral = 0;
    this.clearDetectors();
  }

  /** Spline distance the car waits at: the stage's spawn grid (ported stages), else the grid spot. */
  private gridS(stage: Stage): number {
    const spawn = (stage as Stage & { spawnS?: number }).spawnS;
    if (typeof spawn === 'number' && Number.isFinite(spawn)) return spawn;
    return this.startGridBack > 0 ? normS(stage, stage.startS - this.startGridBack) : stage.startS;
  }

  /**
   * Start pose. A stage with its own spawn grid (`spawnS`, the ported stages) has stage.startPose there: the
   * original places the car on the centre spline at spawnGrid.s heading to s + 1 m (0x484769, single player:
   * no grid column offset). Otherwise on the line, or `startGridBack` m behind it, facing the stage.
   */
  private gridPose(stage: Stage) {
    const spawn = (stage as Stage & { spawnS?: number }).spawnS;
    let pose;
    if (typeof spawn === 'number' && Number.isFinite(spawn)) pose = simStartPose(stage);
    else pose = this.startGridBack > 0 ? simPoseOnStage(stage, stage.startS - this.startGridBack, 0, START_RAISE) : simStartPose(stage);
    return liftAboveGround(stage, pose, START_RAISE, this.world);
  }

  private clearDetectors(): void {
    this.wrongT = this.rightT = this.flipT = this.crawlT = 0;
    if (this.state.wrongWay) {
      this.state.wrongWay = false;
      this.events.push({ type: 'wrongWay', on: false });
    }
  }

  private pacenotes(): void {
    const st = this.state;
    if (this.caller.count === 0) return;
    const note = this.caller.update(st.s, st.lateral);
    if (note) {
      st.pacenotes.unshift(note);
      if (st.pacenotes.length > 3) st.pacenotes.length = 3;
      this.events.push({ type: 'pacenote', note });
    }
    if (st.pacenotes.length) {
      const keep = st.pacenotes.filter((n) => n.cornerS + PACENOTE_KEEP_M > st.s);
      if (keep.length !== st.pacenotes.length) st.pacenotes = keep;
    }
  }

  private autoResets(stage: Stage, tel: Readonly<CarTelemetry>, dt: number): void {
    if (stage.discipline === 'testpad') return;
    const pr = this.lastProj;
    if (pr) {
      if (Math.abs(pr.lateral) > AUTO_RESET_LATERAL_M) return this.requestReset('offTrack');
      if (pr.heightOffset < AUTO_RESET_BELOW_M) return this.requestReset('belowTrack');
      if (!stage.closed) {
        const range = rangeOf(stage);
        if (pr.s < range[0] || pr.s > range[1]) return this.requestReset('outOfRange');
      }
    }
    if (!this.stuckResetEnabled) return;
    const kmh = tel.speedWorldKmh ?? tel.speedKmh;
    this.flipT = upYOfQuat(tel.quat) < 0.3 && kmh < 10 ? this.flipT + dt : 0;
    // crawling only counts while the driver is asking to move (a player waiting at the line is not stuck)
    const asking = tel.throttle > 0.3 || tel.brake > 0.3;
    this.crawlT = kmh < CRAWL_KMH && asking ? this.crawlT + dt : 0;
    if (this.flipT > FLIPPED_S || this.crawlT > CRAWL_S) this.requestReset('stuck');
  }

  private wrongWay(stage: Stage, tel: Readonly<CarTelemetry>, dt: number): void {
    const st = this.state;
    if (stage.discipline === 'testpad' || st.resetting) return;
    const tan = stage.tangentAt(st.s);
    const th = Math.hypot(tan.x, tan.z);
    if (th < 1e-6) return;
    const v = tel.vel;
    const sp = Math.hypot(v.x, v.z);
    let dx: number;
    let dz: number;
    if (sp > 3) {
      dx = v.x / sp;
      dz = v.z / sp;
    } else {
      const f = forwardOfThree(tel.quat, this.fwd);
      const fl = Math.hypot(f.x, f.z) || 1;
      dx = f.x / fl;
      dz = f.z / fl;
    }
    const dot = (dx * tan.x + dz * tan.z) / th;
    this.wrongT = dot < -0.35 ? this.wrongT + dt : 0;
    this.rightT = dot > 0.2 ? this.rightT + dt : 0;
    if (!st.wrongWay && this.wrongT > WRONG_WAY_ON_S) {
      st.wrongWay = true;
      this.events.push({ type: 'wrongWay', on: true });
    } else if (st.wrongWay && this.rightT > WRONG_WAY_OFF_S) {
      st.wrongWay = false;
      this.events.push({ type: 'wrongWay', on: false });
    }
  }

  private recordGhost(tel: Readonly<CarTelemetry>): void {
    if (!this.recorder.recording) return;
    if (this.runSteps % GHOST_STEP_DIV === 0) this.recorder.push(tel.pos, tel.quat, tel.steerAngle);
  }

  private updateMessage(): void {
    const st = this.state;
    let m: string | null = null;
    if (st.phase === 'countdown') m = String(Math.max(1, Math.ceil(st.countdown - 1e-9)));
    else if (st.phase === 'finished') m = 'FINISH';
    else if (st.phase === 'running') {
      if (st.time < GO_MESSAGE_S) m = 'GO!';
      else if (st.wrongWay) m = 'WRONG WAY';
    }
    st.message = m;
  }
}
