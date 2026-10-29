/**
 * src/render/heightSampler.ts — THREE-space height lookups on a Stage heightfield (render builder).
 *
 * Matches the triangulation used by terrain.ts (each cell split along the (ix, iz) → (ix+1, iz+1)
 * diagonal), so shoulders, decals and the flipped-car camera sit exactly on the rendered ground.
 */
import type { Heightfield } from '../core/types';

export class HeightSampler {
  readonly hf: Heightfield;
  /** Optional render-only offsets (terrain lowered under the road); same indexing as hf.heights. */
  heights: Float32Array;

  constructor(hf: Heightfield, heights?: Float32Array) {
    this.hf = hf;
    this.heights = heights ?? hf.heights;
  }

  /** Height (three y) at three-space (x, z); clamped to the heightfield edges outside it. */
  heightAt(x: number, z: number): number {
    const { originX, originZ, cellSize, nx, nz } = this.hf;
    const h = this.heights;
    if (nx < 2 || nz < 2) return h.length ? h[0] : 0;
    let fx = (x - originX) / cellSize;
    let fz = (z - originZ) / cellSize;
    fx = Math.min(nx - 1.000001, Math.max(0, fx));
    fz = Math.min(nz - 1.000001, Math.max(0, fz));
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const i00 = iz * nx + ix;
    const h00 = h[i00], h10 = h[i00 + 1], h01 = h[i00 + nx], h11 = h[i00 + nx + 1];
    // diagonal (0,0)-(1,1): triangle A = (00, 11, 10) when tx >= tz, triangle B = (00, 01, 11) otherwise
    if (tx >= tz) return h00 + (h10 - h00) * tx + (h11 - h10) * tz;
    return h00 + (h11 - h01) * tx + (h01 - h00) * tz;
  }

  /** Material id at the nearest vertex. */
  materialAt(x: number, z: number): number {
    const { originX, originZ, cellSize, nx, nz, materials } = this.hf;
    const ix = Math.min(nx - 1, Math.max(0, Math.round((x - originX) / cellSize)));
    const iz = Math.min(nz - 1, Math.max(0, Math.round((z - originZ) / cellSize)));
    return materials[iz * nx + ix];
  }
}
