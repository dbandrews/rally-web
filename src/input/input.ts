/**
 * src/input/input.ts — OWNED BY THE GAME BUILDER.
 *
 * Keyboard + gamepad + touch devices -> RawInput (once per rendered frame). Bindings: ./bindings.ts GAME_KEYS
 * (arrows/WASD, Space handbrake, E/Shift gear up, Q/Z gear down, R reset, C camera, V look back,
 * P pause) and GAMEPAD_BINDINGS (standard mapping); the on-screen controls (src/ui/touch.ts) through TouchSource.
 * Device presets (§5.1): keyboard = all digital (the sim's InputFilter ramps them); gamepad = analog stick
 * (the filter applies dead zone 0.1 and sqrtCurve 1), analog triggers -> analog pedals (…Digital = false),
 * buttons -> digital; touch = pedals and buttons digital like keys, steering analog ('touch' device, shaped by the
 * touch controls). When several are used, a held key wins for that channel, then touch, then the pad.
 * Listens to KeyboardEvent.code on `window` (tools/drive.mjs sends real key events through Playwright);
 * preventDefault on bound keys (Space / arrows scroll the page otherwise); ignores keys typed into text
 * fields. The §5.1 filter itself lives in src/sim/inputFilter.ts (consumed by main.ts), not here.
 *
 * REQUIRED EXPORTS (contract in src/core/types.ts IInputManager):
 *   class InputManager implements IInputManager
 *     constructor(target?: Window)
 *     poll(): RawInput                // edge fields true for exactly one poll per press
 *     readonly activeDevice: InputDevice
 *     dispose(): void
 */
import { neutralRawInput } from '../core/constants';
import type { IInputManager, InputDevice, RawInput } from '../core/types';
import { GAME_KEYS, GAMEPAD_BINDINGS, isTypingTarget, type GameAction } from './bindings';

/** Minimal event-target surface we need (a Window in the game, a fake in tests). */
export interface InputTarget {
  addEventListener(type: string, fn: (e: never) => void, opts?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, fn: (e: never) => void, opts?: boolean | EventListenerOptions): void;
}

interface KeyLike {
  code: string;
  target: EventTarget | null;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  preventDefault(): void;
}

type PadReader = () => readonly (Gamepad | null)[];

/** One read of the on-screen controls (src/ui/touch.ts): levels, plus edges pressed since the last read. */
export interface TouchInput {
  /** Analog axis for the 'touch' device, -1..1 (+ = right), or null when nothing steers. */
  steer: number | null;
  throttle: boolean;
  brake: boolean;
  handbrake: boolean;
  reset: boolean;
  lookBack: boolean;
  gearUp: boolean;
  gearDown: boolean;
  cameraNext: boolean;
  pause: boolean;
}

export interface TouchSource {
  /** null while the controls are off and no edge is pending. */
  read(): TouchInput | null;
}

/** Stick movement / trigger travel that marks the pad as the active device. */
const PAD_ACTIVITY = 0.25;

export class InputManager implements IInputManager {
  activeDevice: InputDevice = 'keyboard';
  /** Index of the gamepad in use, or -1. */
  padIndex = -1;
  private readonly target: InputTarget;
  private readonly down = new Set<string>();
  /** Codes pressed since the last poll (edges survive press+release between two polls). */
  private readonly pressed = new Set<string>();
  private readonly codeToAction = new Map<string, GameAction>();
  private readonly padPrev: boolean[] = [];
  private readonly readPads: PadReader;
  private readonly touch: TouchSource | null;

  private readonly onKeyDown = (e: KeyLike) => {
    if (isTypingTarget(e.target)) return;
    // Ctrl/Meta chords belong to the browser (Ctrl+W/T/N cannot be blocked anyway); never treat them as driving.
    if (e.ctrlKey || e.metaKey) return;
    const a = this.codeToAction.get(e.code);
    if (!a) return;
    e.preventDefault();
    if (!this.down.has(e.code) && !e.repeat) this.pressed.add(e.code);
    this.down.add(e.code);
    this.activeDevice = 'keyboard';
  };
  private readonly onKeyUp = (e: KeyLike) => {
    if (this.codeToAction.has(e.code) && !isTypingTarget(e.target)) e.preventDefault();
    this.down.delete(e.code);
  };
  private readonly onBlur = () => {
    this.down.clear();
  };

  constructor(target: Window | InputTarget = window, readPads?: PadReader, touch?: TouchSource) {
    this.target = target as InputTarget;
    this.touch = touch ?? null;
    this.readPads =
      readPads ??
      (() => {
        try {
          const nav = (globalThis as { navigator?: Navigator }).navigator;
          return nav && typeof nav.getGamepads === 'function' ? nav.getGamepads() : [];
        } catch {
          return [];
        }
      });
    for (const [action, codes] of Object.entries(GAME_KEYS) as [GameAction, readonly string[]][]) {
      for (const c of codes) this.codeToAction.set(c, action);
    }
    this.target.addEventListener('keydown', this.onKeyDown as (e: never) => void);
    this.target.addEventListener('keyup', this.onKeyUp as (e: never) => void);
    this.target.addEventListener('blur', this.onBlur as (e: never) => void);
  }

  /** Held now, or tapped since the last poll (a tap shorter than one frame still registers once). */
  private held(a: GameAction): boolean {
    for (const c of GAME_KEYS[a]) if (this.down.has(c) || this.pressed.has(c)) return true;
    return false;
  }
  private edge(a: GameAction): boolean {
    for (const c of GAME_KEYS[a]) if (this.pressed.has(c)) return true;
    return false;
  }

  /** First connected gamepad (prefers the one used last). */
  private pad(): Gamepad | null {
    const pads = this.readPads();
    if (this.padIndex >= 0 && pads[this.padIndex]?.connected) return pads[this.padIndex];
    for (const p of pads) {
      if (p && p.connected) {
        this.padIndex = p.index;
        return p;
      }
    }
    this.padIndex = -1;
    return null;
  }

  poll(): RawInput {
    const r = neutralRawInput();
    // ---- keyboard (digital)
    const kLeft = this.held('steerLeft');
    const kRight = this.held('steerRight');
    const kThr = this.held('throttle');
    const kBrk = this.held('brake');
    const kHb = this.held('handbrake');
    r.device = 'keyboard';
    r.steerDigital = r.throttleDigital = r.brakeDigital = r.handbrakeDigital = true;
    r.left = kLeft;
    r.right = kRight;
    r.throttle = kThr ? 1 : 0;
    r.brake = kBrk ? 1 : 0;
    r.handbrake = kHb ? 1 : 0;
    r.gearUp = this.edge('gearUp');
    r.gearDown = this.edge('gearDown');
    r.reset = this.held('reset');
    r.cameraNext = this.edge('cameraNext');
    r.lookBack = this.held('lookBack');
    r.pause = this.edge('pause');
    this.pressed.clear();

    // ---- gamepad (standard mapping)
    const p = this.pad();
    if (p) {
      const B = GAMEPAD_BINDINGS;
      const btn = (i: number) => p.buttons[i];
      const val = (i: number) => {
        const b = btn(i);
        return b ? (typeof b.value === 'number' && b.value > 0 ? b.value : b.pressed ? 1 : 0) : 0;
      };
      const isDown = (i: number) => {
        const b = btn(i);
        return !!b && (b.pressed || b.value > 0.5);
      };
      const edge = (i: number) => {
        const now = isDown(i);
        const was = this.padPrev[i] === true;
        this.padPrev[i] = now;
        return now && !was;
      };
      const stick = p.axes.length > B.steerAxis ? p.axes[B.steerAxis] : 0;
      const thr = val(B.throttle);
      const brk = val(B.brake);
      const dLeft = isDown(B.steerLeft);
      const dRight = isDown(B.steerRight);
      if (Math.abs(stick) > PAD_ACTIVITY || thr > PAD_ACTIVITY || brk > PAD_ACTIVITY || p.buttons.some((b) => b?.pressed)) {
        this.activeDevice = 'gamepad';
      }
      // steering: keys > d-pad > stick
      if (!kLeft && !kRight) {
        if (dLeft || dRight) {
          r.left = dLeft;
          r.right = dRight;
        } else if (this.activeDevice === 'gamepad' || Math.abs(stick) > 0.05) {
          r.steerDigital = false;
          r.steer = Math.max(-1, Math.min(1, stick || 0));
          r.device = 'gamepad';
        }
      }
      if (!kThr && thr > 0) {
        r.throttleDigital = false;
        r.throttle = Math.min(1, thr);
      }
      if (!kBrk && brk > 0) {
        r.brakeDigital = false;
        r.brake = Math.min(1, brk);
      }
      if (!kHb && isDown(B.handbrake)) r.handbrake = 1;
      r.lookBack = r.lookBack || isDown(B.lookBack);
      r.reset = r.reset || isDown(B.reset);
      r.gearUp = edge(B.gearUp) || r.gearUp;
      r.gearDown = edge(B.gearDown) || r.gearDown;
      r.cameraNext = edge(B.cameraNext) || r.cameraNext;
      r.pause = edge(B.pause) || r.pause;
      if (this.activeDevice === 'gamepad' && !r.steerDigital) r.device = 'gamepad';
    }

    // ---- touch (on-screen pedals / buttons as keys, analog steering)
    const t = this.touch?.read();
    if (t) {
      if (t.steer !== null && !kLeft && !kRight) {
        r.steerDigital = false;
        r.steer = Math.max(-1, Math.min(1, t.steer));
        r.device = 'touch';
        this.activeDevice = 'touch';
      }
      if (t.throttle && !kThr) {
        r.throttleDigital = true;
        r.throttle = 1;
      }
      if (t.brake && !kBrk) {
        r.brakeDigital = true;
        r.brake = 1;
      }
      if (t.handbrake && !kHb) {
        r.handbrakeDigital = true;
        r.handbrake = 1;
      }
      r.reset = r.reset || t.reset;
      r.lookBack = r.lookBack || t.lookBack;
      r.gearUp = r.gearUp || t.gearUp;
      r.gearDown = r.gearDown || t.gearDown;
      r.cameraNext = r.cameraNext || t.cameraNext;
      r.pause = r.pause || t.pause;
    }
    return r;
  }

  /** Release everything (e.g. when a menu takes over). */
  clear(): void {
    this.down.clear();
    this.pressed.clear();
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown as (e: never) => void);
    this.target.removeEventListener('keyup', this.onKeyUp as (e: never) => void);
    this.target.removeEventListener('blur', this.onBlur as (e: never) => void);
  }
}
