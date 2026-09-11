/**
 * Ink bounding box and ROI helpers. Pure; never mutates inputs.
 */
import type { GrayImage } from '../types';

/** Half-open box: pixels with x0 <= x < x1 and y0 <= y < y1. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Clamp an optional ROI to the image (integer, half-open). `undefined` -> whole image.
 * Non-finite coordinates fall back to the image border on that side. An empty result is
 * returned canonically as {0,0,0,0} so callers only need to test `x1 > x0`.
 */
export function clampBox(box: Box | undefined, width: number, height: number): Box {
  const w = width > 0 ? Math.floor(width) : 0;
  const h = height > 0 ? Math.floor(height) : 0;
  if (!box) return { x0: 0, y0: 0, x1: w, y1: h };
  let x0 = Number.isFinite(box.x0) ? Math.floor(box.x0) : 0;
  let y0 = Number.isFinite(box.y0) ? Math.floor(box.y0) : 0;
  let x1 = Number.isFinite(box.x1) ? Math.ceil(box.x1) : w;
  let y1 = Number.isFinite(box.y1) ? Math.ceil(box.y1) : h;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > w) x1 = w;
  if (y1 > h) y1 = h;
  if (x1 <= x0 || y1 <= y0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

/**
 * Bounding box of "ink": pixels with |v - bgLuma| > tol (default 24), dilated on every side by
 * round(dilateFrac * max(w, h)) px (default 5 %) and clamped to the image. Whole image when no
 * pixel qualifies (or the image is empty). NaN pixels never count as ink.
 */
export function inkBBox(gray: GrayImage, bgLuma: number, tol = 24, dilateFrac = 0.05): Box {
  const { width: w, height: h, data: d } = gray;
  if (!(w > 0) || !(h > 0)) return { x0: 0, y0: 0, x1: w > 0 ? w : 0, y1: h > 0 ? h : 0 };
  const t = tol >= 0 ? tol : 0;
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let first = -1;
    for (let x = 0; x < w; x++) {
      const v = d[base + x] - bgLuma;
      if (v > t || v < -t) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = w - 1; x > first; x--) {
      const v = d[base + x] - bgLuma;
      if (v > t || v < -t) {
        last = x;
        break;
      }
    }
    if (first < minX) minX = first;
    if (last > maxX) maxX = last;
    if (y < minY) minY = y;
    maxY = y;
  }
  if (maxX < 0) return { x0: 0, y0: 0, x1: w, y1: h };
  const pad = dilateFrac > 0 ? Math.round(dilateFrac * Math.max(w, h)) : 0;
  return {
    x0: Math.max(0, minX - pad),
    y0: Math.max(0, minY - pad),
    x1: Math.min(w, maxX + 1 + pad),
    y1: Math.min(h, maxY + 1 + pad),
  };
}
