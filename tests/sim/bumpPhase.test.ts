/**
 * tests/sim/bumpPhase.test.ts — surfaceSink's bump phase u = x - trunc(x / 0.2f) * 0.2f (FUN_006cfad0, asm 0x6cfad0-0x6cfb21).
 * bumpPhaseCases.json = [[x, u], ...] produced by EXECUTING the exe function in unicorn (FPCW 0x7F, float32 x and step 0x3e4ccccd):
 * float32 x in [1700, 2100] (the W+0x94 / W+0x9c ray-end coordinates around 1770), the float32 neighbours of the 0.2 grid, and
 * x < 0 (the negative branch with the constant -1.0 at 0x8065a0). Regenerate: research/tools/emu_step/bump_phase.py.
 */
import { describe, expect, it } from 'vitest';
import { bumpPhase } from '../../src/sim/car';
import cases from './fixtures/bumpPhaseCases.json';

describe('bumpPhase = executed FUN_006cfad0(x, 0.2f)', () => {
  const rows = cases as [number, number][];
  it('positive x (incl. the float32 neighbours of the 0.2 grid): bit for bit', () => {
    const pos = rows.filter(([x]) => x >= 0);
    expect(pos.length).toBeGreaterThan(500);
    for (const [x, u] of pos) expect(bumpPhase(x), `x=${x}`).toBe(u);
  });
  it('negative x (constant -1.0 branch)', () => {
    const neg = rows.filter(([x]) => x < 0);
    expect(neg.length).toBeGreaterThan(100);
    for (const [x, u] of neg) expect(bumpPhase(x), `x=${x}`).toBe(u);
  });
  it('is not the exact fmod: at x ~ 1770 the float32 phase differs by up to ~1e-4', () => {
    const exact = (x: number) => ((x % 0.2) + 0.2) % 0.2;
    const worst = Math.max(...rows.filter(([x]) => x > 1700).map(([x]) => Math.abs(Math.min(Math.abs(bumpPhase(x) - exact(x)), 0.2 - Math.abs(bumpPhase(x) - exact(x))))));
    expect(worst).toBeGreaterThan(1e-5);
  });
});
