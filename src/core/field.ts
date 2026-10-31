/**
 * src/core/field.ts — ARCHITECT-OWNED CONTRACT (phase 2: AI opponents + ghosts, docs/PHASE2_AI.md).
 *
 * The "field" is every car in a race other than the player's physics car: the AI opponents (RallyCars with the
 * original's AI controller, own CarSim each) and, separately, the ghosts (pose-driven, no physics; produced by the
 * RaceController's ghost region, not by the field). Types only (+ tiny pure helpers); no three.js, no DOM.
 *
 * Who implements what (details and file ownership: docs/PHASE2_AI.md):
 *   - `IField` / `CarField` (src/game/field.ts): ai-race builder. Registry of the AI cars: roster, grid, per-substep
 *     controller + sim step, tracking, standings, render states for the frame.
 *   - `AiDriver` (src/game/ai/driver.ts): ai-brain builder. The original AI controller behind a small interface.
 *   - car-car contact (src/sim/contact.ts): sim-contact builder.
 *   - ghosts (src/game/ghosts/**, RaceController ghost region): ghosts builder.
 * Changing a type in this file is a contract request to the architect (the owner of the integration).
 */
import type {
  ArchetypeId,
  CarFlags,
  CarRenderState,
  CarSimOptions,
  CarTelemetry,
  ICarSim,
  RaceSelection,
  RaceState,
  Stage,
  ThreeV3,
  WorldQuery,
} from './types';

/** Most AI opponents in a race: the original builds up to 4 participants (player + 3), FUN_00488590 `cmp edi,4`;
 *  every career event has OpponentCount = 3 (research/formats/ai.md §1, §6). */
export const MAX_OPPONENTS = 3;
/** Id of AI car n (1-based grid index): 'ai1' … 'ai3'. The player is 'player', the ghost 'ghost'. */
export const aiCarId = (gridIndex: number): string => `ai${gridIndex}`;
/** Face-cache slot base of the car at `gridIndex` (24·carIndex; the player is car 0). */
export const slotBaseOfGrid = (gridIndex: number): number => 24 * gridIndex;

// ------------------------------------------------------------------------------------------- roster

/** One AI opponent as the race wants it (ai.md §1, §6). Built by src/game/ai/roster.ts. */
export interface AiOpponentSpec {
  /** 'ai1' … 'ai3' (aiCarId). */
  id: string;
  /** Original car name (ORIG_CAR_IDS): the event's `Car =` list entry, or the AI name table (ai.md §1.1). */
  origCar: string;
  /** Handling archetype of that car (src/sim/presets.ts origCarArchetype). */
  archetype: ArchetypeId;
  /** Display name for standings (the driver name when the original has one, else the car's locale name). */
  name: string;
  /** Skill multiplier, AI car +0x50 (AIAttributeManager group value, ai.md §1.1, §5.1). */
  skill: number;
  /** Tyre scale, AI car +0x38: 0.75 / 0.8 / 1.0 / 1.2 / 1.25 (ai.md §1). */
  tyreScale: number;
  /** Grid index (the player is 0): selects the grid slot (src/game/grid.ts) and the face-cache slots. */
  gridIndex: number;
  /** 24·gridIndex = CarSimOptions.slotBase. */
  slotBase: number;
}

/** What main.ts gives the field so that src/game never constructs a CarSim itself (layering + unit tests). */
export interface FieldHost {
  /**
   * A new AI CarSim for `spec` on `world`: `aiFriction: true`, `slotBase: spec.slotBase`, `origCar`, the car's own
   * preset parameters (src/sim/presets.ts origCarParams) with the stage's recommended tyre. Not yet placed.
   */
  createCar(spec: AiOpponentSpec, world: WorldQuery, sel: RaceSelection): ICarSim;
}

// ------------------------------------------------------------------------------------------- per-frame views

/** A non-player car as the per-frame consumers (audio, HUD) see it. Live references: valid for the frame. */
export interface OtherCarFrame {
  id: string;
  kind: 'ai';
  origCar: string;
  archetype: ArchetypeId;
  name: string;
  telemetry: Readonly<CarTelemetry>;
  /** This car's backfire / blow-out flags (its own CarFlagSource, src/game/carFlags.ts). */
  carFlags?: Readonly<CarFlags>;
}

/** Context main.ts hands the field once per substep. */
export interface FieldStepContext {
  /** The player's physics car (already stepped this substep) and its telemetry. */
  player: { sim: ICarSim; telemetry: Readonly<CarTelemetry> };
  /** The player race controller's state of the previous substep (phase, time, countdown, progress, lap, finish). */
  race: Readonly<RaceState>;
}

// ------------------------------------------------------------------------------------------- standings / snapshot

export interface StandingEntry {
  /** 'player' or an aiCarId. */
  id: string;
  name: string;
  origCar?: string;
  player: boolean;
  /** 1-based race position (finished cars by finish order, then by route distance). */
  position: number;
  /** 1-based current lap (1 on point-to-point stages). */
  lap: number;
  /** Total route distance covered, m (all laps), from the start line. */
  distance: number;
  finished: boolean;
  /** Race time at the finish (s), null while racing. */
  finishTime: number | null;
  /** Seconds behind the leader (null for the leader / unknown). */
  gapToLeader: number | null;
  /** Did not finish (the race ended for it unfinished). Set by the field for AI cars; absent = false. */
  dnf?: boolean;
}

/** JSON-safe state of one AI car (test API `getField`, debug overlay). */
export interface FieldCarSnapshot {
  id: string;
  kind: 'ai';
  origCar: string;
  name: string;
  gridIndex: number;
  slotBase: number;
  /** THREE-space position, km/h, spline distance and lateral offset (m, + right), current lap. */
  pos: ThreeV3;
  speedKmh: number;
  s: number;
  lateral: number;
  lap: number;
  /** The controller's last outputs (steer −1..1, throttle, brake 0..1). */
  steer: number;
  throttle: number;
  brake: number;
  parked: boolean;
  /** Automatic resets / stuck recoveries so far. */
  resets: number;
  /** The car's roadside-object hits so far (the sim's `CarTelemetry.collision.objectHits`: railings, signs, trees), for wall-contact checks. */
  objectHits?: number;
  finished: boolean;
  finishTime: number | null;
  /** Did not finish: the grace period after the player's finish ran out. Always set by CarField; absent = false. */
  dnf?: boolean;
  /** Fraction (0..1) of the whole race (all laps) covered, for the HUD progress-bar markers. Set by CarField. */
  progress?: number;
  /** Why and where the car was last reset, e.g. 'belowTrack@1338m t=60.1s'; absent until the first reset. */
  lastReset?: string;
  /** AI controller internals for tests (state machine, target speed km/h, post index, …); free-form numbers/strings. */
  ai?: Record<string, number | string | boolean>;
}

export interface FieldSnapshot {
  /** AI cars in the race (0 = solo). */
  opponents: number;
  cars: FieldCarSnapshot[];
  /** Everybody incl. the player, sorted by position; empty when solo. */
  standings: StandingEntry[];
  /** The player's 1-based position (1 when solo) and the number of cars racing (player included). */
  playerPosition: number;
  fieldSize: number;
}

export const emptyFieldSnapshot = (): FieldSnapshot => ({ opponents: 0, cars: [], standings: [], playerPosition: 1, fieldSize: 1 });

/** Events of the field (forwarded to FrameContext.fieldEvents; the player's own events stay RaceEvents). */
export type FieldEvent =
  | { type: 'aiFinish'; id: string; time: number; position: number }
  | { type: 'aiReset'; id: string; reason: 'stuck' | 'offTrack' | 'belowTrack' | 'flipped' }
  | { type: 'overtake'; id: string; overtook: string };

// ------------------------------------------------------------------------------------------- the field

/**
 * The AI cars of a race (src/game/field.ts `CarField`, `new CarField()`). Everything is a no-op / empty with no
 * opponents (RaceSelection.opponents 0, the default), so a solo race behaves exactly as before phase 2.
 *
 * Per-substep order in main.ts (the original's, FUN_0049ffe0: all physics, then contacts, then race logic):
 *   player car.step → field.step (AI controllers + AI car.step) → stepCarContacts(player + field.sims)
 *   → race.fixedUpdate → field.afterStep.
 */
export interface IField {
  /** The roster of the prepared race (empty = solo). */
  readonly opponents: readonly AiOpponentSpec[];
  /** The AI CarSims, in grid order (for the contact step). */
  readonly sims: readonly ICarSim[];
  /**
   * Build the roster for `sel` (sel.opponents, the stage, the player's car), load the per-race data (AiData posts,
   * AiTimes schedule) and create the AI sims through `host`. main.ts awaits it with the stage and the player car
   * load, then adds every returned car to the renderer (awaited) before the race begins. Never rejects for missing
   * assets: it resolves [] (a solo race) and logs one warning.
   */
  prepare(sel: RaceSelection, stage: Stage, world: WorldQuery, host: FieldHost): Promise<readonly AiOpponentSpec[]>;
  /** After race.begin(): place every AI car on its grid slot, parked; reset trackers and controllers. */
  begin(race: Readonly<RaceState>): void;
  /** Per substep, after the player's car.step(): AI controllers and the AI cars' sim.step(). */
  step(dt: number, ctx: FieldStepContext): void;
  /** Per substep, after the contact step and race.fixedUpdate(): route tracking, laps/finish, stuck/reset, standings. */
  afterStep(dt: number, ctx: FieldStepContext): void;
  /** Render states of the AI cars for this frame (interpolated with `alpha` like the player; THREE space; reused). */
  renderStates(alpha: number): readonly CarRenderState[];
  /** Live per-frame views for audio / HUD (FrameContext.others). */
  otherFrames(frameDt: number, paused: boolean): readonly OtherCarFrame[];
  /** Standings + JSON-safe car states (FrameContext.field, test API getField). */
  snapshot(): FieldSnapshot;
  drainEvents(): FieldEvent[];
  /** Drop the AI cars (stage change / dispose). */
  clear(): void;
}

/** Options the ai-race builder may add to the constructor of CarField (kept here so tests can import the shape). */
export interface CarFieldOptions {
  /** Test hook: use these specs instead of building the roster. */
  specs?: readonly AiOpponentSpec[];
}

/** Type re-check helper for CarSimOptions as the AI cars use it (documentation anchor; see FieldHost.createCar). */
export type AiCarSimOptions = CarSimOptions & { aiFriction: true };
