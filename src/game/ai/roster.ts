/**
 * src/game/ai/roster.ts — OWNED BY THE AI-RACE BUILDER (phase 2, docs/PHASE2_AI.md). The opponent roster.
 *
 * `buildRoster(sel, stage)` decides WHICH cars race against the player: `sel.opponents` AI cars (0..MAX_OPPONENTS), grid
 * index 1..n (the player is 0). Deterministic for (selection, stage, seed).
 *
 * Where the cars come from (research/formats/ai.md §1.1, §6):
 *  - the 22 career events (Misc/events/*.txt [D]) each list the 4 cars of one CLASS (`Car =`, CarCount 4) and start
 *    `OpponentCount = 3` of them: the player's pick plus its 3 class mates ("CarCount counts the roster, OpponentCount how
 *    many start" [D]). All 48 ported stages belong to at least one event [D].
 *  - the exe's AI name table (0x847928, 36 pointers = 6 groups x 6, 29 non-empty [E]) is the same classes: every event's
 *    cars lie in ONE group [D] (the group index selects the AIAttributeManager skill slot, FUN_00488590 0x488d2e-0x488d52 [E]).
 *    It tops up a short list (and is the pool when a caller asks for `tableFallback`); a stage in NO event is a procedural
 *    stage (no AI data, no original cars' stage assets) and gets no opponents.
 * Which event applies to a stage (a stage lies in 1-5 events; documented RULE [I], the exe's career flow chooses by the
 * event being played, which a free race does not have): (1) the first event of the stage (file order = code order) whose
 * Car/BonusCar list contains the player's car; else (2) the first whose class (name-table group) is the player's car's
 * group; else (3) the first event of the stage. The opponents are that event's `Car =` list without the player's car, in list
 * order; when more cars than needed remain, a seeded draw picks which (same seed = same roster).
 * Skill / tyreScale: the exe sets +0x50 (skill) from the AIAttributeManager group slot [E 0x488d2e] and +0xb4 (tyre scale
 * 0.75/0.8/1.0/1.2/1.25) from the tyre type, but only on the HUMAN participant's branch [E 0x488c9b-0x488cb1]; the manager's
 * values are not in any data file, so every AI car carries skill 1.0 / tyreScale 1.0 [I] until the ai-brain builder decodes
 * the slots (docs/orig/ai.md); the spec fields are the seam.
 */
import { MAX_OPPONENTS, aiCarId, slotBaseOfGrid } from '../../core/field';
import type { AiOpponentSpec } from '../../core/field';
import type { RaceSelection, Stage } from '../../core/types';
import { origCarArchetype } from '../../sim/presets';

/** The exe's AI name table (0x847928, 36 pointers: 6 groups of 6, empty slots omitted here) [E]. */
export const AI_NAME_GROUPS: readonly (readonly string[])[] = [
  ['LancerEVO', 'ImprezaWRX', 'FordFocusCosworth', 'Peugeot206', 'CitroenXsara'],
  ['Micra', 'Beetle', 'Corolla', 'Peugeot306', 'FordEscort'],
  ['CitroenXsaraRC', 'Saab93', 'Astra', 'FordFocus'],
  ['Lancer', 'DeltaIntergrale', 'ImprezaHC', 'NissanSkyline'],
  ['AudiS1', 'Metro6R4', 'Peugeot205', 'DeltaS4', 'Renault5', 'FordRS200'],
  ['ToyotaTacoma', 'Escudo', 'AudiS1HC', 'Peugeot405', 'SaabViggen'],
];

export interface CareerEvent {
  /** Misc/events/<code>.txt */
  code: string;
  name: string;
  /** `Car =` lines (CarCount 4; OpponentCount 3 in every file [D]). */
  cars: readonly string[];
  /** `BonusCar =` lines (unlockable prizes; not part of the start roster). */
  bonus: readonly string[];
  /** `Track =` lines as rally-web stage ids. */
  stages: readonly string[];
}

/** Misc/events/*.txt, all 22 files, in code order [D] (tests/game/roster.test.ts re-reads the files when present). */
export const CAREER_EVENTS: readonly CareerEvent[] = [
  { code: 'am', name: 'Alpine Masters', cars: ['CitroenXsaraRC', 'Saab93', 'Astra', 'FordFocus'], bonus: [], stages: ['iceracing-1-f', 'iceracing-3-r', 'iceracing-2-r', 'iceracing-2-f'] },
  { code: 'crc', name: 'Classic Rally Cup', cars: ['AudiS1', 'Metro6R4', 'Peugeot205', 'DeltaS4'], bonus: [], stages: ['newzealand-1-f', 'newzealand-2-r', 'newzealand-1-r', 'kenya-3-r', 'kenya-1-r', 'kenya-3-f', 'corsica-1-f', 'corsica-3-f', 'corsica-1-r'] },
  { code: 'ec', name: 'Eurocross Challenge', cars: ['CitroenXsaraRC', 'Saab93', 'Astra', 'FordFocus'], bonus: [], stages: ['rallycross-1-r', 'rallycross-1-f', 'rallycross-3-f', 'rallycross-2-f'] },
  { code: 'ir30', name: 'Ice Racing 30', cars: ['ToyotaTacoma', 'Escudo', 'AudiS1HC', 'Peugeot405'], bonus: [], stages: ['iceracing-2-f'] },
  { code: 'iri', name: 'Ice Racing International', cars: ['CitroenXsaraRC', 'Saab93', 'Astra', 'FordFocus'], bonus: ['Renault5'], stages: ['iceracing-1-r', 'iceracing-2-r', 'iceracing-3-r', 'iceracing-3-f', 'iceracing-1-f'] },
  { code: 'iro', name: 'Ice Racing Open', cars: ['Micra', 'Beetle', 'Corolla', 'Peugeot306'], bonus: [], stages: ['iceracing-2-f', 'iceracing-3-f', 'iceracing-2-r'] },
  { code: 'kd', name: 'Koenig Downhill', cars: ['ToyotaTacoma', 'Escudo', 'AudiS1HC', 'Peugeot405'], bonus: [], stages: ['hillclimb-3c-r', 'hillclimb-3b-r', 'hillclimb-3a-r'] },
  { code: 'ku', name: 'Koenig Unlimited', cars: ['ToyotaTacoma', 'Escudo', 'AudiS1HC', 'Peugeot405'], bonus: ['SaabViggen'], stages: ['hillclimb-3a-f', 'hillclimb-3b-f', 'hillclimb-3c-f'] },
  { code: 'mkc', name: 'Mt. Kiwi Challenge', cars: ['Lancer', 'DeltaIntergrale', 'ImprezaHC', 'NissanSkyline'], bonus: [], stages: ['hillclimb-2a-f', 'hillclimb-2b-f', 'hillclimb-2c-f'] },
  { code: 'mkd', name: 'Mt. Kiwi Downhill', cars: ['ToyotaTacoma', 'Escudo', 'AudiS1HC', 'Peugeot405'], bonus: [], stages: ['hillclimb-2c-r', 'hillclimb-2b-r', 'hillclimb-2a-r'] },
  { code: 'mku', name: 'Mt. Kiwi Unlimited', cars: ['ToyotaTacoma', 'Escudo', 'AudiS1HC', 'Peugeot405'], bonus: [], stages: ['hillclimb-2a-f', 'hillclimb-2b-f', 'hillclimb-2c-f'] },
  { code: 'mr', name: 'Mediterranean Rally', cars: ['LancerEVO', 'ImprezaWRX', 'FordFocusCosworth', 'Peugeot206'], bonus: ['CitroenXsara'], stages: ['corsica-3-f', 'corsica-2-f', 'corsica-3-r', 'corsica-2-r'] },
  { code: 'pc', name: 'Pacific Classic', cars: ['AudiS1', 'Metro6R4', 'Peugeot205', 'DeltaS4'], bonus: [], stages: ['newzealand-1-f', 'newzealand-3-r', 'newzealand-2-f', 'newzealand-3-f', 'newzealand-2-r'] },
  { code: 'prc', name: 'Pro Rally Cup', cars: ['LancerEVO', 'ImprezaWRX', 'FordFocusCosworth', 'Peugeot206'], bonus: ['Micra'], stages: ['newzealand-3-r', 'newzealand-2-f', 'newzealand-3-f', 'kenya-1-f', 'kenya-2-f', 'kenya-1-r', 'corsica-3-r', 'corsica-2-r', 'corsica-2-f'] },
  { code: 'rc30', name: 'Rallycross 30', cars: ['ToyotaTacoma', 'Escudo', 'AudiS1HC', 'Peugeot405'], bonus: [], stages: ['rallycross-3-f'] },
  { code: 'rci', name: 'Rallycross International', cars: ['CitroenXsaraRC', 'Saab93', 'Astra', 'FordFocus'], bonus: ['FordRS200'], stages: ['rallycross-2-r', 'rallycross-1-r', 'rallycross-3-r', 'rallycross-2-f', 'rallycross-3-f'] },
  { code: 'rcs', name: 'Rallycross Sprint', cars: ['CitroenXsaraRC', 'Saab93', 'Astra', 'FordFocus'], bonus: [], stages: ['rallycross-3-f', 'rallycross-1-f', 'rallycross-3-r'] },
  { code: 'sc', name: 'Safari Classic', cars: ['AudiS1', 'Metro6R4', 'Peugeot205', 'DeltaS4'], bonus: [], stages: ['kenya-3-f', 'kenya-2-r', 'kenya-3-r', 'kenya-1-f', 'kenya-2-f'] },
  { code: 'st', name: 'Safari Trophy', cars: ['LancerEVO', 'ImprezaWRX', 'FordFocusCosworth', 'Peugeot206'], bonus: [], stages: ['kenya-2-f', 'kenya-1-f', 'kenya-2-r', 'kenya-1-r'] },
  { code: 'vpc', name: 'Vista Peak Challenge', cars: ['Lancer', 'DeltaIntergrale', 'ImprezaHC', 'NissanSkyline'], bonus: [], stages: ['hillclimb-1a-f', 'hillclimb-1b-f', 'hillclimb-1c-f'] },
  { code: 'vpd', name: 'Vista Peak Downhill', cars: ['ToyotaTacoma', 'Escudo', 'AudiS1HC', 'Peugeot405'], bonus: [], stages: ['hillclimb-1c-r', 'hillclimb-1b-r', 'hillclimb-1a-r'] },
  { code: 'vpu', name: 'Vista Peak Unlimited', cars: ['ToyotaTacoma', 'Escudo', 'AudiS1HC', 'Peugeot405'], bonus: [], stages: ['hillclimb-1a-f', 'hillclimb-1b-f', 'hillclimb-1c-f'] },
];

/** Name-table group (class) of a car, -1 when it is not in the table. */
export function groupOfCar(car: string | undefined | null): number {
  if (!car) return -1;
  return AI_NAME_GROUPS.findIndex((g) => g.includes(car));
}

/** Skill multiplier of a group, AI car +0x50 [I: the AIAttributeManager slot values are not in the data, see the header]. */
export function skillOfGroup(_group: number): number {
  return 1;
}
/** Tyre scale of an AI car, AI car +0x38 / vt+0xb4 [I, see the header]. */
export const AI_TYRE_SCALE = 1;

/** The events a stage belongs to, in code order. */
export function eventsOfStage(stageId: string): CareerEvent[] {
  return CAREER_EVENTS.filter((e) => e.stages.includes(stageId));
}

/**
 * The event whose roster this race uses (rule in the header), or null when the stage is in none. The AiTimes schedule of
 * the AI cars is read from this event's tree too (ai.md §4, `loadAiSchedule(stage, car, event)`).
 */
export function selectEvent(stageId: string, playerCar: string | undefined | null): CareerEvent | null {
  const evs = eventsOfStage(stageId);
  if (!evs.length) return null;
  if (playerCar) {
    const withCar = evs.find((e) => e.cars.includes(playerCar) || e.bonus.includes(playerCar));
    if (withCar) return withCar;
    const g = groupOfCar(playerCar);
    if (g >= 0) {
      const sameClass = evs.find((e) => groupOfCar(e.cars[0]) === g);
      if (sameClass) return sameClass;
    }
  }
  return evs[0];
}

/** mulberry32: a small deterministic PRNG for the seeded draw. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Display name for standings when no locale name is known: "LancerEVO" → "Lancer EVO", "Peugeot206" → "Peugeot 206". */
export function prettyCarName(id: string): string {
  return id
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2');
}

/**
 * The cars that race the player, in grid order (grid index 1..n). `pool` is the candidate list; the seeded draw keeps the
 * list order of the chosen cars. Cars are never repeated and the player's car is never in the result.
 */
function pickCars(pool: readonly string[], n: number, seed: number): string[] {
  if (pool.length <= n) return [...pool];
  const r = rng(seed);
  const idx = pool.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).sort((a, b) => a - b).map((i) => pool[i]);
}

export interface RosterInfo {
  specs: AiOpponentSpec[];
  /** The career event the roster came from (null = the name table). */
  event: CareerEvent | null;
}

/**
 * The roster plus where it came from. `nameOf` gives a display name for an original car id (the locale name when the
 * assets are built); default is prettyCarName.
 */
export function buildRosterInfo(
  sel: RaceSelection,
  stage: Pick<Stage, 'id'>,
  nameOf: (id: string) => string = prettyCarName,
  opts: { tableFallback?: boolean } = {},
): RosterInfo {
  const raw = sel.opponents ?? 0;
  const n = Math.max(0, Math.min(MAX_OPPONENTS, Number.isFinite(raw) ? Math.floor(raw) : 0));
  if (n === 0) return { specs: [], event: null };
  const player = sel.car ?? null;
  const event = selectEvent(stage.id, player);
  // a stage that is in no career event is a procedural stage (all 48 ported stages are in one [D]): no AI assets, no
  // opponents. `tableFallback` lets a caller race the AI name table's class there anyway (tests).
  if (!event && !opts.tableFallback) return { specs: [], event: null };
  const used = new Set<string>(player ? [player] : []);
  const pool: string[] = [];
  const add = (c: string): void => {
    if (!used.has(c) && origCarArchetype(c)) {
      used.add(c);
      pool.push(c);
    }
  };
  const seed = (sel.seed >>> 0) ^ hashStr(stage.id);
  if (event) {
    // the event's start roster: its `Car =` list minus the player's car; a seeded draw when more remain than needed
    const cars = event.cars.filter((c) => c !== player);
    const drawn = pickCars(cars, n, seed);
    for (const c of drawn) add(c);
  }
  if (pool.length < n) {
    // top-up from the name table: the class of the first car (or of the player's car, else group 2 = the most common
    // event class [D]), then the other groups in order
    const g0 = groupOfCar(event?.cars[0] ?? player);
    const order = [g0 >= 0 ? g0 : 2, ...AI_NAME_GROUPS.map((_, i) => i)];
    const rest: string[] = [];
    for (const g of order) for (const c of AI_NAME_GROUPS[g]) if (!used.has(c) && !rest.includes(c)) rest.push(c);
    const need = n - pool.length;
    // within the class keep the table order; beyond it the seeded draw
    const inClass = rest.filter((c) => groupOfCar(c) === order[0]);
    const take = inClass.length >= need ? pickCars(inClass, need, seed ^ 0x9e3779b9) : [...inClass, ...pickCars(rest.filter((c) => !inClass.includes(c)), need - inClass.length, seed ^ 0x9e3779b9)];
    for (const c of take) add(c);
  }
  const specs: AiOpponentSpec[] = pool.slice(0, n).map((origCar, k) => {
    const gridIndex = k + 1;
    return {
      id: aiCarId(gridIndex),
      origCar,
      archetype: origCarArchetype(origCar) ?? 'awd_wrc',
      name: nameOf(origCar),
      skill: skillOfGroup(groupOfCar(origCar)),
      tyreScale: AI_TYRE_SCALE,
      gridIndex,
      slotBase: slotBaseOfGrid(gridIndex),
    };
  });
  return { specs, event };
}

export function buildRoster(sel: RaceSelection, stage: Pick<Stage, 'id'>): AiOpponentSpec[] {
  return buildRosterInfo(sel, stage).specs;
}
