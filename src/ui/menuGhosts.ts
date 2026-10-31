/**
 * src/ui/menuGhosts.ts — OWNED BY THE GHOSTS BUILDER (phase 2, docs/PHASE2_AI.md). Menu content for ghosts:
 *  - `ghostMenuRows`: the "Ghost" row (Off / Best run / the stage's team ghosts / the player's saved ghosts; writes
 *    env.sel.ghost; the lists come from env.host.listGhosts and fill in asynchronously, then env.rerender()). The Delete key
 *    on a saved ghost asks for confirmation (the original's "Press the DELETE key to remove the highlighted ghost file").
 *  - `ghostResultButtons`: SAVE GHOST on the results screen (the session best of this stage + car) with the name dialog:
 *    the original's wording (LocaleEnglish 413/414/572/612/614/615/636/882), invalid name, overwrite confirm, not-enough-space.
 *  - `ghostKey` / `ghostDialogOpen`: the two hooks menu.ts calls (key dispatch while the dialog is up; Delete on the row).
 * The dialog is a small self-contained overlay (own DOM, own key handling), not a menu.ts Screen, so menu.ts only gains
 * those hook lines. `?ghost=0` disables the row. Specs: research/formats/ghosts.md §4, §7; docs/orig/ghosts.md.
 */
import { urlParam } from '../core/assets';
import type { GhostListEntry, GhostSelection } from '../core/ghosts';
import { GHOST_TEXT, checkGhostName } from '../game/ghosts/names';
import { sharedUserGhostStore } from '../game/ghosts/store';
import { teamFileOfId, warmTeamGhost } from '../game/ghosts/team';
import type { MenuButton, MenuChoice, MenuExtraEnv, MenuRow } from './menuExtras';
import { escapeHtml, formatTime, readBestTime } from './settings';

const LAST_NAME_KEY = 'rally-web:ghost:lastname'; // the original remembers the last name (registry `saveGhostName`)

const ghostsOff = (): boolean => /^(0|false|no|off)$/i.test(urlParam('ghost') ?? '');

// ------------------------------------------------------------------------------------------------- the Ghost row

/** The row's data: the selectable ghosts of the selection's stage (filled by env.host.listGhosts). */
export interface GhostRowModel {
  /** `<stage id>#<revision>` of the loaded list. */
  stageId: string | null;
  entries: GhostListEntry[];
  loading: boolean;
}

/** Row index of a selection: 0 Off, 1 Best run, 2.. the entries (unknown ids fall back to Best run). */
export function ghostRowIndex(sel: GhostSelection | undefined, entries: readonly GhostListEntry[]): number {
  if (!sel || sel.source === 'best') return 1;
  if (sel.source === 'off') return 0;
  const i = entries.findIndex((e) => e.id === sel.id && e.source === sel.source);
  return i < 0 ? 1 : 2 + i;
}

/** The selection a row index stands for. */
export function ghostSelectionAt(i: number, entries: readonly GhostListEntry[]): GhostSelection {
  if (i <= 0) return { source: 'off' };
  if (i === 1) return { source: 'best' };
  const e = entries[i - 2];
  return e ? { source: e.source, id: e.id } : { source: 'best' };
}

const SOURCE_LABEL = { team: 'Team', user: 'Saved' } as const;

export function ghostMenuRows(env: MenuExtraEnv): MenuRow[] {
  const model: GhostRowModel = { stageId: null, entries: [], loading: false };
  const carName = (id: string): string => env.host.listCars?.().find((c) => c.id === id)?.name ?? id;

  /** (Re)load the list when the selection's stage changed. */
  const sync = (): void => {
    const id = env.sel.stageId;
    const key = `${id}#${listRevision}`;
    if (key === model.stageId) return;
    model.stageId = key;
    model.entries = [];
    model.loading = true;
    const list = env.host.listGhosts?.(id);
    if (!list) {
      model.loading = false;
      return;
    }
    void list.then(
      (entries) => {
        if (model.stageId !== key) return;
        model.entries = entries;
        model.loading = false;
        const sel = env.sel.ghost;
        if (sel && (sel.source === 'team' || sel.source === 'user') && !entries.some((e) => e.id === sel.id)) env.sel.ghost = { source: 'best' };
        const g = env.sel.ghost;
        const f = g?.source === 'team' ? teamFileOfId(g.id) : null;
        if (f) warmTeamGhost(f);
        env.rerender();
      },
      () => {
        if (model.stageId === key) model.loading = false;
      },
    );
  };

  const currentEntry = (): GhostListEntry | null => {
    const g = env.sel.ghost;
    return g && (g.source === 'team' || g.source === 'user') ? (model.entries.find((e) => e.id === g.id) ?? null) : null;
  };

  const choices = (): MenuChoice[] => {
    sync();
    const best = readBestTime(env.sel.stageId, env.sel.seed, env.sel.car ?? env.sel.archetype);
    return [
      { label: 'Off' },
      { label: 'Best run', ...(best !== null ? { sub: formatTime(best) } : {}) },
      ...model.entries.map((e) => ({ label: e.name, sub: `${carName(e.origCar)} ${formatTime(e.time)}` })),
    ];
  };

  return [
    {
      id: 'ghost',
      label: 'Ghost',
      choices,
      get: () => (ghostsOff() ? 0 : ghostRowIndex(env.sel.ghost, (sync(), model.entries))),
      set: (i) => {
        const sel = ghostSelectionAt(i, model.entries);
        env.sel.ghost = sel;
        const f = sel.source === 'team' ? teamFileOfId(sel.id) : null;
        if (f) warmTeamGhost(f); // fetch the file while the menu is still up
      },
      enabled: () => !ghostsOff(),
      info: () => {
        sync();
        if (ghostsOff()) return 'Ghost cars are switched off (<b>?ghost=0</b>).';
        const e = currentEntry();
        const sel = env.sel.ghost;
        if (e) {
          const del = e.deletable ? ' <kbd>Delete</kbd> removes this saved ghost.' : '';
          const when = e.date ? ` · saved ${new Date(e.date).toLocaleDateString()}` : '';
          return `<b>${escapeHtml(e.name)}</b> ${SOURCE_LABEL[e.source].toLowerCase()} ghost · <b>${escapeHtml(carName(e.origCar))}</b> · ${formatTime(e.time)}${when}. You race it with its own car.${del}`;
        }
        if (sel?.source === 'off') return 'No ghost car.';
        const n = model.entries.length;
        const base = 'Your best run on this stage and car, replayed as a translucent ghost.';
        if (model.loading) return base;
        return n > 0
          ? `${base} ${n} team / saved ghost${n > 1 ? 's' : ''} for this stage: <b>←</b> <b>→</b> to pick one.`
          : `${base} ${escapeHtml(GHOST_TEXT.none)}.`;
      },
    },
  ];
}

// ------------------------------------------------------------------------------------------------- SAVE GHOST

export function ghostResultButtons(env: MenuExtraEnv): MenuButton[] {
  if (ghostsOff() || !env.host.saveSessionGhost || !env.host.canSaveGhost?.()) return [];
  return [{ id: 'saveghost', label: 'Save ghost', run: () => openSaveDialog(env) }];
}

// ------------------------------------------------------------------------------------------------- the dialog

type DialogKind = 'name' | 'overwrite' | 'delete' | 'message';

interface DialogButton {
  label: string;
  primary?: boolean;
  run(): void;
}

interface DialogState {
  kind: DialogKind;
  title: string;
  /** Lines of body text (plain text, escaped on render). */
  lines: string[];
  sub?: string;
  input: boolean;
  value: string;
  error: string;
  buttons: DialogButton[];
  focus: number;
}

/** Bumped when the saved list changed (a save or a delete) so the Ghost row re-lists on its next render. */
let listRevision = 0;
let host: HTMLDivElement | null = null;
let state: DialogState | null = null;
let styled = false;

const CSS = `
.rw-ghostdlg { z-index: 7; }
.rw-ghostdlg .rw-card { width: min(440px, calc(100vw - 32px)); }
.rw-ghostdlg h2 { font-size: 32px; }
.rw-ghostdlg .rw-gd-text { margin: 4px 0 12px; font-size: 16px; line-height: 1.45; white-space: pre-line; color: #dfe5ec; }
.rw-ghostdlg .rw-gd-text b { color: var(--rw-text); }
.rw-ghostdlg .rw-gd-label { margin: 0 0 6px; }
.rw-ghostdlg .rw-gd-input { box-sizing: border-box; width: 100%; padding: 10px 12px; font: 600 20px/1.2 var(--rw-font); letter-spacing: .04em; color: var(--rw-text); background: rgba(255,255,255,.07); border: 2px solid var(--rw-line); outline: none; }
.rw-ghostdlg .rw-gd-input:focus { border-color: var(--rw-amber); }
.rw-ghostdlg .rw-gd-error { min-height: 20px; margin: 6px 0 10px; font-size: 14px; color: var(--rw-red); }
`;

function ensureStyle(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);
}

export function ghostDialogOpen(): boolean {
  return state !== null;
}

function close(): void {
  state = null;
  host?.remove();
  host = null;
}

function render(): void {
  const s = state;
  if (!s || typeof document === 'undefined') return;
  ensureStyle();
  if (!host) {
    host = document.createElement('div');
    host.className = 'rw-menu rw-open rw-center rw-ghostdlg';
    host.addEventListener('click', onClick);
    (document.getElementById('overlay-root') ?? document.body).appendChild(host);
  }
  const prevInput = host.querySelector('input') as HTMLInputElement | null;
  if (prevInput && s.input) s.value = prevInput.value;
  const btns = s.buttons
    .map((b, i) => `<button class="rw-btn${b.primary ? ' rw-primary' : ''}${!s.input && i === s.focus ? ' rw-focus' : ''}" data-gd="${i}" tabindex="-1">${escapeHtml(b.label)}</button>`)
    .join('');
  host.innerHTML =
    `<div class="rw-shade"></div><div class="rw-card rw-plate" role="dialog" aria-label="${escapeHtml(s.title)}">` +
    `<h2>${escapeHtml(s.title)}</h2>${s.sub ? `<div class="rw-cardsub">${escapeHtml(s.sub)}</div>` : ''}` +
    (s.lines.length ? `<div class="rw-gd-text">${s.lines.map(escapeHtml).join('\n')}</div>` : '') +
    (s.input ? `<div class="rw-label rw-gd-label">${escapeHtml(GHOST_TEXT.name)}</div><input class="rw-gd-input" type="text" maxlength="40" spellcheck="false" autocomplete="off" value="${escapeHtml(s.value)}">` : '') +
    `<div class="rw-gd-error">${escapeHtml(s.error)}</div>` +
    `<div class="rw-row-actions">${btns}</div>` +
    `<div class="rw-foot">${s.input ? '<kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel' : '<kbd>←</kbd><kbd>→</kbd> choose · <kbd>Enter</kbd> select · <kbd>Esc</kbd> cancel'}</div></div>`;
  const input = host.querySelector('input') as HTMLInputElement | null;
  if (input) {
    input.addEventListener('keydown', onInputKey);
    input.addEventListener('input', () => {
      if (state) {
        state.value = input.value;
        state.error = '';
        const err = host?.querySelector('.rw-gd-error');
        if (err) err.textContent = '';
      }
    });
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function onClick(e: MouseEvent): void {
  const b = (e.target as HTMLElement).closest('[data-gd]') as HTMLElement | null;
  if (!b || !state) return;
  state.buttons[Number(b.dataset.gd)]?.run();
}

function onInputKey(e: KeyboardEvent): void {
  e.stopPropagation();
  if (e.key === 'Enter') {
    e.preventDefault();
    state?.buttons[0]?.run();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

/**
 * menu.ts hook (key dispatch). While the dialog is up every key belongs to it (true = consumed); otherwise the Delete key
 * on the Ghost row of the main menu asks to delete the highlighted saved ghost.
 */
export function ghostKey(e: KeyboardEvent, focusedRowId: string, env: MenuExtraEnv): boolean {
  const s = state;
  if (s) {
    if (e.repeat && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return true;
    switch (e.code) {
      case 'Escape':
        close();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'KeyA':
        s.focus = (s.focus + s.buttons.length - 1) % s.buttons.length;
        render();
        break;
      case 'ArrowRight':
      case 'ArrowDown':
      case 'KeyD':
      case 'Tab':
        s.focus = (s.focus + 1) % s.buttons.length;
        render();
        break;
      case 'Enter':
      case 'Space':
        s.buttons[s.focus]?.run();
        break;
      default:
    }
    return true;
  }
  if (e.code === 'Delete' && focusedRowId === 'ghost' && !e.repeat) {
    const g = env.sel.ghost;
    if (g?.source === 'user') {
      void confirmDelete(env, g.id);
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------------------------------------- dialog flows

function lastName(): string {
  try {
    return localStorage.getItem(LAST_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
function rememberName(n: string): void {
  try {
    localStorage.setItem(LAST_NAME_KEY, n);
  } catch {
    /* private window */
  }
}

function message(title: string, lines: string[], then?: () => void): void {
  state = {
    kind: 'message',
    title,
    lines,
    input: false,
    value: '',
    error: '',
    focus: 0,
    buttons: [
      {
        label: 'OK',
        primary: true,
        run: () => {
          close();
          then?.();
        },
      },
    ],
  };
  render();
}

function openSaveDialog(env: MenuExtraEnv): void {
  const sel = env.host.getSelection();
  const carKey = sel.car ?? sel.archetype;
  const stage = env.stageEntry()?.name ?? sel.stageId;
  const submit = async (overwrite: boolean): Promise<void> => {
    const s = state;
    if (!s) return;
    const chk = checkGhostName(s.value);
    if (!chk.ok) {
      s.error = GHOST_TEXT.invalid;
      render();
      return;
    }
    if (!overwrite) {
      let existing: GhostListEntry[] = [];
      try {
        existing = (await env.host.listGhosts?.(sel.stageId)) ?? [];
      } catch {
        /* no list: nothing to overwrite */
      }
      if (existing.some((e) => e.source === 'user' && e.origCar === carKey && e.name.toLowerCase() === chk.key)) {
        state = {
          kind: 'overwrite',
          title: GHOST_TEXT.save,
          lines: GHOST_TEXT.exists.split('\n'),
          sub: chk.name,
          input: false,
          value: chk.name,
          error: '',
          focus: 1,
          buttons: [
            { label: 'Overwrite', run: () => void doSave(chk.name) },
            { label: 'Cancel', primary: true, run: () => openName(chk.name) },
          ],
        };
        render();
        return;
      }
    }
    await doSave(chk.name);
  };
  const doSave = async (name: string): Promise<void> => {
    state = { kind: 'message', title: GHOST_TEXT.save, lines: [GHOST_TEXT.saving], input: false, value: name, error: '', focus: 0, buttons: [] };
    render();
    let ok = false;
    try {
      ok = (await env.host.saveSessionGhost?.(name)) === true;
    } catch {
      ok = false;
    }
    if (ok) {
      rememberName(name);
      listRevision++;
      // storage that could not be opened keeps the ghost in memory: say so instead of promising it survives a reload
      const volatile = sharedUserGhostStore().degraded;
      message(GHOST_TEXT.save, [`Ghost saved: ${name}`, ...(volatile ? ['(browser storage is unavailable: kept until you close this page)'] : [])], () => env.rerender());
    } else message(GHOST_TEXT.save, GHOST_TEXT.noSpace.split('\n'));
  };
  const openName = (value: string): void => {
    state = {
      kind: 'name',
      title: GHOST_TEXT.save,
      sub: `${stage} · ${carKey}`,
      lines: [GHOST_TEXT.enterName],
      input: true,
      value,
      error: '',
      focus: 0,
      buttons: [
        { label: 'Save', primary: true, run: () => void submit(false) },
        { label: 'Cancel', run: close },
      ],
    };
    render();
  };
  openName(lastName());
}

async function confirmDelete(env: MenuExtraEnv, id: string): Promise<void> {
  let name = id;
  try {
    const list = (await env.host.listGhosts?.(env.sel.stageId)) ?? [];
    name = list.find((e) => e.id === id)?.name ?? id;
  } catch {
    /* use the id */
  }
  state = {
    kind: 'delete',
    title: 'Delete ghost',
    lines: [...GHOST_TEXT.deleteConfirm.split('\n'), name],
    input: false,
    value: '',
    error: '',
    focus: 1,
    buttons: [
      {
        label: 'Delete',
        run: () => {
          close();
          void (async () => {
            await env.host.deleteGhost?.(id);
            if (env.sel.ghost?.source === 'user' && env.sel.ghost.id === id) env.sel.ghost = { source: 'best' };
            listRevision++; // the Ghost row re-lists on its next render
            env.rerender();
          })();
        },
      },
      { label: 'Cancel', primary: true, run: close },
    ],
  };
  render();
}
