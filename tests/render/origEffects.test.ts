/**
 * tests/render/origEffects.test.ts — the original car effects (effects builder; research/formats/effects.md).
 *
 *  * the pure ports in src/render/orig/effectsData.ts: OverTimeDistribution tables (FUN_0076b110), the
 *    RandomDistribution sampler (FUN_00576620), the CarFx fade (0x7587da) and phys-var map (FUN_00757260),
 *    the particle light grid lookup, the emitter wheel sets;
 *  * the procedural skid table derived from the original data (all 23 surfaces);
 *  * the built definitions (public/assets, skipped without them): the evaluated scripts of a gravel, a snow and
 *    a water stage, the per-car exhaust / drop-shadow data and the light grid.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests } from '../../src/core/assets';
import { SURFACE_IDS } from '../../src/core/constants';
import { skidLook } from '../../src/render/effects';
import { wheelsOfMode } from '../../src/render/orig/effects';
import {
  FxRng,
  carFxFade,
  evalOT,
  lightAt,
  loadCarEffects,
  loadStageEffects,
  overTimeTable,
  parseLightGrid,
  phyVar,
  sampleRD,
  type CarFxChild,
  type CarFxDef,
  type EmitterDef,
  type PhyVarInput,
  type SpriteDef,
} from '../../src/render/orig/effectsData';
import { builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';

describe('OverTimeDistribution tables (FUN_0076b110)', () => {
  it('interpolates linearly between keys and repeats the last key', () => {
    const t = overTimeTable([
      [0, 1],
      [50, 3],
      [80, 1],
    ]);
    expect(t.length).toBe(101);
    expect(t[0]).toBe(1);
    expect(t[25]).toBeCloseTo(2, 6);
    expect(t[50]).toBe(3);
    expect(t[65]).toBeCloseTo(2, 6);
    expect(t[80]).toBe(1);
    expect(t[100]).toBe(1);
  });
  it('starts from the default when the first key is not at 0; no keys = the default everywhere', () => {
    const t = overTimeTable([[10, 3]], 1, [1]);
    expect(t[0]).toBe(1);
    expect(t[5]).toBeCloseTo(2, 6);
    expect(t[10]).toBe(3);
    expect(t[100]).toBe(3);
    expect([...overTimeTable([])].every((v) => v === 1)).toBe(true);
  });
  it('builds the 4-component colour table and looks it up at life fractions', () => {
    const c = overTimeTable(
      [
        [0, 254, 195, 133, 150],
        [48, 254, 195, 133, 150],
        [100, 254, 195, 133, 0],
      ],
      4,
      [255, 255, 255, 255],
    );
    expect(evalOT(c, 0, 4, 0)).toBe(254);
    expect(evalOT(c, 0.3, 4, 3)).toBe(150);
    expect(evalOT(c, 0.74, 4, 3)).toBeCloseTo(75, 3);
    expect(evalOT(c, 1, 4, 3)).toBe(0);
    // i = trunc(100·t), linear to i + 1
    const s = overTimeTable([
      [0, 0],
      [100, 100],
    ]);
    expect(evalOT(s, 0.255)).toBeCloseTo(25.5, 4);
  });
});

describe('RandomDistribution sampler (FUN_00576620)', () => {
  it('NONE / UNIFORM / symmetric / EXPONENTIAL / NORMAL', () => {
    const rng = new FxRng(1234);
    expect(sampleRD([0, 2.5, 9, false], rng)).toBe(2.5);
    let lo = Infinity, hi = -Infinity, neg = 0, sumE = 0, sumN = 0, sumN2 = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const u = sampleRD([1, 80, 50, false], rng); // CRD_UNIFORM/80/50/0: a + (b − a)·u
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
      if (sampleRD([0, 0.1, 0, true], rng) < 0) neg++; // CRD_NONE/0.1/0/1: random sign
      sumE += sampleRD([2, 3, 0, false], rng);
      const g = sampleRD([3, 1, 2, false], rng);
      sumN += g;
      sumN2 += g * g;
    }
    expect(lo).toBeGreaterThanOrEqual(50);
    expect(hi).toBeLessThanOrEqual(80);
    expect(neg / N).toBeGreaterThan(0.45);
    expect(neg / N).toBeLessThan(0.55);
    expect(sumE / N).toBeGreaterThan(2.85);
    expect(sumE / N).toBeLessThan(3.15);
    const mean = sumN / N;
    expect(mean).toBeGreaterThan(0.95);
    expect(mean).toBeLessThan(1.05);
    expect(Math.sqrt(sumN2 / N - mean * mean)).toBeGreaterThan(1.9);
    expect(Math.sqrt(sumN2 / N - mean * mean)).toBeLessThan(2.1);
  });
  it('the RNG draws u in (0, 1]', () => {
    const rng = new FxRng(7);
    for (let i = 0; i < 10000; i++) {
      const u = rng.next();
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThanOrEqual(1);
    }
  });
});

describe('CarFx fade and physics variables', () => {
  const child = (o: Partial<CarFxChild> = {}): CarFxChild => ({
    template: 'x', pos: [0, 0, 0], rot: [0, 0, 0], isActive: true, trigOnMaterial: 2, attachedMode: 4, trigOnPhyVar: 10, startFade: 0.5, doneFade: 1, ...o,
  });
  it('maps |value| through [start, done]; inactive and < 4 km/h car modes give 0', () => {
    expect(carFxFade(child(), 0.4, 10)).toBe(0);
    expect(carFxFade(child(), 0.75, 10)).toBeCloseTo(0.5, 6);
    expect(carFxFade(child(), -0.75, 10)).toBeCloseTo(0.5, 6);
    expect(carFxFade(child(), 2, 10)).toBe(1);
    expect(carFxFade(child({ isActive: false }), 2, 10)).toBe(0);
    expect(carFxFade(child(), 2, 1.0)).toBe(0); // 0x830140 = 1.1111 m/s
    expect(carFxFade(child({ attachedMode: 14, startFade: 0, doneFade: 1 }), 1, 0)).toBe(1); // pipe modes ignore speed
  });
  it('phys-var indices follow the c_Car* / c_Wheel* enum (0x743730)', () => {
    const v: PhyVarInput = {
      throttle: 0.1, brake: 0.2, gear: 3, rpm: 4000, speed: 20, vel: 21, slipAngle: -0.1,
      wheelVel: 19, wheelVelX: 2, wheelRotVel: 60, xSlip: 0.3, zSlip: -0.4, wheelWorldVel: 19.1,
    };
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => phyVar(i, v))).toEqual([0.1, 0.2, 3, 4000, 20, 21, -0.1, 19, 2, 60, 0.3, -0.4, 19.1]);
    expect(phyVar(13, v)).toBe(0); // ZSlipPos = max(z, 0)
    expect(phyVar(14, v)).toBe(-0.4); // ZSlipNeg = min(z, 0)
    expect(phyVar(15, v)).toBe(0); // XSlipPos: car slip angle ≥ 0
    expect(phyVar(16, v)).toBe(0.3); // XSlipNeg: car slip angle ≤ 0
  });
  it('wheel attach modes select the wheel sets (c_AllWheels 4 … c_RearLeftWheel 10)', () => {
    expect(wheelsOfMode(4)).toEqual([0, 1, 2, 3]);
    expect(wheelsOfMode(5)).toEqual([0, 1]);
    expect(wheelsOfMode(6)).toEqual([2, 3]);
    expect(wheelsOfMode(7)).toEqual([0]);
    expect(wheelsOfMode(10)).toEqual([3]);
    expect(wheelsOfMode(1)).toBeNull();
    expect(wheelsOfMode(12)).toBeNull();
  });
});

describe('particle light grid', () => {
  it('looks up the RGB8 cell of a sim position, the LUT max outside', () => {
    const meta = { cell: 4, tile: 2, tiles: [[1, -1]] as [number, number][], bin: 'effects.bin', bytes: 12 };
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 255, 128, 0]);
    const g = parseLightGrid(meta, bytes.buffer);
    const out = [0, 0, 0];
    // tile (1, −1) covers x 8..16, z −8..0; cell (1, 1) = bytes 9..11
    expect(lightAt(g, 13, -1, [1, 1, 1], out).map((v) => Math.round(v * 255))).toEqual([255, 128, 0]);
    expect(lightAt(g, 9, -7, [1, 1, 1], out).map((v) => Math.round(v * 255))).toEqual([10, 20, 30]);
    expect(lightAt(g, 100, 100, [0.5, 0.6, 0.7], out)).toEqual([0.5, 0.6, 0.7]);
    expect(lightAt(null, 0, 0, [1, 1, 1], out)).toEqual([1, 1, 1]);
  });
});

describe('procedural skid table from the original data', () => {
  it('lists every surface with the Tracks.dds / Skidmarks.con look', () => {
    for (const s of SURFACE_IDS) {
      const k = skidLook(s);
      expect(k, s).toBeTruthy();
      expect(k.alpha).toBeGreaterThanOrEqual(0);
      expect(k.alpha).toBeLessThanOrEqual(1);
      expect(k.halfWidth).toBeGreaterThanOrEqual(0.1);
    }
    expect(skidLook('cobbles').alpha).toBe(0); // setIntensityClamp 13 0
    expect(skidLook('wood').alpha).toBe(0); // setIntensityClamp 6 0
    expect(skidLook('snowChunky').alpha).toBe(0); // empty atlas column
    expect(skidLook('gravel').halfWidth).toBeCloseTo(0.15, 6); // 0.1 + extra width 0.05
    expect(skidLook('grass').halfWidth).toBe(0.1); // the COBBLES block resets material 0's width
  });
});

describe.skipIf(!builtAssetsPresent)('built effect definitions (public/assets)', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => _setAssetFetchForTests(null));

  it('kenya-1-f (gravel / sand): the evaluated scripts', async () => {
    const st = await loadStageEffects('kenya-1-f');
    expect(st).not.toBeNull();
    const j = st!.json;
    const bases = j.carFx.map((e) => e.name);
    expect(bases).toContain('CarFX_Gravel_Base');
    expect(bases).toContain('CarFX_Asphalt_Base');
    expect(bases).not.toContain('CarFX_Snow_Base'); // Mat_07 is not run on this stage
    // PFX_Template placements: every base but Asphalt is turned 180° (yaw)
    expect(j.carFx.find((e) => e.name === 'CarFX_Asphalt_Base')!.rot[0]).toBe(0);
    expect(j.carFx.find((e) => e.name === 'CarFX_Gravel_Base')!.rot[0]).toBe(180);
    // every emitter's sprite exists and has a texture
    for (const [name, t] of Object.entries(j.templates)) {
      if (t.type === 'Emitter') {
        const sp = j.templates[(t as EmitterDef).template];
        expect(sp?.type, name).toBe('SpriteParticle');
      } else if (t.type === 'SpriteParticle') {
        expect((t as SpriteDef).tex, name).toBeTruthy();
      }
    }
    const tail = j.templates['CarFX_Gravel_Tail_EMi'] as EmitterDef;
    expect(tail.intensity).toEqual([0, 32, 0, false]);
    expect(tail.addEmitterSpeed).toBe(true);
    expect(tail.emitterSpeedScale).toBeCloseTo(0.1, 6);
    // the bare "objectTemplate.intensity 40" (CarFX_Mat_05.con:473) leaves the CRD_NONE/22 values (effects.md §2.3)
    expect((j.templates['CarFX_Sand_Tail_EMi'] as EmitterDef).intensity).toEqual([0, 22, 0, false]);
    // per-stage colour override from RenderSettingsSingle1p.con
    const fx = j.templates['CarFX_Gravel_Tail_FX'] as SpriteDef;
    expect(fx.colorRGBAOverTime[0]).toEqual([0, 254, 195, 133, 150]);
    expect(fx.varianceColor).toEqual([1, -30, 0, false]);
    expect(fx.srcBlendMode).toBe(5);
    expect(fx.destBlendMode).toBe(6);
    // skid table (Skidmarks.con + this stage's overrides)
    expect(j.skid.trig[9]).toEqual([0, 0, 0, 0]); // SNOWDEEP: always marks
    expect(j.skid.trig[5]).toEqual([1, 1, 0.1, 0.1]);
    expect(j.skid.extraWidth[0]).toBe(0);
    expect(j.skid.texture).toBeTruthy();
    expect(j.settings.globalParticleColor).toHaveLength(4);
    expect(st!.light).not.toBeNull();
    expect(st!.light!.data.length).toBe(j.light!.tiles.length * j.light!.tile * j.light!.tile * 3);
  });

  it('a snow and a water stage get their material FX', async () => {
    const snow = await loadStageEffects('hillclimb-3b-f');
    expect(snow!.json.carFx.map((e) => e.name)).toEqual(expect.arrayContaining(['CarFX_Snow_Base', 'CarFX_SnowDeep_Base']));
    const water = await loadStageEffects('corsica-3-f');
    const wb = water!.json.templates['CarFX_WaterAsphalt_Base'];
    expect(wb?.type).toBe('CarFx');
    // the burst is attached twice: FL on XSlipPos (15), FR on XSlipNeg (16)
    const bursts = (wb as CarFxDef).children.filter((c) => c.template === 'CarFX_WaterAsphalt_Burst_EMi');
    expect(bursts.map((c) => [c.attachedMode, c.trigOnPhyVar])).toEqual([
      [7, 15],
      [8, 16],
    ]);
  });

  it('per-car exhaust and drop shadow', async () => {
    const c = await loadCarEffects('AudiS1');
    expect(c).not.toBeNull();
    expect(c!.exhaust.map((x) => x.template)).toEqual(['CarFX_Pipe', 'CarFX_GearPipe', 'e_ExFumePOW1']);
    expect(c!.exhaust[0].pos[2]).toBeLessThan(-1.5); // at the rear
    expect(c!.dropShadow.scale).toEqual([1.25, 1.08, 0]);
    expect(c!.dropShadow.tex).toBeTruthy();
    expect(c!.dropShadow.bbox![1][2]).toBeGreaterThan(1.5);
  });
});
