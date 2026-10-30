#!/usr/bin/env python3
"""fmt_quadmesh_export.py -- export one track's QuadMeshes (Track/World/Water .qm + .rs + lightmaps +
textures) into a browser-ready bundle, consumed by artifacts/re/quadmesh/viewer/ (three.js prototype
of the web plan in research/formats/quadmesh.md).

  python3 -I fmt_quadmesh_export.py <research/full/<arch>/track/<name>/<dir>> <outdir> [--lightmaps-from DIR]

Output:
  outdir/scene.json   materials, meshes -> patches -> groups, fog, spawn camera, bounds
  outdir/geom.bin     per patch: position f32x3 (THREE space: z mirrored), color u8x4 (diffuse RGBA),
                      uv0..uv3 f32x2 (as present), index u32 triangle list (D3D strips expanded,
                      degenerates dropped, winding swapped for the mirror)
  outdir/tex/*.png    base/mask textures (DDS decoded with Pillow), names lower-cased
  outdir/lm/*.png     lightmaps: Lightmaps/Track<patch>.tga indices mapped through Lightmaps/Track.pal
"""
import json
import os
import re
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fmt_quadmesh as Q  # noqa: E402
import fmt_quadmesh_validate as V  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
from _paths import FULL  # noqa: E402  rally-web: data root
MISC_TEX = os.path.normpath(os.path.join(FULL, 'Misc', 'texture'))


def read_pal(path):
    raw = open(path, 'rb').read()
    assert raw[:4] == b'RIFF' and raw[8:16] == b'PAL data', path
    return np.frombuffer(raw[24:24 + 1024], np.uint8).reshape(256, 4)[:, :3].copy()


def con_value(text, key):
    m = re.search(r'^\s*' + re.escape(key) + r'\s+(\S+)', text, flags=re.M | re.I)
    return m.group(1) if m else None


class Exporter:
    def __init__(self, tdir, out, lm_from=None):
        self.tdir, self.out = tdir, out
        self.lm_dir = lm_from or os.path.join(tdir, 'Lightmaps')
        os.makedirs(os.path.join(out, 'tex'), exist_ok=True)
        os.makedirs(os.path.join(out, 'lm'), exist_ok=True)
        self.bin = bytearray()
        self.textures = {}
        self.missing = set()
        pal = os.path.join(self.lm_dir, 'Track.pal')
        self.pal = read_pal(pal) if os.path.exists(pal) else None

    # -------- textures
    def texture(self, ref):
        """'texture/X' -> png path relative to out; search <track>/Texture then Misc/texture."""
        base = ref.split('/', 1)[1] if '/' in ref else ref
        key = base.lower()
        if key in self.textures:
            return self.textures[key]
        src = None
        for d in (os.path.join(self.tdir, 'Texture'), MISC_TEX):
            if os.path.isdir(d):
                for fn in os.listdir(d):
                    b, e = os.path.splitext(fn)
                    if b.lower() == key and e.lower() in ('.dds', '.tga'):
                        src = os.path.join(d, fn); break
            if src:
                break
        if src is None:
            self.missing.add(ref); self.textures[key] = None; return None
        rel = f'tex/{key}.png'
        dst = os.path.join(self.out, rel)
        if not os.path.exists(dst):
            Image.open(src).convert('RGBA').save(dst, compress_level=1)
        self.textures[key] = rel
        return rel

    def lightmap(self, patch_name):
        src = os.path.join(self.lm_dir, f'Track{patch_name}.tga')
        if not os.path.exists(src) or self.pal is None:
            return None
        rel = f'lm/{patch_name}.png'
        dst = os.path.join(self.out, rel)
        if not os.path.exists(dst):
            idx = np.asarray(Image.open(src))          # mode P, rows top-down after Pillow decode
            Image.fromarray(self.pal[idx]).save(dst, compress_level=1)
        return rel

    # -------- geometry
    def put(self, arr):
        off = len(self.bin)
        b = np.ascontiguousarray(arr).tobytes()
        self.bin += b
        pad = (-len(self.bin)) % 4
        self.bin += b'\0' * pad
        return off

    def mesh(self, kind, qm_path, rs, lightmapped):
        qm = Q.parse(qm_path)
        patches = []
        for node, p in qm.iter_patches():
            P = p.positions.astype(np.float32).copy()
            P[:, 2] *= -1.0                                   # sim (LH) -> three (RH): mirror z
            groups, idx = [], []
            start = 0
            for s in p.subs:
                t = s.triangles(p.indices)[:, [0, 2, 1]]      # mirror flips winding
                idx.append(t.reshape(-1)); groups.append(dict(start=start, count=int(t.size),
                                                               material=s.material))
                start += int(t.size)
            I = np.concatenate(idx).astype(np.uint32)
            ent = dict(name=p.name, vertexCount=p.vertex_count, format=p.vertex_format,
                       position=self.put(P), index=self.put(I), indexCount=int(I.size), groups=groups,
                       aabbMin=node.aabb_min, aabbMax=node.aabb_max)
            if 'diffuse' in p.attrs:
                ent['color'] = self.put(p.attrs['diffuse'])
            for k in ('uv0', 'uv1', 'uv2', 'uv3'):
                if k in p.attrs:
                    ent[k] = self.put(p.attrs[k].astype(np.float32))
            if lightmapped:
                ent['lightmap'] = self.lightmap(p.name)
            patches.append(ent)
        return dict(kind=kind, lightmappedFile=bool(qm.lightmapped), patches=patches)

    def run(self):
        mats, meshes = {}, []
        for kind in ('Track', 'World', 'Water'):
            qm = os.path.join(self.tdir, 'Mesh', f'{kind}.qm')
            if not os.path.exists(qm):
                continue
            rs = Q.parse_rs(qm[:-3] + '.rs')
            for name, sh in rs.items():
                m = dict(type=sh.type, lightmapped=sh.flag('lightmapped'),
                         doubleIntensity=sh.flag('doubleIntensity'), vertexPaint=sh.flag('vertexPaint'),
                         tex={})
                for slot, key in (('base1', 'base1Tex'), ('mask', 'maskTex'), ('base2', 'base2Tex'),
                                  ('base1', 'texture'), ('bump', 'bumpmap')):
                    if key in sh.props:
                        cu = sh.flag({'base1Tex': 'base1ClampU', 'maskTex': 'maskClampU', 'base2Tex': 'base2ClampU',
                                      'texture': 'textureClampU', 'bumpmap': 'bumpmapClampU'}[key])
                        cv = sh.flag({'base1Tex': 'base1ClampV', 'maskTex': 'maskClampV', 'base2Tex': 'base2ClampV',
                                      'texture': 'textureClampV', 'bumpmap': 'bumpmapClampV'}[key])
                        m['tex'][slot] = dict(src=sh.props[key], png=self.texture(sh.props[key]),
                                              clampU=cu, clampV=cv)
                mats[f'{kind}:{name}'] = m
            ent = self.mesh(kind, qm, rs, lightmapped=(kind == 'Track'))
            for p in ent['patches']:
                for g in p['groups']:
                    g['material'] = f'{kind}:{g["material"]}'
            meshes.append(ent)

        # fog / spawn camera
        def rd(n):
            f = os.path.join(self.tdir, n)
            return open(f, encoding='latin-1').read() if os.path.exists(f) else ''
        light, play = rd('lighting.con'), rd('Play.con')
        fogc = con_value(light, 'track.fogColor') or '0.6/0.65/0.7'
        fogr = con_value(light, 'track.fogRange') or '0/1000'
        col = [float(v) for v in fogc.split('/')]
        col = col * 3 if len(col) == 1 else col                     # 'track.fogColor 0.25' = grey
        fclamp = con_value(light, 'track.fogClamp')                 # renderer+0x8c (default 1e8)
        fog = dict(color=col, range=[float(v) for v in fogr.split('/')],
                   clamp=float(fclamp) if fclamp else 1e8)
        cam = None
        sg = con_value(play, 'race.spawnGrid')
        if sg:
            s0 = float(sg.split('/')[0])
            _, cv = V.read_spl(os.path.join(self.tdir, 'AiFiles', 'center.spl'))
            S, _ = V.sample_spline(cv, step=0.5)
            L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(S, axis=0), axis=1))])
            i = int(np.searchsorted(L, s0)); j = min(len(S) - 1, int(np.searchsorted(L, s0 + 25)))
            pos, ahead = S[i], S[j]
            cam = dict(spawnSim=pos.tolist(), aheadSim=ahead.tolist(), s=s0)
        spl = None
        cpath = os.path.join(self.tdir, 'AiFiles', 'center.spl')
        if os.path.exists(cpath):
            _, cv = V.read_spl(cpath)
            S, _ = V.sample_spline(cv, step=4.0)
            spl = [[round(float(x), 2), round(float(y), 2), round(float(-z), 2)] for x, y, z in S]
        scene = dict(materials=mats, meshes=meshes, fog=fog, camera=cam, spline=spl,
                     missingTextures=sorted(self.missing), lightmapDir=os.path.relpath(self.lm_dir, self.tdir))
        with open(os.path.join(self.out, 'geom.bin'), 'wb') as f:
            f.write(self.bin)
        with open(os.path.join(self.out, 'scene.json'), 'w') as f:
            json.dump(scene, f)
        print(f'{self.tdir} -> {self.out}: {len(self.bin) / 1e6:.1f} MB geometry, '
              f'{sum(1 for v in self.textures.values() if v)} textures, missing {sorted(self.missing)}')


if __name__ == '__main__':
    a = sys.argv[1:]
    lm = None
    if '--lightmaps-from' in a:
        k = a.index('--lightmaps-from'); lm = a[k + 1]; del a[k:k + 2]
    if len(a) != 2:
        print(__doc__); sys.exit(1)
    Exporter(a[0], a[1], lm).run()
