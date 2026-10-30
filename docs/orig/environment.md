# Original environment (sky, clouds, sun flare, fog, lights, weather, view distances, gamma)

Environment builder. Spec: `research/formats/environment.md` (§0–§4, §8, Verification V2/V3/V6) and
`research/formats/textures.md` §6. Everything here is the original's evaluated per-stage state, drawn with the
original's pass order; procedural stages are untouched.

| piece | file |
|---|---|
| build step | `tools/assets/parts/environment.py` → `public/assets/stages/<id>/environment.json` (48 stages) |
| pure maths + json types | `src/render/orig/environmentData.ts` |
| component + frame pipeline | `src/render/orig/environment.ts` (`loadEnvironment`, `OrigEnvironment`, `OrigFramePipeline`, `ORIG_SKY_LAYER`) |
| procedural content in an original view | `src/render/orig/environmentFog.ts` (global material hook) |
| renderer wiring | `src/render/renderer.ts` `loadStage` (atmosphere / camera range) and `update` (render call), `followShadow` (sun) |
| tests | `tests/render/origEnvironment.test.ts` (19 tests; real-data ones skip without built packs) |
| comparison tool | `tools/env-shots.mjs` (canvas grabs: start / mid / toward the sun; `--gamma 0` default) |

Rebuild: `npm run assets -- --parts environment --stages all` (0.4 s, textures are shared and already converted).

## 1. Data (`environment.json`, version 1)

The verified resolver `fmt_environment.resolve_stage` evaluates every stage's scripts in the original load order
(TrackFogSettings → RenderSettings → Single1p/4p → GlobalRenderSettings → Sky.con → lighting.con → Water.con →
Cameras.con, console rules §2). The part maps the resolved state onto a compact json, **every unset field already
filled with the FUN_0040e650 settings default (V2)**, the Sky ctor FUN_005477a0 or the weather ctor FUN_0054a360,
and every texture as a texId:

* `fog.track` / `fog.world`: enabled, colour (raw 0..1), start, end (the high-detail `fogRange`, §3.4), clamp
  (`Track.fogClamp`, default 1e8; World has none), `rangeFixed`, `defaulted[]`.
* `light`: sun direction (SIM + three, normalised), `game.lightColor/shadowColor`, `car.lightColor/ambient`, car
  shadow / lightmap terms, `track.bumpHeight/specularColor`, `particleLightmapMin`.
* `sky`: 5 face texIds (TOP, LFT, RGT, FRT, BAK; no bottom), rotation (deg), `ofsSkyHeight`, half size 3000,
  clouds (`texture`, D3D src/dst blend enums, texScale, speed, height), `ofsRndTexPos`.
* `sun`: the `Sky.setSun` object's LensFlare template (flares then coronas: texture, size/size2, colour/colour2
  0..255, rot), occlusion quad, 4096 m distance; null on 7 stages (6 never call `Sky.setSun`; rallycross-2-f binds
  `sun` but never creates it).
* `weather`: the WPart system (type 0 snow / 1 rain, radius, partSize, speed, random, count, sprite limits,
  displacement, colour, scale, textures) on the 10 weather stages.
* `view`: Track / Object view distance, the HotSpot list, FOV 70, pass ranges (sky 10 / 100010, main 0.1 /
  0.1 + view distance).
* `gamma`: the script `trackGammaDelta`, the live delta (= the script value, §5) and the menu `gfxGamma` default 0.5.
* `templates`: per-object light / shadow multipliers (`geometryTemplate.*`, lighting.con) for the objects builder.

## 2. Runtime

`loadEnvironment` writes the shared `origUniforms` in place (trackFog, worldFog, sunDir, objectLight /
objectShadow, carLight / carAmbient; identity kept), then builds:

* **Sky box** (§3.1, FUN_00547ee0): 5 quads from the vertex/UV table, z-mirrored to three space, one
  `ShaderMaterial` each (texel as stored, no fog), cull NONE, z off, sampler clamp + linear/linear/mip-point,
  centred on the camera + `ofsSkyHeight`, rotated −`rotAngle` about +Y.
* **Clouds** (§3.2, FUN_00549130): one ±2048·20 m plane per cloud at camera.y + height, UV = base · texScale +
  scroll (speed · dt, random start from `ofsRndTexPos`), the cloud's D3D src/dst blend, z off. The 8-bit cloud TGA
  (descriptor: 8 alpha bits) is coverage: colour white, alpha = texel. corsica-1-r has no clouds (§3.2).
  Draw order in the sky pass = the original's sky box → clouds → World.qm (FUN_00547ee0, FUN_00549130,
  FUN_0048eb90): all three are in three's **opaque** render list (the clouds keep their CustomBlending factors), with
  renderOrder −2 (SKY_RENDER_ORDER) < −1.9 + 0.01·i (cloudRenderOrder) < −1.5 (track.ts WORLD_RENDER_ORDER), so the
  distant terrain covers the clouds. (Fixed 2026-10-30: the clouds were `transparent`, i.e. drawn after the opaque
  World mesh, and painted haze bands over the backdrop mountains: up to 63 % of the visible World pixels changed by
  > 15 per channel on corsica-1-f, 0 % now; `artifacts/qa/fix-render/clouds_sheet.png`.)
* **Sun lens flare** (§3.3, 0x78a990 / FUN_0078ca00 / FUN_0078d510 / FlareShader.vs): see §4.
* **Weather** (§3.8, FUN_0054a830 / FUN_0054aa60 / FUN_0054b1c0 / FUN_0054ac20): `WeatherSim` (spawn in the
  scaled ellipsoid, per-particle jitter velocity, `p += (speed + v)·dt − Δsystem`, wrap to −p_old), camera-relative
  world-axis positions drawn with the view rotation only; D3D point sprites with POINTSCALE A = B = 1, C = 0:
  `size = Vh · Si · sqrt(1/(1 + De))` clamped to `width/640 · [min, max]`, Si = partSize.x · ¼ (snow) / ½ (rain);
  colour = texture × WPart.color, SRCALPHA / ONE, z test on, z write off, no fog; one draw per texture (the draw loop
  switches texture every count / textures particles). The procedural `Precipitation` never runs in an original view.
  Pass state traced (2026-10-30, FUN_0054ac20 @0x54af60–0x54b04e and FUN_0054b1c0): stage 0 COLOROP and ALPHAOP both
  MODULATE(TEXTURE, DIFFUSE) (0x490ce0 / 0x4e02b0 with edx 4, args 2 / 0), stage 1 colour + alpha DISABLE, ALPHATEST on
  (GREATER 0, the restored device value), SRCALPHA / ONE, ZWRITE off, POINTSPRITE + POINTSCALE on, POINTSCALE_A = B =
  1; the diffuse is WPart.color packed ×255 (setter 0x5452c0, bytes A·B·G·R — R and B swapped against D3DCOLOR, equal
  on every shipped grey). The sprite is sampled at **mip level 0** (min filter LINEAR, no mip; see §5).
* **View distance**: `viewDistance(camera)` = the HotSpot-regulated `Track.viewDistance` at the camera's spline
  distance (FUN_004e1240 rule: Global + most negative + most positive spot delta, linear fade band).

### 2.1 The frame (`OrigFramePipeline`, one per renderer)

The original's view loop (0x49f0f0 – 0x49f23e) is reproduced literally:

1. **sky pass**: a camera copy with near 10 / far 100010 and only `ORIG_SKY_LAYER`: sky box, clouds, World.qm (the
   track builder puts World.qm on that layer and the pipeline's sky camera draws it).
2. `Clear(ZBUFFER | STENCIL)` (0x49f19d).
3. **main pass**: near 0.1, far 0.1 + the HotSpot-regulated view distance (race +0x73c/+0x740). If World.qm is
   not on the sky layer the far plane stays ≥ the components' `cameraFar` so nothing gets cut.
4. **lens flares** after the main pass (the original draws them after weather, 0x78de70).
5. **gamma ramp** (V3) on the finished 8-bit frame: `out = (round(c·255)/256)^e` with the stage's scripted
   `Game.trackGammaDelta` (§5): e = (0.9, 0.95, 1.0) at delta 0 down to (0.58, 0.63, 0.68) at delta 0.2.
   `?gamma=0` turns it off (for comparisons with `Screenshots/*.tga`, which carry no ramp), `?gfxgamma=<0..1>`
   sets the menu gamma.

Steps 1–4 render into a render target (RGBA8, the canvas' MSAA as samples, a `DepthTexture` for the flare occlusion);
step 5 blits it to the canvas. `renderer.info` accumulates over all passes, so `stats()` reports the whole frame.
A failure inside the pipeline logs one warning and the frame falls back to a plain render.

### 2.2 Pass ranges: the sky pass far is 100 km, not 5 km

The race-level ctor (0x483e30) starts with sky near 10 / range 5000, but the level init overwrites race
+0x734/+0x738 from the settings singleton +0x0c/+0x10 (0x487a6f–0x487a8b; settings events 4 / 5 at
0x486ec2/0x486edc), whose FUN_0040e650 defaults are **10 and 100000** (0x40e6c7/0x40e6d3); no shipped script sets
them. Camera vtable 0x8228f0: +0x24 sets near (+0x24), +0x2c sets the depth **range** (+0x28): the projection
0x689bf0 uses Q = (range + near)/range = far/(far − near). With the earlier 5010 the 2500 m cloud plane was cut at
~26° elevation (a hard line); with 100 km the clouds reach the horizon like in the screenshots.

### 2.3 FOV (no change needed)

`renderer.fieldOfView` (settings +0x1dc, default 70) reaches race +0x730 and the camera's setFov (vtable 0x8228f0
slot +0x14 → +0x1c). The projection 0x689bf0 builds m11 = cos/sin(fov/2) (0x689d14–0x689d36) and m00 = that ×
camera +0x2c (0x689ca3–0x689ccc), where +0x2c = viewport height / width (vtbl+0x34, set at race camera setup, all.c
FUN_00489… `piVar16[3] / piVar16[2]`, halved for two players). **The 70° is the vertical FOV** — exactly three's
`PerspectiveCamera.fov`, so `src/render/cameraRig.ts` (fov 70) already matches; environment.md V6.6's "probably
horizontal" guess is refuted.

## 3. Procedural content inside an original view (gap 4)

`environmentFog.ts` installs one hook on `THREE.Material.prototype.onBeforeCompile` at import (instance hooks
assigned later are chained first and keep distinct program keys; RawShaderMaterial untouched). It is gated by a
shared uniform (`setOrigBuiltinMode`, on while an original view is shown):

* `<fog_fragment>` → the original linear fog with clamp, values by identity from `origUniforms.trackFog`
  (mode off: three's own code, verbatim).
* built-in materials: an sRGB encode after `<colorspace_fragment>` (the original view outputs gamma-space bytes;
  three's linear built-ins would otherwise come out too dark). Skipped for maps in `NoColorSpace` (original
  textures in a built-in material) and `userData.origRaw`.

`applyOrigAtmosphere` (renderer `loadStage`) maps the track fog onto `scene.fog` (needed for `vFogDepth`), sets
the background to the fog colour and lights procedural content like the original car shading (hemisphere =
car.ambient, sun = car.lightColor along the original sun, intensity π, values ^2.2 because the built-ins light in
linear space before the encode). `followShadow` uses `origUniforms.sunDir`.

A/B proof (pine-ridge, fixed debug camera, `?orighook=0` diagnostic flag): with vs without the hook 187 of 307 200
pixels differ, 172 of them by 1 LSB (shader rounding), against 49 pixels between two identical runs; procedural
stages are unchanged up to rounding noise.

## 4. Lens flare and its occlusion (0x78a990, traced from the disassembly)

* Layout (FUN_0078ca00 sun branch, FUN_0078d510): sun object at camera + 4096 · sunDir; flare *i* on the line from
  the mirror point (2·centre − sun) to the sun, coronas on the sun; centre weight tent (FUN_0078c4e0) blends
  size/size2 and colour/colour2; elements before the last two × dot(sunDir, forward); the second-to-last scaled by
  the visibility; the last at clip z = 1. Hidden when the sun is behind the camera (FUN_0078a6a0).
* **Visibility is always 1 in this build**: 0x78b589–0x78b5df writes counter[+0x74]/counter[+0x64] with both
  counters set to 1.
* **The real occlusion is a per-pixel mask**: the SunOcclusionShader quad (white, `COLORWRITEENABLE = ALPHA`,
  z-tested against the main pass) is drawn at the sun; the 8×8 back-buffer block centred on the sun pixel is copied
  (`CopyRects`, rect clipped to the screen, the rest of the 8×8 "occlusion-texture" zero-filled first); every
  element but the last is drawn with texture stage 0 = SELECTARG1(TEXTURE) (0x78b798) and stage 1 = MODULATE(CURRENT,
  occlusion TEXTURE|ALPHAREPLICATE) (0x78b80f), i.e. multiplied by the 8×8 block stretched over its UVs; SRCALPHA /
  ONE (0x78b69c). A sun whose 8×8 block is fully off screen draws nothing.
* Web: after the main pass the pipeline renders an 8×8 mask target from the main depth texture (1 where nothing
  was drawn = the occlusion quad would pass the z test), the elements sample it bilinearly; the last element is
  depth-tested at clip z = 1 (shows only over sky pixels), unmasked.

## 5. Deviations and open points

* **Flare aspect**: c9 = (1/300, −0.004333) is authored for 4:3; the web keeps the vertical scale and scales x by
  (4/3)/(W/H) so the sprites keep their on-screen shape at any aspect.
* **Flare alpha op**: the alpha op of the flare draw is not set in 0x78a990 (inherited state); assumed
  texture.a × diffuse.a (the colour RGB from `setFlareColor` is unused by the traced SELECTARG1 colour op).
* **Weather sprite mip level** (assumption): WebGL picks a point sprite's mip from the gl_PointCoord derivatives, so
  a 4–6 px flake read level 2 of the 16² snow texture and averaged its bright ring away (flakes changed the frame by
  +5/255 on average, +28 at most). The port samples level 0 (max +50 on hillclimb-3b-f; `artifacts/qa/fix-render/
  snow_sheet.png`), in line with the clearly visible flakes in every 3b-f / 3c-f Screenshot; how the original's D3D8
  point sprites chose the level is not traced. The flakes in the port still look fainter than in the 200×150
  Screenshot thumbnails (whose capture resolution is unknown); the maths above is the exe's.
* **Weather texture switch**: equal blocks of count / textures particles (the switch condition's counter is not
  recovered).
* **Cloud colour**: white with alpha = texel (A8 behaviour; an L8 upload would make every cloud opaque, impossible
  given the screenshots). The forced white 500–1000 m cloud fog is not emulated (it only turns a white colour white).
* **The occlusion quad's own extent** (150 × 150 m at 4096 m ≈ 40 px at 600 px height) is wider than the 8×8 block
  at every supported resolution, so its edge never reaches the mask; not emulated.
* **Gamma ramp: the live delta is the stage's script value (resolved 2026-10-30, was delta 0).** The race loader
  0x493230 runs the stage's play script synchronously (console vtbl+0x24 = 0x5b0cd0 at 0x493bef / 0x493e3c);
  Play.con → Start.con → `Game.createTrack` (exec 0x428710) → 0x494c00, which runs RenderSettings.con
  unconditionally (0x4963e7) and so sets `Game.trackGammaDelta` (Game +0x78; written only by the reset
  FUN_0040e650 and the console setter, no other script sets it). Only then does the loader read it (0x494a6d) and
  call the renderer's setDelta(delta, enable 1) (vtbl+0x138 = 0x68dea0 → ramp 0x68dd70 → `SetGammaRamp`); race
  teardown (0x486530) resets (0, off). V3's "read before RenderSettings" took 0x4963e7 for part of the loader; it is
  in 0x494c00. `OrigEnvironment.gammaExponents()` therefore uses `trackGammaDeltaScript` (and the builder writes
  `trackGammaDeltaLive` = the script value): at gfxGamma 0.5, R/G/B exponents 0.90/0.95/1.00 (δ 0, 2 stages),
  0.805/0.855/0.905 (δ 0.05, 9), 0.72/0.77/0.82 (δ 0.1, 26), 0.645/0.695/0.745 (δ 0.15, 2), 0.58/0.63/0.68 (δ 0.2,
  9). The shipped `Screenshots/*.tga` cannot settle this: the engine's writer (0x4e0630 / 0x4e04d0) grabs the back
  buffer (no hardware ramp) as 32-bit top-left TGAs, while all 384 shipped files are 200×150 bottom-left TGA 2.0
  re-saves; on 40 stages from new cameras (`artifacts/port/gamma/`, per-channel quantile distance) no ramp / delta 0
  / script delta score 23.0 / 21.9 / 21.8 (script vs delta 0: t = −0.06), the script ramp fits the δ 0.2 stages best
  and the δ 0.05 stages worst, and the fitted channel exponents show no ramp fingerprint (e_R − e_B = −0.01, the
  ramp forces −0.10). Before / after sheets: `artifacts/port/gamma/sheet_<stage>.png` (one stage per family).
* **HotSpot reference point**: the camera's spline distance (`stage.project`), as the track builder's regulator.
* Not ported here (other owners): water surfaces (track), particles' fog (effects: their ShaderMaterial keeps its own
  fog uniforms), car shading (cars), per-object light multipliers (objects; `templates` is in the json).

## 6. Verification (this phase)

* `npx vitest run tests/render/origEnvironment.test.ts`: 21 passed. The uniform values of all 48 stages equal an
  independent read of `.cache/dumps/environment_dump.json` with the FUN_0040e650 defaults for every unset field;
  `loadEnvironment` builds real stages (sky box on the sky layer with clamp/mip-point samplers, cloud blends,
  flare elements, snow/rain batches summing to `numParticles`); every stage's ramp exponents equal a written-out
  table of its script delta, and `gammaExponents()` returns them (rallycross-1-f 0.58/0.63/0.68).
* Browser: `tools/assets/check-game.mjs --variants default,s3tc=0,orig=0` on corsica-1-f, corsica-2-r (rain),
  hillclimb-3b-f (snow): 0 console errors, 0 warnings. `tools/env-shots.mjs` on 15 stages of every family
  (`artifacts/port/environment/compare_*.png`, ours start / mid / toward the sun next to the original screenshots):
  sky art, cloud layers, fog haze, sun flare shapes (TSun corona rays on kenya, the TSun1 star on iceracing-2-f)
  match the screenshots; rain streaks and snow flakes visible like in the originals.
* Gamma ramp: the blitted frame equals `255·(round(c)/256)^e` of the ramp-off frame (mean within 0.2 per channel);
  with the script delta (6 stages, 8 views each, `artifacts/port/gamma/pixel_check.json`): median |diff| ≤ 0.42.
* Cost (corsica-1-f, 800×600, SwiftShader): 200–430 draw calls and 20 k–100 k triangles per frame for the whole
  view (all builders' content); the environment adds 5 sky quads + ≤ 3 clouds + ≤ 17 flare quads + ≤ 8 weather
  point batches, one 8×8 mask pass, one full-screen blit, and one RGBA8 + depth render target at canvas size.
