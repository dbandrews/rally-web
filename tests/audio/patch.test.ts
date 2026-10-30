// The patch engine life cycle (research/formats/sound.md §3.3-§3.4 + Verification): the 15 Hz sound tick, play()
// idempotence, release() semantics (X-Fade loops keep fading, the rest stops; a second release is a no-op; play
// after release restarts), vol ≤ 0 stops / restarts loops from sample 0, one-shots once per play(), randomPlay
// shuffle bags, randomStartPitch, the Distance / Time / TimeRelease sources.
import { describe, expect, it } from 'vitest';
import { MsvcRand } from '../../src/audio/orig/rand';
import { PatchInstance, SOUND_TICK_HZ, ScriptInstance, SoundSystem } from '../../src/audio/orig/patch';
import { fxRamp, layer, patch, RecBackend } from './helpers';

const TICK = 1 / SOUND_TICK_HZ;
const VOL = 0;
const PITCH = 1;
const S_EXTERN = 1;
const S_DISTANCE = 4;
const S_TIME = 6;
const S_TREL = 7;

function sys() {
  const be = new RecBackend();
  return { be, sys: new SoundSystem(be, 1) };
}

describe('sound tick (FUN_00406370, 15 Hz)', () => {
  it('accumulates frame dt and updates with the whole elapsed time once it reaches 1/15 s', () => {
    const { sys: s } = sys();
    const p = new PatchInstance(s, patch([layer('a', { loop: true })]));
    p.play();
    expect(s.advance(0.03)).toBe(false);
    expect(p.time).toBe(0);
    expect(s.advance(0.04)).toBe(true);
    expect(p.time).toBeCloseTo(0.07, 12);
    for (let i = 0; i < 15; i++) s.advance(1 / 60);
    expect(s.ticks).toBe(1 + 3); // 60 fps → a tick every 4th frame
  });
});

describe('play / release (patch vtable 0x83bd70)', () => {
  it('play() is idempotent while a looping patch is active: Time keeps running', () => {
    const { be, sys: s } = sys();
    const p = new PatchInstance(s, patch([layer('loop', { loop: true })]));
    p.play();
    s.tick(TICK);
    for (let i = 0; i < 5; i++) {
      p.play();
      s.tick(TICK);
    }
    expect(p.time).toBeCloseTo(6 * TICK, 12);
    expect(be.starts('loop')).toBe(1);
    expect(be.live().length).toBe(1);
  });

  it('a one-shot plays once per play(); the patch goes idle when its voice ends', () => {
    const { be, sys: s } = sys();
    const p = new PatchInstance(s, patch([layer('shot')]));
    p.play();
    s.tick(TICK);
    s.tick(TICK);
    expect(be.starts('shot')).toBe(1);
    be.voices[0].end();
    s.tick(TICK);
    expect(p.isActive()).toBe(false);
    expect(s.livePatches.length).toBe(0);
    p.play();
    s.tick(TICK);
    expect(be.starts('shot')).toBe(2);
  });

  it('release(): loops without a Volume←TimeRelease effect stop at once, X-Fade loops fade by their ramp', () => {
    const { be, sys: s } = sys();
    const xfade = fxRamp(VOL, S_TREL, 0, [0, 0.1, 1, -1]); // 1 → 0 over 0.1 s after release (PipeBoost / Whine)
    const p = new PatchInstance(s, patch([layer('plain', { loop: true }), layer('fade', { loop: true, fx: [xfade] })]));
    p.play();
    s.tick(TICK);
    expect(be.live().map((v) => v.layer.s)).toEqual(['plain', 'fade']);
    p.release();
    expect(be.live().map((v) => v.layer.s)).toEqual(['fade']);
    expect(p.timeRelease).toBe(0);
    expect(p.active).toBe(false);
    s.tick(0.05);
    const fade = be.voices[1];
    expect(fade.last!.volume).toBeCloseTo(0.5, 12);
    p.release(); // no-op once released
    expect(p.timeRelease).toBeCloseTo(0.05, 12);
    s.tick(0.06); // TimeRelease 0.11 → volume 0 → voice stopped
    expect(fade.stopped).toBe(true);
    s.tick(TICK);
    expect(s.livePatches.length).toBe(0);
  });

  it('release(); play() restarts the patch and its still-fading loops from sample 0 (the original retrigger)', () => {
    const { be, sys: s } = sys();
    const xfade = fxRamp(VOL, S_TREL, 0, [0, 0.5, 1, -1]);
    const p = new PatchInstance(s, patch([layer('fade', { loop: true, fx: [xfade] })]));
    p.play();
    s.tick(TICK);
    s.tick(TICK);
    p.release();
    s.tick(TICK);
    expect(be.live().length).toBe(1);
    p.play();
    expect(be.voices[0].stopped).toBe(true);
    expect(p.time).toBe(0);
    expect(p.timeRelease).toBe(-1);
    s.tick(TICK);
    expect(be.starts('fade')).toBe(2);
  });

  it('Release-trigger layers sound only after release() (while a fading loop keeps the patch live; unused by the data)', () => {
    const { be, sys: s } = sys();
    const xfade = fxRamp(VOL, S_TREL, 0, [0, 0.5, 1, -1]);
    const p = new PatchInstance(s, patch([layer('main', { loop: true, fx: [xfade] }), layer('tail', { trigger: 1 })]));
    p.play();
    s.tick(TICK);
    expect(be.starts('tail')).toBe(0);
    p.release();
    s.tick(TICK);
    expect(be.starts('tail')).toBe(1);
  });

  it('vol ≤ 0 stops the voice; a loop restarts from sample 0 when audible again', () => {
    const { be, sys: s } = sys();
    const byExt = fxRamp(VOL, S_EXTERN, 0, [0, 1, 0, 1]);
    const p = new PatchInstance(s, patch([layer('loop', { loop: true, fx: [byExt] })]));
    p.setExtern(0, 1);
    p.play();
    s.tick(TICK);
    expect(be.starts('loop')).toBe(1);
    p.setExtern(0, 0);
    s.tick(TICK);
    expect(be.voices[0].stopped).toBe(true);
    p.setExtern(0, 0.5);
    s.tick(TICK);
    expect(be.starts('loop')).toBe(2);
    expect(be.voices[1].last!.volume).toBeCloseTo(0.5, 12);
  });

  it('the Time source runs from play(); patch.volume multiplies; 3-D layers get the emitter pose × relativePosition', () => {
    const { be, sys: s } = sys();
    const t = fxRamp(VOL, S_TIME, 0, [0, 0.7, 0.2, 1]); // EngineThrottle's `param 0 .7 .2 1`
    const p = new PatchInstance(s, patch([layer('eng', { loop: true, fx: [t], rel: [0, 0, 2] })]));
    p.volume = 0.5;
    // yaw 90° (SIM, left-handed): body +z (forward) → world +x
    const q = { w: Math.SQRT1_2, x: 0, y: Math.SQRT1_2, z: 0 };
    p.emitter = { pos: { x: 10, y: 1, z: 5 }, quat: q, vel: { x: 3, y: 0, z: 0 } };
    p.play();
    s.tick(0.35);
    const u = be.voices[0].last!;
    expect(u.volume).toBeCloseTo(0.5 * (0.2 + 0.5), 12);
    expect(u.pos!.x).toBeCloseTo(12, 9);
    expect(u.pos!.z).toBeCloseTo(5, 9);
    expect(u.vel).toEqual({ x: 3, y: 0, z: 0 });
    for (let i = 0; i < 10; i++) s.tick(TICK);
    expect(be.voices[0].last!.volume).toBeCloseTo(0.5 * 1.2, 12); // > 1 before the DS clamp is fine here
  });

  it('the Distance source is |emitter − listener| (0 without a listener)', () => {
    const { be, sys: s } = sys();
    const d = fxRamp(VOL, S_DISTANCE, 0, [30, 200, 1, -1]); // crowd fade 30 → 200 m
    const p = new PatchInstance(s, patch([layer('crowd', { loop: true, fx: [d] })]));
    p.emitter = { pos: { x: 0, y: 0, z: 0 }, quat: null, vel: { x: 0, y: 0, z: 0 } };
    p.play();
    s.tick(TICK);
    expect(be.voices[0].last!.volume).toBe(1);
    s.listener = { pos: { x: 0, y: 0, z: 115 }, vel: { x: 0, y: 0, z: 0 } };
    s.tick(TICK);
    expect(be.voices[0].last!.volume).toBeCloseTo(0.5, 12);
    s.listener.pos.z = 250;
    s.tick(TICK);
    expect(be.voices[0].stopped).toBe(true);
  });

  it('pitch = Π pitch effects + the per-voice randomStartPitch offset rand()·(a+b)/32767 − a', () => {
    const { be, sys: s } = sys();
    const pc = fxRamp(PITCH, 0, 0, [0, 0, 0.9, 0]);
    const p = new PatchInstance(s, patch([layer('cow', { rsp: [0.15, 0], fx: [pc] })]));
    p.play();
    s.tick(TICK);
    const r = new MsvcRand(1).next();
    expect(be.voices[0].last!.pitch).toBeCloseTo(0.9 + (r * 0.15) / 32767 - 0.15, 12);
  });

  it('a missing sample is silent (the original failed load) and does not break the patch', () => {
    const { be, sys: s } = sys();
    be.missing.add('Idleoutside');
    const p = new PatchInstance(s, patch([layer('Idleoutside', { loop: true }), layer('Rumble', { loop: true })]));
    p.play();
    s.tick(TICK);
    expect(be.live().map((v) => v.layer.s)).toEqual(['Rumble']);
  });
});

describe('randomPlay shuffle bag (FUN_007eb5c0)', () => {
  it('n of the layers per play(); each bag is a permutation; a new bag never starts on the last-played layer', () => {
    const { sys: s } = sys();
    const p = new PatchInstance(s, patch([layer('b1'), layer('b2'), layer('b3'), layer('b4'), layer('b5')], 1));
    const picks: number[] = [];
    for (let k = 0; k < 500; k++) {
      p.play();
      picks.push(...p.selectedLayers);
    }
    expect(picks.length).toBe(500);
    for (let b = 0; b < 100; b++) expect([...picks.slice(b * 5, b * 5 + 5)].sort()).toEqual([0, 1, 2, 3, 4]);
    for (let b = 1; b < 100; b++) {
      expect(picks[b * 5]).not.toBe(picks[b * 5 - 1]); // refill: random pick from the others first
      expect(picks[b * 5 + 1]).toBe(picks[b * 5 - 1]); // … then the previous bag's last at position 1
    }
  });

  it('only the drawn layers sound', () => {
    const { be, sys: s } = sys();
    const p = new PatchInstance(s, patch([layer('h1'), layer('h2'), layer('h3')], 1));
    p.play();
    s.tick(TICK);
    expect(be.voices.length).toBe(1);
    expect(be.voices[0].layer.s).toBe(['h1', 'h2', 'h3'][p.selectedLayers[0]]);
  });
});

describe('ScriptInstance', () => {
  it('setExtern / release / setVolume reach every patch; playPatch(n) plays one', () => {
    const { be, sys: s } = sys();
    const sc = new ScriptInstance(s, { patches: [patch([layer('p0', { loop: true })]), patch([layer('p1')])] }, 'k', null);
    sc.setExtern(6, 42);
    sc.setVolume(0.3);
    expect(sc.patches.every((p) => p.ext[6] === 42 && p.volume === 0.3)).toBe(true);
    sc.playPatch(1);
    s.tick(TICK);
    expect(be.voices.map((v) => v.layer.s)).toEqual(['p1']);
    expect(sc.isActive()).toBe(true);
    sc.kill();
    expect(sc.isActive()).toBe(false);
  });
});
