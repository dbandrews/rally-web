/**
 * src/debug/tuningPanel.ts — OWNED BY THE GAME BUILDER.
 *
 * lil-gui live tuning panel of §6. Folders: Quick (archetype, autopilot, time scale, freeze / step, reset,
 * teleport to stage positions / test-pad patches, reset to original, copy / paste JSON), Presets (the built-in,
 * NON-default presets of src/sim/presets.ts, listed first with a ★ — e.g. "Arcade drift (DEVIATION)" — plus named
 * presets in localStorage: save / load / delete; optional "persist tweaks across reloads"), then every §6
 * group (Simulation, Body, Engine, Gearbox incl. per-gear ratios, Drivetrain, Brakes, Suspension, Tyres,
 * Assists, Steering & input, Setup, Surfaces (surface + tyre dropdowns over the live table, μs / μk shown),
 * Camera (incl. the chase entries)), "All other parameters" (every remaining leaf of GameTunables) and a
 * read-only Live telemetry folder. Ranges and steps follow §6 (tuningSchema.ts).
 * All writes go through host.setParam(path, value). Single-value §6 keys that map to per-axle params write
 * 'wheel.front.X' and 'wheel.rear.X'.
 *
 * Keys: F1 or ` toggles the panel, [ / ] time scale, '.' freeze (first press) then single-step (Shift+. = 12
 * steps), F8 autopilot. Freeze / step / teleport / reset go through ITuningHost (setFrozen, stepPhysics,
 * teleport, resetCar).
 *
 * REQUIRED EXPORTS (contract in src/core/types.ts ITuningPanel):
 *   class TuningPanel implements ITuningPanel
 *     constructor(host: ITuningHost)
 *     readonly open: boolean
 *     setOpen(open: boolean): void; toggle(): void
 *     refresh(): void
 *     update(ctx: Readonly<FrameContext>): void
 *     dispose(): void
 */
import GUI, { type Controller } from 'lil-gui';
import { ARCHETYPE_IDS, SURFACE_IDS, TYRE_NAMES } from '../core/constants';
import { getPath } from '../core/paths';
import type { ArchetypeId, FrameContext, ITuningHost, ITuningPanel, Stage, SurfaceId } from '../core/types';
import { presetCarParams, TUNING_PRESETS, type TuningPreset } from '../sim/presets';
import { findTeleportTargets, type TeleportTarget } from './patches';
import { CAMERA_KEYS, coveredPaths, SURFACE_KEYS, SURFACE_TYRE_KEYS, TUNING_SCHEMA, type ParamSpec } from './tuningSchema';
import { copyText, isTypingTarget, jsonModal, store } from './util';

type Model = Record<string, unknown>;

const PRESETS_KEY = 'rally-web:tuning:presets:v1';
const PERSIST_FLAG_KEY = 'rally-web:tuning:persist';
const AUTOSAVE_KEY = 'rally-web:tuning:autosave:v1';
const TIME_SCALES = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
/** Car keys owned by the race selection (menu); never persisted by the autosave. */
const SELECTION_KEYS = ['archetype', 'tyreType', 'transmission', 'steerSensFast'];
const CHASE_MODES = ['chaseNear', 'chase', 'chaseFar', 'chaseHigh'] as const;
/** Built-in presets (src/sim/presets.ts) are listed first under this prefix; they cannot be overwritten or deleted. */
const BUILTIN_PREFIX = '★ ';
const builtinName = (b: TuningPreset): string => BUILTIN_PREFIX + b.label;

interface Autosave {
  v: 1;
  cars: Partial<Record<ArchetypeId, Record<string, unknown>>>;
  input?: unknown;
  camera?: unknown;
  surfaces?: unknown;
}

const PANEL_CSS = `
.lil-gui.rw-tuning { --width: 320px; --name-width: 48%; --font-size: 11px; --widget-height: 18px; --title-background-color: #1b2330; --focus-color: #ffb81c; --number-color: #7fd4ff; --string-color: #b9e986; max-height: 100vh; }
.lil-gui.rw-tuning > .lil-title { background: #ffb81c; color: #0b0f14; font-weight: 700; letter-spacing: .08em; }
.lil-gui.rw-tuning .rw-err { color: #ff7a6e; }
`;

export class TuningPanel implements ITuningPanel {
  private readonly host: ITuningHost;
  private readonly gui: GUI;
  private isOpen = false;
  private lastCtx: Readonly<FrameContext> | null = null;
  private lastArchetype = '';
  private nGears = -1;
  private gearFolder: GUI | null = null;
  private otherFolder: GUI | null = null;
  private idSeq = 0;
  private refreshT = 0;
  private liveT = 0;
  private applying = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private persist = store.get(PERSIST_FLAG_KEY) === '1';
  // quick actions
  private stageKey = '';
  private targets: TeleportTarget[] = [];
  private readonly quick = { s: 0, lateral: 0, target: 0, presetName: 'my setup', preset: '', about: '' };
  private sCtrl: Controller | null = null;
  private targetCtrl: Controller | null = null;
  private presetCtrl: Controller | null = null;
  private aboutCtrl: Controller | null = null;
  // surfaces / camera selections
  private readonly surfSel = { surface: 'gravel' as SurfaceId, tyre: 2, follow: true };
  private readonly camSel = { mode: 'chase' as (typeof CHASE_MODES)[number] };
  private readonly live: Record<string, string | number> = { speed: 0, rpm: 0, gear: '', beta: 0, yaw: 0, aLat: 0, surface: '' };
  private liveCtrls: Controller[] = [];
  private aLatEma = 0;
  private aLatStep = 0;
  private readonly missing: string[] = [];

  private readonly onKey = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const code = e.code;
    if (code === 'F1' || code === 'Backquote') {
      e.preventDefault();
      if (!e.repeat) this.toggle();
    } else if (code === 'BracketLeft' || code === 'BracketRight') {
      e.preventDefault();
      if (!e.repeat) this.bumpTimeScale(code === 'BracketRight' ? 1 : -1);
    } else if (code === 'Period') {
      e.preventDefault();
      this.freezeOrStep(e.shiftKey ? 12 : 1);
    } else if (code === 'F8') {
      e.preventDefault();
      if (!e.repeat) {
        this.host.setAutopilot(!this.host.getAutopilot());
        this.updateAll();
      }
    }
  };

  constructor(host: ITuningHost) {
    this.host = host;
    if (typeof document !== 'undefined' && !document.getElementById('rw-tuning-css')) {
      const st = document.createElement('style');
      st.id = 'rw-tuning-css';
      st.textContent = PANEL_CSS;
      document.head.appendChild(st);
    }
    this.gui = new GUI({ title: 'Handling lab  (F1)', width: 320 });
    this.gui.domElement.classList.add('rw-tuning');
    this.gui.domElement.style.zIndex = '30';
    this.surfSel.tyre = Number(host.getParam('tyreType') ?? 2) || 0;
    this.lastArchetype = String(host.getTunables().car.archetype);
    if (this.persist) this.applyAutosave(true);
    this.build();
    this.setOpen(false);
    window.addEventListener('keydown', this.onKey);
  }

  get open(): boolean {
    return this.isOpen;
  }

  // =================================================================================== building

  private nextId(): string {
    return `p${this.idSeq++}`;
  }

  /** Bind one spec to `folder` through a getter/setter model property. Returns null if the path is absent. */
  private bind(folder: GUI, spec: ParamSpec, root = ''): Controller | null {
    const h = this.host;
    const full = (p: string) => (root ? `${root}.${p}` : p);
    const paths = spec.paths.map(full);
    const read = (): unknown => {
      if (spec.derived === 'mountY') {
        const y = h.getParam('wheelFL.y');
        const r = h.getParam('wheelRadius');
        return typeof y === 'number' && typeof r === 'number' ? Math.round((y - r) * 1e6) / 1e6 : undefined;
      }
      return h.getParam(paths[0]);
    };
    const v0 = read();
    if (v0 === undefined || v0 === null) {
      this.missing.push(paths[0]);
      return null;
    }
    const m: Model = {};
    const id = this.nextId();
    Object.defineProperty(m, id, {
      enumerable: true,
      get: () => {
        const v = read();
        return v === undefined ? v0 : v;
      },
      set: (v: unknown) => {
        if (spec.readOnly) return;
        if (spec.derived === 'mountY') {
          const r = Number(h.getParam('wheelRadius'));
          this.write('wheelFL.y', Number(v) + r);
          this.write('wheelRL.y', Number(v) + r);
        } else for (const p of paths) this.write(p, v);
        if (spec.options || typeof v === 'boolean') this.blurSoon();
      },
    });
    let c: Controller;
    if (spec.options) c = folder.add(m, id, spec.options);
    else if (typeof v0 === 'number' && spec.min !== undefined && spec.max !== undefined) c = folder.add(m, id, spec.min, spec.max, spec.step);
    else c = folder.add(m, id);
    c.name(spec.key);
    if (spec.readOnly) c.disable();
    return c;
  }

  private write(path: string, value: unknown): void {
    try {
      this.host.setParam(path, value);
      this.scheduleAutosave();
    } catch (err) {
      console.warn(`[tuning] setParam('${path}') failed:`, err);
    }
  }

  private blurSoon(): void {
    setTimeout(() => {
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === 'SELECT' || (a.tagName === 'INPUT' && (a as HTMLInputElement).type === 'checkbox'))) a.blur();
    }, 0);
  }

  private build(): void {
    this.buildQuick();
    this.buildPresets();
    for (const f of TUNING_SCHEMA) {
      const folder = this.gui.addFolder(f.title);
      for (const p of f.params) this.bind(folder, p);
      if (f.title === 'Gearbox') this.gearFolder = folder.addFolder('Gear ratios (0 = reverse)');
      folder.close();
    }
    this.buildGears();
    this.buildSurfaces();
    this.buildCamera();
    this.buildOther();
    this.buildLive();
    if (this.missing.length) console.info('[tuning] parameters not present in this build (skipped):', this.missing.join(', '));
  }

  private buildQuick(): void {
    const h = this.host;
    const f = this.gui.addFolder('Quick');
    const m: Model = {};
    const def = (k: string, get: () => unknown, set: (v: unknown) => void) =>
      Object.defineProperty(m, k, { enumerable: true, get, set });
    def('archetype', () => h.getTunables().car.archetype, (v) => {
      h.setArchetype(v as ArchetypeId);
      this.blurSoon();
    });
    def('autopilot', () => h.getAutopilot(), (v) => {
      h.setAutopilot(!!v);
      this.blurSoon();
    });
    def('timeScale', () => Number(h.getParam('loop.timeScale') ?? 1), (v) => this.write('loop.timeScale', Number(v)));
    def('freeze', () => h.isFrozen(), (v) => {
      h.setFrozen(!!v);
      this.blurSoon();
    });
    f.add(m, 'archetype', ARCHETYPE_IDS as unknown as string[]).name('archetype');
    f.add(m, 'autopilot').name('autopilot (F8)');
    f.add(m, 'timeScale', 0.1, 2, 0.05).name('timeScale ([ ])');
    f.add(m, 'freeze').name('freeze (.)');
    const acts = {
      step1: () => this.freezeOrStep(1, true),
      step12: () => this.freezeOrStep(12, true),
      reset: () => h.resetCar(),
      teleport: () => this.teleport(this.quick.s, this.quick.lateral),
      gotoTarget: () => {
        const t = this.targets[this.quick.target];
        if (t) this.teleport(t.s, t.lateral);
      },
      original: () => {
        h.resetToOriginal();
        this.scheduleAutosave();
        this.updateAll();
      },
      copy: () => {
        const json = h.exportJson();
        void copyText(json).then((ok) => {
          if (!ok) jsonModal('copy', json);
          else this.flashTitle('JSON copied');
        });
      },
      paste: () => jsonModal('paste', '', (t) => {
        JSON.parse(t); // validate first: throws into the modal
        h.importJson(t);
        this.scheduleAutosave();
        this.updateAll();
      }),
    };
    f.add(acts, 'step1').name('step 1 substep');
    f.add(acts, 'step12').name('step 0.1 s');
    f.add(acts, 'reset').name('reset car to road');
    const tp = f.addFolder('Teleport');
    this.sCtrl = tp.add(this.quick, 's', 0, 1000, 1).name('s (m along stage)');
    tp.add(this.quick, 'lateral', -40, 40, 0.5).name('lateral (m, + right)');
    tp.add(acts, 'teleport').name('teleport to s / lateral');
    this.targetCtrl = tp.add(this.quick, 'target', { start: 0 }).name('target');
    tp.add(acts, 'gotoTarget').name('go to target');
    tp.close();
    f.add(acts, 'original').name('Reset to original');
    f.add(acts, 'copy').name('Copy JSON');
    f.add(acts, 'paste').name('Paste JSON');
  }

  private buildPresets(): void {
    const f = this.gui.addFolder('Presets');
    const acts = {
      save: () => {
        let name = this.quick.presetName.trim() || `preset ${new Date().toLocaleTimeString()}`;
        while (name.startsWith(BUILTIN_PREFIX.trim())) name = name.slice(BUILTIN_PREFIX.trim().length).trim() || 'my setup';
        const all = this.readPresets();
        all[name] = { created: Date.now(), json: this.host.exportJson() };
        this.writePresets(all);
        this.quick.preset = name;
        this.rebuildPresetList();
        this.flashTitle(`saved "${name}"`);
      },
      load: () => {
        const b = this.builtin(this.quick.preset);
        if (b) {
          this.applyBuiltin(b);
          return;
        }
        const p = this.readPresets()[this.quick.preset];
        if (!p) return;
        try {
          this.host.importJson(p.json);
          this.scheduleAutosave();
          this.updateAll();
          this.flashTitle(`loaded "${this.quick.preset}"`);
        } catch (err) {
          console.warn('[tuning] preset load failed', err);
        }
      },
      del: () => {
        if (this.builtin(this.quick.preset)) {
          this.flashTitle('built-in presets cannot be deleted');
          return;
        }
        const all = this.readPresets();
        delete all[this.quick.preset];
        this.writePresets(all);
        this.quick.preset = '';
        this.rebuildPresetList();
      },
    };
    const pm: Model = {};
    Object.defineProperty(pm, 'persist', {
      enumerable: true,
      get: () => this.persist,
      set: (v: unknown) => {
        this.persist = !!v;
        store.set(PERSIST_FLAG_KEY, this.persist ? '1' : '0');
        if (this.persist) this.saveAutosave();
        else store.remove(AUTOSAVE_KEY);
        this.blurSoon();
      },
    });
    f.add(this.quick, 'presetName').name('name');
    f.add(acts, 'save').name('Save preset');
    this.presetCtrl = f.add(this.quick, 'preset', ['']).name('preset');
    this.aboutCtrl = f.add(this.quick, 'about').name('about (hover)').disable();
    f.add(acts, 'load').name('Load preset');
    f.add(acts, 'del').name('Delete preset');
    f.add(pm, 'persist').name('persist tweaks across reloads');
    f.close();
    this.rebuildPresetList();
  }

  private readPresets(): Record<string, { created: number; json: string }> {
    try {
      const raw = store.get(PRESETS_KEY);
      return raw ? (JSON.parse(raw) as Record<string, { created: number; json: string }>) : {};
    } catch {
      return {};
    }
  }

  private writePresets(p: Record<string, { created: number; json: string }>): void {
    if (!store.set(PRESETS_KEY, JSON.stringify(p))) this.flashTitle('storage full / blocked');
  }

  private rebuildPresetList(): void {
    if (!this.presetCtrl) return;
    const names = [...TUNING_PRESETS.map(builtinName), ...Object.keys(this.readPresets()).sort()];
    if (!names.includes(this.quick.preset)) this.quick.preset = names[0] ?? '';
    this.presetCtrl = this.presetCtrl.options(names).name('preset');
    this.presetCtrl.onChange(() => {
      this.updateAbout();
      this.blurSoon();
    });
    this.updateAbout();
  }

  private builtin(name: string): TuningPreset | undefined {
    return name.startsWith(BUILTIN_PREFIX) ? TUNING_PRESETS.find((b) => builtinName(b) === name) : undefined;
  }

  private updateAbout(): void {
    const b = this.builtin(this.quick.preset);
    const p = b ? null : this.readPresets()[this.quick.preset];
    this.quick.about = b ? b.description : p ? `saved ${new Date(p.created).toLocaleString()}` : '';
    if (this.aboutCtrl) this.aboutCtrl.domElement.title = this.quick.about;
    this.updateAll();
  }

  /**
   * Apply a built-in preset: the SHIPPED parameters of its archetype (the current one unless the preset names one)
   * plus its overrides. Keeps the race-selection choices (tyre, transmission, §5.5 setup menu, steering); other car
   * tweaks are replaced. Input, camera and surface tuning are untouched ("Reset to original" restores everything).
   */
  private applyBuiltin(b: TuningPreset): void {
    try {
      const cur = this.host.getTunables().car;
      const s = cur.setup;
      const keep = {
        tyreType: cur.tyreType,
        transmission: cur.transmission,
        steerSensFast: cur.steerSensFast,
        setup: { brake: s.brake, powerRatio: s.powerRatio, suspension: s.suspension, gearRatio: s.gearRatio },
      };
      const params = presetCarParams(b, cur.archetype, keep);
      this.applying = true;
      try {
        this.host.importJson(JSON.stringify({ car: params }));
      } finally {
        this.applying = false;
      }
      this.scheduleAutosave();
      this.updateAll();
      this.flashTitle(`loaded "${b.label}"`);
    } catch (err) {
      console.warn('[tuning] built-in preset failed', err);
    }
  }

  private buildGears(): void {
    const f = this.gearFolder;
    if (!f) return;
    for (const c of [...f.controllers]) c.destroy();
    const ratios = this.host.getParam('gearRatio');
    const n = Array.isArray(ratios) ? ratios.length : 0;
    this.nGears = n;
    for (let i = 0; i < n; i++) {
      this.bind(f, { key: i === 0 ? 'gearRatio[0] R' : `gearRatio[${i}]`, paths: [`gearRatio.${i}`], min: i === 0 ? -5 : 0.4, max: i === 0 ? -1 : 5, step: 0.01 });
    }
  }

  private buildSurfaces(): void {
    const f = this.gui.addFolder('Surfaces');
    f.add(this.surfSel, 'surface', SURFACE_IDS as unknown as string[]).name('surface').onChange(() => {
      this.surfSel.follow = false;
      this.updateAll();
      this.blurSoon();
    });
    const tyreOpts: Record<string, number> = {};
    TYRE_NAMES.forEach((t, i) => (tyreOpts[t] = i));
    f.add(this.surfSel, 'tyre', tyreOpts).name('tyre type').onChange(() => {
      this.updateAll();
      this.blurSoon();
    });
    f.add(this.surfSel, 'follow').name('follow car surface');
    const h = this.host;
    const dyn = (spec: ParamSpec, tyreRow: boolean) => {
      const m: Model = {};
      const id = this.nextId();
      const path = () => `surfaces.${this.surfSel.surface}.${tyreRow ? `tyre.${this.surfSel.tyre}.` : ''}${spec.paths[0]}`;
      const v0 = h.getParam(path());
      if (v0 === undefined) {
        this.missing.push(path());
        return;
      }
      Object.defineProperty(m, id, {
        enumerable: true,
        get: () => h.getParam(path()) ?? v0,
        set: (v: unknown) => {
          this.write(path(), v);
          if (typeof v === 'boolean' || spec.options) this.blurSoon();
        },
      });
      const c = spec.options ? f.add(m, id, spec.options) : typeof v0 === 'number' ? f.add(m, id, spec.min, spec.max, spec.step) : f.add(m, id);
      c.name(tyreRow ? `tyre: ${spec.key}` : spec.key);
    };
    for (const s of SURFACE_TYRE_KEYS) dyn(s, true);
    for (const s of SURFACE_KEYS) dyn(s, false);
    const mu: Model = {};
    const muOf = (kinetic: boolean) => {
      const base = `surfaces.${this.surfSel.surface}`;
      const t = `${base}.tyre.${this.surfSel.tyre}`;
      const bs = Number(h.getParam(`${t}.bestStatic`));
      const ds = Number(h.getParam(`${t}.diffStatic`));
      const fl = Number(h.getParam(`${base}.frictionLevel`));
      const sk = Number(h.getParam(`${t}.scaleKinetic`));
      const ms = bs + ds * 0.7 * fl;
      const v = kinetic ? ms * sk : ms;
      return Number.isFinite(v) ? v.toFixed(3) : '—';
    };
    Object.defineProperty(mu, 'ms', { enumerable: true, get: () => muOf(false), set: () => {} });
    Object.defineProperty(mu, 'mk', { enumerable: true, get: () => muOf(true), set: () => {} });
    f.add(mu, 'ms').name('μ static (§4.2)').disable();
    f.add(mu, 'mk').name('μ kinetic').disable();
    f.close();
  }

  private buildCamera(): void {
    const f = this.gui.addFolder('Camera');
    for (const p of CAMERA_KEYS) this.bind(f, p);
    const h = this.host;
    f.add(this.camSel, 'mode', CHASE_MODES as unknown as string[]).name('chase entry').onChange(() => {
      this.updateAll();
      this.blurSoon();
    });
    const dyn = (label: string, sub: string, min: number, max: number, step: number) => {
      const m: Model = {};
      const id = this.nextId();
      const path = () => `camera.chase.${this.camSel.mode}.${sub}`;
      const v0 = h.getParam(path());
      if (typeof v0 !== 'number') {
        this.missing.push(path());
        return;
      }
      Object.defineProperty(m, id, {
        enumerable: true,
        get: () => h.getParam(path()) ?? v0,
        set: (v: unknown) => this.write(path(), v),
      });
      f.add(m, id, min, max, step).name(label);
    };
    for (const ax of ['x', 'y', 'z']) dyn(`posA.${ax}`, `posA.${ax}`, -10, 10, 0.05);
    for (const ax of ['x', 'y', 'z']) dyn(`posB.${ax}`, `posB.${ax}`, -10, 10, 0.05);
    dyn('p0 (nose-down gain)', 'p0', 0, 20, 0.5);
    dyn('p1 (nose-down cap)', 'p1', 0, 2, 0.05);
    f.close();
  }

  /** Every remaining numeric / boolean leaf of the tunables (so nothing is unreachable). */
  private buildOther(): void {
    if (this.otherFolder) this.otherFolder.destroy();
    const f = (this.otherFolder = this.gui.addFolder('All other parameters'));
    const covered = coveredPaths();
    const t = this.host.getTunables();
    const roots: [string, unknown][] = [
      ['', t.car],
      ['input', t.input],
      ['camera', t.camera],
    ];
    const skip = (p: string) =>
      covered.has(p) ||
      p === 'archetype' ||
      p.startsWith('gearRatio') ||
      p.startsWith('wheel.') ||
      p.startsWith('camera.chase.') ||
      p === 'wheelFL.y' ||
      p === 'wheelRL.y';
    const walk = (prefix: string, v: unknown, depth: number) => {
      if (depth > 6) return;
      if (typeof v === 'number' || typeof v === 'boolean') {
        if (skip(prefix)) return;
        const spec: ParamSpec = { key: prefix, paths: [prefix] };
        if (typeof v === 'number') {
          const a = Math.abs(v);
          if (prefix === 'nGears' || prefix.endsWith('physicsHz')) spec.readOnly = true;
          if (Number.isInteger(v) && a >= 10) {
            spec.min = v < 0 ? -3 * a : 0;
            spec.max = v < 0 ? 0 : Math.max(10, 3 * a);
            spec.step = 1;
          } else {
            const span = a > 0 ? 3 * a : 1;
            spec.min = v < 0 ? -span : 0;
            spec.max = v < 0 ? Math.max(0, span / 3) : span;
            const raw = span / 300;
            spec.step = Math.pow(10, Math.floor(Math.log10(raw || 1e-3)));
          }
        }
        this.bind(f, spec);
        return;
      }
      if (Array.isArray(v)) {
        v.forEach((x, i) => walk(`${prefix}.${i}`, x, depth + 1));
        return;
      }
      if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
        for (const k of Object.keys(v as object)) walk(prefix ? `${prefix}.${k}` : k, (v as Record<string, unknown>)[k], depth + 1);
      }
    };
    for (const [root, obj] of roots) {
      if (!obj || typeof obj !== 'object') continue;
      for (const k of Object.keys(obj as object)) walk(root ? `${root}.${k}` : k, getPath(obj, k), 1);
    }
    f.close();
  }

  private buildLive(): void {
    const f = this.gui.addFolder('Live telemetry');
    const add = (k: string, label: string) => {
      const c = f.add(this.live, k).name(label).disable();
      this.liveCtrls.push(c);
    };
    add('speed', 'speed km/h');
    add('rpm', 'rpm');
    add('gear', 'gear');
    add('beta', 'β deg');
    add('yaw', 'yaw rate rad/s');
    add('aLat', 'a_lat g');
    add('surface', 'surfaces FL FR RR RL');
    f.close();
  }

  // =================================================================================== actions

  private teleport(s: number, lateral: number): void {
    try {
      this.host.teleport(s, lateral);
    } catch (err) {
      console.warn('[tuning] teleport failed', err);
    }
  }

  private freezeOrStep(n: number, forceStep = false): void {
    const h = this.host;
    const paused = h.isFrozen();
    if (!paused && !forceStep) {
      h.setFrozen(true);
      return;
    }
    if (!paused) h.setFrozen(true);
    h.stepPhysics(n);
  }

  private bumpTimeScale(dir: number): void {
    const cur = Number(this.host.getParam('loop.timeScale') ?? 1);
    let i = TIME_SCALES.findIndex((x) => x >= cur - 1e-6);
    if (i < 0) i = TIME_SCALES.length - 1;
    if (dir > 0) i = TIME_SCALES[i] > cur + 1e-6 ? i : i + 1;
    else i = i - 1;
    i = Math.max(0, Math.min(TIME_SCALES.length - 1, i));
    this.write('loop.timeScale', TIME_SCALES[i]);
    this.updateAll();
  }

  private flashTitle(msg: string): void {
    this.gui.title(`Handling lab — ${msg}`);
    setTimeout(() => this.gui.title('Handling lab  (F1)'), 1800);
  }

  // =================================================================================== persistence

  private scheduleAutosave(): void {
    if (!this.persist || this.applying) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveAutosave(), 400);
  }

  private saveAutosave(): void {
    try {
      const t = JSON.parse(this.host.exportJson()) as Record<string, Record<string, unknown>>;
      const car = { ...t.car };
      const arch = String(car.archetype) as ArchetypeId;
      for (const k of SELECTION_KEYS) delete car[k];
      const setup = car.setup as Record<string, unknown> | undefined;
      car.setup = setup && 'awdBaseSplit' in setup ? { awdBaseSplit: setup.awdBaseSplit } : undefined;
      if (car.setup === undefined) delete car.setup;
      const prev = this.readAutosave();
      const save: Autosave = { v: 1, cars: { ...(prev?.cars ?? {}), [arch]: car }, input: t.input, camera: t.camera, surfaces: t.surfaces };
      store.set(AUTOSAVE_KEY, JSON.stringify(save));
    } catch (err) {
      console.warn('[tuning] autosave failed', err);
    }
  }

  private readAutosave(): Autosave | null {
    try {
      const raw = store.get(AUTOSAVE_KEY);
      const a = raw ? (JSON.parse(raw) as Autosave) : null;
      return a && a.v === 1 ? a : null;
    } catch {
      return null;
    }
  }

  /** Re-apply persisted tweaks (all = also input / camera / surfaces; else only the car of this archetype). */
  private applyAutosave(all: boolean): void {
    const a = this.readAutosave();
    if (!a) return;
    const arch = String(this.host.getTunables().car.archetype) as ArchetypeId;
    const o: Record<string, unknown> = {};
    if (a.cars?.[arch]) o.car = a.cars[arch];
    if (all) {
      if (a.input) o.input = a.input;
      if (a.camera) o.camera = a.camera;
      if (a.surfaces) o.surfaces = a.surfaces;
    }
    if (!Object.keys(o).length) return;
    this.applying = true;
    try {
      this.host.importJson(JSON.stringify(o));
    } catch (err) {
      console.warn('[tuning] could not apply persisted tweaks', err);
    } finally {
      this.applying = false;
    }
  }

  // =================================================================================== ITuningPanel

  setOpen(open: boolean): void {
    this.isOpen = open;
    // the HUD moves its right column (clock, gauge, surface chip) left of the panel while it is open
    if (typeof document !== 'undefined') document.body?.classList.toggle('rw-tuning-open', open);
    if (open) {
      this.gui.show();
      this.gui.open();
      this.updateAll();
    } else this.gui.hide();
  }

  toggle(): void {
    this.setOpen(!this.isOpen);
  }

  refresh(): void {
    const arch = String(this.host.getTunables().car.archetype);
    if (arch !== this.lastArchetype) {
      this.lastArchetype = arch;
      if (this.persist && !this.applying) this.applyAutosave(false);
    }
    const ratios = this.host.getParam('gearRatio');
    if (Array.isArray(ratios) && ratios.length !== this.nGears) {
      this.buildGears();
      this.buildOther();
    }
    this.updateAll();
  }

  private updateAll(): void {
    for (const c of this.gui.controllersRecursive()) {
      try {
        c.updateDisplay();
      } catch {
        /* a binding whose path vanished: ignore */
      }
    }
  }

  update(ctx: Readonly<FrameContext>): void {
    this.lastCtx = ctx;
    const sk = `${ctx.stage.id}#${ctx.stage.seed}`;
    if (sk !== this.stageKey) this.onStage(ctx.stage);
    if (!this.isOpen) return;
    const t = ctx.telemetry;
    if (this.surfSel.follow) {
      const s = t.wheels[0].surface ?? t.wheels[1].surface;
      if (s && s !== this.surfSel.surface) {
        this.surfSel.surface = s;
        this.surfSel.tyre = t.tyreType;
        this.refreshT = 0;
      }
    }
    this.refreshT -= ctx.frameDt;
    if (this.refreshT <= 0) {
      this.refreshT = 0.25;
      this.updateAll();
    }
    // a_lat display: exponential average over ≈ 8 physics steps (the 2-step Δv telemetry chatters at low speed)
    const ds = t.stepCount - this.aLatStep;
    this.aLatStep = t.stepCount;
    if (ds > 0 && Number.isFinite(t.aLat)) this.aLatEma += (t.aLat - this.aLatEma) * (1 - Math.exp(-ds / 8));
    this.liveT -= ctx.frameDt;
    if (this.liveT <= 0) {
      this.liveT = 0.1;
      this.live.speed = Math.round(t.speedKmh * 10) / 10;
      this.live.rpm = Math.round(t.rpm);
      this.live.gear = `${t.gear === 0 ? 'R' : t.gear}${t.shifting ? ' (shifting)' : ''} ${t.transmission}`;
      this.live.beta = Math.round(((t.beta * 180) / Math.PI) * 10) / 10;
      this.live.yaw = Math.round(t.yawRate * 100) / 100;
      this.live.aLat = Math.round((this.aLatEma / 9.81) * 100) / 100;
      this.live.surface = t.wheels.map((w) => (w.surface ?? '-').slice(0, 6)).join(' ');
      for (const c of this.liveCtrls) c.updateDisplay();
    }
  }

  private onStage(stage: Stage): void {
    this.stageKey = `${stage.id}#${stage.seed}`;
    try {
      this.targets = findTeleportTargets(stage);
    } catch {
      this.targets = [];
    }
    const opts: Record<string, number> = {};
    this.targets.forEach((t, i) => (opts[t.label] = i));
    this.quick.target = 0;
    if (this.targetCtrl) this.targetCtrl = this.targetCtrl.options(opts).name('target');
    this.quick.s = Math.min(Math.max(0, this.quick.s), stage.length);
    this.sCtrl?.max(Math.max(1, stage.length)).updateDisplay();
    // pick the chase entry matching the active camera
    const cam = this.lastCtx?.cameraMode;
    if (cam && (CHASE_MODES as readonly string[]).includes(cam)) this.camSel.mode = cam as (typeof CHASE_MODES)[number];
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.gui.destroy();
  }
}
