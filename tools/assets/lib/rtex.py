"""`.rtex` -- rally-web texture container (one texture per file, content-addressed by its bytes).

Mirror of src/render/orig/rtex.ts (keep both in sync; spec in docs/ASSETS.md "The .rtex container").
Little-endian, 4-byte aligned:

  off   type        field
  0     char[4]     magic 'RTEX'
  4     u16         version = 1
  6     u8          format      FORMATS below
  7     u8          flags       FLAG_* below
  8     u32         width       level 0
  12    u32         height      level 0
  16    u32         depth       slices (1 for 2-D textures; > 1 only with FLAG_VOLUME)
  20    u32         levels      n >= 1 (the authored chain; unused trailing DDS levels are dropped)
  24    u8          source      engine format enum of the source file (fmt_textures.FMT_NAMES:
                                1 R8G8B8, 2 A8R8G8B8, 9 L8, 10 P8, 12 DXT1, 14 DXT3, 16 DXT5, ...)
  25    u8          sourceKind  1 = DDS, 2 = TGA
  26    u16         reserved    0
  28    u32         paletteOffset   0, or the offset of 256 x RGBA8 (A = 255) for format P8
  32    u32[n]      levelOffset     from file start, 4-aligned
  32+4n u32[n]      levelSize       bytes (exactly level_size(format, w_i, h_i, d_i))
  ...               palette (1024 B, P8 only), then the level payloads (each padded to 4 bytes)

Level i has w_i = max(1, w >> i), h_i = max(1, h >> i), d_i = max(1, d >> i) (D3D chain rule; volume
depth halves per level too). Rows are stored top row first (D3D/top-left origin: upload with flipY =
false and use the original UVs unchanged). Payloads:

  DXT1/DXT3/DXT5   the original S3TC blocks unchanged (row-major 4x4 blocks, 8 or 16 bytes each), per slice
  RGBA8            R,G,B,A bytes (A8R8G8B8 DDS are BGRA in the file and swizzled at build time)
  RGB8             R,G,B bytes (R8G8B8 DDS, 24-bit TGA)
  L8               luminance bytes (8-bit grey TGA, type 3); the engine samples it as (L, L, L, 1)
  P8               palette indices (8-bit colour-mapped TGA); colour = palette[index]; the index mip chain
                   was averaged in index space (engine AverageMipmap, textures.md §3.3/§4) and must be
                   expanded through the palette PER LEVEL (D3D P8 filters after the palette lookup)

flags: FLAG_VOLUME (1) depth slices, sample as a 3-D texture; FLAG_PALETTE (2) palette present (P8);
FLAG_PUNCHTHROUGH (4) a DXT1 level has 3-colour blocks that use index 3 (= transparent black, D3D DXT1
semantics; always upload DXT1 as RGBA_S3TC_DXT1); FLAG_GENERATED_MIPS (8) levels >= 1 were generated at
build time with the engine rule level[L] = floor(mean of level 0 over the clamped 2^L x 2^L block)
(TGA sources; DDS chains are always the authored ones).
"""
import struct

MAGIC = b'RTEX'
VERSION = 1

FMT_DXT1, FMT_DXT3, FMT_DXT5, FMT_RGBA8, FMT_RGB8, FMT_L8, FMT_P8 = 1, 2, 3, 4, 5, 6, 7
FORMATS = {FMT_DXT1: 'DXT1', FMT_DXT3: 'DXT3', FMT_DXT5: 'DXT5', FMT_RGBA8: 'RGBA8', FMT_RGB8: 'RGB8',
           FMT_L8: 'L8', FMT_P8: 'P8'}
FORMAT_IDS = {v: k for k, v in FORMATS.items()}
BLOCK_BYTES = {FMT_DXT1: 8, FMT_DXT3: 16, FMT_DXT5: 16}
TEXEL_BYTES = {FMT_RGBA8: 4, FMT_RGB8: 3, FMT_L8: 1, FMT_P8: 1}

FLAG_VOLUME, FLAG_PALETTE, FLAG_PUNCHTHROUGH, FLAG_GENERATED_MIPS = 1, 2, 4, 8
SOURCE_DDS, SOURCE_TGA = 1, 2

HEADER = struct.Struct('<4sHBBIIIIBBHI')     # 32 bytes


def level_dims(w, h, d, i):
    return max(1, w >> i), max(1, h >> i), max(1, d >> i)


def level_size(fmt, w, h, d=1):
    if fmt in BLOCK_BYTES:
        return max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * BLOCK_BYTES[fmt] * d
    return w * h * d * TEXEL_BYTES[fmt]


def _pad4(n):
    return (n + 3) & ~3


def pack(fmt, width, height, levels, depth=1, flags=0, source=0, source_kind=0, palette=None):
    """levels: list of bytes-like (level 0 first). palette: 256*4 bytes RGBA (P8 only)."""
    n = len(levels)
    if n < 1:
        raise ValueError('no levels')
    if fmt == FMT_P8:
        if palette is None or len(palette) != 1024:
            raise ValueError('P8 needs a 1024-byte RGBA palette')
        flags |= FLAG_PALETTE
    elif palette is not None:
        raise ValueError('palette only for P8')
    if depth > 1:
        flags |= FLAG_VOLUME
    for i, lv in enumerate(levels):
        w, h, d = level_dims(width, height, depth, i)
        if len(lv) != level_size(fmt, w, h, d):
            raise ValueError('level %d: %d bytes, expected %d' % (i, len(lv), level_size(fmt, w, h, d)))
    pos = HEADER.size + 8 * n
    pal_off = 0
    if palette is not None:
        pal_off = pos
        pos += 1024
    offs = []
    for lv in levels:
        offs.append(pos)
        pos += _pad4(len(lv))
    out = bytearray(pos)
    HEADER.pack_into(out, 0, MAGIC, VERSION, fmt, flags, width, height, depth, n, source, source_kind, 0, pal_off)
    struct.pack_into('<%dI' % n, out, HEADER.size, *offs)
    struct.pack_into('<%dI' % n, out, HEADER.size + 4 * n, *(len(lv) for lv in levels))
    if palette is not None:
        out[pal_off:pal_off + 1024] = palette
    for o, lv in zip(offs, levels):
        out[o:o + len(lv)] = lv
    return bytes(out)


def unpack(b):
    """-> dict(format, flags, width, height, depth, levels=[memoryview...], palette, source, sourceKind)."""
    if len(b) < HEADER.size:
        raise ValueError('short rtex')
    magic, ver, fmt, flags, w, h, d, n, src, kind, _, pal_off = HEADER.unpack_from(b, 0)
    if magic != MAGIC:
        raise ValueError('not an rtex file')
    if ver != VERSION:
        raise ValueError('rtex version %d' % ver)
    if fmt not in FORMATS:
        raise ValueError('rtex format %d' % fmt)
    offs = struct.unpack_from('<%dI' % n, b, HEADER.size)
    sizes = struct.unpack_from('<%dI' % n, b, HEADER.size + 4 * n)
    mv = memoryview(b)
    levels = []
    for i, (o, s) in enumerate(zip(offs, sizes)):
        lw, lh, ld = level_dims(w, h, d, i)
        if s != level_size(fmt, lw, lh, ld) or o + s > len(b) or o % 4:
            raise ValueError('rtex level %d out of bounds' % i)
        levels.append(mv[o:o + s])
    palette = bytes(mv[pal_off:pal_off + 1024]) if pal_off else None
    return dict(format=fmt, formatName=FORMATS[fmt], flags=flags, width=w, height=h, depth=d, levels=levels,
                palette=palette, source=src, sourceKind=kind)
