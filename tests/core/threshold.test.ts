import { describe, expect, it } from 'vitest';
import type { GrayImage, RasterImage, RGB } from '../../src/types';
import {
  binarize,
  histogram256,
  isBimodal,
  maskFromAlpha,
  otsu,
  resolveThreshold,
} from '../../src/core/threshold';
import { coverage, grayToRaster } from '../../src/dev/synth';
import { toGray } from '../../src/core/raster';
import { countInk } from '../../src/core/morphology';

function gray(values: number[], width = values.length, height = 1): GrayImage {
  return { data: Float32Array.from(values), width, height };
}

/** Luma of an anti-aliased disc (radius r, centred) of colour `ink` over `bg`. */
function discGray(ink: RGB, bg: RGB, size = 64, r = 20): GrayImage {
  const c = size / 2;
  return toGray(grayToRaster(coverage(size, (x, y) => Math.hypot(x - c, y - c) - r), size, ink, bg));
}

/** Histogram of a mixture of Gaussians (continuous densities sampled on integer bins). */
function gaussianMixture(parts: Array<{ mean: number; sigma: number; weight: number }>): Float64Array {
  const h = new Float64Array(256);
  for (const { mean, sigma, weight } of parts) {
    for (let i = 0; i < 256; i++) {
      h[i] += (weight * Math.exp(-((i - mean) * (i - mean)) / (2 * sigma * sigma))) / sigma;
    }
  }
  return h;
}

describe('histogram256', () => {
  it('rounds to nearest, clamps and counts every pixel', () => {
    const img = gray([0.4, 0.5, 1.49, 254.6, 300, -3, 255, 127.5]);
    const h = histogram256(img);
    expect(h.length).toBe(256);
    expect(h[0]).toBe(2); // 0.4, -3
    expect(h[1]).toBe(2); // 0.5, 1.49
    expect(h[255]).toBe(3); // 254.6, 300, 255
    expect(h[128]).toBe(1); // 127.5 rounds up
    let total = 0;
    for (let i = 0; i < 256; i++) total += h[i];
    expect(total).toBe(8);
  });

  it('NaN values fall into bin 0 instead of being lost', () => {
    const h = histogram256(gray([Number.NaN, 10]));
    expect(h[0]).toBe(1);
    expect(h[10]).toBe(1);
  });
});

describe('otsu', () => {
  it('splits two Gaussians at 60 and 200 between 110 and 150', () => {
    const h = gaussianMixture([
      { mean: 60, sigma: 10, weight: 1 },
      { mean: 200, sigma: 10, weight: 1 },
    ]);
    const t = otsu(h);
    expect(t).toBeGreaterThanOrEqual(110);
    expect(t).toBeLessThanOrEqual(150);
    // Unequal weights: still in the gap.
    const h2 = gaussianMixture([
      { mean: 60, sigma: 12, weight: 0.2 },
      { mean: 200, sigma: 8, weight: 1 },
    ]);
    const t2 = otsu(h2);
    expect(t2).toBeGreaterThanOrEqual(100);
    expect(t2).toBeLessThanOrEqual(160);
  });

  it('two pure deltas -> middle of the flat gap (pixel < t is ink)', () => {
    const h = new Float64Array(256);
    h[50] = 30;
    h[200] = 70;
    const t = otsu(h);
    // Ties for every t in 51..200 -> middle 125.5 -> 126.
    expect(t).toBe(126);
  });

  it('threshold obeys the polarity: pixels of the dark mode are < t, bright are >= t', () => {
    const h = new Float64Array(256);
    h[0] = 10;
    h[1] = 10;
    h[2] = 10;
    h[255] = 5;
    const t = otsu(h);
    expect(t).toBeGreaterThan(2);
    expect(t).toBeLessThanOrEqual(255);
  });

  it('degenerate histograms return 128', () => {
    expect(otsu(new Float64Array(256))).toBe(128);
    const single = new Float64Array(256);
    single[200] = 99;
    expect(otsu(single)).toBe(128);
  });

  it('otsu of an actual image is consistent with histogram256', () => {
    const vals: number[] = [];
    for (let i = 0; i < 500; i++) vals.push(i < 250 ? 40 + (i % 7) : 210 + (i % 5));
    const t = otsu(histogram256(gray(vals)));
    expect(t).toBeGreaterThan(46);
    expect(t).toBeLessThanOrEqual(210);
  });
});

describe('resolveThreshold', () => {
  it('two pure levels -> the 50 % coverage iso-level (I + P) / 2, then the offset', () => {
    const img = gray([0, 0, 255, 255]);
    expect(resolveThreshold(img, 0)).toBeCloseTo(127.5 / 255, 10);
    expect(resolveThreshold(img, 0.1)).toBeCloseTo(127.5 / 255 + 0.1, 10);
    expect(resolveThreshold(img, -0.2)).toBeCloseTo(127.5 / 255 - 0.2, 10);
  });

  it('light ink on white is not clamped away: orange, cyan, gold and light grey land half way to the paper', () => {
    const inks: RGB[] = [
      [255, 165, 0],
      [0, 255, 255],
      [255, 215, 0],
      [211, 211, 211],
    ];
    for (const ink of inks) {
      const luma = Math.round(0.299 * ink[0] + 0.587 * ink[1] + 0.114 * ink[2]);
      const img = discGray(ink, [255, 255, 255]);
      const t = resolveThreshold(img, 0);
      expect(Math.abs(t * 255 - (luma + 255) / 2), `ink ${ink.join(',')}`).toBeLessThanOrEqual(1.5);
      // The old clamp (<= 0.65) left these discs without a single ink pixel.
      const area = countInk(binarize(img, t)) / (Math.PI * 400);
      expect(area, `ink ${ink.join(',')}`).toBeGreaterThan(0.95);
      expect(area, `ink ${ink.join(',')}`).toBeLessThan(1.05);
    }
  });

  it('dark ink on a dark background: navy on #303030 splits between both levels instead of going all-ink', () => {
    const img = discGray([0, 0, 128], [48, 48, 48]);
    const t = resolveThreshold(img, 0);
    expect(Math.abs(t * 255 - (15 + 48) / 2)).toBeLessThanOrEqual(1.5);
    const area = countInk(binarize(img, t)) / (Math.PI * 400);
    expect(area).toBeGreaterThan(0.95);
    expect(area).toBeLessThan(1.05);
  });

  it('thin strokes: the ink level is a low percentile of the ink class, not its bulk of AA pixels', () => {
    // 900 px of paper (240), 10 fully covered ink pixels (20) and 90 anti-aliased ones (150).
    const vals = [...new Array<number>(900).fill(240), ...new Array<number>(10).fill(20), ...new Array<number>(90).fill(150)];
    expect(resolveThreshold(gray(vals), 0) * 255).toBeCloseTo((20 + 240) / 2, 6);
  });

  it('invert: the ink is the bright class and its level a high percentile of it', () => {
    const vals = [...new Array<number>(900).fill(10), ...new Array<number>(10).fill(235), ...new Array<number>(90).fill(120)];
    expect(resolveThreshold(gray(vals), 0, true) * 255).toBeCloseTo((235 + 10) / 2, 6);
    expect(resolveThreshold(gray([0, 0, 255, 255]), 0, true)).toBeCloseTo(127.5 / 255, 10);
  });

  it('without a usable ink/paper separation (< 24 levels) it falls back to clamp(otsu/255, 0.35, 0.65)', () => {
    const close = gray([100, 100, 110, 110]);
    expect(resolveThreshold(close, 0)).toBeCloseTo(otsu(histogram256(close)) / 255, 10);
    const dark = gray([0, 0, 10, 10]); // otsu 6 -> 0.024 -> clamped to 0.35
    expect(resolveThreshold(dark, 0)).toBeCloseTo(0.35, 10);
    expect(resolveThreshold(dark, 0.1)).toBeCloseTo(0.45, 10);
    const bright = gray([240, 240, 255, 255]); // otsu 248 -> 0.97 -> clamped to 0.65
    expect(resolveThreshold(bright, 0)).toBeCloseTo(0.65, 10);
    expect(resolveThreshold(bright, -0.2)).toBeCloseTo(0.45, 10);
    // A constant image has no split at all.
    expect(resolveThreshold(gray([200, 200, 200]), 0)).toBeCloseTo(128 / 255, 10);
  });

  it('final clamp to [0.02, 0.98] and non-finite offset -> 0', () => {
    const img = gray([0, 0, 255, 255]);
    expect(resolveThreshold(img, -5)).toBe(0.02);
    expect(resolveThreshold(img, 5)).toBe(0.98);
    expect(resolveThreshold(img, Number.NaN)).toBeCloseTo(127.5 / 255, 10);
  });
});

describe('binarize', () => {
  it('ink = gray < t*255 (1 = ink); boundary value is not ink', () => {
    const img = gray([0, 127, 127.5, 128, 255], 5, 1);
    const m = binarize(img, 0.5);
    expect(Array.from(m.data)).toEqual([1, 1, 0, 0, 0]);
    expect([m.width, m.height]).toEqual([5, 1]);
  });

  it('invert flips the polarity to gray >= t*255', () => {
    const img = gray([0, 127, 127.5, 128, 255]);
    expect(Array.from(binarize(img, 0.5, true).data)).toEqual([0, 0, 1, 1, 1]);
  });

  it('t = 0 -> nothing, t = 1 -> everything below 255', () => {
    const img = gray([0, 100, 254.9, 255]);
    expect(Array.from(binarize(img, 0).data)).toEqual([0, 0, 0, 0]);
    expect(Array.from(binarize(img, 1).data)).toEqual([1, 1, 1, 0]);
  });
});

describe('maskFromAlpha', () => {
  it('ink = alpha >= t*255 with default t = 0.5 (127.5)', () => {
    const img: RasterImage = {
      data: Uint8ClampedArray.from([0, 0, 0, 0, 0, 0, 0, 127, 0, 0, 0, 128, 0, 0, 0, 255]),
      width: 2,
      height: 2,
    };
    expect(Array.from(maskFromAlpha(img).data)).toEqual([0, 0, 1, 1]);
    expect(Array.from(maskFromAlpha(img, 0.1).data)).toEqual([0, 1, 1, 1]); // 25.5
    expect(Array.from(maskFromAlpha(img, 1).data)).toEqual([0, 0, 0, 1]);
  });
});

describe('isBimodal', () => {
  it('true for two Gaussians at 60 and 200', () => {
    const h = gaussianMixture([
      { mean: 60, sigma: 10, weight: 1 },
      { mean: 200, sigma: 10, weight: 1 },
    ]);
    expect(isBimodal(h)).toBe(true);
    // Unequal masses (scanned text: mostly paper) still bimodal.
    const text = gaussianMixture([
      { mean: 30, sigma: 8, weight: 0.05 },
      { mean: 240, sigma: 5, weight: 1 },
    ]);
    expect(isBimodal(text)).toBe(true);
    // Wider but still separated clusters (σ = 25).
    const wide = gaussianMixture([
      { mean: 60, sigma: 25, weight: 1 },
      { mean: 200, sigma: 25, weight: 1 },
    ]);
    expect(isBimodal(wide)).toBe(true);
  });

  it('true for two pure levels (a clean binary image)', () => {
    const h = new Float64Array(256);
    h[0] = 120;
    h[255] = 880;
    expect(isBimodal(h)).toBe(true);
  });

  it('false for a uniform ramp', () => {
    const uniform = new Float64Array(256).fill(1);
    expect(isBimodal(uniform)).toBe(false);
    const ramp = histogram256(gray(Array.from({ length: 256 }, (_, i) => i), 16, 16));
    expect(isBimodal(ramp)).toBe(false);
  });

  it('false for a single Gaussian, a constant and an empty histogram', () => {
    expect(isBimodal(gaussianMixture([{ mean: 128, sigma: 30, weight: 1 }]))).toBe(false);
    const single = new Float64Array(256);
    single[77] = 1000;
    expect(isBimodal(single)).toBe(false);
    expect(isBimodal(new Float64Array(256))).toBe(false);
  });
});
