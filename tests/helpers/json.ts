/**
 * tests/helpers/json.ts — ARCHITECT-PROVIDED test helper (read-only for builders).
 * Telemetry / race state / stage info must be JSON-serialisable (Playwright page.evaluate, drive.mjs).
 */

/** Returns null if `v` is plain JSON data (finite numbers, strings, booleans, null, arrays, plain
 *  objects), else a path + reason for the first offending value. */
export function jsonSafetyIssue(v: unknown, path = '$'): string | null {
  if (v === null) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      return Number.isFinite(v) ? null : `${path}: non-finite number ${v}`;
    case 'object': {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const r = jsonSafetyIssue(v[i], `${path}[${i}]`);
          if (r) return r;
        }
        return null;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return `${path}: not a plain object (${proto?.constructor?.name})`;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined) return `${path}.${k}: undefined`;
        const r = jsonSafetyIssue(x, `${path}.${k}`);
        if (r) return r;
      }
      return null;
    }
    default:
      return `${path}: ${typeof v}`;
  }
}
