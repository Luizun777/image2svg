import { describe, expect, it } from 'vitest';
import type { AbsPath, Metrics, PathStats, RasterImage } from '../../src/types';
import { computeMetrics, tunerScore } from '../../src/metrics/fidelity';
import { rasterizeLayers } from '../../src/metrics/scanline';
import { cloneRaster, compositeOnColor, createRaster } from '../../src/core/raster';
import { aaCircle, filledSquare, flatShapes3, sprite32, transparentLogo } from '../../src/dev/synth';

const WHITE: [number, number, number] = [255, 255, 255];
const KAPPA = 0.5522847498307936;

function circlePath(cx: number, cy: number, r: number): AbsPath {
  const k = KAPPA * r;
  return {
    segs: [
      { kind: 'M', x: cx + r, y: cy },
      { kind: 'C', x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x: cx, y: cy + r },
      { kind: 'C', x1: cx - k, y1: cy + r, x2: cx - r, y2: cy + k, x: cx - r, y: cy },
      { kind: 'C', x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x: cx, y: cy - r },
      { kind: 'C', x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x: cx + r, y: cy },
      { kind: 'Z' },
    ],
  };
}

function expectPerfect(m: Metrics): void {
  expect(Math.abs(m.fidelity - 1)).toBeLessThan(1e-6);
  expect(Math.abs(m.ssim - 1)).toBeLessThan(1e-9);
  expect(m.iou).toBe(1);
  expect(m.mae).toBe(0);
  expect(m.pctDiff16).toBe(0);
  expect(m.pctDiff32).toBe(0);
}

describe('computeMetrics', () => {
  it('original vs itself is perfect in every mode', () => {
    const circle = aaCircle(64, 20).image;
    expectPerfect(computeMetrics({ original: circle, rendered: cloneRaster(circle), mode: 'lines', background: WHITE }));
    const flat = flatShapes3(96).image;
    expectPerfect(computeMetrics({ original: flat, rendered: flat, mode: 'flat', background: [0xf2, 0xe8, 0xd5] }));
    const sprite = sprite32(1);
    expectPerfect(computeMetrics({ original: sprite, rendered: cloneRaster(sprite), mode: 'pixel', background: WHITE }));
  });

  it('lines: a Bézier circle rendered by the scanline rasteriser closely matches the AA circle', () => {
    const { image } = aaCircle(64, 20);
    const rendered = rasterizeLayers([{ fill: '#000000', paths: [circlePath(32, 32, 20)] }], 64, 64, WHITE);
    const m = computeMetrics({ original: image, rendered, mode: 'lines', background: WHITE });
    expect(m.iou).toBeGreaterThan(0.97);
    expect(m.ssim).toBeGreaterThan(0.9);
    expect(m.fidelity).toBeGreaterThan(0.93);
    expect(m.mae).toBeLessThan(3);
    expect(m.pctDiff32).toBeLessThan(0.05);
    expect(m.pctDiff16).toBeGreaterThanOrEqual(m.pctDiff32);
    // A smaller circle is clearly worse on IoU while still overlapping.
    const small = rasterizeLayers([{ fill: '#000000', paths: [circlePath(32, 32, 14)] }], 64, 64, WHITE);
    const ms = computeMetrics({ original: image, rendered: small, mode: 'lines', background: WHITE });
    expect(ms.iou).toBeCloseTo((14 * 14) / (20 * 20), 1);
    expect(ms.fidelity).toBeLessThan(m.fidelity);
  });

  it('lines: a blank render scores iou 0 and low fidelity', () => {
    const { image } = aaCircle(64, 20);
    const blank = createRaster(64, 64, [255, 255, 255, 255]);
    const m = computeMetrics({ original: image, rendered: blank, mode: 'lines', background: WHITE });
    expect(m.iou).toBe(0);
    expect(m.ssim).toBeLessThan(0.6);
    expect(m.fidelity).toBeLessThan(0.4);
    expect(m.fidelity).toBeGreaterThanOrEqual(0);
    expect(m.mae).toBeGreaterThan(50);
    // Within the ROI (circle bbox + 3 px), the disc is ~ π400 / (46*46) of the pixels.
    expect(m.pctDiff32).toBeGreaterThan(0.5);
    expect(m.pctDiff32).toBeLessThan(0.75);
  });

  it('lines: explicit thresholdNorm is used for the IoU masks', () => {
    // Original: light-gray square (luma 200) on white; rendered: black square, same place.
    const size = 32;
    const original = createRaster(size, size, [255, 255, 255, 255]);
    const rendered = createRaster(size, size, [255, 255, 255, 255]);
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        const o = (y * size + x) * 4;
        original.data[o] = original.data[o + 1] = original.data[o + 2] = 200;
        rendered.data[o] = rendered.data[o + 1] = rendered.data[o + 2] = 0;
      }
    }
    // t = 0.9 (229.5): both squares are ink -> IoU 1.
    const hi = computeMetrics({ original, rendered, mode: 'lines', background: WHITE, thresholdNorm: 0.9 });
    expect(hi.iou).toBe(1);
    // t = 0.5 (127.5): only the rendered square is ink -> IoU 0.
    const lo = computeMetrics({ original, rendered, mode: 'lines', background: WHITE, thresholdNorm: 0.5 });
    expect(lo.iou).toBe(0);
    // Default (Otsu of the original, between 200 and 255) behaves like the high threshold.
    const auto = computeMetrics({ original, rendered, mode: 'lines', background: WHITE });
    expect(auto.iou).toBe(1);
    expect(auto.ssim).toBe(hi.ssim);
  });

  it('flat/pixel: iou = 1 - pctDiff16 with an exact fraction over the ROI', () => {
    const original = filledSquare(64, 16); // ROI = {13,13,51,51} -> 38*38 = 1444 px
    const rendered = cloneRaster(original);
    for (let y = 20; y < 30; y++) {
      for (let x = 20; x < 30; x++) {
        const o = (y * 64 + x) * 4;
        rendered.data[o] = rendered.data[o + 1] = rendered.data[o + 2] = 128; // diff 128 > 32
      }
    }
    for (const mode of ['flat', 'pixel'] as const) {
      const m = computeMetrics({ original, rendered, mode, background: WHITE });
      expect(m.pctDiff16).toBeCloseTo(100 / 1444, 12);
      expect(m.pctDiff32).toBeCloseTo(100 / 1444, 12);
      expect(m.iou).toBeCloseTo(1 - 100 / 1444, 12);
      expect(m.fidelity).toBeCloseTo(0.6 * m.ssim + 0.4 * m.iou, 12);
      expect(m.fidelity).toBeLessThan(1);
    }
    // A difference of exactly 16 counts for neither threshold.
    const subtle = cloneRaster(original);
    for (let y = 20; y < 30; y++) {
      for (let x = 20; x < 30; x++) {
        const o = (y * 64 + x) * 4;
        subtle.data[o] = 16;
      }
    }
    const ms = computeMetrics({ original, rendered: subtle, mode: 'flat', background: WHITE });
    expect(ms.pctDiff16).toBe(0);
    expect(ms.iou).toBe(1);
  });

  it('transparent originals are composited on the background before comparing', () => {
    const { image } = transparentLogo(64);
    const opaque = compositeOnColor(image, WHITE);
    const m = computeMetrics({ original: image, rendered: opaque, mode: 'lines', background: WHITE });
    expectPerfect(m);
    // The same render compared against a different background is no longer perfect.
    const m2 = computeMetrics({ original: image, rendered: opaque, mode: 'lines', background: [0, 0, 0] });
    expect(m2.fidelity).toBeLessThan(0.9);
  });

  it('ROI comes from the original: differences far from the ink are ignored', () => {
    const original = filledSquare(64, 16); // ROI {13,13,51,51}
    const rendered = cloneRaster(original);
    rendered.data[(2 * 64 + 2) * 4] = 0; // black-ish pixel in the corner, outside the ROI
    rendered.data[(2 * 64 + 2) * 4 + 1] = 0;
    rendered.data[(2 * 64 + 2) * 4 + 2] = 0;
    const m = computeMetrics({ original, rendered, mode: 'lines', background: WHITE });
    expectPerfect(m);
  });

  it('fidelity is clamped to [0, 1]', () => {
    // Strongly anti-correlated texture -> negative SSIM, IoU 0 -> raw score < 0.
    const size = 32;
    const original: RasterImage = createRaster(size, size, [255, 255, 255, 255]);
    const rendered: RasterImage = createRaster(size, size, [255, 255, 255, 255]);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        const v = ((x >> 1) + (y >> 1)) % 2 === 0 ? 40 : 215;
        original.data[o] = original.data[o + 1] = original.data[o + 2] = v;
        rendered.data[o] = rendered.data[o + 1] = rendered.data[o + 2] = 255 - v;
      }
    }
    const m = computeMetrics({ original, rendered, mode: 'flat', background: WHITE });
    expect(m.ssim).toBeLessThan(0);
    expect(m.fidelity).toBeGreaterThanOrEqual(0);
    expect(m.fidelity).toBeLessThanOrEqual(1);
    expect(m.fidelity).toBe(0);
  });

  it('throws on size mismatch and never mutates its inputs', () => {
    const a = aaCircle(32, 10).image;
    const b = aaCircle(16, 5).image;
    expect(() => computeMetrics({ original: a, rendered: b, mode: 'lines', background: WHITE })).toThrow(
      /tamaños/,
    );
    const { image } = transparentLogo(32);
    const rendered = aaCircle(32, 10).image;
    const before = Array.from(image.data);
    const beforeR = Array.from(rendered.data);
    computeMetrics({ original: image, rendered, mode: 'lines', background: WHITE });
    expect(Array.from(image.data)).toEqual(before);
    expect(Array.from(rendered.data)).toEqual(beforeR);
  });
});

describe('tunerScore', () => {
  const metrics = (fidelity: number): Metrics => ({
    fidelity,
    ssim: fidelity,
    iou: fidelity,
    mae: 0,
    pctDiff16: 0,
    pctDiff32: 0,
  });
  const stats = (nodeCount: number, cornerFraction: number): PathStats => ({
    pathCount: 1,
    subpathCount: 1,
    nodeCount,
    lineCount: 0,
    curveCount: 0,
    cornerFraction,
    bytes: 0,
  });

  it('fidelity - 0.15*cornerFraction - 0.10*min(1, nodes / max(1, 2*perimeter))', () => {
    expect(tunerScore(metrics(0.9), stats(100, 0.5), 100)).toBeCloseTo(0.9 - 0.075 - 0.05, 12);
    expect(tunerScore(metrics(1), stats(0, 0), 100)).toBeCloseTo(1, 12);
    expect(tunerScore(metrics(1), stats(0, 1), 100)).toBeCloseTo(0.85, 12);
  });

  it('node penalty saturates at 0.10 and the perimeter floor is 1', () => {
    expect(tunerScore(metrics(1), stats(100000, 0), 100)).toBeCloseTo(0.9, 12);
    expect(tunerScore(metrics(1), stats(200, 0), 100)).toBeCloseTo(0.9, 12);
    expect(tunerScore(metrics(1), stats(1, 0), 0)).toBeCloseTo(0.9, 12); // 1 / max(1, 0) = 1
    expect(tunerScore(metrics(1), stats(0.5, 0), 0)).toBeCloseTo(0.95, 12);
  });

  it('prefers smoother, simpler paths at equal fidelity', () => {
    const m = metrics(0.95);
    expect(tunerScore(m, stats(50, 0.1), 200)).toBeGreaterThan(tunerScore(m, stats(50, 0.6), 200));
    expect(tunerScore(m, stats(50, 0.1), 200)).toBeGreaterThan(tunerScore(m, stats(300, 0.1), 200));
  });
});
