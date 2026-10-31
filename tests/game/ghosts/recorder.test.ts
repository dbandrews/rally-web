/**
 * Ghost recording (src/game/ghosts/recorder.ts = FUN_004db540) against the exe EXECUTED under unicorn on deterministic
 * state streams (research/tools/ghost_exe_fixtures.py: the generator below mirrors its Lcg / gen_states): frames, hold
 * frames, the stationary-start quirk, the 5173-frame cap; plus a record -> play round trip.
 */
import { describe, expect, it } from 'vitest';
import { GHOST_FRAME_BYTES, MAX_GHOST_FRAMES, isHoldFrame, holdCountOf, keyStates, parseGhost, writeGhost } from '../../../src/game/ghosts/format';
import { GhostPlayer } from '../../../src/game/ghosts/player';
import { GhostRecorder15 } from '../../../src/game/ghosts/recorder';
import { FIX, bytesToHex, readJson, sha256 } from './nodefs';

const f32 = Math.fround;

class Lcg {
  x: number;
  constructor(seed: number) {
    this.x = seed >>> 0;
  }
  r(): number {
    this.x = (Math.imul(this.x, 1664525) + 1013904223) >>> 0;
    return this.x / 4294967296;
  }
}

type Seg = [string, number];
/** Mirror of ghost_exe_fixtures.gen_states (integer LCG + float64 arithmetic, rounded to float32). */
function genStates(seed: number, segs: Seg[]): Float32Array[] {
  const rng = new Lcg(seed);
  const pos = [2000, 400, 2500];
  let q = [0, 0, 0, 1];
  let steer = 0;
  let spin = 0;
  const vel = [0.05, 0, 0.1];
  const out: Float32Array[] = [];
  for (const [kind, n] of segs) {
    if (kind === 'jump') {
      pos[0] += n;
      continue;
    }
    for (let t = 0; t < n; t++) {
      if (kind === 'move') {
        for (let i = 0; i < 3; i++) {
          vel[i] += (rng.r() - 0.5) * 0.01;
          pos[i] += vel[i];
        }
        q = q.map((c) => c + (rng.r() - 0.5) * 0.004);
        const nn = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        q = q.map((c) => c / nn);
        steer = Math.max(-30, Math.min(30, steer + (rng.r() - 0.5) * 2));
        spin = spin - (rng.r() * 20 + 5);
        while (spin < -180) spin += 360;
      }
      out.push(new Float32Array([...pos, ...q, steer, spin]));
    }
  }
  return out;
}

interface Case {
  name: string;
  seed: number;
  segs: Seg[];
  ticks: number;
  frameCount: number;
  index: number;
  sub: number;
  initial: number[];
  holds: number;
  framesSha256: string;
  frames?: string;
}
const CASES = readJson<Case[]>(`${FIX}/record.cases.json`);

function record(states: Float32Array[]): GhostRecorder15 {
  const r = new GhostRecorder15();
  r.start();
  for (const s of states) r.sample(s);
  return r;
}

describe('ghost recorder vs the executed exe (FUN_004db540)', () => {
  for (const c of CASES) {
    it(`${c.name}: ${c.ticks} ticks -> ${c.frameCount} frames (${c.holds} hold)`, async () => {
      const states = genStates(c.seed, c.segs);
      expect(states.length).toBe(c.ticks);
      const r = record(states);
      expect(r.frameCount).toBe(c.frameCount);
      expect(r.index).toBe(c.index);
      expect(r.sub).toBe(c.sub);
      expect(Array.from(r.initial)).toEqual(c.initial.map(f32));
      const frames = r.frames.slice(0, r.frameCount * GHOST_FRAME_BYTES);
      expect(await sha256(frames)).toBe(c.framesSha256);
      if (c.frames) expect(bytesToHex(frames)).toBe(c.frames);
      let holds = 0;
      for (let i = 0; i < r.frameCount; i++) if (isHoldFrame(frames, i * GHOST_FRAME_BYTES)) holds++;
      expect(holds).toBe(c.holds);
    });
  }

  it('the grid: initial state at tick 0, frame k encoded at tick 8k + 7', () => {
    const states = genStates(1, [['move', 100]]);
    const r = new GhostRecorder15();
    r.start();
    const seen: number[] = [];
    for (let t = 0; t < 100; t++) {
      const before = r.frameCount;
      r.sample(states[t]);
      if (r.frameCount !== before) seen.push(t);
    }
    expect(Array.from(r.initial)).toEqual(Array.from(states[0]));
    expect(seen.slice(0, 4)).toEqual([7, 15, 23, 31]);
    expect(r.frameCount).toBe(12); // ticks 7..95
  });

  it('cap: at most 5173 frames, then nothing more is recorded', () => {
    const cap = CASES.find((c) => c.name === 'cap')!;
    expect(cap.frameCount).toBe(MAX_GHOST_FRAMES);
    expect(cap.frameCount).toBe(5173);
  });

  it('a stationary start is trimmed to the first period with movement (the exe re-samples the initial state)', () => {
    const still = CASES.find((c) => c.name === 'stillStart')!;
    const aligned = CASES.find((c) => c.name === 'stillStartAligned')!;
    expect(still.ticks).toBe(29 + 800);
    expect(still.frameCount).toBe(100); // 829 ticks would give 103 frames
    expect(aligned.frameCount).toBe(50); // 440 ticks: 55 frames minus 5 whole still periods
    expect(still.sub).toBe(5);
  });

  it('a mid-run stop creates ONE hold frame whose count grows by one per still period (stored as holdCount)', () => {
    const states = genStates(7, [['move', 100], ['still', 323], ['move', 100]]);
    const r = record(states);
    const frames = r.frames;
    let found = -1;
    for (let i = 0; i < r.frameCount; i++) if (isHoldFrame(frames, i * GHOST_FRAME_BYTES)) found = i;
    expect(found).toBeGreaterThan(0);
    expect(holdCountOf(frames, found * GHOST_FRAME_BYTES)).toBeGreaterThan(30);
    // playback shows the held state for holdCount + 1 periods
    const g = r.toFile({ car: 'Micra', name: 'x', splits: [10] });
    const st = keyStates(g);
    const n = holdCountOf(frames, found * GHOST_FRAME_BYTES);
    for (let i = 1; i <= n; i++) expect(Array.from(st[found + 1 + i])).toEqual(Array.from(st[found + 1]));
  });

  it('record -> save (3.0) -> load -> play reproduces the recorded track (position within the 1-tick lag, bit-stable steer)', () => {
    const states = genStates(11, [['move', 1600]]);
    const r = record(states);
    const bytes = writeGhost(r.toFile({ car: 'Peugeot206', name: 'Round Trip', splits: [5, 13.3333], date: 1_700_000_000_000 }));
    const g = parseGhost(bytes);
    expect(g.version).toBe('3.0');
    expect(g.carTemplate).toBe('Peugeot206Ghost');
    expect(g.ghostName).toBe('Round Trip');
    expect(g.frameCount).toBe(200);
    const p = new GhostPlayer(g);
    const out = new Float32Array(9);
    let worst = 0;
    for (let t = 0; t < (g.frameCount - 1) * 8; t++) {
      p.step(out);
      // the ghost shows the recorded track one tick late (segment s covers ticks 8s..8s+7, frame k is recorded at 8k+7)
      const ref = states[Math.max(0, t - 1)];
      worst = Math.max(worst, Math.hypot(out[0] - ref[0], out[1] - ref[1], out[2] - ref[2]));
    }
    expect(worst).toBeLessThan(0.1); // the track is smooth: linear interpolation between 15 Hz samples of a 0.1 m/tick drive
  });

  it('is inert while not recording', () => {
    const r = new GhostRecorder15();
    expect(r.sample(new Float32Array(9))).toBe(false);
    r.start();
    expect(r.sample(new Float32Array(9))).toBe(true);
    r.stop();
    expect(r.sample(new Float32Array(9))).toBe(false);
  });
});
