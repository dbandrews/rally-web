"""audio part (global phase): the original sound bank -> public/assets/global/audio.json + global/audio/*.wav

Spec: research/formats/sound.md (body + "## Verification", whose corrections override the body). Parser:
lib/formats/fmt_sound.py (the verified research parser, used unchanged: SscParser, FS, parse_car_player).

  npm run assets -- --audio --parts audio

What is written (docs/orig/audio.md has the full field list; the runtime is src/audio/orig/):

  global/audio.json      version, tier, the parsed .ssc scripts (every patch / layer / effect with the
                         decomp defaults applied, keyed by the research path, e.g.
                         'Cars/cars/ImprezaWRX/Sound/Engine.ssc'), the sample table (rate, channels, frames,
                         the loop region the original plays = the WHOLE buffer, DirectSound ignores `smpl`
                         [V 0x6b3d30], plus the authored smpl loops for reference), the 29 CarSoundPlayer
                         templates (20 script slots each, player + AI), the material -> surface-slot table
                         (jump table 0x7473e8), the collision type table (0x746e3c), the environment-sound
                         templates + their 793 placements per stage (SIM space), the race UI scripts, the menu
                         meme sounds, and the co-driver words 1..41 (+ team coach 42..92).
  global/audio/<path>    one canonical PCM16 WAV per referenced sample of the 44 kHz tier ("HIGH", sound.md
                         §12/§14.1) + the menu / pacenote / coach samples. The PCM payload is the original's
                         data chunk byte for byte (sample-exact loops: the runtime decodes the WAV itself into
                         an AudioBuffer at the file's native rate, no resampling, no encoder padding).

Never copies the licensed music (original_version/Sound/Music, sound.md §11): it is not in the archives
this part reads.
"""
import os
import re
import struct

PART = 'audio'
VERSION = 1
TIER = '44khz'                     # shipped quality tier ("HIGH" = 44kHz, FUN_00405ba0)
_SEG_OK = re.compile(r'[^a-z0-9_.\-]')


def _riff(path):
    """-> (fmt tuple (tag, ch, rate, byteRate, align, bits), data bytes, smpl loops [[start, end]]) of a WAV."""
    d = open(path, 'rb').read()
    if d[:4] != b'RIFF' or d[8:12] != b'WAVE':
        raise ValueError('%s: not RIFF/WAVE' % path)
    o, fmt, data, smpl = 12, None, None, []
    while o + 8 <= len(d):
        cid, n = d[o:o + 4], struct.unpack_from('<I', d, o + 4)[0]
        if cid == b'fmt ':
            fmt = struct.unpack_from('<HHIIHH', d, o + 8)
        elif cid == b'data':
            data = d[o + 8:o + 8 + n]
        elif cid == b'smpl' and n >= 36:
            nl = struct.unpack_from('<I', d, o + 8 + 28)[0]
            for k in range(nl):
                q = o + 8 + 36 + 24 * k
                if q + 24 <= len(d):
                    _cue, _typ, st, en, _frac, _cnt = struct.unpack_from('<IIIIII', d, q)
                    smpl.append([st, en])
        o += 8 + n + (n & 1)
    if fmt is None or data is None:
        raise ValueError('%s: missing fmt/data' % path)
    tag, ch, rate, _br, align, bits = fmt
    if tag != 1 or bits != 16:
        raise ValueError('%s: not PCM16 (tag %d, %d bit)' % (path, tag, bits))       # sound.md §12: all PCM16
    frames = len(data) // align
    return fmt, data[:frames * align], smpl


def _wav_bytes(ch, rate, data):
    """Canonical 44-byte-header PCM16 WAV around the original data chunk."""
    align = 2 * ch
    hdr = b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVE'
    hdr += b'fmt ' + struct.pack('<IHHIIHH', 16, 1, ch, rate, rate * align, align, 16)
    hdr += b'data' + struct.pack('<I', len(data))
    return hdr + data


def _out_name(research_path):
    """'Audio/sound/44khz/General/3,2,1.wav' -> 'audio/audio/sound/44khz/general/3_2_1.wav' (Output names allow
    only [A-Za-z0-9_.-] per segment)."""
    segs = [_SEG_OK.sub('_', s.lower()) for s in research_path.replace('\\', '/').split('/')]
    segs = [('_' + s) if not s[:1].isalnum() and s[:1] != '_' else s for s in segs]
    return 'audio/' + '/'.join(segs)


def _resolve_sample(fs, load_path, tier):
    """Resolve a `load` argument exactly as fmt_sound.main does (@ROOT -> archive root, @RTD -> quality tier;
    `@ROOT/Sound/...` lives in Audio.rff, the menu ones in Menu.rff; case-insensitive)."""
    import fmt_sound as FSND
    rel = load_path.replace('\\', '/')
    q = rel.replace('@ROOT/', '').replace('@ROOT', '').replace('@RTD', tier)
    q = FSND.norm(q).lstrip('/')
    return fs.resolve('Audio/' + q) or fs.resolve(q) or fs.resolve('Menu/' + q)


def _enum(table, name, default=0):
    return table.index(name) if name in table else default


def _effects_json(FSND, L):
    """A parsed layer's effects in the bank format (EffectJson: d / s / x / e / p)."""
    fx = []
    for e in L['effects']:
        if e['dest'] is None or e['source'] is None:
            continue                  # 'Controller' destination is ignored (FUN_00604800)
        fx.append({'d': _enum(FSND.DEST, e['dest']), 's': _enum(FSND.SRC, e['source']),
                   'x': int(e['extern']), 'e': _enum(FSND.ENV, e['envelope'] or 'Ramp', 1),
                   'p': [float(v) for v in e['effective']]})
    return fx


def build_global(ctx):
    import fmt_sound as FSND
    import stages as S

    fs = FSND.FS(ctx.full)
    parser = FSND.SscParser(fs)
    ssc_files = fs.files(lambda p: p.lower().endswith('.ssc'))
    if not ssc_files:
        raise RuntimeError('no .ssc scripts under %s (extraction cache incomplete?)' % ctx.full)

    samples = {}                                  # research path -> table entry (filled below)

    def want(path):
        if path and path not in samples:
            samples[path] = None
        return path

    # ---- every .ssc (386): patches / layers / effects with the decomp defaults (FUN_00604350, FUN_00605df0)
    scripts = {}
    warnings = 0
    for f in ssc_files:
        r = parser.parse(f)
        warnings += len(r['warnings'])
        pats = []
        for p in r['patches']:
            layers = []
            for L in p['layers']:
                res = _resolve_sample(fs, L['path'], TIER)
                fx = _effects_json(FSND, L)
                layers.append({
                    's': want(res), 'path': L['path'], 'loop': bool(L['loop']), 'is3d': bool(L['is3d']),
                    'volume': float(L['volume']), 'pan': float(L['pan']), 'minDistance': float(L['minDistance']),
                    'priority': int(L['priority']), 'trigger': _enum(FSND.TRIG, L['trigger']),
                    'stop': FSND.STOP.get(L['stop'], 2), 'rsp': [float(v) for v in L['randomStartPitch']],
                    'rel': [float(v) for v in L['relativePosition']], 'doppler': bool(L['doppler']),
                    'fx': fx,
                })
            # randomPlay n is accepted only if n < layer count (setRandomPlay 0x7ea900)
            rp = int(p.get('randomPlay') or 0)
            pats.append({'comment': p.get('comment') or '', 'randomPlay': rp if 0 < rp < len(layers) else 0,
                         'layers': layers})
        scripts[f] = {'patches': pats}

    # ---- CarSoundPlayer templates (SoundPlayer.con = human, SoundAI.con = opponents; 20 slots by position)
    cars = {}
    names = sorted(set(p.split('/')[2] for p in fs.idx.values()
                       if p.startswith('Cars/cars/') and p.count('/') >= 3 and p.split('/')[2] != 'General'))
    for car in names:
        sp = FSND.parse_car_player(fs, 'Cars/cars/%s/SoundPlayer.con' % car)
        ai = FSND.parse_car_player(fs, 'Cars/cars/%s/SoundAI.con' % car)
        if not sp:
            continue
        slots = lambda pl: [s['resolved'] if s['resolved'] in scripts else None for s in (pl or {'scripts': []})['scripts']]
        folders = set()
        for sid in slots(sp):
            for p in (scripts[sid]['patches'] if sid else []):
                for L in p['layers']:
                    if L['s'] and '/Cars/' in L['s']:
                        folders.add(L['s'].split('/')[4])
        cars[car] = {'template': sp['template'], 'player': slots(sp), 'ai': slots(ai),
                     'engineDeltaDistance': sp['engineDeltaDistance'], 'pipeDeltaDistance': sp['pipeDeltaDistance'],
                     'sampleFolder': sorted(folders)[0] if folders else None}
    if len(cars) != 29:
        raise RuntimeError('expected 29 CarSoundPlayer templates, found %d' % len(cars))

    # ---- environment / object sound templates (Misc/object/Sound_*.con) + placements (Objects.con)
    env_templates, obj_sounds = {}, {}
    for f in fs.files(lambda p: p.startswith('Misc/object/') and p.lower().endswith('.con')
                      and os.path.basename(p).lower().startswith('sound')):
        _real, lines = FSND.con_lines(fs, f)
        cur = None
        for line in lines:
            t = line.split()
            if not t:
                continue
            if t[0] == 'ObjectTemplate.create' and len(t) >= 3:
                cur = (t[1], t[2])
            elif cur and t[0] == 'ObjectTemplate.loadSoundScript' and len(t) >= 2:
                p = fs.resolve(FSND.norm(os.path.join(os.path.dirname(f), t[1])))
                if p in scripts:
                    (env_templates if cur[0] == 'WorldEnvironmentSound' else obj_sounds)[cur[1]] = p
    placements = {}
    for f in fs.files(lambda p: p.lower().endswith('/objects.con') and '/track/' in p.lower()):
        sid = S.archive_stage_id(f.split('/')[0])
        if not sid:
            continue
        info = S.load_stage(sid, ctx.vfs)
        ox, oy, oz = info.world_offset
        rows = []
        for line in open(os.path.join(ctx.full, f), encoding='latin-1'):
            t = line.split()
            if len(t) >= 3 and t[0] == 'Object.create' and t[1] in env_templates:
                x, y, z = (FSND.c_atof(v) for v in (t[2].split('/') + ['0', '0'])[:3])
                rows.append([t[1], round(x - ox, 3), round(y - oy, 3), round(z - oz, 3)])   # world -> SIM
        if rows:
            placements[sid] = rows

    # ---- race UI / menu (sound.md §9)
    ui = {k: ('Menu/menu/Sound/%s.ssc' % k) for k in ('CountDown', 'CheckPoint', 'Error')}
    for k, v in ui.items():
        if v not in scripts:
            raise RuntimeError('missing UI script %s' % v)
    menu = {}
    for name in ('Back', 'Error', 'Screeneffekt', 'Select', 'Step', 'Sweep', 'Tag', 'Unlock'):
        p = fs.resolve('Menu/menu/Sound/%s.wav' % name)
        if p:
            menu[name] = want(p)

    # ---- co-driver: Sound_PaceNotes.con words 1..41, Sound_TeamCoach.con 42..92 (sound.md §10)
    def table(con, cmd_vol, cmd_load):
        vol, out = 1.0, {}
        _real, lines = FSND.con_lines(fs, con)
        for line in lines:
            t = line.split()
            if len(t) >= 2 and t[0] == cmd_vol:
                vol = FSND.c_atof(t[1])
            elif len(t) >= 3 and t[0] == cmd_load:
                res = fs.resolve('LocaleEnglish/locale/english/' + t[2])
                if not res:
                    raise RuntimeError('%s: sample %s missing' % (con, t[2]))
                out[str(int(t[1]))] = {'s': want(res), 'phrase': os.path.splitext(os.path.basename(t[2]))[0]}
        return vol, out
    pn_vol, words = table('Misc/object/Sound_PaceNotes.con', 'race.setPaceNoteMasterVolume', 'race.loadPaceNote')
    tc_vol, coach = table('Misc/object/Sound_TeamCoach.con', 'race.setTeamCoachMasterVolume', 'race.loadTeamCoachSample')
    if sorted(int(k) for k in words) != list(range(1, 42)):
        raise RuntimeError('pacenote words are not 1..41: %s' % sorted(words))

    # ---- samples: canonical WAVs (PCM payload byte-identical), table entry per research path
    used_names = {}
    total = 0
    for path in sorted(samples):
        fmt, data, smpl = _riff(os.path.join(ctx.full, path))
        _tag, ch, rate, _br, align, _bits = fmt
        name = _out_name(path)
        if name in used_names and used_names[name] != path:
            raise RuntimeError('sample name clash: %s / %s -> %s' % (used_names[name], path, name))
        used_names[name] = path
        ctx.out.write_bytes(name, _wav_bytes(ch, rate, data))
        frames = len(data) // align
        e = {'f': name, 'rate': rate, 'ch': ch, 'frames': frames,
             'loop': [0, frames]}                 # the region DirectSound loops: the whole buffer [V 0x6b3d30]
        if smpl:
            e['smpl'] = smpl                      # authored loop points (ignored by the original; reference only)
        samples[path] = e
        total += len(data)

    nl = sum(len(p['layers']) for s in scripts.values() for p in s['patches'])
    ctx.log('%d scripts (%d patches, %d layers, %d parser warnings), %d samples (%.1f MB PCM), %d cars, '
            '%d env placements on %d stages' % (len(scripts), sum(len(s['patches']) for s in scripts.values()), nl,
                                                warnings, len(samples), total / 1e6, len(cars),
                                                sum(len(v) for v in placements.values()), len(placements)))
    ctx.out.commit({
        'version': VERSION, 'tier': TIER,
        'enums': {'dest': FSND.DEST, 'source': FSND.SRC, 'envelope': FSND.ENV, 'trigger': FSND.TRIG,
                  'stop': FSND.STOP_NAMES, 'carMap': {'Rpm': 0, 'Gear': 1, 'Throttle': 2, 'SlipX': 3, 'SlipZ': 4,
                                                      'Whine': 5, 'Speed': 6, 'Impulse': 7, 'Wheels': 8, 'Ouside': 9}},
        'scripts': scripts,
        'samples': samples,
        'cars': cars,
        'carScriptRoles': [r[1] for r in FSND.CAR_SCRIPT_ROLES],
        'materialSlot': [FSND.MATERIAL_SLOT[m] for m in range(len(FSND.MATERIALS))],
        'materialNames': FSND.MATERIALS,
        'collision': {'hard': FSND.COLL_HARD, 'snow': FSND.COLL_SNOW, 'tree': FSND.COLL_TREE},
        'env': {'templates': env_templates, 'objectSounds': obj_sounds, 'placements': placements},
        'ui': ui, 'menu': menu,
        'coDriver': {'masterVolume': pn_vol, 'words': words, 'coachVolume': tc_vol, 'coach': coach},
    })


# ------------------------------------------------------------------------------------------------------------
# Test fixture: patch evaluations by the verified research parser (fmt_sound.layer_eval / ramp) for vitest
# (tests/audio/fixtures/layerEval.json). Run: .venv/bin/python -I tools/assets/parts/audio.py --fixtures
# ------------------------------------------------------------------------------------------------------------
def _fixtures(out_path):
    import json
    import random
    import fmt_sound as FSND
    from _paths import FULL
    fs = FSND.FS(FULL)
    parser = FSND.SscParser(fs)
    rnd = random.Random(1234)
    picks = ['Cars/cars/ImprezaWRX/Sound/Engine.ssc', 'Cars/cars/ImprezaWRX/Sound/EngineThrottle.ssc',
             'Cars/cars/ImprezaWRX/Sound/Pipe.ssc', 'Cars/cars/ImprezaWRX/Sound/PipeBoost2.ssc',
             'Cars/cars/Metro6R4/Sound/Pipe.ssc', 'Cars/cars/General/Sounds/WheelFriction.ssc',
             'Cars/cars/General/Sounds/WheelSlipX.ssc', 'Cars/cars/General/Sounds/Whine.ssc',
             'Cars/cars/General/Sounds/Collision.ssc', 'Misc/object/Sounds/BigCrowd.ssc']
    cases = []
    for f in picks:
        r = parser.parse(f)
        for pi, p in enumerate(r['patches']):
            for li, L in enumerate(p['layers']):
                for _ in range(6):
                    ext = {0: rnd.uniform(0, 10000), 1: float(rnd.randint(0, 6)), 2: rnd.choice([0.0, 0.5, 1.0]),
                           3: rnd.uniform(0, 1.2), 4: rnd.uniform(0, 1.2), 5: rnd.choice([0.0, 1.0]),
                           6: rnd.uniform(0, 220), 7: rnd.uniform(0, 450), 8: float(rnd.randint(0, 4)),
                           9: rnd.choice([0.0, 1.0])}
                    dist, time, trel = rnd.uniform(0, 600), rnd.uniform(0, 2), rnd.choice([-1.0, rnd.uniform(0, 0.3)])
                    v, pitch = FSND.layer_eval(L, ext, dist=dist, time=time, trel=trel)
                    cases.append({'script': f, 'patch': pi, 'layer': li,
                                  'def': {'volume': float(L['volume']), 'fx': _effects_json(FSND, L)},
                                  'ext': [ext[i] for i in range(10)],
                                  'dist': dist, 'time': time, 'trel': trel, 'volume': v, 'pitch': pitch})
    ramps = []
    for _ in range(400):
        prm = [rnd.choice([0.0, 1.0, rnd.uniform(-5, 5)]), rnd.choice([0.0, 1.0, rnd.uniform(-5, 5)]),
               rnd.uniform(-2, 2), rnd.uniform(-2, 2), float(rnd.choice([0, 1, 2, 3])), rnd.choice([1.0, 1.2, 2.0, 3.0])]
        x = rnd.choice([prm[0], prm[1], rnd.uniform(-6, 6)])
        ramps.append({'p': prm, 'x': x, 'y': FSND.ramp(prm, x)})
    with open(out_path, 'w') as fh:
        json.dump({'generator': 'tools/assets/parts/audio.py --fixtures (fmt_sound.layer_eval / ramp)',
                   'layers': cases, 'ramps': ramps}, fh, separators=(',', ':'))
    print('%d layer cases, %d ramp cases -> %s' % (len(cases), len(ramps), out_path))


if __name__ == '__main__':
    import sys
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path[0:0] = [os.path.join(here, '..', 'lib'), os.path.join(here, '..', 'lib', 'formats')]
    if '--fixtures' in sys.argv:
        i = sys.argv.index('--fixtures')
        dst = sys.argv[i + 1] if len(sys.argv) > i + 1 else os.path.join(here, '..', '..', '..', 'tests', 'audio', 'fixtures', 'layerEval.json')
        _fixtures(os.path.abspath(dst))
