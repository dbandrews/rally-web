# Original car effects — port notes (effects builder)

Spec: `research/formats/effects.md` (exe addresses, Verification). Build: `tools/assets/parts/effects.py`
(`npm run assets -- --parts effects`). Runtime: `src/render/orig/effectsData.ts` (definitions, RandomDistribution /
OverTimeDistribution, phys vars, light grid) and `src/render/orig/effects.ts` (`OrigEffectsSystem`, `OrigCarFx`),
wired through `src/render/effects.ts` (`ParticleSystem.orig`, `CarEffects.orig`). Tests:
`tests/render/origEffects.test.ts`. Screenshots: `node tools/effects-shots.mjs --stage <id> [--car <Name>]`.

## Outputs

| file | content |
|---|---|
| `stages/<id>/effects.json` | the evaluated templates (Emitter / SpriteParticle / CarFx, every property defaulted), the CarFx bases a car gets on the stage with their PFX_Template placement, the pipe FX present, particle-system settings, the skid table, the drop-shadow settings, the particle-light LUT, texIds (`volume` + `depth` for the animated `Anim_*` sprites) |
| `stages/<id>/effects.bin` | particle light grid: RGB8 per 4 m cell, sparse 32×32-cell tiles within 80 m of the AI spline CVs (60–620 KB; corsica-1-f has no lightmaps → none) |
| `cars/<Name>/effects.json` | exhaust FX placements (Burst.con), drop-shadow texture, DropShadows.con scale, BodyShadow.sm box |
| `global/effects.json` | the startup skid table, the default drop-shadow texture, the PFX_Template list |

## Runtime behaviour

* `GameRenderer.loadStage` → `ParticleSystem.setStage(id, view !== null, textureStore)`: with an original view and
  the part built, the stage's effects load asynchronously; until then (and on procedural stages, `?orig=0`, no
  part, a failed load) the procedural effects run unchanged. A failure logs one `warnOnce`. Loads are sequenced: a
  superseded load (stage switch / restart while textures load) that later fails is dropped silently and never
  unloads the newer stage's effects (`tests/render/origTextures.test.ts`).
* Per car (`CarEffects.update(tel, pose)`): one emitter instance per CarFx child (per wheel for modes 4–10), the
  CarFx fade from the phys variable, the emitter spawn loop, the backfire / blow-out flags for the pipe bursts,
  skid strips per wheel, the drop-shadow quad. Per frame (`ParticleSystem.update(dt, camera)`): the particle step,
  colour / close-distance fade / alpha cull, back-to-front sort per template, upload.
* Draw calls: one instanced draw per SpriteParticle template that has visible particles (typically 2–6 while
  driving), one for the skid marks, one per car drop shadow. Particle count bounded by the stage's
  `ParticleSystem.maxParticles` (3000 or 500) × `maxParticlesPercentage` × the renderer quality's particle density
  (`OrigEffectsSystem.density`: 1 on 'high' = the original's cap, 0.75 / 0.5 on 'medium' / 'low', a port-only
  performance setting), ≤ 100 spawns per emitter per frame; skid
  ring 3500 quads. Measured on SwiftShader: 65–120 live particles at 55–75 km/h on kenya-1-f / hillclimb-3b-f.

## Deviations (WebGL / untraced) — also in the builder's known issues

1. **Wheel slip inputs** (`c_WheelXSlip`, `c_WheelZSlip`): the original's CarWheel FX record writer was not found;
   the port feeds `|tan(slipAngle)|` and `kappa` (telemetry) — the spec's [I] in §10.1. Affects when Slide / Brake /
   Spin emitters and skid marks trigger.
2. **Sprite extents**: half width = XYSizeRatio·size, half height = size (the vertex writer was not located).
3. **Sorting**: the original sorts all particles of all systems together; WebGL draws one batch per template, each
   sorted back to front, the batches ordered by mean depth.
4. **Lighting**: `useProjectedLightmaps` is evaluated once per particle at spawn from the 4 m light grid (the
   original samples the patch lightmap per pixel). `useGradiantLighting` / `useShimmer` are not ported.
5. **No fog on particles** (the Sprite shaders write oFog = 1). Skid marks and the drop shadow use
   `origUniforms.trackFog`.
6. **Collisions** (`hasCollisionPhysics`, gravel lumps): a horizontal plane at the wheel contact height at spawn,
   reflection `v.y ← −v.y·elastic`.
7. **Drop shadow**: the low-detail blob (`DropShadows/<Car>.tga`, multiply blend, `min(tex + dropShadowColor, 1)`),
   corners on the wheel contact heights, height fade from the body height. The original's high-detail dynamic
   shadow passes (`game.dynamicShadows 1`: ShadowGen / ShadowApply) are not ported. Archetype cars (no original
   car name) get no drop shadow and no exhaust FX (no data).
8. **Backfire / blow-out flags** come from the one shared source (src/game/carFlags.ts, run once per rendered frame
   by main.ts) through `CarRenderState.carFlags`; the audio gets the same object (FrameContext.carFlags), so the
   flame and the bang fire on the same frame. `OrigCarFx.pipeFlags` (sound.md §4.3 rules, own random stream) remains
   only for a car without the flags (the ghost).
9. **Template persistence**: the original keeps templates loaded by earlier races; the port uses the fresh-start set
   of each stage.
10. The original screenshots (`Screenshots/*.tga`) show no cars, so the effects could not be compared with them
    directly; the look was checked against the data (textures, colours, sizes) on kenya-1-f (sand / gravel),
    hillclimb-3b-f (snow asphalt), corsica-3-f (wet tarmac) and corsica-1-f (tarmac: no FX without sliding, as in the
    data).
