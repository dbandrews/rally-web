/**
 * Ghost file format (src/game/ghosts/format.ts) against the shipped team ghosts and the exe-proven reference
 * (fmt_ghost.py = FUN_004dccb0 / FUN_004dc7b0 under unicorn; research/tools/ghost_ts_ref.py writes the reference).
 * The full 30 files run when .cache/original is present; the 3 committed fixtures run everywhere (CI).
 */
import { describe, expect, it } from 'vitest';
import {
  GHOST_FRAME_BYTES,
  GhostFormatError,
  decodeFrame,
  encodeFrame,
  fileTimeBytes,
  fileTimeToMs,
  ghostCarOf,
  ghostTotalTime,
  isHoldFrame,
  keyStates,
  parseGhost,
  writeGhost,
  type GhostFile,
} from '../../../src/game/ghosts/format';
import { FIX, TEAM_DIR, bytesEqual, exists, f32at, listDir, readBytes, readJson, sha256 } from './nodefs';

interface Ref {
  rawSha256: string;
  frameCount: number;
  states: number;
  carTemplate: string;
  ghostName: string;
  splits: number[];
  initial: number[];
  first: number[];
  last: number[];
  statesSha256: string;
}
const REF = readJson<{ frames: number; files: Record<string, Ref> }>(`${FIX}/teamghosts.ref.json`);

const haveTeam = exists(TEAM_DIR);
const ciFiles = listDir(FIX).filter((n) => /^[A-Za-z]+_[A-Za-z]+\d[abc]?[fr]$/.test(n));
const files: Array<[string, string]> = haveTeam ? listDir(TEAM_DIR).map((n) => [n, `${TEAM_DIR}/${n}`]) : ciFiles.map((n) => [n, `${FIX}/${n}`]);

describe('ghost codec vs the executed exe (FUN_004dccb0 under unicorn, control word 0x7f)', () => {
  it('covers the expected files', () => {
    expect(files.length).toBe(haveTeam ? 30 : 3);
    expect(REF.frames).toBe(39710);
  });

  let frames = 0;
  for (const [name, path] of files) {
    it(`${name}: parse + every decoded frame + re-encode`, async () => {
      const raw = readBytes(path);
      const ref = REF.files[name];
      expect(ref, name).toBeTruthy();
      expect(await sha256(raw)).toBe(ref.rawSha256);
      const g = parseGhost(raw);
      expect(g.version).toBe('2.0');
      expect(g.frameCount).toBe(ref.frameCount);
      expect(g.carTemplate).toBe(ref.carTemplate);
      expect(g.ghostName).toBe(ref.ghostName);
      expect(g.splits).toEqual(ref.splits.map(Math.fround));
      expect(Array.from(g.initial)).toEqual(ref.initial.map(Math.fround));
      expect(g.trailer.length).toBe(20);
      expect(ghostTotalTime(g)).toBe(Math.fround(ref.splits[ref.splits.length - 1]));
      // every decoded state, bit-exact (sha256 over all float32 states)
      const st = keyStates(g);
      expect(st.length).toBe(ref.states);
      expect(Array.from(st[1])).toEqual(ref.first.map(Math.fround));
      expect(Array.from(st[st.length - 1])).toEqual(ref.last.map(Math.fround));
      expect(await sha256(st)).toBe(ref.statesSha256);
      // encode(decode(frame)) cannot reproduce a frame byte for byte (the decoded state is an absolute float32 that has
      // lost the sub-ulp bits of the recorder's input; the exe's own encoder behaves identically, see the codec cases):
      // it lands within one quantum of every component, with the same FINE flags (25 of 39 710 frames flip one flag)
      const out = new Uint8Array(GHOST_FRAME_BYTES);
      let prev: Float32Array = g.initial;
      let far = 0;
      for (let i = 0; i < g.frameCount; i++) {
        const off = i * GHOST_FRAME_BYTES;
        expect(isHoldFrame(g.frames, off)).toBe(false);
        const next = st[i + 1];
        encodeFrame(prev, next, out, 0);
        const dv = new DataView(out.buffer);
        const dr = new DataView(g.frames.buffer, g.frames.byteOffset + off);
        for (let k = 0; k < 9; k++) if (Math.abs(dv.getInt16(1 + 2 * k, true) - dr.getInt16(1 + 2 * k, true)) > 1) far++;
        prev = next;
      }
      expect(far).toBe(0);
      // write(parse(x)) is the file itself (trailer included)
      expect(bytesEqual(writeGhost(g), raw)).toBe(true);
      frames += g.frameCount;
    });
  }

  it('frame total', () => {
    if (haveTeam) expect(frames).toBe(39710);
    else expect(frames).toBeGreaterThan(1000);
  });
});

describe('frame encoder vs the exe (FUN_004dc7b0 executed under unicorn, control word 0x7f)', () => {
  it('3030 recorded cases (real decoded pairs + random + edge) are byte-identical', () => {
    const b = readBytes(`${FIX}/codec.cases.bin`);
    const n = b.length / 91;
    expect(n).toBe(3030);
    const out = new Uint8Array(GHOST_FRAME_BYTES);
    let bad = 0;
    let withFlags = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 91;
      const prev = new Float32Array(9);
      const cur = new Float32Array(9);
      for (let k = 0; k < 9; k++) {
        prev[k] = f32at(b, o + 4 * k);
        cur[k] = f32at(b, o + 36 + 4 * k);
      }
      encodeFrame(prev, cur, out, 0);
      for (let k = 0; k < 19; k++) if (out[k] !== b[o + 72 + k]) bad++;
      if (out[0] !== 0) withFlags++;
    }
    expect(bad).toBe(0);
    expect(withFlags).toBeGreaterThan(500); // FINE frames are exercised
  });
});

describe('ghost codec properties', () => {
  const rnd = (() => {
    let s = 12345;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  })();

  it('random frames: decode(encode(prev, cur)) stays within one quantum', () => {
    const prev = new Float32Array([2000, 400, 2500, 0.1, 0.2, 0.3, 0.9, 5, 170]);
    const fr = new Uint8Array(GHOST_FRAME_BYTES);
    const dec = new Float32Array(9);
    for (let n = 0; n < 5000; n++) {
      const cur = Array.from(prev, (v, k) => Math.fround(v + (rnd() - 0.5) * (k < 7 ? 6 : 40) * (rnd() < 0.3 ? 1e-5 : 1)));
      encodeFrame(prev, cur, fr, 0);
      decodeFrame(prev, fr, 0, dec);
      for (let k = 0; k < 7; k++) {
        const fine = fr[0] & (2 << k) ? 1 / 32768 : 1;
        expect(Math.abs(dec[k] - cur[k])).toBeLessThanOrEqual((32 / 32766.5) * fine * 1.0001 + 3e-4);
      }
    }
  });

  it('the spin delta wraps through +-180 (encode and decode)', () => {
    const prev = new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 179]);
    const cur = new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, -177]);
    const fr = new Uint8Array(GHOST_FRAME_BYTES);
    encodeFrame(prev, cur, fr, 0);
    const dec = new Float32Array(9);
    decodeFrame(prev, fr, 0, dec);
    expect(dec[8]).toBeCloseTo(-177, 1);
  });

  it('position deltas clamp at one range per period (32 m)', () => {
    const prev = new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 0]);
    const cur = new Float32Array([1000, 0, 0, 0, 0, 0, 1, 0, 0]);
    const fr = new Uint8Array(GHOST_FRAME_BYTES);
    encodeFrame(prev, cur, fr, 0);
    const dec = new Float32Array(9);
    decodeFrame(prev, fr, 0, dec);
    expect(dec[0]).toBeCloseTo(32 * (32766 / 32766.5), 3);
  });
});

describe('ghost file layouts', () => {
  const base = (): GhostFile => ({
    version: '3.0',
    carTemplate: 'Peugeot206Ghost',
    ghostName: 'Zoë Test',
    profileTemplate: 'Profile',
    profileName: 'Ünï',
    date: fileTimeBytes(Date.UTC(2026, 9, 30, 12, 0, 0)),
    splits: [Math.fround(12.345), Math.fround(30.5)],
    initial: new Float32Array([1, 2, 3, 0, 0, 0, 1, 0.5, -10]),
    frames: new Uint8Array(GHOST_FRAME_BYTES * 3).map((_, i) => (i * 37) & 255),
    frameCount: 3,
    trailer: new Uint8Array(0),
  });

  it('3.0 round trip keeps every field (name pair, date, splits, initial, frames)', () => {
    const g = base();
    g.frames[0] = 0; // not a hold frame (bit 0)
    const g2 = parseGhost(writeGhost(g));
    expect(g2.version).toBe('3.0');
    expect(g2.carTemplate).toBe('Peugeot206Ghost');
    expect(ghostCarOf(g2.carTemplate)).toBe('Peugeot206');
    expect(g2.ghostName).toBe('Zoë Test');
    expect(g2.profileName).toBe('Ünï');
    expect(g2.profileTemplate).toBe('Profile');
    expect(fileTimeToMs(g2.date)).toBe(Date.UTC(2026, 9, 30, 12, 0, 0));
    expect(g2.splits).toEqual(g.splits);
    expect(Array.from(g2.initial)).toEqual(Array.from(g.initial));
    expect(bytesEqual(g2.frames, g.frames)).toBe(true);
    expect(g2.trailer.length).toBe(0);
    expect(writeGhost(g2)).toEqual(writeGhost(g));
  });

  it('3.0 header layout is the loader order: version, count, str, wstr, str, wstr, date, splits, initial, frames', () => {
    const g = base();
    g.carTemplate = 'AB';
    g.ghostName = 'C';
    g.profileTemplate = 'D';
    g.profileName = 'E';
    g.splits = [1];
    g.frameCount = 0;
    g.frames = new Uint8Array(0);
    const b = writeGhost(g);
    const dv = new DataView(b.buffer);
    expect(String.fromCharCode(b[0], b[1], b[2], b[3])).toBe('3.0\0');
    expect(dv.getUint32(4, true)).toBe(0);
    expect(dv.getUint32(8, true)).toBe(2);
    expect(String.fromCharCode(b[12], b[13])).toBe('AB');
    expect(dv.getUint32(14, true)).toBe(1);
    expect(b[18] | (b[19] << 8)).toBe(67);
    expect(dv.getUint32(20, true)).toBe(1); // second str
    expect(b[24]).toBe(68);
    expect(dv.getUint32(25, true)).toBe(1); // second wstr
    expect(b[29] | (b[30] << 8)).toBe(69);
    // 8 date bytes at 31..38, then nSplits
    expect(dv.getUint32(39, true)).toBe(1);
    expect(dv.getFloat32(43, true)).toBe(1);
    expect(b.length).toBe(47 + 36);
  });

  it('refuses what the loader refuses', () => {
    const g = base();
    g.frames[0] = 0;
    const ok = writeGhost(g);
    const bad = new Uint8Array(ok);
    bad[0] = 0x39; // "93.0"
    expect(() => parseGhost(bad)).toThrow(GhostFormatError);
    expect(() => parseGhost(ok.subarray(0, ok.length - 5))).toThrow(GhostFormatError);
    expect(() => parseGhost(new Uint8Array(0))).toThrow(GhostFormatError);
    expect(() => parseGhost(new Uint8Array([0x32, 0x2e, 0x30, 0, 255, 255, 255, 255]))).toThrow(GhostFormatError);
  });
});
