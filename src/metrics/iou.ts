/**
 * Pixel-wise comparison metrics with an optional ROI. Pure; never mutates inputs.
 */
import type { BinaryMask, GrayImage, RasterImage } from '../types';
import { clampBox, type Box } from './bbox';

function assertSameSize(
  a: { width: number; height: number },
  b: { width: number; height: number },
  fn: string,
): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`${fn}: tamaños distintos (${a.width}x${a.height} vs ${b.width}x${b.height})`);
  }
}

/** Intersection over union of ink pixels (value !== 0) inside the ROI. 1 when both are empty. */
export function iou(a: BinaryMask, b: BinaryMask, roi?: Box): number {
  assertSameSize(a, b, 'iou');
  const w = a.width;
  const r = clampBox(roi, w, a.height);
  const A = a.data;
  const B = b.data;
  let inter = 0;
  let union = 0;
  for (let y = r.y0; y < r.y1; y++) {
    let p = y * w + r.x0;
    for (let x = r.x0; x < r.x1; x++, p++) {
      if (A[p] !== 0) {
        union++;
        if (B[p] !== 0) inter++;
      } else if (B[p] !== 0) {
        union++;
      }
    }
  }
  return union === 0 ? 1 : inter / union;
}

/** Mean absolute error (0..255) over the ROI. 0 for an empty ROI. */
export function mae(a: GrayImage, b: GrayImage, roi?: Box): number {
  assertSameSize(a, b, 'mae');
  const w = a.width;
  const r = clampBox(roi, w, a.height);
  const A = a.data;
  const B = b.data;
  let sum = 0;
  let count = 0;
  for (let y = r.y0; y < r.y1; y++) {
    let p = y * w + r.x0;
    // Accumulate each row separately to keep the running sum small (better precision).
    let rowSum = 0;
    for (let x = r.x0; x < r.x1; x++, p++) {
      const d = A[p] - B[p];
      rowSum += d < 0 ? -d : d;
    }
    sum += rowSum;
    count += r.x1 - r.x0;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Fraction of ROI pixels whose largest RGB channel difference is strictly greater than
 * `threshold`. Alpha is ignored. 0 for an empty ROI.
 */
export function pctDiff(a: RasterImage, b: RasterImage, threshold: number, roi?: Box): number {
  assertSameSize(a, b, 'pctDiff');
  const w = a.width;
  const r = clampBox(roi, w, a.height);
  const A = a.data;
  const B = b.data;
  let bad = 0;
  let count = 0;
  for (let y = r.y0; y < r.y1; y++) {
    let p = (y * w + r.x0) * 4;
    for (let x = r.x0; x < r.x1; x++, p += 4) {
      let dr = A[p] - B[p];
      let dg = A[p + 1] - B[p + 1];
      let db = A[p + 2] - B[p + 2];
      if (dr < 0) dr = -dr;
      if (dg < 0) dg = -dg;
      if (db < 0) db = -db;
      const m = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
      if (m > threshold) bad++;
    }
    count += r.x1 - r.x0;
  }
  return count === 0 ? 0 : bad / count;
}
