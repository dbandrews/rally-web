/**
 * src/render/orig/textures.ts — TextureStore: `.rtex` (public/assets/tex/<texId>.rtex) → THREE textures.
 *
 *   const store = new TextureStore(renderer);           // one per WebGLRenderer (GameRenderer owns it)
 *   const scope = store.scope();                        // per consumer (stage view, car); dispose() releases
 *   const tex  = await scope.get(texId, { wrapS: THREE.ClampToEdgeWrapping });
 *   const env  = await scope.getCube(faceIds);          // 6 ids +X,−X,+Y,−Y,+Z,−Z (TextureRegistry.cube)
 *   const bump = await scope.getVolume(texId);          // A8R8G8B8 volume (Anim_*, waterBump*)
 *
 * Upload rules (research/formats/textures.md §9.3, verifier notes):
 *   * DXT payloads are uploaded unchanged as S3TC when WEBGL_compressed_texture_s3tc exists — DXT1 always
 *     as RGBA_S3TC_DXT1 (D3D punch-through semantics), never the sRGB variants. `?s3tc=0` (or no extension)
 *     → the bit-exact JS decoder (dxt.ts) and RGBA8 uploads of the same levels (only VRAM differs).
 *   * the authored mip chain exactly (incl. chains that stop at 4×4 — texStorage2D(levels) keeps them
 *     complete); generateMipmaps = false; trilinear (LinearMipmapLinear / Linear), anisotropy 1;
 *     one-level textures use LinearFilter.
 *   * flipY = false (row 0 = top row: the original D3D UVs work unchanged), premultiplyAlpha = false,
 *     colorSpace = NoColorSpace (gamma-space maths, no sRGB decode).
 *   * RGB8 / L8 / P8 are expanded to RGBA8 per level at load (P8 through the palette per level).
 *   * Volumes: three r186's Data3DTexture uploads level 0 only, so authored volume mips (waterBump*: 6–7
 *     levels) are uploaded here by hand (texSubImage3D per level after renderer.initTexture). If three ever
 *     re-uploads such a texture (needsUpdate / context restore) only level 0 is refreshed.
 *   * Cube maps: CompressedCubeTexture (S3TC or RGBA8 faces) in file order +X,−X,+Y,−Y,+Z,−Z, faces as
 *     stored (flipY false). Faces are in the original/SIM frame: sample with `textureCube(env, vec3(d.x,
 *     d.y, -d.z))` for a three-space direction d (or envMapRotation = Euler(0, π, 0) on the plain
 *     textureCube material path; never PMREM).
 * Caching: one THREE texture per (texId(s), wrap, filter, palette) key; parsed files are shared between keys.
 * Textures stay alive while any scope (or an unscoped get) holds them. A texture nobody holds any more goes to an idle
 * pool (≤ IDLE_BUDGET bytes, oldest evicted first) instead of being freed at once, so a restart / same-stage reload or
 * a car re-add (which release the old holders before the new ones acquire) reuses the parsed file and the GPU copy;
 * flushIdle(beginGeneration()) frees what stayed idle across a stage load. TextureStore.dispose() frees all.
 * A holder keeps the entry it acquired (not just its key): a failed load is dropped from the cache, and releasing it
 * later never touches a newer entry of the same key.
 */
import * as THREE from 'three';
import { fetchArrayBuffer, texturePath, urlParam } from '../../core/assets';
import { RTEX_FLAG, RTEX_FORMAT, isDxtFormat, parseRtex, rtexLevelRGBA, type RtexImage } from './rtex';

export interface TexOptions {
  /** Default RepeatWrapping (D3D WRAP); ClampToEdgeWrapping for the `.rs` *Clamp* keys. Cubes default to clamp. */
  wrapS?: THREE.Wrapping;
  wrapT?: THREE.Wrapping;
  /** Volumes only (default RepeatWrapping). */
  wrapR?: THREE.Wrapping;
  /** Default: LinearMipmapLinearFilter with mips, LinearFilter for one-level textures. */
  minFilter?: THREE.MinificationTextureFilter;
  /** Default LinearFilter. */
  magFilter?: THREE.MagnificationTextureFilter;
  /** P8 sources only: expand through this palette (256 × RGBA8) instead of the file's own — the D3D "current
   *  palette" (the car / particle lightmap LUTs, common.ts lightmapLut). `key` identifies it in the cache. */
  palette?: { key: string; rgba: Uint8Array };
}

type Kind = '2d' | 'cube' | '3d';

/** @internal one cached texture; holders (scopes, pins) keep the Entry they acquired. */
export interface Entry {
  readonly key: string;
  promise: Promise<THREE.Texture>;
  texture: THREE.Texture | null;
  refs: number;
  ids: readonly string[];
  /** Approximate texture bytes (all levels / faces), known once loaded. */
  bytes: number;
  /** Generation in which the entry went idle (refs 0), −1 while held. */
  idleGen: number;
}

/** Bytes of unreferenced textures kept for reuse (TextureStore idle pool). */
export const IDLE_BUDGET = 96 * 1024 * 1024;

function levelBytes(m: { data?: ArrayBufferView | null } | null | undefined): number {
  return m?.data ? m.data.byteLength : 0;
}

/** Approximate size of a texture made by the store (its level data, every face). */
function textureBytes(t: THREE.Texture): number {
  const mips = (t as THREE.CompressedTexture).mipmaps as unknown as ({ data?: ArrayBufferView } | THREE.CompressedTexture)[] | undefined;
  if ((t as THREE.CompressedCubeTexture).isCompressedCubeTexture) {
    const faces = (t as THREE.CompressedCubeTexture).image as unknown as THREE.CompressedTexture[];
    return faces.reduce((a, f) => a + textureBytes(f), 0);
  }
  if (mips?.length) return mips.reduce((a, m) => a + levelBytes(m as { data?: ArrayBufferView }), 0);
  return levelBytes(t.image as { data?: ArrayBufferView });
}

/** S3TC available and not disabled by `?s3tc=0`. */
export function s3tcEnabled(renderer: THREE.WebGLRenderer): boolean {
  const q = urlParam('s3tc');
  if (q !== null && /^(0|false|no|off)$/i.test(q)) return false;
  try {
    return renderer.extensions.has('WEBGL_compressed_texture_s3tc');
  } catch {
    return false;
  }
}

function dxtThreeFormat(f: number): THREE.CompressedPixelFormat {
  return f === RTEX_FORMAT.DXT1 ? THREE.RGBA_S3TC_DXT1_Format : f === RTEX_FORMAT.DXT3 ? THREE.RGBA_S3TC_DXT3_Format : THREE.RGBA_S3TC_DXT5_Format;
}

const RGBA_AS_COMPRESSED = THREE.RGBAFormat as unknown as THREE.CompressedPixelFormat;

export interface TextureStoreOptions {
  /** Force the compressed (true) or decoded (false) path; default: s3tcEnabled(renderer). */
  s3tc?: boolean;
  /** Replace the file loader (tests / tools). Default: fetchArrayBuffer(tex/<id>.rtex). */
  load?: (texId: string) => Promise<ArrayBuffer>;
}

export class TextureStore {
  readonly renderer: THREE.WebGLRenderer;
  /** True when DXT levels are uploaded compressed. */
  readonly s3tc: boolean;
  private readonly load: (texId: string) => Promise<ArrayBuffer>;
  private readonly images = new Map<string, Promise<RtexImage>>();
  private readonly entries = new Map<string, Entry>();
  private readonly pinned = new Map<string, Entry>();
  /** Unreferenced entries kept for reuse, oldest first (Map insertion order). */
  private readonly idle = new Map<string, Entry>();
  private idleBytes = 0;
  private gen = 0;
  /** Byte budget of the idle pool (0 = free unreferenced textures at once). */
  idleBudget = IDLE_BUDGET;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, opts: TextureStoreOptions = {}) {
    this.renderer = renderer;
    this.s3tc = opts.s3tc ?? s3tcEnabled(renderer);
    this.load = opts.load ?? ((id) => fetchArrayBuffer(texturePath(id)));
  }

  /** Parsed `.rtex` (shared by every texture made from it). Rejects on fetch / parse errors. */
  image(texId: string): Promise<RtexImage> {
    let p = this.images.get(texId);
    if (!p) {
      p = this.load(texId).then((b) => parseRtex(b));
      p.catch(() => this.images.delete(texId));
      this.images.set(texId, p);
    }
    return p;
  }

  /** 2-D texture, held until store.dispose() (prefer a scope). */
  get(texId: string, opts: TexOptions = {}): Promise<THREE.Texture> {
    return this.pin(this.acquire('2d', [texId], opts));
  }

  /** Cube texture from 6 face ids (+X, −X, +Y, −Y, +Z, −Z), held until store.dispose(). */
  getCube(faces: readonly string[], opts: TexOptions = {}): Promise<THREE.CompressedCubeTexture> {
    return this.pin(this.acquire('cube', faces, opts)) as Promise<THREE.CompressedCubeTexture>;
  }

  /** 3-D (volume) texture, held until store.dispose(). */
  getVolume(texId: string, opts: TexOptions = {}): Promise<THREE.Data3DTexture> {
    return this.pin(this.acquire('3d', [texId], opts)) as Promise<THREE.Data3DTexture>;
  }

  /** A scope: textures it hands out are released by scope.dispose() (freed when no other holder remains). */
  scope(): TextureScope {
    return new TextureScope(this);
  }

  /** textures = held entries, idle = unreferenced ones kept for reuse (idleBytes of them), files = parsed `.rtex`. */
  stats(): { textures: number; idle: number; idleBytes: number; files: number; s3tc: boolean } {
    return { textures: this.entries.size - this.idle.size, idle: this.idle.size, idleBytes: this.idleBytes, files: this.images.size, s3tc: this.s3tc };
  }

  /** Start a load generation (renderer.loadStage): entries released from now on survive flushIdle(this value). */
  beginGeneration(): number {
    return ++this.gen;
  }

  /** Free the idle entries that went idle before generation `gen` (default: every idle entry). */
  flushIdle(gen = Infinity): void {
    for (const e of [...this.idle.values()]) if (e.idleGen < gen) this.evict(e);
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) e.texture?.dispose();
    this.entries.clear();
    this.images.clear();
    this.pinned.clear();
    this.idle.clear();
    this.idleBytes = 0;
  }

  // ------------------------------------------------------------------------------------- internals

  /** @internal the entry for (kind, ids, opts) with one more reference (a revived idle entry, the cached one or a new
   *  load). Release exactly that entry. */
  acquire(kind: Kind, ids: readonly string[], opts: TexOptions): Entry {
    if (this.disposed) throw new Error('TextureStore disposed');
    if (kind === 'cube' && ids.length !== 6) throw new Error(`cube texture needs 6 faces, got ${ids.length}`);
    const key = `${kind}|${ids.join(',')}|${opts.wrapS ?? ''},${opts.wrapT ?? ''},${opts.wrapR ?? ''}|${opts.minFilter ?? ''},${opts.magFilter ?? ''}${opts.palette ? `|pal:${opts.palette.key}` : ''}`;
    let e = this.entries.get(key);
    if (!e) {
      const entry: Entry = { key, promise: null as unknown as Promise<THREE.Texture>, texture: null, refs: 0, ids, bytes: 0, idleGen: -1 };
      entry.promise = this.create(kind, ids, opts).then((t) => {
        entry.texture = t;
        entry.bytes = textureBytes(t);
        if (this.entries.get(key) !== entry) t.dispose(); // evicted / store disposed while loading
        else if (entry.idleGen >= 0) {
          this.idleBytes += entry.bytes; // went idle while loading
          this.trimIdle();
        }
        return t;
      });
      // a failed load leaves the cache (the next acquire retries); its holders keep the dead entry until released
      entry.promise.catch(() => {
        if (this.entries.get(key) !== entry) return;
        this.entries.delete(key);
        if (this.idle.get(key) === entry) this.idle.delete(key);
      });
      this.entries.set(key, entry);
      e = entry;
    } else if (e.idleGen >= 0) {
      // revive an idle entry (restart / reload: the same texture again)
      this.idle.delete(key);
      this.idleBytes -= e.texture ? e.bytes : 0;
      e.idleGen = -1;
    }
    e.refs++;
    return e;
  }

  /** @internal drop one reference to `e` (the entry the holder acquired). */
  release(e: Entry): void {
    if (e.refs <= 0 || --e.refs > 0) return;
    if (this.entries.get(e.key) !== e) {
      e.texture?.dispose(); // a failed / replaced entry: never touches the current one of that key
      return;
    }
    if (this.idleBudget <= 0 || this.disposed) {
      this.evict(e);
      return;
    }
    e.idleGen = this.gen;
    this.idle.set(e.key, e);
    this.idleBytes += e.texture ? e.bytes : 0;
    this.trimIdle();
  }

  /** Evict the oldest idle entries while the pool is over budget. */
  private trimIdle(): void {
    for (const e of this.idle.values()) {
      if (this.idleBytes <= this.idleBudget) break;
      this.evict(e);
    }
  }

  /** Free an unreferenced entry now (texture, cache slot, and its parsed files once nothing else uses them). */
  private evict(e: Entry): void {
    if (this.idle.get(e.key) === e) {
      this.idle.delete(e.key);
      this.idleBytes -= e.texture ? e.bytes : 0;
    }
    e.idleGen = -1;
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
    e.texture?.dispose();
    for (const id of e.ids) if (![...this.entries.values()].some((o) => o.ids.includes(id))) this.images.delete(id);
  }

  private pin(e: Entry): Promise<THREE.Texture> {
    const held = this.pinned.get(e.key);
    if (held === e) this.release(e); // one pin per entry
    else {
      if (held) this.release(held); // the pinned entry of this key failed and was replaced
      this.pinned.set(e.key, e);
    }
    return e.promise;
  }

  private async create(kind: Kind, ids: readonly string[], opts: TexOptions): Promise<THREE.Texture> {
    const imgs = await Promise.all(ids.map((id) => this.image(id)));
    if (kind === '2d') return this.make2D(imgs[0], ids[0], opts);
    if (kind === 'cube') return this.makeCube(imgs, ids, opts);
    return this.makeVolume(imgs[0], ids[0], opts);
  }

  private mipmaps(img: RtexImage, palette?: Uint8Array | null): { compressed: boolean; mipmaps: THREE.CompressedTextureMipmap[] } {
    const compressed = this.s3tc && isDxtFormat(img.format);
    const mipmaps = img.levels.map((L, i) => ({ data: compressed ? L.data : rtexLevelRGBA(img, i, palette), width: L.width, height: L.height }));
    return { compressed, mipmaps };
  }

  private sampler(t: THREE.Texture, levels: number, opts: TexOptions, defWrap: THREE.Wrapping): void {
    t.wrapS = opts.wrapS ?? defWrap;
    t.wrapT = opts.wrapT ?? defWrap;
    t.magFilter = opts.magFilter ?? THREE.LinearFilter;
    t.minFilter = opts.minFilter ?? (levels > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter);
    t.anisotropy = 1;
    t.flipY = false;
    t.premultiplyAlpha = false;
    t.generateMipmaps = false;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
  }

  private make2D(img: RtexImage, id: string, opts: TexOptions): THREE.Texture {
    if (img.flags & RTEX_FLAG.VOLUME) throw new Error(`rtex ${id} is a volume: use getVolume`);
    const pal = opts.palette && img.format === RTEX_FORMAT.P8 ? opts.palette.rgba : null;
    const { compressed, mipmaps } = this.mipmaps(img, pal);
    const t = new THREE.CompressedTexture(mipmaps, img.width, img.height, compressed ? dxtThreeFormat(img.format) : RGBA_AS_COMPRESSED, THREE.UnsignedByteType);
    t.name = `rtex:${id}`;
    this.sampler(t, mipmaps.length, opts, THREE.RepeatWrapping);
    return t;
  }

  private makeCube(imgs: RtexImage[], ids: readonly string[], opts: TexOptions): THREE.CompressedCubeTexture {
    const f0 = imgs[0];
    for (const im of imgs) {
      if (im.format !== f0.format || im.width !== f0.width || im.height !== f0.height || im.levels.length !== f0.levels.length || im.flags & RTEX_FLAG.VOLUME) {
        throw new Error(`cube faces differ in format / size / levels: ${ids.join(',')}`);
      }
    }
    const faces = imgs.map((im) => {
      const { compressed, mipmaps } = this.mipmaps(im);
      return new THREE.CompressedTexture(mipmaps, im.width, im.height, compressed ? dxtThreeFormat(im.format) : RGBA_AS_COMPRESSED, THREE.UnsignedByteType);
    });
    const compressed = this.s3tc && isDxtFormat(f0.format);
    const t = new THREE.CompressedCubeTexture(faces, compressed ? dxtThreeFormat(f0.format) : RGBA_AS_COMPRESSED, THREE.UnsignedByteType);
    t.name = `rtex-cube:${ids[0]}`;
    this.sampler(t, f0.levels.length, opts, THREE.ClampToEdgeWrapping);
    return t;
  }

  private makeVolume(img: RtexImage, id: string, opts: TexOptions): THREE.Data3DTexture {
    const levels = img.levels.map((_, i) => rtexLevelRGBA(img, i));
    const t = new THREE.Data3DTexture(levels[0], img.width, img.height, img.depth);
    t.name = `rtex-3d:${id}`;
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapR = opts.wrapR ?? THREE.RepeatWrapping;
    // three allocates texStorage3D(texture.mipmaps.length levels) but uploads level 0 only: upload the rest here
    t.mipmaps = img.levels.map((L, i) => ({ data: levels[i], width: L.width, height: L.height }));
    this.sampler(t, levels.length, opts, THREE.RepeatWrapping);
    if (levels.length > 1) this.uploadVolumeMips(t, img, levels);
    return t;
  }

  private uploadVolumeMips(t: THREE.Data3DTexture, img: RtexImage, levels: Uint8Array[]): void {
    const r = this.renderer;
    r.initTexture(t);
    const gl = r.getContext() as WebGL2RenderingContext;
    const glTex = (r.properties.get(t) as { __webglTexture?: WebGLTexture }).__webglTexture;
    if (!glTex) throw new Error('volume texture was not allocated');
    r.state.bindTexture(gl.TEXTURE_3D, glTex);
    r.state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    r.state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    r.state.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (let i = 1; i < levels.length; i++) {
      const L = img.levels[i];
      gl.texSubImage3D(gl.TEXTURE_3D, i, 0, 0, 0, L.width, L.height, L.depth, gl.RGBA, gl.UNSIGNED_BYTE, levels[i]);
    }
    r.state.unbindTexture();
  }
}

/** Per-consumer handle on a TextureStore: the same getters; dispose() releases what it handed out (and the
 *  child scopes made with scope()). */
export class TextureScope {
  private readonly store: TextureStore;
  /** The entry this scope holds per key (one reference each). */
  private readonly held = new Map<string, Entry>();
  private readonly children = new Set<TextureScope>();
  private parent: TextureScope | null = null;
  private disposed = false;

  constructor(store: TextureStore) {
    this.store = store;
  }

  get s3tc(): boolean {
    return this.store.s3tc;
  }

  /** A child scope on the same store (released on its own dispose() or with this scope). */
  scope(): TextureScope {
    const c = new TextureScope(this.store);
    if (this.disposed) c.dispose();
    else {
      c.parent = this;
      this.children.add(c);
    }
    return c;
  }

  /** The parsed `.rtex` (shared with the store's textures; e.g. P8 index planes for CPU sampling). */
  image(texId: string): Promise<RtexImage> {
    return this.store.image(texId);
  }

  get(texId: string, opts: TexOptions = {}): Promise<THREE.Texture> {
    return this.hold(this.store.acquire('2d', [texId], opts));
  }

  getCube(faces: readonly string[], opts: TexOptions = {}): Promise<THREE.CompressedCubeTexture> {
    return this.hold(this.store.acquire('cube', faces, opts)) as Promise<THREE.CompressedCubeTexture>;
  }

  getVolume(texId: string, opts: TexOptions = {}): Promise<THREE.Data3DTexture> {
    return this.hold(this.store.acquire('3d', [texId], opts)) as Promise<THREE.Data3DTexture>;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of [...this.children]) c.dispose();
    this.children.clear();
    this.parent?.children.delete(this);
    this.parent = null;
    for (const e of this.held.values()) this.store.release(e);
    this.held.clear();
  }

  private hold(e: Entry): Promise<THREE.Texture> {
    if (this.disposed) {
      this.store.release(e);
      return Promise.reject(new Error('TextureScope disposed'));
    }
    const prev = this.held.get(e.key);
    if (prev === e) this.store.release(e); // one reference per entry and scope
    else {
      if (prev) this.store.release(prev); // the held entry of this key failed and was replaced by a retry
      this.held.set(e.key, e);
    }
    return e.promise;
  }
}
