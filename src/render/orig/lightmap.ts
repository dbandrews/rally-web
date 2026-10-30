/**
 * src/render/orig/lightmap.ts — the PROJECTED track lightmap (no three.js): what the original's car and particle
 * shaders sample under them (research/formats/cars.md §7, effects.md §6.4).
 *
 *   Car/vs/*Lightmap*.vs, EnvmapPass0t.vs, Sprite*Lighting.vs:
 *       oT3 = (Vworld.xz − C_LIGHTMAP_OFFSET.xz) · C_LIGHTMAP_INVSIZE.xz          (SIM world space)
 *   and the pixel shader multiplies by t3 = the patch's P8 lightmap looked up through the CURRENT palette: the car
 *   palette (race +0x948) for the cars, the particle palette (+0x94c) for the sprites — both lightmapLut()
 *   (common.ts, FUN_004e0780), never Track.pal.
 * Every Track.qm patch's lightmap uv3 is an exact axis-aligned linear map of world x and z (kenya1f: max residual
 * 8e-8, effects.md §6.4), so the offset / inverse size of a patch is recovered here by a least-squares fit of its
 * own vertices: u = a·x + b, v = c·z + d in THREE space (the z sign of SIM folds into c).
 * Which patch the original binds for a car is not traced: the patch whose XZ cell holds the car's origin (its
 * height range breaking ties under bridges) [I]. Outside every patch (or a patch without a lightmap): white.
 */

/** u = p[0]·x + p[1], v = p[2]·z + p[3] (three-space world x / z → the patch lightmap's uv). */
export type LightmapProjection = readonly [number, number, number, number];

/** Max |fit − uv3| accepted as the original's axis-aligned projection (uv units). */
export const LIGHTMAP_FIT_TOLERANCE = 1e-3;

/**
 * Least-squares u = a·x + b and v = c·z + d over vertices [start, start + count) of an interleaved float block
 * (`stride` floats per vertex; position x at `posOff`, z at `posOff + 2`; uv3 at `uvOff`). Returns the projection and
 * the largest residual, or null when the patch has fewer than two distinct x or z values.
 */
export function fitLightmapProjection(
  v: Float32Array,
  stride: number,
  posOff: number,
  uvOff: number,
  start: number,
  count: number,
): { proj: LightmapProjection; residual: number } | null {
  if (count < 2) return null;
  let mx = 0, mz = 0, mu = 0, mv = 0;
  for (let i = start; i < start + count; i++) {
    const o = i * stride;
    mx += v[o + posOff];
    mz += v[o + posOff + 2];
    mu += v[o + uvOff];
    mv += v[o + uvOff + 1];
  }
  mx /= count; mz /= count; mu /= count; mv /= count;
  let sxx = 0, sxu = 0, szz = 0, szv = 0;
  for (let i = start; i < start + count; i++) {
    const o = i * stride;
    const dx = v[o + posOff] - mx;
    const dz = v[o + posOff + 2] - mz;
    sxx += dx * dx;
    sxu += dx * (v[o + uvOff] - mu);
    szz += dz * dz;
    szv += dz * (v[o + uvOff + 1] - mv);
  }
  if (!(sxx > 1e-9) || !(szz > 1e-9)) return null;
  const a = sxu / sxx;
  const c = szv / szz;
  const b = mu - a * mx;
  const d = mv - c * mz;
  let residual = 0;
  for (let i = start; i < start + count; i++) {
    const o = i * stride;
    residual = Math.max(residual, Math.abs(a * v[o + posOff] + b - v[o + uvOff]), Math.abs(c * v[o + posOff + 2] + d - v[o + uvOff + 1]));
  }
  return { proj: [a, b, c, d], residual };
}

/** One lightmapped Track.qm patch as the projection lookup sees it (three space, the track object's local frame). */
export interface LightmapPatch {
  /** XZ cell and height range of the patch's vertices. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
  proj: LightmapProjection;
  /** Lightmap texId (P8 .rtex) or null (the engine's texture/white). */
  lightmap: string | null;
}

/** The patch under a point: XZ inside its cell, the height range picking between stacked patches (bridges). */
export class LightmapPatches {
  readonly patches: readonly LightmapPatch[];

  constructor(patches: readonly LightmapPatch[]) {
    this.patches = patches;
  }

  /** Index of the patch under (x, y, z) or −1. `hint` = the last result (checked first). */
  find(x: number, y: number, z: number, hint = -1): number {
    const P = this.patches;
    const inXZ = (p: LightmapPatch) => x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1;
    const inY = (p: LightmapPatch) => y >= p.y0 - 3 && y <= p.y1 + 3;
    if (hint >= 0 && hint < P.length && inXZ(P[hint]) && inY(P[hint])) return hint;
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (!inXZ(p)) continue;
      if (inY(p)) return i;
      const gap = y < p.y0 ? p.y0 - y : y - p.y1;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    return best;
  }
}

/** uv of world (x, z) under a projection, clamped to [0, 1] (the lightmap stage is CLAMP). */
export function projectLightmapUv(p: LightmapProjection, x: number, z: number): [number, number] {
  const u = p[0] * x + p[1];
  const v = p[2] * z + p[3];
  return [u < 0 ? 0 : u > 1 ? 1 : u, v < 0 ? 0 : v > 1 ? 1 : v];
}

/** Nearest texel of an 8-bit index plane (row 0 = top, like the `.rtex` levels) at clamped uv. */
export function sampleIndex(data: Uint8Array, width: number, height: number, u: number, v: number): number {
  const px = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
  const py = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
  return data[py * width + px];
}
