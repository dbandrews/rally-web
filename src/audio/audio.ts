/**
 * src/audio/audio.ts — OWNED BY THE RENDER BUILDER (presentation). Optional polish, lowest priority.
 *
 * Procedural (synthesised, ORIGINAL) engine / turbo / tyre / surface / impact audio with WebAudio.
 * No sampled audio from any other game.
 *
 * REQUIRED EXPORTS (contract in src/core/types.ts IAudioEngine):
 *   class AudioEngine implements IAudioEngine
 *     constructor()
 *     resume(): void              // call from a user gesture (main.ts does on first keydown/pointerdown)
 *     setEnabled(on: boolean): void; readonly enabled: boolean
 *     update(ctx: Readonly<FrameContext>): void   // per frame: rpm, throttle, boostFrac, gear, wheel slip, surface
 *     dispose(): void
 *
 * Voices (all synthesised): engine = two detuned oscillators at the firing frequency (4-cyl: 2 pulses per
 * rev, the classic coupe's 5-cyl: 2.5) through a soft clipper and a throttle-opened low-pass, plus an
 * intake rasp band; turbo whistle + blow-off hiss on lift; tyre squeal (tarmac family) from band-passed
 * noise driven by wheel slip; loose-surface rumble + stone crunch from speed; wind from speed²;
 * a thump on impacts. Everything ramps with setTargetAtTime, so the per-frame cost is a handful of
 * parameter writes.
 */
import { DT, SURFACE_INFO } from '../core/constants';
import type { ArchetypeId, CarTelemetry, FrameContext, IAudioEngine, SurfaceId } from '../core/types';

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

export class AudioEngine implements IAudioEngine {
  enabled = true;
  private g: Graph | null = null;
  private failed = false;
  private lastStep = -1;
  private lastThrottle = 0;
  private lastBoost = 0;
  private lastImpactAt = -1;
  private wheelOmega = [0, 0, 0, 0];

  resume(): void {
    if (this.failed) return;
    if (!this.g) this.build();
    const ac = this.g?.ac;
    if (ac && ac.state === 'suspended') void ac.resume().catch(() => {});
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.g) this.g.master.gain.setTargetAtTime(on ? 0.8 : 0, this.g.ac.currentTime, 0.05);
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
      const master = ac.createGain();
      master.gain.value = this.enabled ? 0.8 : 0;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master.connect(comp).connect(ac.destination);
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
      console.warn('audio: unavailable', e);
      this.failed = true;
      this.g = null;
    }
  }

  update(ctx: Readonly<FrameContext>): void {
    const g = this.g;
    if (!g || g.ac.state !== 'running') return;
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

  /** Debug: current per-wheel ω used for the surface voices. */
  debugState(): { running: boolean; omega: number[] } {
    return { running: this.g?.ac.state === 'running', omega: [...this.wheelOmega] };
  }

  dispose(): void {
    const g = this.g;
    if (!g) return;
    for (const s of g.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    void g.ac.close().catch(() => {});
    this.g = null;
  }
}

/** Type re-export for tooling. */
export type { CarTelemetry };
