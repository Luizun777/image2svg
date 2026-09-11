/**
 * Noise estimation for gradient mode (Immerkær 1996). Pure; never mutates inputs.
 */
import type { RasterImage } from '../types';

/** A pixel enters the estimate only when every pixel of its 3×3 has alpha >= this. */
const OPAQUE_ALPHA = 250;
/** Floor of the strong-edge threshold on the luma Sobel magnitude (÷4, levels). */
const EDGE_SOBEL_MIN = 24;
/** The strong-edge threshold is at least this many times the estimate taken without excluding edges. */
const EDGE_SOBEL_PER_SIGMA = 3;

const SQRT_HALF_PI = Math.sqrt(Math.PI / 2);

/** |L * N| at interior pixel i, N = [[1,-2,1],[-2,4,-2],[1,-2,1]]. */
function absResponse(l: Float32Array, w: number, i: number): number {
  const up = i - w;
  const dn = i + w;
  const v =
    l[up - 1] - 2 * l[up] + l[up + 1] - 2 * l[i - 1] + 4 * l[i] - 2 * l[i + 1] + l[dn - 1] - 2 * l[dn] + l[dn + 1];
  return v < 0 ? -v : v;
}

/** 1 where the whole 3×3 (interior pixels only) has alpha >= OPAQUE_ALPHA; null when every pixel is opaque. */
function opaqueInteriors(d: Uint8ClampedArray, w: number, h: number): Uint8Array | null {
  const n = w * h;
  let all = true;
  for (let o = 3; o < n * 4; o += 4) {
    if (d[o] < OPAQUE_ALPHA) {
      all = false;
      break;
    }
  }
  if (all) return null;
  // Horizontal run of 3 opaque pixels centred at (x, y), then the vertical AND of three rows.
  const hor = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const o = (row + x) * 4 + 3;
      if (d[o - 4] >= OPAQUE_ALPHA && d[o] >= OPAQUE_ALPHA && d[o + 4] >= OPAQUE_ALPHA) hor[row + x] = 1;
    }
  }
  const ok = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      if (hor[i - w] !== 0 && hor[i] !== 0 && hor[i + w] !== 0) ok[i] = 1;
    }
  }
  return ok;
}

/**
 * Noise sigma (levels 0..255) of the Rec.601 luma 0.299R + 0.587G + 0.114B, unblurred, by Immerkær's
 * estimator σ = sqrt(π/2) · Σ|L * N| / (6n), N = [[1,-2,1],[-2,4,-2],[1,-2,1]] (N cancels every
 * function linear in x or in y, so ramps add nothing).
 *
 * Summed pixels: interior pixels whose 3×3 is opaque (alpha >= 250) and not near a strong edge, i.e. no
 * pixel of their 3×3 has a luma Sobel magnitude (÷4, replicated borders) above
 * T = max(24, 3·σ_all), σ_all being the same estimate over every opaque interior pixel (edges
 * included). On pure noise the Sobel and N responses of a pixel are uncorrelated, so the exclusion does
 * not bias the estimate; T >= 3σ_all keeps noise from excluding itself. When the exclusion leaves no
 * pixel, σ_all is returned; 0 when there is no opaque interior pixel (images under 3×3 included).
 */
export function immerkaerSigma(img: RasterImage): number {
  const { width: w, height: h } = img;
  if (w < 3 || h < 3) return 0;
  const n = w * h;
  const d = img.data;
  if (d.length < n * 4) throw new RangeError('immerkaerSigma: data.length < width·height·4');
  const luma = new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) luma[i] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  const ok = opaqueInteriors(d, w, h);

  let sumAll = 0;
  let nAll = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      if (ok !== null && ok[i] === 0) continue;
      sumAll += absResponse(luma, w, i);
      nAll++;
    }
  }
  if (nAll === 0) return 0;
  const sigmaAll = (SQRT_HALF_PI * sumAll) / (6 * nAll);

  // Strong-edge flags: luma Sobel (÷4) above T, compared squared on the raw sums.
  const t = Math.max(EDGE_SOBEL_MIN, EDGE_SOBEL_PER_SIGMA * sigmaAll);
  const t2 = 16 * t * t;
  const strong = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w;
    const y0 = y * w;
    const yp = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      const tl = luma[ym + xm];
      const tr = luma[ym + xp];
      const bl = luma[yp + xm];
      const br = luma[yp + xp];
      const gx = tr + 2 * luma[y0 + xp] + br - tl - 2 * luma[y0 + xm] - bl;
      const gy = bl + 2 * luma[yp + x] + br - tl - 2 * luma[ym + x] - tr;
      if (gx * gx + gy * gy > t2) strong[y0 + x] = 1;
    }
  }

  let sum = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      if (ok !== null && ok[i] === 0) continue;
      const up = i - w;
      const dn = i + w;
      if (
        strong[up - 1] | strong[up] | strong[up + 1] | strong[i - 1] | strong[i] | strong[i + 1] |
        strong[dn - 1] | strong[dn] | strong[dn + 1]
      ) {
        continue;
      }
      sum += absResponse(luma, w, i);
      count++;
    }
  }
  if (count === 0) return sigmaAll;
  return (SQRT_HALF_PI * sum) / (6 * count);
}
