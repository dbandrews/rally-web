"""cars part — the 29 original cars (research/formats/cars.md + Verification, standardmesh.md §5.6).

build_cars(ctx, cars) → per car  cars/<Name>/cars.json            small: names, specs, wheels + hub data, lights,
                                                                     exhaust, drivers, hull, drop shadow, menu icon,
                                                                     the car's own camera table (<Car>CarCamera)
                                 cars/<Name>/cars/meshes.json      materials of every LOD set + both wheel meshes
                                 cars/<Name>/cars/lod<N>.bin       Body + Interior of LOD set N (Mesh/Cars, Cars_1..3)
                                 cars/<Name>/cars/wheels.bin       the tarmac + gravel wheel meshes (4 internal LODs)
                                 cars/<Name>/cars/icon.png         Menu/menu/Texture/Icon<Name>.tga (menu art)
build_stage(ctx, stage)        → stages/<id>/cars.json             the per-stage car inputs (cars.md §7): the track's
                                                                     CarEnvmap cube + CarDirtmap, the stage's car.*
                                                                     material settings (lighting.con / RenderSettings)

Everything geometric is emitted in THREE space (docs/ARCHITECTURE.md §2): positions / normals (x, y, −z), triangle
lists from the D3D strips (cars.md §5.2, degenerates dropped, odd triangles re-wound) with the winding swapped
(a, c, b) so three's CCW front = the original's CW front. Wheel / bundle / light positions in cars.json stay in the
original SIM body frame (the runtime converts; the hub transform is defined there, cars.md §4.2).

Binary blocks (little-endian, 4-byte aligned, offsets in meshes.json per material):
  pos f32×3 · nrm f32×3 · col u8×4 (RGBA; RGB = baked AO, A = reflection weight, cars.md §5.1) · uv0 f32×2 ·
  uv1 f32×2 (dirt-map coordinates, only for `dirtmap` materials) · dpos f32×3 + dnrm f32×3 (Body only: the crash
  morph target, cars.md §5.3) · idx u16×3·nTri.
"""
import io
import json
import os
import re

import numpy as np

import fmt_cars as C
import fmt_environment as E

PART = 'cars'
VERSION = 1

# cars.md §6 / FUN_00660730 (builder reset) + getters of the "Car" builder interface (vtable 0x820c00):
#   car.specularColor   vt+0x4c/+0x50 → builder+0x7c, default (1, 1, 1)                    [V objdump 0x6602d0/0x6602f0]
#   car.specularHighlightsEnable vt+0x64/+0x68 → +0x24f, default 1                           [V 0x660300/0x660320]
#   car.envmapColorScale (1, 1, 1), car.metallicSpecularScale 1                              [V cars.md §6 verifier]
CAR_SETTING_DEFAULTS = {
    'specularColor': [1.0, 1.0, 1.0],
    'specularHighlightsEnable': True,
    'envmapColorScale': [1.0, 1.0, 1.0],
    'metallicSpecularScale': 1.0,
}
# Misc/object/FX_CarFlare*.con: the LensFlare templates the cars' Lensflares.con place (cars.md §10)
FLARE_FILES = ['object/FX_CarFlare.con', 'object/FX_CarFlare2.con', 'object/FX_CarFlare3.con', 'object/FX_CarFlare_Z.con']
# tyre type → wheel geometry: the consumer of tarmac/gravelGeometry was not located (cars.md §12 Q3);
# cars.md §8 recommendation: tyre 0/1 → tarmac, 2/3/4 → gravel.
GRAVEL_TYRES = [2, 3, 4]
# LocaleEnglish labels of the car select screen (Menu/menu/Car/SelectCarFrame): the spec lines of every car
# ("530 hp\r\n790 Nm", "1298 kg\r\n4WD\r\n5") line up with id 50, the three bars with id 51 [E text; bar order = the
# label order [I]].
SPEC_LABELS_ID = 50     # 'HP:\r\nTorque:\r\nWeight:\r\nWheeldrive:\r\nGears:'
SLIDER_LABELS_ID = 51   # 'Speed:\r\nHandling:\r\nAccel:\r\n'


# ------------------------------------------------------------------------------------------- helpers
def _abs(rel_path):
    return None if rel_path is None else os.path.join(C.ROOT, rel_path)


def _r(v, n=6):
    if isinstance(v, (list, tuple)):
        return [_r(x, n) for x in v]
    if isinstance(v, float):
        return round(v, n)
    return v


def _one_line(s):
    return re.sub(r'\s+', ' ', (s or '').replace('\r\n', ' ').replace('\n', ' ')).strip() or None


def _lines(s):
    return [x.strip() for x in (s or '').replace('\r\n', '\n').split('\n') if x.strip()]


class Blob:
    """Append-only little-endian binary with 4-byte aligned blocks."""

    def __init__(self):
        self.buf = io.BytesIO()

    def add(self, arr):
        a = np.ascontiguousarray(arr)
        off = self.buf.tell()
        self.buf.write(a.tobytes())
        pad = (-self.buf.tell()) % 4
        if pad:
            self.buf.write(b'\0' * pad)
        return off

    def bytes(self):
        return self.buf.getvalue()


def _vec4(v, default):
    """fresnelBias / fresnelScale: 3 or 4 values; a missing w defaults to 1 (only the transparent materials use
    w = alpha, and all of those author 4 values — survey of all 1844 materials)."""
    if v is None:
        return list(default)
    if not isinstance(v, list):
        v = [float(v)] * 3
    v = [float(x) for x in v]
    return (v + [1.0])[:4] if len(v) == 3 else v[:4]


def _vec3(v, default):
    if v is None:
        return list(default)
    if not isinstance(v, list):
        return [float(v)] * 3
    return [float(x) for x in v[:3]]


def _truthy(v):
    return v not in (None, False, 0, 0.0, 'false', '0')


def shader_entry(ctx, builder, params, sub):
    """Normalised subshader parameters (cars.md §6/§7) + the texture's texId."""
    p = params or {}
    tex = p.get('texture')
    tid = ctx.textures.use(tex, None) if tex else None
    if tex and tid is None:
        ctx.warn('texture %s did not resolve (subshader %s)' % (tex, sub))
    name = (sub or '').lower()
    kind = {'Car/Default': 'default', 'Car/Reflector': 'reflector', 'Car/Ghost': 'ghost', 'Car/Cup': 'cup'}.get(builder, 'default')
    return {
        'kind': kind,
        'tex': tid,
        'ambient': _r(_vec3(p.get('ambient'), (1, 1, 1))),
        'diffuse': _r(_vec3(p.get('diffuse'), (1, 1, 1))),
        'dirt': _truthy(p.get('dirtmap')),
        'env': _truthy(p.get('envmap')),
        'highlight': _truthy(p.get('specularHighlights')),
        'mask': _truthy(p.get('specularMask')),
        'transparent': _truthy(p.get('transparent')),
        'envPass': _truthy(p.get('envmapPass')),
        # blendSource destColor + blendDest sourceColor (LampGlass) = modulate 2x (cars.md §6)
        'blend': 'mod2x' if (str(p.get('blendSource', '')).lower() == 'destcolor'
                             and str(p.get('blendDest', '')).lower() == 'sourcecolor') else
                 ('alpha' if _truthy(p.get('transparent')) else 'opaque'),
        # no specular keys = no Phong term (default 0, cars.md §6 [?] — the builder default is not resolved)
        'specPower': float(p.get('specularPower') or 0.0),
        'specScale': float(p.get('specularScale') or 0.0),
        'fresnelBias': _r(_vec4(p.get('fresnelBias'), (0, 0, 0, 1))),
        'fresnelScale': _r(_vec4(p.get('fresnelScale'), (0, 0, 0, 0))),
        # flags with a named meaning (cars.md §6): LampBack = brake light (TexSimple while braking)
        'lampBack': name == 'lampback',
    }


def tri_list(cm, lod, mi):
    a = C.cm_arrays(cm, lod, mi)
    tris = a['tris']
    if len(tris):
        tris = tris[:, [0, 2, 1]]           # swap winding for the mirror (cars.md §5.4)
    return a, np.ascontiguousarray(tris.astype(np.uint16))


def to_three(v):
    out = np.array(v, dtype=np.float32, copy=True)
    out[:, 2] *= -1
    return out


def emit_material(ctx, blob, cm, lod, mi, entry, keep_dirt, keep_deform, fallback_rs=None):
    """One .cm material → binary blocks + metadata. None for materials the engine does not draw."""
    if entry.get('subshader') is None and fallback_rs is not None:
        # Cars_N .rs without this subshader (ImprezaWRX Cars_1 `accesories`): use the LOD0 set's (cars.md §6 [?])
        sname, ss = C.subshader_for(fallback_rs, entry['material'])
        if ss is not None:
            entry = dict(entry, subshader=sname, builder=ss['builder'], params=ss['params'])
    if entry.get('subshader') is None:
        return None                         # `lambert1` (Maya default, no subshader): not drawn (cars.md §6)
    a, idx = tri_list(cm, lod, mi)
    if len(idx) == 0:
        return None
    sh = shader_entry(ctx, entry.get('builder'), entry.get('params'), entry.get('subshader'))
    nv = a['pos'].shape[0]
    col = a['color'] if a['color'] is not None else np.full((nv, 4), 255, np.uint8)
    rec = {'name': entry['material'], 'sub': entry.get('subshader'), 'group': entry.get('group', 12),
           'nv': int(nv), 'ni': int(idx.size), 'shader': sh}
    off = {'pos': blob.add(to_three(a['pos'])), 'nrm': blob.add(to_three(a['normal'])), 'col': blob.add(col.astype(np.uint8))}
    uv0 = a['uv0'] if a['uv0'] is not None else np.zeros((nv, 2), np.float32)
    off['uv0'] = blob.add(uv0.astype(np.float32))
    if keep_dirt and sh['dirt'] and a['uv1'] is not None:
        off['uv1'] = blob.add(a['uv1'].astype(np.float32))
    if keep_deform and 'dpos' in a:
        off['dpos'] = blob.add(to_three(a['dpos']))
        off['dnrm'] = blob.add(to_three(a['dnormal']))
    off['idx'] = blob.add(idx)
    rec['off'] = off
    b = a['pos']
    rec['bbox'] = _r([float(b[:, 0].min()), float(b[:, 1].min()), float(-b[:, 2].max()),
                      float(b[:, 0].max()), float(b[:, 1].max()), float(-b[:, 2].min())], 4)
    return rec


def parse_flares():
    """LensFlare templates (FX_CarFlare*.con): per template the flare / corona entries that are active
    (`if 0` … `endif` blocks skipped), with texture, size(s), rotation speed, colours (0..255), fade angle factor."""
    out = {}
    for f in FLARE_FILES:
        p = C.resolve_script(f)
        if p is None:
            continue
        cur, skip = None, []
        for ln in open(p, encoding='latin1').read().splitlines():
            t = ln.split()
            if not t or t[0].lower() == 'rem':
                continue
            h = t[0].lower()
            if h == 'if':
                skip.append(len(t) > 1 and t[1] in ('0', 'false'))
                continue
            if h == 'endif':
                skip and skip.pop()
                continue
            if any(skip):
                continue
            if h == 'objecttemplate.create' and len(t) >= 3:
                cur = out[t[2]] = {'flares': {}, 'coronas': {}, 'scaleDistance': None}
                continue
            if cur is None:
                continue
            m = re.match(r'objecttemplate\.set(flare|corona)(texture|size2|size|rot|color2|color|fadeanglefactor)$', h)
            if m and len(t) >= 3:
                kind = 'flares' if m.group(1) == 'flare' else 'coronas'
                e = cur[kind].setdefault(t[2], {})
                k, v = m.group(2), t[1]
                if k == 'texture':
                    e['texture'] = v
                elif k in ('color', 'color2'):
                    e[k] = [float(x) for x in v.split('/')]
                elif k in ('size', 'size2'):
                    e[k] = [float(x) for x in v.split('/')]
                elif k == 'rot':
                    e['rot'] = float(v)
                else:
                    e['fadeAngleFactor'] = float(v)
            elif h == 'objecttemplate.flarescaledistance' and len(t) >= 2:
                cur['scaleDistance'] = float(t[1])
    return out


def flare_json(ctx, tpl):
    def ent(e):
        tex = e.get('texture')
        tid = ctx.textures.use('texture/' + tex, None) if tex else None
        return {'tex': tid, 'size': e.get('size'), 'size2': e.get('size2'), 'rot': e.get('rot', 0.0),
                'color': e.get('color'), 'color2': e.get('color2'), 'fadeAngleFactor': e.get('fadeAngleFactor', 0.0)}
    return {'scaleDistance': tpl.get('scaleDistance'),
            'flares': [ent(tpl['flares'][k]) for k in sorted(tpl['flares'], key=int)],
            'coronas': [ent(tpl['coronas'][k]) for k in sorted(tpl['coronas'], key=int)]}


def camera_json(cam):
    """<Car>CarCamera (Templates.con, attached by Player.con `addTemplate <Car>CarCamera`): the 25
    `setCamPosition <i> <enabled> <flag> <posA> <posB> <param>` entries in the original SIM car frame. Every camera
    function reads its own entry from this per-car array (template +0x248, stride 0x30: FUN_0075e390 entry 0 at
    +0x0c, FUN_0075e790 entry 1 at +0x3c, FUN_0075fda0 entry 6 at +0x12c..+0x14c, the tether at +0x1ec..+0x200);
    the hard-coded values there are only the no-template fallback. MECHANICS_SPEC §5.3's table = ImprezaWRX's
    entries. `enabled` = in the camera cycle (8 per car, §5.3); `flag` is recorded raw (0 on entries 0-4, 1 after)."""
    if not cam:
        return None
    by_i = {}
    for e in cam.get('positions') or []:
        by_i[e['i']] = e                    # a repeated index: the later line wins (script order)
    return {
        'template': cam.get('template'),
        'attach': _r(cam.get('pos')),
        'entries': [{'i': e['i'], 'enabled': bool(e['a']), 'flag': e['b'], 'posA': _r(e['pos']),
                     'posB': _r(e['target']), 'param': _r(e['param'])} for _, e in sorted(by_i.items())],
    }


def write_icon(ctx, out, car):
    """Menu/menu/Texture/Icon<Car>.tga → cars/icon.png (the original car-select art, 100×85 RGBA)."""
    hit = ctx.vfs.resolve_texture('menu/texture/Icon' + car, None)
    if hit is None:
        return None
    from PIL import Image
    data = ctx.vfs.archives.read(*hit)
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception as e:  # noqa
        ctx.warn('icon %s: %s' % (car, e))
        return None
    b = io.BytesIO()
    im.convert('RGBA').save(b, 'PNG', optimize=True)
    out.write_bytes('cars/icon.png', b.getvalue())
    return {'path': 'cars/icon.png', 'width': im.size[0], 'height': im.size[1]}


# ------------------------------------------------------------------------------------------- build_cars
_loc = None
_flares = None


def build_cars(ctx, cars):
    global _loc, _flares
    if _loc is None:
        _loc = C.load_locale()
    if _flares is None:
        _flares = parse_flares()
    menu_cube = ctx.textures.cube('menu/texture/carenvmap', None)
    if menu_cube is None:
        ctx.warn('menu/texture/carenvmap did not resolve')
    for name in cars:
        build_car(ctx, name, menu_cube)


def build_car(ctx, car, menu_cube):
    d = C.assemble_car(car, _loc)
    out = ctx.car_out(car)
    meshes = {'version': VERSION, 'car': car, 'lods': [], 'wheels': {}}
    tris = []
    # ---- body + interior at the four LOD sets (cars.md §5.5: Mesh/Cars → Cars_1..3; Cars_3 has no Interior)
    lod0_rs = {}
    for li, ld in enumerate(C.LOD_DIRS):
        blob = Blob()
        lod = {'dir': ld, 'bin': 'cars/lod%d.bin' % li, 'meshes': []}
        ntri = 0
        for part in d['parts']:
            dsc = (part.get('lodSets') or {}).get(ld)
            if dsc is None:
                continue
            cm = C.get_cm(_abs(dsc['file']))
            mats = []
            for mi, entry in enumerate(dsc['lods'][0]['materials']):
                fb = lod0_rs.get(part['role'])
                rec = emit_material(ctx, blob, cm, 0, mi, entry, keep_dirt=True, keep_deform=bool(dsc['lods'][0]['deform']),
                                    fallback_rs=fb)
                if rec is not None:
                    mats.append(rec)
                    ntri += rec['ni'] // 3
            if li == 0:
                rsp = next((m.get('shaderFile') for m in dsc['lods'][0]['materials'] if m.get('shaderFile')), None)
                if rsp:
                    lod0_rs[part['role']] = C.get_rs(_abs(rsp))
            lod['meshes'].append({'role': part['role'], 'file': dsc['file'].split('.cache/original/', 1)[-1],
                                  'bbox': dsc['bbox'], 'materials': mats})
        out.write_bytes(lod['bin'], blob.bytes())
        lod['triangles'] = ntri
        tris.append(ntri)
        meshes['lods'].append(lod)

    # ---- wheel meshes: tarmac + gravel geometry (4 internal LODs each, cars.md §5.5 / §8)
    wheel_names = {}
    w0 = d['wheels'][0]['geoms']
    for k in ('tarmacGeometry', 'gravelGeometry'):
        g = w0.get(k) or {}
        wheel_names[k] = g.get('name') if g.get('defined') else None
    blob = Blob()
    for k in ('tarmacGeometry', 'gravelGeometry'):
        gname = wheel_names[k]
        if gname is None or gname in meshes['wheels']:
            continue
        dsc = w0[k]['mesh']
        cm = C.get_cm(_abs(dsc['file']))
        lods = []
        for li, lod in enumerate(dsc['lods']):
            mats = [r for r in (emit_material(ctx, blob, cm, li, mi, e, keep_dirt=True, keep_deform=False)
                                for mi, e in enumerate(lod['materials'])) if r is not None]
            lods.append({'materials': mats})
        meshes['wheels'][gname] = {'file': dsc['file'].split('.cache/original/', 1)[-1], 'bbox': dsc['bbox'], 'lods': lods}
    meshes['wheelsBin'] = 'cars/wheels.bin'
    out.write_bytes('cars/wheels.bin', blob.bytes())
    if wheel_names['gravelGeometry'] is None:   # Astra: WheelGravel6Grey undefined (original data bug) → tarmac
        ctx.log('%s: gravel wheel %s undefined, using the tarmac wheel' % (car, w0['gravelGeometry'].get('name')))

    # ---- wheels: bundle B, camber / toe / yaw, spring data (cars.md §4.2, §4.4)
    menu_pos = {m['child']: m['menu'] for m in d.get('menuDiff', []) if 'child' in m}
    wheels = []
    for w in d['wheels']:
        ph = w['physics']
        rot = w.get('rot') or [0, 0, 0]
        wheels.append({
            'index': w['index'], 'name': w['name'], 'front': w['index'] < 2,
            'bundle': _r(w['pos']), 'menuBundle': _r(menu_pos.get(w['name'], w['pos'])),
            'mount': _r(w['mount']), 'wheelBasePos': _r(w.get('wheelBasePos')),
            # wheel[+0xd4] (degrees added to the yaw) = the template setRotation yaw (180 on right wheels, cars.md §4.2)
            'yawDeg': float(rot[0]),
            'cornerSign': w['visual'].get('cornerSign'), 'camberRad': w['visual'].get('camberRad', 0.0),
            'toeRad': w['visual'].get('toeRad', 0.0),
            'springLength': ph.get('wheel_SpringLength'), 'springK': ph.get('wheel_SpringK'),
            'steerTweak': ph.get('wheel_SteerTweak'), 'rest': w.get('rest'),
        })

    # ---- lights / exhaust / drivers / hull / drop shadow
    used = {f['template'] for f in d.get('lensflares', [])}
    flare_tpls = {t: flare_json(ctx, _flares[t]) for t in sorted(used) if t in _flares}
    ds_tex = ctx.textures.use('texture/Car/DropShadows/' + car, None)
    icon = write_icon(ctx, out, car)
    menu = d.get('menu') or {}
    phys = d['physics']
    hull = d.get('hull') or {}
    colp = _abs(hull.get('file'))
    hull_pts = C.parse_col(colp)['points'] if colp else []
    ncol = int(C.num(phys.get('car_NColPoints'), 12) or 12)
    meshes_rel = 'cars/meshes.json'
    out.write_json(meshes_rel, meshes)
    info = {
        'version': VERSION,
        'car': car,
        'name': _one_line(menu.get('name')) or car,
        'nameLines': _lines(menu.get('name')),
        'nameId': menu.get('nameId'),
        'shortName': d.get('shortName'),
        'shortNameId': d.get('shortNameId'),
        'specs': [_one_line(s) for s in menu.get('specs') or []],
        'specLines': [x for s in menu.get('specs') or [] for x in _lines(s)],
        'specLabels': [x.rstrip(':') for x in _lines(_loc.get(SPEC_LABELS_ID))],
        'sliders': menu.get('sliders'),
        'sliderLabels': [x.rstrip(':') for x in _lines(_loc.get(SLIDER_LABELS_ID))],
        'icon': icon,
        'drive': int(C.num(phys.get('car_WheelDrive'), 2)),
        'mass': C.num(phys.get('car_Mass')),
        'wheelRadius': C.num(phys.get('car_WheelRadius'), 0.3),
        'wheelWidth': C.num(phys.get('car_WheelWidth'), 0.2),
        'wheels': wheels,
        'wheelMeshes': {'tarmac': wheel_names['tarmacGeometry'],
                        'gravel': wheel_names['gravelGeometry'] or wheel_names['tarmacGeometry'],
                        'gravelTyres': GRAVEL_TYRES},
        'lodTriangles': tris,
        'meshes': meshes_rel,
        'lensflares': [{'template': f['template'], 'pos': f['pos'], 'yawDeg': float((f.get('rot') or [0])[0])}
                       for f in d.get('lensflares', [])],
        'flareTemplates': flare_tpls,
        'exhaust': d.get('exhaust', []),
        'drivers': [{'role': x['role'], 'pos': x['pos'], 'characterHeight': x.get('characterHeight')} for x in d.get('drivers', [])],
        'hull': {'points': _r(hull_pts[:ncol], 4), 'extraPoints': _r(hull_pts[ncol:], 4),
                 'min': hull.get('min'), 'max': hull.get('max')},
        'dropShadow': {'tex': ds_tex, 'scale': d.get('dropShadowScale')},
        'camera': camera_json(d.get('camera')),
        'menuEnvCube': menu_cube,
        'missing': d.get('missing', []),
    }
    out.commit(info)
    ctx.log('%s: %s, LOD triangles %s, %d flares' % (car, info['name'], tris, len(info['lensflares'])))


# ------------------------------------------------------------------------------------------- build_stage
_cmds = None


def build_stage(ctx, stage):
    """stages/<id>/cars.json: the per-stage car inputs (cars.md §7 "Inputs per stage")."""
    global _cmds
    env_cube = ctx.textures.cube('texture/CarEnvmap')
    dirt = ctx.textures.use('texture/CarDirtmap')
    if dirt is None:
        dirt = ctx.textures.use('texture/Car/CarDirtMap_512', None)   # cars.md §7 fallback
    car = {}
    try:
        if _cmds is None:
            _cmds = E.load_cmds()
        st = next((s for s in E.stages() if s['id'] == stage.id), None)
        if st is not None:
            env = E.resolve_stage(_cmds, st)['env']
            car = env.get('car') or {}
    except Exception as e:  # noqa — the settings are optional extras, the defaults stand in
        ctx.warn('car settings of %s: %s' % (stage.id, e))
    settings = {}
    for k, dv in CAR_SETTING_DEFAULTS.items():
        v = car.get(k)
        settings[k] = dv if v is None else (_r(v) if isinstance(v, list) else v)
    ctx.out.commit({
        'version': VERSION,
        'stage': stage.id,
        'envCube': env_cube,
        'dirtMap': dirt,
        'settings': settings,
        # reference only: the environment part writes these into origUniforms.carLight / carAmbient
        'lightColor': car.get('lightColor'),
        'ambient': car.get('ambient'),
        'lightmap': {'min': car.get('lightmapMin'), 'max': car.get('lightmapMax'), 'clamp': car.get('lightmapClamp')},
    })
