/**
 * src/game/bestTimes.ts — game builder. Best run per stage (+ seed) and car archetype, persisted in
 * localStorage (memory fallback). The ghost track of the best run is stored under its own key.
 *
 * Key scheme (also read by src/ui/menu.ts to show the best time; keep in sync):
 *   rally-web:best:v2:<stageId>:<seed>:<archetype>        → BestRecord JSON
 *   rally-web:ghost:v2:<stageId>:<seed>:<archetype>       → encodeGhost() JSON
 */
import type { ArchetypeId } from '../core/types';
import { decodeGhost, encodeGhost, type GhostTrack } from './ghost';
import { readJson, writeJson, type KeyValueStore } from './storage';

export interface BestRecord {
  v: 1;
  time: number;
  splits: number[];
  archetype: ArchetypeId;
  /** ms since epoch. */
  date: number;
  resets: number;
}

export const bestKey = (stageId: string, seed: number, archetype: string): string =>
  `rally-web:best:v2:${stageId}:${seed}:${archetype}`;
export const ghostKey = (stageId: string, seed: number, archetype: string): string =>
  `rally-web:ghost:v2:${stageId}:${seed}:${archetype}`;

export class BestTimes {
  readonly store: KeyValueStore;
  constructor(store: KeyValueStore) {
    this.store = store;
  }

  load(stageId: string, seed: number, archetype: string): BestRecord | null {
    const r = readJson<BestRecord>(this.store, bestKey(stageId, seed, archetype));
    if (!r || r.v !== 1 || !Number.isFinite(r.time) || !Array.isArray(r.splits)) return null;
    return r;
  }

  save(stageId: string, seed: number, rec: BestRecord): void {
    writeJson(this.store, bestKey(stageId, seed, rec.archetype), rec);
  }

  loadGhost(stageId: string, seed: number, archetype: string): GhostTrack | null {
    return decodeGhost(this.store.getItem(ghostKey(stageId, seed, archetype)));
  }

  saveGhost(stageId: string, seed: number, archetype: string, g: GhostTrack): void {
    if (g.count < 2) return;
    this.store.setItem(ghostKey(stageId, seed, archetype), encodeGhost(g));
  }

  clear(stageId: string, seed: number, archetype: string): void {
    this.store.removeItem(bestKey(stageId, seed, archetype));
    this.store.removeItem(ghostKey(stageId, seed, archetype));
  }
}
