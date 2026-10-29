/**
 * src/render/sky.ts — gradient sky dome with sun disc, plus a PMREM environment map generated from the
 * same sky (car paint, glass, ice and wet tarmac reflections). Render builder.
 *
 * Colours are the stage's sRGB hex values. The visible dome writes them straight to the framebuffer
 * (no tone mapping), exactly like THREE.Fog does, so distant fogged terrain meets the horizon seamlessly.
 * The environment-map variant converts to linear radiance instead.
 */
import * as THREE from 'three';
import type { EnvironmentPreset } from '../core/types';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w * 0.99999; // always at the far end of the depth range
}`;

const FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uFog;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uLinear;
uniform float uSunDisc;
uniform float uOvercast;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float t = pow(clamp(h, 0.0, 1.0), 0.5);
  vec3 col = mix(uHorizon, uTop, t);
  // haze band at the horizon blends into the fog colour
  col = mix(col, uFog, 1.0 - smoothstep(-0.01, 0.16, h));
  // below the horizon: fog for the visible dome, darker ground for reflections
  col = mix(col, mix(uFog, uGround, uLinear), smoothstep(0.0, -0.25, h));
  float c = max(dot(d, uSunDir), 0.0);
  float glow = pow(c, 48.0) * 0.45 + pow(c, 6.0) * 0.14;
  float disc = smoothstep(0.99935, 0.99965, c) * uSunDisc;
  col += uSunCol * (glow * (1.0 - 0.7 * uOvercast) + disc * 1.6 * (1.0 - uOvercast));
  if (uLinear > 0.5) {
    col = pow(max(col, vec3(0.0)), vec3(2.2)) * 1.0;
  } else {
    col = min(col, vec3(1.0));
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const srgbVec = (hex: number) => new THREE.Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);

function makeSkyMaterial(linear: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Vector3(0.36, 0.56, 0.84) },
      uHorizon: { value: new THREE.Vector3(0.79, 0.86, 0.94) },
      uFog: { value: new THREE.Vector3(0.79, 0.86, 0.94) },
      uGround: { value: new THREE.Vector3(0.3, 0.28, 0.24) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
      uSunCol: { value: new THREE.Vector3(1, 0.95, 0.85) },
      uLinear: { value: linear ? 1 : 0 },
      uSunDisc: { value: 1 },
      uOvercast: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
}

function applyEnv(mat: THREE.ShaderMaterial, env: EnvironmentPreset): void {
  const u = mat.uniforms;
  u.uTop.value.copy(srgbVec(env.skyTop));
  u.uHorizon.value.copy(srgbVec(env.skyHorizon));
  u.uFog.value.copy(srgbVec(env.fogColor));
  u.uGround.value.copy(srgbVec(env.ambientGround)).multiplyScalar(0.8);
  u.uSunDir.value.set(env.sunDir.x, env.sunDir.y, env.sunDir.z).normalize();
  const sc = srgbVec(env.sunColor);
  u.uSunCol.value.copy(sc);
  const overcast = env.weather === 'overcast' || env.weather === 'rain' || env.weather === 'snow' ? 1 : env.weather === 'dust' ? 0.5 : 0;
  u.uOvercast.value = overcast;
  u.uSunDisc.value = env.sunDir.y > -0.05 ? 1 : 0;
}

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = makeSkyMaterial(false);
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = true;
  }

  setEnvironment(env: EnvironmentPreset): void {
    applyEnv(this.mat, env);
  }

  /** Keep the dome centred on the camera (radius must stay inside camera.far). */
  follow(camera: THREE.PerspectiveCamera): void {
    this.mesh.position.copy(camera.position);
    const r = camera.far * 0.5;
    this.mesh.scale.setScalar(r);
  }

  /**
   * Prefiltered environment map of this sky (linear radiance) for PBR reflections. Returns the PMREM render
   * target: release it with `target.dispose()` (disposing only `target.texture` leaks the GPU texture, one per
   * stage load).
   */
  makeEnvMap(renderer: THREE.WebGLRenderer, env: EnvironmentPreset): THREE.WebGLRenderTarget | null {
    try {
      const scene = new THREE.Scene();
      const mat = makeSkyMaterial(true);
      applyEnv(mat, env);
      mat.uniforms.uSunDisc.value = 0; // a disc in the env map makes hot specks on the paint
      const m = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat);
      scene.add(m);
      const pm = new THREE.PMREMGenerator(renderer);
      const rt = pm.fromScene(scene, 0, 0.1, 100);
      pm.dispose();
      m.geometry.dispose();
      mat.dispose();
      return rt;
    } catch (e) {
      console.warn('sky: environment map unavailable', e);
      return null;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
