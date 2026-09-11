import { describe, expect, it } from 'vitest';
import type { BinaryMask, GrayImage, RasterImage, RegionMap } from '../../src/types';
import {
  SOBEL_CONTRAST_RADIUS,
  SOBEL_GATE_RADIUS,
  SOBEL_SEED_CLEARANCE,
  detectGrid,
  edgeThresholds,
  gateSobel,
  hardEdgeRatio,
  hysteresis,
  rgbEdgeMaps,
  sobelMagnitude,
  thinStrokeRatio,
} from '../../src/core/edges';
import { gaussianBlur, gaussianBlurRaster } from '../../src/core/blur';
import { immerkaerSigma } from '../../src/core/noise';
import { upscaleGray } from '../../src/core/upscale';
import { compositeOnColor } from '../../src/core/raster';
import { aaCircle, coverage, gradientFeathers, grayToRaster, sprite32, withNoise } from '../../src/dev/synth';

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

// ---------------------------------------------------------------------------------------------
// Gradient mode (phase 1): rgbEdgeMaps, hysteresis, edgeThresholds
// ---------------------------------------------------------------------------------------------

describe('rgbEdgeMaps', () => {
  it('is 0 on a constant colour (both maps, borders included)', () => {
    const { sobel, laplacian } = rgbEdgeMaps(raster(7, 5, () => [12, 200, 90, 255]));
    expect(sobel.width).toBe(7);
    expect(laplacian.height).toBe(5);
    expect(Array.from(sobel.data).every((v) => v === 0)).toBe(true);
    expect(Array.from(laplacian.data).every((v) => v === 0)).toBe(true);
  });

  it('a 0|255 step in one channel: sobel 255 and laplacian 765/8 on both columns next to it, 0 elsewhere', () => {
    const w = 8;
    const { sobel, laplacian } = rgbEdgeMaps(raster(w, 4, (x) => [x < 4 ? 0 : 255, 100, 100, 255]));
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < w; x++) {
        const s = sobel.data[y * w + x];
        const l = laplacian.data[y * w + x];
        if (x === 3 || x === 4) {
          expect(s).toBeCloseTo(255, 4);
          expect(l).toBeCloseTo(95.625, 4);
        } else {
          expect(s).toBe(0);
          expect(l).toBe(0);
        }
      }
    }
  });

  it('a linear ramp has laplacian 0 inside (the gradient discriminator) and sobel |2·slope|', () => {
    const w = 12;
    const h = 9;
    const { sobel, laplacian } = rgbEdgeMaps(raster(w, h, (x, y) => [50, 10 + 7 * x + 3 * y, 50, 255]));
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        expect(laplacian.data[y * w + x]).toBe(0);
        expect(sobel.data[y * w + x]).toBeCloseTo(Math.hypot(14, 6), 4);
      }
    }
  });

  it('keeps the largest channel: steps of 40 in red and 200 in blue at the same place give 200 and 600/8', () => {
    const { sobel, laplacian } = rgbEdgeMaps(raster(6, 3, (x) => (x < 3 ? [0, 0, 0, 255] : [40, 0, 200, 255])));
    expect(sobel.data[2 * 6 + 2]).toBeCloseTo(200, 4);
    expect(laplacian.data[2 * 6 + 2]).toBeCloseTo(75, 4);
  });

  it('an isolated bright pixel: laplacian 255 on it and 255/8 on its 8 neighbours', () => {
    const { laplacian } = rgbEdgeMaps(raster(5, 5, (x, y) => (x === 2 && y === 2 ? [0, 255, 0, 255] : [0, 0, 0, 255])));
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const v = laplacian.data[y * 5 + x];
        if (x === 2 && y === 2) expect(v).toBeCloseTo(255, 4);
        else if (Math.abs(x - 2) <= 1 && Math.abs(y - 2) <= 1) expect(v).toBeCloseTo(31.875, 4);
        else expect(v).toBe(0);
      }
    }
  });

  it('ignores alpha and matches sobelMagnitude on a grey raster', () => {
    const rnd = prng(5);
    const grey = gray(16, 11, () => Math.floor(rnd() * 256));
    const opaque = raster(16, 11, (x, y) => {
      const v = grey.data[y * 16 + x];
      return [v, v, v, 255];
    });
    const alphaNoise = raster(16, 11, (x, y) => {
      const v = grey.data[y * 16 + x];
      return [v, v, v, Math.floor(rnd() * 256)];
    });
    const a = rgbEdgeMaps(opaque);
    const b = rgbEdgeMaps(alphaNoise);
    expect(b.sobel.data).toEqual(a.sobel.data);
    expect(b.laplacian.data).toEqual(a.laplacian.data);
    const ref = sobelMagnitude(grey).data;
    for (let i = 0; i < ref.length; i++) expect(a.sobel.data[i]).toBeCloseTo(ref[i], 3);
  });

  it('with withAlpha the alpha channel joins the maximum: a shape of one colour on transparency has its rim in the maps', () => {
    const img = raster(8, 4, (x) => [30, 60, 90, x < 4 ? 0 : 255]);
    expect(Array.from(rgbEdgeMaps(img).sobel.data).every((v) => v === 0)).toBe(true);
    const withAlpha = rgbEdgeMaps(img, true);
    expect(withAlpha.sobel.data[8 * 1 + 3]).toBeCloseTo(255, 4);
    expect(withAlpha.laplacian.data[8 * 1 + 4]).toBeCloseTo(95.625, 4);
    expect(withAlpha.sobel.data[8 * 1 + 0]).toBe(0);
  });

  it('handles 1-px and empty images with replicated borders', () => {
    expect(Array.from(rgbEdgeMaps(raster(1, 1, () => [255, 0, 0, 255])).laplacian.data)).toEqual([0]);
    expect(rgbEdgeMaps(raster(0, 0, () => [0, 0, 0, 0])).sobel.data.length).toBe(0);
    const line = rgbEdgeMaps(raster(4, 1, (x) => (x < 2 ? [0, 0, 0, 255] : [0, 0, 80, 255])));
    // Rows replicate: gx = 4·80 on the columns next to the step, /4 -> 80.
    expect(line.sobel.data[1]).toBeCloseTo(80, 4);
    expect(line.sobel.data[2]).toBeCloseTo(80, 4);
  });
});

describe('gateSobel', () => {
  const t = edgeThresholds(0, 1);
  const count = (m: BinaryMask): number => m.data.reduce((a, v) => a + v, 0);

  it('radii: Laplacian activity within 1 px, Sobel contrast within 2 px, weak seeds 3 px clear of strong pixels', () => {
    expect([SOBEL_GATE_RADIUS, SOBEL_CONTRAST_RADIUS, SOBEL_SEED_CLEARANCE]).toEqual([1, 2, 3]);
  });

  it('drops the weak Sobel of a steep ramp (Laplacian 0, the same Sobel all around): its hysteresis no longer floods the ramp', () => {
    const w = 40;
    const h = 20;
    const { sobel, laplacian } = rgbEdgeMaps(raster(w, h, (x) => [10 + 5 * x, 0, 0, 255]));
    const gated = gateSobel(sobel.data, laplacian.data, w, h, t);
    // Columns 0 and w - 1 replicate the border (Sobel 5).
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w - 1; x++) {
        expect(sobel.data[y * w + x]).toBeCloseTo(10, 4); // weak: 9.6 < 10 <= 24
        expect(gated[y * w + x]).toBe(0);
      }
    }
    // One strong pixel in the ramp: the ungated hysteresis takes the whole ramp, the gated one only that pixel.
    const seeded = Float32Array.from(sobel.data);
    seeded[10 * w + 20] = 100;
    expect(count(hysteresis(seeded, w, h, t.sobLo, t.sobHi))).toBe((w - 2) * h);
    expect(count(hysteresis(gateSobel(seeded, laplacian.data, w, h, t), w, h, t.sobLo, t.sobHi))).toBe(1);
  });

  it('copies strong pixels and values <= sobLo; a weak step that stands out seeds (+Infinity) away from strong pixels and keeps its value near them; a weak pixel by a crease keeps its value', () => {
    const w = 24;
    const h = 6;
    // Columns 0-5 at 0, a sharp step of 12 at 6 (unblurred: Laplacian 4.5 < lapHi); columns 12-15 a 4-px ramp of slope 10
    // from 12 to 52; a step of 150 at 20.
    const level = (x: number): number => (x < 6 ? 0 : x < 12 ? 12 : x < 16 ? 12 + 10 * (x - 11) : x < 20 ? 52 : 202);
    const { sobel, laplacian } = rgbEdgeMaps(raster(w, h, (x) => [level(x), level(x), level(x), 255]));
    const gated = gateSobel(sobel.data, laplacian.data, w, h, t);
    const row = 3 * w;
    for (let x = 0; x < w; x++) {
      const v = sobel.data[row + x];
      if (!(v > t.sobLo) || v > t.sobHi) expect(gated[row + x], `x ${x}`).toBe(v);
    }
    expect(sobel.data[row + 5]).toBeCloseTo(12, 4); // weak sharp step
    expect(laplacian.data[row + 5]).toBeCloseTo(4.5, 4);
    expect(gated[row + 5]).toBe(Number.POSITIVE_INFINITY);
    expect(sobel.data[row + 13]).toBeCloseTo(20, 4); // middle of the soft step: lobes 2 px away, Sobel 10 within 2 px
    expect(laplacian.data[row + 13]).toBe(0);
    expect(gated[row + 13]).toBe(Number.POSITIVE_INFINITY);
    expect(sobel.data[row + 19]).toBeGreaterThan(t.sobHi);
    expect(gated[row + 19]).toBe(sobel.data[row + 19]);
    // The weak sharp step of 12 moved next to the strong step (3 px from it): it keeps its value.
    const near = (x: number): number => (x < 14 ? 0 : x < 17 ? 12 : 162);
    const nearMaps = rgbEdgeMaps(raster(w, h, (x) => [near(x), near(x), near(x), 255]));
    const g3 = gateSobel(nearMaps.sobel.data, nearMaps.laplacian.data, w, h, t);
    expect(nearMaps.sobel.data[row + 13]).toBeCloseTo(12, 4);
    expect(nearMaps.sobel.data[row + 16]).toBeGreaterThan(t.sobHi);
    expect(g3[row + 13]).toBe(nearMaps.sobel.data[row + 13]);
    // A ramp of slope 5 (Sobel 10, weak) that bends to slope 15: by the bend, Laplacian 3.75 > lapLo, so x 19 keeps 10.
    const bend = (x: number): number => (x < 20 ? 5 * x : 100 + 15 * (x - 20));
    const maps = rgbEdgeMaps(raster(40, 5, (x) => [bend(x), 0, 0, 255]));
    const g2 = gateSobel(maps.sobel.data, maps.laplacian.data, 40, 5, t);
    expect(maps.laplacian.data[2 * 40 + 20]).toBeCloseTo(3.75, 4);
    expect(maps.sobel.data[2 * 40 + 19]).toBeCloseTo(10, 4);
    expect(g2[2 * 40 + 19]).toBe(maps.sobel.data[2 * 40 + 19]);
    expect(g2[2 * 40 + 10]).toBe(0);
  });

  it('rejects maps shorter than the image and does not mutate its inputs', () => {
    const sob = new Float32Array([0, 12, 30, 12]);
    const lap = new Float32Array(4);
    const before = Array.from(sob);
    gateSobel(sob, lap, 4, 1, t);
    expect(Array.from(sob)).toEqual(before);
    expect(() => gateSobel(sob, lap, 5, 1, t)).toThrow(RangeError);
  });
});

describe('hysteresis', () => {
  it('keeps pixels strictly above hi, and pixels strictly above lo 8-connected to them', () => {
    // Row 0: strong at x=0, weak chain continuing diagonally; a separate weak blob at the right.
    const w = 8;
    const h = 3;
    const mag = new Float32Array(w * h);
    const set = (x: number, y: number, v: number): void => {
      mag[y * w + x] = v;
    };
    set(0, 0, 10); // strong
    set(1, 1, 5); // weak, diagonal to the strong one
    set(2, 2, 5); // weak, diagonal chain
    set(3, 2, 5);
    set(6, 0, 5); // weak, isolated from any strong pixel
    set(7, 1, 5);
    set(5, 1, 4); // equal to lo: not weak, so it does not bridge (6, 0) to (3, 2)
    const out = hysteresis(mag, w, h, 4, 9);
    const on = (x: number, y: number): number => out.data[y * w + x];
    expect([on(0, 0), on(1, 1), on(2, 2), on(3, 2)]).toEqual([1, 1, 1, 1]);
    expect([on(6, 0), on(7, 1), on(5, 1)]).toEqual([0, 0, 0]);
    expect(Array.from(out.data).reduce((s, v) => s + v, 0)).toBe(4);
  });

  it('a value equal to hi is not strong; NaN never passes', () => {
    const mag = Float32Array.from([9, 5, NaN, 12, 5]);
    expect(Array.from(hysteresis(mag, 5, 1, 4, 9).data)).toEqual([0, 0, 0, 1, 1]);
  });

  it('floods a large weak area from a single strong pixel without recursion (stack grows)', () => {
    const w = 700;
    const h = 700;
    const mag = new Float32Array(w * h).fill(5);
    // A serpentine wall of zeros forces a long path.
    for (let x = 0; x < w - 2; x++) {
      for (let y = 0; y < h; y += 4) mag[y * w + (((y / 4) & 1) === 0 ? x : x + 2)] = 0;
    }
    mag[1 * w + 350] = 10;
    const out = hysteresis(mag, w, h, 4, 9);
    let ones = 0;
    let weak = 0;
    for (let i = 0; i < w * h; i++) {
      if (mag[i] > 4) weak++;
      ones += out.data[i];
    }
    expect(ones).toBe(weak);
  });

  it('throws when mag is shorter than width·height', () => {
    expect(() => hysteresis(new Float32Array(3), 2, 2, 1, 2)).toThrow(RangeError);
  });
});

describe('edgeThresholds', () => {
  it('uses the floors below the noise knee: {lapHi 6, lapLo 2.7, sobHi 24, sobLo 9.6}', () => {
    const t = edgeThresholds(0, 1);
    expect(t.lapHi).toBeCloseTo(6, 12);
    expect(t.lapLo).toBeCloseTo(2.7, 12);
    expect(t.sobHi).toBeCloseTo(24, 12);
    expect(t.sobLo).toBeCloseTo(9.6, 12);
    expect(edgeThresholds(0.8, 1).lapHi).toBeCloseTo(6, 12); // 1.8·4·0.8 = 5.76 < 6
  });

  it('scales with sigma: lapHi = 1.8·4σ and sobHi = 9σ above their floors', () => {
    const t = edgeThresholds(2, 1);
    expect(t.lapHi).toBeCloseTo(14.4, 12);
    expect(t.lapLo).toBeCloseTo(0.45 * 14.4, 12);
    expect(t.sobHi).toBeCloseTo(24, 12); // 18 < 24
    const t4 = edgeThresholds(4, 1);
    expect(t4.sobHi).toBeCloseTo(36, 12);
    expect(t4.sobLo).toBeCloseTo(14.4, 12);
  });

  it('divides every threshold by regionDetail', () => {
    const base = edgeThresholds(3, 1);
    for (const detail of [0.5, 1.5, 2]) {
      const t = edgeThresholds(3, detail);
      expect(t.lapHi).toBeCloseTo(base.lapHi / detail, 12);
      expect(t.lapLo).toBeCloseTo(base.lapLo / detail, 12);
      expect(t.sobHi).toBeCloseTo(base.sobHi / detail, 12);
      expect(t.sobLo).toBeCloseTo(base.sobLo / detail, 12);
    }
  });

  it('treats a non-finite or negative sigma as 0 and a non-positive or non-finite regionDetail as 1', () => {
    const ref = edgeThresholds(0, 1);
    expect(edgeThresholds(NaN, 1)).toEqual(ref);
    expect(edgeThresholds(-3, 1)).toEqual(ref);
    expect(edgeThresholds(0, 0)).toEqual(ref);
    expect(edgeThresholds(0, Infinity)).toEqual(ref);
  });
});

describe('edge band on gradientFeathers (phase 1)', () => {
  /** The edge mask segmentRegions builds for an opaque image. */
  function edgeMask(img: RasterImage): Uint8Array {
    const { width: w, height: h } = img;
    const maps = rgbEdgeMaps(gaussianBlurRaster(img, 0.7));
    const t = edgeThresholds(immerkaerSigma(img), 1);
    const lap = hysteresis(maps.laplacian.data, w, h, t.lapLo, t.lapHi).data;
    const sob = hysteresis(maps.sobel.data, w, h, t.sobLo, t.sobHi).data;
    return lap.map((v, i) => v | sob[i]);
  }

  /** 1 where every pixel within Chebyshev distance r carries the same ground-truth label. */
  function interior(labels: RegionMap, r: number): Uint8Array {
    const { width: w, height: h, data } = labels;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = data[y * w + x];
        let ok = true;
        for (let dy = -r; dy <= r && ok; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && data[yy * w + xx] !== l) {
              ok = false;
              break;
            }
          }
        }
        out[y * w + x] = ok ? 1 : 0;
      }
    }
    return out;
  }

  const cases = (): Array<[string, RasterImage, RegionMap]> => {
    const out: Array<[string, RasterImage, RegionMap]> = [];
    for (const seed of [1, 2, 3]) {
      const f = gradientFeathers(256, seed);
      out.push([`seed ${seed}`, f.image, f.labels]);
      out.push([`seed ${seed} + noise ±3`, withNoise(f.image, 3, seed), f.labels]);
    }
    return out;
  };

  it('edge pixels are between 3 % and 12 % of the image (measured 11.73-11.87 %)', () => {
    for (const [name, img] of cases()) {
      const edge = edgeMask(img);
      const share = edge.reduce((s, v) => s + v, 0) / edge.length;
      expect(share, name).toBeGreaterThanOrEqual(0.03);
      expect(share, name).toBeLessThanOrEqual(0.12);
    }
  });

  it('the laplacian inside the shapes (>= 3 px from any boundary) is ~0: mean < 0.5 (0.356), max <= 0.75 (rounding twice)', () => {
    for (const seed of [1, 2, 3]) {
      const f = gradientFeathers(256, seed);
      const lap = rgbEdgeMaps(gaussianBlurRaster(f.image, 0.7)).laplacian.data;
      const inside = interior(f.labels, 3);
      let sum = 0;
      let n = 0;
      let max = 0;
      for (let i = 0; i < lap.length; i++) {
        const l = f.labels.data[i];
        if (inside[i] === 0 || l < 1 || l > 8) continue;
        sum += lap[i];
        n++;
        if (lap[i] > max) max = lap[i];
      }
      expect(n, `seed ${seed}`).toBeGreaterThan(1500); // 1759 interior feather pixels on seed 1
      expect(sum / n, `seed ${seed}`).toBeLessThan(0.5);
      expect(max, `seed ${seed}`).toBeLessThanOrEqual(0.75);
    }
  });

  it('feathers 3 (blue→purple) and 4 (purple→blue) are split by an edge band without gaps', () => {
    for (const [name, img, labels] of cases()) {
      const { width: w, height: h } = img;
      const edge = edgeMask(img);
      const gt = labels.data;
      // Every 4-adjacent contact pair of the two feathers is edge on both sides.
      let pairs = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
            if (j < 0) continue;
            if ((gt[i] === 3 && gt[j] === 4) || (gt[i] === 4 && gt[j] === 3)) {
              pairs++;
              expect(edge[i] & edge[j], `${name} pair ${i}-${j}`).toBe(1);
            }
          }
        }
      }
      expect(pairs, name).toBeGreaterThanOrEqual(40);
      // No 4-path of non-edge pixels leads from feather 3 to feather 4.
      const seen = new Uint8Array(w * h);
      const stack: number[] = [];
      for (let i = 0; i < w * h; i++) {
        if (gt[i] === 3 && edge[i] === 0) {
          seen[i] = 1;
          stack.push(i);
        }
      }
      let reached = 0;
      while (stack.length > 0) {
        const p = stack.pop() as number;
        if (gt[p] === 4) reached++;
        const x = p % w;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
          if (q < 0 || q >= w * h || seen[q] !== 0 || edge[q] !== 0) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
      expect(reached, name).toBe(0);
    }
  });
});
