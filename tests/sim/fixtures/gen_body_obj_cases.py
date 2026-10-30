#!/usr/bin/env python3
"""Emulate the original's OBJECT-contact body solver FUN_006d21c0 (x87, thiscall(dt)) with unicorn on random body
states -> tests/sim/fixtures/bodySolverObjCases.json (tests/sim/objectPass.test.ts feeds the same inputs to
CarSim.bodySolver(dt, true) and compares).

FUN_006d21c0 is called by FUN_006d1a80 (the object pass's hull contacts, docs/orig/collision.md §4). It is the ground
solver FUN_006d0970 (research/frida/emu_body.py, whose harness this is) with its own anchor timer at B+0x138 and the
friction impulse clamped to +-1000 per component; one case family is heavy / long-anchored so that the clamp fires.
Needs a Python with `unicorn` and `numpy` (not in the project .venv: python3 -m venv <dir>; <dir>/bin/pip install
unicorn numpy). The exe is untrusted input: run with -I from outside the data directories.
usage: <venv>/bin/python -I tests/sim/fixtures/gen_body_obj_cases.py original_version/original_desktop_version.exe \
       tests/sim/fixtures/bodySolverObjCases.json [N] [seed]
"""
import json
import math
import struct
import sys

import numpy as np
from unicorn import UC_ARCH_X86, UC_HOOK_MEM_UNMAPPED, UC_MODE_32, UC_PROT_ALL, Uc, UcError
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

EXE, OUT = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
SEED = int(sys.argv[4]) if len(sys.argv) > 4 else 1

exe = open(EXE, 'rb').read()
pe = struct.unpack_from('<I', exe, 0x3c)[0]
nsec = struct.unpack_from('<H', exe, pe + 6)[0]
optsz = struct.unpack_from('<H', exe, pe + 20)[0]
base = struct.unpack_from('<I', exe, pe + 24 + 28)[0]
size_img = struct.unpack_from('<I', exe, pe + 24 + 56)[0]
sect = pe + 24 + optsz

PAGE = 0x1000
al = lambda x: (x + PAGE - 1) & ~(PAGE - 1)

HEAP = 0x10000000
P, X, BODY, HULL, OBJ2, VT, STUB, TABLE, RET = (HEAP + o for o in (0x0, 0x1000, 0x2000, 0x3000, 0x4000, 0x4100, 0x5000, 0x6000, 0x7000))
STACK = 0x20000000
FUNC = 0x6d21c0
TOFF = 0x138   # the object solver's anchor timer (FUN_006d0970: 0x134)
GLOBAL = 0x9350bc

# surface rows (PhysicsParam.con order): BodyK, BodyKScale, MaxDepth, Epsilon, FrictionLevel, Bump, BumpFlag
SURF = [
    [0.85, 0.25, 0.02, 0.35, 0.0, 0.035, 1], [0.9, 0.9, 0.0, 1.0, -1.0, 0.0, 0], [0.92, 0.8, 0.005, 0.5, 0.0, 0.025, 0],
    [0.9, 0.9, 0.0, 1.0, 1.0, 0.0, 0], [0.85, 0.75, 0.02, 0.45, 0.0, 0.015, 0], [0.85, 0.75, 0.0, 0.45, 0.0, 0.01, 0],
    [0.8, 0.9, 0.0, 0.4, 0.0, 0.05, 1], [0.72, 0.5, 0.02, 0.3, 0.25, 0.005, 0], [0.72, 0.5, 0.02, 0.3, 0.25, 0.01, 0],
    [0.8, 0.25, 0.04, 0.2, 0.0, 0.015, 1], [0.72, 0.5, 0.02, 0.3, 0.25, 0.005, 0], [0.8, 0.25, 0.04, 0.3, 0.0, 0.02, 1],
    [1.0, 0.25, 0.04, 0.4, 0.0, 0.02, 1], [0.9, 0.8, 0.0, 1.0, 0.0, 0.075, 1], [0.45, 0.9, 0.02, 0.35, 0.0, 0.02, 1],
    [0.72, 0.8, 0.01, 0.4, 0.0, 0.015, 0], [0.7, 0.8, 0.02, 0.4, 0.0, 0.017, 0], [0.7, 0.8, 0.02, 0.35, 0.0, 0.017, 0],
    [0.65, 0.25, 0.04, 0.4, 0.0, 0.02, 1], [0.9, 0.25, 0.04, 0.55, 0.0, 0.01, 1], [0.7, 0.9, 0.0, 0.5, 2.0, 0.01, 0],
    [0.85, 0.75, 0.02, 0.45, 0.0, 0.01, 0], [0.9, 0.75, 0.04, 0.25, 0.0, 0.01, 1], [0.01, 1.0, 0.0, 1.0, 0.0, 0.0, 0],
]
NROW = 64  # rows 24..63: "missing row -> all columns 1.0" (FUN_006d5d00)

mu = Uc(UC_ARCH_X86, UC_MODE_32)
mu.mem_map(base, al(size_img), UC_PROT_ALL)
mu.mem_write(base, exe[:0x1000])
for i in range(nsec):
    s = sect + 40 * i
    vsz, va, rsz, rptr = struct.unpack_from('<IIII', exe, s + 8)
    mu.mem_write(base + va, exe[rptr:rptr + min(rsz, vsz)])
mu.mem_map(HEAP, 0x10000, UC_PROT_ALL)
mu.mem_map(STACK, 0x10000, UC_PROT_ALL)

w32 = lambda a, v: mu.mem_write(a, struct.pack('<I', v & 0xffffffff))
wf = lambda a, v: mu.mem_write(a, struct.pack('<f', v))
rf = lambda a: struct.unpack('<f', bytes(mu.mem_read(a, 4)))[0]
r32 = lambda a: struct.unpack('<I', bytes(mu.mem_read(a, 4)))[0]

w32(P + 0x54, X)
w32(X + 4, BODY)
w32(GLOBAL, OBJ2)
w32(OBJ2, VT)
w32(VT + 0x20, STUB)
# thiscall getter(mat, col): fld dword [TABLE + (mat*8 + col)*4]; ret 8  (8 columns per row)
code = bytes([0x8B, 0x44, 0x24, 0x04, 0xC1, 0xE0, 0x03, 0x03, 0x44, 0x24, 0x08, 0xD9, 0x04, 0x85]) + struct.pack('<I', TABLE) + bytes([0xC2, 0x08, 0x00])
mu.mem_write(STUB, code)
mu.mem_write(RET, b'\xf4')  # hlt (never executed: emulation stops at RET)
for m in range(NROW):
    row = SURF[m] if m < len(SURF) else [1.0] * 7
    for c in range(8):
        wf(TABLE + (m * 8 + c) * 4, float(row[c]) if c < 7 else 0.0)


def bad(uc, access, addr, size, value, ud):
    print(f'unmapped access {access} at 0x{addr:x} eip 0x{uc.reg_read(UC_X86_REG_EIP):x}')
    return False


mu.hook_add(UC_HOOK_MEM_UNMAPPED, bad)

rng = np.random.default_rng(SEED)


def rot():
    q = rng.normal(size=4)
    if rng.random() < 0.6:  # mostly near upright
        q = np.array([1.0, *(rng.normal(size=3) * 0.15)])
    q /= np.linalg.norm(q)
    w, x, y, z = q
    r = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)]
    u = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)]
    f = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]
    return np.array([r, u, f])


def unit(v):
    return v / np.linalg.norm(v)


f32 = lambda v: float(np.float32(v))
vec = lambda a: [f32(x) for x in a]

cases = []
for k in range(N):
    heavy = k % 2 == 1   # heavy, long-anchored contacts below the COM: the +-1000 friction clamp fires
    mass = f32(rng.uniform(1500, 2600) if heavy else rng.uniform(900, 1600))
    I = vec(rng.uniform(0.3, 1.6, 3))
    R = rot()
    Rp = R if rng.random() < 0.3 else rot() if rng.random() < 0.2 else (lambda M: M)(R + rng.normal(size=(3, 3)) * 0.01)
    pos = vec(rng.normal(size=3) * 50)
    vW = vec(rng.normal(size=3) * rng.choice([0.5, 5, 20]))
    vL = vec(R @ np.array(vW))
    w = vec(rng.normal(size=3) * rng.choice([0.2, 2]))
    L = vec(np.array(w) * np.array(I) * mass)
    Fext = vec([0, -12 * mass, 0] + rng.normal(size=3) * 200)
    n = unit(np.array([0, 1, 0]) + rng.normal(size=3) * (0.1 if heavy else rng.choice([0.05, 0.5, 2])))
    nprev = n if rng.random() < 0.5 else unit(n + rng.normal(size=3) * rng.choice([0.1, 1]))
    c = vec([rng.uniform(-0.3, 0.3), rng.uniform(-0.6, -0.3), rng.uniform(-0.3, 0.3)] if heavy else
            [rng.uniform(-1, 1), rng.uniform(-0.4, 1.0), rng.uniform(-2.2, 2.2)])
    cprev = vec(np.array(c) + (rng.normal(size=3) * 0.05 if rng.random() < 0.7 else rng.normal(size=3)))
    dpos = np.array(vW) * rng.uniform(0, 0.2) + rng.normal(size=3) * 0.01
    ppos = vec(np.array(pos) - dpos)
    T = f32(rng.uniform(0.12, 0.199) if heavy else rng.choice([rng.uniform(0, 0.25), 0.0, 1 / 120, rng.uniform(0.19, 0.21)]))
    depth = f32(-rng.choice([rng.uniform(0, 0.05), rng.uniform(0, 0.7), 0.0]))
    share = f32(rng.uniform(0.35, 0.5) if heavy else rng.uniform(0, 0.5))
    if heavy:
        nprev = n
        cprev = vec(np.array(c) + rng.normal(size=3) * 0.02)
    mat = int(rng.choice([rng.integers(0, 24), rng.integers(0, 64)]) if rng.random() < 0.9 else rng.integers(0, 24))
    flags = 1 | (0x80 if (mat > 23 and rng.random() < 0.8) or rng.random() < 0.1 else 0) | (0x200 if rng.random() < 0.3 else 0) | (0x40 if rng.random() < 0.5 else 0)
    dt = f32(1 / 120)
    # write body
    mu.mem_write(BODY, b'\0' * 0x400)
    w32(BODY + 4, flags)
    wf(BODY + 0x10, mass)
    wf(BODY + 0x14, f32(1 / mass))
    for j in range(3):
        wf(BODY + 0x20 + 4 * j, vW[j]); wf(BODY + 0x2c + 4 * j, vL[j]); wf(BODY + 0x38 + 4 * j, Fext[j])
        wf(BODY + 0x44 + 4 * j, w[j]); wf(BODY + 0x50 + 4 * j, L[j])
        wf(BODY + 0x80 + 4 * j, f32(I[j] * mass)); wf(BODY + 0x8c + 4 * j, f32(1 / (I[j] * mass)))
        for r in range(3):
            wf(BODY + 0x98 + 0x10 * r + 4 * j, f32(R[r][j]))
            wf(BODY + 0xe4 + 0x10 * r + 4 * j, f32(Rp[r][j]))
        wf(BODY + 0xc8 + 4 * j, pos[j]); wf(BODY + 0x114 + 4 * j, ppos[j])
        wf(BODY + 0x148 + 4 * j, f32(n[j])); wf(BODY + 0x154 + 4 * j, f32(nprev[j]))
        wf(BODY + 0x160 + 4 * j, c[j]); wf(BODY + 0x16c + 4 * j, cprev[j])
    wf(BODY + TOFF, T)
    wf(BODY + 0x13c, depth)
    wf(BODY + 0x140, share)
    w32(BODY + 0x144, mat)
    w32(BODY + 0x17c, HULL)
    snap_in = bytes(mu.mem_read(BODY, 0x200))
    # call
    sp = STACK + 0xF000
    sp -= 4; w32(sp, 3)               # nContacts (unused)
    sp -= 4; mu.mem_write(sp, struct.pack('<f', dt))
    sp -= 4; w32(sp, RET)
    mu.reg_write(UC_X86_REG_ESP, sp)
    mu.reg_write(UC_X86_REG_ECX, P)
    try:
        mu.emu_start(FUNC, RET, count=200000)
    except UcError as e:
        print('emu error', k, e)
        continue
    rd = lambda o: rf(BODY + o)
    rv = lambda o: [rd(o), rd(o + 4), rd(o + 8)]
    out = {
        'vW': rv(0x20), 'L': rv(0x50), 'pos': rv(0xc8), 'T': rd(TOFF), 'prevN': rv(0x154), 'prevC': rv(0x16c), 'prevPos': rv(0x114),
        'flags': r32(BODY + 4),
        'strength': rd(0x19c),
    }
    changed = [hex(o) for o in range(0, 0x200, 4) if snap_in[o:o + 4] != bytes(mu.mem_read(BODY + o, 4))]
    # the same state through the ground solver FUN_006d0970 (timer at 0x134): where vW differs the clamp fired
    mu.mem_write(BODY, snap_in)
    wf(BODY + 0x134, T)
    sp = STACK + 0xF000
    sp -= 4; w32(sp, 3)
    sp -= 4; mu.mem_write(sp, struct.pack('<f', dt))
    sp -= 4; w32(sp, RET)
    mu.reg_write(UC_X86_REG_ESP, sp)
    mu.reg_write(UC_X86_REG_ECX, P)
    mu.emu_start(0x6d0970, RET, count=200000)
    out['vWGround'] = rv(0x20)
    cases.append({
        'in': {'mass': mass, 'I': [f32(I[j] * mass) for j in range(3)], 'R': [vec(R[r]) for r in range(3)], 'Rp': [vec(Rp[r]) for r in range(3)],
               'pos': pos, 'vW': vW, 'vL': vL, 'w': w, 'L': L, 'Fext': Fext, 'n': vec(n), 'nPrev': vec(nprev), 'c': c, 'cPrev': cprev,
               'prevPos': ppos, 'T': T, 'depth': depth, 'share': share, 'mat': mat, 'flags': flags, 'dt': dt},
        'out': out,
    })
json.dump(cases, open(OUT, 'w'), separators=(',', ':'))
clamped = sum(1 for cs in cases if max(abs(a - b) for a, b in zip(cs['out']['vW'], cs['out']['vWGround'])) > 1e-3)
print(f'{len(cases)} cases -> {OUT}; the +-1000 friction clamp changes vW in {clamped}')
