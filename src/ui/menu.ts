/**
 * src/ui/menu.ts — OWNED BY THE GAME BUILDER.
 *
 * Main menu (stage, car, tyre, transmission, §5.5 setup options with our labels: brake balance
 * Rear/Middle/Front, power ratio (AWD only), suspension Soft/Medium/Hard, gear ratio Short/Medium/Long
 * ("Short" = m 1.2), steering Stable/Agile; camera; co-driver calls), pause menu (Esc / P: resume, restart,
 * main menu, help), results screen after a 'finish' event (time, splits vs best, top speed, resets;
 * restart / next stage / main menu) and the help overlay (H). Keyboard (arrows / WASD, Enter, Esc,
 * Backspace), mouse and gamepad (d-pad / stick, A, B, Start) navigable. Lives in `root` (= #overlay-root).
 *
 * While a menu is visible it consumes the navigation keys (capture phase), so the car never sees them, and
 * main.ts ignores the pause edge (the menu handles Esc / P itself).
 *
 * Car row (cars builder): the ORIGINAL cars by their real LocaleEnglish names (IMenuHost.listCars, available =
 * built in the asset manifest; info line = the original menu icon, spec lines and bars from cars/<Name>/cars.json),
 * then the three procedural archetype "class cars" (the handling-lab cars and the only cars without built assets).
 * Picking an original car sets RaceSelection.car + its drive archetype; an archetype car clears `car`. The
 * original cars are listed in the original car-select order (constants.ts ORIG_CAR_MENU_ORDER).
 *
 * Menu sounds: the original's meme sounds (Menu.rff menu/sound/<Name>.wav, research/formats/sound.md §9) through
 * playUiSound: 'Step' on cursor moves (the car select / every frame's "Step sound"), 'Tag' on an option value change
 * (the Options frames' "Change sound"), 'Select' on confirm, 'Back' on back, 'Error' on a refused selection (a
 * disabled row; SelectCarFrame / the track lists' "Cannot select sound"), 'Sweep' when the main menu or the results
 * screen opens (the Navigation screen transitions). 'Unlock' (championship rewards) and 'Screeneffekt' (used by no
 * menu meme) have no rally-web counterpart. Silent without the original sound bank.
 *
 * REQUIRED EXPORTS (contract in src/core/types.ts IMenu):
 *   class Menu implements IMenu
 *     constructor(root: HTMLElement, host: IMenuHost)
 *     readonly visible: boolean
 *     showMain(): void; showPause(): void; hide(): void
 *     update(ctx: Readonly<FrameContext>): void
 *     dispose(): void
 */
import { assetUrl, carPartPath, fetchJson, getAssetManifest } from '../core/assets';
import { audioMode, playUiSound } from '../audio/audio';
import { CAMERA_MODES, DEFAULT_CAMERA, ORIG_CAR_MENU_ORDER, TYRE_NAMES } from '../core/constants';
import type {
  ArchetypeInfo,
  CameraMode,
  CarListEntry,
  FrameContext,
  IMenu,
  IMenuHost,
  RaceSelection,
  StageListEntry,
  TyreType,
} from '../core/types';
import { HelpOverlay } from './help';
import { escapeHtml, firstPad, formatDelta, formatTime, isTypingTarget, readBestTime, setUiSetting, uiSettings } from './settings';
import { injectUiStyles } from './styles';

type Screen = 'none' | 'main' | 'pause' | 'results';

interface Choice {
  label: string;
  sub?: string;
}

interface OptRow {
  id: string;
  label: string;
  choices(): Choice[];
  get(): number;
  set(i: number): void;
  enabled(): boolean;
  info(): string;
}

interface Button {
  id: string;
  label: string;
  primary?: boolean;
  run(): void;
}

/** One entry of the Car row: an original car (listCars) or a procedural archetype car. */
type CarChoice = { kind: 'orig'; id: string; name: string; drive: 'AWD' | 'FWD' | 'RWD'; car: CarListEntry } | { kind: 'arch'; id: string; name: string; drive: 'AWD' | 'FWD' | 'RWD'; arch: ArchetypeInfo };

/** The part of cars/<Name>/cars.json the menu shows (tools/assets/parts/cars.py). */
interface CarMenuInfo {
  name: string;
  specs: string[];
  /** The spec lines one per value ("530 hp", "790 Nm", "1298 kg", "4WD", "5") and their screen labels. */
  specLines?: string[];
  specLabels?: string[];
  sliders: number[] | null;
  /** Bar labels of the car select screen ("Speed", "Handling", "Accel"). */
  sliderLabels?: string[];
  icon: { path: string; width: number; height: number } | null;
}
const carMenuInfo = new Map<string, Promise<CarMenuInfo | null>>();

const CAMERA_LABEL: Record<CameraMode, string> = {
  bumper: 'Bumper',
  bonnet: 'Bonnet',
  chaseNear: 'Chase near',
  chase: 'Chase',
  chaseFar: 'Chase far',
  chaseHigh: 'Chase high',
  tetherHigh: 'Tether high',
  tetherLow: 'Tether low',
};

const DISCIPLINE_LABEL: Record<string, string> = {
  rally: 'Rally stage',
  hillclimb: 'Hill climb',
  rallycross: 'Rallycross',
  ice: 'Ice circuit',
  testpad: 'Test pad',
};

const TYRE_LABEL = ['Tarmac', 'Intermediate', 'Gravel', 'Snow', 'Ice'];

/** §5.5 three-way setup options: values for index 0/1/2 and our labels. */
const SETUP3 = {
  brake: { values: [0.8, 1.0, 1.2], labels: ['Rear', 'Middle', 'Front'] },
  powerRatio: { values: [0.8, 1.0, 1.2], labels: ['Rear', 'Middle', 'Front'] },
  suspension: { values: [0.7, 1.0, 1.3], labels: ['Soft', 'Medium', 'Hard'] },
  gearRatio: { values: [1.2, 1.0, 0.8], labels: ['Short', 'Medium', 'Long'] },
} as const;

const nearestIndex = (values: readonly number[], v: number | undefined): number => {
  const x = v ?? 1;
  let bi = 0;
  for (let i = 1; i < values.length; i++) if (Math.abs(values[i] - x) < Math.abs(values[bi] - x)) bi = i;
  return bi;
};

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const fmtLen = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

interface ResultSnap {
  splits: number[];
  prevSplits: number[] | null;
  closed: boolean;
  laps: number;
}

const deltaCell = (d: number | null): string =>
  `<td class="${d === null ? '' : d <= 0 ? 'rw-fastc' : 'rw-slowc'}">${d === null ? '' : formatDelta(d)}</td>`;

/**
 * Results table rows. Point-to-point: one row per split (cumulative time, delta vs the best run at that split).
 * Lap races: one row per lap (lap time, total, cumulative delta vs best), intermediate splits collapsed, best lap
 * highlighted. Untimed (skipped) splits are NaN and show as dashes.
 */
export function resultRows(z: ResultSnap): string {
  const per = z.splits.length;
  const prevAt = (i: number): number | null => (z.prevSplits && z.prevSplits.length > i && Number.isFinite(z.prevSplits[i]) ? z.prevSplits[i] : null);
  const delta = (i: number): number | null => {
    const pb = prevAt(i);
    return pb === null || !Number.isFinite(z.splits[i]) ? null : z.splits[i] - pb;
  };
  if (z.closed && z.laps > 1 && per >= z.laps) {
    const perLap = Math.max(1, Math.round(per / z.laps));
    const laps: { n: number; idx: number; lap: number }[] = [];
    let prevT = 0;
    for (let k = 1; k <= z.laps; k++) {
      const idx = Math.min(per - 1, k * perLap - 1);
      const t = z.splits[idx];
      laps.push({ n: k, idx, lap: Math.round((t - prevT) * 1000) / 1000 }); // whole ms: equal laps tie
      prevT = t;
    }
    const valid = laps.filter((l) => Number.isFinite(l.lap));
    const bestLap = valid.length ? Math.min(...valid.map((l) => l.lap)) : NaN;
    return (
      '<tr class="rw-th"><td></td><td>Lap</td><td>Total</td><td>Δ best</td></tr>' +
      laps
        .map(
          (l) =>
            `<tr class="${l.lap === bestLap ? 'rw-bestlap' : ''}"><td>${l.n === z.laps ? 'Lap ' + l.n + ' · finish' : 'Lap ' + l.n}</td>` +
            `<td>${formatTime(l.lap)}</td><td>${formatTime(z.splits[l.idx])}</td>${deltaCell(delta(l.idx))}</tr>`,
        )
        .join('')
    );
  }
  return z.splits
    .map((t, i) => `<tr><td>${i === per - 1 ? 'Finish' : `Split ${i + 1}`}</td><td>${formatTime(t)}</td>${deltaCell(delta(i))}</tr>`)
    .join('');
}

export class Menu implements IMenu {
  private readonly host: IMenuHost;
  private readonly el: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly help: HelpOverlay;
  private screen: Screen = 'none';
  private focus = 0;
  /** Editable copy of the selection (read from the host in showMain: main.ts builds the Menu before its
   *  selection exists). */
  private sel: RaceSelection = {
    stageId: '',
    archetype: 'awd_wrc',
    tyre: 0,
    transmission: 'auto',
    setup: {},
    steerSensFast: true,
    seed: 1,
  };
  private stages: StageListEntry[] = [];
  private cars: CarChoice[] = [];
  /** Loaded cars.json extras by car id (filled lazily for the info line). */
  private carInfos = new Map<string, CarMenuInfo>();
  private rows: OptRow[] = [];
  private buttons: Button[] = [];
  private returnTo: Screen = 'none';
  private camera: CameraMode = DEFAULT_CAMERA;
  private lastCtx: Readonly<FrameContext> | null = null;
  private resultsAt = -1;
  private lastFinish: { time: number; best: boolean } | null = null;
  private resultsSnap: {
    time: number;
    best: boolean;
    prevBest: number | null;
    splits: number[];
    prevSplits: number[] | null;
    resets: number;
    top: number;
    stage: string;
    car: string;
    closed: boolean;
    laps: number;
    untimed: boolean;
  } | null = null;
  // gamepad navigation
  private padPrev: boolean[] = [];
  private padRepeatT = 0;
  private padDir = 0;
  private padHoldInit = true;
  /** The original sound bank is built (manifest.audio): the Sound / Co-driver lines name the original samples. */
  private origBank = false;

  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(root: HTMLElement, host: IMenuHost) {
    injectUiStyles();
    this.host = host;
    this.el = document.createElement('div');
    this.el.className = 'rw-menu';
    this.el.innerHTML = '<div class="rw-shade"></div>';
    this.body = document.createElement('div');
    this.el.appendChild(this.body);
    root.appendChild(this.el);
    this.help = new HelpOverlay(root);
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('mousemove', (e) => this.onHover(e));
    window.addEventListener('keydown', this.onKey, true);
    void getAssetManifest().then((m) => {
      this.origBank = !!m?.audio;
      if (this.screen === 'main') this.renderMain();
    });
  }

  /** The original samples play (or will, once the first gesture starts the audio): not the synth fallback. */
  private originalSound(): boolean {
    const mode = audioMode();
    return mode === 'original' || (mode !== 'synth' && this.origBank);
  }

  get visible(): boolean {
    return this.screen !== 'none' || this.help.visible;
  }

  // =================================================================================== screens

  showMain(): void {
    if (this.screen === 'pause') this.returnTo = 'pause';
    else if (this.screen !== 'main') this.returnTo = 'none';
    this.stages = this.host.listStages();
    this.cars = this.carChoices();
    this.sel = this.host.getSelection();
    if (!this.stages.some((s) => s.id === this.sel.stageId) && this.stages.length) this.sel.stageId = this.stages[0].id;
    this.buildMainRows();
    this.screen = 'main';
    this.focus = this.rows.length; // Start button
    this.el.className = 'rw-menu rw-open';
    this.padHoldInit = true;
    this.renderMain();
    playUiSound('Sweep');
  }

  showPause(): void {
    if (this.screen === 'pause') return;
    this.screen = 'pause';
    this.returnTo = 'none';
    this.rows = [];
    this.buttons = [
      { id: 'resume', label: 'Resume', primary: true, run: () => this.host.setPaused(false) },
      { id: 'restart', label: 'Restart stage', run: () => this.restart() },
      { id: 'main', label: 'Main menu', run: () => this.showMain() },
      { id: 'help', label: 'Controls', run: () => this.help.show() },
    ];
    this.focus = 0;
    this.el.className = 'rw-menu rw-open rw-center';
    this.padHoldInit = true;
    this.renderCard();
  }

  hide(): void {
    if (this.screen === 'none' && !this.help.visible) return;
    this.screen = 'none';
    this.resultsAt = -1;
    this.help.hide();
    this.el.className = 'rw-menu';
    this.body.innerHTML = '';
  }

  private showResults(): void {
    const ctx = this.lastCtx;
    if (!ctx) return;
    const r = ctx.race;
    const origId = this.host.getSelection().car;
    const orig = origId ? this.host.listCars?.().find((c) => c.id === origId) : undefined;
    const car = orig ?? this.host.listArchetypes().find((a) => a.id === ctx.telemetry.archetype);
    this.resultsSnap = {
      time: r.finishTime ?? r.time,
      best: this.lastFinish?.best ?? false,
      prevBest: r.bestTime,
      splits: [...r.splits],
      prevSplits: r.bestSplits ? [...r.bestSplits] : null,
      resets: r.resets,
      top: r.topSpeedKmh,
      stage: ctx.stage.name,
      car: car?.name ?? ctx.telemetry.archetype,
      closed: ctx.stage.closed,
      laps: Math.max(1, ctx.stage.laps),
      untimed: !!r.untimed,
    };
    this.screen = 'results';
    this.rows = [];
    this.buttons = [
      { id: 'restart', label: 'Restart', primary: true, run: () => this.restart() },
      { id: 'next', label: 'Next stage', run: () => this.nextStage() },
      { id: 'main', label: 'Main menu', run: () => this.showMain() },
    ];
    this.focus = 0;
    this.el.className = 'rw-menu rw-open rw-center';
    this.padHoldInit = true;
    this.renderCard();
    playUiSound('Sweep');
  }

  // =================================================================================== main menu rows

  private stageEntry(): StageListEntry | undefined {
    return this.stages.find((s) => s.id === this.sel.stageId);
  }
  private carEntry(): CarChoice | undefined {
    return this.cars[this.carIndex()];
  }

  private carIndex(): number {
    const s = this.sel;
    let i = s.car ? this.cars.findIndex((c) => c.kind === 'orig' && c.id === s.car) : -1;
    // an original car whose assets are not built (?car=<Name> with ?orig=0) shows its drive archetype's class car
    if (i < 0) i = this.cars.findIndex((c) => c.kind === 'arch' && c.id === s.archetype);
    return Math.max(0, i);
  }

  /** Original cars (built ones, in the original car-select order), then the archetype class cars. */
  private carChoices(): CarChoice[] {
    const order = (id: string) => {
      const i = ORIG_CAR_MENU_ORDER.indexOf(id);
      return i < 0 ? ORIG_CAR_MENU_ORDER.length : i;
    };
    const orig: CarChoice[] = (this.host.listCars?.() ?? [])
      .filter((c) => c.available)
      .sort((a, b) => order(a.id) - order(b.id) || a.name.localeCompare(b.name))
      .map((c) => ({ kind: 'orig', id: c.id, name: c.name, drive: c.drive, car: c }));
    const arch: CarChoice[] = this.host.listArchetypes().map((a) => ({ kind: 'arch', id: a.id, name: a.name, drive: a.drive, arch: a }));
    return [...orig, ...arch];
  }

  /** cars.json of an original car (icon, spec lines, bars) for the info line; re-renders once loaded. */
  private origInfo(id: string): CarMenuInfo | undefined {
    const have = this.carInfos.get(id);
    if (have) return have;
    let p = carMenuInfo.get(id);
    if (!p) {
      p = fetchJson<CarMenuInfo>(carPartPath(id, 'cars')).catch(() => null);
      carMenuInfo.set(id, p);
    }
    void p.then((v) => {
      if (!v || this.carInfos.has(id)) return;
      this.carInfos.set(id, v);
      if (this.screen === 'main' && this.carEntry()?.id === id) this.renderMain();
    });
    return undefined;
  }

  private buildMainRows(): void {
    const s = this.sel;
    const setup = (key: keyof typeof SETUP3, label: string, info: string, enabled: () => boolean = () => true): OptRow => ({
      id: key,
      label,
      choices: () => SETUP3[key].labels.map((l) => ({ label: l })),
      get: () => nearestIndex(SETUP3[key].values, s.setup[key]),
      set: (i) => {
        s.setup = { ...s.setup, [key]: SETUP3[key].values[i] };
      },
      enabled,
      info: () => info,
    });
    this.rows = [
      {
        id: 'stage',
        label: 'Stage',
        choices: () =>
          this.stages.map((e) => {
            const d = DISCIPLINE_LABEL[e.discipline] ?? e.discipline;
            return { label: e.name, sub: d.toLowerCase() === e.name.toLowerCase() ? undefined : d };
          }),
        get: () => Math.max(0, this.stages.findIndex((e) => e.id === s.stageId)),
        set: (i) => {
          const e = this.stages[i];
          if (!e) return;
          s.stageId = e.id;
          s.tyre = e.defaultTyre;
        },
        enabled: () => this.stages.length > 0,
        info: () => {
          const e = this.stageEntry();
          if (!e) return '';
          const laps = e.closed && e.discipline !== 'testpad' && e.laps > 0 ? ` · ${e.laps} ${e.laps === 1 ? 'lap' : 'laps'}` : '';
          const len = e.discipline === 'testpad' ? `${fmtLen(e.approxLength)} loop` : e.closed ? `${fmtLen(e.approxLength)} lap` : fmtLen(e.approxLength);
          return `<b>${escapeHtml(e.name.toUpperCase())}</b> — ${escapeHtml(DISCIPLINE_LABEL[e.discipline] ?? e.discipline)} · ${len}${laps} · ${escapeHtml(TYRE_LABEL[e.defaultTyre] ?? '')} tyres recommended<br>${escapeHtml(e.description)}`;
        },
      },
      {
        id: 'car',
        label: 'Car',
        choices: () => this.cars.map((c) => ({ label: c.name, sub: c.kind === 'arch' ? `${c.drive} · class car` : c.drive })),
        get: () => this.carIndex(),
        set: (i) => {
          const c = this.cars[i];
          if (!c) return;
          if (c.kind === 'orig') {
            s.car = c.id;
            s.archetype = c.car.archetype;
          } else {
            delete s.car;
            s.archetype = c.arch.id;
          }
        },
        enabled: () => this.cars.length > 0,
        info: () => {
          const c = this.carEntry();
          if (!c) return '';
          if (c.kind === 'orig') {
            const inf = this.origInfo(c.id);
            const icon = inf?.icon
              ? `<img src="${escapeHtml(assetUrl(`cars/${c.id}/${inf.icon.path}`))}" alt="" width="${inf.icon.width}" height="${inf.icon.height}" style="float:left;margin:0 10px 0 0;image-rendering:auto">`
              : '';
            // the car select screen's own labels (LocaleEnglish 50 / 51) and RallySlider2 bars (0..1)
            const bar = (v: number) =>
              `<span style="display:inline-block;width:56px;height:6px;margin:0 8px 1px 4px;background:rgba(255,255,255,.18);vertical-align:middle"><span style="display:block;height:100%;width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%;background:#f5b324"></span></span>`;
            const bars = inf?.sliders?.length
              ? `<br><small>${inf.sliders.map((v, j) => `${escapeHtml(inf.sliderLabels?.[j] ?? '')}${bar(v)}`).join('')}</small>`
              : '';
            const lines = inf?.specLines?.length ? inf.specLines : (inf?.specs ?? []);
            const specs = lines.length
              ? `<br>${lines.map((v, j) => (inf?.specLabels?.[j] ? `<small>${escapeHtml(inf.specLabels[j])}</small> ${escapeHtml(v)}` : escapeHtml(v))).join(' · ')}`
              : '';
            return `${icon}<b>${escapeHtml(c.name.toUpperCase())}</b> · ${c.drive}${specs}${bars}<span style="display:block;clear:both"></span>`;
          }
          const a = c.arch;
          const sw = (n: number) => `<span class="rw-swatch" style="background:#${n.toString(16).padStart(6, '0')}"></span>`;
          return `${sw(a.colors.body)}${sw(a.colors.accent)}${sw(a.colors.stripe)} <b>${escapeHtml(a.name.toUpperCase())}</b> · ${a.drive}<br>${escapeHtml(a.blurb)}`;
        },
      },
      {
        id: 'tyre',
        label: 'Tyres',
        choices: () =>
          TYRE_NAMES.map((_, i) => ({ label: TYRE_LABEL[i], sub: this.stageEntry()?.defaultTyre === i ? 'recommended' : undefined })),
        get: () => s.tyre,
        set: (i) => {
          s.tyre = i as TyreType;
        },
        enabled: () => true,
        info: () => 'The wrong compound for the surface costs real grip. Intermediates are the compromise.',
      },
      {
        id: 'transmission',
        label: 'Gearbox',
        choices: () => [{ label: 'Automatic' }, { label: 'Manual' }],
        get: () => (s.transmission === 'manual' ? 1 : 0),
        set: (i) => {
          s.transmission = i === 1 ? 'manual' : 'auto';
        },
        enabled: () => true,
        info: () => 'Manual: E / Shift up, Q / Z down (RB / LB on a pad). Hold brake at a standstill to reverse in automatic.',
      },
      setup('brake', 'Brake bias', 'Front bias is stable under braking; rear bias helps the car rotate into bends.'),
      setup('powerRatio', 'Power split', 'Four-wheel drive only: front-biased drive pulls straighter, rear-biased drive slides more.', () => this.carEntry()?.drive === 'AWD'),
      setup('suspension', 'Suspension', 'Soft soaks up bumps and jumps; hard is sharper and more precise on smooth roads.'),
      setup('gearRatio', 'Gear ratio', 'Short gears accelerate harder; long gears give a higher top speed.'),
      {
        id: 'steering',
        label: 'Steering',
        choices: () => [{ label: 'Stable' }, { label: 'Agile' }],
        get: () => (s.steerSensFast ? 1 : 0),
        set: (i) => {
          s.steerSensFast = i === 1;
        },
        enabled: () => true,
        info: () => 'Agile lets the rear step out first (rotates on lift-off). Stable lets the front run wide first.',
      },
      {
        id: 'camera',
        label: 'Camera',
        choices: () => CAMERA_MODES.map((m) => ({ label: CAMERA_LABEL[m] })),
        get: () => Math.max(0, CAMERA_MODES.indexOf(this.camera)),
        set: (i) => {
          this.camera = CAMERA_MODES[i] ?? DEFAULT_CAMERA;
          this.host.setCamera(this.camera);
        },
        enabled: () => true,
        info: () => 'Also C in the car (Y on a pad). Hold V to look back.',
      },
      {
        id: 'calls',
        label: 'Co-driver',
        choices: () => [{ label: 'Off' }, { label: 'Notes' }, { label: 'Notes + voice' }],
        get: () => (!uiSettings.pacenoteHud ? 0 : uiSettings.voice ? 2 : 1),
        set: (i) => {
          setUiSetting('pacenoteHud', i > 0);
          setUiSetting('voice', i === 2);
        },
        enabled: () => true,
        info: () =>
          this.originalSound()
            ? 'Pacenotes on rally and hill-climb stages: easy 5, medium 4, hard 3, square 2, hairpin 1. The voice is the original co-driver (the browser speech engine on the procedural stages); N toggles it.'
            : 'Pacenotes on rally and hill-climb stages: severity 6 is nearly flat, 1 is a hairpin. Voice uses the browser speech engine (N toggles it).',
      },
      {
        id: 'sound',
        label: 'Sound',
        choices: () => [{ label: 'Off' }, { label: 'On' }],
        get: () => (this.host.isAudioEnabled() ? 1 : 0),
        set: (i) => this.host.setAudioEnabled(i === 1),
        enabled: () => true,
        info: () =>
          this.originalSound()
            ? 'The original engine, surface, impact, ambience and co-driver samples. M toggles it in the car.'
            : 'Synthesised engine, tyre and impact sounds (the original sound bank is off or not built). M toggles it in the car.',
      },
    ];
    this.buttons = [
      { id: 'start', label: 'Start stage', primary: true, run: () => this.startSelected() },
      { id: 'help', label: 'Controls', run: () => this.help.show() },
    ];
    if (this.returnTo === 'pause') this.buttons.push({ id: 'back', label: 'Back', run: () => this.backToPause() });
  }

  private renderMain(): void {
    const best = readBestTime(this.sel.stageId, this.sel.seed, this.sel.car ?? this.sel.archetype);
    const focusRow = this.focus < this.rows.length ? this.rows[this.focus] : this.rows[0];
    const rows = this.rows
      .map((r, i) => {
        const ch = r.choices();
        const c = ch[r.get()] ?? { label: '—' };
        const cls = `rw-opt${i === this.focus ? ' rw-focus' : ''}${r.enabled() ? '' : ' rw-disabled'}`;
        return (
          `<div class="${cls}" data-row="${i}"><span class="rw-k">${escapeHtml(r.label)}</span>` +
          `<span class="rw-v"><button class="rw-arrow" data-row="${i}" data-d="-1" tabindex="-1">‹</button>` +
          `<span class="rw-val">${escapeHtml(c.label)}${c.sub ? `<small>${escapeHtml(c.sub)}</small>` : ''}</span>` +
          `<button class="rw-arrow" data-row="${i}" data-d="1" tabindex="-1">›</button></span></div>`
        );
      })
      .join('');
    const btns = this.buttons
      .map((b, j) => {
        const i = this.rows.length + j;
        return `<button class="rw-btn${b.primary ? ' rw-primary' : ''}${i === this.focus ? ' rw-focus' : ''}" data-btn="${j}" tabindex="-1">${escapeHtml(b.label)}</button>`;
      })
      .join('');
    this.body.innerHTML =
      `<div class="rw-main">` +
      `<div class="rw-title">Rally<em>/</em>Web</div><div class="rw-subtitle">Rally · hill climb · rallycross · ice racing</div>` +
      `<div class="rw-rows">${rows}</div>` +
      `<div class="rw-info">${focusRow ? focusRow.info() : ''}</div>` +
      `<div class="rw-actions">${btns}<div class="rw-best">Best<b>${best !== null ? formatTime(best) : '—'}</b></div></div>` +
      `<div class="rw-foot"><kbd>↑</kbd><kbd>↓</kbd> select · <kbd>←</kbd><kbd>→</kbd> change · <kbd>Enter</kbd> start · <kbd>H</kbd> controls · <kbd>F1</kbd> tuning</div>` +
      `</div>`;
    this.scrollFocusIntoView();
  }

  private renderCard(): void {
    const ctx = this.lastCtx;
    let head = '';
    if (this.screen === 'pause') {
      const r = ctx?.race;
      head =
        `<h2>Paused</h2><div class="rw-cardsub">${escapeHtml(ctx?.stage.name ?? '')}${r && r.phase !== 'idle' ? ` · ${formatTime(r.time)}` : ''}</div>`;
    } else if (this.screen === 'results' && this.resultsSnap) {
      const z = this.resultsSnap;
      const vs = z.untimed
        ? '<span class="rw-badge rw-slowb">Practice · untimed (teleported)</span>'
        : z.prevBest === null
          ? '<span class="rw-badge rw-newbest">First time set</span>'
          : z.best
            ? `<span class="rw-badge rw-newbest">New best ${formatDelta(z.time - z.prevBest)}</span>`
            : `<span class="rw-badge rw-slowb">${formatDelta(z.time - z.prevBest)} vs best ${formatTime(z.prevBest)}</span>`;
      head =
        `<h2>Stage complete</h2><div class="rw-cardsub">${escapeHtml(z.stage)} · ${escapeHtml(z.car)}</div>` +
        `<div class="rw-bigtime">${formatTime(z.time)}</div>${vs}` +
        `<div class="rw-scroll"><table class="rw-splits">${resultRows(z)}</table></div>` +
        `<div class="rw-stats"><span>Top speed <b>${Math.round(z.top)} km/h</b></span><span>Resets <b>${z.resets}</b></span></div>`;
    }
    const btns = this.buttons
      .map(
        (b, j) =>
          `<button class="rw-btn${b.primary ? ' rw-primary' : ''}${j === this.focus ? ' rw-focus' : ''}" data-btn="${j}" tabindex="-1">${escapeHtml(b.label)}</button>`,
      )
      .join('');
    const foot =
      this.screen === 'pause'
        ? '<kbd>Esc</kbd> <kbd>P</kbd> resume · <kbd>Backspace</kbd> restart · <kbd>H</kbd> controls'
        : '<kbd>Enter</kbd> select · <kbd>Backspace</kbd> restart · <kbd>Esc</kbd> main menu';
    this.body.innerHTML = `<div class="rw-card rw-plate">${head}<div class="${this.screen === 'pause' ? 'rw-col' : 'rw-row-actions'}">${btns}</div><div class="rw-foot">${foot}</div></div>`;
    this.scrollFocusIntoView();
  }

  /** Keyboard / pad focus must stay visible in a short window (the main menu column scrolls). */
  private scrollFocusIntoView(): void {
    const f = this.body.querySelector('.rw-focus') as (HTMLElement & { scrollIntoView?: (o?: ScrollIntoViewOptions) => void }) | null;
    try {
      f?.scrollIntoView?.({ block: 'nearest' });
    } catch {
      /* not supported (tests) */
    }
  }

  private render(): void {
    if (this.screen === 'main') this.renderMain();
    else if (this.screen === 'pause' || this.screen === 'results') this.renderCard();
  }

  // =================================================================================== actions

  private startSelected(): void {
    const sel: RaceSelection = { ...this.sel, setup: { ...this.sel.setup } };
    if (this.carEntry()?.drive !== 'AWD') delete sel.setup.powerRatio;
    this.hide();
    this.returnTo = 'none';
    void this.host.startRace(sel).then(() => this.host.setCamera(this.camera));
  }

  private restart(): void {
    this.hide();
    void this.host.restart();
  }

  private nextStage(): void {
    const stages = this.host.listStages();
    const cur = this.host.getSelection();
    const racing = stages.filter((s) => s.discipline !== 'testpad');
    const list = racing.length ? racing : stages;
    const i = list.findIndex((s) => s.id === cur.stageId);
    const next = list[(i + 1) % list.length];
    if (!next) return this.restart();
    this.hide();
    void this.host.startRace({ ...cur, stageId: next.id, tyre: next.defaultTyre, setup: { ...cur.setup } });
  }

  private backToPause(): void {
    this.returnTo = 'none';
    this.screen = 'none';
    this.showPause();
  }

  private move(d: number): void {
    const n = this.rows.length + this.buttons.length;
    if (n === 0) return;
    let f = this.focus;
    for (let k = 0; k < n; k++) {
      f = (f + d + n) % n;
      if (f >= this.rows.length || this.rows[f].enabled()) break;
    }
    if (f !== this.focus) playUiSound('Step');
    this.focus = f;
    this.render();
  }

  private change(d: number): void {
    if (this.focus < this.rows.length) {
      const r = this.rows[this.focus];
      if (!r.enabled()) {
        playUiSound('Error'); // refused (e.g. power ratio on a 2WD car)
        return;
      }
      const n = r.choices().length;
      if (n === 0) return;
      const before = r.get();
      r.set((before + d + n) % n);
      // stage / car lists: the cursor of the track list / car select ("Step"); option values: "Tag"
      if (r.get() !== before) playUiSound(r.id === 'stage' || r.id === 'car' ? 'Step' : 'Tag');
      this.render();
    } else if (this.screen === 'results' || this.screen === 'main') {
      // left/right moves between buttons on button rows
      const j = this.focus - this.rows.length;
      const nb = this.buttons.length;
      const f = this.rows.length + ((j + d + nb) % nb);
      if (f !== this.focus) playUiSound('Step');
      this.focus = f;
      this.render();
    }
  }

  private activate(): void {
    if (this.focus < this.rows.length) {
      if (this.screen === 'main') {
        playUiSound('Select');
        this.startSelected();
      }
      return;
    }
    const b = this.buttons[this.focus - this.rows.length];
    if (!b) return;
    playUiSound('Select');
    b.run();
  }

  private back(): void {
    if (this.help.visible) {
      playUiSound('Back');
      return this.help.hide();
    }
    if (this.screen === 'pause') {
      playUiSound('Back');
      this.host.setPaused(false);
    } else if (this.screen === 'main' && this.returnTo === 'pause') {
      playUiSound('Back');
      this.backToPause();
    } else if (this.screen === 'results') {
      playUiSound('Back');
      this.showMain();
    }
  }

  // =================================================================================== input

  private handleKey(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    const code = e.code;
    const consume = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (this.help.visible) {
      if (code.startsWith('F') && code.length <= 3) return; // F-keys pass through
      consume();
      if (!e.repeat && (code === 'Escape' || code === 'KeyH' || code === 'Enter' || code === 'Space')) this.help.hide();
      return;
    }
    if (this.screen === 'none') {
      if (e.repeat) return;
      const phase = this.lastCtx?.race.phase ?? 'idle';
      if (code === 'Escape') {
        consume();
        if (phase !== 'idle') this.host.setPaused(true);
        else this.showMain();
      } else if (code === 'Backspace') {
        consume();
        if (phase !== 'idle') this.restart();
      } else if (code === 'KeyH') {
        consume();
        if (phase === 'running' || phase === 'countdown') this.host.setPaused(true);
        this.help.show();
      }
      return;
    }
    // a menu screen is open
    switch (code) {
      case 'ArrowUp':
      case 'KeyW':
        consume();
        this.move(-1);
        return;
      case 'ArrowDown':
      case 'KeyS':
        consume();
        this.move(1);
        return;
      case 'ArrowLeft':
      case 'KeyA':
        consume();
        this.change(-1);
        return;
      case 'ArrowRight':
      case 'KeyD':
        consume();
        this.change(1);
        return;
      case 'Enter':
      case 'Space':
        consume();
        if (!e.repeat) this.activate();
        return;
      case 'Escape':
        consume();
        if (!e.repeat) this.back();
        return;
      case 'KeyP':
        consume();
        if (!e.repeat && this.screen === 'pause') this.host.setPaused(false);
        return;
      case 'Backspace':
        consume();
        if (!e.repeat && this.screen !== 'main') this.restart();
        return;
      case 'KeyH':
        consume();
        if (!e.repeat) this.help.show();
        return;
      default:
        // keep game keys away from the car while a menu is up (F-keys, C camera, etc. pass)
        if (/^(Key[EQRVZ]|Shift|Control|Period|Bracket)/.test(code)) consume();
    }
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const arrow = t.closest('[data-d]') as HTMLElement | null;
    if (arrow) {
      this.focus = Number(arrow.dataset.row);
      this.change(Number(arrow.dataset.d));
      return;
    }
    const btn = t.closest('[data-btn]') as HTMLElement | null;
    if (btn) {
      this.focus = this.rows.length + Number(btn.dataset.btn);
      this.activate();
      return;
    }
    const row = t.closest('[data-row]') as HTMLElement | null;
    if (row) {
      const i = Number(row.dataset.row);
      if (i === this.focus) this.change(1);
      else {
        playUiSound('Step');
        this.focus = i;
        this.render();
      }
    }
  }

  private onHover(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const btn = t.closest('[data-btn]') as HTMLElement | null;
    const row = t.closest('[data-row]') as HTMLElement | null;
    const f = btn ? this.rows.length + Number(btn.dataset.btn) : row ? Number(row.dataset.row) : -1;
    if (f >= 0 && f !== this.focus && (f >= this.rows.length || this.rows[f].enabled())) {
      playUiSound('Step');
      this.focus = f;
      this.render();
    }
  }

  private pollPad(dt: number): void {
    const p = firstPad();
    if (!p) return;
    const down = (i: number) => !!p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > 0.5);
    const now: boolean[] = [];
    for (let i = 0; i < 16; i++) now[i] = down(i);
    if (this.padHoldInit) {
      this.padPrev = now;
      this.padHoldInit = false;
      this.padDir = 0;
      return;
    }
    const edge = (i: number) => now[i] && !this.padPrev[i];
    const ax = p.axes[0] ?? 0;
    const ay = p.axes[1] ?? 0;
    let dir = 0; // 1 up, 2 down, 3 left, 4 right
    if (now[12] || ay < -0.6) dir = 1;
    else if (now[13] || ay > 0.6) dir = 2;
    else if (now[14] || ax < -0.6) dir = 3;
    else if (now[15] || ax > 0.6) dir = 4;
    if (dir !== this.padDir) {
      this.padDir = dir;
      this.padRepeatT = 0.38;
      this.padNav(dir);
    } else if (dir !== 0) {
      this.padRepeatT -= dt;
      if (this.padRepeatT <= 0) {
        this.padRepeatT = 0.13;
        this.padNav(dir);
      }
    }
    if (this.help.visible) {
      if (edge(0) || edge(1) || edge(9)) this.help.hide();
    } else if (edge(0)) this.activate();
    else if (edge(1)) this.back();
    else if (edge(9)) {
      if (this.screen === 'pause') this.host.setPaused(false);
      else if (this.screen === 'main') this.startSelected();
    }
    this.padPrev = now;
  }

  private padNav(dir: number): void {
    if (this.help.visible) return;
    if (dir === 1) this.move(-1);
    else if (dir === 2) this.move(1);
    else if (dir === 3) this.change(-1);
    else if (dir === 4) this.change(1);
  }

  // =================================================================================== per frame

  update(ctx: Readonly<FrameContext>): void {
    this.lastCtx = ctx;
    this.camera = ctx.cameraMode;
    for (const e of ctx.events) {
      if (e.type === 'finish') {
        this.lastFinish = { time: e.time, best: e.best };
        this.resultsAt = now() + 1600; // wall clock: also works while frozen / at low fps
      }
      if (e.type === 'go' || e.type === 'countdown') this.resultsAt = -1;
    }
    if (this.resultsAt > 0 && now() >= this.resultsAt) {
      this.resultsAt = -1;
      if (this.screen === 'none' && ctx.race.phase === 'finished') this.showResults();
    }
    // resumed from outside (test API pause(false)) while the pause card is up
    if (this.screen === 'pause' && !ctx.paused) this.hide();
    if (this.visible) this.pollPad(ctx.frameDt);
    else this.padHoldInit = true;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.help.dispose();
    this.el.remove();
  }
}
