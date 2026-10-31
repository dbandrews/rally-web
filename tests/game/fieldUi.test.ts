/**
 * tests/game/fieldUi.test.ts — OWNED BY THE AI-RACE BUILDER. The opponent UI content that needs no DOM: the menu row
 * (src/ui/menuAi.ts) and the results standings table (src/ui/hudAi.ts standingsTableHtml / aiResultsHtml). The DOM parts
 * (HUD strip, bar markers, the live table) are checked in the browser by tools/ai-race.mjs.
 */
import { describe, expect, it } from 'vitest';
import type { FieldSnapshot, StandingEntry } from '../../src/core/field';
import type { IMenuHost, RaceSelection } from '../../src/core/types';
import { aiColor, standingsTableHtml } from '../../src/ui/hudAi';
import { DEFAULT_OPPONENTS, aiMenuRows, aiResultsHtml } from '../../src/ui/menuAi';
import type { MenuExtraEnv } from '../../src/ui/menuExtras';

const sel = (o: Partial<RaceSelection> = {}): RaceSelection => ({
  stageId: 'corsica-1-f',
  archetype: 'awd_wrc',
  car: 'AudiS1',
  tyre: 0,
  transmission: 'auto',
  setup: {},
  steerSensFast: true,
  seed: 1,
  ...o,
});

const env = (s: RaceSelection): MenuExtraEnv => ({
  sel: s,
  host: { listCars: () => [{ id: 'Metro6R4', name: 'MG Metro 6R4', archetype: 'awd_wrc', drive: 'AWD', available: true }] } as unknown as IMenuHost,
  stageEntry: () => undefined,
  rerender: () => {},
});

describe('Opponents menu row', () => {
  it('defaults to 3 (OpponentCount of every career event) when the selection does not say, and respects 0', () => {
    const s = sel();
    const [row] = aiMenuRows(env(s));
    expect(DEFAULT_OPPONENTS).toBe(3);
    expect(s.opponents).toBe(3);
    expect(row.get()).toBe(3);
    const solo = sel({ opponents: 0 });
    aiMenuRows(env(solo));
    expect(solo.opponents).toBe(0); // an explicit ?ai=0 stays solo
  });

  it('choices 0..3, set writes the selection, the info names the roster', () => {
    const s = sel();
    const [row] = aiMenuRows(env(s));
    expect(row.choices().map((c) => c.label)).toEqual(['None', '1 car', '2 cars', '3 cars']);
    expect(row.enabled()).toBe(true);
    row.set(2);
    expect(s.opponents).toBe(2);
    expect(row.info()).toMatch(/2 AI cars/);
    row.set(3);
    expect(row.info()).toContain('MG Metro 6R4'); // the host's car names
    row.set(0);
    expect(s.opponents).toBe(0);
    expect(row.info()).toMatch(/solo/i);
    row.set(9);
    expect(s.opponents).toBe(3);
  });

  it('is disabled (and reads None) on a stage with no AI data', () => {
    const s = sel({ stageId: 'testpad' });
    const [row] = aiMenuRows(env(s));
    expect(row.enabled()).toBe(false);
    expect(row.get()).toBe(0);
    expect(row.info()).toMatch(/original stages/);
  });
});

function entry(o: Partial<StandingEntry> & Pick<StandingEntry, 'id' | 'position'>): StandingEntry {
  return { name: o.id, player: false, lap: 1, distance: 0, finished: false, finishTime: null, gapToLeader: null, ...o };
}

describe('results standings table', () => {
  const field = (): FieldSnapshot => ({
    opponents: 3,
    fieldSize: 4,
    playerPosition: 2,
    cars: [
      { id: 'ai1', kind: 'ai', origCar: 'Metro6R4', name: 'Metro', gridIndex: 1, slotBase: 24, pos: { x: 0, y: 0, z: 0 }, speedKmh: 0, s: 0, lateral: 0, lap: 1, steer: 0, throttle: 0, brake: 0, parked: false, resets: 0, finished: true, finishTime: 200.5 },
      { id: 'ai2', kind: 'ai', origCar: 'DeltaS4', name: 'Delta', gridIndex: 2, slotBase: 48, pos: { x: 0, y: 0, z: 0 }, speedKmh: 0, s: 0, lateral: 0, lap: 2, steer: 0, throttle: 0, brake: 0, parked: false, resets: 0, finished: false, finishTime: null, ai: { dnf: true } },
      { id: 'ai3', kind: 'ai', origCar: 'AudiS1', name: 'Audi', gridIndex: 3, slotBase: 72, pos: { x: 0, y: 0, z: 0 }, speedKmh: 0, s: 0, lateral: 0, lap: 1, steer: 0, throttle: 0, brake: 0, parked: false, resets: 0, finished: false, finishTime: null },
    ],
    standings: [
      entry({ id: 'ai1', name: 'Metro <6R4>', origCar: 'Metro6R4', position: 1, finished: true, finishTime: 200.5 }),
      entry({ id: 'player', name: 'You', origCar: 'ImprezaWRX', player: true, position: 2, finished: true, finishTime: 203.25, gapToLeader: 2.75, distance: 3400 }),
      entry({ id: 'ai3', name: 'Audi', position: 3, lap: 1, distance: 3000 }),
      entry({ id: 'ai2', name: 'Delta', position: 4, lap: 2, distance: 1000 }),
    ],
  });

  it('renders positions, you, the leader time, gaps, racing laps and DNF; names are escaped', () => {
    const html = standingsTableHtml(field());
    expect(html.match(/<tr/g)).toHaveLength(5); // header + 4
    expect(html).toContain('Metro &lt;6R4&gt;');
    expect(html).toContain('3:20.500'); // the leader's time
    expect(html).toContain('+2.750'); // the player's gap
    expect(html).toContain('class="rw-you"');
    expect(html).toContain('Impreza WRX');
    expect(html).toContain('racing · 400 m back');
    expect(html).toMatch(/rw-dnf">DNF/);
  });

  it('is empty without a field; aiResultsHtml wraps it in a live table', () => {
    expect(standingsTableHtml(undefined)).toBe('');
    expect(aiResultsHtml(undefined)).toBe('');
    expect(aiResultsHtml({ opponents: 0, cars: [], standings: [], playerPosition: 1, fieldSize: 1 })).toBe('');
    const h = aiResultsHtml(field());
    expect(h).toContain('<table class="rw-ai-table" data-live>');
    expect(h).toContain('Race result');
  });

  it('marker colours are stable per AI car', () => {
    expect(new Set(['ai1', 'ai2', 'ai3'].map(aiColor)).size).toBe(3);
    expect(aiColor('ai1')).toBe(aiColor('ai1'));
  });
});
