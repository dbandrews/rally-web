/**
 * src/game/selection.ts — the race-selection rules main.ts applies when it boots and loads (pure; unit-tested in
 * tests/game/selection.test.ts):
 *
 *  - normalizeCarSelection: an original car (RaceSelection.car, ORIG_CAR_IDS) fixes the handling archetype to its drive
 *    layout's (presets.ts origCarArchetype); an unknown name is dropped (the archetype car stays).
 *  - withDefaultOrigCar: without `?car=`, the original's default car (ORIG_DEFAULT_CAR) once its `cars` part is built.
 *  - originalStagesFirst: the stage catalogue with the original stages whose render (`track`) and `collision` parts
 *    are built first, in the ported catalogue order (PORTED_ORDER; its first, corsica-1-f, is also the first entry of
 *    the original's Misc/level/track.lst), then the procedural class stages and any unbuilt ported ones; null without
 *    a built original stage (no assets, `?orig=0`).
 */
import type { AssetManifest } from '../core/assets';
import { isPortedStageId, manifestHasStagePart } from '../core/assets';
import { isOrigCarId, ORIG_DEFAULT_CAR } from '../core/constants';
import type { RaceSelection, StageListEntry } from '../core/types';
import { origCarArchetype } from '../sim/presets';

/** Stage parts an original stage needs to be listed first / be the default: the render mesh and the collision mesh. */
export const ORIG_STAGE_PARTS = ['track', 'collision'] as const;

/** An original car fixes the handling archetype to its drive layout's; unknown names are dropped. */
export function normalizeCarSelection(sel: RaceSelection): RaceSelection {
  if (sel.car === undefined) return sel;
  if (!isOrigCarId(sel.car)) {
    const { car: _drop, ...rest } = sel;
    void _drop;
    return rest;
  }
  return { ...sel, archetype: origCarArchetype(sel.car) ?? sel.archetype };
}

/** `sel` in the original's default car when no car was asked for (`carFromUrl`, sel.car) and its cars part is built. */
export function withDefaultOrigCar(sel: RaceSelection, manifest: AssetManifest | null, carFromUrl: boolean): RaceSelection {
  if (carFromUrl || sel.car || !manifest || !(manifest.carParts[ORIG_DEFAULT_CAR] ?? []).includes('cars')) return sel;
  const archetype = origCarArchetype(ORIG_DEFAULT_CAR);
  return archetype ? { ...sel, car: ORIG_DEFAULT_CAR, archetype } : sel;
}

/** The catalogue with the built original stages first (see the header); null when none is built. */
export function originalStagesFirst(stages: readonly StageListEntry[], manifest: AssetManifest | null): StageListEntry[] | null {
  if (!manifest) return null;
  const built = stages.filter((e) => isPortedStageId(e.id) && ORIG_STAGE_PARTS.every((p) => manifestHasStagePart(manifest, e.id, p)));
  if (!built.length) return null;
  const first = new Set(built.map((e) => e.id));
  return [...built, ...stages.filter((e) => !first.has(e.id))];
}
