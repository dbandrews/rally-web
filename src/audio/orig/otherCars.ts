/**
 * src/audio/orig/otherCars.ts — OWNED BY THE AI-RACE BUILDER (phase 2, docs/PHASE2_AI.md). The AI opponents' sounds.
 *
 * One `CarSoundPlayer` per AI car in its AI configuration (`new CarSoundPlayer(sys, bank, car, human = false, seed)`:
 * the SoundAI.con "Simple" script set, `bank.cars[car].ai` slots, ai.md §7 [D]: Engine / Pipe / PipeRelease + Boost 1-3 /
 * EngineThrottle plus the General Simple scripts: GearShift, HandBrake, WheelSlipX/Z, Weather, PipeBoom, PipeBlowOut,
 * Whine, Collision, WheelFriction) fed from FrameContext.others (live telemetry + that car's own backfire / blow-out
 * flags), positioned at the car (SIM space emitter with its velocity: the backend pans, attenuates and Doppler-shifts
 * against the camera listener), created / disposed as the field changes. Each car has its own CarInputMapper (the same
 * telemetry → CarSoundInput mapping as the player, incl. the car-car record CollisionTelemetry.carHits for the thud of a
 * contact). `OriginalAudio.update` calls `update(ctx)` once per frame right after the player car's update
 * (src/audio/orig/player.ts, "PHASE 2 hook"); `stopAll()` on a stage change. The synthesised fallback path has no AI
 * voices (the field's cars are silent there, documented).
 */
import type { FrameContext } from '../../core/types';
import type { AudioBankJson } from './bankTypes';
import { CarInputMapper } from './carInput';
import { CarSoundPlayer } from './carSound';
import type { Emitter, SoundSystem } from './patch';

interface Voice {
  car: string;
  player: CarSoundPlayer;
  mapper: CarInputMapper;
  /** The slice of a FrameContext the mapper reads, filled per frame. */
  ctx: Record<string, unknown>;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class OtherCarSounds {
  private readonly sys: SoundSystem;
  private readonly bank: AudioBankJson;
  private readonly loadSamples: (keys: string[]) => void;
  private readonly voices = new Map<string, Voice>();

  constructor(sys: SoundSystem, bank: AudioBankJson, loadSamples: (keys: string[]) => void) {
    this.sys = sys;
    this.bank = bank;
    this.loadSamples = loadSamples;
  }

  /** Ids of the AI cars that currently have a sound player (tests / debug). */
  get active(): string[] {
    return [...this.voices.keys()];
  }

  /** The sound emitter (SIM pose + velocity) of an AI car's voice, or null (tests / debug). */
  emitter(id: string): Readonly<Emitter> | null {
    return this.voices.get(id)?.player.emitter ?? null;
  }

  update(ctx: Readonly<FrameContext>): void {
    const others = ctx.others;
    if (!others || others.length === 0) {
      if (this.voices.size) this.stopAll();
      return;
    }
    // drop the voices of cars that left the field (or whose car changed)
    if (this.voices.size) {
      for (const [id, v] of this.voices) {
        const o = others.find((x) => x.id === id);
        if (!o || o.origCar !== v.car) this.drop(id, v);
      }
    }
    for (const o of others) {
      let v = this.voices.get(o.id);
      if (!v) {
        if (!this.bank.cars[o.origCar]) continue; // no sound set for this car: silent
        const player = new CarSoundPlayer(this.sys, this.bank, o.origCar, false, ((Date.now() ^ hash(o.id)) & 0x7fffffff) || 1);
        v = { car: o.origCar, player, mapper: new CarInputMapper(), ctx: {} };
        this.voices.set(o.id, v);
        this.loadSamples(player.sampleKeys());
      }
      const c = v.ctx;
      c.telemetry = o.telemetry;
      c.carFlags = o.carFlags;
      c.cameraMode = ctx.cameraMode;
      c.stage = ctx.stage;
      c.impactImpulseMax = 0;
      v.player.update(ctx.frameDt, v.mapper.map(c as unknown as FrameContext));
    }
  }

  private drop(id: string, v: Voice): void {
    v.player.dispose();
    this.voices.delete(id);
  }

  /** Stop and forget every AI voice (stage change: the caller then stops the whole sound system). */
  stopAll(): void {
    for (const [id, v] of [...this.voices]) this.drop(id, v);
  }

  dispose(): void {
    this.stopAll();
  }
}
