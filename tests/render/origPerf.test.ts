// tests/render/origPerf.test.ts — the render-cost changes that must leave the image unchanged: the in-place
// distance sort (same order as the stable Array.sort it replaced), the static-matrix freeze, ProxyGrid.near's
// in-place output.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { sortRangeByDistDesc } from '../../src/render/orig/objects';
import { StaticWorld } from '../../src/render/orig/staticWorld';
import { ProxyGrid } from '../../src/world/orig/obstacles';

/** The previous implementation: insertion sort up to 24, else Array.from + the stable Array.sort. */
function oldSort(perm: Uint32Array, a: number, b: number, dist: Float32Array): void {
  const n = b - a;
  if (n <= 24) {
    for (let i = a + 1; i < b; i++) {
      const v = perm[i];
      const dv = dist[v];
      let j = i - 1;
      while (j >= a && dist[perm[j]] < dv) {
        perm[j + 1] = perm[j];
        j--;
      }
      perm[j + 1] = v;
    }
    return;
  }
  const sub = Array.from(perm.subarray(a, b));
  sub.sort((x, y) => dist[y] - dist[x]);
  perm.set(sub, a);
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('sortRangeByDistDesc', () => {
  it('gives the order of the stable Array.sort it replaced, ties included', () => {
    const r = rng(7);
    for (let trial = 0; trial < 400; trial++) {
      const n = trial < 120 ? trial : Math.floor(r() * 3000);
      const lo = Math.floor(r() * 5);
      const hi = lo + n;
      const total = hi + Math.floor(r() * 5);
      const levels = [3, 20, 1e9][trial % 3]; // few distinct values = many ties
      const dist = new Float32Array(total + 8);
      for (let i = 0; i < dist.length; i++) dist[i] = Math.floor(r() * levels);
      const base = new Uint32Array(total);
      for (let i = 0; i < total; i++) base[i] = i;
      for (let i = total - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [base[i], base[j]] = [base[j], base[i]];
      }
      const a = Uint32Array.from(base);
      const b = Uint32Array.from(base);
      oldSort(a, lo, hi, dist);
      sortRangeByDistDesc(b, lo, hi, dist);
      expect(Array.from(b)).toEqual(Array.from(a));
    }
  });
});

describe('StaticWorld', () => {
  function rig() {
    const scene = new THREE.Scene();
    const mid = new THREE.Group();
    const root = new THREE.Group();
    root.scale.set(1, 1, -1);
    const nodes = [0, 1, 2].map((i) => {
      const m = new THREE.Mesh();
      m.position.set(i, 2 * i, 3);
      m.updateMatrix();
      m.matrixAutoUpdate = false;
      root.add(m);
      return m;
    });
    mid.add(root);
    scene.add(mid);
    return { scene, mid, root, nodes };
  }
  it('freezes the nodes at the settled value and thaws when the root moves', () => {
    const { scene, mid, root, nodes } = rig();
    const sw = new StaticWorld(root);
    for (let f = 0; f < 4; f++) {
      scene.updateMatrixWorld();
      sw.update(nodes);
    }
    expect(nodes.every((n) => !n.matrixWorldAutoUpdate)).toBe(true);
    nodes.forEach((n) => expect(n.matrixWorld.elements).toEqual(new THREE.Matrix4().multiplyMatrices(root.matrixWorld, n.matrix).elements));
    // frozen: still the mirrored matrices after more frames
    scene.updateMatrixWorld();
    sw.update(nodes);
    expect(nodes[2].matrixWorld.elements[10]).toBe(-1);
    // the root moves: the nodes follow at the next update
    mid.position.set(10, 0, 0);
    scene.updateMatrixWorld();
    sw.update(nodes);
    expect(nodes.every((n) => n.matrixWorldAutoUpdate)).toBe(true);
    scene.updateMatrixWorld();
    nodes.forEach((n) => expect(n.matrixWorld.elements).toEqual(new THREE.Matrix4().multiplyMatrices(root.matrixWorld, n.matrix).elements));
    expect(nodes[1].matrixWorld.elements[12]).toBeCloseTo(11);
  });
});

describe('ProxyGrid.near', () => {
  const mk = (x: number, z: number, radius: number) => ({ pos: { x, y: 0, z }, radius });
  const grid = new ProxyGrid([mk(0, 0, 1), mk(5, 0, 1), mk(40, 40, 2), mk(100, 0, 1), mk(3, 3, 0.5)]);
  it('fills a reused array in place and trims it', () => {
    const out: unknown[] = [];
    const brute = (x: number, z: number, r: number) =>
      grid.list.filter((o) => (o.pos.x - x) ** 2 + (o.pos.z - z) ** 2 < (r + o.radius) ** 2);
    for (const [x, z, r] of [[0, 0, 10], [40, 40, 1], [500, 500, 5], [2, 1, 3], [0, 0, -1], [1e9, 0, 5], [0, 0, 200]] as const) {
      const got = grid.near(x, z, r, out);
      expect(got).toBe(out);
      expect(new Set(got)).toEqual(new Set(brute(x, z, r)));
      expect(got.length).toBe(brute(x, z, r).length);
    }
  });
});
