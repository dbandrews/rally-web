import { describe, expect, it } from 'vitest';
import { GAME_KEYS, isTypingTarget } from '../../src/input/bindings';
import { InputManager, type InputTarget, type TouchInput } from '../../src/input/input';
import { neutralRawInput } from '../../src/core/constants';
import { InputFilter } from '../../src/sim/inputFilter';
import { padSteer, tiltRollDeg, touchAxis } from '../../src/ui/touch';

type Fn = (e: unknown) => void;

class FakeTarget implements InputTarget {
  readonly l = new Map<string, Fn[]>();
  addEventListener(type: string, fn: (e: never) => void): void {
    this.l.set(type, [...(this.l.get(type) ?? []), fn as Fn]);
  }
  removeEventListener(type: string, fn: (e: never) => void): void {
    this.l.set(type, (this.l.get(type) ?? []).filter((f) => f !== (fn as Fn)));
  }
  key(type: 'keydown' | 'keyup', code: string, target: unknown = null, repeat = false, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}): { prevented: boolean } {
    const ev = { code, target, repeat, ...mods, prevented: false, preventDefault() { this.prevented = true; } };
    for (const f of this.l.get(type) ?? []) f(ev);
    return ev;
  }
}

function pad(over: { axes?: number[]; buttons?: Record<number, number> } = {}): Gamepad {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const v = over.buttons?.[i] ?? 0;
    return { pressed: v > 0.5, touched: v > 0, value: v };
  });
  return { connected: true, index: 0, id: 'fake', mapping: 'standard', axes: over.axes ?? [0, 0, 0, 0], buttons, timestamp: 0 } as unknown as Gamepad;
}

describe('InputManager (keyboard)', () => {
  it('maps the default keys, ramps are left to the filter (digital flags)', () => {
    const t = new FakeTarget();
    const im = new InputManager(t);
    t.key('keydown', 'KeyW');
    t.key('keydown', 'KeyA');
    t.key('keydown', 'Space');
    const r = im.poll();
    expect(r.device).toBe('keyboard');
    expect(r.throttleDigital && r.steerDigital && r.brakeDigital && r.handbrakeDigital).toBe(true);
    expect(r.throttle).toBe(1);
    expect(r.left).toBe(true);
    expect(r.right).toBe(false);
    expect(r.handbrake).toBe(1);
    t.key('keyup', 'KeyW');
    expect(im.poll().throttle).toBe(0);
    for (const c of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyS', 'KeyD']) expect(t.key('keydown', c).prevented).toBe(true);
  });

  it('edges (gear, camera, pause) fire once per press, even when released before the poll', () => {
    const t = new FakeTarget();
    const im = new InputManager(t);
    t.key('keydown', 'KeyE');
    t.key('keyup', 'KeyE');
    t.key('keydown', 'KeyC');
    let r = im.poll();
    expect(r.gearUp).toBe(true);
    expect(r.cameraNext).toBe(true);
    r = im.poll();
    expect(r.gearUp).toBe(false);
    expect(r.cameraNext).toBe(false);
    // auto-repeat keydowns do not create new edges
    t.key('keydown', 'KeyC', null, true);
    expect(im.poll().cameraNext).toBe(false);
    t.key('keydown', 'KeyQ');
    expect(im.poll().gearDown).toBe(true);
    t.key('keydown', 'KeyP');
    expect(im.poll().pause).toBe(true);
  });

  it('reset (R) and look back (V) are levels', () => {
    const t = new FakeTarget();
    const im = new InputManager(t);
    t.key('keydown', 'KeyR');
    t.key('keydown', 'KeyV');
    expect(im.poll().reset).toBe(true);
    const r = im.poll();
    expect(r.reset).toBe(true);
    expect(r.lookBack).toBe(true);
  });

  it('ignores keys typed into text fields', () => {
    const t = new FakeTarget();
    const im = new InputManager(t);
    const input = { tagName: 'INPUT', type: 'text' };
    t.key('keydown', 'KeyW', input);
    expect(im.poll().throttle).toBe(0);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
  });

  it('Ctrl is not bound (Ctrl+W closes the tab) and Ctrl/Meta chords are left to the browser', () => {
    for (const codes of Object.values(GAME_KEYS)) for (const c of codes as readonly string[]) expect(c.startsWith('Control')).toBe(false);
    const t = new FakeTarget();
    const im = new InputManager(t);
    const ev = t.key('keydown', 'KeyW', null, false, { ctrlKey: true });
    expect(ev.prevented).toBe(false);
    expect(im.poll().throttle).toBe(0);
    t.key('keydown', 'KeyS', null, false, { metaKey: true });
    expect(im.poll().brake).toBe(0);
  });

  it('every bound action has at least one key and no key is bound twice', () => {
    const seen = new Set<string>();
    for (const codes of Object.values(GAME_KEYS)) {
      expect(codes.length).toBeGreaterThan(0);
      for (const c of codes) {
        expect(seen.has(c)).toBe(false);
        seen.add(c);
      }
    }
  });
});

describe('InputManager (gamepad, standard mapping)', () => {
  it('stick → analog steer, triggers → analog pedals, buttons → handbrake / gears / camera / reset / pause', () => {
    const t = new FakeTarget();
    let p = pad({ axes: [-0.5, 0, 0, 0], buttons: { 7: 0.8, 6: 0.3, 0: 1 } });
    const im = new InputManager(t, () => [p]);
    let r = im.poll();
    expect(im.activeDevice).toBe('gamepad');
    expect(r.device).toBe('gamepad');
    expect(r.steerDigital).toBe(false);
    expect(r.steer).toBeCloseTo(-0.5, 9);
    expect(r.throttleDigital).toBe(false);
    expect(r.throttle).toBeCloseTo(0.8, 9);
    expect(r.brakeDigital).toBe(false);
    expect(r.brake).toBeCloseTo(0.3, 9);
    expect(r.handbrake).toBe(1);
    p = pad({ buttons: { 5: 1, 3: 1, 1: 1, 9: 1 } });
    r = im.poll();
    expect(r.gearUp).toBe(true);
    expect(r.cameraNext).toBe(true);
    expect(r.reset).toBe(true);
    expect(r.pause).toBe(true);
    r = im.poll(); // still held: edges do not repeat, reset level stays
    expect(r.gearUp).toBe(false);
    expect(r.pause).toBe(false);
    expect(r.reset).toBe(true);
  });

  it('a held key wins over the pad for that channel', () => {
    const t = new FakeTarget();
    const im = new InputManager(t, () => [pad({ axes: [0.9, 0], buttons: { 7: 0.4 } })]);
    t.key('keydown', 'ArrowUp');
    t.key('keydown', 'ArrowLeft');
    const r = im.poll();
    expect(r.throttleDigital).toBe(true);
    expect(r.throttle).toBe(1);
    expect(r.steerDigital).toBe(true);
    expect(r.left).toBe(true);
  });
});

describe('InputManager (short taps)', () => {
  it('a level key tapped between two polls still reads as held for one poll', () => {
    const t = new FakeTarget();
    const im = new InputManager(t);
    t.key('keydown', 'KeyR');
    t.key('keyup', 'KeyR');
    t.key('keydown', 'Space');
    t.key('keyup', 'Space');
    const r = im.poll();
    expect(r.reset).toBe(true);
    expect(r.handbrake).toBe(1);
    const r2 = im.poll();
    expect(r2.reset).toBe(false);
    expect(r2.handbrake).toBe(0);
  });
});

describe('InputManager (touch controls)', () => {
  const touchRead = (over: Partial<TouchInput> = {}): TouchInput => ({
    steer: null,
    throttle: false,
    brake: false,
    handbrake: false,
    reset: false,
    lookBack: false,
    gearUp: false,
    gearDown: false,
    cameraNext: false,
    pause: false,
    ...over,
  });

  it('pedals are digital like keys, steering is the analog touch device; held keys win', () => {
    let next: TouchInput | null = touchRead({ steer: 0.5, throttle: true, handbrake: true, gearUp: true });
    const t = new FakeTarget();
    const im = new InputManager(t, () => [], { read: () => next });
    let r = im.poll();
    expect(r.device).toBe('touch');
    expect(r.steerDigital).toBe(false);
    expect(r.steer).toBe(0.5);
    expect(r.throttleDigital && r.handbrakeDigital).toBe(true);
    expect(r.throttle).toBe(1);
    expect(r.handbrake).toBe(1);
    expect(r.brake).toBe(0);
    expect(r.gearUp).toBe(true);
    expect(im.activeDevice).toBe('touch');
    t.key('keydown', 'KeyD');
    r = im.poll();
    expect(r.steerDigital).toBe(true);
    expect(r.right).toBe(true);
    next = null; // controls hidden
    t.key('keyup', 'KeyD');
    r = im.poll();
    expect(r.throttle).toBe(0);
    expect(r.steer).toBe(0);
  });
});

describe('touch steering math', () => {
  it('padSteer: offset from the floating centre; the centre follows past full lock', () => {
    expect(padSteer(100, 130, 60)).toEqual({ anchor: 100, d: 0.5 });
    expect(padSteer(100, 190, 60)).toEqual({ anchor: 130, d: 1 }); // pushed 30 px past full lock
    expect(padSteer(130, 160, 60)).toEqual({ anchor: 130, d: 0.5 }); // and half way back answers at once
    expect(padSteer(100, 20, 60)).toEqual({ anchor: 80, d: -1 });
  });

  it('touchAxis through the filter: dead zone, expo blend, full lock at the end, symmetric', () => {
    const f = new InputFilter();
    const steerOf = (d: number) => f.update({ ...neutralRawInput(), device: 'touch', steer: touchAxis(d, 0.03) }, 1 / 120).steer;
    expect(touchAxis(0.02, 0.03)).toBe(0);
    expect(steerOf(1)).toBeCloseTo(1, 3);
    expect(steerOf(-1)).toBeCloseTo(-1, 3);
    let prev = 0;
    for (let d = 0.05; d <= 1; d += 0.05) {
      const s = steerOf(d);
      expect(s).toBeGreaterThan(prev);
      expect(s).toBeLessThanOrEqual(d + 1e-9); // finer than linear near the centre
      expect(steerOf(-d)).toBeCloseTo(-s, 9);
      prev = s;
    }
    expect(steerOf(0.5)).toBeGreaterThan(0.3);
    expect(steerOf(0.5)).toBeLessThan(0.4);
  });

  it('tiltRollDeg: right side down is +, in portrait and both landscapes, upright or laid back', () => {
    // portrait, flat on the back, right edge 20° down
    expect(tiltRollDeg(0, 20, 0)).toBeCloseTo(20, 6);
    // landscape, turned counter-clockwise (top to the left): the screen's right side is the device bottom; that side
    // down = the top up = beta > 0 for a flat device
    expect(tiltRollDeg(15, 0, 90)).toBeCloseTo(15, 6);
    expect(tiltRollDeg(-15, 0, 90)).toBeCloseTo(-15, 6);
    // the other landscape (top to the right): the device top is the screen's right side
    expect(tiltRollDeg(-15, 0, 270)).toBeCloseTo(15, 6);
    // laid back 50° in landscape (CCW): roll survives the pitch (gamma carries the pitch here)
    expect(tiltRollDeg(0, -50, 90)).toBeCloseTo(0, 6);
    const b = 10;
    const g = -50;
    const roll = tiltRollDeg(b, g, 90);
    expect(roll).toBeGreaterThan(5);
    expect(roll).toBeLessThan(10.5);
  });
});
