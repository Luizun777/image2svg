import { describe, expect, it } from 'vitest';
import type { GrayImage, RasterImage } from '../../src/types';
import { gaussianBlur, gaussianBlurRaster, gaussianKernel } from '../../src/core/blur';

function gray(width: number, height: number, f: (x: number, y: number) => number): GrayImage {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y);
  return { data, width, height };
}

describe('gaussianKernel', () => {
  it('has radius ceil(3σ), sums to 1 (+-1e-6) and is symmetric', () => {
    for (const s of [0.3, 0.5, 1, 1.4, 2.5, 4]) {
      const k = gaussianKernel(s);
      const r = Math.ceil(3 * s);
      expect(k.length).toBe(2 * r + 1);
      let sum = 0;
      for (let i = 0; i < k.length; i++) sum += k[i];
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
      for (let i = 0; i <= r; i++) expect(k[r + i]).toBeCloseTo(k[r - i], 12);
      // Centre tap is the largest and strictly decreasing outwards.
      for (let i = 1; i <= r; i++) expect(k[r + i]).toBeLessThan(k[r + i - 1]);
    }
  });

  it('matches exp(-x²/2σ²) ratios', () => {
    const k = gaussianKernel(1); // r = 3, centre index 3
    expect(k[3] / k[4]).toBeCloseTo(Math.exp(0.5), 10);
    expect(k[3] / k[1]).toBeCloseTo(Math.exp(2), 10);
  });
});

describe('gaussianBlur', () => {
  it('σ = 0 (and negative / NaN) returns an equal copy in a different buffer', () => {
    const img = gray(4, 3, (x, y) => x * 3 + y);
    for (const s of [0, -1, Number.NaN]) {
      const out = gaussianBlur(img, s);
      expect(out.data).not.toBe(img.data);
      expect(Array.from(out.data)).toEqual(Array.from(img.data));
      expect([out.width, out.height]).toEqual([4, 3]);
    }
  });

  it('impulse response sums to 255 (+-0.01), is symmetric and matches the kernel product', () => {
    const size = 21;
    const c = 10;
    const sigma = 1.5; // radius 5, fully interior
    const img = gray(size, size, (x, y) => (x === c && y === c ? 255 : 0));
    const out = gaussianBlur(img, sigma);
    let sum = 0;
    for (let i = 0; i < out.data.length; i++) sum += out.data[i];
    expect(Math.abs(sum - 255)).toBeLessThan(0.01);
    const k = gaussianKernel(sigma);
    const r = (k.length - 1) >> 1;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const v = out.data[(c + dy) * size + c + dx];
        expect(v).toBeCloseTo(255 * k[r + dx] * k[r + dy], 4);
        expect(v).toBeCloseTo(out.data[(c - dy) * size + c - dx], 5);
        expect(v).toBeCloseTo(out.data[(c + dx) * size + c + dy], 5);
      }
    }
    // Outside the support everything is exactly 0.
    expect(out.data[0]).toBe(0);
    expect(out.data[(c - r - 1) * size + c]).toBe(0);
    expect(out.data[c * size + c + r + 1]).toBe(0);
  });

  it('keeps a constant image constant', () => {
    for (const s of [0.35, 1, 3.7]) {
      const out = gaussianBlur(gray(9, 6, () => 200.5), s);
      for (let i = 0; i < out.data.length; i++) expect(Math.abs(out.data[i] - 200.5)).toBeLessThan(1e-4);
    }
  });

  it('preserves a linear ramp in the interior (symmetric kernel)', () => {
    const w = 40;
    const h = 30;
    const sigma = 2; // r = 6
    const out = gaussianBlur(gray(w, h, (x, y) => 2 * x + 3 * y + 7), sigma);
    for (let y = 6; y < h - 6; y++) {
      for (let x = 6; x < w - 6; x++) {
        expect(Math.abs(out.data[y * w + x] - (2 * x + 3 * y + 7))).toBeLessThan(1e-3);
      }
    }
  });

  it('replicates borders: a half-plane step keeps its extremes at the edges', () => {
    const w = 32;
    const out = gaussianBlur(gray(w, 3, (x) => (x < 16 ? 0 : 255)), 1.2); // r = 4
    for (let y = 0; y < 3; y++) {
      expect(out.data[y * w]).toBe(0);
      expect(out.data[y * w + w - 1]).toBeCloseTo(255, 4);
      // Monotonic across the edge.
      for (let x = 1; x < w; x++) expect(out.data[y * w + x]).toBeGreaterThanOrEqual(out.data[y * w + x - 1]);
      // Symmetric about the edge: v[15 - i] + v[16 + i] == 255.
      for (let i = 0; i < 8; i++) expect(out.data[y * w + 15 - i] + out.data[y * w + 16 + i]).toBeCloseTo(255, 4);
    }
  });

  it('σ larger than the image still works (radius > size) and stays in range', () => {
    const out = gaussianBlur(gray(4, 4, (x, y) => ((x + y) % 2) * 255), 10);
    for (let i = 0; i < out.data.length; i++) {
      expect(Number.isFinite(out.data[i])).toBe(true);
      expect(out.data[i]).toBeGreaterThanOrEqual(0);
      expect(out.data[i]).toBeLessThanOrEqual(255);
    }
    // Heavy blur of a checkerboard -> close to the mean 127.5 everywhere (within 20).
    for (let i = 0; i < out.data.length; i++) expect(Math.abs(out.data[i] - 127.5)).toBeLessThan(20);
  });

  it('does not mutate the input', () => {
    const img = gray(5, 5, (x, y) => x * y);
    const before = Array.from(img.data);
    gaussianBlur(img, 1);
    expect(Array.from(img.data)).toEqual(before);
  });
});

describe('gaussianBlurRaster', () => {
  function raster(width: number, height: number, f: (x: number, y: number) => [number, number, number, number]): RasterImage {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const px = f(x, y);
        data.set(px, (y * width + x) * 4);
      }
    }
    return { data, width, height };
  }

  it('constant image stays exactly constant, alpha included', () => {
    const out = gaussianBlurRaster(raster(7, 5, () => [10, 20, 30, 40]), 1.3);
    for (let p = 0; p < out.data.length; p += 4) {
      expect(Array.from(out.data.subarray(p, p + 4))).toEqual([10, 20, 30, 40]);
    }
  });

  it('each channel matches the gray blur within rounding', () => {
    const w = 20;
    const h = 6;
    const src = raster(w, h, (x, y) => [x * 12, 255 - x * 12, (x * y * 7) % 256, x < 10 ? 0 : 255]);
    const out = gaussianBlurRaster(src, 1);
    for (let ch = 0; ch < 4; ch++) {
      const g = gaussianBlur(gray(w, h, (x, y) => src.data[(y * w + x) * 4 + ch]), 1);
      for (let i = 0; i < w * h; i++) expect(Math.abs(out.data[i * 4 + ch] - g.data[i])).toBeLessThanOrEqual(0.5 + 1e-6);
    }
  });

  it('σ = 0 copies', () => {
    const src = raster(2, 2, (x, y) => [x, y, 5, 6]);
    const out = gaussianBlurRaster(src, 0);
    expect(out.data).not.toBe(src.data);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
});

/** Pre-refactor blur core, verbatim (Float32 w x h x ch intermediate): the numeric reference. */
function referenceBlurCore(src: ArrayLike<number>, w: number, h: number, ch: number, sigma: number, out: Float32Array | Uint8ClampedArray): void {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  const row = w * ch;
  const tmp = new Float32Array(row * h);
  const pad = new Float64Array((w + 2 * r) * ch);
  for (let y = 0; y < h; y++) {
    const base = y * row;
    for (let i = 0; i < r; i++) {
      for (let c = 0; c < ch; c++) {
        pad[i * ch + c] = src[base + c];
        pad[(w + r + i) * ch + c] = src[base + (w - 1) * ch + c];
      }
    }
    for (let i = 0; i < row; i++) pad[r * ch + i] = src[base + i];
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let s = 0;
        let p = x * ch + c;
        for (let i = 0; i < k.length; i++, p += ch) s += k[i] * pad[p];
        tmp[base + x * ch + c] = s;
      }
    }
  }
  const acc = new Float64Array(row);
  const last = h - 1;
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    for (let i = 0; i < k.length; i++) {
      let sy = y - r + i;
      if (sy < 0) sy = 0;
      else if (sy > last) sy = last;
      const kv = k[i];
      const sBase = sy * row;
      for (let x = 0; x < row; x++) acc[x] += kv * tmp[sBase + x];
    }
    out.set(acc, y * row);
  }
}

/** Byte lengths of every Float32Array / Float64Array constructed while `fn` runs. */
function floatAllocations(fn: () => void): number[] {
  const g = globalThis as unknown as { Float32Array: Float32ArrayConstructor; Float64Array: Float64ArrayConstructor };
  const F32 = g.Float32Array;
  const F64 = g.Float64Array;
  const sizes: number[] = [];
  const spy = <T extends object>(ctor: T): T =>
    new Proxy(ctor, {
      construct(target, args, newTarget) {
        const o = Reflect.construct(target as unknown as new (...a: unknown[]) => ArrayBufferView, args, newTarget);
        sizes.push(o.byteLength);
        return o;
      },
    });
  g.Float32Array = spy(F32);
  g.Float64Array = spy(F64);
  try {
    fn();
  } finally {
    g.Float32Array = F32;
    g.Float64Array = F64;
  }
  return sizes;
}

describe('blur memory: ring of row buffers instead of an image-sized intermediate', () => {
  function rasterOf(width: number, height: number, f: (i: number) => number): RasterImage {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i++) data[i] = f(i);
    return { data, width, height };
  }

  it('is numerically identical to the pre-refactor core on a random 64x64 image (gray <= 1e-6, RGBA exact)', () => {
    let seed = 3;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (const sigma of [0.35, 1, 1.4, 4, 25]) {
      const g = gray(64, 64, () => rnd() * 255);
      const ref = new Float32Array(64 * 64);
      referenceBlurCore(g.data, 64, 64, 1, sigma, ref);
      const out = gaussianBlur(g, sigma);
      let maxDiff = 0;
      for (let i = 0; i < ref.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ref[i] - out.data[i]));
      expect(maxDiff, `sigma ${sigma}`).toBeLessThanOrEqual(1e-6);
      const img = rasterOf(64, 64, () => Math.floor(rnd() * 256));
      const refR = new Uint8ClampedArray(64 * 64 * 4);
      referenceBlurCore(img.data, 64, 64, 4, sigma, refR);
      expect(Array.from(gaussianBlurRaster(img, sigma).data), `sigma ${sigma}`).toEqual(Array.from(refR));
    }
    // Non-square, taller than the kernel ring.
    const tall = gray(7, 90, (x, y) => (x * 37 + y * 11) % 256);
    const refT = new Float32Array(7 * 90);
    referenceBlurCore(tall.data, 7, 90, 1, 2.2, refT);
    const outT = gaussianBlur(tall, 2.2);
    for (let i = 0; i < refT.length; i++) expect(Math.abs(refT[i] - outT.data[i])).toBeLessThanOrEqual(1e-6);
  });

  it('float allocations are O(radius x width), not O(width x height)', () => {
    const w = 40;
    const h = 300;
    const sigma = 1.4;
    const img = rasterOf(w, h, (i) => (i * 7) & 255);
    const sizes = floatAllocations(() => gaussianBlurRaster(img, sigma));
    const r = Math.ceil(3 * sigma);
    const total = sizes.reduce((a, b) => a + b, 0);
    // Before: a 40 x 300 x 4 float32 intermediate (192 kB). Allowed: 2r+1 ring rows + 4 row buffers.
    expect(total).toBeLessThanOrEqual((2 * r + 1 + 4) * w * 4 * 8);
  });

  it('4000x4000 RGBA: arrayBuffers grow by <= 130 MB beyond the 64 MB output', () => {
    const w = 4000;
    const h = 4000;
    const img = rasterOf(w, h, (i) => Math.imul(i, 2654435761) >>> 24);
    const before = process.memoryUsage().arrayBuffers;
    const out = gaussianBlurRaster(img, 1);
    const growth = process.memoryUsage().arrayBuffers - before - out.data.byteLength;
    // Before the refactor: a 256 MB Float32 intermediate (measured +298 MB with the output).
    expect(growth).toBeLessThanOrEqual(130e6);
  }, 60000);
});
