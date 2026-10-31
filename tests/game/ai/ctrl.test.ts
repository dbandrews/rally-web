/**
 * AI low-level controller FUN_007e0540: the TS port vs the ORIGINAL x87 function executed in unicorn
 * (research/tools/ai_ctrl_fixture.py -> fixtures/ctrl.json: 6000 vectors, every state / sub-state, the throttle/brake
 * band edges, reverse, dt = 0, the dead-band edges). Acceptance: max |delta| <= 1e-6 on steer/throttle/brake/timer,
 * identical state/sub/out byte.
 */
import { describe, expect, it } from 'vitest';
import { AiController } from '../../../src/game/ai/ctrl';
import { readJson } from './nodefs';

const f32 = Math.fround; // the fixture stores 9 significant digits of each float32
const fx = readJson<{ cases: { c: number[]; a: number[]; o: number[]; c2: number[] }[] }>('./fixtures/ctrl.json.gz');

describe('AI controller FUN_007e0540 vs the executed exe', () => {
  it('has the committed fixture (>= 5000 vectors)', () => {
    expect(fx.cases.length).toBeGreaterThanOrEqual(5000);
  });

  it('matches every vector to <= 1e-6', () => {
    const ctl = new AiController();
    let worst = 0;
    let bad = 0;
    const seen = new Set<string>();
    for (const [i, cs] of fx.cases.entries()) {
      const [state, sub, timer, prev, v, px, py, pz, hx, hy, hz] = cs.c;
      ctl.state = state;
      ctl.sub = sub;
      ctl.timer = f32(timer);
      ctl.prev = f32(prev);
      ctl.setInputs(v, px, py, pz, hx, hy, hz);
      const io = { steer: f32(cs.a[0]), thr: f32(cs.a[1]), brk: f32(cs.a[2]) };
      const out = ctl.update(io, cs.a[3], cs.a[4], cs.a[5], cs.a[6], cs.a[7], cs.a[8], cs.a[9], cs.a[10], cs.a[11]);
      const d = Math.max(
        Math.abs(io.steer - cs.o[0]),
        Math.abs(io.thr - cs.o[1]),
        Math.abs(io.brk - cs.o[2]),
        Math.abs(ctl.timer - cs.c2[2]),
        Math.abs(ctl.prev - cs.c2[3]),
      );
      worst = Math.max(worst, d);
      seen.add(`${state}/${sub}->${ctl.state}/${ctl.sub}`);
      if (d > 1e-6 || out !== cs.o[3] || ctl.state !== cs.c2[0] || ctl.sub !== cs.c2[1]) {
        bad++;
        if (bad <= 5) console.log('MISMATCH', i, JSON.stringify(cs), JSON.stringify({ steer: io.steer, thr: io.thr, brk: io.brk, out, state: ctl.state, sub: ctl.sub, timer: ctl.timer }));
      }
    }
    console.log(`ctrl: ${fx.cases.length} vectors, ${bad} mismatches, worst |delta| ${worst.toExponential(2)}, ${seen.size} state transitions`);
    expect(bad).toBe(0);
    expect(worst).toBeLessThanOrEqual(1e-6);
    // the suite really exercises the machine: drive, three-point turn (all sub-states), stop, stopped
    for (const t of ['0/0->0/0', '0/0->1/0', '0/0->2/0', '1/1->1/2', '1/3->5/0', '2/0->5/0', '5/0->0/0']) expect(seen.has(t), t).toBe(true);
  });
});
