/**
 * src/game/ai/standings.ts — OWNED BY THE AI-RACE BUILDER (phase 2). Race positions of the cars on the road.
 *
 * Order [I, the rules of a race table; the original's own ranking function was not traced]: cars that FINISHED come first,
 * by finish time (ties by who got there first, then grid index); the others follow by route distance covered, the further
 * the better (ties by grid index, so a standing start orders the field by its grid slots). No allocation: the caller owns
 * the entry objects and the output array.
 */
export interface Racer {
  /** Grid index (the player is 0): the final tie-break. */
  gridIndex: number;
  finished: boolean;
  /** Race time at the finish (s); only read when `finished`. */
  finishTime: number;
  /** Order in which the cars finished (1-based); only read when `finished`. */
  finishOrder: number;
  /** Route distance covered (m, all laps). */
  dist: number;
}

/** Sort comparator: negative when `a` is ahead of `b`. */
export function compareRacers(a: Racer, b: Racer): number {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  if (a.finished) {
    if (a.finishTime !== b.finishTime) return a.finishTime - b.finishTime;
    if (a.finishOrder !== b.finishOrder) return a.finishOrder - b.finishOrder;
    return a.gridIndex - b.gridIndex;
  }
  if (a.dist !== b.dist) return b.dist - a.dist;
  return a.gridIndex - b.gridIndex;
}

/** Sort `racers` in place by position (insertion sort: at most 4 entries, no allocation) and return it. */
export function rankRacers<T extends Racer>(racers: T[]): T[] {
  for (let i = 1; i < racers.length; i++) {
    const x = racers[i];
    let j = i - 1;
    while (j >= 0 && compareRacers(racers[j], x) > 0) {
      racers[j + 1] = racers[j];
      j--;
    }
    racers[j + 1] = x;
  }
  return racers;
}
