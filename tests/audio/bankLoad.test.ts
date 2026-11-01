// Bank loading (src/audio/orig/index.ts): parallel fetch cap, priority order, and the per-frame decode budget — on a stub
// fetch and a stub buffer factory (no assets, no Web Audio).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioBankJson } from '../../src/audio/orig/bankTypes';
import { type BufferFactory, createSoundBank } from '../../src/audio/orig/index';
import { _setAssetFetchForTests } from '../../src/core/assets';

const FRAMES = 8;

function wavBytes(): ArrayBuffer {
  const pcm = FRAMES * 2;
  const out = new Uint8Array(44 + pcm);
  const dv = new DataView(out.buffer);
  out.set([82, 73, 70, 70], 0); // RIFF
  dv.setUint32(4, 36 + pcm, true);
  out.set([87, 65, 86, 69, 102, 109, 116, 32], 8); // WAVEfmt 
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 22050, true);
  dv.setUint32(28, 44100, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  out.set([100, 97, 116, 97], 36); // data
  dv.setUint32(40, pcm, true);
  for (let i = 0; i < FRAMES; i++) dv.setInt16(44 + i * 2, i * 1000, true);
  return out.buffer;
}

function bankJson(n: number): AudioBankJson {
  const samples: AudioBankJson['samples'] = {};
  for (let i = 0; i < n; i++) samples[`s${i}`] = { f: `audio/s${i}.wav`, rate: 22050, ch: 1, frames: FRAMES, loop: [0, FRAMES] };
  return { samples, scripts: {} } as unknown as AudioBankJson;
}

const factory: BufferFactory = {
  createBuffer: (ch, frames, rate) => {
    const chans = Array.from({ length: ch }, () => new Float32Array(frames));
    return { numberOfChannels: ch, length: frames, sampleRate: rate, copyToChannel: (d: Float32Array, c: number) => chans[c].set(d) } as unknown as AudioBuffer;
  },
};

/** A fetch whose responses the test releases by hand (request order recorded). */
function gatedFetch() {
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  _setAssetFetchForTests(((url: string) => {
    const name = /s\d+/.exec(url)![0];
    order.push(name);
    return new Promise<Response>((resolve) => gates.set(name, () => resolve(new Response(wavBytes(), { status: 200 }))));
  }) as unknown as Parameters<typeof _setAssetFetchForTests>[0]);
  return { order, open: (name: string) => gates.get(name)?.() };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  // the manifest is not needed: samples go through fetchArrayBuffer only
});
afterEach(() => {
  _setAssetFetchForTests(null);
  vi.useRealTimers();
});

describe('Bank fetch scheduling', () => {
  it('keeps at most 12 downloads in flight and starts the queued ones highest priority first', async () => {
    const f = gatedFetch();
    const bank = createSoundBank(bankJson(30), factory);
    const keys = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => `s${a + i}`);
    void bank.load(keys(0, 12)); // fills the slots
    void bank.load(keys(12, 20), 1);
    void bank.load(keys(20, 22), 5); // later, but more urgent
    void bank.load(keys(22, 24), 3);
    await flush();
    expect(f.order).toHaveLength(12);
    expect(bank.pending).toBe(24);
    // free three slots: the urgent ones go first, then priority 3, then the rest FIFO
    for (const k of ['s0', 's1', 's2', 's3', 's4', 's5']) f.open(k);
    await flush();
    expect(f.order.slice(12)).toEqual(['s20', 's21', 's22', 's23', 's12', 's13']);
  });

  it('asking again with a higher priority moves a queued sample up', async () => {
    const f = gatedFetch();
    const bank = createSoundBank(bankJson(20), factory);
    void bank.load(Array.from({ length: 12 }, (_, i) => `s${i}`));
    void bank.load(['s12', 's13', 's14'], 1);
    void bank.load(['s14'], 4);
    await flush();
    f.open('s0');
    f.open('s1');
    await flush();
    expect(f.order.slice(12)).toEqual(['s14', 's12']);
  });

  it('settles load() for a failing sample and counts pending down', async () => {
    _setAssetFetchForTests((async () => new Response('nope', { status: 404 })) as unknown as Parameters<typeof _setAssetFetchForTests>[0]);
    const bank = createSoundBank(bankJson(3), factory);
    await bank.load(['s0', 's1', 'unknown']);
    expect(bank.pending).toBe(0);
    expect(bank.sample('s0')).toBeNull();
  });
});

describe('Bank decode budget', () => {
  function instantFetch() {
    _setAssetFetchForTests((async () => new Response(wavBytes(), { status: 200 })) as unknown as Parameters<typeof _setAssetFetchForTests>[0]);
  }
  const loaded = (bank: ReturnType<typeof createSoundBank>, n: number) => Array.from({ length: n }, (_, i) => bank.sample(`s${i}`)).filter(Boolean).length;

  it('decodes at once without a budget', async () => {
    instantFetch();
    const bank = createSoundBank(bankJson(5), factory);
    await bank.load(['s0', 's1', 's2', 's3', 's4']);
    expect(loaded(bank, 5)).toBe(5);
    expect(bank.sample('s3')!.length).toBe(FRAMES);
  });

  it('spreads finished downloads over several frames under a budget, and drains when it is lifted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // real performance.now: the budget is measured
    instantFetch();
    const bank = createSoundBank(bankJson(6), factory);
    bank.setDecodeBudget(1e-9); // every task spends more than this: one decode per frame
    const all = bank.load(['s0', 's1', 's2', 's3', 's4', 's5']);
    await vi.advanceTimersByTimeAsync(0);
    expect(loaded(bank, 6)).toBe(1); // downloaded, queued; one decoded per frame
    expect(bank.pending).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(loaded(bank, 6)).toBe(2);
    bank.setDecodeBudget(Infinity);
    await vi.advanceTimersByTimeAsync(1);
    await all;
    expect(loaded(bank, 6)).toBe(6);
    expect(bank.pending).toBe(0);
  });

  it('a roomy budget decodes several per frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // real performance.now: the budget is measured
    instantFetch();
    const bank = createSoundBank(bankJson(6), factory);
    bank.setDecodeBudget(1000);
    const all = bank.load(['s0', 's1', 's2', 's3', 's4', 's5']);
    await vi.advanceTimersByTimeAsync(1);
    await all;
    expect(loaded(bank, 6)).toBe(6);
  });

  it('dispose settles queued decodes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // real performance.now: the budget is measured
    instantFetch();
    const bank = createSoundBank(bankJson(3), factory);
    bank.setDecodeBudget(1e-9);
    const all = bank.load(['s0', 's1', 's2']);
    await vi.advanceTimersByTimeAsync(0);
    bank.dispose();
    await vi.advanceTimersByTimeAsync(5);
    await all;
    expect(bank.pending).toBe(0);
    expect(bank.sample('s2')).toBeNull();
  });
});
