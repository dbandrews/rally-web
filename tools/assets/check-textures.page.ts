// tools/assets/check-textures.page.ts — page side of tools/assets/check-textures.mjs (loaded by
// check-textures.html through the Vite dev server; not part of the game build).
//
// For every texId: upload through TextureStore twice — S3TC (compressed) and the JS DXT fallback — then read
// EVERY level back on the GPU with texelFetch into an RGBA8 target and compare both against the JS decode of
// the .rtex level (rtexLevelRGBA, itself fixture-tested against the verified numpy decoder). Volumes: every
// slice of every level (the hand-uploaded mips). Cubes: both paths sampled with textureLod at face-centre
// and off-centre directions == the corresponding 2-D face texture at the D3D/GL face-table (s, t).
import * as THREE from 'three';
import { fetchArrayBuffer, texturePath } from '../../src/core/assets';
import { RTEX_FLAG, parseRtex, rtexLevelRGBA, type RtexImage } from '../../src/render/orig/rtex';
import { TextureStore } from '../../src/render/orig/textures';

const VS = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';

interface Report {
  checked: number;
  levels: number;
  volumes: number;
  cubes: number;
  mismatches: string[];
  glErrors: number;
  s3tcExtension: boolean;
  ms: number;
}

export async function run(opts: { ids: string[]; cubes: string[][] }): Promise<Report> {
  const t0 = performance.now();
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const report: Report = { checked: 0, levels: 0, volumes: 0, cubes: 0, mismatches: [], glErrors: 0, s3tcExtension: renderer.extensions.has('WEBGL_compressed_texture_s3tc') };
  const stores = { s3tc: new TextureStore(renderer, { s3tc: true }), js: new TextureStore(renderer, { s3tc: false }) };
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  scene.add(quad);
  const mat2 = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: 'uniform sampler2D t; uniform int lod; void main() { gl_FragColor = texelFetch(t, ivec2(gl_FragCoord.xy), lod); }', uniforms: { t: { value: null }, lod: { value: 0 } } });
  const mat3 = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: 'uniform highp sampler3D t; uniform int lod; uniform int z; void main() { gl_FragColor = texelFetch(t, ivec3(ivec2(gl_FragCoord.xy), z), lod); }', uniforms: { t: { value: null }, lod: { value: 0 }, z: { value: 0 } } });
  const matCube = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: 'uniform samplerCube t; uniform vec3 dirs[12]; uniform float lod; void main() { gl_FragColor = textureLod(t, dirs[int(gl_FragCoord.x)], lod); }', uniforms: { t: { value: null }, dirs: { value: [] as THREE.Vector3[] }, lod: { value: 0 } } });
  const matFace = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: 'uniform sampler2D t; uniform vec2 st[2]; uniform float lod; void main() { gl_FragColor = textureLod(t, st[int(gl_FragCoord.x)], lod); }', uniforms: { t: { value: null }, st: { value: [] as THREE.Vector2[] }, lod: { value: 0 } } });

  const draw = (m: THREE.ShaderMaterial, w: number, h: number): Uint8Array => {
    const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace });
    quad.material = m;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    const out = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, out);
    renderer.setRenderTarget(null);
    rt.dispose();
    return out;
  };
  const diff = (a: Uint8Array, b: Uint8Array) => {
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
  };
  const glErr = () => {
    let e = gl.getError();
    while (e !== gl.NO_ERROR) {
      report.glErrors++;
      e = gl.getError();
    }
  };

  const images = new Map<string, RtexImage>();
  const image = async (id: string) => {
    let im = images.get(id);
    if (!im) images.set(id, (im = parseRtex(await fetchArrayBuffer(texturePath(id)))));
    return im;
  };

  for (const id of opts.ids) {
    const img = await image(id);
    report.checked++;
    for (const [path, store] of Object.entries(stores)) {
      if (img.flags & RTEX_FLAG.VOLUME) {
        const tex = await store.getVolume(id);
        mat3.uniforms.t.value = tex;
        img.levels.forEach((L, lv) => {
          const want = rtexLevelRGBA(img, lv);
          const slice = L.width * L.height * 4;
          for (let z = 0; z < L.depth; z++) {
            mat3.uniforms.lod.value = lv;
            mat3.uniforms.z.value = z;
            const got = draw(mat3, L.width, L.height);
            const d = diff(got, want.subarray(z * slice, (z + 1) * slice));
            if (d) report.mismatches.push(`${id} ${path} volume level ${lv} slice ${z}: ${d} bytes differ`);
          }
          report.levels++;
        });
        if (path === 'js') report.volumes++;
      } else {
        const tex = await store.get(id);
        mat2.uniforms.t.value = tex;
        img.levels.forEach((L, lv) => {
          mat2.uniforms.lod.value = lv;
          const d = diff(draw(mat2, L.width, L.height), rtexLevelRGBA(img, lv));
          if (d) report.mismatches.push(`${id} ${path} level ${lv} (${L.width}x${L.height}): ${d} bytes differ`);
          report.levels++;
        });
      }
      glErr();
    }
  }

  // cube maps: D3D/GL face table — (s, t) = (0.75, 0.25) off-centre directions and the face centres
  const off = [[1, 0.5, -0.5], [-1, 0.5, 0.5], [0.5, 1, -0.5], [0.5, -1, 0.5], [0.5, 0.5, 1], [-0.5, 0.5, -1]];
  const ctr = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const dirs = [...ctr, ...off].map((v) => new THREE.Vector3(...v));
  for (const faces of opts.cubes) {
    report.cubes++;
    const results: Uint8Array[] = [];
    for (const [path, store] of Object.entries(stores)) {
      const cube = await store.getCube(faces);
      const last = (await image(faces[0])).levels.length - 1;
      for (const lod of [0, last]) {
        matCube.uniforms.t.value = cube;
        matCube.uniforms.dirs.value = dirs;
        matCube.uniforms.lod.value = lod;
        const got = draw(matCube, 12, 1);
        results.push(got);
        if (lod !== 0) continue;
        for (let f = 0; f < 6; f++) {
          const face = await store.get(faces[f], { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
          matFace.uniforms.t.value = face;
          matFace.uniforms.st.value = [new THREE.Vector2(0.5, 0.5), new THREE.Vector2(0.75, 0.25)];
          matFace.uniforms.lod.value = 0;
          const ref = draw(matFace, 2, 1);
          const c = got.subarray(f * 4, f * 4 + 4), o = got.subarray((6 + f) * 4, (6 + f) * 4 + 4);
          const dc = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(c[k] - ref[k])));
          const dof = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(o[k] - ref[4 + k])));
          if (dc > 1 || dof > 1) report.mismatches.push(`cube ${faces[0]} ${path} face ${f}: centre Δ${dc}, off-centre Δ${dof} vs its 2-D face`);
        }
      }
      glErr();
    }
    if (diff(results[0], results[2]) || diff(results[1], results[3])) report.mismatches.push(`cube ${faces[0]}: S3TC and JS paths differ`);
  }
  stores.s3tc.dispose();
  stores.js.dispose();
  renderer.dispose();
  report.ms = Math.round(performance.now() - t0);
  return report;
}
