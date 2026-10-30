// Reference JS S3TC (DXT1/DXT3/DXT5) -> RGBA8 decoder for the browser fallback path
// (no WEBGL_compressed_texture_s3tc).  Bit-exact with research/tools/fmt_textures.py and
// with SwiftShader's hardware path (artifacts/re/textures/s3tc_parity.json):
//   * RGB565 expanded by bit replication; c2/c3 = (2a+b)/3 TRUNCATED; 3-colour mode
//     (c0 <= c1, DXT1 only) -> c2 = (a+b)/2 truncated, index 3 = (0,0,0,0)  [D3D DXT1]
//   * DXT3 alpha = 4-bit * 17;  DXT5 alpha 8-mode ((7-i)a0+i a1)/7, 6-mode /5, then 0,255,
//     all truncated.
//   * Row 0 of the output = first block row of the file (D3D top-left origin): upload with
//     UNPACK_FLIP_Y_WEBGL = false, exactly like the compressed path.
//
// Self-test (node):  OUT=<dir> node fmt_textures_dxt_fallback.mjs <file.dds> [...] | @<listfile>
//   -> writes <OUT>/<index>.rgba for comparison with fmt_textures.decode_dds and prints
//      decode throughput.

export function decodeDXT(fourcc, data, width, height, out = new Uint8Array(width * height * 4)) {
  const bw = Math.max(1, (width + 3) >> 2);
  const bh = Math.max(1, (height + 3) >> 2);
  const bs = fourcc === 'DXT1' ? 8 : 16;
  const col = new Uint8Array(16); // 4 colours x RGBA
  const alp = new Uint8Array(16);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * bs;
      const co = fourcc === 'DXT1' ? o : o + 8;
      const c0 = data[co] | (data[co + 1] << 8);
      const c1 = data[co + 2] | (data[co + 3] << 8);
      const r0 = ((c0 >> 11) & 31), g0 = ((c0 >> 5) & 63), b0 = c0 & 31;
      const r1 = ((c1 >> 11) & 31), g1 = ((c1 >> 5) & 63), b1 = c1 & 31;
      const R0 = (r0 << 3) | (r0 >> 2), G0 = (g0 << 2) | (g0 >> 4), B0 = (b0 << 3) | (b0 >> 2);
      const R1 = (r1 << 3) | (r1 >> 2), G1 = (g1 << 2) | (g1 >> 4), B1 = (b1 << 3) | (b1 >> 2);
      col[0] = R0; col[1] = G0; col[2] = B0; col[3] = 255;
      col[4] = R1; col[5] = G1; col[6] = B1; col[7] = 255;
      if (fourcc !== 'DXT1' || c0 > c1) {
        col[8] = ((2 * R0 + R1) / 3) | 0; col[9] = ((2 * G0 + G1) / 3) | 0; col[10] = ((2 * B0 + B1) / 3) | 0; col[11] = 255;
        col[12] = ((R0 + 2 * R1) / 3) | 0; col[13] = ((G0 + 2 * G1) / 3) | 0; col[14] = ((B0 + 2 * B1) / 3) | 0; col[15] = 255;
      } else {
        col[8] = (R0 + R1) >> 1; col[9] = (G0 + G1) >> 1; col[10] = (B0 + B1) >> 1; col[11] = 255;
        col[12] = 0; col[13] = 0; col[14] = 0; col[15] = 0;
      }
      const idx = (data[co + 4] | (data[co + 5] << 8) | (data[co + 6] << 16) | (data[co + 7] << 24)) >>> 0;
      if (fourcc === 'DXT3') {
        for (let i = 0; i < 16; i++) alp[i] = ((data[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      } else if (fourcc === 'DXT5') {
        const a0 = data[o], a1 = data[o + 1];
        const tab = [a0, a1, 0, 0, 0, 0, 0, 0];
        if (a0 > a1) {
          for (let i = 1; i < 7; i++) tab[1 + i] = (((7 - i) * a0 + i * a1) / 7) | 0;
        } else {
          for (let i = 1; i < 5; i++) tab[1 + i] = (((5 - i) * a0 + i * a1) / 5) | 0;
          tab[6] = 0; tab[7] = 255;
        }
        // 48-bit index field, little endian, 3 bits per texel
        const lo = (data[o + 2] | (data[o + 3] << 8) | (data[o + 4] << 16)) >>> 0;
        const hi = (data[o + 5] | (data[o + 6] << 8) | (data[o + 7] << 16)) >>> 0;
        for (let i = 0; i < 8; i++) alp[i] = tab[(lo >> (3 * i)) & 7];
        for (let i = 0; i < 8; i++) alp[8 + i] = tab[(hi >> (3 * i)) & 7];
      }
      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= height) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= width) continue;
          const t = py * 4 + px;
          const s = ((idx >>> (2 * t)) & 3) * 4;
          const d = (y * width + x) * 4;
          out[d] = col[s]; out[d + 1] = col[s + 1]; out[d + 2] = col[s + 2];
          out[d + 3] = fourcc === 'DXT1' ? col[s + 3] : alp[t];
        }
      }
    }
  }
  return out;
}

// --- self-test -----------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const outDir = process.env.OUT || '.';
  let bytes = 0, ms = 0;
  let files = process.argv.slice(2);
  if (files.length === 1 && files[0].startsWith('@')) files = fs.readFileSync(files[0].slice(1), 'utf8').split('\n').filter(Boolean);
  for (const [fi, f] of files.entries()) {
    const b = fs.readFileSync(f);
    const h = b.readUInt32LE(12), w = b.readUInt32LE(16);
    const fourcc = b.toString('latin1', 84, 88);
    const bs = fourcc === 'DXT1' ? 8 : 16;
    const size = Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * bs;
    const data = new Uint8Array(b.buffer, b.byteOffset + 128, size);
    const t0 = performance.now();
    const rgba = decodeDXT(fourcc, data, w, h);
    ms += performance.now() - t0;
    bytes += rgba.length;
    fs.writeFileSync(path.join(outDir, String(fi) + '.rgba'), rgba);
  }
  console.log(JSON.stringify({ files: files.length, mpix: bytes / 4 / 1e6, ms, mpixPerS: bytes / 4 / 1e3 / ms }));
}
