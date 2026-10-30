/**
 * src/world/stages.ts — OWNED BY THE WORLD BUILDER.
 *
 * Stage catalogue and procedural stage generation: centre spline, road ribbon, heightfield terrain with
 * materials, scenery, pacenotes, environment, and the physics WorldQuery (SIM space) for each stage.
 *
 * REQUIRED EXPORTS (keep these signatures; contracts in src/core/types.ts):
 *   listStages(): StageListEntry[]                       // catalogue, cheap (no generation)
 *   buildStage(id: string, seed?: number): BuiltStage    // { stage: Stage (THREE space), world: WorldQuery (SIM space) }
 *                                                        // deterministic for (id, seed); throws on unknown id
 * 'testpad' must always exist (smoke test uses it): a flat tarmac proving ground (surface patches,
 * slalom, ramps and a banked bowl inside a 1.9 km loop road; the start straight is plain flat tarmac).
 *
 * Module map (all in src/world/):
 *   stageDefs.ts    catalogue + one recipe per stage (layout style, terrain, surfaces, scenery script)
 *   builder.ts      the shared pipeline (layout → centre line → elevation → road → terrain → scenery → notes)
 *   layouts.ts      control-point generators (rally turtle, hillclimb zig-zag, closed-loop templates)
 *   spline.ts       centripetal Catmull-Rom, arc-length resampling, turtle integration, loop closure
 *   centerline.ts   dense centre line: pointAt / tangentAt / project (segment grid + local window)
 *   profile.ts      smoothing, grade limiting, crest / jump / dip profiles
 *   road.ts         road ribbon samples + exact ribbon triangles (physics), grid
 *   terrainGen.ts   noise terrain carved to the road (bed, shoulders, ditches, berms, cut / fill), materials
 *   terrain.ts      exact heightfield queries + DDA raycast
 *   ground.ts       combined ground (ribbon over terrain), obstacles, SIM-space WorldQuery adapter
 *   corners.ts      corner detection; pacenotes.ts  co-driver notes; scenery.ts  placement
 *   environments.ts lighting presets (+ palette extension); noise.ts  seeded Perlin noise
 *
 * Extensions beyond the contract (see the world report's contract requests): Stage objects also carry
 * `labels: { text, pos, rotY }[]` (testpad patch names) and `environment.palette` (ground/foliage colours).
 *
 * Scenery conventions (match the renderer's models: front = local -Z, linear props long along local X):
 *   - SceneryInstance.height is the intended visual height (scale = height / scenery.ts NOMINAL_HEIGHT).
 *   - fence / barrier / banner / snowbank run along the road, front toward it (scenery.ts alongRoadRotY);
 *     houses, tents, grandstands and spectators face the road (-Z toward the centre line).
 *   - 'marker' = corner chevron board on the outside of tight bends, across the line of travel with its +X
 *     (arrow) pointing into the bend (chevronRotY); 'post' = white marker posts along the stage edge.
 *   - gates: one 'startGate' (closed stages: the start/finish line at s = 0), 'checkpointGate' at every
 *     checkpoint of point-to-point stages, 'finishGate' at finishS; all on the centre line, radius 0.
 *   - every instance with radius > 0 is an obstacle (WorldQuery.obstaclesNear) and stands >= 3 m beyond
 *     the nearest road edge (more on fast sections); decoration (radius 0) keeps >= 0.6 m off the ribbon.
 */
import type { BuiltStage, StageListEntry } from '../core/types';
import { buildProcStage } from './builder';
import { catalogueEntry, RECIPES, STAGE_ORDER } from './stageDefs';
import { buildPortedStage } from './portedBuilder';
import { PORTED_META, PORTED_ORDER, PORTED_RECIPES } from './portedDefs';

export type { StageLabel } from './builder';
export type { WorldEnvironment, EnvironmentPalette } from './environments';

function portedEntry(id: string): StageListEntry {
  const m = PORTED_META[id];
  return {
    id: m.id,
    name: m.name,
    discipline: m.discipline,
    description: m.description,
    defaultTyre: m.defaultTyre,
    approxLength: m.approxLength,
    closed: m.closed,
    laps: m.laps,
  };
}

export function listStages(): StageListEntry[] {
  return [...STAGE_ORDER.map(catalogueEntry), ...PORTED_ORDER.map(portedEntry)];
}

export function buildStage(id: string, seed = 1): BuiltStage {
  const s = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 1;
  const recipe = RECIPES[id];
  if (recipe) return buildProcStage(recipe(), s);
  const ported = PORTED_RECIPES[id];
  if (ported) return buildPortedStage(ported(), s);
  throw new Error(`unknown stage '${id}' (known: ${[...STAGE_ORDER, ...PORTED_ORDER].join(', ')})`);
}
