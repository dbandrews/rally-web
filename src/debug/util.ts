/**
 * src/debug/util.ts — game builder. Helpers for the debug tools: a text-field guard for key handlers, a
 * small JSON modal (Copy / Paste JSON fallback) and a guarded localStorage.
 */

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

export const store = {
  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string): boolean {
    try {
      globalThis.localStorage?.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key: string): void {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Modal with a textarea. mode 'copy': shows `text` selected for manual copying. mode 'paste': lets the user
 * paste JSON and calls onApply(text).
 */
export function jsonModal(mode: 'copy' | 'paste', text: string, onApply?: (t: string) => void): void {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);pointer-events:auto;font:13px/1.4 ui-monospace,monospace';
  const box = document.createElement('div');
  box.style.cssText = 'width:min(720px,92vw);background:#11161d;border-left:3px solid #ffb81c;padding:14px;color:#e8edf2';
  const title = document.createElement('div');
  title.textContent = mode === 'copy' ? 'Tunables JSON (copy it)' : 'Paste tunables JSON';
  title.style.cssText = 'font-weight:700;margin-bottom:8px;letter-spacing:.08em;text-transform:uppercase';
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.spellcheck = false;
  ta.style.cssText = 'width:100%;height:50vh;background:#0b0f14;color:#cfe;border:1px solid #333;font:12px/1.35 ui-monospace,monospace';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px';
  const btn = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:6px 14px;background:#ffb81c;border:0;font-weight:700;cursor:pointer';
    b.onclick = fn;
    row.appendChild(b);
  };
  const close = () => wrap.remove();
  const err = document.createElement('div');
  err.style.cssText = 'color:#ff7a6e;margin-top:6px;min-height:1em';
  if (mode === 'paste') {
    btn('Apply', () => {
      try {
        onApply?.(ta.value);
        close();
      } catch (e) {
        err.textContent = e instanceof Error ? e.message : String(e);
      }
    });
  }
  btn('Close', close);
  box.append(title, ta, err, row);
  wrap.appendChild(box);
  wrap.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  document.body.appendChild(wrap);
  ta.focus();
  if (mode === 'copy') ta.select();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    const clip = (globalThis.navigator as Navigator | undefined)?.clipboard as Clipboard | undefined;
    if (clip && typeof clip.writeText === 'function') {
      await clip.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}
