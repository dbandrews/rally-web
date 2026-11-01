/**
 * src/audio/orig/wav.ts — OWNED BY THE AUDIO BUILDER.
 *
 * Minimal RIFF/WAVE PCM16 reader for the bank's sample files. The runtime decodes the WAV itself (instead of
 * decodeAudioData, which resamples to the context rate) so an AudioBuffer holds exactly the original frames at
 * the file's native rate: loops stay sample-exact (sound.md §12: the original loops the whole buffer, seam
 * click included) and the playback rate is pitch × native rate, as DirectSound's SetFrequency (0x6b52a0).
 */

export interface PcmData {
  rate: number;
  channels: number;
  frames: number;
  /** One Float32Array per channel, samples / 32768. */
  data: Float32Array<ArrayBuffer>[];
}

/** Parse a PCM16 WAV (any chunk order; extra chunks skipped). Throws on anything else. */
export function parseWav(buf: ArrayBuffer): PcmData {
  const dv = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let o = 12;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let fmtTag = 0;
  let dataOff = -1;
  let dataLen = 0;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o);
    const n = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmtTag = dv.getUint16(o + 8, true);
      channels = dv.getUint16(o + 10, true);
      rate = dv.getUint32(o + 12, true);
      bits = dv.getUint16(o + 22, true);
    } else if (id === 'data') {
      dataOff = o + 8;
      dataLen = Math.min(n, buf.byteLength - dataOff);
    }
    o += 8 + n + (n & 1);
  }
  if (fmtTag !== 1 || bits !== 16 || channels < 1 || rate <= 0 || dataOff < 0) {
    throw new Error(`unsupported WAV (format ${fmtTag}, ${bits} bit, ${channels} ch)`);
  }
  const frames = Math.floor(dataLen / (2 * channels));
  return { rate, channels, frames, data: readPcm16(buf, dataOff, frames, channels) };
}

/** 1 / 32768 (a power of two: pcm * INV equals pcm / 32768 exactly). */
const INV = 1 / 32768;
/** Typed arrays read in the platform byte order; PCM16 WAV is little-endian. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** De-interleave `frames` PCM16 LE frames at `off` into one Float32Array per channel (sample / 32768, exact). An Int16Array
 *  view needs a 2-byte aligned offset (and a little-endian host); otherwise the bytes are copied (or read per sample). */
export function readPcm16(buf: ArrayBuffer, off: number, frames: number, channels: number): Float32Array<ArrayBuffer>[] {
  const data: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < channels; c++) data.push(new Float32Array(new ArrayBuffer(frames * 4)));
  const n = frames * channels;
  if (!LITTLE_ENDIAN) {
    const dv = new DataView(buf);
    for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) data[c][i] = dv.getInt16(off + (i * channels + c) * 2, true) / 32768;
    return data;
  }
  const pcm = off % 2 === 0 ? new Int16Array(buf, off, n) : new Int16Array(buf.slice(off, off + n * 2));
  if (channels === 1) {
    const d = data[0];
    for (let i = 0; i < n; i++) d[i] = pcm[i] * INV;
  } else {
    for (let c = 0; c < channels; c++) {
      const d = data[c];
      for (let i = 0, j = c; i < frames; i++, j += channels) d[i] = pcm[j] * INV;
    }
  }
  return data;
}
