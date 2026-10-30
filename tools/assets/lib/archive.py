"""Original-archive layer: fast reads of the .rff archives + the extracted cache.

  ARCHIVES   original_version/archives/*.rff and original_version/archives/tracks/*.rff
             (override the original_version root with RALLY_ORIGINAL_DIR)
  CACHE      <repo>/.cache/original/<archive>/...  -- the SAME layout as research/full, so the copied
             parsers in lib/formats work on paths unchanged (override with RALLY_ORIG_CACHE)

Archive names are the .rff basenames without extension, exactly as research/full names its folders:
Audio, Cars, LocaleEnglish, Menu, Misc, common, fogzor, corsica1f, ..., rallycross3r.

Reading: `ArchiveSet.read(name, member)` decrypts one entry straight from the .rff (no cache needed).
Extraction: `ensure_extracted(names)` extracts whole archives into the cache once; a stamp per archive
(.cache/stamps/<name>.json: size + mtime of the .rff + layout version) makes later runs a no-op. Each
extraction holds a per-archive file lock (.cache/locks/<name>.lock), writes into .cache/tmp/ and renames
the finished folder into place, so concurrent build runs never see a half-extracted archive.

The .rff format (Blowfish ECB with little-endian block halves + zlib) is documented in lib/rff.py (a copy
of the verified research/tools/rff.py). This module adds a numpy-vectorised decrypt that is bit-identical
to rff.Blowfish.decrypt_ecb_le (checked by `build.py --selftest`), ~20-40x faster.
"""
import json
import os
import re
import shutil
import time
import zlib
from collections import OrderedDict

import numpy as np

import rff

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
ORIGINAL = os.path.abspath(os.environ.get('RALLY_ORIGINAL_DIR') or os.path.join(REPO, 'original_version'))
CACHE_ROOT = os.path.join(REPO, '.cache')
FULL = os.path.abspath(os.environ.get('RALLY_ORIG_CACHE') or os.path.join(CACHE_ROOT, 'original'))
STAMPS = os.path.join(CACHE_ROOT, 'stamps')
LOCKS = os.path.join(CACHE_ROOT, 'locks')
TMP = os.path.join(CACHE_ROOT, 'tmp')
LAYOUT_VERSION = 1

# lookup precedence for a virtual path that exists in several archives (none do in the shipped data;
# the stage's own archive is always tried first by Vfs when a stage is given)
GLOBAL_ORDER = ('Misc', 'Cars', 'Menu', 'LocaleEnglish', 'Audio', 'common', 'fogzor')


def archive_paths(original=None):
    """OrderedDict name -> .rff path: the global archives (GLOBAL_ORDER first), then the tracks sorted."""
    root = os.path.join(original or ORIGINAL, 'archives')
    found = {}
    for d in (root, os.path.join(root, 'tracks')):
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if f.lower().endswith('.rff'):
                found[f[:-4]] = os.path.join(d, f)
    out = OrderedDict()
    for n in GLOBAL_ORDER:
        if n in found:
            out[n] = found.pop(n)
    for n in sorted(found):
        out[n] = found[n]
    return out


def have_originals(original=None):
    return bool(archive_paths(original))


# ------------------------------------------------------------------------------------------ decryption
class NpBlowfish:
    """Vectorised rff.Blowfish.decrypt_ecb_le: every 8-byte block is independent (ECB), so all blocks of a
    buffer go through the 16 rounds as numpy uint32 arrays (uint32 array arithmetic wraps mod 2^32)."""

    CHUNK = 1 << 20     # blocks per pass (bounded temporaries: ~8 MB per array)

    def __init__(self, bf=None):
        bf = bf or rff.cipher()
        self.P = np.array(bf.P, np.uint32)
        self.S = [np.array(s, np.uint32) for s in bf.S]

    def decrypt(self, data):
        n = len(data) // 8
        if n == 0:
            return b''
        src = np.frombuffer(data, '<u4', 2 * n)
        out = np.empty(2 * n, '<u4')
        P = self.P
        S0, S1, S2, S3 = self.S
        for a in range(0, n, self.CHUNK):
            b = min(n, a + self.CHUNK)
            L = src[2 * a:2 * b:2].astype(np.uint32)
            R = src[2 * a + 1:2 * b:2].astype(np.uint32)
            for i in range(17, 1, -1):          # rk = P17 .. P2 (rff.Blowfish.decrypt_ecb_le)
                L ^= P[i]
                F = S0[L >> 24]
                F += S1[(L >> 16) & 0xFF]
                F ^= S2[(L >> 8) & 0xFF]
                F += S3[L & 0xFF]
                R ^= F
                L, R = R, L
            out[2 * a:2 * b:2] = R ^ P[0]
            out[2 * a + 1:2 * b:2] = L ^ P[1]
        return out.tobytes()


_NPBF = None


def np_cipher():
    global _NPBF
    if _NPBF is None:
        _NPBF = NpBlowfish()
    return _NPBF


def _inflate(arch, e, dec):
    if arch.version == 1:
        return bytes(dec[:e.packed])
    data = zlib.decompress(dec[:e.packed])
    if len(data) != e.unpacked:
        raise ValueError('%s: size %d != %d' % (e.name, len(data), e.unpacked))
    return data


class FastArchive(rff.Archive):
    """rff.Archive with the numpy decrypt. read(e) is a drop-in replacement for rff.Archive.read(e)."""

    def read(self, e):
        return _inflate(self, e, np_cipher().decrypt(self.read_raw(e)))

    def iter_all(self):
        """Yield (entry, data) for every entry: the whole payload region is decrypted in one pass (ECB blocks
        are aligned to the same 8-byte grid as the file, and every entry starts 8-aligned)."""
        self.f.seek(0)
        blob = self.f.read(self.dir_offset)
        start = min((e.offset for e in self.entries), default=self.dir_offset)
        start -= start % 8
        dec = np_cipher().decrypt(memoryview(blob)[start:])
        mv = memoryview(dec)
        for e in self.entries:
            o = e.offset - start
            if o % 8:
                # not on the shared grid: decrypt this entry on its own
                yield e, self.read(e)
                continue
            yield e, _inflate(self, e, mv[o:o + ((e.packed + 7) & ~7)])


# ------------------------------------------------------------------------------------------ archive set
def safe_member_path(root, name):
    """research/tools/rff.py _safe_join: archive member -> path under root (rejects '..')."""
    parts = [p for p in re.split(r'[\\/]+', name) if p not in ('', '.', '..')]
    dest = os.path.join(root, *parts)
    if not os.path.abspath(dest).startswith(os.path.abspath(root) + os.sep):
        raise ValueError('unsafe path: %r' % name)
    return dest


class ArchiveSet:
    """All original archives. Entries are read straight from the .rff files (per-process handles, so it is
    safe to use after fork); the extracted cache is preferred when it is valid."""

    def __init__(self, original=None, cache=None):
        self.paths = archive_paths(original)
        self.cache = cache or FULL
        self._open = {}
        self._pid = os.getpid()
        self._valid = set()                   # archives whose cache stamp was checked valid (positive memo)

    def names(self):
        return list(self.paths)

    def open(self, name):
        if os.getpid() != self._pid:          # forked worker: never share file offsets with the parent
            self._open = {}
            self._pid = os.getpid()
        a = self._open.get(name)
        if a is None:
            a = self._open[name] = FastArchive(self.paths[name])
        return a

    def entries(self, name):
        return self.open(name).entries

    def read(self, name, member):
        """Bytes of `member` (exact archive spelling or any case) from archive `name`."""
        cached = self.cache_file(name, member)
        if cached:
            with open(cached, 'rb') as f:
                return f.read()
        a = self.open(name)
        e = a.by_name.get(member.replace('\\', '/').lower())
        if e is None:
            raise KeyError('%s: no member %s' % (name, member))
        return a.read(e)

    def cache_file(self, name, member):
        """Path of `member` in the extracted cache, or None when the archive is not (validly) extracted."""
        if name not in self._valid:
            if not is_extracted(name, self.paths.get(name), self.cache):
                return None
            self._valid.add(name)
        p = safe_member_path(os.path.join(self.cache, name), member)
        return p if os.path.isfile(p) else None


# ------------------------------------------------------------------------------------------ extraction
def _stamp_of(rff_path):
    st = os.stat(rff_path)
    return {'layout': LAYOUT_VERSION, 'size': st.st_size, 'mtime_ns': st.st_mtime_ns}


def _stamp_path(name, cache):
    # stamps live next to the cache root, never inside it (the cache keeps the research/full layout exactly)
    return os.path.join(os.path.dirname(cache), 'stamps', os.path.basename(cache), name + '.json')


def is_extracted(name, rff_path=None, cache=None):
    cache = cache or FULL
    rff_path = rff_path or archive_paths().get(name)
    if not rff_path or not os.path.isdir(os.path.join(cache, name)):
        return False
    try:
        with open(_stamp_path(name, cache)) as f:
            got = json.load(f)
    except (OSError, ValueError):
        return False
    want = _stamp_of(rff_path)
    return all(got.get(k) == v for k, v in want.items())


class _Lock:
    """Exclusive inter-process lock on a file (fcntl.flock; a no-op where fcntl is unavailable)."""

    def __init__(self, path):
        self.path = path
        self.f = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.f = open(self.path, 'a+')
        try:
            import fcntl
            fcntl.flock(self.f.fileno(), fcntl.LOCK_EX)
        except ImportError:
            pass
        return self

    def __exit__(self, *exc):
        try:
            import fcntl
            fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
        except ImportError:
            pass
        self.f.close()


def extract(name, rff_path=None, cache=None, log=None):
    """Extract one archive into <cache>/<name>/ (atomic, locked, stamped). Returns the folder."""
    cache = cache or FULL
    rff_path = rff_path or archive_paths()[name]
    final = os.path.join(cache, name)
    base = os.path.dirname(cache)
    with _Lock(os.path.join(base, 'locks', os.path.basename(cache), name + '.lock')):
        if is_extracted(name, rff_path, cache):
            return final
        t0 = time.time()
        tmp_root = os.path.join(base, 'tmp')
        os.makedirs(tmp_root, exist_ok=True)
        os.makedirs(cache, exist_ok=True)
        tmp = os.path.join(tmp_root, '%s.%d' % (name, os.getpid()))
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        a = FastArchive(rff_path)
        n = total = 0
        try:
            for e, data in a.iter_all():
                dest = safe_member_path(tmp, e.name)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, 'wb') as fo:
                    fo.write(data)
                n += 1
                total += len(data)
        finally:
            a.close()
        if os.path.exists(final):
            old = os.path.join(tmp_root, '%s.old.%d' % (name, os.getpid()))
            os.rename(final, old)
            shutil.rmtree(old, ignore_errors=True)
        os.rename(tmp, final)
        sp = _stamp_path(name, cache)
        os.makedirs(os.path.dirname(sp), exist_ok=True)
        stamp = dict(_stamp_of(rff_path), entries=n, bytes=total, seconds=round(time.time() - t0, 2))
        with open(sp + '.tmp', 'w') as f:
            json.dump(stamp, f)
        os.replace(sp + '.tmp', sp)
        if log:
            log('extracted %-14s %5d files %8.1f MB in %.1f s' % (name, n, total / 1e6, time.time() - t0))
        return final


def _extract_job(args):
    name, path, cache = args
    extract(name, path, cache, log=print)
    return name


def ensure_extracted(names=None, jobs=None, cache=None, log=print):
    """Make sure every archive in `names` (default: all) is extracted into the cache. Returns the cache root.
    Archives are extracted in parallel (largest first); valid ones are skipped after a stat + stamp check."""
    cache = cache or FULL
    paths = archive_paths()
    names = list(paths) if names is None else list(names)
    missing = [n for n in names if n not in paths]
    if missing:
        raise KeyError('unknown archives: %s' % ', '.join(missing))
    todo = [n for n in names if not is_extracted(n, paths[n], cache)]
    if not todo:
        return cache
    todo.sort(key=lambda n: -os.path.getsize(paths[n]))
    jobs = max(1, min(jobs or os.cpu_count() or 1, len(todo)))
    if log:
        mb = sum(os.path.getsize(paths[n]) for n in todo) / 1e6
        log('extracting %d archive(s) (%.0f MB packed) into %s with %d job(s) ...'
            % (len(todo), mb, os.path.relpath(cache, REPO), jobs))
    work = [(n, paths[n], cache) for n in todo]
    if jobs == 1:
        for w in work:
            _extract_job(w)
    else:
        import multiprocessing as mp
        ctx = mp.get_context('fork') if hasattr(os, 'fork') else mp.get_context()
        with ctx.Pool(jobs) as pool:
            for _ in pool.imap_unordered(_extract_job, work):
                pass
    return cache

