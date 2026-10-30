/**
 * src/audio/orig/webBackend.ts — OWNED BY THE AUDIO BUILDER.
 *
 * The audible side of the patch engine (patch.ts VoiceBackend): one Web Audio voice per playing layer, as the
 * original's DirectSound buffers (research/formats/sound.md §3.3 / §3.5 / §14.2):
 *
 *   AudioBufferSourceNode(loop = layer.loop over the WHOLE buffer) → GainNode(DS volume law)
 *     → [PannerNode(equalpower, inverse, ref = minDistance, rolloff 1) if the layer is 3-D] → bus
 *
 * Every value is pushed with setValueAtTime at the 15 Hz sound tick (stepped, as DirectSound applied them; no
 * smoothing). Positions arrive in SIM space and are converted to THREE space (z mirrored) for the PannerNodes and
 * the AudioListener — raw SIM coordinates would swap left / right in Web Audio's right-handed frame (sound.md §14.2
 * Verification). Doppler (DS3D DopplerFactor 1.4, removed from Web Audio) multiplies the playback rate.
 */
import type { SimV3, ThreeV3 } from '../../core/types';
import type { LayerJson } from './bankTypes';
import { DS_MAX_DISTANCE, DS_ROLLOFF, dopplerFactor, dsGain, dsPlaybackRate } from './ds';
import type { OriginalSoundBank } from './index';
import type { SoundSystem, Voice, VoiceBackend, VoiceUpdate } from './patch';

/** Web Audio's PannerNode maxDistance only clamps the distance law; anything past every audible range works. */
const PANNER_MAX_DISTANCE = Math.min(DS_MAX_DISTANCE, 1e4);

export interface VoiceInfo {
  layer: string;
  sample: string | null;
  loop: boolean;
  is3d: boolean;
  gain: number;
  rate: number;
}

const ZERO: SimV3 = { x: 0, y: 0, z: 0 };

class WebVoice implements Voice {
  playing = true;
  gainValue = 0;
  rateValue = 1;
  private readonly src: AudioBufferSourceNode;
  private readonly gain: GainNode;
  private readonly panner: PannerNode | null;

  private readonly be: WebAudioBackend;
  readonly layer: LayerJson;

  constructor(be: WebAudioBackend, layer: LayerJson, buffer: AudioBuffer, bus: AudioNode) {
    this.be = be;
    this.layer = layer;
    const ac = be.ac;
    this.src = ac.createBufferSource();
    this.src.buffer = buffer;
    // DirectSound loops the whole buffer (Play(0, 0, DSBPLAY_LOOPING), 0x6b3d30): loopStart = loopEnd = 0
    this.src.loop = layer.loop;
    this.gain = ac.createGain();
    this.gain.gain.value = 0;
    this.src.connect(this.gain);
    if (layer.is3d) {
      const p = ac.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = Math.max(1e-3, layer.minDistance);
      p.rolloffFactor = DS_ROLLOFF;
      p.maxDistance = PANNER_MAX_DISTANCE;
      this.gain.connect(p).connect(bus);
      this.panner = p;
    } else {
      this.gain.connect(bus);
      this.panner = null;
    }
    this.src.onended = () => this.finish();
    this.src.start();
  }

  update(u: Readonly<VoiceUpdate>): void {
    if (!this.playing) return;
    const be = this.be;
    const t = be.ac.currentTime;
    // §3.3: voice = vol · sfxMaster (vol already includes patch.volume), DS clamp ≤ 1 and the mB law
    const g = dsGain(u.volume * be.sfxMaster());
    if (g !== this.gainValue) {
      this.gain.gain.setValueAtTime(g, t);
      this.gainValue = g;
    }
    let rate = dsPlaybackRate(u.pitch, this.src.buffer?.sampleRate ?? 44100);
    const lst = be.listenerSim;
    if (this.panner) {
      // 3-D: the emitter position (null = no parent: at the listener, head-relative)
      const pos = u.pos ?? lst.pos;
      const p3 = toThree(pos);
      setPos(this.panner, p3, t);
      const r = Math.max(1e-3, u.minDistance);
      if (this.panner.refDistance !== r) this.panner.refDistance = r;
      if (u.pos) rate *= dopplerFactor(u.pos, u.doppler ? (u.vel ?? ZERO) : lst.vel, lst.pos, lst.vel);
    }
    if (rate !== this.rateValue) {
      this.src.playbackRate.setValueAtTime(rate, t);
      this.rateValue = rate;
    }
  }

  stop(): void {
    if (!this.playing) return;
    this.src.onended = null;
    try {
      this.src.stop();
    } catch {
      /* not started / already stopped */
    }
    this.finish();
  }

  private finish(): void {
    this.playing = false;
    this.src.onended = null;
    this.src.disconnect();
    this.gain.disconnect();
    this.panner?.disconnect();
    this.be.voices.delete(this);
  }
}

const toThree = (p: SimV3): ThreeV3 => ({ x: p.x, y: p.y, z: -p.z });

function setPos(n: PannerNode, p: ThreeV3, t: number): void {
  if (n.positionX) {
    n.positionX.setValueAtTime(p.x, t);
    n.positionY.setValueAtTime(p.y, t);
    n.positionZ.setValueAtTime(p.z, t);
  } else (n as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(p.x, p.y, p.z);
}

export class WebAudioBackend implements VoiceBackend {
  readonly voices = new Set<WebVoice>();
  /** Listener in SIM space (doppler); the AudioListener itself is set in THREE space by setListener(). */
  readonly listenerSim = { pos: { x: 0, y: 0, z: 0 } as SimV3, vel: { x: 0, y: 0, z: 0 } as SimV3 };
  sys: SoundSystem | null = null;

  readonly ac: BaseAudioContext;
  readonly bank: OriginalSoundBank;
  readonly bus: AudioNode;

  constructor(ac: BaseAudioContext, bank: OriginalSoundBank, bus: AudioNode) {
    this.ac = ac;
    this.bank = bank;
    this.bus = bus;
  }

  sfxMaster(): number {
    const v = this.sys?.sfxMaster ?? 1;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  start(layer: LayerJson): Voice | null {
    const buf = layer.s ? this.bank.sample(layer.s) : null;
    if (!buf) return null; // missing / not loaded yet: silent, as the original's failed load
    const v = new WebVoice(this, layer, buf, this.bus);
    this.voices.add(v);
    return v;
  }

  /**
   * Listener (CamListener: the camera). posSim / velSim feed the Distance source and doppler; the AudioListener
   * gets the THREE-space position, forward and up (committed at the sound tick, as the DS3D deferred settings).
   */
  setListener(posSim: SimV3, velSim: SimV3, fwdThree: ThreeV3, upThree: ThreeV3): void {
    const L = this.listenerSim;
    L.pos.x = posSim.x;
    L.pos.y = posSim.y;
    L.pos.z = posSim.z;
    L.vel.x = velSim.x;
    L.vel.y = velSim.y;
    L.vel.z = velSim.z;
    const l = this.ac.listener;
    const t = this.ac.currentTime;
    const p = toThree(posSim);
    if (l.positionX) {
      l.positionX.setValueAtTime(p.x, t);
      l.positionY.setValueAtTime(p.y, t);
      l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(fwdThree.x, t);
      l.forwardY.setValueAtTime(fwdThree.y, t);
      l.forwardZ.setValueAtTime(fwdThree.z, t);
      l.upX.setValueAtTime(upThree.x, t);
      l.upY.setValueAtTime(upThree.y, t);
      l.upZ.setValueAtTime(upThree.z, t);
    } else {
      const ll = l as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(...v: number[]): void };
      ll.setPosition(p.x, p.y, p.z);
      ll.setOrientation(fwdThree.x, fwdThree.y, fwdThree.z, upThree.x, upThree.y, upThree.z);
    }
  }

  /** Debug: every sounding voice. */
  info(): VoiceInfo[] {
    return [...this.voices].map((v) => ({
      layer: v.layer.path,
      sample: v.layer.s,
      loop: v.layer.loop,
      is3d: v.layer.is3d,
      gain: +v.gainValue.toFixed(4),
      rate: +v.rateValue.toFixed(4),
    }));
  }

  stopAll(): void {
    for (const v of [...this.voices]) v.stop();
  }
}
