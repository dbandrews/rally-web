#!/usr/bin/env python3
"""fmt_aidata.py - parser for the original game's per-stage AI speed posts (topic `ai`).

Files: `.cache/original/<stage>/track/<name>/<forward|reverse>/AiFiles/AiData.con` (48 dirs).
Format and semantics: research/formats/ai.md section 3. Text console script, one command per post:

    track.aidata_addAiDataPost <lapDist> <recSpeed> <curveSpdScaleValue> <curveCutValue> <lookAheadDist> <thresholdScaleValue>

`rem` lines are comments. Posts are keyed by lapDist (spline distance); the exe's AiData manager
(DAT_00935548, vt+0x1c) selects the active post by distance. `recSpeed` is stored in m/s and
converted to km/h for AI cars (mode +0x17 == 1) with clamps (min 10 -> 250, |lateral| <= 10 -> 40):
FUN_00607280 @ 0x6078d0-0x607902, constant ds:0x8070a0.

Run:  .venv/bin/python -I tools/assets/lib/formats/fmt_aidata.py [file ...]   (default: every stage)
"""
import glob
import os
import re
import sys

CMD = re.compile(r'^\s*track\.aidata_addAiDataPost\s+'
                 r'(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$')


def parse(path):
    """Return (posts, errors). posts = list of dicts with the 6 params as floats."""
    posts, errors = [], []
    with open(path, 'r', errors='replace') as fh:
        for ln, line in enumerate(fh, 1):
            line = line.strip()
            if not line or line.startswith('rem') or line.startswith('#'):
                continue
            m = CMD.match(line)
            if not m:
                errors.append(f'{path}:{ln}: not an aidata_addAiDataPost line: {line!r}')
                continue
            vals = []
            for i, s in enumerate(m.groups()):
                try:
                    vals.append(float(s))
                except ValueError:
                    errors.append(f'{path}:{ln}: param {i} not a float: {s!r}')
                    vals.append(None)
            if None in vals:
                continue
            posts.append(dict(lapDist=vals[0], recSpeed=vals[1], curveSpd=vals[2],
                             curveCut=vals[3], lookAhead=vals[4], threshold=vals[5]))
    return posts, errors


def main(argv):
    cache = os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', '.cache', 'original')
    cache = os.path.abspath(cache)
    paths = argv[1:] or sorted(glob.glob(os.path.join(cache, '*', 'track', '*', '*', 'AiFiles', 'AiData.con')))
    bad = 0
    rs_hist, cc_hist, la_hist, th_hist = {}, {}, {}, {}
    for p in paths:
        posts, errors = parse(p)
        stage = '/'.join(p.split(os.sep)[-5:-1])
        for e in errors:
            print(e)
        bad += len(errors)
        if not posts:
            print(f'{stage}: NO POSTS')
            bad += 1
            continue
        lds = [q['lapDist'] for q in posts]
        mono = all(a <= b for a, b in zip(lds, lds[1:]))
        for q in posts:
            for key, hist in (('recSpeed', rs_hist), ('curveCut', cc_hist),
                              ('lookAhead', la_hist), ('threshold', th_hist)):
                hist[q[key]] = hist.get(q[key], 0) + 1
        print(f'{stage}: {len(posts)} posts lapDist {lds[0]:g}..{lds[-1]:g}'
              f'{" (monotonic)" if mono else " (NON-MONOTONIC)"}'
              f' recSpeed {min(q["recSpeed"] for q in posts):g}..{max(q["recSpeed"] for q in posts):g}')
    print(f'--- {len(paths)} files, {bad} errors')
    if not argv[1:]:
        for name, hist in (('recSpeed', rs_hist), ('curveCut', cc_hist),
                           ('lookAhead', la_hist), ('threshold', th_hist)):
            top = sorted(hist.items(), key=lambda kv: (-kv[1], kv[0]))
            print(f'{name}: ' + ', '.join(f'{v:g} x{k}' for v, k in top[:12]))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))