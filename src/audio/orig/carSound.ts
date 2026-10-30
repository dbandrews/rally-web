/**
 * src/audio/orig/carSound.ts — OWNED BY THE AUDIO BUILDER.
 *
 * Port of the original's CarSoundPlayer (research/formats/sound.md §4, update = vtable 0x82ef10 slot 14 =
 * 0x7465f0 and its callees, read from research/decomp/all.c): the 20 script slots of SoundPlayer.con (human)
 * or SoundAI.con (opponents), the Car:: externs, the play()/release() edge logic, the surface slots, collisions
 * (the car's collision record, CarTelemetry.collision), and the car-side backfire / blow-out flags (0x753410 /
 * 0x753550: the shared source src/game/carFlags.ts when the input carries them, else computed here). Pure
 * TypeScript (vitest); positions SIM space.
 */
import type { SimQuat, SimV3 } from '../../core/types';
import { type AudioBankJson, CAR_EXT, CAR_SLOT } from './bankTypes';
import { type Emitter, ScriptInstance, type SoundSystem } from './patch';
import { ParkMiller } from './rand';

/** What the car exposes to its sound player each update (the car interface vtable 0x82f508 getters). */
export interface CarSoundInput {
  /** Engine rpm (vt+0x10c). */
  rpm: number;
  /** |forward speed| km/h (vt+0x118 = CP+8 · 1/3.6 m/s, ×3.6 in the player: the HUD speed). */
  speedKmh: number;
  /** Effective pedals 0..1 (vt+0x28 throttle, vt+0x2c brake) and handbrake (vt+0x30). */
  throttle: number;
  brake: number;
  handbrake: number;
  /** Gear (vt+0x34): 0 = reverse, 1..n (compared unsigned, as the original). */
  gear: number;
  /** Per wheel (FL, FR, RR, RL): original material byte 0..22 of the contact, or −1 (no contact). */
  wheelMaterial: readonly number[];
  /** Wheel slide / spin amounts (wheel vt+0xe0 / vt+0xe4) and the bump measure (vt+0x108). */
  slipX: readonly number[];
  slipZ: readonly number[];
  bump: readonly number[];
  /** Ouside extern: 1 outside camera, 0 in-car (camera modes 15/16). */
  outside: boolean;
  /** Weather manager: the current entry is rain (+0x84 == 1). */
  raining: boolean;
  /** New object collision record this update (car record +0x30 flag, +0x34 type, +0x38 strength), or null. It
   *  waits (like the original's flag) until the 0.5 s gate opens. */
  impact: { type: number; strength: number } | null;
  /** The physics body's hull contact, read live by the impact reader when no record is set (B+4 bit 0, type B+0x144,
   *  strength B+0x19c; FUN_00746c80 0x746d09). Absent = no body source (e.g. the calibrated fallback). */
  body?: { contact: boolean; type: number; strength: number } | null;
  /** Collision record +0x28: the car is inside a bush. */
  inBush: boolean;
  /** The car update's backfire / blow-out flags (car +0x84 / +0x8c) from the shared source; absent = computed here. */
  backfire?: boolean;
  blowOut?: boolean;
  /** Pose for the emitter (SIM). */
  pos: SimV3;
  quat: SimQuat;
  vel: SimV3;
}

/** Template defaults (FUN_007560e0; no data file sets them): springDampingThreshold +0xa0. */
const SPRING_DAMPING_THRESHOLD = 0.6;

export class CarSoundPlayer {
  readonly emitter: Emitter;
  readonly scripts: (ScriptInstance | null)[];
  /** Car-volume options slider (DAT_00857fbc) → patch.volume each update (0x7467a4). */
  carVolume = 1;
  /** The sound rpm of the last update (+0xf8). */
  soundRpm = 0;
  // template / player state
  private prevGear = 1; // +0xfc
  private prevThrottle = 0; // +0x100
  private prevHandbrake = 0; // +0x104
  private prevSlots = [0, 0, 0, 0]; // +0x148 (never cleared: stale entries stay, as the original)
  private whineFlag = false; // +0x158
  private whineCount = 0; // +0x15c
  private boostT = 0; // +0x160
  private popT = 0; // +0x164
  private bushIn = false; // +0x17c
  private collisionT = 0; // +0x180
  private bushT = 0; // +0x184
  private pendingImpact: { type: number; strength: number } | null = null;
  private readonly materials = [-1, -1, -1, -1]; // +0xa8
  // car-side flags (car +0x84 / +0x88 backfire, +0x8c / +0x90 / +0x94 blow-out)
  private backfireT = 0;
  private blowoutT = 0;
  private blowoutGear = 1;
  backfire = false;
  blowout = false;
  private readonly lcg: ParkMiller;
  private readonly materialSlot: (number | null)[];
  private readonly coll: { hard: Set<number>; snow: Set<number>; tree: Set<number> };

  readonly sys: SoundSystem;
  readonly car: string;

  constructor(sys: SoundSystem, bank: AudioBankJson, car: string, human = true, seed = 1) {
    this.sys = sys;
    this.car = car;
    const def = bank.cars[car];
    if (!def) throw new Error(`no CarSoundPlayer for ${car}`);
    this.emitter = { pos: { x: 0, y: 0, z: 0 }, quat: { w: 1, x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    const slots = human ? def.player : def.ai;
    this.scripts = [];
    for (let i = 0; i < 20; i++) {
      const k = slots[i];
      const s = k ? bank.scripts[k] : undefined;
      this.scripts.push(k && s ? new ScriptInstance(sys, s, k, this.emitter) : null);
    }
    this.lcg = new ParkMiller(seed);
    this.materialSlot = bank.materialSlot;
    this.coll = { hard: new Set(bank.collision.hard), snow: new Set(bank.collision.snow), tree: new Set(bank.collision.tree) };
  }

  private s(i: number): ScriptInstance | null {
    return this.scripts[i] ?? null;
  }

  /** Every sample key the player's scripts reference (preloading). */
  sampleKeys(): string[] {
    const out = new Set<string>();
    for (const sc of this.scripts) for (const p of sc?.patches ?? []) for (const l of p.def.layers) if (l.s) out.add(l.s);
    return [...out];
  }

  /** Car-side flags, run before the player (the car update): backfire 0x753410, blow-out 0x753550. */
  private carFlags(dt: number, inp: CarSoundInput): void {
    if (inp.backfire !== undefined || inp.blowOut !== undefined) {
      // the shared source (src/game/carFlags.ts): the same flags the pipe flames use
      this.backfire = !!inp.backfire;
      this.blowout = !!inp.blowOut;
      return;
    }
    const rand = this.sys.rand;
    // backfire: timer counts down; at <= 0 with the throttle closed and rpm > 1100 roll n = trunc(rpm/1000 + 1.5)
    this.backfireT -= dt;
    this.backfire = false;
    if (this.backfireT <= 0 && inp.throttle <= 0 && inp.rpm > 1100) {
      this.backfireT = 0;
      const pedalInReverse = (inp.brake > 0 && inp.gear === 0) || (inp.throttle > 0 && inp.gear === 0);
      if (!pedalInReverse) {
        const n = Math.trunc(inp.rpm * 0.001 + 1.5);
        if (rand.next() % n !== 0) {
          this.backfire = true;
          this.backfireT = ((rand.next() % 100) - 50) / (inp.rpm * 0.0001 * 400) + 0.15;
        }
      }
    }
    // blow-out: every 0.2 s above 1.3889 m/s; a gear change since the last check sets it with 50 % (rand%6+1 <= 3)
    this.blowoutT += dt;
    this.blowout = false;
    if (this.blowoutT >= 0.2 && inp.speedKmh / 3.6 > 1.3889) {
      this.blowoutT = 0;
      if (inp.gear !== this.blowoutGear && (rand.next() % 6) + 1 <= 3) this.blowout = true;
      this.blowoutGear = inp.gear;
    }
  }

  /** One CarSoundPlayer update (0x7465f0). */
  update(dt: number, inp: CarSoundInput): void {
    this.carFlags(dt, inp);
    const e = this.emitter;
    e.pos.x = inp.pos.x;
    e.pos.y = inp.pos.y;
    e.pos.z = inp.pos.z;
    e.quat = inp.quat;
    e.vel.x = inp.vel.x;
    e.vel.y = inp.vel.y;
    e.vel.z = inp.vel.z;
    const outside = inp.outside ? 1 : 0;
    for (const sc of this.scripts) {
      if (!sc) continue;
      sc.setExtern(CAR_EXT.Speed, inp.speedKmh);
      sc.setExtern(CAR_EXT.Ouside, outside);
      sc.setVolume(this.carVolume);
    }
    const thr = inp.throttle;
    const gear = inp.gear >>> 0;
    this.soundRpmUpdate(inp);
    // FUN_007468e0: wheel data (materials of the 4 wheels)
    for (let w = 0; w < 4; w++) this.materials[w] = inp.wheelMaterial[w] ?? -1;
    if (inp.impact) this.pendingImpact = { ...inp.impact };
    this.collisions(inp.body ?? null);
    this.bush(inp.inBush);
    this.engineIdle(inp);
    this.pipe(inp);
    if (this.prevGear !== gear) this.s(CAR_SLOT.GearShift)?.play(); // FUN_007470a0
    if (inp.handbrake > 0 && this.prevHandbrake === 0) this.s(CAR_SLOT.HandBrake)?.play(); // FUN_007470e0
    this.prevHandbrake = inp.handbrake;
    this.surfaces(inp);
    this.pops(thr, gear);
    this.boosts(thr, gear);
    this.onThrottle(inp);
    const rain = this.s(CAR_SLOT.Weather); // FUN_007479e0
    if (rain) {
      if (inp.raining) rain.play();
      else rain.release();
    }
    // FUN_00747a30 glass: the port has no glass events
    if (this.backfire) this.s(CAR_SLOT.PipeBoom)?.play(); // FUN_00747a90
    if (this.blowout) this.s(CAR_SLOT.PipeBlowOut)?.play(); // FUN_00747ad0
    this.bump(inp);
    this.whine(inp, gear);
    this.prevGear = gear;
    this.prevThrottle = thr;
    this.boostT += dt;
    this.popT += dt;
    this.collisionT += dt;
    this.bushT += dt;
  }

  /** FUN_00746a00: the sound rpm (low-speed roughness on throttle, cap 8760). */
  private soundRpmUpdate(inp: CarSoundInput): void {
    let rpm = inp.rpm;
    let a = 300;
    let b = 350;
    for (const m of this.materials) if (m === 101 || m === 201) a = b = 150; // never true for ids 0..22
    const kmh = inp.speedKmh;
    let k = 0;
    if (kmh <= b) {
      k = 1 - kmh / (a - kmh);
      k = k < 0 ? 0 : k > 1 ? 1 : k;
    }
    if (inp.throttle > 0 && rpm < 8500 && rpm > 2000) {
      let j = k * ((this.lcg.next() % 1200) - 800);
      if (j > 0 && j < 10) j = 10;
      else if (j < 0 && j > -10) j = -10;
      else if (j > 2000) j = 2000;
      else if (j < -2000) j = -2000;
      rpm += Math.abs(inp.throttle) * j;
    }
    if (rpm > 8760) rpm = 8760;
    this.soundRpm = rpm;
  }

  /**
   * FUN_00746c80 (gated 0.5 s; the record waits until the gate opens): the object record (+0x30) first, else the body's
   * hull contact (B+4 bit 0: type B+0x144, strength B+0x19c); the car-car record (+0x3c, type 1, threshold 5) has no
   * source in rally-web. Types: hard / snow ≥ 165, tree ≥ 5 (table 0x746e3c).
   */
  private collisions(body: CarSoundInput['body']): void {
    if (this.collisionT < 0.5) return;
    let rec = this.pendingImpact;
    if (rec) this.pendingImpact = null;
    else if (body?.contact) rec = { type: body.type, strength: body.strength };
    if (!rec) return;
    const col = this.s(CAR_SLOT.Collision);
    if (!col) return;
    let patch = -1;
    if (this.coll.hard.has(rec.type)) patch = rec.strength < 165 ? -1 : 1;
    else if (this.coll.tree.has(rec.type)) patch = rec.strength < 5 ? -1 : 5;
    else if (this.coll.snow.has(rec.type)) patch = rec.strength < 165 ? -1 : 4;
    if (patch < 0) return;
    const p = col.patch(patch);
    if (!p) return;
    p.play();
    p.setExtern(CAR_EXT.Impulse, rec.strength);
    this.collisionT = 0;
  }

  /** FUN_00746ec0: bush rising edge → Collision patch 0 (gated 0.5 s). */
  private bush(inBush: boolean): void {
    if (this.bushT < 0.5) return;
    if (!inBush) this.bushIn = false;
    else if (!this.bushIn) {
      this.bushIn = true;
      const col = this.s(CAR_SLOT.Collision);
      if (col) {
        col.playPatch(0);
        this.bushT = 0;
      }
    }
  }

  private engineExterns(sc: ScriptInstance, inp: CarSoundInput, gear = true): void {
    sc.setExtern(CAR_EXT.Rpm, this.soundRpm);
    if (gear) sc.setExtern(CAR_EXT.Gear, inp.gear);
    sc.setExtern(CAR_EXT.Throttle, inp.throttle);
  }

  /** FUN_00746f30: idle, play() every update (always on). */
  private engineIdle(inp: CarSoundInput): void {
    const sc = this.s(CAR_SLOT.Engine);
    if (!sc) return;
    this.engineExterns(sc, inp);
    sc.play();
  }

  /** FUN_00746fb0: off-throttle pipe. Throttle 0: play on the lift edge, or when stopped; release on the
   *  throttle-on edge. */
  private pipe(inp: CarSoundInput): void {
    const sc = this.s(CAR_SLOT.Pipe);
    if (!sc) return;
    this.engineExterns(sc, inp);
    const thr = inp.throttle;
    if (thr === 0) {
      if (this.prevThrottle > 0 || !sc.isActive()) {
        sc.play();
        return;
      }
    }
    if (thr > 0 && this.prevThrottle === 0) sc.release();
  }

  /** Rpm band of the pop / boost scripts (open intervals 500–2500, 2500–5000, 5000–13000), −1 outside. */
  private band(): number {
    const r = this.soundRpm;
    if (r > 500 && r < 2500) return 0;
    if (r > 2500 && r < 5000) return 1;
    if (r > 5000 && r < 13000) return 2;
    return -1;
  }

  private releaseRange(from: number): void {
    for (let i = from; i < from + 3; i++) this.s(i)?.release();
  }

  /** FUN_00747450: overrun pops (PipeReleaseBoost1-3) on the lift edge or a downshift, > 1 s apart. */
  private pops(thr: number, gear: number): void {
    if (this.popT > 1) {
      if ((thr === 0 && this.prevThrottle > 0) || gear < this.prevGear) {
        const b = this.band();
        if (b >= 0) {
          for (let k = 0; k < 3; k++) {
            const sc = this.s(CAR_SLOT.PipeReleaseBoost1 + k);
            if (!sc) continue;
            sc.release();
            if (k === b) {
              sc.play();
              this.popT = 0;
            }
          }
          this.releaseRange(CAR_SLOT.PipeBoost1); // FUN_00747d00
        }
      } else if (thr > 0) this.releaseRange(CAR_SLOT.PipeReleaseBoost1); // FUN_00747d60
    }
    for (let k = 0; k < 3; k++) {
      const sc = this.s(CAR_SLOT.PipeReleaseBoost1 + k);
      if (!sc) continue;
      sc.setExtern(CAR_EXT.Rpm, this.soundRpm);
      sc.setExtern(CAR_EXT.Throttle, thr);
    }
  }

  /** FUN_007476b0: boost (PipeBoost1-3) on the throttle-on edge or an upshift, > 1 s apart. Band 1 is play()ed
   *  without the release first (as the original); bands 2/3 restart. */
  private boosts(thr: number, gear: number): void {
    if (this.boostT > 1) {
      if ((thr > 0 && this.prevThrottle === 0) || this.prevGear < gear) {
        const b = this.band();
        if (b >= 0) {
          for (let k = 0; k < 3; k++) {
            const sc = this.s(CAR_SLOT.PipeBoost1 + k);
            if (!sc) continue;
            if (k === b) {
              if (k > 0) sc.release();
              sc.play();
              this.boostT = 0;
            } else sc.release();
          }
          this.releaseRange(CAR_SLOT.PipeReleaseBoost1); // FUN_00747d60
        }
      } else if (thr === 0) this.releaseRange(CAR_SLOT.PipeBoost1); // FUN_00747d00
    }
    for (let k = 0; k < 3; k++) {
      const sc = this.s(CAR_SLOT.PipeBoost1 + k);
      if (!sc) continue;
      sc.setExtern(CAR_EXT.Rpm, this.soundRpm);
      sc.setExtern(CAR_EXT.Throttle, thr);
    }
  }

  /** FUN_007478f0: on-throttle engine: play when the throttle opens (or it stopped while open), release on lift. */
  private onThrottle(inp: CarSoundInput): void {
    const sc = this.s(CAR_SLOT.EngineThrottle);
    if (!sc) return;
    const thr = inp.throttle;
    if (thr <= 0 || (this.prevThrottle !== 0 && sc.isActive())) {
      if (thr === 0 && this.prevThrottle > 0) sc.release();
    } else sc.play();
    this.engineExterns(sc, inp);
  }

  /** FUN_00747150: count the wheels per surface slot; release the slots that left, play() the others with
   *  Wheels = count; SlipX = wheel 0, SlipZ = mean |spin| (·0.25). Patches indexed BY SLOT (§6.3). */
  private surfaces(inp: CarSoundInput): void {
    const counts = new Array<number>(19).fill(0);
    for (const m of this.materials) {
      const slot = m >= 0 && m < this.materialSlot.length ? this.materialSlot[m] : null;
      if (slot !== null && slot !== undefined) counts[slot]++;
    }
    const sx = this.s(CAR_SLOT.WheelSlipX);
    const sz = this.s(CAR_SLOT.WheelSlipZ);
    const fr = this.s(CAR_SLOT.WheelFriction);
    sx?.setExtern(CAR_EXT.SlipX, inp.slipX[0] ?? 0);
    let z = 0;
    for (let w = 0; w < 4; w++) z += Math.abs(inp.slipZ[w] ?? 0);
    sz?.setExtern(CAR_EXT.SlipZ, z * 0.25);
    for (const slot of this.prevSlots) {
      if (counts[slot] !== 0) continue;
      sx?.patch(slot)?.release();
      sz?.patch(slot)?.release();
      fr?.patch(slot)?.release();
    }
    let k = 0;
    for (let slot = 0; slot < 19; slot++) {
      const n = counts[slot];
      if (!n) continue;
      if (k < 4) this.prevSlots[k++] = slot;
      for (const sc of [sx, sz, fr]) {
        const p = sc?.patch(slot);
        if (!p) continue;
        p.setExtern(CAR_EXT.Wheels, n);
        p.play();
      }
    }
  }

  /** FUN_00747c90: any wheel below springDampingThreshold · 1.15 with the Collision script idle → patch 3. */
  private bump(inp: CarSoundInput): void {
    let hit = false;
    for (let w = 0; w < 4; w++) if ((inp.bump[w] ?? 1) < SPRING_DAMPING_THRESHOLD * 1.15) hit = true;
    if (!hit) return;
    const col = this.s(CAR_SLOT.Collision);
    if (col && !col.isActive()) col.playPatch(3);
  }

  /** FUN_00747b10: transmission whine while the throttle is open; an upshift drops it out (Whine = 0) and starts
   *  80 updates of random 1-in-6 drop-outs. */
  private whine(inp: CarSoundInput, gear: number): void {
    const sc = this.s(CAR_SLOT.Whine);
    if (!sc) return;
    sc.setExtern(CAR_EXT.Speed, inp.speedKmh);
    sc.setExtern(CAR_EXT.Whine, 1);
    if (inp.throttle <= 0) {
      sc.release();
      return;
    }
    sc.play();
    if (this.prevGear < gear) {
      this.whineFlag = true;
      sc.setExtern(CAR_EXT.Whine, 0);
    }
    if (this.whineFlag) {
      const r = this.lcg.next();
      this.whineCount++;
      if (r % 6 === 1) sc.setExtern(CAR_EXT.Whine, 0);
    }
    if (this.whineCount === 80) {
      this.whineCount = 0;
      this.whineFlag = false;
    }
  }

  dispose(): void {
    for (const sc of this.scripts) sc?.kill();
  }
}
