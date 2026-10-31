/**
 * src/ui/menuAi.ts — OWNED BY THE AI-RACE BUILDER (phase 2, docs/PHASE2_AI.md). Menu content for AI opponents:
 *  - `aiMenuRows`: the "Opponents" row (0..MAX_OPPONENTS, writes env.sel.opponents). DEFAULT 3: every original career
 *    event starts `OpponentCount = 3` on all disciplines [D] (research/formats/ai.md §6). It applies where the menu is the
 *    way into a race; `?ai=` in the URL and the test API / tools keep their own default of 0 (a solo race, as before) and
 *    an explicit `?ai=0` is respected (the selection then carries opponents 0).
 *  - `aiResultsHtml`: the standings table shown on the results screen under the splits (positions, drivers, cars,
 *    times / gaps), from FrameContext.field; it stays live while AI cars are still racing (hudAi.ts).
 * Called from menu.ts at the "PHASE 2 hook" lines.
 */
import { MAX_OPPONENTS } from '../core/field';
import type { FieldSnapshot } from '../core/field';
import { buildRosterInfo, eventsOfStage } from '../game/ai/roster';
import { injectAiStyles, standingsTableHtml } from './hudAi';
import type { MenuExtraEnv, MenuRow } from './menuExtras';
import { escapeHtml } from './settings';

/** What the Opponents row starts at when the selection does not say (the career events' OpponentCount). */
export const DEFAULT_OPPONENTS = 3;

const LABELS = ['None', '1 car', '2 cars', '3 cars'];

export function aiMenuRows(env: MenuExtraEnv): MenuRow[] {
  injectAiStyles();
  if (env.sel.opponents === undefined) env.sel.opponents = DEFAULT_OPPONENTS;
  /** Stages with a roster: the original stages (all lie in a career event). The procedural ones have no AI data. */
  const available = (): boolean => eventsOfStage(env.sel.stageId).length > 0;
  const carName = (id: string): string => env.host.listCars?.().find((c) => c.id === id)?.name ?? id;
  return [
    {
      id: 'opponents',
      label: 'Opponents',
      choices: () => Array.from({ length: MAX_OPPONENTS + 1 }, (_, i) => ({ label: LABELS[i] ?? `${i} cars` })),
      get: () => (available() ? Math.max(0, Math.min(MAX_OPPONENTS, Math.floor(env.sel.opponents ?? 0))) : 0),
      set: (i) => {
        env.sel.opponents = Math.max(0, Math.min(MAX_OPPONENTS, i));
      },
      enabled: () => available(),
      info: () => {
        if (!available()) return 'AI opponents race on the original stages (the procedural stages have no AI data).';
        const n = env.sel.opponents ?? 0;
        if (n <= 0) return 'A solo run against the clock. Your best time and ghost are the same either way.';
        const info = buildRosterInfo(env.sel, { id: env.sel.stageId }, carName);
        const list = info.specs.map((s) => `<b>${escapeHtml(s.name)}</b>`).join(', ');
        return `${n} AI car${n > 1 ? 's' : ''} start beside you on the grid${info.event ? ` (the ${escapeHtml(info.event.name)} class)` : ''}: ${list}. They drive the stage on their own and finish where they finish; the HUD shows your position.`;
      },
    },
  ];
}

export function aiResultsHtml(field: Readonly<FieldSnapshot> | undefined): string {
  const rows = standingsTableHtml(field);
  if (!rows) return '';
  return `<div class="rw-label rw-ai-title">Race result</div><table class="rw-ai-table" data-live>${rows}</table>`;
}
