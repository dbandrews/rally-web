#!/usr/bin/env python3
"""
fmt_replay.py -- replay cameras (Cameras.con), the onboard replay camera entries (CarCamera 13..24), the replay UI
meme layout and a reference implementation of the original's TV-camera solver.  Spec: research/formats/replay.md.

Data
  <archive>/track/<name>/<forward|reverse>/Cameras.con (48 files, 1 019 cameras), exactly:
      race.ReplayCameraSystemMode 1
      race.addReplayCamera <type:int> <fovMin:f> <splineStart:f> <dolly:f> <dollyEnd:x/y/z> <rot:yaw/pitch/roll deg> <eye:x/y/z>
      race.ReplayCameraSystemMode 0
  Argument names are the exe's roles [E FUN_00749a60 store order, FUN_00749cc0 use]:
      type        0..5 TV camera kinds, 6..30 "use CarCamera entry type-6" (no data file uses >= 6)
      fovMin      a1: FOV floor in degrees for the distance zoom; 0 = the camera's base FOV (70)
      splineStart s0: the camera is active while s0 <= car spline distance < next camera's s0
      dolly       a3: dolly length L; types 2/3/5 move eye -> eye + (dollyEnd - eye)*(s - s0)/(L + 1) (no clamp)
      dollyEnd    arg 5 ("pos" in older notes): only types 2, 3, 5 read it
      rot         arg 6 (yaw, pitch, roll) degrees: only types 4, 5 read it (M = Rz(roll) Rx(pitch) Ry(yaw), row vectors)
      eye         arg 7 ("target" in older notes): the camera position (at s0 for the dolly types)
  Frame: the original frame = rally-web SIM (x right, y up, z forward; three = (x, y, -z)), like the spline CVs.

Usage
    .venv/bin/python -I tools/assets/lib/formats/fmt_replay.py dump [--out research/formats/replay_dump.json]
    .venv/bin/python -I tools/assets/lib/formats/fmt_replay.py verify
Library
    import fmt_replay as R
    R.parse_cameras_con(path) -> {'modeHistory': [...], 'cameras': [...], 'lines': n}
    R.solve_tv(cams, s, car_pos, state, mode=0, base_fov=70.0, out_pos=(0,0,0), rand=None) -> (ret, M4x4, fov)
"""
from __future__ import annotations

import glob
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import FULL, REPO  # noqa: E402

STAGE_RX = re.compile(r'^(corsica|hillclimb|iceracing|kenya|newzealand|rallycross)(\d)([a-c]?)([fr])$')


def stage_id(archive: str) -> str | None:
    """'hillclimb1af' -> 'hillclimb-1a-f' (the rally-web stage id)."""
    m = STAGE_RX.match(archive)
    return f'{m.group(1)}-{m.group(2)}{m.group(3)}-{m.group(4)}' if m else None


def _num(t: str) -> float:
    return float(t)


def _vec(t: str) -> list[float]:
    p = t.split('/')
    if len(p) != 3:
        raise ValueError(f'bad vec3 {t!r}')
    return [float(x) for x in p]


def parse_cameras_con(path: str) -> dict:
    """Parse one Cameras.con. Every non-blank line must be one of the two commands (verified on all 48 files)."""
    out = {'modeHistory': [], 'cameras': [], 'lines': 0, 'unknown': []}
    for raw in open(path, 'rb').read().decode('latin-1').splitlines():
        t = raw.strip().split()
        if not t:
            continue
        out['lines'] += 1
        w = t[0].lower()
        if w == 'race.replaycamerasystemmode':
            out['modeHistory'].append(int(_num(t[1])) if len(t) > 1 else None)
        elif w == 'race.addreplaycamera':
            if len(t) != 8:
                raise ValueError(f'{path}: addReplayCamera needs exactly 7 args [E exec 0x443c50]: {raw!r}')
            out['cameras'].append({
                'type': int(_num(t[1])), 'fovMin': _num(t[2]), 'splineStart': _num(t[3]), 'dolly': _num(t[4]),
                'dollyEnd': _vec(t[5]), 'rot': _vec(t[6]), 'eye': _vec(t[7]),
            })
        else:
            out['unknown'].append(raw)
    return out


def camera_files() -> list[tuple[str, str]]:
    """[(archive, path)] for every stage archive that has a Cameras.con."""
    res = []
    for p in sorted(glob.glob(os.path.join(FULL, '*', 'track', '*', '*', 'Cameras.con'))):
        arch = os.path.relpath(p, FULL).split(os.sep)[0]
        res.append((arch, p))
    return res


# ------------------------------------------------------------------------------------------------ CarCamera

CAM_RX = re.compile(r'^\s*ObjectTemplate\.setCamPosition\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)', re.I)


def car_camera_entries(car: str) -> list[dict] | None:
    """The car's <Car>CarCamera table (25 entries: i, enabled, flag, posA, posB, param) from Cars/cars/<car>/Templates.con."""
    p = os.path.join(FULL, 'Cars', 'cars', car, 'Templates.con')
    if not os.path.isfile(p):
        return None
    ents = {}
    for raw in open(p, 'rb').read().decode('latin-1').splitlines():
        if raw.strip().lower().startswith('rem'):
            continue
        m = CAM_RX.match(raw)
        if m:
            i = int(m.group(1))
            ents[i] = {'i': i, 'enabled': int(m.group(2)), 'flag': int(m.group(3)), 'posA': _vec(m.group(4)),
                       'posB': _vec(m.group(5)), 'param': _vec(m.group(6))}
    return [ents[i] for i in sorted(ents)]


# CarCamera entry -> camera function [E jump tables 0x764b24 (player modes 15..38) and 0x763f04 (replay onboard 0..24)]
ENTRY_FUNCS = {
    0: ('0x75e390', 'bumper: rigid + G-sway + 0.1 rad pitch + surface shake'),
    1: ('0x75e790', 'bonnet: rigid'),
    2: ('0x75eb90', 'cockpit-type rigid (disabled on all cars)'), 3: ('0x75ef60', 'cockpit-type rigid (disabled)'),
    4: ('0x75f340', 'cockpit-type rigid (disabled)'),
    5: ('0x75fca0', 'chase string camera (core 0x75f720)'), 6: ('0x75fda0', 'chase'), 7: ('0x75fea0', 'chase'),
    8: ('0x75ffa0', 'chase'), 9: ('0x7600a0', 'chase (disabled for the player)'),
    10: ('0x7601a0', 'tether'), 11: ('0x760590', 'tether (disabled for the player)'), 12: ('0x760980', 'tether'),
    13: ('0x7610d0', 'rigid at posA + G-sway, yawed +90 deg (side camera)'),
    14: ('0x7614e0', 'rigid at posA + G-sway (car orientation)'), 15: ('0x761830', 'rigid + G-sway'),
    16: ('0x761b80', 'rigid + G-sway'), 17: ('0x761ed0', 'rigid + G-sway'),
    18: ('0x762220', 'rigid + G-sway + yaw (never picked by the replay)'), 19: ('0x762630', 'as 18'),
    20: ('0x762a40', 'as 18'), 21: ('0x762e50', 'as 18'), 22: ('0x763260', 'as 18'),
    23: ('0x763670', 'player mode 38 = the replay TV camera'),
    24: ('0x763f70', 'rear view (look back): posA + G-sway, +0.1 rad pitch, yawed 180 deg'),
}
# playerCameraViews option index -> CarCamera entry [E table 0x8479c0, FUN_0049cae0]
OPTION_ENTRIES = [0, 1, 5, 6, 7, 8, 10, 12]
# option labels / tooltips (LocaleEnglish ids; Menu/menu/Options/CameraOptionsFrame)
OPTION_LOCALE = [(509, 519), (510, 520), (511, 521), (512, 522), (513, 523), (515, 525), (516, 526), (518, 528)]
# Replay onboard pick: rand()%25 + 6, rejected 6, 8, 9, 10, 24..28 -> entry = value - 6 [E 0x749d42-0x749d81]
ONBOARD_ENTRIES = [v - 6 for v in range(6, 31) if v not in (6, 8, 9, 10, 24, 25, 26, 27, 28)]


def pick_onboard(rand) -> int:
    """The original's replay onboard pick (returns the CarCamera entry). `rand()` = MSVC rand (0..32767)."""
    while True:
        v = rand() % 25 + 6
        if v not in (6, 8, 9, 10, 24, 25, 26, 27, 28):
            return v - 6


# ------------------------------------------------------------------------------------------------ TV solver

def _sub(a, b): return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
def _add(a, b): return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
def _mul(a, k): return [a[0] * k, a[1] * k, a[2] * k]
def _dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def _cross(a, b): return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


EPS_LEN2 = 1e-24  # [E] global 0x93f894 (runtime-initialised; any tiny value reproduces the exe on real data)


def _norm(v):
    """FUN_004076f0 + FUN_00407630 pattern: skip when |v|^2 is within 1e-12 of 1, zero when below EPS."""
    l2 = _dot(v, v)
    if abs(l2 - 1.0) < 1e-12:
        return list(v)
    if abs(l2) < EPS_LEN2:
        return [0.0, 0.0, 0.0]
    return _mul(v, 1.0 / math.sqrt(l2))


def euler_rows(rot_deg) -> list[list[float]]:
    """Rows of Rz(roll)*Rx(pitch)*Ry(yaw) (D3D row-vector convention), rot = (yaw, pitch, roll) in degrees."""
    a, b, c = (x * math.pi / 180.0 for x in rot_deg)
    ca, sa, cb, sb, cc, sc = math.cos(a), math.sin(a), math.cos(b), math.sin(b), math.cos(c), math.sin(c)
    ry = [[ca, 0, -sa], [0, 1, 0], [sa, 0, ca]]
    rx = [[1, 0, 0], [0, cb, sb], [0, -sb, cb]]
    rz = [[cc, sc, 0], [-sc, cc, 0], [0, 0, 1]]

    def mm(p, q):
        return [[sum(p[i][k] * q[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    return mm(mm(rz, rx), ry)


def zoom_fov(base: float, fov_min: float, d: float) -> float:
    """fov = max(fovMin, min(base, 5 + base*1e4/d^3)) [E 0x749fa8-0x74a060]."""
    z = base * 10000.0 / (d * d * d) if d > 0 else float('inf')
    z = min(z, base - 5.0)
    f = base - ((base - 5.0) - z)
    return max(f, fov_min)


def look_basis(f_dir, tilt: bool):
    """Level look-at (types 0, 2, 3) or the type-1 'tilted' variant: right = (f.z, f.y if tilt else 0, -f.x)."""
    f = _norm(f_dir)
    r = _norm([f[2], f[1] if tilt else 0.0, -f[0]])
    u = _norm(_cross(f, r))
    return r, u, f


def new_state() -> dict:
    """The 0x30-byte camera-system state the solver keeps (FUN_00749c50 reset values)."""
    return {'view': 0, 'cur': 0, 'last': -1, 'flag': 0, 'curType': -1}


def _select(cams, s):
    for i in range(len(cams) - 1, -1, -1):
        if s >= cams[i]['splineStart']:
            return i
    return -1


def solve_tv(cams, s, car_pos, state, mode=0, base_fov=70.0, out_pos=(0.0, 0.0, 0.0), rand=None):
    """Reference port of FUN_00749cc0 (verified in unicorn, research/tools/replay_tvcam_emu.py).

    cams: parsed cameras in file order; s: the car's spline distance; car_pos: car position (sim frame);
    out_pos: translation of the matrix the caller passes in (the caller FUN_00763670 always passes identity,
    so the zoom distance is |car_pos| from the world origin [E 0x7636d3-0x76375e]).
    Returns (ret, M, fov): ret -2 = no camera (the caller falls back to the tether camera),
    -1 = TV camera (M = 4x4 row-major rows right/up/forward/position, fov in degrees),
    >= 0 = CarCamera entry to render with (onboard pick or type >= 6).
    """
    fov = base_fov
    if mode not in (0, 2):
        if mode == 1:
            i = _select(cams, s)
            if i >= 0:
                state['cur'] = i
                if i != state['last']:
                    state['view'] = pick_onboard(rand) + 6
                    state['last'] = state['cur']
                return state['view'] - 6, None, fov
        return -2, None, fov
    i = _select(cams, s)
    if i < 0:
        return -2, None, fov
    if mode == 2:
        state['cur'] = i
        if i != state['last']:
            state['view'] = pick_onboard(rand) + 6
            state['last'] = state['cur']
            state['flag'] = 1 if rand() % 1000 > 500 else 0
        if state['flag']:
            return state['view'] - 6, None, fov
    c = cams[i]
    t, a1, eye = c['type'], c['fovMin'], list(c['eye'])
    rows = [[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]]
    pos = eye
    state['curType'] = t
    d = math.sqrt(sum((car_pos[k] - out_pos[k]) ** 2 for k in range(3)))

    def dolly():
        return _add(eye, _mul(_sub(c['dollyEnd'], eye), (s - c['splineStart']) / (c['dolly'] + 1.0)))
    if 0 <= t <= 5 and a1 > 0:
        fov = zoom_fov(base_fov, a1, d)
    if t == 0:
        rows = list(look_basis(_sub(car_pos, eye), False))
    elif t == 1:
        rows = list(look_basis(_sub(car_pos, eye), True))
    elif t == 2:
        pos = dolly()
        rows = list(look_basis(_sub(car_pos, pos), False))
    elif t == 3:
        rows = list(look_basis(_sub(car_pos, eye), False))
        pos = dolly()
    elif t == 4:
        rows = euler_rows(c['rot'])
    elif t == 5:
        rows = euler_rows(c['rot'])
        pos = dolly()
    elif 6 <= t <= 30:
        state['view'] = t
        return t - 6, None, fov
    else:  # type < 0 or > 30: the switch default keeps the Euler matrix built before the switch [E 0x749edf-0x749f1a]
        rows = euler_rows(c['rot'])
    M = [rows[0] + [0.0], rows[1] + [0.0], rows[2] + [0.0], pos + [1.0]]
    state['view'] = t
    return -1, M, fov


# ------------------------------------------------------------------------------------------------ replay UI

def replay_ui() -> dict:
    """The replay control bar (Menu/menu/InGame/ReplayButtonFrame), parsed with fmt_meme."""
    import fmt_meme
    p = os.path.join(FULL, 'Menu', 'menu', 'InGame', 'ReplayButtonFrame')
    doc = fmt_meme.parse_file(p)
    buttons = []

    def walk(o):
        if isinstance(o, dict):
            if o.get('$class') == 'RallyTransformNode' and isinstance(o.get('Transformed node'), dict):
                tn = o['Transformed node']
                rb = tn.get('Next node') if tn.get('$class') == 'MouseCullNode' else None
                if isinstance(rb, dict) and rb.get('$class') == 'ReplayButtonNode':
                    acts = (rb.get('Select action') or {}).get('Action list') or []
                    fn = [a['Function']['$name'] for a in acts if a.get('$class') == 'CallFunctionAction']
                    post = [(a['Event type'], a['Button type']) for a in acts if a.get('$class') == 'PostButtonEventAction']
                    snd = [a['Sound'] for a in acts if a.get('$class') == 'SoundAction']
                    buttons.append({'x': o['X'], 'y': o['Y'], 'w': o['Width'], 'h': o['Height'], 'picture': rb['Picture'],
                                    'function': fn[0] if fn else None, 'postButton': post[0] if post else None,
                                    'sound': snd[0] if snd else None, 'zoomSpeed': rb['Zoom speed (static)'],
                                    'zoomSize': rb['Zoom size (static)'], 'useKeyboard': tn.get('Use keyboard')})
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(doc['root'])
    buttons.sort(key=lambda b: b['x'])
    return {'source': 'Menu/menu/InGame/ReplayButtonFrame', 'virtualScreen': [640, 480], 'buttons': buttons}


# ------------------------------------------------------------------------------------------------ CLI

def dump() -> dict:
    stages = []
    for arch, p in camera_files():
        d = parse_cameras_con(p)
        stages.append({'archive': arch, 'stage': stage_id(arch), 'file': os.path.relpath(p, REPO),
                       'modeHistory': d['modeHistory'], 'cameras': d['cameras']})
    cars = {}
    cdir = os.path.join(FULL, 'Cars', 'cars')
    if os.path.isdir(cdir):
        for car in sorted(os.listdir(cdir)):
            e = car_camera_entries(car)
            if e:
                cars[car] = [x for x in e if x['i'] >= 13]
    ui = None
    try:
        ui = replay_ui()
    except Exception as ex:  # meme parser / Menu archive missing
        ui = {'error': str(ex)}
    return {'format': 'rally-web replay dump v1 (research/formats/replay.md)', 'stages': stages,
            'carReplayEntries': cars, 'entryFunctions': {str(k): v for k, v in ENTRY_FUNCS.items()},
            'optionEntries': OPTION_ENTRIES, 'optionLocale': OPTION_LOCALE, 'onboardEntries': ONBOARD_ENTRIES,
            'replayUi': ui}


def verify() -> int:
    files = camera_files()
    n = 0
    bad = 0
    types = {}
    for arch, p in files:
        d = parse_cameras_con(p)
        n += len(d['cameras'])
        if d['unknown'] or d['modeHistory'] != [1, 0]:
            print('FAIL structure', arch, d['unknown'][:2], d['modeHistory'])
            bad += 1
        prev = -1e30
        for c in d['cameras']:
            types[c['type']] = types.get(c['type'], 0) + 1
            if c['splineStart'] < prev:
                print('FAIL non-monotonic splineStart', arch, c['splineStart'], prev)
                bad += 1
            prev = c['splineStart']
            if not 0 <= c['type'] <= 5:
                print('FAIL type', arch, c['type'])
                bad += 1
    print(f'{len(files)} files, {n} cameras, types {dict(sorted(types.items()))}, failures {bad}')
    return 1 if bad or len(files) != 48 or n != 1019 else 0


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a or a[0] not in ('dump', 'verify'):
        print(__doc__)
        sys.exit(2)
    if a[0] == 'verify':
        sys.exit(verify())
    out = a[a.index('--out') + 1] if '--out' in a else os.path.join(REPO, 'research', 'formats', 'replay_dump.json')
    with open(out, 'w') as f:
        json.dump(dump(), f, separators=(',', ':'))
    print('wrote', out)
