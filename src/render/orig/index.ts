/**
 * src/render/orig/index.ts — OriginalStageView: the original-asset look of a ported stage, composed from
 * track.ts (loadTrack), objects.ts (loadObjects) and environment.ts (loadEnvironment). docs/ASSETS.md.
 *
 *   const view = await OriginalStageView.load(stage, renderer, textureStore);   // null → procedural
 *   scene.add(view.group);  …  view.update(camera, dt);  rig.groundAt = (x, z) => view.groundAt(x, z);
 *   view.component('environment')            // a loaded component (e.g. the OrigEnvironment), or null
 *   view.carLightmapAt(x, y, z) / view.particleLightAt(x, y, z, out)   // the projected track lightmap
 *   view.dispose();
 *
 * load() resolves to null (the renderer keeps its procedural terrain / road / scenery, no errors) when the
 * stage is not ported, there is no asset manifest (absent assets, `?orig=0`), the manifest lists none of
 * RENDER_PARTS for the stage, or no component loaded. A component that throws logs ONE warning and is
 * treated as absent. Missing pieces get procedural stand-ins so the view is always drivable:
 *   no track   → the procedural terrain + road (src/render/terrain.ts, road.ts)
 *   no track and no objects → also the procedural scenery
 * Before the components load, the shared uniforms (common.ts origUniforms) are reset to the original's
 * settings defaults; loadEnvironment fills them.
 * While a view is shown the renderer uses the gamma-space output (NoToneMapping + LinearSRGBColorSpace).
 */
import * as THREE from 'three';
import { fetchArrayBuffer, fetchJson, getAssetManifest, isPortedStageId, manifestStageParts, stagePartPath, warnOnce } from '../../core/assets';
import type { Stage } from '../../core/types';
import { HeightSampler } from '../heightSampler';
import { buildRoad } from '../road';
import { buildScenery, updateSceneryLod, type SceneryBatch } from '../scenery';
import { buildTerrain, updateTerrainLod, type TerrainChunk } from '../terrain';
import {
  disposeTree,
  origUniforms,
  resetOrigUniforms,
  type OrigComponent,
  type OrigComponentLoader,
  type OrigLightmapSample,
  type OrigLoadContext,
  type OrigSharedUniforms,
} from './common';
import { loadEnvironment } from './environment';
import { loadObjects } from './objects';
import type { TextureScope, TextureStore } from './textures';
import { loadTrack } from './track';

export { ORIG_SKY_LAYER, origUniforms, resetOrigUniforms } from './common';
export type { OrigComponent, OrigLightmapSample, OrigLoadContext, OrigSharedUniforms } from './common';
export { TextureStore, TextureScope } from './textures';

/** Stage parts that make up the original look (any one present → the view is tried). */
export const RENDER_PARTS = ['track', 'objects', 'environment'] as const;
export type RenderPart = (typeof RENDER_PARTS)[number];

const LOADERS: Record<RenderPart, OrigComponentLoader> = {
  track: loadTrack,
  objects: loadObjects,
  environment: loadEnvironment,
};

interface StandIn {
  group: THREE.Group;
  sampler: HeightSampler;
  terrain: TerrainChunk[];
  scenery: SceneryBatch[];
}

export class OriginalStageView {
  /** Add to the scene; holds every component's object3D and the stand-ins. */
  readonly group = new THREE.Group();
  readonly stageId: string;
  /** Render parts that actually loaded (subset of RENDER_PARTS). */
  readonly parts: readonly RenderPart[];
  /** origUniforms (shared by identity with every original material). */
  readonly uniforms: OrigSharedUniforms = origUniforms;
  /** True when the original track replaced the procedural ground. */
  readonly hasTrack: boolean;
  /** True when a component draws its own sky (hide the procedural sky dome). */
  readonly replacesSky: boolean;
  /** Minimum camera far plane the components need (0 = no requirement). */
  readonly cameraFar: number;
  private readonly components: { part: RenderPart; c: OrigComponent }[];
  private readonly standIn: StandIn | null;
  private readonly fallback: HeightSampler;
  private readonly textures: TextureScope;
  private disposed = false;

  private constructor(stage: Stage, textures: TextureScope, components: { part: RenderPart; c: OrigComponent }[]) {
    this.stageId = stage.id;
    this.textures = textures;
    this.components = components;
    this.parts = components.map((x) => x.part);
    this.group.name = `orig:${stage.id}`;
    for (const { c } of components) this.group.add(c.object3D);
    this.hasTrack = this.parts.includes('track');
    this.replacesSky = components.some(({ c }) => c.replacesSky === true);
    this.cameraFar = Math.max(0, ...components.map(({ c }) => c.cameraFar ?? 0));
    this.fallback = new HeightSampler(stage.heightfield);
    this.standIn = this.hasTrack ? null : OriginalStageView.buildStandIn(stage, !this.parts.includes('objects'));
    if (this.standIn) this.group.add(this.standIn.group);
  }

  /** The original view of `stage`, or null for the procedural fallback (see module doc). Never rejects. */
  static async load(stage: Stage, renderer: THREE.WebGLRenderer, textureStore: TextureStore): Promise<OriginalStageView | null> {
    try {
      if (!isPortedStageId(stage.id)) return null;
      const manifest = await getAssetManifest();
      if (!manifest) return null;
      const parts = manifestStageParts(manifest, stage.id);
      if (!RENDER_PARTS.some((p) => parts.includes(p))) return null;
      resetOrigUniforms();
      const textures = textureStore.scope();
      const ctx: OrigLoadContext = {
        stage,
        stageId: stage.id,
        manifest,
        parts,
        renderer,
        textures,
        uniforms: origUniforms,
        partPath: (part, ext = 'json') => stagePartPath(stage.id, part, ext),
        fetchPartJson: <T>(part: string, ext = 'json') => fetchJson<T>(stagePartPath(stage.id, part, ext)),
        fetchPartBuffer: (part, ext = 'bin') => fetchArrayBuffer(stagePartPath(stage.id, part, ext)),
      };
      const loaded = await Promise.all(
        RENDER_PARTS.map(async (part) => {
          if (!parts.includes(part)) return null;
          try {
            const c = await LOADERS[part](ctx);
            return c ? { part, c } : null;
          } catch (e) {
            warnOnce(`orig:${stage.id}:${part}`, `[orig] ${stage.id}: '${part}' failed to load (${(e as Error)?.message ?? e}); using the procedural fallback for it`);
            return null;
          }
        }),
      );
      const comps = loaded.filter((x): x is { part: RenderPart; c: OrigComponent } => x !== null);
      if (!comps.length) {
        textures.dispose();
        resetOrigUniforms();
        return null;
      }
      return new OriginalStageView(stage, textures, comps);
    } catch (e) {
      warnOnce(`orig:${stage.id}`, `[orig] ${stage.id}: original view failed (${(e as Error)?.message ?? e}); using procedural visuals`);
      return null;
    }
  }

  private static buildStandIn(stage: Stage, withScenery: boolean): StandIn {
    const group = new THREE.Group();
    group.name = 'orig:standin';
    const terrain = buildTerrain(stage);
    group.add(terrain.group);
    group.add(buildRoad(stage, terrain.sampler));
    let scenery: SceneryBatch[] = [];
    if (withScenery) {
      const s = buildScenery(stage, terrain.sampler);
      scenery = s.batches;
      group.add(s.group);
    }
    return { group, sampler: terrain.sampler, terrain: terrain.chunks, scenery };
  }

  /** The loaded component of `part` (e.g. the OrigEnvironment for 'environment'), or null when it did not load. */
  component(part: RenderPart): OrigComponent | null {
    return this.components.find((x) => x.part === part)?.c ?? null;
  }

  /** The projected track lightmap under a car at three-space (x, y, z) (OrigComponent.carLightmapAt), or null. */
  carLightmapAt(x: number, y: number, z: number, hint?: number): OrigLightmapSample | null {
    if (this.disposed) return null;
    for (const { c } of this.components) if (c.carLightmapAt) return c.carLightmapAt(x, y, z, hint);
    return null;
  }

  /** Particle light (RGB 0..1) at (x, y, z) from the projected lightmap (OrigComponent.particleLightAt); −1 = none. */
  particleLightAt(x: number, y: number, z: number, out: number[], hint?: number): number {
    if (this.disposed) return -1;
    for (const { c } of this.components) if (c.particleLightAt) return c.particleLightAt(x, y, z, out, hint);
    return -1;
  }

  /** Ground height (three y) at three-space (x, z) for the camera rig: the original track mesh when loaded,
   *  else the stand-in terrain, else the stage heightfield. */
  groundAt(x: number, z: number): number {
    for (const { c } of this.components) {
      if (c.heightAt) {
        const h = c.heightAt(x, z);
        if (Number.isFinite(h)) return h;
      }
    }
    return (this.standIn?.sampler ?? this.fallback).heightAt(x, z);
  }

  /** Per rendered frame, before the render. `lod` scales the stand-in LOD distances (renderer quality). */
  update(camera: THREE.Camera, dt: number, lod = 1): void {
    if (this.disposed) return;
    origUniforms.time.value += dt;
    for (const { c } of this.components) c.update(camera, dt);
    if (this.standIn) {
      updateTerrainLod(this.standIn.terrain, camera.position, lod);
      updateSceneryLod(this.standIn.scenery, camera.position, lod);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { c } of this.components) {
      try {
        c.dispose();
      } catch (e) {
        warnOnce(`orig-dispose:${this.stageId}`, `[orig] dispose failed: ${(e as Error)?.message ?? e}`);
      }
    }
    if (this.standIn) disposeTree(this.standIn.group);
    this.group.removeFromParent();
    this.textures.dispose();
  }
}
