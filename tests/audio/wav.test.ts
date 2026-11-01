// parseWav (src/audio/orig/wav.ts): the Int16Array fast path must produce exactly the Float32 values of the original
// per-sample DataView.getInt16 loop, on random and edge-case data (stereo, odd data length, extra chunks, empty data).
import { describe, expect, it } from 'vitest';
import { parseWav, readPcm16 } from '../../src/audio/orig/wav';

/** The pre-optimisation decode loop (kept here as the reference). */
function reference(buf: ArrayBuffer, off: number, frames: number, channels: number): Float32Array[] {
  const dv = new DataView(buf);
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) data[c][i] = dv.getInt16(off + (i * channels + c) * 2, true) / 32768;
  return data;
}

/** xorshift: deterministic random bytes. */
function bytes(n: number, seed = 0x9e3779b9): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

function wav(pcm: Uint8Array, o: { channels?: number; rate?: number; bits?: number; pre?: Uint8Array; fmtTag?: number } = {}): ArrayBuffer {
  const channels = o.channels ?? 1;
  const rate = o.rate ?? 22050;
  const bits = o.bits ?? 16;
  const pre = o.pre; // an extra chunk (odd length gets a pad byte) before `data`
  const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  const tag = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const parts: ArrayLike<number>[] = [
    tag('fmt '), u32(16), u16(o.fmtTag ?? 1), u16(channels), u32(rate), u32((rate * channels * bits) / 8), u16((channels * bits) / 8), u16(bits),
  ];
  if (pre) parts.push(tag('junk'), u32(pre.length), pre, pre.length & 1 ? [0] : []);
  parts.push(tag('data'), u32(pcm.length), pcm, pcm.length & 1 ? [0] : []);
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + size);
  out.set([...tag('RIFF'), ...u32(4 + size), ...tag('WAVE')], 0);
  let at = 12;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

describe('parseWav fast path', () => {
  it('matches the DataView loop on random mono / stereo / 3-channel data', () => {
    for (const channels of [1, 2, 3]) {
      for (const frames of [1, 2, 7, 1000, 4097]) {
        const pcm = bytes(frames * channels * 2, frames * 31 + channels);
        const r = parseWav(wav(pcm, { channels }));
        expect(r.channels).toBe(channels);
        expect(r.frames).toBe(frames);
        const ref = reference(pcm.buffer.slice(0) as ArrayBuffer, 0, frames, channels);
        for (let c = 0; c < channels; c++) expect(Array.from(r.data[c])).toEqual(Array.from(ref[c]));
      }
    }
  });

  it('covers every int16 value exactly (incl. -32768 and 32767)', () => {
    const pcm = new Uint8Array(65536 * 2);
    const dv = new DataView(pcm.buffer);
    for (let i = 0; i < 65536; i++) dv.setInt16(i * 2, i - 32768, true);
    const r = parseWav(wav(pcm));
    const ref = reference(pcm.buffer, 0, 65536, 1);
    expect(r.data[0][0]).toBe(-1);
    expect(r.data[0][65535]).toBe(32767 / 32768);
    for (let i = 0; i < 65536; i++) expect(r.data[0][i]).toBe(ref[0][i]);
  });

  it('truncates an odd data length / partial last frame like the original', () => {
    const odd = bytes(21, 5); // 10 mono frames + 1 stray byte
    const r = parseWav(wav(odd));
    expect(r.frames).toBe(10);
    expect(Array.from(r.data[0])).toEqual(Array.from(reference(odd.buffer.slice(0) as ArrayBuffer, 0, 10, 1)[0]));
    const st = bytes(30, 6); // 7 stereo frames (28 bytes) + 2 stray bytes
    const s = parseWav(wav(st, { channels: 2 }));
    expect(s.frames).toBe(7);
    const ref = reference(st.buffer.slice(0) as ArrayBuffer, 0, 7, 2);
    expect(Array.from(s.data[0])).toEqual(Array.from(ref[0]));
    expect(Array.from(s.data[1])).toEqual(Array.from(ref[1]));
  });

  it('skips an extra (odd-sized, padded) chunk before the data', () => {
    const pcm = bytes(64, 9);
    const r = parseWav(wav(pcm, { pre: bytes(13, 2) }));
    expect(Array.from(r.data[0])).toEqual(Array.from(reference(pcm.buffer.slice(0) as ArrayBuffer, 0, 32, 1)[0]));
  });

  it('handles a data chunk that claims more than the file holds, and empty data', () => {
    const pcm = bytes(40, 3);
    const buf = wav(pcm);
    const cut = buf.slice(0, buf.byteLength - 10); // the file ends inside the data chunk
    const r = parseWav(cut);
    expect(r.frames).toBe(15);
    expect(Array.from(r.data[0])).toEqual(Array.from(reference(pcm.buffer.slice(0) as ArrayBuffer, 0, 15, 1)[0]));
    const e = parseWav(wav(new Uint8Array(0)));
    expect(e.frames).toBe(0);
    expect(e.data[0].length).toBe(0);
  });

  it('rejects what it did before (8-bit, float, not RIFF)', () => {
    expect(() => parseWav(wav(bytes(16), { bits: 8 }))).toThrow(/unsupported WAV/);
    expect(() => parseWav(wav(bytes(16), { fmtTag: 3 }))).toThrow(/unsupported WAV/);
    expect(() => parseWav(new ArrayBuffer(8))).toThrow(/RIFF/);
  });

  it('reads an unaligned offset through the copy path with the same values', () => {
    const raw = bytes(101, 77);
    for (const off of [0, 1, 3]) {
      const frames = 20;
      const buf = raw.buffer.slice(0) as ArrayBuffer;
      const got = readPcm16(buf, off, frames, 2);
      const ref = reference(buf, off, frames, 2);
      expect(Array.from(got[0])).toEqual(Array.from(ref[0]));
      expect(Array.from(got[1])).toEqual(Array.from(ref[1]));
    }
  });
});
