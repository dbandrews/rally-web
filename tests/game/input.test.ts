import { describe, expect, it } from 'vitest';
import { GAME_KEYS, isTypingTarget } from '../../src/input/bindings';
import { InputManager, type InputTarget } from '../../src/input/input';

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
