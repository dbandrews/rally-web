/**
 * src/render/weather.ts — falling snow / rain / drifting dust around the camera (render builder).
 * One Points (snow, dust) or LineSegments (rain) draw call in a box that wraps around the camera.
 */
import * as THREE from 'three';
import type { EnvironmentPreset } from '../core/types';

const BOX = { x: 70, y: 30, z: 70 };

function dotSprite(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Precipitation {
  readonly object: THREE.Object3D;
  private readonly kind: EnvironmentPreset['weather'];
  private readonly pos: Float32Array;
  private readonly n: number;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.Material;
  private readonly base: Float32Array;
  private t = 0;

  constructor(kind: EnvironmentPreset['weather'], density = 1) {
    this.kind = kind;
    const n = Math.round((kind === 'rain' ? 2500 : kind === 'snow' ? 2200 : 500) * density);
    this.n = n;
    this.base = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.base[i * 3] = Math.random() * BOX.x;
      this.base[i * 3 + 1] = Math.random() * BOX.y;
      this.base[i * 3 + 2] = Math.random() * BOX.z;
    }
    this.geo = new THREE.BufferGeometry();
    if (kind === 'rain') {
      this.pos = new Float32Array(n * 6);
      this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      this.mat = new THREE.LineBasicMaterial({ color: 0xb8c4d0, transparent: true, opacity: 0.35, depthWrite: false });
      this.object = new THREE.LineSegments(this.geo, this.mat);
    } else {
      this.pos = new Float32Array(n * 3);
      this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      this.mat = new THREE.PointsMaterial({
        color: kind === 'snow' ? 0xffffff : 0xd8c8a8,
        size: kind === 'snow' ? 0.12 : 0.05,
        map: dotSprite(),
        transparent: true,
        opacity: kind === 'snow' ? 0.9 : 0.5,
        depthWrite: false,
        sizeAttenuation: true,
      });
      this.object = new THREE.Points(this.geo, this.mat);
    }
    this.object.frustumCulled = false;
    this.object.name = `weather:${kind}`;
  }

  update(dt: number, cam: THREE.Vector3, carVel: THREE.Vector3): void {
    this.t += dt;
    const fall = this.kind === 'rain' ? 14 : this.kind === 'snow' ? 1.6 : 0.15;
    const ox = cam.x - BOX.x / 2, oy = cam.y - BOX.y / 2, oz = cam.z - BOX.z / 2;
    const wrap = (v: number, L: number) => ((v % L) + L) % L;
    for (let i = 0; i < this.n; i++) {
      const bx = this.base[i * 3], bz = this.base[i * 3 + 2];
      let by = this.base[i * 3 + 1] - fall * dt;
      this.base[i * 3 + 1] = by = wrap(by, BOX.y);
      const sway = this.kind === 'snow' ? Math.sin(this.t * 0.8 + i) * 0.6 : this.kind === 'dust' ? Math.sin(this.t * 0.3 + i * 0.7) * 1.5 : 0;
      const x = ox + wrap(bx - cam.x + sway, BOX.x);
      const y = oy + wrap(by - cam.y, BOX.y);
      const z = oz + wrap(bz - cam.z + (this.kind === 'snow' ? Math.cos(this.t * 0.6 + i) * 0.6 : 0), BOX.z);
      if (this.kind === 'rain') {
        const k = i * 6;
        this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
        // streak along fall + relative wind from the car's motion
        this.pos[k + 3] = x + carVel.x * 0.025;
        this.pos[k + 4] = y + 0.55;
        this.pos[k + 5] = z + carVel.z * 0.025;
      } else {
        const k = i * 3;
        this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.object.removeFromParent();
  }
}
