/**
 * src/game/storage.ts — game builder. Key/value persistence that works in the browser (localStorage) and in
 * node/vitest (in-memory fallback). Every access is guarded: private windows, quota errors and blocked
 * storage never throw into the game.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStore implements KeyValueStore {
  private readonly m = new Map<string, string>();
  getItem(key: string): string | null {
    return this.m.has(key) ? (this.m.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.m.set(key, String(value));
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  keys(): string[] {
    return [...this.m.keys()];
  }
}

/** The browser's localStorage if it is usable, else null. */
export function browserStore(): KeyValueStore | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls || typeof ls.getItem !== 'function') return null;
    const k = '__rally_probe__';
    ls.setItem(k, '1');
    ls.removeItem(k);
    return ls;
  } catch {
    return null;
  }
}

/** Wraps a store so that failures (quota, security errors) are swallowed; writes fall back to memory. */
export class SafeStore implements KeyValueStore {
  private readonly inner: KeyValueStore | null;
  private readonly mem = new MemoryStore();
  constructor(inner: KeyValueStore | null) {
    this.inner = inner;
  }
  getItem(key: string): string | null {
    const m = this.mem.getItem(key);
    if (m !== null) return m;
    try {
      return this.inner ? this.inner.getItem(key) : null;
    } catch {
      return null;
    }
  }
  setItem(key: string, value: string): void {
    try {
      if (this.inner) {
        this.inner.setItem(key, value);
        this.mem.removeItem(key);
        return;
      }
    } catch {
      /* quota / blocked: keep it for this session */
    }
    this.mem.setItem(key, value);
  }
  removeItem(key: string): void {
    this.mem.removeItem(key);
    try {
      this.inner?.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** Default store: localStorage when available, memory otherwise, always guarded. */
export function defaultStore(): KeyValueStore {
  return new SafeStore(browserStore());
}

export function readJson<T>(store: KeyValueStore, key: string): T | null {
  const raw = store.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(store: KeyValueStore, key: string, value: unknown): void {
  store.setItem(key, JSON.stringify(value));
}
