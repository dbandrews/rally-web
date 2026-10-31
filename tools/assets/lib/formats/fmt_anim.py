#!/usr/bin/env python3
"""fmt_anim.py -- skeletal animation: .ske skeleton, .skn skin, .baf bone animation, .spl spline (+ the engine's
evaluation rules, decoded from original_desktop_version.exe).  Spec: research/formats/animation.md.

Every claim below is [E] (read in the exe, address given) unless tagged [D] (data) or [I] (inferred).

Files (all little-endian):
  .ske  u32 version(=1)  u32 nBones  nBones x { u16 len, char name[len] (NUL incl., trailing ' ' trimmed),
        i16 parent (-1 / 0xffff = root), f32 m[12] }                                   loader FUN_004fa840
        m = 3 rows (R row i | t_i); the engine stores it as the row-vector 4x4
        L = [[m0,m4,m8,0],[m1,m5,m9,0],[m2,m6,m10,0],[m3,m7,m11,1]]          (0x4faab7-0x4fabad)
  .skn  u32 version(=1)  u32 nVerts  nVerts x { f32 pos[3], u8 nInfl, nInfl x {u16 bone, f32 w, f32 off[3]} }
        u16 nBones  nBones x { u16 len, name }        (skin record = 0x1c-byte runtime entry; VB build FUN_00589480)
  .baf  u32 version  u16 nBones  nBones x { u16 len, name }  u32 nFrames  then frame-major keys:
        v2: per (frame, bone) 20 B = i16 q[4] (x, y, z, w; *3.051851e-05) + f32 pos[3]       loader FUN_004fcdd0
        v1: per (frame, bone) 48 B = f32 m[12]   -- REJECTED by the loader (version != 2 -> load fails) [E 0x4fce5e]
  .spl  text 'degree=3', 'numCVs=N', 'cv[i]=x,y,z' (Animals/bird_splines_01.spl; referenced by no script / string) [D]

Engine conventions (row vectors, v' = v * M, D3D):
  bone world  W_i = L_i * W_parent ; root W = L_root * R0, R0 = rotX(-pi/2) table 0x875b38 (AnimatedObject)
                / 0x875db0 (DriverObject), built by 0x4d2830 / 0x4d7db0 = [[1,0,0,0],[0,c,-s,0],[0,s,c,0],[0,0,0,1]],
                a = -pi/2  ->  (x, y, z) -> (x, -z, y)                                    FUN_004fb7c0
  extra bone rotation X (bone+0x94, look-at / shake): W = ((L * W_parent) without translation) * X, translation
                kept                                                                      FUN_004fb7c0
  key -> local  L = quat_matrix(q) (rows = R_std(q) row-major, i.e. the column-vector matrix of q stored as rows),
                translation row 3 = pos; pos None => keep the local's current translation      FUN_004fb030
  skinned vertex (model space, LH y-up) = sum_i w_i * ([off_i, 1] * W_bone_i)   SkinningShader2Bones.vs
  => the .skn bind position p maps to model space as (-p.x, p.z, p.y) [D: exact for driver, bird, cow, zebra]
"""
import math
import os
import struct
import sys

QSCALE = 3.051851e-05          # float at 0x808550 (= 1/32767), fmul at 0x4fd415..0x4fd4c9
A_ROOT = -0.5 * math.pi        # 0x807f90 (pi) * 0x7fc968 (-0.5)


def _load(src):
    if isinstance(src, (bytes, bytearray)):
        return bytes(src)
    with open(src, 'rb') as f:
        return f.read()


def _name(b, o):
    ln = struct.unpack_from('<H', b, o)[0]
    o += 2
    raw = b[o:o + ln]
    return raw.split(b'\0')[0].rstrip(b' ').decode('latin1'), o + ln, raw


# ----------------------------------------------------------------------------------------------- parsers
def parse_ske(src):
    b = _load(src)
    ver, n = struct.unpack_from('<2I', b, 0)
    o = 8
    bones = []
    for _ in range(n):
        name, o, raw = _name(b, o)
        parent = struct.unpack_from('<h', b, o)[0]
        o += 2
        m = struct.unpack_from('<12f', b, o)
        o += 48
        bones.append({'name': name, 'parent': parent, 'm12': m, 'rawName': raw})
    return {'version': ver, 'bones': bones, 'size': len(b), 'consumed': o}


def parse_skn(src):
    b = _load(src)
    ver, n = struct.unpack_from('<2I', b, 0)
    o = 8
    verts = []
    for _ in range(n):
        pos = struct.unpack_from('<3f', b, o)
        o += 12
        k = b[o]
        o += 1
        infl = []
        for _ in range(k):
            bone, w = struct.unpack_from('<Hf', b, o)
            off = struct.unpack_from('<3f', b, o + 6)
            o += 18
            infl.append((bone, w, off))
        verts.append({'pos': pos, 'influences': infl})
    nb = struct.unpack_from('<H', b, o)[0]
    o += 2
    names = []
    for _ in range(nb):
        nm, o, _raw = _name(b, o)
        names.append(nm)
    return {'version': ver, 'vertices': verts, 'boneNames': names, 'size': len(b), 'consumed': o}


def parse_baf(src):
    """keys[frame][bone] = (q_raw(i16 x4), q(float x4), pos(f32 x3)) for v2, or m12 for v1."""
    b = _load(src)
    ver = struct.unpack_from('<I', b, 0)[0]
    nb = struct.unpack_from('<H', b, 4)[0]
    o = 6
    names = []
    for _ in range(nb):
        nm, o, _raw = _name(b, o)
        names.append(nm)
    nf = struct.unpack_from('<I', b, o)[0]
    o += 4
    keys = []
    for _ in range(nf):
        fr = []
        for _ in range(nb):
            if ver == 2:
                qr = struct.unpack_from('<4h', b, o)
                p = struct.unpack_from('<3f', b, o + 8)
                fr.append((qr, tuple(x * QSCALE for x in qr), p))
                o += 20
            else:
                fr.append(struct.unpack_from('<12f', b, o))
                o += 48
        keys.append(fr)
    return {'version': ver, 'boneNames': names, 'frames': nf, 'keys': keys, 'size': len(b), 'consumed': o,
            'loadable': ver == 2}


def parse_spl(src):
    t = _load(src).decode('latin1')
    out = {'cvs': []}
    for line in t.splitlines():
        line = line.strip()
        if not line or '=' not in line:
            continue
        k, v = line.split('=', 1)
        if k.startswith('cv['):
            out['cvs'].append(tuple(float(x) for x in v.split(',')))
        else:
            out[k] = int(v)
    return out


# ----------------------------------------------------------------------------------------------- 4x4 maths
def mat_identity():
    return [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def mat_mul(a, b):
    """FUN_005d5a60(a, b, out): out = a * b (row-major, row vectors)."""
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def root_matrix():
    c, s = math.cos(A_ROOT), math.sin(A_ROOT)
    return [[1.0, 0.0, 0.0, 0.0], [0.0, c, -s, 0.0], [0.0, s, c, 0.0], [0.0, 0.0, 0.0, 1.0]]


R0 = root_matrix()


def ske_local(m):
    """.ske 12 floats -> engine local 4x4 (0x4faab7-0x4fabad)."""
    return [[m[0], m[4], m[8], 0.0], [m[1], m[5], m[9], 0.0], [m[2], m[6], m[10], 0.0], [m[3], m[7], m[11], 1.0]]


def quat_matrix(q, pos, prev=None):
    """FUN_004fb030 with weight 1: q = (x, y, z, w); pos None keeps prev's translation."""
    x, y, z, w = q
    s = 2.0 / (x * x + y * y + z * z + w * w)
    ys, zs = y * s, z * s
    xws, xxs = x * s * w, x * x * s
    M = [[1 - (y * ys + z * zs), x * ys - zs * w, x * zs + ys * w, 0.0],
         [x * ys + zs * w, 1 - (z * zs + xxs), y * zs - xws, 0.0],
         [x * zs - ys * w, y * zs + xws, 1 - (y * ys + xxs), 0.0],
         [0.0, 0.0, 0.0, 1.0]]
    t = pos if pos is not None else (prev[3][:3] if prev is not None else (0.0, 0.0, 0.0))
    M[3][0], M[3][1], M[3][2] = t[0], t[1], t[2]
    return M


def matrix_quat(M):
    """FUN_004fcab0: rotation part -> q (x, y, z, w) (the inverse of quat_matrix)."""
    tr = M[0][0] + M[2][2] + M[1][1]
    if tr > 0.0:
        r = math.sqrt(tr + 1.0)
        w = r * 0.5
        r = 0.5 / r
        return ((M[2][1] - M[1][2]) * r, (M[0][2] - M[2][0]) * r, (M[1][0] - M[0][1]) * r, w)
    i = 1 if M[0][0] < M[1][1] else 0
    if M[i][i] < M[2][2]:
        i = 2
    nxt = (1, 2, 0)
    j, k = nxt[i], nxt[nxt[i]]
    r = math.sqrt(M[i][i] - (M[j][j] + M[k][k]) + 1.0)
    q = [0.0, 0.0, 0.0, 0.0]
    q[i] = r * 0.5
    r = 0.5 / r
    q[3] = (M[k][j] - M[j][k]) * r
    q[j] = (M[j][i] + M[i][j]) * r
    q[k] = (M[k][i] + M[i][k]) * r
    return tuple(q)


def nlerp(a, b, t):
    """the blend of FUN_004fd220 / FUN_004fb030: sign-corrected linear blend, renormalised."""
    d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
    tb = t if d >= 0.0 else -t
    ta = 1.0 - t
    q = [a[i] * ta + b[i] * tb for i in range(4)]
    n = 1.0 / math.sqrt(sum(x * x for x in q))
    return tuple(x * n for x in q)


def set_bone_key(local, q, pos, weight):
    """FUN_004fb030(bone, q, pos, weight): returns the new local 4x4."""
    if weight == 1.0:
        return quat_matrix(q, pos, local)
    q0 = matrix_quat(local)
    M = quat_matrix(nlerp(q0, q, weight), None, local)
    if pos is not None:                                  # FUN_004fb370: t += (pos - t) * weight
        for i in range(3):
            M[3][i] = local[3][i] + (pos[i] - local[3][i]) * weight
    return M


# ----------------------------------------------------------------------------------------------- clip sampling
def clip_frames(phase, n, loop):
    """FUN_004fd220 time mapping (0x4fd2b7-0x4fd363): phase = normalised clip time.
    returns (i0, i1, t)."""
    if not loop:
        if phase > 1.0 and n >= 2:
            return n - 2, n - 1, 1.0
        if phase < 0.0:
            return 0, 1 % n, 0.0
        N = n - 1
    else:
        N = n
    fr = math.modf(phase)[0]
    if fr < 0.0:
        fr += 1.0
    p = fr * N
    i = int(p)                                           # _ftol: truncation
    i0 = i % n
    return i0, (i0 + 1) % n, p - i


def sample_clip(baf, phase, loop):
    """-> list per .baf bone of (q, pos|None) exactly as FUN_004fd220 hands them to FUN_004fb030."""
    i0, i1, t = clip_frames(phase, baf['frames'], loop)
    A, B = baf['keys'][i0], baf['keys'][i1]
    out = []
    for j in range(len(baf['boneNames'])):
        qa, pa = A[j][1], A[j][2]
        qb, pb = B[j][1], B[j][2]
        q = nlerp(qa, qb, t)
        pos = None if tuple(pa) == tuple(pb) else tuple(pa[k] + (pb[k] - pa[k]) * t for k in range(3))
        out.append((q, pos))
    return out


def compose(bones, locals_, root=R0, extras=None):
    """FUN_004fb7c0 without the IK channels: world matrices of every bone (bones in file order, parents first)."""
    W = []
    for i, bn in enumerate(bones):
        L = locals_[i]
        X = extras.get(i) if extras else None
        if bn['parent'] < 0:
            M = mat_mul(L, root) if root is not None else [r[:] for r in L]
            if X is not None:
                M = mat_mul(M, X)
        else:
            M = mat_mul(L, W[bn['parent']])
            if X is not None:
                t = M[3][:3]
                M[3][0] = M[3][1] = M[3][2] = 0.0
                M = mat_mul(M, X)
                M[3][0], M[3][1], M[3][2] = t
        W.append(M)
    return W


def skin_positions(skn, bone_names, W):
    """SkinningShader2Bones: p = sum w * ([off,1] * W_bone)."""
    idx = {n: i for i, n in enumerate(bone_names)}
    out = []
    for v in skn['vertices']:
        p = [0.0, 0.0, 0.0]
        for bi, w, off in v['influences']:
            M = W[idx[skn['boneNames'][bi]]]
            for c in range(3):
                p[c] += w * (off[0] * M[0][c] + off[1] * M[1][c] + off[2] * M[2][c] + M[3][c])
        out.append(tuple(p))
    return out


def bind_to_model(p):
    """.skn / .sm bind position (Biped, z up) -> engine model space (LH, y up) [D]."""
    return (-p[0], p[2], p[1])


def map_sm_to_skin(positions, skn, tol=1e-3):
    """FUN_00589480 matches each .sm vertex to the skin record with the same position (FUN_0049d960).
    returns the skin-record index per .sm vertex (-1 if none within tol)."""
    keys = {}
    for i, v in enumerate(skn['vertices']):
        keys.setdefault(tuple(round(c, 3) for c in v['pos']), i)
    out = []
    for p in positions:
        k = tuple(round(c, 3) for c in p)
        i = keys.get(k, -1)
        if i < 0:
            best, bd = -1, tol
            for j, v in enumerate(skn['vertices']):
                d = max(abs(v['pos'][c] - p[c]) for c in range(3))
                if d <= bd:
                    best, bd = j, d
            i = best
        out.append(i)
    return out


# ----------------------------------------------------------------------------------------------- validation
def _walk(root):
    for dp, dn, fn in os.walk(root):
        for f in sorted(fn):
            yield os.path.join(dp, f)


def cmd_validate(root):
    """parse every .ske/.skn/.baf/.spl under root to its exact end and run the convention checks."""
    import numpy as np
    counts = {'ske': 0, 'skn': 0, 'baf': 0, 'spl': 0}
    bad = []
    total = 0
    files = {}
    for p in _walk(root):
        ext = p.lower().rsplit('.', 1)[-1]
        if ext not in counts:
            continue
        try:
            r = {'ske': parse_ske, 'skn': parse_skn, 'baf': parse_baf, 'spl': parse_spl}[ext](p)
        except Exception as e:      # noqa
            bad.append((p, repr(e)))
            continue
        counts[ext] += 1
        total += os.path.getsize(p)
        files[os.path.relpath(p, root).lower().replace('\\', '/')] = r
        if ext != 'spl' and r['consumed'] != r['size']:
            bad.append((p, 'leftover %d' % (r['size'] - r['consumed'])))
        if ext == 'ske':
            for i, bn in enumerate(r['bones']):
                if not (bn['parent'] < i):
                    bad.append((p, 'parent order'))
                R = np.array(ske_local(bn['m12']))[:3, :3]
                if np.abs(R @ R.T - np.eye(3)).max() > 2e-3:
                    bad.append((p, 'non-orthonormal ' + bn['name']))
        if ext == 'skn':
            for v in r['vertices']:
                if abs(sum(i[1] for i in v['influences']) - 1) > 1e-3 or not 1 <= len(v['influences']) <= 2:
                    bad.append((p, 'weights'))
                    break
        if ext == 'baf' and r['version'] == 2:
            for fr in r['keys']:
                if any(abs(sum(x * x for x in q) - 1) > 1e-2 for _qr, q, _p in fr):
                    bad.append((p, 'quat norm'))
                    break
    print('parsed', counts, 'bytes', total, 'failures', len(bad))
    for x in bad:
        print('BAD', x)
    # convention check: .ske bind pose skinned with the engine rules vs the .skn bind positions
    for key, r in sorted(files.items()):
        if not key.endswith('.ske'):
            continue
        skn = files.get(key[:-4] + '.skn')
        if not skn:
            continue
        names = [b['name'] for b in r['bones']]
        if any(n not in names for n in skn['boneNames']):
            print('ske/skn bone mismatch', key)
            continue
        W = compose(r['bones'], [ske_local(b['m12']) for b in r['bones']])
        P = np.array(skin_positions(skn, names, W))
        T = np.array([bind_to_model(v['pos']) for v in skn['vertices']])
        e = np.linalg.norm(P - T, axis=1)
        print('%-36s ske bind vs skn bind (model space): median %.4f m  max %.4f m' % (key, np.median(e), e.max()))
    return 1 if bad else 0


def main(argv):
    if len(argv) >= 2 and argv[1] == 'validate':
        here = os.path.dirname(os.path.abspath(__file__))
        root = argv[2] if len(argv) > 2 else os.path.join(here, '..', '..', '..', '..', '.cache', 'original', 'Misc',
                                                           'animations')
        return cmd_validate(os.path.abspath(root))
    print(__doc__)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
