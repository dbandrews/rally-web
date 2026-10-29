# rally-web architecture

rally-web is an original browser rally game whose handling follows `docs/MECHANICS_SPEC.md` (the
normative mechanics; "§" below points there). Stack: Vite 8, TypeScript 7 (native `tsc`), three 0.186,
lil-gui, vitest, Playwright.

Content rule: everything is original: stage names, car names and liveries, art, audio. Never use names,
logos or assets of the original game, real car makers or real rally events. Display names for the three
cars live in `src/core/constants.ts` (`ARCHETYPES`).

## 1. Module map and ownership

Four builders work in parallel, each in its own directories. **Only edit files you own.** Everything in
`src/core/` is the shared contract. If you need a contract change, keep going with a local workaround
and report a *contract request* (what, why, proposed signature); the architect applies it.

| Path | Owner | Contents |
|---|---|---|
| `src/core/` | architect (read-only for builders) | `types.ts` (all interfaces), `constants.ts` (ids, metadata, neutral inputs), `math.ts` (V3/Quat), `space.ts` (sim ↔ three mirror), `loop.ts` (120 Hz accumulator), `paths.ts` (dotted-path params), `stageUtil.ts` (spline → sim pose), `rng.ts` (seeded PRNG) |
| `src/main.ts`, `src/style.css`, `index.html`, `vite.config.ts`, `tsconfig.json`, `package.json` | architect | wiring, base layout, config |
| `src/debug/testApi.ts` | architect | `window.__rally` test API |
| `tools/smoke.mjs`, `tools/drive.mjs`, `tools/lib/harness.mjs` | architect | headless tooling (builders may add their own scripts under `tools/`) |
| `tests/contracts/`, `tests/helpers/`, `tests/sim/flatworld.ts` | architect | cross-module contract tests and shared helpers (read-only for builders) |
| `src/sim/`, `tests/sim/` (except `flatworld.ts`) | **sim builder** | car physics §1-§2, parameters §3-§4, input filter §5.1 |
| `src/world/`, `tests/world/` | **world builder** | stage catalogue, procedural stages, WorldQuery |
| `src/render/`, `src/audio/`, `tests/render/` | **render builder** | Three.js scene, cars, cameras §5.3, effects; synthesised audio |
| `src/input/`, `src/game/`, `src/ui/`, `src/debug/` (except `testApi.ts`), `tests/game/` | **game builder** | devices, race controller §5.4/§5.7, autopilot, HUD, menu, tuning panel §6, telemetry overlay |

Import rule: builder modules import **only `src/core/` and their own directory**. `main.ts` is the
only integrator (it imports every module's required exports). The architect's contract tests import
across modules on purpose.

Status: the integration pass is done (all four modules are real implementations; no stubs remain). The
ownership table still says who designed what; whoever changes a module keeps its REQUIRED EXPORTS and the
contract tests green.

Each builder file starts with a header listing its **REQUIRED EXPORTS**. Keep those names and
signatures exactly. Add any number of extra files and internal exports inside your directory.

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
* Materials: material id = index in `SURFACE_IDS` (0..9: tarmac, gravel, gravelDeep, mud, snow, ice, grass,
  sand, cobbles, water). Ids ≥ 32 = solid but not ground (wheels get no contact, §2.5.1). 255 = none.

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
* Ghost car: once a best run exists for (stage, seed, car), `RaceController.ghostRenderState(tel, alpha)`
  returns a `CarRenderState` (id `'ghost'`); main adds the ghost mesh to the renderer while that is non-null
  and appends it to the cars array (`?ghost=0` disables it).
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
* `class CarSim implements ICarSim` — `new CarSim({ id?, params, world, surfaces?, seed? })`;
  `reset(pose, settleSteps = 100)` (zero state, then settle with handbrake 1.0, §1.2; with DEV-9
  `assist.settleToEquilibrium`, on by default, sleep is held off until the body stops bouncing, so the car rests
  at its spring equilibrium; up to ≈ 230 internal steps, synchronous), `step(controls, dt)`
  in §1.5 order, `telemetry()` (complete `CarTelemetry`, JSON-safe, may be a reused object),
  `pose()`, `setParams(partial)` (deep merge; must also accept a whole `CarParams` for an archetype switch;
  rebuild derived values), `setSurfaces`, `setWorld`, `setParked`, `setFrozen`.
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
  cylinders).
* `telemetry().simFaults` counts NaN / explosion-guard trips (state rolled back, velocities zeroed); 0
  normally, shown in red in the overlay when non-zero.
* Reference: `tools/reference/spec_sim_check.py` implements §2 (flat plane, awd_wrc) and the §7 tests.
* Budget: one `step()` < 0.1 ms.

### World (`src/world/`)
* `listStages(): StageListEntry[]` (catalogue; the **first entry is the default stage** when no
  `?stage=` is given; keep `testpad` in the list) and `buildStage(id, seed?): { stage, world }`
  (deterministic for `(id, seed)`, throws on unknown ids).
* `Stage` (three space): centre spline `pointAt/tangentAt/roadAt/project(pos, hintS)`, `startS`,
  `startPose`, `checkpoints` (finish excluded), `finishS`, `validRange`, `environment`, `heightfield`,
  `road` ribbon samples, `scenery`, `pacenotes` (none for rallycross/ice).
* `WorldQuery` (sim space): `raycast` (dist 0 if the origin is underground), `heightAt`, `normalAt`,
  `materialAt`, `surfaceAt`, `obstaclesNear`. It must describe the same ground as the Stage data
  (contract test checks road height, raycast distance, material and surface at road samples).
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
| `loadStage(id, { car, tyre, seed, transmission, countdown })` | load and await; phase `idle` until `startRace()` unless `countdown: true` |
| `setParam(path, value)` / `getParams()` | see §5 |
| `setAutopilot(bool)`, `setCamera(i \| name)`, `startRace()` | `startRace` skips menu + countdown |
| `getFrameStats()` | frames, physics steps, sim time, fps, paused, timeScale |
| `probe()` | car vs ground and road: `clearance` (origin above `world.heightAt`), global `s` / `lateral` / `heightOffset`, `upY`, `headingErrDeg` (car axis vs road tangent), speed |

Deterministic probing: `pause(true)`, then `step(n)` / `setControls(...)` / `getTelemetry()`.

## 7. URL parameters

`?stage=<id>&car=awd_wrc|fwd_hatch|rwd_classic&tyre=0..4|tarmac|intermediate|gravel|snow|ice&seed=<n>`
`&cam=<0..7|name>&autopilot=1&menu=0&countdown=0&debug=1&tune=1&timescale=0.5&trans=manual&audio=0&ghost=0`

`menu=0` starts with a countdown (`countdown=0` starts immediately). Renderer: `quality=low|medium|high|auto`
(default adaptive on a real GPU, `low` on SwiftShader), `pr=<pixel ratio>`, `aa=0|1`.

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
