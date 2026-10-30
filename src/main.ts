/**
 * src/main.ts — ARCHITECT-OWNED. Builders must not edit; request changes instead.
 *
 * Wiring: URL params → world (buildStage + attachOriginalWorld) → car sim → renderer → race / input / UI →
 * fixed-step loop. Original assets (public/assets/, docs/ASSETS.md) are optional: `?orig=0` or no manifest →
 * the procedural world and visuals.
 *
 * Per rendered frame (requestAnimationFrame):
 *   1. tick = loop.advance(wall dt)                    §1.2 accumulator (0.2 s clamp, timeScale, pause)
 *   2. raw = test override ?? input.poll()             device input once per frame; UI edges handled here
 *   3. tick.steps × physicsStep():                      inputs filtered once per substep (§1.2)
 *        controls = setControls override
 *                 ?? (race not controllable → parked controls: handbrake 1, §5.1)
 *                 ?? autopilot.update()  (if on)
 *                 ?? filter.update(raw)  (gear edges delivered on ONE substep)
 *        car.step(controls, DT); race.fixedUpdate(DT, telemetry)
 *   4. render: the car update's backfire / blow-out flags (src/game/carFlags.ts, one source for the pipe sounds and
 *      flames) → interpolate prev/cur physics pose with alpha (§1.2 [D]) → renderer.update(); UI + audio update.
 *
 * Car: `?car=` (archetype or original car); without it, the original's default car (constants.ts ORIG_DEFAULT_CAR)
 * when the original cars are built, else the awd_wrc archetype car. An original car runs its own handling preset
 * (presets.ts) and chassis hull (CarSimOptions.origCar).
 *
 * Stage: `?stage=`; without it, the first original stage whose render + collision parts are built (PORTED_ORDER:
 * corsica-1-f), else the first procedural stage. The menu lists the built original stages before the procedural ones.
 */
import './style.css';
import { ARCHETYPE_IDS, ARCHETYPES, CAMERA_MODES, DT, ORIG_CAR_IDS, PHYSICS_HZ, TYRE_NAMES, neutralRawInput, parkedControls } from './core/constants';
import { getAssetManifest } from './core/assets';
import { FixedStepLoop } from './core/loop';
import { clamp, copy3, lerp3, qCopy, qSlerp, type Quat, type V3 } from './core/math';
import { deepMergeInto, getPath, partialFromPath, setPath, splitPath } from './core/paths';
import { hashSeed } from './core/rng';
import { mirror, mirrorQuat } from './core/space';
import type {
  ArchetypeId,
  ArchetypeInfo,
  CameraMode,
  CarInfo,
  CarListEntry,
  CarParams,
  CarRenderState,
  CarTelemetry,
  Controls,
  FrameContext,
  FrameStats,
  GameTunables,
  IMenuHost,
  IRaceController,
  ITuningHost,
  LaunchOptions,
  LoadStageOptions,
  ProbeInfo,
  RaceEvent,
  RaceSelection,
  RaceState,
  RawInput,
  Stage,
  StageInfo,
  StageListEntry,
  SurfaceTable,
  Transmission,
  TyreType,
  WorldQuery,
} from './core/types';
import { installTestApi, type TestApiHost } from './debug/testApi';

// builder modules
import { AudioEngine, rendererListener } from './audio/audio';
import { TelemetryOverlay } from './debug/overlay';
import { TuningPanel } from './debug/tuningPanel';
import { Autopilot } from './game/autopilot';
import { CarFlagSource } from './game/carFlags';
import { runOutControls } from './game/driving';
import { normalizeCarSelection, originalStagesFirst, withDefaultOrigCar } from './game/selection';
import { RaceController, START_GRID_BACK_M } from './game/race';
import { isTypingTarget } from './input/bindings';
import { InputManager } from './input/input';
import { loadCarInfo } from './render/orig/car';
import { GameRenderer } from './render/renderer';
import { CarSim } from './sim/car';
import { InputFilter, makeInputFilterConfig } from './sim/inputFilter';
import { makeCarParams, makeSurfaceTable } from './sim/params';
import { origCarArchetype, origCarParams } from './sim/presets';
import { origCarById } from './sim/origCars';
import { Hud } from './ui/hud';
import { Menu } from './ui/menu';
import { toast, uiSettings } from './ui/settings';
import { attachOriginalWorld } from './world/orig';
import { buildStage, listStages } from './world/stages';

const PLAYER_ID = 'player';
/** RaceController.ghostRenderState() uses this id. */
const GHOST_ID = 'ghost';
const TUNABLE_ROOTS = ['car', 'input', 'camera', 'surfaces', 'loop'] as const;
type TunableRoot = (typeof TUNABLE_ROOTS)[number];
/** Race events the test API keeps between two getRaceEvents() calls. */
const API_EVENTS_MAX = 1000;
/** Extra setParam / getParam path (not part of GameTunables): the autopilot's target-speed scale. */
const AUTOPILOT_AGGRESSION = 'autopilot.aggression';

// ------------------------------------------------------------------------------------------- URL params

function parseLaunchOptions(search: string): LaunchOptions {
  const q = new URLSearchParams(search);
  const bool = (k: string, def: boolean) => {
    const v = q.get(k);
    if (v === null) return def;
    return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
  };
  // ?car=<archetype> or ?car=<original car name> (ORIG_CAR_IDS, case-insensitive) → its drive archetype + origCar
  const carQ = q.get('car');
  const origCar = carQ ? (ORIG_CAR_IDS.find((n) => n.toLowerCase() === carQ.toLowerCase()) ?? null) : null;
  const car = origCar
    ? (origCarArchetype(origCar) ?? 'awd_wrc')
    : (ARCHETYPE_IDS as readonly string[]).includes(carQ ?? '') ? (carQ as ArchetypeId) : 'awd_wrc';
  let tyre: TyreType | null = null;
  const tq = q.get('tyre');
  if (tq !== null && tq !== '') {
    const n = Number(tq);
    if (Number.isInteger(n) && n >= 0 && n <= 4) tyre = n as TyreType;
    else {
      const i = TYRE_NAMES.indexOf(tq.toLowerCase());
      if (i >= 0) tyre = i as TyreType;
    }
  }
  const seedQ = q.get('seed');
  const seed = seedQ === null ? 1 : Number.isFinite(Number(seedQ)) ? Math.floor(Number(seedQ)) : hashSeed(seedQ);
  let cam: CameraMode | null = null;
  const cq = q.get('cam');
  if (cq !== null) {
    const n = Number(cq);
    if (Number.isInteger(n) && n >= 0 && n < CAMERA_MODES.length) cam = CAMERA_MODES[n];
    else if ((CAMERA_MODES as readonly string[]).includes(cq)) cam = cq as CameraMode;
  }
  const ts = Number(q.get('timescale') ?? '1');
  const trans: Transmission = q.get('trans') === 'manual' ? 'manual' : 'auto';
  return {
    stage: q.get('stage'),
    car,
    origCar,
    tyre,
    seed,
    cam,
    autopilot: bool('autopilot', false),
    menu: bool('menu', true),
    countdown: bool('countdown', true),
    debug: bool('debug', false),
    tune: bool('tune', false),
    timeScale: Number.isFinite(ts) ? clamp(ts, 0.05, 4) : 1,
    transmission: trans,
    audio: bool('audio', true),
    ghost: bool('ghost', true),
  };
}

// ------------------------------------------------------------------------------------------- App

class App implements IMenuHost, ITuningHost, TestApiHost {
  readonly opts: LaunchOptions;
  private readonly loop = new FixedStepLoop();
  private readonly input: InputManager;
  private readonly filter = new InputFilter();
  private readonly renderer: GameRenderer;
  private readonly race = new RaceController({ startGridBack: START_GRID_BACK_M });
  private readonly autopilot = new Autopilot();
  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly overlay: TelemetryOverlay;
  /** Created in init() after the first stage + car exist (the panel reads tunables in its constructor). */
  private tuning: TuningPanel | null = null;
  private readonly audio = new AudioEngine();
  private readonly surfaces: SurfaceTable = makeSurfaceTable();

  private stage!: Stage;
  private world!: WorldQuery;
  private car!: CarSim;
  private selection: RaceSelection;

  // per-frame / per-step state
  private lastNow = -1;
  private rawOverride: RawInput | null = null;
  private controlsOverride: Controls | null = null;
  private autopilotOn: boolean;
  private lastRaw: RawInput = neutralRawInput();
  private pendingGearUp = false;
  private pendingGearDown = false;
  private prevResetHeld = false;
  private prevPos: V3 = { x: 0, y: 0, z: 0 };
  private prevQuat: Quat = { w: 1, x: 0, y: 0, z: 0 };
  private lastResetCount = -1;
  private justReset = true;
  private events: RaceEvent[] = [];
  /** Race events for the test API (getRaceEvents drains them; the latest API_EVENTS_MAX are kept). */
  private apiEvents: RaceEvent[] = [];
  private frames = 0;
  private physicsSteps = 0;
  private fps = 60;
  private loading = false;
  /** Bumped by every loadSelection: an older load that resumes after a newer one started gives up. */
  private loadToken = 0;
  /** Largest impact impulse over the substeps since the last rendered frame (FrameContext.impactImpulseMax). */
  private frameImpact = 0;
  /** The ghost car mesh is in the renderer (added while the race controller has a ghost pose). */
  private ghostInRenderer = false;
  /** Original car the current CarSim was built for (RaceSelection.car; tuned params are kept only for the same car). */
  private simCar: string | undefined;
  /** `?car=` was given: the URL's choice stands (no default original car). */
  private readonly carFromUrl: boolean;
  /** `?stage=` named a known stage: the URL's choice stands (no default original stage). */
  private readonly stageFromUrl: boolean;
  /** The stage catalogue of the menu and the test API (IMenuHost.listStages): the built original stages first. */
  private stageList: StageListEntry[] = listStages();
  /** The player car's backfire / blow-out flags, once per rendered frame (audio + effects share them). */
  private carFlags = new CarFlagSource(1);
  /** The original cars for the menu (IMenuHost.listCars): availability from manifest.cars, names from cars.json. */
  private carList: CarListEntry[] = ORIG_CAR_IDS.map((id) => this.carEntry(id, id, false));
  private carListReady: Promise<void> = Promise.resolve();
  private readonly api = installTestApi(this);

  constructor(opts: LaunchOptions) {
    this.opts = opts;
    this.carFromUrl = new URLSearchParams(window.location.search).has('car');
    this.autopilotOn = opts.autopilot;
    this.loop.timeScale = opts.timeScale;
    const gameEl = document.getElementById('game')!;
    const hudEl = document.getElementById('hud-root')!;
    const overlayEl = document.getElementById('overlay-root')!;
    this.renderer = new GameRenderer(gameEl);
    this.input = new InputManager(window);
    this.hud = new Hud(hudEl);
    // The first user gesture starts the AudioContext (browser autoplay rules). Registered BEFORE the Menu and in the
    // capture phase: the menu consumes its keys in the capture phase (stopImmediatePropagation), and window capture
    // listeners run in registration order, so a keyboard-only player's first menu key starts the audio (menu meme
    // sounds, countdown). Kept until the context runs: a key that grants no user activation (Esc) retries next time.
    const resumeAudio = () => {
      this.audio.resume();
      if (!this.audio.started) return;
      window.removeEventListener('keydown', resumeAudio, true);
      window.removeEventListener('pointerdown', resumeAudio, true);
    };
    window.addEventListener('keydown', resumeAudio, true);
    window.addEventListener('pointerdown', resumeAudio, true);
    this.menu = new Menu(overlayEl, this);
    this.overlay = new TelemetryOverlay(overlayEl);
    if (opts.cam) this.renderer.setCameraMode(opts.cam);
    this.audio.setEnabled(opts.audio);
    const stages = this.stageList;
    this.stageFromUrl = !!opts.stage && stages.some((s) => s.id === opts.stage);
    const stageId = this.stageFromUrl ? opts.stage! : stages[0].id;
    const entry = stages.find((s) => s.id === stageId)!;
    this.selection = {
      stageId,
      archetype: opts.car,
      ...(opts.origCar ? { car: opts.origCar } : {}),
      tyre: opts.tyre ?? entry.defaultTyre,
      transmission: opts.transmission,
      setup: {},
      steerSensFast: true,
      seed: opts.seed,
    };
    // 3-D audio listener = the render camera (CamListener.con)
    this.audio.setListenerSource(() => rendererListener(this.renderer));
    // M: mute toggle (UI_KEYS.mute; main.ts owns the AudioEngine)
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      this.setAudioEnabled(!this.audio.enabled);
      toast(`Sound ${this.audio.enabled ? 'on' : 'off'}`);
    });
    // auto-pause when the window loses focus or the tab is hidden mid-run (the clock would keep running)
    const autoPause = () => {
      const ph = this.race.state.phase;
      if (this.loading || this.loop.paused || this.menu.visible || (ph !== 'running' && ph !== 'countdown')) return;
      this.setPaused(true);
    };
    window.addEventListener('blur', autoPause);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) autoPause();
    });
  }

  async init(): Promise<void> {
    const start = !this.opts.menu;
    this.carListReady = this.loadCarList(); // in parallel with the first stage load
    await this.defaultToOriginalStage();
    await this.defaultToOriginalCar();
    await this.loadSelection(this.selection, { countdown: start && this.opts.countdown });
    await this.carListReady;
    if (start && !this.opts.countdown) this.race.startNow();
    this.tuning = new TuningPanel(this);
    this.tuning.setOpen(this.opts.tune);
    if (this.opts.menu) this.menu.showMain();
    this.overlay.setVisible(this.opts.debug);
    requestAnimationFrame(this.onFrame);
  }

  // ----------------------------------------------------------------------------------------- loading

  /**
   * With the original stages built (manifest: their `track` render part and `collision` part) the menu lists them
   * first, in the ported catalogue order (PORTED_ORDER; its first, corsica-1-f, is also the first entry of the
   * original's Misc/level/track.lst, "Corsica 1"), then the procedural class stages; without `?stage=` the game
   * starts on the first of them.
   * Without assets (or `?orig=0`) the procedural catalogue and its first stage stay.
   */
  private async defaultToOriginalStage(): Promise<void> {
    const list = originalStagesFirst(listStages(), await getAssetManifest());
    if (!list) return;
    this.stageList = list;
    if (this.stageFromUrl) return;
    this.selection = { ...this.selection, stageId: list[0].id, tyre: this.opts.tyre ?? list[0].defaultTyre };
  }

  /**
   * With the original cars built and no `?car=`, the game starts in the original's default car
   * (constants.ts ORIG_DEFAULT_CAR) instead of the procedural archetype car; without assets (or `?orig=0`) the
   * archetype car stays.
   */
  private async defaultToOriginalCar(): Promise<void> {
    if (this.carFromUrl || this.selection.car) return;
    this.selection = withDefaultOrigCar(this.selection, await getAssetManifest(), this.carFromUrl);
  }

  private async loadSelection(sel: RaceSelection, o: { countdown: boolean }): Promise<void> {
    sel = normalizeCarSelection(sel);
    // loads are async (original assets): when calls overlap the LATEST request wins; an older call that
    // resumes after a newer one started returns without touching the state
    const token = ++this.loadToken;
    this.loading = true;
    try {
      // original collision world when its assets are built (src/world/orig; unchanged otherwise, docs/ASSETS.md)
      const built = await attachOriginalWorld(buildStage(sel.stageId, sel.seed));
      if (token !== this.loadToken) return;
      this.stage = built.stage;
      this.world = built.world;
      this.makeCar(sel);
      // the player car's visual loads alongside the stage, and the race begins only once both are in: the original
      // loads the car with the race, so no procedural stand-in is ever seen (addCar settles once the original
      // visual is attached or the fallback decided; frames stay off while `loading`)
      const stageLoad = this.renderer.loadStage(this.stage);
      this.renderer.removeCar(GHOST_ID);
      this.ghostInRenderer = false;
      this.renderer.removeCar(PLAYER_ID);
      const carLoad = this.renderer.addCar(PLAYER_ID, sel.archetype, { player: true, origCar: sel.car });
      await Promise.all([stageLoad, carLoad]);
      if (token !== this.loadToken) return; // a newer load owns the renderer / stage / car now
      this.beginRace(sel, o);
    } finally {
      if (token === this.loadToken) this.loading = false;
    }
  }

  /** A fresh CarSim for `sel` on the loaded world. */
  private makeCar(sel: RaceSelection): void {
    // tuned parameters survive a reload of the same car; an original car starts from its own data (presets.ts)
    const same = this.car && this.car.params.archetype === sel.archetype && this.simCar === sel.car;
    const keep = same ? (this.car.params as CarParams) : null;
    const params = keep ?? (sel.car ? origCarParams(sel.car) : makeCarParams(sel.archetype));
    this.simCar = sel.car;
    deepMergeInto(params, {
      tyreType: sel.tyre,
      transmission: sel.transmission,
      setup: sel.setup,
      steerSensFast: sel.steerSensFast,
    });
    // an original car probes with its own Car_<Name>.col hull (CarSimOptions.origCar); the player is car 0
    this.car = new CarSim({ id: PLAYER_ID, params, world: this.world, surfaces: this.surfaces, seed: sel.seed, origCar: sel.car ?? null, slotBase: 0 });
    this.carFlags = new CarFlagSource(sel.seed);
  }

  /** A new race of the loaded stage with the current car (placed at the start, parked; countdown or idle). */
  private beginRace(sel: RaceSelection, o: { countdown: boolean }): void {
    // best times / ghost keyed by the original car (IRaceController.begin origCar; race builder)
    const beginOpts: Parameters<IRaceController['begin']>[2] = { countdown: o.countdown, world: this.world, origCar: sel.car };
    this.race.begin(this.stage, this.car, beginOpts);
    this.filter.reset();
    this.autopilot.reset();
    this.autopilot.world = this.world; // obstacle avoidance (the original stages' object proxies)
    this.loop.reset();
    this.pendingGearUp = this.pendingGearDown = false;
    this.snapInterpolation();
    this.selection = { ...sel, setup: { ...sel.setup } };
    this.tuning?.refresh();
  }

  /**
   * A race on the LOADED stage (menu Restart / Backspace, or Start with the same stage and seed): a fresh car and race
   * on the same world, stage view and textures instead of a full loadSelection (which re-fetched and re-uploaded
   * 250-420 files per ported stage). The car visual is swapped only when the car changed. The collision world keeps
   * its per-slot face cache, as the original does on a restart (src/world/orig/world.ts resetFaceCache); the renderer
   * clears the last run's particles, skid marks and emitters. `selection` always describes the loaded stage and car
   * (loadSelection / setArchetype / setParam keep it in step).
   */
  private async restartInPlace(sel: RaceSelection): Promise<void> {
    const carChanged = sel.archetype !== this.car.params.archetype || sel.car !== this.simCar;
    if (carChanged) {
      // a new car: its visual is in before the race begins, as in loadSelection (no procedural stand-in)
      const token = ++this.loadToken;
      this.loading = true;
      try {
        this.renderer.removeCar(GHOST_ID);
        this.ghostInRenderer = false;
        this.renderer.removeCar(PLAYER_ID);
        await this.renderer.addCar(PLAYER_ID, sel.archetype, { player: true, origCar: sel.car });
        if (token !== this.loadToken) return; // a newer load owns the renderer / car now
      } finally {
        if (token === this.loadToken) this.loading = false;
      }
    }
    this.makeCar(sel);
    this.beginRace(sel, { countdown: true });
    this.renderer.resetStageEffects();
  }

  private snapInterpolation(): void {
    const t = this.car.telemetry();
    this.prevPos = copy3(t.posSim);
    this.prevQuat = qCopy(t.quatSim);
    this.lastResetCount = t.resetCount;
    this.justReset = true;
  }

  // ----------------------------------------------------------------------------------------- frame

  private readonly onFrame = (now: number): void => {
    requestAnimationFrame(this.onFrame);
    const raw = this.lastNow < 0 ? 0 : (now - this.lastNow) / 1000;
    this.lastNow = now;
    if (this.loading) return;
    this.frame(raw);
  };

  private frame(rawDt: number): void {
    const tick = this.loop.advance(rawDt);
    this.pollInput();
    for (let i = 0; i < tick.steps; i++) this.physicsStep();
    this.render(tick.frameDt, tick.alpha, tick.steps);
  }

  /** Device / override input once per frame; UI edges handled here; gear edges latched for one substep. */
  private pollInput(): void {
    const dev = this.input.poll(); // always poll so device edges never pile up
    let raw = dev;
    if (this.rawOverride) {
      raw = { ...this.rawOverride };
      // API edges fire once
      this.rawOverride.gearUp = this.rawOverride.gearDown = false;
      this.rawOverride.cameraNext = this.rawOverride.pause = false;
    }
    if (raw.gearUp) this.pendingGearUp = true;
    if (raw.gearDown) this.pendingGearDown = true;
    if (raw.cameraNext) this.renderer.nextCamera();
    this.renderer.lookBack(raw.lookBack);
    if (raw.pause && !this.menu.visible) this.setPaused(!this.loop.paused);
    if (raw.reset && !this.prevResetHeld) this.race.requestReset('manual');
    this.prevResetHeld = raw.reset;
    this.lastRaw = raw;
  }

  private physicsStep(): void {
    const raw = this.lastRaw;
    const stepRaw: RawInput = { ...raw, gearUp: this.pendingGearUp, gearDown: this.pendingGearDown };
    this.pendingGearUp = this.pendingGearDown = false;
    const filtered = this.filter.update(stepRaw, DT); // always run so ramps track the keys
    let controls: Controls;
    if (this.controlsOverride) {
      controls = { ...this.controlsOverride };
      this.controlsOverride.gearUp = this.controlsOverride.gearDown = false; // one-shot edges
    } else if (!this.race.isControllable()) {
      // after the finish: a progressive run-out along the road instead of a full handbrake at speed
      const st = this.race.state;
      controls = st.phase === 'finished' && !st.resetting ? runOutControls(this.car.telemetry(), this.stage, st, this.world) : parkedControls();
    } else if (this.autopilotOn) {
      controls = this.autopilot.update(DT, this.car.telemetry(), this.stage, this.race.state);
    } else {
      controls = filtered;
    }
    const before = this.car.telemetry();
    this.prevPos = copy3(before.posSim);
    this.prevQuat = qCopy(before.quatSim);
    this.car.step(controls, DT);
    const tel = this.car.telemetry();
    if (tel.impactImpulse > this.frameImpact) this.frameImpact = tel.impactImpulse;
    this.race.fixedUpdate(DT, tel);
    this.overlay.sample(tel);
    this.physicsSteps++;
    const after = this.car.telemetry();
    if (after.resetCount !== this.lastResetCount) this.snapInterpolation();
  }

  private render(frameDt: number, alpha: number, steps: number): void {
    this.frames++;
    if (frameDt > 0) this.fps += (1 / frameDt - this.fps) * 0.1;
    const tel = this.car.telemetry();
    if (tel.resetCount !== this.lastResetCount) this.snapInterpolation(); // reset outside the step loop
    this.race.frameUpdate(frameDt, tel);
    for (const e of this.race.drainEvents()) {
      this.events.push(e);
      this.apiEvents.push(e);
    }
    if (this.apiEvents.length > API_EVENTS_MAX) this.apiEvents.splice(0, this.apiEvents.length - API_EVENTS_MAX);
    const posSim = lerp3(this.prevPos, tel.posSim, alpha);
    const qSim = qSlerp(this.prevQuat, tel.quatSim, alpha);
    // the car update's backfire / blow-out flags (one source for the pipe sounds and flames); frozen while paused
    const carFlags = this.carFlags.update(this.loop.paused ? 0 : frameDt, tel);
    const cars: CarRenderState[] = [
      {
        id: PLAYER_ID,
        archetype: this.car.params.archetype,
        ...(this.simCar ? { origCar: this.simCar } : {}),
        ghost: false,
        player: true,
        pos: mirror(posSim),
        quat: mirrorQuat(qSim),
        telemetry: tel,
        justReset: this.justReset,
        carFlags,
      },
    ];
    this.justReset = false;
    // best-run ghost (recorded by the race controller; shown while it has a pose for the race clock)
    const ghost = this.opts.ghost ? this.race.ghostRenderState(tel, alpha) : null;
    if (ghost && !this.ghostInRenderer) {
      // not awaited: the ghost's procedural stand-in stays hidden until its original visual is in
      void this.renderer.addCar(GHOST_ID, ghost.archetype, { ghost: true, player: false, origCar: ghost.origCar });
      this.ghostInRenderer = true;
    } else if (!ghost && this.ghostInRenderer) {
      this.renderer.removeCar(GHOST_ID);
      this.ghostInRenderer = false;
    }
    if (ghost) cars.push(ghost);
    this.renderer.update(frameDt, alpha, cars);
    const ctx: FrameContext = {
      frameDt,
      alpha,
      steps,
      paused: this.loop.paused,
      timeScale: this.loop.timeScale,
      telemetry: tel,
      race: this.race.state,
      events: this.events,
      stage: this.stage,
      cameraMode: this.renderer.getCameraMode(),
      autopilot: this.autopilotOn,
      fps: this.fps,
      impactImpulseMax: Math.max(this.frameImpact, tel.impactImpulse),
      audioEnabled: this.audio.enabled,
      // the player car's original car (per-car engine / turbo patches, research/formats/sound.md §4)
      ...(this.simCar ? { origCar: this.simCar } : {}),
      carFlags,
    };
    this.hud.update(ctx);
    this.menu.update(ctx);
    this.overlay.update(ctx);
    this.tuning?.update(ctx);
    this.audio.update(ctx);
    this.events = [];
    this.frameImpact = 0;
    if (!this.api.ready) {
      this.api.ready = true;
      document.getElementById('loading')?.remove();
    }
  }

  // ----------------------------------------------------------------------------------------- IMenuHost

  listStages(): StageListEntry[] {
    return this.stageList.map((e) => ({ ...e }));
  }
  listArchetypes(): ArchetypeInfo[] {
    return ARCHETYPE_IDS.map((id) => ({ ...ARCHETYPES[id] }));
  }
  /** The 29 original cars (ORIG_CAR_IDS order), names from the built cars.json (LocaleEnglish), else the id. */
  listCars(): CarListEntry[] {
    return this.carList.map((c) => ({ ...c }));
  }
  private carEntry(id: string, name: string, available: boolean): CarListEntry {
    const drive = origCarById(id)?.drive ?? 2;
    return { id, name, archetype: origCarArchetype(id) ?? 'awd_wrc', drive: drive === 0 ? 'FWD' : drive === 1 ? 'RWD' : 'AWD', available };
  }
  /** Availability (manifest.cars) and display names (cars/<Name>/cars.json); silent without assets. */
  private async loadCarList(): Promise<void> {
    const m = await getAssetManifest();
    if (!m) return;
    const built = new Set(Object.entries(m.carParts).filter(([, parts]) => parts.includes('cars')).map(([n]) => n));
    this.carList = await Promise.all(
      ORIG_CAR_IDS.map(async (id) => {
        if (!built.has(id)) return this.carEntry(id, id, false);
        const info = await loadCarInfo(id).catch(() => null);
        return this.carEntry(id, info?.name ?? id, info !== null);
      }),
    );
  }
  async startRace(sel: RaceSelection): Promise<void> {
    this.menu.hide();
    this.loop.paused = false;
    sel = normalizeCarSelection(sel);
    // the loaded stage again: no reload (a load in flight takes the full path, whose token makes the latest win)
    if (!this.loading && this.stage && sel.stageId === this.selection.stageId && sel.seed === this.selection.seed) {
      await this.restartInPlace(sel);
      return;
    }
    await this.loadSelection(sel, { countdown: true });
  }
  async restart(): Promise<void> {
    await this.startRace(this.selection);
  }
  setPaused(paused: boolean): void {
    this.loop.paused = paused;
    if (paused) this.menu.showPause();
    else this.menu.hide();
  }
  isPaused(): boolean {
    return this.loop.paused;
  }
  getSelection(): RaceSelection {
    return { ...this.selection, setup: { ...this.selection.setup } };
  }
  getCameraMode(): CameraMode {
    return this.renderer.getCameraMode();
  }
  setAudioEnabled(on: boolean): void {
    this.audio.setEnabled(on);
    if (on) this.audio.resume();
  }
  isAudioEnabled(): boolean {
    return this.audio.enabled;
  }

  // ----------------------------------------------------------------------------------------- ITuningHost

  getTunables(): GameTunables {
    return {
      car: this.car.params as CarParams,
      input: this.filter.config,
      camera: this.renderer.cameraTuning,
      surfaces: this.surfaces,
      loop: { timeScale: this.loop.timeScale, physicsHz: PHYSICS_HZ },
    };
  }

  private route(path: string): { root: TunableRoot; sub: string } {
    const segs = splitPath(path);
    if (segs.length === 0) throw new Error('empty param path');
    if ((TUNABLE_ROOTS as readonly string[]).includes(segs[0]) && segs.length > 1) {
      return { root: segs[0] as TunableRoot, sub: segs.slice(1).join('.') };
    }
    return { root: 'car', sub: segs.join('.') };
  }

  getParam(path: string): unknown {
    if (path === AUTOPILOT_AGGRESSION) return this.autopilot.aggression;
    const { root, sub } = this.route(path);
    return getPath(this.getTunables()[root], sub);
  }

  setParam(path: string, value: unknown): void {
    if (path === AUTOPILOT_AGGRESSION) {
      this.autopilot.aggression = clamp(Number(value), 0.3, 1.2);
      return;
    }
    const { root, sub } = this.route(path);
    const t = this.getTunables();
    if (getPath(t[root], sub) === undefined) throw new Error(`unknown param '${path}'`);
    switch (root) {
      case 'car':
        if (sub === 'archetype') {
          this.setArchetype(value as ArchetypeId);
          return;
        }
        this.car.setParams(partialFromPath(sub, value, this.car.params));
        if (sub === 'tyreType') this.selection.tyre = value as TyreType;
        if (sub === 'transmission') this.selection.transmission = value as Transmission;
        break;
      case 'input':
        this.filter.setConfig(partialFromPath(sub, value, this.filter.config) as Partial<typeof this.filter.config>);
        break;
      case 'camera':
        this.renderer.setCameraTuning(partialFromPath(sub, value, this.renderer.cameraTuning));
        break;
      case 'surfaces':
        setPath(this.surfaces, sub, value);
        this.car.setSurfaces(this.surfaces);
        break;
      case 'loop':
        if (sub === 'timeScale') this.loop.timeScale = clamp(Number(value), 0.05, 4);
        else throw new Error(`'${path}' is read-only`);
        break;
    }
  }

  setArchetype(id: ArchetypeId): void {
    if (!(ARCHETYPE_IDS as readonly string[]).includes(id)) throw new Error(`unknown archetype '${id}'`);
    const p = this.car.params;
    this.car.setParams(
      makeCarParams(id, { tyreType: p.tyreType, transmission: p.transmission, setup: { ...p.setup }, steerSensFast: p.steerSensFast }),
    );
    // an archetype switch (tuning panel) leaves the original car: the archetype car with its procedural visual
    this.selection.archetype = id;
    delete this.selection.car;
    this.simCar = undefined;
    this.car.setOrigCar(null); // the archetype's §3.4 box hull
    this.renderer.removeCar(PLAYER_ID);
    void this.renderer.addCar(PLAYER_ID, id, { player: true }); // an archetype car: settles at once
    this.tuning?.refresh();
  }

  resetToOriginal(): void {
    const p = this.car.params;
    const keep = { tyreType: p.tyreType, transmission: p.transmission, setup: { ...p.setup }, steerSensFast: p.steerSensFast };
    // an original car resets to its own data (presets.ts origCarParams), an archetype car to the archetype's
    this.car.setParams(this.simCar ? origCarParams(this.simCar, keep) : makeCarParams(p.archetype, keep));
    this.filter.setConfig(makeInputFilterConfig());
    this.renderer.setCameraTuning(this.renderer.defaultCameraTuning()); // §5.3 + the player car's own CarCamera
    deepMergeInto(this.surfaces, makeSurfaceTable());
    this.car.setSurfaces(this.surfaces);
    this.loop.timeScale = 1;
    this.tuning?.refresh();
  }

  exportJson(): string {
    return JSON.stringify(this.getTunables(), null, 2);
  }

  importJson(json: string): void {
    const o = JSON.parse(json) as Partial<GameTunables>;
    if (o.car) {
      if (o.car.archetype && o.car.archetype !== this.car.params.archetype) this.setArchetype(o.car.archetype);
      this.car.setParams(o.car);
    }
    if (o.input) this.filter.setConfig(o.input);
    if (o.camera) this.renderer.setCameraTuning(o.camera);
    if (o.surfaces) {
      deepMergeInto(this.surfaces, o.surfaces);
      this.car.setSurfaces(this.surfaces);
    }
    if (o.loop && typeof o.loop.timeScale === 'number') this.loop.timeScale = clamp(o.loop.timeScale, 0.05, 4);
    this.tuning?.refresh();
  }

  getTelemetry(): Readonly<CarTelemetry> {
    return this.car.telemetry();
  }

  setAutopilot(on: boolean): void {
    this.autopilotOn = on;
    if (on) this.autopilot.reset();
  }

  getAutopilot(): boolean {
    return this.autopilotOn;
  }

  setFrozen(frozen: boolean): void {
    this.loop.paused = frozen;
  }
  isFrozen(): boolean {
    return this.loop.paused;
  }
  stepPhysics(n: number): void {
    this.stepNow(Math.max(0, Math.floor(n)));
  }
  resetCar(): void {
    this.race.requestReset('api');
  }

  // ----------------------------------------------------------------------------------------- TestApiHost

  telemetry(): Readonly<CarTelemetry> {
    return this.car.telemetry();
  }
  raceState(): Readonly<RaceState> {
    return this.race.state;
  }
  stageInfo(): StageInfo {
    const s = this.stage;
    const hf = s.heightfield;
    return {
      id: s.id,
      name: s.name,
      discipline: s.discipline,
      description: s.description,
      defaultTyre: s.defaultTyre,
      approxLength: s.closed ? s.length : s.finishS - s.startS,
      closed: s.closed,
      laps: s.laps,
      seed: s.seed,
      length: s.length,
      startS: s.startS,
      checkpoints: [...s.checkpoints],
      finishS: s.finishS,
      validRange: [s.validRange[0], s.validRange[1]],
      pacenoteCount: s.pacenotes.length,
      sceneryCount: s.scenery.length,
      roadSamples: s.road.length,
      heightfield: { nx: hf.nx, nz: hf.nz, cellSize: hf.cellSize, originX: hf.originX, originZ: hf.originZ },
    };
  }
  setRawOverride(raw: RawInput | null): void {
    this.rawOverride = raw;
  }
  setControlsOverride(c: Controls | null): void {
    this.controlsOverride = c;
  }
  setLoopPaused(paused: boolean): void {
    this.loop.paused = paused;
  }
  stepNow(n: number): void {
    this.pollInput();
    for (let i = 0; i < n; i++) this.physicsStep();
    this.render(Math.min(0.2, n * DT), this.loop.accumulator * PHYSICS_HZ, n);
  }
  apiReset(): void {
    this.race.requestReset('api');
  }
  teleport(s: number, lateral: number): void {
    this.race.teleport(s, lateral);
    this.snapInterpolation();
  }
  async loadStage(id: string, o: LoadStageOptions): Promise<void> {
    const entry = this.stageList.find((e) => e.id === id);
    if (!entry) throw new Error(`unknown stage '${id}'`);
    // o.origCar picks an original car (its archetype replaces o.car); o.car alone picks the archetype car
    const base = this.getSelection();
    if (o.origCar !== undefined || o.car !== undefined) delete base.car;
    const sel: RaceSelection = {
      ...base,
      ...(o.origCar ? { car: o.origCar } : {}),
      stageId: id,
      archetype: (o.origCar ? origCarArchetype(o.origCar) : undefined) ?? o.car ?? this.selection.archetype,
      tyre: o.tyre ?? (id === this.selection.stageId ? this.selection.tyre : entry.defaultTyre),
      seed: o.seed ?? this.selection.seed,
      transmission: o.transmission ?? this.selection.transmission,
    };
    this.menu.hide();
    await this.loadSelection(sel, { countdown: o.countdown ?? false });
    // a load superseded by a newer one returns early: no frame of the half-loaded newer stage (it renders when done)
    if (!this.loading) this.render(0, 0, 0);
  }
  setCamera(mode: number | CameraMode): void {
    const m = typeof mode === 'number' ? CAMERA_MODES[mode] : mode;
    if (!m || !(CAMERA_MODES as readonly string[]).includes(m)) throw new Error(`unknown camera '${mode}'`);
    this.renderer.setCameraMode(m);
  }
  startRaceNow(): void {
    this.menu.hide();
    this.race.startNow();
  }
  probe(): ProbeInfo {
    const t = this.car.telemetry();
    // the ground level at the car's own height (yHint): under an overpass the road below, not the deck
    const groundY = this.world.heightAt(t.posSim.x, t.posSim.z, t.posSim.y);
    const pr = this.stage.project(t.pos);
    const q = t.quat;
    // car forward = local -Z rotated by the THREE quaternion; up-vector y = 1 - 2(x² + z²)
    const fx = -(2 * (q.x * q.z + q.w * q.y));
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const tg = this.stage.tangentAt(pr.s);
    const dot = (fx * tg.x + fz * tg.z) / Math.max(1e-9, Math.hypot(fx, fz) * Math.hypot(tg.x, tg.z));
    return {
      pos: { x: t.pos.x, y: t.pos.y, z: t.pos.z },
      groundY,
      clearance: t.posSim.y - groundY,
      s: pr.s,
      lateral: pr.lateral,
      heightOffset: pr.heightOffset,
      upY: 1 - 2 * (q.x * q.x + q.z * q.z),
      headingErrDeg: (Math.acos(clamp(dot, -1, 1)) * 180) / Math.PI,
      speedKmh: t.speedKmh,
    };
  }
  drainApiEvents(): RaceEvent[] {
    const out = this.apiEvents;
    this.apiEvents = [];
    return out;
  }
  carInfo(): CarInfo {
    return {
      archetype: this.car.params.archetype,
      origCar: this.simCar ?? null,
      hullCar: this.car.hullCar,
      voice: uiSettings.voice,
    };
  }
  frameStats(): FrameStats {
    return {
      frames: this.frames,
      physicsSteps: this.physicsSteps,
      simTime: this.physicsSteps * DT,
      fps: this.fps,
      paused: this.loop.paused,
      timeScale: this.loop.timeScale,
    };
  }
}

// ------------------------------------------------------------------------------------------- boot

function showFatal(err: unknown): void {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) {
    el.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
    el.classList.add('error');
  }
}

try {
  const app = new App(parseLaunchOptions(window.location.search));
  app.init().catch(showFatal);
} catch (err) {
  showFatal(err);
}
