/**
 * src/game/ghosts/team.ts — GHOSTS BUILDER. The shipped team ghosts (30 files of Misc/teamghosts, the "Original Racing
 * Game Team" drivers' best runs; research/formats/ghosts.md §2.4, §8), delivered by the `ghosts` asset part
 * (tools/assets/parts/ghosts.py): global/ghosts.json = the index, global/ghosts/<file>.bin = the original files byte for
 * byte (v2.0 incl. the 20-byte trailer). 26 of the 48 stages have at least one; the 22 others list none.
 *
 * Without the asset part (CI, tests, a fresh clone, ?orig=0) the index is empty and nothing is fetched.
 */
import { fetchArrayBuffer, fetchJson, getAssetManifest } from '../../core/assets';
import { parseGhost, type GhostFile } from './format';

export interface TeamGhostEntry {
  /** The original file name, e.g. "AndersC_Hillclimb2Cr". */
  file: string;
  stageId: string;
  /** The team member (the file name's prefix) and the name stored in the file ("scav1:18"). */
  driver: string;
  name: string;
  /** Original car (the file's `<Car>Ghost` minus "Ghost"). */
  car: string;
  /** Total time (s, the last split). */
  time: number;
  splits: number[];
  frames: number;
  bytes: number;
}

export interface TeamIndex {
  version: 1;
  ghosts: TeamGhostEntry[];
  /** stage id -> Game.createTrack's H for ALL 48 stages (the world y offset the ghost states use). */
  heights: Record<string, number>;
}

const FILE_RE = /^([A-Za-z]+)_([A-Za-z]+?)(\d)([abc]?)([fr])$/i;

/** `AndersC_Hillclimb2Cr` -> `hillclimb-2c-r` (null for anything else). Mirrors tools/assets/parts/ghosts.py. */
export function teamFileStage(file: string): string | null {
  const m = FILE_RE.exec(file);
  if (!m) return null;
  return `${m[2].toLowerCase()}-${m[3]}${m[4].toLowerCase()}-${m[5].toLowerCase()}`;
}

export const teamGhostId = (file: string): string => `team:${file}`;
export const teamFileOfId = (id: string): string | null => (id.startsWith('team:') ? id.slice(5) : null);

let indexPromise: Promise<TeamIndex | null> | null = null;

/** The index (cached). null without the asset part. Never rejects. */
export function loadTeamIndex(): Promise<TeamIndex | null> {
  if (!indexPromise) {
    let p!: Promise<TeamIndex | null>;
    p = (async () => {
      try {
        const m = await getAssetManifest();
        if (!m || !m.global.includes('ghosts')) return null;
        const j = await fetchJson<TeamIndex>('global/ghosts.json');
        return j && j.version === 1 && Array.isArray(j.ghosts) ? j : null;
      } catch {
        if (indexPromise === p) indexPromise = null; // a fetch error is retried next time (an absent part stays cached)
        return null;
      }
    })();
    indexPromise = p;
  }
  return indexPromise;
}

/** The team ghosts of one stage, fastest first. */
export async function teamGhostsOf(stageId: string): Promise<TeamGhostEntry[]> {
  const idx = await loadTeamIndex();
  return (idx?.ghosts ?? []).filter((g) => g.stageId === stageId).sort((a, b) => a.time - b.time);
}

const fileCache = new Map<string, Promise<GhostFile | null>>();
/** Parsed files already loaded (so a race can start synchronously from the cache). */
const ready = new Map<string, GhostFile>();

/** Fetch and parse one team ghost (cached; null when missing or corrupt). Never rejects. */
export function loadTeamGhost(file: string): Promise<GhostFile | null> {
  let p = fileCache.get(file);
  if (!p) {
    p = (async () => {
      try {
        const g = parseGhost(new Uint8Array(await fetchArrayBuffer(`global/ghosts/${file}.bin`)));
        ready.set(file, g);
        return g;
      } catch {
        return null;
      }
    })();
    fileCache.set(file, p);
    void p.then((g) => {
      if (!g) fileCache.delete(file); // retry next time
    });
  }
  return p;
}

/** The ghost file already loaded, without waiting. */
export function cachedTeamGhost(file: string): GhostFile | null {
  return ready.get(file) ?? null;
}
/** Warm the cache for a selection (the menu calls this when a team ghost is picked). */
export function warmTeamGhost(file: string): void {
  void loadTeamGhost(file);
}

/** Test hook: forget the cached index and files. */
export function resetTeamGhostCache(): void {
  indexPromise = null;
  fileCache.clear();
  ready.clear();
}
