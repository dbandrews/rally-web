#!/usr/bin/env python3
"""fmt_objects.py - placed track objects + object/geometry templates of the original game.

Spec: research/formats/objects.md.  Formats handled here:
  Objects.con          per-track placement script (Object.create + Object.geometry.scale/color/shadowFactor)
  MergeObjects.dat     binary cache of the non-merged placements ("Ver 0.7", + bounding-sphere tree)
                       reader 0x6fcf70 / writer 0x6fcb80 (record I/O FUN_006fcd60 / FUN_006fc9e0)
  MergeMesh.dat        merged vegetation batches (TreeMesh mergeable/sideScreen templates), version 4
                       loader entry FUN_004067c0 (layout empirical, see spec)
  object library .con  ObjectTemplate.* / GeometryTemplate.* script language (object/objectTemplatesAlwaysLoad,
                       object/objectTemplates and everything they `run`)
  Start.con, Cameras.con, Trace.con, TraceObjects.con, Files.idx   (small text formats)

World frame: the frame of Objects.con / MergeObjects.dat / MergeMesh.dat ("object world") is the SIM frame
shifted by (2048, H, 2048), H = 3rd argument of Game.createTrack in Start.con:  sim = world - (2048, H, 2048).
Rotation "a/b/c" (degrees) -> row-vector matrix R = Rz(c) . Rx(b) . Ry(a)   (a = yaw about +y, b = pitch about +x,
c = roll about +z; Ry(a) maps +z to (sin a, 0, cos a)).  World matrix = diag(scale) . R, translation = position.

Library:
  vfs = Vfs()                                  case-insensitive union of every archive under research/full
  lib = load_library(vfs)                      -> Library (templates, geometry templates, opened files)
  objs = parse_objects_con(path)               -> list[Placement]
  mo = parse_merge_objects(path)               -> dict (exact, consumes to EOF)
  mm = parse_merge_mesh(path)                  -> dict (exact, consumes to EOF)
  track = load_track(vfs, lib, track_dir)      -> resolved flattened instance list
CLI (research/.venv/bin/python -I research/tools/fmt_objects.py ...):
  validate                 parse every track + library, cross-check .dat vs .con, missing refs, ground heights
  dump [outdir]            JSON per track (default research/formats/objects_dump)
  scatter [outdir]         top-down PNG per family (default artifacts/re/objects)
  info <track_dir>         summary of one track
  mergemesh [archive]      PNG of the decoded MergeMesh.dat geometry (artifacts/re/objects/mergemesh_<a>.png)
"""
import glob
import json
import math
import os
import re
import struct
import sys
from collections import Counter, OrderedDict, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # rally-web: data roots from _paths.py
from _paths import REPO, FULL, DUMPS  # noqa: E402
WORLD_XZ_OFFSET = 2048.0  # world = sim + (2048, H, 2048), H from Game.createTrack (empirical + TrackFull.gcm check)


# ============================================================================================ VFS
class Vfs:
    """Union of the extracted archives (research/full/<archive>/...) keyed by lower-case virtual path.
    The game mounts every .rff at the same virtual root; paths in scripts are case-insensitive."""

    def __init__(self, root=FULL):
        self.root = root
        self.index = {}
        self.dirs = defaultdict(list)
        for arch in sorted(os.listdir(root)):
            ad = os.path.join(root, arch)
            if not os.path.isdir(ad):
                continue
            for dp, dn, fn in os.walk(ad):
                for f in fn:
                    real = os.path.join(dp, f)
                    v = os.path.relpath(real, ad).replace(os.sep, '/').lower()
                    self.index.setdefault(v, real)
                    self.dirs[os.path.dirname(v)].append(v)

    def norm(self, p):
        p = p.replace('\\', '/').strip().lower()
        while p.startswith('./'):
            p = p[2:]
        p = re.sub(r'/+', '/', p)
        return p.lstrip('/')

    def find(self, p, exts=('',)):
        n = self.norm(p)
        for e in exts:
            r = self.index.get(n + e)
            if r:
                return r
        return None

    def exists(self, p, exts=('',)):
        return self.find(p, exts) is not None


# ============================================================================================ helpers
def vec3(s, default=None):
    """'x/y/z' -> [x, y, z] (FUN_004692b0 float reads separated by FUN_0046aec0). Fewer comps -> repeat last."""
    if s is None:
        return default
    parts = [p for p in s.split('/') if p != '']
    try:
        v = [float(p) for p in parts]
    except ValueError:
        return default
    if not v:
        return default
    while len(v) < 3:
        v.append(v[-1])
    return v[:3]


def rot_matrix(yaw, pitch, roll):
    """Row-vector rotation R = Rz(roll) . Rx(pitch) . Ry(yaw), degrees (verified to 3e-7 vs MergeObjects.dat)."""
    a, b, c = (math.radians(x) for x in (yaw, pitch, roll))
    ca, sa, cb, sb, cc, sc = math.cos(a), math.sin(a), math.cos(b), math.sin(b), math.cos(c), math.sin(c)
    Ry = [[ca, 0, -sa], [0, 1, 0], [sa, 0, ca]]
    Rx = [[1, 0, 0], [0, cb, sb], [0, -sb, cb]]
    Rz = [[cc, sc, 0], [-sc, cc, 0], [0, 0, 1]]

    def mm(A, B):
        return [[sum(A[i][k] * B[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    return mm(mm(Rz, Rx), Ry)


def matrix_to_euler(R):
    """Inverse of rot_matrix for an orthonormal row-vector matrix -> (yaw, pitch, roll) degrees."""
    fx, fy, fz = R[2]
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, -fy))))
    yaw = math.degrees(math.atan2(fx, fz))
    # right vector row0 = (cc*ca + sc*sb*sa, sc*cb, ...): roll = atan2(R[0][1], R[1][1])
    roll = math.degrees(math.atan2(R[0][1], R[1][1]))
    return yaw, pitch, roll


# ============================================================================================ .con interpreter
class GeomTemplate:
    __slots__ = ('name', 'type', 'file', 'props', 'lods', 'src', 'overrides')

    def __init__(self, typ, name, src):
        self.type, self.name, self.src = typ, name, src
        self.file = None
        self.props = OrderedDict()
        self.lods = {}
        self.overrides = OrderedDict()   # per-track lighting.con / level/swing.con values (load_track)


class ObjTemplate:
    __slots__ = ('name', 'type', 'geometry', 'children', 'props', 'multi', 'src', 'sound', 'skeleton')

    def __init__(self, typ, name, src):
        self.type, self.name, self.src = typ, name, src
        self.geometry = None
        self.children = []          # [{'name', 'pos', 'rot'}]  (addTemplate / setPosition / setRotation)
        self.props = OrderedDict()  # last value wins
        self.multi = defaultdict(list)  # repeated commands (setMaterialTexture, setAnimationState, ...)
        self.sound = None
        self.skeleton = None


MULTI_CMDS = {'setmaterialtexture', 'setanimationstate', 'addemitterspeed', 'setflarecolor', 'setflaretexture',
              'setflaresize', 'setflarerot', 'setcamposition', 'colorrgbaovertime', 'intensityovertime'}


class Library:
    def __init__(self):
        self.geoms = OrderedDict()      # lower name -> GeomTemplate
        self.tpls = OrderedDict()       # lower name -> ObjTemplate
        self.opened = []                # virtual paths of every script run, in order
        self.missing_runs = []
        self.unknown = Counter()        # other namespaces (kept as counts)
        self.consts = {}
        self.anim_states = OrderedDict()   # AnimationStateMachine states -> list of (baf, speed, loop)
        self.cmd_counts = Counter()


class ConInterp:
    """Minimal Refractor2 console-script runner for the object library and per-track .con files.
    Control flow: rem, beginRem/endRem, if/else/endif (nested), const, var, run <file> [args] (default .con)."""

    def __init__(self, vfs, lib, defines=None):
        self.vfs, self.lib = vfs, lib
        self.cur_geom = None
        self.cur_tpl = None
        self.last_child = None
        self.cur_state = None
        self.defines = {'c_win32': 1}
        if defines:
            self.defines.update(defines)
        self.track_overrides = None   # dict when running per-track scripts (lighting.con)

    def eval_cond(self, toks, args):
        def val(t):
            tl = t.lower()
            if re.fullmatch(r'-?\d+(\.\d+)?', t):
                return float(t)
            if tl == 'v_noarg':
                return float(len(args))
            if tl in self.lib.consts:
                try:
                    return float(self.lib.consts[tl])
                except ValueError:
                    return 1.0
            return float(self.defines.get(tl, 0))
        if len(toks) == 1:
            return val(toks[0]) != 0
        if len(toks) >= 3:
            a, op, b = val(toks[0]), toks[1], val(toks[2])
            return {'>': a > b, '<': a < b, '=': a == b, '==': a == b, '>=': a >= b, '<=': a <= b,
                    '!=': a != b}.get(op, False)
        return False

    def run(self, vpath, args=(), depth=0):
        real = self.vfs.find(vpath, ('', '.con'))
        if real is None:
            self.lib.missing_runs.append(vpath)
            return False
        vn = self.vfs.norm(vpath)
        if not vn.endswith('.con') and self.vfs.find(vpath) is None:
            vn += '.con'
        self.lib.opened.append(vn)
        text = open(real, 'rb').read().decode('latin-1')
        stack = []      # list of (active, taken)
        in_rem = False
        for raw in text.splitlines():
            line = raw.strip()
            if not line:
                continue
            toks = line.split()
            c = toks[0].lower()
            if c == 'beginrem':
                in_rem = True
                continue
            if c == 'endrem':
                in_rem = False
                continue
            if in_rem or c == 'rem' or c.startswith('//'):
                continue
            active = all(s[0] for s in stack)
            if c == 'if':
                r = self.eval_cond(toks[1:], args) if active else False
                stack.append([r, r])
                continue
            if c == 'else':
                if stack:
                    parent = all(s[0] for s in stack[:-1])
                    stack[-1][0] = parent and not stack[-1][1]
                continue
            if c == 'endif':
                if stack:
                    stack.pop()
                continue
            if not active:
                continue
            self.exec(toks, args, depth, vn)
        return True

    def exec(self, toks, args, depth, src):
        c = toks[0]
        cl = c.lower()
        a = toks[1:]
        # argument substitution v_arg1.. (keymaps only; harmless here)
        lib = self.lib
        lib.cmd_counts[cl] += 1
        if cl == 'run':
            if a:
                self.run(a[0], a[1:], depth + 1)
            return
        if cl == 'const':
            m = re.match(r'const\s+(\S+)\s*=\s*(\S+)', ' '.join(toks), re.I)
            if m:
                lib.consts[m.group(1).lower()] = m.group(2)
            return
        if cl == 'var':
            return
        ns, _, cmd = cl.partition('.')
        if ns == 'geometrytemplate':
            self.geom_cmd(cmd, c.partition('.')[2], a, src)
        elif ns == 'objecttemplate':
            self.tpl_cmd(cmd, c.partition('.')[2], a, src)
        elif ns == 'animationstatemachine':
            if cmd == 'createstate' and a:
                self.cur_state = a[0]
                lib.anim_states[a[0].lower()] = {'name': a[0], 'anims': [], 'props': {}}
            elif cmd == 'addanimation' and a and self.cur_state:
                lib.anim_states[self.cur_state.lower()]['anims'].append(a)
            elif self.cur_state:
                lib.anim_states[self.cur_state.lower()]['props'][cmd] = a
        else:
            lib.unknown[cl] += 1

    def geom_cmd(self, cmd, orig, a, src):
        lib = self.lib
        if cmd == 'create' and len(a) >= 2:
            g = GeomTemplate(a[0], a[1], src)
            lib.geoms[a[1].lower()] = g
            self.cur_geom = g
            return
        if cmd == 'active':
            self.cur_geom = lib.geoms.get(a[0].lower()) if a else None
            if self.cur_geom is None and a:
                lib.unknown['geometrytemplate.active:missing'] += 1
            return
        g = self.cur_geom
        if g is None:
            return
        if self.track_overrides is not None:
            g.overrides[cmd] = a
            return
        if cmd == 'file' and a:
            g.file = a[0]
        elif cmd == 'setloddistance' and len(a) >= 2:
            g.lods[int(float(a[0]))] = float(a[1])
        else:
            g.props[cmd] = a

    def tpl_cmd(self, cmd, orig, a, src):
        lib = self.lib
        if cmd == 'create' and len(a) >= 2:
            t = ObjTemplate(a[0], a[1], src)
            lib.tpls[a[1].lower()] = t
            self.cur_tpl = t
            self.last_child = None
            return
        if cmd == 'active':
            self.cur_tpl = lib.tpls.get(a[0].lower()) if a else None
            return
        t = self.cur_tpl
        if t is None:
            return
        if cmd in ('geometry', 'setgeometry') and a:
            t.geometry = a[0]
            t.props[cmd] = a
        elif cmd == 'addtemplate' and a:
            t.children.append({'name': a[0], 'pos': [0.0, 0.0, 0.0], 'rot': [0.0, 0.0, 0.0]})
            self.last_child = len(t.children) - 1
        elif cmd in ('setposition', 'setrotation') and a:
            idx = int(float(a[1])) if len(a) > 1 else self.last_child   # FUN_00702970: 2nd arg = child index
            if idx is not None and 0 <= idx < len(t.children):
                t.children[idx]['pos' if cmd == 'setposition' else 'rot'] = vec3(a[0], [0.0, 0.0, 0.0])
        elif cmd == 'loadsoundscript' and a:
            t.sound = a[0]
            t.props[cmd] = a
        elif cmd == 'createskeleton' and a:
            t.skeleton = a[0]
            t.props[cmd] = a
        elif cmd in MULTI_CMDS:
            t.multi[cmd].append(a)
        else:
            t.props[cmd] = a


LIBRARY_ROOTS = ('object/objectTemplatesAlwaysLoad', 'object/objectTemplates')   # FUN_00494c00 @0x49510d/0x4953e1


def load_library(vfs):
    lib = Library()
    it = ConInterp(vfs, lib)
    for r in LIBRARY_ROOTS:
        it.run(r)
    return lib


# ============================================================================================ Objects.con
class Placement:
    __slots__ = ('template', 'pos', 'rot', 'scale', 'color', 'shadow', 'line', 'nargs')

    def __init__(self, template, pos, rot, line, nargs):
        self.template, self.pos, self.rot, self.line, self.nargs = template, pos, rot, line, nargs
        self.scale = None
        self.color = None
        self.shadow = None


def parse_objects_con(path):
    """Objects.con: only 4 commands occur in the shipped files (census over all 48):
       Object.create <tpl> [x/y/z [yaw/pitch/roll]]   (FUN_006e87b0 parse, FUN_006e8a70 -> FUN_006f8e40)
       Object.geometry.scale x/y/z                     (FUN_00570210 / FUN_00570370 -> scale component +0xc)
       Object.geometry.color r/g/b                     (FUN_0056d690 / FUN_0056d7f0 -> colour component +0x2c)
       Object.geometry.shadowFactor f                  (FUN_0056da60 / FUN_0056db70 -> colour component +0x34)
    The geometry.* lines apply to the most recently created object."""
    out = []
    other = Counter()
    cur = None
    with open(path, 'rb') as f:
        for ln, raw in enumerate(f.read().decode('latin-1').splitlines(), 1):
            t = raw.split()
            if not t:
                continue
            c = t[0].lower()
            if c == 'object.create':
                pos = vec3(t[2], [0.0, 0.0, 0.0]) if len(t) > 2 else [0.0, 0.0, 0.0]
                rot = vec3(t[3], [0.0, 0.0, 0.0]) if len(t) > 3 else [0.0, 0.0, 0.0]
                cur = Placement(t[1] if len(t) > 1 else '', pos, rot, ln, len(t) - 1)
                out.append(cur)
            elif c == 'object.geometry.scale' and cur is not None:
                cur.scale = vec3(t[1])
            elif c == 'object.geometry.color' and cur is not None:
                cur.color = vec3(t[1])
            elif c == 'object.geometry.shadowfactor' and cur is not None:
                cur.shadow = float(t[1])
            elif c == 'rem':
                continue
            else:
                other[t[0]] += 1
    return out, other


# ============================================================================================ MergeObjects.dat
class Rd:
    def __init__(self, b):
        self.b, self.o = b, 0

    def u32(self):
        v = struct.unpack_from('<I', self.b, self.o)[0]
        self.o += 4
        return v

    def i32(self):
        v = struct.unpack_from('<i', self.b, self.o)[0]
        self.o += 4
        return v

    def f(self, n=1):
        v = struct.unpack_from('<%df' % n, self.b, self.o)
        self.o += 4 * n
        return v if n > 1 else v[0]

    def u16s(self, n):
        v = struct.unpack_from('<%dH' % n, self.b, self.o)
        self.o += 2 * n
        return v

    def u8(self):
        v = self.b[self.o]
        self.o += 1
        return v

    def string(self):          # FUN_005b8430 / FUN_005b83f0: u32 length + bytes, no terminator
        n = self.u32()
        v = self.b[self.o:self.o + n].decode('latin-1')
        self.o += n
        return v

    def raw(self, n):
        v = self.b[self.o:self.o + n]
        self.o += n
        return v


MO_VERSION = 'Ver 0.7'          # static std::string @0x93754c initialised from 0x85b464 (FUN_006fc750)
MO_END = 'END OF FILE'          # static std::string @0x93753c from 0x85b46c (FUN_006fc8a0)


def parse_merge_objects(path):
    """Reader 0x6fcf70 (Ghidra-unrecovered, decompiled at 0x6fcf70) / writer 0x6fcb80."""
    b = open(path, 'rb').read()
    r = Rd(b)
    mo = {'size': len(b)}
    mo['version'] = r.string()
    if mo['version'] != MO_VERSION:
        raise ValueError('MergeObjects version %r' % mo['version'])
    mo['count'] = r.u32()
    groups = []
    objs = []
    while True:
        name = r.string()
        if name == MO_END:
            break
        n = r.u32()
        g = {'template': name, 'count': n, 'first': len(objs)}
        for _ in range(n):
            idx = r.u32()                       # object's index in the object list (tree leaves refer to it)
            m = r.f(16)                         # 4x4 world matrix, row-vector, rows 0-2 unit basis, row 3 = pos
            scale = r.f(3)                      # scale component (0xebc881fa) +0xc
            color = r.f(3)                      # colour component (0xa5c048fc) +0x2c
            shadow = r.f(1)                     # shadowFactor (+0x34)
            objs.append({'template': name, 'index': idx, 'matrix': m, 'scale': scale, 'color': color,
                         'shadow': shadow})
        groups.append(g)
    mo['groups'] = groups
    mo['objects'] = objs
    # bounding-sphere binary tree (FUN_006fcb00 writer / FUN_006fce50 reader): pre-order,
    # node = i32 objectIndex (-1 = interior, then 2 children follow), f32[3] centre, f32 radius
    nodes = []

    def node(depth):
        idx = r.i32()
        c = r.f(3)
        rad = r.f(1)
        nodes.append((idx, c, rad, depth))
        if idx < 0:
            node(depth + 1)
            node(depth + 1)
    node(0)
    mo['tree'] = nodes
    mo['leftover'] = len(b) - r.o
    return mo


# ============================================================================================ MergeMesh.dat
MM_VERSION = 4


def _mm_grid(r):
    g = {}
    g['bmin'] = r.f(3)
    g['bmax'] = r.f(3)
    g['nx'] = r.u32()
    g['nz'] = r.u32()
    g['cell'] = r.f(2)
    n = r.u32()
    g['ncells'] = n
    # verifier: when the instance list is empty the header (bmin/bmax/nx/nz/cell) is uninitialised memory
    # (e.g. kenya3f nx=0x74736564 "dest") and ncells = 0 != nx*nz -> never size anything from nx*nz.
    g['empty'] = n == 0
    g['cells'] = r.u16s(n)              # 0xffff = empty, else offset into lists; cell index = iz*nx + ix
    nl = r.u32()
    g['lists'] = r.u16s(nl)             # instance indices, each cell list terminated by 0xffff
    return g


def parse_merge_mesh(path, keep_geometry=False):
    b = open(path, 'rb').read()
    r = Rd(b)
    mm = {'size': len(b)}
    mm['version'] = r.u32()
    if mm['version'] != MM_VERSION:
        raise ValueError('MergeMesh version %d' % mm['version'])
    nt = r.u32()
    tpls = []
    for _ in range(nt):
        t = {}
        sway = r.raw(40)                     # raw sway-parameter struct (see spec)
        t['swayPhase'] = struct.unpack_from('<f', sway, 0)[0]
        (t['swayRangeDegrees'], t['swayPeriodSeconds'], t['swayWindFactor'], dx, dz,
         t['swayForcePeriodSeconds'], t['swayForceA'], t['swayForceB']) = struct.unpack_from('<8f', sway, 4)
        t['swayDirection'] = (dx, dz)
        # verifier [V FUN_00592290 ctor defaults +0x2c=10.0 / +0x30=2.5; setters 0x592620 (+0x2c) / 0x592650 (+0x30)
        # reached from swayForceRangeDegrees / swayForceLengthSeconds]: A = RangeDegrees, B = LengthSeconds
        t['swayForceRangeDegrees'] = t['swayForceA']
        t['swayForceLengthSeconds'] = t['swayForceB']
        t['swayFlags'] = list(sway[36:40])   # byte 39 = swayEnable [E]
        t['name'] = r.string()
        t['texture'] = r.string()
        t['sortDirections'] = r.u32()        # 8 in every file (= TreeMesh sortDirections)
        t['indexStart'] = r.u32()            # into the shared u16 index buffer
        t['triCount'] = r.u32()              # triangles per sort direction
        t['bmin'] = r.f(3)
        t['bmax'] = r.f(3)
        t['sideScreen'] = r.u8()             # 1 = GeometryTemplate.sideScreen ("Kuliss" backdrop) batch
        tpls.append(t)
    mm['templates'] = tpls

    def inst_block():
        n = r.u32()
        lst = []
        for _ in range(n):
            m = r.f(16)                      # world matrix incl. scale (rows scaled), row 3 = position
            c = r.f(3)                       # world-space bounding-sphere centre
            col = r.raw(4)                   # baked vertex colour, D3DCOLOR bytes B,G,R,A
            rad = r.f(1)                     # world bounding-sphere radius
            ti = r.u32()                     # template index
            lst.append({'matrix': m, 'center': c, 'bgra': tuple(col), 'radius': rad, 'template': ti})
        return lst
    mm['instances'] = inst_block()           # normal merged (grass/bushes/baby trees)
    mm['sideScreens'] = inst_block()         # sideScreen batches
    nv = r.u32()
    mm['vertexCount'] = nv
    vb = r.raw(nv * 20)                      # pos.xyz + uv (template-local)
    ni = r.u32()
    mm['indexCount'] = ni
    ib = r.raw(ni * 2)
    if keep_geometry:
        mm['vertices'] = struct.unpack('<%df' % (5 * nv), vb)
        mm['indices'] = struct.unpack('<%dH' % ni, ib)
    mm['grid'] = _mm_grid(r)                 # cell lists over mm['instances']
    mm['gridSideScreen'] = _mm_grid(r)       # cell lists over mm['sideScreens']
    mm['leftover'] = len(b) - r.o
    return mm


# ============================================================================================ small text files
def parse_start_con(path):
    """Start.con: Game.createTrack <Name> <Forward|Reverse> <H> (FUN_00428710 -> FUN_00494c00 track loader),
    Object.initGrid minXZ maxXZ n y/y/y (editor-only: not registered in the release exe),
    Game.cameraPosition x/y/z (FUN_00417ba0 registration, handler 0x417ec0)."""
    out = {'createTrack': None, 'initGrid': None, 'cameraPosition': None, 'other': []}
    for raw in open(path, 'rb').read().decode('latin-1').splitlines():
        t = raw.split()
        if not t or t[0].lower() == 'rem':
            continue
        c = t[0].lower()
        if c == 'game.createtrack':
            out['createTrack'] = {'name': t[1], 'direction': t[2], 'height': float(t[3])}
        elif c == 'object.initgrid':
            out['initGrid'] = {'min': vec3(t[1]), 'max': vec3(t[2]), 'n': float(t[3]), 'y': vec3(t[4])}
        elif c == 'game.cameraposition':
            out['cameraPosition'] = vec3(t[1])
        else:
            out['other'].append(t)
    return out


def parse_cameras_con(path):
    """Cameras.con: race.ReplayCameraSystemMode 1 ... 0 brackets race.addReplayCamera lines (FUN_004436e0,
    parse 0x4438c0, exec 0x443c50):  addReplayCamera <type> <fov> <splineDist> <range> pos rot target."""
    cams = []
    other = []
    for raw in open(path, 'rb').read().decode('latin-1').splitlines():
        t = raw.split()
        if not t or t[0].lower() == 'rem':
            continue
        if t[0].lower() == 'race.addreplaycamera':
            cams.append({'type': int(float(t[1])), 'fov': float(t[2]), 'splineDistance': float(t[3]),
                         'range': float(t[4]), 'pos': vec3(t[5]), 'rot': vec3(t[6]), 'target': vec3(t[7])})
        else:
            other.append(t)
    return {'cameras': cams, 'other': other}


def parse_cmd_list(path):
    out = []
    for raw in open(path, 'rb').read().decode('latin-1').splitlines():
        t = raw.split()
        if t and t[0].lower() != 'rem':
            out.append(t)
    return out


def parse_files_idx(path):
    return [l.strip() for l in open(path, 'rb').read().decode('latin-1').splitlines() if l.strip()]


# ============================================================================================ resolution
KIND_COLORS = OrderedDict([
    ('sidescreen', (40, 110, 40)), ('tree3d', (30, 170, 60)), ('billboardTree', (120, 200, 60)),
    ('mergeVeg', (180, 230, 120)), ('rock', (140, 120, 100)), ('static', (90, 90, 230)),
    ('physics', (240, 140, 0)), ('spectator', (230, 40, 40)), ('animal', (200, 60, 200)),
    ('sound', (0, 200, 220)), ('fx', (255, 255, 0)), ('other', (128, 128, 128)), ('missing', (255, 0, 255)),
])


def mesh_files(vfs, gt):
    """GeometryTemplate.file -> files. StandardMesh/AnimatedMesh: <file>.sm + <file>.rs (FUN_0058bc10 adds the
    extension); TreeMesh: <file>.tm (FUN_0057ad00); 'Type:path' inline geometry references likewise."""
    if gt is None or not gt.file:
        return []
    typ = gt.type.lower()
    exts = {'standardmesh': ('.sm', '.rs'), 'animatedmesh': ('.sm', '.rs'), 'treemesh': ('.tm',),
            'mayamesh': ('.sm',), 'mrmmesh': ('.mrm',)}.get(typ, ('.sm',))
    out = []
    for e in exts:
        out.append({'path': vfs.norm(gt.file) + e, 'exists': vfs.exists(gt.file, (e,))})
    return out


def resolve_geometry(lib, ref):
    """ObjectTemplate.geometry <name> -> GeometryTemplate by name; '<Type>:<file>' creates an inline geometry."""
    if ref is None:
        return None
    if ':' in ref:
        typ, _, f = ref.partition(':')
        g = GeomTemplate(typ, ref, 'inline')
        g.file = f
        return g
    return lib.geoms.get(ref.lower())


_FSM = None


def _fsm():
    global _FSM
    if _FSM is None:
        sys.path.insert(0, HERE)
        import fmt_standardmesh
        _FSM = fmt_standardmesh
    return _FSM


ANIMAL_RE = re.compile(r'cow|sheep|zebra|bird|afrsheep', re.I)
ROCK_RE = re.compile(r'stone|rock|boulder', re.I)


def classify(lib, tpl, gt):
    if tpl is None:
        return 'missing'
    tt = tpl.type.lower()
    if tt == 'animatedobject':
        return 'animal' if ANIMAL_RE.search(tpl.name) or (gt is not None and ANIMAL_RE.search(gt.name)) \
            else 'spectator'
    if tt in ('worldenvironmentsound', 'worldobjectcollisionsound', 'listener'):
        return 'sound'
    if tt in ('emitter', 'spriteparticle', 'effectbundle', 'lensflare', 'carfx'):
        return 'fx'
    if tt == 'phyobject':
        return 'physics'
    if gt is not None and gt.type.lower() == 'treemesh':
        p = gt.props
        if 'sidescreen' in p and p['sidescreen'] and p['sidescreen'][0] != '0':
            return 'sidescreen'
        if 'billboard' in p and p['billboard'] and p['billboard'][0] != '0':
            return 'billboardTree'
        if 'mergeable' in p and p['mergeable'] and p['mergeable'][0] != '0':
            return 'mergeVeg'
        return 'tree3d'
    if gt is not None and ROCK_RE.search(gt.name + ' ' + (gt.file or '')):
        return 'rock'
    if gt is not None:
        return 'static'
    return 'other'


def flag(props, key):
    v = props.get(key)
    return bool(v) and v[0] not in ('0', '0.0')


class Resolver:
    def __init__(self, vfs, lib):
        self.vfs, self.lib = vfs, lib
        self.cache = {}
        self.mesh_info = {}

    def mesh_collision(self, path):
        """Does the mesh file carry an embedded CollisionMesh (.sm collisionSize>0 / .tm class != 0)?"""
        if path in self.mesh_info:
            return self.mesh_info[path]
        res = None
        real = self.vfs.find(path)
        if real:
            try:
                b = open(real, 'rb').read(8 + 24 + 4 + 4)
                if path.endswith('.sm') and len(b) >= 36:
                    ver = struct.unpack_from('<I', b, 0)[0]
                    csz = struct.unpack_from('<I', b, 32)[0]
                    res = {'version': ver, 'collision': csz > 0,
                           'bbox': struct.unpack_from('<6f', b, 8)}
                elif path.endswith('.tm'):
                    res = {'collision': None}
            except OSError:
                res = None
        self.mesh_info[path] = res
        return res

    def texture(self, name, track_vdir=None):
        """'texture/X' -> (virtual path found, where). Lookup order (Files.idx evidence: the TreeMesh texture
        'texture/CO_KulissTrees2_JH' was opened as Track/Corsica1/Forward/Texture/CO_KulissTrees2_JH.DDS):
        track Texture dir first, then the global texture/ dir; extension .dds then .tga."""
        n = self.vfs.norm(name)
        if n.endswith('.dds') or n.endswith('.tga'):
            n = n[:-4]
        base = n[len('texture/'):] if n.startswith('texture/') else n
        cands = []
        if track_vdir:
            cands.append((track_vdir + '/texture/' + base, 'track'))
        cands.append(('texture/' + base, 'global'))
        for c, where in cands:
            for e in ('.dds', '.tga'):
                if c + e in self.vfs.index:
                    return c + e, where
        return None, None

    def mesh_textures(self, files):
        """Texture names referenced by a mesh: .rs 'texture' properties, .tm group textures."""
        out = []
        for f in files:
            real = self.vfs.find(f['path'])
            if not real:
                continue
            key = ('tex', f['path'])
            if key in self.mesh_info:
                out += self.mesh_info[key]
                continue
            names = []
            try:
                if f['path'].endswith('.rs'):
                    for blk in _fsm().parse_rs(real):
                        for k, v in blk['props']:
                            if k.lower() in ('texture', 'detailtexture', 'bumpmap', 'envmap') and v:
                                names.append(v[0])
                elif f['path'].endswith('.tm'):
                    tm = _fsm().parse_tm(real, keep_data=False)
                    for g in tm['groups']:
                        for it in g:
                            names.append(it['texture'])
                    self.mesh_info[('tmcoll', f['path'])] = tm['collisionClass'] != 0
                    self.mesh_info[('bbox', f['path'])] = tm['bbox']
            except Exception as e:  # pragma: no cover
                names.append('!parse-error:%s' % e)
            names = list(OrderedDict.fromkeys(names))
            self.mesh_info[key] = names
            out += names
        return list(OrderedDict.fromkeys(out))

    def template(self, name, depth=0, track_billboards=None):
        key = (name.lower(), track_billboards is not None)
        if key in self.cache:
            return self.cache[key]
        lib, vfs = self.lib, self.vfs
        tpl = lib.tpls.get(name.lower())
        info = OrderedDict()
        info['template'] = name
        if tpl is None:
            info['kind'] = 'missing'
            info['missing'] = ['template:' + name]
            self.cache[key] = info
            return info
        gt = resolve_geometry(lib, tpl.geometry)
        info['type'] = tpl.type
        info['src'] = tpl.src
        info['kind'] = classify(lib, tpl, gt)
        missing = []
        if tpl.geometry:
            info['geometry'] = gt.name if gt is not None else tpl.geometry
            if gt is None:
                missing.append('geometry:' + tpl.geometry)
            else:
                info['geometryType'] = gt.type
                files = mesh_files(vfs, gt)
                info['meshFiles'] = files
                for f in files:
                    if not f['exists']:
                        missing.append('mesh:' + f['path'])
                if gt.lods:
                    info['lodDistances'] = [gt.lods[k] for k in sorted(gt.lods)]
                gp = gt.props
                for k in ('billboard', 'billboarddistance', 'billboardresolution', 'sidescreen', 'mergeable',
                          'lighting', 'depthwrite', 'swayenable', 'collisionswayenable', 'bushswayenable'):
                    if k in gp:
                        info[k] = gp[k][0] if len(gp[k]) == 1 else gp[k]
                if flag(gp, 'billboard'):
                    info['billboardTexture'] = 'Billboards/%s.dds' % gt.name     # per track (createBillboards)
                if 'setskin' in gp:
                    info['skin'] = gp['setskin'][0]
                    if not vfs.exists(gp['setskin'][0]):
                        missing.append('skin:' + gp['setskin'][0])
                if info['meshFiles'] and info['meshFiles'][0]['path'].endswith('.sm'):
                    mi = self.mesh_collision(info['meshFiles'][0]['path'])
                    if mi:
                        info['meshHasCollision'] = mi['collision']
                info['textures'] = self.mesh_textures(info['meshFiles'])
                f0 = info['meshFiles'][0]['path'] if info['meshFiles'] else None
                if f0 and f0.endswith('.tm'):
                    info['meshHasCollision'] = self.mesh_info.get(('tmcoll', f0))
                    bb = self.mesh_info.get(('bbox', f0))
                    if bb:
                        info['meshBBox'] = [list(bb['min']), list(bb['max'])]
                elif f0 and f0.endswith('.sm') and self.vfs.find(f0):
                    try:
                        bb = _fsm().parse_sm(self.vfs.find(f0), keep_data=False)['bbox']
                        info['meshBBox'] = [list(bb['min']), list(bb['max'])]
                    except Exception:
                        pass
        p = tpl.props
        coll = OrderedDict()
        coll['hasCollision'] = flag(p, 'hascollision')
        if 'collisionmaterial' in p:
            coll['material'] = p['collisionmaterial'][0]
        if 'part_colpointfile' in p:
            cp = p['part_colpointfile'][0]
            coll['colPointFile'] = cp
            if not vfs.exists(cp):
                missing.append('col:' + cp)
        if 'part_mass' in p:
            coll['mass'] = float(p['part_mass'][0])
        if 'hascollisionphysics' in p:
            coll['hasCollisionPhysics'] = p['hascollisionphysics'][0]
        info['collision'] = coll
        if tpl.sound:
            info['soundScript'] = tpl.sound
            if not vfs.exists(tpl.sound) and not vfs.exists('object/' + tpl.sound):
                missing.append('sound:' + tpl.sound)
        if 'setshowgeometry' in p:
            info['showGeometry'] = p['setshowgeometry'][0]
        if tpl.type.lower() == 'animatedobject':
            an = OrderedDict()
            an['skeleton'] = tpl.skeleton
            if tpl.skeleton and not vfs.exists(tpl.skeleton):
                missing.append('skeleton:' + tpl.skeleton)
            states = []
            for s in tpl.multi.get('setanimationstate', []):
                st = lib.anim_states.get(s[-1].lower())
                states.append({'slot': s[0], 'state': s[-1],
                               'animations': [x[0] for x in st['anims']] if st else None})
                if st is None:
                    missing.append('animState:' + s[-1])
                else:
                    for x in st['anims']:
                        if not vfs.exists(x[0]):
                            missing.append('baf:' + x[0])
            an['states'] = states
            an['materialTextures'] = [list(x) for x in tpl.multi.get('setmaterialtexture', [])]
            for k in ('setbehaviour', 'setbehaviourtriggerradius', 'setcharacterheight'):
                if k in p:
                    an[k] = p[k][0]
            info['animated'] = an
        if tpl.children:
            kids = []
            for ch in tpl.children:
                sub = self.template(ch['name'], depth + 1) if depth < 8 else {'template': ch['name']}
                kids.append({'template': ch['name'], 'pos': ch['pos'], 'rot': ch['rot'],
                             'kind': sub.get('kind'), 'type': sub.get('type'),
                             'soundScript': sub.get('soundScript'),
                             'meshFiles': [f['path'] for f in sub.get('meshFiles', [])]})
                missing += sub.get('missing', [])
            info['children'] = kids
        extra = OrderedDict()
        for k in ('saveinseparatefile', 'part_islifetimelimited', 'part_lifetime', 'part_ncolpoints',
                  'part_inertia', 'collisionelasticconstant'):
            if k in p:
                extra[k] = p[k] if len(p[k]) != 1 else p[k][0]
        if extra:
            info['props'] = extra
        info['missing'] = sorted(set(missing))
        self.cache[key] = info
        return info


# ============================================================================================ track
def track_dirs(root=FULL):
    out = []
    for p in sorted(glob.glob(os.path.join(root, '*', 'track', '*', '*', 'Objects.con'))):
        tdir = os.path.dirname(p)
        arch = os.path.relpath(p, root).split(os.sep)[0]
        out.append((arch, tdir))
    return out


def family_of(arch):
    return re.match(r'[a-z]+', arch).group(0)


def template_textures(info):
    names = list(info.get('textures', []))
    an = info.get('animated')
    if an:
        names += [m[1] for m in an.get('materialTextures', []) if len(m) > 1]
    return [n for n in names if n and not n.startswith('!')]   # '' = empty group texture in some .tm (Pine1)


def track_lighting(tdir):
    """game.lightColor / game.shadowColor of the track lighting.con (inputs of the baked object tint)."""
    out = {}
    p = os.path.join(tdir, 'lighting.con')
    if os.path.exists(p):
        for raw in open(p, 'rb').read().decode('latin-1').splitlines():
            t = raw.split()
            if len(t) >= 2 and t[0].lower() in ('game.lightcolor', 'game.shadowcolor', 'game.gamma',
                                                 'game.contrast', 'treemesh.billboardlightscale'):
                out[t[0].split('.', 1)[1]] = vec3(t[1])
    return out


def world_matrix(pos, rot, scale):
    R = rot_matrix(*rot)
    s = scale or [1.0, 1.0, 1.0]
    return [[R[i][j] * s[i] for j in range(3)] for i in range(3)], pos


def load_track(vfs, lib, res, tdir, arch):
    tr = OrderedDict()
    tr['archive'] = arch
    tr['dir'] = os.path.relpath(tdir, REPO)
    st = parse_start_con(os.path.join(tdir, 'Start.con'))
    tr['start'] = st
    H = st['createTrack']['height'] if st['createTrack'] else 0.0
    tr['worldOffset'] = [WORLD_XZ_OFFSET, H, WORLD_XZ_OFFSET]
    objs, other = parse_objects_con(os.path.join(tdir, 'Objects.con'))
    tr['objectsConOther'] = dict(other)
    tr['placements'] = objs
    # per-track geometry overrides (lighting.con: geometryTemplate.active <name> + shadowColor/lightColor/lighting)
    ov = {}
    lpath = os.path.join(tdir, 'lighting.con')
    if os.path.exists(lpath):
        cur = None
        for raw in open(lpath, 'rb').read().decode('latin-1').splitlines():
            t = raw.split()
            if not t or t[0].lower() == 'rem':
                continue
            c = t[0].lower()
            if c == 'geometrytemplate.active':
                cur = t[1].lower() if len(t) > 1 else None
                ov.setdefault(cur, OrderedDict())
            elif c.startswith('geometrytemplate.') and cur:
                ov[cur][c.split('.', 1)[1]] = t[1:]
    tr['geometryOverrides'] = ov
    mo_p = os.path.join(tdir, 'MergeObjects.dat')
    mm_p = os.path.join(tdir, 'MergeMesh.dat')
    tr['mergeObjects'] = parse_merge_objects(mo_p) if os.path.exists(mo_p) else None
    tr['mergeMesh'] = parse_merge_mesh(mm_p) if os.path.exists(mm_p) else None
    fi = os.path.join(tdir, 'Files.idx')
    tr['filesIdx'] = parse_files_idx(fi) if os.path.exists(fi) else None
    tr['cameras'] = parse_cameras_con(os.path.join(tdir, 'Cameras.con'))
    tr['trace'] = parse_cmd_list(os.path.join(tdir, 'Trace.con'))
    tr['traceObjects'] = parse_cmd_list(os.path.join(tdir, 'TraceObjects.con'))
    bb = os.path.join(tdir, 'Billboards')
    bbf = []
    if os.path.isdir(bb):
        for dp, dn, fn in os.walk(bb):
            for f in fn:
                bbf.append(os.path.relpath(os.path.join(dp, f), bb).replace(os.sep, '/'))
    tr['billboardFiles'] = sorted(bbf)
    return tr


# ============================================================================================ ground / spline
def read_spl(path):
    txt = open(path, 'r', errors='replace').read()
    return [tuple(map(float, m.group(1).split(','))) for m in
            re.finditer(r'cv\[\d+\]\s*=\s*([-0-9.eE+]+\s*,\s*[-0-9.eE+]+\s*,\s*[-0-9.eE+]+)', txt)]


def sample_spline(cvs, step=2.0):
    import numpy as np
    P = np.array(cvs)
    out = []
    for i in range(len(P) - 3):
        p0, p1, p2, p3 = P[i], P[i + 1], P[i + 2], P[i + 3]
        m = max(2, int(math.ceil(np.linalg.norm(p2 - p1) / step)))
        t = np.arange(m) / m
        b0 = (1 - t) ** 3 / 6
        b1 = (3 * t ** 3 - 6 * t ** 2 + 4) / 6
        b2 = (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6
        b3 = t ** 3 / 6
        out.append(b0[:, None] * p0 + b1[:, None] * p1 + b2[:, None] * p2 + b3[:, None] * p3)
    return np.concatenate(out)


class HeightRaster:
    """Top-surface height raster of a CollisionMesh.Grid (TrackFull.gcm) in sim frame, cell = 1 m.
    Built with numpy per-triangle barycentric fill; also records the lowest surface per cell (bridges)."""

    def __init__(self, gcm, cell=1.0):
        import numpy as np
        V = gcm.V.astype(np.float64)
        T = gcm.I.reshape(-1, 3)
        self.cell = cell
        self.x0, self.z0 = float(V[:, 0].min()) - 1, float(V[:, 2].min()) - 1
        nx = int((V[:, 0].max() - self.x0) / cell) + 3
        nz = int((V[:, 2].max() - self.z0) / cell) + 3
        top = np.full((nz, nx), -np.inf)
        bot = np.full((nz, nx), np.inf)
        A, B, C = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
        for k in range(len(T)):
            a, b, c = A[k], B[k], C[k]
            xs = (a[0], b[0], c[0])
            zs = (a[2], b[2], c[2])
            i0 = int(math.floor((min(xs) - self.x0) / cell))
            i1 = int(math.ceil((max(xs) - self.x0) / cell))
            j0 = int(math.floor((min(zs) - self.z0) / cell))
            j1 = int(math.ceil((max(zs) - self.z0) / cell))
            gx = self.x0 + (np.arange(i0, i1 + 1) + 0.5) * cell
            gz = self.z0 + (np.arange(j0, j1 + 1) + 0.5) * cell
            X, Z = np.meshgrid(gx, gz)
            d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
            if abs(d) < 1e-12:
                continue
            l1 = ((b[2] - c[2]) * (X - c[0]) + (c[0] - b[0]) * (Z - c[2])) / d
            l2 = ((c[2] - a[2]) * (X - c[0]) + (a[0] - c[0]) * (Z - c[2])) / d
            l3 = 1 - l1 - l2
            ins = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
            if not ins.any():
                continue
            y = l1 * a[1] + l2 * b[1] + l3 * c[1]
            sub_t = top[j0:j1 + 1, i0:i1 + 1]
            sub_b = bot[j0:j1 + 1, i0:i1 + 1]
            np.maximum(sub_t, np.where(ins, y, -np.inf), out=sub_t)
            np.minimum(sub_b, np.where(ins, y, np.inf), out=sub_b)
        self.top, self.bot = top, bot

    def near(self, x, z, y):
        """Height of the surface closest to y at (x, z) (top or bottom layer), NaN outside."""
        i = int((x - self.x0) / self.cell)
        j = int((z - self.z0) / self.cell)
        if not (0 <= j < self.top.shape[0] and 0 <= i < self.top.shape[1]):
            return float('nan')
        t, b = self.top[j, i], self.bot[j, i]
        if not math.isfinite(t):
            return float('nan')
        return t if abs(t - y) <= abs(b - y) else b


# ============================================================================================ CLI: validate
def mo_matrix_ok(m, pl):
    """Compare a MergeObjects record with the Objects.con placement it came from."""
    R = rot_matrix(*pl.rot)
    err = 0.0
    for i in range(3):
        for j in range(3):
            err = max(err, abs(m[4 * i + j] - R[i][j]))
    perr = max(abs(m[12 + k] - pl.pos[k]) for k in range(3))
    return err, perr


def validate(args):
    import numpy as np
    sys.path.insert(0, HERE)
    vfs = Vfs()
    lib = load_library(vfs)
    res = Resolver(vfs, lib)
    report = OrderedDict()
    print('library: %d object templates, %d geometry templates, %d scripts run, %d missing runs %s' % (
        len(lib.tpls), len(lib.geoms), len(lib.opened), len(lib.missing_runs), lib.missing_runs[:5]))
    report['library'] = {'objectTemplates': len(lib.tpls), 'geometryTemplates': len(lib.geoms),
                         'scriptsRun': len(lib.opened), 'missingRuns': lib.missing_runs,
                         'unknownCommands': dict(lib.unknown.most_common(40)),
                         'objectTemplateTypes': dict(Counter(t.type for t in lib.tpls.values())),
                         'geometryTemplateTypes': dict(Counter(g.type for g in lib.geoms.values()))}
    do_ground = '--no-ground' not in args
    try:
        import fmt_gcm
    except Exception as e:  # pragma: no cover
        fmt_gcm = None
        print('fmt_gcm unavailable:', e)
    tracks = OrderedDict()
    tot = Counter()
    all_missing = Counter()
    for arch, tdir in track_dirs():
        tr = load_track(vfs, lib, res, tdir, arch)
        pls = tr['placements']
        H = tr['worldOffset'][1]
        row = OrderedDict()
        row['placements'] = len(pls)
        row['objectsConOther'] = tr['objectsConOther']
        cnt = Counter(p.template for p in pls)
        row['templates'] = len(cnt)
        miss = Counter()
        kinds = Counter()
        for name, n in cnt.items():
            info = res.template(name)
            kinds[info['kind']] += n
            for m in info.get('missing', []):
                miss[m] += n
        # billboards: every placed billboard tree needs Billboards/<geom>.dds in this track
        bbf = {f.lower() for f in tr['billboardFiles']}
        used_bb = set()
        for name, n in cnt.items():
            info = res.template(name)
            if 'billboardTexture' in info:
                bn = info['billboardTexture'].split('/', 1)[1].lower()
                used_bb.add(bn)
                if bn not in bbf:
                    miss['billboard:' + bn] += n
        row['billboards'] = {'files': len(bbf), 'used': len(used_bb), 'unused': sorted(bbf - used_bb)}
        tv = vfs.norm(os.path.relpath(tdir, os.path.join(FULL, arch)))
        texwhere = Counter()
        for name, n in cnt.items():
            for t in template_textures(res.template(name)):
                vp, where = res.texture(t, tv)
                if vp is None:
                    miss['texture:' + t] += n
                else:
                    texwhere[where] += 1
        row['textureLookups'] = dict(texwhere)
        row['kinds'] = dict(kinds)
        row['missing'] = dict(miss)
        for m, n in miss.items():
            all_missing[m] += n
        # MergeObjects / MergeMesh vs Objects.con
        mo, mm = tr['mergeObjects'], tr['mergeMesh']
        merged_names = set()
        if mm:
            row['mergeMesh'] = {'size': mm['size'], 'leftover': mm['leftover'], 'templates': len(mm['templates']),
                                'instances': len(mm['instances']), 'sideScreens': len(mm['sideScreens']),
                                'vertices': mm['vertexCount'], 'indices': mm['indexCount'],
                                'grid': [mm['grid']['nx'], mm['grid']['nz'], list(mm['grid']['cell'])],
                                'gridSideScreen': [mm['gridSideScreen']['nx'], mm['gridSideScreen']['nz'],
                                                   list(mm['gridSideScreen']['cell'])]}
            merged_names = {t['name'].lower() for t in mm['templates']}
            # instance count per template must equal the Objects.con count
            mmc = Counter()
            for lst in (mm['instances'], mm['sideScreens']):
                for it in lst:
                    mmc[mm['templates'][it['template']]['name'].lower()] += 1
            conc = Counter({k.lower(): v for k, v in cnt.items()})
            row['mergeMesh']['countsMatchCon'] = all(mmc[k] == conc.get(k, 0) for k in mmc)
            row['mergeMesh']['countMismatch'] = {k: [mmc[k], conc.get(k, 0)] for k in mmc if mmc[k] != conc.get(k, 0)}
            # every merged template's sideScreen flag vs library
            flags = {}
            for t in mm['templates']:
                g = lib.geoms.get(t['name'].lower())
                flags[t['name']] = {'sideScreenDat': t['sideScreen'],
                                    'sideScreenLib': flag(g.props, 'sidescreen') if g else None,
                                    'mergeableLib': flag(g.props, 'mergeable') if g else None}
            row['mergeMesh']['flags'] = flags
            # matrices: match each MM instance to a placement (by template + position)
            cand = defaultdict(list)
            for p in pls:
                cand[(p.template.lower(), int(math.floor(p.pos[0])), int(math.floor(p.pos[2])))].append(p)
            merr, nmatch, nbad = 0.0, 0, 0
            colstat = []
            for lst in (mm['instances'], mm['sideScreens']):
                for it in lst:
                    nm = mm['templates'][it['template']]['name'].lower()
                    m = it['matrix']
                    fx, fz = int(math.floor(m[12])), int(math.floor(m[14]))
                    best = None
                    for dx in (-1, 0, 1):
                        for dz in (-1, 0, 1):
                            for p in cand.get((nm, fx + dx, fz + dz), ()):
                                pe = max(abs(m[12 + k] - p.pos[k]) for k in range(3))
                                if pe > 0.05:
                                    continue
                                R = rot_matrix(*p.rot)
                                s_ = p.scale or [1, 1, 1]
                                e = max(abs(m[4 * i + j] - R[i][j] * s_[i]) for i in range(3) for j in range(3))
                                if best is None or e < best[0]:
                                    best = (e, p)
                    if best is None:
                        continue
                    merr = max(merr, best[0])
                    nbad += best[0] > 1e-3
                    nmatch += 1
                    p = best[1]
                    colstat.append((it['bgra'], p.color, p.shadow, nm))
            row['mergeMesh']['matrixErrOver1e-3'] = int(nbad)
            row['mergeMesh']['_colstat'] = colstat[:0]
            row['mergeMesh']['matrixMatched'] = nmatch
            row['mergeMesh']['matrixMaxErr'] = merr
        if mo:
            non_merged = [p for p in pls if p.template.lower() not in merged_names]
            row['mergeObjects'] = {'size': mo['size'], 'leftover': mo['leftover'], 'count': mo['count'],
                                   'records': len(mo['objects']), 'groups': len(mo['groups']),
                                   'treeNodes': len(mo['tree']),
                                   'treeLeaves': sum(1 for n in mo['tree'] if n[0] >= 0),
                                   'nonMergedPlacements': len(non_merged)}
            leaves = sorted(n[0] for n in mo['tree'] if n[0] >= 0)
            row['mergeObjects']['treeLeavesAreIndices'] = leaves == sorted(o['index'] for o in mo['objects'])
            moc = Counter(o['template'].lower() for o in mo['objects'])
            nmc = Counter(p.template.lower() for p in non_merged)
            row['mergeObjects']['countsMatchCon'] = moc == nmc
            row['mergeObjects']['countDiff'] = {k: [moc.get(k, 0), nmc.get(k, 0)] for k in set(moc) | set(nmc)
                                                if moc.get(k, 0) != nmc.get(k, 0)}
            cand = defaultdict(list)
            for p in non_merged:
                cand[(p.template.lower(), int(math.floor(p.pos[0])), int(math.floor(p.pos[2])))].append(p)
            rerr, perr, nmatch, serr, cerr, sferr = 0.0, 0.0, 0, 0.0, 0.0, 0.0
            nbad = 0
            defaults = Counter()
            for o in mo['objects']:
                m = o['matrix']
                best = None
                fx, fz = int(math.floor(m[12])), int(math.floor(m[14]))
                for dx in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for p in cand.get((o['template'].lower(), fx + dx, fz + dz), ()):
                            e, pe = mo_matrix_ok(m, p)
                            if pe > 0.05:
                                continue
                            sc = e + pe
                            if best is None or sc < best[0]:
                                best = (sc, e, pe, p)
                if best is None:
                    continue
                _, e, pe, p = best
                if e > 1e-3:
                    nbad += 1
                rerr, perr = max(rerr, e), max(perr, pe)
                s_ = p.scale or [1.0, 1.0, 1.0]
                serr = max(serr, max(abs(o['scale'][i] - s_[i]) for i in range(3)))
                if p.color is None:
                    defaults['color:' + '/'.join('%g' % round(x, 4) for x in o['color'])] += 1
                else:
                    cerr = max(cerr, max(abs(o['color'][i] - p.color[i]) for i in range(3)))
                if p.shadow is None:
                    defaults['shadow:%g' % round(o['shadow'], 4)] += 1
                else:
                    sferr = max(sferr, abs(o['shadow'] - p.shadow))
                nmatch += 1
            row['mergeObjects']['rotErrOver1e-3'] = nbad
            row['mergeObjects'].update({'matched': nmatch, 'rotMaxErr': rerr, 'posMaxErr': perr,
                                        'scaleMaxErr': serr, 'colorMaxErr': cerr, 'shadowMaxErr': sferr,
                                        'defaultsWhenAbsent': dict(defaults.most_common(6))})
        # Files.idx: object-library scripts opened in the same order as our interpreter?
        if tr['filesIdx']:
            fi_cons = [vfs.norm(x) for x in tr['filesIdx'] if x.lower().endswith('.con')]
            lib_set = set(lib.opened)
            fi_lib = [x for x in fi_cons if x in lib_set]
            ours = [x for x in lib.opened]
            # ours is the union over all; Files.idx lists only first opens -> compare as subsequence
            seen, uniq = set(), []
            for x in ours:
                if x not in seen:
                    seen.add(x)
                    uniq.append(x)
            fi_set = set(fi_cons)
            row['filesIdx'] = {'entries': len(tr['filesIdx']), 'cons': len(fi_cons),
                               'libraryScriptsListed': len(fi_lib),
                               'librarySubsequence': [x for x in uniq if x in fi_set] == [x for x in fi_lib],
                               'libraryNotListed': [x for x in uniq if x not in fi_set][:10],
                               'mergeFilesListed': [x for x in tr['filesIdx'] if 'merge' in x.lower()],
                               'objectsConListed': any(x.lower().endswith('/objects.con') for x in tr['filesIdx'])}
            # every file in Files.idx that is a mesh/texture/col: does it exist?
            fmiss = [x for x in tr['filesIdx'] if not vfs.exists(x)]
            row['filesIdx']['missing'] = len(fmiss)
            row['filesIdx']['missingSample'] = fmiss[:8]
        # ground check: object y vs TrackFull.gcm (raster) and vs centre spline
        if do_ground and fmt_gcm is not None:
            gpath = os.path.join(tdir, 'Mesh', 'TrackFull.gcm')
            if not os.path.exists(gpath):
                gpath = os.path.join(tdir, 'Mesh', 'Track.gcm')
            g = fmt_gcm.read_gcm(gpath)
            hr = HeightRaster(g)
            dys = defaultdict(list)
            dyt = defaultdict(list)
            for p in pls:
                info = res.template(p.template)
                x, y, z = p.pos[0] - WORLD_XZ_OFFSET, p.pos[1] - H, p.pos[2] - WORLD_XZ_OFFSET
                if info['kind'] == 'physics' and 'meshBBox' in info:
                    # PhyObject meshes are centred on the body (Sign08: y -1.32..1.49): test the mesh bottom
                    y = y + info['meshBBox'][0][1] * ((p.scale or [1, 1, 1])[1])
                h = hr.near(x, z, y)
                dys[info['kind']].append(y - h)
                dyt[p.template].append(y - h)
            worst = []
            for k, v in dyt.items():
                a = np.array(v)
                fin = a[np.isfinite(a)]
                med = float(np.median(np.abs(fin))) if len(fin) else float('nan')
                worst.append((k, len(a), int((~np.isfinite(a)).sum()), round(med, 2),
                              round(float(np.median(fin)), 2) if len(fin) else None))
            worst.sort(key=lambda w: -(w[3] if w[3] == w[3] else 1e9))
            row['groundWorstTemplates'] = worst[:8]
            gk = OrderedDict()
            for k, v in dys.items():
                a = np.array(v)
                fin = a[np.isfinite(a)]
                if len(fin) == 0:
                    gk[k] = {'n': len(a), 'outside': len(a)}
                    continue
                ab = np.abs(fin)
                gk[k] = {'n': len(a), 'outside': int((~np.isfinite(a)).sum()),
                         'median': round(float(np.median(fin)), 3), 'p95abs': round(float(np.percentile(ab, 95)), 3),
                         'within0.5m': round(float((ab < 0.5).mean()), 4), 'within2m': round(float((ab < 2).mean()), 4)}
            row['ground'] = gk
            # spline: the road surface must sit on the spline, objects near the road should be close in y
            cvs = read_spl(os.path.join(tdir, 'AiFiles', 'center.spl'))
            S = sample_spline(cvs, 2.0)
            hs = np.array([hr.near(s[0], s[2], s[1]) for s in S])
            fin = np.isfinite(hs)
            row['splineVsGcm'] = {'samples': int(len(S)), 'onMesh': int(fin.sum()),
                                  'median_dy': round(float(np.median(hs[fin] - S[fin, 1])), 3),
                                  'p95abs': round(float(np.percentile(np.abs(hs[fin] - S[fin, 1]), 95)), 3)}
            P = np.array([[p.pos[0] - WORLD_XZ_OFFSET, p.pos[2] - WORLD_XZ_OFFSET, p.pos[1] - H] for p in pls])
            # nearest spline sample (xz) per object -> distance + dy (chunked)
            near_d, near_dy = [], []
            Sxz = S[:, [0, 2]]
            for i0 in range(0, len(P), 4000):
                Q = P[i0:i0 + 4000]
                d2 = ((Q[:, None, 0] - Sxz[None, :, 0]) ** 2 + (Q[:, None, 1] - Sxz[None, :, 1]) ** 2)
                k = d2.argmin(1)
                near_d.append(np.sqrt(d2[np.arange(len(Q)), k]))
                near_dy.append(Q[:, 2] - S[k, 1])
            near_d, near_dy = np.concatenate(near_d), np.concatenate(near_dy)
            sel = near_d < 15
            row['splineNearby'] = {'within15m': int(sel.sum()),
                                   'median_dy': round(float(np.median(near_dy[sel])), 3) if sel.any() else None,
                                   'p95abs_dy': round(float(np.percentile(np.abs(near_dy[sel]), 95)), 3)
                                   if sel.any() else None,
                                   'median_dist': round(float(np.median(near_d)), 1)}
        tracks[arch] = row
        tot['placements'] += len(pls)
        print('%-14s n=%6d tpl=%3d miss=%d MO=%s MM=%s %s' % (
            arch, len(pls), len(cnt), sum(miss.values()),
            ('ok' if mo and mo['leftover'] == 0 and row['mergeObjects']['countsMatchCon'] else
             ('BAD' if mo else '-')),
            ('ok' if mm and mm['leftover'] == 0 and row['mergeMesh']['countsMatchCon'] else ('BAD' if mm else '-')),
            (' ground: ' + ' '.join('%s %.0f%%' % (k[:6], 100 * v.get('within0.5m', 0)) for k, v in
                                   row.get('ground', {}).items())) if 'ground' in row else ''))
        sys.stdout.flush()
    report['tracks'] = tracks
    report['totals'] = {'placements': tot['placements'], 'missingRefs': dict(all_missing)}
    out = args[args.index('--json') + 1] if '--json' in args else os.path.join(
        REPO, 'artifacts', 're', 'objects', 'validate.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(report, open(out, 'w'), indent=1, default=str)
    print('total placements', tot['placements'], 'missing refs', dict(all_missing))
    print('wrote', out)
    return report


# ============================================================================================ CLI: dump
def r4(x):
    return round(x, 4)


def dump(args):
    outdir = args[0] if args else os.path.join(DUMPS, 'objects_dump')
    os.makedirs(outdir, exist_ok=True)
    vfs = Vfs()
    lib = load_library(vfs)
    res = Resolver(vfs, lib)
    index = OrderedDict()
    for arch, tdir in track_dirs():
        tr = load_track(vfs, lib, res, tdir, arch)
        pls = tr['placements']
        names = list(OrderedDict.fromkeys(p.template for p in pls))
        tix = {n: i for i, n in enumerate(names)}
        cnt = Counter(p.template for p in pls)
        mm = tr['mergeMesh']
        merged = {}
        if mm:
            for t in mm['templates']:
                merged[t['name'].lower()] = 'sideScreenBatch' if t['sideScreen'] else 'mergeBatch'
        templates = []
        for n in names:
            info = dict(res.template(n))
            info['count'] = cnt[n]
            tv = vfs.norm(os.path.relpath(tdir, os.path.join(FULL, arch)))
            tex = OrderedDict()
            for t in template_textures(info):
                tex[t] = res.texture(t, tv)[0]
            if tex:
                info['textureFiles'] = tex
            if 'billboardTexture' in info:
                bp = tv + '/' + info['billboardTexture'].lower()
                info['billboardTextureFile'] = bp if bp in vfs.index else None
            info['mergeMesh'] = merged.get(n.lower())
            ov = tr['geometryOverrides'].get((info.get('geometry') or '').lower())
            if ov:
                info['trackGeometryOverrides'] = ov
            templates.append(info)
        inst = []
        for p in pls:
            row = [tix[p.template]] + [r4(v) for v in p.pos] + [r4(v) for v in p.rot]
            row += [r4(v) for v in (p.scale or (1.0, 1.0, 1.0))]
            row += [r4(v) for v in p.color] if p.color else [None, None, None]
            row.append(r4(p.shadow) if p.shadow is not None else None)
            inst.append(row)
        doc = OrderedDict()
        doc['format'] = 'rally-web objects dump v1 (research/formats/objects.md)'
        doc['archive'] = arch
        doc['trackDir'] = tr['dir']
        doc['createTrack'] = tr['start']['createTrack']
        doc['worldOffset'] = tr['worldOffset']
        doc['lighting'] = track_lighting(tdir)
        doc['tintFormula'] = ('rgbByte = floor(255*clamp01(colorQ * (shadowColor*tplShadowColor*(1+shadowFactor) + '
                              'lightColor*tplLightColor*(1-shadowFactor)))); colorQ = float32(floor(255*color)) * '
                              'float32(0.003921569) (TreeMesh colour is stored as a byte; default byte 127 = 0.498039 '
                              'when the color column is null; non-TreeMesh objects never carry a colour and keep 0.5); '
                              'shadowFactor default 0; tpl* = geometryOverrides[geometry].shadowcolor/lightcolor '
                              '(default 1). Reproduces 458537/458547 MergeMesh baked channel bytes (objects.md '
                              'Verification).')
        doc['frame'] = ('instance pos/rot are in the OBJECT WORLD frame: sim = pos - worldOffset; rotation '
                        'yaw/pitch/roll degrees, R = Rz(roll).Rx(pitch).Ry(yaw) row-vector; '
                        'world matrix = diag(scale).R; color/shadow null = engine default')
        doc['instanceColumns'] = ['templateIndex', 'x', 'y', 'z', 'yaw', 'pitch', 'roll', 'sx', 'sy', 'sz',
                                  'r', 'g', 'b', 'shadowFactor']
        doc['templateCounts'] = OrderedDict(sorted(((n, cnt[n]) for n in names), key=lambda kv: -kv[1]))
        doc['kindCounts'] = dict(Counter(res.template(p.template)['kind'] for p in pls))
        doc['templates'] = templates
        doc['instances'] = inst
        doc['startCon'] = tr['start']
        doc['replayCameras'] = tr['cameras']['cameras']
        doc['trace'] = tr['trace']
        doc['traceObjects'] = tr['traceObjects']
        doc['billboardFiles'] = tr['billboardFiles']
        doc['geometryOverrides'] = tr['geometryOverrides']
        if mm:
            doc['mergeMesh'] = {
                'templates': [{k: v for k, v in t.items()} for t in mm['templates']],
                'instances': len(mm['instances']), 'sideScreens': len(mm['sideScreens']),
                'vertexCount': mm['vertexCount'], 'indexCount': mm['indexCount'],
                'grid': {k: mm['grid'][k] for k in ('bmin', 'bmax', 'nx', 'nz', 'cell')},
                'gridSideScreen': {k: mm['gridSideScreen'][k] for k in ('bmin', 'bmax', 'nx', 'nz', 'cell')},
                'instanceColors': [list(it['bgra']) for it in mm['instances'] + mm['sideScreens']][:0]}
        mo = tr['mergeObjects']
        if mo:
            doc['mergeObjects'] = {'count': mo['count'], 'groups': [{'template': g['template'], 'count': g['count']}
                                                                   for g in mo['groups']],
                                   'treeNodes': len(mo['tree'])}
        doc['filesIdx'] = tr['filesIdx'] is not None
        name = arch
        path = os.path.join(outdir, name + '.json')
        with open(path, 'w') as f:
            json.dump(doc, f, separators=(',', ':'), default=str)
        index[arch] = {'file': name + '.json', 'instances': len(inst), 'templates': len(names),
                       'kinds': doc['kindCounts'], 'bytes': os.path.getsize(path)}
        print(arch, len(inst), os.path.getsize(path))
    json.dump(index, open(os.path.join(outdir, 'index.json'), 'w'), indent=1)
    # the library itself (all templates, resolved), for the converter
    libdoc = OrderedDict()
    libdoc['scriptsRun'] = lib.opened
    libdoc['objectTemplates'] = OrderedDict((t.name, res.template(t.name)) for t in lib.tpls.values())
    libdoc['geometryTemplates'] = OrderedDict(
        (g.name, {'type': g.type, 'file': g.file, 'lods': g.lods, 'props': g.props, 'src': g.src})
        for g in lib.geoms.values())
    libdoc['animationStates'] = lib.anim_states
    json.dump(libdoc, open(os.path.join(outdir, '_library.json'), 'w'), indent=1, default=str)
    print('wrote', outdir)


# ============================================================================================ CLI: scatter
def scatter(args):
    import numpy as np
    from PIL import Image, ImageDraw
    outdir = args[0] if args else os.path.join(REPO, 'artifacts', 're', 'objects')
    os.makedirs(outdir, exist_ok=True)
    vfs = Vfs()
    lib = load_library(vfs)
    res = Resolver(vfs, lib)
    fams = defaultdict(list)
    for arch, tdir in track_dirs():
        fams[family_of(arch)].append((arch, tdir))
    for fam, lst in fams.items():
        tiles = []
        for arch, tdir in lst:
            tr = load_track(vfs, lib, res, tdir, arch)
            H = tr['worldOffset'][1]
            pls = tr['placements']
            cvs = read_spl(os.path.join(tdir, 'AiFiles', 'center.spl'))
            S = sample_spline(cvs, 2.0)
            pts = np.array([[p.pos[0] - WORLD_XZ_OFFSET, p.pos[2] - WORLD_XZ_OFFSET] for p in pls]) if pls else \
                np.zeros((0, 2))
            # view = spline bbox + 350 m (a few stray placements sit at absurd coordinates, e.g. truck3 at
            # 4.4e7 m in hillclimb3b; they are counted as 'off' in the caption)
            lo, hi = S[:, [0, 2]].min(0) - 350, S[:, [0, 2]].max(0) + 350
            if len(pts):
                inb = (pts[:, 0] >= lo[0]) & (pts[:, 0] <= hi[0]) & (pts[:, 1] >= lo[1]) & (pts[:, 1] <= hi[1])
                n_off = int((~inb).sum())
            else:
                n_off = 0
            W = 900
            sc = W / max(hi - lo)
            if (hi[1] - lo[1]) * sc > 1100:
                sc = 1100 / (hi[1] - lo[1])
            Wd, Hd = int((hi[0] - lo[0]) * sc) + 1, int((hi[1] - lo[1]) * sc) + 1
            im = Image.new('RGB', (Wd, Hd + 22), (250, 250, 248))
            dr = ImageDraw.Draw(im)

            def px(x, z):     # top-down, sim +x right, sim +z up (north up)
                return ((x - lo[0]) * sc, 22 + (hi[1] - z) * sc)
            order = list(KIND_COLORS)
            kinds = [res.template(p.template)['kind'] for p in pls]
            idx = sorted(range(len(pls)), key=lambda i: order.index(kinds[i]))
            for i in idx:
                x, z = pts[i]
                c = KIND_COLORS[kinds[i]]
                u, v = px(x, z)
                rr = 1 if kinds[i] in ('mergeVeg', 'billboardTree', 'tree3d', 'sidescreen', 'rock') else 2
                dr.ellipse([u - rr, v - rr, u + rr, v + rr], fill=c)
            line = [px(s[0], s[2]) for s in S]
            dr.line(line, fill=(0, 0, 0), width=2)
            u, v = px(S[0][0], S[0][2])
            dr.rectangle([u - 4, v - 4, u + 4, v + 4], outline=(0, 0, 0), width=2)
            kc = Counter(kinds)
            dr.text((4, 4), '%s  n=%d off=%d  ' % (arch, len(pls), n_off) + ' '.join(
                '%s:%d' % (k, kc[k]) for k in order if kc.get(k)), fill=(0, 0, 0))
            tiles.append(im)
            print(fam, arch, len(pls))
        # sheet + legend
        cols = 2 if len(tiles) <= 6 else 3
        tw = max(t.width for t in tiles)
        th = max(t.height for t in tiles)
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new('RGB', (cols * tw + (cols + 1) * 6, rows * th + (rows + 1) * 6 + 30), (200, 200, 200))
        d = ImageDraw.Draw(sheet)
        x = 6
        for k, c in KIND_COLORS.items():
            d.rectangle([x, 8, x + 12, 20], fill=c)
            d.text((x + 16, 8), k, fill=(0, 0, 0))
            x += 16 + 7 * len(k) + 18
        d.text((x + 10, 8), 'black = AiFiles/center.spl, square = cv0; top-down sim frame (+x right, +z up)',
               fill=(0, 0, 0))
        for i, t in enumerate(tiles):
            r_, c_ = divmod(i, cols)
            sheet.paste(t, (6 + c_ * (tw + 6), 36 + r_ * (th + 6)))
        p = os.path.join(outdir, 'scatter_%s.png' % fam)
        sheet.save(p)
        print('wrote', p, sheet.size)


def mergemesh_png(args):
    """Visual proof of MergeMesh.dat: (left) every merged triangle of every instance, top-down, filled with the
    instance's baked BGRA colour, over the centre spline; (right) side views of each template's vertex-pool mesh
    (sort direction 0 index range)."""
    import numpy as np
    from PIL import Image, ImageDraw
    arch = args[0] if args else 'corsica1f'
    outdir = args[1] if len(args) > 1 else os.path.join(REPO, 'artifacts', 're', 'objects')
    tdir = [t for a, t in track_dirs() if a == arch][0]
    mm = parse_merge_mesh(os.path.join(tdir, 'MergeMesh.dat'), keep_geometry=True)
    H = parse_start_con(os.path.join(tdir, 'Start.con'))['createTrack']['height']
    V = np.array(mm['vertices'], dtype=np.float64).reshape(-1, 5)
    I = np.array(mm['indices'], dtype=np.int64)
    S = sample_spline(read_spl(os.path.join(tdir, 'AiFiles', 'center.spl')), 2.0)
    lo, hi = S[:, [0, 2]].min(0) - 150, S[:, [0, 2]].max(0) + 150
    W = 1400
    sc = W / max(hi - lo)
    Hh = int((hi[1] - lo[1]) * sc) + 1
    im = Image.new('RGB', (int((hi[0] - lo[0]) * sc) + 1, Hh), (255, 255, 255))
    dr = ImageDraw.Draw(im)
    ntri = 0
    for lst in (mm['instances'], mm['sideScreens']):
        for it in lst:
            t = mm['templates'][it['template']]
            M = np.array(it['matrix']).reshape(4, 4)
            idx = I[t['indexStart']:t['indexStart'] + 3 * t['triCount']].reshape(-1, 3)   # sort direction 0
            P = np.c_[V[:, :3], np.ones(len(V))][np.unique(idx)] if False else None
            pts = np.c_[V[idx.ravel(), :3], np.ones(idx.size)] @ M
            b, g, r, a = it['bgra']
            for k in range(0, len(pts), 3):
                tri = [((x - WORLD_XZ_OFFSET - lo[0]) * sc, (hi[1] - (z - WORLD_XZ_OFFSET)) * sc)
                       for x, z in pts[k:k + 3, [0, 2]]]
                dr.polygon(tri, fill=(r, g, b))
                ntri += 1
    dr.line([((x - lo[0]) * sc, (hi[1] - z) * sc) for x, z in S[:, [0, 2]]], fill=(255, 0, 0), width=1)
    dr.text((6, 6), '%s MergeMesh.dat: %d inst + %d sideScreen, %d tris drawn (dir 0), baked BGRA fill; red = '
            'center.spl' % (arch, len(mm['instances']), len(mm['sideScreens']), ntri), fill=(0, 0, 0))
    # template side views
    th = 160
    tiles = []
    for t in mm['templates']:
        idx = I[t['indexStart']:t['indexStart'] + 3 * t['triCount']].reshape(-1, 3)
        P = V[idx.ravel(), :3]
        tl = Image.new('RGB', (th, th + 14), (235, 235, 235))
        d2 = ImageDraw.Draw(tl)
        mn, mx = P.min(0), P.max(0)
        span = max(mx[0] - mn[0], mx[1] - mn[1], 1e-3)
        f = (th - 10) / span
        for k in range(0, len(P), 3):
            d2.polygon([(5 + (x - mn[0]) * f, th - 5 - (y - mn[1]) * f) for x, y in P[k:k + 3, :2]],
                       outline=(30, 90, 30))
        d2.text((3, th), '%s %d' % (t['name'][:18], t['triCount']), fill=(0, 0, 0))
        tiles.append(tl)
    cols = 3
    side = Image.new('RGB', (cols * th, ((len(tiles) + cols - 1) // cols) * (th + 14)), (200, 200, 200))
    for k, tl in enumerate(tiles):
        side.paste(tl, ((k % cols) * th, (k // cols) * (th + 14)))
    out = Image.new('RGB', (im.width + side.width + 6, max(im.height, side.height)), (180, 180, 180))
    out.paste(im, (0, 0))
    out.paste(side, (im.width + 6, 0))
    os.makedirs(outdir, exist_ok=True)
    p = os.path.join(outdir, 'mergemesh_%s.png' % arch)
    out.save(p)
    print('wrote', p, ntri)


def info(args):
    vfs = Vfs()
    lib = load_library(vfs)
    res = Resolver(vfs, lib)
    tdir = args[0]
    arch = os.path.relpath(tdir, FULL).split(os.sep)[0]
    tr = load_track(vfs, lib, res, tdir, arch)
    cnt = Counter(p.template for p in tr['placements'])
    for n, c in cnt.most_common():
        i = res.template(n)
        print('%6d %-28s %-12s %-22s %s %s' % (c, n, i['kind'], i.get('type'),
                                               [f['path'] for f in i.get('meshFiles', [])], i.get('missing')))


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd, args = argv[0], argv[1:]
    if cmd == 'validate':
        validate(args)
    elif cmd == 'dump':
        dump(args)
    elif cmd == 'scatter':
        scatter(args)
    elif cmd == 'info':
        info(args)
    elif cmd == 'mergemesh':
        mergemesh_png(args)
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
