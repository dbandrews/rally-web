# PROGRESS: porting `original_version/` to rally-web

**Target: a full faithful port.** The browser build must be the same game: same handling, tracks, timing and
sounds, and the same look (the original meshes, textures, liveries, sky, lighting, water, UI). `original_version/`
is our own game (`AGENTS.md`), so its assets are in scope, apart from the third-party content listed under
"Legal caveats". The 7 procedural stages stay as the handling lab and the no-assets fallback. Status as of
2026-10-30 (final integration pass).

**Legend:** ✅ done · 🟡 done with open items · ⬜ not started

## Build and run

```
npm install
npm run dev                       # http://localhost:5173 (procedural visuals until the assets are built)

# original assets (needs original_version/, not in git) → public/assets/ (gitignored, ~1.1 GB)
uv venv .venv && uv pip install -r tools/assets/requirements.txt     # once: numpy + Pillow
npm run assets                    # all phases: 48 stages, 29 cars, global audio + effects
npm run assets -- --stages kenya-1-f --parts track,objects           # rebuild only what changed
npm run assets -- --cars all --parts cars
npm run assets -- --list          # parts, stage ids, car names
npm run assets -- --selftest      # pipeline self-check (~15 s)
```

Never `--clean` or delete `public/assets` to rebuild one part: rebuild only the parts you changed. Details:
`docs/ASSETS.md`.

URL flags (full list: `docs/ARCHITECTURE.md` §7):

| flag | effect |
|---|---|
| `stage=<id>` | `corsica-1-f` … `rallycross-3-r` (48 ported), or a procedural stage (`pine-ridge`, `testpad`, …). Default: `corsica-1-f` when its track + collision parts are built, else `pine-ridge` |
| `car=<OrigName>` | an original car, e.g. `ImprezaWRX`, `AudiS1`; `awd_wrc` / `fwd_hatch` / `rwd_classic` = the procedural archetypes. Default: `Micra` when the cars are built, else `awd_wrc` |
| `menu=0`, `countdown=0`, `autopilot=1`, `cam=<0..7\|name>`, `tyre=`, `trans=manual`, `seed=` | game options |
| `orig=0` | ignore the converted assets (procedural everything; the game must stay playable this way) |
| `s3tc=0` | decode DXT in JavaScript instead of compressed uploads |
| `collision=0` | procedural ground instead of the original Track.gcm mesh |
| `gamma=0`, `gfxgamma=<0..1>` | in-race gamma ramp off / menu gamma value |
| `music=1` | play the user's own soundtrack copy from the gitignored `public/sound/music/` (never built) |
| `audio=0`, `ghost=0`, `quality=low\|medium\|high`, `pr=`, `aa=` | sound, ghost, renderer |
| `carlm=0`, `orighook=0` | diagnostics: no track lightmap on the cars / no original-fog hook |

Checks: `npx tsc --noEmit`, `npx vitest run`, `npm run smoke`, `npm run build`, `node tools/all-stages.mjs`
(autopilot drives the 48 ported stages to the finish), `node tools/assets/check-game.mjs` (console and screenshot
sweep in the real game), `tools/render-stage-shots.mjs`, `tools/drive.mjs` (`--query k=v` adds URL flags).

## Status per roadmap step

| step | status | where |
|---|---|---|
| 1. Asset pipeline | ✅ | `tools/assets/`, `src/core/assets.ts`, `src/render/orig/{index,common,textures,rtex,dxt}.ts`; docs/ASSETS.md |
| 2. Track meshes | 🟡 | `parts/track.py`, `src/render/orig/track*.ts`; docs/orig/track.md |
| 3. Collision | ✅ | `parts/collision.py`, `src/world/orig/`, `src/sim/car.ts` object pass; docs/orig/collision.md |
| 4. Objects | 🟡 | `parts/objects.py`, `src/render/orig/objects*.ts`; docs/orig/objects.md |
| 5. Sky, lighting, water, weather | 🟡 | `parts/environment.py`, `src/render/orig/environment*.ts`; docs/orig/environment.md |
| 6. Cars | 🟡 | `parts/cars.py`, `src/render/orig/car*.ts`, `src/sim/origCars.ts`, `presets.ts`; docs/orig/cars.md |
| 7. Sounds | 🟡 | `parts/audio.py`, `src/audio/orig/`; docs/orig/audio.md |
| 8. Effects | 🟡 | `parts/effects.py`, `src/render/orig/effects*.ts`, `src/render/effects.ts`; docs/orig/effects.md |
| 9. Race rules | ✅ | `src/game/`, `src/world/ports/`, `portedDefs.ts`, `portedBuilder.ts`; docs/orig/race.md |
| 10. Sim fidelity | ✅ | `src/sim/`; docs/MECHANICS_SPEC.md v1.5 |
| 11. Menus / UI | 🟡 | `src/ui/menu.ts`, `hud.ts` (HTML UI with original names, icons, sounds) |
| 12. Movies | ⬜ | `original_version/Movies/*.bik` |

### 1. Asset pipeline ✅

* `npm run assets` (`tools/assets/build.py` + `parts/*.py`, Python + numpy) reads the `.rff` archives itself (numpy
  Blowfish, bit-identical to the research reader), extracts once to `.cache/original/`, applies the engine's lookup
  rules (union VFS, stage `Texture/` shadows Misc, BMP < DDS < RCM < RTX < TGA) and writes per-stage, per-car and
  global parts with a manifest rescanned every run. Built: all 6 parts (track, collision, objects, environment,
  cars, effects) for all 48 stages, 29 cars, global audio + effects; 6 466 content-addressed `.rtex` textures
  (original DXT blocks and mip chains, P8 lightmaps + palette, volumes, cubes).
* Runtime: `TextureStore` (S3TC upload or the `?s3tc=0` JS decoder, bit-identical), shared `origUniforms` + the
  original fog GLSL, `OriginalStageView` composing the components, the frame pipeline, gamma-space output. Every
  loader is wired (docs/ASSETS.md §8, integration gaps 1-4 closed in §10). No assets or `?orig=0` → procedural
  stand-ins, no console errors.

### 2. Track meshes 🟡

* `Mesh/Track.qm` (PS 1.1 mesh), `World.qm` (backdrop, drawn in the sky pass) and `Water.qm` of all 48 stages:
  4 790 patches, 2.93 M triangles, quadtree culling with the original track view distance and HotSpot regulator
  (FUN_004e1240), GLSL ports of the DX8 track shaders (Mask / Single / Water, lightmaps, bump, double intensity),
  fog per the original. The Track.qm lightmap uv3 is an exact x/z projection (4 710 patches checked), which also
  feeds the cars (t3) and the particles.
* Open: water is brighter than the screenshots (see the open list); missing texture names sample black; World.qm
  fog without the track clamp; `fogRangeFixed`, `lightmapLimit`, `lightmapOnly`, `maskBlendEnable 0` not modelled.

### 3. Collision ✅

* The physics ground is the original `Mesh/Track.gcm` (TrackFull.gcm is a dev variant, never loaded): RCOL v2 with
  the original arrays in file order and a literal port of the segment query (0x595c50) with the per-slot face cache.
  Recorded original rays reproduce hit/miss and material on all 1.21 M rays (float64 vs the original's x87: c0 within
  3.7e-5 m).
* Static objects: the original's object pass FUN_004a7bc0 → FUN_006d1a80 on the objects' own CollisionMesh.Simple
  meshes (82 190 instances, geometry scale applied, query 0x597810 ported), contacts through FUN_006d21c0 / the body
  solver. Bushes set the bush flag (`softNear`). The `obstaclesNear` cylinders are now only autopilot hints.
* Open: loose parts (6 559 cones, signs, barrels) are not collided; the car's object-pass box is approximated from
  its 12 hull points.

### 4. Objects 🟡

* Trees (TreeMesh with the 8 sort copies), StandardMesh props, spectators / animals, Kuliss backdrops and impostors
  from Objects.con, instanced per template; the ObjectDrawer culling (0x6f2970), distance zones and HotSpot view
  distances decoded from the exe; alpha test GREATER 0 for every object pass (render-state-stack trace).
* Open: tree sway (31 templates) not ported; spectators and animals in their bind pose; leaves split into a
  depth-writing core and a soft edge (documented deviation).

### 5. Sky, lighting, water, weather 🟡

* `environment.json` per stage from the evaluated scripts in load order (TrackFogSettings → RenderSettings → … →
  Cameras.con) with the exe defaults: sky box and clouds (sky pass: sky, clouds, World.qm, near 10 / far 100 010),
  track and world fog, sun and car lights, the sun lens flare with its 8×8 back-buffer occlusion mask, snow / rain
  on the 10 weather stages, view distances, and the in-race gamma ramp with the stage's scripted
  `trackGammaDelta` (traced: the loader runs RenderSettings.con before it reads the delta).
* Procedural content inside an original view uses the original fog (material hook) and lights.
* Open: water brightness (step 2); snow flakes fainter than the screenshots; several inherited render states
  assumed (flare / weather alpha ops, cloud upload format); the DOM HUD is not gamma-ramped.

### 6. Cars 🟡

* 29 cars with their real meshes (4 LOD sets), liveries, wheels (tarmac / gravel), lights and lens flares, LocaleEnglish
  names and the car-select spec lines, bars and icons; the original car shader (env map, dirt layer, highlight) with
  the track lightmap under the car (t3); per-car handling (`origCars.ts`, presets labelled with the real names, e.g.
  "Subaru Impreza WRX (AWD)"); each car's own `Car_<Name>.col` hull in the sim; each car's own `<Car>CarCamera`
  table (25 entries; 15 cars have their own bumper, 20 their own bonnet, 8 their own chase positions).
* The race waits for the original car to load (the procedural stand-in is only seen without assets).
* Open: drivers not drawn; damage morph not driven; dirt factor 0; LOD by distance (the video-quality table is
  not in the archives); static env cube only; no ShadowGen / ShadowApply passes.

### 7. Sounds 🟡

* `global/audio.json` + 582 WAVs (44 kHz tier, PCM byte-identical): 386 `.ssc` scripts, 469 patches. Ported: the
  envelopes, the 15 Hz sound tick, the patch life cycle, the DirectSound volume / frequency / doppler laws, 3-D
  positions, the CarSoundPlayer (all 20 slots, 23 surface materials, backfire / blow-out from the shared
  `src/game/carFlags.ts` source, impacts and the bush sound from the original collision record), stage ambience,
  countdown / checkpoint sounds, menu meme sounds (Step, Tag, Select, Back, Error, Sweep), and the co-driver
  speaking the original pacenote words (on by default).
* Open: wheel slip / bump inputs calibrated, not traced; Error.ssc trigger, team-coach samples and glass events not
  wired; music order rule and the menu / pre-race tables.

### 8. Effects 🟡

* Per stage: the evaluated particle templates (Emitter / SpriteParticle / CarFx), CarFx per wheel and pipe, skid
  marks, the low-detail drop shadow, particle light from the exact track lightmap texel at spawn. Original sprite
  batches stay unfogged (Sprite.vs writes oFog = 1); the procedural fallback particles take the original fog.
* Open: wheel slip inputs and sprite extents inferred; per-template sorting; glass-break particles (no damage).

### 9. Race rules ✅

* All 48 archives' race settings verbatim: spawn grid, event triggers (start, splits, finish; laps on circuits),
  `splineRange` (valid range, returned unchanged), default tyre, the 3-D arc-length distances, the original road
  materials from Track.gcm for the procedural world, `bodyBrakingFactorForTrack` (post-finish track braking).
* The hand-of-god reset to max(s − 20, validRangeMin + 1) (0x4b3f0b); the original's pacenotes (860 notes on 36
  archives, word ids + text) with the original pick / lateral rules; best times and ghosts keyed by the car.
* The autopilot (a test tool, not the original AI) plans around objects; 48/48 stages finish (results below).

### 10. Sim fidelity ✅ (docs/MECHANICS_SPEC.md v1.5)

* Handling ported from the exe and proven against Frida traces of the running original (v1.4: 281 564 tyre calls to
  float32 precision; one suspension fix).
* **Suspension fix** (§2.5.3): the wheel ray's compression is the FRACTION c0/c4 = (SL − hitDist)/SL, not metres
  (`x = 1 − (sink + c0)/(c4·SL)`); the body rides ≈ 2.5 cm higher. Recorded ext matches to ≤ 8.9e-5 over 302 945
  wheel hits; open-loop end error 25-27 mm → 0.6-0.8 mm.
* **Body solver FUN_006d0970 decoded** (§2.9; its Ghidra output is broken, rebuilt from the disassembly): the hull
  probes (FUN_006cea90 tail) reduce up to four hull contacts to one; the solver applies push-out, a normal impulse
  and the anchor friction impulse. Executed in unicorn against the port: equivalent on 3 000 states (float32); the 6
  recorded contact steps reproduce to 2.7e-5 m/s. DEV-4 (own impulse model) withdrawn.
* Wheel and hull segment queries on the original mesh (closed loop on Track.gcm: open-loop median 0.64 mm), the hull
  ground share nb, the post-finish track braking (phys+0x44), the object pass, the collision record for audio.

### 11. Menus / UI 🟡

HTML menu and HUD: original car names, car-select icons, spec lines and bars, car order from the original car
select, menu meme sounds, the original countdown / pacenote audio. Not ported: the `Menu.rff` screen art and 3-D
garage, most `LocaleEnglish.rff` strings, the HUD art.

### 12. Movies ⬜

`original_version/Movies/*.bik` (29 files) not transcoded. MsIntro / DiceIntro need clearance first (below).

## Corrections to earlier notes

* `fogzor.rff` is **TrackFogSettings** (the per-stage low-detail fog scripts the environment resolver loads first),
  not a dev test level.
* The per-car engine / pipe WAVs are in **Audio.rff** (`sound/44khz/…` holds every sample). `Cars.rff` only has the
  `.ssc` scripts.
* There are **29** original cars, not 33.
* `original_version/Sound/Music/` holds **14** WAVs, not 13: the exe's tables reference 11 (10 in-game, of which 3
  are also the menu table, plus 1 pre-race); the three Big Idea tracks are referenced by no table.
* The live gamma delta is the stage's scripted `trackGammaDelta`, not 0 (environment.md §5).

## Legal caveats (clear before any public build)

* **Soundtrack**: the music in `original_version/Sound/Music/` is licensed third-party music (Androyd, Ball Of
  Waxx, Big Idea, Dub Pistols, Fear Factory, Foetus, Frontside, Hardknox, Soundmine). It stays in the gitignored
  `public/sound/music/` (the user's own copy), plays only with `?music=1`, and the build removes `<outDir>/sound`
  (`tools/vite-orig-assets.mjs`). Never copy it into `public/assets` or a build.
* **Car brands**: the car names (Subaru, Mitsubishi, Peugeot, Ford, Audi, Lancia, …) and the manufacturer and
  sponsor liveries on the car textures are third-party trademarks.
* **Sponsor signage** in the track and object textures is third-party branding (e.g. the KONI boards and banners at
  the hillclimb-3b-f start).
* **Movies**: `MsIntro.bik` and `DiceIntro.bik` are publisher / studio intros.
* `vite build` copies the built `public/assets/` (~1.1 GB, including all of the above except the music) into
  `dist/`. The GitHub Pages workflow builds without assets, so the published site is procedural only. Clear the
  items above before shipping a build with the original assets.

## Verification (2026-10-30 integration pass)

All on the current tree, with every part built:

* `npx tsc --noEmit`: clean. `npx vitest run`: 51 files, 2 549 passed, 1 skipped. A CI-like copy (only the files
  git would commit: no `public/assets`, `research/`, `.cache/`, `original_version/`): tsc clean, 47 files passed,
  4 skipped (2 359 passed, 191 skipped), so the Pages workflow's `npm test` does not need the assets.
* `npm run smoke`: ok, all 10 checks (incl. overlapping stage loads and the keyboard-only audio start), 0 console
  errors or warnings.
* `npm run build`: ok. JS bundle 2.55 MB (chunk-size warning only); no `dist/sound`.
* `node tools/all-stages.mjs` (default car = Micra on its `Car_Micra.col` hull, autopilot, stepped): **48/48
  PASS**, 0 resets, 0 object hits, 0 console errors; clearance 0.28-1.86 m, max |lateral| 7.97 m (hillclimb-1c-f
  service park). Examples: corsica-1-f 3:02.911, corsica-3-f 2:39.338, hillclimb-3b-f 5:06.623, kenya-1-f
  3:37.146, newzealand-2-f 4:04.344, iceracing-1-r 10:19.821, rallycross-1-r 8:58.555
  (`artifacts/finish/default/summary.json`).
* `tools/assets/check-game.mjs` on all 48 stages with `car=ImprezaWRX` (3 s autopilot, chase camera): 0 console
  errors, 0 warnings; track, objects and environment loaded on every stage, S3TC path, 132-600 draw calls
  (`artifacts/assets-check/final/`).
* Browser `getCarInfo()` on kenya-1-f: no `?car=` → Micra (hull Micra, camera table Micra, voice on);
  `?car=AudiS1` → AudiS1; `?orig=0` → the awd_wrc archetype, procedural, no errors.
* The original effects part becomes active 0.1-2.8 s after `ready` (measured on 4 stages, machine under load);
  the 3 s countdown normally covers it.

## Open items (prioritised)

**P1: visible or audible differences from the original**

1. Water is brighter than the Screenshots (corsica-1/3, newzealand-2) and the rallycross-1-f horizon ring is grey,
   not sky blue. Shader, constants and pass states were re-traced and match the exe; candidates left: 2002 ps.1.1
   hardware behaviour, a volume-texture format, or a different screenshot build (docs/orig/track.md §7.4).
2. Loose parts (6 559 cones, signs, barrels) are passed through. The original knocks them over as light bodies
   (FUN_006d4390). Needs a dynamic-body hook (`OrigWorld.partsNear` already returns hulls, mass, yaw).
3. Drivers / co-drivers are not drawn; spectators and animals stand in their bind pose (`.ske` / `.baf` open);
   tree sway is not ported (31 templates, controller undecoded).
4. Damage: morph target uploaded but not driven, no broken lamps / glass, no glass-break particles, damage off in
   the sim (law not found). Dirt accumulation: factor stays 0.
5. Menus: `Menu.rff` screens and 3-D garage, locale strings, HUD art; movies (`.bik`).
6. No AI opponents (`AI.con`, `AiData.con`, split-time tables, the AI friction mode); the ghost is silent.
7. Snow flakes look fainter than in the 3b-f / 3c-f Screenshots (D3D8 point-sprite mip choice untraced).
8. High-detail shadows (ShadowGen / ShadowApply) and the dynamic car env cube are not ported; car LOD is chosen by
   distance.

**P2: values inferred or calibrated where the exe was not traced**

9. Wheel FX slip and bump inputs (effects c_WheelXSlip / c_WheelZSlip, audio SlipX / SlipZ / bump) use
   |tan α|, |κ| and suspension extension; sprite extents (XYSizeRatio·size × size); lens flare size law; ghost
   material; car `envmapColorScale` / `metallicSpecularScale` bindings; `reflectivityScale` not applied.
10. Sim: the material-0x23 branch, the impact-effect outputs B+0x190..0x1d0 (sparks, scrapes), the corner states
    phys+0xa8..0xb4 (original 4, port 1), the bush drag on phys+0x28 (flag ported, drag not), car-car response
    (FUN_004a7980 → FUN_006d4390).
11. Object pass approximations: the car box from its hull points (export the car geometry's render box to the
    sim params instead), candidates by placement index, immediate refresh on reset.
12. Race: the countdown writer (3 s from the images and sounds), the splineRange → +0x174 link [I], `race.distance`
    and race+0xa0c, the spline-distance function past the spline end, the pre-running road-edge check and AI stuck
    rule, one trigger per frame in the original. Default car Micra [I]: the Menu.rff `playerCarName` list starts with
    Micra, but the index's initial value is not decoded.
13. Audio: Error.ssc trigger (FUN_00633ab0), the team-coach samples 42..92, music order rule and the menu /
    pre-race tables, options sliders fixed at 1, CarSoundPlayer / ambience update rate, co-driver layer (2-D, 0.92),
    checkpoint stinger meaning, blow-out speed sign. The first menu key's own Step sound is lost while the bank
    loads; the stage ambience and engine are audible behind the boot menu once audio has started.
14. Environment: flare and weather alpha ops, weather texture switch, cloud upload format and the white cloud
    fog, HotSpot reference point (camera vs car); objects: view-distance factor q = 1, zone distance from the
    camera, filters; cars: camera-table `flag` meaning and the CarCamera attach offset (recorded, not applied).

**P3: accepted deviations, performance, tooling, docs**

15. Leaves: core / soft-edge split can blend soft edges of different templates in the wrong order; the GREATER 0
    StandardMesh change was spot-checked on kenya-1-f and hillclimb-1a-f only; the 4096-objects-per-frame cap is
    not enforced.
16. Track: far-plane `discard`, analytic half-vector cube, GeForce-style ps.1.1 saturation; up to 260-600 draw
    calls for the track (one per submesh and pass, as the original).
17. Particles sorted per template batch (the original sorts all together); hasCollisionPhysics bounce on a flat
    plane; fresh template set per stage; `useGradiantLighting` / `useShimmer` not ported.
18. Restart in place keeps the collision face cache (as the original), so it is not bit-identical to a fresh load.
    The ghost car is not awaited (its stand-in is hidden while it loads; never seen in a browser run). The stage's
    original effects load after `ready` (up to ~3 s): with `countdown=0` the first seconds use the procedural
    particles; the original loads them with the race.
19. TextureStore keeps up to 96 MB of the previous stage's textures until the next load finishes. The JS bundle is
    2.55 MB (Vite chunk-size warning).
20. Autopilot: could use `objectCollidersNear` instead of the cylinder hints; kenya-3-f/r run 2.4 / 4.7 s slower
    since it steers round bushes; the post-finish run-out is port behaviour. `drive.mjs` with countdown=0 logs two
    'go' events (harmless).
21. Sim leftovers: Arcade drift preset bands relaxed in tests (retune the preset), `CarParams.bodyGroundShare`
    unused, procedural solids map to material 255, DUMMY (23) gives no wheel contact, `research/frida/emu_body.py`
    needs unicorn (not in `.venv`).
22. Research docs: close gcm.md §10.2 (the users of physics+0x8c are FUN_006d1a80 via the object pass); answer
    standardmesh.md §9 Q2 (CollisionMesh.Simple stores inward normals; the BSP pad is the material output);
    fold the sound.md "Port findings" into its body.
