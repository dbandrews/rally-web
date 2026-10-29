/**
 * src/render/livery.ts — original canvas liveries for the three archetypes (render builder).
 *
 * Designs are drawn in BODY coordinates (sim z along the car, y up / x across) through the same UV
 * layout the body uses (carModel.ts uvMapFor), so stripes follow the beltline and numbers land on the
 * doors. All names / words are invented for rally-web (content rule). Livery index 0 = ARCHETYPES colours;
 * higher indices pick alternative original palettes.
 */
import * as THREE from 'three';
import { ARCHETYPES } from '../core/constants';
import type { ArchetypeId } from '../core/types';
import { LIVERY_SIZE, PROFILES, sectionAt, uvMapFor, type CarProfile, type UvMap } from './carModel';
import { makeCanvas } from './textures';

export interface LiveryColors {
  body: number;
  accent: number;
  stripe: number;
  number: string;
  words: [string, string];
}

const ALT_PALETTES: { body: number; accent: number; stripe: number }[] = [
  { body: 0xf2f2ee, accent: 0x18325e, stripe: 0xe23b2a },
  { body: 0x151719, accent: 0xf5b800, stripe: 0x37c2e0 },
  { body: 0xf08a1c, accent: 0x202226, stripe: 0xffffff },
  { body: 0x6c2a8c, accent: 0xf2f2f2, stripe: 0x42d17a },
];

const NUMBERS: Record<ArchetypeId, string> = { awd_wrc: '7', fwd_hatch: '21', rwd_classic: '3' };
const WORDS: Record<ArchetypeId, [string, string]> = {
  awd_wrc: ['CORVANE', 'KESTRA'],
  fwd_hatch: ['TESSEL', 'VOLTERA'],
  rwd_classic: ['ARDENT', 'MARLOW'],
};

export function liveryColors(id: ArchetypeId, livery = 0): LiveryColors {
  const base = ARCHETYPES[id].colors;
  const pal = livery > 0 ? ALT_PALETTES[(livery - 1) % ALT_PALETTES.length] : base;
  return { body: pal.body, accent: pal.accent, stripe: pal.stripe, number: NUMBERS[id], words: WORDS[id] };
}

const hex = (v: number) => `#${v.toString(16).padStart(6, '0')}`;

class Painter {
  readonly ctx: CanvasRenderingContext2D;
  readonly uv: UvMap;
  readonly p: CarProfile;
  constructor(ctx: CanvasRenderingContext2D, p: CarProfile) {
    this.ctx = ctx;
    this.p = p;
    this.uv = uvMapFor(p);
  }
  /** Polygon in side coordinates [zSim, y], painted on both sides. */
  sidePoly(pts: [number, number][], color: number): void {
    for (const left of [true, false]) {
      const c = this.ctx;
      c.fillStyle = hex(color);
      c.beginPath();
      pts.forEach(([z, y], i) => {
        const [px, py] = this.uv.side(z, y, left);
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      });
      c.closePath();
      c.fill();
    }
  }
  /** Band following a function y(z) between z0..z1 with thickness h (metres). */
  sideBand(z0: number, z1: number, yOf: (z: number) => number, h: number, color: number): void {
    const top: [number, number][] = [], bot: [number, number][] = [];
    const n = 24;
    for (let i = 0; i <= n; i++) {
      const z = z0 + ((z1 - z0) * i) / n;
      const y = yOf(z);
      top.push([z, y + h / 2]);
      bot.push([z, y - h / 2]);
    }
    this.sidePoly([...top, ...bot.reverse()], color);
  }
  sideCircle(z: number, y: number, r: number, color: number): void {
    for (const left of [true, false]) {
      const [px, py] = this.uv.side(z, y, left);
      this.ctx.fillStyle = hex(color);
      this.ctx.beginPath();
      this.ctx.ellipse(px, py, r * this.uv.pxPerM[0], r * this.uv.pxPerM[1], 0, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }
  sideRect(z: number, y: number, w: number, h: number, color: number): void {
    this.sidePoly([[z + w / 2, y + h / 2], [z - w / 2, y + h / 2], [z - w / 2, y - h / 2], [z + w / 2, y - h / 2]], color);
  }
  /** Text centred at (z, y), cap height ≈ h metres. */
  sideText(text: string, z: number, y: number, h: number, color: number, weight = 900, maxW = 3): void {
    for (const left of [true, false]) {
      const [px, py] = this.uv.side(z, y, left);
      const c = this.ctx;
      c.save();
      c.translate(px, py);
      c.scale(1, this.uv.pxPerM[1] / this.uv.pxPerM[0]);
      c.fillStyle = hex(color);
      c.font = `${weight} ${Math.round(h * this.uv.pxPerM[0] * 1.35)}px "Arial Black", Impact, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, 0, 0, maxW * this.uv.pxPerM[0]);
      c.restore();
    }
  }
  topPoly(pts: [number, number][], color: number): void {
    const c = this.ctx;
    c.fillStyle = hex(color);
    c.beginPath();
    pts.forEach(([z, x], i) => {
      const [px, py] = this.uv.top(z, x);
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    });
    c.closePath();
    c.fill();
  }
  topStripe(z0: number, z1: number, x0: number, x1: number, color: number): void {
    this.topPoly([[z0, x0], [z0, x1], [z1, x1], [z1, x0]], color);
  }
  /** Text on the top view reading from behind the car (baseline across the car). */
  topText(text: string, z: number, x: number, h: number, color: number): void {
    const [px, py] = this.uv.top(z, x);
    const c = this.ctx;
    c.save();
    c.translate(px, py);
    c.rotate(-Math.PI / 2);
    c.fillStyle = hex(color);
    const pxm = 896 / (this.p.front - this.p.rear);
    c.font = `900 ${Math.round(h * pxm * 1.35)}px "Arial Black", Impact, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, 0, 0);
    c.restore();
  }
  topCircle(z: number, x: number, r: number, color: number): void {
    const [px, py] = this.uv.top(z, x);
    const pxm = 896 / (this.p.front - this.p.rear);
    this.ctx.fillStyle = hex(color);
    this.ctx.beginPath();
    this.ctx.ellipse(px, py, r * pxm, r * (256 / 2 / (Math.max(...this.p.w.map((k) => k[1])) + 0.05)), 0, 0, Math.PI * 2);
    this.ctx.fill();
  }
}

function paintAwd(pt: Painter, c: LiveryColors): void {
  const p = pt.p;
  const beltY = (z: number) => sectionAt(p, z).belt;
  // white swoosh rising from the front lower corner to the rear quarter
  pt.sidePoly(
    [
      [p.front + 0.1, -0.2],
      [0.6, -0.12],
      [-1.0, 0.12],
      [p.rear - 0.1, 0.3],
      [p.rear - 0.1, 0.05],
      [-1.0, -0.12],
      [0.6, -0.3],
      [p.front + 0.1, -0.4],
    ],
    c.accent,
  );
  // yellow pinstripe above it
  pt.sidePoly([[p.front + 0.1, -0.16], [0.6, -0.08], [-1.0, 0.16], [p.rear - 0.1, 0.34], [p.rear - 0.1, 0.31], [-1.0, 0.13], [0.6, -0.11], [p.rear * 0 + p.front + 0.1, -0.19]], c.stripe);
  // beltline accent
  pt.sideBand(p.front, p.rear, (z) => beltY(z) - 0.03, 0.03, c.stripe);
  // door number roundel
  pt.sideCircle(-0.08, 0.06, 0.2, 0xffffff);
  pt.sideText(c.number, -0.08, 0.06, 0.22, 0x111111);
  pt.sideText(c.words[0], 1.45, 0.14, 0.09, 0xffffff, 900, 0.8);
  pt.sideText(c.words[1], -1.62, 0.2, 0.08, c.body, 900, 0.8);
  // top: twin bonnet stripes, roof roundel
  pt.topStripe(p.front, 0.66, -0.2, -0.1, c.accent);
  pt.topStripe(p.front, 0.66, 0.1, 0.2, c.accent);
  pt.topStripe(p.front, 0.66, -0.06, 0.06, c.stripe);
  pt.topCircle(-0.8, 0, 0.32, 0xffffff);
  pt.topText(c.number, -0.8, 0, 0.36, 0x111111);
}

function paintFwd(pt: Painter, c: LiveryColors): void {
  const p = pt.p;
  // black lower body band
  pt.sidePoly([[p.front + 0.1, -0.05], [p.rear - 0.1, -0.02], [p.rear - 0.1, -0.5], [p.front + 0.1, -0.5]], c.accent);
  // three diagonal stripes across the doors
  for (let k = 0; k < 3; k++) {
    const z = 0.55 - k * 0.22;
    pt.sidePoly([[z, 0.42], [z - 0.12, 0.42], [z - 0.55, -0.05], [z - 0.43, -0.05]], c.stripe);
  }
  // number board
  pt.sideRect(-0.95, 0.16, 0.5, 0.3, 0xffffff);
  pt.sideText(c.number, -0.95, 0.16, 0.22, 0x111111);
  pt.sideText(c.words[0], 1.35, -0.12, 0.08, c.stripe, 900, 0.8);
  pt.sideText(c.words[1], -1.6, -0.13, 0.07, 0xffffff, 900, 0.7);
  // top: diagonal bonnet stripes, roof number
  for (let k = 0; k < 3; k++) pt.topStripe(1.8 - k * 0.22, 1.68 - k * 0.22, -0.7, 0.7, c.stripe);
  pt.topText(c.number, -0.9, 0, 0.34, 0xffffff);
}

function paintRwd(pt: Painter, c: LiveryColors): void {
  const p = pt.p;
  const beltY = (z: number) => sectionAt(p, z).belt;
  // cream lower half, red pinstripes at the split
  pt.sidePoly([[p.front + 0.1, 0.0], [p.rear - 0.1, 0.0], [p.rear - 0.1, -0.6], [p.front + 0.1, -0.6]], c.accent);
  pt.sideBand(p.front + 0.1, p.rear - 0.1, () => 0.02, 0.025, c.stripe);
  pt.sideBand(p.front + 0.1, p.rear - 0.1, () => 0.065, 0.012, c.stripe);
  pt.sideBand(p.front, p.rear, (z) => beltY(z) - 0.025, 0.02, c.accent);
  // square number plate on the door
  pt.sideRect(-0.12, 0.1, 0.42, 0.34, 0xffffff);
  pt.sideRect(-0.12, 0.1, 0.38, 0.3, 0xf6f2e6);
  pt.sideText(c.number, -0.12, 0.1, 0.24, 0x111111);
  pt.sideText(c.words[0], 1.25, -0.16, 0.08, c.body, 900, 0.8);
  pt.sideText(c.words[1], -1.45, -0.16, 0.08, c.stripe, 900, 0.7);
  // top: cream centre stripe with red pins over bonnet / roof / boot
  pt.topStripe(p.front, p.rear, -0.22, 0.22, c.accent);
  pt.topStripe(p.front, p.rear, -0.26, -0.235, c.stripe);
  pt.topStripe(p.front, p.rear, 0.235, 0.26, c.stripe);
  pt.topText(c.number, -0.62, 0, 0.3, 0x111111);
}

const liveryCache = new Map<string, THREE.Texture | null>();

/** Livery texture (sRGB) for archetype + livery index; null without a DOM. */
export function liveryTexture(id: ArchetypeId, livery = 0): THREE.Texture | null {
  const key = `${id}:${livery}`;
  if (liveryCache.has(key)) return liveryCache.get(key)!;
  const canvas = makeCanvas(LIVERY_SIZE, LIVERY_SIZE);
  if (!canvas) {
    liveryCache.set(key, null);
    return null;
  }
  const ctx = canvas.getContext('2d')!;
  const c = liveryColors(id, livery);
  ctx.fillStyle = hex(c.body);
  ctx.fillRect(0, 0, LIVERY_SIZE, LIVERY_SIZE);
  // subtle panel shading: slightly darker lower sides (reads as body curvature)
  const grd = ctx.createLinearGradient(0, 0, 0, 384);
  grd.addColorStop(0, 'rgba(255,255,255,0.06)');
  grd.addColorStop(0.7, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, LIVERY_SIZE, 384);
  ctx.save();
  ctx.translate(0, 384);
  ctx.fillRect(0, 0, LIVERY_SIZE, 384);
  ctx.restore();
  const pt = new Painter(ctx, PROFILES[id]);
  if (id === 'awd_wrc') paintAwd(pt, c);
  else if (id === 'fwd_hatch') paintFwd(pt, c);
  else paintRwd(pt, c);
  // panel gaps: door shut lines (dark, thin) on both sides
  const p = PROFILES[id];
  const doorF = p.sideGlass.length ? Math.max(...p.sideGlass.map((g) => g[1])) : 0.5;
  for (const z of [doorF + 0.05, (doorF + p.axleR) / 2 + 0.1]) {
    const s = sectionAt(p, z);
    pt.sidePoly([[z + 0.006, s.belt], [z - 0.006, s.belt], [z - 0.006, s.yb + 0.04], [z + 0.006, s.yb + 0.04]], 0x0e0e0e);
  }
  // plain cap area keeps the body colour
  ctx.fillStyle = hex(c.body);
  ctx.fillRect(928, 870, 64, 64);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  liveryCache.set(key, t);
  return t;
}
