/**
 * src/world/stageDefs.ts — the stage catalogue: one recipe per stage (all names original).
 *
 *   pine-ridge   Pine Ridge      muddy forest rally, ~3.6 km timed, crests, a jump, a water splash, a switchback pair
 *   col-du-vent  Col du Vent     tarmac hillclimb, ~2.4 km timed, six legs and five hairpins up an exposed slope
 *   frostvale    Frostvale       snow rally, ~3.1 km timed, snow berms, ice patches
 *   red-basin    Red Basin       desert rally, ~3.6 km timed, wide sand with tarmac and gravel stretches, three jumps
 *   kettle-park  Kettle Park     rallycross, ~1.0 km lap, tarmac + gravel, a tabletop jump, 3 laps
 *   lake-skoga   Lake Skoga      ice racing on a frozen lake, ~1.4 km lap of 60-95 m sweepers, snowbanks, 4 laps
 *   testpad      Proving Ground  flat tarmac pad: surface patches, slalom, crest + kicker, banked bowl
 */
// approxLength (menu) = the TIMED distance: start line to finish (point-to-point) or one lap (closed), seed 1;
// the HUD shows the same quantity (src/ui/hud.ts timedLength).
//
// Road surfaces follow the original's stage materials (docs/MECHANICS_SPEC.md §4.3, v1.3): the per-face material
// bytes of the original's collision meshes put its loose RALLY stages on SAND (the desert rally) and MUD (the forest
// rally), not on GRAVEL; GRAVEL is the road of the gravel hill climbs and of the rallycross gravel. So Pine Ridge
// runs on 'mud' (original forest stages: 98-100 % MUD) and Red Basin on 'sand' (original desert stages: ≈ 78 %
// SAND, 14 % ASPHALT, 8 % GRAVEL). Kettle Park keeps tarmac + gravel (original rallycross: 62 % GRAVEL, 38 % ASPHALT).
import { MATERIAL, SURFACE_INFO } from '../core/constants';
import { hashSeed } from '../core/rng';
import type { StageListEntry, SurfaceId } from '../core/types';
import {
  centerlineDistanceField,
  pickSpread,
  sectionMaterials,
  straightSpots,
  type BuildContext,
  type ProcRecipe,
  type StageLabel,
  type StageMeta,
} from './builder';
import { hillclimbLayout, loopFromFeatures, loopLayout, rallyLayout, type LoopTemplate, type RallyStyle } from './layouts';
import { Noise1D, Noise2D } from './noise';
import type { ElevationFeature } from './profile';
import { alongRoadRotY, chevronRotY, type KindSpec, type SceneryPlacer } from './scenery';
import type { PathFeature } from './spline';

const DEG = Math.PI / 180;
const M = MATERIAL;
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const META: Readonly<Record<string, StageMeta>> = Object.freeze({
  'pine-ridge': {
    id: 'pine-ridge', name: 'Pine Ridge', discipline: 'rally', closed: false, laps: 1, defaultTyre: 2, approxLength: 3610, env: 'pineRidge',
    description: 'Fast, muddy forest tracks through rolling pines: blind crests, a jump, a water splash and a switchback pair.',
  },
  'col-du-vent': {
    id: 'col-du-vent', name: 'Col du Vent', discipline: 'hillclimb', closed: false, laps: 1, defaultTyre: 0, approxLength: 2420, env: 'colDuVent',
    description: 'Narrow tarmac hillclimb up an exposed mountainside: six legs, five hairpins and long drops.',
  },
  'frostvale': {
    id: 'frostvale', name: 'Frostvale', discipline: 'rally', closed: false, laps: 1, defaultTyre: 3, approxLength: 3080, env: 'frostvale',
    description: 'Packed snow between banked drifts, with glassy ice patches waiting in the shade.',
  },
  'red-basin': {
    id: 'red-basin', name: 'Red Basin', discipline: 'rally', closed: false, laps: 1, defaultTyre: 2, approxLength: 3630, env: 'redBasin',
    description: 'Wide, fast desert tracks of loose sand, with tarmac and gravel stretches and big jumps over the dry washes.',
  },
  'kettle-park': {
    id: 'kettle-park', name: 'Kettle Park', discipline: 'rallycross', closed: true, laps: 3, defaultTyre: 1, approxLength: 1040, env: 'kettlePark',
    description: 'Rallycross circuit of tarmac and gravel with a tabletop jump on the back straight. 3 laps.',
  },
  'lake-skoga': {
    id: 'lake-skoga', name: 'Lake Skoga', discipline: 'ice', closed: true, laps: 4, defaultTyre: 4, approxLength: 1400, env: 'lakeSkoga',
    description: 'Ice racing on a frozen lake, lined with snowbanks. 4 laps.',
  },
  'testpad': {
    id: 'testpad', name: 'Proving Ground', discipline: 'testpad', closed: true, laps: 1, defaultTyre: 0, approxLength: 1880, env: 'testpad',
    description: 'Open tarmac pad for handling work: surface patches, cone slalom, crest and kicker ramp, banked bowl.',
  },
});

/** Catalogue order (first = default stage). */
export const STAGE_ORDER = ['pine-ridge', 'col-du-vent', 'frostvale', 'red-basin', 'kettle-park', 'lake-skoga', 'testpad'] as const;

export function catalogueEntry(id: string): StageListEntry {
  const m = META[id];
  return {
    id: m.id,
    name: m.name,
    discipline: m.discipline,
    description: m.description,
    defaultTyre: m.defaultTyre,
    approxLength: m.approxLength,
    closed: m.closed,
    laps: m.laps,
  };
}

// ------------------------------------------------------------------------------------------- shared bits

const PINES: KindSpec[] = [
  { kind: 'pine', w: 8, radius: [0.32, 0.5], height: [11, 22] },
  { kind: 'tree', w: 1.2, radius: [0.45, 0.65], height: [8, 13] },
  { kind: 'deadTree', w: 0.3, radius: [0.25, 0.35], height: [6, 10] },
  { kind: 'bush', w: 1.6, radius: [0, 0], height: [0.8, 1.8] },
  { kind: 'rock', w: 0.5, radius: [0.5, 0.9], height: [0.6, 1.2] },
];

/** rotY that turns an object's -Z (front) toward the road centre at s. */
const faceRoad = (ctx: BuildContext, s: number, x: number, z: number): number => {
  const c = ctx.cl.pointAt(s);
  return Math.atan2(-(c.x - x), -(c.z - z));
};

/** Start / finish furniture common to point-to-point stages. */
function startFinish(p: SceneryPlacer, ctx: BuildContext, tent = true): void {
  const { startS, finishS, rng } = ctx;
  p.gate('startGate', startS);
  p.gate('finishGate', finishS);
  for (const side of [-1, 1]) {
    p.line({ kind: 'banner', from: startS - 28, to: startS - 4, every: 8, e: 2.2, side, height: 2.5, along: true });
    p.line({ kind: 'banner', from: finishS - 20, to: finishS + 16, every: 9, e: 2.2, side, height: 2.5, along: true });
  }
  if (tent) {
    for (let i = 0; i < 3; i++) {
      const pt = p.sidePoint(startS - 20 - i * 9, i % 2 ? 1 : -1, rng.range(10, 14));
      p.tryPlace('tent', pt.x, pt.z, 2.2, 3, faceRoad(ctx, startS, pt.x, pt.z), { clear: 4 });
    }
  }
  p.crowd(startS + 12, -1, 8, 7, 12);
  p.crowd(finishS + 10, 1, 8, 8, 13);
}

/** Hairpin chevrons on the outside and don't-cut rocks on the inside of some medium corners. */
function cornerFurniture(p: SceneryPlacer, ctx: BuildContext, rockChance: number): void {
  const { rng, startS, finishS } = ctx;
  for (const c of ctx.corners) {
    if (c.s0 < startS + 10 || c.s1 > finishS - 10) continue;
    if (c.hairpin || c.severity <= 2) {
      for (const k of [-9, 0, 9]) {
        const pt = p.sidePoint(c.apexS + k, -c.dir, 4.4);
        // chevron boards across the line of travel, arrows pointing into the bend
        p.tryPlace('marker', pt.x, pt.z, 0.12, 1.5, chevronRotY(pt.hx, pt.hz, c.dir), { clear: 3, spacing: 0.2 });
      }
    }
    if (!c.hairpin && c.severity >= 3 && c.severity <= 5 && c.angle > 30 * DEG && rng.next() < rockChance) {
      let placed = 0;
      for (const k of [-10, -3, 5]) {
        const r = rng.range(0.6, 0.95);
        const pt = p.sidePoint(c.apexS + k + rng.range(-2, 2), c.dir, 3.15 + r + rng.range(0, 1.2));
        if (p.tryPlace('rock', pt.x, pt.z, r, rng.range(0.6, 1.0), rng.next() * 6.28, { clear: 3, spacing: 0.3 })) placed++;
      }
      if (placed > 0) c.dontCut = true;
    }
  }
}

/** Straight stretches for features, relaxing the straightness requirement until some are found. */
function spotsFor(ctx: BuildContext, half: number, from: number, to: number, want: number): number[] {
  const tries: [number, number][] = [[half, 1 / 450], [half * 0.8, 1 / 300], [half * 0.65, 1 / 200], [half * 0.5, 1 / 120]];
  let best: number[] = [];
  for (const [h, k] of tries) {
    const s = straightSpots(ctx.cl, h, from, to, k);
    if (s.length > best.length) best = s;
    if (s.length >= want * 25) break;
  }
  return best;
}

function rallyFeatures(ctx: BuildContext, o: { crests: number; jumps: number; water: number; jumpH: [number, number] }): ElevationFeature[] {
  const { rng, startS, finishS } = ctx;
  const jumps = pickSpread(rng, spotsFor(ctx, 55, startS + 300, finishS - 200, o.jumps), o.jumps, 450);
  const water = pickSpread(rng, spotsFor(ctx, 28, startS + 350, finishS - 250, o.water), o.water, 400, jumps);
  const crests = pickSpread(rng, spotsFor(ctx, 32, startS + 150, finishS - 120, o.crests), o.crests, 320, [...jumps, ...water]);
  const f: ElevationFeature[] = [];
  for (const s of crests) f.push({ kind: 'crest', s, h: rng.range(1.6, 2.6), before: rng.range(28, 38), after: rng.range(28, 40) });
  for (const s of jumps) f.push({ kind: 'jump', s, h: rng.range(o.jumpH[0], o.jumpH[1]), before: rng.range(16, 20), after: rng.range(24, 30) });
  for (const s of water) f.push({ kind: 'dip', s, h: 0.7, before: 20, after: 20, tag: 'water' });
  return f.sort((a, b) => a.s - b.s);
}

// ------------------------------------------------------------------------------------------- Pine Ridge

function pineRidge(): ProcRecipe {
  const style: RallyStyle = {
    length: 3600, runIn: 140, runOut: 110,
    straight: [15, 80], longStraightProb: 0.1, longStraight: [150, 260],
    corners: [
      { w: 2, R: [120, 300], ang: [20, 50] },
      { w: 3.5, R: [55, 120], ang: [35, 90] },
      { w: 2.5, R: [30, 55], ang: [50, 110] },
      { w: 1, R: [18, 30], ang: [70, 120] },
    ],
    chicaneProb: 0.3, intoProb: 0.3,
    switchbacks: 1, hairpinR: [11, 14], switchLeg: [70, 120], switchDiverge: [18, 28],
    totalTurn: [150, 260], meanderAmp: 70, meanderPeriod: 900, maxDev: 75,
  };
  let mat: Noise2D | null = null;
  let hamlet: { from: number; to: number } | null = null;
  return {
    meta: META['pine-ridge'],
    layout: (rng) => rallyLayout(rng, style),
    layoutLimits: { minRadius: 10, farClear: 55, maxArea: 1.8e6 },
    natural: (seed) => {
      const n = new Noise2D(seed);
      return (x, z) => 26 * n.fbm(x / 700, z / 700, 4) + 7 * n.fbm(x / 170 + 11, z / 170 - 7, 3) + 1.0 * n.fbm(x / 30, z / 30, 2);
    },
    profile: { sigma: 28, gradeMax: 0.1, hairpinGrade: 0.06 },
    width: { base: 7.4, vary: 0.5, hairpinWiden: 2 },
    crown: (s) => (s === 'water' ? 0.02 : 0.09),
    bank: { gain: 2, max: 0.05 },
    features: (ctx) => rallyFeatures(ctx, { crests: 4, jumps: 1, water: 1, jumpH: [1.4, 1.7] }),
    surfaces: (ctx) => {
      // Original forest rally stages: 98-100 % MUD on the road (§4.3 v1.3), plus a wet splash (WATERASPHALT, as in
      // one of the reverse stages). No tarmac or deep-gravel sections: the hamlet sits on the mud road.
      const { cl, rng } = ctx;
      const L = cl.length;
      const t0 = L * rng.range(0.38, 0.5);
      hamlet = { from: t0, to: t0 + rng.range(170, 250) };
      const secs: { from: number; to: number; surface: SurfaceId }[] = [];
      for (const f of ctx.features) if (f.tag === 'water') secs.push({ from: f.s - 7, to: f.s + 7, surface: 'water' });
      return sectionMaterials(cl, 'mud', secs);
    },
    carve: () => ({ cutSlope: 1.0, fillSlope: 0.75, ditchDepth: 0.45, ditchWidth: 2.2, ditchStart: 0.6, rInf: 40, underDepth: 0.15 }),
    margin: 140,
    material: (c, ctx) => {
      mat ??= new Noise2D(hashSeed('pine-mat') ^ ctx.seed);
      if (c.e < 0) return c.roadMat;
      if (c.e < 0.9) return c.roadMat === M.water ? M.mud : c.roadMat;
      if (c.slope > 0.85) return M.gravel;
      if (c.e < 4 && c.h < c.nat - 0.15 && mat.perlin(c.x / 9, c.z / 9) > 0.15) return M.mud;
      if (mat.fbm(c.x / 70, c.z / 70, 2) > 0.42) return M.mud;
      return M.grass;
    },
    scenery: (p, ctx) => {
      startFinish(p, ctx);
      const { rng } = ctx;
      // hamlet along the stretch picked in surfaces()
      if (hamlet) {
        const a = hamlet.from, b = Math.min(ctx.cl.length, hamlet.to);
        let side = 1;
        for (let s = a + 15; s < b - 10; s += rng.range(28, 40)) {
          const pt = p.sidePoint(s, side, rng.range(10, 15));
          p.tryPlace(rng.next() < 0.2 ? 'barn' : 'house', pt.x, pt.z, 4.8, 7, faceRoad(ctx, s, pt.x, pt.z), { clear: 5, spacing: 2 });
          side = -side;
        }
        p.line({ kind: 'fence', from: a, to: b, every: 4, e: 3.5, side: 1, height: 1.1, along: true });
      }
      cornerFurniture(p, ctx, 0.35);
      for (const c of ctx.corners) if (c.hairpin) p.crowd(c.apexS, c.dir, 10, 8, 14);
      for (const f of ctx.features) if (f.kind === 'jump') {
        p.crowd(f.s + 18, 1, 7, 9, 15);
        p.crowd(f.s + 18, -1, 7, 9, 15);
      }
      p.line({ kind: 'post', from: ctx.startS + 30, to: ctx.finishS - 30, every: 45, e: 1.3, side: 'alternate', height: 1.2 });
      p.scatter({ kinds: PINES, density: 21, band: [3, 70], outer: 0.35, spacing: 1.4, fastExtra: 3.5 });
      p.scatter({ kinds: [{ kind: 'pine', w: 1, radius: [0.4, 0.55], height: [16, 26] }], density: 4, band: [70, 160], outer: 0.5, spacing: 2 });
    },
    pacenotes: true,
  };
}

// ------------------------------------------------------------------------------------------- Col du Vent

function colDuVent(): ProcRecipe {
  let mat: Noise2D | null = null;
  const dropAt = (ctx: BuildContext, s: number, side: number): number => {
    if (!ctx.ground) return 0;
    const c = ctx.cl.pointAt(s);
    const hx = ctx.cl.sample(ctx.cl.hx, s), hz = ctx.cl.sample(ctx.cl.hz, s);
    const off = ctx.hwAt(s) + 12;
    const x = c.x - hz * off * side, z = c.z + hx * off * side;
    return c.y - ctx.ground.height(x, z);
  };
  return {
    meta: META['col-du-vent'],
    layout: (rng) =>
      hillclimbLayout(rng, {
        legs: 6, legLen: [330, 420], alpha: 12.5, hairpinR: [11, 13.5], bendsPerLeg: 1,
        bendR: [70, 160], bendAng: [16, 34], runIn: 110, runOut: 110,
      }),
    layoutLimits: { minRadius: 10, farClear: 38, maxArea: 1.3e6 },
    natural: (seed, cl) => {
      const n = new Noise2D(seed);
      // mountain slope toward -Z, as steep as the zig-zag can climb at ~10.5 % along the road
      const rise = Math.max(1, cl.z[0] - cl.minZ);
      const G = Math.min(0.55, Math.max(0.25, (0.105 * cl.length) / rise));
      const z0 = cl.z[0];
      return (x, z) => G * (z0 - z) + 14 * (n.ridged(x / 320, z / 320, 3) - 0.5) + 4 * n.fbm(x / 90, z / 90, 3) + 0.8 * n.fbm(x / 20, z / 20, 2);
    },
    profile: { sigma: 16, gradeMax: 0.135, hairpinGrade: 0.07 },
    width: { base: 6.6, vary: 0.3, hairpinWiden: 2.5 },
    crown: (s) => (s === 'cobbles' ? 0.04 : 0.05),
    bank: { gain: 1.5, max: 0.06 },
    features: () => [],
    surfaces: (ctx) => {
      const L = ctx.cl.length;
      const a = L * ctx.rng.range(0.78, 0.86);
      return sectionMaterials(ctx.cl, 'tarmac', [{ from: a, to: a + ctx.rng.range(100, 140), surface: 'cobbles' }]);
    },
    carve: () => ({ cutSlope: 1.6, fillSlope: 1.3, ditchDepth: 0.3, ditchWidth: 1.4, ditchStart: 0.5, rInf: 45, underDepth: 0.15 }),
    margin: 200,
    material: (c, ctx) => {
      mat ??= new Noise2D(hashSeed('col-mat') ^ ctx.seed);
      if (c.e < 0) return c.roadMat;
      if (c.e < 1.0) return M.gravel;
      if (c.slope > 0.95) return M.gravel;
      if (c.slope > 0.55 && mat.perlin(c.x / 14, c.z / 14) > -0.1) return M.gravel;
      return M.grass;
    },
    exposed: (s, side, ctx) => dropAt(ctx, s, side) > 4.5,
    scenery: (p, ctx) => {
      startFinish(p, ctx);
      const { rng } = ctx;
      // white posts along the drop side, barriers around the hairpins
      for (let s = ctx.startS + 10; s < ctx.finishS; s += 14) {
        for (const side of [-1, 1]) {
          if (dropAt(ctx, s, side) > 4) {
            const pt = p.sidePoint(s, side, 0.9);
            p.tryPlace('post', pt.x, pt.z, 0, 1.0, 0, { visualR: 0.1 });
          }
        }
      }
      for (const c of ctx.corners) {
        if (!c.hairpin) continue;
        p.line({ kind: 'barrier', from: c.apexS - 26, to: c.apexS + 26, every: 4, e: 1.0, side: -c.dir, height: 1.0, along: true });
        p.crowd(c.apexS, c.dir, 9, 7, 12);
      }
      cornerFurniture(p, ctx, 0.15);
      // village on the cobbles
      for (let i = 1; i < ctx.cl.n; i++) {
        if (ctx.material[i] === M.cobbles && ctx.material[i - 1] !== M.cobbles) {
          let j = i;
          while (j < ctx.cl.n && ctx.material[j] === M.cobbles) j++;
          for (let s = i * ctx.cl.ds; s < j * ctx.cl.ds; s += 22) {
            for (const side of [-1, 1]) {
              const pt = p.sidePoint(s + rng.range(-4, 4), side, rng.range(8, 12));
              p.tryPlace('house', pt.x, pt.z, 4.5, 8, faceRoad(ctx, s, pt.x, pt.z), { clear: 4, spacing: 1.5, maxSlope: 0.6 });
            }
          }
        }
      }
      p.scatter({ kinds: [{ kind: 'rock', w: 2, radius: [0.5, 1.0], height: [0.6, 1.4] }, { kind: 'boulder', w: 1, radius: [1.2, 2.2], height: [2, 3.5] }], density: 3, band: [3.5, 60], outer: 0.6, spacing: 1, maxSlope: 3 });
      p.scatter({ kinds: [{ kind: 'pine', w: 4, radius: [0.32, 0.48], height: [9, 18] }, { kind: 'bush', w: 2, radius: [0, 0], height: [0.6, 1.4] }], density: 6, band: [5, 140], outer: 0.5, spacing: 2, maxSlope: 0.8 });
    },
    pacenotes: true,
  };
}

// ------------------------------------------------------------------------------------------- Frostvale

function frostvale(): ProcRecipe {
  const style: RallyStyle = {
    length: 3100, runIn: 140, runOut: 110,
    straight: [20, 90], longStraightProb: 0.12, longStraight: [150, 240],
    corners: [
      { w: 2.5, R: [110, 300], ang: [20, 50] },
      { w: 3.5, R: [55, 110], ang: [35, 90] },
      { w: 2, R: [32, 55], ang: [45, 105] },
      { w: 0.7, R: [20, 30], ang: [70, 120] },
    ],
    chicaneProb: 0.25, intoProb: 0.25,
    switchbacks: 0, hairpinR: [12, 14], switchLeg: [70, 110], switchDiverge: [18, 26],
    totalTurn: [120, 220], meanderAmp: 65, meanderPeriod: 1000, maxDev: 75,
  };
  let berm: Noise1D | null = null;
  let cell = 2;
  // berm band: at least ~2 grid cells wide so the heightfield samples its profile evenly
  let bermW = 3.2;
  const bermH = (s: number, side: number): number => Math.max(0, 0.6 + 0.5 * (berm ? berm.at(s / 45 + (side > 0 ? 200 : 0)) : 0));
  return {
    meta: META['frostvale'],
    layout: (rng) => rallyLayout(rng, style),
    layoutLimits: { minRadius: 12, farClear: 55, maxArea: 2.2e6 },
    natural: (seed) => {
      const n = new Noise2D(seed);
      berm = new Noise1D(seed ^ 0x5a5a);
      return (x, z) => 18 * n.fbm(x / 600, z / 600, 4) + 5 * n.fbm(x / 140 + 3, z / 140, 3) + 0.8 * n.fbm(x / 25, z / 25, 2);
    },
    profile: { sigma: 30, gradeMax: 0.08, hairpinGrade: 0.05 },
    width: { base: 7.6, vary: 0.5, hairpinWiden: 2 },
    crown: (s) => (s === 'ice' ? 0.03 : 0.06),
    bank: { gain: 2, max: 0.05 },
    features: (ctx) => rallyFeatures(ctx, { crests: 3, jumps: 0, water: 0, jumpH: [1.2, 1.4] }),
    surfaces: (ctx) => {
      const { cl, rng, startS, finishS } = ctx;
      const cands: number[] = [];
      for (let s = startS + 200; s < finishS - 120; s += 5) cands.push(s);
      const at = pickSpread(rng, cands, rng.int(5, 7), 260);
      return sectionMaterials(cl, 'snow', at.map((s) => ({ from: s, to: s + rng.range(25, 60), surface: 'ice' as SurfaceId })));
    },
    carve: (cs) => {
      cell = cs;
      bermW = Math.max(3.2, 2.2 * cs);
      return { cutSlope: 0.9, fillSlope: 0.7, ditchDepth: 0, ditchWidth: 1, ditchStart: 1, berm: { height: bermH, start: 0, width: bermW }, rInf: 40, underDepth: 0.15 };
    },
    margin: 140,
    material: (c) => {
      if (c.e < 0) return c.roadMat;
      if (c.slope > 1.1 && c.e > cell * 1.45 + 4) return M.gravel;
      return M.snow;
    },
    scenery: (p, ctx) => {
      startFinish(p, ctx);
      const bStart = cell * 1.45 + 0.2;
      for (let s = ctx.startS - 30; s < ctx.finishS + 30; s += 7) {
        for (const side of [-1, 1]) {
          if (bermH(s, side) < 0.35) continue;
          const pt = p.sidePoint(s, side, bStart + bermW / 2);
          p.tryPlace('snowbank', pt.x, pt.z, 0, bermH(s, side) + 0.2, alongRoadRotY(pt.hx, pt.hz, side), { visualR: 1.2, spacing: 0.1 });
        }
      }
      cornerFurniture(p, ctx, 0.2);
      p.line({ kind: 'post', from: ctx.startS + 20, to: ctx.finishS - 20, every: 38, e: 1.1, side: 'alternate', height: 2.0 });
      for (const c of ctx.corners) if (c.severity <= 2 && ctx.rng.next() < 0.5) p.crowd(c.apexS, c.dir, 6, 9, 14);
      p.scatter({
        kinds: [
          { kind: 'pine', w: 8, radius: [0.3, 0.48], height: [9, 20] },
          { kind: 'deadTree', w: 0.6, radius: [0.22, 0.32], height: [5, 9] },
          { kind: 'rock', w: 0.6, radius: [0.5, 0.9], height: [0.5, 1.0] },
          { kind: 'bush', w: 0.8, radius: [0, 0], height: [0.6, 1.2] },
        ],
        density: 15, band: [5, 70], outer: 0.35, spacing: 1.6, fastExtra: 3,
      });
      p.scatter({ kinds: [{ kind: 'pine', w: 1, radius: [0.4, 0.55], height: [14, 24] }], density: 3.5, band: [70, 150], outer: 0.5, spacing: 2 });
    },
    pacenotes: true,
  };
}

// ------------------------------------------------------------------------------------------- Red Basin

function redBasin(): ProcRecipe {
  const style: RallyStyle = {
    length: 3600, runIn: 150, runOut: 120,
    straight: [40, 160], longStraightProb: 0.22, longStraight: [240, 420],
    corners: [
      { w: 3, R: [150, 400], ang: [15, 50] },
      { w: 3, R: [75, 150], ang: [30, 80] },
      { w: 1.5, R: [40, 75], ang: [45, 100] },
      { w: 0.4, R: [24, 38], ang: [70, 120] },
    ],
    chicaneProb: 0.15, intoProb: 0.15,
    switchbacks: 0, hairpinR: [14, 16], switchLeg: [80, 120], switchDiverge: [20, 28],
    totalTurn: [140, 230], meanderAmp: 55, meanderPeriod: 1400, maxDev: 65,
  };
  let mat: Noise2D | null = null;
  return {
    meta: META['red-basin'],
    layout: (rng) => rallyLayout(rng, style),
    layoutLimits: { minRadius: 20, farClear: 60, maxArea: 3.0e6 },
    natural: (seed, cl) => {
      const n = new Noise2D(seed);
      const dist = centerlineDistanceField(cl, 12, 260);
      return (x, z) => {
        const base = 5 * n.fbm(x / 450, z / 450, 3);
        const d = n.perlin(x / 90 + 3, z / 140 - 5);
        const dunes = 2.2 * (1 - Math.abs(d)) * (1 - Math.abs(d));
        // flat-topped mesas, kept off the road corridor (a backdrop of cliffs)
        const away = smooth(110, 200, dist(x, z));
        const mesa = away > 0 ? 34 * away * smooth(0.34, 0.42, n.fbm(x / 520 + 7, z / 520 - 2, 3)) : 0;
        return base + dunes + mesa + 0.4 * n.fbm(x / 18, z / 18, 2);
      };
    },
    profile: { sigma: 60, gradeMax: 0.07, hairpinGrade: 0.05 },
    width: { base: 9, vary: 0.8, hairpinWiden: 1.5 },
    crown: (s) => (s === 'sand' ? 0.06 : s === 'tarmac' ? 0.05 : 0.08),
    bank: { gain: 1.5, max: 0.04 },
    features: (ctx) => rallyFeatures(ctx, { crests: 3, jumps: 3, water: 0, jumpH: [1.7, 2.2] }),
    surfaces: (ctx) => {
      // Original desert rally stages (§4.3 v1.3, road faces of the three forward stages): ≈ 78 % SAND, 14 % ASPHALT,
      // 8 % GRAVEL. Here: a sand base with two tarmac stretches (≈ 2 × 250 m ≈ 14 %) and two gravel stretches
      // (≈ 2 × 150 m ≈ 8 %) on a ≈ 3.6 km timed stage.
      const { cl, rng, startS, finishS } = ctx;
      const cands: number[] = [];
      for (let s = startS + 150; s < finishS - 350; s += 10) cands.push(s);
      const tar = pickSpread(rng, cands, 2, 900);
      const secs: { from: number; to: number; surface: SurfaceId }[] = tar.map((s) => ({ from: s, to: s + rng.range(220, 280), surface: 'tarmac' as SurfaceId }));
      const grv = pickSpread(rng, cands, 2, 600, tar.map((s) => s + 125));
      for (const s of grv) secs.push({ from: s, to: s + rng.range(130, 170), surface: 'gravel' });
      return sectionMaterials(cl, 'sand', secs);
    },
    carve: () => ({ cutSlope: 0.8, fillSlope: 0.6, ditchDepth: 0, ditchWidth: 1, ditchStart: 1, rInf: 40, underDepth: 0.15 }),
    margin: 180,
    material: (c, ctx) => {
      mat ??= new Noise2D(hashSeed('red-mat') ^ ctx.seed);
      if (c.e < 0) return c.roadMat;
      if (c.e < 1.5) return c.roadMat === M.tarmac ? M.sand : c.roadMat;
      if (c.slope > 0.7) return M.gravel;
      if (mat.fbm(c.x / 80, c.z / 80, 2) > 0.3) return M.gravel;
      return M.sand;
    },
    scenery: (p, ctx) => {
      startFinish(p, ctx);
      for (const f of ctx.features)
        if (f.kind === 'jump') {
          p.crowd(f.s + 22, 1, 9, 12, 18);
          p.crowd(f.s + 22, -1, 9, 12, 18);
        }
      cornerFurniture(p, ctx, 0.3);
      p.line({ kind: 'post', from: ctx.startS + 30, to: ctx.finishS - 30, every: 60, e: 1.6, side: 'alternate', height: 1.2 });
      p.scatter({
        kinds: [
          { kind: 'cactus', w: 3, radius: [0.25, 0.4], height: [2.5, 6] },
          { kind: 'rock', w: 2, radius: [0.5, 1.0], height: [0.6, 1.3] },
          { kind: 'boulder', w: 1, radius: [1.2, 2.4], height: [2, 3.5] },
          { kind: 'bush', w: 3, radius: [0, 0], height: [0.6, 1.4] },
          { kind: 'deadTree', w: 0.6, radius: [0.25, 0.35], height: [4, 7] },
        ],
        density: 3.5, band: [4, 140], outer: 0.5, spacing: 3, fastExtra: 4,
      });
    },
    pacenotes: true,
  };
}

// ------------------------------------------------------------------------------------------- Kettle Park

const KETTLE: LoopTemplate = {
  sense: 1,
  jitterR: 0.1,
  jitterAng: 0.06,
  jitterLen: 0.1,
  minFree: 35,
  items: [
    { kind: 'straight', len: 125, tag: 'start' },
    { kind: 'arc', R: 30, ang: 100, dir: 1 },
    { kind: 'straight', len: 90 },
    { kind: 'arc', R: 22, ang: 80, dir: -1, tag: 'gravel' },
    { kind: 'straight', len: 45, tag: 'gravel' },
    { kind: 'arc', R: 14, ang: 170, dir: 1, tag: 'gravel' },
    { kind: 'straight', len: 0, free: true, tag: 'jumpStraight' },
    { kind: 'arc', R: 45, ang: 60, dir: 1, tag: 'gravel' },
    { kind: 'straight', len: 0, free: true, tag: 'gravel' },
    { kind: 'arc', R: 20, ang: 90, dir: -1, tag: 'gravel' },
    { kind: 'straight', len: 35, tag: 'gravel' },
    { kind: 'arc', R: 26, ang: 0, dir: 1, adjust: true },
    { kind: 'straight', len: 45 },
    { kind: 'straight', len: 125, tag: 'start' },
  ],
};

function kettlePark(): ProcRecipe {
  return {
    meta: META['kettle-park'],
    layout: (rng) => loopLayout(rng, KETTLE),
    layoutLimits: { minRadius: 13, farClear: 32, maxArea: 0.5e6 },
    natural: (seed) => {
      const n = new Noise2D(seed);
      return (x, z) => 3 * n.fbm(x / 260, z / 260, 3) + 1 * n.fbm(x / 60, z / 60, 2);
    },
    profile: { sigma: 18, gradeMax: 0.08, hairpinGrade: 0.05 },
    width: { base: 12, vary: 0.3, hairpinWiden: 1.5 },
    crown: (s) => (s === 'gravel' ? 0.06 : 0.05),
    bank: { gain: 3, max: 0.07 },
    features: (ctx) => {
      const m = ctx.marks.jumpStraight;
      if (!m) return [];
      const mid = 0.5 * (m[0] + m[1]);
      const spots = straightSpots(ctx.cl, 22, m[0] + 20, m[1] - 20, 1 / 300);
      const s = spots.length ? spots.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a)) : mid;
      return [{ kind: 'tabletop', s, h: 1.3, before: 12, after: 18 }];
    },
    surfaces: (ctx) => {
      const g = [...(ctx.marks.gravel ?? []), ...(ctx.marks.jumpStraight ?? [])];
      if (!g.length) return sectionMaterials(ctx.cl, 'tarmac', []);
      return sectionMaterials(ctx.cl, 'tarmac', [{ from: Math.min(...g) - 4, to: Math.max(...g) + 4, surface: 'gravel' }]);
    },
    carve: () => ({ cutSlope: 0.7, fillSlope: 0.5, ditchDepth: 0, ditchWidth: 1, ditchStart: 1, rInf: 35, underDepth: 0.15 }),
    margin: 150,
    material: (c, ctx) => {
      if (c.e < 0) return c.roadMat;
      if (c.e < 1.2) return M.gravel;
      if (c.e < 7) {
        const s = c.s;
        for (const k of ctx.corners) {
          const ss = ctx.cl.normS(s - k.s0);
          if (ss <= k.s1 - k.s0 + 8 && -k.dir === c.side) return M.gravel;
        }
      }
      return M.grass;
    },
    scenery: (p, ctx) => {
      const { cl, rng } = ctx;
      p.gate('startGate', 0);
      for (const c of ctx.corners) {
        p.line({ kind: 'tyreStack', from: c.s0 - 10, to: c.s1 + 10, every: 1.25, e: 6.6, side: -c.dir, radius: 0.5, height: 1.0, clear: 3 });
        if (c.hairpin) for (let k = -1; k <= 1; k++) {
          const pt = p.sidePoint(c.apexS + k * 6, c.dir, 4.6);
          p.tryPlace('hayBale', pt.x, pt.z, 0.6, 1.2, rng.next() * 6.28, { clear: 3 });
        }
      }
      // fences along both sides, grandstands outside the start straight (left of travel)
      p.line({ kind: 'fence', from: 0, to: cl.length, every: 4, e: 10, side: -1, height: 1.1, along: true });
      p.line({ kind: 'fence', from: 0, to: cl.length, every: 4, e: 10, side: 1, height: 1.1, along: true });
      for (const s of [-40, 30]) {
        const pt = p.sidePoint(cl.normS(s), -1, 22);
        p.tryPlace('grandstand', pt.x, pt.z, 7, 6, faceRoad(ctx, cl.normS(s), pt.x, pt.z), { clear: 8 });
      }
      p.crowd(cl.normS(-5), -1, 14, 12, 16);
      p.line({ kind: 'banner', from: cl.length - 30, to: cl.length + 30, every: 10, e: 3, side: 1, height: 2.5, along: true });
      for (const m of [ctx.marks.jumpStraight]) if (m) {
        p.crowd(0.5 * (m[0] + m[1]) + 20, 1, 10, 12, 16);
        p.crowd(0.5 * (m[0] + m[1]) + 20, -1, 10, 12, 16);
      }
      p.line({ kind: 'pole', from: 0, to: cl.length, every: 90, e: 14, side: -1, radius: 0.3, height: 12 });
      p.scatter({ kinds: [{ kind: 'tree', w: 3, radius: [0.45, 0.7], height: [8, 14] }, { kind: 'pine', w: 1, radius: [0.35, 0.5], height: [10, 18] }, { kind: 'bush', w: 2, radius: [0, 0], height: [0.8, 1.6] }], density: 4, band: [30, 130], outer: 0.7, spacing: 2.5 });
    },
    pacenotes: false,
  };
}

// ------------------------------------------------------------------------------------------- Lake Skoga

/**
 * Ice circuit: fast sweepers (R 60-95 m) so ice pace is set by grip, not by hairpins: about 1.4 g on ice tyres
 * gives 100-120 km/h through the corners (the v1 layout's 28-38 m corners capped the pace near 70 km/h).
 */
const SKOGA: LoopTemplate = {
  sense: -1,
  jitterR: 0.08,
  jitterAng: 0.06,
  jitterLen: 0.1,
  minFree: 50,
  items: [
    { kind: 'straight', len: 125, tag: 'start' },
    { kind: 'arc', R: 82, ang: 90, dir: -1 },
    { kind: 'straight', len: 60 },
    { kind: 'arc', R: 95, ang: 35, dir: 1 },
    { kind: 'arc', R: 62, ang: 140, dir: -1 },
    { kind: 'straight', len: 0, free: true },
    { kind: 'arc', R: 88, ang: 55, dir: 1 },
    { kind: 'arc', R: 66, ang: 105, dir: -1 },
    { kind: 'straight', len: 0, free: true },
    { kind: 'arc', R: 78, ang: 0, dir: -1, adjust: true },
    { kind: 'straight', len: 40 },
    { kind: 'straight', len: 125, tag: 'start' },
  ],
};

function lakeSkoga(): ProcRecipe {
  let cell = 2;
  let bermW = 3.4;
  let bn: Noise1D | null = null;
  let lake = { cx: 0, cz: 0, ax: 300, az: 300 };
  const bermH = (s: number, side: number): number => 0.8 + 0.3 * (bn ? bn.at(s / 40 + (side > 0 ? 300 : 0)) : 0);
  const lakeR = (x: number, z: number): number => Math.hypot((x - lake.cx) / lake.ax, (z - lake.cz) / lake.az);
  return {
    meta: META['lake-skoga'],
    layout: (rng) => loopLayout(rng, SKOGA),
    layoutLimits: { minRadius: 18, farClear: 35, maxArea: 0.6e6 },
    natural: (seed, cl) => {
      const n = new Noise2D(seed);
      bn = new Noise1D(seed ^ 0x3c3c);
      lake = { cx: 0.5 * (cl.minX + cl.maxX), cz: 0.5 * (cl.minZ + cl.maxZ), ax: 0.5 * (cl.maxX - cl.minX) + 70, az: 0.5 * (cl.maxZ - cl.minZ) + 70 };
      return (x, z) => {
        const r = lakeR(x, z);
        if (r < 1) return 0;
        return 22 * smooth(1, 1.7, r) * (0.75 + 0.25 * n.fbm(x / 160, z / 160, 3)) + 1.5 * smooth(1, 1.15, r) * n.fbm(x / 40, z / 40, 2);
      };
    },
    profile: { sigma: 10, gradeMax: 0.05, hairpinGrade: 0.05, base: () => 0 },
    width: { base: 12, vary: 0.4, hairpinWiden: 1 },
    crown: () => 0,
    bank: { gain: 0, max: 0 },
    features: () => [],
    surfaces: (ctx) => sectionMaterials(ctx.cl, 'ice', []),
    carve: (cs) => {
      cell = cs;
      bermW = Math.max(3.4, 2.2 * cs);
      return { cutSlope: 1, fillSlope: 1, ditchDepth: 0, ditchWidth: 1, ditchStart: 1, berm: { height: bermH, start: 0, width: bermW }, rInf: 25, underDepth: 0.15 };
    },
    margin: 260,
    minCell: 2,
    material: (c) => {
      if (c.e < 0) return c.roadMat;
      if (c.e < cell * 1.45 + 0.2 + bermW + 0.8 && c.e > 0.5) return M.snow;
      if (c.e <= 0.5) return M.ice;
      return lakeR(c.x, c.z) < 1.02 ? M.ice : M.snow;
    },
    scenery: (p, ctx) => {
      const { cl, rng } = ctx;
      p.gate('startGate', 0);
      const bStart = cell * 1.45 + 0.2;
      for (let s = 0; s < cl.length; s += 6) {
        for (const side of [-1, 1]) {
          const pt = p.sidePoint(s, side, bStart + bermW / 2);
          p.tryPlace('snowbank', pt.x, pt.z, 0, bermH(s, side) + 0.2, alongRoadRotY(pt.hx, pt.hz, side), { visualR: 1.2, spacing: 0.1 });
        }
      }
      p.line({ kind: 'post', from: 0, to: cl.length, every: 30, e: 1.0, side: 'alternate', height: 1.8 });
      p.crowd(cl.normS(10), 1, 12, 12, 18);
      p.crowd(cl.normS(10), -1, 8, 12, 18);
      p.line({ kind: 'banner', from: cl.length - 25, to: cl.length + 25, every: 10, e: 2.5, side: -1, height: 2.5, along: true });
      // shore: cabins, tents and forest
      const shore = (x: number, z: number): boolean => lakeR(x, z) > 1.12;
      for (let i = 0; i < 14; i++) {
        const s = rng.range(0, cl.length);
        const side = rng.next() < 0.5 ? -1 : 1;
        const pt = p.sidePoint(s, side, rng.range(60, 140));
        if (shore(pt.x, pt.z)) p.tryPlace(rng.next() < 0.6 ? 'house' : 'tent', pt.x, pt.z, 4, 6, rng.next() * 6.28, { clear: 10, spacing: 4, maxSlope: 0.4 });
      }
      p.scatter({ kinds: [{ kind: 'pine', w: 6, radius: [0.32, 0.5], height: [9, 20] }, { kind: 'deadTree', w: 0.5, radius: [0.22, 0.3], height: [5, 9] }], density: 10, band: [40, 240], outer: 1.2, spacing: 1.8, accept: (x, z) => shore(x, z) });
    },
    pacenotes: false,
  };
}

// ------------------------------------------------------------------------------------------- Proving Ground

interface Patch {
  surface: SurfaceId;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  dip: number;
}

const BOWL = { x: 125, z: 95, rIn: 44, rTop: 62, bank: 22 * DEG, outSlope: 0.8, gapAngle: Math.PI };

function testpadPatches(): Patch[] {
  const order: SurfaceId[] = ['gravel', 'gravelDeep', 'mud', 'snow', 'ice', 'grass', 'sand', 'cobbles', 'water'];
  const out: Patch[] = [];
  let x = -207;
  for (const s of order) {
    const w = s === 'water' ? 16 : 40;
    out.push({ surface: s, x0: x, x1: x + w, z0: -215, z1: -150, dip: s === 'water' ? 0.08 : 0 });
    x += w + 6;
  }
  return out;
}

function testpad(): ProcRecipe {
  const patches = testpadPatches();
  const S = 180;
  const feats: PathFeature[] = [
    { kind: 'straight', len: S },
    { kind: 'arc', radius: 70, angle: Math.PI / 2, dir: -1 },
    { kind: 'straight', len: 2 * S },
    { kind: 'arc', radius: 70, angle: Math.PI / 2, dir: -1 },
    { kind: 'straight', len: 2 * S },
    { kind: 'arc', radius: 70, angle: Math.PI / 2, dir: -1 },
    { kind: 'straight', len: 2 * S },
    { kind: 'arc', radius: 70, angle: Math.PI / 2, dir: -1 },
    { kind: 'straight', len: S },
  ];
  const bowlH = (x: number, z: number): number => {
    const dx = x - BOWL.x, dz = z - BOWL.z;
    const r = Math.hypot(dx, dz);
    const top = (BOWL.rTop - BOWL.rIn) * Math.tan(BOWL.bank);
    let h = 0;
    if (r <= BOWL.rIn) h = 0;
    else if (r <= BOWL.rTop) h = (r - BOWL.rIn) * Math.tan(BOWL.bank);
    else if (r <= BOWL.rTop + 4) h = top;
    else h = Math.max(0, top - (r - BOWL.rTop - 4) * BOWL.outSlope);
    // entrance gap on the west side
    let a = Math.atan2(dz, dx) - BOWL.gapAngle;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    return h * smooth(0.1, 0.32, Math.abs(a));
  };
  const crestH = (x: number, z: number): number => {
    // smooth hump 1.4 m over 40 m along x, 28 m wide in z
    const u = (x + 195) / 20;
    const w = smooth(0, 6, 20 - Math.abs(z - 100));
    return Math.abs(u) < 1 ? 1.4 * 0.5 * (1 + Math.cos(Math.PI * u)) * w : 0;
  };
  const kickerH = (x: number, z: number): number => {
    const w = smooth(0, 4, 16 - Math.abs(z - 100));
    if (x < -140 || x > -122) return 0;
    const h = x <= -126 ? 1.5 * Math.pow((x + 140) / 14, 1.4) : 1.5 * (1 - (x + 126) / 4);
    return Math.max(0, h) * w;
  };
  const natural = (x: number, z: number): number => {
    const m = Math.max(Math.abs(x), Math.abs(z));
    let h = 3 * smooth(275, 298, m);
    h += bowlH(x, z) + crestH(x, z) + kickerH(x, z);
    for (const p of patches) if (p.dip > 0 && x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) h -= p.dip;
    return h;
  };
  return {
    meta: META['testpad'],
    layout: () => loopFromFeatures(feats, { x: 0, z: 250, heading: Math.PI / 2 }),
    layoutLimits: { minRadius: 40, farClear: 30, maxArea: 1e7, attempts: 1 },
    natural: () => natural,
    profile: { sigma: 1, gradeMax: 0.2, hairpinGrade: 0.2, base: () => 0 },
    width: { base: 12, vary: 0, hairpinWiden: 0 },
    crown: () => 0,
    bank: { gain: 0, max: 0 },
    features: () => [],
    surfaces: (ctx) => sectionMaterials(ctx.cl, 'tarmac', []),
    carve: () => null,
    margin: 38,
    minCell: 2,
    material: (c) => {
      if (c.e < 0) return c.roadMat;
      for (const p of patches) if (c.x >= p.x0 && c.x <= p.x1 && c.z >= p.z0 && c.z <= p.z1) return M[p.surface];
      const m = Math.max(Math.abs(c.x), Math.abs(c.z));
      return m > 258 ? M.grass : M.tarmac;
    },
    scenery: (p, ctx) => {
      p.gate('startGate', 0);
      // cone slalom along z = -100 and a cone box at its start
      for (let x = -180; x <= 180; x += 20) p.tryPlace('cone', x, -100, 0, 0.5, 0, { force: true });
      for (let i = 0; i < 5; i++) {
        p.tryPlace('cone', -200, -100 - 6 + i * 3, 0, 0.5, 0, { force: true });
      }
      // patch signs (labels carry the names)
      for (const pa of patches) p.tryPlace('sign', 0.5 * (pa.x0 + pa.x1), pa.z1 + 4, 0, 2, 0, { force: true });
      // ramp and bowl markers
      p.tryPlace('sign', -195, 126, 0, 2, 0, { force: true });
      p.tryPlace('sign', -131, 122, 0, 2, 0, { force: true });
      p.tryPlace('sign', BOWL.x - BOWL.rTop - 12, BOWL.z + 12, 0, 2, 0, { force: true });
      // tyre stacks on the bowl's outer lip (outside the driving line)
      for (let a = 0; a < Math.PI * 2; a += 0.06) {
        let d = a - BOWL.gapAngle;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) < 0.4) continue;
        p.tryPlace('tyreStack', BOWL.x + Math.cos(a) * (BOWL.rTop + 2.2), BOWL.z + Math.sin(a) * (BOWL.rTop + 2.2), 0.5, 1, 0, { clear: 3, spacing: 0.05 });
      }
      // outside the loop: light poles, a grandstand by the start, some trees on the berm
      p.line({ kind: 'pole', from: 0, to: ctx.cl.length, every: 120, e: 9, side: 1, radius: 0.3, height: 12 });
      const g = p.sidePoint(30, 1, 20);
      p.tryPlace('grandstand', g.x, g.z, 7, 6, faceRoad(ctx, 30, g.x, g.z), { clear: 8 });
      p.scatter({ kinds: [{ kind: 'tree', w: 2, radius: [0.45, 0.65], height: [8, 13] }, { kind: 'pine', w: 2, radius: [0.35, 0.5], height: [10, 16] }], density: 3, band: [14, 40], outer: 1, spacing: 4, side: 1 });
    },
    pacenotes: false,
    labels: (): StageLabel[] => [
      ...patches.map((pa) => ({ text: SURFACE_INFO[pa.surface].name, pos: { x: 0.5 * (pa.x0 + pa.x1), y: 2.4, z: pa.z1 + 4 }, rotY: 0 })),
      { text: 'Crest', pos: { x: -195, y: 2.4, z: 126 }, rotY: 0 },
      { text: 'Kicker', pos: { x: -131, y: 2.4, z: 122 }, rotY: 0 },
      { text: 'Banked bowl', pos: { x: BOWL.x - BOWL.rTop - 12, y: 2.4, z: BOWL.z + 12 }, rotY: 0 },
      { text: 'Slalom', pos: { x: -200, y: 2.4, z: -92 }, rotY: 0 },
    ],
  };
}

export const RECIPES: Readonly<Record<string, () => ProcRecipe>> = Object.freeze({
  'pine-ridge': pineRidge,
  'col-du-vent': colDuVent,
  frostvale,
  'red-basin': redBasin,
  'kettle-park': kettlePark,
  'lake-skoga': lakeSkoga,
  testpad,
});
