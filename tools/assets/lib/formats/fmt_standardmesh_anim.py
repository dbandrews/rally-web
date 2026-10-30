#!/usr/bin/env python3
"""fmt_standardmesh_anim.py -- skeleton (.ske), skin (.skn) and bone animation (.baf) readers.

Layouts are EMPIRICAL ([E]): every file in research/full parses to its exact end, the skin
positions match every vertex of the AnimatedMesh .sm it belongs to, weights sum to 1 and
quaternions are unit length.  The loaders were not located in the decomp (see
research/formats/standardmesh.md, open questions).

  parse_ske(data) -> {'version', 'bones': [{'name', 'parent', 'm3x4'}]}
  parse_skn(data) -> {'version', 'vertices': [{'pos', 'influences': [(bone, weight, offset)]}],
                      'boneNames': [...]}
  parse_baf(data) -> {'version', 'boneNames', 'frames', 'keys': [frame][bone] -> (q4, pos3) | m3x4}
CLI:  fmt_standardmesh_anim.py validate [root]
"""
import os
import struct
import sys


def _load(src):
    if isinstance(src, (bytes, bytearray)):
        return bytes(src)
    with open(src, 'rb') as f:
        return f.read()


def _names(b, o, n):
    out = []
    for _ in range(n):
        ln = struct.unpack_from('<H', b, o)[0]
        o += 2
        out.append(b[o:o + ln].rstrip(b'\0').decode('latin1'))   # length includes the NUL
        o += ln
    return out, o


def parse_ske(src):
    b = _load(src)
    ver, n = struct.unpack_from('<2I', b, 0)
    o = 8
    bones = []
    for _ in range(n):
        ln = struct.unpack_from('<H', b, o)[0]
        o += 2
        name = b[o:o + ln].rstrip(b'\0').decode('latin1')
        o += ln
        parent = struct.unpack_from('<h', b, o)[0]          # -1 = root
        o += 2
        m = struct.unpack_from('<12f', b, o)                # 3 rows x 4 (R | t), see spec
        o += 48
        bones.append({'name': name, 'parent': parent, 'm3x4': m})
    return {'version': ver, 'bones': bones, 'leftover': len(b) - o}


def parse_skn(src):
    b = _load(src)
    ver, n = struct.unpack_from('<2I', b, 0)
    o = 8
    verts = []
    for _ in range(n):
        pos = struct.unpack_from('<3f', b, o)
        o += 12
        k = b[o]
        o += 1
        infl = []
        for _ in range(k):
            bone = struct.unpack_from('<H', b, o)[0]
            w = struct.unpack_from('<f', b, o + 2)[0]
            off = struct.unpack_from('<3f', b, o + 6)
            o += 18
            infl.append((bone, w, off))
        verts.append({'pos': pos, 'influences': infl})
    nb = struct.unpack_from('<H', b, o)[0]
    o += 2
    names, o = _names(b, o, nb)
    return {'version': ver, 'vertices': verts, 'boneNames': names, 'leftover': len(b) - o}


def parse_baf(src):
    b = _load(src)
    ver = struct.unpack_from('<I', b, 0)[0]
    nb = struct.unpack_from('<H', b, 4)[0]
    names, o = _names(b, 6, nb)
    nf = struct.unpack_from('<I', b, o)[0]
    o += 4
    keys = []
    for _ in range(nf):                                    # frame-major
        fr = []
        for _ in range(nb):
            if ver == 2:
                q = tuple(x / 32767.0 for x in struct.unpack_from('<4h', b, o))
                p = struct.unpack_from('<3f', b, o + 8)
                fr.append((q, p))
                o += 20
            else:                                          # version 1: 12 floats
                fr.append(struct.unpack_from('<12f', b, o))
                o += 48
        keys.append(fr)
    return {'version': ver, 'boneNames': names, 'frames': nf, 'keys': keys, 'leftover': len(b) - o}


def cmd_validate(root):
    bad = []
    counts = {'ske': 0, 'skn': 0, 'baf': 0}
    for dp, dn, fn in os.walk(root):
        for f in sorted(fn):
            p = os.path.join(dp, f)
            ext = f.lower().rsplit('.', 1)[-1]
            if ext not in counts:
                continue
            try:
                r = {'ske': parse_ske, 'skn': parse_skn, 'baf': parse_baf}[ext](p)
            except Exception as e:  # noqa
                bad.append((p, repr(e)))
                continue
            counts[ext] += 1
            if r['leftover']:
                bad.append((p, 'leftover %d' % r['leftover']))
            if ext == 'skn':
                for v in r['vertices']:
                    if abs(sum(i[1] for i in v['influences']) - 1) > 1e-3:
                        bad.append((p, 'weights'))
                        break
            if ext == 'baf' and r['version'] == 2:
                for fr in r['keys']:
                    for q, _ in fr:
                        if abs(sum(x * x for x in q) - 1) > 1e-2:
                            bad.append((p, 'quat norm'))
                            break
    print('parsed', counts, 'failures', len(bad))
    for x in bad:
        print('BAD', x)
    return 1 if bad else 0


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == 'validate':
        here = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, here)
        from _paths import FULL  # rally-web: data root
        sys.exit(cmd_validate(sys.argv[2] if len(sys.argv) > 2 else FULL))
    print(__doc__)
