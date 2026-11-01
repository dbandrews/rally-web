/**
 * src/render/effects.ts — wheel effects (render builder).
 *
 *  ParticleSystem  pooled camera-facing quads in ONE instanced draw call (dust clouds, gravel roost,
 *                  snow spray, water splash, tyre smoke, mud chunks). CPU-simulated, swap-remove pool.
 *  SkidMarks       one ring buffer of quads shared by all wheels; continuous ribbons per wheel,
 *                  surface-dependent colour / alpha; oldest marks are overwritten.
 *  CarEffects      per car: reads telemetry each frame, derives the wheel ground slip speed from
 *                  ω·R vs. the contact-patch velocity (kinematic, robust to the tyre model) and emits
 *                  both, scaled by slip, speed and surface (SURFACE_INFO dust flags / colours).
 *
 * Effects advance with SIM time (telemetry.stepCount delta), so they freeze while the game is paused.
 *
 * ORIGINAL effects (effects builder, research/formats/effects.md): under an original stage view with the
 * `effects` part built, ParticleSystem.setStage() loads the stage's original definitions into its
 * OrigEffectsSystem (orig/effects.ts: the per-material CarFx emitters, exhaust bursts, the original skid marks
 * and the drop shadow, drawn as children of this particle mesh) and every CarEffects delegates to its OrigCarFx.
 * Procedural stages, `?orig=0`, a missing part or a failed load keep the procedural effects below. When those
 * procedural particles are drawn INSIDE an original view (part missing / failed / still loading) they take the
 * original look instead of the procedural preset (ParticleSystem.setOriginal): the original track fog
 * (fogUniformMap(origUniforms.trackFog) + ORIG_FOG_PARS, per vertex) and, per particle at spawn, the projected
 * track lightmap through the particle palette (game.particleLightmapMin = the lighting floor; OriginalStageView
 * particleLightAt), like the original's useProjectedLightmaps sprites.
 */
import * as THREE from 'three';
import { DT, SURFACE_INFO } from '../core/constants';
import type { CarRenderState, CarTelemetry, EnvironmentPreset, SurfaceId } from '../core/types';
import { ORIG_FOG_PARS, PARTICLE_LIGHTMAP_MAX, fogUniformMap, origUniforms } from './orig/common';
import { OrigCarFx, OrigEffectsSystem } from './orig/effects';
import type { TextureStore } from './orig/textures';
import { ROAD_LIFT } from './terrain';

// ------------------------------------------------------------------------------------------- particles

const P_VERT = /* glsl */ `
${ORIG_FOG_PARS}
attribute vec3 iPos;
attribute vec4 iCol;
attribute vec2 iSizeRot;
varying vec4 vCol;
varying vec2 vUv;
varying float vFog;
varying float vOrigFog;
void main() {
  vCol = iCol;
  vUv = position.xy;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iSizeRot.y), s = sin(iSizeRot.y);
  vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * iSizeRot.x;
  mv.xy += q;
  vFog = -mv.z;
  vOrigFog = origFogFactor(-mv.z);
  // fade particles that pass right in front of the lens (a chip 20 cm away would fill the screen)
  // (soft dust only fades when the camera is practically inside the puff)
  vCol.a *= iCol.a < 0.0 ? smoothstep(0.3, 1.5, -mv.z) : smoothstep(0.05, 0.5 + 0.2 * iSizeRot.x, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const P_FRAG = /* glsl */ `
${ORIG_FOG_PARS}
uniform vec3 uPFogColor;
uniform float uPFogNear;
uniform float uPFogFar;
uniform vec3 uLight;
uniform float uOrig;
varying vec4 vCol;
varying vec2 vUv;
varying float vFog;
varying float vOrigFog;
void main() {
  float r = length(vUv) * 2.0;
  if (r > 1.0) discard;
  float soft = vCol.a < 0.0 ? 1.0 - smoothstep(0.8, 1.0, r) : (1.0 - smoothstep(0.0, 1.0, r));
  float a = abs(vCol.a) * soft;
  vec3 col = vCol.rgb * uLight;
  if (uOrig > 0.5) col = mix(uFogColor, col, vOrigFog);          // the original track fog (linear + clamp)
  else col = mix(col, uPFogColor, smoothstep(uPFogNear, uPFogFar, vFog));
  gl_FragColor = vec4(col, a);
}`;

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  s0: number; s1: number;
  r: number; g: number; b: number; a: number;
  rot: number; spin: number;
  grav: number; drag: number;
  /** true = hard-edged debris (stones / chunks), false = soft cloud. */
  hard: boolean;
}

export interface EmitParams {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; s0: number; s1: number;
  color: number; alpha: number;
  grav: number; drag: number;
  hard?: boolean;
}

export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly ps: Particle[] = [];
  private count = 0;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aCol: THREE.InstancedBufferAttribute;
  private readonly aSR: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  /** Global emission multiplier (quality setting). */
  density = 1;
  /** Inside an original view: the projected-lightmap particle light at a spawn point (setOriginal). */
  private origLight: ((x: number, y: number, z: number, out: number[], hint?: number) => number) | null = null;
  private origMode = false;
  private lightHint = -1;
  private readonly lightOut = [1, 1, 1];
  /** The original effects of the current stage (inactive on procedural stages). Drawn as children of `mesh`. */
  readonly orig = new OrigEffectsSystem();

  constructor(capacity = 3000) {
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++)
      this.ps.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, s0: 1, s1: 1, r: 1, g: 1, b: 1, a: 1, rot: 0, spin: 0, grav: 0, drag: 0, hard: false });
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index;
    g.setAttribute('position', quad.attributes.position);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSR = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iCol', this.aCol);
    g.setAttribute('iSizeRot', this.aSR);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uPFogColor: { value: new THREE.Vector3(0.8, 0.85, 0.9) },
        uPFogNear: { value: 150 },
        uPFogFar: { value: 1200 },
        uLight: { value: new THREE.Vector3(1, 1, 1) },
        uOrig: { value: 0 },
        ...fogUniformMap(origUniforms.trackFog),
      },
      vertexShader: P_VERT,
      fragmentShader: P_FRAG,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'particles';
    this.mesh.add(this.orig.root);
  }

  /**
   * Stage switch: `original` = the stage is shown through an OriginalStageView. Loads the stage's original
   * effects (async; until then and on any failure the procedural effects run). Never throws; the promise settles once
   * the original effects are in place (or failed), main.ts's loading screen waits for it.
   */
  setStage(stageId: string | null, original: boolean, store: TextureStore | null): Promise<void> {
    return this.orig.setStage(stageId, original, store).catch(() => undefined);
  }

  /** The original effects and the cars' own effect data / drop shadows requested so far have loaded (or failed). */
  settled(): Promise<void> {
    return this.orig.settled();
  }

  setEnvironment(env: EnvironmentPreset): void {
    const f = env.fogColor;
    this.mat.uniforms.uPFogColor.value.set(((f >> 16) & 255) / 255, ((f >> 8) & 255) / 255, (f & 255) / 255);
    this.mat.uniforms.uPFogNear.value = env.fogNear;
    this.mat.uniforms.uPFogFar.value = env.fogFar;
    if (this.origMode) return;
    // rough lighting: ambient + sun elevation, in display space
    const sunUp = Math.max(0, env.sunDir.y);
    const l = Math.min(1.05, 0.45 + 0.25 * env.ambientIntensity + 0.22 * env.sunIntensity * sunUp) * Math.min(1.2, env.exposure);
    this.mat.uniforms.uLight.value.set(l, l, l);
  }

  /**
   * Inside an original view (`on`): the original track fog (origUniforms.trackFog, by identity) and, per particle at
   * spawn, `light` = the projected lightmap through the particle palette (−1 = no lightmap there → the palette's
   * maximum, game.particleLightmapMax). Off: the procedural fog and lighting of setEnvironment (call it after).
   */
  setOriginal(on: boolean, light: ((x: number, y: number, z: number, out: number[], hint?: number) => number) | null = null): void {
    this.origMode = on;
    this.origLight = on ? light : null;
    // the original effects sample the same projected lightmap (exact texel; their 4 m light grid without a view)
    this.orig.lightSource = on ? light : null;
    this.lightHint = -1;
    this.mat.uniforms.uOrig.value = on ? 1 : 0;
    if (on) this.mat.uniforms.uLight.value.set(1, 1, 1);
  }

  clear(): void {
    this.count = 0;
    this.geo.instanceCount = 0;
    this.orig.clear();
  }

  get alive(): number {
    return this.count + this.orig.alive;
  }

  emit(e: EmitParams): void {
    let p: Particle;
    if (this.count < this.capacity) p = this.ps[this.count++];
    else p = this.ps[Math.floor(Math.random() * this.capacity)]; // pool full: recycle a random one
    p.x = e.x; p.y = e.y; p.z = e.z;
    p.vx = e.vx; p.vy = e.vy; p.vz = e.vz;
    p.age = 0; p.life = e.life;
    p.s0 = e.s0; p.s1 = e.s1;
    // colours are written in display (sRGB) space: the shader skips tone mapping like THREE.Fog does
    p.r = ((e.color >> 16) & 255) / 255; p.g = ((e.color >> 8) & 255) / 255; p.b = (e.color & 255) / 255;
    if (this.origMode) {
      // the original's useProjectedLightmaps: the lightmap under the spawn point through the particle palette
      const L = this.lightOut;
      const hit = this.origLight ? this.origLight(e.x, e.y, e.z, L, this.lightHint) : -1;
      if (hit >= 0) this.lightHint = hit;
      else (L[0] = PARTICLE_LIGHTMAP_MAX[0]), (L[1] = PARTICLE_LIGHTMAP_MAX[1]), (L[2] = PARTICLE_LIGHTMAP_MAX[2]);
      p.r *= L[0]; p.g *= L[1]; p.b *= L[2];
    }
    p.a = e.alpha;
    p.rot = Math.random() * Math.PI * 2;
    p.spin = (Math.random() - 0.5) * (e.hard ? 8 : 1.2);
    p.grav = e.grav; p.drag = e.drag;
    p.hard = !!e.hard;
  }

  update(dt: number, camera?: THREE.Camera): void {
    this.orig.update(dt, camera ?? null);
    const ps = this.ps;
    if (dt > 0) {
      let i = 0;
      while (i < this.count) {
        const p = ps[i];
        p.age += dt;
        if (p.age >= p.life) {
          // swap-remove
          const last = ps[--this.count];
          ps[this.count] = p;
          ps[i] = last;
          continue;
        }
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k; p.vy *= k; p.vz *= k;
        p.vy -= 9.81 * p.grav * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.rot += p.spin * dt;
        i++;
      }
    }
    const pos = this.aPos.array as Float32Array, col = this.aCol.array as Float32Array, sr = this.aSR.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const p = ps[i];
      const t = p.age / p.life;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      col[i * 4] = p.r; col[i * 4 + 1] = p.g; col[i * 4 + 2] = p.b;
      // fade in quickly, out smoothly; hard particles keep a negative alpha marker (crisp edge in the shader)
      const fade = Math.min(1, p.age / 0.06) * (1 - t * t);
      col[i * 4 + 3] = (p.hard ? -1 : 1) * Math.max(0.001, p.a * fade);
      sr[i * 2] = p.s0 + (p.s1 - p.s0) * Math.sqrt(t);
      sr[i * 2 + 1] = p.rot;
    }
    this.geo.instanceCount = this.count;
    if (this.count > 0) {
      this.aPos.clearUpdateRanges();
      this.aCol.clearUpdateRanges();
      this.aSR.clearUpdateRanges();
      this.aPos.addUpdateRange(0, this.count * 3);
      this.aCol.addUpdateRange(0, this.count * 4);
      this.aSR.addUpdateRange(0, this.count * 2);
      this.aPos.needsUpdate = true;
      this.aCol.needsUpdate = true;
      this.aSR.needsUpdate = true;
    }
  }

  dispose(): void {
    this.orig.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------------------------------------- skid marks

interface SkidLook {
  color: number;
  alpha: number;
  /** Slip speed (m/s) where marks start, and the slip range to full strength. */
  slip0: number;
  slipRange: number;
  /** Faint rolling track on soft surfaces even without slip (alpha). */
  rolling: number;
  /** Half width of the mark (m): the original's 0.1 m + the material's extra width (Skidmarks.con). */
  halfWidth: number;
}

/**
 * Procedural skid look per surface, from the ORIGINAL skid data (effects.md §7): colour = the material's column
 * of Misc/texture/Tracks.dds (alpha-weighted mean) + the Skidmarks.con colour (added, like skidMarkNoBump.ps),
 * alpha = the column's mean alpha × setIntensityClamp, half width = 0.1 m + setMaterialSkidMarkExtraWidth. The
 * materials Skidmarks.con leaves at the renderer defaults (SNOWASPHALT 10, SNOWDITCH 11, LEAF 14, ASPHALTGRASS 15,
 * MUDDITCH 18: colour (1,1,1) = white marks in the original) use the plain column colour here. GRASS keeps width 0
 * (the script's COBBLES block sets material 0's extra width to 0). slip0 / slipRange / rolling stay the
 * procedural trigger (the original trigger needs the original wheel getters, see orig/effects.ts).
 */
const SKID: Record<SurfaceId, SkidLook> = {
  tarmac: { color: 0x1d1a1c, alpha: 0.75, slip0: 2.2, slipRange: 6, rolling: 0, halfWidth: 0.1 }, // ASPHALT 1
  cobbles: { color: 0x6c6b6a, alpha: 0, slip0: 2.5, slipRange: 6, rolling: 0, halfWidth: 0.1 }, // COBBLES 13 (clamp 0)
  water: { color: 0x5c5f6c, alpha: 0.36, slip0: 2.2, slipRange: 6, rolling: 0, halfWidth: 0.11 }, // WATERASPHALT 3
  gravel: { color: 0x56452f, alpha: 0.46, slip0: 1.2, slipRange: 5, rolling: 0.12, halfWidth: 0.15 }, // GRAVEL 2
  gravelDeep: { color: 0x7d6846, alpha: 0.78, slip0: 1.0, slipRange: 5, rolling: 0.22, halfWidth: 0.14 }, // GRAVELDEEP 12
  mud: { color: 0x241a11, alpha: 0.4, slip0: 0.8, slipRange: 4, rolling: 0.35, halfWidth: 0.14 }, // MUD 4
  snow: { color: 0xe0eaff, alpha: 0.22, slip0: 0.8, slipRange: 4, rolling: 0.2, halfWidth: 0.16 }, // SNOW 7
  ice: { color: 0xebf1ff, alpha: 0.05, slip0: 1.5, slipRange: 5, rolling: 0, halfWidth: 0.12 }, // ICEASPHALT 20
  grass: { color: 0x3f3d31, alpha: 0.31, slip0: 0.8, slipRange: 4, rolling: 0.3, halfWidth: 0.1 }, // GRASS 0
  sand: { color: 0xffe59f, alpha: 0.16, slip0: 0.8, slipRange: 4, rolling: 0.16, halfWidth: 0.15 }, // SAND 5
  wood: { color: 0x5e4c3a, alpha: 0, slip0: 2.5, slipRange: 6, rolling: 0, halfWidth: 0.1 }, // WOOD 6 (clamp 0)
  snowChunky: { color: 0xdbe1f1, alpha: 0, slip0: 0.8, slipRange: 4, rolling: 0, halfWidth: 0.1 }, // SNOWCHUNKY 8 (empty column)
  snowDeep: { color: 0xdbe1fe, alpha: 0.22, slip0: 0.8, slipRange: 4, rolling: 0.22, halfWidth: 0.17 }, // SNOWDEEP 9 (always marks)
  snowAsphalt: { color: 0xc3c9cf, alpha: 0.74, slip0: 0.8, slipRange: 4, rolling: 0, halfWidth: 0.1 }, // SNOWASPHALT 10
  snowDitch: { color: 0xc9d0d1, alpha: 0.74, slip0: 0.8, slipRange: 4, rolling: 0.3, halfWidth: 0.1 }, // SNOWDITCH 11
  leaf: { color: 0x7b6b3d, alpha: 0.85, slip0: 0.8, slipRange: 4, rolling: 0.3, halfWidth: 0.1 }, // LEAF 14
  asphaltGrass: { color: 0x3d4133, alpha: 0.74, slip0: 2.2, slipRange: 6, rolling: 0, halfWidth: 0.1 }, // ASPHALTGRASS 15
  gravelGrass: { color: 0x463b2e, alpha: 0.31, slip0: 1.2, slipRange: 5, rolling: 0.12, halfWidth: 0.15 }, // GRAVELGRASS 16
  mudGrass: { color: 0x3c342c, alpha: 0.31, slip0: 0.8, slipRange: 4, rolling: 0.3, halfWidth: 0.15 }, // MUDGRASS 17
  mudDitch: { color: 0x38322c, alpha: 0.52, slip0: 0.8, slipRange: 4, rolling: 0.35, halfWidth: 0.1 }, // MUDDITCH 18
  sandDeep: { color: 0xffd693, alpha: 0.16, slip0: 0.8, slipRange: 4, rolling: 0.16, halfWidth: 0.17 }, // SANDDEEP 19
  sandDark: { color: 0x5c4c38, alpha: 0.16, slip0: 0.8, slipRange: 4, rolling: 0.16, halfWidth: 0.15 }, // SANDDARK 21
  sandDarkDeep: { color: 0x584624, alpha: 0.78, slip0: 0.8, slipRange: 4, rolling: 0.3, halfWidth: 0.18 }, // SANDDARKDEEP 22
};

/** Exported for tests: the procedural skid look of a surface. */
export const skidLook = (s: SurfaceId): Readonly<SkidLook> => SKID[s];

interface WheelTrack {
  active: boolean;
  lx: number; ly: number; lz: number; // last centre point
  ax: number; ay: number; az: number; // last left vertex
  bx: number; by: number; bz: number; // last right vertex
  alpha: number;
}

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly aPos: THREE.BufferAttribute;
  private readonly aCol: THREE.BufferAttribute;
  private head = 0;
  private filled = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private readonly tmp = new THREE.Color();

  constructor(capacity = 6000) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 4 * 3);
    this.col = new Float32Array(capacity * 4 * 4);
    const idx = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const v = i * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('color', this.aCol);
    const nrm = new Float32Array(capacity * 4 * 3);
    for (let i = 0; i < capacity * 4; i++) nrm[i * 3 + 1] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'skidmarks';
  }

  newTrack(): WheelTrack {
    return { active: false, lx: 0, ly: 0, lz: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, alpha: 0 };
  }

  /** Extend `track` to point (x, y, z) heading (dx, dz) with half-width hw. alpha 0 → break the ribbon. */
  add(track: WheelTrack, x: number, y: number, z: number, dx: number, dz: number, hw: number, color: number, alpha: number): void {
    if (alpha <= 0.01) {
      track.active = false;
      return;
    }
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) return;
    // right = cross(dir, up) = (-dz, 0, dx)
    const rx = (-dz / l) * hw, rz = (dx / l) * hw;
    const ax = x - rx, az = z - rz, bx = x + rx, bz = z + rz;
    if (!track.active) {
      track.active = true;
      track.lx = x; track.ly = y; track.lz = z;
      track.ax = ax; track.ay = y; track.az = az;
      track.bx = bx; track.by = y; track.bz = bz;
      track.alpha = alpha;
      return;
    }
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + 1);
    const p = this.pos, c = this.col;
    const v = i * 12;
    p[v] = track.ax; p[v + 1] = track.ay; p[v + 2] = track.az;
    p[v + 3] = track.bx; p[v + 4] = track.by; p[v + 5] = track.bz;
    p[v + 6] = ax; p[v + 7] = y; p[v + 8] = az;
    p[v + 9] = bx; p[v + 10] = y; p[v + 11] = bz;
    this.tmp.setHex(color);
    const cc = i * 16;
    const a0 = track.alpha, a1 = alpha;
    for (let k = 0; k < 4; k++) {
      c[cc + k * 4] = this.tmp.r;
      c[cc + k * 4 + 1] = this.tmp.g;
      c[cc + k * 4 + 2] = this.tmp.b;
      c[cc + k * 4 + 3] = k < 2 ? a0 : a1;
    }
    this.dirtyLo = Math.min(this.dirtyLo, i);
    this.dirtyHi = Math.max(this.dirtyHi, i);
    track.lx = x; track.ly = y; track.lz = z;
    track.ax = ax; track.ay = y; track.az = az;
    track.bx = bx; track.by = y; track.bz = bz;
    track.alpha = alpha;
  }

  /** Upload changed quads (call once per frame). */
  flush(): void {
    if (this.dirtyHi < 0) return;
    const lo = this.dirtyLo, hi = this.dirtyHi;
    this.aPos.clearUpdateRanges();
    this.aCol.clearUpdateRanges();
    this.aPos.addUpdateRange(lo * 12, (hi - lo + 1) * 12);
    this.aCol.addUpdateRange(lo * 16, (hi - lo + 1) * 16);
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, this.filled * 6);
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  get segments(): number {
    return this.filled;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ------------------------------------------------------------------------------------------- per-car emitter

interface FxLook {
  /** Soft cloud: colour, alpha, sizes, life, per-second emission from speed (per m/s) and slip (per m/s). */
  cloud?: { color: number; alpha: number; s0: number; s1: number; life: number; perSpeed: number; perSlip: number; slip0: number; rise: number; drag: number };
  /** Ballistic debris (stones, clods, droplets). */
  debris?: { color: number; color2: number; alpha: number; size: number; life: number; perSlip: number; perSpeed: number; slip0: number; up: number; back: number; grav: number };
}

function fxFor(surface: SurfaceId): FxLook {
  const info = SURFACE_INFO[surface];
  switch (surface) {
    case 'tarmac':
    case 'cobbles':
      return {
        cloud: { color: 0xe4e4e4, alpha: 0.24, s0: 0.5, s1: 3.0, life: 1.8, perSpeed: 0, perSlip: 6, slip0: 3.5, rise: 0.7, drag: 1.4 },
      };
    case 'water':
      return {
        cloud: { color: 0xdfe7ee, alpha: 0.28, s0: 0.5, s1: 2.6, life: 0.9, perSpeed: 0.9, perSlip: 2, slip0: 0, rise: 0.3, drag: 2.5 },
        debris: { color: 0xcfdbe6, color2: 0xa8bccd, alpha: 0.6, size: 0.07, life: 0.55, perSlip: 3, perSpeed: 2.2, slip0: 0, up: 2.2, back: 0.35, grav: 1 },
      };
    case 'snow':
      return {
        cloud: { color: info.dustColor, alpha: 0.5, s0: 0.6, s1: 3.2, life: 1.5, perSpeed: 1.1, perSlip: 5, slip0: 0.3, rise: 0.25, drag: 2.0 },
        debris: { color: 0xffffff, color2: 0xdfe8f2, alpha: 0.9, size: 0.09, life: 0.7, perSlip: 9, perSpeed: 1.0, slip0: 0.8, up: 2.6, back: 0.4, grav: 0.8 },
      };
    case 'ice':
      return {
        cloud: { color: info.dustColor, alpha: 0.3, s0: 0.4, s1: 2.0, life: 1.0, perSpeed: 0.15, perSlip: 3, slip0: 2, rise: 0.2, drag: 2.5 },
        debris: { color: 0xffffff, color2: 0xd8ecfa, alpha: 0.9, size: 0.05, life: 0.5, perSlip: 6, perSpeed: 0, slip0: 2, up: 1.6, back: 0.3, grav: 0.8 },
      };
    case 'mud':
      return {
        cloud: { color: 0x6a5642, alpha: 0.22, s0: 0.6, s1: 2.6, life: 1.4, perSpeed: 0.25, perSlip: 2.5, slip0: 0.5, rise: 0.25, drag: 2.0 },
        debris: { color: 0x3c2c1e, color2: 0x5a4430, alpha: 1, size: 0.11, life: 0.9, perSlip: 10, perSpeed: 0.8, slip0: 0.5, up: 2.8, back: 0.45, grav: 1.1 },
      };
    case 'grass':
      return {
        cloud: { color: 0x7a6a4c, alpha: 0.2, s0: 0.6, s1: 2.4, life: 1.4, perSpeed: 0.2, perSlip: 3, slip0: 0.8, rise: 0.3, drag: 2.0 },
        debris: { color: 0x3e5a24, color2: 0x4a3a26, alpha: 1, size: 0.1, life: 0.9, perSlip: 9, perSpeed: 0.3, slip0: 0.8, up: 2.6, back: 0.4, grav: 1.1 },
      };
    default: // gravel, gravelDeep, sand: the classic rally dust cloud + stones
      return {
        cloud: {
          color: info.dustColor,
          alpha: surface === 'sand' ? 0.4 : 0.36,
          s0: 0.8,
          s1: surface === 'gravelDeep' ? 6.0 : 5.0,
          life: 3.2,
          perSpeed: 1.25,
          perSlip: 4,
          slip0: 0,
          rise: 0.5,
          drag: 1.2,
        },
        debris: { color: 0x6a5844, color2: 0x9a8668, alpha: 1, size: 0.045, life: 0.8, perSlip: 12, perSpeed: 0.5, slip0: 1.0, up: 3.2, back: 0.5, grav: 1.2 },
      };
  }
}

const FX_CACHE = new Map<SurfaceId, FxLook>();
const fx = (s: SurfaceId) => {
  let f = FX_CACHE.get(s);
  if (!f) FX_CACHE.set(s, (f = fxFor(s)));
  return f;
};

const WHEEL_R = 0.3;

/** Wheel ground slip speed (m/s) from telemetry: |ω·R − v_long| and the contact-patch lateral speed. */
export function wheelSlip(tel: Readonly<CarTelemetry>, i: number): { slip: number; long: number; lat: number; vLong: number } {
  const w = tel.wheels[i];
  const v = tel.velLocal, av = tel.angVelLocal;
  const c = w.visual.centreLocal; // three car-local → sim body (x, y, -z)
  const rz = -(c?.z ?? 0), rx = c?.x ?? 0, ry = c?.y ?? 0;
  // contact-patch velocity in the sim body frame: v + ω × r
  const vx = v.x + (av.y * rz - av.z * ry);
  const vz = v.z + (av.x * ry - av.y * rx);
  const d = Number.isFinite(w.visual.steerAngle) ? w.visual.steerAngle : 0;
  const cs = Math.cos(d), sn = Math.sin(d);
  const vLong = vx * sn + vz * cs;
  const vLat = vx * cs - vz * sn;
  const long = w.omega * WHEEL_R - vLong;
  return { slip: Math.hypot(long, vLat), long, lat: vLat, vLong };
}

export class CarEffects {
  private readonly particles: ParticleSystem;
  private readonly skids: SkidMarks;
  private readonly tracks: WheelTrack[];
  private readonly acc = [0, 0, 0, 0, 0, 0, 0, 0];
  private readonly lastStep: { n: number } = { n: -1 };
  private lastReset = -1;
  /** Per-wheel last skid sample point (spacing control). */
  private readonly lastMark: { x: number; z: number }[] = [];
  /** Aggregates for audio / debugging. */
  readonly slip = [0, 0, 0, 0];
  /** The original effects of this car (used while the particle system has an original stage loaded). */
  readonly orig: OrigCarFx;

  /** `origCar` = the original car name (exhaust bursts and drop shadow need its data; absent → none). */
  constructor(particles: ParticleSystem, skids: SkidMarks, origCar?: string | null) {
    this.particles = particles;
    this.skids = skids;
    this.tracks = [0, 1, 2, 3].map(() => skids.newTrack());
    for (let i = 0; i < 4; i++) this.lastMark.push({ x: 1e9, z: 1e9 });
    this.orig = new OrigCarFx(particles.orig, origCar);
  }

  reset(): void {
    for (const t of this.tracks) t.active = false;
    for (const m of this.lastMark) m.x = m.z = 1e9;
    this.acc.fill(0);
    this.orig.reset();
  }

  /** The car's original effects data and drop shadow (with its texture) have loaded, or failed. Never rejects. */
  whenReady(): Promise<void> {
    return this.orig.whenReady();
  }

  /** Release the original effects of this car (emitters, drop shadow). */
  dispose(): void {
    this.orig.dispose();
  }

  /** `pose` = the interpolated render pose (drop shadow, exhaust); the telemetry pose otherwise. */
  update(tel: Readonly<CarTelemetry>, pose?: Readonly<CarRenderState>): void {
    if (this.particles.orig.active) {
      this.orig.update(tel, pose);
      return;
    }
    if (tel.resetCount !== this.lastReset) {
      this.lastReset = tel.resetCount;
      this.lastStep.n = tel.stepCount;
      this.reset();
      return;
    }
    const steps = this.lastStep.n < 0 ? 0 : tel.stepCount - this.lastStep.n;
    this.lastStep.n = tel.stepCount;
    if (steps <= 0) return;
    const dt = Math.min(0.25, steps * DT);
    const vel = tel.vel; // three space
    const density = this.particles.density;
    // car right vector (three) for the outward spray of the clouds
    const q = tel.quat;
    const rgx = 1 - 2 * (q.y * q.y + q.z * q.z), rgz = 2 * (q.x * q.z - q.w * q.y);
    for (let i = 0; i < 4; i++) {
      const w = tel.wheels[i];
      const ws = wheelSlip(tel, i);
      this.slip[i] = ws.slip;
      if (!w.contact || !w.surface) {
        this.skids.add(this.tracks[i], 0, 0, 0, 0, 0, 0, 0, 0);
        continue;
      }
      const surf = w.surface;
      const cp = w.contactPointThree;
      const speed = Math.abs(ws.vLong);
      // ---- skid marks
      const sk = SKID[surf];
      const markA = Math.min(1, Math.max(0, (ws.slip - sk.slip0) / sk.slipRange));
      let alpha = sk.alpha * markA;
      if (sk.rolling > 0 && speed > 1.5) alpha = Math.max(alpha, sk.rolling);
      const lm = this.lastMark[i];
      const dx = cp.x - lm.x, dz = cp.z - lm.z;
      const moved = Math.hypot(dx, dz);
      if (alpha <= 0.01) {
        this.skids.add(this.tracks[i], 0, 0, 0, 0, 0, 0, 0, 0);
        lm.x = cp.x;
        lm.z = cp.z;
      } else if (moved > 0.3) {
        if (moved > 4) this.tracks[i].active = false; // teleport / big gap: start a fresh ribbon
        this.skids.add(this.tracks[i], cp.x, cp.y + ROAD_LIFT + 0.012, cp.z, dx, dz, sk.halfWidth, sk.color, alpha);
        lm.x = cp.x;
        lm.z = cp.z;
      }
      // ---- particles
      const f = fx(surf);
      // backward-ish spray direction: opposite to the wheel's ground velocity, plus car velocity carry
      const vlen = Math.hypot(vel.x, vel.z) || 1;
      const bx = -vel.x / vlen, bz = -vel.z / vlen;
      if (f.cloud) {
        const c = f.cloud;
        const slipX = Math.max(0, ws.slip - c.slip0);
        const rate = (c.perSpeed * speed + c.perSlip * slipX) * density;
        this.acc[i] += rate * dt;
        let n = Math.floor(this.acc[i]);
        this.acc[i] -= n;
        n = Math.min(n, 6);
        const side = i === 0 || i === 3 ? -1 : 1; // outward from the car's centre line
        for (let k = 0; k < n; k++) {
          const j = (k + Math.random()) / Math.max(1, n);
          const big = Math.min(1.6, 0.6 + (speed + slipX) / 25);
          const out = side * (0.8 + Math.random() * 2.2 + slipX * 0.15);
          this.particles.emit({
            x: cp.x - vel.x * dt * j + (Math.random() - 0.5) * 0.4,
            y: cp.y + 0.25 + Math.random() * 0.2,
            z: cp.z - vel.z * dt * j + (Math.random() - 0.5) * 0.4,
            vx: vel.x * 0.45 + bx * slipX * 0.25 + rgx * out + (Math.random() - 0.5) * 1.2,
            vy: c.rise + Math.random() * 0.6,
            vz: vel.z * 0.45 + bz * slipX * 0.25 + rgz * out + (Math.random() - 0.5) * 1.2,
            life: c.life * (0.7 + Math.random() * 0.6),
            s0: c.s0 * big,
            s1: c.s1 * big * (0.8 + Math.random() * 0.4),
            color: c.color,
            alpha: c.alpha * (0.6 + Math.random() * 0.4),
            grav: -0.01,
            drag: c.drag,
          });
        }
      }
      if (f.debris) {
        const d = f.debris;
        const slipX = Math.max(0, ws.slip - d.slip0);
        const rate = (d.perSlip * slipX + d.perSpeed * speed) * density;
        this.acc[i + 4] += rate * dt;
        let n = Math.floor(this.acc[i + 4]);
        this.acc[i + 4] -= n;
        n = Math.min(n, 8);
        // spin direction: wheel spinning faster than the ground throws debris backward relative to the car
        const thr = Math.sign(ws.long) || 1;
        const fwdX = -bx, fwdZ = -bz;
        for (let k = 0; k < n; k++) {
          const pow = 0.5 + Math.random() * 0.8;
          const back = (d.back * Math.abs(ws.long) + 1.5) * pow;
          this.particles.emit({
            x: cp.x + (Math.random() - 0.5) * 0.25,
            y: cp.y + 0.05,
            z: cp.z + (Math.random() - 0.5) * 0.25,
            vx: vel.x * 0.6 - fwdX * back * thr + (Math.random() - 0.5) * 2.2 + ws.lat * 0.2,
            vy: d.up * pow + Math.random() * 1.2,
            vz: vel.z * 0.6 - fwdZ * back * thr + (Math.random() - 0.5) * 2.2,
            life: d.life * (0.6 + Math.random() * 0.6),
            s0: d.size * (0.6 + Math.random() * 0.8),
            s1: d.size * 0.8,
            color: Math.random() < 0.5 ? d.color : d.color2,
            alpha: d.alpha,
            grav: d.grav,
            drag: 0.6,
            hard: true,
          });
        }
      }
    }
  }
}
