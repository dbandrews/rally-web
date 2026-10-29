/**
 * src/core/paths.ts — ARCHITECT-OWNED CONTRACT. Builders: import, do not edit.
 *
 * Dotted-path get/set and deep merge/clone for parameter objects (tuning panel, test API setParam,
 * ICarSim.setParams). Paths: 'mass', 'wheel.front.springK', 'gearRatio.2', 'surfaces.gravel.tyre.2.bestStatic'.
 * Array indices are plain numeric segments.
 */

export type PlainObject = Record<string, unknown>;

const isObj = (v: unknown): v is PlainObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep clone of plain data (objects, arrays, primitives, typed arrays). */
export function deepClone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => deepClone(x)) as unknown as T;
  if (ArrayBuffer.isView(v)) return (v as unknown as { slice(): unknown }).slice() as T;
  if (isObj(v)) {
    const out: PlainObject = {};
    for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
    return out as T;
  }
  return v;
}

/**
 * Deep-merge `src` into `dst` IN PLACE (dst keeps its object identities, so live references stay valid).
 * Arrays and primitives in `src` replace the value in `dst`. Keys absent in `dst` are added.
 * Returns dst.
 */
export function deepMergeInto<T extends object>(dst: T, src: unknown): T {
  if (!isObj(src)) return dst;
  const d = dst as unknown as PlainObject;
  for (const k of Object.keys(src)) {
    const sv = src[k];
    if (sv === undefined) continue;
    const dv = d[k];
    if (isObj(sv) && isObj(dv)) deepMergeInto(dv, sv);
    else d[k] = deepClone(sv);
  }
  return dst;
}

export function splitPath(path: string): string[] {
  return path.split('.').filter((p) => p.length > 0);
}

/** Read a value by dotted path; undefined if any segment is missing. */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of splitPath(path)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as PlainObject)[seg];
  }
  return cur;
}

/**
 * Write a value by dotted path IN PLACE. Throws if an intermediate segment does not exist (catches typos
 * in tuning paths early). Returns the previous value.
 */
export function setPath(root: unknown, path: string, value: unknown): unknown {
  const segs = splitPath(path);
  if (segs.length === 0) throw new Error('setPath: empty path');
  let cur: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = (cur as PlainObject)[segs[i]];
    if (next === null || typeof next !== 'object') {
      throw new Error(`setPath: '${segs.slice(0, i + 1).join('.')}' does not exist (path '${path}')`);
    }
    cur = next;
  }
  const last = segs[segs.length - 1];
  const obj = cur as PlainObject;
  if (!(last in obj)) throw new Error(`setPath: unknown key '${path}'`);
  const prev = obj[last];
  obj[last] = value;
  return prev;
}

/** Build a nested partial object from a path: ('wheel.front.springK', 1) -> {wheel:{front:{springK:1}}}.
 *  Numeric segments under an existing array in `shapeRoot` produce a full copy of that array with the
 *  element replaced (arrays are replaced wholesale by deep merges). */
export function partialFromPath(path: string, value: unknown, shapeRoot?: unknown): PlainObject {
  const segs = splitPath(path);
  const build = (i: number, shape: unknown): unknown => {
    if (i === segs.length) return value;
    const seg = segs[i];
    if (Array.isArray(shape)) {
      const arr = deepClone(shape) as unknown[];
      arr[Number(seg)] = build(i + 1, shape[Number(seg)]);
      return arr;
    }
    const child = isObj(shape) ? shape[seg] : undefined;
    return { [seg]: build(i + 1, child) };
  };
  return build(0, shapeRoot) as PlainObject;
}
