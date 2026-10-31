#!/usr/bin/env python3
"""
fmt_font.py -- the original rally game's bitmap fonts: Misc/font/<Name>.dif (glyph table, text) + <Name>.tga (atlas).

The meme UI names a font by its .dif file ('Font' / 'Font handle' properties, e.g. "HelveticaNeue10.dif"); the
menu System resolves it through vt[0x80] (FUN_0054e2e0, cached by name) and the font loader FUN_00557720 parses the
.dif.  Spec: research/formats/meme.md section 7.

.dif layout [E FUN_00557720 / FUN_00557d10 / FUN_00557f80 / FUN_00557f00, D all 14 files]
    text, CRLF lines, sections introduced by a keyword line:
    "header"   version (int, 2 in every file), face name (line), atlasWidth (int), atlasHeight (int; read only when
               version >= 2, else = atlasWidth), lineHeight (int; 0 in the two Digital* fonts)
    "glyphs"   count, then count lines "code a b c d x0 y0 x1 y1" (tab- or space-separated):
               code   UTF-16 code unit (32 .. 8482)
               a,b,c  GDI-style ABC widths: left bearing, black-box width, right bearing; pen advance =
                      a + b + c [I].  b equals the atlas rect width x1-x0 for 2 931 of 3 721 glyphs; the
                      rest differ by a few texels (antialiased bitmap wider than the GDI box)    [D]
               d      glyph top above the baseline (pixels)                          [I: name from the data]
               x0,y0,x1,y1  atlas rectangle in texels (top-left origin)
    "kerning"  count, then count lines "first second amount" (pen x += amount between the pair)
.tga atlas: 8-bit grayscale (TGA type 3) coverage, white text tinted by the vertex colour.

Usage:
    .venv/bin/python -I tools/assets/lib/formats/fmt_font.py dump [--out research/formats/meme_fonts.json]
    .venv/bin/python -I tools/assets/lib/formats/fmt_font.py show HelveticaNeue10
"""
from __future__ import annotations

import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import FULL, REPO  # noqa: E402

FONT_DIR = os.path.join(FULL, 'Misc', 'font')


class FontError(Exception):
    pass


def _ints(line: str, n: int, where: str) -> list[int]:
    p = line.split()
    if len(p) != n:
        raise FontError('%s: expected %d fields, got %r' % (where, n, line))
    return [int(x) for x in p]


def parse(text: str, name: str = '?') -> dict:
    lines = [ln for ln in text.replace('\r', '').split('\n')]
    while lines and lines[-1] == '':
        lines.pop()
    i = 0
    out: dict = {'name': name, 'glyphs': {}, 'kerning': []}
    seen = []
    while i < len(lines):
        kw = lines[i].strip()
        i += 1
        if kw == '':
            continue
        seen.append(kw)
        if kw == 'header':
            out['version'] = int(lines[i]); i += 1
            out['face'] = lines[i]; i += 1
            out['atlasWidth'] = int(lines[i]); i += 1
            if out['version'] >= 2:
                out['atlasHeight'] = int(lines[i]); i += 1
            else:
                out['atlasHeight'] = out['atlasWidth']
            out['lineHeight'] = int(lines[i]); i += 1
        elif kw == 'glyphs':
            n = int(lines[i]); i += 1
            for k in range(n):
                code, a, b, c, d, x0, y0, x1, y1 = _ints(lines[i], 9, '%s glyph %d' % (name, k)); i += 1
                out['glyphs'][code] = {'a': a, 'b': b, 'c': c, 'd': d, 'rect': [x0, y0, x1, y1]}
            if len(out['glyphs']) != n:
                raise FontError('%s: duplicate glyph codes' % name)
        elif kw == 'kerning':
            n = int(lines[i]); i += 1
            for k in range(n):
                out['kerning'].append(_ints(lines[i], 3, '%s kerning %d' % (name, k))); i += 1
        else:
            raise FontError('%s: unknown section %r at line %d' % (name, kw, i))
    if 'version' not in out or not out['glyphs']:
        raise FontError('%s: missing header/glyphs (%s)' % (name, seen))
    return out


def tga_header(path: str) -> dict:
    with open(path, 'rb') as f:
        h = f.read(18)
    idl, cmt, typ, cmo, cml, cmd, xo, yo, w, hgt, bpp, desc = struct.unpack('<BBBHHBHHHHBB', h)
    return {'type': typ, 'width': w, 'height': hgt, 'bpp': bpp, 'topLeft': bool(desc & 0x20)}


def load(name: str) -> dict:
    base = name[:-4] if name.lower().endswith('.dif') else name
    # case-insensitive lookup, like the archive VFS
    files = {f.lower(): f for f in os.listdir(FONT_DIR)}
    dif = files.get(base.lower() + '.dif')
    if not dif:
        raise FontError('no font ' + name)
    with open(os.path.join(FONT_DIR, dif), 'rb') as f:
        font = parse(f.read().decode('latin-1'), dif[:-4])
    tga = files.get(base.lower() + '.tga')
    font['atlas'] = {'file': 'Misc/font/' + tga, **tga_header(os.path.join(FONT_DIR, tga))} if tga else None
    return font


def all_fonts() -> list[str]:
    return sorted(f[:-4] for f in os.listdir(FONT_DIR) if f.lower().endswith('.dif'))


def advance(font: dict, text: str) -> int:
    """Pen advance of a string in font pixels: sum(a+b+c) + kerning pairs [I: layout rule, see meme.md 7]."""
    kern = {(a, b): k for a, b, k in font['kerning']}
    x, prev = 0, None
    for ch in text:
        g = font['glyphs'].get(ord(ch))
        if g is None:
            continue
        if prev is not None:
            x += kern.get((prev, ord(ch)), 0)
        x += g['a'] + g['b'] + g['c']
        prev = ord(ch)
    return x


def _main(argv):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('cmd', choices=['dump', 'show'])
    ap.add_argument('names', nargs='*')
    ap.add_argument('--out', default=os.path.join(REPO, 'research', 'formats', 'meme_fonts.json'))
    a = ap.parse_args(argv)
    names = a.names or all_fonts()
    fonts = {n: load(n) for n in names}
    for n, f in fonts.items():
        print('%-16s v%d %-16s atlas %dx%d (tga %s) line %2d glyphs %3d kerning %3d' % (
            n, f['version'], f['face'], f['atlasWidth'], f['atlasHeight'],
            '%dx%d t%d' % (f['atlas']['width'], f['atlas']['height'], f['atlas']['type']) if f['atlas'] else '-',
            f['lineHeight'], len(f['glyphs']), len(f['kerning'])))
    if a.cmd == 'show':
        print(json.dumps(fonts, indent=1))
    else:
        with open(a.out, 'w') as fh:
            json.dump({'format': 'dif font', 'fonts': {n: {**f, 'glyphs': {str(k): v for k, v in f['glyphs'].items()}}
                                                       for n, f in fonts.items()}}, fh, separators=(',', ':'))
        print('wrote', a.out)
    return 0


if __name__ == '__main__':
    sys.exit(_main(sys.argv[1:]))
