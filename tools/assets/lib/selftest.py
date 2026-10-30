"""`build.py --selftest`: quick checks of the pipeline foundation (~1 min).

1. archive layer: numpy Blowfish == rff.Blowfish (pure Python) and FastArchive.read == rff.Archive.read on
   entries of every archive kind; the extracted cache holds the same bytes.
2. stage mapping: every PORTED_ORDER id <-> archive <-> level path, Start.con parsed.
3. engine lookup rules: vfs.resolve_texture == research/tools/fmt_textures.resolve (the verified resolver,
   when research/ exists) for every texture of 12 stages (each family, both directions) + Misc-only names.
4. .rtex conversion round trip on the verifier's sample files (smallest/largest DXT, non-square with
   trailing levels, punch-through DXT1, volumes, R8G8B8, A8R8G8B8, DXT3/DXT5, TGA 2x2 / 1024^2 / top-left
   origin / 8-bit grey / colour-mapped / lightmap through Track.pal): every level decoded from the .rtex ==
   research decode_dds / tga_decode (level 0) and == an independent floor-mean (np.add.reduceat) for the
   generated TGA levels.
5. cube(): CarEnvmap of two stages == research load_cube face paths.
"""
import importlib.util
import os
import random
import shutil
import sys
import tempfile
import time

import numpy as np

import archive as A
import rff
import rtex as R
import stages as S
import textures as T
import vfs as V

RESEARCH_TOOLS = os.path.join(A.REPO, 'research', 'tools')
RESEARCH_FULL = os.path.join(A.REPO, 'research', 'full')

SAMPLES = [  # (basename, archive (None = first in sorted order), why)
    ('HC_PlasticStripe_01_FU.dds', None, 'DXT1 8x8, smallest'),
    ('RC_DETAIL.dds', None, 'DXT1 2048^2, 12 levels'),
    ('nz_wood_01_fu.dds', None, 'DXT1 non-square, trailing levels'),
    ('SWE_track_mask_04_MT.dds', None, 'DXT1 256x2048, +3 trailing'),
    ('co_grennleaf_01_se.dds', None, 'DXT1 punch-through'),
    ('Anim_gravel1.dds', None, 'A8R8G8B8 volume 16^2x4'),
    ('waterBumpTex6e.dds', None, 'A8R8G8B8 volume 64^2x8, 7 levels'),
    ('Metro6R4_lod2.dds', None, 'R8G8B8, 1 level'),
    ('nzbushD.dds', 'corsica1r', 'DXT5 billboard'),
    ('KN_LeafSprites_01-04_fu.dds', 'corsica1r', 'A8R8G8B8 2-D, +2 trailing'),
    ('KN_LeafSprites_01-04_fu.dds', 'Misc', 'DXT3 (Misc copy of the same name)'),
    ('SKYTOP_A.dds', 'rallycross3r', 'DXT3 sky'),
    ('CarFlare_A03.tga', None, 'TGA 2x2'),
    ('co1f_water_Back.tga', 'corsica1f', 'TGA 32-bit (water cube face)'),
    ('CitroenXsaraRC_JT.tga', None, 'TGA 1024^2 24-bit, largest'),
    ('bink_Chris.TGA', None, 'TGA top-left origin, NPOT'),
    ('HandelGotHUD10.tga', None, 'TGA type 3 grey'),
    ('ghost.tga', None, 'TGA type 1, own grey palette'),
    ('Track100.tga', 'hillclimb1br', 'lightmap P8 through Track.pal'),
]
STAGES = ['corsica-1-f', 'corsica-2-r', 'hillclimb-1a-f', 'hillclimb-3c-r', 'iceracing-1-f', 'iceracing-2-r',
          'kenya-1-f', 'kenya-3-r', 'newzealand-1-f', 'newzealand-2-r', 'rallycross-1-f', 'rallycross-3-r']


class Check:
    def __init__(self):
        self.fails = []
        self.n = 0

    def __call__(self, ok, what):
        self.n += 1
        if not ok:
            self.fails.append(what)
            print('  FAIL', what, flush=True)
        return ok


def _research_fmt_textures():
    p = os.path.join(RESEARCH_TOOLS, 'fmt_textures.py')
    if not (os.path.isfile(p) and os.path.isdir(RESEARCH_FULL)):
        return None
    spec = importlib.util.spec_from_file_location('research_fmt_textures', p)
    mod = importlib.util.module_from_spec(spec)
    old, sys.dont_write_bytecode = sys.dont_write_bytecode, True     # research/ stays read-only
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.dont_write_bytecode = old
    return mod


def reduceat_mean(img, L):
    """Independent formulation of the engine chain rule (floor of the 2^L block mean from level 0)."""
    h, w = img.shape[:2]
    bw, bh = min(1 << L, w), min(1 << L, h)
    lw, lh = max(1, w >> L), max(1, h >> L)
    x = img[:lh * bh, :lw * bw].astype(np.int64)
    s = np.add.reduceat(np.add.reduceat(x, np.arange(0, lh * bh, bh), axis=0), np.arange(0, lw * bw, bw), axis=1)
    return (s // (bw * bh)).astype(np.uint8)


def check_archives(ck, arcs):
    print('1. archive layer', flush=True)
    rnd = random.Random(1)
    for name in ['Misc', 'Audio', 'Cars', 'Menu', 'LocaleEnglish', 'common', 'fogzor', 'corsica1f',
                 'hillclimb2cr', 'rallycross3f']:
        if name not in arcs.paths:
            continue
        ref = rff.Archive(arcs.paths[name])
        fast = A.FastArchive(arcs.paths[name])
        ents = sorted(ref.entries, key=lambda e: e.packed)
        pick = ents[:2] + ents[-1:] + rnd.sample(ents, min(5, len(ents)))
        for e in pick:
            if e.packed > 4_000_000:
                continue        # the pure-Python reference is slow; big entries go through iter_all below
            raw = ref.read_raw(e)
            ck(A.np_cipher().decrypt(raw) == rff.cipher().decrypt_ecb_le(raw), '%s:%s numpy decrypt' % (name, e.name))
            data = ref.read(e)
            ck(fast.read(e) == data, '%s:%s FastArchive.read' % (name, e.name))
            cf = arcs.cache_file(name, e.name)
            if cf:
                ck(open(cf, 'rb').read() == data, '%s:%s cache bytes' % (name, e.name))
        if name in ('corsica1f', 'common'):
            got = {e.name: d for e, d in fast.iter_all()}
            ck(all(fast.read(e) == got[e.name] for e in rnd.sample(fast.entries, min(6, len(fast.entries)))),
               '%s iter_all' % name)
        ref.close()
        fast.close()


def check_stages(ck, vfs):
    print('2. stage mapping', flush=True)
    order = S.ported_order()
    ck(len(order) == 48, '48 ported stages (got %d)' % len(order))
    for sid in order:
        arch = S.stage_archive(sid)
        ck(S.archive_stage_id(arch) == sid, '%s id<->archive' % sid)
        st = S.load_stage(sid, vfs)
        ck(vfs.exists(st.vpath('Play.con'), arch) and st.height > 0, '%s level %s' % (sid, st.level))
    ck(S.stage_archive('hillclimb-1a-f') == 'hillclimb1af' and S.level_path('hillclimb-1a-f') ==
       'track/hillclimb1a/forward', 'hillclimb-1a-f mapping')
    ck(S.load_stage('iceracing-1-f', vfs).height == 24.0 and S.load_stage('kenya-2-r', vfs).height == 124.0,
       'Start.con H (iceracing1 24, kenya 124)')


def check_resolve(ck, vfs, FT):
    print('3. engine texture lookup vs research fmt_textures.resolve', flush=True)
    if FT is None:
        print('  (skipped: research/ not present)')
        return
    n = 0
    misc = sorted({v.rsplit('/', 1)[-1].rsplit('.', 1)[0] for v in vfs.files_under('texture')})
    for sid in STAGES:
        st = S.load_stage(sid, vfs)
        names = sorted({v.rsplit('/', 1)[-1].rsplit('.', 1)[0] for v in vfs.files_under(st.level + '/texture')})
        names += misc[::25]
        for nm in names:
            mine = vfs.resolve_texture('texture/' + nm, st)
            ref = FT.resolve('texture/' + nm, st.archive)
            a = os.path.join(mine[0], *mine[1].split('/')) if mine else None
            b = os.path.relpath(ref, FT.FULL) if ref else None
            ck(a == b, '%s texture/%s: %s != %s' % (sid, nm, a, b))
            n += 1
    for nm in ('menu/texture/carenvmap', 'Track/Corsica1/Forward/Texture/CO_Tarmac_01_MT', 'font/HandelGotHUD10'):
        mine = vfs.resolve_texture(nm)
        ref = FT.resolve(nm)
        a = os.path.join(mine[0], *mine[1].split('/')) if mine else None
        b = os.path.relpath(ref, FT.FULL) if ref else None
        ck(a == b, '%s: %s != %s' % (nm, a, b))
        n += 1
    print('  %d names compared' % n)


def check_rtex(ck, vfs, reg, FT):
    print('4. .rtex round trip', flush=True)
    import fmt_textures as MY
    ref = FT or MY
    for base, want_arch, why in SAMPLES:
        hits = [(a, m) for v, hs in vfs.index.items() if v.rsplit('/', 1)[-1] == base.lower() for a, m in hs
                if want_arch is None or a == want_arch]
        if not hits:
            ck(False, 'sample %s not found' % base)
            continue
        arch, member = sorted(hits)[0]
        b = vfs.archives.read(arch, member)
        tid = reg.use_file(arch, member)
        blob = open(os.path.join(reg.dir, tid + '.rtex'), 'rb').read()
        u = R.unpack(blob)
        ck(R.unpack(R.pack(u['format'], u['width'], u['height'], [bytes(x) for x in u['levels']], u['depth'],
                           u['flags'] & ~(R.FLAG_PALETTE | R.FLAG_VOLUME), u['source'], u['sourceKind'],
                           u['palette']))['levels'][-1] == u['levels'][-1], '%s repack' % base)
        if base.lower().endswith('.dds'):
            hd = ref.dds_layout(b)
            ck(len(u['levels']) == hd['mips'] and u['depth'] == hd['depth'], '%s levels %d/%d' %
               (base, len(u['levels']), hd['mips']))
            for L in range(len(u['levels'])):
                want, _ = ref.decode_dds(b, L)
                got = T.decode_level_rgba(u, L)
                want = want if hd['volume'] else want[None]
                ck(got.shape == want.shape and np.array_equal(got, want), '%s level %d texels' % (base, L))
            if base == 'co_grennleaf_01_se.dds':
                ck(bool(u['flags'] & R.FLAG_PUNCHTHROUGH), 'punch-through flag')
        else:
            pal = reg._lightmap_palette(arch, member)
            want, info = ref.tga_decode(b, pal)
            got0 = T.decode_level_rgba(u, 0)[0]
            if info['type'] == 3 or (info['bpp'] == 8 and info['type'] != 1):
                want = want.copy()
                want[..., 3] = 255
            ck(np.array_equal(got0, want), '%s level 0 (%s)' % (base, why))
            n = 1 + int(np.floor(np.log2(max(info['w'], info['h']))))
            ck(len(u['levels']) == n, '%s full chain %d/%d' % (base, len(u['levels']), n))
            if u['format'] == R.FMT_P8:
                idx, _ = ref.tga_decode(b, T.IDENTITY_PALETTE)
                plane = idx[..., :1]
                pal4 = np.frombuffer(u['palette'], np.uint8).reshape(256, 4)
                for L in range(1, len(u['levels'])):
                    ck(np.array_equal(T.decode_level_rgba(u, L)[0], pal4[reduceat_mean(plane, L)[..., 0]]),
                       '%s P8 level %d' % (base, L))
            else:
                ch = {R.FMT_RGBA8: 4, R.FMT_RGB8: 3, R.FMT_L8: 1}[u['format']]
                src = want[..., :ch]
                for L in range(1, len(u['levels'])):
                    exp = reduceat_mean(src, L)
                    got = T.decode_level_rgba(u, L)[0][..., :ch]
                    ck(np.array_equal(got, exp), '%s level %d (floor mean)' % (base, L))
        print('  ok %-28s %-12s %-5s %4dx%-4d d%d L%-2d %s' % (base, arch, u['formatName'], u['width'], u['height'],
                                                        u['depth'], len(u['levels']), why), flush=True)


def check_cubes(ck, vfs, reg, FT):
    print('5. cube maps', flush=True)
    for sid in ('kenya-1-f', 'corsica-2-f'):
        st = S.load_stage(sid, vfs)
        ids = reg.cube('texture/CarEnvmap', st)
        ck(ids is not None and len(ids) == 6, '%s CarEnvmap 6 faces' % sid)
        if ids and FT is not None:
            rcm = FT.resolve('texture/CarEnvmap', st.archive)
            faces = FT.load_cube(rcm, st.archive)
            srcs = []
            for k, p, _ in faces:
                rel = os.path.relpath(p, FT.FULL).split(os.sep)
                srcs.append((rel[0], '/'.join(rel[1:])))
            ck([reg.use_file(*s) for s in srcs] == ids, '%s CarEnvmap faces == research load_cube' % sid)
        print('  %s CarEnvmap -> %s' % (sid, ' '.join(i[:6] for i in ids or [])))
    ck(reg.cube('texture/testkub') is None, 'testkub (absent faces) -> None')


def main():
    t0 = time.time()
    ck = Check()
    if not A.have_originals():
        print('selftest: no original archives (%s) -- nothing to check' % A.ORIGINAL)
        return 0
    arcs = A.ArchiveSet()
    A.ensure_extracted(log=print)
    vfs = V.Vfs(arcs)
    FT = _research_fmt_textures()
    if FT is None:
        print('(research/ not present: comparisons against the research tools are skipped)')
    tmp = tempfile.mkdtemp(prefix='selftest.', dir=os.path.join(A.CACHE_ROOT, 'tmp'))
    try:
        reg = T.TextureRegistry(vfs, tmp)
        check_archives(ck, arcs)
        check_stages(ck, vfs)
        check_resolve(ck, vfs, FT)
        check_rtex(ck, vfs, reg, FT)
        check_cubes(ck, vfs, reg, FT)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print('selftest: %d checks, %d failed, %.1f s' % (ck.n, len(ck.fails), time.time() - t0))
    return 1 if ck.fails else 0


if __name__ == '__main__':
    sys.exit(main())
