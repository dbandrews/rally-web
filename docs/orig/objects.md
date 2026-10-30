# Original objects (trees, props, spectators, Kuliss backdrops, impostors)

Owner: objects builder. Files: `tools/assets/parts/objects.py` (build), `src/render/orig/objects.ts` (component),
`src/render/orig/objectsData.ts` (data contract + pure maths, no three.js), `src/render/orig/objectsShaders.ts`
(GLSL), `tests/render/origObjects.test.ts`, `tools/orig-objects-shots.mjs` (browser screenshots + stats).
Specs: `research/formats/objects.md`, `standardmesh.md`, `environment.md` §3.5/§3.6 (Verification sections win).
Everything marked "decoded here" was read from `original_version/original_desktop_version.exe` for this port
(objdump disassembly; addresses given) because the specs left it open.

## 1. Data flow

```
Objects.con (authoritative, objects.md §1.1) + object library (fmt_objects) + .sm/.tm/.rs (fmt_standardmesh)
   + RenderSettings / HotSpot / lighting.con (fmt_environment)  ──► objects.py build_stage
      stages/<id>/objects.bin   vertices (THREE space), indices (winding swapped), instance records
      stages/<id>/objects.json  settings, hotspots, meshes, templates (textures as texIds), stats   (written last)
   ──► loadObjects (objects.ts): one instanced batch per template, culled + bucketed on the CPU every frame
```

`MergeMesh.enable` is never set in the release game and the MergeMesh class is not even registered, so the
`.dat` caches are ignored: mergeable grass and sideScreen (Kuliss) templates are ordinary TreeMesh objects.

### objects.json (version 2) / objects.bin

* `instStride` = 24 floats per placement, Objects.con order within a template, templates in first-use order:
  `0..11` THREE 3×4 matrix rows (`M = F·(diag(s)·R)ᵀ·F`, R = Rz(roll)·Rx(pitch)·Ry(yaw) row-vector, F = diag(1,1,−1),
  translation `(x−2048, y−H, −(z−2048))`); `12..14` colour (TreeMesh: `float32(floor(255c))·float32(1/255)`, default
  byte 127; other geometry 0.5); `15` shadowFactor; `16..17` SIM local +Z on xz (normalised), `18..19` SIM local +X on
  xz (tree sort selection); `20` radius of the scaled bbox (radiusFromOrigin); `21` max(scale); `22` per-object
  random (objectDistanceVariation).
* `meshes[]`: `sm` (per LOD: vertices f32×8 pos/normal/uv, indices, material groups with `.rs` transparent /
  twosided) or `tm` (vertices f32×10 incl. spriteOffset, the index buffer WITH the 8 sorted copies, groups
  [branches, trunk, sprites, facing], crown sphere). AnimatedMesh = the skin's bind pose (Biped z-up → THREE
  `(x, z, −y)`; the winding is flipped when it disagrees with the normals).
* `templates[]`: kind, mesh index, `lighting` / `lightMul` / `shadowMul` (library + lighting.con), `lodDistances`,
  TreeMesh flags, per-material / per-group texIds (`setMaterialTexture` overrides by material name), `billboard`
  (impostor: atlas texId, `frames` n, `dirs` = .tm sortDirections, `halfWidth`, `minY`, `height`).
* `settings`: the object view settings (see §2), `hotspots`: every HotSpot of the stage.

## 2. ObjectDrawer culling (0x6f2970, decoded here)

Per object, `d²` = |node centre − camera|² (3-D), `r` = node radius, `a = 1 − rnd·variation`, `V` viewDistance:

| rule | |
|---|---|
| culled | `d² > (a·V + r)²` |
| culled | `d² > kC2·r²` and `d² > M²` (strict) |
| distance fade | `(√d² − (a·V·df + r))·invSpan/a` when `d² > (a·V·df + r)²` |
| size fade | `(√(d²/r²) − cfC)·invCfC` when `d² > cf²·kC2·r²`; if `d² < M²` also `min(·, (√d² − cfM)·invCfM)` |
| alpha | `1 − max(both, clamped 0..1)` → TFACTOR alpha byte (`ftol(·255)`) |

* **`kC2 = 10·cot²(fov/2)·C²`** is recomputed at the start of every traversal from the camera FOV (0x6f2f90, called
  by 0x6f26a0 / 0x6f27a0); 0x6f2330's plain `C²` is overwritten every frame. The size cull is therefore a
  projected-size test, `d > √10·cot(fov/2)·C·r` ≈ 4.5·C·r at 70°: with cullConst 15 a tree of r = 8 m stays
  visible to ≈ 540 m (as an impostor beyond its billboard distance). The port uses the three camera's `fov`.
* The engine constants are derived like the engine derives them (setters 0x6f30a0 / 0x6f3110): `invSpan =
  1/(V − V·df)`, `cfC = √(cf²·kC2)`, `invCfC = 1/(√kC2 − √kC2·cf)`, `cfM = √M²·cf`, `invCfM = 1/(√M² − √M²·cf)`.
* `√` is the engine's **bit-trick square root** `(bits >> 1) + 0x1fc00000` (exact at even powers of two, up to
  6 % high in between) everywhere the engine uses it (`fastSqrt`); the culls compare squares exactly.
* Alpha test (re-traced 2026-10-30): **GREATER 0 on every object pass.** The StandardMesh colour pass (sub_584320,
  main branch: ALPHATESTENABLE via FUN_00584710(1) @0x5846a3), the tree pass (0x572f80, ALPHATESTENABLE @0x5730c3)
  and the impostor pass (FUN_00573530) enable the test but set **no ALPHAREF**: the render-state stack (push
  0x685d40, pop 0x685d80, lazy restore 0x685df0 from the nearest enclosing frame that recorded the state at
  frame+0x450) gives them the device-init value **0** (FUN_00683be0: ALPHAFUNC 5 @0x683fa7, ALPHAREF 0 @0x684006 /
  0x68401c). The only 0x7F writers — the StandardMesh depth-only branch (0x5846e5 / 0x5846ea, byte argument ≠ 0, not
  ported), the second tree pass (0x573396) and 0x54ca82 — and 0x4baae2 (0xF0) all sit inside their own pushed frame.
  So soft alpha edges blend (HCMidGrass: only 5 % of its texels are > 0x7F, 29 % > 0), an opaque StandardMesh draws
  every texel with alpha > 0, and a fading instance fades smoothly down to alpha byte 1 (skipped on the CPU only at
  byte 0). The earlier "engine default GREATER / 0x7F" (standardmesh.md, textures.md) was one frame's value.

## 3. HotSpot regulator (0x4e1240 evaluate, 0x49c770 push; decoded here)

All 48 stages enable it. Every frame, at spline distance `s`, for every named spot with `|s − sd| ≤ width`:
`core = (1 − fade)·width`, `f = |s − sd| ≤ core ? 0 : (|s − sd| − core)/(fade·width)`; for each field the spot sets
to a non-zero value `delta = (spot − Global)·(1 − f)`. Result = Global + the largest positive delta + the most
negative delta. The push writes all 12 fields: objectViewDistance·q, trackViewDistance·q, cullConst·q (0x85b378),
(minCullDistance·q)² (0x936958), HOG distances, billboardLODScale (TreeRenderer+0x98), billboardFadeScale (+0x9c),
cullFade / distanceFade (ObjectDrawer vtbl+0x5c/+0x54), variation (0x936988), mergeMeshViewDistance (only into the
absent MergeMesh; TreeRenderer+0xa8 gets 0). Global's unset fields are 0 (spot ctor 0x4e0e30), so the build writes 0
for them (4 stages leave billboardFadeScale unset = a hard mesh/impostor switch). `q` (the graphics option's view
distance factor, 0x8741b0) is taken as 1. The port evaluates `s` from the camera position projected on the stage
spline (the original passes a spline distance from 0x4913df; whether it is the car's or the camera's is not traced).

## 4. Billboard trees and impostors (decoded here)

**LOD — TreeRenderer::queue (0x574590)**, `treeMesh.enable3D` on (the high-detail setting; no script sets it):
`dist` = **horizontal** |camera − tree|, `D = billboardDistance·billboardLODScale·maxScale`, `F = D·billboardFadeScale`.
`D = 0` → impostor only; `dist < D − F` → mesh only; else `w = clamp((dist − (D − F))/F)` (F = 0 → 1): impostor with
alpha byte `ftol(w·(1 − fade)·255)` and, while `dist < D`, the mesh with `ftol((1 − w⁴)·(1 − fade)·255)`.

**Impostor quad — FUN_00573530** (drawn first in the tree pass FUN_00572f80, grouped by texture; CULL NONE, ZWRITE 0,
blend 5/6, alpha test):
* yaw `a = atan2(V[2][2], V[2][0]) + π/2` (view matrix, = the Kuliss facing yaw of FUN_005908d0): `R = W·sx·(cos a, 0,
  −sin a)` SIM, `W = max |bbox.min/max x, z|` (template ctor 0x57b677); `U = local +y · sy·(bbox.max.y − bbox.min.y)`;
  base `B = position + (0, bbox.min.y·sy, 0)` (unrotated, 0x591657).
* vertices BL = B − R, TL = B − R + U, BR = B + R, TR; triangles (BL, TL, BR), (TL, TR, BR).
* frames: `u` = the tree sort parameter (FUN_00591d50), `p = 8·u` (**8 = the .tm sortDirections, not the atlas frame
  count n**), `fr = p − ⌊p⌋`: `fr ≤ 0.5` → `i0 = ⌊p⌋ − 1, t = 0.5 − fr`, else `i0 = ⌊p⌋, t = 1.5 − fr`. uv set A = frame
  i0 (`[i0/n, (i0+1)/n]`, the −R side at the frame's right edge), set B = frame i0 + 1; ADDRESSU WRAP, ADDRESSV CLAMP
  (both stages), so atlases with n = 4 or 2 frames repeat around the tree like the original.
* `Billboard.ps`: `r = lrp(t, A, B)`, `rgb = sat(2·r·TF)`, `a = r.a·alpha`; TF = FUN_00591950 (`c = S + (L − S)·(1 −
  sf)·billboardLightScale`, `TF = bytes(sat(2·c·colour))`) — the impostor is lit by the CPU colour, not by N·L.
* createBillboard (0x572343) rendered frame k at azimuth `(k + 0.5)·360°/n` from local +Z toward +X; the runtime
  frame bins are uniform in cos (u) — reproduced, not "fixed".

## 5. Meshes and trees

* StandardMesh: LOD = highest i with `lodDist[i]² < S·d²/maxScale − r²` (FUN_00580160); meshshader.vs lighting
  `d = sat(S'(1 − λ) + L'λ)`, `λ = max(n·sun, 0)(1 − sf)`, `lighting 0` → 0.5; pixel `sat(2·tex·d)`, alpha
  `tex.a·TF.a`; `transparent` materials blend without z-write, opaque ones blend only while fading; `twosided` →
  DoubleSide. Untextured materials (no `texture` key, e.g. Co_Short_bridge_MF `lambert1`) sample white.
* TreeMesh: the two-stage combiner `rgb = sat(2·d·sat(2·tex·TF))`; lit trees TF = colour byte, `lighting 0` trees
  (Kuliss, irbill) `d = 0.5` and TF = FUN_00591950 (constantLightScale); Sprite.vs shadow sphere; sort copy k =
  `min(⌊8u⌋, 7)` in the SIM frame; facing pass yaw as in §4 (the exact atan2 of the view matrix, also for pitched
  cameras); culling off; MIN/MAG linear + MIP point (trilinear with `mipmapBlendingEnable`).
* All object passes use the track fog (`ORIG_FOG_PARS`, per vertex) and `origUniforms.objectLight / objectShadow /
  sunDir` by identity, so the environment component's values apply whenever it loads.

## 6. Deviations (WebGL / instancing) and what is not ported

0. Every object material is in three's blended list (`transparent: true`) and writes alpha 1 unless the instance
   fades, which is the original's "ALPHABLENDENABLE forced on while inst alpha != 255" (DAT_00911899); pass order by
   `renderOrder`: StandardMesh −2, impostors −1, trunk 0, branches 1, facing 2, sprites 3, then the leaves' soft
   edges 3.25 / 3.5 / 3.75 (FUN_0049a300 draws the StandardMeshes before the tree pass, and the tree pass draws the
   impostors first).
1. **Leaves: depth-writing core + soft edge.** The original draws trees one by one with ZWRITE 0, alpha-tested
   GREATER 0, and relies on the ObjectDrawer's distance slices (`slice = ⌊√d·numSlices/√V⌋`, sorted inside a slice)
   for the order. Instanced batches per (template, sort copy) cannot keep a global order across templates, so each
   leaf pass (branches / facing / sprites) is split: the **core** (alpha > 0x7F) writes depth, the **soft edge**
   (0 < alpha ≤ 0x7F, same geometry and instances, `<name>:soft`) blends after every core without writing depth.
   Together they cover exactly the original's GREATER-0 area; what can differ is the blend order between soft edges
   of different templates, and a far object behind a core pixel (alpha 0.5..1) is hidden instead of showing through
   (1 − alpha). Trunks write depth (the original's ZWRITE 1 around the trunk list). Impostors keep ZWRITE 0 (drawn
   first, far → near per template, `renderOrder −1`).
2. Order: far → near inside each (template, bucket), templates in first-use order; impostors per template, not in
   the original's texture runs.
3. **Sway is not ported**: 31 templates (`Misc/level/Swing.con`) rotate their render matrix within swayLodDistance
   through a per-instance controller (inst+0x120 → globals 0x911cd0 / 0x911cd4 → FUN_004d8d40 / FUN_0049e930 /
   FUN_005d5940) whose math is still undecoded; those trees are static.
4. **Spectators / animals** are drawn in the skin's bind pose (no `.baf` animation, no look-at-car): the `.ske`
   composition and the `.baf` quaternion order are unresolved (standardmesh.md §9).
5. The ObjectDrawer stops queuing at **4096 objects per frame** (0x6f2cc6); the port draws all (the stats report
   `queued`, which stays far below 4096 on the views measured).
6. Node centre / radius = the placement origin and the scaled bbox's radiusFromOrigin (the drawer node fields
   +0xc/+0x4/+0x8 = centre, r², r; their source is not traced).
7. The impostor pass sets no texture filter (it inherits); the port uses linear + MIP point like the tree pass.
   StandardMesh filters stay the store default (trilinear) — not traced (standardmesh.md §9.5).
8. `q` = 1 and the HotSpot spline distance from the camera (§3). `treeMesh.enable3D` = on.
9. Skipped data: `Mesh/SoundPole.sm` (the hidden debug proxy of the 15 WorldEnvironmentSound templates, absent from
   the archives); texture `Spec_SkinFW_04_JH` (absent; those materials keep the mesh's own texture name).

## 7. Numbers (headless SwiftShader, 1280×720, chase camera at the start; `tools/orig-objects-shots.mjs`)

| stage | placements | queued | mesh instances | impostors | objects draw calls | objects tris | whole frame calls / tris |
|---|---|---|---|---|---|---|---|
| corsica-1-f | 2 206 | 194 | 166 | 27 | 97 | 22 k | 259 / 56 k |
| hillclimb-1b-f | 11 746 | 398 | 195 | 131 | 61 | 30 k | 227 / 52 k |
| kenya-2-f | 9 450 | 1 005 | 714 | 254 | 103 | 38 k | 209 / 54 k |
| newzealand-2-f | 11 352 | 432 | 296 | 79 | 123 | 50 k | 378 / 93 k |
| iceracing-1-f | 1 219 | 307 | 180 | 54 | 130 | 25 k | 355 / 55 k |
| rallycross-1-f | 2 764 | 705 | 408 | 111 | 83 | 54 k | 222 / 75 k |

Mid-stage worst case seen: hillclimb-1b-f s = 2000 (bonnet) 883 mesh instances + 373 impostors in 58 objects draw
calls, 53 k triangles. Draw calls are bounded by the (template, LOD / sort copy, material group) combinations in view
(one per visible group, independent of the instance count). CPU: `update()` costs 0.5–0.75 ms per frame on the
densest stages (hillclimb-2b-r, 17 894 placements; node, V8), one pass over the instances of the 64 m cells in range.
Screenshots: `artifacts/port/objects/<stage>_chase.png`, side by side with the original Screenshot00001/00008 in
`artifacts/port/objects/compare_families.png`.
