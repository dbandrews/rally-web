/**
 * src/game/autopilot.ts — OWNED BY THE GAME BUILDER.
 *
 * Drives the player car along the stage centre line. Used by ?autopilot=1, by tools/drive.mjs --autopilot
 * and by playtest agents / tests to verify a stage end to end. Writes physics Controls directly (bypasses
 * the input filter, like the §7 bots).
 *
 *  - Steering: pure pursuit on stage.pointAt(s + lookahead) in the car frame (lookahead grows with speed),
 *    plus yaw-rate damping toward the pursuit arc's yaw rate (catches slides: countersteers when the car
 *    rotates faster than the path).
 *  - Speed: a per-stage speed profile from centre-line curvature × road-surface grip with a braking pass
 *    (driving.ts SpeedProfile), scaled by `aggression`; slower when far off the road or sliding hard.
 *  - Recovery: when stuck (no progress under throttle) or facing the wrong way at low speed it reverses
 *    for a moment with opposite lock (auto box: hold brake → reverse; manual: shift to R), then carries on.
 *  - Manual gearbox: shifts up near the limiter and down at low rpm.
 *  - Obstacles (optional `world`, the stage's WorldQuery): colliding objects standing in the path ahead
 *    (the original stages' Objects.con proxies, chain links included: the rally AI splines were never driven by a
 *    physical AI car — the opponents are split-time tables — and hillclimb 1C's runs through its service park,
 *    a truck and a tent on the road 20 m before the finish) are planned around: the scan (out to the stopping
 *    distance; objects over the road such as walkways are skipped by the sim's height test) groups the blocking
 *    objects into clusters, picks a free lateral line through each one (centre first, then near the previous line,
 *    wide gaps before narrow ones), interpolates the pursuit target's offset between them (holding a line until
 *    the car is through its cluster, with a shorter lookahead and a bounded over-aim there), and caps the target
 *    speed so that each lateral move (a lane change of Δ over L metres at a bounded lateral acceleration) and each
 *    narrow gap can be made, braking down to it in time.
 *
 * REQUIRED EXPORTS (contract in src/core/types.ts IAutopilot):
 *   class Autopilot implements IAutopilot
 *     constructor()
 *     aggression: number                       // 0.3..1.2 target-speed scale
 *     reset(): void
 *     update(dt, tel, stage, race): Controls   // once per substep
 */
import { neutralControls } from '../core/constants';
import { clamp } from '../core/math';
import type { CarTelemetry, Controls, IAutopilot, Obstacle, RaceState, Stage, WorldQuery } from '../core/types';
import { obstacleAtCarHeight, pursuitAngle, SpeedProfile, steerInputFor } from './driving';
import { forwardOfThree, rightOfQuat } from './stageMath';

type Mode = 'drive' | 'reverse';

export interface AutopilotDebug {
  mode: Mode;
  targetSpeed: number;
  lookahead: number;
  alpha: number;
  /** Lateral offset (m, + right) the obstacle plan wants at the pursuit target; obstacle clusters planned ahead. */
  avoidLateral: number;
  avoidClusters: number;
}

/** One group of blocking obstacles ahead, in distances from the plan's stage position. */
interface AvoidCluster {
  /** Distance range (m) its obstacles cover, footprints included. */
  d0: number;
  d1: number;
  /** Lateral line (m, + right of travel) through it. */
  x: number;
  /** The offsets of the cluster's free interval the line may use (edges inset by up to 0.3 m); lo > hi = blocked. */
  lo: number;
  hi: number;
  /** Its blocking slices: distance (m), footprint half length (m) and free intervals (m, + right). */
  slices: { d: number; ext: number; free: Gap[] }[];
}

/** A target-speed cap (m/s) over a distance range (m) of the plan. */
interface AvoidCap {
  d0: number;
  d1: number;
  v: number;
}

/** Slices whose blocking obstacles are closer than this (m) form one cluster (while one line fits through them). */
const CLUSTER_GAP_M = 9;
/** Planning deceleration (m/s²) to reach a cluster's speed cap, and lateral acceleration for the line change. */
const AVOID_DECEL = 4.5;
const AVOID_LAT_ACC = 4;
/** A gap narrower than this (m of free centre line positions) is driven through at a capped speed. */
const NARROW_GAP_M = 2.5;
/** A line leaned toward the next cluster keeps this far (m) inside its own free interval. */
const LEAN_MARGIN_M = 0.7;
/** Near a cluster the target over-aims by this share of the lateral error (bounded): pure pursuit cuts bends and
 *  settles short of an offset line. */
const OVERAIM = 0.8;
const OVERAIM_MAX_M = 1;
/** Near a cluster the pursuit lookahead is at most NEAR_LOOK_M + speed · NEAR_LOOK_S (m; s). */
const NEAR_LOOK_M = 6;
const NEAR_LOOK_S = 0.35;
/** Distance (m) over which the offset returns to the centre line after the last cluster. */
const AVOID_RELEASE_M = 25;

/** A lateral interval (m, + right of travel). */
type Gap = [number, number];

/** The blocked intervals around a set of free ones (sorted, disjoint), bounded by ±1e6. */
function complement(free: Gap[]): Gap[] {
  const out: Gap[] = [];
  let lo = -1e6;
  for (const [a, b] of free) {
    out.push([lo, a]);
    lo = b;
  }
  out.push([lo, 1e6]);
  return out;
}

/** The free intervals between blocked intervals (blocks may overlap; the caller bounds the line with blocks). */
function freeGaps(blocks: Gap[]): Gap[] {
  const sorted = [...blocks].sort((a, b) => a[0] - b[0]);
  const out: Gap[] = [];
  let lo = -Infinity;
  for (const [a, b] of sorted) {
    if (a > lo && Number.isFinite(lo) && a - lo > 0.02) out.push([lo, a]);
    lo = Math.max(lo, b);
  }
  return out;
}

export class Autopilot implements IAutopilot {
  /** 0.3..1.2 target-speed scale (1 = brisk but safe). */
  aggression = 1;
  /** Car wheelbase used by the pursuit geometry (m). */
  wheelbase = 2.5;
  readonly debug: AutopilotDebug = { mode: 'drive', targetSpeed: 0, lookahead: 0, alpha: 0, avoidLateral: 0, avoidClusters: 0 };
  /** The stage's WorldQuery (optional): obstacle avoidance. Null = follow the centre line. */
  world: WorldQuery | null = null;

  private readonly c: Controls = neutralControls();
  private profile: SpeedProfile | null = null;
  private profileStage: Stage | null = null;
  private profileAggr = -1;
  private mode: Mode = 'drive';
  private modeT = 0;
  private stuckT = 0;
  private wrongT = 0;
  private shiftCooldown = 0;
  private lastResetCount = -1;
  private lastS = 0;
  private noProgressT = 0;
  private readonly f = { x: 0, y: 0, z: -1 };
  private readonly r = { x: 1, y: 0, z: 0 };
  /** Lateral offset of the pursuit target (m, + right), the obstacle plan and its scan timer / stage position. */
  private latT = 0;
  private latWant = 0;
  private scanT = 0;
  private plan: AvoidCluster[] = [];
  private caps: AvoidCap[] = [];
  private planS = 0;
  private readonly obs: Obstacle[] = [];

  reset(): void {
    Object.assign(this.c, neutralControls());
    this.mode = 'drive';
    this.modeT = this.stuckT = this.wrongT = this.noProgressT = this.shiftCooldown = 0;
    this.lastResetCount = -1;
    this.latT = this.latWant = this.scanT = 0;
    this.plan = [];
    this.caps = [];
  }

  update(dt: number, tel: Readonly<CarTelemetry>, stage: Stage, race: Readonly<RaceState>): Controls {
    const c = this.c;
    c.gearUp = c.gearDown = false;
    c.handbrake = 0;
    this.ensureProfile(stage);

    if (tel.resetCount !== this.lastResetCount) {
      this.lastResetCount = tel.resetCount;
      this.mode = 'drive';
      this.modeT = this.stuckT = this.wrongT = this.noProgressT = 0;
      this.lastS = race.s;
      this.plan = [];
      this.caps = [];
      this.scanT = 0;
    }
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    this.modeT += dt;

    const vf = tel.velLocal ? tel.velLocal.z : tel.speedKmh / 3.6; // signed forward speed m/s
    const speed = Math.abs(vf);
    const kmh = speed * 3.6;

    // ---- geometry: target on the centre line (shifted round obstacles), in the car frame
    let look = clamp(5 + speed * 0.62, 6, 34);
    let moved = 0;
    let near = false;
    if (this.world) {
      this.scanT -= dt;
      if (this.scanT <= 0) {
        this.scanT = 0.1;
        this.planAvoidance(stage, race.s, speed, race.lateral);
      }
      moved = this.travelled(stage, this.planS, race.s);
      // close to a cluster the line must be held, not cut: a shorter lookahead tracks it tighter
      near = this.plan.some((k) => k.d1 + 1 >= moved && k.d0 - moved < 25);
      if (near) look = Math.min(look, NEAR_LOOK_M + speed * NEAR_LOOK_S);
    }
    const sT = this.aheadS(stage, race.s, look);
    let target = stage.pointAt(sT);
    if (this.world) {
      this.latWant = this.targetLateral(moved, look);
      this.debug.avoidLateral = this.latWant;
      this.debug.avoidClusters = this.plan.length;
      this.latT += clamp(this.latWant - this.latT, -6 * dt, 6 * dt);
      const aim = near ? this.latT + clamp((this.latT - race.lateral) * OVERAIM, -OVERAIM_MAX_M, OVERAIM_MAX_M) : this.latT;
      if (Math.abs(aim) > 1e-3) {
        const t = stage.tangentAt(sT);
        const tl = Math.hypot(t.x, t.z) || 1;
        target = { x: target.x - (t.z / tl) * aim, y: target.y, z: target.z + (t.x / tl) * aim };
      }
    }
    const f = forwardOfThree(tel.quat, this.f);
    const r = rightOfQuat(tel.quat, this.r);
    const dx = target.x - tel.pos.x;
    const dz = target.z - tel.pos.z;
    const lx = dx * r.x + dz * r.z;
    const lz = dx * f.x + dz * f.z;
    const alpha = Math.atan2(lx, lz); // + = target to the right
    this.debug.alpha = alpha;
    this.debug.lookahead = look;

    // ---- recovery state machine
    const throttleWanted = this.mode === 'drive' && c.throttle > 0.3;
    this.stuckT = throttleWanted && speed < 1.2 ? this.stuckT + dt : 0;
    this.wrongT = Math.abs(alpha) > 1.9 && speed < 6 ? this.wrongT + dt : 0;
    // progress watchdog: moving but not advancing along the stage (e.g. pushing along a wall)
    const ds = stage.closed ? 0 : race.s - this.lastS;
    this.noProgressT = this.mode === 'drive' && !stage.closed && ds < 0.4 * dt && kmh < 12 ? this.noProgressT + dt : 0;
    this.lastS = race.s;
    if (this.mode === 'drive' && (this.stuckT > 1.2 || this.wrongT > 1.0 || this.noProgressT > 3)) {
      this.mode = 'reverse';
      this.modeT = 0;
    } else if (this.mode === 'reverse' && (this.modeT > 2.2 || (this.modeT > 0.9 && Math.abs(alpha) < 0.5))) {
      this.mode = 'drive';
      this.modeT = 0;
      this.stuckT = this.wrongT = this.noProgressT = 0;
    }
    this.debug.mode = this.mode;

    const manual = tel.transmission === 'manual';
    if (this.mode === 'reverse') {
      this.reverse(tel, alpha, speed, manual);
      return c;
    }

    // ---- steering: pure pursuit + yaw damping
    const angle = pursuitAngle(lx, lz, this.wheelbase);
    const ld2 = Math.max(1, lx * lx + lz * lz);
    const kPath = (2 * lx) / ld2;
    const yawDes = vf * kPath; // rad/s, + = right
    let steer = steerInputFor(angle, kmh);
    steer += clamp((yawDes - tel.yawRate) * 0.18, -0.5, 0.5);
    c.steer = clamp(steer, -1, 1);

    // ---- speed
    const prof = this.profile!;
    const aheadS = this.aheadS(stage, race.s, speed * 0.35);
    let vT = prof.at(aheadS);
    const roadHalf = this.roadHalfWidth(stage, race.s);
    const off = Math.abs(race.lateral) - roadHalf;
    if (off > 2) vT = Math.min(vT, Math.max(8, 22 - off));
    if (Math.abs(alpha) > 0.6) vT = Math.min(vT, 12);
    const beta = Math.abs(tel.beta ?? 0);
    if (beta > 0.45) vT = Math.min(vT, speed * 0.97);
    if (this.caps.length) vT = Math.min(vT, this.planSpeed(moved));
    this.debug.targetSpeed = vT;
    const err = vT - speed;
    if (vf < -0.5 && !manual) {
      // rolling backwards in a forward gear (or still in R): throttle exits R in the auto box
      c.throttle = 0.6;
      c.brake = 0;
    } else if (err > 0) {
      c.throttle = clamp(0.45 + 0.12 * err, 0, 1);
      if (beta > 0.35) c.throttle = Math.min(c.throttle, 0.55);
      c.brake = 0;
    } else if (err > -1.5) {
      c.throttle = clamp(0.35 + 0.2 * err, 0, 0.35);
      c.brake = 0;
    } else {
      c.throttle = 0;
      // never > 0.3 brake near standstill (auto box would select reverse)
      c.brake = speed < 3 ? 0.2 : clamp(-err * 0.14, 0.2, 1);
    }

    // ---- manual gearbox
    if (manual && !tel.shifting && this.shiftCooldown <= 0) {
      if (tel.gear === 0) this.shift(true);
      else if (tel.rpm > 7600 && tel.gear < tel.nGears) this.shift(true);
      else if (tel.rpm < 3600 && tel.gear > 1) this.shift(false);
    }
    return c;
  }

  // ------------------------------------------------------------------------------------------- helpers

  private reverse(tel: Readonly<CarTelemetry>, alpha: number, speed: number, manual: boolean): void {
    const c = this.c;
    // reversing: opposite lock swings the nose toward the target
    c.steer = alpha > 0 ? -1 : 1;
    if (manual) {
      if (tel.gear !== 0) {
        c.throttle = 0;
        c.brake = speed > 1 ? 0.8 : 0;
        if (speed < 5 && !tel.shifting && this.shiftCooldown <= 0) this.shift(false);
      } else {
        c.throttle = 0.6;
        c.brake = 0;
      }
    } else {
      // auto box: brake held below 5 km/h selects R; in R the brake pedal drives (§2.2)
      c.throttle = 0;
      c.brake = 0.75;
    }
  }

  private shift(up: boolean): void {
    if (up) this.c.gearUp = true;
    else this.c.gearDown = true;
    this.shiftCooldown = 0.45;
  }

  /**
   * The obstacle plan from stage position `s` (car lateral `lat`): every 3 m slice of the centre line out to the
   * stopping distance (open stages: to 10 m past the finish) collects the colliding obstacles whose centre lies in
   * it and whose height span a car on the road can touch (obstacleAtCarHeight); an obstacle within the road blocks
   * the lateral offsets [its offset ± (radius + 1.3 m)] (car half width + margin). Slices with blocks closer than
   * CLUSTER_GAP_M form clusters while one line still fits through all of them; each cluster gets a line through
   * its free interval (every slice bounded by its road plus 2 m): the centre when free, else the offset nearest the
   * previous line (the car's lateral for the first), a narrow gap only when no wide one exists. A backward pass
   * then moves every line toward the next one inside its interval (so the car already leans toward the next gap),
   * and every blocking slice gets its speed caps (the lateral move into it, a narrow gap there).
   */
  private planAvoidance(stage: Stage, s: number, speed: number, lat: number): void {
    const world = this.world;
    this.plan = [];
    this.caps = [];
    this.planS = s;
    if (!world) return;
    const reach = clamp(12 + speed * 2.2 + (speed * speed) / (2 * AVOID_DECEL), 60, 150);
    const slices: { d: number; ext: number; hw: number; blocks: Gap[] }[] = [];
    for (let d = 3; d <= reach; d += 3) {
      // open stages: nothing past the finish matters (the run-out takes over there, main.ts runOutControls)
      if (!stage.closed && (s + d > stage.length || s + d > stage.finishS + 10)) break;
      const sd = this.aheadS(stage, s, d);
      const p = stage.pointAt(sd);
      const t = stage.tangentAt(sd);
      const tl = Math.hypot(t.x, t.z) || 1;
      const tx = t.x / tl;
      const tz = t.z / tl;
      const hw = this.roadHalfWidth(stage, sd);
      world.obstaclesNear({ x: p.x, y: p.y, z: -p.z }, hw + 4, this.obs);
      let blocks: Gap[] | null = null;
      let ext = 0;
      for (const o of this.obs) {
        const ox = o.pos.x - p.x;
        const oz = -o.pos.z - p.z; // sim → three
        if (Math.abs(ox * tx + oz * tz) > 1.6) continue; // this 3 m slice only
        if (!obstacleAtCarHeight(o, p.y)) continue; // walkways and gantries over the road are not walls
        const ol = ox * -tz + oz * tx; // right of travel = (-tz, tx)
        const m = o.radius + 1.3;
        if (Math.abs(ol) - m >= hw) continue; // off the road
        (blocks ??= []).push([ol - m, ol + m]);
        ext = Math.max(ext, o.radius);
      }
      if (blocks) slices.push({ d, ext: Math.max(1.6, ext), hw, blocks });
    }
    // clusters: consecutive slices closer than CLUSTER_GAP_M while ONE line still fits through all of them (a slice
    // that closes every common gap starts the next cluster: a finish gate, then a barrier ring behind it)
    const sliceBlocks = (sl: (typeof slices)[number]): Gap[] => [...sl.blocks, [-1e6, -(sl.hw + 2)], [sl.hw + 2, 1e6]];
    const groups: (typeof slices)[] = [];
    let common: Gap[] = [];
    for (const sl of slices) {
      const g = groups[groups.length - 1];
      const own = sliceBlocks(sl);
      const joint = g && sl.d - g[g.length - 1].d <= CLUSTER_GAP_M ? freeGaps([...own, ...complement(common)]) : [];
      if (joint.length) {
        g.push(sl);
        common = joint;
      } else {
        groups.push([sl]);
        common = freeGaps(own);
      }
    }
    // free intervals and a line per cluster (forward: centre first, else near the previous line); every slice is
    // bounded by its own road plus 2 m
    let prev = lat;
    for (const g of groups) {
      const open = freeGaps(g.flatMap(sliceBlocks));
      let x = prev; // no way through: crawl into it (the reverse recovery takes over when stuck)
      let iv: Gap | null = open.find(([a, b]) => a + 0.3 <= 0 && b - 0.3 >= 0) ?? null;
      if (iv) x = 0;
      else {
        let bestCost = Infinity;
        for (const [a, b] of open) {
          const inset = Math.min(0.3, (b - a) / 2);
          const cx = clamp(prev, a + inset, b - inset);
          const cost = Math.abs(cx - prev) + 0.5 * Math.abs(cx) + 3 * Math.max(0, 1 - (b - a));
          if (cost < bestCost) {
            bestCost = cost;
            x = cx;
            iv = [a, b];
          }
        }
      }
      const inset = iv ? Math.min(0.3, (iv[1] - iv[0]) / 2) : 0;
      this.plan.push({
        d0: g[0].d - g[0].ext,
        d1: g[g.length - 1].d + g[g.length - 1].ext,
        x,
        lo: iv ? iv[0] + inset : 1,
        hi: iv ? iv[1] - inset : -1,
        slices: g.map((sl) => ({ d: sl.d, ext: sl.ext, free: freeGaps(sliceBlocks(sl)) })),
      });
      prev = x;
    }
    // backward: lean each line toward the next one within its own free interval, keeping LEAN_MARGIN_M from its
    // edges (an edge line leaves no room for the tracking error)
    for (let k = this.plan.length - 2; k >= 0; k--) {
      const c = this.plan[k];
      if (c.lo > c.hi) continue;
      const m = Math.min(LEAN_MARGIN_M, (c.hi - c.lo) / 2);
      c.x = clamp(this.plan[k + 1].x, Math.min(c.x, c.lo + m), Math.max(c.x, c.hi - m));
    }
    // speed caps per blocking slice: the lateral move into the slice's own free interval around the line (from the
    // car's lateral for the first cluster, from the previous line after its cluster for the others; a lane change of
    // Δ over L metres peaks at ≈ 2πΔv²/L² lateral acceleration), and a narrow gap there
    const aggr = clamp(this.aggression, 0.3, 1.2);
    let from = lat;
    let start = 0;
    for (const c of this.plan) {
      for (const sl of c.slices) {
        const d0 = sl.d - sl.ext;
        const d1 = sl.d + sl.ext;
        const own = sl.free.find(([a, b]) => c.x >= a - 1e-6 && c.x <= b + 1e-6);
        if (!own) {
          this.caps.push({ d0, d1, v: 5 }); // no way through: crawl
          continue;
        }
        const w = own[1] - own[0];
        if (w < NARROW_GAP_M) this.caps.push({ d0, d1, v: Math.max(5, (10 + 8 * w) * aggr) });
        const inset = Math.min(0.3, w / 2);
        const dx = Math.max(0, own[0] + inset - from, from - (own[1] - inset));
        if (dx > 0.05) {
          const L = Math.max(3, d0 - start - 2);
          this.caps.push({ d0, d1, v: Math.max(5, L * Math.sqrt((AVOID_LAT_ACC * aggr) / (2 * Math.PI * dx))) });
        }
      }
      from = c.x;
      start = c.d1;
    }
  }

  /** The planned lateral offset at distance d (m) from the plan's position: the line of the cluster d is in,
   *  linear between clusters (from 2 m after one to 2 m before the next), released to 0 after the last one. */
  private planLateral(d: number): number {
    const p = this.plan;
    if (!p.length) return 0;
    if (d <= p[0].d1 + 2) return p[0].x;
    for (let k = 1; k < p.length; k++) {
      const a = p[k - 1];
      const b = p[k];
      if (d <= b.d0 - 2) {
        const t = clamp((d - (a.d1 + 2)) / Math.max(1, b.d0 - 2 - (a.d1 + 2)), 0, 1);
        return a.x + (b.x - a.x) * t;
      }
      if (d <= b.d1 + 2) return b.x;
    }
    const last = p[p.length - 1];
    return last.x * clamp(1 - (d - (last.d1 + 2)) / AVOID_RELEASE_M, 0, 1);
  }

  /**
   * The pursuit target's offset with the car `moved` metres past the plan's position and the target `look` metres
   * ahead of it: the line of a cluster the car is in (until the CAR is through it: the target runs ahead, so the
   * profile at the target alone would leave the line early), else the profile at the target, never beyond the
   * next cluster.
   */
  private targetLateral(moved: number, look: number): number {
    const c = this.plan.find((k) => k.d1 + 1 >= moved);
    if (!c) return this.planLateral(moved + look);
    if (moved >= c.d0 - 2) return c.x;
    return this.planLateral(Math.min(moved + look, c.d1));
  }

  /** Target-speed cap from the plan: every cap ahead, reachable by braking at AVOID_DECEL from here. */
  private planSpeed(moved: number): number {
    let v = Infinity;
    for (const c of this.caps) {
      if (c.d1 < moved) continue; // passed
      const d = Math.max(0, c.d0 - moved - 2);
      v = Math.min(v, Math.sqrt(c.v * c.v + 2 * AVOID_DECEL * d));
    }
    return v;
  }

  /** Stage distance travelled from s0 to s1 (closed stages wrap). */
  private travelled(stage: Stage, s0: number, s1: number): number {
    let d = s1 - s0;
    if (stage.closed) {
      const L = stage.length;
      if (d > L / 2) d -= L;
      if (d < -L / 2) d += L;
    }
    return d;
  }

  private aheadS(stage: Stage, s: number, d: number): number {
    const x = s + d;
    return stage.closed ? ((x % stage.length) + stage.length) % stage.length : Math.min(stage.length, x);
  }

  private roadHalfWidth(stage: Stage, s: number): number {
    try {
      const w = stage.roadAt(s).width;
      return Number.isFinite(w) && w > 0 ? w / 2 : 4;
    } catch {
      return 4;
    }
  }

  private ensureProfile(stage: Stage): void {
    const aggr = clamp(this.aggression, 0.3, 1.2);
    if (this.profile && this.profileStage === stage && this.profileAggr === aggr) return;
    this.profile = new SpeedProfile(stage, { gripScale: 0.8 * aggr, brakeFrac: 0.7, vMax: 55 * Math.min(1, aggr + 0.1) });
    this.profileStage = stage;
    this.profileAggr = aggr;
  }
}
