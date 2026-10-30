/**
 * src/world/orig/index.ts — OWNED BY THE COLLISION BUILDER. The original collision world of a ported stage.
 *
 * REQUIRED EXPORTS (keep the signature; called by src/main.ts loadSelection for every stage):
 *   attachOriginalWorld(built: BuiltStage): Promise<BuiltStage>
 *
 * Contract:
 *   * Returns `built` UNCHANGED for procedural stages, without an asset manifest (absent assets, `?orig=0`),
 *     when the manifest lists no 'collision' part for the stage, with `?collision=0`, or on any failure (one
 *     warnOnce, fallback).
 *   * Otherwise returns { stage: built.stage, world: OrigWorld } — a MESH WorldQuery (SIM space) answering
 *     segment / raycast / heightAt / normalAt / materialAt / surfaceAt / obstaclesNear from the original
 *     collision mesh (Track.gcm — the file the game uses; TrackFull.gcm only with the `fullCollision` cvar,
 *     default 0, research/formats/gcm.md §1/§5/§9) → stages/<id>/collision.{json,bin} written by
 *     tools/assets/parts/collision.py ('RCOL': the gcm arrays unchanged + the original top-cell lists) and the
 *     object collision proxies (Objects.con, objects.md §8). `segment` is the literal port of gcm.md §3.2-3.4
 *     (gcm.ts: first hit in traversal order, per-slot face cache, one-sided, `d0 <= 0 → miss`); `raycast` =
 *     raycastViaSegment; face bytes → materialFromOrig; the yHint level rule = pickGroundLevel; off the mesh the
 *     point queries fall back to the procedural `built.world` (never NaN). `stage` (three space) is kept as is.
 *   * Stage frame check (docs/orig/collision.md §5): the stage's road must lie on the mesh in the contract frame
 *     (sim = three with z negated = the gcm frame). When it only fits z-mirrored (a stage built with the
 *     spline's raw (x, y, z) as three space), the world serves the mesh mirrored to match and warns once.
 *   * Deterministic for (stage id, seed); the contract tests (tests/contracts) run on procedural worlds.
 *   * Import rule: src/core and src/world only (no three.js).
 * Notes / deviations: docs/orig/collision.md.
 */
import { fetchArrayBuffer, fetchJson, getAssetManifest, isPortedStageId, manifestHasStagePart, stagePartPath, urlParam, warnOnce } from '../../core/assets';
import type { BuiltStage, Stage } from '../../core/types';
import { pickGroundLevel } from '../../core/worldQuery';
import { GcmGrid } from './gcm';
import { parseRcol, type RcolData } from './rcol';
import { OrigWorld } from './world';

export { OrigWorld } from './world';
export { GcmGrid } from './gcm';
export { parseRcol } from './rcol';

export const COLLISION_PART = 'collision';

/** collision.json (tools/assets/parts/collision.py build_stage), the fields the runtime reads. */
export interface CollisionMeta {
  version: number;
  format: string;
  nV: number;
  nF: number;
  bytes: number;
  obstacles?: { kinds?: string[] };
}

interface LoadedRcol {
  data: RcolData;
  kinds: readonly string[];
}

/** Parsed parts by stage id (a restart / re-select of the same stage re-uses the arrays; the world is new). */
const loaded = new Map<string, Promise<LoadedRcol>>();
/** Parts kept parsed (1.5-4.2 MB each): the current stage and the previous one. */
const KEEP_LOADED = 2;

/** Fetch + parse the stage's collision part (throws on a broken part; a failed load is not cached). */
function loadRcol(stageId: string): Promise<LoadedRcol> {
  let p = loaded.get(stageId);
  if (p) {
    loaded.delete(stageId); // most recent last
    loaded.set(stageId, p);
  } else {
    while (loaded.size >= KEEP_LOADED) loaded.delete(loaded.keys().next().value!);
    p = (async () => {
      const [meta, buf] = await Promise.all([
        fetchJson<CollisionMeta>(stagePartPath(stageId, COLLISION_PART, 'json')),
        fetchArrayBuffer(stagePartPath(stageId, COLLISION_PART, 'bin')),
      ]);
      if (meta.format !== 'RCOL' || (meta.version !== 1 && meta.version !== 2)) throw new Error(`collision.json: ${meta.format} v${meta.version}`);
      if (buf.byteLength !== meta.bytes) throw new Error(`collision.bin: ${buf.byteLength} bytes, json says ${meta.bytes}`);
      const data = parseRcol(buf);
      if (data.nF !== meta.nF || data.nV !== meta.nV) throw new Error('collision.bin does not match collision.json');
      return { data, kinds: meta.obstacles?.kinds ?? [] };
    })();
    loaded.set(stageId, p);
    p.catch(() => loaded.delete(stageId));
  }
  return p;
}

/** Load the stage's collision part into an OrigWorld over `fallback` (throws on a broken part). */
export async function loadOrigWorld(
  stageId: string, fallback: BuiltStage['world'], opts: { mirrorZ?: boolean } = {},
): Promise<OrigWorld> {
  const { data, kinds } = await loadRcol(stageId);
  return new OrigWorld(data, fallback, { kinds, mirrorZ: opts.mirrorZ });
}

/** How the stage's road sits on the mesh: fraction of road samples on the mesh within 2 m, per frame. */
export interface StageFrameFit {
  /** Road samples tested. */
  n: number;
  /** Contract frame: sim = (x, y, −z) of three. */
  sim: number;
  /** z-mirrored: gcm = (x, y, z) of three. */
  mirrored: number;
  /** Serve the mesh mirrored (the road fits only that way). */
  mirrorZ: boolean;
}

const FRAME_SAMPLES = 96;
const FRAME_DY_M = 2;

/** Test the stage's raced road (startS..finishS, or the whole lap) against the mesh in both frames. */
export function stageFrameFit(stage: Stage, data: RcolData): StageFrameFit {
  const grid = new GcmGrid(data);
  const ys = new Float64Array(32), faces = new Int32Array(32);
  const road = stage.road;
  const lo = stage.closed ? -Infinity : Math.min(stage.startS, stage.finishS);
  const hi = stage.closed ? Infinity : Math.max(stage.startS, stage.finishS);
  const pick = road.filter((r) => r.s >= lo && r.s <= hi);
  const list = pick.length >= 8 ? pick : road;
  const step = Math.max(1, Math.floor(list.length / FRAME_SAMPLES));
  let n = 0, sim = 0, mir = 0;
  const fits = (x: number, z: number, y: number) => {
    const k = pickGroundLevel(ys, grid.facesAt(x, z, ys, faces), y);
    return k >= 0 && Math.abs(ys[k] - y) < FRAME_DY_M;
  };
  for (let i = 0; i < list.length; i += step) {
    const p = list[i].pos;
    n++;
    if (fits(p.x, -p.z, p.y)) sim++;
    if (fits(p.x, p.z, p.y)) mir++;
  }
  const fs = n ? sim / n : 0, fm = n ? mir / n : 0;
  return { n, sim: fs, mirrored: fm, mirrorZ: fm > 0.5 && fm > fs };
}

export async function attachOriginalWorld(built: BuiltStage): Promise<BuiltStage> {
  const id = built.stage.id;
  if (!isPortedStageId(id) || urlParam('collision') === '0') return built;
  const manifest = await getAssetManifest();
  if (!manifestHasStagePart(manifest, id, COLLISION_PART)) return built;
  try {
    const { data } = await loadRcol(id);
    const fit = stageFrameFit(built.stage, data);
    if (fit.mirrorZ) {
      warnOnce(`collision-frame:${id}`, `stage ${id} is z-mirrored against the original collision mesh ` +
        `(road on the mesh: ${(100 * fit.sim).toFixed(0)} % as sim, ${(100 * fit.mirrored).toFixed(0)} % mirrored); ` +
        'serving the mesh mirrored to match (docs/orig/collision.md §5)');
    } else if (fit.sim < 0.5) {
      warnOnce(`collision-fit:${id}`, `stage ${id}: only ${(100 * fit.sim).toFixed(0)} % of the road lies on the ` +
        'original collision mesh (docs/orig/collision.md §5)');
    }
    const world = await loadOrigWorld(id, built.world, { mirrorZ: fit.mirrorZ });
    return { stage: built.stage, world };
  } catch (e) {
    warnOnce(`collision:${id}`, `original collision mesh for ${id} unavailable, using the procedural ground: ${String(e)}`);
    return built;
  }
}
