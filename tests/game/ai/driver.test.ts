/**
 * createAiDriver (src/game/ai/driver.ts): the contract behaviour that needs no assets (procedural data, a ported stage's
 * spline), the mailbox rubber band fed by the leader or the AiTimes schedule, determinism, the field's lapDist convention.
 */
import { describe, expect, it } from 'vitest';
import { DT } from '../../../src/core/constants';
import type { CarTelemetry } from '../../../src/core/types';
import { createAiDriver, type AiDriverInit, type AiDriverInputX, type AiOtherCar } from '../../../src/game/ai/driver';
import { buildStage } from '../../../src/world/stages';

const SPEC = { id: 'ai1', origCar: 'Micra', archetype: 'awd_wrc' as const, name: 'x', skill: 1, tyreScale: 1, gridIndex: 1, slotBase: 0 };

function setup(id: string, schedule: AiDriverInit['schedule'] = null) {
  const built = buildStage(id, 1);
  const stage = built.stage;
  const data = { stageId: id, posts: [{ lapDist: 0, recSpeed: 250, curveSpdScale: 1.5, curveCut: 0.25, lookAheadDist: 6, thresholdScale: 1 }] };
  const driver = createAiDriver({ spec: SPEC, stage, world: built.world, data, schedule });
  /** A telemetry of a car standing on the road at spline distance s (sim space), heading along the road. */
  const telAt = (s: number, speedKmh: number, lateral = 0): CarTelemetry => {
    const p = stage.pointAt(s);
    const t = stage.tangentAt(s);
    const right = { x: -t.z, y: 0, z: t.x }; // three space: right of the travel direction (cross(t, up))
    const r = Math.hypot(right.x, right.z) || 1;
    const pos3 = { x: p.x + (right.x / r) * lateral, y: p.y + 0.4, z: p.z + (right.z / r) * lateral };
    const pos = { x: pos3.x, y: pos3.y, z: -pos3.z };
    const f = { x: t.x, y: 0, z: -t.z };
    const n = Math.hypot(f.x, f.z) || 1;
    // sim-space quaternion looking along f (yaw about +y): body forward = +z
    const yaw = Math.atan2(f.x / n, f.z / n);
    return {
      speedKmh,
      posSim: pos,
      quatSim: { w: Math.cos(yaw / 2), x: 0, y: Math.sin(yaw / 2), z: 0 },
      velLocal: { x: 0, y: 0, z: speedKmh / 3.6 },
    } as unknown as CarTelemetry;
  };
  const input = (s: number, speedKmh: number, o: Partial<AiDriverInputX> = {}, lateral = 0, others: AiOtherCar[] = []): AiDriverInputX => ({
    dt: DT,
    self: telAt(s, speedKmh, lateral),
    s,
    lateral,
    lapDist: s - stage.startS,
    others,
    raceTime: 10,
    running: true,
    ...o,
  });
  return { stage, driver, telAt, input };
}

describe('createAiDriver', () => {
  it('is the ported driver and returns parked controls while the race is not running', () => {
    const { driver, input } = setup('rallycross-1-f');
    expect(driver.placeholder).toBe(false);
    const c = driver.update(input(100, 0, { running: false }));
    expect(c).toMatchObject({ steer: 0, throttle: 0, brake: 0, handbrake: 1 });
  });

  it('drives: finite pedals in range, handbrake off, throttle on a straight, deterministic', () => {
    const run = () => {
      const { driver, input, stage } = setup('rallycross-1-f');
      const out: number[] = [];
      for (let i = 0; i < 300; i++) {
        const s = stage.startS + i * 0.1;
        const c = driver.update(input(s, 40 + i * 0.05));
        out.push(c.steer, c.throttle, c.brake);
        expect(c.handbrake).toBe(0);
        expect(Math.abs(c.steer)).toBeLessThanOrEqual(1);
        expect(c.throttle).toBeGreaterThanOrEqual(0);
        expect(c.throttle).toBeLessThanOrEqual(1);
        expect(c.brake).toBeGreaterThanOrEqual(0);
        expect(c.brake).toBeLessThanOrEqual(1);
      }
      return out;
    };
    const a = run();
    expect(a.every(Number.isFinite)).toBe(true);
    expect(a.slice(-30).some((x, i) => i % 3 === 1 && x > 0)).toBe(true); // it accelerates
    expect(run()).toEqual(a);
  });

  it('reset restores the initial behaviour', () => {
    const { driver, input, stage } = setup('rallycross-1-f');
    const first = driver.update(input(stage.startS, 20)).steer;
    for (let i = 1; i < 50; i++) driver.update(input(stage.startS + i * 0.2, 25));
    driver.reset();
    expect(driver.update(input(stage.startS, 20)).steer).toBe(first);
  });

  it('the mailbox rubber band: the leader far behind -> curveSpd x0.65 / 0.75 / 0.85, no leader -> none', () => {
    const { driver, input, stage } = setup('rallycross-1-f');
    const L = stage.length;
    const base = (lead?: number) => {
      driver.reset();
      driver.update(input(1500, 60, { lapDist: 1500 - stage.startS, leaderLapDist: lead }));
      return driver.debug().curveSpd as number;
    };
    const none = base(undefined);
    expect(none).toBeCloseTo(1.5, 4);
    const me = 1500 - stage.startS; // metres from the start line
    expect(base(me - 900) / none).toBeCloseTo(0.65, 3);
    expect(base(me - 500) / none).toBeCloseTo(0.75, 3);
    expect(base(me - 250) / none).toBeCloseTo(0.85, 3);
    expect(base(me - 100) / none).toBeCloseTo(1, 5);
    expect(base(me + 900) / none).toBeCloseTo(1, 5); // far behind the leader: no cut
    expect(L).toBeGreaterThan(1000);
  });

  it('the AiTimes schedule feeds the mailbox when there is no leader (piecewise linear in the race time)', () => {
    const { stage } = setup('rallycross-1-f');
    // 5 laps, 2 splits per lap (one checkpoint + the lap end), total 250 s
    const splits = Array.from({ length: 10 }, (_, k) => (k + 1) * 25);
    const { driver, input } = setup('rallycross-1-f', { laps: 5, splits });
    driver.update(input(stage.startS + 5, 40, { raceTime: 125, lapDist: 5 })); // t = 125 s: half way through the race
    const d = driver.debug();
    const abs = (d.mailLaps as number) * stage.length + (d.mailDist as number); // absolute scheduled position
    // t = 125 s = the split of the first checkpoint of lap 3 (splits every 25 s, 2 per lap): 2 laps + the checkpoint's distance
    expect(abs - stage.startS).toBeCloseTo(2 * stage.length + (stage.checkpoints[0] - stage.startS), 0);
    // no schedule, no leader: mailbox off
    const b = setup('rallycross-1-f');
    b.driver.update(b.input(stage.startS + 5, 40));
    expect(b.driver.debug().mailDist).toBe(-1);
  });
});

describe('samples without a post (index -1)', () => {
  it('a -1 sample falls back to curveSpd 1.0: the in-place rubber-band cuts and the skill multiply never compound', () => {
    const built = buildStage('rallycross-1-f', 1);
    const stage = built.stage;
    const data = { stageId: 'rallycross-1-f', posts: [{ lapDist: 0, recSpeed: 250, curveSpdScale: 1.5, curveCut: 0.25, lookAheadDist: 6, thresholdScale: 1 }] };
    const n = Math.ceil(stage.length / 5) + 2;
    const samples = {
      n,
      step: 5,
      dist: Float32Array.from({ length: n }, (_, i) => i * 5),
      left: new Float32Array(n).fill(6),
      right: new Float32Array(n).fill(6),
      post: new Int16Array(n).fill(-1), // a stage that has posts, but none reaches these samples
    };
    const driver = createAiDriver({ spec: { ...SPEC, skill: 0.9 }, stage, world: built.world, data: { ...data, samples } as never, schedule: null });
    const s = stage.startS + 1500;
    const p = stage.pointAt(s);
    const t = stage.tangentAt(s);
    const yaw = Math.atan2(t.x, -t.z);
    const self = {
      speedKmh: 60,
      posSim: { x: p.x, y: p.y + 0.4, z: -p.z },
      quatSim: { w: Math.cos(yaw / 2), x: 0, y: Math.sin(yaw / 2), z: 0 },
      velLocal: { x: 0, y: 0, z: 60 / 3.6 },
    } as unknown as CarTelemetry;
    const seen: number[] = [];
    for (let i = 0; i < 400; i++) {
      // the mailbox car 900 m away on the cutting side (as the rubber band test above): the x0.65 cut applies on every call
      driver.update({ dt: DT, self, s, lateral: 0, lapDist: 1500, others: [], raceTime: 10, running: true, leaderLapDist: 600 } as AiDriverInputX);
      seen.push(driver.debug().curveSpd as number);
    }
    // 1.0 (default) x 0.65 (cut) x 0.9 (skill), identical on every call and nowhere near zero
    expect(seen[0]).toBeCloseTo(0.585, 3);
    expect(seen[399]).toBeCloseTo(seen[0], 6);
  });
});

describe('createAiDriver cost', () => {
  it('one update (refresh + drive) stays far below the 8.3 ms substep budget', () => {
    const { driver, input, stage } = setup('rallycross-1-f');
    const others: AiOtherCar[] = [0, 1, 2].map((k) => ({ id: `o${k}`, isPlayer: k === 0, pos: stage.pointAt(stage.startS + 30 + 20 * k), speedKmh: 60, s: stage.startS + 30 + 20 * k, lateral: 1, halfWidth: 1 }));
    for (let i = 0; i < 500; i++) driver.update(input(stage.startS + i * 0.1, 60, {}, 0.5, others)); // warm up
    const n = 20000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) driver.update(input(stage.startS + 50 + (i % 500) * 0.1, 60, {}, 0.5, others));
    const us = ((performance.now() - t0) / n) * 1000;
    console.log(`AI driver update: ${us.toFixed(1)} us (3 other cars)`);
    expect(us).toBeLessThan(400);
  });
});
