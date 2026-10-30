#!/usr/bin/env python3
"""Reader for the original game "Refractor2 FinkelArchive 1.0" (.rff) files.

Format (reverse engineered from original_desktop_version.exe, image base 0x400000):

  Header (0x28 bytes, read by FUN_005c81c0):
    0x00  char[0x20]  magic "Refractor2 FinkelArchive 1.0" (NUL padded)
    0x20  u32         directory offset
    0x24  u32         archive version, stored at archive+0x54
                        1 -> payload is Blowfish-encrypted only
                        2 -> payload is Blowfish-encrypted zlib stream
                      (read path FUN_005c79a0 / vtable slot 7 of FinkelArchive
                       vtable 0x812f94; listing path 0x5c7b60 reports size =
                       unpackedSize for version 2, packedSize for 0/1)
  Directory (plaintext, at dirOffset):
    u32 count
    count x { u32 nameLen; char name[nameLen];
              u32 packedSize, unpackedSize, dataOffset, attrs, ftLow, ftHigh }
    attrs is 0x01 / 0x21 in shipped archives = Win32 FILE_ATTRIBUTE_READONLY
    (0x1) | FILE_ATTRIBUTE_ARCHIVE (0x20); it is NOT consulted by the read path.
    ftLow/ftHigh look like a FILETIME (copied into all three find-data times
    by 0x5c7b60); always 0 in shipped archives.

  Payload at dataOffset, length align8(packedSize):
    1. Blowfish ECB decrypt (standard pi-derived P/S tables at 0x835168 /
       0x8351b0, standard key schedule FUN_00799cf0, 16 rounds FUN_00799c00),
       8-byte key 72 03 17 f4 12 43 92 88 (built on stack at 0x5c8097 before
       key schedule into global cipher object 0x91e7c0). The two 32-bit block
       halves are loaded/stored LITTLE-endian (native x86 dword access),
       unlike the big-endian convention of reference Blowfish.
    2. version 2: zlib uncompress() (FUN_00799e60, zlib 1.1.3, normal zlib
       header) of the first packedSize decrypted bytes -> unpackedSize bytes.
       version 1: the first packedSize decrypted bytes are the file.

Usage:
  python3 -I rff.py list <archive>
  python3 -I rff.py extract <archive> <outdir> [--include-regex RE]
                            [--exclude-regex RE] [--text-only]
  python3 -I rff.py cat <archive> <name>
"""
import os
import re
import struct
import sys
import zlib

MAGIC = b"Refractor2 FinkelArchive 1.0"
KEY = bytes([0x72, 0x03, 0x17, 0xF4, 0x12, 0x43, 0x92, 0x88])


# --------------------------------------------------------------------------
# Blowfish tables: the standard initial P-array and S-boxes are the hex
# digits of the fractional part of pi (18 + 4*256 = 1042 words).
# --------------------------------------------------------------------------
def _pi_words(nwords):
    ndigits = nwords * 8  # hex digits needed
    guard = 64
    bits = ndigits * 4 + guard
    one = 1 << bits

    def arctan_inv(x):
        # arctan(1/x) in fixed point
        total = term = one // x
        x2 = x * x
        n = 1
        sign = -1
        while term:
            term //= x2
            total += sign * (term // (2 * n + 1))
            sign = -sign
            n += 1
        return total

    pi = 16 * arctan_inv(5) - 4 * arctan_inv(239)
    frac = pi - (3 << bits)
    frac >>= guard  # now frac / 16**ndigits
    words = []
    for i in range(nwords):
        shift = (nwords - 1 - i) * 32
        words.append((frac >> shift) & 0xFFFFFFFF)
    return words


_TABLES = None


def _tables():
    global _TABLES
    if _TABLES is None:
        w = _pi_words(18 + 1024)
        assert w[0] == 0x243F6A88 and w[17] == 0x8979FB1B, "pi P-array mismatch"
        assert w[-1] == 0x3AC372E6, "pi S-box mismatch"
        _TABLES = (w[:18], [w[18 + 256 * i: 18 + 256 * (i + 1)] for i in range(4)])
    return _TABLES


class Blowfish:
    def __init__(self, key):
        P0, S0 = _tables()
        self.P = list(P0)
        self.S = [list(s) for s in S0]
        # key schedule (FUN_00799cf0): key bytes packed big-endian, cyclic
        j = 0
        for i in range(18):
            d = 0
            for _ in range(4):
                d = ((d << 8) | key[j]) & 0xFFFFFFFF
                j = (j + 1) % len(key)
            self.P[i] ^= d
        L = R = 0
        for i in range(0, 18, 2):
            L, R = self._enc(L, R)
            self.P[i], self.P[i + 1] = L, R
        for s in range(4):
            for i in range(0, 256, 2):
                L, R = self._enc(L, R)
                self.S[s][i], self.S[s][i + 1] = L, R

    def _enc(self, L, R):
        P = self.P
        S0, S1, S2, S3 = self.S
        for i in range(16):
            L ^= P[i]
            R ^= ((((S0[L >> 24] + S1[(L >> 16) & 0xFF]) & 0xFFFFFFFF) ^ S2[(L >> 8) & 0xFF]) + S3[L & 0xFF]) & 0xFFFFFFFF
            L, R = R, L
        L, R = R, L
        R ^= P[16]
        L ^= P[17]
        return L, R

    def decrypt_ecb_le(self, data):
        """Decrypt len(data)//8 blocks; block halves are little-endian u32."""
        n = len(data) // 8
        if n == 0:
            return b""
        words = list(struct.unpack("<%dI" % (2 * n), data[: 8 * n]))
        P = self.P
        S0, S1, S2, S3 = self.S
        p17, p16, p15, p14, p13, p12, p11, p10, p9, p8, p7, p6, p5, p4, p3, p2, p1, p0 = P[::-1]
        rk = (p17, p16, p15, p14, p13, p12, p11, p10, p9, p8, p7, p6, p5, p4, p3, p2)
        out = [0] * (2 * n)
        M = 0xFFFFFFFF
        for b in range(0, 2 * n, 2):
            L = words[b]
            R = words[b + 1]
            for k in rk:
                L ^= k
                R ^= ((((S0[L >> 24] + S1[(L >> 16) & 0xFF]) & M) ^ S2[(L >> 8) & 0xFF]) + S3[L & 0xFF]) & M
                L, R = R, L
            out[b] = R ^ p0
            out[b + 1] = L ^ p1
        return struct.pack("<%dI" % (2 * n), *out)


_BF = None


def cipher():
    global _BF
    if _BF is None:
        _BF = Blowfish(KEY)
    return _BF


# --------------------------------------------------------------------------
class Entry:
    __slots__ = ("name", "packed", "unpacked", "offset", "attrs", "ft_lo", "ft_hi")

    def __init__(self, name, packed, unpacked, offset, attrs, ft_lo, ft_hi):
        self.name = name
        self.packed = packed
        self.unpacked = unpacked
        self.offset = offset
        self.attrs = attrs
        self.ft_lo = ft_lo
        self.ft_hi = ft_hi


class Archive:
    def __init__(self, path):
        self.path = path
        self.f = open(path, "rb")
        hdr = self.f.read(0x28)
        if len(hdr) != 0x28 or not hdr.startswith(MAGIC):
            raise ValueError("%s: not a Refractor2 FinkelArchive" % path)
        self.dir_offset, self.version = struct.unpack_from("<II", hdr, 0x20)
        self.f.seek(self.dir_offset)
        (count,) = struct.unpack("<I", self.f.read(4))
        self.entries = []
        for _ in range(count):
            (nl,) = struct.unpack("<I", self.f.read(4))
            name = self.f.read(nl).decode("latin-1")
            vals = struct.unpack("<6I", self.f.read(24))
            self.entries.append(Entry(name, *vals))
        self.by_name = {e.name.lower(): e for e in self.entries}

    def read_raw(self, e):
        self.f.seek(e.offset)
        return self.f.read((e.packed + 7) & ~7)

    def read(self, e):
        raw = self.read_raw(e)
        dec = cipher().decrypt_ecb_le(raw)
        if self.version == 1:
            return dec[: e.packed]
        data = zlib.decompress(dec[: e.packed])
        if len(data) != e.unpacked:
            raise ValueError("%s: size %d != %d" % (e.name, len(data), e.unpacked))
        return data

    def close(self):
        self.f.close()


def cmd_list(path):
    a = Archive(path)
    print("# %s version=%d entries=%d dirOffset=0x%x" % (path, a.version, len(a.entries), a.dir_offset))
    print("# packed\tunpacked\toffset\tattrs\tname")
    for e in a.entries:
        print("%d\t%d\t0x%x\t0x%x\t%s" % (e.packed, e.unpacked, e.offset, e.attrs, e.name))


def _safe_join(outdir, name):
    parts = [p for p in re.split(r"[\\/]+", name) if p not in ("", ".", "..")]
    dest = os.path.join(outdir, *parts)
    if not os.path.abspath(dest).startswith(os.path.abspath(outdir) + os.sep):
        raise ValueError("unsafe path: %r" % name)
    return dest


def looks_text(data):
    head = data[:8192]
    if not head:
        return True
    if b"\0" in head:
        return False
    ok = sum(1 for c in head if c in (9, 10, 13) or 32 <= c < 127 or c >= 160)
    return ok / len(head) >= 0.95


def cmd_extract(path, outdir, include=None, exclude=None, text_only=False):
    a = Archive(path)
    skipped = []
    inc = re.compile(include, re.I) if include else None
    exc = re.compile(exclude, re.I) if exclude else None
    n = 0
    total = 0
    for e in a.entries:
        if inc and not inc.search(e.name):
            continue
        if exc and exc.search(e.name):
            continue
        data = a.read(e)
        if text_only and not looks_text(data):
            skipped.append(e.name)
            continue
        dest = _safe_join(outdir, e.name)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fo:
            fo.write(data)
        n += 1
        total += len(data)
    print("extracted %d files (%d bytes) from %s -> %s" % (n, total, path, outdir))
    for name in skipped:
        print("skipped (binary content): %s" % name)


def cmd_cat(path, name):
    a = Archive(path)
    e = a.by_name.get(name.lower())
    if e is None:
        sys.exit("not found: %s" % name)
    sys.stdout.buffer.write(a.read(e))


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    cmd = argv[1]
    if cmd == "list" and len(argv) == 3:
        cmd_list(argv[2])
    elif cmd == "extract" and len(argv) >= 4:
        include = exclude = None
        text_only = False
        rest = argv[4:]
        i = 0
        while i < len(rest):
            if rest[i] == "--text-only":
                text_only = True
                i += 1
            elif rest[i] == "--include-regex":
                include = rest[i + 1]
                i += 2
            elif rest[i] == "--exclude-regex":
                exclude = rest[i + 1]
                i += 2
            else:
                sys.exit("unknown option %s" % rest[i])
        cmd_extract(argv[2], argv[3], include, exclude, text_only)
    elif cmd == "cat" and len(argv) == 4:
        cmd_cat(argv[2], argv[3])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
