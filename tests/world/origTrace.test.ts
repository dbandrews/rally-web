// tests/world/origTrace.test.ts — EVERY wheel ray recorded from the RUNNING original (Frida traces
// research/frida/traces/run{1,2}.bin, rallycross1, research/formats/gcm.md §8.2) replayed through the TS port
// (src/world/orig, the built rallycross-1-f collision part) with the per-wheel face-cache slots, compared with
// the original's own outputs (material, normal, c0 = depth, c4 = cos) AND with the statistics of the Python
// reference replay (artifacts/re/gcm/trace_run{1,2}.json, research/tools/fmt_gcm_trace.py): the TS port must
// reproduce them exactly (it reproduces the reference ray for ray, origCollision.test.ts).
//
// run1 (84 480 rays) runs when the trace is present; run2 (1.13 M rays, 1.7 GB) only with RALLY_GCM_FULL_TRACE=1.
// Skipped without the traces / the built part (CI, fresh clones).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { wheelSlot } from '../../src/core/worldQuery';
import { loadOrigWorld, type OrigWorld } from '../../src/world/orig';
import { buildStage } from '../../src/world/stages';
import { builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc?: string): Uint8Array | string;
  openSync(p: string, flags: string): number;
  readSync(fd: number, buf: Uint8Array, off: number, len: number, pos: number): number;
  closeSync(fd: number): void;
  statSync(p: string): { size: number };
}
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;

const TRACES = 'research/frida/traces';
const REF = 'artifacts/re/gcm';
// research/tools/fmt_gcm_trace.py: 24-byte header + two 3032-byte snapshots; the after-snapshot's 4 wheels
const SNAP = 3032, REC = 24 + 2 * SNAP, W0 = 1512, WS = 380;
const OFFSET = [2048, 10, 2048]; // the track object translation of the recorded session (gcm.md §8.2)
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = ['run1', ...(env.RALLY_GCM_FULL_TRACE === '1' ? ['run2'] : [])];
const ready = builtAssetsPresent && fs.existsSync('public/assets/stages/rallycross-1-f/collision.json') &&
  fs.existsSync(`${TRACES}/run1.bin`) && fs.existsSync(`${REF}/trace_run1.json`);

interface Stats {
  rays: number;
  hit_both: number;
  miss_both: number;
  hit_only_orig: number;
  hit_only_port: number;
  mat_eq: number;
  mat_ne: number;
  dn_max: number;
  dc0_max: number;
  dc4_max: number;
  nonvertical: number;
  normal_off_1e4: number;
  depth_off_1e3: number;
  records: number;
  cars: number;
}

function replay(w: OrigWorld, path: string): Stats {
  const st: Stats = {
    rays: 0, hit_both: 0, miss_both: 0, hit_only_orig: 0, hit_only_port: 0, mat_eq: 0, mat_ne: 0, dn_max: 0,
    dc0_max: 0, dc4_max: 0, nonvertical: 0, normal_off_1e4: 0, depth_off_1e3: 0, records: 0, cars: 0,
  };
  const n = Math.floor(fs.statSync(path).size / REC);
  const fd = fs.openSync(path, 'r');
  const CH = 4096;
  const buf = new Uint8Array(CH * REC);
  const dv = new DataView(buf.buffer);
  // the reference keys the caches by the sorted car ids (one dict per car): first pass collects the ids
  const ids = new Set<number>();
  for (let r0 = 0; r0 < n; r0 += CH) {
    const m = Math.min(CH, n - r0);
    fs.readSync(fd, buf, 0, m * REC, r0 * REC);
    for (let r = 0; r < m; r++) ids.add(dv.getUint32(r * REC + 8, true));
  }
  const carIndex = new Map([...ids].sort((a, b) => a - b).map((c, i) => [c, i] as const));
  const o = { x: 0, y: 0, z: 0 }, ray = { x: 0, y: 0, z: 0 };
  for (let r0 = 0; r0 < n; r0 += CH) {
    const m = Math.min(CH, n - r0);
    fs.readSync(fd, buf, 0, m * REC, r0 * REC);
    for (let r = 0; r < m; r++) {
      const base = r * REC;
      const ci = carIndex.get(dv.getUint32(base + 8, true))!;
      for (let wh = 0; wh < 4; wh++) {
        const q = base + 24 + SNAP + W0 + wh * WS;
        const f = (off: number) => dv.getFloat32(q + off, true);
        const ex = f(0x94), ey = f(0x98), ez = f(0x9c), vx = f(0xa0), vy = f(0xa4), vz = f(0xa8);
        if (!(Number.isFinite(ex) && Number.isFinite(ey) && Number.isFinite(ez))) continue;
        if (vx === 0 && vy === 0 && vz === 0) continue;
        const mat = dv.getInt32(q + 0xac, true);
        st.rays++;
        if (vx * vx + vz * vz > 0.05 * 0.05) st.nonvertical++;
        // origin = end − ray − track translation (W+0x94 − W+0xa0, 0x595c91)
        o.x = ex - vx - OFFSET[0];
        o.y = ey - vy - OFFSET[1];
        o.z = ez - vz - OFFSET[2];
        ray.x = vx;
        ray.y = vy;
        ray.z = vz;
        let h = w.segment(o, ray, wheelSlot(24 * ci, wh));
        if (h && h.origMaterial! >= 0x20) h = null; // the wheel cut (FUN_006cea90)
        if (mat === -1 && !h) {
          st.miss_both++;
          continue;
        }
        if (mat === -1) {
          st.hit_only_port++;
          continue;
        }
        if (!h) {
          st.hit_only_orig++;
          continue;
        }
        st.hit_both++;
        if (h.origMaterial === mat) st.mat_eq++;
        else st.mat_ne++;
        const dn = Math.max(Math.abs(h.normal.x - f(0xb4)), Math.abs(h.normal.y - f(0xb8)), Math.abs(h.normal.z - f(0xbc)));
        const d0 = Math.abs(h.depth! - f(0xc0)), d4 = Math.abs(h.cos! - f(0xc4));
        st.dn_max = Math.max(st.dn_max, dn);
        if (dn > 1e-4) st.normal_off_1e4++;
        if (d0 > 1e-3) st.depth_off_1e3++;
        st.dc0_max = Math.max(st.dc0_max, d0);
        st.dc4_max = Math.max(st.dc4_max, d4);
      }
    }
  }
  fs.closeSync(fd);
  st.records = n;
  st.cars = ids.size;
  return st;
}

describe.skipIf(!ready)('recorded wheel rays of the running original (full trace replay)', () => {
  let w: OrigWorld;
  beforeAll(async () => {
    useBuiltAssets();
    w = await loadOrigWorld('rallycross-1-f', buildStage('rallycross-1-f', 1).world);
  }, 120_000); // a built stage + its collision part: well past vitest's 10 s hook default in a parallel run
  afterAll(() => _setAssetFetchForTests(null));

  it.each(RUNS)('%s: every ray agrees with the original and the TS replay equals the Python replay', (run) => {
    w.resetFaceCache();
    const t0 = performance.now();
    const st = replay(w, `${TRACES}/${run}.bin`);
    const ms = performance.now() - t0;
    const ref = JSON.parse(fs.readFileSync(`${REF}/trace_${run}.json`, 'utf8') as string) as Stats;
    console.info(`[collision] ${run}: ${st.rays} rays (${st.nonvertical} tilted), ${st.hit_both} hits / ${st.miss_both} misses ` +
      `agree, material ${st.mat_eq}/${st.hit_both}, max |Δc0| ${st.dc0_max.toExponential(2)} m, max |Δc4| ` +
      `${st.dc4_max.toExponential(2)}, max |Δn| ${st.dn_max.toExponential(2)} (${(ms / 1000).toFixed(1)} s incl. I/O)`);
    // against the running original
    expect(st.hit_only_orig).toBe(0);
    expect(st.hit_only_port).toBe(0);
    expect(st.mat_ne).toBe(0);
    expect(st.depth_off_1e3).toBe(0);
    expect(st.dc0_max).toBeLessThan(1e-4);
    expect(st.dc4_max).toBeLessThan(1e-3);
    // identical to the Python reference replay, field by field
    for (const k of ['rays', 'hit_both', 'miss_both', 'hit_only_orig', 'hit_only_port', 'mat_eq', 'mat_ne', 'nonvertical',
      'normal_off_1e4', 'depth_off_1e3', 'records', 'cars'] as const) expect(st[k], k).toBe(ref[k]);
    for (const k of ['dn_max', 'dc0_max', 'dc4_max'] as const) expect(Math.abs(st[k] - ref[k]), k).toBeLessThan(1e-12);
  }, 600_000);
});
