/**
 * src/input/bindings.ts — game builder. Default device bindings (KeyboardEvent.code / standard gamepad).
 *
 * Keyboard (rally-web defaults; the §5.1 originals — arrows, Space, Z gear down, C, P — are all kept;
 * A is steering here, so gear up moved to E/Shift and look back to V):
 *   throttle Up / W · brake (and reverse when stopped, auto box) Down / S · steer Left/Right, A/D
 *   handbrake Space · gear up E / Shift · gear down Q / Z · camera C · look back V (hold)
 *   Ctrl is deliberately unbound: Ctrl+W / Ctrl+T / Ctrl+N are reserved by the browser (W is the throttle), so a
 *   held Ctrl gear-down key would close the tab mid-stage. Key presses with Ctrl/Meta held are ignored.
 *   reset to road R · pause P
 * UI keys handled by the UI modules themselves (UI_BINDINGS): Esc pause menu, Backspace restart,
 *   F1 or ` tuning panel, F2 / F4 / O telemetry overlay, H help, '.' single step, '[' ']' time scale,
 *   F8 autopilot, N co-driver voice.
 *
 * Gamepad (standard mapping): left stick steer (d-pad left/right too), RT throttle, LT brake,
 *   A handbrake, X look back, LB gear down, RB gear up, Y camera, B reset, Start pause.
 */

export const GAME_KEYS = Object.freeze({
  steerLeft: ['ArrowLeft', 'KeyA'],
  steerRight: ['ArrowRight', 'KeyD'],
  throttle: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  handbrake: ['Space'],
  gearUp: ['KeyE', 'ShiftLeft', 'ShiftRight'],
  gearDown: ['KeyQ', 'KeyZ'],
  reset: ['KeyR'],
  cameraNext: ['KeyC'],
  lookBack: ['KeyV'],
  pause: ['KeyP'],
} as const);

export type GameAction = keyof typeof GAME_KEYS;

/** Keys the UI modules react to (documentation + help overlay; each module listens itself). */
export const UI_BINDINGS = Object.freeze({
  menu: ['Escape'],
  restart: ['Backspace'],
  tuning: ['F1', 'Backquote'],
  overlay: ['F2', 'F4', 'KeyO'],
  help: ['KeyH'],
  step: ['Period'],
  slower: ['BracketLeft'],
  faster: ['BracketRight'],
  autopilot: ['F8'],
  voice: ['KeyN'],
} as const);

/** Standard-mapping gamepad button indices. */
export const PAD = Object.freeze({
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
});

export const GAMEPAD_BINDINGS = Object.freeze({
  steerAxis: 0,
  throttle: PAD.RT,
  brake: PAD.LT,
  handbrake: PAD.A,
  lookBack: PAD.X,
  gearDown: PAD.LB,
  gearUp: PAD.RB,
  cameraNext: PAD.Y,
  reset: PAD.B,
  pause: PAD.START,
  steerLeft: PAD.LEFT,
  steerRight: PAD.RIGHT,
});

/** True when a key event comes from a text field (typing in the tuning panel must not drive the car). */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type ?? 'text').toLowerCase();
    return type !== 'checkbox' && type !== 'button' && type !== 'range' && type !== 'radio';
  }
  return el.isContentEditable === true;
}

/** Human-readable label of a KeyboardEvent.code. */
export function keyLabel(code: string): string {
  const map: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
    ControlLeft: 'Ctrl',
    ControlRight: 'Ctrl',
    Escape: 'Esc',
    Backspace: 'Backspace',
    Backquote: '`',
    Period: '.',
    BracketLeft: '[',
    BracketRight: ']',
    Enter: 'Enter',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}
