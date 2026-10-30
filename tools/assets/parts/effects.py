"""effects part — the original car effects (research/formats/effects.md): the per-material CarFx particle
emitters (dust / gravel / mud / snow / water spray, tyre smoke), the exhaust bursts, skid marks, the car drop
shadow and the projected-lightmap light that the particles use.

The definitions are console scripts. This part evaluates them the way the original's loader does
(effects.md §1): the startup scripts (`object/Skidmarks.con` from ObjectTemplates.con), then per stage the
render-settings chain RenderSettings.con -> RenderSettingsSingle{1p|4p}.con -> GlobalRenderSettingsSingle{1p|4p}
-> Sky.con -> lighting.con -> Water.con -> Cameras.con (environment.md §1; the `run object/CarFX_Mat_NN` lines
create the material templates, `ObjectTemplate.setActive X` + properties override them per stage,
`run level/reducePFX` on the 4p variant), then the per-car scripts Player.con runs (PFX_Template.con adds the
17 CarFX_<Surface>_Base children — only the ones whose template exists; Burst.con adds the exhaust FX).

Outputs (version 1):
  stages/<id>/effects.json   templates {name: Emitter | SpriteParticle | CarFx} with every property defaulted
                             (effects.md §3-§5: emitter ctor FUN_00788f80, sprite data ctor at 0x4b7..,
                             over-time curves as key lists), carFx (the CarFx bases a car gets on this stage, in
                             PFX_Template order, duplicates kept), particle system settings (enable, global colour,
                             maxParticles, particleLightmap min/max/clamp), skid marks (per material trig levels /
                             extra width / intensity clamp / colour, drawSkidMarks), drop-shadow settings, the
                             skid texture and every particle texture as texIds (volume depth = animation frames)
  stages/<id>/effects.bin    particle light grid (effects.md §6.4): the stage lightmaps (P8 index through the
                             particle LUT FUN_004e0780) sampled every LIGHT_CELL m in sparse 32x32-cell tiles near
                             the AI splines; RGB8 per cell (layout in effects.json `light`)
  cars/<Name>/effects.json   exhaust FX placements (Burst.con), drop shadow texture + DropShadows.con scale +
                             the BodyShadow.sm box (the drop-shadow quad, effects.md §8)
  global/effects.json        the startup skid table (Skidmarks.con), skid texture, default drop shadow texture

Positions stay in the original SIM frame (car body frame for the CarFx children / exhaust); the runtime mirrors.
"""
import json
import os
import re
import struct

import numpy as np

import fmt_environment as E

PART = 'effects'
VERSION = 1

MISC = os.path.join(E.FULL, 'Misc')
COMMON_TRACK = os.path.join(E.FULL, 'common', 'track')

# effects.md §5.1: SpriteParticle data defaults (ctor, research/decomp/all.c line ~213150)
SPRITE_DEFAULTS = {
    'hasCollisionPhysics': False, 'collisionElasticConstant': 0.9, 'collisionOffset': 0.0, 'attatchToEmitter': False,
    'closeDistCullConst': 0.95, 'closeDistCullFadeConst': 0.7, 'alphaCull': 2.0, 'scaleWithSpeedFactor': 0.0,
    'maxParticlesPercentage': 1.0,
    'timeToLive': [0, 10.0, 0.0, False], 'size': [0, 1.0, 0.0, False], 'gravityModifier': [0, 1.0, 0.0, False],
    'dragInDof': [0, 0.0, 0.0, False], 'XYSizeRatio': [0, 1.0, 0.0, False], 'rotationSpeed': [0, 0.0, 0.0, False],
    'initRotation': [0, 0.0, 0.0, False], 'varianceColor': [0, 0.0, 0.0, False], 'alphaTestRef': [0, 0.0, 0.0, False],
    'initAnimationFrame': [0, 0.0, 0.0, False], 'animationSpeed': [0, 0.0, 0.0, False],
    'useUVRotation': False, 'useShimmer': False, 'useGradiantLighting': False, 'useProjectedLightmaps': False,
    'usePointSprites': False, 'turnsInMovingDirection': False,
    'srcBlendMode': 5, 'destBlendMode': 6,           # D3DBLEND_SRCALPHA / INVSRCALPHA (ctor [0x170]/[0x171])
}
SPRITE_OT = ('sizeOverTime', 'gravityModifierOverTime', 'dragInDofOverTime', 'XYSizeRatioOverTime',
             'rotationSpeedOverTime', 'alphaTestRefOverTime', 'animationSpeedOverTime')
# effects.md §4.1: Emitter template defaults (ctor FUN_00788f80)
EMITTER_DEFAULTS = {
    'looping': False, 'removeWhenFinished': False, 'startAtCreation': False, 'addEmitterSpeed': False,
    'emitterSpeedScale': 1.0, 'interpolatePosition': True, 'predictePosition': False, 'startProbability': 1.0,
    'useCameraOrientation': False,
    'timeToLive': [0, 10.0, 0.0, False], 'intensity': [0, 1.0, 0.0, False],
}
EMITTER_RD3 = ('relativePositionIn', 'positionalSpeedIn', 'rotationalSpeedIn')
AXES = ('Dof', 'Up', 'Right')
# D3DBLEND values of the script's BlendMode names (dice::ref2::rend::BlendMode, FUN_00774c10)
BLEND = {'bmzero': 1, 'bmone': 2, 'bmsourcecolor': 3, 'bminvsourcecolor': 4, 'bmsourcealpha': 5,
         'bminvsourcealpha': 6, 'bmdestalpha': 7, 'bminvdestalpha': 8, 'bmdestcolor': 9, 'bminvdestcolor': 10,
         'bmsourcealphasat': 11}
CRD = {'crd_none': 0, 'crd_uniform': 1, 'crd_exponential': 2, 'crd_normal': 3}   # FUN_00768430

# effects.md §7: skid renderer defaults (ctor FUN_007e6550): extra width 0, clamp 1, colour (1,1,1); trig levels 0
NUM_MATERIALS = 32
# settings defaults FUN_0040e650 (effects.md §6.4, §8)
DEFAULTS = {
    'particleLightmapMin': [0.2, 0.2, 0.2], 'particleLightmapMax': [1.0, 1.0, 1.0], 'particleLightmapClamp': [0.0, 0.5],
    'dropShadowColor': [0.2, 0.2, 0.2], 'dropShadowFadeOffset': 0.3, 'dropShadowFadeScale': 2.0,
    'drawSkidMarks': True, 'dynamicShadows': False, 'enableParticles': True, 'globalParticleColor': [1.0, 1.0, 1.0, 1.0],
    'maxParticles': 3000,                                                        # DAT_0084c638
    'cullDistCars': 250.0,                                                       # FUN_00411c60(250)
}
LIGHT_CELL = 4.0          # m per particle-light cell (runtime samples per particle; the original per pixel)
LIGHT_TILE = 32           # cells per tile side
LIGHT_BAND = 80.0         # m around the AI spline CVs that get light tiles


# ------------------------------------------------------------------------------------------- parsing helpers
_num = re.compile(r'[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?')


def fnum(tok, default=0.0):
    m = _num.match(tok.strip()) if tok is not None else None
    return float(m.group(0)) if m else default


def vec(tok, n):
    """Console Vec: numbers separated by any single char, missing trailing components repeat the last
    (environment.md §2, Vec parser 0x433100)."""
    vals = [float(m.group(0)) for m in _num.finditer(tok)]
    if not vals:
        return None
    while len(vals) < n:
        vals.append(vals[-1])
    return vals[:n]


def boolean(tok):
    return fnum(tok) != 0.0


def rd(tok):
    """RandomDistribution `CRD_<TYPE>/a/b/sym` -> [type, a, b, sym] (FUN_00768430, sampler FUN_00576620)."""
    parts = tok.split('/')
    t = CRD.get(parts[0].strip().lower())
    if t is None:
        return None
    a = fnum(parts[1]) if len(parts) > 1 else 0.0
    b = fnum(parts[2]) if len(parts) > 2 else 0.0
    s = boolean(parts[3]) if len(parts) > 3 else False
    return [t, a, b, s]


def overtime(tok, comps):
    """OverTimeDistribution `t/v|t/v|...` (t = percent 0..100) -> [[t, v...], ...] sorted, last key per t wins."""
    keys = {}
    for seg in tok.split('|'):
        vals = [float(m.group(0)) for m in _num.finditer(seg)]
        if len(vals) < 1 + comps:
            continue
        t = int(round(vals[0]))
        if 0 <= t <= 100:
            keys[t] = vals[1:1 + comps]
    return [[t] + keys[t] for t in sorted(keys)]


# ------------------------------------------------------------------------------------------- interpreter
class FxInterp:
    """The particle / skid / shadow slice of the console (effects.md §2). Case-insensitive commands; the
    `set` prefix strip rule; Vec repeat rule; `run` with `level/` / `object/` roots."""

    def __init__(self, stage_dir=None):
        self.stage_dir = stage_dir or MISC
        self.templates = {}            # lower name -> template dict
        self.order = []                # creation order (lower names)
        self.cur = None
        self.cur_child = None
        self.files = []
        self.missing_runs = []
        self.skid = {
            'trig': [[0.0, 0.0, 0.0, 0.0] for _ in range(NUM_MATERIALS)],
            'extraWidth': [0.0] * NUM_MATERIALS,
            'intensityClamp': [1.0] * NUM_MATERIALS,
            'color': [[1.0, 1.0, 1.0] for _ in range(NUM_MATERIALS)],
        }
        self.settings = {}
        self.drop_scales = {}

    # ---- files
    def run_file(self, path):
        self.files.append(os.path.relpath(path, E.FULL))
        text = open(path, 'rb').read().decode('latin1')
        skip = []
        for line in re.split(r'\r\n|\n|\r', text):
            t = line.strip()
            if not t:
                continue
            toks = t.split()
            w = toks[0].lower()
            if w == 'if':
                skip.append(not (fnum(toks[1]) != 0 if len(toks) > 1 else False) or any(skip))
                continue
            if w == 'endif':
                if skip:
                    skip.pop()
                continue
            if w == 'else':
                if skip:
                    skip[-1] = not skip[-1]
                continue
            if any(skip) or w == 'rem' or w.startswith('rem'):
                continue
            if w == 'run':
                if len(toks) > 1:
                    p = E.resolve_run(self.stage_dir, toks[1])
                    if p:
                        self.run_file(p)
                    else:
                        self.missing_runs.append(toks[1])   # CarFX_Hillclimb / Snow / Desert: absent (environment.md §2)
                continue
            if '.' not in toks[0]:
                continue
            self.command(toks[0], toks[1:])

    # ---- commands
    def command(self, w, args):
        ns, _, name = w.partition('.')
        ns = ns.lower()
        name = name.lower()
        if ns == 'objecttemplate':
            self.object_template(name, args)
        elif ns == 'skidmark':
            self.skidmark(name, args)
        elif ns == 'particlesystem':
            self.particle_system(name, args)
        elif ns == 'game':
            self.game(name, args)
        elif ns == 'car':
            self.car(name, args)

    def object_template(self, name, args):
        if name == 'create':
            if len(args) < 2:
                return
            t = {'name': args[1], 'type': args[0], 'props': {}, 'children': []}
            key = args[1].lower()
            if key not in self.templates:
                self.order.append(key)
            self.templates[key] = t
            self.cur, self.cur_child = t, None
            return
        if name in ('active', 'setactive'):
            if args:
                self.cur = self.templates.get(args[0].lower())
                self.cur_child = None
            return
        if self.cur is None or not args:
            return                                 # no active template, or a 0-argument "get"
        if name == 'addtemplate':
            ch = {'template': args[0], 'pos': [0.0, 0.0, 0.0], 'rot': [0.0, 0.0, 0.0], 'fx': {}}
            self.cur['children'].append(ch)
            self.cur_child = ch
            return
        if name in ('setposition', 'setrotation'):
            v = vec(args[0], 3)
            if v is not None and self.cur_child is not None:
                self.cur_child['pos' if name == 'setposition' else 'rot'] = v
            return
        if name.startswith('fx_'):
            if self.cur_child is not None:
                self.cur_child['fx'][name[3:]] = args[0]
            return
        # property: keep the raw text, typed at export (last write wins)
        raw = ' '.join(args)
        prev = self.cur['props'].get(name)
        if prev is not None and prev.upper().startswith('CRD_') and not raw.upper().startswith('CRD_'):
            # a RandomDistribution written without its CRD_ type (CarFX_Mat_05.con:473 `objectTemplate.intensity
            # 40`): the stream operator (0x768600) reads the whole token as the type name (no match -> NONE, the
            # type is zeroed first by FUN_00768430) and the a / b / sym reads then fail at the end of the
            # stream, leaving the previous values (effects.md §2.3)
            parts = prev.split('/')
            parts[0] = 'CRD_NONE'
            raw = '/'.join(parts)
        self.cur['props'][name] = raw

    def skidmark(self, name, args):
        if name.startswith('set'):
            name = name[3:]
        try:
            m = int(fnum(args[0], -1)) if args else -1
        except ValueError:
            return
        if not 0 <= m < NUM_MATERIALS:
            return
        if name == 'materialtriglevels' and len(args) == 5:         # 0x787440: 4 floats at +0x58 + 16·m
            self.skid['trig'][m] = [fnum(a) for a in args[1:5]]
        elif name == 'materialskidmarkextrawidth' and len(args) == 2:
            self.skid['extraWidth'][m] = fnum(args[1])
        elif name == 'intensityclamp' and len(args) == 2:
            self.skid['intensityClamp'][m] = fnum(args[1])
        elif name == 'color' and len(args) == 2:
            v = vec(args[1], 3)
            if v is not None:
                self.skid['color'][m] = v

    def particle_system(self, name, args):
        if not args:
            return
        if name == 'enableparticles':
            self.settings['enableParticles'] = boolean(args[0])
        elif name == 'globalparticlecolor':
            v = vec(args[0], 4)
            if v is not None:
                self.settings['globalParticleColor'] = v
        elif name == 'maxparticles':
            self.settings['maxParticles'] = int(fnum(args[0]))
        elif name == 'shadowcolor':
            # registered (FUN_00784c40) but no consumer traced: recorded only (effects.md §6.3)
            v = vec(args[0], 3)
            if v is not None:
                self.settings['particleShadowColor'] = v
        # `ParticleSystem.LightColor` is not registered in the exe: ignored like the original console

    def game(self, name, args):
        if not args:
            return
        if name in ('particlelightmapmin', 'particlelightmapmax'):
            v = vec(args[0], 3)
            if v is not None:
                self.settings['particleLightmapMin' if name.endswith('min') else 'particleLightmapMax'] = v
        elif name == 'particlelightmapclamp':
            v = vec(args[0], 2)
            if v is not None:
                self.settings['particleLightmapClamp'] = v
        elif name == 'drawskidmarks':
            self.settings['drawSkidMarks'] = boolean(args[0])
        elif name == 'dynamicshadows':
            self.settings['dynamicShadows'] = boolean(args[0])

    def car(self, name, args):
        if not args:
            return
        if name == 'dropshadowcolor':
            v = vec(args[0], 3)
            if v is not None:
                self.settings['dropShadowColor'] = v
        elif name == 'dropshadowfadeoffset':
            self.settings['dropShadowFadeOffset'] = fnum(args[0])
        elif name == 'dropshadowfadescale':
            self.settings['dropShadowFadeScale'] = fnum(args[0])
        elif name == 'setdropshadowscale' and len(args) == 2:
            v = vec(args[1], 3)
            if v is not None:
                self.drop_scales[args[0].lower()] = v


# ------------------------------------------------------------------------------------------- export
def _prop(props, key):
    return props.get(key.lower())


def export_emitter(t):
    p = t['props']
    out = {'type': 'Emitter', 'template': (_prop(p, 'template') or '').strip()}
    for k, d in EMITTER_DEFAULTS.items():
        raw = _prop(p, k)
        if raw is None:
            out[k] = d
        elif isinstance(d, bool):
            out[k] = boolean(raw)
        elif isinstance(d, list):
            out[k] = rd(raw) or d
        else:
            out[k] = fnum(raw, d)
    raw = _prop(p, 'intensityOverTime')
    out['intensityOverTime'] = overtime(raw, 1) if raw else []
    for base in EMITTER_RD3:
        out[base] = [rd(_prop(p, base + ax) or '') or [0, 0.0, 0.0, False] for ax in AXES]
    return out


def export_sprite(t, tex_fn):
    p = t['props']
    out = {'type': 'SpriteParticle'}
    for k, d in SPRITE_DEFAULTS.items():
        raw = _prop(p, k)
        if raw is None:
            out[k] = d
        elif k in ('srcBlendMode', 'destBlendMode'):
            out[k] = BLEND.get(raw.strip().lower(), d)
        elif isinstance(d, bool):
            out[k] = boolean(raw)
        elif isinstance(d, list):
            out[k] = rd(raw) or d
        else:
            out[k] = fnum(raw, d)
    for k in SPRITE_OT:
        raw = _prop(p, k)
        out[k] = overtime(raw, 1) if raw else []
    raw = _prop(p, 'colorRGBAOverTime')
    out['colorRGBAOverTime'] = overtime(raw, 4) if raw else []
    name = (_prop(p, 'texture') or '').strip()
    out['texture'] = name
    out['tex'] = tex_fn(name) if name else None
    return out


def export_carfx(t):
    ch = []
    for c in t['children']:
        fx = c['fx']
        ch.append({
            'template': c['template'], 'pos': c['pos'], 'rot': c['rot'],
            'isActive': boolean(fx.get('isactive', '0')),
            'trigOnMaterial': int(fnum(fx.get('trigonmaterial', '-1'), -1)),
            'attachedMode': int(fnum(fx.get('attachedmode', '0'))),
            'trigOnPhyVar': int(fnum(fx.get('trigonphyvar', '0'))),
            'startFade': fnum(fx.get('phyvarstartfade', '0')),
            'doneFade': fnum(fx.get('phyvardonefade', '0')),
        })
    return {'type': 'CarFx', 'children': ch}


def export_templates(it, tex_fn):
    out = {}
    for key in it.order:
        t = it.templates[key]
        ty = t['type'].lower()
        if ty == 'emitter':
            out[t['name']] = export_emitter(t)
        elif ty == 'spriteparticle':
            out[t['name']] = export_sprite(t, tex_fn)
        elif ty == 'carfx':
            out[t['name']] = export_carfx(t)
    return out


def reachable(templates, roots):
    """Names reachable from the CarFx roots (CarFx children -> Emitter -> SpriteParticle)."""
    lower = {k.lower(): k for k in templates}
    seen, stack = [], list(roots)
    while stack:
        n = lower.get(stack.pop().lower())
        if n is None or n in seen:
            continue
        seen.append(n)
        t = templates[n]
        if t['type'] == 'CarFx':
            stack.extend(c['template'] for c in t['children'])
        elif t['type'] == 'Emitter' and t['template']:
            stack.append(t['template'])
    return seen


def settings_out(it):
    s = dict(DEFAULTS)
    s.update(it.settings)
    return s


# ------------------------------------------------------------------------------------------- textures
def tex_resolver(ctx, texmap):
    def use(name):
        key = name.lower()
        if key in texmap:
            return texmap[key]['id']
        tid = ctx.textures.use('texture/' + name)
        if tid is None:
            texmap[key] = {'id': None}
            return None
        inf = ctx.textures.info(tid)
        texmap[key] = {'id': tid, 'depth': inf.get('depth', 1), 'volume': bool(inf.get('flags', 0) & 1),
                       'width': inf.get('width'), 'height': inf.get('height')}
        return tid
    return use


# ------------------------------------------------------------------------------------------- scripts
def startup_interp():
    """The startup state every stage inherits: object/Skidmarks.con (ObjectTemplates.con line 67) and the
    level/DropShadows.con car scales (run by the race loader, string 0x847b54)."""
    it = FxInterp(MISC)
    p = E.resolve_run(MISC, 'object/Skidmarks.con')
    if p:
        it.run_file(p)
    p = E.resolve_run(MISC, 'level/DropShadows.con')
    if p:
        it.run_file(p)
    return it


def stage_variant(family):
    return '4p' if family in E.CIRCUIT_FAMILIES else '1p'


def run_stage_chain(it, stage_dir, family):
    """environment.md §1: the race-track loader's script order (high-detail `Single` files)."""
    variant = stage_variant(family)
    chain = [(stage_dir, 'RenderSettings.con'), (stage_dir, 'RenderSettingsSingle%s.con' % variant),
             (COMMON_TRACK, 'GlobalRenderSettingsSingle%s.con' % variant), (stage_dir, 'Sky.con'),
             (stage_dir, 'lighting.con'), (stage_dir, 'Water.con'), (stage_dir, 'Cameras.con')]
    for base, rel in chain:
        p = E.ci_path(base, rel)
        if p and os.path.isfile(p):
            it.run_file(p)
    return variant


def pfx_children():
    """object/PFX_Template.con: the CarFX_<Surface>_Base list Player.con adds to every car (cars.md §2/§3), with
    each entry's setPosition / setRotation (yaw/pitch/roll degrees; all but Asphalt are turned 180 deg)."""
    p = E.resolve_run(MISC, 'object/PFX_Template.con')
    out = []
    if not p:
        return out
    for line in open(p, 'rb').read().decode('latin1').splitlines():
        m = re.match(r'(?i)\s*ObjectTemplate\.(addTemplate|setPosition|setRotation)\s+(\S+)', line)
        if not m:
            continue
        cmd = m.group(1).lower()
        if cmd == 'addtemplate':
            out.append({'name': m.group(2), 'pos': [0.0, 0.0, 0.0], 'rot': [0.0, 0.0, 0.0]})
        elif out:
            out[-1]['pos' if cmd == 'setposition' else 'rot'] = vec(m.group(2), 3)
    return out


# ------------------------------------------------------------------------------------------- light grid
def read_spline_cvs(path):
    pts = []
    if not path or not os.path.isfile(path):
        return pts
    for line in open(path, 'rb').read().decode('latin1').splitlines():
        m = re.match(r'\s*cv\[\d+\]\s*=\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)', line)
        if m:
            pts.append((float(m.group(1)), float(m.group(3))))
    return pts


def particle_lut(lo, hi, clamp):
    """FUN_004e0780: 256-entry LUT, index i -> lo + (hi-lo)·(i-c0)/(c1-c0) between c0 = clamp.x·255 and
    c1 = clamp.y·255, lo below c0, hi above c1; bytes = trunc(v·255) clamped."""
    c0 = int(clamp[0] * 255.0)
    c1 = int(clamp[1] * 255.0)
    span = float(max(1, c1 - c0))
    lo = np.array(lo, np.float64)
    hi = np.array(hi, np.float64)
    lut = np.zeros((256, 3), np.uint8)
    for i in range(256):
        if i < c0:
            v = lo
        elif i > c1:
            v = hi
        else:
            v = lo + (hi - lo) * ((i - c0) / span)
        lut[i] = np.clip(np.floor(v * 255.0), 0, 255).astype(np.uint8)
    return lut


def tga_p8(path):
    """Colour-mapped 8-bit TGA -> (index plane [h, w] top row first, w, h)."""
    b = open(path, 'rb').read()
    idlen, cmtype, itype = b[0], b[1], b[2]
    cmlen = struct.unpack_from('<H', b, 5)[0]
    cmbits = b[7]
    w, h = struct.unpack_from('<HH', b, 12)
    bpp, desc = b[16], b[17]
    if itype != 1 or bpp != 8:
        return None
    off = 18 + idlen + cmlen * ((cmbits + 7) // 8)
    idx = np.frombuffer(b, np.uint8, w * h, off).reshape(h, w)
    if not (desc & 0x20):            # bottom-up origin -> top row first
        idx = idx[::-1]
    return idx, w, h


def build_light_grid(ctx, stage, lut):
    """effects.md §6.4: per Track.qm patch, the lightmap uv is an exact axis-aligned linear map of world x / z
    (u = a·x + b, v = c·z + d; max residual 8e-8 on kenya1f), which is what SpriteLighting.vs evaluates with
    C_LIGHTMAP_OFFSET_AND_INVSIZE. The grid samples the LUT'd index at cell centres (nearest texel, CLAMP)."""
    import fmt_quadmesh as Q
    sdir = stage.cache_dir
    qm_path = E.ci_path(sdir, 'Mesh/Track.qm')
    lm_dir = E.ci_path(sdir, 'Lightmaps')
    if not qm_path or not lm_dir:
        return None
    qm = Q.parse(qm_path)
    patches = []
    for _node, p in qm.iter_patches():
        pos, luv = p.attrs.get('position'), p.attrs.get('uv3')
        if pos is None or luv is None or len(pos) < 3:
            continue
        lm = E.ci_path(lm_dir, 'Track%s.tga' % p.name)
        if not lm:
            continue
        X = np.c_[pos[:, 0], np.ones(len(pos))]
        Z = np.c_[pos[:, 2], np.ones(len(pos))]
        cu = np.linalg.lstsq(X, luv[:, 0], rcond=None)[0]
        cv = np.linalg.lstsq(Z, luv[:, 1], rcond=None)[0]
        patches.append((float(pos[:, 0].min()), float(pos[:, 0].max()), float(pos[:, 2].min()),
                        float(pos[:, 2].max()), cu, cv, lm))
    if not patches:
        return None
    # tiles near the AI splines
    pts = []
    for nm in ('center.spl', 'left.spl', 'right.spl'):
        pts += read_spline_cvs(E.ci_path(sdir, 'AiFiles/' + nm))
    if not pts:
        return None
    tsize = LIGHT_CELL * LIGHT_TILE
    tiles = set()
    r = int(np.ceil(LIGHT_BAND / tsize))
    for x, z in pts:
        tx, tz = int(np.floor(x / tsize)), int(np.floor(z / tsize))
        for dx in range(-r, r + 1):
            for dz in range(-r, r + 1):
                tiles.add((tx + dx, tz + dz))
    tiles = sorted(tiles)
    cache = {}
    data = np.full((len(tiles), LIGHT_TILE, LIGHT_TILE, 3), 255, np.uint8)
    covered = np.zeros((len(tiles), LIGHT_TILE, LIGHT_TILE), bool)
    cc = (np.arange(LIGHT_TILE) + 0.5) * LIGHT_CELL
    for ti, (tx, tz) in enumerate(tiles):
        x0, z0 = tx * tsize, tz * tsize
        xs, zs = x0 + cc, z0 + cc
        for (xa, xb, za, zb, cu, cv, lm) in patches:
            if xb < x0 or xa > x0 + tsize or zb < z0 or za > z0 + tsize:
                continue
            ix = np.nonzero((xs >= xa) & (xs <= xb))[0]
            iz = np.nonzero((zs >= za) & (zs <= zb))[0]
            if not len(ix) or not len(iz):
                continue
            if lm not in cache:
                cache[lm] = tga_p8(lm)
            img = cache[lm]
            if img is None:
                continue
            idx, w, h = img
            u = np.clip(cu[0] * xs[ix] + cu[1], 0.0, 1.0)
            v = np.clip(cv[0] * zs[iz] + cv[1], 0.0, 1.0)
            px = np.minimum((u * w).astype(int), w - 1)
            pz = np.minimum((v * h).astype(int), h - 1)
            sub = idx[pz][:, px]                         # [len(iz), len(ix)]
            data[ti][np.ix_(iz, ix)] = lut[sub]
            covered[ti][np.ix_(iz, ix)] = True
    keep = [i for i in range(len(tiles)) if covered[i].any()]
    tiles = [tiles[i] for i in keep]
    data = data[keep]
    return {'cell': LIGHT_CELL, 'tile': LIGHT_TILE, 'tiles': [[a, b] for a, b in tiles]}, data.tobytes()


# ------------------------------------------------------------------------------------------- build
_startup = None
_pfx = None


def _startup_state():
    global _startup, _pfx
    if _startup is None:
        _startup = startup_interp()
        _pfx = pfx_children()
    return _startup, _pfx


def build_stage(ctx, stage):
    base, pfx = _startup_state()
    it = FxInterp(stage.cache_dir)
    it.skid = json.loads(json.dumps(base.skid))
    it.settings = dict(base.settings)
    variant = run_stage_chain(it, stage.cache_dir, stage.family)
    texmap = {}
    tex = tex_resolver(ctx, texmap)
    templates = export_templates(it, tex)
    # the CarFx bases a car gets here (PFX_Template order, duplicate MudGrass kept; absent ones skipped like
    # the original's addTemplate of an unknown template)
    lower = {k.lower(): k for k in templates}
    car_fx = [dict(e, name=lower[e['name'].lower()]) for e in pfx
              if e['name'].lower() in lower and templates[lower[e['name'].lower()]]['type'] == 'CarFx']
    pipe_fx = [n for n in ('CarFX_Pipe', 'CarFX_GearPipe', 'e_ExFumePOW1') if n.lower() in lower]
    keep = reachable(templates, [e['name'] for e in car_fx] + [lower[n.lower()] for n in pipe_fx])
    templates = {k: templates[k] for k in keep}
    skid_tex = ctx.textures.use('texture/tracks')            # FUN_00786a70: "tracks" (Misc Tracks.dds, 1024x64)
    s = settings_out(it)
    light = None
    lut = particle_lut(s['particleLightmapMin'], s['particleLightmapMax'], s['particleLightmapClamp'])
    try:
        lg = build_light_grid(ctx, stage, lut)
    except Exception as e:   # noqa: BLE001 - the light grid is optional (unlit = LUT max)
        ctx.warn('light grid: %r' % e)
        lg = None
    if lg is not None:
        meta, blob = lg
        ctx.out.write_bytes('effects.bin', blob)
        light = dict(meta, bin='effects.bin', bytes=len(blob))
    out = {
        'version': VERSION, 'stageId': stage.id, 'variant': variant,
        'files': it.files, 'missingRuns': sorted(set(it.missing_runs)),
        'settings': s,
        'carFx': car_fx,
        'pipeFx': [lower[n.lower()] for n in pipe_fx],
        'templates': templates,
        'skid': dict(it.skid, texture=skid_tex, atlasColumns=32, halfWidth=0.1, lift=0.03, minSegment=0.5,
                     maxSegments=50, activeStrips=30, finishedStrips=40),
        'lut': lut.tolist(),
        'light': light,
        'textures': {k: v for k, v in texmap.items() if v.get('id')},
    }
    ctx.out.commit(out)


def build_cars(ctx, cars):
    import fmt_cars as C
    import fmt_standardmesh as SM
    base, _pfx_list = _startup_state()
    loc = C.load_locale()
    default_ds = ctx.textures.use('texture/car/dropshadows/dropshadow')
    for name in cars:
        d = C.assemble_car(name, loc)
        ds_tex = None
        if d.get('dropShadow'):
            ds_tex = ctx.textures.use('texture/car/dropshadows/%s' % name)
        bbox = None
        sm = E.ci_path(MISC, 'mesh/Cars/%s/BodyShadow.sm' % name)
        if sm:
            try:
                b = SM.parse_sm(sm, keep_data=False)['bbox']
                bbox = [list(map(float, b['min'])), list(map(float, b['max']))]
            except Exception as e:   # noqa: BLE001
                ctx.warn('%s BodyShadow.sm: %r' % (name, e))
        out = {
            'version': VERSION, 'car': name,
            'exhaust': [{'template': x['template'], 'pos': x['pos'], 'rot': x.get('rot', [0, 0, 0])}
                        for x in d.get('exhaust', [])],
            'dropShadow': {'tex': ds_tex or default_ds, 'carTexture': ds_tex is not None,
                           'scale': base.drop_scales.get(name.lower()) or d.get('dropShadowScale'),
                           'bbox': bbox},
        }
        ctx.car_out(name).commit(out)


def build_global(ctx):
    base, pfx = _startup_state()
    ctx.out.commit({
        'version': VERSION,
        'skid': dict(base.skid, texture=ctx.textures.use('texture/tracks')),
        'dropShadowTexture': ctx.textures.use('texture/car/dropshadows/dropshadow'),
        'dropShadowScales': base.drop_scales,
        'pfxTemplate': pfx,
        'files': base.files,
    })
