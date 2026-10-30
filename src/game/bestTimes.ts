/**
 * src/game/bestTimes.ts — game builder. Best run per stage (+ seed) and car, persisted in localStorage
 * (memory fallback). The ghost track of the best run is stored under its own key.
 *
 * Key scheme (also read by src/ui/settings.ts readBestTime for the menu; keep in sync). <car> is the
 * original car name when one is driven (RaceSelection.car, e.g. "ImprezaWRX"), else the archetype id:
 *   rally-web:best:v2:<stageId>:<seed>:<car>        → BestRecord JSON
 *   rally-web:ghost:v2:<stageId>:<seed>:<car>       → encodeGhost() JSON
 */
import type { ArchetypeId } from '../core/types';
import { decodeGhost, encodeGhost, type GhostTrack } from './ghost';
import { readJson, writeJson, type KeyValueStore } from './storage';

export interface BestRecord {
  v: 1;
  time: number;
  splits: number[];
  archetype: ArchetypeId;
  /** Original car name of the run (absent = the archetype car). */
  car?: string;
  /** ms since epoch. */
  date: number;
  resets: number;
}

export const bestKey = (stageId: string, seed: number, car: string): string =>
  `rally-web:best:v2:${stageId}:${seed}:${car}`;
export const ghostKey = (stageId: string, seed: number, car: string): string =>
  `rally-web:ghost:v2:${stageId}:${seed}:${car}`;

export class BestTimes {
  readonly store: KeyValueStore;
  constructor(store: KeyValueStore) {
    this.store = store;
  }

  /** `car`: the original car name, else the archetype id (the key scheme above). */
  load(stageId: string, seed: number, car: string): BestRecord | null {
    const r = readJson<BestRecord>(this.store, bestKey(stageId, seed, car));
    if (!r || r.v !== 1 || !Number.isFinite(r.time) || !Array.isArray(r.splits)) return null;
    return r;
  }

  save(stageId: string, seed: number, rec: BestRecord, car: string = rec.car ?? rec.archetype): void {
    writeJson(this.store, bestKey(stageId, seed, car), rec);
  }

  loadGhost(stageId: string, seed: number, car: string): GhostTrack | null {
    return decodeGhost(this.store.getItem(ghostKey(stageId, seed, car)));
  }

  saveGhost(stageId: string, seed: number, car: string, g: GhostTrack): void {
    if (g.count < 2) return;
    this.store.setItem(ghostKey(stageId, seed, car), encodeGhost(g));
  }

  clear(stageId: string, seed: number, car: string): void {
    this.store.removeItem(bestKey(stageId, seed, car));
    this.store.removeItem(ghostKey(stageId, seed, car));
  }
}
