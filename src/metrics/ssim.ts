/**
 * Box-window SSIM (Wang et al. 2004 with a uniform 8x8 window instead of the Gaussian one).
 * Window sums come from per-band column sums + a horizontal prefix sum (an integral image
 * restricted to one band of rows), so memory is O(width) and no full-size buffers are needed.
 * Pure; never mutates inputs.
 */
import type { GrayImage } from '../types';
import { clampBox, type Box } from './bbox';

/** (K1 * 255)^2 with K1 = 0.01 and (K2 * 255)^2 with K2 = 0.03. */
const C1 = 6.5025;
const C2 = 58.5225;

/**
 * Mean SSIM over `win`x`win` windows (default 8) placed every win/2 px (stride 4) and lying fully
 * inside the ROI (whole image when omitted). A ROI smaller than the window in one axis shrinks
 * the window to the ROI extent on that axis; an empty ROI yields 1 (nothing to compare).
 * ssim(a, a) is exactly 1: both operands go through identical arithmetic.
 * Throws when the images differ in size.
 */
export function ssim(a: GrayImage, b: GrayImage, roi?: Box, win = 8): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `ssim: tamaños distintos (${a.width}x${a.height} vs ${b.width}x${b.height})`,
    );
  }
  const w = a.width;
  const r = clampBox(roi, w, a.height);
  const rw = r.x1 - r.x0;
  const rh = r.y1 - r.y0;
  if (rw <= 0 || rh <= 0) return 1;
  let wsz = Math.floor(win);
  if (!(wsz >= 1)) wsz = 8;
  const winW = Math.min(wsz, rw);
  const winH = Math.min(wsz, rh);
  const strideX = Math.max(1, winW >> 1);
  const strideY = Math.max(1, winH >> 1);
  const n = winW * winH;
  const A = a.data;
  const B = b.data;
  // Prefix sums along x of the column sums of the current band; index 0 is the empty prefix.
  const px = new Float64Array(rw + 1);
  const py = new Float64Array(rw + 1);
  const pxx = new Float64Array(rw + 1);
  const pyy = new Float64Array(rw + 1);
  const pxy = new Float64Array(rw + 1);
  let sum = 0;
  let count = 0;
  for (let y0 = r.y0; y0 + winH <= r.y1; y0 += strideY) {
    px.fill(0);
    py.fill(0);
    pxx.fill(0);
    pyy.fill(0);
    pxy.fill(0);
    const yEnd = y0 + winH;
    for (let y = y0; y < yEnd; y++) {
      let p = y * w + r.x0;
      for (let i = 1; i <= rw; i++, p++) {
        const xv = A[p];
        const yv = B[p];
        px[i] += xv;
        py[i] += yv;
        pxx[i] += xv * xv;
        pyy[i] += yv * yv;
        pxy[i] += xv * yv;
      }
    }
    for (let i = 1; i <= rw; i++) {
      px[i] += px[i - 1];
      py[i] += py[i - 1];
      pxx[i] += pxx[i - 1];
      pyy[i] += pyy[i - 1];
      pxy[i] += pxy[i - 1];
    }
    for (let x0 = 0; x0 + winW <= rw; x0 += strideX) {
      const x1 = x0 + winW;
      const mx = (px[x1] - px[x0]) / n;
      const my = (py[x1] - py[x0]) / n;
      let vx = (pxx[x1] - pxx[x0]) / n - mx * mx;
      let vy = (pyy[x1] - pyy[x0]) / n - my * my;
      const cxy = (pxy[x1] - pxy[x0]) / n - mx * my;
      // Variances can dip below 0 by cancellation on flat windows; the true value is >= 0.
      if (vx < 0) vx = 0;
      if (vy < 0) vy = 0;
      const num = (2 * mx * my + C1) * (2 * cxy + C2);
      const den = (mx * mx + my * my + C1) * (vx + vy + C2);
      sum += num / den;
      count++;
    }
  }
  return count > 0 ? sum / count : 1;
}
