/**
 * src/ui/help.ts — game builder. Controls overlay (H). Keep in sync with src/input/bindings.ts and src/ui/touch.ts.
 * Touch mode (body.rw-touch) shows the touch and gamepad sections; otherwise keyboard, gamepad, race and lab keys.
 */
import { injectUiStyles } from './styles';

const k = (...keys: string[]) => keys.map((x) => `<kbd>${x}</kbd>`).join(' ');

/** `only`: the section shows in touch mode only ('touch') or outside it ('keys'). */
const SECTIONS: { title: string; only?: 'touch' | 'keys'; rows: [string, string][] }[] = [
  {
    title: 'Driving — touch',
    only: 'touch',
    rows: [
      ['Steer', 'Left thumb down anywhere on the left half, slide sideways'],
      ['Throttle / brake', 'GAS / BRAKE pedals, bottom right'],
      ['Reverse (automatic)', 'Hold BRAKE at a standstill'],
      ['Hand brake', 'Above the brake pedal'],
      ['Gear up / down (manual)', '+ / − above the gas pedal'],
      ['Pause · camera · look back · reset', 'Buttons, top left'],
      ['Tilt steering', 'Menu → Touch steer'],
    ],
  },
  {
    title: 'Driving — keyboard',
    only: 'keys',
    rows: [
      ['Throttle', k('↑', 'W')],
      ['Brake / reverse (hold when stopped)', k('↓', 'S')],
      ['Steer', `${k('←', '→')} ${k('A', 'D')}`],
      ['Handbrake', k('Space')],
      ['Gear up / down (manual)', `${k('E', 'Shift')} / ${k('Q', 'Z')}`],
      ['Reset to road', k('R')],
      ['Change camera', k('C')],
      ['Look back (hold)', k('V')],
    ],
  },
  {
    title: 'Driving — gamepad',
    rows: [
      ['Steer', 'Left stick / d-pad'],
      ['Throttle / brake', 'RT / LT'],
      ['Handbrake', 'A'],
      ['Gear down / up', 'LB / RB'],
      ['Camera', 'Y'],
      ['Reset to road', 'B'],
      ['Look back', 'X'],
      ['Pause', 'Start'],
    ],
  },
  {
    title: 'Race',
    only: 'keys',
    rows: [
      ['Pause menu', `${k('Esc')} ${k('P')}`],
      ['Restart stage', k('Backspace')],
      ['Co-driver voice on/off', k('N')],
      ['Sound on/off', k('M')],
      ['This help', k('H')],
    ],
  },
  {
    title: 'Handling lab',
    only: 'keys',
    rows: [
      ['Tuning panel', `${k('F1')} ${k('`')}`],
      ['Telemetry overlay', `${k('F2')} ${k('O')}`],
      ['Freeze / single step', k('.')],
      ['Time scale slower / faster', `${k('[')} ${k(']')}`],
      ['Autopilot on/off', k('F8')],
    ],
  },
];

export class HelpOverlay {
  readonly el: HTMLDivElement;
  private shown = false;
  onClose: (() => void) | null = null;

  constructor(root: HTMLElement) {
    injectUiStyles();
    this.el = document.createElement('div');
    this.el.className = 'rw-help';
    this.el.innerHTML =
      `<div class="rw-helpcard rw-plate"><h2>Controls</h2><div class="rw-cols">` +
      SECTIONS.map(
        (s) =>
          `<div${s.only ? ` class="rw-only-${s.only}"` : ''}><h3>${s.title}</h3>${s.rows.map(([a, b]) => `<div class="rw-kv"><span>${a}</span><span>${b}</span></div>`).join('')}</div>`,
      ).join('') +
      `</div><p>Resets cost about a second plus 20 m, never a time penalty. Leave the road by more than 30 m and you are put back automatically. ` +
      `<span class="rw-only-keys">Press <kbd>H</kbd>, <kbd>Esc</kbd> or click to close.</span><span class="rw-only-touch">Tap to close.</span></p></div>`;
    this.el.addEventListener('click', () => this.hide());
    root.appendChild(this.el);
  }

  get visible(): boolean {
    return this.shown;
  }

  show(): void {
    this.shown = true;
    this.el.classList.add('rw-open');
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.el.classList.remove('rw-open');
    this.onClose?.();
  }

  toggle(): void {
    if (this.shown) this.hide();
    else this.show();
  }

  dispose(): void {
    this.el.remove();
  }
}
