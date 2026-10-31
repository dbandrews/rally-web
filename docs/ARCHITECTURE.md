# rally-web architecture

rally-web is a **full faithful port** of the author's original Refractor2-engine rally game
(`original_version/`, not in git) to the browser: the handling follows `docs/MECHANICS_SPEC.md` (the
normative mechanics; "§" below points there), and all 48 original track archives are ported with their
real splines, elevations, widths, checkpoints and timing (`src/world/ports/` +
`src/world/portedBuilder.ts`). The port targets identical look and sound as well — the visual/audio asset
port is tracked in `PROGRESS.md` (roadmap + status). Stack: Vite 8, TypeScript 7 (native `tsc`), three 0.186,
lil-gui, vitest, Playwright.

## 1. Module map and ownership

Four builders work in parallel (the asset-port phase: nine, see §1.1), each in its own directories. **Only edit files you own.** Everything in
`src/core/` is the shared contract. If you need a contract change, keep going with a local workaround
and report a *contract request* (what, why, proposed signature); the architect applies it.

| Path | Owner | Contents |
|---|---|---|
| `src/core/` | architect (read-only for builders) | `types.ts` (all interfaces), `constants.ts` (ids, metadata, original material / car ids, neutral inputs), `math.ts` (V3/Quat), `space.ts` (sim ↔ three mirror), `loop.ts` (120 Hz accumulator), `paths.ts` (dotted-path params), `stageUtil.ts` (spline → sim pose), `rng.ts` (seeded PRNG), `assets.ts` (original-asset manifest + fetch helpers, docs/ASSETS.md), `worldQuery.ts` (WorldQuery.segment adapters, face-cache slots, multi-level `yHint` rule) |
| `src/main.ts`, `src/style.css`, `index.html`, `vite.config.ts`, `tsconfig.json`, `package.json` | architect | wiring, base layout, config |
| `src/debug/testApi.ts` | architect | `window.__rally` test API |
| `tools/smoke.mjs`, `tools/drive.mjs`, `tools/lib/harness.mjs` | architect | headless tooling (builders may add their own scripts under `tools/`) |
| `tests/contracts/`, `tests/helpers/`, `tests/sim/flatworld.ts` | architect | cross-module contract tests and shared helpers (read-only for builders) |
| `tools/assets/` (`build.py`, `run.mjs`, `lib/**`), `src/render/orig/{index,common,textures,rtex,dxt}.ts`, `tests/assets/`, `tools/vite-orig-assets.mjs` | architect (asset-pipeline foundation) | original-asset build (`npm run assets`) and runtime loaders; per-part ownership (track, collision, objects, environment, cars, audio plugins + their `src/**/orig` modules) in **docs/ASSETS.md §10** |
| `src/sim/`, `tests/sim/` (except `flatworld.ts`) | **sim builder** | car physics §1-§2, parameters §3-§4, input filter §5.1 |
| `src/world/`, `tests/world/` | **world builder** | stage catalogue (7 procedural + 48 ported originals), procedural stages, the ported real track geometry (`ports/` data, `portSpline.ts`, `portedBuilder.ts`, `portedDefs.ts`), WorldQuery |
| `src/render/`, `src/audio/`, `tests/render/` | **render builder** | Three.js scene, cars, cameras §5.3, effects; synthesised audio |
| `src/input/`, `src/game/`, `src/ui/`, `src/debug/` (except `testApi.ts`), `tests/game/` | **game builder** | devices, race controller §5.4/§5.7, autopilot, HUD, menu, tuning panel §6, telemetry overlay |

Import rule: builder modules import **only `src/core/` and their own directory**. `main.ts` is the
only integrator (it imports every module's required exports). The architect's contract tests import
across modules on purpose.

**Original assets** (docs/ASSETS.md): `npm run assets` converts `original_version/archives/*.rff` into the
gitignored `public/assets/` (manifest + per-stage / per-car / global parts + `.rtex` textures). At runtime
`src/core/assets.ts` reads the manifest; `GameRenderer.loadStage` shows `OriginalStageView`
(`src/render/orig/`) instead of the procedural terrain / road / scenery when a ported stage has render parts,
and `main.ts` passes every built stage through `attachOriginalWorld` (`src/world/orig/`). Without the packs or
with `?orig=0` everything stays procedural, silently.

Status: the integration pass is done (all four modules are real implementations). The original-asset
modules under `src/render/orig/`, `src/world/orig/` and `src/audio/orig/` are documented stubs for the asset
phase (docs/ASSETS.md §10). The
ownership table still says who designed what; whoever changes a module keeps its REQUIRED EXPORTS and the
contract tests green.

Each builder file starts with a header listing its **REQUIRED EXPORTS**. Keep those names and
signatures exactly. Add any number of extra files and internal exports inside your directory.

### 1.1 Ownership in the original-asset port phase (nine parallel builders)

The table above records who designed each module. During the asset-port phase nine builders work at the same
time in the same tree; **this** table says who may edit what. Anything not listed is foundation: change it only
through a contract request (what, why, proposed signature) to the architect / integrator. `PROGRESS.md` is
consolidated by the integrator from the builders' results — builders do not edit it.

| builder | owns |
|---|---|
| **track** | `tools/assets/parts/track.py`; `src/render/orig/track*.ts` (+ `src/render/orig/shaders/track*`); the track's water surfaces (`Water.*` settings, environment.md §3.7); `tests/render/origTrack*.test.ts`; `docs/orig/track.md` |
| **collision** | `tools/assets/parts/collision.py`; `src/world/orig/**`; `tests/world/orig*.test.ts` + `tests/world/fixtures/orig/**`; `docs/orig/collision.md` |
| **objects** | `tools/assets/parts/objects.py`; `src/render/orig/objects*.ts`; `tests/render/origObjects*.test.ts`; `docs/orig/objects.md` |
| **environment** | `tools/assets/parts/environment.py`; `src/render/orig/environment*.ts`; `src/render/sky.ts`; `src/render/weather.ts`; in `src/render/renderer.ts` only the colour-pipeline / fog / light / sky code of `loadStage` and the per-frame render call; `src/render/cameraRig.ts` only for a proven FOV fix; `tests/render/origEnvironment*.test.ts`; `docs/orig/environment.md` |
| **cars** | `tools/assets/parts/cars.py`; `src/render/orig/car*.ts`; `src/render/carVisual.ts`, `carModel.ts`, `livery.ts`; `src/sim/origCars.ts` and `src/sim/presets.ts` (car data); in `src/render/renderer.ts` only `addCar` / `removeCar` and car-visual code; in `src/main.ts` only car selection / preset application / `listCars`; `src/ui/menu.ts` (car list); `tests/render/origCar*.test.ts`; `docs/orig/cars.md` |
| **audio** | `tools/assets/parts/audio.py`; `src/audio/**`; `src/ui/voice.ts`; in `src/main.ts` only the audio call sites (incl. `origCar` in the FrameContext literal); `tests/audio/**`; `docs/orig/audio.md` |
| **effects** | `tools/assets/parts/effects.py`; `src/render/effects.ts`; `src/render/orig/effects*.ts`; in `src/render/renderer.ts` only the effects call sites; `tests/render/origEffects*.test.ts`; `docs/orig/effects.md` |
| **race** | `src/game/**`; `src/world/portedDefs.ts`, `portedBuilder.ts`, `portSpline.ts`, `src/world/ports/**`, `src/world/stages.ts`; `research/tools/port_tracks.py`; `tools/all-stages.mjs`; `tests/game/**`; `tests/world/ported*.ts`, `tests/world/stages.test.ts`, `tests/world/spline.test.ts`; `docs/orig/race.md` |
| **sim** | `src/sim/**` except `origCars.ts` / `presets.ts`; `tests/sim/**` (except the architect's `flatworld.ts`); `research/frida/**`; `docs/MECHANICS_SPEC.md` |
| foundation (contract requests only) | `src/core/**`, `src/render/orig/{index,common,textures,rtex,dxt}.ts`, `tools/assets/{build.py,run.mjs,lib/**}`, `docs/ASSETS.md`, `docs/ARCHITECTURE.md`, `tests/contracts/**` |

Phase-0 contract changes every builder builds on (details in §4 and the doc comments in `src/core/types.ts`):
23 surfaces = one per original material (§2 "Materials"); `WorldQuery.segment` + the optional `yHint` +
`RayHit.{t, depth, cos, origMaterial, face}` + `CarSimOptions.slotBase` (§4 World); the original car identity
(`RaceSelection.car`, `AddCarOptions.origCar`, `CarRenderState.origCar`, `FrameContext.origCar`,
`CarListEntry` + `IMenuHost.listCars?`, `LaunchOptions.origCar?`, `LoadStageOptions.origCar?`, constants
`ORIG_CAR_IDS`); `Pacenote.origWords`.

## 2. Coordinate spaces (§1.1)

There are exactly two spaces. Every field in `types.ts` says which one it is in (`…Sim` names and all
`WorldQuery` calls are sim space; `Stage` geometry and render poses are three space).

| | **sim space** (physics, `WorldQuery`) | **three space** (Stage, rendering, cameras) |
|---|---|---|
| handedness | left-handed (the original's frame) | right-handed, Three.js |
| axes | x right, y up, **z forward** | x right, y up, car forward = **-Z** |
| position / direction / normal | `(x, y, z)` | `(x, y, -z)` |
| quaternion (w, x, y, z) | `q` | `(w, -x, -y, z)` |
| car body frame | right +x, up +y, fwd +z | car object local: right +X, up +Y, fwd -Z |

* Convert only with `src/core/space.ts` (`mirror`, `mirrorQuat`, `setThreeVec`, `setThreeQuat`). The mirror
  `M = diag(1, 1, -1)` is its own inverse.
* A heightfield query `heightAt(xSim, zSim)` equals the three-space height at `(x, -z)`.
* Sign conventions (sim): positive steer = right; positive yaw rate (ω.y) = nose right; β > 0 = velocity
  left of heading; `qYawSim(h)` heading 0 faces +z, positive turns toward +x.
* Stage conventions (three): `lateral > 0` = right of the travel direction (`right = cross(tangent, up)`);
  road `bank > 0` = surface tilts down toward the right edge; heightfield vertex `(ix, iz)` at
  `(originX + ix·cell, heights[iz·nx + ix], originZ + iz·cell)`.
* **Wheel order everywhere: 0 FL, 1 FR, 2 RR, 3 RL.**
* Wheel visuals (three): `pivot.rotation.y = -steerAngle`, `wheel.rotation.x = -spinAngle`; place the
  wheel at `WheelVisual.centreLocal` (three car-local).
* The body origin is the centre of mass, about 0.42 m above the ground at rest (§3.2). Car meshes are built
  around that origin; wheel centres sit near `y ≈ -0.12`.
* Materials: **one rally-web surface per original material** (gcm face byte / PhysicsParam.con row 0..22).
  Material id = index in `SURFACE_IDS` (0..9: tarmac, gravel, gravelDeep, mud, snow, ice, grass, sand, cobbles,
  water — unchanged; 10..22: wood, snowChunky, snowDeep, snowAsphalt, snowDitch, leaf, asphaltGrass,
  gravelGrass, mudGrass, mudDitch, sandDeep, sandDark, sandDarkDeep). Ids ≥ 32 = solid but not ground (wheels
  get no contact, §2.5.1 = the original's `(unsigned)mat >= 0x20` cut). 255 = none (= the original's −1).
  **Numbering trap:** the rally-web id is not the original byte (gcm 0 = GRASS, rally-web 0 = tarmac). Convert
  only with `constants.ts` `materialFromOrig(byte)` / `ORIG_MATERIAL_TO_MATERIAL` (256 entries; 23 DUMMY, 255 and
  every byte > 22 → `MATERIAL_NONE`) and `origFromMaterial(id)` / `SURFACE_ORIG_ID`; never pass a raw byte to
  `surfaceFromMaterial` or index `SURFACE_IDS` with it. Every `Record<SurfaceId, …>` table must list all 23.

## 3. Runtime loop (§1.2) and data flow

```
            once per rendered frame (requestAnimationFrame)
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ tick = FixedStepLoop.advance(wallDt)       frameDt = min(0.2, dt); acc += frameDt·timeScale │
 │ raw  = setRawInput override ?? InputManager.poll()          (UI edges handled by main)   │
 │ repeat tick.steps times (DT = 1/120):                                                    │
 │    controls = setControls override                                                       │
 │            ?? (race not controllable → parkedControls(): handbrake 1, §5.1;              │
 │                after the finish → runOutControls(): brake to a stop along the road)     │
 │            ?? Autopilot.update()            (if autopilot on)                            │
 │            ?? InputFilter.update(raw, DT)   (gear edges on exactly one substep)          │
 │    CarSim.step(controls, DT)                                                             │
 │    [AI cars: field.step → stepCarContacts(all cars), docs §10; no-ops when solo]         │
 │    RaceController.fixedUpdate(DT, telemetry)   (clock, checkpoints, resets, pacenotes)   │
 │    TelemetryOverlay.sample(telemetry)          (graphs on the sim clock, 60 Hz)          │
 │ render: pose = lerp/slerp(prevStepPose, curStepPose, alpha)  → mirror to three           │
 │    GameRenderer.update(frameDt, alpha, [CarRenderState])                                 │
 │    RaceController.frameUpdate; Hud / Menu / Overlay / TuningPanel / Audio .update(ctx)   │
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

* Physics never changes DT (§1.2: several terms are per-step). `timeScale` scales the accumulator.
* Pause stops steps; rendering and UI keep running (`ctx.paused`).
* Edges: `RawInput.gearUp/gearDown/cameraNext/pause` are true for one poll; main latches gear edges until
  a substep consumes them (no lost presses on frames with 0 steps).
* `RawInput.reset` is a level; main calls `race.requestReset('manual')` on its rising edge.
* Resets: whenever `telemetry.resetCount` changes, main snaps interpolation and sets
  `CarRenderState.justReset` for one frame (the camera snaps behind the car, §5.3).
* While the menu is visible main ignores the pause edge; the menu handles its own keys (Esc, Enter, P).
* `FrameContext.impactImpulseMax` = the largest `telemetry.impactImpulse` over the frame's substeps (audio
  reads it so a crash on an intermediate substep is not missed).
* Ghost car: `RaceController.ghostRenderStates(tel, alpha)` returns the race's ghost as a `CarRenderState` (id `'ghost'`;
  the stored best run, a shipped team ghost or a saved one, `RaceSelection.ghost`; drawn with the ghost FILE's car); main
  adds / replaces / removes the renderer car in `syncGhostCars` (`?ghost=0` disables it). The ghost is the original's
  15 Hz delta-coded file played tick by tick from GO (`src/game/ghosts/`, docs/orig/ghosts.md); `main.ts` awaits
  `race.prepareGhost(sel.ghost)` in loadSelection / restartInPlace so a team / saved ghost is in place at begin.
  Saved ghosts live in IndexedDB (`rally-web-ghosts`), the best-run ghost in localStorage (`rally-web:ghost:v3:`).
* M toggles audio (main owns the `AudioEngine`) and shows a toast; the menu's Sound row uses
  `IMenuHost.setAudioEnabled`.
* Window blur / hidden tab during countdown or running → `setPaused(true)` (pause card).
* main constructs `RaceController({ startGridBack: START_GRID_BACK_M })`: the car waits 8 m behind the start line
  so the start gantry is in front of the countdown camera (the controller's default, 0, keeps the contract
  behaviour for tests).
* A debug teleport (`teleport(s, lateral)`) marks the run untimed (`RaceState.untimed`) and records the gates it
  jumped over as NaN splits without events.

Construction order (main.ts): renderer, input, HUD, menu, overlay → first `buildStage` + `CarSim` +
`renderer.loadStage` + `race.begin` → **then** `TuningPanel` (so `host.getTunables()` is valid in its
constructor) → menu or countdown → RAF loop. A stage load creates a new `CarSim` (tuned parameters are kept
when the archetype is unchanged).

## 4. Contracts by module (see `src/core/types.ts` for the full documented types)

### Sim (`src/sim/`)
* `class CarSim implements ICarSim` — `new CarSim({ id?, params, world, surfaces?, seed?, slotBase?, origCar? })`
  (`origCar` = an ORIG_CAR_IDS name: the chassis probes use that car's `Car_<Name>.col` hull, src/sim/origHulls.ts;
  main.ts passes the selection's car and slotBase 0);
  `reset(pose, settleSteps = 100)` (zero state, then settle with handbrake 1.0, §1.2; with DEV-9
  `assist.settleToEquilibrium`, on by default, sleep is held off until the body stops bouncing, so the car rests
  at its spring equilibrium; up to ≈ 230 internal steps, synchronous), `step(controls, dt)`
  in §1.5 order, `telemetry()` (complete `CarTelemetry`, JSON-safe, may be a reused object),
  `pose()`, `setParams(partial)` (deep merge; must also accept a whole `CarParams` for an archetype switch;
  rebuild derived values), `setSurfaces`, `setWorld`, `setParked`, `setFrozen`, and the optional
  `setTrackBraking(factor)` (the original's post-finish braking; `RaceController` calls it at the finish with the
  stage's Physics.bodyBrakingFactorForTrack, `reset` clears it).
* `telemetry().collision` — the original's collision record for the impact / bush sounds (`CollisionTelemetry`,
  research/formats/sound.md Port findings 5): the hull contact (`hull`, raw `hullMaterial` B+0x144, `hullStrength`
  = jn − 100 N·s, B+0x19c), the object record (`objectHits` counter, `objectType` = the obstacle's raw
  collisionMaterial, `objectStrength`) and `bush` (`WorldQuery.softNear`, optional, mesh worlds).
* Backfire / blow-out flags (`CarFlags`) are NOT sim telemetry: the original computes them in the per-frame car
  update, so `src/game/carFlags.ts` (`CarFlagSource`) runs once per rendered frame in main.ts and the same object
  goes to the audio (`FrameContext.carFlags`) and the effects (`CarRenderState.carFlags`).
* `params.ts` — `ARCHETYPE_PARAMS`, `makeCarParams(id, overrides?)`, `DEFAULT_SURFACE_TABLE`,
  `makeSurfaceTable()`, `muStatic`, `muKinetic` (values pre-filled from §3/§4; verify them).
* `inputFilter.ts` — `class InputFilter implements IInputFilter` (`new InputFilter(cfg?)`, `config`,
  `setConfig`, `reset`, `update(raw, dt)`), `makeInputFilterConfig()`.
* `presets.ts` — built-in, NON-default tuning presets (spec §6.1): `TUNING_PRESETS`,
  `presetOverrides(preset, archetype)`, `presetCarParams(preset, archetype, keep?)`. Listed first (★) in the tuning
  panel's Presets folder; never applied by default.
* Rules: no three.js, no DOM (runs in vitest). Seeded `Rng` only (T20 determinism). Read the live surface
  table each step. aLat/aLong from Δv over ≥ 2 steps (§2.6 low-speed note). Wheels use `world.raycast`
  (4 per step). Chassis collision §2.9 uses **height queries**: 8 hull points (12 when fewer than 3 wheels
  touch) against `world.heightAt`, plus `normalAt` / `materialAt` for a penetrating point, because that works
  for any body orientation; so `heightAt` / `normalAt` must describe the same ground as `raycast` (road
  ribbon included) and stay cheap. Obstacles: `world.obstaclesNear(pos, ≈3 m)` once per step (vertical
  cylinders) — unless the world has `objectCollidersNear` (ported stages, RCOL v2): then the original's object
  pass runs after each step on the objects' own collision meshes (docs/orig/collision.md §4) and the cylinders are
  only hints (autopilot).
* Original-mesh fidelity (phase 0 contract, sim builder): `world.segment(origin, ray, slot)` is the original's
  query. Wheels: origin = mount, ray = −springLength·bodyUp, slot = `wheelSlot(slotBase, w)`, and
  `c0 = hit.depth`, `c4 = hit.cos` (MECHANICS_SPEC §2.5.3, research/formats/gcm.md §3.5). Hull (gcm.md §3.6):
  segment from the previous-step centre of mass to each hull point, slot `hullSlot(slotBase, i)`, contact when
  `origMaterial !== 255` and `depth < 0.01`. `CarSimOptions.slotBase` = 24·carIndex (default 0). Height queries
  pass `yHint` = the body / point y so bridges resolve to the right level.
* `telemetry().simFaults` counts NaN / explosion-guard trips (state rolled back, velocities zeroed); 0
  normally, shown in red in the overlay when non-zero.
* Reference: `tools/reference/spec_sim_check.py` implements §2 (flat plane, awd_wrc) and the §7 tests.
* Budget: one `step()` < 0.1 ms.

### World (`src/world/`)
* `listStages(): StageListEntry[]` (catalogue; the **first entry is the default stage** when no
  `?stage=` is given; keep `testpad` in the list) and `buildStage(id, seed?): { stage, world }`
  (deterministic for `(id, seed)`, throws on unknown ids).
* The catalogue is **7 procedural stages + the 48 ported originals** (`src/world/ports/*.ts`, generated
  by `research/tools/port_tracks.py`; ids `corsica-1-f` … `rallycross-3-r`). A ported stage builds from the
  archive's `AiFiles` centre/left/right splines (degree-3 uniform B-splines, evaluated in `portSpline.ts`;
  the ported `s` is the **3-D arc length** — the original's distance unit) and from `Play.con`'s race
  settings (spawn grid, valid range, event triggers = start line + timed splits + finish, default tyre,
  laps), ported verbatim (one documented shift where an archive's distances overrun its evaluated spline).
  Terrain and scenery dress the real road until the original render meshes are ported;
  `tests/world/ported.test.ts` pins every stage to its archive. Fidelity roadmap: `PROGRESS.md`.
* `Stage` (three space): centre spline `pointAt/tangentAt/roadAt/project(pos, hintS)`, `startS`,
  `startPose`, `checkpoints` (finish excluded), `finishS`, `validRange`, `environment`, `heightfield`,
  `road` ribbon samples, `scenery`, `pacenotes` (none for rallycross/ice).
* `WorldQuery` (sim space): `raycast`, `segment`, `heightAt`, `normalAt`, `materialAt`, `surfaceAt` (the four
  point queries take an optional `yHint`), `obstaclesNear`. It must describe the same ground as the Stage data
  (contract test checks road height, raycast distance, segment fields, material and surface at road samples).
  * `segment(originSim, raySim, slot?)` — **required** on every implementation; the original's collision query
    (research/formats/gcm.md §3.2-3.4 + Verification): `raySim` is the full segment vector (not unit);
    one-sided (front faces only, start strictly above the face plane, end on/below it; parallel and back faces
    never hit); the FIRST face in the original traversal order wins, not the nearest; per-slot face cache
    (`slot` = wheelIndex + 24·carIndex for wheel rays, 8 + hullIndex + 24·carIndex for hull segments, −1 /
    undefined = none, slots < 5000; helpers in `src/core/worldQuery.ts`); a hit fills `dist = t·|ray|`, `t`,
    `depth = dot(end − v0, n)` (≤ 0), `cos = dot(n, ray)` (unnormalised), `origMaterial` (raw byte), `material`
    (= `materialFromOrig(origMaterial)`), `face`. Optional 4th argument `out`: a RayHit written in place and
    returned (valid until the next call with it; `makeRayHit()`); implementations may ignore it, so callers use the
    return value. `raycast(o, dir, max, out?)` likewise. CarSim passes one scratch hit (no allocation per substep).
  * `objectCollidersNear?(posSim, radius, out?)` — optional (mesh worlds with object meshes): `ObjectCollider`s with
    the original's mesh query `segment(o, ray, out: ObjectSegmentHit)` (0x597810), origin, bounding sphere, render
    box and transform; the sim's object pass uses them instead of the `obstaclesNear` cylinders.
  * Procedural worlds (`src/world/ground.ts`, `tests/sim/flatworld.ts`, `tests/sim/profileworld.ts`,
    `research/frida/replay.ts`) implement `segment` with `segmentViaRaycast(this, …)` (start on/below the ground
    → miss, slot ignored) and keep the legacy `raycast` "origin underground → dist 0".
  * Mesh worlds (`src/world/orig/**`, the original Track.gcm) implement `segment` literally and
    `raycast(o, dir, maxDist)` = `segment(o, dir·maxDist, −1)` (`raycastViaSegment`): an origin below the ground
    is a **miss** (the original), never dist 0. Off the mesh nothing is hit (the car falls; the §5.4 reset catches
    it), while `heightAt` & co. fall back to the procedural terrain (never NaN).
  * `yHint` (sim y) picks the level of multi-valued ground (bridges, overpasses): the highest ground at or below
    `yHint + 1 m`, else the lowest above it (`pickGroundLevel`); without it the highest (unchanged).
    Procedural worlds are single-valued and ignore it.
* `testpad` ("Proving Ground"): ~600 × 600 m flat tarmac with patches of the other nine surfaces, a cone
  slalom, a crest, a kicker ramp, a 22° banked bowl and a 1.88 km loop road; `Stage.labels` names the
  patches (the renderer draws them as name plates). The race controller disables auto-reset, wrong way and
  the finish on `discipline === 'testpad'`.
* Optional extras in the contract: `Stage.labels` (text plates) and `EnvironmentPreset.palette` (per-stage
  ground / foliage colours; the terrain blends `palette.ground[surface]` in).
* Scenery orientation conventions (model front = local -Z, linear props long along X, chevrons point +X,
  gates on the centre line) are documented on `SceneryInstance` in `types.ts`.
* Budget: `raycast` < 5 µs (≈ 2000 rays/s per car).

### Render (`src/render/`, `src/audio/`)
* `class GameRenderer implements IGameRenderer` — `new GameRenderer(container)`, `loadStage`, `addCar`,
  `removeCar`, `update(frameDt, alpha, cars)`, `setCameraMode/nextCamera/getCameraMode/lookBack`,
  `cameraTuning` + `setCameraTuning`, `resize`, `stats`, `dispose`; plus `makeCameraTuning()` (§5.3 defaults).
* Cameras (§5.3): 8 views in `CAMERA_MODES` order, look-back, flipped-car follow, FOV 70; per-frame
  constants converted with `perFrameK(k, frameDt)`.
* `class AudioEngine implements IAudioEngine` — synthesised, original sounds (optional polish).
* Original car identity (phase 0 contract): `addCar(id, archetype, { origCar })` and `CarRenderState.origCar`
  carry the original car name (`ORIG_CAR_IDS`, = `manifest.cars` key); the renderer keeps the procedural
  archetype visual until `loadOriginalCar(origCar, …)` resolves (docs/ASSETS.md §10 gap 2). The audio engine
  reads `FrameContext.origCar` for the per-car engine patches; `Pacenote.origWords` (original co-driver word ids
  1..41, playback order) selects the original co-driver samples, falling back to the synthesized voice on `text`.
* Must render under headless SwiftShader (smoke test). Keep draw calls modest.

### Game (`src/input/`, `src/game/`, `src/ui/`, `src/debug/`)
* `class InputManager implements IInputManager` (`new InputManager(window)`): keyboard + Gamepad API;
  `poll()` once per frame. Bindings live in `src/input/bindings.ts` (`GAME_KEYS`, `UI_BINDINGS`,
  `GAMEPAD_BINDINGS`); `constants.ts` `DEFAULT_KEYS` / `UI_KEYS` mirror them (contract test). Keys typed
  into text fields never reach the car.
* `class RaceController implements IRaceController` (`new RaceController()`): phases, clock in sim time,
  checkpoints/laps/finish, best times + ghost (localStorage per stage/seed/car), §5.4 resets (fade, auto
  "hand of god", no time penalty), §5.7 pacenotes, wrong way, [D] stuck rules (upside down 2.5 s, or < 3 km/h
  for 10 s with a pedal pressed). `begin(stage, car, { countdown, world })`: spawn / reset heights use
  `world.heightAt`.
* `class Autopilot implements IAutopilot` (`new Autopilot()`): returns `Controls`; must drive every stage
  to the finish (contract test: > 100 m of progress in 20 s on every stage).
* `class Hud implements IHud` (`new Hud(hudRoot)`), `class Menu implements IMenu`
  (`new Menu(overlayRoot, host)`), `class TelemetryOverlay implements ITelemetryOverlay`
  (`new TelemetryOverlay(overlayRoot)`), `class TuningPanel implements ITuningPanel`
  (`new TuningPanel(host)`, lil-gui, every §6 key; writes only through `host.setParam`).
* UI keys (`UI_KEYS`): F1 or `` ` `` tuning panel, F2 / F4 / O overlay, Esc pause menu, Backspace restart,
  H help, `.` freeze / single step, `[` `]` time scale, F8 autopilot, N co-driver voice, M mute.
* Original cars (phase 0 contract): `RaceSelection.car?` = the original car name (absent = archetype car;
  `archetype` stays the handling class / fallback visual); `IMenuHost.listCars?(): CarListEntry[]`
  (`{ id, name, archetype, drive, available }`); best times and the ghost are keyed by the car name when
  present (race builder; main.ts passes it as `race.begin(stage, car, { countdown, world, origCar })`). `Pacenote.origWords?` is present on notes ported from the original `Pacenotes.con`.
* Hosts (implemented by main.ts): `IMenuHost` (stages, cars, startRace, restart, setPaused (opens the pause
  menu), selection, setCamera / getCameraMode, setAudioEnabled / isAudioEnabled) and `ITuningHost`
  (tunables, setParam / getParam, archetype, reset to original, JSON export / import, telemetry, autopilot,
  setFrozen / isFrozen (no pause menu), stepPhysics(n), teleport(s, lateral), resetCar).

## 5. Parameters and live tuning (§6)

`GameTunables = { car: CarParams, input: InputFilterConfig, camera: CameraTuning, surfaces: SurfaceTable,
loop: { timeScale, physicsHz } }`. One dotted-path syntax everywhere (`ITuningHost.setParam`,
`window.__rally.setParam`):

* first segment picks the root: `car.`, `input.`, `camera.`, `surfaces.`, `loop.`; no known root means car:
  `mass` ≡ `car.mass`;
* examples: `wheel.front.springK`, `assist.bigBetaSymmetric` (DEV-1), `setup.suspension`, `gearRatio.2`,
  `input.keySteerRate`, `camera.fov`, `camera.chase.chase.posA.y`, `surfaces.gravel.tyre.2.bestStatic`,
  `loop.timeScale`;
* unknown paths throw (typos surface immediately); `archetype` switches the archetype;
* one extra path outside `GameTunables`: `autopilot.aggression` (0.3..1.2, the autopilot's speed scale).

Per-axle wheel parameters live in `car.wheel.front` / `car.wheel.rear`; single-value §6 keys (e.g.
`springK`, `twStaMy`) are written to both axles by the panel.

## 6. Test API (`window.__rally`, type `RallyTestApi`)

| member | behaviour |
|---|---|
| `ready`, `version` | true after the first stage is loaded and a frame rendered |
| `getTelemetry()` / `getRaceState()` / `getStageInfo()` / `listStages()` | JSON clones |
| `setRawInput(partial \| null)` | replace device input (merged over neutral; edges fire once); null = devices |
| `setControls(partial \| null)` | bypass filter, autopilot and race gating with fixed Controls; null = off |
| `pause(bool)` | stop/resume the fixed-step loop (rendering continues; no pause menu) |
| `step(n)` | run n substeps synchronously (full pipeline incl. race logic), render once, return telemetry |
| `reset()` | immediate race reset (reason `'api'`) |
| `teleport(s, lateral = 0)` | car at spline distance s, lateral metres right, with settle |
| `loadStage(id, { car, origCar, tyre, seed, transmission, countdown, opponents, ghost })` | load and await; phase `idle` until `startRace()` unless `countdown: true` |
| `setParam(path, value)` / `getParams()` | see §5 |
| `setAutopilot(bool)`, `setCamera(i \| name)`, `startRace()` | `startRace` skips menu + countdown |
| `getFrameStats()` | frames, physics steps, sim time, fps, paused, timeScale |
| `probe()` | car vs ground and road: `clearance` (origin above `world.heightAt` at the car's own height, `yHint`), global `s` / `lateral` / `heightOffset`, `upY`, `headingErrDeg` (car axis vs road tangent), speed |
| `getCarInfo()` | the player car: `archetype`, `origCar` (null = archetype car), `hullCar` (the `Car_<Name>.col` hull in use, null = the §3.4 box), `voice` (co-driver setting) |
| `getRaceEvents()` | the `RaceEvent`s since the last call, oldest first (drained; at most the latest 1000 kept): countdown, go, checkpoint, lap, finish, `reset` with its `reason` (`manual`, `api`, `restart`, the automatic ones), pacenote, wrongWay |
| `getField()` | PHASE 2: the AI field as JSON (`FieldSnapshot`: AI cars with pos / speed / s / lateral / controller outputs, standings, the player's position); empty when solo |
| `getGhosts()` | PHASE 2: the ghost cars in play (`GhostInfo[]`: id, source best/team/user, car, time, playback tick, finished, pos) |

Deterministic probing: `pause(true)`, then `step(n)` / `setControls(...)` / `getTelemetry()`.

## 7. URL parameters

`?stage=<id>&car=awd_wrc|fwd_hatch|rwd_classic|<original car name, e.g. AudiS1>&tyre=0..4|tarmac|intermediate|gravel|snow|ice&seed=<n>`
(original car names → `LaunchOptions.origCar` / `RaceSelection.car`). Without `?car=` the game starts in the
original's default car (`ORIG_DEFAULT_CAR`, Micra) when the original cars are built, else the `awd_wrc` archetype car.
Without `?stage=` it starts on the first original stage whose `track` and `collision` parts are built (catalogue
order: `corsica-1-f`, also the first entry of the original's `Misc/level/track.lst`), else the first procedural
stage; the menu then lists the original stages first.
`&cam=<0..7|name>&autopilot=1&menu=0&countdown=0&debug=1&tune=1&timescale=0.5&trans=manual&audio=0&ghost=0&touch=1`
(`&ai=0..3` AI opponents on the grid, default 0 = solo; phase 2, `docs/PHASE2_AI.md`)

`menu=0` starts with a countdown (`countdown=0` starts immediately). Renderer: `quality=low|medium|high|auto`
(default adaptive on a real GPU, `low` on SwiftShader), `pr=<pixel ratio>`, `aa=0|1`. Original assets:
`orig=0` (procedural everything), `s3tc=0` (JS DXT decoder instead of compressed uploads), `collision=0` (the
procedural ground instead of the Track.gcm mesh), `gamma=0` / `gfxgamma=<0..1>` (the in-race gamma ramp), `music=1`
(the user's own soundtrack copy in public/sound/, never built); diagnostics only: `carlm=0` (no track lightmap
under the original cars), `orighook=0` (no original-fog hook on procedural materials); docs/ASSETS.md. `tools/drive.mjs --query k=v`
(repeatable) adds any of them to a drive run.

## 8. Running and testing

```
npm run dev          # http://localhost:5173 (also on the LAN: --host)
npm run typecheck    # tsc --noEmit (TS7 native compiler)
npm run build        # typecheck + vite build
npm test             # vitest: tests/contracts (architect) + tests/<module> (builders)
npm run smoke        # headless end-to-end check; screenshot artifacts/smoke.png; JSON summary; exit code
npm run drive -- --stage testpad --car rwd_classic --keys "ArrowUp:3000,ArrowUp+ArrowLeft:1500,Space:400" --shots 3
npm run drive -- --stage <id> --autopilot --seconds 60 --shots 6 --out artifacts/run1
npm run drive -- --stage <id> --autopilot --until-finish      # stepped (deterministic) full-stage run
npm run stages               # every stage to the finish with the autopilot (--car …); table + artifacts/finish/<car>/
npm run keys                 # real keyboard events: menu → countdown → drive → R → C → F1 panel → F2
npm run check                # build (incl. typecheck) + vitest + smoke
npm run assets               # original-asset packs → public/assets/ (Python; docs/ASSETS.md)
```

`tools/drive.mjs` prints a JSON summary (max/avg speed, distance, β, lateral g, gears, surfaces, resets,
race phase and times, fps), health `checks` (finite telemetry, no sim faults, never below the ground or
flying off, not stuck, no auto resets, no rollover, facing the travel direction, finished) and writes the
5 Hz time series to `<out>/trace.json`. `--param path=value` (repeatable) tunes before the run; `--url`
reuses a running dev server; `--headed` shows the browser. `--until-finish` / `--stepped [n]` pause the loop
and advance it with `step(n)`, so runs do not depend on the headless frame rate (SwiftShader: 5-30 fps).

Keep `npm run typecheck`, `npm test`, `npm run build` and `npm run smoke` green.

## 9. Conventions

* TypeScript 7 with `erasableSyntaxOnly`: no `enum`, `namespace` or constructor parameter properties; use
  unions and `as const` objects. `verbatimModuleSyntax`: `import type` for types. `strict` is on.
* No `Math.random()` in sim or world code (use `Rng`). Telemetry, race state and stage info stay plain JSON data.
* Hot paths (sim step, raycast) avoid per-call allocation where cheap (`…To` helpers in `math.ts`).
* Do not commit (the orchestrator handles git).

## 10. Phase 2: AI opponents, ghosts, car-car contact (final state)

`docs/PHASE2_AI.md` has the plan, the ownership map, the decisions and the open items (its section 0 is the final state). The
per-substep order with AI cars (main.ts `physicsStep`, the original's: all physics, then contacts, then race logic) is: player
`car.step` -> `field.step` (AI controllers + their `car.step`) -> `stepCarContacts([player, ...field.sims])` -> `race.fixedUpdate`
-> `field.afterStep`. With no opponents the field and the contact step are no-ops and a solo race is bit-identical to before phase 2.

* **Car-car contact** (`src/sim/contact.ts`, `src/sim/contact/{solve,hull,carHulls}.ts`): `stepCarContacts(cars, dt)` is
  FUN_004a7980's pair loop (i, then j >= i, self pair skipped, `collidable` checked) calling the body solver FUN_006d4390 / 6d4fd0 /
  6d5240 on the cars' 18-point / 10-plane `Car_<Name>.col` hulls (`carHulls.ts` is generated by `research/tools/contact_gen_hulls.py`).
  `CarSim.contactBody()` is the live view of the car's rigid body (shared vectors, scalars pulled per call; `commit()` stores the
  anchor timer and drops the telemetry cache), `CarSim.setCollidable(on)`, `setContactMultiplayer(on)` lowers the impulse cap from
  30000 to 10000 N.s as the `-multiplayer` flag does. It writes `CollisionTelemetry.carHits / carStrength` on both cars (absent until a car
  has been through a contact step; `carStrength` is the LATEST contact's strength, so a consumer latches on a change of `carHits`). It
  does not allocate per call. `ICarSim.contactBody?()` / `setCollidable?()` are optional in the contract; a sim without them is ignored.
  Spec: MECHANICS_SPEC Appendix D, research/formats/dynamics.md 7.1.
* **AI driver** (`src/game/ai/`): `ctrl.ts` (FUN_007e0540), `aicar.ts` (FUN_00607280 / 00607ae0 / 00609550 on typed RallyCar memory,
  every x87 op rounded to float32), `driver.ts` (`createAiDriver`: spline front end from `Stage` + the side.rsd samples, `placeholder:
  false`), `aidata.ts` (loaders; resolve null without assets), asset part `ai`. `CarSimOptions.aiFriction` (tarmac tyre rows on every
  surface, `frictionLevel = min(FL, 0)`) is implemented in `src/sim/car.ts` on a private surface table. One driver update per physics
  substep. `CarField` feeds `AiDriverInputX.leaderLapDist` = the human's route distance (the original's rubber band). Spec docs/orig/ai.md.
* **Multi-car race** (`src/game/field.ts` `CarField`): `prepare` builds the roster (`ai/roster.ts`: the career event's `Car =` list minus the
  player's car, the exe's AI name table as top-up), loads AiData / AiTimes, creates one `ICarSim` + `AiDriver` per opponent through
  `FieldHost.createCar` (main.ts), `begin` puts them on the original's grid (`src/game/grid.ts`, FUN_00484640 proven in unicorn) parked,
  `step` / `afterStep` run the controller + sim step and the route / gate / finish / recovery tracking (no per-substep allocation).
  AI cars are released in the substep the player is. `renderStates` / `otherFrames` / `snapshot` feed the renderer, audio
  (`src/audio/orig/otherCars.ts`: SoundAI Simple set per car, 3-D + Doppler; the car-car impact sound is wired from `carHits` for all cars)
  and the UI (`src/ui/hudAi.ts` position / strip / bar markers, `src/ui/menuAi.ts` Opponents row + results table).
  `?ai=0..3` / `loadStage(id, { opponents })` / the menu row select the count; absent = 0 = solo (the menu row defaults to 3).
  Ids: player `'player'`, AI `'ai1'..'ai3'`, ghost `'ghost'`; face-cache slots `24 * gridIndex + ...`. Spec docs/orig/race.md 9a.
* **Ghosts** (`src/game/ghosts/`, docs/orig/ghosts.md): `format.ts` (the exe's 2.0 / 3.0 file layout, FUN_004dccb0 / 004dc7b0 codec at the game's
  float32 x87 precision), `player.ts` (FUN_004db730, tick-driven from GO), `recorder.ts` (FUN_004db540), `frame.ts` (world / sim / three
  conversions), `session.ts` (`GhostSession`: recorder + playback slot + session best + the ghost render state), `store.ts` (IndexedDB
  `rally-web-ghosts`, memory fallback), `team.ts` (the 30 shipped team ghosts, asset part `ghosts`), `names.ts`. `RaceController` keeps a thin
  ghost region over `GhostSession`; the best-run ghost is stored under `rally-web:ghost:v3:<stage>:<seed>:<car>` (the old 30 Hz
  `rally-web:ghost:v2:*` JSON is never read). `src/ui/menuGhosts.ts` adds the Ghost row (Off / Best run / team ghosts / saved), SAVE GHOST
  with the name dialog and the Delete key. A team / saved ghost races with the FILE's car, drawn translucent, silent, no shadow; it takes its
  first pose at GO.
* **Railings**: the object pass (`CarSim.objectPass`) gates TreeMesh candidates on the tight trunk radius and every other mesh object on its
  bounding sphere (0x4a7fb3; `ObjectCollider.treeMesh`), so fences, walls and rails are hit anywhere along their span.
* **Tools**: `node tools/ai-race.mjs --real` (stepped 4-car races on one stage per discipline, 89 checks), `node tools/ghosts-check.mjs`
  (team ghosts / save round trip through the real menu), `node tools/ai-stages.mjs` (a solo AI car on all 48 stages),
  `node artifacts/phase2/integrate/play.mjs` (the integration play-through: menu -> AI race -> results -> restart with the own ghost ->
  pause menu -> main menu -> stage change, team ghost, disciplines, `?orig=0`, solo, 5+5 consecutive races memory, fps).
* **Test API**: `getField()` (`FieldSnapshot`: cars with controller outputs, `dnf`, `progress`, `lastReset`, standings with `dnf`,
  `playerPosition`), `getGhosts()` (`GhostInfo[]`), `loadStage(id, { opponents, ghost, countdown })`.
