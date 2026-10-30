// .rtex container: encode/parse round trips, validation, and real pipeline outputs vs the Python decode.
import { describe, expect, it } from 'vitest';
import { RTEX_FLAG, RTEX_FORMAT, encodeRtex, parseRtex, rtexLevelDims, rtexLevelRGBA, rtexLevelSize, type RtexFormat } from '../../src/render/orig/rtex';
import fixture from './fixtures/rtex.json';

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function levelsFor(format: RtexFormat, w: number, h: number, d: number, n: number, seed = 7): Uint8Array[] {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) >>> 24);
  return Array.from({ length: n }, (_, i) => {
    const [lw, lh, ld] = rtexLevelDims(w, h, d, i);
    return Uint8Array.from({ length: rtexLevelSize(format, lw, lh, ld) }, rnd);
  });
}

const palette = Uint8Array.from({ length: 1024 }, (_, i) => (i % 4 === 3 ? 255 : (i * 37) & 255));

describe('rtex container', () => {
  const cases: [string, RtexFormat, number, number, number, number][] = [
    ['DXT1 64x32, 7 levels to 1x1', RTEX_FORMAT.DXT1, 64, 32, 1, 7],
    ['DXT3 256x64 short chain (stops at 4)', RTEX_FORMAT.DXT3, 256, 64, 1, 5],
    ['DXT5 8x8, 4 levels', RTEX_FORMAT.DXT5, 8, 8, 1, 4],
    ['RGBA8 16x16', RTEX_FORMAT.RGBA8, 16, 16, 1, 5],
    ['RGB8 5x3 (unaligned rows)', RTEX_FORMAT.RGB8, 5, 3, 1, 3],
    ['L8 7x2', RTEX_FORMAT.L8, 7, 2, 1, 3],
    ['P8 16x8', RTEX_FORMAT.P8, 16, 8, 1, 5],
    ['RGBA8 volume 8x8x4, 4 levels', RTEX_FORMAT.RGBA8, 8, 8, 4, 4],
  ];

  it.each(cases)('round trip %s', (_n, format, w, h, d, n) => {
    const levels = levelsFor(format, w, h, d, n);
    const enc = encodeRtex({ format, flags: RTEX_FLAG.GENERATED_MIPS, width: w, height: h, depth: d, levels, palette: format === RTEX_FORMAT.P8 ? palette : null, source: 2, sourceKind: 2 });
    const img = parseRtex(enc.slice().buffer as ArrayBuffer);
    expect([img.format, img.width, img.height, img.depth, img.levels.length]).toEqual([format, w, h, d, n]);
    expect(!!(img.flags & RTEX_FLAG.VOLUME)).toBe(d > 1);
    expect(!!(img.flags & RTEX_FLAG.PALETTE)).toBe(format === RTEX_FORMAT.P8);
    img.levels.forEach((L, i) => {
      expect([L.width, L.height, L.depth]).toEqual(rtexLevelDims(w, h, d, i));
      expect(Array.from(L.data)).toEqual(Array.from(levels[i]));
      expect(L.data.byteOffset % 4).toBe(0);
      expect(rtexLevelRGBA(img, i).length).toBe(L.width * L.height * L.depth * 4);
    });
  });

  it('level sizes follow the D3D chain rule (DXT levels < 4 px are one block)', () => {
    expect(rtexLevelSize(RTEX_FORMAT.DXT1, 2, 2)).toBe(8);
    expect(rtexLevelSize(RTEX_FORMAT.DXT1, 1, 8)).toBe(16);
    expect(rtexLevelSize(RTEX_FORMAT.DXT5, 8, 1)).toBe(32);
    expect(rtexLevelSize(RTEX_FORMAT.RGB8, 5, 3)).toBe(45);
    expect(rtexLevelSize(RTEX_FORMAT.RGBA8, 4, 4, 2)).toBe(128);
    expect(rtexLevelDims(256, 2048, 1, 8)).toEqual([1, 8, 1]);
  });

  it('expands RGB8 / L8 / P8 to RGBA8 like D3D samples them', () => {
    const rgb = parseRtex(encodeRtex({ format: RTEX_FORMAT.RGB8, flags: 0, width: 1, height: 1, depth: 1, levels: [Uint8Array.of(1, 2, 3)], palette: null, source: 1, sourceKind: 1 }));
    expect(Array.from(rtexLevelRGBA(rgb, 0))).toEqual([1, 2, 3, 255]);
    const l8 = parseRtex(encodeRtex({ format: RTEX_FORMAT.L8, flags: 0, width: 2, height: 1, depth: 1, levels: [Uint8Array.of(9, 200)], palette: null, source: 9, sourceKind: 2 }));
    expect(Array.from(rtexLevelRGBA(l8, 0))).toEqual([9, 9, 9, 255, 200, 200, 200, 255]);
    const p8 = parseRtex(encodeRtex({ format: RTEX_FORMAT.P8, flags: 0, width: 2, height: 1, depth: 1, levels: [Uint8Array.of(0, 3)], palette, source: 10, sourceKind: 2 }));
    expect(Array.from(rtexLevelRGBA(p8, 0))).toEqual([...palette.subarray(0, 4), ...palette.subarray(12, 16)]);
  });

  it('rejects malformed files', () => {
    const good = encodeRtex({ format: RTEX_FORMAT.DXT1, flags: 0, width: 4, height: 4, depth: 1, levels: [new Uint8Array(8)], palette: null, source: 12, sourceKind: 1 });
    expect(() => parseRtex(good.subarray(0, 20))).toThrow();
    const badMagic = good.slice();
    badMagic[0] = 0;
    expect(() => parseRtex(badMagic)).toThrow(/magic/);
    const badVersion = good.slice();
    badVersion[4] = 9;
    expect(() => parseRtex(badVersion)).toThrow(/version/);
    const badSize = good.slice();
    new DataView(badSize.buffer).setUint32(36, 9, true);
    expect(() => parseRtex(badSize)).toThrow(/level 0/);
    expect(() => parseRtex(good.subarray(0, good.length - 4))).toThrow();
  });

  describe('real pipeline outputs (tools/assets/build.py) decode like the Python reference', () => {
    it.each(fixture.files.map((f) => [f.name, f] as const))('%s', (_n, f) => {
      const img = parseRtex(bytes(f.rtex));
      expect(img.levels.length).toBe(f.levels.length);
      f.levels.forEach((want, i) => {
        const got = rtexLevelRGBA(img, i);
        const exp = bytes(want);
        expect(got.length).toBe(exp.length);
        let diff = 0;
        for (let k = 0; k < exp.length; k++) if (got[k] !== exp[k]) diff++;
        expect(diff).toBe(0);
      });
    });
  });
});
