/**
 * A solo AI car (the ported original AI, AI friction, the original collision mesh) drives stages to the finish.
 * Default: one stage per discipline (kept short for the unit run); the full 48-stage table is tools/ai-stages.mjs.
 * Skipped without public/assets (npm run assets).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../../src/core/assets';
import { _resetAiDataCaches } from '../../../src/game/ai/aidata';
import { builtAssetsPresent, useBuiltAssets } from '../../assets/builtAssetFetch';
import { runSolo } from './soloRun';

describe.skipIf(!builtAssetsPresent)('solo AI car on the original stages', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => {
    _setAssetFetchForTests(null);
    _resetAiDataCaches();
  });

  for (const id of ['rallycross-1-f', 'hillclimb-1a-f']) {
    it(`${id}: finishes with the real driver`, async () => {
      const r = await runSolo(id, { car: id.startsWith('rallycross') ? 'Corolla' : 'ImprezaWRX', maxSeconds: 400 });
      console.log(JSON.stringify(r));
      expect(r.simFaults).toBe(0);
      expect(r.finished).toBe(true);
      expect(r.resets).toBe(0);
    }, 300_000);
  }
});
