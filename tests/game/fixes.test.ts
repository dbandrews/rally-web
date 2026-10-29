/**
 * tests/game/fixes.test.ts — game-side behaviour added in the review fixes: debug-teleport gate skipping (no
 * checkpoint events, NaN splits, untimed run), the start grid offset, the post-finish run-out controls, sector
 * deltas for the progress bar and the per-lap results table.
 */
import { describe, expect, it } from 'vitest';
import { DT } from '../../src/core/constants';
import type { RaceEvent } from '../../src/core/types';
import { runOutControls } from '../../src/game/driving';
import { RaceController } from '../../src/game/race';
import { MemoryStore } from '../../src/game/storage';
import { sectorDelta, timedLength } from '../../src/ui/hud';
import { resultRows } from '../../src/ui/menu';
import { FakeCar, makeLineStage } from './fakes';

function cruise(car: FakeCar, race: RaceController, v: number, n: number): RaceEvent[] {
  const ev: RaceEvent[] = [];
  for (let i = 0; i < n; i++) {
    car.place(0, car.pos.z - v * DT, 0, v);
    race.fixedUpdate(DT, car.telemetry());
    ev.push(...race.drainEvents());
  }
  return ev;
}

describe('debug teleport mid-run', () => {
  it('skips the gates it jumps over silently (NaN splits), marks the run untimed, times the next gate normally', () => {
    const stage = makeLineStage({ startS: 10, finishS: 410, checkpoints: [110, 210, 310] });
    const car = new FakeCar();
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    cruise(car, race, 20, 30);
    race.teleport(250, 0);
    const ev0 = race.drainEvents();
    expect(ev0.some((e) => e.type === 'checkpoint')).toBe(false);
    expect(race.state.untimed).toBe(true);
    expect(race.state.splits.length).toBe(2);
    expect(race.state.splits.every((t) => Number.isNaN(t))).toBe(true);
    expect(race.state.nextCheckpoint).toBe(2);
    // the next crossing (checkpoint 3 at s 310) is a real split with an event
    const ev = cruise(car, race, 20, Math.round(4 / DT));
    const cp = ev.filter((e) => e.type === 'checkpoint') as { index: number; time: number }[];
    expect(cp.map((e) => e.index)).toEqual([2]);
    expect(Number.isFinite(race.state.splits[2])).toBe(true);
    // a teleport never skips the finish
    race.teleport(405, 0);
    expect(race.state.phase).toBe('running');
  });
});

describe('start grid', () => {
  it('startGridBack puts the car that far behind the start line; the default (contract) is on the line', () => {
    const stage = makeLineStage({ startS: 40, finishS: 400, checkpoints: [] });
    const a = new FakeCar();
    new RaceController({ store: new MemoryStore() }).begin(stage, a, { countdown: false });
    expect(-a.pos.z).toBeCloseTo(40, 6);
    const b = new FakeCar();
    const race = new RaceController({ store: new MemoryStore(), startGridBack: 8 });
    race.begin(stage, b, { countdown: false });
    expect(-b.pos.z).toBeCloseTo(32, 6);
    race.startNow();
    const ev = cruise(b, race, 20, Math.round(20 / DT));
    const fin = ev.find((e) => e.type === 'finish') as { time: number };
    // 8 m of grid + 360 m timed distance at 20 m/s
    expect(fin.time).toBeCloseTo(368 / 20, 2);
  });
});

describe('post-finish run-out', () => {
  // 60 m of road left after the finish line
  const stage = makeLineStage({ startS: 10, finishS: 400, checkpoints: [], length: 460 });
  const tel = (kmh: number, lateral = 0) => ({ pos: { x: lateral, y: 0, z: -400 }, quat: { w: 1, x: 0, y: 0, z: 0 }, speedKmh: kmh, velLocal: { x: 0, y: 0, z: kmh / 3.6 } });
  it('no throttle, no handbrake at speed, a brake that fits the run-out; parks below 10 km/h', () => {
    const fast = runOutControls(tel(120), stage, { s: 400 });
    // 120 km/h in 48 m at 12 m/s² ≈ 0.96 → about full brake, still no handbrake
    expect(fast.brake).toBeGreaterThan(0.8);
    expect(fast.throttle).toBe(0);
    expect(fast.handbrake).toBe(0);
    expect(fast.brake).toBeGreaterThan(0.25);
    expect(fast.brake).toBeLessThanOrEqual(1);
    const slow = runOutControls(tel(60), stage, { s: 400 });
    expect(slow.brake).toBeLessThan(fast.brake);
    const park = runOutControls(tel(6), stage, { s: 400 });
    expect(park.handbrake).toBe(1);
    expect(park.brake).toBe(0);
  });
  it('steers back toward the centre line', () => {
    expect(runOutControls(tel(80, 3), stage, { s: 400 }).steer).toBeLessThan(0); // right of the line → steer left
    expect(runOutControls(tel(80, -3), stage, { s: 400 }).steer).toBeGreaterThan(0);
  });
});

describe('HUD / results timing helpers', () => {
  it('sectorDelta: the time gained or lost inside one sector, not the cumulative delta', () => {
    const best = [30, 60, 90];
    const run = [32, 70, 99]; // cumulative +2, +10, +9: sector 3 was 1 s FASTER
    expect(sectorDelta(run, best, 0)).toBeCloseTo(2, 9);
    expect(sectorDelta(run, best, 1)).toBeCloseTo(8, 9);
    expect(sectorDelta(run, best, 2)).toBeCloseTo(-1, 9);
    expect(sectorDelta(run, null, 1)).toBeNull();
    expect(sectorDelta([Number.NaN, 70], best, 1)).toBeNull();
  });
  it('timedLength: start line to finish for stages, one lap for circuits', () => {
    expect(timedLength({ closed: false, length: 3727, startS: 40, finishS: 3647 })).toBe(3607);
    expect(timedLength({ closed: true, length: 1041, startS: 0, finishS: 0 })).toBe(1041);
  });
  it('resultRows: lap races list one row per lap with the lap time and highlight the best lap', () => {
    const html = resultRows({ splits: [20, 40, 82.7, 101, 122, 145.6, 165, 186, 208.6], prevSplits: null, closed: true, laps: 3 });
    const rows = html.match(/<tr[^>]*>/g)!;
    expect(rows.length).toBe(4); // header + 3 laps
    expect(html).toContain('1:02.900'); // lap 2 = 145.6 - 82.7
    expect(html).toContain('1:03.000'); // lap 3
    expect(html).toContain('1:22.700'); // lap 1
    expect((html.match(/rw-bestlap/g) ?? []).length).toBe(1);
    expect(html.indexOf('rw-bestlap')).toBeLessThan(html.indexOf('1:02.900'));
    const p2p = resultRows({ splits: [30, 60, 90], prevSplits: [31, 59, 91], closed: false, laps: 1 });
    expect(p2p).toContain('Split 1');
    expect(p2p).toContain('Finish');
    expect(p2p).toContain('−1.000');
  });
});
