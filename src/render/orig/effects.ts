/**
 * src/render/orig/effects.ts — the ORIGINAL car effects under an original stage view (effects builder).
 *
 *   OrigEffectsSystem   one per renderer: loads stages/<id>/effects.json (orig/effectsData.ts), owns one sprite
 *                       batch per SpriteParticle template (one instanced draw call each, depth-sorted), the
 *                       original skid marks and the global particle cap; update(dt, camera) once per frame.
 *   OrigCarFx           one per car: the CarFx emitters of the stage (PFX_Template bases × children, per wheel
 *                       for the wheel modes), the exhaust bursts (Burst.con), the skid strips and the drop shadow;
 *                       update(telemetry, pose) once per frame.
 *
 * Semantics (research/formats/effects.md, exe addresses there): CarFx fade from the physics variable (§3,
 * 0x757650), emitter spawn loop (§4, 0x787f00: rate = intensity × intensityOverTime, ≤ 100 per frame,
 * posSpeed sampled once per frame, relPos per particle, particle alpha × fade at spawn), particle integration
 * (§5, 0x576dc0: midpoint, gravity −9.82·gravMod·OT, drag k·OT·v), render colour (§5.4, 0x575490: colour OT +
 * variance, × global colour, close-distance fade, alpha cull 2/255), the Sprite*.vs shaders (camera-facing
 * quads, UV rotation, no fog), skid marks (§7, CarWheel 0x75bfa0 + skidMarkNoBump), drop shadow (§8).
 * Deviations (WebGL / untraced) are listed in docs/orig/effects.md.
 */
import * as THREE from 'three';
import { DT, origFromMaterial } from '../../core/constants';
import type { CarRenderState, CarTelemetry } from '../../core/types';
import { warnOnce } from '../../core/assets';
import { ORIG_FOG_PARS, fogUniformMap, origUniforms } from './common';
import type { TextureScope, TextureStore } from './textures';
import {
  FxRng,
  carFxFade,
  evalOT,
  lightAt,
  loadCarEffects,
  loadStageEffects,
  overTimeTable,
  phyVar,
  sampleRD,
  type CarEffectsDef,
  type CarFxChild,
  type CarFxDef,
  type EmitterDef,
  type PhyVarInput,
  type SpriteDef,
  type StageEffects,
} from './effectsData';

const GRAVITY = -9.819999694824219; // 0x810110
const DEG = Math.PI / 180;
const BODY_Z_OFFSET = 2.0; // 0x806700 added to the child's z in the body modes 0..3 (0x757748 …)
const MAX_SPAWN_PER_FRAME = 100; // 0x788475
const SKID_SPEED_MIN = 1.0; // 0x75c114: car speed > 1 m/s
const SKID_SLIP_SCALE = 0.3; // 0x8066f8
const PIPE_FUME_SPEED = 8.333333969116211; // 0x82f4e0
const PIPE_FUME_SLOPE = -0.23999997973442078; // 0x830144

// ------------------------------------------------------------------------------------------- helpers

/** sim → three (x, y, −z). */
const toThree = (v: THREE.Vector3, x: number, y: number, z: number) => v.set(x, y, -z);

interface Frame {
  pos: THREE.Vector3;
  dof: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
}
const newFrame = (): Frame => ({ pos: new THREE.Vector3(), dof: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3() });

function blendFactor(d3d: number): THREE.BlendingDstFactor {
  switch (d3d) {
    case 1: return THREE.ZeroFactor;
    case 2: return THREE.OneFactor;
    case 3: return THREE.SrcColorFactor;
    case 4: return THREE.OneMinusSrcColorFactor;
    case 5: return THREE.SrcAlphaFactor;
    case 6: return THREE.OneMinusSrcAlphaFactor;
    case 7: return THREE.DstAlphaFactor;
    case 8: return THREE.OneMinusDstAlphaFactor;
    case 9: return THREE.DstColorFactor;
    case 10: return THREE.OneMinusDstColorFactor;
    default: return THREE.OneFactor;
  }
}

// ------------------------------------------------------------------------------------------- sprite batch

const SPRITE_VERT = /* glsl */ `
in vec3 iPos;
in vec2 iWH;
in vec2 iSinCos;
in vec4 iCol;
in float iFrame;
uniform float uUVRot;
out vec4 vCol;
out vec3 vUv;
void main() {
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  vec2 corner = position.xy;            // (±1, ±1)
  vec2 wh = iWH * corner;               // the signed SPRITE_WH of this vertex
  float s = iSinCos.x, c = iSinCos.y;
  if (uUVRot > 0.5) {
    // SpriteUVRot.vs: unrotated quad, UVs rotated about (0.5, 0.5)
    mv.xy += wh;
    vec2 f = step(0.0, corner) - 0.5;
    vUv = vec3(c * f.x - s * f.y + 0.5, 0.5 - (s * f.x + c * f.y), iFrame);
  } else {
    // Sprite.vs: x' = w·c − h·s, y' = w·s + h·c
    mv.x += wh.x * c - wh.y * s;
    mv.y += wh.x * s + wh.y * c;
    vUv = vec3(0.5 * corner.x + 0.5, 0.5 - 0.5 * corner.y, iFrame);
  }
  vCol = iCol;
  gl_Position = projectionMatrix * mv;
}`;

const SPRITE_FRAG_2D = /* glsl */ `
uniform sampler2D uTex;
in vec4 vCol;
in vec3 vUv;
out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vUv.xy);
  vec4 c = t * vCol;
  if (c.a <= 0.0) discard;              // alpha test GREATER 0 (alphaTestRef 0 on every shipped template)
  outColor = c;
}`;

const SPRITE_FRAG_3D = /* glsl */ `
uniform sampler3D uTex;
uniform float uDepth;
in vec4 vCol;
in vec3 vUv;
out vec4 outColor;
void main() {
  // animated sprites: the frame index runs over the volume slices (w wraps like the D3D volume address)
  float w = (fract(vUv.z) * uDepth + 0.5) / uDepth;
  vec4 t = texture(uTex, vec3(vUv.xy, w));
  vec4 c = t * vCol;
  if (c.a <= 0.0) discard;
  outColor = c;
}`;

/**
 * Stable sort of ord[0..n) by dep[0..n) DESCENDING (equal depths keep their order): the back-to-front order of the
 * original insertion sort, in O(n) for the larger batches (an LSD radix sort on the float32 bits: depths are positive,
 * so the IEEE bit patterns order like the values; the complemented key sorts descending). `dep` is clobbered, only `ord`
 * is the result. Scratch is shared (the batches sort one after the other).
 */
export class DepthSorter {
  private keyA = new Uint32Array(0);
  private keyB = new Uint32Array(0);
  private ordB = new Uint32Array(0);
  private readonly hist = new Uint32Array(2048);

  sort(dep: Float32Array, ord: Uint32Array, n: number): void {
    if (n < 2) return;
    if (n <= DepthSorter.INSERTION_MAX) {
      for (let a = 1; a < n; a++) {
        const kd = dep[a], ko = ord[a];
        let b = a - 1;
        while (b >= 0 && dep[b] < kd) {
          dep[b + 1] = dep[b];
          ord[b + 1] = ord[b];
          b--;
        }
        dep[b + 1] = kd;
        ord[b + 1] = ko;
      }
      return;
    }
    if (this.keyA.length < n) {
      const cap = Math.max(n, this.keyA.length * 2);
      this.keyA = new Uint32Array(cap);
      this.keyB = new Uint32Array(cap);
      this.ordB = new Uint32Array(cap);
    }
    const bits = new Uint32Array(dep.buffer, dep.byteOffset, n);
    let ka = this.keyA, kb = this.keyB;
    let oa: Uint32Array = ord, ob: Uint32Array = this.ordB;
    for (let i = 0; i < n; i++) ka[i] = ~bits[i];
    const hist = this.hist;
    for (let shift = 0; shift < 33; shift += 11) {
      hist.fill(0);
      for (let i = 0; i < n; i++) hist[(ka[i] >>> shift) & 2047]++;
      let sum = 0;
      for (let b = 0; b < 2048; b++) {
        const c = hist[b];
        hist[b] = sum;
        sum += c;
      }
      for (let i = 0; i < n; i++) {
        const k = ka[i];
        const j = hist[(k >>> shift) & 2047]++;
        kb[j] = k;
        ob[j] = oa[i];
      }
      [ka, kb] = [kb, ka];
      [oa, ob] = [ob, oa];
    }
    // three passes: the sorted order sits in the scratch array
    for (let i = 0; i < n; i++) ord[i] = oa[i];
  }

  static readonly INSERTION_MAX = 128;
}

const depthSorter = new DepthSorter();

/** Per-template particle pool + one instanced draw call. */
class SpriteBatch {
  readonly def: SpriteDef;
  readonly mesh: THREE.Mesh;
  count = 0;
  private cap = 0;
  // state (SoA)
  pos = new Float32Array(0);
  vel = new Float32Array(0);
  birth = new Float64Array(0);
  death = new Float64Array(0);
  size0 = new Float32Array(0);
  xy0 = new Float32Array(0);
  grav = new Float32Array(0);
  drag = new Float32Array(0);
  rot = new Float32Array(0);
  rotSpeed = new Float32Array(0);
  frame = new Float32Array(0);
  animSpeed = new Float32Array(0);
  variance = new Float32Array(0);
  alphaScale = new Float32Array(0);
  light = new Float32Array(0);
  groundY = new Float32Array(0);
  prevPlaneD = new Float32Array(0);
  // per-frame render scratch
  private sizeNow = new Float32Array(0);
  private depth = new Float32Array(0);
  private order = new Uint32Array(0);
  private readonly geo: THREE.InstancedBufferGeometry;
  private aPos!: THREE.InstancedBufferAttribute;
  private aWH!: THREE.InstancedBufferAttribute;
  private aSC!: THREE.InstancedBufferAttribute;
  private aCol!: THREE.InstancedBufferAttribute;
  private aFrame!: THREE.InstancedBufferAttribute;
  readonly mat: THREE.RawShaderMaterial | THREE.ShaderMaterial;
  readonly tables: {
    size: Float32Array; grav: Float32Array; drag: Float32Array; xy: Float32Array; rot: Float32Array;
    anim: Float32Array; color: Float32Array;
  };
  readonly frames: number;
  meanDepth = 0;

  /** `capacity`: the particles the batch can hold before it has to grow (the stage's global cap: no growth mid-race). */
  constructor(def: SpriteDef, tex: THREE.Texture | null, frames: number, capacity = 64) {
    this.def = def;
    this.frames = Math.max(1, frames);
    this.tables = {
      size: overTimeTable(def.sizeOverTime),
      grav: overTimeTable(def.gravityModifierOverTime),
      drag: overTimeTable(def.dragInDofOverTime),
      xy: overTimeTable(def.XYSizeRatioOverTime),
      rot: overTimeTable(def.rotationSpeedOverTime),
      anim: overTimeTable(def.animationSpeedOverTime),
      color: overTimeTable(def.colorRGBAOverTime, 4, [255, 255, 255, 255]),
    };
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.instanceCount = 0;
    this.geo = g;
    this.grow(Math.max(64, capacity));
    const volume = tex instanceof THREE.Data3DTexture;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uTex: { value: tex },
        uDepth: { value: this.frames },
        uUVRot: { value: def.useUVRotation ? 1 : 0 },
      },
      vertexShader: SPRITE_VERT,
      fragmentShader: volume ? SPRITE_FRAG_3D : SPRITE_FRAG_2D,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: blendFactor(def.srcBlendMode) as THREE.BlendingSrcFactor,
      blendDst: blendFactor(def.destBlendMode),
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = 'origfx:' + def.texture;
  }

  private grow(n: number): void {
    if (n <= this.cap) return;
    const cap = Math.max(n, this.cap * 2);
    const g1 = <T extends Float32Array | Float64Array>(a: T, k: number, C: new (n: number) => T): T => {
      const b = new C(cap * k);
      b.set(a);
      return b;
    };
    this.pos = g1(this.pos, 3, Float32Array);
    this.vel = g1(this.vel, 3, Float32Array);
    this.birth = g1(this.birth, 1, Float64Array);
    this.death = g1(this.death, 1, Float64Array);
    this.size0 = g1(this.size0, 1, Float32Array);
    this.xy0 = g1(this.xy0, 1, Float32Array);
    this.grav = g1(this.grav, 1, Float32Array);
    this.drag = g1(this.drag, 1, Float32Array);
    this.rot = g1(this.rot, 1, Float32Array);
    this.rotSpeed = g1(this.rotSpeed, 1, Float32Array);
    this.frame = g1(this.frame, 1, Float32Array);
    this.animSpeed = g1(this.animSpeed, 1, Float32Array);
    this.variance = g1(this.variance, 1, Float32Array);
    this.alphaScale = g1(this.alphaScale, 1, Float32Array);
    this.light = g1(this.light, 3, Float32Array);
    this.groundY = g1(this.groundY, 1, Float32Array);
    this.prevPlaneD = g1(this.prevPlaneD, 1, Float32Array);
    this.sizeNow = new Float32Array(cap * 2);
    this.depth = new Float32Array(cap);
    this.order = new Uint32Array(cap);
    const mk = (k: number) => new THREE.InstancedBufferAttribute(new Float32Array(cap * k), k).setUsage(THREE.DynamicDrawUsage);
    this.aPos = mk(3);
    this.aWH = mk(2);
    this.aSC = mk(2);
    this.aCol = mk(4);
    this.aFrame = mk(1);
    this.geo.setAttribute('iPos', this.aPos);
    this.geo.setAttribute('iWH', this.aWH);
    this.geo.setAttribute('iSinCos', this.aSC);
    this.geo.setAttribute('iCol', this.aCol);
    this.geo.setAttribute('iFrame', this.aFrame);
    this.cap = cap;
  }

  add(sys: OrigEffectsSystem, p: THREE.Vector3, v: THREE.Vector3, alphaScale: number, groundY: number): boolean {
    const d = this.def;
    // global cap (0x576020): count ≥ maxParticles × maxParticlesPercentage → dropped (× the quality density)
    if (sys.globalCount >= sys.maxParticles * sys.density * d.maxParticlesPercentage) return false;
    const rng = sys.rng;
    const i = this.count;
    this.grow(i + 1);
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.variance[i] = sampleRD(d.varianceColor, rng);
    const xy = sampleRD(d.XYSizeRatio, rng);
    this.size0[i] = sampleRD(d.size, rng);
    this.rotSpeed[i] = sampleRD(d.rotationSpeed, rng);
    this.frame[i] = sampleRD(d.initAnimationFrame, rng);
    this.animSpeed[i] = sampleRD(d.animationSpeed, rng);
    this.rot[i] = sampleRD(d.initRotation, rng) * DEG;
    this.drag[i] = sampleRD(d.dragInDof, rng);
    this.grav[i] = sampleRD(d.gravityModifier, rng);
    this.xy0[i] = xy;
    this.birth[i] = sys.time;
    this.death[i] = sys.time + Math.max(1e-3, sampleRD(d.timeToLive, rng));
    this.alphaScale[i] = alphaScale;
    this.groundY[i] = groundY;
    this.prevPlaneD[i] = 1e9;
    if (d.useProjectedLightmaps) {
      const l = sys.lightAtThree(p.x, p.z, p.y);
      this.light[i * 3] = l[0]; this.light[i * 3 + 1] = l[1]; this.light[i * 3 + 2] = l[2];
    } else {
      this.light[i * 3] = 1; this.light[i * 3 + 1] = 1; this.light[i * 3 + 2] = 1;
    }
    this.count++;
    sys.globalCount++;
    return true;
  }

  private remove(sys: OrigEffectsSystem, i: number): void {
    const j = --this.count;
    sys.globalCount--;
    if (i === j) return;
    const c3 = (a: Float32Array) => { a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; };
    c3(this.pos); c3(this.vel); c3(this.light);
    for (const a of [this.size0, this.xy0, this.grav, this.drag, this.rot, this.rotSpeed, this.frame, this.animSpeed, this.variance, this.alphaScale, this.groundY, this.prevPlaneD]) a[i] = a[j];
    this.birth[i] = this.birth[j];
    this.death[i] = this.death[j];
  }

  /** §5.2 particle step (0x576dc0) + §5.4 render prep (0x575490). */
  update(sys: OrigEffectsSystem, dt: number, cam: THREE.Camera | null, projScale: number): void {
    const d = this.def, T = this.tables;
    let i = 0;
    while (i < this.count) {
      if (sys.time >= this.death[i]) {
        this.remove(sys, i);
        continue;
      }
      if (dt > 0) {
        const t = (sys.time - this.birth[i]) / (this.death[i] - this.birth[i]);
        const g = evalOT(T.grav, t) * this.grav[i] * GRAVITY;
        const k = this.drag[i] * evalOT(T.drag, t);
        const o = i * 3;
        const vx = this.vel[o], vy = this.vel[o + 1], vz = this.vel[o + 2];
        // a = (0, g, 0) − k·v ; midpoint: p += (v + a·dt/2)·dt ; v += a·dt
        const ax = -k * vx, ay = g - k * vy, az = -k * vz;
        const dx = (vx + ax * dt * 0.5) * dt, dy = (vy + ay * dt * 0.5) * dt, dz = (vz + az * dt * 0.5) * dt;
        this.pos[o] += dx; this.pos[o + 1] += dy; this.pos[o + 2] += dz;
        if (d.scaleWithSpeedFactor > 0) this.size0[i] += (dx * dx + dy * dy + dz * dz) * d.scaleWithSpeedFactor;
        this.vel[o] = vx + ax * dt; this.vel[o + 1] = vy + ay * dt; this.vel[o + 2] = vz + az * dt;
        if (d.hasCollisionPhysics) {
          // ground plane under the emitter (§5.3): penetrating and moving in → reflect with the elastic constant
          const h = this.pos[o + 1] - this.groundY[i];
          if (h < this.prevPlaneD[i] && h < d.collisionOffset && this.vel[o + 1] < 0) {
            this.pos[o + 1] = this.groundY[i] + d.collisionOffset;
            this.vel[o + 1] = -this.vel[o + 1] * d.collisionElasticConstant;
          }
          this.prevPlaneD[i] = h;
        }
        this.rot[i] += this.rotSpeed[i] * evalOT(T.rot, t) * dt * DEG;
        this.frame[i] += (this.animSpeed[i] * evalOT(T.anim, t) * dt) / this.frames;
      }
      i++;
    }
    this.mesh.visible = this.count > 0;
    if (!this.count) return;
    // ---- render prep: view depth, colour, close-distance fade, sort back to front
    const gc = sys.globalColor;
    const e = cam ? cam.matrixWorldInverse.elements : null;
    let n = 0, depthSum = 0;
    for (let p = 0; p < this.count; p++) {
      const o = p * 3;
      const x = this.pos[o], y = this.pos[o + 1], z = this.pos[o + 2];
      const vz = e ? -(e[2] * x + e[6] * y + e[10] * z + e[14]) : 10;
      if (vz <= 0) continue;
      const t = (sys.time - this.birth[p]) / (this.death[p] - this.birth[p]);
      // [0x64] = size·sizeOT, [0x60] = XYSizeRatio·XYOT·[0x64]: X = ratio·Y (the property name; the vertex
      // writer was not located, effects.md §5.5) → half width = ratio·size, half height = size
      const size = evalOT(T.size, t) * this.size0[p];
      const sizeX = evalOT(T.xy, t) * this.xy0[p] * size;
      // close-distance fade (0x575b29): s = [0x64]·[0x60]·projScale/z
      const s = (size * sizeX * projScale) / vz;
      let fade = 1;
      if (s > d.closeDistCullConst) fade = 0;
      else if (s > d.closeDistCullFadeConst) fade = 1 - Math.sqrt((s - d.closeDistCullFadeConst) / (d.closeDistCullConst - d.closeDistCullFadeConst));
      let a = evalOT(T.color, t, 4, 3) * this.alphaScale[p] * fade;
      a = Math.min(255, Math.max(0, a * gc[3]));
      if (a < d.alphaCull) continue;
      this.depth[n] = vz;
      this.order[n] = p;
      this.sizeNow[p * 2] = sizeX;
      this.sizeNow[p * 2 + 1] = size;
      // reuse alphaScale-free scratch: store final alpha in depth-ordered pass below
      this.prevAlpha[p] = a;
      depthSum += vz;
      n++;
    }
    this.meanDepth = n ? depthSum / n : 1e9;
    // back to front: stable sort by depth, descending (DepthSorter)
    depthSorter.sort(this.depth, this.order, n);
    const ord = this.order;
    const P = this.aPos.array as Float32Array, WH = this.aWH.array as Float32Array, SC = this.aSC.array as Float32Array;
    const C = this.aCol.array as Float32Array, F = this.aFrame.array as Float32Array;
    for (let q = 0; q < n; q++) {
      const p = ord[q];
      const o = p * 3;
      const t = (sys.time - this.birth[p]) / (this.death[p] - this.birth[p]);
      P[q * 3] = this.pos[o]; P[q * 3 + 1] = this.pos[o + 1]; P[q * 3 + 2] = this.pos[o + 2];
      WH[q * 2] = this.sizeNow[p * 2]; WH[q * 2 + 1] = this.sizeNow[p * 2 + 1];
      let r = this.rot[p];
      if (d.turnsInMovingDirection && e) {
        // screen-space direction of motion − π/2 (0x575d4d)
        const vx = this.vel[o], vy = this.vel[o + 1], vz = this.vel[o + 2];
        const sx = e[0] * vx + e[4] * vy + e[8] * vz, sy = e[1] * vx + e[5] * vy + e[9] * vz;
        r = Math.atan2(sy, sx) - Math.PI / 2;
      }
      SC[q * 2] = Math.sin(r); SC[q * 2 + 1] = Math.cos(r);
      const v = this.variance[p];
      const cr = Math.min(255, Math.max(0, (evalOT(T.color, t, 4, 0) + v) * gc[0]));
      const cg = Math.min(255, Math.max(0, (evalOT(T.color, t, 4, 1) + v) * gc[1]));
      const cb = Math.min(255, Math.max(0, (evalOT(T.color, t, 4, 2) + v) * gc[2]));
      C[q * 4] = (cr / 255) * this.light[o];
      C[q * 4 + 1] = (cg / 255) * this.light[o + 1];
      C[q * 4 + 2] = (cb / 255) * this.light[o + 2];
      C[q * 4 + 3] = this.prevAlpha[p] / 255;
      F[q] = this.frame[p];
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    for (const [attr, k] of [[this.aPos, 3], [this.aWH, 2], [this.aSC, 2], [this.aCol, 4], [this.aFrame, 1]] as const) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * k);
      attr.needsUpdate = true;
    }
  }

  private prevAlphaBuf = new Float32Array(0);
  private get prevAlpha(): Float32Array {
    if (this.prevAlphaBuf.length < this.cap) this.prevAlphaBuf = new Float32Array(this.cap);
    return this.prevAlphaBuf;
  }

  clear(sys: OrigEffectsSystem): void {
    sys.globalCount -= this.count;
    this.count = 0;
    this.geo.instanceCount = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------------------------------------- emitter instance

/** One live Emitter (effects.md §4; instance fields 0xa8 life, 0xac age, 0xb0 timer, 0xb4 prev pos, 0xc8 fade). */
class EmitterInst {
  readonly def: EmitterDef;
  readonly batch: SpriteBatch | null;
  readonly child: CarFxChild;
  /** Car-frame placement of the CarFx base (sim) and its yaw (deg). */
  readonly basePos: readonly number[];
  readonly baseYaw: number;
  /** Wheel index for the wheel modes, −1 otherwise. */
  readonly wheel: number;
  life = 0;
  age = 0;
  timer = 0;
  running = false;
  fade = 1;
  readonly prev = new THREE.Vector3();
  hasPrev = false;
  private readonly intensityOT: Float32Array;

  constructor(def: EmitterDef, batch: SpriteBatch | null, child: CarFxChild, basePos: readonly number[], baseYaw: number, wheel: number, sys: OrigEffectsSystem) {
    this.def = def;
    this.batch = batch;
    this.child = child;
    this.basePos = basePos;
    this.baseYaw = baseYaw;
    this.wheel = wheel;
    this.intensityOT = overTimeTable(def.intensityOverTime);
    if (def.startAtCreation) this.start(sys);
  }

  /** FUN_00788c00(0): start with probability startProbability. */
  start(sys: OrigEffectsSystem): void {
    if (sys.rng.next() >= this.def.startProbability && this.def.startProbability < 1) return;
    this.life = sampleRD(this.def.timeToLive, sys.rng);
    this.age = 0;
    this.timer = this.interval(sys);
    this.running = true;
  }

  /** FUN_007879a0: 1 / (intensity · intensityOverTime(age/life) · rateScale(=1)); 10000 when 0. */
  private interval(sys: OrigEffectsSystem, t = this.life > this.age ? this.age / this.life : 1): number {
    const r = sampleRD(this.def.intensity, sys.rng) * evalOT(this.intensityOT, t);
    return r === 0 ? 10000 : 1 / r;
  }

  /** The emitter step (0x787f00). `frame` = emitter world frame (three), `carVel` three. */
  update(sys: OrigEffectsSystem, dt: number, frame: Frame, carVel: THREE.Vector3, groundY: number): void {
    if (!this.running || this.fade <= 0 || !this.batch) {
      this.prev.copy(frame.pos);
      this.hasPrev = true;
      return;
    }
    const d = this.def, rng = sys.rng, tmp = sys.tmpV;
    if (this.age < this.life && dt > 0 && sys.spawnAllowed) {
      // v0 once per frame: car velocity × scale + positional speed along the emitter axes
      const v0 = sys.tmpV0.set(0, 0, 0);
      if (d.addEmitterSpeed) v0.copy(carVel).multiplyScalar(d.emitterSpeedScale);
      v0.addScaledVector(frame.dof, sampleRD(d.positionalSpeedIn[0], rng));
      v0.addScaledVector(frame.up, sampleRD(d.positionalSpeedIn[1], rng));
      v0.addScaledVector(frame.right, sampleRD(d.positionalSpeedIn[2], rng));
      if (d.interpolatePosition || !this.hasPrev) this.prev.copy(frame.pos);
      const step = Math.min(dt, this.life - this.age);
      let t = this.timer;
      for (let k = 0; k < MAX_SPAWN_PER_FRAME && t < step; k++) {
        tmp.lerpVectors(this.prev, frame.pos, t / dt);
        tmp.addScaledVector(frame.dof, sampleRD(d.relativePositionIn[0], rng));
        tmp.addScaledVector(frame.up, sampleRD(d.relativePositionIn[1], rng));
        tmp.addScaledVector(frame.right, sampleRD(d.relativePositionIn[2], rng));
        this.batch.add(sys, tmp, v0, this.fade, groundY);
        t += this.interval(sys, (t + this.age) / this.life);
      }
      this.timer = Math.max(0, t - step);
    }
    this.age += dt;
    this.prev.copy(frame.pos);
    this.hasPrev = true;
    if (this.age >= this.life) {
      if (d.looping) {
        this.life = sampleRD(d.timeToLive, rng);
        this.age = 0;
        this.timer = this.interval(sys);
      } else this.running = false;
    }
  }
}

// ------------------------------------------------------------------------------------------- skid marks

const SKID_VERT = /* glsl */ `
attribute vec4 color;
varying vec4 vCol;
varying vec2 vUv;
varying float vOrigFog;
${ORIG_FOG_PARS}
void main() {
  vCol = color;
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vOrigFog = origFogFactor(-mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const SKID_FRAG = /* glsl */ `
uniform sampler2D uTex;
varying vec4 vCol;
varying vec2 vUv;
varying float vOrigFog;
${ORIG_FOG_PARS}
void main() {
  vec4 t = texture2D(uTex, vUv);
  // skidMarkNoBump.ps: rgb = v0 + t0, a = v0.a · t0.a
  vec3 c = min(vCol.rgb + t.rgb, vec3(1.0));
  float a = vCol.a * t.a;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(mix(uFogColor, c, vOrigFog), a);
}`;

interface SkidStrip {
  active: boolean;
  mat: number;
  segs: number;
  v: number;
  /** Last committed centre + edges (three). */
  lc: THREE.Vector3;
  la: THREE.Vector3;
  lb: THREE.Vector3;
  la0: number;
}

/** Ring of skid quads (effects.md §7): (activeStrips + finishedStrips) × maxSegments quads. */
class OrigSkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly cap: number;
  private readonly pos: Float32Array;
  private readonly uv: Float32Array;
  private readonly col: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private head = 0;
  private filled = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -1;

  constructor(capacity: number, tex: THREE.Texture | null) {
    this.cap = capacity;
    this.pos = new Float32Array(capacity * 12);
    this.uv = new Float32Array(capacity * 8);
    this.col = new Float32Array(capacity * 16);
    const idx = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex }, ...fogUniformMap(origUniforms.trackFog) },
      vertexShader: SKID_VERT,
      fragmentShader: SKID_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'origfx:skidmarks';
  }

  quad(a0: THREE.Vector3, b0: THREE.Vector3, a1: THREE.Vector3, b1: THREE.Vector3, u0: number, u1: number, v0: number, v1: number, rgb: readonly number[], al0: number, al1: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.filled = Math.min(this.cap, this.filled + 1);
    const p = this.pos, o = i * 12;
    p[o] = a0.x; p[o + 1] = a0.y; p[o + 2] = a0.z;
    p[o + 3] = b0.x; p[o + 4] = b0.y; p[o + 5] = b0.z;
    p[o + 6] = a1.x; p[o + 7] = a1.y; p[o + 8] = a1.z;
    p[o + 9] = b1.x; p[o + 10] = b1.y; p[o + 11] = b1.z;
    const uv = this.uv, t = i * 8;
    uv[t] = u0; uv[t + 1] = v0; uv[t + 2] = u1; uv[t + 3] = v0; uv[t + 4] = u0; uv[t + 5] = v1; uv[t + 6] = u1; uv[t + 7] = v1;
    const c = this.col, q = i * 16;
    for (let k = 0; k < 4; k++) {
      c[q + k * 4] = rgb[0]; c[q + k * 4 + 1] = rgb[1]; c[q + k * 4 + 2] = rgb[2];
      c[q + k * 4 + 3] = k < 2 ? al0 : al1;
    }
    this.dirtyLo = Math.min(this.dirtyLo, i);
    this.dirtyHi = Math.max(this.dirtyHi, i);
  }

  flush(): void {
    if (this.dirtyHi < 0) return;
    const lo = this.dirtyLo, hi = this.dirtyHi;
    for (const [name, k] of [['position', 12], ['uv', 8], ['color', 16]] as const) {
      const a = this.geo.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(lo * k, (hi - lo + 1) * k);
      a.needsUpdate = true;
    }
    this.geo.setDrawRange(0, this.filled * 6);
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
  }

  get segments(): number {
    return this.filled;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
    this.geo.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ------------------------------------------------------------------------------------------- drop shadow

const SHADOW_VERT = /* glsl */ `
varying vec2 vUv;
varying float vOrigFog;
${ORIG_FOG_PARS}
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vOrigFog = origFogFactor(-mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const SHADOW_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec3 uShadowColor;
uniform float uFade;
varying vec2 vUv;
varying float vOrigFog;
${ORIG_FOG_PARS}
void main() {
  // the grey drop-shadow texture (white = no shadow) plus car.dropShadowColor as the floor, multiplied onto the
  // frame; fades to white with the height fade and in the fog
  vec3 s = min(texture2D(uTex, vUv).rgb + uShadowColor, vec3(1.0));
  s = mix(vec3(1.0), s, uFade * vOrigFog);
  gl_FragColor = vec4(s, 1.0);
}`;

// ------------------------------------------------------------------------------------------- the system

export class OrigEffectsSystem {
  /** Added to the scene (as a child of the procedural particle mesh). */
  readonly root = new THREE.Group();
  stage: StageEffects | null = null;
  readonly rng = new FxRng();
  time = 0;
  globalCount = 0;
  maxParticles = 3000;
  globalColor: number[] = [1, 1, 1, 1];
  /** Quality scaling of the particle cap (renderer quality presets: 1 on 'high' = the original's cap; the original
   *  has no such setting, lower presets thin the effects for slow GPUs). */
  density = 1;
  spawnAllowed = true;
  readonly tmpV = new THREE.Vector3();
  readonly tmpV0 = new THREE.Vector3();
  private scope: TextureScope | null = null;
  private readonly batches = new Map<string, SpriteBatch>();
  skids: OrigSkidMarks | null = null;
  private readonly cars = new Set<OrigCarFx>();
  private seq = 0;
  private readonly lightOut = [1, 1, 1];
  shadowTex: THREE.Texture | null = null;
  private store: TextureStore | null = null;
  camera: THREE.Camera | null = null;
  private projScale = 1;

  constructor() {
    this.root.name = 'origfx';
  }

  get active(): boolean {
    return this.stage !== null;
  }

  /** The latest setStage (the effects of the stage settle with it); `settled()` waits for it. */
  private loading: Promise<void> = Promise.resolve();

  /** Load the stage's original effects (null / failure → procedural effects, one warning). The promise settles once the
   *  effects data, its textures, the batches and every car's emitters / drop shadow (and their textures) are in place. */
  setStage(stageId: string | null, original: boolean, store: TextureStore | null): Promise<void> {
    return (this.loading = this.loadStage(stageId, original, store));
  }

  /** Everything that was requested so far has landed: the stage effects and the cars' own effects data + drop shadows.
   *  Never rejects. */
  async settled(): Promise<void> {
    await this.loading.catch(() => undefined);
    await Promise.all([...this.cars].map((c) => c.whenReady()));
  }

  private async loadStage(stageId: string | null, original: boolean, store: TextureStore | null): Promise<void> {
    const seq = ++this.seq;
    this.unload();
    if (!stageId || !original || !store) return;
    let st: StageEffects | null = null;
    try {
      st = await loadStageEffects(stageId);
    } catch (e) {
      if (seq === this.seq) warnOnce(`fx:${stageId}`, `[render] original effects of ${stageId} failed: ${(e as Error)?.message ?? e}`);
      return;
    }
    if (!st || seq !== this.seq) return;
    const scope = store.scope();
    try {
      const textures = new Map<string, THREE.Texture | null>();
      const info = st.json.textures;
      await Promise.all(
        Object.entries(info).map(async ([name, t]) => {
          const tex = t.volume
            ? await scope.getVolume(t.id, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, wrapR: THREE.RepeatWrapping })
            : await scope.get(t.id, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
          textures.set(name.toLowerCase(), tex);
        }),
      );
      const skidTex = st.json.skid.texture ? await scope.get(st.json.skid.texture) : null;
      if (seq !== this.seq) {
        scope.dispose();
        return;
      }
      this.scope = scope;
      this.store = store;
      this.stage = st;
      const s = st.json.settings;
      this.maxParticles = s.maxParticles;
      this.globalColor = [...s.globalParticleColor];
      for (const [name, t] of Object.entries(st.json.templates)) {
        if (t.type !== 'SpriteParticle') continue;
        const ti = info[t.texture.toLowerCase()];
        // preallocated to the most this template can ever hold (global cap x its percentage at density 1): no growth mid-race
        const b = new SpriteBatch(t, textures.get(t.texture.toLowerCase()) ?? null, ti?.volume ? ti.depth ?? 1 : 1, Math.ceil(s.maxParticles * t.maxParticlesPercentage));
        this.batches.set(name.toLowerCase(), b);
        this.root.add(b.mesh);
      }
      const sk = st.json.skid;
      this.skids = new OrigSkidMarks((sk.activeStrips + sk.finishedStrips) * sk.maxSegments, skidTex);
      this.skids.mesh.visible = s.drawSkidMarks;
      this.root.add(this.skids.mesh);
      for (const c of this.cars) c.rebuild();
      await Promise.all([...this.cars].map((c) => c.whenReady())); // their drop-shadow textures
    } catch (e) {
      if (this.scope === scope) this.scope = null;
      scope.dispose();
      // a superseded load that fails must not tear down the newer stage's effects
      if (seq !== this.seq) return;
      this.unload();
      warnOnce(`fx:${stageId}`, `[render] original effects of ${stageId} failed: ${(e as Error)?.message ?? e}`);
    }
  }

  private unload(): void {
    for (const c of this.cars) c.teardown();
    for (const b of this.batches.values()) {
      this.root.remove(b.mesh);
      b.dispose();
    }
    this.batches.clear();
    if (this.skids) {
      this.root.remove(this.skids.mesh);
      this.skids.dispose();
      this.skids = null;
    }
    this.scope?.dispose();
    this.scope = null;
    this.stage = null;
    this.globalCount = 0;
  }

  batch(name: string): SpriteBatch | null {
    return this.batches.get(name.toLowerCase()) ?? null;
  }

  textureScope(): TextureScope | null {
    return this.store ? this.store.scope() : null;
  }

  /** The stage view's projected-lightmap sampler (OriginalStageView.particleLightAt: the exact lightmap texel under
   *  the spawn point through the particle palette); null → the 4 m light grid of effects.bin. */
  lightSource: ((x: number, y: number, z: number, out: number[], hint?: number) => number) | null = null;
  private lightHint = -1;

  /** Particle light (RGB 0..1) at a three-space spawn point: the lightmap texel (lightSource), else the light grid. */
  lightAtThree(x: number, zThree: number, y = 0): number[] {
    const st = this.stage;
    if (!st) return [1, 1, 1];
    if (this.lightSource) {
      const h = this.lightSource(x, y, zThree, this.lightOut, this.lightHint);
      if (h >= 0) {
        this.lightHint = h;
        return this.lightOut;
      }
    }
    return lightAt(st.light, x, -zThree, st.lightMax, this.lightOut);
  }

  register(c: OrigCarFx): void {
    this.cars.add(c);
  }

  unregister(c: OrigCarFx): void {
    this.cars.delete(c);
  }

  clear(): void {
    for (const b of this.batches.values()) b.clear(this);
    this.globalCount = 0;
    this.skids?.clear();
  }

  get alive(): number {
    return this.globalCount;
  }

  /** Tools / tests: live particles per template, skid quads, emitters per car. */
  debugStats(): { stage: string | null; alive: number; batches: Record<string, number>; skidQuads: number; cars: number[] } {
    const batches: Record<string, number> = {};
    for (const [k, b] of this.batches) if (b.count) batches[k] = b.count;
    return {
      stage: this.stage?.json.stageId ?? null,
      alive: this.globalCount,
      batches,
      skidQuads: this.skids?.segments ?? 0,
      cars: [...this.cars].map((c) => c.emitterCount),
    };
  }

  /** Once per rendered frame after the cars: advances the particles by the sim dt and uploads. */
  update(dt: number, camera: THREE.Camera | null): void {
    if (!this.stage) return;
    this.time += dt;
    this.camera = camera;
    const pc = camera as THREE.PerspectiveCamera | null;
    if (pc?.isPerspectiveCamera) {
      // c8 = cot(fov/2)·π·0.3 (0x57594c: sqrt(cot²), × 0x810100 × 0x8066f8)
      const h = (pc.fov * DEG) / 2;
      this.projScale = (1 / Math.tan(h)) * Math.PI * 0.3;
    }
    for (const b of this.batches.values()) b.update(this, dt, camera, this.projScale);
    // batches are not sorted against each other by WebGL: draw the far ones first
    const list = [...this.batches.values()].filter((b) => b.mesh.visible).sort((a, b) => b.meanDepth - a.meanDepth);
    list.forEach((b, i) => (b.mesh.renderOrder = 20 + i));
    this.skids?.flush();
  }

  dispose(): void {
    this.seq++;
    this.unload();
  }
}

// ------------------------------------------------------------------------------------------- per car

interface SkidWheel {
  strip: SkidStrip | null;
  state: number;
  prevMat: number;
}

/**
 * The original effects of one car. `update(tel, pose)` after the car's render pose is known. Keeps working
 * across stage loads (rebuild() re-creates the emitters for the new stage's templates).
 */
export class OrigCarFx {
  private readonly sys: OrigEffectsSystem;
  private readonly origCar: string | null;
  private emitters: EmitterInst[] = [];
  private carDef: CarEffectsDef | null = null;
  private readonly frame = newFrame();
  private readonly carPos = new THREE.Vector3();
  private readonly carQuat = new THREE.Quaternion();
  private readonly carVel = new THREE.Vector3();
  private readonly tv = new THREE.Vector3();
  private readonly tv2 = new THREE.Vector3();
  private readonly skid: SkidWheel[] = [0, 1, 2, 3].map(() => ({ strip: null, state: 0, prevMat: -1 }));
  private shadow: THREE.Mesh | null = null;
  private shadowScope: TextureScope | null = null;
  private lastStep = -1;
  private lastReset = -1;
  // backfire / blow-out flags (sound.md §4.3; 0x753410 / 0x753550)
  private backfireTimer = 0;
  private blowTimer = 0;
  private lastGear = 0;
  private disposed = false;
  /** Loads in flight (the car's effects.json, the drop-shadow texture): whenReady() waits for them. */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(sys: OrigEffectsSystem, origCar?: string | null) {
    this.sys = sys;
    this.origCar = origCar ?? null;
    sys.register(this);
    if (this.origCar) {
      this.track(
        loadCarEffects(this.origCar)
          .then((d) => {
            if (this.disposed) return;
            this.carDef = d;
            this.rebuild();
          })
          .catch((e) => warnOnce(`fx-car:${this.origCar}`, `[render] original car effects of ${this.origCar} failed: ${(e as Error)?.message ?? e}`)),
      );
    }
    this.rebuild();
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    const done = () => void this.inflight.delete(p);
    p.then(done, done);
  }

  /** The car's effects data and drop shadow (with its texture) have loaded, or failed (the fallback stays). Never rejects. */
  async whenReady(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]); // a settled load may start the next (rebuild)
  }

  /** (Re)create the emitters for the current stage. */
  rebuild(): void {
    this.teardown();
    const st = this.sys.stage;
    if (!st || this.disposed) return;
    const T = st.json.templates;
    const mk = (base: string, bpos: readonly number[], byaw: number) => {
      const b = T[base];
      if (!b || b.type !== 'CarFx') return;
      for (const ch of (b as CarFxDef).children) {
        const em = T[ch.template];
        if (!em || em.type !== 'Emitter') continue;
        const batch = this.sys.batch((em as EmitterDef).template);
        const wheels = wheelsOfMode(ch.attachedMode);
        if (wheels) for (const w of wheels) this.emitters.push(new EmitterInst(em as EmitterDef, batch, ch, bpos, byaw, w, this.sys));
        else this.emitters.push(new EmitterInst(em as EmitterDef, batch, ch, bpos, byaw, -1, this.sys));
      }
    };
    for (const e of st.json.carFx) mk(e.name, e.pos, e.rot[0]);
    if (this.carDef) for (const x of this.carDef.exhaust) if (st.json.pipeFx.includes(x.template)) mk(x.template, x.pos, x.rot[0]);
    this.buildShadow();
  }

  private buildShadow(): void {
    const st = this.sys.stage, ds = this.carDef?.dropShadow;
    if (!st || !ds?.tex || !ds.bbox) return;
    const scope = this.sys.textureScope();
    if (!scope) return;
    this.shadowScope = scope;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    const s = st.json.settings;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uShadowColor: { value: new THREE.Vector3(...(s.dropShadowColor as [number, number, number])) },
        uFade: { value: 1 },
        ...fogUniformMap(origUniforms.trackFog),
      },
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.visible = false;
    mesh.name = 'origfx:dropshadow';
    this.shadow = mesh;
    this.sys.root.add(mesh);
    this.track(
      scope
        .get(ds.tex, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping })
        .then((t) => {
          if (this.shadow === mesh) mat.uniforms.uTex.value = t;
        })
        .catch(() => undefined),
    );
  }

  /** Drop the emitters / shadow of the previous stage (particles already spawned stay with the batches). */
  teardown(): void {
    this.emitters = [];
    for (const s of this.skid) {
      s.strip = null;
      s.state = 0;
    }
    if (this.shadow) {
      this.sys.root.remove(this.shadow);
      this.shadow.geometry.dispose();
      (this.shadow.material as THREE.Material).dispose();
      this.shadow = null;
    }
    this.shadowScope?.dispose();
    this.shadowScope = null;
  }

  reset(): void {
    for (const s of this.skid) {
      s.strip = null;
      s.state = 0;
    }
    for (const e of this.emitters) e.hasPrev = false;
    this.lastStep = -1;
  }

  get ready(): boolean {
    return this.sys.active;
  }

  get emitterCount(): number {
    return this.emitters.length;
  }

  update(tel: Readonly<CarTelemetry>, pose?: Readonly<CarRenderState>): void {
    const st = this.sys.stage;
    if (!st) return;
    if (tel.resetCount !== this.lastReset) {
      this.lastReset = tel.resetCount;
      this.lastStep = tel.stepCount;
      this.reset();
      this.lastStep = tel.stepCount;
      return;
    }
    const steps = this.lastStep < 0 ? 0 : tel.stepCount - this.lastStep;
    this.lastStep = tel.stepCount;
    const dt = Math.min(0.25, Math.max(0, steps) * DT);
    const p = pose?.pos ?? tel.pos, q = pose?.quat ?? tel.quat;
    this.carPos.set(p.x, p.y, p.z);
    this.carQuat.set(q.x, q.y, q.z, q.w);
    this.carVel.set(tel.vel.x, tel.vel.y, tel.vel.z);
    const speed = Math.abs(tel.speedKmh / 3.6);
    // car FX only within cullDistCars of the camera (0x78802f)
    const cam = this.sys.camera;
    const cull = st.json.settings.cullDistCars;
    this.sys.spawnAllowed = !cam || cam.position.distanceToSquared(this.carPos) <= cull * cull;
    // the shared backfire / blow-out source (CarRenderState.carFlags, src/game/carFlags.ts: the same flags as the
    // pipe sounds); the ghost (no flags) derives its own
    const flags = pose?.carFlags ?? this.pipeFlags(tel, dt);
    const base: PhyVarInput = {
      throttle: tel.throttle, brake: tel.brake, gear: tel.gear, rpm: tel.rpm, speed, vel: Math.hypot(tel.vel.x, tel.vel.y, tel.vel.z),
      slipAngle: tel.beta, wheelVel: 0, wheelVelX: 0, wheelRotVel: 0, xSlip: 0, zSlip: 0, wheelWorldVel: 0,
    };
    const wheelIn: PhyVarInput[] = tel.wheels.map((w, i) => {
      const ws = wheelVelocities(tel, i);
      return {
        ...base,
        wheelVel: ws.vLong, wheelVelX: ws.vLat, wheelRotVel: w.omega,
        xSlip: Math.abs(Math.tan(w.slipAngle)), zSlip: w.kappa, wheelWorldVel: Math.hypot(ws.vLong, ws.vLat),
      };
    });
    for (const em of this.emitters) {
      const ch = em.child;
      const mode = ch.attachedMode;
      let groundY = this.carPos.y - 0.42;
      if (em.wheel >= 0) {
        const w = tel.wheels[em.wheel];
        const mat = w.contact ? origFromMaterial(w.material) : -1;
        if (mat < 0 || mat === 255 || (ch.trigOnMaterial >= 0 && ch.trigOnMaterial !== mat)) {
          this.setFade(em, 0);
          continue;
        }
        this.wheelFrame(tel, em.wheel);
        groundY = w.contactPointThree.y;
        this.setFade(em, carFxFade(ch, phyVar(ch.trigOnPhyVar, wheelIn[em.wheel]), speed));
      } else if (mode <= 3) {
        // body modes: every wheel of the set must touch, the trigger material is the last wheel's
        const set = mode === 2 ? [0, 1] : mode === 3 ? [2, 3] : [0, 1, 2, 3];
        let mat = -1, ok = true;
        for (const wi of set) {
          const w = tel.wheels[wi];
          const m = w.contact ? origFromMaterial(w.material) : -1;
          if (m < 0 || m === 255) ok = false;
          mat = m;
        }
        if (mode > 0 && (!ok || (ch.trigOnMaterial >= 0 && ch.trigOnMaterial !== mat))) {
          this.setFade(em, 0);
          continue;
        }
        this.bodyFrame(em, true);
        this.setFade(em, carFxFade(ch, phyVar(ch.trigOnPhyVar, base), speed));
      } else {
        this.bodyFrame(em, false);
        if (mode === 12 || mode === 13) {
          if ((mode === 12 && flags.backfire) || (mode === 13 && flags.blowOut)) {
            em.fade = 1;
            em.start(this.sys);
          }
        } else if (mode === 14) {
          const f = Math.min(1, Math.max(0, (speed - PIPE_FUME_SPEED) * PIPE_FUME_SLOPE));
          this.setFade(em, carFxFade(ch, f, speed));
        }
      }
      em.update(this.sys, dt, this.frame, this.carVel, groundY);
    }
    this.updateSkids(tel, speed, wheelIn);
    this.updateShadow(tel);
  }

  private setFade(em: EmitterInst, f: number): void {
    em.fade = f;
  }

  /** Emitter frame for the body / pipe modes: child (+2 m z in the body modes) × CarFx base × car (sim → three). */
  private bodyFrame(em: EmitterInst, bodyMode: boolean): void {
    const ch = em.child, F = this.frame;
    const yaw = em.baseYaw * DEG;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // child position in the base frame, then the base yaw (sim: x' = x·cos + z·sin, z' = −x·sin + z·cos)
    const lx = ch.pos[0], ly = ch.pos[1], lz = ch.pos[2] + (bodyMode ? BODY_Z_OFFSET : 0);
    const bx = lx * cy + lz * sy + em.basePos[0];
    const by = ly + em.basePos[1];
    const bz = -lx * sy + lz * cy + em.basePos[2];
    toThree(F.pos, bx, by, bz).applyQuaternion(this.carQuat).add(this.carPos);
    toThree(F.dof, sy, 0, cy).applyQuaternion(this.carQuat);
    toThree(F.right, cy, 0, -sy).applyQuaternion(this.carQuat);
    F.up.set(0, 1, 0).applyQuaternion(this.carQuat);
  }

  /** Wheel modes (0x757a3f): origin = contact point, Dof = horizontal wheel heading, Right = axle toward the car
   *  centre (left wheels' +x, right wheels' mirrored −x), Up ⟂ both. */
  private wheelFrame(tel: Readonly<CarTelemetry>, w: number): void {
    const F = this.frame, wt = tel.wheels[w];
    const c = wt.contactPointThree;
    F.pos.set(c.x, c.y, c.z);
    const steer = Number.isFinite(wt.visual.steerAngle) ? wt.visual.steerAngle : 0;
    // wheel right axis (three, car-local: +x right; the steer turns it about the car up, + = right)
    const r = this.tv.set(Math.cos(steer), 0, Math.sin(steer)).applyQuaternion(this.carQuat);
    const inward = w === 0 || w === 3 ? 1 : -1;
    F.right.copy(r).multiplyScalar(inward);
    // Dof = horizontal ⟂ of the wheel axis (sim (−r.z, 0, r.x)) → three (r.zThree… ) computed in three directly
    F.dof.set(r.z, 0, -r.x);
    if (F.dof.lengthSq() < 1e-8) F.dof.set(0, 0, -1).applyQuaternion(this.carQuat);
    F.dof.normalize();
    F.up.crossVectors(F.right, F.dof);
    if (F.up.y < 0) F.up.negate();
    F.up.normalize();
  }

  /** Backfire (0x753410) and blow-out (0x753550) flags, rebuilt from telemetry (sound.md §4.3). */
  private pipeFlags(tel: Readonly<CarTelemetry>, dt: number): { backfire: boolean; blowOut: boolean } {
    let backfire = false, blowOut = false;
    if (dt <= 0) return { backfire, blowOut };
    const rng = this.sys.rng;
    this.backfireTimer -= dt;
    if (this.backfireTimer <= 0 && tel.throttle <= 0 && tel.rpm > 1100) {
      const n = Math.trunc(tel.rpm / 1000 + 1.5);
      const r = Math.floor(rng.next() * 32768);
      if (r % n !== 0) {
        backfire = true;
        this.backfireTimer = ((Math.floor(rng.next() * 32768) % 100) - 50) / (0.04 * tel.rpm) + 0.15;
      }
    }
    this.blowTimer += dt;
    if (this.blowTimer >= 0.2) {
      this.blowTimer = 0;
      if (Math.abs(tel.speedKmh / 3.6) > 1.3889 && tel.gear !== this.lastGear) blowOut = (Math.floor(rng.next() * 32768) % 6) + 1 <= 3;
      this.lastGear = tel.gear;
    }
    return { backfire, blowOut };
  }

  // ---- skid marks (CarWheel 0x75bfa0, strip add 0x7e8180)
  private updateSkids(tel: Readonly<CarTelemetry>, speed: number, wheelIn: PhyVarInput[]): void {
    const sk = this.sys.skids, st = this.sys.stage;
    if (!sk || !st || !st.json.settings.drawSkidMarks) return;
    const S = st.json.skid;
    for (let i = 0; i < 4; i++) {
      const w = tel.wheels[i], sw = this.skid[i];
      const mat = w.contact ? origFromMaterial(w.material) : -1;
      const valid = mat >= 0 && mat < 32;
      const wi = wheelIn[i];
      const xs = Math.abs(wi.xSlip), zs = Math.abs(wi.zSlip);
      let lat = false, lon = false;
      let intensity = Math.min(1, (xs + zs) * SKID_SLIP_SCALE);
      if (valid && speed > SKID_SPEED_MIN) {
        const tr = S.trig[mat];
        lat = xs >= tr[0] && Math.abs(wi.wheelVelX) >= tr[2];
        lon = zs >= tr[1] && Math.abs(wi.wheelVel) >= tr[3];
        if (tr[0] === 0 && tr[2] === 0) {
          lat = true;
          intensity = 0.5;
        }
      }
      if (!valid || !(lat || lon) || mat !== sw.prevMat) {
        sw.strip = null;
      }
      sw.prevMat = mat;
      if (!valid || !(lat || lon)) continue;
      // edge points: contact ∓ axle·0.1, widened by the material's extra width
      const c = w.contactPointThree;
      const steer = Number.isFinite(w.visual.steerAngle) ? w.visual.steerAngle : 0;
      const ax = this.tv2.set(Math.cos(steer), 0, Math.sin(steer)).applyQuaternion(this.carQuat);
      const hw = S.halfWidth + S.extraWidth[mat];
      const cx = c.x, cy = c.y + S.lift, cz = c.z;
      const al = Math.min(intensity, S.intensityClamp[mat]);
      const u0 = mat / S.atlasColumns, u1 = (mat + 1) / S.atlasColumns;
      const col = S.color[mat];
      if (!sw.strip) {
        sw.strip = {
          active: true, mat, segs: 0, v: 0,
          lc: new THREE.Vector3(cx, cy, cz),
          la: new THREE.Vector3(cx - ax.x * hw, cy - ax.y * hw, cz - ax.z * hw),
          lb: new THREE.Vector3(cx + ax.x * hw, cy + ax.y * hw, cz + ax.z * hw),
          la0: al,
        };
        continue;
      }
      const s = sw.strip;
      const dx = cx - s.lc.x, dy = cy - s.lc.y, dz = cz - s.lc.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < S.minSegment * S.minSegment) continue;
      if (d2 > 25) {
        sw.strip = null; // a reset / teleport: start a new strip
        continue;
      }
      const a1 = new THREE.Vector3(cx - ax.x * hw, cy - ax.y * hw, cz - ax.z * hw);
      const b1 = new THREE.Vector3(cx + ax.x * hw, cy + ax.y * hw, cz + ax.z * hw);
      const v1 = s.v + (0.5 * Math.sqrt(d2)) / (2 * hw);
      sk.quad(s.la, s.lb, a1, b1, u0, u1, s.v, v1, col, s.la0, al);
      s.lc.set(cx, cy, cz);
      s.la.copy(a1);
      s.lb.copy(b1);
      s.la0 = al;
      s.v = v1;
      if (++s.segs >= S.maxSegments) sw.strip = { ...s, segs: 0, lc: s.lc.clone(), la: s.la.clone(), lb: s.lb.clone() };
    }
  }

  // ---- drop shadow (§8)
  private updateShadow(tel: Readonly<CarTelemetry>): void {
    const m = this.shadow, ds = this.carDef?.dropShadow, st = this.sys.stage;
    if (!m || !ds?.bbox || !st) return;
    const contacts = tel.wheels.filter((w) => w.contact);
    if (!contacts.length) {
      m.visible = false;
      return;
    }
    // ground plane under the car from the wheel contact points (three space)
    let gy = 0;
    for (const w of contacts) gy += w.contactPointThree.y;
    gy /= contacts.length;
    const sc = ds.scale ?? [1, 1, 0];
    const [mn, mx] = ds.bbox;
    const x0 = mn[0] * sc[0], x1 = mx[0] * sc[0], z0 = mn[2] * sc[1], z1 = mx[2] * sc[1];
    const pos = (m.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const corners = [
      [x0, z1],
      [x1, z1],
      [x0, z0],
      [x1, z0],
    ];
    const fl = tel.wheels[0].contactPointThree, fr = tel.wheels[1].contactPointThree, rr = tel.wheels[2].contactPointThree, rl = tel.wheels[3].contactPointThree;
    corners.forEach(([x, z], k) => {
      // sim car-local (x, 0, z) → three world, then onto the plane through the contact points (bilinear)
      const v = toThree(this.tv, x, 0, z).applyQuaternion(this.carQuat).add(this.carPos);
      const front = z > 0;
      const left = x < 0;
      const y = contacts.length === 4 ? (front ? (left ? fl.y : fr.y) : left ? rl.y : rr.y) : gy;
      pos[k * 3] = v.x; pos[k * 3 + 1] = y + 0.02; pos[k * 3 + 2] = v.z;
    });
    const attr = m.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    // height fade (dropShadowFadeOffset / FadeScale): body height above the ground beyond the offset
    const h = Math.max(0, this.carPos.y - gy - 0.42);
    const s = st.json.settings;
    (m.material as THREE.ShaderMaterial).uniforms.uFade.value = Math.min(1, Math.max(0, 1 - (h - s.dropShadowFadeOffset) * s.dropShadowFadeScale));
    m.visible = true;
  }

  dispose(): void {
    this.disposed = true;
    this.teardown();
    this.sys.unregister(this);
  }
}

/** Wheel sets of the wheel attach modes (c_AllWheels 4 … c_RearLeftWheel 10); null for body / pipe modes. */
export function wheelsOfMode(mode: number): number[] | null {
  switch (mode) {
    case 4: return [0, 1, 2, 3];
    case 5: return [0, 1];
    case 6: return [2, 3];
    case 7: return [0];
    case 8: return [1];
    case 9: return [2];
    case 10: return [3];
    default: return null;
  }
}

/** Longitudinal / lateral contact-patch speeds of wheel i (m/s; the wheel getters vt+0xd4 / +0xd8). */
export function wheelVelocities(tel: Readonly<CarTelemetry>, i: number): { vLong: number; vLat: number } {
  const w = tel.wheels[i];
  const v = tel.velLocal, av = tel.angVelLocal;
  const c = w.visual.centreLocal;
  const rz = -(c?.z ?? 0), rx = c?.x ?? 0, ry = c?.y ?? 0;
  const vx = v.x + (av.y * rz - av.z * ry);
  const vz = v.z + (av.x * ry - av.y * rx);
  const d = Number.isFinite(w.visual.steerAngle) ? w.visual.steerAngle : 0;
  const cs = Math.cos(d), sn = Math.sin(d);
  return { vLong: vx * sn + vz * cs, vLat: vx * cs - vz * sn };
}
