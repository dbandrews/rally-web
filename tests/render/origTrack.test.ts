// tests/render/origTrack.test.ts — the track part (tools/assets/parts/track.py + src/render/orig/track*.ts).
//
// Pure maths always (view-distance regulator, bump light, water animation, height grid, stage frame fit, shader
// sources). Real data when the packs are built (`npm run assets -- --parts track --stages all`): every stage's
// patch / vertex / triangle counts equal the verified parser fmt_quadmesh (QM_REF below, generated straight from
// tools/assets/lib/formats/fmt_quadmesh.py — independent of parts/track.py), the binary is consistent (groups tile
// the index buffer, indices in range, bounds hold every vertex), every texId resolves to a valid .rtex, lightmaps
// are P8 through the stage's Track.pal (when .cache/original is present), and the runtime loader builds, culls
// and samples a real stage.
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _setAssetFetchForTests, fetchArrayBuffer, fetchJson, stageArchive, stageLevelPath, stagePartPath } from '../../src/core/assets';
import { createOrigUniforms, type OrigLoadContext } from '../../src/render/orig/common';
import { RTEX_FORMAT, parseRtex } from '../../src/render/orig/rtex';
import type { TextureScope } from '../../src/render/orig/textures';
import { loadTrack, stageFrameFit, trackStats, WORLD_RENDER_ORDER } from '../../src/render/orig/track';
import {
  bumpLightDir,
  maxTrackViewDistance,
  meshArrays,
  TrackHeightGrid,
  trackViewDistance,
  validateTrackJson,
  waterAnimation,
  type TrackJson,
  type TrackSettingsJson,
  type TrackWaterJson,
} from '../../src/render/orig/trackData';
import { SPEC_BUMP_FS, WATER2_FS, WATER2_VS, WATER_FS, WATER_VS, trackFragmentShader, trackVertexShader } from '../../src/render/orig/trackShaders';
import { buildStage } from '../../src/world/stages';
import { BUILT_ASSETS_DIR, builtAssetsPresent, useBuiltAssets } from '../assets/builtAssetFetch';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
  readdirSync(p: string): string[];
}
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as Fs;

const ORIG = '.cache/original';

/** [patches, vertices, triangles (strips expanded, degenerates dropped)] per .qm, from fmt_quadmesh.parse. */
const QM_REF: Record<string, Partial<Record<'track' | 'world' | 'water', [number, number, number]>>> = {
  'corsica-1-f': { track: [182, 89268, 79210], world: [4, 7075, 13514], water: [1, 2361, 4369] },
  'corsica-1-r': { track: [182, 89268, 79210], world: [4, 7075, 13514], water: [1, 2361, 4369] },
  'corsica-2-f': { track: [71, 105264, 99780], world: [4, 7075, 13514] },
  'corsica-2-r': { track: [83, 105176, 99986], world: [4, 7075, 13514] },
  'corsica-3-f': { track: [79, 61004, 53320], world: [1, 1939, 3622], water: [1, 847, 1515] },
  'corsica-3-r': { track: [126, 65026, 58114], world: [1, 1939, 3622], water: [1, 997, 1711] },
  'hillclimb-1a-f': { track: [263, 49576, 62146], world: [1, 1939, 3622] },
  'hillclimb-1a-r': { track: [263, 49576, 62146], world: [1, 1939, 3622] },
  'hillclimb-1b-f': { track: [90, 42327, 42235], world: [1, 1939, 3622] },
  'hillclimb-1b-r': { track: [90, 42327, 42235], world: [1, 1939, 3622] },
  'hillclimb-1c-f': { track: [88, 64202, 75952], world: [1, 1939, 3622] },
  'hillclimb-1c-r': { track: [91, 64215, 75952], world: [1, 1939, 3622] },
  'hillclimb-2a-f': { track: [136, 58355, 74270], world: [1, 2079, 3998] },
  'hillclimb-2a-r': { track: [136, 58355, 74270], world: [1, 2079, 3998] },
  'hillclimb-2b-f': { track: [181, 47355, 57096], world: [1, 29997, 9999] },
  'hillclimb-2b-r': { track: [181, 47355, 57096], world: [1, 29997, 9999] },
  'hillclimb-2c-f': { track: [99, 38363, 43606], world: [1, 29997, 9999] },
  'hillclimb-2c-r': { track: [99, 38363, 43606], world: [1, 29997, 9999] },
  'hillclimb-3a-f': { track: [64, 53360, 70397], world: [1, 2079, 3998], water: [1, 1171, 2065] },
  'hillclimb-3a-r': { track: [139, 54664, 70397], world: [1, 2079, 3998], water: [1, 1171, 2065] },
  'hillclimb-3b-f': { track: [99, 49563, 51249], world: [1, 4096, 2048], water: [1, 1171, 2065] },
  'hillclimb-3b-r': { track: [100, 49578, 51257], world: [1, 4096, 2048], water: [1, 1171, 2065] },
  'hillclimb-3c-f': { track: [73, 48892, 54509], world: [1, 4096, 2048] },
  'hillclimb-3c-r': { track: [73, 48892, 54509], world: [1, 4096, 2048] },
  'iceracing-1-f': { track: [40, 34027, 40072], world: [1, 1596, 2893] },
  'iceracing-1-r': { track: [40, 34027, 40072], world: [1, 1596, 2893] },
  'iceracing-2-f': { track: [46, 26984, 25596], world: [4, 5516, 10033] },
  'iceracing-2-r': { track: [46, 26984, 25596], world: [4, 5516, 10033] },
  'iceracing-3-f': { track: [40, 20955, 19950], world: [4, 5516, 10033] },
  'iceracing-3-r': { track: [40, 20955, 19950], world: [4, 5516, 10033] },
  'kenya-1-f': { track: [187, 53058, 66044], world: [1, 808, 1518], water: [1, 240, 390] },
  'kenya-1-r': { track: [178, 52017, 65124], world: [1, 808, 1518], water: [1, 240, 390] },
  'kenya-2-f': { track: [73, 90058, 87251], world: [1, 808, 1518] },
  'kenya-2-r': { track: [73, 80399, 74434], world: [1, 808, 1518] },
  'kenya-3-f': { track: [160, 60673, 78623], world: [1, 808, 1518] },
  'kenya-3-r': { track: [160, 60673, 78623], world: [1, 808, 1518] },
  'newzealand-1-f': { track: [57, 55749, 50820], world: [1, 626, 1077] },
  'newzealand-1-r': { track: [62, 66019, 66094], world: [1, 626, 1077] },
  'newzealand-2-f': { track: [99, 89695, 77168], world: [1, 626, 1077], water: [1, 1248, 2285] },
  'newzealand-2-r': { track: [70, 71280, 59345], world: [1, 626, 1077], water: [1, 1813, 3344] },
  'newzealand-3-f': { track: [60, 74955, 65499], world: [1, 1045, 1966] },
  'newzealand-3-r': { track: [82, 73394, 64223], world: [1, 1045, 1966] },
  'rallycross-1-f': { track: [57, 34194, 32076], water: [1, 1494, 2532] },
  'rallycross-1-r': { track: [57, 34194, 32076], water: [1, 1494, 2532] },
  'rallycross-2-f': { track: [10, 18215, 22590] },
  'rallycross-2-r': { track: [10, 18215, 22590] },
  'rallycross-3-f': { track: [34, 21253, 19552] },
  'rallycross-3-r': { track: [41, 21377, 19552] },
};
const STAGES = Object.keys(QM_REF);

const SETTINGS: TrackSettingsJson = {
  viewDistance: 1000,
  hotspots: {
    enabled: true,
    global: { name: 'Global', trackViewDistance: 1200 },
    spots: [
      { name: 'far', splineDistance: 1000, width: 100, fade: 0.5, trackViewDistance: 2000 },
      { name: 'near', splineDistance: 1050, width: 100, fade: 0.5, trackViewDistance: 600 },
      { name: 'unset', splineDistance: 1000, width: 300, fade: 0.5, trackViewDistance: 0 },
    ],
  },
  bumpEnable: true,
  bumpHeight: 1,
  specularColor: [1, 0.5, 0.5],
  drawWorld: true,
  passes: { worldNear: 10, worldFar: 100000, trackNear: 0.1 },
};

// ------------------------------------------------------------------------------------------------ pure maths

describe('track maths (pure)', () => {
  it('trackViewDistance = the HotSpot regulator FUN_004e1240 (Global + strongest +/- spot deltas)', () => {
    // outside every window: the Global value
    expect(trackViewDistance(SETTINGS, 5000)).toBe(1200);
    // s = 1000: 'far' at its centre (t = 0 → +800); 'near' d = 50 ≤ (1−0.5)·100 → t = 0 → −600
    expect(trackViewDistance(SETTINGS, 1000)).toBeCloseTo(1200 + 800 - 600, 9);
    // s = 925: 'far' d = 75 → t = (75 − 50)/50 = 0.5 → +400; 'near' d = 125 > width → no effect
    expect(trackViewDistance(SETTINGS, 925)).toBeCloseTo(1600, 9);
    // |s − sd| ≤ width is inclusive: d = 100 → t = 1 → delta 0
    expect(trackViewDistance(SETTINGS, 900)).toBeCloseTo(1200, 9);
    // regulator off → Track.viewDistance
    expect(trackViewDistance({ ...SETTINGS, hotspots: { ...SETTINGS.hotspots, enabled: false } }, 1000)).toBe(1000);
    expect(maxTrackViewDistance(SETTINGS)).toBe(2000);
  });

  it('bump light = normalize(sun.x, sun.y·track.bumpHeight, sun.z) (FUN_0049a680 → vtbl+0x4c)', () => {
    const l = bumpLightDir([0, 0.6, 0.8], 0.5);
    expect(Math.hypot(...l)).toBeCloseTo(1, 12);
    expect(l[1] / l[2]).toBeCloseTo(0.3 / 0.8, 12);
    expect(bumpLightDir([0, 0, 0], 1)).toEqual([0, 0, 0]);
  });

  it('water animation = the constant setup @0x669225–0x66936d (scroll integrals, wrapped volume phase)', () => {
    const w: TrackWaterJson = {
      baseTile: 10, baseScrollSpeed: 0.3, baseScrollDirection: [3, 4], bumpTile: 6, bumpScrollSpeed: 0.5,
      bumpScrollDirection: [0, 2], animationSpeed: 10, envIntensity: 0.4, specularColor: [1, 1, 1],
      baseTex: null, bumpTex: null, bumpDepth: 8, envTex: null,
    };
    const a = waterAnimation(w, 2);
    expect(a.baseScroll[0]).toBeCloseTo(0.6 * 0.6, 12);
    expect(a.baseScroll[1]).toBeCloseTo(0.6 * 0.8, 12);
    expect(a.bumpScroll).toEqual([0, 1]);
    expect(a.phase).toBeCloseTo((10 * 2) / 8 - 2, 12);
    // both speeds 0: no scrolling; a one-slice bump volume never animates
    expect(waterAnimation({ ...w, baseScrollSpeed: 0, bumpScrollSpeed: 0 }, 5).baseScroll).toEqual([0, 0]);
    expect(waterAnimation({ ...w, bumpDepth: 1 }, 3).phase).toBe(0);
  });

  it('TrackHeightGrid: the highest up-facing triangle, NaN off the mesh', () => {
    // two stacked quads (CCW from above in three = front faces +y) and one down-facing triangle on top
    const v = new Float32Array([
      0, 0, 0, 10, 0, 0, 10, 0, -10, 0, 0, -10, // y 0
      0, 5, 0, 10, 5, 0, 10, 5, -10, 0, 5, -10, // y 5
      0, 9, 0, 10, 9, -10, 10, 9, 0, // y 9, clockwise from above = back face
    ]);
    const ix = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10]);
    const g = new TrackHeightGrid([{ arrays: { vertices: v, colors: new Uint8Array(0), indices: ix }, stride: 3, ranges: [{ start: 0, count: 15 }] }], 4);
    expect(g.triangleCount).toBe(4);
    expect(g.heightAt(5, -5)).toBeCloseTo(5, 6);
    expect(g.heightAt(9.9, -0.1)).toBeCloseTo(5, 6);
    expect(Number.isNaN(g.heightAt(15, -5))).toBe(true);
    expect(Number.isNaN(g.heightAt(5, 5))).toBe(true);
  });

  it('stageFrameFit picks the frame the road lies on (contract frame vs z-mirrored)', () => {
    const road = Array.from({ length: 40 }, (_, i) => ({ s: i * 10, pos: { x: i * 10, y: 0.2 * i, z: -50 - i } }));
    const stage = { road, closed: false, startS: 0, finishS: 400 } as unknown as Parameters<typeof stageFrameFit>[0];
    const onContract = { heightAt: (x: number, z: number) => (z < 0 ? 0.02 * x : NaN) };
    const onMirror = { heightAt: (x: number, z: number) => (z > 0 ? 0.02 * x : NaN) };
    expect(stageFrameFit(stage, onContract).mirrorZ).toBe(false);
    expect(stageFrameFit(stage, onContract).sim).toBe(1);
    const m = stageFrameFit(stage, onMirror);
    expect(m.mirrorZ).toBe(true);
    expect(m.mirrored).toBe(1);
  });

  it('shader sources follow the original programs', () => {
    const mask = trackFragmentShader('mask', false);
    expect(mask).toContain('mix(t0, t2, t1)'); // lrp r1, t1, t2, t0: the mask weights base2
    expect(mask).toContain('clamp(2.0 * r1 * vColor, 0.0, 1.0)');
    expect(mask).toContain('clamp(uLmScale * r0 * t3, 0.0, 1.0)');
    expect(mask).toContain('if (vViewZ > uTrackFar) discard;');
    expect(mask).toContain('mix(uFogColor, r0.rgb, vOrigFog)');
    const world = trackFragmentShader('single', true);
    expect(world).not.toContain('discard'); // the World pass has its own far plane (100 km)
    expect(world).not.toContain('uLightmap');
    expect(trackVertexShader('single', true)).toContain('uPassProjection * mv');
    expect(trackVertexShader('singleLit', false)).toContain('in vec2 uv3;');
    expect(trackVertexShader('singleLit', false)).not.toContain('in vec2 uv1;');
    expect(SPEC_BUMP_FS).toContain('nh * nh');
    expect(WATER_VS).toContain('ws.zx * uTile.y + uScroll.wz'); // mad oT1.xy, r0.zx, c16.yy, c21.wz
    expect(WATER2_VS).toContain('normalize(vec3(e.x, e.y, uSimZ * e.z))');
    expect(WATER_FS).toContain('uFogColor * uFogScale');
    expect(WATER2_FS).toContain('texture(uEnv, r)');
    for (const src of [mask, world, SPEC_BUMP_FS, WATER_VS, WATER_FS, WATER2_VS, WATER2_FS]) {
      expect(src).not.toContain('${');
      expect(src.split('{').length).toBe(src.split('}').length);
    }
    expect(WORLD_RENDER_ORDER).toBeGreaterThan(-2); // after the environment's sky box (−2)
    expect(WORLD_RENDER_ORDER).toBeLessThan(0); // before the track pass
  });
});

// ------------------------------------------------------------------------------------------------ real data

const trackBuilt = builtAssetsPresent && STAGES.every((id) => fs.existsSync(`${BUILT_ASSETS_DIR}/stages/${id}/track.json`));
const origPresent = fs.existsSync(ORIG);

function readJson<T>(p: string): T {
  return JSON.parse(new TextDecoder().decode(fs.readFileSync(p))) as T;
}

function readBin(p: string): ArrayBuffer {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** Case-insensitive child of a directory (the extracted archives keep the original's mixed case). */
function child(dir: string, name: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === name.toLowerCase());
  return hit ? `${dir}/${hit}` : null;
}

function trackPal(id: string): Uint8Array | null {
  const lvl = `${ORIG}/${stageArchive(id)}/${stageLevelPath(id)}`;
  const dir = child(lvl, 'Lightmaps');
  const pal = dir && child(dir, 'Track.pal');
  return pal ? fs.readFileSync(pal) : null;
}

describe.skipIf(!trackBuilt)('track part on real data (all 48 stages)', () => {
  const texSeen = new Map<string, ReturnType<typeof parseRtex>>();
  const tex = (id: string): ReturnType<typeof parseRtex> => {
    let t = texSeen.get(id);
    if (!t) {
      t = parseRtex(fs.readFileSync(`${BUILT_ASSETS_DIR}/tex/${id}.rtex`));
      texSeen.set(id, t);
    }
    return t;
  };

  it.each(STAGES)('%s: counts = fmt_quadmesh, the binary is consistent', (id) => {
    const j = validateTrackJson(readJson(`${BUILT_ASSETS_DIR}/stages/${id}/track.json`));
    const bin = readBin(`${BUILT_ASSETS_DIR}/stages/${id}/track.bin`);
    expect(bin.byteLength).toBe(j.binBytes);
    const ref = QM_REF[id];
    expect(j.meshes.map((m) => m.kind).sort()).toEqual(Object.keys(ref).sort());
    for (const m of j.meshes) {
      const [np, nv, nt] = ref[m.kind]!;
      expect(m.patches.length).toBe(np);
      expect(m.vertexCount).toBe(nv);
      expect(m.indexCount).toBe(3 * nt);
      expect(m.stats).toMatchObject({ patches: np, vertices: nv, triangles: nt });
      const a = meshArrays(bin, m);
      // groups tile the index buffer in patch order; patch vertex ranges tile the vertex buffer
      let next = 0;
      let vnext = 0;
      for (const p of m.patches) {
        expect(p.vertexStart).toBe(vnext);
        vnext += p.vertexCount;
        for (const g of p.groups) {
          expect(g.start).toBe(next);
          expect(g.count % 3).toBe(0);
          next += g.count;
          const mat = j.materials[g.material];
          expect(mat.mesh).toBe(m.kind);
          // every index of the group lies in its patch's vertex range
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = g.start; i < g.start + g.count; i++) {
            lo = Math.min(lo, a.indices[i]);
            hi = Math.max(hi, a.indices[i]);
          }
          expect(lo).toBeGreaterThanOrEqual(p.vertexStart);
          expect(hi).toBeLessThan(p.vertexStart + p.vertexCount);
        }
        // the patch bounds hold every vertex of the patch (THREE space)
        const s = m.floatStride;
        for (let v = p.vertexStart; v < p.vertexStart + p.vertexCount; v += 7) {
          for (let k = 0; k < 3; k++) {
            expect(a.vertices[v * s + k]).toBeGreaterThanOrEqual(p.bounds[k] - 2e-3);
            expect(a.vertices[v * s + k]).toBeLessThanOrEqual(p.bounds[k + 3] + 2e-3);
          }
        }
      }
      expect(next).toBe(m.indexCount);
      expect(vnext).toBe(m.vertexCount);
      // layout: Track.qm 0x92541 (pos + uv0..uv3), World.qm 0x541 (pos + uv0), Water.qm 0x141 / 0x541
      if (m.kind === 'track') expect(m.vertexFormat).toBe(0x92541);
      if (m.kind === 'world') expect(m.vertexFormat).toBe(0x541);
      expect(m.floatStride).toBe(3 + 2 * Object.keys(m.layout).filter((k) => k.startsWith('uv')).length);
      // quadtree: pre-order, every patch listed exactly once
      const listed = m.nodes.flatMap((n) => n.patches).sort((x, y) => x - y);
      expect(listed).toEqual(m.patches.map((_, i) => i));
    }
  });

  it.each(STAGES)('%s: every texId resolves to a valid .rtex; lightmaps are P8 through Track.pal', (id) => {
    const j = readJson<TrackJson>(`${BUILT_ASSETS_DIR}/stages/${id}/track.json`);
    const missing = new Set(j.missingTextures);
    for (const m of j.materials) {
      for (const [slot, ref] of Object.entries(m.tex)) {
        if (!ref) continue;
        if (ref.id === null) {
          expect(missing.has(ref.name), `${m.name}.${slot} ${ref.name}`).toBe(true);
          continue;
        }
        const t = tex(ref.id);
        expect(t.width).toBeGreaterThan(0);
      }
    }
    expect(tex(j.white).width).toBeGreaterThan(0);
    const track = j.meshes.find((m) => m.kind === 'track')!;
    const lms = track.patches.map((p) => p.lightmap);
    expect(j.lightmaps.patches).toBe(lms.length);
    if (id === 'corsica-1-f') {
      // the archive ships no Lightmaps/ (quadmesh.md §5): every patch takes the engine's texture/white
      expect(lms.every((x) => x === null)).toBe(true);
    } else {
      expect(lms.every((x) => typeof x === 'string')).toBe(true);
      const pal = origPresent ? trackPal(id) : null;
      for (const lm of new Set(lms)) {
        const t = tex(lm!);
        expect(t.format).toBe(RTEX_FORMAT.P8);
        expect(t.palette).not.toBeNull();
        if (pal) {
          // Track.pal: RIFF 'PAL ' header (24 bytes), then 256 × (R, G, B, flags) [V FUN_0065a000]
          for (let i = 0; i < 256; i++) {
            expect([t.palette![4 * i], t.palette![4 * i + 1], t.palette![4 * i + 2], t.palette![4 * i + 3]]).toEqual([pal[24 + 4 * i], pal[25 + 4 * i], pal[26 + 4 * i], 255]);
          }
        }
      }
    }
    // Water.* (environment.md §3.7) exactly where a Water.qm exists; the bump volume carries the animation depth
    const hasWater = j.meshes.some((m) => m.kind === 'water');
    expect(j.water !== null).toBe(hasWater);
    if (j.water) {
      if (j.water.bumpTex) expect(tex(j.water.bumpTex).depth).toBe(j.water.bumpDepth);
      if (j.water.envTex) for (const f of j.water.envTex) expect(tex(f).width).toBeGreaterThan(0);
    }
  });

  it.each(['corsica-2-r', 'hillclimb-3b-f', 'iceracing-2-r', 'kenya-3-f', 'newzealand-2-r', 'rallycross-3-f'])(
    '%s: the ported stage road lies on Track.qm in the contract frame (three = SIM with z negated)',
    (id) => {
      const j = validateTrackJson(readJson(`${BUILT_ASSETS_DIR}/stages/${id}/track.json`));
      const bin = readBin(`${BUILT_ASSETS_DIR}/stages/${id}/track.bin`);
      const t = j.meshes[0];
      const grid = new TrackHeightGrid([{ arrays: meshArrays(bin, t), stride: t.floatStride, ranges: t.patches.flatMap((p) => p.groups) }]);
      const fit = stageFrameFit(buildStage(id).stage, grid);
      expect(fit.n).toBeGreaterThan(100);
      expect(fit.sim).toBeGreaterThan(0.95);
      expect(fit.mirrorZ).toBe(false);
    },
    60000,
  );

  it('the documented unresolved names only (quadmesh.md §4.1 + newzealand-2-f Textures/ EnvTex)', () => {
    const all = new Map<string, string[]>();
    for (const id of STAGES) {
      const j = readJson<TrackJson>(`${BUILT_ASSETS_DIR}/stages/${id}/track.json`);
      if (j.missingTextures.length) all.set(id, j.missingTextures);
      if (id === 'newzealand-2-f') expect(j.water?.envTex).toBeNull();
    }
    expect(Object.fromEntries(all)).toEqual({
      'kenya-3-f': ['texture/KE_Tarmac_02_MT'],
      'kenya-3-r': ['texture/KE_Tarmac_02_MT'],
      'newzealand-2-f': ['texture/NZ2f_water.rcm'],
      'newzealand-2-r': ['texture/SWE_side_01_test_MT'],
    });
  });
});

describe.skipIf(!trackBuilt)('track runtime loader on a real stage', () => {
  beforeAll(() => useBuiltAssets());
  afterAll(() => _setAssetFetchForTests(null));

  /** A TextureScope stand-in (no GL): plain THREE textures, every requested id must exist on disk. `palettes`
   *  collects the palette keys requested (the car lightmaps). */
  function fakeScope(requested: Set<string>, palettes: string[] = []): TextureScope {
    const mk = (id: string) => {
      requested.add(id);
      if (!fs.existsSync(`${BUILT_ASSETS_DIR}/tex/${id}.rtex`)) throw new Error(`missing ${id}`);
      return new THREE.Texture();
    };
    return {
      s3tc: false,
      get: async (id: string, opts?: { palette?: { key: string; rgba: Uint8Array } }) => {
        if (opts?.palette) palettes.push(opts.palette.key);
        return mk(id);
      },
      image: async (id: string) => parseRtex(fs.readFileSync(`${BUILT_ASSETS_DIR}/tex/${id}.rtex`).slice().buffer),
      scope: () => fakeScope(requested, palettes),
      getCube: async (ids: readonly string[]) => {
        ids.forEach(mk);
        return new THREE.CubeTexture() as unknown as THREE.CompressedCubeTexture;
      },
      getVolume: async (id: string) => {
        mk(id);
        return new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1);
      },
      dispose: () => {},
    } as unknown as TextureScope;
  }

  it.each(['kenya-1-f', 'corsica-1-f', 'iceracing-1-f'])('%s: builds every pass, culls through the quadtree, samples the ground', async (id) => {
    const { stage } = buildStage(id);
    const requested = new Set<string>();
    const palettes: string[] = [];
    const uniforms = createOrigUniforms();
    const ctx: OrigLoadContext = {
      stage,
      stageId: id,
      manifest: { version: 1, stages: { [id]: ['track'] }, cars: [], carParts: {}, global: [], audio: false, textures: 0 } as unknown as OrigLoadContext['manifest'],
      parts: ['track'],
      renderer: {} as THREE.WebGLRenderer,
      textures: fakeScope(requested, palettes),
      uniforms,
      partPath: (part, ext = 'json') => stagePartPath(id, part, ext),
      fetchPartJson: <T>(part: string, ext = 'json') => fetchJson<T>(stagePartPath(id, part, ext)),
      fetchPartBuffer: (part, ext = 'bin') => fetchArrayBuffer(stagePartPath(id, part, ext)),
    };
    expect(await loadTrack({ ...ctx, parts: [] })).toBeNull();
    const c = await loadTrack(ctx);
    expect(c).not.toBeNull();
    const j = readJson<TrackJson>(`${BUILT_ASSETS_DIR}/stages/${id}/track.json`);
    const track = j.meshes.find((m) => m.kind === 'track')!;
    // one mesh per Track.qm / Water.qm patch + one World mesh
    const meshes: THREE.Mesh[] = [];
    c!.object3D.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    const nWater = j.meshes.find((m) => m.kind === 'water')?.patches.length ?? 0;
    const hasWorld = j.meshes.some((m) => m.kind === 'world') && j.settings.drawWorld;
    expect(meshes.length).toBe(track.patches.length + nWater + (hasWorld ? 1 : 0));
    const world = meshes.find((m) => m.name === 'orig-track:world');
    expect(!!world).toBe(hasWorld);
    if (world) expect(world.renderOrder).toBe(WORLD_RENDER_ORDER);
    // SpecBump groups exactly for the bumpmapped subshaders (track.bumpEnable)
    const bumpMats = new Set(j.materials.map((m, i) => (m.tex.bump ? i : -1)).filter((i) => i >= 0));
    let bumpGroups = 0;
    for (const p of track.patches) for (const g of p.groups) if (j.settings.bumpEnable && bumpMats.has(g.material)) bumpGroups++;
    let specGroups = 0;
    for (const m of meshes) for (const mm of m.material as THREE.Material[]) if (mm.name.startsWith('orig-track:specBump')) specGroups++;
    expect(specGroups).toBe(bumpGroups);
    // every lightmap of the stage was requested (corsica-1-f: only texture/white)
    for (const p of track.patches) expect(requested.has(p.lightmap ?? j.white)).toBe(true);

    // a camera at the start, looking down the road: some but not all patches visible; ground under the car
    const cam = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 6000);
    const sp = stage.startPose.pos;
    const fwd = stage.tangentAt(stage.startS);
    cam.position.set(sp.x - 8 * fwd.x, sp.y + 3, sp.z - 8 * fwd.z);
    cam.lookAt(sp.x + 30 * fwd.x, sp.y, sp.z + 30 * fwd.z);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    c!.update(cam, 1 / 60);
    const st = trackStats(c)!;
    expect(st.patchesTotal).toBe(track.patches.length);
    expect(st.patches).toBeGreaterThan(0);
    expect(st.patches).toBeLessThan(track.patches.length);
    expect(st.drawCalls).toBeGreaterThanOrEqual(st.patches);
    expect(st.viewDistance).toBeGreaterThan(0);
    const visible = meshes.filter((m) => m.name.startsWith('orig-track:track:') && m.visible).length;
    expect(visible).toBe(st.patches);
    const h = c!.heightAt!(sp.x, sp.z);
    expect(Number.isFinite(h)).toBe(true);
    expect(Math.abs(h - sp.y)).toBeLessThan(2.5);
    expect(Number.isNaN(c!.heightAt!(1e6, 1e6))).toBe(true);
    expect(c!.cameraFar).toBeGreaterThanOrEqual(maxTrackViewDistance(j.settings));
    // the projected lightmap under the start (cars: through the car palette; particles: CPU through the particle
    // palette); corsica-1-f ships no lightmaps → white (null)
    const lm = c!.carLightmapAt!(sp.x, sp.y, sp.z);
    const out = [0, 0, 0];
    if (track.patches.some((p) => p.lightmap)) {
      expect(lm).not.toBeNull();
      const u = lm!.proj[0] * sp.x + lm!.proj[1];
      const v = lm!.proj[2] * sp.z + lm!.proj[3];
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(lm!.texture).toBeNull(); // first request: loading
      await new Promise((r) => setTimeout(r, 0));
      const lm2 = c!.carLightmapAt!(sp.x, sp.y, sp.z, lm!.patch);
      expect(lm2!.patch).toBe(lm!.patch);
      expect(lm2!.texture).not.toBeNull();
      expect(palettes.length).toBe(1);
      expect(palettes[0]).toMatch(/^car:/);
      expect(c!.particleLightAt!(sp.x, sp.y, sp.z, out)).toBe(lm!.patch);
      const pmin = uniforms.particleLightmapMin.value.toArray();
      for (let k = 0; k < 3; k++) {
        expect(out[k]).toBeGreaterThanOrEqual(Math.floor(pmin[k] * 255) / 255 - 1e-9);
        expect(out[k]).toBeLessThanOrEqual(1);
      }
    } else {
      expect(lm).toBeNull();
      expect(c!.particleLightAt!(sp.x, sp.y, sp.z, out)).toBe(-1);
    }
    expect(c!.carLightmapAt!(1e6, 0, 1e6)).toBeNull();
    // World pass: emulated in the main render without an environment component ('own', layer 0); on the
    // environment pipeline's sky layer while an `orig:environment` sibling is present and its sky pass draws it
    if (world) {
      const tc = c as unknown as { worldMode: string };
      expect(tc.worldMode).toBe('own');
      expect(world.layers.isEnabled(0)).toBe(true);
      const view = new THREE.Group();
      const env = new THREE.Group();
      env.name = 'orig:environment';
      view.add(env, c!.object3D);
      c!.update(cam, 1 / 60);
      expect(tc.worldMode).toBe('sky');
      expect(world.layers.isEnabled(0)).toBe(false);
      expect(world.layers.isEnabled(1)).toBe(true);
      // the sky camera drawing it keeps the mode; nobody drawing it for > 3 updates falls back to 'own'
      const skyCam = new THREE.PerspectiveCamera(60, 4 / 3, 10, 100010);
      skyCam.layers.set(1);
      for (let i = 0; i < 5; i++) {
        c!.update(cam, 1 / 60);
        world.onBeforeRender({} as THREE.WebGLRenderer, new THREE.Scene(), skyCam, world.geometry, world.material as THREE.Material, null as unknown as THREE.Group);
      }
      expect(tc.worldMode).toBe('sky');
      for (let i = 0; i < 5; i++) c!.update(cam, 1 / 60);
      expect(tc.worldMode).toBe('own');
      expect(world.layers.isEnabled(0)).toBe(true);
    }
    c!.dispose();
  });
});
