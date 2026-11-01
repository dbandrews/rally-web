/**
 * src/render/orig/track.ts — the original track render meshes of a ported stage (Mesh/Track.qm + World.qm +
 * Water.qm), drawn with GLSL ports of the DX8 track shaders (trackShaders.ts). docs/orig/track.md.
 *
 *   loadTrack(ctx) → OrigComponent | null      (null: the stage has no 'track' part → stand-in ground)
 *
 * Data: stages/<id>/track.json + track.bin from tools/assets/parts/track.py (layout: trackData.ts). Frame
 * composition (environment.md §4.1, quadmesh.md §1/§4):
 *   1. sky pass: sky box + clouds (environment component), then World.qm (Track/Single, WORLD fog) with the
 *      sky-pass planes (near 10 m, far 100 km), then a Z clear [V frame sequence @0x49f114–0x49f1c1].
 *      With the environment component the renderer runs that pass itself (environment.ts OrigFramePipeline:
 *      the World mesh sits on ORIG_SKY_LAYER and is drawn by its sky camera). Without it, the World mesh
 *      emulates the pass in the main render: renderOrder −1.5, its own projection, renderer.clearDepth() in its
 *      onAfterRender (`worldMode`, switched per frame, self-healing if no sky pass draws it).
 *   2. track pass: the Track.qm patches (renderOrder 0, culled through the quadtree), each submesh with its
 *      subshader's passes: Mask / Single base pass, SpecBump additive pass (bumpmap + track.bumpEnable),
 *      Water + Water2 (env, additive). Everything in the track pass is clipped at the track view distance
 *      (race +0x740: the HotSpot regulator's trackViewDistance, else Track.viewDistance), like the D3D far
 *      plane — in the fragment shader too, because the camera's far plane may also have to hold other passes.
 * Fog: ORIG_FOG_PARS on origUniforms.trackFog (World.qm: .worldFog), referenced by identity.
 * heightAt(x, z): the highest up-facing Track.qm triangle (camera ground sampler), NaN off the mesh.
 * The projected lightmap (lightmap.ts) for the cars and the particles: carLightmapAt (the patch lightmap through
 * the car palette, Car.lightmapMin/Max/Clamp; a few recently used patches stay loaded) and particleLightAt (CPU,
 * nearest texel of the P8 index plane through the particle palette, game.particleLightmapMin).
 */
import * as THREE from 'three';
import { warnOnce } from '../../core/assets';
import type { Stage } from '../../core/types';
import {
  fogUniformMap,
  lightmapLut,
  ORIG_SKY_LAYER,
  PARTICLE_LIGHTMAP_CLAMP,
  PARTICLE_LIGHTMAP_MAX,
  type OrigComponent,
  type OrigLightmapSample,
  type OrigLoadContext,
  type OrigSharedUniforms,
  type OrigUniform,
} from './common';
import { ORIG_ENVIRONMENT_NAME } from './environment';
import { fitLightmapProjection, LIGHTMAP_FIT_TOLERANCE, LightmapPatches, projectLightmapUv, sampleIndex, type LightmapPatch } from './lightmap';
import { RTEX_FORMAT, type RtexImage } from './rtex';
import type { TextureScope } from './textures';
import {
  bumpLightDir,
  maxTrackViewDistance,
  meshArrays,
  TrackHeightGrid,
  trackViewDistance,
  validateTrackJson,
  waterAnimation,
  type Bounds6,
  type TrackJson,
  type TrackMaterialJson,
  type TrackMeshArrays,
  type TrackMeshJson,
  type TrackTexRef,
} from './trackData';
import {
  SPEC_BUMP_FS,
  SPEC_BUMP_VS,
  trackFragmentShader,
  trackVertexShader,
  WATER2_FS,
  WATER2_VS,
  WATER_FS,
  WATER_VS,
} from './trackShaders';
import { StaticWorld } from './staticWorld';

export const TRACK_PART = 'track';

/** Render orders: the environment's sky box is −2; World.qm + its Z clear sit between it and the track pass. */
export const WORLD_RENDER_ORDER = -1.5;

/** Car lightmap textures (the car palette) kept loaded: the patches the cars visited last. */
const CAR_LIGHTMAP_CACHE = 8;

export async function loadTrack(ctx: OrigLoadContext): Promise<OrigComponent | null> {
  if (!ctx.parts.includes(TRACK_PART)) return null;
  const [raw, bin] = await Promise.all([ctx.fetchPartJson(TRACK_PART), ctx.fetchPartBuffer(TRACK_PART, 'bin')]);
  const json = validateTrackJson(raw);
  if (bin.byteLength < json.binBytes) throw new Error(`track.bin: ${bin.byteLength} bytes, expected ${json.binBytes}`);
  const c = new TrackComponent(ctx.stage, json, bin, ctx.uniforms);
  try {
    await c.init(ctx.textures);
  } catch (e) {
    c.dispose();
    throw e;
  }
  return c;
}

/** Per-frame statistics of the track component (debug / tools). */
export interface TrackFrameStats {
  /** Visible Track.qm patches / all. */
  patches: number;
  patchesTotal: number;
  /** Draw calls and triangles the track component submits this frame (all passes, World included). */
  drawCalls: number;
  triangles: number;
  /** Current track-pass far plane (m). */
  viewDistance: number;
}

interface PatchMesh {
  mesh: THREE.Mesh;
  /** Track.qm (counted in TrackFrameStats.patches) or Water.qm. */
  track: boolean;
  box: THREE.Box3;
  /** Triangles / draw calls of this patch's groups (all passes). */
  tris: number;
  calls: number;
}

interface NodeRec {
  box: THREE.Box3;
  children: number[];
  patches: PatchMesh[];
}

const CLAMP = THREE.ClampToEdgeWrapping;
const WRAP = THREE.RepeatWrapping;

class TrackComponent implements OrigComponent {
  readonly object3D = new THREE.Group();
  readonly cameraFar: number;
  readonly stats: TrackFrameStats;
  private readonly json: TrackJson;
  private readonly bin: ArrayBuffer;
  private readonly stage: Stage;
  private readonly shared: OrigSharedUniforms;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly black: THREE.DataTexture;
  private readonly tex = new Map<string, THREE.Texture>();
  private cube: THREE.CompressedCubeTexture | null = null;
  private volume: THREE.Data3DTexture | null = null;
  private height: TrackHeightGrid | null = null;
  private nodes: NodeRec[] = [];
  /** Root node index of each patch mesh's quadtree (Track.qm, Water.qm) in `nodes`. */
  private readonly roots: number[] = [];
  private patches: PatchMesh[] = [];
  /** The patch meshes never move: their world matrices are computed once (staticWorld.ts). */
  private readonly staticWorld = new StaticWorld(this.object3D);
  private patchMeshes: THREE.Mesh[] | null = null;
  private world: THREE.Mesh | null = null;
  /** 'sky': drawn by the environment pipeline's sky pass (ORIG_SKY_LAYER); 'own': emulated in the main render. */
  worldMode: 'sky' | 'own' = 'sky';
  /** Updates since the sky pass last drew the World mesh (self-heal when the pipeline does not run). */
  private worldMissed = 0;
  private worldTris = 0;
  private worldCalls = 0;
  private hintS: number | undefined = undefined;
  private disposed = false;
  // projected lightmap (cars / particles)
  private scope: TextureScope | null = null;
  private lmPatches: LightmapPatches | null = null;
  private lmImages: (RtexImage | null)[] = [];
  private readonly carLm = new Map<number, { scope: TextureScope; tex: THREE.Texture | null; used: number }>();
  private carLmKey = '';
  private carLmPalette: Uint8Array | null = null;
  private carLmTick = 0;
  private particleLutKey = '';
  private particleLut: Uint8Array | null = null;
  // shared uniform objects (by identity in every material)
  private readonly uTrackFar: OrigUniform<number>;
  private readonly uPassProjection = { value: new THREE.Matrix4() };
  private readonly uSun = { value: new THREE.Vector3(0, Math.SQRT1_2, Math.SQRT1_2) };
  private readonly uBumpLight = { value: new THREE.Vector3(0, Math.SQRT1_2, Math.SQRT1_2) };
  private readonly uSpecular: OrigUniform<THREE.Vector3>;
  private readonly uScroll = { value: new THREE.Vector4() };
  private readonly uPhase = { value: 0 };
  /** three → SIM z sign for the SIM-space shading (−1; +1 while the stage is served z-mirrored). */
  private readonly uSimZ = { value: -1 };
  /** The stage was built z-mirrored against the original (stageFrameFit): the meshes are served mirrored. */
  mirrored = false;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly camPos = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();
  private readonly farPlane = new THREE.Plane();
  private readonly invObj = new THREE.Matrix4();

  constructor(stage: Stage, json: TrackJson, bin: ArrayBuffer, shared: OrigSharedUniforms) {
    this.stage = stage;
    this.json = json;
    this.bin = bin;
    this.shared = shared;
    this.object3D.name = 'orig-track';
    this.cameraFar = maxTrackViewDistance(json.settings) * 1.02;
    this.uTrackFar = { value: json.settings.viewDistance };
    const sc = json.settings.specularColor;
    this.uSpecular = { value: new THREE.Vector3(sc[0], sc[1], sc[2]) };
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.colorSpace = THREE.NoColorSpace;
    this.black.needsUpdate = true;
    this.stats = { patches: 0, patchesTotal: 0, drawCalls: 0, triangles: 0, viewDistance: json.settings.viewDistance };
    this.object3D.userData.trackStats = this.stats;
  }

  // ------------------------------------------------------------------------------------------- loading

  async init(scope: TextureScope): Promise<void> {
    await this.loadTextures(scope);
    if (this.disposed) return;
    const arrays = this.json.meshes.map((m) => meshArrays(this.bin, m));
    for (let i = 0; i < this.json.meshes.length; i++) {
      const m = this.json.meshes[i];
      if (m.kind === 'world') {
        if (this.json.settings.drawWorld) this.buildWorld(m, arrays[i]);
      } else this.buildPatches(m, arrays[i]);
    }
    const ti = this.json.meshes.findIndex((m) => m.kind === 'track');
    const t = this.json.meshes[ti];
    const ranges = t.patches.flatMap((p) => p.groups.map((g) => ({ start: g.start, count: g.count })));
    this.height = new TrackHeightGrid([{ arrays: arrays[ti], stride: t.floatStride, ranges }]);
    this.stats.patchesTotal = t.patches.length;
    this.scope = scope;
    await this.buildLightmapPatches(t, arrays[ti], scope);
    if (this.disposed) return;
    const fit = stageFrameFit(this.stage, this.height);
    if (fit.mirrorZ) {
      // Contract frame = three (x, y, −z) of the SIM-frame mesh (docs/ARCHITECTURE.md §2, quadmesh.md
      // Verification "Handedness"). A ported stage whose road only lies on the mesh z-mirrored was built with the
      // spline's raw (x, y, z) as three space: serve the meshes mirrored so the drive and the look agree (the
      // collision world does the same, docs/orig/collision.md §5); SIM-space shading stays the original's.
      this.mirrored = true;
      this.uSimZ.value = 1;
      this.object3D.scale.set(1, 1, -1);
      warnOnce(`orig-track-frame:${this.stage.id}`, `[orig] track: stage ${this.stage.id} is z-mirrored against the original track mesh (road on the mesh ${(100 * fit.sim).toFixed(0)} % as contract frame, ${(100 * fit.mirrored).toFixed(0)} % mirrored); drawing the mesh mirrored to match (docs/orig/track.md §5)`);
    }
  }

  /** Every texture the stage needs, in parallel (TextureScope caches per (id, wrap) key). */
  private async loadTextures(scope: TextureScope): Promise<void> {
    const jobs: Promise<void>[] = [];
    const want = (id: string | null, clampU: boolean, clampV: boolean): void => {
      if (!id) return;
      const key = texKey(id, clampU, clampV);
      if (this.tex.has(key)) return;
      this.tex.set(key, this.black); // placeholder until loaded
      jobs.push(
        scope.get(id, { wrapS: clampU ? CLAMP : WRAP, wrapT: clampV ? CLAMP : WRAP }).then(
          (t) => void this.tex.set(key, t),
          (e) => this.textureFailed(id, e), // keeps the black placeholder
        ),
      );
    };
    const usedMats = new Set<number>();
    for (const m of this.json.meshes) for (const p of m.patches) for (const g of p.groups) usedMats.add(g.material);
    for (const mi of usedMats) {
      const mat = this.json.materials[mi];
      for (const ref of Object.values(mat.tex) as TrackTexRef[]) want(ref.id, ref.clampU, ref.clampV);
    }
    const track = this.json.meshes.find((m) => m.kind === 'track');
    for (const p of track?.patches ?? []) want(p.lightmap, true, true); // stage 3: CLAMP U/V/W [V @0x66676a]
    want(this.json.white, true, true);
    const w = this.json.water;
    if (w && this.json.meshes.some((m) => m.kind === 'water')) {
      if (w.bumpTex) jobs.push(scope.getVolume(w.bumpTex).then((t) => void (this.volume = t), (e) => this.textureFailed(w.bumpTex!, e)));
      if (w.envTex) jobs.push(scope.getCube(w.envTex).then((t) => void (this.cube = t), (e) => this.textureFailed(w.envTex!.join('+'), e)));
    }
    await Promise.all(jobs);
  }

  /** One texture of a listed part failed to load: one warning, that texture samples black (fallback rule 3). */
  private textureFailed(id: string, e: unknown): void {
    warnOnce(`orig-track-tex:${this.stage.id}`, `[orig] track: texture ${id} failed to load (${(e as Error)?.message ?? e}); drawn black`);
  }

  private texture(ref: TrackTexRef | undefined): THREE.Texture {
    // a name that resolves nowhere (5 references in the corpus) samples as black (docs/orig/track.md)
    if (!ref?.id) return this.black;
    return this.tex.get(texKey(ref.id, ref.clampU, ref.clampV)) ?? this.black;
  }

  private lightmap(id: string | null): THREE.Texture {
    // `lightmapEnable && lightmap ? lightmap : white` (renderer +0x220 = texture/white) [V @0x666add]
    return this.tex.get(texKey(id ?? this.json.white, true, true)) ?? this.tex.get(texKey(this.json.white, true, true)) ?? this.black;
  }

  /** Interleaved vertex block + colour + index attributes of one mesh, shared by all its patch geometries. */
  private attributes(m: TrackMeshJson, a: TrackMeshArrays): { attrs: Record<string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute>; index: THREE.BufferAttribute } {
    const ib = new THREE.InterleavedBuffer(a.vertices, m.floatStride);
    const attrs: Record<string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute> = {
      position: new THREE.InterleavedBufferAttribute(ib, 3, m.layout.position ?? 0),
      color: new THREE.BufferAttribute(a.colors, 4, true),
    };
    for (const k of ['uv0', 'uv1', 'uv2', 'uv3'] as const) {
      const o = m.layout[k];
      if (o !== undefined) attrs[k] = new THREE.InterleavedBufferAttribute(ib, 2, o);
    }
    return { attrs, index: new THREE.BufferAttribute(a.indices, 1) };
  }

  private geometry(attrs: Record<string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute>, index: THREE.BufferAttribute, b: Bounds6): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    for (const [k, v] of Object.entries(attrs)) g.setAttribute(k, v);
    g.setIndex(index);
    // preset bounds from the patch (the shared buffers hold every patch: never let three compute them)
    g.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.geometries.push(g);
    return g;
  }

  /** Track.qm / Water.qm: one THREE.Mesh per patch (the original's culling unit), groups = submesh passes. */
  private buildPatches(m: TrackMeshJson, a: TrackMeshArrays): void {
    const { attrs, index } = this.attributes(m, a);
    const shared = new Map<string, THREE.Material>();
    const nodes: NodeRec[] = m.nodes.map((n) => ({ box: box3(n.bounds), children: n.children, patches: [] }));
    const bumpOn = this.json.settings.bumpEnable;
    const patchMeshes: PatchMesh[] = [];
    for (const p of m.patches) {
      const g = this.geometry(attrs, index, p.bounds);
      const mats: THREE.Material[] = [];
      let tris = 0;
      let calls = 0;
      const addGroup = (start: number, count: number, mat: THREE.Material): void => {
        g.addGroup(start, count, mats.length);
        mats.push(mat);
        tris += count / 3;
        calls++;
      };
      for (const gr of p.groups) {
        const mj = this.json.materials[gr.material];
        if (mj.type === 'Water') {
          addGroup(gr.start, gr.count, this.cached(shared, `w${gr.material}`, () => this.waterMaterial(1)));
          if (this.cube && this.volume) addGroup(gr.start, gr.count, this.cached(shared, `w2${gr.material}`, () => this.waterMaterial(2)));
          continue;
        }
        const prog = programOf(mj);
        // per patch when lightmapped (the patch's lightmap is a material texture), shared otherwise
        const key = prog === 'single' ? `s${gr.material}` : `${prog}${gr.material}:${p.name}`;
        addGroup(gr.start, gr.count, this.cached(shared, key, () => this.baseMaterial(mj, prog, p.lightmap, false)));
        // SpecBump: `bumpmap` set, track.bumpEnable, device caps (FUN_00666660 → 2 passes)
        if (bumpOn && mj.tex.bump) addGroup(gr.start, gr.count, this.cached(shared, `b${gr.material}`, () => this.bumpMaterial(mj)));
      }
      const mesh = new THREE.Mesh(g, mats);
      mesh.name = `orig-track:${m.kind}:${p.name}`;
      mesh.frustumCulled = false; // culled through the quadtree in update()
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      this.object3D.add(mesh);
      patchMeshes.push({ mesh, track: m.kind === 'track', box: box3(p.bounds), tris, calls });
    }
    m.nodes.forEach((n, i) => {
      for (const pi of n.patches) nodes[i].patches.push(patchMeshes[pi]);
    });
    // one quadtree per mesh: re-base the child indices into this.nodes
    const base = this.nodes.length;
    for (const n of nodes) n.children = n.children.map((c) => c + base);
    this.nodes.push(...nodes);
    this.roots.push(base);
    this.patches.push(...patchMeshes);
  }

  /** World.qm: one mesh, its own projection, WORLD fog, the Z clear after its last group. */
  private buildWorld(m: TrackMeshJson, a: TrackMeshArrays): void {
    const { attrs, index } = this.attributes(m, a);
    const all = m.patches.reduce<Bounds6 | null>((acc, p) => (acc ? unionBounds(acc, p.bounds) : p.bounds), null);
    if (!all) return;
    const g = this.geometry(attrs, index, all);
    const mats: THREE.Material[] = [];
    const shared = new Map<string, THREE.Material>();
    for (const p of m.patches) {
      for (const gr of p.groups) {
        const mj = this.json.materials[gr.material];
        if (mj.type === 'Water') continue;
        const prog = programOf(mj);
        g.addGroup(gr.start, gr.count, mats.length);
        mats.push(this.cached(shared, `${prog}${gr.material}:${p.name}`, () => this.baseMaterial(mj, prog, null, true)));
        this.worldTris += gr.count / 3;
        this.worldCalls++;
      }
    }
    const mesh = new THREE.Mesh(g, mats);
    mesh.name = 'orig-track:world';
    mesh.frustumCulled = false;
    mesh.renderOrder = WORLD_RENDER_ORDER;
    const tf = m.transform;
    if (tf) {
      mesh.position.set(tf.position[0], tf.position[1], tf.position[2]);
      mesh.rotation.set(tf.rotationYXZ[0], tf.rotationYXZ[1], tf.rotationYXZ[2], 'YXZ');
    }
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    const last = g.groups[g.groups.length - 1];
    const skyCamera = (c: THREE.Camera): boolean => !c.layers.isEnabled(0) && c.layers.isEnabled(ORIG_SKY_LAYER);
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      // the sky pass camera already has the pass planes (near 10, far 100 km): use its projection as is
      if (this.worldMode === 'sky' && skyCamera(camera)) {
        this.worldMissed = 0;
        this.uPassProjection.value.copy(camera.projectionMatrix);
      }
    };
    // own mode: the World pass ends with a Z clear, the track pass never depth-tests against the backdrop
    mesh.onAfterRender = (renderer, _scene, camera, _geometry, _material, group) => {
      if (this.worldMode === 'own' && !skyCamera(camera) && (!group || (group as unknown) === last)) renderer.clearDepth();
    };
    mesh.layers.set(ORIG_SKY_LAYER);
    this.object3D.add(mesh);
    this.world = mesh;
  }

  /** Sky pass (environment pipeline) when the environment component is in the view and its sky pass draws the
   *  World mesh; otherwise the emulated World pass in the main render. */
  private updateWorldMode(): void {
    const w = this.world;
    if (!w) return;
    const envPresent = !!this.object3D.parent?.children.some((c) => c.name === ORIG_ENVIRONMENT_NAME);
    let mode: 'sky' | 'own' = envPresent ? 'sky' : 'own';
    if (mode === 'sky' && ++this.worldMissed > 3) {
      mode = 'own';
      if (this.worldMode === 'sky') warnOnce(`orig-track-world:${this.stage.id}`, '[orig] track: no sky pass drew World.qm; drawing it in the main pass');
    }
    if (mode === this.worldMode && (mode === 'sky') === w.layers.isEnabled(ORIG_SKY_LAYER)) return;
    this.worldMode = mode;
    if (mode === 'sky') {
      w.layers.set(ORIG_SKY_LAYER);
      this.worldMissed = 0;
    } else w.layers.set(0);
  }

  private cached(map: Map<string, THREE.Material>, key: string, make: () => THREE.Material): THREE.Material {
    let m = map.get(key);
    if (!m) {
      m = make();
      map.set(key, m);
      this.materials.push(m);
    }
    return m;
  }

  // ------------------------------------------------------------------------------------------- projected lightmap

  /** Per lightmapped patch: its XZ cell and the fitted oT3 projection (lightmap.ts), plus the P8 index planes. */
  private async buildLightmapPatches(t: TrackMeshJson, a: TrackMeshArrays, scope: TextureScope): Promise<void> {
    const uv = t.layout.uv3;
    if (!t.lightmappedFile || uv === undefined) return;
    const pos = t.layout.position ?? 0;
    const list: LightmapPatch[] = [];
    let rejected = 0;
    for (const p of t.patches) {
      const fit = fitLightmapProjection(a.vertices, t.floatStride, pos, uv, p.vertexStart, p.vertexCount);
      if (!fit || fit.residual > LIGHTMAP_FIT_TOLERANCE) {
        rejected++;
        continue;
      }
      const b = p.bounds;
      list.push({ x0: b[0], y0: b[1], z0: b[2], x1: b[3], y1: b[4], z1: b[5], proj: fit.proj, lightmap: p.lightmap });
    }
    if (rejected) warnOnce(`orig-track-lmfit:${this.stage.id}`, `[orig] track: ${rejected} patch lightmaps of ${this.stage.id} are not an axis-aligned projection; the cars stay unshadowed there`);
    this.lmPatches = new LightmapPatches(list);
    const image = typeof scope.image === 'function' ? scope.image.bind(scope) : null; // (stand-in scopes in tests)
    this.lmImages = await Promise.all(
      list.map((p) =>
        p.lightmap && image
          ? image(p.lightmap).then(
              (img) => (img.format === RTEX_FORMAT.P8 ? img : null),
              () => null,
            )
          : Promise.resolve(null),
      ),
    );
  }

  /** Index of the lightmapped patch under three-space (x, y, z) (the meshes may be served z-mirrored). */
  private lightmapPatch(x: number, y: number, z: number, hint: number): number {
    return this.lmPatches ? this.lmPatches.find(x, y, this.mirrored ? -z : z, hint) : -1;
  }

  carLightmapAt(x: number, y: number, z: number, hint = -1): OrigLightmapSample | null {
    const i = this.lightmapPatch(x, y, z, hint);
    if (i < 0 || this.disposed) return null;
    const p = this.lmPatches!.patches[i];
    if (!p.lightmap) return null;
    const pr = p.proj;
    return { patch: i, texture: this.carLightmapTexture(i, p.lightmap), proj: [pr[0], pr[1], this.mirrored ? -pr[2] : pr[2], pr[3]] };
  }

  /** The patch lightmap through the car palette (race +0x948 = lightmapLut(Car.lightmapMin/Max/Clamp)); null while
   *  it loads. The last CAR_LIGHTMAP_CACHE patches stay loaded. */
  private carLightmapTexture(i: number, id: string): THREE.Texture | null {
    const u = this.shared;
    const key = `${u.carLightmapMin.value.toArray().join(',')}|${u.carLightmapMax.value.toArray().join(',')}|${u.carLightmapClamp.value.toArray().join(',')}`;
    if (key !== this.carLmKey || !this.carLmPalette) {
      for (const e of this.carLm.values()) e.scope.dispose();
      this.carLm.clear();
      this.carLmKey = key;
      this.carLmPalette = lightmapLut(u.carLightmapMin.value.toArray(), u.carLightmapMax.value.toArray(), u.carLightmapClamp.value.toArray());
    }
    const tick = ++this.carLmTick;
    let e = this.carLm.get(i);
    if (!e && this.scope && typeof this.scope.scope === 'function') {
      const entry = { scope: this.scope.scope(), tex: null as THREE.Texture | null, used: tick };
      e = entry;
      this.carLm.set(i, entry);
      entry.scope
        .get(id, { wrapS: CLAMP, wrapT: CLAMP, palette: { key: `car:${key}`, rgba: this.carLmPalette } })
        .then(
          (t) => void (entry.tex = t),
          (err) => warnOnce(`orig-track-carlm:${this.stage.id}`, `[orig] track: car lightmap ${id} failed to load (${(err as Error)?.message ?? err}); the car stays unshadowed there`),
        );
      if (this.carLm.size > CAR_LIGHTMAP_CACHE) {
        let old = -1;
        let oldUsed = Infinity;
        for (const [k, v] of this.carLm) if (k !== i && v.used < oldUsed) (oldUsed = v.used), (old = k);
        if (old >= 0) {
          this.carLm.get(old)!.scope.dispose();
          this.carLm.delete(old);
        }
      }
    }
    if (!e) return null;
    e.used = tick;
    return e.tex;
  }

  particleLightAt(x: number, y: number, z: number, out: number[], hint = -1): number {
    const i = this.lightmapPatch(x, y, z, hint);
    const img = i >= 0 ? this.lmImages[i] : null;
    if (!img) return -1;
    const u = this.shared.particleLightmapMin.value;
    const key = `${u.x},${u.y},${u.z}`;
    if (key !== this.particleLutKey || !this.particleLut) {
      this.particleLutKey = key;
      this.particleLut = lightmapLut(u.toArray(), PARTICLE_LIGHTMAP_MAX, PARTICLE_LIGHTMAP_CLAMP);
    }
    const p = this.lmPatches!.patches[i];
    const [lu, lv] = projectLightmapUv(p.proj, x, this.mirrored ? -z : z);
    const L = img.levels[0];
    const k = 4 * sampleIndex(L.data, L.width, L.height, lu, lv);
    out[0] = this.particleLut[k] / 255;
    out[1] = this.particleLut[k + 1] / 255;
    out[2] = this.particleLut[k + 2] / 255;
    return i;
  }

  // ------------------------------------------------------------------------------------------- materials

  private baseMaterial(mj: TrackMaterialJson, prog: 'mask' | 'singleLit' | 'single', lightmap: string | null, worldPass: boolean): THREE.RawShaderMaterial {
    const fog = fogUniformMap(worldPass ? this.shared.worldFog : this.shared.trackFog);
    const u: Record<string, THREE.IUniform> = { ...fog, uBase1: { value: this.texture(mj.tex.base1) } };
    if (worldPass) u.uPassProjection = this.uPassProjection;
    else u.uTrackFar = this.uTrackFar;
    if (prog === 'mask') {
      u.uMask = { value: this.texture(mj.tex.mask) };
      u.uBase2 = { value: this.texture(mj.tex.base2) };
    }
    if (prog !== 'single') {
      u.uLightmap = { value: this.lightmap(lightmap) };
      // Mask2xVP iff doubleIntensity && lightmapEnable; TextureVPLightmap2x iff doubleIntensity [V @0x666808, @0x666caa]
      u.uLmScale = { value: mj.doubleIntensity ? 2 : 1 };
    }
    const mat = new THREE.RawShaderMaterial({
      name: `orig-track:${prog}:${mj.name}`,
      glslVersion: THREE.GLSL3,
      vertexShader: trackVertexShader(prog, worldPass),
      fragmentShader: trackFragmentShader(prog, worldPass),
      uniforms: u,
      side: THREE.FrontSide, // D3D CULL_CCW; the build swapped two indices per triangle for the z mirror
      depthTest: true,
      depthWrite: true,
    });
    return mat;
  }

  private bumpMaterial(mj: TrackMaterialJson): THREE.RawShaderMaterial {
    return new THREE.RawShaderMaterial({
      name: `orig-track:specBump:${mj.name}`,
      glslVersion: THREE.GLSL3,
      vertexShader: SPEC_BUMP_VS,
      fragmentShader: SPEC_BUMP_FS,
      uniforms: {
        uBump: { value: this.texture(mj.tex.bump) },
        uSpecular: this.uSpecular,
        uBumpLight: this.uBumpLight,
        uTrackFar: this.uTrackFar,
        uSimZ: this.uSimZ,
      },
      // ALPHABLEND, SRCBLEND = SRCALPHA, DESTBLEND = ONE, ZWRITE off, ZBIAS 5 [V @0x666d0d–0x666d3a]
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -5,
      side: THREE.FrontSide,
    });
  }

  private waterMaterial(pass: 1 | 2): THREE.RawShaderMaterial {
    const w = this.json.water;
    const fog = fogUniformMap(this.shared.trackFog);
    const tile = new THREE.Vector2(w && w.baseTile ? 1 / w.baseTile : 1, w && w.bumpTile ? 1 / w.bumpTile : 1);
    const common: Record<string, THREE.IUniform> = {
      ...fog,
      // FOGCOLOR = renderer +0x90 for the water passes: Track.fogColor, halved when a Water.EnvTex is bound
      uFogScale: { value: w?.envTex ? 0.5 : 1 },
      uTile: { value: tile },
      uScroll: this.uScroll,
      uPhase: this.uPhase,
      uBump: { value: this.volume ?? blackVolume() },
      uTrackFar: this.uTrackFar,
      uSimZ: this.uSimZ,
    };
    if (pass === 1) {
      return new THREE.RawShaderMaterial({
        name: 'orig-track:water',
        glslVersion: THREE.GLSL3,
        vertexShader: WATER_VS,
        fragmentShader: WATER_FS,
        uniforms: {
          ...common,
          uSun: this.uSun,
          uBumpLight: this.uBumpLight,
          uWaterSpecular: { value: new THREE.Vector3(...(w?.specularColor ?? [0, 0, 0])) },
        },
        side: THREE.FrontSide,
      });
    }
    return new THREE.RawShaderMaterial({
      name: 'orig-track:water2',
      glslVersion: THREE.GLSL3,
      vertexShader: WATER2_VS,
      fragmentShader: WATER2_FS,
      uniforms: { ...common, uEnv: { value: this.cube }, uEnvIntensity: { value: w?.envIntensity ?? 0 } },
      // ALPHABLEND, SRC = DEST = ONE, ZWRITE off, ZBIAS 5 [V @0x666dc5]
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -5,
      side: THREE.FrontSide,
    });
  }

  // ------------------------------------------------------------------------------------------- per frame

  update(camera: THREE.Camera, _dt: number): void {
    if (this.disposed) return;
    camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    // track view distance (race +0x740): HotSpot regulator at the camera's spline distance, else Track.viewDistance
    const st = this.json.settings;
    let far = st.viewDistance;
    if (st.hotspots.enabled && st.hotspots.global) {
      try {
        const p = this.stage.project({ x: this.camPos.x, y: this.camPos.y, z: this.camPos.z }, this.hintS);
        this.hintS = p.s;
        far = trackViewDistance(st, p.s);
      } catch {
        far = st.hotspots.global.trackViewDistance;
      }
    }
    // the camera's far plane is near + range (camera vtbl+0x2c takes the range; environment.ts MAIN_PASS_NEAR)
    this.uTrackFar.value = st.passes.trackNear + far;
    this.stats.viewDistance = far;

    // light vectors in SIM space (FUN_0049a680: sun → vtbl+0x4c with the bump light)
    const s = this.shared.sunDir.value;
    this.uSun.value.set(s.x, s.y, -s.z).normalize();
    const bl = bumpLightDir([this.uSun.value.x, this.uSun.value.y, this.uSun.value.z], st.bumpHeight);
    this.uBumpLight.value.set(bl[0], bl[1], bl[2]);
    const w = this.json.water;
    if (w) {
      const a = waterAnimation(w, this.shared.time.value);
      this.uScroll.value.set(a.baseScroll[0], a.baseScroll[1], a.bumpScroll[0], a.bumpScroll[1]);
      this.uPhase.value = a.phase;
    }

    // World pass projection (own mode): the camera's, with near 10 m / far 100 km (settings +0xc / +0x10)
    const cam = camera as THREE.PerspectiveCamera;
    this.updateWorldMode();
    if (this.world && this.worldMode === 'own') {
      const pm = this.uPassProjection.value.copy(cam.projectionMatrix);
      const n = st.passes.worldNear;
      const f = st.passes.worldFar;
      pm.elements[10] = -(f + n) / (f - n);
      pm.elements[14] = (-2 * f * n) / (f - n);
    }

    // quadtree culling against the view frustum with the far plane at the track view distance, in the
    // meshes' local frame (bounds are local; the object may be served mirrored)
    this.object3D.updateMatrixWorld();
    const mw = this.object3D.matrixWorld;
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(mw);
    this.patchMeshes ??= this.patches.map((p) => p.mesh);
    this.staticWorld.update(this.patchMeshes);
    this.frustum.setFromProjectionMatrix(this.projScreen, cam.coordinateSystem);
    camera.getWorldDirection(this.camDir);
    this.farPlane.normal.copy(this.camDir).negate();
    this.farPlane.constant = this.camDir.dot(this.camPos) + this.uTrackFar.value;
    this.frustum.planes[4].copy(this.farPlane).applyMatrix4(this.invObj.copy(mw).invert());
    for (const p of this.patches) p.mesh.visible = false;
    let vis = 0;
    let calls = this.world ? this.worldCalls : 0;
    let tris = this.world ? this.worldTris : 0;
    const stack = this.roots.slice();
    while (stack.length) {
      const n = this.nodes[stack.pop()!];
      if (!this.frustum.intersectsBox(n.box)) continue;
      for (const p of n.patches) {
        if (!this.frustum.intersectsBox(p.box)) continue;
        p.mesh.visible = true;
        if (p.track) vis++;
        calls += p.calls;
        tris += p.tris;
      }
      for (const c of n.children) stack.push(c);
    }
    this.stats.patches = vis;
    this.stats.drawCalls = calls;
    this.stats.triangles = tris;
  }

  heightAt(x: number, z: number): number {
    return this.height ? this.height.heightAt(x, this.mirrored ? -z : z) : NaN;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const e of this.carLm.values()) e.scope.dispose();
    this.carLm.clear();
    this.lmImages = [];
    this.black.dispose();
    blackVolumeTex?.dispose();
    blackVolumeTex = null;
    this.object3D.removeFromParent();
    this.object3D.clear();
    this.patches = [];
    this.nodes = [];
    this.world = null;
    // textures belong to the view's TextureScope (released by OriginalStageView.dispose)
  }
}

// ------------------------------------------------------------------------------------------- helpers

/** Share of the stage's road samples (between start and finish) that lie on the track mesh (|dy| < 2 m) in
 *  the contract frame (three = SIM with z negated) and z-mirrored; mirror when only the mirrored fit holds. */
export function stageFrameFit(stage: Stage, grid: { heightAt(x: number, z: number): number }, samples = 160): { n: number; sim: number; mirrored: number; mirrorZ: boolean } {
  const road = stage.road ?? [];
  const lo = stage.closed ? -Infinity : Math.min(stage.startS, stage.finishS);
  const hi = stage.closed ? Infinity : Math.max(stage.startS, stage.finishS);
  const pick = road.filter((r) => r.s >= lo && r.s <= hi);
  const list = pick.length >= 8 ? pick : road;
  const step = Math.max(1, Math.floor(list.length / samples));
  let n = 0;
  let sim = 0;
  let mir = 0;
  for (let i = 0; i < list.length; i += step) {
    const p = list[i].pos;
    n++;
    if (Math.abs(grid.heightAt(p.x, p.z) - p.y) < 2) sim++;
    if (Math.abs(grid.heightAt(p.x, -p.z) - p.y) < 2) mir++;
  }
  const fs = n ? sim / n : 0;
  const fm = n ? mir / n : 0;
  return { n, sim: fs, mirrored: fm, mirrorZ: fm > 0.5 && fm > fs };
}

function programOf(m: TrackMaterialJson): 'mask' | 'singleLit' | 'single' {
  if (m.type === 'Mask') return 'mask'; // Mask ignores `lightmapped` (always lightmapped) [V @0x6667ef]
  return m.lightmapped ? 'singleLit' : 'single'; // `lightmapped && lightmapEnable` [V @0x666c4f]
}

function texKey(id: string, clampU: boolean, clampV: boolean): string {
  return `${id}|${clampU ? 'c' : 'w'}${clampV ? 'c' : 'w'}`;
}

function box3(b: Bounds6): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
}

function unionBounds(a: Bounds6, b: Bounds6): Bounds6 {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])];
}

let blackVolumeTex: THREE.Data3DTexture | null = null;
/** Stand-in for a missing Water.BumpTex: a flat normal (0, 1, 0) volume. */
function blackVolume(): THREE.Data3DTexture {
  if (!blackVolumeTex) {
    warnOnce('orig-track:water-bump', '[orig] track: Water.BumpTex missing; the water uses a flat normal');
    blackVolumeTex = new THREE.Data3DTexture(new Uint8Array([128, 255, 128, 255]), 1, 1, 1);
    blackVolumeTex.colorSpace = THREE.NoColorSpace;
    blackVolumeTex.needsUpdate = true;
  }
  return blackVolumeTex;
}

/** The loaded component's frame statistics, or null (debug / tools; `object3D.userData.trackStats`). */
export function trackStats(c: OrigComponent | null | undefined): TrackFrameStats | null {
  return c instanceof TrackComponent ? c.stats : null;
}
