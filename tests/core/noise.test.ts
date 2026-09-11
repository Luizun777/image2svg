import { describe, expect, it } from 'vitest';
import type { RasterImage } from '../../src/types';
import { immerkaerSigma } from '../../src/core/noise';
import {
  diagonalSweep,
  flatShapes3,
  gradientFeathers,
  hueRamp,
  noisePhoto,
  radialDisc,
  withNoise,
} from '../../src/dev/synth';

function raster(
  width: number,
  height: number,
  f: (x: number, y: number) => [number, number, number, number],
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(f(x, y), (y * width + x) * 4);
  return { data, width, height };
}

const grey96 = (): RasterImage => raster(96, 96, () => [128, 128, 128, 255]);

/** Immerkær without any exclusion, in Float64: every interior pixel whose 3×3 has alpha >= 250. */
function immerkaerAll(img: RasterImage): number {
  const { width: w, height: h, data: d } = img;
  const L = (x: number, y: number): number => {
    const o = (y * w + x) * 4;
    return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  };
  let sum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let opaque = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (d[((y + dy) * w + x + dx) * 4 + 3] < 250) opaque = false;
      if (!opaque) continue;
      const v =
        L(x - 1, y - 1) - 2 * L(x, y - 1) + L(x + 1, y - 1) - 2 * L(x - 1, y) + 4 * L(x, y) - 2 * L(x + 1, y) +
        L(x - 1, y + 1) - 2 * L(x, y + 1) + L(x + 1, y + 1);
      sum += Math.abs(v);
      n++;
    }
  }
  return n === 0 ? 0 : (Math.sqrt(Math.PI / 2) * sum) / (6 * n);
}

describe('immerkaerSigma', () => {
  it('is 0 on a flat colour, on an exact linear ramp and on images under 3×3', () => {
    expect(immerkaerSigma(grey96())).toBe(0);
    // Integer ramp 10 + 3x + 2y per channel (N cancels anything linear): 0 up to the Float32 luma (measured 2.3e-6).
    expect(immerkaerSigma(raster(40, 30, (x, y) => [10 + 3 * x, 20 + 2 * y, 5 + x + y, 255]))).toBeLessThan(1e-4);
    expect(immerkaerSigma(raster(2, 5, () => [9, 200, 30, 255]))).toBe(0);
    expect(immerkaerSigma(raster(0, 0, () => [0, 0, 0, 0]))).toBe(0);
  });

  it('clean ramps stay under 0.3 (plan): hueRamp 0.000, diagonalSweep 0.162, radialDisc 0.092', () => {
    expect(immerkaerSigma(hueRamp(96).image)).toBeLessThan(0.3);
    expect(immerkaerSigma(diagonalSweep(128).image)).toBeLessThan(0.3);
    expect(immerkaerSigma(radialDisc(128).image)).toBeLessThan(0.3);
  });

  it('strong edges are excluded: clean flatShapes3 < 1 (plan; 0.000, 0.480 without exclusion), clean gradientFeathers 0.010 (0.979)', () => {
    const shapes = flatShapes3(96).image;
    expect(immerkaerAll(shapes)).toBeGreaterThan(0.4);
    expect(immerkaerSigma(shapes)).toBeLessThan(0.05);
    const feathers = gradientFeathers(256).image;
    expect(immerkaerAll(feathers)).toBeGreaterThan(0.9);
    expect(immerkaerSigma(feathers)).toBeLessThan(0.05);
  });

  it('uniform ±3 noise per channel reads σ̂ in [1.33, 1.40] on flat content (luma σ 0.669·2 = 1.337; the plan range [1.4, 2.1] is unreachable)', () => {
    for (const seed of [1, 2, 3]) {
      for (const [name, img] of [
        ['grey', grey96()],
        ['hueRamp', hueRamp(96).image],
        ['flatShapes3', flatShapes3(96).image],
        ['noisePhoto', noisePhoto(256)],
      ] as const) {
        const s = immerkaerSigma(withNoise(img, 3, seed));
        expect(s, `${name} seed ${seed}`).toBeGreaterThanOrEqual(1.33);
        expect(s, `${name} seed ${seed}`).toBeLessThanOrEqual(1.4);
      }
    }
  });

  it('edges no longer inflate the noise of gradient art: gradientFeathers ±3 reads 0.79 (1.71 without exclusion; white clamps half of it)', () => {
    for (const seed of [1, 2, 3]) {
      const img = withNoise(gradientFeathers(256).image, 3, seed);
      expect(immerkaerAll(img)).toBeGreaterThan(1.7);
      const s = immerkaerSigma(img);
      expect(s).toBeGreaterThan(0.75);
      expect(s).toBeLessThan(0.85);
    }
  });

  it('noisePhoto is a smooth field (0.199; the plan asked > 3, unreachable: its bilinear lattices hold no pixel noise); real ±10 noise reads > 3', () => {
    const s = immerkaerSigma(noisePhoto(256));
    expect(s).toBeGreaterThan(0.15);
    expect(s).toBeLessThan(0.25);
    expect(immerkaerSigma(withNoise(grey96(), 10, 1))).toBeGreaterThan(3);
    expect(immerkaerSigma(withNoise(noisePhoto(256), 10, 1))).toBeGreaterThan(3);
  });

  it('a steep noisy ramp (8 levels/px) is not excluded as an edge: σ̂ in [1.2, 1.5]', () => {
    const ramp = raster(28, 28, (x) => {
      const v = 20 + 8 * x;
      return [v, v, v, 255];
    });
    for (const seed of [1, 2, 3]) {
      const s = immerkaerSigma(withNoise(ramp, 3, seed));
      expect(s).toBeGreaterThan(1.2);
      expect(s).toBeLessThan(1.5);
    }
  });

  it('with no strong edge nearby it equals Immerkær over every opaque interior pixel', () => {
    for (const seed of [1, 2]) {
      const img = withNoise(grey96(), 3, seed);
      expect(immerkaerSigma(img)).toBeCloseTo(immerkaerAll(img), 5);
    }
  });

  it('when every pixel is near a strong edge the estimate falls back to the one without exclusion', () => {
    // 2×2 checkerboard 0/255: Sobel 255 everywhere, N ≠ 0.
    const board = raster(24, 24, (x, y) => ((((x >> 1) + (y >> 1)) & 1) === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const all = immerkaerAll(board);
    expect(all).toBeGreaterThan(10);
    expect(immerkaerSigma(board)).toBeCloseTo(all, 4);
  });

  it('only interior pixels whose whole 3×3 is opaque (alpha >= 250) count', () => {
    const rnd = withNoise(raster(64, 64, () => [128, 128, 128, 255]), 40, 7);
    // Left half flat and opaque; right half the noise with alpha 249 (or 0).
    for (const alpha of [0, 249]) {
      const img = raster(64, 64, (x, y) => {
        if (x < 32) return [90, 90, 90, 255];
        const o = (y * 64 + x) * 4;
        return [rnd.data[o], rnd.data[o + 1], rnd.data[o + 2], alpha];
      });
      expect(immerkaerSigma(img), `alpha ${alpha}`).toBe(0);
    }
    const allTransparent = raster(16, 16, (x) => [x * 10, 0, 0, 0]);
    expect(immerkaerSigma(allTransparent)).toBe(0);
  });

  it('does not mutate its input', () => {
    const img = withNoise(flatShapes3(96).image, 3, 1);
    const copy = new Uint8ClampedArray(img.data);
    immerkaerSigma(img);
    expect(img.data).toEqual(copy);
  });
});
