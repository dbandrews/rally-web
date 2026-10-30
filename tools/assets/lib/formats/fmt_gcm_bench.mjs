// fmt_gcm_bench.mjs - micro-benchmark of the planned browser query on an RGC1 file (fmt_gcm_export.py output).
// usage: node research/tools/fmt_gcm_bench.mjs <stage.rgc> [nRays]
// Implements the vertical wheel-ray path of research/formats/gcm.md §3 / §9 on typed arrays only and times it on
// rays dropped onto random faces (60 % of them start above the surface, like loaded wheels).
import { readFileSync } from 'node:fs';

const buf = readFileSync(process.argv[2]);
const N = Number(process.argv[3] ?? 2_000_000);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const dv = new DataView(ab);
const u32 = (o) => dv.getUint32(o, true);
const f32 = (o) => dv.getFloat32(o, true);
if (String.fromCharCode(...new Uint8Array(ab, 0, 4)) !== 'RGC1') throw new Error('not RGC1');
const nV = u32(8), nF = u32(12), minX = f32(16), minZ = f32(20), maxX = f32(24), maxZ = f32(28);
const T = u32(32), nB = u32(36), nCells = u32(40), nRefs = u32(44), flags = u32(48);
let o = 64;
const take = (Ctor, n) => { const a = new Ctor(ab, o, n); o += (a.byteLength + 3) & ~3; return a; };
const V = take(Float32Array, 3 * nV);
const I = (flags & 1) ? take(Uint16Array, 3 * nF) : take(Uint32Array, 3 * nF);
const M = take(Int8Array, nF);
const FN = take(Float32Array, 3 * nF);
const tile = take(Int32Array, T * T);
const blk = take(Float32Array, 8 * nB);
const blkI = take(Uint32Array, 2 * nB);
const cs = take(Uint32Array, nCells + 1);
const refs = take(Uint32Array, nRefs);
if (o !== ab.byteLength) throw new Error('size mismatch');
const tw = (maxX - minX) / T, td = (maxZ - minZ) / T;

function blockAt(x, z) {
  const ix = Math.floor((x - minX) / tw), iz = Math.floor((z - minZ) / td);
  for (let k = 0; k < 5; k++) {
    const i = ix + (k === 1 ? -1 : k === 2 ? 1 : 0), j = iz + (k === 3 ? -1 : k === 4 ? 1 : 0);
    if (i < 0 || j < 0 || i >= T || j >= T) continue;
    const b = tile[i * T + j];
    if (b < 0) continue;
    const q = 8 * b;
    if (blk[q] <= x && x < blk[q + 2] && blk[q + 1] <= z && z < blk[q + 3]) return b;
  }
  return -1;
}

// vertical segment (x, y0, z) -> (x, y0 - len, z); returns face id or -1; writes depth into out[0]
const out = new Float64Array(2);
function vertical(x, y0, z, len) {
  const b = blockAt(x, z);
  if (b < 0) return -1;
  const q = 8 * b, dim = blkI[2 * b], base = blkI[2 * b + 1];
  const i = Math.trunc((x - blk[q]) * blk[q + 6]), j = Math.trunc((z - blk[q + 1]) * blk[q + 7]);
  if (i < 0 || j < 0 || i >= dim || j >= dim) return -1;
  const c = base + i * dim + j;
  const ey = y0 - len;
  for (let k = cs[c], e = cs[c + 1]; k < e; k++) {
    const f = refs[k];
    const a0 = 3 * I[3 * f], a1 = 3 * I[3 * f + 1], a2 = 3 * I[3 * f + 2];
    const nx = FN[3 * f], ny = FN[3 * f + 1], nz = FN[3 * f + 2];
    const d1 = (x - V[a0]) * nx + (ey - V[a0 + 1]) * ny + (z - V[a0 + 2]) * nz;
    if (d1 > 0) continue;
    const d0 = (x - V[a0]) * nx + (y0 - V[a0 + 1]) * ny + (z - V[a0 + 2]) * nz;
    if (d0 <= 0) continue; // gcm.md Verification §3.4: d0 = 0 is a MISS (0x59511f test ah,0x41; jp)
    const da = -len * ny;
    if (da >= 0) continue;
    const t = -d0 / da;
    let pi, pj, iA, jA;
    if (Math.abs(ny) >= 0.7) { iA = 0; jA = 2; pi = x; pj = z; }
    else if (Math.abs(nz) > 0.3) { iA = 0; jA = 1; pi = x; pj = y0 - t * len; }
    else { iA = 1; jA = 2; pi = y0 - t * len; pj = z; }
    const e1 = (V[a1 + jA] - V[a0 + jA]) * (pi - V[a0 + iA]) - (pj - V[a0 + jA]) * (V[a1 + iA] - V[a0 + iA]);
    const e2 = (V[a2 + jA] - V[a1 + jA]) * (pi - V[a1 + iA]) - (V[a2 + iA] - V[a1 + iA]) * (pj - V[a1 + jA]);
    if ((e1 < 0 && e2 > 0) || (e1 > 0 && e2 < 0)) continue;
    const e3 = (V[a0 + jA] - V[a2 + jA]) * (pi - V[a2 + iA]) - (pj - V[a2 + jA]) * (V[a0 + iA] - V[a2 + iA]);
    if ((e1 < 0 && e3 > 0) || (e1 > 0 && e3 < 0)) continue;
    out[0] = d1;
    return f;
  }
  return -1;
}

// test rays: random points on random faces, start 0..0.75 m above (hits) or 0.75..1.2 m above (misses)
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const R = 1 << 16, X = new Float64Array(R), Y = new Float64Array(R), Z = new Float64Array(R);
for (let r = 0; r < R; r++) {
  const f = Math.floor(rnd() * nF);
  let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
  const a0 = 3 * I[3 * f], a1 = 3 * I[3 * f + 1], a2 = 3 * I[3 * f + 2];
  X[r] = V[a0] + u * (V[a1] - V[a0]) + v * (V[a2] - V[a0]);
  Y[r] = V[a0 + 1] + u * (V[a1 + 1] - V[a0 + 1]) + v * (V[a2 + 1] - V[a0 + 1]) + rnd() * 1.2;
  Z[r] = V[a0 + 2] + u * (V[a1 + 2] - V[a0 + 2]) + v * (V[a2 + 2] - V[a0 + 2]);
}
let hits = 0;
for (let r = 0; r < 200_000; r++) vertical(X[r & (R - 1)], Y[r & (R - 1)], Z[r & (R - 1)], 0.75); // warm-up
const t0 = process.hrtime.bigint();
for (let r = 0; r < N; r++) if (vertical(X[r & (R - 1)], Y[r & (R - 1)], Z[r & (R - 1)], 0.75) >= 0) hits++;
const ns = Number(process.hrtime.bigint() - t0) / N;
console.log(JSON.stringify({ file: process.argv[2].split('/').pop(), faces: nF, blocks: nB, rays: N, hitFrac: +(hits / N).toFixed(3), nsPerRay: +ns.toFixed(1) }));
