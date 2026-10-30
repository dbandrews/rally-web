// Effect envelopes and layer evaluation ≡ the verified research parser (fmt_sound.ramp / layer_eval, fixtures from
// `python -I tools/assets/parts/audio.py --fixtures`) and the worked examples of research/formats/sound.md §3-§6.
import { describe, expect, it } from 'vitest';
import type { EffectJson } from '../../src/audio/orig/bankTypes';
import { type EffectSources, hasTimeReleaseVolume, layerVolumePitch, linear, ramp } from '../../src/audio/orig/envelope';
import fixture from './fixtures/layerEval.json';

interface LayerCase {
  script: string;
  patch: number;
  layer: number;
  def: { volume: number; fx: EffectJson[] };
  ext: number[];
  dist: number;
  time: number;
  trel: number;
  volume: number;
  pitch: number;
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));

const src = (o: Partial<EffectSources>): EffectSources => ({
  ext: o.ext ?? [],
  speed: 0,
  acceleration: 0,
  distance: o.distance ?? 0,
  altitude: 0,
  time: o.time ?? 0,
  timeRelease: o.timeRelease ?? -1,
});

describe('Ramp envelope (FUN_00605e50) ≡ fmt_sound.ramp', () => {
  it(`matches ${fixture.ramps.length} random cases`, () => {
    let bad = 0;
    for (const c of fixture.ramps) if (!close(ramp(c.p, c.x), c.y)) bad++;
    expect(bad).toBe(0);
  });

  it('the spec worked examples (§3.2)', () => {
    // step form `1 1 1 −1` (Ouside): 1 when x < 1, 0 when x ≥ 1
    const ouside = [1, 1, 1, -1, 0, 1];
    expect(ramp(ouside, 0)).toBe(1);
    expect(ramp(ouside, 0.999)).toBe(1);
    expect(ramp(ouside, 1)).toBe(0);
    expect(ramp(ouside, 5)).toBe(0);
    // EngineThrottle pitch `Ramp 1000 9400 0.45 0.55 2 1.2` (ease-in): 0.45 at idle, 1.0 at 9400 rpm
    const pitch = [1000, 9400, 0.45, 0.55, 2, 1.2];
    expect(ramp(pitch, 800)).toBe(0.45);
    expect(ramp(pitch, 9400)).toBeCloseTo(1.0, 12);
    expect(ramp(pitch, 5200)).toBeCloseTo(0.45 + 0.55 * Math.pow(0.5, 1.2), 12);
    // the Pipe / Piston Time ramp `param 0 .7 .2 1`: 0.2 → 1.2 over 0.7 s
    const t = [0, 0.7, 0.2, 1, 0, 1];
    expect(ramp(t, 0)).toBeCloseTo(0.2, 12);
    expect(ramp(t, 0.35)).toBeCloseTo(0.7, 12);
    expect(ramp(t, 2)).toBeCloseTo(1.2, 12);
    // ease-out (curve 1) and the default branch bug y0 + y0
    expect(ramp([0, 1, 0, 1, 1, 2], 0.5)).toBeCloseTo(0.75, 12);
    expect(ramp([0, 1, 0.3, 1, 3, 2], 0.5)).toBeCloseTo(0.6, 12);
    // x1 < x0 → x1 = x0 (a step)
    expect(ramp([2, 1, 0, 1, 0, 1], 1.9)).toBe(0);
    expect(ramp([2, 1, 0, 1, 0, 1], 2)).toBe(1);
    // not clamped
    expect(ramp([0, 1, -0.5, 3, 0, 1], 0.5)).toBeCloseTo(1, 12);
  });

  it('Linear (FUN_00605d70): y = p0 + p1·x', () => {
    expect(linear([0.5, 2], 3)).toBe(6.5);
    expect(linear([0, 0], 3)).toBe(0);
  });
});

describe('layer evaluation (§3.3) ≡ fmt_sound.layer_eval', () => {
  const cases = fixture.layers as LayerCase[];
  it(`matches ${cases.length} layer cases from the real scripts`, () => {
    let bad = 0;
    for (const c of cases) {
      const r = layerVolumePitch(c.def, src({ ext: c.ext, distance: c.dist, time: c.time, timeRelease: c.trel }));
      // the research tool clamps the product at 0; the runtime returns it raw and tests vol <= 0 → stop
      if (!close(Math.max(0, r.volume), c.volume) || !close(r.pitch, c.pitch)) bad++;
    }
    expect(bad).toBe(0);
  });

  it('covers the engine, pipe, boost, surface, whine, collision and crowd scripts', () => {
    const scripts = new Set(cases.map((c) => c.script.split('/').pop()));
    for (const s of ['Engine.ssc', 'EngineThrottle.ssc', 'Pipe.ssc', 'PipeBoost2.ssc', 'WheelFriction.ssc', 'WheelSlipX.ssc', 'Whine.ssc', 'Collision.ssc', 'BigCrowd.ssc']) {
      expect(scripts.has(s), s).toBe(true);
    }
  });

  it('volume: layer.volume clamped to ≤ 1 (≤ 0 → silent), × Π volume effects × patch volume', () => {
    const fx: EffectJson[] = [{ d: 0, s: 1, x: 0, e: 1, p: [0, 10, 0, 1, 0, 1] }];
    expect(layerVolumePitch({ volume: 3, fx }, src({ ext: [5] })).volume).toBeCloseTo(0.5, 12);
    expect(layerVolumePitch({ volume: 0.5, fx }, src({ ext: [5] }), 0.5).volume).toBeCloseTo(0.125, 12);
    expect(layerVolumePitch({ volume: -1, fx }, src({ ext: [5] })).volume).toBe(0);
    // pitch = 1 · Π pitch effects; Default = extern 0
    const pf: EffectJson[] = [
      { d: 1, s: 0, x: 0, e: 1, p: [0, 0, 0.7, 0, 0, 1] },
      { d: 1, s: 1, x: 6, e: 1, p: [0, 220, 0.6, 0.5, 0, 1] },
    ];
    const ext = new Array(10).fill(0);
    ext[6] = 110;
    expect(layerVolumePitch({ volume: 1, fx: pf }, src({ ext })).pitch).toBeCloseTo(0.7 * 0.85, 12);
  });

  it('hasTimeReleaseVolume finds the X-Fade layers', () => {
    expect(hasTimeReleaseVolume([{ d: 0, s: 7, x: 0, e: 1, p: [0, 0.1, 1, -1, 0, 1] }])).toBe(true);
    expect(hasTimeReleaseVolume([{ d: 1, s: 7, x: 0, e: 1, p: [0, 0.1, 1, -1, 0, 1] }])).toBe(false);
  });
});
