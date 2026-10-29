/**
 * tests/contracts/core.test.ts — ARCHITECT-OWNED. Checks the shared math / space / loop / path contracts.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_IDS, DT, MATERIAL, SURFACE_IDS } from '../../src/core/constants';
import { FixedStepLoop } from '../../src/core/loop';
import { cross, qAxes, qFromBasis, qIntegrate, qLookSim, qRotate, qYawSim, type V3 } from '../../src/core/math';
import { getPath, partialFromPath, setPath, deepMergeInto } from '../../src/core/paths';
import { mirror, mirrorQuat, setThreeQuat } from '../../src/core/space';
import { ARCHETYPE_PARAMS, DEFAULT_SURFACE_TABLE, makeCarParams, muStatic } from '../../src/sim/params';

const close = (a: V3, b: V3) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
  expect(a.z).toBeCloseTo(b.z, 9);
};

describe('math (sim space, §1.1/§2.5.0)', () => {
  it('cross(up, fwd) = right and cross(fwd, right) = up', () => {
    close(cross({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }), { x: 1, y: 0, z: 0 });
    close(cross({ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }), { x: 0, y: 1, z: 0 });
  });
  it('positive yaw rate turns the nose right (+x)', () => {
    let q = qYawSim(0);
    for (let i = 0; i < 120; i++) q = qIntegrate(q, { x: 0, y: 0.5, z: 0 }, DT);
    const f = qAxes(q).fwd;
    expect(f.x).toBeGreaterThan(0.4);
    expect(Math.atan2(f.x, f.z)).toBeCloseTo(0.5, 5);
  });
  it('qFromBasis inverts qAxes', () => {
    const q0 = qLookSim({ x: 0.3, y: -0.2, z: 0.9 });
    const ax = qAxes(q0);
    const q1 = qFromBasis(ax.right, ax.up, ax.fwd);
    close(qAxes(q1).fwd, ax.fwd);
    close(qAxes(q1).up, ax.up);
    expect(Math.abs(ax.right.y)).toBeLessThan(1e-12); // zero roll
  });
});

describe('space mirror (§1.1)', () => {
  it('rotating in sim then mirroring equals mirroring then rotating in three', () => {
    const qSim = qLookSim({ x: 0.5, y: 0.1, z: -0.4 });
    const vBody = { x: 0.3, y: -0.7, z: 1.9 };
    const a = mirror(qRotate(qSim, vBody));
    const tq = setThreeQuat(new THREE.Quaternion(), qSim);
    const b = new THREE.Vector3(vBody.x, vBody.y, -vBody.z).applyQuaternion(tq);
    close(a, { x: b.x, y: b.y, z: b.z });
    const mq = mirrorQuat(qSim);
    expect([mq.x, mq.y, mq.z, mq.w]).toEqual([tq.x, tq.y, tq.z, tq.w]);
  });
  it('sim forward (+z) is three -Z', () => {
    const tq = setThreeQuat(new THREE.Quaternion(), qYawSim(0));
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(tq);
    expect(f.z).toBeCloseTo(-1, 12);
  });
});

describe('FixedStepLoop (§1.2)', () => {
  it('120 Hz accumulator with 0.2 s clamp and timeScale', () => {
    const l = new FixedStepLoop();
    expect(l.advance(1 / 60).steps).toBe(2);
    expect(l.advance(1.0).steps).toBe(24); // clamped to 0.2 s
    l.timeScale = 0.5;
    let n = 0;
    for (let i = 0; i < 60; i++) n += l.advance(1 / 60).steps;
    expect(n).toBe(60);
    l.paused = true;
    expect(l.advance(1 / 60).steps).toBe(0);
    l.requestSteps(3);
    expect(l.advance(1 / 60).steps).toBe(3);
  });
});

describe('paths', () => {
  it('get/set/partial', () => {
    const p = makeCarParams('awd_wrc');
    expect(getPath(p, 'wheel.front.springK')).toBe(35000);
    setPath(p, 'wheel.front.springK', 40000);
    expect(p.wheel.front.springK).toBe(40000);
    expect(() => setPath(p, 'wheel.front.nope', 1)).toThrow();
    const part = partialFromPath('gearRatio.2', 2.0, p);
    deepMergeInto(p, part);
    expect(p.gearRatio).toEqual([-3.3, 3.35, 2.0, 1.55, 1.22, 0.97, 0.84]);
    expect(ARCHETYPE_PARAMS.awd_wrc.gearRatio[2]).toBe(2.15); // originals untouched
  });
});

describe('parameter data (§3, §4)', () => {
  it('archetypes are complete and consistent', () => {
    for (const id of ARCHETYPE_IDS) {
      const p = ARCHETYPE_PARAMS[id];
      expect(p.archetype).toBe(id);
      expect(p.gearRatio).toHaveLength(p.nGears + 1);
      expect(p.gearRatio[0]).toBeLessThan(0);
    }
  });
  it('surface table matches §4.3 static mu values', () => {
    expect(SURFACE_IDS.map((s) => DEFAULT_SURFACE_TABLE[s].material)).toEqual(SURFACE_IDS.map((s) => MATERIAL[s]));
    expect(muStatic(DEFAULT_SURFACE_TABLE.tarmac, 0)).toBeCloseTo(2.407, 3);
    expect(muStatic(DEFAULT_SURFACE_TABLE.snow, 0)).toBeCloseTo(0.34, 2);
    expect(muStatic(DEFAULT_SURFACE_TABLE.ice, 0)).toBeCloseTo(0.095, 3);
    expect(muStatic(DEFAULT_SURFACE_TABLE.water, 0)).toBeCloseTo(1.895, 3);
    expect(muStatic(DEFAULT_SURFACE_TABLE.gravel, 2)).toBeCloseTo(1.775, 3);
  });
});

describe('key bindings (constants mirror src/input/bindings.ts)', () => {
  it('DEFAULT_KEYS equals the input module GAME_KEYS and UI_KEYS lists the UI bindings', async () => {
    const { DEFAULT_KEYS, UI_KEYS } = await import('../../src/core/constants');
    const { GAME_KEYS, UI_BINDINGS } = await import('../../src/input/bindings');
    expect(DEFAULT_KEYS).toEqual(GAME_KEYS);
    const ui = UI_KEYS as Record<string, readonly string[]>;
    const map: Record<string, string> = { menu: 'menu', restart: 'restart', tuning: 'toggleTuning', overlay: 'toggleOverlay', help: 'help', step: 'step', slower: 'slower', faster: 'faster', autopilot: 'autopilot', voice: 'voice' };
    for (const [k, codes] of Object.entries(UI_BINDINGS)) expect(ui[map[k]], k).toEqual(codes);
    // no key is bound twice across driving and UI
    const all = [...Object.values(GAME_KEYS).flat(), ...Object.values(UI_KEYS).flat()];
    expect(new Set(all).size).toBe(all.length);
  });
});
