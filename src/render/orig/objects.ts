/**
 * src/render/orig/objects.ts — OWNED BY THE OBJECTS BUILDER. Every placed object of an original stage: trees,
 * bushes, grass, Kuliss backdrops (TreeMesh) with their distant billboard impostors, rocks, buildings, signs, fences,
 * curbs, props (StandardMesh), spectators and animals (AnimatedMesh, bind pose).
 *
 * REQUIRED EXPORTS (keep the signature; composed by index.ts OriginalStageView):
 *   loadObjects(ctx: OrigLoadContext): Promise<OrigComponent | null>
 *
 * Data: stages/<id>/objects.json + objects.bin (tools/assets/parts/objects.py; layout in objectsData.ts). The build
 * step emits THREE-space instance matrices (objects.md §8: M_three = F·(diag(s)·R)ᵀ·F) and THREE-space vertices,
 * so the runtime only instantiates.
 *
 * Drawing (docs/orig/objects.md):
 *   * one InstancedBufferGeometry + material array per (template, StandardMesh LOD) and per (template, tree pass
 *     [, sort copy]); each template owns one dynamic instance buffer, refilled every frame with the visible
 *     instances grouped by bucket (LOD or tree sort copy k); every bucket's geometry addresses its sub-range of
 *     that buffer through attribute offsets. Billboard trees add one impostor quad batch (FUN_00573530).
 *   * per frame (update): the HotSpot regulator at the camera's spline distance (0x4e1240), the ObjectDrawer culling
 *     + fades with this frame's camera FOV (0x6f2970 / 0x6f2f90), the billboard-tree LOD (TreeRenderer::queue
 *     0x574590), frustum test, StandardMesh LOD (smLod), tree sort copy (treeSortVariant), back-to-front order
 *     within a bucket, the Kuliss / impostor facing yaw from the camera (FUN_005908d0 / FUN_00573530).
 *   * shaders: objectsShaders.ts (StandardMesh MODULATE2X lighting, the two-stage tree combiner, Sprite.vs shadow
 *     sphere, the impostor lrp, alpha test GREATER 0, the track fog).
 */
import * as THREE from 'three';
import type { OrigComponent, OrigLoadContext } from './common';
import {
  INST,
  INST_STRIDE,
  billboardFrame,
  billboardWeight,
  byteQ,
  cullFrame,
  hotspotSettings,
  maxVisibleDistance,
  objectAlpha,
  smLod,
  treeSortU,
  treeSortVariant,
  validateObjectsJson,
  type CullFrame,
  type ObjTemplate,
  type ObjectsJson,
  type ObjectsSettings,
  type SmMesh,
  type TmMesh,
} from './objectsData';
import { createBillboardMaterial, createObjMaterial, type ObjPass } from './objectsShaders';

export const OBJECTS_PART = 'objects';

/** Floats per instance in the GPU buffer: iRow0, iRow1, iRow2, iTint, iMisc. */
const RIS = 20;
/** Spatial cell (m) for skipping far instances. */
const CELL = 64;
/** Frustum-test padding (m · max scale): sprite quads expand beyond the mesh bbox in view space. */
const SPRITE_PAD = 2;
/** Floats per impostor in the billboard instance buffer (objectsShaders.ts iB0..iB3). */
const BIS = 16;
/** Pixels pass the alpha test when tex.a·TF.a > 0 (GREATER 0 on every object pass, objectsShaders.ts): only an
 *  instance alpha byte of 0 draws nothing. */
const ALPHA_MIN = 0.5 / 255;
/** Field of view used when the camera is not a PerspectiveCamera (renderer.fieldOfView default 70). */
const DEFAULT_FOV_DEG = 70;

interface Cell {
  cx: number;
  cz: number;
  rMax: number;
  start: number;
  end: number;
}

interface Bucket {
  mesh: THREE.Mesh;
  /** Leaf passes: the soft-edge sub-pass (same geometry, alpha 1..0x7F, no depth write; objectsShaders.ts `edge`). */
  soft: THREE.Mesh | null;
  geom: THREE.InstancedBufferGeometry;
  /** Instance offset currently bound (attributes rebuilt when it changes). */
  start: number;
}

interface BaseGeom {
  vb: THREE.InterleavedBuffer;
  index: THREE.BufferAttribute;
  tree: boolean;
}

/** Visible-instance scratch per template (reused). */
interface Scratch {
  idx: Uint32Array;
  key: Uint8Array;
  dist: Float32Array;
  alpha: Float32Array;
  n: number;
}

/** Impostor quads of one billboard-tree template (FUN_00573530): static per-instance quad data + a dynamic buffer. */
interface BillboardBatch {
  mesh: THREE.Mesh;
  geom: THREE.InstancedBufferGeometry;
  buf: THREE.InstancedInterleavedBuffer;
  data: Float32Array;
  /** Per instance: base.xyz, halfWidth·sx, up.xyz (= local +y · sy·height). */
  quad: Float32Array;
  /** billboardDistance (m) and the frame selector N (.tm sortDirections). */
  distance: number;
  dirs: number;
  idx: Uint32Array;
  dist: Float32Array;
  alpha: Float32Array;
  order: Uint32Array;
  n: number;
}

class TemplateBatch {
  readonly t: ObjTemplate;
  readonly n: number;
  readonly tree: boolean;
  /** Static instance records (INST_STRIDE floats each). */
  readonly src: Float32Array;
  readonly order: Uint32Array;
  readonly cells: Cell[];
  readonly buf: THREE.InstancedInterleavedBuffer;
  readonly data: Float32Array;
  /** Bucket count: StandardMesh LODs, or 8 tree sort copies (1 when the tree has no sorted lists). */
  readonly nKeys: number;
  /** meshes[key] = the meshes that draw bucket `key` (SM: one per LOD; tree: branches k + sprites k). */
  readonly keyed: Bucket[][];
  /** Tree passes over every visible instance (trunk, facing). */
  readonly all: Bucket[];
  readonly lodDist: number[] | undefined;
  readonly lodCount: number;
  readonly scratch: Scratch;
  readonly counts: Int32Array;
  readonly starts: Int32Array;
  rMaxAll = 0;
  /** Impostors (billboard trees with an atlas). */
  bb: BillboardBatch | null = null;

  constructor(t: ObjTemplate, src: Float32Array, nKeys: number, lodCount: number) {
    this.t = t;
    this.n = t.instCount;
    this.src = src;
    this.tree = t.geometryType?.toLowerCase() === 'treemesh';
    this.nKeys = nKeys;
    this.lodDist = t.lodDistances;
    this.lodCount = lodCount;
    this.data = new Float32Array(Math.max(1, this.n) * RIS);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, RIS, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    this.keyed = Array.from({ length: nKeys }, () => []);
    this.all = [];
    this.counts = new Int32Array(nKeys);
    this.starts = new Int32Array(nKeys);
    this.scratch = { idx: new Uint32Array(this.n), key: new Uint8Array(this.n), dist: new Float32Array(this.n), alpha: new Float32Array(this.n), n: 0 };
    // spatial cells over the instance positions (THREE xz)
    const byCell = new Map<string, number[]>();
    for (let i = 0; i < this.n; i++) {
      const o = i * INST_STRIDE;
      const x = src[o + INST.ROW0 + 3];
      const z = src[o + INST.ROW2 + 3];
      const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      let l = byCell.get(k);
      if (!l) byCell.set(k, (l = []));
      l.push(i);
    }
    this.order = new Uint32Array(this.n);
    this.cells = [];
    let p = 0;
    for (const [k, l] of byCell) {
      const [ix, iz] = k.split(',').map(Number);
      let rMax = 0;
      for (const i of l) {
        this.order[p++] = i;
        rMax = Math.max(rMax, src[i * INST_STRIDE + INST.RADIUS]);
      }
      this.rMaxAll = Math.max(this.rMaxAll, rMax);
      this.cells.push({ cx: (ix + 0.5) * CELL, cz: (iz + 0.5) * CELL, rMax, start: p - l.length, end: p });
    }
  }
}

export interface ObjectsStats {
  templates: number;
  instances: number;
  /** Mesh instances drawn this frame (impostors are counted in `billboards`). */
  visible: number;
  /** Impostor quads drawn this frame. */
  billboards: number;
  /** Meshes (instanced geometries) drawn this frame. */
  drawn: number;
  meshes: number;
  /** WebGL draw calls of the objects component this frame (one per visible material group). */
  drawCalls: number;
  /** Triangles submitted this frame (incl. instancing). */
  triangles: number;
  /** Instances the original's ObjectDrawer would have queued (it stops at 4096 per frame, 0x6f2cc6). */
  queued: number;
}

class ObjectsView implements OrigComponent {
  readonly object3D = new THREE.Group();
  readonly cameraFar: number;
  private readonly json: ObjectsJson;
  private readonly batches: TemplateBatch[] = [];
  private readonly materials = new Set<THREE.Material>();
  private readonly geoms = new Set<THREE.BufferGeometry>();
  private readonly settings: ObjectsSettings;
  private readonly live: ObjectsSettings;
  private readonly cull: CullFrame;
  private readonly stage: OrigLoadContext['stage'];
  private readonly faceX = { value: new THREE.Vector3(1, 0, 0) };
  private readonly faceZ = { value: new THREE.Vector3(0, 0, 1) };
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly viewInv = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly camPos = new THREE.Vector3();
  private readonly frame = { i0: 0, t: 0 };
  private readonly useHotspots: boolean;
  private hintS: number | undefined;
  private disposed = false;
  readonly lastStats: ObjectsStats = { templates: 0, instances: 0, visible: 0, billboards: 0, drawn: 0, meshes: 0, drawCalls: 0, triangles: 0, queued: 0 };

  constructor(json: ObjectsJson, ctx: OrigLoadContext) {
    this.json = json;
    this.stage = ctx.stage;
    this.object3D.name = 'orig:objects';
    this.object3D.userData.stats = this.lastStats; // tooling (tools/orig-objects-shots.mjs)
    this.settings = { ...json.settings };
    this.live = { ...json.settings };
    this.cull = cullFrame(this.settings, (DEFAULT_FOV_DEG * Math.PI) / 180);
    this.useHotspots = json.hotspots.some((h) => h.splineDistance !== undefined && (h.width ?? 0) > 0);
    // far enough for the farthest object view distance the regulator can reach (Global + any spot)
    const vd = Math.max(json.settings.viewDistance, ...json.hotspots.map((h) => h.viewDistance ?? 0));
    this.cameraFar = Math.ceil(vd + 100);
  }

  /** Build every batch (textures already resolved into `tex`). */
  build(bin: ArrayBuffer, tex: Map<string, THREE.Texture>, ctx: OrigLoadContext): void {
    const j = this.json;
    const inst = new Float32Array(bin, j.instOffset, j.instCount * INST_STRIDE);
    const bases = new Map<string, BaseGeom>();
    const baseOf = (mi: number, lod: number): BaseGeom | null => {
      const key = `${mi}:${lod}`;
      const hit = bases.get(key);
      if (hit) return hit;
      const m = j.meshes[mi];
      let vOff: number, vCount: number, iOff: number, iCount: number, iType: string, stride: number;
      if (m.type === 'sm') {
        const L = m.lods[lod];
        if (!L) return null;
        ({ vOffset: vOff, vCount, iOffset: iOff, iCount, iType } = L);
        stride = 8;
      } else {
        ({ vOffset: vOff, vCount, iOffset: iOff, iCount, iType } = m);
        stride = 10;
      }
      const vb = new THREE.InterleavedBuffer(new Float32Array(bin, vOff, vCount * stride), stride);
      const ia = iType === 'u16' ? new Uint16Array(bin, iOff, iCount) : new Uint32Array(bin, iOff, iCount);
      const b: BaseGeom = { vb, index: new THREE.BufferAttribute(ia, 1), tree: m.type === 'tm' };
      bases.set(key, b);
      return b;
    };
    const u = ctx.uniforms;
    for (const t of j.templates) {
      if (t.mesh < 0 || t.instCount <= 0) continue;
      const m = j.meshes[t.mesh];
      const src = inst.subarray(t.instOffset * INST_STRIDE, (t.instOffset + t.instCount) * INST_STRIDE);
      if (m.type === 'sm') {
        const lodCount = m.lods.length;
        const b = new TemplateBatch(t, src, lodCount, lodCount);
        for (let l = 0; l < lodCount; l++) {
          const L = m.lods[l];
          const base = baseOf(t.mesh, l);
          if (!L || !base || !L.materials.length) continue;
          const mats = L.materials.map((mat, i) => {
            const texId = t.materialTex?.[l]?.[i] ?? null;
            return this.material({
              pass: 'mesh',
              map: (texId && tex.get(this.texKey(texId, false))) || null,
              uniforms: u,
              lighting: t.lighting,
              lightMul: t.lightMul,
              shadowMul: t.shadowMul,
              transparent: mat.transparent,
              twosided: mat.twosided,
            });
          });
          // StandardMeshes draw before the tree pass (FUN_0049a300 order): renderOrder −2 < impostors −1 < trees 0..3
          b.keyed[l].push(this.bucket(base, L.materials.map((mat, i) => ({ start: mat.start, count: mat.count, mat: i })), mats, `${t.name}:lod${l}`, -2));
        }
        this.batches.push(b);
      } else {
        const tm = m as TmMesh;
        const sorted = tm.groups[0].length > 0 || tm.groups[2].length > 0;
        const nKeys = sorted ? Math.max(1, tm.sortDirections) : 1;
        const b = new TemplateBatch(t, src, nKeys, 1);
        const base = baseOf(t.mesh, 0);
        if (!base) continue;
        const trilinear = t.trilinear === true;
        const lightScale = t.billboard ? this.settings.billboardLightScale : this.settings.constantLightScale;
        const mk = (pass: ObjPass, list: number, edge?: 'core' | 'soft') =>
          tm.groups[list].map((_, e) => {
            const texId = t.groupTex?.[list]?.[e] ?? null;
            return this.material({
              pass,
              edge,
              map: (texId && tex.get(this.texKey(texId, !trilinear))) || null,
              uniforms: u,
              lighting: t.lighting,
              lightMul: t.lightMul,
              shadowMul: t.shadowMul,
              lightScale,
              faceX: this.faceX,
              faceZ: this.faceZ,
              crownCenter: tm.crownCenter,
              crownRadius: tm.crownRadius,
              gradiantFactor: t.gradiantFactor ?? 0.5,
            });
          });
        const ranges = (list: number, k: number) => tm.groups[list].map((e, i) => ({ start: e.start + e.triCount * 3 * k, count: e.triCount * 3, mat: i }));
        // draw order inside a tree (FUN_005908d0): trunk -> branches -> facing -> sprites; the impostors of the whole
        // pass come first (FUN_00572f80 calls the billboard pass 0x573530 before the 3D trees)
        // leaves: the depth-writing core at 1..3, their soft edges after every core at 3.25..3.75 (objectsShaders.ts)
        if (tm.groups[1].length) b.all.push(this.bucket(base, ranges(1, 0), mk('trunk', 1), `${t.name}:trunk`, 0));
        if (tm.groups[3].length) b.all.push(this.bucket(base, ranges(3, 0), mk('facing', 3, 'core'), `${t.name}:facing`, 2, mk('facing', 3, 'soft'), 3.5));
        const branchMats = tm.groups[0].length ? [mk('branches', 0, 'core'), mk('branches', 0, 'soft')] : null;
        const spriteMats = tm.groups[2].length ? [mk('sprites', 2, 'core'), mk('sprites', 2, 'soft')] : null;
        for (let k = 0; k < nKeys; k++) {
          if (branchMats) b.keyed[k].push(this.bucket(base, ranges(0, k), branchMats[0], `${t.name}:branches${k}`, 1, branchMats[1], 3.25));
          if (spriteMats) b.keyed[k].push(this.bucket(base, ranges(2, k), spriteMats[0], `${t.name}:sprites${k}`, 3, spriteMats[1], 3.75));
        }
        const bbTex = t.billboard?.tex ? tex.get(this.bbKey(t.billboard.tex)) : undefined;
        if (t.billboard && bbTex && t.billboard.halfWidth !== undefined) b.bb = this.billboardBatch(t, src, bbTex, ctx);
        this.batches.push(b);
      }
    }
    this.lastStats.templates = this.batches.length;
    this.lastStats.instances = this.batches.reduce((a, b) => a + b.n, 0);
  }

  /** Texture cache key: trees sample MIN/MAG linear with MIP point (tree pass @0x572fe9) unless the template enables
   *  mipmapBlending (template+0x151 → trilinear). */
  texKey(texId: string, mipPoint: boolean): string {
    return `${texId}|${mipPoint ? 'p' : 'l'}`;
  }

  /** Impostor atlas key: WRAP in u, CLAMP in v (ADDRESSU 1 / ADDRESSV 3, FUN_00573530 @0x57366f). */
  bbKey(texId: string): string {
    return `${texId}|bb`;
  }

  private matCache = new Map<string, THREE.ShaderMaterial>();

  private material(o: Parameters<typeof createObjMaterial>[0]): THREE.ShaderMaterial {
    const key = [o.pass, o.edge ?? '', o.map?.uuid ?? '-', o.lighting ? 1 : 0, o.lightMul.join('/'), o.shadowMul.join('/'), o.lightScale ?? '', o.transparent ? 1 : 0, o.twosided ? 1 : 0, o.crownCenter?.join('/') ?? '', o.crownRadius ?? '', o.gradiantFactor ?? ''].join('|');
    let m = this.matCache.get(key);
    if (!m) {
      m = createObjMaterial(o);
      this.matCache.set(key, m);
      this.materials.add(m);
    }
    return m;
  }

  /** One impostor quad per instance: 6 corners (two triangles BL-TL-BR, TL-TR-BR like the original's vertex order). */
  private billboardBatch(t: ObjTemplate, src: Float32Array, map: THREE.Texture, ctx: OrigLoadContext): BillboardBatch {
    const bb = t.billboard!;
    const n = t.instCount;
    const quad = new Float32Array(n * 7);
    for (let i = 0; i < n; i++) {
      const o = i * INST_STRIDE;
      // column 1 of the THREE matrix = mirrored local +y · sy; column 0 / 2 lengths = sx / sz
      const c1x = src[o + INST.ROW0 + 1];
      const c1y = src[o + INST.ROW1 + 1];
      const c1z = src[o + INST.ROW2 + 1];
      const sx = Math.hypot(src[o + INST.ROW0], src[o + INST.ROW1], src[o + INST.ROW2]);
      const sy = Math.hypot(c1x, c1y, c1z);
      const q = i * 7;
      quad[q] = src[o + INST.ROW0 + 3];
      quad[q + 1] = src[o + INST.ROW1 + 3] + (bb.minY ?? 0) * sy; // + (0, bbox.min.y·sy, 0) unrotated (0x591657)
      quad[q + 2] = src[o + INST.ROW2 + 3];
      quad[q + 3] = (bb.halfWidth ?? 0) * sx;
      const h = bb.height ?? 0; // up = row1 · 2·sy·height/2
      quad[q + 4] = c1x * h;
      quad[q + 5] = c1y * h;
      quad[q + 6] = c1z * h;
    }
    const g = new THREE.InstancedBufferGeometry();
    // corners (cx, cy, 0) in `position` (three takes a non-indexed draw count from position.count)
    const corners = new Float32Array([-1, 0, 0, -1, 1, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0, 1, 0, 0]);
    g.setAttribute('position', new THREE.BufferAttribute(corners, 3));
    const data = new Float32Array(Math.max(1, n) * BIS);
    const buf = new THREE.InstancedInterleavedBuffer(data, BIS, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iB0', new THREE.InterleavedBufferAttribute(buf, 4, 0));
    g.setAttribute('iB1', new THREE.InterleavedBufferAttribute(buf, 4, 4));
    g.setAttribute('iB2', new THREE.InterleavedBufferAttribute(buf, 4, 8));
    g.setAttribute('iB3', new THREE.InterleavedBufferAttribute(buf, 4, 12));
    g.instanceCount = 0;
    this.geoms.add(g);
    const mat = createBillboardMaterial({
      map,
      uniforms: ctx.uniforms,
      lightMul: t.lightMul,
      shadowMul: t.shadowMul,
      lightScale: this.settings.billboardLightScale,
      frames: bb.frames ?? Math.max(1, bb.resolution[2] ?? 1),
      faceX: this.faceX,
    });
    this.materials.add(mat);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `orig-objects:${t.name}:billboard`;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.renderOrder = -1;
    this.object3D.add(mesh);
    return {
      mesh,
      geom: g,
      buf,
      data,
      quad,
      distance: bb.distance,
      dirs: bb.dirs ?? 8,
      idx: new Uint32Array(n),
      dist: new Float32Array(n),
      alpha: new Float32Array(n),
      order: new Uint32Array(n),
      n: 0,
    };
  }

  private bucket(base: BaseGeom, ranges: { start: number; count: number; mat: number }[], mats: THREE.Material[], name: string, order = 0, softMats?: THREE.Material[], softOrder = order): Bucket {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(base.vb, 3, 0));
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(base.vb, 3, 3));
    g.setAttribute('uv', new THREE.InterleavedBufferAttribute(base.vb, 2, 6));
    if (base.tree) g.setAttribute('spriteOffset', new THREE.InterleavedBufferAttribute(base.vb, 2, 8));
    g.setIndex(base.index);
    for (const r of ranges) g.addGroup(r.start, r.count, r.mat);
    g.instanceCount = 0;
    this.geoms.add(g);
    const mesh = new THREE.Mesh(g, mats);
    mesh.name = `orig-objects:${name}`;
    mesh.frustumCulled = false; // culled per instance on the CPU
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.renderOrder = order;
    this.object3D.add(mesh);
    let soft: THREE.Mesh | null = null;
    if (softMats) {
      soft = new THREE.Mesh(g, softMats);
      soft.name = `orig-objects:${name}:soft`;
      soft.frustumCulled = false;
      soft.matrixAutoUpdate = false;
      soft.visible = false;
      soft.renderOrder = softOrder;
      this.object3D.add(soft);
    }
    return { mesh, soft, geom: g, start: -1 };
  }

  private bind(b: Bucket, buf: THREE.InstancedInterleavedBuffer, start: number, count: number): void {
    if (b.start !== start) {
      const o = start * RIS;
      b.geom.setAttribute('iRow0', new THREE.InterleavedBufferAttribute(buf, 4, o));
      b.geom.setAttribute('iRow1', new THREE.InterleavedBufferAttribute(buf, 4, o + 4));
      b.geom.setAttribute('iRow2', new THREE.InterleavedBufferAttribute(buf, 4, o + 8));
      b.geom.setAttribute('iTint', new THREE.InterleavedBufferAttribute(buf, 4, o + 12));
      b.geom.setAttribute('iMisc', new THREE.InterleavedBufferAttribute(buf, 4, o + 16));
      b.start = start;
    }
    b.geom.instanceCount = count;
    b.mesh.visible = count > 0;
    if (b.soft) b.soft.visible = count > 0;
  }

  update(camera: THREE.Camera, _dt: number): void {
    if (this.disposed) return;
    camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    const cx = this.camPos.x;
    const cy = this.camPos.y;
    const cz = this.camPos.z;
    // HotSpot regulator (0x4e1240) at the camera's spline distance
    let s = this.settings;
    if (this.useHotspots) {
      try {
        const p = this.stage.project({ x: cx, y: cy, z: cz }, this.hintS);
        this.hintS = p.s;
        s = hotspotSettings(this.settings, this.json.hotspots, p.s, this.live);
      } catch {
        s = this.settings;
      }
    }
    // ObjectDrawer constants of this frame (projected-size cull from the camera FOV, 0x6f2f90)
    const fov = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? (camera as THREE.PerspectiveCamera).fov : DEFAULT_FOV_DEG;
    const cf = cullFrame(s, (fov * Math.PI) / 180, this.cull);
    // facing yaw of the Kuliss pass and the impostors (FUN_005908d0 @0x5908da, FUN_00573530 @0x573bf3), SIM frame:
    // a = atan2(V[2][2], V[2][0]) + π/2 with V the view matrix: V[2][2] = forward.z, V[2][0] = right.z; local X =
    // (cos a, 0, −sin a), local Z = (sin a, 0, cos a). THREE: right_sim.z = −e[2], forward_sim.z = e[10].
    const e = camera.matrixWorld.elements;
    const a = Math.atan2(e[10], -e[2]) + Math.PI / 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    this.faceX.value.set(ca, 0, sa);
    this.faceZ.value.set(-sa, 0, ca);
    this.viewInv.copy(camera.matrixWorld).invert();
    this.projView.multiplyMatrices((camera as THREE.PerspectiveCamera).projectionMatrix, this.viewInv);
    this.frustum.setFromProjectionMatrix(this.projView);
    const st = this.lastStats;
    st.visible = 0;
    st.billboards = 0;
    st.queued = 0;
    for (const b of this.batches) this.updateBatch(b, s, cf, cx, cy, cz);
    let drawn = 0;
    let calls = 0;
    let tris = 0;
    for (const c of this.object3D.children) {
      if (!c.visible) continue;
      drawn++;
      const g = (c as THREE.Mesh).geometry as THREE.InstancedBufferGeometry;
      const n = g.instanceCount;
      if (g.groups.length) {
        calls += g.groups.length;
        for (const gr of g.groups) tris += (gr.count / 3) * n;
      } else {
        calls++;
        tris += 2 * n;
      }
    }
    st.drawn = drawn;
    st.drawCalls = calls;
    st.triangles = tris;
    st.meshes = this.object3D.children.length;
  }

  private updateBatch(b: TemplateBatch, s: ObjectsSettings, cf: CullFrame, cx: number, cy: number, cz: number): void {
    const src = b.src;
    const sc = b.scratch;
    sc.n = 0;
    const tree = b.tree;
    const sorted = tree && b.nKeys > 1;
    const bb = b.bb;
    if (bb) bb.n = 0;
    const bbScale = s.billboardLODScale;
    const bbFade = s.billboardFadeScale;
    for (const cell of b.cells) {
      const range = maxVisibleDistance(cell.rMax, cf) + CELL * 0.7072;
      const dxc = cell.cx - cx;
      const dzc = cell.cz - cz;
      if (dxc * dxc + dzc * dzc > range * range) continue;
      for (let p = cell.start; p < cell.end; p++) {
        const i = b.order[p];
        const o = i * INST_STRIDE;
        const x = src[o + 3];
        const y = src[o + 7];
        const z = src[o + 11];
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        const r = src[o + INST.RADIUS];
        const alpha = objectAlpha(d2, r, src[o + INST.RND], cf);
        if (alpha <= 0) continue;
        this.sphere.center.set(x, y, z);
        this.sphere.radius = r + (tree ? SPRITE_PAD * src[o + INST.MAX_SCALE] : 0);
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
        this.lastStats.queued++;
        let meshAlpha: number;
        if (bb) {
          // TreeRenderer::queue (0x574590): horizontal distance, D scaled by the instance's max scale
          const distXZ = Math.sqrt(dx * dx + dz * dz);
          const D = bb.distance * bbScale * src[o + INST.MAX_SCALE];
          const w = billboardWeight(distXZ, D, D * bbFade);
          if (w >= 0) {
            const ba = byteQ(w * alpha);
            if (ba > ALPHA_MIN) {
              const k = bb.n++;
              bb.idx[k] = i;
              bb.dist[k] = d2;
              bb.alpha[k] = ba;
            }
            const w2 = w * w;
            meshAlpha = distXZ < D ? byteQ((1 - w2 * w2) * alpha) : 0;
          } else meshAlpha = byteQ(alpha);
        } else meshAlpha = byteQ(alpha);
        if (meshAlpha <= ALPHA_MIN) continue;
        let key = 0;
        if (sorted) {
          // sim frame: camera − tree with z negated
          key = treeSortVariant(-dx, dz, src[o + INST.SORT_Z], src[o + INST.SORT_Z + 1], src[o + INST.SORT_X], src[o + INST.SORT_X + 1], b.nKeys);
        } else if (!tree && b.lodCount > 1) {
          key = smLod(d2, r, src[o + INST.MAX_SCALE], b.lodDist, b.lodCount, s.lodDistanceScale);
        }
        const k = sc.n++;
        sc.idx[k] = i;
        sc.key[k] = key;
        sc.dist[k] = d2;
        sc.alpha[k] = meshAlpha;
      }
    }
    this.lastStats.visible += sc.n;
    if (bb) this.fillBillboards(b, bb, cx, cz);
    // bucket by key (counting sort), far → near inside a bucket (blending order)
    const counts = b.counts;
    const starts = b.starts;
    counts.fill(0);
    for (let k = 0; k < sc.n; k++) counts[sc.key[k]]++;
    let acc = 0;
    for (let k = 0; k < b.nKeys; k++) {
      starts[k] = acc;
      acc += counts[k];
    }
    const perm = permScratch(sc.n);
    const fill = fillScratch(b.nKeys);
    for (let k = 0; k < b.nKeys; k++) fill[k] = starts[k];
    for (let k = 0; k < sc.n; k++) perm[fill[sc.key[k]]++] = k;
    if (tree || b.t.kind === 'spectator') {
      for (let k = 0; k < b.nKeys; k++) {
        if (counts[k] > 1) sortRangeByDistDesc(perm, starts[k], starts[k] + counts[k], sc.dist);
      }
    }
    const data = b.data;
    for (let w = 0; w < sc.n; w++) {
      const k = perm[w];
      const i = sc.idx[k];
      const o = i * INST_STRIDE;
      const q = w * RIS;
      for (let c = 0; c < 16; c++) data[q + c] = src[o + c];
      data[q + 16] = sc.alpha[k];
      data[q + 17] = 0;
      data[q + 18] = 0;
      data[q + 19] = 0;
    }
    if (sc.n > 0) {
      b.buf.clearUpdateRanges();
      b.buf.addUpdateRange(0, sc.n * RIS);
      b.buf.needsUpdate = true;
    }
    for (let k = 0; k < b.nKeys; k++) for (const bk of b.keyed[k]) this.bind(bk, b.buf, starts[k], counts[k]);
    for (const bk of b.all) this.bind(bk, b.buf, 0, sc.n);
  }

  /** Impostor quads (FUN_00573530): frame pair from the sort parameter, far → near. */
  private fillBillboards(b: TemplateBatch, bb: BillboardBatch, cx: number, cz: number): void {
    const n = bb.n;
    const src = b.src;
    const order = bb.order;
    for (let k = 0; k < n; k++) order[k] = k;
    if (n > 1) sortRangeByDistDesc(order, 0, n, bb.dist);
    const data = bb.data;
    const q7 = bb.quad;
    const fr = this.frame;
    for (let w = 0; w < n; w++) {
      const k = order[w];
      const i = bb.idx[k];
      const o = i * INST_STRIDE;
      const q = i * 7;
      const dxSim = cx - src[o + 3];
      const dzSim = -(cz - src[o + 11]);
      billboardFrame(treeSortU(dxSim, dzSim, src[o + INST.SORT_Z], src[o + INST.SORT_Z + 1], src[o + INST.SORT_X], src[o + INST.SORT_X + 1]), bb.dirs, fr);
      const d = w * BIS;
      data[d] = q7[q];
      data[d + 1] = q7[q + 1];
      data[d + 2] = q7[q + 2];
      data[d + 3] = q7[q + 3];
      data[d + 4] = q7[q + 4];
      data[d + 5] = q7[q + 5];
      data[d + 6] = q7[q + 6];
      data[d + 7] = fr.i0;
      data[d + 8] = byteQ(fr.t); // specular alpha byte (ftol(t·255)), the lrp weight
      data[d + 9] = bb.alpha[k];
      data[d + 10] = src[o + INST.SHADOW];
      data[d + 11] = 0;
      data[d + 12] = src[o + INST.COLOR];
      data[d + 13] = src[o + INST.COLOR + 1];
      data[d + 14] = src[o + INST.COLOR + 2];
      data[d + 15] = 0;
    }
    if (n > 0) {
      bb.buf.clearUpdateRanges();
      bb.buf.addUpdateRange(0, n * BIS);
      bb.buf.needsUpdate = true;
    }
    bb.geom.instanceCount = n;
    bb.mesh.visible = n > 0;
    this.lastStats.billboards += n;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.geoms) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geoms.clear();
    this.materials.clear();
    this.object3D.removeFromParent();
    this.object3D.clear();
  }
}

// scratch arrays shared by every batch (update runs batch by batch)
let permBuf = new Uint32Array(1024);
let fillBuf = new Int32Array(16);
function permScratch(n: number): Uint32Array {
  if (permBuf.length < n) permBuf = new Uint32Array(Math.max(n, permBuf.length * 2));
  return permBuf;
}
function fillScratch(n: number): Int32Array {
  if (fillBuf.length < n) fillBuf = new Int32Array(n);
  return fillBuf;
}

/** Insertion sort for small ranges, else a typed-array sort by key (distance, descending). */
function sortRangeByDistDesc(perm: Uint32Array, a: number, b: number, dist: Float32Array): void {
  const n = b - a;
  if (n <= 24) {
    for (let i = a + 1; i < b; i++) {
      const v = perm[i];
      const dv = dist[v];
      let j = i - 1;
      while (j >= a && dist[perm[j]] < dv) {
        perm[j + 1] = perm[j];
        j--;
      }
      perm[j + 1] = v;
    }
    return;
  }
  const sub = Array.from(perm.subarray(a, b));
  sub.sort((x, y) => dist[y] - dist[x]);
  perm.set(sub, a);
}

/** Loads stages/<id>/objects.{json,bin}; null when the part is absent. Throws on real failures (the view warns once). */
export async function loadObjects(ctx: OrigLoadContext): Promise<OrigComponent | null> {
  if (!ctx.parts.includes(OBJECTS_PART)) return null;
  const [raw, bin] = await Promise.all([ctx.fetchPartJson<unknown>(OBJECTS_PART), ctx.fetchPartBuffer(OBJECTS_PART, 'bin')]);
  const json = validateObjectsJson(raw);
  if (bin.byteLength < json.binBytes) throw new Error(`objects.bin: ${bin.byteLength} bytes, expected ${json.binBytes}`);
  // textures: StandardMesh trilinear (store default), trees MIN/MAG linear + MIP point unless trilinear
  const want = new Map<string, { id: string; mipPoint: boolean }>();
  const view = new ObjectsView(json, ctx);
  for (const t of json.templates) {
    if (t.mesh < 0) continue;
    const tree = (t.geometryType ?? '').toLowerCase() === 'treemesh';
    const mipPoint = tree && t.trilinear !== true;
    for (const row of t.materialTex ?? []) for (const id of row) if (id) want.set(view.texKey(id, false), { id, mipPoint: false });
    for (const row of t.groupTex ?? []) for (const id of row) if (id) want.set(view.texKey(id, mipPoint), { id, mipPoint });
  }
  // impostor atlases (FUN_00573530): ADDRESSU WRAP, ADDRESSV CLAMP; the pass sets no filter, it inherits the tree
  // pass's MIN/MAG linear + MIP point (docs/orig/objects.md)
  const bbWant = new Set<string>();
  for (const t of json.templates) if (t.mesh >= 0 && t.billboard?.tex) bbWant.add(t.billboard.tex);
  const levels = json.texLevels ?? {};
  const tex = new Map<string, THREE.Texture>();
  await Promise.all([
    ...[...want].map(async ([key, w]) => {
      const multi = (levels[w.id] ?? 2) > 1;
      const t = await ctx.textures.get(w.id, {
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        minFilter: !multi ? THREE.LinearFilter : w.mipPoint ? THREE.LinearMipmapNearestFilter : THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });
      tex.set(key, t);
    }),
    ...[...bbWant].map(async (id) => {
      const multi = (levels[id] ?? 2) > 1;
      const t = await ctx.textures.get(id, {
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        minFilter: multi ? THREE.LinearMipmapNearestFilter : THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      tex.set(view.bbKey(id), t);
    }),
  ]);
  view.build(bin, tex, ctx);
  return view;
}

export type { ObjectsView };
export type { SmMesh };
