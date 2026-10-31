/**
 * src/sim/contact.ts - OWNED BY THE SIM-CONTACT BUILDER (phase 2, docs/PHASE2_AI.md).
 *
 * Car-car contact: the original's FUN_004a7980 car-car loop -> FUN_006d4390 (research/formats/dynamics.md sec. 6.2, 7;
 * docs/MECHANICS_SPEC.md "car-car contact"), run once per physics substep AFTER every car has been stepped
 * (`CarSim.step`, which already includes each car's own object pass), BEFORE the race logic. `stepCarContacts` walks the
 * pairs exactly as the original [E FUN_004a7980 0x4a7980-0x4a7bbe]: for i, for j >= i, the self pair skipped, cars with
 * `collidable == 0` skipped, `contact(flag 1, bodyI, bodyJ)`; on a hit both cars get the car-car record (carHits++,
 * carStrength = B+0x19c of that body = `CollisionTelemetry.carHits / carStrength`, sound.md sec. 7 type 1, threshold 5).
 *
 * The bodies come from `CarSim.contactBody()` (the live view: vectors shared with the car, scalars pulled); the maths is
 * src/sim/contact/solve.ts (a line-by-line port of research/tools/dyn_ref.py, proven against the exe in unicorn).
 * No allocation per call.
 *
 * main.ts calls it with [player, ...field.sims] every substep, only when there is more than one car. Cars that have no
 * `contactBody()` (other ICarSim implementations) are ignored.
 */
import type { ICarSim } from '../core/types';
import { contactBodies, lastImpulse, type ContactBody } from './contact/solve';

export { CONTACT_CAP, CONTACT_CAP_MULTIPLAYER, makeContactBody } from './contact/solve';
export type { ContactBody } from './contact/solve';
export { buildContactHull, carContactHull, boxContactHull } from './contact/hull';
export type { ContactHull } from './contact/hull';

/** Result of one contact step (for tests and the field's events). The same object is returned every call. */
export interface CarContactResult {
  /** Pairs in contact this substep. */
  pairs: number;
  /** Largest normal impulse j (N.s) applied this substep. */
  maxImpulse: number;
}

/** A car that offers the live body view (CarSim, the sim-contact region of src/sim/car.ts). */
export interface ContactCar {
  contactBody(): ContactBody;
}

const RESULT: CarContactResult = { pairs: 0, maxImpulse: 0 };
const bodies: (ContactBody | null)[] = [];
let multiplayer = false;

/** The `-multiplayer` command-line flag of the exe caps a contact impulse at 10000 N.s instead of 30000 (FUN_006d4390). */
export function setContactMultiplayer(on: boolean): void {
  multiplayer = on;
}

function bodyOf(car: ICarSim): ContactBody | null {
  const f = (car as Partial<ContactCar>).contactBody;
  return typeof f === 'function' ? f.call(car) : null;
}

export function stepCarContacts(cars: readonly ICarSim[], _dt: number): CarContactResult {
  const n = cars.length;
  RESULT.pairs = 0;
  RESULT.maxImpulse = 0;
  if (n < 2) return RESULT;
  bodies.length = n;
  for (let i = 0; i < n; i++) bodies[i] = bodyOf(cars[i]);
  for (let i = 0; i < n; i++) {
    const A = bodies[i];
    if (!A || !A.collidable) continue;
    for (let j = i; j < n; j++) {
      const B = bodies[j];
      if (!B || !B.collidable || B === A) continue;
      if (contactBodies(1, A, B, multiplayer)) {
        RESULT.pairs++;
        if (lastImpulse > RESULT.maxImpulse) RESULT.maxImpulse = lastImpulse;
        A.carHits++;
        A.carStrength = A.imp19c;
        B.carHits++;
        B.carStrength = B.imp19c;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const b = bodies[i];
    if (b && b.dirty) {
      b.dirty = false;
      if (b.commit) b.commit();
    }
    bodies[i] = null;
  }
  return RESULT;
}
