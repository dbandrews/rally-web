/**
 * src/render/geomUtil.ts — low-poly geometry helpers (render builder).
 *
 * Scenery and car parts are built from small primitives, each given a flat vertex colour, then merged
 * into one BufferGeometry (one draw call per model / instanced batch). All geometries produced here are
 * NON-indexed with flat normals (faceted low-poly look) and carry exactly the attributes
 * `position`, `normal`, `color` (so any two of them can be merged).
 */
import * as THREE from 'three';

const _c = new THREE.Color();

/** Convert to non-indexed, drop uv, recompute flat normals, paint one colour (sRGB hex → linear). */
export function paint(geo: THREE.BufferGeometry, color: number | THREE.Color, jitter = 0, seed = 1): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position') g.deleteAttribute(name);
  }
  g.computeVertexNormals();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  if (typeof color === 'number') _c.setHex(color);
  else _c.copy(color);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i += 3) {
    // per-face brightness jitter (keeps the faceted look lively)
    let k = 1;
    if (jitter > 0) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      k = 1 + ((s / 4294967296) * 2 - 1) * jitter;
    }
    for (let v = 0; v < 3 && i + v < n; v++) {
      col[(i + v) * 3] = _c.r * k;
      col[(i + v) * 3 + 1] = _c.g * k;
      col[(i + v) * 3 + 2] = _c.b * k;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Apply a transform to a geometry (returns the same geometry). */
export function place(
  geo: THREE.BufferGeometry,
  pos: [number, number, number] = [0, 0, 0],
  rot: [number, number, number] = [0, 0, 0],
  scl: [number, number, number] = [1, 1, 1],
): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
    new THREE.Vector3(...scl),
  );
  geo.applyMatrix4(m);
  return geo;
}

/**
 * Merge painted parts (all non-indexed with position/normal/color). Local implementation: importing
 * three/addons in the dev server would pull in a second copy of three (not in optimizeDeps).
 */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = ['position', 'normal', 'color'] as const;
  let total = 0;
  for (const p of parts) {
    if (p.index) throw new Error('geomUtil.merge: indexed geometry (paint() it first)');
    for (const n of names) if (!p.attributes[n]) throw new Error(`geomUtil.merge: missing ${n}`);
    total += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  for (const n of names) {
    const out = new Float32Array(total * 3);
    let o = 0;
    for (const p of parts) {
      const a = p.attributes[n] as THREE.BufferAttribute;
      out.set(a.array as Float32Array, o);
      o += a.count * 3;
    }
    g.setAttribute(n, new THREE.BufferAttribute(out, 3));
  }
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// ---------------------------------------------------------------------------------------- primitives

export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Box whose base sits at y = 0. */
export const boxBase = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
export const cyl = (rTop: number, rBot: number, h: number, seg = 7) => new THREE.CylinderGeometry(rTop, rBot, h, seg, 1);
/** Cylinder whose base sits at y = 0. */
export const cylBase = (rTop: number, rBot: number, h: number, seg = 7, open = false) =>
  new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open).translate(0, h / 2, 0);
export const cone = (r: number, h: number, seg = 7) => new THREE.ConeGeometry(r, h, seg, 1);
/** Cone whose base sits at y = 0. */
export const coneBase = (r: number, h: number, seg = 7, open = false) => new THREE.ConeGeometry(r, h, seg, 1, open).translate(0, h / 2, 0);
export const ico = (r: number, detail = 0) => new THREE.IcosahedronGeometry(r, detail);
export const dodeca = (r: number) => new THREE.DodecahedronGeometry(r, 0);

/** Randomly displace the vertices of a (non-indexed after paint) blob, keeping shared corners together. */
export function lumpy(geo: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const key = (x: number, y: number, z: number) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
  const offs = new Map<string, [number, number, number]>();
  let s = seed >>> 0 || 7;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = key(x, y, z);
    let o = offs.get(k);
    if (!o) {
      o = [rnd() * amount, rnd() * amount, rnd() * amount];
      offs.set(k, o);
    }
    pos.setXYZ(i, x + o[0], y + o[1], z + o[2]);
  }
  pos.needsUpdate = true;
  return geo;
}

/**
 * Triangular prism: cross-section in XY (base width `w` on y = 0, apex at height `h`), extruded along Z
 * by `len`, centred on z = 0. Rotate by π/2 about Y for a ridge along X.
 */
export function prism(w: number, h: number, len: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(0, h);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false }).translate(0, 0, -len / 2);
}

/** A flat textured quad in the XY plane (centre origin), for banners. */
export function quad(w: number, h: number): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, h);
}
