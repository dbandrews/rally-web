/**
 * tests/world/maps.test.ts — OPT-IN headless stage maps (top-down PNGs) for eyeballing generated stages.
 *
 *   WORLD_MAPS=1 npx vitest run tests/world/maps.test.ts                 # every stage, seed 1
 *   WORLD_MAPS=pine-ridge,testpad WORLD_MAP_SEED=7 npx vitest run tests/world/maps.test.ts
 *   WORLD_MAP_FOCUS=2200:90 ...                                         # zoom: spline s 2200, ±90 m
 *
 * Output: artifacts/world-maps/<id>-s<seed>.png (legend in tests/world/mapRender.ts). Without WORLD_MAPS
 * the map tests are skipped; the PNG encoder itself is always checked.
 */
import { describe, expect, it } from 'vitest';
import { buildStage, listStages } from '../../src/world/stages';
import { encodePng, renderStageMap } from './mapRender';

const env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const want = env.WORLD_MAPS;
const seed = Number(env.WORLD_MAP_SEED ?? 1);
const focus = env.WORLD_MAP_FOCUS ? env.WORLD_MAP_FOCUS.split(':').map(Number) : null;
const ids = listStages()
  .map((s) => s.id)
  .filter((id) => want && (want === '1' || want.split(',').includes(id)));

describe('stage maps', () => {
  it('encodes a valid PNG', () => {
    const b = buildStage('testpad', 1);
    const img = renderStageMap(b, { width: 64, focus: { s: 0, r: 40 } });
    const png = encodePng(img);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(img.rgb.length).toBe(64 * img.h * 3);
  });

  it.skipIf(!ids.length).each(ids.length ? ids : ['none'])('writes the map of %s', async (id) => {
    const b = buildStage(id, seed);
    const img = renderStageMap(b, { width: 1100, focus: focus ? { s: focus[0], r: focus[1] ?? 100 } : undefined });
    const png = encodePng(img);
    // node:fs through a computed specifier: the project has no Node typings
    const spec = 'node:' + 'fs';
    const fs = (await import(/* @vite-ignore */ spec)) as { mkdirSync(p: string, o: object): void; writeFileSync(p: string, d: Uint8Array): void };
    fs.mkdirSync('artifacts/world-maps', { recursive: true });
    const file = `artifacts/world-maps/${id}-s${seed}${focus ? `-at${focus[0]}` : ''}.png`;
    fs.writeFileSync(file, png);
    expect(png.length).toBeGreaterThan(1000);
  });
});
