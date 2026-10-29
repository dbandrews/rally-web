/**
 * src/world/terrainGen.ts — builds the stage heightfield: natural terrain from noise, then "earthworks"
 * that carve it to the road (road bed under the ribbon, shoulders, ditches, snow berms, cut and fill
 * slopes), then per-vertex materials.
 *
 * Invariant used by the physics: every terrain vertex that can belong to a triangle overlapping the road
 * ribbon lies BELOW the ribbon (≥ 4 cm under the edges, `underDepth` under the surface), so the ribbon is
 * always the top surface on the road and the ground is single-valued.
 */
import { MATERIAL_NONE } from '../core/constants';
import type { Heightfield } from '../core/types';
import type { RoadModel } from './road';

export interface CarveOptions {
  /** Cut slope (rise per metre) and fill slope (drop per metre) of the earthworks. */
  cutSlope: number;
  fillSlope: number;
  /** Ditch depth (m) and width (m), starting `ditchStart` m beyond the edge, only in cuts. */
  ditchDepth: number;
  ditchWidth: number;
  ditchStart: number;
  /** Optional snow / earth berm: height(s, side) m above the edge, from bermStart over bermWidth m. */
  berm?: { height: (s: number, side: number) => number; start: number; width: number };
  /** Influence distance beyond the edge (m); natural terrain beyond it. */
  rInf: number;
  /** Depth of the road bed under the ribbon (m). */
  underDepth: number;
  /** Per-segment override: true = skip earthworks (only the road bed clamp), e.g. testpad. */
  flat?: boolean;
}

export interface MaterialContext {
  x: number;
  z: number;
  h: number;
  /** Ground slope (rise per metre) at the vertex. */
  slope: number;
  /** Signed distance beyond the nearest road edge (m; < 0 under the road); 1e9 if far. */
  e: number;
  /** Material of the nearest road sample (or MATERIAL_NONE if far). */
  roadMat: number;
  /** s of the nearest road point (or -1 if far), side (+1 right / -1 left). */
  s: number;
  side: number;
  /** Natural (uncarved) height and noise helpers are up to the stage. */
  nat: number;
}

export interface TerrainSpec {
  originX: number;
  originZ: number;
  cellSize: number;
  nx: number;
  nz: number;
  natural: (x: number, z: number) => number;
  carve: CarveOptions | null;
  material: (c: MaterialContext) => number;
}

export interface TerrainResult {
  hf: Heightfield;
  /** Per vertex: signed distance beyond the nearest road edge (1e9 = far). */
  edgeDist: Float32Array;
  /** Per vertex: s of the nearest road point (-1 = far). */
  nearS: Float32Array;
  /** Per vertex: natural height (before carving). */
  natural: Float32Array;
}

const FAR = 1e9;

export function buildTerrain(spec: TerrainSpec, road: RoadModel): TerrainResult {
  const { nx, nz, cellSize: cs, originX: ox, originZ: oz } = spec;
  const N = nx * nz;
  const nat = new Float32Array(N);
  for (let iz = 0; iz < nz; iz++) {
    const z = oz + iz * cs;
    for (let ix = 0; ix < nx; ix++) nat[iz * nx + ix] = spec.natural(ox + ix * cs, z);
  }
  const carve = spec.carve;
  const rInf = carve ? carve.rInf : 12;
  const eS = cs * 1.45; // shoulder zone: every triangle touching the ribbon has its vertices within this

  const Ucone = new Float64Array(N).fill(Infinity);
  const Lcone = new Float64Array(N).fill(-Infinity);
  // edge distance of the segment that set each bound (for continuous conflict resolution)
  const eU = new Float32Array(N);
  const eL = new Float32Array(N);
  const foot = new Float64Array(N).fill(Infinity);
  const nearE = new Float64Array(N).fill(FAR);
  const nearSeg = new Int32Array(N).fill(-1);
  const nearT = new Float32Array(N);
  const nearSide = new Int8Array(N);
  const nearEdgeY = new Float64Array(N);

  const S = road.segCount;
  const cut = carve ? carve.cutSlope : 0;
  const fill = carve ? carve.fillSlope : 0;
  const under = carve ? carve.underDepth : 0;
  const eC = carve ? Math.max(eS, carve.ditchStart + carve.ditchWidth) : eS;
  const fadeStart = rInf - 12;
  for (let k = 0; k < S; k++) {
    const a = k, b = k + 1;
    const ax = road.cx[a], az = road.cz[a];
    const dx = road.cx[b] - ax, dz = road.cz[b] - az;
    const l2 = dx * dx + dz * dz;
    const l = Math.sqrt(l2) || 1;
    const rxh = -dz / l, rzh = dx / l;
    const hwA = road.hw[a], hwB = road.hw[b];
    const reach = Math.max(hwA, hwB) + rInf;
    const x0 = Math.min(ax, road.cx[b]) - reach;
    const x1 = Math.max(ax, road.cx[b]) + reach;
    const z0 = Math.min(az, road.cz[b]) - reach;
    const z1 = Math.max(az, road.cz[b]) + reach;
    const ix0 = Math.max(0, Math.floor((x0 - ox) / cs));
    const ix1 = Math.min(nx - 1, Math.ceil((x1 - ox) / cs));
    const iz0 = Math.max(0, Math.floor((z0 - oz) / cs));
    const iz1 = Math.min(nz - 1, Math.ceil((z1 - oz) / cs));
    const yA = road.cy[a], yB = road.cy[b];
    const ylA = road.ly[a], ylB = road.ly[b], yrA = road.ry[a], yrB = road.ry[b];
    for (let iz = iz0; iz <= iz1; iz++) {
      const pz = oz + iz * cs;
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = ox + ix * cs;
        let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const cxp = ax + dx * t, czp = az + dz * t;
        const qx = px - cxp, qz = pz - czp;
        const d = Math.sqrt(qx * qx + qz * qz);
        const lat = qx * rxh + qz * rzh;
        const side = lat >= 0 ? 1 : -1;
        const hw = hwA + (hwB - hwA) * t;
        const e = d - hw;
        if (e > rInf) continue;
        const i = iz * nx + ix;
        const yEdge = side > 0 ? yrA + (yrB - yrA) * t : ylA + (ylB - ylA) * t;
        if (e < nearE[i]) {
          nearE[i] = e;
          nearSeg[i] = k;
          nearT[i] = t;
          nearSide[i] = side;
          nearEdgeY[i] = yEdge;
        }
        if (e < 0) {
          const yc = yA + (yB - yA) * t;
          const surf = yc + (yEdge - yc) * Math.min(1, d / Math.max(1e-6, hw));
          const v = surf - under;
          if (v < foot[i]) foot[i] = v;
        } else if (e < eS) {
          const v = yEdge - 0.04 - 0.06 * e;
          if (v < foot[i]) foot[i] = v;
        }
        if (!carve || carve.flat) continue;
        const fade = e > fadeStart ? 10 * (e - fadeStart) : 0;
        const ee = e > 0 ? e : 0;
        const u = yEdge - 0.04 - 0.06 * Math.min(ee, eS) + (ee > eC ? cut * (ee - eC) : 0) + fade;
        if (u < Ucone[i]) {
          Ucone[i] = u;
          eU[i] = ee;
        }
        const lo = yEdge - 0.04 - 0.06 * Math.min(ee, eS) - (ee > eS ? fill * (ee - eS) : 0) - fade;
        if (lo > Lcone[i]) {
          Lcone[i] = lo;
          eL[i] = ee;
        }
      }
    }
  }

  // ---- pass 2: detail profile from the nearest road point, conflict resolution, road-bed clamp
  const heights = new Float32Array(N);
  // berms must start outside the shoulder zone so they never poke through the ribbon
  const bermStart = carve && carve.berm ? Math.max(carve.berm.start, eS + 0.2) : 0;
  const nearS = new Float32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    let h = nat[i];
    const k = nearSeg[i];
    if (k >= 0) nearS[i] = road.s[k] + (road.s[k + 1] - road.s[k]) * nearT[i];
    if (carve && !carve.flat && k >= 0) {
      const e = Math.max(0, nearE[i]);
      const yEdge = nearEdgeY[i];
      const U = Ucone[i];
      const L = Lcone[i];
      // cut / fill cones. A single road section always has L <= U; L > U means two different sections
      // (stacked hairpin legs) disagree: blend by distance so the slope between them stays continuous.
      if (L <= U) h = h < L ? L : h > U ? U : h;
      else {
        const den = eL[i] + eU[i];
        const w = den > 1e-6 ? eU[i] / den : 0.5;
        h = U + (L - U) * w;
      }
      // ditch, only where the ground is cut (natural above the shoulder), faded in over 0.4 m
      const shoulder = yEdge - 0.04 - 0.06 * Math.min(e, eS);
      if (carve.ditchDepth > 0 && e > carve.ditchStart && e < carve.ditchStart + carve.ditchWidth) {
        const w = Math.sin((Math.PI * (e - carve.ditchStart)) / carve.ditchWidth);
        const cutF = Math.min(1, Math.max(0, (nat[i] - shoulder) / 0.4));
        const bottom = shoulder - carve.ditchDepth * w * cutF;
        if (h > bottom) h = bottom;
      }
      // berm (raises the ground)
      if (carve.berm && e > bermStart && e < bermStart + carve.berm.width) {
        const bh = carve.berm.height(nearS[i], nearSide[i]);
        if (bh > 0) {
          const top = yEdge + bh * Math.sin((Math.PI * (e - bermStart)) / carve.berm.width);
          if (h < top) h = top;
        }
      }
    }
    if (carve && h > foot[i]) h = foot[i];
    heights[i] = h;
  }

  // ---- materials
  const materials = new Uint8Array(N).fill(MATERIAL_NONE);
  const ctx: MaterialContext = { x: 0, z: 0, h: 0, slope: 0, e: FAR, roadMat: MATERIAL_NONE, s: -1, side: 1, nat: 0 };
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const hl = heights[iz * nx + Math.max(0, ix - 1)];
      const hr = heights[iz * nx + Math.min(nx - 1, ix + 1)];
      const hd = heights[Math.max(0, iz - 1) * nx + ix];
      const hu = heights[Math.min(nz - 1, iz + 1) * nx + ix];
      ctx.x = ox + ix * cs;
      ctx.z = oz + iz * cs;
      ctx.h = heights[i];
      ctx.slope = Math.hypot(hr - hl, hu - hd) / (2 * cs);
      const k = nearSeg[i];
      ctx.e = nearE[i];
      ctx.s = nearS[i];
      ctx.side = nearSide[i] || 1;
      ctx.nat = nat[i];
      ctx.roadMat = k >= 0 ? (nearT[i] < 0.5 ? road.mat[k] : road.mat[k + 1]) : MATERIAL_NONE;
      materials[i] = spec.material(ctx);
    }
  }
  const edgeDist = new Float32Array(N);
  for (let i = 0; i < N; i++) edgeDist[i] = nearE[i];
  return {
    hf: { originX: ox, originZ: oz, cellSize: cs, nx, nz, heights, materials },
    edgeDist,
    nearS,
    natural: nat,
  };
}
