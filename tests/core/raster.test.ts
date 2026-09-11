import { describe, expect, it } from 'vitest';
import type { RasterImage } from '../../src/types';
import {
  alphaStats,
  alphaToGray,
  borderModeColor,
  cloneRaster,
  compositeOnColor,
  createRaster,
  dominantInkColor,
  toGray,
} from '../../src/core/raster';

function setPx(img: RasterImage, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  const p = (y * img.width + x) * 4;
  img.data[p] = r;
  img.data[p + 1] = g;
  img.data[p + 2] = b;
  img.data[p + 3] = a;
}

describe('createRaster / cloneRaster', () => {
  it('creates a zeroed image of the right size', () => {
    const img = createRaster(3, 2);
    expect(img.width).toBe(3);
    expect(img.height).toBe(2);
    expect(img.data.length).toBe(24);
    expect(Array.from(img.data).every((v) => v === 0)).toBe(true);
  });

  it('applies the fill colour to every pixel', () => {
    const img = createRaster(2, 2, [10, 20, 30, 40]);
    for (let p = 0; p < img.data.length; p += 4) {
      expect(Array.from(img.data.subarray(p, p + 4))).toEqual([10, 20, 30, 40]);
    }
  });

  it('clamps negative or fractional sizes to a valid empty image', () => {
    const img = createRaster(-1, 2.7);
    expect(img.width).toBe(0);
    expect(img.height).toBe(2);
    expect(img.data.length).toBe(0);
  });

  it('clone has identical content in a different buffer', () => {
    const a = createRaster(2, 1, [1, 2, 3, 4]);
    const b = cloneRaster(a);
    expect(b.data).not.toBe(a.data);
    expect(b.data.buffer).not.toBe(a.data.buffer);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
    b.data[0] = 99;
    expect(a.data[0]).toBe(1);
  });
});

describe('toGray / alphaToGray', () => {
  it('uses Rec.601 luma and ignores alpha', () => {
    const img = createRaster(4, 1);
    setPx(img, 0, 0, 255, 255, 255, 0); // white, transparent
    setPx(img, 1, 0, 255, 0, 0, 255); // red
    setPx(img, 2, 0, 0, 255, 0, 128); // green
    setPx(img, 3, 0, 0, 0, 255, 255); // blue
    const g = toGray(img);
    expect(g.width).toBe(4);
    expect(g.height).toBe(1);
    expect(g.data[0]).toBeCloseTo(255, 3);
    expect(g.data[1]).toBeCloseTo(0.299 * 255, 3);
    expect(g.data[2]).toBeCloseTo(0.587 * 255, 3);
    expect(g.data[3]).toBeCloseTo(0.114 * 255, 3);
  });

  it('alphaToGray returns alpha as is (no inversion)', () => {
    const img = createRaster(3, 1);
    setPx(img, 0, 0, 1, 2, 3, 0);
    setPx(img, 1, 0, 1, 2, 3, 77);
    setPx(img, 2, 0, 1, 2, 3, 255);
    const g = alphaToGray(img);
    expect(Array.from(g.data)).toEqual([0, 77, 255]);
  });
});

describe('compositeOnColor', () => {
  it('alpha 0 -> background exactly; alpha 255 -> source exactly', () => {
    const img = createRaster(2, 1);
    setPx(img, 0, 0, 10, 20, 30, 0);
    setPx(img, 1, 0, 10, 20, 30, 255);
    const out = compositeOnColor(img, [200, 100, 50]);
    expect(Array.from(out.data.subarray(0, 4))).toEqual([200, 100, 50, 255]);
    expect(Array.from(out.data.subarray(4, 8))).toEqual([10, 20, 30, 255]);
  });

  it('alpha 128 lands within +-1 of the midpoint', () => {
    const img = createRaster(1, 1);
    setPx(img, 0, 0, 255, 0, 100, 128);
    const out = compositeOnColor(img, [0, 255, 0]);
    expect(Math.abs(out.data[0] - 127.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.data[1] - 127.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.data[2] - 50)).toBeLessThanOrEqual(1);
    expect(out.data[3]).toBe(255);
  });

  it('matches the float formula within 0.5 for every alpha', () => {
    const img = createRaster(256, 1);
    for (let a = 0; a < 256; a++) setPx(img, a, 0, 40, 200, 90, a);
    const out = compositeOnColor(img, [220, 30, 160]);
    for (let a = 0; a < 256; a++) {
      const t = a / 255;
      const p = a * 4;
      expect(Math.abs(out.data[p] - (40 * t + 220 * (1 - t)))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(out.data[p + 1] - (200 * t + 30 * (1 - t)))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(out.data[p + 2] - (90 * t + 160 * (1 - t)))).toBeLessThanOrEqual(0.5);
      expect(out.data[p + 3]).toBe(255);
    }
  });

  it('does not mutate the input', () => {
    const img = createRaster(1, 1);
    setPx(img, 0, 0, 1, 2, 3, 4);
    const before = Array.from(img.data);
    compositeOnColor(img, [255, 255, 255]);
    expect(Array.from(img.data)).toEqual(before);
  });
});

describe('borderModeColor', () => {
  it('returns the exact border colour when the ring is constant', () => {
    const img = createRaster(6, 5, [10, 10, 10, 255]);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 6; x++) {
        const onRing = x === 0 || y === 0 || x === 5 || y === 4;
        if (onRing) setPx(img, x, y, 201, 77, 13);
      }
    }
    expect(borderModeColor(img)).toEqual([201, 77, 13]);
  });

  it('averages the real values inside the winning 5-bit bin', () => {
    // 4x1: ring == all pixels. Values 200 and 203 share a bin (both >> 3 == 25).
    const img = createRaster(4, 1);
    setPx(img, 0, 0, 200, 200, 200);
    setPx(img, 1, 0, 203, 203, 203);
    setPx(img, 2, 0, 200, 200, 200);
    setPx(img, 3, 0, 203, 203, 203);
    expect(borderModeColor(img)).toEqual([202, 202, 202]); // 201.5 rounds to 202
  });

  it('returns null when the border is noisy (below 80 % agreement)', () => {
    const img = createRaster(10, 10);
    let i = 0;
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const onRing = x === 0 || y === 0 || x === 9 || y === 9;
        if (!onRing) continue;
        // Cycle 4 clearly different colours -> 25 % each.
        const c = i++ % 4;
        setPx(img, x, y, c * 60, 255 - c * 60, (c * 90) % 256);
      }
    }
    expect(borderModeColor(img)).toBeNull();
  });

  it('accepts exactly 80 % agreement and rejects just below', () => {
    // 6x6 ring = 20 pixels. 16/20 = 80 % agree -> colour; 15/20 = 75 % -> null.
    const make = (agree: number): RasterImage => {
      const img = createRaster(6, 6, [0, 0, 0, 255]);
      let i = 0;
      for (let y = 0; y < 6; y++) {
        for (let x = 0; x < 6; x++) {
          const onRing = x === 0 || y === 0 || x === 5 || y === 5;
          if (!onRing) continue;
          if (i < agree) setPx(img, x, y, 255, 255, 255);
          else setPx(img, x, y, 20 * i, 0, 0); // distinct bins
          i++;
        }
      }
      return img;
    };
    expect(borderModeColor(make(16))).toEqual([255, 255, 255]);
    expect(borderModeColor(make(15))).toBeNull();
  });

  it('ignores ring pixels with alpha < 128', () => {
    const img = createRaster(5, 5, [0, 0, 0, 0]);
    // Only one opaque ring pixel; the rest of the ring is transparent noise.
    setPx(img, 2, 0, 9, 8, 7, 255);
    setPx(img, 0, 2, 200, 100, 50, 100);
    expect(borderModeColor(img)).toEqual([9, 8, 7]);
  });

  it('returns null for a fully transparent ring and for empty images', () => {
    expect(borderModeColor(createRaster(4, 4, [255, 255, 255, 0]))).toBeNull();
    expect(borderModeColor(createRaster(0, 0))).toBeNull();
  });

  it('handles 1x1 and 1xN images', () => {
    expect(borderModeColor(createRaster(1, 1, [5, 6, 7, 255]))).toEqual([5, 6, 7]);
    expect(borderModeColor(createRaster(1, 7, [5, 6, 7, 255]))).toEqual([5, 6, 7]);
    expect(borderModeColor(createRaster(7, 1, [5, 6, 7, 255]))).toEqual([5, 6, 7]);
  });
});

describe('alphaStats', () => {
  it('counts transparent (< 8) and partial (8..247) pixels', () => {
    const img = createRaster(10, 1);
    const alphas = [0, 7, 8, 100, 247, 248, 255, 255, 255, 3];
    alphas.forEach((a, x) => setPx(img, x, 0, 0, 0, 0, a));
    const s = alphaStats(img);
    expect(s.transparentRatio).toBeCloseTo(0.3, 10);
    expect(s.partialAlphaRatio).toBeCloseTo(0.3, 10);
  });

  it('returns zeros for an empty image', () => {
    expect(alphaStats(createRaster(0, 0))).toEqual({ transparentRatio: 0, partialAlphaRatio: 0 });
  });
});

describe('dominantInkColor', () => {
  it('picks the most frequent colour that differs from the background', () => {
    const img = createRaster(10, 10, [255, 255, 255, 255]); // 100 px white
    for (let i = 0; i < 30; i++) setPx(img, i % 10, Math.floor(i / 10), 30, 60, 200); // 30 blue
    for (let i = 30; i < 40; i++) setPx(img, i % 10, Math.floor(i / 10), 200, 30, 30); // 10 red
    expect(dominantInkColor(img, [255, 255, 255])).toEqual([30, 60, 200]);
  });

  it('excludes colours within distance 48 of the background', () => {
    const img = createRaster(10, 10, [255, 255, 255, 255]);
    // 50 near-white pixels (distance ~ 40 < 48) and 5 black ones.
    for (let i = 0; i < 50; i++) setPx(img, i % 10, Math.floor(i / 10), 232, 232, 232);
    for (let i = 50; i < 55; i++) setPx(img, i % 10, Math.floor(i / 10), 0, 0, 0);
    expect(dominantInkColor(img, [255, 255, 255])).toEqual([0, 0, 0]);
  });

  it('with bg null counts every opaque pixel and averages the bin', () => {
    const img = createRaster(4, 1);
    setPx(img, 0, 0, 100, 100, 100);
    setPx(img, 1, 0, 102, 102, 102); // same 5-bit bin as 100
    setPx(img, 2, 0, 0, 0, 0);
    setPx(img, 3, 0, 250, 250, 250, 10); // ignored: alpha < 128
    expect(dominantInkColor(img, null)).toEqual([101, 101, 101]);
  });

  it('falls back to black when nothing qualifies', () => {
    expect(dominantInkColor(createRaster(3, 3, [255, 255, 255, 255]), [255, 255, 255])).toEqual([0, 0, 0]);
    expect(dominantInkColor(createRaster(0, 0), null)).toEqual([0, 0, 0]);
  });
});
