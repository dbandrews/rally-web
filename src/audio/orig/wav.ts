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
  const data: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < channels; c++) data.push(new Float32Array(new ArrayBuffer(frames * 4)));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) data[c][i] = dv.getInt16(dataOff + (i * channels + c) * 2, true) / 32768;
  }
  return { rate, channels, frames, data };
}
