/**
 * src/world/profile.ts — 1-D signal helpers for road profiles along s: Gaussian smoothing, grade
 * (slope) limiting, and elevation features (crests, jumps, dips).
 */

/** Gaussian smoothing with sigma in SAMPLES. Open arrays renormalise at the ends; closed arrays wrap. */
export function gaussianSmooth(src: Float64Array, sigma: number, closed: boolean): Float64Array {
  const n = src.length;
  if (sigma <= 0.01) return Float64Array.from(src);
  const r = Math.max(1, Math.ceil(sigma * 3));
  const w = new Float64Array(2 * r + 1);
  for (let k = -r; k <= r; k++) w[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let norm = 0;
    for (let k = -r; k <= r; k++) {
      let j = i + k;
      if (closed) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      sum += src[j] * w[k + r];
      norm += w[k + r];
    }
    out[i] = sum / norm;
  }
  return out;
}

/**
 * Limit |dy/ds| ≤ gmax[i] (per sample) by averaging a forward-lagging and a backward-lagging clamp
 * (both satisfy the bound, so their average does too). Closed profiles iterate around the loop.
 */
export function gradeLimit(src: Float64Array, gmax: Float64Array, ds: number, closed: boolean): Float64Array {
  const n = src.length;
  const f = Float64Array.from(src);
  const b = Float64Array.from(src);
  if (!closed) {
    for (let i = 1; i < n; i++) {
      const g = Math.min(gmax[i], gmax[i - 1]) * ds;
      f[i] = Math.min(f[i - 1] + g, Math.max(f[i - 1] - g, src[i]));
    }
    for (let i = n - 2; i >= 0; i--) {
      const g = Math.min(gmax[i], gmax[i + 1]) * ds;
      b[i] = Math.min(b[i + 1] + g, Math.max(b[i + 1] - g, src[i]));
    }
  } else {
    for (let lap = 0; lap < 3; lap++) {
      for (let i = 0; i < n; i++) {
        const p = (i - 1 + n) % n;
        const g = Math.min(gmax[i], gmax[p]) * ds;
        f[i] = Math.min(f[p] + g, Math.max(f[p] - g, lap === 0 ? src[i] : f[i]));
      }
      for (let i = n - 1; i >= 0; i--) {
        const q = (i + 1) % n;
        const g = Math.min(gmax[i], gmax[q]) * ds;
        b[i] = Math.min(b[q] + g, Math.max(b[q] - g, lap === 0 ? src[i] : b[i]));
      }
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * (f[i] + b[i]);
  return out;
}

export type ElevationFeatureKind = 'crest' | 'jump' | 'dip' | 'tabletop';

export interface ElevationFeature {
  kind: ElevationFeatureKind;
  /** Crest top / jump lip / dip bottom (m along s). */
  s: number;
  /** Height (m, > 0; dips go down by h). */
  h: number;
  /** Lengths before / after s (m). */
  before: number;
  after: number;
  /** Optional tag (pacenote hint, e.g. 'water'). */
  tag?: string;
}

/** Height offset of one feature at distance u = s - feature.s. */
export function featureOffset(f: ElevationFeature, u: number): number {
  if (u <= -f.before || u >= f.after) return 0;
  switch (f.kind) {
    case 'crest':
    case 'dip': {
      const half = u < 0 ? f.before : f.after;
      const v = 0.5 * (1 + Math.cos((Math.PI * u) / half));
      return f.kind === 'crest' ? f.h * v : -f.h * v;
    }
    case 'jump': {
      // smooth run-up whose slope is largest at the lip, then a sharp break and a long landing slope
      if (u < 0) {
        const t = (u + f.before) / f.before; // 0..1
        return f.h * (1 - Math.cos((Math.PI / 2) * t));
      }
      const t = u / f.after;
      return f.h * (1 - t) * (1 - t);
    }
    case 'tabletop': {
      // ramp up over `before`, flat top of 6 m, ramp down over `after - 6`
      const top = 6;
      if (u < 0) {
        const t = (u + f.before) / f.before;
        const g = t < 0.2 ? (t * t) / 0.4 : t - 0.1; // C1 blend into a straight ramp
        return (f.h * g) / 0.9;
      }
      if (u < top) return f.h;
      const t = (u - top) / Math.max(1, f.after - top);
      return f.h * (1 - t * t * (3 - 2 * t));
    }
  }
}
