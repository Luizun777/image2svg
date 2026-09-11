/**
 * Basic RGBA raster helpers. Pure functions; never mutate inputs.
 */
import type { GrayImage, RasterImage, RGB } from '../types';

/** 5-bit quantised key: (r>>3)<<10 | (g>>3)<<5 | (b>>3). 32768 bins. */
const BINS = 32768;

export function createRaster(
  width: number,
  height: number,
  fill?: [number, number, number, number],
): RasterImage {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill) {
    const [r, g, b, a] = fill;
    // Only fill when it is not the zero default (saves a pass for transparent black).
    if ((r | g | b | a) !== 0) {
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      }
    }
  }
  return { data, width: w, height: h };
}

export function cloneRaster(img: RasterImage): RasterImage {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

/** Rec.601 luma 0.299R + 0.587G + 0.114B; alpha ignored. Values 0..255 (float, unrounded). */
export function toGray(img: RasterImage): GrayImage {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  }
  return { data: out, width: img.width, height: img.height };
}

/** Alpha channel as a gray image (0..255, as is; caller decides polarity). */
export function alphaToGray(img: RasterImage): GrayImage {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0, p = 3; i < n; i++, p += 4) out[i] = d[p];
  return { data: out, width: img.width, height: img.height };
}

/** out = src*a + bg*(1-a), alpha = 255. Rounded to nearest. Does not mutate. */
export function compositeOnColor(img: RasterImage, bg: RGB): RasterImage {
  const src = img.data;
  const out = new Uint8ClampedArray(src.length);
  const br = bg[0];
  const bgc = bg[1];
  const bb = bg[2];
  for (let p = 0; p < src.length; p += 4) {
    const a = src[p + 3];
    if (a === 255) {
      out[p] = src[p];
      out[p + 1] = src[p + 1];
      out[p + 2] = src[p + 2];
    } else if (a === 0) {
      out[p] = br;
      out[p + 1] = bgc;
      out[p + 2] = bb;
    } else {
      const ia = 255 - a;
      // Integer arithmetic, rounded half up. Max value 255*255 fits comfortably in int32.
      out[p] = ((src[p] * a + br * ia + 127) / 255) | 0;
      out[p + 1] = ((src[p + 1] * a + bgc * ia + 127) / 255) | 0;
      out[p + 2] = ((src[p + 2] * a + bb * ia + 127) / 255) | 0;
    }
    out[p + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

function quantKey(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

/**
 * Mode (5-bit quantised) of the 1-px border ring, counting only pixels with alpha >= 128.
 * Returns the real average colour of the winning bin when it holds >= 80 % of the counted
 * pixels, otherwise null (noisy border or no opaque border pixels).
 */
export function borderModeColor(img: RasterImage): RGB | null {
  const { width: w, height: h, data: d } = img;
  if (w <= 0 || h <= 0) return null;
  const counts = new Uint32Array(BINS);
  const sums = new Float64Array(BINS * 3);
  let total = 0;
  const visit = (p: number): void => {
    if (d[p + 3] < 128) return;
    const r = d[p];
    const g = d[p + 1];
    const b = d[p + 2];
    const k = quantKey(r, g, b);
    counts[k]++;
    sums[k * 3] += r;
    sums[k * 3 + 1] += g;
    sums[k * 3 + 2] += b;
    total++;
  };
  // Top and bottom rows.
  for (let x = 0; x < w; x++) visit(x * 4);
  if (h > 1) for (let x = 0; x < w; x++) visit(((h - 1) * w + x) * 4);
  // Left and right columns, excluding the corners already visited.
  for (let y = 1; y < h - 1; y++) {
    visit(y * w * 4);
    if (w > 1) visit((y * w + w - 1) * 4);
  }
  if (total === 0) return null;
  let best = -1;
  let bestCount = 0;
  for (let k = 0; k < BINS; k++) {
    const c = counts[k];
    if (c > bestCount) {
      bestCount = c;
      best = k;
    }
  }
  if (best < 0 || bestCount < 0.8 * total) return null;
  return [
    Math.round(sums[best * 3] / bestCount),
    Math.round(sums[best * 3 + 1] / bestCount),
    Math.round(sums[best * 3 + 2] / bestCount),
  ];
}

/** transparentRatio: alpha < 8; partialAlphaRatio: 8 <= alpha < 248. Both 0 for empty images. */
export function alphaStats(img: RasterImage): { transparentRatio: number; partialAlphaRatio: number } {
  const n = img.width * img.height;
  if (n === 0) return { transparentRatio: 0, partialAlphaRatio: 0 };
  const d = img.data;
  let transparent = 0;
  let partial = 0;
  for (let p = 3; p < d.length; p += 4) {
    const a = d[p];
    if (a < 8) transparent++;
    else if (a < 248) partial++;
  }
  return { transparentRatio: transparent / n, partialAlphaRatio: partial / n };
}

/**
 * Most frequent colour (5-bit bin, returned as the real average of its members) among pixels with
 * alpha >= 128 whose Euclidean RGB distance to `bg` is > 48. With bg = null every opaque pixel
 * counts. Falls back to black when no pixel qualifies.
 */
export function dominantInkColor(img: RasterImage, bg: RGB | null): RGB {
  const d = img.data;
  const counts = new Uint32Array(BINS);
  const sums = new Float64Array(BINS * 3);
  const hasBg = bg !== null;
  const br = hasBg ? bg[0] : 0;
  const bgc = hasBg ? bg[1] : 0;
  const bb = hasBg ? bg[2] : 0;
  const minDist2 = 48 * 48;
  let found = false;
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] < 128) continue;
    const r = d[p];
    const g = d[p + 1];
    const b = d[p + 2];
    if (hasBg) {
      const dr = r - br;
      const dg = g - bgc;
      const db = b - bb;
      if (dr * dr + dg * dg + db * db <= minDist2) continue;
    }
    const k = quantKey(r, g, b);
    counts[k]++;
    sums[k * 3] += r;
    sums[k * 3 + 1] += g;
    sums[k * 3 + 2] += b;
    found = true;
  }
  if (!found) return [0, 0, 0];
  let best = 0;
  let bestCount = 0;
  for (let k = 0; k < BINS; k++) {
    const c = counts[k];
    if (c > bestCount) {
      bestCount = c;
      best = k;
    }
  }
  return [
    Math.round(sums[best * 3] / bestCount),
    Math.round(sums[best * 3 + 1] / bestCount),
    Math.round(sums[best * 3 + 2] / bestCount),
  ];
}
