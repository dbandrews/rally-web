/**
 * tests/render/render.test.ts — render-builder unit tests (node, no WebGL): camera rig math (§5.3), car
 * models, heightfield sampling, stage mesh builders, effects bookkeeping.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_IDS, DT } from '../../src/core/constants';
import { CameraRig, chaseBlendTarget, chaseExtraHeight, makeCameraTuning } from '../../src/render/cameraRig';
import { PROFILES, carGeometry, restWheelCentre, sectionAt } from '../../src/render/carModel';
import { ParticleSystem, SkidMarks, wheelSlip } from '../../src/render/effects';
import { HeightSampler } from '../../src/render/heightSampler';
import { buildRoad } from '../../src/render/road';
import { buildScenery } from '../../src/render/scenery';
import { NOMINAL_HEIGHT, buildSceneryModel } from '../../src/render/sceneryModels';
import { buildTerrain } from '../../src/render/terrain';
import type { CameraMode, SceneryKind } from '../../src/core/types';
import { FakeCar } from './fixtures/fakeCar';
import { synthStage } from './fixtures/synthStage';

const stage = synthStage({ length: 900, seed: 5 });

function finiteGeometry(g: THREE.BufferGeometry): boolean {
  const a = g.attributes.position.array as ArrayLike<number>;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

function rigOn(car: FakeCar, mode: CameraMode, frames: number, dt = 1 / 60) {
  const rig = new CameraRig(makeCameraTuning());
  rig.setMode(mode);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  for (let i = 0; i < frames; i++) {
    if (i > 0) car.advance(dt);
    const st = car.renderState();
    pos.set(st.pos.x, st.pos.y, st.pos.z);
    quat.set(st.quat.x, st.quat.y, st.quat.z, st.quat.w);
    rig.update(dt, { pos, quat, tel: st.telemetry, justReset: i === 0 });
  }
  return { rig, pos, quat };
}

describe('camera rig (§5.3)', () => {
  it('chase blend target follows the spec breakpoints', () => {
    expect(chaseBlendTarget(0)).toBeCloseTo(0.2, 6);
    expect(chaseBlendTarget(2)).toBeCloseTo(0.2, 6);
    expect(chaseBlendTarget(19.4)).toBeCloseTo(0.2 + 17.4 * 0.0342936, 6);
    expect(chaseBlendTarget(19.5)).toBeCloseTo(0.8, 6);
    expect(chaseBlendTarget(39.5)).toBeCloseTo(1, 6);
    expect(chaseBlendTarget(80)).toBe(1);
    expect(chaseBlendTarget(-11)).toBeCloseTo(0, 6);
  });

  it('nose-down extra height is p1 once the nose dips and 0 when level / nose-up', () => {
    expect(chaseExtraHeight({ x: 0, y: 0.05, z: -1 }, 10, 0.5)).toBe(0);
    expect(chaseExtraHeight({ x: 0, y: -0.05, z: -0.998 }, 10, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('chase cam snaps behind the car on reset at |posA..posB| distance and looks at car + 1.5 m', () => {
    const car = new FakeCar(stage, 'awd_wrc', 100);
    const { rig, pos, quat } = rigOn(car, 'chase', 1);
    const cam = rig.camera;
    const local = cam.position.clone().sub(pos).applyQuaternion(quat.clone().invert());
    // behind (+Z in three car-local) and above
    expect(local.z).toBeGreaterThan(3.0);
    expect(local.z).toBeLessThan(4.2);
    expect(cam.position.y - pos.y).toBeGreaterThan(0.9);
    expect(cam.position.y - pos.y).toBeLessThan(1.6);
    // looking at the car: forward of the camera points at car + (0, 1.5, 0)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const to = new THREE.Vector3(pos.x, pos.y + 1.5, pos.z).sub(cam.position).normalize();
    expect(fwd.dot(to)).toBeGreaterThan(0.999);
    // level horizon (no roll)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    expect(Math.abs(right.y)).toBeLessThan(1e-6);
  });

  it('chase cam trails and pulls back with speed (posB at high speed)', () => {
    const car = new FakeCar(stage, 'awd_wrc', 50);
    car.speed = 40;
    const { rig, pos } = rigOn(car, 'chase', 120);
    const d = rig.camera.position.distanceTo(pos);
    const e = makeCameraTuning().chase.chase;
    expect(d).toBeGreaterThan(Math.hypot(e.posA.y, e.posA.z));
    expect(d).toBeLessThan(Math.hypot(e.posB.y, e.posB.z) + 0.4);
  });

  it('is frame-rate independent (30 vs 120 fps end up at the same place)', () => {
    const a = new FakeCar(stage, 'awd_wrc', 60);
    a.speed = 25;
    a.drift = 0.3;
    const b = new FakeCar(stage, 'awd_wrc', 60);
    b.speed = 25;
    b.drift = 0.3;
    const ra = rigOn(a, 'chase', 61, 1 / 30);
    const rb = rigOn(b, 'chase', 241, 1 / 120);
    expect(ra.rig.camera.position.distanceTo(rb.rig.camera.position)).toBeLessThan(0.35);
  });

  it('tether cams keep their distance band', () => {
    for (const mode of ['tetherHigh', 'tetherLow'] as const) {
      const car = new FakeCar(stage, 'awd_wrc', 80);
      car.speed = 20;
      const { rig, pos } = rigOn(car, mode, 180);
      const d = rig.camera.position.distanceTo(pos);
      const t = makeCameraTuning().tether[mode];
      expect(d).toBeGreaterThan(t.d.x * 0.79);
      // first-order pull at p1·dt lags by ≈ v / p1 behind the target distance
      expect(d).toBeLessThan(t.d.y * 1.05 + 20 / t.p1 + 0.6);
    }
  });

  it('bumper / bonnet / look-back are rigid in the car frame; bumper and look-back hide the car', () => {
    const car = new FakeCar(stage, 'fwd_hatch', 200);
    let r = rigOn(car, 'bumper', 2);
    expect(r.rig.hideCar).toBe(true);
    let local = r.rig.camera.position.clone().sub(r.pos).applyQuaternion(r.quat.clone().invert());
    expect(local.z).toBeCloseTo(-1.4, 1); // forward of the origin (three -Z)
    r = rigOn(car, 'bonnet', 2);
    expect(r.rig.hideCar).toBe(false);
    local = r.rig.camera.position.clone().sub(r.pos).applyQuaternion(r.quat.clone().invert());
    expect(local.y).toBeCloseTo(0.65, 2);
    expect(local.z).toBeCloseTo(-0.9, 2);
    const rig = new CameraRig();
    rig.lookingBack = true;
    const st = car.renderState();
    const pos = new THREE.Vector3(st.pos.x, st.pos.y, st.pos.z);
    const quat = new THREE.Quaternion(st.quat.x, st.quat.y, st.quat.z, st.quat.w);
    rig.update(1 / 60, { pos, quat, tel: st.telemetry, justReset: true });
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
    const carFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    expect(camFwd.dot(carFwd)).toBeLessThan(-0.99);
    expect(rig.hideCar).toBe(true);
  });

  it('flipped car switches to the free follow cam (4-8 m, FOV = 85.94·atan(3.5/d)) and clears after 0.5 s on wheels', () => {
    const car = new FakeCar(stage, 'awd_wrc', 120);
    const rig = new CameraRig();
    rig.groundAt = () => -1000;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const step = (justReset = false) => {
      car.advance(1 / 60);
      const st = car.renderState();
      pos.set(st.pos.x, st.pos.y, st.pos.z);
      quat.set(st.quat.x, st.quat.y, st.quat.z, st.quat.w);
      rig.update(1 / 60, { pos, quat, tel: st.telemetry, justReset });
    };
    step(true);
    for (let i = 0; i < 10; i++) step();
    expect(rig.flipped).toBe(false);
    car.extraRoll = Math.PI; // upside down
    for (let i = 0; i < 120; i++) step();
    expect(rig.flipped).toBe(true);
    const d = rig.camera.position.distanceTo(pos);
    expect(d).toBeGreaterThanOrEqual(3.99);
    expect(d).toBeLessThanOrEqual(8.5);
    expect(rig.camera.fov).toBeCloseTo(85.943665 * Math.atan(3.5 / d), 1);
    car.extraRoll = 0;
    for (let i = 0; i < 20; i++) step();
    expect(rig.flipped).toBe(true); // < 0.5 s on the wheels
    for (let i = 0; i < 25; i++) step();
    expect(rig.flipped).toBe(false);
  });
});

describe('car models', () => {
  for (const id of ARCHETYPE_IDS) {
    it(`${id}: body fits the §3.4 hull and leaves the wheels free`, () => {
      const g = carGeometry(id);
      const box = new THREE.Box3();
      for (const s of Object.values(g)) {
        if (s.attributes.position.count === 0) continue;
        expect(finiteGeometry(s)).toBe(true);
        s.computeBoundingBox();
        box.union(s.boundingBox!);
      }
      const p = PROFILES[id];
      // three car-local: forward = -Z
      expect(-box.min.z).toBeGreaterThan(p.front - 0.05);
      expect(-box.min.z).toBeLessThan(p.front + 0.25);
      expect(box.max.z).toBeGreaterThan(-p.rear - 0.05);
      expect(box.max.z).toBeLessThan(-p.rear + 0.3);
      expect(box.max.x - box.min.x).toBeLessThan(2.0); // incl. mirrors
      expect(box.max.y).toBeLessThan(1.4);
      // arches clear the tyre tops
      for (const axle of [p.axleF, p.axleR]) {
        const s = sectionAt(p, axle);
        expect(s.yb).toBeGreaterThan(p.wheelY + p.wheelR);
      }
      // rest wheel centres sit one radius above the ground
      for (let i = 0; i < 4; i++) expect(restWheelCentre(id, i).y - p.ground).toBeCloseTo(p.wheelR, 3);
      expect(g.paint.attributes.uv.count).toBe(g.paint.attributes.position.count);
    });
  }
});

describe('stage meshes', () => {
  it('HeightSampler reproduces the heightfield at vertices and interpolates inside cells', () => {
    const hf = stage.heightfield;
    const hs = new HeightSampler(hf);
    for (const [ix, iz] of [[3, 4], [10, 20], [hf.nx - 2, hf.nz - 3]]) {
      const x = hf.originX + ix * hf.cellSize, z = hf.originZ + iz * hf.cellSize;
      expect(hs.heightAt(x, z)).toBeCloseTo(hf.heights[iz * hf.nx + ix], 4);
    }
    const ix = 7, iz = 9;
    const x = hf.originX + (ix + 0.5) * hf.cellSize, z = hf.originZ + (iz + 0.5) * hf.cellSize;
    const h00 = hf.heights[iz * hf.nx + ix], h11 = hf.heights[(iz + 1) * hf.nx + ix + 1];
    expect(hs.heightAt(x, z)).toBeCloseTo((h00 + h11) / 2, 4); // centre lies on the shared diagonal
  });

  it('terrain is chunked, finite, and sits below the road ribbon inside the road', () => {
    const t = buildTerrain(stage);
    const meshes = t.group.children.filter((c) => c.name !== 'skirt') as THREE.Mesh[];
    expect(meshes.length).toBeGreaterThan(1);
    for (const m of meshes) expect(finiteGeometry(m.geometry)).toBe(true);
    for (const s of [100, 333, 700]) {
      const r = stage.roadAt(s);
      expect(t.sampler.heightAt(r.pos.x, r.pos.z)).toBeLessThan(r.pos.y - 0.05);
    }
  });

  it('road ribbon: one mesh per surface + shoulders + line decals', () => {
    const t = buildTerrain(stage);
    const g = buildRoad(stage, t.sampler);
    const surfaces = new Set(stage.road.map((r) => r.surface));
    const roads = g.children.filter((c) => c.name.startsWith('road:'));
    expect(roads.length).toBe(surfaces.size);
    expect(g.children.some((c) => c.name === 'shoulders')).toBe(true);
    for (const m of roads as THREE.Mesh[]) {
      expect(finiteGeometry(m.geometry)).toBe(true);
      const n = m.geometry.attributes.normal;
      for (let i = 0; i < n.count; i += 7) expect(n.getY(i)).toBeGreaterThan(0.5);
    }
  });

  it('scenery: every kind has a model (gates excepted) and instances are batched', () => {
    const kinds = Object.keys(NOMINAL_HEIGHT) as SceneryKind[];
    for (const k of kinds) {
      const g = buildSceneryModel(k);
      if (k === 'startGate' || k === 'finishGate' || k === 'checkpointGate') expect(g).toBeNull();
      else {
        expect(g).not.toBeNull();
        expect(finiteGeometry(g!)).toBe(true);
        g!.computeBoundingBox();
        // nominal height within 35 %
        expect(g!.boundingBox!.max.y).toBeGreaterThan(NOMINAL_HEIGHT[k] * 0.65);
        expect(g!.boundingBox!.max.y).toBeLessThan(NOMINAL_HEIGHT[k] * 1.35);
      }
    }
    const t = buildTerrain(stage);
    const sc = buildScenery(stage, t.sampler);
    expect(sc.count).toBe(stage.scenery.length);
    const gates = sc.group.getObjectByName('gates')!;
    expect(gates.children.length).toBe(2 + stage.checkpoints.filter((c) => c < stage.length).length);
  });
});

describe('effects', () => {
  it('wheel slip is ~0 when rolling straight and grows with wheelspin and drift', () => {
    const car = new FakeCar(stage, 'awd_wrc', 100);
    car.speed = 20;
    car.advance(DT * 4);
    for (let i = 0; i < 4; i++) expect(wheelSlip(car.telemetry(), i).slip).toBeLessThan(0.05);
    car.wheelspin = 6;
    car.advance(DT * 4);
    expect(wheelSlip(car.telemetry(), 2).slip).toBeCloseTo(6, 1);
    car.wheelspin = 0;
    car.drift = 0.4;
    car.advance(DT * 4);
    expect(wheelSlip(car.telemetry(), 0).slip).toBeGreaterThan(5);
  });

  it('skid mark ring buffer wraps at capacity; particle pool never exceeds capacity', () => {
    const sk = new SkidMarks(50);
    const tr = sk.newTrack();
    for (let i = 0; i < 200; i++) sk.add(tr, i * 0.5, 0, 0, 1, 0, 0.1, 0x111111, 0.8);
    sk.flush();
    expect(sk.segments).toBe(50);
    const ps = new ParticleSystem(100);
    for (let i = 0; i < 300; i++) ps.emit({ x: 0, y: 0, z: 0, vx: 0, vy: 1, vz: 0, life: 1, s0: 1, s1: 2, color: 0xffffff, alpha: 0.5, grav: 0, drag: 0 });
    expect(ps.alive).toBe(100);
    ps.update(2);
    expect(ps.alive).toBe(0);
  });
});
