#!/usr/bin/env python3
"""Run the original's CollisionMesh.Simple segment query 0x597810 (x87, thiscall, 9 args, ret 0x24) in unicorn on
real object meshes and placements -> tests/world/fixtures/orig/objmesh_cases.json (tests/world/objectMeshes.test.ts
feeds the same segments to src/world/orig/objectMeshes.ts and compares; docs/orig/collision.md §4).

The meshes and the instance transforms (diag(scale)·R rows + translation, the matrix the mesh-instance query 0x5912a0
composes at 0x591c20) come from a built RCOL v2 part (public/assets/stages/<id>/collision.{json,bin}). The BSP gather
0x7e5f60 is replaced by a stub that hands the query EVERY triangle (the port visits all triangles); everything else
(inverse 0x5d53b0, the AABB reject, the plane / edge tests, the deepest-end choice, the outputs) runs as shipped.
Needs a Python with `unicorn` and `numpy` (python3 -m venv <dir>; <dir>/bin/pip install unicorn numpy). The exe is
untrusted input: run with -I from outside the data directories.
usage: <venv>/bin/python -I tests/world/fixtures/orig/gen_objmesh_cases.py original_version/original_desktop_version.exe \\
       public/assets/stages/kenya-1-f tests/world/fixtures/orig/objmesh_cases.json [segmentsPerInstance] [seed]
"""
import json
import struct
import sys

import numpy as np
from unicorn import UC_ARCH_X86, UC_HOOK_MEM_UNMAPPED, UC_MODE_32, UC_PROT_ALL, Uc, UcError
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

EXE, STAGE, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
NSEG = int(sys.argv[4]) if len(sys.argv) > 4 else 60
SEED = int(sys.argv[5]) if len(sys.argv) > 5 else 3
INST_STRIDE_MIN = 28
QUERY = 0x597810
BSP_GATHER = 0x7e5f60
VEC = 0x91ba30            # the query's static candidate vector (begin +4, end +8, capacity +0xc)
GUARD = 0x91ba42          # its construct-once guard byte (bit 0: constructed, atexit registered)

# ------------------------------------------------------------------ the built part: meshes + instances
meta = json.load(open(STAGE + '/collision.json'))
blob = open(STAGE + '/collision.bin', 'rb').read()
sec = meta['sections']
f32 = lambda name, w: np.frombuffer(blob, '<f4', sec[name][1] // 4, sec[name][0]).reshape(-1, w)
mesh, mV, mTN = f32('mesh', 8), f32('mV', 3), f32('mTN', 3)
mTI = np.frombuffer(blob, '<u4', sec['mTI'][1] // 4, sec['mTI'][0]).reshape(-1, 4)
stride = meta['objectMeshes']['instStride']
inst = f32('inst', stride)
tpl = meta['obstacles']['templates']

# one instance per distinct mesh (the most scaled one), up to 12 meshes
rng = np.random.default_rng(SEED)
pick = {}
for k, r in enumerate(inst):
    m = int(r[12])
    s = float(np.linalg.norm(r[0:9].reshape(3, 3), axis=1).max())
    if m not in pick or abs(s - 1) > abs(pick[m][1] - 1):
        pick[m] = (k, s)
chosen = sorted(pick.items())[:12]

# ------------------------------------------------------------------ unicorn over the exe image
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
OBJ, VERTS, TRIS, LIST, MAT, ORIG, RAY, NRM, PNT, COS, DEP, MATO, RET = (
    HEAP + o for o in (0x0, 0x1000, 0x20000, 0x40000, 0x50000, 0x50100, 0x50110, 0x50120, 0x50130, 0x50140,
                       0x50144, 0x50148, 0x50200))
STACK = 0x20000000

mu = Uc(UC_ARCH_X86, UC_MODE_32)
mu.mem_map(base, al(size_img), UC_PROT_ALL)
mu.mem_write(base, exe[:0x1000])
for i in range(nsec):
    s = sect + 40 * i
    vsz, va, rsz, rptr = struct.unpack_from('<IIII', exe, s + 8)
    mu.mem_write(base + va, exe[rptr:rptr + min(rsz, vsz)])
mu.mem_map(HEAP, 0x60000, UC_PROT_ALL)
mu.mem_map(STACK, 0x10000, UC_PROT_ALL)
w32 = lambda a, v: mu.mem_write(a, struct.pack('<I', v & 0xffffffff))
wf = lambda a, v: mu.mem_write(a, struct.pack('<f', v))
rf = lambda a: struct.unpack('<f', bytes(mu.mem_read(a, 4)))[0]
r32 = lambda a: struct.unpack('<I', bytes(mu.mem_read(a, 4)))[0]
mu.mem_write(RET, b'\xf4')
# every call starts from a clean x87 state (fninit; jmp QUERY): values left on the FPU stack by the harness / earlier
# calls would otherwise overflow it in the deeper expressions and turn results into NaN (an emulation artefact)
ENTRY = RET + 0x10
mu.mem_write(ENTRY, b'\xdb\xe3\xe9' + struct.pack('<i', QUERY - (ENTRY + 7)))
mu.mem_write(GUARD, bytes([mu.mem_read(GUARD, 1)[0] | 1]))


# 0x7e5f60 -> end = begin + [NLIST]; ret 0xc (the list itself is pre-written at LIST). The byte count is DATA: unicorn
# keeps translated code, so patching an immediate per mesh would silently keep the first mesh's count.
NLIST = RET + 0x40
mu.mem_write(BSP_GATHER, b'\xa1' + struct.pack('<I', VEC + 4) + b'\x03\x05' + struct.pack('<I', NLIST) + b'\xa3' +
             struct.pack('<I', VEC + 8) + b'\xc2\x0c\x00')


def stub(n):
    w32(NLIST, 4 * n)


def bad(uc, access, addr, size, value, ud):
    print(f'unmapped access {access} at 0x{addr:x} eip 0x{uc.reg_read(UC_X86_REG_EIP):x}')
    return False


mu.hook_add(UC_HOOK_MEM_UNMAPPED, bad)

f = lambda v: float(np.float32(v))
out_meshes, cases = [], []
for mid, (k, _s) in chosen:
    t0, nt = int(mesh[mid][0]), int(mesh[mid][1])
    T = mTI[t0:t0 + nt]
    used = sorted(set(T[:, :3].reshape(-1).tolist()))
    remap = {v: i for i, v in enumerate(used)}
    V = mV[used]
    # the CollisionMesh.Simple object: AABB at +0x10 / +0x1c, vertex array (16-byte {x, y, z, tag}) at +0x34
    mu.mem_write(OBJ, b'\0' * 0x100)
    lo, hi = V.min(0), V.max(0)
    for j in range(3):
        wf(OBJ + 0x10 + 4 * j, float(lo[j]))
        wf(OBJ + 0x1c + 4 * j, float(hi[j]))
    w32(OBJ + 0x34, VERTS)
    w32(OBJ + 0x38, VERTS + 16 * len(V))
    for i, v in enumerate(V):
        mu.mem_write(VERTS + 16 * i, struct.pack('<3fI', *[float(x) for x in v], 0))
    tris = []
    for i, (row, n) in enumerate(zip(T, mTN[t0:t0 + nt])):
        a, b, c, pad = int(row[0]), int(row[1]), int(row[2]), int(row[3])
        tris.append([f(n[0]), f(n[1]), f(n[2]), remap[a], remap[b], remap[c], pad])
        mu.mem_write(TRIS + 32 * i, struct.pack('<4f4I', float(n[0]), float(n[1]), float(n[2]), 0.0,
                                                remap[a], remap[b], remap[c], pad))
        w32(LIST + 4 * i, TRIS + 32 * i)
    stub(nt)
    r = inst[k]
    M3 = r[0:9].reshape(3, 3).astype(np.float64)
    Tt = r[9:12].astype(np.float64)
    mat16 = [*M3[0], 0.0, *M3[1], 0.0, *M3[2], 0.0, *Tt, 1.0]
    for j, v in enumerate(mat16):
        wf(MAT + 4 * j, float(v))
    out_meshes.append({'template': tpl[int(r[16])], 'V': [[f(x) for x in v] for v in V], 'tris': tris,
                       'm': [f(x) for x in mat16]})
    # segments around / through the mesh (world space): starts in a shell around the object, ends through it
    cw = ((lo + hi) * 0.5) @ M3 + Tt
    ext = float(np.linalg.norm((hi - lo) @ M3)) * 0.5 + 0.5
    for q in range(NSEG):
        o = cw + rng.normal(size=3) * ext
        tgt = cw + rng.normal(size=3) * ext * 0.4
        d = tgt - o
        d *= rng.uniform(0.3, 1.6)
        if q % 7 == 0:
            d = rng.normal(size=3) * 0.75          # short random rays (hull-point-like)
        o, d = [f(x) for x in o], [f(x) for x in d]
        mu.mem_write(ORIG, struct.pack('<3f', *o))
        mu.mem_write(RAY, struct.pack('<3f', *d))
        mu.mem_write(NRM, struct.pack('<3f', 7.0, 7.0, 7.0))
        mu.mem_write(PNT, struct.pack('<3f', 7.0, 7.0, 7.0))
        wf(COS, 7.0)
        wf(DEP, 7.0)
        w32(MATO, 0xdeadbeef)
        # the candidate vector: empty at the call (begin = end = LIST, capacity large)
        w32(VEC + 4, LIST)
        w32(VEC + 8, LIST)
        w32(VEC + 12, LIST + 0x8000)
        sp = STACK + 0xF000
        for a in (MATO, 0xffffffff, DEP, COS, PNT, NRM, RAY, ORIG, MAT):   # pushed last arg first
            sp -= 4
            w32(sp, a)
        sp -= 4
        w32(sp, RET)
        mu.reg_write(UC_X86_REG_ESP, sp)
        mu.reg_write(UC_X86_REG_ECX, OBJ)
        try:
            mu.emu_start(ENTRY, RET, count=2_000_000)
        except UcError as e:
            print('emu error', mid, q, e)
            continue
        hit = (mu.reg_read(UC_X86_REG_EAX) & 0xff) != 0
        c = {'mesh': len(out_meshes) - 1, 'o': o, 'ray': d, 'hit': hit}
        if hit:
            c['normal'] = [rf(NRM + 4 * j) for j in range(3)]
            c['point'] = [rf(PNT + 4 * j) for j in range(3)]
            c['depth'] = rf(DEP)
            c['mat'] = r32(MATO)
            c['cosUntouched'] = rf(COS) == 7.0
        cases.append(c)

json.dump({'stage': meta['stage'].get('id') if isinstance(meta.get('stage'), dict) else STAGE,
           'meshes': out_meshes, 'cases': cases}, open(OUT, 'w'), separators=(',', ':'))
print(f'{len(out_meshes)} meshes, {len(cases)} segments ({sum(c["hit"] for c in cases)} hits) -> {OUT}')
