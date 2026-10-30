# Original audio (audio builder)

The browser build plays the original game's sound: the 44 kHz sample tier, the `.ssc` patch scripts, the
CarSoundPlayer logic, the stage ambience, the race UI sounds, the menu sounds and the co-driver words. The
spec is `research/formats/sound.md`; where its `## Verification` section disagrees with the body, the
Verification wins. Everything below that goes beyond the spec was read from `research/decomp/all.c` or
disassembled from `original_version/original_desktop_version.exe` (its code section is plain; `objdump -d
--start-address=…` works).

## 1. Data flow

```
.cache/original/{Audio,Cars,Misc,Menu,LocaleEnglish}/…      (Audio.rff sound/44khz/… holds EVERY sample,
        │                                                     the per-car ones too; Cars.rff only the scripts)
tools/assets/parts/audio.py  build_global  (lib/formats/fmt_sound.py: SscParser, parse_car_player)
        ▼
public/assets/global/audio.json   + global/audio/<lower-case research path>.wav (582 files, 35.9 MB PCM)
        ▼
src/audio/orig/index.ts  loadOriginalSoundBank(ctx) → OriginalSoundBank (lazy fetch + own WAV decode)
        ▼
src/audio/orig/player.ts  OriginalAudio  ← src/audio/audio.ts AudioEngine.update(FrameContext)
   ├─ patch.ts      SoundSystem (15 Hz tick) + PatchInstance / ScriptInstance (vtable 0x83bd70)
   ├─ webBackend.ts one Web Audio voice per playing layer (DS volume law, frequency clamp, doppler, 3-D)
   ├─ carSound.ts   CarSoundPlayer (0x7465f0) ← carInput.ts (telemetry → the car interface)
   ├─ envSound.ts   WorldEnvironmentSound objects + manager (FUN_00797480 / FUN_007960c0)
   ├─ coDriver.ts   pacenote player (FUN_0067a190 / FUN_0067a250) ← src/ui/voice.ts ← HUD 'pacenote'
   └─ race UI scripts (CountDown / CheckPoint / Error.ssc) on RaceEvents, menu sounds (playUiSound)
src/audio/orig/music.ts  MusicPlayer — only with ?music=1, only from the gitignored public/sound/music/
```

Build: `npm run assets -- --audio --parts audio` (~1 s). Test fixture for the envelope tests:
`.venv/bin/python -I tools/assets/parts/audio.py --fixtures` → `tests/audio/fixtures/layerEval.json`
(624 layer evaluations and 400 ramps by the verified research parser).

## 2. `global/audio.json` (src/audio/orig/bankTypes.ts `AudioBankJson`)

| key | content |
|---|---|
| `version`, `tier` | 1, `44khz` (the "HIGH" quality, FUN_00405ba0) |
| `scripts[path]` | all 386 `.ssc` (469 patches, 894 layers, 3685 effects) with the decomp defaults applied; layer = `s` (sample key, null for the NissanSkyline `Idleoutside` typo — the original's load fails too), `loop`, `is3d`, `volume`, `minDistance`, `trigger`, `stop`, `rsp` (randomStartPitch a/b), `rel` (relativePosition, car-local SIM), `doppler`, `fx` (`d` dest, `s` source, `x` extern, `e` envelope, `p` the 6 effective Ramp params) |
| `samples[key]` | `f` file under `global/`, `rate`, `ch`, `frames`, `loop = [0, frames]` (DirectSound loops the WHOLE buffer, 0x6b3d30; the seam click is part of the sound), `smpl` (the 70 authored loop chunks, kept as metadata; the original ignores them) |
| `cars[Name]` | per original car (`ORIG_CAR_IDS`): `player` / `ai` = the 20 SoundPlayer.con / SoundAI.con slots (index = slot), `sampleFolder`, delta distances |
| `materialSlot[byte]` | original material byte 0..22 → surface slot 0..18 or null (jump table 0x7473e8; WOOD, COBBLES, LEAF, SANDDARK silent) |
| `collision` | Collision.ssc patch per collision type (table 0x746e3c): hard / snow / tree |
| `env` | 15 `WorldEnvironmentSound` templates → script, 793 placements on 48 stages (SIM = world − (2048, H, 2048)) |
| `ui`, `menu` | CountDown / CheckPoint / Error.ssc; the 8 Menu.rff meme sounds |
| `coDriver` | `masterVolume` 0.92, `words` 1..41 (LocaleEnglish PaceNotes, 11025 Hz), team coach 42..92 |

Samples are shipped as canonical PCM16 WAVs whose `data` chunk is byte-identical to the original
(`tests/audio/bank.test.ts` compares all 582). The runtime parses the WAV itself (`wav.ts`) and builds the
AudioBuffer at the file's native rate, so loops are sample-exact and `playbackRate` = pitch × native rate as
DirectSound's SetFrequency. FLAC / Opus were not needed (36 MB total, fetched lazily: a stage loads its car,
ambience, UI and word samples, ~100 files).

## 3. Runtime: what is ported

* **Envelopes / layer volume and pitch** (envelope.ts, sound.md §3.2-§3.3): Ramp FUN_00605e50, Linear
  FUN_00605d70; vol = clamp(layer.volume) · Π Volume effects · patch.volume; pitch = Π Pitch effects + the voice's
  random start offset `rand()·(a+b)/32767 − a`.
* **15 Hz sound tick** (patch.ts `SoundSystem.advance`, FUN_00406370 / FUN_004063e0(15.0)): frame dt accumulates;
  once ≥ 1/15 s every live patch gets `update(whole elapsed)`, every voice gets volume / pitch / position, and the
  listener commits. `play()` / `release()` act immediately.
* **Patch life cycle** (vtable 0x83bd70): play idempotent while active (+0x59 = has a looping layer, vt+0x24 =
  0x7eb430 disassembled: any layer with the loop flag); release no-op once released, keeps `Volume ← TimeRelease`
  loops fading, stops the rest; `release(); play()` restarts; vol ≤ 0 frees the voice, a loop restarts from
  sample 0 when audible again; one-shots once per play; randomPlay shuffle bag (FUN_007eb5c0).
* **DirectSound setters** (ds.ts): gain = 10^(trunc(865.617·ln v)/2000) with v = min(1, vol·sfxMaster);
  frequency = trunc(p·rate) clamped to 100..200000 Hz; DS3D listener RollOff 1, Doppler 1.4 (emulated:
  playbackRate × (c − 1.4·vL)/(c − 1.4·vS); `dopplerOff` = source velocity := listener velocity = 1).
* **3-D** (webBackend.ts): PannerNode equalpower / inverse / refDistance = minDistance / rolloff 1 (= DS3D
  min/max(d, min)); positions and the AudioListener in THREE space (z mirrored; raw SIM would swap left and
  right). Emitter = car pose × `relativePosition` (engine ≈ +2 m forward, pipes ≈ −1.5 m). Listener = the render
  camera (`CamListener.con`), committed at the tick. `stereo` layers skip the panner.
* **CarSoundPlayer** (carSound.ts, 0x7465f0 and callees): all 20 slots of the selected car's SoundPlayer.con
  (FrameContext.origCar; an archetype car uses `DEFAULT_ORIG_CAR`: awd_wrc → ImprezaWRX, fwd_hatch →
  Peugeot206, rwd_classic → FordEscort — all 29 patch sets have identical parameters, only the samples differ):
  idle, off-throttle pipe, overrun pops and boosts by rpm band (> 1 s gates), on-throttle engine, gear shift,
  handbrake, slides / spin / rolling per surface slot for all 23 materials (indexed by slot, not by name, §6.3),
  rain, backfire (0x753410) and blow-out (0x753550) flags (the shared source src/game/carFlags.ts via
  FrameContext.carFlags, the same flags as the pipe flames; computed here only without it), impacts (0.5 s gate, type
  table, thresholds 165 / 5), bump, whine with the upshift drop-outs; sound rpm jitter FUN_00746a00 (Park-Miller).
* **Ambience** (envSound.ts): placements per stage. Decomp findings beyond sound.md §8: the object ctor
  FUN_00797480 `play()`s patch 0 at creation when it has a looping layer (crowds, applause), and the manager
  FUN_007979c0 re-rolls (`rand() % 20 == 0` within 60 m) only patches that are inactive **and have no looping
  layer** (cows, sheep, horns). Nothing is ever stopped (the stop calls hit the 1-byte `ret` stub FUN_005d9640);
  the loops go quiet through their Distance ramps. A car standing exactly still for 90 updates blocks the re-rolls.
* **Race UI** (player.ts): `countdown` events n = 3, 2, 1 → CountDown.ssc patch 0 (`3,2,1.wav`), `go` → patch 1
  (`go!.wav`) (the meme node's First … Fourth, FUN_00643ac0); `checkpoint` → CheckPoint.ssc patch 0
  (`checkpointquicker`) when the split is not slower than the best, else patch 1 (`checkpointslower`) [? meaning
  from the names]. Menu sounds: `playUiSound(name)` from src/audio/audio.ts (2-D, straight from Menu.rff).
* **Co-driver** (coDriver.ts + src/ui/voice.ts), decoded from the race HUD update (call site 0x4b0415):
  `FUN_0074b620` picks the note (race builder, src/world/portedPacenotes.ts); **FUN_0067a190** loads the note:
  nothing if the first word has no sample, else 8 slots (an unknown word ends the note), cursor = 0, word 0
  plays. **There is no queue: a new note replaces the current one** (the word still sounding plays out).
  **FUN_0067a250** runs every frame: when the cursor word's patch is no longer active, the cursor advances and the
  next word plays; with +0x38 set (mapped to the game pause) a sounding word is released and skipped. Each word is
  a patch instance (FUN_0067bd20 → FUN_007e9aa0, vtable 0x83bd70) played with `setVolume(DAT_00857fc8)` —
  **DAT_00857fc8 (options slider 4, unidentified in sound.md §11) is the co-driver volume**. The gap between
  words is therefore "the frame that notices the end + the next 15 Hz tick", reproduced by running the words as
  patches on the same SoundSystem. voice.ts plays `Pacenote.origWords` this way and falls back to
  speechSynthesis on the text when the bank / the first word's sample is not loaded or the note has no words.
  The HUD's voice setting (src/ui/settings.ts `uiSettings.voice`) is **on by default**, as the original always
  speaks the notes (N or the menu turns it off; settings key `rally-web:ui:v2`).
* **Menu sounds**: src/ui/menu.ts calls `playUiSound` — Step (cursor), Tag (option value), Select, Back, Error
  (refused), Sweep (main menu / results screen opens); see the menu.ts header for the meme-file evidence.
* **Music** (music.ts): off by default. `?music=1` streams `public/sound/music/<Artist> - <Title>.wav` (the
  user's own copy: `public/sound/` is gitignored and tools/vite-orig-assets.mjs removes `<outDir>/sound/` after
  `vite build`, so it is never in public/assets or a build) in the in-game table order of FUN_004e8aa0
  (10 tracks; menu FUN_004e8f50 and pre-race FUN_004e8e00 tables are exported but not wired), sequential, volume
  sfx × music through the DS law. A missing file is skipped with one warning (the browser also logs its 404).

## 4. Calibrations and deviations

| item | what the port does | why |
|---|---|---|
| SlipX / SlipZ (wheel vt+0xe0 / +0xe4) | SlipX = \|tan α\| of wheel 0 (the relaxed lateral slip the tyre integrates; 1 at 45°), SlipZ = mean \|κ\| | the wheel getters are not traced (sound.md §15 Q1); the scripts ramp both over 0..1 |
| bump (wheel vt+0x108) | suspension extension 1 − offset / 0.75 (bump below 0.69 ≈ 31 % compression) | not traced; the static ride sits at ≈ 0.88 |
| impacts | the original's three sources from `CarTelemetry.collision` (sound.md Port findings 5): the object record once per new object hit (type = the object's raw collisionMaterial: trees 6 → Tree, 1 → Hard, −1 silent; strength = impulse − 100), else the hull contact read live (B+0x144 material, B+0x19c = jn − 100, the original's own unit) | traced; on mesh worlds (RCOL v2) the object record comes from the sim's port of the original's object pass (FUN_004a7bc0 → FUN_006d1a80, B+0x19c, 0 when the car only rests against the object; strength-0 records stay silent); the [D] cylinder model remains only on procedural stages / v1 collision files; no car-car record (no opponents). Telemetry without the record (test fakes) falls back to `impactImpulseMax / 10` on the material under the car |
| bush (`+0x28`) | `CarTelemetry.collision.bush`: the car centre within 2 m of a soft object (OrigWorld.softNear) and inside its footprint | mesh worlds only (procedural stages have no soft objects) |
| glass events | never fire | the sim has no glass breakage |
| Ouside | 0 for the `bumper` and `bonnet` views | the original's camera modes 15 / 16 are its in-car views |
| rain | `stage.environment.weather === 'rain'` | the weather manager's `+0x84 == 1` |
| sfxMaster / car / co-driver sliders | 1 (rally-web has only on / off = the output gain) | no options sliders |
| CarSoundPlayer / env manager rate | once per rendered frame | their update rate is not traced (§15 Q6) |
| co-driver word layer | 2-D, volume 0.92 | the loader's layer setup (vt+4 args 0, 0, 0) is not decoded |
| wind, water splash | none | the original has no such samples (WATERASPHALT rolls on `Water/Mud.wav`, slot 3) |
| AI cars | not played | rally-web has no opponents (the ghost is silent, as a replay) |
| missing sample while loading | that layer stays silent; a loop retries every tick until its buffer arrives | the original's failed `load` stays failed (the Skyline typo still does) |

No smoothing is applied: gain, rate and positions step at 15 Hz as DirectSound applied them.

## 5. Public API

* `src/audio/audio.ts`: `AudioEngine` (IAudioEngine) + `setListenerSource(fn)`, `playUiSound(name)` (method
  and module function), `debugState()`; `rendererListener(renderer)` (GameRenderer's public read-only `camera`); `window.__rallyAudio`.
* `src/audio/orig/index.ts`: `loadOriginalSoundBank(ctx)`, `createSoundBank(json, factory)`, `loadBankJson()`,
  `scriptSampleKeys`, `samplePath`.
* `src/audio/orig/coDriver.ts`: `getCoDriverOutput()` / `setCoDriverOutput()` (voice.ts uses them).
* main.ts audio call sites: `origCar` in the FrameContext literal, `setListenerSource(() =>
  rendererListener(this.renderer))`.

## 6. Verification

* `npx vitest run tests/audio` (61 tests): Ramp ≡ fmt_sound.ramp (400 cases), layer evaluation ≡
  fmt_sound.layer_eval (624 cases on the real scripts), the spec's worked examples, DS laws, RNGs, WAV reader,
  patch life cycle (tick, play / release / restart, X-Fade, loop restart, randomPlay bags, randomStartPitch,
  Distance / Time sources); the built bank (counts 386 / 469 / 894 / 3685, sample table complete, every file
  decodes to its entry, PCM byte-identical to the original WAVs, smpl preserved, every layer and effect ≡
  sound_dump.json, slots / collision / placements / words); the CarSoundPlayer on the real scripts (idle,
  throttle, lift, pops, boosts, shifts, handbrake, all 23 surfaces, slides, impacts, backfire, blow-out, all 29
  cars, the Skyline typo), the env manager on all 48 stages, the co-driver player and voice.ts fallback.
* `node tests/audio/browser-check.mjs [--stage id] [--car Name] [--cam view] [--variants default,orig=0]`: the
  real game drives a stage with the autopilot and records `window.__rallyAudio.state()`. corsica-1-f /
  ImprezaWRX (40 s): mode original, 34 samples heard (engine, pipes, pops, boosts, gear shift, whine, bangs,
  blow-outs, tarmac roll / slide / spin, both crowds, horns, countdown, go, checkpoint), up to 16 voices, the
  co-driver spoke the original notes word by word (`1 18 6` = EasyLeft Into HardRight, `17 3 21 37 28`, …), no
  console errors or warnings from audio. `orig=0`: synth, no errors. iceracing-1-f / Metro6R4 / bumper: inside
  layers (Idleinside), no TurboRelease (Metro), 27 voices max, no errors.
