# Original-asset pipeline (`npm run assets`)

rally-web ports the original game's look and sound by converting the original archives
(`original_version/archives/*.rff`, our own assets) into browser-ready packs under `public/assets/`.
The packs are **gitignored and never committed**. Without them (CI, tests, a fresh clone) or with `?orig=0`
the game runs exactly as before: procedural terrain / road / scenery / environment, synthesised audio, no
console errors.

```
original_version/archives/*.rff ──► tools/assets/build.py ──► public/assets/ ──► src/core/assets.ts
          (Blowfish + zlib)          + parts/*.py plugins      manifest.json        src/render/orig/*
                 │                    + lib/formats (verified    stages/ cars/        src/world/orig/*
                 ▼                      research parsers)        global/ tex/         src/audio/orig/*
     .cache/original/<archive>/…  (extracted once, research/full layout)
```

Format specs (read the "Web plan" section and the appended "## Verification" section of each; the
verification fixes override the body): `research/formats/{quadmesh,gcm,objects,standardmesh,textures,
environment,cars,sound}.md`. `research/` and `original_version/` are gitignored and local-only; everything
the shipped pipeline needs lives in `tools/assets/`.

## 1. Setup and commands

```
uv venv .venv && uv pip install -r tools/assets/requirements.txt     # numpy + Pillow (once)
npm run assets                                   # everything: all stages, all cars, global (audio)
npm run assets -- --stages corsica-1-f,hillclimb-1a-f --parts track --jobs 8
npm run assets -- --cars AudiS1 --parts cars
npm run assets -- --audio --parts audio
npm run assets -- --list                         # parts (+ hooks), stage ids, car names
npm run assets -- --selftest                     # foundation self-check (~15 s), see §8
```

`npm run assets` = `node tools/assets/run.mjs` → `python -I tools/assets/build.py …` with `.venv/bin/python`
when present, else `python3` (`RALLY_PYTHON` overrides). Python ≥ 3.10.

| option | meaning |
|---|---|
| `--stages all\|id,id` | stage phase: every selected part's `build_stage` for these stages (ids = `PORTED_ORDER`) |
| `--cars all\|Name,Name` | car phase: every selected part's `build_cars` once with these cars (case-insensitive) |
| `--audio` | global phase: every selected part's `build_global` (the audio bank and other shared data) |
| (none of the three) | all three phases, everything |
| `--parts p,p` | restrict to these plugins; `_name` plugins run only when named here |
| `--jobs N` | parallel stage workers (default min(16, CPUs)); also used for the first extraction |
| `--out DIR` | output root (default `public/assets`) |
| `--clean` | first delete the selected parts' outputs for the selected stages / cars / global (never other parts, never `tex/`; `rm -rf public/assets` for a full reset) |
| `--no-extract` | skip the extraction-cache check |
| `--selftest` | run the self-check and exit |

Exit status 1 when any part failed (each failure prints its traceback; other stages / parts still run).
Unresolved texture names are listed per stage in the summary. The manifest is regenerated at the end of
**every** run by scanning the output folder (§4), so builders can run different parts concurrently (and
even the same part, as long as no run `--clean`s a part + stage another run is building at that moment).

Env overrides: `RALLY_ORIGINAL_DIR` (default `original_version/`), `RALLY_ORIG_CACHE` (default
`.cache/original/`).

## 2. Directory layout

| path | what |
|---|---|
| `tools/assets/build.py` | CLI (§1) |
| `tools/assets/run.mjs` | npm wrapper (venv detection) |
| `tools/assets/requirements.txt` | numpy, Pillow |
| `tools/assets/parts/<part>.py` | part plugins, auto-discovered (§3) |
| `tools/assets/lib/rff.py` | `.rff` reader (copy of the verified `research/tools/rff.py`) |
| `tools/assets/lib/archive.py` | archive set, numpy Blowfish (bit-identical, ~13× faster), extraction cache |
| `tools/assets/lib/vfs.py` | the engine's virtual file system + lookup rules (§5) |
| `tools/assets/lib/stages.py` | stage ids ↔ archives ↔ level paths, `StageInfo` (Start.con `H`) |
| `tools/assets/lib/textures.py` | texture registry (`ctx.textures`), DDS/TGA → `.rtex` conversion |
| `tools/assets/lib/rtex.py` | `.rtex` writer/reader (§6) |
| `tools/assets/lib/context.py` | `BuildContext` (`ctx`) and `Output` |
| `tools/assets/lib/manifest.py` | manifest scan/write |
| `tools/assets/lib/selftest.py` | `--selftest` |
| `tools/assets/lib/formats/` | the verified research parsers (§7) |
| `tools/assets/make_test_fixtures.py` | regenerates `tests/assets/fixtures/*.json` |
| `tools/assets/check-textures.mjs` (+ `.page.ts`, `.html`) | GPU upload check of built textures (§8) |
| `tools/assets/check-game.mjs` | loads stages in the real game with URL variants (§8) |
| `tools/vite-orig-assets.mjs` | Vite plugin: a missing manifest is served/emitted as `null` |
| `.cache/original/<archive>/…` | extracted archives, **identical to `research/full`** (19 110 files, 1.8 GB, ~12 s on first run) |
| `.cache/{stamps,locks,tmp,dumps}/` | extraction stamps, inter-process locks, temp files, parser CLI dumps |
| `public/assets/` | **output** (gitignored): see §4 |

Archive names are the `.rff` basenames: `Audio Cars LocaleEnglish Menu Misc common fogzor corsica1f …
rallycross3r`. Every archive is mounted at the same virtual root (Misc holds `texture/ mesh/ object/
shaders/ level/ …`, Cars holds `cars/`, Audio `sound/`, track archives `track/<layout>/<dir>/…`).

## 3. Part plugins

A plugin is `tools/assets/parts/<name>.py` with `PART = '<name>'` and any of:

```python
PART = 'track'

def build_stage(ctx, stage):        # once per selected stage (parallel workers, one process per stage)
    qm = ctx.vfs.read(stage.vpath('Mesh/Track.qm'))           # bytes straight from the archive
    path = ctx.vfs.real_path(stage.vpath('Mesh/Track.qm'))     # or a file path in the extracted cache
    import fmt_quadmesh as Q                                   # verified parsers are importable directly
    mesh = Q.parse(path)
    tex = ctx.textures.use('texture/CO_Tarmac_01_MT')          # engine-resolved, deduped .rtex → texId
    env = ctx.textures.cube('texture/CarEnvmap')               # [6 texIds] or None
    ctx.out.write_bytes('track.bin', blob)                     # binaries first …
    ctx.out.commit({'version': 1, 'textures': [tex], …})       # … track.json LAST (marks the part present)

def build_cars(ctx, cars):          # once, with the selected car names ('AudiS1', …)
    for name in cars:
        ctx.car_out(name).commit({...})                        # cars/<Name>/<part>.json

def build_global(ctx):              # once (shared outputs, e.g. the audio bank)
    ctx.out.commit({...})                                      # global/<part>.json
```

Lib modules are importable as top-level modules inside plugins: `archive`, `vfs`, `stages`, `textures`,
`rtex`, `context`, and the parsers `fmt_*` (§7). Parts must not depend on each other's outputs (they
run in any order, possibly in different processes); share code through a `tools/assets/lib/` module instead.
Part names (the file name, `PART`, the manifest key) use only letters, digits and `_` (enforced). Extra
json files of a part (`track.lod.json`) are fine: only `<part>.json` marks a part, the manifest ignores the rest.
Raise on real errors (the run reports them and exits 1); return quietly when a stage lacks the data (e.g.
corsica1f has no lightmaps, rallycross has no World.qm).

### `ctx` (lib/context.py `BuildContext`)

| member | |
|---|---|
| `ctx.part` | plugin name |
| `ctx.stage` | `StageInfo` in `build_stage`, else `None` |
| `ctx.vfs` | `Vfs`: `find(vpath, prefer=archive)`, `exists`, `read`, `read_text` (latin-1), `listdir(vdir)`, `files_under(vdir)` (recursive, lower-case vpaths), `real_path(vpath)` (extracted cache path), `texture_candidates`, `resolve_texture` |
| `ctx.archives` | `ArchiveSet`: `names()`, `read(archive, member)`, `entries(archive)` |
| `ctx.full` | extracted cache root (= `research/full` layout; what the copied parsers read via `FULL`) |
| `ctx.textures` | texture registry bound to the stage (§6): `use(name[, stage])`, `cube(name[, stage])`, `use_file(archive, member)`, `resolve(name[, stage])`, `info(texId)`, `alpha_class(texId)`, `missing` |
| `ctx.out` | `Output` for the slot (`stages/<id>/` or `global/`); `None` in `build_cars` |
| `ctx.car_out(name)` | `Output` for `cars/<name>/` |
| `ctx.log(msg)`, `ctx.warn(msg)` | prefixed log lines |

`Output`: `path(name)`, `write_bytes(name, data)`, `write_text`, `write_json(name, obj)`, `commit(obj)`
(= `<part>.json`), `clean()`. Names must be `<part>.<ext>` or `<part>/<relative path>`; anything else raises,
so parts cannot clobber each other. Every write is atomic (temp file + rename).

### `StageInfo` (lib/stages.py)

| field | example |
|---|---|
| `id` | `hillclimb-1a-f` |
| `archive` | `hillclimb1af` |
| `family` | `hillclimb` (corsica, hillclimb, iceracing, kenya, newzealand, rallycross) |
| `layout` / `direction` / `reverse` | `hillclimb1a` / `forward` / False |
| `level` | `track/hillclimb1a/forward` (virtual, lower case) |
| `track_name` | `Hillclimb1A` (Start.con `Game.createTrack` arg 1) |
| `height` | `H` = 424.0 (Start.con arg 3; 424 most, Iceracing1 24, Kenya 124, NewZealand1 100, NewZealand2/3 200, Rallycross1 10) |
| `world_offset` | `(2048, H, 2048)` |
| `vpath(rel)` | `track/hillclimb1a/forward/mesh/track.qm` |
| `cache_dir` | `.cache/original/hillclimb1af/track/hillclimb1a/forward` |
| `to_json()` | the fields above as JSON |

Helpers: `stages.stage_archive(id)`, `archive_stage_id(archive)`, `level_path(id)`, `ported_order()` (read
from `src/world/ports/index.ts`), `load_stage(id, vfs)`.

### Frames (docs/ARCHITECTURE.md §2, research/formats/objects.md §1.3)

* `.qm` / `.gcm` meshes and `AiFiles/*.spl` are in the original **sim** frame (left-handed, y up, z forward).
* `Objects.con`, `MergeObjects.dat` / `MergeMesh.dat`, `Start.con` positions are in the **world** frame:
  `sim = world − (2048, H, 2048)`. `Cameras.con` is already sim.
* three = sim with z negated: positions `(x, y, −z)`; mirroring flips triangle winding (swap two indices per
  triangle so three's CCW front = D3D's CW front). Prefer emitting **three-space** data from the build step.

## 4. Outputs and the manifest

```
public/assets/
  manifest.json
  stages/<stage id>/<part>.json   (+ <part>.bin, <part>.<ext>, <part>/…)
  cars/<CarName>/<part>.json      (+ …)
  global/<part>.json              (+ …)      global/audio.json = the original sound bank
  tex/<texId>.rtex                content-addressed textures (shared by every part / stage / car)
```

A part is **present iff its `<part>.json` exists** (write it last). The manifest is a scan of that
(`lib/manifest.py`, mirror `src/core/assets.ts`), written under a lock so concurrent runs never leave a stale
one:

```json
{ "version": 1,
  "stages": { "corsica-1-f": ["environment", "objects", "track"] },
  "cars": ["AudiS1"], "carParts": { "AudiS1": ["cars"] },
  "global": ["audio"], "audio": true,
  "textures": 5954 }
```

`vite build` copies `public/assets/` into `dist/` when present (hundreds of MB); a build without it emits
`assets/manifest.json` = `null` (and the dev server answers `null` while the file is missing), so the game
never logs a 404 for it. Serve `.rtex` / `.bin` with HTTP gzip/brotli in a real deployment (P8 lightmaps
compress ~3×; the whole 48-stage texture set is 537 MB uncompressed).

## 5. Engine lookup rules (lib/vfs.py)

* Paths are case-insensitive, `\` = `/`; every archive is mounted at the same root (union; no path exists
  in two archives — verified). Level folder: `track/<layout>/<forward|reverse>/`.
* **Texture names** (TextureManager FUN_006a70c0/FUN_006a7280 + the level-load `texture` mount, textures.md
  §2.2): the extension is ignored (cut at the last `.` of the last component); `texture/X` resolves in the
  stage's `Texture/` folder first, then Misc's `texture/` (**the stage folder shadows Misc** — 804 same-name
  pairs differ); `track/…` is a level path; `menu/X` is Menu then `locale/english/menu/X`; anything else a
  root path. Per folder the probe order is **BMP < DDS < RCM < RTX < TGA** (a DDS always beats a TGA twin).
  `vfs.resolve_texture` agrees with the verified `fmt_textures.resolve` on 1 808 names (selftest).
* Cube maps (`.rcm`): six face lines in file order = +X, −X, +Y, −Y, +Z, −Z, each resolved like a texture
  name; bare face names (`Env_NewZealand2r`) fall back to `texture/<name>` (textures.md §10 Q6).
* Lightmaps: `<level>/Lightmaps/TrackNNN.tga` are P8 drawn through `<level>/Lightmaps/Track.pal` (`.act`
  fallback, else red like the engine's 0xF800 LUT). corsica1f ships none (render white, quadmesh.md §8).

## 6. Textures: `ctx.textures` and the `.rtex` container

`texId = ctx.textures.use(name)` resolves with the rules above, converts, hashes the `.rtex` bytes
(sha256, first 20 hex chars) and writes `tex/<texId>.rtex` once (identical content from forward/reverse
stages, stage/Misc copies or different names is stored once). `None` (and a `(name, stage id)` pair in
`ctx.textures.missing`, a set shared by every stage the worker process built — filter by `ctx.stage.id`)
when nothing resolves; a `TextureError` when a file cannot be converted. `cube(name)` → six texIds or
`None`. `use_file(archive, member)` skips name resolution (billboards, lightmaps). `info(texId)` → format,
size, levels, flags, source; `alpha_class(texId)` → `opaque | binary | graded` (decodes, use sparingly).

Conversion (textures.md §2–§4, §9.3, verifier corrections):

| source | `.rtex` |
|---|---|
| DDS DXT1 / DXT3 / DXT5 | the original blocks and **authored** mip chain unchanged (chains that stop at 4×4 included); trailing unused levels dropped; DXT1 3-colour blocks using index 3 set `PUNCHTHROUGH` |
| DDS A8R8G8B8 (2-D and volumes) | RGBA8 (BGRA swizzled at build time); volumes keep every level (`VOLUME`, depth halves per level) |
| DDS R8G8B8 | RGB8 (`Metro6R4_lod2`: one level — single-level DDS stay single-level, the engine generates nothing) |
| TGA 32 / 24 bit | RGBA8 / RGB8 + full chain built at build time: level L = **floor(mean of level 0 over the clamped 2^L block)** per channel (every level from level 0, `GENERATED_MIPS`) |
| TGA 8-bit grey (type 3) | L8 (+ chain); sampled as (L, L, L, 1) |
| TGA colour-mapped (type 1) | P8 index plane + 256-entry palette (lightmaps: `Track.pal`; others: the file's own grey ramp); the chain is averaged **in index space** and expanded per level at load (D3D P8 filters after the lookup) |

### `.rtex` layout (lib/rtex.py ≡ src/render/orig/rtex.ts)

Little-endian, 4-byte aligned, one texture per file:

| offset | type | field |
|---|---|---|
| 0 | char[4] | magic `RTEX` |
| 4 | u16 | version = 1 |
| 6 | u8 | format: 1 DXT1, 2 DXT3, 3 DXT5, 4 RGBA8, 5 RGB8, 6 L8, 7 P8 |
| 7 | u8 | flags: 1 VOLUME, 2 PALETTE, 4 PUNCHTHROUGH, 8 GENERATED_MIPS |
| 8, 12, 16 | u32 | width, height, depth (level 0; depth 1 for 2-D) |
| 20 | u32 | levels n ≥ 1 |
| 24 | u8 | source engine format (12 DXT1, 14 DXT3, 16 DXT5, 2 A8R8G8B8, 1 R8G8B8, 9 L8, 10 P8, …) |
| 25 | u8 | source kind: 1 DDS, 2 TGA |
| 26 | u16 | reserved (0) |
| 28 | u32 | palette offset (0 or 256 × RGBA8, A = 255) |
| 32 | u32[n] | level byte offsets (from file start, 4-aligned) |
| 32 + 4n | u32[n] | level byte sizes |
| … | | palette, then level payloads (each padded to 4 bytes) |

Level i is `max(1, w>>i) × max(1, h>>i) × max(1, d>>i)`; DXT size = `max(1,⌈w/4⌉)·max(1,⌈h/4⌉)·(8|16)·d`,
others `w·h·d·(4|3|1|1)`. Rows are stored **top row first** (D3D origin): upload with `flipY = false` and use
the original UVs unchanged. No DDS header.

## 7. The verified parsers (`tools/assets/lib/formats/`)

Copies of `research/tools/` (independently verified, see each spec's Verification section): `fmt_quadmesh`
(+ `_validate`, `_export`), `fmt_gcm` (+ `fmt_gcm_export`, the RGC1 browser layout + reference query, and
`fmt_gcm_bench.mjs`), `fmt_objects`, `fmt_standardmesh` (+ `_anim`), `fmt_textures` (+
`fmt_textures_dxt_fallback.mjs`), `fmt_environment` (+ `data/environment_cmds.json`, the console command
table it reads), `fmt_cars`, `fmt_sound`. **The only change** in each copy is its data-root constants, now
from `formats/_paths.py` (`FULL` = `.cache/original`, `REPO`, `ART_ROOT` = `artifacts/re`, `DUMPS` =
`.cache/dumps`, `DATA`); plus `fmt_gcm_bench.mjs` now uses the verified triangle start test **`d0 <= 0 →
miss`** (gcm.md Verification §3.4; `fmt_gcm.py` / `fmt_gcm_export.py` already did). Any TS port of the RGC
query must use `d0 <= 0` as well. `fmt_standardmesh.find_texture` is a research heuristic: resolve textures
through `ctx.textures` instead. Not copied (research-only): the `*_verify*`, `*_render*`, `*_sheets`,
`fmt_gcm_trace` tools.

Parsers that index the whole tree (`fmt_objects.Vfs`, `fmt_sound`, `fmt_cars`) see every archive because
the cache is always extracted completely (deterministic results regardless of what ran before).

## 8. Runtime (TypeScript)

### `src/core/assets.ts` (no three.js; shared by render / world / audio)

| export | |
|---|---|
| `getAssetManifest(): Promise<AssetManifest \| null>` | fetched once, cached; null when absent / unreadable / other version / `?orig=0` / outside the browser; never rejects |
| `hasStagePart(id, part)`, `manifestHasStagePart(m, id, part)`, `manifestStageParts(m, id)` | part queries |
| `fetchJson(rel)`, `fetchArrayBuffer(rel)` | GET under the asset base; throw on errors (catch → `warnOnce` → fall back) |
| `assetBaseUrl()`, `assetUrl(rel)` | `import.meta.env.BASE_URL + 'assets/'` (works with `base: './'`) |
| `stagePartPath(id, part, ext)`, `carPartPath`, `globalPartPath`, `texturePath(texId)` | relative paths |
| `isPortedStageId`, `stageArchive`, `archiveStageId`, `stageLevelPath`, `stageFamily` | id helpers (`corsica-1-f` ↔ `corsica1f` ↔ `track/corsica1/forward`) |
| `origAssetsDisabled()`, `urlParam(name)`, `warnOnce(key, msg)` | flags and diagnostics |
| `_setAssetFetchForTests(fn)` | tests only |

### `src/render/orig/textures.ts` — `TextureStore` / `TextureScope`

`GameRenderer.textureStore` (one per WebGLRenderer). Consumers take a `scope()` and `dispose()` it; a texture
lives while any scope holds it. `scope.get(texId, { wrapS, wrapT, minFilter, magFilter })` → `THREE.Texture`
(one per (id, wrap, filter) key); `getCube(sixIds)` → `CompressedCubeTexture`; `getVolume(texId)` →
`Data3DTexture`. Upload rules: DXT stays compressed where `WEBGL_compressed_texture_s3tc` exists (DXT1 always
`RGBA_S3TC_DXT1`), else / with **`?s3tc=0`** the bit-exact JS decoder (`dxt.ts`) and RGBA8 levels; the
authored chain exactly (`texStorage2D(levels)`); `generateMipmaps = false`; trilinear (`LinearFilter` for
one-level textures); anisotropy 1; `flipY = false`; `premultiplyAlpha = false`; `NoColorSpace`.
RGB8/L8/P8 expand to RGBA8 at load (P8 through its palette per level). Volumes: three r186 uploads only level 0
of a `Data3DTexture`, so the store uploads the authored levels itself (`texSubImage3D` after `initTexture`;
a later three re-upload would refresh level 0 only). Cubes: faces as stored (+X…−Z, flipY false); they are in
the original/sim frame — sample `textureCube(env, vec3(d.x, d.y, -d.z))` for a three-space direction `d`
(never PMREM). Alpha test GREATER 0x7F → `alphaTest = 0.5` / `if (a <= 0.5) discard`.

### `src/render/orig/common.ts` — shared uniforms, fog GLSL, component contract

`origUniforms` (module singleton, reset to the original's defaults by every stage load — procedural stages
included, so an original car never inherits the previous stage's fog — filled by the
environment component, referenced **by identity** by every original material — write `.value`, never
replace the objects; colours are raw 0..1 floats in `THREE.Vector3`, never `THREE.Color`):

| uniform | default (FUN_0040e650) | source |
|---|---|---|
| `trackFog.{enabled, color, start, end, clamp}` | 0, (1,1,1), 0, 1024, 1e8 | `Track.fog*` (track, objects, trees, cars, water, particles) |
| `worldFog.{enabled, color, start, end, clamp}` | 0, (1,1,1), 0, 1024, 1e8 | `World.fog*` (World.qm only) |
| `sunDir` | (0, 0.7071, −0.7071) | three space, toward the sun (`sunLightDirThree`) |
| `objectLight` / `objectShadow` | 0.6 / 0.2 | `game.lightColor` / `game.shadowColor` |
| `carLight` / `carAmbient` | 0.5 / 0.3 | `car.lightColor` / `car.ambient` |
| `time` | 0 | seconds since the view loaded |

Fog (environment.md §3.4, quadmesh.md §4.3): `ORIG_FOG_PARS` declares `uFogEnabled/uFogColor/uFogStart/
uFogEnd/uFogClamp` and `float origFogFactor(float viewZ)` = `clamp(max((end − z)/(end − start), (end −
clamp)/(end − start)), 0, 1)` (1 = unfogged; fogEnable 0 → 1). Bind with
`uniforms: { ...fogUniformMap(origUniforms.trackFog), … }` (World.qm: `.worldFog`); vertex
`vOrigFog = origFogFactor(-mvPosition.z)`, fragment `rgb = mix(uFogColor, rgb, vOrigFog)`.
`origFogFactor()` is the CPU mirror. Also `ORIG_DEFAULTS`, `createOrigUniforms()`, `resetOrigUniforms()`,
`disposeTree(root)`.

Component contract (`OrigComponentLoader = (ctx: OrigLoadContext) => Promise<OrigComponent | null>`):
`ctx` = `{ stage, stageId, manifest, parts, renderer, textures (the view's TextureScope), uniforms,
partPath(part, ext), fetchPartJson(part, ext), fetchPartBuffer(part, ext = 'bin') }`; a component =
`{ object3D, update(camera, dt), dispose(), heightAt?(x, z), replacesSky?, cameraFar? }`. Return null when the
part is absent; throw on real failures.

### `src/render/orig/index.ts` — `OriginalStageView`

`OriginalStageView.load(stage, renderer, textureStore)` → view or null (never rejects). Tried for ported
stages whose manifest lists any of `RENDER_PARTS = track, objects, environment`; loads the components in
parallel (`track.ts` `loadTrack`, `objects.ts` `loadObjects`, `environment.ts` `loadEnvironment`). A failing
component logs **one** warning and counts as absent; no component → null. Stand-ins keep the view drivable:
no track → procedural terrain + road; no track and no objects → also procedural scenery. The view exposes
`group`, `parts`, `hasTrack`, `replacesSky`, `cameraFar`, `uniforms`, `groundAt(x, z)` (camera ground
sampler: track `heightAt` → stand-in terrain → stage heightfield), `update(camera, dt, lod)`, `dispose()`.

Load ordering: `GameRenderer.loadStage` runs view loads one at a time (a superseded load settles — its
components may still write `origUniforms` — before the next stage resets them, then is disposed) and
`main.ts` `loadSelection` lets the **latest** request win when loads overlap. Components therefore never
see a half-reset uniform set from another stage, but must still only write uniforms from their own load.

`GameRenderer.loadStage` (async) uses the view **instead of** the procedural terrain / road / scenery and
switches the output to the original's gamma-space pipeline (`NoToneMapping` + `LinearSRGBColorSpace`);
procedural stages restore ACES + sRGB. The procedural sky dome hides when a component `replacesSky`.
`debugInfo()` reports `orig` (loaded parts) and `s3tc`.

**Frame pipeline** (`src/render/orig/environment.ts` `OrigFramePipeline`, driven by the renderer while an original
view with an environment is shown; docs/orig/environment.md §2–§4): the original's pass order of the race view
loop 0x49f0f0 — (1) the sky pass on `ORIG_SKY_LAYER` (common.ts; sky box, clouds, World.qm) with a camera of near
10 / far 10 + 100000 (the level-init defaults over the constructor's 5000); (2) a depth / stencil clear; (3) the
main pass (track, objects, cars, particles, weather) with near 0.1 and far = near + the HotSpot-regulated Track view
distance (FUN_004e1240), then the lens flares (per-pixel occlusion, an 8×8 depth mask); (4) the hardware gamma
ramp blit (`?gamma=0` off, `?gfxgamma=` the menu gamma). The old "cameraFar ≥ 5200 when the sky box is drawn" rule
no longer applies: the sky pass has its own camera (`OrigComponent.cameraFar` is still honoured without the
pipeline, e.g. when the environment part is absent).

### Other entry points (all implemented)

| module | signature | behaviour |
|---|---|---|
| `src/world/orig/index.ts` | `attachOriginalWorld(built: BuiltStage): Promise<BuiltStage>` (called by `main.ts` for every stage load) | the mesh `OrigWorld` (Track.gcm `segment`, object proxies, `softNear` bushes) for every ported stage whose manifest lists `collision` (all 48 built); `built` unchanged with `?collision=0`, without the part, or on a failure (one `warnOnce`) — docs/orig/collision.md |
| `src/render/orig/car.ts` | `loadOriginalCar(carName, { stageId?, textures?, ghost? }): Promise<OriginalCarVisual \| null>` (per-stage CarEnvmap / CarDirtmap from `stages/<stageId>/cars.json`) | called by `GameRenderer.addCar` for `AddCarOptions.origCar` (addCar's promise settles with it; the procedural `CarVisual` is hidden meanwhile and shows only as the fallback; main.ts awaits the player car with the stage load; `removeCar` disposes visual then scope) — docs/orig/cars.md |
| `src/audio/orig/index.ts` | `loadOriginalSoundBank(ctx: BaseAudioContext): Promise<OriginalSoundBank \| null>` | called by `AudioEngine` (src/audio/audio.ts) when it creates its AudioContext; null → the synth. Per-car patches follow `FrameContext.origCar` — docs/orig/audio.md |
| `src/render/orig/{track,objects,environment}.ts` | `OrigComponentLoader` (`loadTrack`, `loadObjects`, `loadEnvironment`) | built for all 48 ported stages; composed by `OriginalStageView` — docs/orig/{track,objects,environment}.md |
| `src/render/orig/effects.ts` | `OrigEffectsSystem` / `OrigCarFx` (global/effects + stages/<id>/effects.json) | particles, skid marks, drop shadow and pipe FX; the pipe flames read the shared backfire / blow-out flags (`CarRenderState.carFlags`, src/game/carFlags.ts) — docs/orig/effects.md |

### Fallback rules (all modules)

1. No manifest (absent assets, other version, `?orig=0`, node/vitest) → procedural / synth, **silently**.
2. Manifest present but the part is not listed → that piece stays procedural, silently.
3. A listed part fails to fetch / parse / build → `warnOnce(...)` (one console warning), that piece falls back.
4. Never throw out of a loader into the game loop; never log `console.error` for asset problems (the smoke
   tests treat console errors as failures).

## 9. Verification tools and tests

| command | checks |
|---|---|
| `npm run assets -- --selftest` | numpy Blowfish ≡ pure-Python `rff` (every archive kind), cache bytes; 48 stage mappings + Start.con; engine lookup ≡ `research/tools/fmt_textures.resolve` (1 808 names, 12 stages); `.rtex` round trip on 19 sample files (every format: smallest/largest DXT, non-square + trailing levels, punch-through, A8R8G8B8 2-D + volumes, R8G8B8, 32/24/8-bit TGA, colour-mapped, lightmap via Track.pal) ≡ research `decode_dds` / `tga_decode` at every level + an independent floor-mean; CarEnvmap cubes ≡ `load_cube` (2 304 checks; the research comparisons are skipped when `research/` is absent) |
| `node tools/assets/check-textures.mjs [--ids-from stages/<id>/<part>.json] [--limit N]` | headless Chromium: every level of each texture through both upload paths (S3TC and the JS fallback) read back with `texelFetch` ≡ the JS decode; volume slices of every level; cubes (6-id arrays in the json) sampled at face centres / off-centre ≡ their 2-D faces |
| `node tools/assets/check-game.mjs --stages <ids> --variants default,orig=0,s3tc=0` | the real game per URL variant: console errors / warnings, `orig` parts, screenshots in `artifacts/assets-check/` |
| `npx vitest run tests/assets` | `.rtex` round trips + validation, real pipeline outputs (fixtures) ≡ the Python decode, DXT1/3/5 decoder ≡ the verified numpy decoder (`tests/assets/fixtures/dxt.json`, regenerate with `make_test_fixtures.py`), manifest/asset helpers with and without assets, stage-id mapping for all 48 stages, fog factor, uniform identity; `builtAssets.test.ts` checks `public/assets` when present (skipped otherwise), incl. the runtime fetch path through `tests/assets/builtAssetFetch.ts` |

**Testing a loader on real data in vitest** (node has no asset fetch, so every loader sees "no assets"):
`tests/assets/builtAssetFetch.ts` exports `builtAssetsPresent` and `useBuiltAssets()`, which serves
`public/assets/` from disk to `src/core/assets.ts` (`getAssetManifest`, `fetchJson`, `fetchArrayBuffer`,
`TextureStore` with `{ s3tc: false }` and a stub renderer for 2-D textures). Wrap such tests in
`describe.skipIf(!builtAssetsPresent)` and reset with `_setAssetFetchForTests(null)`; see `builtAssets.test.ts`.

## 10. Ownership for the next phase

Each builder owns its plugin and runtime files; `src/core/assets.ts`, `src/render/orig/{index,common,
textures,rtex,dxt}.ts`, `tools/assets/{build.py,run.mjs,lib/**}` and this document are the shared foundation
(change them only through a contract request, see docs/ARCHITECTURE.md §1). Shared Python helpers a builder
needs go in a new `tools/assets/lib/<topic>.py`.

| builder | build step | runtime | data / spec |
|---|---|---|---|
| **track** | `tools/assets/parts/track.py` | `src/render/orig/track*.ts` (+ shaders), the track's water | quadmesh.md, textures.md §4 (lightmaps), environment.md §3.7 |
| **collision** | `tools/assets/parts/collision.py` | `src/world/orig/**` (a mesh `WorldQuery`: `segment` literal, `raycastViaSegment`, `materialFromOrig`, `yHint`) | gcm.md (Track.gcm; RGC1 = `fmt_gcm_export` + the original top-cell lists, §9), objects.md §8 (proxies) |
| **objects** | `tools/assets/parts/objects.py` | `src/render/orig/objects*.ts` | objects.md, standardmesh.md |
| **environment** | `tools/assets/parts/environment.py` | `src/render/orig/environment*.ts` (fills `origUniforms`), `src/render/sky.ts`, `weather.ts`, renderer colour pipeline / fog / lights | environment.md, textures.md §6 |
| **cars** | `tools/assets/parts/cars.py` | `src/render/orig/car*.ts`, `carVisual.ts` / `carModel.ts` / `livery.ts`, renderer `addCar` / `removeCar`, main.ts car selection, menu car list | cars.md, standardmesh.md §5.6 |
| **audio** | `tools/assets/parts/audio.py` | `src/audio/**`, `src/ui/voice.ts`, main.ts audio call sites | sound.md |
| **effects** | `tools/assets/parts/effects.py` | `src/render/effects.ts`, `src/render/orig/effects*.ts` | environment.md (particles), textures.md |
| **ai** (phase 2) | `tools/assets/parts/ai.py` (+ `lib/formats/fmt_aidata.py`, `fmt_aitimes.py`) | `src/game/ai/aidata.ts` (`loadAiStageData`, `loadAiSchedule`), `driver.ts` | docs/orig/ai.md, research/formats/ai.md |
| **ghosts** (phase 2) | `tools/assets/parts/ghosts.py` (+ `lib/formats/fmt_ghost.py`) | `src/game/ghosts/{team,store,session}.ts`, `src/ui/menuGhosts.ts` | docs/orig/ghosts.md, research/formats/ghosts.md |
| **race** | — (`research/tools/port_tracks.py`) | `src/game/**`, `src/world/{portedDefs,portedBuilder,portSpline,stages}.ts`, `src/world/ports/**` | MECHANICS_SPEC.md, sound.md §10 (Pacenotes.con) |
| **sim** | — | `src/sim/**` except `origCars.ts` / `presets.ts` | MECHANICS_SPEC.md, gcm.md §3.5-3.6 |

The full file-level ownership of this phase (incl. tests and `docs/orig/<builder>.md`) is
docs/ARCHITECTURE.md §1.1.

Part names (= output file names and manifest entries): `track`, `collision`, `objects`, `environment`, `cars`
(car phase; its `build_stage` may also write `stages/<id>/cars.json` with the per-stage car inputs), `audio`
(global phase: `global/audio.json` sets `manifest.audio`). Phase 2 adds `ai` (per stage `stages/<id>/ai.json`: the AiData posts and
the side.rsd 5 m sample table, 804 posts / 39 827 samples over the 48 stages; global `global/ai.json`: the 360 AiTimes schedules; a part
may only write `<part>.*`, hence `global/ai.json`, not `aitimes.json`) and `ghosts` (global: `global/ghosts.json` = the index with the 48
stages' `Game.createTrack` height H and the 30 team ghosts, `global/ghosts/<File>.bin`: the original files byte for byte). Both are gitignored
like every part and are rebuilt with `npm run assets -- --stages all --parts ai` / `npm run assets -- --parts ghosts`.

### Integration gaps (closed)

Gaps 1–4 are closed (integration pass, 2026-10-30); the original text is kept below for the history, each with a
pointer to where it landed.

* **Gap 1 → done.** `?car=<Name>` and `RaceSelection.car` (main.ts; with the cars built and no `?car=` the game
  starts in the original's default car, constants.ts `ORIG_DEFAULT_CAR`), the per-car presets
  (src/sim/presets.ts `origCarParams`, labelled with the real names), the car's own `Car_<Name>.col` hull
  (`CarSimOptions.origCar`), `listCars()` + the menu car list (original car-select order), `origCar` in
  `addCar` / `CarRenderState` / `FrameContext`, best times and ghosts keyed by the car (`IRaceController.begin`).
  `window.__rally.getCarInfo()` reports the car and the hull in use.
* **Gap 2 → done.** `GameRenderer.addCar` calls `loadOriginalCar` (src/render/renderer.ts; docs/orig/cars.md).
* **Gap 3 → done.** `AudioEngine` calls `loadOriginalSoundBank` (src/audio/audio.ts); per-car patches use
  `FrameContext.origCar`; the co-driver voice is on by default (src/ui/settings.ts); impacts and the bush sound
  read `CarTelemetry.collision` (docs/orig/audio.md).
* **Gap 4 → done.** `src/render/orig/environmentFog.ts` (the built-in material hook: the original track fog and an
  sRGB encode for procedural content inside an original view) + `applyOrigAtmosphere` (environment.ts: lights and
  `scene.fog` from `origUniforms`); the original particles bind `fogUniformMap(origUniforms.trackFog)`.
* Gap 5 stays as written (LOD: the components use the original's own view distances).

1. **Original car identity — types landed (phase 0), behaviour open.** The contract now carries the original
   car name (the `cars/<Name>` folder = `manifest.cars` key = `src/sim/origCars.ts` `archive` =
   `src/core/constants.ts` `ORIG_CAR_IDS`, 29 names; `isOrigCarId`): `RaceSelection.car?`,
   `AddCarOptions.origCar?`, `CarRenderState.origCar?`, `FrameContext.origCar?`, `LaunchOptions.origCar?`
   (`?car=<Name>`), `LoadStageOptions.origCar?`, `CarListEntry { id, name, archetype, drive, available }` and
   `IMenuHost.listCars?()`. Absent everywhere = the procedural archetype car (today's behaviour). Who implements
   what:
   * **cars**: `?car=` parsing, preset application (`presets.ts` per-car handling) and `selection.car` in
     main.ts; `listCars()` (available = `manifest.cars` lists it; name from LocaleEnglish when built); the menu
     car list; passing `origCar` to `addCar` and into the `CarRenderState`s; gap 2.
   * **audio**: `origCar: this.selection.car` in main.ts's FrameContext literal; per-car engine patches (gap 3).
   * **race**: key best times / ghosts by `RaceSelection.car ?? archetype`, received as
     `IRaceController.begin(stage, car, { …, origCar })` (main.ts passes `origCar: sel.car` — cars builder's
     part of main.ts); the ghost `CarRenderState` carries the same `origCar`.
2. **`loadOriginalCar` has no call site.** The cars builder wires it into `GameRenderer.addCar` / `removeCar`
   (`src/render/renderer.ts`, outside its own files — coordinate): keep the procedural `CarVisual` until the
   promise resolves, drop the result when the car was removed / re-added meanwhile, pass
   `{ stageId: <ported id or null>, textures: this.textureStore.scope() }`, dispose visual then scope.
   Per-stage inputs (CarEnvmap cube, CarDirtmap) come from `parts/cars.py build_stage` → `stages/<id>/cars.json`.
3. **`loadOriginalSoundBank` has no call site.** The audio builder plugs the bank into `src/audio/audio.ts`
   `AudioEngine` (outside `src/audio/orig/**`); per-car engine patches need gap 1.
4. **Procedural content inside an original view** (the procedural car until gap 2 lands, particles, skid
   marks, precipitation, a stand-in ground) still uses the procedural `THREE.Fog`, hemisphere / sun lights and
   sRGB-authored colours under the gamma-space output (`NoToneMapping` + `LinearSRGBColorSpace`), so it looks
   darker / differently fogged. Nothing maps `origUniforms.trackFog` onto `scene.fog` yet; the environment
   builder requests a renderer hook if it needs one.
5. `OrigComponent.update(camera, dt)` gets no quality / LOD factor (the view's `lod` only scales the stand-ins);
   use the original's own view distances (environment.md §3.6).
