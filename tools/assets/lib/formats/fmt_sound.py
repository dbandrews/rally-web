#!/usr/bin/env python3
"""fmt_sound.py - parser / validator for the original game's sound data (topic `sound`).

Reads (all under research/full/, case-insensitive like the Windows original):
  * every .ssc sound script (Cars/cars/**, Misc/object/Sounds, Menu/menu/Sound)
  * the CarSoundPlayer templates Cars/cars/<Car>/SoundPlayer.con / SoundAI.con
  * the environment / object sound templates Misc/object/Sound_*.con
  * the co-driver tables Misc/object/Sound_PaceNotes.con / Sound_TeamCoach.con and every stage Pacenotes.con
  * every WAV (Audio/sound/{11kHz,22khz,44khz}, Menu, LocaleEnglish)
and writes research/formats/sound_dump.json (+ PNG proofs under artifacts/re/sound/).

The .ssc grammar, enum tables and runtime semantics reproduced here are the decomp-verified ones documented
in research/formats/sound.md (loader FUN_005f7940 / FUN_005fcb90 / FUN_005fd0e0, Ramp FUN_00605e50, ...).

Run:  research/.venv/bin/python -I research/tools/fmt_sound.py [--no-png]
"""
import collections
import json
import math
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # rally-web: data roots from _paths.py
from _paths import REPO as ROOT, FULL, ART_ROOT, DUMPS  # noqa: E402
OUT_JSON = DUMPS + '/sound_dump.json'
ART = ART_ROOT + '/sound'
TIERS = ['11kHz', '22khz', '44khz']          # directory spelling on disk; @RTD -> "11kHz"/"22kHz"/"44kHz" [V FUN_00405ba0]

# ----------------------------------------------------------------------------------------------------------
# decomp tables
# ----------------------------------------------------------------------------------------------------------
# keyword index = case of the dispatcher switch FUN_005fd0e0; table built by FUN_005fcb90 (strings 0x845c68..)
KEYWORDS = ['load', 'stream', 'stereo', 'loop', 'volume', 'pan', 'minDistance', 'priority', 'trigger',
            'randomStartPitch', 'beginEffect', 'endEffect', 'controlSource', 'controlDestination', 'envelope',
            'param', 'paramController', 'newPatch', 'randomPlay', 'relativePosition', 'dopplerOff', 'stop']
KW = {k: i for i, k in enumerate(KEYWORDS)}
DEST = ['Volume', 'Pitch', 'MinDistance', 'Controller', 'Chorus', 'Reverb', 'Compressor', 'Distortion', 'Echo',
        'Flanger', 'TVA', 'TVF']                                                    # FUN_00602f00
SRC = ['Default', 'Extern', 'Speed', 'Acceleration', 'Distance', 'Altitude', 'Time', 'TimeRelease']  # FUN_00603490
ENV = ['Linear', 'Ramp']                                                           # FUN_006028e0
TRIG = ['Default', 'Release', 'Volume']                                            # FUN_00603890
STOP = {'Immediate': 1, 'ImmediateReset': 2, 'FinishSample': 3}                    # FUN_005fd9f0
STOP_NAMES = {v: k for k, v in STOP.items()}
ENV_NPARAM = {'Linear': 2, 'Ramp': 6}                                              # FUN_00605fc0(...,2|6)
ENV_DEFAULT = {'Linear': [0.0, 0.0], 'Ramp': [0.0, 0.0, 0.0, 0.0, 0.0, 1.0]}       # FUN_00605df0 p4=0 p5=1

# CarSoundPlayer script slots (index = loadSoundScript order) and what drives them [V FUN_007465f0 + callees]
CAR_SCRIPT_ROLES = [
    ('Engine', 'engine_idle', 'FUN_00746f30: externs Rpm/Gear/Throttle, play() every update (always on)'),
    ('Pipe', 'engine_offthrottle', 'FUN_00746fb0: play while Throttle==0 (re-armed if stopped), release on throttle-on edge'),
    ('PipeReleaseBoost1', 'overrun_pop_low', 'FUN_00747450: (throttle-off edge or downshift) and >1 s since last; 500<rpm<2500; chosen band is release()+play() (restart), others released; throttle>0 releases all pops only inside the same >1 s gate'),
    ('PipeReleaseBoost2', 'overrun_pop_mid', 'FUN_00747450: same trigger; 2500<rpm<5000'),
    ('PipeReleaseBoost3', 'overrun_pop_high', 'FUN_00747450: same trigger; 5000<rpm<13000'),
    ('PipeBoost1', 'boost_low', 'FUN_007476b0: (throttle-on edge or upshift) and >1 s since last; 500<rpm<2500'),
    ('PipeBoost2', 'boost_mid', 'FUN_007476b0: same trigger; 2500<rpm<5000'),
    ('PipeBoost3', 'boost_high', 'FUN_007476b0: same trigger; 5000<rpm<13000'),
    ('EngineThrottle', 'engine_onthrottle', 'FUN_007478f0: play on throttle-on edge (or if stopped while throttle>0), release on throttle-off edge'),
    ('GearShift', 'gearshift', 'FUN_007470a0: play when gear != previous gear'),
    ('HandBrake', 'handbrake', 'FUN_007470e0: play on handbrake rising edge (car vt+0x30 > 0, previous == 0)'),
    ('WheelSlipX', 'slide', 'FUN_00747150: patch[slot(material)] per wheel material; Wheels=count; SlipX=wheel0 vt+0xe0'),
    ('WheelSlipZ', 'wheelspin', 'FUN_00747150: patch[slot(material)]; Wheels=count; SlipZ=mean|wheel vt+0xe4|'),
    ('Weather', 'rain', 'FUN_007479e0: play while current weather +0x84 == 1 (rain), else release'),
    ('Glassbreak', 'glassbreak', 'FUN_00747a30: car vt+0x1e0: 0 -> patch 0 (lights), 1 -> patch 1 (window); then vt+0x1e4 reset'),
    ('PipeBoom', 'backfire', 'FUN_00747a90: car vt+0x12c == 1 (backfire flag, 0x753410)'),
    ('PipeBlowOut', 'blowout', 'FUN_00747ad0: car vt+0x130 == 1 (blow-out flag, 0x753550)'),
    ('Whine', 'trans_whine', 'FUN_00747b10: Speed(km/h), Whine=1 (0 / random dropouts for 80 updates after an upshift); play while throttle>0'),
    ('Collision', 'collision', 'FUN_00746c80/FUN_00746ec0/FUN_00747c90: patch 0 bush, 1 hard, 2 metal(silent), 3 bump, 4 snow, 5 tree'),
    ('WheelFriction', 'surface_roll', 'FUN_00747150: patch[slot(material)] per wheel material; Wheels=count'),
]

# exe c_MATERIAL_ROAD_* ids (docs/MECHANICS_SPEC.md 4.4) -> surface sound patch slot [V jump table 0x7473e8]
MATERIALS = ['GRASS', 'ASPHALT', 'GRAVEL', 'WATERASPHALT', 'MUD', 'SAND', 'WOOD', 'SNOW', 'SNOWCHUNKY', 'SNOWDEEP',
             'SNOWASPHALT', 'SNOWDITCH', 'GRAVELDEEP', 'COBBLES', 'LEAF', 'ASPHALTGRASS', 'GRAVELGRASS', 'MUDGRASS',
             'MUDDITCH', 'SANDDEEP', 'ICEASPHALT', 'SANDDARK', 'SANDDARKDEEP']
MATERIAL_SLOT = {0: 10, 1: 0, 2: 4, 3: 3, 4: 7, 5: 11, 6: None, 7: 14, 8: 15, 9: 16, 10: 17, 11: 18, 12: 6,
                 13: None, 14: None, 15: 1, 16: 5, 17: 8, 18: 9, 19: 12, 20: 2, 21: None, 22: 13}
# collision type (material id of the hit, +100 for object materials) -> Collision.ssc patch [V table 0x746e3c]
COLL_HARD = [0, 1, 2, 4, 5, 12, 13, 15, 16, 19, 20, 21, 22, 100, 101, 102, 104, 105, 112, 113, 115, 116, 119, 120, 121, 122]
COLL_SNOW = [7, 8, 9, 10, 11, 107, 108, 109, 110, 111]
COLL_TREE = [6, 106]

# ----------------------------------------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------------------------------------
_FLOAT = re.compile(r'\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)')
_INT = re.compile(r'\s*([+-]?\d+)')


def c_atof(s):
    m = _FLOAT.match(s or '')
    return float(m.group(1)) if m else 0.0


def c_atoi(s):
    m = _INT.match(s or '')
    return int(m.group(1)) if m else 0


class FS:
    """case-insensitive index of research/full (the original ran on Windows)."""

    def __init__(self, base):
        self.base = base
        self.idx = {}
        for r, ds, fs in os.walk(base):
            for f in fs:
                p = os.path.relpath(os.path.join(r, f), base).replace('\\', '/')
                self.idx.setdefault(p.lower(), p)

    def resolve(self, rel):
        rel = os.path.normpath(rel.replace('\\', '/')).replace('\\', '/').lstrip('/')
        return self.idx.get(rel.lower())

    def files(self, pred):
        return sorted(p for p in self.idx.values() if pred(p))


def norm(p):
    return os.path.normpath(p.replace('\\', '/')).replace('\\', '/')


# ----------------------------------------------------------------------------------------------------------
# the .ssc loader (faithful to FUN_005f7940 preprocessor + FUN_005fd0e0 dispatcher)
# ----------------------------------------------------------------------------------------------------------
class SscParser:
    def __init__(self, fs):
        self.fs = fs

    def parse(self, rel):
        self.maps = {}           # map name -> {key: index}
        self.cur_map = None
        self.skip = False
        self.patches = []
        self.patch = None        # builder
        self.layer = None
        self.effect = None
        self.warn = []
        self.stats = collections.Counter()
        self.includes = []
        self.ignored = collections.Counter()
        self._file(rel, 0)
        if self.effect is not None:
            self.warn.append('effect not closed at end of file')
        return {'file': rel, 'includes': self.includes, 'maps': self.maps, 'patches': self.patches,
                'warnings': self.warn, 'keywordCounts': dict(self.stats),
                'ignoredLineHeads': dict(self.ignored)}

    def _file(self, rel, depth):
        real = self.fs.resolve(rel)
        if real is None:
            self.warn.append('missing file %s' % rel)
            return
        raw = open(os.path.join(self.fs.base, real), 'rb').read()
        text = raw.decode('latin-1')
        nbytes = 0
        for lineno, line in enumerate(text.splitlines(), 1):
            nbytes += len(line)
            self._line(line.strip(), real, lineno, depth)
        self.consumed = len(raw)

    def _line(self, line, real, lineno, depth):
        # --- block skip / C comments (FUN_005f7940) ---
        if line == 'endSkip' or '*/' in line:
            self.skip = False
            return
        if self.skip:
            return
        if line == 'beginSkip' or '/*' in line:
            self.skip = True
            return
        if not line:
            return
        # --- #beginMap / #endMap (FUN_005f7ed0): entries get 0-based indices ---
        if self.cur_map is not None:
            if line.startswith('#endMap'):
                self.cur_map = None
            else:
                name = line.split()[0]
                m = self.maps[self.cur_map]
                m.setdefault(name, len(m))
            return
        if line.startswith('#beginMap'):
            parts = line.split()
            self.cur_map = parts[1] if len(parts) > 1 else ''
            self.maps.setdefault(self.cur_map, {})
            return
        # --- #map<Map::Key> -> index text (FUN_005f7bd0, recursive) ---
        guard = 0
        while '#map' in line and guard < 16:
            guard += 1
            m = re.search(r'#map<([^:>]*)::([^>]*)>', line)
            if not m:
                self.warn.append('%s:%d malformed #map' % (real, lineno))
                break
            mp, key = m.group(1), m.group(2)
            if mp not in self.maps or key not in self.maps[mp]:
                self.warn.append('%s:%d unknown #map<%s::%s>' % (real, lineno, mp, key))
                val = ''
            else:
                val = str(self.maps[mp][key])
            line = line[:m.start()] + val + line[m.end():]
            self._mapref = (mp, key)
        # --- #include (FUN_005f87a0): relative to the including file ---
        if line.startswith('#include'):
            arg = line[len('#include'):].strip()
            inc = norm(os.path.join(os.path.dirname(real), arg))
            self.includes.append(inc)
            if depth < 8:
                self._file(inc, depth + 1)
            return
        if line.startswith('#templateLevel'):
            self.warn.append('%s:%d #templateLevel (unhandled)' % (real, lineno))
            return
        tok = line.split(None, 1)
        cmd = tok[0]
        args = tok[1] if len(tok) > 1 else ''
        if cmd == 'newPatch':                         # FUN_005f7940 -> FUN_005fe170
            self.stats[cmd] += 1
            self._end_patch()
            self.patch = {'index': len(self.patches), 'layers': [], 'line': lineno, 'comment': self._lastcomment}
            self.patches.append(self.patch)
            self.layer = None
            return
        if cmd not in KW:
            # every other line (comments "*** x ***", "rem", typos) is ignored by FUN_005fc480 failing
            if re.match(r'^\*+\s*[A-Za-z]', line):
                self._lastcomment = line.strip('* ').strip()
            self.ignored[cmd[:12]] += 1
            return
        self.stats[cmd] += 1
        self._cmd(cmd, args, real, lineno)

    _lastcomment = ''
    _mapref = None

    def _end_patch(self):
        pass

    def _need_layer(self, cmd, real, lineno):
        if self.patch is None:
            self.warn.append('%s:%d %s before any newPatch (would crash the original)' % (real, lineno, cmd))
            return False
        if self.layer is None:
            self.warn.append('%s:%d %s before any load in the patch (null layer in the original)' % (real, lineno, cmd))
            return False
        return True

    def _cmd(self, cmd, args, real, lineno):
        if cmd in ('load', 'stream'):
            if self.patch is None:
                self.warn.append('%s:%d load before newPatch' % (real, lineno))
                return
            path = args.strip()
            self.layer = {
                'path': path, 'line': lineno, 'comment': self._lastcomment,
                # defaults of the 0x50-byte layer description, ctor FUN_00604350
                'is3d': True, 'stream': cmd == 'stream', 'loop': False, 'stop': 'ImmediateReset',
                'volume': 1.0, 'pan': 0.0, 'minDistance': 1.0, 'randomPlay': 0, 'randomStartPitch': [0.0, 0.0],
                'relativePosition': [0.0, 0.0, 0.0], 'doppler': True, 'priority': 0, 'trigger': 'Default',
                'effects': [],
            }
            self.patch['layers'].append(self.layer)
            return
        if cmd == 'beginEffect':
            if not self._need_layer(cmd, real, lineno):
                return
            if self.effect is not None:
                self.warn.append('%s:%d beginEffect inside an open effect (previous one is dropped)' % (real, lineno))
            self.effect = {'dest': None, 'source': None, 'extern': 0, 'externName': None, 'envelope': None,
                           'params': [], 'line': lineno, 'comment': self._lastcomment}
            return
        if cmd in ('controlSource', 'controlDestination', 'envelope', 'param', 'paramController', 'endEffect'):
            if self.effect is None:
                self.warn.append('%s:%d %s outside beginEffect' % (real, lineno, cmd))
                return
            e = self.effect
            if cmd == 'controlSource':
                t = args.split(None, 1)
                name = t[0] if t else ''
                if name not in SRC:
                    self.warn.append('%s:%d unknown controlSource %r' % (real, lineno, name))
                    return
                e['source'] = name
                e['extern'] = c_atoi(t[1] if len(t) > 1 else '')     # FUN_00604820 atoi(rest)
                if self._mapref and name in ('Extern', 'Default'):
                    e['externName'] = '%s::%s' % self._mapref
                self._mapref = None
            elif cmd == 'controlDestination':
                name = args.split()[0] if args.split() else ''
                if name not in DEST:
                    self.warn.append('%s:%d unknown controlDestination %r' % (real, lineno, name))
                    return
                if name != 'Controller':                                   # FUN_00604800 ignores 3
                    e['dest'] = name
            elif cmd == 'envelope':
                name = args.split()[0] if args.split() else ''
                if name not in ENV:
                    self.warn.append('%s:%d unknown envelope %r' % (real, lineno, name))
                    return
                e['envelope'] = name
            elif cmd == 'param':
                e['params'].append(c_atof(args))
            elif cmd == 'paramController':
                e.setdefault('paramControllers', []).append(c_atoi(args))
            elif cmd == 'endEffect':
                if e['dest'] is None or e['source'] is None or e['envelope'] is None:
                    self.warn.append('%s:%d effect missing dest/source/envelope: %r' % (real, lineno, e))
                env = e['envelope'] or 'Ramp'
                n = ENV_NPARAM[env]
                eff = list(ENV_DEFAULT[env])
                for i, v in enumerate(e['params'][:n]):
                    eff[i] = v
                if len(e['params']) > n:
                    self.warn.append('%s:%d %d params for %s (extra ignored)' % (real, lineno, len(e['params']), env))
                e['effective'] = eff
                self.layer['effects'].append(e)
                self.effect = None
            return
        if not self._need_layer(cmd, real, lineno):
            return
        L = self.layer
        if cmd == 'stereo':
            L['is3d'] = False
        elif cmd == 'loop':
            L['loop'] = True
        elif cmd == 'volume':
            L['volume'] = c_atof(args)
        elif cmd == 'pan':
            L['pan'] = c_atof(args)
        elif cmd == 'minDistance':
            L['minDistance'] = c_atof(args)
        elif cmd == 'priority':
            L['priority'] = c_atoi(args)
        elif cmd == 'trigger':
            name = args.split()[0] if args.split() else ''
            if name in TRIG:
                L['trigger'] = name
            else:
                self.warn.append('%s:%d unknown trigger %r' % (real, lineno, name))
        elif cmd == 'randomStartPitch':
            a = args.split('/')
            L['randomStartPitch'] = [c_atof(a[0]), c_atof(a[1]) if len(a) > 1 else 0.0]
        elif cmd == 'randomPlay':
            L['randomPlay'] = c_atoi(args)
            self.patch['randomPlay'] = L['randomPlay']
        elif cmd == 'relativePosition':
            a = args.split('/')
            L['relativePosition'] = [c_atof(a[i]) if i < len(a) else 0.0 for i in range(3)]
        elif cmd == 'dopplerOff':
            L['doppler'] = False
        elif cmd == 'stop':
            name = args.split()[0] if args.split() else ''
            if name in STOP:
                L['stop'] = name
            else:
                self.warn.append('%s:%d unknown stop mode %r' % (real, lineno, name))


# ----------------------------------------------------------------------------------------------------------
# WAV
# ----------------------------------------------------------------------------------------------------------
def read_wav(path):
    d = open(path, 'rb').read()
    info = {'bytes': len(d), 'ok': False, 'chunks': []}
    if d[:4] != b'RIFF' or d[8:12] != b'WAVE':
        info['error'] = 'not RIFF/WAVE'
        return info, None
    riff = struct.unpack_from('<I', d, 4)[0]
    info['riffSizeOk'] = riff + 8 == len(d)
    o = 12
    fmt = data = None
    smpl = None
    while o + 8 <= len(d):
        cid = d[o:o + 4].decode('latin-1')
        n = struct.unpack_from('<I', d, o + 4)[0]
        info['chunks'].append(cid)
        if cid == 'fmt ':
            fmt = struct.unpack_from('<HHIIHH', d, o + 8)
        elif cid == 'data':
            data = (o + 8, n)
        elif cid == 'smpl' and n >= 36:
            nl = struct.unpack_from('<I', d, o + 8 + 28)[0]
            loops = []
            for k in range(nl):
                if o + 8 + 36 + 24 * (k + 1) <= len(d):
                    cue, typ, st, en, frac, cnt = struct.unpack_from('<IIIIII', d, o + 8 + 36 + 24 * k)
                    loops.append([st, en])
            smpl = loops
        o += 8 + n + (n & 1)
    info['trailingBytes'] = len(d) - o if o <= len(d) else -(o - len(d))
    if not fmt or not data:
        info['error'] = 'missing fmt/data'
        return info, None
    tag, ch, rate, bps, align, bits = fmt
    info.update({'format': tag, 'channels': ch, 'rate': rate, 'bits': bits, 'blockAlign': align})
    off, n = data
    n_avail = min(n, len(d) - off)
    info['dataBytes'] = n
    info['dataTruncated'] = n_avail < n
    if smpl is not None:
        info['smplLoops'] = smpl
    if tag != 1 or bits not in (8, 16):
        info['error'] = 'unsupported format tag %d bits %d' % (tag, bits)
        return info, None
    frames = n_avail // align
    info['frames'] = frames
    info['seconds'] = round(frames / rate, 4)
    info['dataRemainder'] = n_avail % align
    raw = d[off:off + frames * align]
    if bits == 16:
        import numpy as np
        a = np.frombuffer(raw, '<i2').astype(np.float32) / 32768.0
    else:
        import numpy as np
        a = (np.frombuffer(raw, 'u1').astype(np.float32) - 128) / 128.0
    a = a.reshape(-1, ch) if ch > 1 else a.reshape(-1, 1)
    import numpy as np
    info['peak'] = round(float(np.abs(a).max()) if a.size else 0.0, 4)
    info['rmsDb'] = round(20 * math.log10(max(1e-9, float(np.sqrt((a ** 2).mean())) if a.size else 1e-9)), 2)
    if a.size:
        seam = float(np.abs(a[0] - a[-1]).max())
        info['loopSeamJump'] = round(seam, 4)
    info['ok'] = True
    return info, a


# ----------------------------------------------------------------------------------------------------------
# .con helpers
# ----------------------------------------------------------------------------------------------------------
def con_lines(fs, rel):
    real = fs.resolve(rel)
    if real is None:
        return None, []
    t = open(os.path.join(fs.base, real), 'rb').read().decode('latin-1')
    return real, [l.strip() for l in t.splitlines()]


def parse_car_player(fs, rel):
    real, lines = con_lines(fs, rel)
    if real is None:
        return None
    out = {'file': real, 'template': None, 'class': None, 'engineDeltaDistance': None, 'pipeDeltaDistance': None,
           'scripts': [], 'otherCommands': []}
    base = os.path.dirname(real)
    for l in lines:
        if not l or l.lower().startswith('rem'):
            continue
        t = l.split()
        c = t[0]
        if c == 'ObjectTemplate.create':
            out['class'], out['template'] = t[1], t[2]
        elif c == 'ObjectTemplate.setEngineDeltaDistance':
            out['engineDeltaDistance'] = c_atof(t[1])
        elif c == 'ObjectTemplate.setPipeDeltaDistance':
            out['pipeDeltaDistance'] = c_atof(t[1])
        elif c == 'ObjectTemplate.loadSoundScript':
            p = norm(os.path.join(base, t[1]))
            out['scripts'].append({'index': len(out['scripts']), 'path': p, 'resolved': fs.resolve(p)})
        else:
            out['otherCommands'].append(l)
    return out


def ramp(eff, x):
    """Ramp envelope, FUN_00605e50 (x87 compare order reproduced)."""
    x0, x1, y0, dy, curve, e = eff
    if x1 < x0:
        x1 = x0
    if x <= x0:
        if x0 == x1 and x >= x0:
            return y0 + dy
        return y0
    if x >= x1:
        return y0 + dy
    t = (x - x0) / (x1 - x0)
    c = int(curve)            # __ftol truncation
    if c == 0:
        return y0 + dy * t
    if c == 1:
        return y0 + dy * (1.0 - (1.0 - t) ** e)
    if c == 2:
        return y0 + dy * t ** e
    return y0 + y0           # default branch of the switch (unused by the data)


def linear(eff, x):
    return eff[0] + eff[1] * x      # FUN_00605d70


def layer_eval(layer, ext, dist=0.0, time=10.0, trel=-1.0, speed_ms=0.0):
    """volume and pitch of one layer for a set of externs (no 3-D attenuation, master volumes = 1)."""
    v = min(1.0, layer['volume'])
    if v <= 0:
        v = 0.0
    pitch = 1.0
    for e in layer['effects']:
        src = e['source']
        if src == 'Default':
            x = ext.get(0, 0.0)
        elif src == 'Extern':
            x = ext.get(e['extern'], 0.0)
        elif src == 'Distance':
            x = dist
        elif src == 'Time':
            x = time
        elif src == 'TimeRelease':
            x = trel
        elif src == 'Speed':
            x = speed_ms
        else:
            x = 0.0
        y = ramp(e['effective'], x) if e['envelope'] == 'Ramp' else linear(e['effective'], x)
        if e['dest'] == 'Volume':
            v *= y
        elif e['dest'] == 'Pitch':
            pitch *= y
    return max(0.0, v), pitch


# ----------------------------------------------------------------------------------------------------------
# pacenotes / AI spline
# ----------------------------------------------------------------------------------------------------------
def read_spl(path):
    cv = []
    for l in open(path, encoding='latin-1'):
        m = re.match(r'cv\[\d+\]=([-\d.eE+]+),([-\d.eE+]+),([-\d.eE+]+)', l.strip())
        if m:
            cv.append(tuple(float(m.group(i)) for i in (1, 2, 3)))
    return cv


def bspline_samples(cv, per=20):
    import numpy as np
    P = np.array(cv)
    out = []
    for i in range(len(P) - 3):
        p0, p1, p2, p3 = P[i:i + 4]
        for k in range(per):
            t = k / per
            b0 = (1 - t) ** 3 / 6
            b1 = (3 * t ** 3 - 6 * t ** 2 + 4) / 6
            b2 = (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6
            b3 = t ** 3 / 6
            out.append(b0 * p0 + b1 * p1 + b2 * p2 + b3 * p3)
    return np.array(out)


# ----------------------------------------------------------------------------------------------------------
# PNG proofs (Pillow line charts)
# ----------------------------------------------------------------------------------------------------------
PALETTE = [(31, 119, 180), (255, 127, 14), (44, 160, 44), (214, 39, 40), (148, 103, 189), (140, 86, 75),
           (227, 119, 194), (127, 127, 127), (188, 189, 34), (23, 190, 207)]


def chart(draw, box, series, xr, yr, title, font, xlabel=''):
    x0, y0, x1, y1 = box
    draw.rectangle(box, outline=(90, 90, 90), fill=(255, 255, 255))
    draw.text((x0 + 4, y0 + 2), title, fill=(0, 0, 0), font=font)
    for gy in range(5):
        yy = y1 - (y1 - y0 - 14) * gy / 4
        draw.line([(x0, yy), (x1, yy)], fill=(225, 225, 225))
        draw.text((x0 + 2, yy - 10), '%.2g' % (yr[0] + (yr[1] - yr[0]) * gy / 4), fill=(120, 120, 120), font=font)
    if xlabel:
        draw.text((x1 - 6 * len(xlabel) - 4, y1 - 12), xlabel, fill=(120, 120, 120), font=font)
    for si, (name, pts) in enumerate(series):
        col = PALETTE[si % len(PALETTE)]
        P = [(x0 + (x1 - x0) * (px - xr[0]) / (xr[1] - xr[0]),
              y1 - (y1 - y0 - 14) * (min(max(py, yr[0]), yr[1]) - yr[0]) / (yr[1] - yr[0])) for px, py in pts]
        draw.line(P, fill=col, width=2)
        draw.text((x0 + 4, y0 + 14 + 11 * si), name, fill=col, font=font)


def make_pngs(dump, scripts, fs):
    from PIL import Image, ImageDraw, ImageFont
    os.makedirs(ART, exist_ok=True)
    font = ImageFont.load_default()
    # 1) Ramp curve modes
    im = Image.new('RGB', (760, 300), (245, 245, 245))
    dr = ImageDraw.Draw(im)
    xs = [i / 100 * 1.2 - 0.1 for i in range(101)]
    ser = [('curve0 linear  (0,1,0,1)', [(x, ramp([0, 1, 0, 1, 0, 1], x)) for x in xs]),
           ('curve1 e=2 ease-out', [(x, ramp([0, 1, 0, 1, 1, 2], x)) for x in xs]),
           ('curve2 e=2 ease-in (Speed/Impulse vols)', [(x, ramp([0, 1, 0, 1, 2, 2], x)) for x in xs]),
           ('curve2 e=1.2', [(x, ramp([0, 1, 0, 1, 2, 1.2], x)) for x in xs]),
           ('step x0==x1=0.5 (1,-1): Ouside', [(x, ramp([0.5, 0.5, 1, -1, 0, 1], x)) for x in xs])]
    chart(dr, (10, 10, 750, 290), ser, (-0.1, 1.1), (-0.05, 1.05), 'Ramp envelope FUN_00605e50: y = y0 + dy*f(t), t=(x-x0)/(x1-x0) clamped', font, 'x')
    im.save(ART + '/ramp_modes.png')

    # 2) per-car engine patches: gain & pitch vs RPM (outside camera, distance 0, steady state)
    cars = sorted(dump['carSoundPlayers'])
    cols = 4
    rows = (len(cars) + cols - 1) // cols
    W, H = 380, 230
    for kind in ('onthrottle', 'offthrottle'):
        im = Image.new('RGB', (cols * W + 10, rows * H * 2 + 10), (245, 245, 245))
        dr = ImageDraw.Draw(im)
        for ci, car in enumerate(cars):
            pl = dump['carSoundPlayers'][car]['player']
            sc = pl['scripts']
            # on-throttle: EngineThrottle (8) + idle (0); off-throttle: Pipe (1) + idle (0)
            idx = [0, 8] if kind == 'onthrottle' else [0, 1]
            gser, pser = [], []
            for si in idx:
                if si >= len(sc) or not sc[si]['resolved']:
                    continue
                s = scripts.get(sc[si]['resolved'])
                if not s:
                    continue
                for p in s['patches']:
                    for L in p['layers']:
                        nm = os.path.basename(L['path'].replace('\\', '/'))[:-4]
                        g, pp = [], []
                        for r in range(0, 10001, 100):
                            ext = {0: float(r), 1: 3.0, 2: 1.0 if kind == 'onthrottle' else 0.0, 6: 80.0, 9: 1.0, 8: 4.0}
                            v, pi = layer_eval(L, ext, dist=0.0, time=10.0)
                            g.append((r, v))
                            pp.append((r, pi))
                        gser.append((nm, g))
                        pser.append((nm, pp))
            x, y = 5 + (ci % cols) * W, 5 + (ci // cols) * 2 * H
            chart(dr, (x, y, x + W - 8, y + H - 6), gser, (0, 10000), (0, 1.0), '%s gain vs rpm (%s, outside)' % (car, kind), font, 'rpm')
            chart(dr, (x, y + H, x + W - 8, y + 2 * H - 6), pser, (0, 10000), (0, 2.2), '%s pitch (playbackRate) vs rpm' % car, font, 'rpm')
        im.save(ART + '/engine_%s_curves.png' % kind)

    # 2b) one car, large: ImprezaWRX engine stack outside / inside, on / off throttle, and pitch
    pl = dump['carSoundPlayers'].get('ImprezaWRX', {}).get('player')
    if pl:
        im = Image.new('RGB', (1560, 1000), (245, 245, 245))
        dr = ImageDraw.Draw(im)
        panels = [('on-throttle, OUTSIDE camera', [0, 8], 1.0, 1.0), ('on-throttle, INSIDE camera', [0, 8], 1.0, 0.0),
                  ('off-throttle, OUTSIDE camera', [0, 1], 0.0, 1.0), ('off-throttle, INSIDE camera', [0, 1], 0.0, 0.0)]
        for k, (title, idx, thr, outside) in enumerate(panels):
            ser, pser = [], []
            for si in idx:
                s = scripts.get(pl['scripts'][si]['resolved'])
                for p in s['patches']:
                    for L in p['layers']:
                        nm = '%s:%s' % (CAR_SCRIPT_ROLES[si][0], os.path.basename(L['path'].replace('\\', '/'))[:-4])
                        pts, pp = [], []
                        for r in range(0, 10001, 50):
                            v, pi = layer_eval(L, {0: float(r), 1: 3.0, 2: thr, 6: 80.0, 9: outside}, dist=0.0, time=10.0)
                            pts.append((r, v))
                            pp.append((r, pi))
                        ser.append((nm, pts))
                        pser.append((nm, pp))
            x, y = 10 + (k % 2) * 775, 10 + (k // 2) * 330
            chart(dr, (x, y, x + 765, y + 320), ser, (0, 10000), (0, 1.0), 'ImprezaWRX layer gain vs Car::Rpm, %s (Speed 80 km/h, distance 0, Time>0.7 s)' % title, font, 'rpm')
            if k == 0:
                chart(dr, (10, 670, 1540, 990), pser, (0, 10000), (0, 1.3), 'ImprezaWRX layer pitch (= AudioBufferSourceNode.playbackRate) vs Car::Rpm  (Idle* pitch follows Car::Speed: 0.9..1.0 over 1..20 km/h)', font, 'rpm')
        im.save(ART + '/engine_ImprezaWRX.png')

    # 3) surface patches vs speed for asphalt / gravel / snow (outside, 4 wheels)
    wf = scripts.get(fs.resolve('Cars/cars/General/Sounds/WheelFriction.ssc'))
    if wf:
        im = Image.new('RGB', (1140, 260), (245, 245, 245))
        dr = ImageDraw.Draw(im)
        for k, (slot, nm) in enumerate([(0, 'ASPHALT'), (4, 'GRAVEL'), (14, 'SNOW')]):
            ser = []
            for L in wf['patches'][slot]['layers']:
                pts = [(s, layer_eval(L, {6: float(s), 8: 4.0, 9: 1.0, 0: 3000.0})[0]) for s in range(0, 201, 2)]
                ser.append((os.path.basename(L['path'].replace('\\', '/')) + ' rp=%s' % L['relativePosition'], pts))
            chart(dr, (10 + k * 375, 10, 375 + k * 375, 250), ser, (0, 200), (0, 1.0), 'WheelFriction %s (outside, 4 wheels)' % nm, font, 'km/h')
        im.save(ART + '/surface_roll_curves.png')


# ----------------------------------------------------------------------------------------------------------
def main():
    no_png = '--no-png' in sys.argv
    fs = FS(FULL)
    dump = {'meta': {'tool': 'research/tools/fmt_sound.py', 'spec': 'research/formats/sound.md'}}

    # ---- all .ssc ----
    ssc_files = fs.files(lambda p: p.lower().endswith('.ssc'))
    P = SscParser(fs)
    scripts = {}
    kwtot = collections.Counter()
    ign = collections.Counter()
    for f in ssc_files:
        r = P.parse(f)
        r['consumedBytes'] = P.consumed
        r['fileBytes'] = os.path.getsize(os.path.join(FULL, f))
        scripts[f] = r
        kwtot.update(r['keywordCounts'])
        ign.update(r['ignoredLineHeads'])

    # ---- resolve every load path in every tier ----
    refs = collections.defaultdict(set)
    missing = collections.defaultdict(list)
    for f, s in scripts.items():
        for p in s['patches']:
            for L in p['layers']:
                rel = L['path'].replace('\\', '/')
                res = {}
                for t in TIERS:
                    q = rel.replace('@ROOT/', '').replace('@ROOT', '').replace('@RTD', t)
                    q = norm(q).lstrip('/')
                    # @ROOT/Sound/... lives in Audio.rff -> research/full/Audio/sound/...
                    cand = fs.resolve('Audio/' + q) or fs.resolve(q) or fs.resolve('Menu/' + q)
                    res[t] = cand
                    if cand:
                        refs[cand].add(f)
                    else:
                        missing[f].append('%s [%s]' % (L['path'], t))
                L['resolved'] = res
    # ---- WAV census ----
    wavs = fs.files(lambda p: p.lower().endswith('.wav'))
    wav_info = {}
    tier_sum = collections.defaultdict(lambda: collections.Counter())
    decoded = 0
    for w in wavs:
        info, a = read_wav(os.path.join(FULL, w))
        info['referencedBy'] = sorted(refs.get(w, []))
        wav_info[w] = info
        top = w.split('/')
        group = '/'.join(top[:3]) if top[0] == 'Audio' else top[0] + ('/' + top[3] if top[0] == 'LocaleEnglish' and len(top) > 3 else '')
        ts = tier_sum[group]
        ts['files'] += 1
        ts['bytes'] += info['bytes']
        if info.get('ok'):
            decoded += 1
            ts['seconds'] = ts.get('seconds', 0) + info['seconds']
            ts['fmt %dch %dHz %dbit' % (info['channels'], info['rate'], info['bits'])] += 1
            if info.get('smplLoops'):
                ts['withSmplLoop'] += 1
    # tier pairing (same relative names in every quality tier?)
    names = {t.lower(): set(p.lower().split('/', 3)[3] for p in wavs if p.lower().startswith('audio/sound/%s/' % t.lower())) for t in TIERS}
    dump['wavCensus'] = {
        'total': len(wavs), 'decodedOk': decoded,
        'byGroup': {k: {kk: (round(vv, 1) if isinstance(vv, float) else vv) for kk, vv in v.items()} for k, v in sorted(tier_sum.items())},
        'tierNameSetsEqual': names['11khz'] == names['22khz'] == names['44khz'],
        'tierOnly': {t: sorted(names[t.lower()] - names['44khz'] if t != '44khz' else names[t.lower()] - names['22khz'])[:20] for t in TIERS},
        'unreferencedAudioRffWavs44': sorted(w for w in wavs if w.lower().startswith('audio/sound/44khz/') and w not in refs),
        'files': wav_info,
    }

    # ---- car sound players ----
    cars = sorted(set(p.split('/')[2] for p in fs.idx.values() if p.startswith('Cars/cars/') and p.count('/') >= 3
                      and p.split('/')[2] not in ('General',)))
    players = {}
    for car in cars:
        sp = parse_car_player(fs, 'Cars/cars/%s/SoundPlayer.con' % car)
        ai = parse_car_player(fs, 'Cars/cars/%s/SoundAI.con' % car)
        if not sp and not ai:
            continue
        for pl in (sp, ai):
            if not pl:
                continue
            for s in pl['scripts']:
                s['role'] = CAR_SCRIPT_ROLES[s['index']][1] if s['index'] < len(CAR_SCRIPT_ROLES) else None
        samples = set()
        for s in (sp or {'scripts': []})['scripts']:
            if s['resolved'] and s['resolved'] in scripts:
                for p in scripts[s['resolved']]['patches']:
                    for L in p['layers']:
                        if L['resolved'].get('44khz'):
                            samples.add(L['resolved']['44khz'])
        players[car] = {'player': sp, 'ai': ai,
                        'aiMissingScripts': [s['path'] for s in (ai or {'scripts': []})['scripts'] if not s['resolved']],
                        'playerMissingScripts': [s['path'] for s in (sp or {'scripts': []})['scripts'] if not s['resolved']],
                        'carSampleDirs': sorted(set(os.path.dirname(x) for x in samples if '/Cars/' in x))}
    dump['carSoundPlayers'] = players
    dump['carScriptRoles'] = [{'index': i, 'file': a, 'role': b, 'driver': c} for i, (a, b, c) in enumerate(CAR_SCRIPT_ROLES)]
    dump['materialSurfaceSlot'] = {str(m): {'material': MATERIALS[m], 'slot': MATERIAL_SLOT[m]} for m in range(len(MATERIALS))}
    wfp = scripts.get(fs.resolve('Cars/cars/General/Sounds/WheelFriction.ssc'))
    if wfp:
        dump['surfaceSlotPatchComments'] = {
            name: [p.get('comment') for p in scripts[fs.resolve('Cars/cars/General/Sounds/%s.ssc' % name)]['patches']]
            for name in ('WheelFriction', 'WheelSlipX', 'WheelSlipZ')}
    dump['collisionTypeToPatch'] = {'hard_patch1': COLL_HARD, 'snow_patch4': COLL_SNOW, 'tree_patch5': COLL_TREE,
                                    'thresholds': 'strength >= 165 for car-side/object hits (bl=1), >= 5 otherwise; snow: >=165 only when bl=1; tree >= 5; min 0.5 s between collision sounds'}

    # ---- environment / object sound templates ----
    env = {}
    for f in fs.files(lambda p: p.startswith('Misc/object/') and p.lower().endswith('.con') and os.path.basename(p).lower().startswith('sound')):
        real, lines = con_lines(fs, f)
        cur = None
        for l in lines:
            t = l.split()
            if not t:
                continue
            if t[0] == 'ObjectTemplate.create' and len(t) >= 3:
                cur = {'class': t[1], 'template': t[2], 'file': real, 'scripts': [], 'other': []}
                env[t[2]] = cur
            elif cur and t[0] == 'ObjectTemplate.loadSoundScript':
                p = norm(os.path.join(os.path.dirname(real), t[1]))
                cur['scripts'].append({'path': p, 'resolved': fs.resolve(p)})
            elif cur and not l.lower().startswith('rem'):
                cur['other'].append(l)
    placements = collections.defaultdict(lambda: collections.Counter())
    place_pos = collections.defaultdict(list)
    for f in fs.files(lambda p: p.lower().endswith('/objects.con') and '/track/' in p.lower()):
        stage = f.split('/')[0]
        for l in open(os.path.join(FULL, f), encoding='latin-1'):
            t = l.split()
            if len(t) >= 2 and t[0] == 'Object.create' and t[1] in env:
                placements[stage][t[1]] += 1
                if len(t) >= 3:
                    place_pos[stage].append([t[1]] + [c_atof(x) for x in t[2].split('/')])
    dump['environmentSounds'] = {'templates': env, 'placementsPerStage': {k: dict(v) for k, v in sorted(placements.items())},
                                 'placementPositions': dict(place_pos),
                                 'runtime': 'FUN_007960c0/FUN_007979c0: per update, for every car within 60 m of the object: if patch 0 is not active -> rand()%20==0 starts it (play). The out-of-range and stationary-car (+0.2/update, >=18) branches call FUN_005d9640, which is an empty stub (ret) -> env sounds are never stopped by the manager; loops only fall silent through their own Distance volume ramps (verifier, see sound.md Verification)'}

    # ---- co-driver ----
    pn_real, pn_lines = con_lines(fs, 'Misc/object/Sound_PaceNotes.con')
    pace = {'masterVolume': None, 'samples': {}}
    for l in pn_lines:
        t = l.split()
        if not t:
            continue
        if t[0] == 'race.setPaceNoteMasterVolume':
            pace['masterVolume'] = c_atof(t[1])
        elif t[0] == 'race.loadPaceNote':
            rel = 'LocaleEnglish/locale/english/' + t[2]
            res = fs.resolve(rel)
            info = wav_info.get(res, {})
            pace['samples'][int(t[1])] = {'phrase': os.path.splitext(os.path.basename(t[2]))[0], 'path': t[2],
                                         'resolved': res, 'seconds': info.get('seconds')}
    tc_real, tc_lines = con_lines(fs, 'Misc/object/Sound_TeamCoach.con')
    coach = {'masterVolume': None, 'samples': {}}
    for l in tc_lines:
        t = l.split()
        if t and t[0] == 'race.setTeamCoachMasterVolume':
            coach['masterVolume'] = c_atof(t[1])
        elif t and t[0] == 'race.loadTeamCoachSample':
            res = fs.resolve('LocaleEnglish/locale/english/' + t[2])
            coach['samples'][int(t[1])] = {'path': t[2], 'resolved': res, 'seconds': wav_info.get(res, {}).get('seconds')}
    stages = {}
    sweep_data = []
    word_use = collections.Counter()
    bad_ids = collections.Counter()
    for f in fs.files(lambda p: p.lower().endswith('/pacenotes.con')):
        stage = f.split('/')[0]
        st = {'file': f, 'modes': [], 'notes': [], 'other': []}
        for l in open(os.path.join(FULL, f), encoding='latin-1'):
            t = l.split()
            if not t:
                continue
            if t[0] == 'race.PaceNotesSystemMode':
                st['modes'].append([len(st['notes']), c_atoi(t[1])])   # [notes before it, mode]
            elif t[0] == 'race.addPaceNote':
                vals = t[1:]
                if len(vals) != 10:
                    st['other'].append(l.strip())
                    continue
                kind = c_atoi(vals[0])
                words = [c_atoi(v) for v in vals[1:9] if c_atoi(v) != -1]
                dist = c_atof(vals[9])
                for w in words:
                    word_use[w] += 1
                    if w not in pace['samples']:
                        bad_ids[w] += 1
                st['notes'].append({'k': kind, 'w': words, 'd': dist,
                                    'phrase': ' '.join(pace['samples'].get(w, {}).get('phrase', '?%d' % w) for w in words)})
            else:
                st['other'].append(l.strip())
        d = [n['d'] for n in st['notes']]
        st['monotonic'] = all(b > a for a, b in zip(d, d[1:]))
        # AI centre spline length for the sanity check (pacenote distance must lie on the stage)
        spl = fs.resolve(os.path.dirname(f) + '/AiFiles/center.spl')
        if spl:
            import numpy as np
            S = bspline_samples(read_spl(os.path.join(FULL, spl)))
            seg = np.linalg.norm(np.diff(S[:, [0, 2]], axis=0), axis=1)
            st['splineLength2d'] = round(float(seg.sum()), 1)
            arc = np.concatenate([[0.0], np.cumsum(seg)])[:-1]
            head = np.unwrap(np.arctan2(np.diff(S[:, 2]), np.diff(S[:, 0])))
            sweep_data.append((st, arc, head))
            st['maxNoteOverLength'] = round(max(d) / float(seg.sum()), 3) if d else None
        st['kinds'] = dict(collections.Counter(n['k'] for n in st['notes']))
        stages[stage] = st
    # [E] where is the described corner relative to the note distance? sign of the heading change in a
    # 60 m window at d+L vs the LEFT/RIGHT word (left = heading atan2(z,x) increasing in the left-handed frame)
    import numpy as np
    sweep = {}
    for L in range(-300, 501, 25):
        agree = tot = 0
        for st, arc, head in sweep_data:
            for n in st['notes']:
                dw = [w for w in n['w'] if 1 <= w <= 10]
                if not dw:
                    continue
                a = np.interp(n['d'] + L - 30, arc, head)
                b = np.interp(n['d'] + L + 30, arc, head)
                if abs(b - a) < 0.15:
                    continue
                tot += 1
                agree += ((b - a) > 0) == (dw[0] % 2 == 1)
        sweep[L] = [tot, round(agree / max(1, tot), 3)]
    dump['coDriverLeadSweep'] = sweep
    dump['coDriver'] = {'paceNotes': pace, 'teamCoach': coach, 'stages': stages,
                        'wordUsage': {str(k): v for k, v in sorted(word_use.items())},
                        'idsWithoutSample': dict(bad_ids)}

    # ---- menu / race UI ----
    dump['menuSounds'] = {
        'scripts': {k: v for k, v in scripts.items() if k.startswith('Menu/')},
        'codeRefs': {'Menu/Sound/CheckPoint.ssc': 'FUN_00619e70 (patch 0 checkpointquicker = split faster, 1 checkpointslower) [?] patch meaning by sample name',
                     'Menu/Sound/CountDown.ssc': 'FUN_00643540 (patch 0 "3,2,1", patch 1 "go!")',
                     'Menu/Sound/Error.ssc': 'FUN_00633ab0'},
        'memeWavRefs': 'menu meme nodes name Back/Error/Screeneffekt/Select/Step/Sweep/Tag/Unlock.wav under menu/sound/ (property strings "Select sound", "Step sound", "Up down sound", "Change sound", "Failed select sound", "Cannot select sound")',
    }

    # ---- scripts (the full resolved patch data) ----
    dump['scripts'] = scripts
    tot_patches = sum(len(s['patches']) for s in scripts.values())
    tot_layers = sum(len(p['layers']) for s in scripts.values() for p in s['patches'])
    tot_eff = sum(len(L['effects']) for s in scripts.values() for p in s['patches'] for L in p['layers'])
    # census of every parameter value used
    census = collections.defaultdict(collections.Counter)
    for s in scripts.values():
        for p in s['patches']:
            for L in p['layers']:
                for k in ('is3d', 'loop', 'stream', 'stop', 'doppler', 'trigger', 'randomPlay', 'priority'):
                    census[k][str(L[k])] += 1
                census['randomStartPitch'][str(L['randomStartPitch'])] += 1
                census['pan'][str(L['pan'])] += 1
                for e in L['effects']:
                    census['dest/source'][('%s<-%s%s' % (e['dest'], e['source'], ('#%d %s' % (e['extern'], e['externName'] or '')) if e['source'] in ('Extern',) else ''))] += 1
                    census['envelope/nparams'][('%s/%d' % (e['envelope'], len(e['params'])))] += 1
                    if e['envelope'] == 'Ramp':
                        census['rampCurve'][('curve=%g exp=%g' % (e['effective'][4], e['effective'][5]))] += 1
    dump['grammarCensus'] = {k: dict(v) for k, v in census.items()}
    dump['grammarCensus']['keywords'] = dict(kwtot)
    dump['grammarCensus']['ignoredLineHeads'] = dict(ign.most_common(30))

    warn_all = {f: s['warnings'] for f, s in scripts.items() if s['warnings']}
    leftover = {f: s['fileBytes'] - s['consumedBytes'] for f, s in scripts.items() if s['fileBytes'] != s['consumedBytes']}
    dump['validation'] = {
        'sscFiles': len(ssc_files), 'sscParsed': len(scripts), 'sscLeftoverBytes': leftover,
        'patches': tot_patches, 'layers': tot_layers, 'effects': tot_eff,
        'sscWarnings': warn_all,
        'missingSampleRefs': {f: v for f, v in missing.items()},
        'missingSampleRefCount': sum(len(v) for v in missing.values()),
        'wavTotal': len(wavs), 'wavDecoded': decoded,
        'wavErrors': {w: i.get('error') for w, i in wav_info.items() if not i.get('ok')},
        'wavTrailingBytes': {w: i['trailingBytes'] for w, i in wav_info.items() if i.get('trailingBytes')},
        'wavDataRemainder': {w: i['dataRemainder'] for w, i in wav_info.items() if i.get('dataRemainder')},
        'carPlayers': len(players),
        'carPlayerMissingScripts': {c: v['playerMissingScripts'] for c, v in players.items() if v['playerMissingScripts']},
        'carAiMissingScripts': {c: len(v['aiMissingScripts']) for c, v in players.items() if v['aiMissingScripts']},
        'paceNoteStages': len(stages),
        'paceNoteIdsWithoutSample': dict(bad_ids),
        'paceNoteSamplesMissing': [k for k, v in pace['samples'].items() if not v['resolved']],
        'teamCoachSamplesMissing': [k for k, v in coach['samples'].items() if not v['resolved']],
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w') as fh:
        json.dump(dump, fh, indent=1, sort_keys=False, default=str)
    v = dump['validation']
    print('ssc: %d files parsed (%d with leftover bytes), %d patches, %d layers, %d effects' % (
        v['sscParsed'], len(leftover), tot_patches, tot_layers, tot_eff))
    print('ssc warnings in %d files; missing sample refs: %d (in %d files)' % (len(warn_all), v['missingSampleRefCount'], len(missing)))
    print('wav: %d files, %d decoded; errors %d; trailing-bytes files %d' % (len(wavs), decoded, len(v['wavErrors']), len(v['wavTrailingBytes'])))
    print('car players: %d; AI scripts missing in %d cars' % (len(players), len(v['carAiMissingScripts'])))
    print('pacenote stages: %d; ids without sample: %s' % (len(stages), dict(bad_ids)))
    if not no_png:
        make_pngs(dump, scripts, fs)
        print('pngs ->', ART)


if __name__ == '__main__':
    main()
