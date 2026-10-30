#!/usr/bin/env python3
"""Golden fixtures for the TypeScript port of the original's Track.gcm query (src/world/orig/gcm.ts).

Runs the faithful Python reference (tools/assets/lib/formats/fmt_gcm.py, Gcm.raycast with per-slot caches) on
generated ray sets per stage and writes one compact binary per stage; plus a window of the wheel rays recorded
from the RUNNING original (research/frida/traces/run1.bin, rallycross1, gcm.md §8.2) with the original's own
outputs next to the reference's.

  .venv/bin/python -I tests/world/fixtures/orig/gen_gcm_golden.py            # all fixtures
  .venv/bin/python -I tests/world/fixtures/orig/gen_gcm_golden.py --no-trace # skip the recorded-ray window

Ray sets (category byte): 0 vertical wheel drops on random faces (slot -1); 1 steep / cliff faces (vertical,
up to 4 m long, where the first hit can differ from the nearest); 2 tilted 0.75 m wheel rays up to 45 deg
(Bresenham path) in moving 4-wheel sequences with per-slot caches; 3 hull segments COM -> 12 hull points of a
randomly oriented body (slots 8..19, sequences); 4 long rays in any direction incl. upward / horizontal and
outside the bbox (clip + multi-cell walks); 5 starts at exact vertex xz (e1 == 0) and exactly on a vertex
(d0 == 0 -> miss); 6 face-cache sequences where the cache decides between stacked faces (cache_sequences). Inputs are float32 values (stored as such), outputs the reference's float64 results.
Rays whose horizontal extent^2 falls between the reference's 0.05^2 and the exe's f32(0.05f*0.05f) are not
generated (the TS port uses the exe constant; the reference the double).

gcm_golden_<stage>.bin, little-endian:
  char[4] 'GGLD', u32 version 1, u32 count, char[32] stage id (NUL padded)
  count x 84-byte records: f32 origin[3], f32 ray[3], i32 slot, u8 category, u8 hit, u8 material (raw byte),
     u8 flags (1 first != nearest, 2 the slot cache changed the result), i32 face, f64 t, f64 depth, f64 cos,
     f64 point[3]
gcm_trace_rallycross1.bin:
  char[4] 'GTRC', u32 version 1, u32 count, f32 offset[3]
  count x 64-byte records: f32 end[3], f32 vec[3] (the original's W+0x94 / W+0xa0), u8 car, u8 wheel,
     u8 refHit, u8 pad, i32 origMaterial (-1 = miss), f32 origNormal[3], f32 c0, f32 c4 (the original's
     W+0xc0 / W+0xc4), i32 refFace, f64 refDepth   (reference = fmt_gcm on rallycross1f Track.gcm)
"""
import math
import os
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'tools', 'assets', 'lib', 'formats'))
import fmt_gcm as G  # noqa: E402

CACHE = os.environ.get('RALLY_ORIG_CACHE') or os.path.join(REPO, '.cache', 'original')
STAGES = [  # (stage id, archive, rays per category)
    ('corsica-2-f', 'corsica2f'),
    ('hillclimb-1c-f', 'hillclimb1cf'),
    ('newzealand-3-f', 'newzealand3f'),
    ('kenya-1-f', 'kenya1f'),
    ('rallycross-1-f', 'rallycross1f'),
    ('iceracing-3-f', 'iceracing3f'),
]
LIM_REF = G.BRESENHAM_LIMIT * G.BRESENHAM_LIMIT
LIM_EXE = float(np.float32(np.float32(0.05) * np.float32(0.05)))
F = np.float32
HULL = [(-0.8, -0.33, 2.0), (0.8, -0.33, 2.0), (0.8, -0.33, -2.0), (-0.8, -0.33, -2.0),
        (-0.85, 0.25, 2.1), (0.85, 0.25, 2.1), (0.85, 0.25, -2.1), (-0.85, 0.25, -2.1),
        (-0.6, 0.92, 0.6), (0.6, 0.92, 0.6), (0.6, 0.92, -1.0), (-0.6, 0.92, -1.0)]


def gcm_path(arch):
    m = __import__('re').match(r'([a-z]+)(\d[a-z]?)([fr])$', arch)
    fam, num, d = m.groups()
    return os.path.join(CACHE, arch, 'track', fam + num, 'forward' if d == 'f' else 'reverse', 'Mesh', 'Track.gcm')


def f32v(v):
    return tuple(float(F(x)) for x in v)


def rot(yaw, pitch, roll):
    cy, sy, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    Ry = np.array([[cy, 0, -sy], [0, 1, 0], [sy, 0, cy]])
    Rx = np.array([[1, 0, 0], [0, cp, sp], [0, -sp, cp]])
    Rz = np.array([[cr, sr, 0], [-sr, cr, 0], [0, 0, 1]])
    return Rz @ Rx @ Ry          # row vectors: v_world = v_body . R


class Gen:
    def __init__(self, g, seed):
        self.g = g
        self.rng = np.random.default_rng(seed)
        self.T = g.tris
        self.V = g.V.astype(np.float64)
        self.caches = {}
        self.out = []
        self.ny = g.FN[:, 1]

    def surface_point(self, faces=None):
        f = int(self.rng.choice(faces)) if faces is not None else int(self.rng.integers(0, self.g.nfaces))
        w = self.rng.dirichlet([1, 1, 1])
        return f, (self.V[self.T[f]] * w[:, None]).sum(0)

    def ground(self, x, z):
        h = self.g.raycast((x, 1.0e4, z), (0.0, -2.0e4, 0.0))
        return None if h is None else h.point[1]

    def cast(self, cat, o, r, slot):
        o, r = f32v(o), f32v(r)
        e = r[0] * r[0] + r[2] * r[2]
        if LIM_REF < e <= LIM_EXE:
            return                                          # the reference / exe threshold band: skipped
        cache = self.caches if slot >= 0 else None
        h = self.g.raycast(o, r, cache=cache, slot=slot if slot >= 0 else None)
        flags = 0
        hn = self.g.raycast(o, r, nearest=True)
        if (h is None) != (hn is None) or (h is not None and hn.face != h.face):
            flags |= 1
        if slot >= 0:
            h0 = self.g.raycast(o, r)                        # same ray without any cache
            if (h is None) != (h0 is None) or (h is not None and h0.face != h.face):
                flags |= 2
        self.out.append((o, r, slot, cat, h, flags))

    # -------------------------------------------------------------------------------------- ray sets
    def vertical(self, n):
        for _ in range(n):
            _, p = self.surface_point()
            self.cast(0, (p[0], p[1] + self.rng.uniform(-0.6, 1.2), p[2]), (0.0, -0.75, 0.0), -1)

    def cliffs(self, n):
        steep = np.nonzero((np.abs(self.ny) < 0.6) & (np.abs(self.g.FN).sum(1) > 0))[0]
        if not len(steep):
            return
        for _ in range(n):
            _, p = self.surface_point(steep)
            L = self.rng.uniform(1.0, 4.0)
            self.cast(1, (p[0], p[1] + self.rng.uniform(0.2, 2.0), p[2]), (0.0, -L, 0.0), -1)

    def wheels(self, nseq, steps):
        for s in range(nseq):
            car = s % 3
            _, p = self.surface_point()
            heading = self.rng.uniform(0, 2 * math.pi)
            tilt0 = self.rng.uniform(0, math.radians(45))
            tdir = self.rng.uniform(0, 2 * math.pi)
            for k in range(steps):
                x = p[0] + math.sin(heading) * 0.35 * k
                z = p[2] + math.cos(heading) * 0.35 * k
                gy = self.ground(x, z)
                if gy is None:
                    break
                tilt = tilt0 + self.rng.normal(0, math.radians(2))
                up = np.array([math.sin(tilt) * math.cos(tdir), math.cos(tilt), math.sin(tilt) * math.sin(tdir)])
                for w, (wx, wz) in enumerate(((-0.78, 1.3), (0.78, 1.3), (0.78, -1.3), (-0.78, -1.3))):
                    mount = np.array([x + wx * 0.2, gy + self.rng.uniform(0.3, 0.95), z + wz * 0.2])
                    self.cast(2, mount, -0.75 * up, w + 24 * car)

    def hulls(self, nseq, steps):
        for s in range(nseq):
            car = s % 3
            _, p = self.surface_point()
            yaw = self.rng.uniform(0, 2 * math.pi)
            pitch0, roll0 = self.rng.normal(0, 0.3), self.rng.normal(0, 0.6)
            for k in range(steps):
                x, z = p[0] + math.sin(yaw) * 0.2 * k, p[2] + math.cos(yaw) * 0.2 * k
                gy = self.ground(x, z)
                if gy is None:
                    break
                R = rot(yaw, pitch0 + 0.05 * k, roll0 - 0.05 * k)
                com = np.array([x, gy + self.rng.uniform(0.2, 1.0), z])
                for i, hp in enumerate(HULL):
                    P = com + np.array(hp) @ R
                    self.cast(3, com, P - com, 8 + i + 24 * car)

    def long(self, n):
        g = self.g
        minx, minz, maxx, maxz = float(g.bmin[0]), float(g.bmin[1]), float(g.bmax[0]), float(g.bmax[1])
        for k in range(n):
            if k % 3 == 0:
                o = np.array([self.rng.uniform(minx - 60, maxx + 60), 0.0, self.rng.uniform(minz - 60, maxz + 60)])
                o[1] = self.rng.uniform(float(g.V[:, 1].min()) - 5, float(g.V[:, 1].max()) + 30)
            else:
                _, p = self.surface_point()
                o = p + np.array([0.0, self.rng.uniform(-3.0, 25.0), 0.0])
            d = self.rng.normal(size=3)
            if k % 4 == 0:
                d[1] = -abs(d[1]) * 0.2                       # shallow, nearly horizontal
            d /= np.linalg.norm(d)
            L = self.rng.choice([self.rng.uniform(2, 20), self.rng.uniform(20, 400)])
            self.cast(4, o, d * L, -1 if k % 2 else 100 + k % 50)

    def vertices(self, n):
        for k in range(n):
            f = int(self.rng.integers(0, self.g.nfaces))
            v0 = self.V[self.T[f][0]]
            if k % 2:
                self.cast(5, (v0[0], v0[1] + self.rng.uniform(0.05, 1.0), v0[2]), (0.0, -2.0, 0.0), -1)
            else:
                self.cast(5, v0, (0.0, -1.0, 0.0), -1)      # start exactly on the plane: d0 == 0 -> miss

    def cache_sequences(self, nseq, tries=6000):
        """Sequences where the slot's face cache decides the result: a vertical ray whose first hit (list order)
        is a LOWER face B while an upper face A is also crossed. Ray 1 ends between A and B (hits only A: A is
        cached), ray 2 is the full ray (the cached A is tested first and wins; without the cache B wins), ray 3
        lands in another block (the block change forgets the face), ray 4 = ray 2 again (B)."""
        steep = np.nonzero((np.abs(self.ny) < 0.6) & (np.abs(self.g.FN).sum(1) > 0))[0]
        found = 0
        for _ in range(tries):
            if found >= nseq or not len(steep):
                break
            _, p = self.surface_point(steep)
            o = f32v((p[0], p[1] + self.rng.uniform(0.2, 2.0), p[2]))
            r = f32v((0.0, -self.rng.uniform(1.0, 4.0), 0.0))
            hf = self.g.raycast(o, r)
            hn = self.g.raycast(o, r, nearest=True)
            if hf is None or hn is None or hf.face == hn.face or not hn.point[1] > hf.point[1] + 1e-3:
                continue
            ymid = 0.5 * (hn.point[1] + hf.point[1])
            r1 = f32v((0.0, ymid - o[1], 0.0))
            h1 = self.g.raycast(o, r1)
            if h1 is None or h1.face != hn.face:
                continue
            slot = 200 + found
            far = None
            for _ in range(50):
                _, q = self.surface_point()
                if abs(q[0] - o[0]) > 40 or abs(q[2] - o[2]) > 40:
                    far = q
                    break
            if far is None:
                continue
            self.cast(6, o, r1, slot)
            self.cast(6, o, r, slot)
            self.cast(6, (far[0], far[1] + 0.5, far[2]), (0.0, -1.0, 0.0), slot)
            self.cast(6, o, r, slot)
            found += 1

    def write(self, path, sid):
        recs = []
        for o, r, slot, cat, h, flags in self.out:
            if h is None:
                recs.append(struct.pack('<6fiBBBBi6d', *o, *r, slot, cat, 0, 255, flags, -1, *([0.0] * 6)))
            else:
                recs.append(struct.pack('<6fiBBBBi6d', *o, *r, slot, cat, 1, h.material & 255, flags, h.face,
                                        h.t, h.depth, h.cos, *h.point))
        hdr = b'GGLD' + struct.pack('<II', 1, len(recs)) + sid.encode().ljust(32, b'\0')
        open(path, 'wb').write(hdr + b''.join(recs))


def golden():
    for k, (sid, arch) in enumerate(STAGES):
        g = G.read_gcm(gcm_path(arch))
        gen = Gen(g, 1000 + k)
        gen.vertical(500)
        gen.cliffs(500)
        gen.wheels(30, 10)
        gen.hulls(12, 6)
        gen.long(300)
        gen.vertices(160)
        gen.cache_sequences(40)
        out = os.path.join(HERE, 'gcm_golden_%s.bin' % sid)
        gen.write(out, sid)
        cats = np.bincount([c for _, _, _, c, _, _ in gen.out], minlength=7).tolist()
        hits = sum(1 for x in gen.out if x[4] is not None)
        fn = sum(1 for x in gen.out if x[5] & 1)
        cc = sum(1 for x in gen.out if x[5] & 2)
        nv = sum(1 for x in gen.out if x[1][0] ** 2 + x[1][2] ** 2 > LIM_EXE)
        print('%-15s %5d rays (per category %s), %5d hits, non-vertical %d, first!=nearest %d, cache changed %d, %d bytes'
              % (sid, len(gen.out), cats, hits, nv, fn, cc, os.path.getsize(out)))


def trace(first=13500, count=1500):
    """Records 13500..15000 of run1.bin (4 cars, 4 wheel rays per record; the window with the most misses and
    tilted rays) + the reference on rallycross1f Track.gcm with per-car caches (slot = wheel)."""
    import fmt_gcm_trace as TR   # research/tools only (local); the copy under tools/assets does not ship it
    run = os.path.join(REPO, 'research', 'frida', 'traces', 'run1.bin')
    g = G.read_gcm(gcm_path('rallycross1f'))
    recs = TR.load(run, first + count)[first:]
    n = len(recs)
    a = 24 + TR.SNAP
    car = recs[:, 8:12].copy().view('<u4').reshape(n)
    cars = {c: i for i, c in enumerate(sorted(set(car.tolist())))}
    off = (2048.0, 10.0, 2048.0)
    caches = {}
    out = []
    st = dict(rays=0, agree=0, nonvertical=0, misses=0)
    for r in range(n):
        rec = recs[r]
        ci = cars[int(car[r])]
        cache = caches.setdefault(ci, {})
        for w in range(4):
            o = a + TR.W0 + w * TR.WS
            end = rec[o + 0x94:o + 0xa0].view('<f4').astype(np.float64)
            vec = rec[o + 0xa0:o + 0xac].view('<f4').astype(np.float64)
            mat = int(rec[o + 0xac:o + 0xb0].view('<i4')[0])
            nrm = rec[o + 0xb4:o + 0xc0].view('<f4')
            c0, c4 = (float(v) for v in rec[o + 0xc0:o + 0xc8].view('<f4'))
            if not np.isfinite(end).all() or not np.any(vec):
                continue
            org = end - vec - np.array(off)
            h = g.raycast(org, vec, cache=cache, slot=w)
            if h is not None and h.material >= 32:
                h = None
            st['rays'] += 1
            st['agree'] += int((h is None) == (mat == -1))
            st['misses'] += int(mat == -1)
            st['nonvertical'] += int(vec[0] ** 2 + vec[2] ** 2 > LIM_EXE)
            out.append(struct.pack('<6fBBBBi3fffid', *end.astype(np.float32).tolist(), *vec.astype(np.float32).tolist(),
                                   ci, w, 0 if h is None else 1, 0, mat, *nrm.tolist(), c0, c4,
                                   -1 if h is None else h.face, 0.0 if h is None else h.depth))
    path = os.path.join(HERE, 'gcm_trace_rallycross1.bin')
    open(path, 'wb').write(b'GTRC' + struct.pack('<II3f', 1, len(out), *off) + b''.join(out))
    print('trace window records %d..%d: %s, %d bytes' % (first, first + n, st, os.path.getsize(path)))


if __name__ == '__main__':
    golden()
    if '--no-trace' not in sys.argv:
        sys.path.insert(0, os.path.join(REPO, 'research', 'tools'))
        trace()
