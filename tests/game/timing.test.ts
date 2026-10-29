import { describe, expect, it } from 'vitest';
import { buildGates, crossingTime, formatDelta, formatTime, wrapDelta } from '../../src/game/timing';
import { makeCircleStage, makeLineStage } from './fakes';

describe('timing gates', () => {
  it('point-to-point: checkpoints relative to the start, finish last', () => {
    const g = buildGates(makeLineStage({ startS: 10, finishS: 990, checkpoints: [250, 500, 750] }));
    expect(g.map((x) => x.kind)).toEqual(['checkpoint', 'checkpoint', 'checkpoint', 'finish']);
    expect(g.map((x) => x.dist)).toEqual([240, 490, 740, 980]);
    expect(g.map((x) => x.index)).toEqual([0, 1, 2, 3]);
  });

  it('checkpoints behind the start or beyond the finish are dropped', () => {
    const g = buildGates(makeLineStage({ startS: 300, finishS: 700, checkpoints: [250, 500, 750] }));
    expect(g.map((x) => x.kind)).toEqual(['checkpoint', 'finish']);
    expect(g[0].dist).toBe(200);
  });

  it('testpad has no gates', () => {
    expect(buildGates(makeLineStage({ discipline: 'testpad' }))).toEqual([]);
  });

  it('closed: per lap checkpoints + lap line, last line is the finish', () => {
    const st = makeCircleStage({ radius: 100, laps: 3 });
    const L = st.length;
    const g = buildGates(st);
    expect(g).toHaveLength(9);
    expect(g.map((x) => x.kind)).toEqual(['checkpoint', 'checkpoint', 'lap', 'checkpoint', 'checkpoint', 'lap', 'checkpoint', 'checkpoint', 'finish']);
    expect(g[2].dist).toBeCloseTo(L, 6);
    expect(g[8].dist).toBeCloseTo(3 * L, 6);
    expect(g[3].dist).toBeCloseTo(L + L / 3, 6);
    expect(g.map((x) => x.lap)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
  });

  it('closed with the grid shortly behind the lap line: first crossing only starts lap 1', () => {
    const st = makeCircleStage({ radius: 100, laps: 2, startS: 2 * Math.PI * 100 - 30, finishS: 0, checkpoints: [] });
    const g = buildGates(st);
    expect(g.map((x) => x.kind)).toEqual(['lap', 'finish']);
    expect(g[0].dist).toBeCloseTo(30 + st.length, 6);
  });

  it('wrapDelta and crossingTime', () => {
    expect(wrapDelta(5, 100)).toBe(5);
    expect(wrapDelta(-95, 100)).toBe(5);
    expect(wrapDelta(95, 100)).toBe(-5);
    // crossed 0.25 of the step before its end
    expect(crossingTime(10, 0.1, 99, 101, 100.5)).toBeCloseTo(10 - 0.025, 9);
    expect(crossingTime(10, 0.1, 100, 100, 100)).toBe(10);
  });

  it('formats times in m:ss.mmm and deltas with a sign', () => {
    expect(formatTime(83.4567)).toBe('1:23.457');
    expect(formatTime(5)).toBe('0:05.000');
    expect(formatTime(3725.5)).toBe('1:02:05.500');
    expect(formatTime(null)).toBe('-:--.---');
    expect(formatDelta(0.8449)).toBe('+0.845');
    expect(formatDelta(-1.2)).toBe('-1.200');
    expect(formatDelta(0)).toBe('±0.000');
  });
});
