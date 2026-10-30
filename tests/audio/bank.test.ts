// The BUILT original sound bank (public/assets/global/audio.json + global/audio/…, `npm run assets -- --audio
// --parts audio`) against the original files and the verified research dump (research/formats/sound.md §0 / §12 /
// §13 Verification). Skipped when the packs are absent (CI, fresh clones); the dump / cache comparisons are
// skipped when .cache/dumps/sound_dump.json / .cache/original are absent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AudioBankJson } from '../../src/audio/orig/bankTypes';
import { createSoundBank, loadBankJson, samplePath } from '../../src/audio/orig/index';
import { parseWav } from '../../src/audio/orig/wav';
import { _setAssetFetchForTests, fetchArrayBuffer } from '../../src/core/assets';
import { ORIG_CAR_IDS, ORIG_MATERIAL_NAMES } from '../../src/core/constants';
import { BUILT_ASSETS_DIR, builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
  readFileSync(p: string, enc: string): string;
}
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;
const DUMP = '.cache/dumps/sound_dump.json';
const ORIG = '.cache/original';
const hasAudio = builtAssetsPresent && fs.existsSync(`${BUILT_ASSETS_DIR}/global/audio.json`);

/** sound.md §6: original material byte → surface slot (jump table 0x7473e8); null = silent. */
const SPEC_SLOT: Record<string, number | null> = {
  ASPHALT: 0, ASPHALTGRASS: 1, ICEASPHALT: 2, WATERASPHALT: 3, GRAVEL: 4, GRAVELGRASS: 5, GRAVELDEEP: 6, MUD: 7,
  MUDGRASS: 8, MUDDITCH: 9, GRASS: 10, SAND: 11, SANDDEEP: 12, SANDDARKDEEP: 13, SNOW: 14, SNOWCHUNKY: 15,
  SNOWDEEP: 16, SNOWASPHALT: 17, SNOWDITCH: 18, WOOD: null, COBBLES: null, LEAF: null, SANDDARK: null,
};
/** sound.md §10 co-driver words. */
const WORDS = [
  'EasyLeft', 'EasyRight', 'MediumLeft', 'MediumRight', 'HardLeft', 'HardRight', 'HairpinLeft', 'HairpinRight',
  'TightHairpinLeft', 'TightHairpinRight', 'SquareLeft', 'SquareRight', 'Narrows', 'OverCrest', 'OverBridge',
  'Caution', 'Long', 'Into', 'Onto', 'OverFinish', 'Tightens', 'OverJump', 'Rocks', 'Trees', 'Fence', 'Exposure',
  'Bank', 'Banks', 'Bumps', 'Ditch', 'Tarmac', 'Mud', 'Gravel', 'Sand', 'Dontcut', 'Opens', 'Careful', 'Inside',
  'Outside', 'Bump', 'LongStraight',
];

/** data chunk + smpl loops of a RIFF file. */
function riff(b: Uint8Array): { data: Uint8Array; smpl: [number, number][] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  let o = 12;
  let data: Uint8Array = new Uint8Array(0);
  const smpl: [number, number][] = [];
  while (o + 8 <= b.byteLength) {
    const id = tag(o);
    const n = dv.getUint32(o + 4, true);
    if (id === 'data') data = b.subarray(o + 8, o + 8 + n);
    if (id === 'smpl' && n >= 36) {
      const nl = dv.getUint32(o + 8 + 28, true);
      for (let k = 0; k < nl; k++) {
        const q = o + 8 + 36 + 24 * k;
        if (q + 24 <= b.byteLength) smpl.push([dv.getUint32(q + 8, true), dv.getUint32(q + 12, true)]);
      }
    }
    o += 8 + n + (n & 1);
  }
  return { data, smpl };
}

describe.skipIf(!hasAudio)('built sound bank (global/audio.json)', () => {
  let bank: AudioBankJson;
  beforeAll(async () => {
    useBuiltAssets();
    const b = await loadBankJson();
    if (!b) throw new Error('manifest.audio false');
    bank = b;
  });
  afterAll(() => _setAssetFetchForTests(null));

  it('all 386 .ssc scripts: 469 patches, 894 layers, 3685 effects (sound.md §0)', () => {
    const scripts = Object.values(bank.scripts);
    expect(scripts.length).toBe(386);
    const patches = scripts.flatMap((s) => s.patches);
    const layers = patches.flatMap((p) => p.layers);
    expect(patches.length).toBe(469);
    expect(layers.length).toBe(894);
    expect(layers.reduce((a, l) => a + l.fx.length, 0)).toBe(3685);
    // every envelope is a Ramp with 6 effective params; only Volume / Pitch destinations
    for (const l of layers) for (const e of l.fx) expect(e.e === 1 && e.p.length === 6 && (e.d === 0 || e.d === 1)).toBe(true);
  });

  it('sample table complete: every load resolves except the NissanSkyline Idleoutside typo (sound.md §12)', () => {
    const missing: string[] = [];
    for (const [k, s] of Object.entries(bank.scripts)) {
      for (const p of s.patches) for (const l of p.layers) {
        if (!l.s) missing.push(`${k}:${l.path}`);
        else expect(bank.samples[l.s], l.s).toBeDefined();
      }
    }
    expect(missing.length).toBe(2);
    expect(missing.every((m) => m.includes('NissanSkyline') && /Idleoutside/i.test(m))).toBe(true);
    expect(Object.keys(bank.samples).length).toBe(582); // 482 script samples + 92 co-driver / coach + 8 menu
    expect(bank.tier).toBe('44khz');
  });

  it('every sample file decodes to its table entry; loops are the WHOLE buffer (DirectSound, 0x6b3d30)', async () => {
    let n = 0;
    for (const [k, e] of Object.entries(bank.samples)) {
      const pcm = parseWav(await fetchArrayBuffer(samplePath(e.f)));
      expect([pcm.frames, pcm.rate, pcm.channels], k).toEqual([e.frames, e.rate, e.ch]);
      expect(e.loop).toEqual([0, e.frames]);
      n++;
    }
    expect(n).toBe(582);
  });

  it.skipIf(!fs.existsSync(ORIG))('PCM byte-identical to the original WAVs; authored smpl loop points preserved', () => {
    let smplFiles = 0;
    for (const [k, e] of Object.entries(bank.samples)) {
      const src = riff(fs.readFileSync(`${ORIG}/${k}`));
      const out = riff(fs.readFileSync(`${BUILT_ASSETS_DIR}/global/${e.f}`));
      expect(out.data.byteLength, k).toBe(src.data.byteLength);
      let same = true;
      for (let i = 0; i < src.data.byteLength && same; i++) same = out.data[i] === src.data[i];
      expect(same, k).toBe(true);
      if (src.smpl.length) {
        smplFiles++;
        expect(e.smpl, k).toEqual(src.smpl);
      } else expect(e.smpl).toBeUndefined();
    }
    expect(smplFiles).toBeGreaterThan(0);
  });

  it('per-car engine patch sets keyed by the original car name (ORIG_CAR_IDS), 20 player slots', () => {
    expect(Object.keys(bank.cars).sort()).toEqual([...ORIG_CAR_IDS].sort());
    for (const [name, c] of Object.entries(bank.cars)) {
      expect(c.player.length, name).toBe(20);
      expect(c.player.every((s) => s !== null), name).toBe(true);
      expect(c.ai.filter((s) => s !== null).length, name).toBe(6); // 14 of the 20 Simple/ scripts are absent
      expect(c.player[0]).toBe(`Cars/cars/${name}/Sound/Engine.ssc`);
      expect(c.player[19]).toBe('Cars/cars/General/Sounds/WheelFriction.ssc');
    }
    expect(bank.cars.ImprezaWRX.sampleFolder).toBe('Subaruimpreza');
    expect(bank.cars.AudiS1HC.sampleFolder).toBe('Audiquatro');
    // Metro6R4's Pipe.ssc lacks the TurboRelease layer (sound.md §4.4)
    const pipeLayers = (car: string) => bank.scripts[bank.cars[car].player[1]!].patches[0].layers.map((l) => l.path.split(/[\\/]/).pop());
    expect(pipeLayers('ImprezaWRX')).toContain('TurboRelease.wav');
    expect(pipeLayers('Metro6R4')).not.toContain('TurboRelease.wav');
  });

  it('surfaces: all 23 original materials → the jump-table slot (sound.md §6)', () => {
    expect(bank.materialSlot.length).toBe(23);
    for (let m = 0; m < 23; m++) expect(bank.materialSlot[m], ORIG_MATERIAL_NAMES[m]).toBe(SPEC_SLOT[ORIG_MATERIAL_NAMES[m]]);
    // the WheelFriction patch comments name the slots 1:1
    const wf = bank.scripts['Cars/cars/General/Sounds/WheelFriction.ssc'].patches;
    expect(wf.length).toBeGreaterThanOrEqual(19);
    expect(wf[0].comment).toMatch(/asphalt/i);
    expect(wf[4].comment).toMatch(/gravel/i);
    expect(wf[10].comment).toMatch(/grass/i);
    expect(wf[14].comment).toMatch(/snow/i);
  });

  it('impacts: collision types → Hard / Snow / Tree patches (table 0x746e3c)', () => {
    const hard = [0, 1, 2, 4, 5, 12, 13, 15, 16, 19, 20, 21, 22];
    expect(bank.collision.hard).toEqual([...hard, ...hard.map((t) => t + 100)]);
    expect(bank.collision.snow).toEqual([7, 8, 9, 10, 11, 107, 108, 109, 110, 111]);
    expect(bank.collision.tree).toEqual([6, 106]);
  });

  it('ambience: 15 env templates, 793 placements on 48 stages, SIM space', () => {
    expect(Object.keys(bank.env.templates).length).toBe(15);
    const rows = Object.values(bank.env.placements);
    expect(rows.length).toBe(48);
    expect(rows.reduce((a, r) => a + r.length, 0)).toBe(793);
    for (const r of rows) for (const [t] of r) expect(bank.env.templates[t]).toBeDefined();
  });

  it('race UI scripts, menu sounds and the co-driver words 1..41 (sound.md §9 / §10)', () => {
    for (const k of ['CountDown', 'CheckPoint', 'Error'] as const) expect(bank.scripts[bank.ui[k]]).toBeDefined();
    expect(bank.scripts[bank.ui.CountDown].patches.map((p) => p.layers[0].s)).toEqual([
      'Audio/sound/44khz/General/3,2,1.wav',
      'Audio/sound/44khz/General/GO!.wav',
    ]);
    expect(Object.keys(bank.menu).sort()).toEqual(['Back', 'Error', 'Screeneffekt', 'Select', 'Step', 'Sweep', 'Tag', 'Unlock']);
    expect(bank.coDriver.masterVolume).toBeCloseTo(0.92, 6);
    expect(Object.keys(bank.coDriver.words).map(Number).sort((a, b) => a - b)).toEqual(WORDS.map((_, i) => i + 1));
    for (let i = 0; i < 41; i++) {
      const w = bank.coDriver.words[String(i + 1)];
      expect(w.phrase.toLowerCase()).toBe(WORDS[i].toLowerCase());
      expect(bank.samples[w.s].rate).toBe(11025);
    }
    expect(Object.keys(bank.coDriver.coach).length).toBe(51);
  });

  it('createSoundBank: lazy load + decode at the native rate, case-insensitive keys', async () => {
    const made: { ch: number; frames: number; rate: number }[] = [];
    const fake = {
      createBuffer(ch: number, frames: number, rate: number) {
        made.push({ ch, frames, rate });
        const data = Array.from({ length: ch }, () => new Float32Array(frames));
        return { numberOfChannels: ch, length: frames, sampleRate: rate, duration: frames / rate, copyToChannel: (src: Float32Array, c: number) => data[c].set(src), getChannelData: (c: number) => data[c] } as unknown as AudioBuffer;
      },
    };
    const sb = createSoundBank(bank, fake);
    const k = bank.coDriver.words['14'].s;
    expect(sb.sample(k)).toBeNull();
    await sb.load([k, k.toUpperCase(), 'nope.wav']);
    const b = sb.sample(k.toLowerCase());
    expect(b).not.toBeNull();
    expect(b!.sampleRate).toBe(11025);
    expect(b!.length).toBe(bank.samples[k].frames);
    expect(made.length).toBe(1);
    expect(sb.pending).toBe(0);
  });
});

describe.skipIf(!hasAudio || !fs.existsSync(DUMP))('built bank ≡ the verified research dump (sound_dump.json)', () => {
  let bank: AudioBankJson;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dump: any;
  beforeAll(async () => {
    useBuiltAssets();
    bank = (await loadBankJson())!;
    dump = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
  });
  afterAll(() => _setAssetFetchForTests(null));

  it('every layer and every effect parameter equals the dump', () => {
    let effects = 0;
    expect(Object.keys(bank.scripts).sort()).toEqual(Object.keys(dump.scripts).sort());
    for (const [k, s] of Object.entries(bank.scripts)) {
      const ds = dump.scripts[k];
      expect(s.patches.length, k).toBe(ds.patches.length);
      s.patches.forEach((p, pi) => {
        const dp = ds.patches[pi];
        expect(p.layers.length).toBe(dp.layers.length);
        p.layers.forEach((l, li) => {
          const dl = dp.layers[li];
          expect([l.loop, l.is3d, l.volume, l.minDistance, l.doppler, l.rsp, l.rel], `${k}#${pi}.${li}`).toEqual([
            dl.loop, dl.is3d, dl.volume, dl.minDistance, dl.doppler, dl.randomStartPitch, dl.relativePosition,
          ]);
          expect(l.s).toBe(dl.resolved['44khz'] ?? null);
          const dfx = dl.effects.filter((e: { dest: string | null }) => e.dest === 'Volume' || e.dest === 'Pitch');
          expect(l.fx.length).toBe(dfx.length);
          l.fx.forEach((e, ei) => {
            expect(e.p).toEqual(dfx[ei].effective);
            effects++;
          });
        });
      });
    }
    expect(effects).toBe(3685);
  });

  it('sample frames / rates / channels equal the WAV census; car folders, slots, placements and words equal the dump', () => {
    for (const [k, e] of Object.entries(bank.samples)) {
      const c = dump.wavCensus.files[k];
      expect(c, k).toBeDefined();
      expect([e.frames, e.rate, e.ch]).toEqual([c.frames, c.rate, c.channels]);
    }
    for (const [car, c] of Object.entries(bank.cars)) {
      expect(`Audio/sound/44khz/Cars/${c.sampleFolder}`).toBe(dump.carSoundPlayers[car].carSampleDirs[0]);
    }
    for (const [m, v] of Object.entries(dump.materialSurfaceSlot) as [string, { slot: number | null }][]) {
      expect(bank.materialSlot[Number(m)] ?? null).toBe(v.slot ?? null);
    }
    let placed = 0;
    for (const [arch, counts] of Object.entries(dump.environmentSounds.placementsPerStage) as [string, Record<string, number>][]) {
      placed += Object.values(counts).reduce((a, b) => a + b, 0);
      void arch;
    }
    expect(placed).toBe(793);
    for (const [id, w] of Object.entries(dump.coDriver.paceNotes.samples) as [string, { resolved: string }][]) {
      expect(bank.coDriver.words[id].s).toBe(w.resolved);
    }
  });
});
