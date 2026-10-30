/**
 * src/render/orig/trackShaders.ts — GLSL3 ports of the original DX8 track shaders (Misc/shaders/Track/*.vs|.ps)
 * for the track component (track.ts). docs/orig/track.md §Shaders.
 *
 * Every program works on raw gamma-space values (textures NoColorSpace, no tone mapping, LinearSRGB output),
 * like the vs.1.1 / ps.1.1 originals. Spec: research/formats/quadmesh.md §4.3–4.5 (+ Verification),
 * environment.md §3.4 (fog), §3.7 (water); the pass setup / constants were re-read from the executable
 * (track subshader setup @0x6666d0–0x666e56, end pass @0x666e60, VS/PS constants @0x669050–0x6695c9,
 * half-vector cube FUN_00688ea0 via vtbl+0x4c @0x6682a0):
 *
 *   Mask (Mask4t.vs + MaskVP / Mask2xVP.ps)         r1 = lrp(t1, t2, t0); r0 = sat(2·r1·v0); r0 = sat(k·r0·t3)
 *   Single lit (TextureLightmap.vs + TextureVPLightmap(2x).ps)   r0 = sat(2·t0·v0); r0 = sat(k·r0·t3)
 *   Single (Texture.vs + TextureVP.ps; World.qm)    r0 = sat(2·t0·v0)
 *   fog (fixed function after the PS)               out = lerp(fogColor, r0, oFog)   (ORIG_FOG_PARS)
 *   SpecBump (2nd pass, SRCALPHA/ONE, ZWRITE off, ZBIAS 5, oFog = 1)
 *                                                   rgb = (N·H)⁴ · c0 · bump.a,  N = bump(uv0)_bx2
 *   Water (pass 1, opaque)                          rgb = N·L + bump.a · c1 · (N·H)⁴   (base texture unused)
 *   Water2 (pass 2, ONE/ONE, ZWRITE off, ZBIAS 5)   rgb = env(reflect(E, N)) · c2
 *
 * H is the renderer's half-vector cube (+0x21c, 64² per face, rebuilt when the bump light changes):
 * texel(d) = normalize(normalize(d) + Lb) packed as 127·h + 128, looked up with the world eye vector
 * E = eyePos − worldPos; computed analytically here (no 8-bit quantisation). Lb = the bump light
 * normalize(sun.x, sun.y·track.bumpHeight, sun.z); L = the sun (c14, packed into oD0 = L·0.5 + 0.5).
 * The bump volumes / normal maps hold SIM-space normals (G = up), the cubes are SIM-frame faces: the water
 * and bump maths therefore run in SIM space (three z negated).
 *
 * ps.1.1 saturates every arithmetic result (GeForce-class MaxPixelShaderValue 1; quadmesh.md §4.4 verifier
 * note): reproduced with clamp() after each original instruction that saturates.
 */
import { ORIG_FOG_PARS } from './common';

/** Which original program pair a material uses. */
export type TrackProgram = 'mask' | 'singleLit' | 'single' | 'specBump' | 'water' | 'water2';

/** The track pass's far plane (race +0x740 = the HotSpot / Track.viewDistance value): fragments beyond it are
 *  clipped like the D3D far plane (the camera's own far plane is larger: sky box, World pass). */
const FAR_CLIP = /* glsl */ `
uniform float uTrackFar;
in float vViewZ;
`;

/** Vertex stage shared by Mask / Single (Mask4t.vs, TextureLightmap.vs, Texture.vs): oPos, oFog, oD0, oT0..3. */
export function trackVertexShader(program: 'mask' | 'singleLit' | 'single', worldPass: boolean): string {
  const uvs = program === 'mask' ? ['uv0', 'uv1', 'uv2', 'uv3'] : program === 'singleLit' ? ['uv0', 'uv3'] : ['uv0'];
  return /* glsl */ `
precision highp float;
in vec3 position;
in vec4 color;
${uvs.map((u) => `in vec2 ${u};`).join('\n')}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
${worldPass ? 'uniform mat4 uPassProjection; // World pass: near 10 m, far 100 km (settings +0xc / +0x10)' : ''}
${ORIG_FOG_PARS}
out vec4 vColor;
${uvs.map((u) => `out vec2 v${u[0].toUpperCase()}${u.slice(1)};`).join('\n')}
out float vOrigFog;
out float vViewZ;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = ${worldPass ? 'uPassProjection' : 'projectionMatrix'} * mv;
  vViewZ = -mv.z;
  vOrigFog = origFogFactor(-mv.z);           // oFog = max(dp4(pos, c27), c26.x), clamped by the fog unit
  vColor = color;                             // oD0 = v5 (D3D colour interpolator)
  ${uvs.map((u) => `v${u[0].toUpperCase()}${u.slice(1)} = ${u};`).join('\n  ')}
}
`;
}

/** Mask (MaskVP / Mask2xVP), Single lit (TextureVPLightmap / 2x) and Single (TextureVP). */
export function trackFragmentShader(program: 'mask' | 'singleLit' | 'single', worldPass: boolean): string {
  const uvs = program === 'mask' ? ['vUv0', 'vUv1', 'vUv2', 'vUv3'] : program === 'singleLit' ? ['vUv0', 'vUv3'] : ['vUv0'];
  let body: string;
  if (program === 'mask') {
    body = /* glsl */ `
  vec4 t0 = texture(uBase1, vUv0);            // tex t0 ; bottom  (base1Tex, uv set 0)
  vec4 t1 = texture(uMask, vUv1);             // tex t1 ; mask    (maskTex, uv set 1)
  vec4 t2 = texture(uBase2, vUv2);            // tex t2 ; top     (base2Tex, uv set 2)
  vec4 t3 = texture(uLightmap, vUv3);         // tex t3 ; shadow  (Lightmaps/Track<patch>, CLAMP)
  vec4 r1 = mix(t0, t2, t1);                  // mov r0, t1 ; lrp r1, r0, t2, t0  (the mask weights base2)
  vec4 r0 = clamp(2.0 * r1 * vColor, 0.0, 1.0);          // mul_x2 r0, r1, v0
  r0 = clamp(uLmScale * r0 * t3, 0.0, 1.0);              // mul (MaskVP) | mul_x2 (Mask2xVP) r0, r0, t3`;
  } else if (program === 'singleLit') {
    body = /* glsl */ `
  vec4 r0 = clamp(2.0 * texture(uBase1, vUv0) * vColor, 0.0, 1.0);   // mul_x2 r0, t0, v0
  r0 = clamp(uLmScale * r0 * texture(uLightmap, vUv3), 0.0, 1.0);   // mul | mul_x2 r0, r0, t3`;
  } else {
    body = /* glsl */ `
  vec4 r0 = clamp(2.0 * texture(uBase1, vUv0) * vColor, 0.0, 1.0);   // TextureVP: mul_x2 r0, t0, v0`;
  }
  return /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uBase1;
${program === 'mask' ? 'uniform sampler2D uMask;\nuniform sampler2D uBase2;' : ''}
${program !== 'single' ? 'uniform sampler2D uLightmap;\nuniform float uLmScale;' : ''}
uniform vec3 uFogColor;
${worldPass ? 'in float vViewZ;' : FAR_CLIP}
in vec4 vColor;
${uvs.map((u) => `in vec2 ${u};`).join('\n')}
in float vOrigFog;
out vec4 outColor;
void main() {
  ${worldPass ? '' : 'if (vViewZ > uTrackFar) discard;'}
${body}
  outColor = vec4(mix(uFogColor, r0.rgb, vOrigFog), 1.0);   // fixed-function fog after the PS; opaque
}
`;
}

// ----------------------------------------------------------------------------------------------- SpecBump

/** SpecBump.vs: oPos, oT1 = uv0 (normal map), oT0 = eyePos − world (half-vector cube), oFog = 1. */
export const SPEC_BUMP_VS = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv0;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform float uSimZ;           // three → SIM: z · uSimZ (−1; +1 while the stage is served z-mirrored, track.ts)
out vec2 vUv0;
out vec3 vEyeSim;
out float vViewZ;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vViewZ = -mv.z;
  vec3 e = cameraPosition - (modelMatrix * vec4(position, 1.0)).xyz;    // sub oT0.xyz, EYE_POS, r0
  vEyeSim = vec3(e.x, e.y, uSimZ * e.z);
  vUv0 = uv0;
}
`;

/** SpecBump.ps: rgb = (N·H)⁴ · c0 · t1.a, a = 1 (blend SRCALPHA / ONE). */
export const SPEC_BUMP_FS = /* glsl */ `
precision highp float;
uniform sampler2D uBump;
uniform vec3 uSpecular;        // c0 = track.specularColor (FUN_0049a680 → vtbl+0x8c, renderer +0x60)
uniform vec3 uBumpLight;       // Lb (SIM): the half-vector cube's light (renderer +0x54)
${FAR_CLIP}
in vec2 vUv0;
in vec3 vEyeSim;
out vec4 outColor;
void main() {
  if (vViewZ > uTrackFar) discard;
  vec4 t1 = texture(uBump, vUv0);
  vec3 n = t1.rgb * 2.0 - 1.0;                                  // t1_bx2
  vec3 h = normalize(normalize(vEyeSim) + uBumpLight);          // tex t0: half-vector cube (FUN_00688ea0)
  float nh = clamp(dot(n, h), -1.0, 1.0);                       // dp3 r0.rgb, t1_bx2, t0_bx2
  nh = nh * nh;                                                 // mul r0.rgb, r0, r0
  nh = nh * nh;                                                 // mul r0.rgb, r0, r0
  vec3 r1 = clamp(uSpecular * t1.a, 0.0, 1.0);                  // mul r1.rgb, c0, t1.a
  outColor = vec4(clamp(nh * r1, 0.0, 1.0), 1.0);               // mul r0.rgb, r0, r1 ; mov r0.a, 1 − 0
}
`;

// ----------------------------------------------------------------------------------------------- water

/** Water.vs / Water2.vs: base / bump uvs from the world position (zx swizzle), eye vector, light in oD0. */
const WATER_VS_COMMON = /* glsl */ `
precision highp float;
in vec3 position;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform vec2 uTile;            // c16 = (1/BaseTile, 1/BumpTile)
uniform vec4 uScroll;          // c21 = (∫BaseScrollSpeed·baseDir, ∫BumpScrollSpeed·bumpDir)
uniform float uPhase;          // c15.x = bump volume animation phase
uniform float uSimZ;           // three → SIM: z · uSimZ
${ORIG_FOG_PARS}
out vec3 vBumpUvw;
out vec3 vEyeSim;
out float vOrigFog;
out float vViewZ;
`;

export const WATER_VS = /* glsl */ `${WATER_VS_COMMON}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vViewZ = -mv.z;
  vOrigFog = origFogFactor(-mv.z);
  vec3 w = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 ws = vec3(w.x, w.y, uSimZ * w.z);                 // world position, SIM frame
  // mad oT1.xy, r0.zx, c16.yy, c21.wz ; mov oT1.z, c15.x    (the base uv oT0 only feeds the unused alpha)
  vBumpUvw = vec3(ws.zx * uTile.y + uScroll.wz, uPhase);
  vec3 e = cameraPosition - w;                           // sub oT2, EYE_POS, r0
  vEyeSim = vec3(e.x, e.y, uSimZ * e.z);
}
`;

/** Water.ps: rgb = N·L + t1.a·c1·(N·H)⁴, a = 1; base texture t0 only in the alpha (0 → 1 − 0). */
export const WATER_FS = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uBump;
uniform vec3 uSun;             // c14 = the sun (SIM), packed as oD0 = L·0.5 + 0.5
uniform vec3 uBumpLight;       // Lb (SIM), the half-vector cube's light
uniform vec3 uWaterSpecular;   // c1 = Water.SpecularColor
uniform vec3 uFogColor;
uniform float uFogScale;       // 0.5 when the renderer has a Water.EnvTex (vtbl+0x3c @0x668230 halves FOGCOLOR)
${FAR_CLIP}
in vec3 vBumpUvw;
in vec3 vEyeSim;
in float vOrigFog;
out vec4 outColor;
void main() {
  if (vViewZ > uTrackFar) discard;
  vec4 t1 = texture(uBump, vBumpUvw);
  vec3 n = t1.rgb * 2.0 - 1.0;                                     // t1_bx2
  vec3 l = clamp(uSun * 0.5 + 0.5, 0.0, 1.0) * 2.0 - 1.0;           // v0_bx2 (oD0 is saturated)
  float nl = clamp(dot(n, l), -1.0, 1.0);                           // dp3 r0.rgb, t1_bx2, v0_bx2
  vec3 h = normalize(normalize(vEyeSim) + uBumpLight);              // tex t2: half-vector cube
  float nh = clamp(dot(n, h), -1.0, 1.0);                           // dp3 r1, t1_bx2, t2_bx2
  vec3 r1 = clamp(t1.a * uWaterSpecular, 0.0, 1.0);                 // mul r1.rgb, t1.a, c1
  float nh4 = nh * nh;                                              // + mul r1.a, r1, r1
  nh4 = nh4 * nh4;                                                  // mul r1.a, r1, r1
  vec3 rgb = clamp(r1 * nh4 + nl, 0.0, 1.0);                        // mad r0.rgb, r1, r1.a, r0
  outColor = vec4(mix(uFogColor * uFogScale, rgb, vOrigFog), 1.0);
}
`;

/** Water2.vs: bump uvw, normalised eye vector (texture space = identity, c17..c19). */
export const WATER2_VS = WATER_VS.replace('vEyeSim = vec3(e.x, e.y, uSimZ * e.z);', 'vEyeSim = normalize(vec3(e.x, e.y, uSimZ * e.z));   // dp3/rsq/mul: normalised per vertex');

/** Water2.ps: texm3x3pad ×2 + texm3x3vspec (reflect the eye vector about the bump normal), rgb = env·c2. */
export const WATER2_FS = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uBump;
uniform samplerCube uEnv;      // Water.EnvTex (renderer +0x134), SIM-frame faces
uniform float uEnvIntensity;   // c2 = Water.EnvIntensity
uniform vec3 uFogColor;
uniform float uFogScale;
${FAR_CLIP}
in vec3 vBumpUvw;
in vec3 vEyeSim;
in float vOrigFog;
out vec4 outColor;
void main() {
  if (vViewZ > uTrackFar) discard;
  vec3 n = texture(uBump, vBumpUvw).rgb * 2.0 - 1.0;                // t0_bx2 (texture space = SIM: identity)
  vec3 e = vEyeSim;
  vec3 r = 2.0 * dot(n, e) / max(dot(n, n), 1e-6) * n - e;          // texm3x3vspec: reflect E about N
  vec3 env = texture(uEnv, r).rgb;                                  // SIM direction = the cube's own frame
  vec3 rgb = clamp(env * uEnvIntensity, 0.0, 1.0);                  // mul r0.rgb, t3, c2
  outColor = vec4(mix(uFogColor * uFogScale, rgb, vOrigFog), 1.0); // blended ONE / ONE
}
`;
