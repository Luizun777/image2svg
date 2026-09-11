import { describe, expect, it } from 'vitest';
import type { BinaryMask, RasterImage, RGB } from '../../src/types';
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
} from '../../src/dev/synth';
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
