/**
 * src/audio/audio.ts — OWNED BY THE AUDIO BUILDER.
 *
 * The game's audio engine (IAudioEngine). Two paths:
 *
 *   1. ORIGINAL (the target, research/formats/sound.md): when the asset manifest lists the global `audio` part,
 *      the original sound bank (src/audio/orig/index.ts loadOriginalSoundBank) drives the ported patch engine
 *      (src/audio/orig/player.ts OriginalAudio: the CarSoundPlayer of FrameContext.origCar or the archetype's
 *      default original car, the stage ambience, the race UI scripts, the co-driver words, the menu sounds) on the
 *      original's 15 Hz sound tick. No compressor (the original mixes straight into DirectSound).
 *   2. SYNTH (fallback: no assets, `?orig=0`, a failing bank): procedural engine / turbo / tyre / surface / impact
 *      voices, unchanged from the pre-port engine. No sampled audio from any other game.
 *
 * Music (the licensed soundtrack) is off unless `?music=1` and then only reads the gitignored
 * public/sound/music/ folder (src/audio/orig/music.ts).
 *
 * REQUIRED EXPORTS (contract in src/core/types.ts IAudioEngine):
 *   class AudioEngine implements IAudioEngine
 *     constructor()
 *     resume(): void              // call from a user gesture (main.ts: window keydown / pointerdown in the capture phase, registered before the Menu, until `started`)
 *     setEnabled(on: boolean): void; readonly enabled: boolean
 *     update(ctx: Readonly<FrameContext>): void   // per frame
 *     dispose(): void
 *   Extras (main.ts audio call sites): setListenerSource(fn) — the render camera (GameRenderer.camera) as the 3-D listener;
 *   playUiSound(name) — menu meme sounds; debugState() / window.__rallyAudio — what plays (tools).
 *
 * Synth voices: engine = two detuned oscillators at the firing frequency (4-cyl: 2 pulses per
 * rev, the classic coupe's 5-cyl: 2.5) through a soft clipper and a throttle-opened low-pass, plus an
 * intake rasp band; turbo whistle + blow-off hiss on lift; tyre squeal (tarmac family) from band-passed
 * noise driven by wheel slip; loose-surface rumble + stone crunch from speed; wind from speed²;
 * a thump on impacts. Everything ramps with setTargetAtTime, so the per-frame cost is a handful of
 * parameter writes.
 */
import { warnOnce } from '../core/assets';
import { DT, SURFACE_INFO } from '../core/constants';
import type { ArchetypeId, CarTelemetry, FrameContext, IAudioEngine, SurfaceId } from '../core/types';
import { loadOriginalSoundBank } from './orig';
import { MusicPlayer, musicEnabled } from './orig/music';
import { type ListenerPose, OriginalAudio, type OriginalAudioDebug, type UiSoundName } from './orig/player';

const FIRING: Record<ArchetypeId, number> = { awd_wrc: 2, fwd_hatch: 2, rwd_classic: 2.5 };
const PITCH: Record<ArchetypeId, number> = { awd_wrc: 1, fwd_hatch: 1.12, rwd_classic: 0.92 };
const SQUEAL_SURFACES: ReadonlySet<SurfaceId> = new Set(['tarmac', 'cobbles', 'water']);

type Ctor = typeof AudioContext;

function noiseBuffer(ac: BaseAudioContext, seconds = 2): AudioBuffer {
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * seconds), ac.sampleRate);
  const d = buf.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < d.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    d[i] = (s / 4294967296) * 2 - 1;
  }
  return buf;
}

function softClip(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return c;
}

interface Graph {
  ac: AudioContext;
  master: GainNode;
  engOscA: OscillatorNode;
  engOscB: OscillatorNode;
  engSub: OscillatorNode;
  engFilter: BiquadFilterNode;
  engGain: GainNode;
  rasp: BiquadFilterNode;
  raspGain: GainNode;
  turbo: OscillatorNode;
  turboGain: GainNode;
  hiss: BiquadFilterNode;
  hissGain: GainNode;
  squeal: BiquadFilterNode;
  squealGain: GainNode;
  rumble: BiquadFilterNode;
  rumbleGain: GainNode;
  crunch: BiquadFilterNode;
  crunchGain: GainNode;
  wind: BiquadFilterNode;
  windGain: GainNode;
  noise: AudioBuffer;
  sources: AudioScheduledSourceNode[];
}

/** The engine that owns the current context (playUiSound target). */
let current: AudioEngine | null = null;

/** Play a menu meme sound (Menu.rff menu/sound/<Name>.wav, sound.md §9) through the live engine; a no-op with the
 *  synth / without assets. For the menu (IMenuHost owner). */
export function playUiSound(name: UiSoundName): void {
  current?.playUiSound(name);
}

/** The live engine's sound path ('idle' before the first user gesture builds it); the menu's Sound / Co-driver copy. */
export function audioMode(): AudioDebugState['mode'] {
  return current?.debugState().mode ?? 'idle';
}

/** The render camera of a GameRenderer (its public read-only `camera`) as the audio listener; null without one. */
export function rendererListener(renderer: { readonly camera?: ListenerPose | null } | null): ListenerPose | null {
  const cam = renderer?.camera ?? null;
  return cam && cam.matrixWorld && cam.matrixWorld.elements ? cam : null;
}

export interface AudioDebugState {
  running: boolean;
  mode: 'idle' | 'loading' | 'original' | 'synth';
  omega: number[];
  original: OriginalAudioDebug | null;
  music: boolean;
  /** Smoothed main-thread ms per update() call. */
  cpuMs: number;
}

declare global {
  interface Window {
    /** Debug / tools: what the audio engine plays (tests/audio/browser-check.mjs). */
    __rallyAudio?: { state(): AudioDebugState };
  }
}

export class AudioEngine implements IAudioEngine {
  enabled = true;
  private ac: AudioContext | null = null;
  /** On / off gain → destination (both paths). */
  private out: GainNode | null = null;
  private g: Graph | null = null;
  private failed = false;
  private mode: AudioDebugState['mode'] = 'idle';
  private orig: OriginalAudio | null = null;
  private music: MusicPlayer | null = null;
  private listener: (() => ListenerPose | null) | null = null;
  /** Smoothed CPU ms of update() (debugState). */
  private cpuMs = 0;
  private lastStep = -1;
  private lastThrottle = 0;
  private lastBoost = 0;
  private lastImpactAt = -1;
  private wheelOmega = [0, 0, 0, 0];

  resume(): void {
    if (this.failed) return;
    if (!this.ac) this.build();
    const ac = this.ac;
    if (ac && ac.state === 'suspended') void ac.resume().catch(() => {});
  }

  /** The context runs (or can never start: no Web Audio): main.ts's gesture hook stops calling resume(). */
  get started(): boolean {
    return this.failed || this.ac?.state === 'running';
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.out && this.ac) this.out.gain.setTargetAtTime(on ? 1 : 0, this.ac.currentTime, 0.05);
    if (!on) this.music?.pause();
  }

  /** The 3-D listener (CamListener.con: the render camera), read once per frame. */
  setListenerSource(fn: (() => ListenerPose | null) | null): void {
    this.listener = fn;
  }

  playUiSound(name: UiSoundName): void {
    if (this.enabled && this.ac?.state === 'running') this.orig?.playUiSound(name, 1);
  }

  private build(): void {
    const C: Ctor | undefined =
      typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext) : undefined;
    if (!C) {
      this.failed = true;
      return;
    }
    try {
      const ac = new C({ latencyHint: 'interactive' });
      const out = ac.createGain();
      out.gain.value = this.enabled ? 1 : 0;
      out.connect(ac.destination);
      this.ac = ac;
      this.out = out;
      this.mode = 'loading';
      current = this;
      if (typeof window !== 'undefined') window.__rallyAudio = { state: () => this.debugState() };
      if (musicEnabled()) this.music = new MusicPlayer();
      // the original bank when built (silent while its JSON loads), else the synth
      loadOriginalSoundBank(ac)
        .then((bank) => {
          if (this.ac !== ac) {
            bank?.dispose();
            return;
          }
          if (!bank) {
            this.buildSynth();
            return;
          }
          this.orig = new OriginalAudio(ac, bank, out);
          this.mode = 'original';
        })
        .catch((e) => {
          warnOnce('audio-bank', `audio: original sound bank unavailable (${String(e)}); using the synthesised sounds`);
          if (this.ac === ac) this.buildSynth();
        });
    } catch (e) {
      console.warn('audio: unavailable', e);
      this.failed = true;
      this.ac = null;
    }
  }

  private buildSynth(): void {
    const ac = this.ac;
    const out = this.out;
    if (!ac || !out) return;
    this.mode = 'synth';
    try {
      const master = ac.createGain();
      master.gain.value = 0.8;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master.connect(comp).connect(out);
      const noise = noiseBuffer(ac);
      const sources: AudioScheduledSourceNode[] = [];
      const noiseSrc = (rate = 1) => {
        const s = ac.createBufferSource();
        s.buffer = noise;
        s.loop = true;
        s.playbackRate.value = rate;
        s.start();
        sources.push(s);
        return s;
      };
      // engine
      const engGain = ac.createGain();
      engGain.gain.value = 0;
      const shaper = ac.createWaveShaper();
      shaper.curve = softClip(2.2);
      const engFilter = ac.createBiquadFilter();
      engFilter.type = 'lowpass';
      engFilter.frequency.value = 800;
      engFilter.Q.value = 1.2;
      const engOscA = ac.createOscillator();
      engOscA.type = 'sawtooth';
      const engOscB = ac.createOscillator();
      engOscB.type = 'sawtooth';
      engOscB.detune.value = 14;
      const engSub = ac.createOscillator();
      engSub.type = 'square';
      const subGain = ac.createGain();
      subGain.gain.value = 0.35;
      engOscA.connect(shaper);
      engOscB.connect(shaper);
      engSub.connect(subGain).connect(shaper);
      shaper.connect(engFilter).connect(engGain).connect(master);
      for (const o of [engOscA, engOscB, engSub]) {
        o.frequency.value = 60;
        o.start();
        sources.push(o);
      }
      // intake rasp: band-passed noise tracking the firing harmonics
      const rasp = ac.createBiquadFilter();
      rasp.type = 'bandpass';
      rasp.Q.value = 3;
      const raspGain = ac.createGain();
      raspGain.gain.value = 0;
      noiseSrc().connect(rasp).connect(raspGain).connect(master);
      // turbo whistle + blow-off hiss
      const turbo = ac.createOscillator();
      turbo.type = 'sine';
      const turboGain = ac.createGain();
      turboGain.gain.value = 0;
      turbo.connect(turboGain).connect(master);
      turbo.start();
      sources.push(turbo);
      const hiss = ac.createBiquadFilter();
      hiss.type = 'highpass';
      hiss.frequency.value = 2500;
      const hissGain = ac.createGain();
      hissGain.gain.value = 0;
      noiseSrc(1.3).connect(hiss).connect(hissGain).connect(master);
      // tyres / surface / wind
      const squeal = ac.createBiquadFilter();
      squeal.type = 'bandpass';
      squeal.frequency.value = 1150;
      squeal.Q.value = 9;
      const squealGain = ac.createGain();
      squealGain.gain.value = 0;
      noiseSrc(0.9).connect(squeal).connect(squealGain).connect(master);
      const rumble = ac.createBiquadFilter();
      rumble.type = 'lowpass';
      rumble.frequency.value = 280;
      const rumbleGain = ac.createGain();
      rumbleGain.gain.value = 0;
      noiseSrc(0.6).connect(rumble).connect(rumbleGain).connect(master);
      const crunch = ac.createBiquadFilter();
      crunch.type = 'bandpass';
      crunch.frequency.value = 2600;
      crunch.Q.value = 0.8;
      const crunchGain = ac.createGain();
      crunchGain.gain.value = 0;
      noiseSrc(1.7).connect(crunch).connect(crunchGain).connect(master);
      const wind = ac.createBiquadFilter();
      wind.type = 'bandpass';
      wind.frequency.value = 500;
      wind.Q.value = 0.6;
      const windGain = ac.createGain();
      windGain.gain.value = 0;
      noiseSrc(0.8).connect(wind).connect(windGain).connect(master);
      this.g = {
        ac, master, engOscA, engOscB, engSub, engFilter, engGain, rasp, raspGain, turbo, turboGain, hiss, hissGain,
        squeal, squealGain, rumble, rumbleGain, crunch, crunchGain, wind, windGain, noise, sources,
      };
    } catch (e) {
      console.warn('audio: synthesised sounds unavailable', e);
      this.g = null;
    }
  }

  update(ctx: Readonly<FrameContext>): void {
    const ac = this.ac;
    if (!ac || ac.state !== 'running') return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    if (this.orig) this.updateOriginal(ctx, this.orig);
    else if (this.g) this.updateSynth(ctx, this.g);
    if (t0) this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.05;
  }

  private updateOriginal(ctx: Readonly<FrameContext>, o: OriginalAudio): void {
    o.setListener(this.listener?.() ?? null, ctx.frameDt, ctx.telemetry.posSim);
    // sfxMaster = 1: rally-web has no options sliders; on / off is the output gain
    o.update(ctx, 1);
    const m = this.music;
    if (m) {
      m.setVolume(1);
      if (this.enabled && !ctx.paused) m.play();
      else m.pause();
    }
  }

  private updateSynth(ctx: Readonly<FrameContext>, g: Graph): void {
    const tel = ctx.telemetry;
    const t = g.ac.currentTime;
    const tc = 0.03;
    const silent = !this.enabled || ctx.paused;
    if (silent) {
      for (const n of [g.engGain, g.raspGain, g.turboGain, g.hissGain, g.squealGain, g.rumbleGain, g.crunchGain, g.windGain]) n.gain.setTargetAtTime(0, t, 0.05);
      return;
    }
    const arch = tel.archetype;
    const rpm = Math.max(600, tel.rpm || 0);
    const thr = Math.max(0, Math.min(1, tel.throttle || 0));
    const fire = (rpm / 60) * FIRING[arch] * PITCH[arch];
    g.engOscA.frequency.setTargetAtTime(fire, t, tc * 0.5);
    g.engOscB.frequency.setTargetAtTime(fire * 1.002, t, tc * 0.5);
    g.engSub.frequency.setTargetAtTime(fire * 0.5, t, tc * 0.5);
    const load = tel.shifting ? 0.25 : 0.35 + thr * 0.65;
    g.engFilter.frequency.setTargetAtTime(380 + thr * 2600 + rpm * 0.22, t, tc);
    g.engGain.gain.setTargetAtTime(0.1 + 0.16 * load, t, tc);
    g.rasp.frequency.setTargetAtTime(fire * 3, t, tc);
    g.raspGain.gain.setTargetAtTime(thr * 0.05 * Math.min(1, rpm / 5000), t, tc);
    // turbo
    const boost = Math.max(0, Math.min(1, tel.boostFrac || 0));
    g.turbo.frequency.setTargetAtTime(1800 + boost * 4200 + rpm * 0.15, t, 0.08);
    g.turboGain.gain.setTargetAtTime(boost * boost * 0.022 * (0.4 + thr * 0.6), t, 0.08);
    if (this.lastThrottle > 0.6 && thr < 0.2 && this.lastBoost > 0.45) {
      g.hissGain.gain.cancelScheduledValues(t);
      g.hissGain.gain.setValueAtTime(0.09 * this.lastBoost, t);
      g.hissGain.gain.setTargetAtTime(0, t + 0.04, 0.12);
    }
    this.lastThrottle = thr;
    this.lastBoost = boost;
    // surfaces: wheel slip from ω·R vs ground speed (kinematic, robust to the tyre model)
    const v = Math.abs(tel.velLocal?.z ?? tel.speedKmh / 3.6);
    let squeal = 0, loose = 0, crunch = 0, contacts = 0;
    for (let i = 0; i < 4; i++) {
      const w = tel.wheels[i];
      this.wheelOmega[i] = w.omega;
      if (!w.contact || !w.surface) continue;
      contacts++;
      const slipLong = Math.abs(w.omega * 0.3 - v);
      const slipLat = Math.abs(Math.sin(w.slipAngle || 0)) * v;
      const slip = Math.hypot(slipLong, slipLat);
      if (SQUEAL_SURFACES.has(w.surface)) squeal += Math.max(0, Math.min(1, (slip - 2.5) / 6));
      else if (SURFACE_INFO[w.surface].dust) {
        loose += Math.min(1, v / 30);
        crunch += Math.min(1, slip / 6) * 0.7 + Math.min(1, v / 40) * 0.3;
      }
    }
    g.squeal.frequency.setTargetAtTime(1000 + squeal * 90 + Math.sin(t * 13) * 40, t, tc);
    g.squealGain.gain.setTargetAtTime(Math.min(1, squeal / 2.5) * 0.12, t, 0.05);
    g.rumble.frequency.setTargetAtTime(160 + v * 12, t, 0.1);
    g.rumbleGain.gain.setTargetAtTime(contacts ? (loose / 4) * 0.3 + Math.min(1, v / 40) * 0.05 : 0, t, 0.08);
    g.crunchGain.gain.setTargetAtTime(contacts ? (crunch / 4) * 0.06 : 0, t, 0.06);
    g.wind.frequency.setTargetAtTime(350 + v * 12, t, 0.2);
    g.windGain.gain.setTargetAtTime(Math.min(0.12, (v * v) / 25000), t, 0.2);
    // impacts
    // max over the frame's substeps (a crash on an intermediate substep is not missed); short cooldown so
    // a scraping contact does not thump every frame
    const imp = Math.max(ctx.impactImpulseMax ?? 0, tel.impactImpulse);
    if (imp > 800 && (this.lastImpactAt < 0 || tel.stepCount - this.lastImpactAt > 18)) {
      this.lastImpactAt = tel.stepCount;
      this.thump(Math.min(1, imp / 8000));
    }
    if (this.lastStep >= 0 && tel.stepCount < this.lastStep) this.lastImpactAt = -1;
    this.lastStep = tel.stepCount;
    void DT;
  }

  private thump(k: number): void {
    const g = this.g;
    if (!g) return;
    const ac = g.ac;
    const t = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = g.noise;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 500 + k * 900;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.5 * k, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f).connect(gain).connect(g.master);
    src.start(t, Math.random());
    src.stop(t + 0.4);
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.25);
    const og = ac.createGain();
    og.gain.setValueAtTime(0.4 * k, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(og).connect(g.master);
    o.start(t);
    o.stop(t + 0.32);
  }

  /** Debug: the path in use, what the original engine plays, per-wheel ω of the synth surface voices. */
  debugState(): AudioDebugState {
    return {
      running: this.ac?.state === 'running',
      mode: this.mode,
      omega: [...this.wheelOmega],
      original: this.orig?.debug() ?? null,
      music: !!this.music,
      cpuMs: +this.cpuMs.toFixed(3),
    };
  }

  dispose(): void {
    const g = this.g;
    for (const s of g?.sources ?? []) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.g = null;
    this.orig?.dispose();
    this.orig = null;
    this.music?.dispose();
    this.music = null;
    if (current === this) current = null;
    const ac = this.ac;
    this.ac = null;
    this.out = null;
    if (ac) void ac.close().catch(() => {});
  }
}

/** Type re-export for tooling. */
export type { CarTelemetry };
