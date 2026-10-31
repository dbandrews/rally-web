/**
 * tests/game/roster.test.ts — OWNED BY THE AI-RACE BUILDER. The opponent roster (src/game/ai/roster.ts).
 * The event table is checked against the 22 extracted Misc/events/*.txt when .cache/original is present (skipped
 * otherwise), the name table against the exe's pointer table (0x847928).
 */
import { describe, expect, it } from 'vitest';
import { ORIG_CAR_IDS } from '../../src/core/constants';
import { MAX_OPPONENTS, aiCarId, slotBaseOfGrid } from '../../src/core/field';
import type { RaceSelection } from '../../src/core/types';
import { AI_NAME_GROUPS, CAREER_EVENTS, buildRoster, buildRosterInfo, eventsOfStage, groupOfCar, prettyCarName, selectEvent } from '../../src/game/ai/roster';
import { origCarArchetype } from '../../src/sim/presets';
import { PORTED_ORDER } from '../../src/world/ports';

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as {
  readFileSync(p: string, e: string): string;
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
};

const sel = (o: Partial<RaceSelection> = {}): RaceSelection => ({
  stageId: 'corsica-1-f',
  archetype: 'awd_wrc',
  tyre: 0,
  transmission: 'auto',
  setup: {},
  steerSensFast: true,
  seed: 1,
  opponents: 3,
  ...o,
});

describe('data tables', () => {
  it('the name table covers the 29 original cars once', () => {
    const all = AI_NAME_GROUPS.flat();
    expect(all).toHaveLength(29);
    expect(new Set(all).size).toBe(29);
    expect([...all].sort()).toEqual([...ORIG_CAR_IDS].sort());
  });

  const EVENTS_DIR = '.cache/original/Misc/events';
  const have = fs.existsSync(EVENTS_DIR);
  (have ? it : it.skip)('CAREER_EVENTS = the 22 extracted event files (cars, bonus cars, tracks, OpponentCount 3)', () => {
    const files = fs.readdirSync(EVENTS_DIR).filter((f) => f.endsWith('.txt')).sort();
    expect(files).toHaveLength(22);
    expect(CAREER_EVENTS.map((e) => e.code)).toEqual(files.map((f) => f.replace('.txt', '')));
    for (const f of files) {
      const t = fs.readFileSync(`${EVENTS_DIR}/${f}`, 'latin1');
      const ev = CAREER_EVENTS.find((e) => e.code === f.replace('.txt', ''))!;
      expect([...t.matchAll(/^Car = (\w+)/gm)].map((m) => m[1])).toEqual(ev.cars);
      expect([...t.matchAll(/^BonusCar = (\w+)/gm)].map((m) => m[1])).toEqual(ev.bonus);
      expect(/OpponentCount = 3/.test(t)).toBe(true);
      expect(/CarCount = 4/.test(t)).toBe(true);
      const stages = [...t.matchAll(/^Track = (\w+)/gm)].map((m) => {
        const x = /^([a-z]+)(\d)([abc]?)([fr])$/.exec(m[1].toLowerCase())!;
        return `${x[1]}-${x[2]}${x[3]}-${x[4]}`;
      });
      expect(stages).toEqual(ev.stages);
    }
  });

  it('every event is one class of the name table, and every ported stage is in an event', () => {
    for (const e of CAREER_EVENTS) {
      expect(e.cars).toHaveLength(4);
      const g = groupOfCar(e.cars[0]);
      expect(g).toBeGreaterThanOrEqual(0);
      for (const c of e.cars) expect(groupOfCar(c), `${e.code} ${c}`).toBe(g);
    }
    for (const id of PORTED_ORDER) expect(eventsOfStage(id).length, id).toBeGreaterThan(0);
  });
});

describe('buildRoster', () => {
  it('0 opponents (or absent) = solo', () => {
    expect(buildRoster(sel({ opponents: 0 }), { id: 'corsica-1-f' })).toEqual([]);
    expect(buildRoster(sel({ opponents: undefined }), { id: 'corsica-1-f' })).toEqual([]);
  });

  it('a stage in no event (procedural) gets none; the name table can be forced', () => {
    expect(buildRoster(sel({ stageId: 'testpad' }), { id: 'testpad' })).toEqual([]);
    const forced = buildRosterInfo(sel({ car: 'Micra' }), { id: 'testpad' }, undefined, { tableFallback: true });
    expect(forced.event).toBeNull();
    expect(forced.specs.map((s) => s.origCar)).toHaveLength(3);
    for (const s of forced.specs) expect(groupOfCar(s.origCar)).toBe(1); // the player's class
  });

  it('ids, grid indices and slot bases (the player is 0)', () => {
    const r = buildRoster(sel({ car: 'ImprezaWRX' }), { id: 'corsica-1-f' });
    expect(r).toHaveLength(3);
    r.forEach((s, i) => {
      expect(s.id).toBe(aiCarId(i + 1));
      expect(s.gridIndex).toBe(i + 1);
      expect(s.slotBase).toBe(slotBaseOfGrid(i + 1));
      expect(s.archetype).toBe(origCarArchetype(s.origCar));
      expect(s.skill).toBeGreaterThan(0);
      expect(s.tyreScale).toBeGreaterThan(0);
      expect(s.name.length).toBeGreaterThan(0);
    });
  });

  it('career stage: the event Car = list minus the player (3 opponents = the 3 class mates), in list order', () => {
    // corsica-1-f lies in crc (AudiS1 class); the player's AudiS1 selects it, the others race in list order
    const r = buildRosterInfo(sel({ car: 'AudiS1' }), { id: 'corsica-1-f' });
    expect(r.event?.code).toBe('crc');
    expect(r.specs.map((s) => s.origCar)).toEqual(['Metro6R4', 'Peugeot205', 'DeltaS4']);
    const r2 = buildRosterInfo(sel({ car: 'DeltaS4' }), { id: 'corsica-1-f' });
    expect(r2.specs.map((s) => s.origCar)).toEqual(['AudiS1', 'Metro6R4', 'Peugeot205']);
  });

  it('the player may drive a bonus car or a car outside the class: the player is never in the field', () => {
    for (const car of ['Micra', 'Renault5', 'FordRS200', 'ToyotaTacoma', undefined]) {
      for (const id of PORTED_ORDER) {
        const r = buildRoster(sel({ stageId: id, car }), { id });
        expect(r, `${id} ${car}`).toHaveLength(3);
        expect(r.map((s) => s.origCar)).not.toContain(car);
        expect(new Set(r.map((s) => s.origCar)).size).toBe(3);
        for (const s of r) expect(ORIG_CAR_IDS).toContain(s.origCar);
      }
    }
  });

  it('1 and 2 opponents: a seeded subset of the class mates, same seed = same roster, list order kept', () => {
    for (const n of [1, 2]) {
      const a = buildRoster(sel({ opponents: n, car: 'AudiS1', seed: 7 }), { id: 'corsica-1-f' });
      const b = buildRoster(sel({ opponents: n, car: 'AudiS1', seed: 7 }), { id: 'corsica-1-f' });
      expect(a).toEqual(b);
      expect(a).toHaveLength(n);
      const order = ['Metro6R4', 'Peugeot205', 'DeltaS4'];
      const idx = a.map((s) => order.indexOf(s.origCar));
      expect(idx.every((i) => i >= 0)).toBe(true);
      expect([...idx].sort((x, y) => x - y)).toEqual(idx);
    }
    const seeds = new Set<string>();
    for (let seed = 1; seed < 40; seed++) seeds.add(buildRoster(sel({ opponents: 1, car: 'AudiS1', seed }), { id: 'corsica-1-f' })[0].origCar);
    expect(seeds.size).toBeGreaterThan(1); // the seed matters
  });

  it('the event rule: the player car first, then its class, then the first event of the stage', () => {
    // kenya-1-f is in prc (LancerEVO class), sc (AudiS1 class), st (LancerEVO class)
    expect(eventsOfStage('kenya-1-f').map((e) => e.code)).toEqual(['prc', 'sc', 'st']);
    expect(selectEvent('kenya-1-f', 'DeltaS4')?.code).toBe('sc');
    expect(selectEvent('kenya-1-f', 'Micra')?.code).toBe('prc'); // prc's bonus car
    expect(selectEvent('kenya-1-f', 'Peugeot205')?.code).toBe('sc');
    expect(selectEvent('kenya-1-f', 'Peugeot306')?.code).toBe('prc'); // class 1 is in no kenya event: the first
    expect(selectEvent('kenya-1-f', undefined)?.code).toBe('prc');
    expect(selectEvent('testpad', 'Micra')).toBeNull();
  });

  it('never more than MAX_OPPONENTS', () => {
    expect(buildRoster(sel({ opponents: 9 }), { id: 'corsica-1-f' })).toHaveLength(MAX_OPPONENTS);
    expect(buildRoster(sel({ opponents: -2 }), { id: 'corsica-1-f' })).toEqual([]);
    expect(buildRoster(sel({ opponents: Number.NaN }), { id: 'corsica-1-f' })).toEqual([]);
  });

  it('display names', () => {
    expect(prettyCarName('Peugeot206')).toBe('Peugeot 206');
    expect(prettyCarName('LancerEVO')).toBe('Lancer EVO');
    expect(prettyCarName('AudiS1HC')).toBe('Audi S1HC');
    expect(prettyCarName('CitroenXsaraRC')).toBe('Citroen Xsara RC');
    expect(buildRosterInfo(sel({ car: 'AudiS1' }), { id: 'corsica-1-f' }, (id) => `<${id}>`).specs[0].name).toBe('<Metro6R4>');
  });
});
