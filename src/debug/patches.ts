/**
 * src/debug/patches.ts — game builder. Finds teleport targets on a stage for the tuning panel's quick
 * actions: road sections by surface, and (test pads only) terrain material patches of the heightfield.
 * Each target is expressed as (s, lateral) for window.__rally.teleport.
 */
import { SURFACE_IDS, SURFACE_INFO } from '../core/constants';
import type { Stage, SurfaceId } from '../core/types';

export interface TeleportTarget {
  label: string;
  s: number;
  lateral: number;
}

export function findTeleportTargets(stage: Stage, maxSamples = 40000): TeleportTarget[] {
  const out: TeleportTarget[] = [];
  out.push({ label: `start (s ${Math.round(stage.startS)})`, s: stage.startS, lateral: 0 });
  // ---- road sections by surface
  const road = stage.road ?? [];
  let runStart = 0;
  for (let i = 1; i <= road.length; i++) {
    if (i === road.length || road[i].surface !== road[runStart].surface) {
      const a = road[runStart];
      const len = (i === road.length ? road[road.length - 1].s : road[i].s) - a.s;
      if (len > 15 && out.length < 40) {
        out.push({
          label: `road ${SURFACE_INFO[a.surface]?.name ?? a.surface} @ ${Math.round(a.s)} m (${Math.round(len)} m)`,
          s: a.s + Math.min(10, len / 2),
          lateral: 0,
        });
      }
      runStart = i;
    }
  }
  // ---- terrain material patches (testpad only: elsewhere terrain is everywhere)
  if (stage.discipline === 'testpad' && stage.heightfield && stage.heightfield.materials?.length) {
    const hf = stage.heightfield;
    const total = hf.nx * hf.nz;
    const stride = Math.max(1, Math.ceil(Math.sqrt(total / maxSamples)));
    const acc = new Map<number, { n: number; x: number; z: number }>();
    for (let iz = 0; iz < hf.nz; iz += stride) {
      for (let ix = 0; ix < hf.nx; ix += stride) {
        const m = hf.materials[iz * hf.nx + ix];
        if (m >= SURFACE_IDS.length) continue;
        const a = acc.get(m) ?? { n: 0, x: 0, z: 0 };
        a.n++;
        a.x += hf.originX + ix * hf.cellSize;
        a.z += hf.originZ + iz * hf.cellSize;
        acc.set(m, a);
      }
    }
    if (acc.size > 1) {
      for (const [m, a] of acc) {
        const cx = a.x / a.n;
        const cz = a.z / a.n;
        // nearest sample of that material to the centroid (centroids of odd shapes may fall outside)
        let best = { d: Infinity, x: cx, z: cz };
        for (let iz = 0; iz < hf.nz; iz += stride) {
          for (let ix = 0; ix < hf.nx; ix += stride) {
            if (hf.materials[iz * hf.nx + ix] !== m) continue;
            const x = hf.originX + ix * hf.cellSize;
            const z = hf.originZ + iz * hf.cellSize;
            const d = (x - cx) ** 2 + (z - cz) ** 2;
            if (d < best.d) best = { d, x, z };
          }
        }
        try {
          const pr = stage.project({ x: best.x, y: 0, z: best.z });
          const id = SURFACE_IDS[m] as SurfaceId;
          out.push({
            label: `patch ${SURFACE_INFO[id]?.name ?? id} (s ${Math.round(pr.s)}, lat ${Math.round(pr.lateral)})`,
            s: pr.s,
            lateral: pr.lateral,
          });
        } catch {
          /* projection failed */
        }
      }
    }
  }
  return out;
}
