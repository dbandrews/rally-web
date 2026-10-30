#!/usr/bin/env python3
"""fmt_gcm.py - reader + faithful query port for the original game's collision formats.

Formats (spec: research/formats/gcm.md):
  .gcm   dice.ref2.geom.CollisionMesh.Grid, version 3   (track collision: Mesh/Track.gcm, Mesh/TrackFull.gcm)
         loader  0x5955f0 (secondary-vtable slot 4 of class 0x62fcc2fe, ctor FUN_00595360)
         block   FUN_005957c0, writer 0x595960/0x595b00
         query   0x595c50 (grid ray) -> FUN_00594330 (block ray) -> FUN_00595020 (segment/triangle)
  .col   text point lists (count line, then "x y z" lines) - object/car collision hull points
  .cm    NOT collision: dice.ref2.geom GeometryTemplate.CarMesh render meshes (car bodies, wheels, cups);
         only the header is sniffed here (see gcm.md section 6).

Library:
  g = read_gcm(path)            -> Gcm (numpy arrays, every section of the file)
  g.raycast(origin, ray)        -> Hit | None   (faithful port of the original's segment query, sim/world frame)
  g.height_at(x, z, y_top, y_bot) -> Hit | None (vertical query from y_top down to y_bot)
  read_col(path)                -> (n,3) float32 array
CLI:
  fmt_gcm.py info <file.gcm>...
  fmt_gcm.py validate [--root research/full]      parse every .gcm/.col/.cm, report leftovers + structure checks
  fmt_gcm.py splines [--json out.json]            gcm height under the AI centre spline, all 48 stages
  fmt_gcm.py render <outdir>                       top-down material PNGs (per family) + spline overlay
  fmt_gcm.py trace <frida run.bin> <Track.gcm>     replay the recorded wheel/hull rays of the running original
  fmt_gcm.py export <Track.gcm> <out.bin>         compact web binary (see gcm.md "Web plan")
Run with: research/.venv/bin/python -I research/tools/fmt_gcm.py ...
"""
import glob
import json
import math
import os
import re
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # rally-web: data roots from _paths.py
from _paths import FULL as ROOT, REPO  # noqa: E402

# c_MATERIAL_ROAD_* enum (exe strings 0x85d0f0..0x85ceac, pushes 0x743b3b-0x74467d; ids = PhysicsParam rows)
MATERIALS = ['GRASS', 'ASPHALT', 'GRAVEL', 'WATERASPHALT', 'MUD', 'SAND', 'WOOD', 'SNOW', 'SNOWCHUNKY', 'SNOWDEEP',
             'SNOWASPHALT', 'SNOWDITCH', 'GRAVELDEEP', 'COBBLES', 'LEAF', 'ASPHALTGRASS', 'GRAVELGRASS', 'MUDGRASS',
             'MUDDITCH', 'SANDDEEP', 'ICEASPHALT', 'SANDDARK', 'SANDDARKDEEP', 'DUMMY']

BRESENHAM_LIMIT = 0.05      # console var "bresenhamLimit" (0x84cc90, squared into 0x91ba1c by 0x593a70)
F32 = np.float32


class GcmBlock:
    """One 0x5c-byte block (FUN_005957c0)."""
    __slots__ = ('bmin', 'bmax', 'inv', 'dim', 'use16', 'base', 'off', 'list16', 'list32', 'index')


class Hit:
    __slots__ = ('point', 'normal', 'cos', 'depth', 'material', 'face', 'block', 't')

    def __repr__(self):
        return 'Hit(face=%d mat=%d t=%.4f depth=%.4f cos=%.4f point=%s normal=%s)' % (
            self.face, self.material, self.t, self.depth, self.cos,
            tuple(round(v, 4) for v in self.point), tuple(round(v, 4) for v in self.normal))


class Gcm:
    """All sections of a version-3 CollisionMesh.Grid file, in file order."""

    def __init__(self):
        self.path = None
        self.version = 0
        self.bmin = None          # (2,) f32  minX, minZ          obj+0x0c
        self.bmax = None          # (2,) f32  maxX, maxZ          obj+0x14
        self.dim = 0              # u32 top grid is dim x dim     obj+0x2c
        self.cell_start = None    # (dim*dim,) u32 -> index into cell_list   obj+0x30
        self.cell_list = None     # u16 block ids, 0xffff ends each cell     obj+0x40
        self.V = None             # (nV,3) f32 vertices                      obj+0x50
        self.I = None             # (3*nF,) u32 vertex indices               obj+0x70
        self.VN = None            # (nVN,3) f32 vertex normals (TrackFull)   obj+0x60
        self.VNI = None           # (3*nF or 0,) u32 normal index / corner   obj+0x80
        self.M = None             # (nF,) u8 material id                     obj+0xa0
        self.FN = None            # (nF,3) f32 face normals                  obj+0x90
        self.blocks = []          # GcmBlock                                 obj+0x1c (0x5c each)
        self.size = 0
        self.leftover = 0
        self._py = None

    # ------------------------------------------------------------------ derived
    @property
    def nfaces(self):
        return len(self.I) // 3

    @property
    def tris(self):
        return self.I.reshape(-1, 3)

    def block_faces(self, b):
        """Unique global face ids referenced by a block (both list encodings)."""
        if b.use16:
            l = b.list16[b.list16 != 0xffff].astype(np.int64) + b.base
        else:
            l = b.list32[b.list32 != 0xffffffff].astype(np.int64)
        return np.unique(l)

    # ------------------------------------------------------------------ faithful query (python port)
    def _prep(self):
        if self._py is not None:
            return self._py
        py = {}
        py['V'] = self.V.astype(np.float64).tolist()
        py['I'] = self.I.tolist()
        py['FN'] = self.FN.astype(np.float64).tolist()
        py['M'] = self.M.astype(np.int8).tolist()          # movsx: signed byte (0x594fce)
        py['cs'] = self.cell_start.tolist()
        py['cl'] = self.cell_list.tolist()
        bl = []
        for b in self.blocks:
            bl.append((float(b.bmin[0]), float(b.bmin[2]), float(b.bmax[0]), float(b.bmax[2]),
                       float(b.inv[0]), float(b.inv[1]), int(b.dim), bool(b.use16), int(b.base),
                       b.off.tolist(), b.list16.tolist() if b.use16 else b.list32.tolist()))
        py['B'] = bl
        dimf = float(F32(self.dim))
        py['inv'] = (float(F32(dimf / (float(self.bmax[0]) - float(self.bmin[0])))),
                     float(F32(dimf / (float(self.bmax[1]) - float(self.bmin[1])))))
        self._py = py
        return py

    def raycast(self, origin, ray, cache=None, slot=None, nearest=False):
        """Port of 0x595c50: segment query origin -> origin+ray (ray = full vector, not unit).

        Returns the FIRST hit in traversal order (grid cells along the ray, block ids in cell order, faces in
        cell-list order), exactly like the original. `nearest=True` instead scans all candidates and returns
        the smallest t (for comparison). `cache`/`slot` emulate the per-slot face cache (0x911dc8/0x916be8).
        """
        py = self._prep()
        ox, oy, oz = (float(v) for v in origin)
        rx, ry, rz = (float(v) for v in ray)
        minx, minz = float(self.bmin[0]), float(self.bmin[1])
        maxx, maxz = float(self.bmax[0]), float(self.bmax[1])
        invx, invz = py['inv']
        dim = self.dim
        if rx * rx + rz * rz <= BRESENHAM_LIMIT * BRESENHAM_LIMIT:
            cells = [(_trunc((ox - minx) * invx), _trunc((oz - minz) * invz))]
        else:
            c = _clip2d(ox, oz, ox + rx, oz + rz, minx, maxx, minz, maxz)
            if c is None:
                return None
            ax, az, bx, bz = c
            cells = _bresenham(_trunc((ax - minx) * invx), _trunc((az - minz) * invz),
                               _trunc((bx - minx) * invx), _trunc((bz - minz) * invz))
        best = None
        cs, cl = py['cs'], py['cl']
        last_block = cache.get(('b', slot), -1) if cache is not None else -1
        for (i, j) in cells:
            if not (0 <= i < dim and 0 <= j < dim):
                continue
            k = cs[i * dim + j]
            while True:
                bid = cl[k]
                if bid == 0xffff:
                    break
                if cache is not None and last_block != bid:
                    cache[('f', slot)] = -1                  # 0x595eb5: block changed -> forget face
                h = self._block_ray(bid, ox, oy, oz, rx, ry, rz, cache, slot, nearest)
                if h is not None:
                    if not nearest:
                        if cache is not None:
                            cache[('b', slot)] = bid
                        return h
                    if best is None or h.t < best.t:
                        best = h
                k += 1
        if cache is not None and not nearest:
            cache[('b', slot)] = -1                          # 0x595f32 (miss forgets the block)
        return best

    def _block_ray(self, bid, ox, oy, oz, rx, ry, rz, cache, slot, nearest):
        """Port of FUN_00594330."""
        py = self._py
        bminx, bminz, bmaxx, bmaxz, ibx, ibz, bdim, use16, base, off, lst = py['B'][bid]
        if rx * rx + rz * rz <= BRESENHAM_LIMIT * BRESENHAM_LIMIT:
            # half-open xz box test (0x594477..0x5944bf)
            if not (bminx <= ox < bmaxx and bminz <= oz < bmaxz):
                return None
            cells = [(_trunc((ox - bminx) * ibx), _trunc((oz - bminz) * ibz))]
        else:
            c = _clip2d(ox, oz, ox + rx, oz + rz, bminx, bmaxx, bminz, bmaxz)
            if c is None:
                return None
            ax, az, bx, bz = c
            cells = _bresenham(_trunc((ax - bminx) * ibx), _trunc((az - bminz) * ibz),
                               _trunc((bx - bminx) * ibx), _trunc((bz - bminz) * ibz))
        ex, ey, ez = ox + rx, oy + ry, oz + rz                # segment end = origin + ray (unclipped)
        term = 0xffff if use16 else 0xffffffff
        best = None
        cached = cache.get(('f', slot), -1) if cache is not None else -1
        for (i, j) in cells:
            if not (0 <= i < bdim and 0 <= j < bdim):
                continue
            if cached != -1 and not nearest:                  # cached face first (0x594664..0x594a2a)
                h = self._tri(cached, ox, oy, oz, ex, ey, ez, rx, ry, rz)
                if h is not None:
                    h.block = bid
                    return h
            k = off[i * bdim + j]
            while True:
                f = lst[k]
                if f == term:
                    break
                if use16:
                    f += base
                h = self._tri(f, ox, oy, oz, ex, ey, ez, rx, ry, rz)
                if h is not None:
                    h.block = bid
                    if not nearest:
                        if cache is not None:
                            cache[('f', slot)] = f
                        return h
                    if best is None or h.t < best.t:
                        best = h
                k += 1
        if cache is not None and not nearest:
            cache[('f', slot)] = -1                            # 0x594b41
        return best

    def _tri(self, f, ox, oy, oz, ex, ey, ez, rx, ry, rz):
        """Port of FUN_00595020 (one-sided segment/triangle test, dominant-axis 2-D edge test)."""
        py = self._py
        I, V = py['I'], py['V']
        v0 = V[I[3 * f]]
        v1 = V[I[3 * f + 1]]
        v2 = V[I[3 * f + 2]]
        nx, ny, nz = py['FN'][f]
        d1 = (ex - v0[0]) * nx + (ey - v0[1]) * ny + (ez - v0[2]) * nz      # end vs plane
        if d1 > 0.0:
            return None
        d0 = (ox - v0[0]) * nx + (oy - v0[1]) * ny + (oz - v0[2]) * nz      # start vs plane
        if d0 <= 0.0:       # verifier fix: start ON the plane is a miss too (0x59511f `test ah,0x41; jp`
            return None     # continues only for d0 > 0; same in the face-cache path 0x5947d0 `jnp`)
        ax, ay, az = ex - ox, ey - oy, ez - oz
        da = ax * nx + ay * ny + az * nz
        if da >= 0.0:
            return None                                                      # back face / parallel
        t = -(d0 / da)
        if abs(ny) >= 0.7:
            i, j, k = 0, 2, 1
        elif abs(nz) > 0.3:
            i, j, k = 0, 1, 2
        else:
            i, j, k = 1, 2, 0
        o = (ox, oy, oz)
        a = (ax, ay, az)
        hi = t * a[i] + o[i]
        hj = t * a[j] + o[j]
        e1 = (v1[j] - v0[j]) * (hi - v0[i]) - (hj - v0[j]) * (v1[i] - v0[i])
        e2 = (v2[j] - v1[j]) * (hi - v1[i]) - (v2[i] - v1[i]) * (hj - v1[j])
        if (e1 < 0.0 and e2 > 0.0) or (e1 > 0.0 and e2 < 0.0):
            return None
        e3 = (v0[j] - v2[j]) * (hi - v2[i]) - (hj - v2[j]) * (v0[i] - v2[i])
        if (e1 < 0.0 and e3 > 0.0) or (e1 > 0.0 and e3 < 0.0):
            return None
        p = [0.0, 0.0, 0.0]
        p[i], p[j], p[k] = hi, hj, t * a[k] + o[k]
        h = Hit()
        h.point = tuple(p)
        h.normal = (nx, ny, nz)
        h.cos = nx * rx + ny * ry + nz * rz          # *a5 = dot(n, ray)        (0x594fd4)
        h.depth = d1                                 # *a6 = dot(end - v0, n)   (FUN_00595020 p6)
        h.material = py['M'][f]                      # movsx byte               (0x594fce)
        h.face = f
        h.block = -1
        h.t = t
        return h

    def height_at(self, x, z, y_top=1.0e4, y_bot=-1.0e4):
        """Vertical query (the 'lightmap sampler' form 0x675f00 uses y 10000 / ray -20000)."""
        return self.raycast((x, y_top, z), (0.0, y_bot - y_top, 0.0))


def _trunc(v):
    # MSVC __ftol: truncation toward zero (cells left of min clamp to 0 and are then box-tested)
    return int(math.trunc(v))


def _clip2d(x0, z0, x1, z1, minx, maxx, minz, maxz):
    """Cohen-Sutherland in xz (FUN_00593be0, outcodes FUN_00593ac0: 1 z>maxZ, 8 z<minZ, 4 x>maxX, 2 x<minX)."""
    def code(x, z):
        c = 0
        if z > maxz:
            c = 1
        elif z < minz:
            c = 8
        if x > maxx:
            return c | 4
        if x < minx:
            c |= 2
        return c
    c0, c1 = code(x0, z0), code(x1, z1)
    for _ in range(16):
        if c0 == 0 and c1 == 0:
            return x0, z0, x1, z1
        if c0 & c1:
            return None
        c = c0 if c0 else c1
        if c & 1:
            x = (x1 - x0) * (maxz - z0) / (z1 - z0) + x0; z = maxz
        elif c & 8:
            x = (x1 - x0) * (minz - z0) / (z1 - z0) + x0; z = minz
        elif c & 4:
            z = (z1 - z0) * (maxx - x0) / (x1 - x0) + z0; x = maxx
        else:
            z = (z1 - z0) * (minx - x0) / (x1 - x0) + z0; x = minx
        if c == c0:
            x0, z0 = x, z; c0 = code(x0, z0)
        else:
            x1, z1 = x, z; c1 = code(x1, z1)
    return None


def _bresenham(x0, z0, x1, z1):
    """Cell walk of FUN_00593e10: Bresenham plus the corner cell(s) when the line passes near a corner."""
    out = [(x0, z0)]
    dx, dz = x1 - x0, z1 - z0
    sx = -1 if dx < 0 else 1
    sz = -1 if dz < 0 else 1
    dx, dz = abs(dx), abs(dz)
    ix, iz = x0, z0
    if 2 * dz < 2 * dx:
        err = dx
        for _ in range(dx):
            ix += sx
            e = err + 2 * dz
            if 2 * dx < e:
                e -= 2 * dx
                iz += sz
                if err + e < 2 * dx:
                    out.append((ix, iz - sz))
                elif 2 * dx < err + e:
                    out.append((ix - sx, iz))
                else:
                    out.append((ix, iz - sz)); out.append((ix - sx, iz))
            out.append((ix, iz))
            err = e
    elif dz > 0:
        err = dz
        for _ in range(dz):
            iz += sz
            e = err + 2 * dx
            if 2 * dz < e:
                e -= 2 * dz
                ix += sx
                if e + err < 2 * dz:
                    out.append((ix - sx, iz))
                elif 2 * dz < e + err:
                    out.append((ix, iz - sz))
                else:
                    out.append((ix - sx, iz)); out.append((ix, iz - sz))
            out.append((ix, iz))
            err = e
    return out


# ---------------------------------------------------------------------------------------------- reading
class _R:
    def __init__(self, d):
        self.d = d
        self.o = 0

    def u32(self):
        v = struct.unpack_from('<I', self.d, self.o)[0]
        self.o += 4
        return v

    def u8(self):
        v = self.d[self.o]
        self.o += 1
        return v

    def arr(self, dt, n):
        a = np.frombuffer(self.d, dtype=dt, count=n, offset=self.o)
        self.o += a.nbytes
        return a


def read_gcm(path):
    d = open(path, 'rb').read()
    r = _R(d)
    g = Gcm()
    g.path = path
    g.size = len(d)
    g.version = r.u32()
    if g.version != 3:
        raise ValueError('%s: version %d != 3 (loader 0x59560a rejects it)' % (path, g.version))
    g.bmin = r.arr('<f4', 2)
    g.bmax = r.arr('<f4', 2)
    g.dim = r.u32()
    g.cell_start = r.arr('<u4', r.u32())
    g.cell_list = r.arr('<u2', r.u32())
    g.V = r.arr('<f4', 3 * r.u32()).reshape(-1, 3)
    g.I = r.arr('<u4', r.u32())
    g.VN = r.arr('<f4', 3 * r.u32()).reshape(-1, 3)
    g.VNI = r.arr('<u4', r.u32())
    g.M = r.arr('u1', r.u32())
    g.FN = r.arr('<f4', 3 * r.u32()).reshape(-1, 3)
    nb = r.u32()
    for k in range(nb):
        b = GcmBlock()
        b.index = k
        b.bmin = r.arr('<f4', 3)
        b.bmax = r.arr('<f4', 3)
        b.inv = r.arr('<f4', 2)
        b.dim = r.u32()
        b.use16 = r.u8()
        b.base = r.u32()
        b.off = r.arr('<u2', r.u32())
        b.list16 = r.arr('<u2', r.u32())
        b.list32 = r.arr('<u4', r.u32())
        g.blocks.append(b)
    g.leftover = len(d) - r.o
    return g


def check_gcm(g):
    """Structural invariants; returns list of problem strings (empty = OK)."""
    p = []
    nf, nv = g.nfaces, len(g.V)
    if len(g.I) % 3:
        p.append('index count not multiple of 3')
    if len(g.I) and int(g.I.max()) >= nv:
        p.append('vertex index out of range')
    if len(g.M) != nf:
        p.append('materials %d != faces %d' % (len(g.M), nf))
    if len(g.FN) != nf:
        p.append('face normals %d != faces %d' % (len(g.FN), nf))
    if len(g.VN) or len(g.VNI):
        if len(g.VNI) != len(g.I):
            p.append('normal index count %d != index count %d' % (len(g.VNI), len(g.I)))
        elif int(g.VNI.max()) >= len(g.VN):
            p.append('vertex normal index out of range')
    if len(g.cell_start) != g.dim * g.dim:
        p.append('cells %d != dim^2' % len(g.cell_start))
    # cell c owns cell_list[cell_start[c] : cell_start[c+1]]; its last entry must be the 0xffff terminator
    cs = g.cell_start.astype(np.int64)
    ends = np.concatenate([cs[1:], [len(g.cell_list)]]) - 1
    if (cs[0] != 0) or np.any(np.diff(cs) < 1) or np.any(g.cell_list[ends] != 0xffff):
        p.append('cell lists are not consecutive 0xffff-terminated runs')
    nterm = int((g.cell_list == 0xffff).sum())
    if nterm != len(cs):
        # only seen when the file has > 65535 blocks: the u16 cell list cannot hold the id, the exporter
        # truncated it (id & 0xffff) and id 65535 reads as an early terminator in the original (0x595e9b).
        g.warnings = getattr(g, 'warnings', []) + [
            'u16 block-id overflow: %d blocks, %d in-cell 0xffff entries (early terminators), %d distinct ids'
            % (len(g.blocks), nterm - len(cs), len(np.unique(g.cell_list[g.cell_list != 0xffff])))]
    ids = g.cell_list[g.cell_list != 0xffff]
    if len(ids) and int(ids.max()) >= len(g.blocks):
        p.append('block id out of range')
    for b in g.blocks:
        if len(b.off) != b.dim * b.dim:
            p.append('block %d: %d offsets for dim %d' % (b.index, len(b.off), b.dim))
            continue
        lst, t = (b.list16, 0xffff) if b.use16 else (b.list32, 0xffffffff)
        other = b.list32 if b.use16 else b.list16
        if len(other):
            p.append('block %d: unused list not empty' % b.index)
        term = np.nonzero(lst == t)[0]
        if len(term) != len(b.off):
            p.append('block %d: terminators %d != cells %d' % (b.index, len(term), len(b.off)))
            continue
        starts = np.concatenate([[0], term[:-1] + 1])
        if not np.array_equal(starts, b.off.astype(np.int64)):
            p.append('block %d: offsets are not the prefix of the lists' % b.index)
        f = lst[lst != t].astype(np.int64) + (b.base if b.use16 else 0)
        if len(f) and (f.max() >= nf or f.min() < 0):
            p.append('block %d: face id out of range' % b.index)
    return p


def read_col(path):
    """.col 'collision point file' (ObjectTemplate.car_ColPointFile / part_ColPointFile), text, CRLF:
         line 'nPoints' ("%d"), nPoints lines "%f %f %f", line 'nFaces' ("%d"), nFaces lines "%d %d %d %d"
       (FUN_006d62e0 counts points, FUN_006d6430 counts faces, FUN_006d6630 reads both; the point count must
       equal the count line, faces are always quads of point indices).
       Returns (points (n,3) f32 body/object frame, quads (m,4) i32)."""
    lines = [l.strip() for l in open(path, 'r', errors='replace').read().splitlines() if l.strip()]
    k = 0
    n = int(lines[k]); k += 1
    pts = []
    for _ in range(n):
        pts.append([float(v) for v in lines[k].split()[:3]]); k += 1
    m = int(lines[k]); k += 1
    quads = []
    for _ in range(m):
        q = [int(v) for v in lines[k].split()]
        if len(q) != 4:
            raise ValueError('%s: face line %r is not a quad' % (path, lines[k]))
        quads.append(q); k += 1
    if k != len(lines):
        raise ValueError('%s: %d trailing lines' % (path, len(lines) - k))
    P = np.array(pts, dtype=np.float32).reshape(n, 3)
    Q = np.array(quads, dtype=np.int32).reshape(m, 4)
    if len(Q) and (Q.max() >= n or Q.min() < 0):
        raise ValueError('%s: face index out of range' % path)
    return P, Q


def sniff_cm(path):
    """Header of a .cm (CarMesh render mesh): u32 version(8), u32 0, f32 bbox[6], ... shader paths."""
    d = open(path, 'rb').read(64)
    ver, z = struct.unpack_from('<II', d, 0)
    bb = struct.unpack_from('<6f', d, 8)
    return ver, z, bb


# ---------------------------------------------------------------------------------------------- splines
def read_spl(path):
    txt = open(path, 'r', errors='replace').read()
    cvs = [tuple(map(float, m.group(1).split(','))) for m in
           re.finditer(r'cv\[\d+\]\s*=\s*([-0-9.eE+]+\s*,\s*[-0-9.eE+]+\s*,\s*[-0-9.eE+]+)', txt)]
    return np.array(cvs, dtype=np.float64)


def sample_spline(cvs, step=1.0):
    """Uniform cubic B-spline (degree 3), samples ~every `step` m (3-D arc length)."""
    P = cvs
    n = len(P) - 3
    dense = []
    for i in range(n):
        p0, p1, p2, p3 = P[i], P[i + 1], P[i + 2], P[i + 3]
        seg = np.linalg.norm(p2 - p1)
        m = max(2, int(math.ceil(seg / step)))
        t = np.arange(m) / m
        b0 = (1 - t) ** 3 / 6
        b1 = (3 * t ** 3 - 6 * t ** 2 + 4) / 6
        b2 = (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6
        b3 = t ** 3 / 6
        dense.append(b0[:, None] * p0 + b1[:, None] * p1 + b2[:, None] * p2 + b3[:, None] * p3)
    return np.concatenate(dense)


def stage_dirs(root=ROOT):
    """[(stage id, archive dir, track dir)] for the 48 race stages (fogzor has no Track.gcm)."""
    out = []
    for p in sorted(glob.glob(os.path.join(root, '*', 'track', '*', '*', 'Mesh', 'Track.gcm'))):
        tdir = os.path.dirname(os.path.dirname(p))
        arch = p[len(root) + 1:].split(os.sep)[0]
        out.append((arch, tdir))
    return out


def port_id(arch):
    """corsica1f -> corsica-1-f, hillclimb2bf -> hillclimb-2b-f (src/world/ports naming)."""
    m = re.match(r'([a-z]+?)(\d[a-z]?)([fr])$', arch)
    return '%s-%s-%s' % m.groups() if m else arch


def race_range(arch):
    """(valid range, triggers) from the generated src/world/ports/<id>.ts (Play.con data, 3-D arc metres)."""
    p = os.path.join(REPO, 'src', 'world', 'ports', port_id(arch) + '.ts')
    try:
        t = open(p).read()
    except OSError:
        return None, None
    vr = re.search(r'VALID_RANGE[^=]*=\s*\[([-0-9.e]+),\s*([-0-9.e]+)\]', t)
    tr = re.search(r'TRIGGERS[^=]*=\s*\[([^\]]*)\]', t)
    cl = re.search(r'CLOSED\s*=\s*(true|false)', t)
    vr = (float(vr.group(1)), float(vr.group(2))) if vr else None
    tr = [float(v) for v in tr.group(1).split(',') if v.strip()] if tr else None
    if cl and cl.group(1) == 'true':
        tr = None                    # lap circuit: the whole (closed) spline is raced
        vr = None
    return vr, tr


def spline_samples(cvs, step=2.0):
    S = sample_spline(cvs, step)
    s = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(S, axis=0), axis=1))])
    return S, s


def _stats(dy):
    if len(dy) == 0:
        return dict(n=0)
    dy = np.asarray(dy)
    a = np.abs(dy)
    return dict(n=int(len(dy)), mean=float(dy.mean()), mean_abs=float(a.mean()),
                p95_abs=float(np.percentile(a, 95)), max_abs=float(a.max()))


def cmd_splines(args):
    """gcm surface under the AI centre spline: a wheel-like ray from y+1.5 m straight down 3 m (first hit, exactly
    as the original); if that misses, a full-height ray (anything under the point at all)."""
    out_json = None
    if '--json' in args:
        out_json = args[args.index('--json') + 1]
    step = 2.0
    rows = []
    for arch, tdir in stage_dirs():
        g = read_gcm(os.path.join(tdir, 'Mesh', 'Track.gcm'))
        cvs = read_spl(os.path.join(tdir, 'AiFiles', 'center.spl'))
        S, s = spline_samples(cvs, step)
        vr, tr = race_range(arch)
        lo, hi = (min(tr), max(tr)) if tr else (vr if vr else (0.0, float(s[-1])))
        race = (s >= lo) & (s <= hi)
        res = {'all': [], 'race': []}
        miss = {'all': 0, 'race': 0}
        far = {'all': 0, 'race': 0}
        outside = {'all': 0, 'race': 0}
        mats = {}
        for k, (x, y, z) in enumerate(S):
            keys = ('all', 'race') if race[k] else ('all',)
            ins = g.bmin[0] <= x < g.bmax[0] and g.bmin[1] <= z < g.bmax[1]
            h = g.raycast((x, y + 1.5, z), (0.0, -3.0, 0.0))
            if h is None:
                h2 = g.height_at(x, z)
                for kk in keys:
                    if not ins:
                        outside[kk] += 1
                    if h2 is None:
                        miss[kk] += 1
                    else:
                        far[kk] += 1
                if h2 is None:
                    continue
                h = h2
            for kk in keys:
                res[kk].append(h.point[1] - y)
            if race[k]:
                mats[h.material] = mats.get(h.material, 0) + 1
        row = dict(stage=arch, spline_len=float(s[-1]), race_lo=float(lo), race_hi=float(hi),
                   samples=int(len(S)), race_samples=int(race.sum()))
        for kk in ('all', 'race'):
            n = len(S) if kk == 'all' else int(race.sum())
            row[kk] = dict(_stats(res[kk]), no_tri=miss[kk], no_tri_frac=miss[kk] / max(1, n),
                           wheel_ray_miss=miss[kk] + far[kk], wheel_ray_miss_frac=(miss[kk] + far[kk]) / max(1, n),
                           outside_bbox=outside[kk])
        row['race_materials'] = {(MATERIALS[k] if 0 <= k < 24 else str(k)): v
                                 for k, v in sorted(mats.items(), key=lambda kv: -kv[1])}
        rows.append(row)
        R, A = row['race'], row['all']
        print('%-14s race %6.0f-%6.0f/%6.0f m: n %5d no-tri %5.2f%% wheel-miss %5.2f%% dy %+.3f |dy| p95 %.3f max %6.3f'
              ' | whole spline: no-tri %5.1f%% (outside bbox %d)  %s' % (
                  arch, lo, hi, s[-1], R['n'], 100 * R['no_tri_frac'], 100 * R['wheel_ray_miss_frac'],
                  R.get('mean', float('nan')), R.get('p95_abs', float('nan')), R.get('max_abs', float('nan')),
                  100 * A['no_tri_frac'], A['outside_bbox'],
                  ' '.join('%s:%.0f%%' % (k, 100.0 * v / max(1, R['n'])) for k, v in list(row['race_materials'].items())[:3])))
        sys.stdout.flush()
    if out_json:
        json.dump(rows, open(out_json, 'w'), indent=1)
    return rows


# ---------------------------------------------------------------------------------------------- validate
def cmd_validate(args):
    root = ROOT
    if '--root' in args:
        root = args[args.index('--root') + 1]
    ok = bad = 0
    print('== .gcm')
    for p in sorted(glob.glob(os.path.join(root, '**', '*.gcm'), recursive=True)):
        try:
            g = read_gcm(p)
            probs = check_gcm(g)
            u16 = sum(1 for b in g.blocks if b.use16)
            print('%-62s v%d dim %d V %6d F %6d VN %6d blocks %6d (u16 %6d u32 %4d) left %d %s%s' % (
                os.path.relpath(p, root), g.version, g.dim, len(g.V), g.nfaces, len(g.VN), len(g.blocks), u16,
                len(g.blocks) - u16, g.leftover, ('PROBLEMS ' + '; '.join(probs[:3])) if probs else 'ok',
                ('  WARN ' + '; '.join(getattr(g, 'warnings', []))) if getattr(g, 'warnings', []) else ''))
            if g.leftover or probs:
                bad += 1
            else:
                ok += 1
        except Exception as e:  # noqa
            print('FAIL', p, e)
            bad += 1
    print('gcm ok %d bad %d' % (ok, bad))
    cok = cbad = 0
    print('== .col')
    for p in sorted(glob.glob(os.path.join(root, '**', '*.col'), recursive=True)):
        try:
            pts, quads = read_col(p)
            cok += 1
            used = np.unique(quads) if len(quads) else np.array([], int)
            print('%-50s %3d points %3d quads (points used by quads %d)  bbox %s..%s' % (
                os.path.relpath(p, root), len(pts), len(quads), len(used),
                np.round(pts.min(0), 3), np.round(pts.max(0), 3)))
        except Exception as e:  # noqa
            print('FAIL', p, e)
            cbad += 1
    print('col ok %d bad %d' % (cok, cbad))
    mok = mbad = 0
    vers = {}
    for p in sorted(glob.glob(os.path.join(root, '**', '*.cm'), recursive=True)):
        try:
            v, z, bb = sniff_cm(p)
            vers[(v, z)] = vers.get((v, z), 0) + 1
            mok += 1
        except Exception as e:  # noqa
            print('FAIL', p, e)
            mbad += 1
    print('== .cm (CarMesh render meshes, header only): %d files, (version, word1) counts %s, bad %d' % (
        mok, vers, mbad))
    return bad + cbad + mbad


def cmd_info(args):
    for p in args:
        g = read_gcm(p)
        print(p)
        print('  version %d  bbox x %.3f..%.3f z %.3f..%.3f  grid %dx%d (cell %.3f x %.3f m)' % (
            g.version, g.bmin[0], g.bmax[0], g.bmin[1], g.bmax[1], g.dim, g.dim,
            (g.bmax[0] - g.bmin[0]) / g.dim, (g.bmax[1] - g.bmin[1]) / g.dim))
        print('  cell list %d u16 (%d block refs)  vertices %d  faces %d  vertex normals %d (+%d indices)' % (
            len(g.cell_list), int((g.cell_list != 0xffff).sum()), len(g.V), g.nfaces, len(g.VN), len(g.VNI)))
        print('  y range %.2f..%.2f  blocks %d  leftover %d' % (g.V[:, 1].min(), g.V[:, 1].max(),
                                                               len(g.blocks), g.leftover))
        u, c = np.unique(g.M, return_counts=True)
        print('  materials', ', '.join('%s(%d)=%d' % (MATERIALS[k] if k < 24 else '?', k, n) for k, n in zip(u, c)))
        print('  problems', check_gcm(g) or 'none')


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd, args = argv[1], argv[2:]
    if cmd == 'info':
        cmd_info(args)
    elif cmd == 'validate':
        return 1 if cmd_validate(args) else 0
    elif cmd == 'splines':
        cmd_splines(args)
    elif cmd == 'render':
        from fmt_gcm_render import cmd_render  # noqa: E402  (sibling module)
        cmd_render(args)
    elif cmd == 'trace':
        from fmt_gcm_trace import cmd_trace  # noqa: E402
        cmd_trace(args)
    elif cmd == 'export':
        from fmt_gcm_export import cmd_export  # noqa: E402
        cmd_export(args)
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.exit(main(sys.argv))
