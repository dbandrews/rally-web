/**
 * src/debug/graphs.ts — game builder. Rolling strip charts on one canvas (telemetry overlay) and the
 * per-wheel friction-circle diagram.
 */

export interface SeriesSpec {
  label: string;
  unit: string;
  min: number;
  max: number;
  color: string;
  /** Optional second series drawn in the same strip. */
  color2?: string;
  label2?: string;
  /** Draw a zero line. */
  zero?: boolean;
}

export class StripCharts {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly specs: SeriesSpec[];
  private readonly cap: number;
  private readonly data: Float32Array[];
  private readonly data2: Float32Array[];
  private head = 0;
  private count = 0;
  private readonly w: number;
  private readonly h: number;

  constructor(specs: SeriesSpec[], width = 360, stripH = 46, capacity = 600) {
    this.specs = specs;
    this.cap = capacity;
    this.w = width;
    this.h = stripH * specs.length;
    this.canvas = document.createElement('canvas');
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx = this.canvas.getContext('2d');
    this.ctx?.scale(dpr, dpr);
    this.data = specs.map(() => new Float32Array(capacity));
    this.data2 = specs.map(() => new Float32Array(capacity));
  }

  push(values: readonly number[], values2?: readonly (number | undefined)[]): void {
    for (let i = 0; i < this.specs.length; i++) {
      this.data[i][this.head] = Number.isFinite(values[i]) ? values[i] : 0;
      const v2 = values2?.[i];
      this.data2[i][this.head] = v2 !== undefined && Number.isFinite(v2) ? v2 : Number.NaN;
    }
    this.head = (this.head + 1) % this.cap;
    this.count = Math.min(this.cap, this.count + 1);
  }

  clear(): void {
    this.head = this.count = 0;
  }

  draw(): void {
    const g = this.ctx;
    if (!g) return;
    const W = this.w;
    const sh = this.h / this.specs.length;
    g.clearRect(0, 0, W, this.h);
    g.font = '10px ui-monospace, monospace';
    for (let i = 0; i < this.specs.length; i++) {
      const sp = this.specs[i];
      const y0 = i * sh;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)';
      g.fillRect(0, y0, W, sh);
      const yOf = (v: number) => y0 + sh - 3 - ((Math.min(sp.max, Math.max(sp.min, v)) - sp.min) / (sp.max - sp.min)) * (sh - 6);
      if (sp.zero && sp.min < 0 && sp.max > 0) {
        g.strokeStyle = 'rgba(255,255,255,0.18)';
        g.beginPath();
        g.moveTo(0, yOf(0));
        g.lineTo(W, yOf(0));
        g.stroke();
      }
      const line = (arr: Float32Array, color: string) => {
        g.strokeStyle = color;
        g.lineWidth = 1.4;
        g.beginPath();
        let started = false;
        for (let k = 0; k < this.count; k++) {
          const idx = (this.head - this.count + k + this.cap) % this.cap;
          const v = arr[idx];
          if (!Number.isFinite(v)) {
            started = false;
            continue;
          }
          const x = W - (this.count - 1 - k) * (W / (this.cap - 1));
          const y = yOf(v);
          if (!started) {
            g.moveTo(x, y);
            started = true;
          } else g.lineTo(x, y);
        }
        g.stroke();
      };
      line(this.data[i], sp.color);
      if (sp.color2) line(this.data2[i], sp.color2);
      const last = this.count ? this.data[i][(this.head - 1 + this.cap) % this.cap] : 0;
      g.fillStyle = sp.color;
      g.fillText(`${sp.label} ${last.toFixed(Math.abs(sp.max) >= 50 ? 0 : 2)}${sp.unit}`, 4, y0 + 11);
      if (sp.label2 && sp.color2) {
        g.fillStyle = sp.color2;
        g.fillText(sp.label2, W - 4 - g.measureText(sp.label2).width, y0 + 11);
      }
    }
  }
}

export interface WheelForce {
  /** Normalised by μ·Fz: lateral (+ right) and longitudinal (+ forward). */
  fy: number;
  fx: number;
  slide: boolean;
  contact: boolean;
  load: number;
}

/** Top-down car with one friction circle per wheel (wheel order FL, FR, RR, RL). */
export function drawFrictionCircles(g: CanvasRenderingContext2D, w: number, h: number, wheels: readonly WheelForce[], maxLoad: number): void {
  g.clearRect(0, 0, w, h);
  const pos: [number, number][] = [
    [0.27, 0.25],
    [0.73, 0.25],
    [0.73, 0.75],
    [0.27, 0.75],
  ];
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = 1;
  g.strokeRect(w * 0.36, h * 0.12, w * 0.28, h * 0.76);
  const R = Math.min(w, h) * 0.2;
  wheels.forEach((wh, i) => {
    const cx = pos[i][0] * w;
    const cy = pos[i][1] * h;
    const lr = R * (0.55 + 0.45 * Math.min(1.4, wh.load / Math.max(1, maxLoad)));
    g.strokeStyle = wh.contact ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.12)';
    g.beginPath();
    g.arc(cx, cy, lr, 0, Math.PI * 2);
    g.stroke();
    if (!wh.contact) return;
    const x = cx + Math.max(-1.5, Math.min(1.5, wh.fy)) * lr;
    const y = cy - Math.max(-1.5, Math.min(1.5, wh.fx)) * lr;
    g.strokeStyle = wh.slide ? '#ff4b3e' : '#34d27f';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(x, y);
    g.stroke();
    g.fillStyle = wh.slide ? '#ff4b3e' : '#34d27f';
    g.beginPath();
    g.arc(x, y, 3, 0, Math.PI * 2);
    g.fill();
  });
}
