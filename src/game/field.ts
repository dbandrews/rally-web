/**
 * src/game/field.ts — OWNED BY THE AI-RACE BUILDER (phase 2, docs/PHASE2_AI.md).
 *
 * `CarField` (IField, src/core/field.ts): the registry of the AI cars of a race. It builds the roster (ai/roster.ts),
 * loads the per-race AI data (ai/aidata.ts), creates one AI CarSim per opponent through the FieldHost main.ts supplies,
 * places them on the grid (grid.ts), runs one AiDriver per car (ai/driver.ts) every physics substep, tracks route
 * distance / laps / finish / stuck-reset / standings, and produces the interpolated CarRenderState and the per-frame
 * audio/HUD views. With no opponents every method is a cheap no-op (the solo race is unchanged).
 *
 * Race rules for the AI cars (docs/orig/race.md "multi-car race"):
 *  - GRID: the original's placement loop (grid.ts, [E] executed). The countdown is the player's: the AI cars are parked
 *    (CarSim.setParked) until the player's race phase is 'running' and are released in the same substep as the player.
 *  - TIMING: the same gates as the player's (timing.ts buildGates) and the same trigger rule (a gate counts only within
 *    20 m of the centre line, FUN_00483470 [E]); the AI clock is the player's race clock (steps · DT from GO).
 *  - FINISH: an AI car that crosses the finish gets the finish braking (stage `trackBraking`, as the player, race.md §1) and
 *    then rolls out under the player's run-out controller (driving.ts). The AI cars keep racing after the player has
 *    finished; the field's standings are final when every AI car has finished or POST_FINISH_LIMIT_S seconds after the
 *    player's finish (the remaining cars are then DNF, ranked by distance) [I: the original's end-of-race rule for AI
 *    participants was not traced; every participant runs the same tracker FUN_004b4170].
 *  - RECOVERY [I]: the original has no traced AI stuck rule beyond the controller's own three-point turn (ai.md §5.6
 *    state machine, in the driver). The field applies the player's hand-of-god rules (race.md §3, FUN_004b3e50 [E] numbers:
 *    |lateral| > 30 m, 5 m below the road, outside the stage's spline range) and the player's [D] stuck rules (upside down
 *    2.5 s, crawling < 3 km/h with a pedal pressed 10 s) with an instant teleport (no fade): back 20 m on the centre line
 *    (in place for stuck / flipped), 100 settle steps (the driver keeps its state: its race-progress base is the lapDist of its
 *    first update).
 */
import {
  AUTO_RESET_BELOW_M,
  AUTO_RESET_LATERAL_M,
  RESET_BACK_M,
  RESET_RAISE,
  SETTLE_STEPS,
  parkedControls,
} from '../core/constants';
import { emptyFieldSnapshot } from '../core/field';
import type {
  AiOpponentSpec,
  CarFieldOptions,
  FieldCarSnapshot,
  FieldEvent,
  FieldHost,
  FieldSnapshot,
  FieldStepContext,
  IField,
  OtherCarFrame,
  StandingEntry,
} from '../core/field';
import { normS, simPoseOnStage, START_RAISE } from '../core/stageUtil';
import type {
  CarFlags,
  CarRenderState,
  CarTelemetry,
  Controls,
  ICarSim,
  RaceSelection,
  RaceState,
  Stage,
  ThreeQuat,
  WorldQuery,
} from '../core/types';
import { loadAiSchedule, loadAiStageData } from './ai/aidata';
import { createAiDriver } from './ai/driver';
import type { AiDriver, AiDriverInit, AiDriverInputX, AiOtherCar, AiStageData } from './ai/driver';
import { buildRosterInfo, prettyCarName } from './ai/roster';
import { rankRacers, type Racer } from './ai/standings';
import { CarFlagSource } from './carFlags';
import { runOutControls } from './driving';
import { gridSimPose, gridSlot, stageGrid, stageSpawnGrid } from './grid';
import { START_GRID_BACK_M, TRIGGER_LATERAL_M } from './race';
import { liftAboveGround, upYOfQuat } from './stageMath';
import { buildGates, crossingTime, roundMs, wrapDelta, type TimingGate } from './timing';

/** Seconds after the player's finish that the AI cars get to finish before the standings are final (DNF after). [I] */
export const POST_FINISH_LIMIT_S = 90;
/** The player's [D] stuck rules, applied to the AI cars (race.ts FLIPPED_S / CRAWL_S / CRAWL_KMH). */
const FLIPPED_S = 2.5;
const CRAWL_S = 10;
const CRAWL_KMH = 3;
/** The grid row behind the first may sit at the range minimum itself (hillclimb-3a-f: spawn 54, range 48): the range check lets it be. */
const RANGE_SLACK_M = 0.5;
/** Half width of a car body for the overtake machine: wheel track half width + a tyre (other+0x9c) [I]. */
const BODY_HALF_EXTRA_M = 0.2;

/** Options beyond the contract's (tests inject the pieces that need assets). */
export interface CarFieldDeps {
  /** Display name of an original car (default: prettyCarName; main.ts sets the locale name). */
  nameOf?: (id: string) => string;
  /** Replace the AI controller factory (tests). */
  createDriver?: (init: AiDriverInit) => AiDriver;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Everything the field keeps per AI car. */
class Tracker implements Racer {
  readonly spec: AiOpponentSpec;
  readonly sim: ICarSim;
  readonly driver: AiDriver;
  readonly halfWidth: number;
  // route tracking (the same quantities as RaceController)
  s = 0;
  lateral = 0;
  heightOffset = 0;
  dist = 0;
  prevDist = 0;
  prevS = 0;
  lap = 1;
  nextGate = 0;
  finished = false;
  finishTime = 0;
  finishOrder = 0;
  dnf = false;
  resets = 0;
  /** Why and where (route distance, m) the car was last reset; for the snapshot / tools. */
  lastReset = '';
  flipT = 0;
  crawlT = 0;
  // Racer
  get gridIndex(): number {
    return this.spec.gridIndex;
  }
  controls: Controls = parkedControls();
  runOutControls: Controls = parkedControls();
  runOutTick = 0;
  // interpolation (sim space)
  readonly prevPos: Vec3 = { x: 0, y: 0, z: 0 };
  readonly prevQuat = { w: 1, x: 0, y: 0, z: 0 };
  lastResetCount = -1;
  justReset = true;
  // views (reused)
  readonly input: AiDriverInputX;
  readonly others: AiOtherCar[] = [];
  readonly flagSource: CarFlagSource;
  readonly render: CarRenderState;
  readonly frame: OtherCarFrame;
  readonly snap: FieldCarSnapshot;

  constructor(spec: AiOpponentSpec, sim: ICarSim, driver: AiDriver, tel: CarTelemetry, name: string, seed: number) {
    this.spec = spec;
    this.sim = sim;
    this.driver = driver;
    this.halfWidth = halfWidthOf(sim);
    this.flagSource = new CarFlagSource(seed);
    this.input = { dt: 0, self: tel, s: 0, lateral: 0, lapDist: 0, others: this.others, raceTime: 0, running: false, leaderLapDist: 0 };
    const flags: Readonly<CarFlags> = this.flagSource.flags;
    this.render = {
      id: spec.id,
      archetype: spec.archetype,
      origCar: spec.origCar,
      ghost: false,
      player: false,
      ai: true,
      carIndex: spec.gridIndex,
      pos: { x: 0, y: 0, z: 0 },
      quat: { w: 1, x: 0, y: 0, z: 0 },
      telemetry: tel,
      justReset: true,
      carFlags: flags,
    };
    this.frame = { id: spec.id, kind: 'ai', origCar: spec.origCar, archetype: spec.archetype, name, telemetry: tel, carFlags: flags };
    this.snap = {
      id: spec.id,
      kind: 'ai',
      origCar: spec.origCar,
      name,
      gridIndex: spec.gridIndex,
      slotBase: spec.slotBase,
      pos: { x: 0, y: 0, z: 0 },
      speedKmh: 0,
      s: 0,
      lateral: 0,
      lap: 1,
      steer: 0,
      throttle: 0,
      brake: 0,
      parked: true,
      resets: 0,
      finished: false,
      finishTime: null,
    };
  }
}

/** The player as a Racer (progress read from RaceState). */
class PlayerRacer implements Racer {
  gridIndex = 0;
  finished = false;
  finishTime = 0;
  finishOrder = 0;
  dist = 0;
  prevS = 0;
}

let warnedNoOpponents = false;
let warnedNoAiData = false;

/** Half body width from the wheel track (FL wheel x), a tyre wider; a sim without wheel data (a test fake) gets 0.95 m. */
function halfWidthOf(sim: ICarSim): number {
  const x = (sim.params as { wheelFL?: { x: number } }).wheelFL?.x;
  return (typeof x === 'number' && Number.isFinite(x) ? Math.abs(x) : 0.75) + BODY_HALF_EXTRA_M;
}

export class CarField implements IField {
  private specs: readonly AiOpponentSpec[] = [];
  private simList: readonly ICarSim[] = [];
  private trackers: Tracker[] = [];
  private readonly opts: CarFieldOptions & CarFieldDeps;
  /** Display names (main.ts assigns the locale lookup; a prepared roster's names are fixed at prepare). */
  nameOf: ((id: string) => string) | null = null;

  private stage: Stage | null = null;
  private world: WorldQuery | null = null;
  private gates: TimingGate[] = [];
  private laps = 1;
  private prepareToken = 0;

  // race clock / state
  private started = false;
  private steps = 0;
  private clock = 0;
  private finishCounter = 0;
  private readonly player = new PlayerRacer();
  private playerOther: AiOtherCar = { id: 'player', isPlayer: true, pos: { x: 0, y: 0, z: 0 }, speedKmh: 0, s: 0, lateral: 0, halfWidth: 0.95 };
  private playerFinishedAt = -1;
  private events: FieldEvent[] = [];
  private frameDt = 0;
  private readonly parkedCtl = parkedControls();
  private readonly ranked: Racer[] = [];
  private readonly snapshotObj: FieldSnapshot = emptyFieldSnapshot();
  private readonly standingPool = new Map<string, StandingEntry>();

  constructor(opts: CarFieldOptions & CarFieldDeps = {}) {
    this.opts = opts;
  }

  get opponents(): readonly AiOpponentSpec[] {
    return this.specs;
  }
  get sims(): readonly ICarSim[] {
    return this.simList;
  }

  // =================================================================================== prepare

  async prepare(sel: RaceSelection, stage: Stage, world: WorldQuery, host: FieldHost): Promise<readonly AiOpponentSpec[]> {
    const token = ++this.prepareToken;
    const n = sel.opponents ?? 0;
    this.playerCar = sel.car;
    this.stage = stage;
    this.world = world;
    let specs: AiOpponentSpec[] = [];
    let eventCode: string | null = null;
    if (n > 0) {
      if (this.opts.specs) specs = this.opts.specs.slice(0, n).map((s) => ({ ...s }));
      else {
        const named = this.nameOf ?? this.opts.nameOf;
        const info = buildRosterInfo(sel, stage, (id) => {
          const nm = named?.(id);
          return nm && nm !== id ? nm : prettyCarName(id);
        });
        specs = info.specs;
        eventCode = info.event?.code ?? null;
        if (!specs.length || !stageSpawnGrid(stage)) {
          specs = [];
          if (!warnedNoOpponents) {
            warnedNoOpponents = true;
            console.info(`[field] no AI opponents on '${stage.id}': only the original stages (Misc/events rosters, AiData) have them`);
          }
        }
      }
    }
    if (!specs.length) {
      if (token === this.prepareToken) this.drop();
      return this.specs;
    }
    // the per-race AI data: the stage's AiData posts once, the AiTimes schedule per car (null without the `ai` asset part)
    const data: AiStageData | null = await loadAiStageData(stage.id).catch(() => null);
    const schedules = await Promise.all(specs.map((sp) => loadAiSchedule(stage.id, sp.origCar, eventCode).catch(() => null)));
    if (token !== this.prepareToken) return this.specs; // a newer prepare owns the field
    if (!data && !this.opts.specs) {
      // the `ai` asset part is not built / not deployed: the controller has no AiData posts (speed targets), so a default-valued
      // opponent would not be the original's driver. Race solo instead of faking one (test hook `specs` keeps its cars).
      if (!warnedNoAiData) {
        warnedNoAiData = true;
        console.info(`[field] no AiData for '${stage.id}' (asset part 'ai' not built): racing without opponents`);
      }
      this.drop();
      return this.specs;
    }
    const make = this.opts.createDriver ?? createAiDriver;
    const trackers: Tracker[] = specs.map((sp, i) => {
      const sim = host.createCar(sp, world, sel);
      const driver = make({ spec: sp, stage, world, data, schedule: schedules[i] });
      return new Tracker(sp, sim, driver, sim.telemetry(), sp.name, (sel.seed >>> 0) + sp.gridIndex * 7919);
    });
    this.gates = buildGates(stage);
    this.laps = stage.closed ? Math.max(1, Math.floor(stage.laps || 1)) : 1;
    this.trackers = trackers;
    this.specs = specs;
    this.simList = trackers.map((t) => t.sim);
    this.wireOthers();
    this.started = false;
    return this.specs;
  }

  /** Each car's `others` list: the player first, then the other AI cars (objects reused every substep). */
  private wireOthers(): void {
    for (const t of this.trackers) {
      t.others.length = 0;
      t.others.push(this.playerOther);
    }
    for (const t of this.trackers) {
      for (const o of this.trackers) {
        if (o === t) continue;
        t.others.push({ id: o.spec.id, isPlayer: false, pos: { x: 0, y: 0, z: 0 }, speedKmh: 0, s: 0, lateral: 0, halfWidth: o.halfWidth });
      }
    }
  }

  private drop(): void {
    this.specs = [];
    this.simList = [];
    this.trackers = [];
    this.events = [];
    this.started = false;
    this.ranked.length = 0;
    this.standingPool.clear();
    Object.assign(this.snapshotObj, emptyFieldSnapshot());
  }

  // =================================================================================== begin

  begin(race: Readonly<RaceState>): void {
    const stage = this.stage;
    if (!stage || !this.trackers.length) return;
    const grid = stageGrid(stage, START_GRID_BACK_M);
    const count = 1 + this.trackers.length;
    this.started = false;
    this.steps = 0;
    this.clock = 0;
    this.finishCounter = 0;
    this.playerFinishedAt = -1;
    this.events = [];
    this.player.finished = false;
    this.player.finishTime = 0;
    this.player.finishOrder = 0;
    this.player.prevS = race.s;
    this.player.dist = stage.closed ? wrapDelta(race.s - stage.startS, stage.length) : race.s - stage.startS;
    for (const t of this.trackers) {
      const pose = liftAboveGround(stage, gridSimPose(stage, grid, t.spec.gridIndex, count, START_RAISE), START_RAISE, this.world);
      t.sim.reset(pose, SETTLE_STEPS);
      t.sim.setParked(true);
      const tel = t.sim.telemetry();
      const pr = stage.project(tel.pos, undefined);
      // the route distance starts from the SLOT's nominal s (the player's does too), so the cars of a row tie before GO and
      // the standings read in grid order; nothing accumulates until the race runs (afterStep)
      const slot = gridSlot(grid, t.spec.gridIndex, count, stage);
      t.s = t.prevS = normS(stage, slot.s);
      t.lateral = pr.lateral;
      t.heightOffset = pr.heightOffset;
      t.dist = t.prevDist = stage.closed ? wrapDelta(slot.s - stage.startS, stage.length) : slot.s - stage.startS;
      t.lap = 1;
      t.nextGate = 0;
      t.finished = false;
      t.finishTime = 0;
      t.finishOrder = 0;
      t.dnf = false;
      t.resets = 0;
      t.lastReset = '';
      t.flipT = t.crawlT = 0;
      t.controls = this.parkedCtl;
      t.driver.reset();
      t.flagSource.reset();
      this.snapPose(t, tel);
      t.justReset = true;
    }
  }

  private snapPose(t: Tracker, tel: Readonly<CarTelemetry>): void {
    t.prevPos.x = tel.posSim.x;
    t.prevPos.y = tel.posSim.y;
    t.prevPos.z = tel.posSim.z;
    t.prevQuat.w = tel.quatSim.w;
    t.prevQuat.x = tel.quatSim.x;
    t.prevQuat.y = tel.quatSim.y;
    t.prevQuat.z = tel.quatSim.z;
    t.lastResetCount = tel.resetCount;
  }

  // =================================================================================== per substep

  step(dt: number, ctx: FieldStepContext): void {
    const ts = this.trackers;
    if (!ts.length) return;
    const race = ctx.race;
    // the player as the others see it (previous substep's projection: s / lateral are the race controller's)
    const po = this.playerOther;
    const pt = ctx.player.telemetry;
    po.pos.x = pt.pos.x;
    po.pos.y = pt.pos.y;
    po.pos.z = pt.pos.z;
    po.speedKmh = pt.speedKmh;
    po.s = race.s;
    po.lateral = race.lateral;
    po.halfWidth = halfWidthOf(ctx.player.sim);
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      const tel = t.sim.telemetry();
      // previous pose for the render interpolation
      t.prevPos.x = tel.posSim.x;
      t.prevPos.y = tel.posSim.y;
      t.prevPos.z = tel.posSim.z;
      t.prevQuat.w = tel.quatSim.w;
      t.prevQuat.x = tel.quatSim.x;
      t.prevQuat.y = tel.quatSim.y;
      t.prevQuat.z = tel.quatSim.z;
      // the other AI cars' state for t's overtake machine
      let k = 1;
      for (let j = 0; j < ts.length; j++) {
        if (j === i) continue;
        const o = ts[j];
        const oo = t.others[k++];
        const op = o.sim.telemetry();
        oo.pos.x = op.pos.x;
        oo.pos.y = op.pos.y;
        oo.pos.z = op.pos.z;
        oo.speedKmh = op.speedKmh;
        oo.s = o.s;
        oo.lateral = o.lateral;
      }
      let controls: Controls;
      if (!this.started) controls = this.parkedCtl;
      else if (t.finished || t.dnf) controls = this.runOut(t, tel);
      else {
        const inp = t.input;
        inp.dt = dt;
        inp.self = tel;
        inp.s = t.s;
        inp.lateral = t.lateral;
        inp.lapDist = t.dist;
        inp.leaderLapDist = this.player.dist; // the original's rubber band: the human car owns the mailbox (docs/orig/ai.md section 5)
        inp.raceTime = this.clock;
        inp.running = true;
        controls = t.driver.update(inp);
      }
      t.controls = controls;
      t.sim.step(controls, dt);
      const after = t.sim.telemetry();
      if (after.resetCount !== t.lastResetCount) {
        this.snapPose(t, after);
        t.justReset = true;
      }
    }
  }

  /** The post-finish roll-out (the player's controller, driving.ts): refreshed every 4th substep, no object scan. */
  private runOut(t: Tracker, tel: Readonly<CarTelemetry>): Controls {
    if ((t.runOutTick++ & 3) === 0 || t.controls === this.parkedCtl) t.runOutControls = runOutControls(tel, this.stage!, t, null);
    return t.runOutControls;
  }

  afterStep(dt: number, ctx: FieldStepContext): void {
    const ts = this.trackers;
    const stage = this.stage;
    if (!ts.length || !stage) return;
    const race = ctx.race;
    const ph = race.phase;
    // the shared countdown: the AI cars are released in the substep the player is (RaceController.startNow)
    if (!this.started) {
      if (ph === 'running' || ph === 'finished') {
        this.started = true;
        this.steps = 0;
        for (const t of ts) {
          t.sim.setParked(false);
          t.driver.reset();
        }
      }
    } else this.steps++;
    this.clock = this.steps * dt;

    // the player's progress (continuous route distance) and finish
    const p = this.player;
    if (this.started) {
      if (stage.closed) p.dist += wrapDelta(race.s - p.prevS, stage.length);
      else p.dist = race.s - stage.startS;
      p.prevS = race.s;
    }
    this.playerLap = race.lap;
    if (ph === 'finished' && !p.finished) {
      p.finished = true;
      p.finishTime = race.finishTime ?? race.time;
      p.finishOrder = ++this.finishCounter;
      this.playerFinishedAt = this.clock;
    }
    // standings freeze: every AI car done, or the grace period after the player's finish is over
    if (p.finished && this.playerFinishedAt >= 0 && this.clock - this.playerFinishedAt > POST_FINISH_LIMIT_S) {
      for (const t of ts) if (!t.finished) t.dnf = true;
    }

    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      const tel = t.sim.telemetry();
      const pr = stage.project(tel.pos, t.s);
      t.lateral = pr.lateral;
      t.heightOffset = pr.heightOffset;
      if (!this.started) continue; // on the grid: distance stays the slot's
      t.prevDist = t.dist;
      if (stage.closed) t.dist += wrapDelta(pr.s - t.prevS, stage.length);
      else t.dist = pr.s - stage.startS;
      t.prevS = pr.s;
      t.s = pr.s;
      if (t.finished || t.dnf) continue;
      // gates (the player's rule: counted only within 20 m of the centre line; a trigger that waited counts later)
      const gates = this.gates;
      while (t.nextGate < gates.length && t.dist >= gates[t.nextGate].dist) {
        if (Math.abs(t.lateral) >= TRIGGER_LATERAL_M) break;
        const g = gates[t.nextGate++];
        if (g.kind === 'lap') t.lap = Math.min(this.laps, g.lap + 1);
        else if (g.kind === 'finish') this.finishCar(t, g, dt);
      }
      if (!t.finished) this.recover(t, tel, stage, dt);
    }
  }

  private finishCar(t: Tracker, g: TimingGate, dt: number): void {
    t.finished = true;
    t.finishTime = roundMs(t.prevDist < g.dist ? crossingTime(this.clock, dt, t.prevDist, t.dist, g.dist) : this.clock);
    t.finishOrder = ++this.finishCounter;
    t.lap = this.laps;
    const braking = (this.stage as Stage & { trackBraking?: number }).trackBraking;
    if (typeof braking === 'number' && braking > 0) t.sim.setTrackBraking?.(braking);
    this.events.push({ type: 'aiFinish', id: t.spec.id, time: t.finishTime, position: this.finishCounter });
  }

  /** The hand-of-god and stuck rules for an AI car (header). */
  private recover(t: Tracker, tel: Readonly<CarTelemetry>, stage: Stage, dt: number): void {
    if (stage.discipline === 'testpad') return;
    if (Math.abs(t.lateral) > AUTO_RESET_LATERAL_M) return this.reset(t, 'offTrack', RESET_BACK_M);
    if (t.heightOffset < AUTO_RESET_BELOW_M) return this.reset(t, 'belowTrack', RESET_BACK_M);
    if (!stage.closed && (t.s < stage.validRange[0] - RANGE_SLACK_M || t.s > stage.validRange[1])) return this.reset(t, 'offTrack', RESET_BACK_M);
    const kmh = tel.speedWorldKmh ?? tel.speedKmh;
    t.flipT = upYOfQuat(tel.quat) < 0.3 && kmh < 10 ? t.flipT + dt : 0;
    const asking = t.controls.throttle > 0.3 || t.controls.brake > 0.3;
    t.crawlT = kmh < CRAWL_KMH && asking ? t.crawlT + dt : 0;
    if (t.flipT > FLIPPED_S) return this.reset(t, 'flipped', 0);
    if (t.crawlT > CRAWL_S) return this.reset(t, 'stuck', 0);
  }

  private reset(t: Tracker, reason: 'stuck' | 'offTrack' | 'belowTrack' | 'flipped', back: number): void {
    const stage = this.stage!;
    let s: number;
    let d: number;
    if (stage.closed) {
      d = t.dist - back;
      s = normS(stage, stage.startS + d);
    } else {
      const lo = Math.max(0, stage.validRange[0] + 1);
      const hi = Math.min(stage.length, stage.validRange[1]);
      s = Math.min(hi, Math.max(lo, t.s - back));
      d = s - stage.startS;
    }
    t.sim.reset(liftAboveGround(stage, simPoseOnStage(stage, s, 0, RESET_RAISE), RESET_RAISE, this.world), SETTLE_STEPS);
    // the driver is NOT reset: it keeps its race progress base (lapDist at its first update, ai-brain's AiTimes / overtake
    // bookkeeping) and its own state machine recovers from a standstill (ai.md §5.6 states 2 / 5)
    t.dist = t.prevDist = d;
    t.s = t.prevS = s;
    t.lateral = 0;
    t.heightOffset = 0;
    t.flipT = t.crawlT = 0;
    t.resets++;
    t.lastReset = `${reason}@${Math.round(t.dist)}m t=${Math.round(this.clock * 10) / 10}s`;
    const tel = t.sim.telemetry();
    this.snapPose(t, tel);
    t.justReset = true;
    this.events.push({ type: 'aiReset', id: t.spec.id, reason });
  }

  // =================================================================================== per frame

  renderStates(alpha: number): readonly CarRenderState[] {
    const ts = this.trackers;
    if (!ts.length) return EMPTY_RENDER;
    const out = this.renderOut;
    out.length = ts.length;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      const tel = t.sim.telemetry();
      t.flagSource.update(this.frameDt, tel);
      const rs = t.render;
      // sim-space lerp / slerp, then the z mirror into THREE space (core/space.ts mirror, mirrorQuat)
      const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
      const cp = tel.posSim;
      rs.pos.x = t.prevPos.x + (cp.x - t.prevPos.x) * a;
      rs.pos.y = t.prevPos.y + (cp.y - t.prevPos.y) * a;
      rs.pos.z = -(t.prevPos.z + (cp.z - t.prevPos.z) * a);
      slerpMirror(t.prevQuat, tel.quatSim, a, rs.quat);
      rs.telemetry = tel;
      rs.justReset = t.justReset;
      t.justReset = false;
      out[i] = rs;
    }
    return out;
  }
  private readonly renderOut: CarRenderState[] = [];

  /** The frame's dt (0 while paused) for the AI cars' flag timers: call BEFORE renderStates, like the player's `paused ? 0 : frameDt`. */
  setFrame(frameDt: number, paused: boolean): void {
    this.frameDt = paused ? 0 : frameDt;
  }

  otherFrames(frameDt: number, paused: boolean): readonly OtherCarFrame[] {
    const ts = this.trackers;
    this.setFrame(frameDt, paused);
    if (!ts.length) return EMPTY_FRAMES;
    const out = this.frameOut;
    out.length = ts.length;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      t.frame.telemetry = t.sim.telemetry();
      out[i] = t.frame;
    }
    return out;
  }
  private readonly frameOut: OtherCarFrame[] = [];

  snapshot(): FieldSnapshot {
    const ts = this.trackers;
    const snap = this.snapshotObj;
    if (!ts.length || !this.stage) return snap;
    snap.opponents = ts.length;
    snap.fieldSize = ts.length + 1;
    const total = this.gates.length ? this.gates[this.gates.length - 1].dist : 0;
    // cars
    snap.cars.length = ts.length;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      const tel = t.sim.telemetry();
      const c = t.snap;
      c.pos.x = tel.pos.x;
      c.pos.y = tel.pos.y;
      c.pos.z = tel.pos.z;
      c.speedKmh = tel.speedKmh;
      c.s = t.s;
      c.lateral = t.lateral;
      c.lap = t.lap;
      c.steer = t.controls.steer;
      c.throttle = t.controls.throttle;
      c.brake = t.controls.brake;
      c.parked = tel.parked;
      c.resets = t.resets;
      c.objectHits = tel.collision.objectHits;
      c.finished = t.finished;
      c.finishTime = t.finished ? t.finishTime : null;
      const dbg = t.driver.debug();
      dbg.dnf = t.dnf;
      if (t.resets) dbg.lastReset = t.lastReset;
      dbg.dist = Math.round(t.dist * 100) / 100;
      const prog = total > 0 ? Math.round(Math.min(1, Math.max(0, t.dist / total)) * 10000) / 10000 : 0;
      dbg.progress = prog;
      c.dnf = t.dnf;
      c.progress = prog;
      if (t.resets) c.lastReset = t.lastReset;
      c.ai = dbg;
      snap.cars[i] = c;
    }
    // standings
    const r = this.ranked;
    r.length = 0;
    r.push(this.player);
    for (const t of ts) r.push(t);
    rankRacers(r);
    snap.standings.length = r.length;
    const leader = r[0];
    for (let i = 0; i < r.length; i++) {
      const x = r[i];
      const isPlayer = x === this.player;
      const id = isPlayer ? 'player' : (x as Tracker).spec.id;
      let e = this.standingPool.get(id);
      if (!e) {
        e = { id, name: '', player: isPlayer, position: 0, lap: 1, distance: 0, finished: false, finishTime: null, gapToLeader: null };
        this.standingPool.set(id, e);
      }
      e.name = isPlayer ? this.playerName : (x as Tracker).frame.name;
      const oc = isPlayer ? this.playerCar : (x as Tracker).spec.origCar;
      if (oc) e.origCar = oc;
      else delete e.origCar;
      e.player = isPlayer;
      e.position = i + 1;
      e.lap = isPlayer ? this.playerLap : (x as Tracker).lap;
      e.distance = Math.round(x.dist * 100) / 100;
      e.finished = x.finished;
      e.dnf = !isPlayer && (x as Tracker).dnf;
      e.finishTime = x.finished ? x.finishTime : null;
      e.gapToLeader = i > 0 && x.finished && leader.finished ? roundMs(x.finishTime - leader.finishTime) : null;
      snap.standings[i] = e;
      if (isPlayer) snap.playerPosition = i + 1;
    }
    return snap;
  }
  /** The player's lap and name for the standings (set by afterStep from the race state / the host). */
  playerName = 'You';
  private playerCar: string | undefined;
  private playerLap = 1;

  drainEvents(): FieldEvent[] {
    if (!this.events.length) return [];
    const e = this.events;
    this.events = [];
    return e;
  }

  clear(): void {
    this.prepareToken++;
    this.drop();
    this.stage = null;
    this.world = null;
    this.gates = [];
  }
}

const EMPTY_RENDER: readonly CarRenderState[] = Object.freeze([]) as readonly CarRenderState[];
const EMPTY_FRAMES: readonly OtherCarFrame[] = Object.freeze([]) as readonly OtherCarFrame[];

/** Normalised lerp/slerp of two sim-space quaternions, written as the z-mirrored THREE-space quaternion (mirrorQuat). */
function slerpMirror(a: { w: number; x: number; y: number; z: number }, b: { w: number; x: number; y: number; z: number }, t: number, out: ThreeQuat): void {
  let bw = b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let d = a.w * bw + a.x * bx + a.y * by + a.z * bz;
  if (d < 0) {
    bw = -bw;
    bx = -bx;
    by = -by;
    bz = -bz;
    d = -d;
  }
  let s0: number;
  let s1: number;
  if (d > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const th = Math.acos(d);
    const sin = Math.sin(th);
    s0 = Math.sin((1 - t) * th) / sin;
    s1 = Math.sin(t * th) / sin;
  }
  let w = a.w * s0 + bw * s1;
  let x = a.x * s0 + bx * s1;
  let y = a.y * s0 + by * s1;
  let z = a.z * s0 + bz * s1;
  const l = Math.hypot(w, x, y, z) || 1;
  w /= l;
  x /= l;
  y /= l;
  z /= l;
  out.w = w;
  out.x = -x;
  out.y = -y;
  out.z = z;
}
