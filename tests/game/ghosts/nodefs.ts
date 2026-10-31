/**
 * Test helper (ghosts builder): node:fs / node:crypto through computed specifiers, because the project has no Node
 * typings (tsc covers tests/); paths are relative to the repo root (vitest's cwd).
 */
interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc?: string): Uint8Array | string;
  readdirSync(p: string): string[];
}
export const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;

export const FIX = 'tests/game/ghosts/fixtures';
export const TEAM_DIR = '.cache/original/Misc/teamghosts';

export const exists = (p: string): boolean => fs.existsSync(p);
export const readBytes = (p: string): Uint8Array => new Uint8Array(fs.readFileSync(p) as Uint8Array);
export const readText = (p: string): string => fs.readFileSync(p, 'utf8') as string;
export const listDir = (p: string): string[] => fs.readdirSync(p).slice().sort();
export const readJson = <T>(p: string): T => JSON.parse(readText(p)) as T;

/** Environment variable (undefined outside node). */
export const env = (k: string): string | undefined =>
  (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env[k];

export const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** sha256 hex of bytes or of a list of float32 arrays (concatenated). */
export async function sha256(data: Uint8Array | Float32Array[]): Promise<string> {
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) bytes = data;
  else {
    const n = data.reduce((a, s) => a + s.byteLength, 0);
    bytes = new Uint8Array(n);
    let o = 0;
    for (const s of data) {
      bytes.set(new Uint8Array(s.buffer, s.byteOffset, s.byteLength), o);
      o += s.byteLength;
    }
  }
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));
}

export const f32at = (b: Uint8Array, off: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(off, true);
export const u32at = (b: Uint8Array, off: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, true);
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
