/**
 * tests/sim/contact.order.test.ts — OWNED BY sim-contact.
 *
 * main.ts physicsStep runs the original's order (FUN_0049ffe0): all physics, then the car-car contacts, then the race
 * logic. The contacts rewrite the player's pose / velocity through the live body view, so the telemetry read before them
 * is stale: the race logic (gates, lateral / offTrack, stuck and flip timers), the field's afterStep and the overlay must
 * be handed a telemetry read AFTER stepCarContacts. This guards that wiring (QA finding "race logic reads the player's
 * telemetry from before the car-car contact step") The mechanism it relies on (the contact commit drops the telemetry cache, so a
 * re-read is a fresh object holding the post-contact velocity) is asserted in contact.sim.test.ts 'the live view'.
 */
import { describe, expect, it } from 'vitest';

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync(p: string, e: string): string };

describe('physicsStep hands the race logic a post-contact telemetry', () => {
  const src = fs.readFileSync('src/main.ts', 'utf8');
  const body = src.slice(src.indexOf('private physicsStep()'), src.indexOf('private render('));
  it('re-reads telemetry after stepCarContacts and before race.fixedUpdate / afterStep / overlay.sample', () => {
    const iContacts = body.indexOf('stepCarContacts(');
    const iReread = body.indexOf('tel = this.car.telemetry()', iContacts);
    const iRace = body.indexOf('this.race.fixedUpdate(DT, tel)');
    const iAfter = body.indexOf('this.field.afterStep(');
    const iOverlay = body.indexOf('this.overlay.sample(tel)');
    expect(iContacts).toBeGreaterThan(0);
    expect(iReread).toBeGreaterThan(iContacts);
    expect(iRace).toBeGreaterThan(iReread);
    expect(iAfter).toBeGreaterThan(iRace);
    expect(iOverlay).toBeGreaterThan(iAfter);
    expect(body.indexOf('fctx.player.telemetry = tel', iReread)).toBeGreaterThan(iReread); // the field context sees it too
  });
});
