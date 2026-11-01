// raceSampleGroups (src/audio/orig/preload.ts): the sample keys a race will need, computed from the bank JSON alone, on a
// synthetic bank (shape, priority order, dedupe) and, when the packs are built, against the keys the live objects ask for.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AudioBankJson, PatchJson } from '../../src/audio/orig/bankTypes';
import { CarSoundPlayer } from '../../src/audio/orig/carSound';
import { EnvSoundManager } from '../../src/audio/orig/envSound';
import { loadBankJson, scriptSampleKeys } from '../../src/audio/orig/index';
import { SoundSystem } from '../../src/audio/orig/patch';
import { carSampleKeys, envSampleKeys, PRELOAD_PRIORITY, raceSampleGroups, uiSampleKeys } from '../../src/audio/orig/preload';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { BUILT_ASSETS_DIR, builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';
import { layer, patch, RecBackend } from './helpers';

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { existsSync(p: string): boolean };
const hasAudio = builtAssetsPresent && fs.existsSync(`${BUILT_ASSETS_DIR}/global/audio.json`);

const script = (...samples: string[]): { patches: PatchJson[] } => ({ patches: [patch(samples.map((s) => layer(s)))] });

function fakeBank(): AudioBankJson {
  const slots = (n: number, fill: Record<number, string>) => Array.from({ length: n }, (_, i) => fill[i] ?? null);
  return {
    version: 1,
    tier: 't',
    scripts: {
      'A/Engine': script('eng1', 'eng2'),
      'A/Surface': script('gravel', 'shared'),
      'A/AI/Engine': script('aieng', 'shared'),
      'B/AI/Engine': script('aieng2'),
      'Env/Wind': script('wind'),
      'Env/Bird': script('bird', 'wind'),
      'UI/Count': script('beep'),
      'UI/Check': script('check'),
    },
    samples: {},
    cars: {
      A: { template: 'A', player: slots(20, { 0: 'A/Engine', 12: 'A/Surface' }), ai: slots(20, { 0: 'A/AI/Engine' }), engineDeltaDistance: null, pipeDeltaDistance: null, sampleFolder: null },
      B: { template: 'B', player: slots(20, {}), ai: slots(20, { 0: 'B/AI/Engine', 1: 'A/AI/Engine' }), engineDeltaDistance: null, pipeDeltaDistance: null, sampleFolder: null },
    },
    carScriptRoles: [],
    materialSlot: [],
    materialNames: [],
    collision: { hard: [], snow: [], tree: [] },
    env: {
      templates: { Wind: 'Env/Wind', Bird: 'Env/Bird' },
      objectSounds: {},
      placements: { stage1: [['Wind', 0, 0, 0], ['Bird', 1, 1, 1], ['Gone', 2, 2, 2]], stage2: [] },
    },
    ui: { CountDown: 'UI/Count', CheckPoint: 'UI/Check', Error: 'missing' },
    menu: { Back: 'menu/back', Step: 'menu/step' },
    coDriver: { masterVolume: 1, words: { '1': { s: 'word/left', phrase: 'left' }, '2': { s: 'word/right', phrase: 'right' } }, coachVolume: 1, coach: {} },
  } as unknown as AudioBankJson;
}

describe('race sample groups (synthetic bank)', () => {
  const bank = fakeBank();

  it('lists the keys of each source', () => {
    expect(carSampleKeys(bank, 'A', true).sort()).toEqual(['eng1', 'eng2', 'gravel', 'shared']);
    expect(carSampleKeys(bank, 'A', false).sort()).toEqual(['aieng', 'shared']);
    expect(carSampleKeys(bank, 'Nope', true)).toEqual([]);
    expect(envSampleKeys(bank, 'stage1').sort()).toEqual(['bird', 'wind']);
    expect(envSampleKeys(bank, 'unknown-stage')).toEqual([]);
    expect(uiSampleKeys(bank).sort()).toEqual(['beep', 'check', 'menu/back', 'menu/step', 'word/left', 'word/right']);
  });

  it('orders player, AI, stage, UI and gives each key to its most urgent group once', () => {
    const g = raceSampleGroups(bank, { stageId: 'stage1', car: 'A', aiCars: ['A', 'B', 'B'] });
    expect(g.map((x) => x.name)).toEqual(['player', 'ai', 'env', 'ui']);
    expect(g.map((x) => x.priority)).toEqual([PRELOAD_PRIORITY.player, PRELOAD_PRIORITY.ai, PRELOAD_PRIORITY.env, PRELOAD_PRIORITY.ui]);
    expect(g[0].priority).toBeGreaterThan(g[1].priority);
    expect(g[0].keys.sort()).toEqual(['eng1', 'eng2', 'gravel', 'shared']);
    expect(g[1].keys.sort()).toEqual(['aieng', 'aieng2']); // 'shared' stays with the player
    expect(g[2].keys.sort()).toEqual(['bird', 'wind']);
    expect(g[3].keys).toHaveLength(6);
    const all = g.flatMap((x) => x.keys);
    expect(new Set(all).size).toBe(all.length);
  });

  it('an archetype car (null) preloads no player set; unknown AI cars are skipped', () => {
    const g = raceSampleGroups(bank, { stageId: 'stage2', car: null, aiCars: ['Zed'] });
    expect(g[0].keys).toEqual([]);
    expect(g[1].keys).toEqual([]);
    expect(g[2].keys).toEqual([]);
    expect(g[3].keys.length).toBeGreaterThan(0);
  });

  it('scriptSampleKeys ignores missing scripts', () => {
    expect(scriptSampleKeys(bank, ['A/Engine', null, undefined, 'nope'])).toEqual(['eng1', 'eng2']);
  });
});

describe.skipIf(!hasAudio)('race sample groups on the real bank', () => {
  let bank: AudioBankJson;
  beforeAll(async () => {
    useBuiltAssets();
    bank = (await loadBankJson())!;
  });
  afterAll(() => _setAssetFetchForTests(null));

  it('computes the same keys as the live CarSoundPlayer / EnvSoundManager', () => {
    const sys = () => new SoundSystem(new RecBackend(), 1);
    for (const car of Object.keys(bank.cars).slice(0, 8)) {
      for (const human of [true, false]) {
        expect(carSampleKeys(bank, car, human).sort()).toEqual(new CarSoundPlayer(sys(), bank, car, human, 1).sampleKeys().sort());
      }
    }
    for (const stage of Object.keys(bank.env.placements).slice(0, 8)) {
      expect(envSampleKeys(bank, stage).sort()).toEqual(new EnvSoundManager(sys(), bank, stage).sampleKeys().sort());
    }
  });

  it('every key is in the sample table', () => {
    const stage = Object.keys(bank.env.placements)[0];
    const groups = raceSampleGroups(bank, { stageId: stage, car: Object.keys(bank.cars)[0], aiCars: Object.keys(bank.cars).slice(1, 4) });
    for (const g of groups) for (const k of g.keys) expect(bank.samples[k], k).toBeDefined();
    expect(groups[0].keys.length).toBeGreaterThan(5);
  });
});
