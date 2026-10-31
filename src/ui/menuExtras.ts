/**
 * src/ui/menuExtras.ts — CONTRACT written by the architect (phase 2, docs/PHASE2_AI.md): the seam through which the
 * AI-race and ghosts builders add menu rows, result-screen content and buttons WITHOUT editing the middle of menu.ts.
 * Their code lives in src/ui/menuAi.ts (ai-race) and src/ui/menuGhosts.ts (ghosts); menu.ts only calls the functions
 * below at the marked hook lines (grep "PHASE 2 hook").
 */
import type { IMenuHost, RaceSelection, StageListEntry } from '../core/types';

export interface MenuChoice {
  label: string;
  sub?: string;
}

/** Same shape as menu.ts's OptRow (an option row of the main menu: ‹ value ›). */
export interface MenuRow {
  id: string;
  label: string;
  choices(): MenuChoice[];
  get(): number;
  set(i: number): void;
  enabled(): boolean;
  /** HTML shown in the info line under the rows while the row is focused. */
  info(): string;
}

/** Same shape as menu.ts's Button. */
export interface MenuButton {
  id: string;
  label: string;
  primary?: boolean;
  run(): void;
}

/** What the extra rows / buttons may use from the menu. */
export interface MenuExtraEnv {
  /** The menu's editable copy of the selection (rows write opponents / ghost here; Start passes it to the host). */
  sel: RaceSelection;
  host: IMenuHost;
  /** The catalogue entry of sel.stageId. */
  stageEntry(): StageListEntry | undefined;
  /** Re-render the screen (after an async list loaded or a value changed). */
  rerender(): void;
}
