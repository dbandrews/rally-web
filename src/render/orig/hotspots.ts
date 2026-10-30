/**
 * src/render/orig/hotspots.ts — the original's HotSpot regulator (FUN_004e1240, evaluated every frame by
 * FUN_0049c770), the ONE implementation the track (trackData.trackViewDistance), the environment
 * (environmentData.hotspotTrackViewDistance) and the objects (objectsData.hotspotSettings) use. No three.js.
 *
 * For a spline distance s (here: the camera projected onto the stage's centre spline), every spot with
 * |s − splineDistance| ≤ width (`width` is the HALF window, inclusive) contributes, for each field it sets to a
 * non-zero value v:
 *     core  = (1 − fade)·width
 *     t     = d ≤ core ? 0 : (d − core) / (fade·width)            (d = |s − splineDistance|)
 *     delta = (1 − t)·(v − Global)
 * and the field's value is Global + min(0, every negative delta) + max(0, every positive delta) — the strongest
 * shortening and the strongest lengthening, not a sequential blend. The Global spot itself never contributes
 * (its delta is 0 by construction; its window is s = 0 only). Fields a spot leaves at 0 are ignored.
 */

/** The window part of a spot (unset fields: the spot ctor's 0, 0x4e0e30). */
export interface HotSpotWindow {
  splineDistance?: number;
  width?: number;
  fade?: number;
}

/**
 * 1 − t of a spot at spline distance s (1 inside the core, falling linearly to 0 at the window edge), or −1 when
 * s is outside the window (or the spot has no window).
 */
export function hotspotWeight(h: HotSpotWindow, s: number): number {
  const sd = h.splineDistance;
  if (sd === undefined || !Number.isFinite(sd)) return -1;
  const width = h.width ?? 0;
  const d = Math.abs(s - sd);
  if (!(d <= width)) return -1;
  const fade = h.fade ?? 0;
  const core = (1 - fade) * width;
  const t = core < d ? (d - core) / (fade * width) : 0;
  return 1 - t;
}

/**
 * One regulated field: Global `global` adjusted by every spot in `spots` (FUN_004e1240). `value(h)` reads the field
 * of a spot (undefined / 0 = not set). A non-finite `s` returns `global`.
 */
export function regulateHotspot<T extends HotSpotWindow>(global: number, spots: readonly T[], s: number, value: (h: T) => number | undefined): number {
  if (!Number.isFinite(s)) return global;
  let neg = 0;
  let pos = 0;
  for (const h of spots) {
    const v = value(h);
    if (v === undefined || v === 0 || !Number.isFinite(v)) continue;
    const w = hotspotWeight(h, s);
    if (w < 0) continue;
    const delta = w * (v - global);
    if (delta <= 0) {
      if (delta < neg) neg = delta;
    } else if (delta > pos) pos = delta;
  }
  return global + neg + pos;
}

/** The largest value the regulator can produce for a field (Global and every spot's own value). */
export function maxHotspotValue<T>(global: number, spots: readonly T[], value: (h: T) => number | undefined): number {
  let m = global;
  for (const h of spots) {
    const v = value(h);
    if (typeof v === 'number' && v > m) m = v;
  }
  return m;
}
