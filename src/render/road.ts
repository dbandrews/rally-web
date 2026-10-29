/**
 * src/render/road.ts — road ribbon meshes from Stage.road (render builder).
 *
 *  - One mesh per surface (runs of equal surface merged): left edge / centre / right edge per sample,
 *    lifted ROAD_LIFT above the samples, polygon offset against the terrain. u across (0 = left edge),
 *    v = s / tileLength, so the procedural textures put lines and wheel ruts in the right places.
 *  - Soft verges: an alpha-faded strip on each side draped over the rendered terrain.
 *  - Chequered start / finish line decals.
 */
import * as THREE from 'three';
import type { RoadSample, Stage, SurfaceId } from '../core/types';
import type { HeightSampler } from './heightSampler';
import { ROAD_LIFT } from './terrain';
import { roadLook, shoulderTexture } from './textures';

const SHOULDER_W = 2.2;
const SHOULDER_IN = 0.12;

interface Strip {
  pos: number[];
  uv: number[];
  idx: number[];
}

function segmentCount(stage: Stage): number {
  const n = stage.road.length;
  if (n < 2) return 0;
  if (stage.closed) {
    const a = stage.road[n - 1].pos, b = stage.road[0].pos;
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 12) return n; // close the loop
  }
  return n - 1;
}

export function buildRoad(stage: Stage, sampler: HeightSampler): THREE.Group {
  const group = new THREE.Group();
  group.name = 'road';
  const road = stage.road;
  const n = road.length;
  const segs = segmentCount(stage);
  if (segs === 0) return group;

  // ---------------------------------------------------------------- surface ribbons (runs)
  const strips = new Map<SurfaceId, Strip>();
  const getStrip = (s: SurfaceId) => {
    let st = strips.get(s);
    if (!st) strips.set(s, (st = { pos: [], uv: [], idx: [] }));
    return st;
  };
  let i = 0;
  while (i < segs) {
    const surf = road[i].surface;
    let j = i;
    while (j < segs && road[j].surface === surf) j++;
    // run covers samples i..j (j = first sample of the next run, or the end)
    const st = getStrip(surf);
    const look = roadLook(surf);
    const base = st.pos.length / 3;
    let rows = 0;
    for (let k = i; k <= j; k++) {
      const r = road[k % n];
      // closing segment of a loop: continue v past the lap length so the texture does not jump
      const sv = k >= n ? r.s + stage.length : r.s;
      const v = sv / look.tileLength;
      st.pos.push(r.left.x, r.left.y + ROAD_LIFT, r.left.z);
      st.pos.push(r.pos.x, r.pos.y + ROAD_LIFT, r.pos.z);
      st.pos.push(r.right.x, r.right.y + ROAD_LIFT, r.right.z);
      st.uv.push(0, v, 0.5, v, 1, v);
      rows++;
    }
    for (let r = 0; r < rows - 1; r++) {
      const a = base + r * 3, b = a + 3;
      // CCW seen from above (travel along -z: left = -x)
      st.idx.push(a, a + 1, b, a + 1, b + 1, b);
      st.idx.push(a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
    }
    i = j;
  }
  for (const [surf, st] of strips) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(st.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(st.uv, 2));
    g.setIndex(st.idx);
    g.computeVertexNormals();
    fixUpNormals(g);
    g.computeBoundingSphere();
    const look = roadLook(surf);
    const mat = new THREE.MeshStandardMaterial({
      map: look.map,
      color: look.map ? 0xffffff : look.color,
      roughness: look.roughness,
      metalness: look.metalness,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      envMapIntensity: surf === 'ice' || surf === 'water' ? 1.0 : 0.35,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `road:${surf}`;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // ---------------------------------------------------------------- shoulders (both sides, one mesh)
  const sp: number[] = [], sc: number[] = [], su: number[] = [], si: number[] = [];
  const col = new THREE.Color();
  const addSide = (side: -1 | 1) => {
    const base = sp.length / 3;
    for (let k = 0; k <= segs; k++) {
      const r: RoadSample = road[k % n];
      const edge = side < 0 ? r.left : r.right;
      let ox = edge.x - r.pos.x, oz = edge.z - r.pos.z;
      const ol = Math.hypot(ox, oz) || 1;
      ox /= ol;
      oz /= ol;
      const look = roadLook(r.surface);
      col.setHex(look.shoulder);
      const sv = (k >= n ? r.s + stage.length : r.s) / 4;
      // inner (slightly inside the road edge), mid, outer
      const pts: [number, number, number, number][] = [];
      const inX = edge.x - ox * SHOULDER_IN, inZ = edge.z - oz * SHOULDER_IN;
      pts.push([inX, edge.y + ROAD_LIFT + 0.004, inZ, 0.95]);
      const mX = edge.x + ox * 0.7, mZ = edge.z + oz * 0.7;
      pts.push([mX, Math.max(sampler.heightAt(mX, mZ), edge.y - 0.4) + 0.05, mZ, 0.7]);
      const oX = edge.x + ox * SHOULDER_W, oZ = edge.z + oz * SHOULDER_W;
      pts.push([oX, sampler.heightAt(oX, oZ) + 0.05, oZ, 0]);
      for (let p = 0; p < 3; p++) {
        sp.push(pts[p][0], pts[p][1], pts[p][2]);
        sc.push(col.r, col.g, col.b, pts[p][3]);
        su.push(p * 0.5 * side, sv);
      }
    }
    for (let k = 0; k < segs; k++) {
      const a = base + k * 3, b = a + 3;
      for (let p = 0; p < 2; p++) {
        si.push(a + p, b + p, a + p + 1, a + p + 1, b + p, b + p + 1);
      }
    }
  };
  addSide(-1);
  addSide(1);
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(sc, 4));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2));
    g.setIndex(si);
    g.computeVertexNormals();
    fixUpNormals(g);
    g.computeBoundingSphere();
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      map: shoulderTexture(),
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'shoulders';
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // ---------------------------------------------------------------- start / finish line decals
  const lines: number[] = [stage.startS];
  if (Math.abs(stage.finishS - stage.startS) > 1 && !(stage.closed && Math.abs(stage.finishS - stage.length) < 1)) lines.push(stage.finishS);
  for (const s of lines) group.add(lineDecal(stage, s));
  return group;
}

/** Make every vertex normal point upward (strip windings differ between the two shoulder sides). */
function fixUpNormals(g: THREE.BufferGeometry): void {
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < nrm.count; i++) {
    if (nrm.getY(i) < 0) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
  }
  nrm.needsUpdate = true;
}

let chequerTex: THREE.Texture | null | undefined;
function chequer(): THREE.Texture | null {
  if (chequerTex !== undefined) return chequerTex;
  if (typeof document === 'undefined') return (chequerTex = null);
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 32;
  const ctx = c.getContext('2d')!;
  for (let x = 0; x < 16; x++)
    for (let y = 0; y < 2; y++) {
      ctx.fillStyle = (x + y) % 2 ? '#151515' : '#f1f1f1';
      ctx.fillRect(x * 16, y * 16, 16, 16);
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return (chequerTex = t);
}

function lineDecal(stage: Stage, s: number): THREE.Mesh {
  const r = stage.roadAt(s);
  const t = stage.tangentAt(s);
  const half = 0.6; // 1.2 m deep band along the road
  const pts = [r.left, r.right];
  const pos: number[] = [];
  for (const sgn of [-1, 1]) {
    for (const p of pts) pos.push(p.x + t.x * half * sgn, p.y + ROAD_LIFT + 0.01 + t.y * half * sgn, p.z + t.z * half * sgn);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  g.setIndex([0, 2, 1, 1, 2, 3]);
  g.computeVertexNormals();
  fixUpNormals(g);
  const tex = chequer();
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    color: tex ? 0xffffff : 0xdddddd,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(g, mat);
  m.name = 'lineDecal';
  m.receiveShadow = true;
  return m;
}
