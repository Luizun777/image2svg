/**
 * Integer upscaling with a separable Catmull-Rom bicubic filter (a = -0.5) and box downscaling.
 * Pure functions; never mutate inputs.
 */
import type { GrayImage, RasterImage, UpscaleSetting } from '../types';

/** Maximum area (in pixels) of the upscaled working image. */
export const MAX_UPSCALED_AREA = 16e6;

/**
 * auto: 4 if min(w,h) <= 512; 2 if <= 1024; otherwise the largest U >= 1 with w*U*h*U <= 16 Mpx.
 * Any candidate (auto or explicit) is reduced while it exceeds 16 Mpx; `capped` is true when
 * that reduction happened. U never goes below 1.
 */
export function chooseUpscale(
  width: number,
  height: number,
  requested: UpscaleSetting,
): { U: number; capped: boolean } {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const area = w * h;
  if (area === 0) return { U: 1, capped: false };
  const largestFitting = Math.max(1, Math.floor(Math.sqrt(MAX_UPSCALED_AREA / area)));
  let candidate: number;
  if (requested === 'auto') {
    const m = Math.min(w, h);
    if (m <= 512) candidate = 4;
    else if (m <= 1024) candidate = 2;
    else candidate = largestFitting;
  } else {
    candidate = Math.max(1, Math.floor(requested));
  }
  const U = Math.min(candidate, largestFitting);
  return { U, capped: U < candidate };
}

/** Catmull-Rom (a = -0.5) tap weights for fractional offset t in [0,1), taps at -1,0,1,2. */
function catmullRomWeights(t: number, out: Float64Array, o: number): void {
  const t2 = t * t;
  const t3 = t2 * t;
  const w0 = -0.5 * t + t2 - 0.5 * t3;
  const w1 = 1 - 2.5 * t2 + 1.5 * t3;
  const w2 = 0.5 * t + 2 * t2 - 1.5 * t3;
  const w3 = -0.5 * t2 + 0.5 * t3;
  // Analytically the sum is 1; renormalise to kill rounding so constants stay exactly constant.
  const s = w0 + w1 + w2 + w3;
  out[o] = w0 / s;
  out[o + 1] = w1 / s;
  out[o + 2] = w2 / s;
  out[o + 3] = w3 / s;
}

/**
 * Per-destination-index sampling tables: 4 clamped source indices and 4 weights each.
 * Destination pixel centre maps to srcX = (dstX + 0.5) / U - 0.5 (clamp-to-edge sampling).
 */
function buildTaps(srcLen: number, U: number): { idx: Int32Array; wts: Float64Array } {
  const dstLen = srcLen * U;
  const idx = new Int32Array(dstLen * 4);
  const wts = new Float64Array(dstLen * 4);
  const last = srcLen - 1;
  for (let d = 0; d < dstLen; d++) {
    const s = (d + 0.5) / U - 0.5;
    const s0 = Math.floor(s);
    const t = s - s0;
    catmullRomWeights(t, wts, d * 4);
    for (let k = 0; k < 4; k++) {
      let i = s0 - 1 + k;
      if (i < 0) i = 0;
      else if (i > last) i = last;
      idx[d * 4 + k] = i;
    }
  }
  return { idx, wts };
}

/**
 * Separable bicubic resampling core. `src` holds `ch` interleaved channels, row-major.
 *
 * Memory: the horizontal pass is kept for 4 source rows only. The vertical taps of an output row
 * are 4 consecutive (clamped) source rows and they advance monotonically, so source row s lives
 * in ring slot s % 4 exactly while it is needed and is computed once (the previous version kept
 * a dstW x srcH x ch Float32 intermediate: 128 MB for RGBA at 16 Mpx). The arithmetic is the
 * same expression in the same order, so the result is unchanged.
 *
 * Anti-ringing: every output sample is clamped, per channel, to the [min, max] of its 2x2
 * nearest source taps. Catmull-Rom alone overshoots a 2-D corner by up to 15 % of the local
 * range; the clamp removes all overshoot while linear ramps and constants are untouched (they
 * already lie between those taps).
 *
 * Each output row is handed to `out` via set() (so `out` can be a Float32Array — then
 * `clampFloat` clamps to [0, 255] — or a Uint8ClampedArray, which clamps and rounds itself).
 */
function bicubicCore(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  ch: number,
  U: number,
  out: Float32Array | Uint8ClampedArray,
  clampFloat: boolean,
): void {
  const dstW = srcW * U;
  const dstH = srcH * U;
  const tx = buildTaps(srcW, U);
  const ty = buildTaps(srcH, U);
  const srcRow = srcW * ch;
  const tmpRow = dstW * ch;
  const ring = new Float32Array(4 * tmpRow);
  const slotRow = new Int32Array(4).fill(-1);

  /** Horizontal pass of source row sy into its ring slot; returns the slot's offset. */
  const horizontal = (sy: number): number => {
    const slot = sy & 3;
    const tBase = slot * tmpRow;
    if (slotRow[slot] === sy) return tBase;
    slotRow[slot] = sy;
    const sBase = sy * srcRow;
    for (let x = 0; x < dstW; x++) {
      const q = x * 4;
      const i0 = sBase + tx.idx[q] * ch;
      const i1 = sBase + tx.idx[q + 1] * ch;
      const i2 = sBase + tx.idx[q + 2] * ch;
      const i3 = sBase + tx.idx[q + 3] * ch;
      const w0 = tx.wts[q];
      const w1 = tx.wts[q + 1];
      const w2 = tx.wts[q + 2];
      const w3 = tx.wts[q + 3];
      const o = tBase + x * ch;
      for (let c = 0; c < ch; c++) {
        ring[o + c] = w0 * src[i0 + c] + w1 * src[i1 + c] + w2 * src[i2 + c] + w3 * src[i3 + c];
      }
    }
    return tBase;
  };

  const rowBuf = new Float32Array(tmpRow);
  for (let y = 0; y < dstH; y++) {
    const q = y * 4;
    const r0 = horizontal(ty.idx[q]);
    const r1 = horizontal(ty.idx[q + 1]);
    const r2 = horizontal(ty.idx[q + 2]);
    const r3 = horizontal(ty.idx[q + 3]);
    const w0 = ty.wts[q];
    const w1 = ty.wts[q + 1];
    const w2 = ty.wts[q + 2];
    const w3 = ty.wts[q + 3];
    for (let i = 0; i < tmpRow; i++) {
      rowBuf[i] = w0 * ring[r0 + i] + w1 * ring[r1 + i] + w2 * ring[r2 + i] + w3 * ring[r3 + i];
    }
    // Anti-ringing clamp to the 2x2 nearest source taps (taps 1 and 2 of each axis).
    const ya = ty.idx[q + 1] * srcRow;
    const yb = ty.idx[q + 2] * srcRow;
    for (let x = 0; x < dstW; x++) {
      const xa = tx.idx[x * 4 + 1] * ch;
      const xb = tx.idx[x * 4 + 2] * ch;
      const o = x * ch;
      for (let c = 0; c < ch; c++) {
        const a = src[ya + xa + c];
        const b = src[ya + xb + c];
        const e = src[yb + xa + c];
        const f = src[yb + xb + c];
        let lo = a;
        let hi = a;
        if (b < lo) lo = b;
        else if (b > hi) hi = b;
        if (e < lo) lo = e;
        else if (e > hi) hi = e;
        if (f < lo) lo = f;
        else if (f > hi) hi = f;
        const v = rowBuf[o + c];
        if (v < lo) rowBuf[o + c] = lo;
        else if (v > hi) rowBuf[o + c] = hi;
      }
    }
    if (clampFloat) {
      for (let i = 0; i < tmpRow; i++) {
        const v = rowBuf[i];
        rowBuf[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    // Uint8ClampedArray.set() clamps and rounds; Float32Array.set() copies.
    out.set(rowBuf, y * tmpRow);
  }
}

function normalizeFactor(U: number): number {
  if (!Number.isFinite(U)) return 1;
  return Math.max(1, Math.floor(U));
}

/** U = 1 -> copy. Catmull-Rom bicubic, clamp-to-edge, 2x2-tap anti-ringing clamp; final clamp to [0,255]. */
export function upscaleGray(img: GrayImage, U: number): GrayImage {
  const u = normalizeFactor(U);
  if (u === 1) return { data: new Float32Array(img.data), width: img.width, height: img.height };
  const w = img.width * u;
  const h = img.height * u;
  const out = new Float32Array(w * h);
  if (img.width > 0 && img.height > 0) bicubicCore(img.data, img.width, img.height, 1, u, out, true);
  return { data: out, width: w, height: h };
}

/** Same filter per channel, alpha included; output rounded and clamped by Uint8ClampedArray. */
export function upscaleRaster(img: RasterImage, U: number): RasterImage {
  const u = normalizeFactor(U);
  if (u === 1) return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  const w = img.width * u;
  const h = img.height * u;
  const out = new Uint8ClampedArray(w * h * 4);
  if (img.width > 0 && img.height > 0) bicubicCore(img.data, img.width, img.height, 4, u, out, false);
  return { data: out, width: w, height: h };
}

/**
 * Box downscale core: averages factor x factor blocks. Output dims are ceil(w/f) x ceil(h/f);
 * partial blocks at the right/bottom edge average only the pixels that exist.
 */
function boxCore(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  ch: number,
  f: number,
  out: Float32Array | Uint8ClampedArray,
): void {
  const dstW = Math.ceil(srcW / f);
  const dstH = Math.ceil(srcH / f);
  const acc = new Float64Array(dstW * ch);
  const srcRow = srcW * ch;
  for (let by = 0; by < dstH; by++) {
    acc.fill(0);
    const y0 = by * f;
    const y1 = Math.min(srcH, y0 + f);
    for (let y = y0; y < y1; y++) {
      const base = y * srcRow;
      for (let x = 0; x < srcW; x++) {
        const bx = (x / f) | 0;
        const s = base + x * ch;
        const o = bx * ch;
        for (let c = 0; c < ch; c++) acc[o + c] += src[s + c];
      }
    }
    const rows = y1 - y0;
    const oBase = by * dstW * ch;
    for (let bx = 0; bx < dstW; bx++) {
      const cols = Math.min(srcW, bx * f + f) - bx * f;
      const inv = 1 / (rows * cols);
      for (let c = 0; c < ch; c++) out[oBase + bx * ch + c] = acc[bx * ch + c] * inv;
    }
  }
}

/** Average of factor x factor blocks (see boxCore). factor <= 1 -> copy. */
export function downscaleBox(img: GrayImage, factor: number): GrayImage {
  const f = normalizeFactor(factor);
  if (f === 1) return { data: new Float32Array(img.data), width: img.width, height: img.height };
  const w = Math.ceil(img.width / f);
  const h = Math.ceil(img.height / f);
  const out = new Float32Array(w * h);
  if (w > 0 && h > 0) boxCore(img.data, img.width, img.height, 1, f, out);
  return { data: out, width: w, height: h };
}

export function downscaleBoxRaster(img: RasterImage, factor: number): RasterImage {
  const f = normalizeFactor(factor);
  if (f === 1) return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  const w = Math.ceil(img.width / f);
  const h = Math.ceil(img.height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  if (w > 0 && h > 0) boxCore(img.data, img.width, img.height, 4, f, out);
  return { data: out, width: w, height: h };
}
