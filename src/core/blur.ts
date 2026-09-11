/**
 * Exact separable Gaussian blur, radius ceil(3σ), replicated borders. Pure; never mutates.
 */
import type { GrayImage, RasterImage } from '../types';

/** Normalised 1-D Gaussian kernel of radius ceil(3σ) (length 2r+1, sum 1 ± 1e-12). */
export function gaussianKernel(sigmaPx: number): Float64Array {
  const r = Math.ceil(3 * sigmaPx);
  const k = new Float64Array(2 * r + 1);
  const inv2s2 = 1 / (2 * sigmaPx * sigmaPx);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-i * i * inv2s2);
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/**
 * Blur core over `ch` interleaved channels: horizontal pass through a replicated-padded row
 * buffer, vertical pass accumulating each output row in Float64 and storing it into `out`
 * (Float32Array copies, Uint8ClampedArray clamps + rounds).
 *
 * Memory: horizontally blurred rows live in a ring of min(2r+1, h) Float32 rows instead of a
 * w x h x ch intermediate (256 MB for RGBA at 16 Mpx). The vertical taps of output row y are the
 * clamped source rows y-r..y+r — at most min(2r+1, h) consecutive rows — so source row s sits in
 * slot s % ringRows exactly while it is needed and is computed once. Same expressions in the
 * same order as the full intermediate: the output is numerically identical.
 */
function blurCore(
  src: ArrayLike<number>,
  w: number,
  h: number,
  ch: number,
  sigma: number,
  out: Float32Array | Uint8ClampedArray,
): void {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  const row = w * ch;
  const pad = new Float64Array((w + 2 * r) * ch);
  const ringRows = Math.min(k.length, h);
  const ring = new Float32Array(ringRows * row);
  const slotRow = new Int32Array(ringRows).fill(-1);

  /** Horizontal pass of source row sy into its ring slot (edge samples replicated); returns the slot offset. */
  const horizontal = (sy: number): number => {
    const slot = sy % ringRows;
    const tBase = slot * row;
    if (slotRow[slot] === sy) return tBase;
    slotRow[slot] = sy;
    const base = sy * row;
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
        let p = x * ch + c; // pad index of tap 0 (== src x - r)
        for (let i = 0; i < k.length; i++, p += ch) s += k[i] * pad[p];
        ring[tBase + x * ch + c] = s;
      }
    }
    return tBase;
  };

  // Vertical pass: accumulate whole rows (cache friendly), clamped source rows replicate edges.
  const acc = new Float64Array(row);
  const last = h - 1;
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    for (let i = 0; i < k.length; i++) {
      let sy = y - r + i;
      if (sy < 0) sy = 0;
      else if (sy > last) sy = last;
      const kv = k[i];
      const sBase = horizontal(sy);
      for (let x = 0; x < row; x++) acc[x] += kv * ring[sBase + x];
    }
    out.set(acc, y * row);
  }
}

/** σ <= 0 (or non-finite) -> equal copy in a new buffer. */
export function gaussianBlur(img: GrayImage, sigmaPx: number): GrayImage {
  const { width: w, height: h } = img;
  if (!(sigmaPx > 0) || w === 0 || h === 0) {
    return { data: new Float32Array(img.data), width: w, height: h };
  }
  const out = new Float32Array(w * h);
  blurCore(img.data, w, h, 1, sigmaPx, out);
  return { data: out, width: w, height: h };
}

/** Per-channel blur, alpha included (not premultiplied). */
export function gaussianBlurRaster(img: RasterImage, sigmaPx: number): RasterImage {
  const { width: w, height: h } = img;
  if (!(sigmaPx > 0) || w === 0 || h === 0) {
    return { data: new Uint8ClampedArray(img.data), width: w, height: h };
  }
  const out = new Uint8ClampedArray(w * h * 4);
  blurCore(img.data, w, h, 4, sigmaPx, out);
  return { data: out, width: w, height: h };
}
