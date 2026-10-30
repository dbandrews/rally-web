/**
 * src/render/orig/objectsShaders.ts — GLSL of the original object passes (research/formats/standardmesh.md §5,
 * environment.md §3.5), for InstancedBufferGeometry with the per-instance attributes written by objects.ts:
 *
 *   iRow0..2  3x4 world matrix (THREE space), row i = (L[i][0], L[i][1], L[i][2], t[i])
 *   iTint     (colourQ.rgb, shadowFactor)      TreeMesh colour byte/255 (TFACTOR inst+0x4c), Object.geometry.shadowFactor
 *   iMisc.x   alpha = 1 − ObjectDrawer fade (TFACTOR alpha, inst+0x4f)
 *
 * StandardMesh (meshshader.vs + stage 0 MODULATE2X(TEXTURE, DIFFUSE), §5.1):
 *   λ = max(dot(n, −L), 0)·(1 − shadowFactor);  d = sat(SHADOW·(1 − λ) + LIGHT·λ)
 *   LIGHT = game.lightColor ⊙ template.lightColor, SHADOW = game.shadowColor ⊙ template.shadowColor, both 0.5 when the
 *   template has `lighting 0` (FUN_00580160 c12/c13);  rgb = sat(2·tex·d), a = tex.a·TF.a, alpha test GREATER 0.
 * TreeMesh (tree pass @0x572f80: stage 0 MODULATE2X(TEXTURE, TFACTOR), stage 1 MODULATE2X(DIFFUSE, CURRENT), §5.2):
 *   rgb = sat(2·d·sat(2·tex·TF)), a = tex.a·TF.a;  lit trees: TF.rgb = colour byte, d per vertex like §5.1 (trunk.vs)
 *   or the shadow sphere (Sprite.vs, §5.3);  `lighting 0` trees: d = 0.5 and TF = FUN_00591950 (CPU colour):
 *   sat(lerp(S, L, (1 − shadowFactor)·f)·2·colour) quantised to bytes, f = billboardLightScale | constantLightScale.
 * Alpha test GREATER 0 on every object pass: the StandardMesh colour pass (sub_584320 main branch), the tree pass
 * (0x572f80) and the impostor pass (FUN_00573530) enable the test without setting ALPHAREF, so the value restored from
 * the render-state stack is the device-init 0 (FUN_00683be0 @0x684006 / frame+0x450 = 0). The only 0x7F writers
 * (0x4bb8b0 from the StandardMesh depth-only branch 0x5846ef and the second tree pass 0x573396; 0x54ca82) each sit in
 * their own pushed frame (0x685d40 … 0x685d80), which the restore (0x685df0) undoes. Soft alpha edges therefore blend
 * (or, on an opaque StandardMesh, draw opaque), and fading instances fade smoothly down to alpha byte 1.
 * Impostors (Tree/Billboard.vs/.ps, FUN_00573530): camera-yawed quads, rgb = sat(2·lrp(t, frameA, frameB)·TF),
 * TF = FUN_00591950 with billboardLightScale (createBillboardMaterial below).
 * Fog: the track fog (ORIG_FOG_PARS, per vertex).
 */
import * as THREE from 'three';
import { fogUniformMap, ORIG_FOG_PARS, type OrigSharedUniforms } from './common';

export type ObjPass = 'mesh' | 'trunk' | 'branches' | 'facing' | 'sprites';

const INSTANCE_PARS = /* glsl */ `
attribute vec4 iRow0;
attribute vec4 iRow1;
attribute vec4 iRow2;
attribute vec4 iTint;
attribute vec4 iMisc;
vec3 instPos(vec3 p) { vec4 q = vec4(p, 1.0); return vec3(dot(iRow0, q), dot(iRow1, q), dot(iRow2, q)); }
vec3 instDir(vec3 n) { return vec3(dot(iRow0.xyz, n), dot(iRow1.xyz, n), dot(iRow2.xyz, n)); }
vec3 instScale() {
  return vec3(length(vec3(iRow0.x, iRow1.x, iRow2.x)), length(vec3(iRow0.y, iRow1.y, iRow2.y)), length(vec3(iRow0.z, iRow1.z, iRow2.z)));
}
vec3 safeNormalize(vec3 v) { float l = length(v); return l > 1e-8 ? v / l : vec3(0.0); }
`;

const VERTEX = /* glsl */ `
${ORIG_FOG_PARS}
${INSTANCE_PARS}
attribute vec2 spriteOffset;
uniform vec3 uSunDir;
uniform vec3 uLight;
uniform vec3 uShadow;
uniform vec3 uLightMul;
uniform vec3 uShadowMul;
uniform float uLighting;
uniform float uLightScale;
uniform vec3 uFaceX;
uniform vec3 uFaceZ;
uniform vec3 uCrownCenter;
uniform float uCrownRadius;
uniform float uGradiant;
varying vec2 vUv;
varying vec3 vD;
varying vec3 vTF;
varying float vAlpha;
varying float vOrigFog;

void main() {
  vec3 L = uLighting > 0.5 ? uLight * uLightMul : vec3(0.5);
  vec3 S = uLighting > 0.5 ? uShadow * uShadowMul : vec3(0.5);
  float invShadow = 1.0 - iTint.w;
#if defined(PASS_FACING)
  // FUN_005908d0: the instance rotation is replaced by a yaw from the camera (local +z = camera forward,
  // local +x = -camera right); the instance scale survives.
  vec3 sc = instScale();
  vec3 wp = vec3(iRow0.w, iRow1.w, iRow2.w) + uFaceX * (position.x * sc.x) + vec3(0.0, position.y * sc.y, 0.0) + uFaceZ * (position.z * sc.z);
  vec3 nw = uFaceX * normal.x + vec3(0.0, normal.y, 0.0) + uFaceZ * normal.z;
#else
  vec3 wp = instPos(position);
  vec3 nw = instDir(normal);
#endif
  vec4 mv = viewMatrix * (modelMatrix * vec4(wp, 1.0));
#if defined(PASS_SPRITES)
  // Sprite.vs: camera-facing expansion in view space by the instance scale (c21 = scale.xyz)
  vec3 ssc = instScale();
  mv.xy += spriteOffset * ssc.xy;
  // shadow sphere (FUN_005916b0): P1 on the sun side of the crown, s = (1 - |pos - P1| / |2B|)·invShadow
  mat3 M = mat3(iRow0.x, iRow1.x, iRow2.x, iRow0.y, iRow1.y, iRow2.y, iRow0.z, iRow1.z, iRow2.z);
  vec3 toSun = safeNormalize(inverse(M) * uSunDir);
  float b = uCrownRadius * uGradiant;
  vec3 P1 = uCrownCenter + toSun * b;
  float lam = b > 1e-6 ? (1.0 - length(position - P1) / (2.0 * b)) * invShadow : invShadow;
#else
  vec3 n = safeNormalize(mat3(modelMatrix) * nw);
  float lam = max(dot(n, uSunDir), 0.0) * invShadow;
#endif
  vD = clamp(S * (1.0 - lam) + L * lam, 0.0, 1.0);
#if defined(TREE)
  if (uLighting > 0.5) {
    vTF = iTint.rgb;
  } else {
    vec3 Lc = uLight * uLightMul;
    vec3 Sc = uShadow * uShadowMul;
    vec3 c = Sc + (Lc - Sc) * (invShadow * uLightScale);
    vTF = floor(clamp(c * 2.0 * iTint.rgb, 0.0, 1.0) * 255.0) / 255.0;
  }
#else
  vTF = vec3(1.0);
#endif
  vUv = uv;
  vAlpha = iMisc.x;
  gl_Position = projectionMatrix * mv;
  vOrigFog = origFogFactor(-mv.z);
}
`;

const FRAGMENT = /* glsl */ `
${ORIG_FOG_PARS}
uniform sampler2D map;
uniform float uBlendAlways;
varying vec2 vUv;
varying vec3 vD;
varying vec3 vTF;
varying float vAlpha;
varying float vOrigFog;

void main() {
#if defined(HAS_MAP)
  vec4 t = texture2D(map, vUv);
#else
  vec4 t = vec4(1.0);
#endif
  float a = t.a * vAlpha;
  if (a * 255.0 <= ALPHA_REF + 0.5) discard;     // ALPHAFUNC GREATER, ALPHAREF 0 (leaf core sub-pass: 0x7F)
#if defined(ALPHA_MAX)
  if (a * 255.0 > ALPHA_MAX + 0.5) discard;      // leaf soft-edge sub-pass: only what the depth-writing core left
#endif
#if defined(TREE)
  vec3 rgb = clamp(2.0 * vD * clamp(2.0 * t.rgb * vTF, 0.0, 1.0), 0.0, 1.0);
#else
  vec3 rgb = clamp(2.0 * t.rgb * vD, 0.0, 1.0);
#endif
  rgb = mix(uFogColor, rgb, vOrigFog);
  // opaque passes blend only while the instance fades (ALPHABLENDENABLE forced on, DAT_00911899)
  gl_FragColor = vec4(rgb, (uBlendAlways > 0.5 || vAlpha < 1.0) ? a : 1.0);
}
`;

// ------------------------------------------------------------------------------------------------ impostors

/**
 * Billboard impostors (Tree/Billboard.vs + Billboard.ps, quads built by FUN_00573530). Per instance (iB*):
 *   iB0 = (base.xyz, halfWidth·sx)   base = tree position + (0, bbox.min.y·sy, 0) (unrotated world-y offset)
 *   iB1 = (up.xyz, i0)               up = world local +y · sy·(bbox.max.y − bbox.min.y)
 *   iB2 = (t, alpha, shadowFactor, -)  t = weight of frame i0 (byte), alpha = w·(1 − fade) (byte)
 *   iB3 = (colourQ.rgb, -)
 * position.xy = corner (cx, cy): cx = −1 at base − R, +1 at base + R (R = halfWidth·uFaceX, the facing yaw of the
 * Kuliss pass); cy = 0 bottom, 1 top (three draws a non-indexed geometry with position.count vertices). Texture coordinates (WRAP in u): frame i spans [i/n, (i+1)/n]; the −R side samples the frame's
 * right edge: uvA.u = (i0 + (cx < 0 ? 1 : 0))/n, uvB = uvA + 1/n, v = 1 − cy.
 * pixel = lrp(t, texA, texB); rgb = sat(2·pixel·TF), a = pixel.a·alpha (alpha test GREATER 0, blend, no z-write)
 * TF = FUN_00591950 with f = billboardLightScale (billboard templates), quantised to bytes.
 */
const BILLBOARD_VERTEX = /* glsl */ `
${ORIG_FOG_PARS}
attribute vec4 iB0;
attribute vec4 iB1;
attribute vec4 iB2;
attribute vec4 iB3;
uniform vec3 uFaceX;
uniform vec3 uLight;
uniform vec3 uShadow;
uniform vec3 uLightMul;
uniform vec3 uShadowMul;
uniform float uLightScale;
uniform float uFrames;
varying vec2 vUvA;
varying vec2 vUvB;
varying vec3 vTF;
varying float vT;
varying float vAlpha;
varying float vOrigFog;

void main() {
  vec2 corner = position.xy;
  vec3 wp = iB0.xyz + uFaceX * (corner.x * iB0.w) + iB1.xyz * corner.y;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float ua = (iB1.w + (corner.x < 0.0 ? 1.0 : 0.0)) / uFrames;
  vUvA = vec2(ua, 1.0 - corner.y);
  vUvB = vec2(ua + 1.0 / uFrames, 1.0 - corner.y);
  vec3 Lc = uLight * uLightMul;
  vec3 Sc = uShadow * uShadowMul;
  vec3 c = Sc + (Lc - Sc) * ((1.0 - iB2.z) * uLightScale);
  vTF = floor(clamp(c * 2.0 * iB3.rgb, 0.0, 1.0) * 255.0) / 255.0;
  vT = iB2.x;
  vAlpha = iB2.y;
  gl_Position = projectionMatrix * mv;
  vOrigFog = origFogFactor(-mv.z);
}
`;

const BILLBOARD_FRAGMENT = /* glsl */ `
${ORIG_FOG_PARS}
uniform sampler2D map;
varying vec2 vUvA;
varying vec2 vUvB;
varying vec3 vTF;
varying float vT;
varying float vAlpha;
varying float vOrigFog;

void main() {
  vec4 r = mix(texture2D(map, vUvB), texture2D(map, vUvA), vT);
  float a = r.a * vAlpha;
  if (a * 255.0 <= 0.5) discard;                 // ALPHAFUNC GREATER, ALPHAREF 0 (the device default; FUN_00573530 sets no ref)
  vec3 rgb = clamp(2.0 * r.rgb * vTF, 0.0, 1.0);
  rgb = mix(uFogColor, rgb, vOrigFog);
  gl_FragColor = vec4(rgb, a);
}
`;

export interface BillboardMaterialOptions {
  map: THREE.Texture;
  uniforms: OrigSharedUniforms;
  lightMul: readonly number[];
  shadowMul: readonly number[];
  /** treeMesh.billboardLightScale (FUN_00591950 f for billboard templates). */
  lightScale: number;
  /** Atlas frame count n (billboardResolution third value). */
  frames: number;
  faceX: { value: THREE.Vector3 };
}

/** Impostor pass state (FUN_00573530): CULLMODE NONE, ZWRITE 0, SRCALPHA/INVSRCALPHA, alpha test on. */
export function createBillboardMaterial(o: BillboardMaterialOptions): THREE.ShaderMaterial {
  const u = o.uniforms;
  return new THREE.ShaderMaterial({
    name: 'orig-objects:billboard',
    uniforms: {
      ...fogUniformMap(u.trackFog),
      map: { value: o.map },
      uLight: u.objectLight,
      uShadow: u.objectShadow,
      uLightMul: { value: new THREE.Vector3(o.lightMul[0], o.lightMul[1], o.lightMul[2]) },
      uShadowMul: { value: new THREE.Vector3(o.shadowMul[0], o.shadowMul[1], o.shadowMul[2]) },
      uLightScale: { value: o.lightScale },
      uFrames: { value: o.frames },
      uFaceX: o.faceX,
    },
    vertexShader: BILLBOARD_VERTEX,
    fragmentShader: BILLBOARD_FRAGMENT,
    side: THREE.DoubleSide,
    transparent: true,
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: false,
  });
}

export interface ObjMaterialOptions {
  pass: ObjPass;
  map: THREE.Texture | null;
  uniforms: OrigSharedUniforms;
  lighting: boolean;
  lightMul: readonly number[];
  shadowMul: readonly number[];
  /** FUN_00591950 f: billboardLightScale (billboard trees) or constantLightScale. */
  lightScale?: number;
  /** StandardMesh `.rs` flags. */
  transparent?: boolean;
  twosided?: boolean;
  /** Shared per-view uniform objects for the facing pass (camera yaw). */
  faceX?: { value: THREE.Vector3 };
  faceZ?: { value: THREE.Vector3 };
  crownCenter?: readonly number[];
  crownRadius?: number;
  gradiantFactor?: number;
  /**
   * Leaf passes (branches / facing / sprites) only: which half of the alpha-tested area this material draws. The
   * original draws leaves alpha-tested GREATER 0 with ZWRITE 0, one tree at a time far → near; instanced batches cannot
   * keep that global order, so this port splits them: 'core' (alpha > 0x7F) writes depth, 'soft' (0 < alpha ≤ 0x7F)
   * blends after every core without writing depth (docs/orig/objects.md, deviation 1).
   */
  edge?: 'core' | 'soft';
}

/** ALPHAREF of an object pass: 0 for all of them (the device-init value; see the header). */
export function objAlphaRef(_pass: ObjPass): number {
  return 0;
}

/**
 * One material per (pass, texture, template light settings). Blending SRCALPHA/INVSRCALPHA everywhere: opaque passes
 * write alpha 1 unless the instance fades (the original forces ALPHABLENDENABLE on while inst alpha != 255,
 * DAT_00911899), so every material sits in three's blended (transparent) list and objects.ts orders the passes with
 * renderOrder like the original: StandardMesh, impostors, then the 3D trees (trunk, branches, facing, sprites).
 * Trees: culling off (CULLMODE NONE @0x5731e6). Leaves: see `edge` (the original's ZWRITE 0 relies on per-tree draw
 * order, which instanced batches cannot keep; docs/orig/objects.md).
 */
export function createObjMaterial(o: ObjMaterialOptions): THREE.ShaderMaterial {
  const tree = o.pass !== 'mesh';
  const defines: Record<string, string> = {};
  if (tree) defines.TREE = '';
  if (o.map) defines.HAS_MAP = '';
  if (o.pass === 'facing') defines.PASS_FACING = '';
  if (o.pass === 'sprites') defines.PASS_SPRITES = '';
  const leaves = o.pass === 'branches' || o.pass === 'facing' || o.pass === 'sprites';
  const transparent = leaves || (o.pass === 'mesh' && o.transparent === true);
  const soft = leaves && o.edge === 'soft';
  // core leaves keep only what passes 0x7F (they write depth); soft leaves the rest of the GREATER-0 area
  defines.ALPHA_REF = (leaves && o.edge === 'core' ? 0x7f : objAlphaRef(o.pass)).toFixed(1);
  if (soft) defines.ALPHA_MAX = (0x7f).toFixed(1);
  const u = o.uniforms;
  const m = new THREE.ShaderMaterial({
    name: `orig-objects:${o.pass}${leaves && o.edge ? `:${o.edge}` : ''}`,
    defines,
    uniforms: {
      ...fogUniformMap(u.trackFog),
      map: { value: o.map },
      uSunDir: u.sunDir,
      uLight: u.objectLight,
      uShadow: u.objectShadow,
      uLightMul: { value: new THREE.Vector3(o.lightMul[0], o.lightMul[1], o.lightMul[2]) },
      uShadowMul: { value: new THREE.Vector3(o.shadowMul[0], o.shadowMul[1], o.shadowMul[2]) },
      uLighting: { value: o.lighting ? 1 : 0 },
      uLightScale: { value: o.lightScale ?? 0.5 },
      uFaceX: o.faceX ?? { value: new THREE.Vector3(1, 0, 0) },
      uFaceZ: o.faceZ ?? { value: new THREE.Vector3(0, 0, 1) },
      uCrownCenter: { value: new THREE.Vector3(...((o.crownCenter ?? [0, 0, 0]) as [number, number, number])) },
      uCrownRadius: { value: o.crownRadius ?? 0 },
      uGradiant: { value: o.gradiantFactor ?? 0.5 },
      uBlendAlways: { value: transparent ? 1 : 0 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: tree || o.twosided ? THREE.DoubleSide : THREE.FrontSide,
    // blended list even for opaque passes (alpha 1 unless fading), see above
    transparent: true,
    blending: THREE.NormalBlending,
    depthTest: true,
    // StandardMesh `transparent` materials: ZWRITE off (sub_5838a0); soft leaf edges never write depth; the rest does
    depthWrite: !(o.pass === 'mesh' && o.transparent === true) && !soft,
  });
  return m;
}
