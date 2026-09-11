import { describe, expect, it } from 'vitest';
import type { RasterImage } from '../../src/types';
import { diffHeatmap } from '../../src/metrics/diffMap';
import { aaCircle } from '../../src/dev/synth';
import { cloneRaster } from '../../src/core/raster';

function raster(
  width: number,
  height: number,
  f: (x: number, y: number) => [number, number, number, number],
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = f(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { data, width, height };
}

function px(img: RasterImage, x: number, y: number): [number, number, number, number] {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

describe('diffHeatmap', () => {
  it('identical images -> every pixel fully transparent (0,0,0,0)', () => {
    const img = aaCircle(32, 10).image;
    const out = diffHeatmap(img, cloneRaster(img));
    expect([out.width, out.height]).toEqual([32, 32]);
    expect(out.data.length).toBe(32 * 32 * 4);
    let nonZero = 0;
    for (let i = 0; i < out.data.length; i++) if (out.data[i] !== 0) nonZero++;
    expect(nonZero).toBe(0);
  });

  it('a fully different pixel is opaque and red-ish', () => {
    const a = raster(3, 1, () => [0, 0, 0, 255]);
    const b = raster(3, 1, (x) => (x === 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = diffHeatmap(a, b);
    const [r, g, bl, al] = px(out, 1, 0);
    expect(al).toBe(255);
    expect(r).toBeGreaterThanOrEqual(200);
    expect(g).toBeLessThan(80);
    expect(bl).toBeLessThan(80);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(bl);
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(out, 2, 0)).toEqual([0, 0, 0, 0]);
  });

  it('delta <= 16 is transparent; delta 17 is faint yellow with alpha 51', () => {
    const a = raster(2, 1, () => [100, 100, 100, 255]);
    const b = raster(2, 1, (x) => (x === 0 ? [116, 100, 100, 255] : [100, 100, 117, 255]));
    const out = diffHeatmap(a, b);
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 0]);
    const [r, g, bl, al] = px(out, 1, 0);
    expect(al).toBe(51); // min(255, round(17/255 * 765)) = 51
    expect(r).toBe(255);
    expect(g).toBeGreaterThan(150); // yellow: strong green component
    expect(bl).toBe(0);
  });

  it('alpha = min(255, d*765) and the ramp goes yellow -> orange -> red', () => {
    const a = raster(4, 1, () => [0, 0, 0, 255]);
    // deltas: 76 (d = 0.298, yellow), 100 (alpha saturates), 115 (d = 0.45, orange), 153 (d = 0.6, red)
    const b = raster(4, 1, (x) => [[76, 100, 115, 153][x], 0, 0, 255]);
    const out = diffHeatmap(a, b);
    const yellow = px(out, 0, 0);
    expect(yellow[3]).toBe(228); // 76 * 3
    expect(yellow[0]).toBe(255);
    expect(yellow[1]).toBeGreaterThan(180);
    expect(yellow[2]).toBe(0);
    expect(px(out, 1, 0)[3]).toBe(255); // 100 * 3 = 300 -> 255
    const orange = px(out, 2, 0);
    expect(orange[0]).toBeGreaterThanOrEqual(240);
    expect(orange[1]).toBeGreaterThan(80);
    expect(orange[1]).toBeLessThan(yellow[1]);
    const red = px(out, 3, 0);
    expect(red[3]).toBe(255);
    expect(red[0]).toBeGreaterThanOrEqual(200);
    expect(red[1]).toBeLessThan(80);
    expect(red[1]).toBeLessThan(orange[1]);
    // Monotone: green decreases along the ramp.
    expect(yellow[1]).toBeGreaterThan(orange[1]);
    expect(orange[1]).toBeGreaterThan(red[1]);
  });

  it('uses the maximum RGB channel delta and ignores alpha', () => {
    const a = raster(2, 1, () => [50, 50, 50, 255]);
    const b = raster(2, 1, (x) => (x === 0 ? [50, 50, 50, 0] : [50, 60, 250, 255]));
    const out = diffHeatmap(a, b);
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(out, 1, 0)[3]).toBe(255); // delta 200 -> red, opaque
    expect(px(out, 1, 0)[0]).toBeGreaterThanOrEqual(200);
  });

  it('does not mutate inputs and throws on size mismatch', () => {
    const a = aaCircle(16, 5).image;
    const b = raster(16, 16, () => [255, 255, 255, 255]);
    const aBefore = Array.from(a.data);
    const bBefore = Array.from(b.data);
    const out = diffHeatmap(a, b);
    expect(out.data).not.toBe(a.data);
    expect(Array.from(a.data)).toEqual(aBefore);
    expect(Array.from(b.data)).toEqual(bBefore);
    expect(() => diffHeatmap(a, raster(16, 8, () => [0, 0, 0, 255]))).toThrow(/tamaños/);
  });
});
