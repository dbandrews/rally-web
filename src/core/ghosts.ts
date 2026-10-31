/**
 * src/core/ghosts.ts — ARCHITECT-OWNED CONTRACT (phase 2, docs/PHASE2_AI.md). Types only.
 *
 * What a race can ghost against, and what the menu lists. Specs: research/formats/ghosts.md. The ghost car itself is
 * produced by the RaceController's ghost region (src/game/race.ts + src/game/ghosts/**, ghosts builder) as
 * CarRenderState objects with id 'ghost' (RaceController.ghostRenderStates); it has no physics and no sound.
 */

/** Which ghost a race plays against (RaceSelection.ghost). Absent = the session/stored best run of this
 *  stage + car, as before phase 2 (`{ source: 'best' }`). `?ghost=0` still hides every ghost. */
export type GhostSelection =
  | { source: 'off' }
  /** The player's own best run for (stage, seed, car). */
  | { source: 'best' }
  /** A shipped team ghost (Misc/teamghosts, 30 files); `id` = GhostListEntry.id. */
  | { source: 'team'; id: string }
  /** A ghost the player saved (SAVE GHOST); `id` = GhostListEntry.id. */
  | { source: 'user'; id: string };

/** One selectable ghost of a stage (menu "Ghost" row, TeamGhost / TaGhostListFrame lists). */
export interface GhostListEntry {
  /** Stable id: `team:<file name>` / `user:<storage key>`. */
  id: string;
  source: 'team' | 'user';
  /** Ghost name (user-typed, or the team driver) and the driver / profile name. */
  name: string;
  /** Original car of the ghost (its `<Car>Ghost` template minus "Ghost"). */
  origCar: string;
  stageId: string;
  /** Total time (s) = the last split. */
  time: number;
  /** ms since epoch (user ghosts), else null. */
  date: number | null;
  /** Can be deleted from the menu (user ghosts only). */
  deletable: boolean;
}
