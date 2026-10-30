/**
 * tests/world/ported.test.ts — fidelity of the 48 PORTED original tracks (src/world/ports/*)
 * against the ported archive data: real geometry, real race settings, sane procedural dressing.
 *
 * The per-stage facts (spline length, triggers, valid range, tyre, laps) are asserted against
 * the data modules themselves (generated from the archives); a handful of stages are also
 * asserted against independently extracted numbers (research/tools/port_tracks.py summary) so
 * a regression in either direction shows up.
 */
import { describe, expect, it } from 'vitest';
import { materialFromOrig, surfaceFromMaterial } from '../../src/core/constants';
import type { BuiltStage } from '../../src/core/types';
import { buildStage, listStages } from '../../src/world/stages';
import { PORTED_DATA, PORTED_ORDER } from '../../src/world/ports';
import { portedRaceSettings, portedReach } from '../../src/world/portedBuilder';
import { effectiveOrder, origPacenoteText } from '../../src/world/portedPacenotes';

const cache = new Map<string, BuiltStage & { ms: number }>();
const get = (id: string): BuiltStage & { ms: number } => {
  let b = cache.get(id);
  if (!b) {
    const t0 = performance.now();
    b = { ...buildStage(id, 1), ms: performance.now() - t0 };
    cache.set(id, b);
  }
  return b;
};

/** Independently extracted facts (port_tracks.py output over the original archives). */
const KNOWN: Readonly<Record<string, { len: number; start: number; finish: number; tyre: number; closed: boolean }>> = Object.freeze({
  'corsica-1-f': { len: 3731, start: 171, finish: 3576, tyre: 0, closed: false },
  'corsica-1-r': { len: 3733, start: 172, finish: 3577, tyre: 0, closed: false },
  'kenya-1-f': { len: 7381, start: 1509, finish: 6484, tyre: 2, closed: false },
  'newzealand-2-f': { len: 7073, start: 1394, finish: 6703, tyre: 2, closed: false },
  'hillclimb-1a-f': { len: 3852, start: 72, finish: 3648, tyre: 2, closed: false },
  'hillclimb-3a-r': { len: 4943, start: 624, finish: 4906, tyre: 3, closed: false },
  'iceracing-2-r': { len: 1292, start: 37, finish: 619, tyre: 4, closed: true },
  'rallycross-1-f': { len: 2466, start: 50, finish: 1526, tyre: 1, closed: true },
});

describe('ported catalogue', () => {
  it('lists the ported stages after the procedural ones, every archive exactly once', () => {
    const ids = listStages().map((s) => s.id);
    expect(ids.slice(0, 7)).toEqual(['pine-ridge', 'col-du-vent', 'frostvale', 'red-basin', 'kettle-park', 'lake-skoga', 'testpad']);
    expect(ids.slice(7)).toEqual(PORTED_ORDER);
    expect(PORTED_ORDER.length).toBe(48);
    expect(new Set(PORTED_ORDER).size).toBe(48);
    const archives = PORTED_ORDER.map((id) => PORTED_DATA[id].archive);
    expect(new Set(archives).size).toBe(48);
    expect(archives).toEqual([...archives].sort());
  });

  it('covers the six families, 24 layouts in both directions', () => {
    for (const d of Object.values(PORTED_DATA)) {
      expect(d.center.length % 3).toBe(0);
      expect(d.left.length % 3).toBe(0);
      expect(d.right.length % 3).toBe(0);
      expect(d.triggers.length).toBeGreaterThanOrEqual(2);
      if (d.closed) expect(d.laps).toBeGreaterThanOrEqual(1);
    }
    const layouts = new Set(PORTED_ORDER.map((id) => PORTED_DATA[id].archive.replace(/[fr]\.rff$/, '')));
    expect(layouts.size).toBe(24);
    const families = new Set(PORTED_ORDER.map((id) => PORTED_DATA[id].family));
    expect([...families].sort()).toEqual(['corsica', 'hillclimb', 'iceracing', 'kenya', 'newzealand', 'rallycross']);
  });
});

describe.each(PORTED_ORDER.map((id) => [id] as const))('ported stage %s', (id) => {
  it('reproduces the archive race settings exactly; the car waits at the spawn grid', () => {
    const d = PORTED_DATA[id];
    const st = get(id).stage;
    const rs = portedRaceSettings(d, st.length);
    expect(st.id).toBe(id);
    expect(st.closed).toBe(d.closed);
    expect(st.defaultTyre).toBe(d.defaultTyre);
    expect(st.laps).toBe(d.laps);
    expect(st.startS).toBeCloseTo(rs.startS, 6);
    expect(st.finishS).toBeCloseTo(rs.finishS, 6);
    expect(st.checkpoints.map((x) => Math.round(x * 1000))).toEqual(rs.checkpoints.map((x) => Math.round(x * 1000)));
    expect(st.validRange[0]).toBeCloseTo(rs.validRange[0], 6);
    expect(st.validRange[1]).toBeCloseTo(rs.validRange[1], 6);
    // race.spawnGrid: the start pose sits on the centre line at the spawn distance (docs/orig/race.md §1)
    expect(rs.shift).toBe(0);
    expect((st as typeof st & { spawnS: number }).spawnS).toBeCloseTo(rs.spawnS, 6);
    const sp = st.project(st.startPose.pos);
    expect(Math.abs(sp.lateral)).toBeLessThan(0.05);
    expect(Math.abs(sp.s - rs.spawnS)).toBeLessThan(0.5);
    // Physics.bodyBrakingFactorForTrack (post-finish braking): 0.4 everywhere but hillclimb3cf (0.1)
    expect((st as typeof st & { trackBraking: number }).trackBraking).toBe(id === 'hillclimb-3c-f' ? 0.1 : 0.4);
    expect(d.bodyBraking).toBe((st as typeof st & { trackBraking: number }).trackBraking);
    expect('origValidRange' in st).toBe(false); // the verbatim range IS stage.validRange now
    if (d.closed) {
      expect(st.validRange).toEqual([0, st.length]); // no splineRange: the original's ±FLT_MAX, never out of range
    } else {
      // the race controller's range (§5.4 check + reset floor) is the archive's splineRange as it is, and the
      // car waiting at its spawn grid is inside it (corsica-2-f 550 < 559, hillclimb-3a-f 48 < 54, -3b-r 220 < 237)
      expect(st.validRange).toEqual([d.validRange[0], d.validRange[1]]);
      expect(st.validRange[0]).toBeLessThan(rs.spawnS);
      expect(st.validRange[1]).toBeGreaterThan(st.finishS);
      // verbatim: every archive distance as it is (the centre line runs on past a late finish)
      expect(st.startS).toBe(d.triggers[0]);
      expect(st.finishS).toBe(d.triggers[d.triggers.length - 1]);
      expect(rs.spawnS).toBe(d.spawnS);
      // only corsica-2-f, hillclimb-3a-f and hillclimb-3b-r start their range past trigger 0 (docs/orig/race.md §3)
      const late = ['corsica-2-f', 'hillclimb-3a-f', 'hillclimb-3b-r'].includes(id);
      expect(st.validRange[0] > st.startS).toBe(late);
      expect(st.finishS).toBeLessThan(st.length - 40);
      for (const c of st.checkpoints) {
        expect(c).toBeGreaterThan(st.startS);
        expect(c).toBeLessThan(st.finishS);
      }
    }
    // the timing lines sit ON the road (project onto it laterally inside the width)
    for (const s of [st.startS, ...(st.closed ? [] : [st.finishS, ...st.checkpoints])]) {
      const p = st.pointAt(s);
      const pr = st.project(p);
      expect(Math.abs(pr.lateral)).toBeLessThan(0.5);
    }
  });

  it('has the archive spline length (±3 %; extended to a late finish) and a physical road ribbon', () => {
    const d = PORTED_DATA[id];
    const b = get(id);
    const st = b.stage;
    const want = Math.max(d.splineLength, portedReach(d));
    expect(Math.abs(st.length - want) / want).toBeLessThan(0.03);
    expect(st.road.length).toBeGreaterThan(50);
    for (const r of st.road) {
      expect(Number.isFinite(r.pos.x + r.pos.y + r.pos.z + r.width)).toBe(true);
      expect(r.width).toBeGreaterThan(4.5);
      expect(r.width).toBeLessThan(45);
      expect(Math.abs(r.bank)).toBeLessThan(0.16);
      // left/right edge points are where the ported edges say they are (width consistency)
      const w = Math.hypot(r.left.x - r.right.x, r.left.z - r.right.z);
      expect(Math.abs(w - r.width) / r.width).toBeLessThan(0.02);
    }
    for (const h of st.heightfield.heights) expect(Number.isFinite(h)).toBe(true);
    expect(st.heightfield.nx * st.heightfield.nz).toBeLessThanOrEqual(400_000);
    expect(b.ms).toBeLessThan(3000);
  });

  it('is deterministic per seed and varies with the seed', () => {
    const a = buildStage(id, 42);
    const c = buildStage(id, 42);
    const sum = (st: BuiltStage['stage']): number =>
      st.scenery.reduce((x, s) => x + s.pos.x + s.pos.z, 0) + st.road.length;
    expect(sum(a.stage)).toBeCloseTo(sum(c.stage), 6);
    expect(sum(buildStage(id, 43).stage)).not.toBeCloseTo(sum(a.stage), 3);
  });

  it('drives on the original road material (Track.gcm under the centre line, ROAD_MATERIAL runs)', () => {
    const st = get(id).stage;
    const d = PORTED_DATA[id];
    expect(d.roadMaterial.length).toBeGreaterThan(0);
    const surf = (b: number) => surfaceFromMaterial(materialFromOrig(b));
    for (const [, b] of d.roadMaterial) expect(surf(b)).not.toBeNull();
    // exactly the archive's materials, each run where the original has it
    expect(new Set(st.road.map((r) => r.surface))).toEqual(new Set(d.roadMaterial.map(([, b]) => surf(b))));
    d.roadMaterial.forEach(([s0, b], k) => {
      const s1 = k + 1 < d.roadMaterial.length ? d.roadMaterial[k + 1][0] : Math.min(st.length, s0 + 50);
      if (s1 - s0 >= 4) expect(st.roadAt((s0 + s1) / 2).surface).toBe(surf(b));
    });
    // the families as the original paints them
    const surfaces = new Set(st.road.map((r) => r.surface));
    const has = (w: string): boolean => surfaces.has(w as never);
    const layout = d.archive.replace(/[fr]\.rff$/, '');
    switch (d.family) {
      case 'corsica':
        expect(has('tarmac') || has('water')).toBe(true); // ASPHALT / WATERASPHALT (corsica 2r, 3f)
        break;
      case 'kenya':
        expect(has('sand')).toBe(true);
        break;
      case 'newzealand':
        expect(has('mud')).toBe(true);
        break;
      case 'hillclimb':
        expect([...surfaces]).toEqual([layout.startsWith('hillclimb3') ? 'snowAsphalt' : 'gravel']);
        break;
      case 'iceracing':
        expect([...surfaces]).toEqual(['ice']); // ICEASPHALT
        break;
      case 'rallycross':
        expect(has('tarmac') && (has('gravel') || has('mud'))).toBe(true);
        break;
      default:
        expect(d.family).toBeTruthy();
    }
  });

  it('drives the timed route start → finish', () => {
    const st = get(id).stage;
    if (st.closed) return;
    const timed = st.finishS - st.startS;
    expect(timed).toBeGreaterThan(400);
    // the timed length matches the catalogue entry (menu display)
    const entry = listStages().find((e) => e.id === id)!;
    expect(Math.abs(entry.approxLength - timed)).toBeLessThan(25);
  });

  it('co-driver notes are the archive PaceNotes.con (reachable notes, original word ids)', () => {
    const st = get(id).stage;
    const d = PORTED_DATA[id];
    if (st.closed) {
      expect(d.pacenotes.length).toBe(0);
      expect(st.pacenotes.length).toBe(0);
      return;
    }
    expect(d.pacenotes.length).toBeGreaterThanOrEqual(12);
    const order = effectiveOrder(d.pacenotes.map((n) => n[0]));
    // every note the original's backward scan can fire, in order (only newzealand3f has an unreachable one)
    expect(order.length).toBe(id === 'newzealand-3-f' ? d.pacenotes.length - 1 : d.pacenotes.length);
    expect(st.pacenotes.length).toBe(order.length);
    let last = -1;
    st.pacenotes.forEach((n, k) => {
      const [dist, words] = d.pacenotes[order[k]];
      expect(n.s).toBeCloseTo(dist, 6);
      expect(n.origWords).toEqual(words);
      expect(n.text).toBe(origPacenoteText(words));
      expect(n.s).toBeGreaterThan(last);
      expect(n.s).toBeLessThanOrEqual(n.cornerS);
      last = n.s;
      expect([0, 1, 2, 3, 4, 5, 6]).toContain(n.severity);
      for (const w of n.origWords!) {
        expect(w).toBeGreaterThanOrEqual(1);
        expect(w).toBeLessThanOrEqual(41);
      }
    });
  });
});

describe('the original co-driver notes against the real road', () => {
  it('call the bends ahead in the direction of the original (pooled over the 36 stages, sound.md §10)', () => {
    // direction word vs the turn of a 60 m window centred 110 m after the call point; the verifier measured
    // 0.71 pooled at +125 m. A z-mirrored stage (raw spline x, z as three space) scores ≈ 0.29.
    let agree = 0;
    let total = 0;
    for (const id of PORTED_ORDER) {
      const st = get(id).stage;
      for (const n of st.pacenotes) {
        if (n.direction === 'straight') continue;
        const a = st.tangentAt(n.s + 80);
        const b = st.tangentAt(n.s + 140);
        const turn = a.x * b.z - a.z * b.x; // three space: > 0 = turning right
        if (Math.abs(turn) < 0.05) continue;
        total++;
        if (turn > 0 === (n.direction === 'right')) agree++;
      }
    }
    expect(total).toBeGreaterThan(600);
    expect(agree / total).toBeGreaterThan(0.65);
  });
});

describe('independent archive numbers', () => {
  it.each(Object.entries(KNOWN).map(([id, k]) => [id, k] as const))('%s matches the extractor output', (id, k) => {
    const d = PORTED_DATA[id];
    const st = get(id).stage;
    const rs = portedRaceSettings(d, st.length);
    expect(st.closed).toBe(k.closed);
    expect(st.defaultTyre).toBe(k.tyre);
    expect(Math.abs(st.length - k.len) / k.len).toBeLessThan(0.03);
    expect(rs.startS).toBe(k.start);
    if (!k.closed) expect(rs.finishS).toBe(k.finish);
  });
});