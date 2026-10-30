"""track: the original track render meshes (Mesh/Track.qm + World.qm + Water.qm) per stage.

Spec: research/formats/quadmesh.md (incl. its Verification section), textures.md §4 (lightmaps),
environment.md §3.4 (fog), §3.6 (view distances), §3.7 (Water.*), §4 (pass order). Runtime:
src/render/orig/track*.ts. Docs: docs/orig/track.md.

Output (stages/<id>/):
  track.bin   per mesh (Track, World, Water): interleaved f32 vertices [position(3, THREE space = sim with z
              negated), uv0..uvN (2 each, the original D3D uvs unchanged)], u8x4 RGBA diffuse colours, u32
              triangle-list indices (D3D strips expanded with the odd-triangle swap, degenerates dropped, two
              indices swapped per triangle for the z mirror: three's CCW front = D3D's CW front + CULL_CCW)
  track.json  materials (one per .rs subshader: Mask / Single / Water + flags + texIds), meshes (layout, the
              quadtree with vertex-recomputed bounds, patches with their per-material groups and lightmap
              texId), the World placement, the view-distance / HotSpot / bump / water settings (resolved with
              the verified environment interpreter fmt_environment), stats (counts as fmt_quadmesh reports them)

Faithfulness notes (the [V] addresses are cited in docs/orig/track.md):
  * PS 1.1 path only (Mesh/Track.qm); SmallQuadSize is the fixed-function / low-end mesh and is not used.
  * Lightmaps: <level>/Lightmaps/Track<patch>, resolved like the engine (TGA, P8 through Track.pal);
    stages without them (corsica1f) get the engine's own fallback texture/white (renderer +0x220).
  * Missing base textures (5 references in the corpus) are recorded and drawn black at runtime.
"""
import math
import re

import numpy as np

import fmt_environment as FE
import fmt_quadmesh as Q

PART = 'track'
VERSION = 1

# the three QuadMesh geometries the track loader creates (quadmesh.md §1); kind -> file
MESH_FILES = (('track', 'Mesh/Track.qm'), ('world', 'Mesh/World.qm'), ('water', 'Mesh/Water.qm'))

# texture slots per subshader type: slot -> (.rs key, clampU key, clampV key)   (quadmesh.md §4.1)
SLOTS = {
    'Mask': (('base1', 'base1Tex', 'base1ClampU', 'base1ClampV'),
             ('mask', 'maskTex', 'maskClampU', 'maskClampV'),
             ('base2', 'base2Tex', 'base2ClampU', 'base2ClampV'),
             ('bump', 'bumpmap', 'bumpmapClampU', 'bumpmapClampV')),
    'Single': (('base1', 'texture', 'textureClampU', 'textureClampV'),
               ('bump', 'bumpmap', 'bumpmapClampU', 'bumpmapClampV')),
    'Water': (),
}

# settings defaults (FUN_0040e650, environment.md §V2) and the renderer defaults (FUN_0066a400 @0x66a2d7)
DEFAULTS = {
    'viewDistance': 1000.0,          # Track.viewDistance, settings +0x38
    'bumpHeight': 1.0,               # track.bumpHeight, settings +0x60
    'specularColor': [1.0, 0.5, 0.5],  # track.specularColor, settings +0x68
    'bumpEnable': True,              # track.bumpEnable, renderer +0x80
    'drawWorld': True,               # game.drawWorld -> race +0x753 (FUN_0048eb90 skips the World pass)
}
# camera near / far per pass [V frame sequence @0x49f114-0x49f1c1, settings defaults FUN_0040e650]:
#   sky + World pass: near = settings +0xc (10 m), far = settings +0x10 (100 km)  -> Z (and stencil) clear
#   track pass:       near = settings +0x34 (0.1 m), far = race +0x740 = the track view distance
# no shipped script sets them (World.nearPlane / Track.nearPlane are never used).
PASSES = {'worldNear': 10.0, 'worldFar': 100000.0, 'trackNear': 0.1}
# HotSpot value slots (spot +0x1c.., regulator +0x34..; FUN_004e1240, FUN_0049c770, printer FUN_0048fa90)
HOTSPOT_TRACK_VIEW_DISTANCE = 'trackViewDistance'


# ----------------------------------------------------------------------------------------------- helpers
def _f(v, nd=4):
    return float(round(float(v), nd))


def _vec(v, n=3):
    return [float(x) for x in list(v)[:n]]


def _aabb_three(mn, mx):
    """sim AABB -> three AABB (z negated: min/max z swap)."""
    return [float(mn[0]), float(mn[1]), -float(mx[2]), float(mx[0]), float(mx[1]), -float(mn[2])]


def _union(a, b):
    if a is None:
        return list(b)
    if b is None:
        return list(a)
    return [min(a[0], b[0]), min(a[1], b[1]), min(a[2], b[2]), max(a[3], b[3]), max(a[4], b[4]), max(a[5], b[5])]


class Blob:
    """track.bin builder: 4-byte aligned blocks."""

    def __init__(self):
        self.parts = []
        self.size = 0

    def put(self, arr):
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


# ----------------------------------------------------------------------------------------------- settings
def _env_stage(stage):
    """fmt_environment's stage record (its resolver walks the loader order of environment.md §1)."""
    m = re.match(r'^([a-z]+)(\d[abc]?)([fr])$', stage.archive)
    return {'archive': stage.archive, 'family': m.group(1), 'num': m.group(2), 'dir': m.group(3),
            'path': stage.cache_dir, 'id': stage.id}


def _world_placement(ctx, stage, order):
    """World.qm object placement: the loader's `Object.absolutePosition 2048/<H>/2048` (string 0x8485fc,
    format with the track height) unless a stage script re-positions / rotates the object `World`
    (`Object.active World` + `object.absolutePosition` / `object.rotation yaw/pitch/roll`, 25 stages).
    Scans the executed top-level scripts in the loader order (no `run` target touches objects)."""
    pos = [2048.0, float(stage.height), 2048.0]
    rot = [0.0, 0.0, 0.0]
    for rel in order:
        if rel.startswith('MISSING'):
            continue
        try:
            with open(FE.os.path.join(FE.REPO, rel), 'rb') as f:
                text = f.read().decode('latin-1')
        except OSError:
            continue
        active = None
        for raw in text.splitlines():
            t = raw.strip().split()
            if not t:
                continue
            cmd = t[0].lower()
            if cmd == 'rem':
                continue
            if cmd == 'object.active':
                active = t[1].lower() if len(t) > 1 else None
            elif cmd in ('object.create',):
                active = None
            elif cmd == 'object.name' and len(t) > 1:
                active = t[1].lower()
            elif active == 'world' and len(t) == 2 and cmd == 'object.absoluteposition':
                pos = FE.parse_vec(t[1], 3)
            elif active == 'world' and len(t) == 2 and cmd == 'object.rotation':
                rot = FE.parse_vec(t[1], 3)
    ox, oy, oz = stage.world_offset
    # three: position (x - 2048, y - H, -(z - 2048)); rotation.set(-pitch, -yaw, roll, 'YXZ') (objects.md §6)
    return {'worldPosition': [float(v) for v in pos], 'rotationYawPitchRollDeg': [float(v) for v in rot],
            'position': [float(pos[0] - ox), float(pos[1] - oy), float(-(pos[2] - oz))],
            'rotationYXZ': [-math.radians(rot[1]), -math.radians(rot[0]), math.radians(rot[2])]}


def _settings(ctx, stage):
    env_stage = _env_stage(stage)
    res = FE.resolve_stage(FE.load_cmds(), env_stage)
    env = res['env']
    tr = env['track']
    hs = env['hotspots']
    spots = []
    glob = None
    for h in hs.get('list') or []:
        rec = {'name': h.get('name'), HOTSPOT_TRACK_VIEW_DISTANCE: float(h.get(HOTSPOT_TRACK_VIEW_DISTANCE) or 0.0)}
        if (h.get('name') or '').lower() == 'global':
            glob = rec
            continue
        rec.update({'splineDistance': float(h.get('splineDistance') or 0.0), 'width': float(h.get('width') or 0.0),
                    'fade': float(h.get('fade') or 0.0)})
        spots.append(rec)

    def val(v, d):
        return d if v is None else v

    settings = {
        'viewDistance': float(val(tr.get('viewDistance'), DEFAULTS['viewDistance'])),
        'hotspots': {'enabled': bool(hs.get('enable')), 'global': glob, 'spots': spots},
        'bumpEnable': bool(val(tr.get('bumpEnable'), DEFAULTS['bumpEnable'])),
        'bumpHeight': float(val(tr.get('bumpHeight'), DEFAULTS['bumpHeight'])),
        'specularColor': _vec(val(tr.get('specularColor'), DEFAULTS['specularColor'])),
        'drawWorld': bool(val(env['game'].get('drawWorld'), DEFAULTS['drawWorld'])),
        'passes': dict(PASSES),
    }
    world = _world_placement(ctx, stage, res['executionOrder'])
    return settings, world, env.get('water') or {}


def _water(ctx, w):
    """Water.* (environment.md §3.7; field / constant mapping in docs/orig/track.md §3)."""
    if not w:
        return None
    out = {
        'baseTile': float(w.get('baseTile', 1.0)), 'baseScrollSpeed': float(w.get('baseScrollSpeed', 0.0)),
        'baseScrollDirection': _vec(w.get('baseScrollDirection', [0.0, 0.0]), 2),
        'bumpTile': float(w.get('bumpTile', 1.0)), 'bumpScrollSpeed': float(w.get('bumpScrollSpeed', 0.0)),
        'bumpScrollDirection': _vec(w.get('bumpScrollDirection', [0.0, 0.0]), 2),
        'animationSpeed': float(w.get('animationSpeed', 0.0)), 'envIntensity': float(w.get('envIntensity', 0.0)),
        'specularColor': _vec(w.get('specularColor', [0.0, 0.0, 0.0])),
        'baseTexName': w.get('baseTex'), 'bumpTexName': w.get('bumpTex'), 'envTexName': w.get('envTex'),
        'baseTex': None, 'bumpTex': None, 'bumpDepth': 1, 'envTex': None,
    }
    if w.get('baseTex'):
        out['baseTex'] = _use(ctx, w['baseTex'])
    if w.get('bumpTex'):
        out['bumpTex'] = _use(ctx, w['bumpTex'])
        if out['bumpTex']:
            out['bumpDepth'] = int(ctx.textures.info(out['bumpTex'])['depth'])
    if w.get('envTex'):
        out['envTex'] = ctx.textures.cube(w['envTex'])
        if out['envTex'] is None:
            # newzealand-2-f: Water.con names texture/NZ2f_water.rcm, shipped under Textures/ (not a texture
            # folder): the engine loads no EnvTex there either -> one water pass, unhalved fog colour
            ctx.warn('water EnvTex %s does not resolve' % w['envTex'])
            _MISSING.append(w['envTex'])
    return out


_MISSING = []


def _use(ctx, name):
    try:
        tid = ctx.textures.use(name)
    except Exception as e:  # noqa: BLE001  (TextureError: unconvertible file)
        ctx.warn('texture %s: %s' % (name, e))
        tid = None
    if tid is None:
        _MISSING.append(name)
    return tid


# ----------------------------------------------------------------------------------------------- meshes
def _materials(ctx, kind, rs, mats, index):
    for name, sh in rs.items():
        typ = sh.type.split('/', 1)[1] if '/' in sh.type else sh.type
        if typ not in SLOTS:
            raise ValueError('%s: subshader %s has unknown type %s' % (kind, name, sh.type))
        m = {'name': name, 'mesh': kind, 'type': typ,
             'lightmapped': sh.flag('lightmapped'), 'doubleIntensity': sh.flag('doubleIntensity'),
             'vertexPaint': sh.flag('vertexPaint'), 'tex': {}}
        for slot, key, cu, cv in SLOTS[typ]:
            if key in sh.props:
                m['tex'][slot] = {'name': sh.props[key], 'id': _use(ctx, sh.props[key]),
                                  'clampU': sh.flag(cu), 'clampV': sh.flag(cv)}
        index[(kind, name)] = len(mats)
        mats.append(m)


def _mesh(ctx, stage, kind, qm, mat_index, blob):
    patches_src = [(n, p) for n, p in qm.iter_patches()]
    if not patches_src:
        return None
    fmt = patches_src[0][1].vertex_format
    for _, p in patches_src:
        if p.vertex_format != fmt:
            raise ValueError('%s: mixed vertex formats in one .qm (0x%x, 0x%x)' % (kind, fmt, p.vertex_format))
    uvs = [k for k in ('uv0', 'uv1', 'uv2', 'uv3') if k in patches_src[0][1].attrs]
    stride = 3 + 2 * len(uvs)
    layout = {'position': 0}
    for i, k in enumerate(uvs):
        layout[k] = 3 + 2 * i

    nv = sum(p.vertex_count for _, p in patches_src)
    verts = np.zeros((nv, stride), np.float32)
    cols = np.full((nv, 4), 128, np.uint8)
    idx_parts = []
    patches = []
    node_ids = {}
    base = 0
    istart = 0
    ntri = 0
    for node, p in patches_src:
        P = p.positions.astype(np.float32)
        sl = slice(base, base + p.vertex_count)
        verts[sl, 0] = P[:, 0]
        verts[sl, 1] = P[:, 1]
        verts[sl, 2] = -P[:, 2]                                   # sim (LH) -> three (RH): mirror z
        for i, k in enumerate(uvs):
            verts[sl, 3 + 2 * i:5 + 2 * i] = p.attrs[k]
        if 'diffuse' in p.attrs:
            cols[sl] = p.attrs['diffuse']                         # D3DCOLOR BGRA -> RGBA (fmt_quadmesh)
        groups = []
        for s in p.subs:
            t = s.triangles(p.indices)                            # D3D order (CW front), strips expanded
            if not len(t):
                continue
            t = t[:, [0, 2, 1]].astype(np.int64) + base           # mirror flips winding
            idx_parts.append(t.reshape(-1).astype(np.uint32))
            mi = mat_index[(kind, s.material)]
            if groups and groups[-1]['material'] == mi and groups[-1]['start'] + groups[-1]['count'] == istart:
                groups[-1]['count'] += int(t.size)                # adjacent submeshes of one subshader: one draw
            else:
                groups.append({'material': mi, 'start': istart, 'count': int(t.size)})
            istart += int(t.size)
            ntri += len(t)
        vb = [float(P[:, 0].min()), float(P[:, 1].min()), float(-P[:, 2].max()),
              float(P[:, 0].max()), float(P[:, 1].max()), float(-P[:, 2].min())] if p.vertex_count else None
        lm = None
        if kind == 'track' and qm.lightmapped:
            # GeometryTemplate.lightmapPath <level>/Lightmaps; texture <lightmapPath>/Track<patch name>
            # [V FUN_00659ba0 + @0x4959bc]; resolved like any engine texture name (a level path: TGA)
            name = '%s/Lightmaps/Track%s' % (stage.level, p.name)
            if ctx.textures.resolve(name) is not None:
                lm = ctx.textures.use(name)
        patches.append({'name': p.name, 'node': id(node), 'vertexStart': base, 'vertexCount': p.vertex_count,
                        'bounds': vb, 'groups': groups, 'lightmap': lm})
        base += p.vertex_count

    # quadtree: nodes in file order (pre-order), bounds = union of the file AABB and every vertex below
    nodes = []

    def walk(n):
        i = len(nodes)
        node_ids[id(n)] = i
        rec = {'bounds': _aabb_three(n.aabb_min, n.aabb_max), 'children': [], 'patches': []}
        nodes.append(rec)
        for c in n.children:
            ci = walk(c)
            rec['children'].append(ci)
            rec['bounds'] = _union(rec['bounds'], nodes[ci]['bounds'])
        return i
    walk(qm.root)
    for pi, pt in enumerate(patches):
        ni = node_ids[pt.pop('node')]
        nodes[ni]['patches'].append(pi)
        if pt['bounds'] is None:
            pt['bounds'] = list(nodes[ni]['bounds'])
    # propagate patch bounds upward (children are listed after their parent in pre-order)
    for ni in range(len(nodes) - 1, -1, -1):
        n = nodes[ni]
        for pi in n['patches']:
            n['bounds'] = _union(n['bounds'], patches[pi]['bounds'])
        for ci in n['children']:
            n['bounds'] = _union(n['bounds'], nodes[ci]['bounds'])
    for rec in nodes + patches:
        rec['bounds'] = [_f(v, 3) for v in rec['bounds']]

    indices = np.concatenate(idx_parts) if idx_parts else np.zeros(0, np.uint32)
    return {
        'kind': kind, 'vertexFormat': fmt, 'lightmappedFile': bool(qm.lightmapped),
        'floatStride': stride, 'layout': layout, 'vertexCount': int(nv), 'indexCount': int(indices.size),
        'vertices': blob.put(verts), 'colors': blob.put(cols), 'indices': blob.put(indices),
        'nodes': nodes, 'patches': patches,
        'stats': {'patches': len(patches), 'vertices': int(nv), 'triangles': int(ntri),
                  'submeshes': int(sum(len(p.subs) for _, p in patches_src)),
                  'groups': int(sum(len(p['groups']) for p in patches)),
                  'indexCountSource': int(sum(p.index_count for _, p in patches_src))},
    }


def build_stage(ctx, stage):
    del _MISSING[:]
    blob = Blob()
    mats, mat_index, meshes = [], {}, []
    for kind, rel in MESH_FILES:
        qm_path = ctx.vfs.real_path(stage.vpath(rel))
        if qm_path is None:
            continue                                   # no World.qm on rallycross, Water.qm on 14 stages only
        rs_path = ctx.vfs.real_path(stage.vpath(rel[:-3] + '.rs'))
        if rs_path is None:
            raise ValueError('%s has no .rs' % rel)
        qm = Q.parse(qm_path)
        if qm.leftover:
            raise ValueError('%s: %d bytes left over' % (rel, qm.leftover))
        _materials(ctx, kind, Q.parse_rs(rs_path), mats, mat_index)
        m = _mesh(ctx, stage, kind, qm, mat_index, blob)
        if m is not None:
            m['file'] = rel
            meshes.append(m)
    if not meshes or meshes[0]['kind'] != 'track':
        raise ValueError('no Mesh/Track.qm')

    settings, world, water_raw = _settings(ctx, stage)
    water = _water(ctx, water_raw)
    white = ctx.textures.use('texture/white')          # renderer +0x220: the missing-lightmap stand-in
    for m in meshes:
        if m['kind'] == 'world':
            m['transform'] = world
    lm = [p['lightmap'] for p in meshes[0]['patches']]
    ctx.out.write_bytes('track.bin', blob.bytes())
    ctx.out.commit({
        'version': VERSION,
        'stage': stage.to_json(),
        'binBytes': blob.size,
        'white': white,
        'materials': mats,
        'meshes': meshes,
        'settings': settings,
        'water': water,
        'missingTextures': sorted(set(_MISSING)),
        'lightmaps': {'patches': len(lm), 'present': sum(1 for x in lm if x), 'fallback': 'texture/white'},
    })
    ctx.log('%s: %s, %d materials, %.1f MB, lightmaps %d/%d%s' % (
        stage.id, ', '.join('%s %dp/%dv/%dt' % (m['kind'], m['stats']['patches'], m['stats']['vertices'],
                                               m['stats']['triangles']) for m in meshes),
        len(mats), blob.size / 1e6, sum(1 for x in lm if x), len(lm),
        (', missing ' + ', '.join(sorted(set(_MISSING)))) if _MISSING else ''))
