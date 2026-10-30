"""objects -- every placed object of a stage (trees, bushes, rocks, buildings, signs, fences, spectators, Kuliss
backdrops), converted for src/render/orig/objects.ts.

Spec: research/formats/objects.md (+ Verification), research/formats/standardmesh.md (+ Verification),
environment.md §3.5 / §3.6, docs/orig/objects.md (this port's decisions and deviations).

What the release game does (objects.md §1.1 Verification): `MergeMesh.enable` is never set and the MergeMesh class
is not even registered, so every placement comes from **Objects.con** (authoritative; the .dat files are caches).
Mergeable grass and sideScreen (Kuliss) templates are therefore ordinary TreeMesh objects, drawn by the tree pass.
Billboard trees (`billboard 1`) also get their impostor atlas `Billboards/<geometry>.dds` (n frames side by side) and
the quad extents of the template ctor (0x57b677–0x57b71c): half width W = max |bbox x/z| over both corners, height
h = bbox.max.y − bbox.min.y, base offset bbox.min.y (docs/orig/objects.md §Billboards).

Output (stages/<id>/):
  objects.bin   little-endian, 4-byte aligned sections (offsets in bytes, referenced from objects.json):
                * StandardMesh / AnimatedMesh LOD vertices: f32 x 8 per vertex (pos.xyz, normal.xyz, uv) THREE space
                * TreeMesh vertices: f32 x 10 (pos.xyz, normal.xyz, uv, spriteOffset.xy) THREE space
                * indices (u16 when the vertex count fits, else u32), triangle winding swapped for the z mirror
                * instances: f32 x INST_STRIDE per placement (see INST_* below)
  objects.json  {version, stage, settings, hotspots, meshes, templates, stats}  (written LAST)

Frames: Objects.con positions are in the object WORLD frame: sim = world - (2048, H, 2048); three = sim with z
negated (objects.md §1.3, §8 Verification: M_three = F·(diag(s)·R)ᵀ·F, F = diag(1, 1, -1)). Mesh vertices are in
the sim frame (z -> -z here, two indices of every triangle swapped); AnimatedMesh vertices are in the 3ds-Max
Biped frame (z up, standardmesh.md §2.4): sim = (x, z, y), three = (x, z, -y) (bind pose, see docs/orig/objects.md).
"""
import math
import os
import re
import struct
from collections import OrderedDict

import numpy as np

PART = 'objects'
VERSION = 2

# Instance record (f32 each), one per Objects.con placement, in Objects.con order within a template.
#   0..11  3x4 world matrix in THREE space, row-major: row i = (L[i][0], L[i][1], L[i][2], t[i])
#  12..14  colour Q: TreeMesh = float32(floor(255·c))·float32(1/255) (default byte 127, objects.md §2.2),
#          other geometry = 0.5 (never coloured; the StandardMesh TFACTOR is FF FF FF, standardmesh.md §2.5)
#  15      shadowFactor (Object.geometry.shadowFactor, default 0)
#  16..17  SIM local +Z axis projected on xz, normalised (tree sort variant, standardmesh.md §3 FUN_00591e30)
#  18..19  SIM local +X axis on xz (only the sign of dot(d, X) is used)
#  20      bounding radius r of the scaled mesh bbox (radiusFromOrigin; ObjectDrawer node radius, LOD radius)
#  21      max(scale) (StandardMesh LOD: e = S·d²/maxScale - r², standardmesh.md §2.5)
#  22      per-object random in [0, 1) (ObjectDrawer node+0x18 · objectDistanceVariation)
#  23      reserved (0)
INST_STRIDE = 24

TREE_COLOUR_DEFAULT_BYTE = 127          # tree instance ctor FUN_0058ff80: inst+0x4c = 7F 7F 7F FF
F32_INV255 = float(np.float32(0.003921569))   # the engine's byte -> float constant (objects.md §2.2)

# Engine defaults the stage scripts may leave unset (environment.md §V2 FUN_0040e650, ObjectDrawer statics).
DEFAULTS = {
    'viewDistance': 300.0,             # Object.viewDistance
    'distanceFade': 0.75,              # Object.distanceFade
    'cullFade': 0.75,                  # object.cullFade
    'cullConst': 15.0,                 # ObjectDrawer.distanceCullConst: .data 0x85b378 = 15.0
    'minCullDistance': 75.0,           # ObjectDrawer.minCullDistance: 0x6f2360 stores 5625 = 75² into 0x936958
    'variation': 0.0,                  # objectDistanceVariation (0x936988, bss)
    'billboardLODScale': 1.0,
    'billboardFadeScale': 0.0,
    'mergeMeshViewDistance': 0.0,
    'lodDistanceScale': 1.0,           # standardMesh.lodDistanceScale
    'billboardLightScale': 0.5,        # treeMesh.billboardLightScale (settings+0xa0, default @0x571ae5)
    'constantLightScale': 0.5,         # treeMesh.constantLightScale  (settings+0xa4, default @0x571b63)
}
# HotSpot field -> settings key (HotSpot struct order: FUN_004e13d0 printers, applied at 0x49c7c4..0x49c8c1)
HOTSPOT_FIELDS = {
    'objectViewDistance': 'viewDistance', 'objectDistanceFade': 'distanceFade', 'objectCullFade': 'cullFade',
    'objectCullConst': 'cullConst', 'objectMinCullDistance': 'minCullDistance',
    'objectDistanceVariation': 'variation', 'billboardLODScale': 'billboardLODScale',
    'billboardFadeScale': 'billboardFadeScale', 'mergeMeshViewDistance': 'mergeMeshViewDistance',
}

_PROC = {}            # per worker process: library, parsed meshes


# ------------------------------------------------------------------------------------------------- helpers
def _lib():
    if 'lib' not in _PROC:
        import fmt_objects as O
        vfs = O.Vfs()
        lib = O.load_library(vfs)
        _PROC['lib'] = (O, vfs, lib)
    return _PROC['lib']


def _env_settings(stage):
    """Resolved environment scripts of the stage (fmt_environment, the verified interpreter)."""
    import fmt_environment as E
    if 'cmds' not in _PROC:
        _PROC['cmds'] = E.load_cmds()
    st = next((s for s in E.stages() if s['id'] == stage.id), None)
    if st is None:
        return None
    return E.resolve_stage(_PROC['cmds'], st)['env']


def _flag(v, default):
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, (list, tuple)):
        v = v[0] if v else None
        if v is None:
            return default
    s = str(v).strip().lower()
    if s in ('true', 'false'):
        return s == 'true'
    try:
        return float(s) != 0.0
    except ValueError:
        return default


def _num(v, lib, default=None):
    """'60' / 'c_loddist' (library const) -> float."""
    if v is None:
        return default
    if isinstance(v, (list, tuple)):
        v = v[0] if v else None
    if v is None:
        return default
    s = str(v).strip()
    for _ in range(4):
        try:
            return float(s)
        except ValueError:
            c = lib.consts.get(s.lower())
            if c is None:
                return default
            s = str(c)
    return default


def _vec3(v):
    if v is None:
        return None
    if isinstance(v, (list, tuple)) and v and isinstance(v[0], (int, float)):
        out = [float(x) for x in v][:3]
    else:
        s = v[0] if isinstance(v, (list, tuple)) else v
        out = [float(x) for x in str(s).split('/') if x != '']
    if not out:
        return None
    while len(out) < 3:              # Vec args repeat the last value (environment.md §0.7, 0x433100)
        out.append(out[-1])
    return out[:3]


def _rot_rows(yaw, pitch, roll):
    """Row-vector R = Rz(roll)·Rx(pitch)·Ry(yaw), degrees (objects.md §1.3, FUN_0049d9a0)."""
    a, b, c = (math.radians(x) for x in (yaw, pitch, roll))
    ca, sa, cb, sb, cc, sc = math.cos(a), math.sin(a), math.cos(b), math.sin(b), math.cos(c), math.sin(c)
    ry = np.array([[ca, 0, -sa], [0, 1, 0], [sa, 0, ca]])
    rx = np.array([[1, 0, 0], [0, cb, sb], [0, -sb, cb]])
    rz = np.array([[cc, sc, 0], [-sc, cc, 0], [0, 0, 1]])
    return rz @ rx @ ry


def _bbox_radius(bmin, bmax, scale=(1.0, 1.0, 1.0)):
    """radiusFromOrigin of the (scaled) bbox = max corner distance from the local origin (FUN_005b8620)."""
    r2 = 0.0
    for x in (bmin[0], bmax[0]):
        for y in (bmin[1], bmax[1]):
            for z in (bmin[2], bmax[2]):
                r2 = max(r2, (x * scale[0]) ** 2 + (y * scale[1]) ** 2 + (z * scale[2]) ** 2)
    return math.sqrt(r2)


class Bin:
    """objects.bin builder: 4-byte aligned sections."""

    def __init__(self):
        self.parts = []
        self.size = 0

    def add(self, arr):
        b = np.ascontiguousarray(arr).tobytes()
        off = self.size
        self.parts.append(b)
        self.size += len(b)
        pad = (-self.size) % 4
        if pad:
            self.parts.append(b'\0' * pad)
            self.size += pad
        return off

    def bytes(self):
        return b''.join(self.parts)


def _index_array(idx, nverts):
    return np.asarray(idx, np.uint16 if nverts <= 65535 else np.uint32)


def _winding_agreement(pos, nrm, tris):
    """Fraction of triangles (three space, after the swap) whose CCW face normal agrees with the stored normals."""
    if len(tris) == 0:
        return 1.0
    a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    fn = np.cross(b - a, c - a)
    vn = nrm[tris[:, 0]] + nrm[tris[:, 1]] + nrm[tris[:, 2]]
    d = np.einsum('ij,ij->i', fn, vn)
    ok = np.isfinite(d) & (np.abs(d) > 1e-12)
    if not ok.any():
        return 1.0
    return float((d[ok] > 0).mean())


# ------------------------------------------------------------------------------------------------- meshes
def _resolve_tex(ctx, name, missing):
    """Engine texture name -> texId (stage Texture/ shadows Misc, BMP<DDS<RCM<RTX<TGA; docs/ASSETS.md §5)."""
    if not name:
        return None
    n = name.strip()
    while n.endswith('.'):           # stray trailing '.' in two .tm files (standardmesh.md §3)
        n = n[:-1]
    if not n:
        return None
    tid = ctx.textures.use(n)
    if tid is None:
        missing.add(n)
    return tid


def _rs_blocks(ctx, sm_vpath):
    import fmt_standardmesh as S
    rs = sm_vpath[:-3] + '.rs'
    if not ctx.vfs.exists(rs):
        return {}
    out = {}
    for blk in S.parse_rs(ctx.vfs.read(rs)):
        props = {k.lower(): v for k, v in blk['props']}
        out[blk['name'].lower()] = props
    return out


def build_sm(ctx, vpath, animated, binw, missing):
    """StandardMesh / AnimatedMesh .sm -> mesh entry (+ per-material default texture names)."""
    import fmt_standardmesh as S
    sm = S.parse_sm(ctx.vfs.read(vpath))
    rs = _rs_blocks(ctx, vpath)
    lods = []
    agree = []
    for li, mats in enumerate(sm['lods']):
        P, N, U, I, groups = [], [], [], [], []
        base = 0
        icount = 0
        for mi, m in enumerate(mats):
            if not m['name']:
                continue                  # car/wheel shadow meshes (standardmesh.md §8)
            stride, layout = S.fvf_layout(m['vertexFormat'])
            if stride != m['stride'] or m['vertexCount'] == 0:
                continue
            raw = np.frombuffer(m['vb'], np.float32).reshape(m['vertexCount'], stride // 4)
            lay = {name: (off // 4, n) for name, off, n in layout}
            if 'position' not in lay:
                continue
            o, _ = lay['position']
            p = raw[:, o:o + 3].astype(np.float64)
            if 'normal' in lay:
                o, _ = lay['normal']
                n = raw[:, o:o + 3].astype(np.float64)
            else:
                n = np.zeros_like(p)
            if 'uv0' in lay and lay['uv0'][1] >= 2:
                o, _ = lay['uv0']
                uv = raw[:, o:o + 2].astype(np.float64)
            else:
                uv = np.zeros((len(p), 2))
            if animated:                # Biped z-up -> three (x, z, -y)  (sim (x, z, y))
                p = np.stack([p[:, 0], p[:, 2], -p[:, 1]], 1)
                n = np.stack([n[:, 0], n[:, 2], -n[:, 1]], 1)
            else:                       # sim -> three: z mirrored
                p = p * (1, 1, -1)
                n = n * (1, 1, -1)
            idx = list(struct.unpack_from('<%dH' % m['indexCount'], m['ib'], 0))
            tris = np.array(S.sm_triangles(m['primType'], idx), np.int64).reshape(-1, 3)
            if len(tris) == 0:
                continue
            tris = tris[:, [0, 2, 1]]                    # winding swap for the mirror (standardmesh.md §8)
            agree.append((_winding_agreement(p, n, tris), len(tris)))
            props = rs.get(m['name'].lower(), {})
            tex = props.get('texture')
            groups.append({
                'name': m['name'],
                'start': icount,
                'count': int(tris.size),
                'texName': tex[0] if tex else None,
                'transparent': _flag(props.get('transparent'), False),
                'twosided': _flag(props.get('twosided'), False),
                'hasShader': bool(props),
            })
            P.append(p)
            N.append(n)
            U.append(uv)
            I.append(tris + base)
            base += len(p)
            icount += tris.size
        if not P:
            lods.append(None)
            continue
        lods.append((np.concatenate(P), np.concatenate(N), np.concatenate(U), np.concatenate(I), groups))
    tri_total = sum(t for _, t in agree)
    agreement = sum(a * t for a, t in agree) / tri_total if tri_total else 1.0
    flip = animated and agreement < 0.5
    if flip:
        # the Biped -> three map is a rotation (two reflections); if the skin's winding disagrees with its normals
        # anyway, flip it so FrontSide shows the outside (measured per mesh, docs/orig/objects.md)
        ctx.log('%s: winding agreement %.2f, flipping' % (vpath, agreement))
        agreement = 1.0 - agreement
    out = []
    for lod in lods:
        if lod is None:
            out.append(None)
            continue
        p, n, uv, tris, groups = lod
        if flip:
            tris = tris[:, [0, 2, 1]]
        vtx = np.concatenate([p, n, uv], 1).astype(np.float32)
        voff = binw.add(vtx)
        ia = _index_array(tris.reshape(-1), len(p))
        ioff = binw.add(ia)
        out.append({'vOffset': voff, 'vCount': int(len(p)), 'iOffset': ioff, 'iCount': int(ia.size),
                    'iType': 'u16' if ia.dtype == np.uint16 else 'u32', 'materials': groups})
    lods = out
    bb = sm['bbox']
    bmin, bmax = list(bb['min']), list(bb['max'])
    if animated:
        bmin, bmax = [bmin[0], bmin[2], bmin[1]], [bmax[0], bmax[2], bmax[1]]
    return {
        'type': 'sm', 'file': vpath, 'animated': bool(animated),
        'bboxSim': [bmin, bmax],
        'lods': lods, 'windingAgreement': round(agreement, 4),
        'triangles': [0 if l is None else l['iCount'] // 3 for l in lods],
    }


def build_tm(ctx, vpath, binw, missing):
    """TreeMesh .tm -> mesh entry (all 8 sorted copies kept, standardmesh.md §3)."""
    import fmt_standardmesh as S
    tm = S.parse_tm(ctx.vfs.read(vpath))
    nv = tm['vertexCount']
    raw = np.frombuffer(tm['vb'], np.float32).reshape(nv, 10).astype(np.float64)
    pos = raw[:, 0:3] * (1, 1, -1)
    nrm = raw[:, 3:6] * (1, 1, -1)
    uv = raw[:, 6:8]
    spr = raw[:, 8:10]                                # view-space metres (x right, y up): not mirrored
    idx = np.frombuffer(tm['ib'], np.uint16).astype(np.int64)
    groups = tm['groups']
    # sprite normals are placeholders / denormals / junk (standardmesh.md §3 verifier 2): zero them
    sprite_v = set()
    for it in groups[2]:
        nvar = tm['sortDirections']
        s, e = it['startIndex'], it['startIndex'] + it['triCount'] * 3 * nvar
        sprite_v.update(idx[s:e].tolist())
    if sprite_v:
        nrm[sorted(sprite_v)] = 0.0
    bad = ~np.isfinite(nrm).all(1) | (np.abs(nrm) > 1e3).any(1)
    nrm[bad] = 0.0
    if idx.size % 3 == 0 and all(it['startIndex'] % 3 == 0 for g in groups for it in g):
        idx = idx.reshape(-1, 3)[:, [0, 2, 1]].reshape(-1)          # winding swap (culling is off anyway)
    vtx = np.concatenate([pos, nrm, uv, spr], 1).astype(np.float32)
    vtx[~np.isfinite(vtx)] = 0.0
    voff = binw.add(vtx)
    ia = _index_array(idx, nv)
    ioff = binw.add(ia)
    gl = []
    for g in groups:
        gl.append([{'start': int(it['startIndex']), 'triCount': int(it['triCount']), 'texName': it['texture']}
                   for it in g])
    cc = tm['crownCenter']
    cr = tm['crownRadius']
    has_sprites = bool(groups[2])
    if not (all(math.isfinite(x) and abs(x) < 1e4 for x in cc) and math.isfinite(cr) and cr > 0):
        cc, cr = (0.0, 0.0, 0.0), 0.0
    bb = tm['bbox']
    tris = [sum(it['triCount'] for it in g) for g in groups]
    return {
        'type': 'tm', 'file': vpath,
        'bboxSim': [list(bb['min']), list(bb['max'])],
        'vOffset': voff, 'vCount': int(nv), 'iOffset': ioff, 'iCount': int(ia.size),
        'iType': 'u16' if ia.dtype == np.uint16 else 'u32',
        'sortDirections': int(tm['sortDirections']),
        'groups': gl,
        'crownCenter': [float(cc[0]), float(cc[1]), -float(cc[2])] if has_sprites else [0.0, 0.0, 0.0],
        'crownRadius': float(cr) if has_sprites else 0.0,
        'triangles': tris,
    }


# ------------------------------------------------------------------------------------------------- build
def _placements(ctx, stage):
    O, _, _ = _lib()
    path = ctx.vfs.real_path(stage.vpath('Objects.con'))
    if path is None:
        return None
    pls, _other = O.parse_objects_con(path)
    return pls


def _cull_settings(env, lib):
    """Object view distance / fade / size-cull values: HotSpot 'Global' when the regulator is enabled (it pushes
    its values into the ObjectDrawer every frame, 0x49c7c4..0x49c8c1), else the RenderSettings values, else the
    engine defaults."""
    s = dict(DEFAULTS)
    if env:
        o = env.get('objects') or {}
        dr = o.get('drawer') or {}
        for k, v in (('viewDistance', o.get('viewDistance')), ('distanceFade', o.get('distanceFade')),
                     ('cullFade', o.get('cullFade')), ('cullConst', dr.get('distanceCullConst')),
                     ('minCullDistance', dr.get('minCullDistance')), ('variation', dr.get('viewDistanceVariation')),
                     ('lodDistanceScale', o.get('standardMeshLodDistanceScale')),
                     ('billboardLightScale', o.get('treeBillboardLightScale'))):
            if v is not None:
                s[k] = float(v[0] if isinstance(v, (list, tuple)) else v)
    g = (env or {}).get('game') or {}
    # game.lightColor / game.shadowColor (FUN_0040e650 defaults 0.6 / 0.2): diagnostics + tests only, the runtime
    # reads origUniforms.objectLight / objectShadow (filled by the environment component from the same scripts)
    s['lightColor'] = _vec3(g.get('lightColor')) or [0.6, 0.6, 0.6]
    s['shadowColor'] = _vec3(g.get('shadowColor')) or [0.2, 0.2, 0.2]
    hs = []
    if env and env.get('hotspots') and env['hotspots'].get('enable'):
        for spot in env['hotspots'].get('list') or []:
            row = {'name': spot.get('name')}
            for k in ('splineDistance', 'width', 'fade'):
                if spot.get(k) is not None:
                    row[k] = float(spot[k])
            for hk, sk in HOTSPOT_FIELDS.items():
                if spot.get(hk) is not None:
                    row[sk] = float(spot[hk])
            hs.append(row)
        # the enabled regulator pushes ALL of the Global spot every frame (0x49c770); a field the scripts never set is
        # 0 there (spot ctor 0x4e0e30), e.g. billboardFadeScale on 4 stages (= a hard mesh/impostor switch)
        g = next((x for x in hs if (x.get('name') or '').lower() == 'global'), None) or {}
        for sk in HOTSPOT_FIELDS.values():
            s[sk] = float(g.get(sk, 0.0))
        s['regulated'] = True
    return s, hs


def build_stage(ctx, stage):
    O, ovfs, lib = _lib()
    pls = _placements(ctx, stage)
    if not pls:
        return
    env = _env_settings(stage)
    settings, hotspots = _cull_settings(env, lib)
    env_tpl = {k.lower(): v for k, v in ((env or {}).get('templates') or {}).items()}
    H = stage.height
    off = np.array([2048.0, H, 2048.0])

    binw = Bin()
    missing_tex = set()
    meshes = []
    mesh_ix = {}
    tex_cache = {}

    def tex(name):
        if name not in tex_cache:
            tex_cache[name] = _resolve_tex(ctx, name, missing_tex)
        return tex_cache[name]

    def mesh_for(gt):
        """GeometryTemplate -> mesh index (or -1 when the file is absent, e.g. Mesh/SoundPole)."""
        if gt is None or not gt.file:
            return -1, 'no geometry'
        typ = gt.type.lower()
        base = ovfs.norm(gt.file)
        if typ in ('standardmesh', 'animatedmesh', 'mayamesh'):
            vp = base + '.sm'
        elif typ == 'treemesh':
            vp = base + '.tm'
        else:
            return -1, 'unsupported geometry type %s' % gt.type
        if vp in mesh_ix:
            return mesh_ix[vp], (None if mesh_ix[vp] >= 0 else 'missing ' + vp)
        if not ctx.vfs.exists(vp):
            mesh_ix[vp] = -1
            return -1, 'missing ' + vp
        if vp.endswith('.tm'):
            m = build_tm(ctx, vp, binw, missing_tex)
        else:
            m = build_sm(ctx, vp, typ == 'animatedmesh', binw, missing_tex)
        mesh_ix[vp] = len(meshes)
        meshes.append(m)
        return mesh_ix[vp], None

    # templates in first-use order, placements grouped by template (Objects.con order inside a template)
    order = OrderedDict()
    for i, p in enumerate(pls):
        order.setdefault(p.template.lower(), []).append(i)

    templates = []
    inst_rows = []
    kinds = {}
    for key, ixs in order.items():
        tpl = lib.tpls.get(key)
        name = pls[ixs[0]].template
        gt = O.resolve_geometry(lib, tpl.geometry) if tpl is not None else None
        kind = O.classify(lib, tpl, gt)
        mi, why = mesh_for(gt) if tpl is not None else (-1, 'unknown template')
        gp = gt.props if gt is not None else {}
        gname = gt.name if gt is not None else ''
        ov = env_tpl.get(gname.lower(), {})
        gtype = gt.type.lower() if gt is not None else ''
        is_tree = gtype == 'treemesh'
        lighting = _flag(gp.get('lighting'), True)
        if 'lighting' in ov:
            lighting = bool(ov['lighting'])
        light_mul = _vec3(ov.get('lightColor')) or _vec3(gp.get('lightcolor')) or [1.0, 1.0, 1.0]
        shadow_mul = _vec3(ov.get('shadowColor')) or _vec3(gp.get('shadowcolor')) or [1.0, 1.0, 1.0]
        t = OrderedDict()
        t['name'] = name
        t['kind'] = kind
        t['geometry'] = gname or None
        t['geometryType'] = gt.type if gt is not None else None
        t['mesh'] = mi
        if why:
            t['skip'] = why
        t['lighting'] = lighting
        t['lightMul'] = light_mul
        t['shadowMul'] = shadow_mul
        if gt is not None and gt.lods:
            t['lodDistances'] = [float(gt.lods[k]) for k in sorted(gt.lods)]
        if is_tree:
            t['sideScreen'] = _flag(gp.get('sidescreen'), False)
            t['mergeable'] = _flag(gp.get('mergeable'), False)
            t['depthWrite'] = _flag(gp.get('depthwrite'), False)
            t['trilinear'] = _flag(gp.get('mipmapblendingenable'), False)
            t['gradiantFactor'] = _num(ov.get('gradiantFactor') or gp.get('gradiantfactor'), lib, 0.5)
            if _flag(gp.get('billboard'), False):
                res = [int(float(x)) for x in str((gp.get('billboardresolution') or ['0/0/0'])[0]).split('/') if x]
                bb_v = stage.vpath('Billboards/%s.dds' % gname)
                hit = ctx.vfs.find(bb_v, stage.archive)
                bb_tex = ctx.textures.use_file(*hit) if hit else None
                if hit is None:
                    missing_tex.add('Billboards/%s.dds' % gname)
                bb = {'distance': _num(gp.get('billboarddistance'), lib, 0.0), 'resolution': res, 'tex': bb_tex}
                m = meshes[mi] if mi >= 0 else None
                if m is not None and m['type'] == 'tm':
                    lo, hi = m['bboxSim']
                    bb['frames'] = max(1, res[2] if len(res) > 2 else 1)          # atlas frames n (template+0x104)
                    bb['dirs'] = m['sortDirections']                             # frame selector N (template+0xec)
                    bb['halfWidth'] = max(abs(lo[0]), abs(lo[2]), abs(hi[0]), abs(hi[2]))
                    bb['minY'] = lo[1]
                    bb['height'] = hi[1] - lo[1]
                t['billboard'] = bb
        # per-material textures (AnimatedObject.setMaterialTexture overrides by material name)
        if mi >= 0 and meshes[mi]['type'] == 'sm':
            over = {}
            if tpl is not None:
                for a in tpl.multi.get('setmaterialtexture', []):
                    if len(a) >= 2:
                        tn = a[1] if '/' in a[1] else 'texture/' + a[1]
                        over[a[0].lower()] = tn
            mats = []
            for lod in meshes[mi]['lods']:
                row = []
                for g in (lod['materials'] if lod else []):
                    nm = over.get(g['name'].lower())
                    tid = tex(nm) if nm else None
                    if tid is None:                       # absent override texture: keep the mesh's own (§known)
                        tid = tex(g['texName']) if g['texName'] else None
                    row.append(tid)
                mats.append(row)
            t['materialTex'] = mats
        elif mi >= 0:
            t['groupTex'] = [[tex(it['texName']) for it in g] for g in meshes[mi]['groups']]
        # instances
        m = meshes[mi] if mi >= 0 else None
        bmin, bmax = (m['bboxSim'] if m else ([0, 0, 0], [0, 0, 0]))
        first = len(inst_rows)
        for i in ixs:
            p = pls[i]
            s = p.scale or [1.0, 1.0, 1.0]
            R = _rot_rows(*p.rot)
            A = np.diag(s) @ R                               # rows = scaled local axes (sim)
            F = np.diag([1.0, 1.0, -1.0])
            L = F @ A.T @ F
            tpos = F @ (np.array(p.pos) - off)
            row = np.zeros(INST_STRIDE)
            row[0:3], row[3] = L[0], tpos[0]
            row[4:7], row[7] = L[1], tpos[1]
            row[8:11], row[11] = L[2], tpos[2]
            if is_tree:
                if p.color is not None:
                    cq = [float(np.float32(math.floor(255.0 * c)) * np.float32(F32_INV255)) for c in p.color]
                else:
                    cq = [float(np.float32(TREE_COLOUR_DEFAULT_BYTE) * np.float32(F32_INV255))] * 3
            else:
                cq = [0.5, 0.5, 0.5]
            row[12:15] = cq
            row[15] = p.shadow if p.shadow is not None else 0.0
            zx, zz = R[2][0], R[2][2]
            ln = math.hypot(zx, zz)
            row[16:18] = (zx / ln, zz / ln) if ln > 1e-12 else (0.0, 0.0)
            row[18:20] = (R[0][0], R[0][2])
            row[20] = _bbox_radius(bmin, bmax, s)
            row[21] = max(s)
            row[22] = ((i * 2654435761) % 4294967296) / 4294967296.0     # deterministic per placement
            inst_rows.append(row)
        t['instOffset'] = first
        t['instCount'] = len(ixs)
        kinds[kind] = kinds.get(kind, 0) + len(ixs)
        templates.append(t)

    inst = np.array(inst_rows, np.float32).reshape(-1, INST_STRIDE)
    inst_off = binw.add(inst)

    # final material/texture tables on the meshes are per template; drop build-only keys
    for m in meshes:
        if m['type'] == 'sm':
            for lod in m['lods']:
                for g in (lod['materials'] if lod else []):
                    g.pop('texName', None)
        else:
            for g in m['groups']:
                for it in g:
                    it.pop('texName', None)

    tex_levels = {}
    for t in templates:
        ids = [tid for row in (t.get('materialTex') or []) + (t.get('groupTex') or []) for tid in row]
        if t.get('billboard') and t['billboard'].get('tex'):
            ids.append(t['billboard']['tex'])
        for tid in ids:
            if tid and tid not in tex_levels:
                tex_levels[tid] = int(ctx.textures.info(tid)['levels'])
    miss = sorted(missing_tex)
    if miss:
        ctx.log('unresolved textures: %s' % ', '.join(miss))
    ctx.out.write_bytes('objects.bin', binw.bytes())
    ctx.out.commit({
        'version': VERSION,
        'stage': stage.to_json(),
        'source': 'Objects.con (authoritative; objects.md §1.1 Verification)',
        'instStride': INST_STRIDE,
        'instOffset': inst_off,
        'instCount': int(len(inst)),
        'binBytes': binw.size,
        'settings': settings,
        'hotspots': hotspots,
        'meshes': meshes,
        'templates': templates,
        'texLevels': tex_levels,
        'stats': {'placements': len(pls), 'templates': len(templates), 'meshes': len(meshes), 'kinds': kinds,
                  'missingTextures': miss},
    })
