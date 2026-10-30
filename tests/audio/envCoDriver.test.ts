// Stage ambience (envSound.ts, FUN_00797480 / FUN_007960c0 / FUN_007979c0) and the co-driver word player
// (coDriver.ts + src/ui/voice.ts), research/formats/sound.md §8 / §10.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AudioBankJson } from '../../src/audio/orig/bankTypes';
import { CoDriverPlayer, type CoDriverOutput, getCoDriverOutput, setCoDriverOutput } from '../../src/audio/orig/coDriver';
import { ENV_RANGE_M, ENV_STILL_LIMIT, ENV_STILL_STEP, EnvSoundManager } from '../../src/audio/orig/envSound';
import { loadBankJson } from '../../src/audio/orig/index';
import { SoundSystem } from '../../src/audio/orig/patch';
import { _setAssetFetchForTests } from '../../src/core/assets';
import type { Pacenote } from '../../src/core/types';
import { CoDriverVoice } from '../../src/ui/voice';
import { BUILT_ASSETS_DIR, builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';
import { RecBackend, fxRamp, layer, patch } from './helpers';

interface Fs {
  existsSync(p: string): boolean;
}
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;
const hasAudio = builtAssetsPresent && fs.existsSync(`${BUILT_ASSETS_DIR}/global/audio.json`);

function envBank(): AudioBankJson {
  const fade = fxRamp(0, 4, 0, [30, 200, 1, -1]);
  return {
    scripts: {
      crowd: { patches: [patch([layer('crowd.wav', { loop: true, fx: [fade] })])] },
      cow: { patches: [patch([layer('cow1.wav', { rsp: [0.15, 0] }), layer('cow2.wav', { rsp: [0.15, 0] })], 1)] },
    },
    env: {
      templates: { EnvSoundBigCrowd1: 'crowd', EnvSoundCow: 'cow' },
      objectSounds: {},
      placements: {
        stage: [
          ['EnvSoundBigCrowd1', 0, 0, 100],
          ['EnvSoundCow', 0, 0, 0],
          ['EnvSoundMissing', 0, 0, 0],
        ],
      },
    },
  } as unknown as AudioBankJson;
}

describe('EnvSoundManager', () => {
  it('looping patches start at object creation (FUN_00797480); one-shots only roll within 60 m', () => {
    const be = new RecBackend();
    const sys = new SoundSystem(be, 3);
    const m = new EnvSoundManager(sys, envBank(), 'stage');
    expect(m.objects.map((o) => [o.template, o.looping])).toEqual([
      ['EnvSoundBigCrowd1', true],
      ['EnvSoundCow', false],
    ]);
    expect(m.objects[0].script.patch(0)!.active).toBe(true);
    sys.listener = { pos: { x: 0, y: 0, z: 400 }, vel: { x: 0, y: 0, z: 0 } };
    sys.tick(1 / 15);
    expect(be.voices.length).toBe(0); // the crowd is beyond its Distance fade
    // far car: the cow never rolls
    for (let i = 0; i < 300; i++) m.update([{ x: 0, y: 0, z: ENV_RANGE_M + 1 + i * 1e-3 }]);
    expect(m.objects[1].script.patch(0)!.isActive()).toBe(false);
    // near car (moving): rand() % 20 == 0 starts it within a few dozen updates
    let n = 0;
    while (!m.objects[1].script.patch(0)!.isActive() && n < 1000) m.update([{ x: 0, y: 0, z: 10 + ++n * 1e-3 }]);
    expect(n).toBeLessThan(1000);
    expect(n).toBeGreaterThan(0);
    // the listener walks into the crowd: its loop becomes audible
    sys.listener.pos.z = 120;
    sys.tick(1 / 15);
    expect(be.voices.some((v) => v.layer.s === 'crowd.wav' && v.playing)).toBe(true);
  });

  it('a car standing exactly still for 90 updates (0.2 per update ≥ 18) stops the re-rolls', () => {
    const be = new RecBackend();
    const sys = new SoundSystem(be, 3);
    const m = new EnvSoundManager(sys, envBank(), 'stage');
    const still = { x: 0, y: 0, z: 5 };
    for (let i = 0; i < Math.ceil(ENV_STILL_LIMIT / ENV_STILL_STEP) + 2; i++) m.update([still]);
    expect(m.still).toBeGreaterThanOrEqual(ENV_STILL_LIMIT);
    const cow = m.objects[1].script.patch(0)!;
    cow.kill();
    for (let i = 0; i < 500; i++) m.update([still]);
    expect(cow.isActive()).toBe(false);
    m.update([{ x: 0, y: 0, z: 5.5 }]);
    expect(m.still).toBe(0);
  });
});

describe.skipIf(!hasAudio)('EnvSoundManager on real stages', () => {
  let bank: AudioBankJson;
  beforeAll(async () => {
    useBuiltAssets();
    bank = (await loadBankJson())!;
  });
  afterAll(() => _setAssetFetchForTests(null));

  it('every stage builds its placements; crowd / applause loops start, cows / sheep / horns wait for a car', () => {
    let total = 0;
    for (const id of Object.keys(bank.env.placements)) {
      const m = new EnvSoundManager(new SoundSystem(new RecBackend(), 1), bank, id);
      total += m.objects.length;
      for (const o of m.objects) {
        const loop = /Crowd|Applause/.test(o.template);
        expect(o.looping, `${id} ${o.template}`).toBe(loop);
        expect(o.script.patch(0)!.active).toBe(loop);
      }
      m.dispose();
    }
    expect(total).toBe(793);
  });
});

// ------------------------------------------------------------------------------------------- co-driver

function coDriver(loadedOk = (k: string) => k !== 'w5.wav') {
  const be = new RecBackend();
  const sys = new SoundSystem(be, 1);
  const p = new CoDriverPlayer(sys, (id) => (id >= 1 && id <= 41 ? `w${id}.wav` : null), loadedOk, 0.92);
  /** one frame: the pacenote player update (FUN_0067a250) then the sound system (15 Hz tick on 1/15 s frames) */
  const frame = () => {
    p.update();
    sys.advance(1 / 15);
  };
  const sounding = () => be.live().map((v) => v.layer.s);
  const endAll = () => be.live().forEach((v) => v.end());
  return { be, sys, p, frame, sounding, endAll };
}

describe('CoDriverPlayer (FUN_0067a190 / FUN_0067a250)', () => {
  it('speaks the words one after the other: the next word starts once the previous word patch is inactive', () => {
    const c = coDriver();
    c.p.say([14, 18, 1]);
    expect(c.p.speaking).toEqual([14, 18, 1]);
    c.sys.advance(1 / 15); // the voice starts at the next sound tick
    expect(c.sounding()).toEqual(['w14.wav']);
    expect(c.be.voices[0].layer.is3d).toBe(false);
    expect(c.be.voices[0].last!.volume).toBeCloseTo(0.92, 12); // setPaceNoteMasterVolume × slider 4 (1)
    c.frame();
    c.frame();
    expect(c.sounding()).toEqual(['w14.wav']); // still speaking: no advance
    c.endAll();
    c.frame(); // the update notices the end → plays w18 → its voice starts on this frame's tick
    expect(c.sounding()).toEqual(['w18.wav']);
    expect(c.p.speaking).toEqual([18, 1]);
    c.endAll();
    c.frame();
    c.endAll();
    c.frame();
    expect(c.p.speaking).toBeNull();
    expect(c.be.voices.map((v) => v.layer.s)).toEqual(['w14.wav', 'w18.wav', 'w1.wav']);
  });

  it('no queue: a new note replaces the one being spoken (the sounding word plays out)', () => {
    const c = coDriver();
    c.p.say([14, 18, 1]);
    c.sys.advance(1 / 15);
    c.p.say([2, 21]);
    c.sys.advance(1 / 15);
    expect(c.sounding()).toEqual(['w14.wav', 'w2.wav']);
    expect(c.p.speaking).toEqual([2, 21]);
  });

  it('a note whose first word is unknown is ignored; an unknown word ends the note there', () => {
    const c = coDriver();
    expect(c.p.canSay([99, 1])).toBe(false);
    expect(c.p.canSay([5, 1])).toBe(false); // sample not loaded → synthesized fallback in voice.ts
    expect(c.p.canSay([1, 99])).toBe(true);
    c.p.say([99, 1]);
    expect(c.p.speaking).toBeNull();
    c.p.say([1, 99, 2]);
    expect(c.p.speaking).toEqual([1]);
  });

  it('+0x38 (pause): a sounding word is released and skipped, no new word starts', () => {
    const c = coDriver();
    c.p.say([14, 18, 1]);
    c.sys.advance(1 / 15);
    c.p.setPaused(true);
    c.p.update();
    expect(c.be.voices[0].stopped).toBe(true);
    expect(c.p.speaking).toEqual([18, 1]);
    c.p.update();
    c.p.update();
    expect(c.p.speaking).toBeNull();
    c.sys.advance(1 / 15);
    expect(c.be.voices.length).toBe(1);
    c.p.setPaused(false);
    c.p.say([3]);
    c.p.stop();
    c.sys.advance(1 / 15);
    expect(c.sounding()).toEqual([]);
  });
});

describe('CoDriverVoice (src/ui/voice.ts)', () => {
  afterEach(() => setCoDriverOutput(null));
  const note = (words?: number[]): Pacenote => ({ s: 0, cornerS: 100, text: '3 left', direction: 'left', severity: 3, modifiers: [], ...(words ? { origWords: words } : {}) });

  it('plays Pacenote.origWords through the original co-driver when every word is loaded, else falls back', () => {
    const said: number[][] = [];
    let paused = false;
    let stops = 0;
    const out: CoDriverOutput = {
      canSay: (w) => !w.includes(99),
      say: (w) => said.push([...w]),
      setPaused: (p) => (paused = p),
      stop: () => stops++,
      speaking: null,
    };
    const v = new CoDriverVoice();
    expect(getCoDriverOutput()).toBeNull();
    v.say(note([14, 1])); // no output registered: synthesized fallback (speech is absent in node: silent)
    expect(said).toEqual([]);
    setCoDriverOutput(out);
    expect(v.available).toBe(true);
    v.say(note([14, 18, 1]));
    v.say(note()); // procedural note without words → synthesized voice
    v.say(note([14, 99])); // a word sample not loaded → synthesized voice
    expect(said).toEqual([[14, 18, 1]]);
    v.setPaused(true);
    expect(paused).toBe(true);
    v.stop();
    expect(stops).toBe(1);
  });
});
