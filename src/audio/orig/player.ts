/**
 * src/audio/orig/player.ts — OWNED BY THE AUDIO BUILDER.
 *
 * OriginalAudio: the original sound system driven from the per-frame FrameContext (research/formats/sound.md §14.3):
 *   * SoundSystem (patch.ts) on its 15 Hz sound tick + the Web Audio voices (webBackend.ts);
 *   * the human CarSoundPlayer (carSound.ts) of the selected original car (FrameContext.origCar), or a default
 *     original car per archetype when the car is an archetype car (DEFAULT_ORIG_CAR);
 *   * the stage ambience (envSound.ts) from the stage's Objects.con placements;
 *   * the race UI scripts (Menu/menu/Sound/CountDown / CheckPoint / Error.ssc, 2-D) on the race events;
 *   * the menu meme sounds (Menu.rff menu/sound/<Name>.wav) through playUiSound();
 *   * the co-driver word player (coDriver.ts), registered for voice.ts.
 * The listener is the render camera (CamListener.con), committed at the sound tick.
 */
import type { ArchetypeId, FrameContext, RaceEvent, SimV3, ThreeV3 } from '../../core/types';
import type { AudioBankJson } from './bankTypes';
import { CarInputMapper } from './carInput';
import { CarSoundPlayer } from './carSound';
import { CoDriverPlayer, setCoDriverOutput } from './coDriver';
import { dsGain } from './ds';
import { EnvSoundManager } from './envSound';
import { type OriginalSoundBank, scriptSampleKeys } from './index';
import { ScriptInstance, SoundSystem } from './patch';
import { WebAudioBackend } from './webBackend';

/** The original car whose patches an archetype car uses (the archetype's handling class; all 29 patch sets have
 *  identical parameters except Metro6R4's Pipe, only the samples differ, sound.md §4.4). */
export const DEFAULT_ORIG_CAR: Readonly<Record<ArchetypeId, string>> = Object.freeze({
  awd_wrc: 'ImprezaWRX',
  fwd_hatch: 'Peugeot206',
  rwd_classic: 'FordEscort',
});

/** Menu meme sounds (sound.md §9). */
export type UiSoundName = 'Back' | 'Error' | 'Screeneffekt' | 'Select' | 'Step' | 'Sweep' | 'Tag' | 'Unlock';

/** Camera pose for the listener, THREE space (a column-major world matrix, as three's Object3D.matrixWorld). */
export interface ListenerPose {
  matrixWorld: { elements: ArrayLike<number> };
}

export interface OriginalAudioDebug {
  car: string | null;
  stage: string | null;
  ticks: number;
  livePatches: string[];
  voices: ReturnType<WebAudioBackend['info']>;
  envObjects: number;
  coDriver: { speaking: readonly number[] | null; notes: number };
  pendingSamples: number;
  /** The listener follows the render camera (else the car position), SIM space. */
  listener: { camera: boolean; pos: SimV3 };
  /** Every patch that got at least one voice since the stage loaded (`<script>#<patch>`). */
  heard: string[];
  /** The latest menu meme sounds that started (oldest first, at most 16). */
  ui: string[];
}

export class OriginalAudio {
  readonly sys: SoundSystem;
  readonly backend: WebAudioBackend;
  readonly coDriver: CoDriverPlayer;
  private readonly bank: AudioBankJson;
  private readonly sfxBus: GainNode;
  private readonly uiBus: GainNode;
  private car: CarSoundPlayer | null = null;
  private carName: string | null = null;
  private env: EnvSoundManager | null = null;
  private stageKey: string | null = null;
  private readonly ui: Record<string, ScriptInstance | null> = {};
  private readonly mapper = new CarInputMapper();
  private readonly listenerPos: SimV3 = { x: 0, y: 0, z: 0 };
  private readonly listenerVel: SimV3 = { x: 0, y: 0, z: 0 };
  private readonly fwd: ThreeV3 = { x: 0, y: 0, z: -1 };
  private readonly up: ThreeV3 = { x: 0, y: 1, z: 0 };
  private haveListener = false;
  private listenerIsCamera = false;
  private readonly heard = new Set<string>();
  /** Debug: the latest menu meme sounds that started. */
  private readonly uiPlayed: string[] = [];
  private muted = false;

  readonly ac: AudioContext;
  readonly sounds: OriginalSoundBank;

  constructor(ac: AudioContext, sounds: OriginalSoundBank, out: AudioNode) {
    this.ac = ac;
    this.sounds = sounds;
    this.bank = sounds.json;
    this.sfxBus = ac.createGain();
    this.sfxBus.connect(out);
    this.uiBus = ac.createGain();
    this.uiBus.connect(out);
    this.backend = new WebAudioBackend(ac, sounds, this.sfxBus);
    this.sys = new SoundSystem(this.backend, (Date.now() & 0x7fffffff) || 1);
    this.backend.sys = this.sys;
    this.sys.onTick = () => this.commitListener();
    for (const k of ['CountDown', 'CheckPoint', 'Error'] as const) {
      const key = this.bank.ui[k];
      const def = key ? this.bank.scripts[key] : undefined;
      this.ui[k] = key && def ? new ScriptInstance(this.sys, def, key, null) : null;
    }
    const words = this.bank.coDriver.words;
    this.coDriver = new CoDriverPlayer(
      this.sys,
      (id) => words[String(id)]?.s ?? null,
      (key) => sounds.sample(key) !== null,
      this.bank.coDriver.masterVolume,
    );
    // always-needed samples: race UI, menu, co-driver words
    void sounds.load([
      ...scriptSampleKeys(this.bank, Object.values(this.bank.ui)),
      ...Object.values(this.bank.menu),
      ...Object.values(words).map((w) => w.s),
    ]);
    setCoDriverOutput(this.coDriver);
  }

  /** Original car name for a FrameContext (origCar if it has a CarSoundPlayer, else the archetype default). */
  carFor(ctx: Readonly<FrameContext>): string | null {
    const c = ctx.origCar;
    if (c && this.bank.cars[c]) return c;
    const d = DEFAULT_ORIG_CAR[ctx.telemetry.archetype];
    return d && this.bank.cars[d] ? d : (Object.keys(this.bank.cars)[0] ?? null);
  }

  private setCar(name: string | null): void {
    if (name === this.carName) return;
    this.car?.dispose();
    this.car = null;
    this.carName = name;
    if (!name) return;
    this.car = new CarSoundPlayer(this.sys, this.bank, name, true, (Date.now() & 0x7fffffff) || 1);
    void this.sounds.load(this.car.sampleKeys());
  }

  private setStage(id: string, seed: number): void {
    const key = `${id}#${seed}`;
    if (key === this.stageKey) return;
    this.stageKey = key;
    // a stage change stops every sound (the original rebuilds its objects per level)
    this.env?.dispose();
    this.coDriver.stop();
    this.sys.stopAll();
    this.backend.stopAll();
    this.heard.clear();
    const car = this.carName;
    this.carName = null;
    this.car?.dispose();
    this.car = null;
    this.setCar(car);
    this.env = new EnvSoundManager(this.sys, this.bank, id);
    void this.sounds.load(this.env.sampleKeys());
  }

  /** Listener = the camera; SIM position from the THREE world matrix (z mirrored), velocity from the delta. */
  setListener(cam: ListenerPose | null, dt: number, fallbackSim: SimV3): void {
    let p: SimV3;
    this.listenerIsCamera = !!cam;
    if (cam) {
      const e = cam.matrixWorld.elements;
      p = { x: e[12], y: e[13], z: -e[14] };
      this.fwd.x = -e[8];
      this.fwd.y = -e[9];
      this.fwd.z = -e[10];
      this.up.x = e[4];
      this.up.y = e[5];
      this.up.z = e[6];
    } else p = { ...fallbackSim };
    if (this.haveListener && dt > 0) {
      const vx = (p.x - this.listenerPos.x) / dt;
      const vy = (p.y - this.listenerPos.y) / dt;
      const vz = (p.z - this.listenerPos.z) / dt;
      // a camera cut (reset, view change) is not a velocity
      const fast = Math.hypot(vx, vy, vz) > 120;
      this.listenerVel.x = fast ? 0 : vx;
      this.listenerVel.y = fast ? 0 : vy;
      this.listenerVel.z = fast ? 0 : vz;
    }
    this.listenerPos.x = p.x;
    this.listenerPos.y = p.y;
    this.listenerPos.z = p.z;
    if (!this.haveListener) {
      this.haveListener = true;
      this.commitListener();
    }
    this.sys.listener = { pos: this.listenerPos, vel: this.listenerVel };
  }

  /** The listener's deferred settings are committed at the sound tick (vt+0x34). */
  private commitListener(): void {
    if (!this.haveListener) return;
    this.backend.setListener(this.listenerPos, this.listenerVel, this.fwd, this.up);
    for (const p of this.sys.livePatches) if (p.sounding().length) this.heard.add(p.name);
  }

  /** Per rendered frame. */
  update(ctx: Readonly<FrameContext>, sfxMaster: number): void {
    this.setStage(ctx.stage.id, ctx.stage.seed);
    this.setCar(this.carFor(ctx));
    this.sys.sfxMaster = sfxMaster;
    const mute = ctx.paused;
    if (mute !== this.muted) {
      // pause: the game freezes and its sounds with it (no sound tick runs while paused)
      this.muted = mute;
      this.sfxBus.gain.setValueAtTime(mute ? 0 : 1, this.ac.currentTime);
    }
    for (const e of ctx.events) this.onEvent(e);
    // the pacenote player runs every frame (FUN_0067a250; voice.ts fired this frame's note, its +0x38 = pause)
    this.coDriver.setPaused(mute);
    this.coDriver.update();
    if (mute) return;
    const inp = this.mapper.map(ctx);
    this.car?.update(ctx.frameDt, inp);
    this.env?.update([inp.pos]);
    this.sys.advance(ctx.frameDt);
  }

  private onEvent(e: RaceEvent): void {
    const cd = this.ui.CountDown;
    switch (e.type) {
      case 'countdown':
        if (e.n > 0) cd?.playPatch(0); // "3, 2, 1" (CountDown.ssc patch 0, the meme node's First..Third)
        break;
      case 'go':
        cd?.playPatch(1); // go!.wav (patch 1, Fourth)
        break;
      case 'checkpoint':
        // patch 0 checkpointquicker / 1 checkpointslower: the split against the best (names, sound.md §9 [?])
        this.ui.CheckPoint?.playPatch(e.delta !== null && e.delta > 0 ? 1 : 0);
        break;
      default:
        break;
    }
  }

  /** Error.ssc (race UI error). */
  playError(): void {
    this.ui.Error?.playPatch(0);
  }

  /** A menu meme sound, straight from Menu.rff (2-D, no script). */
  playUiSound(name: UiSoundName, sfxMaster: number): void {
    const key = this.bank.menu[name];
    const buf = key ? this.sounds.sample(key) : null;
    if (!buf) return;
    const s = this.ac.createBufferSource();
    s.buffer = buf;
    const g = this.ac.createGain();
    g.gain.value = dsGain(sfxMaster);
    s.connect(g).connect(this.uiBus);
    s.onended = () => {
      s.disconnect();
      g.disconnect();
    };
    s.start();
    this.uiPlayed.push(name);
    if (this.uiPlayed.length > 16) this.uiPlayed.shift();
  }

  debug(): OriginalAudioDebug {
    return {
      car: this.carName,
      stage: this.stageKey,
      ticks: this.sys.ticks,
      livePatches: this.sys.livePatches.map((p) => p.name),
      voices: this.backend.info(),
      envObjects: this.env?.objects.length ?? 0,
      coDriver: { speaking: this.coDriver.speaking, notes: this.coDriver.notes },
      pendingSamples: this.sounds.pending,
      listener: { camera: this.listenerIsCamera, pos: { ...this.listenerPos } },
      heard: [...this.heard],
      ui: [...this.uiPlayed],
    };
  }

  dispose(): void {
    this.env?.dispose();
    this.car?.dispose();
    for (const s of Object.values(this.ui)) s?.kill();
    this.sys.stopAll();
    this.backend.stopAll();
    this.coDriver.dispose();
    setCoDriverOutput(null);
    this.sfxBus.disconnect();
    this.uiBus.disconnect();
    this.sounds.dispose();
  }
}
