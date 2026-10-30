/**
 * src/render/orig/rtex.ts — the `.rtex` texture container (public/assets/tex/<texId>.rtex). Pure: no
 * three.js / DOM (vitest runs it in node). Mirror of tools/assets/lib/rtex.py; spec in docs/ASSETS.md.
 *
 *   off   type      field
 *   0     char[4]   'RTEX'
 *   4     u16       version (1)
 *   6     u8        format         RTEX_FORMAT
 *   7     u8        flags          RTEX_FLAG
 *   8     u32       width          level 0
 *   12    u32       height
 *   16    u32       depth          1 for 2-D; slices with RTEX_FLAG.VOLUME
 *   20    u32       levels         n ≥ 1 (authored chain; trailing unused DDS levels dropped)
 *   24    u8        source         engine format of the source (12 DXT1, 14 DXT3, 16 DXT5, 2 A8R8G8B8, 1 R8G8B8, 9 L8, 10 P8…)
 *   25    u8        sourceKind     1 DDS, 2 TGA
 *   26    u16       reserved
 *   28    u32       paletteOffset  0 or offset of 256 × RGBA8 (P8)
 *   32    u32[n]    levelOffset    4-aligned, from file start
 *   32+4n u32[n]    levelSize
 *
 * Level i is max(1, w>>i) × max(1, h>>i) × max(1, d>>i), rows top first (upload with flipY = false and use
 * the original D3D UVs unchanged). DXT payloads are the original blocks; RGBA8/RGB8/L8/P8 are plain bytes.
 */
import { decodeDXT, type DxtFormat } from './dxt';

export const RTEX_FORMAT = { DXT1: 1, DXT3: 2, DXT5: 3, RGBA8: 4, RGB8: 5, L8: 6, P8: 7 } as const;
export type RtexFormat = (typeof RTEX_FORMAT)[keyof typeof RTEX_FORMAT];
export const RTEX_FORMAT_NAME: Readonly<Record<RtexFormat, string>> = { 1: 'DXT1', 2: 'DXT3', 3: 'DXT5', 4: 'RGBA8', 5: 'RGB8', 6: 'L8', 7: 'P8' };

export const RTEX_FLAG = {
  /** depth slices: sample as a 3-D texture */
  VOLUME: 1,
  /** palette present (P8) */
  PALETTE: 2,
  /** a DXT1 level uses 3-colour blocks with index 3 = transparent black (alpha-test it like D3D did) */
  PUNCHTHROUGH: 4,
  /** levels ≥ 1 were generated at build time with the engine's floor-mean rule (TGA sources) */
  GENERATED_MIPS: 8,
} as const;

export const RTEX_MAGIC = 0x58455452; // 'RTEX' little-endian
export const RTEX_VERSION = 1;

export interface RtexLevel {
  width: number;
  height: number;
  depth: number;
  /** View into the file buffer (no copy). */
  data: Uint8Array;
}

export interface RtexImage {
  format: RtexFormat;
  flags: number;
  width: number;
  height: number;
  depth: number;
  levels: RtexLevel[];
  /** 256 × RGBA8 for P8, else null. */
  palette: Uint8Array | null;
  source: number;
  sourceKind: number;
}

const BLOCK_BYTES: Partial<Record<RtexFormat, number>> = { 1: 8, 2: 16, 3: 16 };
const TEXEL_BYTES: Partial<Record<RtexFormat, number>> = { 4: 4, 5: 3, 6: 1, 7: 1 };

export function isDxtFormat(f: RtexFormat): f is 1 | 2 | 3 {
  return f === 1 || f === 2 || f === 3;
}

export function dxtName(f: 1 | 2 | 3): DxtFormat {
  return f === 1 ? 'DXT1' : f === 2 ? 'DXT3' : 'DXT5';
}

/** Exact byte size of one level (all slices). */
export function rtexLevelSize(format: RtexFormat, w: number, h: number, d = 1): number {
  const bb = BLOCK_BYTES[format];
  if (bb) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * bb * d;
  return w * h * d * (TEXEL_BYTES[format] as number);
}

export function rtexLevelDims(w: number, h: number, d: number, i: number): [number, number, number] {
  return [Math.max(1, w >> i), Math.max(1, h >> i), Math.max(1, d >> i)];
}

/** Parse an .rtex file. Throws on a malformed file (callers fall back). Level data are views (no copy). */
export function parseRtex(src: ArrayBuffer | Uint8Array): RtexImage {
  const u8 = src instanceof Uint8Array ? src : new Uint8Array(src);
  if (u8.byteLength < 32) throw new Error('rtex: short file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== RTEX_MAGIC) throw new Error('rtex: bad magic');
  const version = dv.getUint16(4, true);
  if (version !== RTEX_VERSION) throw new Error(`rtex: version ${version}`);
  const format = dv.getUint8(6) as RtexFormat;
  if (!(format in RTEX_FORMAT_NAME)) throw new Error(`rtex: format ${format}`);
  const flags = dv.getUint8(7);
  const width = dv.getUint32(8, true), height = dv.getUint32(12, true), depth = dv.getUint32(16, true);
  const n = dv.getUint32(20, true);
  const source = dv.getUint8(24), sourceKind = dv.getUint8(25);
  const palOff = dv.getUint32(28, true);
  if (!(n >= 1 && n <= 16) || 32 + 8 * n > u8.byteLength || width < 1 || height < 1 || depth < 1) throw new Error('rtex: bad header');
  const levels: RtexLevel[] = [];
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(32 + 4 * i, true);
    const size = dv.getUint32(32 + 4 * n + 4 * i, true);
    const [w, h, d] = rtexLevelDims(width, height, depth, i);
    if (size !== rtexLevelSize(format, w, h, d) || off % 4 !== 0 || off + size > u8.byteLength) throw new Error(`rtex: level ${i} out of bounds`);
    levels.push({ width: w, height: h, depth: d, data: u8.subarray(off, off + size) });
  }
  let palette: Uint8Array | null = null;
  if (palOff) {
    if (palOff + 1024 > u8.byteLength) throw new Error('rtex: palette out of bounds');
    palette = u8.subarray(palOff, palOff + 1024);
  }
  if (format === RTEX_FORMAT.P8 && !palette) throw new Error('rtex: P8 without palette');
  return { format, flags, width, height, depth, levels, palette, source, sourceKind };
}

/** Encode (tests and tools; the build writes files with tools/assets/lib/rtex.py). */
export function encodeRtex(img: Omit<RtexImage, 'levels'> & { levels: readonly Uint8Array[] }): Uint8Array {
  const n = img.levels.length;
  const pad = (x: number) => (x + 3) & ~3;
  let pos = 32 + 8 * n;
  const palOff = img.palette ? pos : 0;
  if (img.palette) pos += 1024;
  const offs: number[] = [];
  for (const l of img.levels) {
    offs.push(pos);
    pos += pad(l.length);
  }
  const out = new Uint8Array(pos);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, RTEX_MAGIC, true);
  dv.setUint16(4, RTEX_VERSION, true);
  dv.setUint8(6, img.format);
  dv.setUint8(7, img.flags | (img.palette ? RTEX_FLAG.PALETTE : 0) | (img.depth > 1 ? RTEX_FLAG.VOLUME : 0));
  dv.setUint32(8, img.width, true);
  dv.setUint32(12, img.height, true);
  dv.setUint32(16, img.depth, true);
  dv.setUint32(20, n, true);
  dv.setUint8(24, img.source);
  dv.setUint8(25, img.sourceKind);
  dv.setUint32(28, palOff, true);
  img.levels.forEach((l, i) => {
    dv.setUint32(32 + 4 * i, offs[i], true);
    dv.setUint32(32 + 4 * n + 4 * i, l.length, true);
    out.set(l, offs[i]);
  });
  if (img.palette) out.set(img.palette, palOff);
  return out;
}

/**
 * One level as RGBA8 (all slices, top row first): DXT via the bit-exact JS decoder, RGB8 → alpha 255,
 * L8 → (L, L, L, 255) (D3D L8 sampling), P8 → palette[index] (the index chain was averaged at build time,
 * the palette lookup per level reproduces D3D P8 filtering), RGBA8 as is (a copy). `palette` (256 × RGBA8)
 * replaces a P8 file's own palette (the device's current palette, e.g. the car lightmap LUT); ignored otherwise.
 */
export function rtexLevelRGBA(img: RtexImage, level: number, palette?: Uint8Array | null): Uint8Array {
  const L = img.levels[level];
  const n = L.width * L.height;
  const out = new Uint8Array(n * L.depth * 4);
  const f = img.format;
  if (isDxtFormat(f)) {
    const slice = L.data.length / L.depth;
    for (let z = 0; z < L.depth; z++) {
      decodeDXT(dxtName(f), L.data.subarray(z * slice, (z + 1) * slice), L.width, L.height, out.subarray(z * n * 4, (z + 1) * n * 4));
    }
    return out;
  }
  const s = L.data;
  const m = n * L.depth;
  if (f === RTEX_FORMAT.RGBA8) {
    out.set(s);
  } else if (f === RTEX_FORMAT.RGB8) {
    for (let i = 0; i < m; i++) {
      out[4 * i] = s[3 * i]; out[4 * i + 1] = s[3 * i + 1]; out[4 * i + 2] = s[3 * i + 2]; out[4 * i + 3] = 255;
    }
  } else if (f === RTEX_FORMAT.L8) {
    for (let i = 0; i < m; i++) {
      const g = s[i];
      out[4 * i] = g; out[4 * i + 1] = g; out[4 * i + 2] = g; out[4 * i + 3] = 255;
    }
  } else {
    const p = (palette ?? img.palette) as Uint8Array;
    for (let i = 0; i < m; i++) {
      const k = 4 * s[i];
      out[4 * i] = p[k]; out[4 * i + 1] = p[k + 1]; out[4 * i + 2] = p[k + 2]; out[4 * i + 3] = p[k + 3];
    }
  }
  return out;
}
