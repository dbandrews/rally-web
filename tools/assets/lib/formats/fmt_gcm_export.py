#!/usr/bin/env python3
"""fmt_gcm_export.py - compact browser binary ("RGC1") for a Track.gcm + a reference reader/query that operates
ONLY on the exported arrays (what the TypeScript WorldQuery will do), verified against fmt_gcm's faithful port.

  fmt_gcm.py export <Track.gcm> <out.rgc> [--verify N]
  fmt_gcm.py export --all <outdir> [--verify N]       all 48 stages, prints sizes (raw / gzip) and verification

Layout (little-endian, every section 4-byte aligned; offsets from file start):
  0   char[4] 'RGC1'
  4   u32  version = 1
  8   u32  nV                      vertices
  12  u32  nF                      faces
  16  f32  minX, minZ, maxX, maxZ  gcm bbox (Track.gcm header)
  32  u32  T                       tile grid T x T over the bbox (blocks are exactly these tiles, [E] all files)
  36  u32  nB                      non-empty tiles (blocks)
  40  u32  nCells                  sum of dim^2 over blocks
  44  u32  nRefs                   sum of face refs over all sub-cells (no terminators)
  48  u32  flags                   bit0: indices are u16
  52  u32  reserved[3]
  64  f32  V[nV*3]
      u16|u32 I[nF*3]              (u16 when nV <= 65536; padded to 4)
      u8   M[nF]                   original material id (0..22; 255 = -1), padded to 4
      f32  FN[nF*3]                stored face normals (exact; 371 are (0,0,0) = inert faces)
      i32  tile[T*T]               block index of tile (ix*T + iz, x-major like the original) or -1
      f32  blk[nB*8]               x0, z0, x1, z1 (stored tile box), y0, y1, invX, invZ
      u32  blkI[nB*2]              dim, cellBase (index of the block's first sub-cell in cellStart)
      u32  cellStart[nCells+1]     CSR offsets into refs; sub-cell (i,j) of block b = cellBase + i*dim + j
      u32  refs[nRefs]             global face ids, in the ORIGINAL list order (first-hit order is preserved)
"""
import gzip
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fmt_gcm as G  # noqa: E402

MAGIC = b'RGC1'


def _pad4(b):
    return b + b'\0' * ((-len(b)) % 4)


def build(g):
    ext = g.blocks[0].bmax - g.blocks[0].bmin
    T = int(round((float(g.bmax[0]) - float(g.bmin[0])) / float(ext[0])))
    tile = np.full(T * T, -1, np.int32)
    blk, blki, cell_start, refs = [], [], [0], []
    nb = 0
    for b in g.blocks:
        faces_any = (b.list16 != 0xffff).any() if b.use16 else (b.list32 != 0xffffffff).any()
        ix = int(round((float(b.bmin[0]) - float(g.bmin[0])) / float(ext[0])))
        iz = int(round((float(b.bmin[2]) - float(g.bmin[1])) / float(ext[2])))
        if not faces_any:
            continue                               # empty block: can never hit, drop it
        assert tile[ix * T + iz] == -1, 'two blocks on one tile'
        tile[ix * T + iz] = nb
        blk.append([b.bmin[0], b.bmin[2], b.bmax[0], b.bmax[2], b.bmin[1], b.bmax[1], b.inv[0], b.inv[1]])
        blki.append([b.dim, len(cell_start) - 1])
        lst, term = (b.list16, 0xffff) if b.use16 else (b.list32, 0xffffffff)
        base = b.base if b.use16 else 0
        for c in range(b.dim * b.dim):
            k = int(b.off[c])
            while lst[k] != term:
                refs.append(int(lst[k]) + base)
                k += 1
            cell_start.append(len(refs))
        nb += 1
    return T, np.array(blk, np.float32).reshape(-1, 8), np.array(blki, np.uint32).reshape(-1, 2), \
        np.array(cell_start, np.uint32), np.array(refs, np.uint32), tile


def export(g, out):
    T, blk, blki, cs, refs, tile = build(g)
    nV, nF = len(g.V), g.nfaces
    u16 = nV <= 65536
    hdr = MAGIC + struct.pack('<3I4f6I', 1, nV, nF, float(g.bmin[0]), float(g.bmin[1]), float(g.bmax[0]),
                              float(g.bmax[1]), T, len(blk), len(cs) - 1, len(refs), 1 if u16 else 0, 0)
    hdr += b'\0' * (64 - len(hdr))
    body = [g.V.astype('<f4').tobytes(),
            _pad4(g.I.astype('<u2' if u16 else '<u4').tobytes()),
            _pad4(g.M.astype('u1').tobytes()),
            g.FN.astype('<f4').tobytes(),
            tile.astype('<i4').tobytes(),
            blk.astype('<f4').tobytes(),
            blki.astype('<u4').tobytes(),
            cs.astype('<u4').tobytes(),
            refs.astype('<u4').tobytes()]
    data = hdr + b''.join(body)
    if out:
        open(out, 'wb').write(data)
    return data


class Rgc:
    """Reference reader + query on the exported arrays only (mirrors the planned TypeScript)."""

    def __init__(self, data):
        (self.ver, self.nV, self.nF, self.minX, self.minZ, self.maxX, self.maxZ, self.T, self.nB, self.nCells,
         self.nRefs, flags, _) = struct.unpack_from('<3I4f6I', data, 4)
        o = 64

        def take(dt, n):
            nonlocal o
            a = np.frombuffer(data, dtype=dt, count=n, offset=o)
            o += (a.nbytes + 3) & ~3
            return a
        self.V = take('<f4', 3 * self.nV).astype(np.float64).reshape(-1, 3)
        self.I = take('<u2' if flags & 1 else '<u4', 3 * self.nF).astype(np.int64)
        self.M = take('u1', self.nF).astype(np.int8)
        self.FN = take('<f4', 3 * self.nF).astype(np.float64).reshape(-1, 3)
        self.tile = take('<i4', self.T * self.T)
        self.blk = take('<f4', 8 * self.nB).astype(np.float64).reshape(-1, 8)
        self.blki = take('<u4', 2 * self.nB).reshape(-1, 2)
        self.cs = take('<u4', self.nCells + 1)
        self.refs = take('<u4', self.nRefs)
        assert o == len(data), (o, len(data))
        self.tw = (self.maxX - self.minX) / self.T
        self.td = (self.maxZ - self.minZ) / self.T
        # python lists for speed
        self._V = self.V.tolist(); self._I = self.I.tolist(); self._FN = self.FN.tolist(); self._M = self.M.tolist()
        self._cs = self.cs.tolist(); self._refs = self.refs.tolist(); self._blk = self.blk.tolist()
        self._blki = self.blki.tolist(); self._tile = self.tile.tolist()

    def block_at(self, x, z):
        """Tile lookup + half-open stored-box test (+ neighbours for boundary rounding)."""
        ix = int(np.floor((x - self.minX) / self.tw))
        iz = int(np.floor((z - self.minZ) / self.td))
        for dx, dz in ((0, 0), (-1, 0), (1, 0), (0, -1), (0, 1)):
            i, j = ix + dx, iz + dz
            if 0 <= i < self.T and 0 <= j < self.T:
                b = self._tile[i * self.T + j]
                if b >= 0:
                    x0, z0, x1, z1 = self._blk[b][:4]
                    if x0 <= x < x1 and z0 <= z < z1:
                        return b
        return -1

    def vertical(self, x, y0, z, ylen):
        """Vertical segment (x,y0,z) -> (x,y0-ylen,z): first hit in original list order (the wheel ray)."""
        b = self.block_at(x, z)
        if b < 0:
            return None
        x0, z0, _, _, _, _, ivx, ivz = self._blk[b]
        dim, base = self._blki[b]
        i = int((x - x0) * ivx)            # truncation, as __ftol
        j = int((z - z0) * ivz)
        if not (0 <= i < dim and 0 <= j < dim):
            return None
        c = base + i * dim + j
        for k in range(self._cs[c], self._cs[c + 1]):
            f = self._refs[k]
            h = self._tri(f, x, y0, z, ylen)
            if h is not None:
                return h
        return None

    def _tri(self, f, x, y0, z, ylen):
        I, V = self._I, self._V
        v0, v1, v2 = V[I[3 * f]], V[I[3 * f + 1]], V[I[3 * f + 2]]
        nx, ny, nz = self._FN[f]
        ey = y0 - ylen
        d1 = (x - v0[0]) * nx + (ey - v0[1]) * ny + (z - v0[2]) * nz
        if d1 > 0:
            return None
        d0 = (x - v0[0]) * nx + (y0 - v0[1]) * ny + (z - v0[2]) * nz
        if d0 <= 0:         # verifier fix: start on the plane is a miss (0x59511f; see gcm.md §3.4)
            return None
        da = -ylen * ny
        if da >= 0:
            return None
        t = -(d0 / da)
        if abs(ny) >= 0.7:
            i, j = 0, 2
        elif abs(nz) > 0.3:
            i, j = 0, 1
        else:
            i, j = 1, 2
        p = (x, y0 + t * -ylen, z)
        hi, hj = p[i], p[j]
        e1 = (v1[j] - v0[j]) * (hi - v0[i]) - (hj - v0[j]) * (v1[i] - v0[i])
        e2 = (v2[j] - v1[j]) * (hi - v1[i]) - (v2[i] - v1[i]) * (hj - v1[j])
        if (e1 < 0 < e2) or (e2 < 0 < e1):
            return None
        e3 = (v0[j] - v2[j]) * (hi - v2[i]) - (hj - v2[j]) * (v0[i] - v2[i])
        if (e1 < 0 < e3) or (e3 < 0 < e1):
            return None
        return (f, p[1], d1, self._M[f])


def verify(g, r, n=20000, seed=1):
    """Random vertical wheel-like rays over the mesh (sampled on random faces), RGC vs faithful port."""
    rng = np.random.default_rng(seed)
    T = g.tris
    fs = rng.integers(0, g.nfaces, n)
    w = rng.dirichlet([1, 1, 1], n)
    P = (g.V[T[fs]] * w[:, :, None]).sum(1).astype(np.float64)
    off = rng.uniform(-0.6, 1.2, n)
    bad = 0
    hits = 0
    for k in range(n):
        x, y, z = P[k]
        y0 = y + off[k]
        a = g.raycast((x, y0, z), (0.0, -0.75, 0.0))
        b = r.vertical(x, y0, z, 0.75)
        if (a is None) != (b is None):
            bad += 1
            continue
        if a is not None:
            hits += 1
            if a.face != b[0] or abs(a.depth - b[2]) > 1e-6 or a.material != b[3]:
                bad += 1
    return n, hits, bad


def cmd_export(args):
    nver = 0
    if '--verify' in args:
        nver = int(args[args.index('--verify') + 1])
    if args[0] == '--all':
        outdir = args[1]
        os.makedirs(outdir, exist_ok=True)
        tot_raw = tot_gz = tot_src = 0
        for arch, tdir in G.stage_dirs():
            src = os.path.join(tdir, 'Mesh', 'Track.gcm')
            g = G.read_gcm(src)
            out = os.path.join(outdir, G.port_id(arch) + '.rgc')
            data = export(g, out)
            gz = len(gzip.compress(data, 9))
            tot_raw += len(data); tot_gz += gz; tot_src += os.path.getsize(src)
            msg = ''
            if nver:
                n, hits, bad = verify(g, Rgc(data), nver)
                msg = 'verify %d rays, %d hits, %d mismatches' % (n, hits, bad)
            print('%-14s gcm %8d  rgc %8d  gzip %8d  %s' % (arch, os.path.getsize(src), len(data), gz, msg))
            sys.stdout.flush()
        print('TOTAL gcm %d  rgc %d  gzip %d' % (tot_src, tot_raw, tot_gz))
    else:
        g = G.read_gcm(args[0])
        data = export(g, args[1])
        print('wrote', args[1], len(data), 'bytes (gzip %d)' % len(gzip.compress(data, 9)))
        if nver:
            print('verify (rays, hits, mismatches):', verify(g, Rgc(data), nver))


if __name__ == '__main__':
    cmd_export(sys.argv[1:])
