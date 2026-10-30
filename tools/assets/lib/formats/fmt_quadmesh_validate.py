#!/usr/bin/env python3
"""fmt_quadmesh_validate.py -- whole-corpus validation of the QuadMesh (.qm/.rs) parser.

  python3 -I fmt_quadmesh_validate.py parse  [research/full]    # every .qm + .rs, exact consumption
  python3 -I fmt_quadmesh_validate.py spline [research/full]    # Track.qm road vs AiFiles/center.spl
  python3 -I fmt_quadmesh_validate.py all

Spline check: the centre spline (degree-3 uniform B-spline, integer knots, the same de Boor scheme
as src/world/portSpline.ts) is sampled every ~1 m; for each sample (x, z) the Track.qm triangles
whose XZ projection contains the point are intersected with the vertical line and the hit nearest
to the spline height is taken. dy = mesh_y - spline_y. Samples whose 4 controlling CVs include a
y == 0.000 CV are counted separately (y0CV; kenya1/2, newzealand1 carry such CVs -- the check shows
those are genuine zero elevations: the mesh is at y = 0 there too). Misses = spline outside Track.qm
(the AI spline runs past the stage's splineRange).
Also reports the facing of the hit triangles: with D3D's default CULL_CCW (clockwise = front) the
front-face normal in the left-handed sim frame is cross(b - a, c - a); the road must face +y.
"""
import glob
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fmt_quadmesh as Q  # noqa: E402


# ------------------------------------------------------------------ spline ---------------------
def read_spl(path):
    t = open(path, encoding='latin-1').read()
    deg = int(re.search(r'degree=(\d+)', t).group(1))
    cv = np.array([[float(a) for a in m.groups()] for m in
                   re.finditer(r'cv\[\d+\]=([-\d.eE]+),([-\d.eE]+),([-\d.eE]+)', t)])
    return deg, cv


def sample_spline(cv, deg=3, step=1.0):
    """Uniform cubic B-spline, segment i (t in [i, i+1), i = 3..n-1) uses cv[i-3..i]."""
    n = len(cv)
    pts, flat = [], []
    for i in range(deg, n):
        P = cv[i - 3:i + 1]
        seglen = np.linalg.norm(P[2] - P[1]) + 1e-6
        m = max(1, int(np.ceil(seglen / step)))
        u = np.arange(m) / m
        b0 = (1 - u) ** 3 / 6
        b1 = (3 * u ** 3 - 6 * u ** 2 + 4) / 6
        b2 = (-3 * u ** 3 + 3 * u ** 2 + 3 * u + 1) / 6
        b3 = u ** 3 / 6
        pts.append(b0[:, None] * P[0] + b1[:, None] * P[1] + b2[:, None] * P[2] + b3[:, None] * P[3])
        flat.append(np.full(m, bool((P[:, 1] == 0).any())))
    return np.concatenate(pts), np.concatenate(flat)


# ------------------------------------------------------------------ mesh triangles -------------
def mesh_triangles(qm):
    """World-space triangles (N,3,3) + material names per triangle."""
    tris, mats = [], []
    for _, p in qm.iter_patches():
        P = p.positions.astype(np.float64)
        for s in p.subs:
            t = s.triangles(p.indices)
            tris.append(P[t]); mats += [s.material] * len(t)
    return np.concatenate(tris), np.array(mats)


class TriGrid:
    def __init__(self, T, cell=8.0):
        self.T, self.cell = T, cell
        lo = T[:, :, [0, 2]].min(1); hi = T[:, :, [0, 2]].max(1)
        self.o = lo.min(0) - 1
        c0 = np.floor((lo - self.o) / cell).astype(np.int64)
        c1 = np.floor((hi - self.o) / cell).astype(np.int64)
        self.nx = int(c1[:, 0].max()) + 2
        ids, owners = [], []
        span = c1 - c0 + 1
        for dx in range(int(span[:, 0].max())):
            for dz in range(int(span[:, 1].max())):
                ok = (dx < span[:, 0]) & (dz < span[:, 1])
                idx = np.nonzero(ok)[0]
                ids.append((c0[idx, 1] + dz) * self.nx + (c0[idx, 0] + dx)); owners.append(idx)
        ids = np.concatenate(ids); owners = np.concatenate(owners)
        order = np.argsort(ids, kind='stable')
        self.ids, self.owners = ids[order], owners[order]

    def candidates(self, x, z):
        cx = int((x - self.o[0]) // self.cell); cz = int((z - self.o[1]) // self.cell)
        key = cz * self.nx + cx
        a = np.searchsorted(self.ids, key); b = np.searchsorted(self.ids, key, 'right')
        return self.owners[a:b]

    def heights_at(self, x, z):
        """All (height, triangle index) where the vertical line at (x,z) crosses a triangle."""
        c = self.candidates(x, z)
        if len(c) == 0:
            return np.zeros(0), c
        T = self.T[c]
        a, b, d = T[:, 0], T[:, 1], T[:, 2]
        v0x, v0z = b[:, 0] - a[:, 0], b[:, 2] - a[:, 2]
        v1x, v1z = d[:, 0] - a[:, 0], d[:, 2] - a[:, 2]
        px, pz = x - a[:, 0], z - a[:, 2]
        den = v0x * v1z - v1x * v0z
        with np.errstate(divide="ignore", invalid="ignore"):
            u = (px * v1z - v1x * pz) / den
            v = (v0x * pz - px * v0z) / den
            ok = (np.abs(den) > 1e-9) & (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1 + 1e-6)
        h = a[ok, 1] + u[ok] * (b[ok, 1] - a[ok, 1]) + v[ok] * (d[ok, 1] - a[ok, 1])
        return h, c[ok]


def spline_check(track_dir):
    qm = Q.parse(os.path.join(track_dir, 'Mesh', 'Track.qm'))
    T, mats = mesh_triangles(qm)
    grid = TriGrid(T)
    _, cv = read_spl(os.path.join(track_dir, 'AiFiles', 'center.spl'))
    S, flat = sample_spline(cv)
    dy, faceup, hitmat, isflat = [], [], [], []
    miss = 0
    for (x, y, z), fl in zip(S, flat):
        h, idx = grid.heights_at(x, z)
        if len(h) == 0:
            miss += 1; continue
        k = int(np.argmin(np.abs(h - y)))
        t = T[idx[k]]
        n = np.cross(t[1] - t[0], t[2] - t[0])
        dy.append(h[k] - y); faceup.append(n[1] > 0); hitmat.append(mats[idx[k]]); isflat.append(fl)
    dy = np.array(dy); faceup = np.array(faceup); isflat = np.array(isflat)
    return dict(samples=len(S), hits=len(dy), miss=miss, dy=dy, faceup=faceup, flat=isflat,
                mats=hitmat, tris=len(T))


def cmd_parse(root):
    ok = bad = 0
    tot = dict(nodes=0, patches=0, verts=0, tris=0, subs=0)
    for f in sorted(glob.glob(os.path.join(root, '**', '*.qm'), recursive=True)):
        try:
            qm = Q.parse(f)
            assert qm.leftover == 0, f'{qm.leftover} leftover bytes'
            rs = Q.parse_rs(f[:-3] + '.rs')
            for _, p in qm.iter_patches():
                for s in p.subs:
                    assert s.material in rs, f'material {s.material} missing in .rs'
                    assert s.start_index + s.index_span <= p.index_count
                assert (p.indices < p.vertex_count).all()
                tot['patches'] += 1; tot['verts'] += p.vertex_count; tot['subs'] += len(p.subs)
                tot['tris'] += sum(len(s.triangles(p.indices)) for s in p.subs)
            tot['nodes'] += sum(1 for _ in qm.iter_nodes())
            ok += 1
        except Exception as e:  # noqa: BLE001
            bad += 1; print('FAIL', f, e)
    nrs = 0
    for f in sorted(glob.glob(os.path.join(root, '**', 'Mesh', '**', '*.rs'), recursive=True)):
        Q.parse_rs(f); nrs += 1
    print(f'.qm files: {ok} parsed exactly to EOF (0 leftover bytes), {bad} failed; .rs files: {nrs}')
    print('totals', tot)
    return bad == 0


def cmd_spline(root):
    rows = []
    for d in sorted(glob.glob(os.path.join(root, '*', 'track', '*', '*'))):
        if not os.path.exists(os.path.join(d, 'Mesh', 'Track.qm')):
            continue
        r = spline_check(d)
        dy, fl, up = r['dy'], r['flat'], r['faceup']
        g = dy[~fl]
        name = d.split(os.sep)[-4]
        rows.append((name, r, g))
        cover = r['hits'] / r['samples']
        print(f'{name:14s} samples={r["samples"]:5d} hit={cover:6.1%} '
              f'|dy| mean={np.abs(g).mean() if len(g) else float("nan"):.3f} '
              f'p95={np.percentile(np.abs(g), 95) if len(g) else float("nan"):.3f} '
              f'max={np.abs(g).max() if len(g) else float("nan"):.3f} m  mean dy={g.mean() if len(g) else 0:+.3f} '
              f'faceUp={up.mean():.1%}  y0CV={fl.sum()} (|dy| mean {np.abs(dy[fl]).mean() if fl.any() else 0:.1f})')
    return rows


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'all'
    from _paths import FULL  # rally-web: data root
    root = sys.argv[2] if len(sys.argv) > 2 else FULL
    if cmd in ('parse', 'all'):
        cmd_parse(root)
    if cmd in ('spline', 'all'):
        cmd_spline(root)
