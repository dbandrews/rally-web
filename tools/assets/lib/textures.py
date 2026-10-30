"""Texture registry: engine-resolved texture names -> content-addressed `.rtex` files (public/assets/tex/).

    texId = registry.use('texture/CO_Tarmac_01_MT', stage)      # -> '3f9a...' (20 hex chars) or None
    faces = registry.cube('texture/CarEnvmap', stage)           # -> [6 texIds] +X,-X,+Y,-Y,+Z,-Z or None

* Names resolve with the engine rules (vfs.Vfs.resolve_texture: stage Texture/ shadows Misc/texture,
  BMP < DDS < RCM < RTX < TGA, no extension, case-insensitive).
* The output file is `tex/<texId>.rtex` with texId = sha256(rtex bytes)[:20]: identical content (forward
  and reverse stages, stage/Misc copies, the same image under two names) is stored once. Files are
  written atomically (temp + rename), so parallel stage workers and concurrent build runs are safe.
* Conversion (research/formats/textures.md; rtex.py documents the container):
    DDS DXT1/3/5        authored blocks + authored mip chain unchanged; trailing unused levels dropped;
                        single-level DDS stay single-level (the engine generates nothing for them, §2.3)
    DDS A8R8G8B8        RGBA8 (BGRA swizzled), incl. volumes (FLAG_VOLUME, depth slices per level)
    DDS R8G8B8          RGB8
    DDS 16-bit          decoded to RGBA8 (none ship)
    TGA 32 / 24 bit     RGBA8 / RGB8, full chain generated: level L = floor(mean of level 0 over the clamped
                        2^L block) per channel (ScaleFilter.AverageMipmap slot 4, every level from level 0)
    TGA 8-bit grey      L8, same chain rule
    TGA colour-mapped   P8 + palette: under a level's Lightmaps/ the palette is that folder's Track.pal
                        (.act fallback, else all red like the engine's 0xF800 LUT); elsewhere the file's
                        own colour map (always an identity grey ramp); the chain is averaged in INDEX space
    TGA 16-bit          RGBA8 level 0 only (the engine's generator cannot build X1R5G5B5 mips; none ship)
"""
import hashlib
import math
import os

import numpy as np

import fmt_textures as FT
import rtex as R
import stages as S

IDENTITY_PALETTE = np.repeat(np.arange(256, dtype=np.uint8)[:, None], 3, 1)


class TextureError(Exception):
    pass


# ------------------------------------------------------------------------------------------ helpers
def atomic_write(path, data):
    """Write bytes to `path` via a temp file in the same folder + os.replace (readers never see partial files)."""
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    tmp = '%s.tmp.%d.%s' % (path, os.getpid(), os.urandom(4).hex())
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def floor_mean_chain(img):
    """Full mip chain of an (h, w, c) uint8 image by the engine rule (textures.md §3.3, verifier):
    level L texel = floor(mean of level 0 over a min(2^L, w) x min(2^L, h) block). Level 0 included.
    (Non-power-of-two images, UI art only, drop the remainder columns/rows of partial blocks.)"""
    h, w = img.shape[:2]
    n = 1 + int(math.floor(math.log2(max(w, h))))
    out = [np.ascontiguousarray(img)]
    for L in range(1, n):
        bw, bh = min(1 << L, w), min(1 << L, h)
        lw, lh = max(1, w >> L), max(1, h >> L)
        crop = img[:lh * bh, :lw * bw].astype(np.uint32)
        s = crop.reshape(lh, bh, lw, bw, img.shape[2]).sum(axis=(1, 3))
        out.append((s // (bw * bh)).astype(np.uint8))
    return out


def dxt1_punchthrough(level):
    """True when a DXT1 level has a 3-colour block (c0 <= c1) that uses index 3 (transparent black)."""
    a = np.frombuffer(level, np.uint8).reshape(-1, 8)
    c0 = a[:, 0].astype(np.uint16) | (a[:, 1].astype(np.uint16) << 8)
    c1 = a[:, 2].astype(np.uint16) | (a[:, 3].astype(np.uint16) << 8)
    idx = (a[:, 4].astype(np.uint32) | (a[:, 5].astype(np.uint32) << 8) |
           (a[:, 6].astype(np.uint32) << 16) | (a[:, 7].astype(np.uint32) << 24))
    sel = (idx[:, None] >> (2 * np.arange(16, dtype=np.uint32))[None, :]) & 3
    return bool(np.any((c0 <= c1) & np.any(sel == 3, 1)))


def _palette1024(rgb):
    pal = np.full((256, 4), 255, np.uint8)
    n = min(256, len(rgb))
    pal[:n, :3] = rgb[:n, :3]
    return pal.tobytes()


def tga_colour_map(b):
    """The TGA file's own colour map as (n, 3) RGB (entries before cmo are zero), or None."""
    idl, cmt, it, cmo, cml, cmd = b[0], b[1], b[2], int.from_bytes(b[3:5], 'little'), int.from_bytes(b[5:7], 'little'), b[7]
    if cmt != 1:
        return None
    esz = (cmd + 7) // 8
    raw = np.frombuffer(b, np.uint8, cml * esz, 18 + idl).reshape(cml, esz)
    rgb = raw[:, [2, 1, 0]] if esz >= 3 else np.repeat(raw[:, :1], 3, 1)
    return np.concatenate([np.zeros((cmo, 3), np.uint8), rgb]) if cmo else rgb.copy()


# ------------------------------------------------------------------------------------------ conversion
def convert_dds(b):
    hd = FT.dds_layout(b)
    fmt = hd['fmt']
    if hd['leftover'] < 0:
        raise TextureError('truncated DDS')
    if fmt in (13, 15):
        raise TextureError('DXT2/DXT4 are rejected by the engine')
    w, h, d = hd['w'], hd['h'], hd['depth']
    lv = hd['levels'][:hd['mips']]
    raw = [bytes(b[off:off + sz]) for (_, _, _, off, sz) in lv]
    flags = 0
    if fmt in (12, 14, 16):
        out_fmt = {12: R.FMT_DXT1, 14: R.FMT_DXT3, 16: R.FMT_DXT5}[fmt]
        if d > 1:
            raise TextureError('DXT volume textures are not supported')
        if fmt == 12 and any(dxt1_punchthrough(x) for x in raw):
            flags |= R.FLAG_PUNCHTHROUGH
        levels = raw
    elif fmt in (2, 3):
        out_fmt = R.FMT_RGBA8
        levels = []
        for x in raw:
            px = np.frombuffer(x, np.uint8).reshape(-1, 4)[:, [2, 1, 0, 3]].copy()
            if fmt == 3:
                px[:, 3] = 255
            levels.append(px.tobytes())
    elif fmt == 1:
        out_fmt = R.FMT_RGB8
        levels = [np.frombuffer(x, np.uint8).reshape(-1, 3)[:, ::-1].tobytes() for x in raw]
    else:                                   # 16-bit formats: decode
        out_fmt = R.FMT_RGBA8
        levels = []
        for i, (lw, lh, ld, off, sz) in enumerate(lv):
            one = sz // ld
            levels.append(b''.join(FT.decode_raw(b[off + z * one:off + (z + 1) * one], fmt, lw, lh).tobytes()
                                   for z in range(ld)))
    return R.pack(out_fmt, w, h, levels, depth=d, flags=flags, source=fmt, source_kind=R.SOURCE_DDS)


def convert_tga(b, palette_rgb=None):
    """palette_rgb: (256, 3) palette replacing the file's colour map (lightmaps: Track.pal)."""
    img, info = FT.tga_decode(b)
    it, bpp = info['type'], info['bpp']
    w, h = info['w'], info['h']
    src = info['efmt']
    if it in (1, 9):                        # colour-mapped -> P8 (index plane + palette)
        idx, _ = FT.tga_decode(b, IDENTITY_PALETTE)
        plane = idx[:, :, :1]
        pal = palette_rgb if palette_rgb is not None else tga_colour_map(b)
        if pal is None:
            raise TextureError('colour-mapped TGA without a colour map')
        chain = floor_mean_chain(plane)
        return R.pack(R.FMT_P8, w, h, [c.tobytes() for c in chain], flags=R.FLAG_GENERATED_MIPS,
                      source=src, source_kind=R.SOURCE_TGA, palette=_palette1024(pal))
    if bpp == 8:                            # grey -> L8
        fmt, plane = R.FMT_L8, img[:, :, :1]
    elif bpp == 24:
        fmt, plane = R.FMT_RGB8, img[:, :, :3]
    elif bpp == 32:
        fmt, plane = R.FMT_RGBA8, img
    elif bpp == 16:
        return R.pack(R.FMT_RGBA8, w, h, [np.ascontiguousarray(img).tobytes()], source=src, source_kind=R.SOURCE_TGA)
    else:
        raise TextureError('TGA %d bpp' % bpp)
    chain = floor_mean_chain(np.ascontiguousarray(plane))
    return R.pack(fmt, w, h, [c.tobytes() for c in chain], flags=R.FLAG_GENERATED_MIPS, source=src,
                  source_kind=R.SOURCE_TGA)


def convert(data, ext, palette_rgb=None):
    ext = ext.lower().lstrip('.')
    if ext == 'dds':
        return convert_dds(data)
    if ext == 'tga':
        return convert_tga(data, palette_rgb)
    raise TextureError('unsupported texture file type .%s' % ext)


def decode_level_rgba(info, level=0):
    """Decode one level of an unpacked rtex (rtex.unpack) to RGBA uint8 (d, h, w, 4) -- tests and tools."""
    w, h, d = R.level_dims(info['width'], info['height'], info['depth'], level)
    data = bytes(info['levels'][level])
    f = info['format']
    one = len(data) // d
    out = []
    for z in range(d):
        s = data[z * one:(z + 1) * one]
        if f in R.BLOCK_BYTES:
            img, _ = FT.decode_dxt(s, {R.FMT_DXT1: 12, R.FMT_DXT3: 14, R.FMT_DXT5: 16}[f], w, h)
        elif f == R.FMT_RGBA8:
            img = np.frombuffer(s, np.uint8).reshape(h, w, 4)
        elif f == R.FMT_RGB8:
            img = np.concatenate([np.frombuffer(s, np.uint8).reshape(h, w, 3), np.full((h, w, 1), 255, np.uint8)], 2)
        elif f == R.FMT_L8:
            g = np.frombuffer(s, np.uint8).reshape(h, w, 1)
            img = np.concatenate([g, g, g, np.full((h, w, 1), 255, np.uint8)], 2)
        else:
            pal = np.frombuffer(info['palette'], np.uint8).reshape(256, 4)
            img = pal[np.frombuffer(s, np.uint8).reshape(h, w)]
        out.append(np.asarray(img, np.uint8))
    return np.stack(out)


def alpha_class(a):
    if a.min() == 255:
        return 'opaque'
    u = np.unique(a)
    return 'binary' if np.all((u == 0) | (u == 255)) else 'graded'


# ------------------------------------------------------------------------------------------ registry
class TextureRegistry:
    """One per build process. `use()` / `cube()` resolve, convert, dedupe and write; see module doc."""

    def __init__(self, vfs, out_root, log=None):
        self.vfs = vfs
        self.dir = os.path.join(out_root, 'tex')
        self.log = log
        self._by_source = {}        # (archive, member lower) -> texId
        self._info = {}             # texId -> info dict (header fields + sources)
        self.missing = set()        # (name, stage id) that did not resolve
        self.written = 0
        self.reused = 0

    # --------------------------------------------------------------------------------- lookups
    def resolve(self, name, stage=None):
        """(archive, member) the engine would load for `name` in `stage`, or None."""
        return self.vfs.resolve_texture(name, S.as_stage(stage, self.vfs))

    def use(self, name, stage=None):
        """texId of the texture the engine loads for `name` (in `stage`'s mounts when given), or None
        when nothing resolves (recorded in .missing). Raises TextureError for files that cannot convert."""
        st = S.as_stage(stage, self.vfs)
        hit = self.vfs.resolve_texture(name, st)
        if hit is None:
            self.missing.add((name, st.id if st else None))
            return None
        if hit[1].lower().endswith('.rcm'):
            raise TextureError('%s resolves to a cube map (%s): use cube()' % (name, hit[1]))
        return self.use_file(*hit)

    def use_file(self, arch, member):
        """texId for an explicit archive member (no engine name resolution)."""
        key = (arch, member.lower())
        tid = self._by_source.get(key)
        if tid is not None:
            return tid
        data = self.vfs.archives.read(arch, member)
        ext = member.rsplit('.', 1)[-1]
        pal = self._lightmap_palette(arch, member) if ext.lower() == 'tga' and data[2] in (1, 9) else None
        try:
            blob = convert(data, ext, pal)
        except Exception as e:  # noqa
            raise TextureError('%s:%s: %s' % (arch, member, e)) from e
        tid = hashlib.sha256(blob).hexdigest()[:20]
        path = os.path.join(self.dir, tid + '.rtex')
        if os.path.exists(path):
            self.reused += 1
        else:
            atomic_write(path, blob)
            self.written += 1
        info = self._info.get(tid)
        if info is None:
            info = self._info[tid] = self._header(blob)
            info['sources'] = []
        info['sources'].append('%s:%s' % (arch, member))
        self._by_source[key] = tid
        return tid

    def cube(self, name, stage=None):
        """Six texIds (+X, -X, +Y, -Y, +Z, -Z = the .rcm face lines in file order, D3DCUBEMAP_FACES; faces
        stored top row first, sample in SIM space: three dir (x, y, z) -> cube (x, y, -z), textures.md §5,
        §9.3) for a `.rcm` cube map, or None when the rcm or any face does not resolve (testkub)."""
        st = S.as_stage(stage, self.vfs)
        hit = self.vfs.resolve_texture(name, st)          # engine probe order: an .rcm wins over a TGA only
        if hit is None or not hit[1].lower().endswith('.rcm'):
            self.missing.add((name, st.id if st else None))
            return None
        r = FT.rcm_parse(self.vfs.archives.read(*hit))
        out = []
        for face in r['faces']:
            fh = self.vfs.resolve_texture(face, st)
            if fh is None and '/' not in face:          # bare face names (Env_NewZealand2r): textures.md §10 Q6
                fh = self.vfs.resolve_texture('texture/' + face, st)
            if fh is None or fh[1].lower().endswith('.rcm'):
                self.missing.add((face, st.id if st else None))
                return None
            out.append(self.use_file(*fh))
        return out

    # --------------------------------------------------------------------------------- info
    @staticmethod
    def _header(blob):
        u = R.unpack(blob)
        return {'format': u['formatName'], 'width': u['width'], 'height': u['height'], 'depth': u['depth'],
                'levels': len(u['levels']), 'flags': u['flags'],
                'source': FT.FMT_NAMES.get(u['source'], str(u['source']))}

    def info(self, tid):
        """{format, width, height, depth, levels, flags, source, sources?} for a texId (also for ids written
        by another process: read back from tex/<id>.rtex)."""
        inf = self._info.get(tid)
        if inf is None:
            with open(os.path.join(self.dir, tid + '.rtex'), 'rb') as f:
                inf = self._info[tid] = self._header(f.read())
            inf['sources'] = []
        return inf

    def alpha_class(self, tid, level=0):
        """'opaque' | 'binary' (0/255 only) | 'graded' -- decodes the level (use sparingly)."""
        with open(os.path.join(self.dir, tid + '.rtex'), 'rb') as f:
            u = R.unpack(f.read())
        return alpha_class(decode_level_rgba(u, level)[..., 3])

    # --------------------------------------------------------------------------------- lightmaps
    def _lightmap_palette(self, arch, member):
        """Track.pal of a `<level>/Lightmaps/` TGA (FUN_0065a000: .pal, then .act, else 0xF800 = red)."""
        low = member.replace('\\', '/').lower()
        d = low.rsplit('/', 1)[0]
        if not d.endswith('/lightmaps'):
            return None
        for ext in ('pal', 'act'):
            hit = self.vfs.find('%s/track.%s' % (d, ext), arch)
            if hit is not None and hit[0] == arch:
                return FT.pal_decode(self.vfs.archives.read(*hit))
        red = np.zeros((256, 3), np.uint8)
        red[:, 0] = 255
        return red


class BoundTextures:
    """ctx.textures in a stage build: TextureRegistry with the stage as the default mount
    (pass stage=None explicitly for a global lookup without the stage's Texture/ folder)."""

    _CTX = object()

    def __init__(self, registry, stage):
        self.registry = registry
        self.stage = stage

    def resolve(self, name, stage=_CTX):
        return self.registry.resolve(name, self.stage if stage is BoundTextures._CTX else stage)

    def use(self, name, stage=_CTX):
        return self.registry.use(name, self.stage if stage is BoundTextures._CTX else stage)

    def use_file(self, arch, member):
        return self.registry.use_file(arch, member)

    def cube(self, name, stage=_CTX):
        return self.registry.cube(name, self.stage if stage is BoundTextures._CTX else stage)

    def info(self, tid):
        return self.registry.info(tid)

    def alpha_class(self, tid, level=0):
        return self.registry.alpha_class(tid, level)

    @property
    def missing(self):
        return self.registry.missing
