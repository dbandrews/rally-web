/**
 * tests/world/stages.test.ts — determinism per seed, no NaN anywhere, scenery clearance, pacenote and
 * timing structure, catalogue facts, build budget.
 */
import { describe, expect, it } from 'vitest';
import { MATERIAL_NONE, SURFACE_IDS } from '../../src/core/constants';
import type { BuiltStage, PacenoteModifier, Stage } from '../../src/core/types';
import { buildStage, listStages } from '../../src/world/stages';

function digest(st: Stage): string {
  let h = 2166136261;
  const mix = (v: number): void => {
    h ^= Math.round(v * 1000) | 0;
    h = Math.imul(h, 16777619);
  };
  const hf = st.heightfield;
  for (let i = 0; i < hf.heights.length; i += 7) mix(hf.heights[i]);
  for (let i = 0; i < hf.materials.length; i += 7) mix(hf.materials[i]);
  for (const r of st.road) mix(r.pos.x + r.pos.y * 3 + r.pos.z * 7 + r.width);
  for (const s of st.scenery) mix(s.pos.x + s.pos.z * 3 + s.radius);
  for (const p of st.pacenotes) mix(p.s + p.severity);
  return `${h >>> 0}:${hf.nx}x${hf.nz}:${st.road.length}:${st.scenery.length}:${st.pacenotes.length}`;
}

const finite = (...v: number[]): boolean => v.every((x) => Number.isFinite(x));
const MODS: PacenoteModifier[] = ['long', 'short', 'tightens', 'opens', 'into', 'dontCut', 'cut', 'crest', 'jump', 'bump', 'caution', 'narrows', 'bridge', 'water', 'surfaceChange', 'overFinish'];

const cache = new Map<string, { b: BuiltStage; ms: number }>();
const get = (id: string): { b: BuiltStage; ms: number } => {
  let e = cache.get(id);
  if (!e) {
    const t0 = performance.now();
    const b = buildStage(id, 1);
    cache.set(id, (e = { b, ms: performance.now() - t0 }));
  }
  return e;
};

describe('catalogue', () => {
  it('lists the seven original stages, a real stage first and the testpad', () => {
    const l = listStages();
    expect(l.map((s) => s.id)).toEqual(['pine-ridge', 'col-du-vent', 'frostvale', 'red-basin', 'kettle-park', 'lake-skoga', 'testpad']);
    expect(l.map((s) => s.name)).toEqual(['Pine Ridge', 'Col du Vent', 'Frostvale', 'Red Basin', 'Kettle Park', 'Lake Skoga', 'Proving Ground']);
    const kp = l.find((s) => s.id === 'kettle-park')!;
    expect(kp.closed && kp.laps === 3 && kp.discipline === 'rallycross').toBe(true);
    const ls = l.find((s) => s.id === 'lake-skoga')!;
    expect(ls.closed && ls.laps === 4 && ls.discipline === 'ice').toBe(true);
    expect(l.find((s) => s.id === 'testpad')!.discipline).toBe('testpad');
    // listStages returns fresh copies
    l[0].name = 'x';
    expect(listStages()[0].name).toBe('Pine Ridge');
  });

  it('stage lengths are close to the catalogue lengths', () => {
    for (const e of listStages()) {
      const { b } = get(e.id);
      expect(Math.abs(b.stage.length - e.approxLength) / e.approxLength).toBeLessThan(0.15);
    }
  });
});

describe.each(listStages().map((s) => [s.id, s] as const))('stage %s', (id, entry) => {
  it('is deterministic per seed and varies with the seed', () => {
    const a = buildStage(id, 42);
    const b = buildStage(id, 42);
    expect(digest(a.stage)).toBe(digest(b.stage));
    expect(JSON.stringify(a.stage.pacenotes)).toBe(JSON.stringify(b.stage.pacenotes));
    expect(a.world.heightAt(12.3, -45.6)).toBe(b.world.heightAt(12.3, -45.6));
    if (id !== 'testpad') expect(digest(buildStage(id, 43).stage)).not.toBe(digest(a.stage));
  });

  it('builds within budget with a sensible heightfield', () => {
    const { b, ms } = get(id);
    expect(ms).toBeLessThan(3000);
    const hf = b.stage.heightfield;
    expect(hf.nx * hf.nz).toBeLessThanOrEqual(400_000);
    expect(hf.cellSize).toBeGreaterThanOrEqual(2);
    expect(hf.cellSize).toBeLessThanOrEqual(3.5);
    // the road (with a margin) is inside the heightfield
    const x1 = hf.originX + (hf.nx - 1) * hf.cellSize;
    const z1 = hf.originZ + (hf.nz - 1) * hf.cellSize;
    for (const r of b.stage.road) {
      expect(r.pos.x).toBeGreaterThan(hf.originX + 30);
      expect(r.pos.x).toBeLessThan(x1 - 30);
      expect(r.pos.z).toBeGreaterThan(hf.originZ + 30);
      expect(r.pos.z).toBeLessThan(z1 - 30);
    }
  });

  it('contains no NaN / invalid data', () => {
    const st = get(id).b.stage;
    for (const h of st.heightfield.heights) expect(Number.isFinite(h)).toBe(true);
    for (const m of st.heightfield.materials) expect(m < SURFACE_IDS.length || m === MATERIAL_NONE).toBe(true);
    expect(st.heightfield.materials.every((m) => m !== MATERIAL_NONE)).toBe(true);
    for (const r of st.road) {
      expect(finite(r.s, r.width, r.bank, r.pos.x, r.pos.y, r.pos.z, r.left.x, r.left.y, r.left.z, r.right.x, r.right.y, r.right.z)).toBe(true);
      expect(r.width).toBeGreaterThan(5.5);
      expect(r.width).toBeLessThan(16);
    }
    for (const sc of st.scenery) {
      expect(finite(sc.pos.x, sc.pos.y, sc.pos.z, sc.rotY, sc.scale, sc.radius, sc.height)).toBe(true);
      expect(sc.scale).toBeGreaterThan(0);
      expect(sc.height).toBeGreaterThan(0);
    }
    const env = st.environment;
    expect(finite(env.timeOfDay, env.fogNear, env.fogFar, env.sunIntensity, env.ambientIntensity, env.exposure, env.sunDir.x, env.sunDir.y, env.sunDir.z)).toBe(true);
    expect(Math.hypot(env.sunDir.x, env.sunDir.y, env.sunDir.z)).toBeCloseTo(1, 6);
    expect(env.fogFar).toBeGreaterThan(env.fogNear);
    expect(st.length).toBeGreaterThan(500);
  });

  it('keeps colliding scenery at least 3 m clear of the road edge', () => {
    const st = get(id).b.stage;
    let colliding = 0;
    for (const sc of st.scenery) {
      if (sc.radius <= 0) continue;
      colliding++;
      const pr = st.project(sc.pos);
      const e = Math.abs(pr.lateral) - st.roadAt(pr.s).width / 2 - sc.radius;
      expect(e).toBeGreaterThan(2.95);
    }
    expect(colliding).toBeGreaterThan(id === 'testpad' ? 20 : 100);
  });

  it('has a drivable start on a straight, and well-formed timing', () => {
    const st = get(id).b.stage;
    const hor = (v: { x: number; z: number }) => {
      const l = Math.hypot(v.x, v.z);
      return { x: v.x / l, z: v.z / l };
    };
    const t0 = hor(st.tangentAt(st.startS));
    for (const ds of [-15, 15, 30]) {
      const t = hor(st.tangentAt(st.startS + ds));
      expect(t.x * t0.x + t.z * t0.z).toBeGreaterThan(0.99);
    }
    const sp = st.project(st.startPose.pos);
    expect(Math.abs(sp.lateral)).toBeLessThan(0.1);
    const d0 = hor(st.startPose.dir);
    expect(d0.x * t0.x + d0.z * t0.z).toBeGreaterThan(0.999);
    if (st.closed) {
      expect(st.startS).toBe(0);
      expect(st.finishS).toBe(0);
      expect(st.checkpoints.length).toBe(2);
      expect(st.validRange).toEqual([0, st.length]);
    } else {
      expect(st.checkpoints.length).toBe(3);
      expect(st.checkpoints[0]).toBeGreaterThan(st.startS);
      expect(st.checkpoints[2]).toBeLessThan(st.finishS);
      expect(st.finishS).toBeLessThan(st.length - 40);
      expect(st.validRange[0]).toBeLessThan(st.startS);
    }
    expect(st.laps).toBe(entry.laps);
  });

  it('pacenotes are sorted, positioned before their features and use the 1-6 scale', () => {
    const st = get(id).b.stage;
    if (st.closed || st.discipline === 'testpad') {
      expect(st.pacenotes.length).toBe(0);
      return;
    }
    const notes = st.pacenotes;
    expect(notes.length).toBeGreaterThan(10);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (i > 0) expect(n.s).toBeGreaterThan(notes[i - 1].s);
      expect(n.s).toBeLessThanOrEqual(n.cornerS);
      expect(n.s).toBeGreaterThanOrEqual(0);
      expect(n.text.length).toBeGreaterThan(0);
      expect([0, 1, 2, 3, 4, 5, 6]).toContain(n.severity);
      expect(['left', 'right', 'straight']).toContain(n.direction);
      if (n.direction === 'straight') expect(n.severity).toBe(0);
      else expect(n.severity).toBeGreaterThan(0);
      for (const m of n.modifiers) expect(MODS).toContain(m);
      // the direction matches the curvature just after the corner entry
      if (n.direction !== 'straight') {
        const a = st.tangentAt(n.cornerS);
        const b = st.tangentAt(n.cornerS + 12);
        const turn = a.x * b.z - a.z * b.x; // three space: > 0 = turning right
        expect(Math.sign(turn)).toBe(n.direction === 'right' ? 1 : -1);
      }
    }
    expect(notes[notes.length - 1].modifiers).toContain('overFinish');
    expect(notes.some((n) => n.direction !== 'straight')).toBe(true);
  });
});

describe('stage features', () => {
  // Spec §4.3 v1.3: the original's forest rally stages are 98-100 % MUD on the road, its desert rally stages ≈ 78 %
  // SAND / 14 % ASPHALT / 8 % GRAVEL (per-face materials of the original's collision meshes).
  const timedShares = (st: Stage): Record<string, number> => {
    const lo = st.closed ? 0 : st.startS;
    const hi = st.closed ? st.length : st.finishS;
    const c: Record<string, number> = {};
    let n = 0;
    for (const r of st.road) if (r.s >= lo && r.s <= hi) {
      c[r.surface] = (c[r.surface] ?? 0) + 1;
      n++;
    }
    for (const k of Object.keys(c)) c[k] /= n;
    return c;
  };

  it('Pine Ridge is a mud forest rally (≥ 97 % mud) with a jump, crests, a water splash, a hamlet and hairpins', () => {
    const st = get('pine-ridge').b.stage;
    expect(new Set(st.road.map((r) => r.surface))).toEqual(new Set(['mud', 'water']));
    expect(timedShares(st).mud).toBeGreaterThanOrEqual(0.97);
    const mods = new Set(st.pacenotes.flatMap((p) => p.modifiers));
    for (const m of ['crest', 'jump', 'water']) expect(mods.has(m as PacenoteModifier) || st.pacenotes.some((p) => p.text.includes(m))).toBe(true);
    expect(st.pacenotes.some((p) => p.text.includes('hairpin'))).toBe(true);
    expect(st.scenery.filter((s) => s.kind === 'house' || s.kind === 'barn').length).toBeGreaterThanOrEqual(3);
  });

  it('Col du Vent climbs steeply on tarmac with hairpins', () => {
    const st = get('col-du-vent').b.stage;
    const climb = st.pointAt(st.finishS).y - st.pointAt(st.startS).y;
    expect(climb).toBeGreaterThan(180);
    expect(st.pacenotes.filter((p) => p.text.includes('hairpin')).length).toBeGreaterThanOrEqual(4);
    expect(st.road.filter((r) => r.surface === 'tarmac').length / st.road.length).toBeGreaterThan(0.85);
  });

  it('Frostvale is snow with ice patches; Lake Skoga is ice lined with snowbanks', () => {
    const fv = get('frostvale').b.stage;
    expect(new Set(fv.road.map((r) => r.surface))).toEqual(new Set(['snow', 'ice']));
    const ls = get('lake-skoga').b;
    expect(new Set(ls.stage.road.map((r) => r.surface))).toEqual(new Set(['ice']));
    expect(ls.stage.scenery.filter((s) => s.kind === 'snowbank').length).toBeGreaterThan(100);
    // the berm rises beside the track
    const r = ls.stage.road[40];
    const t = ls.stage.tangentAt(r.s);
    const off = r.width / 2 + 6;
    expect(ls.world.heightAt(r.pos.x - t.z * off, -(r.pos.z + t.x * off))).toBeGreaterThan(r.pos.y + 0.3);
  });

  it('Kettle Park is a 12 m tarmac/gravel circuit with a jump', () => {
    const st = get('kettle-park').b.stage;
    const tarmac = st.road.filter((r) => r.surface === 'tarmac').length / st.road.length;
    expect(tarmac).toBeGreaterThan(0.3);
    expect(tarmac).toBeLessThan(0.75);
    expect(Math.min(...st.road.map((r) => r.width))).toBeGreaterThan(11);
    const ys = st.road.map((r) => r.pos.y);
    let maxRise = 0;
    for (let i = 5; i < ys.length; i++) maxRise = Math.max(maxRise, ys[i] - ys[i - 5]);
    expect(maxRise).toBeGreaterThan(0.6);
  });

  it('Red Basin is wide, fast sand (≈ 78 %) with tarmac (≈ 14 %) and gravel (≈ 8 %) stretches and jumps', () => {
    const st = get('red-basin').b.stage;
    expect(new Set(st.road.map((r) => r.surface))).toEqual(new Set(['sand', 'tarmac', 'gravel']));
    const sh = timedShares(st);
    expect(sh.sand).toBeGreaterThan(0.68);
    expect(sh.sand).toBeLessThan(0.86);
    expect(sh.tarmac).toBeGreaterThan(0.08);
    expect(sh.tarmac).toBeLessThan(0.22);
    expect(sh.gravel).toBeGreaterThan(0.04);
    expect(sh.gravel).toBeLessThan(0.13);
    expect(st.pacenotes.filter((p) => p.modifiers.includes('jump')).length).toBeGreaterThanOrEqual(2);
    const avgW = st.road.reduce((a, r) => a + r.width, 0) / st.road.length;
    expect(avgW).toBeGreaterThan(8);
  });

  it('the testpad is flat tarmac at the start with every surface patch on the pad', () => {
    const { stage, world } = get('testpad').b;
    const p = stage.startPose.pos;
    for (let d = -40; d <= 60; d += 5) {
      expect(world.heightAt(p.x + d, -p.z)).toBeCloseTo(0, 6);
      expect(world.surfaceAt(p.x + d, -p.z)).toBe('tarmac');
    }
    const present = new Set<number>();
    for (const m of stage.heightfield.materials) present.add(m);
    for (let m = 0; m < SURFACE_IDS.length; m++) expect(present.has(m)).toBe(true);
    const labels = (stage as Stage & { labels?: { text: string }[] }).labels ?? [];
    expect(labels.length).toBeGreaterThanOrEqual(9);
    expect(stage.scenery.filter((s) => s.kind === 'cone').length).toBeGreaterThan(10);
  });
});
