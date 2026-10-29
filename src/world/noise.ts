/**
 * src/world/noise.ts — seeded 2-D gradient noise (Perlin) and fractal helpers for terrain generation.
 * Deterministic: the permutation and gradients come from src/core/rng.ts (never Math.random).
 */
import { Rng } from '../core/rng';

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

export class Noise2D {
  private readonly perm = new Uint16Array(512);
  private readonly gx = new Float64Array(256);
  private readonly gy = new Float64Array(256);

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint16Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) {
      const a = rng.next() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  /** Perlin gradient noise, approximately in [-1, 1]. */
  perlin(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const p = this.perm;
    const a = p[X] + Y;
    const b = p[X + 1] + Y;
    const g00 = p[a] & 255;
    const g01 = p[a + 1] & 255;
    const g10 = p[b] & 255;
    const g11 = p[b + 1] & 255;
    const gx = this.gx;
    const gy = this.gy;
    const n00 = gx[g00] * xf + gy[g00] * yf;
    const n10 = gx[g10] * (xf - 1) + gy[g10] * yf;
    const n01 = gx[g01] * xf + gy[g01] * (yf - 1);
    const n11 = gx[g11] * (xf - 1) + gy[g11] * (yf - 1);
    const u = fade(xf);
    const v = fade(yf);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.41421356;
  }

  /** Fractal Brownian motion, normalised to roughly [-1, 1]. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.perlin(x * freq + i * 17.13, y * freq - i * 9.71);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1] (sharp crests, smooth valleys). */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const r = 1 - Math.abs(this.perlin(x * freq + i * 31.7, y * freq + i * 5.3));
      sum += amp * r * r;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

/** Smooth 1-D value noise over s (for width / surface wobble along a road), in [-1, 1]. */
export class Noise1D {
  private readonly v: Float64Array;
  constructor(seed: number, size = 512) {
    const rng = new Rng(seed);
    this.v = new Float64Array(size);
    for (let i = 0; i < size; i++) this.v[i] = rng.next() * 2 - 1;
  }
  at(x: number): number {
    const n = this.v.length;
    const i = Math.floor(x);
    const f = x - i;
    const a = this.v[((i % n) + n) % n];
    const b = this.v[(((i + 1) % n) + n) % n];
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  }
}
