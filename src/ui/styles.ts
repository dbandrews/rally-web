/**
 * src/ui/styles.ts — game builder. CSS for the HUD, menus and help overlay, injected once.
 * Visual language: stage-plate panels (chamfered dark plates, amber accent bar), condensed tabular numerals,
 * green/red split colours. Original design.
 */

const CSS = /* css */ `
:root {
  --rw-amber: #ffb81c;
  --rw-amber-dim: #b9840f;
  --rw-ink: #0b0f14;
  --rw-panel: rgba(9, 12, 17, 0.80);
  --rw-panel-solid: #0f141b;
  --rw-line: rgba(255, 255, 255, 0.13);
  --rw-text: #f3f5f7;
  --rw-dim: #98a3b0;
  --rw-green: #34d27f;
  --rw-red: #ff4b3e;
  --rw-blue: #59c6ff;
  --rw-font: 'Bahnschrift', 'DIN Alternate', 'Barlow Condensed', 'Roboto Condensed', 'Arial Narrow', system-ui, sans-serif;
  --rw-chamfer: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
}
.rw-hud, .rw-menu, .rw-help, .rw-toast-wrap {
  font-family: var(--rw-font);
  color: var(--rw-text);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
.rw-hud { position: absolute; inset: 0; pointer-events: none; }
.rw-hud.rw-hidden > *:not(.rw-fade):not(.rw-toast-wrap) { display: none !important; }
.rw-plate {
  background: var(--rw-panel);
  clip-path: var(--rw-chamfer);
  border-left: 3px solid var(--rw-amber);
}
.rw-label { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--rw-dim); font-weight: 600; }

/* ---- progress (top left) */
.rw-progress { position: absolute; left: 18px; top: 16px; width: min(380px, 40vw); padding: 8px 12px 10px; }
.rw-progress .rw-stage { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 7px; }
.rw-progress .rw-stage b { font-size: 15px; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rw-bar { position: relative; display: flex; gap: 3px; height: 10px; }
.rw-seg { position: relative; background: rgba(255,255,255,.10); overflow: hidden; }
.rw-seg > i { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--rw-amber); }
.rw-seg.rw-fast > i { background: var(--rw-green); }
.rw-seg.rw-slow > i { background: var(--rw-red); }
.rw-seg.rw-cur > i { background: rgba(255, 184, 28, .55); }
.rw-seg.rw-skip > i { background: rgba(255,255,255,.32); }
.rw-marker { position: absolute; top: -4px; width: 3px; height: 18px; background: #fff; box-shadow: 0 0 6px rgba(255,255,255,.7); transform: translateX(-1px); }

/* ---- clock (top right) */
.rw-clock { position: absolute; right: 18px; top: 16px; padding: 6px 16px 8px 14px; text-align: right; min-width: 200px; }
.rw-clock .rw-time { font-size: 40px; font-weight: 700; line-height: 1; letter-spacing: .02em; }
.rw-clock .rw-row { display: flex; justify-content: flex-end; gap: 12px; margin-top: 4px; font-size: 14px; color: var(--rw-dim); }
.rw-clock .rw-row b { color: var(--rw-text); font-weight: 600; }
.rw-split { margin-top: 6px; font-size: 22px; font-weight: 700; opacity: 0; transition: opacity .25s; }
.rw-split.rw-on { opacity: 1; }
.rw-fastc { color: var(--rw-green); }
.rw-slowc { color: var(--rw-red); }
.rw-lapbox { display: inline-block; margin-top: 6px; padding: 2px 8px; background: var(--rw-amber); color: var(--rw-ink); font-weight: 800; font-size: 15px; letter-spacing: .08em; }

/* ---- pacenotes (top centre) */
.rw-notes { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); display: flex; gap: 8px; align-items: flex-start; max-width: calc(100vw - 2 * min(420px, 41vw)); }
.rw-note { display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px 8px; min-width: 120px; transition: opacity .3s, transform .3s; }
.rw-note:not(:first-child) { opacity: .62; transform: scale(.86); transform-origin: top left; }
.rw-note.rw-passed { opacity: .28; }
.rw-note svg { width: 54px; height: 54px; flex: none; }
.rw-note .rw-sev { font-size: 44px; font-weight: 800; line-height: 1; color: var(--rw-amber); min-width: 24px; text-align: center; }
.rw-note .rw-ntext { display: flex; flex-direction: column; gap: 2px; }
.rw-note .rw-ntext b { font-size: 15px; line-height: 1.12; letter-spacing: .06em; text-transform: uppercase; max-width: 230px;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
.rw-note:not(:first-child) .rw-ntext { display: none; }
.rw-note:not(:first-child) { min-width: 0; padding-right: 8px; }
.rw-note .rw-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.rw-note .rw-tags span { font-size: 10px; font-weight: 700; letter-spacing: .1em; padding: 1px 5px; background: rgba(255,255,255,.14); text-transform: uppercase; }
.rw-note .rw-tags span.rw-warn { background: var(--rw-red); }
.rw-note.rw-warncard { border-left-color: var(--rw-red); }
.rw-note .rw-tags:empty { display: none; }
.rw-note .rw-dist { font-size: 13px; color: var(--rw-dim); }

/* ---- gauge cluster (bottom right) */
.rw-gauge { position: absolute; right: 18px; bottom: 16px; width: 230px; height: 214px; }
.rw-gauge svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.rw-gauge .rw-speed { position: absolute; left: 0; right: 0; top: 64px; text-align: center; font-size: 62px; font-weight: 700; line-height: 1; letter-spacing: -.01em; text-shadow: 0 2px 8px rgba(0,0,0,.6); }
.rw-gauge .rw-unit { position: absolute; left: 0; right: 0; top: 126px; text-align: center; font-size: 12px; letter-spacing: .3em; color: var(--rw-dim); }
.rw-gauge .rw-gear { position: absolute; left: 50%; top: 162px; transform: translateX(-50%); width: 40px; height: 44px; display: flex; align-items: center; justify-content: center; font-size: 34px; font-weight: 800; background: var(--rw-panel); border: 2px solid var(--rw-line); }
.rw-gauge .rw-gear.rw-shift { background: var(--rw-amber); color: var(--rw-ink); border-color: var(--rw-amber); }
.rw-gauge .rw-gear.rw-limit { background: var(--rw-red); color: #fff; border-color: var(--rw-red); }
.rw-gauge .rw-boost { position: absolute; left: 80px; right: 80px; top: 146px; height: 4px; background: rgba(255,255,255,.12); }
.rw-gauge .rw-boost > i { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--rw-blue); }
.rw-gauge .rw-rpm { display: none; }
.rw-surface { position: absolute; right: 18px; bottom: 236px; display: flex; gap: 8px; align-items: center; padding: 4px 10px 4px 9px; font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
  color: #d3dae2; background: var(--rw-panel); clip-path: var(--rw-chamfer); border-left: 3px solid var(--rw-amber); text-shadow: 0 1px 2px rgba(0,0,0,.8); }
.rw-surface i { flex: none; width: 10px; height: 10px; border: 1px solid rgba(255,255,255,.6); transform: rotate(45deg); }
.rw-surface b { color: var(--rw-text); }
.rw-surface span { color: #c3ccd6; }
/* the tuning panel (lil-gui, fixed top right, 320 px) covers the right HUD column: move it left while open */
body.rw-tuning-open .rw-clock, body.rw-tuning-open .rw-gauge, body.rw-tuning-open .rw-surface { right: 352px; }
body.rw-tuning-open .rw-notes { max-width: calc(100vw - 2 * min(420px, 41vw) - 340px); }

/* ---- status chips (bottom left) */
.rw-chips { position: absolute; left: 18px; bottom: 18px; display: flex; flex-direction: column-reverse; gap: 6px; align-items: flex-start; }
.rw-chip { font-size: 13px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; padding: 4px 10px; background: var(--rw-panel); border-left: 3px solid var(--rw-blue); }
.rw-chip.rw-amberc { border-left-color: var(--rw-amber); }
.rw-chip.rw-redc { border-left-color: var(--rw-red); }

/* ---- centre messages */
.rw-msg { position: absolute; left: 0; right: 0; top: 34%; text-align: center; font-size: 120px; font-weight: 800; font-style: italic; letter-spacing: .04em; line-height: 1;
  color: #fff; text-shadow: 0 6px 30px rgba(0,0,0,.55), 0 0 2px #000; opacity: 0; transform: scale(1.2); transition: opacity .15s, transform .25s; }
.rw-msg.rw-on { opacity: 1; transform: scale(1); }
.rw-msg.rw-go { color: var(--rw-green); }
.rw-msg.rw-finish { color: var(--rw-amber); font-size: 96px; }
.rw-msg.rw-wrong { color: var(--rw-red); font-size: 72px; animation: rw-blink .6s steps(2, start) infinite; }
@keyframes rw-blink { to { visibility: hidden; } }
.rw-cp { position: absolute; left: 50%; top: 24%; transform: translateX(-50%); padding: 8px 22px; display: flex; gap: 18px; align-items: baseline; opacity: 0; transition: opacity .3s; }
.rw-cp.rw-on { opacity: 1; }
.rw-cp b { font-size: 30px; }
.rw-cp span { font-size: 14px; letter-spacing: .16em; text-transform: uppercase; color: var(--rw-dim); }
.rw-fade { position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none; display: flex; align-items: center; justify-content: center; }
.rw-fade span { font-family: var(--rw-font); font-size: 22px; letter-spacing: .4em; color: var(--rw-amber); text-transform: uppercase; }

/* ---- toasts */
.rw-toast-wrap { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; align-items: center; pointer-events: none; }
.rw-toast { padding: 6px 14px; font-size: 14px; letter-spacing: .1em; text-transform: uppercase; background: var(--rw-panel); border-left: 3px solid var(--rw-amber); animation: rw-toast 2.4s forwards; }
@keyframes rw-toast { 0% { opacity: 0; transform: translateY(8px); } 10%, 80% { opacity: 1; transform: none; } 100% { opacity: 0; } }

/* ======================================================================= menus */
.rw-menu { position: absolute; inset: 0; pointer-events: auto; display: none; }
.rw-menu.rw-open { display: block; }
.rw-menu .rw-shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(6,8,11,.94) 0%, rgba(6,8,11,.80) 38%, rgba(6,8,11,.25) 70%, rgba(6,8,11,.05) 100%); }
.rw-menu.rw-center .rw-shade { background: rgba(6,8,11,.62); }
.rw-main { position: absolute; left: clamp(16px, 5vw, 72px); top: 50%; transform: translateY(-50%); box-sizing: border-box; width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 24px); overflow-y: auto; overscroll-behavior: contain; }
.rw-title { font-size: 46px; font-weight: 800; font-style: italic; letter-spacing: .02em; line-height: .95; text-transform: uppercase; }
.rw-title em { color: var(--rw-amber); font-style: italic; }
.rw-subtitle { margin: 4px 0 12px; font-size: 13px; letter-spacing: .3em; text-transform: uppercase; color: var(--rw-dim); }
.rw-rows { display: flex; flex-direction: column; gap: 2px; }
.rw-opt { display: grid; grid-template-columns: 130px 1fr; align-items: center; min-height: 31px; padding: 0 10px; background: rgba(255,255,255,.035); border-left: 3px solid transparent; cursor: pointer; }
.rw-opt.rw-focus { background: rgba(255,184,28,.13); border-left-color: var(--rw-amber); }
.rw-opt.rw-disabled { opacity: .38; }
.rw-opt .rw-k { font-size: 12px; letter-spacing: .18em; text-transform: uppercase; color: var(--rw-dim); font-weight: 600; }
.rw-opt .rw-v { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 17px; font-weight: 600; letter-spacing: .04em; }
.rw-opt .rw-v .rw-val { flex: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rw-opt .rw-v small { color: var(--rw-dim); font-size: 12px; letter-spacing: .1em; margin-left: 6px; }
.rw-arrow { width: 28px; height: 28px; border: 0; background: transparent; color: var(--rw-dim); font: 700 18px/1 var(--rw-font); cursor: pointer; }
.rw-arrow:hover, .rw-opt.rw-focus .rw-arrow { color: var(--rw-amber); }
.rw-info { margin: 8px 0 0; padding: 10px 12px; font-size: 14px; line-height: 1.45; color: #cdd5de; background: rgba(255,255,255,.04); border-left: 3px solid var(--rw-line); min-height: 42px; }
.rw-info b { color: var(--rw-text); letter-spacing: .06em; }
.rw-swatch { display: inline-block; width: 12px; height: 12px; margin-right: 3px; vertical-align: -1px; border: 1px solid rgba(255,255,255,.35); }
.rw-actions { display: flex; gap: 10px; align-items: stretch; margin-top: 10px; }
.rw-btn { flex: none; padding: 12px 22px; border: 0; background: rgba(255,255,255,.08); color: var(--rw-text); font: 700 17px/1 var(--rw-font); letter-spacing: .16em; text-transform: uppercase; cursor: pointer; clip-path: var(--rw-chamfer); }
.rw-btn.rw-primary { background: var(--rw-amber); color: var(--rw-ink); }
.rw-btn.rw-focus { outline: 2px solid #fff; outline-offset: -2px; }
.rw-btn.rw-primary.rw-focus { outline-color: var(--rw-ink); box-shadow: 0 0 0 2px var(--rw-amber); }
.rw-best { display: flex; flex-direction: column; justify-content: center; padding: 0 8px; font-size: 13px; color: var(--rw-dim); letter-spacing: .1em; text-transform: uppercase; }
.rw-best b { font-size: 20px; color: var(--rw-text); letter-spacing: .02em; }
.rw-foot { margin-top: 10px; font-size: 12px; color: var(--rw-dim); letter-spacing: .12em; text-transform: uppercase; }
.rw-foot kbd, .rw-help kbd { display: inline-block; min-width: 18px; padding: 1px 5px; margin: 0 2px; border: 1px solid rgba(255,255,255,.3); border-bottom-width: 2px; font: 600 11px/1.3 var(--rw-font); color: var(--rw-text); text-align: center; }
.rw-card { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); box-sizing: border-box; display: flex; flex-direction: column; width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 24px); overflow: hidden; padding: 22px 26px 22px; }
.rw-card > * { flex: none; }
/* only the splits table scrolls: the buttons and the key hints always stay on screen */
.rw-card .rw-scroll { flex: 0 1 auto; min-height: 48px; overflow-y: auto; overscroll-behavior: contain; margin: 12px 0 14px; }
.rw-card h2 { margin: 0; font-size: 40px; font-weight: 800; font-style: italic; letter-spacing: .04em; text-transform: uppercase; }
.rw-card .rw-cardsub { margin: 4px 0 16px; font-size: 13px; letter-spacing: .2em; color: var(--rw-dim); text-transform: uppercase; }
.rw-card .rw-col { display: flex; flex-direction: column; gap: 6px; }
.rw-card .rw-col .rw-btn { width: 100%; text-align: left; }
.rw-bigtime { font-size: 64px; font-weight: 800; line-height: 1; letter-spacing: .01em; }
.rw-badge { display: inline-block; margin: 8px 0 4px; padding: 3px 10px; font-size: 14px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
.rw-badge.rw-newbest { background: var(--rw-green); color: var(--rw-ink); }
.rw-badge.rw-slowb { background: rgba(255,75,62,.18); color: var(--rw-red); }
.rw-splits { width: 100%; margin: 0; border-collapse: collapse; font-size: 15px; }
.rw-splits tr.rw-th td { color: var(--rw-dim); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; border-bottom-color: rgba(255,255,255,.25); }
.rw-splits tr.rw-bestlap td:nth-child(2) { color: var(--rw-green); font-weight: 700; }
.rw-splits td { padding: 4px 6px; border-bottom: 1px solid var(--rw-line); }
.rw-splits td:first-child { color: var(--rw-dim); letter-spacing: .12em; font-size: 12px; text-transform: uppercase; }
.rw-splits td:not(:first-child) { text-align: right; }
.rw-stats { display: flex; gap: 18px; margin-bottom: 14px; font-size: 13px; color: var(--rw-dim); letter-spacing: .1em; text-transform: uppercase; }
.rw-stats b { color: var(--rw-text); font-size: 16px; }
.rw-row-actions { display: flex; gap: 8px; flex-wrap: wrap; }

/* ---- help */
.rw-help { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(6,8,11,.72); pointer-events: auto; z-index: 5; }
.rw-help.rw-open { display: flex; }
.rw-help .rw-helpcard { width: min(860px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; padding: 20px 26px; }
.rw-help h2 { margin: 0 0 12px; font-size: 30px; font-style: italic; letter-spacing: .06em; text-transform: uppercase; }
.rw-help .rw-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 6px 26px; }
.rw-help h3 { margin: 10px 0 4px; font-size: 12px; letter-spacing: .24em; text-transform: uppercase; color: var(--rw-amber); }
.rw-help .rw-kv { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,.06); font-size: 14px; }
.rw-help .rw-kv span:first-child { color: #cfd6de; }
.rw-help .rw-kv span:last-child { text-align: right; white-space: nowrap; }
.rw-help p { margin: 12px 0 0; font-size: 12px; color: var(--rw-dim); letter-spacing: .08em; }

@media (max-width: 1100px) {
  .rw-notes { top: 82px; max-width: calc(100vw - 32px); }
}
/* 720p windows: the main menu has 13 rows since the Opponents / Ghost rows (phase 2): tighten it so title and buttons both fit */
@media (max-height: 800px) {
  .rw-title { font-size: 40px; }
  .rw-subtitle { margin: 2px 0 8px; }
  .rw-opt { min-height: 27px; }
  .rw-info { margin-top: 6px; padding: 6px 12px; min-height: 0; }
  .rw-actions { margin-top: 8px; }
  .rw-foot { margin-top: 6px; font-size: 11px; }
}
/* short windows (a 1366x768 laptop browser is about 620-640 px tall): compact menus so every button fits */
@media (max-height: 700px) {
  .rw-title { font-size: 34px; }
  .rw-subtitle { margin: 2px 0 8px; font-size: 11px; }
  .rw-opt { min-height: 26px; }
  .rw-opt .rw-v { font-size: 15px; }
  .rw-arrow { height: 24px; }
  .rw-info { margin-top: 6px; padding: 6px 10px; font-size: 13px; line-height: 1.35; min-height: 0; }
  .rw-actions { margin-top: 8px; }
  .rw-btn { padding: 10px 18px; font-size: 15px; }
  .rw-foot { margin-top: 6px; }
  .rw-card { padding: 14px 20px 14px; }
  .rw-card h2 { font-size: 30px; }
  .rw-card .rw-cardsub { margin: 2px 0 8px; }
  .rw-card .rw-scroll { margin: 8px 0 10px; }
  .rw-bigtime { font-size: 46px; }
  .rw-badge { margin: 4px 0 2px; }
  .rw-splits td { padding: 2px 6px; }
  .rw-stats { margin-bottom: 8px; }
}
@media (max-height: 540px) {
  .rw-subtitle, .rw-main .rw-foot { display: none; }
  .rw-opt { min-height: 23px; }
}
/* narrow portrait windows: stack the progress box under the clock instead of overlapping it */
@media (max-width: 520px) {
  .rw-progress { top: 92px; left: auto; right: 18px; width: min(300px, calc(100vw - 36px)); box-sizing: border-box; }
  .rw-clock { min-width: 0; }
  .rw-notes { top: 150px; }
  /* circuits: the clock carries the lap box (≈ 26 px taller) */
  .rw-hud.rw-closed .rw-progress { top: 120px; }
  .rw-hud.rw-closed .rw-notes { top: 178px; }
}
@media (max-width: 720px) {
  .rw-gauge { transform: scale(.78); transform-origin: bottom right; }
  .rw-clock .rw-time { font-size: 30px; }
  .rw-msg { font-size: 80px; }
  .rw-title { font-size: 40px; }
  .rw-opt { grid-template-columns: 96px 1fr; }
}
`;

let injected = false;

export function injectUiStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const el = document.createElement('style');
  el.id = 'rw-ui-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}
