// src/core/assets.ts without assets (the CI / fresh-clone state) and with a fake fetch; stage-id helpers;
// the shared uniforms + fog factor of src/render/orig/common.ts; the world stub.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSET_MANIFEST_VERSION,
  _setAssetFetchForTests,
  archiveStageId,
  assetUrl,
  getAssetManifest,
  hasStagePart,
  isPortedStageId,
  manifestHasStagePart,
  parseManifest,
  stageArchive,
  stageFamily,
  stageLevelPath,
  stagePartPath,
  texturePath,
} from '../../src/core/assets';
import { ORIG_DEFAULTS, createOrigUniforms, fogUniformMap, origFogFactor, resetOrigUniforms } from '../../src/render/orig/common';
import { attachOriginalWorld } from '../../src/world/orig';
import { PORTED_DATA, PORTED_ORDER } from '../../src/world/ports';
import { buildStage } from '../../src/world/stages';

const MANIFEST = { version: ASSET_MANIFEST_VERSION, stages: { 'corsica-1-f': ['environment', 'track'] }, cars: ['AudiS1'], carParts: { AudiS1: ['cars'] }, global: ['audio'], audio: true, textures: 12 };

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => _setAssetFetchForTests(null));

describe('asset manifest', () => {
  it('is null without assets (node, no fetch override) and every helper says "absent"', async () => {
    _setAssetFetchForTests(null);
    expect(await getAssetManifest()).toBeNull();
    expect(await hasStagePart('corsica-1-f', 'track')).toBe(false);
    expect(manifestHasStagePart(null, 'corsica-1-f', 'track')).toBe(false);
  });

  it('treats the dev server / build placeholder `null` as absent, silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setAssetFetchForTests(fakeFetch(null));
    expect(await getAssetManifest()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('parses, caches (one fetch) and answers part queries', async () => {
    const f = fakeFetch(MANIFEST);
    _setAssetFetchForTests(f);
    const m = await getAssetManifest();
    expect(m?.stages['corsica-1-f']).toEqual(['environment', 'track']);
    expect(m?.audio).toBe(true);
    expect(await hasStagePart('corsica-1-f', 'track')).toBe(true);
    expect(await hasStagePart('corsica-1-f', 'objects')).toBe(false);
    expect(await hasStagePart('kenya-1-f', 'track')).toBe(false);
    await getAssetManifest();
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(assetUrl('manifest.json'));
  });

  it('falls back (null, one warning) on HTTP errors and version mismatches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setAssetFetchForTests(fakeFetch({}, 404));
    expect(await getAssetManifest()).toBeNull();
    _setAssetFetchForTests(fakeFetch({ ...MANIFEST, version: 999 }));
    expect(await getAssetManifest()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    expect(parseManifest({ version: ASSET_MANIFEST_VERSION, stages: { a: ['x', 3] } })?.stages.a).toEqual(['x']);
    expect(parseManifest('nope')).toBeNull();
  });

  it('builds URLs under <BASE_URL>assets/', () => {
    expect(assetUrl('manifest.json')).toBe('/assets/manifest.json');
    expect(stagePartPath('corsica-1-f', 'track', 'bin')).toBe('stages/corsica-1-f/track.bin');
    expect(texturePath('abc')).toBe('tex/abc.rtex');
  });
});

describe('stage id ↔ archive ↔ level path', () => {
  it('maps every ported stage like the generator (PORTED_DATA.archive)', () => {
    expect(PORTED_ORDER.length).toBe(48);
    for (const id of PORTED_ORDER) {
      const arch = stageArchive(id)!;
      expect(`${arch}.rff`).toBe(PORTED_DATA[id].archive);
      expect(archiveStageId(arch)).toBe(id);
      expect(stageFamily(id)).toBe(PORTED_DATA[id].family);
      expect(isPortedStageId(id)).toBe(true);
    }
  });

  it('level paths and non-ported ids', () => {
    expect(stageLevelPath('corsica-1-f')).toBe('track/corsica1/forward');
    expect(stageLevelPath('hillclimb-1a-r')).toBe('track/hillclimb1a/reverse');
    expect(stageArchive('hillclimb-1a-f')).toBe('hillclimb1af');
    for (const x of ['testpad', 'pine-ridge', 'Misc', 'common', 'fogzor']) {
      expect(isPortedStageId(x)).toBe(false);
      expect(stageArchive(x)).toBeNull();
      expect(archiveStageId(x)).toBeNull();
    }
  });
});

describe('original fog + shared uniforms', () => {
  const fog = (enabled: number, start: number, end: number, clamp = 1e8) => ({ enabled, start, end, clamp });
  it('is D3D linear fog with the engine clamp term (1 = unfogged)', () => {
    expect(origFogFactor(0, fog(1, 0, 500))).toBe(1);
    expect(origFogFactor(250, fog(1, 0, 500))).toBeCloseTo(0.5, 12);
    expect(origFogFactor(900, fog(1, 0, 500))).toBe(0);
    expect(origFogFactor(900, fog(1, 0, 500, 180))).toBeCloseTo((500 - 180) / 500, 12); // hillclimb clamp
    expect(origFogFactor(50, fog(1, -500, 1000))).toBeCloseTo(950 / 1500, 12); // negative starts are legal
    expect(origFogFactor(5000, fog(0, 0, 10))).toBe(1); // fogEnable 0
  });

  it('reset keeps object identity (materials reference the shared objects)', () => {
    const u = createOrigUniforms();
    const map = fogUniformMap(u.trackFog);
    const color = u.trackFog.color.value;
    u.trackFog.enabled.value = 1;
    color.set(0.1, 0.2, 0.3);
    u.sunDir.value.set(1, 0, 0);
    resetOrigUniforms(u);
    expect(map.uFogEnabled).toBe(u.trackFog.enabled);
    expect(u.trackFog.color.value).toBe(color);
    expect(color.toArray()).toEqual([...ORIG_DEFAULTS.fogColor]);
    expect(u.trackFog.clamp.value).toBe(1e8);
    expect(u.sunDir.value.toArray()).toEqual([...ORIG_DEFAULTS.sunDirThree]);
  });
});

describe('attachOriginalWorld (stub)', () => {
  it('returns the procedural world unchanged without assets', async () => {
    const built = buildStage('corsica-1-f', 1);
    expect(await attachOriginalWorld(built)).toBe(built);
  });
});
