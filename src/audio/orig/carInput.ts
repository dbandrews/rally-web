/**
 * src/audio/orig/carInput.ts — OWNED BY THE AUDIO BUILDER.
 *
 * rally-web telemetry → the CarSoundPlayer's car interface (carSound.ts CarSoundInput; the original's getters on
 * the car vtable 0x82f508 and the wheel components, research/formats/sound.md §4.1-§4.2). Pure (vitest).
 *
 * Exact mappings: rpm (display rpm incl. the limiter jitter, MECHANICS_SPEC §5.2a: "the jitter reaches the HUD and
 * sound"), speed (|vL.z| km/h, car vt+0x118 × 3.6), throttle / brake / handbrake, gear (0 = R), the wheel
 * materials (rally-web material → the original byte, constants.ts origFromMaterial; no contact → −1), the pose.
 *
 * The collision record (CarTelemetry.collision, the sim's port of what FUN_00746c80 / FUN_00746ec0 read):
 *   impact = the OBJECT record (+0x30/+0x34/+0x38) once per new object hit (collision.objectHits changed): type =
 *            the object's raw collisionMaterial (6 trees / wood → Tree, 1 → Hard, −1 → nothing), strength = impulse − 100
 *   body   = the hull contact read live (B+4 bit 0, B+0x144 material, B+0x19c = jn − 100), the original's units
 *   inBush = record +0x28 (collision.bush)
 *   A telemetry without the record (older fakes) falls back to the calibrated impact below.
 * The backfire / blow-out flags come from the shared source (FrameContext.carFlags, src/game/carFlags.ts).
 *
 * Calibrated (the wheel getters vt+0xe0 / +0xe4 / +0x108 are not traced, sound.md §15 Q1; documented in
 * docs/orig/audio.md):
 *   SlipX  = |tan α| of wheel 0 (the relaxed lateral slip the tyre model integrates, §2.6 W7; 1 at 45°)
 *   SlipZ  = |κ| per wheel (slip ratio, §2.6 W8); the player averages |·| over the 4 wheels
 *   bump   = suspension extension 1 − offset / springLength (MECHANICS_SPEC ext, 1 = full droop; the player plays
 *            the Bump patch below springDampingThreshold·1.15 = 0.69, i.e. past ~31 % compression)
 *   fallback impact (no collision record in the telemetry) = { type: the original material byte under the car,
 *            strength: impactImpulseMax / IMPULSE_PER_STRENGTH } (Hard ≥ 165 ≈ 1650 N·s)
 */
import { origFromMaterial } from '../../core/constants';
import type { CameraMode, FrameContext, SimV3 } from '../../core/types';
import type { CarSoundInput } from './carSound';

/** Shipped springLength (PhysicsParam / params.ts, every car). */
export const SPRING_LENGTH_M = 0.75;
/** N·s of rally-web impact impulse per unit of the original's collision strength (calibration, see above). */
export const IMPULSE_PER_STRENGTH = 10;
/** Impulses below this are resting contact, not a collision record (≈ 200 N·s per step at rest). */
export const IMPACT_MIN_IMPULSE = 50;
/** The in-car cameras (the original's camera modes 15 / 16 → Ouside = 0, 0x74671e). */
export const INSIDE_CAMERAS: ReadonlySet<CameraMode> = new Set<CameraMode>(['bumper', 'bonnet']);

/** Original material byte of each wheel contact (−1 = none). */
export function wheelMaterials(ctx: Readonly<FrameContext>): number[] {
  return ctx.telemetry.wheels.map((w) => {
    if (!w.contact) return -1;
    const b = origFromMaterial(w.material);
    return b === 255 ? -1 : b;
  });
}

/** The material byte most wheels are on (impact type), or −1 airborne. */
export function dominantMaterial(mats: readonly number[]): number {
  let best = -1;
  let n = 0;
  for (const m of mats) {
    if (m < 0) continue;
    let k = 0;
    for (const o of mats) if (o === m) k++;
    if (k > n) {
      n = k;
      best = m;
    }
  }
  return best;
}

export class CarInputMapper {
  private lastMaterial = 1; // ASPHALT until the first contact
  /** collision.objectHits at the last map (−1 = none seen yet): a change is a new object record. */
  private lastObjectHits = -1;
  /** collision.carHits at the last map (−1 = none seen yet): a change is a new car-car record (phase 2). */
  private lastCarHits = -1;
  readonly input: CarSoundInput = {
    rpm: 0,
    speedKmh: 0,
    throttle: 0,
    brake: 0,
    handbrake: 0,
    gear: 1,
    wheelMaterial: [-1, -1, -1, -1],
    slipX: [0, 0, 0, 0],
    slipZ: [0, 0, 0, 0],
    bump: [1, 1, 1, 1],
    outside: true,
    raining: false,
    impact: null,
    carHit: null,
    body: null,
    inBush: false,
    pos: { x: 0, y: 0, z: 0 },
    quat: { w: 1, x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
  };

  map(ctx: Readonly<FrameContext>): CarSoundInput {
    const tel = ctx.telemetry;
    const o = this.input;
    o.rpm = tel.rpm || 0;
    o.speedKmh = tel.speedKmh || 0;
    o.throttle = tel.throttle || 0;
    o.brake = tel.brake || 0;
    o.handbrake = tel.handbrake || 0;
    o.gear = tel.gear;
    const mats = wheelMaterials(ctx);
    o.wheelMaterial = mats;
    const sx: number[] = [];
    const sz: number[] = [];
    const bump: number[] = [];
    for (const w of tel.wheels) {
      sx.push(w.contact ? Math.abs(Math.tan(w.slipAngle || 0)) : 0);
      sz.push(w.contact ? Math.abs(w.kappa || 0) : 0);
      bump.push(w.contact ? 1 - (w.visual?.suspensionOffset ?? 0) / SPRING_LENGTH_M : 1);
    }
    o.slipX = sx;
    o.slipZ = sz;
    o.bump = bump;
    o.outside = !INSIDE_CAMERAS.has(ctx.cameraMode);
    o.raining = ctx.stage?.environment?.weather === 'rain';
    const dom = dominantMaterial(mats);
    if (dom >= 0) this.lastMaterial = dom;
    const col = tel.collision;
    if (col) {
      // the object record: set on the update after a new hit (a new CarSim restarts the count: resync only)
      const hits = col.objectHits;
      o.impact = this.lastObjectHits >= 0 && hits > this.lastObjectHits ? { type: col.objectType, strength: col.objectStrength } : null;
      this.lastObjectHits = hits;
      const ch = col.carHits ?? 0;
      o.carHit = this.lastCarHits >= 0 && ch > this.lastCarHits ? { strength: col.carStrength ?? 0 } : null;
      this.lastCarHits = ch;
      o.body = { contact: col.hull, type: col.hullMaterial, strength: col.hullStrength };
      o.inBush = col.bush;
    } else {
      const imp = Math.max(ctx.impactImpulseMax ?? 0, tel.impactImpulse ?? 0);
      o.impact = imp > IMPACT_MIN_IMPULSE ? { type: this.lastMaterial, strength: imp / IMPULSE_PER_STRENGTH } : null;
      o.body = null;
      o.carHit = null;
      o.inBush = false;
    }
    if (ctx.carFlags) {
      o.backfire = ctx.carFlags.backfire;
      o.blowOut = ctx.carFlags.blowOut;
    } else {
      delete o.backfire;
      delete o.blowOut;
    }
    copy(o.pos, tel.posSim);
    o.quat = { w: tel.quatSim.w, x: tel.quatSim.x, y: tel.quatSim.y, z: tel.quatSim.z };
    copy(o.vel, tel.velSim);
    return o;
  }
}

function copy(dst: SimV3, src: SimV3): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
}
