/**
 * src/render/carModel.ts — procedural low-poly rally cars (render builder). Original designs.
 *
 * Each archetype has a side/plan PROFILE (piecewise-linear curves along the car, sim body frame:
 * z forward, y up, origin = centre of mass). The body is lofted through cross-sections
 * (floor, sill, side, shoulder/beltline, greenhouse, roof crown) with round-ish wheel-arch cut-outs,
 * then emitted in the THREE car-local frame (forward = -Z). Triangles go to material SLOTS:
 * paint (livery texture), glass, dark trim, accent, lights. Paint UVs are assigned per face:
 * left side / right side / top view / plain, matching the livery canvas layout in livery.ts.
 *
 *   awd_wrc     "Corvane X4"     modern 5-door-ish hatch, box flares, big rear wing
 *   fwd_hatch   "Tessel F2"      short, tall small hatch, roof spoiler
 *   rwd_classic "Ardent Classic" boxy 80s coupe, long flat bonnet, light pod, ducktail
 */
import * as THREE from 'three';
import type { ArchetypeId } from '../core/types';

// ------------------------------------------------------------------------------------------- profiles

type Key = [number, number]; // [zSim, value]

export interface CarProfile {
  id: ArchetypeId;
  front: number;
  rear: number;
  /** Body-frame y of the ground at rest (= -CG height). */
  ground: number;
  wheelR: number;
  wheelW: number;
  /** Rest wheel centre y (body frame). */
  wheelY: number;
  axleF: number;
  axleR: number;
  trackF: number;
  trackR: number;
  archGap: number;
  bottom: Key[];
  belt: Key[];
  top: Key[];
  crown: Key[];
  w: Key[];
  wTop: Key[];
  sideGlass: [number, number][];
  topGlass: [number, number][];
  rim: number;
}

export const PROFILES: Readonly<Record<ArchetypeId, CarProfile>> = {
  awd_wrc: {
    id: 'awd_wrc',
    front: 2.07,
    rear: -2.3,
    ground: -0.42,
    wheelR: 0.3,
    wheelW: 0.23,
    wheelY: -0.12,
    axleF: 1.21,
    axleR: -1.32,
    trackF: 0.755,
    trackR: 0.76,
    archGap: 0.07,
    bottom: [[2.07, -0.2], [1.92, -0.29], [-2.12, -0.29], [-2.3, -0.17]],
    belt: [[2.07, -0.02], [1.9, 0.14], [1.5, 0.26], [0.7, 0.4], [0.5, 0.45], [-1.7, 0.52], [-2.06, 0.5], [-2.3, 0.36]],
    top: [[2.07, 0.06], [1.9, 0.22], [1.4, 0.35], [0.66, 0.46], [-0.02, 0.98], [-1.56, 0.97], [-2.06, 0.7], [-2.3, 0.46]],
    crown: [[2.07, 0.01], [1.4, 0.05], [0.66, 0.05], [0.5, 0.05], [-0.02, 0.04], [-1.56, 0.04], [-2.3, 0.02]],
    w: [[2.07, 0.66], [1.95, 0.8], [1.7, 0.88], [0.75, 0.88], [0.6, 0.84], [-0.75, 0.84], [-0.9, 0.89], [-2.05, 0.89], [-2.3, 0.8]],
    wTop: [[2.07, 0.58], [1.9, 0.7], [0.75, 0.74], [0.66, 0.72], [-0.02, 0.62], [-1.56, 0.62], [-2.06, 0.66], [-2.3, 0.7]],
    sideGlass: [[-1.78, -0.62], [-0.52, 0.56]],
    topGlass: [[-0.02, 0.66], [-2.06, -1.56]],
    rim: 0xf2f2f2,
  },
  fwd_hatch: {
    id: 'fwd_hatch',
    front: 1.95,
    rear: -2.05,
    ground: -0.38,
    wheelR: 0.3,
    wheelW: 0.21,
    wheelY: -0.08,
    axleF: 1.235,
    axleR: -1.31,
    trackF: 0.765,
    trackR: 0.765,
    archGap: 0.06,
    bottom: [[1.95, -0.17], [1.8, -0.25], [-1.95, -0.25], [-2.05, -0.16]],
    belt: [[1.95, 0.04], [1.78, 0.2], [1.2, 0.34], [0.78, 0.44], [-1.8, 0.52], [-2.05, 0.42]],
    top: [[1.95, 0.12], [1.78, 0.29], [1.2, 0.4], [0.78, 0.46], [0.08, 1.03], [-1.82, 1.02], [-2.0, 0.6], [-2.05, 0.44]],
    crown: [[1.95, 0.01], [1.2, 0.05], [0.78, 0.05], [0.08, 0.04], [-1.82, 0.03], [-2.05, 0.02]],
    w: [[1.95, 0.68], [1.8, 0.8], [1.6, 0.85], [-1.9, 0.85], [-2.05, 0.78]],
    wTop: [[1.95, 0.6], [1.78, 0.72], [0.78, 0.74], [0.08, 0.64], [-1.82, 0.64], [-2.0, 0.7], [-2.05, 0.7]],
    sideGlass: [[-1.74, -0.5], [-0.4, 0.7]],
    topGlass: [[0.08, 0.78], [-2.0, -1.82]],
    rim: 0xcfd3d6,
  },
  rwd_classic: {
    id: 'rwd_classic',
    front: 1.8,
    rear: -1.9,
    ground: -0.47,
    wheelR: 0.3,
    wheelW: 0.24,
    wheelY: -0.17,
    axleF: 1.26,
    axleR: -1.19,
    trackF: 0.655,
    trackR: 0.73,
    archGap: 0.06,
    bottom: [[1.8, -0.24], [1.7, -0.33], [-1.82, -0.33], [-1.9, -0.25]],
    belt: [[1.8, 0.1], [1.7, 0.21], [0.55, 0.26], [0.38, 0.31], [-1.3, 0.36], [-1.5, 0.33], [-1.9, 0.3]],
    top: [[1.8, 0.16], [1.7, 0.27], [0.52, 0.31], [0.38, 0.34], [-0.22, 0.84], [-1.02, 0.84], [-1.44, 0.44], [-1.9, 0.39]],
    crown: [[1.8, 0.01], [0.38, 0.02], [-0.22, 0.03], [-1.02, 0.03], [-1.44, 0.02], [-1.9, 0.01]],
    w: [[1.8, 0.72], [1.68, 0.78], [1.5, 0.8], [0.9, 0.8], [0.75, 0.77], [-0.6, 0.77], [-0.72, 0.9], [-1.9, 0.9]],
    wTop: [[1.8, 0.68], [1.68, 0.74], [0.38, 0.72], [-0.22, 0.58], [-1.02, 0.58], [-1.44, 0.74], [-1.9, 0.8]],
    sideGlass: [[-1.24, -0.62], [-0.54, 0.34]],
    topGlass: [[-0.22, 0.38], [-1.44, -1.02]],
    rim: 0xd9b23a,
  },
};

function interp(keys: Key[], z: number): number {
  // keys sorted by z descending (front first)
  if (z >= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (z <= last[0]) return last[1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [z0, v0] = keys[i], [z1, v1] = keys[i + 1];
    if (z <= z0 && z >= z1) {
      const t = (z0 - z) / (z0 - z1 || 1);
      return v0 + (v1 - v0) * t;
    }
  }
  return last[1];
}

const inRanges = (r: [number, number][], z: number) => r.some(([a, b]) => z > a && z < b);

export interface Section {
  z: number;
  yb: number;
  belt: number;
  top: number;
  crown: number;
  w: number;
  wTop: number;
}

/** Body cross-section at sim z (with wheel-arch cut-outs). */
export function sectionAt(p: CarProfile, z: number): Section {
  let yb = interp(p.bottom, z);
  const Ra = p.wheelR + p.archGap;
  for (const A of [p.axleF, p.axleR]) {
    const dz = Math.abs(z - A);
    if (dz < Ra) yb = Math.max(yb, p.wheelY + Math.sqrt(Ra * Ra - dz * dz) * 1.0);
  }
  let belt = interp(p.belt, z);
  belt = Math.max(belt, yb + 0.08);
  let top = interp(p.top, z);
  top = Math.max(top, belt + 0.03);
  const crown = top + interp(p.crown, z);
  return { z, yb, belt, top, crown, w: interp(p.w, z), wTop: interp(p.wTop, z) };
}

function stations(p: CarProfile): number[] {
  const zs = new Set<number>();
  for (const k of [p.bottom, p.belt, p.top, p.crown, p.w, p.wTop]) for (const [z] of k) zs.add(z);
  for (const [a, b] of [...p.sideGlass, ...p.topGlass]) {
    zs.add(a);
    zs.add(b);
  }
  const Ra = p.wheelR + p.archGap;
  for (const A of [p.axleF, p.axleR]) for (const f of [-1, -0.92, -0.72, -0.4, 0, 0.4, 0.72, 0.92, 1]) zs.add(A + f * Ra);
  const sorted = [...zs].filter((z) => z <= p.front && z >= p.rear).sort((a, b) => b - a);
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    out.push(sorted[i]);
    if (i < sorted.length - 1) {
      const gap = sorted[i] - sorted[i + 1];
      const n = Math.floor(gap / 0.32);
      for (let k = 1; k <= n; k++) out.push(sorted[i] - (gap * k) / (n + 1));
    }
  }
  // drop near-duplicates
  return out.filter((z, i) => i === 0 || out[i - 1] - z > 0.004);
}

// ------------------------------------------------------------------------------------------- UV layout

export const LIVERY_SIZE = 1024;
/** Canvas rows: left side [0, 384), right side [384, 768), top view [768, 1024). */
export interface UvMap {
  side(zSim: number, y: number, left: boolean): [number, number]; // canvas px
  top(zSim: number, x3: number): [number, number];
  plain: [number, number];
  /** Pixels per metre on the side regions (x along the car, y vertical). */
  pxPerM: [number, number];
}

export function uvMapFor(p: CarProfile): UvMap {
  const L = p.front - p.rear;
  const yMax = Math.max(...p.top.map((k) => k[1])) + 0.12;
  const Hh = yMax - p.ground;
  const wMax = Math.max(...p.w.map((k) => k[1])) + 0.05;
  return {
    side(z, y, left) {
      const t = (y - p.ground) / Hh;
      if (left) return [((p.front - z) / L) * LIVERY_SIZE, (1 - t) * 384];
      return [((z - p.rear) / L) * LIVERY_SIZE, 384 + (1 - t) * 384];
    },
    top(z, x3) {
      return [((p.front - z) / L) * 896, 768 + ((wMax - x3) / (2 * wMax)) * 256];
    },
    plain: [960, 900],
    pxPerM: [LIVERY_SIZE / L, 384 / Hh],
  };
}

// ------------------------------------------------------------------------------------------- triangle builder

export type Slot = 'paint' | 'glass' | 'dark' | 'accent' | 'chrome' | 'head' | 'tail' | 'rev';
export const SLOTS: readonly Slot[] = ['paint', 'glass', 'dark', 'accent', 'chrome', 'head', 'tail', 'rev'];

class Tris {
  pos: number[] = [];
  uv: number[] = [];
}

const _n = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();

class CarBuilder {
  readonly slots = new Map<Slot, Tris>();
  readonly p: CarProfile;
  readonly uv: UvMap;

  constructor(p: CarProfile) {
    this.p = p;
    this.uv = uvMapFor(p);
    for (const s of SLOTS) this.slots.set(s, new Tris());
  }

  /** Triangle in THREE car-local coordinates; `hint` = rough outward direction (winding is fixed to match). */
  tri(slot: Slot, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, hint: THREE.Vector3 | null): void {
    _e1.subVectors(b, a);
    _e2.subVectors(c, a);
    _n.crossVectors(_e1, _e2);
    if (_n.lengthSq() < 1e-12) return;
    let A = a, B = b;
    if (hint && _n.dot(hint) < 0) {
      A = b;
      B = a;
      _n.negate();
    }
    const t = this.slots.get(slot)!;
    t.pos.push(A.x, A.y, A.z, B.x, B.y, B.z, c.x, c.y, c.z);
    if (slot === 'paint') {
      _n.normalize();
      const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
      for (const v of [A, B, c]) {
        let px: [number, number];
        if (ax >= 0.5 && ax >= az) px = this.uv.side(-v.z, v.y, _n.x < 0);
        else if (ay >= az * 0.9) px = this.uv.top(-v.z, v.x);
        else px = this.uv.plain;
        t.uv.push(px[0] / LIVERY_SIZE, 1 - px[1] / LIVERY_SIZE);
      }
    }
  }

  /** Append a three primitive (already positioned in THREE car-local space). */
  geo(slot: Slot, g: THREE.BufferGeometry): void {
    const ng = g.index ? g.toNonIndexed() : g;
    const pos = ng.attributes.position as THREE.BufferAttribute;
    const t = this.slots.get(slot)!;
    for (let i = 0; i < pos.count; i++) {
      t.pos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (slot === 'paint') t.uv.push(this.uv.plain[0] / LIVERY_SIZE, 1 - this.uv.plain[1] / LIVERY_SIZE);
    }
    if (ng !== g) ng.dispose();
    g.dispose();
  }

  /** Box centred at sim body (x, y, zSim), size (sx, sy, sz along sim z), optional rotation (three Euler). */
  box(slot: Slot, x: number, y: number, zSim: number, sx: number, sy: number, sz: number, rot?: [number, number, number]): void {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    if (rot) g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)));
    g.translate(x, y, -zSim);
    this.geo(slot, g);
  }

  /** Cylinder with its axis along the car (sim z). */
  lamp(slot: Slot, x: number, y: number, zSim: number, r: number, len: number, seg = 10): void {
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1).rotateX(Math.PI / 2).translate(x, y, -zSim);
    this.geo(slot, g);
  }

  build(): Record<Slot, THREE.BufferGeometry> {
    const out = {} as Record<Slot, THREE.BufferGeometry>;
    for (const s of SLOTS) {
      const t = this.slots.get(s)!;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3));
      if (s === 'paint') g.setAttribute('uv', new THREE.Float32BufferAttribute(t.uv, 2));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      out[s] = g;
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------- body loft

function ring(s: Section): [number, number][] {
  const r1: [number, number] = [s.w * 0.94, s.yb];
  const r2: [number, number] = [s.w, Math.min(s.yb + 0.06, s.belt - 0.02)];
  const r3: [number, number] = [s.w, s.belt];
  const r4: [number, number] = [s.wTop, s.top];
  return [[0, s.yb], r1, r2, r3, r4, [0, s.crown], [-r4[0], r4[1]], [-r3[0], r3[1]], [-r2[0], r2[1]], [-r1[0], r1[1]]];
}
// band k → slot: 0,9 floor | 1,2,7,8 lower side | 3,6 greenhouse | 4,5 top
const BAND_KIND = ['floor', 'side', 'side', 'green', 'top', 'top', 'green', 'side', 'side', 'floor'] as const;

function loftBody(b: CarBuilder): void {
  const p = b.p;
  const zs = stations(p);
  const secs = zs.map((z) => sectionAt(p, z));
  const rings = secs.map(ring);
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), D = new THREE.Vector3();
  const hint = new THREE.Vector3();
  for (let i = 0; i < secs.length - 1; i++) {
    const s0 = secs[i], s1 = secs[i + 1];
    const zMid = (s0.z + s1.z) / 2;
    const r0 = rings[i], r1 = rings[i + 1];
    for (let k = 0; k < 10; k++) {
      const k2 = (k + 1) % 10;
      const kind = BAND_KIND[k];
      let slot: Slot = 'paint';
      if (kind === 'floor') slot = 'dark';
      else if (kind === 'green' && inRanges(p.sideGlass, zMid)) slot = 'glass';
      else if (kind === 'top' && inRanges(p.topGlass, zMid)) slot = 'glass';
      A.set(r0[k][0], r0[k][1], -s0.z);
      B.set(r0[k2][0], r0[k2][1], -s0.z);
      C.set(r1[k2][0], r1[k2][1], -s1.z);
      D.set(r1[k][0], r1[k][1], -s1.z);
      if (kind === 'floor') hint.set(0, -1, 0);
      else if (kind === 'top') hint.set(0, 1, 0);
      else hint.set(Math.sign(r0[k][0] + r0[k2][0]) || 1, 0, 0);
      b.tri(slot, A, B, C, hint);
      b.tri(slot, A, C, D, hint);
    }
  }
  // end caps (fans): front faces -Z, rear faces +Z (three car-local)
  for (const [ri, si] of [[0, 0], [rings.length - 1, secs.length - 1]] as const) {
    hint.set(0, 0, ri === 0 ? -1 : 1);
    const r = rings[ri], s = secs[si];
    let cx = 0, cy = 0;
    for (const [x, y] of r) {
      cx += x;
      cy += y;
    }
    const cen = new THREE.Vector3(cx / r.length, cy / r.length, -s.z);
    for (let k = 0; k < 10; k++) {
      const k2 = (k + 1) % 10;
      A.set(r[k][0], r[k][1], -s.z);
      B.set(r[k2][0], r[k2][1], -s.z);
      b.tri('paint', cen, A, B, hint);
    }
  }
}

// ------------------------------------------------------------------------------------------- details

function commonDetails(b: CarBuilder): void {
  const p = b.p;
  const f = sectionAt(p, p.front - 0.02);
  const r = sectionAt(p, p.rear + 0.02);
  // bumpers (dark), slightly proud of the body
  b.box('dark', 0, f.yb + 0.08, p.front - 0.06, f.w * 2 * 0.98 + 0.06, 0.17, 0.16);
  b.box('dark', 0, r.yb + 0.08, p.rear + 0.06, r.w * 2 * 0.98 + 0.06, 0.17, 0.16);
  // grille
  b.box('dark', 0, (f.yb + f.belt) / 2 + 0.06, p.front - 0.005, f.w * 0.9, 0.09, 0.03);
  // headlights
  const hy = Math.min(f.belt - 0.05, (f.yb + f.belt) / 2 + 0.07);
  for (const sx of [-1, 1]) {
    b.box('head', sx * f.w * 0.62, hy, p.front - 0.01, f.w * 0.42, 0.09, 0.04);
  }
  // tail lights + reverse lights
  const ty = Math.min(r.belt - 0.05, r.belt - 0.06);
  for (const sx of [-1, 1]) {
    b.box('tail', sx * r.w * 0.7, ty, p.rear + 0.012, r.w * 0.36, 0.1, 0.03);
    b.box('rev', sx * r.w * 0.42, ty, p.rear + 0.014, r.w * 0.14, 0.07, 0.03);
  }
  // mirrors at the A-pillar base
  const zA = p.sideGlass.length ? Math.max(...p.sideGlass.map((g) => g[1])) - 0.05 : 0.4;
  const sA = sectionAt(p, zA);
  for (const sx of [-1, 1]) {
    b.box('paint', sx * (sA.w + 0.07), sA.belt + 0.08, zA, 0.12, 0.08, 0.12);
    b.box('dark', sx * (sA.w + 0.02), sA.belt + 0.05, zA + 0.02, 0.06, 0.03, 0.05);
  }
  // mud flaps behind every wheel
  for (const [axle, track] of [[p.axleF, p.trackF], [p.axleR, p.trackR]] as const) {
    for (const sx of [-1, 1]) {
      const z = axle - (p.wheelR + p.archGap + 0.03);
      const top = p.wheelY + 0.12, bot = p.ground + 0.07;
      b.box('accent', sx * track, (top + bot) / 2, z, p.wheelW + 0.06, top - bot, 0.02);
    }
  }
  // number-plate recess
  b.box('chrome', 0, f.yb + 0.08, p.front + 0.025, 0.42, 0.1, 0.01);
}

function awdDetails(b: CarBuilder): void {
  const p = b.p;
  const zw = -2.1;
  const s = sectionAt(p, zw);
  const wy = s.crown + 0.2;
  // big wing on two struts + endplates
  for (const sx of [-1, 1]) b.box('dark', sx * 0.42, (s.crown + wy) / 2, zw, 0.05, wy - s.crown + 0.05, 0.16);
  b.box('accent', 0, wy, zw - 0.05, 1.5, 0.04, 0.27, [-0.12, 0, 0]);
  for (const sx of [-1, 1]) b.box('accent', sx * 0.76, wy - 0.03, zw - 0.05, 0.025, 0.14, 0.34);
  // roof vent + bonnet vents + front splitter + side skirts
  const rv = sectionAt(p, -0.35);
  b.box('dark', 0, rv.crown + 0.04, -0.35, 0.34, 0.08, 0.32);
  const bv = sectionAt(p, 1.62);
  b.box('dark', 0, bv.crown + 0.003, 1.62, 0.4, 0.01, 0.14);
  b.box('dark', 0, -0.33, p.front - 0.08, 1.4, 0.03, 0.22);
  for (const sx of [-1, 1]) b.box('dark', sx * 0.83, -0.27, -0.05, 0.06, 0.07, 1.55);
  // exhaust
  b.lamp('chrome', 0.45, -0.24, p.rear - 0.02, 0.05, 0.14);
}

function fwdDetails(b: CarBuilder): void {
  const p = b.p;
  const zr = -1.84;
  const s = sectionAt(p, zr);
  // roof-edge spoiler
  b.box('accent', 0, s.crown + 0.01, zr - 0.1, 1.28, 0.04, 0.3, [0.18, 0, 0]);
  // two round driving lamps in the grille
  const f = sectionAt(p, p.front - 0.02);
  for (const sx of [-1, 1]) {
    b.lamp('dark', sx * 0.32, f.yb + 0.21, p.front + 0.02, 0.075, 0.05);
    b.lamp('head', sx * 0.32, f.yb + 0.21, p.front + 0.045, 0.06, 0.01);
  }
  // roof rack bars (silhouette detail)
  const rs = sectionAt(p, -0.9);
  for (const z of [-0.4, -1.4]) b.box('dark', 0, rs.crown + 0.04, z, 1.15, 0.03, 0.04);
  b.lamp('chrome', -0.45, -0.2, p.rear - 0.02, 0.04, 0.12);
}

function rwdDetails(b: CarBuilder): void {
  const p = b.p;
  // 4-lamp light pod on a bar across the nose
  const f = sectionAt(p, p.front - 0.02);
  const py = f.belt - 0.06;
  b.box('dark', 0, py - 0.05, p.front + 0.03, 1.16, 0.04, 0.06);
  for (const x of [-0.45, -0.15, 0.15, 0.45]) {
    b.lamp('dark', x, py, p.front + 0.06, 0.068, 0.06);
    b.lamp('head', x, py, p.front + 0.092, 0.056, 0.01);
  }
  // ducktail on the boot
  const s = sectionAt(p, -1.84);
  b.box('paint', 0, s.crown + 0.03, -1.82, 1.55, 0.05, 0.22, [0.32, 0, 0]);
  // bonnet scoop + roof vent
  const bs = sectionAt(p, 0.9);
  b.box('dark', 0, bs.crown + 0.04, 0.9, 0.42, 0.08, 0.36);
  const rs = sectionAt(p, -0.6);
  b.box('dark', 0, rs.crown + 0.03, -0.6, 0.3, 0.06, 0.26);
  // twin exhausts
  for (const x of [0.36, 0.5]) b.lamp('chrome', x, -0.28, p.rear - 0.03, 0.045, 0.16);
}

// ------------------------------------------------------------------------------------------- public

const geoCache = new Map<ArchetypeId, Record<Slot, THREE.BufferGeometry>>();

/** Body geometries per slot for an archetype (THREE car-local frame, cached; do not dispose). */
export function carGeometry(id: ArchetypeId): Record<Slot, THREE.BufferGeometry> {
  let g = geoCache.get(id);
  if (g) return g;
  const p = PROFILES[id];
  const b = new CarBuilder(p);
  loftBody(b);
  commonDetails(b);
  if (id === 'awd_wrc') awdDetails(b);
  else if (id === 'fwd_hatch') fwdDetails(b);
  else rwdDetails(b);
  g = b.build();
  geoCache.set(id, g);
  return g;
}

/** Rest wheel centre (THREE car-local) for wheel index 0 FL, 1 FR, 2 RR, 3 RL (fallback before telemetry). */
export function restWheelCentre(id: ArchetypeId, i: number): THREE.Vector3 {
  const p = PROFILES[id];
  const front = i === 0 || i === 1;
  const left = i === 0 || i === 3;
  const x = (front ? p.trackF : p.trackR) * (left ? -1 : 1);
  return new THREE.Vector3(x, p.wheelY, -(front ? p.axleF : p.axleR));
}
