# PROGRESS: porting `original_version/` to rally-web

**Target: a full faithful port.** The browser build must be the same game: same handling, tracks, timing and
sounds, and the same look (the original meshes, textures, liveries, sky, lighting, water, UI). `original_version/`
is our own game (`AGENTS.md`), so its assets are in scope, apart from the third-party content listed under
"Legal caveats". The 7 procedural stages stay as the handling lab and the no-assets fallback. Status as of
2026-10-31 (phase 2 integrated: AI opponents, ghosts, car-car contact, railings).

**Legend:** ✅ done · 🟡 done with open items · ⬜ not started

## Build and run

```
npm install
npm run dev                       # http://localhost:5173 (procedural visuals until the assets are built)

# original assets (needs original_version/ to rebuild) → public/assets/ (tracked in git, ~1.1 GB; the CI deploy ships it)
uv venv .venv && uv pip install -r tools/assets/requirements.txt     # once: numpy + Pillow
npm run assets                    # all phases: 48 stages, 29 cars, global audio + effects
npm run assets -- --stages kenya-1-f --parts track,objects           # rebuild only what changed
npm run assets -- --cars all --parts cars
npm run assets -- --list          # parts, stage ids, car names
npm run assets -- --selftest      # pipeline self-check (~15 s)
```

New or rebuilt files under `public/assets/` must be `git add`ed before deploying (see the phase-2 repo note in section 13).
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
| `touch=1` / `touch=0` | force the phone / tablet touch controls on or off (default: on for a coarse pointer or after a touch) |
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
| 13. Phase 2: AI opponents, ghosts, car-car contact, railings | ✅ ported, 🟡 inferred values (section 13) | `src/game/{ai,ghosts,field,grid}*`, `src/sim/contact*`, `parts/{ai,ghosts}.py`; docs/PHASE2_AI.md, docs/orig/{ai,ghosts}.md |
| 14. Gravel friction audit (2026-10-31) | ✅ fixed, 🟡 open items (section 14) | `src/sim/{params,inputFilter,car}.ts`, `research/tools/{emu_step,emu_keys}`, `research/frida/regress.audit.ts` |

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
* Railings fixed (phase 2): the object pass gates only TreeMesh instances on the tight trunk radius and every other mesh object on its
  bounding sphere [E 0x4a7fb3], so fences, walls and rails are hit anywhere along their span (docs/orig/collision.md 4.1).
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

Phones and tablets (a rally-web addition, `src/ui/touch.ts`): floating analog steering pad on the left half or tilt
steering, GAS / BRAKE / HAND BRAKE pedals bottom right (slide between them), pause / camera / look back / reset /
fullscreen buttons, manual gear + / −; compact touch HUD and finger-sized menus; upright phones pause with a
turn-sideways banner; first tap asks for fullscreen + landscape (Android), `manifest.webmanifest` for Add to Home
Screen (iPhone). Checked in Chromium phone emulation only, not yet on real devices.

### 12. Movies ⬜

`original_version/Movies/*.bik` (29 files) not transcoded. MsIntro / DiceIntro need clearance first (below).

### 13. Phase 2: AI opponents, ghosts, car-car contact, railings 🟡

Scope of the round (the user's choice): AI opponents, ghosts including the shipped team ghosts, and the railing collisions. Plan, ownership,
decisions and the final state: `docs/PHASE2_AI.md` (section 0). Specs: `docs/orig/ai.md`, `docs/orig/ghosts.md`, `docs/orig/race.md` 9a,
`docs/MECHANICS_SPEC.md` Appendix D, `docs/orig/collision.md` 4.1. Tags: **[E]** exe-verified, **[D]** data-verified, **[I]** inferred.

**AI opponents (ported)**
* The original controller: low level FUN_007e0540, per frame FUN_00607280 / 00607ae0 / 00609550, run at the game's 24-bit x87 precision
  (`src/game/ai/{ctrl,aicar,driver,aidata}.ts`). Proof **[E]**: executed in unicorn, 6 000 controller vectors and 3 200 per-frame cases
  bit-identical. Against the Frida runs (open loop) throttle / brake bands match on about 76-78 % of steps and steering on 54 % (limit-cycle
  phase); the AI tyre-friction mode matches to a one-step |v| error of 7e-7.
* Data **[D]**: asset part `ai` = the 804 AiData posts / 39 827 samples of the 48 stages (`stages/<id>/ai.json`) and the AiTimes schedule
  (`global/ai.json`).
* Race: the original start grid (FUN_00484640, executed in unicorn **[E]**, 546 slots, 4.8e-4 m), roster from the career events (3 opponents, as
  every original event), `CarField` (tracking, laps, finish, recovery, standings), HUD position box and strip, results table, per-car SoundAI
  voices, menu Opponents row (`None / 1 / 2 / 3`, `?ai=0..3`; disabled without an event or without the assets).
* Played to the finish in the browser, 3 AI each: corsica, hillclimb, rallycross and ice racing, 0 AI resets; AI cars scrape railings but do not
  break through (0 resets, |lateral| at most 7.8 m on 3 stages). A solo AI car finishes 46 of 48 stages.
* Inferred **[I]**: AI skill per car and the difficulty-to-tyre-scale map are 1.0 (not in any data file; the Frida recording fits 0.70-0.75), the
  spin-recovery trigger (+0x54) is undecoded (`AiDriverX.setRecovery` exists and nobody calls it), the human as owner of the rubber-band mailbox
  (a slow human makes the AI finish about 1:52 against 1:27-1:39 without the feed), and the player's grid index (0, left column, front row).

**Ghosts (ported)**
* The exe's 2.0 / 3.0 file format (`src/game/ghosts/format.ts`): all 30 team ghosts / 39 710 frames decode with 0 mismatches, 317 440 playback
  ticks bit-exact, 3 030 encode cases byte-identical **[E]**. Tick-exact player (FUN_004db730) and recorder (FUN_004db540).
* The 30 shipped team ghosts on 26 stages (asset part `ghosts`, `global/ghosts.json` + `global/ghosts/*.bin`), saved ghosts (IndexedDB, with a
  memory fallback only when the database cannot be opened; a quota error on a write now reports "not enough space"), SAVE GHOST / Delete, the menu
  Ghost row (Off / Best run / team ghost / saved), the best run kept as a 3.0 file. A hold frame at index 0 plays one period, as in the original
  (research/formats/ghosts.md 3.3 **[E]**).
* Inferred **[I]**: the ghost's look (alpha 0.35, environment-only pass), that it is first drawn at GO (the exe plays it in race state 5; whether a
  parked ghost is drawn before GO is undecoded). Unresolved: the team-ghost start offsets (1.6-24 m from the centre-line pose, not multiples of
  the 6 m row spacing) are not explained by any grid slot, so how the original times the split triggers for a ghost is open; the port keeps the
  stage's gate positions.

**Car-car contact (ported)**: FUN_004a7980's pair loop and the body solver FUN_006d4390 / 6d4fd0 / 6d5240 on the real 18-point `Car_<Name>.col`
hulls (`src/sim/contact*`). 8 000 unicorn cases / 3 928 contacts 0 mismatches; the Frida run-2 trace's 271 contacts agree to 2.7e-4 m/s **[E]**.
Writes the car-car collision record the impact sound reads. The race logic now reads the telemetry after the contact step (as the original runs its
race logic after contacts; a stale-read bug found in QA, fixed with a regression test).

**Railings (fixed)**: the object pass has two gate branches in the exe (0x4a7fb3): only TreeMesh instances use the tight trunk radius, every other
mesh object gates on its bounding sphere **[E]**, so fences, walls and rails are hit anywhere along their span (docs/orig/collision.md 4.1).
Proof: 41 % -> 0.26 % pass-through of wall-like faces over 77 350 independent drives; a regression test drives a real Micra at 40 and 140 km/h
into the middle of a panel on 6 families (hillclimb-3a-f, kenya-1-f, newzealand-1-f, rallycross-1-f, iceracing-3-f, corsica-3-r) on the built
collision packs and requires the car to be held at the face (a mutation check with the old single-branch gate fails 10 of 12). A QA matrix of 48
browser drives found 0 crossings when each pair of trace positions was tested against every nearby triangle. The rest of what the matrix showed
(a hard launch at the corsica-3-r bank, a car lying against a rail with a rising hit counter) is the bank geometry and the original's per-substep
object record, not a railing defect (docs/orig/collision.md 4.1); a Frida trace of the original would settle the launch **[I]**.

**Verified**: see "Verification (2026-10-31)" below.

**Repo note (do before deploying)**: `public/assets/` is tracked in git (the CI deploy ships it, and CI runs `npm test` on the checkout). The
phase-2 parts are new, untracked files: `stages/<id>/ai.json` x48, `global/ai.json`, `global/ghosts.json`, `global/ghosts/*.bin` x30 (80 files),
plus the modified manifest and `collision.{bin,json}` of all stages. `git add` them, or the deployed game races solo (the field logs one info
line and starts without opponents), has no team ghosts, and the manifest test and two `ai` part tests fail in CI.

### 14. Gravel friction audit (2026-10-31) 🟡

Trigger: the user reported that gravel friction does not feel identical. Two audit rounds, no change to the tyre model itself: the gravel rows,
tyre functions and mu getters were already equal to the exe. Tags as in section 13.

**What was checked**
* Frida run 2 (rallycross1, tyre 1): all 168 399 gravel wheel-steps are grip mode, mu 1.71, no handbrake, |beta| under 3.4 deg. So sliding, handbrake,
  tyres 0-4 and the loose materials had never been compared with the running original.
* **Emulator proof of the untraced regimes [E]**: the exe's own car step FUN_006c6760 (whole callee tree, x87 control word 0x7F) is executed in unicorn on
  states rebuilt from the trace snapshots (`research/tools/emu_step/`, README there). It reproduces 99.9 % of 20 000 recorded post-states bit for bit.
  On 28 700 synthetic cases (sliding, handbrake, large beta, launch, lock-up, tyres 0-4, 10 loose materials) the port equals the exe, once DEV-1
  is off, to 3.4e-6 m/s per step with the trace's float32 parameters and 7.4e-6 m/s with the shipped decimal ones (float32 rounding of the
  constants; `fround` on every parameter brings it back to 3.4e-6), 0 tyre-mode mismatches, 14 chained 3 s runs within 6.6 mm.
* Parameter parity of the 29 cars and the surface and tyre tables (lanes param-parity, loose-surfaces), the input path (keyboard executed through
  FUN_005b6290 -> FUN_005b65b0 -> FUN_00752c00, `research/tools/emu_keys/`), the game options (steering, tyre) and a closed-loop comparison.
* Whole-run one-step gate: the port against the recorded run 2 post-state on all 281 290 steps (124 096 with a wheel on gravel; 638 hull-contact
  steps left out): `research/frida/regress.audit.ts`.

**Found and fixed**
* **DEV-1 off by default** (`assist.bigBetaSymmetric = false`): the exe gives the big-beta grip bonus only for signed beta > 0.75 (asm 0x6cbb49-0x6cbb99);
  the port gave it to both slide directions. Flag on: up to 0.063 m/s per step (0.046 on gravel, tyre 2) and 0.92 m / 11 deg after a 3 s handbrake
  turn on sand (`research/tools/emu_step/out/mutations.json`, `chaincmp.bigbeta.json`); flag off: the float32 floor above.
  Kept as an opt-in toggle. Test: default has no bonus at beta -1.0, has it at +1.0, and the flag gives both.
* **Both steer keys held**: the exe steers toward Right (FUN_005b65b0 tests the positive key first); the port centred, so a fast gravel counter-steer
  flick pulsed the steering to 0 for the frames of key overlap. `inputFilter.ts`: `dir = raw.right ? 1 : raw.left ? -1 : 0`; fuzz-equal to the exe
  afterwards. d-pad uses the same `left` / `right`; touch and sticks use the analog path (unchanged).
* **Bump-surface phase** (car.ts `bumpPhase`, `worldOffX/Z`): the sink of the bumpFlag surfaces (orig 0, 6, 9, 11-14, 18, 19, 22; not gravel) takes the
  phase of the float32 ray-end coordinate in the original world frame with FUN_006cfad0's 24-bit products; the port used an exact float64 fmod, off by up to
  1.6e-4 m of extension / 59 N. `bumpPhase` is bit-equal to the executed function on 1 039 cases (`tests/sim/bumpPhase.test.ts`); 657 of 658 outliers gone.
  The live sim adds the track translation (2048, ., 2048) [E on rallycross1 only, research/formats/gcm.md: 1.2 M rays; assumed for the other
  stages]. 2048 m is a whole number of 0.2 m cells, so a different offset could only move the phase by float32 rounding, as before the fix.
  The car-level wiring is checked by `research/frida/bump.audit.ts` only.
* `research/study/physics_values.md` section 7: the steering option is `(v != 0)` (asm 0x499c68-0x499c7b), 0 = Slow ("loose"), 1 = Fast ("tight", default).
  The port's default (Fast) was already right.
* Replay harness: `Replayer` takes the hull from P+0xa4 (TRACE_CARS: FordEscort, Micra, Beetle, Corolla) and runs in the trace frame (worldOff 0).

**Benign (residual classes, run 2 against the exe, after the fixes)**: on gravel steps one-step |v error| p50 6e-7, p99.9 2.4e-6 m/s. 8 steps in 281 290 differ
by more than 1e-5 m/s, all float32 gates the port cannot reproduce without a float32 quaternion / axes / velocity pipeline: the W18 side-fill gate
|Vy| > 0.0625 (5 steps, 3 on gravel, up to 1.6e-2 m/s for one step, unbiased), the body slip angle at a standstill after the finish (vL.z about 1e-9: 3
steps, none on gravel) and one bump-surface ray end one float32 ulp across a phase edge (idx 4812). Allow-list in `regress.audit.ts`; nothing lasting.

**Open**
* Bush drag (PhysCar+0x28 / +0x2c, 0x6cd3d9): the formula is executed-proven (drag = elastic 0.6 x 0.85 x (km/h/240 x 0.125 + 0.15) x Fext.y x vL at the
  hull bottom centre, one shot per substep, 6 900 states, 4e-6 m/s) but the object-pass gate (0 < e < 1, bush origin within 2 m, TreeMesh) needs
  the placement origin and `knbush1` is a hard collider in the port; **not applied**. Real effect: about 0.1 to 0.5 m/s per substep while brushing a roadside bush.
* The analog pedal dead zone 0.08 is a port choice for gamepads (the exe passes pedals through raw); keyboard is unaffected.
* Which race-start tyre writer wins (FUN_00488590 or FUN_00499ab0) is unrecovered; the port starts each stage on its stage-default tyre. Tyre 1 vs 2 on
  gravel is mu 1.710 vs 1.775.
* The menu says Stable / Agile where the original says loose / tight; the port does not persist the pre-race selection across reloads (the original has
  save / load car settings).
* No Frida trace of tyre 2, sand or mud exists; those regimes are proven only through the emulator.
* The audit harnesses (`research/tools/emu_step/`, `emu_keys/`, `research/frida/*.audit.ts`) live under the gitignored `research/`, so they
  are local only and not run in CI.

## Corrections to earlier notes

* `fogzor.rff` is **TrackFogSettings** (the per-stage low-detail fog scripts the environment resolver loads first),
  not a dev test level.
* The per-car engine / pipe WAVs are in **Audio.rff** (`sound/44khz/…` holds every sample). `Cars.rff` only has the
  `.ssc` scripts.
* There are **29** original cars, not 33.
* `original_version/Sound/Music/` holds **14** WAVs, not 13: the exe's tables reference 11 (10 in-game, of which 3
  are also the menu table, plus 1 pre-race); the three Big Idea tracks are referenced by no table.
* The live gamma delta is the stage's scripted `trackGammaDelta`, not 0 (environment.md §5).

## Research from a stopped spec round (unverified, for future rounds)

A spec round for the next scope (menu art, replays, movies, damage) was stopped part way. Its partial output is in the tree and is **unverified**:
notes and dumps `research/formats/meme.md`, `meme_*.json` (classes, bindings, fonts, load order, dump), `dynamics.md`, `replay.md`
(+ `replay_dump.json`, `replay_tvcam_cases.json`), `movies.md` (+ `movies_dump.json`), `damage_dump.json`; extraction and analysis scripts
`research/tools/*` (e.g. `fmt_meme.py`, `fmt_anim.py`, `fmt_bink.py`, `damage_survey.py`, `anim_census.py`); and format readers
`tools/assets/lib/formats/{fmt_meme,fmt_anim,fmt_font,fmt_bink,fmt_replay}.py` (not wired into `build.py`). Treat the claims as leads, re-check
against the exe before relying on them. (`dynamics.md` 6-7 was used and verified for the car-car contact; the rest was not.)

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
  `dist/`. Since commit 933bf35 `public/assets/` is tracked in git and the GitHub Pages workflow (push to main)
  deploys it, so a push publishes the original assets with the third-party content above. Clear the items above
  before pushing.

## Verification (2026-10-31, final acceptance of phase 2; the 2026-10-30 pass below is the pre-phase-2 baseline)

Run on the final tree with every asset part built:

* `npx tsc --noEmit`: clean. `npx vitest run`: 75 files passed, 1 skipped; 2 820 tests passed, 3 skipped. The first full run had one failure, the
  contact allocation test (heap growth 15 MB under full-suite load; passes alone). It is now best-of-3 windows; the second full run is green.
* `npm run smoke`: `"ok": true` (testpad drive 63.2 km/h, moved 29.3 m, 0 ignored console messages).
* `npm run build`: ok; JS 2.65 MB (chunk-size warning only); `dist/assets/global/{ai.json,ghosts.json,ghosts/}` and `stages/<id>/ai.json`
  shipped; no `dist/sound`.
* `node tools/all-stages.mjs --jobs 6 --shots 0 --out artifacts/phase2/final/all-stages` (solo, autopilot, Micra): 48 / 48 PASS, 0 resets,
  0 object hits, 0 console errors, max |lateral| 8.06 m.
* Browser play-through through the real menu (`node artifacts/phase2/integrate/play.mjs --only menu-ai,menu-ghost,team-ghost,disciplines,orig0,solo
  --out artifacts/phase2/final`): ALL OK, 53 checks, 0 console errors or warnings. Screenshots in `artifacts/phase2/final/` (looked at: mid-race
  HUD with position strip, results card with the standings table, own-ghost race, team ghost on hillclimb-2c-r, rallycross and ice-racing finishes).
  * corsica-1-f: Micra autopilot 3:03.322; Audi S1 / Metro 6R4 / Delta S4 finish 1:51.924 / 1:53.263 / 1:55.344, 0 resets.
  * hillclimb-1a-f: AI 137.9 / 141.6 / 140.2 s, player 198.5 s; rallycross-1-f: AI 306.9 / 303.1 / 309.5 s, player 461.9 s; iceracing-1-f:
    AI 298.3 / 291.0 / 295.4 s, player 661.4 s; all finish, 0 AI resets.
  * own ghost from the results Restart; team ghosts kenya-1-f (JeffP, Lancer EVO 6.5b 1:51.945) and hillclimb-2c-r (Delta S4 1:18.411);
    restart, main menu and stage change leave exactly the new roster; `?orig=0` plays (Opponents row disabled); Opponents None + Ghost Off = solo.
* Railings: `tests/sim/objectPass.test.ts` (20 / 20): a real Micra on the built collision packs into the middle of a railing panel at 40 and
  140 km/h, 6 families (hillclimb-3a-f, kenya-1-f, newzealand-1-f, rallycross-1-f, iceracing-3-f, corsica-3-r), held at the face every time.
  This is a unit-level drive on the real packs, not a browser drive.
* Not re-run in the final pass (rest on the builders' and integrator's reports in `docs/PHASE2_AI.md` 0.3): the memory (5 stage loads + 12 restarts,
  heap +4.5 MB) and frame-rate runs (4 cars 0.89x, 4 cars + ghost 0.79x of solo, SwiftShader), the asset builds `ai` / `ghosts`, the
  unicorn proofs, and the CI-like copy (tsc clean, 72 files passed / 3 skipped).

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
6. AI and ghost values that are still guesses (section 13, docs/PHASE2_AI.md 0.5): AI skill per car and the difficulty-to-tyre-scale map
   (both 1.0 in `roster.ts` skillOfGroup / AI_TYRE_SCALE; the Frida recording fits 0.70-0.75), the spin-recovery trigger (+0x54; `setRecovery`
   has no caller), the ghost's look and whether it is drawn before GO, the player's grid index and the team-ghost start offsets (see
   section 13). Visible effect: AI cars finish noticeably faster than the original's likely pace when the human is slow.
7. Snow flakes look fainter than in the 3b-f / 3c-f Screenshots (D3D8 point-sprite mip choice untraced).
8. High-detail shadows (ShadowGen / ShadowApply) and the dynamic car env cube are not ported; car LOD is chosen by
   distance.

**P2: values inferred or calibrated where the exe was not traced**

9. Wheel FX slip and bump inputs (effects c_WheelXSlip / c_WheelZSlip, audio SlipX / SlipZ / bump) use
   |tan α|, |κ| and suspension extension; sprite extents (XYSizeRatio·size × size); lens flare size law; ghost
   material; car `envmapColorScale` / `metallicSpecularScale` bindings; `reflectivityScale` not applied.
10. Sim: the material-0x23 branch, the impact-effect outputs B+0x190..0x1d0 (sparks, scrapes), the corner states
    phys+0xa8..0xb4 (original 4, port 1), the bush drag on phys+0x28 (flag ported, drag not; the drag formula is proven, the object-pass gate is not, section 14). Car-car response
    (FUN_004a7980 → FUN_006d4390) is ported and proven (section 13).
11. Object pass approximations: the car box from its hull points (export the car geometry's render box to the
    sim params instead), candidates by placement index, immediate refresh on reset. The object pass runs per car before the car-car
    contact step (the original interleaves them per car), and the contact port is float64: about 1.7 % of touching substeps in the Frida
    trace (shallow piles, face-on-face ties under 2 mm) pick the other plane owner than the float32 exe did (no float32 mode).
    A hard hit launches the car high (median rise 3.8 m at 140 km/h head-on into the riot fence; the corsica-3-r bank launch): the
    gate and solver are exe-verified so this is probably faithful, but a Frida trace of the original hitting a fence or that bank would
    settle it. AI cars scrape long rails (hillclimb-2b-f Skyline: 336 hit substeps; `objectHits` counts substeps, like the original's
    per-substep record): not compared with the original AI.
12. Race: the countdown writer (3 s from the images and sounds), the splineRange → +0x174 link [I], `race.distance`
    and race+0xa0c, the spline-distance function past the spline end, the pre-running road-edge check and AI stuck
    rule, one trigger per frame in the original. Default car Micra [I]: the Menu.rff `playerCarName` list starts with
    Micra, but the index's initial value is not decoded.
13. Audio: Error.ssc trigger (FUN_00633ab0), the team-coach samples 42..92, music order rule and the menu /
    pre-race tables, options sliders fixed at 1, CarSoundPlayer / ambience update rate, co-driver layer (2-D, 0.92),
    checkpoint stinger meaning, blow-out speed sign. The first menu key's own Step sound is lost while the bank
    loads; the stage ambience and engine are audible behind the boot menu once audio has started.
13b. Phase-2 plumbing leftovers: `getAssetManifest()` (src/core/assets.ts) caches null for the session after one failed manifest fetch, so a
    transient error drops AI, ghosts and every original asset until reload; `IMenuHost.saveSessionGhost` returns a boolean (the menu maps
    save failures itself); the `overtake` FieldEvent is declared and never emitted; renderer `CarEntry.ai / carIndex` are stored and
    unused; `GhostListEntry` has no driver field; the unicorn harnesses of the older proofs (`research/tools/contact_emu.py`, `emu_dyn.py`,
    `research/frida/emu_body.py`) never set the x87 control word (they ran at extended precision, the game at 24-bit; difference about 1e-7
    relative, inside the tolerances: re-run with FPCW 0x7f to tighten them). The autopilot can be shoved off the road by AI cars at the
    start (it does not avoid them; one Saab93 run needed a reset).
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
19b. Menu: with a best time on the stage, the BEST label next to the Back button is clipped (shows '3:03') in the main menu reached from
    the pause menu; the HUD of a paused race (position box, strip) shows through the shade. Perf-budget tests (`tests/sim/ground.test.ts`
    step cost, `tests/world/stages.test.ts` pine-ridge build time, the contact allocation test, now best-of-3) can fail when the machine is
    saturated, and the browser tools and smoke are wall-clock dependent (they failed at load 100-250 in the builders' runs).
20. Autopilot: could use `objectCollidersNear` instead of the cylinder hints; kenya-3-f/r run 2.4 / 4.7 s slower
    since it steers round bushes; the post-finish run-out is port behaviour. `drive.mjs` with countdown=0 logs two
    'go' events (harmless).
21. Sim leftovers: Arcade drift preset bands relaxed in tests (retune the preset), `CarParams.bodyGroundShare`
    unused, procedural solids map to material 255, DUMMY (23) gives no wheel contact, `research/frida/emu_body.py`
    needs unicorn (not in `.venv`).
22. Research docs: close gcm.md §10.2 (the users of physics+0x8c are FUN_006d1a80 via the object pass); answer
    standardmesh.md §9 Q2 (CollisionMesh.Simple stores inward normals; the BSP pad is the material output);
    fold the sound.md "Port findings" into its body.
