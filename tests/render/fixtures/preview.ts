/**
 * tests/render/fixtures/preview.ts — render preview page driver (tools/render-preview/index.html).
 * Render builder tool: exercises GameRenderer on a synthetic stage with a kinematic fake car, independent
 * of the sim / world / game modules. Headless API on window.__preview (see tools/render-shots.mjs).
 *
 *   ?env=day|dusk|snow|overcast|night|desert  ?car=awd_wrc|fwd_hatch|rwd_classic  ?cam=<mode>  ?live=1
 * Live keys: ↑/↓ speed, ←/→ drift, Space wheelspin, B brake, C camera, Ctrl look back, 1-9 jump to sections.
 */
import { CAMERA_MODES } from '../../../src/core/constants';
import type { ArchetypeId, CameraMode, Stage, SurfaceId } from '../../../src/core/types';
import { GameRenderer } from '../../../src/render/renderer';
import { FakeCar } from './fakeCar';
import { synthStage, type SynthEnv } from './synthStage';

interface LoadOpts {
  env?: SynthEnv;
  surfaces?: SurfaceId[];
  car?: ArchetypeId;
  seed?: number;
  flat?: boolean;
  s?: number;
}

interface CarSet {
  speed?: number;
  drift?: number;
  wheelspin?: number;
  brake?: number;
  steer?: number;
  lateral?: number;
  s?: number;
  extraRoll?: number;
  gear?: number;
  surface?: SurfaceId | null;
}

const q = new URLSearchParams(location.search);
const el = document.getElementById('game')!;
const info = document.getElementById('info')!;
const renderer = new GameRenderer(el);
let stage: Stage;
let car: FakeCar;
let ghost: FakeCar | null = null;

function states() {
  const out = [car.renderState()];
  if (ghost) {
    const g = ghost.renderState();
    out.push({ ...g, id: 'ghost', ghost: true, player: false });
  }
  return out;
}

function load(o: LoadOpts = {}): { length: number; scenery: number } {
  const t0 = performance.now();
  stage = synthStage({ env: o.env ?? ((q.get('env') as SynthEnv) || 'day'), surfaces: o.surfaces, seed: o.seed, flat: o.flat });
  const t1 = performance.now();
  renderer.loadStage(stage);
  const arche = o.car ?? ((q.get('car') as ArchetypeId) || 'awd_wrc');
  renderer.removeCar('player');
  renderer.removeCar('ghost');
  ghost = null;
  renderer.addCar('player', arche, { player: true });
  car = new FakeCar(stage, arche, o.s ?? stage.startS);
  renderer.update(0, 0, [car.renderState()]);
  console.info(`[preview] stage ${(t1 - t0).toFixed(0)} ms, renderer.loadStage ${(performance.now() - t1).toFixed(0)} ms`);
  return { length: stage.length, scenery: stage.scenery.length };
}

function set(p: CarSet): void {
  if (p.s !== undefined || p.lateral !== undefined) car.teleport(p.s ?? car.s, p.lateral ?? car.lateral);
  if (p.speed !== undefined) car.speed = p.speed;
  if (p.drift !== undefined) car.drift = p.drift;
  if (p.wheelspin !== undefined) car.wheelspin = p.wheelspin;
  if (p.brake !== undefined) car.brake = p.brake;
  if (p.steer !== undefined) car.steer = p.steer;
  if (p.extraRoll !== undefined) car.extraRoll = p.extraRoll;
  if (p.gear !== undefined) car.gear = p.gear;
  if (p.surface !== undefined) car.surfaceOverride = p.surface;
}

/** Simulate `seconds` at a fixed frame rate synchronously (deterministic screenshots). */
function run(seconds: number, fps = 60): void {
  const dt = 1 / fps;
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) {
    car.advance(dt);
    if (ghost) {
      ghost.speed = car.speed;
      ghost.drift = car.drift * 0.5;
      ghost.advance(dt);
    }
    renderer.update(dt, 0, states());
  }
}

let live = q.get('live') === '1';
let last = -1;
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyC') renderer.nextCamera();
  if (e.code.startsWith('Digit')) car.teleport(Number(e.code.slice(5)) * 200 + 20, 0);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!live) return;
  const dt = last < 0 ? 1 / 60 : Math.min(0.1, (now - last) / 1000);
  last = now;
  if (keys.has('ArrowUp')) car.speed = Math.min(50, car.speed + 12 * dt);
  if (keys.has('ArrowDown')) car.speed = Math.max(0, car.speed - 20 * dt);
  car.drift += ((keys.has('ArrowRight') ? 0.45 : keys.has('ArrowLeft') ? -0.45 : 0) - car.drift) * Math.min(1, 3 * dt);
  car.wheelspin = keys.has('Space') ? 8 : 0;
  car.brake = keys.has('KeyB') ? 1 : 0;
  renderer.lookBack(keys.has('ControlLeft'));
  car.advance(dt);
  renderer.update(dt, 0, [car.renderState()]);
  const st = renderer.stats();
  info.textContent = `${renderer.getCameraMode()}  ${(car.speed * 3.6).toFixed(0)} km/h  s=${car.s.toFixed(0)}  fps ${st.fps.toFixed(0)}  calls ${st.drawCalls}  tris ${(st.triangles / 1000).toFixed(0)}k`;
}

const cam = q.get('cam');
if (cam && (CAMERA_MODES as readonly string[]).includes(cam)) renderer.setCameraMode(cam as CameraMode);
load();
requestAnimationFrame(frame);

(window as unknown as { __preview: unknown }).__preview = {
  ready: true,
  load,
  set,
  run,
  camera: (m: CameraMode) => renderer.setCameraMode(m),
  debugCamera: (pos: { x: number; y: number; z: number } | null, target?: { x: number; y: number; z: number }, relative = true) =>
    renderer.setDebugCamera(pos, target, relative),
  lookBack: (on: boolean) => renderer.lookBack(on),
  /** Add / remove a translucent ghost car `gap` metres ahead of the player, `lateral` m to the side. */
  ghost: (on: boolean, gap = 8, lateral = 1.5) => {
    renderer.removeCar('ghost');
    ghost = null;
    if (!on) return;
    renderer.addCar('ghost', car.archetype, { ghost: true, player: false });
    ghost = new FakeCar(stage, car.archetype, car.s + gap);
    ghost.lateral = lateral;
  },
  setLive: (on: boolean) => {
    live = on;
    last = -1;
  },
  setParam: (p: Parameters<GameRenderer['setCameraTuning']>[0]) => renderer.setCameraTuning(p),
  quality: (qq: 'low' | 'medium' | 'high') => renderer.setQuality(qq),
  stats: () => ({ ...renderer.stats(), ...renderer.debugInfo() }),
  /** Show / hide scene objects by name prefix (bench experiments). */
  toggle: (prefix: string, visible: boolean) => {
    const scene = (renderer as unknown as { scene: { traverse(f: (o: { name: string; visible: boolean }) => void): void } }).scene;
    let n = 0;
    scene.traverse((o) => {
      if (o.name.startsWith(prefix)) {
        o.visible = visible;
        n++;
      }
    });
    return n;
  },
  pixelRatio: (r: number) => {
    (renderer as unknown as { renderer: { setPixelRatio(r: number): void } }).renderer.setPixelRatio(r);
    renderer.resize();
  },
  /** ms per frame (render + sync) over `frames` frames at the given quality. */
  bench: (frames: number, quality: 'low' | 'medium' | 'high') => {
    renderer.setQuality(quality);
    const gl = (renderer as unknown as { renderer: { getContext(): WebGL2RenderingContext } }).renderer.getContext();
    const px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    run(0.2, 30);
    sync();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      car.advance(1 / 30);
      renderer.update(1 / 30, 0, [car.renderState()]);
      sync();
    }
    return (performance.now() - t0) / frames;
  },
  car: () => ({ s: car.s, speed: car.speed, tel: car.telemetry() }),
};
