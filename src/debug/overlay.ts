/**
 * src/debug/overlay.ts — OWNED BY THE GAME BUILDER.
 *
 * Read-only telemetry overlay of §6 "Debug overlay" — the core tool for iterating on feel:
 *  - car: speed (forward / world), rpm, gear + shift state, boost, tyre, transmission, pedals;
 *  - dynamics: β (deg), yaw rate, a_lat / a_long (g), steer input + wheel angle, yaw caps active, airMul,
 *    nContacts, body contact, impact impulse;
 *  - per wheel {GRIP / SLIDE mode, Fz, μ, α (deg), κ, Fx, Fy, ω, drive / brake torque, suspension, surface};
 *  - friction circles (|F| / μFz per wheel, red when sliding);
 *  - rolling graphs (6 s of SIM time, sampled at 60 Hz by sample() once per physics step; frame-rate
 *    independent): speed, β, yaw rate, a_lat (8-step average, see below), steer (+ steer angle), throttle (+ brake);
 *  - a_lat / a_long are shown as 8-step (1/15 s) averages: the §2.6 2-step Δv telemetry still swings by about
 *    1 g step to step at low-speed full lock (3- / 7-step patterns on fwd / rwd), which is a model property;
 *  - fps / steps / time scale / race s & lateral / phase / resets.
 * Toggle with F2 (also F4 / O); ?debug=1 shows it at start. Lives in #overlay-root (no pointer events).
 *
 * REQUIRED EXPORTS (contract in src/core/types.ts ITelemetryOverlay):
 *   class TelemetryOverlay implements ITelemetryOverlay
 *     constructor(root: HTMLElement)
 *     readonly visible: boolean
 *     setVisible(on: boolean): void; toggle(): void
 *     update(ctx: Readonly<FrameContext>): void
 *     dispose(): void
 */
import { G_REPORT } from '../core/constants';
import { RAD2DEG } from '../core/math';
import type { CarTelemetry, FrameContext, ITelemetryOverlay } from '../core/types';
import { drawFrictionCircles, StripCharts, type WheelForce } from './graphs';
import { isTypingTarget } from './util';

const CSS = `
.rw-ovl { position: absolute; left: 8px; top: 80px; width: 372px; max-height: calc(100vh - 80px); overflow: hidden; display: none; pointer-events: none;
  background: rgba(6, 9, 13, 0.78); border-left: 3px solid #59c6ff; color: #d8e6f0; font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.rw-ovl.rw-on { display: block; }
.rw-ovl pre { margin: 0; padding: 6px 8px 4px; white-space: pre; }
.rw-ovl .g { color: #34d27f; } .rw-ovl .r { color: #ff6b5e; } .rw-ovl .y { color: #ffb81c; } .rw-ovl .d { color: #7d8a97; } .rw-ovl .b { color: #7fd4ff; }
.rw-ovl .rw-ovl-row { display: flex; gap: 4px; padding: 0 8px 4px; align-items: flex-start; }
.rw-ovl canvas { display: block; }
.rw-ovl .bar { display: inline-block; height: 7px; vertical-align: 0; background: #ffb81c; }
`;

const WHEEL_NAMES = ['FL', 'FR', 'RR', 'RL'];
/** Graph sampling: every 2nd physics step (60 Hz sim time), 6 s window. */
const SAMPLE_EVERY = 2;
const GRAPH_SECONDS = 6;
const GRAPH_CAPACITY = (GRAPH_SECONDS * 120) / SAMPLE_EVERY;
/** a_lat / a_long display average (steps). */
const ACC_AVG_STEPS = 8;
/** Table order on screen: FL FR / RL RR. */
const TABLE_ORDER = [0, 1, 3, 2];

const pad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const f = (v: number, d = 0, w = 6) => pad(Number.isFinite(v) ? v.toFixed(d) : '—', w);
const bar = (v: number, w = 50, color = '#ffb81c') =>
  `<span class="bar" style="width:${Math.round(Math.max(0, Math.min(1, v)) * w)}px;background:${color}"></span>`;

export class TelemetryOverlay implements ITelemetryOverlay {
  private readonly el: HTMLDivElement;
  private readonly text: HTMLPreElement;
  private readonly wheelsPre: HTMLPreElement;
  private readonly circles: HTMLCanvasElement;
  private readonly circlesCtx: CanvasRenderingContext2D | null;
  private readonly charts: StripCharts;
  private shown = false;
  private textT = 0;
  private lastStep = -1;
  private lastReset = -1;
  /** Steps sampled through sample() since the last update() (0 → update() falls back to one push per frame). */
  private sampled = 0;
  private sampleN = 0;
  private readonly accRing = new Float64Array(2 * ACC_AVG_STEPS);
  private accN = 0;
  private accHead = 0;
  /** 8-step averages (m/s²). */
  private aLatAvg = 0;
  private aLongAvg = 0;

  private readonly onKey = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    if (e.code === 'F2' || e.code === 'F4' || e.code === 'KeyO') {
      e.preventDefault();
      if (!e.repeat) this.toggle();
    }
  };

  constructor(root: HTMLElement) {
    if (typeof document !== 'undefined' && !document.getElementById('rw-ovl-css')) {
      const st = document.createElement('style');
      st.id = 'rw-ovl-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'rw-ovl';
    this.text = document.createElement('pre');
    const row = document.createElement('div');
    row.className = 'rw-ovl-row';
    this.wheelsPre = document.createElement('pre');
    this.wheelsPre.style.padding = '0';
    this.circles = document.createElement('canvas');
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    this.circles.width = 96 * dpr;
    this.circles.height = 118 * dpr;
    this.circles.style.width = '96px';
    this.circles.style.height = '118px';
    this.circlesCtx = this.circles.getContext('2d');
    this.circlesCtx?.scale(dpr, dpr);
    row.append(this.wheelsPre, this.circles);
    this.charts = new StripCharts(
      [
        { label: 'speed', unit: ' km/h', min: 0, max: 220, color: '#ffb81c' },
        { label: 'β', unit: '°', min: -45, max: 45, color: '#ff6b5e', zero: true },
        { label: 'yaw', unit: ' rad/s', min: -3, max: 3, color: '#7fd4ff', zero: true, color2: '#ff3b2f', label2: 'cap active' },
        { label: 'a_lat', unit: ' g', min: -2, max: 2, color: '#34d27f', zero: true, color2: 'rgba(52,210,127,0.4)', label2: 'a_long' },
        { label: 'steer', unit: '', min: -1, max: 1, color: '#e0e0e0', zero: true, color2: '#ffb81c', label2: 'wheel°/34' },
        { label: 'thr', unit: '', min: 0, max: 1, color: '#34d27f', color2: '#ff6b5e', label2: 'brake' },
      ],
      356,
      40,
      GRAPH_CAPACITY,
    );
    this.charts.canvas.style.margin = '0 8px 8px';
    this.el.append(this.text, row, this.charts.canvas);
    root.appendChild(this.el);
    window.addEventListener('keydown', this.onKey);
  }

  get visible(): boolean {
    return this.shown;
  }

  setVisible(on: boolean): void {
    this.shown = on;
    this.el.classList.toggle('rw-on', on);
  }

  toggle(): void {
    this.setVisible(!this.shown);
  }

  /**
   * Once per physics step (main.ts): graph samples on the sim clock (every 2nd step = 60 Hz) and the 8-step
   * acceleration averages. Cheap; runs while hidden so the graphs have history when opened.
   */
  sample(t: Readonly<CarTelemetry>): void {
    if (t.resetCount !== this.lastReset) {
      this.lastReset = t.resetCount;
      this.charts.clear();
      this.accN = this.accHead = 0;
    }
    this.lastStep = t.stepCount;
    this.sampled++;
    this.pushAccel(t);
    if (this.sampleN++ % SAMPLE_EVERY === 0) this.pushChart(t);
  }

  private pushAccel(t: Readonly<CarTelemetry>): void {
    const r = this.accRing;
    r[2 * this.accHead] = Number.isFinite(t.aLat) ? t.aLat : 0;
    r[2 * this.accHead + 1] = Number.isFinite(t.aLong) ? t.aLong : 0;
    this.accHead = (this.accHead + 1) % ACC_AVG_STEPS;
    this.accN = Math.min(ACC_AVG_STEPS, this.accN + 1);
    let a = 0;
    let b = 0;
    for (let i = 0; i < this.accN; i++) {
      a += r[2 * i];
      b += r[2 * i + 1];
    }
    this.aLatAvg = a / this.accN;
    this.aLongAvg = b / this.accN;
  }

  private pushChart(t: Readonly<CarTelemetry>): void {
    this.charts.push(
      [t.speedKmh, t.beta * RAD2DEG, t.yawRate, this.aLatAvg / G_REPORT, t.steer, t.throttle],
      [undefined, undefined, t.yawRateCapActive || t.yawCapActive ? t.yawRate : undefined, this.aLongAvg / G_REPORT, (t.steerAngle * RAD2DEG) / 34.4, t.brake],
    );
  }

  update(ctx: Readonly<FrameContext>): void {
    const t = ctx.telemetry;
    if (this.sampled === 0 && t.stepCount !== this.lastStep) {
      // nobody calls sample() (tests / other hosts): one sample per rendered frame
      if (t.resetCount !== this.lastReset) {
        this.lastReset = t.resetCount;
        this.charts.clear();
        this.accN = this.accHead = 0;
      }
      this.lastStep = t.stepCount;
      this.pushAccel(t);
      this.pushChart(t);
    }
    this.sampled = 0;
    if (!this.shown) return;
    this.charts.draw();
    this.drawCircles(t);
    this.textT -= ctx.frameDt;
    if (this.textT > 0 && ctx.steps > 0) return;
    this.textT = 1 / 12;
    this.text.innerHTML = this.mainText(ctx);
    this.wheelsPre.innerHTML = this.wheelText(t);
  }

  private mainText(ctx: Readonly<FrameContext>): string {
    const t = ctx.telemetry;
    const r = ctx.race;
    const gear = t.gear === 0 ? 'R' : String(t.gear);
    const caps = `${t.yawCapActive ? '<span class="r">YAWCAP</span>' : '<span class="d">yawcap</span>'} ${t.yawRateCapActive ? '<span class="r">RATECAP</span>' : '<span class="d">ratecap</span>'}`;
    return [
      `<span class="b">fps</span> ${f(ctx.fps, 0, 3)}  <span class="b">steps</span> ${f(ctx.steps, 0, 2)}  <span class="b">×</span>${ctx.timeScale.toFixed(2)}  ${ctx.paused ? '<span class="r">PAUSED</span>' : ''} ${ctx.autopilot ? '<span class="y">AUTO</span>' : ''}  <span class="d">${ctx.cameraMode}</span>`,
      `<span class="y">${f(t.speedKmh, 1, 6)}</span> km/h  world ${f(t.speedWorldKmh, 1, 6)}  rpm ${f(t.rpm, 0, 5)}  <span class="y">${gear}</span>/${t.nGears}${t.shifting ? '<span class="r">*</span>' : ' '} ${t.transmission}`,
      `boost ${bar(t.boostFrac, 40, '#7fd4ff')} ${t.boostFrac.toFixed(2)}  tyre ${t.tyreType}  ${t.parked ? '<span class="r">PARKED</span>' : ''}`,
      `thr ${bar(t.throttle, 40, '#34d27f')} brk ${bar(t.brake, 40, '#ff6b5e')} hb ${bar(t.handbrake, 40, '#ffb81c')}`,
      `steer ${f(t.steer, 2, 5)}  wheel ${f(t.steerAngle * RAD2DEG, 1, 5)}°  <span class="y">β ${f(t.beta * RAD2DEG, 1, 6)}°</span>  yaw ${f(t.yawRate, 2, 5)}`,
      `a_lat ${f(this.aLatAvg / G_REPORT, 2, 5)}g  a_long ${f(this.aLongAvg / G_REPORT, 2, 5)}g <span class="d">(8-step)</span>  a_v ${f(t.aVert / G_REPORT, 2, 5)}g`,
      `${caps}  air ${t.airMul.toFixed(2)}  n ${t.nContacts}${t.airborne ? ' <span class="r">AIR</span>' : ''}${t.bodyOnGround ? ' <span class="r">BODY</span>' : ''}${t.impactImpulse > 0 ? ` <span class="r">hit ${t.impactImpulse.toFixed(0)}</span>` : ''}${t.simFaults > 0 ? ` <span class="r">SIM FAULTS ${t.simFaults}</span>` : ''}`,
      `<span class="b">race</span> ${r.phase} s ${f(r.s, 1, 7)} lat ${f(r.lateral, 1, 6)} ${(r.progress * 100).toFixed(1)}% resets ${r.resets}${r.wrongWay ? ' <span class="r">WRONG WAY</span>' : ''}`,
    ].join('\n');
  }

  private wheelText(t: Readonly<CarTelemetry>): string {
    const head = `<span class="d">     ${TABLE_ORDER.map((i) => pad(WHEEL_NAMES[i], 7)).join('')}</span>`;
    const row = (label: string, fn: (i: number) => string) => `${pad(label, 4)} ${TABLE_ORDER.map((i) => fn(i)).join('')}`;
    const w = t.wheels;
    return [
      head,
      row('mode', (i) =>
        !w[i].contact ? pad('air', 7).replace('air', '<span class="d">air</span>') : w[i].mode === 2 ? pad('SLIDE', 7).replace('SLIDE', '<span class="r">SLIDE</span>') : pad('grip', 7).replace('grip', '<span class="g">grip</span>'),
      ),
      row('Fz', (i) => f(w[i].load, 0, 7)),
      row('μ', (i) => f(w[i].mu, 2, 7)),
      row('α°', (i) => f(w[i].slipAngle * RAD2DEG, 1, 7)),
      row('κ', (i) => f(w[i].kappa, 3, 7)),
      row('Fx', (i) => f(w[i].Fx, 0, 7)),
      row('Fy', (i) => f(w[i].Fy, 0, 7)),
      row('ω', (i) => f(w[i].omega, 1, 7)),
      row('Tdr', (i) => f(w[i].driveT, 0, 7)),
      row('Tbr', (i) => f(w[i].brakeT, 0, 7)),
      row('Fs', (i) => f(w[i].Fsusp, 0, 7)),
      row('susp', (i) => f(w[i].visual?.suspensionOffset ?? 0, 3, 7)),
      row('surf', (i) => pad((w[i].surface ?? '—').slice(0, 6), 7)),
    ].join('\n');
  }

  private drawCircles(t: Readonly<CarTelemetry>): void {
    const g = this.circlesCtx;
    if (!g) return;
    let maxLoad = 1;
    for (const w of t.wheels) maxLoad = Math.max(maxLoad, w.load);
    const wf: WheelForce[] = t.wheels.map((w) => {
      const cap = Math.max(1, w.mu * w.load);
      return { fx: w.Fx / cap, fy: w.Fy / cap, slide: w.mode === 2, contact: w.contact, load: w.load };
    });
    drawFrictionCircles(g, 96, 118, wf, maxLoad * 0.8);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.el.remove();
  }
}
