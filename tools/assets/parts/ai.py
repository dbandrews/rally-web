"""ai part: the original AI's per-stage data and the AiTimes schedules (research/formats/ai.md sections 3-4, docs/orig/ai.md).

  npm run assets -- --stages all --parts ai

Outputs

  stages/<id>/ai.json     the stage's AiData posts (AIFiles/AiData.con, parsed by lib/formats/fmt_aidata.py) plus the
                          per-5-m "sample" table the spline manager keeps (AIFiles/side.rsd: distance, left and right
                          clearance of the road at that point) with the AiData post each sample inherits:

                            posts   [{lapDist, recSpeed, curveSpdScale, curveCut, lookAheadDist, thresholdScale}] sorted
                                    (recSpeed in AiData units, m/s).
                            samples {n, step, dist[], left[], right[], post[]}  post[i] = index into `posts` of the post
                                    the sample inherits, or -1 (the exe's loop FUN_004f0ea0 @ 0x4f0f10-0x4f1007: the
                                    persisted post index advances at most one post per sample, a sample takes a post when
                                    its distance >= the post's lapDist; samples before the first post carry zeros).

  global/aitimes.json     every AiTimes file (Misc/aitimes, 360): {laps, splits[]} keyed by the lower-cased relative path
                          ('events/am/iceracing2r/astra', 'hillclimb1bf/<car>'), compact.

The side.rsd layout was decoded from the data: u32 count, then `count` 16-byte records {u32 0, f32 dist, f32 left,
f32 right}, dist = 5 m steps from 0 [D, all 48 files].
"""
import os
import struct
import sys

PART = 'ai'
VERSION = 1

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib', 'formats'))
import fmt_aidata  # noqa: E402
import fmt_aitimes  # noqa: E402


def _f32(x):
    """The value as printed with 9 significant digits (round-trips a float32)."""
    return float('%.9g' % x)


def read_rsd(data):
    """-> (dist[], left[], right[]) of a side.rsd; raises on a malformed file."""
    n = struct.unpack_from('<I', data, 0)[0]
    if len(data) != 4 + 16 * n:
        raise ValueError('side.rsd: %d bytes for %d records' % (len(data), n))
    dist, left, right = [], [], []
    for i in range(n):
        z, d, l, r = struct.unpack_from('<Ifff', data, 4 + 16 * i)
        if z != 0:
            raise ValueError('side.rsd record %d: leading word %d != 0' % (i, z))
        dist.append(d)
        left.append(l)
        right.append(r)
    return dist, left, right


def sample_posts(dist, post_lapdist):
    """The post index each sample inherits: FUN_004f0ea0 0x4f0f10-0x4f1007 (persisted index, <= 1 post per sample)."""
    n_posts = len(post_lapdist)
    out = []
    idx = 0
    chosen = -1
    for d in dist:
        p = idx
        while p < n_posts:
            if d >= post_lapdist[p]:          # fcomp: not (sampleDist < post.lapDist)
                chosen = p
                idx = p + 1
                break
            p += 1
        out.append(chosen)
    return out


def build_stage(ctx, stage):
    p_con = ctx.vfs.real_path(stage.vpath('AiFiles/AiData.con'))
    p_rsd = ctx.vfs.real_path(stage.vpath('AiFiles/side.rsd'))
    if not p_con or not p_rsd:
        ctx.warn('no AiFiles (AiData.con / side.rsd) in %s' % stage.archive)
        return
    posts, errors = fmt_aidata.parse(p_con)
    if errors or not posts:
        raise ValueError('AiData.con: %s' % '; '.join(errors) or 'no posts')
    posts.sort(key=lambda q: q['lapDist'])
    with open(p_rsd, 'rb') as fh:
        dist, left, right = read_rsd(fh.read())
    step = _f32(dist[1] - dist[0]) if len(dist) > 1 else 5.0
    out = {
        'version': VERSION, 'stageId': stage.id,
        'posts': [dict(lapDist=_f32(q['lapDist']), recSpeed=_f32(q['recSpeed']), curveSpdScale=_f32(q['curveSpd']),
                       curveCut=_f32(q['curveCut']), lookAheadDist=_f32(q['lookAhead']),
                       thresholdScale=_f32(q['threshold'])) for q in posts],
        'samples': {'n': len(dist), 'step': step, 'dist': [_f32(x) for x in dist], 'left': [_f32(x) for x in left],
                    'right': [_f32(x) for x in right], 'post': sample_posts(dist, [q['lapDist'] for q in posts])},
    }
    ctx.out.commit(out)
    ctx.log('%d posts, %d samples' % (len(posts), len(dist)))


def build_global(ctx):
    files = [v for v in ctx.vfs.files_under('aitimes') if not v.endswith('/')]
    out = {}
    bad = 0
    for v in files:
        path = ctx.vfs.real_path(v)
        laps, times, errors = fmt_aitimes.parse(path)
        if errors or not times or not all(a < b for a, b in zip(times, times[1:])):
            ctx.warn('%s: %s' % (v, errors or 'not increasing'))
            bad += 1
            continue
        out[v[len('aitimes/'):]] = {'laps': laps, 'splits': [_f32(t) for t in times]}
    if bad:
        raise ValueError('%d AiTimes files failed to parse' % bad)
    ctx.out.commit({'version': VERSION, 'count': len(out), 'times': out})
    ctx.log('%d AiTimes files' % len(out))
