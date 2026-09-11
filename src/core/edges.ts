/**
 * Edge statistics used by the classifier. Pure; never mutates inputs.
 */
import type { BinaryMask, GrayImage, RasterImage } from '../types';
import { countInk, erode1 } from './morphology';

/**
 * Sobel gradient magnitude with replicated borders. Each component is divided by 4 so that a
 * clean 0 -> 255 step yields exactly 255 (magnitude range 0..~361 for diagonal edges).
 */
export function sobelMagnitude(img: GrayImage): GrayImage {
  const { width: w, height: h, data: d } = img;
  const out = new Float32Array(w * h);
  if (w === 0 || h === 0) return { data: out, width: w, height: h };
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w;
    const y0 = y * w;
    const yp = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      const tl = d[ym + xm];
      const tc = d[ym + x];
      const tr = d[ym + xp];
      const ml = d[y0 + xm];
      const mr = d[y0 + xp];
      const bl = d[yp + xm];
      const bc = d[yp + x];
      const br = d[yp + xp];
      const gx = (tr + 2 * mr + br - tl - 2 * ml - bl) * 0.25;
      const gy = (bl + 2 * bc + br - tl - 2 * tc - tr) * 0.25;
      out[y0 + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return { data: out, width: w, height: h };
}

/** Sobel magnitude (normalised as in sobelMagnitude) above which a pixel is an edge pixel. */
export const EDGE_MAGNITUDE = 64;

/**
 * Tolerance (levels) of the anti-aliasing test in hardEdgeRatio. Measured (tol 8 / 12 / 16 / 24):
 * sprite32 seeds 1-7 over white 1.000 for all; aaCircle 0 / 0.054 / 0.054 / 0.054; glyph
 * 0.088 / 0.088 / 0.088 / 0.127; clip_art (JPEG) 0.28 / 0.21 / 0.16 / 0.07; splash
 * 0.05 / 0.10 / 0.21 / 0.40. 12 flags quantisation-level wobble as neither blend nor extreme
 * while keeping the JPEG and gradient art far from the 0.9 pixel-art rule.
 */
export const HARD_EDGE_TOL = 12;

/**
 * Among edge pixels (Sobel magnitude > 64; on RGB the largest of the three channel magnitudes):
 * the fraction whose transition is abrupt, i.e. no pixel of their 3x3 neighbourhood (in-bounds
 * pixels only) holds an intermediate anti-aliasing value.
 *
 * A pixel q is such a blend when, over its own 3x3 neighbourhood and on the channel with the
 * largest local range lo..hi (> 2·HARD_EDGE_TOL), q's value is more than HARD_EDGE_TOL away from
 * both lo and hi and — on RGB — q's colour lies within HARD_EDGE_TOL (every channel) of the
 * blend of the two pixels holding lo and hi at the same parameter. So a hard step between ANY
 * two levels is hard (not only black/white), while a genuine third colour where three pixel-art
 * blocks meet is not on that segment and is not taken for anti-aliasing.
 *
 * Accepts a GrayImage (single channel) or an RGBA RasterImage (alpha ignored). 0 when there are
 * no edge pixels.
 */
export function hardEdgeRatio(img: GrayImage | RasterImage): number {
  const { width: w, height: h } = img;
  if (w <= 0 || h <= 0) return 0;
  const d = img.data;
  if (d instanceof Float32Array) return hardEdgeRatioGray(d, w, h);
  return hardEdgeRatioRgb(d, w, h);
}

function hardEdgeRatioGray(d: Float32Array, w: number, h: number): number {
  const mag = sobelMagnitude({ data: d, width: w, height: h }).data;
  const tol = HARD_EDGE_TOL;
  // Lazily computed blend flag per pixel: -1 unknown, 0 no, 1 yes.
  const flag = new Int8Array(w * h).fill(-1);
  const isBlend = (x: number, y: number): boolean => {
    const i = y * w + x;
    if (flag[i] >= 0) return flag[i] === 1;
    const ya = y > 0 ? y - 1 : 0;
    const yb = y < h - 1 ? y + 1 : h - 1;
    const xa = x > 0 ? x - 1 : 0;
    const xb = x < w - 1 ? x + 1 : w - 1;
    let lo = Infinity;
    let hi = -Infinity;
    for (let yy = ya; yy <= yb; yy++) {
      const row = yy * w;
      for (let xx = xa; xx <= xb; xx++) {
        const v = d[row + xx];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const v = d[i];
    const blend = hi - lo > 2 * tol && v - lo > tol && hi - v > tol;
    flag[i] = blend ? 1 : 0;
    return blend;
  };
  let edges = 0;
  let hard = 0;
  for (let y = 0; y < h; y++) {
    const ya = y > 0 ? y - 1 : 0;
    const yb = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      if (!(mag[y * w + x] > EDGE_MAGNITUDE)) continue;
      edges++;
      const xa = x > 0 ? x - 1 : 0;
      const xb = x < w - 1 ? x + 1 : w - 1;
      let soft = false;
      for (let yy = ya; yy <= yb && !soft; yy++) {
        for (let xx = xa; xx <= xb; xx++) {
          if (isBlend(xx, yy)) {
            soft = true;
            break;
          }
        }
      }
      if (!soft) hard++;
    }
  }
  return edges === 0 ? 0 : hard / edges;
}

function hardEdgeRatioRgb(d: Uint8ClampedArray, w: number, h: number): number {
  const tol = HARD_EDGE_TOL;
  const flag = new Int8Array(w * h).fill(-1);
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  const loAt = [0, 0, 0];
  const hiAt = [0, 0, 0];
  const isBlend = (x: number, y: number): boolean => {
    const i = y * w + x;
    if (flag[i] >= 0) return flag[i] === 1;
    const ya = y > 0 ? y - 1 : 0;
    const yb = y < h - 1 ? y + 1 : h - 1;
    const xa = x > 0 ? x - 1 : 0;
    const xb = x < w - 1 ? x + 1 : w - 1;
    for (let c = 0; c < 3; c++) {
      lo[c] = 256;
      hi[c] = -1;
    }
    for (let yy = ya; yy <= yb; yy++) {
      for (let xx = xa; xx <= xb; xx++) {
        const o = (yy * w + xx) * 4;
        for (let c = 0; c < 3; c++) {
          const v = d[o + c];
          if (v < lo[c]) {
            lo[c] = v;
            loAt[c] = o;
          }
          if (v > hi[c]) {
            hi[c] = v;
            hiAt[c] = o;
          }
        }
      }
    }
    let c = 0;
    if (hi[1] - lo[1] > hi[c] - lo[c]) c = 1;
    if (hi[2] - lo[2] > hi[c] - lo[c]) c = 2;
    const o = i * 4;
    const v = d[o + c];
    const range = hi[c] - lo[c];
    let blend = range > 2 * tol && v - lo[c] > tol && hi[c] - v > tol;
    if (blend) {
      // Same parameter on the segment between the two extreme pixels, every channel.
      const t = (v - lo[c]) / range;
      const a = loAt[c];
      const b = hiAt[c];
      for (let k = 0; k < 3; k++) {
        const diff = d[o + k] - (d[a + k] + t * (d[b + k] - d[a + k]));
        if (diff > tol || diff < -tol) {
          blend = false;
          break;
        }
      }
    }
    flag[i] = blend ? 1 : 0;
    return blend;
  };
  // (|G| / 4)^2 > 64^2 on the raw Sobel sums.
  const edge2 = 16 * EDGE_MAGNITUDE * EDGE_MAGNITUDE;
  let edges = 0;
  let hard = 0;
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w;
    const y0 = y * w;
    const yp = (y < h - 1 ? y + 1 : h - 1) * w;
    const ya = y > 0 ? y - 1 : 0;
    const yb = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      let isEdge = false;
      for (let c = 0; c < 3 && !isEdge; c++) {
        const tl = d[(ym + xm) * 4 + c];
        const tc = d[(ym + x) * 4 + c];
        const tr = d[(ym + xp) * 4 + c];
        const ml = d[(y0 + xm) * 4 + c];
        const mr = d[(y0 + xp) * 4 + c];
        const bl = d[(yp + xm) * 4 + c];
        const bc = d[(yp + x) * 4 + c];
        const br = d[(yp + xp) * 4 + c];
        const gx = tr + 2 * mr + br - tl - 2 * ml - bl;
        const gy = bl + 2 * bc + br - tl - 2 * tc - tr;
        isEdge = gx * gx + gy * gy > edge2;
      }
      if (!isEdge) continue;
      edges++;
      let soft = false;
      for (let yy = ya; yy <= yb && !soft; yy++) {
        for (let xx = xm; xx <= xp; xx++) {
          if (isBlend(xx, yy)) {
            soft = true;
            break;
          }
        }
      }
      if (!soft) hard++;
    }
  }
  return edges === 0 ? 0 : hard / edges;
}

/** 1 - countInk(erode1(mask)) / countInk(mask); 0 when the mask has no ink. */
export function thinStrokeRatio(mask: BinaryMask): number {
  const ink = countInk(mask);
  if (ink === 0) return 0;
  return 1 - countInk(erode1(mask)) / ink;
}

/** RGBA pixels as packed uint32 (byte order irrelevant: only equality is tested). */
function packedPixels(img: RasterImage): Uint32Array {
  const d = img.data;
  const n = img.width * img.height;
  if (d.byteOffset % 4 === 0 && d.byteLength >= n * 4) {
    return new Uint32Array(d.buffer, d.byteOffset, n);
  }
  const copy = new Uint8ClampedArray(n * 4);
  copy.set(d.subarray(0, n * 4));
  return new Uint32Array(copy.buffer, 0, n);
}

/**
 * Largest k in [8..2] such that w % k == 0, h % k == 0 and every k x k block is a single exact
 * RGBA colour; 1 when no such k exists.
 */
export function detectGrid(img: RasterImage): number {
  const { width: w, height: h } = img;
  if (w <= 0 || h <= 0) return 1;
  const px = packedPixels(img);
  for (let k = 8; k >= 2; k--) {
    if (w % k !== 0 || h % k !== 0) continue;
    if (allBlocksConstant(px, w, h, k)) return k;
  }
  return 1;
}

function allBlocksConstant(px: Uint32Array, w: number, h: number, k: number): boolean {
  for (let by = 0; by < h; by += k) {
    for (let bx = 0; bx < w; bx += k) {
      const ref = px[by * w + bx];
      for (let y = by; y < by + k; y++) {
        const row = y * w;
        for (let x = bx; x < bx + k; x++) {
          if (px[row + x] !== ref) return false;
        }
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Gradient mode (phase 1): RGB edge maps, hysteresis and noise-scaled thresholds
// ---------------------------------------------------------------------------------------------

export interface EdgeMaps {
  sobel: GrayImage;
  laplacian: GrayImage;
}

/**
 * Edge maps of an RGBA image, per channel R, G and B (and alpha when `withAlpha`; ignored otherwise), with
 * replicated borders, keeping the largest channel at every pixel:
 *   sobel     = sqrt(gx² + gy²) with each component divided by 4 (a clean 0 -> 255 step gives 255, as
 *               sobelMagnitude; a ramp of slope s gives 2s);
 *   laplacian = |convolution with [[1,1,1],[1,-8,1],[1,1,1]]| / 8: 0 on any linear ramp (so a gradient
 *               has none), a peak on both sides of an anti-aliased edge.
 * Same size as img.
 */
export function rgbEdgeMaps(img: RasterImage, withAlpha = false): EdgeMaps {
  const { width: w, height: h } = img;
  const n = w * h;
  const d = img.data;
  if (d.length < n * 4) throw new RangeError('rgbEdgeMaps: data.length < width·height·4');
  const sob = new Float32Array(n);
  const lap = new Float32Array(n);
  const channels = withAlpha ? 4 : 3;
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w;
    const y0 = y * w;
    const yp = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      const oTl = (ym + xm) * 4;
      const oTc = (ym + x) * 4;
      const oTr = (ym + xp) * 4;
      const oMl = (y0 + xm) * 4;
      const oMc = (y0 + x) * 4;
      const oMr = (y0 + xp) * 4;
      const oBl = (yp + xm) * 4;
      const oBc = (yp + x) * 4;
      const oBr = (yp + xp) * 4;
      let s2 = 0;
      let l = 0;
      for (let c = 0; c < channels; c++) {
        const tl = d[oTl + c];
        const tc = d[oTc + c];
        const tr = d[oTr + c];
        const ml = d[oMl + c];
        const mr = d[oMr + c];
        const bl = d[oBl + c];
        const bc = d[oBc + c];
        const br = d[oBr + c];
        const gx = tr + 2 * mr + br - tl - 2 * ml - bl;
        const gy = bl + 2 * bc + br - tl - 2 * tc - tr;
        const g2 = gx * gx + gy * gy;
        if (g2 > s2) s2 = g2;
        let lc = tl + tc + tr + ml + mr + bl + bc + br - 8 * d[oMc + c];
        if (lc < 0) lc = -lc;
        if (lc > l) l = lc;
      }
      sob[y0 + x] = Math.sqrt(s2) * 0.25;
      lap[y0 + x] = l * 0.125;
    }
  }
  return { sobel: { data: sob, width: w, height: h }, laplacian: { data: lap, width: w, height: h } };
}

/**
 * Hysteresis thresholding: 1 where mag > hi, or mag > lo and 8-connected (through pixels > lo) to a
 * pixel > hi. Flood fill with an explicit Int32Array stack (grown on demand, each pixel pushed at most
 * once), no recursion. NaN never passes either threshold.
 */
export function hysteresis(mag: Float32Array, width: number, height: number, lo: number, hi: number): BinaryMask {
  const w = width;
  const h = height;
  const n = w * h;
  if (mag.length < n) throw new RangeError('hysteresis: mag.length < width·height');
  const out = new Uint8Array(n);
  let stack = new Int32Array(Math.max(1, Math.min(n, 1 << 16)));
  let top = 0;
  for (let i = 0; i < n; i++) {
    if (out[i] !== 0 || !(mag[i] > hi)) continue;
    out[i] = 1;
    stack[top++] = i;
    while (top > 0) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      const xa = x > 0 ? x - 1 : 0;
      const xb = x < w - 1 ? x + 1 : x;
      const ya = y > 0 ? y - 1 : 0;
      const yb = y < h - 1 ? y + 1 : y;
      for (let yy = ya; yy <= yb; yy++) {
        const row = yy * w;
        for (let xx = xa; xx <= xb; xx++) {
          const q = row + xx;
          if (out[q] !== 0 || !(mag[q] > lo)) continue;
          out[q] = 1;
          if (top === stack.length) {
            const grown = new Int32Array(Math.min(n, stack.length * 2));
            grown.set(stack);
            stack = grown;
          }
          stack[top++] = q;
        }
      }
    }
  }
  return { data: out, width: w, height: h };
}

export interface EdgeThresholds {
  lapHi: number;
  lapLo: number;
  sobHi: number;
  sobLo: number;
}

/** Laplacian (÷8) floor of the strong threshold, levels: the plan's measurement on the clean bird. */
const LAP_HI_MIN = 6;
/** Strong Laplacian threshold per level of noise sigma: 1.8 · 4σ. */
const LAP_HI_PER_SIGMA = 1.8 * 4;
const LAP_LO_RATIO = 0.45;
/** Sobel (÷4) floor of the strong threshold, levels. */
const SOB_HI_MIN = 24;
const SOB_HI_PER_SIGMA = 9;
const SOB_LO_RATIO = 0.4;

/**
 * Edge thresholds scaled by the noise estimate σ (immerkaerSigma, levels) and divided by regionDetail
 * (above 1: lower thresholds, more edges, more regions):
 *   lapHi = max(6, 1.8·4σ) / regionDetail; lapLo = 0.45·lapHi; sobHi = max(24, 9σ) / regionDetail; sobLo = 0.4·sobHi.
 * A non-finite or negative σ counts as 0; a non-finite or non-positive regionDetail as 1.
 * The edge mask is hysteresis(laplacian, lapLo, lapHi) ∪ hysteresis(sobel, sobLo, sobHi).
 */
export function edgeThresholds(sigma: number, regionDetail: number): EdgeThresholds {
  const s = Number.isFinite(sigma) && sigma > 0 ? sigma : 0;
  const detail = Number.isFinite(regionDetail) && regionDetail > 0 ? regionDetail : 1;
  const lapHi = Math.max(LAP_HI_MIN, LAP_HI_PER_SIGMA * s) / detail;
  const sobHi = Math.max(SOB_HI_MIN, SOB_HI_PER_SIGMA * s) / detail;
  return { lapHi, lapLo: LAP_LO_RATIO * lapHi, sobHi, sobLo: SOB_LO_RATIO * sobHi };
}

/** Radius (px, Chebyshev) of the Laplacian activity that lets a weak Sobel pixel into the hysteresis (gateSobel). */
export const SOBEL_GATE_RADIUS = 1;
/**
 * Radius (px, Chebyshev) of the window whose smallest Sobel value a weak pixel must exceed by sobLo (gateSobel): a soft
 * step (a bicubic-upscaled boundary, 4-6 px wide) has its low surroundings within 2 px of its centre.
 */
export const SOBEL_CONTRAST_RADIUS = 2;
/**
 * A weak step seeds the Sobel hysteresis only farther than this (px, Chebyshev) from every strong pixel (gateSobel):
 * next to a strong edge the hysteresis already reaches it, and seeds there cut the narrow tips of shapes, whose
 * anti-aliased sides are weak and stand out (gradientFeathers(256): 3 tips became regions of their own).
 */
export const SOBEL_SEED_CLEARANCE = 3;

export function gateSobel(
  sobel: Float32Array,
  laplacian: Float32Array,
  width: number,
  height: number,
  t: EdgeThresholds,
  lapRadius: number = SOBEL_GATE_RADIUS,
  contrastRadius: number = SOBEL_CONTRAST_RADIUS,
): Float32Array {
  const w = width;
  const h = height;
  const n = w * h;
  if (sobel.length < n || laplacian.length < n) throw new RangeError('gateSobel: map length < width·height');
  const out = new Float32Array(n);
  const rl = lapRadius >= 0 ? Math.floor(lapRadius) : -1;
  const rc = contrastRadius >= 0 ? Math.floor(contrastRadius) : -1;
  const rs = SOBEL_SEED_CLEARANCE;
  const { sobLo, sobHi, lapLo, lapHi } = t;
  // The windows are read only around weak pixels (a minority), with early exits: the same clipped squares as a
  // separable minimum / maximum filter over the whole image, at a fraction of the cost.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = sobel[i];
      if (!(v > sobLo) || v > sobHi) {
        out[i] = v;
        continue;
      }
      let localized = false;
      if (rc >= 0) {
        const floor = v - sobLo;
        const y0 = y > rc ? y - rc : 0;
        const y1 = y + rc < h ? y + rc : h - 1;
        const x0 = x > rc ? x - rc : 0;
        const x1 = x + rc < w ? x + rc : w - 1;
        for (let yy = y0; yy <= y1 && !localized; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            if (sobel[row + xx] < floor) {
              localized = true;
              break;
            }
          }
        }
      }
      if (localized) {
        let near = false;
        const y0 = y > rs ? y - rs : 0;
        const y1 = y + rs < h ? y + rs : h - 1;
        const x0 = x > rs ? x - rs : 0;
        const x1 = x + rs < w ? x + rs : w - 1;
        for (let yy = y0; yy <= y1 && !near; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            const j = row + xx;
            if (sobel[j] > sobHi || laplacian[j] > lapHi) {
              near = true;
              break;
            }
          }
        }
        out[i] = near ? v : Number.POSITIVE_INFINITY;
        continue;
      }
      let active = false;
      if (rl >= 0) {
        const y0 = y > rl ? y - rl : 0;
        const y1 = y + rl < h ? y + rl : h - 1;
        const x0 = x > rl ? x - rl : 0;
        const x1 = x + rl < w ? x + rl : w - 1;
        for (let yy = y0; yy <= y1 && !active; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            if (laplacian[row + xx] > lapLo) {
              active = true;
              break;
            }
          }
        }
      }
      out[i] = active ? v : 0;
    }
  }
  return out;
}
