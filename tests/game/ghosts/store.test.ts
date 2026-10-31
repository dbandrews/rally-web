/**
 * Saved-ghost store (src/game/ghosts/store.ts): the IndexedDB backend against a minimal in-test fake of the IndexedDB
 * API (only what the store uses), the memory fallback, the name rules (names.ts) and the team index helpers (team.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GHOST_FRAME_BYTES, fileTimeBytes, parseGhost, type GhostFile } from '../../../src/game/ghosts/format';
import { MAX_GHOST_NAME, checkGhostName } from '../../../src/game/ghosts/names';
import { IndexedDbGhostBackend, MemoryGhostBackend, UserGhostStore, userGhostId, type SavedGhostRecord } from '../../../src/game/ghosts/store';
import { _setAssetFetchForTests } from '../../../src/core/assets';
import { resetTeamGhostCache, teamFileOfId, teamFileStage, teamGhostId, teamGhostsOf, loadTeamIndex, cachedTeamGhost } from '../../../src/game/ghosts/team';

/** Just enough IndexedDB: one database, object stores keyed by `keyPath`, async requests. */
class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}
function fakeIndexedDB(opts: { failOpen?: boolean; failPut?: boolean } = {}) {
  const stores = new Map<string, Map<string, unknown>>();
  let opens = 0;
  const later = (fn: () => void) => void Promise.resolve().then(fn);
  const done = <T>(value: T): FakeRequest<T> => {
    const r = new FakeRequest<T>();
    later(() => {
      r.result = value;
      r.onsuccess?.();
    });
    return r;
  };
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => {
      stores.set(n, new Map());
    },
    transaction: (name: string) => {
      const tx = {
        error: null as Error | null,
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        // the transaction commits after the request; a quota error aborts it (the request itself succeeded)
        finish: (ok: boolean) =>
          later(() => {
            later(() => {
              if (ok) tx.oncomplete?.();
              else {
                tx.error = new Error('QuotaExceededError');
                tx.onabort?.();
              }
            });
          }),
        objectStore: () => {
          const m = stores.get(name)!;
          return {
            getAll: () => done([...m.values()]),
            get: (id: string) => done(m.get(id)),
            put: (rec: { id: string }) => {
              if (opts.failPut) tx.finish(false);
              else (m.set(rec.id, rec), tx.finish(true));
              return done(rec.id);
            },
            delete: (id: string) => (m.delete(id), tx.finish(true), done(undefined)),
          };
        },
      };
      return tx;
    },
  };
  const factory = {
    open: () => {
      opens++;
      if (opts.failOpen) throw new Error('SecurityError');
      const r = new FakeRequest<typeof db>();
      later(() => {
        r.result = db;
        r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  return { factory: factory as unknown as IDBFactory, stores, opens: () => opens };
}

const file = (car = 'Micra', time = 20): GhostFile => ({
  version: '3.0',
  carTemplate: `${car}Ghost`,
  ghostName: 'tmp',
  profileTemplate: 'tmp',
  profileName: 'tmp',
  date: fileTimeBytes(1_700_000_000_000),
  splits: [Math.fround(time / 2), Math.fround(time)],
  initial: new Float32Array([1, 2, 3, 0, 0, 0, 1, 0, 0]),
  frames: new Uint8Array(GHOST_FRAME_BYTES * 4).map((_, i) => (i % GHOST_FRAME_BYTES === 0 ? 0 : (i * 7) & 255)),
  frameCount: 4,
  trailer: new Uint8Array(0),
});

describe('UserGhostStore on IndexedDB', () => {
  it('save / list / load / has / delete round trip through the object store', async () => {
    const fake = fakeIndexedDB();
    const s = new UserGhostStore(new IndexedDbGhostBackend(fake.factory));
    expect(s.kind).toBe('indexeddb');
    const r = await s.save('corsica-1-f', file('Micra', 91.5), 'First Run');
    expect(r).toEqual({ ok: true, id: userGhostId('corsica-1-f', 'Micra', 'first run') });
    await s.save('corsica-1-f', file('Corolla', 90), 'Other car');
    await s.save('kenya-1-f', file('Micra', 100), 'Other stage');
    const list = await s.list('corsica-1-f');
    expect(list.map((x) => x.name).sort()).toEqual(['First Run', 'Other car']);
    expect(list.every((x) => x.stageId === 'corsica-1-f' && x.bytes.length > 0)).toBe(true);
    const rec = list.find((x) => x.name === 'First Run') as SavedGhostRecord;
    expect(rec.car).toBe('Micra');
    expect(rec.time).toBeCloseTo(91.5, 3);
    const g = await s.load(rec.id);
    expect(g?.ghostName).toBe('First Run');
    expect(g?.version).toBe('3.0');
    expect(await s.has('corsica-1-f', 'Micra', 'FIRST RUN')).toBe(true);
    expect(await s.has('corsica-1-f', 'Corolla', 'First Run')).toBe(false);
    await s.delete(rec.id);
    expect(await s.load(rec.id)).toBeNull();
    expect((await s.list('corsica-1-f')).length).toBe(1);
    expect(s.degraded).toBe(false);
  });

  it('saving the same (stage, car, name) replaces the record', async () => {
    const s = new UserGhostStore(new IndexedDbGhostBackend(fakeIndexedDB().factory));
    await s.save('s', file('Micra', 50), 'Same');
    await s.save('s', file('Micra', 40), 'same');
    const l = await s.list('s');
    expect(l.length).toBe(1);
    expect(l[0].time).toBeCloseTo(40, 3);
    expect(l[0].name).toBe('same');
  });

  it('refuses invalid names without touching the store', async () => {
    const fake = fakeIndexedDB();
    const s = new UserGhostStore(new IndexedDbGhostBackend(fake.factory));
    for (const bad of ['', ' ', 'a:b', 'x|y', 'LPT1', 'a'.repeat(MAX_GHOST_NAME + 1)]) expect(await s.save('s', file(), bad)).toEqual({ ok: false, reason: 'invalid' });
    expect(fake.stores.get('ghosts')?.size ?? 0).toBe(0);
  });

  it('a failing write (quota) reports not-enough-space: no silent memory fallback, earlier records stay listed', async () => {
    const fake = fakeIndexedDB();
    const s = new UserGhostStore(new IndexedDbGhostBackend(fake.factory));
    expect((await s.save('s', file(), 'kept')).ok).toBe(true);
    const failing = fakeIndexedDB({ failPut: true });
    const s2 = new UserGhostStore(new IndexedDbGhostBackend(failing.factory));
    expect(await s2.save('s', file(), 'x')).toEqual({ ok: false, reason: 'space' });
    expect(s2.degraded).toBe(false);
    expect(s2.kind).toBe('indexeddb');
    expect((await s2.list('s')).length).toBe(0);
    expect(failing.stores.get('ghosts')?.size ?? 0).toBe(0);
    expect((await s.list('s')).map((r) => r.name)).toEqual(['kept']);
  });

  it('IndexedDB that cannot be opened falls back to memory on first use', async () => {
    const s = new UserGhostStore(new IndexedDbGhostBackend(fakeIndexedDB({ failOpen: true }).factory));
    expect((await s.save('s', file(), 'y')).ok).toBe(true);
    expect(s.degraded).toBe(true);
    expect((await s.list('s')).map((x) => x.name)).toEqual(['y']);
  });

  it('without IndexedDB (node) the default store is the memory fallback', async () => {
    const s = new UserGhostStore();
    expect(s.kind).toBe('memory');
    expect((await s.save('s', file(), 'z')).ok).toBe(true);
  });

  it('corrupt records load as null (the original: "Unable to load ghost file")', async () => {
    const b = new MemoryGhostBackend();
    const s = new UserGhostStore(b);
    await b.put({ id: 'user:s/Micra/bad', stageId: 's', car: 'Micra', name: 'bad', time: 1, date: 1, bytes: new Uint8Array([1, 2, 3]) });
    expect(await s.load('user:s/Micra/bad')).toBeNull();
    expect(await s.load('user:s/Micra/missing')).toBeNull();
    const ok = await s.save('s', file(), 'good');
    expect(ok.ok).toBe(true);
    const rec = (await s.list('s')).find((x) => x.name === 'good')!;
    expect(parseGhost(rec.bytes).frameCount).toBe(4);
  });
});

describe('team ghost index retry', () => {
  afterEach(() => {
    _setAssetFetchForTests(null);
    resetTeamGhostCache();
  });
  it('a failed index fetch is retried by the next call (not cached for the session)', async () => {
    resetTeamGhostCache();
    let fail = true;
    const idx = { version: 1, ghosts: [{ file: 'KikiW_Corsica1f', stageId: 'corsica-1-f', time: 100 }], heights: {} };
    const manifest = { version: 1, stages: {}, cars: [], carParts: {}, global: ['ghosts'], audio: false, textures: 0 };
    _setAssetFetchForTests(async (url: string) => {
      const rel = url.split('?')[0].replace(/^.*?assets\//, '');
      if (rel === 'manifest.json') return new Response(JSON.stringify(manifest), { status: 200 });
      if (rel === 'global/ghosts.json') return fail ? new Response('boom', { status: 500 }) : new Response(JSON.stringify(idx), { status: 200 });
      return new Response('nf', { status: 404 });
    });
    expect(await loadTeamIndex()).toBeNull();
    fail = false;
    expect((await loadTeamIndex())?.ghosts).toHaveLength(1);
  });
});

describe('ghost names', () => {
  it('trims, collapses spaces, keys case-insensitively', () => {
    expect(checkGhostName('  Fast   Lap ')).toEqual({ ok: true, name: 'Fast Lap', key: 'fast lap' });
    expect(checkGhostName('')).toEqual({ ok: false, reason: 'empty' });
    expect(checkGhostName('a'.repeat(MAX_GHOST_NAME))).toMatchObject({ ok: true });
    expect(checkGhostName('a'.repeat(MAX_GHOST_NAME + 1))).toEqual({ ok: false, reason: 'long' });
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\tb', 'con', 'NUL', 'com1', 'aux.txt', 'name.', 'x\u0007']) {
      expect(checkGhostName(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: 'invalid' });
    }
    // names from the shipped files are valid
    for (const n of ['KIKI1', 'Ghost', 'scav1:18'.replace(':', ' '), 'Barbie MagicHair', 'M2', '206_3']) expect(checkGhostName(n).ok, n).toBe(true);
  });
});

describe('team ghost helpers without the asset part', () => {
  it('the index is empty (no manifest in node), ids round trip, nothing is cached', async () => {
    resetTeamGhostCache();
    expect(await loadTeamIndex()).toBeNull();
    expect(await teamGhostsOf('corsica-1-f')).toEqual([]);
    expect(teamFileOfId(teamGhostId('KikiW_Corsica1f'))).toBe('KikiW_Corsica1f');
    expect(teamFileOfId('user:x')).toBeNull();
    expect(cachedTeamGhost('KikiW_Corsica1f')).toBeNull();
    expect(teamFileStage('KikiW_Corsica1f')).toBe('corsica-1-f');
  });
});
