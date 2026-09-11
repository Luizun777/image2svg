import { describe, expect, it } from 'vitest';
import type { BinaryMask, Fill, LinearGradient, RasterImage, RegionMap, RGB } from '../../src/types';
import {
  aaCircle,
  aaDiagonalLine,
  coverage,
  filledSquare,
  flatShapes3,
  glyph,
  grayToRaster,
  nearestUpscale,
  noisePhoto,
  sprite32,
  transparentLogo,
  bakedCheckerLogo,
  chessboardGraphic,
  diagonalSweep,
  gradientFeathers,
  hueRamp,
  radialDisc,
  withNoise,
} from '../../src/dev/synth';
import { evaluateFill } from '../../src/core/fillEval';
import { assertMaskNested, maskIoU, rasterEquals } from './helpers';

// ---------------------------------------------------------------------------------------------
// Local test utilities (no dependency on other modules that may not exist yet)
// ---------------------------------------------------------------------------------------------

function mask(width: number, height: number, bits: number[]): BinaryMask {
  return { data: Uint8Array.from(bits), width, height };
}

function raster(width: number, height: number, bytes: number[]): RasterImage {
  return { data: Uint8ClampedArray.from(bytes), width, height };
}

function inkCount(m: BinaryMask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) if (m.data[i] !== 0) n++;
  return n;
}

function px(img: RasterImage, x: number, y: number): [number, number, number, number] {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

/** Sum over pixels of (255 - red)/255 — "ink coverage" of a grayscale ink-on-white image. */
function inkSum(img: RasterImage): number {
  let s = 0;
  for (let o = 0; o < img.data.length; o += 4) s += (255 - img.data[o]) / 255;
  return s;
}

function sum(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

/** BFS flood fill: number of connected components of pixels equal to `value`. */
function countComponents(m: BinaryMask, value: 0 | 1, eightConnected: boolean): number {
  const { width: w, height: h, data } = m;
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let count = 0;
  for (let start = 0; start < w * h; start++) {
    if (data[start] !== value || visited[start]) continue;
    count++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!eightConnected && dx !== 0 && dy !== 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (visited[q] || data[q] !== value) continue;
          visited[q] = 1;
          queue[tail++] = q;
        }
      }
    }
  }
  return count;
}

/** Distinct 5-bit-quantised colours (r>>3, g>>3, b>>3) among opaque pixels, with >= minCount px. */
function distinct5bit(img: RasterImage, minCount = 1): number {
  const counts = new Map<number, number>();
  for (let o = 0; o < img.data.length; o += 4) {
    const key = ((img.data[o] >> 3) << 10) | ((img.data[o + 1] >> 3) << 5) | (img.data[o + 2] >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let n = 0;
  for (const c of counts.values()) if (c >= minCount) n++;
  return n;
}

function distinctExact(img: RasterImage): Set<number> {
  const set = new Set<number>();
  for (let o = 0; o < img.data.length; o += 4) {
    set.add((img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2]);
  }
  return set;
}

function keyOf(c: RGB): number {
  return (c[0] << 16) | (c[1] << 8) | c[2];
}

/** Principal axis angle (degrees, y down) of the ink pixel distribution. */
function principalAngleDeg(m: BinaryMask): number {
  let n = 0;
  let mx = 0;
  let my = 0;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (m.data[y * m.width + x]) {
        n++;
        mx += x;
        my += y;
      }
    }
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (m.data[y * m.width + x]) {
        sxx += (x - mx) * (x - mx);
        syy += (y - my) * (y - my);
        sxy += (x - mx) * (y - my);
      }
    }
  }
  return (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI;
}

function isGrayscaleOpaque(img: RasterImage): boolean {
  for (let o = 0; o < img.data.length; o += 4) {
    if (img.data[o] !== img.data[o + 1] || img.data[o] !== img.data[o + 2]) return false;
    if (img.data[o + 3] !== 255) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// coverage / grayToRaster
// ---------------------------------------------------------------------------------------------

describe('coverage', () => {
  it('half-plane on a pixel boundary gives exact 0/1 coverage', () => {
    const cov = coverage(64, (x) => x - 32);
    expect(cov.length).toBe(64 * 64);
    expect(cov[10 * 64 + 31]).toBe(1);
    expect(cov[10 * 64 + 32]).toBe(0);
    expect(sum(cov)).toBe(64 * 32);
  });

  it('half-plane through a pixel centre gives exactly 0.5 on that column', () => {
    const cov = coverage(64, (x) => x - 32.5);
    expect(cov[5 * 64 + 32]).toBe(0.5);
    expect(cov[5 * 64 + 31]).toBe(1);
    expect(cov[5 * 64 + 33]).toBe(0);
    expect(sum(cov)).toBe(64 * 32 + 32);
  });

  it('uses (i+0.5)/ss subsample positions (ss=1 is the pixel-centre test)', () => {
    const cov = coverage(4, (x) => x - 2.4, 1);
    expect(Array.from(cov.subarray(0, 4))).toEqual([1, 1, 0, 0]);
    // ss=2: samples at x+0.25 and x+0.75 → pixel 2 has one sample (2.25) inside
    const cov2 = coverage(4, (x) => x - 2.4, 2);
    expect(cov2[2]).toBe(0.5);
  });

  it('values are multiples of 1/(ss*ss) in [0,1]', () => {
    const cov = coverage(16, (x, y) => Math.hypot(x - 8, y - 8) - 5);
    for (let i = 0; i < cov.length; i++) {
      expect(cov[i]).toBeGreaterThanOrEqual(0);
      expect(cov[i]).toBeLessThanOrEqual(1);
      expect(Math.abs(cov[i] * 64 - Math.round(cov[i] * 64))).toBeLessThan(1e-6);
    }
  });

  it('disc coverage sums to the disc area within 0.5 %', () => {
    const r = 20;
    const cov = coverage(64, (x, y) => Math.hypot(x - 32, y - 32) - r);
    const area = Math.PI * r * r;
    expect(Math.abs(sum(cov) - area) / area).toBeLessThan(0.005);
  });

  it('size 0 → empty; invalid size/ss throw', () => {
    expect(coverage(0, () => -1).length).toBe(0);
    expect(() => coverage(-1, () => -1)).toThrow(RangeError);
    expect(() => coverage(3.5, () => -1)).toThrow(RangeError);
    expect(() => coverage(4, () => -1, 0)).toThrow(RangeError);
  });
});

describe('grayToRaster', () => {
  it('blends ink over background with rounding to nearest', () => {
    const cov = Float32Array.from([0, 0.5, 1, 0.25]);
    const img = grayToRaster(cov, 2, [0, 0, 0], [255, 255, 255]);
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect(Array.from(img.data)).toEqual([
      255, 255, 255, 255, 128, 128, 128, 255, 0, 0, 0, 255, 191, 191, 191, 255,
    ]);
  });

  it('works per channel with coloured ink and background', () => {
    const img = grayToRaster(Float32Array.from([0.5]), 1, [200, 100, 0], [0, 0, 100]);
    expect(Array.from(img.data)).toEqual([100, 50, 50, 255]);
  });

  it('clamps out-of-range coverage and rejects mismatched lengths', () => {
    const img = grayToRaster(Float32Array.from([1.5, -0.5, NaN, 1]), 2, [0, 0, 0], [255, 255, 255]);
    expect(img.data[0]).toBe(0); // 1.5 → 1
    expect(img.data[4]).toBe(255); // -0.5 → 0
    expect(img.data[8]).toBe(255); // NaN → 0
    expect(img.data[12]).toBe(0);
    expect(() => grayToRaster(new Float32Array(3), 2, [0, 0, 0], [255, 255, 255])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// aaCircle
// ---------------------------------------------------------------------------------------------

describe('aaCircle', () => {
  const fx = aaCircle(64, 20);
  const area = Math.PI * 400;

  it('reports analytic area and perimeter', () => {
    expect(fx.area).toBeCloseTo(area, 10);
    expect(fx.perimeter).toBeCloseTo(2 * Math.PI * 20, 10);
  });

  it('is a 64×64 opaque grayscale image, black centre, white corners', () => {
    expect(fx.image.width).toBe(64);
    expect(fx.image.height).toBe(64);
    expect(isGrayscaleOpaque(fx.image)).toBe(true);
    expect(px(fx.image, 32, 32)).toEqual([0, 0, 0, 255]);
    expect(px(fx.image, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(px(fx.image, 63, 63)).toEqual([255, 255, 255, 255]);
  });

  it('ink sum of the 1x image is within 0.5 % of π r²', () => {
    expect(Math.abs(inkSum(fx.image) - area) / area).toBeLessThan(0.005);
  });

  it('has intermediate gray values on the edge (at least 50 pixels strictly in (10, 245))', () => {
    let mid = 0;
    for (let o = 0; o < fx.image.data.length; o += 4) {
      const v = fx.image.data[o];
      if (v > 10 && v < 245) mid++;
    }
    expect(mid).toBeGreaterThanOrEqual(50);
  });

  it('is symmetric about both axes', () => {
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        expect(px(fx.image, x, y)[0]).toBe(px(fx.image, 63 - x, y)[0]);
        expect(px(fx.image, x, y)[0]).toBe(px(fx.image, x, 63 - y)[0]);
      }
    }
  });

  it('maskAt(U) has size 64·U and ink count ≈ area·U² (2 % at 1x, 0.5 % at 4x)', () => {
    const m1 = fx.maskAt(1);
    expect(m1.width).toBe(64);
    expect(m1.height).toBe(64);
    expect(m1.data.length).toBe(64 * 64);
    expect(Math.abs(inkCount(m1) - area) / area).toBeLessThan(0.02);

    const m2 = fx.maskAt(2);
    expect(m2.width).toBe(128);
    expect(Math.abs(inkCount(m2) / 4 - area) / area).toBeLessThan(0.01);

    const m4 = fx.maskAt(4);
    expect(m4.width).toBe(256);
    expect(m4.data.length).toBe(256 * 256);
    expect(Math.abs(inkCount(m4) / 16 - area) / area).toBeLessThan(0.005);
  });

  it('maskAt uses the pixel-centre test', () => {
    const m1 = fx.maskAt(1);
    // (12, 32): centre (12.5, 32.5) → d = sqrt(19.5² + 0.5²) = 19.506 < 20 → ink
    expect(m1.data[32 * 64 + 12]).toBe(1);
    // (11, 32): centre (11.5, 32.5) → d = 20.506 → background
    expect(m1.data[32 * 64 + 11]).toBe(0);
    const m4 = fx.maskAt(4);
    // U=4 pixel (47, 128): centre ((47.5)/4, 128.5/4) = (11.875, 32.125) → d = 20.125 → bg
    expect(m4.data[128 * 256 + 47]).toBe(0);
    // pixel (48, 128): (12.125, 32.125) → d = 19.875 → ink
    expect(m4.data[128 * 256 + 48]).toBe(1);
  });

  it('every mask is a single component with no holes', () => {
    for (const U of [1, 2, 4]) {
      const m = fx.maskAt(U);
      expect(countComponents(m, 1, true)).toBe(1);
      expect(countComponents(m, 0, false)).toBe(1);
    }
  });

  it('rejects non-integer or non-positive U', () => {
    expect(() => fx.maskAt(0)).toThrow(RangeError);
    expect(() => fx.maskAt(1.5)).toThrow(RangeError);
  });

  it('honours custom size and radius', () => {
    const small = aaCircle(32, 10);
    expect(small.image.width).toBe(32);
    const a = Math.PI * 100;
    expect(Math.abs(inkSum(small.image) - a) / a).toBeLessThan(0.005);
    expect(small.maskAt(3).width).toBe(96);
  });
});

// ---------------------------------------------------------------------------------------------
// aaDiagonalLine
// ---------------------------------------------------------------------------------------------

describe('aaDiagonalLine', () => {
  const fx = aaDiagonalLine(64, 1.5, 30);
  // Segment half length: (32 - 8 - 0.75) / cos 30°, capsule area = 2·L·w + π (w/2)²
  const L = 23.25 / Math.cos(Math.PI / 6);
  const capsuleArea = 2 * L * 1.5 + Math.PI * 0.75 * 0.75;

  it('is a 64×64 opaque grayscale image with ink through the centre', () => {
    expect(fx.image.width).toBe(64);
    expect(isGrayscaleOpaque(fx.image)).toBe(true);
    expect(px(fx.image, 32, 32)[0]).toBeLessThan(128);
    expect(fx.maskAt(1).data[32 * 64 + 32]).toBe(1);
  });

  it('ink sum matches the capsule area within 3 %', () => {
    expect(Math.abs(inkSum(fx.image) - capsuleArea) / capsuleArea).toBeLessThan(0.03);
    const m4 = fx.maskAt(4);
    expect(Math.abs(inkCount(m4) / 16 - capsuleArea) / capsuleArea).toBeLessThan(0.03);
  });

  it('keeps an 8 px margin from every edge (1x image and 4x mask)', () => {
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (x < 8 || y < 8 || x >= 56 || y >= 56) expect(px(fx.image, x, y)[0]).toBe(255);
      }
    }
    const m4 = fx.maskAt(4);
    const lo = 8 * 4;
    const hi = (64 - 8) * 4 - 1;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        if (m4.data[y * 256 + x] && (x < lo || y < lo || x > hi || y > hi)) {
          throw new Error(`ink outside margin at (${x}, ${y})`);
        }
      }
    }
  });

  it('is one closed component at every resolution', () => {
    for (const U of [1, 2, 4]) {
      const m = fx.maskAt(U);
      expect(countComponents(m, 1, true)).toBe(1);
      expect(countComponents(m, 0, false)).toBe(1);
    }
  });

  it('runs at 30° (y down: upper-left → lower-right), ±1°', () => {
    const m4 = fx.maskAt(4);
    expect(Math.abs(principalAngleDeg(m4) - 30)).toBeLessThan(1);
    // upper half of the ink lies left of the centre, lower half to the right
    let topX = 0;
    let topN = 0;
    let botX = 0;
    let botN = 0;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        if (!m4.data[y * 256 + x]) continue;
        if (y < 128) {
          topX += x;
          topN++;
        } else {
          botX += x;
          botN++;
        }
      }
    }
    expect(topX / topN).toBeLessThan(120);
    expect(botX / botN).toBeGreaterThan(136);
  });

  it('vertical (90°) and horizontal (0°) lines occupy exactly the two centre columns/rows', () => {
    const v = aaDiagonalLine(64, 1.5, 90).maskAt(1);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (v.data[y * 64 + x]) expect(x === 31 || x === 32).toBe(true);
      }
    }
    // rows 9..54 are fully covered in both columns; round caps add row 8 and 55
    expect(v.data[9 * 64 + 31]).toBe(1);
    expect(v.data[54 * 64 + 32]).toBe(1);
    expect(v.data[8 * 64 + 31]).toBe(1);
    expect(v.data[7 * 64 + 31]).toBe(0);
    expect(inkCount(v)).toBe(2 * 48);

    const h = aaDiagonalLine(64, 1.5, 0).maskAt(1);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (h.data[y * 64 + x]) expect(y === 31 || y === 32).toBe(true);
      }
    }
    expect(inkCount(h)).toBe(2 * 48);
  });

  it('throws when the image cannot hold the margins', () => {
    expect(() => aaDiagonalLine(16, 1.5, 30)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// glyph
// ---------------------------------------------------------------------------------------------

describe('glyph', () => {
  const fx = glyph(48);
  // ring area + bar area inside the hole (∫_{-2}^{2} sqrt(81 - t²) dt)
  const ringArea = Math.PI * (14 * 14 - 9 * 9);
  const barInHole = 2 * (Math.sqrt(77) + 40.5 * Math.asin(2 / 9));
  const area = ringArea + barInHole;

  it('is a 48×48 opaque grayscale image with AA edges', () => {
    expect(fx.image.width).toBe(48);
    expect(isGrayscaleOpaque(fx.image)).toBe(true);
    let mid = 0;
    for (let o = 0; o < fx.image.data.length; o += 4) {
      const v = fx.image.data[o];
      if (v > 10 && v < 245) mid++;
    }
    expect(mid).toBeGreaterThanOrEqual(40);
  });

  it('samples: ring wall is ink, hole is background, bar reaches the centre', () => {
    const m = fx.maskAt(1);
    const at = (x: number, y: number): number => m.data[y * 48 + x];
    expect(at(24, 10)).toBe(1); // top of the ring wall
    expect(at(24, 12)).toBe(1);
    expect(at(24, 18)).toBe(0); // inside the hole
    expect(at(23, 24)).toBe(1); // bar, just left of the centre
    expect(at(24, 24)).toBe(0); // centre: bar ends at x=24, hole continues
    expect(at(30, 24)).toBe(0); // right side of the hole
    expect(at(36, 24)).toBe(1); // right ring wall
    expect(at(2, 2)).toBe(0);
  });

  it('is exactly one connected component with exactly one hole at 1x, 2x and 4x', () => {
    for (const U of [1, 2, 4]) {
      const m = fx.maskAt(U);
      expect(m.width).toBe(48 * U);
      expect(countComponents(m, 1, true)).toBe(1);
      expect(countComponents(m, 0, false)).toBe(2); // outside + one hole
    }
  });

  it('ink area matches the analytic union area (0.5 % at 1x AA, 1 % at 4x mask)', () => {
    expect(Math.abs(inkSum(fx.image) - area) / area).toBeLessThan(0.005);
    expect(Math.abs(inkCount(fx.maskAt(4)) / 16 - area) / area).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------------------------
// flatShapes3
// ---------------------------------------------------------------------------------------------

describe('flatShapes3', () => {
  const fx = flatShapes3(96);
  const BG: RGB = [0xf2, 0xe8, 0xd5];
  const CIRCLE: RGB = [0x2a, 0x6f, 0x97];
  const RECT: RGB = [0xe0, 0x7a, 0x5f];

  it('returns the palette [bg, circle, rect] and a 3-label map', () => {
    expect(fx.palette).toEqual([BG, CIRCLE, RECT]);
    expect(fx.labels.count).toBe(3);
    expect(fx.labels.width).toBe(96);
    expect(fx.labels.height).toBe(96);
    expect(fx.labels.data.length).toBe(96 * 96);
    expect(fx.image.width).toBe(96);
    expect(fx.image.height).toBe(96);
  });

  it('known pixels: background, circle interior, rect, rect over circle', () => {
    expect(px(fx.image, 5, 5)).toEqual([...BG, 255]);
    expect(fx.labels.data[5 * 96 + 5]).toBe(0);
    expect(px(fx.image, 40, 44)).toEqual([...CIRCLE, 255]);
    expect(fx.labels.data[44 * 96 + 40]).toBe(1);
    expect(px(fx.image, 66, 50)).toEqual([...RECT, 255]);
    expect(fx.labels.data[50 * 96 + 66]).toBe(2);
    expect(px(fx.image, 50, 44)).toEqual([...RECT, 255]); // inside both → rect wins
    expect(fx.labels.data[44 * 96 + 50]).toBe(2);
  });

  it('exactly the 3 palette colours appear as exact colours; blended pixels exist', () => {
    const colours = distinctExact(fx.image);
    const paletteKeys = new Set([keyOf(BG), keyOf(CIRCLE), keyOf(RECT)]);
    for (const k of paletteKeys) expect(colours.has(k)).toBe(true);
    const blended = [...colours].filter((k) => !paletteKeys.has(k));
    expect(blended.length).toBeGreaterThan(0);
    expect(colours.size).toBeGreaterThan(3);
  });

  it('every non-palette pixel is a linear blend of bg and circle (±1 per channel)', () => {
    let blends = 0;
    for (let p = 0; p < 96 * 96; p++) {
      const o = p * 4;
      const c: RGB = [fx.image.data[o], fx.image.data[o + 1], fx.image.data[o + 2]];
      expect(fx.image.data[o + 3]).toBe(255);
      const k = keyOf(c);
      if (k === keyOf(BG) || k === keyOf(CIRCLE) || k === keyOf(RECT)) continue;
      blends++;
      // t from the red channel (largest span: 242 → 42)
      const t = (BG[0] - c[0]) / (BG[0] - CIRCLE[0]);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
      for (let ch = 0; ch < 3; ch++) {
        const expected = BG[ch] + (CIRCLE[ch] - BG[ch]) * t;
        expect(Math.abs(c[ch] - expected)).toBeLessThanOrEqual(1);
      }
    }
    expect(blends).toBeGreaterThanOrEqual(50);
  });

  it('exact colours map to their label; rect covers exactly 40×40 px', () => {
    let rectCount = 0;
    let circleCount = 0;
    for (let p = 0; p < 96 * 96; p++) {
      const o = p * 4;
      const k = (fx.image.data[o] << 16) | (fx.image.data[o + 1] << 8) | fx.image.data[o + 2];
      const label = fx.labels.data[p];
      if (k === keyOf(BG)) expect(label).toBe(0);
      if (k === keyOf(CIRCLE)) expect(label).toBe(1);
      if (k === keyOf(RECT)) expect(label).toBe(2);
      if (label === 2) {
        rectCount++;
        expect(k).toBe(keyOf(RECT)); // crisp rect edges → every rect label is exact
      }
      if (label === 1) circleCount++;
    }
    expect(rectCount).toBe(1600);
    // circle area π·24² ≈ 1810 minus the part hidden by the rect (≈ 600)
    expect(circleCount).toBeGreaterThan(1100);
    expect(circleCount).toBeLessThan(1300);
  });

  it('scales with size', () => {
    const half = flatShapes3(48);
    expect(half.image.width).toBe(48);
    expect(px(half.image, 20, 22)).toEqual([...CIRCLE, 255]);
    expect(px(half.image, 33, 25)).toEqual([...RECT, 255]);
    let rect = 0;
    for (let p = 0; p < 48 * 48; p++) if (half.labels.data[p] === 2) rect++;
    expect(rect).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// sprite32 / nearestUpscale
// ---------------------------------------------------------------------------------------------

describe('sprite32', () => {
  it('is 32×32, deterministic per seed, different across seeds', () => {
    const a = sprite32(1);
    expect(a.width).toBe(32);
    expect(a.height).toBe(32);
    expect(a.data.length).toBe(32 * 32 * 4);
    expect(rasterEquals(a, sprite32(1))).toBe(true);
    expect(rasterEquals(sprite32(), sprite32(1))).toBe(true);
    expect(rasterEquals(a, sprite32(2))).toBe(false);
    expect(a.data).not.toBe(sprite32(1).data); // fresh buffer each call
  });

  it('alpha is 0 or 255; transparent pixels are zeroed; <= 6 opaque colours', () => {
    const img = sprite32(1);
    let transparent = 0;
    let opaque = 0;
    const colours = new Set<number>();
    for (let o = 0; o < img.data.length; o += 4) {
      const a = img.data[o + 3];
      expect(a === 0 || a === 255).toBe(true);
      if (a === 0) {
        transparent++;
        expect(img.data[o] | img.data[o + 1] | img.data[o + 2]).toBe(0);
      } else {
        opaque++;
        colours.add((img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2]);
      }
    }
    expect(transparent).toBeGreaterThan(0);
    expect(opaque).toBeGreaterThan(0);
    expect(opaque / 1024).toBeGreaterThan(0.1);
    expect(opaque / 1024).toBeLessThan(0.9);
    expect(colours.size).toBeLessThanOrEqual(6);
    expect(colours.size).toBeGreaterThanOrEqual(3);
  });

  it('opaque pixels form blocks: every opaque pixel has an opaque 4-neighbour (blocks >= 2 px)', () => {
    const img = sprite32(7);
    const at = (x: number, y: number): number =>
      x < 0 || y < 0 || x >= 32 || y >= 32 ? 0 : img.data[(y * 32 + x) * 4 + 3];
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        if (!at(x, y)) continue;
        const n = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1);
        expect(n).toBeGreaterThan(0);
      }
    }
  });
});

describe('nearestUpscale', () => {
  it('replicates each pixel k×k', () => {
    const src = raster(2, 2, [
      1, 2, 3, 4, 5, 6, 7, 8, //
      9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    const up = nearestUpscale(src, 3);
    expect(up.width).toBe(6);
    expect(up.height).toBe(6);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        const sx = Math.floor(x / 3);
        const sy = Math.floor(y / 3);
        expect(px(up, x, y)).toEqual(px(src, sx, sy));
      }
    }
  });

  it('k=1 is a copy with a fresh buffer; invalid k throws', () => {
    const src = sprite32(3);
    const copy = nearestUpscale(src, 1);
    expect(rasterEquals(copy, src)).toBe(true);
    expect(copy.data).not.toBe(src.data);
    expect(() => nearestUpscale(src, 0)).toThrow(RangeError);
    expect(() => nearestUpscale(src, 2.5)).toThrow(RangeError);
  });

  it('upscaled sprite has constant k×k blocks equal to the source pixel', () => {
    const src = sprite32(1);
    const up = nearestUpscale(src, 4);
    expect(up.width).toBe(128);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const s = px(src, x >> 2, y >> 2);
        const u = px(up, x, y);
        if (s[0] !== u[0] || s[1] !== u[1] || s[2] !== u[2] || s[3] !== u[3]) {
          throw new Error(`mismatch at (${x}, ${y})`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// transparentLogo
// ---------------------------------------------------------------------------------------------

describe('transparentLogo', () => {
  const fx = transparentLogo(64);
  // 5-point star area = 5 · R · r · sin(36°)
  const area = 5 * 26 * 11 * Math.sin(Math.PI / 5);

  it('RGB is constant #1D3557 everywhere, including transparent pixels', () => {
    expect(fx.image.width).toBe(64);
    expect(fx.image.height).toBe(64);
    for (let o = 0; o < fx.image.data.length; o += 4) {
      if (fx.image.data[o] !== 0x1d || fx.image.data[o + 1] !== 0x35 || fx.image.data[o + 2] !== 0x57) {
        throw new Error(`RGB differs at byte ${o}`);
      }
    }
  });

  it('alpha: 0 in the background, 255 inside, intermediate on the edges', () => {
    expect(px(fx.image, 0, 0)[3]).toBe(0);
    expect(px(fx.image, 63, 63)[3]).toBe(0);
    expect(px(fx.image, 32, 50)[3]).toBe(0); // between the two lower tips
    expect(px(fx.image, 32, 32)[3]).toBe(255);
    expect(px(fx.image, 32, 12)[3]).toBe(255); // inside the upper tip
    expect(px(fx.image, 32, 5)[3]).toBe(0); // above the upper tip (tip at y=6)
    const tip = px(fx.image, 32, 7)[3];
    expect(tip).toBeGreaterThan(0);
    expect(tip).toBeLessThan(255);
    let mid = 0;
    for (let o = 3; o < fx.image.data.length; o += 4) {
      const a = fx.image.data[o];
      if (a > 0 && a < 255) mid++;
    }
    expect(mid).toBeGreaterThanOrEqual(60);
  });

  it('alpha sum equals the star area within 0.5 %', () => {
    let s = 0;
    for (let o = 3; o < fx.image.data.length; o += 4) s += fx.image.data[o] / 255;
    expect(Math.abs(s - area) / area).toBeLessThan(0.005);
  });

  it('maskAt(U): size 64·U, area within 2 % (1x) / 0.5 % (4x), mirror-symmetric, one component', () => {
    const m1 = fx.maskAt(1);
    expect(m1.width).toBe(64);
    expect(Math.abs(inkCount(m1) - area) / area).toBeLessThan(0.02);
    const m4 = fx.maskAt(4);
    expect(m4.width).toBe(256);
    expect(Math.abs(inkCount(m4) / 16 - area) / area).toBeLessThan(0.005);
    for (const m of [m1, m4]) {
      const w = m.width;
      for (let y = 0; y < w; y++) {
        for (let x = 0; x < w; x++) {
          if (m.data[y * w + x] !== m.data[y * w + (w - 1 - x)]) {
            throw new Error(`asymmetric at (${x}, ${y}) U=${w / 64}`);
          }
        }
      }
      expect(countComponents(m, 1, true)).toBe(1);
      expect(countComponents(m, 0, false)).toBe(1);
    }
  });

  it('1x mask agrees with alpha >= 128 on all but a handful of edge pixels', () => {
    const m1 = fx.maskAt(1);
    let mismatches = 0;
    for (let p = 0; p < 64 * 64; p++) {
      const ink = fx.image.data[p * 4 + 3] >= 128 ? 1 : 0;
      if (ink !== m1.data[p]) mismatches++;
    }
    expect(mismatches).toBeLessThanOrEqual(12);
  });
});

// ---------------------------------------------------------------------------------------------
// noisePhoto
// ---------------------------------------------------------------------------------------------

describe('noisePhoto', () => {
  const img = noisePhoto(64, 1);

  it('is 64×64 opaque and deterministic per seed', () => {
    expect(img.width).toBe(64);
    expect(img.height).toBe(64);
    for (let o = 3; o < img.data.length; o += 4) expect(img.data[o]).toBe(255);
    expect(rasterEquals(img, noisePhoto(64, 1))).toBe(true);
    expect(rasterEquals(img, noisePhoto())).toBe(true);
    expect(rasterEquals(img, noisePhoto(64, 2))).toBe(false);
    expect(noisePhoto(32, 5).width).toBe(32);
  });

  it('has more than 200 distinct 5-bit colours (also counting only colours with >= 3 px)', () => {
    expect(distinct5bit(img)).toBeGreaterThan(200);
    expect(distinct5bit(img, 3)).toBeGreaterThan(200);
    expect(distinct5bit(noisePhoto(64, 2))).toBeGreaterThan(200);
    expect(distinct5bit(noisePhoto(64, 3))).toBeGreaterThan(200);
  });

  it('is smooth (mean horizontal step < 20 per channel) but has real contrast (std > 25)', () => {
    let steps = 0;
    let stepSum = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 1; x < 64; x++) {
        const o = (y * 64 + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          stepSum += Math.abs(img.data[o + ch] - img.data[o - 4 + ch]);
          steps++;
        }
      }
    }
    expect(stepSum / steps).toBeLessThan(20);
    for (let ch = 0; ch < 3; ch++) {
      let s = 0;
      let s2 = 0;
      let min = 255;
      let max = 0;
      for (let o = ch; o < img.data.length; o += 4) {
        const v = img.data[o];
        s += v;
        s2 += v * v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const mean = s / 4096;
      const std = Math.sqrt(s2 / 4096 - mean * mean);
      expect(std).toBeGreaterThan(25);
      expect(max - min).toBeGreaterThan(120);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// filledSquare
// ---------------------------------------------------------------------------------------------

describe('filledSquare', () => {
  it('64/16: black 32×32 square on white, hard edges', () => {
    const img = filledSquare(64, 16);
    expect(img.width).toBe(64);
    expect(isGrayscaleOpaque(img)).toBe(true);
    let black = 0;
    for (let o = 0; o < img.data.length; o += 4) {
      const v = img.data[o];
      expect(v === 0 || v === 255).toBe(true);
      if (v === 0) black++;
    }
    expect(black).toBe(32 * 32);
    expect(px(img, 16, 16)[0]).toBe(0);
    expect(px(img, 47, 47)[0]).toBe(0);
    expect(px(img, 15, 16)[0]).toBe(255);
    expect(px(img, 48, 47)[0]).toBe(255);
    expect(px(img, 16, 15)[0]).toBe(255);
  });

  it('defaults and custom inset', () => {
    expect(rasterEquals(filledSquare(), filledSquare(64, 16))).toBe(true);
    const small = filledSquare(10, 3);
    let black = 0;
    for (let o = 0; o < small.data.length; o += 4) if (small.data[o] === 0) black++;
    expect(black).toBe(16);
    // inset >= size/2 → all white
    let blackNone = 0;
    const none = filledSquare(8, 4);
    for (let o = 0; o < none.data.length; o += 4) if (none.data[o] === 0) blackNone++;
    expect(blackNone).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

describe('helpers', () => {
  it('maskIoU', () => {
    const a = mask(3, 1, [1, 1, 0]);
    const b = mask(3, 1, [0, 1, 1]);
    expect(maskIoU(a, a)).toBe(1);
    expect(maskIoU(a, b)).toBeCloseTo(1 / 3, 12);
    expect(maskIoU(mask(2, 1, [1, 0]), mask(2, 1, [0, 1]))).toBe(0);
    expect(maskIoU(mask(2, 1, [0, 0]), mask(2, 1, [0, 0]))).toBe(1);
    expect(maskIoU(mask(2, 1, [0, 0]), mask(2, 1, [0, 1]))).toBe(0);
    expect(() => maskIoU(a, mask(1, 3, [1, 1, 0]))).toThrow();
  });

  it('assertMaskNested passes for nested masks and reports the violation count', () => {
    const outer = mask(2, 2, [1, 1, 1, 0]);
    expect(() => assertMaskNested(outer, mask(2, 2, [1, 0, 1, 0]))).not.toThrow();
    expect(() => assertMaskNested(outer, outer)).not.toThrow();
    expect(() => assertMaskNested(outer, mask(2, 2, [0, 0, 0, 0]))).not.toThrow();
    expect(() => assertMaskNested(mask(2, 2, [0, 1, 0, 0]), mask(2, 2, [1, 1, 1, 0]))).toThrow(/2/);
    expect(() => assertMaskNested(outer, mask(1, 4, [1, 1, 1, 0]))).toThrow();
  });

  it('rasterEquals compares dimensions and bytes', () => {
    const a = raster(1, 2, [1, 2, 3, 4, 5, 6, 7, 8]);
    const b = raster(1, 2, [1, 2, 3, 4, 5, 6, 7, 8]);
    const c = raster(1, 2, [1, 2, 3, 4, 5, 6, 7, 9]);
    const d = raster(2, 1, [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rasterEquals(a, b)).toBe(true);
    expect(rasterEquals(a, c)).toBe(false);
    expect(rasterEquals(a, d)).toBe(false);
  });
});

describe('bakedCheckerLogo', () => {
  it('is opaque and deterministic per seed, with a neutral painted checkerboard behind the magenta logo', () => {
    const a = bakedCheckerLogo();
    const b = bakedCheckerLogo();
    expect(a.image.width).toBe(128);
    expect(a.image.height).toBe(128);
    expect(Array.from(a.image.data)).toEqual(Array.from(b.image.data));
    expect(Array.from(bakedCheckerLogo({ seed: 2 }).image.data)).not.toEqual(Array.from(a.image.data));
    const d = a.image.data;
    for (let p = 3; p < d.length; p += 4) expect(d[p]).toBe(255);
    const px = (x: number, y: number): number[] => Array.from(d.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 3));
    // Parity 0 (255) at (2, 2), parity 1 (204) at (12, 2); noise +-4 per channel.
    for (const v of px(2, 2)) expect(Math.abs(v - 255)).toBeLessThanOrEqual(4);
    for (const v of px(12, 2)) expect(Math.abs(v - 204)).toBeLessThanOrEqual(4);
    // Disc centre (64, 53.76) is magenta #E6007E.
    const c = px(64, 54);
    expect(Math.abs(c[0] - 230)).toBeLessThanOrEqual(4);
    expect(c[1]).toBeLessThanOrEqual(4);
    expect(Math.abs(c[2] - 126)).toBeLessThanOrEqual(4);
    // background is exactly coverage < 0.5; the coverage integrates the disc (pi * 30.72^2) and the
    // bar (87.04 x 15.36), which do not overlap, within 0.5 %.
    let covered = 0;
    for (let i = 0; i < a.coverage.length; i++) {
      expect(a.background.data[i]).toBe(a.coverage[i] < 0.5 ? 1 : 0);
      covered += a.coverage[i];
    }
    const logoArea = Math.PI * 30.72 * 30.72 + 87.04 * 15.36;
    expect(Math.abs(covered - logoArea) / logoArea).toBeLessThan(0.005);
  });

  it('counters are checkerboard holes inside the disc; whiteRect is an opaque white rectangle', () => {
    const holes = bakedCheckerLogo({ inner: 'counters' });
    let counters = 0;
    for (let i = 0; i < holes.counters.data.length; i++) {
      if (holes.counters.data[i] === 0) continue;
      counters++;
      expect(holes.coverage[i]).toBe(0);
      expect(holes.background.data[i]).toBe(1);
    }
    expect(counters).toBeGreaterThan(100);
    const rect = bakedCheckerLogo({ inner: 'whiteRect', cell: 16 });
    let white = 0;
    for (let i = 0; i < rect.whiteRect.data.length; i++) {
      if (rect.whiteRect.data[i] === 0) continue;
      white++;
      expect(rect.background.data[i]).toBe(0);
      for (let ch = 0; ch < 3; ch++) expect(rect.image.data[i * 4 + ch]).toBeGreaterThanOrEqual(251);
    }
    expect(white).toBeGreaterThan(600);
    expect(bakedCheckerLogo().counters.data.every((v) => v === 0)).toBe(true);
  });

  it('accepts fractional cells and rejects invalid ones', () => {
    const f = bakedCheckerLogo({ cell: 12.5, noise: 0, offset: [3, 7], levels: [153, 252] });
    // x = 2 lies in cell floor((2.5 - 3) / 12.5) = -1, y = 10 in floor((10.5 - 7) / 12.5) = 0: parity 1.
    expect(f.image.data[(10 * 128 + 2) * 4]).toBe(252);
    expect(f.image.data[(10 * 128 + 4) * 4]).toBe(153);
    expect(() => bakedCheckerLogo({ cell: 0 })).toThrow(RangeError);
    expect(() => bakedCheckerLogo({ cell: Number.NaN })).toThrow(RangeError);
  });
});

describe('chessboardGraphic', () => {
  it('draws an 8x8 board of the two levels on a solid background that fills the border', () => {
    const { image, board } = chessboardGraphic();
    expect(image.width).toBe(96);
    const d = image.data;
    let inBoard = 0;
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 96; x++) {
        const o = (y * 96 + x) * 4;
        expect(d[o + 3]).toBe(255);
        if (board.data[y * 96 + x] !== 0) {
          inBoard++;
          continue;
        }
        expect([d[o], d[o + 1], d[o + 2]]).toEqual([40, 90, 160]);
      }
    }
    expect(inBoard).toBe(64 * 64);
    expect(d[(16 * 96 + 16) * 4]).toBe(255);
    expect(d[(16 * 96 + 24) * 4]).toBe(204);
    expect(d[(24 * 96 + 24) * 4]).toBe(255);
  });
});

// ---------------------------------------------------------------------------------------------
// Gradient fixtures
// ---------------------------------------------------------------------------------------------

const WHITE_RGB: RGB = [255, 255, 255];

/** Largest channel gap between a pixel and round(fill at the pixel centre). */
function fillGap(img: RasterImage, fill: Fill, x: number, y: number): number {
  const c = evaluateFill(fill, x + 0.5, y + 0.5, [0, 0, 0]);
  const o = (y * img.width + x) * 4;
  return Math.max(
    Math.abs(img.data[o] - Math.round(c[0])),
    Math.abs(img.data[o + 1] - Math.round(c[1])),
    Math.abs(img.data[o + 2] - Math.round(c[2])),
  );
}

function labelMask(labels: RegionMap, id: number): BinaryMask {
  const data = new Uint8Array(labels.data.length);
  for (let i = 0; i < data.length; i++) data[i] = labels.data[i] === id ? 1 : 0;
  return { data, width: labels.width, height: labels.height };
}

const hex = (c: RGB): string => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

/** Pairs "a-b" (a < b, both non-background) of labels that are 4-adjacent somewhere. */
function touchingPairs(labels: RegionMap): string[] {
  const { width: w, height: h, data } = labels;
  const pairs = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[y * w + x];
      const right = x + 1 < w ? data[y * w + x + 1] : a;
      const below = y + 1 < h ? data[(y + 1) * w + x] : a;
      for (const b of [right, below]) {
        if (a !== b && a !== 0 && b !== 0) pairs.add(`${Math.min(a, b)}-${Math.max(a, b)}`);
      }
    }
  }
  return [...pairs].sort();
}

/**
 * Pixels at least 1 px inside their topmost shape and 1 px away from every later one (or 1 px away from
 * every shape for the background): no anti-aliasing reaches them. Calls visit(x, y, topIndex | -1).
 */
function forEachInterior(size: number, sdfs: ReadonlyArray<(x: number, y: number) => number>, visit: (x: number, y: number, top: number) => void): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = sdfs.map((f) => f(x + 0.5, y + 0.5));
      let top = -1;
      for (let k = 0; k < d.length; k++) if (d[k] < 0) top = k;
      if (top >= 0 && d[top] > -1) continue;
      if (d.some((v, k) => k > top && v < 1)) continue;
      visit(x, y, top);
    }
  }
}

describe('gradientFeathers', () => {
  const fx = gradientFeathers();
  const { image, shapes, labels } = fx;

  it('is deterministic; the seed only changes the tip lengths', () => {
    const again = gradientFeathers();
    expect(rasterEquals(again.image, image)).toBe(true);
    expect(again.labels.data).toEqual(labels.data);
    const other = gradientFeathers(256, 2);
    expect(rasterEquals(other.image, image)).toBe(false);
    for (let k = 0; k < 8; k++) {
      const a = shapes[k].fill as LinearGradient;
      const b = other.shapes[k].fill as LinearGradient;
      expect([b.x1, b.y1, b.stops]).toEqual([a.x1, a.y1, a.stops]);
      const length = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
      expect(length).toBeGreaterThanOrEqual(104 * 0.94 - 1e-9);
      expect(length).toBeLessThanOrEqual(104 + 1e-9);
    }
  });

  it('white background, 8 two-stop linear feathers along their axes with distinct colours, a flat shadow last', () => {
    expect(fx.background).toEqual(WHITE_RGB);
    expect(shapes.map((sh) => sh.label)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([image.width, labels.width, labels.height, labels.count]).toEqual([256, 256, 256, 10]);
    const pairs = new Set<string>();
    for (let k = 0; k < 8; k++) {
      const f = shapes[k].fill;
      if (f.kind !== 'linear') throw new Error(`feather ${k + 1} is not linear`);
      expect(f.stops.map((st) => st.offset)).toEqual([0, 1]);
      pairs.add(f.stops.map((st) => hex(st.color)).join('>'));
      expect((Math.atan2(-(f.y2 - f.y1), f.x2 - f.x1) * 180) / Math.PI).toBeCloseTo(7 + 22.5 * k, 9);
      // The ramp runs from the middle of the base edge to the middle of the tip edge.
      expect(Math.abs(shapes[k].sdf(f.x1, f.y1))).toBeLessThan(1e-9);
      expect(Math.abs(shapes[k].sdf(f.x2, f.y2))).toBeLessThan(1e-9);
      expect(shapes[k].sdf((f.x1 + f.x2) / 2, (f.y1 + f.y2) / 2)).toBeLessThan(-3);
    }
    expect(pairs.size).toBe(8);
    expect((shapes[2].fill as LinearGradient).stops.map((st) => hex(st.color))).toEqual(['#2040d0', '#8030c0']);
    expect((shapes[3].fill as LinearGradient).stops.map((st) => hex(st.color))).toEqual(['#8030c0', '#2040d0']);
    expect(shapes[8].fill).toEqual({ kind: 'solid', color: [0x20, 0x22, 0x2a] });
  });

  it('ground truth: every interior pixel is round(fill at its centre) within 1 level and carries its label', () => {
    let interior = 0;
    let worst = 0;
    let wrongLabel = 0;
    const bg: Fill = { kind: 'solid', color: fx.background };
    forEachInterior(256, shapes.map((sh) => sh.sdf), (x, y, top) => {
      interior++;
      worst = Math.max(worst, fillGap(image, top < 0 ? bg : shapes[top].fill, x, y));
      if (labels.data[y * 256 + x] !== top + 1) wrongLabel++;
    });
    expect(interior).toBeGreaterThan(0.9 * 256 * 256);
    expect(worst).toBeLessThanOrEqual(1);
    expect(wrongLabel).toBe(0);
  });

  it('labels cover every pixel; each shape is one 4-connected piece; only 3-4 and the shadow with 6 and 7 touch', () => {
    for (const seed of [1, 2, 3]) {
      const f = seed === 1 ? fx : gradientFeathers(256, seed);
      const seen = new Set<number>(f.labels.data);
      expect([...seen].sort((a, b) => a - b), `seed ${seed}`).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      for (let id = 0; id < 10; id++) {
        expect(countComponents(labelMask(f.labels, id), 1, false), `seed ${seed} label ${id}`).toBe(1);
      }
      expect(touchingPairs(f.labels), `seed ${seed}`).toEqual(['3-4', '6-9', '7-9']);
    }
  });

  it('feathers 3 and 4 are 4-adjacent along their shared side, where their ramps differ by >= 33 levels', () => {
    const f3 = shapes[2].fill;
    const f4 = shapes[3].fill;
    const c3: RGB = [0, 0, 0];
    const c4: RGB = [0, 0, 0];
    let contacts = 0;
    let minGap = Infinity;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        if (labels.data[y * 256 + x] !== 3) continue;
        for (const [nx, ny] of [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ]) {
          if (labels.data[ny * 256 + nx] !== 4) continue;
          contacts++;
          evaluateFill(f3, x + 0.5, y + 0.5, c3);
          evaluateFill(f4, nx + 0.5, ny + 0.5, c4);
          minGap = Math.min(minGap, Math.max(Math.abs(c3[0] - c4[0]), Math.abs(c3[1] - c4[1]), Math.abs(c3[2] - c4[2])));
        }
      }
    }
    // Measured on seeds 1..8: 44 contacts, smallest gap 33.5..36.1 levels (seed 1: 35.7).
    expect(contacts).toBeGreaterThanOrEqual(40);
    expect(minGap).toBeGreaterThanOrEqual(33);
  });

  it('the shadow covers part of feathers 6 and 7 and nothing reaches within 3 px of the border', () => {
    let over6 = 0;
    let over7 = 0;
    let nearBorder = 0;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        if (shapes[8].sdf(cx, cy) < 0) {
          if (shapes[5].sdf(cx, cy) < 0) over6++;
          if (shapes[6].sdf(cx, cy) < 0) over7++;
        }
        if ((x < 3 || y < 3 || x > 252 || y > 252) && labels.data[y * 256 + x] !== 0) nearBorder++;
      }
    }
    expect(over6).toBeGreaterThan(20);
    expect(over7).toBeGreaterThan(20);
    expect(nearBorder).toBe(0);
  });

  it('scales with size', () => {
    const small = gradientFeathers(128);
    expect([small.image.width, small.labels.count]).toEqual([128, 10]);
    for (let id = 0; id < 10; id++) expect(countComponents(labelMask(small.labels, id), 1, false), `label ${id}`).toBe(1);
    const a = shapes[0].fill as LinearGradient;
    const b = small.shapes[0].fill as LinearGradient;
    expect([b.x1, b.y1, b.x2, b.y2].map((v) => v * 2)).toEqual([a.x1, a.y1, a.x2, a.y2].map((v) => expect.closeTo(v, 9)));
  });
});

describe('radialDisc', () => {
  const fx = radialDisc();

  it('a 3-stop radial gradient centred on the disc with r = its radius; deterministic', () => {
    expect(fx.fill).toEqual({
      kind: 'radial',
      cx: 60,
      cy: 66,
      r: 48,
      stops: [
        { offset: 0, color: [0xff, 0xe0, 0x8a] },
        { offset: 0.5, color: [0xff, 0x7a, 0x3d] },
        { offset: 1, color: [0x7a, 0x1f, 0xa2] },
      ],
    });
    expect(fx.sdf(60, 66)).toBe(-48);
    expect(fx.sdf(108, 66)).toBeCloseTo(0, 12);
    expect(rasterEquals(radialDisc().image, fx.image)).toBe(true);
  });

  it('interior pixels are the fill at their centre (±1 level); pixels 1 px outside are white', () => {
    let inside = 0;
    let worst = 0;
    let notWhite = 0;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const d = fx.sdf(x + 0.5, y + 0.5);
        if (d < -1) {
          inside++;
          worst = Math.max(worst, fillGap(fx.image, fx.fill, x, y));
        } else if (d > 1 && px(fx.image, x, y).some((v) => v !== 255)) notWhite++;
      }
    }
    expect(inside).toBeGreaterThan(0.95 * Math.PI * 47 * 47);
    expect(worst).toBeLessThanOrEqual(1);
    expect(notWhite).toBe(0);
  });

  it('scales with size', () => {
    const big = radialDisc(256);
    expect([big.image.width, big.fill.cx, big.fill.cy, big.fill.r]).toEqual([256, 120, 132, 96]);
  });
});

describe('diagonalSweep', () => {
  const fx = diagonalSweep();

  it('a rounded square with a 4-stop gradient from the bottom-left to the top-right', () => {
    expect(fx.fill.stops.map((st) => st.offset)).toEqual([0, 0.3, 0.65, 1]);
    expect(fx.fill.stops.map((st) => hex(st.color))).toEqual(['#feda75', '#fa7e1e', '#d62976', '#962fbf']);
    expect([fx.fill.x1, fx.fill.y1, fx.fill.x2, fx.fill.y2]).toEqual([20, 108, 108, 20]);
    expect(fx.sdf(64, 64)).toBe(-48);
    expect(fx.sdf(16.5, 16.5)).toBeGreaterThan(0); // rounded corner
    expect(fx.sdf(16.5, 64)).toBeLessThan(0);
    expect(rasterEquals(diagonalSweep().image, fx.image)).toBe(true);
  });

  it('interior pixels are the fill at their centre (±1 level); pixels 1 px outside are white', () => {
    let inside = 0;
    let worst = 0;
    let notWhite = 0;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const d = fx.sdf(x + 0.5, y + 0.5);
        if (d < -1) {
          inside++;
          worst = Math.max(worst, fillGap(fx.image, fx.fill, x, y));
        } else if (d > 1 && px(fx.image, x, y).some((v) => v !== 255)) notWhite++;
      }
    }
    expect(inside).toBeGreaterThan(0.9 * (96 * 96 - (4 - Math.PI) * 20 * 20));
    expect(worst).toBeLessThanOrEqual(1);
    expect(notWhite).toBe(0);
  });
});

describe('hueRamp', () => {
  const fx = hueRamp();

  it('every pixel is the red → green ramp at its centre, identical rows', () => {
    expect(fx.fill).toEqual({
      kind: 'linear',
      x1: 0,
      y1: 48,
      x2: 96,
      y2: 48,
      stops: [
        { offset: 0, color: [0xed, 0x2b, 0x2b] },
        { offset: 1, color: [0x14, 0x9e, 0x14] },
      ],
    });
    let worst = 0;
    for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) worst = Math.max(worst, fillGap(fx.image, fx.fill, x, y));
    expect(worst).toBe(0);
    for (let x = 1; x < 96; x++) {
      expect(px(fx.image, x, 0)[0]).toBeLessThanOrEqual(px(fx.image, x - 1, 0)[0]);
      expect(px(fx.image, x, 0)[1]).toBeGreaterThanOrEqual(px(fx.image, x - 1, 0)[1]);
      expect(px(fx.image, x, 77)).toEqual(px(fx.image, x, 0));
    }
  });

  it('keeps a constant Rec.601 luma of 101.006 up to rounding (±0.5)', () => {
    let worst = 0;
    for (let o = 0; o < fx.image.data.length; o += 4) {
      const d = fx.image.data;
      worst = Math.max(worst, Math.abs(0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2] - 101.006));
    }
    expect(worst).toBeLessThanOrEqual(0.5 + 1e-9);
  });
});

describe('withNoise', () => {
  function grey(): RasterImage {
    const data = new Uint8ClampedArray(64 * 64 * 4).fill(128);
    for (let o = 3; o < data.length; o += 4) data[o] = (o >> 2) % 256;
    return { data, width: 64, height: 64 };
  }

  it('adds seeded uniform integer noise in [-amp, amp] to each channel and leaves alpha untouched', () => {
    const img = grey();
    const noisy = withNoise(img);
    expect(rasterEquals(withNoise(grey()), noisy)).toBe(true);
    expect(rasterEquals(withNoise(grey(), 3, 2), noisy)).toBe(false);
    const counts = new Map<number, number>();
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let o = 0; o < noisy.data.length; o += 4) {
      expect(noisy.data[o + 3]).toBe(img.data[o + 3]);
      for (let ch = 0; ch < 3; ch++) {
        const delta = noisy.data[o + ch] - 128;
        counts.set(delta, (counts.get(delta) ?? 0) + 1);
        sum += delta;
        sq += delta * delta;
        n++;
      }
    }
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(Math.abs(sum / n)).toBeLessThan(0.1);
    expect(Math.sqrt(sq / n - (sum / n) ** 2)).toBeCloseTo(2, 1); // sqrt(3·4/3)
    expect(img.data.every((v, i) => i % 4 === 3 || v === 128)).toBe(true);
  });

  it('clamps at 255 and amp 0 is an exact copy', () => {
    const white: RasterImage = { data: new Uint8ClampedArray(16 * 16 * 4).fill(255), width: 16, height: 16 };
    const noisy = withNoise(white, 3, 5);
    expect(noisy.data.every((v) => v >= 252 && v <= 255)).toBe(true);
    const img = grey();
    const copy = withNoise(img, 0);
    expect(rasterEquals(copy, img)).toBe(true);
    expect(copy.data).not.toBe(img.data);
  });
});
