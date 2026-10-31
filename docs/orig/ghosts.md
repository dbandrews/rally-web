# Ghosts: port notes (phase 2)

How the browser build implements the original's ghost subsystem. The original's behaviour and every address are in
`research/formats/ghosts.md` (the authority; this file is the port side). Tags: **[E]** exe-verified (executed under unicorn
or read from the disassembly), **[D]** data-verified, **[I]** inferred.

## 1. Module layout

| file | role |
|---|---|
| `src/game/ghosts/format.ts` | the exe file layout (2.0 team, 3.0 saved): parse / write, the 19-byte frame codec `decodeFrame` (FUN_004dccb0) / `encodeFrame` (FUN_004dc7b0), `keyStates` |
| `src/game/ghosts/player.ts` | `GhostPlayer`: FUN_004db730 + the manager's hold counter, one `step()` per 120 Hz tick from GO |
| `src/game/ghosts/recorder.ts` | `GhostRecorder15`: FUN_004db540 (15 Hz grid, hold frames, 5173-frame cap, the stationary-start quirk), `toFile()` = the 3.0 save layout |
| `src/game/ghosts/frame.ts` | file state <-> port frames (world offset, handedness, quaternion, steer / spin units and signs), render-pose interpolation |
| `src/game/ghosts/session.ts` | `GhostSession`: the ghost manager of a race (recorder + playback slot + session best + team / saved lists + the ghost `CarRenderState`) |
| `src/game/ghosts/store.ts` | saved ghosts: IndexedDB (stage, car, name) with a memory fallback, the 3.0 bytes as the record |
| `src/game/ghosts/team.ts` | the shipped team ghosts from the `ghosts` asset part (`global/ghosts.json`, `global/ghosts/<file>.bin`) |
| `src/game/ghosts/names.ts` | SAVE GHOST name rules, the original's strings (locale 413 / 414 / 572 / 612 / 614 / 615 / 636 / 882 / 1270 / 1271) |
| `src/game/bestTimes.ts` | the stored best-run ghost: base64 of the 3.0 file under `rally-web:ghost:v3:<stage>:<seed>:<car>` |
| `src/game/race.ts` ghost region | thin shell over `GhostSession` (`ghostRenderStates`, `ghostInfos`, `listGhosts`, `canSaveGhost`, `saveSessionGhost`, `deleteGhost`, `prepareGhost`, `hasGhost`, `ghostPose`) |
| `src/ui/menuGhosts.ts` | the Ghost row, SAVE GHOST button + name dialog, Delete confirm |
| `tools/assets/parts/ghosts.py` | the asset part (30 files + index + the 48 stages' H) |

`src/game/ghost.ts` (the 30 Hz Float32 recorder) is retired.

## 2. Arithmetic: the game runs its x87 code in SINGLE precision [E]

Direct3D 8 `CreateDevice` is called without `D3DCREATE_FPU_PRESERVE` (the behaviour flags at 0x68cf5e are 0x20 / 0x40 / 0x50 /
0x80), so after the device exists every x87 add / sub / mul / div result is rounded to float32. The TS port therefore rounds
(`Math.fround`) after **every** operation; transcendentals (`acos`, `sin`) stay full precision (x87 PC does not apply to them).

The earlier proofs of this subsystem used a float64 "80-bit intermediates" model and agreed with unicorn only because **unicorn
starts with PC=80 until the first `fldcw`** (the first `__ftol` switches it to 24 bit with control word 0): the model was right for
the first calls and wrong afterwards. `research/tools/ghost_exe_fixtures.py` now sets the control word to 0x7f first (what D3D leaves).
Result: the single-precision model is bit-exact on 39 710 real frames, 270 000 random decoded components and 30 000 random encodes;
the old model differs by one float32 ulp in ~8 % of the components (42 % of the real frames). `fmt_ghost.py` keeps both
(`decode_frame` = real game, `*_x80` = the old model). **Other unicorn harnesses in `research/` (sim, collision, AI) should set the control
word the same way** (see `known_issues` of the ghosts report).

Consequence for "encode(decode(frame)) == frame": it cannot hold. The decoded state is an absolute float32 (a position near 2000 has
2.4e-4 m resolution, a frame quantum is 1e-3 m) so the recorder's sub-ulp input is gone; re-encoding lands within +-1 LSB of every
component (all 39 710 frames; flags equal except 25) and the exe's own encoder does the same. What is exact: the TS encoder equals the
executed FUN_004dc7b0 byte for byte on 3030 recorded cases.

## 3. Time base [E]

Ghost time is the TICK count from GO (120 Hz, 8 ticks per 15 Hz frame), never the race clock or wall time. `RaceController` calls
`GhostSession.tick(tel)` once per `fixedUpdate` of the running phase. Tick 0 shows the initial state, tick 8s + c is c/8 of the way
through segment s (frame k is recorded at tick 8k + 7 and shown from tick 8k + 8: **the ghost lags the recorded run by exactly one
tick**), the last frame is never shown and the ghost freezes after `(frameCount - 1) * 8` ticks at 7/8 of the last segment.
The ghost stops with the race (the player's finish): the exe plays it only while the race object is in state 5.
Render poses interpolate between the last two ticks with the same alpha as the player's car (the exe renders per tick).

## 4. Frames [E/D]

World frame = sim + (2048, H, 2048), H = `Game.createTrack`'s third argument (424; iceracing-1 24; kenya 124; newzealand-1 100;
newzealand-2/3 200; rallycross-1 10; the part also ships all 48). The file quaternion is the conjugate of the sim quaternion
(`quatSim`); three = sim with z negated. Steer is degrees, + = right; the file's spin angle runs **negative** while the car rolls
forward, so `spin_file = -wheel[0].spinAngle` in degrees. Proof on real data (`tests/game/ghosts/frame.test.ts`, 30 files): every
ghost starts on its stage's road facing along it (|dot| > 0.97, lateral < 11 m) and passes its split gates at its split times to
< 1.2 m (after removing the start-slot offset below), i.e. H, handedness and tick 0 = GO are all confirmed.

**Start slots.** The ghost's first state is the player's grid slot in the original run. It differs from the port's `race.spawnGrid`
position by a constant per stage (hillclimb-2c-r -4 m, hillclimb-2a-r -10.7 m, hillclimb-3b-f -24 m, newzealand-1-r -24 m,
hillclimb-1c-f -79 m, rallycross 1/3 -70..-78 m, corsica 1/3 -6..-12 m, kenya 6..18 m), and **the split gates are crossed that same distance
LATER than the port's gate positions** (residual after subtracting the offset < 1 m on all 24 point-to-point files). So the original
times a trigger by the distance travelled from the car's OWN start position, not from the line [I from [D] data]. The race / grid
owners should use these 30 starts as ground truth for the player slot (the ghosts were raced with the stage's opponents on the grid).

**Integration check [D], 2026-10-30 (what these 30 starts do NOT show).** The offsets are not grid slots: on every point-to-point file but hillclimb-1c-f (whose start lies
before the centre spline) the ghost starts on the centre line (|lateral| <= 0.1 m; a grid start would be +-2 m at count > 1), and the s offsets (-1.6 ... -24 m, e.g.
hillclimb-2c-r -4.1, hillclimb-3b-f -23.9, corsica-1-f -11.1) are not multiples of the row spacing (6 m), so they cannot fix which grid index
the player takes (still **[I]**: index 0, left column, front row; race.md 9a.1). Nor do they need an engine rule: the original plays a ghost from
the file's own initial pose (FUN_004db730), so a ghost that starts a few metres behind the car is reproduced as is (the port does the same).
Whether the offset comes from a trigger rule ("measured from the car's own start") or from the build of the stage the ghosts were recorded on
(the files ship with the game and may predate the final track data) is **unresolved [I]**; the port keeps the stage's own gate positions.
The ghost is not drawn during the countdown (it takes its first pose at tick 0 = GO) **[I]**; the exe's state-5-only playback is [E], whether a
ghost is drawn parked before GO is not decoded.

## 5. Recording and the session best [E]

`GhostRecorder15` is FUN_004db540 verbatim, proven against the executed function on 9 deterministic streams (frames, hold frames, index,
sub-tick, initial state, the 5173 cap). Quirks kept: the first call stores the initial state; a stationary start re-samples it every
period (the leading stillness is trimmed in 8-tick steps); identical frames make one HOLD frame whose count grows (stored as
`holdCount`, shown for `holdCount + 1` periods); a trailing hold is not counted; a hold at frame 0 plays for one period only.

`GhostSession.finishRun` keeps the faster valid run of this (stage, seed, car) as the session best (slot 0x278, FUN_004db290). Only it can be
saved (SAVE GHOST). A run with a debug teleport is invalid. The stored best-run ghost (localStorage) is written when a run beats the stored
best time, as before, but in the exe layout.

## 6. Team ghosts and the unlock decision [I]

`enableTeamGhosts` (set by FUN_00617840 from an unresolved predicate) is not reproduced: the port offers the team ghosts of a stage in the
Ghost row whenever the `ghosts` part is built, with no unlock. 26 stages list at least one (4 list two), 22 list none. A team ghost races
with the file's car (`<Car>Ghost` minus "Ghost"), whatever the player drives. Selecting one in the menu warms its file; `main.ts` awaits
`RaceController.prepareGhost` (loadSelection, restart with a changed selection) so the race starts with it; a ghost that still arrives
after GO catches up to the current tick.

## 7. Saved ghosts

SAVE GHOST (results screen, when a session best exists): name dialog with the original's wording; invalid name (the Windows file-name rule
[I], the exe's check was not traced), overwrite confirm (same name, any case), "Saving ghost file...", not-enough-space text when the store
refuses. The record is the 3.0 file (`GhostFile.version '3.0'`, name pair, FILETIME date, splits, initial state, frames, no trailer):
exportable as a real original ghost file. The Delete key on a saved ghost in the Ghost row asks "Do you really want to delete the ghost
file:" first. IndexedDB database `rally-web-ghosts`, store `ghosts`, key `user:<stage>/<car>/<lower-case name>`; a database that cannot be opened
switches to memory for the session (`degraded`; the save dialog then says the ghost is kept until the page closes). A failed write on a working
database (quota; a write counts when its transaction commits) is not hidden by a memory write: SAVE GHOST shows the not-enough-space text.

Old `rally-web:ghost:v2:*` JSON ghosts (30 Hz Float32) are never read and no error is raised: they lack the wheel spin and the exe's frame
grid; the best time record is kept, the ghost is rewritten at the next best run. `BestTimes.clear` removes both keys.

## 8. Ghost car [D/I]

The ghost is the file's car with the original's ghost part set (4 wheels + body + interior, no sound, no shadow, no effects: `Ghost.con`).
Wheels: the front pair carries the recorded steer, all four the recorded wheel-0 spin (FUN_0049bb90), none touches the ground (rest
position). The look (env-only pass, alpha 0.35) is unchanged [I]: the Car/Ghost pixel shader is not pinned (research/formats/ghosts.md §5, §10.2).

## 9. Tests and tools

`tests/game/ghosts/{format,player,recorder,frame,session,store}.test.ts`; fixtures from `research/tools/ghost_exe_fixtures.py`
(`<unicorn venv>/bin/python -I research/tools/ghost_exe_fixtures.py [--all-out DIR]`; `GHOST_PLAY_ALL=DIR` makes `player.test.ts` compare
all 30 files tick by tick: 317 440 ticks, position / steer / spin bit-exact, quaternion direction max 9.1e-8). Browser acceptance:
`node tools/ghosts-check.mjs` (screenshots and `result.json` in `artifacts/phase2/ghosts/`).
