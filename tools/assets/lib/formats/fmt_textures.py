#!/usr/bin/env python3
"""Image formats of the original game (DDS / TGA / RCM cube maps / RIFF PAL) -> RGBA.

Pure numpy decoders that follow the engine's own loaders in the decomp
(research/decomp/all.c + objdump of original_version/original_desktop_version.exe;
several handler methods are not Ghidra functions and were read as assembly):

  TextureHandler.DDS   vtable 0x824308   header FUN_006ad500, format map FUN_006ad560,
                                         info FUN_006ad210, load FUN_006ace80
  TextureHandler.Targa vtable 0x8242c0   header FUN_006ac7c0, format map FUN_006acb60,
                                         rows FUN_006ac950, RLE FUN_006aca00
  TextureHandler.Cube  vtable 0x82432c   .rcm parse FUN_006ae440 (+ line reader
                                         FUN_006ae300), load FUN_006ad780,
                                         writer FUN_006ad8e0 (_Right/_Left/... names)
  TextureManager       vtable 0x824100   lookup FUN_006a70c0 -> FUN_006a7280 (handler
                                         probe order = sorted handler names)
  lightmap palette     FUN_0065a000      <level>/Lightmaps/Track.pal (RIFF PAL; .act
                                         fallback) -> P8 palette or R5G6B5 LUT

Format enum (engine-internal, FUN_0068fd90 maps it to D3DFORMAT, FUN_007ebe00 = bits/px):
  1 R8G8B8(24)  2 A8R8G8B8(32)  3 X8R8G8B8(32)  4 A4R4G4B4  5 A1R5G5B5  6 R5G6B5
  7 X1R5G5B5  8 A8  9 L8  10 P8  12 DXT1(4bpp)  13 DXT2  14 DXT3  15 DXT4  16 DXT5

Usage:
  python3 -I fmt_textures.py census            # parse + decode every image, write
                                               # artifacts/re/textures/census.json
  python3 -I fmt_textures.py sheets            # contact sheets -> artifacts/re/textures/
  python3 -I fmt_textures.py info <file>       # dump one file's header
  python3 -I fmt_textures.py png <file> <out.png> [level]
"""
import os, re, sys, json, struct, collections

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # rally-web: data roots from _paths.py
from _paths import REPO as ROOT, FULL, ART_ROOT  # noqa: E402
ART = os.path.join(ART_ROOT, 'textures')

FMT_NAMES = {1: 'R8G8B8', 2: 'A8R8G8B8', 3: 'X8R8G8B8', 4: 'A4R4G4B4', 5: 'A1R5G5B5',
             6: 'R5G6B5', 7: 'X1R5G5B5', 8: 'A8', 9: 'L8', 10: 'P8', 12: 'DXT1',
             13: 'DXT2', 14: 'DXT3', 15: 'DXT4', 16: 'DXT5'}
BPP = {1: 24, 2: 32, 3: 32, 4: 16, 5: 16, 6: 16, 7: 16, 8: 8, 9: 8, 10: 8,
       12: 4, 13: 8, 14: 8, 15: 8, 16: 8}          # FUN_007ebe00
DXT = (12, 13, 14, 15, 16)


class FormatError(Exception):
    pass


# ----------------------------------------------------------------------------- DDS
DDSD_MIPMAPCOUNT = 0x20000
DDSD_DEPTH = 0x800000
DDSCAPS2_CUBEMAP = 0x200
DDSCAPS2_VOLUME = 0x200000


def dds_header(b):
    """FUN_006ad500 + FUN_006ad560.  Returns dict; raises FormatError like the engine."""
    if len(b) < 128 or b[:4] != b'DDS ':
        raise FormatError('no DDS magic')
    (size, flags, h, w, pitch, depth, mips) = struct.unpack_from('<7I', b, 4)
    pf_size, pf_flags, fourcc, bits, rm, gm, bm, am = struct.unpack_from('<II4s5I', b, 76)
    caps1, caps2 = struct.unpack_from('<II', b, 108)
    if mips == 0:
        mips = 1                                    # FUN_006ad500: 0 -> 1
    if w == 0 or h == 0:
        raise FormatError('zero size')
    # FUN_006ad560: FourCC is tested first and WITHOUT looking at DDPF_FOURCC
    fc = {b'DXT1': 12, b'DXT2': 13, b'DXT3': 14, b'DXT4': 15, b'DXT5': 16}.get(fourcc)
    if fc is None:
        if bits == 32:
            fc = 2                                  # always A8R8G8B8 (masks ignored)
        elif bits == 24:
            fc = 1
        elif bits == 16:
            fc = {0xf0: 4, 0x3e0: 5, 0x7e0: 6}.get(gm)   # keyed on the GREEN mask
            if fc is None:
                raise FormatError('16-bit mask')
        else:
            raise FormatError('bitcount %d' % bits)
    vol = bool(flags & DDSD_DEPTH) and depth >= 1   # FUN_006ad210 volume test
    return dict(size=size, flags=flags, w=w, h=h, pitch=pitch, depth=depth if vol else 1,
                volume=vol, mips=mips, fmt=fc, pf_flags=pf_flags, fourcc=fourcc,
                bits=bits, masks=(rm, gm, bm, am), caps1=caps1, caps2=caps2,
                cube=bool(caps2 & DDSCAPS2_CUBEMAP))


def dds_level_size(fmt, w, h):
    """Byte size of one 2-D level exactly as FUN_006ace80 computes it."""
    bpp = BPP[fmt]
    if fmt not in DXT:
        return bpp * w * h // 8
    if w >= 4 and h >= 4:
        return bpp * w * h // 8
    s = (bpp * 16) // 8
    if h > 4:
        s *= h // 4
    if w > 4:
        s *= w // 4
    return s


def dds_layout(b):
    """Header + list of levels (w, h, d, offset, size) + leftover byte count."""
    hd = dds_header(b)
    off = 128
    levels = []
    w, h, d = hd['w'], hd['h'], hd['depth']
    for i in range(hd['mips']):
        lw, lh, ld = max(1, w >> i), max(1, h >> i), max(1, d >> i)
        sz = dds_level_size(hd['fmt'], lw, lh) * ld
        levels.append((lw, lh, ld, off, sz))
        off += sz
    hd['levels'] = levels
    hd['end'] = off
    hd['leftover'] = len(b) - off
    # Trailing bytes: the exporter wrote the chain down to 1x1 but stored
    # dwMipMapCount = log2(min(w,h))+1 for non-square maps.  FUN_006ace80 reads only
    # dwMipMapCount levels, so these are never used.  Explain them level by level.
    hd['trailing_levels'] = 0
    if hd['leftover'] > 0:
        t, i = 0, hd['mips']
        while t < hd['leftover'] and (w >> i or h >> i):
            t += dds_level_size(hd['fmt'], max(1, w >> i), max(1, h >> i)) * max(1, d >> i)
            i += 1
        if t == hd['leftover']:
            hd['trailing_levels'] = i - hd['mips']
    return hd


def _expand565(c):
    c = c.astype(np.uint32)
    r = (c >> 11) & 31
    g = (c >> 5) & 63
    bl = c & 31
    return np.stack([(r << 3) | (r >> 2), (g << 2) | (g >> 4), (bl << 3) | (bl >> 2)], -1)


def _blocks_to_image(px, bw, bh, w, h):
    # px: (bh*bw, 16, 4) -> (h, w, 4), cropping to the level size (levels < 4 px)
    img = px.reshape(bh, bw, 4, 4, 4).transpose(0, 2, 1, 3, 4).reshape(bh * 4, bw * 4, 4)
    return img[:h, :w]


def _dxt_color(blk, four_color_always):
    """blk: (n, 8) uint8 colour blocks -> (n, 16, 4) RGBA (alpha from DXT1 mode)."""
    c0 = blk[:, 0].astype(np.uint16) | (blk[:, 1].astype(np.uint16) << 8)
    c1 = blk[:, 2].astype(np.uint16) | (blk[:, 3].astype(np.uint16) << 8)
    idx = (blk[:, 4].astype(np.uint32) | (blk[:, 5].astype(np.uint32) << 8) |
           (blk[:, 6].astype(np.uint32) << 16) | (blk[:, 7].astype(np.uint32) << 24))
    e0 = _expand565(c0)
    e1 = _expand565(c1)
    four = (c0 > c1) | four_color_always
    pal = np.zeros((len(blk), 4, 4), np.uint32)
    pal[:, 0, :3] = e0
    pal[:, 1, :3] = e1
    pal[:, :2, 3] = 255
    f = four[:, None]
    # truncating division: bit-exact with SwiftShader's S3TC decoder (validated by
    # artifacts/re/textures/s3tc_parity.json); the D3D spec leaves the rounding open, so
    # 2002-era GPUs may differ by 1 LSB here.
    pal[:, 2, :3] = np.where(f, (2 * e0 + e1) // 3, (e0 + e1) // 2)
    pal[:, 3, :3] = np.where(f, (e0 + 2 * e1) // 3, 0)
    pal[:, 2, 3] = 255
    pal[:, 3, 3] = np.where(four, 255, 0)           # DXT1 3-colour mode: index 3 = transparent black
    sel = (idx[:, None] >> (2 * np.arange(16, dtype=np.uint32))[None, :]) & 3
    out = np.take_along_axis(pal, sel[:, :, None].astype(np.int64).repeat(4, 2), 1)
    return out.astype(np.uint8), (~four) & np.any(sel == 3, 1)


def decode_dxt(data, fmt, w, h):
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    bs = 8 if fmt == 12 else 16
    need = bw * bh * bs
    a = np.frombuffer(data, np.uint8, need).reshape(bw * bh, bs)
    if fmt == 12:
        px, punch = _dxt_color(a, False)
        return _blocks_to_image(px, bw, bh, w, h), bool(punch.any())
    px, _ = _dxt_color(a[:, 8:], True)              # DXT2-5: colour always 4-colour mode
    px = px.copy()
    if fmt in (13, 14):                             # explicit 4-bit alpha
        al = a[:, :8]
        nib = np.stack([al & 15, al >> 4], -1).reshape(-1, 16).astype(np.uint32)
        px[:, :, 3] = (nib * 17).astype(np.uint8)
    else:                                           # interpolated alpha
        a0 = a[:, 0].astype(np.int32)
        a1 = a[:, 1].astype(np.int32)
        bits = np.zeros(len(a), np.uint64)
        for i in range(6):
            bits |= a[:, 2 + i].astype(np.uint64) << np.uint64(8 * i)
        sel = ((bits[:, None] >> (np.uint64(3) * np.arange(16, dtype=np.uint64))[None, :])
               & np.uint64(7)).astype(np.int64)
        tab = np.zeros((len(a), 8), np.int32)
        tab[:, 0] = a0
        tab[:, 1] = a1
        eight = (a0 > a1)[:, None]
        for i in range(1, 7):                       # 8-alpha: (7-i)a0 + i a1 / 7
            t8 = ((7 - i) * a0 + i * a1) // 7          # truncating (SwiftShader parity)
            tab[:, 1 + i] = t8
        for i in range(1, 5):                       # 6-alpha: (5-i)a0 + i a1 / 5, then 0, 255
            t6 = ((5 - i) * a0 + i * a1) // 5
            tab[:, 1 + i] = np.where(eight[:, 0], tab[:, 1 + i], t6)
        tab[:, 6] = np.where(eight[:, 0], tab[:, 6], 0)
        tab[:, 7] = np.where(eight[:, 0], tab[:, 7], 255)
        px[:, :, 3] = np.take_along_axis(tab, sel, 1).astype(np.uint8)
    if fmt in (13, 15):                             # premultiplied variants (absent; rejected by engine)
        pass
    return _blocks_to_image(px, bw, bh, w, h), False


def decode_raw(data, fmt, w, h):
    n = w * h
    if fmt in (2, 3):
        a = np.frombuffer(data, np.uint8, n * 4).reshape(h, w, 4)   # B G R A in memory
        out = a[:, :, [2, 1, 0, 3]].copy()
        if fmt == 3:
            out[:, :, 3] = 255
        return out
    if fmt == 1:
        a = np.frombuffer(data, np.uint8, n * 3).reshape(h, w, 3)
        out = np.empty((h, w, 4), np.uint8)
        out[:, :, :3] = a[:, :, ::-1]
        out[:, :, 3] = 255
        return out
    if fmt in (4, 5, 6, 7):
        c = np.frombuffer(data, '<u2', n).reshape(h, w).astype(np.uint32)
        out = np.empty((h, w, 4), np.uint8)
        if fmt == 6:
            out[:, :, :3] = _expand565(c)
            out[:, :, 3] = 255
        elif fmt in (5, 7):
            r, g, b_ = (c >> 10) & 31, (c >> 5) & 31, c & 31
            out[:, :, 0] = (r << 3) | (r >> 2)
            out[:, :, 1] = (g << 3) | (g >> 2)
            out[:, :, 2] = (b_ << 3) | (b_ >> 2)
            out[:, :, 3] = np.where((c >> 15) & 1, 255, 0) if fmt == 5 else 255
        else:
            out[:, :, 0] = ((c >> 8) & 15) * 17
            out[:, :, 1] = ((c >> 4) & 15) * 17
            out[:, :, 2] = (c & 15) * 17
            out[:, :, 3] = ((c >> 12) & 15) * 17
        return out
    raise FormatError('raw fmt %d' % fmt)


def decode_dds(b, level=0, slice_=None):
    """-> (RGBA (h,w,4) or (d,h,w,4) for volumes, header).  Level 0 = full size."""
    hd = dds_layout(b)
    lw, lh, ld, off, sz = hd['levels'][level]
    if hd['leftover'] < 0 and off + sz > len(b):
        raise FormatError('truncated')
    one = sz // ld
    out = []
    punch = False
    for z in range(ld):
        data = b[off + z * one: off + (z + 1) * one]
        if hd['fmt'] in DXT:
            img, p = decode_dxt(data, hd['fmt'], lw, lh)
            punch |= p
        else:
            img = decode_raw(data, hd['fmt'], lw, lh)
        out.append(img)
    hd['punchthrough'] = punch
    if hd['volume']:
        return (np.stack(out) if slice_ is None else out[slice_]), hd
    return out[0], hd


# ----------------------------------------------------------------------------- TGA
def tga_decode(b, palette=None):
    """FUN_006ac7c0 / FUN_006acb60 / FUN_006ac950 / FUN_006aca00 -> (RGBA top-down, info).

    palette: optional (256,3) uint8 RGB that REPLACES the file's colour map (lightmaps
    are drawn through <level>/Lightmaps/Track.pal, FUN_0065a000)."""
    if len(b) < 18:
        raise FormatError('short tga')
    idl, cmt, it, cmo, cml, cmd, xo, yo, w, h, bpp, desc = struct.unpack_from('<BBBHHBHHHHBB', b, 0)
    # engine format (FUN_006acb60): type 1 -> P8 (or R5G6B5 when lightmaps are converted);
    # else by bits/pixel: 8 -> L8, 16 -> X1R5G5B5, 24 -> R8G8B8, 32 -> A8R8G8B8
    if it in (1, 9):
        efmt = 10
    else:
        efmt = {8: 9, 16: 7, 24: 1, 32: 2}.get(bpp)
        if efmt is None:
            raise FormatError('tga bpp %d' % bpp)
    off = 18 + idl
    cmap = None
    if cmt == 1:
        esz = (cmd + 7) // 8
        raw = np.frombuffer(b, np.uint8, cml * esz, off).reshape(cml, esz)
        off += cml * esz
        if esz == 3:
            cmap = np.concatenate([raw[:, [2, 1, 0]], np.full((cml, 1), 255, np.uint8)], 1)
        elif esz == 4:
            cmap = raw[:, [2, 1, 0, 3]].copy()
        else:
            raise FormatError('cmap depth %d' % cmd)
        cmap = np.concatenate([np.zeros((cmo, 4), np.uint8), cmap]) if cmo else cmap
    elif cml and it not in (1, 9):
        pass        # junk colour-map spec on true-colour files (cmt=0): engine ignores it
    ps = (bpp + 7) // 8
    n = w * h
    if it in (1, 2, 3):
        pix = np.frombuffer(b, np.uint8, n * ps, off).reshape(n, ps)
        off += n * ps
    elif it in (9, 10, 11):
        out = np.empty((n, ps), np.uint8)
        i = 0
        while i < n:
            c = b[off]; off += 1
            cnt = (c & 127) + 1
            if c & 128:
                out[i:i + cnt] = np.frombuffer(b, np.uint8, ps, off); off += ps
            else:
                out[i:i + cnt] = np.frombuffer(b, np.uint8, cnt * ps, off).reshape(cnt, ps)
                off += cnt * ps
            i += cnt
        pix = out
    else:
        raise FormatError('tga type %d' % it)
    if it in (1, 9):
        idx = pix[:, 0]
        if palette is not None:
            pal = np.concatenate([palette[:, :3], np.full((len(palette), 1), 255, np.uint8)], 1)
        else:
            pal = cmap
        rgba = pal[idx]
    elif ps == 1:
        rgba = np.repeat(pix, 4, 1)
        rgba[:, 3] = 255
    elif ps == 2:
        c = pix[:, 0].astype(np.uint32) | (pix[:, 1].astype(np.uint32) << 8)
        rgba = np.empty((n, 4), np.uint8)
        for k, s in ((0, 10), (1, 5), (2, 0)):
            v = (c >> s) & 31
            rgba[:, k] = (v << 3) | (v >> 2)
        rgba[:, 3] = 255                            # engine: X1R5G5B5
    elif ps == 3:
        rgba = np.concatenate([pix[:, [2, 1, 0]], np.full((n, 1), 255, np.uint8)], 1)
    else:
        rgba = pix[:, [2, 1, 0, 3]].copy()
    img = rgba.reshape(h, w, 4)
    if not (desc & 0x20):                           # bottom-up rows (FUN_006ac950)
        img = img[::-1]
    if desc & 0x10:
        img = img[:, ::-1]
    # TGA 2.0 footer (26 bytes) and optional extension / developer areas
    end = off
    footer = False
    if len(b) - off >= 26 and b[-18:] == b'TRUEVISION-XFILE.\0':
        footer = True
        ext_off, dev_off = struct.unpack_from('<II', b, len(b) - 26)
        end = len(b) - 26
        tail = b[off:end]
        if ext_off or dev_off:
            pass                                    # areas live between off and footer
        elif any(tail):
            raise FormatError('non-zero gap before footer')
        off = end + 26
    info = dict(type=it, cmap_type=cmt, cmap_len=cml, cmap_depth=cmd, bpp=bpp, desc=desc,
                w=w, h=h, idlen=idl, efmt=efmt, footer=footer, end=off,
                leftover=len(b) - off, rle=it >= 9)
    return np.ascontiguousarray(img), info


# ----------------------------------------------------------------------------- PAL / RCM
def pal_decode(b):
    """RIFF 'PAL ' (LOGPALETTE) -> (n,3) RGB.  FUN_0065a000 reads 0x418 bytes and uses
    entries at +24 as (R,G,B,flags).  Extra chunks after 'data' are ignored."""
    if b[:4] == b'RIFF' and b[8:12] == b'PAL ':
        pos = 12
        while pos + 8 <= len(b):
            cid, csz = b[pos:pos + 4], struct.unpack_from('<I', b, pos + 4)[0]
            if cid == b'data':
                ver, n = struct.unpack_from('<HH', b, pos + 8)
                e = np.frombuffer(b, np.uint8, n * 4, pos + 12).reshape(n, 4)
                return e[:, :3].copy()
            pos += 8 + csz + (csz & 1)
        raise FormatError('no data chunk')
    if len(b) in (768, 772):                        # .act fallback
        return np.frombuffer(b, np.uint8, 768).reshape(256, 3).copy()
    raise FormatError('not a palette')


def pal_chunks(b):
    out = []
    pos = 12
    while pos + 8 <= len(b):
        cid, csz = b[pos:pos + 4], struct.unpack_from('<I', b, pos + 4)[0]
        out.append((cid.decode('latin1'), csz))
        pos += 8 + csz + (csz & 1)
    return out, len(b) - pos


CUBE_FACES = ('PositiveX', 'NegativeX', 'PositiveY', 'NegativeY', 'PositiveZ', 'NegativeZ')
# engine writer FUN_006ad8e0: face i is saved as <base><suffix>.tga
CUBE_SUFFIX = ('_Right', '_Left', '_Up', '_Down', '_Front', '_Back')


def rcm_parse(b):
    """FUN_006ae440: line 1 must EQUAL '[CubeMap]' (after the line reader drops '\\r';
    std::string::compare(0, len, "[CubeMap]", 9) = FUN_0047bfe0, so a longer line fails;
    verifier fix, all 74 shipped files comply); the next SIX lines are the
    faces in D3DCUBEMAP_FACES order (+X,-X,+Y,-Y,+Z,-Z) BY POSITION - the key before
    '=' is never compared.  Value = text after the first '=', leading spaces skipped,
    extension stripped (FUN_00510390) and '.tga' appended (the extension is then
    ignored by the manager's lookup, see resolve())."""
    lines = b.split(b'\n')
    lines = [l[:-1] if l.endswith(b'\r') else l for l in lines]
    if lines[0] != b'[CubeMap]':
        raise FormatError('line 1 is not exactly [CubeMap]')
    faces = []
    keys = []
    for l in lines[1:7]:
        if b'=' not in l:
            raise FormatError('face line without =')
        k, v = l.split(b'=', 1)
        v = v.lstrip(b' ').decode('latin1')
        keys.append(k.strip().decode('latin1'))
        base = v.rsplit('.', 1)[0] if '.' in v.rsplit('/', 1)[-1] else v
        faces.append(base)
    trailing = b'\n'.join(lines[7:])
    return dict(faces=faces, keys=keys, trailing=len(trailing.strip()))


# ----------------------------------------------------------------------------- resolve
# TextureManager probe order (FUN_006a8670 inserts handler->getName() into an ordered
# std::set; FUN_006a7280 walks it begin..end and loads the first <base>.<EXT> that exists)
PROBE_ORDER = ('BMP', 'DDS', 'RCM', 'RTX', 'TGA')


def stage_dirs(stage):
    """stage id like 'corsica1f' -> (track root dir, virtual 'Track/<Name>/<Dir>')."""
    m = re.match(r'([a-z]+\d[abc]?)([fr])$', stage)
    name, d = m.group(1), m.group(2)
    sub = 'forward' if d == 'f' else 'reverse'
    return os.path.join(FULL, stage, 'track', name, sub)


_ci_cache = {}


def _ci_index(d):
    if d not in _ci_cache:
        idx = {}
        if os.path.isdir(d):
            for f in os.listdir(d):
                idx.setdefault(f.lower(), f)
        _ci_cache[d] = idx
    return _ci_cache[d]


def ci_path(path):
    """Case-insensitive path lookup (the archives are Windows paths)."""
    parts = path.replace('\\', '/').split('/')
    cur = parts[0] if parts[0] else '/'
    for p in parts[1:]:
        if not p:
            continue
        idx = _ci_index(cur)
        hit = idx.get(p.lower())
        if hit is None:
            return None
        cur = os.path.join(cur, hit)
    return cur


def resolve(vpath, stage=None):
    """Virtual texture name ('texture/CO_Tarmac_01_MT', 'Track/Corsica1/Forward/Texture/x',
    'menu/texture/carenvmap') -> real file under research/full, honouring the engine's
    extension probe order.  'texture/' is searched in the stage's Texture/ dir first,
    then Misc/texture (mount order [?], see spec)."""
    v = vpath.replace('\\', '/')
    base = v.rsplit('.', 1)[0] if '.' in v.rsplit('/', 1)[-1] else v
    roots = []
    low = base.lower()
    if low.startswith('texture/'):
        rest = base[len('texture/'):]
        if stage:
            roots.append(os.path.join(stage_dirs(stage), 'Texture', rest))
        roots.append(os.path.join(FULL, 'Misc', 'texture', rest))
    elif low.startswith('track/'):
        p = base.split('/')
        st = p[1].lower() + p[2][0].lower()
        roots.append(os.path.join(FULL, st, 'track', p[1].lower(), p[2].lower(), *p[3:]))
    elif low.startswith('menu/'):
        roots.append(os.path.join(FULL, 'Menu', 'menu', *base.split('/')[1:]))
        roots.append(os.path.join(FULL, 'LocaleEnglish', 'locale', 'english', *base.split('/')))
    else:
        roots.append(os.path.join(FULL, 'Misc', base))
    for r in roots:
        for ext in PROBE_ORDER:
            hit = ci_path(r + '.' + ext.lower())
            if hit:
                return hit
    return None


def load_rgba(path, level=0, palette=None):
    b = open(path, 'rb').read()
    ext = path.rsplit('.', 1)[-1].lower()
    if ext == 'dds':
        img, hd = decode_dds(b, level)
        if hd['volume']:
            img = img[0]
        return img, hd
    if ext == 'tga':
        if palette is None and os.path.basename(os.path.dirname(path)) == 'Lightmaps':
            pp = os.path.join(os.path.dirname(path), 'Track.pal')
            if os.path.exists(pp):
                palette = pal_decode(open(pp, 'rb').read())
        return tga_decode(b, palette)
    raise FormatError('ext ' + ext)


def load_cube(rcm_path, stage=None):
    """-> list of 6 (face name, resolved path, RGBA)."""
    r = rcm_parse(open(rcm_path, 'rb').read())
    out = []
    for k, f in zip(CUBE_FACES, r['faces']):
        p = resolve(f, stage)
        if p is None and stage is None:
            # faces named relative to the rcm's own archive
            p = ci_path(os.path.join(os.path.dirname(rcm_path), os.path.basename(f) + '.dds')) or \
                ci_path(os.path.join(os.path.dirname(rcm_path), os.path.basename(f) + '.tga'))
        img = load_rgba(p)[0] if p else None
        out.append((k, p, img))
    return out


# ----------------------------------------------------------------------------- census
def category(rel):
    p = rel.split('/')
    low = rel.lower()
    if p[0] in ('Misc',):
        if '/texture/car/' in low:
            if '/dropshadows/' in low:
                return 'car-dropshadow'
            return 'car-livery'
        if '/font/' in low:
            return 'font'
        if '/texture/' in low:
            return 'misc-texture'
        return 'misc-other'
    if p[0] == 'Menu':
        return 'menu'
    if p[0] == 'LocaleEnglish':
        return 'locale'
    if p[0] == 'Cars':
        return 'cars'
    # track archives
    sub = p[4] if len(p) > 4 else ''
    fn = p[-1].lower()
    if sub == 'Lightmaps':
        return 'track-lightmap'
    if sub == 'Screenshots':
        return 'track-screenshot'
    if sub == 'Billboards':
        return 'track-billboard'
    if fn.startswith('carenvmap'):
        return 'track-carenvmap'
    if fn.startswith('sky'):
        return 'track-sky'
    if fn.endswith('.rcm') or 'water' in fn:
        return 'track-water'
    if fn.startswith('cardirtmap'):
        return 'track-cardirt'
    return 'track-texture'


def stage_of(rel):
    p = rel.split('/')
    if len(p) > 3 and p[1] == 'track':
        return p[0]
    return None


def alpha_class(a):
    """'opaque' | 'binary' (only 0/255) | 'full' (graded)."""
    if a.min() == 255:
        return 'opaque'
    u = np.unique(a)
    if np.all((u == 0) | (u == 255)):
        return 'binary'
    return 'full'


def census():
    os.makedirs(ART, exist_ok=True)
    rows = []
    fails = []
    for dp, dn, fn in os.walk(FULL):
        dn.sort()
        for f in sorted(fn):
            ext = f.rsplit('.', 1)[-1].lower() if '.' in f else ''
            if ext not in ('dds', 'tga', 'rcm', 'pal'):
                continue
            path = os.path.join(dp, f)
            rel = os.path.relpath(path, FULL)
            b = open(path, 'rb').read()
            row = dict(path=rel, ext=ext, bytes=len(b), cat=category(rel), stage=stage_of(rel))
            try:
                if ext == 'dds':
                    hd = dds_layout(b)
                    img, hd2 = decode_dds(b, 0)
                    a = img[..., 3]
                    row.update(fmt=FMT_NAMES[hd['fmt']], w=hd['w'], h=hd['h'], depth=hd['depth'],
                               mips=hd['mips'], volume=hd['volume'], cube=hd['cube'],
                               leftover=hd['leftover'], trailing_levels=hd['trailing_levels'],
                               alpha=alpha_class(a),
                               punch=hd2['punchthrough'],
                               full_chain=hd['mips'] == 1 + int(np.log2(max(hd['w'], hd['h']))),
                               payload=hd['end'] - 128, pf_flags=hd['pf_flags'],
                               mean=[float(x) for x in img.reshape(-1, 4).mean(0)])
                    # decode every level too (validation)
                    for lv in range(1, hd['mips']):
                        decode_dds(b, lv)
                elif ext == 'tga':
                    img, info = load_rgba(path)
                    row.update(fmt='TGA%d/%dbpp' % (info['type'], info['bpp']), w=info['w'],
                               h=info['h'], tga_type=info['type'], bpp=info['bpp'],
                               origin_top=bool(info['desc'] & 0x20), footer=info['footer'],
                               leftover=info['leftover'], alpha=alpha_class(img[..., 3]),
                               efmt=FMT_NAMES[info['efmt']], payload=info['w'] * info['h'] * (info['bpp'] // 8),
                               mean=[float(x) for x in img.reshape(-1, 4).mean(0)])
                    if info['type'] == 1:
                        row['alpha'] = 'opaque'
                elif ext == 'rcm':
                    r = rcm_parse(b)
                    st = stage_of(rel)
                    res = [resolve(x, st) for x in r['faces']]
                    row.update(fmt='RCM', keys=r['keys'], faces=r['faces'],
                               resolved=[os.path.relpath(x, FULL) if x else None for x in res],
                               trailing=r['trailing'], leftover=0)
                elif ext == 'pal':
                    pal = pal_decode(b)
                    ch, lo = pal_chunks(b)
                    row.update(fmt='RIFF-PAL', entries=len(pal), chunks=ch, leftover=lo)
            except Exception as e:  # noqa
                fails.append((rel, repr(e)))
                row['error'] = repr(e)
            rows.append(row)
    json.dump(dict(rows=rows, fails=fails), open(os.path.join(ART, 'census.json'), 'w'), indent=0)
    return rows, fails


def summarize(rows):
    C = collections.defaultdict(lambda: [0, 0])
    for r in rows:
        if 'error' in r:
            continue
        k = (r['cat'], r['ext'], r.get('fmt', '?'))
        C[k][0] += 1
        C[k][1] += r['bytes']
    for k in sorted(C):
        print('%-18s %-4s %-14s %6d %10.1f MB' % (k + (C[k][0], C[k][1] / 1e6)))


def main(argv):
    cmd = argv[1] if len(argv) > 1 else 'census'
    if cmd == 'census':
        rows, fails = census()
        summarize(rows)
        lo = [r for r in rows if r.get('leftover')]
        unexpl = [r for r in lo if not r.get('trailing_levels')]
        print('files', len(rows), 'failed', len(fails), 'with leftover bytes', len(lo),
              '(explained as unused trailing mip levels: %d, unexplained: %d)' % (len(lo) - len(unexpl), len(unexpl)))
        lo = unexpl
        for f in fails[:20]:
            print('FAIL', f)
        for r in lo[:20]:
            print('LEFTOVER', r['path'], r['leftover'])
    elif cmd == 'info':
        b = open(argv[2], 'rb').read()
        if argv[2].lower().endswith('.dds'):
            print(json.dumps(dds_layout(b), default=str, indent=1))
        elif argv[2].lower().endswith('.tga'):
            print(tga_decode(b)[1])
        elif argv[2].lower().endswith('.rcm'):
            print(rcm_parse(b))
        elif argv[2].lower().endswith('.pal'):
            print(pal_chunks(b), pal_decode(b)[:8])
    elif cmd == 'png':
        from PIL import Image
        lv = int(argv[4]) if len(argv) > 4 else 0
        img, _ = load_rgba(argv[2], lv)
        Image.fromarray(img).save(argv[3])
    elif cmd == 'sheets':
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import fmt_textures_sheets
        fmt_textures_sheets.main()
    else:
        print(__doc__)


if __name__ == '__main__':
    main(sys.argv)
