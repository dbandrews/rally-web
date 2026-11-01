/**
 * src/ui/hudAi.ts — OWNED BY THE AI-RACE BUILDER (phase 2, docs/PHASE2_AI.md). In-race HUD for opponents: the player's
 * race position (e.g. "2 / 4"), a standings strip, opponent markers on the progress bar — all from
 * FrameContext.field (FieldSnapshot). Mounted by hud.ts (`new AiHud(wrap)` in the constructor, `update(ctx)` from
 * Hud.update every frame). DOM + CSS only, nothing when ctx.field has no opponents. It hides with the rest of the HUD
 * (it is a child of the HUD wrap). The same module renders the standings table shared with the results screen
 * (menuAi.ts) and keeps that table live while the AI cars are still racing after the player's finish.
 */
import type { FieldSnapshot, StandingEntry } from '../core/field';
import type { FrameContext } from '../core/types';
import { prettyCarName } from '../game/ai/roster';
import { escapeHtml, formatTime } from './settings';

const CSS = /* css */ `
.rw-ai { position: absolute; left: 18px; top: 84px; width: min(380px, 40vw); display: flex; flex-direction: column; gap: 6px; }
.rw-ai-pos { display: flex; align-items: baseline; gap: 10px; padding: 4px 14px 6px 12px; align-self: flex-start; }
.rw-ai-pos b { font-size: 40px; font-weight: 800; line-height: 1; letter-spacing: .02em; }
.rw-ai-pos b small { font-size: 20px; color: var(--rw-dim); font-weight: 700; margin-left: 2px; }
.rw-ai-strip { padding: 5px 12px 6px 10px; display: flex; flex-direction: column; gap: 1px; font-size: 14px; }
.rw-ai-row { display: grid; grid-template-columns: 18px 12px 1fr auto; align-items: center; gap: 7px; line-height: 1.35; }
.rw-ai-row .rw-n { color: var(--rw-dim); font-weight: 700; text-align: right; }
.rw-ai-row .rw-c { width: 8px; height: 8px; border-radius: 50%; background: var(--rw-dim); }
.rw-ai-row .rw-nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: .03em; }
.rw-ai-row .rw-g { color: var(--rw-dim); font-size: 13px; }
.rw-ai-row.rw-you { color: var(--rw-amber); font-weight: 700; }
.rw-ai-row.rw-you .rw-g { color: var(--rw-amber); }
.rw-ai-dot { position: absolute; top: -1px; width: 8px; height: 12px; margin-left: -4px; border-radius: 2px; box-shadow: 0 0 5px rgba(0,0,0,.7); }
.rw-ai-dot.rw-fin { opacity: .45; }
.rw-ai-table { width: 100%; border-collapse: collapse; font-size: 15px; margin: 4px 0 2px; }
.rw-ai-table td { padding: 3px 6px; white-space: nowrap; }
.rw-ai-table td:nth-child(1) { width: 26px; color: var(--rw-dim); font-weight: 700; text-align: right; }
.rw-ai-table td:nth-child(2) { width: 100%; overflow: hidden; text-overflow: ellipsis; max-width: 0; }
.rw-ai-table td:nth-child(3) { text-align: right; font-variant-numeric: tabular-nums; }
.rw-ai-table small { color: var(--rw-dim); margin-left: 6px; font-size: 12px; letter-spacing: .06em; }
.rw-ai-table tr.rw-you td { color: var(--rw-amber); font-weight: 700; }
.rw-ai-table tr.rw-th td { color: var(--rw-dim); font-size: 11px; letter-spacing: .16em; text-transform: uppercase; font-weight: 600; }
.rw-ai-table .rw-dnf { color: var(--rw-red); }
.rw-ai-table .rw-run { color: var(--rw-dim); }
.rw-ai-title { margin-top: 10px; }
@media (max-width: 520px) {
  .rw-ai { top: 164px; left: auto; right: 18px; width: min(300px, calc(100vw - 36px)); align-items: flex-end; }
  .rw-hud.rw-closed .rw-ai { top: 192px; }
}
`;

let injected = false;
/** The opponent HUD / results styles, injected once (the CSS variables come from styles.ts). */
export function injectAiStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const el = document.createElement('style');
  el.id = 'rw-ai-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** Marker / list colours of the AI cars by grid index (1..3); the player is white / amber. */
export const AI_COLORS = ['#59c6ff', '#ff6b5e', '#34d27f'] as const;
export const aiColor = (id: string): string => AI_COLORS[(Math.max(1, Number(id.replace(/\D/g, '')) || 1) - 1) % AI_COLORS.length];

/** What a standings row says about a car, from the snapshot. */
function resultText(e: StandingEntry, leader: StandingEntry | undefined, dnf: boolean, me: StandingEntry | undefined): { text: string; cls: string } {
  if (e.finished && e.finishTime !== null) {
    if (e === leader || e.gapToLeader === null) return { text: formatTime(e.finishTime), cls: '' };
    return { text: `+${e.gapToLeader.toFixed(3)}`, cls: '' };
  }
  if (dnf) return { text: 'DNF', cls: 'rw-dnf' };
  // still on the road after the player's finish: how far back, in metres
  const back = me && me.finished ? Math.round(me.distance - e.distance) : null;
  return { text: back !== null && back > 0 ? `racing · ${back} m back` : `lap ${e.lap}`, cls: 'rw-run' };
}

/** The standings table (results screen and its live refresh). Empty string when there is no field. */
export function standingsTableHtml(field: Readonly<FieldSnapshot> | undefined): string {
  if (!field || field.opponents <= 0 || field.standings.length < 2) return '';
  const dnfOf = new Map(field.cars.map((c) => [c.id, (c.dnf ?? c.ai?.dnf) === true]));
  const leader = field.standings[0];
  const me = field.standings.find((e) => e.player);
  const rows = field.standings
    .map((e) => {
      const r = resultText(e, leader, dnfOf.get(e.id) === true, me);
      const car = e.origCar ? prettyCarName(e.origCar) : '';
      const name = e.player ? `You${car ? `<small>${escapeHtml(car)}</small>` : ''}` : escapeHtml(e.name);
      return `<tr class="${e.player ? 'rw-you' : ''}"><td>${e.position}</td><td>${name}</td><td class="${r.cls}">${escapeHtml(r.text)}</td></tr>`;
    })
    .join('');
  return `<tr class="rw-th"><td></td><td>Driver</td><td>Result</td></tr>${rows}`;
}

export class AiHud {
  private readonly root: HTMLElement;
  private readonly pos: HTMLElement;
  private readonly strip: HTMLElement;
  private bar: HTMLElement | null = null;
  /** Progress-bar dots with the style / class last written (written only when they change). */
  private readonly dots = new Map<string, { el: HTMLElement; left: string; fin: boolean }>();
  /** The results screen's live standings table, while it is in the document. */
  private table: Element | null = null;
  private posKey = '';
  private stripKey = '';
  private tableKey = '';
  private shown = false;

  constructor(wrap: HTMLElement) {
    injectAiStyles();
    this.root = document.createElement('div');
    this.root.className = 'rw-ai';
    this.root.style.display = 'none';
    this.pos = document.createElement('div');
    this.pos.className = 'rw-ai-pos rw-plate';
    this.strip = document.createElement('div');
    this.strip.className = 'rw-ai-strip rw-plate';
    this.root.append(this.pos, this.strip);
    wrap.appendChild(this.root);
  }

  update(ctx: Readonly<FrameContext>): void {
    const f = ctx.field;
    const on = !!f && f.opponents > 0 && f.standings.length > 1;
    if (on !== this.shown) {
      this.shown = on;
      this.root.style.display = on ? '' : 'none';
      if (!on) this.clearDots();
    }
    if (!on || !f) return;
    // position "n / N"
    const pk = `${f.playerPosition}/${f.fieldSize}`;
    if (pk !== this.posKey) {
      this.posKey = pk;
      this.pos.innerHTML = `<b>${f.playerPosition}<small>/${f.fieldSize}</small></b><span class="rw-label">Position</span>`;
    }
    // standings strip: position, colour, name, gap in metres to the player (ahead +, behind -) or the result
    const me = f.standings.find((e) => e.player);
    const dnfOf = new Map<string, boolean>();
    for (const c of f.cars) dnfOf.set(c.id, (c.dnf ?? c.ai?.dnf) === true);
    const rows: string[] = [];
    for (const e of f.standings) {
      let g: string;
      if (e.finished && e.finishTime !== null) g = formatTime(e.finishTime);
      else if (dnfOf.get(e.id)) g = 'DNF';
      else if (e.player || !me) g = `lap ${e.lap}`;
      else {
        const d = Math.round(e.distance - me.distance);
        g = `${d >= 0 ? '+' : '−'}${Math.abs(d)} m`;
      }
      rows.push(
        `<div class="rw-ai-row${e.player ? ' rw-you' : ''}"><span class="rw-n">${e.position}</span>` +
          `<span class="rw-c" style="background:${e.player ? 'var(--rw-amber)' : aiColor(e.id)}"></span>` +
          `<span class="rw-nm">${e.player ? 'You' : escapeHtml(e.name)}</span><span class="rw-g">${escapeHtml(g)}</span></div>`,
      );
    }
    const sk = rows.join('');
    if (sk !== this.stripKey) {
      this.stripKey = sk;
      this.strip.innerHTML = sk;
    }
    this.updateDots(f);
    this.refreshResults(f);
  }

  /** The opponents' positions along the progress bar (0..1 of the whole race). */
  private updateDots(f: Readonly<FieldSnapshot>): void {
    if (!this.bar || !this.bar.isConnected) this.bar = this.root.parentElement?.querySelector('.rw-bar') ?? null;
    const bar = this.bar;
    if (!bar) return;
    const live = new Set<string>();
    for (const c of f.cars) {
      live.add(c.id);
      let d = this.dots.get(c.id);
      if (!d) {
        const e = document.createElement('i');
        e.className = 'rw-ai-dot';
        e.style.background = aiColor(c.id);
        e.title = c.name;
        bar.appendChild(e);
        d = { el: e, left: '', fin: false };
        this.dots.set(c.id, d);
      }
      const p = c.progress ?? (typeof c.ai?.progress === 'number' ? c.ai.progress : 0);
      const left = `${(Math.min(1, Math.max(0, p)) * 100).toFixed(2)}%`;
      if (left !== d.left) {
        d.left = left;
        d.el.style.left = left;
      }
      if (c.finished !== d.fin) {
        d.fin = c.finished;
        d.el.classList.toggle('rw-fin', c.finished);
      }
    }
    for (const [id, d] of this.dots) {
      if (!live.has(id)) {
        d.el.remove();
        this.dots.delete(id);
      }
    }
  }

  private clearDots(): void {
    for (const d of this.dots.values()) d.el.remove();
    this.dots.clear();
  }

  /** The results screen's standings table (menuAi.aiResultsHtml) follows the field while AI cars are still racing. */
  private refreshResults(f: Readonly<FieldSnapshot>): void {
    if (!this.table?.isConnected) this.table = document.querySelector('.rw-ai-table[data-live]');
    const t = this.table;
    if (!t) {
      this.tableKey = '';
      return;
    }
    const html = standingsTableHtml(f);
    if (html !== this.tableKey) {
      this.tableKey = html;
      t.innerHTML = html;
    }
  }

  dispose(): void {
    this.clearDots();
    this.table = null;
    this.root.remove();
  }
}
