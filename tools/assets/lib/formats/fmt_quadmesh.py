#!/usr/bin/env python3
"""fmt_quadmesh.py -- parser for the original game's QuadMesh render meshes (.qm) and their
subshader files (.rs).

Byte layout (all little-endian), reverse engineered from original_desktop_version.exe; full spec
with decomp citations in research/formats/quadmesh.md.

  file   (FUN_00659030):
    u32  version                    2 or 3 (every shipped file: 3)
    u32  reserved                   read and ignored (always 0)
    u8   lightmapped                only if version >= 3 (v2 => 1); -> QuadMesh+0x79
    u32  extraClassId               FUN_00659250: 0 = none; else a serialisable object of that
                                    class id is created and reads itself (never present)
    node root

  node   (FUN_006592c0, 0x50 bytes in memory):
    f32[6] aabb                     min.xyz, max.xyz (FUN_005b8620 reads 0x18 bytes)
    u32  childCount ; node[childCount]
    u32  patchCount ; patch[patchCount]

  patch  (FUN_00659620, 0x30 bytes in memory, "BlockCluster"):
    str  name                       u32 len + bytes (FUN_005b8430); lightmap = Lightmaps/Track<name>.tga
    u32  subCount
    sub[subCount]:  str material; u32 startIndex; u32 primCount; u32 primType
                                    (D3DPRIMITIVETYPE: 4 = triangle list, 5 = triangle strip)
    u32  vertexFormat               Refractor vertex flags: 0x1 pos f32x3, 0x40 diffuse D3DCOLOR,
                                    0x100 specular D3DCOLOR, 0x400/0x2000/0x10000/0x80000 tex0..3 f32x2
    u32  stride                     bytes per vertex
    u32  vertexCount
    u32  indexCount
    u8   vertices[vertexCount*stride]
    u16  indices[indexCount]        per-submesh ranges, list or strip (see primType)

Library:  parse(path) -> QuadMesh   (numpy arrays per patch)
          parse_rs(path) -> {name: Subshader}
CLI:      python3 -I fmt_quadmesh.py summary <file.qm> [...]
          python3 -I fmt_quadmesh.py obj <file.qm> <out.obj>
          python3 -I fmt_quadmesh.py ply <file.qm> <out.ply>
          python3 -I fmt_quadmesh.py validate <research/full>     # every .qm/.rs under the tree
"""
import os
import re
import struct
import sys
from dataclasses import dataclass, field

import numpy as np

# ---------------------------------------------------------------- vertex format ----------------
VF_POSITION = 0x1        # float3                           (Refractor vertex flag, FUN_004defe0)
VF_NORMAL = 0x10         # float3 (offset logic in FUN_00659620 @0x659a14; never set in tracks)
VF_DIFFUSE = 0x40        # D3DCOLOR (BGRA bytes)  -> VS v5
VF_SPECULAR = 0x100      # D3DCOLOR (BGRA bytes)  -> VS v6
VF_TEX = (0x400, 0x2000, 0x10000, 0x80000)   # float2 each -> VS v7..v10 (oT0..oT3)
KNOWN_FORMATS = (0x141, 0x541, 0x2541, 0x12541, 0x92541)  # the five decls built by FUN_0066a400


def format_layout(fmt):
    """Return [(name, offset, kind)] and stride for a vertex format (field order = flag order)."""
    out, off = [], 0
    if fmt & VF_POSITION:
        out.append(('position', off, 'f3')); off += 12
    if fmt & VF_NORMAL:
        out.append(('normal', off, 'f3')); off += 12
    if fmt & VF_DIFFUSE:
        out.append(('diffuse', off, 'c4')); off += 4
    if fmt & VF_SPECULAR:
        out.append(('specular', off, 'c4')); off += 4
    for i, bit in enumerate(VF_TEX):
        if fmt & bit:
            out.append((f'uv{i}', off, 'f2')); off += 8
    known = VF_POSITION | VF_NORMAL | VF_DIFFUSE | VF_SPECULAR | sum(VF_TEX)
    if fmt & ~known:
        raise ValueError(f'unknown vertex format bits 0x{fmt & ~known:x} in 0x{fmt:x}')
    return out, off


# ---------------------------------------------------------------- data classes -----------------
PT_TRIANGLELIST = 4
PT_TRIANGLESTRIP = 5


@dataclass
class SubMesh:
    material: str
    start_index: int
    prim_count: int
    prim_type: int       # D3DPRIMITIVETYPE

    @property
    def index_span(self):
        return self.prim_count * 3 if self.prim_type == PT_TRIANGLELIST else self.prim_count + 2

    def triangles(self, indices, drop_degenerate=True):
        """Triangle list [N,3] in D3D winding order (clockwise = front in the left-handed sim frame)."""
        seg = indices[self.start_index:self.start_index + self.index_span].astype(np.int64)
        if self.prim_type == PT_TRIANGLELIST:
            tris = seg.reshape(-1, 3)
        elif self.prim_type == PT_TRIANGLESTRIP:
            n = self.prim_count
            i = np.arange(n)
            a, b, c = seg[i], seg[i + 1], seg[i + 2]
            odd = (i & 1) == 1          # D3D strips: odd triangles are emitted (b, a, c)
            a2 = np.where(odd, b, a); b2 = np.where(odd, a, b)
            tris = np.stack([a2, b2, c], 1)
        else:
            raise ValueError(f'unsupported primitive type {self.prim_type}')
        if drop_degenerate and len(tris):
            keep = (tris[:, 0] != tris[:, 1]) & (tris[:, 1] != tris[:, 2]) & (tris[:, 0] != tris[:, 2])
            tris = tris[keep]
        return tris


@dataclass
class Patch:
    name: str
    subs: list
    vertex_format: int
    stride: int
    vertex_count: int
    index_count: int
    raw_vertices: bytes = field(repr=False)
    indices: np.ndarray = field(repr=False)
    attrs: dict = field(default_factory=dict, repr=False)   # name -> numpy array

    @property
    def positions(self):
        return self.attrs['position']


@dataclass
class Node:
    aabb_min: tuple
    aabb_max: tuple
    children: list
    patches: list
    depth: int = 0


@dataclass
class QuadMesh:
    path: str
    version: int
    reserved: int
    lightmapped: int
    extra_class_id: int
    root: Node
    size: int
    consumed: int

    def iter_nodes(self):
        stack = [self.root]
        while stack:
            n = stack.pop()
            yield n
            stack.extend(reversed(n.children))

    def iter_patches(self):
        for n in self.iter_nodes():
            for p in n.patches:
                yield n, p

    @property
    def leftover(self):
        return self.size - self.consumed


# ---------------------------------------------------------------- reader -----------------------
class _R:
    def __init__(self, data):
        self.d = data
        self.o = 0

    def u8(self):
        v = self.d[self.o]; self.o += 1; return v

    def u32(self):
        v = struct.unpack_from('<I', self.d, self.o)[0]; self.o += 4; return v

    def f32n(self, n):
        v = struct.unpack_from(f'<{n}f', self.d, self.o); self.o += 4 * n; return v

    def bytes(self, n):
        if self.o + n > len(self.d):
            raise EOFError(f'need {n} bytes at 0x{self.o:x}, file has {len(self.d)}')
        v = self.d[self.o:self.o + n]; self.o += n; return v

    def string(self):
        n = self.u32()
        if n > 4096:
            raise ValueError(f'implausible string length {n} at 0x{self.o - 4:x}')
        return self.bytes(n).decode('latin-1')


def _decode_vertices(raw, fmt, stride, count):
    layout, natural = format_layout(fmt)
    if natural != stride:
        raise ValueError(f'stride {stride} != layout size {natural} for format 0x{fmt:x}')
    buf = np.frombuffer(raw, dtype=np.uint8).reshape(count, stride) if count else \
        np.zeros((0, stride), np.uint8)
    attrs = {}
    for name, off, kind in layout:
        if kind == 'f3':
            attrs[name] = buf[:, off:off + 12].copy().view('<f4').reshape(count, 3)
        elif kind == 'f2':
            attrs[name] = buf[:, off:off + 8].copy().view('<f4').reshape(count, 2)
        elif kind == 'c4':
            # D3DCOLOR dword 0xAARRGGBB stored little-endian = bytes B,G,R,A. Keep as RGBA u8.
            bgra = buf[:, off:off + 4]
            attrs[name] = bgra[:, [2, 1, 0, 3]].copy()
    return attrs


def _read_patch(r):
    name = r.string()
    nsub = r.u32()
    subs = []
    for _ in range(nsub):
        mat = r.string()
        start, count, ptype = r.u32(), r.u32(), r.u32()
        subs.append(SubMesh(mat, start, count, ptype))
    fmt, stride, vc, ic = r.u32(), r.u32(), r.u32(), r.u32()
    raw = r.bytes(vc * stride)
    idx = np.frombuffer(r.bytes(ic * 2), dtype='<u2').copy()
    attrs = _decode_vertices(raw, fmt, stride, vc)
    return Patch(name, subs, fmt, stride, vc, ic, raw, idx, attrs)


def _read_node(r, depth=0):
    bb = r.f32n(6)
    nchild = r.u32()
    if nchild > 64:
        raise ValueError(f'implausible child count {nchild} at 0x{r.o - 4:x}')
    children = [_read_node(r, depth + 1) for _ in range(nchild)]
    npatch = r.u32()
    if npatch > 4096:
        raise ValueError(f'implausible patch count {npatch} at 0x{r.o - 4:x}')
    patches = [_read_patch(r) for _ in range(npatch)]
    return Node(tuple(bb[:3]), tuple(bb[3:]), children, patches, depth)


def parse(path):
    data = open(path, 'rb').read()
    r = _R(data)
    version = r.u32()
    if version not in (2, 3):
        raise ValueError(f'unsupported .qm version {version}')
    reserved = r.u32()
    lightmapped = r.u8() if version >= 3 else 1
    extra = r.u32()
    if extra != 0:
        raise NotImplementedError(f'embedded object class 0x{extra:08x} (never seen in shipped data)')
    root = _read_node(r)
    return QuadMesh(path, version, reserved, lightmapped, extra, root, len(data), r.o)


# ---------------------------------------------------------------- .rs subshaders ---------------
@dataclass
class Subshader:
    name: str
    type: str            # "Track/Mask" | "Track/Single" | "Track/Water"
    props: dict          # key -> raw value string (quotes stripped)

    def flag(self, k, default=False):
        """Engine boolean semantics [V @0x667877-0x6678c4]: bool true/false; int 0 -> false,
        1 -> true; float 0.0 -> false, 1.0 -> true; any other value keeps the default.
        (Every shipped .rs uses literal true/false.)"""
        v = self.props.get(k)
        if v is None:
            return default
        lv = v.strip().lower()
        if lv in ('true', 'false'):
            return lv == 'true'
        try:
            f = float(lv)
        except ValueError:
            return default
        return False if f == 0.0 else True if f == 1.0 else default


_RS_BLOCK = re.compile(r'subshader\s+"([^"]*)"\s+"([^"]*)"\s*\{(.*?)\}', re.S)
_RS_PROP = re.compile(r'^\s*(\w+)\s+(.*?)\s*;\s*$', re.M)


def parse_rs(path):
    text = open(path, 'rb').read().decode('latin-1')
    out = {}
    consumed = 0
    for m in _RS_BLOCK.finditer(text):
        props = {}
        for pm in _RS_PROP.finditer(m.group(3)):
            v = pm.group(2).strip()
            if v.startswith('"') and v.endswith('"'):
                v = v[1:-1]
            props[pm.group(1)] = v
        # strict: nothing but `key value;` lines inside a block (verifier addition)
        leftover = _RS_PROP.sub('', m.group(3)).strip()
        if leftover:
            raise ValueError(f'{path}: unparsed text in subshader {m.group(1)!r}: {leftover[:60]!r}')
        out[m.group(1)] = Subshader(m.group(1), m.group(2), props)
        consumed += len(m.group(0))
    # sanity: nothing but whitespace outside the blocks
    rest = _RS_BLOCK.sub('', text).strip()
    if rest:
        raise ValueError(f'{path}: unparsed text {rest[:60]!r}')
    return out


# ---------------------------------------------------------------- exports ----------------------
def all_triangles(qm):
    """Yield (patch, submesh, tri_indices[N,3] into that patch's vertices)."""
    for _, p in qm.iter_patches():
        for s in p.subs:
            yield p, s, s.triangles(p.indices)


def export_obj(qm, out):
    with open(out, 'w') as f:
        f.write(f'# {qm.path}\n# sim frame (left-handed, y up); z mirrored here for right-handed viewers\n')
        base = 1
        for _, p in qm.iter_patches():
            P = p.positions
            for v in P:
                f.write(f'v {v[0]:.4f} {v[1]:.4f} {-v[2]:.4f}\n')
            uv = p.attrs.get('uv0')
            if uv is not None:
                for t in uv:
                    f.write(f'vt {t[0]:.5f} {1 - t[1]:.5f}\n')
            for s in p.subs:
                f.write(f'g {p.name}_{s.material}\nusemtl {s.material}\n')
                for a, b, c in s.triangles(p.indices) + base:
                    # mirror z flips winding; swap b/c to keep faces front-facing
                    if uv is not None:
                        f.write(f'f {a}/{a} {c}/{c} {b}/{b}\n')
                    else:
                        f.write(f'f {a} {c} {b}\n')
            base += len(P)


def export_ply(qm, out):
    verts, cols, faces = [], [], []
    base = 0
    for _, p in qm.iter_patches():
        verts.append(p.positions)
        d = p.attrs.get('diffuse')
        cols.append(d[:, :3] if d is not None else np.full((p.vertex_count, 3), 200, np.uint8))
        for s in p.subs:
            faces.append(s.triangles(p.indices) + base)
        base += p.vertex_count
    V = np.concatenate(verts); C = np.concatenate(cols); F = np.concatenate(faces)
    with open(out, 'wb') as f:
        f.write((f'ply\nformat binary_little_endian 1.0\nelement vertex {len(V)}\n'
                 'property float x\nproperty float y\nproperty float z\n'
                 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
                 f'element face {len(F)}\nproperty list uchar int vertex_indices\nend_header\n').encode())
        vd = np.zeros(len(V), dtype=[('x', '<f4'), ('y', '<f4'), ('z', '<f4'),
                                     ('r', 'u1'), ('g', 'u1'), ('b', 'u1')])
        vd['x'], vd['y'], vd['z'] = V[:, 0], V[:, 1], -V[:, 2]
        vd['r'], vd['g'], vd['b'] = C[:, 0], C[:, 1], C[:, 2]
        f.write(vd.tobytes())
        fd = np.zeros(len(F), dtype=[('n', 'u1'), ('a', '<i4'), ('b', '<i4'), ('c', '<i4')])
        fd['n'] = 3; fd['a'], fd['b'], fd['c'] = F[:, 0], F[:, 2], F[:, 1]
        f.write(fd.tobytes())


# ---------------------------------------------------------------- CLI ------------------------
def summary(path):
    qm = parse(path)
    nodes = list(qm.iter_nodes())
    patches = [p for _, p in qm.iter_patches()]
    fmts = {}
    for p in patches:
        fmts[p.vertex_format] = fmts.get(p.vertex_format, 0) + 1
    mats = sorted({s.material for p in patches for s in p.subs})
    nv = sum(p.vertex_count for p in patches)
    ntri = sum(len(s.triangles(p.indices)) for p in patches for s in p.subs)
    print(f'{path}: v{qm.version} lightmapped={qm.lightmapped} nodes={len(nodes)} '
          f'maxDepth={max(n.depth for n in nodes)} patches={len(patches)} verts={nv} tris={ntri} '
          f'formats={{{", ".join(f"0x{k:x}:{v}" for k, v in sorted(fmts.items()))}}} '
          f'materials={len(mats)} leftover={qm.leftover}')
    print(f'  root aabb {qm.root.aabb_min} .. {qm.root.aabb_max}')
    return qm


def main(argv):
    if len(argv) < 3:
        print(__doc__); return 1
    cmd = argv[1]
    if cmd == 'summary':
        for p in argv[2:]:
            summary(p)
    elif cmd == 'obj':
        export_obj(parse(argv[2]), argv[3])
    elif cmd == 'ply':
        export_ply(parse(argv[2]), argv[3])
    elif cmd == 'validate':
        root = argv[2]
        ok = bad = 0
        for dp, _, fns in sorted(os.walk(root)):
            for fn in sorted(fns):
                full = os.path.join(dp, fn)
                if fn.lower().endswith('.qm'):
                    try:
                        qm = parse(full)
                        if qm.leftover:
                            raise ValueError(f'{qm.leftover} leftover bytes')
                        ok += 1
                    except Exception as e:  # noqa: BLE001
                        bad += 1
                        print('FAIL', full, e)
        print(f'qm parsed OK: {ok}, failed: {bad}')
    else:
        print(__doc__); return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
