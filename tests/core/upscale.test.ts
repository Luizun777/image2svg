import { describe, expect, it } from 'vitest';
import type { GrayImage, RasterImage } from '../../src/types';
import {
  MAX_UPSCALED_AREA,
  chooseUpscale,
  downscaleBox,
  downscaleBoxRaster,
  upscaleGray,
  upscaleRaster,
} from '../../src/core/upscale';

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
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = a;
    }
  }
  return { data, width, height };
}

describe('chooseUpscale', () => {
  it('auto picks 4 / 2 / largest-fitting by min dimension', () => {
    expect(chooseUpscale(500, 500, 'auto')).toEqual({ U: 4, capped: false });
    // 512 x 2000 x 16 = 16.4 Mpx > cap -> reduced to 3 (3.1 Mpx * 9 = 9.2 Mpx), flagged.
    expect(chooseUpscale(512, 2000, 'auto')).toEqual({ U: 3, capped: true });
    expect(chooseUpscale(512, 1500, 'auto')).toEqual({ U: 4, capped: false });
    expect(chooseUpscale(800, 800, 'auto')).toEqual({ U: 2, capped: false });
    expect(chooseUpscale(1024, 1024, 'auto')).toEqual({ U: 2, capped: false });
    expect(chooseUpscale(3000, 3000, 'auto')).toEqual({ U: 1, capped: false });
    // 1500^2 = 2.25 Mpx -> U^2 <= 7.1 -> U = 2
    expect(chooseUpscale(1500, 1500, 'auto')).toEqual({ U: 2, capped: false });
    // 2000^2 = 4 Mpx -> U^2 <= 4 -> U = 2 ; 2001^2 -> U = 1
    expect(chooseUpscale(2000, 2000, 'auto')).toEqual({ U: 2, capped: false });
    expect(chooseUpscale(2001, 2001, 'auto')).toEqual({ U: 1, capped: false });
  });

  it('caps an explicit U to the largest factor within 16 Mpx', () => {
    const r = chooseUpscale(2500, 2500, 4);
    expect(r.capped).toBe(true);
    expect(r.U).toBe(1);
    expect(2500 * r.U * 2500 * r.U).toBeLessThanOrEqual(MAX_UPSCALED_AREA);
    // 1000*4 * 1000*4 = 16e6 exactly -> allowed.
    expect(chooseUpscale(1000, 1000, 4)).toEqual({ U: 4, capped: false });
    expect(chooseUpscale(1000, 1000, 3)).toEqual({ U: 3, capped: false });
    expect(chooseUpscale(1001, 1001, 4)).toEqual({ U: 3, capped: true });
  });

  it('explicit U within budget is honoured, including U = 1', () => {
    expect(chooseUpscale(100, 100, 2)).toEqual({ U: 2, capped: false });
    expect(chooseUpscale(100, 100, 1)).toEqual({ U: 1, capped: false });
    expect(chooseUpscale(100, 100, 4)).toEqual({ U: 4, capped: false });
  });

  it('auto caps when the small side is tiny but the area is huge', () => {
    // 400 x 20000 = 8 Mpx: auto candidate 4 (min <= 512) but 4x exceeds 16 Mpx -> U = 1, capped.
    expect(chooseUpscale(400, 20000, 'auto')).toEqual({ U: 1, capped: true });
  });

  it('never goes below 1 and tolerates degenerate sizes', () => {
    expect(chooseUpscale(5000, 5000, 1)).toEqual({ U: 1, capped: false });
    expect(chooseUpscale(0, 100, 'auto')).toEqual({ U: 1, capped: false });
  });
});

describe('upscaleGray', () => {
  it('U = 1 returns an equal copy in a new buffer', () => {
    const img = gray(3, 2, (x, y) => x * 10 + y);
    const out = upscaleGray(img, 1);
    expect(out.data).not.toBe(img.data);
    expect(Array.from(out.data)).toEqual(Array.from(img.data));
    expect([out.width, out.height]).toEqual([3, 2]);
  });

  it('keeps a constant image constant (+-1e-3)', () => {
    for (const c of [0, 37.25, 128, 255]) {
      const out = upscaleGray(gray(5, 7, () => c), 4);
      expect([out.width, out.height]).toEqual([20, 28]);
      for (let i = 0; i < out.data.length; i++) expect(Math.abs(out.data[i] - c)).toBeLessThan(1e-3);
    }
  });

  it('reproduces a linear ramp (interior exact, whole image error < 1 for unit slope)', () => {
    const U = 4;
    const src = gray(16, 12, (x, y) => 10 * x + 3 * y + 5);
    const out = upscaleGray(src, U);
    // Interior: all four taps in-bounds for both axes -> linear reproduction to fp precision.
    let maxInterior = 0;
    for (let y = 0; y < out.height; y++) {
      const sy = (y + 0.5) / U - 0.5;
      if (sy < 1 || sy >= src.height - 2) continue;
      for (let x = 0; x < out.width; x++) {
        const sx = (x + 0.5) / U - 0.5;
        if (sx < 1 || sx >= src.width - 2) continue;
        const expected = 10 * sx + 3 * sy + 5;
        maxInterior = Math.max(maxInterior, Math.abs(out.data[y * out.width + x] - expected));
      }
    }
    expect(maxInterior).toBeLessThan(1e-3);
    // Unit-slope ramp, whole image (edges are clamp-extended so they deviate a little).
    const src1 = gray(16, 1, (x) => 20 + x);
    const out1 = upscaleGray(src1, U);
    let maxAll = 0;
    for (let x = 0; x < out1.width; x++) {
      const sx = Math.min(15, Math.max(0, (x + 0.5) / U - 0.5));
      maxAll = Math.max(maxAll, Math.abs(out1.data[x] - (20 + sx)));
    }
    expect(maxAll).toBeLessThan(1);
  });

  it('a 2-px 0|255 step upscaled 4x is monotonic along x, in [0,255], symmetric', () => {
    const src = gray(2, 3, (x) => (x === 0 ? 0 : 255));
    const out = upscaleGray(src, 4);
    expect([out.width, out.height]).toEqual([8, 12]);
    for (let y = 0; y < out.height; y++) {
      const row = Array.from(out.data.subarray(y * 8, y * 8 + 8));
      for (let x = 0; x < 8; x++) {
        expect(row[x]).toBeGreaterThanOrEqual(0);
        expect(row[x]).toBeLessThanOrEqual(255);
        if (x > 0) expect(row[x]).toBeGreaterThanOrEqual(row[x - 1]);
      }
      expect(row[0]).toBe(0);
      expect(row[7]).toBe(255);
      // Catmull-Rom is symmetric: v[i] + v[7-i] == 255 (undershoot/overshoot clamp symmetrically).
      for (let x = 0; x < 4; x++) expect(row[x] + row[7 - x]).toBeCloseTo(255, 3);
      // Actual transition happens: not a hard step.
      expect(row[3]).toBeGreaterThan(20);
      expect(row[3]).toBeLessThan(128);
    }
  });

  it('a wide 0|255 step is monotonic and clamped; a 64|192 step has no overshoot at all', () => {
    const wide = upscaleGray(gray(8, 1, (x) => (x < 4 ? 0 : 255)), 4);
    for (let x = 1; x < wide.width; x++) expect(wide.data[x]).toBeGreaterThanOrEqual(wide.data[x - 1]);
    expect(wide.data[0]).toBe(0);
    expect(wide.data[wide.width - 1]).toBe(255);
    const mid = upscaleGray(gray(8, 1, (x) => (x < 4 ? 64 : 192)), 4);
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = 0; x < mid.width; x++) {
      lo = Math.min(lo, mid.data[x]);
      hi = Math.max(hi, mid.data[x]);
      if (x > 0) expect(mid.data[x]).toBeGreaterThanOrEqual(mid.data[x - 1]);
    }
    // Catmull-Rom alone rings ~7 % past the step; the 2x2-tap clamp removes it entirely.
    expect(lo).toBeGreaterThanOrEqual(64);
    expect(hi).toBeLessThanOrEqual(192);
    // Still a smooth transition, not a nearest-neighbour step.
    expect(Array.from(mid.data).filter((v) => v > 70 && v < 186).length).toBeGreaterThanOrEqual(2);
  });

  it('uses the (d + 0.5)/U - 0.5 centre mapping: 2x of a 1D ramp lands at quarter positions', () => {
    const out = upscaleGray(gray(8, 1, (x) => 100 + 8 * x), 2);
    // Interior dst pixel 7 -> src 3.25 -> 126 ; dst 8 -> src 3.75 -> 130.
    expect(out.data[7]).toBeCloseTo(126, 3);
    expect(out.data[8]).toBeCloseTo(130, 3);
  });

  it('does not mutate the input and handles empty images', () => {
    const img = gray(3, 3, (x, y) => x + y);
    const before = Array.from(img.data);
    upscaleGray(img, 3);
    expect(Array.from(img.data)).toEqual(before);
    const empty = upscaleGray({ data: new Float32Array(0), width: 0, height: 5 }, 2);
    expect([empty.width, empty.height, empty.data.length]).toEqual([0, 10, 0]);
  });
});

describe('upscaleRaster', () => {
  it('keeps a constant RGBA image exactly constant', () => {
    const out = upscaleRaster(raster(3, 3, () => [12, 200, 77, 130]), 4);
    expect([out.width, out.height]).toEqual([12, 12]);
    for (let p = 0; p < out.data.length; p += 4) {
      expect(Array.from(out.data.subarray(p, p + 4))).toEqual([12, 200, 77, 130]);
    }
  });

  it('filters every channel including alpha, matching the gray path', () => {
    const src = raster(6, 2, (x) => [x * 40, 255 - x * 40, 0, x < 3 ? 0 : 255]);
    const out = upscaleRaster(src, 2);
    const g = upscaleGray(gray(6, 2, (x) => x * 40), 2);
    const a = upscaleGray(gray(6, 2, (x) => (x < 3 ? 0 : 255)), 2);
    for (let i = 0; i < out.width * out.height; i++) {
      expect(Math.abs(out.data[i * 4] - g.data[i])).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.abs(out.data[i * 4 + 3] - a.data[i])).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(out.data[i * 4 + 2]).toBe(0);
    }
  });

  it('U = 1 copies', () => {
    const src = raster(2, 2, (x, y) => [x, y, 3, 4]);
    const out = upscaleRaster(src, 1);
    expect(out.data).not.toBe(src.data);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
});

/** Pre-refactor bicubic core (verbatim: Float32 dstW x srcH x ch intermediate) plus the 2x2-tap clamp. */
function referenceBicubic(src: ArrayLike<number>, srcW: number, srcH: number, ch: number, U: number, out: Float32Array | Uint8ClampedArray, clampFloat: boolean): void {
  const taps = (srcLen: number): { idx: Int32Array; wts: Float64Array } => {
    const dstLen = srcLen * U;
    const idx = new Int32Array(dstLen * 4);
    const wts = new Float64Array(dstLen * 4);
    for (let d = 0; d < dstLen; d++) {
      const s = (d + 0.5) / U - 0.5;
      const s0 = Math.floor(s);
      const t = s - s0;
      const t2 = t * t;
      const t3 = t2 * t;
      const w0 = -0.5 * t + t2 - 0.5 * t3;
      const w1 = 1 - 2.5 * t2 + 1.5 * t3;
      const w2 = 0.5 * t + 2 * t2 - 1.5 * t3;
      const w3 = -0.5 * t2 + 0.5 * t3;
      const sum = w0 + w1 + w2 + w3;
      wts[d * 4] = w0 / sum;
      wts[d * 4 + 1] = w1 / sum;
      wts[d * 4 + 2] = w2 / sum;
      wts[d * 4 + 3] = w3 / sum;
      for (let k = 0; k < 4; k++) idx[d * 4 + k] = Math.min(srcLen - 1, Math.max(0, s0 - 1 + k));
    }
    return { idx, wts };
  };
  const dstW = srcW * U;
  const dstH = srcH * U;
  const tx = taps(srcW);
  const ty = taps(srcH);
  const tmp = new Float32Array(dstW * srcH * ch);
  const srcRow = srcW * ch;
  const tmpRow = dstW * ch;
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < dstW; x++) {
      const q = x * 4;
      for (let c = 0; c < ch; c++) {
        tmp[y * tmpRow + x * ch + c] =
          tx.wts[q] * src[y * srcRow + tx.idx[q] * ch + c] +
          tx.wts[q + 1] * src[y * srcRow + tx.idx[q + 1] * ch + c] +
          tx.wts[q + 2] * src[y * srcRow + tx.idx[q + 2] * ch + c] +
          tx.wts[q + 3] * src[y * srcRow + tx.idx[q + 3] * ch + c];
      }
    }
  }
  const rowBuf = new Float32Array(tmpRow);
  for (let y = 0; y < dstH; y++) {
    const q = y * 4;
    for (let i = 0; i < tmpRow; i++) {
      rowBuf[i] =
        ty.wts[q] * tmp[ty.idx[q] * tmpRow + i] +
        ty.wts[q + 1] * tmp[ty.idx[q + 1] * tmpRow + i] +
        ty.wts[q + 2] * tmp[ty.idx[q + 2] * tmpRow + i] +
        ty.wts[q + 3] * tmp[ty.idx[q + 3] * tmpRow + i];
    }
    // Anti-ringing: clamp to the [min, max] of the 2x2 nearest source taps, per channel.
    const ya = ty.idx[q + 1] * srcRow;
    const yb = ty.idx[q + 2] * srcRow;
    for (let x = 0; x < dstW; x++) {
      const xa = tx.idx[x * 4 + 1] * ch;
      const xb = tx.idx[x * 4 + 2] * ch;
      for (let c = 0; c < ch; c++) {
        const a = src[ya + xa + c];
        const b = src[ya + xb + c];
        const d = src[yb + xa + c];
        const e = src[yb + xb + c];
        const lo = Math.min(a, b, d, e);
        const hi = Math.max(a, b, d, e);
        const v = rowBuf[x * ch + c];
        rowBuf[x * ch + c] = v < lo ? lo : v > hi ? hi : v;
      }
    }
    if (clampFloat) for (let i = 0; i < tmpRow; i++) rowBuf[i] = Math.min(255, Math.max(0, rowBuf[i]));
    out.set(rowBuf, y * tmpRow);
  }
}

/** Byte lengths of every Float32Array constructed while `fn` runs (the Float64 tap tables are O(dstW + dstH)). */
function float32Allocations(fn: () => void): number[] {
  const g = globalThis as unknown as { Float32Array: Float32ArrayConstructor };
  const F32 = g.Float32Array;
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
  try {
    fn();
  } finally {
    g.Float32Array = F32;
  }
  return sizes;
}

describe('upscale anti-ringing clamp', () => {
  it('2-D corner (x<4 && y<4 ? 64 : 192) upscaled 4x: zero overshoot and undershoot', () => {
    const out = upscaleGray(gray(8, 8, (x, y) => (x < 4 && y < 4 ? 64 : 192)), 4);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of out.data) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    // Without the clamp: 44.56 .. 202.06 (15 % of the range).
    expect(lo).toBeGreaterThanOrEqual(64);
    expect(hi).toBeLessThanOrEqual(192);
  });

  it('every output sample lies within [min, max] of its 2x2 nearest source taps (gray and every RGBA channel)', () => {
    let seed = 99;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) / 16777216;
    };
    const U = 3;
    const src = gray(9, 7, () => Math.round(rnd() * 255));
    const out = upscaleGray(src, U);
    const rgba = raster(9, 7, () => [Math.round(rnd() * 255), Math.round(rnd() * 255), Math.round(rnd() * 255), Math.round(rnd() * 255)]);
    const outR = upscaleRaster(rgba, U);
    const near = (d: number, len: number): [number, number] => {
      const s0 = Math.floor((d + 0.5) / U - 0.5);
      return [Math.min(len - 1, Math.max(0, s0)), Math.min(len - 1, Math.max(0, s0 + 1))];
    };
    for (let y = 0; y < out.height; y++) {
      const [ya, yb] = near(y, 7);
      for (let x = 0; x < out.width; x++) {
        const [xa, xb] = near(x, 9);
        const taps = [src.data[ya * 9 + xa], src.data[ya * 9 + xb], src.data[yb * 9 + xa], src.data[yb * 9 + xb]];
        const v = out.data[y * out.width + x];
        expect(v).toBeGreaterThanOrEqual(Math.min(...taps));
        expect(v).toBeLessThanOrEqual(Math.max(...taps));
        for (let c = 0; c < 4; c++) {
          const t = [rgba.data[(ya * 9 + xa) * 4 + c], rgba.data[(ya * 9 + xb) * 4 + c], rgba.data[(yb * 9 + xa) * 4 + c], rgba.data[(yb * 9 + xb) * 4 + c]];
          const vr = outR.data[(y * outR.width + x) * 4 + c];
          expect(vr).toBeGreaterThanOrEqual(Math.min(...t));
          expect(vr).toBeLessThanOrEqual(Math.max(...t));
        }
      }
    }
  });
});

describe('upscale memory: row buffers instead of an image-sized intermediate', () => {
  it('matches the pre-refactor core (plus clamp): gray within 1e-6, RGBA byte-identical', () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (const U of [2, 3, 4]) {
      const src = gray(64, 64, () => rnd() * 255);
      const ref = new Float32Array(64 * U * 64 * U);
      referenceBicubic(src.data, 64, 64, 1, U, ref, true);
      const out = upscaleGray(src, U);
      let maxDiff = 0;
      for (let i = 0; i < ref.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ref[i] - out.data[i]));
      expect(maxDiff).toBeLessThanOrEqual(1e-6);
      const rgba = raster(64, 64, () => [rnd() * 256, rnd() * 256, rnd() * 256, rnd() * 256]);
      const refR = new Uint8ClampedArray(64 * U * 64 * U * 4);
      referenceBicubic(rgba.data, 64, 64, 4, U, refR, false);
      expect(Array.from(upscaleRaster(rgba, U).data)).toEqual(Array.from(refR));
    }
  });

  it('float allocations stay a few rows wide (no dstW x srcH x ch intermediate)', () => {
    const w = 64;
    const h = 64;
    const U = 4;
    const img = raster(w, h, (x, y) => [x * 4, y * 4, (x * y) & 255, 255]);
    const sizes = float32Allocations(() => upscaleRaster(img, U));
    const total = sizes.reduce((a, b) => a + b, 0);
    // Before: 256 x 64 x 4 x 4 B = 262 kB. Allowed: 8 destination rows of 4 float32 channels.
    expect(total).toBeLessThanOrEqual(8 * w * U * 4 * 4);
  });
});

describe('downscaleBox', () => {
  it('returns the constant after upscaling a constant', () => {
    const img = gray(5, 3, () => 91.5);
    const out = downscaleBox(upscaleGray(img, 4), 4);
    expect([out.width, out.height]).toEqual([5, 3]);
    for (let i = 0; i < out.data.length; i++) expect(Math.abs(out.data[i] - 91.5)).toBeLessThan(1e-3);
  });

  it('averages exact blocks', () => {
    // 4x2 -> factor 2 -> 2x1: blocks {1,2,5,6} -> 3.5 ; {3,4,7,8} -> 5.5
    const img = gray(4, 2, (x, y) => y * 4 + x + 1);
    const out = downscaleBox(img, 2);
    expect([out.width, out.height]).toEqual([2, 1]);
    expect(Array.from(out.data)).toEqual([3.5, 5.5]);
  });

  it('ceil-sizes and averages partial edge blocks', () => {
    // 3x3 with factor 2 -> 2x2. Bottom-right block is the single pixel (2,2).
    const img = gray(3, 3, (x, y) => y * 3 + x);
    const out = downscaleBox(img, 2);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(out.data[0]).toBeCloseTo((0 + 1 + 3 + 4) / 4, 6);
    expect(out.data[1]).toBeCloseTo((2 + 5) / 2, 6);
    expect(out.data[2]).toBeCloseTo((6 + 7) / 2, 6);
    expect(out.data[3]).toBeCloseTo(8, 6);
  });

  it('factor 1 is a copy', () => {
    const img = gray(2, 2, (x) => x);
    const out = downscaleBox(img, 1);
    expect(out.data).not.toBe(img.data);
    expect(Array.from(out.data)).toEqual(Array.from(img.data));
  });

  it('round-trips a nearest-upscaled image exactly (up to rounding)', () => {
    const img = gray(4, 4, (x, y) => (x * 7 + y * 13) % 256);
    const big = gray(8, 8, (x, y) => img.data[(y >> 1) * 4 + (x >> 1)]);
    const out = downscaleBox(big, 2);
    expect(Array.from(out.data)).toEqual(Array.from(img.data));
  });
});

describe('downscaleBoxRaster', () => {
  it('averages every channel and rounds', () => {
    const src = raster(2, 2, (x, y) => [x * 255, y * 255, 10, (x + y) * 100]);
    const out = downscaleBoxRaster(src, 2);
    expect([out.width, out.height]).toEqual([1, 1]);
    // r: (0+255+0+255)/4 = 127.5 -> 128 (round half to even on Uint8ClampedArray gives 128)
    expect(Math.abs(out.data[0] - 127.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(out.data[1] - 127.5)).toBeLessThanOrEqual(0.5);
    expect(out.data[2]).toBe(10);
    expect(out.data[3]).toBe(100); // (0+100+100+200)/4
  });

  it('inverts a constant upscale', () => {
    const src = raster(3, 2, () => [1, 2, 3, 4]);
    const out = downscaleBoxRaster(upscaleRaster(src, 3), 3);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
});
