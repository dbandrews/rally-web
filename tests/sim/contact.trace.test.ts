/**
 * tests/sim/contact.trace.test.ts - the car-car contact against the REAL GAME: the Frida physics trace of the original
 * (research/frida/traces/run2.bin: a rallycross race, 4 cars: FordEscort, Micra, Beetle, Corolla), extracted by
 * research/tools/contact_trace.py into fixtures/contact/trace_run2.json.gz.
 *
 * Each case is one 120 Hz substep k: the POST-step state of the four cars (the input of FUN_004a7980's pair loop) and the
 * PRE-step state of the same cars at substep k+1 (its output, as the original recorded it), plus the float64 reference
 * (research/tools/dyn_ref.py) result. The whole trace run: 27 338 substeps with touching bounding spheres; 26 583 without
 * any contact (the port also finds none), 271 contacts that the port reproduces within v 3e-4 m/s, L 1 N.m.s, position
 * 5e-4 m, B+0x19c 0.34 N.s (a float32 position ulp at 2000 m is 2.4e-4 m), 483 within 2 mm of a decision boundary of the
 * overlap test (two depths that tie, a face-on-face contact: float32 positions pick the other plane owner; the physics of
 * either choice agrees to a few %) and ONE case that differs only in the bookkeeping value B+0x19c.
 *
 * The test replays the stored cases through stepCarContacts (the TS port; same pair order i, j >= i):
 *   - every case: TS == dyn_ref to 1e-6 (the port is the line-by-line translation);
 *   - the 'agree' cases: TS == the original's recorded outcome within the tolerances above.
 */
import { describe, expect, it } from 'vitest';
import type { ICarSim } from '../../src/core/types';
import { carContactHull, makeContactBody, stepCarContacts, type ContactBody } from '../../src/sim/contact';

const nodeFs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as {
  readFileSync(p: string): Uint8Array;
  existsSync(p: string): boolean;
};
const nodeZlib = (await import(/* @vite-ignore */ 'node:' + 'zlib')) as { gunzipSync(b: Uint8Array): Uint8Array };

type V = number[];
interface InBody {
  R: number[];
  pos: V;
  v: V;
  w: V;
  L: V;
  I: V;
  invI: V;
  prevN: V;
  mass: number;
  invMass: number;
  radius: number;
  imp19c: number;
  imp190: number;
  T: number;
}
interface OutBody {
  pos: V;
  v: V;
  L: V;
  prevN: V;
  T: number;
  imp19c: number;
}
interface Case {
  k: number;
  kind: 'agree' | 'tie' | 'MISMATCH';
  margin: number;
  inp: InBody[];
  trace: OutBody[];
  ref: OutBody[];
}

const FIXTURE = 'tests/sim/fixtures/contact/trace_run2.json.gz';
const doc = nodeFs.existsSync(FIXTURE)
  ? (JSON.parse(new TextDecoder().decode(nodeZlib.gunzipSync(nodeFs.readFileSync(FIXTURE)))) as {
      cars: string[];
      stats: Record<string, number>;
      cases: Case[];
    })
  : null;

function setV(d: { x: number; y: number; z: number }, s: V): void {
  d.x = s[0];
  d.y = s[1];
  d.z = s[2];
}
const vec = (v: { x: number; y: number; z: number }): V => [v.x, v.y, v.z];

/** the fixture holds 9 significant digits of float32 values: fround restores them exactly */
const f = (a: V): V => a.map(Math.fround);

function bodyOf(name: string, i0: InBody): ContactBody {
  const i: InBody = {
    ...i0, R: f(i0.R), pos: f(i0.pos), v: f(i0.v), w: f(i0.w), L: f(i0.L), I: f(i0.I), invI: f(i0.invI), prevN: f(i0.prevN),
    mass: Math.fround(i0.mass), invMass: Math.fround(i0.invMass), imp19c: Math.fround(i0.imp19c), imp190: Math.fround(i0.imp190), T: Math.fround(i0.T),
  };
  const b = makeContactBody(carContactHull(name)!, i.mass, { x: i.I[0], y: i.I[1], z: i.I[2] });
  b.invMass = i.invMass;
  setV(b.invI, i.invI);
  setV(b.right, i.R.slice(0, 3));
  setV(b.up, i.R.slice(3, 6));
  setV(b.fwd, i.R.slice(6, 9));
  setV(b.pos, i.pos);
  setV(b.v, i.v);
  setV(b.w, i.w);
  setV(b.L, i.L);
  setV(b.prevN, i.prevN);
  b.imp19c = i.imp19c;
  b.imp190 = i.imp190;
  b.T = i.T;
  return b;
}

const maxAbs = (a: V, b: V) => Math.max(...a.map((x, k) => Math.abs(x - b[k])));
const scale = (a: V) => 1 + Math.max(...a.map(Math.abs));

describe.skipIf(!doc)('car-car contact vs the original running a rallycross race (Frida run2)', () => {
  const run = (c: Case): ContactBody[] => {
    const bodies = doc!.cars.map((n, k) => bodyOf(n, c.inp[k]));
    const cars = bodies.map((b) => ({ contactBody: () => b }) as unknown as ICarSim);
    stepCarContacts(cars, 1 / 120);
    return bodies;
  };

  it('has the cases', () => {
    expect(doc!.cars).toEqual(['FordEscort', 'Micra', 'Beetle', 'Corolla']);
    expect(doc!.stats.substeps).toBeGreaterThan(27000);
    expect(doc!.stats.contact_agree).toBeGreaterThanOrEqual(250);
    expect(doc!.cases.filter((c) => c.kind === 'agree').length).toBe(doc!.stats.contact_agree);
  });

  it('every stored substep: the TS port equals the float64 reference (dyn_ref.py) to 1e-6', () => {
    const bad: string[] = [];
    for (const c of doc!.cases) {
      const out = run(c);
      for (let k = 0; k < out.length; k++) {
        const r = c.ref[k];
        const b = out[k];
        if (maxAbs(vec(b.v), r.v) > 1e-6 * scale(r.v) || maxAbs(vec(b.L), r.L) > 1e-6 * scale(r.L) || maxAbs(vec(b.pos), r.pos) > 1e-6 * scale(r.pos))
          bad.push(`k=${c.k} car ${k}: v ${vec(b.v)} vs ${r.v}`);
        if (Math.abs(b.imp19c - r.imp19c) > 1e-6 * (1 + Math.abs(r.imp19c))) bad.push(`k=${c.k} car ${k}: imp19c ${b.imp19c} vs ${r.imp19c}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("the 'agree' substeps: the TS port reproduces what the original recorded (v, L, position push, B+0x19c, anchor timer)", () => {
    const agree = doc!.cases.filter((c) => c.kind === 'agree');
    const bad: string[] = [];
    let contacts = 0;
    let touchedByOriginal = 0;
    let touchedByBoth = 0;
    for (const c of agree) {
      const out = run(c);
      for (let k = 0; k < out.length; k++) {
        const t = c.trace[k];
        const b = out[k];
        if (b.T === 0.2) contacts++;
        if (maxAbs(vec(b.v), t.v) > 5e-3 * scale(t.v)) bad.push(`k=${c.k} car ${k} v ${vec(b.v)} vs ${t.v}`);
        if (maxAbs(vec(b.L), t.L) > 5e-2 * scale(t.L)) bad.push(`k=${c.k} car ${k} L ${vec(b.L)} vs ${t.L}`);
        if (Math.max(Math.abs(b.pos.x - t.pos[0]), Math.abs(b.pos.z - t.pos[2])) > 1e-3) bad.push(`k=${c.k} car ${k} pos`);
        if (Math.abs(b.imp19c - t.imp19c) > 5e-2 * (1 + Math.abs(t.imp19c))) bad.push(`k=${c.k} car ${k} imp19c ${b.imp19c} vs ${t.imp19c}`);
        // the bodies the original touched (T := 0.2 from some other value): the port touches them too, except where the
        // contact is a fraction of a millimetre deep (a coin flip between float32 and float64; no velocity change)
        if (Math.abs(t.T - 0.2) < 1e-6 && Math.abs(c.inp[k].T - 0.2) > 1e-6) {
          touchedByOriginal++;
          if (b.T === 0.2) touchedByBoth++;
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(agree.length).toBeGreaterThanOrEqual(250);
    expect(contacts).toBeGreaterThanOrEqual(2 * 250);
    expect(touchedByOriginal).toBeGreaterThan(300);
    expect(touchedByBoth / touchedByOriginal).toBeGreaterThan(0.8);
  });
});
