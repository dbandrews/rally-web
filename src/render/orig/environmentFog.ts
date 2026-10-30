/**
 * src/render/orig/environmentFog.ts — procedural content inside an original view (docs/ASSETS.md §10 gap 4):
 * the procedural car until the original one loads, stand-in terrain / road / scenery, skid marks and any other
 * three.js built-in material. Environment builder.
 *
 * One global material hook (installed once, a no-op while no original view is shown, so procedural stages
 * render exactly as before):
 *   * every shader that includes `<fog_fragment>` gets the ORIGINAL track fog while ORIG mode is on:
 *       f = clamp(max((end − z)/(end − start), (end − clampDist)/(end − start)), 0, 1);  rgb = mix(fogColor, rgb, f)
 *     with z = vFogDepth (view-space depth) and the values read BY IDENTITY from origUniforms.trackFog
 *     (environment.md §3.4; fogEnable 0 → no fog). Off: three's own fog code, unchanged.
 *   * built-in (non-ShaderMaterial) materials get an sRGB encode after `<colorspace_fragment>` while ORIG mode is
 *     on: the original view outputs gamma-space bytes (NoToneMapping + LinearSRGBColorSpace), under which
 *     three's linear-light built-ins would come out too dark; encoding them restores the brightness they have on
 *     procedural stages. Skipped for materials whose map is NoColorSpace (original textures drawn with a
 *     built-in material, e.g. a SpriteMaterial over an .rtex: those are raw gamma-space bytes already) and for
 *     `material.userData.origRaw = true`.
 * Materials that set their own `onBeforeCompile` keep it: the hook is chained after it (and the program cache key
 * keeps both sources). RawShaderMaterial is never touched.
 *
 * The renderer turns ORIG mode on with setOrigBuiltinMode(true) when it shows an original view (and maps the same
 * fog onto scene.fog so `vFogDepth` exists and hook-less shaders get a close linear stand-in).
 */
import * as THREE from 'three';
import { urlParam } from '../../core/assets';
import { origUniforms } from './common';

/** 1 while an original view is shown (shared by identity with every hooked material). */
export const origBuiltinMode = { value: 0 };

export function setOrigBuiltinMode(on: boolean): void {
  origBuiltinMode.value = on ? 1 : 0;
}

const DECL = /* glsl */ `
uniform float uOrigBiMode;
uniform float uOrigBiEncode;
uniform float uOrigBiFogEnabled;
uniform vec3 uOrigBiFogColor;
uniform float uOrigBiFogStart;
uniform float uOrigBiFogEnd;
uniform float uOrigBiFogClamp;
vec3 origBiOETF(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}
`;

const FOG_REPLACEMENT = /* glsl */ `
#ifdef USE_FOG
if (uOrigBiMode > 0.5) {
  if (uOrigBiFogEnabled > 0.5) {
    float origSpan = uOrigBiFogEnd - uOrigBiFogStart;
    if (abs(origSpan) < 1e-6) origSpan = 1e-6;
    float origF = clamp(max((uOrigBiFogEnd - vFogDepth) / origSpan, (uOrigBiFogEnd - uOrigBiFogClamp) / origSpan), 0.0, 1.0);
    gl_FragColor.rgb = mix(uOrigBiFogColor, gl_FragColor.rgb, origF);
  }
} else {
${THREE.ShaderChunk.fog_fragment}
}
#endif
`;

const ENCODE = /* glsl */ `
#include <colorspace_fragment>
if (uOrigBiMode > 0.5 && uOrigBiEncode > 0.5) gl_FragColor.rgb = origBiOETF(gl_FragColor.rgb);
`;

type ShaderLike = { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string };
type Hook = (this: THREE.Material, shader: ShaderLike, renderer: THREE.WebGLRenderer) => void;

function wantsEncode(m: THREE.Material): boolean {
  if (m.userData?.origRaw) return false;
  const map = (m as THREE.MeshBasicMaterial).map;
  if (map && map.colorSpace === THREE.NoColorSpace) return false;
  return true;
}

function origHook(this: THREE.Material, shader: ShaderLike): void {
  const m = this as THREE.Material & { isRawShaderMaterial?: boolean; isShaderMaterial?: boolean };
  if (m.isRawShaderMaterial) return;
  let fs = shader.fragmentShader;
  if (typeof fs !== 'string' || fs.startsWith('#version')) return;
  const hasFog = fs.includes('#include <fog_fragment>');
  const builtin = !m.isShaderMaterial;
  const hasCs = builtin && fs.includes('#include <colorspace_fragment>');
  if (!hasFog && !hasCs) return;
  const f = origUniforms.trackFog;
  const u = shader.uniforms;
  u.uOrigBiMode = origBuiltinMode;
  u.uOrigBiEncode = { value: builtin && wantsEncode(m) ? 1 : 0 };
  u.uOrigBiFogEnabled = f.enabled;
  u.uOrigBiFogColor = f.color;
  u.uOrigBiFogStart = f.start;
  u.uOrigBiFogEnd = f.end;
  u.uOrigBiFogClamp = f.clamp;
  if (hasFog) fs = fs.replace('#include <fog_fragment>', FOG_REPLACEMENT);
  if (hasCs) fs = fs.replace('#include <colorspace_fragment>', ENCODE);
  shader.fragmentShader = DECL + fs;
}

const HOOK_KEY = '|origEnvHook:1';
const USER_HOOK = Symbol('origUserOnBeforeCompile');
let installed = false;

/**
 * Install the hook on THREE.Material.prototype (idempotent). `material.onBeforeCompile = fn` keeps working: the
 * accessor stores fn and returns a wrapper that runs fn, then the hook (its toString — the default program
 * cache key — is fn's source + a tag, so materials with different user hooks never share a program).
 */
export function installOrigBuiltinHook(): void {
  if (installed) return;
  // `?orighook=0`: diagnostics only (A/B renders proving procedural stages are unchanged); original views then
  // show their procedural content with three's own fog and linear output
  if (urlParam('orighook') === '0') return;
  installed = true;
  const proto = THREE.Material.prototype as unknown as Record<string | symbol, unknown>;
  const wrappers = new WeakMap<Hook, Hook>();
  const userOf = new WeakMap<Hook, Hook | undefined>();
  const defaultSource = origHook.toString() + HOOK_KEY;
  const bare: Hook = function (this: THREE.Material, shader, renderer) {
    void renderer;
    origHook.call(this, shader);
  };
  bare.toString = () => defaultSource;
  userOf.set(bare, undefined);
  Object.defineProperty(proto, 'onBeforeCompile', {
    configurable: true,
    get(this: Record<symbol, Hook | undefined>): Hook {
      const user = this[USER_HOOK];
      if (!user) return bare;
      let w = wrappers.get(user);
      if (!w) {
        w = function (this: THREE.Material, shader, renderer) {
          user.call(this, shader, renderer);
          origHook.call(this, shader);
        };
        const src = user.toString() + HOOK_KEY;
        w.toString = () => src;
        wrappers.set(user, w);
        userOf.set(w, user);
      }
      return w;
    },
    set(this: Record<symbol, Hook | undefined>, fn: Hook | null | undefined) {
      // one of our own wrappers assigned back (copied from another material): store its user hook, never chain twice
      if (typeof fn === 'function' && userOf.has(fn)) this[USER_HOOK] = userOf.get(fn);
      else this[USER_HOOK] = typeof fn === 'function' ? fn : undefined;
    },
  });
}

/** True once installOrigBuiltinHook ran (tests / diagnostics). */
export function origBuiltinHookInstalled(): boolean {
  return installed;
}

// installed at import (before any material exists), so instance hooks assigned later are chained
installOrigBuiltinHook();
