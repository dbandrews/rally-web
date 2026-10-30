// tests/world/objectMeshes.test.ts — the static objects' own collision meshes (src/world/orig/objectMeshes.ts, RCOL v2):
// the port of CollisionMesh.Simple's segment query 0x597810 against the ORIGINAL code run in unicorn on real meshes
// and placements (fixtures/orig/objmesh_cases.json, generator gen_objmesh_cases.py), the deepest-end rule, the
// mirrored frame, and the RCOL v2 sections on a built part (skipped without assets). docs/orig/collision.md §4.
import { describe, expect, it } from 'vitest';
import type { ObjectSegmentHit, SimV3 } from '../../src/core/types';
import { OrigObjectMeshes } from '../../src/world/orig/objectMeshes';
import { INST, MESH_STRIDE, parseRcol, type RcolData } from '../../src/world/orig/rcol';
import { builtAssetsPresent } from '../assets/builtAssetFetch';

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync(p: string, e?: string): string & Uint8Array; existsSync(p: string): boolean };

type V = [number, number, number];
interface Fixture {
  meshes: { template: string; V: V[]; tris: [number, number, number, number, number, number, number][]; m: number[] }[];
  cases: { mesh: number; o: V; ray: V; hit: boolean; normal?: V; point?: V; depth?: number; mat?: number; cosUntouched?: boolean }[];
}

const STRIDE = 28;

/** An RcolData carrying only object meshes: one instance per mesh with the given 4×4 (rows; row 3 = translation). */
function meshData(meshes: Fixture['meshes'], kinds = 0): RcolData {
  const mV: number[] = [], mTN: number[] = [], mTI: number[] = [], mesh: number[] = [], inst: number[] = [];
  let nv = 0, nt = 0;
  meshes.forEach((m, k) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of m.V) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], v[j]); hi[j] = Math.max(hi[j], v[j]); }
    mesh.push(nt, m.tris.length, ...lo, ...hi);
    for (const v of m.V) mV.push(...v);
    for (const t of m.tris) { mTN.push(t[0], t[1], t[2]); mTI.push(t[3] + nv, t[4] + nv, t[5] + nv, t[6]); }
    nv += m.V.length;
    nt += m.tris.length;
    const r = new Array(STRIDE).fill(0);
    const M = m.m;
    r.splice(INST.M, 9, M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]);
    r.splice(INST.T, 3, M[12], M[13], M[14]);
    r[INST.MESH] = k;
    r[INST.MATERIAL] = -1;
    r[INST.RADIUS] = 2;
    r[INST.OBJECT] = k;
    r[INST.KIND] = kinds;
    r.splice(INST.BOXMIN, 3, ...lo);
    r.splice(INST.BOXMAX, 3, ...hi);
    r.splice(INST.CENTRE, 3, M[12], M[13], M[14]);
    inst.push(...r);
  });
  return {
    mV: Float32Array.from(mV), mTN: Float32Array.from(mTN), mTI: Uint32Array.from(mTI), mesh: Float32Array.from(mesh),
    nMesh: meshes.length, nInst: meshes.length, instStride: STRIDE, inst: Float32Array.from(inst), version: 2,
  } as unknown as RcolData;
}

const hitOut = (): ObjectSegmentHit => ({ normal: { x: 0, y: 0, z: 0 }, point: { x: 0, y: 0, z: 0 }, depth: 0 });
const v = (a: V): SimV3 => ({ x: a[0], y: a[1], z: a[2] });

describe('object collision meshes: the CollisionMesh.Simple query 0x597810', () => {
  const fx = JSON.parse(fs.readFileSync('tests/world/fixtures/orig/objmesh_cases.json', 'utf8')) as Fixture;

  it(`${fx.cases.length} segments on ${fx.meshes.length} original meshes / placements agree with the original run in unicorn`, () => {
    const om = new OrigObjectMeshes(meshData(fx.meshes), ['tree']);
    expect(om.list.length).toBe(fx.meshes.length);
    const out = hitOut();
    let hits = 0, scaled = 0, maxDn = 0, maxDp = 0, maxDd = 0;
    for (const c of fx.cases) {
      const col = om.list[c.mesh];
      const got = col.segment(v(c.o), v(c.ray), out);
      expect(got, `case on ${fx.meshes[c.mesh].template}`).toBe(c.hit);
      if (!c.hit) continue;
      hits++;
      const n = c.normal!, p = c.point!;
      maxDn = Math.max(maxDn, Math.abs(out.normal.x - n[0]), Math.abs(out.normal.y - n[1]), Math.abs(out.normal.z - n[2]));
      maxDp = Math.max(maxDp, Math.abs(out.point.x - p[0]), Math.abs(out.point.y - p[1]), Math.abs(out.point.z - p[2]));
      maxDd = Math.max(maxDd, Math.abs(out.depth - c.depth!));
      if (Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) > 1e-3) scaled++;
      expect(c.cosUntouched).toBe(true); // the query never writes the cos output
    }
    expect(hits).toBeGreaterThan(100);
    expect(scaled).toBeGreaterThan(0); // scaled placements: the returned normal is NOT re-normalised (n·M)
    expect(maxDn).toBeLessThan(1e-4);
    expect(maxDp).toBeLessThan(1e-3);
    expect(maxDd).toBeLessThan(1e-4);
  });

  it('the deepest end wins (not the first, not the nearest); a start on the plane misses; one-sided', () => {
    // two parallel walls facing +x (stored normals point INTO the solid: −x), at x = 1 and x = 2
    const wall = (x: number, k: number): Fixture['meshes'][number]['tris'] => [
      [-1, 0, 0, k, k + 1, k + 2, 0], [-1, 0, 0, k, k + 2, k + 3, 0],
    ];
    const V: V[] = [[1, -5, -5], [1, 5, -5], [1, 5, 5], [1, -5, 5], [2, -5, -5], [2, 5, -5], [2, 5, 5], [2, -5, 5]];
    const mesh = { template: 'walls', V, tris: [...wall(2, 4), ...wall(1, 0)], m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
    const om = new OrigObjectMeshes(meshData([mesh]), ['barrier']);
    const out = hitOut();
    const c = om.list[0];
    // from x = 3 to x = 0.5: crosses x = 2 (nearer, listed first) and x = 1; the end is deeper behind x = 2 (−1.5)
    expect(c.segment({ x: 3, y: 0, z: 0 }, { x: -2.5, y: 0, z: 0 }, out)).toBe(true);
    expect(out.depth).toBeCloseTo(-1.5, 9);
    expect(out.point.x).toBeCloseTo(2, 9);
    expect(out.normal).toEqual({ x: 1, y: 0, z: 0 });
    // starting exactly on the x = 2 plane: that wall misses (d0 = 0); the x = 1 wall is hit
    expect(c.segment({ x: 2, y: 0, z: 0 }, { x: -1.5, y: 0, z: 0 }, out)).toBe(true);
    expect(out.point.x).toBeCloseTo(1, 9);
    // from behind (−x side) nothing faces the segment
    expect(c.segment({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, out)).toBe(false);
    // outside the mesh's AABB: rejected before any triangle
    expect(c.segment({ x: 3, y: 9, z: 0 }, { x: -2.5, y: 0, z: 0 }, out)).toBe(false);
  });

  it('a mirrored world answers the mirrored segment (z negated in and out) and exposes the mirrored transform', () => {
    const fx2 = fx.meshes.slice(0, 3);
    const a = new OrigObjectMeshes(meshData(fx2), ['tree']);
    const b = new OrigObjectMeshes(meshData(fx2), ['tree'], true);
    const oa = hitOut(), ob = hitOut();
    let n = 0;
    for (const c of fx.cases.filter((k) => k.mesh < 3)) {
      const ha = a.list[c.mesh].segment(v(c.o), v(c.ray), oa);
      const hb = b.list[c.mesh].segment({ x: c.o[0], y: c.o[1], z: -c.o[2] }, { x: c.ray[0], y: c.ray[1], z: -c.ray[2] }, ob);
      expect(hb).toBe(ha);
      if (!ha) continue;
      n++;
      expect(ob.point.z).toBeCloseTo(-oa.point.z, 9);
      expect(ob.normal.z).toBeCloseTo(-oa.normal.z, 9);
      expect(ob.depth).toBeCloseTo(oa.depth, 9);
    }
    expect(n).toBeGreaterThan(5);
    expect(b.list[0].origin.z).toBeCloseTo(-a.list[0].origin.z, 9);
    expect(b.list[0].m[2]).toBeCloseTo(-a.list[0].m[2], 9);
  });
});

describe('RCOL v2 object meshes on a built part', () => {
  it.skipIf(!builtAssetsPresent)('kenya-1-f: every hard object has its mesh instance; meshes and indices are consistent', () => {
    const root = 'public/assets/stages/kenya-1-f/collision';
    if (!fs.existsSync(root + '.bin')) return;
    const b = fs.readFileSync(root + '.bin') as unknown as Uint8Array;
    const d = parseRcol(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const meta = JSON.parse(fs.readFileSync(root + '.json', 'utf8'));
    expect(d.version).toBe(2);
    expect(d.nInst).toBe(meta.obstacles.stats.hard - (meta.obstacles.stats.degenerateMeshes ?? 0));
    expect(d.nInst).toBe(meta.objectMeshes.instances);
    const om = new OrigObjectMeshes(d, meta.obstacles.kinds);
    expect(om.list.length).toBe(d.nInst);
    for (let m = 0; m < d.nMesh; m++) expect(d.mesh[m * MESH_STRIDE + 1]).toBeGreaterThan(0);
    // the riot fence panels (kn_riotfence_01): a collider whose origin is the placement, radius ≈ the MergeObjects leaf (1.37 m)
    const fence = om.list.filter((c) => meta.obstacles.templates[d.inst[d.instStride * om.list.indexOf(c) + INST.TEMPLATE]] === 'kn_riotfence_01');
    expect(fence.length).toBeGreaterThan(50);
    for (const c of fence) expect(c.radius).toBeCloseTo(1.369, 2);
  });
});
