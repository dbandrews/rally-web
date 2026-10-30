#!/usr/bin/env python3
"""
fmt_cars.py — car visual assembly for the original Refractor2 rally game (research tool).

Parses, for every car under research/full/Cars/cars/<Car>/:
  * the .con template scripts (Geom, Templates, TemplatesMenu, Player, AI, Ghost, Burst, Lensflares,
    PhysicsCar, PhysicsWheel*) plus the shared ones (Cars/cars/Wheels.con, Misc/object/Driver.con,
    CarCommon.con, FX_CarFlare*.con) with `run` includes and `if v_inMenu` branches,
  * the CarMesh files (.cm, version 8; loader FUN_00654760 -> 0x6548f0 -> 0x654930/0x654980/0x654a10/0x654c30)
    for all four LOD sets Mesh/Cars, Mesh/Cars_1, Mesh/Cars_2, Mesh/Cars_3 (path rewrite FUN_00577e40),
  * the per-mesh subshader files (Shaders.rs / <wheel>.rs; "Car/Default" builder, _SP/_MP rule 0x65eaa0),
  * texture references (Misc/texture/...), drop shadows, hull points (.col), menu names (Menu/menu/Car/<Car>
    meme files -> LocaleEnglish localestrings.str LSBL ids).

Writes research/formats/cars_dump.json and prints a validation summary (every .cm consumed to its last byte,
every file reference resolved).

Usage:  research/.venv/bin/python -I research/tools/fmt_cars.py [--out PATH] [--quiet]
Library: import fmt_cars; fmt_cars.parse_cm(path) / fmt_cars.cm_arrays(...) / fmt_cars.assemble_all()
"""
from __future__ import annotations

import glob
import json
import math
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # rally-web: data roots from _paths.py
from _paths import REPO as ROOT, FULL, DUMPS  # noqa: E402
CARS = os.path.join(FULL, 'Cars', 'cars')
MISC = os.path.join(FULL, 'Misc')
MENU_CAR = os.path.join(FULL, 'Menu', 'menu', 'Car')
LOCALE = os.path.join(FULL, 'LocaleEnglish', 'locale', 'english', 'locale', 'localestrings.str')
LOD_DIRS = ['Cars', 'Cars_1', 'Cars_2', 'Cars_3']

# --------------------------------------------------------------------------------------- file lookup
_ci_cache: dict[str, dict[str, str]] = {}


def ci_path(base: str, rel: str) -> str | None:
    """Case-insensitive resolve of rel (with / separators) under base. Returns the real path or None."""
    cur = base
    for part in [p for p in rel.replace('\\', '/').split('/') if p]:
        if cur not in _ci_cache:
            try:
                _ci_cache[cur] = {n.lower(): n for n in os.listdir(cur)}
            except (NotADirectoryError, FileNotFoundError):
                return None
        n = _ci_cache[cur].get(part.lower())
        if n is None:
            return None
        cur = os.path.join(cur, n)
    return cur


def rel(p: str | None) -> str | None:
    return None if p is None else os.path.relpath(p, ROOT)


def resolve_script(name: str) -> str | None:
    """`run X` path -> file. Scripts live under Cars/cars (Cars/...) or Misc (object/..., animations/...)."""
    n = name.replace('\\', '/')
    cands = [n] if n.lower().endswith('.con') else [n + '.con', n]
    for c in cands:
        if c.lower().startswith('cars/'):
            p = ci_path(os.path.join(FULL, 'Cars', 'cars'), c[5:])
        else:
            p = ci_path(MISC, c)
        if p and os.path.isfile(p):
            return p
    return None


def resolve_mesh(file_ref: str, ext: str) -> str | None:
    return ci_path(MISC, file_ref + ext)


def resolve_texture(ref: str) -> str | None:
    """Shader texture reference ("texture/car/OpelAstra_LOD0") -> Misc/texture/... file (.dds preferred)."""
    for ext in ('.dds', '.tga', '.rcm', ''):
        p = ci_path(MISC, ref + ext)
        if p and os.path.isfile(p):
            return p
    return None


# --------------------------------------------------------------------------------------- .cm reader
VF_POS, VF_NORMAL, VF_DIFFUSE, VF_TEX0, VF_TEX1, VF_TEX2 = 0x1, 0x10, 0x40, 0x400, 0x2000, 0x10000


def vertex_layout(fmt: int) -> dict[str, int]:
    """Byte offsets of the vertex components for a Refractor vertex-format word [E: holds for all files;
    fmt 0x12451 stride 52, 0x451 stride 36, 0x411 stride 32 (.sm), 0x1 stride 12 (.sm shadow)]."""
    off, lay = 0, {}
    for bit, name, size in ((VF_POS, 'pos', 12), (VF_NORMAL, 'normal', 12), (VF_DIFFUSE, 'color', 4),
                            (VF_TEX0, 'uv0', 8), (VF_TEX1, 'uv1', 8), (VF_TEX2, 'uv2', 8)):
        if fmt & bit:
            lay[name] = off
            off += size
    lay['stride'] = off
    return lay


class Reader:
    def __init__(self, data: bytes):
        self.d, self.o = data, 0

    def u8(self):
        v = self.d[self.o]; self.o += 1; return v

    def u32(self):
        v = struct.unpack_from('<I', self.d, self.o)[0]; self.o += 4; return v

    def f32s(self, n):
        v = struct.unpack_from('<%df' % n, self.d, self.o); self.o += 4 * n; return v

    def raw(self, n):
        v = self.d[self.o:self.o + n]; self.o += n; return v

    def string(self):  # FUN_005b8430: u32 length + bytes, no terminator
        n = self.u32(); return self.raw(n).decode('latin1')


def parse_cm(path: str) -> dict:
    """CarMesh (.cm). Byte layout [V FUN_00654930, FUN_00654980, FUN_00654a10, FUN_00654c30]:
       u32 version (must be 8) | u32 unk | f32[6] AABB min,max (FUN_005b8620 also derives a radius)
       u32 nExtra (0 in every file; >0 would be u32 classId + an object read, FUN_00654980)
       u32 nLod | per LOD: u8 keepDeformCopy | u32 nMat | nMat x material header | nMat x material data
       material header: string name | 12 raw bytes (exporter garbage "shCompiler.c") | u32 primType |
                        u32 vertexFormat | u32 stride | u32 nVert | u32 nIndex | u32 mat+0x3c | u32 mat+0x40
       material data:   nVert*stride vertex bytes | nIndex*u16 indices | (keepDeformCopy) nVert*24 bytes
    """
    d = open(path, 'rb').read()
    r = Reader(d)
    out = {'path': path, 'version': r.u32(), 'unk': r.u32()}
    out['bbox'] = list(r.f32s(6))
    out['nExtra'] = r.u32()
    if out['nExtra']:
        raise ValueError('%s: nExtra=%d not supported' % (path, out['nExtra']))
    nlod = r.u32()
    lods = []
    for _ in range(nlod):
        flag = r.u8()
        mats = []
        for _ in range(r.u32()):
            m = {'name': r.string(), 'raw12': r.raw(12).decode('latin1'), 'prim': r.u32(), 'fmt': r.u32(),
                 'stride': r.u32(), 'nv': r.u32(), 'ni': r.u32(), 'f3c': r.u32(), 'group': r.u32()}
            mats.append(m)
        for m in mats:
            m['voff'] = r.o; r.o += m['stride'] * m['nv']
            m['ioff'] = r.o; r.o += 2 * m['ni']
            if flag:
                m['doff'] = r.o; r.o += 24 * m['nv']
        lods.append({'deform': flag, 'materials': mats})
    out['lods'] = lods
    out['end'] = r.o
    out['size'] = len(d)
    out['_data'] = d
    return out


def strip_to_tris(idx):
    """D3DPT_TRIANGLESTRIP (prim 5) -> triangle list, degenerates dropped, odd triangles re-wound."""
    tris = []
    for i in range(len(idx) - 2):
        a, b, c = idx[i], idx[i + 1], idx[i + 2]
        if a == b or b == c or a == c:
            continue
        tris.append((a, b, c) if i % 2 == 0 else (b, a, c))
    return tris


def cm_arrays(cm: dict, lod: int, mi: int):
    """numpy arrays for one material: dict(pos, normal, color(u8 RGBA), uv0, uv1, uv2, tris, dpos, dnormal)."""
    import numpy as np
    m = cm['lods'][lod]['materials'][mi]
    d = cm['_data']
    lay = vertex_layout(m['fmt'])
    assert lay['stride'] == m['stride'], (cm['path'], m['fmt'], m['stride'])
    raw = np.frombuffer(d, dtype=np.uint8, count=m['nv'] * m['stride'], offset=m['voff']).reshape(m['nv'], m['stride'])

    def f(name, n):
        if name not in lay:
            return None
        o = lay[name]
        return raw[:, o:o + 4 * n].copy().view(np.float32).reshape(m['nv'], n)
    out = {'pos': f('pos', 3), 'normal': f('normal', 3), 'uv0': f('uv0', 2), 'uv1': f('uv1', 2), 'uv2': f('uv2', 2)}
    if 'color' in lay:
        o = lay['color']
        bgra = raw[:, o:o + 4]
        out['color'] = bgra[:, [2, 1, 0, 3]].copy()  # D3DCOLOR is BGRA in memory -> RGBA
    else:
        out['color'] = None
    idx = list(struct.unpack_from('<%dH' % m['ni'], d, m['ioff']))
    if m['prim'] == 5:
        tris = strip_to_tris(idx)
    elif m['prim'] == 4:
        tris = [tuple(idx[i:i + 3]) for i in range(0, len(idx) - 2, 3)]
    else:
        raise ValueError('prim %d' % m['prim'])
    out['tris'] = np.array(tris, dtype=np.int32).reshape(-1, 3)
    out['maxIndex'] = max(idx) if idx else -1
    if 'doff' in m:
        dd = np.frombuffer(d, dtype=np.float32, count=m['nv'] * 6, offset=m['doff']).reshape(m['nv'], 6)
        out['dpos'], out['dnormal'] = dd[:, :3].copy(), dd[:, 3:].copy()
    return out


# --------------------------------------------------------------------------------------- .rs reader
def parse_rs(path: str) -> dict:
    """Subshader file: `subshader "<name>" "<builder>" { key values; ... }` -> {name: {builder, params}}."""
    t = open(path, encoding='latin1').read()
    out = {}
    for m in re.finditer(r'subshader\s+"([^"]*)"\s+"([^"]*)"\s*\{([^}]*)\}', t):
        params = {}
        for stmt in m.group(3).split(';'):
            stmt = stmt.strip()
            if not stmt:
                continue
            k, _, v = stmt.partition(' ')
            v = v.strip()
            if v.startswith('"'):
                params[k] = v.strip('"')
            elif v in ('true', 'false'):
                params[k] = v == 'true'
            else:
                try:
                    nums = [float(x) for x in v.split()]
                    params[k] = nums[0] if len(nums) == 1 else nums
                except ValueError:
                    params[k] = v
        out[m.group(1)] = {'builder': m.group(2), 'params': params}
    return out


def subshader_for(rs: dict, name: str, multipass: bool = False) -> tuple[str | None, dict | None]:
    """Name lookup with the CarMesh builder's suffix rule [V 0x65eaa0]: while reading the .rs, a subshader
    named "X_SP" is registered as "X" when builder+0x24e == 0 (the default, init 0x66081e); "X_MP" when it
    is 1. So the mesh material "Window" binds Window_SP by default."""
    if name in rs:
        return name, rs[name]
    suf = '_MP' if multipass else '_SP'
    if name + suf in rs:
        return name + suf, rs[name + suf]
    return None, None


# --------------------------------------------------------------------------------------- .con executor
def _vec(s: str):
    try:
        return [float(x) for x in re.split(r'[/\\]', s)]
    except ValueError:
        return s


class ConDB:
    """Minimal Refractor console-script executor: ObjectTemplate / GeometryTemplate registries."""

    def __init__(self, in_menu: bool = False):
        self.obj: dict[str, dict] = {}
        self.geo: dict[str, dict] = {}
        self.cur = None
        self.curgeo = None
        self.files: list[str] = []
        self.missing: list[str] = []
        self.vars = {'v_inMenu': 1 if in_menu else 0}
        self.order: list[str] = []

    def run(self, path: str):
        if path is None:
            return
        self.files.append(path)
        lines = open(path, encoding='latin1').read().splitlines()
        stack = []  # if-stack of booleans

        def active():
            return all(stack)
        for ln in lines:
            s = ln.strip()
            if not s or s.lower().startswith('rem'):
                continue
            tok = s.split()
            head = tok[0]
            hl = head.lower()
            if hl == 'if':
                cond = False
                if len(tok) == 2:
                    cond = tok[1] not in ('0', 'false')
                elif len(tok) >= 4 and tok[2] == '=':
                    cond = str(self.vars.get(tok[1], 0)) == tok[3]
                stack.append(cond)
                continue
            if hl == 'else':
                stack[-1] = not stack[-1]
                continue
            if hl == 'endif':
                stack.pop()
                continue
            if not active():
                continue
            if hl == 'var':
                self.vars.setdefault(tok[1], 0)
                continue
            if hl == 'game.statemenu':
                if '->' in tok:
                    self.vars[tok[tok.index('->') + 1]] = self.vars['v_inMenu']
                continue
            if hl == 'run':
                p = resolve_script(tok[1])
                if p is None:
                    self.missing.append('script:' + tok[1])
                else:
                    self.run(p)
                continue
            if hl.startswith('geometrytemplate.'):
                cmd = head.split('.', 1)[1]
                if cmd == 'create':
                    self.curgeo = {'type': tok[1], 'name': tok[2], 'src': rel(path)}
                    self.geo[tok[2]] = self.curgeo
                elif self.curgeo is not None:
                    self.curgeo[cmd] = ' '.join(tok[1:])
                continue
            if hl.startswith('objecttemplate.'):
                cmd = head.split('.', 1)[1]
                args = tok[1:]
                if cmd == 'create':
                    self.cur = {'type': args[0], 'name': args[1], 'props': {}, 'children': [], 'src': rel(path)}
                    self.obj[args[1]] = self.cur
                    self.order.append(args[1])
                    continue
                if self.cur is None:
                    continue
                if cmd == 'addTemplate':
                    self.cur['children'].append({'template': args[0], 'pos': [0.0, 0.0, 0.0], 'rot': [0.0, 0.0, 0.0],
                                                 'props': {}, 'src': rel(path)})
                    continue
                if cmd in ('setPosition', 'setRotation') and self.cur['children']:
                    self.cur['children'][-1]['pos' if cmd == 'setPosition' else 'rot'] = _vec(args[0])
                    continue
                if cmd.startswith('fx_') and self.cur['children']:
                    self.cur['children'][-1]['props'][cmd] = args
                    continue
                key = cmd[0].lower() + cmd[1:]
                val = args[0] if len(args) == 1 else args
                if isinstance(val, str):
                    v2 = _vec(val)
                    val = v2[0] if isinstance(v2, list) and len(v2) == 1 else v2
                if key in ('setCamPosition', 'setGearRatio', 'setGearSpeed', 'loadSoundScript') or key in self.cur['props'] and key.startswith('set'):
                    self.cur['props'].setdefault(key, []).append(args)
                else:
                    self.cur['props'][key] = val
                continue
            # other console commands are ignored (none in car scripts besides the above)


# --------------------------------------------------------------------------------------- locale / menu
def load_locale(path: str = LOCALE) -> dict[int, str]:
    """LSBL string table: 'LSBL', u32[8] header, then (u16 id, u32 charOffset) entries up to id 0xffff,
    then NUL-terminated UTF-16LE strings; offsets are in UTF-16 units from the end of the table [E]."""
    d = open(path, 'rb').read()
    assert d[:4] == b'LSBL'
    o, ents = 0x24, []
    while True:
        i, off = struct.unpack_from('<HI', d, o); o += 6
        ents.append((i, off))
        if i == 0xffff:
            break
    out = {}
    for i, off in ents[:-1]:
        s = o + 2 * off; e = s
        while d[e:e + 2] != b'\0\0':
            e += 2
        out[i] = d[s:e].decode('utf-16-le')
    return out


def menu_car(car: str, loc: dict[int, str]) -> dict | None:
    """Menu/menu/Car/<Car>: MemeFile 2.0 (689 bytes for 28 cars, 651 for Peugeot206 [E]). Holds three
    RallySlider2 bar values (each a FloatData followed by min 0, max 1, step 0.0385) and two LocaleStringData
    ids (spec lines "hp/Nm", "kg/drive/gears"); the car name is the locale id just before them [E].
    Pattern-based extraction (no full meme parser): bar = f32 before b'\\0'*6+'\\x80?<\\x88\\x1d=';
    ids = the first pair (v, v+1) of u32 where locale[v] holds ' hp' and locale[v+1] holds ' kg'."""
    p = ci_path(MENU_CAR, car)
    if not p or not os.path.isfile(p):
        return None
    d = open(p, 'rb').read()
    pat = b'\x00\x00\x00\x00\x00\x00\x80\x3f\x3c\x88\x1d\x3d'
    sliders, o = [], d.find(pat)
    while o >= 0:
        sliders.append(round(struct.unpack_from('<f', d, o - 4)[0], 4))
        o = d.find(pat, o + 1)
    ids = None
    for o1 in range(len(d) - 4):
        v = struct.unpack_from('<I', d, o1)[0]
        if v - 1 in loc and ' hp' in loc.get(v, '') and ' kg' in loc.get(v + 1, ''):
            for o2 in range(o1 + 4, len(d) - 4):
                if struct.unpack_from('<I', d, o2)[0] == v + 1:
                    ids = [v, v + 1]
                    break
        if ids:
            break
    if ids is None:
        return {'file': rel(p), 'error': 'no locale ids', 'sliders': sliders}
    name_id = ids[0] - 1
    return {'file': rel(p), 'sliders': sliders, 'specIds': ids, 'nameId': name_id,
            'name': loc.get(name_id), 'specs': [loc.get(i) for i in ids]}


SHORT_NAMES = {  # LocaleEnglish ids 756-785 (results / HUD short names), matched to archive folders [E by text]
    'Micra': 756, 'Beetle': 757, 'Corolla': 758, 'Peugeot306': 759, 'LancerEVO': 760, 'ImprezaWRX': 761,
    'FordFocusCosworth': 762, 'Peugeot206': 763, 'CitroenXsaraRC': 764, 'Saab93': 765, 'Astra': 766,
    'FordFocus': 767, 'NissanSkyline': 768, 'DeltaIntergrale': 769, 'ImprezaHC': 770, 'Lancer': 771,
    'AudiS1': 772, 'Metro6R4': 773, 'Peugeot205': 774, 'DeltaS4': 775, 'ToyotaTacoma': 776, 'Escudo': 777,
    'AudiS1HC': 778, 'Peugeot405': 779, 'CitroenXsara': 780, 'FordEscort': 781, 'Renault5': 783,
    'FordRS200': 784, 'SaabViggen': 785,
}


# --------------------------------------------------------------------------------------- hull (.col)
def parse_col(path: str) -> dict:
    """Hull point file: n, n lines 'x y z', m, m lines of 4 point indices (faces) [E]."""
    toks = open(path, encoding='latin1').read().split()
    i = 0
    n = int(toks[i]); i += 1
    pts = [[float(toks[i + 3 * k + j]) for j in range(3)] for k in range(n)]
    i += 3 * n
    faces = []
    if i < len(toks):
        m = int(toks[i]); i += 1
        faces = [[int(toks[i + 4 * k + j]) for j in range(4)] for k in range(m)]
        i += 4 * m
    return {'points': pts, 'faces': faces, 'leftoverTokens': len(toks) - i}


# --------------------------------------------------------------------------------------- assembly
WHEEL_ORDER = ['FrontLeft', 'FrontRight', 'RearRight', 'RearLeft']   # 0 FL, 1 FR, 2 RR, 3 RL [V FUN_006c6810]
GRAVITY = 12.0  # m/s^2 (docs/MECHANICS_SPEC.md §1)
# FUN_006c8ef0 local tables (verifier): 7-entry camber table (x0.25 at use), 17-entry front / 11-entry rear toe.
CAMBER_TABLE = [0.0, 0.017, 0.033, 0.05, 0.067, 0.083, 0.1]
TOE_TABLE_F = [round(-0.08 + 0.01 * i, 2) for i in range(17)]
TOE_TABLE_R = [round(-0.05 + 0.01 * i, 2) for i in range(11)]


def num(v, default=None):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, list) and v and isinstance(v[0], (int, float)):
        return float(v[0])
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def static_ext(spring_k: float, spring_len: float, load: float) -> float:
    """Rest extension x of a wheel from Fs = k*L*e*(1+e/2) = load (docs §2.5.3, setup.suspension = 1)."""
    c = load / (spring_k * spring_len)
    e = -1 + math.sqrt(1 + 2 * c)
    return 1 - e


_cm_cache: dict[str, dict] = {}
_rs_cache: dict[str, dict] = {}


def get_cm(p):
    if p not in _cm_cache:
        _cm_cache[p] = parse_cm(p)
    return _cm_cache[p]


def get_rs(p):
    if p not in _rs_cache:
        _rs_cache[p] = parse_rs(p)
    return _rs_cache[p]


def describe_mesh(file_ref: str, lod_dir: str | None, missing: list) -> dict | None:
    """Resolve one CarMesh geometry file at one LOD set; materials -> subshader -> texture."""
    ref = file_ref
    if lod_dir and lod_dir != 'Cars':
        ref = re.sub(r'(?i)^mesh/cars/', 'Mesh/%s/' % lod_dir, file_ref)
    p = resolve_mesh(ref, '.cm')
    if p is None:
        return None
    cm = get_cm(p)
    desc = {'file': rel(p), 'version': cm['version'], 'bbox': [round(x, 4) for x in cm['bbox']],
            'consumed': cm['end'], 'size': cm['size'], 'lods': []}
    for li, lod in enumerate(cm['lods']):
        mats = []
        for m in lod['materials']:
            shader_path = m['name'].lstrip('/').rsplit('/', 1)
            sub = shader_path[1] if len(shader_path) == 2 else m['name']
            rs_ref = shader_path[0]
            if lod_dir and lod_dir != 'Cars':  # shaders follow the same Mesh/Cars -> Mesh/Cars_N rewrite [V 0x655110]
                rs_ref2 = re.sub(r'(?i)^mesh/cars/', 'Mesh/%s/' % lod_dir, rs_ref)
            else:
                rs_ref2 = rs_ref
            rsp = ci_path(MISC, rs_ref2 + '.rs') or ci_path(MISC, rs_ref + '.rs')
            entry = {'material': sub, 'shaderFile': rel(rsp), 'prim': m['prim'], 'fmt': hex(m['fmt']),
                     'stride': m['stride'], 'nv': m['nv'], 'ni': m['ni'], 'group': m['group'],
                     'deform': bool(lod['deform'])}
            if m['f3c']:
                entry['f3c'] = m['f3c']
            if rsp is None:
                missing.append('shader:' + rs_ref2 + '.rs')
            else:
                rs = get_rs(rsp)
                sname, ss = subshader_for(rs, sub)
                if ss is None:
                    entry['subshader'] = None   # e.g. 'lambert1': no subshader -> builder default [?]
                else:
                    entry['subshader'] = sname
                    entry['builder'] = ss['builder']
                    entry['params'] = ss['params']
                    tex = ss['params'].get('texture')
                    if tex:
                        tp = resolve_texture(tex)
                        entry['texture'] = tex
                        entry['textureFile'] = rel(tp)
                        if tp is None:
                            missing.append('texture:' + tex)
            mats.append(entry)
        desc['lods'].append({'deform': bool(lod['deform']), 'materials': mats})
    return desc


def assemble_car(car: str, loc: dict, shared_menu: bool = False) -> dict:
    cdir = os.path.join(CARS, car)
    missing: list[str] = []
    db = ConDB(in_menu=False)
    for s in ('Cars/cars/Wheels.con',):
        db.run(os.path.join(FULL, 'Cars', 'cars', 'Wheels.con'))
    db.run(resolve_script('object/Driver.con'))
    db.run(resolve_script('object/CarCommon.con'))
    db.run(resolve_script('object/CarFX_Pipe.con'))
    # FUN_00491ce0: Cars/<Car>/Geom, Cars/<Car>/Templates, then Cars/<Car>/Player (or /AI)
    db.run(resolve_script('Cars/%s/Geom' % car))
    db.run(resolve_script('Cars/%s/Templates' % car))
    db.run(resolve_script('Cars/%s/Player' % car))
    db.run(resolve_script('Cars/%s/AI' % car))
    db.run(resolve_script('Cars/%s/Ghost' % car))
    missing += db.missing
    menu = ConDB(in_menu=True)   # FUN_0060b6d0: TemplatesMenu + Ghost in the menu
    menu.run(os.path.join(FULL, 'Cars', 'cars', 'Wheels.con'))
    menu.run(resolve_script('object/Driver.con'))
    menu.run(resolve_script('Cars/%s/Geom' % car))
    menu.run(resolve_script('Cars/%s/TemplatesMenu' % car))
    menu.run(resolve_script('Cars/%s/Player' % car))

    player = db.obj.get(car)
    out: dict = {'car': car, 'scripts': sorted({rel(f) for f in db.files})}
    P = player['props'] if player else {}
    phys = {k: P.get(k) for k in ('car_Mass', 'car_WheelRadius', 'car_WheelWidth', 'car_WheelScale', 'car_Inertia',
                                   'car_RollCenterY', 'car_ColPointFile', 'car_NColPoints', 'car_WheelDrive',
                                   'car_DriverLeftHandPos', 'car_DriverRightHandPos',
                                   'car_DriverHandsRotationalHeight', 'car_CoDriverLeftHandPos',
                                   'car_CoDriverRightHandPos', 'carsetup_ToeFront', 'carsetup_ToeRear',
                                   'carsetup_CamberFront', 'carsetup_CamberRear')}
    out['physics'] = phys
    R = num(P.get('car_WheelRadius'), 0.3)
    mass = num(P.get('car_Mass'), 1000)

    # ---- children of the RallyCar (Player.con)
    kids = player['children'] if player else []
    parts, wheels, drivers, others, bursts, flares = [], [], [], [], [], []
    for ch in kids:
        t = db.obj.get(ch['template'])
        typ = t['type'] if t else None
        if typ == 'CarWheelBundle':
            wheels.append((ch, t))
        elif typ == 'SimpleObject':
            parts.append((ch, t))
        elif typ == 'DriverObject':
            drivers.append((ch, t))
        elif ch['template'] in ('CarFX_Pipe', 'CarFX_GearPipe') or ch['template'].startswith('e_ExFume'):
            bursts.append(ch)
        elif ch['template'].startswith('CarFlare'):
            flares.append(ch)
        else:
            others.append(ch)

    # ---- body parts at every LOD
    out['parts'] = []
    for ch, t in parts:
        g = db.geo.get(t['props'].get('geometry'))
        e = {'template': t['name'], 'role': 'body' if t['name'].lower().endswith('body') else
             'interior' if t['name'].lower().endswith('interior') else 'part',
             'geometry': t['props'].get('geometry'), 'pos': ch['pos'], 'rot': ch['rot']}
        if g is None:
            missing.append('geometry:%s' % t['props'].get('geometry'))
        else:
            e['geomType'] = g['type']
            e['file'] = g.get('file')
            e['lodSets'] = {}
            for ld in LOD_DIRS:
                dsc = describe_mesh(g['file'], ld, missing)
                e['lodSets'][ld] = dsc
            if e['lodSets']['Cars'] is None:
                missing.append('mesh:' + g['file'] + '.cm')
            # BodyShadow.sm (shadow-volume mesh, pos-only, StandardMesh v7) next to Body
            sh = resolve_mesh(g['file'] + 'Shadow', '.sm')
            if sh:
                e['shadowMesh'] = rel(sh)
        out['parts'].append(e)

    # ---- wheels
    out['wheels'] = []
    zs = {}
    for wi, (ch, bt) in enumerate(wheels):
        wch = bt['children'][0] if bt['children'] else None
        wt = db.obj.get(wch['template']) if wch else None
        pos = wch['pos'] if wch else None
        rot = wch['rot'] if wch else None
        name = wt['name'] if wt else None
        idx = next((i for i, k in enumerate(WHEEL_ORDER) if name and name.endswith(k)), wi)
        wp = wt['props'] if wt else {}
        geoms = {}
        for k in ('geometry', 'tarmacGeometry', 'gravelGeometry'):
            gname = wp.get(k)
            g = db.geo.get(gname)
            if g is None:
                geoms[k] = {'name': gname, 'defined': False}
                if k != 'geometry':
                    missing.append('wheelGeometry:%s' % gname)
                continue
            dsc = describe_mesh(g['file'], None, missing)
            if dsc is None:
                missing.append('mesh:' + g['file'] + '.cm')
            geoms[k] = {'name': gname, 'defined': True, 'file': g['file'], 'mesh': dsc,
                        'shadowMesh': rel(resolve_mesh(g['file'] + 'Shadow', '.sm'))}
        # physics params of this wheel (PhysicsWheelFront/Rear run inside the CarWheel template)
        wph = {k: num(v) for k, v in wp.items() if k.startswith('wheel_') and k != 'wheel_WheelBasePos'}
        e = {'index': idx, 'name': name, 'bundle': bt['name'], 'pos': pos, 'rot': rot,
             'wheelBasePos': wp.get('wheel_WheelBasePos'), 'geoms': geoms, 'physics': wph}
        if isinstance(pos, list):
            e['mount'] = [pos[0], round(pos[1] - R, 6), pos[2]]   # FUN_006c6810: y -= WheelRadius
            zs[idx] = pos[2]
        out['wheels'].append(e)
    out['wheels'].sort(key=lambda w: w['index'])
    # visual camber / toe per wheel [V FUN_006c8ef0, verifier 2026-10-29; see cars.md §4.2]:
    #   camber (roll about the body z axis) = CAMBER_TABLE[carsetup_Camber*] * 0.25, sign +right/-left
    #   toe (yaw, added to steer)           = TOE_TABLE_F/R[carsetup_Toe*], sign +right/-left
    #   table index == raw carsetup value (setup struct +0x34 ToeF, +0x38 ToeR, +0x3c CamberF, +0x40 CamberR).
    for w in out['wheels']:
        front = w['index'] < 2
        right = w['index'] in (1, 2)
        sgn = 1.0 if right else -1.0
        ci = num(P.get('carsetup_CamberFront' if front else 'carsetup_CamberRear'))
        ti = num(P.get('carsetup_ToeFront' if front else 'carsetup_ToeRear'))
        vis = {'cornerSign': sgn}
        if ci is not None and 0 <= int(ci) < len(CAMBER_TABLE):
            vis['camberRad'] = round(sgn * CAMBER_TABLE[int(ci)] * 0.25, 6)
        tt = TOE_TABLE_F if front else TOE_TABLE_R
        if ti is not None and 0 <= int(ti) < len(tt):
            vis['toeRad'] = round(sgn * tt[int(ti)], 6)
        w['visual'] = vis
    # rest pose (flat ground, no sink, no load transfer): per-axle static load split by the lever arms
    if len(zs) == 4:
        zf, zr = zs[0], zs[3]
        for w in out['wheels']:
            front = w['index'] < 2
            share = (abs(zr) if front else abs(zf)) / (zf - zr) / 2
            load = mass * GRAVITY * share
            k = w['physics'].get('wheel_SpringK'); L = w['physics'].get('wheel_SpringLength')
            if k and L:
                x = static_ext(k, L, load)
                xv = max(0.85, x)   # FUN_006c8ef0 clamps the visual extension at >= 0.85
                y = w['pos'][1]
                w['rest'] = {'load': round(load, 1), 'ext': round(x, 4), 'visualExt': round(xv, 4),
                             'contactY': round(y - R - x * L, 4),
                             'centreY': round(y - xv * L, 4)}
    # ---- drivers
    out['drivers'] = []
    for ch, t in drivers:
        g = db.geo.get(t['props'].get('geometry'))
        sm = resolve_mesh(g['file'], '.sm') if g else None
        skn = ci_path(MISC, g.get('setSkin', '')) if g and g.get('setSkin') else None
        ske = ci_path(MISC, t['props'].get('createSkeleton', '')) if t['props'].get('createSkeleton') else None
        if g is None or sm is None:
            missing.append('driverMesh:%s' % t['props'].get('geometry'))
        if skn is None or ske is None:
            missing.append('driverSkin/Skeleton')
        out['drivers'].append({'template': t['name'], 'role': 'codriver' if 'codriver' in t['name'].lower() else 'driver',
                               'pos': ch['pos'], 'rot': ch['rot'], 'geometry': t['props'].get('geometry'),
                               'mesh': rel(sm), 'skin': rel(skn), 'skeleton': rel(ske),
                               'characterHeight': num(t['props'].get('setCharacterHeight')),
                               'shake': {k: num(v) for k, v in t['props'].items() if 'hake' in k}})
    # ---- camera, exhaust bursts, lens flares, other
    cam = next((db.obj[c['template']] for c in kids if db.obj.get(c['template'], {}).get('type') == 'CarCamera'), None)
    camch = next((c for c in kids if db.obj.get(c['template'], {}).get('type') == 'CarCamera'), None)
    if cam:
        cps = []
        for a in cam['props'].get('setCamPosition', []):
            cps.append({'i': int(a[0]), 'a': int(a[1]), 'b': int(a[2]), 'pos': _vec(a[3]), 'target': _vec(a[4]),
                        'param': _vec(a[5])})
        out['camera'] = {'template': cam['name'], 'pos': camch['pos'], 'positions': cps}
    out['exhaust'] = [{'template': b['template'], 'pos': b['pos'], 'rot': b['rot']} for b in bursts]
    out['lensflares'] = [{'template': f['template'], 'pos': f['pos'], 'rot': f['rot']} for f in flares]
    out['lensflaresActive'] = bool(flares)
    lf = resolve_script('Cars/%s/Lensflares' % car)
    if lf and not flares:   # file present but `rem run` in Player.con: record the (inactive) positions
        tmp = ConDB(); tmp.cur = {'type': 'tmp', 'name': 'tmp', 'props': {}, 'children': []}
        tmp.run(lf)
        out['lensflaresInactive'] = [{'template': c['template'], 'pos': c['pos'], 'rot': c['rot']} for c in tmp.cur['children']]
    out['otherChildren'] = [{'template': c['template'], 'pos': c['pos'], 'rot': c['rot']} for c in others]
    # ---- menu variant (TemplatesMenu.con): only differences are recorded
    mp = menu.obj.get(car)
    mdiff = []
    for name, t in menu.obj.items():
        if t['src'] and 'TemplatesMenu' in t['src'] and name in db.obj:
            a, b = db.obj[name], t
            for i, (c1, c2) in enumerate(zip(a['children'], b['children'])):
                if c1['pos'] != c2['pos'] or c1['rot'] != c2['rot']:
                    mdiff.append({'template': name, 'child': c1['template'], 'race': c1['pos'], 'menu': c2['pos']})
            for k in sorted(set(a['props']) | set(b['props'])):   # sorted: deterministic dump (verifier fix)
                if a['props'].get(k) != b['props'].get(k):
                    mdiff.append({'template': name, 'prop': k, 'race': a['props'].get(k), 'menu': b['props'].get(k)})
    out['menuDiff'] = mdiff
    # ---- ghost car (Ghost.con): same parts, rendered with the Car/Ghost shader (Misc/shaders/Car/Ghost.rs)
    gh = db.obj.get(car + 'Ghost')
    out['ghost'] = {'template': car + 'Ghost', 'children': [c['template'] for c in gh['children']] if gh else None}
    # ---- hull, drop shadow, names
    colp = P.get('car_ColPointFile')
    if colp:
        cp = ci_path(MISC, colp)
        if cp is None:
            missing.append('col:' + colp)
        else:
            col = parse_col(cp)
            pts = col['points']
            out['hull'] = {'file': rel(cp), 'nPoints': len(pts), 'nFaces': len(col['faces']),
                           'min': [min(p[i] for p in pts) for i in range(3)],
                           'max': [max(p[i] for p in pts) for i in range(3)], 'leftoverTokens': col['leftoverTokens']}
    ds = ci_path(MISC, 'texture/Car/DropShadows/%s.tga' % car)
    out['dropShadow'] = rel(ds)
    out['dropShadowScale'] = drop_shadow_scales().get(car)   # Misc/level/DropShadows.con (Car.setDropShadowScale)
    if ds is None:
        missing.append('dropShadow:%s' % car)
    out['menu'] = menu_car(car, loc)
    if out['menu'] is None:
        missing.append('menuFrame:%s' % car)
    sid = SHORT_NAMES.get(car)
    out['shortName'] = loc.get(sid) if sid else None
    out['shortNameId'] = sid
    out['missing'] = sorted(set(missing))
    return out


_dss = None


def drop_shadow_scales() -> dict:
    """Misc/level/DropShadows.con: `Car.setDropShadowScale <Car> sx/sz/sy` [V string FUN_00438f20]."""
    global _dss
    if _dss is None:
        _dss = {}
        p = ci_path(MISC, 'level/DropShadows.con')
        for ln in open(p, encoding='latin1').read().splitlines():
            t = ln.split()
            if len(t) == 3 and t[0].lower() == 'car.setdropshadowscale':
                _dss[t[1]] = _vec(t[2])
    return _dss


def all_cars() -> list[str]:
    return sorted(n for n in os.listdir(CARS) if os.path.isdir(os.path.join(CARS, n)) and
                  os.path.isfile(os.path.join(CARS, n, 'Player.con')))


def validate_all_cm() -> dict:
    """Parse every .cm under Misc/mesh, check exact consumption, index ranges, vertex layouts, deform data."""
    import numpy as np
    res = {'files': 0, 'failed': [], 'leftover': [], 'materials': 0, 'fmts': {}, 'prims': {}, 'badIndex': 0,
           'deformFiles': 0, 'deformNormalLenDev': 0.0, 'deformMaxDisp': 0.0, 'uv2EqualsUv0': 0, 'uv2Total': 0,
           'windingVsNormals': [0, 0]}
    for p in sorted(glob.glob(os.path.join(MISC, 'mesh', '**', '*.cm'), recursive=True)):
        res['files'] += 1
        try:
            cm = parse_cm(p)
        except Exception as ex:  # noqa
            res['failed'].append([rel(p), str(ex)]); continue
        if cm['end'] != cm['size'] or cm['version'] != 8:
            res['leftover'].append([rel(p), cm['size'] - cm['end'], cm['version']])
        for li, lod in enumerate(cm['lods']):
            if lod['deform']:
                res['deformFiles'] += 1
            for mi, m in enumerate(lod['materials']):
                res['materials'] += 1
                res['fmts'][hex(m['fmt'])] = res['fmts'].get(hex(m['fmt']), 0) + 1
                res['prims'][str(m['prim'])] = res['prims'].get(str(m['prim']), 0) + 1
                a = cm_arrays(cm, li, mi)
                if a['maxIndex'] >= m['nv']:
                    res['badIndex'] += 1
                if a['uv2'] is not None:
                    res['uv2Total'] += 1
                    if np.allclose(a['uv2'], a['uv0']):
                        res['uv2EqualsUv0'] += 1
                if 'dpos' in a and len(a['dpos']):
                    nl = np.linalg.norm(a['dnormal'], axis=1)
                    res['deformNormalLenDev'] = max(res['deformNormalLenDev'], float(np.abs(nl - 1).max()))
                    res['deformMaxDisp'] = max(res['deformMaxDisp'], float(np.linalg.norm(a['dpos'] - a['pos'], axis=1).max()))
                if len(a['tris']):
                    P = a['pos']; t = a['tris']
                    fn = np.cross(P[t[:, 1]] - P[t[:, 0]], P[t[:, 2]] - P[t[:, 0]])
                    vn = a['normal'][t].sum(axis=1)
                    s = (fn * vn).sum(axis=1)
                    res['windingVsNormals'][0] += int((s < 0).sum())   # clockwise-front (D3D) in a LH frame
                    res['windingVsNormals'][1] += int((s > 0).sum())
        cm.pop('_data', None)
    return res


def assemble_all(verbose=True) -> dict:
    loc = load_locale()
    cars = all_cars()
    out = {'meta': {'generator': 'research/tools/fmt_cars.py', 'spec': 'research/formats/cars.md',
                    'frame': 'original world/body frame = rally-web SIM space (LH, x right, y up, z forward, m); '
                             'mesh origin = RallyCar origin = physics body origin (centre of mass)',
                    'wheelOrder': '0 FL, 1 FR, 2 RR, 3 RL', 'lodDirs': LOD_DIRS, 'gravity': GRAVITY},
           'cars': {}}
    for c in cars:
        out['cars'][c] = assemble_car(c, loc)
    # orphan drop shadows / textures for the record
    ds = sorted(os.path.splitext(n)[0] for n in os.listdir(os.path.join(MISC, 'texture', 'Car', 'DropShadows'))
                if n.lower().endswith('.tga'))
    out['meta']['dropShadowsWithoutCar'] = [d for d in ds if d not in cars]
    return out


def main(argv):
    outp = os.path.join(DUMPS, 'cars_dump.json')
    quiet = '--quiet' in argv
    if '--out' in argv:
        outp = argv[argv.index('--out') + 1]
    v = validate_all_cm()
    data = assemble_all()
    data['meta']['cmValidation'] = v
    nmiss = {c: d['missing'] for c, d in data['cars'].items() if d['missing']}
    data['meta']['carsWithMissingRefs'] = nmiss
    # texture coverage
    used = set()
    for c, d in data['cars'].items():
        for p in d['parts']:
            for ld, s in (p.get('lodSets') or {}).items():
                if s:
                    for lod in s['lods']:
                        for m in lod['materials']:
                            if m.get('textureFile'):
                                used.add(m['textureFile'])
        for w in d['wheels']:
            for g in w['geoms'].values():
                if g.get('mesh'):
                    for lod in g['mesh']['lods']:
                        for m in lod['materials']:
                            if m.get('textureFile'):
                                used.add(m['textureFile'])
    allt = sorted(rel(p) for p in glob.glob(os.path.join(MISC, 'texture', 'Car', '*')) if os.path.isfile(p))
    data['meta']['carTexturesReferenced'] = len(used)
    data['meta']['carTexturesUnreferenced'] = [t for t in allt if t not in used]
    # de-duplicate the shared wheel meshes into data['wheelMeshes'][file] (referenced by 'meshRef')
    wm = data.setdefault('wheelMeshes', {})
    for c, d in data['cars'].items():
        for w in d['wheels']:
            for g in w['geoms'].values():
                if g.get('mesh'):
                    wm[g['mesh']['file']] = g['mesh']
                    g['meshRef'] = g['mesh']['file']
                    del g['mesh']
    os.makedirs(os.path.dirname(outp), exist_ok=True)
    with open(outp, 'w') as f:
        json.dump(data, f, indent=None, separators=(',', ':'), default=str)
    if not quiet:
        print('cm files parsed: %d  failed: %d  leftover: %d  materials: %d  fmts: %s  prims: %s  badIndex: %d'
              % (v['files'], len(v['failed']), len(v['leftover']), v['materials'], v['fmts'], v['prims'], v['badIndex']))
        print('deform LODs: %d  max |dpos-pos| %.4f m  max | |dn|-1 | %.4g  uv2==uv0: %d/%d  winding(cw-front, ccw): %s'
              % (v['deformFiles'], v['deformMaxDisp'], v['deformNormalLenDev'], v['uv2EqualsUv0'], v['uv2Total'],
                 v['windingVsNormals']))
        print('cars: %d  with missing refs: %d %s' % (len(data['cars']), len(nmiss), json.dumps(nmiss)[:2000]))
        print('car textures referenced: %d, unreferenced in texture/Car: %d' % (len(used), len(data['meta']['carTexturesUnreferenced'])))
        print('wrote', rel(outp))
    return data


if __name__ == '__main__':
    main(sys.argv[1:])
