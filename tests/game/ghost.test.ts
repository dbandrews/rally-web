import { describe, expect, it } from 'vitest';
import { decodeGhost, encodeGhost, GHOST_HZ, GHOST_STEP_DIV, GhostRecorder, ghostDuration, sampleGhost } from '../../src/game/ghost';
import { PacenoteCaller } from '../../src/game/pacenotes';
import { MemoryStore, SafeStore } from '../../src/game/storage';
import { note } from './fakes';

describe('ghost', () => {
  it('samples every 4 physics steps (30 Hz)', () => {
    expect(GHOST_HZ).toBe(30);
    expect(GHOST_STEP_DIV).toBe(4);
  });

  it('records, interpolates, and survives an encode/decode round trip', () => {
    const r = new GhostRecorder();
    r.start();
    for (let i = 0; i < 61; i++) r.push({ x: i, y: 1, z: -2 * i }, { w: 1, x: 0, y: 0, z: 0 }, 0.1);
    const g = r.track();
    expect(g.count).toBe(61);
    expect(ghostDuration(g)).toBeCloseTo(2, 9);
    const p = sampleGhost(g, 0.5 + 1 / 60)!;
    expect(p.pos.x).toBeCloseTo(15.5, 4);
    expect(p.pos.z).toBeCloseTo(-31, 4);
    expect(sampleGhost(g, 99)!.pos.x).toBe(60);
    const back = decodeGhost(encodeGhost(g))!;
    expect(back.count).toBe(61);
    expect(Array.from(back.data)).toEqual(Array.from(g.data));
    expect(decodeGhost('garbage')).toBeNull();
    expect(decodeGhost(null)).toBeNull();
  });

  it('quaternion interpolation takes the short arc and stays normalised', () => {
    const r = new GhostRecorder();
    r.start();
    r.push({ x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0);
    r.push({ x: 0, y: 0, z: 0 }, { w: -0.9, x: 0, y: -Math.sqrt(1 - 0.81), z: 0 }, 0); // same as (0.9, 0, +0.436, 0)
    const q = sampleGhost(r.track(), 0.5 / 30)!.quat;
    expect(Math.hypot(q.w, q.x, q.y, q.z)).toBeCloseTo(1, 9);
    expect(q.w).toBeGreaterThan(0.9);
  });
});

describe('pacenote caller', () => {
  it('fires the last passed note once; skips notes jumped over', () => {
    const c = new PacenoteCaller();
    c.reset([note(300), note(100), note(200)]);
    expect(c.update(50, 0)).toBeNull();
    expect(c.update(100, 0)?.s).toBe(100);
    expect(c.update(150, 0)).toBeNull();
    expect(c.update(310, 0)?.s).toBe(300); // 200 was jumped over (teleport)
    expect(c.update(320, 0)).toBeNull();
    expect(c.upcoming(0, 2).map((n) => n.s)).toEqual([100, 200]);
  });

  it('lateral gate: |lateral| ≥ 20 m holds the note until back on the road', () => {
    const c = new PacenoteCaller();
    c.reset([note(100)]);
    expect(c.update(110, 20)).toBeNull();
    expect(c.update(115, -19.9)?.s).toBe(100);
  });

  it('markPlayedUpTo blocks replays', () => {
    const c = new PacenoteCaller();
    c.reset([note(100), note(200)]);
    c.markPlayedUpTo(150);
    expect(c.update(160, 0)).toBeNull();
    expect(c.update(210, 0)?.s).toBe(200);
  });
});

describe('storage', () => {
  it('SafeStore falls back to memory when the backing store throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const s = new SafeStore(broken);
    s.setItem('a', '1');
    expect(s.getItem('a')).toBe('1');
    s.removeItem('a');
    expect(s.getItem('a')).toBeNull();
    const m = new MemoryStore();
    const s2 = new SafeStore(m);
    s2.setItem('b', '2');
    expect(m.getItem('b')).toBe('2');
  });
});
