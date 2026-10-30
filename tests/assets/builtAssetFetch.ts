// tests/assets/builtAssetFetch.ts — serve the BUILT packs (public/assets/, `npm run assets`) to
// src/core/assets.ts inside vitest. Vitest runs in node, where the runtime has no fetch of its own and every
// loader sees "no assets"; this installs a disk-backed fetch so a part loader can be tested on real data:
//
//   import { builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';
//   import { _setAssetFetchForTests } from '../../src/core/assets';
//   describe.skipIf(!builtAssetsPresent)('track part on real data', () => {
//     beforeAll(() => useBuiltAssets());
//     afterAll(() => _setAssetFetchForTests(null));
//     it('…', async () => { const m = await getAssetManifest(); … fetchJson(stagePartPath(id, 'track')) … });
//   });
//
// Skip (never fail) when the packs are absent: CI and fresh clones have none.
import { _setAssetFetchForTests } from '../../src/core/assets';

interface Fs {
  existsSync(p: string): boolean;
  promises: { readFile(p: string): Promise<Uint8Array> };
}
// node:fs through a computed specifier: the project has no Node typings
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;

/** Output root of `npm run assets` (relative to the repo root = vitest's cwd). */
export const BUILT_ASSETS_DIR = 'public/assets';
export const builtAssetsPresent: boolean = fs.existsSync(`${BUILT_ASSETS_DIR}/manifest.json`);

/** Route every src/core/assets.ts request (assetUrl(rel) = BASE_URL + 'assets/' + rel) to public/assets/<rel>
 *  (404 for missing files). Also forgets the cached manifest. Undo with _setAssetFetchForTests(null). */
export function useBuiltAssets(dir = BUILT_ASSETS_DIR): void {
  _setAssetFetchForTests(async (url: string) => {
    const rel = decodeURIComponent(url.split('?')[0].replace(/^.*?assets\//, ''));
    if (rel.split('/').includes('..')) return new Response('bad path', { status: 400 });
    try {
      const b = await fs.promises.readFile(`${dir}/${rel}`);
      return new Response(b.slice().buffer as ArrayBuffer, { status: 200 });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}
