/**
 * src/sim/presets.ts — OWNED BY THE SIM BUILDER.
 *
 * Built-in, NON-default tuning presets (docs/MECHANICS_SPEC.md §6.1, v1.3). The shipped parameters
 * (params.ts ARCHETYPE_PARAMS) are the original's and stay the default; a preset is a named override set that
 * the tuning panel lists under Presets, so a human can A/B it against the original game. A preset is applied
 * on top of the archetype's SHIPPED parameters (presetCarParams), keeping only the race-selection choices
 * (tyre type, transmission, the §5.5 setup menu multipliers, steering option).
 *
 *   kind 'deviation': deliberately NOT the original. Labelled DEVIATION in the panel.
 *   kind 'original':  a parameter set from the original's car data that the three archetypes do not cover.
 *
 * REQUIRED EXPORTS:
 *   TUNING_PRESETS: readonly TuningPreset[]
 *   presetOverrides(preset, archetype): DeepPartial<CarParams>     the merged overrides for that archetype
 *   presetCarParams(preset, archetype, keep?): CarParams            shipped params of the target archetype + overrides
 */
import { deepClone, deepMergeInto } from '../core/paths';
import type { ArchetypeId, CarParams, DeepPartial } from '../core/types';
import { makeCarParams } from './params';

export type PresetKind = 'deviation' | 'original';

export interface TuningPreset {
  /** Stable key. */
  id: string;
  /** Name shown in the panel's preset list. */
  label: string;
  kind: PresetKind;
  description: string;
  /** Switch to this archetype first (presets that model one car class). */
  archetype?: ArchetypeId;
  /** Overrides for every archetype. */
  all?: DeepPartial<CarParams>;
  /** Further overrides per archetype, merged after `all`. */
  perArchetype?: Partial<Record<ArchetypeId, DeepPartial<CarParams>>>;
}

/**
 * "Arcade drift" (DEVIATION). Makes power slides holdable for the AWD and FWD cars, using the terms the v1.3 audit
 * found limiting (spec §6.1): per-axle lateral balance under power (drive split, longitudinal load transfer),
 * TWKinSteer (the only yaw torque in a slide) and the turbo spool that gates power-on rotation.
 * Measured (gravel, P-I-D counter-steer controller, spec §7 drift-hold probe): awd_wrc holds 10-40° with steer
 * +0.05…+0.65 (shipped: +0.4…+0.89, 40° marginal); fwd_hatch holds 10-40° (shipped: < 6° at full lock).
 */
const ARCADE_DRIFT: TuningPreset = {
  id: 'arcade-drift',
  label: 'Arcade drift (DEVIATION)',
  kind: 'deviation',
  description:
    'Not the original. All cars: TWKinSteer 1.7045 → 2.5, turboSpinup 1 → 0.5 (boost spools 2× faster). ' +
    'awd_wrc: AWD base split fs 1 → 0.8 (50/50 → 40/60 F/R), momentZDist 0.080 → 0.06. ' +
    'fwd_hatch: fwdFrontBias 1.5 → 1.1 (75/25 → 55/45 F/R), momentZDist 0.080 → 0.04. rwd_classic: shared changes only.',
  all: {
    wheel: { front: { twKinSteer: 2.5 }, rear: { twKinSteer: 2.5 } },
    turboSpinup: 0.5,
  },
  perArchetype: {
    awd_wrc: {
      setup: { awdBaseSplit: 0.8 },
      wheel: { front: { momentZDist: 0.06 }, rear: { momentZDist: 0.06 } },
    },
    fwd_hatch: {
      fwdFrontBias: 1.1,
      wheel: { front: { momentZDist: 0.04 }, rear: { momentZDist: 0.04 } },
    },
  },
};

/**
 * The original's class-4 4WD cars (the high-power 1980s class: five AWD cars, spec §3.2 v1.3), per-field medians of
 * the shipped car files: mass 910-1298 → 1030 kg, TorqueScale 1300-1900 → 1340, 5 gears (all identical),
 * TurboSize 1 (one car has 0), wheel bundle FL (-0.698, 0.56, 1.077), RL (-0.750, 0.56, -1.323) → wheelbase 2.40 m,
 * front axle 55.1 %; hull ±2.0 m (collision-point medians 2.001 / -1.992). Everything else is shared by all cars.
 */
const CLASS4_AWD: TuningPreset = {
  id: 'orig-class4-awd',
  label: 'orig: class-4 AWD car',
  kind: 'original',
  description:
    'Original car data, not a deviation: the medians of the five class-4 (high-power) 4WD cars on the awd_wrc body. ' +
    'mass 1030, torqueScale 1340, 5 gears, wheelbase 2.40 m (55 % front). Power-to-weight 1.30 against 0.76 N·m/kg.',
  archetype: 'awd_wrc',
  perArchetype: {
    awd_wrc: {
      mass: 1030,
      torqueScale: 1340,
      turboSize: 1,
      nGears: 5,
      gearRatio: [-3.3, 3.42, 2.15, 1.52, 1.17, 0.75],
      gearSpeed: [0, 0, 0, 0, 0],
      wheelFL: { x: -0.698, y: 0.56, z: 1.077 },
      wheelRL: { x: -0.75, y: 0.56, z: -1.323 },
      hullFrontZ: 2.0,
      hullRearZ: -2.0,
    },
  },
};

export const TUNING_PRESETS: readonly TuningPreset[] = Object.freeze([ARCADE_DRIFT, CLASS4_AWD]);

/** The merged overrides a preset applies to `archetype` (a fresh object). */
export function presetOverrides(preset: TuningPreset, archetype: ArchetypeId): DeepPartial<CarParams> {
  const out: DeepPartial<CarParams> = {};
  if (preset.all) deepMergeInto(out, deepClone(preset.all));
  const per = preset.perArchetype?.[preset.archetype ?? archetype];
  if (per) deepMergeInto(out, deepClone(per));
  return out;
}

/**
 * Full parameter set: the SHIPPED parameters of the preset's archetype (or `archetype`), then `keep` (the race
 * selection choices to preserve), then the preset's overrides.
 */
export function presetCarParams(preset: TuningPreset, archetype: ArchetypeId, keep?: DeepPartial<CarParams>): CarParams {
  const target = preset.archetype ?? archetype;
  const p = makeCarParams(target, keep);
  deepMergeInto(p, presetOverrides(preset, target));
  return p;
}
