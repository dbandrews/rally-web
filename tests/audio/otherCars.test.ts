// OtherCarSounds (src/audio/orig/otherCars.ts): one SoundAI "Simple" CarSoundPlayer per AI car on the REAL built scripts with a
// recording backend: voices per car, 3-D position + Doppler velocity, lifecycle (car leaves / stage change / dispose), the
// car-car record (CollisionTelemetry.carHits → Collision Hard patch, threshold 5). Real-data parts skip without the packs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AudioBankJson } from '../../src/audio/orig/bankTypes';
import { CarInputMapper } from '../../src/audio/orig/carInput';
import { CarSoundPlayer } from '../../src/audio/orig/carSound';
import { loadBankJson } from '../../src/audio/orig/index';
import { OtherCarSounds } from '../../src/audio/orig/otherCars';
import { SoundSystem } from '../../src/audio/orig/patch';
import { _setAssetFetchForTests } from '../../src/core/assets';
import type { OtherCarFrame } from '../../src/core/field';
import type { CarTelemetry, FrameContext } from '../../src/core/types';
import { FakeCar, makeLineStage } from '../game/fakes';
import { BUILT_ASSETS_DIR, builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';
import { RecBackend } from './helpers';

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { existsSync(p: string): boolean };
const hasAudio = builtAssetsPresent && fs.existsSync(`${BUILT_ASSETS_DIR}/global/audio.json`);

const base = (s: string | null) => (s ? s.split('/').pop()! : '');

function frame(id: string, origCar: string, tel: CarTelemetry): OtherCarFrame {
  return { id, kind: 'ai', origCar, archetype: 'fwd_hatch', name: id, telemetry: tel, carFlags: { backfire: false, blowOut: false } };
}

function carTel(x: number, z: number, speed = 0, throttle = 0): CarTelemetry {
  const c = new FakeCar();
  c.place(x, z, 0, speed);
  c.lastControls = { steer: 0, throttle, brake: 0, handbrake: 0, gearUp: false, gearDown: false };
  c.rpm = 1500 + throttle * 4000;
  const t = c.telemetry();
  return t;
}

describe.skipIf(!hasAudio)('OtherCarSounds on the real SoundAI scripts', () => {
  let bank: AudioBankJson;
  beforeAll(async () => {
    useBuiltAssets();
    bank = (await loadBankJson())!;
  });
  afterAll(() => _setAssetFetchForTests(null));

  const stage = makeLineStage();
  function rig() {
    const be = new RecBackend();
    const sys = new SoundSystem(be, 11);
    sys.listener = { pos: { x: 0, y: 2, z: -5 }, vel: { x: 0, y: 0, z: 0 } };
    const loaded: string[][] = [];
    const sounds = new OtherCarSounds(sys, bank, (k) => loaded.push(k));
    const ctxOf = (others: OtherCarFrame[] | undefined): FrameContext =>
      ({ frameDt: 1 / 60, cameraMode: 'chase', stage, others, impactImpulseMax: 0 }) as unknown as FrameContext;
    const run = (secs: number, others: OtherCarFrame[] | undefined) => {
      for (let t = 0; t < secs - 1e-9; t += 1 / 60) {
        sounds.update(ctxOf(others));
        sys.advance(1 / 60);
      }
    };
    return { be, sys, sounds, loaded, run };
  }

  it('creates one AI-configured player per car, preloads its samples, and removes it when the car leaves', () => {
    const r = rig();
    const a = frame('ai1', 'Micra', carTel(3, -40));
    const b = frame('ai2', 'Corolla', carTel(-3, -60));
    r.run(0.5, [a, b]);
    expect(r.sounds.active).toEqual(['ai1', 'ai2']);
    expect(r.loaded).toHaveLength(2);
    expect(r.loaded[0].length).toBeGreaterThan(0);
    // engine idle voices of both cars sound; the AI set is the Simple scripts (a subset of the player's)
    const live = r.be.live();
    expect(live.length).toBeGreaterThan(2);
    const player = new CarSoundPlayer(new SoundSystem(new RecBackend(), 1), bank, 'Micra', true, 1);
    const ai = new CarSoundPlayer(new SoundSystem(new RecBackend(), 1), bank, 'Micra', false, 1);
    expect(ai.scripts.filter(Boolean).length).toBeLessThan(player.scripts.filter(Boolean).length);
    expect(ai.scripts.filter(Boolean).length).toBe(6); // Engine, Pipe, EngineThrottle, WheelSlipX, Whine, Collision
    // ai2 leaves
    const before = r.be.live().length;
    r.run(0.1, [a]);
    expect(r.sounds.active).toEqual(['ai1']);
    expect(r.be.live().length).toBeLessThan(before);
    // the field ends: everything goes
    r.run(0.1, undefined);
    expect(r.sounds.active).toEqual([]);
    expect(r.be.live()).toHaveLength(0);
  });

  it('positions each car in SIM space with its velocity for the Doppler shift', () => {
    const r = rig();
    const t = carTel(3, -40, 30, 1); // moving at 30 m/s along -z (THREE)
    r.run(0.4, [frame('ai1', 'Micra', t)]);
    const e = r.sounds.emitter('ai1')!;
    expect(e.pos.x).toBeCloseTo(t.posSim.x, 6);
    expect(e.pos.z).toBeCloseTo(t.posSim.z, 6);
    expect(e.vel.z).toBeCloseTo(t.velSim.z, 6);
    expect(Math.abs(e.vel.z)).toBeGreaterThan(20);
    // the voices carry the emitter's position (+ their layer offsets) and velocity to the backend (pan, distance, Doppler)
    const v = r.be.live().find((x) => x.last?.pos && x.last?.vel)!;
    expect(v).toBeTruthy();
    expect(Math.abs(v.last!.pos!.z - t.posSim.z)).toBeLessThan(5);
    expect(Math.abs(v.last!.vel!.z - t.velSim.z)).toBeLessThan(1e-6);
  });

  it('the engine follows the car: rpm and throttle change the voices (Engine.ssc pitch / EngineThrottle plays on throttle)', () => {
    const r = rig();
    r.run(0.5, [frame('ai1', 'Micra', carTel(3, -30, 0, 0))]);
    const idleVoices = r.be.voices.length;
    r.run(0.5, [frame('ai1', 'Micra', carTel(3, -30, 20, 1))]);
    expect(r.be.voices.length).toBeGreaterThan(idleVoices); // the on-throttle set started
    expect(r.be.live().some((v) => /Engine[12]?\.wav$/i.test(v.layer.s ?? ''))).toBe(true);
  });

  it('a car-car contact (carHits) plays the Collision Hard patch from strength 5; below it nothing; one per 0.5 s', () => {
    const r = rig();
    const t = carTel(3, -8);
    const f = frame('ai1', 'Micra', t);
    r.run(1.0, [f]); // gate open (collisionT > 0.5)
    const hardCount = () => r.be.voices.filter((v) => /Collision\/Hard|\/Hard\d?\.wav$/i.test(v.layer.s ?? '') || /hard/i.test(base(v.layer.s))).length;
    const h0 = hardCount();
    t.collision.carHits = 1; // a hit of strength 0 (below the threshold 5)
    r.run(0.1, [f]);
    t.collision.carHits = 2;
    t.collision.carStrength = 3; // below the car-car threshold 5
    r.run(0.1, [f]);
    expect(hardCount()).toBe(h0);
    r.run(0.6, [f]);
    t.collision.carHits = 3;
    t.collision.carStrength = 40;
    r.run(0.2, [f]); // the patch engine ticks at 15 Hz
    expect(hardCount()).toBeGreaterThan(h0);
  });

  it('unknown cars are silent; stopAll and dispose drop every voice', () => {
    const r = rig();
    r.run(0.2, [frame('ai1', 'NoSuchCar', carTel(0, -20))]);
    expect(r.sounds.active).toEqual([]);
    r.run(0.3, [frame('ai1', 'Micra', carTel(0, -20))]);
    expect(r.sounds.active).toEqual(['ai1']);
    r.sounds.stopAll();
    expect(r.sounds.active).toEqual([]);
    r.run(0.1, [frame('ai1', 'Micra', carTel(0, -20))]); // comes back on the next frame (a new stage)
    expect(r.sounds.active).toEqual(['ai1']);
    r.sounds.dispose();
    expect(r.sounds.active).toEqual([]);
  });
});

describe('CarInputMapper car-car record', () => {
  it('maps a new carHits count to a one-shot carHit (the first sighting only syncs)', () => {
    const m = new CarInputMapper();
    const t = carTel(0, 0);
    const ctx = { telemetry: t, cameraMode: 'chase', stage: makeLineStage(), impactImpulseMax: 0 } as unknown as FrameContext;
    t.collision.carHits = 4;
    expect(m.map(ctx).carHit).toBeNull(); // the first map only syncs the counter (a CarSim that already had hits)
    t.collision.carHits = 5;
    t.collision.carStrength = 12;
    expect(m.map(ctx).carHit).toEqual({ strength: 12 });
    expect(m.map(ctx).carHit).toBeNull();
  });
});
