/**
 * tests/contracts/phase2.test.ts — ARCHITECT-OWNED. Pins the phase-2 seams (docs/PHASE2_AI.md): the solo race must stay
 * exactly the solo race while the AI-brain / AI-race / sim-contact / ghosts builders fill the stubs in.
 * Builders: when you replace a stub, keep these tests green (they only assert the solo / no-opponent behaviour and the
 * shape of the seams); add your own tests in your own files.
 */
import { describe, expect, it } from 'vitest';
import { MAX_OPPONENTS, aiCarId, emptyFieldSnapshot, slotBaseOfGrid } from '../../src/core/field';
import { PORTED_ORDER } from '../../src/world/ports';
import { buildStage } from '../../src/world/stages';
import { CarField } from '../../src/game/field';
import { gridSlot, stageGrid, stageSpawnGrid } from '../../src/game/grid';
import { buildRoster } from '../../src/game/ai/roster';
import { createAiDriver } from '../../src/game/ai/driver';
import { loadAiSchedule, loadAiStageData } from '../../src/game/ai/aidata';
import { stepCarContacts } from '../../src/sim/contact';
import { RaceController } from '../../src/game/race';
import { MemoryStore } from '../../src/game/storage';
import { simPoseOnStage } from '../../src/core/stageUtil';

describe('field contract', () => {
  it('ids and slot bases', () => {
    expect(MAX_OPPONENTS).toBe(3);
    expect(aiCarId(1)).toBe('ai1');
    expect(slotBaseOfGrid(0)).toBe(0);
    expect(slotBaseOfGrid(3)).toBe(72);
    expect(emptyFieldSnapshot()).toEqual({ opponents: 0, cars: [], standings: [], playerPosition: 1, fieldSize: 1 });
  });

  it('an empty field is inert', async () => {
    const f = new CarField();
    const { stage, world } = buildStage('testpad', 1);
    const specs = await f.prepare({ stageId: 'testpad', archetype: 'awd_wrc', tyre: 0, transmission: 'auto', setup: {}, steerSensFast: true, seed: 1 }, stage, world, {
      createCar() {
        throw new Error('no cars expected');
      },
    });
    expect(specs).toEqual([]);
    expect(f.sims).toHaveLength(0);
    expect(f.renderStates(0.5)).toHaveLength(0);
    expect(f.snapshot().opponents).toBe(0);
    expect(f.drainEvents()).toEqual([]);
  });

  it('the roster stub has no opponents; the AI data loaders resolve null; contacts are a no-op', async () => {
    const { stage } = buildStage('testpad', 1);
    expect(buildRoster({ stageId: 'testpad', archetype: 'awd_wrc', tyre: 0, transmission: 'auto', setup: {}, steerSensFast: true, seed: 1, opponents: 3 }, stage)).toEqual([]);
    expect(await loadAiStageData('corsica-1-f')).toBeNull();
    expect(await loadAiSchedule('corsica-1-f', 'Micra', null)).toBeNull();
    expect(stepCarContacts([], 1 / 120)).toEqual({ pairs: 0, maxImpulse: 0 });
  });

  it('createAiDriver returns parked controls until the race runs', () => {
    const { stage, world } = buildStage('testpad', 1);
    const d = createAiDriver({
      spec: { id: 'ai1', origCar: 'Micra', archetype: 'fwd_hatch', name: 'x', skill: 1, tyreScale: 1, gridIndex: 1, slotBase: 24 },
      stage,
      world,
      data: null,
      schedule: null,
    });
    expect(typeof d.placeholder).toBe('boolean');
    const c = d.update({ dt: 1 / 120, self: null as never, s: 0, lateral: 0, lapDist: 0, others: [], raceTime: 0, running: false });
    expect(c.handbrake).toBe(1);
  });
});

describe('grid', () => {
  it('a single car stands on the spawn grid centre line (the solo race, unchanged)', () => {
    expect(gridSlot([171, 2, 6], 0, 1)).toEqual({ s: 171, lateral: 0 });
  });

  it('every ported stage carries race.spawnGrid verbatim with the car at its spawn s', () => {
    for (const id of PORTED_ORDER) {
      const { stage } = buildStage(id, 1);
      const g = stageSpawnGrid(stage);
      expect(g, id).not.toBeNull();
      const spawnS = (stage as unknown as { spawnS: number }).spawnS;
      const L = stage.length;
      // closed circuits: spawnS is wrapped into one lap, the grid keeps the archive's number
      expect(stage.closed ? ((g![0] % L) + L) % L : g![0], id).toBeCloseTo(spawnS, 6);
      expect(stageGrid(stage, 8)).toBe(g);
    }
  });

  it('procedural stages get a synthetic grid behind the line', () => {
    const { stage } = buildStage('testpad', 1);
    expect(stageSpawnGrid(stage)).toBeNull();
    const g = stageGrid(stage, 8);
    const L = stage.length;
    expect(g[0]).toBeCloseTo(stage.closed ? (((stage.startS - 8) % L) + L) % L : Math.max(0, stage.startS - 8), 6);
  });
});

describe('race controller seams', () => {
  it('a solo begin() with the new options places the car exactly as before', () => {
    const { stage, world } = buildStage('testpad', 1);
    const mk = () => {
      const poses: unknown[] = [];
      const car = {
        id: 'player',
        archetype: 'awd_wrc',
        params: { archetype: 'awd_wrc' },
        reset: (p: unknown) => void poses.push(p),
        step() {},
        telemetry: () => null,
        pose: () => null,
        setParams() {},
        setSurfaces() {},
        setWorld() {},
        setParked() {},
        setFrozen() {},
      };
      return { car, poses };
    };
    const a = mk();
    const b = mk();
    const r1 = new RaceController({ store: new MemoryStore(), startGridBack: 8 });
    const r2 = new RaceController({ store: new MemoryStore(), startGridBack: 8 });
    r1.begin(stage, a.car as never, { countdown: false, world });
    r2.begin(stage, b.car as never, { countdown: false, world, gridIndex: 0, gridCount: 1 });
    expect(b.poses).toEqual(a.poses);
    expect(a.poses.length).toBeGreaterThan(0);
    void simPoseOnStage;
  });

  it('ghost seams exist and are inert in the stub', async () => {
    const r = new RaceController({ store: new MemoryStore() });
    expect(r.ghostInfos()).toEqual([]);
    expect(await r.listGhosts('corsica-1-f')).toEqual([]);
    expect(r.canSaveGhost()).toBe(false);
  });
});
