import { describe, expect, it } from 'vitest';
import type { GrayImage } from '../../src/types';
import { ssim } from '../../src/metrics/ssim';
import { toGray } from '../../src/core/raster';
import { aaCircle, noisePhoto } from '../../src/dev/synth';

const C1 = 6.5025;
const C2 = 58.5225;

function gray(width: number, height: number, f: (x: number, y: number) => number): GrayImage {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y);
  return { data, width, height };
}

function invert(g: GrayImage): GrayImage {
  const data = new Float32Array(g.data.length);
  for (let i = 0; i < data.length; i++) data[i] = 255 - g.data[i];
  return { data, width: g.width, height: g.height };
}

/** Deterministic pseudo-random noise in [-amp, amp] (mulberry32). */
function addNoise(g: GrayImage, amp: number, seed = 7): GrayImage {
  let a = seed | 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const data = new Float32Array(g.data.length);
  for (let i = 0; i < data.length; i++) {
    let v = g.data[i] + (rand() * 2 - 1) * amp;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    data[i] = v;
  }
  return { data, width: g.width, height: g.height };
}

/** Reference SSIM of two equally sized sample sets (single window). */
function ssimRef(a: number[], b: number[]): number {
  const n = a.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += a[i];
    my += b[i];
  }
  mx /= n;
  my /= n;
  let vx = 0;
  let vy = 0;
  let cxy = 0;
  for (let i = 0; i < n; i++) {
    vx += (a[i] - mx) * (a[i] - mx);
    vy += (b[i] - my) * (b[i] - my);
    cxy += (a[i] - mx) * (b[i] - my);
  }
  vx /= n;
  vy /= n;
  cxy /= n;
  return ((2 * mx * my + C1) * (2 * cxy + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
}

describe('ssim', () => {
  it('ssim(a, a) = 1 (+-1e-9) for a circle, a photo-like texture and a constant image', () => {
    const circle = toGray(aaCircle(64, 20).image);
    expect(Math.abs(ssim(circle, circle) - 1)).toBeLessThan(1e-9);
    const photo = toGray(noisePhoto(64, 3));
    expect(Math.abs(ssim(photo, photo) - 1)).toBeLessThan(1e-9);
    const flat = gray(24, 24, () => 77.3);
    expect(Math.abs(ssim(flat, flat) - 1)).toBeLessThan(1e-9);
    // A copy in a different buffer is still exactly identical.
    const copy = { ...photo, data: new Float32Array(photo.data) };
    expect(Math.abs(ssim(photo, copy) - 1)).toBeLessThan(1e-9);
  });

  it('small additive noise keeps SSIM > 0.9 but < 1', () => {
    const photo = toGray(noisePhoto(64, 1));
    const noisy = addNoise(photo, 2);
    const s = ssim(photo, noisy);
    expect(s).toBeGreaterThan(0.9);
    expect(s).toBeLessThan(1);
    const circle = toGray(aaCircle(64, 20).image);
    const s2 = ssim(circle, addNoise(circle, 2));
    expect(s2).toBeGreaterThan(0.9);
    expect(s2).toBeLessThan(1);
  });

  it('inverting the image gives SSIM < 0.2', () => {
    const circle = toGray(aaCircle(64, 20).image);
    expect(ssim(circle, invert(circle))).toBeLessThan(0.2);
    const photo = toGray(noisePhoto(64, 2));
    expect(ssim(photo, invert(photo))).toBeLessThan(0.2);
  });

  it('is symmetric', () => {
    const a = toGray(noisePhoto(48, 5));
    const b = addNoise(toGray(aaCircle(48, 14).image), 10, 3);
    expect(Math.abs(ssim(a, b) - ssim(b, a))).toBeLessThan(1e-12);
  });

  it('matches the closed form on a single 8x8 window (luminance-only case)', () => {
    const a = gray(8, 8, () => 100);
    const b = gray(8, 8, () => 110);
    const expected = (2 * 100 * 110 + C1) / (100 * 100 + 110 * 110 + C1);
    expect(ssim(a, b)).toBeCloseTo(expected, 10);
  });

  it('matches a reference implementation on a single window with variance', () => {
    // Left half 0 / right half 200; b = a / 2. mu 100/50, var 10000/2500, cov 5000.
    const a = gray(8, 8, (x) => (x < 4 ? 0 : 200));
    const b = gray(8, 8, (x) => (x < 4 ? 0 : 100));
    const expected =
      ((2 * 100 * 50 + C1) * (2 * 5000 + C2)) / ((100 * 100 + 50 * 50 + C1) * (10000 + 2500 + C2));
    expect(ssim(a, b)).toBeCloseTo(expected, 10);
    expect(ssim(a, b)).toBeCloseTo(ssimRef(Array.from(a.data), Array.from(b.data)), 10);
  });

  it('averages windows placed with stride 4 (12x8 -> windows at x = 0 and 4)', () => {
    const a = gray(12, 8, (x, y) => ((x * 7 + y * 13) % 23) * 10);
    const b = gray(12, 8, (x, y) => (x < 8 ? ((x * 7 + y * 13) % 23) * 10 : 30 + ((x * 5 + y) % 9) * 20));
    const win0 = ssimRef(
      Array.from({ length: 64 }, (_, i) => a.data[(i >> 3) * 12 + (i & 7)]),
      Array.from({ length: 64 }, (_, i) => b.data[(i >> 3) * 12 + (i & 7)]),
    );
    expect(Math.abs(win0 - 1)).toBeLessThan(1e-12);
    const win1 = ssimRef(
      Array.from({ length: 64 }, (_, i) => a.data[(i >> 3) * 12 + 4 + (i & 7)]),
      Array.from({ length: 64 }, (_, i) => b.data[(i >> 3) * 12 + 4 + (i & 7)]),
    );
    expect(win1).toBeLessThan(0.999);
    expect(ssim(a, b)).toBeCloseTo((win0 + win1) / 2, 10);
  });

  it('only counts windows fully inside the ROI', () => {
    const a = toGray(noisePhoto(32, 4));
    const b = { ...a, data: new Float32Array(a.data) };
    // Corrupt column 7 and the top-left 8x8 block: outside the ROI {8,8,32,32}.
    for (let y = 0; y < 32; y++) b.data[y * 32 + 7] = 255 - b.data[y * 32 + 7];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) b.data[y * 32 + x] = 0;
    expect(Math.abs(ssim(a, b, { x0: 8, y0: 8, x1: 32, y1: 32 }) - 1)).toBeLessThan(1e-9);
    expect(ssim(a, b)).toBeLessThan(0.999);
    // ROI outside the image or empty -> 1 (nothing to compare).
    expect(ssim(a, b, { x0: 40, y0: 40, x1: 50, y1: 50 })).toBe(1);
  });

  it('shrinks the window for ROIs (or images) smaller than 8 px', () => {
    const a = gray(4, 4, () => 100);
    const b = gray(4, 4, () => 110);
    const expected = (2 * 100 * 110 + C1) / (100 * 100 + 110 * 110 + C1);
    expect(ssim(a, b)).toBeCloseTo(expected, 10);
    expect(Math.abs(ssim(a, a) - 1)).toBeLessThan(1e-9);
    // 3 px wide ROI on a bigger image: still returns a finite, sane value.
    const big = toGray(noisePhoto(32, 9));
    const s = ssim(big, invert(big), { x0: 10, y0: 0, x1: 13, y1: 32 });
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeLessThan(0.5);
  });

  it('custom window size works (win = 4 on a 4x4 image equals one window)', () => {
    const a = gray(4, 4, (x, y) => x * 40 + y * 10);
    const b = gray(4, 4, (x, y) => 200 - x * 30 + y * 5);
    expect(ssim(a, b, undefined, 4)).toBeCloseTo(ssimRef(Array.from(a.data), Array.from(b.data)), 10);
  });

  it('throws on size mismatch and does not mutate inputs', () => {
    const a = gray(8, 8, () => 1);
    const b = gray(8, 9, () => 1);
    expect(() => ssim(a, b)).toThrow(/tamaños/);
    const c = toGray(noisePhoto(16, 1));
    const d = invert(c);
    const cBefore = Array.from(c.data);
    const dBefore = Array.from(d.data);
    ssim(c, d);
    expect(Array.from(c.data)).toEqual(cBefore);
    expect(Array.from(d.data)).toEqual(dBefore);
  });
});
