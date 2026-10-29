/**
 * src/render/carVisual.ts — one rendered car: lofted body (per-slot meshes), four wheel rigs, brake /
 * reverse / head lights, ghost variant (render builder).
 *
 * Wheel rig per wheel: root (position = WheelVisual.centreLocal + surface jitter) → steer pivot
 * (rotation.y = -steerAngle, rate-limited to 4 rad/s, §5.2) → spinner (rotation.x = -spinAngle) → tyre/rim.
 */
import * as THREE from 'three';
import { SURFACE_INFO } from '../core/constants';
import { applyThreeQuat } from '../core/space';
import type { ArchetypeId, CarRenderState } from '../core/types';
import { PROFILES, SLOTS, carGeometry, restWheelCentre, type Slot } from './carModel';
import { liveryColors, liveryTexture } from './livery';
import { rimTexture } from './textures';

const STEER_RATE = 4; // rad/s, §5.2 visual steer follow

interface WheelRig {
  root: THREE.Group;
  pivot: THREE.Group;
  spinner: THREE.Group;
  steer: number;
  phase: number;
}

const wheelGeoCache = new Map<string, { tyre: THREE.BufferGeometry; face: THREE.BufferGeometry; inner: THREE.BufferGeometry }>();
function wheelGeo(r: number, w: number) {
  const key = `${r}:${w}`;
  let g = wheelGeoCache.get(key);
  if (!g) {
    const tyre = new THREE.CylinderGeometry(r, r, w, 20, 1, true).rotateZ(Math.PI / 2);
    // slightly rounded shoulders: shrink the cylinder ends a touch by adding bevel rings
    const face = new THREE.CircleGeometry(r * 0.985, 20).rotateY(Math.PI / 2); // faces +X
    const inner = new THREE.CircleGeometry(r * 0.985, 14).rotateY(-Math.PI / 2); // faces -X
    g = { tyre, face, inner };
    wheelGeoCache.set(key, g);
  }
  return g;
}

export interface CarVisualOptions {
  ghost?: boolean;
  livery?: number;
  night?: boolean;
}

export class CarVisual {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly archetype: ArchetypeId;
  readonly ghost: boolean;
  private readonly wheels: WheelRig[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly tailMat: THREE.MeshStandardMaterial;
  private readonly revMat: THREE.MeshStandardMaterial;
  private readonly headMat: THREE.MeshStandardMaterial;
  private night = false;
  private time = 0;

  constructor(archetype: ArchetypeId, opts: CarVisualOptions = {}) {
    this.archetype = archetype;
    this.ghost = !!opts.ghost;
    this.night = !!opts.night;
    const prof = PROFILES[archetype];
    const colors = liveryColors(archetype, opts.livery ?? 0);
    const geo = carGeometry(archetype);
    const ghostMat = this.ghost
      ? new THREE.MeshStandardMaterial({ color: 0xb8dcff, transparent: true, opacity: 0.42, roughness: 0.35, metalness: 0.1, depthWrite: true, emissive: 0x2a5a8a, emissiveIntensity: 0.8 })
      : null;
    if (ghostMat) this.mats.push(ghostMat);
    const map = this.ghost ? null : liveryTexture(archetype, opts.livery ?? 0);
    const mk = (slot: Slot): THREE.Material => {
      if (ghostMat) return ghostMat;
      let m: THREE.Material;
      switch (slot) {
        case 'paint':
          m = new THREE.MeshStandardMaterial({ map, color: map ? 0xffffff : colors.body, roughness: 0.32, metalness: 0.15, envMapIntensity: 1.1 });
          break;
        case 'glass':
          m = new THREE.MeshStandardMaterial({ color: 0x3a4c5e, roughness: 0.07, metalness: 0.75, envMapIntensity: 1.6 });
          break;
        case 'dark':
          m = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.75, metalness: 0.0 });
          break;
        case 'accent':
          m = new THREE.MeshStandardMaterial({ color: archetype === 'fwd_hatch' ? colors.accent : colors.accent, roughness: 0.45, metalness: 0.1 });
          break;
        case 'chrome':
          m = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.2, metalness: 0.9 });
          break;
        case 'head':
          m = new THREE.MeshStandardMaterial({ color: 0xf4f1e6, emissive: 0xfff3d6, emissiveIntensity: 0.25, roughness: 0.1, metalness: 0.2 });
          break;
        case 'tail':
          m = new THREE.MeshStandardMaterial({ color: 0x5a0805, emissive: 0xff1a0a, emissiveIntensity: 0.15, roughness: 0.2 });
          break;
        case 'rev':
          m = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.2 });
          break;
      }
      this.mats.push(m);
      return m;
    };
    const slotMats = {} as Record<Slot, THREE.Material>;
    for (const s of SLOTS) {
      slotMats[s] = mk(s);
      const g = geo[s];
      if (!g.attributes.position || g.attributes.position.count === 0) continue;
      const mesh = new THREE.Mesh(g, slotMats[s]);
      mesh.castShadow = !this.ghost;
      mesh.receiveShadow = !this.ghost && s !== 'glass';
      mesh.name = `car:${s}`;
      this.body.add(mesh);
    }
    this.headMat = slotMats.head as THREE.MeshStandardMaterial;
    this.tailMat = slotMats.tail as THREE.MeshStandardMaterial;
    this.revMat = slotMats.rev as THREE.MeshStandardMaterial;
    this.root.add(this.body);

    // wheels
    const wg = wheelGeo(prof.wheelR, prof.wheelW);
    const tyreMat = ghostMat ?? new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.92, metalness: 0 });
    const rimMap = this.ghost ? null : rimTexture(prof.rim);
    const rimMat = ghostMat ?? new THREE.MeshStandardMaterial({ map: rimMap, color: rimMap ? 0xffffff : prof.rim, roughness: 0.4, metalness: 0.5 });
    const innerMat = ghostMat ?? new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    if (!ghostMat) this.mats.push(tyreMat, rimMat, innerMat);
    for (let i = 0; i < 4; i++) {
      const root = new THREE.Group();
      const pivot = new THREE.Group();
      const spinner = new THREE.Group();
      const left = i === 0 || i === 3;
      const tyre = new THREE.Mesh(wg.tyre, tyreMat);
      const face = new THREE.Mesh(wg.face, rimMat);
      const inner = new THREE.Mesh(wg.inner, innerMat);
      const hw = prof.wheelW / 2 + 0.002;
      // outer face points away from the car
      if (left) {
        face.rotation.y = Math.PI;
        face.position.x = -hw;
        inner.rotation.y = Math.PI;
        inner.position.x = hw;
      } else {
        face.position.x = hw;
        inner.position.x = -hw;
      }
      for (const m of [tyre, face, inner]) {
        m.castShadow = !this.ghost;
        m.receiveShadow = false;
        spinner.add(m);
      }
      pivot.add(spinner);
      root.add(pivot);
      root.position.copy(restWheelCentre(archetype, i));
      this.root.add(root);
      this.wheels.push({ root, pivot, spinner, steer: 0, phase: i * 1.7 });
    }
    this.setNight(this.night);
  }

  setNight(on: boolean): void {
    this.night = on;
    this.headMat.emissiveIntensity = on ? 4 : 0.25;
  }

  /** Hide / show the whole car (bumper / look-back cameras). */
  setVisible(on: boolean): void {
    this.root.visible = on;
  }

  update(state: CarRenderState, frameDt: number): void {
    this.time += frameDt;
    this.root.position.set(state.pos.x, state.pos.y, state.pos.z);
    applyThreeQuat(this.root.quaternion, state.quat);
    const tel = state.telemetry;
    const speed = Math.abs(tel.velLocal?.z ?? tel.speedKmh / 3.6);
    const maxStep = STEER_RATE * Math.max(frameDt, 0);
    for (let i = 0; i < 4; i++) {
      const w = tel.wheels[i];
      const rig = this.wheels[i];
      const vis = w.visual;
      const c = vis.centreLocal;
      let jitter = 0;
      if (w.contact && w.surface) {
        const s = Math.sin(35 * this.time + rig.phase);
        jitter = SURFACE_INFO[w.surface].wheelJitterAmp * speed * 0.0002 * s * s;
      }
      if (c && Number.isFinite(c.x)) rig.root.position.set(c.x, c.y + jitter, c.z);
      const target = Number.isFinite(vis.steerAngle) ? vis.steerAngle : 0;
      if (state.justReset || frameDt <= 0) rig.steer = target;
      else rig.steer += Math.max(-maxStep, Math.min(maxStep, target - rig.steer));
      rig.pivot.rotation.y = -rig.steer;
      rig.spinner.rotation.x = Number.isFinite(vis.spinAngle) ? -(vis.spinAngle % (Math.PI * 2)) : 0;
    }
    if (!this.ghost) {
      const braking = tel.brake > 0.05;
      this.tailMat.emissiveIntensity = braking ? 5 : this.night ? 1.2 : 0.15;
      this.revMat.emissiveIntensity = tel.gear === 0 ? 3 : 0;
    }
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    this.root.removeFromParent();
  }
}
