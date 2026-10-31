/**
 * Ghost playback (src/game/ghosts/player.ts = FUN_004db730 + the manager's hold counter) against the original exe EXECUTED
 * under unicorn (research/tools/ghost_exe_fixtures.py): the real team ghosts (3 committed, all 30 with GHOST_PLAY_ALL=<dir>
 * written by `ghost_exe_fixtures.py --all-out <dir>`), synthetic ghosts with hold frames / sign flips / the 1e-6 guard,
 * the tick grid (frame k at tick 8k + 7, 7/8 freeze) and the end behaviour.
 */
import { describe, expect, it } from 'vitest';
import { GhostPlayer, normalizeQuat } from '../../../src/game/ghosts/player';
import { GHOST_FRAME_BYTES, keyStates, parseGhost, type GhostFile } from '../../../src/game/ghosts/format';
import { FIX, TEAM_DIR, env, exists, f32at, hexToBytes, listDir, readBytes, readJson, u32at } from './nodefs';

function readF32(path: string): Float32Array {
  const b = readBytes(path);
  const n = u32at(b, 0);
  const out = new Float32Array(n * 9);
  for (let i = 0; i < n * 9; i++) out[i] = f32at(b, 4 + 4 * i);
  return out;
}

const unitDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  const na = Math.hypot(a[3], a[4], a[5], a[6]);
  const nb = Math.hypot(b[3], b[4], b[5], b[6]);
  let m = 0;
  for (let i = 3; i < 7; i++) m = Math.max(m, Math.abs(a[i] / na - b[i] / nb));
  return m;
};

interface Stats {
  ticks: number;
  nonQuatMismatch: number;
  quatBitMismatch: number;
  maxUnitDiff: number;
}

function compare(file: GhostFile, exe: Float32Array): Stats {
  const p = new GhostPlayer(file);
  const out = new Float32Array(9);
  const st: Stats = { ticks: 0, nonQuatMismatch: 0, quatBitMismatch: 0, maxUnitDiff: 0 };
  const n = exe.length / 9;
  for (let t = 0; t < n; t++) {
    expect(p.step(out), `tick ${t} must play`).toBe(true);
    const e = exe.subarray(9 * t, 9 * t + 9);
    for (const k of [0, 1, 2, 7, 8]) if (out[k] !== e[k]) st.nonQuatMismatch++;
    let qb = false;
    for (let k = 3; k < 7; k++) if (out[k] !== e[k]) qb = true;
    if (qb) st.quatBitMismatch++;
    st.maxUnitDiff = Math.max(st.maxUnitDiff, unitDiff(out, e));
    st.ticks++;
  }
  expect(p.step(out), 'the exe returned false after these ticks').toBe(false);
  return st;
}

describe('ghost playback vs the executed exe: real team ghosts', () => {
  for (const name of ['JoelH_Iceracing2f', 'JohanA_Rallycross3f', 'TobiasA_Rallycross3r']) {
    it(`${name}: every tick (position, steer, spin bit-exact; quaternion direction < 1e-6)`, () => {
      const file = parseGhost(readBytes(`${FIX}/${name}`));
      const exe = readF32(`${FIX}/play.${name}.f32`);
      expect(exe.length / 9).toBe((file.frameCount - 1) * 8);
      const st = compare(file, exe);
      expect(st.nonQuatMismatch).toBe(0);
      expect(st.maxUnitDiff).toBeLessThan(1e-6);
    });
  }

  const all = env('GHOST_PLAY_ALL');
  (all && exists(all) && exists(TEAM_DIR) ? it : it.skip)('ALL 30 team ghosts, every tick (GHOST_PLAY_ALL=<dir>)', () => {
    let ticks = 0;
    let nonQuat = 0;
    let qbit = 0;
    let maxd = 0;
    for (const name of listDir(TEAM_DIR)) {
      const file = parseGhost(readBytes(`${TEAM_DIR}/${name}`));
      const st = compare(file, readF32(`${all as string}/play.${name}.f32`));
      ticks += st.ticks;
      nonQuat += st.nonQuatMismatch;
      qbit += st.quatBitMismatch;
      maxd = Math.max(maxd, st.maxUnitDiff);
    }
    console.log(`[ghost playback] 30 files, ${ticks} ticks: position/steer/spin mismatches ${nonQuat}, quaternion bit-mismatching ticks ${qbit}, max normalised quaternion diff ${maxd.toExponential(2)}`);
    expect(nonQuat).toBe(0);
    expect(maxd).toBeLessThan(1e-6);
  });
});

describe('ghost playback vs the executed exe: synthetic ghosts', () => {
  const synth = readJson<Array<{
    desc: string;
    initial: number[];
    frameCount: number;
    frames: string;
    ticks: number[][];
  }>>(`${FIX}/play.synth.json`);
  for (const s of synth) {
    it(s.desc, () => {
      const file: GhostFile = {
        version: '2.0',
        carTemplate: 'XGhost',
        ghostName: 'x',
        splits: [1],
        initial: new Float32Array(s.initial),
        frames: hexToBytes(s.frames),
        frameCount: s.frameCount,
        trailer: new Uint8Array(0),
      };
      expect(file.frames.length).toBe(s.frameCount * GHOST_FRAME_BYTES);
      const flat = new Float32Array(s.ticks.length * 9);
      s.ticks.forEach((t, i) => flat.set(t, 9 * i));
      const st = compare(file, flat);
      expect(st.nonQuatMismatch).toBe(0);
      expect(st.maxUnitDiff).toBeLessThan(1e-6);
    });
  }
});

describe('ghost playback: hold frames', () => {
  const holdFrame = (n: number): number[] => [1, n & 255, 0, 0, 0, ...new Array(14).fill(0)];
  const mk = (counts: Array<number | null>): GhostFile => {
    const fr = new Uint8Array(counts.length * GHOST_FRAME_BYTES);
    counts.forEach((n, i) => fr.set(n === null ? new Array(GHOST_FRAME_BYTES).fill(0) : holdFrame(n), i * GHOST_FRAME_BYTES));
    return { version: '2.0', carTemplate: 'XGhost', ghostName: 'x', splits: [1], initial: new Float32Array([1, 2, 3, 0, 0, 0, 1, 4, 5]), frames: fr, frameCount: counts.length, trailer: new Uint8Array(0) };
  };
  const ticksPerFrame = (file: GhostFile): number[] => {
    const p = new GhostPlayer(file);
    const out = new Float32Array(9);
    const at: number[] = [];
    let last = 0;
    for (let t = 0; p.step(out); t++) {
      if (p.k !== last) {
        at.push(t + 1);
        last = p.k;
      }
    }
    return at;
  };

  it('a hold frame at index >= 1 lasts holdCount + 1 periods', () => {
    // frames: plain (nonzero flags would be a delta; an all-zero non-hold frame is a plain still frame), hold 2, plain, plain
    expect(ticksPerFrame(mk([null, 2, null, null]))).toEqual([8, 8 + 24, 8 + 24 + 8]);
  });

  it('a hold at frame 0 lasts ONE period whatever its count (the exe re-enters its start branch, which resets the hold counter) [E, unicorn]', () => {
    expect(ticksPerFrame(mk([5, null, null]))).toEqual([8, 16]);
    expect(ticksPerFrame(mk([0, null, null]))).toEqual([8, 16]);
  });
});

describe('ghost playback: the tick grid and the end', () => {
  const file = parseGhost(readBytes(`${FIX}/JoelH_Iceracing2f`));
  const states = keyStates(file);

  it('tick 0 shows the initial state; tick 8s + c is c/8 of the way through segment s (frame k is recorded at tick 8k + 7, shown at tick 8k + 8)', () => {
    const p = new GhostPlayer(file);
    const out = new Float32Array(9);
    p.step(out);
    for (let k = 0; k < 9; k++) expect(out[k]).toBe(file.initial[k]);
    // tick 8k + c is the state c/8 of the way from frame k-1 to frame k (frame -1 = initial)
    for (let t = 1; t < 8 * 20; t++) {
      p.step(out);
      const seg = Math.floor(t / 8);
      const f = (t % 8) / 8;
      const a = states[seg];
      const b = states[seg + 1];
      expect(Math.abs(out[0] - (a[0] * (1 - f) + b[0] * f))).toBeLessThan(2e-3);
      expect(Math.abs(out[2] - (a[2] * (1 - f) + b[2] * f))).toBeLessThan(2e-3);
      expect(out[7]).toBeCloseTo(a[7] * (1 - f) + b[7] * f, 3);
    }
  });

  it('the position at ticks 8k + 7 + 1 equals the decoded frame k (frame k is reached at tick 8(k+1))', () => {
    const p = new GhostPlayer(file);
    const out = new Float32Array(9);
    for (let t = 0; t <= 8 * 30; t++) {
      p.step(out);
      if (t % 8 === 0 && t > 0) {
        const s = states[t / 8];
        expect(out[0]).toBe(s[0]);
        expect(out[1]).toBe(s[1]);
        expect(out[2]).toBe(s[2]);
        expect(out[7]).toBe(s[7]);
        expect(out[8]).toBe(s[8]);
      }
    }
  });

  it('freezes after (frameCount - 1) * 8 ticks at 7/8 of the last segment and never shows the last frame', () => {
    const p = new GhostPlayer(file);
    const out = new Float32Array(9);
    const last = new Float32Array(9);
    let n = 0;
    while (p.step(out)) {
      last.set(out);
      n++;
    }
    expect(n).toBe((file.frameCount - 1) * 8);
    expect(p.finished).toBe(true);
    expect(p.k).toBe(file.frameCount - 1);
    const a = states[file.frameCount - 2];
    const b = states[file.frameCount - 1];
    const f = 7 / 8;
    expect(Math.abs(last[0] - (a[0] * (1 - f) + b[0] * f))).toBeLessThan(2e-3);
    // further calls keep returning false and leave the output alone
    out.fill(123);
    expect(p.step(out)).toBe(false);
    expect(out[0]).toBe(123);
  });

  it('seek(n) equals n steps; rewind restarts', () => {
    const p = new GhostPlayer(file);
    const a = new Float32Array(9);
    const b = new Float32Array(9);
    for (let i = 0; i < 1234; i++) p.step(a);
    const q = new GhostPlayer(file);
    q.seek(1234, b);
    expect(Array.from(b)).toEqual(Array.from(a));
    p.rewind();
    p.step(a);
    expect(a[0]).toBe(file.initial[0]);
  });

  it('normalizeQuat makes the exe output a unit quaternion', () => {
    const s = [0, 0, 0, 0.5, 0.5, 0.5, 2.5, 0, 0];
    normalizeQuat(s);
    expect(Math.hypot(s[3], s[4], s[5], s[6])).toBeCloseTo(1, 12);
    const z = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    normalizeQuat(z);
    expect(z[6]).toBe(1);
  });
});
