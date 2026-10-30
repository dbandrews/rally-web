// DXT1/3/5 JS fallback decoder vs the verified numpy decoder (fixture: tools/assets/make_test_fixtures.py).
import { describe, expect, it } from 'vitest';
import { decodeDXT, type DxtFormat } from '../../src/render/orig/dxt';
import fixture from './fixtures/dxt.json';

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

interface Case {
  name: string;
  format: DxtFormat;
  width: number;
  height: number;
  data: string;
  rgba: string;
}
const cases = fixture.cases as Case[];

describe('decodeDXT (bit-exact with fmt_textures.decode_dxt)', () => {
  it('fixture covers every format, sub-4 levels and real blocks', () => {
    for (const f of ['DXT1', 'DXT3', 'DXT5']) expect(cases.some((c) => c.format === f)).toBe(true);
    expect(cases.some((c) => c.width < 4 || c.height < 4)).toBe(true);
    expect(cases.filter((c) => c.name.includes(':')).length).toBeGreaterThanOrEqual(4);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const got = decodeDXT(c.format, bytes(c.data), c.width, c.height);
    const want = bytes(c.rgba);
    expect(got.length).toBe(c.width * c.height * 4);
    let diff = 0;
    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) diff++;
    expect(diff).toBe(0);
  });

  it('DXT1 3-colour blocks decode index 3 as transparent black (punch-through foliage)', () => {
    const c = cases.find((x) => x.name.includes('co_grennleaf'))!;
    const got = decodeDXT('DXT1', bytes(c.data), c.width, c.height);
    let transparent = 0;
    for (let i = 0; i < got.length; i += 4) if (got[i + 3] === 0) {
      transparent++;
      expect([got[i], got[i + 1], got[i + 2]]).toEqual([0, 0, 0]);
    }
    expect(transparent).toBeGreaterThan(0);
  });

  it('writes into a caller buffer and rejects short input', () => {
    const c = cases[0];
    const out = new Uint8Array(c.width * c.height * 4);
    expect(decodeDXT(c.format, bytes(c.data), c.width, c.height, out)).toBe(out);
    expect(() => decodeDXT('DXT5', new Uint8Array(8), 4, 4)).toThrow();
  });
});
