// src/game/selection.ts (main.ts's boot / load selection rules) and the post-finish track braking of a PORTED stage
// through the race controller (FUN_004b4170 case 3 → state 4 → FUN_004b3790 phys+0x44, MECHANICS_SPEC §2.7).
import { describe, expect, it } from 'vitest';
import type { AssetManifest } from '../../src/core/assets';
import { ASSET_MANIFEST_VERSION } from '../../src/core/assets';
import { DT, ORIG_DEFAULT_CAR } from '../../src/core/constants';
import type { RaceSelection, Stage } from '../../src/core/types';
import { RaceController } from '../../src/game/race';
import { normalizeCarSelection, originalStagesFirst, withDefaultOrigCar } from '../../src/game/selection';
import { MemoryStore } from '../../src/game/storage';
import { origCarArchetype } from '../../src/sim/presets';
import { buildStage, listStages } from '../../src/world/stages';
import { FakeCar } from './fakes';

const sel = (o: Partial<RaceSelection> = {}): RaceSelection => ({
  stageId: 'pine-ridge',
  archetype: 'awd_wrc',
  tyre: 2,
  transmission: 'auto',
  setup: {},
  steerSensFast: true,
  seed: 1,
  ...o,
});

const manifest = (stages: Record<string, string[]>, carParts: Record<string, string[]> = {}): AssetManifest => ({
  version: ASSET_MANIFEST_VERSION,
  stages,
  cars: Object.keys(carParts),
  carParts,
  global: [],
  audio: false,
  textures: 0,
});

describe('normalizeCarSelection', () => {
  it('an original car sets its drive archetype; an unknown car name is dropped; no car is unchanged', () => {
    expect(normalizeCarSelection(sel({ car: 'Micra' }))).toMatchObject({ car: 'Micra', archetype: origCarArchetype('Micra') });
    const dropped = normalizeCarSelection(sel({ car: 'NoSuchCar', archetype: 'rwd_classic' }));
    expect('car' in dropped).toBe(false);
    expect(dropped.archetype).toBe('rwd_classic');
    const plain = sel();
    expect(normalizeCarSelection(plain)).toBe(plain);
  });
});

describe('withDefaultOrigCar', () => {
  const built = manifest({}, { [ORIG_DEFAULT_CAR]: ['cars'] });
  it("the original's default car once its cars part is built", () => {
    expect(withDefaultOrigCar(sel(), built, false)).toMatchObject({ car: ORIG_DEFAULT_CAR, archetype: origCarArchetype(ORIG_DEFAULT_CAR) });
  });
  it('?car= wins, a chosen car stays, no manifest / an unbuilt car keeps the archetype car', () => {
    expect(withDefaultOrigCar(sel(), built, true).car).toBeUndefined();
    expect(withDefaultOrigCar(sel({ car: 'AudiS1' }), built, false).car).toBe('AudiS1');
    expect(withDefaultOrigCar(sel(), null, false).car).toBeUndefined();
    expect(withDefaultOrigCar(sel(), manifest({}, { [ORIG_DEFAULT_CAR]: ['effects'] }), false).car).toBeUndefined();
  });
});

describe('originalStagesFirst (default stage and menu order)', () => {
  const all = listStages();
  it('without assets: null (the procedural catalogue and Pine Ridge stay first)', () => {
    expect(originalStagesFirst(all, null)).toBeNull();
    expect(originalStagesFirst(all, manifest({}))).toBeNull();
  });
  it('built original stages (track + collision) first, in catalogue order, then the procedural and unbuilt ones', () => {
    const m = manifest({
      'kenya-1-f': ['track', 'collision', 'objects'],
      'corsica-1-f': ['track', 'collision'],
      'corsica-1-r': ['track'], // no collision: not first
    });
    const list = originalStagesFirst(all, m)!;
    expect(list.slice(0, 2).map((e) => e.id)).toEqual(['corsica-1-f', 'kenya-1-f']);
    expect(list).toHaveLength(all.length);
    expect(new Set(list.map((e) => e.id))).toEqual(new Set(all.map((e) => e.id)));
    // the procedural class stages follow, in their own order, before the unbuilt ported ones
    const rest = list.slice(2).map((e) => e.id);
    expect(rest.indexOf('pine-ridge')).toBeLessThan(rest.indexOf('corsica-1-r'));
  });
  it('every ported stage built: corsica-1-f (the first entry of the original Misc/level/track.lst) is the default', () => {
    const m = manifest(Object.fromEntries(all.filter((e) => /-[fr]$/.test(e.id)).map((e) => [e.id, ['track', 'collision']])));
    expect(originalStagesFirst(all, m)![0].id).toBe('corsica-1-f');
  });
});

describe('post-finish track braking on a ported stage', () => {
  it('hillclimb-3c-f (bodyBrakingFactorForTrack 0.1) hands the car 0.1 exactly once at the finish; begin clears it', () => {
    const { stage } = buildStage('hillclimb-3c-f', 1);
    expect((stage as Stage & { trackBraking?: number }).trackBraking).toBe(0.1);
    const car = new FakeCar();
    const calls: number[] = [];
    const set = car.setTrackBraking.bind(car);
    car.setTrackBraking = (f: number) => {
      calls.push(f);
      set(f);
    };
    const race = new RaceController({ store: new MemoryStore() });
    race.begin(stage, car, { countdown: false });
    race.startNow();
    race.teleport(stage.finishS - 30, 0);
    car.speed = 20;
    for (let i = 0; i < Math.round(4 / DT); i++) {
      car.step({ steer: 0, throttle: 0, brake: 0, handbrake: 0, gearUp: false, gearDown: false }, DT);
      race.fixedUpdate(DT, car.telemetry());
    }
    expect(race.state.phase).toBe('finished');
    expect(calls).toEqual([0.1]);
    expect(car.trackBraking).toBe(0.1);
    race.begin(stage, car, { countdown: false });
    expect(car.trackBraking).toBe(0);
    expect(calls).toEqual([0.1]);
  });
});
