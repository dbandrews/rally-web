# Collision: the original Track.gcm as the physics ground

Owner: the collision builder. Spec: `research/formats/gcm.md` (§1-§4, §9 and its Verification section, which
overrides the body), `research/formats/objects.md` §1.3 / §7.3 / §8 (placements and proxies). Reference code:
`tools/assets/lib/formats/fmt_gcm.py` (`Gcm.raycast` with slots, the faithful Python port).

| piece | file |
|---|---|
| build step (per stage) | `tools/assets/parts/collision.py` → `public/assets/stages/<id>/collision.{bin,json}` |
| RCOL reader | `src/world/orig/rcol.ts` |
| literal query port | `src/world/orig/gcm.ts` (`GcmGrid`) |
| mesh `WorldQuery` | `src/world/orig/world.ts` (`OrigWorld`) |
| object proxies (cylinders: hints) | `src/world/orig/obstacles.ts` (`OrigObstacles`) |
| object collision meshes + the 0x597810 query port | `src/world/orig/objectMeshes.ts` (`OrigObjectMeshes`) |
| the object pass (car side) | `src/sim/car.ts` `objectPass` + `bodySolver(dt, true)` |
| wiring | `src/world/orig/index.ts` (`attachOriginalWorld`, `loadOrigWorld`, `stageFrameFit`) |
| tests | `tests/world/origGcm.test.ts` (synthetic, always runs), `origCollision.test.ts` (built part + goldens), `origTrace.test.ts` (recorded original), `objectMeshes.test.ts` (the object-mesh query vs the original in unicorn), `tests/sim/objectPass.test.ts` (the object solver vs the original in unicorn, the pass on box meshes), fixtures `tests/world/fixtures/orig/`, `tests/sim/fixtures/` |

## 1. Data: `collision.bin` ('RCOL' v2; v1 files still load)

Built from **`Mesh/Track.gcm` only**. The game loads `TrackFull.gcm` only with the `fullCollision` cvar,
which defaults to 0 and is never set by a shipped `.con` (gcm.md §1, §5). TrackFull is a dev variant: on
rallycross1/2 every face is −1, so it gives no contact anywhere.

The file holds the arrays the original query reads, **unchanged and in file order**. The exact layout is in the
`collision.py` docstring.

* `V` (f32), `I` (u16, since nV ≤ 65 536 in every Track.gcm), `M` (the raw material byte), `FN` (the
  **stored** face normals, bit-exact, including the inert (0,0,0) ones).
* The 256 × 256 **top-cell lists** (`cellList`, u16 block ids, each list ended by 0xffff). `cellStart` is not
  shipped: in every Track.gcm it is exactly the prefix of the terminators. The build asserts this, and the
  reader rebuilds it.
* Every block, kept as it is: the box (bmin/bmax) and the stored f32 `invX`/`invZ`, the sub-grid dim, `use16` +
  `base`, its sub-cell offsets, and its u16 or u32 face lists in the original list order.
* The object proxies (§4) and the hull points of the loose parts.
* v2: the static objects' own collision meshes (§4): each used CollisionMesh.Simple once (vertices, and per
  triangle the stored normal + 3 indices + pad of its 32-byte BSP record, the data the query 0x597810 reads), and
  one instance per hard object part (transform with the scale, render box, bounding radius, collisionMaterial).
  A v1 file has none; the car then uses the cylinder stand-in.

The query needs both the original top-cell lists and the original list order. The non-vertical walk visits
top cells, and a cell's list can name neighbouring tiles first. "First hit" is not "nearest" on cliffs. A tile
DDA or a nearest-hit search is not equivalent (gcm.md §3.4, §9 caveat).

All 48 stages build in about 10 s (`npm run assets -- --parts collision --stages all`). Over all 48 stages the
files are 133 MB raw (v1: 117 MB); the object-mesh instances add 10.5 MB (82 190 × 128 B), the meshes themselves
are a few kB per stage.

## 2. The query: a literal port (`gcm.ts`)

| original | port | notes |
|---|---|---|
| Grid vtbl+0xc **0x595c50** | `GcmGrid.segment` | `invX/Z = f32(dim / (max − min))`. Near-vertical (`rx² + rz² ≤ f32(0.05f·0.05f)`, the exe's bresenhamLimit² at 0x91ba1c) → one cell `trunc((o − min)·inv)`. Otherwise a Cohen-Sutherland clip to the bbox (FUN_00593be0 / 593ac0) + supercover Bresenham over the top cells (FUN_00593e10, start → end, both corner cells on a tie). Cells outside [0, dim) are skipped. Block ids are taken in cell-list order. 0x595eb5: another block → forget the face. Hit → `lastBlock = bid`. Miss → `lastBlock = −1` (0x595f32). |
| **FUN_00594330** | `GcmGrid.blockQuery` | Vertical: half-open xz box `bmin ≤ o < bmax` (y not tested). Otherwise a clip + Bresenham over the sub-grid. The **unclipped** segment end is tested. The slot's cached face is tested first in every visited sub-cell, then the sub-cell list. The **first** hit wins (`lastFace = f`). Miss → `lastFace = −1` (0x594b41). |
| **FUN_00595020** | `GcmGrid.tri` | `d1 = dot(end − v0, n) > 0` → miss. **`d0 ≤ 0` → miss** (a start on the plane misses). `da ≥ 0` → miss (one-sided). `t = −d0/da`. Axis choice `|n.y| ≥ 0.7f` → (x, z), `|n.z| > 0.3f` → (x, y), else (y, z) (f32 literals 0x8066f4 / 0x8066f8). `e2` and `e3` are compared **only with `e1`**, so `e1 == 0` accepts (the quirk is kept). depth = d1, cos = dot(n, ray) with the unnormalised ray, material = the raw byte. |
| lastBlock / lastFace 0x916be8 / 0x911dc8 | `Int32Array(5000)` per grid | One grid per stage world, slots shared by every car (wheel `w + 24·car`, hull `8 + i + 24·car`). `resetFaceCache()` = the ctor's −1 fill. |

There is no allocation per query: the walks use preallocated buffers and the hit goes into a reused `GcmHit`.
`OrigWorld.segment(o, ray, slot, out)` writes it into the caller's `RayHit` when `out` is given (CarSim passes one
scratch hit for its wheel and hull segments: no allocation on the hot path); without `out` it returns a fresh one.
`segmentViaRaycast` (procedural / ported fallback worlds) does the same and asks the world's `raycast` to fill a
module scratch (`ground.ts` / `portedBuilder.ts` do).

**Precision (deviation, documented).** The port computes in float64 on the file's float32 values, in the
reference's operation order. It reproduces `fmt_gcm.py` bit for bit (§6). The running original computes on the
x87 FPU (D3D normally switches it to 24-bit precision), so its c0 / c4 differ from ours by float rounding:
max |Δc0| 3.7e-5 m and max |Δc4| 2.3e-4 over the 1.21 M recorded rays. On exact edge ties a different
neighbouring face can win (16 of 1.13 M rays have a normal more than 1e-4 off, all with the same material).
Hit/miss and material agree on every recorded ray.

## 3. The mesh `WorldQuery` (`world.ts`)

* `segment(o, ray, slot)` is the port above. Every `RayHit` field is set: `dist = t·|ray|`, `t`, `depth`, `cos`,
  `origMaterial` (raw byte), `material = materialFromOrig(byte)` (`ORIG_MATERIAL_TO_MATERIAL`; the raw byte
  is never used as a rally-web id), `face`. The normal is the stored flat face normal. The original never
  smooths for physics (gcm.md §3.1).
* `raycast(o, dir, max)` = `raycastViaSegment` = `segment(o, dir·max, −1)`. An origin below the ground is a
  **miss**, never a dist-0 hit. Off the mesh nothing is hit: the car falls, and the race's §5.4 reset catches it.
* `heightAt / normalAt / materialAt / surfaceAt (x, z, yHint?)` use every front-facing face (n.y > 0) over
  (x, z): the faces of the blocks whose half-open box holds the point, from that top cell's list. The test is
  edge-inclusive xz containment against the face plane through v0 with the stored normal, which is the plane
  `segment` hits. The level is picked by `pickGroundLevel`: without `yHint` the highest; with it the highest at
  or below yHint + 1 m, else the lowest above. The last point is memoised, because heightAt → normalAt →
  materialAt usually ask the same point. Off the mesh these queries return the procedural world's answer, so
  they never return NaN.
  Example: on the corsica-3-f overpass at s 3938 there are levels 78.03 / 83.98 / 87.47. `heightAt` = 87.47
  (the deck), `heightAt(…, 78)` = 78.03 (the road under it), and a wheel ray from 0.5 m above the road hits 78.03.
* `obstaclesNear` returns the HARD proxies (§4): hints (the autopilot) once object meshes exist.
  `objectCollidersNear` (v2 files only) returns the object colliders the car collides with (§4). Extras:
  `partsNear` (the loose parts with their hulls), `softNear` (bushes), `onMesh`, `origMaterialAt`, `resetFaceCache`.
* `attachOriginalWorld(built)` returns `{ stage, world: OrigWorld }` when the manifest lists `collision` for the
  stage. Otherwise, with `?collision=0`, or on any failure (one `warnOnce`), it returns `built` unchanged. The
  parsed arrays of the last 2 stages are kept, so a restart does not fetch again; the world (and its face
  cache) is new for each load.

## 4. Static objects: the original's object pass on the objects' own collision meshes

Built from `Objects.con` + the object library (`fmt_objects` resolver, child templates followed), in sim
space: `sim = world − (2048, H, 2048)`, `v = v_local·diag(s)·R + pos`, `R = Rz·Rx·Ry`. There are three classes:

| class | which objects | physics | served by |
|---|---|---|---|
| HARD (82 194 parts, 82 190 with a shape: 4 have `Object.geometry.scale 0/0/0`) | `hasCollision 1` + a mesh with a `CollisionMesh.Simple` (trees, rocks, signs, fences, curbs, walls, houses) | **the object's own collision mesh** under its transform, queried by the car's hull segments as the original does (below) | `objectCollidersNear` (car) + `obstaclesNear` (cylinder hints) |
| DYNAMIC (6 559) | `PhyObject` loose parts: cones, plastic walls, sign boards, barrels | the `.col` hull points (8 / 12 / 18-point convex hulls, gcm.md §6) transformed to sim space, + mass and `collisionMaterial`, kept on the record (`OrigObstacle.hull/mass/yaw`) | `partsNear` only |
| SOFT (13 858) | `hasCollision 1` **without** collision geometry (bushes `nzbushD`, `cobushD`, …) | the render bbox footprint (min half extent): the bush flag only | `softNear` only |

### 4.1 What the original does [V asm, executed where marked]

The game loop runs the object pass after every physics substep (FUN_0049ffe0 → FUN_004a7980 → FUN_004a7bc0 per car):

1. **Candidates** (0x4a7cdb, 0x4a7d51, game+0x940 = 16 set at 0x484143): every 16 substeps car k (k < 4; at counter
   4k) refreshes its list with the objects within 16·0.25 m + the car's radius of the car's bounding centre; the list
   is sorted by pointer (descending). Cars ≥ 4 never refresh.
2. **Gate** (0x4a7f1c-0x4a811a), static objects — the colour component picks the branch. `getComponent` (the colour
   hash, [geometry vtbl+8] → the 0xa5c048fc interface) answers non-zero only on a TreeMesh instance (its QI 0x5901b0;
   StandardMesh 0x586e10 and AnimatedMesh 0x57fc00 answer 0; objects.md §3: colour only on TreeMesh placements):
   - **TreeMesh** (0x4a8008): tested only while the 3-D distance from its ORIGIN to the car's bounding centre is
     ≤ 0.2·radius + 1.5 (radius = object +8, half the scaled render box diagonal = the MergeObjects tree leaf radius;
     0x7fc78c, 0x8070d0) — the trunk gate, so a tree is tested only near its trunk.
   - **every other object** (StandardMesh: fences, railings, walls, signs, houses; 0x4a8049): tested while its
     bounding sphere touches the car's — the distance from its box CENTRE (object +0xc/+0x10/+0x14) to the car body
     object's centre (+0xc..+0x14) is ≤ radius + the car's radius (car object +8). A long railing piece is therefore
     tested along its whole length, not only near its origin (which sits at one end of the panel).
   In both branches the render box corners must not be all outside one face plane of the car's box
   (FUN_005d5ef0 / 5f90 / 5fe0).
3. **FUN_006d1a80**: for EVERY hull point (body+8 = 12, no scheduling) the segment from the previous COM
   (B+0xd8) to the point goes through the physics callback physics+0x8c (0x677c30) → the mesh instance's query
   0x5912a0 (it composes diag(geometry scale)·R + pos at 0x591c20, so scaled objects collide scaled) →
   CollisionMesh.Simple's query **0x597810** (slot −1). A hit is a contact when depth < 0.01 and fewer than 4 contacts
   so far; its material is `collisionMaterial` when 0..22, else 1 (ASPHALT). The contacts accumulate exactly as the
   ground hull contacts (gcm.md §3.6: push direction, depth-weighted point, mean depth, smallest material, 0x40).
   A zero push direction ends here.
4. **FUN_006d21c0**: the body solver FUN_006d0970 (MECHANICS_SPEC §2.9) on that contact, with its own anchor
   timer B+0x138 (the anchor memory is shared) and the friction impulse clamped to ±1000 per component before it
   reaches the velocity [V executed: `tests/sim/fixtures/bodySolverObjCases.json`, 150 states in unicorn, 16 where
   the clamp changes the result]. It also runs (timer, B+0x19c = 0) when no hull point touched.
5. **Record** (0x4a81a3-0x4a81e8): a contact sets the car record's object hit, `collisionMaterial` (raw) and
   B+0x19c (CarTelemetry.collision.objectHits / objectType / objectStrength).

   *Continuous contact* [E 0x4a81a3-0x4a81e8 + sound.md Port findings 5]: the record is written on EVERY substep that has a hull contact
   (the object pass runs per substep), and the flag stays set until the sound reader clears it (per frame, 0.5 s gate, strength >= 165
   to be audible). `CarTelemetry.collision.objectHits` therefore counts contact SUBSTEPS (a car pinned against a rail counts 1 per
   substep, ~100 in 1.3 s); the audio latches a change once per frame, exactly the original's set-every-substep / clear-per-frame
   behaviour. A pinned car at 2-4 km/h has jn well under 265 N*s (strength < 165), so it is silent. It is not a defect.
   The original has no reset for a car lying on its side other than the race rules (upside down 2.5 s, race.md 9a.4).

   *Pass-through audit of the QA railing matrix* [D]: all 48 browser runs (`artifacts/qa2/railings/matrix/results.json`, 6 stage
   families, Micra / Impreza / Audi, 40-140 km/h, glancing, head-on, reversing): every consecutive pair of trace positions (0.125 s)
   was tested at 4 heights against every triangle of every instance within 60 m (instance transform as `objectMeshes.ts`, the
   stage's z mirror taken from the hit points): 0 crossings. The two reverse-run "suspects" are geometry, not pass-through:
   rallycross-1-f's `RCconcwallMiddle` chain (4-5 m pieces, x -232..-213) STARTS at x -212.7, the car went round its end and was
   stopped by the chain's outer face (54 -> 10 km/h in 0.125 s); newzealand-1-f's `kn_riotfence_01` is a 10-panel cluster
   (2.3 m panels) whose nearest panel is >= 6.1 m from the car's path.

**0x597810** (`objectMeshes.ts`, [V executed: `tests/world/fixtures/orig/objmesh_cases.json`, 720 segments on 12 real
meshes / placements, the BSP gather stubbed to hand over every triangle]): the segment goes into the mesh's local
frame (general inverse 0x5d53b0); its AABB (which also contains the local origin, 0x4bb630 starts from 0,0,0) must
touch the mesh's vertex AABB; per triangle n = −(stored normal) (the records store inward normals), `dE = (E−v0)·n
> 0` → skip, `d0 ≤ 0` → skip, `D·n ≥ 0` → skip, the Grid's axis choice and edge tests (c2/c3 compared only with
c1); of the accepted triangles the **deepest end (smallest dE)** wins. Out: normal n·M (NOT re-normalised on a
scaled object), point H·M + T, depth dE in the local frame, the cos output untouched.

### 4.2 The port and its deviations

* `src/sim/car.ts objectPass` runs after each `step` on worlds with `objectCollidersNear` (RCOL v2): steps 1-5
  above. `obstacleCollision` (the [D] cylinders) then does nothing; it stays for procedural stages and v1 files.
* [~] The car's box, radius and centre come from its hull points (the original: the car geometry's box, object +8
  / +0xc). The candidate order is by placement index (the original: pointer order). A reset refreshes the list at
  once (the original's is stale by ≤ 16 substeps). The query visits every triangle in file order, not the BSP's
  leaf list (only an exact dE tie could differ).
* The telemetry keeps the ground pass's `hull` / `hullStrength` / `bodyOnGround` (the original's FUN_006d1a80
  overwrites the shared body fields; nothing reads them before the next substep recomputes them).
* The cylinders (`obstaclesNear`, `collision.py`): a compact footprint (aspect ≤ 1.25, half ≤ 6 m) is one cylinder
  of the footprint's larger half extent (not its corner radius); every other hard footprint above 0.6 m (fence
  panels, barriers, boards, curbs, buildings) a chain of 0.3 m cylinders along its edges. Over the 48 stages the
  single-cylinder fence / barrier / sign proxies reaching > 0.5 m into the road ribbon went from 1 319 to 28
  (`artifacts/qa/fix-world-sim/intrusions-after.json`).

Indexed in a 16 m spatial hash (objects.md §8 suggests a 16 m grid). The hash is used rather than a dense grid
so that stray coordinates cannot blow up the allocation.

**Deviations / open.**
* Loose parts are **not** collided. In the original they are light rigid bodies (a 10 kg cone) that the car
  knocks over (FUN_006d4390). Knock-over physics + visuals need a dynamic-body contract (contract request, sim /
  objects builders). The hulls and masses are ready on the records.
* Flag-only bushes are not obstacles. The original has no geometry to hit; the object pass sets the bush flag
  (MECHANICS_SPEC §2.7).
* 10 placements are dropped: 5 `truck3` instances × f/r in hillclimb3b/3c and iceracing3, editor debris at
  ~1e7 m (`FAR_LIMIT`, `stats.farDropped`).
* Walls, rock faces and overhangs are **not** proxies. They are steep ground faces of Track.gcm, and the
  hull segments hit them (gcm.md §3.6, §9).
* Example (kenya-1-f s 1517, the riot-fence line at lateral +4.9..5.0): the car teleported to lateral 3.0..3.9 now
  stays there (the old 1.4-1.6 m cylinders pushed it back to 2.65), and driven into the fence it stops with its
  centre at ≤ 4.41 m (`artifacts/qa/fix-world-sim/kenya1f-fence-{before,after}.png`).

## 5. Stage frame check (safety net for a contract mismatch)

The gcm, the AI splines and the object placements are in the original sim frame. rally-web sim is the same
frame and three = (x, y, −z) (ASSETS.md §3 "Frames"). Until 2026-10-29 23:31 the ported stages
(`src/world/portedBuilder.ts`, race builder) fed the spline's raw (x, z) into the **three-space** centre
line. In sim space the whole stage was then the original **mirrored in z**: left and right turns were swapped,
and the stage did not line up with the track / objects renderers, which emit (x, y, −z).

`attachOriginalWorld` measures the alignment with `stageFrameFit`: 96 road samples over the raced section,
tested in both frames (on the mesh, |dy| < 2 m).

* Road on the mesh in the contract frame: the world is used as is (the target state).
* Road only fits z-mirrored: the world serves the mesh **mirrored** (`OrigWorld` `mirrorZ`: query inputs and
  outputs have z negated at the API boundary, and the proxies are decoded mirrored), and it warns once:
  `stage <id> is z-mirrored against the original collision mesh …`. A reflection keeps every dot product, so
  one-sidedness, t, depth, cos, the traversal order and the face cache are exactly the original query on the
  mirrored segment. Physics then matches the stage's road, so the game stays playable.
* Neither frame fits: a warning, and the contract frame is used.

Status: the race builder fixed the stages (three = (x, y, −z) of the CVs). **All 48 stages now fit the contract
frame**: 99–100 % of the road lies on the mesh as sim, against 0–71 % mirrored. So `mirrorZ` is off everywhere
and nothing is logged. Before the fix, every stage fitted only mirrored (100 %) and was served through this path.
`origCollision.test.ts` asserts the contract frame on every built stage. The mirror path stays as a guarded
fallback, with unit tests (`origGcm.test.ts`).

## 6. Verification

* **Golden rays** (`tests/world/fixtures/orig/gcm_golden_<stage>.bin`, generator `gen_gcm_golden.py`
  (deterministic, rerun reproduces the files byte for byte), Python reference `fmt_gcm.Gcm.raycast` with slots):
  about 3 600 rays per stage on corsica-2-f, hillclimb-1c-f, newzealand-3-f, kenya-1-f, rallycross-1-f and
  iceracing-3-f. Ray kinds:
  * vertical drops;
  * cliff faces;
  * tilted 0.75 m wheel rays up to 45° in moving 4-wheel sequences with slots (Bresenham path);
  * hull segments COM → 12 points with slots 8..19;
  * long rays in any direction, including outside the bbox;
  * exact-vertex starts (`e1 == 0`, `d0 == 0`);
  * face-cache sequences where the cache decides between stacked faces.

  The set covers 13 664 non-vertical rays, 292 rays where the first hit ≠ the nearest and 122 where the cache
  changed the result. **The TS port reproduces every ray exactly**: hit/miss, face, t, depth, cos, raw
  material and the hit point, all bit-identical.
* **The running original** (`tests/world/origTrace.test.ts`, Frida traces `research/frida/traces/run{1,2}.bin`,
  rallycross1, offset (2048, 10, 2048), per-wheel slots). Every recorded wheel ray is replayed: **run1 84 480 and
  run2 1 127 712 rays** (296 304 tilted). Hits and misses agree on every ray (1 210 333 / 1 859), and the material
  agrees on every hit. Max |Δc0| is 3.1e-5 / 3.7e-5 m, max |Δc4| 2.6e-6 / 2.3e-4, max |Δn| 7.5e-4 / 2.2e-2. The
  replay statistics equal the Python replay (`artifacts/re/gcm/trace_run{1,2}.json`) field by field. run2
  (1.7 GB) runs with `RALLY_GCM_FULL_TRACE=1`. A 6 000-ray window is also a fixture
  (`gcm_trace_rallycross1.bin`, in `origCollision.test.ts`).
* **Speed** (node, `origCollision.test.ts` "query cost"), measured on corsica-2-f / hillclimb-1c-f /
  newzealand-3-f / kenya-1-f / rallycross-1-f / iceracing-3-f:

  | query | ns per query |
  |---|---|
  | vertical wheel ray | 251–422 |
  | tilted wheel ray (with the per-wheel cache) | 227–420 |
  | hull segment | 385–773 |
  | `heightAt` | 111–245 |

  The budget is 5 µs. One car costs 16 segments × 120 Hz ≈ 1 ms of CPU per second.
* **In the game** (headless, `tools/drive.mjs --autopilot --stepped`, contract frame, after the race builder's
  fix). The original mesh world was attached on every run, with 0 console errors and 0 warnings. The runs were
  repeated before the fix through the mirror path, with the same results.
  * rallycross-1-f, 40 s: wheels on tarmac and gravel. kenya-1-f, 60 s: sand. hillclimb-3a-f: snowAsphalt
    (the original SNOWWET road). corsica-2-f: tarmac with gravelGrass / grass verges.
  * All runs: minimum clearance 0.39–0.45 m, no fall-through, no flips. The procedural world gives "gravel"
    on corsica-2 and "snow" on hillclimb-3a.
  * corsica-2-f and hillclimb-3a-f each show one auto reset **at the start line**. It is also there with
    `?collision=0`: the race builder's spawn s lies before the valid range.
  * Off the corridor (teleported beside the road where Track.gcm has no faces: corsica-2-f s 4025 / −26 m,
    kenya-1-f s 3052 / −14 m, hillclimb-3a-f s 2619 / +26 m), the car loses all contacts, falls, and the
    hand-of-god reset puts it back on the centre line 0.5–0.6 s later. With `?collision=0` the procedural
    ground holds it there.

## 7. Contract notes for other builders

* **race**: ported stages use three = (x, y, −z) of the spline CVs (§5, done). `liftAboveGround`
  (`src/game/stageMath.ts`) should pass `pose.pos.y` as `yHint`; without it, a reset under the corsica-3
  overpass lifts the car onto the deck.
* **main.ts probe** (`clearance`, line ~734): pass `t.posSim.y` as `yHint` on multi-level ground.
* **sim**: done on your side. The wheels and hull use `segment` with `wheelSlot` / `hullSlot`. Keep `slotBase` =
  24·carIndex for AI cars (slots < 5000).
* **objects / sim**: a dynamic-body hook for `partsNear` (cones, signs, barrels knocked over), §4.

## 8. Rebuild / regenerate

```
npm run assets -- --parts collision --stages all          # ~10 s, all 48 stages
.venv/bin/python -I tests/world/fixtures/orig/gen_gcm_golden.py   # goldens + the trace window (~10 s)
<venv with unicorn>/bin/python -I tests/world/fixtures/orig/gen_objmesh_cases.py original_version/original_desktop_version.exe \
    public/assets/stages/kenya-1-f tests/world/fixtures/orig/objmesh_cases.json 60 3     # 0x597810 in unicorn
<venv with unicorn>/bin/python -I tests/sim/fixtures/gen_body_obj_cases.py original_version/original_desktop_version.exe \
    tests/sim/fixtures/bodySolverObjCases.json 150 11                                   # FUN_006d21c0 in unicorn
npx vitest run tests/world/orig                            # synthetic + built-part + recorded-trace tests
RALLY_GCM_FULL_TRACE=1 npx vitest run tests/world/origTrace.test.ts   # + run2 (1.13 M rays)
```
