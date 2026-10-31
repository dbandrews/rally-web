/**
 * src/game/bestTimes.ts — game builder (ghost storage: ghosts builder). Best run per stage (+ seed) and car, persisted
 * in localStorage (memory fallback). The ghost of the best run is stored under its own key as the ORIGINAL's ghost file
 * (src/game/ghosts/format.ts, version 3.0, base64), written when a run beats the stored best.
 *
 * Key scheme (also read by src/ui/settings.ts readBestTime for the menu; keep in sync). <car> is the
 * original car name when one is driven (RaceSelection.car, e.g. "ImprezaWRX"), else the archetype id:
 *   rally-web:best:v2:<stageId>:<seed>:<car>        → BestRecord JSON
 *   rally-web:ghost:v3:<stageId>:<seed>:<car>       → base64 of the 3.0 ghost file
 *   rally-web:ghost:v2:<stageId>:<seed>:<car>       → the retired 30 Hz Float32 JSON of earlier builds: never read
 *                                                     (its states cannot be turned into the exe's 15 Hz delta
 *                                                     frames without the wheel spin), removed by clear()
 */
import type { ArchetypeId } from '../core/types';
import { parseGhost, writeGhost, type GhostFile } from './ghosts/format';
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
  `rally-web:ghost:v3:${stageId}:${seed}:${car}`;
/** The retired pre-exe-format key (never read). */
export const legacyGhostKey = (stageId: string, seed: number, car: string): string =>
  `rally-web:ghost:v2:${stageId}:${seed}:${car}`;

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

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

  /** The stored best-run ghost, or null (none, unreadable, or not the exe layout). */
  loadGhost(stageId: string, seed: number, car: string): GhostFile | null {
    const text = this.store.getItem(ghostKey(stageId, seed, car));
    if (!text) return null;
    try {
      const g = parseGhost(base64ToBytes(text));
      return g.frameCount > 1 ? g : null;
    } catch {
      return null;
    }
  }

  saveGhost(stageId: string, seed: number, car: string, g: GhostFile): void {
    if (g.frameCount < 2) return;
    this.store.setItem(ghostKey(stageId, seed, car), bytesToBase64(writeGhost(g)));
  }

  clear(stageId: string, seed: number, car: string): void {
    this.store.removeItem(bestKey(stageId, seed, car));
    this.store.removeItem(ghostKey(stageId, seed, car));
    this.store.removeItem(legacyGhostKey(stageId, seed, car));
  }
}
