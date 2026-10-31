/**
 * AI car FUN_00607280 (refresh), FUN_00607ae0 (drive) and FUN_00609550 (reset) vs the ORIGINAL x87 functions executed in
 * unicorn on synthetic object graphs (research/tools/ai_hl_emu.py -> fixtures/aicar.json.gz, FPU control word 0x7f =
 * the game's 24-bit precision). The fixture holds the full RallyCar block before and after, the other cars, the
 * spline-manager stub results (replayed in call order, arguments asserted), the PhysCar values and the pedals / out
 * byte / the arguments handed to the controller. TOLERANCE 0: every float field, pedal and controller argument is
 * bit-identical (the port rounds every x87 op to float32, docs/orig/ai.md section 1); ints and flags are exact.
 */
import { describe, expect, it } from 'vitest';
import { AiCar, type AiEnv, type AiPeer, type AiPost } from '../../../src/game/ai/aicar';
import { readJson } from './nodefs';

type Sp = Record<string, number>;
interface Call extends Array<string | number> {}
interface Case {
  k: 'r' | 'd' | 'z';
  dt?: number;
  flag?: number;
  L?: number;
  pre: Sp;
  post: Sp;
  peers?: Sp[];
  ptrs?: number[];
  ped?: number[];
  ctl?: number[] | null;
  out?: number;
  tpost?: number;
  tpreIdx?: number;
  env: { speed: number; vlz: number; pos: number[]; fwd?: number[]; ped?: number[]; near?: number; len?: number; post?: number[] | null; mail?: number[] };
  calls: Call[];
  mailOut?: number[];
}
const fx = readJson<{ cases: Case[] }>('./fixtures/aicar.json.gz');

const bits = new DataView(new ArrayBuffer(4));
const fb = (u: number): number => {
  bits.setUint32(0, u >>> 0, true);
  return bits.getFloat32(0, true);
};
const u32 = (f: number): number => {
  bits.setFloat32(0, f, true);
  return bits.getUint32(0, true);
};
const W = (sp: Sp, off: number): number => sp[String(off)] ?? 0;

function peerOf(sp: Sp): AiPeer {
  return {
    lapDist: fb(W(sp, 0x74)),
    lat: fb(W(sp, 0x7c)),
    recSpeed: fb(W(sp, 0x5c)),
    w84: fb(W(sp, 0x84)),
    w88: fb(W(sp, 0x88)),
    w94: fb(W(sp, 0x94)),
    w98: fb(W(sp, 0x98)),
    yawErr: fb(W(sp, 0x9c)),
    speed: fb(W(sp, 0x1c4)),
  };
}

function loadCar(c: Case): AiCar {
  const car = new AiCar();
  car.m.setUint32(0, 0, true);
  for (let o = 0; o < 0x200; o += 4) car.m.setUint32(o, 0, true);
  for (const [k, v] of Object.entries(c.pre)) car.m.setUint32(Number(k), v, true);
  car.ctrl.state = car.m.getInt32(0x1b4, true);
  car.ctrl.sub = car.m.getInt32(0x1b8, true);
  car.ctrl.timer = car.m.getFloat32(0x1bc, true);
  car.ctrl.prev = car.m.getFloat32(0x1c0, true);
  car.ctrl.v = car.m.getFloat32(0x1c4, true);
  return car;
}

function mockEnv(c: Case, peers: AiPeer[], store: { ped: number[]; out: number; mail: number[]; calls: number }): AiEnv {
  const q = c.calls.map((x) => x);
  const next = (kind: string): Call => {
    const e = q.shift();
    if (!e) throw new Error('env queue empty for ' + kind);
    if (e[0] !== kind) throw new Error(`env call order: expected ${e[0]}, got ${kind}`);
    store.calls++;
    return e;
  };
  const ped = c.env.ped ?? [0, 0, 0];
  const P = (i: number | undefined): AiPeer | null => (i ? peers[i - 1] : null);
  const ptrs = c.ptrs ?? [0, 0, 0, 0];
  const mail = c.env.mail ?? [u32(-1), 0];
  return {
    getSteer: () => ped[0],
    getThrottle: () => ped[1],
    getBrake: () => ped[2],
    setPedals: (s, t, b) => {
      store.ped = [s, t, b];
    },
    setHandbrake: () => {},
    speedKmh: () => c.env.speed,
    speedSigned: () => c.env.vlz,
    bodyPos: () => ({ x: c.env.pos[0], y: c.env.pos[1], z: c.env.pos[2] }),
    bodyFwd: () => ({ x: c.env.fwd![0], y: c.env.fwd![1], z: c.env.fwd![2] }),
    setOutByte: (v) => {
      store.out = v;
    },
    nearest: () => c.env.near!,
    segLength: () => c.env.len!,
    advance: (dist, d) => {
      const e = next('adv');
      expect(fb(e[1] as number)).toBeCloseTo(dist, 3);
      expect(fb(e[2] as number)).toBeCloseTo(d, 3);
      return fb(e[3] as number);
    },
    pointAt: (dist) => {
      const e = next('pt');
      expect(fb(e[1] as number)).toBeCloseTo(dist, 3);
      return { x: fb(e[2] as number), y: fb(e[3] as number), z: fb(e[4] as number) };
    },
    postAt: (): AiPost | null => {
      const p = c.env.post;
      return p ? { rec: p[0], curveSpd: p[1], curveCut: p[2], lookAhead: p[3], thresh: p[4], left: p[5], right: p[6] } : null;
    },
    carAhead: () => P(ptrs[0]) ?? P(ptrs[1]),
    carBehind: () => P(ptrs[2]) ?? P(ptrs[3]),
    mailStore: (d, l) => {
      store.mail = [u32(d), l];
    },
    mailDist: () => fb(mail[0]),
    mailLaps: () => mail[1],
  };
}

const got1b0 = (car: AiCar): number => car.m.getUint32(0x1b0, true);
const near = (a: number, b: number, rel = 0): boolean => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b)) || (Number.isNaN(a) && Number.isNaN(b));

/** Offsets compared as float32 (the rest of the block: ints / bytes, exact). */
const FLOAT_RANGES: [number, number][] = [[0x1c, 0x1c], [0x24, 0x24], [0x38, 0x4c - 4], [0x50, 0x50], [0x58, 0x58], [0x5c, 0x78 + 4], [0x74, 0x9c], [0xa4, 0xac], [0xb4, 0x1b0 - 4]];
const isFloatOff = (o: number): boolean => FLOAT_RANGES.some(([a, b]) => o >= a && o <= b);

describe('AI car FUN_00607280 / FUN_00607ae0 vs the executed exe', () => {
  it('has the committed fixture (>= 2000 cases of both functions)', () => {
    expect(fx.cases.length).toBeGreaterThanOrEqual(2000);
    expect(fx.cases.filter((c) => c.k === 'r').length).toBeGreaterThanOrEqual(500);
    expect(fx.cases.filter((c) => c.k === 'd').length).toBeGreaterThanOrEqual(1500);
  });

  it('FUN_00609550 reset zeroes the same words as the exe on random blocks (100 cases)', () => {
    let n = 0;
    for (const c of fx.cases) {
      if (c.k !== 'z') continue;
      n++;
      const car = loadCar(c);
      car.reset(null);
      for (let o = 0; o < 0x200; o += 4) {
        if (o >= 0x1b4 && o < 0x1e4) continue; // the controller block is a separate object here (checked below)
        if (o === 0xb0) continue;
        expect(car.m.getUint32(o, true), `+0x${o.toString(16)}`).toBe(W(c.post, o));
      }
      expect([car.ctrl.state, car.ctrl.sub, car.ctrl.timer, car.ctrl.prev, car.ctrl.v, car.ctrl.px, car.ctrl.hz]).toEqual([0, 0, 0, 0, 0, 0, 0]);
      for (let o = 0x1b4; o < 0x1e0; o += 4) expect(W(c.post, o)).toBe(0);
      expect(car.target).toBeNull();
    }
    expect(n).toBe(100);
  });

  for (const kind of ['r', 'd'] as const) {
    it(`${kind === 'r' ? 'FUN_00607280 refresh' : 'FUN_00607ae0 drive'} matches every case`, () => {
      const hist = new Map<string, number>();
      let bad = 0;
      let n = 0;
      const detail: string[] = [];
      for (const [ci, c] of fx.cases.entries()) {
        if (c.k !== kind) continue;
        n++;
        const car = loadCar(c);
        const peers = (c.peers ?? []).map(peerOf);
        if (c.k === 'd') car.target = c.tpreIdx ? peers[c.tpreIdx - 1] : null;
        const store = { ped: [NaN, NaN, NaN], out: -1, mail: c.env.mail ?? [0, 0], calls: 0 };
        const env = mockEnv(c, peers, store);
        const spy: number[][] = [];
        const origUpdate = car.ctrl.update.bind(car.ctrl);
        car.ctrl.update = (io, ts, rev, tx, ty, tz, dx, dy, dz, dt) => {
          spy.push([ts, rev, tx, ty, tz, dx, dy, dz, dt]);
          return origUpdate(io, ts, rev, tx, ty, tz, dx, dy, dz, dt);
        };
        let err: unknown = null;
        try {
          if (c.k === 'r') car.refresh(env, c.flag!);
          else car.update(env, c.dt!);
        } catch (e) {
          err = e;
        }
        const miss: string[] = [];
        if (err) miss.push('throw ' + String(err));
        else {
          for (let o = 0; o < 0x200; o += 4) {
            if (o >= 0x1b4 && o < 0x1e4) continue;
            if (o === 0xb0) continue;
            if (o === 0x1b0) {
              // the post pointer: a flag here (the exe stores the manager's record address)
              if ((got1b0(car) !== 0) !== (W(c.post, o) !== 0)) miss.push('+0x1b0 post presence');
              continue;
            }
            const want = W(c.post, o);
            const got = car.m.getUint32(o, true);
            const ok = isFloatOff(o) ? near(fb(got), fb(want)) : got === want;
            if (!ok) miss.push(`+0x${o.toString(16)} got ${isFloatOff(o) ? fb(got) : got} want ${isFloatOff(o) ? fb(want) : want}`);
          }
          // the controller block
          const cs = [W(c.post, 0x1b4) | 0, W(c.post, 0x1b8) | 0];
          if (c.k === 'd') {
            if (car.ctrl.state !== cs[0] || car.ctrl.sub !== cs[1]) miss.push(`ctrl state/sub ${car.ctrl.state}/${car.ctrl.sub} want ${cs[0]}/${cs[1]}`);
            if (!near(car.ctrl.timer, fb(W(c.post, 0x1bc)), 0)) miss.push(`ctrl timer ${car.ctrl.timer} want ${fb(W(c.post, 0x1bc))}`);
            if (!near(car.ctrl.prev, fb(W(c.post, 0x1c0)), 0)) miss.push(`ctrl prev`);
            const cv = [car.ctrl.v, car.ctrl.px, car.ctrl.py, car.ctrl.pz, car.ctrl.hx, car.ctrl.hy, car.ctrl.hz];
            [0x1c4, 0x1c8, 0x1cc, 0x1d0, 0x1d4, 0x1d8, 0x1dc].forEach((o, i) => {
              if (!near(cv[i], fb(W(c.post, o)), 0)) miss.push(`ctrl@0x${o.toString(16)} ${cv[i]} want ${fb(W(c.post, o))}`);
            });
            const ti = car.target === null ? 0 : peers.indexOf(car.target) + 1;
            if (ti !== c.tpost) miss.push(`target ${ti} want ${c.tpost}`);
            c.ped!.forEach((w, i) => {
              if (!near(store.ped[i], w, 0)) miss.push(`pedal${i} ${store.ped[i]} want ${w}`);
            });
            if (store.out !== c.out) miss.push(`outbyte ${store.out} want ${c.out}`);
            // the arguments the drive function hands to the controller FUN_007e0540 (target speed, point, direction, dt)
            if (!c.ctl || spy.length !== 1) miss.push('controller call count ' + spy.length);
            else {
              const names = ['targetSpeed', 'reverse', 'tx', 'ty', 'tz', 'dx', 'dy', 'dz', 'dt'];
              c.ctl.forEach((w, i) => {
                const want = i === 1 ? w : fb(w);
                if (!near(spy[0][i], want, 0)) miss.push(`ctlarg.${names[i]} ${spy[0][i]} want ${want}`);
              });
            }
          } else if (c.mailOut && (store.mail[0] !== c.mailOut[0] || store.mail[1] !== c.mailOut[1])) {
            miss.push(`mailbox ${store.mail} want ${c.mailOut}`);
          }
          if (store.calls !== c.calls.length) miss.push(`spline calls ${store.calls} want ${c.calls.length}`);
        }
        if (miss.length) {
          bad++;
          for (const m of miss) hist.set(m.split(' ')[0] + ' ' + m.split(' ')[1], (hist.get(m.split(' ')[0] + ' ' + m.split(' ')[1]) ?? 0) + 1);
          if (detail.length < 6) detail.push(`case ${ci}: ${miss.slice(0, 4).join('; ')}`);
        }
      }
      console.log(`${kind}: ${n} cases, ${bad} mismatching; first: ${detail.join(' | ')}; by field: ${JSON.stringify([...hist].sort((a, b) => b[1] - a[1]).slice(0, 12))}`);
      expect(bad).toBe(0);
    });
  }
});
