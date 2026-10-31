/**
 * src/game/ai/aidata.ts — OWNED BY THE AI-BRAIN BUILDER (phase 2, docs/PHASE2_AI.md). AiData posts + AiTimes loaders.
 *
 * `loadAiStageData(stageId)` reads the stage's `ai` asset part (`stages/<id>/ai.json`, built by
 * tools/assets/parts/ai.py from AIFiles/AiData.con and AIFiles/side.rsd; research/formats/ai.md §3, docs/orig/ai.md §3)
 * and `loadAiSchedule(...)` the AiTimes file of a (track, car) (`global/ai.json`, from fmt_aitimes.py; ai.md §4). Both
 * resolve null when the part is not built (no assets, `?orig=0`, unknown file) and never reject: the AI then drives with
 * the object's defaults.
 *
 * The global part is `global/ai.json` (an asset part may only write `<part>.<ext>`), not `global/aitimes.json`.
 *
 * The stage data carries, besides the AiData posts of the driver.ts contract, the spline manager's per-5-m `samples`
 * (side.rsd: road clearance left / right of the centre line, with the AiData post each sample inherits). The driver
 * reads its "post record" (FUN_00607280's vt+0x54 result) from them.
 */
import { fetchJson, getAssetManifest, globalPartPath, stagePartPath, stageArchive, warnOnce } from '../../core/assets';
import type { AiDataPost, AiStageData, AiTimesSchedule } from './driver';

/** The spline manager's sample table of one stage: one entry per `step` metres of the centre line. */
export interface AiSampleTable {
  n: number;
  step: number;
  dist: Float32Array;
  /** Road clearance (m) left / right of the centre line at the sample (side.rsd). */
  left: Float32Array;
  right: Float32Array;
  /** Index into `posts` of the AiData post the sample inherits (-1 = none yet: the post parameters are zero). */
  post: Int16Array;
}

/** `AiStageData` of the contract plus the sample table (null when the stage file predates it). */
export interface AiStageDataX extends AiStageData {
  samples: AiSampleTable | null;
}

interface StageJson {
  version?: number;
  stageId?: string;
  posts?: AiDataPost[];
  samples?: { n: number; step: number; dist: number[]; left: number[]; right: number[]; post: number[] };
}

/** Pure parse of `stages/<id>/ai.json` (exported for tests). */
export function parseAiStageData(stageId: string, j: unknown): AiStageDataX | null {
  const o = j as StageJson | null;
  if (!o || !Array.isArray(o.posts) || o.posts.length === 0) return null;
  const posts = o.posts
    .map((p) => ({
      lapDist: Number(p.lapDist),
      recSpeed: Number(p.recSpeed),
      curveSpdScale: Number(p.curveSpdScale),
      curveCut: Number(p.curveCut),
      lookAheadDist: Number(p.lookAheadDist),
      thresholdScale: Number(p.thresholdScale),
    }))
    .sort((a, b) => a.lapDist - b.lapDist);
  let samples: AiSampleTable | null = null;
  const s = o.samples;
  if (s && s.n > 0 && s.dist.length === s.n && s.left.length === s.n && s.right.length === s.n && s.post.length === s.n) {
    samples = { n: s.n, step: s.step, dist: Float32Array.from(s.dist), left: Float32Array.from(s.left), right: Float32Array.from(s.right), post: Int16Array.from(s.post) };
  }
  return { stageId, posts, samples };
}

const stageCache = new Map<string, Promise<AiStageDataX | null>>();

export function loadAiStageData(stageId: string): Promise<AiStageDataX | null> {
  let p = stageCache.get(stageId);
  if (!p) {
    p = (async () => {
      try {
        const m = await getAssetManifest();
        if (!m || !(m.stages[stageId] ?? []).includes('ai')) return null;
        return parseAiStageData(stageId, await fetchJson<unknown>(stagePartPath(stageId, 'ai')));
      } catch (e) {
        warnOnce('ai-stage-' + stageId, `[ai] no AiData for ${stageId} (${(e as Error).message}): the AI drives with the object defaults`);
        // a fetch / parse error is not "the part is absent": do not cache it, the next prepare retries (an absent manifest entry
        // returns null above and stays cached)
        if (stageCache.get(stageId) === p) stageCache.delete(stageId);
        return null;
      }
    })();
    stageCache.set(stageId, p);
  }
  return p;
}

interface TimesJson {
  version?: number;
  times?: Record<string, { laps?: number; splits?: number[] }>;
}

let timesPromise: Promise<TimesJson | null> | null = null;
function loadTimes(): Promise<TimesJson | null> {
  if (!timesPromise) {
    let p: Promise<TimesJson | null> | undefined;
    p = (async () => {
      try {
        const m = await getAssetManifest();
        if (!m || !m.global.includes('ai')) return null;
        return await fetchJson<TimesJson>(globalPartPath('ai'));
      } catch (e) {
        warnOnce('ai-times', `[ai] no AiTimes (${(e as Error).message}): no behind-schedule speed cuts`);
        if (timesPromise === p) timesPromise = null; // an error is retried by the next race; an absent part stays cached
        return null;
      }
    })();
    timesPromise = p;
  }
  return timesPromise;
}

/** The key of an AiTimes file in `global/ai.json`: `events/<code>/<track>/<car>` or `<track>/<car>`, lower case. */
export function aiTimesKey(stageId: string, origCar: string, event: string | null): string | null {
  const track = stageArchive(stageId);
  if (!track) return null;
  const tail = `${track}/${origCar}`.toLowerCase();
  return event ? `events/${event.toLowerCase()}/${tail}` : tail;
}

/**
 * The AiTimes schedule of a (stage, car). `event` = the career event code (Misc/events/<code>.txt) when racing an event,
 * else null (the single-race tree: only Hillclimb1bf, Hillclimb2af, Kenya2f, NewZealand2f exist there).
 */
export async function loadAiSchedule(stageId: string, origCar: string, event: string | null): Promise<AiTimesSchedule | null> {
  const key = aiTimesKey(stageId, origCar, event);
  if (!key) return null;
  const t = await loadTimes();
  const e = t?.times?.[key];
  if (!e || !Array.isArray(e.splits) || e.splits.length === 0 || !(e.laps && e.laps > 0)) return null;
  return { laps: e.laps, splits: e.splits.slice() };
}

/** Tests only: forget the caches. */
export function _resetAiDataCaches(): void {
  stageCache.clear();
  timesPromise = null;
}
