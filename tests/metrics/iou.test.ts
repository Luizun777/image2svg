import { describe, expect, it } from 'vitest';
import type { BinaryMask, GrayImage, RasterImage } from '../../src/types';
import { iou, mae, pctDiff } from '../../src/metrics/iou';
import { maskIoU } from '../fixtures/helpers';
import { aaCircle } from '../../src/dev/synth';

function mask(width: number, height: number, f: (x: number, y: number) => number): BinaryMask {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y);
  return { data, width, height };
}

function gray(width: number, height: number, f: (x: number, y: number) => number): GrayImage {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y);
  return { data, width, height };
}

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

describe('iou', () => {
  it('computes intersection / union with concrete counts', () => {
    // a: x < 6 (60 px), b: x >= 4 (60 px), overlap x in [4,6) (20 px), union 100 px.
    const a = mask(10, 10, (x) => (x < 6 ? 1 : 0));
    const b = mask(10, 10, (x) => (x >= 4 ? 1 : 0));
    expect(iou(a, b)).toBeCloseTo(20 / 100, 12);
    expect(iou(a, a)).toBe(1);
    expect(iou(a, b)).toBeCloseTo(maskIoU(a, b), 12);
  });

  it('both empty -> 1; one empty -> 0', () => {
    const empty = mask(5, 5, () => 0);
    const full = mask(5, 5, () => 1);
    expect(iou(empty, empty)).toBe(1);
    expect(iou(empty, full)).toBe(0);
    expect(iou(full, empty)).toBe(0);
  });

  it('honours the ROI (half-open) and treats any non-zero value as ink', () => {
    const a = mask(10, 10, (x) => (x < 6 ? 1 : 0));
    const b = mask(10, 10, (x) => (x >= 4 ? 7 : 0));
    // ROI columns 4..5 only: both fully ink -> 1.
    expect(iou(a, b, { x0: 4, y0: 0, x1: 6, y1: 10 })).toBe(1);
    // ROI columns 0..3: a ink, b empty -> 0.
    expect(iou(a, b, { x0: 0, y0: 0, x1: 4, y1: 10 })).toBe(0);
    // ROI columns 2..7 rows 0..4: a covers 2..5 (4 cols), b covers 4..7 (4 cols), overlap 2 cols.
    expect(iou(a, b, { x0: 2, y0: 0, x1: 8, y1: 5 })).toBeCloseTo(2 / 6, 12);
    // Empty ROI -> 1 (vacuous), ROI clamped to the image.
    expect(iou(a, b, { x0: 20, y0: 0, x1: 30, y1: 10 })).toBe(1);
    expect(iou(a, b, { x0: -5, y0: -5, x1: 50, y1: 50 })).toBeCloseTo(0.2, 12);
  });

  it('agrees with maskIoU on synthetic masks', () => {
    const c = aaCircle(64, 20);
    const m1 = c.maskAt(1);
    const m2 = aaCircle(64, 18).maskAt(1);
    expect(iou(m1, m2)).toBeCloseTo(maskIoU(m1, m2), 12);
    expect(iou(m1, m2)).toBeGreaterThan(0.75);
    expect(iou(m1, m2)).toBeLessThan(0.9);
  });

  it('throws on size mismatch', () => {
    expect(() => iou(mask(4, 4, () => 0), mask(4, 5, () => 0))).toThrow(/tamaños/);
  });
});

describe('mae', () => {
  it('mean absolute difference, sign-independent', () => {
    const a = gray(4, 2, (x) => x * 10);
    const b = gray(4, 2, (x, y) => x * 10 + (y === 0 ? 3 : -5));
    expect(mae(a, b)).toBeCloseTo((4 * 3 + 4 * 5) / 8, 12);
    expect(mae(a, a)).toBe(0);
    expect(mae(b, a)).toBeCloseTo(mae(a, b), 12);
  });

  it('ROI restricts the average; empty ROI -> 0', () => {
    const a = gray(4, 2, (x) => x * 10);
    const b = gray(4, 2, (x, y) => x * 10 + (y === 0 ? 3 : -5));
    expect(mae(a, b, { x0: 0, y0: 0, x1: 4, y1: 1 })).toBeCloseTo(3, 12);
    expect(mae(a, b, { x0: 0, y0: 1, x1: 4, y1: 2 })).toBeCloseTo(5, 12);
    expect(mae(a, b, { x0: 2, y0: 0, x1: 3, y1: 2 })).toBeCloseTo(4, 12);
    expect(mae(a, b, { x0: 9, y0: 0, x1: 12, y1: 2 })).toBe(0);
  });

  it('handles fractional values and large images without drift (constant offset)', () => {
    const a = gray(300, 200, (x, y) => ((x * 31 + y * 17) % 256) + 0.25);
    const b = gray(300, 200, (x, y) => ((x * 31 + y * 17) % 256) - 0.5);
    expect(mae(a, b)).toBeCloseTo(0.75, 6);
  });

  it('throws on size mismatch', () => {
    expect(() => mae(gray(2, 2, () => 0), gray(3, 2, () => 0))).toThrow(/tamaños/);
  });
});

describe('pctDiff', () => {
  it('uses the maximum RGB channel difference with a strict threshold, ignoring alpha', () => {
    const a = raster(4, 1, () => [100, 100, 100, 255]);
    const b = raster(4, 1, (x) => {
      if (x === 0) return [100, 100, 100, 0]; // alpha only -> no diff
      if (x === 1) return [100, 116, 100, 255]; // diff 16 -> not > 16
      if (x === 2) return [100, 100, 117, 255]; // diff 17 -> > 16
      return [60, 100, 100, 255]; // diff 40
    });
    expect(pctDiff(a, b, 16)).toBeCloseTo(2 / 4, 12);
    expect(pctDiff(a, b, 32)).toBeCloseTo(1 / 4, 12);
    expect(pctDiff(a, b, 0)).toBeCloseTo(3 / 4, 12);
    expect(pctDiff(a, a, 0)).toBe(0);
    expect(pctDiff(b, a, 16)).toBeCloseTo(pctDiff(a, b, 16), 12);
  });

  it('ROI restricts the count; empty ROI -> 0', () => {
    const a = raster(8, 8, () => [0, 0, 0, 255]);
    const b = raster(8, 8, (x, y) => (x < 4 && y < 4 ? [200, 0, 0, 255] : [0, 0, 0, 255]));
    expect(pctDiff(a, b, 16)).toBeCloseTo(16 / 64, 12);
    expect(pctDiff(a, b, 16, { x0: 0, y0: 0, x1: 4, y1: 4 })).toBe(1);
    expect(pctDiff(a, b, 16, { x0: 4, y0: 4, x1: 8, y1: 8 })).toBe(0);
    expect(pctDiff(a, b, 16, { x0: 2, y0: 2, x1: 6, y1: 6 })).toBeCloseTo(4 / 16, 12);
    expect(pctDiff(a, b, 16, { x0: 8, y0: 8, x1: 9, y1: 9 })).toBe(0);
  });

  it('throws on size mismatch', () => {
    expect(() => pctDiff(raster(2, 2, () => [0, 0, 0, 255]), raster(2, 3, () => [0, 0, 0, 255]), 16)).toThrow(
      /tamaños/,
    );
  });
});
