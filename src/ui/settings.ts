/**
 * src/ui/settings.ts — game builder. UI preferences shared by the HUD and the menus (persisted), plus a
 * tiny bus so the menu can raise HUD toasts.
 */

export interface UiSettings {
  /** Co-driver reads the pacenotes aloud: the original's co-driver samples when the sound bank is loaded, else
   *  speechSynthesis. On by default (the original always speaks the notes; N or the menu turns it off). */
  voice: boolean;
  /** Show the pacenote cards in the HUD. */
  pacenoteHud: boolean;
  /** Show the HUD at all. */
  hud: boolean;
  /** Touch screens: steer with the on-screen pad ('drag') or by tilting the device ('tilt'; src/input/touch.ts). */
  touchSteer: 'drag' | 'tilt';
}

const KEY = 'rally-web:ui:v2';
/** v1 stored the whole object, so its `voice` is the old default (off) unless the player toggled it: dropped. */
const KEY_V1 = 'rally-web:ui:v1';
const DEFAULTS: UiSettings = { voice: true, pacenoteHud: true, hud: true, touchSteer: 'drag' };

function load(): UiSettings {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<UiSettings>) };
    const v1 = globalThis.localStorage?.getItem(KEY_V1);
    if (v1) {
      const { voice: _old, ...rest } = JSON.parse(v1) as Partial<UiSettings>;
      void _old;
      return { ...DEFAULTS, ...rest };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export const uiSettings: UiSettings = load();

type Listener = (s: Readonly<UiSettings>) => void;
const listeners = new Set<Listener>();

export function setUiSetting<K extends keyof UiSettings>(key: K, value: UiSettings[K]): void {
  uiSettings[key] = value;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(uiSettings));
  } catch {
    /* ignore */
  }
  for (const l of listeners) l(uiSettings);
}

export function onUiSettings(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ------------------------------------------------------------------------------------------- toasts

type ToastFn = (text: string) => void;
const toastListeners = new Set<ToastFn>();
export function toast(text: string): void {
  for (const l of toastListeners) l(text);
}
export function onToast(l: ToastFn): () => void {
  toastListeners.add(l);
  return () => toastListeners.delete(l);
}

// ------------------------------------------------------------------------------------------- helpers

/** True when a key event comes from a text field. */
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

/** "m:ss.mmm". */
export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return '-:--.---';
  const neg = t < 0;
  let ms = Math.round(Math.abs(t) * 1000);
  const m = Math.floor(ms / 60000);
  ms -= m * 60000;
  const s = Math.floor(ms / 1000);
  ms -= s * 1000;
  return `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** "+1.234" / "-0.456". */
export function formatDelta(d: number | null | undefined): string {
  if (d === null || d === undefined || !Number.isFinite(d)) return '';
  const ms = Math.round(d * 1000);
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '±';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}`;
}

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Best time stored by the race controller (src/game/bestTimes.ts key scheme — keep in sync). */
export function readBestTime(stageId: string, seed: number, archetype: string): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(`rally-web:best:v2:${stageId}:${seed}:${archetype}`);
    if (!raw) return null;
    const r = JSON.parse(raw) as { time?: number };
    return typeof r.time === 'number' && Number.isFinite(r.time) ? r.time : null;
  } catch {
    return null;
  }
}

/** Gamepad snapshot for menu navigation. */
export function firstPad(): Gamepad | null {
  try {
    const pads = globalThis.navigator?.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p;
  } catch {
    /* ignore */
  }
  return null;
}
