import { describe, expect, it } from 'vitest';
import type { RasterImage, RGB } from '../../src/types';
import { TRANSPARENT_AUTO_RATIO, resolveAlphaMode, resolveBackground } from '../../src/core/background';

function opaque(width: number, height: number, rgb: RGB): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < data.length; p += 4) data.set([rgb[0], rgb[1], rgb[2], 255], p);
  return { data, width, height };
}

/** Image with the first `n` pixels transparent (alpha 0), the rest opaque. */
function withTransparent(width: number, height: number, n: number): RasterImage {
  const img = opaque(width, height, [40, 40, 40]);
  for (let i = 0; i < n; i++) img.data[i * 4 + 3] = 0;
  return img;
}

describe('resolveBackground', () => {
  const img = opaque(4, 4, [200, 200, 200]);

  it('explicit settings pass through', () => {
    expect(resolveBackground(img, 'white', { borderColor: [1, 2, 3] })).toEqual([255, 255, 255]);
    expect(resolveBackground(img, 'transparent', { borderColor: [1, 2, 3] })).toBeNull();
    const rgb: RGB = [10, 20, 30];
    const out = resolveBackground(img, { rgb }, { borderColor: null });
    expect(out).toEqual([10, 20, 30]);
    expect(out).not.toBe(rgb); // a copy, never the caller's array
  });

  it('explicit rgb is clamped and rounded to bytes', () => {
    expect(resolveBackground(img, { rgb: [-5, 300, 12.6] }, { borderColor: null })).toEqual([0, 255, 13]);
  });

  it('auto: opaque image uses the border colour, else white', () => {
    expect(resolveBackground(img, 'auto', { borderColor: [7, 8, 9] })).toEqual([7, 8, 9]);
    expect(resolveBackground(img, 'auto', { borderColor: null })).toEqual([255, 255, 255]);
    expect(resolveBackground(withTransparent(10, 10, 5), 'auto', { borderColor: [7, 8, 9] })).toEqual([7, 8, 9]); // 5 % is not > 5 %
  });

  it('auto: image with > 5 % transparent pixels -> transparent', () => {
    expect(resolveBackground(withTransparent(10, 10, 6), 'auto', { borderColor: [7, 8, 9] })).toBeNull();
    expect(resolveBackground(withTransparent(10, 10, 100), 'auto', { borderColor: null })).toBeNull();
  });

  it('auto: pixels with alpha 7 count as transparent, alpha 8 does not', () => {
    const a7 = opaque(10, 10, [1, 1, 1]);
    for (let i = 0; i < 10; i++) a7.data[i * 4 + 3] = 7;
    expect(resolveBackground(a7, 'auto', { borderColor: null })).toBeNull();
    const a8 = opaque(10, 10, [1, 1, 1]);
    for (let i = 0; i < 10; i++) a8.data[i * 4 + 3] = 8;
    expect(resolveBackground(a8, 'auto', { borderColor: null })).toEqual([255, 255, 255]);
  });

  it('returns a fresh array for the border colour (no aliasing)', () => {
    const border: RGB = [7, 8, 9];
    const out = resolveBackground(img, 'auto', { borderColor: border });
    expect(out).toEqual(border);
    expect(out).not.toBe(border);
  });
});

describe('resolveAlphaMode', () => {
  it('explicit values pass through regardless of the ratio', () => {
    expect(resolveAlphaMode({ transparentRatio: 0.9 }, 'composite')).toBe('composite');
    expect(resolveAlphaMode({ transparentRatio: 0 }, 'mask')).toBe('mask');
  });

  it("auto: 'mask' when transparentRatio > 0.05, else 'composite'", () => {
    expect(TRANSPARENT_AUTO_RATIO).toBe(0.05);
    expect(resolveAlphaMode({ transparentRatio: 0.051 }, 'auto')).toBe('mask');
    expect(resolveAlphaMode({ transparentRatio: 0.05 }, 'auto')).toBe('composite');
    expect(resolveAlphaMode({ transparentRatio: 0 }, 'auto')).toBe('composite');
    expect(resolveAlphaMode({ transparentRatio: 1 }, 'auto')).toBe('mask');
  });
});
