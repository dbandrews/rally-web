"""Part plugins: every tools/assets/parts/<name>.py that defines PART = '<name>' and any of

    build_stage(ctx, stage)   once per selected stage (stage = ctx.stage, a stages.StageInfo)
    build_cars(ctx, cars)     once, with the selected car names (folder names under Cars.rff cars/)
    build_global(ctx)         once (shared outputs: the audio bank, ...)

Files starting with '_' (templates, throwaway checks) are only loaded when named explicitly in --parts.
"""
import importlib.util
import os
import re

PARTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'parts'))
HOOKS = ('build_stage', 'build_cars', 'build_global')


def discover(parts_dir=PARTS_DIR, wanted=None):
    """-> {part name: module}. `wanted`: explicit list (may include '_private' parts) or None for all public."""
    files = {}
    if os.path.isdir(parts_dir):
        for f in sorted(os.listdir(parts_dir)):
            if f.endswith('.py') and f != '__init__.py':
                files[f[:-3]] = os.path.join(parts_dir, f)
    if wanted is None:
        names = [n for n in files if not n.startswith('_')]
    else:
        missing = [n for n in wanted if n not in files]
        if missing:
            raise SystemExit('unknown part(s): %s (have: %s)' % (', '.join(missing), ', '.join(files) or 'none'))
        names = list(wanted)
    out = {}
    for n in names:
        if not re.match(r'^[A-Za-z0-9_]+$', n):     # part names are file / manifest keys: no '.', '-', ' '
            raise SystemExit('%s: part names may only use letters, digits and _' % files[n])
        spec = importlib.util.spec_from_file_location('rally_asset_parts.' + n, files[n])
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        part = getattr(mod, 'PART', None)
        if part != n:
            raise SystemExit('%s: PART must be %r (got %r)' % (files[n], n, part))
        if not any(callable(getattr(mod, h, None)) for h in HOOKS):
            raise SystemExit('%s: defines none of %s' % (files[n], ', '.join(HOOKS)))
        out[n] = mod
    return out
