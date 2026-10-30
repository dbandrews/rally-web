// The CarSoundPlayer (research/formats/sound.md §4, update 0x7465f0) on the REAL built scripts with a recording
// backend: which layers sound for idle / throttle / lift / shifts / surfaces / impacts / inside vs outside, the
// sound-rpm jitter (FUN_00746a00) and the telemetry mapping (carInput.ts). Real-data parts skip without the packs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AudioBankJson } from '../../src/audio/orig/bankTypes';
import { CarInputMapper, dominantMaterial, IMPULSE_PER_STRENGTH, wheelMaterials } from '../../src/audio/orig/carInput';
import { type CarSoundInput, CarSoundPlayer } from '../../src/audio/orig/carSound';
import { loadBankJson } from '../../src/audio/orig/index';
import { SoundSystem } from '../../src/audio/orig/patch';
import { ParkMiller } from '../../src/audio/orig/rand';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { MATERIAL, ORIG_MATERIAL_NAMES, materialFromOrig } from '../../src/core/constants';
import type { FrameContext } from '../../src/core/types';
import { BUILT_ASSETS_DIR, builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';
import { RecBackend } from './helpers';

interface Fs {
  existsSync(p: string): boolean;
}
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;
const hasAudio = builtAssetsPresent && fs.existsSync(`${BUILT_ASSETS_DIR}/global/audio.json`);

function input(o: Partial<CarSoundInput> = {}): CarSoundInput {
  return {
    rpm: 900,
    speedKmh: 0,
    throttle: 0,
    brake: 0,
    handbrake: 0,
    gear: 1,
    wheelMaterial: [1, 1, 1, 1],
    slipX: [0, 0, 0, 0],
    slipZ: [0, 0, 0, 0],
    bump: [1, 1, 1, 1],
    outside: true,
    raining: false,
    impact: null,
    inBush: false,
    pos: { x: 0, y: 0, z: 0 },
    quat: { w: 1, x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    ...o,
  };
}

const base = (s: string | null) => (s ? s.split('/').pop()! : '');

describe.skipIf(!hasAudio)('CarSoundPlayer on the real ImprezaWRX scripts', () => {
  let bank: AudioBankJson;
  beforeAll(async () => {
    useBuiltAssets();
    bank = (await loadBankJson())!;
  });
  afterAll(() => _setAssetFetchForTests(null));

  function rig(car = 'ImprezaWRX') {
    const be = new RecBackend();
    const sys = new SoundSystem(be, 7);
    sys.listener = { pos: { x: 0, y: 2, z: -5 }, vel: { x: 0, y: 0, z: 0 } };
    const p = new CarSoundPlayer(sys, bank, car, true, 7);
    const run = (secs: number, inp: CarSoundInput) => {
      for (let t = 0; t < secs - 1e-9; t += 1 / 60) {
        p.update(1 / 60, inp);
        sys.advance(1 / 60);
      }
    };
    const sounding = () => new Set(be.live().map((v) => base(v.layer.s)));
    return { be, sys, p, run, sounding };
  }

  it('idle: Engine.ssc (Idleoutside; Rumble3 from 1000 rpm) and the off-throttle Pipe loops play; inside cam → Idleinside', () => {
    const r = rig();
    r.run(1, input());
    const s = r.sounding();
    expect(s.has('Idleoutside.wav')).toBe(true);
    expect(s.has('Rumble3.wav')).toBe(false); // Volume ← Rpm Ramp 1000 4000 0 1: silent at 900 rpm
    r.run(0.3, input({ rpm: 1500 }));
    const s1 = r.sounding();
    expect(s1.has('Rumble3.wav')).toBe(true);
    expect(s1.has('Pipereleaseloop1.wav')).toBe(true); // Volume ← Rpm Ramp 1000 3100 0 1
    expect(s1.has('Engine1.wav')).toBe(false); // the on-throttle set is released while lifted
    r.run(0.5, input({ outside: false }));
    const s2 = r.sounding();
    expect(s2.has('Idleinside.wav')).toBe(true);
    expect(s2.has('Idleoutside.wav')).toBe(false);
  });

  it('throttle on: EngineThrottle (Engine1/2, Pipeloop, Pistons) plays, the boost band restarts, Pipe is released', () => {
    const r = rig();
    r.run(1.5, input());
    r.run(0.5, input({ throttle: 1, rpm: 4000, speedKmh: 40 }));
    const s = r.sounding();
    expect([...s].some((n) => /^Engine[12]\.wav$/i.test(n))).toBe(true);
    expect([...s].some((n) => /^Pipeloop[12]\.wav$/i.test(n))).toBe(true);
    expect(s.has('Pistons.wav')).toBe(false); // Volume ← Rpm Ramp 5000 9000: from 5000 rpm
    expect([...s].some((n) => /^Pipereleaseloop/i.test(n))).toBe(false);
    // PipeBoost2 (rpm band 2500–5000) got a voice on the throttle-on edge
    expect(r.be.voices.some((v) => /Pipeboost2\.wav$/i.test(v.layer.s ?? ''))).toBe(true);
    // the EngineThrottle pitch follows Ramp 1000 9400 0.45 0.55 2 1.2 of the sound rpm
    const e1 = r.be.live().find((v) => /Engine1\.wav$/i.test(v.layer.s ?? ''))!;
    const rpm = r.p.soundRpm;
    const t = (rpm - 1000) / 8400;
    expect(e1.last!.pitch).toBeCloseTo(0.45 + 0.55 * Math.pow(t, 1.2), 9);
  });

  it('lift: EngineThrottle stops at once, the Pipe loops and an overrun pop (band by rpm) start', () => {
    const r = rig();
    r.run(1.5, input({ throttle: 1, rpm: 6000, speedKmh: 80 }));
    const before = r.be.voices.length;
    r.run(0.2, input({ throttle: 0, rpm: 6000, speedKmh: 80 }));
    const s = r.sounding();
    expect([...s].some((n) => /^Engine[12]\.wav$/i.test(n))).toBe(false);
    expect([...s].some((n) => /^Pipereleaseloop/i.test(n))).toBe(true);
    const fresh = r.be.voices.slice(before).map((v) => base(v.layer.s));
    expect(fresh.some((n) => /^Pipereleaseboost3\.wav$/i.test(n))).toBe(true); // 5000–13000 → band 3
  });

  it('a gear change plays GearShift.wav; the handbrake edge plays Handbrake.wav', () => {
    const r = rig();
    r.run(0.5, input({ throttle: 1, rpm: 5000, speedKmh: 50, gear: 2 }));
    r.run(0.3, input({ throttle: 1, rpm: 4000, speedKmh: 52, gear: 3 }));
    expect(r.be.starts('Audio/sound/44khz/General/GearShift.wav')).toBe(2); // 1→2 at the first update, 2→3
    r.run(0.3, input({ handbrake: 1 }));
    expect(r.be.starts('Audio/sound/44khz/General/Handbrake.wav')).toBe(1);
  });

  it('surfaces: every one of the 23 materials plays its WheelFriction slot patch (or nothing when silent)', () => {
    const wf = bank.scripts['Cars/cars/General/Sounds/WheelFriction.ssc'];
    for (let m = 0; m < 23; m++) {
      const r = rig();
      const heard = new Set<number>();
      const fr = r.p.scripts[19]!;
      // outside and inside camera (some slots have only inside layers, e.g. SnowChunky's Ouside step 1 1 1 −1)
      for (const outside of [true, false]) {
        r.run(0.5, input({ wheelMaterial: [m, m, m, m], speedKmh: 70, throttle: 0.5, rpm: 4000, outside }));
        fr.patches.forEach((p, i) => p.sounding().length && heard.add(i));
      }
      const slot = bank.materialSlot[m];
      const active = [...heard];
      if (slot === null) expect(active, ORIG_MATERIAL_NAMES[m]).toEqual([]);
      else {
        expect(active, ORIG_MATERIAL_NAMES[m]).toEqual([slot]);
        expect(fr.patches[slot].ext[8]).toBe(4); // Wheels = 4
        void wf;
      }
    }
  });

  it('a surface that is left is released; mixed wheels split the Wheels count', () => {
    const r = rig();
    r.run(0.5, input({ wheelMaterial: [1, 1, 2, 2], speedKmh: 70 }));
    const fr = r.p.scripts[19]!;
    expect(fr.patches[0].ext[8]).toBe(2);
    expect(fr.patches[4].ext[8]).toBe(2);
    r.run(0.5, input({ wheelMaterial: [2, 2, 2, 2], speedKmh: 70 }));
    expect(fr.patches[0].sounding()).toEqual([]);
    expect(fr.patches[4].ext[8]).toBe(4);
  });

  it('slides: WheelSlipX by slot follows SlipX of wheel 0 and Speed', () => {
    const r = rig();
    r.run(0.5, input({ wheelMaterial: [1, 1, 1, 1], speedKmh: 60, slipX: [0.8, 0, 0, 0] }));
    const sx = r.p.scripts[11]!;
    expect(sx.patches[0].sounding().length).toBe(1); // tarmac squeal (randomPlay 1 of s_t1..s_t5)
    expect(sx.patches[0].ext[3]).toBeCloseTo(0.8, 12);
  });

  it('impacts: hard ≥ 165, at most one per 0.5 s, Impulse extern = strength; Tree (WOOD) ≥ 5', () => {
    const r = rig();
    r.run(0.6, input());
    r.p.update(1 / 60, input({ impact: { type: 1, strength: 300 } }));
    r.sys.advance(1 / 15);
    const col = r.p.scripts[18]!;
    expect(col.patches[1].sounding().length).toBe(1);
    expect(col.patches[1].ext[7]).toBe(300);
    r.p.update(1 / 60, input({ impact: { type: 1, strength: 300 } }));
    r.sys.advance(1 / 15);
    const hard = r.be.voices.filter((v) => /Impact\/Hard/i.test(v.layer.s ?? '')).length;
    expect(hard).toBe(1); // gated
    const r2 = rig();
    r2.run(0.6, input());
    r2.p.update(1 / 60, input({ impact: { type: 1, strength: 100 } }));
    r2.sys.advance(1 / 15);
    expect(r2.p.scripts[18]!.patches[1].sounding().length).toBe(0);
    r2.run(0.6, input());
    r2.p.update(1 / 60, input({ impact: { type: 106, strength: 10 } }));
    r2.sys.advance(1 / 15);
    expect(r2.p.scripts[18]!.patches[5].sounding().length).toBe(1);
  });

  it('the body (hull) contact plays when no object record is set; the record wins; the bush rising edge plays Bush', () => {
    const r = rig();
    r.run(0.6, input());
    r.p.update(1 / 60, input({ body: { contact: true, type: 1, strength: 300 } }));
    r.sys.advance(1 / 15);
    const col = r.p.scripts[18]!;
    expect(col.patches[1].sounding().length).toBe(1); // Hard (ASPHALT under the hull)
    expect(col.patches[1].ext[7]).toBe(300);
    const r2 = rig();
    r2.run(0.6, input());
    // object record (a tree, collisionMaterial 6) and a hard hull contact in the same update: the record is read first
    r2.p.update(1 / 60, input({ impact: { type: 6, strength: 20 }, body: { contact: true, type: 1, strength: 300 } }));
    r2.sys.advance(1 / 15);
    expect(r2.p.scripts[18]!.patches[5].sounding().length).toBe(1);
    expect(r2.p.scripts[18]!.patches[1].sounding().length).toBe(0);
    const r3 = rig();
    r3.run(0.6, input());
    r3.p.update(1 / 60, input({ inBush: true, speedKmh: 30 }));
    r3.sys.advance(1 / 15);
    expect(r3.p.scripts[18]!.patches[0].sounding().length).toBe(1);
  });

  it('shared backfire / blow-out flags (src/game/carFlags.ts) replace the player-side rolls', () => {
    const r = rig();
    r.run(3, input({ throttle: 0, rpm: 6000, speedKmh: 90, backfire: false, blowOut: false }));
    expect(r.be.voices.some((v) => /General\/Bang\d\.wav$/.test(v.layer.s ?? ''))).toBe(false);
    r.p.update(1 / 60, input({ throttle: 0, rpm: 6000, speedKmh: 90, backfire: true, blowOut: false }));
    r.sys.advance(1 / 15);
    expect(r.be.voices.some((v) => /General\/Bang\d\.wav$/.test(v.layer.s ?? ''))).toBe(true);
  });

  it('backfire (0x753410) and blow-out (0x753550) flags fire PipeBoom / PipeBlowOut', () => {
    const r = rig();
    r.run(3, input({ throttle: 0, rpm: 6000, speedKmh: 90 }));
    expect(r.be.voices.some((v) => /General\/Bang\d\.wav$/.test(v.layer.s ?? ''))).toBe(true);
    for (let g = 1; g < 6; g++) r.run(0.25, input({ throttle: 1, rpm: 5000, speedKmh: 60 + g * 10, gear: g }));
    expect(r.be.voices.some((v) => /General\/Blowout\d\.wav$/.test(v.layer.s ?? ''))).toBe(true);
  });

  it('every original car builds a player; NissanSkyline has no outside idle (the load typo)', () => {
    for (const car of Object.keys(bank.cars)) {
      const r = rig(car);
      r.run(0.4, input({ rpm: 1500 }));
      expect(r.sounding().has('Rumble3.wav'), car).toBe(true);
    }
    const r = rig('NissanSkyline');
    r.run(0.4, input());
    expect([...r.sounding()].some((n) => /idle/i.test(n))).toBe(false);
  });
});

describe('sound rpm (FUN_00746a00)', () => {
  it('low-speed roughness on throttle between 2000 and 8500 rpm, |j| ≥ 10, ±2000, cap 8760', () => {
    const be = new RecBackend();
    const sys = new SoundSystem(be, 1);
    const empty = { patches: [] };
    const bank = {
      cars: { X: { template: 'X', player: new Array(20).fill(null), ai: [], engineDeltaDistance: 0, pipeDeltaDistance: 0, sampleFolder: null } },
      scripts: { e: empty },
      materialSlot: [],
      collision: { hard: [], snow: [], tree: [] },
    } as unknown as AudioBankJson;
    const p = new CarSoundPlayer(sys, bank, 'X', true, 99);
    const lcg = new ParkMiller(99);
    for (const [rpm, kmh, thr] of [
      [4000, 0, 1],
      [4000, 30, 0.5],
      [4000, 200, 1],
      [1500, 10, 1],
      [9000, 10, 0],
      [8400, 5, 1],
    ]) {
      p.update(1 / 60, input({ rpm, speedKmh: kmh, throttle: thr }));
      let expRpm = rpm;
      let k = kmh <= 350 ? 1 - kmh / (300 - kmh) : 0;
      k = Math.min(1, Math.max(0, k));
      if (thr > 0 && rpm > 2000 && rpm < 8500) {
        let j = k * ((lcg.next() % 1200) - 800);
        if (j > 0 && j < 10) j = 10;
        else if (j < 0 && j > -10) j = -10;
        j = Math.max(-2000, Math.min(2000, j));
        expRpm += thr * j;
      }
      expect(p.soundRpm).toBeCloseTo(Math.min(expRpm, 8760), 9);
    }
  });
});

describe('telemetry → CarSoundInput (carInput.ts)', () => {
  const wheel = (material: number, contact = true, o: Record<string, unknown> = {}) => ({
    contact,
    material,
    slipAngle: 0,
    kappa: 0,
    visual: { suspensionOffset: 0.1 },
    ...o,
  });
  const ctx = (o: Record<string, unknown> = {}) =>
    ({
      telemetry: {
        archetype: 'awd_wrc',
        rpm: 5000,
        speedKmh: 72,
        throttle: 0.7,
        brake: 0,
        handbrake: 0,
        gear: 3,
        impactImpulse: 0,
        wheels: [wheel(MATERIAL.tarmac, true, { slipAngle: Math.atan(0.4) }), wheel(MATERIAL.gravel, true, { kappa: -0.3 }), wheel(MATERIAL.gravel), wheel(MATERIAL.gravel, false)],
        posSim: { x: 1, y: 2, z: 3 },
        quatSim: { w: 1, x: 0, y: 0, z: 0 },
        velSim: { x: 0, y: 0, z: 20 },
      },
      cameraMode: 'chaseFar',
      stage: { environment: { weather: 'rain' } },
      impactImpulseMax: 0,
      ...o,
    }) as unknown as FrameContext;

  it('materials → original bytes (NUMBERING TRAP: rally-web tarmac 0 = ASPHALT 1), no contact → −1', () => {
    expect(wheelMaterials(ctx())).toEqual([1, 2, 2, -1]);
    for (let b = 0; b < 23; b++) {
      const c = ctx();
      (c.telemetry.wheels[0] as { material: number }).material = materialFromOrig(b);
      expect(wheelMaterials(c)[0]).toBe(b);
    }
    expect(dominantMaterial([1, 2, 2, -1])).toBe(2);
    expect(dominantMaterial([-1, -1, -1, -1])).toBe(-1);
  });

  it('slips, bump extension, Ouside, rain, impacts', () => {
    const m = new CarInputMapper();
    const i = m.map(ctx());
    expect(i.slipX[0]).toBeCloseTo(0.4, 12);
    expect(i.slipZ[1]).toBeCloseTo(0.3, 12);
    expect(i.bump[0]).toBeCloseTo(1 - 0.1 / 0.75, 12);
    expect(i.bump[3]).toBe(1);
    expect(i.outside).toBe(true);
    expect(i.raining).toBe(true);
    expect(i.impact).toBeNull();
    expect(m.map(ctx({ cameraMode: 'bumper' })).outside).toBe(false);
    expect(m.map(ctx({ cameraMode: 'bonnet' })).outside).toBe(false);
    const hit = m.map(ctx({ impactImpulseMax: 2500 })).impact!;
    expect(hit).toEqual({ type: 2, strength: 2500 / IMPULSE_PER_STRENGTH });
  });

  it('the collision record (CarTelemetry.collision): object hits latch once, body live, bush, shared flags', () => {
    const rec = (o: Record<string, unknown> = {}) => ({ hull: false, hullMaterial: 0, hullStrength: 0, objectHits: 0, objectType: -1, objectStrength: 0, bush: false, ...o });
    const withRec = (r: Record<string, unknown>, o: Record<string, unknown> = {}) => {
      const c = ctx(o);
      (c.telemetry as unknown as { collision: unknown }).collision = rec(r);
      return c;
    };
    const m = new CarInputMapper();
    expect(m.map(withRec({ objectHits: 3 })).impact).toBeNull(); // first sight: resync, no record
    const i = m.map(withRec({ objectHits: 4, objectType: 6, objectStrength: 42 }, { impactImpulseMax: 9000 }));
    expect(i.impact).toEqual({ type: 6, strength: 42 }); // the record, not the calibrated impulse
    expect(m.map(withRec({ objectHits: 4, objectType: 6, objectStrength: 42 })).impact).toBeNull(); // once
    expect(m.map(withRec({ objectHits: 0 })).impact).toBeNull(); // a new CarSim: resync
    const b = m.map(withRec({ hull: true, hullMaterial: 2, hullStrength: 180, bush: true }));
    expect(b.body).toEqual({ contact: true, type: 2, strength: 180 });
    expect(b.inBush).toBe(true);
    expect(b.backfire).toBeUndefined();
    const f = m.map(withRec({}, { carFlags: { backfire: true, blowOut: false } }));
    expect(f.backfire).toBe(true);
    expect(f.blowOut).toBe(false);
  });
});
