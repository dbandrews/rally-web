"""collision part: the physics ground of a ported stage = the original Track.gcm, plus object collision proxies.

Spec: research/formats/gcm.md (§1 the game uses Track.gcm, §2 layout, §3.2-3.4 the query, §9 web plan +
Verification), research/formats/objects.md §1.3 / §7.3 / §8 (placements, frames, collision proxies),
research/formats/standardmesh.md §2.2 (CollisionMesh.Simple of the object meshes). Runtime: src/world/orig/.
Notes and deviations: docs/orig/collision.md.

Outputs (stages/<id>/):
  collision.bin    'RCOL' v2 (layout below): the Track.gcm arrays the original's query reads, unchanged and in
                   file order (vertices, indices, stored face normals incl. the inert zero normals, raw material
                   bytes, the top-cell lists, every block with its u16/u32 sub-cell lists) + obstacle proxies +
                   the static objects' own collision meshes (CollisionMesh.Simple, below).
  collision.json   counts, bbox, section table, obstacle kind table, stats (written LAST = part present).

Track.gcm only, never TrackFull.gcm (gcm.md §1: TrackFull needs the `fullCollision` cvar, default 0).
The top-cell `cellStart` array is NOT shipped: in every Track.gcm it is exactly the prefix of the 0xffff
terminators of `cellList` (check_gcm + the assertion below), so the runtime rebuilds it bit-identically.

Object collision meshes (v2, docs/orig/collision.md §4): the original collides the car with a static object by
querying the object's CollisionMesh.Simple (standardmesh.md §2.2) with the car's hull segments under the object's
transform (object pass FUN_004a7bc0 → FUN_006d1a80 → callback 0x677c30 → mesh-instance query 0x5912a0, which
composes diag(Object.geometry.scale)·R + pos (0x591c20) → CollisionMesh.Simple query 0x597810). The build ships
each used mesh once, in the query's own data (the 32-byte BSP tri records: stored normal, 3 vertex indices, pad)
plus one instance per hard object part (transform with the scale, render box, bounding radius, material).

RCOL v2 layout (little-endian; every section starts 4-byte aligned, offsets from the file start):
  0   char[4] 'RCOL'
  4   u32  version = 1
  8   u32  nV                         vertices                              (Grid +0x50)
  12  u32  nF                         faces                                 (Grid +0x70 / 3)
  16  f32  minX, minZ, maxX, maxZ     gcm bbox                              (Grid +0x0c, +0x14)
  32  u32  dim                        top grid dim x dim (256)              (Grid +0x2c)
  36  u32  nCellList                  u16 block ids incl. 0xffff terminators (Grid +0x40)
  40  u32  nB                         blocks, file order, empty ones kept   (Grid +0x1c)
  44  u32  nOff                       sum of block dim^2 (u16 sub-cell offsets)
  48  u32  nList16                    u16 sub-cell list entries (with terminators)
  52  u32  nList32                    u32 sub-cell list entries (with terminators)
  56  u32  flags                      bit0: I is u16
  60  u32  nObst                      obstacle records (OBST_STRIDE f32 each)
  64  u32  nHull                      hull points (f32 x 3, sim space)
  68  u32  obstStride                 = OBST_STRIDE
  72  u32  nMesh                      object collision meshes (v2)
  76  u32  nMV                        their vertices
  80  u32  nMT                        their triangles
  84  u32  nInst                      object collision instances
  88  u32  instStride                 = INST_STRIDE
  92  u32  reserved                   header = 96 bytes
      f32  V[3 nV]
      u16|u32 I[3 nF]
      u8   M[nF]                      raw material byte (c_MATERIAL_ROAD_*, gcm.md §4)
      f32  FN[3 nF]                   stored face normals (exact)
      u16  cellList[nCellList]        cell (i, j) list starts after the (i*dim + j)-th terminator
      f32  blkF[8 nB]                 bmin.x, bmin.y, bmin.z, bmax.x, bmax.y, bmax.z, invX, invZ  (block +0x00..+0x1c)
      u32  blkU[5 nB]                 dim, use16, base, offBase (into off), listBase (into list16 | list32)
      u16  off[nOff]                  per block: dim^2 starts of its sub-cell lists (block +0x2c, relative)
      u16  list16[nList16]            per block (use16): face id - base, lists ended by 0xffff (block +0x3c)
      u32  list32[nList32]            per block (!use16): face id, lists ended by 0xffffffff (block +0x4c)
      f32  obst[OBST_STRIDE nObst]    see OBST_* below (sim space)
      f32  hull[3 nHull]              loose-part hull points (.col), sim space
      f32  mesh[8 nMesh]              tri0, nTri, then the AABB of the mesh's vertices min xyz, max xyz (the
                                      engine's FUN_004bbcb0 box, tested by 0x597810 before any triangle)
      f32  mV[3 nMV]                  vertices, the mesh's local frame (CollisionMesh.Simple +0x28)
      f32  mTN[3 nMT]                 per triangle: the STORED normal of its BSP record (the query uses its negation)
      u32  mTI[4 nMT]                 per triangle: i0, i1, i2 (absolute into mV), pad (the query's material out)
      f32  inst[INST_STRIDE nInst]    see INST_* below (sim space)
"""
import math
import os
import struct
import sys

import numpy as np

import fmt_gcm as G

PART = 'collision'
MAGIC = b'RCOL'
VERSION = 2
HEADER_SIZE = 96

# --------------------------------------------------------------------------------------------- obstacles
# One record per proxy cylinder (f32 each), WorldQuery.obstaclesNear (the autopilot's avoidance, and the car's
# stand-in physics on worlds without object meshes). A compact footprint (aspect <= 1.25, half <= 6 m) is one
# cylinder of its larger half extent; any other hard footprint above 0.6 m (fence panels, barriers, boards, curb
# walls, buildings) becomes a chain of small cylinders along its edges (shape CHAIN). The car itself collides with
# the object meshes (inst).
OBST_STRIDE = 16
O_X, O_Y, O_Z, O_RADIUS, O_HEIGHT, O_KIND, O_FLAGS, O_MATERIAL, O_MASS, O_OBJECT, O_SHAPE, O_HULL0, O_HULLN, \
    O_YAW, O_TEMPLATE = range(15)
# flags
F_HARD = 1          # static collision geometry (CollisionMesh.Simple in the object mesh): hits the car
F_DYNAMIC = 2       # PhyObject (loose part with a .col hull and a mass: the original knocks it over)
F_SOFT = 4          # hasCollision 1 without any collision geometry (bushes: no hard hit in the original)
# shapes
S_CYLINDER, S_CHAIN = 0, 1

COMPACT_MAX_HALF = 6.0  # m: a hard footprint is compact (one cylinder) when half <= this and aspect <= COMPACT_ASPECT
COMPACT_ASPECT = 1.25   #    (near-square / round: the cylinder overhangs the narrow sides by <= 25 %); every other
                        #    hard footprint above 2 CHAIN_RADIUS (fence panels, barriers, boards, curbs) is a chain
CHAIN_RADIUS = 0.3      # m: chain cylinder radius
CHAIN_STEP = 0.5        # m: chain sample spacing (< 2 radius: no gaps)
FAR_LIMIT = 1.0e5       # m: placements farther than this from the sim origin are editor debris, dropped (5 truck3
                        #    instances in hillclimb3b/3c and iceracing3 sit at ~1e7 m: unreachable, never drawn)

KINDS = ('tree', 'pine', 'bush', 'rock', 'boulder', 'post', 'sign', 'barrier', 'fence', 'tyreStack', 'cone',
         'spectator', 'tent', 'house', 'pole', 'grandstand', 'banner')

# --------------------------------------------------------------------------------------------- object meshes
# One record per hard object part (f32 each): the transform the original's mesh-instance query uses (0x591c20:
# diag(scale)·R rows + the translation; v_sim = v_local · M + T), the mesh, and what the object pass FUN_004a7bc0
# reads before it queries the mesh: the object's bounding radius (object +8: half the diagonal of the scaled render
# box, = the MergeObjects tree leaf radius), its bounding centre (+0xc) and the geometry box (vtbl+0x1c, the render
# box; its corners go through the transform for the overlap test against the car's box, FUN_005d5fe0).
INST_STRIDE = 32
(I_M, I_T, I_MESH, I_MATERIAL, I_RADIUS, I_OBJECT, I_TEMPLATE, I_BOXMIN, I_BOXMAX, I_CENTRE, I_KIND,
 I_FLAGS) = (0, 9, 12, 13, 14, 15, 16, 17, 20, 23, 26, 27)
IF_COLOUR = 1           # the geometry answers the colour interface 0xa5c048fc (every Standard/TreeMesh instance):
                        # the object pass then gates on |T - car| <= 0.2·radius + 1.5 (0x4a8008)


def _pad4(b):
    return b + b'\0' * ((-len(b)) % 4)


# ============================================================================================= gcm
def pack_gcm(g):
    """Track.gcm (fmt_gcm.Gcm) -> (sections list, header fields). Arrays unchanged, file order."""
    probs = G.check_gcm(g)
    if probs:
        raise ValueError('Track.gcm structure: ' + '; '.join(probs[:4]))
    if g.version != 3 or g.leftover:
        raise ValueError('Track.gcm: version %d, %d leftover bytes' % (g.version, g.leftover))
    dim = int(g.dim)
    cs = g.cell_start.astype(np.int64)
    term = np.nonzero(g.cell_list == 0xffff)[0]
    # the runtime rebuilds cellStart as the prefix of the terminators: prove it equals the stored array
    rebuilt = np.concatenate([[0], term[:-1] + 1])
    if len(term) != dim * dim or not np.array_equal(rebuilt, cs):
        raise ValueError('cellStart is not the terminator prefix (u16 block-id overflow?)')
    nV, nF = len(g.V), g.nfaces
    u16 = nV <= 65536
    blkF, blkU, offs, l16, l32 = [], [], [], [], []
    n_off = n16 = n32 = 0
    for b in g.blocks:
        if len(b.off) != b.dim * b.dim:
            raise ValueError('block %d: offsets' % b.index)
        if b.use16 not in (0, 1):
            raise ValueError('block %d: use16 = %d' % (b.index, b.use16))
        blkF.append([b.bmin[0], b.bmin[1], b.bmin[2], b.bmax[0], b.bmax[1], b.bmax[2], b.inv[0], b.inv[1]])
        if b.use16:
            blkU.append([b.dim, 1, b.base, n_off, n16])
            l16.append(b.list16)
            n16 += len(b.list16)
        else:
            blkU.append([b.dim, 0, 0, n_off, n32])      # base is garbage when use16 = 0 (gcm.md §2); unused
            l32.append(b.list32)
            n32 += len(b.list32)
        offs.append(b.off)
        n_off += len(b.off)
        if (b.use16 and len(b.list16) > 65536) or (not b.use16 and len(b.list32) > 65536):
            raise ValueError('block %d: list longer than its u16 offsets can address' % b.index)
    cat = lambda parts, dt: (np.concatenate(parts).astype(dt) if parts else np.zeros(0, dt))  # noqa: E731
    sections = [
        ('V', g.V.astype('<f4').tobytes()),
        ('I', g.I.astype('<u2' if u16 else '<u4').tobytes()),
        ('M', g.M.astype('u1').tobytes()),
        ('FN', g.FN.astype('<f4').tobytes()),
        ('cellList', g.cell_list.astype('<u2').tobytes()),
        ('blkF', np.array(blkF, np.float32).reshape(-1, 8).astype('<f4').tobytes()),
        ('blkU', np.array(blkU, np.int64).reshape(-1, 5).astype('<u4').tobytes()),
        ('off', cat(offs, '<u2').tobytes()),
        ('list16', cat(l16, '<u2').tobytes()),
        ('list32', cat(l32, '<u4').tobytes()),
    ]
    hdr = dict(nV=nV, nF=nF, bbox=[float(g.bmin[0]), float(g.bmin[1]), float(g.bmax[0]), float(g.bmax[1])],
               dim=dim, nCellList=int(len(g.cell_list)), nB=len(g.blocks), nOff=n_off, nList16=n16,
               nList32=n32, u16=u16)
    return sections, hdr


def assemble(hdr, sections, obst, hull, om=None):
    """Header + sections (4-byte aligned) -> (bytes, {name: [offset, byteLength]}). `om` = object meshes
    (mesh, mV, mTN, mTI, inst arrays; build_obstacles)."""
    if om is None:
        om = empty_object_meshes()
    secs = list(sections) + [('obst', obst.astype('<f4').tobytes()), ('hull', hull.astype('<f4').tobytes()),
                             ('mesh', om['mesh'].astype('<f4').tobytes()), ('mV', om['mV'].astype('<f4').tobytes()),
                             ('mTN', om['mTN'].astype('<f4').tobytes()), ('mTI', om['mTI'].astype('<u4').tobytes()),
                             ('inst', om['inst'].astype('<f4').tobytes())]
    head = MAGIC + struct.pack('<3I4f9I', VERSION, hdr['nV'], hdr['nF'], *hdr['bbox'], hdr['dim'],
                               hdr['nCellList'], hdr['nB'], hdr['nOff'], hdr['nList16'], hdr['nList32'],
                               1 if hdr['u16'] else 0, len(obst), len(hull))
    head += struct.pack('<6I', OBST_STRIDE, len(om['mesh']), len(om['mV']), len(om['mTN']), len(om['inst']),
                        INST_STRIDE)
    head += b'\0' * (HEADER_SIZE - len(head))
    assert len(head) == HEADER_SIZE
    out = [head]
    table = {}
    o = HEADER_SIZE
    for name, data in secs:
        table[name] = [o, len(data)]
        p = _pad4(data)
        out.append(p)
        o += len(p)
    return b''.join(out), table


# ============================================================================================= obstacles
_LIB = {}


def _objects_lib(full):
    """fmt_objects Vfs + library + resolver (once per worker process; the library is the same for all stages)."""
    if full not in _LIB:
        import fmt_objects as O
        vfs = O.Vfs(full)
        lib = O.load_library(vfs)
        _LIB[full] = (O, vfs, lib, O.Resolver(vfs, lib), {})
    return _LIB[full]


def _mesh_collision_verts(O, vfs, info, cache):
    """A template mesh's CollisionMesh.Simple (standardmesh.md §2.2) as (V (n, 3) local, I (m, 3), TN (m, 3) the
    stored normals, pad (m,)) taken from the 32-byte BSP tri records the query 0x597810 reads, + the mesh path;
    or None."""
    mf = info.get('meshFiles') or []
    if not mf:
        return None
    path = mf[0]['path']
    if path in cache:
        return cache[path]
    import fmt_standardmesh as SM
    v = None
    real = vfs.find(path)
    if real:
        m = SM.parse_tm(real, keep_data=False) if path.endswith('.tm') else SM.parse_sm(real, keep_data=False)
        c = m.get('collision')
        if c and c['vertices'] and c['indices'] and c.get('bspTris'):
            V = np.array([x[:3] for x in c['vertices']], np.float64)
            T = c['bspTris']
            I = np.array([t[4:7] for t in T], np.int64).reshape(-1, 3)
            # the records duplicate the face arrays (standardmesh.md §2.2, [E] 316/316): keep the build honest
            if not np.array_equal(I.reshape(-1), np.array(c['indices'], np.int64)) or I.max() >= len(V):
                raise ValueError('%s: CollisionMesh BSP records differ from the index array' % path)
            TN = np.array([t[0:3] for t in T], np.float64)
            pad = np.array([t[7] for t in T], np.int64)
            v = (V, I, TN, pad, path)
    cache[path] = v
    return v


def empty_object_meshes():
    return {'mesh': np.zeros((0, 8), np.float32), 'mV': np.zeros((0, 3), np.float32),
            'mTN': np.zeros((0, 3), np.float32), 'mTI': np.zeros((0, 4), np.uint32),
            'inst': np.zeros((0, INST_STRIDE), np.float32)}


class _ObjectMeshes:
    """Accumulates the stage's object collision meshes (each used mesh once) and the hard-object instances."""

    def __init__(self):
        self.index = {}
        self.mesh, self.mV, self.mTN, self.mTI, self.inst = [], [], [], [], []
        self.nv = self.nt = 0

    def mesh_id(self, cv):
        V, I, TN, pad, path = cv
        if path not in self.index:
            self.index[path] = len(self.mesh)
            lo, hi = V.min(0), V.max(0)
            self.mesh.append([self.nt, len(I), *lo.tolist(), *hi.tolist()])
            self.mV.extend(V.tolist())
            self.mTN.extend(TN.tolist())
            self.mTI.extend([[int(a) + self.nv, int(b) + self.nv, int(c) + self.nv, int(p) & 0xffffffff]
                             for (a, b, c), p in zip(I.tolist(), pad.tolist())])
            self.nv += len(V)
            self.nt += len(I)
        return self.index[path]

    def add(self, cv, M, t, box, material, obj, tpl, kind):
        """One hard part: v_sim = v_local · M + t (M = diag(scale)·R rows, as 0x591c20 composes them)."""
        lo, hi = np.array(box[0], np.float64), np.array(box[1], np.float64)
        rec = [0.0] * INST_STRIDE
        rec[I_M:I_M + 9] = M.reshape(-1).tolist()
        rec[I_T:I_T + 3] = t.tolist()
        rec[I_MESH] = self.mesh_id(cv)
        rec[I_MATERIAL] = material
        rec[I_RADIUS] = 0.5 * float(np.linalg.norm((hi - lo) @ M))
        rec[I_OBJECT], rec[I_TEMPLATE], rec[I_KIND], rec[I_FLAGS] = obj, tpl, kind, IF_COLOUR
        rec[I_BOXMIN:I_BOXMIN + 3] = lo.tolist()
        rec[I_BOXMAX:I_BOXMAX + 3] = hi.tolist()
        rec[I_CENTRE:I_CENTRE + 3] = (((lo + hi) * 0.5) @ M + t).tolist()
        self.inst.append(rec)

    def arrays(self):
        if not self.inst:
            return empty_object_meshes()
        return {'mesh': np.array(self.mesh, np.float32).reshape(-1, 8),
                'mV': np.array(self.mV, np.float32).reshape(-1, 3),
                'mTN': np.array(self.mTN, np.float32).reshape(-1, 3),
                'mTI': np.array(self.mTI, np.uint32).reshape(-1, 4),
                'inst': np.array(self.inst, np.float32).reshape(-1, INST_STRIDE)}


def _kind(info, flags, half):
    """SceneryKind of a proxy (debug / effects; the sim treats every hard obstacle alike)."""
    n = (info.get('template', '') + ' ' + ' '.join(f['path'] for f in info.get('meshFiles') or [])).lower()
    k = info.get('kind')
    if flags & F_SOFT:
        return 'bush'
    if k in ('billboardTree', 'tree3d', 'mergeVeg', 'sidescreen'):
        if 'bush' in n:
            return 'bush'
        return 'pine' if any(s in n for s in ('pine', 'fir', 'spruce', 'gran', 'tall')) else 'tree'
    if k == 'rock':
        return 'boulder' if half > 1.5 else 'rock'
    for key, kind in (('cone', 'cone'), ('spectator', 'spectator'), ('sign', 'sign'), ('banner', 'banner'),
                      ('barrel', 'tyreStack'), ('tyre', 'tyreStack'), ('checkpoint', 'pole'), ('pole', 'pole'),
                      ('fence', 'fence'), ('tent', 'tent'), ('house', 'house'), ('cabin', 'house'),
                      ('stand', 'grandstand'), ('curb', 'barrier'), ('wall', 'barrier'), ('plastic', 'barrier')):
        if key in n:
            return kind
    return 'post' if half < 0.5 else 'barrier'


def _chain(P, I):
    """Chain proxy of a large collision mesh (sim-space vertices P, triangles I): sample every triangle densely
    (<= CHAIN_STEP/2 in 3-D), bin the samples on a CHAIN_STEP xz grid keeping each cell's y range (a wall's cell
    spans its full height, an overhead beam's cell only the beam: cars pass under gantries), then drop the
    cells surrounded on all 8 sides (unreachable from outside). -> list of (x, z, base y, top y)."""
    h = CHAIN_STEP * 0.5
    pts = []
    for tri in I:
        a, b, c = P[tri[0]], P[tri[1]], P[tri[2]]
        nu = max(1, int(math.ceil(np.linalg.norm(b - a) / h)))
        nv = max(1, int(math.ceil(np.linalg.norm(c - a) / h)))
        n = max(nu, nv, int(math.ceil(np.linalg.norm(c - b) / h)))
        u, v = np.meshgrid(np.arange(n + 1) / n, np.arange(n + 1) / n)
        k = (u + v) <= 1.0 + 1e-9
        u, v = u[k], v[k]
        pts.append(a + np.outer(u, b - a) + np.outer(v, c - a))
    if not pts:
        return []
    S = np.concatenate(pts)
    key = np.floor(S[:, [0, 2]] / CHAIN_STEP).astype(np.int64)
    cells = {}
    for (i, j), (x, y, z) in zip(key.tolist(), S.tolist()):
        e = cells.get((i, j))
        if e is None:
            cells[(i, j)] = [x, z, y, y, 1]
        else:
            e[0] += x
            e[1] += z
            e[2] = min(e[2], y)
            e[3] = max(e[3], y)
            e[4] += 1
    out = []
    for (i, j), (sx, sz, y0, y1, n) in cells.items():
        if all((i + di, j + dj) in cells for di in (-1, 0, 1) for dj in (-1, 0, 1)):
            continue
        out.append((sx / n, sz / n, y0, y1))
    return out


def build_obstacles(ctx, stage):
    """Objects.con placements -> (obst f32 (n, OBST_STRIDE), hull f32 (m, 3), stats, template names, object
    meshes). Sim space: sim = world - (2048, H, 2048) (objects.md §1.3); object transform
    v_world = v_local . diag(s) . R + pos with R = Rz(roll) . Rx(pitch) . Ry(yaw) (row vectors)."""
    O, vfs, lib, res, mesh_cache = _objects_lib(ctx.full)
    import fmt_gcm as GG
    con = ctx.vfs.real_path(stage.vpath('Objects.con'))
    if not con:
        return (np.zeros((0, OBST_STRIDE), np.float32), np.zeros((0, 3), np.float32), {'placements': 0}, [],
                empty_object_meshes())
    placements, _ = O.parse_objects_con(con)
    off = np.array(stage.world_offset, np.float64)
    rows, hull = [], []
    om = _ObjectMeshes()
    stats = {'placements': len(placements), 'objects': 0, 'hard': 0, 'dynamic': 0, 'soft': 0, 'chains': 0,
             'chainCylinders': 0, 'farDropped': 0, 'meshInstances': 0}
    tpl_names = []
    tpl_index = {}
    col_cache = {}

    def parts_of(name, M, t, depth=0):
        """(template info, 3x3 row matrix local->parent-world, translation) for a template and its children."""
        info = res.template(name)
        out = [(info, M, t)]
        if depth < 4:
            for ch in info.get('children') or []:
                Rc = np.array(O.rot_matrix(*ch['rot']), np.float64)
                tc = np.array(ch['pos'], np.float64) @ M + t
                out += parts_of(ch['template'], Rc @ M, tc, depth + 1)
        return out

    for k, p in enumerate(placements):
        R = np.array(O.rot_matrix(*p.rot), np.float64)
        s = np.array(p.scale or [1.0, 1.0, 1.0], np.float64)
        M0 = np.diag(s) @ R
        t0 = np.array(p.pos, np.float64) - off
        if not np.isfinite(t0).all() or np.abs(t0).max() > FAR_LIMIT:
            stats['farDropped'] += 1
            continue
        yaw = math.radians(p.rot[0])
        for info, M, t in parts_of(p.template, M0, t0):
            coll = info.get('collision') or {}
            colfile = coll.get('colPointFile')
            hard = coll.get('hasCollision') and info.get('meshHasCollision')
            if not (coll.get('hasCollision') or colfile):
                continue
            name = info.get('template', '')
            if name not in tpl_index:
                tpl_index[name] = len(tpl_names)
                tpl_names.append(name)
            mat = float(coll['material']) if coll.get('material') not in (None, '') else -1.0
            mass = float(coll.get('mass') or 0.0)
            hstart = hcount = 0
            if info.get('type', '').lower() == 'phyobject' and colfile:
                # loose part (objects.md §7.3): the .col hull (gcm.md §6) is its physics shape
                real = vfs.find(colfile)
                if not real:
                    continue
                if real not in col_cache:
                    col_cache[real] = GG.read_col(real)[0].astype(np.float64)
                L = col_cache[real]
                P = L @ M + t
                flags = F_DYNAMIC
                hstart, hcount = len(hull), len(P)
                hull.extend(P.tolist())
                tris = None
            elif hard:
                cv = _mesh_collision_verts(O, vfs, info, mesh_cache)
                if cv is None:
                    continue
                L, tris = cv[0], cv[1]
                P = L @ M + t
                flags = F_HARD
            else:
                # flag-only collision (bushes): the render bbox footprint, informational (never hard)
                bb = info.get('meshBBox')
                if not bb:
                    continue
                L = np.array([[bb[i][0], bb[j][1], bb[l][2]] for i in (0, 1) for j in (0, 1) for l in (0, 1)],
                             np.float64)
                P = L @ M + t
                flags = F_SOFT
                tris = None
            stats['objects'] += 1
            stats['hard' if flags & F_HARD else 'dynamic' if flags & F_DYNAMIC else 'soft'] += 1
            yb, yt = float(P[:, 1].min()), float(P[:, 1].max())
            # footprint: local-frame AABB of the shape mapped through the transform (upright objects)
            lmin, lmax = L.min(0), L.max(0)
            c_loc = (lmin + lmax) * 0.5
            cw = c_loc @ M + t
            ax = np.linalg.norm(M[0]) * (lmax[0] - lmin[0]) * 0.5
            az = np.linalg.norm(M[2]) * (lmax[2] - lmin[2]) * 0.5
            half = max(ax, az)
            kind = KINDS.index(_kind(info, flags, half))
            base = [0.0] * OBST_STRIDE
            base[O_KIND], base[O_FLAGS], base[O_MATERIAL], base[O_MASS] = kind, flags, mat, mass
            base[O_OBJECT], base[O_HULL0], base[O_HULLN], base[O_YAW] = k, hstart, hcount, yaw
            base[O_TEMPLATE] = tpl_index[name]
            if flags & F_HARD:
                # the physics shape: the mesh itself under the part's transform (render box: the geometry's);
                # a zero scale (editor debris, `Object.geometry.scale 0/0/0`) has no shape to hit
                if abs(np.linalg.det(M)) > 1e-12:
                    box = info.get('meshBBox') or [lmin.tolist(), lmax.tolist()]
                    om.add(cv, M, t, box, mat, k, tpl_index[name], kind)
                    stats['meshInstances'] += 1
                else:
                    stats['degenerateMeshes'] = stats.get('degenerateMeshes', 0) + 1
            compact = half <= COMPACT_MAX_HALF and half <= COMPACT_ASPECT * max(1e-3, min(ax, az))
            if flags & F_HARD and not compact and half > 2 * CHAIN_RADIUS and tris is not None:
                pts = _chain(P, tris)
                stats['chains'] += 1
                stats['chainCylinders'] += len(pts)
                for x, z, y0, y1 in pts:
                    r = list(base)
                    r[O_X], r[O_Y], r[O_Z], r[O_RADIUS], r[O_HEIGHT], r[O_SHAPE] = x, y0, z, CHAIN_RADIUS, \
                        max(0.05, y1 - y0), S_CHAIN
                    rows.append(r)
            else:
                # one cylinder around a compact footprint (aspect <= COMPACT_ASPECT) or a small one: radius = the
                # footprint's larger half extent (not its corner: a round trunk keeps its radius, a square box
                # overhangs nowhere by more than the aspect allows); dynamic parts the farthest hull point; soft
                # bushes the smaller half extent
                d = np.hypot(P[:, 0] - cw[0], P[:, 2] - cw[2])
                r = list(base)
                r[O_X], r[O_Y], r[O_Z] = float(cw[0]), yb, float(cw[2])
                if flags & F_SOFT:
                    r[O_RADIUS] = float(min(ax, az))
                elif flags & F_HARD:
                    r[O_RADIUS] = float(min(half, d.max()))
                else:
                    r[O_RADIUS] = float(d.max())
                r[O_HEIGHT], r[O_SHAPE] = max(0.05, yt - yb), S_CYLINDER
                rows.append(r)
    obst = np.array(rows, np.float32).reshape(-1, OBST_STRIDE)
    hullA = np.array(hull, np.float32).reshape(-1, 3)
    stats['records'] = len(obst)
    return obst, hullA, stats, tpl_names, om.arrays()


# ============================================================================================= part
def build_stage(ctx, stage):
    src = ctx.vfs.real_path(stage.vpath('Mesh/Track.gcm'))
    if not src:
        return                                       # no collision mesh (not a race stage)
    g = G.read_gcm(src)
    sections, hdr = pack_gcm(g)
    obst, hull, ostats, tpl_names, om = build_obstacles(ctx, stage)
    data, table = assemble(hdr, sections, obst, hull, om)
    ctx.out.write_bytes('collision.bin', data)
    mats = np.bincount(g.M.astype(np.int64), minlength=256)
    meta = {
        'version': VERSION,
        'format': 'RCOL',
        'source': stage.vpath('Mesh/Track.gcm'),
        'stage': stage.to_json(),
        'worldOffset': list(stage.world_offset),
        'nV': hdr['nV'], 'nF': hdr['nF'], 'nB': hdr['nB'], 'dim': hdr['dim'],
        'bbox': hdr['bbox'],
        'yRange': [float(g.V[:, 1].min()), float(g.V[:, 1].max())],
        'sections': table,
        'bytes': len(data),
        'materials': {str(i): int(c) for i, c in enumerate(mats) if c},
        'zeroNormals': int((np.abs(g.FN).sum(1) == 0).sum()),
        'obstacles': {'stride': OBST_STRIDE, 'records': int(len(obst)), 'hullPoints': int(len(hull)),
                      'kinds': list(KINDS), 'templates': tpl_names, 'stats': ostats,
                      'flags': {'hard': F_HARD, 'dynamic': F_DYNAMIC, 'soft': F_SOFT},
                      'shapes': {'cylinder': S_CYLINDER, 'chain': S_CHAIN}},
        'objectMeshes': {'meshes': int(len(om['mesh'])), 'vertices': int(len(om['mV'])),
                         'triangles': int(len(om['mTN'])), 'instances': int(len(om['inst'])),
                         'instStride': INST_STRIDE},
    }
    ctx.out.commit(meta)
    ctx.log('Track.gcm %d faces %d blocks -> %d bytes; obstacles %d records (%s)' % (
        hdr['nF'], hdr['nB'], len(data), len(obst),
        ', '.join('%s %d' % kv for kv in ostats.items())))


if __name__ == '__main__':   # pragma: no cover - the part runs through tools/assets/build.py
    sys.exit('run through: npm run assets -- --parts collision [--stages ids]')
