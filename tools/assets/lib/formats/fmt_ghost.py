#!/usr/bin/env python3
"""fmt_ghost.py - parser / decoder for the original game's ghost files (topic `ai-ghosts`).

Covers the shipped team ghosts (Misc/teamghosts/<Driver>_<Track>, version "2.0") and the user ghosts the game
saves in Time Attack (version "3.0", %APPDATA%/.../Ghost Cars/...). Spec: research/formats/ai.md section 8.

Exe references (original_desktop_version.exe):
  load   FUN_004dc1a0   (version check "3.0" PTR 0x8498b4 / legacy "2.0" 0x8498d0, field order below)
  save   FUN_004dbdd0   (always writes "3.0": + 2nd name pair + 8-byte SYSTEMTIME-derived date)
  record FUN_004db540   (one frame per N ticks, N = tickRate / 15: FUN_004dcee0, 0x486ae4: 120 Hz -> 8)
  encode FUN_004dc7b0   decode FUN_004dccb0   playback FUN_004db730 (lerp / quaternion slerp between frames)
  state  FUN_0049bf20   (pos = car vt+0x28, quat from the car matrix vt+0x30, steer deg, wheel-0 spin deg)
  apply  FUN_0049bb90   (ghost car matrix + the 4 wheel matrices)

File layout (little endian):
  char[4]  version            "2.0\\0" or "3.0\\0"
  u32      frameCount         (G+0x04; also the record index G+0x78 at save time)
  str      carTemplate        u32 n + n bytes, e.g. "Peugeot206Ghost"     (G+0x0c)
  wstr     ghostName          u32 n + 2n bytes UTF-16LE, e.g. "IkeGhost2" (G+0x1c)
  [3.0 only] str + wstr       second name pair (G+0x2c / G+0x3c)  + 8 bytes date (G+0x4c vt+0xc)
  u32      nSplits ; f32[nSplits] split times (s); the last one = the ghost's total time (G+0x08)
  f32[9]   initial state      (G+0x80)
  u8[19]   frames[frameCount] (G+0xc8)

State (9 floats): px py pz | qx qy qz qw | steerDeg | wheelSpinDeg (wrapped to +-180).
Frame (19 bytes): u8 flags, s16 d[9].
  flags bit0 = HOLD frame: bytes 1..4 = u32 holdCount, the state stays for holdCount + 1 frame periods
  flags bit(k+1), k = 0..6 = FINE: component k delta was < 2^-15 of its range, stored * 32768
  value = prev + RANGE[k] * (FINE ? 1/32768 : 1) * d[k] / 32766.5     (decode 0x4dccb0)
  RANGE = 32, 16, 32, 32, 32, 32, 32 (pos, quat: 0x4d9df0 / 0x4d9e20 / 0x8083b4), 128 (steer), 256 (spin)
  the spin delta is wrapped into [-180, 180] before encoding; the decoded spin is wrapped back to [-180, 180].

Run:  .venv/bin/python -I tools/assets/lib/formats/fmt_ghost.py [file ...]   (default: every team ghost)
"""
import glob
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import FULL  # noqa: E402

RANGE = (32.0, 16.0, 32.0, 32.0, 32.0, 32.0, 32.0, 128.0, 256.0)
F32 = lambda v: struct.unpack('<f', struct.pack('<f', v))[0]  # noqa: E731
INV_Q = F32(1.0 / 32766.5)        # 3.0518975e-05 (decode multiplier; 0x46fffd00 = 32766.5 is the encode one)
FINE = F32(1.0 / 32768.0)         # 3.0517578e-05
FRAME = 19
GHOST_HZ = 15                      # recording rate (tickRate / (tickRate // 15))


class Reader:
    def __init__(self, b):
        self.b, self.o = b, 0

    def take(self, n):
        assert self.o + n <= len(self.b), f'read past end ({self.o}+{n} > {len(self.b)})'
        v = self.b[self.o:self.o + n]
        self.o += n
        return v

    def u32(self):
        return struct.unpack('<I', self.take(4))[0]

    def f32(self):
        return struct.unpack('<f', self.take(4))[0]

    def s(self):
        return self.take(self.u32()).decode('latin-1')

    def ws(self):
        return self.take(2 * self.u32()).decode('utf-16-le')


def parse(b):
    r = Reader(b)
    g = {'version': r.take(4).rstrip(b'\0').decode()}
    assert g['version'] in ('2.0', '3.0'), g['version']
    g['frameCount'] = r.u32()
    g['carTemplate'] = r.s()
    g['ghostName'] = r.ws()
    if g['version'] == '3.0':
        g['name2'] = r.s()
        g['wname2'] = r.ws()
        g['date'] = r.take(8).hex()
    n = r.u32()
    g['splits'] = [r.f32() for _ in range(n)]
    g['totalTime'] = g['splits'][-1] if n else float('inf')
    g['initial'] = [r.f32() for _ in range(9)]
    g['frames'] = [r.take(FRAME) for _ in range(g['frameCount'])]
    g['trailing'] = len(b) - r.o
    return g


def decode_frame(prev, fr):
    """FUN_004dccb0 (float32 like the exe's stores)."""
    flags = fr[0]
    d = struct.unpack('<9h', fr[1:])
    out = []
    for k in range(9):
        fine = FINE if (k < 7 and flags & (2 << k)) else 1.0
        out.append(F32(F32(RANGE[k] * fine * d[k] * INV_Q) + prev[k]))
    if out[8] > 180.0:
        out[8] = F32(out[8] - 360.0)
    if out[8] < -180.0:
        out[8] = F32(out[8] + 360.0)
    return out


def key_states(g):
    """The state at every recording period (15 Hz), hold frames expanded: list of 9-float states.
    states[0] = initial; states[i] = the state reached at period i."""
    st = [list(g['initial'])]
    prev = list(g['initial'])
    for fr in g['frames']:
        if fr[0] & 1:
            hold = struct.unpack('<I', fr[1:5])[0]
            st.extend([list(prev)] * (hold + 1))
        else:
            prev = decode_frame(prev, fr)
            st.append(list(prev))
    return st


def slerp(q0, q1, f):
    """FUN_004db730 quaternion path (dot >= 0 / < 0 branches, 1e-6 guard)."""
    dot = sum(a * b for a, b in zip(q0, q1))
    sgn = 1.0
    if dot < 0:
        dot, sgn = -dot, -1.0
    a, b = 1.0 - f, f
    if 1.0 - dot > 1e-6:
        th = math.acos(min(1.0, dot))
        s = 1.0 / math.sin(th)
        a, b = math.sin((1.0 - f) * th) * s, math.sin(f * th) * s
    return [a * x + sgn * b * y for x, y in zip(q0, q1)]


def sample(states, t):
    """Ghost pose at race time t (s): position lerp + quaternion slerp + lerp of steer / spin between periods."""
    x = t * GHOST_HZ
    i = int(math.floor(x))
    if i >= len(states) - 1:
        return states[-1]
    f = x - i
    a, b = states[i], states[i + 1]
    pos = [a[k] + (b[k] - a[k]) * f for k in range(3)]
    q = slerp(a[3:7], b[3:7], f)
    return pos + q + [a[7] + (b[7] - a[7]) * f, a[8] + (b[8] - a[8]) * f]


def team_ghost_files():
    return sorted(glob.glob(os.path.join(FULL, 'Misc', 'teamghosts', '*')))


def main(argv):
    files = argv or team_ghost_files()
    bad = 0
    for p in files:
        b = open(p, 'rb').read()
        g = parse(b)
        st = key_states(g)
        holds = sum(1 for f in g['frames'] if f[0] & 1)
        qn = max(abs(math.sqrt(sum(c * c for c in s[3:7])) - 1.0) for s in st)
        ok = g['trailing'] == 0
        bad += not ok
        print(f"{os.path.basename(p):28s} v{g['version']} frames {g['frameCount']:5d} periods {len(st) - 1:5d} "
              f"({(len(st) - 1) / GHOST_HZ:7.2f} s) total {g['totalTime']:8.3f} splits {len(g['splits']):2d} "
              f"holds {holds:3d} car {g['carTemplate']:22s} name {g['ghostName']!r:14s} |q|-1 max {qn:.4f} "
              f"trailing {g['trailing']}")
    print('files', len(files), 'with trailing bytes', bad)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
