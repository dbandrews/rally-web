/**
 * src/main.ts — ARCHITECT-OWNED. Builders must not edit; request changes instead.
 *
 * Wiring: URL params → world (buildStage) → car sim → renderer → race / input / UI → fixed-step loop.
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
 *   4. render: interpolate prev/cur physics pose with alpha (§1.2 [D]) → renderer.update(); UI update.
 */
import './style.css';
import { ARCHETYPE_IDS, ARCHETYPES, CAMERA_MODES, DT, PHYSICS_HZ, TYRE_NAMES, neutralRawInput, parkedControls } from './core/constants';
import { FixedStepLoop } from './core/loop';
import { clamp, copy3, lerp3, qCopy, qSlerp, type Quat, type V3 } from './core/math';
import { deepMergeInto, getPath, partialFromPath, setPath, splitPath } from './core/paths';
import { hashSeed } from './core/rng';
import { mirror, mirrorQuat } from './core/space';
import type {
  ArchetypeId,
  ArchetypeInfo,
  CameraMode,
  CarParams,
  CarRenderState,
  CarTelemetry,
  Controls,
  FrameContext,
  FrameStats,
  GameTunables,
  IMenuHost,
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
import { AudioEngine } from './audio/audio';
import { TelemetryOverlay } from './debug/overlay';
import { TuningPanel } from './debug/tuningPanel';
import { Autopilot } from './game/autopilot';
import { runOutControls } from './game/driving';
import { RaceController, START_GRID_BACK_M } from './game/race';
import { isTypingTarget } from './input/bindings';
import { InputManager } from './input/input';
import { GameRenderer, makeCameraTuning } from './render/renderer';
import { CarSim } from './sim/car';
import { InputFilter, makeInputFilterConfig } from './sim/inputFilter';
import { makeCarParams, makeSurfaceTable } from './sim/params';
import { Hud } from './ui/hud';
import { Menu } from './ui/menu';
import { toast } from './ui/settings';
import { buildStage, listStages } from './world/stages';

const PLAYER_ID = 'player';
/** RaceController.ghostRenderState() uses this id. */
const GHOST_ID = 'ghost';
const TUNABLE_ROOTS = ['car', 'input', 'camera', 'surfaces', 'loop'] as const;
type TunableRoot = (typeof TUNABLE_ROOTS)[number];
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
  const carQ = q.get('car');
  const car = (ARCHETYPE_IDS as readonly string[]).includes(carQ ?? '') ? (carQ as ArchetypeId) : 'awd_wrc';
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
  private frames = 0;
  private physicsSteps = 0;
  private fps = 60;
  private loading = false;
  /** Largest impact impulse over the substeps since the last rendered frame (FrameContext.impactImpulseMax). */
  private frameImpact = 0;
  /** The ghost car mesh is in the renderer (added while the race controller has a ghost pose). */
  private ghostInRenderer = false;
  private readonly api = installTestApi(this);

  constructor(opts: LaunchOptions) {
    this.opts = opts;
    this.autopilotOn = opts.autopilot;
    this.loop.timeScale = opts.timeScale;
    const gameEl = document.getElementById('game')!;
    const hudEl = document.getElementById('hud-root')!;
    const overlayEl = document.getElementById('overlay-root')!;
    this.renderer = new GameRenderer(gameEl);
    this.input = new InputManager(window);
    this.hud = new Hud(hudEl);
    this.menu = new Menu(overlayEl, this);
    this.overlay = new TelemetryOverlay(overlayEl);
    if (opts.cam) this.renderer.setCameraMode(opts.cam);
    this.audio.setEnabled(opts.audio);
    const stages = listStages();
    const stageId = opts.stage && stages.some((s) => s.id === opts.stage) ? opts.stage : stages[0].id;
    const entry = stages.find((s) => s.id === stageId)!;
    this.selection = {
      stageId,
      archetype: opts.car,
      tyre: opts.tyre ?? entry.defaultTyre,
      transmission: opts.transmission,
      setup: {},
      steerSensFast: true,
      seed: opts.seed,
    };
    const resumeAudio = () => this.audio.resume();
    window.addEventListener('keydown', resumeAudio, { once: true });
    window.addEventListener('pointerdown', resumeAudio, { once: true });
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
    await this.loadSelection(this.selection, { countdown: start && this.opts.countdown });
    if (start && !this.opts.countdown) this.race.startNow();
    this.tuning = new TuningPanel(this);
    this.tuning.setOpen(this.opts.tune);
    if (this.opts.menu) this.menu.showMain();
    this.overlay.setVisible(this.opts.debug);
    requestAnimationFrame(this.onFrame);
  }

  // ----------------------------------------------------------------------------------------- loading

  private async loadSelection(sel: RaceSelection, o: { countdown: boolean }): Promise<void> {
    this.loading = true;
    try {
      const built = buildStage(sel.stageId, sel.seed);
      this.stage = built.stage;
      this.world = built.world;
      const keep = this.car && this.car.params.archetype === sel.archetype ? (this.car.params as CarParams) : null;
      const params = keep ?? makeCarParams(sel.archetype);
      deepMergeInto(params, {
        tyreType: sel.tyre,
        transmission: sel.transmission,
        setup: sel.setup,
        steerSensFast: sel.steerSensFast,
      });
      this.car = new CarSim({ id: PLAYER_ID, params, world: this.world, surfaces: this.surfaces, seed: sel.seed });
      await this.renderer.loadStage(this.stage);
      this.renderer.removeCar(GHOST_ID);
      this.ghostInRenderer = false;
      this.renderer.removeCar(PLAYER_ID);
      this.renderer.addCar(PLAYER_ID, sel.archetype, { player: true });
      this.race.begin(this.stage, this.car, { countdown: o.countdown, world: this.world });
      this.filter.reset();
      this.autopilot.reset();
      this.loop.reset();
      this.pendingGearUp = this.pendingGearDown = false;
      this.snapInterpolation();
      this.selection = { ...sel, setup: { ...sel.setup } };
      this.tuning?.refresh();
    } finally {
      this.loading = false;
    }
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
      controls = st.phase === 'finished' && !st.resetting ? runOutControls(this.car.telemetry(), this.stage, st) : parkedControls();
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
    for (const e of this.race.drainEvents()) this.events.push(e);
    const posSim = lerp3(this.prevPos, tel.posSim, alpha);
    const qSim = qSlerp(this.prevQuat, tel.quatSim, alpha);
    const cars: CarRenderState[] = [
      {
        id: PLAYER_ID,
        archetype: this.car.params.archetype,
        ghost: false,
        player: true,
        pos: mirror(posSim),
        quat: mirrorQuat(qSim),
        telemetry: tel,
        justReset: this.justReset,
      },
    ];
    this.justReset = false;
    // best-run ghost (recorded by the race controller; shown while it has a pose for the race clock)
    const ghost = this.opts.ghost ? this.race.ghostRenderState(tel, alpha) : null;
    if (ghost && !this.ghostInRenderer) {
      this.renderer.addCar(GHOST_ID, ghost.archetype, { ghost: true, player: false });
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
    return listStages();
  }
  listArchetypes(): ArchetypeInfo[] {
    return ARCHETYPE_IDS.map((id) => ({ ...ARCHETYPES[id] }));
  }
  async startRace(sel: RaceSelection): Promise<void> {
    this.menu.hide();
    this.loop.paused = false;
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
    this.selection.archetype = id;
    this.renderer.removeCar(PLAYER_ID);
    this.renderer.addCar(PLAYER_ID, id, { player: true });
    this.tuning?.refresh();
  }

  resetToOriginal(): void {
    const p = this.car.params;
    this.car.setParams(
      makeCarParams(p.archetype, { tyreType: p.tyreType, transmission: p.transmission, setup: { ...p.setup }, steerSensFast: p.steerSensFast }),
    );
    this.filter.setConfig(makeInputFilterConfig());
    this.renderer.setCameraTuning(makeCameraTuning());
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
    const entry = listStages().find((e) => e.id === id);
    if (!entry) throw new Error(`unknown stage '${id}'`);
    const sel: RaceSelection = {
      ...this.getSelection(),
      stageId: id,
      archetype: o.car ?? this.selection.archetype,
      tyre: o.tyre ?? (id === this.selection.stageId ? this.selection.tyre : entry.defaultTyre),
      seed: o.seed ?? this.selection.seed,
      transmission: o.transmission ?? this.selection.transmission,
    };
    this.menu.hide();
    await this.loadSelection(sel, { countdown: o.countdown ?? false });
    this.render(0, 0, 0);
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
    const groundY = this.world.heightAt(t.posSim.x, t.posSim.z);
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
