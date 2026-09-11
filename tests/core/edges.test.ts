import { describe, expect, it } from 'vitest';
import type { BinaryMask, GrayImage, RasterImage } from '../../src/types';
import { detectGrid, hardEdgeRatio, sobelMagnitude, thinStrokeRatio } from '../../src/core/edges';
import { gaussianBlur } from '../../src/core/blur';
import { upscaleGray } from '../../src/core/upscale';
import { compositeOnColor } from '../../src/core/raster';
import { aaCircle, coverage, grayToRaster, sprite32 } from '../../src/dev/synth';

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
    for (let x = 0; x < width; x++) data.set(f(x, y), (y * width + x) * 4);
  }
  return { data, width, height };
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sobelMagnitude', () => {
  it('is 0 on a constant image', () => {
    const out = sobelMagnitude(gray(6, 5, () => 77));
    expect(Array.from(out.data).every((v) => v === 0)).toBe(true);
  });

  it('a 0|255 vertical step gives 255 on both columns next to the edge and 0 elsewhere', () => {
    const w = 8;
    const out = sobelMagnitude(gray(w, 4, (x) => (x < 4 ? 0 : 255)));
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < w; x++) {
        const v = out.data[y * w + x];
        if (x === 3 || x === 4) expect(v).toBeCloseTo(255, 4);
        else expect(v).toBe(0);
      }
    }
  });

  it('a horizontal step behaves the same along y (replicated borders)', () => {
    const h = 6;
    const out = sobelMagnitude(gray(3, h, (_x, y) => (y < 3 ? 255 : 0)));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < 3; x++) {
        const v = out.data[y * 3 + x];
        if (y === 2 || y === 3) expect(v).toBeCloseTo(255, 4);
        else expect(v).toBe(0);
      }
    }
  });

  it('a linear ramp of slope s gives magnitude 2s (central difference spans 2 px)', () => {
    const out = sobelMagnitude(gray(10, 4, (x) => 20 * x));
    for (let y = 0; y < 4; y++) {
      for (let x = 1; x < 9; x++) expect(out.data[y * 10 + x]).toBeCloseTo(40, 4);
      // Border columns replicate: one-sided difference -> half.
      expect(out.data[y * 10]).toBeCloseTo(20, 4);
      expect(out.data[y * 10 + 9]).toBeCloseTo(20, 4);
    }
  });
});

describe('hardEdgeRatio', () => {
  it('is 1 for a hard-edged square', () => {
    const img = gray(32, 32, (x, y) => (x >= 8 && x < 24 && y >= 8 && y < 24 ? 0 : 255));
    expect(hardEdgeRatio(img)).toBe(1);
  });

  it('is 1 for a hard checkerboard-ish pixel-art pattern', () => {
    const img = gray(16, 16, (x, y) => ((((x >> 2) + (y >> 2)) & 1) === 0 ? 0 : 255));
    expect(hardEdgeRatio(img)).toBe(1);
  });

  it('is ~0 for a smooth square (upscaled + blurred)', () => {
    const small = gray(16, 16, (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? 0 : 255));
    const smooth = gaussianBlur(upscaleGray(small, 4), 1.5);
    expect(hardEdgeRatio(smooth)).toBeLessThan(0.02);
  });

  it('is 0 for a linearly interpolated edge', () => {
    // 0, 85, 170, 255: gradient 85 > 64 so the ramp pixels count as edges, all with intermediate neighbours.
    const img = gray(12, 4, (x) => Math.max(0, Math.min(255, (x - 4) * 85)));
    expect(hardEdgeRatio(img)).toBe(0);
  });

  it('is 0 when there are no edge pixels at all', () => {
    expect(hardEdgeRatio(gray(5, 5, () => 128))).toBe(0);
    expect(hardEdgeRatio(gray(0, 0, () => 0))).toBe(0);
  });

  it('mixes: half hard, half soft edges -> ratio in between', () => {
    // Top half: hard vertical edge. Bottom half: soft (blurred) vertical edge, same position.
    const w = 32;
    const h = 32;
    const hard = gray(w, h / 2, (x) => (x < 16 ? 0 : 255));
    const soft = gaussianBlur(gray(w, h / 2, (x) => (x < 16 ? 0 : 255)), 2);
    const data = new Float32Array(w * h);
    data.set(hard.data, 0);
    data.set(soft.data, w * (h / 2));
    const r = hardEdgeRatio({ data, width: w, height: h });
    expect(r).toBeGreaterThan(0.2);
    expect(r).toBeLessThan(0.8);
  });
});

describe('hardEdgeRatio: abrupt transitions between any two levels, on RGB', () => {
  it('a hard step between two mid-tone greys is hard (the old < 16 / > 239 rule called it soft)', () => {
    expect(hardEdgeRatio(gray(32, 8, (x) => (x < 16 ? 64 : 192)))).toBe(1);
    expect(hardEdgeRatio(gray(32, 32, (x, y) => (x >= 8 && x < 24 && y >= 8 && y < 24 ? 90 : 170)))).toBe(1);
  });

  it('a hard step between two mid-tone colours of similar luma is detected and hard', () => {
    // Luma 94 vs 131 (a 37-level luma step is not even an edge); red differs by 160.
    const img = raster(24, 8, (x) => (x < 12 ? [200, 40, 90, 255] : [40, 160, 220, 255]));
    expect(hardEdgeRatio(img)).toBe(1);
  });

  it('the same two colours with a 1-px anti-aliased blend column are soft', () => {
    const img = raster(24, 8, (x) => (x < 12 ? [200, 40, 90, 255] : x === 12 ? [120, 100, 155, 255] : [40, 160, 220, 255]));
    expect(hardEdgeRatio(img)).toBe(0);
  });

  it('three-colour junctions of pixel art stay hard: a genuine third colour is not a blend', () => {
    const img = raster(16, 16, (x, y) => (y < 8 ? (x < 8 ? [255, 0, 77, 255] : [255, 163, 0, 255]) : [41, 173, 255, 255]));
    expect(hardEdgeRatio(img)).toBe(1);
  });

  it('native-resolution colour pixel art: sprite32 over white is > 0.9 hard for several seeds', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(hardEdgeRatio(compositeOnColor(sprite32(seed), [255, 255, 255])), `seed ${seed}`).toBeGreaterThan(0.9);
    }
  });

  it('anti-aliased colour art is soft: orange disc on white, black aaCircle', () => {
    const disc = grayToRaster(coverage(64, (x, y) => Math.hypot(x - 32, y - 32) - 20), 64, [255, 165, 0], [255, 255, 255]);
    expect(hardEdgeRatio(disc)).toBeLessThan(0.2);
    expect(hardEdgeRatio(aaCircle().image)).toBeLessThan(0.2);
  });

  it('a GrayImage and the same values as a grey RGBA raster give the same ratio', () => {
    const src = gray(16, 16, (x, y) => (x >= 4 && x < 12 && y >= 5 && y < 11 ? 30 : 220));
    const soft = gaussianBlur(upscaleGray(src, 2), 0.6);
    const rounded = gray(soft.width, soft.height, (x, y) => Math.round(soft.data[y * soft.width + x]));
    const asRaster = raster(soft.width, soft.height, (x, y) => {
      const v = rounded.data[y * soft.width + x];
      return [v, v, v, 255];
    });
    expect(hardEdgeRatio(asRaster)).toBeCloseTo(hardEdgeRatio(rounded), 12);
    const hardSq = gray(32, 32, (x, y) => (x >= 8 && x < 24 && y >= 8 && y < 24 ? 64 : 192));
    const hardSqRaster = raster(32, 32, (x, y) => {
      const v = hardSq.data[y * 32 + x];
      return [v, v, v, 255];
    });
    expect(hardEdgeRatio(hardSqRaster)).toBe(1);
  });
});

describe('thinStrokeRatio', () => {
  function maskOf(width: number, height: number, f: (x: number, y: number) => boolean): BinaryMask {
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y) ? 1 : 0;
    return { data, width, height };
  }

  it('is 1 for a 1-px line', () => {
    expect(thinStrokeRatio(maskOf(20, 9, (_x, y) => y === 4))).toBe(1);
    expect(thinStrokeRatio(maskOf(9, 20, (x) => x === 3))).toBe(1);
  });

  it('is 1 - 64/100 for a 10-px square and smaller for bigger blobs', () => {
    const sq10 = maskOf(20, 20, (x, y) => x >= 5 && x < 15 && y >= 5 && y < 15);
    expect(thinStrokeRatio(sq10)).toBeCloseTo(0.36, 10);
    const sq30 = maskOf(40, 40, (x, y) => x >= 5 && x < 35 && y >= 5 && y < 35);
    expect(thinStrokeRatio(sq30)).toBeCloseTo(1 - 784 / 900, 10);
  });

  it('is 0 for an empty mask', () => {
    expect(thinStrokeRatio(maskOf(4, 4, () => false))).toBe(0);
  });
});

describe('detectGrid', () => {
  function blocks(width: number, height: number, k: number, seed = 1): RasterImage {
    const rnd = prng(seed);
    const bw = Math.ceil(width / k);
    const bh = Math.ceil(height / k);
    const colors: Array<[number, number, number, number]> = [];
    for (let i = 0; i < bw * bh; i++) {
      // Make neighbouring blocks differ for sure: alternate high/low red by parity.
      const bx = i % bw;
      const by = Math.floor(i / bw);
      const base = (bx + by) % 2 === 0 ? 0 : 128;
      colors.push([base + Math.floor(rnd() * 100), Math.floor(rnd() * 256), Math.floor(rnd() * 256), 255]);
    }
    return raster(width, height, (x, y) => colors[Math.floor(y / k) * bw + Math.floor(x / k)]);
  }

  it('finds 3 for constant 3x3 blocks (12x12)', () => {
    expect(detectGrid(blocks(12, 12, 3))).toBe(3);
  });

  it('prefers the largest valid k: 6x6 blocks -> 6, not 3 or 2', () => {
    expect(detectGrid(blocks(24, 24, 6))).toBe(6);
    expect(detectGrid(blocks(24, 12, 6))).toBe(6);
  });

  it('returns 8 for 8x8 blocks and 4 for 4x4 blocks, 2 for 2x2', () => {
    expect(detectGrid(blocks(32, 16, 8))).toBe(8);
    expect(detectGrid(blocks(16, 16, 4))).toBe(4);
    expect(detectGrid(blocks(10, 6, 2))).toBe(2);
  });

  it('returns 1 for random noise', () => {
    const rnd = prng(7);
    const noise = raster(24, 24, () => [
      Math.floor(rnd() * 256),
      Math.floor(rnd() * 256),
      Math.floor(rnd() * 256),
      255,
    ]);
    expect(detectGrid(noise)).toBe(1);
  });

  it('returns 1 when the size is not divisible or a single pixel breaks a block', () => {
    // 3x3 blocks in a 13x13 image: no k in 2..8 divides 13.
    expect(detectGrid(blocks(13, 13, 3))).toBe(1);
    const img = blocks(12, 12, 3);
    img.data[(5 * 12 + 5) * 4 + 3] = 254; // alpha differs -> RGBA no longer exact
    expect(detectGrid(img)).toBe(1);
  });

  it('a constant image reports the largest divisor k in 2..8', () => {
    expect(detectGrid(raster(16, 16, () => [9, 9, 9, 255]))).toBe(8);
    expect(detectGrid(raster(14, 21, () => [9, 9, 9, 255]))).toBe(7);
    expect(detectGrid(raster(11, 11, () => [9, 9, 9, 255]))).toBe(1);
  });

  it('works on an unaligned subarray view', () => {
    const src = blocks(12, 12, 3);
    const buf = new Uint8ClampedArray(src.data.length + 1);
    buf.set(src.data, 1);
    const view: RasterImage = { data: buf.subarray(1), width: 12, height: 12 };
    expect(view.data.byteOffset % 4).toBe(1);
    expect(detectGrid(view)).toBe(3);
  });

  it('empty image -> 1', () => {
    expect(detectGrid(raster(0, 0, () => [0, 0, 0, 0]))).toBe(1);
  });
});
