import { describe, expect, it } from 'vitest';
import { PacenoteCaller } from '../../src/game/pacenotes';
import { MemoryStore, SafeStore } from '../../src/game/storage';
import { note } from './fakes';

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

  it('lateral gate: a note passed ≥ 20 m off the line is marked played and lost (FUN_0074b620)', () => {
    const c = new PacenoteCaller();
    c.reset([note(100), note(200)]);
    expect(c.update(110, 20)).toBeNull();
    expect(c.isPlayed(0)).toBe(true);
    expect(c.update(115, -19.9)).toBeNull();
    expect(c.update(205, -19.9)?.s).toBe(200);
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
