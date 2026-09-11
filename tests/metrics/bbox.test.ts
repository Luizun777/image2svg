import { describe, expect, it } from 'vitest';
import type { GrayImage } from '../../src/types';
import { clampBox, inkBBox } from '../../src/metrics/bbox';
import { toGray } from '../../src/core/raster';
import { filledSquare } from '../../src/dev/synth';

function gray(width: number, height: number, f: (x: number, y: number) => number): GrayImage {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y);
  return { data, width, height };
}

describe('inkBBox', () => {
  it('filledSquare(64,16): ink [16,48) dilated by round(0.05*64)=3 px', () => {
    const g = toGray(filledSquare(64, 16));
    expect(inkBBox(g, 255)).toEqual({ x0: 13, y0: 13, x1: 51, y1: 51 });
  });

  it('dilateFrac 0 gives the exact half-open bbox', () => {
    const g = toGray(filledSquare(64, 16));
    expect(inkBBox(g, 255, 24, 0)).toEqual({ x0: 16, y0: 16, x1: 48, y1: 48 });
  });

  it('returns the whole image when nothing differs from the background', () => {
    const g = gray(20, 10, () => 200);
    expect(inkBBox(g, 200)).toEqual({ x0: 0, y0: 0, x1: 20, y1: 10 });
    // Differences within tolerance are not ink either.
    const g2 = gray(20, 10, (x) => (x % 2 === 0 ? 200 - 24 : 200 + 24));
    expect(inkBBox(g2, 200)).toEqual({ x0: 0, y0: 0, x1: 20, y1: 10 });
  });

  it('tolerance is strict: |v - bg| == tol is background, tol + 1 is ink', () => {
    const base = gray(16, 16, () => 255);
    const g = { ...base, data: new Float32Array(base.data) };
    g.data[5 * 16 + 7] = 255 - 24; // exactly tol -> not ink
    expect(inkBBox(g, 255)).toEqual({ x0: 0, y0: 0, x1: 16, y1: 16 });
    g.data[5 * 16 + 7] = 255 - 25; // tol + 1 -> ink
    expect(inkBBox(g, 255, 24, 0)).toEqual({ x0: 7, y0: 5, x1: 8, y1: 6 });
    // Custom tolerance.
    expect(inkBBox(g, 255, 30, 0)).toEqual({ x0: 0, y0: 0, x1: 16, y1: 16 });
    expect(inkBBox(g, 255, 10, 0)).toEqual({ x0: 7, y0: 5, x1: 8, y1: 6 });
  });

  it('ink both darker and lighter than the background counts', () => {
    const g = gray(32, 32, () => 128);
    g.data[3 * 32 + 4] = 0; // dark
    g.data[20 * 32 + 25] = 255; // light
    expect(inkBBox(g, 128, 24, 0)).toEqual({ x0: 4, y0: 3, x1: 26, y1: 21 });
  });

  it('dilation is clamped to the image and uses max(w, h)', () => {
    // 10x4 image, ink at (7, 2); pad = round(0.05 * 10) = round(0.5) = 1.
    const g = gray(10, 4, (x, y) => (x === 7 && y === 2 ? 0 : 255));
    expect(inkBBox(g, 255)).toEqual({ x0: 6, y0: 1, x1: 9, y1: 4 });
    // Ink in the corner: dilation cannot go below 0.
    const c = gray(40, 40, (x, y) => (x === 0 && y === 0 ? 0 : 255));
    expect(inkBBox(c, 255)).toEqual({ x0: 0, y0: 0, x1: 3, y1: 3 });
    // Big dilateFrac covers everything.
    expect(inkBBox(c, 255, 24, 10)).toEqual({ x0: 0, y0: 0, x1: 40, y1: 40 });
  });

  it('finds the extreme columns even when they appear on different rows', () => {
    const g = gray(30, 30, () => 255);
    g.data[10 * 30 + 2] = 0; // leftmost, row 10
    g.data[15 * 30 + 27] = 0; // rightmost, row 15
    g.data[12 * 30 + 14] = 0;
    expect(inkBBox(g, 255, 24, 0)).toEqual({ x0: 2, y0: 10, x1: 28, y1: 16 });
  });

  it('NaN pixels are never ink; empty images return an empty box', () => {
    const g = gray(8, 8, () => 255);
    g.data[3] = Number.NaN;
    expect(inkBBox(g, 255)).toEqual({ x0: 0, y0: 0, x1: 8, y1: 8 });
    expect(inkBBox({ data: new Float32Array(0), width: 0, height: 0 }, 255)).toEqual({
      x0: 0,
      y0: 0,
      x1: 0,
      y1: 0,
    });
  });

  it('does not mutate the input', () => {
    const g = toGray(filledSquare(32, 8));
    const before = Array.from(g.data);
    inkBBox(g, 255);
    expect(Array.from(g.data)).toEqual(before);
  });
});

describe('clampBox', () => {
  it('undefined -> whole image; boxes are clamped and floored/ceiled', () => {
    expect(clampBox(undefined, 10, 5)).toEqual({ x0: 0, y0: 0, x1: 10, y1: 5 });
    expect(clampBox({ x0: -3, y0: 1, x1: 100, y1: 4 }, 10, 5)).toEqual({ x0: 0, y0: 1, x1: 10, y1: 4 });
    expect(clampBox({ x0: 1.2, y0: 0.9, x1: 3.1, y1: 2.5 }, 10, 5)).toEqual({ x0: 1, y0: 0, x1: 4, y1: 3 });
  });

  it('empty or inverted boxes become {0,0,0,0}; non-finite sides fall back to the border', () => {
    expect(clampBox({ x0: 5, y0: 0, x1: 5, y1: 5 }, 10, 5)).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
    expect(clampBox({ x0: 6, y0: 0, x1: 2, y1: 5 }, 10, 5)).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
    expect(clampBox({ x0: 12, y0: 0, x1: 20, y1: 5 }, 10, 5)).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
    expect(clampBox({ x0: Number.NaN, y0: 1, x1: Number.POSITIVE_INFINITY, y1: 3 }, 10, 5)).toEqual({
      x0: 0,
      y0: 1,
      x1: 10,
      y1: 3,
    });
  });
});
