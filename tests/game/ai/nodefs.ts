// node:fs / node:zlib through computed specifiers: the project has no Node typings (same trick as tests/assets/builtAssets.test.ts)
interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc?: string): Uint8Array | string;
}
interface Zlib {
  gunzipSync(b: Uint8Array): Uint8Array;
}
export const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;
const zlib = (await import(/* @vite-ignore */ 'node:' + 'zlib')) as Zlib;
/** Read a JSON fixture (plain or .gz) relative to the test file. */
export const readJson = <T>(rel: string): T => {
  const path = new URL(rel, import.meta.url).pathname;
  const raw = fs.readFileSync(path) as Uint8Array;
  const text = path.endsWith('.gz') ? new TextDecoder().decode(zlib.gunzipSync(raw)) : new TextDecoder().decode(raw);
  return JSON.parse(text) as T;
};
export const root = new URL('../../../', import.meta.url).pathname;
