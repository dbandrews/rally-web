/**
 * src/game/ghosts/store.ts — GHOSTS BUILDER. Persistence of the player's saved ghosts (SAVE GHOST): the original writes
 * one 3.0 file per ghost into "Ghost Cars\" (research/formats/ghosts.md §4); the port keeps the same file bytes as records
 * in IndexedDB keyed by (stage id, car, name), with an in-memory fallback when IndexedDB is unavailable or fails (private
 * windows, blocked storage, node/vitest). The bytes are the exe's 3.0 layout, so a record can be exported as a real file.
 */
import { checkGhostName } from './names';
import { ghostCarOf, ghostTotalTime, parseGhost, writeGhost, type GhostFile } from './format';

export interface SavedGhostRecord {
  /** `user:<stage id>/<car>/<lower-case name>` */
  id: string;
  stageId: string;
  /** Original car (the file's `<Car>Ghost` minus "Ghost"). */
  car: string;
  name: string;
  /** Total time (s). */
  time: number;
  /** ms since epoch. */
  date: number;
  /** The 3.0 file. */
  bytes: Uint8Array;
}

export const userGhostId = (stageId: string, car: string, name: string): string => `user:${stageId}/${car}/${name.trim().toLowerCase()}`;

/** A key/record backend: a thin async map. */
export interface GhostBackend {
  readonly kind: 'indexeddb' | 'memory';
  getAll(): Promise<SavedGhostRecord[]>;
  get(id: string): Promise<SavedGhostRecord | null>;
  put(rec: SavedGhostRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemoryGhostBackend implements GhostBackend {
  readonly kind = 'memory' as const;
  private readonly m = new Map<string, SavedGhostRecord>();
  async getAll(): Promise<SavedGhostRecord[]> {
    return [...this.m.values()];
  }
  async get(id: string): Promise<SavedGhostRecord | null> {
    return this.m.get(id) ?? null;
  }
  async put(rec: SavedGhostRecord): Promise<void> {
    this.m.set(rec.id, { ...rec, bytes: new Uint8Array(rec.bytes) });
  }
  async delete(id: string): Promise<void> {
    this.m.delete(id);
  }
}

const DB_NAME = 'rally-web-ghosts';
const STORE = 'ghosts';

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });

/** The database could not be opened or is unavailable (blocked, private window, no storage): the store may fall back to memory. */
export class GhostStorageUnavailable extends Error {}

/** IndexedDB backend (one object store keyed by record id). Opening is lazy; every failure rejects. */
export class IndexedDbGhostBackend implements GhostBackend {
  readonly kind = 'indexeddb' as const;
  private db: Promise<IDBDatabase> | null = null;
  private readonly factory: IDBFactory;
  constructor(factory: IDBFactory) {
    this.factory = factory;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        let r: IDBOpenDBRequest;
        try {
          r = this.factory.open(DB_NAME, 1);
        } catch (e) {
          reject(e);
          return;
        }
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
        r.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
      this.db.catch(() => {
        this.db = null; // allow a retry
      });
    }
    return this.db;
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBTransaction> {
    let db: IDBDatabase;
    try {
      db = await this.open();
    } catch (e) {
      throw new GhostStorageUnavailable(e instanceof Error ? e.message : 'IndexedDB unavailable');
    }
    return db.transaction(STORE, mode);
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.tx(mode)).objectStore(STORE);
  }

  /** A write is done when its TRANSACTION commits: a quota error surfaces at commit (abort), after the request succeeded. */
  private async write(op: (s: IDBObjectStore) => IDBRequest): Promise<void> {
    const tx = await this.tx('readwrite');
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      op(tx.objectStore(STORE));
    });
  }

  async getAll(): Promise<SavedGhostRecord[]> {
    return (await req((await this.store('readonly')).getAll())) as SavedGhostRecord[];
  }
  async get(id: string): Promise<SavedGhostRecord | null> {
    return ((await req((await this.store('readonly')).get(id))) as SavedGhostRecord | undefined) ?? null;
  }
  async put(rec: SavedGhostRecord): Promise<void> {
    await this.write((s) => s.put(rec));
  }
  async delete(id: string): Promise<void> {
    await this.write((s) => s.delete(id));
  }
}

export type SaveResult = { ok: true; id: string } | { ok: false; reason: 'invalid' | 'space' | 'mismatch' };

/**
 * The saved-ghost store. Reads and writes go to IndexedDB when it works. Only an UNAVAILABLE database (cannot be opened:
 * blocked, private window, no storage) switches to memory for the rest of the session and sets `degraded` (the ghost then
 * lives for this session only; the menu says so). A failure of a single operation on a working database (a quota error on
 * put) is NOT hidden by a memory write: it propagates, and save() reports reason 'space'.
 */
export class UserGhostStore {
  private backend: GhostBackend;
  private readonly fallback = new MemoryGhostBackend();
  /** True once IndexedDB failed and the memory fallback took over. */
  degraded = false;

  constructor(backend?: GhostBackend) {
    this.backend = backend ?? defaultBackend();
    if (this.backend.kind === 'memory') this.degraded = true;
  }

  get kind(): 'indexeddb' | 'memory' {
    return this.backend.kind;
  }

  private async run<T>(op: (b: GhostBackend) => Promise<T>): Promise<T> {
    try {
      return await op(this.backend);
    } catch (e) {
      if (this.backend === this.fallback || !(e instanceof GhostStorageUnavailable)) throw e;
      this.backend = this.fallback;
      this.degraded = true;
      return op(this.backend);
    }
  }

  /** Records of one stage (any car), newest first. Records that do not parse are skipped. */
  async list(stageId: string): Promise<SavedGhostRecord[]> {
    const all = await this.run((b) => b.getAll());
    return all.filter((r) => r.stageId === stageId && r.bytes && r.bytes.length > 0).sort((a, b) => b.date - a.date);
  }

  async get(id: string): Promise<SavedGhostRecord | null> {
    return this.run((b) => b.get(id));
  }

  /** The parsed ghost of a record, or null when the file is corrupt (the original: "Unable to load ghost file"). */
  async load(id: string): Promise<GhostFile | null> {
    const r = await this.get(id);
    if (!r) return null;
    try {
      return parseGhost(r.bytes);
    } catch {
      return null;
    }
  }

  async has(stageId: string, car: string, name: string): Promise<boolean> {
    return (await this.get(userGhostId(stageId, car, name))) !== null;
  }

  /** Save `file` (a 3.0 ghost named `name`) for `stageId`; an existing record of the same name is replaced. */
  async save(stageId: string, file: GhostFile, name: string): Promise<SaveResult> {
    const chk = checkGhostName(name);
    if (!chk.ok) return { ok: false, reason: 'invalid' };
    const car = ghostCarOf(file.carTemplate);
    const named: GhostFile = { ...file, version: '3.0', ghostName: chk.name };
    const bytes = writeGhost(named);
    const rec: SavedGhostRecord = {
      id: userGhostId(stageId, car, chk.name),
      stageId,
      car,
      name: chk.name,
      time: ghostTotalTime(named),
      date: Date.now(),
      bytes,
    };
    try {
      await this.run((b) => b.put(rec));
    } catch {
      return { ok: false, reason: 'space' };
    }
    return { ok: true, id: rec.id };
  }

  async delete(id: string): Promise<void> {
    try {
      await this.run((b) => b.delete(id));
    } catch {
      /* nothing to delete */
    }
  }
}

function defaultBackend(): GhostBackend {
  try {
    const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (f && typeof f.open === 'function') return new IndexedDbGhostBackend(f);
  } catch {
    /* blocked */
  }
  return new MemoryGhostBackend();
}

let shared: UserGhostStore | null = null;
/** The page-wide store (one IndexedDB database). */
export function sharedUserGhostStore(): UserGhostStore {
  if (!shared) shared = new UserGhostStore();
  return shared;
}
