/**
 * src/world/orig/rcol.ts — reader of `stages/<id>/collision.bin` ('RCOL' v1 / v2, written by
 * tools/assets/parts/collision.py; layout in that file's docstring).
 *
 * The arrays are the original Track.gcm sections unchanged and in file order (research/formats/gcm.md §2):
 * vertices, indices, raw material bytes, stored face normals, the 256 × 256 top-cell block lists, and every
 * block with its own u16 (+ base) or u32 sub-cell face lists. Only the top-cell `cellStart` array is not
 * shipped: in every Track.gcm it is the prefix of the 0xffff terminators of `cellList` (the build asserts it),
 * so it is rebuilt here bit-identically. Plus the object collision proxies (obstacles.ts) and, from v2 on, the
 * static objects' own collision meshes with one instance per hard object part (objectMeshes.ts).
 */

export const RCOL_MAGIC = 'RCOL';
/** Newest version written by the build; v1 files (no object meshes) still load (cylinder stand-in physics). */
export const RCOL_VERSION = 2;
const HEADER_SIZE = 96;

/** Obstacle record layout (f32 × stride, tools/assets/parts/collision.py OBST_*). */
export const OBST = {
  X: 0,
  Y: 1,
  Z: 2,
  RADIUS: 3,
  HEIGHT: 4,
  KIND: 5,
  FLAGS: 6,
  MATERIAL: 7,
  MASS: 8,
  OBJECT: 9,
  SHAPE: 10,
  HULL0: 11,
  HULLN: 12,
  YAW: 13,
  TEMPLATE: 14,
} as const;
/** Obstacle flags: hard = static collision geometry, dynamic = loose PhyObject part, soft = flag only (bushes). */
export const OBST_HARD = 1;
export const OBST_DYNAMIC = 2;
export const OBST_SOFT = 4;

/** Object collision instance layout (f32 × instStride, tools/assets/parts/collision.py INST_*). */
export const INST = {
  /** 3×3 rows: local → sim (row vectors, v·M + T), the geometry scale included (0x591c20). */
  M: 0,
  T: 9,
  MESH: 12,
  MATERIAL: 13,
  /** Bounding radius (half the scaled render box diagonal, object +8). */
  RADIUS: 14,
  OBJECT: 15,
  TEMPLATE: 16,
  /** Render box (local, unscaled: corners go through M). */
  BOXMIN: 17,
  BOXMAX: 20,
  /** Bounding centre (sim, object +0xc). */
  CENTRE: 23,
  KIND: 26,
  FLAGS: 27,
} as const;
/** Instance flag: the geometry answers the colour interface (the object pass's small gate, 0x4a8008). */
export const INST_COLOUR = 1;
/** Mesh table stride: tri0, nTri, AABB min xyz, max xyz. */
export const MESH_STRIDE = 8;

/** The Track.gcm arrays (CollisionMesh.Grid, gcm.md §2) + obstacle proxies, as typed views on the file. */
export interface RcolData {
  nV: number;
  nF: number;
  /** gcm bbox in xz (Grid +0x0c / +0x14), f32 values. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Top grid dim (256 in every file). */
  dim: number;
  V: Float32Array;
  I: Uint16Array | Uint32Array;
  /** Raw material byte per face (c_MATERIAL_ROAD_*, gcm.md §4). */
  M: Uint8Array;
  /** Stored face normals (incl. the inert (0,0,0) ones). */
  FN: Float32Array;
  /** dim² + 1 starts into cellList (rebuilt: the prefix of the terminators). */
  cellStart: Uint32Array;
  /** Block ids per top cell, each list ended by 0xffff. */
  cellList: Uint16Array;
  nB: number;
  /** Per block: bmin.x, bmin.y, bmin.z, bmax.x, bmax.y, bmax.z, invX, invZ (f32, stored). */
  blkF: Float32Array;
  /** Per block: dim, use16, base, offBase (into off), listBase (into list16 | list32). */
  blkU: Uint32Array;
  off: Uint16Array;
  list16: Uint16Array;
  list32: Uint32Array;
  nObst: number;
  obstStride: number;
  obst: Float32Array;
  /** Loose-part hull points (.col), sim space, xyz. */
  hull: Float32Array;
  /** File version (1: no object meshes). */
  version: number;
  /** Object collision meshes (v2; empty in v1): per mesh tri0, nTri, AABB (MESH_STRIDE f32). */
  nMesh: number;
  mesh: Float32Array;
  /** Their vertices (local), stored triangle normals, and i0, i1, i2 (into mV), pad per triangle. */
  mV: Float32Array;
  mTN: Float32Array;
  mTI: Uint32Array;
  nInst: number;
  instStride: number;
  /** One record per hard object part (INST layout). */
  inst: Float32Array;
}

/** Parse an RCOL v1 / v2 buffer. Throws on a malformed file (the caller warns once and falls back). */
export function parseRcol(buf: ArrayBuffer): RcolData {
  if (buf.byteLength < HEADER_SIZE) throw new Error('collision.bin: too short');
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== RCOL_MAGIC) throw new Error(`collision.bin: bad magic ${magic}`);
  const u32 = (o: number) => dv.getUint32(o, true);
  const f32 = (o: number) => dv.getFloat32(o, true);
  const version = u32(4);
  if (version !== 1 && version !== 2) throw new Error(`collision.bin: version ${version}`);
  const nV = u32(8), nF = u32(12);
  const minX = f32(16), minZ = f32(20), maxX = f32(24), maxZ = f32(28);
  const dim = u32(32), nCellList = u32(36), nB = u32(40), nOff = u32(44), nList16 = u32(48), nList32 = u32(52);
  const flags = u32(56), nObst = u32(60), nHull = u32(64), obstStride = u32(68);
  const v2 = version >= 2;
  const nMesh = v2 ? u32(72) : 0, nMV = v2 ? u32(76) : 0, nMT = v2 ? u32(80) : 0, nInst = v2 ? u32(84) : 0;
  const instStride = v2 ? u32(88) : INST.FLAGS + 1;
  if (instStride <= INST.FLAGS) throw new Error('collision.bin: instance stride');
  let o = HEADER_SIZE;
  const take = <T extends ArrayBufferView>(Ctor: new (b: ArrayBuffer, off: number, n: number) => T, n: number, bpe: number): T => {
    if (o + n * bpe > buf.byteLength) throw new Error('collision.bin: truncated');
    const a = new Ctor(buf, o, n);
    o += (n * bpe + 3) & ~3;
    return a;
  };
  const V = take(Float32Array, 3 * nV, 4);
  const I = flags & 1 ? take(Uint16Array, 3 * nF, 2) : take(Uint32Array, 3 * nF, 4);
  const M = take(Uint8Array, nF, 1);
  const FN = take(Float32Array, 3 * nF, 4);
  const cellList = take(Uint16Array, nCellList, 2);
  const blkF = take(Float32Array, 8 * nB, 4);
  const blkU = take(Uint32Array, 5 * nB, 4);
  const off = take(Uint16Array, nOff, 2);
  const list16 = take(Uint16Array, nList16, 2);
  const list32 = take(Uint32Array, nList32, 4);
  const obst = take(Float32Array, obstStride * nObst, 4);
  const hull = take(Float32Array, 3 * nHull, 4);
  const mesh = take(Float32Array, MESH_STRIDE * nMesh, 4);
  const mV = take(Float32Array, 3 * nMV, 4);
  const mTN = take(Float32Array, 3 * nMT, 4);
  const mTI = take(Uint32Array, 4 * nMT, 4);
  const inst = take(Float32Array, instStride * nInst, 4);
  if (o !== buf.byteLength) throw new Error('collision.bin: size mismatch');
  for (let m = 0; m < nMesh; m++) {
    const t0 = mesh[MESH_STRIDE * m], nt = mesh[MESH_STRIDE * m + 1];
    if (!(t0 >= 0 && nt >= 0 && t0 + nt <= nMT)) throw new Error('collision.bin: object mesh table');
  }
  for (let t = 0; t < 4 * nMT; t += 4) {
    if (mTI[t] >= nMV || mTI[t + 1] >= nMV || mTI[t + 2] >= nMV) throw new Error('collision.bin: object mesh indices');
  }
  for (let k = 0; k < nInst; k++) {
    const m = inst[instStride * k + INST.MESH];
    if (!(m >= 0 && m < nMesh)) throw new Error('collision.bin: object instance mesh');
  }
  // cellStart = the prefix of the terminators (verified equal to the stored array at build time)
  const cellStart = new Uint32Array(dim * dim + 1);
  let c = 0;
  for (let k = 0; k < nCellList && c < dim * dim; k++) if (cellList[k] === 0xffff) cellStart[++c] = k + 1;
  if (c !== dim * dim) throw new Error('collision.bin: cell lists');
  for (let b = 0; b < nB; b++) if (blkU[5 * b] === 0) throw new Error('collision.bin: block dim 0');
  return {
    nV, nF, minX, minZ, maxX, maxZ, dim, V, I, M, FN, cellStart, cellList, nB, blkF, blkU, off, list16, list32,
    nObst, obstStride, obst, hull, version, nMesh, mesh, mV, mTN, mTI, nInst, instStride, inst,
  };
}
