/**
 * tests/render/origEffectsLoad.test.ts — the load-time and per-frame parts of the original effects that the loading screen
 * relies on (src/render/orig/effects.ts, src/render/loadCap.ts):
 *  * DepthSorter = the stable back-to-front order of the insertion sort it replaced (ties keep their order);
 *  * capped(): a stalled load never holds the caller, a failure never rejects.
 */
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { DepthSorter, OrigCarFx, OrigEffectsSystem } from '../../src/render/orig/effects';
import { TextureStore } from '../../src/render/orig/textures';
import { builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';
import { capped } from '../../src/render/loadCap';

/** The previous per-frame sort of SpriteBatch.update, verbatim. */
function insertionDesc(dep: Float32Array, ord: Uint32Array, n: number): void {
  for (let a2 = 1; a2 < n; a2++) {
    const kd = dep[a2], ko = ord[a2];
    let b = a2 - 1;
    while (b >= 0 && dep[b] < kd) {
      dep[b + 1] = dep[b];
      ord[b + 1] = ord[b];
      b--;
    }
    dep[b + 1] = kd;
    ord[b + 1] = ko;
  }
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function sortBoth(depths: number[]): { fast: number[]; ref: number[] } {
  const n = depths.length;
  const cap = n + 3; // arrays longer than n, as in SpriteBatch
  const d1 = new Float32Array(cap), d2 = new Float32Array(cap);
  const o1 = new Uint32Array(cap), o2 = new Uint32Array(cap);
  depths.forEach((v, i) => {
    d1[i] = d2[i] = v;
    o1[i] = o2[i] = i;
  });
  new DepthSorter().sort(d1, o1, n);
  insertionDesc(d2, o2, n);
  return { fast: [...o1.subarray(0, n)], ref: [...o2.subarray(0, n)] };
}

describe('DepthSorter (particle batches, back to front)', () => {
  it('gives the insertion sort order for random depths, small and large', () => {
    const rnd = lcg(7);
    for (const n of [0, 1, 2, 5, 64, 128, 129, 400, 3000]) {
      const depths = Array.from({ length: n }, () => 0.1 + rnd() * 900);
      const { fast, ref } = sortBoth(depths);
      expect(fast).toEqual(ref);
    }
  });

  it('keeps the order of equal depths (stable), also for near-equal float32 values', () => {
    const rnd = lcg(11);
    for (const n of [40, 500, 2500]) {
      // few distinct values: lots of ties; plus values one float32 step apart
      const base = [3, 3.0000002, 10, 10, 250.5, 0.5];
      const depths = Array.from({ length: n }, () => base[Math.floor(rnd() * base.length)]);
      const { fast, ref } = sortBoth(depths);
      expect(fast).toEqual(ref);
    }
  });

  it('sorts already sorted and reversed input, and tiny / huge depths', () => {
    const asc = Array.from({ length: 300 }, (_, i) => 1 + i);
    expect(sortBoth(asc).fast).toEqual(sortBoth(asc).ref);
    const desc = asc.slice().reverse();
    expect(sortBoth(desc).fast).toEqual(sortBoth(desc).ref);
    const odd = Array.from({ length: 200 }, (_, i) => (i % 2 ? 1e-30 * (i + 1) : 1e30 / (i + 1)));
    expect(sortBoth(odd).fast).toEqual(sortBoth(odd).ref);
  });

  it('is reusable across calls of different sizes', () => {
    const s = new DepthSorter();
    const rnd = lcg(3);
    for (const n of [900, 200, 1500, 150]) {
      const dep = new Float32Array(n), ref = new Float32Array(n);
      const o = new Uint32Array(n), r = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        dep[i] = ref[i] = rnd() * 100 + 1;
        o[i] = r[i] = i;
      }
      s.sort(dep, o, n);
      insertionDesc(ref, r, n);
      expect([...o]).toEqual([...r]);
    }
  });
});

describe('capped (loads behind the loading screen)', () => {
  it('resolves true when the load finishes in time, false on failure, false at the cap', async () => {
    vi.useFakeTimers();
    try {
      await expect(capped(Promise.resolve(1), 50)).resolves.toBe(true);
      await expect(capped(Promise.reject(new Error('x')), 50)).resolves.toBe(false);
      const stalled = capped(new Promise(() => undefined), 50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(stalled).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!builtAssetsPresent)('OrigEffectsSystem / OrigCarFx loads (built assets)', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => _setAssetFetchForTests(null));

  it('setStage settles with the batches in place, preallocated to the stage cap; a car\'s effects + drop shadow are ready after settled()', async () => {
    const store = new TextureStore({} as THREE.WebGLRenderer, { s3tc: false });
    const sys = new OrigEffectsSystem();
    // a car created BEFORE the stage effects load (loadSelection starts both together), another after
    const early = new OrigCarFx(sys, 'Micra');
    await sys.setStage('corsica-1-f', true, store);
    expect(sys.active).toBe(true);
    const late = new OrigCarFx(sys, 'Micra');
    await sys.settled();
    for (const car of [early, late]) {
      await car.whenReady();
      expect(car.emitterCount).toBeGreaterThan(0);
      const shadow = sys.root.children.filter((c) => c.name === 'origfx:dropshadow');
      expect(shadow.length).toBe(2);
      for (const m of shadow) expect(((m as THREE.Mesh).material as THREE.ShaderMaterial).uniforms.uTex.value).not.toBeNull();
    }
    // every batch holds the whole global cap up front: no growth (and no GPU buffer replacement) mid-race
    const batches = sys.root.children.filter((c) => c.name.startsWith('origfx:') && c.name !== 'origfx:dropshadow' && (c as THREE.Mesh).geometry);
    expect(batches.length).toBeGreaterThan(5);
    for (const b of batches) {
      const g = (b as THREE.Mesh).geometry as THREE.InstancedBufferGeometry;
      const attr = g.getAttribute('iPos');
      if (attr) expect(attr.count).toBeGreaterThanOrEqual(3000);
    }
    sys.dispose();
  });

  it('settled() and whenReady() resolve without stage effects (procedural stage, no assets for the car)', async () => {
    const sys = new OrigEffectsSystem();
    const fx = new OrigCarFx(sys, 'NoSuchCar');
    await sys.setStage('procedural-stage', false, null);
    await sys.settled();
    await fx.whenReady();
    expect(sys.active).toBe(false);
  });
});
