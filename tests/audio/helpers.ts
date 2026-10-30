// Test doubles for the patch engine: a VoiceBackend that records every voice, and layer / patch builders.
import type { EffectJson, LayerJson, PatchJson } from '../../src/audio/orig/bankTypes';
import type { Voice, VoiceBackend, VoiceUpdate } from '../../src/audio/orig/patch';

export class RecVoice implements Voice {
  playing = true;
  stopped = false;
  updates: VoiceUpdate[] = [];
  readonly layer: LayerJson;
  constructor(layer: LayerJson) {
    this.layer = layer;
  }
  update(u: Readonly<VoiceUpdate>): void {
    this.updates.push({ ...u, pos: u.pos ? { ...u.pos } : null, vel: u.vel ? { ...u.vel } : null });
  }
  stop(): void {
    this.playing = false;
    this.stopped = true;
  }
  /** A one-shot reached its end. */
  end(): void {
    this.playing = false;
  }
  get last(): VoiceUpdate | undefined {
    return this.updates[this.updates.length - 1];
  }
}

export class RecBackend implements VoiceBackend {
  voices: RecVoice[] = [];
  /** Sample keys that have no buffer (start returns null). */
  missing = new Set<string>();
  start(layer: LayerJson): Voice | null {
    if (!layer.s || this.missing.has(layer.s)) return null;
    const v = new RecVoice(layer);
    this.voices.push(v);
    return v;
  }
  live(): RecVoice[] {
    return this.voices.filter((v) => v.playing);
  }
  starts(sample: string): number {
    return this.voices.filter((v) => v.layer.s === sample).length;
  }
}

export function layer(s: string, o: Partial<LayerJson> = {}): LayerJson {
  return {
    s,
    path: s,
    loop: false,
    is3d: true,
    volume: 1,
    pan: 0,
    minDistance: 1,
    priority: 0,
    trigger: 0,
    stop: 2,
    rsp: [0, 0],
    rel: [0, 0, 0],
    doppler: true,
    fx: [],
    ...o,
  };
}

export const fxRamp = (d: number, s: number, x: number, p: number[]): EffectJson => ({ d, s, x, e: 1, p: [...p, 0, 1].slice(0, 6) });

export function patch(layers: LayerJson[], randomPlay = 0): PatchJson {
  return { comment: '', randomPlay, layers };
}
