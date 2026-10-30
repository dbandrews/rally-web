"""environment part: the evaluated per-stage environment of the original (sky box, clouds, sun / lens flare,
Track + World fog, lighting colours and sun direction, view distances, weather particles, gamma ramp inputs).

Spec: research/formats/environment.md (§0, §1 load order: TrackFogSettings -> RenderSettings -> Single1p/4p ->
GlobalRenderSettings -> Sky.con -> lighting.con -> Water.con -> Cameras.con, §2 console rules, §3.1-3.8,
§4 frame composition, Verification V2 settings defaults / V3 gamma ramp), textures.md §6 (sky box: 5 faces,
no bottom). The scripts are resolved by the verified parser lib/formats/fmt_environment.py (resolve_stage =
the same evaluation that wrote environment_dump.json); this part only maps the resolved state onto a compact
runtime json with texIds. Runtime: src/render/orig/environment*.ts. Notes / deviations: docs/orig/environment.md.

Output: stages/<id>/environment.json (version 1), every value already defaulted (FUN_0040e650 for the settings
singleton, the Sky ctor FUN_005477a0, the weather ctor FUN_0054a360), every texture as a texId:

  fog.track / fog.world    {enabled, color[3], start, end, clamp, rangeFixed[2], defaulted[]}   (§3.4; high-detail
                           path = fogRange; World never has a clamp)
  light                    sunDirSim / sunDirThree (unit, toward the sun), objectLight / objectShadow
                           (game.lightColor / shadowColor), carLight / carAmbient, car shadow + lightmap terms,
                           track bump / specular, particleLightmapMin                                  (§3.5)
  sky                      faces [TOP, LFT, RGT, FRT, BAK] texIds, rotationDeg, offsetY, halfSize 3000, clouds[]
                           {name, tex, srcBlend, dstBlend, texScale, speed[2], height}, rndTexPos     (§3.1, §3.2)
  sun                      null (no Sky.setSun / no LensFlare object of that name) or {template, lensFlareCount,
                           coronaCount, occlusion[2], isSun, elements[] (flares then coronas = the element order
                           of FUN_0078d460) {kind, tex, size[2], size2[2], rot, color[4], color2[4]}}  (§3.3)
  weather                  null or the WPart system {type, radius, partSize, speed, random, numParticles,
                           pointSpriteMin/Max, displacement, color[4], scale[3], textures[]} (§3.8)
  view                     trackViewDistance, objectViewDistance, hotspots[], fieldOfView, skyPassNear/Far,
                           cameraFar (§3.6; sky/World pass near 10, far 10 + 100000 from the settings defaults;
                           main pass near 0.1, far 0.1 + the HotSpot-regulated Track view distance)
  gamma                    script trackGammaDelta, the live delta (= the script value, V3 note), gfxGamma default 0.5
  templates                per-object light / shadow multipliers (geometryTemplate.*, lighting.con)
  textures                 every texId above (tools/assets/check-textures.mjs --ids-from)
"""
import math

import fmt_environment as E

PART = 'environment'
VERSION = 1

SKY_HALF_SIZE = 3000.0                      # 0x453b8000, FUN_00547ee0 vertex table
SKY_FACES = ('SkyTOP_A', 'SkyLFT_A', 'SkyRGT_A', 'SkyFRT_A', 'SkyBAK_A')   # FUN_00547c40: +0x54..+0x64, no SkyBOT_A
# sky + World.qm pass: the race-level ctor 0x483e30 starts with near 10 / range 5000, but the level init
# (0x487a6f..0x487a8b, settings events 4 / 5 at 0x486ec2 / 0x486edc) overwrites them with the settings +0x0c / +0x10,
# whose FUN_0040e650 defaults are 10 / 100000 (0x40e6c7 / 0x40e6d3; no shipped script sets them). Main pass: near =
# settings +0x34 = 0.1, range = Track.viewDistance (then regulated per frame by the HotSpot view distances)
SKY_PASS_NEAR = 10.0
SKY_PASS_FAR = 10.0 + 100000.0
MAIN_PASS_NEAR = 0.1
MAIN_PASS_FAR_DEFAULT = 0.1 + 1000.0
GFX_GAMMA_DEFAULT = 0.5                     # gfx settings ctor 0x4c9220 (+0x20); environment.md V3

# weather system ctor FUN_0054a360 defaults (fields: +0x84 type, +0x40 radius, +0x38 partSize, +0x8c speed,
# +0x88 random, +0x10 count, +0x48 colour (0xff000000), +0xa0 scale, +0x18c displacement, +0x19c / +0x1a0 sprite
# size limits, +0x198 fadeZ, +0x16c fadeIn (1e8), +0x98 acceleration)
WEATHER_DEFAULTS = {
    'type': 0, 'radius': 0.0, 'partSize': [0.0, 0.0], 'speed': [0.0, -5.0, 0.0], 'random': 1.0, 'numParticles': 0,
    'pointSpriteMinSize': 1.0, 'pointSpriteMaxSize': 64.0, 'displacement': [0.0, 0.0, 0.0],
    'color': [0.0, 0.0, 0.0, 1.0], 'scale': [1.0, 1.0, 1.0], 'fadeZ': 0.0, 'fadeInValue': 1.0e8, 'acceleration': 1.0,
}

D = E.SETTINGS_DEFAULTS


def _vec(v, n, default):
    if v is None:
        v = default
    v = [float(x) for x in v]
    return (v + [v[-1]] * n)[:n]


def _f(v, default):
    return float(default if v is None else v)


def _stage_entry(stage_id):
    for st in E.stages():
        if st['id'] == stage_id:
            return st
    raise RuntimeError('fmt_environment has no stage %s' % stage_id)


def _tex(ctx, name, used):
    """texId of `texture/<name>` (stage Texture/ shadows Misc, extension ignored) or None."""
    if not name:
        return None
    n = name.replace('\\', '/')
    if not n.lower().startswith('texture/'):
        n = 'texture/' + n
    tid = ctx.textures.use(n)
    if tid is None:
        ctx.warn('texture %s does not resolve' % n)
    else:
        used.append(tid)
    return tid


def _fog(eff, raw, ns):
    """One fog block with the FUN_0040e650 defaults for every unset field (environment.md §3.4, V2)."""
    enabled = eff['enable'] if eff['enable'] is not None else D[ns + '.fogEnable']
    color = _vec(eff['color'], 3, D[ns + '.fogColor'])
    start = _f(eff['start'], D[ns + '.fogRange'][0])
    end = _f(eff['end'], D[ns + '.fogRange'][1])
    out = {
        'enabled': bool(enabled), 'color': color, 'start': start, 'end': end,
        'clamp': 1.0e8,
        'rangeFixed': _vec(raw.get('rangeFixed'), 2, D[ns + '.fogRangeFixed']),
        'defaulted': list(eff.get('defaultedFields') or []),
    }
    if ns == 'Track':
        c = raw.get('clamp')
        out['clamp'] = float(D['Track.fogClamp'] if c is None else c)
        if c is None:
            out['defaulted'].append('clamp')
    return out


def build_stage(ctx, stage):
    st = _stage_entry(stage.id)
    r = E.resolve_stage(E.load_cmds(), st)
    env = r['env']
    used = []

    # ---------------------------------------------------------------- fog (§3.4)
    fe = env['fogEffective']
    fog = {'track': _fog(fe['track'], env['fog']['track'], 'Track'),
           'world': _fog(fe['world'], env['fog']['world'], 'World')}

    # ---------------------------------------------------------------- lighting (§3.5)
    g, car, trk = env['game'], env['car'], env['track']
    sky = env['sky']
    sd = [float(x) for x in sky['sunLightDir']]          # normalised on set (exec 0x53f0c0) / FUN_0049a680
    n = math.sqrt(sum(x * x for x in sd))
    sd = [x / n for x in sd] if n > 1e-12 else [0.0, 0.0, 0.0]
    light = {
        'sunDirSim': sd,
        'sunDirThree': [sd[0], sd[1], -sd[2]],
        'sunDirSet': 'sky.sunLightDir' in r['provenance'],
        'objectLight': _vec(g['lightColor'], 3, D['game.lightColor']),
        'objectShadow': _vec(g['shadowColor'], 3, D['game.shadowColor']),
        'carLight': _vec(car['lightColor'], 3, D['car.lightColor']),
        'carAmbient': _vec(car['ambient'], 3, D['car.ambient']),
        'carShadow': _vec(car['shadowColor'], 3, D['car.shadowColor']),
        'carDropShadow': _vec(car['dropShadowColor'], 3, D['car.dropShadowColor']),
        'carLightmapMin': _vec(car['lightmapMin'], 3, D['Car.lightmapMin']),
        'carLightmapMax': _vec(car['lightmapMax'], 3, D['Car.lightmapMax']),
        'carLightmapClamp': _vec(car['lightmapClamp'], 2, D['Car.lightmapClamp']),
        'carShadowHeightScale': _f(car['shadowHeightScale'], D['Car.shadowHeightScale']),
        'trackBumpHeight': _f(trk['bumpHeight'], D['track.bumpHeight']),
        'trackSpecularColor': _vec(trk['specularColor'], 3, D['track.specularColor']),
        'particleLightmapMin': _vec(g['particleLightmapMin'], 3, D['game.particleLightmapMin']),
    }

    # ---------------------------------------------------------------- sky box + clouds (§3.1, §3.2)
    sky_out = None
    if sky.get('initialised'):
        faces = [_tex(ctx, 'texture/' + f, used) for f in SKY_FACES]
        clouds = []
        for c in sky.get('clouds') or []:
            clouds.append({
                'name': c['name'], 'tex': _tex(ctx, c.get('texture'), used),
                'srcBlend': int(c['srcBlend']), 'dstBlend': int(c['dstBlend']),
                'texScale': float(c['texScale']), 'speed': [float(c['speed'][0]), float(c['speed'][1])],
                'height': float(c['height']),
            })
        sky_out = {
            'faces': faces, 'rotationDeg': float(sky['rotAngleDeg'] or 0.0),
            'offsetY': float(sky['ofsSkyHeight'] or 0.0), 'halfSize': SKY_HALF_SIZE,
            'clouds': clouds, 'rndTexPos': float(sky.get('ofsRndTexPos') or 0.0),
        }

    # ---------------------------------------------------------------- sun / lens flare (§3.3)
    sun = None
    tname = sky.get('sunFlareTemplate')
    tmpl = env['objectTemplates'].get(tname) if tname else None
    if tmpl and (tmpl.get('class') or '').lower() == 'lensflare':
        nf = int(tmpl.get('lensFlareCount') or 0)
        nc = int(tmpl.get('coronaCount') or 0)
        elems = []
        for kind, count, table in (('flare', nf, tmpl.get('flares') or {}), ('corona', nc, tmpl.get('coronas') or {})):
            for i in range(count):
                e = table.get(str(i)) or {}
                elems.append({
                    'kind': kind, 'tex': _tex(ctx, e.get('texture'), used),
                    'size': _vec(e.get('size'), 2, [0.0]), 'size2': _vec(e.get('size2'), 2, [0.0]),
                    'rot': _f(e.get('rot'), 0.0),
                    'color': _vec(e.get('color'), 4, [0.0]), 'color2': _vec(e.get('color2'), 4, [0.0]),
                })
        occ = tmpl.get('occlusionQuadWidthHeight')
        sun = {
            'object': sky.get('sunObject'), 'template': tname, 'lensFlareCount': nf, 'coronaCount': nc,
            'occlusion': _vec([occ] if isinstance(occ, (int, float)) else occ, 2, [0.0]),
            'isSun': bool(tmpl.get('isSun', True)), 'enabled': bool(tmpl.get('enable', True)),
            'distance': 4096.0,                     # FUN_005485b0: sun object at camera + 4096 * sunDir
            'elements': elems,
        }

    # ---------------------------------------------------------------- weather (§3.8)
    weather = None
    w = env.get('weather')
    if w:
        wd = dict(WEATHER_DEFAULTS)
        for k in wd:
            if w.get(k) is not None:
                wd[k] = w[k]
        texs = []
        for k in sorted(w.get('textures') or {}, key=lambda s: int(s)):
            t = _tex(ctx, w['textures'][k]['name'], used)
            if t is not None:
                texs.append(t)
        weather = {
            'type': int(wd['type']), 'radius': float(wd['radius']), 'partSize': _vec(wd['partSize'], 2, [0.0]),
            'speed': _vec(wd['speed'], 3, [0.0]), 'random': float(wd['random']),
            'numParticles': int(wd['numParticles']),
            'pointSpriteMinSize': float(wd['pointSpriteMinSize']), 'pointSpriteMaxSize': float(wd['pointSpriteMaxSize']),
            'displacement': _vec(wd['displacement'], 3, [0.0]), 'color': _vec(wd['color'], 4, [0.0]),
            'scale': _vec(wd['scale'], 3, [1.0]), 'textures': texs,
            # read by the unused WeatherSnow/RainShader only (no reader in FUN_0054ac20 / FUN_0054b1c0)
            'unused': {'fadeZ': float(wd['fadeZ']), 'fadeInValue': float(wd['fadeInValue']),
                       'acceleration': float(wd['acceleration'])},
        }

    # ---------------------------------------------------------------- view distances (§3.6)
    hs = env['hotspots']
    spots = []
    for s in hs.get('list') or []:
        spots.append({k: (float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v) for k, v in s.items()})
    tvd = _f(trk['viewDistance'], D['Track.viewDistance'])
    ovd = _f(env['objects']['viewDistance'], D['Object.viewDistance'])
    track_views = [tvd] + [s['trackViewDistance'] for s in spots if isinstance(s.get('trackViewDistance'), float)]
    view = {
        'trackViewDistance': tvd, 'objectViewDistance': ovd,
        'hotspotsEnabled': bool(hs.get('enable')) if hs.get('enable') is not None else False, 'hotspots': spots,
        'fieldOfView': _f(env['objects'].get('fieldOfView'), D['renderer.fieldOfView']),
        'skyPassNear': SKY_PASS_NEAR, 'skyPassFar': SKY_PASS_FAR,
        'mainPassNear': MAIN_PASS_NEAR, 'mainPassFarDefault': MAIN_PASS_FAR_DEFAULT,
        # one camera covering both passes (single-pass fallback); the frame pipeline uses the pass ranges above
        'cameraFar': max(SKY_PASS_FAR, max(track_views)),
    }

    # ---------------------------------------------------------------- per-template light multipliers (lighting.con)
    templates = {}
    for name, t in (env.get('templates') or {}).items():
        sel = {k: t[k] for k in ('lightColor', 'shadowColor', 'lighting') if t.get(k) is not None}
        if sel:
            if 'lightColor' in sel:
                sel['lightColor'] = _vec(sel['lightColor'], 3, [1.0])
            if 'shadowColor' in sel:
                sel['shadowColor'] = _vec(sel['shadowColor'], 3, [1.0])
            if 'lighting' in sel:
                sel['lighting'] = bool(sel['lighting'])
            templates[name] = sel

    out = {
        'version': VERSION,
        'stage': stage.id,
        'variant': r['renderSettingsVariant'],
        'fog': fog,
        'light': light,
        'sky': sky_out,
        'sun': sun,
        'weather': weather,
        'view': view,
        # the live delta IS the script value: RenderSettings.con runs inside Game.createTrack (0x428710 ->
        # 0x494c00 -> 0x4963e7) during the play script, before the race loader's read at 0x494a6d
        # (docs/orig/environment.md section 5, research/formats/environment.md V3 note 2026-10-30)
        'gamma': {'trackGammaDeltaScript': _f(g['trackGammaDelta'], D['game.trackGammaDelta']),
                  'trackGammaDeltaLive': _f(g['trackGammaDelta'], D['game.trackGammaDelta']),
                  'gfxGammaDefault': GFX_GAMMA_DEFAULT},
        'templates': templates,
        'defaultsApplied': env.get('defaultsApplied') or {},
        'textures': sorted(set(used)),
    }
    ctx.out.commit(out)
    ctx.log('sky %s, %d clouds, sun %s, weather %s, %d textures' % (
        'yes' if sky_out else 'no', len(sky_out['clouds']) if sky_out else 0, tname if sun else '-',
        ('snow', 'rain')[weather['type']] if weather and weather['type'] in (0, 1) else '-', len(out['textures'])))
