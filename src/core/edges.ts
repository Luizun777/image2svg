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
