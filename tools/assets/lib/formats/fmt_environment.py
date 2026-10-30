"""fmt_environment.py -- parse + resolve the per-stage environment scripts of the original game.

Reads, for every one of the 48 stages under research/full/<name>{f,r}/track/<name>/{forward,reverse}/:
  fogzor/TrackFogSettings/<Name>{f,r}.con, RenderSettings.con, RenderSettingsSingle{1p,4p}.con
  (+ the *Small* variants, parsed for validation only), common/track/GlobalRenderSettingsSingle{1p,4p}.con,
  Sky.con, lighting.con, Water.con, Cameras.con, and every file they `run` (Misc/level/*, Misc/object/*),
in the order the track loader executes them (see research/formats/environment.md section 1), with the
console semantics of the original (FUN_00511050 lookup: case-insensitive, get/set prefix fallback; Vec
arguments parsed with "missing trailing components repeat the last one" (0x433100)), and writes

  research/formats/environment_dump.json   -- resolved environment for all 48 stages
  artifacts/re/environment/*.png           -- sky box crosses, panoramas with sun marker, screenshot checks
  (--no-images skips the PNGs)

The command metadata (namespace, kind, arity, registration/exec addresses) comes from
research/formats/environment_cmds.json, produced by research/tools/fmt_environment_cmds.py.

usage: research/.venv/bin/python -I research/tools/fmt_environment.py [--no-images]
"""
import os, sys, re, json, math

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # rally-web: data roots from _paths.py
from _paths import REPO, FULL, ART_ROOT, DUMPS, DATA  # noqa: E402
OUT_JSON = os.path.join(DUMPS, 'environment_dump.json')
CMDS_JSON = os.path.join(DATA, 'environment_cmds.json')
ART = os.path.join(ART_ROOT, 'environment')

FAMILIES = ('corsica', 'hillclimb', 'iceracing', 'kenya', 'newzealand', 'rallycross')
CIRCUIT_FAMILIES = ('iceracing', 'rallycross')   # loader 0x4971d3: strncmp(name,"iceracing"/"rallycross") -> 4p set

# ----------------------------------------------------------------------------------------------------
# file system: the game mounts every archive at the same root; texture/ and level/ are searched in the
# track first (Track/<Name>/<Dir>/...) then in Misc.  We mirror that with a case-insensitive lookup.
# ----------------------------------------------------------------------------------------------------
_ci_cache = {}
def ci_listdir(d):
    if d not in _ci_cache:
        try:
            _ci_cache[d] = {f.lower(): f for f in os.listdir(d)}
        except FileNotFoundError:
            _ci_cache[d] = {}
    return _ci_cache[d]

def ci_path(base, rel):
    """case-insensitive join; returns real path or None."""
    cur = base
    for part in re.split(r'[\\/]+', rel):
        if not part: continue
        m = ci_listdir(cur).get(part.lower())
        if m is None: return None
        cur = os.path.join(cur, m)
    return cur

def find_texture(stage_dir, name, exts=('.dds', '.tga', '.rcm')):
    """'texture/Foo' -> track Texture/Foo.* first, then Misc/texture/Foo.*; returns repo-relative path."""
    rel = re.sub(r'^texture[\\/]', '', name, flags=re.I)
    has_ext = os.path.splitext(rel)[1].lower() in ('.dds', '.tga', '.rcm', '.rtx', '.bmp')
    for base in (os.path.join(stage_dir, 'Texture'), os.path.join(FULL, 'Misc', 'texture')):
        cands = [rel] if has_ext else [rel + e for e in exts]
        for c in cands:
            p = ci_path(base, c)
            if p: return os.path.relpath(p, REPO)
    return None

def resolve_run(stage_dir, rel):
    """`run level/x` / `run object/y` -> Misc/level, Misc/object (".con" optional)."""
    cands = [rel] if rel.lower().endswith('.con') else [rel + '.con', rel]
    for base in (stage_dir, os.path.join(FULL, 'Misc')):
        for c in cands:
            p = ci_path(base, c)
            if p and os.path.isfile(p): return p
    return None

# ----------------------------------------------------------------------------------------------------
# argument parsing (console arg types; Vec parser 0x433100 / 0x420520 ...)
# ----------------------------------------------------------------------------------------------------
_num = re.compile(r'[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?')

def parse_float(tok):
    m = _num.match(tok)
    return float(m.group(0)) if m else None

def parse_vec(tok, n):
    """istringstream >> f >> c >> f >> c >> f with ONE target float reused for every component
    (0x433100): when the stream runs dry the variable keeps the last parsed value, so "0.7" -> 0.7/0.7/0.7
    and "1.4/1.3" -> 1.4/1.3/1.3.  Returns None if not even the first component parses."""
    out = []; last = None; s = tok
    for i in range(n):
        m = _num.match(s)
        if m:
            last = float(m.group(0)); s = s[m.end():]
            if s: s = s[1:]          # >> char separator (any char, normally '/')
            out.append(last)
        else:
            if last is None: return None
            out.append(last); s = ''
    return out

def parse_bool(tok):
    v = parse_float(tok)
    return None if v is None else (v != 0)

def parse_arg(ty, tok):
    if ty == 'float': return parse_float(tok)
    if ty in ('uint', 'int'):
        v = parse_float(tok); return None if v is None else int(v)
    if ty == 'bool': return parse_bool(tok)
    if ty == 'Vec2': return parse_vec(tok, 2)
    if ty == 'Vec3': return parse_vec(tok, 3)
    if ty == 'Vec4': return parse_vec(tok, 4)
    return tok

# ----------------------------------------------------------------------------------------------------
# command metadata
# ----------------------------------------------------------------------------------------------------
def load_cmds():
    d = json.load(open(CMDS_JSON))
    table = {}
    for k, v in d.items():
        table[k.lower()] = v
    return table

BLEND = {'bmzero': 1, 'bmone': 2, 'bmsourcecolor': 3, 'bminvsourcecolor': 4, 'bmsourcealpha': 5,
         'bminvsourcealpha': 6, 'bmdestalpha': 7, 'bminvdestalpha': 8, 'bmdestcolor': 9, 'bminvdestcolor': 10,
         'bmsourcealphasaturate': 11}   # FUN_00548df0 (== D3DBLEND)

def norm3(v):
    l = math.sqrt(sum(c * c for c in v))
    return [c / l for c in v] if l > 1e-12 else [0.0, 0.0, 0.0]   # sunLightDirectionVec exec 0x53f0c0

# ----------------------------------------------------------------------------------------------------
# the resolved state
# ----------------------------------------------------------------------------------------------------
# Settings-singleton defaults (verifier, 2026-10-29): FUN_0040e650, called by the singleton ctor FUN_0040e2e0
# AND by the race-level reset FUN_004ac570 (base vtbl+0x6c, chained from every race level's unload 0x487df0, which
# also releases the per-track carEnvmap). So every stage starts from these values; a field a stage leaves unset
# takes the default, not the previous stage's value. Setter -> field mapping via the Appendix A callee column.
SETTINGS_DEFAULTS = {
    'game.trackGammaDelta': 0.0,                    # FUN_0040ef30(0)            +0x78
    'World.fogEnable': False,                       # FUN_0040f010(0)            +0x14
    'World.fogRange': [0.0, 1024.0],                # FUN_0040f070               +0x24
    'World.fogRangeFixed': [0.0, 1024.0],           # FUN_0040f0e0               +0x2c
    'World.fogColor': [1.0, 1.0, 1.0],              # FUN_0040f160               +0x18
    'Track.viewDistance': 1000.0,                   # FUN_0040f250(1000.0)       +0x38
    'Track.fogEnable': False,                       # FUN_0040f720(0)            +0x3c
    'Track.fogRange': [0.0, 1024.0],                # FUN_0040f780               +0x4c
    'Track.fogRangeFixed': [0.0, 1024.0],           # FUN_0040f7f0               +0x54
    'Track.fogColor': [1.0, 1.0, 1.0],              # FUN_0040f880               +0x40
    'Track.fogClamp': 1.0e8,                        # FUN_0040f910(0x4cbebc20)   +0x5c  (= no clamp)
    'track.bumpHeight': 1.0,                        # FUN_0040f980(1.0)          +0x60
    'track.specularColor': [1.0, 0.5, 0.5],         # FUN_0040f9f0               +0x68
    'track.lightmapLimit': 4096,                    # FUN_0040fa80(0x1000)       +0x70
    'game.gamma': [1.0, 1.0, 1.0],                  # FUN_0040fb40               +0xa8 (no effect, FUN_0060a2d0)
    'game.brightness': [1.0, 1.0, 1.0],             # FUN_0040fc40               +0xb4 (no effect)
    'game.contrast': [1.0, 1.0, 1.0],               # FUN_0040fcd0               +0xc0 (no effect)
    'Object.viewDistance': 300.0,                   # FUN_0040f2c0(300.0)        +0x7c
    'Object.distanceFade': 0.75,                    # FUN_0040f330(0.75)         +0x80
    'object.cullFade': 0.75,                        # FUN_0040f3a0(0.75)         +0x84
    'mergeMesh.sideScreenViewDistance': 0.0,        # FUN_0040f5d0(0)            +0x98
    'mergeMesh.sideScreenFade': 0.75,               # FUN_0040f640(0.75)         +0x9c
    'mergeMesh.sideScreenAlphaRef': 0.0,            # FUN_0040f6b0(0)            +0xa0
    'game.lightColor': [0.6, 0.6, 0.6],             # FUN_0040fe80               +0xe8
    'game.shadowColor': [0.2, 0.2, 0.2],            # FUN_0040ff10               +0xf4
    'car.lightColor': [0.5, 0.5, 0.5],              # FUN_00410030               +0x114
    'car.ambient': [0.3, 0.3, 0.3],                 # FUN_004100c0               +0x120
    'Car.lightmapMin': [0.2, 0.2, 0.2],             # FUN_00410150               +0x130
    'Car.lightmapMax': [1.0, 1.0, 1.0],             # FUN_004101e0               +0x138
    'Car.lightmapClamp': [0.0, 0.5],                # FUN_00410270               +0x144
    'Car.shadowHeightScale': 1.5,                   # FUN_004103e0(1.5)          +0x154
    'car.shadowColor': [0.5, 0.5, 0.5],             # FUN_00411770               +0x158
    'car.dropShadowColor': [0.2, 0.2, 0.2],         # FUN_004117f0               +0x164
    'game.particleLightmapMin': [0.2, 0.2, 0.2],    # FUN_00410450               +0x1b8
    'renderer.fieldOfView': 70.0,                   # FUN_00410680(70.0)         +0x1dc
    'game.drawSkidMarks': True,                     # FUN_00410cb0(1)            +0x204
    'game.drawWorld': True,                         # FUN_00410e70(1)            +0x1fa
    'game.dynamicShadows': True,                    # FUN_00411f70(1)            +0x21a
    'game.enableAnimationTriggerSystem': True,      # FUN_00412970(1)            +0x282
}

def new_state():
    return {
        # ---- settings singleton *0x868558 (setters FUN_0040f010.. ; ctor FUN_0040e2e0) ----
        'fog': {
            'world': {'enable': None, 'color': None, 'range': None, 'rangeFixed': None},
            'track': {'enable': None, 'color': None, 'range': None, 'rangeFixed': None, 'clamp': None},
        },
        'game': {'gamma': None, 'contrast': None, 'brightness': None, 'lightColor': None, 'shadowColor': None,
                 'trackGammaDelta': None, 'particleLightmapMin': None, 'drawWorld': None, 'dynamicShadows': None,
                 'drawSkidMarks': None, 'enableAnimationTriggerSystem': None, 'renderToTexture': None},
        'car': {'ambient': None, 'lightColor': None, 'shadowColor': None, 'dropShadowColor': None,
                'lightmapMin': None, 'lightmapMax': None, 'lightmapClamp': None, 'shadowHeightScale': None,
                'envmapColorScale': None, 'specularColor': None, 'metallicSpecularScale': None,
                'specularHighlightsEnable': None, 'dropShadowScales': {}},
        'track': {'viewDistance': None, 'lightmapLimit': None, 'bumpHeight': None, 'specularColor': None,
                  'bumpEnable': None, 'bumpLightmapEnable': None, 'bumpLightmapMin': None, 'bumpLightmapMax': None,
                  'bumpLightmapClamp': None},
        'objects': {'viewDistance': None, 'distanceFade': None, 'cullFade': None,
                    'drawer': {'minCullDistance': None, 'distanceCullConst': None, 'defaultNumberSlices': None,
                               'viewDistanceVariation': None},
                    'standardMeshLodDistanceScale': None, 'standardMeshSwayLodDistance': None,
                    'treeSwayEnable': None, 'treeSwayLodDistance': None, 'treeBillboardLightScale': None,
                    'mergeMesh': {'sideScreenAlphaRef': None, 'sideScreenFade': None, 'sideScreenViewDistance': None},
                    'worldAbsolutePosition': None, 'fieldOfView': None},
        'templates': {},          # geometryTemplate.* per active template (lighting.con, swing.con)
        'sky': {'initialised': False, 'rotAngleDeg': 0.0, 'ofsSkyHeight': 0.0, 'ofsCloudHeight': None,
                'ofsCloudDist': None, 'ofsRndTexPos': 0.0, 'cloudFog': False,
                'sunLightDir': [0.0, 0.7071067811865476, 0.7071067811865476],  # Sky ctor FUN_005477a0 stores (0,0.707,0.707) (0x3f34fdf4); FUN_0049a680 normalises it
                'sunObject': None, 'clouds': []},
        'objectTemplates': {},    # lens flares (ObjectTemplate.create LensFlare ...) and other active templates
        'objectsCreated': [],     # Object.create / Object.name
        'water': {},
        'weather': None,
        'hotspots': {'enable': None, 'list': []},
        'particles': {'enableParticles': None, 'globalParticleColor': None, 'maxParticles': None},
        'skidmarks': {'color': None, 'intensityClamp': None, 'materialExtraWidth': None},
        'replay': {'modeHistory': [], 'cameras': []},
        'renderer': {},
    }

class Interp:
    def __init__(self, cmds, stage_dir):
        self.cmds = cmds
        self.stage_dir = stage_dir
        self.st = new_state()
        self.prov = {}            # dotted state path -> "file:line"
        self.files = []           # consumption records
        self.ignored = []         # commands the original console does not know
        self.badargs = []
        self.passthrough = {}     # known commands outside the environment scope: name -> count
        self.cur_template = None  # geometryTemplate.active
        self.cur_otemplate = None # ObjectTemplate.active / create
        self.cur_object = None
        self.cur_hotspot = None
        self.vars = {}
        self.depth = 0

    # ------------------------------------------------------------------------------------------------
    def set(self, path, value, where):
        node = self.st
        keys = path.split('.')
        for k in keys[:-1]:
            node = node.setdefault(k, {})
        node[keys[-1]] = value
        self.prov[path] = where

    def run_file(self, path, why):
        rec = {'file': os.path.relpath(path, REPO), 'why': why, 'bytes': 0, 'lines': 0, 'commands': 0, 'rem': 0,
               'blank': 0, 'control': 0, 'ignored': 0, 'leftoverBytes': 0}
        raw = open(path, 'rb').read()
        rec['bytes'] = len(raw)
        text = raw.decode('latin1')
        # every byte must belong to a line (CR/LF/CRLF terminated or the last unterminated line)
        lines = re.split(r'\r\n|\n|\r', text)
        consumed = sum(len(l) for l in lines) + sum(len(x) for x in re.findall(r'\r\n|\n|\r', text))
        rec['leftoverBytes'] = len(text) - consumed
        self.files.append(rec)
        skip = []                 # if-stack: True = skipping
        self.depth += 1
        for ln, line in enumerate(lines, 1):
            where = '%s:%d' % (os.path.relpath(path, FULL), ln)
            rec['lines'] += 1 if (line or ln < len(lines)) else 0
            t = line.strip()
            if not t:
                rec['blank'] += 1; continue
            toks = t.split()
            w = toks[0]; wl = w.lower()
            if wl in ('if',):
                rec['control'] += 1
                cond = self.eval_cond(toks[1:]) if not any(skip) else False
                skip.append(not cond); continue
            if wl == 'endif':
                rec['control'] += 1
                if skip: skip.pop()
                continue
            if wl == 'else':
                rec['control'] += 1
                if skip: skip[-1] = not skip[-1]
                continue
            if any(skip):
                rec['control'] += 1; continue
            if wl == 'rem' or wl.startswith('rem*') or wl == 'rem--':
                rec['rem'] += 1; continue
            if wl == 'var':
                rec['control'] += 1; self.vars[toks[1].lower()] = 0 if len(toks) > 1 else None; continue
            if wl == 'run':
                rec['control'] += 1
                if len(toks) < 2: self.ignored.append({'where': where, 'line': t, 'why': 'run without file'}); continue
                p = resolve_run(self.stage_dir, toks[1])
                if not p:
                    self.ignored.append({'where': where, 'line': t, 'why': 'run target not found'}); continue
                if self.depth > 8: continue
                self.run_file(p, 'run from %s' % where)
                continue
            if '.' not in w or len(toks) and '->' in toks:
                rec['ignored'] += 1
                self.ignored.append({'where': where, 'line': t, 'why': 'not a console command'}); continue
            if self.command(w, toks[1:], where):
                rec['commands'] += 1
            else:
                rec['ignored'] += 1
        self.depth -= 1
        return rec

    def eval_cond(self, toks):
        if not toks: return False
        if len(toks) == 1:
            v = parse_float(toks[0])
            if v is not None: return v != 0
            return bool(self.vars.get(toks[0].lower()))
        a = self.vars.get(toks[0].lower(), parse_float(toks[0]))
        b = parse_float(toks[2]) if len(toks) > 2 else None
        if toks[1] in ('=', '=='): return a == b
        if toks[1] == '!=': return a != b
        return False

    # ------------------------------------------------------------------------------------------------
    def command(self, w, args, where):
        key = w.lower()
        meta = self.cmds.get(key)
        if meta is None:
            # not one of the environment commands mapped in environment_cmds.json (particle templates in
            # Misc/object/CarFX_*.con etc.): out of this topic, counted but not interpreted
            self.passthrough[key] = self.passthrough.get(key, 0) + 1
            return True
        if not meta.get('matches'):
            self.ignored.append({'where': where, 'line': ' '.join([w] + args),
                                 'why': 'unknown to the original console (no registration in that namespace)'})
            return False
        m = meta['matches'][0]
        ty = m.get('type')
        canon = key
        if meta.get('via'):
            canon = meta['via'].split('-> ')[1].lower()
        h = HANDLERS.get(canon)
        if h is None:
            self.passthrough[canon] = self.passthrough.get(canon, 0) + 1
            return True
        try:
            ok = h(self, args, ty, where)
        except Exception as e:  # noqa
            ok = False
            self.badargs.append({'where': where, 'line': ' '.join([w] + args), 'why': 'handler error %r' % e})
        if ok is False:
            self.badargs.append({'where': where, 'line': ' '.join([w] + args), 'why': 'argument count/type rejected'})
        return True

# ----------------------------------------------------------------------------------------------------
# handlers -- one per (canonical) command; path = where the original stores it
# ----------------------------------------------------------------------------------------------------
HANDLERS = {}
def H(*names):
    def deco(f):
        for n in names: HANDLERS[n.lower()] = f
        return f
    return deco

def prop(path, ty_override=None):
    """kind-1 property: 0 args = get (no effect), 1 arg = set."""
    def f(it, args, ty, where):
        if len(args) == 0: return True
        if len(args) != 1: return False
        v = parse_arg(ty_override or ty, args[0])
        if v is None: return False
        it.set(path, v, where); return True
    return f

for name, path in {
    'world.fogenable': 'fog.world.enable', 'world.fogrange': 'fog.world.range',
    'world.fograngefixed': 'fog.world.rangeFixed', 'world.fogcolor': 'fog.world.color',
    'track.fogenable': 'fog.track.enable', 'track.fogrange': 'fog.track.range',
    'track.fograngefixed': 'fog.track.rangeFixed', 'track.fogcolor': 'fog.track.color',
    'track.fogclamp': 'fog.track.clamp',
    'game.gamma': 'game.gamma', 'game.contrast': 'game.contrast', 'game.brightness': 'game.brightness',
    'game.lightcolor': 'game.lightColor', 'game.shadowcolor': 'game.shadowColor',
    'game.trackgammadelta': 'game.trackGammaDelta', 'game.particlelightmapmin': 'game.particleLightmapMin',
    'game.drawworld': 'game.drawWorld', 'game.dynamicshadows': 'game.dynamicShadows',
    'game.drawskidmarks': 'game.drawSkidMarks', 'game.enableanimationtriggersystem': 'game.enableAnimationTriggerSystem',
    'game.rendertotexture': 'game.renderToTexture',
    'car.ambient': 'car.ambient', 'car.lightcolor': 'car.lightColor', 'car.shadowcolor': 'car.shadowColor',
    'car.dropshadowcolor': 'car.dropShadowColor', 'car.lightmapmin': 'car.lightmapMin',
    'car.lightmapmax': 'car.lightmapMax', 'car.lightmapclamp': 'car.lightmapClamp',
    'car.shadowheightscale': 'car.shadowHeightScale', 'car.envmapcolorscale': 'car.envmapColorScale',
    'car.specularcolor': 'car.specularColor', 'car.metallicspecularscale': 'car.metallicSpecularScale',
    'car.specularhighlightsenable': 'car.specularHighlightsEnable',
    'track.viewdistance': 'track.viewDistance', 'track.lightmaplimit': 'track.lightmapLimit',
    'track.bumpheight': 'track.bumpHeight', 'track.specularcolor': 'track.specularColor',
    'track.bumpenable': 'track.bumpEnable', 'track.bumplightmapenable': 'track.bumpLightmapEnable',
    'track.bumplightmapmin': 'track.bumpLightmapMin', 'track.bumplightmapmax': 'track.bumpLightmapMax',
    'track.bumplightmapclamp': 'track.bumpLightmapClamp',
    'object.viewdistance': 'objects.viewDistance', 'object.distancefade': 'objects.distanceFade',
    'object.cullfade': 'objects.cullFade',
    'objectdrawer.minculldistance': 'objects.drawer.minCullDistance',
    'objectdrawer.distancecullconst': 'objects.drawer.distanceCullConst',
    'objectdrawer.defaultnumberslices': 'objects.drawer.defaultNumberSlices',
    'objectdrawer.viewdistancevariation': 'objects.drawer.viewDistanceVariation',
    'standardmesh.loddistancescale': 'objects.standardMeshLodDistanceScale',
    'standardmesh.swayloddistance': 'objects.standardMeshSwayLodDistance',
    'treemesh.swayenable': 'objects.treeSwayEnable', 'treemesh.swayloddistance': 'objects.treeSwayLodDistance',
    'treemesh.billboardlightscale': 'objects.treeBillboardLightScale',
    'mergemesh.sidescreenalpharef': 'objects.mergeMesh.sideScreenAlphaRef',
    'mergemesh.sidescreenfade': 'objects.mergeMesh.sideScreenFade',
    'mergemesh.sidescreenviewdistance': 'objects.mergeMesh.sideScreenViewDistance',
    'renderer.fieldofview': 'objects.fieldOfView',
    'particlesystem.enableparticles': 'particles.enableParticles',
    'particlesystem.globalparticlecolor': 'particles.globalParticleColor',
    'particlesystem.maxparticles': 'particles.maxParticles',
    'skidmark.setcolor': 'skidmarks.color', 'skidmark.setintensityclamp': 'skidmarks.intensityClamp',
    'skidmark.setmaterialskidmarkextrawidth': 'skidmarks.materialExtraWidth',
    'sky.sunlightdirectionvec': None,
}.items():
    if path: HANDLERS[name] = prop(path)

@H('sky.sunlightdirectionvec')
def _sun(it, args, ty, where):
    if len(args) == 0: return True
    if len(args) != 1: return False
    v = parse_vec(args[0], 3)
    if v is None: return False
    it.set('sky.sunLightDir', norm3(v), where); it.set('sky.sunLightDirRaw', v, where); return True

@H('sky.initsky')
def _initsky(it, args, ty, where):
    # FUN_00547c40: +0x30 = 1, ofsCloudHeight = 2500, ofsCloudDist = 333, loads 5 faces
    sky = it.st['sky']
    if sky.get('clouds'):
        pass
    it.set('sky.initialised', True, where)
    it.set('sky.ofsCloudHeight', 2500.0, where)
    it.set('sky.ofsCloudDist', 333.0, where)
    faces = {}
    for k, fn in (('top', 'SkyTOP_A'), ('left', 'SkyLFT_A'), ('right', 'SkyRGT_A'), ('front', 'SkyFRT_A'),
                  ('back', 'SkyBAK_A')):
        faces[k] = find_texture(it.stage_dir, 'texture/' + fn)
    it.set('sky.faces', faces, where)
    return True

def skyf(path, n=1):
    def f(it, args, ty, where):
        if len(args) != n: return False
        v = parse_float(args[0])
        if v is None: return False
        it.set(path, v, where); return True
    return f
HANDLERS['sky.setrotangle'] = skyf('sky.rotAngleDeg')            # exec 0x53dd80 -> sky+0x1c (degrees)
HANDLERS['sky.changeofsskyheight'] = skyf('sky.ofsSkyHeight')     # sky+0x18
HANDLERS['sky.changeofscloudheight'] = skyf('sky.ofsCloudHeight') # FUN_00547860 sky+0x10
HANDLERS['sky.changeofsclouddist'] = skyf('sky.ofsCloudDist')     # FUN_00547870 sky+0x14

@H('sky.changeofsrndtexpos')
def _rnd(it, args, ty, where):
    if len(args) != 1: return False
    v = parse_float(args[0]); it.set('sky.ofsRndTexPos', v, where); return True   # FUN_00547880

@H('sky.setcloudfog')
def _cfog(it, args, ty, where):
    it.set('sky.cloudFog', parse_bool(args[0]) if args else None, where); return True

@H('sky.setsun')
def _setsun(it, args, ty, where):
    if len(args) != 1: return False
    it.set('sky.sunObject', args[0], where); return True              # FUN_00548520 -> sky+0x2c / +0x38

@H('sky.addcloud')
def _addcloud(it, args, ty, where):
    # FUN_00547940: new cloud, name "cloud_<n>", height = ofsCloudHeight - n*ofsCloudDist, src 5 dst 6, scale 1
    sky = it.st['sky']
    n = len(sky['clouds'])
    h = (sky['ofsCloudHeight'] or 0.0) - n * (sky['ofsCloudDist'] or 0.0)
    sky['clouds'].append({'name': 'cloud_%d' % n, 'srcBlend': 5, 'dstBlend': 6, 'texScale': 1.0,
                          'speed': [0.0, 0.0], 'height': h, 'texture': None, 'texturePath': None, 'addedAt': where})
    return True

def cur_cloud(it):
    c = it.st['sky']['clouds']
    return c[-1] if c else None

@H('cloud.setname')
def _cname(it, args, ty, where):
    c = cur_cloud(it)
    if c is None or len(args) != 1: return False
    c['name'] = args[0]; return True

@H('cloud.setsrcblend', 'cloud.setdstblend')
def _cblend(it, args, ty, where):
    c = cur_cloud(it)
    if c is None or len(args) != 1: return False
    v = BLEND.get(args[0].lower())
    if v is None: return False
    c['srcBlend' if 'src' in where_cmd(it) else 'dstBlend'] = v
    return True

def where_cmd(it):
    return it._lastcmd

@H('cloud.settexscale')
def _cscale(it, args, ty, where):
    c = cur_cloud(it)
    if c is None or len(args) != 1: return False
    c['texScale'] = parse_float(args[0]); return True                 # FUN_00549080 cloud+0x64

@H('cloud.setspeed')
def _cspeed(it, args, ty, where):
    c = cur_cloud(it)
    if c is None or len(args) != 2: return False                      # exec 0x540d20: exactly 2 floats
    c['speed'] = [parse_float(args[0]), parse_float(args[1])]; return True

@H('cloud.setheight')
def _cheight(it, args, ty, where):
    c = cur_cloud(it)
    if c is None or len(args) != 1: return False
    c['height'] = parse_float(args[0]); return True                   # cloud+0x68

@H('cloud.texture')
def _ctex(it, args, ty, where):
    c = cur_cloud(it)
    if c is None or len(args) != 1: return False
    c['texture'] = args[0]; c['texturePath'] = find_texture(it.stage_dir, 'texture/' + args[0]); return True

# ---- geometry templates (lighting.con per-object colour multipliers, Swing.con sway) ----
@H('geometrytemplate.active')
def _gta(it, args, ty, where):
    if len(args) != 1: return False
    it.cur_template = args[0]
    it.st['templates'].setdefault(args[0], {}); return True

def gt(field, kind):
    def f(it, args, ty, where):
        if it.cur_template is None or len(args) != 1: return False
        v = parse_arg(kind, args[0])
        if v is None: return False
        it.st['templates'][it.cur_template][field] = v; return True
    return f
for fld, kind in (('lightColor', 'Vec3'), ('shadowColor', 'Vec3'), ('lighting', 'bool'), ('sideScreen', 'bool'),
                  ('billboardDistance', 'float'), ('mipmapBlendingEnable', 'bool'), ('gradiantFactor', 'float'),
                  ('swayEnable', 'bool'), ('swayPeriodSeconds', 'float'), ('swayRangeDegrees', 'float'),
                  ('swayWindFactor', 'float'), ('swayDirection', 'Vec2'), ('swayForceRangeDegrees', 'float'),
                  ('swayForcePeriodSeconds', 'float'), ('swayForceLengthSeconds', 'float')):
    HANDLERS['geometrytemplate.' + fld.lower()] = gt(fld, kind)

# ---- object templates (lens flares) / objects ----
@H('objecttemplate.create')
def _otc(it, args, ty, where):
    if len(args) != 2: return False
    it.cur_otemplate = args[1]
    it.st['objectTemplates'][args[1]] = {'class': args[0], 'createdAt': where, 'flares': {}, 'coronas': {}}
    return True

@H('objecttemplate.active')
def _ota(it, args, ty, where):
    if len(args) != 1: return False
    it.cur_otemplate = args[0]
    it.st['objectTemplates'].setdefault(args[0], {'class': None, 'flares': {}, 'coronas': {}, 'note': 'activated only'})
    return True

def ot_set(field, kind, indexed=None):
    def f(it, args, ty, where):
        t = it.st['objectTemplates'].get(it.cur_otemplate)
        if t is None: return False
        if indexed:
            if len(args) != 2: return False
            v = parse_arg(kind, args[0]); i = int(parse_float(args[1]))
            t[indexed].setdefault(str(i), {})[field] = v
        else:
            if len(args) != 1: return False
            t[field] = parse_arg(kind, args[0])
        return True
    return f
for nm, fld, kind, idx in (
        ('setflaretexture', 'texture', 'str', 'flares'), ('setflaresize', 'size', 'Vec2', 'flares'),
        ('setflaresize2', 'size2', 'Vec2', 'flares'), ('setflarerot', 'rot', 'float', 'flares'),
        ('setflarecolor', 'color', 'Vec4', 'flares'), ('setflarecolor2', 'color2', 'Vec4', 'flares'),
        ('setcoronatexture', 'texture', 'str', 'coronas'), ('setcoronasize', 'size', 'Vec2', 'coronas'),
        ('setcoronasize2', 'size2', 'Vec2', 'coronas'), ('setcoronarot', 'rot', 'float', 'coronas'),
        ('setcoronacolor', 'color', 'Vec4', 'coronas'), ('setcoronacolor2', 'color2', 'Vec4', 'coronas')):
    HANDLERS['objecttemplate.' + nm] = ot_set(fld, kind, idx)
for nm, fld, kind in (('setlensflarecount', 'lensFlareCount', 'int'), ('setcoronacount', 'coronaCount', 'int'),
                      ('setocclusionquadwidthheight', 'occlusionQuadWidthHeight', 'float'),
                      ('setissun', 'isSun', 'bool'), ('enable', 'enable', 'bool')):
    HANDLERS['objecttemplate.' + nm] = (lambda fld, kind: (lambda it, args, ty, where: (
        it.st['objectTemplates'].get(it.cur_otemplate) is not None and len(args) >= 1 and
        it.st['objectTemplates'][it.cur_otemplate].__setitem__(fld, parse_arg(kind, args[0])) is None)))(fld, kind)
HANDLERS['objecttemplate.initlensflares'] = lambda it, a, t, w: True

@H('object.create')
def _oc(it, args, ty, where):
    it.cur_object = {'template': args[0] if args else None, 'createdAt': where}
    it.st['objectsCreated'].append(it.cur_object); return True

@H('object.name')
def _on(it, args, ty, where):
    if it.cur_object is None or len(args) != 1: return False
    it.cur_object['name'] = args[0]; return True

@H('object.active')
def _oa(it, args, ty, where):
    it.cur_object = {'active': args[0] if args else None, 'activatedAt': where}; return True

@H('object.absoluteposition')
def _oap(it, args, ty, where):
    if len(args) != 1 or it.cur_object is None: return False
    v = parse_vec(args[0], 3); it.cur_object['absolutePosition'] = v
    if (it.cur_object.get('active') or '').lower() == 'world':
        it.set('objects.worldAbsolutePosition', v, where)
    return True

@H('object.rotation')
def _orot(it, args, ty, where):
    if len(args) != 1 or it.cur_object is None: return False
    it.cur_object['rotation'] = parse_vec(args[0], 3); return True

@H('object.setocclusionquadwidthheight')
def _ooq(it, args, ty, where):
    if it.cur_object is None: return False
    it.cur_object['occlusionQuadWidthHeight'] = [parse_float(a) for a in args]; return True

@H('car.setdropshadowscale')
def _dss(it, args, ty, where):
    if len(args) != 2: return False
    it.st['car']['dropShadowScales'][args[0]] = parse_vec(args[1], 3); return True

# ---- water (Water ns, accessor FUN_00647e60 -> water object) ----
for nm, fld, kind in (('basetex', 'baseTex', 'tex'), ('basetile', 'baseTile', 'float'),
                      ('basescrollspeed', 'baseScrollSpeed', 'float'), ('basescrolldirection', 'baseScrollDirection', 'Vec2'),
                      ('bumptex', 'bumpTex', 'tex'), ('bumptile', 'bumpTile', 'float'),
                      ('animationspeed', 'animationSpeed', 'float'), ('bumpscrollspeed', 'bumpScrollSpeed', 'float'),
                      ('bumpscrolldirection', 'bumpScrollDirection', 'Vec2'), ('envtex', 'envTex', 'tex'),
                      ('envintensity', 'envIntensity', 'float'), ('specularcolor', 'specularColor', 'Vec3')):
    def mk(fld, kind):
        def f(it, args, ty, where):
            if len(args) != 1: return False
            if kind == 'tex':
                it.st['water'][fld] = args[0]
                it.st['water'][fld + 'Path'] = find_texture(it.stage_dir, args[0])
            else:
                v = parse_arg(kind, args[0])
                if v is None: return False
                it.st['water'][fld] = v
            it.prov['water.' + fld] = where
            return True
        return f
    HANDLERS['water.' + nm] = mk(fld, kind)

# ---- weather (Weather.initWeather + WPart.* ; FUN_00549c10 / FUN_0054b620 saver) ----
@H('weather.initweather')
def _wi(it, args, ty, where):
    it.st['weather'] = {'initAt': where, 'textures': {}}; return True

for nm, fld, kind in (('type', 'type', 'int'), ('radius', 'radius', 'float'), ('partsize', 'partSize', 'Vec2'),
                      ('speed', 'speed', 'Vec3'), ('random', 'random', 'float'), ('numparticles', 'numParticles', 'int'),
                      ('pointspriteminsize', 'pointSpriteMinSize', 'float'),
                      ('pointspritemaxsize', 'pointSpriteMaxSize', 'float'), ('displacement', 'displacement', 'Vec3'),
                      ('color', 'color', 'Vec4'), ('fadez', 'fadeZ', 'float'), ('fadeinvalue', 'fadeInValue', 'float'),
                      ('scale', 'scale', 'Vec3'), ('acceleration', 'acceleration', 'float')):
    def mkw(fld, kind):
        def f(it, args, ty, where):
            if it.st['weather'] is None or len(args) != 1: return False
            it.st['weather'][fld] = parse_arg(kind, args[0]); return True
        return f
    HANDLERS['wpart.' + nm] = mkw(fld, kind)

@H('wpart.settexture')
def _wt(it, args, ty, where):
    if it.st['weather'] is None or len(args) != 2: return False
    it.st['weather']['textures'][args[0]] = {'name': args[1], 'path': find_texture(it.stage_dir, 'texture/' + args[1])}
    return True

# ---- hot spots (view-distance regulator; HotSpot ns, FUN_004e1c20 / FUN_004e2xxx) ----
@H('hotspot.enable')
def _he(it, args, ty, where):
    if len(args) != 1: return False
    it.st['hotspots']['enable'] = parse_bool(args[0]); return True

@H('hotspot.removeall')
def _hr(it, args, ty, where):
    it.st['hotspots']['list'] = []; it.cur_hotspot = None; return True

@H('hotspot.addhotspot')
def _ha(it, args, ty, where):
    if len(args) != 1: return False
    it.cur_hotspot = {'name': args[0]}
    it.st['hotspots']['list'].append(it.cur_hotspot); return True

for nm in ('splineDistance', 'width', 'fade', 'objectViewDistance', 'trackViewDistance', 'objectCullConst',
           'objectMinCullDistance', 'horizontalHOGDistance', 'verticalHOGDistance', 'billboardLODScale',
           'billboardFadeScale', 'objectCullFade', 'objectDistanceFade', 'mergeMeshViewDistance',
           'objectDistanceVariation'):
    def mkh(nm):
        def f(it, args, ty, where):
            if it.cur_hotspot is None or len(args) != 1: return False
            it.cur_hotspot[nm] = parse_float(args[0]); return True
        return f
    HANDLERS['hotspot.' + nm.lower()] = mkh(nm)

# ---- replay cameras (Race ns; exec 0x443c50: exactly 7 args -> replay system vcall +0x9c) ----
@H('race.replaycamerasystemmode')
def _rm(it, args, ty, where):
    it.st['replay']['modeHistory'].append(parse_float(args[0]) if args else None); return True

@H('race.addreplaycamera')
def _rc(it, args, ty, where):
    if len(args) != 7: return False
    it.st['replay']['cameras'].append({
        'type': int(parse_float(args[0])), 'a1': parse_float(args[1]), 'splineStart': parse_float(args[2]),
        'a3': parse_float(args[3]), 'pos': parse_vec(args[4], 3), 'rot': parse_vec(args[5], 3),
        'target': parse_vec(args[6], 3)})
    return True

# ----------------------------------------------------------------------------------------------------
_orig_command = Interp.command
def _command_with_name(self, w, args, where):
    self._lastcmd = w.lower()
    return _orig_command(self, w, args, where)
Interp.command = _command_with_name

# ----------------------------------------------------------------------------------------------------
def stages():
    out = []
    for name in sorted(os.listdir(FULL)):
        m = re.match(r'^(corsica|hillclimb|iceracing|kenya|newzealand|rallycross)(\d[a-c]?)([fr])$', name)
        if not m: continue
        fam, num, d = m.groups()
        tdir = os.path.join(FULL, name, 'track', fam + num, 'forward' if d == 'f' else 'reverse')
        out.append({'archive': name, 'family': fam, 'num': num, 'dir': d, 'path': tdir,
                    'id': '%s-%s-%s' % (fam, num, d)})
    return out

def tfs_file(st):
    want = (st['family'] + st['num'] + st['dir'] + '.con').lower()
    return ci_path(os.path.join(FULL, 'fogzor', 'TrackFogSettings'), want)

def resolve_stage(cmds, st):
    it = Interp(cmds, st['path'])
    variant = '4p' if st['family'] in CIRCUIT_FAMILIES else '1p'
    order = []
    def go(rel, why, base=None):
        p = ci_path(base or st['path'], rel)
        if p and os.path.isfile(p):
            order.append(os.path.relpath(p, REPO))
            it.run_file(p, why)
        else:
            order.append('MISSING ' + rel)
    p = tfs_file(st)
    if p: order.append(os.path.relpath(p, REPO)); it.run_file(p, 'TrackFogSettings (fogzor.rff, low-detail fog)')
    go('RenderSettings.con', 'loader 0x4963dc')
    go('RenderSettingsSingle%s.con' % variant, 'loader 0x49783a/0x4966d6 (PS1.1 hardware path)')
    go('GlobalRenderSettingsSingle%s.con' % variant, 'loader 0x497aae', base=os.path.join(FULL, 'common', 'track'))
    go('Sky.con', 'loader 0x497c39')
    go('lighting.con', 'loader 0x497dad')
    if ci_path(st['path'], 'Water.con'): go('Water.con', 'loader 0x497f22')
    go('Cameras.con', 'loader 0x498092')
    s = it.st
    # ---- derived / effective values ----
    f = s['fog']
    eff = {
        'note': 'high-detail path (profile track detail == 2, FUN_0049a300/FUN_0049a680): fogRange; '
                'otherwise fogRangeFixed (fogzor TrackFogSettings)',
        'track': {'enable': f['track']['enable'], 'color': f['track']['color'], 'start': None, 'end': None,
                  'clampDistance': f['track']['clamp'], 'clampFactor': None},
        'world': {'enable': f['world']['enable'], 'color': f['world']['color'], 'start': None, 'end': None},
    }
    if f['track']['range']:
        a, b = f['track']['range']; eff['track']['start'], eff['track']['end'] = a, b
        if f['track']['clamp'] is not None and b != a:
            eff['track']['clampFactor'] = max(0.0, min(1.0, (b - f['track']['clamp']) / (b - a)))
    if f['world']['range']:
        eff['world']['start'], eff['world']['end'] = f['world']['range']
    for k, ns in (('track', 'Track'), ('world', 'World')):
        unset = [n for n in ('enable', 'color', 'range') if f[k][n] is None]
        if unset:
            # verifier: the settings singleton IS reset to the FUN_0040e650 defaults by the race-level
            # reset FUN_004ac570 (and the ctor), so unset fields take the defaults below
            eff[k]['defaultedFields'] = unset
            if f[k]['enable'] is None: eff[k]['enable'] = SETTINGS_DEFAULTS[ns + '.fogEnable']
            if f[k]['color'] is None: eff[k]['color'] = SETTINGS_DEFAULTS[ns + '.fogColor']
            if f[k]['range'] is None:
                eff[k]['start'], eff[k]['end'] = SETTINGS_DEFAULTS[ns + '.fogRange']
    s['fogEffective'] = eff
    # verifier: which settings fields this stage leaves unset, with the FUN_0040e650 default the original uses
    state_path = {
        'World.fogEnable': ('fog', 'world', 'enable'), 'World.fogRange': ('fog', 'world', 'range'),
        'World.fogRangeFixed': ('fog', 'world', 'rangeFixed'), 'World.fogColor': ('fog', 'world', 'color'),
        'Track.fogEnable': ('fog', 'track', 'enable'), 'Track.fogRange': ('fog', 'track', 'range'),
        'Track.fogRangeFixed': ('fog', 'track', 'rangeFixed'), 'Track.fogColor': ('fog', 'track', 'color'),
        'Track.fogClamp': ('fog', 'track', 'clamp'), 'Track.viewDistance': ('track', 'viewDistance'),
        'track.bumpHeight': ('track', 'bumpHeight'), 'track.specularColor': ('track', 'specularColor'),
        'track.lightmapLimit': ('track', 'lightmapLimit'), 'game.trackGammaDelta': ('game', 'trackGammaDelta'),
        'game.gamma': ('game', 'gamma'), 'game.brightness': ('game', 'brightness'), 'game.contrast': ('game', 'contrast'),
        'game.lightColor': ('game', 'lightColor'), 'game.shadowColor': ('game', 'shadowColor'),
        'game.particleLightmapMin': ('game', 'particleLightmapMin'), 'game.drawSkidMarks': ('game', 'drawSkidMarks'),
        'game.drawWorld': ('game', 'drawWorld'), 'game.dynamicShadows': ('game', 'dynamicShadows'),
        'game.enableAnimationTriggerSystem': ('game', 'enableAnimationTriggerSystem'),
        'Object.viewDistance': ('objects', 'viewDistance'), 'Object.distanceFade': ('objects', 'distanceFade'),
        'object.cullFade': ('objects', 'cullFade'),
        'mergeMesh.sideScreenViewDistance': ('objects', 'mergeMesh', 'sideScreenViewDistance'),
        'mergeMesh.sideScreenFade': ('objects', 'mergeMesh', 'sideScreenFade'),
        'mergeMesh.sideScreenAlphaRef': ('objects', 'mergeMesh', 'sideScreenAlphaRef'),
        'renderer.fieldOfView': ('objects', 'fieldOfView'),
        'car.lightColor': ('car', 'lightColor'), 'car.ambient': ('car', 'ambient'),
        'Car.lightmapMin': ('car', 'lightmapMin'), 'Car.lightmapMax': ('car', 'lightmapMax'),
        'Car.lightmapClamp': ('car', 'lightmapClamp'), 'Car.shadowHeightScale': ('car', 'shadowHeightScale'),
        'car.shadowColor': ('car', 'shadowColor'), 'car.dropShadowColor': ('car', 'dropShadowColor'),
    }
    dflt = {}
    for key, path in state_path.items():
        v = s
        for q in path:
            v = v.get(q) if isinstance(v, dict) else None
        if v is None:
            dflt[key] = SETTINGS_DEFAULTS[key]
    s['defaultsApplied'] = dflt
    sd = s['sky']['sunLightDir']
    s['sky']['sunLightDirThree'] = [sd[0], sd[1], -sd[2]]
    s['sky']['sunElevationDeg'] = math.degrees(math.asin(max(-1, min(1, sd[1])))) if any(sd) else None
    s['sky']['sunHeadingSimDeg'] = math.degrees(math.atan2(sd[0], sd[2])) if any(sd) else None
    # the lens flare template driving the sun
    sunobj = s['sky']['sunObject']
    # keep only the lens-flare templates (the CarFX particle templates belong to the particle topic)
    s['objectTemplates'] = {k: v for k, v in s['objectTemplates'].items()
                            if (v.get('class') or '').lower() == 'lensflare' or v.get('flares') or v.get('coronas')}
    s['sky']['sunFlareTemplate'] = None
    for o in s['objectsCreated']:
        if sunobj and (o.get('name') or '').lower() == sunobj.lower():
            s['sky']['sunFlareTemplate'] = o.get('template')
    return {'id': st['id'], 'archive': st['archive'], 'family': st['family'], 'direction': st['dir'],
            'trackDir': os.path.relpath(st['path'], REPO), 'renderSettingsVariant': 'Single' + variant,
            'executionOrder': order, 'env': s, 'provenance': it.prov, 'files': it.files,
            'ignoredCommands': it.ignored, 'rejectedArgs': it.badargs, 'outOfScopeCommands': it.passthrough}

# ----------------------------------------------------------------------------------------------------
# validation over ALL files of the format (incl. the Small* variants not used by the resolved path)
# ----------------------------------------------------------------------------------------------------
FORMAT_FILES = ('Sky.con', 'lighting.con', 'RenderSettings.con', 'RenderSettingsSingle1p.con',
                'RenderSettingsSingle4p.con', 'RenderSettingsSmallSingle1p.con', 'RenderSettingsSmallSingle4p.con',
                'Water.con', 'Cameras.con')

def validate_all(cmds):
    rep = {'byKind': {}, 'files': 0, 'failed': 0, 'leftoverBytes': 0, 'unknownCommands': {}}
    seen = set()
    def one(path, kind, stage_dir):
        it = Interp(cmds, stage_dir)
        try:
            r = it.run_file(path, 'validation')
        except Exception as e:  # noqa
            rep['failed'] += 1; return
        k = rep['byKind'].setdefault(kind, {'files': 0, 'bytes': 0, 'lines': 0, 'commands': 0, 'rem': 0, 'blank': 0,
                                           'control': 0, 'ignored': 0, 'leftoverBytes': 0})
        for rr in it.files:
            if rr['file'] in seen and rr is not r: continue
            seen.add(rr['file'])
        k['files'] += 1
        for f in ('bytes', 'lines', 'commands', 'rem', 'blank', 'control', 'ignored', 'leftoverBytes'):
            k[f] += r[f]
        rep['files'] += 1; rep['leftoverBytes'] += r['leftoverBytes']
        for ig in it.ignored:
            key = ig['line'].split()[0].lower()
            rep['unknownCommands'][key] = rep['unknownCommands'].get(key, 0) + 1
    for st in stages():
        for fn in FORMAT_FILES:
            p = ci_path(st['path'], fn)
            if p: one(p, fn, st['path'])
    for f in sorted(os.listdir(os.path.join(FULL, 'fogzor', 'TrackFogSettings'))):
        one(os.path.join(FULL, 'fogzor', 'TrackFogSettings', f), 'TrackFogSettings/*.con', FULL)
    for f in sorted(os.listdir(os.path.join(FULL, 'common', 'track'))):
        one(os.path.join(FULL, 'common', 'track', f), 'common/track/Global*.con', FULL)
    lv = os.path.join(FULL, 'Misc', 'level')
    for f in sorted(os.listdir(lv)):
        if re.match(r'(lenz|env_|flare_remove|swing|reducepfx|dropshadows|heatshimmer)', f, re.I):
            one(os.path.join(lv, f), 'Misc/level/<run targets>', FULL)
    return rep

# ----------------------------------------------------------------------------------------------------
# images
# ----------------------------------------------------------------------------------------------------
def load_img(rel):
    from PIL import Image
    return Image.open(os.path.join(REPO, rel)).convert('RGBA')

def sky_cross(env, size=256):
    """horizontal cross: row0 [_,TOP,_,_] row1 [LFT,FRT,RGT,BAK] row2 [_,(no bottom face),_,_].
    Face orientation from the quads in FUN_00547ee0 (see spec): side faces read left->right when viewed from
    inside; TOP has v=0 at +z (front) and u=0 at +x, so it is rotated 180 deg to sit on FRT's top edge."""
    from PIL import Image, ImageDraw
    fc = env['sky'].get('faces') or {}
    img = Image.new('RGB', (size * 4, size * 3), (40, 40, 40))
    def put(k, x, y, rot=0):
        if not fc.get(k): return
        im = load_img(fc[k]).convert('RGB').resize((size, size))
        if rot: im = im.rotate(rot)
        img.paste(im, (x * size, y * size))
    put('top', 1, 0, 180); put('left', 0, 1); put('front', 1, 1); put('right', 2, 1); put('back', 3, 1)
    d = ImageDraw.Draw(img)
    d.text((size + 4, 2 * size + 4), 'no bottom face (SKYBOT_A not loaded, FUN_00547c40)', fill=(200, 200, 200))
    for i, k in enumerate(('LFT -x', 'FRT +z', 'RGT +x', 'BAK -z')):
        d.text((i * size + 4, size + 4), k, fill=(255, 255, 0))
    d.text((size + 4, 4), 'TOP +y (rot 180)', fill=(255, 255, 0))
    return img

def sample_sky(faces, imgs, dx, dy, dz):
    """direction in SKY-BOX local space (before setRotAngle) -> RGB, using the quads of FUN_00547ee0."""
    ax, ay, az = abs(dx), abs(dy), abs(dz)
    if ay >= ax and ay >= az:
        if dy < 0: return None
        # TOP (y=+S): u = (S - x)/2S, v = (S - z)/2S
        x, z = dx / ay, dz / ay; k = 'top'; u = (1 - x) / 2; v = (1 - z) / 2
    elif ax >= az:
        y, z = dy / ax, dz / ax
        if dx < 0: k = 'left'; u = (z + 1) / 2; v = (1 - y) / 2      # x=-S: u from -z to +z
        else: k = 'right'; u = (1 - z) / 2; v = (1 - y) / 2          # x=+S: u from +z to -z
    else:
        x, y = dx / az, dy / az
        if dz > 0: k = 'front'; u = (x + 1) / 2; v = (1 - y) / 2     # z=+S: u from -x to +x
        else: k = 'back'; u = (1 - x) / 2; v = (1 - y) / 2           # z=-S: u from +x to -x
    im = imgs.get(k)
    if im is None: return None
    w, h = im.size
    return im.getpixel((min(w - 1, max(0, int(u * w))), min(h - 1, max(0, int(v * h)))))[:3]

def sky_panorama(env, W=1024, H=320, pitch_min=-15, pitch_max=75):
    """equirectangular view of the box as the player sees it: world heading (sim: 0 = +z, +90 = +x) on x,
    elevation on y.  Box rotation (setRotAngle, deg, x' = x cos + z sin) and ofsSkyHeight (box centre =
    camera + (0, ofs, 0), half size 3000 m) applied.  Sun marker at sky.sunLightDir."""
    from PIL import Image, ImageDraw
    fc = env['sky'].get('faces') or {}
    imgs = {k: load_img(v).convert('RGB') for k, v in fc.items() if v}
    a = math.radians(env['sky']['rotAngleDeg'] or 0.0)
    ofs = env['sky']['ofsSkyHeight'] or 0.0
    S = 3000.0
    img = Image.new('RGB', (W, H), (0, 0, 0))
    px = img.load()
    for j in range(H):
        el = math.radians(pitch_max - (pitch_max - pitch_min) * j / (H - 1))
        for i in range(W):
            hd = math.radians(-180 + 360 * i / W)
            wx, wy, wz = math.cos(el) * math.sin(hd), math.sin(el), math.cos(el) * math.cos(hd)
            # world dir -> box-local: ray from camera (box local origin at (0,-ofs,0)) hits the box; for
            # sampling we only need the direction from the box centre of the hit point.
            # inverse of row-vector rotation M (x'=x c + z s ; z' = -x s + z c): local = R^T world
            lx = wx * math.cos(a) - wz * math.sin(a)
            lz = wx * math.sin(a) + wz * math.cos(a)
            ly = wy
            # intersect ray o=(0,-ofs,0) + t*l with the cube |.|=S
            ts = []
            for comp, o in ((lx, 0.0), (ly, -ofs), (lz, 0.0)):
                if abs(comp) > 1e-9:
                    ts.append(((S if comp > 0 else -S) - o) / comp)
            t = min(tt for tt in ts if tt > 0)
            hx, hy, hz = lx * t, -ofs + ly * t, lz * t
            c = sample_sky(fc, imgs, hx, hy, hz)
            px[i, j] = c if c else (30, 20, 20)
    d = ImageDraw.Draw(img)
    sd = env['sky']['sunLightDir']
    if any(sd):
        hd = math.degrees(math.atan2(sd[0], sd[2])); el = math.degrees(math.asin(max(-1, min(1, sd[1]))))
        x = (hd + 180) / 360 * W; y = (pitch_max - el) / (pitch_max - pitch_min) * (H - 1)
        d.ellipse((x - 9, y - 9, x + 9, y + 9), outline=(255, 0, 0), width=2)
        d.text((x + 11, y - 6), 'sunLightDir', fill=(255, 0, 0))
    yh = (pitch_max - 0) / (pitch_max - pitch_min) * (H - 1)
    d.line((0, yh, W, yh), fill=(255, 255, 0))
    for hdg in range(-180, 181, 45):
        x = (hdg + 180) / 360 * W
        d.line((x, H - 8, x, H), fill=(255, 255, 255)); d.text((x + 2, H - 18), str(hdg), fill=(255, 255, 255))
    return img

def rgb255(c):
    return tuple(int(round(max(0, min(1, v)) * 255)) for v in c[:3])

def screenshot_check(st, env, W=320):
    """screenshots + swatches: track fog colour, world fog colour, sky horizon colour (box side faces at the
    camera's eye level), and the measured colour of the top-of-frame / horizon band of each screenshot."""
    from PIL import Image, ImageDraw
    shots = []
    sdir = ci_path(st['path'], 'Screenshots')
    if sdir:
        for f in sorted(os.listdir(sdir))[:4]:
            if f.lower().endswith('.tga'):
                shots.append(Image.open(os.path.join(sdir, f)).convert('RGB'))
    rows = max(1, len(shots))
    img = Image.new('RGB', (W + 420, rows * (W * 3 // 4) + 40), (24, 24, 24))
    d = ImageDraw.Draw(img)
    fe = env['fogEffective']
    sw = [('track fog', fe['track']['color']), ('world fog', fe['world']['color'])]
    fc = env['sky'].get('faces') or {}
    imgs = {k: load_img(v).convert('RGB') for k, v in fc.items() if v}
    hz = []
    ofs = env['sky']['ofsSkyHeight'] or 0.0
    for k in ('front', 'right', 'back', 'left'):
        im = imgs.get(k)
        if not im: continue
        w, h = im.size
        v = (3000.0 + ofs) / 6000.0      # eye level on the side faces
        row = int(v * h)
        band = [im.getpixel((x, min(h - 1, row + dy)))[:3] for x in range(0, w, 4) for dy in (-3, 0, 3)]
        hz.append(tuple(sum(c[i] for c in band) // len(band) for i in range(3)))
    if hz:
        sw.append(('sky @ eye level', [sum(c[i] for c in hz) / len(hz) / 255 for i in range(3)]))
    y = 4
    d.text((4, y), '%s  (rot %s deg, ofsSkyHeight %s)' % (st['id'], env['sky']['rotAngleDeg'], ofs), fill=(255, 255, 255))
    y = 24
    for i, sh in enumerate(shots):
        th = sh.resize((W, W * sh.size[1] // sh.size[0]))
        img.paste(th, (4, y))
        # measured: mean of the top 8% rows (sky) and of a band at 45% height (distance haze/horizon)
        top = sh.crop((0, 0, sh.size[0], max(1, sh.size[1] // 12))).resize((1, 1)).getpixel((0, 0))
        mid = sh.crop((0, int(sh.size[1] * 0.40), sh.size[0], int(sh.size[1] * 0.48))).resize((1, 1)).getpixel((0, 0))
        x0 = W + 12
        for j, (lab, col) in enumerate([('shot top', [c / 255 for c in top]), ('shot 40-48%', [c / 255 for c in mid])] + sw):
            if col is None: continue
            c = rgb255(col)
            yy = y + j * 26
            d.rectangle((x0, yy, x0 + 40, yy + 20), fill=c)
            d.text((x0 + 48, yy + 4), '%-14s %3d %3d %3d' % (lab, *c), fill=(230, 230, 230))
        y += th.size[1] + 8
    return img

def make_images(dump, only_ids):
    from PIL import Image
    os.makedirs(ART, exist_ok=True)
    made = []
    byid = {s['id']: s for s in dump['stages']}
    for sid in only_ids:
        s = byid[sid]; env = s['env']
        p = os.path.join(ART, 'skybox_cross_%s.png' % sid); sky_cross(env).save(p); made.append(p)
        p = os.path.join(ART, 'sky_panorama_%s.png' % sid); sky_panorama(env).save(p); made.append(p)
        st = next(x for x in stages() if x['id'] == sid)
        p = os.path.join(ART, 'screenshot_check_%s.png' % sid); screenshot_check(st, env).save(p); made.append(p)
    # contact sheet: all 48 panoramas (small)
    sheet_w, ph = 512, 160
    sheet = Image.new('RGB', (sheet_w * 4, ph * 12), (0, 0, 0))
    from PIL import ImageDraw
    dd = ImageDraw.Draw(sheet)
    for i, s in enumerate(dump['stages']):
        pan = sky_panorama(s['env'], W=sheet_w, H=ph)
        sheet.paste(pan, ((i % 4) * sheet_w, (i // 4) * ph))
        dd.text(((i % 4) * sheet_w + 4, (i // 4) * ph + 4), s['id'], fill=(255, 255, 255))
    p = os.path.join(ART, 'sky_panoramas_all48.png'); sheet.save(p); made.append(p)
    return made

# ----------------------------------------------------------------------------------------------------
def hexcol(c):
    if c is None: return None
    r, g, b = rgb255(c)
    return '0x%02x%02x%02x' % (r, g, b)

def web_preset(st_entry):
    """proposed mapping onto rally-web's EnvironmentPreset (src/core/types.ts) -- see spec 'Web plan'.
    Colours are gamma-space 0..1 values from the scripts (no sRGB conversion: render with
    ColorManagement disabled, LinearSRGB output, NoToneMapping)."""
    from PIL import Image
    env = st_entry['env']; fe = env['fogEffective']; sky = env['sky']; g = env['game']
    fc = sky.get('faces') or {}
    top = hz = None
    try:
        if fc.get('top'):
            im = Image.open(os.path.join(REPO, fc['top'])).convert('RGB')
            w, h = im.size
            top = im.crop((w // 4, h // 4, 3 * w // 4, 3 * h // 4)).resize((1, 1)).getpixel((0, 0))
        cols = []
        for k in ('front', 'right', 'back', 'left'):
            if not fc.get(k): continue
            im = Image.open(os.path.join(REPO, fc[k])).convert('RGB')
            w, h = im.size
            v = (3000.0 + (sky['ofsSkyHeight'] or 0.0)) / 6000.0
            y0 = max(0, int(v * h) - max(1, h // 32)); y1 = min(h, int(v * h) + 1)
            cols.append(im.crop((0, y0, w, y1)).resize((1, 1)).getpixel((0, 0)))
        if cols:
            hz = tuple(sum(c[i] for c in cols) // len(cols) for i in range(3))
    except Exception:
        pass
    sd = sky['sunLightDir']
    light = g['lightColor'] or SETTINGS_DEFAULTS['game.lightColor']
    shadow = g['shadowColor'] or SETTINGS_DEFAULTS['game.shadowColor']
    wp = None
    if env.get('weather'):
        wp = 'snow' if env['weather'].get('type') == 0 else 'rain'
    el = sky.get('sunElevationDeg')
    return {
        'skyTop': '0x%02x%02x%02x' % top if top else None,
        'skyHorizon': '0x%02x%02x%02x' % hz if hz else None,
        'fogColor': hexcol(fe['track']['color']),
        'fogNear': fe['track']['start'], 'fogFar': fe['track']['end'],
        'fogClampDistance': fe['track']['clampDistance'],
        'fogEnabled': bool(fe['track']['enable']),
        'worldFog': {'color': hexcol(fe['world']['color']), 'near': fe['world']['start'], 'far': fe['world']['end'],
                     'enabled': bool(fe['world']['enable'])},
        'sunDir': {'x': sd[0], 'y': sd[1], 'z': -sd[2]},
        # objects/trees: colour = 2 * tex * lerp(shadow, light, max(0, N.sun)) (meshshader.vs/trunk.vs + x2 stage)
        'sunColor': hexcol([min(1.0, 2 * (l - s)) for l, s in zip(light, shadow)]),
        'sunIntensity': 1.0,
        'ambientSky': hexcol([min(1.0, 2 * s) for s in shadow]),
        'ambientGround': hexcol([min(1.0, 2 * s) for s in shadow]),
        'ambientIntensity': 1.0,
        'weather': wp or 'clear',
        'exposure': 1.0,
        'timeOfDayNote': 'not in the original data; sun elevation %.1f deg' % el if el is not None else None,
    }

def main():
    cmds = load_cmds()
    dump = {'format': 'rally-web environment dump v1',
            'generatedBy': 'research/tools/fmt_environment.py',
            'spec': 'research/formats/environment.md',
            'frames': {'sunLightDir': 'SIM space (left-handed, x right, y up, z forward); three = (x, y, -z)',
                       'colours': 'linear 0..1 floats as written in the scripts; the original renders in gamma '
                                  'space (no sRGB conversion)'},
            'settingsDefaults': {'source': 'FUN_0040e650 (called by ctor FUN_0040e2e0 and race-level reset '
                                           'FUN_004ac570): value of every settings field a stage leaves unset',
                                 'values': SETTINGS_DEFAULTS},
            'stages': []}
    for st in stages():
        e = resolve_stage(cmds, st)
        e['webPreset'] = web_preset(e)
        dump['stages'].append(e)
    dump['validation'] = validate_all(cmds)
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    json.dump(dump, open(OUT_JSON, 'w'), indent=1)
    v = dump['validation']
    print('stages resolved:', len(dump['stages']))
    print('format files parsed:', v['files'], 'failed:', v['failed'], 'leftover bytes:', v['leftoverBytes'])
    for k, r in sorted(v['byKind'].items()):
        print('  %-34s files %3d bytes %7d lines %5d cmds %5d rem %4d blank %4d ctrl %4d ignored %3d leftover %d' % (
            k, r['files'], r['bytes'], r['lines'], r['commands'], r['rem'], r['blank'], r['control'], r['ignored'],
            r['leftoverBytes']))
    print('commands unknown to the original console:', v['unknownCommands'])
    if '--no-images' not in sys.argv:
        reps = ['corsica-1-f', 'hillclimb-1a-f', 'iceracing-1-f', 'kenya-1-f', 'newzealand-1-f', 'rallycross-1-f']
        made = make_images(dump, reps)
        print('images:', len(made))

if __name__ == '__main__':
    main()
