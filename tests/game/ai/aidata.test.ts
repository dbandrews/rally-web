/**
 * AiData / AiTimes loaders (src/game/ai/aidata.ts): a fake fetch (always runs) and the built `ai` part on real data
 * (skipped without public/assets): 48 stage files, 804 posts, side.rsd samples, 360 AiTimes files.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../../src/core/assets';
import { _resetAiDataCaches, aiTimesKey, loadAiSchedule, loadAiStageData, parseAiStageData } from '../../../src/game/ai/aidata';
import { builtAssetsPresent, useBuiltAssets } from '../../assets/builtAssetFetch';

const manifest = (over: object = {}) => ({ version: 1, stages: { 'corsica-1-f': ['ai', 'track'] }, cars: [], carParts: {}, global: ['ai'], audio: false, textures: 0, ...over });
const stageJson = {
  version: 1,
  stageId: 'corsica-1-f',
  posts: [
    { lapDist: 100, recSpeed: 50, curveSpdScale: 1.5, curveCut: 0.25, lookAheadDist: 6, thresholdScale: 1 },
    { lapDist: 0, recSpeed: 70, curveSpdScale: 1.75, curveCut: 0.25, lookAheadDist: 6, thresholdScale: 1 },
  ],
  samples: { n: 3, step: 5, dist: [0, 5, 10], left: [6, 6.5, 7], right: [5, 5.5, 6], post: [1, 1, 0] },
};
const timesJson = { version: 1, count: 2, times: { 'events/am/iceracing2r/astra': { laps: 5, splits: [19.65, 42.335] }, 'hillclimb1bf/micra': { laps: 1, splits: [60, 120.5] } } };

function fakeFetch(files: Record<string, unknown>, log: string[] = []) {
  return async (url: string) => {
    const rel = url.split('?')[0].replace(/^.*?assets\//, '');
    log.push(rel);
    if (rel in files) return new Response(JSON.stringify(files[rel]), { status: 200 });
    return new Response('nf', { status: 404 });
  };
}

describe('AiData / AiTimes loaders (fake fetch)', () => {
  afterEach(() => {
    _setAssetFetchForTests(null);
    _resetAiDataCaches();
  });

  it('a failed fetch is not cached for the session (the next prepare retries); an absent part stays cached', async () => {
    let fail = true;
    const log: string[] = [];
    const ok = fakeFetch({ 'manifest.json': manifest(), 'stages/corsica-1-f/ai.json': stageJson, 'global/ai.json': timesJson }, log);
    _setAssetFetchForTests(async (url: string) => {
      if (fail && /ai\.json/.test(url) && !/manifest/.test(url)) return new Response('boom', { status: 500 });
      return ok(url);
    });
    expect(await loadAiStageData('corsica-1-f')).toBeNull();
    expect(await loadAiSchedule('hillclimb-1b-f', 'Micra', null)).toBeNull();
    fail = false;
    expect(await loadAiStageData('corsica-1-f')).not.toBeNull(); // retried
    expect(await loadAiSchedule('hillclimb-1b-f', 'Micra', null)).not.toBeNull(); // the global file too
    // absent from the manifest: one manifest read, never a stage fetch, cached
    const n = log.length;
    expect(await loadAiStageData('corsica-2-f')).toBeNull();
    expect(await loadAiStageData('corsica-2-f')).toBeNull();
    expect(log.length).toBe(n);
  });

  it('parses a stage file: posts sorted by lapDist, the sample table as typed arrays', async () => {
    _setAssetFetchForTests(fakeFetch({ 'manifest.json': manifest(), 'stages/corsica-1-f/ai.json': stageJson }));
    const d = await loadAiStageData('corsica-1-f');
    expect(d).not.toBeNull();
    expect(d!.stageId).toBe('corsica-1-f');
    expect(d!.posts.map((p) => p.lapDist)).toEqual([0, 100]);
    expect(d!.posts[0].recSpeed).toBe(70);
    expect(d!.samples!.n).toBe(3);
    expect(Array.from(d!.samples!.post)).toEqual([1, 1, 0]);
    expect(d!.samples!.left[2]).toBeCloseTo(7, 5);
  });

  it('caches per stage and resolves null (never rejects) for absent parts', async () => {
    const log: string[] = [];
    _setAssetFetchForTests(fakeFetch({ 'manifest.json': manifest(), 'stages/corsica-1-f/ai.json': stageJson }, log));
    await loadAiStageData('corsica-1-f');
    await loadAiStageData('corsica-1-f');
    expect(log.filter((l) => l === 'stages/corsica-1-f/ai.json').length).toBe(1);
    expect(await loadAiStageData('corsica-2-f')).toBeNull(); // not in the manifest
    _setAssetFetchForTests(fakeFetch({ 'manifest.json': manifest({ stages: { 'corsica-3-f': ['ai'] } }) }));
    _resetAiDataCaches();
    expect(await loadAiStageData('corsica-3-f')).toBeNull(); // listed but 404
  });

  it('resolves null without a manifest (no assets, ?orig=0)', async () => {
    _setAssetFetchForTests(fakeFetch({}));
    expect(await loadAiStageData('corsica-1-f')).toBeNull();
    expect(await loadAiSchedule('corsica-1-f', 'Micra', null)).toBeNull();
  });

  it('rejects malformed files as null', () => {
    expect(parseAiStageData('x', null)).toBeNull();
    expect(parseAiStageData('x', { posts: [] })).toBeNull();
    const d = parseAiStageData('x', { posts: stageJson.posts, samples: { n: 2, step: 5, dist: [0], left: [], right: [], post: [] } });
    expect(d!.samples).toBeNull(); // inconsistent sample arrays are dropped, the posts survive
  });

  it('looks AiTimes up by event / single-race tree, case-insensitively', async () => {
    _setAssetFetchForTests(fakeFetch({ 'manifest.json': manifest(), 'global/ai.json': timesJson }));
    expect(aiTimesKey('iceracing-2-r', 'Astra', 'am')).toBe('events/am/iceracing2r/astra');
    expect(aiTimesKey('hillclimb-1b-f', 'Micra', null)).toBe('hillclimb1bf/micra');
    expect(aiTimesKey('not-a-stage', 'Micra', null)).toBeNull();
    const s = await loadAiSchedule('iceracing-2-r', 'Astra', 'AM');
    expect(s).toEqual({ laps: 5, splits: [19.65, 42.335] });
    expect((await loadAiSchedule('hillclimb-1b-f', 'Micra', null))!.splits[1]).toBe(120.5);
    expect(await loadAiSchedule('iceracing-2-r', 'Astra', null)).toBeNull(); // no single-race file for that track
  });
});

describe.skipIf(!builtAssetsPresent)('built ai part (public/assets)', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => {
    _setAssetFetchForTests(null);
    _resetAiDataCaches();
  });

  it('48 stage files with 804 posts in total and consistent sample tables', async () => {
    const { PORTED_ORDER } = await import('../../../src/world/ports');
    let posts = 0;
    for (const id of PORTED_ORDER) {
      const d = await loadAiStageData(id);
      expect(d, id).not.toBeNull();
      posts += d!.posts.length;
      for (let i = 1; i < d!.posts.length; i++) expect(d!.posts[i].lapDist).toBeGreaterThanOrEqual(d!.posts[i - 1].lapDist);
      const s = d!.samples!;
      expect(s, id).not.toBeNull();
      expect(s.dist[0]).toBe(0);
      expect(s.dist[1] - s.dist[0]).toBeCloseTo(5, 4);
      expect(s.post[0], id).toBe(0); // AiData starts at lapDist 0 in every stage
      for (let i = 1; i < s.n; i++) expect(s.post[i]).toBeGreaterThanOrEqual(s.post[i - 1]);
      expect(Math.min(...s.left)).toBeGreaterThan(0);
      expect(Math.min(...s.right)).toBeGreaterThan(0);
    }
    expect(PORTED_ORDER.length).toBe(48);
    expect(posts).toBe(804);
  });

  it('360 AiTimes files: strictly increasing splits, the event/single-race keys resolve', async () => {
    const m = await (await import('../../../src/core/assets')).fetchJson<{ count: number; times: Record<string, { laps: number; splits: number[] }> }>('global/ai.json');
    expect(m.count).toBe(360);
    expect(Object.keys(m.times).length).toBe(360);
    for (const [k, v] of Object.entries(m.times)) {
      expect(v.splits.length, k).toBeGreaterThan(0);
      for (let i = 1; i < v.splits.length; i++) expect(v.splits[i], k).toBeGreaterThan(v.splits[i - 1]);
    }
    const s = await loadAiSchedule('iceracing-2-r', 'Astra', 'am');
    expect(s!.laps).toBe(5);
    expect(s!.splits[s!.splits.length - 1]).toBeCloseTo(195.891, 2);
    expect(await loadAiSchedule('hillclimb-1b-f', 'Lancer', null)).not.toBeNull();
  });
});
