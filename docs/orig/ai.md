# AI opponents: port notes (the original `RallyCar` AI, phase 2 `ai-brain`)

Port of the original's AI car logic to TypeScript, proven against the original x87 code executed in unicorn and against the
Frida run-2 recording. Evidence tags as everywhere: **[E]** exe-verified (address cited), **[D]** data-verified, **[I]**
inferred. The spec this supersedes is `research/formats/ai.md` (its §5.1/§5.2 prose had errors, listed in §12 below).

Files: `src/game/ai/ctrl.ts` (FUN_007e0540), `src/game/ai/aicar.ts` (FUN_00607280 + FUN_00607ae0), `src/game/ai/driver.ts`
(`createAiDriver`, the geometry front end), `src/game/ai/aidata.ts` (loaders), `tools/assets/parts/ai.py` (asset part),
`src/sim/car.ts` ("AI friction (phase 2)"), tests `tests/game/ai/**`, proof tools `research/tools/ai_ctrl_fixture.py`,
`research/tools/ai_hl_emu.py`, table tool `tools/ai-stages.mjs`.

## 1. Numeric model: x87 at 24-bit precision [E]

The running game computes on the x87 FPU with the **24-bit precision control** (D3D8 switches it; the CRT's `_CIacos` 0x7a0770
keeps whatever precision control the caller has: `0x7a7405` = `(CW & 0x300) | 0x7f`). Every FADD/FSUB/FMUL/FDIV/FSQRT result is
therefore rounded to float32. `aicar.ts` / `ctrl.ts` model exactly that: each arithmetic op is `Math.fround` of a float64 op
(`mul/add/sub/div/sqr` helpers), loads of f32/f64 immediates are exact, transcendentals (FSIN/FCOS/FPATAN) are not rounded.
`acos` = `atan2(f32(sqrt(f32(f32(1+x)*f32(1-x)))), x)` (0x7a07a8-0x7a07b6). The unicorn harnesses write FPCW = 0x7f explicitly
(`research/tools/ai_ctrl_emu.py set_fpu`): unicorn's reset leaves its rounding state at 64-bit until a FLDCW executes, which made
earlier fixtures depend on run order. With this model the TS port is **bit-identical** to the executed exe (§9).

## 2. The object, the call order, the cadence [E]

`RallyCar` (class `dice.rx.ObjectTemplate.RallyCar`, size 0x9858, vtable 0x81a128). AI cars have byte `+0x17 = 1`
(FUN_00488590 @ 0x488aac). Per frame the engine calls vtable slot `+0x0c` = **FUN_00607280(flag, ctl, 0)** ("refresh") and slot
`+0x10` = **FUN_00607ae0(ctl, dt)** ("drive"); `ctl` is the car's `PhysCar` (pedals at P+0x60/64/68/6c, `ctl+0x54` = CP, CP+4 = the
rigid body B, CP+8 = speed km/h, B+0x34 = signed forward speed m/s, B+0xc8 = position, B+0xb8 = forward axis).
FUN_006c4ba0 returns **CP+8 = speed km/h** (not a "grip factor" as `research/formats/ai.md` §5.2 says), FUN_006c4b90 B+0x34, FUN_006c4b30
B+0xc8, FUN_006c4b60 B+0xb8 (the forward AXIS, not the velocity), FUN_006c4bb0 CP+0x30 (the out byte).

**Cadence [D]**: the Frida run-2 AI cars write new pedals **every physics step** (dt = 1/120 s; steer moves by exactly 2·dt, throttle by
0.5·dt per step; `tests/game/ai/traceReplay.test.ts`). `AiDriver.update` is called once per substep, no dt accumulation. Order inside a
step: refresh, then drive [I; drive reads fields refresh wrote].

## 3. The spline manager singleton (DAT_00935548) and what the port uses [E]

Class vtable 0x826220. Methods used by the AI (`AiEnv` in `aicar.ts` mirrors them): `+0x14` advance a (segment, distance) pair by d
(wraps through the segment list; clamps at the end of an open segment), `+0x18` the 3-D point at a pair, `+0x24` nearest-point update of a
car's pair (tolerances 0.1 / 0.05), `+0x1c` segment length, `+0x54` the post record at a pair, `+0x38/+0x3c/+0x40/+0x44` the per-segment
car list (sorted by distance): first / last / next after / previous before a car, `+0x48/+0x4c` insert / re-sort. All 48 stages have
**one** segment (the centre spline), so a pair is (0, distance). The port's `Stage` spline is the same AiFiles centre spline with the
same arc-length unit [D race.md], so `advance` = wrap (closed) / clamp (open) of `s + d` and `pointAt` = the stage's point mirrored to sim
space. The car list is circular: ahead = the next car by distance (the first car when I am last), behind = the previous (the last when I am
first) [E 0x607fee-0x60806c]; the exe's gap to "ahead" wraps by adding the segment length while negative.

**The post record** (vt+0x54) is per **sample**, not per AiData post: `AIFiles/side.rsd` holds `u32 count` + `count` records of 16 bytes
`{u32 0, f32 dist, f32 left, f32 right}` with dist = 5 m steps (0..3750 for corsica-1-f) [D, 48 files]: the road clearance left / right of
the centre line. FUN_004f0ea0 (0x4f0f10-0x4f1007) builds the sample table: each sample takes the AiData post with the largest
`lapDist <= sample distance`, scanning from a persisted index that advances at most one post per sample [E]. The post a car reads is the
sample at `floor(dist/5)` of the pair `dist + look0` (`[esi+0x194]`, the near look-ahead point) [E 0x6078a0-0x6078b6]. The asset part
`ai` stores `posts` + `samples {n, step, dist[], left[], right[], post[]}` per stage (804 posts, 39 827 samples, 48 files).

## 4. FUN_00607280 "refresh" (aicar.ts `refresh`) [E]

In order: nearest-point update (`+0x190` = pair distance, `+0x74 lapDist` = it, `+0x1c` = segment length); `+0x78 look0 = speedKmh /
lookAheadDist(+0x68, the value of the previous frame) + 5` (5.0 when lookAheadDist <= 0); position (y forced 0) -> `+0xb4`; the body forward axis (y 0)
normalised -> `+0xd8`; the spline point under the car `+0xc0`; offsets `+0xe4/+0xf0`; `+0x80` = 3-D distance; `+0x7c` = horizontal distance
(FUN_007e1150) with the sign flipped when `cross(offset, tangent) >= 0` (so + = right in sim space); the unit tangent from the point 1 m ahead
`+0x108`; the right vector `(tz, 0, -tx)` -> `+0x114`; `+0x9c = 3 * cross(heading, tangent)` (a yaw-error measure; **not** a half width, the
overtake code uses `|other+0x9c|` as a lateral margin); the near look-ahead point `+0x120` at `dist + look0`; the post there.
Post -> fields: mode 1: `rec(+0x5c) = post.rec * 3.6`, `< 10 -> 250.0`, `|lat| > 10 -> 40.0`; mode 0: raw `post.rec` when > 0; `+0x84/+0x88 =
left/right clearance`, `+0x8c/+0x90` their doubles, `+0x94 = left + lat`, `+0x98 = right - lat`; curveSpd / curveCut / lookAhead / thresh copied
only when > 0 (defaults 1 / 0.25 / 6 / 1 survive); then the mailbox cut (§5); `curveSpd *= skill(+0x50)`; finally `|lat| > 10 && rec > 40 -> rec = 40`
(constant 0x81a33c = **40**; `research/formats/ai.md` §5.1 had the comparison direction of the `|lat|` tests reversed).

## 5. The mailbox (0x8e5a84): the rubber band [E, interpretation I]

FUN_00607280 flag 0 **stores** the car's `(laps +0x20, distInLap +0x24)` in a global mailbox (vtable `+0x24/+0x2c`), flag 1 (AI cars) **reads**
it (`+0x28/+0x30`) and computes `f = (mailLaps*L + mailDist) - (own laps*L + own dist)`; with the byte `+0x4c == 1` (default 1) and the mailbox
distance >= 0: `f < -800 -> curveSpd *= 0.65`, `f < -400 -> *= 0.75`, `f < -200 -> *= 0.85` (constants 0x81a350/348/344 and 0x81a34c/80660c/81a340).
Reset (FUN_00609550) publishes -1 (off). The 0x65/0.75/0.85 cut therefore slows an AI car that is far **ahead** of the flag-0 car.
**Who is the flag-0 car** is [I]: the fit against the recording (§9.3) is best with the **human car** as the mailbox owner (the AI cars then
carry the clean factor 0.75 = the tyre-scale table value for difficulty level 1, instead of an unexplained 0.49 without it); the AiTimes
schedule (`FUN_004b4fe0`) is the other candidate. An AiTimes file holds `laps x (checkpoints + 1)` cumulative split times [D, every stage with a file: corsica-1-f 6 splits = 5 checkpoints + the finish, iceracing 10 = 5 laps x (1 checkpoint + the lap line);
the file's `LapCount` can exceed the stage's laps (iceracing-1-r: 7 vs 5)]; the driver's schedule position at race time t is the piecewise-linear distance through
`(0, 0), (split_i, checkpoint_i - startS (+ laps x length))`. `createAiDriver` feeds the mailbox from `AiDriverInputX.leaderLapDist` (the human's metres
from the start line) when given, else from the `AiTimes` schedule at `raceTime` (piecewise linear through the split times at the stage's checkpoint
distances), else it is off. **ai-race should pass `leaderLapDist`** (the player's `dist`).

## 6. FUN_00607ae0 "drive" (aicar.ts `update`) [E; bit-exact vs the exe]

1. Parked when `+0x18c < 0` (no track pair): pedals 0. Handbrake 0 every frame.
2. Far point = the pair advanced by `2*look0` -> `+0x12c`; unit vectors from the car (y 0) to the near and far points (`+0x168`, `+0x174`).
3. Heading error `h = cross(unit(far), tangent)` (FUN_007e1110, signed float32, `|h|` = x87 value); heading flag `+0x34 = 1` when
   `|h| > 0.5 - speedKmh*0.002`.
4. **Circle-law speed** (km/h): chord = |far vector|, `c = chord-normalised dot(far vector, tangent)` (clamped 1), theta = acos(c),
   `vt = sqrt(chord / (2 cos(pi/2 - theta)) * 9.82) * (curveSpd * tyreScale(+0x38)) * 3.6` (all float32 ops).
5. Curve cut: the target point T (starts at the near point) is shifted along the right vector by `window * curveCut * |h|` (window = `+0x88` for `h < 0`,
   `+0x84` for `h > 0`; sign + for h<0, - for h>0). With the heading flag and `rec > 60`, when the overtake state is not 0:
   `vt *= 1 - min(0.6, |lat|*6*|h| / (w88+w84))`.
6. Gate `L38 = ((3 - |h|)*(speedKmh/6 + 5) + 10) * thresh`; lateral margin `L30 = |h|*1.125 + 2.75 - max(0, 2 - cutBase(+0x44))`.
7. Other cars: ahead / behind from the list (§3); gap `d` = wrapped distance to ahead; `L11` = |ahead.lat - lat| < |ahead.+0x9c| + L30 (when `d < L38`),
   `L12` = ahead.lat >= lat.
8. **Overtake machine** (state `+0x2c`, target `+0xb0`, lane `+0xa0`, lane vector `+0xa4`): 0 none, 1 overtaking (target shifted by `R * min(6, 50/(d+0.1))`),
   2 lane change done (target kept shifted by the stored vector), 3 abort / reverse. All branches transcribed block by block with their addresses
   (`case 0x6081ce`... in `update`). Entry: overlap `L11` and (ahead slower than me + 2.5 km/h, or ahead's rec - 30 > its speed); the lane (`+0xa0`) is chosen from the
   free room `+0x94/+0x98/+0x84/+0x88` of both cars against `w = (|hw| + 0.975*L30)*(|h|+1)`; aborts set state 0 (or 3) and the "aborted" flag.
9. Near-car cuts (heading flag, ahead laterally inside `|hw| + 2.5*L30`): `vt *= 0.2 / 0.4 / 0.7` for gaps `< 6 / < 10 / < 15 m` (nearer = stronger), and the
   manoeuvre is dropped when `|h| > 0.3`. Then `vt = min(vt, rec)` (rec > 0), `target = (thrB + thrA) * vt`; a car within 6 m ahead forces state 3 (or the 10 km/h crawl).
10. **Controller** FUN_007e0540 (`ctrl.ts`) with `targetSpeed = target * 0.2777778` m/s, `reverse = state == 3`, point T, direction = the track tangent, dt.
11. Lateral nudge near the ahead car (`+0x48` scale), brake assist behind a slower car (throttle `*0.2/0.25/0.5/0.571`, brake 0.5 or 0.125 by closing speed and gap),
    the "just aborted" emergency brake (gap bins 6/10/20/30/40 m), spin recovery (`+0x54` flag, `+0x58` accumulated angle: steer 0, throttle `0.9 - 0.75 sin^2(1.5 a)`,
    controller timer 0), clamps (steer +-1, throttle / brake 0..1).

## 7. AI friction mode [E]

`CarSimOptions.aiFriction` (`src/sim/car.ts`, region "AI friction (phase 2)"): a **private deep copy** of the surface table with the tarmac tyre row's
`bestStatic / diffStatic / scaleKinetic / bestRollK` on every surface [E 0x6c4978-0x6c49ac] and `frictionLevel = min(FL, 0)` [E 0x6cb6cb]. With the option off
the car is bit-identical to one built without it (`tests/game/ai/aiFriction.test.ts`). `research/frida/replay.ts` uses the option.

## 8. What `createAiDriver` needs and returns (for the field)

`AiDriverInit`: `spec` (`skill` -> `+0x50`, `tyreScale` -> `+0x38`), `stage`, `data` (`loadAiStageData`, with `samples`; without them the driver builds
clearances from `stage.roadAt(s).width/2`), `schedule` (optional, §5). `AiDriverInput`: `self` telemetry (`posSim`, `quatSim`, `velLocal.z`, `speedKmh`),
`s` / `lateral` (stage projection, + right), `lapDist` = **metres from the start line, continuous over laps** (the field's `dist`), `others` (`s`, `lateral`,
`pos` three space, `speedKmh`; the heading is derived from successive positions, `halfWidth` is **unused**: the exe's `+0x9c` is a yaw-error measure), `raceTime`,
`running` (false -> parked controls, handbrake 1). Optional extras: `AiDriverInputX.leaderLapDist` (§5), `AiDriverX.syncPedals` (tests), `setRecovery(on)` (the spin-recovery
trigger: the exe's race code sets `+0x54` through vtable slot `+0x70`; who triggers it is not decoded, `ai-race`'s stuck rule can use it). Returns `Controls`
(steer, throttle, brake; handbrake 0; the automatic box does the gears). One update (refresh + drive, 3 other cars) costs about 27 us on a loaded machine (`tests/game/ai/driver.test.ts`); the object is typed memory with scalar locals, the per-call garbage is a handful of small closures plus the stage's own `pointAt` / `tangentAt` results.

**tyreScale is the game's difficulty setting** [E 0x489147-0x489165]: `switch(level)` 1 -> 0.75, 2 -> 0.8, 3 (default) -> 1.0, 4 -> 1.2, 5 -> 1.25
(FUN_00488590 passes it to vtable +0xb4 when the setting's enable flag is set). The Frida run's three AI cars fit **0.70-0.75** (§9.3) = level 1.
**skill** (`+0x50`) comes from the AIAttributeManager group (not decoded; 1.0 is used and fits the recording).

## 9. Proofs

1. **Controller** `tests/game/ai/ctrl.test.ts`: `tests/game/ai/fixtures/ctrl.json.gz` = 6 000 vectors executed in unicorn (every state / sub-state, the throttle/brake
   band edges, reverse, dt = 0, dead-band edges), generated by `research/tools/ai_ctrl_fixture.py`; **0 mismatches, worst |delta| 5.0e-8** (1 ulp at 0.5 magnitude);
   the Python reference `ref_controller` agrees on 20 000 random cases except 8 one-ulp x87 rounding differences (it uses float64 intermediates).
2. **AI car** `tests/game/ai/aicar.test.ts`: `fixtures/aicar.json.gz` = 3 100 cases (700 FUN_00607280, 2 400 FUN_00607ae0) of the real functions in unicorn on synthetic
   object graphs (real-layout RallyCar blocks, other cars with the real vtable, a PhysCar, the mailbox, the spline manager as machine-code stubs whose calls and arguments are recorded
   and asserted), `research/tools/ai_hl_emu.py`. Compared: the whole 0x200-byte car block, the controller state, the pedals, the out byte, the target pointer, the exact arguments handed to
   FUN_007e0540. **Tolerance 0: all 3 100 cases bit-identical.** Coverage of the drive set: every overtake transition (0->1, 0->3, 1->0/2/3, 2->0/1/3, 3->0/1), both lane directions,
   controller states 0/1/2/5, spin recovery, heading flag, near-car cuts. Mutation check: changing any of 0.7, 9.82, the 0.0625 brake bin, the 0.571 factor, the 15 m bin, the
   `t2` slope makes the suite fail (a 1 % perturbation of the `|h| > 0.3` and 25 km/h thresholds is not caught: continuous values rarely fall in a 1 % window).
3. **Recording** `tests/game/ai/traceReplay.test.ts`, Frida run 2 (rallycross-1-f, a human car parked on the grid, three AI cars; 120 Hz): open loop, teacher forced: the driver gets the
   recorded car states and must produce the recorded pedals (its integrated pedals re-synced each step). With `skill*tyreScale = 0.75`, the human as mailbox owner and the AI cars' hidden
   start state unknown (state 0 assumed): first 6 000 steps (17 922 comparisons): **steer median error 0, 54 % within 1e-3, p99 0.26; throttle median 0, 76 % within 1e-3, p99 0.05;
   brake median 0, 78 % within 1e-3** (the misses are overtake-state decisions and the +-1-step phase of the steering limit cycle); 1 500-step windows: steer 70 %, throttle 79 %, brake 85 %.
   Throttle and brake bands match exactly whenever the target-speed band agrees, the throttle ramp (0.5·dt per step) reproduces to the last digit. The remaining error sources: the stage spline vs
   the original's `pointAt` (cm-level differences change the circle-law speed by a few percent: theta is tiny on straights), the unknown hidden state at the start of the recording,
   and the unrecovered mapping of the leader / `skill`. Fit of `skill*tyreScale` over the three cars (throttle within 1e-3, human = mailbox owner): 0.45 -> 19-32 %, 0.6 -> 46-63 %, 0.7 -> 76-83 %, **0.75 -> 76-85 %**, 0.85 -> 65-73 %, 1.0 -> 46-52 %; without the mailbox cut the best fit is 0.45-0.5 (74-81 %) = 0.65 x 0.75, which is why the leader mailbox is taken to be the human car. Full output: `artifacts/phase2/ai-brain/trace-replay.txt`.
4. **Data**: `stages/<id>/ai.json` for all 48 stages (804 posts, 39 827 samples), `global/ai.json` 360 AiTimes files (`tests/game/ai/aidata.test.ts`, fake-fetch loader tests +
   real-data checks).
5. **Solo AI car on every stage** `tools/ai-stages.mjs` (`artifacts/phase2/ai-brain/ai-stages.md`): see that file; the table also lists the AiTimes totals. The original never raced AI cars on rally
   stages (opponents there are the AiTimes split tables, `Autopilot` comment), so rally results measure the port's driving, not parity: obstacles on the road (hillclimb-1c-f's service park) stop it.

Regenerating the fixtures (needs `unicorn` in a scratch venv, not `.venv`; run with `-I` from outside the data directories):

```
<venv>/bin/python -I research/tools/ai_ctrl_fixture.py original_version/original_desktop_version.exe tests/game/ai/fixtures/ctrl.json.gz 6000 7
<venv>/bin/python -I research/tools/ai_hl_emu.py       original_version/original_desktop_version.exe tests/game/ai/fixtures/aicar.json.gz 2400 700 11
```

Tools: `node tools/ai-stages.mjs [--stages all|id,..] [--jobs 4]` (the solo table, `artifacts/phase2/ai-brain/ai-stages.md`);
`AI_REPLAY_K=0.75,0.75,0.75 AI_REPLAY_STEPS=6000 npx vitest run tests/game/ai/traceReplay.test.ts` (needs `research/frida/traces/run2.bin`; `AI_REPLAY_FROM`,
`AI_REPLAY_DUMP/DFROM/CAR`, `AI_REPLAY_MISS`, `AI_REPLAY_PEDAL=steer`, `AI_REPLAY_LEADER=0` for diagnostics).

## 10. Known gaps

* Who triggers spin recovery (`+0x54`) and the exact trigger of the exe's stuck handling (race code, `ai-race` decides; `setRecovery`).
* `skill` per AI car (AIAttributeManager groups), the discipline -> group mapping (`research/formats/ai.md` §1.1 is [I]).
* The mailbox owner is [I] (human car); the AiTimes schedule fallback is [I].
* Exact `pointAt` of the original's segment curve object (vtable `+0x14` of the node behind `+0x18`): the port uses the stage spline; see §9.3 for the effect.
* Initial hidden state at the start of the recording.

## 11. Corrections to `research/formats/ai.md`

See the status block at the top of that file; summary: §5.2's "grip" is the car's speed in km/h; the field map's `+0x0d/+0x15/+0x16` are `+0x34 / +0x54 / +0x58` in FUN_00607ae0;
the 40 km/h clamp applies for `|lateral| > 10`; the near-car cuts get stronger as the gap shrinks (`gap < 6 -> *0.2`); `+0x9c` is not the half width; the `-800/-400/-200` cuts compare against the
mailbox (human / schedule) progress; `+0x1c4` is the controller's signed speed (vtable `+0x104`), which other cars read as the "speed" of a car; the AiTimes cuts need no AiTimes file in
FUN_00607280 itself.
