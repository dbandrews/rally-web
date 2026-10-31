#!/usr/bin/env python3
"""fmt_aitimes.py - parser for the original game's AiTimes target-schedule files (topic `ai`).

Files: `.cache/original/Misc/aitimes/...` (360 files) — plain text, per track per car:
  aitimes/<Track>/<Car>                              (Hillclimb1bf, Hillclimb2af, Kenya2f, NewZealand2f)
  aitimes/Events/<code>/<Track>/<Car>                (22 event codes, see research/formats/ai.md section 6)

Layout (e.g. Events/am/Iceracing2r/Astra):
  LapCount = 5
  TimeCount = 10
  19.650            <- cumulative split times (s) at checkpoint distances,
  42.335               one per line, TimeCount of them
  ...

The exe loads these with FUN_004dda10 (path pick by discipline: ==4 -> "AiTimes/Events/"
0x847b38, ==2/7 -> 0x868508, else "AiTimes/" 0x847b2c) and interpolates per frame in
FUN_004b4fe0 over checkpoint distances (FUN_00748160); writer FUN_004bf9b0 ("New AiTimes/").
Spec: research/formats/ai.md section 4.

Run:  .venv/bin/python -I tools/assets/lib/formats/fmt_aitimes.py [file ...]   (default: every file)
"""
import glob
import os
import re
import sys

HDR = re.compile(r'^\s*(LapCount|TimeCount)\s*=\s*(\d+)\s*$')
NUM = re.compile(r'^\s*(-?\d+(?:\.\d+)?)\s*$')


def parse(path):
    """Return (laps, times, errors). times = list of cumulative seconds (float)."""
    laps = times = None
    errors = []
    with open(path, 'r', errors='replace') as fh:
        for ln, line in enumerate(fh, 1):
            m = HDR.match(line)
            if m:
                key, n = m.group(1), int(m.group(2))
                if key == 'LapCount':
                    laps = n
                else:
                    times = n
                continue
            m = NUM.match(line)
            if m:
                if times is None:
                    errors.append(f'{path}:{ln}: split before TimeCount')
                    continue
                times = times if isinstance(times, list) else []
                times.append(float(m.group(1)))
                continue
            if line.strip():
                errors.append(f'{path}:{ln}: unparsed: {line.strip()!r}')
    if isinstance(times, int):
        n, times = times, []
        errors.append(f'{path}: TimeCount={n} but no split lines')
    return laps, times or [], errors


def main(argv):
    cache = os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', '.cache', 'original')
    cache = os.path.abspath(cache)
    paths = argv[1:] or sorted(glob.glob(os.path.join(cache, 'Misc', 'aitimes', '**', '*'), recursive=True))
    paths = [p for p in paths if os.path.isfile(p)]
    bad = 0
    for p in paths:
        laps, times, errors = parse(p)
        rel = os.path.relpath(p, os.path.join(cache, 'Misc', 'aitimes'))
        for e in errors:
            print(e)
        bad += len(errors)
        mono = all(a < b for a, b in zip(times, times[1:]))
        if not times:
            print(f'{rel}: EMPTY')
            bad += 1
            continue
        print(f'{rel}: laps={laps} splits={len(times)} last={times[-1]:g}s'
              f'{" (increasing)" if mono else " (NOT INCREASING)"}')
    print(f'--- {len(paths)} files, {bad} errors')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))