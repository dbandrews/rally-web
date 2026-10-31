# Phase 2: AI opponents, ghosts, car-car contact (architecture, work split and FINAL STATE)

Scope of this round (the user's choice, `MEMORY.md` port-scope-2026-10): **(1) AI opponents, (2) ghosts including the
shipped team ghosts, (3) railing collisions** (a separate agent: `src/sim/car.ts` objectPass region, `src/world/orig/**`,
`tools/assets/parts/collision.py`, `docs/orig/collision.md`; nobody else touches those). Nothing else: no meme UI/HUD art
port, no movies, no damage, no replays. Where opponents or ghosts need UI, extend the HTML menu (`src/ui/menu.ts`) and the
DOM HUD (`src/ui/hud.ts`).

Specs (written before this document): `research/formats/ai.md` (AI), `research/formats/ghosts.md` (ghosts),
`research/formats/dynamics.md` §6-§7 (car-car contact), `docs/MECHANICS_SPEC.md` §4.2 (AI friction), `docs/orig/race.md`
(grid, countdown, checkpoints), `docs/ARCHITECTURE.md`. Evidence tags as everywhere: **[E]** exe-verified (cite the
address), **[D]** data-verified, **[I]** inferred. Prefer executing the original function in unicorn over reading.

## 0. Final state (integration pass, 2026-10-30)

Everything in the scope above is built, wired and played end to end in the browser. Sections 1-7 below are the plan the four
builders worked from; where they say "stub", "placeholder" or "PLACEHOLDER [I]" the item is finished (the hook table in 4.3 is
updated). This section is the current truth.

### 0.1 What exists

| item | where | proof |
|---|---|---|
| Car-car contact: the exe's pair loop (FUN_004a7980) + the body solver FUN_006d4390 / 6d4fd0 / 6d5240 on the 18-point / 10-plane `Car_<Name>.col` hulls; `CarSim.contactBody()`, `setCollidable()`, `setContactMultiplayer()`; writes `CollisionTelemetry.carHits / carStrength` on both cars | `src/sim/contact.ts`, `src/sim/contact/*`, MECHANICS_SPEC Appendix D, `research/formats/dynamics.md` 7.1 | **[E]** unicorn: 8000 random two-car cases, 3928 contacts, 0 mismatches; TS port vs the executed exe on 2200 fixture cases (v 1e-6 relative, position 7.8e-7 m); Frida run 2: 271 contacts agree to 2.7e-4 m/s (483 are within 2 mm of a float32 plane-owner tie, 1 differs only in bookkeeping). Solo telemetry bit-identical (hash over 3 stages x 2400 steps). |
| AI controller: low-level FUN_007e0540, per-frame FUN_00607280 / 00607ae0 / 00609550, AiData posts and the AiTimes schedule, AI tyre-friction mode | `src/game/ai/{ctrl,aicar,driver,aidata}.ts`, asset part `ai` (`stages/<id>/ai.json`, `global/ai.json`), `CarSimOptions.aiFriction`, docs/orig/ai.md | **[E]** unicorn at the game's x87 precision (24-bit, every op rounded to float32): 6000 controller vectors 0 mismatches; 3200 per-frame cases bit-identical. Frida run 2 replay (open loop): throttle / brake bands match to 1e-3 on ~76-78 % of steps, steering 54 % (limit-cycle phase), AI-friction one-step |v| error median 7e-7. A solo AI car finishes 46 of 48 stages (`artifacts/phase2/ai-brain/ai-stages.md`). |
| Multi-car race: grid (FUN_00484640), roster, `CarField` (sims, drivers, tracking, laps, finish, recovery, standings), HUD position + strip + bar markers, menu Opponents row, results table, per-AI-car SoundAI voices, renderer cars | `src/game/{grid,field}.ts`, `src/game/ai/{roster,standings}.ts`, `src/ui/{menuAi,hudAi}.ts`, `src/audio/orig/otherCars.ts`, docs/orig/race.md 9a | **[E]** grid executed in unicorn (546 slots, 4.8e-4 m); `tools/ai-race.mjs --real` 89/89 checks; this pass's menu play-through (0.2). |
| Ghosts: the exe file format (2.0 / 3.0 decode and encode), tick-exact player (FUN_004db730) and recorder (FUN_004db540), the 30 shipped team ghosts (asset part `ghosts`), saved ghosts (IndexedDB), SAVE GHOST / delete, Ghost row | `src/game/ghosts/*`, `src/ui/menuGhosts.ts`, docs/orig/ghosts.md | **[E]** decode 30 files / 39 710 frames 0 mismatches; playback 317 440 ticks bit-exact; encode 3030 cases byte-identical; `tools/ghosts-check.mjs` all sections. |
| Railing collisions | `src/sim/car.ts` objectPass, `tools/assets/parts/collision.py`, docs/orig/collision.md 4.1 | **[E]** the object-pass gate has two branches (0x4a7fb3): only TreeMesh instances (colour interface 0x80d5fc) use the tight trunk gate; everything else gates on the bounding sphere. Pass-through of wall-like faces 41 % -> 0.26 % over 77 350 independent drives. |

### 0.2 Integration pass: what was played (`artifacts/phase2/integrate/`, `play.mjs`)

Through the real menu and the real keyboard, stepped and deterministic, headless SwiftShader:

* **menu-ai**: default menu (Corsica 1, Micra, Opponents 3 cars, Ghost Best run) -> Enter -> 4-car grid (HUD 1/4, strip) -> countdown -> GO ->
  mid-race -> the player and all 3 AI cars finish -> results card with the standings table. 0 console errors or warnings.
* **menu-ghost**: Restart from the results (Ghost row = own best run): the ghost appears at GO and stays within 0.2 m of the (deterministic)
  autopilot player, 4 AI cars + ghost in the renderer; Escape -> Restart stage mid-race; Escape -> Main menu -> stage + opponents changed -> a
  new race with exactly the new roster in the field and the renderer (no leftovers).
* **team-ghost**: kenya-1-f (JeffP, Lancer EVO) and hillclimb-2c-r (DeltaS4) through the Ghost row: the team ghost races beside the field.
* **disciplines**: one menu-started 4-car race to the finish on hillclimb-1a-f, rallycross-1-f and iceracing-1-f (every car finishes, 0 resets).
* **orig0**: `?orig=0` plays on the procedural stage; the Opponents row is disabled with an explanation; `?orig=0&ai=3` is a solo race, no errors.
* **solo**: Opponents None + Ghost Off through the menu = one car, no ghost, as before phase 2.
* **memory**: 5 stage loads and 5 restarts in place with 4 cars each: heap, geometry, texture and program counts flat in the steady state
  (numbers in 0.3). Renderer cars = field + ghosts in all 10 races.
* **fps**: solo vs 4 cars (0.3).

### 0.3 Numbers

All on the final tree, headless Chromium + SwiftShader, `public/assets` fully built (every part, `ai` and `ghosts` included):

| check | result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 74 files passed, 1 skipped; 2805 tests passed, 3 skipped |
| CI-like copy (everything `git add -A` would commit: no `research/`, `.cache/`, `original_version/`) | tsc clean; 72 files passed, 3 skipped (2758 passed, 23 skipped). With the 80 new asset files left out, the manifest test and 2 `ai` part tests fail by design (the manifest lists parts that are not there) |
| `npm run smoke` | ok (all checks; testpad drive 62.8 km/h, moved 28 m) |
| `npm run build` | ok; JS 2.65 MB (chunk-size warning only); `dist/assets/global/{ai.json,ghosts.json,ghosts/}` and `stages/<id>/ai.json` shipped, no `dist/sound` |
| `node tools/all-stages.mjs --jobs 6 --shots 0` (solo, autopilot) | 48 / 48 PASS, 0 resets, 0 object hits, 0 console errors, max \|lateral\| 7.97 m (`artifacts/phase2/integrate/all-stages/summary.json`) |
| menu -> 4-car race on corsica-1-f (Micra autopilot 3:03.322) | AI Audi S1 / Metro 6R4 / Delta S4 finish 1:52.213 / 1:52.961 / 1:54.733, 0 resets, standings AI, AI, AI, you; 0 errors / warnings |
| menu races, 3 AI each | hillclimb-1a-f: AI 2:17.7 / 2:22.7 / 2:20.9 vs player 3:18.5; rallycross-1-f: 5:02.9 / 5:08.1 / 5:05.5 vs 7:35.5; iceracing-1-f: 4:55.1 / 4:51.8 / 4:59.5 vs 10:40.2; all finish, 0 AI resets |
| own ghost (second race from the results Restart) | present from GO, within 0.2 m of the identical autopilot run; 4 AI + ghost = 5 renderer cars; restart mid-race and stage change leave exactly the new roster (3 cars, no ghost) |
| team ghosts | kenya-1-f JeffP (Lancer EVO 6.5b, 1:51.945), hillclimb-2c-r (Delta S4, 1:18.411) through the Ghost row; race with the file's car |
| memory (4 cars, corsica-1-f) | 5 full stage loads: JS heap 93.8 -> 95.3 MB; 12 restarts in place: 97.2 -> 98.3 MB; geometries 642 -> 704 (lazy first-use resources, +3 over the last six restarts), textures 145 -> 150, shader programs 45 throughout; renderer cars = field + ghosts in all 17 races |
| frame rate (real time, SwiftShader low quality) | corsica-1-f solo 36.3 fps, 4 cars 32.2 fps (0.89); hillclimb-2c-r solo 33.0, 4 cars + team ghost 26.1 (0.79); sim runs at 0.97-1.0x real time in all cases |
| console | 0 errors, 0 warnings in every scenario |

Screenshots (all looked at): `artifacts/phase2/integrate/` `00-menu` (13-row menu fits 1280x720), `01-menuai-grid`, `02-menuai-midrace`,
`04-menuai-results-final`, `05-menughost-race`, `08-menu-changed`, `09-new-stage-race`, `10/11-teamghost-*`, `12/13-disc-*`, `14/15-orig0-*`, `16-solo-race`.

Integration fixes made in this pass: (1) the AI rubber band was not fed (`leaderLapDist`): wired, and guarded so that a stage without AiData
posts cannot compound `curveSpd` to zero (the AI stood still in the unit test); (2) with the `ai` part missing the field now races solo with one
info line instead of a default-valued opponent; (3) the 720p main menu overflowed after the two new rows (title clipped): compact rules at
`max-height: 800px`; (4) the typed `dnf / progress / lastReset` fields, the optional `ICarSim` contact methods and the stale contract comments;
(5) the contact allocation test warms up long enough for the JIT (it failed in the full parallel run, passed alone).


### 0.4 Decisions and defaults (final)

* **Solo is the default of the tools** (`?ai` absent, `loadStage` without `opponents`): `all-stages`, `smoke`, `drive` are unchanged. **The menu's
  Opponents row defaults to 3** (every original event has `OpponentCount = 3`), `None / 1 / 2 / 3`, disabled with an explanation on stages in no
  event (the procedural ones).
* **Tick cadence**: the AI runs once per physics substep, dt = 1/120 **[D]** (Frida: pedals change by exactly 2 dt / 0.5 dt per step).
* **Rubber band**: `CarField` passes the human's route distance as `AiDriverInputX.leaderLapDist` (integration fix; before it the driver fell
  back to the AiTimes schedule). The human as owner of the original's mailbox 0x8e5a84 is **[I]** (best fit of the recording).
* **QA fixes (ai-race, 2026-10-31)**: (a) `CarField.setFrame(frameDt, paused)` is called by `main.ts` before `renderStates`, so the AI cars' backfire /
  blow-out timers use this frame's dt (0 while paused) like the player's, not the previous frame's; (b) a failed `ai.json` (stage or global) or
  `ghosts.json` fetch is evicted from the loader cache and retried by the next race (an absent manifest entry stays cached); (c) a sample with no
  AiData post (index -1; none of the 48 shipped stages has one) uses curve-speed scale 1.0 instead of 0, so the in-place rubber-band cuts and the skill
  multiply cannot compound **[I]** (the exe's zero record would compound the same way; unreachable with the shipped data); (d)
  `FieldCarSnapshot.objectHits` exposes each AI car's roadside-object hit count for wall-contact checks.
* **Grid**: player = grid index 0, left column, front row **[I]**. The 30 team ghosts do NOT settle this: their start poses are on the centre
  line of the point-to-point stages (a solo start, |lateral| < 0.1 m; hillclimb-1c-f aside) and 1.6-24 m behind the port's spawn, by amounts that are not multiples
  of the row spacing, so they are not grid slots; they come from the build the ghosts were recorded on (the original plays them from the
  file's own initial pose as well, so the offset is reproduced as is). The earlier idea "the original times triggers from the car's own start"
  is not needed (docs/orig/ghosts.md 4).
* **Ghost visibility**: the ghost takes its first pose at GO (tick 0) and is not drawn during the countdown **[I]** (the exe plays it only in
  race state 5; whether a parked ghost is drawn before GO is not decoded).
* **Team ghosts** are all listed (no unlock; the `enableTeamGhosts` predicate is unresolved) and race with the FILE's car.
* **After the player finishes** the AI keep racing; standings are final when all are done or after 90 s (the rest DNF) **[I]**.
* **AI recovery** (stuck, flipped, below track) is the player's hand-of-god rule applied as an instant teleport **[I]** (no AI-specific rule exists in the exe).
* **Object pass interleave**: `CarSim.step()` runs each car's object pass before any car-car contact; the original interleaves per car. At most one
  impulse application earlier or later, only for a car touching a static object and another car in the same substep **[I]**, MECHANICS_SPEC D.6.
* **Contract changes made here** (`src/core/*`): `ICarSim.contactBody?()` / `setCollidable?()` (optional), `FieldCarSnapshot.dnf / progress /
  lastReset` and `StandingEntry.dnf` (typed; the free-form `ai` record keeps them too), `aiFriction` comment, `AiOtherCar.halfWidth` /
  `AiDriverInput.lapDist` docs. Not changed (worked around in the owners' files): `IMenuHost.saveSessionGhost` still returns a boolean, so the
  menu validates the name itself and maps every failure to "not enough space".

### 0.5 Open items (all outside this round's scope or undecodable from the data)

* AI skill per car (AIAttributeManager group values) and the difficulty -> tyre scale are not in any data file: skill 1.0, tyre scale 1.0 (the
  recording fits 0.70-0.75 = difficulty level 1). `roster.ts` `skillOfGroup` / `AI_TYRE_SCALE` is the one place to change.
* Spin recovery (RallyCar +0x54) has no decoded trigger; `AiDriverX.setRecovery` exists, nobody calls it.
* The stage spline vs the original's `pointAt` differs at cm level; it shifts the AI steering limit cycle by a step (replay fidelity limit).
* Float64 contact port: about 1.7 % of the trace's touching substeps (shallow piles, face-on-face ties < 2 mm) pick the other plane owner than
  the exe's float32 state did. Both are valid contacts. No float32 mode.
* Hard hits launch the car high (140 km/h head-on into the riot fence: median 3.8 m rise). The gate and the solver are exe-verified, so this is
  probably faithful; a Frida trace of the original hitting a fence at speed would settle it.
* Ghost look (alpha 0.35, env-only pass) is still **[I]** (the Car/Ghost pixel shader is not pinned); the exact wheel Euler order of the ghost wheels is inferred.
* The `overtake` `FieldEvent` type is declared and never emitted. The renderer's `CarEntry.ai` / `carIndex` are stored and unused.
* The AI never raced on rally stages in the original recording set (only the Frida rallycross run); the port runs the event's cars there
  (hillclimb-1c-f and kenya-3-f DNF for a solo AI car at obstacles on the road; 8 stages need a reset).
* The stage's loose parts (cones, signs, barrels) are still not collided (PROGRESS P1 item 2), by design of this round.
* `docs/orig/ghosts.md`: `SAVE GHOST` name rule is **[I]** (Windows file-name rule, 32 chars).

## 1. What the original does (one paragraph each)

* **AI cars** are `RallyCar` objects like the player's, flagged `+0x17 = 1` ("use AiData post", ai.md §1). Each frame
  FUN_00607ae0 computes a circle-law target speed from the stage's AiData posts (per stage, keyed by spline distance),
  a look-ahead and a lateral target, runs the overtake machine, then drives the car to that point and speed with the
  low-level controller FUN_007e0540 (machine-proven, ai.md §5.6). Physics run in "AI friction mode" (tarmac tyre rows on
  every surface, `frictionLevel = min(FL, 0)`). The AiTimes schedule (360 files) throttles a car that is behind its
  target time. AI cars use the SoundAI "Simple" sound set and `othercarlodlevel`. Every career event has
  `OpponentCount = 3` on every discipline [D], up to 4 participants per race [E].
* **Car-car contact**: after all cars have stepped, FUN_004a7980 walks the pairs and calls FUN_006d4390 (the same body-body
  impulse the loose-parts contact uses; hull = the `Car_<Name>.col` 18 points + 10 planes), which also writes the car-car
  collision record used by the impact sound (dynamics.md §7).
* **Ghosts**: a ghost is a pose-driven `<Car>Ghost` RallyCar (4 wheels + body + interior, no sound), played from a v2.0
  (shipped team, 30 files) or v3.0 (saved) file: 15 Hz delta frames, 8 physics ticks per frame, slerp, freezes at the
  end. Only the session best is recordable/savable (SAVE GHOST with a name). Specs: ghosts.md.

## 2. The four builders

All four start at once; every seam they share is a typed contract plus a working stub (§4), so none waits for another.

| key | builder | one-line goal |
|---|---|---|
| `sim-contact` | car-car contact | FUN_004a7980 car-car loop and FUN_006d4390 as a sim primitive (`stepCarContacts`) plus the live body view of `CarSim`, proven in unicorn, with the car-car collision record. |
| `ai-brain` | the original AI controller | FUN_007e0540 + FUN_00607280/00607ae0 as `createAiDriver`, the `ai` asset part (AiData, AiTimes), the AI friction option in the sim; validated against unicorn and the Frida AI runs. |
| `ai-race` | multi-car race | roster, grid (0x484769), `CarField` (sims, trackers, laps/finish, stuck/reset, standings), race flow and results, renderer/audio/menu/HUD for opponents. |
| `ghosts` | ghosts | the exe ghost format (decode/encode), tick-exact recorder/player, team ghosts shipped as an asset part, user ghosts (save/list/delete), ghost car selection, menu rows. |

Why `ai-brain` and `ai-race` are separate: the specs list unresolved decode work for FUN_00607ae0 (register arguments,
discipline-to-skill mapping, tick cadence) that is research-heavy and independent of the race plumbing. `ai-race` drives
the stable `AiDriver` interface (§4.4) with the architect's Autopilot placeholder until the real driver lands.

## 3. Ownership map

Every file has exactly one owner. "Region" rules for shared files are in §3.2. Anything not listed: do not edit; ask via
`known_issues` in your report.

### 3.1 Files

| owner | files |
|---|---|
| **architect** (contract; read-only for builders, contract requests go in `known_issues`) | `src/core/field.ts`, `src/core/ghosts.ts`, `src/core/types.ts` (phase-2 additions), `src/core/constants.ts`, `src/debug/testApi.ts`, `src/ui/menuExtras.ts`, `src/game/ai/driver.ts` (the interface and types; the body of `createAiDriver` is `ai-brain`'s, see below), `tests/contracts/**`, `docs/PHASE2_AI.md`, `PROGRESS.md`, `docs/ARCHITECTURE.md`, `tools/smoke.mjs`, `tools/drive.mjs`, `tools/lib/harness.mjs` |
| **sim-contact** | `src/sim/contact.ts`, `src/sim/contact/**`, `tests/sim/contact*.test.ts`, `tests/sim/fixtures/contact/**`, `research/tools/contact_*.py` (new scratch/proof tools), `research/formats/dynamics.md` (§7 corrections only), `docs/MECHANICS_SPEC.md` (a new subsection "car-car contact"; append-only), artifacts `artifacts/phase2/sim-contact/` |
| **ai-brain** | `src/game/ai/ctrl.ts`, `src/game/ai/aicar.ts`, `src/game/ai/aidata.ts`, the **body** of `createAiDriver` in `src/game/ai/driver.ts` (replace the placeholder section only; keep the exported types/signatures), `tests/game/ai/**` (+ `tests/game/ai/fixtures/**`), `tools/assets/parts/ai.py` (new asset part), `tools/assets/lib/formats/fmt_aidata.py`, `tools/assets/lib/formats/fmt_aitimes.py`, `research/formats/ai.md`, `research/tools/ai_*.py`, `docs/orig/ai.md` (new: port notes), `research/frida/replay.ts` (only the AI-friction rewrite region ~157-177), artifacts `artifacts/phase2/ai-brain/` |
| **ai-race** | `src/game/field.ts`, `src/game/grid.ts`, `src/game/ai/roster.ts`, `src/game/ai/standings.ts` (new), `src/ui/menuAi.ts`, `src/ui/hudAi.ts`, `src/audio/orig/otherCars.ts`, `tests/game/field*.test.ts`, `tests/game/grid.test.ts`, `tests/game/roster.test.ts`, `tests/audio/otherCars*.test.ts`, `tools/ai-race.mjs` (new browser driver for multi-car runs), `docs/orig/race.md` (append "multi-car race" sections), artifacts `artifacts/phase2/ai-race/` |
| **ghosts** | `src/game/ghosts/**` (new: `format.ts`, `recorder.ts`, `player.ts`, `store.ts`, `team.ts`, …), `src/game/ghost.ts` (becomes a thin compat layer or is retired; keep `tests/game/ghost.test.ts` green or migrate it), `src/game/bestTimes.ts`, `src/ui/menuGhosts.ts`, `tools/assets/parts/ghosts.py` (new asset part), `tools/assets/lib/formats/fmt_ghost.py`, `research/formats/ghosts.md`, `research/formats/ghosts_dump.json`, `research/tools/ghost_*.py`, `tests/game/ghost*.test.ts`, `tests/game/ghosts/**`, `docs/orig/ghosts.md` (new: port notes), artifacts `artifacts/phase2/ghosts/` |
| **railings fixer** (not part of this plan) | `src/world/orig/**`, `tools/assets/parts/collision.py`, `docs/orig/collision.md`, `tests/world/orig*.test.ts`, `tests/sim/objectPass.test.ts`, the objectPass region of `src/sim/car.ts` |

### 3.2 Shared files by region

| file | region | owner | rule for the others |
|---|---|---|---|
| `src/main.ts` | everything not listed below, the loop, `loadSelection`, `restartInPlace`, `beginRace`, the "PHASE 2: field + ghosts" block (`fieldHost`, `prepareField`, `addAiCar`, `fieldContext`, `syncGhostCars`) | architect (done now) | Builders do not restructure it. If a hook needs a change, make the smallest exact-match edit **inside** the PHASE 2 block or the three call sites (`physicsStep` field/contact lines, `render` field/ghost lines, `beginRace` field line), say so in `known_issues`, never reformat. `ai-race` may adjust `fieldHost.createCar` and `prepareField`; `ghosts` may add to the ghost host delegates (`listGhosts`...). |
| `src/game/race.ts` | the ghost region (`// ====== ghost` up to `// ====== internals`), the ghost fields, the ghost lines of `begin`/`startNow`/`finish`, `recordGhost` | **ghosts** | `ai-race` must not touch it. |
| `src/game/race.ts` | `gridS`, `gridPose`, the `gridIndex/gridCount` fields and their `begin` line | **ai-race** | `ghosts` must not touch it. |
| `src/game/race.ts` | the rest (phases, gates, resets, pacenotes, wrong way) | nobody this round | A bug there goes to `known_issues`. |
| `src/sim/car.ts` | objectPass and its constants | railings fixer | nobody else |
| `src/sim/car.ts` | "AI friction" (constructor + `rebuildDerived` surface-row handling of `CarSimOptions.aiFriction`; a private copy of the surface table; at most a few lines in the step) | **ai-brain** | smallest exact edits, add a region comment `// ===== AI friction (phase 2)`. |
| `src/sim/car.ts` | "contact body view" (`contactBody()` and what it needs, placed at the END of the class) | **sim-contact** | region comment `// ===== contact body (phase 2)`. Touching other methods requires a `known_issues` entry. |
| `src/render/renderer.ts` | `addCar` (the `ai`/`carIndex` options), `setCarLod`, the AI parts of `CarEntry` | **ai-race** | |
| `src/render/renderer.ts` | ghost entries (`ghost: true`: material pass, `ghostAlpha`) and `src/render/orig/carShader.ts` ghost code, `src/render/orig/car.ts` ghost part set | **ghosts** | change the look only with draw-level proof (ghosts.md §5); otherwise keep 0.35 |
| `src/audio/orig/player.ts` | the three `others.*` hook lines | **ai-race** | |
| `src/audio/audio.ts`, `src/audio/orig/carSound.ts`, `carInput.ts` | AI-sound needs (`CarSoundPlayer` already supports `human=false`) | **ai-race**, minimal exact edits | the audio mapper reads `CollisionTelemetry.carHits/carStrength` (`sim-contact` writes them) |
| `src/ui/menu.ts` | the `PHASE 2 hook` lines only (rows, results standings, results buttons, `extraEnv`) | architect (done now) | content lives in `menuAi.ts` / `menuGhosts.ts`. A new menu **screen** (ghost list, save-name prompt) is added by **ghosts** as a new `Screen` member with its own render/key code in `menuGhosts.ts` and the smallest possible dispatch lines in `menu.ts` (exact-match insertions, no reformat). |
| `src/ui/hud.ts` | the `AiHud` lines only | architect (done now) | content lives in `hudAi.ts` |
| `src/world/portedBuilder.ts` | `spawnGrid` on the ported stage (done) | architect | nobody |
| `research/frida/**` | `replay.ts` AI-friction region | **ai-brain** | the rest belongs to the sim owner of the previous phase; read-only |
| `docs/MECHANICS_SPEC.md` | new subsections only | **sim-contact** (car-car), **ai-brain** (§4.2 option wording) | the railings fixer is also editing it: append, never rewrite |
| `tools/assets/build.py`, `lib/**` | none | foundation | new parts are plugins in `tools/assets/parts/<name>.py`, auto-discovered; do not edit `build.py` |

## 4. Contracts and hook points (already applied; behaviour unchanged, `?ai` default 0)

### 4.1 Types (read these first)

* `src/core/field.ts` (new): `AiOpponentSpec`, `FieldHost`, `OtherCarFrame`, `FieldStepContext`, `StandingEntry`,
  `FieldCarSnapshot`, `FieldSnapshot`, `FieldEvent`, `IField`, `MAX_OPPONENTS = 3`, `aiCarId`, `slotBaseOfGrid`.
* `src/core/ghosts.ts` (new): `GhostSelection` (`off | best | team{id} | user{id}`), `GhostListEntry`.
* `src/core/types.ts`: `CarSimOptions.aiFriction` (line ~749), `CollisionTelemetry.carHits/carStrength` (~835),
  `RaceBeginOptions` (+ `IRaceController.begin`; `gridIndex`, `gridCount`, `ghost`), `AddCarOptions.ai/carIndex`,
  `CarRenderState.ai/carIndex`, `IGameRenderer.setCarLod?`, `FrameContext.others/field/fieldEvents`,
  `RaceSelection.opponents/ghost`, `IMenuHost.listGhosts?/saveSessionGhost?/deleteGhost?/canSaveGhost?`,
  `LaunchOptions.opponents`, `LoadStageOptions.opponents/ghost`, `RallyTestApi.getField/getGhosts`, `GhostInfo`.

### 4.2 The per-substep order (`src/main.ts` `physicsStep`)

```
controls -> player car.step
  -> field.step(DT, ctx)               AI drivers decide, every AI car.step            (ai-race calls ai-brain's driver)
  -> stepCarContacts([player, ...ai])  car-car contacts (only when there are AI cars)  (sim-contact)
  -> race.fixedUpdate(DT, tel)         player gates / resets / ghost record            (race.ts, ghosts region)
  -> field.afterStep(DT, ctx)          route tracking, laps, finish, stuck/reset, standings (ai-race)
```

This is the original's order (all physics, then contacts, then race logic; dynamics.md §7). Each `CarSim.step` still runs
that car's own object pass inside `step()`; the original interleaves "car i object pass, car i vs cars j >= i". The
difference is below one step of impulse ordering; sim-contact may split `step()` into physics + `objectPass` if it can
show (unicorn or trace) that the interleave matters, via a new optional `ICarSim` method and a `known_issues` note.

### 4.3 Hook points

| what | where | who fills it |
|---|---|---|
| field creation, `field.prepare/begin/step/afterStep/renderStates/otherFrames/snapshot` | `src/main.ts` constructor fields ~177, `loadSelection` ~362 (`prepareField`), `beginRace` ~402, `restartInPlace` ~424, `physicsStep` ~594, `render` ~639 | ai-race fills `src/game/field.ts` |
| AI CarSim factory (aiFriction, slotBase, private surface table) | `src/main.ts` `fieldHost.createCar` ~451 | architect wrote it; ai-brain makes `aiFriction` real in `src/sim/car.ts` |
| contact step | `src/main.ts` `physicsStep` (`stepCarContacts`) -> `src/sim/contact.ts` | sim-contact |
| grid slots | `src/game/grid.ts` `gridSlot` / `gridSimPose` (FUN_00484640, executed in unicorn) used by `race.ts gridS/gridPose` and the field | ai-race (done) |
| ported stage spawn grid | `Stage.spawnGrid` on ported stages (`portedBuilder.ts withSpawn`), read by `stageSpawnGrid` | done |
| AI driver | `src/game/ai/driver.ts` `AiDriver`, `createAiDriver` (the ported original controller, `placeholder: false`; the Autopilot stand-in is gone from the game path) | ai-brain (done) |
| AiData / AiTimes loading | `src/game/ai/aidata.ts` (`loadAiStageData`, `loadAiSchedule`; resolve null without assets); asset part `ai` -> `stages/<id>/ai.json`, `global/ai.json` | ai-brain; ai-race calls them from `CarField.prepare` |
| roster | `src/game/ai/roster.ts` `buildRoster` / `buildRosterInfo` | ai-race (done) |
| AI render | `renderer.addCar(..., { ai, carIndex })`, `renderer.setCarLod` (stored only) | ai-race |
| AI sound | `src/audio/orig/otherCars.ts` (SoundAI Simple set per AI car) called from `player.ts` (`others.*` hooks) | ai-race (done) |
| menu rows / results / buttons | `menu.ts` lines ~564 (rows), ~628 (standings), ~339 (buttons); `menuAi.ts`, `menuGhosts.ts` | ai-race / ghosts |
| HUD position | `hud.ts` `AiHud` (~169, ~321); `hudAi.ts` | ai-race |
| ghost cars | `RaceController.ghostRenderStates/ghostInfos/listGhosts/canSaveGhost/saveSessionGhost/deleteGhost` (ghost region) + main's `syncGhostCars` | ghosts |
| ghost selection | `RaceSelection.ghost` -> `RaceBeginOptions.ghost` -> `RaceController.selectedGhost` | ghosts |
| test API | `window.__rally.getField()`, `getGhosts()`, `loadStage(id, { opponents, ghost })`, URL `?ai=0..3` | architect (done) |

### 4.4 Defaults and decisions made here

* **Solo is the default** everywhere the tools run: `?ai` absent = 0 opponents, `loadStage` without `opponents` keeps the
  current selection (0). `tools/all-stages.mjs`, `tools/smoke.mjs`, `tools/drive.mjs` are API-driven and stay solo.
* The **menu's Opponents row** default is `ai-race`'s decision; recommendation 3, because every original career event has
  `OpponentCount = 3` on all disciplines [D]. It writes `RaceSelection.opponents`; the Start button passes it to `startRace`.
* **Which cars**: the event's `Car =` list when the stage belongs to a career event (22 events, `.cache/original/Misc/events`),
  else the AI name table (ai.md §1.1). The player's own car is excluded. Deterministic for (selection, stage, seed).
* **Tick cadence**: `AiDriver.update` is called once per physics substep (120 Hz) with `dt = 1/120`; if the original runs
  FUN_00607ae0 per rendered frame (open question ai.md), the driver accumulates dt internally and computes at the
  original's cadence. `ai-brain` settles this from the Frida run 2 frame records and records it in `docs/orig/ai.md`.
* **Team ghosts are shipped** into `public/assets` as the `ghosts` asset part (all original assets are ours and in scope;
  gitignored like the other parts, copied to `dist/` by the build). The soundtrack rule is untouched.
* The ghost's current look (`ghostAlpha 0.35`, env-only pass) is [I]; change it only with draw-level proof.
* AI cars are never the camera target; their wheels emit effects (dust, skid marks) like the player's; shadows follow the
  renderer's existing per-car rules.
* Perf budget: 4 cars at 120 Hz must stay playable headless (SwiftShader) at the same speed as before per car: the field step
  must not allocate per substep.

## 5. Integration sequence

0. **Architect (done in this change)**: contracts, stubs, hooks, `tests/contracts/phase2.test.ts`; `tsc`, `vitest`, `smoke` green.
1. **Parallel (all four builders, no ordering)**: each works against the stubs. Order of preference inside a builder is in its brief.
2. **Merge points** (the builders verify these themselves when the other lands; no one waits):
   * `sim-contact` lands `stepCarContacts` + `CarSim.contactBody()`: `ai-race` re-runs its 4-car stage runs and checks that
     cars no longer pass through each other and the impact sound fires from `carHits`.
   * `ai-brain` lands the real `createAiDriver` + `ai` part + `aiFriction`: `ai-race` re-runs the multi-car acceptance with
     `placeholder === false` (the run asserts it) and its screenshot set.
   * `ghosts` is independent; it needs `ai-race` only for a menu that shows both rows (the two builders edit different
     files; the integration check is a manual screenshot of the main menu).
3. **Integration pass (architect/integrator, after all four report)**: `npx tsc --noEmit`, `npx vitest run` (incl. a CI-like
   copy without `public/assets`, `research/`, `.cache/`), `npm run smoke`, `npm run build`, `node tools/all-stages.mjs`
   (solo, 48/48), `node tools/assets/check-game.mjs`, plus a 4-car run (`tools/ai-race.mjs`) on one stage per discipline,
   the full-field team-ghost run, and `PROGRESS.md` (P1 item 6 and the car-car part of item 10 closed). Conflicts between
   builders' edits to shared files are resolved here.

## 6. Acceptance bars

Common to all builders: `npx tsc --noEmit` clean; `npx vitest run` green (the builder's own tests included; tests that need
`public/assets` or `.cache/original` skip cleanly when absent, like the existing ones); `npm run smoke` ok; `tools/all-stages.mjs`
still 48/48 solo (when the builder touched anything the solo race runs through); **0 console errors/warnings** in every browser
check; browser checks save screenshots under `artifacts/phase2/<key>/` (named by what they show); no scratch files left in
`tests/` or `src/`; all claims tagged [E]/[D]/[I]; never commit; never copy `original_version/Sound/Music`.

### sim-contact
1. `src/sim/contact.ts` implements FUN_004a7980's car-car loop (pair order, self-pair skip, `collidable`, the object-pass
   interleave note of §4.2) and FUN_006d4390 / FUN_006d4fd0 / FUN_006d5240 for **two car bodies** (18-point hulls + 10 planes of
   `Car_<Name>.col`, `flag = 1`).
2. **Unicorn proof** of the car-car configuration: extend `research/tools/emu_dyn.py` / `dyn_ref.py` style harnesses (needs a
   scratch venv with `unicorn`, not `.venv`): >= 2 000 random two-car cases with real car hulls, 0 disagreements beyond the
   documented float32 tolerance (compare against dyn_ref.contact float64 and the executed original); fixtures committed small
   (<= 1 MB) under `tests/sim/fixtures/contact/`, a vitest that replays them through the TS port.
3. `CarSim.contactBody()` (region at the end of `car.ts`) returns the live view the contact needs and applies the results to the
   car's `v`, `L`, anchor memory and impact fields; the next `step()` and `telemetry()` see them (cache invalidated). Zero change
   to a solo run: bit-identical telemetry over a 20 s `tools/drive.mjs --until-finish` run (compare `artifacts/finish` summaries).
4. `CollisionTelemetry.carHits/carStrength` written exactly as dynamics.md §7 (`record.carHit`, strength = B+0x19c, both cars).
5. Two real `CarSim`s on a real stage (Track.gcm) in a vitest/script: head-on, rear-end, side swipe: impulses finite, no energy
   gain beyond the original's own (`j = −0.8·…`), no NaN, `simFaults` 0, cars separate; a stacked/resting pair does not explode.
6. No per-call allocation in `stepCarContacts` (a perf test: 4 cars x 1 s of steps well under the sim budget).
7. Deliverable doc: MECHANICS_SPEC subsection + dynamics.md §7 corrections; artifacts: a screenshot pair of a collision.

### ai-brain
1. **Controller**: `src/game/ai/ctrl.ts` matches the unicorn execution of FUN_007e0540 with max |delta| <= 1e-6 over the full
   randomized vector suite (vectors exported by `research/tools/ai_ctrl_emu.py` into a committed fixture, 5 000+ cases incl. every
   state/sub-state and band edge), re-run as a vitest.
2. **Per-frame controller** (`aicar.ts`: FUN_00607280 init and FUN_00607ae0): the unresolved arguments (EBP/ESI/EDI = overtake
   window, lateral margin, lane sign) decoded from the disassembly **and** the function executed in unicorn on synthetic car/
   spline state: TS vs unicorn equal to float32 tolerance on >= 2 000 cases covering the circle law, look-ahead, curve cut,
   the overtake/lane machine (all four states), near-car cuts, spin recovery, AiTimes cuts (documented in ai.md as [E]).
3. **Replay proof**: with `aiFriction` and the real driver, the port reproduces Frida run 2's AI Micra and Corolla within the
   existing `compare.audit.ts` tolerances (inputs and positions per frame; report max/median errors in `docs/orig/ai.md`);
   `research/frida/replay.ts` uses the sim option instead of its private surface-table rewrite.
4. **AiData/AiTimes**: `tools/assets/parts/ai.py` writes `stages/<id>/ai.json` for all 48 stages (0 errors, 804 posts) and
   `global/aitimes.json` (360 files, 0 errors); `loadAiStageData`/`loadAiSchedule` read them (null without assets).
5. **AI friction**: `CarSimOptions.aiFriction` honoured per ai.md §10 [E 0x6c4978-0x6c49ac, 0x6cb6cb], on a private surface copy;
   with it off, existing sim tests stay green and player telemetry is bit-identical.
6. `createAiDriver` returns `placeholder: false`; a solo AI car (no player) drives every one of the 48 stages to the finish (the
   AI analogue of `tools/all-stages.mjs`: add `tools/ai-stages.mjs`), with lap times within the AiTimes order of magnitude, 0
   resets on rally stages (report the table).
7. Mapping questions answered with evidence or flagged [I]: discipline -> skill group (ai.md §1.1), tick cadence, tyreScale.

### ai-race
1. **Grid**: `gridSlot` proven from the exe (0x484769, unicorn or exact disassembly) and tested on all 48 ported stages for 1..4
   cars: every slot on the road (|lateral| <= half road width), no overlaps, the player's slot = the original's.
2. **Roster**: `buildRoster` deterministic; career-event stages use the event's `Car =` list (22 events), others the name table;
   player's car excluded; `OpponentCount`-style limit 3; tyreScale/skill per ai.md.
3. **CarField** implements `IField`: AI sims via `FieldHost`, parked until GO, countdown shared with the player (3 s), per-substep
   `step`/`afterStep`, route tracking with the shared gate utilities (`src/game/timing.ts`), laps and finish per AI car, stuck and
   off-road recovery (decode the original's AI stuck rule, race.md open item 12, or document the port rule as [I]), standings
   (finish order, then distance), `snapshot()` JSON-safe, no per-substep allocation.
4. **Race flow**: results screen shows the standings (`aiResultsHtml`); what happens when the player finishes first/last is
   decided and documented (the AI cars keep driving to their finish or the standings freeze after N s); restart, stage change
   and menu round-trips leave no AI sim, renderer car or sound behind (checked by `getField()` and renderer car counts).
5. **Render**: AI cars show their original meshes/liveries via `addCar({ ai: true, carIndex })`; `setCarLod` implements the
   original's `othercarlodlevel` choice if decodable from the exe (FUN_00694f50) else documented as [I]; no console errors.
6. **Audio**: `otherCars.ts` plays the SoundAI Simple set per AI car (3-D, doppler), starts/stops with the field; voice budget
   respected (no more than the original's AI scripts); the synth fallback stays silent for AI.
7. **Menu/HUD**: Opponents row; position "n / N" and a standings strip in the HUD; results standings; all plain HTML/CSS in the
   existing style; keyboard + pad reachable.
8. **Browser acceptance** (`tools/ai-race.mjs`, stepped, deterministic): a 4-car race to the finish on one stage per discipline
   (corsica-1-f, hillclimb-1a-f, iceracing-1-f, rallycross-1-f) with the real driver: standings correct, all AI finish, 0 console
   errors, screenshots (grid at countdown, mid-race, results, menu row, HUD) in `artifacts/phase2/ai-race/`. Re-run after
   `sim-contact` lands (cars collide) and after `ai-brain` lands (`placeholder === false`).
9. Solo regression: `?ai` absent and `opponents: 0` behave exactly as before (tests/contracts/phase2.test.ts stays green;
   all-stages 48/48).

### ghosts
1. **Format**: `src/game/ghosts/format.ts` decodes/encodes the exe layout (v2.0 and v3.0 headers, 36-byte initial state, 19-byte
   frames, hold frames, 20-byte trailer kept opaque) with the exe's float32 rounding; **all 30 team ghosts** decode to the same
   values as `fmt_ghost.py`/the unicorn-verified dump (39 710 frames, 0 mismatches); encode(decode(x)) reproduces the frames
   byte-for-byte; a v3.0 round trip.
2. **Playback**: tick-driven from GO exactly as FUN_004db730 (8 ticks per frame, frame k at tick 8k+7, linear position, slerp,
   hold counter, freeze at 7/8 of the last segment); tested against the exe's playback output (`research/tools/ghost_play_emu.py`,
   normalised quaternion diff < 1e-6) and the end-freeze rule.
3. **Recording**: 15 Hz grid, 5 173-frame cap, hold frames; session best kept (the faster of the session's finished runs), saved
   only by SAVE GHOST; the existing auto-saved best-run ghost per (stage, seed, car) keeps working through the same new layout
   (migrate or ignore the old `rally-web:ghost:v2:*` JSON without errors).
4. **Team ghosts**: `tools/assets/parts/ghosts.py` ships the 30 files (index + binary) under `public/assets/global/` (or per
   stage); the Ghost row lists a stage's team ghosts with driver, car and time; selecting one races it with the ghost file's
   car (`<Car>Ghost` template minus "Ghost"): 26 of 48 stages have one, the 22 others list none.
5. **User ghosts**: SAVE GHOST (name prompt with the original's rules, overwrite confirm, delete) via IndexedDB (stage id + car +
   name) in the 3.0 layout; list/load/delete round trip; a saved ghost loads in a fresh page.
6. **Ghost car**: the file's car, 4 wheels + body + interior only, no sound, no shadow, no effects; stays silent. Look unchanged
   unless proven.
7. **Test API**: `getGhosts()` reports id/source/car/time/tick/finished; a stepped run asserts the ghost position at known ticks
   against the decoded file.
8. Browser acceptance: for 3 stages with team ghosts (e.g. hillclimb-2c-r with DeltaS4, rallycross-1-f with Peugeot206, and one
   more) screenshots of the menu row, the ghost beside the player at GO, mid-run and the frozen end; 0 console errors;
   `ghost=0` hides it; solo regression as above.

## 7. Tools and gotchas

* `unicorn` is not in `.venv`: `uv venv <scratch>/ucvenv && uv pip install --python <scratch>/ucvenv/bin/python unicorn`; run
  `<scratch>/ucvenv/bin/python -I research/tools/<script>.py`. Python on extracted data otherwise `.venv/bin/python -I`.
* `npm run assets -- --stages all --parts ai` (new parts: `--parts ai`, `--parts ghosts`); never `--clean` the shared tree.
* Browser tools start vite on free ports, so parallel runs are safe. Use `tools/drive.mjs --stepped`/`--until-finish` for
  deterministic runs and the test API (`window.__rally`) for state; do not scrape the DOM for race state.
* Layering: `src/game` must not import `CarSim`; AI sims come through `FieldHost` (main.ts). `src/sim` has no DOM/three. The
  core types are the only shared dependency.
* Ids: player `'player'`, AI `'ai1'..'ai3'` (`aiCarId`), ghost `'ghost'`. Face-cache slots `24 * gridIndex + ...`
  (`slotBaseOfGrid`); the player is grid index 0.
* A builder that needs a contract change keeps going with a local workaround and reports it in `known_issues` (what, why,
  proposed signature); the architect applies it at the integration pass.
