/**
 * src/audio/orig/patch.ts — OWNED BY THE AUDIO BUILDER.
 *
 * Port of the original's sound-script runtime (research/formats/sound.md §3 + Verification; decomp addresses
 * below): patch instances (vtable 0x83bd70), their layers and effects, the shuffle bag, and the 15 Hz sound tick
 * (FUN_00406370 → FUN_005fbc40 → patch update). Pure TypeScript: the audible side is a VoiceBackend (Web Audio in
 * webBackend.ts, a recorder in the tests). Positions are SIM space (x right, y up, z forward, metres); the
 * backend converts to three space for the PannerNodes / listener (sound.md §14.2).
 *
 * Patch state (byte offsets of the original instance):
 *   +0x58 playedTick   set by play(), cleared at the end of every update
 *   +0x59 active       set by play() only if the patch has a looping layer (vt+0x24 = 0x7eb430), cleared by release()
 *   +0x84 time / +0x88 timeRelease (−1 until release)
 *   +0x90 releasedTick set by release(), cleared at the end of every update
 *   +0x91 live         "voices may still be playing" (isActive's second half)
 *   +0x94 volume       the owner's master volume (car-volume slider)
 *   per layer: playing (+0x3c array), once (+0x4c array), the voice
 */
import { qRotate } from '../../core/math';
import type { SimQuat, SimV3 } from '../../core/types';
import type { LayerJson, PatchJson, ScriptJson } from './bankTypes';
import { DEST_PITCH, DEST_VOLUME, type EffectSources, effectInput, evalEffect, hasTimeReleaseVolume } from './envelope';
import { MsvcRand } from './rand';

/** Sound tick rate: FUN_004063e0(15.0) at 0x4026d9 (no data file changes it). */
export const SOUND_TICK_HZ = 15;

/** What a voice gets each tick (FUN_007eab60 + the voice update FUN_00602220). */
export interface VoiceUpdate {
  /** §3.3 vol: layer volume · Π Volume effects · patch.volume (> 0). The backend applies sfxMaster, the ≤ 1 clamp
   *  and the DirectSound gain law. */
  volume: number;
  /** Π Pitch effects + the voice's random start offset (playback-rate multiplier before the DS clamp). */
  pitch: number;
  /** 3-D layers: emitter position / velocity, SIM space (null for `stereo` layers). */
  pos: SimV3 | null;
  vel: SimV3 | null;
  minDistance: number;
  doppler: boolean;
}

export interface Voice {
  /** False once a one-shot reached its end (or after stop()). */
  readonly playing: boolean;
  update(u: Readonly<VoiceUpdate>): void;
  stop(): void;
}

export interface VoiceBackend {
  /** Start the layer's sample (from frame 0, looping for `loop` layers). null = no buffer (missing / not loaded
   *  yet): the layer is silent, as the original's failed load. */
  start(layer: LayerJson): Voice | null;
}

/** Owner-driven emitter (setParent / setPosition, slots 13/14). SIM space. */
export interface Emitter {
  pos: SimV3;
  /** Parent orientation for `relativePosition`; null = no parent transform (the offset is ignored). */
  quat: SimQuat | null;
  vel: SimV3;
}

export interface SoundListener {
  pos: SimV3;
  vel: SimV3;
}

/** The global script manager: live patch list, the 15 Hz tick, listener, sfx master, rand(). */
export class SoundSystem {
  /** Options slider 1 (DAT_00850ecc), 0..1. */
  sfxMaster = 1;
  /** null = no listener: the Distance source reads 0 (FUN_007eb460, DAT_009334f0 == 0). */
  listener: SoundListener | null = null;
  readonly rand: MsvcRand;
  /** Called after the patches of a tick were updated (the listener commit, vt+0x34). */
  onTick: ((elapsed: number) => void) | null = null;
  private readonly live: PatchInstance[] = [];
  private acc = 0;
  ticks = 0;

  readonly backend: VoiceBackend;

  constructor(backend: VoiceBackend, seed = 1) {
    this.backend = backend;
    this.rand = new MsvcRand(seed);
  }

  register(p: PatchInstance): void {
    if (!this.live.includes(p)) this.live.push(p);
  }
  unregister(p: PatchInstance): void {
    const i = this.live.indexOf(p);
    if (i >= 0) this.live.splice(i, 1);
  }
  get livePatches(): readonly PatchInstance[] {
    return this.live;
  }

  /** FUN_00406370: accumulate frame dt; once the total reaches 1/15 s update every live patch with the WHOLE
   *  accumulated time and reset it. Returns true when a tick ran. */
  advance(frameDt: number): boolean {
    this.acc += Math.max(0, frameDt);
    if (this.acc < 1 / SOUND_TICK_HZ) return false;
    const el = this.acc;
    this.acc = 0;
    this.tick(el);
    return true;
  }

  /** One sound tick (FUN_005fbc40): every live patch's update(elapsed), unregistered ones removed after. */
  tick(elapsed: number): void {
    this.ticks++;
    for (const p of [...this.live]) p.update(elapsed);
    this.onTick?.(elapsed);
  }

  /** Stop everything (stage change / dispose). */
  stopAll(): void {
    for (const p of [...this.live]) p.kill();
    this.live.length = 0;
    this.acc = 0;
  }
}

const tmpSrc: EffectSources = { ext: [], speed: 0, acceleration: 0, distance: 0, altitude: 0, time: 0, timeRelease: -1 };

export class PatchInstance {
  /** Patch externs (setExtern, slot 12): the Car:: map has 10 entries. */
  readonly ext = new Float64Array(16);
  /** +0x94 master volume (setVolume, slot 10). */
  volume = 1;
  time = 0;
  timeRelease = -1;
  active = false;
  playedTick = false;
  releasedTick = false;
  live = false;
  altitude = 0;
  emitter: Emitter | null = null;
  private registered = false;
  private readonly hasLoop: boolean;
  private readonly hasTR: boolean[];
  private readonly playing: boolean[];
  private readonly once: boolean[];
  private readonly voices: (Voice | null)[];
  private readonly offsets: number[];
  // randomPlay shuffle bag (+0x64 bag, +0x70 cursor, +0x78 selected)
  private bag: number[] = [];
  private cursor = 0;
  private selected: number[] = [];
  private prevVel: SimV3 = { x: 0, y: 0, z: 0 };
  private accel = 0;
  private readonly lpos: SimV3 = { x: 0, y: 0, z: 0 };

  readonly sys: SoundSystem;
  readonly def: PatchJson;
  /** For debugging / tests: `<script key>#<patch index>`. */
  readonly name: string;

  constructor(sys: SoundSystem, def: PatchJson, name = '') {
    this.sys = sys;
    this.def = def;
    this.name = name;
    const n = def.layers.length;
    this.hasLoop = def.layers.some((l) => l.loop);
    this.hasTR = def.layers.map((l) => hasTimeReleaseVolume(l.fx));
    this.playing = new Array<boolean>(n).fill(false);
    this.once = new Array<boolean>(n).fill(false);
    this.voices = new Array<Voice | null>(n).fill(null);
    this.offsets = new Array<number>(n).fill(0);
  }

  setExtern(i: number, v: number): void {
    if (i >= 0 && i < this.ext.length) this.ext[i] = v;
  }

  /** play() — slot 3, FUN_007ea740. A no-op while active; else re-initialise (Time 0, TimeRelease −1), stop the
   *  still-sounding loops, re-arm every layer and draw the randomPlay layers. Voices start in the next update. */
  play(): void {
    if (this.active) return;
    if (!this.registered) {
      this.registered = true;
      this.sys.register(this);
    }
    this.playedTick = true;
    this.time = 0;
    this.timeRelease = -1;
    this.releasedTick = false;
    this.live = true;
    if (this.hasLoop) this.active = true;
    const L = this.def.layers;
    for (let i = 0; i < L.length; i++) {
      if (L[i].loop && this.playing[i]) {
        this.stopVoice(i);
        this.playing[i] = false;
      }
    }
    for (let i = 0; i < L.length; i++) this.playing[i] = this.once[i] = false;
    if (this.def.randomPlay > 0) this.pickRandom();
  }

  /** release() — slot 4, 0x7ea810 (disassembly, sound.md §3.4): no-op once released; else clear playedTick and
   *  active, TimeRelease = 0, stop every playing layer except a loop with a Volume ← TimeRelease effect (it fades
   *  by its ramp), set releasedTick. */
  release(): void {
    if (this.timeRelease >= 0) return;
    this.playedTick = false;
    this.active = false;
    this.timeRelease = 0;
    const L = this.def.layers;
    for (let i = 0; i < L.length; i++) {
      if (!this.playing[i]) continue;
      if (L[i].loop && this.hasTR[i]) continue;
      this.stopVoice(i);
      this.playing[i] = false;
    }
    this.releasedTick = true;
  }

  /** isActive() — slot 6, FUN_007eb2a0. */
  isActive(): boolean {
    if ((this.playedTick || this.active || this.releasedTick) && this.timeRelease < 0) return true;
    if (!this.live) return false;
    // FUN_007eb390 ("layer still pending") is false for every layer of the data: no effect carries the +0x30
    // wait flag, so the group test vt+0xc (0x605970) is always true. Only sounding voices keep the patch live.
    let any = false;
    for (let i = 0; i < this.voices.length; i++) {
      if (this.voices[i]?.playing) any = true;
      else this.playing[i] = false; // a non-streamed voice that ended (+0x10 = stream, unused by the data)
    }
    this.live = any;
    return any;
  }

  /** update(dt) — slot 5, FUN_007eacf0, called by the 15 Hz sound tick for registered patches. */
  update(dt: number): void {
    if (!this.isActive()) {
      this.active = false;
      this.timeRelease = -1;
      this.releasedTick = false;
      this.registered = false;
      this.sys.unregister(this);
      return;
    }
    // FUN_007eaf80: emitter velocity / acceleration
    const e = this.emitter;
    if (e && dt > 0) {
      this.accel = Math.hypot(e.vel.x - this.prevVel.x, e.vel.y - this.prevVel.y, e.vel.z - this.prevVel.z) / dt;
      this.prevVel.x = e.vel.x;
      this.prevVel.y = e.vel.y;
      this.prevVel.z = e.vel.z;
    }
    this.time += dt;
    if (this.timeRelease >= 0) this.timeRelease += dt;
    const L = this.def.layers;
    if (this.def.randomPlay === 0) {
      for (let i = 0; i < L.length; i++) {
        const trig = L[i].trigger;
        if (trig === 0) {
          // Default: skipped on the release tick unless the layer fades by TimeRelease
          if (!this.releasedTick || this.hasTR[i]) this.updateLayer(i);
        } else if (trig === 1 && this.timeRelease >= 0) this.updateLayer(i);
      }
    } else {
      for (const i of this.selected) this.updateLayer(i);
    }
    this.playedTick = false;
    this.releasedTick = false;
  }

  /** Emitter position of layer i (FUN_007eab60: parent transform × relativePosition). */
  layerPos(i: number, out: SimV3): SimV3 {
    const e = this.emitter;
    if (!e) {
      out.x = out.y = out.z = 0;
      return out;
    }
    const r = this.def.layers[i].rel;
    if (e.quat && (r[0] !== 0 || r[1] !== 0 || r[2] !== 0)) {
      const o = qRotate(e.quat, { x: r[0], y: r[1], z: r[2] });
      out.x = e.pos.x + o.x;
      out.y = e.pos.y + o.y;
      out.z = e.pos.z + o.z;
    } else {
      out.x = e.pos.x;
      out.y = e.pos.y;
      out.z = e.pos.z;
    }
    return out;
  }

  /** Sources of layer i (FUN_007eb460). */
  sources(i: number): EffectSources {
    const s = tmpSrc;
    const e = this.emitter;
    const lst = this.sys.listener;
    s.ext = this.ext;
    s.speed = e ? Math.hypot(e.vel.x, e.vel.y, e.vel.z) : 0;
    s.acceleration = this.accel;
    if (lst && e) {
      const p = this.layerPos(i, this.lpos);
      s.distance = Math.hypot(p.x - lst.pos.x, p.y - lst.pos.y, p.z - lst.pos.z);
    } else s.distance = 0;
    s.altitude = this.altitude;
    s.time = this.time;
    s.timeRelease = this.timeRelease;
    return s;
  }

  /** Layer update, FUN_007eae20. */
  private updateLayer(i: number): void {
    const L = this.def.layers[i];
    const src = this.sources(i);
    let v = 0;
    let pitch = 1;
    if (this.sys.sfxMaster !== 0 && L.volume > 0) {
      v = L.volume > 1 ? 1 : L.volume;
      for (const e of L.fx) {
        const y = evalEffect(e, effectInput(e, src));
        if (e.d === DEST_VOLUME) v *= y;
        else if (e.d === DEST_PITCH) pitch *= y;
      }
      v *= this.volume;
    } else {
      for (const e of L.fx) if (e.d === DEST_PITCH) pitch *= evalEffect(e, effectInput(e, src));
    }
    if (v <= 0) {
      if (this.playing[i]) {
        this.stopVoice(i);
        this.playing[i] = false;
      }
    } else {
      if (this.playedTick || L.loop || this.releasedTick || !this.playing[i]) this.startLayer(i);
      const voice = this.voices[i];
      if (voice) {
        const d3 = L.is3d && this.emitter;
        voice.update({
          volume: v,
          pitch: pitch + this.offsets[i],
          pos: d3 ? this.layerPos(i, { x: 0, y: 0, z: 0 }) : null,
          vel: d3 ? this.emitter!.vel : null,
          minDistance: L.minDistance,
          doppler: L.doppler,
        });
      }
    }
    // FUN_007eb390 is false for every layer of the data (see isActive), so the layer is armed after its first update
    this.once[i] = true;
  }

  /** FUN_007eaad0: start the voice of layer i if it is not playing (one-shots once per play(); a loop again
   *  from sample 0 when it becomes audible, unless the patch was released). */
  private startLayer(i: number): void {
    const L = this.def.layers[i];
    // (deviation: a loop whose buffer was not loaded yet when it started retries, so late-loading samples
    // become audible; the original's failed load stays failed, which a missing sample still reproduces)
    if (this.playing[i] && L.loop && this.voices[i]) return;
    this.playing[i] = true;
    if (this.once[i] && !(L.loop && this.timeRelease < 0)) return;
    this.once[i] = true;
    this.stopVoice(i); // one buffer per layer: a still-sounding one-shot restarts
    // randomStartPitch a / b: off = rand()·(a + b)/32767 − a (voice update FUN_00602220)
    const [a, b] = L.rsp;
    this.offsets[i] = a !== 0 || b !== 0 ? (this.sys.rand.next() * (a + b)) / 32767 - a : 0;
    this.voices[i] = this.sys.backend.start(L);
  }

  private stopVoice(i: number): void {
    const v = this.voices[i];
    if (v) {
      v.stop();
      this.voices[i] = null;
    }
  }

  /** FUN_007eb5c0: the next randomPlay layers from the shuffle bag. Refill: [random, previous bag's last at
   *  position 1, the rest random], each pick rand() % remaining over the ordered remaining list. */
  private pickRandom(): void {
    const n = this.def.layers.length;
    if (this.bag.length <= this.cursor) {
      const last = this.bag.length ? this.bag[this.bag.length - 1] : -1;
      const list: number[] = [];
      for (let k = 0; k < n; k++) if (k !== last) list.push(k);
      const bag: number[] = [];
      for (let k = 0; k < n; k++) {
        if (k === 1 && last !== -1) bag.push(last);
        else {
          const r = this.sys.rand.next() % list.length;
          bag.push(list[r]);
          list.splice(r, 1);
        }
      }
      this.bag = bag;
      this.cursor = 0;
    }
    this.selected = [];
    const end = this.cursor + this.def.randomPlay;
    for (let j = this.cursor; j < end; j++) if (j < this.bag.length) this.selected.push(this.bag[j]);
    this.cursor = end;
  }

  /** Debug / tests: indices of the layers with a sounding voice. */
  sounding(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.voices.length; i++) if (this.voices[i]?.playing) out.push(i);
    return out;
  }
  get selectedLayers(): readonly number[] {
    return this.selected;
  }

  /** Stop all voices and drop out of the live list (stage change). */
  kill(): void {
    for (let i = 0; i < this.voices.length; i++) this.stopVoice(i);
    this.playing.fill(false);
    this.once.fill(false);
    this.active = this.live = this.playedTick = this.releasedTick = false;
    this.timeRelease = -1;
    this.registered = false;
    this.sys.unregister(this);
  }
}

/** A loaded `.ssc` script: its patches (the CarSoundPlayer's script object, vt+8 play … vt+0x38 getPatch). */
export class ScriptInstance {
  readonly patches: PatchInstance[];
  readonly key: string;
  constructor(sys: SoundSystem, def: ScriptJson, key: string, emitter: Emitter | null) {
    this.key = key;
    this.patches = def.patches.map((p, i) => {
      const pi = new PatchInstance(sys, p, `${key}#${i}`);
      pi.emitter = emitter;
      return pi;
    });
  }
  patch(i: number): PatchInstance | null {
    return this.patches[i] ?? null;
  }
  /** vt+8: play (patch 0). */
  play(): void {
    this.patches[0]?.play();
  }
  /** vt+0xc(n): play patch n. */
  playPatch(n: number): void {
    this.patches[n]?.play();
  }
  /** vt+0x10: release. */
  release(): void {
    for (const p of this.patches) p.release();
  }
  /** vt+0x18: any patch active. */
  isActive(): boolean {
    return this.patches.some((p) => p.isActive());
  }
  /** vt+0x24: set an extern on every patch. */
  setExtern(i: number, v: number): void {
    for (const p of this.patches) p.setExtern(i, v);
  }
  /** vt+0x1c (car-volume slider → patch.volume). */
  setVolume(v: number): void {
    for (const p of this.patches) p.volume = v;
  }
  kill(): void {
    for (const p of this.patches) p.kill();
  }
}
