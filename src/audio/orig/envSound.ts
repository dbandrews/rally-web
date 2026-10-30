/**
 * src/audio/orig/envSound.ts — OWNED BY THE AUDIO BUILDER.
 *
 * Stage ambience: the WorldEnvironmentSound objects (`Object.create EnvSound* x/y/z` in the stage's Objects.con,
 * 15 templates in Misc/object/Sound_*.con, research/formats/sound.md §8) and their manager. Read from the decomp:
 *
 *   object ctor FUN_00797480: if patch 0 of its script has a looping layer (patch vt+0x24 = 0x7eb430, read from
 *     the disassembly: any layer with the loop flag) the patch is play()ed at creation, i.e. the crowd / applause
 *     loops start with the stage and are never stopped (their Distance ramps make them inaudible; a voice at
 *     volume 0 is freed and restarts from sample 0 when it becomes audible again, patch.ts).
 *   manager FUN_007960c0 (per update, cars' positions): a car whose position did not change since the last update
 *     adds 0.2 to a counter (else it resets to 0); while the counter is < 18, every object within 60 m of a car
 *     gets FUN_007979c0: patch 0 not active (vt+0x18) AND without a looping layer (vt+0x24) → `rand() % 20 == 0`
 *     → play(). So only the one-shot patches (cows, sheep, horns) are re-rolled. Both "stop" paths call
 *     FUN_005d9640, a 1-byte `ret` stub, so the manager never stops anything. (sound.md §8 says every patch 0 is
 *     re-rolled; the vt+0x24 test and the ctor start were missed there.)
 *   The multi-car early-out (FUN_00797a20 = patch vt+0x20 = 0x40ecf0 `mov eax,[ecx+4]` = the layer count, "== 1")
 *   only applies with more than one car; rally-web has one sound car (the player).
 *
 * Pure TypeScript (vitest); positions SIM space.
 */
import type { SimV3 } from '../../core/types';
import type { AudioBankJson } from './bankTypes';
import { ScriptInstance, type SoundSystem } from './patch';

/** FUN_007960c0 constants. */
export const ENV_RANGE_M = 60;
export const ENV_STILL_STEP = 0.2;
export const ENV_STILL_LIMIT = 18;
export const ENV_ROLL = 20;

export interface EnvObject {
  template: string;
  pos: SimV3;
  script: ScriptInstance;
  /** Patch 0 has a looping layer (vt+0x24): started at creation, never re-rolled. */
  looping: boolean;
}

export class EnvSoundManager {
  readonly objects: EnvObject[] = [];
  /** +0x40: the "a car stood still" counter. */
  still = 0;
  /** +0x10: the cars' positions of the last update. */
  private readonly last: SimV3[] = [];

  readonly sys: SoundSystem;
  readonly stageId: string;

  constructor(sys: SoundSystem, bank: AudioBankJson, stageId: string) {
    this.sys = sys;
    this.stageId = stageId;
    const rows = bank.env.placements[stageId] ?? [];
    for (const [template, x, y, z] of rows) {
      const key = bank.env.templates[template];
      const def = key ? bank.scripts[key] : undefined;
      if (!key || !def) continue;
      const pos = { x, y, z };
      const script = new ScriptInstance(sys, def, key, { pos, quat: null, vel: { x: 0, y: 0, z: 0 } });
      const p0 = script.patch(0);
      const looping = !!p0 && p0.def.layers.some((l) => l.loop);
      this.objects.push({ template, pos, script, looping });
      if (looping) p0!.play(); // FUN_00797480
    }
  }

  /** Every sample key the stage's ambience uses (preloading). */
  sampleKeys(): string[] {
    const out = new Set<string>();
    for (const o of this.objects) for (const p of o.script.patches) for (const l of p.def.layers) if (l.s) out.add(l.s);
    return [...out];
  }

  /** One manager update (FUN_007960c0) with the cars' SIM positions. */
  update(cars: readonly SimV3[]): void {
    let still = false;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const l = this.last[i];
      if (l && l.x === c.x && l.y === c.y && l.z === c.z) still = true;
      this.last[i] = { x: c.x, y: c.y, z: c.z };
    }
    this.last.length = cars.length;
    if (still) this.still += ENV_STILL_STEP;
    else this.still = 0;
    if (this.still >= ENV_STILL_LIMIT) return; // the else branch only calls the no-op stop stub
    const rand = this.sys.rand;
    for (const o of this.objects) {
      for (const c of cars) {
        const d = Math.hypot(o.pos.x - c.x, o.pos.y - c.y, o.pos.z - c.z);
        if (!(d < ENV_RANGE_M)) continue;
        // FUN_007979c0 (single car: no FUN_00797a20 early-out)
        const p = o.script.patch(0);
        if (p && !p.isActive() && !o.looping && rand.next() % ENV_ROLL === 0) p.play();
      }
    }
  }

  dispose(): void {
    for (const o of this.objects) o.script.kill();
    this.objects.length = 0;
  }
}
