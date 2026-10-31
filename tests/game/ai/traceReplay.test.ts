/**
 * The ported AI vs the ORIGINAL game's AI cars: Frida run 2 (research/frida/traces/run2.bin: rallycross-1-f, one human car
 * parked on the grid, three AI cars Micra / Corolla / ... driving, 120 Hz physics steps with the pedals the AI wrote).
 *
 * Open-loop, teacher-forced: for each recorded step the AI driver gets the recorded car state (position, orientation,
 * speeds, the other cars) and must produce the pedals the original wrote that step (P+0x60/64/68 of the pre-step snapshot);
 * the driver's integrated pedal state is re-synced to the recording every step so one miss never snowballs. Reports the
 * per-pedal error distribution. Skipped without the trace (1.7 GB, not in the repo) or the built assets.
 *
 *   TRACE=research/frida/traces/run2.bin  AI_REPLAY_STEPS=4000  npx vitest run tests/game/ai/traceReplay.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../../src/core/assets';
import { qFromBasis } from '../../../src/core/math';
import { createAiDriver } from '../../../src/game/ai/driver';
import { loadAiStageData, _resetAiDataCaches } from '../../../src/game/ai/aidata';
import type { AiOtherCar } from '../../../src/game/ai/driver';
import type { CarTelemetry } from '../../../src/core/types';
import { buildStage } from '../../../src/world/stages';
import { builtAssetsPresent, useBuiltAssets } from '../../assets/builtAssetFetch';
import { fs, root } from './nodefs';

const env = ((globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}) as Record<string, string | undefined>;
const TRACE = env.TRACE ?? `${root}research/frida/traces/run2.bin`;
const STAGE = env.AI_REPLAY_STAGE ?? 'rallycross-1-f';
const STEPS = Number(env.AI_REPLAY_STEPS ?? 3000);
const FROM = Number(env.AI_REPLAY_FROM ?? 0); // first step group
const OFFSET = { x: 2048, y: 10, z: 2048 }; // the session's track translation (compare.audit.ts)
const REC = 6088;
const present = fs.existsSync(TRACE) && builtAssetsPresent;

interface Fr {
  car: number;
  ai: number;
  pos: { x: number; y: number; z: number };
  right: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  fwd: { x: number; y: number; z: number };
  vL: { x: number; y: number; z: number };
  speedKmh: number;
  ped: [number, number, number];
  parked: boolean;
}

async function readFrames(first: number, groups: number): Promise<Fr[][]> {
  const T = (await import(/* @vite-ignore */ root + 'research/frida/trace.ts')) as {
    Snap: new (dv: DataView, base: number) => any;
    HDR: number;
    REC: number;
  };
  const fsm = (await import(/* @vite-ignore */ 'node:' + 'fs')) as unknown as {
    openSync(p: string, f: string): number;
    readSync(fd: number, b: Uint8Array, o: number, l: number, p: number): number;
    closeSync(fd: number): void;
  };
  const fd = fsm.openSync(TRACE, 'r');
  const nrec = groups * 4;
  const buf = new Uint8Array(nrec * REC);
  const n = fsm.readSync(fd, buf, 0, buf.length, first * 4 * REC);
  fsm.closeSync(fd);
  const dv = new DataView(buf.buffer);
  const frames: Fr[][] = [];
  for (let g = 0; g + 4 <= Math.floor(n / REC); g += 4) {
    const grp: Fr[] = [];
    for (let k = 0; k < 4; k++) {
      const o = (g + k) * REC;
      const pre = new T.Snap(dv, o + T.HDR);
      grp.push({
        car: dv.getUint32(o + 8, true),
        ai: pre.aiMode,
        pos: pre.pos,
        right: pre.right,
        up: pre.up,
        fwd: pre.fwd,
        vL: pre.vL,
        speedKmh: pre.speedKmh,
        ped: [pre.steerIn, pre.thrIn, pre.brkIn],
        parked: pre.parked,
      });
    }
    frames.push(grp);
  }
  return frames;
}

const q = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : NaN;
};

describe.skipIf(!present)('ported AI vs the original game (Frida run 2)', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => {
    _setAssetFetchForTests(null);
    _resetAiDataCaches();
  });

  it(`reproduces the pedals of the original's AI cars (${STEPS} steps from group ${FROM})`, async () => {
    const built = buildStage(STAGE, 1);
    const stage = built.stage;
    const data = await loadAiStageData(STAGE);
    expect(data).not.toBeNull();
    const frames = await readFrames(FROM, STEPS);
    expect(frames.length).toBeGreaterThan(100);
    const ids = [...new Set(frames[0].map((f) => f.car))];
    // the AI cars: aiMode 1 in the first group
    const aiCars = frames[0].filter((f) => f.ai === 1).map((f) => f.car);
    expect(aiCars.length).toBeGreaterThanOrEqual(2);
    const humanCar = frames[0].find((f) => f.ai === 0)!.car;
    const L = stage.length;
    const ks = (env.AI_REPLAY_K ?? '').split(',').filter(Boolean).map(Number);
    const drivers = new Map(
      aiCars.map((c, i) => [
        c,
        createAiDriver({
          spec: { id: `ai${i + 1}`, origCar: 'Micra', archetype: 'awd_wrc', name: 'x', skill: ks[i] ?? 1, tyreScale: 1, gridIndex: i + 1, slotBase: 0 },
          stage,
          world: built.world,
          data,
          schedule: null,
        }),
      ]),
    );
    const hint = new Map<number, number>();
    const prevS = new Map<number, number>();
    const progress = new Map<number, number>();
    const err = { steer: [] as number[], thr: [] as number[], brk: [] as number[] };
    const perCar = new Map<number, { steer: number[]; thr: number[]; brk: number[] }>();
    let compared = 0;
    let prevPed = new Map<number, [number, number, number]>();
    let missN = 0;
    let parkedN = 0;
    let gi = -1;
    for (const grp of frames) {
      gi++;
      // project every car onto the stage (sim = world - offset; three = mirror)
      const proj = new Map<number, { s: number; lateral: number; pos3: { x: number; y: number; z: number }; speedKmh: number; isPlayer: boolean }>();
      for (const f of grp) {
        const simPos = { x: f.pos.x - OFFSET.x, y: f.pos.y - OFFSET.y, z: f.pos.z - OFFSET.z };
        const p3 = { x: simPos.x, y: simPos.y, z: -simPos.z };
        const pr = stage.project(p3, hint.get(f.car));
        hint.set(f.car, pr.s);
        let ds = pr.s - (prevS.get(f.car) ?? pr.s);
        if (ds < -L / 2) ds += L;
        else if (ds > L / 2) ds -= L;
        progress.set(f.car, (progress.get(f.car) ?? pr.s) + ds); // lap 0 assumed at the first sample
        prevS.set(f.car, pr.s);
        proj.set(f.car, { s: pr.s, lateral: pr.lateral, pos3: p3, speedKmh: f.speedKmh, isPlayer: f.ai === 0 });
      }
      for (const f of grp) {
        const drv = drivers.get(f.car);
        if (!drv) continue;
        // before GO the original does not drive its AI cars: pedals all zero while standing (the parked flag is not set in these records)
        const standing = f.ped[0] === 0 && f.ped[1] === 0 && f.ped[2] === 0 && Math.abs(f.vL.z) < 0.05;
        const pre = f.parked || standing ? undefined : prevPed.get(f.car);
        if (f.parked || standing) {
          drv.update({ dt: 1 / 120, self: {} as CarTelemetry, s: 0, lateral: 0, lapDist: 0, others: [], raceTime: 0, running: false });
          prevPed.set(f.car, f.ped);
          parkedN++;
          continue;
        }
        if (pre) drv.syncPedals(pre[0], pre[1], pre[2]);
        const me = proj.get(f.car)!;
        const simPos = { x: f.pos.x - OFFSET.x, y: f.pos.y - OFFSET.y, z: f.pos.z - OFFSET.z };
        const tel = {
          speedKmh: f.speedKmh,
          posSim: simPos,
          quatSim: qFromBasis(f.right, f.up, f.fwd),
          velLocal: f.vL,
        } as unknown as CarTelemetry;
        const others: AiOtherCar[] = grp
          .filter((o) => o.car !== f.car)
          .map((o) => {
            const pj = proj.get(o.car)!;
            return { id: String(o.car), isPlayer: o.ai === 0, pos: pj.pos3, speedKmh: pj.speedKmh, s: pj.s, lateral: pj.lateral, halfWidth: 0 };
          });
        const c = drv.update({ dt: 1 / 120, self: tel, s: me.s, lateral: me.lateral, lapDist: progress.get(f.car)! - stage.startS, others, raceTime: 0, running: true, ...(env.AI_REPLAY_LEADER === '0' ? {} : { leaderLapDist: progress.get(humanCar)! - stage.startS }) } as never);
        if (env.AI_REPLAY_DUMP && f.car === aiCars[Number(env.AI_REPLAY_CAR ?? 0)] && gi >= Number(env.AI_REPLAY_DFROM ?? 0) && gi < Number(env.AI_REPLAY_DFROM ?? 0) + Number(env.AI_REPLAY_DUMP)) {
          const d = drv.debug();
          console.log(`DUMP g=${gi} others=${others.map((o) => `${o.id.slice(-4)}:s${o.s.toFixed(0)}/l${o.lateral.toFixed(1)}/v${o.speedKmh.toFixed(0)}`).join(' ')} rec=${f.ped.map((x) => x.toFixed(4))} ours=${[c.steer, c.throttle, c.brake].map((x) => x.toFixed(4))} v=${f.vL.z.toFixed(2)} kmh=${f.speedKmh.toFixed(1)} s=${me.s.toFixed(1)} lat=${me.lateral.toFixed(2)} ${JSON.stringify(d)}`);
        }
        if (pre && env.AI_REPLAY_MISS && f.car === aiCars[Number(env.AI_REPLAY_CAR ?? 0)] && ((env.AI_REPLAY_PEDAL !== 'steer' && (Math.abs(c.throttle - f.ped[1]) > 2e-3 || Math.abs(c.brake - f.ped[2]) > 2e-3)) || (env.AI_REPLAY_PEDAL === 'steer' && Math.abs(c.steer - f.ped[0]) > 2e-3)) && missN++ < Number(env.AI_REPLAY_MISS)) {
          console.log(`MISS g=${gi} rec=${f.ped.map((x) => x.toFixed(4))} ours=${[c.steer, c.throttle, c.brake].map((x) => x.toFixed(4))} prev=${pre.map((x) => x.toFixed(4))} v=${f.vL.z.toFixed(2)} s=${me.s.toFixed(1)} lat=${me.lateral.toFixed(2)} ${JSON.stringify(drv.debug())}`);
        }
        if (pre) {
          const e = [Math.abs(c.steer - f.ped[0]), Math.abs(c.throttle - f.ped[1]), Math.abs(c.brake - f.ped[2])];
          err.steer.push(e[0]);
          err.thr.push(e[1]);
          err.brk.push(e[2]);
          const pc = perCar.get(f.car) ?? perCar.set(f.car, { steer: [], thr: [], brk: [] }).get(f.car)!;
          pc.steer.push(e[0]);
          pc.thr.push(e[1]);
          pc.brk.push(e[2]);
          compared++;
        }
        prevPed.set(f.car, f.ped);
      }
      prevPed = new Map(prevPed);
    }
    const stat = (xs: number[]) => `max ${Math.max(...xs).toExponential(2)} p99 ${q(xs, 0.99).toExponential(2)} median ${q(xs, 0.5).toExponential(2)} within 1e-3: ${((xs.filter((x) => x < 1e-3).length / xs.length) * 100).toFixed(1)}%`;
    const lines = [`ids ${ids.map((i) => i.toString(16)).join(',')}; AI cars ${aiCars.map((i) => i.toString(16)).join(',')}; ${compared} comparisons (${parkedN} parked records skipped)`];
    for (const [c, e] of perCar) lines.push(`car 0x${c.toString(16)}: steer ${stat(e.steer)} | thr ${stat(e.thr)} | brk ${stat(e.brk)}`);
    lines.push(`all: steer ${stat(err.steer)} | thr ${stat(err.thr)} | brk ${stat(err.brk)}`);
    console.log('TRACE-REPLAY\n' + lines.join('\n'));
    expect(compared).toBeGreaterThan(100);
  }, 600_000);
});
