/**
 * Every §6 key in the tuning panel schema must address a real parameter of the live tunables (otherwise the
 * panel silently skips it). Uses the real sim parameter sets; the camera defaults come from the renderer
 * (skipped if that module cannot load in node).
 */
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_IDS, SURFACE_IDS } from '../../src/core/constants';
import { getPath } from '../../src/core/paths';
import type { GameTunables } from '../../src/core/types';
import { CAMERA_KEYS, SURFACE_KEYS, SURFACE_TYRE_KEYS, TUNING_SCHEMA } from '../../src/debug/tuningSchema';
import { makeInputFilterConfig } from '../../src/sim/inputFilter';
import { makeCarParams, makeSurfaceTable } from '../../src/sim/params';

async function tunables(): Promise<{ t: GameTunables; camera: boolean }> {
  let camera: GameTunables['camera'] | null = null;
  try {
    camera = (await import('../../src/render/renderer')).makeCameraTuning();
  } catch {
    camera = null;
  }
  return {
    t: {
      car: makeCarParams('awd_wrc'),
      input: makeInputFilterConfig(),
      camera: camera as GameTunables['camera'],
      surfaces: makeSurfaceTable(),
      loop: { timeScale: 1, physicsHz: 120 },
    },
    camera: camera !== null,
  };
}

/** Same routing as main.ts / ITuningHost.setParam. */
function resolve(t: GameTunables, path: string): unknown {
  const segs = path.split('.');
  const roots = ['car', 'input', 'camera', 'surfaces', 'loop'];
  if (roots.includes(segs[0]) && segs.length > 1) return getPath((t as unknown as Record<string, unknown>)[segs[0]], segs.slice(1).join('.'));
  return getPath(t.car, path);
}

describe('tuning schema (§6)', () => {
  it('every car / input / loop path exists, with a sane range around the shipped value', async () => {
    const { t } = await tunables();
    const missing: string[] = [];
    for (const f of TUNING_SCHEMA) {
      for (const p of f.params) {
        for (const path of p.paths) {
          const v = resolve(t, path);
          if (v === undefined) missing.push(path);
          if (typeof v === 'number' && p.min !== undefined && p.max !== undefined && !p.derived) {
            expect(p.max, path).toBeGreaterThan(p.min);
            if (!path.startsWith('setup.')) {
              expect(v, `${path} default inside [min, max]`).toBeGreaterThanOrEqual(p.min - 1e-9);
              expect(v, `${path} default inside [min, max]`).toBeLessThanOrEqual(p.max + 1e-9);
            }
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('mountY derives from the wheel centre (§3.2: 0.23 / 0.27 / 0.18)', () => {
    const expected = { awd_wrc: 0.23, fwd_hatch: 0.27, rwd_classic: 0.18 };
    for (const id of ARCHETYPE_IDS) {
      const p = makeCarParams(id);
      expect(p.wheelFL.y - p.wheelRadius).toBeCloseTo(expected[id], 6);
    }
  });

  it('surface keys exist for every surface and tyre type', async () => {
    const { t } = await tunables();
    for (const s of SURFACE_IDS) {
      for (const k of SURFACE_KEYS) expect(getPath(t.surfaces, `${s}.${k.paths[0]}`), `${s}.${k.paths[0]}`).not.toBeUndefined();
      for (let ty = 0; ty < 5; ty++) for (const k of SURFACE_TYRE_KEYS) expect(getPath(t.surfaces, `${s}.tyre.${ty}.${k.paths[0]}`)).not.toBeUndefined();
    }
  });

  it('camera keys exist', async () => {
    const { t, camera } = await tunables();
    if (!camera) return;
    for (const k of CAMERA_KEYS) expect(resolve(t, k.paths[0]), k.paths[0]).not.toBeUndefined();
    for (const m of ['chaseNear', 'chase', 'chaseFar', 'chaseHigh']) expect(resolve(t, `camera.chase.${m}.posA.y`)).toBeTypeOf('number');
  });
});
