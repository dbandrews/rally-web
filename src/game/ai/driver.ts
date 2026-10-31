/**
 * src/game/ai/driver.ts — CONTRACT written by the architect (phase 2, docs/PHASE2_AI.md); the BODY of
 * `createAiDriver` is owned by the AI-BRAIN builder, everything that calls it by the AI-RACE builder.
 *
 * `AiDriver` is the original AI controller (RallyCar vtable +0x10 FUN_00607ae0 → FUN_007e0540, research/formats/ai.md
 * §5) behind a small, pure-TypeScript interface: one instance per AI car, `update` once per physics substep, returns
 * the car's Controls. It owns the AiData post selection (§3), the AiTimes behind-schedule cuts (§4), the circle-law
 * target speed, the overtake machine and the low-level drive-to-point controller, and keeps its own state.
 *
 * The body of `createAiDriver` is the ai-brain port (src/game/ai/aicar.ts = FUN_00607280 + FUN_00607ae0, ctrl.ts =
 * FUN_007e0540, proven bit-exact against the executed exe); `placeholder` is false. docs/orig/ai.md has the field map,
 * what the field must pass in and what comes back.
 */
import { parkedControls } from '../../core/constants';
import type { AiOpponentSpec } from '../../core/field';
import { qAxesTo } from '../../core/math';
import type { CarTelemetry, Controls, Stage, WorldQuery } from '../../core/types';
import { AiCar, type AiEnv, type AiPeer, type AiPost, type V3 } from './aicar';
import type { AiSampleTable } from './aidata';

/** One AiData speed post (ai.md §3): effective from `lapDist` (spline distance, m) on. Units as in AiData.con
 *  (recSpeed m/s). Produced by src/game/ai/aidata.ts from the `ai` asset part. */
export interface AiDataPost {
  lapDist: number;
  recSpeed: number;
  curveSpdScale: number;
  curveCut: number;
  lookAheadDist: number;
  thresholdScale: number;
}

/** A stage's AI data (stages/<id>/ai.json, the `ai` asset part built by tools/assets/parts/ai.py). */
export interface AiStageData {
  stageId: string;
  /** Posts sorted by lapDist. */
  posts: readonly AiDataPost[];
}

/** AiTimes target schedule of one (track, car): cumulative split times at the checkpoint distances (ai.md §4). */
export interface AiTimesSchedule {
  laps: number;
  /** Cumulative split times (s) of the whole race, last = total. */
  splits: readonly number[];
  /** The spline distance (m, one lap) of each split's checkpoint. */
  distances?: readonly number[];
}

export interface AiDriverInit {
  spec: AiOpponentSpec;
  stage: Stage;
  world: WorldQuery;
  /** The stage's AiData posts (null = the object's defaults: recSpeed 10, curve 1, cut 0.25, look-ahead 6, 1). */
  data: AiStageData | null;
  /** The AiTimes schedule for this track + car (null = none: no behind-schedule cuts). */
  schedule: AiTimesSchedule | null;
}

/** Another car on the road as the overtake machine sees it (ai.md §5.3). Positions THREE space. */
export interface AiOtherCar {
  id: string;
  isPlayer: boolean;
  pos: { x: number; y: number; z: number };
  speedKmh: number;
  /** Spline distance (m, lap-wrapped) and lateral offset (m, + right) of that car. */
  s: number;
  lateral: number;
  /** Half the car's width, m. NOT the exe's other+0x9c (that is 3*cross(heading, tangent), a yaw-error measure the
   *  overtake margins use, docs/orig/ai.md section 4): the ported driver ignores this field and derives the other
   *  car's heading from successive positions. Kept for the Autopilot stand-in and the field's own use. */
  halfWidth: number;
}

export interface AiDriverInput {
  dt: number;
  /** The AI car's latest telemetry (after its last step). */
  self: Readonly<CarTelemetry>;
  /** Its spline distance (m; lap-wrapped on closed stages), lateral offset (m, + right) and race distance (m from
   *  the start line, continuous over laps: the field's `dist`; the ported driver adds `stage.startS`). */
  s: number;
  lateral: number;
  lapDist: number;
  others: readonly AiOtherCar[];
  /** Race clock seconds (0 before GO) and whether the race is running; the AiTimes schedule is read at this time. */
  raceTime: number;
  running: boolean;
}

/**
 * Extension input of the ported driver (ai-brain): the human leader's race progress in the same unit as `lapDist` (metres
 * from the start line, continuous over laps; the field's `dist`). When given, the mailbox of FUN_00607280 (flag 1: the AI car compares its own progress with
 * the stored one of the flag-0 car, docs/orig/ai.md §5) is fed from it; otherwise from the AiTimes schedule at `raceTime`.
 */
export interface AiDriverInputX extends AiDriverInput {
  leaderLapDist?: number;
}

export interface AiDriver {
  /** True for the architect's Autopilot stand-in; false for the ported original controller. */
  readonly placeholder: boolean;
  /** Back to the initial state (new race, after a reset: ai.md §2 vtable +0x14). */
  reset(): void;
  /** Controls for the next physics substep. Must return parked controls while !running. */
  update(input: AiDriverInput): Controls;
  /** Free-form state for tests and FieldCarSnapshot.ai (controller state, target speed km/h, active post, …). */
  debug(): Record<string, number | string | boolean>;
}

/** Optional extras of the ported driver (the contract interface stays as is). */
export interface AiDriverX extends AiDriver {
  /** The race code's spin-recovery trigger (RallyCar vtable +0x70 sets +0x54, +0x58 = the angle accumulator, docs/orig/ai.md §6). */
  setRecovery(on: boolean): void;
  /** The ported car object (tests / tools). */
  readonly car: AiCar;
  /** Tests / trace replay: overwrite the pedals the controller integrates from (the ctl's current steer / throttle / brake). */
  syncPedals(steer: number, throttle: number, brake: number): void;
}

const f32 = Math.fround;
const KMH = f32(3.5999999046325684);
const STEP_FALLBACK = 5;

/** One other car as the overtake machine reads it: the AiPeer fields derived from an AiOtherCar. */
class PeerState implements AiPeer {
  lapDist = 0;
  lat = 0;
  recSpeed = 10;
  w84 = 0;
  w88 = 0;
  w94 = 0;
  w98 = 0;
  yawErr = 0;
  speed = 0;
  // heading from successive positions (the exe reads the other car's own heading axis)
  lastX = 0;
  lastZ = 0;
  hx = 0;
  hz = 1;
  seen = false;
}

/** Posts -> per-sample table when the ai part has no `samples` (an old build): clearance from the road width. */
function fallbackSamples(init: AiDriverInit): AiSampleTable {
  const posts = init.data?.posts ?? [];
  const L = init.stage.length;
  const n = Math.max(2, Math.floor(L / STEP_FALLBACK) + 1);
  const dist = new Float32Array(n);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const post = new Int16Array(n);
  let idx = 0;
  let chosen = -1;
  for (let i = 0; i < n; i++) {
    const d = i * STEP_FALLBACK;
    dist[i] = d;
    const w = init.stage.roadAt(Math.min(d, L)).width * 0.5;
    left[i] = w;
    right[i] = w;
    for (let p = idx; p < posts.length; p++) {
      if (d >= posts[p].lapDist) {
        chosen = p;
        idx = p + 1;
        break;
      }
    }
    post[i] = chosen;
  }
  return { n, step: STEP_FALLBACK, dist, left, right, post };
}

/** The AiTimes schedule as a piecewise-linear race-clock -> distance-travelled function (knots at the split times). */
function buildSchedule(init: AiDriverInit): { t: Float64Array; d: Float64Array } | null {
  const sc = init.schedule;
  if (!sc || sc.splits.length === 0 || !(sc.laps > 0)) return null;
  const st = init.stage;
  const L = st.length;
  const per = sc.splits.length % sc.laps === 0 ? sc.splits.length / sc.laps : sc.splits.length;
  const laps = per === sc.splits.length ? 1 : sc.laps;
  // one lap of checkpoint distances relative to the start line: the timed checkpoints, then the lap end
  let rel: number[];
  if (sc.distances && sc.distances.length === per) rel = Array.from(sc.distances);
  else {
    const cps = [...st.checkpoints, st.finishS];
    rel = cps.map((c) => (st.closed ? ((c - st.startS) % L + L) % L : c - st.startS));
    if (st.closed) rel[rel.length - 1] = L;
    if (rel.length !== per) {
      // a schedule that does not line up with the stage's checkpoints (never in the shipped data): spread evenly
      rel = Array.from({ length: per }, (_, j) => ((j + 1) / per) * (st.closed ? L : st.finishS - st.startS));
    }
  }
  const t = new Float64Array(sc.splits.length + 1);
  const d = new Float64Array(sc.splits.length + 1);
  for (let k = 0; k < laps; k++) {
    for (let j = 0; j < per; j++) {
      const i = k * per + j;
      t[i + 1] = sc.splits[i];
      d[i + 1] = (st.closed ? k * L : 0) + rel[j];
    }
  }
  return { t, d };
}

function scheduleDistance(sch: { t: Float64Array; d: Float64Array }, time: number): number {
  const n = sch.t.length;
  if (time <= 0) return 0;
  if (time >= sch.t[n - 1]) return sch.d[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sch.t[mid] <= time) lo = mid;
    else hi = mid;
  }
  const u = (time - sch.t[lo]) / (sch.t[hi] - sch.t[lo]);
  return sch.d[lo] + (sch.d[hi] - sch.d[lo]) * u;
}

/** The AI driver for one car: the ported RallyCar AI (docs/orig/ai.md). */
export function createAiDriver(init: AiDriverInit): AiDriverX {
  const stage = init.stage;
  const L = f32(stage.length);
  const closed = stage.closed;
  const samples: AiSampleTable = (init.data as { samples?: AiSampleTable | null } | null)?.samples ?? fallbackSamples(init);
  const posts = init.data?.posts ?? [];
  const car = new AiCar();
  const sched = buildSchedule(init);
  const parked = parkedControls();
  const out: Controls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, gearUp: false, gearDown: false };

  // ---- per-update inputs (set before refresh/update, read by the env)
  let tel: Readonly<CarTelemetry> | null = null;
  let curS = 0;
  const fwd: V3 = { x: 0, y: 0, z: 1 };
  const axR: V3 = { x: 1, y: 0, z: 0 };
  const axU: V3 = { x: 0, y: 1, z: 0 };
  const pos: V3 = { x: 0, y: 0, z: 0 };
  const pedals = { steer: 0, thr: 0, brk: 0 };
  let mailD = -1;
  let mailL = 0;
  let ahead: PeerState | null = null;
  let behind: PeerState | null = null;
  const peers = new Map<string, PeerState>();
  const post: AiPost = { rec: 0, curveSpd: 0, curveCut: 0, lookAhead: 0, thresh: 0, left: 0, right: 0 };
  const pt: V3 = { x: 0, y: 0, z: 0 };

  const sampleIndex = (d: number): number => {
    let i = Math.floor(d / samples.step);
    if (i < 0) i = 0;
    else if (i > samples.n - 1) i = samples.n - 1;
    while (i + 1 < samples.n && samples.dist[i + 1] <= d) i++;
    while (i > 0 && samples.dist[i] > d) i--;
    return i;
  };
  /** The spline manager's post record at a distance (vt+0x54). */
  const postAtDist = (d: number): AiPost => {
    const i = sampleIndex(d);
    const pi = samples.post[i];
    const p = pi >= 0 ? posts[pi] : null;
    post.rec = p ? p.recSpeed : 0;
    // No post yet (-1; none of the 48 shipped stages has one): the object's initial curve-speed scale 1.0 (aicar.ts ctor) instead
    // of 0, because a zero is skipped by the `> 0` guard in refresh and the in-place rubber-band cuts would then compound for good [I]
    post.curveSpd = p ? p.curveSpdScale : 1;
    post.curveCut = p ? p.curveCut : 0;
    post.lookAhead = p ? p.lookAheadDist : 0;
    post.thresh = p ? p.thresholdScale : 0;
    post.left = samples.left[i];
    post.right = samples.right[i];
    return post;
  };
  /** Sim-space point on the centre line (the stage is THREE space: z mirrored). */
  const pointSim = (d: number): V3 => {
    const p = stage.pointAt(d);
    pt.x = p.x;
    pt.y = p.y;
    pt.z = -p.z;
    return pt;
  };

  const env: AiEnv = {
    getSteer: () => pedals.steer,
    getThrottle: () => pedals.thr,
    getBrake: () => pedals.brk,
    setPedals: (s, t, b) => {
      pedals.steer = s;
      pedals.thr = t;
      pedals.brk = b;
    },
    setHandbrake: () => {},
    speedKmh: () => tel!.speedKmh,
    speedSigned: () => tel!.velLocal.z,
    bodyPos: () => pos,
    bodyFwd: () => fwd,
    setOutByte: () => {},
    nearest: () => curS,
    segLength: () => L,
    advance: (dist, d) => {
      let n = f32(dist + d);
      if (closed) {
        while (n >= L) n = f32(n - L);
        while (n < 0) n = f32(n + L);
      } else n = n < 0 ? 0 : n > L ? L : n;
      return n;
    },
    pointAt: (d) => pointSim(d),
    postAt: (d) => postAtDist(d),
    carAhead: () => ahead,
    carBehind: () => behind,
    mailStore: () => {},
    mailDist: () => mailD,
    mailLaps: () => mailL,
  };

  const initCar = (): void => {
    car.sb(0x17, 1); // the AI mode (RallyCar +0x17, FUN_00488590 @ 0x488aac)
    car.sf(0x38, init.spec.tyreScale);
    car.sf(0x50, init.spec.skill);
    car.si(0x18c, 0);
    car.si(0x1ac, 1);
    car.sf(0x1c, L);
  };
  initCar();

  /** Fill a PeerState from an AiOtherCar the way the exe's own refresh would have filled the other RallyCar. */
  function fillPeer(pr: PeerState, o: AiOtherCar): void {
    pr.lapDist = f32(o.s);
    pr.lat = f32(o.lateral);
    pr.speed = f32(o.speedKmh / 3.6);
    // heading from the position step (the other car's body forward axis, horizontal)
    const px = o.pos.x;
    const pz = -o.pos.z; // THREE -> sim
    if (pr.seen) {
      const dx = px - pr.lastX;
      const dz = pz - pr.lastZ;
      const n = Math.hypot(dx, dz);
      if (n > 1e-4) {
        pr.hx = dx / n;
        pr.hz = dz / n;
      }
    } else {
      const t = stage.tangentAt(o.s);
      const n = Math.hypot(t.x, t.z) || 1;
      pr.hx = t.x / n;
      pr.hz = -t.z / n;
      pr.seen = true;
    }
    pr.lastX = px;
    pr.lastZ = pz;
    const p = postAtDist(o.s);
    pr.w84 = p.left;
    pr.w88 = p.right;
    pr.w94 = f32(p.left + pr.lat);
    pr.w98 = f32(p.right - pr.lat);
    const lat = pr.lat;
    let rec: number;
    if (o.isPlayer) rec = p.rec > 0 ? p.rec : 10; // mode 0: the AiData value unconverted (FUN_00607280 @ 0x607952)
    else {
      rec = f32(p.rec * KMH);
      if (rec < 10) rec = 250;
      if (!(Math.abs(lat) <= 10)) rec = 40;
    }
    if (Math.abs(lat) > 10 && rec > 40) rec = 40;
    pr.recSpeed = rec;
    const t = stage.tangentAt(o.s);
    const tn = Math.hypot(t.x, t.z) || 1;
    const tx = t.x / tn;
    const tz = -t.z / tn;
    pr.yawErr = f32(3 * f32(pr.hz * tx - tz * pr.hx));
  }

  function selectNeighbours(selfS: number, others: readonly AiOtherCar[]): void {
    ahead = null;
    behind = null;
    if (others.length === 0) return;
    // the segment's sorted car list: the next car after me (null at the end -> the first car), the previous (-> the last)
    let nextS = Infinity;
    let prevS = -Infinity;
    let nextI = -1;
    let prevI = -1;
    let minS = Infinity;
    let minI = -1;
    let maxS = -Infinity;
    let maxI = -1;
    for (let i = 0; i < others.length; i++) {
      const s = others[i].s;
      if (s > selfS && s < nextS) {
        nextS = s;
        nextI = i;
      }
      if (s < selfS && s > prevS) {
        prevS = s;
        prevI = i;
      }
      if (s < minS) {
        minS = s;
        minI = i;
      }
      if (s > maxS) {
        maxS = s;
        maxI = i;
      }
    }
    const aI = nextI >= 0 ? nextI : minI;
    const bI = prevI >= 0 ? prevI : maxI;
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      let pr = peers.get(o.id);
      if (!pr) {
        pr = new PeerState();
        peers.set(o.id, pr);
      }
      if (i === aI || i === bI) fillPeer(pr, o);
      if (i === aI) ahead = pr;
      if (i === bI) behind = pr;
    }
  }

  const driver: AiDriverX = {
    placeholder: false,
    car,
    reset() {
      car.reset(null);
      initCar();
      pedals.steer = pedals.thr = pedals.brk = 0;
      peers.clear();
      mailD = -1;
    },
    syncPedals(steer: number, throttle: number, brake: number) {
      pedals.steer = steer;
      pedals.thr = throttle;
      pedals.brk = brake;
    },
    setRecovery(on: boolean) {
      car.sb(0x54, on ? 1 : 0);
      car.sf(0x58, 0);
    },
    update(inp) {
      if (!inp.running) {
        pedals.steer = pedals.thr = pedals.brk = 0;
        return parked;
      }
      tel = inp.self;
      curS = inp.s;
      // body pose (sim space)
      pos.x = tel.posSim.x;
      pos.y = tel.posSim.y;
      pos.z = tel.posSim.z;
      qAxesTo(tel.quatSim, axR, axU, fwd);
      // race progress of this car and of the AiTimes schedule (the 0x8e5a84 mailbox, FUN_00607280 @ 0x6079c9)
      const mine = stage.startS + inp.lapDist; // absolute spline distance, continuous over laps (lapDist counts from the start line)
      if (closed) {
        const laps = Math.floor(mine / L);
        car.si(0x20, laps);
        car.sf(0x24, mine - laps * L);
      } else {
        car.si(0x20, 0);
        car.sf(0x24, mine);
      }
      // The rubber band multiplies curveSpd in place (aicar.ts refresh), and only a post carrying a curve-speed scale resets it:
      // without AiData posts (assets not built) the human's progress must not feed the mailbox or the cuts would compound.
      const lead = posts.length > 0 ? (inp as AiDriverInputX).leaderLapDist : undefined;
      if (lead !== undefined || sched) {
        const abs = stage.startS + (lead !== undefined ? lead : scheduleDistance(sched!, inp.raceTime));
        if (closed) {
          const laps = Math.floor(abs / L);
          mailL = laps;
          mailD = abs - laps * L;
        } else {
          mailL = 0;
          mailD = abs;
        }
      } else mailD = -1;
      selectNeighbours(inp.s, inp.others);
      car.refresh(env, 1);
      car.update(env, inp.dt);
      out.steer = pedals.steer;
      out.throttle = pedals.thr;
      out.brake = pedals.brk;
      return out;
    },
    debug() {
      const st = car.i(0x2c);
      return {
        placeholder: false,
        mailDist: mailD,
        mailLaps: mailL,
        targetKmh: car.lastTargetKmh,
        circleKmh: car.lastCircleKmh,
        state: st,
        ctrlState: car.ctrl.state,
        ctrlSub: car.ctrl.sub,
        recKmh: car.f(0x5c),
        curveSpd: car.f(0x60),
        lat: car.f(0x7c),
        lapDist: car.f(0x74),
        headFlag: car.b(0x34) === 1,
        target: car.target !== null,
        steer: pedals.steer,
        throttle: pedals.thr,
        brake: pedals.brk,
      };
    },
  };
  return driver;
}

// the contract names kept for callers that import them from here
export type { AiPeer };
