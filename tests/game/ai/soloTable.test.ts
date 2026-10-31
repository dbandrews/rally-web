/**
 * The per-stage table of a solo AI car (tools/ai-stages.mjs drives this file with AI_STAGES / AI_TABLE env vars):
 * for every requested stage the (event, car) pair of an AiTimes file of that track is run twice, with the AiTimes
 * schedule (the game's configuration) and without it, and the finish times are written next to the AiTimes total.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { _setAssetFetchForTests, fetchJson, stageArchive } from '../../../src/core/assets';
import { _resetAiDataCaches } from '../../../src/game/ai/aidata';
import { builtAssetsPresent, useBuiltAssets } from '../../assets/builtAssetFetch';
import { runSolo, type SoloResult } from './soloRun';
import { fs } from './nodefs';

const env = ((globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}) as Record<string, string | undefined>;
const tablePath = env.AI_TABLE;
const wanted = (env.AI_STAGES ?? '').split(',').filter(Boolean);

interface Row extends SoloResult {
  event: string | null;
  scheduleTotal: number | null;
  noSchedule: { finished: boolean; finishTime: number; resets: number } | null;
}

describe.skipIf(!builtAssetsPresent || !tablePath || wanted.length === 0)('solo AI table', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => {
    _setAssetFetchForTests(null);
    _resetAiDataCaches();
  });

  it('runs the requested stages', async () => {
    const times = (await fetchJson<{ times: Record<string, { laps: number; splits: number[] }> }>('global/ai.json')).times;
    const rows: Row[] = [];
    for (const id of wanted) {
      const track = stageArchive(id)!;
      // the (event, car) of the first AiTimes file of this track whose car we have
      const keys = Object.keys(times).filter((k) => k.split('/').slice(-2)[0] === track).sort();
      const pick = keys[0];
      const parts = pick ? pick.split('/') : [];
      const event = parts[0] === 'events' ? parts[1] : null;
      const carKey = parts[parts.length - 1];
      const { ORIG_CAR_IDS } = await import('../../../src/core/constants');
      const car = (ORIG_CAR_IDS as readonly string[]).find((c) => c.toLowerCase() === carKey) ?? 'ImprezaWRX';
      const withS = await runSolo(id, { car, event, maxSeconds: 700 });
      const noS = await runSolo(id, { car, event, schedule: false, maxSeconds: 700 });
      rows.push({ ...withS, event, scheduleTotal: withS.schedule?.total ?? null, noSchedule: { finished: noS.finished, finishTime: noS.finishTime, resets: noS.resets } });
      console.log(`${id} ${car} ${event ?? '-'}: ${withS.finished ? withS.finishTime.toFixed(1) : 'DNF'} s (schedule ${withS.schedule?.total ?? '-'}), no schedule ${noS.finished ? noS.finishTime.toFixed(1) : 'DNF'}, resets ${withS.resets}/${noS.resets}`);
    }
    (fs as unknown as { writeFileSync(p: string, s: string): void }).writeFileSync(tablePath!, JSON.stringify(rows));
  }, 3_000_000);
});
