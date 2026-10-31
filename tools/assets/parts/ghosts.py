"""ghosts part — the 30 shipped team ghosts (Misc.rff teamghosts/<Driver>_<Track>, ghost format "2.0"), the "Original
Racing Game Team" drivers' best runs (research/formats/ghosts.md §2.4, §8, docs/orig/ghosts.md).

Outputs (version 1):
  global/ghosts.json            the index: one entry per file {file, stageId, driver, name, car, time, splits, frames,
                                bytes} (time = the last split, the ghost's total) and `heights` = Game.createTrack's H
                                for all 48 stages (the world y offset: ghost states are in the WORLD frame,
                                sim = world - (2048, H, 2048), src/game/ghosts/frame.ts)
  global/ghosts/<file>.bin      the original files byte for byte (incl. the 20-byte trailer the loader never reads)

26 of the 48 stages have at least one team ghost; the other 22 have none (research/formats/ghosts.md §8). The race side is
src/game/ghosts/team.ts. Run:  npm run assets -- --parts ghosts   (the global phase; build.py is not touched).
"""
import os
import re

import fmt_ghost as G
import stages as S

PART = 'ghosts'
VERSION = 1

FILE_RE = re.compile(r'^([A-Za-z]+)_([A-Za-z]+?)(\d)([abc]?)([fr])$', re.I)


def stage_of_file(name):
    """'AndersC_Hillclimb2Cr' -> 'hillclimb-2c-r' (mirrors teamFileStage in src/game/ghosts/team.ts)."""
    m = FILE_RE.match(name)
    if not m:
        raise ValueError('team ghost file name does not map to a stage: %r' % name)
    return '%s-%s%s-%s' % (m.group(2).lower(), m.group(3), m.group(4).lower(), m.group(5).lower())


def build_global(ctx):
    order = {sid: i for i, sid in enumerate(S.ported_order())}
    ids = set(order)
    entries = []
    for vp in ctx.vfs.files_under('teamghosts'):
        real = ctx.vfs.real_path(vp)
        name = os.path.basename(real)
        data = ctx.vfs.read(vp)
        g = G.parse(data)
        stage_id = stage_of_file(name)
        if stage_id not in ids:
            raise ValueError('%s: stage %s is not a ported stage' % (name, stage_id))
        if g['version'] != '2.0' or g['frameCount'] < 2 or not g['splits']:
            raise ValueError('%s: unexpected ghost (version %s, %d frames)' % (name, g['version'], g['frameCount']))
        car = g['carTemplate']
        entries.append({
            'file': name, 'stageId': stage_id, 'driver': name.split('_')[0], 'name': g['ghostName'],
            'car': car[:-5] if car.endswith('Ghost') else car, 'time': g['splits'][-1],
            'splits': g['splits'], 'frames': g['frameCount'], 'bytes': len(data),
        })
        ctx.out.write_bytes('ghosts/%s.bin' % name, data)
    entries.sort(key=lambda e: (order[e['stageId']], e['time']))
    heights = {sid: S.load_stage(sid, ctx.vfs).height for sid in S.ported_order()}
    ctx.log('%d team ghosts on %d stages' % (len(entries), len({e['stageId'] for e in entries})))
    ctx.out.commit({'version': VERSION, 'ghosts': entries, 'heights': heights})
