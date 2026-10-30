// tests/render/origTextures.test.ts — TextureStore / TextureScope reference handling (src/render/orig/textures.ts) and
// the OrigEffectsSystem stage-load race (src/render/orig/effects.ts): a holder releases exactly the entry it acquired
// (a failed load never frees a later successful one), unreferenced textures stay in the idle pool for a restart /
// re-add, and a superseded effects load that fails leaves the newer stage's effects alone. JS decode path, no GL.
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { OrigEffectsSystem } from '../../src/render/orig/effects';
import { RTEX_FORMAT, encodeRtex } from '../../src/render/orig/rtex';
import { TextureStore } from '../../src/render/orig/textures';
import { BUILT_ASSETS_DIR, builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';

const FILE = encodeRtex({ format: RTEX_FORMAT.RGBA8, flags: 0, width: 2, height: 2, depth: 1, levels: [new Uint8Array(16).fill(7)], palette: null, source: 2, sourceKind: 1 });

/** A store over an in-memory loader: `fail` ids reject (transient), every load is counted per id. */
function makeStore(): { store: TextureStore; loads: Map<string, number>; fail: Set<string> } {
  const loads = new Map<string, number>();
  const fail = new Set<string>();
  const store = new TextureStore({} as THREE.WebGLRenderer, {
    s3tc: false,
    load: async (id) => {
      loads.set(id, (loads.get(id) ?? 0) + 1);
      if (fail.has(id)) throw new Error('transient 503');
      return FILE.slice().buffer;
    },
  });
  return { store, loads, fail };
}

function watchDispose(t: THREE.Texture): { disposed: boolean } {
  const w = { disposed: false };
  t.addEventListener('dispose', () => (w.disposed = true));
  return w;
}

describe('TextureStore reference handling', () => {
  it('a scope whose load failed never releases the texture another holder acquired later', async () => {
    const { store, fail } = makeStore();
    store.idleBudget = 0; // free unreferenced textures at once (the pre-pool behaviour)
    fail.add('x');
    const a = store.scope();
    await expect(a.get('x')).rejects.toThrow('transient');
    fail.delete('x');
    const b = store.scope();
    const tex = await b.get('x');
    const w = watchDispose(tex);
    a.dispose();
    expect(w.disposed).toBe(false);
    expect(store.stats().textures).toBe(1);
    b.dispose();
    expect(w.disposed).toBe(true);
    expect(store.stats().textures).toBe(0);
  });

  it('a retry in the same scope after a failure holds the new texture (not released on acquire)', async () => {
    const { store, fail } = makeStore();
    store.idleBudget = 0;
    fail.add('y');
    const s = store.scope();
    await expect(s.get('y')).rejects.toThrow('transient');
    fail.delete('y');
    const tex = await s.get('y');
    const w = watchDispose(tex);
    expect(store.stats().textures).toBe(1);
    expect(w.disposed).toBe(false);
    s.dispose();
    expect(w.disposed).toBe(true);
  });

  it('pinned (unscoped) gets follow the same rule', async () => {
    const { store, fail } = makeStore();
    store.idleBudget = 0;
    fail.add('p');
    await expect(store.get('p')).rejects.toThrow('transient');
    fail.delete('p');
    const tex = await store.get('p');
    expect(await store.get('p')).toBe(tex); // one pin per entry
    expect(store.stats().textures).toBe(1);
  });

  it('idle pool: a released texture is reused by the next acquire (restart / re-add) without a reload', async () => {
    const { store, loads } = makeStore();
    const gen = store.beginGeneration();
    const a = store.scope();
    const t1 = await a.get('z');
    const w = watchDispose(t1);
    a.dispose();
    expect(w.disposed).toBe(false);
    expect(store.stats()).toMatchObject({ textures: 0, idle: 1 });
    expect(store.stats().idleBytes).toBe(16);
    const b = store.scope();
    expect(await b.get('z')).toBe(t1);
    expect(loads.get('z')).toBe(1);
    expect(store.stats()).toMatchObject({ textures: 1, idle: 0, idleBytes: 0 });
    // released in this generation: survives flushIdle(gen); freed by the next load's flush
    b.dispose();
    store.flushIdle(gen);
    expect(w.disposed).toBe(false);
    store.flushIdle(store.beginGeneration());
    expect(w.disposed).toBe(true);
    expect(store.stats()).toMatchObject({ textures: 0, idle: 0, idleBytes: 0, files: 0 });
  });

  it('idle pool: oldest entries are evicted beyond the byte budget', async () => {
    const { store } = makeStore();
    store.idleBudget = 40; // two 16-byte textures fit, a third evicts the oldest
    const s = store.scope();
    const ts = await Promise.all(['a', 'b', 'c'].map((id) => s.get(id)));
    const ws = ts.map(watchDispose);
    s.dispose();
    expect(ws.map((w) => w.disposed)).toEqual([true, false, false]);
    expect(store.stats()).toMatchObject({ idle: 2, idleBytes: 32 });
  });
});

// ------------------------------------------------------------------------------------------------ effects race

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { existsSync(p: string): boolean };
const effectsBuilt = builtAssetsPresent && ['kenya-1-f', 'kenya-1-r'].every((id) => fs.existsSync(`${BUILT_ASSETS_DIR}/stages/${id}/effects.json`));

/** A stand-in store whose scope hands out textures after `ms` (rejecting when `fail`). */
function fxStore(ms: number, fail: boolean): TextureStore {
  const later = <T>(v: () => T) => new Promise<T>((res, rej) => setTimeout(() => (fail ? rej(new Error('fetch failed')) : res(v())), ms));
  const scope = {
    get: () => later(() => new THREE.Texture()),
    getVolume: () => later(() => new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1)),
    dispose: () => undefined,
  };
  return { scope: () => scope } as unknown as TextureStore;
}

describe.skipIf(!effectsBuilt)('OrigEffectsSystem.setStage concurrency (real effects packs)', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => _setAssetFetchForTests(null));

  it('a superseded load that fails leaves the newer stage loaded', async () => {
    const sys = new OrigEffectsSystem();
    const a = sys.setStage('kenya-1-f', true, fxStore(300, true)); // slow, fails
    await new Promise((r) => setTimeout(r, 150)); // A waits on its textures
    const b = sys.setStage('kenya-1-r', true, fxStore(0, false)); // newer, succeeds
    await b;
    expect(sys.active).toBe(true);
    await a;
    expect(sys.active).toBe(true);
    expect(sys.stage?.json.stageId).toBe('kenya-1-r');
    sys.dispose();
  });
});
