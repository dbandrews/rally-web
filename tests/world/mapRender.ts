/**
 * tests/world/mapRender.ts — headless top-down stage maps for inspecting generated stages (no browser).
 * Pure functions: renderStageMap() → RGB pixels, encodePng() → PNG bytes (stored deflate, no deps).
 * Used by tests/world/maps.test.ts (opt-in: WORLD_MAPS=1 npx vitest run tests/world/maps.test.ts).
 *
 * Legend: terrain coloured by material (SURFACE_INFO) with hill shading and 5 m contours; road edges dark,
 * centre line white; green = start, red = finish, yellow = checkpoints, cyan = pacenote triggers;
 * scenery dots (dark green trees, grey rocks, red spectators, black tyre stacks, white snowbanks, ...).
 */
import { SURFACE_IDS, SURFACE_INFO } from '../../src/core/constants';
import type { BuiltStage, SceneryKind } from '../../src/core/types';

export interface MapImage {
  w: number;
  h: number;
  rgb: Uint8Array;
  metresPerPixel: number;
}

const KIND_RGB: Partial<Record<SceneryKind, [number, number, number]>> = {
  pine: [20, 60, 25], tree: [40, 90, 30], deadTree: [90, 70, 50], bush: [70, 110, 50], rock: [120, 120, 120],
  boulder: [100, 100, 100], cactus: [60, 120, 40], spectator: [255, 0, 0], house: [160, 60, 40], barn: [140, 40, 30],
  tyreStack: [20, 20, 20], snowbank: [255, 255, 255], marker: [255, 140, 0], post: [255, 255, 0], sign: [255, 0, 255],
  cone: [255, 120, 0], tent: [0, 200, 255], grandstand: [0, 0, 160], fence: [200, 200, 160], barrier: [220, 220, 220],
  pole: [0, 0, 0], hayBale: [230, 200, 90], banner: [255, 0, 128],
};

/** Render a map of the whole heightfield, or a square of half-size `r` around (x, z) / around spline s. */
export function renderStageMap(b: BuiltStage, opts: { width?: number; focus?: { x?: number; z?: number; s?: number; r: number } } = {}): MapImage {
  const { stage, world } = b;
  const hf = stage.heightfield;
  let x0 = hf.originX, z0 = hf.originZ;
  let x1 = hf.originX + (hf.nx - 1) * hf.cellSize, z1 = hf.originZ + (hf.nz - 1) * hf.cellSize;
  const f = opts.focus;
  if (f) {
    const c = f.s !== undefined ? stage.pointAt(f.s) : { x: f.x ?? 0, z: f.z ?? 0 };
    x0 = c.x - f.r; x1 = c.x + f.r; z0 = c.z - f.r; z1 = c.z + f.r;
  }
  const W = opts.width ?? 1000;
  const H = Math.max(1, Math.round((W * (z1 - z0)) / (x1 - x0)));
  const mpp = (x1 - x0) / W;
  const rgb = new Uint8Array(W * H * 3);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = x0 + (i + 0.5) * mpp;
      const z = z0 + (j + 0.5) * mpp;
      const m = world.materialAt(x, -z);
      const n = world.normalAt(x, -z); // sim normal; three z = -sim z
      const h = world.heightAt(x, -z);
      let sh = 0.55 + 0.6 * (-0.5 * n.x + 0.7 * n.y + 0.5 * n.z);
      sh = Math.max(0.25, Math.min(1.3, sh));
      const contour = Math.abs((((h % 5) + 5) % 5)) < 0.3 * mpp ? 0.85 : 1;
      const col = m < SURFACE_IDS.length ? SURFACE_INFO[SURFACE_IDS[m]].color : 0xff00ff;
      const o = (j * W + i) * 3;
      rgb[o] = Math.min(255, ((col >> 16) & 255) * sh * contour);
      rgb[o + 1] = Math.min(255, ((col >> 8) & 255) * sh * contour);
      rgb[o + 2] = Math.min(255, (col & 255) * sh * contour);
    }
  }
  const dot = (x: number, z: number, r: number, c: [number, number, number]): void => {
    const ci = (x - x0) / mpp;
    const cj = (z - z0) / mpp;
    const rr = Math.max(0.6, r / mpp);
    for (let j = Math.floor(cj - rr); j <= cj + rr; j++)
      for (let i = Math.floor(ci - rr); i <= ci + rr; i++) {
        if (i < 0 || j < 0 || i >= W || j >= H || (i - ci) ** 2 + (j - cj) ** 2 > rr * rr) continue;
        const o = (j * W + i) * 3;
        rgb[o] = c[0];
        rgb[o + 1] = c[1];
        rgb[o + 2] = c[2];
      }
  };
  for (const sc of stage.scenery) dot(sc.pos.x, sc.pos.z, Math.max(sc.radius, 0.5), KIND_RGB[sc.kind] ?? [255, 0, 255]);
  for (const r of stage.road) {
    dot(r.left.x, r.left.z, 0.3, [30, 30, 30]);
    dot(r.right.x, r.right.z, 0.3, [30, 30, 30]);
  }
  for (let s = 0; s < stage.length; s += Math.max(0.5, mpp)) {
    const p = stage.pointAt(s);
    dot(p.x, p.z, 0.25, [255, 255, 255]);
  }
  const mark = (s: number, r: number, c: [number, number, number]): void => {
    const p = stage.pointAt(s);
    dot(p.x, p.z, r, c);
  };
  for (const n of stage.pacenotes) mark(n.s, 2, [0, 200, 255]);
  for (const c of stage.checkpoints) mark(c, 3, [255, 255, 0]);
  mark(stage.finishS, 4, [255, 0, 0]);
  mark(stage.startS, 4, [0, 255, 0]);
  return { w: W, h: H, rgb, metresPerPixel: mpp };
}

// ------------------------------------------------------------------------------------------- PNG

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal PNG (RGB8) with an uncompressed (stored) zlib stream. */
export function encodePng(img: MapImage): Uint8Array {
  const { w, h, rgb } = img;
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  // zlib: header, stored blocks of <= 65535 bytes, adler32
  const blocks = Math.ceil(raw.length / 65535) || 1;
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0;
  z[o++] = 0x78;
  z[o++] = 0x01;
  for (let bI = 0; bI < blocks; bI++) {
    const start = bI * 65535;
    const len = Math.min(65535, raw.length - start);
    z[o++] = bI === blocks - 1 ? 1 : 0;
    z[o++] = len & 255;
    z[o++] = len >>> 8;
    z[o++] = ~len & 255;
    z[o++] = (~len >>> 8) & 255;
    z.set(raw.subarray(start, start + len), o);
    o += len;
  }
  let a = 1, bb = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % 65521;
    bb = (bb + a) % 65521;
  }
  const ad = ((bb << 16) | a) >>> 0;
  z[o++] = ad >>> 24;
  z[o++] = (ad >>> 16) & 255;
  z[o++] = (ad >>> 8) & 255;
  z[o++] = ad & 255;
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const c = new Uint8Array(12 + data.length);
    const dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    dv.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
    return c;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let q = 0;
  for (const p of parts) {
    out.set(p, q);
    q += p.length;
  }
  return out;
}
