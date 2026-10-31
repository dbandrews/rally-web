/**
 * src/game/ai/aicar.ts — the original AI car object's per-frame logic: FUN_00607280 (vtable slot +0x0c, "refresh":
 * spline state, post parameters, lateral window) and FUN_00607ae0 (slot +0x10, "drive": circle-law target speed,
 * look-ahead, curve cut, overtake machine, near-car cuts, spin recovery, then the low-level controller FUN_007e0540).
 * Docs: docs/orig/ai.md (the field map, every constant and every branch with its address), research/formats/ai.md.
 *
 * FIDELITY. The object is a typed memory block laid out exactly like the exe's RallyCar (`mem`, offsets = the exe's);
 * every float field store rounds to float32 like the exe, locals the exe keeps in `[esp+..]` are rounded at the same
 * stores, x87 intermediates stay float64. Constants are the exe's immediates with their operand width (f32 / f64).
 * Verified against the ORIGINAL functions executed in unicorn on synthetic object graphs (research/tools/ai_hl_emu.py,
 * fixtures tests/game/ai/fixtures/*.json, tests/game/ai/aicar.test.ts).
 *
 * The exe reaches the world through three interfaces, mirrored here as `AiEnv`:
 *  - the PhysCar `ctl` (pedals, CP speed, body position / forward axis / signed forward speed),
 *  - the spline manager singleton DAT_00935548 (vt+0x14 advance, +0x18 point, +0x24 nearest, +0x1c length, +0x54 post,
 *    and the per-segment sorted car list +0x38..+0x44),
 *  - the other RallyCars (`AiPeer`: their lapDist +0x74, lateral +0x7c, post window +0x84/+0x88/+0x94/+0x98, +0x9c,
 *    recSpeed +0x5c and controller speed +0x1c4).
 * Single-segment tracks (all 48 stages have one centre spline): the segment id is carried but always 0.
 */
import { AiController } from './ctrl';

const f32 = Math.fround;
// x87 at the game's 24-bit precision control (D3D8 switches it; docs/orig/ai.md section 1): every FADD/FSUB/FMUL/FDIV/
// FSQRT result is rounded to float32. Transcendentals (FSIN/FCOS/FPATAN) are not affected by the precision control.
const mul = (a: number, b: number): number => f32(a * b);
const add = (a: number, b: number): number => f32(a + b);
const sub = (a: number, b: number): number => f32(a - b);
const div = (a: number, b: number): number => f32(a / b);
const sqr = (a: number): number => f32(Math.sqrt(a));
const sum3 = (x: number, y: number, z: number): number => add(add(mul(x, x), mul(y, y)), mul(z, z));
/** FUN_007a0770 = _CIacos at the 24-bit control word: fpatan(sqrt((1+x)(1-x)), x), the argument ops rounded to f32. */
export const acosX87 = (x: number): number => Math.atan2(sqr(mul(add(1, x), sub(1, x))), x);

// ---------------------------------------------------------------------------------------------------- constants
// float32 immediates (DWORD PTR) and float64 immediates (QWORD PTR) with the exe address they come from.
const K1 = f32(1); // 0x7fc798
const K0_2 = f32(0.2); // 0x7fc78c
const K10 = f32(10); // 0x805ff4
const K0_5 = f32(0.5); // 0x8061c4
const K0_25 = f32(0.25); // 0x8061d0
const K0_1 = f32(0.1); // 0x8061d8
const K0_4 = f32(0.4); // 0x8065c0
const K0_6 = f32(0.6); // 0x8065e8
const K0_75 = f32(0.75); // 0x80660c
const K0_7 = f32(0.7); // 0x8066f4
const K2 = f32(2); // 0x806700
const K2_5 = f32(2.5); // 0x806708
const K3_6 = f32(3.6); // 0x8070a0
const K5 = f32(5); // 0x8070c8
const K1_5 = f32(1.5); // 0x8070d0
const K3 = f32(3); // 0x807b24
const K50 = f32(50); // 0x807b2c
const K60 = f32(60); // 0x80cb98
const K0_6667 = f32(0.666666687); // 0x80d4d8
const K1e12 = f32(1e-12); // 0x81a0d8
const K0_5714 = f32(0.571428597); // 0x81a378
const K0_2778 = f32(0.277777791); // 0x81a388
const K15 = f32(15); // 0x81a398
const K0_4b = f32(0.399999976); // 0x81a39c
const K0_2b = f32(0.199999988); // 0x81a3a0
const K0_975 = f32(0.975000024); // 0x81a3c8
const K30 = f32(30); // 0x81a3cc
const K12 = f32(12); // 0x81a3d0
const K2_75 = f32(2.75); // 0x81a3d4
const K1_125 = f32(1.125); // 0x81a3d8
const K1_6 = f32(0.166666672); // 0x81a3dc
const K6 = f32(6); // 0x81a3e0
const K9_82 = f32(9.81999969); // 0x81a3e4
const KHALFPI = f32(1.57079637); // 0x81a3e8
const K0_002 = f32(0.00200000009); // 0x81a3ec
const TINY2 = f32(K1e12 * K1e12); // 0x920e84 (static init 0x606970)
const K250 = f32(250); // 0x437a0000
const K40 = f32(40);
const K0_65 = f32(0.65); // 0x81a34c
const K0_85 = f32(0.85); // 0x81a340
const K_800 = f32(-800); // 0x81a350
const K_400 = f32(-400); // 0x81a348
const K_200 = f32(-200); // 0x81a344
const D_PI = 3; // qword 0x808438
const D_10 = 10; // qword 0x814088
const D_0_9 = 0.89999997615814209; // qword 0x81a358
const D_0_75 = 0.75; // qword 0x81a360
const D_40 = 40; // qword 0x81a368
const D_30 = 30; // qword 0x81a370
const D_15 = 15; // qword 0x81a380
const D_0_3 = 0.30000001192092896; // qword 0x81a390
const D_6 = 6; // qword 0x81a3a8
const D_1_125 = 1.125; // qword 0x81a3b0
const D_25 = 25; // qword 0x81a3b8
const D_0_175 = 0.17499999999999999; // qword 0x81a3c0
const D_20 = 20; // qword 0x806330
const D_5 = 5; // qword 0x808508

// ---------------------------------------------------------------------------------------------------- offsets
export const O = {
  mode: 0x17, // byte: 1 = AI opponent (use AiData post)
  seglen: 0x1c,
  lapsDone: 0x20, // int, race progress (laps) of this car
  distInLap: 0x24, // float, race progress (dist in lap) of this car
  state: 0x2c, // int overtake state 0..3
  headFlag: 0x34, // byte
  tyre: 0x38,
  thrA: 0x3c,
  thrB: 0x40,
  cutBase: 0x44,
  laneScale: 0x48,
  mailActive: 0x4c, // byte
  skill: 0x50,
  spinOn: 0x54, // byte
  spinAng: 0x58,
  rec: 0x5c,
  curveSpd: 0x60,
  curveCut: 0x64,
  lookAhead: 0x68,
  thresh: 0x6c,
  lapDist: 0x74,
  look0: 0x78,
  lat: 0x7c,
  dist3d: 0x80,
  w84: 0x84,
  w88: 0x88,
  w8c: 0x8c,
  w90: 0x90,
  w94: 0x94,
  w98: 0x98,
  yawErr: 0x9c,
  laneDir: 0xa0, // byte: 1 = shift right
  laneVec: 0xa4,
  pos: 0xb4,
  splPt: 0xc0,
  fwdRaw: 0xcc,
  fwd: 0xd8,
  offA: 0xe4,
  offB: 0xf0,
  tan0: 0xfc,
  tan: 0x108,
  right: 0x114,
  pt0: 0x120,
  pt1: 0x12c,
  v144: 0x144,
  v150: 0x150,
  v168: 0x168,
  v174: 0x174,
  seg: 0x18c, // int
  segDist: 0x190, // float
  pair194: 0x194,
  pair19c: 0x19c,
  handle: 0x1ac,
  post: 0x1b0,
  ctrl: 0x1b4,
  ctrlTimer: 0x1bc,
  ctrlV: 0x1c4,
} as const;

// ---------------------------------------------------------------------------------------------------- interfaces
export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** What the exe reads from another RallyCar (the overtake machine's "other car"). */
export interface AiPeer {
  lapDist: number; // +0x74 (vt+0x78)
  lat: number; // +0x7c (vt+0x88)
  recSpeed: number; // +0x5c km/h (vt+0x30)
  w84: number; // +0x84 (vt+0x98)
  w88: number; // +0x88 (vt+0x9c)
  w94: number;
  w98: number;
  yawErr: number; // +0x9c
  speed: number; // +0x1c4 = the controller's signed speed, m/s (vt+0x104)
}

/** The per-sample post record of the spline manager (vt+0x54): AiData parameters + the side-clearance (side.rsd). */
export interface AiPost {
  rec: number; // post+0x08 recSpeed (m/s, AiData units)
  curveSpd: number; // +0x0c
  curveCut: number; // +0x10
  lookAhead: number; // +0x14
  thresh: number; // +0x18
  left: number; // +0x1c
  right: number; // +0x20
}

export interface AiEnv {
  // --- PhysCar ctl
  getSteer(): number;
  getThrottle(): number;
  getBrake(): number;
  setPedals(steer: number, thr: number, brk: number): void;
  setHandbrake(v: number): void;
  /** CP+0x08 (FUN_006c4ba0) km/h. */
  speedKmh(): number;
  /** B+0x34 (FUN_006c4b90) signed forward speed, m/s. */
  speedSigned(): number;
  /** B+0xc8 (FUN_006c4b30). */
  bodyPos(): V3;
  /** B+0xb8 (FUN_006c4b60) body forward axis. */
  bodyFwd(): V3;
  /** CP+0x30 byte (FUN_006c4bb0): written by the controller's out byte. */
  setOutByte(v: number): void;
  // --- spline manager (single segment)
  /** vt+0x24: nearest point on the segment for the car (the in/out pair's distance). */
  nearest(prevDist: number): number;
  /** vt+0x1c: segment length. */
  segLength(): number;
  /** vt+0x14: advance the pair by d (wraps on closed segments, clamps on open ones). */
  advance(dist: number, d: number): number;
  /** vt+0x18: the 3-D point (sim space) at a pair distance. */
  pointAt(dist: number): V3;
  /** vt+0x54: the post record at a pair distance (null = none). */
  postAt(dist: number): AiPost | null;
  /** The car ahead / behind in the segment's sorted list, resolved like the exe (vt+0x40/+0x38, +0x44/+0x3c, self = null). */
  carAhead(): AiPeer | null;
  carBehind(): AiPeer | null;
  // --- the 0x8e5a84 mailbox (FUN_00607280 flag 0 stores, flag 1 reads)
  mailStore(dist: number, laps: number): void;
  mailDist(): number;
  mailLaps(): number;
}

// ---------------------------------------------------------------------------------------------------- the car
export class AiCar implements AiPeer {
  readonly m = new DataView(new ArrayBuffer(0x200));
  readonly ctrl = new AiController();
  /** The overtake target ([esi+0xb0]). */
  target: AiPeer | null = null;
  /** Last frame's target speed handed to the controller, km/h (debug / tools; not an exe field). */
  lastTargetKmh = 0;
  /** Last frame's circle-law speed before the caps, km/h, and the chord / cosine it came from (debug). */
  lastCircleKmh = 0;

  constructor() {
    this.construct();
  }

  // ---- memory helpers
  f(o: number): number {
    return this.m.getFloat32(o, true);
  }
  sf(o: number, v: number): void {
    this.m.setFloat32(o, v, true);
  }
  i(o: number): number {
    return this.m.getInt32(o, true);
  }
  si(o: number, v: number): void {
    this.m.setInt32(o, v, true);
  }
  b(o: number): number {
    return this.m.getUint8(o);
  }
  sb(o: number, v: number): void {
    this.m.setUint8(o, v);
  }

  // ---- AiPeer view (the exe's vtable getters)
  get lapDist(): number { return this.f(O.lapDist); }
  get lat(): number { return this.f(O.lat); }
  get recSpeed(): number { return this.f(O.rec); }
  get w84(): number { return this.f(O.w84); }
  get w88(): number { return this.f(O.w88); }
  get w94(): number { return this.f(O.w94); }
  get w98(): number { return this.f(O.w98); }
  get yawErr(): number { return this.f(O.yawErr); }
  get speed(): number { return this.f(O.ctrlV); }

  /** RallyCar constructor FUN_00606cd6 defaults (the fields the AI code reads). */
  construct(): void {
    this.sb(0x18, 1);
    this.sf(O.tyre, 1);
    this.sf(O.thrA, 1);
    this.sf(O.thrB, 0);
    this.sf(O.cutBase, 1);
    this.sf(O.laneScale, 1);
    this.sb(O.mailActive, 1);
    this.sf(O.skill, 1);
    this.sf(O.rec, 10);
    this.sf(O.curveSpd, 1);
    this.sf(O.curveCut, 0.25);
    this.sf(O.lookAhead, 6);
    this.sf(O.thresh, 1);
    this.sb(O.laneDir, 1);
    this.si(O.seg, -1);
    this.si(O.handle, 0);
  }

  /**
   * FUN_00609550 (vtable +0x14, arg 0): zero the AI state block, the controller included, and publish mailbox dist = -1.
   * Fields kept: mode +0x17, tyre +0x38, skill +0x50, the post parameters +0x5c..+0x6c, the segment pair +0x18c and the handle.
   */
  reset(env: AiEnv | null): void {
    this.ctrl.reset();
    if (env) env.mailStore(-1, 0);
    this.si(0x28, 0);
    this.si(O.state, 0);
    this.si(0x30, 0);
    this.sb(O.headFlag, 0);
    this.si(O.lapsDone, 0);
    this.sf(O.distInLap, 0);
    this.sb(O.spinOn, 0);
    this.sf(O.spinAng, 0);
    for (let o = 0x70; o <= 0x9c; o += 4) this.si(o, 0);
    this.sb(O.laneDir, 1);
    for (let o = 0xa4; o <= 0x110; o += 4) this.si(o, 0);
    for (let o = 0x120; o <= 0x188; o += 4) this.si(o, 0);
    this.target = null;
  }

  // ======================================================================================================
  // FUN_00607280 — refresh (vtable +0x0c). flag: 0 = store the car's progress in the mailbox, 1 = read it (AI).
  // ======================================================================================================
  refresh(env: AiEnv, flag: number): void {
    // the exe first reads the car's position (6c4b30) and, with no handle yet, finds the car's segment and registers it in the
    // segment's car list (vt+0x20/+0x30/+0x48; on failure it takes the defaults path 0x607317 and returns). All stages have one
    // segment: the port registers the car on segment 0 with a fixed handle.
    if (this.i(O.handle) === 0) this.si(O.handle, 1);
    if (this.i(O.seg) < 0) this.si(O.seg, 0);
    // vt+0x24 nearest, vt+0x4c re-sort, lapDist = pair distance, segment length
    this.sf(O.segDist, env.nearest(this.f(O.segDist)));
    this.sf(O.lapDist, this.f(O.segDist));
    this.sf(O.seglen, env.segLength());
    // look-ahead base: speed / lookAheadDist + 5 (the divisor is the post look-ahead)
    if (this.f(O.lookAhead) > 0) this.sf(O.look0, add(div(env.speedKmh(), this.f(O.lookAhead)), K5));
    else this.sf(O.look0, 5);
    // car position (y zeroed) and the body forward axis (horizontal, normalised)
    const p = env.bodyPos();
    this.sf(O.pos, p.x);
    this.sf(O.pos + 8, p.z);
    this.sf(O.pos + 4, 0);
    const a = env.bodyFwd();
    this.sf(O.fwdRaw, a.x);
    this.sf(O.fwdRaw + 4, a.y);
    this.sf(O.fwdRaw + 8, a.z);
    this.sf(O.fwdRaw + 4, 0);
    this.sf(O.fwd, this.f(O.fwdRaw));
    this.sf(O.fwd + 4, this.f(O.fwdRaw + 4));
    this.sf(O.fwd + 8, this.f(O.fwdRaw + 8));
    this.normScaled(O.fwd);
    // the spline point under the car, offsets
    const sp = env.pointAt(this.f(O.segDist));
    this.sf(O.splPt, sp.x);
    this.sf(O.splPt + 4, sp.y);
    this.sf(O.splPt + 8, sp.z);
    // 3-D offset (with the car's real y) -> |.| in +0x80 (the x87 chain: f32 differences, sqrt in extended)
    const ox = sub(p.x, this.f(O.splPt));
    const oy = sub(p.y, this.f(O.splPt + 4));
    const oz = sub(p.z, this.f(O.splPt + 8));
    this.sf(O.offA, ox);
    this.sf(O.offA + 4, oy);
    this.sf(O.offA + 8, oz);
    this.sf(O.offB, ox);
    this.sf(O.offB + 4, oy);
    this.sf(O.offB + 8, oz);
    this.sf(O.dist3d, sqr(sum3(ox, oy, oz)));
    // horizontal offset from the pos copy (y of pos is 0, so y = -spline y, then forced 0 below)
    this.sf(O.offA, sub(this.f(O.pos), this.f(O.splPt)));
    this.sf(O.offA + 8, sub(this.f(O.pos + 8), this.f(O.splPt + 8)));
    this.si(O.offA + 4, 0);
    // |horizontal offset| (FUN_007e1150) = lateral magnitude
    this.sf(O.lat, sqr(add(mul(this.f(O.offA + 8), this.f(O.offA + 8)), mul(this.f(O.offA), this.f(O.offA)))));
    // the segment tangent from the point 1 m ahead
    const ahead1 = env.advance(this.f(O.segDist), 1.0);
    const sp1 = env.pointAt(ahead1);
    this.sf(O.tan0, sub(sp1.x, this.f(O.splPt)));
    this.sf(O.tan0 + 4, sub(sp1.y, this.f(O.splPt + 4)));
    this.sf(O.tan0 + 8, sub(sp1.z, this.f(O.splPt + 8)));
    this.sf(O.tan, this.f(O.tan0));
    this.sf(O.tan + 4, this.f(O.tan0 + 4));
    this.sf(O.tan + 8, this.f(O.tan0 + 8));
    this.normScaled(O.tan);
    // right vector = (tz, 0, -tx), normalised
    this.sf(O.right, this.f(O.tan + 8));
    this.si(O.right + 4, 0);
    this.sf(O.right + 8, -this.f(O.tan));
    this.normInline(O.right);
    // yaw error = 3 * cross(heading, tangent)
    const crossHT = sub(mul(this.f(O.fwd + 8), this.f(O.tan)), mul(this.f(O.tan + 8), this.f(O.fwd)));
    this.sf(O.yawErr, mul(crossHT, K3));
    // sign of the lateral offset: cross(offset, tangent0xfc) >= 0 flips it
    const crossOT = sub(mul(this.f(O.offA + 8), this.f(O.tan0)), mul(this.f(O.tan0 + 8), this.f(O.offA)));
    if (!(crossOT < 0)) this.sf(O.lat, -this.f(O.lat));
    // the near look-ahead point and the post there
    const pairNear = env.advance(this.f(O.segDist), this.f(O.look0));
    this.si(O.pair194, 0);
    this.sf(O.pair194 + 4, pairNear);
    const q = env.pointAt(pairNear);
    this.sf(O.pt0, q.x);
    this.sf(O.pt0 + 4, q.y);
    this.sf(O.pt0 + 8, q.z);
    const post = env.postAt(pairNear);
    this.si(O.post, post ? 1 : 0);
    if (!post) return;
    const mode = this.b(O.mode);
    if (mode === 1) {
      this.sf(O.rec, mul(post.rec, K3_6));
      if (this.f(O.rec) < K10) this.sf(O.rec, K250);
      if (!(Math.abs(this.f(O.lat)) <= K10)) this.sf(O.rec, K40);
    }
    this.sf(O.w84, post.left);
    this.sf(O.w88, post.right);
    this.sf(O.w8c, add(post.left, post.left));
    this.sb(0x18, 1);
    this.sf(O.w90, add(post.right, post.right));
    this.sf(O.w94, add(this.f(O.w84), this.f(O.lat)));
    this.sf(O.w98, sub(this.f(O.w88), this.f(O.lat)));
    if (mode !== 1 && post.rec > 0) this.sf(O.rec, post.rec);
    if (post.curveSpd > 0) this.sf(O.curveSpd, post.curveSpd);
    if (post.curveCut > 0) this.sf(O.curveCut, post.curveCut);
    if (post.lookAhead > 0) this.sf(O.lookAhead, post.lookAhead);
    if (post.thresh > 0) this.sf(O.thresh, post.thresh);
    if (this.b(O.mailActive) === 1) {
      if (flag === 0) {
        env.mailStore(this.f(O.distInLap), this.i(O.lapsDone));
      } else if (flag === 1) {
        const md = env.mailDist();
        const ml = env.mailLaps();
        if (!(md < 0)) {
          const len = this.f(O.seglen);
          const d = sub(add(mul(ml, len), md), add(mul(this.i(O.lapsDone), len), this.f(O.distInLap)));
          // behind-schedule rubber band: the mailbox car is `d` metres ahead (+) / behind (-) of this car
          if (!(d >= K_800)) this.sf(O.curveSpd, mul(this.f(O.curveSpd), K0_65));
          else if (!(d >= K_400)) this.sf(O.curveSpd, mul(this.f(O.curveSpd), K0_75));
          else if (d < K_200) this.sf(O.curveSpd, mul(this.f(O.curveSpd), K0_85));
        }
      }
    }
    this.sf(O.curveSpd, mul(this.f(O.skill), this.f(O.curveSpd)));
    if (Math.abs(this.f(O.lat)) > K10 && !(this.f(O.rec) <= K40)) this.sf(O.rec, K40); // 0x81a33c = 40 (not the 60 of FUN_00607ae0)
  }

  /** The exe's vector normalisation (both the inline copies and FUN_00407630): |n2-1| < eps skip; |n2| >= tiny^2 scale by
   *  f32(1/sqrt(n2)) (each x87 op rounded); else zero. */
  private normScaled(o: number): void {
    const x = this.f(o);
    const y = this.f(o + 4);
    const z = this.f(o + 8);
    const n2 = sum3(x, y, z);
    if (!(Math.abs(sub(n2, 1)) < K1e12)) {
      if (!(Math.abs(n2) >= TINY2)) {
        this.si(o, 0);
        this.si(o + 4, 0);
        this.si(o + 8, 0);
      } else {
        const sc = div(1, sqr(n2));
        this.sf(o, mul(sc, x));
        this.sf(o + 4, mul(sc, y));
        this.sf(o + 8, mul(sc, z));
      }
    }
  }
  private normInline(o: number): void {
    this.normScaled(o);
  }

  // ======================================================================================================
  // FUN_00607ae0 — drive (vtable +0x10). The overtake machine (0x6081bd..0x6087d6) is transcribed block by block
  // (labels = exe addresses) because its branches cross freely; everything else is straight-line.
  // ======================================================================================================
  update(env: AiEnv, dt: number): void {
    dt = f32(dt);
    const m = this;
    if (m.i(O.seg) < 0) {
      env.setPedals(0, 0, 0);
      return;
    }
    env.setHandbrake(0);

    // ---- far look-ahead point (2 x look0 ahead) -> +0x12c; vectors from the car, unit copies
    const pairFar = env.advance(m.f(O.segDist), mul(2, m.f(O.look0)));
    m.si(O.pair19c, 0);
    m.sf(O.pair19c + 4, pairFar);
    const far = env.pointAt(pairFar);
    m.sf(O.pt1, far.x);
    m.sf(O.pt1 + 4, far.y);
    m.sf(O.pt1 + 8, far.z);
    // T = the target point the controller steers to; starts as the near look-ahead point (+0x120)
    let tx = m.f(O.pt0);
    let ty = m.f(O.pt0 + 4);
    let tz = m.f(O.pt0 + 8);
    m.sf(O.v144, m.f(O.pt0) - m.f(O.pos));
    m.sf(O.v144 + 4, 0);
    m.sf(O.v144 + 8, m.f(O.pt0 + 8) - m.f(O.pos + 8));
    m.sf(O.v150, m.f(O.pt1) - m.f(O.pos));
    m.sf(O.v150 + 4, 0);
    m.sf(O.v150 + 8, m.f(O.pt1 + 8) - m.f(O.pos + 8));
    for (let k = 0; k < 12; k += 4) {
      m.sf(O.v168 + k, m.f(O.v144 + k));
      m.sf(O.v174 + k, m.f(O.v150 + k));
    }
    m.normInline(O.v168);
    m.normInline(O.v174);

    // ---- heading error h = FUN_007e1110(v174, tan) = v174.z*tan.x - tan.z*v174.x (signed, float32); hAbs = |extended|
    m.sb(O.headFlag, 0);
    const hExt = sub(mul(m.f(O.v174 + 8), m.f(O.tan)), mul(m.f(O.tan + 8), m.f(O.v174)));
    let h = hExt; // L34
    const hAbs = Math.abs(hExt); // L3c (qword)
    const spd = env.speedKmh();
    if (sub(K0_5, mul(spd, K0_002)) < hAbs) m.sb(O.headFlag, 1);
    // chord to the far point, its cosine with the tangent -> the circle-law speed (R = chord / (2 sin theta))
    const chord = sqr(sum3(m.f(O.v150), m.f(O.v150 + 4), m.f(O.v150 + 8)));
    let cs = div(add(mul(m.f(O.tan + 8), m.f(O.v150 + 8)), mul(m.f(O.v150), m.f(O.tan))), chord); // FUN_007e1130 / chord
    if (!(cs <= 1.0)) cs = 1.0;
    const theta = acosX87(cs); // FUN_007a0770 = _CIacos
    let vt = mul(mul(sqr(mul(div(chord, mul(2, Math.cos(sub(KHALFPI, theta)))), K9_82)), mul(m.f(O.curveSpd), m.f(O.tyre))), K3_6); // L2c km/h

    // ---- curve cut: shift the target sideways by window * curveCut * |h|
    if (h < 0) {
      const t = mul(mul(m.f(O.w88), m.f(O.curveCut)), hAbs);
      tx = add(tx, mul(t, m.f(O.right)));
      ty = add(ty, mul(t, m.f(O.right + 4)));
      tz = add(tz, mul(t, m.f(O.right + 8)));
    } else if (h > 0) {
      const t = mul(mul(m.f(O.w84), m.f(O.curveCut)), hAbs);
      tx = sub(tx, mul(t, m.f(O.right)));
      ty = sub(ty, mul(t, m.f(O.right + 4)));
      tz = sub(tz, mul(t, m.f(O.right + 8)));
    }
    // ---- heading flag: slow down by the lateral displacement (not at state 0)
    if (m.b(O.headFlag) === 1 && m.f(O.rec) > K60) {
      let t2 = div(mul(mul(Math.abs(m.f(O.lat)), K6), hAbs), add(m.f(O.w88), m.f(O.w84)));
      if (m.i(O.state) !== 0) {
        if (!(t2 <= K0_6)) t2 = K0_6;
        vt = mul(sub(K1, t2), vt);
      }
    }
    // ---- L38 = look-ahead gate (m); L30 = lateral margin (m)
    let L38 = mul(add(mul(sub(D_PI, hAbs), add(mul(spd, K1_6), K5)), D_10), m.f(O.thresh));
    let cut = sub(K2, m.f(O.cutBase));
    if (!(cut >= 0)) cut = 0;
    const L30 = sub(add(mul(hAbs, K1_125), K2_75), cut);

    // ---- the cars ahead / behind in the segment's sorted list
    const ahead = env.carAhead();
    env.carBehind(); // the exe computes the wrapped gap to the car behind and calls its lateral getter; unused
    let L11 = 0; // lateral overlap with the car ahead
    let L12 = 1; // 1: the car ahead is level/right of us
    let L18 = 0; // wrapped gap to the car ahead (m)
    let L10 = 0; // an overtake attempt was aborted this frame
    let L13 = 0;
    const len = m.f(O.seglen);
    /** the exe's wrap: add the segment length while negative, then subtract while above it (float32 each step). */
    const wrap = (d: number): number => {
      while (d < 0) d = add(d, len);
      while (!(d <= len)) d = sub(d, len);
      return d;
    };
    if (ahead) {
      L18 = wrap(sub(ahead.lapDist, m.f(O.lapDist)));
      if (L18 < L38) {
        const mm = add(Math.abs(ahead.yawErr), L30);
        const sl = m.f(O.lat);
        L11 = sub(sl, mm) < ahead.lat && add(sl, mm) > ahead.lat ? 1 : 0;
        L12 = ahead.lat >= sl ? 1 : 0;
      }
    }

    const mySpeedKmh = (): number => mul(m.f(O.ctrlV), K3_6);
    let state = m.i(O.state);
    const setState = (s: number): void => {
      state = s;
      m.si(O.state, s);
    };
    const cl = (): void => {
      m.target = null;
    };

    // ===== 0x6081bd .. 0x6087d6 : state machine
    let pc = 0x6081bd;
    let w = 0; // L28
    let inc = 0;
    let A: AiPeer | null = ahead; // edi
    run: for (;;) {
      switch (pc) {
        case 0x6081bd: {
          L10 = 0;
          pc = state === 2 ? 0x6081ce : 0x60859e;
          continue run;
        }
        case 0x6081ce: {
          // state 2
          const tgt = m.target;
          if (!tgt) {
            pc = 0x608596;
            continue run;
          }
          w = wrap(sub(tgt.lapDist, m.f(O.lapDist)));
          if (tgt.lapDist < m.f(O.lapDist) && w < K12) {
            setState(3);
            cl();
            pc = 0x6087d6;
            continue run;
          }
          // 0x608276
          if (!(w <= L38)) {
            setState(0);
            cl();
            pc = 0x6087d6;
            continue run;
          }
          L38 = mul(tgt.speed, K3_6);
          if (!(add(mySpeedKmh(), K30) >= L38)) {
            setState(0);
            cl();
            pc = 0x6087d6;
            continue run;
          }
          // 0x6082da
          if (L11 !== 1) {
            pc = 0x6084c8;
            continue run;
          }
          L38 = mySpeedKmh();
          if (add(mul(A!.speed, K3_6), K2_5) < L38) {
            pc = 0x60834a;
            continue run;
          }
          L38 = mul(A!.speed, K3_6);
          pc = sub(A!.recSpeed, K30) <= L38 ? 0x6087d6 : 0x60834a;
          continue run;
        }
        case 0x60834a: {
          // start / restart an overtake of A (also 0x608ba3 from state 0/3)
          setState(1);
          m.target = A;
          w = mul(add(Math.abs(A!.yawErr), mul(L30, K0_975)), add(hAbs, 1));
          if (hAbs <= D_0_175) {
            pc = 0x6083bf;
          } else if (h <= 0) {
            pc = 0x608bf8;
          } else {
            // 0x60839f (h > 0)
            if (m.f(O.w98) <= w) pc = 0x6084b5;
            else pc = A!.w98 > w ? 0x608c6d : 0x6084b5;
          }
          continue run;
        }
        case 0x6083bf: {
          if (mySpeedKmh() >= D_25) {
            pc = 0x608400;
            continue run;
          }
          if (L12 === 0) {
            // 0x608c5c: other.w88
            pc = A!.w88 <= K1 ? 0x608461 : 0x608c6d;
          } else {
            // 0x608c81: other.w84
            pc = A!.w84 <= K1 ? 0x608ce1 : 0x608c8e;
          }
          continue run;
        }
        case 0x608400: {
          const t = m.target!;
          if (t.w98 < t.w94) {
            pc = 0x60846d;
            continue run;
          }
          if (m.f(O.w98) <= w) {
            pc = 0x60843f;
            continue run;
          }
          pc = t.w98 > w ? 0x608c6d : 0x60843f;
          continue run;
        }
        case 0x60843f: {
          const t = m.target!;
          if (m.f(O.w94) <= w) pc = 0x6084b5;
          else if (t.w94 <= w) pc = 0x6084b5;
          else pc = 0x608461;
          continue run;
        }
        case 0x60846d: {
          const t = m.target!;
          if (m.f(O.w94) <= w) {
            pc = 0x60848f;
            continue run;
          }
          pc = t.w94 > w ? 0x608461 : 0x60848f;
          continue run;
        }
        case 0x60848f: {
          const t = m.target!;
          if (m.f(O.w98) <= w) pc = 0x6084b5;
          else pc = t.w98 > w ? 0x608c6d : 0x6084b5;
          continue run;
        }
        case 0x608bf8: {
          // |h| > 0.175 and h <= 0
          if (h >= 0) {
            pc = 0x6087d6;
            continue run;
          }
          // 0x608c0d
          if (m.f(O.w94) <= w) pc = 0x6084b5;
          else pc = A!.w94 <= w ? 0x6084b5 : 0x608461;
          continue run;
        }
        case 0x6084b5: {
          setState(0);
          cl();
          L10 = 1;
          pc = 0x6087d6;
          continue run;
        }
        case 0x608461:
        case 0x608c8e: {
          m.sb(O.laneDir, 0);
          pc = 0x6087d6;
          continue run;
        }
        case 0x608c6d:
        case 0x608ce1: {
          m.sb(O.laneDir, 1);
          pc = 0x6087d6;
          continue run;
        }
        case 0x6084c8: {
          // state 2, no overlap with the car ahead
          if (Math.abs(m.f(O.lat)) <= K10) {
            const tgt = m.target!;
            if (!(Math.abs(tgt.lat) > K10)) {
              const dir = m.b(O.laneDir);
              if (dir === 1) {
                tx = add(tx, m.f(O.laneVec));
                ty = add(ty, m.f(O.laneVec + 4));
                tz = add(tz, m.f(O.laneVec + 8));
              } else if (dir === 0) {
                tx = sub(tx, m.f(O.laneVec));
                ty = sub(ty, m.f(O.laneVec + 4));
                tz = sub(tz, m.f(O.laneVec + 8));
              }
              pc = 0x6087d6;
              continue run;
            }
          }
          // 0x6084da
          if (mySpeedKmh() > D_25) {
            setState(0);
            cl();
          }
          pc = 0x6087d6;
          continue run;
        }
        case 0x608596: {
          setState(0);
          pc = 0x6087d6;
          continue run;
        }
        case 0x60859e: {
          if (state !== 1) {
            pc = 0x608b26;
            continue run;
          }
          // state 1: overtaking
          const tgt = m.target;
          if (!tgt) {
            pc = 0x608596;
            continue run;
          }
          w = mul(add(Math.abs(tgt.yawErr), mul(L30, K1_125)), add(hAbs, 1));
          const d3 = wrap(sub(tgt.lapDist, m.f(O.lapDist)));
          h = d3; // L34 is reused
          if (tgt.lapDist < m.f(O.lapDist) && d3 < K12) {
            setState(3);
            cl();
            pc = 0x6087d6;
            continue run;
          }
          if (!(d3 <= L38)) {
            setState(0);
            cl();
            pc = 0x6087d6;
            continue run;
          }
          L38 = mul(tgt.speed, K3_6);
          if (!(add(mySpeedKmh(), K30) >= L38)) {
            setState(0);
            cl();
            pc = 0x6087d6;
            continue run;
          }
          // 0x6086d9
          const sl = m.f(O.lat);
          const X = mul(add(Math.abs(tgt.yawErr), L30), D_1_125);
          if (sub(sl, X) >= tgt.lat || add(sl, X) <= tgt.lat) {
            pc = 0x6088d9;
            continue run;
          }
          // 0x608743: still level -> shift the target sideways by inc
          let i0 = Math.abs(div(K50, add(L18, K0_1)));
          inc = i0 <= D_6 ? i0 : 6.0;
          const dir = m.b(O.laneDir);
          if (dir === 1) {
            tx = add(tx, mul(m.f(O.right), inc));
            ty = add(ty, mul(inc, m.f(O.right + 4)));
            tz = add(tz, mul(inc, m.f(O.right + 8)));
          } else if (dir === 0) {
            tx = sub(tx, mul(m.f(O.right), inc));
            ty = sub(ty, mul(inc, m.f(O.right + 4)));
            tz = sub(tz, mul(inc, m.f(O.right + 8)));
          }
          pc = 0x6087d6;
          continue run;
        }
        case 0x6088d9: {
          const tgt = m.target!;
          const sl = m.f(O.lat);
          const X = mul(add(Math.abs(tgt.yawErr), L30), D_1_125);
          if (sub(sl, X) > tgt.lat) {
            pc = 0x608a40;
            continue run;
          }
          if (add(sl, X) < tgt.lat) {
            pc = 0x608a40;
            continue run;
          }
          // 0x60893f: boundary
          if (!(Math.abs(sl) > K10) && Math.abs(tgt.lat) <= K10) {
            const cdir = m.b(O.laneDir);
            if (cdir === 1) {
              const v = mul(w, K0_75);
              if (v > m.f(O.w98) || v > tgt.w98) {
                pc = 0x608a08;
                continue run;
              }
            }
            if (cdir === 0) {
              const v = mul(w, K0_75);
              if (v > m.f(O.w94) || v > tgt.w94) {
                pc = 0x608a08;
                continue run;
              }
            }
            pc = 0x6087d6;
            continue run;
          }
          // 0x60896a
          if (mySpeedKmh() > D_25) {
            setState(0);
            cl();
          }
          pc = 0x6087d6;
          continue run;
        }
        case 0x608a08: {
          if (mySpeedKmh() > D_25) {
            setState(3);
            cl();
            L10 = 1;
          }
          pc = 0x6087d6;
          continue run;
        }
        case 0x608a40: {
          const i0 = Math.abs(div(K50, add(L18, K0_1)));
          inc = i0 <= D_6 ? i0 : 6.0;
          setState(2);
          const dir = m.b(O.laneDir);
          if (dir === 1 || dir === 0) {
            m.sf(O.laneVec, mul(m.f(O.right), inc));
            m.sf(O.laneVec + 4, mul(inc, m.f(O.right + 4)));
            m.sf(O.laneVec + 8, mul(inc, m.f(O.right + 8)));
          }
          pc = 0x6087d6;
          continue run;
        }
        case 0x608b26: {
          // states 0 and 3
          if ((state !== 0 && state !== 3) || L11 !== 1) {
            pc = 0x6087d6;
            continue run;
          }
          L38 = mySpeedKmh();
          if (add(mul(A!.speed, K3_6), K2_5) < L38) {
            pc = 0x60834a;
            continue run;
          }
          L38 = mul(A!.speed, K3_6);
          pc = sub(A!.recSpeed, K30) <= L38 ? 0x6087d6 : 0x60834a;
          continue run;
        }
        case 0x6087d6:
          break run;
        default:
          throw new Error('AiCar.update: bad pc ' + pc.toString(16));
      }
    }

    // ===== 0x6087d6 : a car close ahead and a heading error: cut the speed, maybe drop the manoeuvre
    A = ahead;
    state = m.i(O.state);
    if (m.b(O.headFlag) === 1 && A && (state === 1 || state === 2 || state === 3)) {
      L38 = mul(L30, K2_5);
      const X = add(Math.abs(A.yawErr), L38);
      const sl = m.f(O.lat);
      if (sub(sl, X) < A.lat && add(sl, X) > A.lat) {
        let cutDone = false;
        if (L18 < K6) {
          vt = mul(vt, K0_2b);
          cutDone = true;
        } else if (L18 < K10) {
          vt = mul(vt, K0_4b);
          cutDone = true;
        } else if (L18 < K15) {
          vt = mul(vt, K0_7);
          cutDone = true;
        }
        void cutDone;
        if (hAbs > D_0_3) {
          setState(0);
          cl();
        }
      }
    }

    // ===== 0x608d43 : the speed cap and the throttle trim
    const rec = m.f(O.rec);
    let X: number;
    if (rec > 0) X = vt < rec ? vt : rec;
    else if (rec === 0) X = 0;
    else X = rec;
    L38 = mul(add(m.f(O.thrB), m.f(O.thrA)), X);
    L12 = 0;
    L13 = 0;
    let next: 'x' | 'a' | 'b' | 'c' = 'a';
    if (A && L18 < K6) {
      L13 = 1;
      if (m.i(O.state) !== 1) next = 'b';
      else if (!(mySpeedKmh() < K15)) next = 'b';
      else {
        L12 = 1;
        L38 = K10;
        next = 'c';
      }
    }
    if (next === 'a') {
      if (m.i(O.state) === 3) setState(0);
    } else if (next === 'b') {
      const s = m.i(O.state);
      if (s === 0 || s === 1 || s === 2 || s === 3) {
        setState(3);
        cl();
      }
    } else {
      // 0x608e15: crawl behind a slow car; keep the state while the target moves > 10 km/h
      const tgt = m.target;
      if (!(tgt && Math.abs(mul(tgt.speed, K3_6)) <= K10)) {
        if (tgt) cl();
        L12 = 0;
        setState(0);
      }
    }

    // ===== 0x608e4a : the low-level controller
    const io = { steer: f32(env.getSteer()), thr: f32(env.getThrottle()), brk: f32(env.getBrake()) };
    state = m.i(O.state);
    const reverse = state === 3 ? 1 : 0;
    const p = env.bodyPos();
    void p;
    const c = m.ctrl;
    c.setInputs(env.speedSigned(), m.f(O.pos), m.f(O.pos + 4), m.f(O.pos + 8), m.f(O.fwd), m.f(O.fwd + 4), m.f(O.fwd + 8));
    m.sf(O.ctrlV, c.v);
    m.lastTargetKmh = L38;
    m.lastCircleKmh = vt;
    const out = c.update(io, mul(L38, K0_2778), reverse, tx, ty, tz, m.f(O.tan), m.f(O.tan + 4), m.f(O.tan + 8), dt);
    env.setOutByte(out);
    // the controller state lives inside the object in the exe (+0x1b4..); mirror the timer for the spin recovery reset
    m.sf(O.ctrlTimer, c.timer);

    let f48 = m.f(O.laneScale);
    if (!(f48 >= 0)) f48 = 0;
    const LW = mul(2, f48);
    let steer = io.steer;
    let thr = io.thr;
    let brk = io.brk;
    if (L13 === 1) {
      const A2 = A!;
      const dl = Math.abs(sub(m.f(O.lat), A2.lat));
      const win = add(Math.abs(A2.yawErr), L30);
      const nudge = (k: number): number => mul(mul(LW, dt), k);
      if (win <= dl) {
        if (A2.lat < m.f(O.lat)) steer = sub(steer, nudge(K3));
        else if (A2.lat > m.f(O.lat)) steer = add(steer, nudge(K3));
      } else if (A2.lat < m.f(O.lat)) steer = add(steer, nudge(K6));
      else if (A2.lat > m.f(O.lat)) steer = sub(steer, nudge(K6));
    }

    // ===== 0x609028 : brake assist behind a slower car / after an aborted overtake
    state = m.i(O.state);
    if (state === 0 || state === 1 || state === 2 || state === 3) {
      if (mySpeedKmh() > D_15 && L12 === 0 && L11 === 1) {
        const mine = mySpeedKmh();
        const theirs = mul(A!.speed, K3_6);
        if (!(theirs >= mine)) {
          const dv = sub(mine, theirs);
          if (L18 < D_6) {
            brk = K0_5;
            if (dv > D_20) thr = mul(thr, K0_2);
            else if (dv > D_10) thr = mul(thr, K0_25);
            else if (dv > D_5) thr = mul(thr, K0_5);
            else thr = mul(thr, K0_5714);
          } else if (L18 < D_10) {
            if (dv > D_20) thr = mul(thr, K0_2);
            else if (dv > D_10) thr = mul(thr, K0_4);
            else if (dv > D_5) thr = mul(thr, K0_5714);
            else thr = mul(thr, K0_6667);
            brk = f32(0.125);
          }
        }
      }
    }

    // ===== 0x6091d4 : just aborted, car still alongside: brake harder
    if (L10 === 1 && L11 === 1 && m.i(O.state) !== 1 && mySpeedKmh() > D_15) {
      const A2 = A!;
      const theirs = mul(A2.speed, K3_6);
      if (theirs < K30) {
        if (L18 < D_6) {
          thr = 0;
          brk = 1.0;
        } else if (L18 < D_10) {
          brk = 0.75;
          thr = mul(thr, K0_4);
        } else if (L18 < D_20) {
          brk = 0.5;
          thr = mul(thr, K0_5);
        } else if (L18 < D_30) {
          brk = 0.25;
          thr = mul(thr, K0_5714);
        } else if (L18 < D_40) {
          brk = 0.125;
          thr = mul(thr, K0_6667);
        }
      } else if (sub(mySpeedKmh(), theirs) > K30) {
        if (L18 < D_6) {
          brk = 0.25;
          thr = mul(thr, K0_2);
        } else if (L18 < D_10) {
          brk = 0.25;
          thr = mul(thr, K0_4);
        } else if (L18 < D_20) {
          brk = 0.125;
          thr = mul(thr, K0_5);
        } else if (L18 < D_30) {
          brk = 0.0625;
          thr = mul(thr, K0_5714);
        } else if (L18 < D_40) {
          brk = 0.03125;
          thr = mul(thr, K0_6667);
        }
      }
    }

    // ===== 0x6093ed : spin recovery
    if (m.b(O.spinOn) === 1) {
      const ang = m.f(O.spinAng);
      if (ang < K6) {
        const a15 = mul(ang, K1_5);
        const sn = f32(Math.sin(a15));
        if ((m.b(0x10) & 1) !== 0) thr = sub(D_0_9, mul(Math.abs(mul(sn, sn)), D_0_75));
        else {
          const cs2 = Math.cos(a15);
          thr = sub(D_0_9, mul(Math.abs(mul(cs2, cs2)), D_0_75));
        }
      } else thr = 1.0;
      steer = 0;
      brk = 0;
      m.sf(O.ctrlTimer, 0);
      c.timer = 0;
      m.sf(O.spinAng, add(dt, m.f(O.spinAng)));
    }

    // ===== 0x609485 : clamps and the pedals
    if (!(steer <= 1)) steer = 1;
    else if (steer < -1) steer = -1;
    if (!(thr <= 1)) thr = 1;
    else if (thr < 0) thr = 0;
    if (!(brk <= 1)) brk = 1;
    else if (brk < 0) brk = 0;
    env.setPedals(steer, thr, brk);
  }
}
