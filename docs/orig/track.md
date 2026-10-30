# Original track meshes (`track` part)

The drivable stage surface, the distant backdrop terrain and the water sheets of every ported stage, drawn
from the original `Mesh/Track.qm`, `Mesh/World.qm` and `Mesh/Water.qm` with GLSL ports of the original DX8
track shaders. Owner: the track builder.

| piece | file |
|---|---|
| build step | `tools/assets/parts/track.py` (`npm run assets -- --parts track --stages all`) |
| data layout + pure helpers | `src/render/orig/trackData.ts` |
| GLSL ports | `src/render/orig/trackShaders.ts` |
| runtime component | `src/render/orig/track.ts` (`loadTrack`, an `OrigComponentLoader`) |
| tests | `tests/render/origTrack.test.ts` |
| comparison shots | `artifacts/port/track/` (`compare-start.mjs`, `compare_sheet.py`) |

Specs: `research/formats/quadmesh.md` (+ Verification), `textures.md` §4 (lightmaps),
`environment.md` §3.4 (fog), §3.6 (view distances), §3.7 (water), §4 (frame composition), §8.1 (gamma-space
maths). Facts the specs left open were re-read from `original_desktop_version.exe`; the addresses are cited
below and in the code comments.

## 1. Build step (`stages/<id>/track.json` + `track.bin`)

Per stage the three QuadMeshes the track loader creates (quadmesh.md §1). Only the PS 1.1 mesh
`Mesh/Track.qm` is used; `SmallQuadSize/` is the fixed-function / low-end mesh.

* **Vertices** (`track.bin`, 4-byte aligned blocks per mesh): interleaved f32 `[position (3), uv0..uvN (2
  each)]` with the position converted to three space `(x, y, −z)` and the D3D uvs unchanged; u8×4 RGBA
  diffuse colours (D3DCOLOR BGRA → RGBA, normalised in the shader); the specular stream (fixed-function data)
  is dropped. Track.qm: pos + uv0..uv3 (stride 11 floats), World.qm: pos + uv0, Water.qm: pos (+ uv0).
* **Indices**: u32 triangle lists. D3D strips are expanded with the odd-triangle swap, degenerates dropped,
  then two indices are swapped per triangle for the z mirror (three's CCW front + `FrontSide` = D3D's CW
  front + `CULL_CCW`). The patch's indices are rebased onto the mesh-wide vertex block.
* **Groups** = submeshes in file order (`material` = index into `materials`, `start`/`count` in the index
  buffer); adjacent submeshes of one subshader would be merged (none occur: the exporter already merged
  them; 17 329 submeshes = 17 329 groups over the 48 stages).
* **Materials** = one per `.rs` subshader: `type` Mask / Single / Water, `lightmapped`, `doubleIntensity`,
  `vertexPaint` (looked up and discarded by the engine), textures `base1` / `mask` / `base2` / `bump` with
  their clamp flags, each resolved with the engine lookup (`ctx.textures.use`).
* **Quadtree**: nodes in file (pre-)order, bounds = union of the file AABB and every vertex below (cells can
  be smaller than their triangles, quadmesh.md §2.2); per-patch bounds recomputed from the vertices.
* **Lightmaps**: `<level>/Lightmaps/Track<patch>` per Track.qm patch, P8 through `Track.pal` (the `.rtex`
  palette; index mips by the engine floor-mean rule). corsica-1-f ships none → `null` → the engine's
  `texture/white` (renderer +0x220), i.e. the shipped look (quadmesh.md §5, verifier).
* **World placement**: `Object.absolutePosition 2048/<H>/2048` from the loader unless a stage script moves
  the object `World` (25 stages, e.g. corsica-1-f y = 600); converted like objects (`(x − 2048, y − H,
  −(z − 2048))`, Euler `(−pitch, −yaw, roll, 'YXZ')`).
* **Settings** (resolved with the verified `fmt_environment` interpreter in the loader order of
  environment.md §1, unset fields at the FUN_0040e650 defaults): `Track.viewDistance`, the HotSpot
  regulator's `Global` + spots (`splineDistance`, `width`, `fade`, `trackViewDistance`), `track.bumpEnable`,
  `track.bumpHeight`, `track.specularColor`, `game.drawWorld`, the pass near/far planes; and `Water.*`
  (environment.md §3.7) with the textures resolved (BaseTex, BumpTex volume + its depth = the animation frame
  count, EnvTex cube = six face ids in SIM frame).
* `missingTextures`: names that resolve nowhere — `texture/KE_Tarmac_02_MT` (kenya-3-f/r),
  `texture/SWE_side_01_test_MT` (newzealand-2-r Water.rs), `texture/NZ2f_water.rcm` (newzealand-2-f: the
  file is under `Textures/`, which is not a texture folder, so the engine loads no EnvTex there either).

All 48 stages build in ~3 s (16 jobs); 4 790 patches, 2.80 M vertices, 2.93 M triangles in total.

## 2. Frame composition (environment.md §4.1, verified)

| order | what | with the environment component (normal case) | without it (fallback, `worldMode 'own'`) |
|---|---|---|---|
| 1 | sky box (+ clouds), Z off | `OrigFramePipeline` sky pass (`ORIG_SKY_LAYER`, its sky camera near 10 / far 100 010) | — |
| 2 | **World pass**: World.qm, `Track/Single` (TextureVP), WORLD fog, near 10 m / far 100 km (settings +0xc / +0x10) | the World mesh is on `ORIG_SKY_LAYER`, drawn by the sky camera (its projection copied into `uPassProjection` in `onBeforeRender`) | layer 0, `renderOrder −1.5`, `uPassProjection` = the camera's with near / far replaced |
| 3 | Z (+ stencil) clear [frame sequence @0x49f114–0x49f1c1] | the pipeline's `clearDepth()` | `renderer.clearDepth()` in the World mesh's `onAfterRender` (after its last group) |
| 4 | **track pass**: Track.qm patches, Water.qm, objects, cars, …, far plane = race +0x740 | main camera, far = near + view distance (when World.qm is on the sky layer) | main camera (far ≥ `cameraFar`) |
| 5 | in-race gamma ramp | the pipeline's blit (`?gamma=0` off) | — |

The mode is chosen per frame: 'sky' when the environment component is in the view (sibling object
`orig:environment`) and its sky pass actually drew the World mesh within the last 3 updates, else 'own' (one
warning). The World mesh starts on `ORIG_SKY_LAYER`, which is what tells the pipeline (`origPassOptions`) that
World.qm is in the sky pass, so the main pass may stop at the view distance like the original.
`game.drawWorld 0` (5 stages) skips the World pass; rallycross has no World.qm.

### Track view distance (race +0x740) and culling

FUN_0049c770: when the HotSpot regulator is enabled (FUN_004e1210) the track pass far plane is
`detail (1 at full detail) · regulator(s).trackViewDistance` with `s` = the camera's spline distance
(camera vtbl+0xa0 in FUN_00491350); otherwise `Track.viewDistance`. The regulator FUN_004e1240: for each spot
with `|s − splineDistance| ≤ width` (inclusive half window), `t = d ≤ (1 − fade)·width ? 0 : (d − (1 −
fade)·width)/(fade·width)`, `delta = (1 − t)·(v − Global)` for every value `v ≠ 0`; the result is `Global +
min(negative deltas) + max(positive deltas)` (`trackViewDistance()` in trackData.ts, unit-tested).
`s` comes from `stage.project(cameraPos)`. The far plane is `near (0.1) + view distance` (the camera setter
takes the range; same convention as the environment pipeline).

Culling: per frame the quadtree (node and patch AABBs, local frame) is tested against the camera frustum with
its far plane moved to the track view distance; visible patches get `mesh.visible = true`. The D3D far plane
itself (triangles crossing it are clipped per pixel) is reproduced in the fragment shaders
(`if (viewZ > uTrackFar) discard`), because the shared camera's far plane also has to hold the sky box and
the World pass. `cameraFar` = the largest view distance the stage can ask for.

## 3. Shaders (trackShaders.ts)

Gamma-space throughout (raw texels, `NoColorSpace`, no tone mapping, `LinearSRGBColorSpace` output).
ps.1.1 saturation after every saturating instruction (GeForce-class `MaxPixelShaderValue` 1; quadmesh.md §4.4
verifier note). Fog: `ORIG_FOG_PARS` per vertex (`oFog = max(dp4(pos, c27), c26.x)` = the linear view-depth fog
with the `Track.fogClamp` floor), `out = mix(fogColor, rgb, oFog)`, on `origUniforms.trackFog` (World.qm:
`.worldFog`), bound by identity.

| program (original) | selection [V setup @0x6666d0] | equation |
|---|---|---|
| Mask (`Mask4t.vs` + `MaskVP` / `Mask2xVP`) | `Track/Mask` (lightmapped flag ignored, @0x6667ef); 2x iff `doubleIntensity && lightmapEnable` | `r1 = lrp(t1, t2, t0)` (the mask weights base2); `r0 = sat(2·r1·v0)`; `r0 = sat(k·r0·t3)` |
| Single lit (`TextureLightmap.vs` + `TextureVPLightmap(2x)`) | `Track/Single` with `lightmapped` | `r0 = sat(2·t0·v0)`; `r0 = sat(k·r0·t3)` |
| Single (`Texture.vs` + `TextureVP`) | `Track/Single` otherwise (World.qm) | `r0 = sat(2·t0·v0)` |
| SpecBump, 2nd pass | `bumpmap` set, `track.bumpEnable`, caps (FUN_00666660) | `rgb = (N·H)⁴ · c0 · bump.a`, `N = bump(uv0)_bx2`; ALPHABLEND SRCALPHA/ONE, ZWRITE off, ZBIAS 5, `oFog = 1` [@0x666d0d–0x666dbd] |
| Water, pass 1 (opaque) | `Track/Water` | `rgb = N·L + bump.a · c1 · (N·H)⁴`, a = 1; `t0` (BaseTex) only reaches the alpha and cancels (`sub r0.a, t0, t0`) |
| Water2, pass 2 | Water with an EnvTex | `rgb = env(reflect(E, N)) · c2` (`texm3x3pad`×2 + `texm3x3vspec`, texture space = identity c17..c19); ALPHABLEND ONE/ONE, ZWRITE off, ZBIAS 5 [@0x666dc5] |

t3 = the patch lightmap (CLAMP, uv3), or `texture/white` when the patch has none [@0x666add]. A texture name
that resolves nowhere samples as black.

Constants re-read from the executable (VS/PS constant upload @0x669050–0x6695c9, track renderer vtable
0x820e68):

* **c0 (SpecBump)** = `track.specularColor` (FUN_0049a680 → vtbl+0x8c FUN_00668c90 → renderer +0x60).
* **c1 (Water)** = `Water.SpecularColor` (vtbl+0x94 FUN_00668da0 → +0x70); **c2** = `Water.EnvIntensity`
  replicated (vtbl+0x6c → +0xd4).
* **c14 (L, Water)** = the sun (toward the sun, normalised; vtbl+0x4c first argument → +0x48), packed into
  `oD0 = L·0.5 + 0.5`.
* **Half-vector cube** (renderer +0x21c, 64² per face, rebuilt by vtbl+0x4c @0x6682a0 whenever the bump light
  changes; FUN_00688ea0 type 1): texel(d) = `normalize(normalize(d) + Lb)` packed as `127·h + 128`, with the
  standard D3D face directions; looked up with the world eye vector `eyePos − worldPos`. `Lb` = the bump light
  `normalize(sun.x, sun.y·track.bumpHeight, sun.z)` (vtbl+0x4c second argument → +0x54). Computed
  analytically per pixel here.
* **Water uv / animation**: `c16 = (1/BaseTile, 1/BumpTile)` (setters store 1/x); bump uvw =
  `(world.zx·c16.y + c21.wz, c15.x)`; `c21 = (∫BaseScrollSpeed·baseDir, ∫BumpScrollSpeed·bumpDir)` — both
  accumulators advance by `speed·dt` (renderer +0xa8 = frame dt, vtbl+0x54) once per frame while either speed
  ≠ 0; directions normalised by their setters (0 when |d|² ≈ 0); `c15.x` = phase += `AnimationSpeed·dt/depth`,
  wrapped above 1, only when the bump volume has more than one slice. The bump volume is sampled with WRAP on
  u, v, w (trilinear between slices). `waterAnimation()` in trackData.ts.
* **Water fog colour**: the water pass sets FOGCOLOR from renderer +0x90 = `Track.fogColor`, **halved** when
  the renderer holds a Water.EnvTex (vtbl+0x3c FUN_00668230 multiplies the stored colour by 0.5 when +0x134 ≠
  0): both passes fog toward `fogColor/2`, so the additive sum reaches `fogColor`.
* The bump maps (water volumes, `*_bump` normal maps) hold SIM-space normals (G = up, measured: WaterBumpTex7
  mean G 254, Ir_IceStain_JT_bump 235); all water / bump maths runs in SIM space (three z negated), the env
  cube is sampled with the SIM direction (its faces are SIM-frame).

## 4. Ground sampler

`heightAt(x, z)`: the highest up-facing Track.qm triangle under three-space (x, z) (uniform 16 m grid of
triangle lists), NaN off the mesh — the camera rig's ground (`OriginalStageView.groundAt`).

## 5. Frame check (stage vs mesh)

At load the stage's road samples (start..finish) are tested against the mesh in the contract frame (three =
SIM with z negated) and z-mirrored (`stageFrameFit`). If the road only lies on the mirrored mesh (a stage built
with the spline's raw (x, y, z) as three space), the component serves itself mirrored (`scale.z = −1`, SIM
shading via `uSimZ`) and warns once — the same workaround as the collision world (docs/orig/collision.md §5).
With the current ported stages all 48 fit the contract frame (98–100 % of the road samples within 2 m; 0–71 %
mirrored, the circuits being nearly symmetric), so the fallback is dormant.

## 6. Verification

* `tests/render/origTrack.test.ts` (112 tests, ~20 s): the regulator / bump light / water animation / height grid /
  frame fit maths; shader sources; on the built packs, all 48 stages: patch / vertex / triangle counts equal
  `fmt_quadmesh.parse` (table generated from the verified parser, independent of track.py), groups tile the
  index buffer, indices stay inside their patch, bounds hold every vertex, quadtree lists every patch once,
  every texId is a valid `.rtex`, every lightmap is P8 with exactly the stage's `Track.pal` (RIFF offset 24),
  corsica-1-f uses the white fallback, `Water.*` exactly on the 14 water stages, only the documented
  unresolved names; the runtime loader on kenya-1-f / corsica-1-f / iceracing-1-f (meshes per patch, World
  render order, SpecBump groups = bumpmapped submeshes, culling, ground height at the start within 2.5 m, the
  World-pass mode switch); the ported stage road on Track.qm in the contract frame (6 stages, > 95 %).
* `tools/assets/check-game.mjs` default / `s3tc=0` / `orig=0` on corsica-1-f, hillclimb-3a-f, kenya-1-f,
  newzealand-2-r, rallycross-1-f, iceracing-2-f: 0 console errors, 0 warnings.
* Comparison shots (`artifacts/port/track/<stage>_{chase,bonnet}_vs_original.png`; `compare-start.mjs` then
  `compare_sheet.py`): the real game at the start of corsica-1-f, hillclimb-1a-f, iceracing-1-f, kenya-1-f,
  newzealand-1-f, rallycross-1-f (track + objects + environment, `?gamma=0`), next to the same frame through the
  in-race gamma ramp with the stage's scripted `Game.trackGammaDelta`, above the 8 original screenshots.
  Materials, road markings, walls, mask blends, lightmap shadows, ice / snow / sand / tarmac / mud surfaces and
  the World backdrops match the screenshots. Road luminance (median; the patch just ahead of the bonnet cam vs
  the screenshots' bottom-centre road, median of 8 — different spots of the stage, so ±20 % is noise):

  | stage | scripted `trackGammaDelta` | port raw | port + ramp (scripted delta) | screenshots |
  |---|---|---|---|---|
  | corsica-1-f | 0.0 | 160 | 164 | 131 |
  | kenya-1-f | 0.05 | 215 | 220 | 172 |
  | iceracing-1-f | 0.05 | 207 | 214 | 190 |
  | hillclimb-1a-f | 0.2 | 40 | 81 | 85 |
  | newzealand-1-f | 0.2 | 37 | 77 | 73 |
  | rallycross-1-f | 0.2 | 31 | 69 | 67 |

  The raw framebuffer is in the screenshots' range on the delta 0 / 0.05 stages and ~2× too dark on every
  delta-0.2 stage; through the in-race gamma ramp (environment.md V3) **with the stage's scripted delta** all
  of them match.
* **Gamma resolution (2026-10-30, environment.md §5, research V3 note).** The scripted delta IS live in a race, but
  for a different reason than above: the exe applies the ramp at 0x494a6d after the play script's
  `Game.createTrack` has run RenderSettings.con (0x428710 → 0x494c00 → 0x4963e7), so the pipeline now ramps every
  original stage with its `Game.trackGammaDelta` (R^0.58 G^0.63 B^0.68 on the delta-0.2 stages). The screenshots,
  though, carry **no** ramp: the engine grabs the back buffer (0x4e0630, `GetBackBuffer`, which the hardware ramp
  never touches), the shipped files are offline 200×150 TGA 2.0 re-saves, and their colours lack the ramp's fixed
  channel offsets (fitted e_R − e_B ≈ −0.01 on 40 stages; any enabled ramp gives −0.10). Their brightness only
  partly follows the delta (best fit on the 0.2 stages, worst on the 0.05 ones), so they are not a brightness
  reference: keep `?gamma=0` for screenshot comparisons and judge in-race brightness by the exe. Sheets:
  `artifacts/port/gamma/`.
* Draw calls / triangles of the track component (800×600, start, chase cam; whole frame in brackets):
  kenya-1-f 262 / 22 k, 58 of 187 patches (390 / 40 k); corsica-1-f 108 / 30 k (244 / 54 k); iceracing-1-f
  149 / 25 k (342 / 52 k); rallycross-1-f 71 / 17 k (187 / 62 k); hillclimb-1a-f 129 / 19 k (261 / 49 k);
  newzealand-1-f 137 / 17 k (340 / 80 k); worst seen: a lake view over corsica-1-f, 600 / 70 k (105 patches).
  The draws are the original's (one per submesh and pass); merging across patches would need a lightmap atlas.

## 7. Deviations and open points

1. **Far plane**: besides the camera's far plane (exact when the environment pipeline runs and World.qm is on
   its sky layer), the track shaders `discard` beyond near + view distance, so the clip is right also when the
   main camera's far is larger (no environment component, rallycross without World.qm, `drawWorld 0`). The
   discard costs early-Z on the terrain; acceptable at these triangle counts.
2. **Half-vector cube**: computed analytically (no 64² × 8-bit quantisation of H).
3. **ps.1.1 range**: GeForce-style saturation after each instruction (a Radeon 8500 keeps values up to 8 and
   would brighten painted areas by up to ~1.3×, quadmesh.md §4.4).
4. **Water — OPEN: the port is brighter than the screenshots.** QA (2026-10-30) measured the lakes against the
   Screenshots: corsica-3-r shows dark mountain reflections (60–85) where the port is a light grey (150–176),
   newzealand-2-f (one pass) a slate 56–76 where the port has 122–141, corsica-1-f 120–182 vs 233–254; the
   rallycross-1-f horizon ring is sky-blue (164,192,225) in Screenshot00007 and the track fog grey in the port. A
   pass-1 term near 0 (N·L ≈ 0, e.g. L = the bump light) reproduces the dark lakes
   (`artifacts/qa/corsica-newzealand/sheets/water_experiment.png`), but the executable says otherwise, re-read for
   this: the shipped `Water.pso` / `Water.vso` / `Water2.*` bytecode equals the `.ps` / `.vs` sources (decoded);
   VS c13 = (1, 0.5, 0, 0) (0x6691bd–0x6691db) and c14 = renderer +0x48 (0x6691e5–0x669206), uploaded per draw
   with c0–c27 (0x669523), and +0x48 is FUN_0049a680's first vtbl+0x4c argument = race +0x904, the normalised sun
   **toward** the sun (default (0, 1, 0) @0x49a6bf; the D3D light gets its negation @0x49a7a2–0x49a7f0; arguments
   pushed eax = bump light, edi = sun @0x49ab3b–0x49ab41); pass 1 (0x666af2–0x666be5): FOGCOLOR = renderer +0x90
   (= `track.fogColor`, FUN_0040f900 → vtbl+0x3c 0x668230, halved with an EnvTex), VS +0x210 / PS +0x20c (=
   `Shaders/Track/Water`, loaded @0x66a76f / 0x66a849), stages 0/1 WRAP, stage 2 CLAMP, textures BaseTex / BumpTex
   volume / half-vector cube, no blend state of its own — the end-pass 0x666e60 → 0x666f43 turns ALPHABLENDENABLE
   off and ZWRITE on after every second pass, so pass 1 is opaque; pass 2 (0x666dc5) SRC = DEST = ONE (0x491070 =
   RS 19 / 20). The bump volumes are A8R8G8B8 with G ≈ 254 (normals straight up, Tex6e / 7 / 10). With all of that,
   pass 1 = sun.y + spec for flat water, as implemented; what makes the original darker is not found (candidates
   left: hardware behaviour of the 2002 ps.1.1 path, a texture-manager format change for volumes, the screenshot
   build). Not changed. The Water object's world transform is taken as identity (the uv phase of `world.zx·tile`
   would shift if the engine placed the object elsewhere). The scroll accumulators start at 0 when the view loads
   (the original's are statics since program start).
5. **Missing textures** sample black (the engine's behaviour for a failed load is not traced): the kenya-3
   `KE_Tarmac_02_MT` subshaders and one newzealand-2-r water-side subshader.
6. **Halved fog colour**: applied to the water passes only (the only FOGCOLOR consumer of renderer +0x90).
7. **World.qm fog**: the WORLD fog without the track clamp (environment.md V6.3 open).
8. `Track.fogRangeFixed` (non-high detail) is not used; `track.lightmapLimit`, `lightmapStreaming`,
   `track.lightmapOnly`, `maskBlendEnable 0` are not modelled (defaults: full lightmaps, Mask path).
9. **Brightness vs screenshots**: see §6 — the in-race ramp now uses the scripted delta (environment.md §5); the
   screenshots carry no ramp, so compare them with `?gamma=0` frames.
