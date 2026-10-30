#!/usr/bin/env python3
"""fmt_standardmesh.py -- Refractor2 (rally) StandardMesh .sm / TreeMesh .tm / subshader .rs reader.

Byte layouts are decomp-verified; see research/formats/standardmesh.md for the spec and the
function citations (FUN_0058bbc0 .sm load chain, FUN_0057ad00 .tm loader, FUN_005975c0 collision).

Library:
    parse_sm(data|path)  -> dict   (StandardMesh / AnimatedMesh file, version 7)
    parse_tm(data|path)  -> dict   (TreeMesh file, version 5)
    parse_rs(text|path)  -> list   (subshader blocks)
    fvf_layout(code)     -> (stride, [(name, byte_offset, n_floats)])   engine vertex-format bits
    sm_vertices(sm, mat) -> dict name -> list of tuples
    sm_triangles(mat, idx) -> list of (a, b, c)   (list or strip, degenerates dropped)
CLI (run with research/.venv/bin/python -I):
    fmt_standardmesh.py validate [root]            parse every .sm/.tm/.rs under root (default research/full)
    fmt_standardmesh.py info <file.sm|.tm>         dump structure
    fmt_standardmesh.py obj <file.sm|.tm> <out.obj> [--lod N] [--rh]
                                                   OBJ (+.mtl) export; raw original (LH) coords unless --rh
                                                   (--rh: z -> -z and winding swapped, i.e. three.js space)
"""
import os
import struct
import sys

SM_VERSION = 7          # FUN_0058bdb0: cmp [esp+0x10],7
TM_VERSION = 5          # FUN_0057ad00: cmp [esp+0x58],5
COLLISION_VERSION = 4   # FUN_005975c0: cmp [esp+0xc],4
CLASS_COLLISION_SIMPLE = 0xEB97C2FA   # dice.ref2.geom.CollisionMesh.Simple (registration @0x5934d8)
CLASS_COLLISION_GRID = 0x62FCC2FE     # dice.ref2.geom.CollisionMesh.Grid  ([0x80d680], @0x593588)
PRIM_TRIANGLELIST = 4   # D3DPT_TRIANGLELIST (material +0x14 -> renderer DrawIndexed, FUN_00580160)
PRIM_TRIANGLESTRIP = 5  # D3DPT_TRIANGLESTRIP

# Engine vertex format bits -> (size, attribute name).  Order = D3D8 FVF order.
# Stride calculator FUN_0068a240, D3D FVF converter FUN_007ec800 (both [V]).
_FVF_ORDER = [
    (0x00000001, 12, 'position', 3),      # D3DFVF_XYZ
    (0x00000004, 16, 'positionRHW', 4),   # D3DFVF_XYZRHW
    (0x00200000, 4, 'blend1', 1),         # D3DFVF_XYZB1
    (0x00400000, 8, 'blend2', 2),         # D3DFVF_XYZB2
    (0x00800000, 12, 'blend3', 3),        # D3DFVF_XYZB3
    (0x01000000, 16, 'blend4', 4),        # D3DFVF_XYZB4
    (0x20000000, 4, 'blendExtra', 1),     # extra 4 bytes (FVF |= 4)  [?] never used by data
    (0x00000010, 12, 'normal', 3),        # D3DFVF_NORMAL
    (0x00000040, 4, 'psize_or_diffuse', 1),  # FVF 0x40 (D3DFVF_DIFFUSE in D3D8 numbering)
    (0x00000100, 4, 'specular', 1),       # FVF 0x80
]
# texcoord sets: (1D, 2D, 3D, 4D) bit per set
_TEX_BITS = [
    (0x00000200, 0x00000400, 0x00000800, 0x02000000),
    (0x00001000, 0x00002000, 0x00004000, 0x04000000),
    (0x00008000, 0x00010000, 0x00020000, 0x08000000),
    (0x00040000, 0x00080000, 0x00100000, 0x10000000),
]


def fvf_layout(code):
    """Engine vertex format -> (stride, [(name, offset, n_floats)])."""
    out = []
    off = 0
    for bit, size, name, n in _FVF_ORDER:
        if code & bit:
            out.append((name, off, n))
            off += size
    for t, bits in enumerate(_TEX_BITS):
        for dim, bit in enumerate(bits):
            if code & bit:
                out.append(('uv%d' % t, off, dim + 1))
                off += 4 * (dim + 1)
                break
    return off, out


class Reader:
    def __init__(self, data):
        self.b = data
        self.o = 0

    def u8(self):
        v = self.b[self.o]
        self.o += 1
        return v

    def u32(self):
        v = struct.unpack_from('<I', self.b, self.o)[0]
        self.o += 4
        return v

    def f32(self, n=1):
        v = struct.unpack_from('<%df' % n, self.b, self.o)
        self.o += 4 * n
        return v if n > 1 else v[0]

    def raw(self, n):
        if self.o + n > len(self.b):
            raise ValueError('read past end (%d + %d > %d)' % (self.o, n, len(self.b)))
        v = self.b[self.o:self.o + n]
        self.o += n
        return v

    def string(self):
        # FUN_005b8430: u32 length, then length bytes (no terminator)
        n = self.u32()
        return self.raw(n).decode('latin1')

    def aabb(self):
        # FUN_005b8620: 24 bytes min.xyz max.xyz (engine then derives two radii)
        v = self.f32(6)
        return {'min': v[0:3], 'max': v[3:6]}


def _load(src):
    if isinstance(src, (bytes, bytearray)):
        return bytes(src)
    with open(src, 'rb') as f:
        return f.read()


# --------------------------------------------------------------------------------------------
# CollisionMesh.Simple (version 4) -- FUN_005975c0 + FUN_007e5e20 + FUN_007e6030
# --------------------------------------------------------------------------------------------
def parse_collision_simple(r):
    c = {'start': r.o}
    c['version'] = r.u32()
    if c['version'] != COLLISION_VERSION:
        raise ValueError('collision version %d' % c['version'])
    nv = r.u32()
    c['vertices'] = [struct.unpack_from('<3fI', r.b, r.o + 16 * i) for i in range(nv)]  # x,y,z,u32
    r.o += 16 * nv
    ni = r.u32()
    c['indices'] = list(struct.unpack_from('<%dI' % ni, r.b, r.o))
    r.o += 4 * ni
    nf = r.u32()
    c['faces'] = [struct.unpack_from('<3fI', r.b, r.o + 16 * i) for i in range(nf)]  # n.xyz, u32 flags
    r.o += 16 * nf
    # BSP part (FUN_007e5e20)
    c['bspRefTotal'] = r.u32()     # -> +0x40, allocates *4 (pointer pool for leaf lists)
    c['bspNodeCount'] = r.u32()    # -> +0x34, allocates *0x28 (non-root nodes)
    ntri = r.u32()                 # -> +0x2c, raw 32-byte records
    c['bspTris'] = [struct.unpack_from('<4f3II', r.b, r.o + 32 * i) for i in range(ntri)]
    r.o += 32 * ntri
    nodes = []

    def node(depth):
        plane = r.f32(6)          # 0x18 bytes (FUN_007e6030 'read 0x18 -> node+8')
        n = r.u32()
        items = list(struct.unpack_from('<%dI' % n, r.b, r.o))
        r.o += 4 * n
        idx = len(nodes)
        nodes.append({'depth': depth, 'v6': plane, 'items': items, 'left': None, 'right': None})
        if r.u8():
            nodes[idx]['left'] = node(depth + 1)
        if r.u8():
            nodes[idx]['right'] = node(depth + 1)
        return idx

    node(0)
    c['bspNodes'] = nodes
    c['end'] = r.o
    return c


def parse_collision_block(r, cls):
    if cls == CLASS_COLLISION_SIMPLE:
        return parse_collision_simple(r)
    raise ValueError('unknown collision class 0x%08x' % cls)


# --------------------------------------------------------------------------------------------
# StandardMesh .sm (also AnimatedMesh: identical bytes, other in-memory material struct)
# --------------------------------------------------------------------------------------------
def parse_sm(src, keep_data=True):
    b = _load(src)
    r = Reader(b)
    sm = {'size': len(b)}
    # FUN_0058bdb0 (vtable +0xa4)
    sm['version'] = r.u32()
    if sm['version'] != SM_VERSION:
        raise ValueError('sm version %d' % sm['version'])
    sm['headerUnknown'] = r.u32()          # read into a stack temp and discarded
    sm['bbox'] = r.aabb()                  # -> template+0x40 (+0x58 radius copied to +0x60)
    # FUN_0058be00 (vtable +0xa8)
    sm['collisionSize'] = r.u32()          # loader only tests > 0; value = byte size of the block [E]
    sm['collision'] = None
    if sm['collisionSize']:
        cstart = r.o
        cls = r.u32()
        sm['collisionClass'] = cls
        sm['collision'] = parse_collision_block(r, cls)
        sm['collisionSizeOk'] = (r.o - cstart) == sm['collisionSize']
    # FUN_005813e0 / FUN_0058be90 (vtable +0xac): LODs
    nlod = r.u32()
    sm['lods'] = []
    for li in range(nlod):
        # FUN_00581500 / FUN_0058bfb0 (vtable +0xb0): materials of one LOD
        nm = r.u32()
        mats = []
        for mi in range(nm):
            m = {}
            m['name'] = r.string()                  # -> mat+0x00 (subshader name in the .rs)
            m['reserved12'] = struct.unpack_from('<3I', b, r.o)
            r.o += 12                               # -> mat+0x20, never read by renderer [?]
            m['primType'] = r.u32()                 # -> mat+0x14, D3DPRIMITIVETYPE
            m['vertexFormat'] = r.u32()             # -> CreateVertexBuffer(0x14, fmt, n)
            m['stride'] = r.u32()
            m['vertexCount'] = r.u32()
            m['indexCount'] = r.u32()               # -> mat+0x30
            m['reserved2c'] = r.u32()               # -> mat+0x2c [?]
            mats.append(m)
        for m in mats:                              # vertex blobs, then index blob, per material
            m['vertexOffset'] = r.o
            vb = r.raw(m['vertexCount'] * m['stride'])
            m['indexOffset'] = r.o
            ib = r.raw(m['indexCount'] * 2)
            if keep_data:
                m['vb'] = vb
                m['ib'] = ib
        sm['lods'].append(mats)
    sm['leftover'] = len(b) - r.o
    return sm


def sm_vertices(mat):
    stride, layout = fvf_layout(mat['vertexFormat'])
    if stride != mat['stride']:
        raise ValueError('stride mismatch fmt 0x%x: %d vs %d' % (mat['vertexFormat'], stride, mat['stride']))
    vb = mat['vb']
    n = mat['vertexCount']
    out = {}
    for name, off, comps in layout:
        out[name] = [struct.unpack_from('<%df' % comps, vb, i * stride + off) for i in range(n)]
    return out


def indices_of(mat):
    return list(struct.unpack_from('<%dH' % mat['indexCount'], mat['ib'], 0))


def sm_triangles(prim, idx):
    """D3D list/strip -> triangles in original winding (front = clockwise on screen, D3DCULL_CCW)."""
    tris = []
    if prim == PRIM_TRIANGLELIST:
        for i in range(0, len(idx) - 2, 3):
            tris.append((idx[i], idx[i + 1], idx[i + 2]))
    elif prim == PRIM_TRIANGLESTRIP:
        for i in range(len(idx) - 2):
            a, b_, c = idx[i], idx[i + 1], idx[i + 2]
            if a == b_ or b_ == c or a == c:
                continue                          # degenerate join triangle
            tris.append((a, b_, c) if i % 2 == 0 else (b_, a, c))
    else:
        raise ValueError('prim type %d' % prim)
    return tris


# --------------------------------------------------------------------------------------------
# TreeMesh .tm -- FUN_0057ad00
# --------------------------------------------------------------------------------------------
TM_GROUP_NAMES = ('branches', 'trunk', 'sprites', 'facing')   # template +0x1c/+0x2c/+0x3c/+0x4c
TM_VERTEX = (('position', 0, 3), ('normal', 12, 3), ('uv0', 24, 2), ('spriteOffset', 32, 2))
TM_STRIDE = 40                                                 # FUN_0057cc90 element 0x28


def parse_tm(src, keep_data=True):
    b = _load(src)
    r = Reader(b)
    tm = {'size': len(b)}
    tm['version'] = r.u32()
    tm['headerUnknown'] = r.u32()
    if tm['version'] != TM_VERSION:
        raise ValueError('tm version %d' % tm['version'])
    tm['sortDirections'] = r.u32()            # -> +0xec (8 in every file)
    tm['bbox'] = r.aabb()                     # -> +0x5c
    tm['spriteBBox'] = r.aabb()               # -> +0x7c
    tm['crownRadius'] = r.f32()               # -> +0xa8
    tm['crownCenter'] = r.f32(3)              # -> +0x9c..+0xa4
    tm['crownCenterRaw'] = struct.unpack_from('<3I', b, r.o - 12)
    tm['groups'] = []
    for g in range(4):
        n = r.u32()
        lst = []
        for i in range(n):
            # FUN_0057a530: u32, u32, string -> element +0, +4, +8 (0x1c bytes in memory)
            start = r.u32()
            tris = r.u32()
            tex = r.string()
            lst.append({'startIndex': start, 'triCount': tris, 'texture': tex})
        tm['groups'].append(lst)
    cls = r.u32()                              # class id (0 = none), created + read directly
    tm['collisionClass'] = cls
    tm['collision'] = parse_collision_block(r, cls) if cls else None
    nv = r.u32()
    tm['vertexCount'] = nv
    tm['vertexOffset'] = r.o
    vb = r.raw(nv * TM_STRIDE)
    ni = r.u32()
    tm['indexCount'] = ni
    tm['indexOffset'] = r.o
    ib = r.raw(ni * 2)
    if keep_data:
        tm['vb'] = vb
        tm['ib'] = ib
    tm['leftover'] = len(b) - r.o
    return tm


def tm_vertices(tm):
    vb = tm['vb']
    out = {}
    for name, off, comps in TM_VERTEX:
        out[name] = [struct.unpack_from('<%df' % comps, vb, i * TM_STRIDE + off)
                     for i in range(tm['vertexCount'])]
    return out


def tm_group_triangles(tm, group, item, variant=0):
    """Triangles of one texture group.  Groups 0 (branches) and 2 (sprites) store
    sortDirections pre-sorted copies back to back; `variant` selects one (FUN_00590670)."""
    idx = struct.unpack_from('<%dH' % tm['indexCount'], tm['ib'], 0)
    it = tm['groups'][group][item]
    nvar = tm['sortDirections'] if group in (0, 2) and tm['sortDirections'] >= 2 else 1
    v = min(variant, nvar - 1)
    s = it['startIndex'] + it['triCount'] * 3 * v
    return [(idx[s + 3 * k], idx[s + 3 * k + 1], idx[s + 3 * k + 2]) for k in range(it['triCount'])]


def tm_sort_variant(local_dir_x, local_dir_z, n=8):
    """FUN_00591d50 + FUN_00591e30: pick the pre-sorted index copy from the horizontal direction
    tree->camera expressed in the tree's local frame (x = local X axis, z = local Z axis)."""
    l2 = local_dir_x * local_dir_x + local_dir_z * local_dir_z
    if l2 > 0 and abs(l2 - 1.0) >= 1e-12:
        inv = l2 ** -0.5
        local_dir_x *= inv
        local_dir_z *= inv
    u = 0.25 - local_dir_z * 0.249975
    if local_dir_x < 0.0:
        u = 1.0 - u
    return min(int(u * n), n - 1)


# --------------------------------------------------------------------------------------------
# .rs subshader files (text)
# --------------------------------------------------------------------------------------------
def parse_rs(src):
    if isinstance(src, (bytes, bytearray)):
        text = bytes(src).decode('latin1')
    elif os.path.exists(src):
        with open(src, 'rb') as f:
            text = f.read().decode('latin1')
    else:
        text = src
    out = []
    i = 0
    n = len(text)
    toks = []
    # tokenizer: strings, braces, semicolons, words; // and rem comments are not used in .rs
    while i < n:
        ch = text[i]
        if ch.isspace():
            i += 1
        elif ch == '"':
            j = text.index('"', i + 1)
            toks.append(('str', text[i + 1:j]))
            i = j + 1
        elif ch in '{};':
            toks.append((ch, ch))
            i += 1
        elif text.startswith('//', i):
            j = text.find('\n', i)
            i = n if j < 0 else j
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in '{};"':
                j += 1
            toks.append(('word', text[i:j]))
            i = j
    k = 0
    while k < len(toks):
        t = toks[k]
        if t == ('word', 'subshader'):
            name = toks[k + 1][1]
            builder = toks[k + 2][1]
            assert toks[k + 3][0] == '{', toks[k:k + 4]
            k += 4
            props = []
            cur = []
            while toks[k][0] != '}':
                if toks[k][0] == ';':
                    if cur:
                        props.append((cur[0], cur[1:]))
                    cur = []
                else:
                    cur.append(toks[k][1])
                k += 1
            if cur:
                props.append((cur[0], cur[1:]))
            out.append({'name': name, 'builder': builder, 'props': props})
            k += 1
        else:
            k += 1
    return out


def rs_value(props, key, default=None):
    for k, v in props:
        if k.lower() == key.lower():
            return v
    return default


# --------------------------------------------------------------------------------------------
# texture lookup (texture/<name> -> a .dds/.tga somewhere in research/full)
# --------------------------------------------------------------------------------------------
_TEX_INDEX = None


def find_texture(name, root=None):
    global _TEX_INDEX
    root = root or default_root()
    if _TEX_INDEX is None:
        _TEX_INDEX = {}
        for dp, dn, fn in os.walk(root):
            low = dp.lower()
            if '/texture' not in low and '/billboards' not in low:
                continue
            for f in fn:
                base, ext = os.path.splitext(f)
                if ext.lower() not in ('.dds', '.tga'):
                    continue
                key = base.lower()
                # prefer Misc/texture, then .dds
                rank = (0 if '/misc/texture' in low else 1, 0 if ext.lower() == '.dds' else 1)
                full = os.path.join(dp, f)
                sub = os.path.relpath(dp, root).lower().split('texture', 1)[-1].strip('/')
                for k in {key, (sub + '/' + key).strip('/')}:
                    if k not in _TEX_INDEX or rank < _TEX_INDEX[k][0]:
                        _TEX_INDEX[k] = (rank, full)
    n = name.replace('\\', '/').strip()
    low = n.lower()
    if low.startswith('texture/'):
        low = low[len('texture/'):]
    if low.endswith('.'):
        low = low[:-1]
    low = os.path.splitext(low)[0] if low.endswith(('.dds', '.tga')) else low
    hit = _TEX_INDEX.get(low) or _TEX_INDEX.get(low.split('/')[-1])
    return hit[1] if hit else None


def default_root():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from _paths import FULL  # rally-web: data root
    return FULL


# --------------------------------------------------------------------------------------------
# OBJ export
# --------------------------------------------------------------------------------------------
def write_obj(path, out_obj, lod=0, rh=False, rs_path=None):
    base = os.path.splitext(out_obj)[0]
    mtl_name = os.path.basename(base) + '.mtl'
    lines = ['# exported by fmt_standardmesh.py from %s' % os.path.basename(path),
             '# coords: %s' % ('three.js (x, y, -z), winding swapped' if rh else
                              'original LH (x right, y up, z fwd), D3D CW front faces'),
             'mtllib %s' % mtl_name]
    mtl = []
    vbase = 1
    rs = {}
    if rs_path is None:
        cand = os.path.splitext(path)[0] + '.rs'
        rs_path = cand if os.path.exists(cand) else None
    if rs_path:
        for s in parse_rs(rs_path):
            rs[s['name']] = s

    def emit(name, pos, nrm, uv, tris, tex):
        nonlocal vbase
        lines.append('o %s' % name)
        lines.append('usemtl %s' % name)
        for p in pos:
            lines.append('v %.6f %.6f %.6f' % (p[0], p[1], -p[2] if rh else p[2]))
        for t in uv:
            lines.append('vt %.6f %.6f' % (t[0], 1.0 - t[1]))   # D3D v down -> OBJ v up
        for q in nrm:
            lines.append('vn %.6f %.6f %.6f' % (q[0], q[1], -q[2] if rh else q[2]))
        for a, b_, c in tris:
            if rh:
                b_, c = c, b_
            ids = []
            for k in (a, b_, c):
                s = str(k + vbase)
                s += '/' + (str(k + vbase) if uv else '')
                if nrm:
                    s += '/' + str(k + vbase)
                ids.append(s.rstrip('/'))
            lines.append('f ' + ' '.join(ids))
        mtl.append('newmtl %s' % name)
        mtl.append('Kd 1 1 1')
        if tex:
            mtl.append('map_Kd %s' % tex)
        vbase += len(pos)

    if path.lower().endswith('.tm'):
        tm = parse_tm(path)
        V = tm_vertices(tm)
        used = {}
        for g in range(4):
            for it_i, it in enumerate(tm['groups'][g]):
                tris = tm_group_triangles(tm, g, it_i, 0)
                # compact vertex set
                ids = sorted({k for t in tris for k in t})
                remap = {k: i for i, k in enumerate(ids)}
                pos = [V['position'][k] for k in ids]
                if g == 2:
                    # sprites: emit as fixed quads facing -z (viewer at -z) for preview
                    pos = [(V['position'][k][0] + V['spriteOffset'][k][0], V['position'][k][1] +
                            V['spriteOffset'][k][1], V['position'][k][2]) for k in ids]
                nrm = [V['normal'][k] for k in ids]
                uv = [V['uv0'][k] for k in ids]
                tex = find_texture(it['texture'])
                nm = '%s_%d_%s' % (TM_GROUP_NAMES[g], it_i, os.path.basename(it['texture']) or 'none')
                emit(nm.replace(' ', '_'), pos, nrm, uv, [tuple(remap[k] for k in t) for t in tris],
                     os.path.relpath(tex, os.path.dirname(out_obj)) if tex else None)
    else:
        sm = parse_sm(path)
        lod = min(lod, len(sm['lods']) - 1)
        for mi, m in enumerate(sm['lods'][lod]):
            V = sm_vertices(m)
            tris = sm_triangles(m['primType'], indices_of(m))
            tex = None
            s = rs.get(m['name'])
            if s:
                t = rs_value(s['props'], 'texture')
                if t:
                    tex = find_texture(t[0])
            nm = ('%d_%s' % (mi, m['name'] or 'unnamed')).replace(' ', '_')
            emit(nm, V['position'], V.get('normal', []), V.get('uv0', []), tris,
                 os.path.relpath(tex, os.path.dirname(out_obj)) if tex else None)
    with open(out_obj, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    with open(base + '.mtl', 'w') as f:
        f.write('\n'.join(mtl) + '\n')


# --------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------
def _walk(root, exts):
    for dp, dn, fn in os.walk(root):
        for f in sorted(fn):
            if f.lower().endswith(exts):
                yield os.path.join(dp, f)


def cmd_validate(root):
    import collections
    stats = collections.Counter()
    fmts = collections.Counter()
    bad = []
    for p in _walk(root, ('.sm',)):
        try:
            sm = parse_sm(p, keep_data=True)
        except Exception as e:  # noqa
            bad.append((p, repr(e)))
            continue
        stats['sm'] += 1
        if sm['leftover']:
            bad.append((p, 'leftover %d' % sm['leftover']))
        if sm['collision'] is not None:
            stats['sm_with_collision'] += 1
            if not sm['collisionSizeOk']:
                bad.append((p, 'collision size field mismatch'))
        stats['sm_lods_%d' % len(sm['lods'])] += 1
        for lod in sm['lods']:
            for m in lod:
                stride, _ = fvf_layout(m['vertexFormat'])
                if stride != m['stride']:
                    bad.append((p, 'stride mismatch'))
                idx = indices_of(m)
                if idx and max(idx) >= m['vertexCount']:
                    bad.append((p, 'index out of range'))
                fmts[(m['vertexFormat'], m['stride'], m['primType'])] += 1
                stats['materials'] += 1
    for p in _walk(root, ('.tm',)):
        try:
            tm = parse_tm(p, keep_data=True)
        except Exception as e:  # noqa
            bad.append((p, repr(e)))
            continue
        stats['tm'] += 1
        if tm['leftover']:
            bad.append((p, 'leftover %d' % tm['leftover']))
        if tm['collision'] is not None:
            stats['tm_with_collision'] += 1
        idx = struct.unpack_from('<%dH' % tm['indexCount'], tm['ib'], 0)
        if idx and max(idx) >= tm['vertexCount']:
            bad.append((p, 'index out of range'))
        # every group fits in the index buffer (with the 8 sorted copies for groups 0/2)
        for g in range(4):
            for it in tm['groups'][g]:
                nvar = tm['sortDirections'] if g in (0, 2) else 1
                if it['startIndex'] + it['triCount'] * 3 * nvar > tm['indexCount']:
                    bad.append((p, 'group %d overruns index buffer' % g))
                stats['tm_group%d' % g] += 1
    nrs = 0
    nsub = collections.Counter()
    for p in _walk(root, ('.rs',)):
        try:
            subs = parse_rs(p)
        except Exception as e:  # noqa
            bad.append((p, repr(e)))
            continue
        nrs += 1
        for s in subs:
            nsub[s['builder']] += 1
    print('parsed: %d .sm, %d .tm, %d .rs  (failures/leftovers: %d)' % (stats['sm'], stats['tm'], nrs, len(bad)))
    for k in sorted(stats):
        print('  %-22s %d' % (k, stats[k]))
    print('vertex formats (fmt, stride, prim): count')
    for k, v in sorted(fmts.items()):
        print('  0x%06x %2d %d : %d   %s' % (k + (v, [a[0] for a in fvf_layout(k[0])[1]])))
    print('subshader builders:', dict(nsub))
    for b_ in bad[:50]:
        print('BAD', b_)
    return 0 if not bad else 1


def cmd_info(path):
    if path.lower().endswith('.tm'):
        tm = parse_tm(path, keep_data=False)
        for k in ('version', 'headerUnknown', 'sortDirections', 'bbox', 'spriteBBox', 'crownRadius',
                  'crownCenter', 'collisionClass', 'vertexCount', 'indexCount', 'leftover'):
            print('%-16s %s' % (k, tm[k]))
        for g, lst in enumerate(tm['groups']):
            for it in lst:
                print('group %d %-9s start %6d tris %5d  %s' % (g, TM_GROUP_NAMES[g], it['startIndex'],
                                                               it['triCount'], it['texture']))
    else:
        sm = parse_sm(path, keep_data=False)
        for k in ('version', 'headerUnknown', 'bbox', 'collisionSize', 'leftover'):
            print('%-16s %s' % (k, sm[k]))
        if sm['collision']:
            c = sm['collision']
            print('collision: %d verts, %d tris, %d bsp nodes' % (len(c['vertices']), len(c['faces']),
                                                                 len(c['bspNodes'])))
        for li, lod in enumerate(sm['lods']):
            for m in lod:
                print('lod %d  %-40s prim %d fmt 0x%06x stride %d verts %5d idx %6d  %s' % (
                    li, m['name'], m['primType'], m['vertexFormat'], m['stride'], m['vertexCount'],
                    m['indexCount'], [a[0] for a in fvf_layout(m['vertexFormat'])[1]]))


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == 'validate':
        return cmd_validate(argv[2] if len(argv) > 2 else default_root())
    if cmd == 'info':
        cmd_info(argv[2])
        return 0
    if cmd == 'obj':
        lod = 0
        rh = '--rh' in argv
        if '--lod' in argv:
            lod = int(argv[argv.index('--lod') + 1])
        write_obj(argv[2], argv[3], lod=lod, rh=rh)
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
