/**
 * src/render/sceneryModels.ts — original low-poly scenery models (render builder).
 *
 * Every model: base at y = 0, centred on the origin, "front" facing local -Z, long axis along X for
 * linear props (fence, barrier, snowbank, grandstand). Flat-shaded, vertex coloured, one merged geometry
 * per kind (instanced by scenery.ts). Nominal sizes (SceneryInstance.scale = 1):
 *
 *   pine 10.5 m tall · tree 7.5 m · deadTree 6 m · bush 1.4 m · rock 0.9 m · boulder 2.2 m · cactus 3.2 m
 *   post 1.0 m · marker (chevron board) 1.5 m · sign 2.2 m · barrier 0.8 m × 3 m · fence 1.1 m × 4 m
 *   tyreStack 0.85 m · hayBale 1.2 m · cone 0.7 m · snowbank 1.1 m × 6 m · spectator 1.75 m
 *   tent 2.3 m · house 6 m · barn 7.5 m · banner 2 m × 4 m · pole 6 m · grandstand 4.5 m × 14 m
 *   (startGate / checkpointGate / finishGate are built by gates.ts, sized to the road.)
 */
import * as THREE from 'three';
import type { SceneryKind } from '../core/types';
import { box, boxBase, coneBase, cyl, cylBase, dodeca, ico, lumpy, merge, paint, place, prism } from './geomUtil';

export const NOMINAL_HEIGHT: Readonly<Record<SceneryKind, number>> = {
  tree: 7.5,
  pine: 10.5,
  deadTree: 6,
  bush: 1.4,
  rock: 0.9,
  boulder: 2.2,
  cactus: 3.2,
  post: 1.0,
  marker: 1.5,
  sign: 2.2,
  barrier: 0.8,
  fence: 1.1,
  tyreStack: 0.85,
  hayBale: 1.2,
  cone: 0.7,
  snowbank: 1.1,
  spectator: 1.75,
  tent: 2.3,
  house: 6,
  barn: 7.5,
  banner: 2,
  startGate: 5,
  checkpointGate: 5,
  finishGate: 5,
  pole: 6,
  grandstand: 4.5,
};

/** Kinds whose instances get a random tint (spectator shirts, foliage variation). */
export const TINT_KINDS: ReadonlySet<SceneryKind> = new Set(['tree', 'pine', 'bush', 'spectator', 'tent', 'cactus', 'deadTree', 'tyreStack']);
/** Kinds that cast shadows (everything except tiny props). */
export const SHADOW_KINDS: ReadonlySet<SceneryKind> = new Set([
  'tree', 'pine', 'deadTree', 'bush', 'rock', 'boulder', 'cactus', 'sign', 'marker', 'barrier', 'fence', 'tyreStack',
  'hayBale', 'snowbank', 'spectator', 'tent', 'house', 'barn', 'banner', 'pole', 'grandstand', 'post', 'cone',
]);

type G = THREE.BufferGeometry;
const P = (g: G, color: number, pos?: [number, number, number], rot?: [number, number, number], scl?: [number, number, number], jitter = 0.06, seed = 1): G =>
  place(paint(g, color, jitter, seed), pos, rot, scl);

function pine(): G {
  const parts: G[] = [P(cylBase(0.12, 0.22, 2.4, 6, true), 0x5a3d26)];
  const tiers: [number, number, number, number][] = [
    [2.1, 4.0, 1.3, 0x2c5530],
    [1.75, 3.6, 3.2, 0x30603a],
    [1.35, 3.2, 5.1, 0x2d5934],
    [0.9, 2.8, 6.9, 0x336539],
    [0.45, 1.9, 8.6, 0x2f5f36],
  ];
  // only the lowest tier needs its underside; the others are hidden inside the tier below
  tiers.forEach(([r, h, y, c], i) => parts.push(P(coneBase(r, h, 7, i > 0), c, [0, y, 0], [0, i * 0.7, 0], undefined, 0.1, 11 + i)));
  return merge(parts);
}

function tree(): G {
  const parts: G[] = [P(cylBase(0.14, 0.26, 3.4, 6, true), 0x5e4630)];
  parts.push(P(cyl(0.08, 0.1, 1.8, 5), 0x5e4630, [0.55, 3.4, 0.1], [0, 0, -0.7]));
  parts.push(P(cyl(0.08, 0.1, 1.6, 5), 0x5e4630, [-0.5, 3.3, -0.2], [0.2, 0, 0.7]));
  const blobs: [number, number, number, number, number][] = [
    [2.2, 0, 4.9, 0, 0x4b7a33],
    [1.7, 1.2, 4.2, 0.5, 0x538538],
    [1.6, -1.1, 4.4, -0.6, 0x47732f],
    [1.4, 0.2, 6.1, 0.2, 0x5a8c3c],
  ];
  blobs.forEach(([r, x, y, z, c], i) => parts.push(lumpy(P(ico(r, 0), c, [x, y, z], undefined, undefined, 0.1, 21 + i), r * 0.18, 5 + i)));
  return merge(parts);
}

function deadTree(): G {
  const c = 0x6b5d4f;
  const parts: G[] = [P(cylBase(0.07, 0.24, 6, 6), c)];
  parts.push(P(cyl(0.04, 0.08, 2.2, 5), c, [0.6, 3.6, 0], [0, 0, -0.9]));
  parts.push(P(cyl(0.04, 0.07, 1.8, 5), c, [-0.5, 4.3, 0.2], [0.3, 0, 0.8]));
  parts.push(P(cyl(0.03, 0.06, 1.4, 5), c, [0.1, 5.0, -0.45], [-0.9, 0, 0.1]));
  return merge(parts);
}

function bush(): G {
  const parts: G[] = [];
  const b: [number, number, number, number, number][] = [
    [0.85, 0, 0.62, 0, 0x4f7232],
    [0.65, 0.6, 0.48, 0.25, 0x56793a],
    [0.6, -0.55, 0.45, -0.2, 0x48692e],
  ];
  b.forEach(([r, x, y, z, c], i) => parts.push(lumpy(P(ico(r, 0), c, [x, y, z], undefined, [1, 0.8, 1], 0.12, 31 + i), r * 0.15, 9 + i)));
  return merge(parts);
}

function rock(scale: number, seed: number, color: number): G {
  const g = lumpy(paint(dodeca(1), color, 0.12, seed), 0.28, seed);
  return place(g, [0, 0.42 * scale, 0], [0.3, seed, 0.2], [scale * 1.1, scale * 0.62, scale * 0.95]);
}

function cactus(): G {
  const c = 0x557f3e;
  const parts: G[] = [P(cylBase(0.24, 0.28, 3.2, 8), c)];
  parts.push(P(cyl(0.16, 0.16, 0.8, 7), c, [0.45, 1.5, 0], [0, 0, Math.PI / 2]));
  parts.push(P(cylBase(0.15, 0.16, 1.0, 7), c, [0.8, 1.45, 0]));
  parts.push(P(cyl(0.14, 0.14, 0.6, 7), c, [-0.36, 2.0, 0], [0, 0, Math.PI / 2]));
  parts.push(P(cylBase(0.13, 0.14, 0.8, 7), c, [-0.62, 1.95, 0]));
  return merge(parts);
}

function post(): G {
  return merge([
    P(boxBase(0.12, 1.0, 0.12), 0xeeeeea, undefined, undefined, undefined, 0.02),
    P(boxBase(0.125, 0.12, 0.125), 0xd22a1c, [0, 0.78, 0]),
    P(boxBase(0.126, 0.06, 0.126), 0x222222, [0, 0.62, 0]),
  ]);
}

function marker(): G {
  // chevron board (black on yellow) on two legs; arrow points to +X (the world can flip with rotY)
  const parts: G[] = [
    P(boxBase(0.07, 1.0, 0.07), 0x777777, [-0.45, 0, 0.03]),
    P(boxBase(0.07, 1.0, 0.07), 0x777777, [0.45, 0, 0.03]),
    P(box(1.3, 0.55, 0.05), 0xf2c40c, [0, 1.2, 0], undefined, undefined, 0.02),
  ];
  const shape = new THREE.Shape();
  shape.moveTo(-0.1, 0.22);
  shape.lineTo(0.12, 0);
  shape.lineTo(-0.1, -0.22);
  shape.lineTo(-0.22, -0.22);
  shape.lineTo(0.0, 0);
  shape.lineTo(-0.22, 0.22);
  // chevrons as thin slabs through the board: visible (and pointing +X) from both faces
  for (const dx of [-0.35, 0, 0.35]) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.062, bevelEnabled: false }).translate(0, 0, -0.031);
    parts.push(P(g, 0x151515, [dx, 1.2, 0], undefined, undefined, 0));
  }
  return merge(parts);
}

function sign(): G {
  return merge([
    P(boxBase(0.08, 1.6, 0.08), 0x8a8a8a),
    P(box(0.9, 0.7, 0.04), 0xc8201a, [0, 1.85, 0]),
    P(box(0.78, 0.58, 0.05), 0xf4f4f0, [0, 1.85, 0]),
    P(box(0.5, 0.1, 0.055), 0x1a1a1a, [0, 1.85, 0]),
  ]);
}

function barrier(): G {
  // jersey barrier 3 m along X with red/white bands
  const shape = new THREE.Shape();
  shape.moveTo(-0.3, 0);
  shape.lineTo(0.3, 0);
  shape.lineTo(0.22, 0.25);
  shape.lineTo(0.1, 0.8);
  shape.lineTo(-0.1, 0.8);
  shape.lineTo(-0.22, 0.25);
  shape.closePath();
  const parts: G[] = [];
  for (let k = 0; k < 4; k++) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.75, bevelEnabled: false });
    parts.push(P(g, k % 2 ? 0xc0392b : 0xe8e6e0, [-1.5 + k * 0.75, 0, 0], [0, Math.PI / 2, 0], undefined, 0.03, k));
  }
  return merge(parts);
}

function fence(): G {
  const c = 0x7a5a3a;
  const parts: G[] = [];
  for (const x of [-1.9, 0, 1.9]) parts.push(P(boxBase(0.12, 1.1, 0.12), c, [x, 0, 0], undefined, undefined, 0.1, 3));
  parts.push(P(box(4.0, 0.1, 0.05), 0x8a6844, [0, 0.85, 0]));
  parts.push(P(box(4.0, 0.1, 0.05), 0x8a6844, [0, 0.45, 0]));
  return merge(parts);
}

/**
 * Four stacked tyres that read as tyres: lighter rubber (a near-black albedo rendered as flat black holes), a
 * recessed groove between tyres, a painted white sidewall band on every tyre and a dark hole on top. Instances are
 * tinted in a red / white pattern (scenery.ts) so a tyre wall reads as a row of stacks.
 */
function tyreStack(): G {
  const parts: G[] = [];
  for (let k = 0; k < 4; k++) {
    const y = k * 0.21;
    parts.push(P(cylBase(0.34, 0.34, 0.15, 12), 0x3c3c3c, [0, y + 0.03, 0], [0, k, 0], undefined, 0.12, k));
    parts.push(P(cylBase(0.315, 0.315, 0.21, 12), 0x262626, [0, y, 0], [0, k, 0], undefined, 0.05, k + 7));
    parts.push(P(cylBase(0.343, 0.343, 0.045, 12), 0xe6e6e6, [0, y + 0.085, 0], [0, k, 0], undefined, 0.04, k + 13));
  }
  parts.push(P(cylBase(0.2, 0.2, 0.02, 12), 0x141414, [0, 0.84, 0]));
  return merge(parts);
}

function hayBale(): G {
  return merge([
    P(cyl(0.6, 0.6, 1.2, 10), 0xd6b25a, [0, 0.6, 0], [0, 0, Math.PI / 2], undefined, 0.08),
    P(cyl(0.45, 0.45, 1.21, 10), 0xc9a24c, [0, 0.6, 0], [0, 0, Math.PI / 2], undefined, 0.02),
  ]);
}

function trafficCone(): G {
  return merge([
    P(boxBase(0.4, 0.04, 0.4), 0x1a1a1a),
    P(coneBase(0.17, 0.66, 10), 0xff6a13, [0, 0.04, 0], undefined, undefined, 0.02),
    P(cylBase(0.105, 0.125, 0.11, 10), 0xf4f4f4, [0, 0.3, 0]),
  ]);
}

function snowbank(): G {
  const parts: G[] = [];
  const pieces: [number, number, number, number][] = [
    [-2.2, 0.7, 1.3, 0.9],
    [-0.8, 0.85, 1.6, 1.1],
    [0.7, 0.8, 1.5, 1.0],
    [2.2, 0.65, 1.3, 0.85],
  ];
  pieces.forEach(([x, h, r, d], i) =>
    parts.push(lumpy(P(ico(1, 1), i % 2 ? 0xf3f7fb : 0xe9eff6, [x, h * 0.35, 0], [0, i, 0], [r, h, d], 0.05, 40 + i), 0.08, 12 + i)),
  );
  return merge(parts);
}

function spectator(): G {
  // white shirt / light trousers so the instance tint reads mostly on the clothes
  return merge([
    P(boxBase(0.14, 0.85, 0.18), 0x3b4352, [-0.1, 0, 0]),
    P(boxBase(0.14, 0.85, 0.18), 0x3b4352, [0.1, 0, 0]),
    P(boxBase(0.44, 0.6, 0.26), 0xffffff, [0, 0.85, 0], undefined, undefined, 0.05),
    P(box(0.12, 0.55, 0.12), 0xf0f0f0, [-0.29, 1.14, -0.05], [0.35, 0, 0.12]),
    P(box(0.12, 0.55, 0.12), 0xf0f0f0, [0.29, 1.2, -0.12], [-0.9, 0, -0.1]),
    P(ico(0.14, 0), 0xe3b48f, [0, 1.6, 0], undefined, [1, 1.15, 1]),
    P(cylBase(0.15, 0.15, 0.08, 8), 0x2a2a2a, [0, 1.71, 0]),
  ]);
}

function tent(): G {
  return merge([
    P(prism(2.8, 2.3, 3), 0xffffff, [0, 0, 0], [0, Math.PI / 2, 0], undefined, 0.04),
    P(boxBase(0.06, 2.3, 0.06), 0x777777, [-1.45, 0, 0]),
    P(boxBase(0.06, 2.3, 0.06), 0x777777, [1.45, 0, 0]),
  ]);
}

function house(): G {
  return merge([
    P(boxBase(6, 3.2, 5), 0xd8cfbd, undefined, undefined, undefined, 0.04),
    P(prism(5.6, 2.2, 6.4), 0x8a3b2b, [0, 3.2, 0], [0, Math.PI / 2, 0], undefined, 0.05),
    P(boxBase(0.9, 2.0, 0.08), 0x5a3b26, [0.8, 0, -2.52]),
    P(boxBase(1.0, 0.9, 0.08), 0x27313b, [-1.6, 1.4, -2.52]),
    P(boxBase(1.0, 0.9, 0.08), 0x27313b, [2.2, 1.4, -2.52]),
    P(boxBase(0.6, 1.2, 0.6), 0x7b6a5a, [1.6, 4.4, 1.0]),
  ]);
}

function barn(): G {
  return merge([
    P(boxBase(8, 4.2, 12), 0x9b2e22, undefined, undefined, undefined, 0.05),
    P(prism(8.6, 3.2, 12.4), 0x5a5e63, [0, 4.2, 0], undefined, undefined, 0.05),
    P(boxBase(3.2, 3.2, 0.1), 0x6a1f17, [0, 0, -6.04]),
    P(box(3.3, 0.15, 0.12), 0xf0eee8, [0, 1.6, -6.1], [0, 0, 0.78]),
    P(box(3.3, 0.15, 0.12), 0xf0eee8, [0, 1.6, -6.1], [0, 0, -0.78]),
  ]);
}

function banner(): G {
  // generic stage banner: two poles + striped cloth (no sponsor names)
  const parts: G[] = [P(cylBase(0.05, 0.05, 2.0, 6), 0x888888, [-2, 0, 0]), P(cylBase(0.05, 0.05, 2.0, 6), 0x888888, [2, 0, 0])];
  const cols = [0x1f5fbf, 0xf2f2f2, 0xf5b800, 0xf2f2f2, 0x1f5fbf];
  cols.forEach((c, i) => parts.push(P(box(4, 0.2, 0.03), c, [0, 1.1 + i * 0.18, 0], undefined, undefined, 0.01)));
  return merge(parts);
}

function pole(): G {
  return merge([
    P(cylBase(0.05, 0.08, 6, 6), 0xcccccc),
    P(box(1.2, 0.7, 0.02), 0xd0302a, [0.62, 5.5, 0], undefined, undefined, 0.02),
    P(box(0.4, 0.7, 0.025), 0xf2f2f2, [0.62, 5.5, 0]),
  ]);
}

function grandstand(): G {
  // front (the low first row, where the crowd looks) = local -Z, per the SceneryInstance convention:
  // tiers rise toward +Z, roof posts at the back (+Z)
  const parts: G[] = [];
  for (let k = 0; k < 4; k++) parts.push(P(boxBase(14, 0.6 + k * 0.7, 1.0), k % 2 ? 0x9aa0a6 : 0x8a9096, [0, 0, -1.5 + k * 1.0], undefined, undefined, 0.03));
  for (const x of [-6.8, 0, 6.8]) parts.push(P(boxBase(0.15, 4.5, 0.15), 0x555b61, [x, 0, 1.8]));
  parts.push(P(box(14.4, 0.12, 4.6), 0x2f4f7f, [0, 4.5, 0], [-0.12, 0, 0]));
  return merge(parts);
}

// ------------------------------------------------------------------------------------------- far LODs

/** Far-distance stand-ins (a fraction of the triangles); null = the kind is simply hidden when far. */
export function buildSceneryLod(kind: SceneryKind): THREE.BufferGeometry | null {
  switch (kind) {
    case 'pine':
      // one open cone (5 triangles), dark base so the missing trunk does not read
      return merge([P(coneBase(1.9, 9.4, 5, true), 0x2c5832, [0, 0.9, 0], undefined, undefined, 0.06, 2)]);
    case 'tree':
      return merge([P(new THREE.OctahedronGeometry(2.4, 0), 0x4c7a34, [0, 4.9, 0], undefined, [1, 1.05, 1], 0.08, 4), P(cylBase(0.2, 0.25, 3.0, 3, true), 0x5e4630)]);
    case 'deadTree':
      return merge([P(cylBase(0.07, 0.24, 6, 3, true), 0x6b5d4f)]);
    case 'bush':
      return merge([P(new THREE.OctahedronGeometry(0.9, 0), 0x4f7232, [0, 0.55, 0], undefined, [1.25, 0.7, 1.1], 0.1, 5)]);
    case 'rock':
    case 'boulder':
    case 'house':
    case 'barn':
    case 'grandstand':
    case 'snowbank':
    case 'cactus':
    case 'tent':
      return buildSceneryModel(kind); // already cheap or big enough to keep
    default:
      return null;
  }
}

/** Distance (m) beyond which a kind switches to its far LOD (or is hidden when it has none). */
export const LOD_DISTANCE: Partial<Record<SceneryKind, number>> = {
  pine: 170, tree: 150, deadTree: 140, bush: 90, rock: 1e9, boulder: 1e9, house: 1e9, barn: 1e9, grandstand: 1e9,
  snowbank: 1e9, cactus: 1e9, tent: 1e9,
};
/** Small props are hidden beyond this distance (m). */
export const PROP_HIDE_DISTANCE = 260;

/** Build the merged model for a kind (null for kinds handled elsewhere, e.g. gates). */
export function buildSceneryModel(kind: SceneryKind): THREE.BufferGeometry | null {
  switch (kind) {
    case 'pine':
      return pine();
    case 'tree':
      return tree();
    case 'deadTree':
      return deadTree();
    case 'bush':
      return bush();
    case 'rock':
      return merge([rock(0.75, 3, 0x8a847a)]);
    case 'boulder':
      return merge([rock(1.8, 7, 0x7f786e), rock(0.7, 13, 0x847d73).translate(1.6, -0.1, 0.6)]);
    case 'cactus':
      return cactus();
    case 'post':
      return post();
    case 'marker':
      return marker();
    case 'sign':
      return sign();
    case 'barrier':
      return barrier();
    case 'fence':
      return fence();
    case 'tyreStack':
      return tyreStack();
    case 'hayBale':
      return hayBale();
    case 'cone':
      return trafficCone();
    case 'snowbank':
      return snowbank();
    case 'spectator':
      return spectator();
    case 'tent':
      return tent();
    case 'house':
      return house();
    case 'barn':
      return barn();
    case 'banner':
      return banner();
    case 'pole':
      return pole();
    case 'grandstand':
      return grandstand();
    case 'startGate':
    case 'checkpointGate':
    case 'finishGate':
      return null;
  }
  return null;
}
