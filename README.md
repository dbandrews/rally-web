# rally-web

An original browser rally game whose handling is modelled on the feel of early-2000s arcade rally games.
The mechanics are specified in `docs/MECHANICS_SPEC.md` and implemented in `src/sim`. It uses Three.js
rendering, a fixed 120 Hz physics step, a live tuning panel, a telemetry overlay, and headless tooling so
agents can drive and check the game without a screen.

All content is original: the stages, the cars (Corvane X4 AWD, Tessel F2 FWD, Ardent Classic RWD),
liveries, art and the synthesised audio.

**Play it:** https://dbandrews.github.io/rally-web/ (rebuilt by `.github/workflows/pages.yml` on every push to
`main`; the workflow runs the tests and the build before publishing).

## Run it

```
npm install
npm run dev          # Vite dev server; open http://localhost:5173 (also reachable on the LAN)
```

The start menu lets you pick the stage, car, tyres, gearbox, the setup options, the camera, co-driver calls
and sound. Use the arrow keys to choose and change an option, then Enter to start. A 3-2-1 countdown runs,
then you drive. To skip the menu, use the URL, for example `http://localhost:5173/?stage=testpad&menu=0`
(see "URL parameters" below).

Stages (`?stage=` id):

| id | name | type |
|---|---|---|
| `pine-ridge` (default) | Pine Ridge | muddy forest rally, about 3.6 km: crests, a jump, a water splash, a hamlet, a hairpin pair |
| `col-du-vent` | Col du Vent | tarmac hillclimb, about 2.4 km: hairpins, rock faces, a cobbled village |
| `frostvale` | Frostvale | snow rally, about 3.1 km, with ice patches and snow berms |
| `red-basin` | Red Basin | desert rally, about 3.6 km: loose sand with tarmac and gravel stretches, long straights, three jumps |
| `kettle-park` | Kettle Park | rallycross circuit, 3 laps of about 1 km, tarmac and gravel, a tabletop jump |
| `lake-skoga` | Lake Skoga | ice circuit on a frozen lake, 4 laps of about 1.4 km (fast 60-95 m sweepers) |
| `testpad` | Proving Ground | flat tarmac pad for handling work (see below); no finish or automatic resets |

Your best time and a ghost of that run are saved in the browser (localStorage) for each stage, seed and car.
On your next run the ghost drives alongside you, and the HUD shows split deltas against your best.

## Controls

| action | keyboard | gamepad (standard mapping) |
|---|---|---|
| steer | ← → or A D | left stick, d-pad |
| throttle | ↑ or W | RT |
| brake; hold when stopped to reverse (automatic gearbox) | ↓ or S | LT |
| handbrake | Space | A |
| gear up / down (manual gearbox) | E or Shift / Q or Z | RB / LB |
| reset to road | R | B |
| next camera (8 views) | C | Y |
| look back (hold) | V | X |
| pause / resume | P | Start |
| pause menu | Esc | Start |
| restart stage | Backspace | |
| help (all keys) | H | |
| mute | M | |
| co-driver voice on/off | N | |

Menus work with the arrows (or WASD), Enter and Esc, the mouse, or a gamepad (d-pad, A, B).
Ctrl is deliberately not bound (Ctrl+W, with W as the throttle, would close the browser tab). The game pauses
itself when the window loses focus or the tab is hidden during a run.

Debug and tuning keys:

| key | what it does |
|---|---|
| F1 or ` | tuning panel ("Handling lab") |
| F2 (or F4, O) | telemetry overlay with graphs |
| F8 | autopilot on/off (it drives the stage while you watch or tune) |
| `.` | freeze physics, then single-step (Shift+. = 12 steps = 0.1 s); P resumes |
| `[` / `]` | time scale down / up (0.1× to 2×) |

## Iterating on handling

1. **Start on the Proving Ground:**
   `http://localhost:5173/?stage=testpad&menu=0&countdown=0&tune=1&debug=1`.
   - The pad is about 600 × 600 m of flat tarmac.
   - It has patches of all nine other surfaces with name plates: loose gravel, gravel, mud, snow, ice, grass,
     sand, cobbles and wet tarmac.
   - It also has a cone slalom, a crest, a kicker ramp, a 22° banked bowl and a 1.88 km loop road.
   - Nothing resets you automatically there.
2. **Tuning panel (F1).** Every key of spec §6 is a live control, using the spec's ranges. Changes apply from
   the next physics step.
   - **Quick**: archetype, autopilot, time scale, freeze and single step, reset the car to the road, and
     teleport. Teleport takes an s/lateral position or a named target; on the pad, every surface patch is a
     target.
   - **Spec groups**: Simulation, Body, Engine, Gearbox (with per-gear ratios), Drivetrain, Brakes,
     Suspension, Tyres, Assists (including the §0 DEV toggles), Steering & input, and Setup.
   - **Surfaces**: the live friction table for any surface × tyre, showing μ static and kinetic. It can
     follow the surface the car is on.
   - **Camera**: FOV, lerp rates and the chase entries.
   - **All other parameters**: anything not covered above.
   - **Live telemetry**: read-only values while you drive.
   - **Reset to original** restores the shipped §3/§4 values. **Copy JSON** and **Paste JSON** move a whole
     setup between sessions or people.
   - **Presets** saves named setups in localStorage. "Persist tweaks across reloads" (off by default) keeps
     your edits for each car. Built-in presets are listed first with a ★ and are never active by default:
     **Arcade drift (DEVIATION)** makes the AWD and FWD cars hold big power slides (not the original; for A/B
     against it), and **orig: class-4 AWD car** puts the original's high-power 4WD class data on the AWD car.
     Hover the "about" line for what a preset changes (docs/MECHANICS_SPEC.md §6.1).
3. **Telemetry overlay (F2).**
   - Readouts: speed, rpm, gear, boost, pedals, steer angle, body slip β, yaw rate, lateral and longitudinal g,
     the yaw-cap flags, airborne state and impacts.
   - A per-wheel table: grip or slide, load, μ, slip angle, slip ratio, forces, wheel speed, drive and brake
     torque, suspension, surface.
   - Friction circles, and graphs of the last 6 s of sim time (sampled at 60 Hz whatever the frame rate) of
     speed, β, yaw rate, g, steer and pedals. a_lat / a_long are 8-step averages (the 2-step telemetry chatters
     by about 1 g at low-speed full lock, a property of the model).
   - A red "SIM FAULTS" tag appears if the physics guard ever trips.
4. **Watch and compare.**
   - Press F8 and let the autopilot drive a stage after a change.
   - Slow the game down with `[` to see a slide develop.
   - Freeze with `.` and step through a moment.
5. **Check it headlessly.** For example:
   `npm run drive -- --stage testpad --car rwd_classic --param torqueScale=1500 --keys "ArrowUp:3000,ArrowUp+ArrowLeft:1500,Space+ArrowLeft:500"`
   This prints a telemetry summary and writes screenshots and a 5 Hz trace to `artifacts/drive/`. The §7
   feel tests (`tests/sim/feel.test.ts`) pin the reference numbers. Run them after any change to defaults.

### Open feel questions (decide in playtests; the shipped values are the original's)

These are properties of the spec-faithful model, not bugs. Each can be tried live in the panel.

- **Turbo lag on power oversteer.** After any part-throttle phase the turbo is back at idle, so power-on rotation
  arrives 2-3 s after the throttle opens. From a steady 80 km/h on gravel the RWD needs about 4 s to pass 30° of
  slip, compared with 1.1 s with the turbo spooled. Try `turboSpinup`, `turboIdle` and `turboSpoolThrottle`
  (Engine folder; spec §2.3.3, §7 T8).
- **Holding a drift.** Only steering into the slide sustains it. AWD holds about 12-20°, FWD cannot hold a
  drift, and RWD holds 17-25° while its speed runs away. Try `twKinSteer`, `driftGripGain`,
  `sideFillBase`/`sideFillCap` and `twMomLimScale`. The "drift hold" test in `tests/sim/feel.test.ts` reports
  the achievable slip angle per car; re-baseline it if you change these on purpose.
- **Small-steer stiction at speed.** Steer inputs up to about 0.06 give almost no yaw, and above that the
  response jumps. The cause is the TWStaMy grip-mode yaw friction. On a gamepad this means stick deflections
  of 10-15 % do little on fast straights. Try `input.sqrtCurvePad = 2` or `input.padDeadzone = 0.05`.
- **Surface contrast.** In straight-line acceleration, gravel is only about 6 % slower than tarmac, and ice on
  ice tyres brakes and corners like snow. Try the `surfaces.<surface>.tyre.<n>.bestStatic` /
  `scaleKinetic` rows.

Parameter paths (panel, `--param`, `window.__rally.setParam`) are dotted:

- `mass` (the same as `car.mass`), `wheel.front.springK`, `gearRatio.2`, `assist.bigBetaSymmetric`
- `input.keySteerRate`, `camera.fov`, `camera.chase.chase.posA.y`
- `surfaces.gravel.tyre.2.bestStatic`, `loop.timeScale`, `autopilot.aggression`

Unknown paths throw an error.

## URL parameters

| parameter | effect |
|---|---|
| `stage=<id>` | stage to load (default `pine-ridge`) |
| `car=awd_wrc\|fwd_hatch\|rwd_classic` | car archetype |
| `tyre=tarmac\|intermediate\|gravel\|snow\|ice` (or 0-4) | tyres (default: the stage's recommendation) |
| `trans=manual` | manual gearbox |
| `seed=<n>` | stage seed: a different procedural layout of the same stage |
| `menu=0` | skip the menu and start with the countdown; `countdown=0` starts at once |
| `cam=<0-7 or name>` | camera: bumper, bonnet, chaseNear, chase, chaseFar (default), chaseHigh, tetherHigh, tetherLow |
| `tune=1` / `debug=1` | open the tuning panel / telemetry overlay at start |
| `autopilot=1` | autopilot drives |
| `timescale=0.5` | slow motion (0.05-4) |
| `audio=0` / `ghost=0` | no sound / no ghost car |
| `quality=low\|medium\|high` | pin the render quality (default: adaptive on a real GPU) |

## Checks

| command | what it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (TypeScript 7 native compiler) |
| `npm test` | vitest: contract tests, §7 feel tests against the Python reference numbers, world, game and render unit tests |
| `npm run build` | typecheck and a production build into `dist/` |
| `npm run smoke` | headless Chromium end-to-end check; screenshot in `artifacts/smoke.png` |
| `npm run keys` | real keyboard events on `testpad` and `pine-ridge`: menu, Enter, countdown, driving, R reset, C camera, F1 panel (typing a new torqueScale must slow the car), F2 overlay |
| `npm run stages` | the autopilot drives every stage to the finish (all laps; on the pad, one loop) and checks health: no NaN or sim faults, never below the ground or flying off, never stuck, no automatic resets, no rollover, facing the travel direction. Table plus `artifacts/finish/<car>/<stage>/` screenshots; `--car fwd_hatch` etc. for the other cars |
| `npm run drive -- …` | scripted or autopilot playtest with telemetry, health checks and screenshots (options in the header of `tools/drive.mjs`; `--until-finish` gives a deterministic full-stage run) |
| `npm run check` | build, then `npm test`, then smoke |

The headless tools use Chromium's SwiftShader software WebGL. It runs at 5-30 fps, so `npm run stages`
takes a few minutes. `--until-finish` and `--stepped` advance the simulation with `window.__rally.step()`
instead of real time, so their results do not depend on the frame rate.

Agents and scripts can drive the game through `window.__rally`: telemetry, race state, raw input or control
overrides, pause and step, teleport, reset, stage loading, parameters, camera, and `probe()` for ground
clearance and heading. See `docs/ARCHITECTURE.md` §6.

## Layout

| path | what it holds |
|---|---|
| `src/core` | shared contracts |
| `src/sim` | car physics |
| `src/world` | procedural stages and ground queries |
| `src/render` | graphics |
| `src/audio` | sound |
| `src/input`, `src/game`, `src/ui`, `src/debug` | devices, race logic and autopilot, HUD and menus, tuning panel and overlay |
| `src/main.ts` | wires them together |

See `docs/ARCHITECTURE.md` for the module map, coordinate spaces, loop and test API.
