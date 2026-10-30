/**
 * src/ui/hud.ts — OWNED BY THE GAME BUILDER.
 *
 * In-race HUD (pure DOM/CSS + inline SVG inside `root` = #hud-root):
 *  - top left: stage name + progress bar with one section per timed sector (checkpoints, laps), each coloured
 *    by its split delta against the best run (green faster / red slower), position marker;
 *  - top right: race clock (m:ss.mmm), best time, lap x/y (closed stages), split delta popup;
 *  - top centre: up to 3 pacenote cards (glyph, severity, call, modifiers, distance to the corner);
 *  - bottom right: rev gauge with redline + speed (km/h) + gear (shift light) + boost bar; surface + tyre chip;
 *  - bottom left: status chips (camera, autopilot, time scale, transmission, voice);
 *  - centre: countdown / GO / FINISH / WRONG WAY, checkpoint popup; reset fade (opacity = race.fade).
 * Co-driver voice on 'pacenote' events (the original's samples, else speechSynthesis; on by default, toggle N or
 * in the menu).
 *
 * REQUIRED EXPORTS (contract in src/core/types.ts IHud):
 *   class Hud implements IHud
 *     constructor(root: HTMLElement)
 *     update(ctx: Readonly<FrameContext>): void
 *     setVisible(on: boolean): void
 *     dispose(): void
 */
import { CAMERA_MODES, SURFACE_INFO, TYRE_NAMES } from '../core/constants';
import type { CameraMode, FrameContext, IHud, Pacenote, Stage, SurfaceId } from '../core/types';
import { MODIFIER_LABEL, pacenoteSvg, WARN_MODIFIERS } from './pacenoteIcon';
import { escapeHtml, formatDelta, formatTime, isTypingTarget, onToast, onUiSettings, setUiSetting, toast, uiSettings } from './settings';
import { injectUiStyles } from './styles';
import { CoDriverVoice } from './voice';

const CAMERA_LABEL: Record<CameraMode, string> = {
  bumper: 'Bumper cam',
  bonnet: 'Bonnet cam',
  chaseNear: 'Chase near',
  chase: 'Chase',
  chaseFar: 'Chase far',
  chaseHigh: 'Chase high',
  tetherHigh: 'Tether high',
  tetherLow: 'Tether low',
};

/** Gauge geometry: 250° arc. */
const ARC_START = 145;
const ARC_SWEEP = 250;
const GAUGE_R = 92;
const GCX = 115;
const GCY = 112;

function polar(deg: number, r = GAUGE_R): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [GCX + r * Math.cos(a), GCY + r * Math.sin(a)];
}
function arcPath(d0: number, d1: number, r = GAUGE_R): string {
  const [x0, y0] = polar(d0, r);
  const [x1, y1] = polar(d1, r);
  const large = d1 - d0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

interface Sector {
  /** Fraction of the whole run. */
  len: number;
}

/** Timed distance: start line to finish (point-to-point) or one lap (closed). Same number as the menu. */
export function timedLength(stage: Pick<Stage, 'closed' | 'length' | 'startS' | 'finishS'>): number {
  return stage.closed ? stage.length : Math.max(0, stage.finishS - stage.startS);
}

/**
 * Time gained or lost in sector i alone (this run's sector time minus the best run's), or null when either
 * run has no valid time for it. Sector 0 equals the cumulative delta.
 */
export function sectorDelta(splits: readonly number[], best: readonly number[] | null, i: number): number | null {
  if (!best || best.length <= i || i >= splits.length) return null;
  const a = splits[i] - (i > 0 ? splits[i - 1] : 0);
  const b = best[i] - (i > 0 ? best[i - 1] : 0);
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}

/** Timed sectors (point-to-point: checkpoints + finish; closed: per lap). Mirrors src/game/timing.ts. */
function sectorsOf(stage: Stage): Sector[] {
  if (stage.discipline === 'testpad') return [];
  const cps = [...stage.checkpoints].sort((a, b) => a - b);
  const bounds: number[] = [];
  if (!stage.closed) {
    const total = Math.max(1, stage.finishS - stage.startS);
    let prev = 0;
    for (const s of cps) {
      const d = s - stage.startS;
      if (d > 0.5 && s < stage.finishS) {
        bounds.push(d - prev);
        prev = d;
      }
    }
    bounds.push(total - prev);
    return bounds.map((b) => ({ len: b / total }));
  }
  const L = stage.length;
  const laps = Math.max(1, stage.laps);
  const rel = cps.map((s) => (((s - stage.finishS) % L) + L) % L).filter((r) => r > 0.5 && r < L - 0.5);
  rel.sort((a, b) => a - b);
  const per: number[] = [];
  let prev = 0;
  for (const r of rel) {
    per.push(r - prev);
    prev = r;
  }
  per.push(L - prev);
  const out: Sector[] = [];
  for (let i = 0; i < laps; i++) for (const p of per) out.push({ len: p / (L * laps) });
  return out;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class Hud implements IHud {
  private readonly wrap: HTMLDivElement;
  private readonly fade: HTMLDivElement;
  // progress
  private readonly stageName: HTMLElement;
  private readonly stageInfo: HTMLElement;
  private readonly bar: HTMLDivElement;
  private readonly marker: HTMLDivElement;
  private segs: { el: HTMLDivElement; fill: HTMLElement; start: number; len: number }[] = [];
  private readonly progressBox: HTMLDivElement;
  // clock
  private readonly time: HTMLElement;
  private readonly bestEl: HTMLElement;
  private readonly lapEl: HTMLElement;
  private readonly splitEl: HTMLElement;
  // notes
  private readonly notesEl: HTMLDivElement;
  private noteKey = '';
  private noteCards: { el: HTMLElement; dist: HTMLElement; note: Pacenote }[] = [];
  // gauge
  private readonly rpmArc: SVGPathElement;
  private readonly redArc: SVGPathElement;
  private readonly speedEl: HTMLElement;
  private readonly gearEl: HTMLElement;
  private readonly boostFill: HTMLElement;
  private readonly rpmText: HTMLElement;
  private readonly surfEl: HTMLElement;
  private readonly gaugeBox: HTMLDivElement;
  /** Analytic arc length of the rev arc (R · sweep). */
  private readonly arcLen = (GAUGE_R * ARC_SWEEP * Math.PI) / 180;
  private redKey = '';
  // centre
  private readonly msg: HTMLElement;
  private readonly cp: HTMLElement;
  private readonly chips: HTMLElement;
  private readonly toasts: HTMLElement;
  // state
  private visible = true;
  private stageKey = '';
  private lastSplits = 0;
  private splitShowT = 0;
  private cpShowT = 0;
  private camShowT = 0;
  private lastCam: CameraMode | null = null;
  private lastMsg = '';
  private chipKey = '';
  private readonly cache = new Map<string, string>();
  private readonly voice = new CoDriverVoice();
  private lastPhase = '';
  private readonly offToast: () => void;
  private readonly offSettings: () => void;
  private readonly onKey = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target) || e.repeat) return;
    if (e.code === 'KeyN') {
      setUiSetting('voice', !uiSettings.voice);
      toast(`Co-driver voice ${uiSettings.voice ? 'on' : 'off'}${uiSettings.voice && !this.voice.available ? ' (not supported here)' : ''}`);
    }
  };

  constructor(root: HTMLElement) {
    injectUiStyles();
    this.wrap = el('div', 'rw-hud');

    // ---- progress
    this.progressBox = el('div', 'rw-progress rw-plate');
    const head = el('div', 'rw-stage');
    this.stageName = el('b');
    this.stageInfo = el('span', 'rw-label');
    head.append(this.stageName, this.stageInfo);
    this.bar = el('div', 'rw-bar');
    this.marker = el('div', 'rw-marker');
    this.bar.appendChild(this.marker);
    this.progressBox.append(head, this.bar);

    // ---- clock
    const clock = el('div', 'rw-clock rw-plate');
    this.time = el('div', 'rw-time', '0:00.000');
    const row = el('div', 'rw-row');
    this.bestEl = el('span');
    row.appendChild(this.bestEl);
    this.lapEl = el('div', 'rw-lapbox');
    this.splitEl = el('div', 'rw-split');
    clock.append(this.time, row, this.lapEl, this.splitEl);

    // ---- notes
    this.notesEl = el('div', 'rw-notes');

    // ---- gauge
    this.gaugeBox = el('div', 'rw-gauge');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 230 214');
    const mk = (d: string, stroke: string, width: number, extra = '') => {
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', stroke);
      p.setAttribute('stroke-width', String(width));
      if (extra) p.setAttribute('stroke-linecap', extra);
      svg.appendChild(p);
      return p;
    };
    const full = arcPath(ARC_START, ARC_START + ARC_SWEEP);
    const disc = document.createElementNS(svgNS, 'circle');
    disc.setAttribute('cx', String(GCX));
    disc.setAttribute('cy', String(GCY));
    disc.setAttribute('r', String(GAUGE_R + 14));
    disc.setAttribute('fill', 'rgba(9,12,17,0.72)');
    svg.appendChild(disc);
    mk(full, 'rgba(255,255,255,0.10)', 12);
    this.redArc = mk(full, '#ff4b3e', 12);
    this.redArc.setAttribute('opacity', '0.45');
    this.rpmArc = mk(full, '#ffb81c', 12);
    // ticks every 1000 rpm are rebuilt with the redline
    const ticks = document.createElementNS(svgNS, 'g');
    ticks.setAttribute('class', 'rw-ticks');
    svg.appendChild(ticks);
    this.gaugeBox.appendChild(svg);
    this.gearEl = el('div', 'rw-gear', '1');
    this.speedEl = el('div', 'rw-speed', '0');
    const unit = el('div', 'rw-unit', 'KM/H');
    const boost = el('div', 'rw-boost');
    this.boostFill = el('i');
    boost.appendChild(this.boostFill);
    this.rpmText = el('div', 'rw-rpm');
    this.gaugeBox.append(this.gearEl, this.speedEl, unit, boost, this.rpmText);
    this.surfEl = el('div', 'rw-surface');

    // ---- centre + chips + fade
    this.msg = el('div', 'rw-msg');
    this.cp = el('div', 'rw-cp rw-plate');
    this.chips = el('div', 'rw-chips');
    this.toasts = el('div', 'rw-toast-wrap');
    this.fade = el('div', 'rw-fade', '<span>Recovering</span>');

    this.wrap.append(this.progressBox, clock, this.notesEl, this.gaugeBox, this.surfEl, this.chips, this.msg, this.cp, this.toasts, this.fade);
    root.appendChild(this.wrap);
    this.offToast = onToast((t) => this.showToast(t));
    this.offSettings = onUiSettings(() => {
      this.noteKey = '\u0000'; // force a rebuild (also when the cards are switched off)
      if (!uiSettings.voice) this.voice.stop();
    });
    window.addEventListener('keydown', this.onKey);
  }

  private setText(key: string, e: HTMLElement, text: string): void {
    if (this.cache.get(key) === text) return;
    this.cache.set(key, text);
    e.textContent = text;
  }

  private setHtml(key: string, e: HTMLElement, html: string): void {
    if (this.cache.get(key) === html) return;
    this.cache.set(key, html);
    e.innerHTML = html;
  }

  private showToast(text: string): void {
    const t = el('div', 'rw-toast');
    t.textContent = text;
    this.toasts.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  update(ctx: Readonly<FrameContext>): void {
    const r = ctx.race;
    const t = ctx.telemetry;
    const dt = ctx.frameDt;
    // reset fade always drawn (even when the HUD is hidden)
    const fade = Math.max(0, Math.min(1, r.fade));
    this.fade.style.opacity = fade.toFixed(3);
    const showHud = this.visible && uiSettings.hud && r.phase !== 'idle';
    this.wrap.classList.toggle('rw-hidden', !showHud);

    // stage change → rebuild sectors
    const sk = `${ctx.stage.id}#${ctx.stage.seed}`;
    if (sk !== this.stageKey) this.rebuildStage(ctx.stage);

    // phase change: voice housekeeping
    if (r.phase !== this.lastPhase) {
      if (r.phase === 'countdown' || r.phase === 'idle') {
        this.voice.stop();
        this.lastSplits = r.splits.length;
        // a new run (restart of the same stage): drop the previous run's split / checkpoint popups
        this.splitShowT = this.cpShowT = 0;
        this.splitEl.classList.remove('rw-on');
        this.cp.classList.remove('rw-on');
      }
      this.lastPhase = r.phase;
    }
    this.voice.setPaused(ctx.paused);

    for (const e of ctx.events) {
      if (e.type === 'pacenote' && uiSettings.voice) this.voice.say(e.note);
      if (e.type === 'checkpoint' || e.type === 'lap') this.cpShowT = 3.0;
    }
    if (!showHud) return;

    // ---- progress
    const prog = Math.max(0, Math.min(1, r.progress));
    this.marker.style.left = `${(prog * 100).toFixed(2)}%`;
    const bs = r.bestSplits;
    for (let i = 0; i < this.segs.length; i++) {
      const sg = this.segs[i];
      const done = i < r.splits.length;
      const cur = !done && i === r.splits.length;
      let cls = 'rw-seg';
      if (done) {
        const sd = sectorDelta(r.splits, bs, i);
        if (!Number.isFinite(r.splits[i])) cls += ' rw-skip';
        else if (sd !== null) cls += sd <= 0 ? ' rw-fast' : ' rw-slow';
      }
      if (cur) cls += ' rw-cur';
      if (sg.el.className !== cls) sg.el.className = cls;
      const f = done ? 1 : cur ? Math.max(0, Math.min(1, (prog - sg.start) / Math.max(1e-6, sg.len))) : 0;
      sg.fill.style.width = `${(f * 100).toFixed(1)}%`;
    }

    // ---- clock
    this.setText('time', this.time, formatTime(r.phase === 'countdown' ? 0 : r.time));
    this.setHtml('best', this.bestEl, r.bestTime !== null ? `BEST <b>${formatTime(r.bestTime)}</b>` : `<span class="rw-label">No best yet</span>`);
    if (ctx.stage.closed && ctx.stage.discipline !== 'testpad' && r.laps > 1) {
      this.lapEl.style.display = '';
      this.setText('lap', this.lapEl, `LAP ${Math.min(r.lap, r.laps)}/${r.laps}`);
    } else this.lapEl.style.display = 'none';
    if (r.splits.length > this.lastSplits && !Number.isFinite(r.splits[r.splits.length - 1])) {
      this.lastSplits = r.splits.length; // skipped by a debug teleport: no popup
    } else if (r.splits.length > this.lastSplits) {
      const i = r.splits.length - 1;
      const delta = bs && bs.length > i && Number.isFinite(bs[i]) ? r.splits[i] - bs[i] : null;
      const sd = sectorDelta(r.splits, bs, i);
      const label = this.splitLabel(ctx.stage, i, r.splits.length >= this.segs.length);
      this.splitEl.className = `rw-split rw-on ${delta === null ? '' : delta <= 0 ? 'rw-fastc' : 'rw-slowc'}`;
      this.splitEl.textContent = delta === null ? `${label} ${formatTime(r.splits[i])}` : `${label} ${formatDelta(delta)}`;
      this.cp.innerHTML =
        `<span>${escapeHtml(label)}</span><b>${formatTime(r.splits[i])}</b>` +
        (delta === null ? '' : `<b class="${delta <= 0 ? 'rw-fastc' : 'rw-slowc'}">${formatDelta(delta)}</b>`) +
        (sd === null || i === 0 ? '' : `<span class="${sd <= 0 ? 'rw-fastc' : 'rw-slowc'}">sector ${formatDelta(sd)}</span>`);
      this.splitShowT = 4;
      this.lastSplits = r.splits.length;
    } else if (r.splits.length < this.lastSplits) this.lastSplits = r.splits.length;
    this.splitShowT -= dt;
    if (this.splitShowT <= 0 && this.splitEl.classList.contains('rw-on')) this.splitEl.classList.remove('rw-on');
    this.cpShowT -= dt;
    this.cp.classList.toggle('rw-on', this.cpShowT > 0 && r.splits.length > 0 && r.phase !== 'finished');

    // ---- pacenotes
    this.updateNotes(ctx);

    // ---- gauge
    const rpmMax = t.rpmMax > 0 ? t.rpmMax : 8750;
    const red = t.rpmRedline > 0 ? t.rpmRedline : rpmMax * 0.94;
    const redKey = `${red}|${rpmMax}`;
    if (redKey !== this.redKey) {
      this.redKey = redKey;
      const d0 = ARC_START + ARC_SWEEP * Math.min(1, red / rpmMax);
      this.redArc.setAttribute('d', arcPath(d0, ARC_START + ARC_SWEEP));
      this.buildTicks(rpmMax);
    }
    const frac = Math.max(0, Math.min(1, t.rpm / rpmMax));
    this.rpmArc.setAttribute('stroke-dasharray', `${(frac * this.arcLen).toFixed(1)} ${this.arcLen.toFixed(1)}`);
    this.rpmArc.setAttribute('stroke', t.rpm >= red ? '#ff4b3e' : '#ffb81c');
    this.setText('speed', this.speedEl, String(Math.round(Math.abs(t.speedKmh))));
    const gear = t.gear === 0 ? 'R' : String(t.gear);
    this.setText('gear', this.gearEl, t.shifting ? '·' : gear);
    const gcls = `rw-gear${t.rpm >= red ? ' rw-limit' : t.rpm >= red - 600 && t.gear > 0 && t.gear < t.nGears ? ' rw-shift' : ''}`;
    if (this.gearEl.className !== gcls) this.gearEl.className = gcls;
    this.boostFill.style.width = `${(Math.max(0, Math.min(1, t.boostFrac)) * 100).toFixed(0)}%`;
    this.setText('rpm', this.rpmText, `${(Math.round(t.rpm / 50) * 50).toLocaleString('en-US')} RPM`);

    // ---- surface chip
    const surf = this.dominantSurface(ctx);
    const tyre = TYRE_NAMES[t.tyreType] ?? '';
    const sinfo = surf ? SURFACE_INFO[surf] : null;
    const col = sinfo ? `#${sinfo.color.toString(16).padStart(6, '0')}` : 'transparent';
    this.setHtml(
      'surf',
      this.surfEl,
      `<i style="background:${col}"></i><b>${sinfo ? escapeHtml(sinfo.name) : t.airborne ? 'Airborne' : '—'}</b><span>${escapeHtml(tyre)} tyres</span>`,
    );

    // ---- chips
    if (ctx.cameraMode !== this.lastCam) {
      if (this.lastCam !== null) this.camShowT = 1.6;
      this.lastCam = ctx.cameraMode;
    }
    this.camShowT -= dt;
    const chips: string[] = [];
    if (this.camShowT > 0) chips.push(`<div class="rw-chip">${CAMERA_LABEL[ctx.cameraMode] ?? ctx.cameraMode} · ${CAMERA_MODES.indexOf(ctx.cameraMode) + 1}/${CAMERA_MODES.length}</div>`);
    if (ctx.autopilot) chips.push('<div class="rw-chip rw-amberc">Autopilot</div>');
    if (Math.abs(ctx.timeScale - 1) > 1e-3) chips.push(`<div class="rw-chip rw-redc">Time ×${ctx.timeScale.toFixed(2)}</div>`);
    if (t.transmission === 'manual') chips.push('<div class="rw-chip">Manual</div>');
    if (r.untimed && r.phase === 'running') chips.push('<div class="rw-chip rw-amberc">Practice · untimed</div>');
    if (ctx.paused && !document.querySelector('.rw-menu.rw-open')) chips.push('<div class="rw-chip rw-redc">Frozen · . step · P resume</div>');
    const ck = chips.join('');
    if (ck !== this.chipKey) {
      this.chipKey = ck;
      this.chips.innerHTML = ck;
    }

    // ---- centre message
    const m = r.message ?? '';
    if (m !== this.lastMsg) {
      this.lastMsg = m;
      if (m) {
        this.msg.textContent = m;
        const kind = m === 'GO!' ? ' rw-go' : m === 'FINISH' ? ' rw-finish' : m === 'WRONG WAY' ? ' rw-wrong' : '';
        this.msg.className = `rw-msg${kind}`;
        void this.msg.offsetWidth; // restart the pop-in transition
        this.msg.className = `rw-msg rw-on${kind}`;
      } else this.msg.className = 'rw-msg';
    }
  }

  private splitLabel(stage: Stage, i: number, final: boolean): string {
    if (final) return 'Finish';
    if (stage.closed) {
      const per = this.segs.length / Math.max(1, stage.laps);
      const inLap = i % per;
      return inLap === per - 1 ? `Lap ${Math.floor(i / per) + 1}` : `Split ${inLap + 1}`;
    }
    return `Split ${i + 1}`;
  }

  private dominantSurface(ctx: Readonly<FrameContext>): SurfaceId | null {
    const counts = new Map<SurfaceId, number>();
    for (const w of ctx.telemetry.wheels) if (w.contact && w.surface) counts.set(w.surface, (counts.get(w.surface) ?? 0) + 1);
    let best: SurfaceId | null = null;
    let n = 0;
    for (const [k, v] of counts) if (v > n) {
      best = k;
      n = v;
    }
    return best;
  }

  private buildTicks(rpmMax: number): void {
    const g = this.gaugeBox.querySelector('.rw-ticks');
    if (!g) return;
    const svgNS = 'http://www.w3.org/2000/svg';
    g.innerHTML = '';
    for (let k = 0; k * 1000 <= rpmMax + 1; k++) {
      const deg = ARC_START + ARC_SWEEP * Math.min(1, (k * 1000) / rpmMax);
      const [x0, y0] = polar(deg, GAUGE_R - 9);
      const [x1, y1] = polar(deg, GAUGE_R - 15);
      const ln = document.createElementNS(svgNS, 'line');
      ln.setAttribute('x1', x0.toFixed(1));
      ln.setAttribute('y1', y0.toFixed(1));
      ln.setAttribute('x2', x1.toFixed(1));
      ln.setAttribute('y2', y1.toFixed(1));
      ln.setAttribute('stroke', 'rgba(255,255,255,.55)');
      ln.setAttribute('stroke-width', '2');
      g.appendChild(ln);
      const [tx, ty] = polar(deg, GAUGE_R - 25);
      const tx2 = document.createElementNS(svgNS, 'text');
      tx2.setAttribute('x', tx.toFixed(1));
      tx2.setAttribute('y', (ty + 4).toFixed(1));
      tx2.setAttribute('text-anchor', 'middle');
      tx2.setAttribute('fill', 'rgba(255,255,255,.55)');
      tx2.setAttribute('font-size', '11');
      tx2.setAttribute('font-family', 'Bahnschrift, Arial Narrow, sans-serif');
      tx2.textContent = String(k);
      g.appendChild(tx2);
    }
  }

  private rebuildStage(stage: Stage): void {
    this.stageKey = `${stage.id}#${stage.seed}`;
    this.setText('stageName', this.stageName, stage.name);
    const len = timedLength(stage);
    const km = len >= 1000 ? `${(len / 1000).toFixed(1)} km` : `${Math.round(len)} m`;
    const info = stage.discipline === 'testpad' ? `${km} loop` : stage.closed && stage.laps > 1 ? `${stage.laps} laps · ${km}` : km;
    this.setText('stageInfo', this.stageInfo, info);
    for (const s of this.segs) s.el.remove();
    this.segs = [];
    let acc = 0;
    for (const sec of sectorsOf(stage)) {
      const e = el('div', 'rw-seg');
      e.style.flex = `${Math.max(0.02, sec.len)} 1 0`;
      const fill = el('i');
      e.appendChild(fill);
      this.bar.insertBefore(e, this.marker);
      this.segs.push({ el: e, fill, start: acc, len: sec.len });
      acc += sec.len;
    }
    this.progressBox.style.display = this.segs.length ? '' : 'none';
    this.wrap.classList.toggle('rw-closed', stage.closed && stage.discipline !== 'testpad' && stage.laps > 1);
    this.lastSplits = 0;
    // sentinel (never a real key): forces updateNotes to rebuild, also when the new stage has no notes
    // ('' is the key of an empty list, which left the previous stage's cards on screen)
    this.noteKey = '\u0000';
  }

  private updateNotes(ctx: Readonly<FrameContext>): void {
    const notes = uiSettings.pacenoteHud ? ctx.race.pacenotes : [];
    const key = notes.map((n) => `${n.s}`).join('|');
    if (key !== this.noteKey) {
      this.noteKey = key;
      this.notesEl.innerHTML = '';
      this.noteCards = notes.map((n) => {
        const said = ` ${n.text.toLowerCase().replace(/[^a-z' ]+/g, ' ')} `;
        const mods = n.modifiers ?? [];
        const warn = mods.some((m) => WARN_MODIFIERS.has(m));
        const card = el('div', `rw-note rw-plate${warn ? ' rw-warncard' : ''}`);
        // chips only for what the headline does not already say (the call text includes most modifiers)
        const tags = mods
          .filter((m) => !said.includes(` ${(MODIFIER_LABEL[m] ?? m).toLowerCase()} `))
          .map((m) => `<span class="${WARN_MODIFIERS.has(m) ? 'rw-warn' : ''}">${escapeHtml(MODIFIER_LABEL[m] ?? m)}</span>`)
          .join('');
        card.innerHTML =
          pacenoteSvg(n) +
          (n.severity > 0 ? `<div class="rw-sev">${n.severity}</div>` : '') +
          `<div class="rw-ntext"><b>${escapeHtml(n.text)}</b><div class="rw-tags">${tags}</div><span class="rw-dist"></span></div>`;
        this.notesEl.appendChild(card);
        return { el: card, dist: card.querySelector('.rw-dist') as HTMLElement, note: n };
      });
    }
    const s = ctx.race.s;
    for (const c of this.noteCards) {
      let d = c.note.cornerS - s;
      if (ctx.stage.closed && d < -ctx.stage.length / 2) d += ctx.stage.length;
      const txt = d > 1 ? `${Math.round(d / 5) * 5} m` : 'now';
      if (c.dist.textContent !== txt) c.dist.textContent = txt;
      c.el.classList.toggle('rw-passed', d < -15);
    }
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.wrap.classList.toggle('rw-hidden', !on);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.offToast();
    this.offSettings();
    this.voice.stop();
    this.wrap.remove();
  }
}
