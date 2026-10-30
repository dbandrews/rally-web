/**
 * src/render/textures.ts — procedural canvas textures (render builder). No external assets.
 *
 * Everything is generated at runtime from seeded noise and cached for the session:
 *   - terrainDetail(): RGB detail map for the terrain shader (R pebbles, G grass streaks, B soft blotches)
 *   - roadTexture(surface): road ribbon albedo per surface (u = across the road, v = along it, tiles in v)
 *   - shoulderTexture(): loose verge noise
 *   - rimTexture(color): wheel rim face (spokes make the spin visible)
 *   - textTexture(...): banners / gate boards
 * In a non-DOM environment (vitest) the factories return null and callers fall back to plain colours.
 */
import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { SurfaceId } from '../core/types';

export const hasDom = (): boolean => typeof document !== 'undefined' && typeof document.createElement === 'function';

export function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (!hasDom()) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ------------------------------------------------------------------------------------------- noise

/** Tileable value noise in [0, 1], `period` cells across `size` pixels (period must divide nicely). */
export function tileNoise(w: number, h: number, periodX: number, periodY: number, rng: Rng): Float32Array {
  const grid = new Float32Array(periodX * periodY);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
  const out = new Float32Array(w * h);
  const sx = periodX / w, sy = periodY / h;
  for (let y = 0; y < h; y++) {
    const fy = y * sy;
    const iy = Math.floor(fy);
    let ty = fy - iy;
    ty = ty * ty * (3 - 2 * ty);
    const y0 = iy % periodY, y1 = (iy + 1) % periodY;
    for (let x = 0; x < w; x++) {
      const fx = x * sx;
      const ix = Math.floor(fx);
      let tx = fx - ix;
      tx = tx * tx * (3 - 2 * tx);
      const x0 = ix % periodX, x1 = (ix + 1) % periodX;
      const a = grid[y0 * periodX + x0], b = grid[y0 * periodX + x1];
      const c = grid[y1 * periodX + x0], d = grid[y1 * periodX + x1];
      out[y * w + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return out;
}

/** Fractal sum of tileable octaves, normalised to ~[0, 1]. */
export function fbm(w: number, h: number, basePeriod: number, octaves: number, rng: Rng, aspectY = 1): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 1, total = 0, p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    const n = tileNoise(w, h, p, Math.max(1, Math.round(p * aspectY)), rng);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= 0.5;
    p *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function rgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

function finishTexture(c: HTMLCanvasElement, srgb: boolean, repeatV: boolean, repeatU = repeatV): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = repeatU ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = repeatV ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const cache = new Map<string, THREE.Texture | null>();
function cached<T extends THREE.Texture>(key: string, make: () => T | null): T | null {
  if (cache.has(key)) return cache.get(key) as T | null;
  const t = make();
  cache.set(key, t);
  return t;
}

// ------------------------------------------------------------------------------------------- terrain detail

/** RGB detail map (linear data). R: pebbles/grit, G: grass streaks, B: soft blotches. Mean ≈ 0.5. */
export function terrainDetail(): THREE.Texture | null {
  return cached('terrainDetail', () => {
    const S = 512;
    const c = makeCanvas(S, S);
    if (!c) return null;
    const rng = new Rng(9001);
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(S, S);
    const grit = fbm(S, S, 64, 3, rng);
    const blot = fbm(S, S, 4, 4, rng);
    const streakA = fbm(S, S, 128, 2, rng);
    const streakB = fbm(S, S, 16, 3, rng);
    for (let i = 0; i < S * S; i++) {
      // pebbles: high-contrast thresholded grit + speckle
      const g = grit[i];
      const peb = 0.5 + (smooth(0.55, 0.7, g) - smooth(0.25, 0.4, 1 - g)) * 0.35 + (rng.next() - 0.5) * 0.18;
      // grass: vertical-ish streaks (anisotropic noise) modulated by patches
      const gr = 0.5 + (streakA[i] - 0.5) * 0.7 + (streakB[i] - 0.5) * 0.45 + (rng.next() - 0.5) * 0.22;
      const bl = 0.5 + (blot[i] - 0.5) * 0.7 + (rng.next() - 0.5) * 0.03;
      img.data[i * 4] = Math.round(clamp01(peb) * 255);
      img.data[i * 4 + 1] = Math.round(clamp01(gr) * 255);
      img.data[i * 4 + 2] = Math.round(clamp01(bl) * 255);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return finishTexture(c, false, true);
  });
}

// ------------------------------------------------------------------------------------------- roads

export interface RoadLook {
  map: THREE.Texture | null;
  /** Metres of road per texture repeat along the road. */
  tileLength: number;
  roughness: number;
  metalness: number;
  /** Average colour (sRGB hex), used when textures are unavailable and for shoulders. */
  color: number;
  /** Verge / shoulder colour (sRGB hex) blended over the terrain beside the road. */
  shoulder: number;
}

interface RoadPainter {
  base: number;
  tile: number;
  rough: number;
  shoulder: number;
  paint: (px: Uint8ClampedArray, W: number, H: number, rng: Rng) => void;
}

/** Shared helper: fill with base colour × noise. */
function fillNoise(px: Uint8ClampedArray, W: number, H: number, base: number, rng: Rng, coarse: number, fine: number, period = 8): Float32Array {
  const [r, g, b] = rgb(base);
  const n1 = fbm(W, H, period, 4, rng, 2);
  for (let i = 0; i < W * H; i++) {
    const k = 1 + (n1[i] - 0.5) * coarse + (rng.next() - 0.5) * fine;
    px[i * 4] = r * k;
    px[i * 4 + 1] = g * k;
    px[i * 4 + 2] = b * k;
    px[i * 4 + 3] = 255;
  }
  return n1;
}

/** Multiply a vertical band (u0..u1, soft edges) by `k` (tint toward `col` by `mix`). */
function band(px: Uint8ClampedArray, W: number, H: number, u0: number, u1: number, soft: number, k: number, col?: number, mix = 0, wobble?: Float32Array) {
  const c = col !== undefined ? rgb(col) : null;
  for (let y = 0; y < H; y++) {
    const wob = wobble ? (wobble[y * W] - 0.5) * 0.04 : 0;
    for (let x = 0; x < W; x++) {
      const u = x / W + wob;
      const w = smooth(u0 - soft, u0 + soft, u) * (1 - smooth(u1 - soft, u1 + soft, u));
      if (w <= 0) continue;
      const i = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let v = px[i + ch] * (1 + (k - 1) * w);
        if (c) v = v + (c[ch] - v) * mix * w;
        px[i + ch] = v;
      }
    }
  }
}

/** Speckles (stones) of random size / brightness. */
function speckle(px: Uint8ClampedArray, W: number, H: number, rng: Rng, count: number, rMin: number, rMax: number, colA: number, colB: number, alpha: number, uMask?: (u: number) => number) {
  const a = rgb(colA), b = rgb(colB);
  for (let n = 0; n < count; n++) {
    const cx = rng.next() * W, cy = rng.next() * H;
    const m = uMask ? uMask(cx / W) : 1;
    if (rng.next() > m) continue;
    const r = rMin + rng.next() * (rMax - rMin);
    const t = rng.next();
    const col = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const r2 = r * r;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const x = Math.floor(cx + dx), y = (Math.floor(cy + dy) + H) % H;
        if (x < 0 || x >= W) continue;
        const i = (y * W + x) * 4;
        const shade = 1 - (dx + dy) / (r * 4); // fake light from the top-left
        const al = alpha * (1 - d2 / (r2 * 1.6));
        for (let ch = 0; ch < 3; ch++) px[i + ch] = px[i + ch] + (col[ch] * shade - px[i + ch]) * al;
      }
    }
  }
}

/** Painted line (u0..u1) with dash pattern along v (dashOn/period in 0..1 of the tile); worn edges. */
function paintLine(px: Uint8ClampedArray, W: number, H: number, u0: number, u1: number, col: number, rng: Rng, dashOn = 1, phase = 0) {
  const c = rgb(col);
  for (let y = 0; y < H; y++) {
    const v = ((y / H + phase) % 1 + 1) % 1;
    if (v > dashOn) continue;
    for (let x = Math.floor(u0 * W); x <= Math.ceil(u1 * W); x++) {
      if (x < 0 || x >= W) continue;
      const wear = rng.next();
      if (wear < 0.12) continue;
      const i = (y * W + x) * 4;
      const a = 0.75 + wear * 0.2;
      for (let ch = 0; ch < 3; ch++) px[i + ch] = px[i + ch] + (c[ch] - px[i + ch]) * a;
    }
  }
}

/** The surfaces with a painted road look of their own (the original ten). */
type PaintedSurface = 'tarmac' | 'gravel' | 'gravelDeep' | 'mud' | 'snow' | 'ice' | 'grass' | 'sand' | 'cobbles' | 'water';

/**
 * Nearest-look STAND-INS for the appended original materials (rally-web ids 10..22): they share the painter and
 * the cached texture of the named surface. Procedural roads only; the original stages' look comes from their
 * track textures (track / effects builders replace these).
 */
const ROAD_STAND_IN: Readonly<Record<Exclude<SurfaceId, PaintedSurface>, PaintedSurface>> = {
  wood: 'cobbles',
  snowChunky: 'snow',
  snowDeep: 'snow',
  snowAsphalt: 'snow',
  snowDitch: 'snow',
  leaf: 'mud',
  asphaltGrass: 'tarmac',
  gravelGrass: 'gravel',
  mudGrass: 'mud',
  mudDitch: 'mud',
  sandDeep: 'sand',
  sandDark: 'sand',
  sandDarkDeep: 'sand',
};
const paintedOf = (s: SurfaceId): PaintedSurface =>
  (ROAD_STAND_IN as Partial<Record<SurfaceId, PaintedSurface>>)[s] ?? (s as PaintedSurface);

const ROAD_PAINTERS: Record<PaintedSurface, RoadPainter> = {
  tarmac: {
    base: 0x45484d,
    tile: 12,
    rough: 0.82,
    shoulder: 0x7d7566,
    paint(px, W, H, rng) {
      fillNoise(px, W, H, 0x45484d, rng, 0.22, 0.28, 6);
      speckle(px, W, H, rng, 2500, 0.6, 1.4, 0x5a5d62, 0x303236, 0.6);
      // polished wheel lines
      band(px, W, H, 0.2, 0.34, 0.04, 0.86);
      band(px, W, H, 0.66, 0.8, 0.04, 0.86);
      // tar seams
      for (let k = 0; k < 3; k++) {
        const u = 0.15 + rng.next() * 0.7;
        band(px, W, H, u, u + 0.006, 0.002, 0.7);
      }
      paintLine(px, W, H, 0.035, 0.06, 0xe9e6dc, rng);
      paintLine(px, W, H, 0.94, 0.965, 0xe9e6dc, rng);
      paintLine(px, W, H, 0.493, 0.507, 0xe9e6dc, rng, 0.34);
    },
  },
  water: {
    base: 0x30363d,
    tile: 12,
    rough: 0.22,
    shoulder: 0x5e5a50,
    paint(px, W, H, rng) {
      const n = fillNoise(px, W, H, 0x353a40, rng, 0.3, 0.18, 4);
      // dark puddles
      for (let i = 0; i < W * H; i++) {
        const p = smooth(0.55, 0.65, n[i]);
        for (let ch = 0; ch < 3; ch++) px[i * 4 + ch] *= 1 - p * 0.45;
      }
      band(px, W, H, 0.2, 0.34, 0.04, 0.8);
      band(px, W, H, 0.66, 0.8, 0.04, 0.8);
      paintLine(px, W, H, 0.035, 0.06, 0xb8b6ae, rng);
      paintLine(px, W, H, 0.94, 0.965, 0xb8b6ae, rng);
      paintLine(px, W, H, 0.493, 0.507, 0xb8b6ae, rng, 0.34);
    },
  },
  gravel: {
    base: 0xa08a6a,
    tile: 10,
    rough: 0.96,
    shoulder: 0x8c7a5e,
    paint(px, W, H, rng) {
      const wob = fbm(W, H, 2, 2, rng);
      fillNoise(px, W, H, 0xa08a6a, rng, 0.25, 0.22, 6);
      // compacted wheel ruts (darker, smoother), loose ridge in the centre and at the edges
      band(px, W, H, 0.22, 0.36, 0.035, 0.84, 0x7c6a52, 0.25, wob);
      band(px, W, H, 0.64, 0.78, 0.035, 0.84, 0x7c6a52, 0.25, wob);
      band(px, W, H, -0.1, 0.12, 0.05, 1.1, 0xb8a58a, 0.2);
      band(px, W, H, 0.88, 1.1, 0.05, 1.1, 0xb8a58a, 0.2);
      const loose = (u: number) => 0.25 + 0.75 * Math.max(smooth(0.36, 0.45, u) * (1 - smooth(0.55, 0.64, u)), 1 - smooth(0.12, 0.22, u), smooth(0.78, 0.88, u));
      speckle(px, W, H, rng, 9000, 0.6, 2.0, 0xc4b296, 0x6a5a46, 0.75, loose);
    },
  },
  gravelDeep: {
    base: 0xa8916f,
    tile: 10,
    rough: 0.97,
    shoulder: 0x93805f,
    paint(px, W, H, rng) {
      const wob = fbm(W, H, 2, 2, rng);
      fillNoise(px, W, H, 0xa8916f, rng, 0.3, 0.25, 5);
      band(px, W, H, 0.24, 0.36, 0.06, 0.9, 0x8a765a, 0.2, wob);
      band(px, W, H, 0.64, 0.76, 0.06, 0.9, 0x8a765a, 0.2, wob);
      speckle(px, W, H, rng, 14000, 0.6, 2.4, 0xcdbb9e, 0x6a5a46, 0.8);
    },
  },
  mud: {
    base: 0x5e4834,
    tile: 9,
    rough: 0.55,
    shoulder: 0x56432f,
    paint(px, W, H, rng) {
      const wob = fbm(W, H, 2, 2, rng);
      const n = fillNoise(px, W, H, 0x5e4834, rng, 0.35, 0.16, 5);
      band(px, W, H, 0.22, 0.36, 0.04, 0.7, 0x3a2c20, 0.3, wob);
      band(px, W, H, 0.64, 0.78, 0.04, 0.7, 0x3a2c20, 0.3, wob);
      // puddles in the ruts
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x, u = x / W;
          const inRut = Math.max(smooth(0.2, 0.25, u) * (1 - smooth(0.33, 0.38, u)), smooth(0.62, 0.67, u) * (1 - smooth(0.75, 0.8, u)));
          const p = smooth(0.6, 0.66, n[i]) * inRut;
          px[i * 4] = px[i * 4] * (1 - p) + 70 * p;
          px[i * 4 + 1] = px[i * 4 + 1] * (1 - p) + 66 * p;
          px[i * 4 + 2] = px[i * 4 + 2] * (1 - p) + 60 * p;
        }
      speckle(px, W, H, rng, 2500, 0.8, 2.5, 0x7a6248, 0x3c2e22, 0.5);
    },
  },
  snow: {
    base: 0xe8eef5,
    tile: 10,
    rough: 0.7,
    shoulder: 0xf2f6fa,
    paint(px, W, H, rng) {
      const wob = fbm(W, H, 2, 2, rng);
      fillNoise(px, W, H, 0xe6edf4, rng, 0.08, 0.06, 5);
      // compacted, slightly polished tracks with tread texture
      band(px, W, H, 0.2, 0.36, 0.05, 0.86, 0xb4c2d2, 0.4, wob);
      band(px, W, H, 0.64, 0.8, 0.05, 0.86, 0xb4c2d2, 0.4, wob);
      // tread imprints: faint darker rows inside both tracks
      for (let y = 0; y < H; y += 6) {
        for (let x = 0; x < W; x++) {
          const u = x / W;
          if (!((u > 0.23 && u < 0.33) || (u > 0.67 && u < 0.77))) continue;
          const i = (y * W + x) * 4;
          for (let ch = 0; ch < 3; ch++) px[i + ch] *= 0.95;
        }
      }
      speckle(px, W, H, rng, 1500, 0.5, 1.2, 0xffffff, 0xd8e2ec, 0.6);
    },
  },
  ice: {
    base: 0xb7d0e0,
    tile: 14,
    rough: 0.12,
    shoulder: 0xe8f0f6,
    paint(px, W, H, rng) {
      const n = fillNoise(px, W, H, 0xaecbdf, rng, 0.28, 0.04, 3);
      // frosty patches vs clear dark ice
      for (let i = 0; i < W * H; i++) {
        const f = smooth(0.5, 0.75, n[i]);
        px[i * 4] = px[i * 4] * (1 - f) + 226 * f;
        px[i * 4 + 1] = px[i * 4 + 1] * (1 - f) + 236 * f;
        px[i * 4 + 2] = px[i * 4 + 2] * (1 - f) + 244 * f;
      }
      // skate scratches / cracks
      const ctxLines = 60;
      for (let k = 0; k < ctxLines; k++) {
        let x = rng.next() * W, y = rng.next() * H;
        const ang = (rng.next() - 0.5) * 0.6 + (rng.next() < 0.5 ? Math.PI / 2 : 0);
        const len = 20 + rng.next() * 120;
        for (let t = 0; t < len; t++) {
          x += Math.cos(ang) + (rng.next() - 0.5) * 0.6;
          y += Math.sin(ang) + (rng.next() - 0.5) * 0.6;
          const xi = Math.floor(x), yi = ((Math.floor(y) % H) + H) % H;
          if (xi < 0 || xi >= W) break;
          const i = (yi * W + xi) * 4;
          px[i] = px[i] + (250 - px[i]) * 0.5;
          px[i + 1] = px[i + 1] + (252 - px[i + 1]) * 0.5;
          px[i + 2] = px[i + 2] + (255 - px[i + 2]) * 0.5;
        }
      }
    },
  },
  grass: {
    base: 0x587f3a,
    tile: 8,
    rough: 0.95,
    shoulder: 0x4e7834,
    paint(px, W, H, rng) {
      const wob = fbm(W, H, 2, 2, rng);
      fillNoise(px, W, H, 0x587f3a, rng, 0.3, 0.3, 8);
      band(px, W, H, 0.2, 0.36, 0.05, 0.85, 0x6a5a3e, 0.55, wob);
      band(px, W, H, 0.64, 0.8, 0.05, 0.85, 0x6a5a3e, 0.55, wob);
    },
  },
  sand: {
    base: 0xd4b57e,
    tile: 10,
    rough: 0.95,
    shoulder: 0xd8bc88,
    paint(px, W, H, rng) {
      const wob = fbm(W, H, 2, 2, rng);
      fillNoise(px, W, H, 0xd4b57e, rng, 0.16, 0.14, 6);
      // ripples
      for (let y = 0; y < H; y++) {
        const k = 1 + Math.sin(y * 0.35 + wob[y * W] * 8) * 0.035;
        for (let x = 0; x < W; x++) for (let ch = 0; ch < 3; ch++) px[(y * W + x) * 4 + ch] *= k;
      }
      band(px, W, H, 0.2, 0.36, 0.05, 0.88, 0xb0925e, 0.3, wob);
      band(px, W, H, 0.64, 0.8, 0.05, 0.88, 0xb0925e, 0.3, wob);
    },
  },
  cobbles: {
    base: 0x6f6b66,
    tile: 4,
    rough: 0.75,
    shoulder: 0x6a6258,
    paint(px, W, H, rng) {
      fillNoise(px, W, H, 0x3c3a37, rng, 0.2, 0.1, 4);
      const rows = 16, cols = 14;
      const ch = H / rows, cw = W / cols;
      for (let r = 0; r < rows; r++) {
        const off = (r % 2) * cw * 0.5;
        for (let c = -1; c <= cols; c++) {
          const cx = c * cw + off + cw / 2, cy = r * ch + ch / 2;
          const tone = 0.75 + rng.next() * 0.5;
          const base = rgb(0x77726b);
          for (let y = Math.floor(cy - ch / 2); y < cy + ch / 2; y++) {
            for (let x = Math.floor(cx - cw / 2); x < cx + cw / 2; x++) {
              if (x < 0 || x >= W) continue;
              const dx = (x - cx) / (cw * 0.46), dy = (y - cy) / (ch * 0.44);
              const d = dx * dx + dy * dy;
              if (d > 1) continue;
              const yy = ((y % H) + H) % H;
              const i = (yy * W + x) * 4;
              const sh = (1 - d * 0.5) * tone * (1 - (dx + dy) * 0.12);
              px[i] = base[0] * sh;
              px[i + 1] = base[1] * sh;
              px[i + 2] = base[2] * sh;
            }
          }
        }
      }
    },
  },
};

/** Road ribbon look for a surface (texture cached). */
export function roadLook(surface: SurfaceId): RoadLook {
  const look = paintedOf(surface);
  const p = ROAD_PAINTERS[look] ?? ROAD_PAINTERS.tarmac;
  const map = cached(`road:${look}`, () => {
    const W = 256, H = 512;
    const c = makeCanvas(W, H);
    if (!c) return null;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    p.paint(img.data, W, H, new Rng(1234 + look.length * 77));
    ctx.putImageData(img, 0, 0);
    const t = finishTexture(c, true, true, false);
    return t;
  });
  return {
    map,
    tileLength: p.tile,
    roughness: p.rough,
    metalness: 0,
    color: p.base,
    shoulder: p.shoulder,
  };
}

/** Soft verge noise (grayscale, sRGB); multiplied with the shoulder vertex colour. */
export function shoulderTexture(): THREE.Texture | null {
  return cached('shoulder', () => {
    const S = 256;
    const c = makeCanvas(S, S);
    if (!c) return null;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(S, S);
    const rng = new Rng(55);
    const n = fbm(S, S, 8, 4, rng);
    for (let i = 0; i < S * S; i++) {
      const v = 200 + (n[i] - 0.5) * 90 + (rng.next() - 0.5) * 60;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return finishTexture(c, true, true);
  });
}

// ------------------------------------------------------------------------------------------- wheels

/** Wheel rim face: coloured spokes on a dark disc, tyre sidewall ring. */
export function rimTexture(color: number): THREE.Texture | null {
  return cached(`rim:${color}`, () => {
    const S = 128;
    const c = makeCanvas(S, S);
    if (!c) return null;
    const ctx = c.getContext('2d')!;
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    ctx.fillStyle = '#151515';
    ctx.fillRect(0, 0, S, S);
    const cx = S / 2;
    // tyre sidewall ring
    ctx.fillStyle = '#1d1d1d';
    ctx.beginPath();
    ctx.arc(cx, cx, S * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cx, S * 0.43, 0, Math.PI * 2);
    ctx.stroke();
    // rim
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    ctx.arc(cx, cx, S * 0.33, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = hex;
    ctx.beginPath();
    ctx.arc(cx, cx, S * 0.31, 0, Math.PI * 2);
    ctx.arc(cx, cx, S * 0.26, 0, Math.PI * 2, true);
    ctx.fill();
    // six spokes
    ctx.save();
    ctx.translate(cx, cx);
    for (let k = 0; k < 6; k++) {
      ctx.rotate(Math.PI / 3);
      ctx.fillStyle = hex;
      ctx.beginPath();
      ctx.moveTo(-S * 0.035, 0);
      ctx.lineTo(S * 0.035, 0);
      ctx.lineTo(S * 0.05, S * 0.28);
      ctx.lineTo(-S * 0.05, S * 0.28);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // hub
    ctx.fillStyle = '#444';
    ctx.beginPath();
    ctx.arc(cx, cx, S * 0.06, 0, Math.PI * 2);
    ctx.fill();
    return finishTexture(c, true, false);
  });
}

// ------------------------------------------------------------------------------------------- text boards

export interface TextBoardOptions {
  bg: number;
  fg: number;
  /** Optional chequer border colour. */
  chequer?: number;
  font?: string;
  w?: number;
  h?: number;
}

/** A banner / board with centred text (sRGB). */
export function textTexture(text: string, o: TextBoardOptions): THREE.Texture | null {
  const key = `text:${text}:${o.bg}:${o.fg}:${o.chequer ?? -1}:${o.w ?? 1024}x${o.h ?? 160}`;
  return cached(key, () => {
    const W = o.w ?? 1024, H = o.h ?? 160;
    const c = makeCanvas(W, H);
    if (!c) return null;
    const ctx = c.getContext('2d')!;
    const hex = (v: number) => `#${v.toString(16).padStart(6, '0')}`;
    ctx.fillStyle = hex(o.bg);
    ctx.fillRect(0, 0, W, H);
    if (o.chequer !== undefined) {
      const sq = H / 8;
      for (let x = 0; x < W / sq; x++)
        for (let y = 0; y < 2; y++) {
          ctx.fillStyle = (x + y) % 2 === 0 ? hex(o.chequer) : hex(o.bg);
          ctx.fillRect(x * sq, y * sq, sq, sq);
          ctx.fillRect(x * sq, H - (2 - y) * sq, sq, sq);
        }
    }
    ctx.fillStyle = hex(o.fg);
    ctx.font = o.font ?? `900 ${Math.round(H * 0.5)}px "Arial Black", Impact, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H / 2 + H * 0.02, W * 0.94);
    return finishTexture(c, true, false);
  });
}

/** Disposes all cached textures (renderer.dispose()). */
export function disposeTextureCache(): void {
  for (const t of cache.values()) t?.dispose();
  cache.clear();
}
