/**
 * tests/sim/contact.fixtures.test.ts - the CAR-CAR body-body contact FUN_006d4390 (with FUN_006d4fd0 / FUN_006d5240)
 * against the ORIGINAL function executed in unicorn (research/tools/contact_emu.py; research/formats/dynamics.md sec. 6-7).
 *
 * fixtures/contact/carcar.json.gz: 2200 stratified cases of the 8000 executed (2047 contacts; 0 disagreements between the
 * exe and research/tools/dyn_ref.py in the full run), two bodies with the REAL Car_<Name>.col hulls (all 18 points, the
 * 10 planes of the quads): random poses, velocities, spins, anchor memory, impact records, sleeping bodies, the
 * 30000 / 10000 (-multiplayer) caps, both plane-owner branches (the 1.5 MARK), sphere-only near misses. The TS port is
 * run on the exact float32 inputs and must reproduce every output field within the documented tolerance: the exe works
 * in x87 extended precision and stores float32, the port in float64. Measured over the 2047 contacts: max relative
 * deviation v 1.0e-6, L 9.9e-6, B+0x19c 1.6e-5, max position error 7.8e-7 m, prevN 5e-7 (the fixture keeps 7 digits);
 * asserted at 5e-5 (relative to the vector's size + 5e-5 absolute; the unicorn run itself compares at 5e-4). A
 * plane-test tie (|n.q - d| < 1e-5) would be exempt (none occurs in the 8000 executed cases).
 */
import { describe, expect, it } from 'vitest';
import { carContactHull, makeContactBody, setContactMultiplayer, stepCarContacts, type ContactBody } from '../../src/sim/contact';
import { contactBodies, lastSlot } from '../../src/sim/contact/solve';
import { CAR_COL } from '../../src/sim/contact/carHulls';

const nodeFs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as {
  readFileSync(p: string): Uint8Array;
  existsSync(p: string): boolean;
};
const nodeZlib = (await import(/* @vite-ignore */ 'node:' + 'zlib')) as { gunzipSync(b: Uint8Array): Uint8Array };

type V = number[];
interface InBody {
  q: number[];
  w: V;
  I: V;
  pos: V;
  v: V;
  prevN: V;
  mass: number;
  imp19c: number;
  imp190: number;
  sleep?: number;
}
interface OutBody {
  v: V;
  L: V;
  pos: V;
  prevN: V;
  prevC: V;
  pt1a4: V;
  pt1b0: V;
  pt1bc: V;
  imp19c: number;
  imp190: number;
  flags: number;
  sleep: number;
}
interface Case {
  A: string;
  B: string;
  inA: InBody;
  inB: InBody;
  ret: number;
  mp?: number;
  slot?: number;
  margin?: number;
  outA?: OutBody;
  outB?: OutBody;
}

const FIXTURE = 'tests/sim/fixtures/contact/carcar.json.gz';
const f32 = Math.fround;

/** dyn_ref.quat_to_rows with the exe's float32 storage (emu_dyn.new_body: Rm = f32 rows). */
function rowsOf(q: number[]): number[][] {
  const [w, x, y, z] = q;
  const r = [
    [1 - 2 * (z * z + y * y), 2 * (z * w + y * x), 2 * (z * x - y * w)],
    [2 * (y * x - z * w), 1 - 2 * (z * z + x * x), 2 * (w * x + y * z)],
    [2 * (y * w + z * x), 2 * (y * z - w * x), 1 - 2 * (y * y + x * x)],
  ];
  return r.map((row) => row.map(f32));
}

function setV(d: { x: number; y: number; z: number }, s: V): void {
  d.x = s[0];
  d.y = s[1];
  d.z = s[2];
}

function bodyOf(car: string, i: InBody): ContactBody {
  const hull = carContactHull(car);
  if (!hull) throw new Error('no hull for ' + car);
  const I = { x: i.I[0], y: i.I[1], z: i.I[2] };
  const b = makeContactBody(hull, i.mass, I);
  b.invMass = f32(1 / i.mass);
  b.invI.x = f32(1 / I.x);
  b.invI.y = f32(1 / I.y);
  b.invI.z = f32(1 / I.z);
  const R = rowsOf(i.q);
  setV(b.right, R[0]);
  setV(b.up, R[1]);
  setV(b.fwd, R[2]);
  setV(b.pos, i.pos);
  setV(b.v, i.v);
  setV(b.w, i.w);
  b.L.x = f32(i.w[0] * I.x);
  b.L.y = f32(i.w[1] * I.y);
  b.L.z = f32(i.w[2] * I.z);
  setV(b.prevN, i.prevN);
  b.imp19c = i.imp19c;
  b.imp190 = i.imp190;
  b.sleep = i.sleep ?? 0;
  return b;
}

/** emu_dyn.close: vectors compare against the vector's own size. */
function closeVec(a: V, b: V, rel = 5e-5, ab = 5e-5): boolean {
  const m = Math.max(...a.map(Math.abs), ...b.map(Math.abs), 0);
  return a.every((x, k) => Math.abs(x - b[k]) <= ab + rel * m);
}
function closeNum(a: number, b: number, rel = 5e-5, ab = 5e-5): boolean {
  return Math.abs(a - b) <= ab + rel * Math.max(Math.abs(a), Math.abs(b));
}
const vec = (v: { x: number; y: number; z: number }): V => [v.x, v.y, v.z];

function check(b: ContactBody, e: OutBody, bad: string[], tag: string): void {
  const vecs: [string, V, V][] = [
    ['v', vec(b.v), e.v],
    ['L', vec(b.L), e.L],
    ['pos', vec(b.pos), e.pos],
    ['prevN', vec(b.prevN), e.prevN],
    ['prevC', vec(b.prevC), e.prevC],
    ['pt1a4', vec(b.pt1a4), e.pt1a4],
    ['pt1b0', vec(b.pt1b0), e.pt1b0],
    ['pt1bc', vec(b.pt1bc), e.pt1bc],
  ];
  for (const [k, a, x] of vecs) if (!closeVec(a, x)) bad.push(`${tag}.${k} ${a} vs ${x}`);
  if (!closeNum(b.imp19c, e.imp19c)) bad.push(`${tag}.imp19c ${b.imp19c} vs ${e.imp19c}`);
  if (!closeNum(b.imp190, e.imp190)) bad.push(`${tag}.imp190 ${b.imp190} vs ${e.imp190}`);
  if (b.flags !== e.flags) bad.push(`${tag}.flags ${b.flags} vs ${e.flags}`);
  if (b.sleep !== e.sleep) bad.push(`${tag}.sleep ${b.sleep} vs ${e.sleep}`);
  if (b.T !== 0.2) bad.push(`${tag}.T ${b.T}`);
}

const have = nodeFs.existsSync(FIXTURE);
const doc = have
  ? (JSON.parse(new TextDecoder().decode(nodeZlib.gunzipSync(nodeFs.readFileSync(FIXTURE)))) as {
      summary: Record<string, number>;
      cases: Case[];
    })
  : null;

describe('car hulls (Car_<Name>.col)', () => {
  it('all 29 cars: 18 points, 10 quads, 10 outward planes (COM inside), radius = max |p|', () => {
    const names = Object.keys(CAR_COL);
    expect(names.length).toBe(29);
    for (const n of names) {
      const h = carContactHull(n)!;
      expect(h.nPts).toBe(18);
      expect(h.nPl).toBe(10);
      let r = 0;
      for (let i = 0; i < 18; i++) {
        r = Math.max(r, Math.hypot(h.px[i], h.py[i], h.pz[i]));
      }
      // outward-wound [D dyn_survey: all 29]: the centre of mass (origin) is inside every plane (n.0 - d <= 0)
      for (let k = 0; k < 10; k++) expect(h.nd[k]).toBeGreaterThan(0);
      expect(h.radius).toBeCloseTo(r, 5);
      for (let k = 0; k < 10; k++) expect(Math.hypot(h.nx[k], h.ny[k], h.nz[k])).toBeCloseTo(1, 6);
    }
  });
});

describe.skipIf(!doc)('car-car contact vs the executed original (unicorn)', () => {
  it('replays >= 2000 cases with the real hulls: 0 disagreements', () => {
    const cases = doc!.cases;
    expect(cases.length).toBeGreaterThanOrEqual(2000);
    expect(doc!.summary.cases).toBeGreaterThanOrEqual(8000);
    let contacts = 0;
    let ties = 0;
    const seen = { slot0: 0, slot1: 0, cap30000: 0, cap10000: 0, asleep: 0, miss: 0 };
    const failures: string[] = [];
    for (let n = 0; n < cases.length; n++) {
      const c = cases[n];
      const A = bodyOf(c.A, c.inA);
      const B = bodyOf(c.B, c.inB);
      const r = contactBodies(1, A, B, !!c.mp);
      const bad: string[] = [];
      if (r !== !!c.ret) bad.push(`ret ${r} vs ${c.ret}`);
      if (c.ret && r) {
        contacts++;
        if (lastSlot !== c.slot) bad.push(`slot ${lastSlot} vs ${c.slot}`);
        check(A, c.outA!, bad, 'A');
        check(B, c.outB!, bad, 'B');
        seen[c.slot === 0 ? 'slot0' : 'slot1']++;
        const top = Math.max(c.outA!.imp19c, c.outB!.imp19c);
        if (Math.abs(top - (c.mp ? 10000 : 30000)) < 1) seen[c.mp ? 'cap10000' : 'cap30000']++;
      } else if (!c.ret) {
        if (c.inA.sleep && c.inB.sleep) seen.asleep++;
        else seen.miss++;
        // a miss changes nothing: v, L, pos untouched
        if (!closeVec(vec(A.v), c.inA.v, 0, 0) || !closeVec(vec(B.pos), c.inB.pos, 0, 0)) bad.push('miss moved a body');
      }
      if (bad.length) {
        if ((c.margin ?? 1e9) < 1e-5) ties++;
        else failures.push(`case ${n} ${c.A} vs ${c.B}: ${bad.slice(0, 4).join('; ')}`);
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    expect(ties).toBe(0);
    // coverage of every branch
    expect(contacts).toBeGreaterThanOrEqual(2000);
    expect(seen.slot0).toBeGreaterThan(300);
    expect(seen.slot1).toBeGreaterThan(300);
    expect(seen.cap30000).toBeGreaterThan(10);
    expect(seen.cap10000).toBeGreaterThan(10);
    expect(seen.asleep).toBeGreaterThan(10);
    expect(seen.miss).toBeGreaterThan(50);
  });
});

describe('stepCarContacts pair loop', () => {
  /** A minimal car for the loop: only contactBody(). */
  function fake(name: string, x: number, z: number, collidable = true) {
    const b = makeContactBody(carContactHull(name)!, 1000, { x: 400, y: 500, z: 300 });
    b.pos.x = x;
    b.pos.z = z;
    b.collidable = collidable;
    return { b, contactBody: () => b } as unknown as { b: ContactBody; contactBody(): ContactBody } & import('../../src/core/types').ICarSim;
  }

  it('walks (i, j >= i) once per pair, skips the self pair and non-collidable cars, records carHits/carStrength', () => {
    setContactMultiplayer(false);
    const a = fake('Micra', 0, 0);
    const b = fake('Micra', 0, 3.2); // nose to tail: the hulls overlap
    const c = fake('Micra', 40, 0);
    const d = fake('Micra', 0, 3.1, false); // overlapping but not collidable
    a.b.v.z = 20;
    const res = stepCarContacts([a, b, c, d], 1 / 120);
    expect(res.pairs).toBe(1);
    expect(res.maxImpulse).toBeGreaterThan(0);
    expect(a.b.carHits).toBe(1);
    expect(b.b.carHits).toBe(1);
    expect(c.b.carHits).toBe(0);
    expect(d.b.carHits).toBe(0);
    expect(a.b.carStrength).toBeGreaterThan(0);
    expect(b.b.carStrength).toBeCloseTo(a.b.carStrength, 9);
    // momentum along the contact normal is conserved (equal masses): the pair shares the closing speed
    expect(a.b.v.z + b.b.v.z).toBeCloseTo(20, 6);
    expect(a.b.v.z).toBeLessThan(20);
    expect(b.b.v.z).toBeGreaterThan(0);
  });

  it('a single car, or cars without contactBody, do nothing', () => {
    const a = fake('Micra', 0, 0);
    expect(stepCarContacts([a], 1 / 120).pairs).toBe(0);
    expect(stepCarContacts([a, { id: 'x' } as never], 1 / 120).pairs).toBe(0);
  });
});
