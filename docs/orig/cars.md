# Original cars — build, runtime, deviations (cars builder)

The 29 original cars with their real meshes (all four LOD sets), liveries, wheels, lights, names and handling,
selectable in the menu. Spec: `research/formats/cars.md` (+ its Verification section), `standardmesh.md` §5.6.
Owner files: `tools/assets/parts/cars.py`, `src/render/orig/car.ts`, `src/render/orig/carShader.ts`,
`src/render/carVisual.ts` (host of the original visual), `src/sim/origCars.ts`, `src/sim/presets.ts`, the car row of
`src/ui/menu.ts`, the car-selection code of `src/main.ts`, `addCar` / `removeCar` of `src/render/renderer.ts`,
`tests/render/origCar.test.ts`, `tools/cars/*`.

## 1. Build (`npm run assets -- --parts cars [--cars all|A,B] [--stages all|ids]`)

`build_cars` (car phase, ~2 s for all 29) → `public/assets/cars/<Name>/`:

| file | content |
|---|---|
| `cars.json` | display name (LocaleEnglish via `Menu/menu/Car/<Car>`), short name (ids 756–785), spec lines + their screen labels (locale 50 "HP / Torque / Weight / Wheeldrive / Gears"), the three bars + labels (locale 51 "Speed / Handling / Accel"), menu icon, drive, mass, wheels (bundle B, garage bundle, mount, template yaw, camber / toe, side sign, spring length / K, steer tweak, rest pose), wheel mesh names (tarmac / gravel), LOD triangle counts, lens flares (positions + FX_CarFlare*.con templates with texIds), exhaust, drivers, hull points, drop shadow, menu env cube (`menu/texture/carenvmap`), `camera`: the car's own `<Car>CarCamera` (Templates.con, attached by Player.con at 0/1/0.25), all 25 `setCamPosition i enabled flag posA posB param` entries in the SIM car frame |
| `cars/meshes.json` | per LOD set (`Mesh/Cars`, `Cars_1..3`) Body + Interior materials (`Cars_3` has no Interior), the two wheel meshes with their 4 internal LODs; per material the normalised subshader (cars.md §6/§7), texId, CarMeshPart group, byte offsets |
| `cars/lod<N>.bin`, `cars/wheels.bin` | THREE-space blocks: pos f32×3 (x, y, −z), normal, colour RGBA8 (RGB = baked AO, A = reflection weight), uv0, uv1 (dirt map, `dirtmap` materials only), Body crash morph target (pos + normal), u16 triangle lists (D3D strips → lists, odd triangles re-wound, degenerates dropped, winding swapped (a, c, b)) |
| `cars/icon.png` | `Menu/menu/Texture/Icon<Car>.tga` (100 × 85, the original car-select art) |

`build_stage` → `stages/<id>/cars.json`: the track's `Texture/CarEnvmap.rcm` cube (6 texIds, +X…−Z, SIM frame),
`Texture/CarDirtmap` (fallback `Misc/texture/Car/CarDirtMap_512`), the stage's `car.*` settings (specularColor,
specularHighlightsEnable, envmapColorScale, metallicSpecularScale; lighting.con / RenderSettings via
`fmt_environment`). All 29 cars and all 48 stages are built (182 unique car textures incl. flares, drop shadows and the menu cube).

Material rules: `_SP` subshaders bind (cvar `multiplayerShaders` 0), `lambert1` (no subshader) is not drawn, a
`Cars_N` material missing from its `.rs` falls back to the LOD0 set's subshader (ImprezaWRX Cars_1 `accesories`),
Astra's undefined `WheelGravel6Grey` falls back to its tarmac wheel (original data bug).

## 2. Runtime (`src/render/orig/car.ts`, `carShader.ts`)

`loadOriginalCar(name, { textures, stageId, ghost?, menu?, lod? })` → `OriginalCarVisual | null` (null without a
manifest / the car part / a texture scope; throws on real failures — the renderer warns once and keeps the
procedural car). `GameRenderer.addCar(id, archetype, { origCar })` returns a promise that settles once the
original is handed to `CarVisual.setOriginal` (or the procedural fallback is decided; a result for a removed /
re-added car is dropped); the procedural `CarVisual` stays hidden while it loads (`setOriginalPending`). main.ts
starts the player car with the stage load and awaits both before `race.begin`, as the original loads the car with
the race: the procedural stand-in is never seen (it shows only without assets / on a failed load). `removeCar`
disposes the visual, then its `TextureScope`. `debugInfo().origCars` lists `{ id, car, lod }`.

* **Cameras** (MECHANICS_SPEC §5.3): the original reads every view from the player car's own CarCamera entries
  (template +0x248, stride 0x30: FUN_0075e390 entry 0, FUN_0075e790 entry 1, FUN_0075fca0..ffa0 entries 5-8,
  FUN_007601a0 / 00760980 entries 10 / 12; the literals there are only the no-template fallback). `carCameraTuning(info)`
  maps 0 → bumper, 1 → bonnet, 5-8 → chase posA / posB / p0 p1, 10 / 12 → tether, 24 → look-back; the renderer
  merges it into `cameraTuning` when the car is the player (`applyCarCamera`; archetype cars get the generic table =
  ImprezaWRX's, `makeCameraTuning`; a reload of the same car keeps tuned positions; main.ts "reset to original" uses
  `defaultCameraTuning()`). 20 of 29 cars have their own bonnet, 15 their own bumper, 8 their own chase positions;
  the 8 enabled cycle views and the look-back entry are the same on every car. `debugInfo().cameraCar` names the car.

* **Frames** (cars.md §4.1): the mesh frame is the physics body frame (origin = centre of mass); root = the
  `CarRenderState` pose, Body + Interior at the origin.
* **Wheels** (cars.md §4.2, FUN_006c8ef0, re-read from the decomp): hub = (B.x + steerOffX, B.y − max(0.85, ext +
  jitter)·L, B.z + steerOffZ) with ext = 1 − suspensionOffset / L from the sim's `WheelVisual`, jitter =
  amp(material)·speed·0.0002·sin²(35 t) per-wheel timer; rotation camber (about the body z, outermost) · yaw (toe +
  rate-limited visual steer + template yaw 180° on the right wheels) · spin (about the axle, innermost), converted
  with S·M·S. `tests/render/origCar.test.ts` rebuilds the matrix with the exe's literal row operations and compares
  all 16 elements. Tyre mesh radius 0.33 over the 0.30 physics radius is kept (cars.md §4.5). Wheel geometry:
  tarmac wheel for tyre types 0/1, gravel wheel for 2/3/4 (cars.md §8 recommendation).
* **Shaders** (`carShader.ts`, cars.md §7): GLSL port of `Standard_Base[Dirt][Envmap]` +
  `Palettized_D3DCompliant/[Dirt][Envmap]Tex[Highlight][Mask]`: oD0 = sat((ambient·car.ambient + N·L·diffuse·
  car.lightColor)·vcol.rgb), fresnel = bias + (scale·(1 + E·N)²)², oD1 = sat(fresnel.x·vcol.a, specScale·
  (N·H)^power·vcol.a) (both clamped like vs.1.1), pixel `t0·v0 + t2.a·c2 + fr·t2 + spec·t0`, dirt lerp, Mask
  variants, `Car/Reflector`, LampGlass modulate-2x + additive `envmapPass`, `Car/Ghost`. Env cube sampled in the
  SIM frame: `textureCube(env, vec3(r.x, r.y, −r.z))`. Track fog per vertex (`origUniforms.trackFog`); lighting from
  `origUniforms.carLight / carAmbient / sunDir` (environment part; the original defaults elsewhere). Raw
  gamma-space output (no colour-space chunks), like the D3D8 original.
* **LOD**: by camera distance, `LOD_DIST` = 22 / 50 / 110 m → Mesh/Cars, Cars_1, Cars_2, Cars_3; the wheel meshes
  switch their internal LOD with the same index.
* **Lights**: `LampBack` materials switch to the unlit `Generic/TexSimple` program while braking (cars.md §6);
  lens flares from Lensflares.con + FX_CarFlare*.con: `CarFlareRear` while braking, `CarFlareBack` in reverse,
  `CarFlare` (headlights) at night; Astra / Escudo / ToyotaTacoma ship their Lensflares.con commented out (no flares),
  FordFocus / Saab93 / CitroenXsaraRC use the invisible `CarFlare_ZERO` headlights.
* **Ghost**: same meshes, every material drawn with the `Car/Ghost` program (env reflection only, alpha 0.35),
  no flares, no shadows.
* **Selection**: `?car=<Name>` (case-insensitive), the menu's Car row (original cars by LocaleEnglish name when
  built — availability = `manifest.cars` — then the three archetype class cars), `RaceSelection.car`; main.ts
  applies `origCarParams(name)` (the car's own PhysicsCar.con data + Templates.con wheel bundles + hull box on its
  drive layout's archetype, `presets.ts`) and passes the name to `addCar`, the `CarRenderState`, `race.begin`.
  Without assets the car row lists only the class cars; `?car=<Name>` then still applies that car's handling with
  its drive archetype's procedural visual.

## 3. Verification

* `npx vitest run tests/render/origCar.test.ts` (10 tests): manifest = 29 cars + 48 stages; names / short names /
  spec + bar counts = cars.md §10; all 116 wheel bundles, FR/RR mirroring, template yaw, camber / toe and rest hub
  heights = cars.md §4.4 (±1 mm); garage bundles +0.05…0.105 m; every texId of every car / stage file resolves
  (none missing); materials, groups and vertex counts of every LOD set of every car = the verified parser's dump
  (`.cache/dumps/cars_dump.json`), triangle counts ≤ strip − 2; an independent TypeScript `.cm` reader (from the
  spec text) ≡ the built binaries bit-exactly for ImprezaWRX, Peugeot206, ToyotaTacoma (every LOD set, both wheels ×
  4 internal LODs: positions, normals, colours, uv0, uv1, deform targets, triangle lists; files consumed to the
  last byte; tyre radius 0.33); runtime wheel matrices ≡ FUN_006c8ef0; LOD by distance; gravel wheel by tyre;
  LampBack brake switch; ghost materials. A mutation (winding / z sign flipped) makes the reader test fail.
* `node tools/cars/car-shots.mjs showroom --cars all` → `artifacts/port/cars/showroom.png`: all 29 cars (front 3/4,
  side, rear 3/4) next to the original menu icon, garage lighting of `Misc/level/menuinit.con`. Every livery,
  rim and body shape matches its icon except **Astra**: the icon shows an older black / yellow "Shell Helix #8"
  livery (`Astra_L1.dds`, referenced by no shipped `.rs`), the game draws `OpelAstra_LOD0` (silver / red #1) — the
  port follows the game data. Rim colours on AudiS1HC / DeltaIntergrale icons differ slightly from the
  Templates.con wheels (pre-rendered icons).
* `node tools/cars/car-shots.mjs details --cars ImprezaWRX` → LOD 0..3, brake / reverse / night lights, steer,
  gravel wheel, damage morph, ghost.
* `node tools/cars/car-shots.mjs stage --stages corsica-1-f,kenya-1-f,iceracing-1-f,hillclimb-1a-f,testpad --cars …`
  → in-game shots (chase / bonnet / side / front), 0 console errors from the car code.
* `node tools/cars/menu-check.mjs` → the menu lists 32 cars (29 original by name + 3 class cars), picking one shows
  its icon / specs / bars, Start loads that car (`debugInfo().origCars`, sim mass = the car's). `--variant orig=0`
  → 3 class cars only, procedural visual, no errors.

Cost of one car at LOD0: 27–45 draw calls (ImprezaWRX 42), 12–16 k triangles incl. wheels (+ shadow-map passes
of the opaque body meshes); LOD3 ≈ 16 calls / 2 k triangles. Car data per car 1.3–1.6 MB (`cars/` total 43 MB) + its textures (ImprezaWRX: 18 textures, 2.0 MB of DXT .rtex for all LOD sets + wheels; 182 unique car textures, 54 MB),
fetched on first use (LRU of 3 cars' buffers).

## 4. Deviations and open points

| what | original | port | why |
|---|---|---|---|
| LOD choice | one LOD set per car from the video-quality table (`playercarlodlevel` / `othercarlodlevel`, FUN_00491ce0; the table is not in the archives) | by camera distance (22 / 50 / 110 m) | task requirement; the table is missing |
| track lightmap under the car (t3) | projected terrain lightmap multiplies the car (`car.lightmapMin/Max/Clamp`) | ported (integration 2026-10-30): the patch lightmap under the car (`OriginalStageView.carLightmapAt`, Track.qm uv3 = an exact x/z projection, fitted per patch at load) through the car palette; white without a track (menu, procedural stage); `?carlm=0` turns it off | — |
| dirt factor c0 | accumulates over the stage (`physicsDirtMapScaleValue`, law not located) | 0 (clean car); `setDirt()` exists | cars.md §12 Q2 |
| damage | `addDamage` morph toward the stored crash pose + broken lamp / window textures | morph target uploaded (`setDamage()`), not driven | law not located (cars.md §9 / §12 Q1) |
| drivers | Driver.sm + skeleton, 1 or 2 seats | not drawn | bind pose / animation open (cars.md §12 Q4) |
| env cube | static CarEnvmap or the dynamic cube (`carDynamicEnvmap`) | static CarEnvmap of the stage, the menu cube elsewhere | dynamic cube not ported |
| shadows | ShadowGen/Apply passes or the `DropShadows/<Car>.tga` blob | three's sun shadow map (opaque body meshes cast) | shadow passes belong to the environment / renderer |
| `envmapColorScale`, `metallicSpecularScale` | builder getters (vt+0x78 / +0x80) | env colour × scale, specScale × scale | binding inferred from the names [I] |
| `car.reflectivityScale` (menu 0.8) | builder getter vt+0x88 | not applied | binding unknown, only the menu sets it |
| non-driven axle spin | visual ω clamped to ±v/R (forced to v/R under flag 0x10000<<i) | the sim's spin angle | imperceptible; flag meaning open |
| lens flare size / occlusion | LensFlare object (size law not decompiled), occlusion query of a 0.3 m quad, flare moved toward the eye by c9.z | size·min(dist, flareScaleDistance)·2, sprite pulled 0.3 m toward the camera and depth-tested | [I] |
| ghost material | `Car/Ghost` (Ghost0t.vs env coordinate only; blend states not decompiled) | env × envScale, alpha 0.35, depth write | [I] |
| garage pose | TemplatesMenu bundles + `menu/texture/carenvmap` | used by the showroom tool (`menu: true`); the HTML menu shows the original icon | the 3-D garage is not ported |
| procedural stages / night | — | the car keeps the original's default car light (0.5 / 0.3) and sun; no procedural fog | gap 4 of docs/ASSETS.md §10 |
