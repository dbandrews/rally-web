/**
 * src/render/orig/carShader.ts — GLSL port of the original car shaders (OWNED BY THE CARS BUILDER).
 *
 * Source: Misc/shaders/Car/{vs,ps}/… (DX8 asm, research/formats/cars.md §7 + Verification). One ShaderMaterial per
 * `.cm` material; the program variant comes from the subshader flags exactly like the original's name choice
 * (FUN_006610d0): pixel shader `[Dirt][Envmap]Tex[Highlight][Mask]`, vertex shader `Standard_Base[Dirt][Envmap]`.
 *
 * Vertex (Standard_BaseDirtEnvmapLightmap2t.vs, world space, E = normalize(Vworld − eye)):
 *   envUV   = E − 2(E·N)N                              cube lookup in the SIM frame: textureCube(env, (r.x, r.y, −r.z))
 *   fresnel = fresnelBias + (fresnelScale·(1 + E·N)²)²   (component-wise; mad r, r, r, bias)
 *   lit     = (max(0, N·−L), max(0, N·H)^specPower),   H = normalize(−E − L)   (−L = origUniforms.sunDir)
 *   oD0.rgb = sat((ambient·car.ambient + lit.diff·diffuse·car.lightColor)·vcol.rgb)
 *   oD0.a   = sat(materialColour.a·fresnel.a)            (envmap programs; materialColour.a otherwise; = 1)
 *   oD1.x   = sat(fresnel.x·vcol.a)  ("red mask" c7),  oD1.z = sat(specScale·lit.spec·vcol.a)
 *   (vs.1.1 saturates oD0/oD1 before interpolation — the D3D8 rule; LampGlass ambient 100 relies on it)
 * Pixel (Palettized_D3DCompliant/DirtEnvmapTexHighlight.ps, ps.1.1 registers clamp at 1 after every op):
 *   c  = t0·v0  [+ t2.a·c2 (Highlight)]  + fr·t2  + spec·t0
 *   c  = lerp(c, t1·v0, c0·t1.a)                         (Dirt: CarDirtmap on uv1, c0 = dirt factor)
 *   c *= t3                                              (the projected track lightmap under the car, below)
 *   a  = v0.a·t0.a
 *   …Mask: reflection and Phong term × t0.a (no env.a·c2 with Dirt — "pixel shader too long");
 *   Tex = t0·v0; DirtTex = lerp(t0, t1, c0·t1.a)·v0.
 * Other builders: Car/Reflector (Reflector1t.vs + Reflector.ps) = t0·env·sat(matAmbient + N·L·matDiffuse), a = 1;
 *   LampGlass `envmapPass` second pass (EnvmapPass0t.vs + EnvmapPass.ps) = env·sat(fresnel)·lightmap, a = 1 (blend
 *   [I]: additive); LampBack while braking = Generic/TexSimple (t0 unlit); Car/Ghost (Ghost0t.vs: env coordinate only).
 * Track lightmap t3 (Palettized_D3DCompliant, every Tex/Envmap/Dirt program and EnvmapPass; not Reflector, TexSimple,
 *   Ghost, Cup): oT3 = (Vworld.xz − C_LIGHTMAP_OFFSET.xz)·C_LIGHTMAP_INVSIZE.xz = the patch lightmap under the car
 *   (track.ts carLightmapAt) expanded through the CAR palette (Car.lightmapMin/Max/Clamp, common.ts lightmapLut;
 *   bound by the car renderer at 0x48f8b8). Here vLmUv = (uLmProj.x·x + uLmProj.y, uLmProj.z·z + uLmProj.w) in three
 *   world space; no track (menu, procedural stage) → a white 1×1 texture.
 * Fog: the TRACK fog (origUniforms.trackFog, ORIG_FOG_PARS) per vertex like every original material.
 * Output: raw gamma-space bytes (no colour-space / tone-mapping chunks), like the D3D8 original.
 *
 * Per-stage constants (stages/<id>/cars.json `settings`): c2 = car.specularColor (default 1,1,1 [V builder+0x7c]),
 * car.specularHighlightsEnable gates the Highlight term [I], car.envmapColorScale scales the env colour [I],
 * car.metallicSpecularScale scales specScale [I] (bindings of the last two inferred from their names, cars.md §6).
 */
import * as THREE from 'three';
import { ORIG_FOG_PARS, fogUniformMap, origUniforms, type OrigUniform } from './common';

/** Normalised subshader (tools/assets/parts/cars.py shader_entry). */
export interface CarShaderDef {
  kind: 'default' | 'reflector' | 'ghost' | 'cup';
  tex: string | null;
  ambient: [number, number, number];
  diffuse: [number, number, number];
  dirt: boolean;
  env: boolean;
  highlight: boolean;
  mask: boolean;
  transparent: boolean;
  envPass: boolean;
  blend: 'opaque' | 'alpha' | 'mod2x';
  specPower: number;
  specScale: number;
  fresnelBias: [number, number, number, number];
  fresnelScale: [number, number, number, number];
  lampBack: boolean;
}

/** Program the material is drawn with. `envPass` = the LampGlass second pass; `ghost` = the ghost car. */
export type CarPass = 'main' | 'envPass' | 'ghost';

/** Uniforms shared by every material of one car visual (written per frame by OriginalCarVisual). */
export interface CarVisualUniforms {
  /** CarEnvmap cube of the stage (or the menu cube). */
  env: OrigUniform<THREE.Texture | null>;
  /** CarDirtmap of the stage. */
  dirtMap: OrigUniform<THREE.Texture | null>;
  /** c0 dirt factor 0..1 (accumulation law not located, cars.md §12 Q2: stays 0 = clean car). */
  dirtFactor: OrigUniform<number>;
  /** c2 car.specularColor (× specularHighlightsEnable). */
  specColor: OrigUniform<THREE.Vector3>;
  /** car.envmapColorScale. */
  envScale: OrigUniform<THREE.Vector3>;
  /** car.metallicSpecularScale. */
  specScaleMul: OrigUniform<number>;
  /** 1 while braking: LampBack materials switch to TexSimple. */
  brake: OrigUniform<number>;
  /** Crash morph 0..1 toward the stored deformation pose (cars.md §5.3/§9; the damage law is not ported). */
  damage: OrigUniform<number>;
  /** Ghost translucency (alpha of the ghost pass). */
  ghostAlpha: OrigUniform<number>;
  /** t3: the projected track lightmap under the car through the car palette (white when none). */
  lightmap: OrigUniform<THREE.Texture>;
  /** Its projection: u = x·p.x + p.y, v = z·p.z + p.w (three world space). */
  lightmapProj: OrigUniform<THREE.Vector4>;
}

let whiteTex: THREE.DataTexture | null = null;
/** The white 1×1 lightmap (no track lightmap under the car: t3 = 1). Shared, never disposed. */
export function whiteLightmap(): THREE.DataTexture {
  if (!whiteTex) {
    whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteTex.colorSpace = THREE.NoColorSpace;
    whiteTex.name = 'orig-car:white-lightmap';
    whiteTex.needsUpdate = true;
  }
  return whiteTex;
}

export function createCarVisualUniforms(): CarVisualUniforms {
  return {
    env: { value: null },
    dirtMap: { value: null },
    dirtFactor: { value: 0 },
    specColor: { value: new THREE.Vector3(1, 1, 1) },
    envScale: { value: new THREE.Vector3(1, 1, 1) },
    specScaleMul: { value: 1 },
    brake: { value: 0 },
    damage: { value: 0 },
    ghostAlpha: { value: 0.35 },
    lightmap: { value: whiteLightmap() },
    lightmapProj: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
}

const VERT = /* glsl */ `
${ORIG_FOG_PARS}
attribute vec4 aCol;
#ifdef DIRT
attribute vec2 aUv1;
varying vec2 vUv1;
#endif
#ifdef DEFORM
attribute vec3 aDpos;
attribute vec3 aDnrm;
uniform float uDamage;
#endif
uniform vec3 uMatAmbient;
uniform vec3 uMatDiffuse;
uniform vec3 uCarAmbient;
uniform vec3 uCarLight;
uniform vec3 uSunDir;
uniform vec4 uFresnelBias;
uniform vec4 uFresnelScale;
uniform float uSpecScale;
uniform float uSpecScaleMul;
uniform float uSpecPower;
#ifdef LIGHTMAP
uniform vec4 uLmProj;
varying vec2 vLmUv;
#endif
varying vec2 vUv0;
varying vec4 vD0;
varying vec4 vD1;
varying vec3 vRefl;
varying float vOrigFog;

void main() {
  vec3 p = position;
  vec3 n = normal;
#ifdef DEFORM
  p = mix(p, aDpos, uDamage);
  n = normalize(mix(n, aDnrm, uDamage));
#endif
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vec3 N = normalize(mat3(modelMatrix) * n);
  vec3 E = normalize(wp.xyz - cameraPosition);
  float EdotN = dot(E, N);
  vRefl = E - 2.0 * EdotN * N;
  vec4 f = (1.0 + EdotN) * (1.0 + EdotN) * uFresnelScale;
  vec4 fresnel = f * f + uFresnelBias;
  vec3 L = normalize(uSunDir);                        // toward the sun = the original's −C_LIGHT_DIR
  float diff = max(0.0, dot(N, L));
  vec3 H = normalize(-E + L);
  float spec = diff > 0.0 ? pow(max(0.0, dot(N, H)), max(uSpecPower, 1e-4)) : 0.0;   // lit: 0 when N·L <= 0
#if defined(REFLECTOR)
  vD0 = vec4(clamp(uMatAmbient + diff * uMatDiffuse, 0.0, 1.0), 1.0);
  vD1 = vec4(0.0);
#elif defined(ENVPASS)
  vD0 = clamp(fresnel, 0.0, 1.0);
  vD1 = vec4(0.0);
#else
  vec3 d0 = (uMatAmbient * uCarAmbient + diff * uMatDiffuse * uCarLight) * aCol.rgb;
  #ifdef ENV
  vD0 = vec4(clamp(d0, 0.0, 1.0), clamp(fresnel.w, 0.0, 1.0));
  #else
  vD0 = vec4(clamp(d0, 0.0, 1.0), 1.0);
  #endif
  vD1 = clamp(vec4(fresnel.x * aCol.a, 0.0, uSpecScale * uSpecScaleMul * spec * aCol.a, 0.0), 0.0, 1.0);
#endif
  vUv0 = uv;
#ifdef DIRT
  vUv1 = aUv1;
#endif
#ifdef LIGHTMAP
  vLmUv = vec2(uLmProj.x * wp.x + uLmProj.y, uLmProj.z * wp.z + uLmProj.w);   // oT3 (CLAMP)
#endif
  vec4 mv = viewMatrix * wp;
  vOrigFog = origFogFactor(-mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
${ORIG_FOG_PARS}
uniform sampler2D tBase;
uniform samplerCube tEnv;
uniform sampler2D tDirt;
uniform float uDirtFactor;
uniform vec3 uSpecColor;
uniform vec3 uEnvScale;
uniform float uBrake;
uniform float uGhostAlpha;
#ifdef LIGHTMAP
uniform sampler2D tLightmap;
varying vec2 vLmUv;
#endif
varying vec2 vUv0;
varying vec4 vD0;
varying vec4 vD1;
varying vec3 vRefl;
varying float vOrigFog;
#ifdef DIRT
varying vec2 vUv1;
#endif

vec4 envSample() {
  vec3 r = normalize(vRefl);
  return textureCube(tEnv, vec3(r.x, r.y, -r.z));   // cube faces are in the SIM frame (docs/ASSETS.md §8)
}

void main() {
  vec4 col;
#if defined(GHOST)
  vec4 e = envSample();
  col = vec4(e.rgb * uEnvScale, uGhostAlpha);
#elif defined(ENVPASS)
  vec4 e = envSample();
  vec3 ep = min(e.rgb * uEnvScale * vD0.rgb, 1.0);
  #ifdef LIGHTMAP
  ep *= texture2D(tLightmap, vLmUv).rgb;              // EnvmapPass.ps: mul r0, r0, t1 (the lightmap)
  #endif
  col = vec4(ep * vOrigFog, 1.0);                     // additive pass fades out in the fog
  gl_FragColor = col;
  return;
#else
  vec4 t0 = texture2D(tBase, vUv0);
  #if defined(REFLECTOR)
  vec4 e = envSample();
  col = vec4(min(t0.rgb * e.rgb * uEnvScale, 1.0) * vD0.rgb, 1.0);
  #else
  vec3 c = min(t0.rgb * vD0.rgb, 1.0);
    #ifdef ENV
  vec4 e = envSample();
  vec3 env = e.rgb * uEnvScale;
  float fr = vD1.x;
  float sp = vD1.z;
      #ifdef MASK
  vec3 refl = min(fr * env + sp * t0.rgb, 1.0) * t0.a;
        #if defined(HIGHLIGHT) && !defined(DIRT)
  refl = min(refl + e.a * t0.a * uSpecColor, 1.0);
        #endif
  c = min(c + refl, 1.0);
      #else
        #ifdef HIGHLIGHT
  c = min(c + e.a * uSpecColor, 1.0);
        #endif
  c = min(c + fr * env, 1.0);
  c = min(c + sp * t0.rgb, 1.0);
      #endif
    #endif
    #ifdef DIRT
  vec4 t1 = texture2D(tDirt, vUv1);
  c = mix(c, min(t1.rgb * vD0.rgb, 1.0), clamp(uDirtFactor * t1.a, 0.0, 1.0));
    #endif
    #ifdef LIGHTMAP
  c *= texture2D(tLightmap, vLmUv).rgb;               // mul r0.rgb, r0, t3 (Palettized: RGB through the car palette)
    #endif
  col = vec4(c, vD0.a * t0.a);
    #ifdef LAMPBACK
  col = mix(col, t0, uBrake);                         // Generic/TexSimple while braking
    #endif
  #endif
#endif
#ifdef MOD2X
  // dest·src + src·dest: fog pulls the factor toward 0.5 (= no change) instead of the fog colour
  col.rgb = mix(vec3(0.5), col.rgb, vOrigFog);
#else
  col.rgb = mix(uFogColor, col.rgb, vOrigFog);
#endif
  gl_FragColor = col;
}
`;

/** ShaderMaterial for one car material + pass. Textures are bound later through `setCarTextures`. */
export function makeCarMaterial(
  def: CarShaderDef,
  pass: CarPass,
  shared: CarVisualUniforms,
  opts: { base: THREE.Texture | null; deform: boolean },
): THREE.ShaderMaterial {
  const defines: Record<string, string> = {};
  const isGhost = pass === 'ghost';
  const isEnvPass = pass === 'envPass';
  if (isGhost) defines.GHOST = '';
  else if (isEnvPass) defines.ENVPASS = '';
  else if (def.kind === 'reflector') defines.REFLECTOR = '';
  else {
    if (def.env) defines.ENV = '';
    if (def.dirt && shared.dirtMap.value) defines.DIRT = '';
    if (def.env && def.highlight) defines.HIGHLIGHT = '';
    if (def.env && def.mask) defines.MASK = '';
    if (def.lampBack) defines.LAMPBACK = '';
    if (def.kind === 'default') defines.LIGHTMAP = '';
  }
  if (isEnvPass) defines.LIGHTMAP = '';
  if (!isGhost && !isEnvPass && def.blend === 'mod2x') defines.MOD2X = '';
  if (opts.deform) defines.DEFORM = '';
  const u = origUniforms;
  const mat = new THREE.ShaderMaterial({
    name: `orig-car:${def.kind}:${pass}`,
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines,
    uniforms: {
      ...fogUniformMap(u.trackFog),
      uCarAmbient: u.carAmbient,
      uCarLight: u.carLight,
      uSunDir: u.sunDir,
      uMatAmbient: { value: new THREE.Vector3(...def.ambient) },
      uMatDiffuse: { value: new THREE.Vector3(...def.diffuse) },
      uFresnelBias: { value: new THREE.Vector4(...def.fresnelBias) },
      uFresnelScale: { value: new THREE.Vector4(...def.fresnelScale) },
      uSpecScale: { value: def.specScale },
      uSpecPower: { value: def.specPower },
      uSpecScaleMul: shared.specScaleMul,
      uSpecColor: shared.specColor,
      uEnvScale: shared.envScale,
      uDirtFactor: shared.dirtFactor,
      uBrake: shared.brake,
      uDamage: shared.damage,
      uGhostAlpha: shared.ghostAlpha,
      tBase: { value: opts.base },
      tEnv: shared.env,
      tDirt: shared.dirtMap,
      tLightmap: shared.lightmap,
      uLmProj: shared.lightmapProj,
    },
  });
  // D3D render states (cars.md §6/§7 Verification "still open": SRCALPHA/INVSRCALPHA after opaque; CULL_CCW)
  mat.side = THREE.FrontSide;
  if (isGhost) {
    mat.transparent = true;
    mat.depthWrite = true;
  } else if (isEnvPass) {
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.premultipliedAlpha = false;
  } else if (def.blend === 'mod2x') {
    // LampGlass: blendSource destColor, blendDest sourceColor = 2·src·dst
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.DstColorFactor;
    mat.blendDst = THREE.SrcColorFactor;
  } else if (def.blend === 'alpha') {
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.NormalBlending;
  }
  return mat;
}
