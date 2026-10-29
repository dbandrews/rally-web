/**
 * src/core/loop.ts — ARCHITECT-OWNED CONTRACT. Builders: import, do not edit.
 *
 * Fixed-step accumulator of §1.2:
 *   frameDt = min(0.2, wall-clock delta);  acc += frameDt·timeScale;  n = floor(acc·120);  acc -= n/120
 * No other cap on n. Physics always steps with DT = 1/120 (never scale DT; timeScale scales the
 * accumulator). Render interpolation alpha = acc·120 ∈ [0, 1) (§1.2 [D]): draw lerp(prev, cur, alpha).
 *
 * Pause: advance() returns 0 steps (alpha frozen) but frameDt is still reported so the UI keeps running.
 * Single-step: requestSteps(n) queues n steps that the next advance() returns even while paused.
 */
import { DT, PHYSICS_HZ } from './constants';

export { DT, PHYSICS_HZ } from './constants';

/** §1.2: per-frame wall-clock clamp. */
export const MAX_FRAME_DT = 0.2;

export interface LoopTick {
  /** Physics substeps to run now (each with dt = DT). */
  steps: number;
  /** Render interpolation fraction in [0, 1). */
  alpha: number;
  /** Clamped real frame time (s), unscaled. Use for cameras, UI, effects (§1.2). */
  frameDt: number;
}

export class FixedStepLoop {
  /** Slow motion / fast forward factor (§6 Simulation timeScale, 0.1..2). */
  timeScale = 1;
  paused = false;
  private acc = 0;
  private queued = 0;

  /** Seconds of physics time accumulated but not yet stepped (0 ≤ acc < DT after advance). */
  get accumulator(): number {
    return this.acc;
  }

  /** Feed one rendered frame's wall-clock delta (seconds). */
  advance(rawFrameDt: number): LoopTick {
    const frameDt = Math.min(MAX_FRAME_DT, Math.max(0, Number.isFinite(rawFrameDt) ? rawFrameDt : 0));
    let steps = 0;
    if (!this.paused) {
      this.acc += frameDt * this.timeScale;
      // tiny epsilon so exact multiples of DT do not lose a step to float error
      steps = Math.floor(this.acc * PHYSICS_HZ + 1e-9);
      this.acc -= steps / PHYSICS_HZ;
      if (this.acc < 0) this.acc = 0;
    }
    if (this.queued > 0) {
      steps += this.queued;
      this.queued = 0;
    }
    return { steps, alpha: Math.min(0.999999, this.acc * PHYSICS_HZ), frameDt };
  }

  /** Queue n extra steps for the next advance() (works while paused: single-step debugging). */
  requestSteps(n: number): void {
    this.queued += Math.max(0, Math.floor(n));
  }

  /** Drop accumulated time (after a stage load / long stall). */
  reset(): void {
    this.acc = 0;
    this.queued = 0;
  }
}

/** Convenience: seconds -> whole physics steps. */
export const stepsFor = (seconds: number): number => Math.round(seconds / DT);
