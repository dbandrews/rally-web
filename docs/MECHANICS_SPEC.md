# rally-web: Driving Mechanics Specification

Status: authoritative v1.5 (independently verified; corrections listed in Appendix C; v1.5 = the original's ground
interface: wheel and hull SEGMENT queries on the original collision mesh, the suspension reads the ray's compression
FRACTION (§2.5.3, the body rides ≈ 2.5 cm higher than v1.4), the chassis hull and body solver FUN_006d0970 ported
literally (§2.9, DEV-4 withdrawn), the post-finish track braking (§2.7), all proven against the executed exe and the
Frida traces on Track.gcm; v1.4 = RUNTIME-verified
against the running original with a Frida trace: one suspension fix (§2.5.2/§2.5.3), everything else matches to float
precision; v1.2 = playtest-review
fixes: defined power-test start states, DEV-9, re-derived §7 bands; v1.3 = drift-fidelity audit: the original's
loose rally stages run on SAND / MUD, not GRAVEL (§4.3), the slide model itself re-verified unchanged, the
drift-hold probe uses a counter-steer P-I-D controller (§7), non-default presets incl. "Arcade drift" (§6.1)).
Owner: physics.
Target: TypeScript + Three.js, fixed-step simulation.

This document specifies the car handling, input, gearbox, camera and reset mechanics for rally-web, an
original browser rally game whose driving must feel accurate to the original mechanics. 

An engineer should be able to implement everything below without reading any other document.

---------------------------------------------------------------------------------------------------

## 0. How to read this document

### 0.1 Confidence tags

Every claim about the original carries a tag:

| Tag | Meaning |
|---|---|
| **[V]** | VERIFIED: read directly in the original's code (decompile and/or disassembly) or shipped config. An address `0x6c7170` or `FUN_006c7170` points at the code (image base 0x400000). |
| **[R]** | RUNTIME-VERIFIED (v1.4): measured in the running original with a Frida trace of every physics step (Appendix C, v1.4) and reproduced by replaying the trace through rally-web's sim. |
| **[I]** | INFERRED: the arithmetic is verified, the meaning or naming is deduced. |
| **[G]** | GUESS: plausible, not confirmed. Where this spec must still choose a behaviour, it says so. |
| **[D]** | DESIGN: our own choice for rally-web (no original behaviour exists or it is not recovered). |
| **[DEV]** | DEVIATION: we deliberately differ from verified original behaviour. Every deviation has a tuning-panel toggle that restores the original. |
| **[M]** | MODEL-DERIVED: a number produced by running §2 as written (reference implementations), not measured in the original. |
| **UNVERIFIED** | An independent check (Appendix C) could neither confirm nor refute the item. The reason is given inline; the value kept is the most defensible one. |

### 0.2 The feel in one paragraph (what makes it feel like the original)

[V] unless noted. One shared chassis and tyre model for every car: per-car character comes only from mass,
engine torque scale, gearing, drive layout (FWD/RWD/AWD) and wheel positions. Grip is very high (static
friction coefficients around 2.4 on tarmac with tarmac tyres, against a 12 m/s² gravity), so cornering and
braking reach 2-3 g on tarmac. Each tyre has a two-state friction machine (grip vs slide, with hysteresis);
while gripping, a strong artificial yaw friction (TWStaMy) holds the car straight; once tyres slide, that yaw
friction disappears and a steering-proportional yaw torque (TWKinSteer) takes over, so the car rotates easily
and can be held sideways. Grip grows with body slip angle while on throttle, a "side fill" force tops lateral
grip up toward the friction limit, and a forward "drift drive" push keeps speed in slides. Yaw torque and yaw
rate are hard-capped, and the caps loosen with body slip angle. Engine torque at the wheel is NOT multiplied
by the gear ratio (gears only move the rpm along a single shared torque curve), with large low-gear launch
bonuses and a turbo that adds up to +75 % torque. Tyre normal loads are a static weight split plus weak,
one-step-lagged load transfer, independent of the springs. In the air, gravity (and the downforce) ramp to
1.45x within 6 steps and the car is damped. Physics runs at a fixed 120 Hz.

### 0.3 Deviations from the original (all togglable)

| Id | Deviation | Reason | Toggle (default) |
|---|---|---|---|
| DEV-1 | The "big slip angle" grip bonus (§2.6, step W10) uses `abs(beta) > 0.75` instead of the original's signed `beta > 0.75`. | Original applies it to right-hand drifts only [V asm 0x6cbb55]; almost certainly a bug. | `assist.bigBetaSymmetric = true` |
| DEV-2 | **Withdrawn in v1.1.** (Was: floor the yaw-torque cap at 0.) | The cap cannot go negative: β uses `atan`, not `atan2` [V fpatan(x, 1) at 0x6cb041], so \|β\| < π/2 and the cap is always ≥ 0.179·TWMaxMom·Iyy (§2.8). A reversing car reads β ≈ 0. | none |
| DEV-3 | TWStaMy yaw-friction sign uses a smooth sign with a 0.05 rad/s band instead of a hard `L_y >= 0 ? -1 : +1`. | The hard sign flips the yaw rate by 4·TWStaMy·μ·dt ≈ 0.033 rad/s every step on tarmac when driving straight (±0.017 rad/s about zero; invisible in heading) [M]. | `assist.smoothYawFrictionSign = false` (OFF by default: keep original; enable only if jitter is visible) |
| DEV-4 | **Withdrawn in v1.5.** (Was: body-to-ground collision by our own impulse model.) | The original's hull probes (FUN_006cea90 tail) and body solver FUN_006d0970 are ported literally and proven (§2.9). | none |
| DEV-5 | Physical damage is off by default (§5.6). | Reviews report damage as cosmetic; original's damage source was not found. | `damage.physical = false` |
| DEV-6 | The sleep rule's pedal test uses `S.thr > throttleMinLimit \|\| S.brk > brakeMinLimit` instead of "any non-zero pedal" (§2.10). | Sleep is the only thing that brings a car to rest, and any non-zero pedal disables it [V]. A tiny pedal value at standstill leaves the car creeping (\|v\| up to 0.26 m/s) [M]. | `assist.sleepPedalThreshold = false` (OFF: original; the [D] analog pedal dead zone in §5.1 normally suffices) |
| DEV-7 | The sleep rule's `hardSpring` threshold becomes `max(4500, 1.25 × static per-wheel spring force)` (§2.10). | With the original's fixed 4500 N, cars heavier than about 1440 kg (shipped springs, awd geometry) never sleep and jitter at standstill [V threshold, M effect]. | `assist.heavyCarSleep = false` (OFF: original) |
| DEV-8 | The W18 side-fill gate becomes a ramp `clamp((\|Vy\| - 0.0625)/0.0625, 0, 1)` instead of a hard on/off at 0.0625 m/s (§2.6). | The hard gate causes a period-2 lateral-force limit cycle between 10 and 45 km/h. It does not change the mean force [M]. | `assist.smoothSideFillGate = false` (OFF: original) |
| DEV-9 | The §1.2 settle suppresses sleep while the body drops onto its springs: sleep is off until the body has been vertically still (\|vW.y\| < 2 mm/s, ≥ 3 wheels) for 10 steps (capped at settleSteps + 240), then the remaining steps (at least 15, at least settleSteps in total) run with sleep. The settle runs synchronously inside reset, so no game time passes. | With the original settle, sleep freezes the body wherever \|v\| first dips under √0.1 m/s while it is still bouncing: 1-4.5 cm off its spring equilibrium (also at the §7.1 spawn), so every launch bobs 16-45 mm, and a teleport hands over a car that is still moving [M]. Sleep-free settling alone would let the low-speed chatter creep (yaw ±0.08 rad/s), which is why sleep returns for the end. | `assist.settleToEquilibrium = true` (ON; false = original settle) |

Not a DEV toggle: the built-in tuning presets of §6.1 (v1.3). "Arcade drift" is a named, clearly labelled
deviation preset that is never active by default; loading it in the tuning panel is the only way to get it.

### 0.4 Source code addresses most used

`FUN_006c6760` physics step entry; `FUN_006c6b00` pre-step; `FUN_006c6b60` inputs/steer; `FUN_006c6c60`
gearbox; `FUN_006c7170` engine, differentials, brakes; `FUN_006c7e70` rpm/turbo; `FUN_006c8050` engine torque;
`FUN_006c81a0` torque curve; `FUN_006c8250` gravity/aero; `FUN_006caab0` main step (suspension, tyres,
assists, integration); `FUN_006cea90` wheel raycasts; `FUN_006cf620` suspension; `FUN_006cf860` surface sink
and bump; `FUN_006cfb50` tyre normal loads; `FUN_006d0300` wheel spin; `FUN_006d0410` combined-slip tyre force;
`FUN_006d07c0`/`FUN_006d0850` lateral/longitudinal curves; `FUN_006d0910` aligning moment; `FUN_0074f0b0`
template-to-runtime copy; `0x752c00` input filter; `FUN_0075f720` chase camera; `FUN_004b3e50` reset.

---------------------------------------------------------------------------------------------------

## 1. Simulation architecture

### 1.1 Units and coordinate conventions

**Units (both original and rally-web):** metres, seconds, kilograms, newtons, radians, rad/s. Speeds shown
to the player are km/h. Engine speed in rpm. Exceptions are listed per parameter in §3 ("SI meaning" column).

**Original frame [V]:** left-handed, Direct3D style. Body frame: **x = right, y = up, z = forward**. World: y up.
Wheel order: **0 = front-left, 1 = front-right, 2 = rear-right, 3 = rear-left** (wheels 0 and 3 share the left
side, 1 and 2 the right side; 0 and 1 are the steered front axle). Positive yaw rate (body ω.y > 0) turns the
nose to the **right**. Positive steering input and positive steer angle mean **turn right** [V: steered axle
construction in FUN_006caab0 and keymap `c_PIYaw ArrowRight ArrowLeft`]. Quaternion integration uses
`q̇ = ½ q ⊗ (0, ω_body)` and the standard rotation matrix [V FUN_006caab0 start].

**rally-web: "sim space" equals the original's frame.** All of §2 is written in the original's frame and must
be implemented verbatim in that frame (same component formulas, same cross product
`cross(a,b) = (a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x)`). This avoids sign-transcription bugs.
Sim space is the Three.js world mirrored in z: a mirror maps the right-handed Three.js world to the
left-handed sim space, and back. The mirror `M = diag(1, 1, -1)` is its own inverse.

| Quantity | Sim space (left-handed) | Three.js (right-handed, Y-up) |
|---|---|---|
| World position | `p = (x, y, z)` | `(x, y, -z)` |
| World direction / velocity / normal | `v` | `(v.x, v.y, -v.z)` |
| Car body axes | right = +x, up = +y, forward = +z | car object local: right = +X, up = +Y, **forward = -Z** |
| Orientation quaternion (w, x, y, z) | `q` | `new THREE.Quaternion(-q.x, -q.y, q.z, q.w)` |
| Angular velocity (body) | `ω` | not needed by rendering |

Notes:
* A car mesh must face **-Z** in its local frame. A glTF asset (faces +Z) goes inside a group rotated by π about Y.
* Terrain queries: convert the sim ray origin and direction with M, query Three.js geometry, convert the hit
  normal back with M. Hit distance is unchanged. The material id comes from the hit face.
* The chase camera (§5.3) is computed in Three.js space from the converted car pose.

### 1.2 Timestep [V]

* Physics runs at a **fixed 120 Hz**: `DT = 1/120 s` [V settings+0x284 = 120 set in FUN_0040e2e0; race+0xfc =
  1/120; accumulator FUN_006c4390; loop FUN_0049ffe0].
* Per rendered frame: `frameDt = min(0.2, performance.now() delta)`; `acc += frameDt * timeScale`;
  `n = floor(acc * 120)`; `acc -= n / 120`; run the car step n times. No other cap on n [V FUN_00404a60
  (0.2 s clamp), FUN_006c4390].
* Inputs are sampled and filtered once per substep (the original steps "drivers" and cars in the same substep
  loop [V FUN_0049ffe0]). The input filter (§5.1) therefore uses `dt = 1/120`.
* Cameras, visual wheel spin and effects update once per rendered frame with the frame dt.
* [D] Render interpolation: keep the previous and current physics pose and draw `lerp/slerp(prev, cur, acc*120)`.
  The original did not interpolate; we do so to avoid judder on 144/165 Hz displays.
* **Do not change DT.** Several terms are per-step, not per-second: turbo spool, the air-gravity ramp, and the
  TWStaMy chatter amplitude (the flip timer is dt-based). The sleep rule (§2.10) needs one step of full
  friction (μ·g·dt) to stay below √0.1 m/s. That holds at 120 Hz (0.24 m/s on tarmac) and fails at 60 Hz.
  [M] spec-literal sim at 60 Hz: 0-100 km/h 18 % slower (turbo), the car never comes to rest with no input,
  and low-speed lateral chatter reaches about 8 g peak-to-peak. Nothing diverges at either rate.
  UNVERIFIED: the original's own behaviour at other rates was not tested; these effects come from running §2 as written.
* Settle: at stage start and after every reset, run **100 physics steps** with all inputs zero and handbrake
  = 1.0 before handing control to the player [V FUN_004b3790 case 2, FUN_004b3e50]. With DEV-9 (default on)
  sleep is held off until the body has stopped bouncing, so the car rests exactly at its spring equilibrium.

### 1.3 Model overview

* **Rigid body** (one per car): mass m, diagonal body inertia `I = car_Inertia ⊙ m` (inertia is given per kg),
  world position, world velocity `vW`, orientation quaternion, **angular momentum L stored in the body frame**,
  no gyroscopic term [V].
* **Four ray-cast wheels**: a ray from the wheel mount straight down the body's -up axis, length SpringLength.
  The spring-damper only supports the body. **Tyre normal loads do not come from the springs**: they are a
  quasi-static weight split plus load transfer from the previous step's tyre forces [V FUN_006cfb50].
* **Each wheel** has its own spin ω (inverse inertia "WheelInertia"), a relaxed slip-angle state, slip ratio,
  and a grip/slide friction mode.
* **Drivetrain**: engine rpm is computed from driven-wheel speed (no clutch slip except while shifting).
  Torque from a single shared normalised curve × TorqueScale, split per wheel by a fixed-bias differential
  with a limited-slip term. **Gear ratio does not multiply wheel torque** [V FUN_006c7170, FUN_006c8050].
* **Arcade assists** (yaw helpers, yaw caps, side fill, drift boost, launch help, air gravity) are part of the
  model, not optional extras. See §2.11 for the list.
* **Hull points** (12 body points) collide with the ground (§2.9).

### 1.4 Runtime state

```ts
type V3 = { x: number; y: number; z: number };
type Quat = { w: number; x: number; y: number; z: number };

interface Body {
  mass: number; invMass: number;
  I: V3; invI: V3;               // diagonal body inertia = p.inertia * mass  [V FUN_006c6810]
  pos: V3;                       // world (sim space), at the centre of mass / body origin
  vW: V3;                        // world velocity
  q: Quat;                       // body -> world
  right: V3; up: V3; fwd: V3;    // world-space body axes (rows of R), rebuilt from q each step
  vL: V3;                        // local velocity = (dot(right,vW), dot(up,vW), dot(fwd,vW))
  L: V3;                         // angular momentum, BODY frame
  w: V3;                         // angular velocity, BODY frame (= invI ⊙ L, refreshed in integration)
  Fext: V3;                      // world: gravity + aero (computed in stepA)
  loadMoment: V3;                // .x and .z used; accumulated in the wheel loop, read next step  [V B+0x74/+0x7c]
  airMul: number;                // gravity multiplier, init 1                                    [V phys+0x84]
  bodyOnGround: boolean;         // any hull point touching (from §2.9)
}

interface Wheel {
  mount: V3;          // body frame: bundle position with y reduced by WheelRadius at init  [V FUN_006c6810]
  otherAxleZ: number; // z of the wheel on the same side, other axle ("WheelBasePos.z")       [V Templates.con]
  front: boolean;     // index < 2
  omega: number;      // rad/s, + = rolling forward
  driveT: number;     // N·m this step
  brakeT: number;     // N·m this step (magnitude)
  brakeCap: number;   // N·m service-brake capacity (§2.3.6)
  load: number;       // SIGNED: -normal load (negative when loaded), from §2.5.5          [V W+0x1c]
  tanA: number;       // relaxed tan(slip angle)                                           [V W+0x20]
  ext: number;        // suspension extension fraction 0..1, 1 = fully drooped/no contact  [V C+4]
  dampV: number;      // damper velocity state                                             [V W+0x38]
  kappa: number;      // slip ratio                                                        [V W+0x3c]
  Fsusp: number;      // N, along the contact normal                                       [V W+0x40]
  mu: number;         // friction coefficient used this step
  contact: boolean; surface: number;  // material id, -1 if no contact
  hitDist: number;    // ray hit distance from mount (m) = t·SL
  c0: number; c4: number; // the ray's depth = dot(end − v0, n) (≤ 0) and cos = dot(n, ray) = −SL·(n·up); miss 0 / 1  [V W+0xc0/+0xc4]
  normalW: V3;        // world contact normal
  contactW: V3;       // world contact point (written at end of the wheel loop)
  steerOffX: number; steerOffZ: number; // kingpin offset of the contact point (front only)
  ny: number;         // local contact-normal y (0 if no contact), for anti-roll
  mode: 1 | 2;        // 1 = GRIP (static mu), 2 = SLIDE (kinetic mu); init 1                [V state+4 nibbles]
}

interface CarState {
  speedKmh: number;          // |vL.z| * 3.6 (forward component only)                    [V CP+8]
  thr: number; brk: number;  // effective pedals after the auto-box reverse swap         [V CP+0x24/+0x28]
  steer: [number, number];   // front steer angles, rad                                  [V CP+0x1c/+0x20]
  gear: number;              // 0 = reverse, 1..nGears; there is no neutral               [V CP+0x2c]
  shiftDir: 0 | 1 | 2;       // 0 idle, 1 up, 2 down                                       [V state+0xc]
  shiftTimer: number;        //                                                           [V state+0x10]
  clutch: boolean;           // "clutch open": set while shifting or parked              [V state flags bit 3]
  rpm: number; boost: number;
  ratio: number[];           // effective gear ratios incl. setup modifiers (§2.3.1)
  shiftSpeed: number[];      // auto upshift speeds km/h (§2.2)
  reverseAllowed: boolean;   // init true                                                 [V CP+0x30]
  thrRamp: number;           // 0..2.25, used by the flip assist                          [V CP+0x38]
  flipTimer: number;         //                                                           [V phys+0xb8]
  nContacts: number;
  parked: boolean;           // pre-start hold; clutch open + all wheels braked           [V phys+0x74]
  steerSensFast: boolean;    // selects StaticSlipAngleFast (true, default) or Slow       [V phys+0x46, ctor 0x6c4655 = 1]
  stepParity: number;        // toggles each step (phys+0x90); the hull probes / body solver use it with carIndex >> 1
}

interface Controls {          // written by the input filter (§5.1) each substep            [V phys+0x60..0x70]
  steer: number;              // -1..1, + = right
  throttle: number; brake: number; handbrake: number;  // 0..1
  gearUp: boolean; gearDown: boolean;                  // edge-triggered, manual box only
}
```

### 1.5 Step order (one call per 1/120 s substep) [V FUN_006c6760]

```
step(dt):
  if dt == 0 or car frozen: return
  A. stepA(dt)                       // FUN_006c6b00
     A1 speedKmh = |vL.z| * 3.6
     A2 inputs: pedal swap, clutch flag, steer angles          (§2.1)
     A3 gearbox                                                 (§2.2)
     A4 damage effects, only if damage.physical                 (§5.6)
     A5 engine, rpm, turbo, differentials, brakes               (§2.3)
     A6 gravity + aero -> body.Fext                             (§2.4)
  B. stepB(dt)                       // FUN_006caab0
     B1 speed factor s, slip-ratio threshold
     B2 integrate pose with last step's velocities; rebuild axes; vL
     B3 body slip angle beta
     B4 wheel segments + hull probes                             (§2.5.1, §2.9)
     B5 suspension -> Fsusp, ext, nContacts                      (§2.5.3)
     B6 tyre normal loads                                        (§2.5.5)
     B7 per-wheel loop: spin, kinematics, slip, mu, tyre force, assists, accumulate (§2.6)
     B8 throttle ramp; body friction damping                    (§2.7)
     B9 anti-roll torque                                         (§2.7)
     B10 body solver (car's turn, or a hull hit in the last 5 steps) (§2.9)
     B11 yaw torque and yaw momentum caps (if >= 2 contacts)    (§2.8)
     B12 air gravity multiplier                                  (§2.10)
     B13 integrate velocities and angular momentum; free-flight damping; sleep (§2.10)
```

### 1.6 Implementation phases (suggested)

1. Flat-plane harness + §2.1-§2.8 + §2.10 with no suspension travel (contact height fixed). This alone
   reproduces all handling feel tests in §7 except crests and jumps.
2. Ray-cast suspension (§2.5), slopes, bumps, anti-roll, air phase, chassis collision.
3. Input filter, cameras, reset, tuning panel.

---------------------------------------------------------------------------------------------------

## 2. Force equations (TypeScript-ready pseudo-code, in step order)

Conventions inside this section: all vectors are sim-space. `p` = car parameters (§3), `S` = CarState,
`B` = Body, `W[i]` = wheels, `C` = Controls. Helpers:

```ts
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
// add, sub, scale(v,k), dot, cross (formula in §1.1), len, normalize: usual vector helpers
const toLocal = (v: V3): V3 => ({ x: dot(B.right, v), y: dot(B.up, v), z: dot(B.fwd, v) });
const toWorld = (l: V3): V3 => add(add(scale(B.right, l.x), scale(B.up, l.y)), scale(B.fwd, l.z));
const DT = 1 / 120;
const GRAVITY = 12.0;                          // m/s²  [V 0x825df8 = -12.0, FUN_006c8250]
const DEEP = new Set([0, 9, 11, 12, 18, 19, 22]); // grass, snow-deep, snow-ditch, gravel-deep,
                                               // mud-ditch, sand-deep, sand-dark-deep [V switch in 0x6d0410/0x6caab0]
```

Note on gravity: the car physics uses **12 m/s²** [V]. A 9.82 constant also exists in the original but is used
by AI curve-speed code and other objects, not by the car [V 0x81a3e4 used at 0x607e42].

### 2.1 Inputs and steering angle [V FUN_006c6b60]

```ts
function inputsAndSteer() {
  S.speedKmh = Math.abs(B.vL.z) * 3.6;
  if (p.transmission === 'auto' && S.gear === 0) { S.thr = C.brake; S.brk = C.throttle; } // pedals swap in auto reverse
  else { S.thr = C.throttle; S.brk = C.brake; }
  S.clutch = S.parked /* || C.clutchButton (not exposed) */;   // cleared every step otherwise
  const lock = p.wheelScale + (S.speedKmh < 40 ? (40 - S.speedKmh) * 0.005 : 0); // rad; 0.4 -> 0.6 at standstill
  const st = clamp(C.steer, -1, 1);
  S.steer[0] = S.steer[1] = lock * st;   // same angle both front wheels; Ackermann comes from §2.6 W5
  // + damage steer offsets if damage.physical (§5.6)
}
```
* There is no rate limit or speed-dependent reduction of lock in the physics. Input smoothing lives in the
  input filter (§5.1).
* A "throttle held" timer exists in the original (state+8) but has no reader [V]; omit it.

### 2.2 Gearbox [V FUN_006c6c60, shift speeds FUN_006c6810]

Shift-speed table, rebuilt whenever ratios change:

```ts
function buildShiftSpeeds() {
  const rpmRef = p.turboSize !== 0 ? p.maxTurboTorqueRpm : p.maxTorqueRpm;   // 6750 / 6500
  const circ = 2 * Math.PI * p.wheelRadius;
  for (let i = 0; i < p.nGears; i++)     // shiftSpeed[i] = upshift speed out of gear i+1, km/h
    S.shiftSpeed[i] = p.useGearSpeedValues ? p.gearSpeed[i]
                    : ((rpmRef - 50) * (circ * 3.6) / (p.finalDrive * 60)) / S.ratio[i + 1];
}
```

Per step (stepA, after inputs):

```ts
function gearbox(dt: number) {
  if (S.shiftDir !== 0) {                         // a shift is in progress
    S.shiftTimer -= dt; S.clutch = true;          // no drive torque while shifting (§2.3)
    if (S.shiftTimer >= 0) return;
    S.gear += S.shiftDir === 1 ? +1 : -1; S.shiftDir = 0;
    return;                                       // (+ damage gear-skip rules, §5.6)
  }
  if (p.transmission === 'auto') {
    if (S.clutch) return;                         // parked: no auto logic
    const v = len(B.vW) * 3.6;                    // 3-D WORLD speed: sliding sideways counts toward upshifts
    const g = S.gear;
    if (g === 0) {                                // reverse -> 1st when "brake" (= throttle pedal) pressed
      if (S.brk > 0.3 && (S.speedKmh < 0.25 || B.vL.z > 0)) { S.shiftDir = 1; S.shiftTimer = p.timeChangeGearFR * 1.5; }
      return;
    }
    if (v > S.shiftSpeed[g - 1] && g < p.nGears) { S.shiftDir = 1; S.shiftTimer = p.timeChangeGear * 1.5; }
    if (S.thr <= p.throttleMinLimit) {            // coasting
      if (S.brk <= 0.3 || S.speedKmh >= 5) {
        const th = S.shiftSpeed[g - 1] * p.downGearFactor;
        if (v < th && S.rpm < p.minRpmGearChange &&
            ((g === 2 && v < 0.75 * th) || (g > 2 && v < 0.95 * th))) {
          S.shiftDir = 2; S.shiftTimer = Math.min(S.shiftTimer, 0); // timer NOT reloaded: completes next step [V]
        }
      } else {                                     // braking below 5 km/h: select 1st, then reverse
        S.gear = 1;
        if (S.reverseAllowed) { S.shiftDir = 2; S.shiftTimer = p.timeChangeGearFR * 1.5; }
      }
    } else if (g > 1 && v < S.shiftSpeed[g - 2] * p.downGearFactor) { // on-throttle kick-down: instant, no clutch
      let u = g - 1;
      while (u > 1 && v < S.shiftSpeed[u - 2] * p.downGearFactor) { S.gear--; u--; }
      S.gear--;
    }
  } else {                                         // manual
    if (!C.gearDown) {
      if (C.gearUp && S.gear < p.nGears) {
        if (S.gear === 0) {
          if (!(S.speedKmh >= 100 && B.vL.z <= 0)) { S.shiftDir = 1; S.shiftTimer = p.timeChangeGearFR * 1.5; }
        } else { S.shiftDir = 1; S.shiftTimer = p.timeChangeGear; }      // manual: no x1.5
      }
    } else if (S.gear !== 0) {
      if (S.gear === 1) { if (S.speedKmh < 30) { S.shiftDir = 2; S.shiftTimer = p.timeChangeGearFR * 1.5; } }
      else { S.shiftDir = 2; S.shiftTimer = p.timeChangeGear; }
    }
  }
}
```

Consequences with shipped values (TimeChangeGear 0.1, FR 0.15): auto shifts take 0.15 s with zero drive torque;
manual shifts 0.10 s; R↔1 0.225 s. "Hold brake while stopped for reverse" = brake > 0.3 below 5 km/h.

### 2.3 Engine, differentials and brakes [V FUN_006c7170, FUN_006c7e70, FUN_006c8050, FUN_006c81a0]

#### 2.3.1 Effective gear ratios [V FUN_006c8350/FUN_006c83c0]

```ts
// m = setup gear-ratio modifier (1.0 default; menu 0.8/1.0/1.2, §5.5). Gears 0 (R) and 1..4 use m, gears >= 5 use (2 - m).
S.ratio[g] = p.gearRatio[g] * (g <= 4 ? m : (2 - m));     // gearRatio[0] is reverse (negative)
// (the original also multiplies by a per-gear damage factor (1 - (k[g]-1)*0.5), k = 1 normally)
buildShiftSpeeds();
```

#### 2.3.2 Torque curve and engine torque

`TORQUE_CURVE` (124 entries, shared by every car, index = rpm × 0.0128, i.e. 78.125 rpm per entry, linear
interpolation) [V int16/16384 table at 0x85a0e8]:

```ts
const TORQUE_CURVE = [
  0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,
  0.1953,0.1953,0.1953,0.1953,0.2026,0.2054,0.2065,0.2063,0.2055,0.2046,0.2041,0.2047,0.2067,0.2109,0.2178,0.2279,
  0.2418,0.2599,0.2821,0.3079,0.3369,0.3687,0.4029,0.4390,0.4767,0.5156,0.5552,0.5952,0.6350,0.6766,0.7366,0.8039,
  0.8602,0.8912,0.9135,0.9318,0.9467,0.9584,0.9675,0.9745,0.9798,0.9838,0.9872,0.9904,0.9930,0.9954,0.9975,0.9992,
  1.0005,1.0016,1.0023,1.0027,1.0028,1.0026,1.0020,1.0011,0.9999,0.9985,0.9966,0.9946,0.9922,0.9896,0.9866,0.9836,
  0.9806,0.9776,0.9745,0.9714,0.9681,0.9647,0.9611,0.9573,0.9534,0.9491,0.9445,0.9396,0.9343,0.9287,0.9226,0.9161,
  0.9091,0.9016,0.8935,0.8848,0.8755,0.8656,0.8550,0.8438,0.8317,0.8187,0.8047,0.7898,0.7737,0.7564,0.7379,0.7180,
  0.6967,0.6738,0.6495,0.6235,0.5958,0.5663,0.5350,0.5017,0.4502,0.3759,0.2908,0.2073 ];
// shape: 0.195 flat to 1500 rpm, 0.5 at ~3250, 0.9 at ~3830, peak 1.003 at 5300, 0.80 at 8300, 0.21 at 9600

function torqueCurve(): number {
  // (original: if a damage "cut timer" > 0, returns 0 and forces S.thr = 0.5; ignore unless damage.physical)
  const r = Math.abs(S.rpm);
  if (r > 9500) return 0;
  const f = r * 0.0128, i = Math.floor(f);
  if (i >= 123) return TORQUE_CURVE[123];
  return TORQUE_CURVE[i] + (TORQUE_CURVE[i + 1] - TORQUE_CURVE[i]) * (f - i);
}

function engineTorque(): number {                          // per-wheel base torque T, N·m  [V FUN_006c8050]
  let t = S.rpm >= 10000 ? 0 : torqueCurve() * p.torqueScaleFactor;
  t *= p.torqueScale;                                      // (x (1 + 0.125*bonus), bonus always 0 [V])
  if (S.gear < 3 && S.rpm < 5500) {                        // gears R, 1, 2: low-rpm fill
    const f = (6000 - S.rpm) * 1e-4 * p.torqueScale;
    if (f > 0) t += f;
    if (p.useSpinTorque && S.thr > 0.5 && (S.gear === 0 || S.gear === 1))
      t += Math.abs(S.thr) * p.spinTorqueScaleValue * f;   // big launch bonus in R/1st
  }
  if (p.turboSize !== 0) t *= 1 + (0.75 / p.turboWasteGate) * p.turboSize * S.boost; // up to x1.75
  // (engine damage misfire, §5.6)
  t *= upgrade.engine;                                     // 1.0
  if (S.gear === 0) t = -t;
  return t;
}
```

Worked example (shipped values, 1st gear, 1000 rpm, full throttle, TorqueScale 935): curve 0.195 → 182;
fill (6000-1000)·1e-4·935 = 468; SpinTorque 10·468 = 4675; total ≈ 5325 N·m per wheel. Launches are
traction-limited by design.

#### 2.3.3 Rpm and turbo [V FUN_006c7e70]

```ts
function updateRpm(wMean: number, thr: number, dt: number) {
  if (!S.clutch) {
    S.rpm = wMean * 9.549296 * S.ratio[S.gear] * p.finalDrive;           // rad/s -> rpm, direct drive
    if (S.rpm > p.cutRpm) S.rpm -= 2 * S.rpm * dt;
  } else {                                                               // clutch open (shifting/parked): free rev
    S.rpm = S.rpm - (2 - thr * 1.95) * S.rpm * dt * 0.75 + dt * 15000 * thr * 2.5 * torqueCurve();
  }
  if (p.turboSize === 0) { S.boost = -1; return; }
  if (thr <= 0.5 || S.rpm <= p.turboSize * 1500 - 800)   // 0.5 = p.turboSpoolThrottle (tunable, §6)
    S.boost -= p.turboSize * Math.max(0, (0.5 - thr) * 2) * S.boost / (p.turboSpinup * 40);  // PER STEP, not x dt
  else
    S.boost += S.boost * thr / (p.turboSpinup * 40);                                        // PER STEP
  S.boost = clamp(S.boost, p.turboIdle, p.turboWasteGate);
}
```
With shipped values (idle 0.1, waste gate 100, spinup 1) boost grows ×1.025 per step at full throttle: from
idle to the waste gate in about 2.3 s, i.e. the torque factor rises from 1.0 to 1.75 over 2.3 s of full throttle.
It decays at the same rate with the throttle closed and is capped to 25 (factor 1.19) during shifts.
Feel consequence [M]: any part-throttle phase (≤ 0.5, e.g. a steady cruise) lets the turbo fall back to idle,
so power-on rotation (D3/D4, "accelerate out while sliding" D6) arrives 2-3 s after the throttle opens: from a
steady 80 km/h on gravel the rwd car passes |β| 30° only after ≈ 4 s, against ≈ 1.1 s when the turbo is already
spooled (§7 T8). Whether that lag is wanted is a playtest question; tune it live with `turboSpinup`,
`turboIdle` and `turboSpoolThrottle` (§6). The shipped values are the original's.

#### 2.3.4 Drive torque, engine braking and differentials [V FUN_006c7170, jump tables 0x6c7e24/34/44]

```ts
function drivetrain(hb: number, dt: number) {
  for (const w of W) { w.driveT = 0; w.brakeT = 0; }
  const shifting = S.shiftDir !== 0 || S.clutch;
  if (shifting) {
    if (p.useEngineBrakeConstant && ((S.shiftDir === 1 && S.gear === 0) || (S.shiftDir === 2 && S.gear === 1)))
      for (const w of W) w.brakeT = p.engineBrakeConstant;        // R<->1 change: hold the car
    const wAll = (W[0].omega + W[1].omega + W[2].omega + W[3].omega) * 0.25;
    if (S.shiftDir !== 0) {
      if (p.turboSize !== 0 && S.boost > 0.25 * p.turboWasteGate) S.boost = 0.25 * p.turboWasteGate;
      updateRpm(wAll, 0, dt);                                       // throttle ignored while shifting
    } else updateRpm(wAll, S.thr, dt);
  } else {
    const f = (o: number) => (S.gear === 0 ? Math.min(o, 0) : Math.max(o, 0)); // ignore wheels turning "backwards"
    let kF = 1, kR = 1, kC = 1, wMean = 0;
    if (p.wheelDrive === 0) {                     // "FWD": rpm from fronts
      const a = f(W[0].omega), b = f(W[1].omega); wMean = (a + b) / 2;
      if (wMean !== 0) kF = clamp(b / wMean, 0.5, 1.5);
    } else if (p.wheelDrive === 1) {              // "RWD": rpm from rears
      const a = f(W[3].omega), b = f(W[2].omega); wMean = (a + b) / 2;
      if (wMean !== 0) kR = clamp(b / wMean, 0.5, 1.5);
    } else {                                      // AWD
      const a = f(W[0].omega), b = f(W[1].omega), fm = (a + b) / 2; if (fm !== 0) kF = clamp(b / fm, 0.5, 1.5);
      const c = f(W[3].omega), d = f(W[2].omega), rm = (c + d) / 2; if (rm !== 0) kR = clamp(d / rm, 0.5, 1.5);
      wMean = (fm + rm) / 2; if (wMean !== 0) kC = clamp(fm / wMean, 0.5, 1.5);
    }
    updateRpm(wMean, S.thr, dt);
    let T: number;
    if (S.thr <= p.throttleMinLimit) {            // off throttle: engine braking (NOT EngineBrakeConstant)
      T = (S.thr - p.throttleMinLimit) * ((5000 - 700 * S.gear) + S.rpm) * 0.75;   // negative
      if (Math.abs(wMean) < 1) T *= Math.abs(wMean);
      if (S.gear === 0) T = -T;
    } else {
      T = engineTorque();
      if (p.useAntiSpin && S.gear < 3 && W.some(w => Math.abs(w.kappa) > 0.05)) T /= p.antiSpinFactor;
      T *= S.thr;
    }
    // per-wheel split; T is a per-wheel base torque, the four shares always sum to 4T.
    // k = ratio of one wheel's speed to its pair mean: torque moves AWAY from the faster wheel (LSD-like).
    if (p.wheelDrive === 0) {         // 75 % front / 25 % rear  (rear pair reuses the FRONT ratio kF) [V]
      W[0].driveT = 1.5 * T * kF; W[1].driveT = 1.5 * T * (2 - kF);
      W[2].driveT = 0.5 * T * kF; W[3].driveT = 0.5 * T * (2 - kF);
    } else if (p.wheelDrive === 1) {  // 37.5 % front / 62.5 % rear (front pair reuses the REAR ratio kR) [V]
      W[0].driveT = 0.75 * T * kR; W[1].driveT = 0.75 * T * (2 - kR);
      W[2].driveT = 1.25 * T * (2 - kR); W[3].driveT = 1.25 * T * kR;
    } else {                          // AWD: centre split fs (1.0 = 50/50), centre LSD kC
      const fs = setup.awdBaseSplit /*1.0 [G]*/ * setup.powerRatio /*1.0*/;
      W[0].driveT = (2 - kC) * kF * fs * T;       W[1].driveT = (2 - kC) * (2 - kF) * fs * T;
      W[2].driveT = (2 - kR) * kC * (2 - fs) * T; W[3].driveT = kR * kC * (2 - fs) * T;
    }
  }
  engineBrakeConstant();   // §2.3.5
  idleAndLimiter();        // §2.3.5
  rollingResistance();     // §2.3.6
  serviceBrakes(hb);       // §2.3.6
}
```

Important feel facts [V]: "FWD" (wheelDrive 0) still sends 25 % to the rear, "RWD" (1) sends 37.5 % to the
front. Gear ratio never scales wheel torque. No drive torque at all while a shift is in progress.

#### 2.3.5 Hill-hold, stall drag, park; idle and rev limiter [V FUN_006c7170 tail]

```ts
function engineBrakeConstant() {
  if (!p.useEngineBrakeConstant) return;
  const EBC = p.engineBrakeConstant;
  if (S.parked) { for (const w of W) w.brakeT = EBC; return; }
  if (S.thr < p.throttleMinLimit || S.shiftDir !== 0) {
    if (S.rpm <= p.minRpm) {                       // below idle: stall drag
      const x = Math.min(p.minRpm - S.rpm, p.minRpm) / p.minRpm;
      for (const w of W) w.brakeT = x * x * EBC * 0.2;
    }
  } else if (S.gear === 0) { for (const w of W) if (w.omega > 0.3) w.brakeT = EBC; }  // no rolling forward in R
  else { for (const w of W) if (w.omega < -0.3) w.brakeT = EBC; }                  // hill-hold: no rolling back
}

// rpmAtStepStart = S.rpm captured at the very start of drivetrain(), before updateRpm()
function idleAndLimiter() {   // writes S.rpm AFTER this step's torque lookup; see the note below for its readers
  if (S.rpm < p.minRpm) {
    if (S.thr >= p.throttleMinLimit) S.rpm = p.minRpm;
    else S.rpm = clamp(rpmAtStepStart, p.minRpm - 184, p.minRpm - 16) + randInt(-15, 16);  // stall wobble
  }
  if (S.rpm > p.cutRpm) S.rpm = p.cutRpm + 512 + randInt(-511, 512);   // jittery redline, CutRPM+1 .. +1024
}
```
The limiter does **not** cut torque [V FUN_006c7170: FUN_006c7e70, then FUN_006c8050, then the tail]. Torque
is looked up right after `updateRpm()`, at the wheel-derived rpm reduced by `2·rpm·dt` above CutRPM: about
8590 rpm (curve ≈ 0.74) at 210 km/h in 6th. The `CutRPM + 1 … + 1024` jitter is written afterwards. The next
step's `updateRpm()` overwrites it from wheel speed, so it only reaches the HUD/sound, the auto-box
`rpm < MinRPMGearChange` test (§2.2) and the clutch-open free-rev branch (§2.3.3). The stall wobble below
idle works the same way. Top speed is set by drag and rolling resistance (§7 T2), not by the limiter.

#### 2.3.6 Rolling resistance, service brakes, ABS, handbrake [V FUN_006c7170, asm 0x6c7c4c-0x6c7d2e; FUN_006c8540]

```ts
function rollingResistance() {        // viscous on wheel spin; uses LAST step's tyre loads
  let pool = 0;
  W.forEach((w, i) => {
    let c = 0;
    if (w.contact) {
      const rr = tyreTable(w.surface, p.tyreType).bestRollK + tyreTable(w.surface, p.tyreType).diffRollK * p.rollLevel;
      const t = (-w.load) / 2048 * rr;          // N·m per rad/s
      c = 0.25 * t; pool += 0.75 * t;
    }
    const driven = p.wheelDrive === 2 || (p.wheelDrive === 0 && i < 2) || (p.wheelDrive === 1 && i >= 2);
    if (driven) c += p.wheel[i].rollK;          // drivetrain drag on DRIVEN wheels only ("RollK")
    w.driveT -= w.omega * c;
  });
  for (const w of W) w.driveT -= w.omega * 0.25 * pool;
}

// brake capacity (at init and on setup change):
//   f = p.brakeBalance (1.25) * setup.brake (1.0); front cap = p.brakeTorque * upgrade.brakes * f;
//   rear cap = p.brakeTorque * upgrade.brakes * (2 - f).   -> 5000 / 3000 N·m per wheel with shipped values
function serviceBrakes(hb: number) {
  if (S.brk > p.brakeMinLimit) for (const w of W) {
    if (S.brk < 0.75) w.brakeT = 0.5 * S.brk * S.brk * w.brakeCap;                   // half-strength zone
    else if (!p.useAbs || Math.abs(w.kappa) < p.absFactor) w.brakeT = S.brk * S.brk * w.brakeCap;
    else w.brakeT = 0;                                                                // ABS release
  }
  if (hb > p.brakeMinLimit)                       // handbrake OVERWRITES service brake on all wheels, linear
    W.forEach((w, i) => { w.brakeT = hb * p.handBrakeTorque * (i < 2 ? 0.3 : 1.3); });
}
```
Note: the handbrake does not cut drive torque [V]. ABS only acts above 75 % pedal and only when the slip
ratio reaches 0.75 (very late) [V].

### 2.4 Gravity and aerodynamics [V FUN_006c8250, asm 0x6c8250-0x6c8342]

```ts
function aeroGravity() {
  const q = -p.airKZY * B.vL.z * B.vL.z;                     // downforce from FORWARD speed², along body up
  B.Fext = {
    x: q * B.up.x - Math.abs(B.vW.x) * B.vW.x * p.airKZZ,   // quadratic drag per WORLD axis
    y: q * B.up.y - GRAVITY * B.mass - Math.abs(B.vW.y) * B.vW.y * p.airKZZ,
    z: q * B.up.z - Math.abs(B.vW.z) * B.vW.z * p.airKZZ,
  };
}
```
Shipped AirKZY 1.25 kg/m (downforce 1125 N at 30 m/s), AirKZZ 2.0 kg/m (drag 1800 N at 30 m/s).

### 2.5 Main step B: pose, contacts, suspension, loads

#### 2.5.0 Start of stepB [V FUN_006caab0 start]

```ts
const s = S.speedKmh <= 25 ? 0 : Math.min(1, (S.speedKmh - 25) * 0.02);   // assist speed factor: 0 @25 -> 1 @75 km/h
const kappaThr = 0.075 * (1 + s);                                          // slip-ratio grip->slide threshold
B.pos = add(B.pos, scale(B.vW, dt));                                       // positions first (symplectic Euler)
B.q = normalizeQ(addQ(B.q, scaleQ(mulQ(B.q, { w: 0, ...B.w }), 0.5 * dt)));  // q += ½ dt q⊗(0,ω_body)
rebuildAxes();      // right = (1-2(y²+z²), 2(xy+wz), 2(xz-wy)); up = (2(xy-wz), 1-2(x²+z²), 2(yz+wx));
                    // fwd = (2(xz+wy), 2(yz-wx), 1-2(x²+y²))   [V]
B.vL = toLocal(B.vW);
const beta = B.vL.z === 0 ? 0 : Math.atan(-B.vL.x / B.vL.z);   // body slip angle; + = velocity LEFT of heading
S.stepParity ^= 1;
```

#### 2.5.1 Wheel rays [V FUN_006cea90; R v1.4/v1.5]

The ground query is the original's SEGMENT test (research/formats/gcm.md §3.2-3.4; `WorldQuery.segment`): `ray` is
the full segment vector, the test is one-sided (the start strictly above the face plane, the end on or below it,
`dot(ray, n) < 0`), the FIRST face in the original traversal order wins, and each wheel / hull point keeps a face
cache under its slot. A hit returns `depth = dot(end − v0, n)` (≤ 0, metres the segment END lies below the face) and
`cos = dot(n, ray)` (the ray NOT normalised: −SL·cosθ for a wheel).

```ts
let nWheel = 0;
for (const [i, w] of W.entries()) {
  const start = add(B.pos, toWorld(w.mount));
  const ray = scale(B.up, -p.springLength);     // straight down the BODY axis (not world down), full length
  w.rayEnd = add(start, ray);                   // W+0x94: the bump pattern samples this point (§2.5.2)
  const hit = terrain.segment(start, ray, i + 24 * carIndex);   // slot = wheel + 24·car (car+0xa4)
  if (!hit || (hit.origMaterial >>> 0) >= 0x20) {              // (unsigned) material >= 32: no contact
    w.contact = false; w.surface = -1; w.normalW = {x: 0, y: 1, z: 0}; w.c0 = 0; w.c4 = 1;
  } else {
    w.contact = true; w.surface = hit.material; w.hitDist = hit.dist; w.normalW = hit.normal;
    w.c0 = hit.depth;                           // W+0xc0
    w.c4 = hit.cos;                             // W+0xc4 = −SL·(n·up)
    nWheel++;
  }
}
// then the hull probes of §2.9 (12 points if nWheel < 3, else 8; scheduling there)
```
rally-web numbering: `hit.material` is the rally-web material (`materialFromOrig(byte)`, §4.3), `hit.origMaterial` the
raw gcm byte. [R] On the original Track.gcm (rallycross1, built collision part) the sim's own wheel segments
reproduce every recorded wheel ray of the Frida traces: 282,228 wheel-steps of run 2, 1 contact mismatch, material
100 %, |Δc0| ≤ 8.1e-5 m, |Δc4| ≤ 7.7e-4 (Appendix C v1.5).

#### 2.5.2 Surface sink and bump [V FUN_006cf860]

```ts
function surfaceSink(w: Wheel): number {
  const sf = surfaceTable[w.surface];
  let sink = sf.maxDepth;
  if (sf.bumpFlag & 1) {                           // washboard on flagged surfaces, 0.2 m cells
    let b = 0;
    for (const c of [w.rayEnd.x, w.rayEnd.z]) {   // v1.4 [R]: this step's ray END point (mount - up·SL), W+0x94/+0x9c
      const u = ((c % 0.2) + 0.2) % 0.2;
      if (u > 0.025 && u < 0.175) b += Math.cos((u - 0.1) * 16) - 0.36;
    }
    const A = sf.bump * (1 - S.speedKmh / 512);
    sink += A * (0.64 - 0.5 * b);                  // 0..0.64·A ripple
  }
  return sink;
}
```
(A second pattern with 0.8 m cells applies when the hull touches a special material 0x23 [V]; not needed.)

#### 2.5.3 Suspension [V FUN_006cf620; R v1.5]

```ts
let n = 0;
for (const w of W) {
  if (!w.contact) { w.dampV = 0; w.ext = 1.0; w.Fsusp = 0; continue; }
  n++;
  const x = clamp(1 - (surfaceSink(w) + w.c0) / (w.c4 * p.springLength), 0, 1);   // [V, R] the ray's c0 / c4
  // = 1 − (SL − hitDist)/SL² + sink/(SL²·cosθ): c0/c4 = (SL − hitDist)/SL is the compression FRACTION; sink LOWERS the car
  const xPrev = w.ext === 1.0 ? x : w.ext;                         // no damper spike on first contact
  w.ext = x;
  const e = 1 - (xPrev + x) / 2;                                   // mean compression fraction
  const k = setup.suspension;                                      // 1.0; menu 0.7/1.0/1.3 (§5.5)
  const dx = clamp((xPrev - x) * p.springLength, -0.5, 0.5);       // compression this step (in units of SL·x)
  const vOld = w.dampV, vNew = (2 / dt) * (dx - dt * vOld) + vOld; // trapezoid: (vNew+vOld)/2 = dx/dt
  w.dampV = vNew;
  const Fd = Math.min(60000, 0.5 * (vNew + vOld) * (1 + e) * k * p.dampK);
  const Fs = k * p.springK * p.springLength * e * (1 + 0.5 * e);   // progressive spring
  let F = Fd + Fs;
  const vn = dot(B.vW, w.normalW);
  if (vn > 2) F = Math.min(F, Math.max(0, 32000 - 5000 * vn));     // anti-pogo when leaving the ground fast
  w.Fsusp = Math.max(0, F);
}
S.nContacts = n;
```
`Fsusp` is applied along the contact normal at the contact point in the wheel loop (§2.6 W4). It is never used
as the tyre load. With shipped values the static compression fraction is about 0.13, i.e. (1 − x)·SL² ≈ 0.074 m
of geometric compression (0.75 m springs): per metre of travel the spring and damper act 1/SL = 1.33× stiffer than
the fraction suggests. The wheel loop places the contact point at `mount − up·SL·x` (C+0x24), which therefore sits
≈ 2-3 cm ABOVE the hit face, 0.42 m below the CG on the awd car (the §7 reference depth).

v1.5 [R] (proof, `research/frida/susp_proof.py`, run 1 / run 2 of the Frida traces, rallycross1 Track.gcm):
* the ray callback's outputs are geometric: on consecutive steps over the same face, Δc0 = 1.000000·dot(Δend, n)
  (1,225 / 3,950 pairs, residual median 1e-6 m; a compression-in-metres reading would need the factor SL = 0.75), and
  re-casting every recorded ray through the gcm port gives |t·SL − SL·(1 − c0/c4)| ≤ 3.7e-5 m;
* the recorded extension C+4 equals `1 − (sink + c0)/(c4·SL)` to ≤ 8.9e-5 (median 1.5e-8) over 21,269 / 281,676
  human wheel hits; the v1.4 formula `x = 1 − (comp − sink/(SL·cosθ))/SL` with comp = SL − hitDist in METRES misses
  by median 0.036-0.038 (max 0.078). v1.4 could not see this because its replay fed a fake distance SL − c0/c4 that
  turned the recorded fraction into metres;
* closed loop: replaying the trace open-loop on planes through each hit face (2 s windows, the original's inputs
  only), the end position error drops from median 25-27 mm (v1.4 formula; the car rides 2.5 cm too low) to 0.6-0.8 mm
  (run 2: p99 5 mm over 549 windows); on the original Track.gcm itself (wheels and hull segments on the mesh) median
  0.64 mm, p99 3.8 mm.

Consequences [M]: every car rides ≈ 2.5 cm higher than v1.4 (awd_wrc CG 0.446 m, fwd_hatch 0.421, rwd_classic 0.508
at the spring equilibrium on tarmac); wheel rate, damping and the anti-roll torque per metre of travel are 1.33×
the v1.4 values; tyre loads are unchanged (they do not come from the springs, §2.5.5). The §7 handling bands hold
(T13's crest load floor moved from 0.80 to 0.78 × static because the lower contact point gives ≈ 8 % more lagged
load transfer).

#### 2.5.4 Static front share (init) [V FUN_006c6810]

```ts
p.frontShare2 = 2 * Math.abs(W[3].mount.z) / (W[0].mount.z - W[3].mount.z);  // "s2": 2 x front axle fraction
// e.g. front axle 1.21 m ahead, rear 1.32 m behind -> 1.044 (front axle carries 52.2 %)
```

#### 2.5.5 Tyre normal loads [V FUN_006cfb50]

```ts
function tyreLoads(n: number) {
  const Fup = dot(B.Fext, B.up);                  // gravity + aero along body up (negative); NOT x airMul
  const nb = B.flags & 1 ? B.hullDir.y : 0;     // [V v1.5] the hull push direction's y (B+0x14c) while it touches
  B.bodyShare = (n === 0 ? 1 : n === 1 ? 1 / (nb + 1) : 1 / (nb + 4)) * nb;   // B+0x140, read by the body solver
  const Tx = B.loadMoment.x, Tz = B.loadMoment.z; // from LAST step's tyre forces (one-step lag)
  const SX = [-1, +1, +1, -1], SZ = [+1, +1, -1, -1];
  const sameSide = [3, 2, 1, 0], sameAxle = [1, 0, 3, 2];
  if (n === 1) {
    const i = W.findIndex(w => w.contact), d = toWorld(W[i].mount);
    W[i].load = -(d.y / len(d)) * Fup / (nb + 1);
  } else if (n >= 2) {
    const base = Fup / (nb + 4);
    W.forEach((w, i) => {
      if (!w.contact) return;
      const share = n === 2 ? base : base * (i < 2 ? p.frontShare2 : 2 - p.frontShare2);
      const kx = n === 2 ? 2 : (n === 3 && !W[sameSide[i]].contact ? 2 : 1);
      const kz = n === 2 ? 2 : (n === 3 && !W[sameAxle[i]].contact ? 2 : 1);
      w.load = share + SX[i] * kx * p.wheel[i].momentXDist * Tx + SZ[i] * kz * p.wheel[i].momentZDist * Tz;
    });
  }
}
// Tyre load used in the wheel loop: Fz = max(0, -w.load), then slope factor (§2.6 W6).
```
Consequences [V]: with 4 contacts the tyres carry exactly the weight (`12·m`) plus downforce. With fewer wheels
in contact each wheel still gets only about a quarter, so total grip drops (2 wheels carry half the weight).
`Tx`/`Tz` already contain the contact depth below the CG (about 0.42 m), so a rigid-body geometry would use
gains of 1/(2·track) ≈ 0.33 and 1/(2·wheelbase) ≈ 0.20. The shipped gains (0.060 and 0.080) make load transfer
about 5.5x weaker laterally and 2.5x weaker longitudinally than real [I]: the car feels planted. Grip does not
drop over crests until a wheel actually loses contact.

### 2.6 Per-wheel loop [V FUN_006caab0 wheel loop; tyre force FUN_006d0410]

Accumulators, zeroed before the loop: `Facc` (body-frame force), `Tacc` (body-frame torque),
`B.loadMoment = 0`. For each wheel i = 0..3 in order:

```ts
for (let i = 0; i < 4; i++) {
  const w = W[i], wp = p.wheel[i];
  let Fw = {x: 0, y: 0, z: 0};           // this wheel's force on the body (body frame)
  let Fx = 0, Fy = 0, Vx = 0, Vy = 0, head = 0, FxWheel = 0;
  // W1 wheel spin from drive and brake torque  [V FUN_006d0300]
  if (w.omega > 0) w.omega = Math.max(0, w.omega - w.brakeT * wp.wheelInertia * dt);
  else if (w.omega < 0) w.omega = Math.min(0, w.omega + w.brakeT * wp.wheelInertia * dt);
  let launch = 1;                        // launch assist, R and 1st with throttle
  if (S.gear <= 1 && S.thr > 0.1) {
    if (p.wheelDrive === 2) launch = Math.max(1, (25 - Math.abs(w.omega)) * 0.2);
    else launch = i < 2 ? Math.max(1, 4 - Math.abs(w.omega)) : Math.max(1, (20 - Math.abs(w.omega)) * 0.2);
  }
  w.omega += launch * w.driveT * wp.wheelInertia * dt;   // NOTE wheelInertia is an INVERSE inertia (1/(kg·m²))
  // W2 lock
  if (Math.abs(w.omega) < 3.14 && w.brakeT > 1000) w.omega = 0;
  // W3 contact point (body frame)
  const r = {x: w.mount.x, y: w.mount.y, z: w.mount.z};
  if (w.contact) {
    r.y = w.mount.y - p.springLength * w.ext;
    if (w.front) {                                         // kingpin offset (scrub radius) [V]
      const k = wp.steerTweak * (i === 1 ? -1 : 1);
      w.steerOffX = (1 - Math.cos(S.steer[i])) * k; w.steerOffZ = Math.sin(S.steer[i]) * k;
      r.x += w.steerOffX; r.z += w.steerOffZ;
    }
    // W4 contact velocity, normal, suspension force
    const v = add(B.vL, cross(B.w, r));
    let Fz = Math.max(0, -w.load);
    const nL = toLocal(w.normalW);
    Fw = scale(nL, w.Fsusp);
    // W5 wheel axes. Front wheels: lateral axis points at the turning centre on the other axle's line (Ackermann)
    let ax = 1, az = 0;
    if (w.front && S.steer[i] !== 0) {
      const t = Math.tan(S.steer[i]), c = t === 0 ? 1 : 1 / t;
      const dz = r.z - w.otherAxleZ;                      // ≈ +wheelbase for front wheels
      const X = (dz - w.steerOffZ) * c - r.x;
      if (X <= 0) { ax = -X; az = dz; } else { ax = X; az = -dz; }
    }
    const a = {x: ax, y: 0, z: az};
    const d = normalize(sub(a, scale(nL, dot(a, nL))));   // lateral axis in the ground plane (+ ≈ right)
    const fw = cross(d, nL);                             // longitudinal axis (+ ≈ forward)
    Vy = dot(v, d); Vx = dot(v, fw);
    w.ny = nL.y;
    // W6 slope load reduction
    if (nL.y < 0.9635) Fz *= Math.max(0.25, nL.y * nL.y);
    // W7 slip angle with relaxation (TireRelaxK, 1/m)
    const aVx = Math.abs(Vx);
    if (aVx > 3) w.tanA += wp.tireRelaxK * (-Vy - aVx * w.tanA) * dt;
    else if (aVx > 0.1) w.tanA = -Vy / aVx;
    else if (Math.abs(Vy) > 0.01) w.tanA = -Vy * 10;
    else w.tanA = Vy >= 0 ? -1e-5 : 1e-5;
    const alpha = Math.atan(w.tanA);
    // W8 slip ratio
    w.kappa = aVx === 0 ? (p.wheelRadius * w.omega - Vx) * 100 : (p.wheelRadius * w.omega - Vx) / aVx;
    // W9 friction coefficient from the tyre x surface table (§4)
    let mu = w.mode === 1 ? muStatic(w.surface, p.tyreType) : muKinetic(w.surface, p.tyreType);
    // W10 drift grip bonus (both modes)
    if (Math.abs(beta) > 0.125) mu *= 1 + Math.abs(beta) * S.thr * 0.2;
    const bb = assist.bigBetaSymmetric ? Math.abs(beta) : beta;          // DEV-1 (original: signed beta)
    if (bb > 0.75) mu *= 1 + (Math.abs(beta) - 0.75) * 0.3;
    w.mu = mu;
    const muFz = Fz * mu;
    // W11 grip/slide state machine (new mode takes effect NEXT step)
    const ssa = (S.steerSensFast ? wp.staticSlipAngleFast : wp.staticSlipAngleSlow) * upgrade.handling;
    const thrA = Fz / 2048 * ssa;                     // rad; grows with load
    let newMode = w.mode;
    if (w.mode === 1) {
      if ((Math.abs(w.omega) > 0.05 || Math.abs(Vy) > 0.05) &&
          (Math.abs(alpha) > thrA || Math.abs(w.kappa) > kappaThr)) newMode = 2;
    } else {
      if ((Math.abs(alpha) < thrA || Math.abs(Vy) < 0.1) && (Math.abs(w.kappa) < kappaThr || aVx < 0.1)) newMode = 1;
    }
    // W12 tyre force (§2.6.1)
    const tf = tyreForce(wp, w.tanA, w.kappa, Fz, muFz, DEEP.has(w.surface));
    Fy = tf.Fy; Fx = tf.Fx;
    // W13 yaw assists ("TW" tweaks), added to the yaw torque, scaled by the speed factor s
    let M: number;
    if (w.mode === 1) {
      M = wp.twStaMy * B.I.y * mu * (B.L.y >= 0 ? -1 : 1);          // yaw friction against yaw momentum
      // DEV-3 (if assist.smoothYawFrictionSign): M = -wp.twStaMy*B.I.y*mu*clamp(B.L.y/(0.05*B.I.y), -1, 1)
      if (w.front) { const m2 = wp.twStaSteer * B.I.y * mu * S.steer[i]; M += B.vL.z <= 0 ? -m2 : m2; }
    } else {
      M = tf.Mz;                                                     // self-aligning moment only while sliding
      if (w.front) { const m2 = (Math.abs(beta) + 0.25) * B.I.y * wp.twKinSteer * mu * S.steer[i]; M += B.vL.z <= 0 ? -m2 : m2; }
      if (Math.abs(w.omega) < 0.05 && Math.abs(Vy) < 0.05) newMode = 1;
    }
    Tacc.y += M * s;
    // W14 low-speed fades
    if (Math.abs(w.omega) < 0.1 && aVx < 0.1) Fx *= aVx * 10;
    if (Math.abs(Vy) < 0.0625) Fy *= Math.abs(Vy) * 16;
    head = muFz - Math.abs(Fy);                                      // grip headroom for the side fill
    FxWheel = Fx;                                                    // wheel reaction uses Fx BEFORE W15 [V]
    // W15 sliding wheelspin limiter (slide mode, below 25 km/h): reduces only the force on the BODY
    if (w.mode === 2 && (S.gear > 1 || p.wheelDrive === 2) && s === 0 && Math.abs(w.kappa) > 0.15 &&
        sgn(w.kappa) === sgn(w.omega) && w.omega !== 0) {
      const f1 = Math.min(1, 0.15 / Math.abs(w.kappa) + 0.25), g1 = Math.max(0, 1.5 - mu);
      Fx *= Math.max(f1, g1);                                        // NB can exceed 1 on low-mu surfaces [V]
    }
    w.mode = newMode;
    Fw = add(Fw, add(scale(fw, Fx), scale(d, Fy)));
  } else {
    w.ny = 0;
  }
  // W16 drift drive boost and wheel reaction (FxWheel = 0 when not in contact)
  const extra = Math.abs(w.omega) > 1 ? FxWheel * 0.5 * Math.abs(beta) * s : 0;
  if (w.brakeT < 1000 || Math.abs(w.omega) < 3.14)                 // [V asm 0x6cbfbe-0x6cbfd9]
    w.omega += -(extra + FxWheel) * p.wheelRadius * wp.wheelInertia * dt;
  // W17 spin-torque damping (shipped OFF)
  if (p.useSpinTorqueDamping && S.speedKmh < 40 && S.thr > 0.5 && S.gear === 1 && Math.abs(w.kappa) > 0.05)
    Facc.z /= p.spinTorqueDampingValue;
  Facc.z += extra;                                                   // body push along heading, no torque
  // W18 side fill: push lateral grip toward the friction limit, grows with body slip
  if (head !== 0 && Math.abs(Vy) > 0.0625) {
    const f2 = Math.min(1, Math.abs(beta) + 0.25);
    const gate = assist.smoothSideFillGate ? clamp((Math.abs(Vy) - 0.0625) / 0.0625, 0, 1) : 1;   // DEV-8 (off)
    Facc.x += (Fy > 0 ? 1 : -1) * f2 * Math.min(head, 10000) * gate; // body-x, no torque; Fy == 0 -> negative [V]
  }
  // W19 flip assist (rolls an overturned, stopped car back with throttle)  [V; application point I]
  if (len(B.vW) * 3.6 < 5) {
    if (B.up.y >= 0.125) S.flipTimer = 0; else S.flipTimer += dt;  // NB runs once PER WHEEL: 4·dt per step
    if (S.flipTimer > 4 && Math.abs(B.fwd.y) < 0.5 && B.up.y < 0.25 && S.nContacts === 0) {
      const push = {x: 0, y: B.mass * S.thrRamp * -GRAVITY, z: 0};  // body frame
      if (B.right.y >= 0.5) { if ((i === 1 || i === 2)) Fw = add(Fw, push); }   // lying on its left side
      else if (i === 0 || i === 3) Fw = add(Fw, push);              // lying on its right side
      // (original has one more orientation test in the first branch; equivalent for a car on its side)
    }
  }
  // W20 accumulate
  Facc = add(Facc, Fw);
  Tacc = add(Tacc, cross(r, Fw));
  B.loadMoment.x += -r.y * Fw.x;  B.loadMoment.z += -r.y * Fw.z;    // drives next step's load transfer
  w.contactW = add(B.pos, toWorld(r));
}
```

Low-speed behaviour of the loop [M, spec-literal sim; UNVERIFIED against the original, which was not run]:
* **10-45 km/h, 2-step lateral limit cycle.** The 0.0625 m/s gates (W18 on above, W14 fade below) make the
  lateral force alternate every step: up to about 1.4 g step-to-step on tarmac at full lock (17 km/h: 0.09 g /
  0.99 g). The mean is correct and position jitter is about 0.3 mm, so it is faithful and harmless to the
  trajectory. None above 60 km/h. **Consumers must not read a single step's force**: derive bumper-cam G-sway,
  tyre audio and telemetry from Δv over at least 2 physics steps (a whole rendered frame). DEV-8 smooths it.
* **Below about 0.1 m/s the tyre forces are bang-bang**: κ = ±1 when ω = 0, and the W14 fade gain is
  λ·dt = 10·μ·g·dt = μ ≈ 2.4 on tarmac (explicit Euler needs λ·dt < 2, i.e. μ < 2.0). Only the sleep rule
  (§2.10) brings the car to rest.

#### 2.6.1 Tyre force function [V FUN_006d0410, FUN_006d0700, FUN_006d07c0, FUN_006d0850, FUN_006d0910]

`LOAD_TABLE` rows every 500 N of tyre load, 0..9500 N: `[Palpha, Pkappa, Dy, Dx]` [V table at 0x859fa8]:

```ts
const LOAD_TABLE = [
  [0.4033,0.3049,1.0262,1.0707],[0.4095,0.3094,1.0266,1.0719],[0.4158,0.3140,1.0270,1.0731],[0.4223,0.3188,1.0275,1.0744],
  [0.4291,0.3238,1.0280,1.0757],[0.4361,0.3289,1.0285,1.0771],[0.4433,0.3342,1.0290,1.0785],[0.4508,0.3397,1.0295,1.0799],
  [0.4586,0.3454,1.0300,1.0815],[0.4667,0.3513,1.0306,1.0831],[0.4752,0.3574,1.0312,1.0847],[0.4839,0.3638,1.0318,1.0865],
  [0.4930,0.3704,1.0324,1.0883],[0.5025,0.3773,1.0331,1.0902],[0.5124,0.3845,1.0338,1.0922],[0.5228,0.3920,1.0345,1.0943],
  [0.5336,0.3999,1.0353,1.0965],[0.5449,0.4081,1.0361,1.0988],[0.5568,0.4167,1.0370,1.1013],[0.5692,0.4257,1.0378,1.1039] ];

function tyreForce(wp, tanA: number, kappa: number, Fz: number, muFz: number, deep: boolean) {
  const neg = kappa < 0, k = Math.abs(kappa);
  const sx = -k / (1 + k), sy = tanA / (1 + k);              // combined slip
  let P: number[];
  if (Fz >= 9500) P = LOAD_TABLE[19];
  else { const f = Fz * 0.002, j = Math.floor(f), t = f - j;
         P = LOAD_TABLE[j].map((v, q) => v + (LOAD_TABLE[j + 1][q] - v) * t); }
  const [pa, pk, Dy, Dx] = P;
  const cx = -pk / (pk + 1), cy = pa / (pk + 1);             // peak-slip normalisers
  const nx = sx / cx, ny = sy / cy;
  let sMag = Math.hypot(sx, sy), rho = Math.hypot(nx, ny);   // rho = normalised combined slip
  let kEq = rho * pk / (pk + 1); kEq = kEq / (kEq + 1);      // equivalent pure slip ratio (>= 0)
  const aEq = Math.atan(sy > 0 ? cy * rho : -cy * rho);      // equivalent pure slip angle
  const mult = deep && p.useSideFriction ? p.sideFrictionFactor : 1;   // 1.4 on DEEP surfaces
  const B_lat = Math.max(1, (1.75 - Fz * 1e-4) * wp.latPosK + 5);
  const B_lon = Math.max(1, (1.75 - Fz * 1e-4) * wp.longPosK + 5);
  const lat = Fz > 0 ? (1 - Math.exp(-B_lat * Math.abs(aEq)) - Math.abs(aEq) * wp.latNegK) * Dy : 0;
  const lon = Fz > 0 ? Math.max(0, (1 - Math.exp(-B_lon * kEq) - kEq * wp.longNegK) * Dx) : 0;
  const Fy0 = mult * muFz * lat, Fx0 = muFz * lon;           // pure-slip forces
  const rc = Math.min(rho, 1);
  if (sMag === 0) sMag = 1e-4; if (rho === 0) rho = 1e-4;
  let Fx = (-sx / sMag) * (Fx0 - (Fx0 - Fy0) * (ny / rho) ** 2 * rc);  // force opposes the slip direction,
  const Fy = (sy / sMag) * (Fy0 - (Fy0 - Fx0) * (nx / rho) ** 2 * rc); // magnitude blends Fx0..Fy0 by direction
  if (neg) Fx = -Fx;
  let Mz = Fz < 0 ? 0 : -sgn(aEq) * aEq * aEq * Fz * 0.5 * wp.alignMomScale;
  if (Fy0 !== 0) Mz *= Math.abs(Fy) / Fy0;
  return { Fx, Fy, Mz, aEq };
}
```
Curve meaning [V]: `PosK` sets how fast the exponential saturates (decreasing with load). `NegK` is a linear
term at every slip; its visible effect is the fall-off after the peak. With shipped values (LatPosK 5.0,
LatNegK 0.054) at 3700 N (Dy 1.030, B 11.9) the lateral function rises with a 4.8° time constant (0.645 at
4.8°, 0.96 at 14°), peaks at 1.00 (exactly μ·Fz) near 26° and is still 0.94 at 90°: slides are flat-topped
and forgiving. Pure longitudinal slip maps to `kEq = k/(1+2k)`, so a locked wheel (κ = -1) still produces
μ·Fz of braking force (0.9999).

`LOAD_TABLE` is precomputed from the shipped Pos/Neg K values [I, arithmetic checked on all 20 rows to
< 7e-5]: `Palpha` and `Pkappa` are the peak locations of the lateral and longitudinal curves, and `Dy`, `Dx`
are the reciprocals of their peak values. That is why the peak is exactly μ·Fz at every load. If `latPosK`,
`latNegK`, `longPosK` or `longNegK` are tuned (§6), rebuild the table the same way:
`B = max(1, (1.75 - 1e-4·Fz)·PosK + 5)`, `peak = ln(B/NegK)/B`, `D = 1/(1 - NegK/B - peak·NegK)`.
Otherwise the peak no longer equals μ·Fz.

### 2.7 After the wheel loop: throttle ramp, body friction damping, anti-roll [V FUN_006caab0]

```ts
S.thrRamp = S.thr > 0 ? Math.min(2.25, S.thrRamp + 2.25 * dt) : 0;

if (p.useBodyFrictionDamping) {
  const vmag = len(B.vL), vhat = vmag > 0 ? scale(B.vL, 1 / vmag) : {x: 0, y: 0, z: 0};
  let F: V3 | null = null;
  if (S.nContacts === 0 && B.bodyOnGround) {                     // sliding on the chassis
    F = scale(vhat, vmag * 0.25 * p.bodyContactFactor * B.Fext.y);
  } else if (S.nContacts > 0) {                                  // bogging on DEEP surfaces
    let sumDiff = 0, K = 0;
    for (const w of W) if (w.contact && DEEP.has(w.surface)) {
      sumDiff += tyreTable(w.surface, p.tyreType).diffRollK; K += 0.5 * p.wheelContactFactor;
    }
    F = scale(vhat, (sumDiff / S.nContacts) * vmag * K * B.Fext.y);  // Fext.y < 0 -> opposes motion
  }
  if (F) { Facc = add(Facc, F); const at = {x: 0, y: (hull[0].y + hull[3].y) / 2, z: 0}; Tacc = add(Tacc, cross(at, F)); }
}
// v1.5 [V 0x6cd7ec-0x6cdbff, R]: post-finish TRACK BRAKING, while phys+0x44 is set (the player state machine
// FUN_004b3790 sets it in state 4, the race is over): the same shape at the same point,
//   F = factor · (S.speedKmh / 240 · 0.125 + 0.15) · B.Fext.y · B.vL,   factor = Physics.bodyBrakingFactorForTrack
// (Play.con: 0.4 on every stage, 0.1 on hillclimb3cf; CarPhysicsParamManager vtbl+0x3c). rally-web: CarSim.setTrackBraking(factor).
// The race controller (src/game/race.ts finish) calls CarSim.setTrackBraking(stage.trackBraking) at the finish
// (ICarSim.setTrackBraking, on the contract): the ported stage's Physics.bodyBrakingFactorForTrack (Play.con, the
// stage data BODY_BRAKING); car.reset clears it; procedural stages carry no factor (no drag).
// The one-shot drag of phys+0x28 (0x6cd3d9, same shape × phys+0x2c × 0.85, then cleared at 0x6cd7e8) is the BUSH drag
// (finding 2026-10-30): phys+0x28 is the collision record's bush flag (car vt+0x178 = 0x5d9750 returns car+8 = phys), set
// with phys+0x2c = the soft object's collisionElasticConstant (template+0x58, 0 < x < 1; the bushes ship 0.6) by the
// object pass FUN_004a7bc0 (0x4a86b5 / 0x4a86b8) while the car centre is within 2 m of a bush and inside its box. The
// flag is exported as CarTelemetry.collision.bush (the bush sound, sound.md §7); the drag itself is not ported yet.
// Example (bogging): 4 wheels on deep gravel: decel = 1.3 x 0.00625 x 12 x |v| = 0.0975·|v| m/s² (2.2 m/s² at 80 km/h).

// anti-roll: pure body roll torque per axle [V asm 0x6cdcd0-0x6cdd9b]
const x = (i: number) => W[i].mount.x, SL = p.springLength;
Tacc.z += 0.5 * (p.wheel[0].rollStiffness + p.wheel[1].rollStiffness) *
          ((W[0].ext - W[1].ext) * SL * 2 * (W[0].ny + W[1].ny)) / (x(1) - x(0));
Tacc.z += 0.5 * (p.wheel[2].rollStiffness + p.wheel[3].rollStiffness) *
          ((W[3].ext - W[2].ext) * SL * 2 * (W[3].ny + W[2].ny)) / (x(2) - x(3));
// (+ torque about z lifts the right side). Effective roll stiffness ≈ 4·RollStiffness N·m/rad per axle.
```

### 2.8 Yaw caps [V FUN_006caab0 tail]

```ts
if (S.nContacts >= 2) {
  const lim = ((2.75 - s) - Math.abs(beta)) * p.twMaxMom * B.I.y;      // yaw torque cap, always > 0:
  // beta uses atan (|beta| < π/2), so lim ≥ (1.75 - π/2)·TWMaxMom·Iyy = 0.179·TWMaxMom·Iyy ≈ 1.02 rad/s²·Iyy
  // (s = 1, |beta| → 90°). A reversing car reads beta ≈ 0. (DEV-2 withdrawn: the negative case is unreachable.)
  Tacc.y = Math.min(Tacc.y, lim); Tacc.y = Math.max(Tacc.y, -lim);     // (this order, as the original)
  const limL = B.I.y * ((2 - s) * p.twMomLimStart + Math.abs(beta) * p.twMomLimScale);
  B.L.y = clamp(B.L.y, -limL, limL);   // yaw RATE cap = TWMomLimStart·(2-s) + TWMomLimScale·|beta| rad/s
}
// shipped: yaw rate ≤ 1.12 + 1.51·|beta| rad/s above 75 km/h, ≤ 2.25 + 1.51·|beta| below 25 km/h;
// yaw accel ≤ (1.75 - |beta|) x 5.70 rad/s² above 75 km/h.
```

### 2.9 Chassis-ground collision [V FUN_006cea90 tail, FUN_006d0970; R v1.5]

v1.5: the original's chassis contact is ported literally (DEV-4 withdrawn). It has two halves: the HULL PROBES at the
end of the wheel-ray function (B4, before the suspension), which reduce up to four hull contacts to ONE contact
(point, push direction, depth, material), and the BODY SOLVER FUN_006d0970 (B10), which resolves that contact with
a push-out, a normal impulse and an "anchor" friction impulse. The Ghidra pseudo-code of FUN_006d0970 is broken by
x87 stack aliasing; the port follows the disassembly (0x6d0970-0x6d1a7b).

Hull: the first `car_NColPoints` = 12 points of the car's `car_ColPointFile` (`Misc/object/Car_<Name>.col`, body frame,
origin = COM; 0-3 bottom corners FL FR RR RL, 4-7 belt-line corners, 8-11 roof; §3.4). Car state: `mask` (phys+0x9c),
`recent` / `quiet` (phys+0x94 / +0x98), `corner[4]` (phys+0xa8..0xb4, 1 = intact; the original raises a corner to 4
outside the physics step, source not traced; rally-web keeps 1), parity (phys+0x90, §2.5.0), `carIndex` (phys+0xa4).

```ts
// ---- B4b hull probes (after the wheel rays; nWheel = wheels with contact) [V FUN_006cea90 0x6ceda6-0x6cf5f3]
const turn = S.stepParity === carIndex >> 1;
const nPts = nWheel < 3 ? 12 : 8;
const belt = nWheel < 3 ? 0b1111 : corner.map((c, k) => (c >= 2 ? 1 << k : 0)).reduce((a, b) => a | b, 0);
if (turn) mask = 0;
let count = 0, nBottom = 0, nUpper = 0, minMat = 0x3f, sum = {x: 0, y: 0, z: 0}, sumD = 0, any = false, flags = 0;
for (let i = 0; i < nPts; i++) {
  if (i >= 4 && !turn && !(mask & (1 << i))) continue;          // 4-11 only on the car's turn or if they hit last time
  if (i >= 4 && i < 8 && !(belt & (1 << (i - 4)))) continue;    // belt points: < 3 wheels, or a raised corner
  const P = add(B.pos, toWorld(hull[i]));                       // this step's pose
  const h = terrain.segment(B.prevPos, sub(P, B.prevPos), 8 + i + 24 * carIndex);  // FROM the previous step's COM (B+0xd8)
  if (!h) continue;
  mask |= 1 << i; any = true;
  const mat = h.origMaterial;                                   // raw byte; 255 = the original's −1
  if (mat === 255 || !(h.depth < 0.01) || count >= 4) continue; // (depth ≤ 0 on every hit)
  if (mat > 23) flags |= 0x80;                                  // non-ground solid
  minMat = Math.min(minMat, mat);
  if (mat === 0x23) { flags |= 0x100; continue; }               // special material: flag only (never in a Track.gcm)
  sum = add(sum, scale(h.normal, -h.depth)); sumD -= h.depth; idx[count] = i; dep[count] = h.depth; count++;
  if (i < 4) nBottom++; else nUpper++;
}
if (any) { quiet = 0; recent = true; } else if (quiet > 4) recent = false; else { quiet++; recent = true; }
B.bodyOnGround = false;                                         // CP+0x34
if (count >= 1 && len(sum) !== 0) {
  B.bodyOnGround = true; flags |= 1;
  let c = {x: 0, y: 0, z: 0};
  for (let k = 0; k < count; k++) c = add(c, scale(hull[idx[k]], -dep[k] / sumD));   // depth-weighted contact point
  if (flags & 0x80 && c.y > 0) c.y *= 0.2;
  B.hullPt = c;                                                 // B+0x160 (body frame)
  B.hullDir = normalize(sum);                                   // B+0x148 (world)
  B.hullDepth = -sumD / count;                                  // B+0x13c, mean depth (≤ 0)
  B.hullMat = minMat;                                           // B+0x144
  if (nUpper < nBottom) flags |= 0x40;
}
B.flags = flags;   // the original keeps its other B+4 bits (2..0x20: belt flags, 0x200); no physics reads them

// ---- B10 body solver, on the car's turn or while `recent` [V FUN_006d0970; call site 0x6cde02]
function bodySolver(dt) {
  B.T += dt;                                                    // B+0x134 anchor timer
  if (!(B.flags & 1)) return;
  const sf = bodyColumns(B.hullMat);  // BodyK, BodyKScale, MaxDepth, Epsilon: §4.4 row; 23 = DUMMY row; > 23 → all 1.0
  const c = B.hullPt, d = B.hullDepth; let n = {...B.hullDir};
  const vP = add(B.vW, toWorld(cross(B.w, c)));                 // contact velocity with the LAGGED ω (B+0x44)
  if (B.hullMat > 23 && n.y > 0) n.y = 0;                       // solids never push up
  let k;                                                        // 1. push-out beyond the surface's MaxDepth
  if (-d < sf.maxDepth) k = sf.maxDepth === 0 ? 0 : -d / sf.maxDepth;
  else { B.pos = add(B.pos, scale(n, Math.min(0.5, -(sf.maxDepth + d)))); k = 1; }
  const vn = Math.min(0, dot(vP, n) * sf.bodyKScale);           // 2. normal impulse
  const nB = toLocal(n), X = mul(cross(c, nB), B.invI);         //    |(I⁻¹(c×n))×c · n| + 1/m
  let jn = -sf.epsilon * vn * k / (Math.abs(dot(cross(X, c), nB)) + B.invMass);
  let Jt = {x: 0, y: 0, z: 0};                                  // 3. anchor friction
  if (B.T >= 0.2) B.T = 0;
  else if (dot(n, B.prevN) > 0.8) {                             //    the contact continues the last one
    const m = scale(add(c, B.prevC), 0.5);                      //    midpoint of this and the last contact (body)
    const pPrev = add(B.prevPos, mulRows(m, B.prevR)), r = toWorld(m);
    const D = sub(scale(sub(pPrev, add(r, B.pos)), 1 / (B.T + 0.001)), vP);   // velocity that returns it there
    const cosRN = dot(normalize(r), n);
    Jt = D;                                                     //    (the raw D, ≈ D/m: ≤ 1 mm/s; asm 0x6d11d9)
    if (cosRN < -0.4 && dot(D, D) !== 0) {                      //    contact below the COM
      const N = Math.max(0, -dot(n, B.Fext) * B.bodyShare);     //    the body's weight share along n (§2.5.5)
      let sR = -dot(B.right, n); if (c.x < 0) sR = -sR; sR = Math.max(0, sR);
      let tip = (1 - Math.abs(n.y)) * sR * sR * 26.640649795532227 * B.mass;   // side-tip term
      if (Math.abs(B.vL.z) < 16) tip *= Math.abs(B.vL.z) / 64;
      Jt = scale(normalize(D), -cosRN * (tip + N) * sf.bodyK * B.T);  // Coulomb, accumulated over T
      B.T = 0;
      if (B.hullMat >= 0x20 && Jt.y > 0) Jt.y = 0;
      B.L = add(B.L, toLocal(cross(r, Jt)));
    }
  }
  B.prevN = n; B.prevC = c; B.prevPos = B.pos; B.prevR = [B.right, B.up, B.fwd];   // B+0x154 / 0x16c / 0x114 / 0xe4
  jn = Math.min(10000, Math.max(0, jn));                        // (impact = jn before the cap: effects / damage)
  const Jn = scale(n, jn);
  if (B.vW.y <= 0 || Jn.y <= 0) Jn.y = Math.min(Jn.y, 8000);
  else if (B.flags & 0x80) Jn.y = Math.min(500, Jn.y * clamp((2 - B.vW.y) / 2, 0, 1));
  B.L = add(B.L, cross(c, toLocal(Jn)));
  B.vW = add(B.vW, scale(add(Jn, Jt), B.invMass));
}
```
Not ported: the material-0x23 branch at the top of FUN_006d0970 (body flag 0x100: a speed-proportional drag and a
splash point; no collision data produces 0x23) and the impact-effect outputs B+0x190..0x1d0 (spark / scrape trigger,
contact type 0/1/2, contact points; the effects / audio side). Car-car and object contacts are handled outside the
physics step in the original (FUN_004a7980, §8 #10). Static objects (ported 2026-10-30, `CarSim.objectPass`,
docs/orig/collision.md §4): after each substep the object pass FUN_004a7bc0 gates each candidate (a TreeMesh:
|origin − car centre| ≤ 0.2·radius + 1.5; any other object: |centre − car centre| ≤ radius + car radius; then the
render box against the car box), FUN_006d1a80 sends EVERY hull point's segment (previous COM →
point) through the object's own CollisionMesh.Simple (query 0x597810), accumulates the contacts exactly as above
(material = collisionMaterial when 0..22, else 1) and calls **FUN_006d21c0** = this solver with its own anchor timer
B+0x138 (shared anchor memory) and the friction impulse clamped to ±1000 per component before vW [V executed:
tests/sim/fixtures/bodySolverObjCases.json]. Worlds without object meshes (procedural, RCOL v1) keep the [D]
obstacle cylinders. Car-car (FUN_006d4390) and the loose parts are not ported.

Verification (v1.5):
* [V, executed] `research/frida/emu_body.py` RUNS the original FUN_006d0970 (x87, in unicorn over the exe image; the
  surface getter stubbed with the PhysicsParam.con rows) on 3,000 random body states (all materials 0-63, push-out
  and impulse regimes, anchor fired / expired / rejected, flags 0x40 / 0x80 / 0x200): rally-web's port agrees on every
  written state to float32 (|ΔvW| ≤ 1.5e-5 relative, |ΔL| ≤ 1.5e-5 relative, |Δpos| ≤ 7.7e-6 m, anchor timer and
  memory exact). 120 of the cases are a unit test (tests/sim/fixtures/bodySolverCases.json).
* [R] On the original Track.gcm with the cars' own Car_<Name>.col hulls, the 6 recorded body-ground contact steps of
  run 2 (AI cars Micra / Corolla on two wheels at 35 km/h, AI friction mode, §4.2): the hull accumulation (depth,
  material, push direction, contact point) equals the original's exactly, and the whole step (probes, tyre loads with
  `nb`, solver) reproduces the original's velocity change to |Δv| ≤ 2.7e-5 m/s of 0.17-0.22 m/s and the angular
  momentum change to ≤ 0.03 of 9-257 N·m·s. The anchor-friction branch is covered only by the executed cases (the
  recorded contacts had T ≥ 0.2).

Behaviour [M]: on its roof (awd box hull, gravel) the car comes to rest at the roof height and keeps a period-2
rock of |ω| ≈ 0.09 rad/s (the impulse uses the lagged ω; ≈ 0.04° per step, invisible); sliding on the roof it
decelerates at ≈ 1.2 g on gravel (the anchor impulse BodyK·T·N every ≤ 0.2 s ≈ BodyK·12 m/s², plus the 2 m/s²
free-flight damping, §2.10). v1.3's note that the hull touches flat tarmac in 100 km/h full-lock handbrake slides
no longer applies: with the corrected ride height (+2.5 cm, §2.5.3) and the original's probe schedule (only the
bottom corners while ≥ 3 wheels touch) no hull contact occurs in them (tarmac and gravel, all archetypes, 0 of
≈ 1,000 steps each).

### 2.10 Air gravity multiplier, integration, free flight, sleep [V FUN_006caab0 tail]

```ts
// air gravity multiplier (ramps per STEP)
if (S.speedKmh <= 10) B.airMul = 1;
else if (S.nContacts < 3) B.airMul = Math.min(1.45, B.airMul * 1.065);      // reaches 1.45 in 6 steps (50 ms)
else if (Math.abs(dot(B.fwd, {x: 0, y: 1, z: 0})) <= 0.25) B.airMul = 1;    // back on the ground, roughly level
// integration (symplectic Euler, one-step angular lag)
const Fworld = add(toWorld(Facc), scale(B.Fext, B.airMul));                  // gravity AND aero scaled in the air
B.vW = add(B.vW, scale(Fworld, B.invMass * dt));
B.w = {x: B.invI.x * B.L.x, y: B.invI.y * B.L.y, z: B.invI.z * B.L.z};     // ω from L BEFORE adding torque
B.L = add(B.L, scale(Tacc, dt));
// free flight: no wheel touches
if (S.nContacts === 0) {
  for (const ax of ['x', 'y', 'z']) {
    B.L[ax] = towardZero(B.L[ax], B.I[ax] * dt);   // -1 rad/s² on every body axis; no air control
    B.vW[ax] = towardZero(B.vW[ax], 2 * dt);       // -2 m/s² on every WORLD axis, vertical included
  }
}
// sleep (snap to rest)
const pedals = assist.sleepPedalThreshold                                       // DEV-6 (off)
  ? S.thr > p.throttleMinLimit || S.brk > p.brakeMinLimit
  : S.thr !== 0 || S.brk !== 0;                                                 // original [V]: ANY non-zero pedal
const springCap = assist.heavyCarSleep                                          // DEV-7 (off)
  ? Math.max(4500, 1.25 * GRAVITY * B.mass * Math.max(p.frontShare2, 2 - p.frontShare2) / 4)
  : 4500;                                                                       // original [V]
const hardSpring = W.some(w => w.Fsusp > springCap);
if (dot(B.vW, B.vW) < 0.1 && dot(B.w, B.w) < 0.1 && S.nContacts >= 3 && !hardSpring && (!pedals || S.parked)) {
  B.vW = {x: 0, y: 0, z: 0}; B.L.y = 0; for (const w of W) w.omega = 0;
}
// towardZero(v, d) = v > 0 ? Math.max(0, v - d) : Math.min(0, v + d)
```
In the air the downforce stays on (it depends only on forward speed) and is scaled by `airMul` along with
gravity. With `q = AirKZY·v_fwd²/m`, the car decelerates upward at `1.45·(12 + q) + 2` m/s² and falls at
`1.45·(12 + q) - 2` m/s²: about 20.5 / 16.5 m/s² at 100 km/h and 20.8 / 16.8 at 110 km/h (awd_wrc).
Pitch/roll/yaw rates decay at 1 rad/s².

Sleep notes [V rule, M effects]:
* Sleep is the only mechanism that brings a car to rest (see the low-speed notes after §2.6). Any non-zero
  pedal disables it in the original, so rally-web applies a small analog pedal dead zone (§5.1, [D]).
* `hardSpring` blocks sleep for cars heavier than about 1440 kg with shipped springs (awd geometry: static
  front spring force ≈ 3.13·m N per wheel). Such cars jitter at standstill: at 1540 kg, the original's heaviest
  car, |v| reaches 0.29 m/s, with 0.14 m of drift in 5 s and 0.28° of pitch shimmer. This is original
  behaviour; DEV-7 removes it.
* The window `|v|² < 0.1` assumes 120 Hz (§1.2).

### 2.11 Arcade assists summary (all part of the model) [V unless noted]

| # | Assist | Formula | Section |
|---|---|---|---|
| 1 | Steering-proportional yaw torque, grip | `s·μ·Iyy·TWStaSteer·δ·sign(vz)` per front wheel | 2.6 W13 |
| 2 | Yaw friction, grip | `-s·μ·Iyy·TWStaMy·sign(L_y)` per wheel (all four) | 2.6 W13 |
| 3 | Steering-proportional yaw torque, slide | `s·(\|β\|+0.25)·μ·Iyy·TWKinSteer·δ·sign(vz)` per front wheel; yaw friction removed | 2.6 W13 |
| 4 | Yaw torque cap | `((2.75-s)-\|β\|)·TWMaxMom·Iyy` | 2.8 |
| 5 | Yaw rate cap | `(2-s)·TWMomLimStart + \|β\|·TWMomLimScale` | 2.8 |
| 6 | Drift grip bonus | μ × (1 + 0.2·\|β\|·throttle) above \|β\| 0.125 | 2.6 W10 |
| 7 | Big-angle grip bonus | μ × (1 + 0.3·(\|β\|-0.75)) above 0.75 rad (DEV-1) | 2.6 W10 |
| 8 | Side fill | `sign(Fy)·min(1,\|β\|+0.25)·min(μFz-\|Fy\|, 10000)` on body x | 2.6 W18 |
| 9 | Drift drive boost | `0.5·Fx·\|β\|·s` on body z (and loads the wheel) | 2.6 W16 |
| 10 | Deep-surface lateral factor | Fy0 × SideFrictionFactor (1.4) on DEEP surfaces | 2.6.1 |
| 11 | Launch multiplier | wheel spin-up ×(up to 4-5) in R/1st | 2.6 W1 |
| 12 | Low-rpm fill + SpinTorque | R/1/2 and R/1 torque bonuses | 2.3.2 |
| 13 | Wheelspin limiter | slide mode below 25 km/h | 2.6 W15 |
| 14 | ABS / traction control | ABS on (κ ≥ 0.75), TCS off | 2.3.4, 2.3.6 |
| 15 | Hill-hold | EngineBrakeConstant on wheels rolling the wrong way | 2.3.5 |
| 16 | Anti-pogo | spring force cap when leaving the ground | 2.5.3 |
| 17 | Air gravity ×1.45 and air damping | | 2.10 |
| 18 | Flip assist | throttle rolls a stopped, overturned car | 2.6 W19 |
| 19 | Sleep | | 2.10 |
| 20 | Weak load transfer | MomentXDist/MomentZDist gains | 2.5.5 |
| 21 | Extra low-speed steering lock | +0.005 rad per km/h below 40 | 2.1 |
| 22 | Deep-surface bogging drag | BodyFrictionDamping | 2.7 |

---------------------------------------------------------------------------------------------------

## 3. Parameter sets

All 29 cars in the original share every tyre, suspension, brake, assist, rpm and shift parameter [V: every
`PhysicsCar.con`, `PhysicsWheelFront.con`, `PhysicsWheelRear.con` diffed]. Only mass, torque scale, gear count
and ratios, turbo flag, drive layout, wheel positions and hull differ. rally-web keeps that structure: §3.1 is
shared by every car, §3.2 defines the three archetypes. The values are the original's shipped configuration
(not the template-constructor defaults, which differ; see §3.6).

Units: the original's values are already SI except where the "SI meaning" column says otherwise.

"conf V" in the tables below refers to the shipped value and to the arithmetic that uses it. Which config
name feeds which runtime offset is [I]: the `wheel_*`/`car_*` string order, the template-to-runtime copy
order (FUN_0074f0b0) and the way the code uses each offset all agree, but the binding itself was not read.
Examples: wheel offsets 0xe0-0x138 in string order, 0xe8 = WheelBasePos.z, 0x118/0x11c = StaticSlipAngle
Fast/Slow, 0x12c/0x134 = LatPosK/LatNegK, 0x130/0x138 = LongPosK/LongNegK; car offsets 0x128/0x12c =
UseSideFriction/SideFrictionFactor, 0x6d/0x70 = UseSpinTorque/SpinTorqueScaleValue.

### 3.1 Shared car parameters

| rally-web key | original name | value | SI meaning / conversion | conf |
|---|---|---|---|---|
| `airKZY` | car_AirKZY | 1.25 | downforce coeff, kg/m: `F = 1.25·v_fwd²` N along body up | V |
| `airKZZ` | car_AirKZZ | 2.0 | drag coeff, kg/m, per WORLD axis: `F_i = -2.0·\|v_i\|·v_i` | V |
| `inertia` | car_Inertia | (1.25, 1.45, 0.50) | per-kg inertia, m²: `I = inertia·mass` kg·m² about (x pitch, y yaw, z roll) | V |
| `wheelRadius` | car_WheelRadius | 0.30 | m | V |
| `finalDrive` | car_WheelRatio | 5.6 | final drive; affects rpm only | V |
| `wheelScale` | car_WheelScale | 0.40 | max steer angle, rad (22.9°), +0.005 rad per km/h below 40 (0.6 rad at rest) | V |
| `torqueScaleFactor` | car_TorqueScaleFactor | 1.0 | multiplies the curve | V |
| `minRpm` / `cutRpm` / `maxRpm` | car_MinRPM / CutRPM / MaxRPM | 1000 / 8250 / 8750 | idle / limiter / display clamp, rpm | V |
| `maxTorqueRpm` / `maxTurboTorqueRpm` | car_MaxTorqueRPM / MaxTurboTorqueRPM | 6500 / 6750 | only used for auto-shift speeds | V |
| `minRpmGearChange` | car_MinRPMGearChange | 4000 | auto coast-downshift needs rpm below this | V |
| `turboIdle` / `turboWasteGate` / `turboSpinup` | car_TurboIdle / TurboWasteGate / TurboSpinup | 0.1 / 100 / 1.0 | boost range; per-step growth `1 + thr/(40·spinup)` | V |
| `brakeTorque` | car_BrakeTorque | 4000 | N·m per wheel before balance | V |
| `brakeBalance` | carsetup_BrakeBalance | 1.25 | front factor; rear = 2 - 1.25 = 0.75 → 5000 / 3000 N·m per wheel | V |
| `brakeMinLimit` | car_BrakeMinLimit | 0.1 | pedal dead zone for brake and handbrake | V |
| `handBrakeTorque` | car_HandBrakeTorque | 3500 | N·m; ×0.3 front (1050), ×1.3 rear (4550) per wheel | V |
| `useAbs` / `absFactor` | car_UseAbsSystem / AbsSystemFactor | true / 0.75 | ABS releases a wheel when slip ratio ≥ 0.75 (pedal ≥ 0.75 only) | V |
| `useAntiSpin` / `antiSpinFactor` | car_UseAntiSpinSystem / AntiSpinFactor | false / 8 | traction control (off) | V |
| `timeChangeGear` / `timeChangeGearFR` | car_TimeChangeGear / TimeChangeGearFR | 0.10 / 0.15 | s (×1.5 in auto) | V |
| `downGearFactor` | car_GearStatusDownGearFactor | 0.775 | | V |
| `throttleMinLimit` | car_ThrottleMinLimit | 0.1 | below: engine-braking branch | V |
| `useEngineBrakeConstant` / `engineBrakeConstant` | car_UseEngineBrakeConstant / EngineBrakeConstant | true / 4000 | N·m hill-hold / stall / park brake | V |
| `useSpinTorque` / `spinTorqueScaleValue` | car_UseSpinTorque / SpinTorqueScaleValue | true / 10 | launch torque bonus in R/1st (NOT a yaw assist) | V |
| `useSpinTorqueDamping` / `spinTorqueDampingValue` | car_UseSpinTorqueDamping / ...Value | false / 1 | | V |
| `useBodyFrictionDamping` | car_UseBodyFrictionDamping | true | | V |
| `wheelContactFactor` | car_BodyFrictionDampingWheelContactFactor | 0.003125 | deep-surface drag gain | V |
| `bodyContactFactor` | car_BodyFrictionDampingBodyContactFactor | 0.05 | chassis-sliding drag gain | V |
| `useSideFriction` / `sideFrictionFactor` | car_UseSideFriction / SideFrictionFactor | true / 1.4 | lateral force ×1.4 on DEEP surfaces | V |
| `twMaxMom` | car_TWMaxMom | 5.7039 | yaw-accel cap gain, rad/s² | V |
| `twMomLimStart` | car_TWMomLimStart | 1.1242 | yaw-rate cap base, rad/s | V |
| `twMomLimScale` | car_TWMomLimScale | 1.5147 | yaw-rate cap per rad of body slip, 1/s | V |
| `rollLevel` | car_RollLevel | 0 | selects DiffRollK weight in rolling resistance | V |
| `transmission` | car_TransmissionType | auto (0) | 0 auto, else manual | V |
| `useGearSpeedValues` | car_UseGearSpeedValues | false | explicit shift speeds unused | V |
| (unused) | car_FrictionLevel 0, car_RollCenterY 0.15, car_ThrottleTime 0.5, car_WheelWidth 0.2, toe/camber indices | | no reader in the physics step | V (no reader) / I |

Wheel parameters (front / rear; identical left/right):

| rally-web key | original name | front / rear | SI meaning / conversion | conf |
|---|---|---|---|---|
| `springK` | wheel_SpringK | 35000 / 35000 | N/m, progressive: `F = K·c·(1 + 0.5·c/SL)` (c = compression m) | V |
| `dampK` | wheel_DampK | 5000 / 5000 | N·s/m, ×(1 + compression fraction), capped 60000 N | V |
| `springLength` | wheel_SpringLength | 0.75 / 0.75 | m, ray length = full travel | V |
| `rollStiffness` | wheel_RollStiffness | 14200 / 15000 | anti-roll gain; ≈ 4×value N·m/rad per axle | V |
| `rollK` | wheel_RollK | 1.00596 / 1.00596 | N·m per rad/s drag on DRIVEN wheels | V |
| `wheelInertia` | wheel_WheelInertia | 0.050027 / 0.050027 | **inverse** spin inertia, 1/(kg·m²); equivalent inertia 19.99 kg·m². 4 wheels × 20 kg·m² / 0.3² ≈ 890 kg of equivalent mass on drive, engine-braking and rolling-resistance effects: it roughly halves coast and engine-braking deceleration compared with a light wheel. Do not "fix" it to 1/0.05. | V |
| `momentXDist` | wheel_MomentXDist | 0.060145 / same | lateral load-transfer gain, 1/m (N of load per N·m of roll moment) | V |
| `momentZDist` | wheel_MomentZDist | 0.080006 / same | longitudinal load-transfer gain, 1/m | V |
| `twStaSteer` | wheel_TWStaSteer | 2.2428 / (unused rear) | grip-mode steering yaw gain: yaw accel `= s·μ·2.2428·δ` rad/s² per front wheel | V |
| `twKinSteer` | wheel_TWKinSteer | 1.7045 / (unused rear) | slide-mode steering yaw gain | V |
| `twStaMy` | wheel_TWStaMy | 0.418 / 0.418 | grip-mode yaw friction: `s·μ·0.418` rad/s² per gripping wheel | V |
| `staticSlipAngleFast` | wheel_StaticSlipAngleFast | 0.12 / 0.06 | rad per 2048 N of load; grip→slide at `\|α\| > SSA·Fz/2048` (at 3700 N: 12.4° / 6.2°) | V |
| `staticSlipAngleSlow` | wheel_StaticSlipAngleSlow | 0.08 / 0.10 | same, "steering = 0" setup option (8.3° / 10.4° at 3700 N) | V |
| `steerTweak` | wheel_SteerTweak | 0.05 / 0.05 | kingpin (scrub) offset of the front contact point, m | V |
| `tireRelaxK` | wheel_TireRelaxK | 1.60723 / same | 1/m; relaxation length 0.622 m | V |
| `alignMomScale` | wheel_AlignMomScale | 0.126552 / same | m; aligning moment `0.5·AMS·Fz·α²` | V |
| `latPosK` / `latNegK` | wheel_LatPosK / LatNegK | 5.00238 / 0.053606 | lateral curve rise gain / post-peak slope per rad | V |
| `longPosK` / `longNegK` | wheel_LongPosK / LongNegK | 5.39649 / 0.176533 | longitudinal rise gain / post-peak slope per unit slip | V |
| `otherAxleZ` | wheel_WheelBasePos (z) | z of the same-side wheel on the other axle | defines the Ackermann turning-centre line | V (config), I (meaning) |

Setup and upgrade defaults (all 1.0 unless noted): `setup.brake`, `setup.powerRatio`, `setup.suspension`,
`setup.gearRatio` (m), `setup.awdBaseSplit` (1.0, [G]: initialiser not found), `steerSensFast = true`
(constructor default [V 0x6c4655]); `upgrade.engine`, `upgrade.weight` (× mass), `upgrade.brakes`,
`upgrade.handling` (× static slip angle). The original defines upgrade levels engine 1/1.1/1.2, weight
1/0.9/0.8, brakes 1/1.1/1.2, handling 1/2/4 but ships no UI for them [V config, I usage].

### 3.2 Archetype cars

Derived from the distribution of the original's 29 cars (ids and labels are ours; no real car names):
* `awd_wrc` = the four modern 4WD "pro rally" cars: mass 1230 (all), torqueScale median 935 (range 920-950),
  shared gears; wheel z positions are the per-axis MEAN (FL z 1.2085 → 1.21, RL z -1.319 → -1.32), x is the
  median (-0.755 / -0.760), y ≈ 0.53. (A true median z, 1.24 / -1.3085, would give frontShare2 1.027.)
* `fwd_hatch` = mean of the two FWD cars (mass 960 kg, torque scale 890-970).
* `rwd_classic` = the RWD car, cross-checked against the Group-B-class medians (mass 910-1298 kg, torque scale 1300-1375).

v1.3 [V config, M effect]: `awd_wrc` models the 4WD class with the LOWEST power-to-weight. The class table at
0x847928 (read by FUN_00488590 as `switch(slot/6)`) puts only 4 of the 26 AWD cars in class 0 (TorqueScale/Mass
0.75-0.77 N·m/kg); the other 22 are in classes 1-5: class 1 is just as weak (0.73-0.95), class 2 ≈ 1.05, class 3
0.81-0.98, class 4 (the 1980s high-power cars) 1.06-1.84, class 5 (unlimited hill climb) 1.17-1.88. All 29 cars
share every other handling parameter, so the only car-specific drift levers are mass, torque, gears, turbo, drive
layout and wheel positions. In the model, the holdable slip angle grows with power-to-weight and with the front
axle share: at a 30° target (v1.2 P-D probe) awd_wrc holds 20.4° against ≈ 24° for 57-60 %-front light cars; with
the §7 counter-steer probe on gravel awd_wrc holds up to 40° at steer +0.68 (30°), the class-4 medians up to 45° at
+0.51. The class-0 per-axis MEDIAN geometry (FL z 1.24, RL z -1.3085, frontShare2 1.027) is noted above; do NOT bias
awd_wrc toward its single front-heavy car (58.7 % front), that would be cherry-picking. The class-4 4WD medians
(five cars: mass 1030 kg, TorqueScale 1340, 5 gears -3.3 / 3.42 / 2.15 / 1.52 / 1.17 / 0.75, TurboSize 1 (one car
has 0), FL (-0.698, 0.56, 1.077), RL (-0.750, 0.56, -1.323): wheelbase 2.40 m, 55.1 % front; hull ±2.0 m from the
collision-point files) are available as the non-default preset "orig: class-4 AWD car" (§6.1).

| key | awd_wrc | fwd_hatch | rwd_classic | units / notes |
|---|---|---|---|---|
| `mass` | 1230 | 960 | 1010 | kg (range in original 790-1540) |
| `torqueScale` | 935 | 930 | 1350 | N·m per wheel at curve = 1 (range 750-1900) |
| peak curve torque, 4 wheels, full boost | 6545 | 6510 | 9450 | N·m = 4 × torqueScale × 1.75; excludes the low-gear fill and the launch bonus |
| 1st-gear launch torque, 4 wheels, 1000 rpm, full throttle, boost idle | 21 300 | 21 190 | 30 760 | N·m = 4 × (0.195 + 0.5 + 5.0) × torqueScale (§2.3.2 worked example); before the W1 launch wheel multiplier |
| `wheelDrive` | 2 (AWD 50/50) | 0 (75 % front / 25 % rear) | 1 (37.5 % / 62.5 %) | |
| `turboSize` | 1 | 1 | 1 | 0 = no turbo (one original car) |
| `nGears` | 6 | 6 | 5 | |
| `gearRatio[0..n]` | -3.3, 3.35, 2.15, 1.55, 1.22, 0.97, 0.84 | same as awd_wrc | -3.3, 3.42, 2.15, 1.52, 1.17, 0.75 | index 0 = reverse |
| wheel FL (x, y, z) | (-0.755, 0.53, 1.21) | (-0.765, 0.57, 1.235) | (-0.655, 0.48, 1.26) | m, body frame, wheel centre ("bundle" position); FR mirrors x |
| wheel RL (x, y, z) | (-0.760, 0.53, -1.32) | (-0.765, 0.57, -1.31) | (-0.730, 0.48, -1.19) | RR mirrors x |
| `mount.y` | 0.23 | 0.27 | 0.18 | m = wheel y - wheelRadius (ray start) |
| wheelbase / track F / track R | 2.53 / 1.51 / 1.52 | 2.545 / 1.53 / 1.53 | 2.45 / 1.31 / 1.46 | m |
| `frontShare2` | 1.0435 | 1.0295 | 0.9714 | §2.5.4; front axle carries 52.2 / 51.5 / 48.6 % |
| static tyre load F / R | 3850 / 3530 | 2965 / 2795 | 2945 / 3115 | N per wheel at 12 m/s² |
| grip→slide angle F / R (Fast) | 12.9° / 5.9° | 10.0° / 4.7° | 9.9° / 5.2° | at static load |
| CG height above ground at rest | ≈ 0.446 | ≈ 0.421 | ≈ 0.508 | m, = SL − (1 − x)·SL² − mount.y with x ≈ 0.87 (v1.5, §2.5.3; v1.4: 0.42 / 0.38 / 0.47) |
| auto upshift speeds | 40.4, 62.9, 87.3, 110.9, 139.5 | same | 39.6, 62.9, 89.0, 115.6 | km/h, `135.31 / ratio` |
| speed at CutRPM per gear | 49.7, 77.5, 107.5, 136.6, 171.8, 198.4 | same | 48.7, 77.5, 109.6, 142.4, 222.2 | km/h, `166.6 / ratio` (not a hard cap) |
| hull length (front / rear of origin) | +2.07 / -2.30 | +1.95 / -2.05 | +1.80 / -1.90 | m, §3.4 |
| AI pace factor (original class factor) | 0.725 | 0.725 | 0.975 | AI only, §8 |
| model 0-100 km/h, tarmac | 4.6 s | 4.1 s | 3.2 s | §7 T1 |
| model top speed, tarmac | 210 km/h | 213 km/h | 245 km/h | §7 T2 |

### 3.3 Ratio-derived values (all archetypes)

* rpm = ω_driven · 9.549296 · ratio · 5.6. At 100 km/h (ω = 92.6 rad/s) in 4th (1.22): 6040 rpm.
* Upshift speed `= (6750 - 50) · (2π·0.30·3.6) / (5.6·60) / ratio = 135.31 / ratio` km/h.
* Coast downshift from gear g (> 2): speed < 0.95 · 0.775 · shiftSpeed[g-1] (the CURRENT gear's own upshift
  speed) and rpm < 4000; 2→1: < 0.75 · 0.775 · shiftSpeed[1] (62.9 km/h → 36.5 km/h) [V FUN_006c6c60].

### 3.4 Body hull (collision points) [V data v1.5; D for the archetypes]

The original cars use the first 12 points (`car_NColPoints 12`) of their `car_ColPointFile`
(`Misc/object/Car_<Name>.col`, research/formats/gcm.md §6): 0-3 bottom corners FL FR RR RL, 4-7 belt-line corners,
8-11 roof points, body frame with origin at the COM (e.g. Astra: x ±0.919, bottom y −0.326, belt y 0.25, roof
y 0.917, z +2.053 / −1.972). rally-web ships them as `src/sim/origHulls.ts` (generated by
`research/frida/port_hulls.py`, keyed by the ORIG_CAR_IDS name) and uses them when the CarSim is built with
`origCar` (the RaceSelection.car). Procedural archetype cars keep the generic box in the same point order:
`(±0.85, -0.33, zf)`, `(±0.85, -0.33, zr)` (FL FR RR RL order: −x front, +x front, +x rear, −x rear), the same four at
`y = 0.33`, roof `(∓0.50, 1.00, +0.12)`, `(±0.48, 1.00, -1.06)`, with zf / zr from §3.2. The chassis drags act at
`(0, (hull[0].y + hull[3].y)/2, 0)` (§2.7; `hullBottomY = -0.33` for the box). Points 12-17 of the .col files and
their quads belong to car-car / object contacts (outside the step, not ported).

### 3.5 Input, camera and gameplay constants

See §5 (all [V] unless marked).

### 3.6 Template defaults (do NOT use)

The original's constructors hold different defaults that shipped data overrides, e.g. SpringK 50000,
DampK 4200, SpringLength 0.506, SteerTweak 0.1, static slip angles 0.04, WheelScale 0.45, WheelRadius 0.318,
WheelRatio 6.1, BrakeTorque 1000, CutRPM 8000, TorqueScaleFactor 1.125, EngineBrakeConstant 5000,
GearStatusDownGearFactor 0.75, SpinTorqueScaleValue 1 (UseSpinTorque 0), AbsSystemFactor 0.25 (ABS off),
AirKZY 0.5, WheelContactFactor 0.00625 [V FUN_00753f80, FUN_0075c400]. Only the shipped values above matter.

---------------------------------------------------------------------------------------------------

## 4. Surfaces and tyres

### 4.1 Tyre types and stage defaults

| id | tyre | default for |
|---|---|---|
| 0 | tarmac | tarmac rally stages |
| 1 | intermediate | rallycross (mixed) |
| 2 | gravel | loose rally stages (their roads are SAND / MUD, §4.3), gravel hill climbs |
| 3 | snow | snowy/icy hill climbs |
| 4 | ice | ice racing |

[I] order from the manual and the per-stage `race.tyretype` defaults (tarmac stages 0, rallycross 1,
gravel stages and hill climbs 2, snowy hill climb 3, ice racing 4) [V config]. The player may override
(setup menu, §5.5).

### 4.2 Friction formulas [V FUN_006c49c0, FUN_006c4a60, FUN_006c4930]

```ts
// tyre table row = TYRE_TABLE[surface][tyreType] = [BestStatic, DiffStatic, ScaleKinetic, BestRollK, DiffRollK]
// surface row    = SURFACE_TABLE[surface]        = [BodyK, BodyKScale, MaxDepth, Epsilon, FrictionLevel, Bump, BumpFlag]
muStatic  = BestStatic + DiffStatic * 0.7 * FrictionLevel;   // 0.7 [V 0x8066f4]
muKinetic = muStatic * ScaleKinetic;
rollK     = BestRollK + DiffRollK * car.rollLevel;           // rollLevel = 0 -> BestRollK
// missing row -> all columns 1.0 [V FUN_006d5d00]
```
FrictionLevel acts as a wetness/iciness modifier: -1 on dry asphalt (grippier), +1 wet asphalt, +0.25 snow,
+2 ice-on-asphalt, 0 elsewhere. All μ values are true friction coefficients against `Fz` (newtons) under
12 m/s² gravity, so tarmac grip exceeds 2 g by design.

AI-only friction mode (v1.3, [V]; §8 #8 resolved): `phys+0xcc` = bit 0 of the owning player's flags. FUN_004b3790
state 0 copies it (0x4b37e2-0x4b3805: `mov byte [eax+0xcc], 1` / `0`); the flag is set by FUN_004b3b00 (player
vtable 0x8077f8, slot +0x1c), which FUN_00488590 calls at 0x48922c-0x48923c with `profile->vfunc0x30()`, 0 for
local human players (the flags word player+0x14 is zeroed by the constructor at 0x74d55a). With the flag set,
FUN_006c49c0 / 4a60 / 4930 read tyre row `5 + tyre` (ASPHALT) for static/kinetic μ and BestRollK on every surface,
and the caller zeroes a positive FrictionLevel (0x6cb6cb-0x6cb6f7: `cmp al,1; jne; …; fcomp [0.0]; test ah,0x41;
jne; mov [esp+0xb4],0`), i.e. `FL = min(FL_surface, 0)`. So AI / non-local cars grip like on dry asphalt
everywhere (gravel tyres: 2.126 on asphalt, 1.9 elsewhere; ice tyres 1.6) and get no deep-surface rolling drag.
The player car never uses this mode; it matters only when calibrating against the original's AI or ghost times.

### 4.3 The rally-web surfaces (23 = one per original material)

rally-web has **one surface per original material id 0..22** (v1.5 contract change; DUMMY 23 has none): the
original ten keep rally-web material ids 0..9, the other 13 original materials were appended as ids 10..22
(`src/core/constants.ts` SURFACE_IDS order: wood, snowChunky, snowDeep, snowAsphalt, snowDitch, leaf,
asphaltGrass, gravelGrass, mudGrass, mudDitch, sandDeep, sandDark, sandDarkDeep). Every row is the
PhysicsParam.con row verbatim (§4.4; contract test against the extracted file). **Numbering trap:** the
rally-web material id is the SURFACE_IDS index, not the original byte (gcm 0 = GRASS, rally-web 0 = tarmac);
raw gcm bytes go through `materialFromOrig` / `ORIG_MATERIAL_TO_MATERIAL` (23, 255 and every byte > 22 →
MATERIAL_NONE). Values: static μ / kinetic μ per tyre type, and the multiplier relative to
tarmac-on-tarmac-tyres (μs 2.407).

| rally-web surface | orig. id | tarmac tyre | intermediate | gravel tyre | snow tyre | ice tyre |
|---|---|---|---|---|---|---|
| `tarmac` | 1 ASPHALT | 2.407 / 2.061 (1.00) | 2.266 / 1.903 (0.94) | 2.126 / 1.701 (0.88) | 1.902 / 1.522 (0.79) | 1.790 / 1.432 (0.74) |
| `gravel` | 2 GRAVEL | 1.550 / 1.240 (0.64) | 1.710 / 1.368 (0.71) | 1.775 / 1.420 (0.74) | 1.350 / 1.080 (0.56) | 1.305 / 1.044 (0.54) |
| `gravelDeep` | 12 GRAVELDEEP | 1.550 / 1.240 (0.64) | same | same | same | same |
| `mud` | 4 MUD | 1.150 / 0.920 (0.48) | 1.280 / 1.024 (0.53) | 1.380 / 1.104 (0.57) | 1.250 / 1.000 (0.52) | 1.407 / 1.126 (0.58) |
| `snow` | 7 SNOW | 0.340 / 0.272 (0.14) | 0.437 / 0.349 (0.18) | 0.437 / 0.349 (0.18) | 1.310 / 1.048 (0.54) | 1.407 / 1.125 (0.58) |
| `ice` | 20 ICEASPHALT | 0.095 / 0.076 (0.04) | 0.345 / 0.276 (0.14) | 0.595 / 0.476 (0.25) | 1.195 / 0.956 (0.50) | 1.295 / 1.036 (0.54) |
| `grass` | 0 GRASS | 0.808 / 0.646 (0.34) | 1.203 / 0.962 (0.50) | 1.502 / 1.202 (0.62) | 1.350 / 1.080 (0.56) | 1.449 / 1.159 (0.60) |
| `sand` | 5 SAND | 0.899 / 0.719 (0.37) | 1.280 / 1.024 (0.53) | 1.449 / 1.159 (0.60) | 1.350 / 1.080 (0.56) | 1.350 / 1.080 (0.56) |
| `cobbles` | 13 COBBLES | 1.750 / 1.400 (0.73) | same | same | same | same |
| `water` (wet tarmac) | 3 WATERASPHALT | 1.895 / 1.622 (0.79) | 1.784 / 1.499 (0.74) | 1.674 / 1.339 (0.70) | 1.498 / 1.198 (0.62) | 1.410 / 1.128 (0.59) |
| `wood` | 6 WOOD | 1.526 / 1.221 (0.63) | 1.600 / 1.280 (0.66) | 1.600 / 1.280 (0.66) | 1.600 / 1.280 (0.66) | 1.600 / 1.280 (0.66) |
| `snowChunky` | 8 SNOWCHUNKY | 0.242 / 0.194 (0.10) | 0.339 / 0.272 (0.14) | 0.339 / 0.272 (0.14) | 1.310 / 1.048 (0.54) | 1.504 / 1.203 (0.62) |
| `snowDeep` | 9 SNOWDEEP | 0.250 / 0.200 (0.10) | 0.350 / 0.280 (0.15) | 0.350 / 0.280 (0.15) | 1.350 / 1.080 (0.56) | 1.550 / 1.240 (0.64) |
| `snowAsphalt` | 10 SNOWASPHALT | 0.339 / 0.272 (0.14) | 0.437 / 0.349 (0.18) | 0.437 / 0.349 (0.18) | 1.310 / 1.048 (0.54) | 1.407 / 1.125 (0.58) |
| `snowDitch` | 11 SNOWDITCH | 0.250 / 0.200 (0.10) | 0.350 / 0.280 (0.15) | 0.350 / 0.280 (0.15) | 1.350 / 1.080 (0.56) | 1.550 / 1.240 (0.64) |
| `leaf` | 14 LEAF | 1.750 / 1.400 (0.73) | 1.700 / 1.360 (0.71) | 1.600 / 1.280 (0.66) | 1.500 / 1.200 (0.62) | 1.400 / 1.120 (0.58) |
| `asphaltGrass` | 15 ASPHALTGRASS | 1.825 / 1.460 (0.76) | 1.725 / 1.380 (0.72) | 1.700 / 1.360 (0.71) | 1.650 / 1.320 (0.69) | 1.625 / 1.300 (0.68) |
| `gravelGrass` | 16 GRAVELGRASS | 1.400 / 1.120 (0.58) | 1.450 / 1.160 (0.60) | 1.500 / 1.200 (0.62) | 1.450 / 1.160 (0.60) | 1.400 / 1.120 (0.58) |
| `mudGrass` | 17 MUDGRASS | 1.300 / 1.040 (0.54) | 1.350 / 1.080 (0.56) | 1.400 / 1.120 (0.58) | 1.350 / 1.080 (0.56) | 1.300 / 1.040 (0.54) |
| `mudDitch` | 18 MUDDITCH | 1.450 / 1.160 (0.60) | 1.450 / 1.160 (0.60) | 1.450 / 1.160 (0.60) | 1.450 / 1.160 (0.60) | 1.450 / 1.160 (0.60) |
| `sandDeep` | 19 SANDDEEP | 1.650 / 1.320 (0.69) | 1.650 / 1.320 (0.69) | 1.650 / 1.320 (0.69) | 1.650 / 1.320 (0.69) | 1.650 / 1.320 (0.69) |
| `sandDark` | 21 SANDDARK | 0.899 / 0.719 (0.37) | 1.280 / 1.024 (0.53) | 1.449 / 1.159 (0.60) | 1.350 / 1.080 (0.56) | 1.350 / 1.080 (0.56) |
| `sandDarkDeep` | 22 SANDDARKDEEP | 1.650 / 1.320 (0.69) | 1.650 / 1.320 (0.69) | 1.650 / 1.320 (0.69) | 1.650 / 1.320 (0.69) | 1.650 / 1.320 (0.69) |

Other per-surface columns:

| surface | DEEP (×1.4 lateral, bogging) | BestRollK | DiffRollK (bogging weight) | MaxDepth m | Bump m | BumpFlag | BodyK | BodyKScale | Epsilon | wheel jitter amp (visual) | camera roughness |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tarmac | no | 1.0 | 1.0 | 0 | 0 | 0 | 0.90 | 0.90 | 1.00 | 0.125 | 0.03125 |
| gravel | no | 1.1 | 1.1 | 0.005 | 0.025 | 0 | 0.92 | 0.80 | 0.50 | 0.75 | 0.25 |
| gravelDeep | **yes** | 5.01 | 1.3 | 0.04 | 0.02 | 1 | 1.00 | 0.25 | 0.40 | 1.5 | 0.275 |
| mud | no | 1.3 | 1.3 | 0.02 | 0.015 | 0 | 0.85 | 0.75 | 0.45 | 1.0 | 0.25 |
| snow | no | 1.2 | 1.2 | 0.02 | 0.005 | 0 | 0.72 | 0.50 | 0.30 | 0.25 | 0.0625 |
| ice | no | 1.1 | 1.1 | 0 | 0.01 | 0 | 0.70 | 0.90 | 0.50 | 0.25 | 0.0625 |
| grass | **yes** | 1.204 | 1.006 | 0.02 | 0.035 | 1 | 0.85 | 0.25 | 0.35 | 2.0 | 0.3125 |
| sand | no | 1.15 | 1.15 | 0 | 0.01 | 0 | 0.85 | 0.75 | 0.45 | 0.5 | 0.125 |
| cobbles | no | 3.1 | 1.1 | 0 | 0.075 | 1 | 0.90 | 0.80 | 1.00 | 2.5 | 0.375 |
| water | no | 1.0 | 1.0 | 0 | 0 | 0 | 0.90 | 0.90 | 1.00 | 0.125 | 0.03125 |
| wood | no | 1 | 1 | 0 | 0.05 | 1 | 0.80 | 0.90 | 0.40 | 2.5 | 0.375 |
| snowChunky | no | 2.002 | 1.2 | 0.02 | 0.01 | 0 | 0.72 | 0.50 | 0.30 | 0.25 | 0.0625 |
| snowDeep | **yes** | 10.075 | 1.5 | 0.04 | 0.015 | 1 | 0.80 | 0.25 | 0.20 | 0.5 | 0.125 |
| snowAsphalt | no | 1.2 | 1.2 | 0.02 | 0.005 | 0 | 0.72 | 0.50 | 0.30 | 0.25 | 0.0625 |
| snowDitch | **yes** | 10.068 | 1.5 | 0.04 | 0.02 | 1 | 0.80 | 0.25 | 0.30 | 0.5 | 0.125 |
| leaf | no | 1 | 1 | 0.02 | 0.02 | 1 | 0.45 | 0.90 | 0.35 | 0.125 | 0.03125 |
| asphaltGrass | no | 1.116 | 1.2 | 0.01 | 0.015 | 0 | 0.72 | 0.80 | 0.40 | 0.125 | 0.03125 |
| gravelGrass | no | 1.35 | 1.51 (2.51 on tyres 0, 4) | 0.02 | 0.017 | 0 | 0.70 | 0.80 | 0.40 | 1 | 0.25 |
| mudGrass | no | 1.505 | 1.4 | 0.02 | 0.017 | 0 | 0.70 | 0.80 | 0.35 | 1 | 0.25 |
| mudDitch | **yes** | 10.064 | 1.905 (20.905 on tyres 0, 4) | 0.04 | 0.02 | 1 | 0.65 | 0.25 | 0.40 | 1.25 | 0.275 |
| sandDeep | **yes** | 5.024 | 1.5 | 0.04 | 0.01 | 1 | 0.90 | 0.25 | 0.55 | 1.25 | 0.1875 |
| sandDark | no | 1.15 | 1.15 | 0.02 | 0.01 | 0 | 0.85 | 0.75 | 0.45 | 0.5 | 0.125 |
| sandDarkDeep | **yes** | 5.024 | 1.5 | 0.04 | 0.01 | 1 | 0.90 | 0.75 | 0.25 | 1.25 | 0.1875 |

v1.5 verification: the shipped table (`src/sim/params.ts` DEFAULT_SURFACE_TABLE, 23 rows) equals the extracted
PhysicsParam.con in every column of every material (max |Δ| = 0; the Frida replay prints this check, and a contract
test holds it); the replay runs on this table through `materialFromOrig`, so the traced materials (GRASS, ASPHALT,
GRAVEL) behave as in the original to the one-step precision of Appendix C. The other 20 materials share the same
code paths (μ §4.2, DEEP / bogging §2.6 W16 and §2.7, sink and washboard §2.5.2, body columns §2.9); their rows are
data only. Differences: DUMMY (23) gives no wheel contact in rally-web (the original would touch it with the DUMMY
row, `(unsigned)23 < 0x20`; no Track.gcm face uses it); the body solver answers 23 with the DUMMY row and > 23 with
"all columns 1.0" exactly as the original's getter.

Column notes:
* **DEEP** [V]: lateral pure-slip force ×`sideFrictionFactor` (1.4) and body-friction "bogging" drag (§2.7).
  In the original the DEEP set is {grass, snow-deep, snow-ditch, gravel-deep, mud-ditch, sand-deep,
  sand-dark-deep} (orig ids {0, 9, 11, 12, 18, 19, 22}, the FUN_006d0410 switch); rally-web stores it as a
  per-surface boolean (`grass`, `snowDeep`, `snowDitch`, `gravelDeep`, `mudDitch`, `sandDeep`, `sandDarkDeep`).
* **BestRollK** [V]: viscous rolling resistance per wheel, `ω · Fz/2048 · rollK` N·m. Deep gravel is 5×,
  cobbles 3×, deep snow and mud ditches 10× asphalt.
* **MaxDepth / Bump / BumpFlag** [V]: suspension sink and 0.2 m washboard (§2.5.2).
* **BodyK / BodyKScale / Epsilon** [V read, I meaning]: chassis contact (§2.9: friction, normal-velocity
  scaling, restitution).
* **wheel jitter amp** [V FUN_006c8ef0]: visual wheel bounce `amp · speed(m/s) · 0.0002 · sin²(35·t)` m
  (switch on the orig id; an id outside the switch, e.g. DUMMY, gets 1.0).
* **camera roughness** [V FUN_0075e210]: summed over the 4 wheels for the bumper-cam shake (§5.3)
  (switch on the orig id; ids outside it add 0).

#### 4.3.1 Which surface the original's stages actually use (v1.3) [V data, M effect]

The original's collision mesh `Track.gcm` stores one material byte per face (after the `3·nFaces` u32 index array:
u32 nFaces, then nFaces bytes). The ids are the exe's `c_MATERIAL_ROAD_*` enum (strings at 0x85d0f0..0x85ceac,
values 0..22, registered by the pushes at 0x743b3b-0x74467d), the same ids as §4.4. (`TrackFull.gcm` is used only
with the console variable `fullCollision`, default 0, 0x40260e.) Face area within 3.5 m of each stage's AI centre
spline (the road), forward stages [V, audit script `artifacts/audit/gcm_materials.py`]:

> **Port status (post-v1.4):** the original stages themselves are now ported directly — all 48 track
> archives build as rally-web stages with the real splines, timing and these surfaces
> (`src/world/ports/` + `src/world/portedBuilder.ts`; ids like `corsica-1-f`). The right-hand column
> below names the PROCEDURAL stand-ins that stay in the catalogue as the handling-lab class stages; the
> ported stage families reproduce the per-stage material shares in this table. The full-fidelity target
> (look identical too) is tracked in `PROGRESS.md`.

| original stage group | race.tyretype | road material share | rally-web stage |
|---|---|---|---|
| desert rally 1 / 2 / 3 | 2 gravel | SAND 98.7 / 82.0 / 53.6 %, ASPHALT 0 / 17.8 / 24.1 %, GRAVEL 0.4 / 0 / 22.3 % (mean ≈ 78 / 14 / 8 %) | `red-basin`: sand base, ≈ 14 % tarmac, ≈ 8 % gravel |
| forest rally 1 / 2 / 3 | 2 gravel | MUD 99.9 / 98.3 / 100 % (+ 1.7 % MUDGRASS; a wet-asphalt splash in one reverse stage) | `pine-ridge`: mud, plus a short `water` splash |
| gravel hill climbs 1a / 2a | 2 gravel | GRAVEL 87.3 / 99.8 % (+ GRAVELGRASS) | (none; `gravel` is the base surface only for such stages) |
| tarmac rally 1 / 2 | 0 tarmac | ASPHALT 96 / 84.7 % (stage 2 also GRAVEL 14.4 %) | `col-du-vent` |
| snowy hill climb 3a | 3 snow | SNOWASPHALT (id 10, rows equal to SNOW id 7) 100 % | `frostvale` (`snow`) |
| ice racing 1 / 2 | 4 ice | ICEASPHALT 100 / 97 % | `lake-skoga` (`ice`) |
| rallycross 1 | 1 intermediate | GRAVEL 62.5 %, ASPHALT 37.5 % | `kettle-park` (tarmac + gravel) |

So the original's loose RALLY stages run on SAND and MUD: static μ with gravel tyres 1.449 / 1.380 (kinetic
1.159 / 1.104), 0.60 / 0.57 of tarmac on tarmac tyres, against GRAVEL's 1.775 (0.74). GRAVEL is the road of the
gravel hill climbs and the rallycross. Snow and ice stages match their rows above. The gravel-to-tarmac contrast
on the representative loose surface is therefore -45 / -47 % peak lateral grip (sand / mud, awd_wrc, §4.5) rather than
-31 % (gravel), and braking 100-0 takes 26.6 / 27.8 m instead of 22.1 m (tarmac 15.7 m). This is
a content fact, not a model change, and it does not by itself make class-0 AWD slides holdable (§7 drift hold).

### 4.4 Full original tables (for adding surfaces)

```ts
// SURFACE_TABLE: material id -> [BodyK, BodyKScale, MaxDepth, Epsilon, FrictionLevel, Bump, BumpFlag]  [V PhysicsParam.con]
const SURFACE_TABLE = {
   0: [0.85, 0.25, 0.02, 0.35, 0.0, 0.035, 1], // GRASS (DEEP)
   1: [0.9, 0.9, 0.0, 1.0, -1.0, 0.0, 0],      // ASPHALT
   2: [0.92, 0.8, 0.005, 0.5, 0.0, 0.025, 0],  // GRAVEL
   3: [0.9, 0.9, 0.0, 1.0, 1.0, 0.0, 0],       // WATERASPHALT
   4: [0.85, 0.75, 0.02, 0.45, 0.0, 0.015, 0], // MUD
   5: [0.85, 0.75, 0.0, 0.45, 0.0, 0.01, 0],   // SAND
   6: [0.8, 0.9, 0.0, 0.4, 0.0, 0.05, 1],      // WOOD
   7: [0.72, 0.5, 0.02, 0.3, 0.25, 0.005, 0],  // SNOW
   8: [0.72, 0.5, 0.02, 0.3, 0.25, 0.01, 0],   // SNOWCHUNKY
   9: [0.8, 0.25, 0.04, 0.2, 0.0, 0.015, 1],   // SNOWDEEP (DEEP)
  10: [0.72, 0.5, 0.02, 0.3, 0.25, 0.005, 0],  // SNOWASPHALT
  11: [0.8, 0.25, 0.04, 0.3, 0.0, 0.02, 1],    // SNOWDITCH (DEEP)
  12: [1.0, 0.25, 0.04, 0.4, 0.0, 0.02, 1],    // GRAVELDEEP (DEEP)
  13: [0.9, 0.8, 0.0, 1.0, 0.0, 0.075, 1],     // COBBLES
  14: [0.45, 0.9, 0.02, 0.35, 0.0, 0.02, 1],   // LEAF
  15: [0.72, 0.8, 0.01, 0.4, 0.0, 0.015, 0],   // ASPHALTGRASS
  16: [0.7, 0.8, 0.02, 0.4, 0.0, 0.017, 0],    // GRAVELGRASS
  17: [0.7, 0.8, 0.02, 0.35, 0.0, 0.017, 0],   // MUDGRASS
  18: [0.65, 0.25, 0.04, 0.4, 0.0, 0.02, 1],   // MUDDITCH (DEEP)
  19: [0.9, 0.25, 0.04, 0.55, 0.0, 0.01, 1],   // SANDDEEP (DEEP)
  20: [0.7, 0.9, 0.0, 0.5, 2.0, 0.01, 0],      // ICEASPHALT
  21: [0.85, 0.75, 0.02, 0.45, 0.0, 0.01, 0],  // SANDDARK
  22: [0.9, 0.75, 0.04, 0.25, 0.0, 0.01, 1],   // SANDDARKDEEP (DEEP)
  23: [0.01, 1.0, 0.0, 1.0, 0.0, 0.0, 0],      // DUMMY
};
// TYRE_TABLE: material id -> per tyre type 0..4 -> [BestStatic, DiffStatic, ScaleKinetic, BestRollK, DiffRollK]  [V]
const TYRE_TABLE = {
   0: [[0.808,-0.137,0.8,1.204,1.006],[1.203,-0.205,0.8,1.204,1.006],[1.502,-0.255,0.8,1.204,1.006],[1.35,-0.23,0.8,1.204,1.006],[1.449,-0.246,0.8,1.204,1.006]],
   1: [[2.151,-0.366,0.856,1.0,1.0],[2.025,-0.344,0.84,1.0,1.0],[1.9,-0.323,0.8,1.0,1.0],[1.7,-0.289,0.8,1.0,1.0],[1.6,-0.272,0.8,1.0,1.0]],
   2: [[1.55,-0.264,0.8,1.1,1.1],[1.71,-0.282,0.8,1.1,1.1],[1.775,-0.302,0.8,1.1,1.1],[1.35,-0.23,0.8,1.1,1.1],[1.305,-0.222,0.8,1.1,1.1]],
   3: [[2.151,-0.366,0.856,1.0,1.0],[2.025,-0.344,0.84,1.0,1.0],[1.9,-0.323,0.8,1.0,1.0],[1.7,-0.289,0.8,1.0,1.0],[1.6,-0.272,0.8,1.0,1.0]],
   4: [[1.15,-0.196,0.8,1.3,1.3],[1.28,-0.218,0.8,1.3,1.3],[1.38,-0.235,0.8,1.3,1.3],[1.25,-0.213,0.8,1.3,1.3],[1.407,-0.239,0.8,1.3,1.3]],
   5: [[0.899,-0.136,0.8,1.15,1.15],[1.28,-0.201,0.8,1.15,1.15],[1.449,-0.229,0.8,1.15,1.15],[1.35,-0.213,0.8,1.15,1.15],[1.35,-0.213,0.8,1.15,1.15]],
   6: [[1.526,-0.259,0.8,1.0,1.0],[1.6,-0.272,0.8,1.0,1.0],[1.6,-0.272,0.8,1.0,1.0],[1.6,-0.272,0.8,1.0,1.0],[1.6,-0.272,0.8,1.0,1.0]],
   7: [[0.35,-0.06,0.8,1.2,1.2],[0.45,-0.076,0.8,1.2,1.2],[0.45,-0.076,0.8,1.2,1.2],[1.35,-0.23,0.8,1.2,1.2],[1.45,-0.247,0.8,1.2,1.2]],
   8: [[0.25,-0.043,0.8,2.002,1.2],[0.35,-0.06,0.8,2.002,1.2],[0.35,-0.06,0.8,2.002,1.2],[1.35,-0.23,0.8,2.002,1.2],[1.55,-0.264,0.8,2.002,1.2]],
   9: [[0.25,-0.043,0.8,10.075,1.5],[0.35,-0.06,0.8,10.075,1.5],[0.35,-0.06,0.8,10.075,1.5],[1.35,-0.23,0.8,10.075,1.5],[1.55,-0.264,0.8,10.075,1.5]],
  10: [[0.35,-0.06,0.8,1.2,1.2],[0.45,-0.076,0.8,1.2,1.2],[0.45,-0.076,0.8,1.2,1.2],[1.35,-0.23,0.8,1.2,1.2],[1.45,-0.247,0.8,1.2,1.2]],
  11: [[0.25,-0.043,0.8,10.068,1.5],[0.35,-0.06,0.8,10.068,1.5],[0.35,-0.06,0.8,10.068,1.5],[1.35,-0.23,0.8,10.068,1.5],[1.55,-0.264,0.8,10.068,1.5]],
  12: [[1.55,-0.264,0.8,5.01,1.3],[1.55,-0.264,0.8,5.01,1.3],[1.55,-0.264,0.8,5.01,1.3],[1.55,-0.264,0.8,5.01,1.3],[1.55,-0.264,0.8,5.01,1.3]],
  13: [[1.75,-0.298,0.8,3.1,1.1],[1.75,-0.298,0.8,3.1,1.1],[1.75,-0.298,0.8,3.1,1.1],[1.75,-0.298,0.8,3.1,1.1],[1.75,-0.298,0.8,3.1,1.1]],
  14: [[1.75,-0.213,0.8,1.0,1.0],[1.7,-0.213,0.8,1.0,1.0],[1.6,-0.213,0.8,1.0,1.0],[1.5,-0.213,0.8,1.0,1.0],[1.4,-0.213,0.8,1.0,1.0]],
  15: [[1.825,-0.276,0.8,1.116,1.2],[1.725,-0.276,0.8,1.116,1.2],[1.7,-0.276,0.8,1.116,1.2],[1.65,-0.276,0.8,1.116,1.2],[1.625,-0.276,0.8,1.116,1.2]],
  16: [[1.4,-0.238,0.8,1.35,2.51],[1.45,-0.238,0.8,1.35,1.51],[1.5,-0.238,0.8,1.35,1.51],[1.45,-0.238,0.8,1.35,1.51],[1.4,-0.238,0.8,1.35,2.51]],
  17: [[1.3,-0.221,0.8,1.505,1.4],[1.35,-0.221,0.8,1.505,1.4],[1.4,-0.221,0.8,1.505,1.4],[1.35,-0.221,0.8,1.505,1.4],[1.3,-0.221,0.8,1.505,1.4]],
  18: [[1.45,-0.247,0.8,10.064,20.905],[1.45,-0.247,0.8,10.064,1.905],[1.45,-0.247,0.8,10.064,1.905],[1.45,-0.247,0.8,10.064,1.905],[1.45,-0.247,0.8,10.064,20.905]],
  19: [[1.65,-0.28,0.8,5.024,1.5],[1.65,-0.28,0.8,5.024,1.5],[1.65,-0.28,0.8,5.024,1.5],[1.65,-0.28,0.8,5.024,1.5],[1.65,-0.28,0.8,5.024,1.5]],
  20: [[0.5,-0.289,0.8,1.1,1.1],[0.75,-0.289,0.8,1.1,1.1],[1.0,-0.289,0.8,1.1,1.1],[1.6,-0.289,0.8,1.1,1.1],[1.7,-0.289,0.8,1.1,1.1]],
  21: [[0.899,-0.136,0.8,1.15,1.15],[1.28,-0.201,0.8,1.15,1.15],[1.449,-0.229,0.8,1.15,1.15],[1.35,-0.213,0.8,1.15,1.15],[1.35,-0.213,0.8,1.15,1.15]],
  22: [[1.65,-0.28,0.8,5.024,1.5],[1.65,-0.28,0.8,5.024,1.5],[1.65,-0.28,0.8,5.024,1.5],[1.65,-0.28,0.8,5.024,1.5],[1.65,-0.28,0.8,5.024,1.5]],
  23: [[1.0,-0.17,0.8,1.0,1.0],[1.0,-0.17,0.8,1.0,1.0],[1.0,-0.17,0.8,1.0,1.0],[1.0,-0.17,0.8,1.0,1.0],[1.0,-0.17,0.8,1.0,1.0]],
};
```

### 4.5 What the surfaces do to the feel (model-derived, awd_wrc, matched tyres; details in §7)

| surface (tyre) | peak lateral (§7 T4) | braking 100→0 | 0-100 km/h | coast decel at 100 km/h |
|---|---|---|---|---|
| tarmac (tarmac) | 2.5-2.8 g | 15.7 m | 4.6 s | 5.4 m/s² |
| gravel (gravel) | 1.9-2.0 g | 22.2 m | 4.8 s | 5.3 m/s² |
| sand (gravel) — the original's desert rally road (v1.3) | 1.49 / 1.51 g | 26.6 m | 4.96 s | 5.35 m/s² |
| mud (gravel) — the original's forest rally road (v1.3) | 1.45 / 1.44 g | 27.8 m | 4.98 s | 5.43 m/s² |
| snow (snow) | 1.4-1.45 g | 29.6 m | 4.9 s | 5.2 m/s² |
| ice (ice) | 1.4-1.45 g | 29.9 m | 4.8 s | 5.1 m/s² |
| snow (tarmac tyres) | 0.33-0.36 g steady state (0.55 g unfiltered); UNVERIFIED, see T4 | 105 m | 9.4 s | |
| ice (tarmac tyres) | 0.12 g steady state at 60 km/h (0.20 g unfiltered); UNVERIFIED, see T4 | ≈ 255 m (from an initialised 100 km/h, §7 T3) | never: top speed ≈ 86 km/h, 0-60 ≈ 20 s | |
| gravel deep (gravel) | | | | ≈ 9.4 m/s² at 80 km/h; top speed below 135 km/h |

---------------------------------------------------------------------------------------------------

## 5. Input filtering, steering, gearbox, cameras, reset, setup

### 5.1 Input filter [V 0x752c00 (CarPlayer::readInput 0x753090)]

Runs every physics substep (dt = 1/120) and writes `Controls` (§1.4). Digital channels ramp while held and
drop to 0 the instant they are released (no return ramp). A digital channel counts as pressed when its raw
value is > 0 [V: `raw <= 0 → 0`].

```ts
interface RawInput { thr: number; brk: number; hb: number; steer: number;   // analog values 0..1 / -1..1
                     thrDigital: boolean; brkDigital: boolean; hbDigital: boolean; steerDigital: boolean;
                     left: boolean; right: boolean; gearUpEdge: boolean; gearDownEdge: boolean; }
// [D] analog pedal dead zone (the original passes analog pedals raw [V 0x752c00]). It keeps a resting pedal
// or a worn trigger that reads 0.01-0.07 from disabling sleep (§2.10). Default cfg.pedalDeadzone = 0.08
// (v1.1: 0.05; a trigger resting at 0.06 kept the car awake: 15-35 mm body bob and creep).
const pedal = (v: number) => (v < cfg.pedalDeadzone ? 0 : (v - cfg.pedalDeadzone) / (1 - cfg.pedalDeadzone));
function filterInputs(raw: RawInput, dt: number) {
  C.throttle = raw.thrDigital ? (raw.thr > 0 ? (C.throttle <= 0.09 ? 0.10 : C.throttle + 2.0 * dt) : 0) : pedal(raw.thr);
  C.brake    = raw.brkDigital ? (raw.brk > 0 ? (C.brake    <= 0.19 ? 0.20 : C.brake    + 1.5 * dt) : 0) : pedal(raw.brk);
  C.handbrake= raw.hbDigital  ? (raw.hb  > 0 ? (C.handbrake<= 0.49 ? 0.50 : C.handbrake+ 1.0 * dt) : 0) : pedal(raw.hb);
  if (raw.steerDigital) {
    const dir = (raw.right ? 1 : 0) - (raw.left ? 1 : 0);
    if (dir === 0) C.steer = 0;                                               // snaps to centre
    else if (dir > 0) C.steer = C.steer <= 0.04 ? 0.05 : C.steer + 2.0 * dt;  // opposite lock: jumps to ±0.05
    else C.steer = C.steer >= -0.04 ? -0.05 : C.steer - 2.0 * dt;
  } else {
    let x = applyDeadzone(raw.steer, device.deadzone);        // [D] rescaled dead zone; pads 0.1 [V keymapP]
    if (cfg.sqrtCurve === 1) x = sgn(x) * Math.sqrt(Math.abs(x));             // Car.SQRTCurve 1 [V]
    else if (cfg.sqrtCurve === 2) x = sgn(x) * Math.sqrt(Math.sqrt(Math.abs(x)));
    if (cfg.steeringType === 1) {                              // default [V ctor 0x6c4652 sets 1]
      if (Math.abs(x) < 0.002) C.steer = 0;                    // dead zone tests x BEFORE squaring [V]
      else {
        const a = cfg.steerSensitivity /*1.0*/ * Math.abs(x);
        C.steer = sgn(x) * (a * a - 0.002) * 1.002004;         // squared response, NO rate limit
      }  // NB: for 0.002 <= |x| < ~0.045 the output has the opposite sign (at most 0.002), as in the original
    } else {                                                   // type 0: rate-limited (unused by default)
      if (x === 0) { C.steer = towardZero(C.steer, 4.0 * dt); if (Math.abs(C.steer) < 0.01) C.steer = 0; }
      else { const r = (x * x + 0.5) * 3 * dt; C.steer += clamp(x - C.steer, -r, r); }
    }
  }
  C.throttle = clamp(C.throttle, 0, 1); C.brake = clamp(C.brake, 0, 1);
  C.handbrake = clamp(C.handbrake, 0, 1); C.steer = clamp(C.steer, -1, 1);
  C.gearUp = raw.gearUpEdge; C.gearDown = raw.gearDownEdge;   // one substep per press
}
```

| Channel | first frame of press | then | time to 1.0 | release |
|---|---|---|---|---|
| throttle (key) | 0.10 | +2.0/s | 0.45 s | 0 instantly |
| brake (key) | 0.20 | +1.5/s | 0.53 s | 0 instantly |
| handbrake (key) | 0.50 | +1.0/s | 0.50 s | 0 instantly |
| steer (keys) | ±0.05 | ±2.0/s | 0.475 s | 0 instantly |

Device presets [V keymaps]: keyboard = all digital. Gamepad = stick steering with dead zone 0.1 and
`sqrtCurve = 1` (sqrt then square: net linear), digital pedal buttons unless triggers are analog. Wheel and
joystick = analog axes, `sqrtCurve = 0` (squared steering response), throttle/brake axes inverted.
Not controllable (pre-start, finished): steer 0, throttle 0, brake 0, **handbrake 1.0** [V 0x74d8f0].
Default bindings: arrows steer/throttle/brake, Space handbrake (hold), A/Z gear up/down, Enter reset,
C camera, Left Ctrl look back, P pause [V keymap.con].

### 5.2 Steering summary

Steer angle `= (0.40 + max(0, 40 - kmh)·0.005) · C.steer` rad, same for both fronts; Ackermann from the
turning-centre axle construction (§2.6 W5); 0.05 m kingpin offset; no high-speed lock reduction [V].
Visual front wheels follow the physics angle at ≤ 4 rad/s [V FUN_006c8ef0].

### 5.2a Gearbox logic summary (normative code in §2.2)

* Gears: R, 1..N; no neutral. A shift is a timed state; while it runs the clutch is open, drive torque is
  zero, the engine free-revs down, and turbo boost is capped to 25 % of the waste gate.
* **Auto, upshift**: 3-D world speed > upshift speed of the current gear (speed at peak-torque rpm minus 50);
  0.15 s. Sliding sideways counts as speed.
* **Auto, coast downshift** (throttle ≤ 0.1): below 0.95 × 0.775 × the CURRENT gear's upshift speed (0.75 ×
  0.775 × 62.9 km/h for 2→1) and rpm < 4000; takes effect on the next substep. On that completion step the
  clutch is open, so rpm free-revs and can stay below 4000 for the next decision: one coast downshift can
  chain straight into another (§7 T16).
* **Auto, kick-down** (throttle > 0.1): instantly drops to the highest gear whose speed band contains the
  current speed (no clutch time).
* **Auto, reverse**: holding brake > 0.3 below 5 km/h selects 1st, then R after 0.225 s; in R the pedals swap
  (throttle pedal brakes, brake pedal drives); R→1 when the (swapped) brake input > 0.3 and stopped or rolling
  forward. Changing between R and 1 applies EngineBrakeConstant to all wheels.
* **Manual**: up/down buttons, 0.10 s shifts; 1→R only below 30 km/h; R→1 refused above 100 km/h reversing.
* Upshift speeds for the archetypes: §3.2. Shift timings per original: TimeChangeGear 0.10 s, ×1.5 in auto.
* rpm shown to the player: `min(rpm, maxRpm)`; the limiter jitters rpm between 8251 and 9274 for HUD and
  sound (torque is looked up before the jitter, §2.3.5).

### 5.3 Cameras [V FUN_0075f720, FUN_0075e390, FUN_007601a0, FUN_00760d80, 0x764410]

Offsets below are in the ORIGINAL car frame (x right, y up, z forward); convert with M for Three.js (car
forward = -Z). Constants marked "per frame" were applied once per rendered frame with no dt; use
`kdt = 1 - (1 - k)^(60·frameDt)` (60 Hz reference, [I]: original frame rate assumed 60).

Views in cycle order (8 enabled, matching "bumper, hood, 6 chase-type"): 0 bumper, 1 bonnet, 5 chase near,
6 chase, 7 chase far, 8 chase high, 10 tether high, 12 tether low. Look-back = entry 24 `(0, 0.4, -1.5)`
facing backwards while held. **FOV fixed at 70°** (no speed FOV); only the flipped-car camera changes it.

| entry | type | posA | posB | p0 / p1 |
|---|---|---|---|---|
| 0 | bumper | (0, 0.45, 1.40) | | |
| 1 | bonnet (rigid) | (0, 0.65, 0.90) | | |
| 5 | chase near | (0, 1.15, -3.10) | (0, 1.35, -3.20) | 10 / 0.5 |
| 6 | chase | (0, 1.15, -3.50) | (0, 1.35, -4.00) | 10 / 0.5 |
| 7 | chase far | (0, 1.15, -4.25) | (0, 1.45, -4.75) | 10 / 0.5 |
| 8 | chase high | (0, 1.45, -5.00) | (0, 2.50, -7.00) | 11 / 0.75 |
| 10 / 12 | tether | p = (0.125, 32) / (0.125, 8) | d = (4, 4.3, 4.2) / (5, 8.3, 8.2) | |

**The table is ImprezaWRX's** (= the generic `makeCameraTuning()`, used for the archetype cars). Every original car
carries its own table: `ObjectTemplate.create CarCamera <Car>CarCamera` in its Templates.con (25
`setCamPosition i enabled flag posA posB param` lines, attached by Player.con `addTemplate <Car>CarCamera`), and each
camera function reads its entry from the player car's template array [V: template +0x248, stride 0x30; FUN_0075e390
entry 0 at +0x0c, FUN_0075e790 entry 1 at +0x3c, FUN_0075fda0 entry 6 at +0x12c..+0x14c, the tether at
+0x1ec..+0x200]; the literals in those functions (e.g. bumper (0, 0.456, 1.8575)) are only the no-template
fallback. 20 of the 29 cars have their own bonnet, 15 their own bumper and 8 their own chase entries (e.g. FordFocus
bonnet (0, 0.70, 1.05) / bumper (0, 0.45, 1.80); AudiS1 bonnet (0, 0.85, 0.70), chase y 1.3 → 1.4; Escudo chase
y 1.3 → 1.5); the enabled flags, chase-high, tether and look-back entries are identical on all 29. The port ships
them in `cars/<Name>/cars.json` `camera` and applies them for the player car (docs/orig/cars.md §2 "Cameras").

**Chase camera** (entries 5-8), per rendered frame:
```ts
const v = B.vL.z;                                         // forward speed m/s
let f = v <= 0 ? v / 55 + 0.2 : v < 2 ? 0.2 : v < 19.5 ? 0.2 + (v - 2) * 0.0342936 : 0.8 + (v - 19.5) * 0.01;
f = clamp(f, 0, 1);                                        // 0.2 at 2 m/s ... 1.0 at 39.5 m/s (142 km/h)
cam.blend += clamp(f - cam.blend, -0.025, 0.025);          // per frame (≈ 1.5/s)
const off = lerp(posA, posB, cam.blend), dist = len(off);
let dir = normalize(sub(cam.pos, car.pos)); if (justReset) dir = scale(carFwd, -1);
cam.pos = add(car.pos, scale(dir, dist));                  // leash: keep direction, fix distance
let extra = 0;                                             // extra height when nose-down
if (carFwd.y < 0) { const a = -Math.asin(Math.hypot(carFwd.x, carFwd.z)); extra = Math.min(p0 * 1.125 * a * a, p1); }
const ideal = add(car.pos, carRotate(off));
cam.pos.x += (ideal.x - cam.pos.x) * 0.04;                 // per frame: slow horizontal follow
cam.pos.z += (ideal.z - cam.pos.z) * 0.04;
cam.pos.y += ((car.pos.y + off.y - 3.0 * carFwd.y + extra) - cam.pos.y) * 0.42;  // per frame: fast vertical
cam.lookAt(car.pos + (0, 1.5, 0) world); cam.roll = 0;     // horizon always level
```
Result: a string camera that swings round slowly (the car visibly yaws in frame during slides, which shows
the slide angle) and rises and pulls back with speed.

**Bumper camera** (entry 0): rigid at posA in the car frame plus a G-sway offset
`d = clamp(-8·dt·Δv_local, ±0.15 x, ±0.10 y, ±0.15 z)` smoothed 15 % per frame; pitched down
`0.1 + sin²(25·t)·kmh·rough·2.4615e-5` rad, `rough` = sum over the 4 wheels of the surface roughness (§4.3).
**Tether cameras** (10, 12) [V, field meaning I]: keep the camera distance between min and max (scaled
by speed factor), pull toward the target distance at `stiffness·dt`; height only rises, toward
`car.y + 2·p0 + (dist + 0.5)/4 ± 1.5·pitch + (1 - s)`; look at the car, no roll; dt-based.
**Flipped-car camera**: when `car.up.y < 0`, all views switch to a free follow camera: distance kept in
4-8 m (pull-in gain 4·dt), rising toward `car.y + 0.25·dist` (gain 0.25·dt), kept ≥ 2 m above terrain,
FOV(deg) = `85.943665·atan(3.5/dist)`; clears once ≥ 3 wheels touch for 0.5 s.
`bodyShake*/shakeForce*` parameters belong to the animated driver figures, not the camera [V].

### 5.4 Reset rules [V FUN_004b3e50, FUN_004b3790; defaults at 0x4a2aab]

* **Manual reset**: reset button (> 0.5), only while the race is running (not during countdown/finish).
* **Automatic reset ("hand of god")**, checked every frame against the stage centre spline:
  |lateral offset| > **30 m**, or height relative to the spline < **-5 m**, or spline distance outside the
  stage's valid range.
* **Sequence**: 1.0 s fade; controls disabled. At 0.5 s remaining, teleport to the centre-spline point at
  `max(currentDistance - 20 m, validRangeMin + 1 m)`, raised **+1.5 m**, heading toward the spline point 1 m
  further on, roll 0; zero linear and angular velocity, wheel spins 0; run **100 settle steps** (handbrake 1.0);
  fade in. **No time penalty**; the clock keeps running (cost ≈ 1 s + 20 m).
  [V 0x4b3f0b-0x4b3f25: `fld [esi+0x174]; fadd 1.0 (0x7fc798); push 20.0 (0x41a00000); call 0x74d980`. The floor is
  the player's range minimum +0x174 (the stage's `race.splineRange` minimum, the link INFERRED, docs/orig/race.md §3),
  not the start distance: on corsica-2-f (splineRange 550, start line 545) the floor is 551. Corrected 2026-10-30; the
  earlier "startDistance + 1 m" was wrong. Lap circuits have no splineRange (±FLT_MAX): 20 m back, across the line.]
* Pacenotes are not replayed after a reset (§5.7).
* **AI stuck rule**: below 30 km/h for 20 s → reset in place (0 m back) [V code, I applies to AI].
* [D] rally-web may add a "stuck" auto-reset for the player using the same rule if playtests need it.

### 5.5 Pre-race setup options [V FUN_00499ab0, 0x499b52-0x499c82; value order I]

| option (menu order) | stored | values for index v = 0/1/2 | effect |
|---|---|---|---|
| tyres | tyre type | 0..4 | tyre table column (§4) |
| transmission | auto/manual | 0 auto | §2.2 |
| brake balance (rear/middle/front) | `setup.brake = 0.8 + 0.2v` | 0.8 / 1.0 / 1.2 | front cap ×1.25·m, rear ×(2 - 1.25·m) → front share 50 / 62.5 / 75 % |
| power ratio (AWD only) | `setup.powerRatio = 0.8 + 0.2v` | 0.8 / 1.0 / 1.2 | AWD front factor fs (§2.3.4) |
| suspension (soft/medium/hard) | `setup.suspension = 0.7 + 0.3v` | 0.7 / 1.0 / 1.3 | multiplies SpringK and DampK |
| gear ratio (short/medium/long) | `setup.gearRatio m = 0.8 + 0.2v` | 0.8 / 1.0 / 1.2 | gears R,1-4 × m, gears ≥ 5 × (2 - m); shift speeds rebuilt |
| steering (loose/tight) | `steerSensFast = (v != 0)` | false / true | selects StaticSlipAngleSlow (F 0.08, R 0.10: front lets go first) or Fast (F 0.12, R 0.06: rear lets go first, default) |

Which label maps to which index is not recovered; [D] rally-web labels: steering "Stable" = Slow, "Agile" =
Fast (default); gear ratio "Short" = m 1.2 (gears 1-4 numerically higher). Note the steering option does not
change steering rate or lock [V].

### 5.6 Damage (optional, DEV-5) [V FUN_006ca420; damage source not found]

Off by default. If enabled, values are clamped and re-applied every step while racing:

| damage | clamp | effect |
|---|---|---|
| steer (per front wheel) | ±0.05 rad | added to that wheel's steer angle (pull / toe) |
| suspension (per wheel) | ≤ 0.25 | SpringK and DampK × (1 - d) |
| brakes (per wheel) | ≤ 0.25 | brake capacity × (1 - d) |
| engine | ≤ 0.25 | TorqueScale × (1 - d); random misfire when > 0.25 (`T *= 1 - rand(0..127)/256·d`) |
| gearbox | flags | 1st/3rd ×0.9, 2nd/4th ×1.1 ratios; 2nd and/or 4th skipped; random gear pops every 0-7 s above 10 km/h |

### 5.7 Race-structure hooks used by mechanics [V]

* Pacenotes: authored list `{distanceAlongSpline, words[≤8]}`; each frame the last note with
  `distance ≤ playerDistance` fires once if unplayed and `|lateral| < 20 m`; marked played even when not spoken;
  purely positional (no speed look-ahead); up to 3 icons shown [V FUN_0074b620]. rally-web uses its own
  vocabulary (severity ladder × direction × modifiers × hazards).
* Rally/hill-climb stages: start + 6 timed checkpoints (last = finish); lap races: 2 triggers per lap.

---------------------------------------------------------------------------------------------------

## 6. Live tuning panel (lil-gui)

Every key below is a live parameter; changes apply on the next substep (rebuild derived values: brake caps,
ratios, shift speeds, inertia, frontShare2). Group = lil-gui folder. Defaults are the shipped values
(§3) or the selected archetype. A "Reset to original" button restores §3; "Copy JSON" exports the set.

**Simulation**
| key | default | min | max | step | note |
|---|---|---|---|---|---|
| `physicsHz` | 120 | 120 | 120 | – | read-only (see §1.2) |
| `timeScale` | 1 | 0.1 | 2 | 0.05 | slow motion for debugging |
| `gravity` | 12 | 8 | 16 | 0.1 | m/s² |
| `airGravityGrowth` | 1.065 | 1.0 | 1.2 | 0.005 | per step |
| `airGravityMax` | 1.45 | 1.0 | 2.0 | 0.05 | |
| `airLinDamp` | 2.0 | 0 | 6 | 0.1 | m/s², free flight |
| `airAngDamp` | 1.0 | 0 | 4 | 0.1 | rad/s², free flight |
| `archetype` | awd_wrc | – | – | – | dropdown |

**Body**
| key | default | min | max | step |
|---|---|---|---|---|
| `mass` | archetype | 600 | 2000 | 10 |
| `inertia.x / .y / .z` | 1.25 / 1.45 / 0.50 | 0.2 | 3 | 0.05 |
| `airKZY` | 1.25 | 0 | 5 | 0.05 |
| `airKZZ` | 2.0 | 0 | 6 | 0.05 |
| `mountY` (all wheels) | archetype | 0.0 | 0.5 | 0.01 |

Note on `mass`: above about 1440 kg the original's `hardSpring` rule blocks sleep and the car jitters at
standstill (§2.10). Keep that (original behaviour) or enable DEV-7 (`heavyCarSleep`).

**Engine**
| key | default | min | max | step |
|---|---|---|---|---|
| `torqueScale` | archetype | 300 | 2500 | 5 |
| `torqueScaleFactor` | 1.0 | 0.5 | 2 | 0.01 |
| `minRpm` / `cutRpm` | 1000 / 8250 | 500 / 6000 | 2000 / 9400 | 50 |
| `lowGearFill` (gain 1e-4, gears < 3) | 1e-4 | 0 | 4e-4 | 1e-5 |
| `useSpinTorque` / `spinTorqueScaleValue` | true / 10 | – / 0 | – / 20 | 0.5 |
| `turboSize` | 1 | 0 | 2 | 0.1 |
| `turboMaxGain` (0.75) | 0.75 | 0 | 1.5 | 0.05 |
| `turboSpinup` | 1.0 | 0.25 | 4 | 0.05 |
| `turboIdle` / `turboWasteGate` (boost range) | 0.1 / 100 | 0.01 / 1 | 100 / 200 | 0.01 / 1 |
| `turboSpoolThrottle` (spool above, decay at or below; turbo lag after part throttle) | 0.5 [V] | 0.05 | 1 | 0.01 |
| `engineBrakeGain` (0.75) | 0.75 | 0 | 2 | 0.05 |
| `engineBrakeBase` (5000) / `perGear` (700) | 5000 / 700 | 0 / 0 | 10000 / 2000 | 50 |
| `throttleMinLimit` | 0.1 | 0 | 0.3 | 0.01 |
| `useAntiSpin` / `antiSpinFactor` | false / 8 | – / 1 | – / 20 | 0.5 |

**Gearbox**
| key | default | min | max | step |
|---|---|---|---|---|
| `transmission` | auto | – | – | auto/manual |
| `gearRatio[1..n]`, `gearRatio[0]` | archetype | 0.4 / -5 | 5 / -1 | 0.01 |
| `finalDrive` | 5.6 | 3 | 8 | 0.05 |
| `wheelRadius` | 0.30 | 0.25 | 0.40 | 0.005 |
| `timeChangeGear` / `timeChangeGearFR` | 0.10 / 0.15 | 0 | 0.6 | 0.01 |
| `autoShiftTimeMul` (1.5) | 1.5 | 1 | 3 | 0.1 |
| `downGearFactor` | 0.775 | 0.5 | 0.95 | 0.005 |
| `minRpmGearChange` | 4000 | 2000 | 7000 | 50 |
| `maxTorqueRpm` / `maxTurboTorqueRpm` | 6500 / 6750 | 4000 | 9000 | 50 |

**Drivetrain**
| key | default | min | max | step |
|---|---|---|---|---|
| `wheelDrive` | archetype | 0 | 2 | 1 |
| `fwdFrontBias` (1.5 → 75 %) | 1.5 | 1.0 | 2.0 | 0.05 |
| `rwdRearBias` (1.25 → 62.5 %) | 1.25 | 1.0 | 2.0 | 0.05 |
| `awdSplit fs` (1.0 → 50 %) | 1.0 | 0.6 | 1.4 | 0.02 |
| `lsdClamp` (0.5..1.5) | 0.5 | 0 | 1 | 0.05 |
| `rollK` | 1.00596 | 0 | 4 | 0.01 |
| `wheelInertia` (inverse) | 0.050027 | 0.01 | 0.2 | 0.001 |
| `launchMulFront / Rear / AWD` (4 / 20·0.2 / 25·0.2) | on | – | – | toggle + scale 0..2 |

**Brakes**
| key | default | min | max | step |
|---|---|---|---|---|
| `brakeTorque` | 4000 | 1000 | 8000 | 50 |
| `brakeBalance` | 1.25 | 0.8 | 1.6 | 0.01 |
| `brakeHalfZone` (0.75 / 0.5) | 0.75 | 0 | 1 | 0.05 |
| `handBrakeTorque` | 3500 | 0 | 8000 | 50 |
| `hbFront` / `hbRear` | 0.3 / 1.3 | 0 / 0 | 1 / 2 | 0.05 |
| `useAbs` / `absFactor` | true / 0.75 | – / 0.05 | – / 1 | 0.01 |
| `engineBrakeConstant` | 4000 | 0 | 8000 | 50 |
| `lockTorque` / `lockOmega` (1000 / 3.14) | 1000 / 3.14 | 0 / 0 | 5000 / 10 | 10 / 0.1 |

**Suspension**
| key | default | min | max | step |
|---|---|---|---|---|
| `springK` | 35000 | 10000 | 100000 | 500 |
| `dampK` | 5000 | 500 | 20000 | 100 |
| `springLength` | 0.75 | 0.3 | 1.2 | 0.01 |
| `rollStiffness F / R` | 14200 / 15000 | 0 | 40000 | 100 |
| `damperCap` | 60000 | 10000 | 100000 | 1000 |
| `antiPogo` (32000, 5000, 2 m/s) | on | – | – | toggle |
| `setup.suspension` | 1.0 | 0.5 | 1.5 | 0.05 |

**Tyres**
| key | default | min | max | step |
|---|---|---|---|---|
| `latPosK` / `longPosK` | 5.00238 / 5.39649 | 0.5 | 15 | 0.05 |
| `latNegK` / `longNegK` | 0.053606 / 0.176533 | 0 | 0.6 | 0.005 |
| `rebuildLoadTable` (on PosK/NegK change, §2.6.1) | on | – | – | toggle |
| `tireRelaxK` | 1.60723 | 0.2 | 6 | 0.05 |
| `alignMomScale` | 0.126552 | 0 | 0.5 | 0.005 |
| `staticSlipAngleFast F / R` | 0.12 / 0.06 | 0.01 | 0.3 | 0.005 |
| `staticSlipAngleSlow F / R` | 0.08 / 0.10 | 0.01 | 0.3 | 0.005 |
| `steerSensFast` | true | – | – | toggle |
| `slipRatioThreshold` (0.075) | 0.075 | 0.02 | 0.3 | 0.005 |
| `momentXDist` / `momentZDist` | 0.060145 / 0.080006 | 0 | 0.4 | 0.005 |
| `loadTableScale` (multiplies Palpha, Pkappa) | 1.0 | 0.5 | 2 | 0.05 |
| `muGlobalScale` [D] | 1.0 | 0.3 | 1.5 | 0.01 |

**Assists**
| key | default | min | max | step |
|---|---|---|---|---|
| `twStaMy` | 0.418 | 0 | 2 | 0.01 |
| `twStaSteer` | 2.2428 | 0 | 6 | 0.01 |
| `twKinSteer` | 1.7045 | 0 | 6 | 0.01 |
| `twMaxMom` | 5.7039 | 0 | 15 | 0.05 |
| `twMomLimStart` | 1.1242 | 0.2 | 4 | 0.01 |
| `twMomLimScale` | 1.5147 | 0 | 4 | 0.01 |
| `assistSpeedLo` / `assistSpeedSlope` (25 km/h / 0.02) | 25 / 0.02 | 0 / 0.005 | 80 / 0.1 | 1 / 0.001 |
| `driftGripBeta` / `driftGripGain` (0.125 / 0.2) | 0.125 / 0.2 | 0 / 0 | 1 / 1 | 0.005 / 0.01 |
| `bigBetaThreshold` / `bigBetaGain` (0.75 / 0.3) | 0.75 / 0.3 | 0 / 0 | 1.5 / 1 | 0.01 |
| `bigBetaSymmetric` (DEV-1) | true | – | – | toggle |
| `sideFillBase` / `sideFillCap` (0.25 / 10000) | 0.25 / 10000 | 0 / 0 | 1 / 30000 | 0.01 / 500 |
| `driftDriveBoost` (0.5) | 0.5 | 0 | 2 | 0.05 |
| `sideFrictionFactor` | 1.4 | 1 | 3 | 0.05 |
| `wheelContactFactor` / `bodyContactFactor` | 0.003125 / 0.05 | 0 | 0.02 / 0.3 | 0.0005 / 0.005 |
| `smoothYawFrictionSign` (DEV-3) | false | – | – | toggle |
| `sleepPedalThreshold` (DEV-6) / `heavyCarSleep` (DEV-7) / `smoothSideFillGate` (DEV-8) | false / false / false | – | – | toggles |
| `settleToEquilibrium` (DEV-9) | true | – | – | toggle |
| `wheelspinLimiter` | on | – | – | toggle |
| `flipAssist` | on | – | – | toggle |

**Steering & input**
| key | default | min | max | step |
|---|---|---|---|---|
| `wheelScale` (max lock) | 0.40 | 0.2 | 0.8 | 0.01 |
| `lowSpeedLockKmh` / `lowSpeedLockGain` | 40 / 0.005 | 0 / 0 | 80 / 0.02 | 1 / 0.0005 |
| `steerTweak` | 0.05 | 0 | 0.2 | 0.005 |
| `keySteerStart` / `keySteerRate` | 0.05 / 2.0 | 0 / 0.5 | 0.3 / 8 | 0.01 / 0.1 |
| `keyThrottleStart` / `Rate` | 0.10 / 2.0 | 0 / 0.5 | 1 / 8 | 0.01 / 0.1 |
| `keyBrakeStart` / `Rate` | 0.20 / 1.5 | 0 / 0.5 | 1 / 8 | 0.01 / 0.1 |
| `keyHandbrakeStart` / `Rate` | 0.50 / 1.0 | 0 / 0.5 | 1 / 8 | 0.01 / 0.1 |
| `steeringType` | 1 | 0 | 1 | 1 |
| `sqrtCurve` | per device | 0 | 2 | 1 |
| `steerSensitivity` | 1.0 | 0.5 | 2 | 0.05 |
| `padDeadzone` | 0.1 | 0 | 0.4 | 0.01 |
| `pedalDeadzone` [D] (analog throttle/brake/handbrake) | 0.08 | 0 | 0.2 | 0.01 |

**Surfaces** (pick surface + tyre type in dropdowns; edits the live table)
| key | default | min | max | step |
|---|---|---|---|---|
| `bestStatic` | table | 0 | 3 | 0.005 |
| `diffStatic` | table | -0.6 | 0.2 | 0.005 |
| `scaleKinetic` | table | 0.4 | 1.0 | 0.005 |
| `bestRollK` / `diffRollK` | table | 0 | 25 | 0.01 |
| `frictionLevel` | table | -2 | 3 | 0.05 |
| `maxDepth` / `bump` | table | 0 | 0.1 | 0.001 |
| `bumpFlag` / `deep` | table | – | – | toggles |

**Camera**
| key | default | min | max | step |
|---|---|---|---|---|
| `fov` | 70 | 50 | 100 | 1 |
| `chase.posA` / `posB` (x, y, z) | entry table | -10 | 10 | 0.05 |
| `chase.horizLerp` / `vertLerp` (per 60 Hz frame) | 0.04 / 0.42 | 0.005 / 0.05 | 0.3 / 1 | 0.005 |
| `chase.blendRate` | 0.025 | 0.005 | 0.1 | 0.005 |
| `chase.lookAtHeight` | 1.5 | 0 | 3 | 0.05 |
| `bumper.pitch` | 0.1 | 0 | 0.3 | 0.01 |
| `bumper.shakeGain` | 2.4615e-5 | 0 | 1e-4 | 1e-6 |

**Debug overlay** (read-only): speed, rpm, gear, shift state, boost, per wheel {mode, Fz, μ, α (deg), κ,
Fx, Fy, ω}, β (deg), yaw rate, yaw caps active, airMul, nContacts, surface ids.

### 6.1 Built-in presets (v1.3, never active by default)

The Presets folder lists these first (marked ★; `src/sim/presets.ts`), above the user's saved presets. Loading one
sets the car to the SHIPPED parameters of its archetype plus the preset's overrides, keeping the race-selection
choices (tyre, transmission, §5.5 setup menu, steering option); input, camera and surface tuning are untouched.
"Reset to original" restores §3.

**"Arcade drift (DEVIATION)"** [D, deliberately not the original]. Purpose: A/B the remembered "big controllable
4WD slides" against the faithful model. Levers are the terms the v1.3 audit found limiting (§7 drift hold): the
per-axle lateral balance under power (drive split, longitudinal load transfer `momentZDist`), TWKinSteer (the only
yaw torque while sliding) and the turbo spool that gates power-on rotation.

| key | shipped | Arcade drift | applies to |
|---|---|---|---|
| `wheel.*.twKinSteer` | 1.7045 | 2.5 | all |
| `turboSpinup` | 1 | 0.5 (boost spools 2× faster) | all |
| `setup.awdBaseSplit` | 1 (50/50) | 0.8 (40/60 F/R) | awd_wrc |
| `wheel.*.momentZDist` | 0.080006 | 0.06 / 0.04 | awd_wrc / fwd_hatch |
| `fwdFrontBias` | 1.5 (75/25) | 1.1 (55/45 F/R) | fwd_hatch |

Measured [M] on gravel with the §7 counter-steer probe: awd_wrc holds every target 10-40° at steer +0.05…+0.65
(shipped +0.40…+0.89), fwd_hatch 10-40° at +0.31…+0.78 (shipped: none), rwd_classic 10-45° (unchanged); on sand
and mud awd holds 10-45° / 10-40° and fwd 10-40°. Side effects: T6 recovery 0.45-0.52 s, T7 ≤ 3.4° (v1.5: rwd with a spooled turbo holds a 5-6° power-on attitude for ≈ 2 s at 100 → 190 km/h, max 6.2°, then 3.7°; the ride-height fix lowers the tyre contact by 3 cm), T3 braking
unchanged (±1 %), T4 tarmac peak lateral within ±3 %; on the loose and icy surfaces the unfiltered T4 maximum moves
by -15…+13 % because the cars now drift in the steady-cornering bot (awd ice 1.33 g against 1.57, fwd gravel 2.20
against 1.94); fwd keeps its power understeer on corner entry (T9 window +58 %), the awd no longer tightens on power
(T10 +4 %) and drifts at ≈ 28° in the T11 cornering bot; 0-100 km/h is 0.4-0.6 s quicker (the boost arrives
sooner); the handbrake turn at 60 km/h is unchanged at 1 s (awd 89° vs 88°). For fwd_hatch the drive split is the
only lever found: without it the best is ≈ 15° (fwdFrontBias 1.25), so this preset's fwd is effectively a
front-biased AWD.

**"orig: class-4 AWD car"** [V config]: not a deviation. The class-4 4WD medians of §3.2 on the awd_wrc body
(switches to awd_wrc): mass 1030, torqueScale 1340, 5 gears, FL (-0.698, 0.56, 1.077), RL (-0.750, 0.56, -1.323),
hull ±2.0. [M]: 0-100 km/h 3.5 s on tarmac; holds 10-45° on gravel at steer +0.29…+0.53.

No "alt:" preset exists for the one open reading on the slide path, the default index of the Loose/Tight steering
option (§8 #5): both values are already an opt-in menu choice (Steering: Agile = Fast, default; Stable = Slow).

---------------------------------------------------------------------------------------------------

## 7. Feel-validation tests (headless)

### 7.1 Harness

* World: infinite flat plane, uniform material, normal (0, 1, 0), unless stated. Car spawned at rest, wheels
  touching, then 100 settle steps (§1.2).
* Fixed 120 Hz stepping, no rendering. Inputs are written straight into `Controls` (input filter bypassed)
  unless the test is about the filter.
* Defaults: automatic gearbox, default setup, `steerSensFast = true`, tyre type matched to the surface
  (tarmac→0, gravel/gravelDeep/mud/sand/grass→2, snow→3, ice→4), all assists at shipped values, DEV toggles
  at defaults.
* Speed-hold bot (used to reach a test speed): `throttle = v < vT ? clamp((vT - v)·0.2 + 0.3, 0, 1) : 0`,
  `brake = 0`, steer 0, v in km/h of `|vL.z|·3.6`; consider the speed reached when `|v - vT| < 0.5` after ≥ 3 s.
* Cornering bot (constant steer): `throttle = clamp((vT - |vW|·3.6)·0.15 + 0.35, 0, 1)`.
* **Power-test start state (v1.2).** T7-T11 depend on the turbo state at the throttle step (§2.3.3), which the
  first `|v - vT| < 0.5` crossing leaves undefined (boost 0.1-1.0 depending on car and surface). Power tests
  therefore name their start:
  * *steady*: after reaching vT, 3 s more of the speed-hold bot (a steady cruise; boostFrac < 0.05);
  * *spooled*: *steady*, then 3 s of left-foot braking at vT (throttle 1, `brake = clamp((v - vT)·0.25 + 0.3,
    0, 1)`; boostFrac = 1);
  * *spec*: the literal v1.1 protocol (no extra hold), kept as a reference only.
  For T9-T11 the corner itself is still a transient (β and boost keep moving through the 4 s cornering bot),
  so their bounds are bands over four entry histories: a 3 s or 6 s steady straight, and a 2 s turn at steer
  ∓0.3 / ±0.3 before the 3 s straight (`tests/sim/harness.ts` `powerStep`).
* Metrics: `a_lat` = body-frame x component of (total world force / mass), expressed in g = 9.81 m/s²;
  heading = yaw angle; β = §2.5.0.

Expected values come from a planar reference implementation of §2 (flat ground, all wheels in contact,
contact depth 0.42 m, no suspension travel), labelled **[M]** (model-derived). In v1.1 they were re-run with
an independent full 3-D implementation of §2 (ray suspension, settle, auto box) at DT; Appendix C lists
what changed. Tolerances ±12 % unless stated
reflect integration and bot details. Values labelled **[E]** are estimates (analytic or from reviews).

### 7.2 Tests

**T1 Acceleration 0-60 / 0-100 / 0-160 km/h**, full throttle from rest, straight. [M]

| archetype | tarmac (tarmac tyres) | gravel (gravel tyres) | sand (gravel tyres) | mud (gravel tyres) | snow (snow tyres) | snow (tarmac tyres) |
|---|---|---|---|---|---|---|
| awd_wrc | 2.4 / 4.6 / 8.2 s | 2.7 / 4.8 / 8.5 s | 2.8 / 4.96 / 8.7 s | 2.8 / 4.98 / 8.9 s | 2.8 / 5.0 s | 5.0 / 9.4 s |
| fwd_hatch | 2.1 / 4.1 / 7.1 s | 2.3 / 4.3 / 7.5 s | 2.5 / 4.5 / 8.2 s | 2.6 / 4.7 / 8.65 s | 2.7 / 4.8 s | 10.0 / >15 s |
| rwd_classic | 1.5 / 3.2 / 4.9 s | 1.7 / 3.3 / 5.2 s | 1.77 / 3.4 / 5.3 s | 1.8 / 3.44 / 5.44 s | 1.9 / 3.5 s | 6.3 / 11.9 s |

Pass: within ±12 %. Ordering must hold: rwd < fwd < awd on all matched surfaces; tarmac < gravel < sand < mud;
gravel < snow; wrong tyres on snow at least 1.9× slower. (v1.3: the sand / mud columns, the original's loose rally
roads (§4.3.1), from running the model.)

**T2 Top speed**, 60 s full throttle on tarmac. [M] awd_wrc 210, fwd_hatch 213, rwd_classic 245 km/h
(±5 %). The car must still be in top gear. The HUD rpm jitters in 8251-9274 (limiter), while torque is looked
up at about 8590 rpm (awd at 210 km/h; torque not cut, §2.3.5). Top speed is the drag + rolling-resistance
balance. On deep gravel (awd, gravel tyres): < 140 km/h.

**T3 Braking from 100 km/h**, full brake (1.0) from steady 100 km/h, auto box, ABS on. Distance to < 0.2 km/h. [M]

| surface (tyre) | distance | time |
|---|---|---|
| tarmac (tarmac) | 15.7 m (13.8-17.6) | 1.1 s |
| gravel (gravel) | 22.1 m (19.5-24.8) | 1.6 s |
| sand (gravel), v1.3 | 26.4-26.6 m (23.5-29.8) | 1.92 s |
| mud (gravel), v1.3 | 27.8-28.1 m (24.6-31.2) | 2.03 s |
| snow (snow) / ice (ice) | 29.5-30.5 m (26-34) | 2.15 s |
| snow (tarmac tyres) | ≈ 105 m (90-120) | |
| ice (tarmac tyres) | ≈ 255 m (225-285), see note | ≈ 20.3 s |

Ice on tarmac tyres cannot reach 100 km/h: top speed ≈ 86 km/h [M]. The car sits in 3rd at the limiter
because the upshift uses world speed (< 87.3 km/h), and 0-60 takes about 20 s. For that row, initialise
`vW` = 100 km/h forward, all ω = v/R, gear 4, then brake 1.0.

All three archetypes within ±3 % of each other on the same surface (shared brakes and tyres).
**T3b Coast-down**: from 100 km/h, all pedals 0 for 1 s: mean deceleration 5.0-5.7 m/s² on tarmac/gravel, 5.0-5.5 on snow/ice
(engine braking + rolling + drag), snow/ice below tarmac. [M] (v1.1 said 4.2-5.2 on snow/ice; the spec-literal
reference gives 5.30 / 5.21.)

**T4 Peak steady-state lateral acceleration.** Reach 60 or 100 km/h (ice on tarmac tyres: 60 km/h only, see
T3), then hold steer ∈ {0.05, 0.1, 0.15, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0} with the cornering bot for 6 s;
average `a_lat` over the last 2 s. **Steady-state filter:** discard a steer value if the mean |β| over the
window is > 30° or the mean speed is < 0.85·vT; report the maximum of the rest ("filtered"). [M]

UNVERIFIED (metric): the unfiltered maximum, used for the fwd/rwd columns and by v1, includes runs where the
bot lost speed or the car spun. It depends on the bot: a different valid bot changes the low-grip values by
×1.5-1.7. The filtered awd values below come from one spec-literal sim. The fwd/rwd columns were not re-run
with the filter.

| surface (tyre) | awd_wrc filtered, 60 / 100 km/h | awd_wrc unfiltered | fwd_hatch (unfiltered) | rwd_classic (unfiltered) |
|---|---|---|---|---|
| tarmac | 2.59 / 2.76 g | 2.5-2.8 g | 2.6-2.9 g | 2.8-2.95 g (speed not held: spins into a drift) |
| gravel | 1.86 / 1.90 g | 1.9-2.0 g | 1.9 g | 2.1 g (drifting, β ≈ 40°) |
| snow (snow) | 1.43 / 1.39 g | 1.39-1.58 g (60 km/h max is a 34 km/h drift, β 37°) | 1.4-1.47 g | 1.5-1.6 g (drifting) |
| ice (ice) | 1.42 / 1.37 g | 1.37-1.57 g (same) | 1.4-1.47 g | 1.5-1.6 g (drifting) |
| snow (tarmac tyres) | 0.33 / 0.36 g | 0.55 g (speed collapses to 20 km/h) | | |
| ice (tarmac tyres) | 0.12 g (60 only) | 0.20 g (42 km/h) | | |
| ice (gravel tyres) | 0.51 / 0.57 g | 0.8-0.94 g (spinning, β 58-73°) | | |
| sand (gravel), v1.3 | 1.49 / 1.51 g | 1.67 g | 1.52-1.60 g | 1.78 g |
| mud (gravel), v1.3 | 1.45 / 1.44 g | 1.63 g | 1.46-1.52 g | 1.85 g |

Pass: filtered awd_wrc values ±12 %. Matched-tyre ratios on the filtered awd values (max over both speeds)
tarmac : gravel : sand : mud : snow = 1.0 : (0.66-0.80) : (0.50-0.61) : (0.48-0.59) : (0.48-0.60) (sim: 1 : 0.69 :
0.55 : 0.53 : 0.52). The fwd/rwd columns are
for ordering only (rwd ≥ awd on every matched surface).

**T5 Handbrake turn at 60 km/h on gravel.** From steady 60 km/h: steer 1.0 and handbrake 1.0 for 0.5 s with
throttle 0, then handbrake 0, throttle 1.0, steer held at 1.0. Heading change: [M]

| archetype | at 0.5 s | at 1.0 s | speed at 1.0 s | at 2.0 s |
|---|---|---|---|---|
| awd_wrc | 38° | 87° (75-100) | 32 km/h | 176° |
| fwd_hatch | 31° | 66° (56-78) | 31 km/h | 158° |
| rwd_classic | 39° | 96° (82-110) | 33 km/h | 224° |

Reference without handbrake (full lock, throttle 0, 1 s): awd 80°, fwd 50°, rwd 77°. Pass: the handbrake run
must turn more than the no-handbrake run within 1 s (+5° to +20°) while losing at least 40 % of the speed,
and the car must accelerate away (speed rising) within 0.3 s of releasing. Design target H1 (60-90° in about
1 s, accelerate away) is met.

**T5b Handbrake tap.** Same start, steer 0.6, handbrake 0.15 s, then throttle 0.6: heading change at 1 s vs.
the same input without the tap: +3° to +20° more (awd +8°, fwd +3°, rwd +18° [M]); no spin (heading change
< 120° at 1 s).

**T5c Handbrake hold.** Same as T5 but hold the handbrake 1.5 s: the car stops (< 5 km/h) by 1.0-1.2 s
with heading change 50-100° [M] (v1.1: 50-95°; the spec-literal reference with rwd_classic parameters gives 97.8°). Note: the review-based target "holding the handbrake > 1-1.5 s spins the car
> 180°" (H2) is NOT reproduced at 60 km/h by the model; at higher entry speeds it is (T5 at 2 s shows
> 158°). Do not tune toward H2 unless playtests ask for it.

**T6 Tarmac slide recovery (S1).** Tarmac, steady 80 km/h, steer 1.0 + handbrake 1.0 for 0.4 s, then steer 0,
handbrake 0, throttle 0.3. Peak |β| 12-15°, and |β| < 5° within 0.43-0.53 s [M] (target S1: < 1 s).

**T7 No sustained power slide on tarmac (S1).** Tarmac, steady 100 km/h, steer 0.3, full throttle for 3 s:
max |β| ≤ 4° for all archetypes [M], from every start state (spec / steady / spooled).

**T8 Power on gravel (D3, D4).** Gravel, 80 km/h, steer 0.3, full throttle [M, v1.2 start states, §7.1]:
* *steady* (turbo at idle): awd and fwd max |β| ≤ 4° over 6 s; rwd stays below 10° for the first 3 s (turbo lag,
  sim 4.8°) and passes 30° after 3-5 s (sim 4.0 s, by then at ≈ 95 km/h), then spins (≈ 49°).
* *spooled* (3 s of left-foot braking): awd and fwd ≤ 4°; rwd passes 30° within 1.5 s (sim 1.10 s, 52°).
* Reference, v1.1 protocol (*spec* start): awd/fwd ≤ 4°, rwd > 30° within 3 s (sim 33.8°), only because that rwd
  run starts at boost ≈ 0.11 (the bot was still accelerating).
The power oversteer of D3/D4 therefore exists but is gated by the §2.3.3 turbo spool [V].

Radius metric for T9/T10: `r = |vW| / |ω_y|`, **averaged over 0.2-0.5 s after the throttle step**, compared
with its value just before the step. Note that `r` is not the path radius while β changes: yaw rate
overstates curvature, and the course-rate radius `|v|/(course rate)` can move the other way (+15 % in T10).

**T9 FWD power understeer (D1).** fwd_hatch, gravel, *steady* start (§7.1), hold 80 km/h at steer 0.45 for 4 s
(cornering bot), then full throttle 1 s: `r` grows ≥ +25 % in the 0.2-0.5 s window and at 1 s (band over the
entry histories: window +61…+184 %); at steer 0.6 the window value grows ≥ +25 % (band +32…+79 %; v1.1's
"> +100 %" was never measured with the window, the spec-literal model gives +90 %) and the 1 s value > +100 %
[M]. Reference, v1.1 protocol: +27 % / +224 % at 1 s.

**T10 AWD mild power oversteer (D3).** awd_wrc, same protocol at steer 0.45 (*steady* start): `r` shrinks ≥ 2 %
in the 0.2-0.5 s window (band over the entry histories -3…-13 %; the v1.1 protocol gives -18 %, v1's -35 % was
not reproduced) and β reaches 15-22° by 1 s (sim 5.8-7.3° → 19.6-20.5°) [M]. At steer 0.6 `r` changes by less
than ±15 % (sim +1…+3 %). The shrink depends on how the car entered the corner: it is mild and short-lived.

**T11 Lift-off rotation (D5).** awd_wrc, gravel, *steady* start, hold 80 km/h at steer 0.45, then throttle 0 for
1.5 s, steer held: |β| rises from 5-8° to > 40° (sim 46-48°) and peak yaw rate rises ≥ 1.55× (band over the
entry histories 1.61-1.80×; the v1.1 protocol gives 1.96×, hence v1.1's ≥ 1.8× bound) [M]. fwd_hatch with the
same protocol: the model shows **no** lift-off snap (yaw-rate ratio ≈ 1.0, β unchanged). The review claim
"FWD rear snaps out on lift" (D1) is therefore NOT a property of the original model; treat as an open feel
question (§8), do not tune toward it by default.

**Drift hold (regression probe, not an [M] target; v1.3).** Gravel unless stated, reach 40 km/h, 2.5 s full
throttle, a 0.35 s handbrake flick at full lock with the throttle held, then 4 s at full throttle with a
counter-steer controller holding β at a target: `steer = 0.06·e - 0.006·dβ/dt + 0.1·∫e dt`, `e = βT - β` (deg),
clamped to ±1 with anti-windup (P-I-D). A target is *held* if ≥ 80 % of the 1-4 s samples are within ±8° and
|mean β − βT| ≤ 4°; the *max holdable* β is the largest target of 10, 15, … 50° up to which every target is held by
the P-I-D or, failing that, the P-D gains (`tests/sim/harness.ts` `maxHoldableBeta`). v1.2 used the P-D controller
only; its steady-state error is what produced the old headline "awd holds about 12-20°" (it still reads 12.4° /
20.4° mean β at the 20° / 30° targets).

Shipped model [M]:

| surface | awd_wrc | fwd_hatch | rwd_classic |
|---|---|---|---|
| gravel | 10-40° (30° at steer +0.68, 71 km/h; 40° marginal, 71 % at full lock) | none (β < 6° at full lock) | 10-45° (30° at +0.40, speed 109 km/h and rising) |
| sand | 10° only (under-rotates: 24° mean at a 30° target, oscillating) | none | 10-45° |
| mud | 10-40° (30° at +0.53) | none | 10-45° |

So the awd car CAN hold 30-40° but only by steering INTO the slide: there is no opposite-lock equilibrium
(TWKinSteer, §2.6 W13, is the only yaw torque that balances the rear's larger lateral moment under power: front load
falls from 52.2 % static to ≈ 47 %, the front spins more). Open loop, any steer ≤ +0.4 after a flick straightens
the car (the tyres return to GRIP and TWStaMy locks the yaw). The fwd car's rear returns to GRIP, so it cannot hold
a power slide; rwd holds slides while its speed runs away (drift push, §2.6 W16). Design targets S2/F1 ("throttle-
held drift through a medium corner, 30-45° slip normal") are met by rwd, by awd only with steer into the turn, and
not by fwd. The higher-power original 4WD classes hold more (§3.2). The non-default "Arcade drift" preset (§6.1)
is the A/B alternative; do not change the shipped values for it.

**T12 Yaw step response.** Steady 80 km/h, throttle 0.4, steer step 0 → 0.2: time to 63 % of the 1 s yaw
rate 0.12-0.17 s, tarmac 0.11-0.17 s (step-quantised sim result 0.117 s; fwd_hatch on snow: up to 0.4 s);
yaw rate at 1 s: tarmac 0.51-0.54, gravel 0.46-0.49, snow 0.40-0.43 rad/s [M].

**T13 Crest (no take-off).** Road profile: flat, then a convex vertical arc of radius 40 m spanning 15 m,
then a 5 % downslope. Cross at 60 km/h, no steering, throttle 0.5. Expected [E]: v²/R = 6.9 m/s² < 12 → at
least 3 wheels keep contact throughout; airMul stays 1; tyre loads stay at the static split (§2.5.5: no
crest unloading while wheels touch); heading change < 2°.

**T14 Crest take-off.** Same profile at 110 km/h (v²/R = 23 m/s² > 12): all wheels leave the ground within
the arc; airMul reaches 1.45 within 6 steps (0.05 s) of fewer than 3 contacts; while airborne the vertical
acceleration is -20.8 ± 0.5 m/s² while rising and -16.8 ± 0.5 m/s² while falling
(`1.45·(12 + AirKZY·v²/m) ± 2`, downforce included, §2.10); body rates decay at 1 rad/s²; horizontal speed
decays at about 2 m/s² plus drag. On landing no second airborne phase
longer than 0.05 s (anti-pogo cap). Airtime 0.2-0.5 s [E].

**T15 Ramp jump.** 10° take-off ramp at 100 km/h onto flat ground at ramp-top height: airtime 0.45-0.6 s
(≈ 0.53 s analytic vs 0.98 s with plain 9.81 gravity), ≈ 7 km/h speed loss, distance ≈ 14 m [E].
Feel target: "heavier once airborne" (A1 conflict resolved toward the original's ×1.45 gravity).

**T16 Gearbox.** Full-throttle run (T1): upshifts trigger at 40.4, 62.9, 87.3, 110.9, 139.5 km/h (±1 km/h,
world speed) for awd/fwd; each upshift has 0.15 s (18 steps) with zero drive torque. Coast from 140 km/h with
all pedals 0 (awd): 6→5 and 5→4 back-to-back at ≈ 96 km/h (the 5→4 decision reads the free-rev rpm left by
the clutch-open completion step, §5.2a), then 4→3 ≈ 66, 3→2 ≈ 52, 2→1 ≈ 36 km/h [M; mechanism V
FUN_006c6c60]. From 30 km/h, brake 1.0 until stopped, keep holding: gear becomes 1 below 5 km/h, then R
after 0.225 s; the held BRAKE pedal then drives backwards (pedal swap, §2.1) and the throttle pedal brakes.
Manual: upshift 0.10 s.

**T17 Input filter.** Keyboard throttle held from 0: 0.10 at the first substep, 1.0 at 0.45 s (±1 step). Steer key:
±0.05 then 1.0 at 0.475 s; release → 0 on the next substep; opposite key while at +0.6 → -0.05 next substep.

**T18 Deep surface bogging.** awd_wrc, gravelDeep, from steady 80 km/h coast 1 s: deceleration 8-11 m/s²
(rolling resistance ×5 plus body friction damping ≈ 0.0975·|v|) [M+E]. Grass (DEEP, tarmac tyres) costs
lateral grip (0.34 of tarmac) but gains ×1.4 lateral factor.

**T19 Reset.** Drive 31 m sideways off the spline: auto reset triggers; car placed 20 m back on the
centre line, +1.5 m, aligned; 100 settle steps; total control loss ≈ 1.0 s; race clock not adjusted.

**T20 Determinism.** Two runs of T1 with identical inputs produce bit-identical states (seeded RNG for the
rpm wobble). Required for ghosts and replays.

---------------------------------------------------------------------------------------------------

## 8. Open questions and unverified items

| # | Item | Status | What we do now |
|---|---|---|---|
| 1 | Chassis-ground collision (FUN_006d0970, surface BodyK/BodyKScale/Epsilon) | **resolved v1.5** [V executed, R]: hull probes + body solver ported literally (§2.9); open: the material-0x23 branch, the impact-effect outputs B+0x190..0x1d0, the source of the corner states phys+0xa8..0xb4 | the original's model |
| 2 | Body ground share `nb` in tyre loads (B+0x14c) | **resolved v1.5** [V, R]: the hull push direction's y while the hull touches; B+0x140 = nb/(nb + n) feeds the solver's friction | §2.5.5 |
| 3 | Hit semantics of the wheel ray (compression vs fraction, W+0xc0/+0xc4, written by the ray callback this+0x88) | **resolved v1.4/v1.5 [R]**: W+0xc0 = depth = dot(end − v0, n), W+0xc4 = cos = dot(n, ray) = −SL·(n·up), so c0/c4 = (SL − hitDist)/SL is a FRACTION (v1.4 read it as metres); the sink LOWERS the car; the bump pattern samples the ray end point W+0x94 | x = 1 − (sink + c0)/(c4·SL) (§2.5.3) |
| 4 | Base AWD split `setup.awdBaseSplit` (S+0x1c) initial value | **resolved v1.3** [V]: the constructor FUN_006d7720 writes `in_ECX[7] = 0x3f800000` (S+0x1c = 1.0); the only read is FUN_006c7170 `fs = S[+0x1c]·S[+0x8]` | 1.0 (50/50) |
| 5 | Setup menu value order (which label is index 0/1/2), esp. steering Loose/Tight | not recovered (v1.3: the default index decides Fast vs Slow; Slow cuts a held awd slide from 17.6° to 2.4° β, reference model at 101 km/h, steer 0.5 [M]) | our labels §5.5 [D]; default Fast (the most slide-friendly); both are a menu choice, which serves as the A/B |
| 6 | Original render/camera frame rate (camera constants are per frame) | unknown | 60 Hz reference [I] |
| 7 | Triggers of the two extra drags (phys+0x28 one-shot × 0.85; phys+0x44 × bodyBrakingFactorForTrack 0.4, both × (0.15 + kmh/1920)) | **phys+0x44 resolved v1.5** [V, R]: set by the player state machine FUN_004b3790 state 4 (race over); the drag is reproduced on the 360 post-finish steps of run 2 (§2.7). phys+0x28: the bush flag, set with phys+0x2c = collisionElasticConstant by the object pass FUN_004a7bc0 (0x4a86b5 / 0x4a86b8, 2026-10-30; never set in the traces, which had no bush contact) | phys+0x44: `ICarSim.setTrackBraking(factor)` (the race controller turns it on after the finish); phys+0x28: the flag is CarTelemetry.collision.bush, the drag is not ported |
| 8 | "Asphalt override" friction mode (phys+0xcc, forces tyre row 5+tyre and FrictionLevel ≤ 0) | **resolved v1.3** [V]: AI / non-local cars only, set from the player flags (§4.2) | omitted for the player (correct); matters only for AI / ghost pace calibration |
| 9 | Collision-to-damage mapping; whether damage occurs in normal play | not found | damage off (DEV-5) |
| 10 | Car–car collision response (FUN_004a7980 → FUN_006d4390) | not studied | use §2.9 impulses between hull points [D] |
| 11 | AI: class factor 0.725-1.0 passed to the AI object; split-time tables per car/stage | target [I] | AI out of scope here |
| 12 | Review claim D1 "FWD rear snaps out on lift-off" not reproduced by the model (T11) | model fact [M] | keep model; revisit in playtests |
| 13 | Review claim H2 "handbrake hold spins > 180°" not reproduced at 60 km/h (T5c) | model fact [M] | keep model |
| 14 | Menu track lengths imply 150 km/h average stage speed (dev ghosts); world scale unknown | [I] | our stages are authored to the model's speeds |
| 15 | `car_ThrottleTime`, `car_FrictionLevel`, `car_RollCenterY` | no reader [V] | unused |
| 16 | Tether camera field meanings (min/target/max order) | [I] | §5.3 description; tune visually |
| 17 | Material 0x23 "wave" sink (0.8 m cells) when the hull touches it | [V] code, material unknown | omitted |
| 18 | Steered-axle construction when mount z differs from WheelBasePos (only identical in shipped data) | [V] | use otherAxleZ = other wheel's mount z |
| 19 | Config-name → runtime-offset binding for `car_*` / `wheel_*` parameters | v1.3: verified for all 21 `wheel_*` fields and the drift-relevant `car_*` fields (handler binding, audit `cmdbind.py`); FUN_0074f0b0 copies without scaling or clamping; 0 mismatches between the shipped text and §3 | names as in §3.1 |
| 20 | T4 / T9 / T10 metric definitions (bot-dependent maxima, sampling instant) | UNVERIFIED | T4 steady-state filter; 0.2-0.5 s radius window (§7) |
| 21 | Low-speed behaviour: bang-bang tyre forces below 0.1 m/s, 2-step lateral limit cycle at 10-45 km/h, sleep defeated by pedals / mass > 1440 kg / 60 Hz | [M] from running §2; not observed in the original | keep original; DEV-6/7/8 available (off); [D] pedal dead zone; consumers average over ≥ 2 steps |
| 22 | awd_wrc on SAND under-rotates in the §7 drift-hold probe (max holdable 10° against 40° on gravel and mud; oscillating) | [M], cause not isolated (controller or model) | model kept; sand is now the main surface of `red-basin` |
| 23 | Remembered "big controllable 4WD slides" vs the model (awd holds 30-40° only by steering into the slide; fwd none) | v1.3 audit: spec and port faithful on the slide path; the memory fits the high-power 4WD classes (§3.2) and the sand / mud stages (§4.3.1) better than class 0 on gravel | non-default "Arcade drift" preset (§6.1) for A/B against the original |

---------------------------------------------------------------------------------------------------

## Appendix A. Disagreements between the two independent studies, and their resolution

Two independent reverse-engineering passes (A: bottom-up from parameter binding; B: top-down from the main
loop) plus three supporting studies were reconciled. Where they disagreed, the code was re-read for this spec.

| # | Topic | Claims | Resolution (evidence) |
|---|---|---|---|
| 1 | Gravity | A, B, controls: 12 m/s². Values study: 9.82. | **12** for the car [V `fmul [0x825df8]` = -12.0 at 0x6c825c]. 9.82 is AI/other objects. |
| 2 | Physics rate | B: fixed 120 Hz. Others: unknown. | **120 Hz** [V FUN_0040e2e0 → FUN_00412b50(0x78); FUN_006c4390]. |
| 3 | Wheel reaction while braking | A: applied when `brake < 1000 OR \|ω\| ≥ 3.14`. B: `brake < 1000 OR \|ω\| < 3.14`. | **B** [V asm 0x6cbfbe-0x6cbfd9: skip when brake ≥ 1000 AND \|ω\| ≥ 3.14]. Heavy brakes spin wheels down without ground feedback, then they lock. |
| 4 | Sliding wheelspin limiter | B only. | **Present** [V t_6caab0 slide branch]; it scales only the body force; the wheel reaction uses the unlimited Fx (§2.6 W15/W16). |
| 5 | Static slip angle selection | A: Fast if phys+0x46 else Slow. B: always Fast. Controls: menu byte = (v ≠ 0). Values: (v == 0). | Constructor sets 1 = Fast [V 0x6c4655]; menu writes `v != 0` [V fcomp/jnp at 0x499c68-0x499c7b]. A and controls are right; values study's (v == 0) was wrong. |
| 6 | Rolling resistance pool | A: 0.25·t own + 0.25·Σ0.75·t to every wheel. B: unsure. Values: "3/4 to the body". | **A** [V asm 0x6c7c4d-0x6c7d2c: pool on the x87 stack, second loop subtracts ω·0.25·pool]. |
| 7 | Aero | A, B: downforce along body up from forward speed², drag per WORLD axis. Controls: per local axis. | **A/B** [V asm 0x6c8259-0x6c8342: drag uses B+0x20..0x28 world velocity; q·up rows 0xa8/0xac/0xb0]. |
| 8 | Auto coast-downshift timer | A: not reloaded (completes next step). Controls: reloaded ×1.5. | **A** [V FUN_006c6c60: state = 2 without writing +0x10]. |
| 9 | Sleep condition | A: no pedals or park. B: "UseSpinTorqueDamping flag". | **A**: the byte is phys+0x74 (park) [V t_6caab0 tail]. |
| 10 | Suspension setup multiplier | A: spring and damper. Controls: one term. | **Both** [V FUN_006cf620: DampK W+0xf0 and SpringK W+0xec each × setup+0xc]. |
| 11 | WheelDrive 0 torque split | A: 75 % front / 25 % rear. Values: "0.5 per front wheel". | **A** [V constants 0x8061c4 = 0.5 (h = 0.5T), jump table 0x6c7e44: 1.5T·k, 1.5T·(2-k), 0.5T·k, 0.5T·(2-k)]. |
| 12 | Meaning of SpinTorque / TWStaMy / MomentXDist (design study guesses) | yaw assist / static μ / lever arms | launch torque bonus [V FUN_006c8050] / grip-mode yaw friction [V] / load-transfer gains [V FUN_006cfb50]. |
| 13 | WheelBasePos | "wheel mounting position" | holds the **same-side wheel of the other axle** [V Templates.con: FL gets the RL position]; only its z is used, as the Ackermann turning-centre line. |
| 14 | Flip-assist timer | not noted | runs inside the wheel loop: +dt per wheel, so the 4 s threshold is reached after 1 s [V]. |
| 15 | Yaw-cap clamp with negative limit | v1: original forces +\|lim\| when \|β\| > 2.75 - s; DEV-2. | **Unreachable** (v1.1): β = atan(-vx/vz), not atan2 [V fpatan(x, 1) at 0x6cb041], so \|β\| < π/2 and lim ≥ 0.179·TWMaxMom·Iyy ≈ 1.02 rad/s²·Iyy. DEV-2 withdrawn. |

## Appendix B. Provenance

* Executable decompilation and disassembly of the original (image base 0x400000); addresses as cited.
* Shipped configuration text: per-car physics/wheel files, the global surface/tyre table file, keymaps,
  camera blocks, per-stage tyre defaults.
* Studies reconciled: sim model A, sim model B, physics values reference, controls & camera study, design &
  feel study (manual, reviews, FAQs). Feel targets S1-S7, D1-D8, H1-H4, F1-F6, A1-A3 referenced in §7 come
  from the design study; where the model contradicts a review, the model wins and §8 records it.
* v1.1: two independent verification passes (code re-read; spec-literal 3-D simulation), see Appendix C.

## Appendix C. Verification log

v1 was checked by two independent passes. Pass 1 tried to refute 21 handling-critical claims against the
decompile, its own disassembly and constants read from the executable. Pass 2 checked every table value against
the shipped configuration and ran a full 3-D implementation of §2, written exactly as specified, through §7
at DT and 2·DT. Every refuted item below was re-confirmed in the code or the sim before it was changed.

**Confirmed without change** [V unless noted]: 120 Hz accumulator, 0.2 s clamp and 100-step settle; steer
lock and auto-reverse pedal swap; assist speed factor, κ threshold and β; slip-angle relaxation and κ; the
grip/slide machine, including the Fast/Slow static-slip-angle selection (a selection, not a blend; default
Fast); drift grip bonus incl. the signed-β quirk (DEV-1); combined-slip tyre force and all 80 `LOAD_TABLE`
floats; Pos/Neg K curves; TWStaMy/TWStaSteer/TWKinSteer and their signs; W14-W18; deep-surface
SideFrictionFactor; SpinTorque as a launch bonus; yaw torque and rate caps; suspension; tyre loads independent
of the springs; anti-roll; FWD/RWD/AWD splits and that gear ratio never scales wheel torque; torque curve and
turbo; brakes, ABS and handbrake; gravity 12 and aero. All §3/§4 table values (0 mismatches). [M] T1, T2,
T3 (matched tyres and snow on tarmac tyres), T3b, T5/T5b/T5c, T6, T7, T8, T15, T18, the gearbox upshift
speeds, static loads and CG height.

**Corrected (refuted)**:

| Where | Was | Now | Evidence |
|---|---|---|---|
| §0.2 | "heavily damped" load transfer | weak, one-step-lagged (there is no damping) | FUN_006cfb50 |
| §2.3.5, §5.2a, T2 | torque lookup sees the 8251-9274 rpm limiter jitter | torque is looked up before the jitter, at ≈ 8590 rpm (curve ≈ 0.74) at 210 km/h; the jitter reaches only the HUD/sound, the auto-box rpm test and free-rev | FUN_006c7170 calls FUN_006c7e70, then FUN_006c8050, then writes CutRPM+512+rand; FUN_006c7e70 overwrites rpm from wheel speed |
| §2.6.1 | lateral curve 0.97 peak at 26°, 0.92 at 90° (Dy omitted) | 1.00 (exactly μ·Fz) at 26°, 0.94 at 90°, 0.645 at 4.8°. Added: the table holds the curve peak locations and reciprocal peaks, so rebuild it when Pos/Neg K are tuned | recomputed from the executable's table; all 20 rows match the closed form to < 7e-5 |
| DEV-2, §2.8, App. A #15 | yaw-torque cap can go negative when reversing | unreachable; DEV-2 withdrawn | β = fpatan((-1/vz)·vx, 1) at 0x6cb03f-0x6cb041 |
| §2.10, T14 | air accelerations 19.4 / 15.4 m/s² | 1.45·(12 + AirKZY·v²/m) ± 2: 20.8 / 16.8 at 110 km/h (downforce stays on in the air) | FUN_006c8250 has no contact gate; §2.10 integrates Fext·airMul; sim -20.2 / -16.4 at 100 km/h |
| §3.2 | awd_wrc = "median" | wheel z is the per-axis mean (values unchanged) | the shipped car files |
| §3.2 | "peak total drive torque 6545" | renamed peak curve torque; added 1st-gear launch torque (21 300 N·m awd) | §2.3.2 |
| §5.1 | steer dead zone tested on y = (sens·\|x\|)²; digital pressed when raw > 0.5 | dead zone tested on \|x\| before squaring (tiny reversed output near centre kept); digital pressed when raw > 0; digital steer compares ≤ 0.04 | FUN_00752c00 |
| §5.2a | coast downshift uses the lower gear's upshift speed | the CURRENT gear's (shiftSpeed[g-1]) | FUN_006c6c60 reads [-4 + g·4]; kick-down reads [-8 + g·4] |
| T16 | coast downshifts only at rpm < 4000; throttle drives backwards in R | 6→5→4 chain at ≈ 96 km/h (clutch bit set on the completion step); the BRAKE pedal drives in R | FUN_006c6c60 sets flag 8 before the timer test; FUN_006c6b60 swap; sim |
| T3, T4, §4.5 | ice on tarmac tyres braked from steady 100 km/h: 207 m | top speed ≈ 86 km/h, so it cannot be reached; ≈ 255 m / 20.3 s from an initialised 100 km/h; T4 at 60 km/h only | sim: 86.4 km/h after 90 s, 0-60 20.1 s, 255.4 m |
| §1.2 | per-step terms include the flip timer; wheel-spin loop unstable off 120 Hz | flip timer is dt-based; at 60 Hz the observed failures are turbo spool, the sleep window and low-speed chatter (nothing diverges) | sim at 2·DT |
| §2.10, §6 | (implicit) sleep works for all masses | `hardSpring` blocks sleep above ≈ 1440 kg (1540 kg never sleeps) | 4500 N test in FUN_006caab0 tail; sim |
| T12 | tarmac t63 ≥ 0.12 s | 0.11-0.17 s (sim 0.117 s, one step = 8.3 ms) | sim |
| DEV-3, §3.1 | wording | chatter = 4·TWStaMy·μ·dt ≈ 0.033 rad/s per step; wheel inertia ≈ 890 kg equivalent mass | sim |

**Marked UNVERIFIED (uncertain)**, with the value kept:
* T4: the unfiltered maximum depends on the bot. Added a steady-state filter and filtered awd values. The
  fwd/rwd columns were not re-run.
* T9/T10: the radius depends on the sampling instant. Defined a 0.2-0.5 s window; T10 now reads ≥ 10 %
  shrink and keeps β 12-20°; the T9 fwd values are kept but not re-run.
* T11: yaw-rate ratio 1.96× against a ≥ 2× bound; relaxed to ≥ 1.8×.
* Low speed (§2.6 notes, §2.10): bang-bang tyre forces below 0.1 m/s, a 2-step lateral limit cycle at
  10-45 km/h, and sleep defeated by any pedal. Kept the original behaviour; added a [D] analog pedal dead
  zone (0.05) and optional DEV-6/7/8 (all off).
* Suspension ray outputs W+0xc0/+0xc4 (§2.5.3, §8 #3) and the config-name → offset binding (§3, §8 #19)
  remain [I].

**v1.2 (playtest review, rally-web build)**:

| Where | Was | Now | Evidence |
|---|---|---|---|
| §7.1, T7-T11 | power tests start at the first \|v - vT\| < 0.5 crossing | named start states (*steady* / *spooled* / *spec* reference); T9-T11 bands over four entry histories | the T8 rwd result is 4.8° (steady), 52° (spooled), 33.8° (spec, boost 0.11) |
| T8 | rwd > 30° in 3 s | steady: < 10° in 3 s, > 30° within 3-5 s; spooled: > 30° within 1.5 s | §2.3.3 spool ×1.025 per step, decay at thr ≤ 0.5 |
| T10 | r shrinks ≥ 10 %, β 12-20° | steady start: ≥ 2 % (band -3…-13 %), β 15-22° | 9 entry histories |
| T11 | yaw ratio ≥ 1.8× | ≥ 1.55× (band 1.61-1.80×), β > 40° | same |
| T9 | steer 0.6: > +100 % (window, never measured) | window ≥ +25 % (+32…+79 %), 1 s > +100 % | same |
| T3b, T5c | snow/ice 4.2-5.2 m/s²; heading 50-95° | 5.0-5.5 m/s²; 50-100° | spec-literal reference 5.30 / 5.21 m/s², rwd 97.8° |
| §1.2, §0.3 | settle with sleep: body frozen 1-4.5 cm off equilibrium | DEV-9 (on): rests at the spring equilibrium (< 0.1 mm), launch bob ≈ 1 mm | sim, all archetypes, drops of 0 / 0.6 / 1.5 m |
| §5.1 | pedalDeadzone 0.05 | 0.08 | a pad trigger resting at 0.06 kept the car awake (creep, 15-35 mm bob) |
| §2.3.3, §6 | spool threshold hard-coded | `turboSpoolThrottle` (0.5 [V]), `turboIdle`, `turboWasteGate` in the panel | bit-identical at 0.5 (T20) |

Tools: tyre-curve recompute `re/tools/curve_chk.py`; table check `re/tools/spec_table_check.py`; sim
`study/spec_sim_check.py` and diagnostics `re/tools/diag_*.py` (scratchpad of the study session).

**v1.3 (drift-fidelity audit: "AWD holds only 12-20°, FWD < 6°, gravel only 6 % slower than tarmac, ice like
snow")**. Three lenses: code-diff (spec vs the original's code), params (spec vs the shipped data and stage
content), equivalence (TS port vs the Python spec reference). Scripts, traces and annotated disassembly in
`artifacts/audit/`.

*Confirmed without change*: every term that governs slide holding and the surface contrast, against the
disassembly and the float constants read from the exe: TWStaMy, TWStaSteer, TWKinSteer and Mz; the grip/slide
machine and its hysteresis; the static slip angle selection; the W10 grip bonuses; side fill; drift push; the yaw
caps; the combined-slip tyre force and its load table; slip relaxation; steering lock; the differentials; turbo
(per physics step at 120 Hz, TurboSpinup 1 shipped); friction tables; anti-roll and load transfer (signs, operand
order, wheel indices, per-step vs per-second). Port vs spec: the TS sim matches the reference to ≈ 1e-15 rad over
642-step slide traces (3 cars × 4 surfaces) and to < 1e-9 relative in every logged force of the hb30 / flick /
lift-off scenarios; the only divergence is the [D] hull contact in hard tarmac slides (§2.9). Data: 0 mismatches
over 83 car / wheel keys and all 10 surfaces; FUN_0074f0b0 copies without scaling; per-class scale factors and
difficulty change only AI target speed; ice tyres on ice ≈ snow tyres on snow (1.295 vs 1.310) is the shipped
table. Verdict: for the class-0 AWD car on gravel the original really behaves like the model.

| Where | Was | Now | Evidence |
|---|---|---|---|
| §4.3.1 (new), §4.1, §4.5, T1/T3/T4 | (implicit) the loose rally stages are GRAVEL | the original's desert / forest rally roads are SAND (≈ 78 %) / MUD (98-100 %); GRAVEL only on the gravel hill climbs and rallycross. rally-web `red-basin` → sand base (+ ≈ 14 % tarmac, 8 % gravel), `pine-ridge` → mud. New sand / mud rows: lateral 1.44-1.51 g (gravel 1.86-1.90), braking 26.6 / 27.8 m (22.1), 0-100 4.96 / 4.98 s (4.8) | per-face material bytes of each stage's `Track.gcm` (u32 nFaces + nFaces bytes after the index array; ids = the `c_MATERIAL_ROAD_*` enum, pushes 0x743b3b-0x74467d), face area within 3.5 m of the AI spline; `race.tyretype` and stage themes cross-check |
| §3.2 | awd_wrc presented as "the" 4WD car | it is the lowest power-to-weight 4WD class (4 of 26 AWD cars); 22 AWD cars are in classes 1-5 (class 1 equally weak); class-4 medians recorded (preset §6.1) | class table 0x847928, FUN_00488590 `switch(slot/6)`; PhysicsCar.con / Templates.con of all 29 cars |
| §4.2, §8 #8 | asphalt-override mode: setter not found | AI / non-local cars only: tyre row 5+tyre, FL = min(FL, 0) | FUN_004b3790 0x4b37e2-0x4b3805, FUN_004b3b00 via FUN_00488590 0x48922c-0x48923c, gate 0x6cb6cb-0x6cb6f7 |
| §8 #4 | AWD base split 1.0 [G] | 1.0 [V] | FUN_006d7720 `in_ECX[7] = 0x3f800000`; FUN_006c7170 `S[+0x1c]·S[+0x8]` |
| §8 #19 | config-name binding [I] | verified (21 wheel fields, drift-relevant car fields) | audit `cmdbind.py`, `cfg_vs_ts.py` |
| §7 drift hold | P-D probe: "awd holds ≈ 12° / 20° (targets 20 / 30°)" | P-I-D counter-steer probe + max holdable β: awd 10-40° steering into the slide, fwd none, rwd 10-45°; the P-D numbers were the controller's steady-state error | `tests/sim/harness.ts` driftHold / maxHoldableBeta; audit `ts_drift.test.ts` |
| §2.9, §8 #1 | — | note: [D] hull touches tarmac in ≈ 100 km/h handbrake slides (\|Δβ\| < 1e-4 rad) | audit `parity_tarmac2.mjs` |
| §6.1 (new), §0.3 | — | built-in non-default presets "Arcade drift (DEVIATION)" and "orig: class-4 AWD car" | `src/sim/presets.ts`, `tests/sim/presets.test.ts` |

Not changed: no spec or port error was found on the slide path, so the shipped parameters and §2 are unchanged.
What limits slides in the model (equivalence lens, reference model): awd holds only while all four tyres stay in
SLIDE, and the yaw balance under power favours the rear (rear yaw moment 14.0 vs 12.4 kN·m in a 30° hold), which
only TWKinSteer with steer into the turn balances; a rear μ ×0.85 or a 25/75 split would give a neutral /
opposite-lock drift. fwd: the rear drops back to GRIP and TWStaMy (≈ 1.5 rad/s² per gripping axle) stops the
rotation. The flick is limited by the yaw-rate cap (peak β 29.5° → 36.6° without it). Turbo lag gates power-on
rotation (rwd t30 4.0 s vs 1.9 s spooled) [M].

**v1.4 (runtime verification against the running original, Frida).** A Frida agent hooked the per-car physics
step FUN_006c6760 (called from the vehicle update at 0x752589 with ECX = PhysCar, a collision interface and a
`double dt`) and the tyre force FUN_006d0410, and saved raw snapshots of PhysCar, CarParams, the tyre-state block,
the rigid body, setup, upgrades and all four wheels (wheel list = PhysCar+0x58, next = W+0x08) before and after
every 1/120 s step. Recorded: an 18 s scripted manoeuvre run (full throttle, turn-in, handbrake, counter-steer,
braking, lift-off flick, full-lock handbrake) plus a complete 5-lap rallycross race driven by an autopilot that
followed the AI cars' recorded line (car: 1230 kg, TorqueScale 960, AWD, auto box, intermediate tyres; road
gravel 60 % / asphalt 39 % / grass 1 % of wheel-steps). Replay (`research/frida/`, gitignored): each recorded
pre-step state, the original's inputs and the original's ray results are loaded into rally-web's CarSim, one step
is run and compared with the original's post-step state; open-loop windows run 2 s on the original's inputs alone.

| Where | Was | Now | Evidence |
|---|---|---|---|
| §2.5.3, §8 #3 | `x = 1 - (sink + comp)/SL` (sink raised the body) | `x = 1 - (comp - sink/(SL·cosθ))/SL`: W+0xc4 = -SL·(up·n), W+0xc0 = comp·W+0xc4, so the sink LOWERS the body by ≈ 1.33·sink | extension of every grass wheel-step reproduced; before the fix one-step |v error| p90 0.66 m/s on run 1, after 1.6e-5 |
| §2.5.2 | bump pattern at last step's contact point | at this step's ray END point W+0x94/+0x9c (mount - up·SL); modulo FUN_006cfad0 | implied sink fits W+0x94 with median error 7.6e-6 m (contact point: 4e-4, last contact: 7e-3) |

Results after the fix, complete race (70,557 steps of the player car, 40 body-contact steps excluded):
one-step |v error| median 5.4e-7 m/s, p99 1.1e-4 m/s (actual |Δv| median 0.037 m/s); wheel ω error ≤ 1.1e-4 rad/s;
tyre loads ≤ 3.4e-7 relative; **0 grip/slide mode mismatches in 282,068 wheel-steps; 0 gear mismatches**. The
steps with |v error| > 0.01 m/s are 360 steps after the finish line (the original's post-finish braking factor,
not modelled) and 2 single steps where a wheel's |Vy| sits on the hard 0.0625 m/s side-fill gate (W18; float32 vs
float64 picks the other branch for one step, ≈ 2.5 kN for 1/120 s). Open loop: 270 windows of 2 s, end position
error median 7 mm (max 1.2 m). Tyre model: all 281,564 FUN_006d0410 calls reproduced by `tyreForce()` to float32
precision (Fy / Fx error ≤ 7.2e-5 of max(50 N, 5 % μFz); Mz, α_eq and the interpolated load-table row likewise).
Not covered by the runtime data: chassis-ground and object collisions (handled outside the step or excluded),
damage, the AI-only friction mode, manual gearbox, snow / ice / mud / sand surfaces (not on this track) and the
idle / rev-limiter rpm dither (different RNG; ±16 rpm idle, ±512 rpm at the cut).

**v1.5 (the ground interface on the original collision mesh; sim builder).** Tools (`research/frida/`, gitignored):
`susp_proof.py` (the compression term against the traces and the gcm port), `compare.audit.ts` (one-step and
open-loop replay; `MESH=<stage>` replays on the built collision part of the ORIGINAL Track.gcm, wheels and hull
segments included; `LEGACY=1` runs the v1.4 car.ts for comparison; `CARS=all CAR=… ORIGCAR=…` replays an AI car with
the §4.2 AI friction mode), `emu_body.py` + `bodysolver.audit.ts` (FUN_006d0970 executed in unicorn vs the port),
`port_hulls.py` (src/sim/origHulls.ts). The replay now hands the sim the recorded ray outputs c0 / c4 as
RayHit.depth / cos (v1.4 fed the fake distance SL − c0/c4) and its open-loop planes pass through each hit face
(`rayEnd − c0·n`; v1.4 used the contact point C+0x24, which sits 2-3 cm above the face).

| Where | Was | Now | Evidence |
|---|---|---|---|
| §2.5.3, §8 #3 | `x = 1 − (comp − sink/(SL·cosθ))/SL`, comp = SL − hitDist in metres | `x = 1 − (sink + c0)/(c4·SL)` with the ray's depth / cos: the compression is the FRACTION (SL − hitDist)/SL; the body rides ≈ 2.5 cm higher | recorded ext = the exe formula to ≤ 8.9e-5 over 302,945 wheel hits (metres formula: median 0.036); Δc0 = 1.000000·dot(Δend, n); open-loop end error 25-27 mm → 0.6-0.8 mm |
| §2.5.1 | raycast down the body axis | the original's one-sided SEGMENT mount → mount − SL·up with face-cache slot wheel + 24·car | on Track.gcm the sim's own rays reproduce the recorded c0 / c4 to 8.1e-5 m / 7.7e-4, 1 contact mismatch in 282,228 wheel-steps |
| §2.9, DEV-4, §3.4 | own impulse model on height queries, generic box hull | the original's hull probes (FUN_006cea90 tail) and body solver (FUN_006d0970) ported literally; the cars' Car_<Name>.col hulls | executed-exe equivalence on 3,000 states (float32); the 6 recorded contact steps reproduced to 2.7e-5 m/s |
| §2.5.5, §8 #2 | nb = 0 [G] | nb = B+0x14c (push direction y) while the hull touches; B+0x140 = nb/(nb + n) | FUN_006cfb50 switch; contact steps above |
| §2.7, §8 #7 | post-finish braking not modelled | phys+0x44 track braking `factor·(km/h/240·0.125 + 0.15)·Fext.y·vL` at the hull bottom centre | run 2 one-step max \|v error\| 0.285 → 0.016 m/s, max \|L error\| 108 → 7.7 N·m·s; open-loop max 0.355 → 0.012 m |
| §2.7 | chassis drags at (0, hullBottomY, 0) | at (0, (hull[0].y + hull[3].y)/2, 0) (identical for the box) | asm 0x6cd9xx: hull points 0 and 3 |

Results (human car FordEscort, rallycross1, run 1 / run 2; before → after):
* one-step, recorded rays: unchanged (|v error| median 5.4e-7, p99 4.0e-5 m/s on run 2; ext error ≤ 1.7e-4; 0 mode /
  gear mismatches), except the 360 post-finish steps now modelled (max |v error| 0.285 → 0.016 m/s);
* open-loop, 2 s windows on the hit-face planes: run 1 median 10 → 0.8 mm (max 793 → 2 mm); run 2 median 7 → 0.64 mm,
  p99 22 → 5 mm, max 355 → 12 mm (549 windows). The v1.4 car.ts on the same geometric planes: median 25 / 27 mm;
* closed loop on the original Track.gcm (wheels AND hull on the mesh, the car's own hull): one-step |v error| median
  3.2e-5 m/s, open-loop median 0.64 mm, p99 3.8 mm, max 12 mm (run 2; run 1 median 0.8 mm, max 1.4 mm); AI cars
  Micra / Corolla (AI friction mode) median 0.61-0.63 mm over 361-365 windows;
* synthetic self-test (rally-web's own trace in the original's layout): open-loop median 7 → 0.03 mm;
* tyre audit (281,564 FUN_006d0410 calls): unchanged (Fy / Fx ≤ 7.2e-5 relative).
Still not covered by runtime data: the anchor friction on real contacts (only executed cases), the material-0x23
branch, damage, manual gearbox, and every surface other than GRASS / ASPHALT / GRAVEL (their rows are verified
against PhysicsParam.con, §4.3).

---

## Appendix D. Car-car contact (phase 2, `sim-contact`)

Added in phase 2 (docs/PHASE2_AI.md). Normative spec: `research/formats/dynamics.md` §6.2-§6.3 and §7 (the original's
FUN_006d4390 body-body contact and FUN_004a7980's car-car loop); this appendix says how the sim implements it. Tags: **[E]**
exe-verified (addresses), **[X]** executed in unicorn, **[T]** checked against the Frida trace of the original, **[I]**
inferred. Code: `src/sim/contact.ts` (the pair loop), `src/sim/contact/solve.ts` (FUN_006d4390 / FUN_006d4fd0 / FUN_006d5240,
a line-by-line port of `research/tools/dyn_ref.py`), `src/sim/contact/hull.ts` + generated `carHulls.ts` (the full
`Car_<Name>.col` hulls), `CarSim.contactBody()` (the live view, the "contact body (phase 2)" region at the end of the class).

### D.1 The pair loop [E FUN_004a7980 0x4a7980-0x4a7bbe]

```ts
stepCarContacts(cars: readonly ICarSim[], dt): CarContactResult   // once per 120 Hz substep, after EVERY car has stepped
for (i = 0; i < n; i++)                                           // list order = [player, ...AI]
  if (cars[i].collidable)                                         // car+0x161, 1 from the constructor [E 0x74e478]
    for (j = i; j < n; j++)                                       // starts at i: the self pair is skipped
      if (cars[j].collidable && body[j] !== body[i] && contact(1, body[i], body[j]))
        { carHits++ and carStrength = B+0x19c of that body, on BOTH cars }
```

`contact` is FUN_006d4390 with flag 1. Unknown session flag `*(*0x8e4e14)+4 & 2` (skips the loop in the original; meaning [I],
dynamics.md §13) is not ported. `-multiplayer` (cap 10000 instead of 30000 N·s) is `setContactMultiplayer(true)`; default off.

### D.2 The body [E dynamics.md §7, §6.3]

All **18 points and 10 planes** of the car's `Car_<Name>.col` (FUN_006c45a0 → FUN_006d3f00 with the file's own counts), not
the 12 ground-probe points of `origHulls.ts`; planes by FUN_006d68e0 (float32), radius B+0x18 = max |p| over the 18 points
(FUN_006ca5e0). All 29 car hulls are outward-wound [D, dyn_survey]. Archetype cars (no `.col`) use the box of their probe
points as 8 points / 6 planes [I, tests only]. Mass, inverse inertia and the lagged angular velocity B+0x44 are the car's
own; the rotation rows are `right / up / fwd`; L and w are body-frame like the exe's. Vectors are shared with the car
(`pos`, `vW`, `L`, `w`, `invI`, axes, the anchor memory `bsPrevN` / `bsPrevC`), so the contact writes `v`, `L`, `pos.x/z`,
`prevN` (plane normal, or the 1.5 marker on the penetrating body) and `prevC` directly; the anchor timer B+0x134 := 0.2 is
committed to `bsT` (the next ground solve then expires the anchor before it reads the overwritten `prevN`/`prevC`
[E dynamics.md §6.3]) and the telemetry cache is dropped, so the next `step()` / `telemetry()` see the new state. The
angular velocity is not touched (each car recomputes w = I⁻¹L at its next step) [E].

### D.3 Record [E dynamics.md §7, sound.md §7]

`telemetry().collision.carHits` counts the contacts the car took part in (every substep of a sustained contact counts once
per pair); `carStrength` = this body's B+0x19c **after the latest contact** (max(entry value, j)), i.e. the record keeps the
latest contact's strength: a first hit of 3 534 N·s followed by separating substeps (j = 0) leaves 0 behind. That is the
original's behaviour (the record is overwritten by every contact), so a sound reader must read it at the hit (latch on a
change of `carHits`) or track its own maximum between reads. The fields are absent until the car has been through a
contact step (solo races never create the view; solo telemetry is bit-identical, D.5).

### D.4 What the contact does to the car, in practice

Measured on two Micras on a flat world (tests/sim/contact.sim.test.ts): a rear-end hit at 16 vs 5 m/s gives j = 3 534 N·s on
the first substep and the pair rolls on together at ≈ 10 m/s (the contact is inelastic by design: j = 0.8·v_rel /
(1/mA + 1/mB + rotation), the closing speed is reduced to ≈ 20 %, the overlap is then removed by the x/z position split by
mass ratio); a head-on at 14 + 14 m/s stays below the 30 000 cap; total kinetic energy never increases across a contact step;
a resting pair interpenetrating by 0.5 m is pushed apart in x/z with bounded velocities for 4 s.

### D.5 Proof

| claim | evidence |
|---|---|
| FUN_006d4390 / 4fd0 / 5240 on two **real car hulls** (18 points, 10 planes) equal the original | `research/tools/contact_emu.py` runs the exe function in unicorn: **8 000 random cases, 3 928 contacts** (slot 0: 2 346, slot 1: 1 582, i.e. both plane-owner branches; 129 at the 30 000 / 10 000 caps; 1 222 with j clamped to 0; 246 both-asleep early-outs; 3 826 sphere-only near misses; 29 hulls; 7 scenarios head-on / rear / side / T-bone / stacked / random / far; 25 % with `-multiplayer`): **0 disagreements** with dyn_ref (rel 5e-4), **0 plane-test ties** [X] |
| the TS port equals the executed original | `tests/sim/contact.fixtures.test.ts`: 2 200 of those cases (2 047 contacts) in `fixtures/contact/carcar.json.gz` (998 KB) replayed on the exact float32 inputs: max deviation v 1.0e-6, L 9.9e-6, B+0x19c 1.6e-5 (relative), position 7.8e-7 m, prevN 5e-7, flags / sleep / anchor timer exact [X] |
| the original **game** does the same | `research/tools/contact_trace.py` on the Frida trace of a 4-car rallycross race (run2, FordEscort / Micra / Beetle / Corolla; the hull of each car identified from the recorded mass + radius B+0x18): contacts run on the post-step snapshots in the original's pair order, compared with the next pre-step snapshots. 27 338 substeps have touching bounding spheres: **26 583 without contact in both** (port and original), **271 contacts reproduced** (v ≤ 2.7e-4 m/s, L ≤ 1.01 N·m·s, position push ≤ 5.0e-4 m, B+0x19c ≤ 0.34 N·s), 483 within 2 mm of a decision boundary (below), 1 differing only in the bookkeeping value B+0x19c. `tests/sim/contact.trace.test.ts` replays 332 stored cases (`trace_run2.json.gz`, 237 KB) [T] |
| two real `CarSim`s | `tests/sim/contact.sim.test.ts`: rear-end, head-on, side-swipe on a flat world and on `newzealand-1-f` (Track.gcm through src/world/orig): finite impulses ≤ 30 000, simFaults 0, no energy gain, not closing afterwards, carHits / carStrength on both cars; resting stacked pair bounded; telemetry cache invalidation; multiplayer cap; solo identity; 200 000 calls × 4 overlapping cars with a heap growth below 4 MB (no per-call allocation) |
| solo runs unchanged | 3 stages × 2 400 steps of a real Micra (corsica-1-f, newzealand-1-f with 102 object hits, hillclimb-1a-f with 22) with the full telemetry JSON hashed every step: identical with and without the contact region of `car.ts` (no view is created in a solo run, `carHits` stays absent) |
| in the browser, with the real AI | `artifacts/phase2/sim-contact/collision_*.png`: a Ford Focus AI car (111 km/h) hits the stationary player Micra from behind on rallycross-1-f; carHits / carStrength set, 0 console errors |

**Decision-boundary ties [X, T].** The overlap picks the plane owner by the smaller of two exit depths (FUN_006d4fd0:
`depth0 < depth1`). For two parallel faces pressed against each other (nose to tail) both depths are equal up to the float
noise: in the trace the pair at k = 43018 has depths 0.059738 and 0.059672 (6.6e-5 apart) while the original stores car
positions as float32 (ulp 2.4e-4 m at 2 000 m) and computes in x87; our float64 pick can be the other slot. Both picks are
valid contacts (impulse magnitudes differ by a few percent, the lever arm of the torque by up to 0.1 m: L differs by up to
a few hundred N·m·s on the 4 700 N·s hit). The 483 trace substeps in that class are shallow multi-car piles (depths below
2 mm). Not reproducible without float32 state; no "bit-faithful" mode is provided (dynamics.md §10.3).

### D.6 Deviations from the original (tagged)

* **Object-pass interleave [I].** The original runs `car i object pass → car i vs cars j ≥ i`, car after car. rally-web's
  `CarSim.step()` includes the car's own object pass, so every car's object pass happens before any car-car contact of the
  substep. The two orders differ only for a car that touches a static object and another car in the same substep: its object
  solver then sees the pre-contact velocity (and the contact sees the post-object-solver one) instead of the reverse, one
  impulse application (≤ one substep) earlier or later. No change to energy, no new contact, bounded by the same 30 000 N·s
  cap. Not worth splitting `step()` (that would touch the railing fixer's objectPass); the 271 trace contacts agree to 5e-4
  m with the unsplit order.
* **B+0x19c / B+0x144 sharing [I].** The exe's B+0x19c / 0x144 are written by the ground solver, the object solver and the
  contact alike (and cleared by each solver call). The sim keeps the ground and the object strengths in separate fields
  (`bodyStrength`, `objSolveStrength`); the contact reads the ground one as its entry value (`imp19c`) and keeps its own
  record (`carStrength`) without writing `hullMaterial` (0x40) / `hullStrength` back, so `collision.hull*` keeps describing
  the ground contact. Differs from the original only when a ground-slam strength above the contact's j coincides with the
  contact (the record's maximum then keeps the slam's strength) and in the one bookkeeping case of the trace.
* **Float64 / sim frame [I]** as for the loose parts (dynamics.md §10.3): matches single calls to ≤ 2e-5 relative, not
  the float32 chaos of near-tie contacts.
* The 0x190 / 0x194 / 0x1a0 record maxima and the contact points B+0x1a4 / 0x1b0 / 0x1bc are written into the view
  (`ContactBody`) and reset every substep; nothing in rally-web reads them (damage and skid sounds of the original do).

### 4.2a AI friction option (phase 2: `CarSimOptions.aiFriction`)

The AI friction mode of §4.2 is a first-class sim option: `CarSim` built with `aiFriction: true` takes a **private deep copy** of the surface table with the tarmac
(ASPHALT) tyre row's `bestStatic / diffStatic / scaleKinetic / bestRollK` on every surface [E 0x6c4978-0x6c49ac] and `frictionLevel = min(FL, 0)` [E 0x6cb6cb]
(`aiFrictionTable` in `src/sim/car.ts`, also applied by `setSurfaces`). Off (default): bit-identical to a car built without the option. The replay tool
`research/frida/replay.ts` uses it (`aiFriction: first.aiMode === 1`) instead of its former in-place table rewrite. Tests: `tests/game/ai/aiFriction.test.ts`; AI
notes: `docs/orig/ai.md`.
