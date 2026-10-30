// DirectSound setters (research/formats/sound.md §3.3 / §3.5 + Verification) and the WAV reader.
import { describe, expect, it } from 'vitest';
import { DS_SPEED_OF_SOUND, dopplerFactor, dsGain, dsPlaybackRate } from '../../src/audio/orig/ds';
import { MsvcRand, ParkMiller } from '../../src/audio/orig/rand';
import { parseWav } from '../../src/audio/orig/wav';

describe('volume law (0x6b5210)', () => {
  it('mB = trunc(865.617·ln v) clamped [−10000, 0], gain = 10^(mB/2000) ≈ v^0.99658', () => {
    expect(dsGain(1)).toBe(1);
    expect(dsGain(2)).toBe(1); // v > 1 → 1 (EngineThrottle pipe loops reach 1.2×)
    expect(dsGain(0)).toBe(0);
    expect(dsGain(-1)).toBe(0);
    expect(dsGain(0.5)).toBeCloseTo(Math.pow(10, Math.trunc(865.617 * Math.log(0.5)) / 2000), 15);
    for (const v of [0.9, 0.5, 0.25, 0.1, 0.01]) expect(Math.abs(dsGain(v) - Math.pow(v, 0.99658))).toBeLessThan(2e-3);
    expect(dsGain(1e-9)).toBeCloseTo(1e-5, 10); // −10000 mB floor
  });
});

describe('pitch → frequency (0x6b52a0)', () => {
  it('playback rate = trunc(p · rate) / rate, p ≥ 0.001, DS8 100..200000 Hz', () => {
    expect(dsPlaybackRate(1, 44100)).toBe(1);
    expect(dsPlaybackRate(0.5, 44100)).toBe(0.5);
    expect(dsPlaybackRate(1.2345, 11025)).toBe(Math.trunc(1.2345 * 11025) / 11025);
    expect(dsPlaybackRate(0, 44100)).toBe(100 / 44100); // 0.001 · 44100 = 44 Hz → 100 Hz
    expect(dsPlaybackRate(10, 44100)).toBe(200000 / 44100);
  });
});

describe('DS3D doppler (DopplerFactor 1.4)', () => {
  const at = (x: number, y = 0, z = 0) => ({ x, y, z });
  it('approach raises, recede lowers, dopplerOff (source vel = listener vel) is exactly 1', () => {
    const c = DS_SPEED_OF_SOUND;
    expect(dopplerFactor(at(0), at(20), at(100), at(0))).toBeCloseTo(c / (c - 1.4 * 20), 12);
    expect(dopplerFactor(at(0), at(-20), at(100), at(0))).toBeCloseTo(c / (c + 1.4 * 20), 12);
    expect(dopplerFactor(at(0), at(0), at(100), at(10))).toBeCloseTo((c - 14) / c, 12);
    expect(dopplerFactor(at(0), at(30, 0, 5), at(100), at(30, 0, 5))).toBeCloseTo(1, 12);
    expect(dopplerFactor(at(0), at(20, 0, 0), at(0, 0, 100), at(0))).toBeCloseTo(1, 12); // perpendicular
    expect(dopplerFactor(at(5), at(1), at(5), at(0))).toBe(1);
  });
});

describe('random generators', () => {
  it('MSVC rand(): the CRT LCG sequence for seed 1', () => {
    const r = new MsvcRand(1);
    expect([r.next(), r.next(), r.next(), r.next()]).toEqual([41, 18467, 6334, 26500]);
  });
  it('Park–Miller ×630360016 = two Schrage steps ×24112 ×26143 (FUN_00746a00)', () => {
    const r = new ParkMiller(1);
    const a = r.next();
    expect(a).toBe(Number((630360016n * 1n) % 2147483647n));
    const b = r.next();
    expect(b).toBe(Number((630360016n * BigInt(a)) % 2147483647n));
  });
});

describe('parseWav (PCM16, any chunk order)', () => {
  function wav(ch: number, rate: number, samples: number[], extra = false): ArrayBuffer {
    const data = new Int16Array(samples);
    const chunks: Uint8Array[] = [];
    const head = new DataView(new ArrayBuffer(12));
    const str = (dv: DataView, o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    const fmt = new DataView(new ArrayBuffer(24));
    str(fmt, 0, 'fmt ');
    fmt.setUint32(4, 16, true);
    fmt.setUint16(8, 1, true);
    fmt.setUint16(10, ch, true);
    fmt.setUint32(12, rate, true);
    fmt.setUint32(16, rate * ch * 2, true);
    fmt.setUint16(20, ch * 2, true);
    fmt.setUint16(22, 16, true);
    const dh = new DataView(new ArrayBuffer(8));
    str(dh, 0, 'data');
    dh.setUint32(4, data.byteLength, true);
    if (extra) {
      const x = new DataView(new ArrayBuffer(11 + 1));
      str(x, 0, 'smpl');
      x.setUint32(4, 3, true); // odd size → pad byte
      chunks.push(new Uint8Array(x.buffer));
    }
    chunks.push(new Uint8Array(fmt.buffer), new Uint8Array(dh.buffer), new Uint8Array(data.buffer));
    const total = 12 + chunks.reduce((a, c) => a + c.byteLength, 0);
    str(head, 0, 'RIFF');
    head.setUint32(4, total - 8, true);
    str(head, 8, 'WAVE');
    const out = new Uint8Array(total);
    out.set(new Uint8Array(head.buffer), 0);
    let o = 12;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out.buffer;
  }
  it('decodes exactly the frames (no resampling), stereo de-interleaved', () => {
    const p = parseWav(wav(2, 22050, [0, 16384, -32768, 32767, 1, -1], true));
    expect(p.rate).toBe(22050);
    expect(p.channels).toBe(2);
    expect(p.frames).toBe(3);
    expect([...p.data[0]]).toEqual([0, -1, 1 / 32768]);
    expect([...p.data[1]]).toEqual([0.5, 32767 / 32768, -1 / 32768]);
  });
  it('rejects non-PCM16', () => {
    const b = wav(1, 11025, [1, 2]);
    new DataView(b).setUint16(12 + 8 + 14, 8, true); // bits = 8
    expect(() => parseWav(b)).toThrow();
  });
});
