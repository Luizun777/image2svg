/**
 * Histograms, Otsu thresholding and binarisation. Pure; never mutates inputs.
 * Polarity everywhere: ink = gray < t (1 = ink).
 */
import type { BinaryMask, GrayImage, RasterImage } from '../types';

/** 256 bins; values rounded to nearest and clamped to [0,255]. NaN counts as 0. */
export function histogram256(img: GrayImage): Float64Array {
  const hist = new Float64Array(256);
  const d = img.data;
  for (let i = 0; i < d.length; i++) {
    let v = d[i];
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    // (v + 0.5) | 0 rounds half up for v >= 0; NaN -> 0.
    hist[(v + 0.5) | 0]++;
  }
  return hist;
}

/**
 * Otsu's method. Returns t in 0..255 maximising between-class variance of the split
 * {bins < t} vs {bins >= t}, i.e. pixel < t -> ink. When several t tie (a flat gap between the
 * modes) the middle of the tied run is returned. Empty histogram -> 128.
 */
export function otsu(hist: Float64Array): number {
  const { total, betweenVarianceAt } = otsuState(hist);
  if (total === 0) return 128;
  let best = -1;
  let first = 128;
  let last = 128;
  for (let t = 1; t <= 255; t++) {
    const v = betweenVarianceAt(t);
    if (v > best) {
      best = v;
      first = t;
      last = t;
    } else if (v === best) {
      last = t;
    }
  }
  return Math.round((first + last) / 2);
}

/**
 * Shared Otsu bookkeeping: cumulative weights/means so the between-class variance of any split
 * can be evaluated in O(1). Kept tiny and allocation-free apart from two 256-entry arrays.
 */
function otsuState(hist: Float64Array): {
  total: number;
  mean: number;
  variance: number;
  betweenVarianceAt: (t: number) => number;
} {
  const cumW = new Float64Array(257);
  const cumS = new Float64Array(257);
  for (let i = 0; i < 256; i++) {
    cumW[i + 1] = cumW[i] + hist[i];
    cumS[i + 1] = cumS[i] + hist[i] * i;
  }
  const total = cumW[256];
  const mean = total > 0 ? cumS[256] / total : 0;
  let variance = 0;
  if (total > 0) {
    let acc = 0;
    for (let i = 0; i < 256; i++) acc += hist[i] * (i - mean) * (i - mean);
    variance = acc / total;
  }
  const betweenVarianceAt = (t: number): number => {
    const w0 = cumW[t];
    const w1 = total - w0;
    if (w0 <= 0 || w1 <= 0) return 0;
    const m0 = cumS[t] / w0;
    const m1 = (cumS[256] - cumS[t]) / w1;
    const dm = m1 - m0;
    return (w0 / total) * (w1 / total) * dm * dm;
  };
  return { total, mean, variance, betweenVarianceAt };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Share of the ink class, counted from its far end (darkest bins; brightest with invert), whose
 * level is taken as the ink level I. Not the class mean or median: in a thin anti-aliased stroke
 * most "ink" pixels are partial-coverage blends and only the core reaches the true ink level,
 * while 5 % still ignores a few isolated specks. Measured (traced IoU vs the ideal 4x mask,
 * levels on the 1x source): aaDiagonalLine(1.5) p1..p10 0.954, p25 0.938, p50 0.775;
 * a 1-px line p1..p5 0.912, p10 0.901, p25 0.869.
 */
export const INK_LEVEL_PERCENTILE = 0.05;

/**
 * Minimum |P - I| (grey levels) for the ink/paper levels to be trusted. Below it there is no
 * usable separation (a nearly uniform or pure-noise image) and the clamped Otsu level is used.
 */
export const MIN_LEVEL_SEPARATION = 24;

/**
 * Bin where the cumulative count of class [lo, hi) reaches q of the class, walking upwards from
 * lo (or downwards from hi - 1 with fromTop). -1 for an empty class.
 */
function classPercentile(hist: Float64Array, lo: number, hi: number, q: number, fromTop: boolean): number {
  let total = 0;
  for (let i = lo; i < hi; i++) total += hist[i];
  if (total <= 0) return -1;
  const target = q * total;
  let acc = 0;
  if (fromTop) {
    for (let i = hi - 1; i >= lo; i--) {
      acc += hist[i];
      if (acc > 0 && acc >= target) return i;
    }
    return lo;
  }
  for (let i = lo; i < hi; i++) {
    acc += hist[i];
    if (acc > 0 && acc >= target) return i;
  }
  return hi - 1;
}

/**
 * Binarisation level (normalised 0..1) at the geometric 50 % coverage iso-level between ink and
 * paper: t = (I + P) / 2 + offset, clamped to [0.02, 0.98].
 *
 * Otsu only splits the histogram into two classes. P is the median of the paper class and I the
 * INK_LEVEL_PERCENTILE of the ink class from its far end; ink is the dark class (pixel < t), or
 * the bright one with `invert` (matching binarize's polarity). Pass the UNBLURRED source: the
 * upscale and the blur keep the flat levels but pull thin strokes away from theirs, so the
 * levels measured there would fatten them.
 *
 * Fallback, when a class is empty or |P - I| < MIN_LEVEL_SEPARATION: clamp(otsu/255, 0.35, 0.65).
 * (That clamp used to be applied always: light ink on white — orange, cyan, gold — had its Otsu
 * level 215-229 clamped to 166 and lost every ink pixel; navy on #303030 went all-ink.)
 */
export function resolveThreshold(img: GrayImage, offset: number, invert = false): number {
  const hist = histogram256(img);
  const split = otsu(hist);
  const off = Number.isFinite(offset) ? offset : 0;
  let level = clamp(split / 255, 0.35, 0.65);
  const ink = invert
    ? classPercentile(hist, split, 256, INK_LEVEL_PERCENTILE, true)
    : classPercentile(hist, 0, split, INK_LEVEL_PERCENTILE, false);
  const paper = invert ? classPercentile(hist, 0, split, 0.5, false) : classPercentile(hist, split, 256, 0.5, false);
  if (ink >= 0 && paper >= 0 && Math.abs(paper - ink) >= MIN_LEVEL_SEPARATION) {
    level = (ink + paper) / 2 / 255;
  }
  return clamp(level + off, 0.02, 0.98);
}

/** ink (1) = gray < t*255; with invert, ink = gray >= t*255. */
export function binarize(img: GrayImage, thresholdNorm: number, invert = false): BinaryMask {
  const d = img.data;
  const out = new Uint8Array(d.length);
  const t = thresholdNorm * 255;
  if (invert) {
    for (let i = 0; i < d.length; i++) out[i] = d[i] >= t ? 1 : 0;
  } else {
    for (let i = 0; i < d.length; i++) out[i] = d[i] < t ? 1 : 0;
  }
  return { data: out, width: img.width, height: img.height };
}

/** ink (1) = alpha >= t*255 (default t = 0.5). */
export function maskFromAlpha(img: RasterImage, thresholdNorm = 0.5): BinaryMask {
  const d = img.data;
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const t = thresholdNorm * 255;
  for (let i = 0, p = 3; i < n; i++, p += 4) out[i] = d[p] >= t ? 1 : 0;
  return { data: out, width: img.width, height: img.height };
}

/**
 * Two clear clusters. Requires (a) Otsu separability = between-class variance / total variance
 * >= 0.6 and (b) both classes compact: each class' standard deviation <= 0.25 x the distance
 * between the class means. (a) alone accepts a uniform ramp (separability 0.75) and even a single
 * Gaussian (0.64), hence (b). Degenerate histograms (empty, or a single value) -> false.
 */
export function isBimodal(hist: Float64Array): boolean {
  const { total, variance, betweenVarianceAt } = otsuState(hist);
  if (total === 0 || variance <= 0) return false;
  const t = otsu(hist);
  const between = betweenVarianceAt(t);
  if (between / variance < 0.6) return false;
  // Class statistics for the split at t.
  let w0 = 0;
  let s0 = 0;
  let w1 = 0;
  let s1 = 0;
  for (let i = 0; i < 256; i++) {
    if (i < t) {
      w0 += hist[i];
      s0 += hist[i] * i;
    } else {
      w1 += hist[i];
      s1 += hist[i] * i;
    }
  }
  if (w0 <= 0 || w1 <= 0) return false;
  const m0 = s0 / w0;
  const m1 = s1 / w1;
  let v0 = 0;
  let v1 = 0;
  for (let i = 0; i < 256; i++) {
    if (i < t) v0 += hist[i] * (i - m0) * (i - m0);
    else v1 += hist[i] * (i - m1) * (i - m1);
  }
  const sep = m1 - m0;
  const maxStd = Math.sqrt(Math.max(v0 / w0, v1 / w1));
  return maxStd <= 0.25 * sep;
}
