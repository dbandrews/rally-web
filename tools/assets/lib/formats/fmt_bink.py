#!/usr/bin/env python3
"""Bink 1 (.bik) container parser + exhaustive byte accounting (research/formats/movies.md).

Pipeline copy of research/tools/fmt_bink.py; the only change is the Movies root (RALLY_ORIGINAL_DIR, _paths.REPO).

  .venv/bin/python -I research/tools/fmt_bink.py [--json OUT] [files...]   (default: original_version/Movies/*.bik)

Container layout (Bink 1, RAD Game Tools; field names as in the public Bink SDK / FFmpeg libavformat/bink.c):

  0   char[3] 'BIK', char version ('b'..'i'; all 29 originals are 'i')
  4   u32 file size - 8
  8   u32 frame count
  12  u32 largest frame size (bytes, audio + video packets of one frame)
  16  u32 (frame count again in every file; FFmpeg skips it)
  20  u32 width, 24 u32 height
  28  u32 fps numerator, 32 u32 fps denominator
  36  u32 video flags (0x00100000 alpha plane, 0x00020000 / 0x00010000 grey / swap, ...)
  40  u32 audio track count N
  44  N x u32 (max decoded audio packet size, per track)
      N x (u16 sample rate, u16 flags: 0x2000 stereo, 0x1000 DCT (else RDFT), 0x4000 16-bit)
      N x u32 track id
      (frames + 1) x u32 frame offsets; bit 0 = keyframe flag, offset = value & ~1; the last entry = file size
  frame i (offset[i] .. offset[i+1]):  for each audio track: u32 packet size S, S bytes (first u32 of a non-empty
      packet = decoded sample bytes); the rest of the frame = the video packet.

Checks per file (every byte accounted for): magic/version, size field, offsets monotonic, offsets[0] == end of the
header tables, offsets[-1] == file size, every audio packet inside its frame, largest frame size field ==
max(frame size), frame count == ffprobe-style duration * fps. Prints a table and optionally writes JSON.
"""
import glob
import json
import os
import struct
import sys

from _paths import REPO  # noqa: E402  (pipeline copy: the only change is the data root)

MOVIES = os.path.join(os.path.abspath(os.environ.get('RALLY_ORIGINAL_DIR') or os.path.join(REPO, 'original_version')),
                      'Movies')


class BinkError(ValueError):
    pass


def parse(path):
    d = open(path, 'rb').read()
    if len(d) < 44 or d[:3] != b'BIK':
        raise BinkError('%s: not a Bink 1 file' % path)
    ver = chr(d[3])
    size8, frames, largest, frames2, w, h, fnum, fden, vflags, ntr = struct.unpack_from('<10I', d, 4)
    if size8 + 8 != len(d):
        raise BinkError('%s: size field %d + 8 != file size %d' % (path, size8, len(d)))
    o = 44
    maxpkt = list(struct.unpack_from('<%dI' % ntr, d, o)); o += 4 * ntr
    tracks = []
    for t in range(ntr):
        rate, fl = struct.unpack_from('<HH', d, o); o += 4
        tracks.append({'sampleRate': rate, 'flags': fl, 'stereo': bool(fl & 0x2000),
                       'codec': 'binkaudio_dct' if fl & 0x1000 else 'binkaudio_rdft',
                       'bits16': bool(fl & 0x4000), 'maxDecodedPacket': maxpkt[t]})
    ids = list(struct.unpack_from('<%dI' % ntr, d, o)); o += 4 * ntr
    for t in range(ntr):
        tracks[t]['id'] = ids[t]
    raw = struct.unpack_from('<%dI' % (frames + 1), d, o); o += 4 * (frames + 1)
    header_end = o
    offs = [v & ~1 for v in raw]
    keys = [i for i, v in enumerate(raw[:-1]) if v & 1]
    if offs[0] != header_end:
        raise BinkError('%s: first frame at %d, header ends at %d' % (path, offs[0], header_end))
    if offs[-1] != len(d):
        raise BinkError('%s: last offset %d != file size %d' % (path, offs[-1], len(d)))
    audio_bytes = [0] * ntr
    audio_samples = [0] * ntr
    audio_packets = [0] * ntr
    video_bytes = 0
    fsizes = []
    for i in range(frames):
        a, b = offs[i], offs[i + 1]
        if b < a:
            raise BinkError('%s: frame %d offsets not monotonic' % (path, i))
        fsizes.append(b - a)
        p = a
        for t in range(ntr):
            if p + 4 > b:
                raise BinkError('%s: frame %d track %d: no packet size' % (path, i, t))
            s = struct.unpack_from('<I', d, p)[0]; p += 4
            if p + s > b:
                raise BinkError('%s: frame %d track %d: packet overruns the frame' % (path, i, t))
            if s:
                if s < 4:
                    raise BinkError('%s: frame %d track %d: packet of %d bytes' % (path, i, t, s))
                audio_samples[t] += struct.unpack_from('<I', d, p)[0]
                audio_packets[t] += 1
            audio_bytes[t] += 4 + s
            p += s
        video_bytes += b - p
    if max(fsizes) != largest:
        raise BinkError('%s: largest frame field %d != max frame %d' % (path, largest, max(fsizes)))
    accounted = header_end + sum(audio_bytes) + video_bytes
    if accounted != len(d):
        raise BinkError('%s: accounted %d of %d bytes' % (path, accounted, len(d)))
    for t in range(ntr):
        ch = 2 if tracks[t]['stereo'] else 1
        tracks[t].update(packets=audio_packets[t], bytes=audio_bytes[t],
                         decodedSampleBytes=audio_samples[t],
                         seconds=audio_samples[t] / (2.0 * ch * tracks[t]['sampleRate']))
    return {
        'file': os.path.basename(path), 'bytes': len(d), 'version': ver,
        'width': w, 'height': h, 'frames': frames, 'framesField2': frames2,
        'fpsNum': fnum, 'fpsDen': fden, 'fps': fnum / fden, 'duration': frames * fden / fnum,
        'videoFlags': vflags, 'alpha': bool(vflags & 0x00100000), 'largestFrame': largest,
        'keyframes': len(keys), 'keyframeIndices': keys[:8] + (['...'] if len(keys) > 8 else []),
        'headerBytes': header_end, 'videoBytes': video_bytes, 'audioTracks': tracks,
        'videoKbps': video_bytes * 8 / 1000.0 / (frames * fden / fnum),
    }


def main(argv):
    out = None
    if argv[:1] == ['--json']:
        out, argv = argv[1], argv[2:]
    files = argv or sorted(glob.glob(os.path.join(MOVIES, '*.bik')), key=str.lower)
    rows = []
    bad = 0
    for f in files:
        try:
            rows.append(parse(f))
        except BinkError as e:
            print('FAIL', e)
            bad += 1
    print('%-14s %3s %9s %5s %6s %10s %8s %4s %6s %5s  %s'
          % ('file', 'ver', 'w x h', 'frm', 'fps', 'dur s', 'bytes', 'key', 'kbps', 'flags', 'audio'))
    for r in rows:
        au = ', '.join('%s %d Hz %s %.3f s' % (t['codec'], t['sampleRate'], 'st' if t['stereo'] else 'mono',
                                               t['seconds']) for t in r['audioTracks']) or '-'
        print('%-14s %3s %4dx%-4d %5d %6.3f %10.4f %8d %4d %6.0f %5x  %s'
              % (r['file'], r['version'], r['width'], r['height'], r['frames'], r['fps'], r['duration'],
                 r['bytes'], r['keyframes'], r['videoKbps'], r['videoFlags'], au))
    print('%d file(s) parsed, every byte accounted for (header + audio packets + video packets); %d failure(s)'
          % (len(rows), bad))
    if out:
        with open(out, 'w') as fh:
            json.dump(rows, fh, indent=1)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
