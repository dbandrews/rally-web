# Asset part plugins

One file per part: `<name>.py` with `PART = '<name>'` and any of `build_stage(ctx, stage)`,
`build_cars(ctx, cars)`, `build_global(ctx)`. Auto-discovered by `tools/assets/build.py`; files starting with
`_` run only when named in `--parts`. Part names use letters, digits and `_` only. API, outputs, ownership and
the not-yet-wired integration points: `docs/ASSETS.md` §3–§4, §10.
