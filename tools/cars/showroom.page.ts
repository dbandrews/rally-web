// tools/cars/showroom.page.ts — page side of tools/cars/car-shots.mjs (loaded by showroom.html through the Vite dev
// server; not part of the game build). Renders ORIGINAL cars (src/render/orig/car.ts) on their own, in fixed views,
// next to the original's menu icon (Menu/menu/Texture/Icon<Car>.tga, built as cars/<Name>/cars/icon.png).
//
// Lighting = the original garage (Misc/level/menuinit.con): game.lightDirection 0/-0.7/1 relative to the menu
// camera (which looks along +z sim, so the light comes from behind / above the camera), Car.ambient 0.3,
// Car.lightColor 0.7; env cube = menu/texture/carenvmap (no stageId) or the stage's CarEnvmap (stageId).
// Output: the original's gamma-space pipeline (NoToneMapping + LinearSRGBColorSpace).
import * as THREE from 'three';
import type { CarRenderState } from '../../src/core/types';
import { carIconUrl, loadCarInfo, loadOriginalCar, type CarInfo, type OriginalCarVisual } from '../../src/render/orig/car';
import { origUniforms, resetOrigUniforms } from '../../src/render/orig/common';
import { TextureStore } from '../../src/render/orig/textures';

export interface View {
  label: string;
  /** Camera azimuth in degrees around the car (0 = straight ahead of the car, 90 = its left side), elevation (deg). */
  az: number;
  el: number;
  dist: number;
  fov?: number;
  lod?: number;
  brake?: boolean;
  reverse?: boolean;
  night?: boolean;
  tyre?: number;
  steer?: number;
  damage?: number;
  ghost?: boolean;
}

export interface RunOptions {
  cars: string[];
  views: View[];
  width: number;
  height: number;
  stageId?: string | null;
  menu?: boolean;
  background?: number;
}

export interface CarShots {
  car: string;
  name: string;
  icon: string | null;
  shots: { label: string; url: string; drawCalls: number; triangles: number }[];
  error?: string;
}

function fakeState(info: CarInfo, v: View): CarRenderState {
  const wheels = info.wheels.map((w) => {
    const ext = w.rest?.ext ?? 0.88;
    const steer = w.front ? ((v.steer ?? 0) * Math.PI) / 180 : 0;
    return {
      slipAngle: 0, kappa: 0, load: 0, mode: 1, surface: null, material: -1, contact: true, omega: 0, Fsusp: 0, Fx: 0, Fy: 0, mu: 0,
      driveT: 0, brakeT: 0, contactPoint: { x: 0, y: 0, z: 0 }, contactPointThree: { x: 0, y: 0, z: 0 },
      visual: { steerAngle: steer, spinAngle: 0.3, suspensionOffset: w.springLength * (1 - ext), centreLocal: { x: 0, y: 0, z: 0 } },
    };
  });
  const telemetry = {
    id: 'showroom', archetype: 'awd_wrc', stepCount: 0, simTime: 0, speedKmh: 0, brake: v.brake ? 1 : 0, gear: v.reverse ? 0 : 1,
    tyreType: v.tyre ?? 0, wheels, vel: { x: 0, y: 0, z: 0 },
  };
  return {
    id: 'showroom', archetype: 'awd_wrc', ghost: !!v.ghost, player: true,
    pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 },
    telemetry: telemetry as unknown as CarRenderState['telemetry'],
    justReset: true,
  };
}

export async function run(opts: RunOptions): Promise<CarShots[]> {
  const W = opts.width;
  const H = opts.height;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(opts.background ?? 0xdedede, 1);
  const store = new TextureStore(renderer);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(30, W / H, 0.05, 200);
  resetOrigUniforms();
  // Misc/level/menuinit.con
  origUniforms.carAmbient.value.set(0.3, 0.3, 0.3);
  origUniforms.carLight.value.set(0.7, 0.7, 0.7);
  const out: CarShots[] = [];
  const grid = document.getElementById('grid') ?? document.body;
  for (const car of opts.cars) {
    const row: CarShots = { car, name: car, icon: null, shots: [] };
    out.push(row);
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    grid.appendChild(rowEl);
    try {
      const info = await loadCarInfo(car);
      row.name = info.name;
      row.icon = carIconUrl(info);
      const label = document.createElement('div');
      label.className = 'label';
      label.innerHTML = `<b>${info.name}</b><br><small>${car} · LOD tris ${info.lodTriangles.join('/')}</small>`;
      rowEl.appendChild(label);
      if (row.icon) {
        const img = document.createElement('img');
        img.src = row.icon;
        img.className = 'icon';
        rowEl.appendChild(img);
      }
      const visuals = new Map<string, { vis: OriginalCarVisual; dispose: () => void }>();
      const get = async (ghost: boolean) => {
        const key = ghost ? 'ghost' : 'main';
        let v = visuals.get(key);
        if (!v) {
          const scope = store.scope();
          const vis = await loadOriginalCar(car, { textures: scope, stageId: opts.stageId ?? null, menu: opts.menu ?? true, ghost });
          if (!vis) throw new Error('loadOriginalCar returned null');
          v = { vis, dispose: () => (vis.dispose(), scope.dispose()) };
          visuals.set(key, v);
        }
        return v.vis;
      };
      for (const view of opts.views) {
        const vis = await get(!!view.ghost);
        scene.add(vis.root);
        vis.setLod(view.lod ?? 0);
        vis.setNight(!!view.night);
        vis.setDamage(view.damage ?? 0);
        vis.apply(fakeState(info, view), 0, cam);
        const az = (view.az * Math.PI) / 180;
        const el = (view.el * Math.PI) / 180;
        // three car frame: forward −Z, left −X
        const target = new THREE.Vector3(0, 0.25, 0);
        cam.fov = view.fov ?? 30;
        cam.position.set(-Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(view.dist).add(target);
        cam.lookAt(target);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld();
        // garage light: from behind / above the camera (menuinit.con lightDirection 0/-0.7/1 in the camera's frame)
        const back = new THREE.Vector3().subVectors(cam.position, target).setY(0).normalize();
        origUniforms.sunDir.value.copy(back).add(new THREE.Vector3(0, 0.7, 0)).normalize();
        vis.apply(fakeState(info, view), 1 / 60, cam); // flares need the camera
        renderer.info.reset();
        renderer.info.autoReset = false;
        renderer.render(scene, cam);
        const url = renderer.domElement.toDataURL('image/png');
        row.shots.push({ label: view.label, url, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
        renderer.info.autoReset = true;
        scene.remove(vis.root);
        const fig = document.createElement('figure');
        fig.innerHTML = `<img src="${url}" width="${W}" height="${H}"><figcaption>${view.label}</figcaption>`;
        rowEl.appendChild(fig);
      }
      for (const v of visuals.values()) v.dispose();
    } catch (e) {
      row.error = String((e as Error)?.stack ?? e);
      const err = document.createElement('pre');
      err.textContent = `${car}: ${row.error}`;
      rowEl.appendChild(err);
    }
  }
  document.body.dataset.done = '1';
  return out;
}
