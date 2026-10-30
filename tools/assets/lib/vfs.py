"""The engine's virtual file system and lookup rules (research/formats/objects.md §1.2, textures.md §2.2).

* Every .rff archive is mounted at the same virtual root; script/texture paths are case-insensitive and
  use '/'.  `Vfs` is the lower-cased union of all archive directories (read straight from the .rff
  directories, no extraction needed).  A path present in several archives (none is, in the shipped
  data) resolves in this order: the given stage's archive, then archive.GLOBAL_ORDER, then the tracks.
* Level folder of a stage: `track/<layout>/<forward|reverse>/` (stages.py).
* Texture names (`resolve_texture`), exactly as TextureManager FUN_006a70c0 / FUN_006a7280 +
  the level-load mount FUN_00486530:
    - the extension is stripped (cut at the last '.' of the last path component) - textures are keyed
      by name WITHOUT extension, the requested extension is never used;
    - `texture/X` is searched in the stage's `track/<layout>/<dir>/Texture/` first (the mounted alias),
      then in `texture/` (Misc.rff) -- the stage folder SHADOWS Misc/texture;
    - `track/...` is a level path (the stage archive), `menu/X` is Menu.rff then LocaleEnglish's
      `locale/english/menu/X`, anything else is a root path (Misc.rff for `font/`, `texture/`...);
    - per candidate folder the handler probe order is BMP < DDS < RCM < RTX < TGA (std::set of handler
      names): a DDS always wins over a TGA of the same name.
  `fmt_textures.resolve` (the verified research resolver) implements the same rules on the extracted
  tree; `build.py --selftest` checks that both agree.
"""
import os
import re
from collections import defaultdict

import archive as A

PROBE_ORDER = ('bmp', 'dds', 'rcm', 'rtx', 'tga')


def norm(p):
    """Engine-style virtual path: '\\' -> '/', lower case, no './', no doubled or leading '/'."""
    p = p.replace('\\', '/').strip().lower()
    while p.startswith('./'):
        p = p[2:]
    p = re.sub(r'/+', '/', p)
    return p.lstrip('/')


def strip_ext(name):
    """FUN_00510390 as the texture manager uses it: drop the extension of the last path component."""
    v = name.replace('\\', '/')
    last = v.rsplit('/', 1)[-1]
    return v.rsplit('.', 1)[0] if '.' in last else v


class Vfs:
    """Case-insensitive union of every archive. Keys are norm()-ed virtual paths."""

    def __init__(self, archives=None):
        self.archives = archives or A.ArchiveSet()
        self.order = self.archives.names()
        self.index = {}                 # vpath -> [(archive, entry name), ...] in precedence order
        self.dirs = defaultdict(set)    # vdir -> child names (lower case)
        for name in self.order:
            for e in self.archives.entries(name):
                v = norm(e.name)
                self.index.setdefault(v, []).append((name, e.name))
                parts = v.split('/')
                for i in range(1, len(parts)):
                    self.dirs['/'.join(parts[:i])].add(parts[i])
                self.dirs[''].add(parts[0])

    # ----------------------------------------------------------------------------------- lookups
    def find(self, vpath, prefer=None):
        """(archive, member) for a virtual path, or None. `prefer` = archive name tried first."""
        hits = self.index.get(norm(vpath))
        if not hits:
            return None
        if prefer:
            for h in hits:
                if h[0] == prefer:
                    return h
        return hits[0]

    def exists(self, vpath, prefer=None):
        return self.find(vpath, prefer) is not None

    def read(self, vpath, prefer=None):
        hit = self.find(vpath, prefer)
        if hit is None:
            raise FileNotFoundError(vpath)
        return self.archives.read(*hit)

    def read_text(self, vpath, prefer=None):
        return self.read(vpath, prefer).decode('latin-1')

    def listdir(self, vdir):
        return sorted(self.dirs.get(norm(vdir).rstrip('/'), ()))

    def files_under(self, vdir):
        """Every virtual file path below `vdir` (recursive), sorted."""
        d = norm(vdir).rstrip('/') + '/'
        return sorted(v for v in self.index if v.startswith(d))

    def real_path(self, vpath, prefer=None):
        """Path of the file in the extracted cache (archive.FULL/<archive>/<member>), extracting the archive
        on demand. Use this when handing a file to a copied parser that wants a filesystem path."""
        hit = self.find(vpath, prefer)
        if hit is None:
            return None
        name, member = hit
        A.ensure_extracted([name], log=None)
        return A.safe_member_path(os.path.join(A.FULL, name), member)

    # ----------------------------------------------------------------------------------- textures
    def texture_candidates(self, name, stage=None):
        """Folder-candidates (virtual, without extension) for an engine texture name, in lookup order."""
        base = strip_ext(name.strip())
        low = norm(base)
        out = []
        if low.startswith('texture/'):
            rest = low[len('texture/'):]
            if stage is not None:
                out.append((stage.archive, '%s/texture/%s' % (stage.level, rest)))
            out.append((None, 'texture/' + rest))
        elif low.startswith('track/'):
            out.append((None, low))
        elif low.startswith('menu/'):
            out.append((None, low))
            out.append((None, 'locale/english/' + low))
        else:
            out.append((None, low))
        return out

    def resolve_texture(self, name, stage=None):
        """Engine resolution of a texture name -> (archive, member) or None (see module doc)."""
        for prefer, cand in self.texture_candidates(name, stage):
            for ext in PROBE_ORDER:
                hit = self.find(cand + '.' + ext, prefer)
                if hit is not None and (prefer is None or hit[0] == prefer):
                    return hit
        return None
