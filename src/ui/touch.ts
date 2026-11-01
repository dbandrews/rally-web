/**
 * src/ui/touch.ts — on-screen driving controls for phones and tablets.
 *
 * Touch mode (body.rw-touch): on when the primary pointer is coarse or a finger touches the screen, off again on a
 * key press; `?touch=1` / `?touch=0` pin it. The HUD, menus and help restyle themselves for it (src/ui/styles.ts).
 *
 * TouchControls (in #hud-root; shown in touch mode while a race counts down or runs and no menu is open), landscape:
 *   left half   steering pad: the thumb's first contact is the centre and sliding sideways steers (analog, full lock
 *               at PAD_LOCK_FRAC of the short screen side). The centre follows a thumb pushed past full lock, so
 *               sliding back answers at once; lifting the thumb centres the wheel.
 *   right       GAS, BRAKE (held at a standstill = reverse, automatic gearbox) and HAND BRAKE above it; a thumb
 *               sliding between them changes pedal. Manual gearbox: gear + / − above the gas.
 *   top left    pause, camera, look back (hold), reset to road, fullscreen (where the browser has it).
 * Tilt steering (menu "Touch steer", uiSettings.touchSteer = 'tilt'): the device's roll against the horizon steers
 * (full lock at TILT_LOCK_DEG, like turning a wheel); brake and hand brake move to the left thumb. Without orientation
 * events (permission refused, plain http) the steering pad stays.
 * The first tap asks for fullscreen + landscape lock (Android; iPhone Safari has neither: Add to Home Screen instead,
 * public/manifest.webmanifest). A phone held upright while racing pauses the race; a banner asks to turn it sideways.
 *
 * InputManager.poll merges read() into the RawInput (src/input/input.ts TouchSource): pedals and buttons as keys (the
 * §5.1 digital ramps), steering as the analog 'touch' device (the filter's wheel preset; touchAxis shapes it).
 */
import type { FrameContext } from '../core/types';
import type { TouchInput, TouchSource } from '../input/input';
import { isTypingTarget, onUiSettings, toast, uiSettings } from './settings';
import { injectUiStyles } from './styles';

/** Steering pad full lock: this fraction of the short screen side (CSS px), clamped to [MIN, MAX]. */
const PAD_LOCK_FRAC = 0.19;
const PAD_LOCK_MIN = 56;
const PAD_LOCK_MAX = 110;
/** Pad dead zone, as a fraction of full lock (thumb jitter at the centre). */
const PAD_DEAD = 0.03;
/** The pad's bar is drawn this far above the thumb (the thumb would hide it). */
const PAD_BAR_ABOVE = 78;
/** Tilt: full lock at this roll, a dead zone around level (degrees). */
const TILT_LOCK_DEG = 25;
const TILT_DEAD_DEG = 1.5;
/** Tilt counts as live while orientation events keep coming (ms); the fallback notice after this long without (s). */
const TILT_STALE_MS = 600;
const TILT_WAIT_S = 1.5;
/** Pedal hit boxes reach this far past their drawn edges (CSS px). */
const PEDAL_SLACK = 12;
/** Phones (short side below this, CSS px) are not raced upright. */
const PHONE_MAX_SHORT_SIDE = 600;

// ------------------------------------------------------------------------------------------- steering math

/** Steering pad: thumb x against the floating centre → { centre (follows past full lock), offset -1..1 }. */
export function padSteer(anchor: number, x: number, lock: number): { anchor: number; d: number } {
  let dx = x - anchor;
  if (dx > lock) {
    anchor = x - lock;
    dx = lock;
  } else if (dx < -lock) {
    anchor = x + lock;
    dx = -lock;
  }
  return { anchor, d: dx / lock };
}

/**
 * Steering response: offset d -1..1 (pad or tilt) → the RawInput axis of the 'touch' device. An expo blend (half
 * linear near the centre for small corrections, full lock at the end); the filter squares the axis (steeringType 1,
 * wheel preset), so the axis is the square root of the steer wanted.
 */
export function touchAxis(d: number, dead = 0): number {
  const a = Math.min(1, Math.abs(d));
  if (a <= dead) return 0;
  const u = (a - dead) / (1 - dead);
  return Math.sign(d) * Math.sqrt(u * (0.45 + 0.55 * u));
}

/**
 * Device roll in degrees (+ = the screen's right side down) from deviceorientation beta / gamma and the screen
 * orientation angle (counter-clockwise turn from the natural orientation): the angle between the screen's x axis and
 * the horizon, whatever the pitch, so it works upright and laid back alike and needs no calibration.
 */
export function tiltRollDeg(beta: number, gamma: number, screenAngle: number): number {
  const r = Math.PI / 180;
  // earth "up" in device coordinates (deviceorientation Z-X'-Y'' angles)
  const upX = -Math.cos(beta * r) * Math.sin(gamma * r);
  const upY = Math.sin(beta * r);
  // the screen's x axis in device coordinates is (cos a, -sin a)
  const dot = upX * Math.cos(screenAngle * r) - upY * Math.sin(screenAngle * r);
  return Math.asin(Math.max(-1, Math.min(1, -dot))) / r;
}

function screenAngle(): number {
  const so = (globalThis.screen as (Screen & { orientation?: { angle?: number } }) | undefined)?.orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  const wo = (globalThis as { orientation?: number }).orientation; // iOS before 16.4
  return typeof wo === 'number' ? wo : 0;
}

/** iOS asks before it sends orientation events; call from a tap. true = granted or no prompt needed. */
export function requestTiltPermission(): Promise<boolean> {
  const doe = (globalThis as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  if (!doe) return Promise.resolve(false);
  if (typeof doe.requestPermission !== 'function') return Promise.resolve(true);
  return doe.requestPermission().then(
    (s) => s === 'granted',
    () => false,
  );
}

// ------------------------------------------------------------------------------------------- touch mode

let touchMode = false;
let forcedMode: boolean | null = null;
let modeReady = false;
const modeListeners = new Set<(on: boolean) => void>();

function setTouchMode(on: boolean): void {
  if (forcedMode !== null) on = forcedMode;
  if (on === touchMode) return;
  touchMode = on;
  document.body.classList.toggle('rw-touch', on);
  for (const l of modeListeners) l(on);
}

/** The URL pin or the primary pointer's guess, then follow the device used last (a touch / a key). */
export function initTouchMode(): void {
  if (modeReady || typeof window === 'undefined') return;
  modeReady = true;
  const q = new URLSearchParams(window.location.search).get('touch');
  forcedMode = q === '1' ? true : q === '0' ? false : null;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  touchMode = !(forcedMode ?? coarse); // force the first setTouchMode through
  setTouchMode(forcedMode ?? coarse);
  window.addEventListener('pointerdown', (e) => e.pointerType === 'touch' && setTouchMode(true), true);
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.repeat && !isTypingTarget(e.target) && !/^(Shift|Control|Alt|Meta|Unidentified)/.test(e.code) && e.code !== '') setTouchMode(false);
    },
    true,
  );
}

export function isTouchMode(): boolean {
  return touchMode;
}

export function onTouchMode(fn: (on: boolean) => void): () => void {
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

/** The device has a touch screen (the menu offers the touch steering choice). */
export function touchCapable(): boolean {
  if (touchMode) return true;
  const nav = globalThis.navigator as Navigator | undefined;
  return !!nav && (nav.maxTouchPoints ?? 0) > 0;
}

/** Fullscreen and landscape lock where the browser allows them (needs a tap; Android Chrome, desktop). */
async function enterFullscreen(): Promise<void> {
  try {
    const d = document.documentElement;
    if (!document.fullscreenElement && typeof d.requestFullscreen === 'function') await d.requestFullscreen({ navigationUI: 'hide' });
    const so = globalThis.screen?.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
    await so?.lock?.('landscape');
  } catch {
    /* refused or unsupported (iPhone Safari): the game runs in the browser window */
  }
}

function phonePortrait(): boolean {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return h > w && w < PHONE_MAX_SHORT_SIDE;
}

// ------------------------------------------------------------------------------------------- controls

type Pedal = 'throttle' | 'brake' | 'handbrake';
type Btn = 'pause' | 'camera' | 'lookBack' | 'reset' | 'fullscreen' | 'gearUp' | 'gearDown';
type Ptr = { kind: 'steer'; anchor: number; x: number; y: number; d: number } | { kind: 'pedal'; pedal: Pedal | null } | { kind: 'btn'; btn: Btn };

const PEDALS: readonly Pedal[] = ['throttle', 'brake', 'handbrake'];

const svg = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICONS: Record<Exclude<Btn, 'gearUp' | 'gearDown'>, string> = {
  pause: svg('<path d="M8.5 5v14M15.5 5v14" stroke-width="3.4"/>'),
  camera: svg('<path d="M3 7.5h11.5v9H3z"/><path d="M14.5 10.5 21 7v10l-6.5-3.5"/>'),
  lookBack: svg('<rect x="2.5" y="6" width="19" height="9" rx="2.5"/><path d="M12 15v4M14.5 10.5H9.5m2-2-2 2 2 2"/>'),
  reset: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4.5H15"/>'),
  fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
};
const BTN_LABEL: Record<Btn, string> = {
  pause: 'Pause',
  camera: 'Change camera',
  lookBack: 'Look back',
  reset: 'Reset to road',
  fullscreen: 'Fullscreen',
  gearUp: 'Gear up',
  gearDown: 'Gear down',
};

const CSS = /* css */ `
.rw-tc { position: absolute; inset: 0; z-index: 1; display: none; pointer-events: auto; touch-action: none;
  -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; font-family: var(--rw-font); color: var(--rw-text);
  --pw: clamp(64px, min(12vw, 20vh), 116px); --gap: 10px; --edge: 16px; --bot: calc(16px + env(safe-area-inset-bottom, 0px)); }
.rw-tc.rw-on { display: block; }

/* pedals: grip-ribbed plates, the pedal colour on top, filled while pressed */
.rw-tc-pedal { position: absolute; box-sizing: border-box; width: var(--pw); display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 12px; font-size: 13px; font-weight: 800; letter-spacing: .16em; line-height: 1.1; text-align: center; text-transform: uppercase;
  color: rgba(243,245,247,.9); text-shadow: 0 1px 2px rgba(0,0,0,.7);
  background: repeating-linear-gradient(180deg, rgba(255,255,255,.08) 0 4px, transparent 4px 12px), rgba(9,12,17,.5);
  border-top: 4px solid var(--c); clip-path: var(--rw-chamfer); }
.rw-tc-pedal.rw-down { color: var(--rw-ink); text-shadow: none; background: repeating-linear-gradient(180deg, rgba(0,0,0,.13) 0 4px, transparent 4px 12px), var(--c); }
.rw-tc-gas { --c: var(--rw-amber); right: var(--edge); bottom: var(--bot); height: calc(var(--pw) * 1.55); }
.rw-tc-brake { --c: var(--rw-red); right: calc(var(--edge) + var(--pw) + var(--gap)); bottom: var(--bot); height: calc(var(--pw) * 1.15); }
.rw-tc-hb { --c: var(--rw-blue); right: calc(var(--edge) + var(--pw) + var(--gap)); bottom: calc(var(--bot) + var(--pw) * 1.15 + var(--gap));
  height: calc(var(--pw) * .62); align-items: center; padding: 0; font-size: 11px; }
.rw-tc.rw-tilt .rw-tc-brake { right: auto; left: var(--edge); height: calc(var(--pw) * 1.55); }
.rw-tc.rw-tilt .rw-tc-hb { right: auto; left: var(--edge); bottom: calc(var(--bot) + var(--pw) * 1.55 + var(--gap)); }

/* small buttons */
.rw-tc-btn { box-sizing: border-box; width: 42px; height: 42px; display: flex; align-items: center; justify-content: center;
  background: rgba(9,12,17,.62); color: var(--rw-text); font: 800 26px/1 var(--rw-font);
  clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px); }
.rw-tc-btn svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.rw-tc-btn.rw-down { background: var(--rw-amber); color: var(--rw-ink); }
.rw-tc-btn[hidden] { display: none; }
.rw-tc-bar { position: absolute; left: 12px; top: 80px; display: flex; gap: 6px; }
.rw-tc-gears { position: absolute; right: var(--edge); bottom: calc(var(--bot) + var(--pw) * 1.55 + var(--gap)); width: var(--pw); display: none; flex-direction: column; gap: 6px; }
.rw-tc.rw-manual .rw-tc-gears { display: flex; }
.rw-tc-gears .rw-tc-btn { width: 100%; height: calc(var(--pw) * .5); border-top: 3px solid var(--rw-amber); }

/* steering pad: a bar above the thumb, centred where it landed */
.rw-tc-pad { position: absolute; left: 0; top: 0; height: 44px; display: none; pointer-events: none; will-change: transform; }
.rw-tc.rw-steering .rw-tc-pad { display: block; }
.rw-tc-pad::before { content: ''; position: absolute; left: 0; right: 0; top: 18px; height: 8px; background: rgba(9,12,17,.6); box-shadow: inset 0 0 0 1px rgba(255,255,255,.22); }
.rw-tc-pad::after { content: ''; position: absolute; left: 50%; top: 11px; width: 2px; height: 22px; margin-left: -1px; background: rgba(255,255,255,.6); }
.rw-tc-fill { position: absolute; top: 18px; height: 8px; background: var(--rw-amber); }
.rw-tc-knob { position: absolute; top: 2px; width: 8px; height: 40px; margin-left: -4px; background: #fff; box-shadow: 0 0 0 2px var(--rw-amber), 0 0 12px rgba(255,184,28,.8); }
.rw-tc-hint { position: absolute; left: max(24px, 9vw); bottom: calc(var(--bot) + 30px); display: flex; align-items: center; gap: 10px;
  font-size: 12px; font-weight: 700; letter-spacing: .26em; text-transform: uppercase; color: rgba(243,245,247,.6); text-shadow: 0 1px 3px rgba(0,0,0,.85); }
.rw-tc-hint span { font-size: 26px; letter-spacing: 0; color: var(--rw-amber); }
.rw-tc.rw-steering .rw-tc-hint, .rw-tc.rw-tilt .rw-tc-hint { display: none; }

/* tilt: the steer reading, bottom centre under the car */
.rw-tc-tilt { position: absolute; left: 50%; bottom: calc(var(--bot) - 6px); width: 180px; height: 6px; margin-left: -90px; display: none; background: rgba(9,12,17,.6); }
.rw-tc.rw-tilt .rw-tc-tilt { display: block; }
.rw-tc-tilt::after { content: ''; position: absolute; left: 50%; top: -4px; width: 2px; height: 14px; margin-left: -1px; background: rgba(255,255,255,.6); }
.rw-tc-tilt i { position: absolute; top: 0; bottom: 0; background: var(--rw-amber); }

/* phone held upright */
.rw-tc-turn { position: fixed; left: 0; right: 0; top: 12px; z-index: 30; display: none; align-items: center; gap: 10px; padding: 8px 14px 8px 10px;
  box-sizing: border-box; width: max-content; max-width: calc(100vw - 24px); margin: 0 auto; pointer-events: none; background: var(--rw-panel);
  border-left: 3px solid var(--rw-amber); font: 700 13px/1.2 var(--rw-font); letter-spacing: .12em; text-transform: uppercase; color: var(--rw-text); }
.rw-tc-turn svg { flex: none; width: 26px; height: 26px; fill: none; stroke: var(--rw-amber); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
@media (orientation: portrait) and (max-width: ${PHONE_MAX_SHORT_SIDE - 1}px) {
  body.rw-touch.rw-upright .rw-tc-turn { display: flex; }
  /* the race is paused upright: no HUD behind the pause card */
  body.rw-touch .rw-hud > *:not(.rw-fade):not(.rw-toast-wrap) { display: none !important; }
}
`;

let cssInjected = false;
function injectTouchStyles(): void {
  if (cssInjected) return;
  cssInjected = true;
  injectUiStyles();
  const el = document.createElement('style');
  el.id = 'rw-touch-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}

function div(cls: string, html = ''): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  e.innerHTML = html;
  return e;
}

export class TouchControls implements TouchSource {
  private readonly el: HTMLDivElement;
  private readonly pad: HTMLDivElement;
  private readonly padFill: HTMLElement;
  private readonly padKnob: HTMLElement;
  private readonly tiltFill: HTMLElement;
  private readonly turn: HTMLDivElement;
  private readonly pedalEls: Record<Pedal, HTMLDivElement>;
  private readonly btnEls = new Map<Btn, HTMLDivElement>();
  private readonly ptrs = new Map<number, Ptr>();
  private rects: { pedal: Pedal; r: DOMRect }[] = [];
  private shown = false;
  // last values written to the DOM every frame (written only when they change)
  private uprightOn = false;
  private tiltOn = false;
  private manualOn = false;
  private tiltLeft = '';
  private tiltWidth = '';
  private readonly edges = { gearUp: false, gearDown: false, cameraNext: false, pause: false };
  /** Tilt offset -1..1 (smoothed) and the time of the last orientation event. */
  private tilt = 0;
  private tiltAt = -Infinity;
  private tiltListening = false;
  private tiltWait = 0;
  private tiltWarned = false;
  private fullscreenTried = false;
  private readonly offSettings: () => void;

  private readonly onDown = (e: PointerEvent) => this.pointerDown(e);
  private readonly onMove = (e: PointerEvent) => this.pointerMove(e);
  private readonly onUp = (e: PointerEvent) => this.pointerUp(e);
  private readonly onOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    const d = Math.max(-1, Math.min(1, tiltRollDeg(e.beta, e.gamma, screenAngle()) / TILT_LOCK_DEG));
    this.tilt += (d - this.tilt) * 0.5; // the sensor jitters; events come at 30-60 Hz
    this.tiltAt = performance.now();
  };
  /** The first tap of a touch session asks for fullscreen + landscape (needs the tap's user activation: pointerup). */
  private readonly onFirstTap = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || this.fullscreenTried || !touchMode) return;
    this.fullscreenTried = true;
    window.removeEventListener('pointerup', this.onFirstTap, true);
    void enterFullscreen();
  };

  constructor(root: HTMLElement) {
    injectTouchStyles();
    initTouchMode();
    this.el = div('rw-tc');
    this.el.setAttribute('aria-hidden', 'true');

    const bar = div('rw-tc-bar');
    for (const b of ['pause', 'camera', 'lookBack', 'reset', 'fullscreen'] as const) {
      const e = div('rw-tc-btn', ICONS[b]);
      e.dataset.b = b;
      e.title = BTN_LABEL[b];
      bar.appendChild(e);
      this.btnEls.set(b, e);
    }
    this.btnEls.get('fullscreen')!.hidden = typeof document.documentElement.requestFullscreen !== 'function';
    const gears = div('rw-tc-gears');
    for (const [b, label] of [
      ['gearUp', '+'],
      ['gearDown', '−'],
    ] as const) {
      const e = div('rw-tc-btn', label);
      e.dataset.b = b;
      e.title = BTN_LABEL[b];
      gears.appendChild(e);
      this.btnEls.set(b, e);
    }

    this.pedalEls = {
      throttle: div('rw-tc-pedal rw-tc-gas', 'Gas'),
      brake: div('rw-tc-pedal rw-tc-brake', 'Brake'),
      handbrake: div('rw-tc-pedal rw-tc-hb', 'Hand<br>brake'),
    };

    this.pad = div('rw-tc-pad', '<i class="rw-tc-fill"></i><i class="rw-tc-knob"></i>');
    this.padFill = this.pad.querySelector('.rw-tc-fill') as HTMLElement;
    this.padKnob = this.pad.querySelector('.rw-tc-knob') as HTMLElement;
    const hint = div('rw-tc-hint', '<span>‹</span>Slide to steer<span>›</span>');
    const tilt = div('rw-tc-tilt', '<i></i>');
    this.tiltFill = tilt.firstElementChild as HTMLElement;

    this.el.append(hint, this.pedalEls.throttle, this.pedalEls.brake, this.pedalEls.handbrake, gears, bar, tilt, this.pad);
    root.appendChild(this.el);

    this.turn = div(
      'rw-tc-turn',
      svg('<rect x="7" y="2.5" width="10" height="17" rx="2" transform="rotate(-90 12 12)"/><path d="M4 7.5a8.5 8.5 0 0 1 4-4M5.5 3.2 8 3.5l-.3 2.5"/>') +
        'Turn your phone sideways to drive',
    );
    document.body.appendChild(this.turn);

    this.el.addEventListener('pointerdown', this.onDown);
    this.el.addEventListener('pointermove', this.onMove);
    this.el.addEventListener('pointerup', this.onUp);
    this.el.addEventListener('pointercancel', this.onUp);
    this.el.addEventListener('lostpointercapture', this.onUp);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointerup', this.onFirstTap, true);
    this.offSettings = onUiSettings(() => this.syncTiltListener());
    this.syncTiltListener();
  }

  // ----------------------------------------------------------------------------------------- TouchSource

  read(): TouchInput | null {
    const e = this.edges;
    if (!this.shown && !e.gearUp && !e.gearDown && !e.cameraNext && !e.pause) return null;
    let steer: number | null = null;
    let throttle = false;
    let brake = false;
    let handbrake = false;
    let reset = false;
    let lookBack = false;
    if (this.shown) {
      if (this.tiltLive()) steer = touchAxis(this.tilt, TILT_DEAD_DEG / TILT_LOCK_DEG);
      for (const p of this.ptrs.values()) {
        if (p.kind === 'steer' && steer === null) steer = touchAxis(p.d, PAD_DEAD);
        else if (p.kind === 'pedal') {
          throttle ||= p.pedal === 'throttle';
          brake ||= p.pedal === 'brake';
          handbrake ||= p.pedal === 'handbrake';
        } else if (p.kind === 'btn') {
          reset ||= p.btn === 'reset';
          lookBack ||= p.btn === 'lookBack';
        }
      }
    }
    const out: TouchInput = { steer, throttle, brake, handbrake, reset, lookBack, ...e };
    e.gearUp = e.gearDown = e.cameraNext = e.pause = false;
    return out;
  }

  // ----------------------------------------------------------------------------------------- per frame

  /** Show / hide for the frame (touch mode, a race on, no menu), layout classes, tilt fallback, upright pause. */
  update(ctx: Readonly<FrameContext>, menuOpen: boolean): void {
    const ph = ctx.race.phase;
    const racing = ph === 'countdown' || ph === 'running';
    const upright = touchMode && phonePortrait();
    // racing a phone held upright: pause (the pause card waits; the banner asks to turn it, not over the menus at rest)
    if (upright && racing && !menuOpen && !ctx.paused) this.edges.pause = true;
    const uprightOn = upright && racing;
    if (uprightOn !== this.uprightOn) {
      this.uprightOn = uprightOn;
      document.body.classList.toggle('rw-upright', uprightOn);
    }
    const show = touchMode && racing && !menuOpen && !upright;
    if (show !== this.shown) {
      this.shown = show;
      this.el.classList.toggle('rw-on', show);
      if (!show) this.releaseAll();
    }
    if (!show) return;

    const tiltWanted = uiSettings.touchSteer === 'tilt';
    const live = this.tiltLive();
    if (tiltWanted && !live && !ctx.paused) {
      this.tiltWait += ctx.frameDt;
      if (this.tiltWait > TILT_WAIT_S && !this.tiltWarned) {
        this.tiltWarned = true;
        toast('Tilt steering unavailable here: steer with the touch pad');
      }
    } else this.tiltWait = 0;
    if (live !== this.tiltOn) {
      this.tiltOn = live;
      this.el.classList.toggle('rw-tilt', live);
    }
    const manual = ctx.telemetry.transmission === 'manual';
    if (manual !== this.manualOn) {
      this.manualOn = manual;
      this.el.classList.toggle('rw-manual', manual);
    }
    if (live) {
      const d = Math.max(-1, Math.min(1, this.tilt));
      const left = `${(50 + Math.min(0, d) * 50).toFixed(1)}%`;
      if (left !== this.tiltLeft) {
        this.tiltLeft = left;
        this.tiltFill.style.left = left;
      }
      const width = `${(Math.abs(d) * 50).toFixed(1)}%`;
      if (width !== this.tiltWidth) {
        this.tiltWidth = width;
        this.tiltFill.style.width = width;
      }
    }
  }

  // ----------------------------------------------------------------------------------------- pointers

  private lock(): number {
    return Math.max(PAD_LOCK_MIN, Math.min(PAD_LOCK_MAX, PAD_LOCK_FRAC * Math.min(window.innerWidth, window.innerHeight)));
  }

  private tiltLive(): boolean {
    return uiSettings.touchSteer === 'tilt' && performance.now() - this.tiltAt < TILT_STALE_MS;
  }

  private pedalAt(x: number, y: number): Pedal | null {
    let best: Pedal | null = null;
    let bestD = Infinity;
    for (const { pedal, r } of this.rects) {
      if (x < r.left - PEDAL_SLACK || x > r.right + PEDAL_SLACK || y < r.top - PEDAL_SLACK || y > r.bottom + PEDAL_SLACK) continue;
      const d = Math.hypot(x - (r.left + r.right) / 2, y - (r.top + r.bottom) / 2);
      if (d < bestD) {
        bestD = d;
        best = pedal;
      }
    }
    return best;
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.shown) return;
    e.preventDefault();
    try {
      this.el.setPointerCapture(e.pointerId); // moves keep coming when the thumb slides off a control
    } catch {
      /* synthetic pointer */
    }
    const b = (e.target as Element | null)?.closest?.('[data-b]') as HTMLElement | null;
    if (b) {
      const btn = b.dataset.b as Btn;
      this.ptrs.set(e.pointerId, { kind: 'btn', btn });
      if (btn === 'pause') this.edges.pause = true;
      else if (btn === 'camera') this.edges.cameraNext = true;
      else if (btn === 'gearUp') this.edges.gearUp = true;
      else if (btn === 'gearDown') this.edges.gearDown = true;
      (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(12);
      this.paint();
      return;
    }
    this.rects = PEDALS.map((pedal) => ({ pedal, r: this.pedalEls[pedal].getBoundingClientRect() }));
    const pedal = this.pedalAt(e.clientX, e.clientY);
    const box = this.el.getBoundingClientRect();
    const padZone = !this.tiltLive() && e.clientX - box.left < box.width / 2;
    const steering = [...this.ptrs.values()].some((p) => p.kind === 'steer');
    if (!pedal && padZone && !steering) this.ptrs.set(e.pointerId, { kind: 'steer', anchor: e.clientX, x: e.clientX, y: e.clientY, d: 0 });
    else this.ptrs.set(e.pointerId, { kind: 'pedal', pedal }); // near the pedals: sliding onto one presses it
    this.paint();
  }

  private pointerMove(e: PointerEvent): void {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    if (p.kind === 'steer') {
      const s = padSteer(p.anchor, e.clientX, this.lock());
      p.anchor = s.anchor;
      p.d = s.d;
      p.x = e.clientX;
      p.y = e.clientY;
      this.drawPad();
    } else if (p.kind === 'pedal') {
      const q = this.pedalAt(e.clientX, e.clientY);
      if (q !== p.pedal) {
        p.pedal = q;
        this.paint();
      }
    }
  }

  private pointerUp(e: PointerEvent): void {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    this.ptrs.delete(e.pointerId);
    // fullscreen needs the user activation of the release (a touch press grants none)
    if (p.kind === 'btn' && p.btn === 'fullscreen' && e.type === 'pointerup') {
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
      else void enterFullscreen();
    }
    this.paint();
  }

  private releaseAll(): void {
    this.ptrs.clear();
    this.paint();
  }

  /** Pressed states and the steering bar. */
  private paint(): void {
    const on = new Set<string>();
    for (const p of this.ptrs.values()) {
      if (p.kind === 'pedal' && p.pedal) on.add(p.pedal);
      else if (p.kind === 'btn') on.add(p.btn);
    }
    for (const pd of PEDALS) this.pedalEls[pd].classList.toggle('rw-down', on.has(pd));
    for (const [b, e] of this.btnEls) e.classList.toggle('rw-down', on.has(b));
    this.drawPad();
  }

  private drawPad(): void {
    let s: Extract<Ptr, { kind: 'steer' }> | null = null;
    for (const p of this.ptrs.values()) if (p.kind === 'steer') s = p;
    this.el.classList.toggle('rw-steering', s !== null);
    if (!s) return;
    const lock = this.lock();
    const y = Math.max(8, s.y - PAD_BAR_ABOVE);
    this.pad.style.width = `${(2 * lock).toFixed(0)}px`;
    this.pad.style.transform = `translate(${(s.anchor - lock).toFixed(1)}px, ${y.toFixed(1)}px)`;
    const k = (1 + s.d) * lock;
    this.padKnob.style.left = `${k.toFixed(1)}px`;
    this.padFill.style.left = `${Math.min(k, lock).toFixed(1)}px`;
    this.padFill.style.width = `${Math.abs(k - lock).toFixed(1)}px`;
  }

  private syncTiltListener(): void {
    const want = uiSettings.touchSteer === 'tilt';
    if (want === this.tiltListening) return;
    this.tiltListening = want;
    if (want) {
      this.tiltWarned = false;
      window.addEventListener('deviceorientation', this.onOrientation);
    } else {
      window.removeEventListener('deviceorientation', this.onOrientation);
      this.tiltAt = -Infinity;
    }
  }

  dispose(): void {
    window.removeEventListener('deviceorientation', this.onOrientation);
    window.removeEventListener('pointerup', this.onFirstTap, true);
    this.offSettings();
    this.el.remove();
    this.turn.remove();
    document.body.classList.remove('rw-upright');
    this.uprightOn = false;
  }
}
