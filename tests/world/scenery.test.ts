/**
 * tests/world/scenery.test.ts — scenery orientation conventions shared with the renderer's models
 * (front = local -Z, linear props have their long axis on local X, chevron arrows point +X) and the gates.
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import type { BuiltStage, SceneryKind } from '../../src/core/types';
import { alongRoadRotY, chevronRotY } from '../../src/world/scenery';
import { buildStage, listStages } from '../../src/world/stages';

/** THREE rotation.y applied to a local (x, z) vector. */
const rotY = (theta: number, x: number, z: number): { x: number; z: number } => ({
  x: x * Math.cos(theta) + z * Math.sin(theta),
  z: -x * Math.sin(theta) + z * Math.cos(theta),
});

const built = new Map<string, BuiltStage>();
const get = (id: string): BuiltStage => {
  let b = built.get(id);
  if (!b) built.set(id, (b = buildStage(id, 5)));
  return b;
};

describe('orientation helpers', () => {
  it('alongRoadRotY puts local X along the road and the front (-Z) toward it', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 200; i++) {
      const a = rng.next() * Math.PI * 2;
      const hx = Math.sin(a), hz = -Math.cos(a); // travel direction (three space)
      const right = { x: -hz, z: hx };
      for (const side of [-1, 1]) {
        const th = alongRoadRotY(hx, hz, side);
        const X = rotY(th, 1, 0);
        expect(Math.abs(X.x * hx + X.z * hz)).toBeCloseTo(1, 9);
        const front = rotY(th, 0, -1);
        // a prop on `side` faces back across the road: front · right = -side
        expect(front.x * right.x + front.z * right.z).toBeCloseTo(-side, 9);
      }
    }
  });

  it('chevronRotY sets the board across the road with +X pointing into the bend', () => {
    const rng = new Rng(4);
    for (let i = 0; i < 200; i++) {
      const a = rng.next() * Math.PI * 2;
      const hx = Math.sin(a), hz = -Math.cos(a);
      const right = { x: -hz, z: hx };
      for (const turn of [-1, 1]) {
        const th = chevronRotY(hx, hz, turn);
        const X = rotY(th, 1, 0);
        expect(X.x * right.x + X.z * right.z).toBeCloseTo(turn, 9);
        const Z = rotY(th, 0, 1);
        expect(Math.abs(Z.x * hx + Z.z * hz)).toBeCloseTo(1, 9);
      }
    }
  });
});

describe('placed scenery', () => {
  const LINEAR: SceneryKind[] = ['snowbank', 'fence', 'banner', 'barrier'];

  it.each(listStages().map((s) => [s.id]))('%s: linear props run along the road and face it', (id) => {
    const { stage } = get(id);
    let n = 0;
    for (const sc of stage.scenery) {
      if (!LINEAR.includes(sc.kind)) continue;
      const pr = stage.project(sc.pos);
      if (Math.abs(pr.lateral) > 25) continue; // far props (e.g. paddock fences) are not tied to the line
      const t = stage.tangentAt(pr.s);
      const tl = Math.hypot(t.x, t.z);
      const X = rotY(sc.rotY, 1, 0);
      expect(Math.abs((X.x * t.x + X.z * t.z) / tl)).toBeGreaterThan(0.94); // within ~20° of the tangent
      const front = rotY(sc.rotY, 0, -1);
      const toRoad = { x: pr.point.x - sc.pos.x, z: pr.point.z - sc.pos.z };
      expect(front.x * toRoad.x + front.z * toRoad.z).toBeGreaterThan(0);
      n++;
    }
    if (id === 'frostvale' || id === 'lake-skoga' || id === 'kettle-park') expect(n).toBeGreaterThan(50);
  });

  it.each(['pine-ridge', 'col-du-vent', 'frostvale', 'red-basin'])('%s: corner chevrons point into the bend', (id) => {
    const { stage } = get(id);
    const chevrons = stage.scenery.filter((s) => s.kind === 'marker');
    expect(chevrons.length).toBeGreaterThan(2);
    for (const c of chevrons) {
      const pr = stage.project(c.pos);
      const t = stage.tangentAt(pr.s);
      const tl = Math.hypot(t.x, t.z);
      // chevrons stand on the OUTSIDE of the bend: the bend turns away from their side
      const turn = pr.lateral > 0 ? -1 : 1;
      const right = { x: -t.z / tl, z: t.x / tl };
      const X = rotY(c.rotY, 1, 0);
      expect(Math.sign(X.x * right.x + X.z * right.z)).toBe(turn);
    }
  });

  it.each(listStages().map((s) => [s.id]))('%s: gates sit on the centre line at start / splits / finish', (id) => {
    const { stage } = get(id);
    const gates = stage.scenery.filter((s) => s.kind === 'startGate' || s.kind === 'checkpointGate' || s.kind === 'finishGate');
    for (const g of gates) {
      expect(g.radius).toBe(0);
      expect(Math.abs(stage.project(g.pos).lateral)).toBeLessThan(0.5);
    }
    const splits = gates.filter((g) => g.kind === 'checkpointGate').map((g) => stage.project(g.pos).s);
    if (stage.closed) {
      expect(splits.length).toBe(0);
      expect(gates.filter((g) => g.kind === 'startGate').length).toBe(1);
    } else {
      expect(splits.length).toBe(stage.checkpoints.length);
      splits.forEach((s, i) => expect(Math.abs(s - stage.checkpoints[i])).toBeLessThan(1.5));
      expect(Math.abs(stage.project(gates.find((g) => g.kind === 'finishGate')!.pos).s - stage.finishS)).toBeLessThan(1.5);
    }
  });
});
