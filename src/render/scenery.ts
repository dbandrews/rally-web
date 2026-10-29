/**
 * src/render/scenery.ts — instanced scenery + start / checkpoint / finish gates (render builder).
 *
 * Instances are grouped by (kind, 160 m cell) into InstancedMeshes so frustum culling (camera and the
 * shadow camera) skips most of a long stage; one shared geometry + material per kind.
 */
import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { SceneryInstance, SceneryKind, Stage } from '../core/types';
import { box, boxBase, cylBase, merge, paint, place } from './geomUtil';
import type { HeightSampler } from './heightSampler';
import { LOD_DISTANCE, NOMINAL_HEIGHT, PROP_HIDE_DISTANCE, SHADOW_KINDS, TINT_KINDS, buildSceneryLod, buildSceneryModel } from './sceneryModels';
import { ROAD_LIFT } from './terrain';
import { textTexture } from './textures';

const CELL = 160;
const GATE_KINDS: ReadonlySet<SceneryKind> = new Set(['startGate', 'checkpointGate', 'finishGate']);

const modelCache = new Map<SceneryKind, THREE.BufferGeometry | null>();
const lodCache = new Map<SceneryKind, THREE.BufferGeometry | null>();
let sharedMat: THREE.MeshLambertMaterial | null = null;

function model(kind: SceneryKind): THREE.BufferGeometry | null {
  if (!modelCache.has(kind)) modelCache.set(kind, buildSceneryModel(kind));
  return modelCache.get(kind)!;
}
function lodModel(kind: SceneryKind): THREE.BufferGeometry | null {
  if (!lodCache.has(kind)) {
    const far = buildSceneryLod(kind);
    // kinds whose LOD is the full model reuse the same geometry (no second batch needed)
    lodCache.set(kind, far && LOD_DISTANCE[kind] !== undefined && LOD_DISTANCE[kind]! < 1e8 ? far : null);
  }
  return lodCache.get(kind)!;
}

/** One (kind, cell) batch: near model, optional far model, switching distances. */
export interface SceneryBatch {
  near: THREE.InstancedMesh;
  far: THREE.InstancedMesh | null;
  centre: THREE.Vector3;
  radius: number;
  lodDist: number;
  hideDist: number;
}

/** Scenery closer to the camera than NEAR_FADE_START (m) is fully cut away, fully drawn beyond NEAR_FADE_END. */
export const NEAR_FADE_START = 1.5;
export const NEAR_FADE_END = 3.5;

/**
 * Near-camera fade (screen-door dither): a chase camera that swings into a tree canopy or a building would
 * otherwise fill the screen with one flat polygon. Shadow depth passes use their own material, so shadows stay.
 */
function addNearFade(mat: THREE.Material): void {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
      {
        float rwFade = smoothstep(${NEAR_FADE_START.toFixed(2)}, ${NEAR_FADE_END.toFixed(2)}, length(vViewPosition));
        if (rwFade < 1.0) {
          vec2 rwP = floor(gl_FragCoord.xy);
          float rwT = fract(dot(rwP, vec2(0.7548777, 0.5698403)) + 0.5 * fract(rwP.y * 0.5));
          if (rwFade <= rwT) discard;
        }
      }`,
    );
  };
  mat.customProgramCacheKey = () => 'rw-scenery-nearfade';
}

function material(): THREE.MeshLambertMaterial {
  if (!sharedMat) {
    sharedMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    sharedMat.name = 'shared:scenery';
    addNearFade(sharedMat);
  }
  return sharedMat;
}

const SHIRTS = [0xd23b2e, 0x2f6fd0, 0xf2c037, 0x2e9e57, 0xf2f2f2, 0xe8742c, 0x7b4bc9, 0x222831, 0x47b5c9];
const TENTS = [0xf2f2f2, 0x2f6fd0, 0xd23b2e, 0xf2c037, 0x3a8f4a];

function tintFor(kind: SceneryKind, rng: Rng, out: THREE.Color, index = 0): THREE.Color {
  switch (kind) {
    case 'tyreStack':
      // painted tyre walls: pairs of red stacks between pairs of plain ones (white bands stay white)
      return (index >> 1) % 2 === 1 ? out.setRGB(1, 0.26, 0.2) : out.setRGB(1, 1, 1);
    case 'spectator':
      return out.setHex(SHIRTS[rng.int(0, SHIRTS.length - 1)]);
    case 'tent':
      return out.setHex(TENTS[rng.int(0, TENTS.length - 1)]);
    default: {
      const b = 0.82 + rng.next() * 0.3;
      const warm = (rng.next() - 0.5) * 0.12;
      return out.setRGB(b * (1 + warm), b, b * (1 - warm * 0.5));
    }
  }
}

export interface SceneryBuild {
  group: THREE.Group;
  /** Instances drawn (non-gate). */
  count: number;
  batches: SceneryBatch[];
}

/**
 * Per-frame LOD: near model inside lodDist, far model (or nothing) beyond, everything hidden past
 * hideDist. `scale` multiplies all distances (quality setting).
 */
export function updateSceneryLod(batches: readonly SceneryBatch[], cam: THREE.Vector3, scale = 1): void {
  for (const b of batches) {
    const d = Math.max(0, Math.hypot(b.centre.x - cam.x, b.centre.z - cam.z) - b.radius);
    const hidden = d > b.hideDist * scale;
    const near = !hidden && d <= b.lodDist * scale;
    b.near.visible = near;
    if (b.far) b.far.visible = !hidden && !near;
  }
}

export function buildScenery(stage: Stage, sampler: HeightSampler): SceneryBuild {
  const group = new THREE.Group();
  group.name = 'scenery';
  const rng = new Rng((stage.seed * 7919 + 17) >>> 0);
  const buckets = new Map<string, { kind: SceneryKind; items: SceneryInstance[] }>();
  let count = 0;
  for (const inst of stage.scenery) {
    if (GATE_KINDS.has(inst.kind)) continue;
    const cx = Math.floor(inst.pos.x / CELL), cz = Math.floor(inst.pos.z / CELL);
    const key = `${inst.kind}:${cx}:${cz}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { kind: inst.kind, items: [] }));
    b.items.push(inst);
  }
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const col = new THREE.Color();
  const batches: SceneryBatch[] = [];
  for (const { kind, items } of buckets.values()) {
    const geo = model(kind);
    if (!geo) continue;
    const mesh = new THREE.InstancedMesh(geo, material(), items.length);
    const tint = TINT_KINDS.has(kind);
    items.forEach((it, i) => {
      // keep the base on the rendered ground (sink slightly so slopes do not show floating edges)
      const g = sampler.heightAt(it.pos.x, it.pos.z);
      const y = Math.abs(g - it.pos.y) < 3 ? Math.min(it.pos.y, g) : it.pos.y;
      p.set(it.pos.x, y - 0.05, it.pos.z);
      q.setFromAxisAngle(up, it.rotY);
      // visual size from the instance height when given (independent of the world's nominal table)
      const sc = Math.min(6, Math.max(0.15, it.height > 0 ? it.height / NOMINAL_HEIGHT[kind] : it.scale > 0 ? it.scale : 1));
      s.set(sc, sc, sc);
      m4.compose(p, q, s);
      mesh.setMatrixAt(i, m4);
      if (tint) mesh.setColorAt(i, tintFor(kind, rng, col, i));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = SHADOW_KINDS.has(kind);
    mesh.receiveShadow = true;
    mesh.name = `scenery:${kind}`;
    group.add(mesh);
    count += items.length;
    // far LOD batch shares the instance matrices / colours
    const farGeo = lodModel(kind);
    let far: THREE.InstancedMesh | null = null;
    if (farGeo) {
      far = new THREE.InstancedMesh(farGeo, material(), items.length);
      far.instanceMatrix = mesh.instanceMatrix; // shared GPU buffers
      if (mesh.instanceColor) far.instanceColor = mesh.instanceColor;
      far.computeBoundingSphere();
      far.castShadow = false; // far trees are outside the shadow box anyway
      far.receiveShadow = false;
      far.name = `scenery:${kind}:far`;
      far.visible = false;
      group.add(far);
    }
    const bs = mesh.boundingSphere ?? new THREE.Sphere();
    const lodDist = LOD_DISTANCE[kind] ?? PROP_HIDE_DISTANCE;
    batches.push({
      near: mesh,
      far,
      centre: bs.center.clone(),
      radius: bs.radius,
      lodDist,
      hideDist: LOD_DISTANCE[kind] === undefined ? PROP_HIDE_DISTANCE : 1e9,
    });
  }
  group.add(buildGates(stage, sampler));
  return { group, count, batches };
}

// ------------------------------------------------------------------------------------------- gates

interface GateSpec {
  s: number;
  kind: 'start' | 'finish' | 'startFinish' | 'split';
  label: string;
}

function gateSpecs(stage: Stage): GateSpec[] {
  const out: GateSpec[] = [];
  const fromScenery = stage.scenery.filter((g) => GATE_KINDS.has(g.kind));
  const lapLine = stage.closed && (Math.abs(stage.finishS - stage.startS) < 1 || Math.abs(stage.finishS - stage.length) < 1);
  if (fromScenery.length) {
    let split = 0;
    for (const g of fromScenery) {
      const s = stage.project(g.pos).s;
      if (g.kind === 'checkpointGate') out.push({ s, kind: 'split', label: `SPLIT ${++split}` });
      else if (g.kind === 'startGate') out.push({ s, kind: lapLine ? 'startFinish' : 'start', label: lapLine ? 'START · FINISH' : 'START' });
      else out.push({ s, kind: 'finish', label: 'FINISH' });
    }
    return out;
  }
  out.push({ s: stage.startS, kind: lapLine ? 'startFinish' : 'start', label: lapLine ? 'START · FINISH' : 'START' });
  stage.checkpoints.forEach((s, i) => {
    if (s > 0 && s < stage.length) out.push({ s, kind: 'split', label: `SPLIT ${i + 1}` });
  });
  if (!lapLine) out.push({ s: stage.finishS, kind: 'finish', label: 'FINISH' });
  return out;
}

const GATE_STYLE = {
  start: { pillar: 0x2f9e4f, bg: 0x1d7a3a, fg: 0xffffff, chequer: undefined as number | undefined },
  startFinish: { pillar: 0x222222, bg: 0xf4f4f4, fg: 0x111111, chequer: 0x111111 },
  finish: { pillar: 0x222222, bg: 0xf4f4f4, fg: 0xc0221a, chequer: 0x111111 },
  split: { pillar: 0xf2b705, bg: 0x1b2a44, fg: 0xf2b705, chequer: undefined as number | undefined },
};

let gatePillarMat: THREE.MeshLambertMaterial | null = null;

function buildGates(stage: Stage, sampler: HeightSampler): THREE.Group {
  const group = new THREE.Group();
  group.name = 'gates';
  if (stage.road.length < 2) return group;
  if (!gatePillarMat) {
    gatePillarMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    gatePillarMat.name = 'shared:gate';
  }
  for (const g of gateSpecs(stage)) {
    const r = stage.roadAt(g.s);
    const t = stage.tangentAt(g.s);
    const style = GATE_STYLE[g.kind];
    const width = r.width + 3.0;
    const isSplit = g.kind === 'split';
    const H = isSplit ? 4.6 : 5.2;
    const boardH = isSplit ? 0.8 : 1.1;
    const pillarW = isSplit ? 0.35 : 0.7;
    // pillars + beam, built in gate-local space (span along X, facing -Z = travel direction)
    const parts: THREE.BufferGeometry[] = [];
    // feet: pillars reach down to the lower of road / terrain beside the road
    const right = new THREE.Vector3(-t.z, 0, t.x).normalize();
    for (const sx of [-1, 1]) {
      const x = sx * (width / 2 + pillarW / 2);
      const fx = r.pos.x + right.x * x, fz = r.pos.z + right.z * x;
      const drop = Math.max(0.5, r.pos.y - sampler.heightAt(fx, fz) + 0.3);
      parts.push(place(paint(boxBase(pillarW, H + drop, pillarW), style.pillar, 0.04), [x, -drop, 0]));
      if (!isSplit) parts.push(place(paint(cylBase(pillarW * 0.62, pillarW * 0.62, 0.3, 8), 0xffffff), [x, H - 0.05, 0]));
    }
    parts.push(place(paint(box(width + pillarW * 2, 0.25, 0.3), style.pillar), [0, H - boardH - 0.12, 0]));
    parts.push(place(paint(box(width + pillarW * 2, 0.25, 0.3), style.pillar), [0, H + 0.12, 0]));
    const frame = new THREE.Mesh(merge(parts), gatePillarMat);
    frame.castShadow = true;
    frame.receiveShadow = true;
    const root = new THREE.Group();
    root.add(frame);
    // text boards on both faces
    const tex = textTexture(g.label, { bg: style.bg, fg: style.fg, chequer: style.chequer, w: 1024, h: Math.round(1024 * (boardH / width)) || 128 });
    const boardMat = new THREE.MeshLambertMaterial({ map: tex, color: tex ? 0xffffff : style.bg });
    for (const face of [-1, 1]) {
      // +Z face is seen by the approaching car (gate local -Z = travel direction), -Z face when looking back
      const board = new THREE.Mesh(new THREE.PlaneGeometry(width, boardH), boardMat);
      board.position.set(0, H - boardH / 2, face * 0.16);
      board.rotation.y = face > 0 ? 0 : Math.PI;
      board.castShadow = true;
      root.add(board);
    }
    root.position.set(r.pos.x, r.pos.y + ROAD_LIFT, r.pos.z);
    root.rotation.y = Math.atan2(-t.x, -t.z);
    root.name = `gate:${g.label}`;
    group.add(root);
  }
  return group;
}

// ------------------------------------------------------------------------------------------- stage labels

/**
 * Stage.labels (test-pad patch names): a dark name plate with white text, readable from both sides, at the
 * label position (raised so it clears the ground), turned to label.rotY. One small mesh per label.
 */
export function buildStageLabels(stage: Stage, sampler: HeightSampler): THREE.Group {
  const group = new THREE.Group();
  group.name = 'stage-labels';
  for (const l of stage.labels ?? []) {
    const text = l.text.toUpperCase();
    const w = Math.min(9, Math.max(2.6, text.length * 0.42 + 0.8));
    const h = 0.8;
    const tex = textTexture(text, { bg: 0x14181e, fg: 0xffffff, w: 1024, h: Math.max(64, Math.round((1024 * h) / w)) });
    const mat = new THREE.MeshLambertMaterial({ map: tex, color: tex ? 0xffffff : 0x14181e });
    const root = new THREE.Group();
    for (const face of [-1, 1]) {
      // two single-sided planes back to back so the text never reads mirrored
      const board = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      board.position.z = face * 0.12;
      board.rotation.y = face > 0 ? 0 : Math.PI;
      root.add(board);
    }
    const ground = sampler.heightAt(l.pos.x, l.pos.z);
    root.position.set(l.pos.x, Math.max(l.pos.y, ground + 1.6), l.pos.z);
    root.rotation.y = l.rotY;
    root.name = `label:${l.text}`;
    group.add(root);
  }
  return group;
}
