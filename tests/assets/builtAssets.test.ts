// Checks the BUILT asset packs in public/assets/ (npm run assets). Skipped when they are absent (CI, fresh
// clones): the game must work without them, and so must the test suite.
import type * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSET_MANIFEST_VERSION, _setAssetFetchForTests, getAssetManifest, parseManifest } from '../../src/core/assets';
import { parseRtex, rtexLevelRGBA } from '../../src/render/orig/rtex';
import { TextureStore } from '../../src/render/orig/textures';
import { useBuiltAssets } from './builtAssetFetch';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc?: string): Uint8Array | string;
  readdirSync(p: string): string[];
}
// node:fs through a computed specifier: the project has no Node typings
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;
const ROOT = 'public/assets';
const present = fs.existsSync(`${ROOT}/manifest.json`);

describe.skipIf(!present)('built original assets (public/assets)', () => {
  const raw = present ? JSON.parse(fs.readFileSync(`${ROOT}/manifest.json`, 'utf8') as string) : null;

  it('manifest matches the runtime version and lists only existing part files', () => {
    expect(raw.version).toBe(ASSET_MANIFEST_VERSION);
    const m = parseManifest(raw)!;
    for (const [id, parts] of Object.entries(m.stages)) {
      for (const p of parts) expect(fs.existsSync(`${ROOT}/stages/${id}/${p}.json`), `${id}/${p}.json`).toBe(true);
    }
    const tex = fs.existsSync(`${ROOT}/tex`) ? fs.readdirSync(`${ROOT}/tex`).filter((f) => f.endsWith('.rtex')) : [];
    expect(m.textures).toBe(tex.length);
  });

  it('every part json parses', () => {
    for (const [id, parts] of Object.entries(raw.stages as Record<string, string[]>)) {
      for (const p of parts) expect(() => JSON.parse(fs.readFileSync(`${ROOT}/stages/${id}/${p}.json`, 'utf8') as string)).not.toThrow();
    }
  });

  it('a sample of tex/*.rtex parses and decodes', () => {
    const tex = fs.existsSync(`${ROOT}/tex`) ? fs.readdirSync(`${ROOT}/tex`).filter((f) => f.endsWith('.rtex')).sort() : [];
    const step = Math.max(1, Math.floor(tex.length / 60));
    for (let i = 0; i < tex.length; i += step) {
      const img = parseRtex(fs.readFileSync(`${ROOT}/tex/${tex[i]}`) as Uint8Array);
      const last = img.levels.length - 1;
      const L = img.levels[last];
      expect(rtexLevelRGBA(img, last).length).toBe(L.width * L.height * L.depth * 4);
    }
  });
});

describe.skipIf(!present)('runtime fetch path on the built packs (tests/assets/builtAssetFetch.ts)', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => _setAssetFetchForTests(null));

  it('getAssetManifest() reads public/assets/manifest.json', async () => {
    const want = parseManifest(JSON.parse(fs.readFileSync(`${ROOT}/manifest.json`, 'utf8') as string));
    expect(await getAssetManifest()).toEqual(want);
  });

  it('TextureStore loads a 2-D texture through fetchArrayBuffer (JS decode path, no GL needed)', async () => {
    const tex = fs.existsSync(`${ROOT}/tex`) ? fs.readdirSync(`${ROOT}/tex`).filter((f) => f.endsWith('.rtex')).sort() : [];
    const id = tex.map((f) => f.slice(0, -5)).find((i) => !(parseRtex(fs.readFileSync(`${ROOT}/tex/${i}.rtex`) as Uint8Array).flags & 1));
    if (!id) return;
    const store = new TextureStore({} as THREE.WebGLRenderer, { s3tc: false });
    const scope = store.scope();
    const t = (await scope.get(id)) as THREE.CompressedTexture;
    const img = parseRtex(fs.readFileSync(`${ROOT}/tex/${id}.rtex`) as Uint8Array);
    expect(t.mipmaps.length).toBe(img.levels.length);
    expect(t.flipY).toBe(false);
    expect(store.stats().textures).toBe(1);
    scope.dispose();
    expect(store.stats().textures).toBe(0);
  });
});
