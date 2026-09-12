/**
 * Region fill models for gradient mode (phase 3): a flat colour, a linear or a radial gradient fitted on
 * the core pixels of each region of an edge-based segmentation, the ladder that picks one, and the
 * merge planner for over-segmented regions. Pure and deterministic; never mutates its inputs. It does
 * not import core/regions.ts (Segmentation lives in types.ts).
 *
 * Coordinates: pixel (x, y) is sampled at its centre (x + 0.5, y + 0.5), in the units of img/seg (the
 * convention of ARCHITECTURE.md "Reglas globales"); every fill returned is in those units. The RMSE that
 * decides a model is always the RMSE of what the fill paints, evaluated through core/fillEval.ts
 * (rmseOf): for a gradient, the stop ramp, not the plane that only gives its axis.
 *
 * Ramp fitting (fitLinear / fitRadial): the parameter s of every core pixel (projection on the axis, or
 * distance to the centre) is binned between its 0.5 and 99.5 percentiles into K = clamp(round(L/4), 8, 64)
 * bins; each bin gives a vertex (weighted mean s, weighted mean colour), empty bins are interpolated.
 * Douglas-Peucker, run greedily (the vertex with the largest error first, so a cap keeps the most
 * important ones), picks the stops whose colour is farther than eps = max(1.5, 0.8 sigma) levels (RMS over
 * R, G, B) from the chord, at most maxStops. The stop colours are then the weighted least-squares fit of
 * the piecewise-linear ramp on the pixels themselves (a tridiagonal system per channel), so the ends need
 * no extrapolation rule. Two IRLS passes follow: Tukey biweight on each pixel's RMS residual with
 * c = 4.685 * max(1.4826 * MAD, 1 level), re-binning with those weights, Douglas-Peucker and the stop fit
 * again. The reported RMSE is unweighted, over every core pixel.
 */
import type { Fill, Gradient, GradientStop, LinearGradient, RadialGradient, RasterImage, RegionModel, RGB, Segmentation } from '../types';
import { evaluateFill, isDegenerateGradient, normalizeStops, stopColorAt } from './fillEval';

// ---------------------------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------------------------

export const MOMENTS_PER_REGION = 16;
// Moments of region k live in m[16·k + i], over its core pixels (seg.core = 1 and region k), x and y = centres.
export const M_N = 0,
  M_X = 1,
  M_Y = 2,
  M_XX = 3,
  M_XY = 4,
  M_YY = 5,
  M_R = 6,
  M_G = 7,
  M_B = 8,
  M_RX = 9,
  M_GX = 10,
  M_BX = 11,
  M_RY = 12,
  M_GY = 13,
  M_BY = 14,
  M_CC = 15; // M_CC = Σ (R² + G² + B²)

// ---------------------------------------------------------------------------------------------
// Ladder and fitting constants (measurements in ARCHITECTURE.md "Decisiones de implementación")
// ---------------------------------------------------------------------------------------------

/** Regions with fewer core pixels are always solid. */
export const MIN_MODEL_CORE = 64;
/** Solid when rmseFlat <= max(FLAT_RMSE_FLOOR, FLAT_RMSE_SIGMA · sigma). */
export const FLAT_RMSE_FLOOR = 2;
export const FLAT_RMSE_SIGMA = 1.5;
/** A gradient is acceptable when its rmse <= max(GRADIENT_RMSE_FLOOR, GRADIENT_RMSE_SIGMA · sigma) ... */
export const GRADIENT_RMSE_FLOOR = 2.5;
export const GRADIENT_RMSE_SIGMA = 2;
/** ... and <= GRADIENT_MAX_FLAT_RATIO · rmseFlat. */
export const GRADIENT_MAX_FLAT_RATIO = 0.6;
/** A radial beats an existing linear fit only when rmseRad <= RADIAL_MAX_LINEAR_RATIO · rmseLin. */
export const RADIAL_MAX_LINEAR_RATIO = 0.85;
/** Douglas-Peucker tolerance max(STOP_EPS_FLOOR, STOP_EPS_SIGMA · sigma), levels RMS over R, G, B. */
export const STOP_EPS_FLOOR = 1.5;
export const STOP_EPS_SIGMA = 0.8;
/** Ramp extent: the RAMP_TRIM and 1 - RAMP_TRIM quantiles of the pixel parameter. */
export const RAMP_TRIM = 0.005;
/** Bins: K = clamp(round(L / BIN_LENGTH), MIN_BINS, MAX_BINS). */
export const BIN_LENGTH = 4;
export const MIN_BINS = 8;
export const MAX_BINS = 64;
/** IRLS passes after the unweighted fit, Tukey biweight constant, MAD → sigma and the scale floor (levels). */
export const IRLS_PASSES = 2;
export const TUKEY_C = 4.685;
export const MAD_TO_SIGMA = 1.4826;
export const TUKEY_MIN_SCALE = 1;
/** Radial centre: Gaussian pre-smoothing of the colour derivatives. */
export const RADIAL_SMOOTH_SIGMA = 0.7;
/** At most this many core pixels (evenly strided) feed the centre estimate. */
export const RADIAL_MAX_SAMPLES = 8192;
/** Fewer usable samples than this → no radial fit. */
export const RADIAL_MIN_SAMPLES = 16;
/** Samples whose colour gradient is weaker than this (levels/px) carry no direction. */
export const RADIAL_MIN_GRADIENT = 0.05;
/** The centre system Σ w (I − d dᵀ) is ill-conditioned below this eigenvalue ratio (parallel directions). */
export const RADIAL_MIN_CONDITION = 0.05;
/** r below this (px) → no radial fit. */
export const RADIAL_MIN_RADIUS = 2;
/** Monotonicity of the dominant channel along ρ: reversals up to RADIAL_MONOTONE_EPS_FACTOR · eps are noise. */
export const RADIAL_MONOTONE_EPS_FACTOR = 2;
/**
 * splitComplex: k-means (k = 2) iterations over (x, y, signed luma residual). 12 is where the belly of pajaro stops
 * moving pixels (measurements in ARCHITECTURE.md, "Degradados, división de regiones complejas").
 */
export const SPLIT_KMEANS_ITERATIONS = 12;
/** The split is kept only when the core-weighted RMSE of the parts is at most this ratio of the whole region's ... */
export const SPLIT_MAX_RMSE_RATIO = 0.8;
/** ... and at least this many levels below it. Both bounds: a clear relative AND absolute gain. */
export const SPLIT_MIN_RMSE_GAIN = 1.5;
/** Levels of k = 2 splits (a part still complex is split again), so at most 2^depth parts per region. */
export const SPLIT_MAX_DEPTH = 2;
/** planMerges defaults. */
export const MERGE_MIN_AREA_FLOOR = 16;
export const MERGE_MIN_AREA_SHARE = 2e-5;
export const MERGE_MAX_RMSE_GAIN = 1.5;
export const MERGE_MAX_BOUNDARY_JUMP = 3;
/** Two linear regions whose axes differ by more than this (degrees, undirected) never merge. */
export const MERGE_MAX_AXIS_DEG = 15;
/** Joint fits and boundary jumps use at most this many (evenly strided) pixels / boundary pairs. */
export const MERGE_MAX_JOINT_PIXELS = 32768;
export const MERGE_MAX_BOUNDARY_SAMPLES = 4096;
/**
 * A small group (under MIN_MODEL_CORE core pixels) whose boundary jump fails is only fitted jointly with its neighbour when
 * the neighbour's model, extrapolated past its end stops, misses the small group's core by at most this RMSE (levels), a
 * strong step (the Sobel floor): measured 0.31 for the cut tip of feather 5 against 114-168 for the other fragments of
 * gradientFeathers(256) and 177-179 for every candidate of the Compartamos avatar probe, whose joint fits (up to
 * MERGE_MAX_JOINT_PIXELS pixels each, repeated after every merge) took the probe from 36 to 2236 ms.
 */
export const MERGE_SMALL_MAX_OFFSET = 24;

/** Quantiles by sorting up to this many values, by a 65536-bucket histogram above. */
const SORT_LIMIT = 65536;
const QUANTILE_BUCKETS = 65536;
/** Residual histogram for the MAD: RESIDUAL_BUCKETS_PER_LEVEL buckets per level up to 256 levels. */
const RESIDUAL_BUCKETS_PER_LEVEL = 32;

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface RegionPixels {
  offsets: Int32Array;
  indices: Int32Array;
}

export interface FitOptions {
  sigma: number;
  maxStops: number;
}

export interface Plane {
  cx: number;
  cy: number;
  mean: RGB;
  gx: RGB;
  gy: RGB;
  rmse: number;
}

export interface MergeOptions {
  sigma: number;
  minArea: number;
  maxRmseGain: number;
  maxBoundaryJump: number;
  pixels?: RegionPixels;
  /** Compatible extension: stops and radial gradients the joint fits may use (defaults 8 and true), as in the pipeline's trace. */
  maxStops?: number;
  radial?: boolean;
  /**
   * Merge a small group (under MIN_MODEL_CORE core pixels) whose boundary jump fails when the joint model explains it (default
   * true). The classifier's probe turns it off: such fragments are solid and explained either way, and their joint fits
   * are most of the probe's merge time.
   */
  smallGroups?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Moments, core pixels, flat and plane
// ---------------------------------------------------------------------------------------------

function checkSameSize(img: RasterImage, seg: Segmentation, fn: string): void {
  const r = seg.regions;
  if (img.width !== r.width || img.height !== r.height || seg.core.width !== r.width || seg.core.height !== r.height) {
    throw new RangeError(`${fn}: imagen ${img.width}x${img.height}, regiones ${r.width}x${r.height}, núcleo ${seg.core.width}x${seg.core.height}`);
  }
}

/** Moments of every region over its core pixels, length 16·count, in one raster pass. */
export function accumulateMoments(img: RasterImage, seg: Segmentation): Float64Array {
  checkSameSize(img, seg, 'accumulateMoments');
  const W = seg.regions.width;
  const H = seg.regions.height;
  const count = seg.regions.count;
  const reg = seg.regions.data;
  const core = seg.core.data;
  const d = img.data;
  const m = new Float64Array(MOMENTS_PER_REGION * count);
  for (let y = 0; y < H; y++) {
    const yc = y + 0.5;
    for (let x = 0, i = y * W; x < W; x++, i++) {
      if (core[i] === 0) continue;
      const k = reg[i];
      if (k < 0) continue;
      if (k >= count) throw new RangeError(`accumulateMoments: región ${k} >= count ${count}`);
      const o = k * MOMENTS_PER_REGION;
      const xc = x + 0.5;
      const p = i * 4;
      const R = d[p];
      const G = d[p + 1];
      const B = d[p + 2];
      m[o] += 1;
      m[o + 1] += xc;
      m[o + 2] += yc;
      m[o + 3] += xc * xc;
      m[o + 4] += xc * yc;
      m[o + 5] += yc * yc;
      m[o + 6] += R;
      m[o + 7] += G;
      m[o + 8] += B;
      m[o + 9] += R * xc;
      m[o + 10] += G * xc;
      m[o + 11] += B * xc;
      m[o + 12] += R * yc;
      m[o + 13] += G * yc;
      m[o + 14] += B * yc;
      m[o + 15] += R * R + G * G + B * B;
    }
  }
  return m;
}

/** CSR of the core pixels per region: region k = indices[offsets[k] .. offsets[k+1]), raster order. */
export function corePixels(seg: Segmentation): RegionPixels {
  const count = seg.regions.count;
  const reg = seg.regions.data;
  const core = seg.core.data;
  const n = reg.length;
  const offsets = new Int32Array(count + 1);
  for (let i = 0; i < n; i++) {
    if (core[i] === 0) continue;
    const k = reg[i];
    if (k < 0) continue;
    if (k >= count) throw new RangeError(`corePixels: región ${k} >= count ${count}`);
    offsets[k + 1]++;
  }
  for (let k = 0; k < count; k++) offsets[k + 1] += offsets[k];
  const indices = new Int32Array(offsets[count]);
  const cursor = offsets.slice(0, count);
  for (let i = 0; i < n; i++) {
    if (core[i] === 0) continue;
    const k = reg[i];
    if (k < 0) continue;
    indices[cursor[k]++] = i;
  }
  return { offsets, indices };
}

/** Mean colour of the core of `id` and its pooled RMSE; n = 0 → black and 0. */
export function fitFlat(m: Float64Array, id: number): { color: RGB; rmse: number } {
  const o = id * MOMENTS_PER_REGION;
  const n = m[o + M_N];
  if (!(n > 0)) return { color: [0, 0, 0], rmse: 0 };
  const sr = m[o + M_R];
  const sg = m[o + M_G];
  const sb = m[o + M_B];
  const ss = m[o + M_CC] - (sr * sr + sg * sg + sb * sb) / n;
  return { color: [sr / n, sg / n, sb / n], rmse: Math.sqrt(Math.max(0, ss) / (3 * n)) };
}

/**
 * Least-squares plane per channel with centred coordinates: c ≈ mean + gx·(x − cx) + gy·(y − cy). A
 * collinear core (determinant ≈ 0) gives gx = gy = 0, i.e. the flat model.
 */
export function fitPlane(m: Float64Array, id: number): Plane {
  const o = id * MOMENTS_PER_REGION;
  const n = m[o + M_N];
  if (!(n > 0)) return { cx: 0, cy: 0, mean: [0, 0, 0], gx: [0, 0, 0], gy: [0, 0, 0], rmse: 0 };
  const sx = m[o + M_X];
  const sy = m[o + M_Y];
  const cx = sx / n;
  const cy = sy / n;
  const vxx = m[o + M_XX] - sx * cx;
  const vxy = m[o + M_XY] - sx * cy;
  const vyy = m[o + M_YY] - sy * cy;
  const det = vxx * vyy - vxy * vxy;
  // Relative test (1 − correlation² of x and y) plus an absolute variance floor: rounding in the sums
  // of a single column leaves vxx ≈ 1e-9, which must not pass for a spread.
  const singular = !(vxx > 1e-6 * n) || !(vyy > 1e-6 * n) || !(det > 1e-9 * vxx * vyy);
  const mean: RGB = [0, 0, 0];
  const gx: RGB = [0, 0, 0];
  const gy: RGB = [0, 0, 0];
  let explained = 0;
  let sumSq = 0;
  for (let c = 0; c < 3; c++) {
    const s = m[o + M_R + c];
    mean[c] = s / n;
    sumSq += (s * s) / n;
    if (singular) continue;
    const vcx = m[o + M_RX + c] - cx * s;
    const vcy = m[o + M_RY + c] - cy * s;
    gx[c] = (vyy * vcx - vxy * vcy) / det;
    gy[c] = (vxx * vcy - vxy * vcx) / det;
    explained += gx[c] * vcx + gy[c] * vcy;
  }
  const ss = m[o + M_CC] - sumSq - explained;
  return { cx, cy, mean, gx, gy, rmse: Math.sqrt(Math.max(0, ss) / (3 * n)) };
}

/**
 * Principal unit eigenvector of Σ_c g_c g_cᵀ, g_c = (gx_c, gy_c), not weighted by luma (hue-only ramps keep
 * their axis). strength = sqrt(λ1) (levels/px), collinearity = λ2/λ1 (0 when λ1 = 0); ux > 0, or ux = 0 and uy > 0.
 */
export function planeAxis(p: Plane): { ux: number; uy: number; strength: number; collinearity: number } {
  let a = 0;
  let b = 0;
  let c = 0;
  for (let k = 0; k < 3; k++) {
    a += p.gx[k] * p.gx[k];
    b += p.gx[k] * p.gy[k];
    c += p.gy[k] * p.gy[k];
  }
  const tr = a + c;
  const disc = Math.hypot(a - c, 2 * b);
  const l1 = (tr + disc) / 2;
  if (!(l1 > 0)) return { ux: 1, uy: 0, strength: 0, collinearity: 0 };
  const l2 = Math.max(0, (tr - disc) / 2);
  const theta = 0.5 * Math.atan2(2 * b, a - c);
  let ux = Math.cos(theta);
  let uy = Math.sin(theta);
  if (ux < 0 || (ux === 0 && uy < 0)) {
    ux = -ux;
    uy = -uy;
  }
  if (ux === 0) ux = 0; // no -0
  return { ux, uy, strength: Math.sqrt(l1), collinearity: l2 / l1 };
}

/** Pooled RMSE (levels, over R, G, B) of `fill`, evaluated with fillEval at each core pixel centre of `id`. */
export function rmseOf(img: RasterImage, px: RegionPixels, id: number, fill: Fill): number {
  const start = px.offsets[id];
  const end = px.offsets[id + 1];
  const n = end - start;
  if (n <= 0) return 0;
  const W = img.width;
  const d = img.data;
  const idx = px.indices;
  const c: RGB = [0, 0, 0];
  let ss = 0;
  for (let i = start; i < end; i++) {
    const p = idx[i];
    const x = p % W;
    const y = (p - x) / W;
    evaluateFill(fill, x + 0.5, y + 0.5, c);
    const o = p * 4;
    const dr = d[o] - c[0];
    const dg = d[o + 1] - c[1];
    const db = d[o + 2] - c[2];
    ss += dr * dr + dg * dg + db * db;
  }
  return Math.sqrt(ss / (3 * n));
}

// ---------------------------------------------------------------------------------------------
// Ramp fitting shared by the linear and radial models
// ---------------------------------------------------------------------------------------------

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp255(v: number): number {
  return v > 0 ? (v < 255 ? v : 255) : 0;
}

function sanitizeSigma(sigma: number): number {
  return Number.isFinite(sigma) && sigma > 0 ? sigma : 0;
}

function stopLimit(maxStops: number): number {
  if (!Number.isFinite(maxStops)) return 8;
  return clampInt(Math.floor(maxStops), 2, MAX_BINS);
}

/** Quantile of sorted values with linear interpolation between ranks (q·(n−1)). */
function sortedQuantile(s: Float64Array, q: number): number {
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** [qLo, qHi] quantiles of v: exact by sorting a copy for small inputs, 65536-bucket histogram otherwise. */
function quantilePair(v: Float64Array, qLo: number, qHi: number): [number, number] {
  const n = v.length;
  if (n <= SORT_LIMIT) {
    const s = Float64Array.from(v).sort();
    return [sortedQuantile(s, qLo), sortedQuantile(s, qHi)];
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (!(max > min)) return [min, max];
  const counts = new Uint32Array(QUANTILE_BUCKETS);
  const scale = QUANTILE_BUCKETS / (max - min);
  for (let i = 0; i < n; i++) {
    let b = Math.floor((v[i] - min) * scale);
    if (b >= QUANTILE_BUCKETS) b = QUANTILE_BUCKETS - 1;
    counts[b]++;
  }
  const at = (q: number): number => {
    const target = q * (n - 1);
    let cum = 0;
    for (let b = 0; b < QUANTILE_BUCKETS; b++) {
      const c = counts[b];
      if (c > 0 && cum + c > target) return min + (b + (target - cum + 0.5) / c) / scale;
      cum += c;
    }
    return max;
  };
  return [at(qLo), at(qHi)];
}

interface BinPolyline {
  /** Vertex parameter per bin (weighted mean s; bin centre for an empty bin). */
  vt: Float64Array;
  /** Vertex colour per bin, 3 per bin (weighted mean; interpolated for an empty bin). */
  vc: Float64Array;
  /** Bin weight (0 = empty). */
  bw: Float64Array;
  /** First and last non-empty bins; -1 when all are empty. */
  first: number;
  last: number;
}

/**
 * Weighted sufficient statistics of the ramp parameter on M = K·MICRO_PER_BIN equal micro-bins of
 * [sLo, sHi], kept as prefix sums over the micro-bin index b (so the normal equations of any knot set on
 * the micro-bin edges cost O(knots)): Σw, Σw·b, Σw·b², Σw·τ, Σw·τ·b, Σw·τ², Σw·c, Σw·c·b, Σw·τ·c, with
 * τ = clamped parameter − left edge of its micro-bin (small, so the quadratic sums do not cancel); plus
 * Σw·|c|² and Σw overall. The parameter is clamped to [origin, sHi] as the fill evaluation clamps it;
 * pixels below sLo or above sHi fall in the end micro-bins.
 */
interface MicroStats {
  M: number;
  sLo: number;
  width: number;
  origin: number;
  /** Prefix sums, length M + 1 (colour ones 3·(M + 1)): P[b] = Σ over micro-bins < b. */
  P0: Float64Array;
  P0b: Float64Array;
  P0bb: Float64Array;
  P1: Float64Array;
  P1b: Float64Array;
  P2: Float64Array;
  Pc0: Float64Array;
  Pc0b: Float64Array;
  Pc1: Float64Array;
  cc: number;
  totalW: number;
  /** Bin-polyline colour at each micro-bin edge (3·(M + 1)) and at the origin, for the ridge; filled by attachPrior. */
  priorEdges: Float64Array | null;
  priorOrigin: Float64Array | null;
}

/** Micro-bins per Douglas-Peucker bin: knots move on a grid 1/MICRO_PER_BIN of a bin. */
export const MICRO_PER_BIN = 16;
/** An interior stop whose removal (after re-placing its neighbours) raises the weighted ramp RMSE by at most this many levels is dropped. */
export const PRUNE_MAX_RMSE_LOSS = 0.05;
/**
 * Flat end segments (flatEnds): the end stop is dropped when it differs from its neighbour by at most this many times
 * eps = max(STOP_EPS_FLOOR, STOP_EPS_SIGMA·σ) in every channel (3 levels on a clean image). The least-squares colour of
 * a short flat end wanders more than eps: a radial ramp flat for its first 12 px of 40 fitted its two inner stops 1.67
 * levels apart.
 */
export const FLAT_END_TOL_FACTOR = 2;

function microStats(
  d: Uint8ClampedArray,
  idx: Int32Array,
  start: number,
  s: Float64Array,
  w: Float32Array | null,
  sLo: number,
  sHi: number,
  origin: number,
  M: number,
): MicroStats {
  const n = s.length;
  const width = (sHi - sLo) / M;
  const inv = 1 / width;
  const w0 = new Float64Array(M);
  const w1 = new Float64Array(M);
  const w2 = new Float64Array(M);
  const c0 = new Float64Array(3 * M);
  const c1 = new Float64Array(3 * M);
  let cc = 0;
  let totalW = 0;
  for (let i = 0; i < n; i++) {
    const wi = w === null ? 1 : w[i];
    if (wi === 0) continue;
    const si = s[i];
    let b = Math.floor((si - sLo) * inv);
    if (b < 0) b = 0;
    else if (b >= M) b = M - 1;
    const tc = si < origin ? origin : si > sHi ? sHi : si;
    const tau = tc - (sLo + b * width);
    const o = idx[start + i] * 4;
    const R = d[o];
    const G = d[o + 1];
    const B = d[o + 2];
    const wt = wi * tau;
    w0[b] += wi;
    w1[b] += wt;
    w2[b] += wt * tau;
    c0[3 * b] += wi * R;
    c0[3 * b + 1] += wi * G;
    c0[3 * b + 2] += wi * B;
    c1[3 * b] += wt * R;
    c1[3 * b + 1] += wt * G;
    c1[3 * b + 2] += wt * B;
    cc += wi * (R * R + G * G + B * B);
    totalW += wi;
  }
  const P0 = new Float64Array(M + 1);
  const P0b = new Float64Array(M + 1);
  const P0bb = new Float64Array(M + 1);
  const P1 = new Float64Array(M + 1);
  const P1b = new Float64Array(M + 1);
  const P2 = new Float64Array(M + 1);
  const Pc0 = new Float64Array(3 * (M + 1));
  const Pc0b = new Float64Array(3 * (M + 1));
  const Pc1 = new Float64Array(3 * (M + 1));
  for (let b = 0; b < M; b++) {
    P0[b + 1] = P0[b] + w0[b];
    P0b[b + 1] = P0b[b] + w0[b] * b;
    P0bb[b + 1] = P0bb[b] + w0[b] * b * b;
    P1[b + 1] = P1[b] + w1[b];
    P1b[b + 1] = P1b[b] + w1[b] * b;
    P2[b + 1] = P2[b] + w2[b];
    for (let ch = 0; ch < 3; ch++) {
      Pc0[3 * (b + 1) + ch] = Pc0[3 * b + ch] + c0[3 * b + ch];
      Pc0b[3 * (b + 1) + ch] = Pc0b[3 * b + ch] + c0[3 * b + ch] * b;
      Pc1[3 * (b + 1) + ch] = Pc1[3 * b + ch] + c1[3 * b + ch];
    }
  }
  return { M, sLo, width, origin, P0, P0b, P0bb, P1, P1b, P2, Pc0, Pc0b, Pc1, cc, totalW, priorEdges: null, priorOrigin: null };
}

/** Douglas-Peucker bins (MICRO_PER_BIN micro-bins each): weighted mean parameter and colour; empty bins interpolated. */
function binsFromMicro(st: MicroStats, K: number): BinPolyline {
  const bw = new Float64Array(K);
  const vt = new Float64Array(K);
  const vc = new Float64Array(3 * K);
  const binWidth = st.width * MICRO_PER_BIN;
  let first = -1;
  let last = -1;
  for (let k = 0; k < K; k++) {
    const b0 = k * MICRO_PER_BIN;
    const b1 = b0 + MICRO_PER_BIN;
    const w = st.P0[b1] - st.P0[b0];
    if (w > 0) {
      bw[k] = w;
      // Σ w·(edge + τ) = sLo·Σw + width·Σw·b + Σw·τ
      vt[k] = (st.sLo * w + st.width * (st.P0b[b1] - st.P0b[b0]) + (st.P1[b1] - st.P1[b0])) / w;
      for (let ch = 0; ch < 3; ch++) vc[3 * k + ch] = (st.Pc0[3 * b1 + ch] - st.Pc0[3 * b0 + ch]) / w;
      if (first < 0) first = k;
      last = k;
    } else {
      vt[k] = st.sLo + (k + 0.5) * binWidth;
    }
  }
  if (first < 0) return { vt, vc, bw, first, last };
  let prev = first;
  for (let k = 0; k < K; k++) {
    if (bw[k] > 0) {
      prev = k;
      continue;
    }
    if (k < first || k > last) {
      const src = k < first ? first : last;
      vc[3 * k] = vc[3 * src];
      vc[3 * k + 1] = vc[3 * src + 1];
      vc[3 * k + 2] = vc[3 * src + 2];
      continue;
    }
    let next = k + 1;
    while (bw[next] === 0) next++;
    const span = vt[next] - vt[prev];
    const u = span > 0 ? (vt[k] - vt[prev]) / span : 0.5;
    for (let ch = 0; ch < 3; ch++) vc[3 * k + ch] = vc[3 * prev + ch] + (vc[3 * next + ch] - vc[3 * prev + ch]) * u;
  }
  return { vt, vc, bw, first, last };
}

/**
 * Greedy Douglas-Peucker on the bin polyline: starting from the two end vertices, insert the vertex with
 * the largest RMS colour distance to its chord while it exceeds eps and there are fewer than maxStops.
 */
function douglasPeucker(vt: Float64Array, vc: Float64Array, K: number, eps: number, maxStops: number): number[] {
  const sel = [0, K - 1];
  while (sel.length < maxStops) {
    let best = -1;
    let bestSeg = -1;
    let bestDev = eps;
    for (let s = 0; s + 1 < sel.length; s++) {
      const a = sel[s];
      const b = sel[s + 1];
      const span = vt[b] - vt[a];
      for (let v = a + 1; v < b; v++) {
        const u = span > 0 ? (vt[v] - vt[a]) / span : 0.5;
        let d2 = 0;
        for (let ch = 0; ch < 3; ch++) {
          const ca = vc[3 * a + ch];
          const e = vc[3 * v + ch] - (ca + (vc[3 * b + ch] - ca) * u);
          d2 += e * e;
        }
        const dev = Math.sqrt(d2 / 3);
        if (dev > bestDev) {
          bestDev = dev;
          best = v;
          bestSeg = s;
        }
      }
    }
    if (best < 0) break;
    sel.splice(bestSeg + 1, 0, best);
  }
  return sel;
}

/** Colour of the bin polyline at s (end vertices held constant outside), written to out[o..o+2]. */
function polylineAt(poly: BinPolyline, K: number, s: number, out: Float64Array, o: number): void {
  const { vt, vc } = poly;
  let k = 0;
  if (s <= vt[0]) k = -1;
  else if (s >= vt[K - 1]) k = K - 1;
  else while (k + 1 < K && vt[k + 1] <= s) k++;
  if (k < 0 || k >= K - 1) {
    const src = k < 0 ? 0 : K - 1;
    for (let ch = 0; ch < 3; ch++) out[o + ch] = vc[3 * src + ch];
    return;
  }
  const span = vt[k + 1] - vt[k];
  const u = span > 0 ? (s - vt[k]) / span : 0;
  for (let ch = 0; ch < 3; ch++) out[o + ch] = vc[3 * k + ch] + (vc[3 * (k + 1) + ch] - vc[3 * k + ch]) * u;
}

/** Tabulates the bin-polyline colour at every micro-bin edge and at the origin (the ridge prior of rampFit). */
function attachPrior(st: MicroStats, poly: BinPolyline, K: number): void {
  const edges = new Float64Array(3 * (st.M + 1));
  for (let e = 0; e <= st.M; e++) polylineAt(poly, K, st.sLo + e * st.width, edges, 3 * e);
  const origin = new Float64Array(3);
  polylineAt(poly, K, st.origin, origin, 0);
  st.priorEdges = edges;
  st.priorOrigin = origin;
}

interface RampResult {
  knots: Float64Array;
  /** 3 per knot, clamped to [0, 255]. */
  colors: Float64Array;
}

interface RampFit extends RampResult {
  /** Weighted sum of squared errors over the three channels. */
  sse: number;
}

/**
 * Weighted least-squares colours of the piecewise-linear ramp whose interior knots sit on the micro-bin
 * edges `edges` (strictly increasing, in 1..M−1), first knot st.origin and last sHi, from the prefix sums
 * alone in O(knots) (hat basis, tridiagonal normal equations, a tiny ridge towards the bin polyline so a
 * knot without support stays defined), and its exact weighted SSE with the clamped colours.
 */
function rampFit(st: MicroStats, edges: readonly number[]): RampFit {
  const m = edges.length + 2;
  const h = st.width;
  const knots = new Float64Array(m);
  knots[0] = st.origin;
  for (let q = 0; q < edges.length; q++) knots[q + 1] = st.sLo + edges[q] * h;
  knots[m - 1] = st.sLo + st.M * h;
  const D = new Float64Array(m);
  const E = new Float64Array(m);
  const R = new Float64Array(3 * m);
  for (let j = 0; j < m - 1; j++) {
    const bs = j === 0 ? 0 : edges[j - 1];
    const be = j === m - 2 ? st.M : edges[j];
    const S0 = st.P0[be] - st.P0[bs];
    if (!(S0 > 0)) continue;
    // Sums over the segment in the local micro index b' = b − bs.
    const Sb = st.P0b[be] - st.P0b[bs] - bs * S0;
    const Sbb = st.P0bb[be] - st.P0bb[bs] - 2 * bs * (st.P0b[be] - st.P0b[bs]) + bs * bs * S0;
    const S1 = st.P1[be] - st.P1[bs];
    const S1b = st.P1b[be] - st.P1b[bs] - bs * S1;
    const S2 = st.P2[be] - st.P2[bs];
    const es = st.sLo + bs * h;
    const left = knots[j];
    const right = knots[j + 1];
    const delta = right - left;
    const A0 = right - es; // a = A0 − h·b'
    const B0 = es - left; // bo = B0 + h·b'
    const inv2 = 1 / (delta * delta);
    D[j] += (A0 * A0 * S0 - 2 * A0 * h * Sb + h * h * Sbb - 2 * A0 * S1 + 2 * h * S1b + S2) * inv2;
    D[j + 1] += (B0 * B0 * S0 + 2 * B0 * h * Sb + h * h * Sbb + 2 * B0 * S1 + 2 * h * S1b + S2) * inv2;
    E[j] += (A0 * B0 * S0 + (A0 - B0) * h * Sb - h * h * Sbb + (A0 - B0) * S1 - 2 * h * S1b - S2) * inv2;
    for (let ch = 0; ch < 3; ch++) {
      const Sc0 = st.Pc0[3 * be + ch] - st.Pc0[3 * bs + ch];
      const Sc0b = st.Pc0b[3 * be + ch] - st.Pc0b[3 * bs + ch] - bs * Sc0;
      const Sc1 = st.Pc1[3 * be + ch] - st.Pc1[3 * bs + ch];
      R[3 * j + ch] += (A0 * Sc0 - h * Sc0b - Sc1) / delta;
      R[3 * (j + 1) + ch] += (B0 * Sc0 + h * Sc0b + Sc1) / delta;
    }
  }
  const lambda = 1e-6 * (st.totalW / m) + 1e-9;
  const pe = st.priorEdges as Float64Array;
  const po = st.priorOrigin as Float64Array;
  const priorAt = (q: number, ch: number): number => {
    if (q === 0) return po[ch];
    const e = q === m - 1 ? st.M : edges[q - 1];
    return pe[3 * e + ch];
  };
  // Thomas algorithm on the symmetric tridiagonal (D + λ, E), same matrix for the three channels.
  const cp = new Float64Array(m);
  const dp = new Float64Array(3 * m);
  let denom = D[0] + lambda;
  cp[0] = E[0] / denom;
  for (let ch = 0; ch < 3; ch++) dp[ch] = (R[ch] + lambda * priorAt(0, ch)) / denom;
  for (let q = 1; q < m; q++) {
    denom = D[q] + lambda - E[q - 1] * cp[q - 1];
    cp[q] = q < m - 1 ? E[q] / denom : 0;
    for (let ch = 0; ch < 3; ch++) {
      dp[3 * q + ch] = (R[3 * q + ch] + lambda * priorAt(q, ch) - E[q - 1] * dp[3 * (q - 1) + ch]) / denom;
    }
  }
  const colors = new Float64Array(3 * m);
  for (let ch = 0; ch < 3; ch++) colors[3 * (m - 1) + ch] = dp[3 * (m - 1) + ch];
  for (let q = m - 2; q >= 0; q--) {
    for (let ch = 0; ch < 3; ch++) colors[3 * q + ch] = dp[3 * q + ch] - cp[q] * colors[3 * (q + 1) + ch];
  }
  for (let i = 0; i < colors.length; i++) colors[i] = clamp255(colors[i]);
  let sse = st.cc;
  for (let q = 0; q < m; q++) {
    for (let ch = 0; ch < 3; ch++) {
      const c = colors[3 * q + ch];
      sse += -2 * c * R[3 * q + ch] + D[q] * c * c;
      if (q < m - 1) sse += 2 * E[q] * c * colors[3 * (q + 1) + ch];
    }
  }
  return { knots, colors, sse: Math.max(0, sse) };
}

/**
 * Places the interior knots (micro-bin edges) by coordinate descent, each scanned over every edge between
 * its neighbours, then drops the interior knot whose removal (with its two neighbours re-placed) costs the
 * least weighted RMSE while that cost is at most PRUNE_MAX_RMSE_LOSS. Two knots straddling one corner
 * collapse into one on the corner; a knot fitted to noise disappears.
 */
function refineAndPrune(st: MicroStats, edges: number[]): number[] {
  const tol = (v: number): number => 1e-9 * Math.max(1, v);
  /** Re-places knots `which` (indices into cur) in turn, repeating the sweep while any moves; returns the SSE. */
  const place = (cur: number[], which: readonly number[], sweeps: number): number => {
    let best = rampFit(st, cur).sse;
    for (let sweep = 0; sweep < sweeps; sweep++) {
      let moved = false;
      for (const q of which) {
        if (q < 0 || q >= cur.length) continue;
        const lo = q === 0 ? 1 : cur[q - 1] + 1;
        const hi = q === cur.length - 1 ? st.M - 1 : cur[q + 1] - 1;
        const keep = cur[q];
        let bestE = keep;
        for (let e = lo; e <= hi; e++) {
          if (e === keep) continue;
          cur[q] = e;
          const sse = rampFit(st, cur).sse;
          if (sse < best - tol(best)) {
            best = sse;
            bestE = e;
          }
        }
        cur[q] = bestE;
        if (bestE !== keep) moved = true;
      }
      if (!moved) break;
    }
    return best;
  };
  const all = (cur: number[]): number[] => cur.map((_, q) => q);
  let cur = edges.slice();
  let best = place(cur, all(cur), 8);
  const rms = (sse: number): number => Math.sqrt(sse / (3 * st.totalW));
  while (cur.length > 0) {
    let bestTrial: number[] | null = null;
    let bestSse = Infinity;
    for (let q = 0; q < cur.length; q++) {
      const trial = cur.slice(0, q).concat(cur.slice(q + 1));
      const sse = place(trial, [q - 1, q], 2);
      if (sse < bestSse) {
        bestSse = sse;
        bestTrial = trial;
      }
    }
    if (bestTrial === null || rms(bestSse) - rms(best) > PRUNE_MAX_RMSE_LOSS) break;
    cur = bestTrial;
    best = place(cur, all(cur), 8);
  }
  return cur;
}

/**
 * Stops of the ramp of parameter s (one value per core pixel of idx[start..]) between sLo and sHi; the
 * first knot is `origin` (sLo, or 0 for a radial whose centre is inside), the last sHi.
 */
function fitRamp(
  d: Uint8ClampedArray,
  idx: Int32Array,
  start: number,
  s: Float64Array,
  sLo: number,
  sHi: number,
  origin: number,
  opts: FitOptions,
): RampResult {
  const n = s.length;
  const L = sHi - sLo;
  const K = clampInt(Math.round(L / BIN_LENGTH), MIN_BINS, MAX_BINS);
  const M = K * MICRO_PER_BIN;
  const sigma = sanitizeSigma(opts.sigma);
  const eps = Math.max(STOP_EPS_FLOOR, STOP_EPS_SIGMA * sigma);
  const maxStops = stopLimit(opts.maxStops);
  const w = new Float32Array(n).fill(1);
  let result: RampResult | null = null;
  const hist = new Uint32Array(256 * RESIDUAL_BUCKETS_PER_LEVEL);
  for (let pass = 0; pass <= IRLS_PASSES; pass++) {
    const st = microStats(d, idx, start, s, pass === 0 ? null : w, sLo, sHi, origin, M);
    if (!(st.totalW > 0)) break; // every weight 0: keep the previous fit
    const poly = binsFromMicro(st, K);
    attachPrior(st, poly, K);
    const sel = douglasPeucker(poly.vt, poly.vc, K, eps, maxStops);
    const edges: number[] = [];
    for (let q = 1; q + 1 < sel.length; q++) {
      const e = clampInt(Math.round((poly.vt[sel[q]] - sLo) / st.width), 1, M - 1);
      if (edges.length === 0 || e > edges[edges.length - 1]) edges.push(e);
    }
    const fit = rampFit(st, refineAndPrune(st, edges));
    result = { knots: fit.knots, colors: fit.colors };
    if (pass === IRLS_PASSES) break;
    // Tukey biweight on each pixel's RMS residual against this ramp.
    const { knots, colors } = fit;
    hist.fill(0);
    const res = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const { j, u } = locate(knots, s[i]);
      const o = idx[start + i] * 4;
      let e2 = 0;
      for (let ch = 0; ch < 3; ch++) {
        const pred = colors[3 * j + ch] + (colors[3 * (j + 1) + ch] - colors[3 * j + ch]) * u;
        const e = d[o + ch] - pred;
        e2 += e * e;
      }
      const r = Math.sqrt(e2 / 3);
      res[i] = r;
      let b = Math.floor(r * RESIDUAL_BUCKETS_PER_LEVEL);
      if (b >= hist.length) b = hist.length - 1;
      hist[b]++;
    }
    const half = (n - 1) / 2;
    let cum = 0;
    let mad = 0;
    for (let b = 0; b < hist.length; b++) {
      cum += hist[b];
      if (cum > half) {
        mad = (b + 0.5) / RESIDUAL_BUCKETS_PER_LEVEL;
        break;
      }
    }
    const c = TUKEY_C * Math.max(MAD_TO_SIGMA * mad, TUKEY_MIN_SCALE);
    for (let i = 0; i < n; i++) {
      const q = res[i] / c;
      w[i] = q < 1 ? (1 - q * q) * (1 - q * q) : 0;
    }
  }
  return result as RampResult; // pass 0 always has pixels
}

/** Segment j (knots[j] <= s <= knots[j+1]) and position u of s clamped to the knot range. */
function locate(knots: Float64Array, s: number): { j: number; u: number } {
  const m = knots.length;
  let t = s;
  if (!(t > knots[0])) t = knots[0];
  else if (t > knots[m - 1]) t = knots[m - 1];
  let j = 0;
  while (j < m - 2 && t > knots[j + 1]) j++;
  const span = knots[j + 1] - knots[j];
  return { j, u: span > 0 ? (t - knots[j]) / span : 0 };
}

/**
 * Index range [first, last] of the stops left once flat end segments are dropped: while more than two stops remain and
 * the first two (or the last two) differ by at most `tol` levels in every channel, the end one goes. Pad already paints
 * a flat end with that colour, so the gradient only needs its end points moved to the kept stops: a two-colour ramp
 * whose shape is flat past its ends keeps 2 stops (pajaro: 6 of 19 gradients came out with 3 or 4).
 */
function flatEnds(stops: readonly GradientStop[], tol: number): { first: number; last: number } {
  const close = (a: GradientStop, b: GradientStop): boolean =>
    Math.abs(a.color[0] - b.color[0]) <= tol && Math.abs(a.color[1] - b.color[1]) <= tol && Math.abs(a.color[2] - b.color[2]) <= tol;
  let first = 0;
  let last = stops.length - 1;
  while (last - first + 1 > 2 && close(stops[first], stops[first + 1])) first++;
  while (last - first + 1 > 2 && close(stops[last], stops[last - 1])) last--;
  return { first, last };
}

function rampStops(ramp: RampResult, span: number, origin: number): { offset: number; color: RGB }[] {
  const out: { offset: number; color: RGB }[] = [];
  for (let j = 0; j < ramp.knots.length; j++) {
    out.push({
      offset: span > 0 ? (ramp.knots[j] - origin) / span : 0,
      color: [ramp.colors[3 * j], ramp.colors[3 * j + 1], ramp.colors[3 * j + 2]],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Linear and radial models
// ---------------------------------------------------------------------------------------------

/**
 * Linear gradient along planeAxis(plane): t = projection of the core pixel centres on the axis through
 * the centroid; (x1, y1) and (x2, y2) at its 0.5 and 99.5 percentiles; stops by fitRamp. rmse = rmseOf of
 * the gradient (the stop ramp). null when the plane has no gradient or the extent is under 1 px.
 */
export function fitLinear(
  img: RasterImage,
  px: RegionPixels,
  id: number,
  plane: Plane,
  opts: FitOptions,
): { fill: LinearGradient; rmse: number } | null {
  const axis = planeAxis(plane);
  if (!(axis.strength > 0)) return null;
  const start = px.offsets[id];
  const n = px.offsets[id + 1] - start;
  if (n <= 0) return null;
  const W = img.width;
  const idx = px.indices;
  const { ux, uy } = axis;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = idx[start + i];
    const x = p % W;
    const y = (p - x) / W;
    t[i] = (x + 0.5 - plane.cx) * ux + (y + 0.5 - plane.cy) * uy;
  }
  const [tLo, tHi] = quantilePair(t, RAMP_TRIM, 1 - RAMP_TRIM);
  if (!(tHi - tLo >= 1)) return null;
  const ramp = fitRamp(img.data, idx, start, t, tLo, tHi, tLo, opts);
  const all = normalizeStops(rampStops(ramp, tHi - tLo, tLo));
  const { first, last } = flatEnds(all, FLAT_END_TOL_FACTOR * Math.max(STOP_EPS_FLOOR, STOP_EPS_SIGMA * sanitizeSigma(opts.sigma)));
  const oA = all[first].offset;
  const oB = all[last].offset;
  const a = tLo + (tHi - tLo) * oA;
  const b = tLo + (tHi - tLo) * oB;
  const fill: LinearGradient = {
    kind: 'linear',
    x1: plane.cx + a * ux,
    y1: plane.cy + a * uy,
    x2: plane.cx + b * ux,
    y2: plane.cy + b * uy,
    stops: normalizeStops(all.slice(first, last + 1).map((s) => ({ offset: oB > oA ? (s.offset - oA) / (oB - oA) : s.offset, color: s.color }))),
  };
  return { fill, rmse: rmseOf(img, px, id, fill) };
}

/** 1-D Gaussian of RADIAL_SMOOTH_SIGMA (radius 3) and its central difference (radius 4), 9 taps each, centred at 4. */
function derivativeKernels(): { KX: Float64Array; KY: Float64Array } {
  const sigma = RADIAL_SMOOTH_SIGMA;
  const r = Math.ceil(3 * sigma);
  const g = new Float64Array(9);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    g[i + 4] = v;
    sum += v;
  }
  for (let i = 0; i < 9; i++) g[i] /= sum;
  const dd = new Float64Array(9);
  for (let i = -4; i <= 4; i++) {
    const before = i - 1 >= -4 ? g[i - 1 + 4] : 0;
    const after = i + 1 <= 4 ? g[i + 1 + 4] : 0;
    dd[i + 4] = (before - after) / 2; // ∂/∂x of (G ∗ I) by central difference: (S(x+1) − S(x−1)) / 2
  }
  const KX = new Float64Array(81);
  const KY = new Float64Array(81);
  for (let j = 0; j < 9; j++) {
    for (let i = 0; i < 9; i++) {
      KX[j * 9 + i] = dd[i] * g[j];
      KY[j * 9 + i] = g[i] * dd[j];
    }
  }
  return { KX, KY };
}

let kernelCache: { KX: Float64Array; KY: Float64Array } | null = null;

/**
 * Radial gradient: centre = weighted least-squares intersection of the lines through core pixels along
 * their colour-gradient direction (dominant eigenvector of JᵀJ, J = 3×2 Jacobian of R, G, B by central
 * differences of a σ 0.7 Gaussian, only where that 9×9 support is core of the region; a 3×3 unsmoothed
 * fallback for thin regions), weight = gradient magnitude; r = p99.5 of ρ; stops by fitRamp along ρ.
 * null when there are too few samples, the system is ill-conditioned (parallel directions: a linear
 * ramp), r < 2 px, or the bin means along ρ are not monotone in their dominant channel.
 */
export function fitRadial(
  img: RasterImage,
  px: RegionPixels,
  id: number,
  opts: FitOptions & { support?: (pixel: number) => boolean },
): { fill: RadialGradient; rmse: number } | null {
  const start = px.offsets[id];
  const n = px.offsets[id + 1] - start;
  if (n < RADIAL_MIN_SAMPLES) return null;
  const W = img.width;
  const H = img.height;
  const d = img.data;
  const idx = px.indices;
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < n; i++) {
    const p = idx[start + i];
    const x = p % W;
    const y = (p - x) / W;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const member = new Uint8Array(bw * bh);
  for (let i = 0; i < n; i++) {
    const p = idx[start + i];
    const x = p % W;
    const y = (p - x) / W;
    member[(y - minY) * bw + (x - minX)] = 1;
  }
  const support = opts.support;
  const isMember =
    support === undefined
      ? (x: number, y: number): boolean => x >= minX && x <= maxX && y >= minY && y <= maxY && member[(y - minY) * bw + (x - minX)] === 1
      : (x: number, y: number): boolean => x >= 0 && x < W && y >= 0 && y < H && support(y * W + x);
  if (kernelCache === null) kernelCache = derivativeKernels();
  const { KX, KY } = kernelCache;
  const stride = Math.max(1, Math.ceil(n / RADIAL_MAX_SAMPLES));

  const solveCentre = (smoothed: boolean): { cx: number; cy: number; samples: number; condition: number } => {
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let b1 = 0;
    let b2 = 0;
    let samples = 0;
    const jx = [0, 0, 0];
    const jy = [0, 0, 0];
    for (let i = 0; i < n; i += stride) {
      const p = idx[start + i];
      const x = p % W;
      const y = (p - x) / W;
      if (smoothed) {
        let inside = true;
        for (let dy = -4; dy <= 4 && inside; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            if (!isMember(x + dx, y + dy)) {
              inside = false;
              break;
            }
          }
        }
        if (!inside) continue;
        for (let ch = 0; ch < 3; ch++) {
          let sx = 0;
          let sy = 0;
          for (let dy = -4; dy <= 4; dy++) {
            const row = (p + dy * W) * 4 + ch;
            const kr = (dy + 4) * 9;
            for (let dx = -4; dx <= 4; dx++) {
              const v = d[row + dx * 4];
              sx += KX[kr + dx + 4] * v;
              sy += KY[kr + dx + 4] * v;
            }
          }
          jx[ch] = sx;
          jy[ch] = sy;
        }
      } else {
        if (!isMember(x - 1, y) || !isMember(x + 1, y) || !isMember(x, y - 1) || !isMember(x, y + 1)) continue;
        const o = p * 4;
        for (let ch = 0; ch < 3; ch++) {
          jx[ch] = (d[o + 4 + ch] - d[o - 4 + ch]) / 2;
          jy[ch] = (d[o + 4 * W + ch] - d[o - 4 * W + ch]) / 2;
        }
      }
      let txx = 0;
      let txy = 0;
      let tyy = 0;
      for (let ch = 0; ch < 3; ch++) {
        txx += jx[ch] * jx[ch];
        txy += jx[ch] * jy[ch];
        tyy += jy[ch] * jy[ch];
      }
      const l1 = (txx + tyy + Math.hypot(txx - tyy, 2 * txy)) / 2;
      const mag = Math.sqrt(l1);
      if (!(mag >= RADIAL_MIN_GRADIENT)) continue;
      const theta = 0.5 * Math.atan2(2 * txy, txx - tyy);
      const nx = -Math.sin(theta); // normal of the line along the gradient direction (cos θ, sin θ)
      const ny = Math.cos(theta);
      const pxc = x + 0.5;
      const pyc = y + 0.5;
      const proj = nx * pxc + ny * pyc;
      a11 += mag * nx * nx;
      a12 += mag * nx * ny;
      a22 += mag * ny * ny;
      b1 += mag * nx * proj;
      b2 += mag * ny * proj;
      samples++;
    }
    const tr = a11 + a22;
    const disc = Math.hypot(a11 - a22, 2 * a12);
    const lmax = (tr + disc) / 2;
    const lmin = (tr - disc) / 2;
    const condition = lmax > 0 ? lmin / lmax : 0;
    const det = a11 * a22 - a12 * a12;
    return { cx: (a22 * b1 - a12 * b2) / det, cy: (a11 * b2 - a12 * b1) / det, samples, condition };
  };

  let centre = solveCentre(true);
  if (centre.samples < RADIAL_MIN_SAMPLES) centre = solveCentre(false);
  if (centre.samples < RADIAL_MIN_SAMPLES || !(centre.condition >= RADIAL_MIN_CONDITION)) return null;
  const { cx, cy } = centre;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;

  const rho = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = idx[start + i];
    const x = p % W;
    const y = (p - x) / W;
    rho[i] = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  }
  const [rLo, r] = quantilePair(rho, RAMP_TRIM, 1 - RAMP_TRIM);
  if (!(r >= RADIAL_MIN_RADIUS) || !(r - rLo >= 1)) return null;
  const K = clampInt(Math.round((r - rLo) / BIN_LENGTH), MIN_BINS, MAX_BINS);
  const eps = Math.max(STOP_EPS_FLOOR, STOP_EPS_SIGMA * sanitizeSigma(opts.sigma));
  const origin = rLo <= (r - rLo) / K ? 0 : rLo;
  const firstBins = binsFromMicro(microStats(d, idx, start, rho, null, rLo, r, origin, K * MICRO_PER_BIN), K);
  if (!monotoneDominant(firstBins, K, RADIAL_MONOTONE_EPS_FACTOR * eps)) return null;
  const ramp = fitRamp(d, idx, start, rho, rLo, r, origin, opts);
  const all = normalizeStops(rampStops(ramp, r, 0));
  // A flat centre keeps its first offset (the centre cannot move); a flat rim moves r in to the last kept stop.
  const { first, last } = flatEnds(all, FLAT_END_TOL_FACTOR * eps);
  const oB = all[last].offset;
  const rOut = oB > 0 ? r * oB : r;
  const kept = all.slice(first, last + 1).map((s) => ({ offset: oB > 0 ? s.offset / oB : s.offset, color: s.color }));
  const fill: RadialGradient = { kind: 'radial', cx, cy, r: rOut, stops: normalizeStops(kept) };
  return { fill, rmse: rmseOf(img, px, id, fill) };
}

/** True when the channel with the largest range over the non-empty bins never reverses by more than tol. */
function monotoneDominant(poly: BinPolyline, K: number, tol: number): boolean {
  if (poly.first < 0) return false;
  let best = 0;
  let bestRange = -1;
  for (let ch = 0; ch < 3; ch++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < K; k++) {
      if (poly.bw[k] === 0) continue;
      const v = poly.vc[3 * k + ch];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo > bestRange) {
      bestRange = hi - lo;
      best = ch;
    }
  }
  const dir = poly.vc[3 * poly.last + best] >= poly.vc[3 * poly.first + best] ? 1 : -1;
  let extreme = poly.vc[3 * poly.first + best];
  for (let k = poly.first; k <= poly.last; k++) {
    if (poly.bw[k] === 0) continue;
    const v = poly.vc[3 * k + best];
    if (dir > 0) {
      if (v < extreme - tol) return false;
      if (v > extreme) extreme = v;
    } else {
      if (v > extreme + tol) return false;
      if (v < extreme) extreme = v;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Model ladder
// ---------------------------------------------------------------------------------------------

function solidOf(color: RGB): Fill {
  return { kind: 'solid', color: [color[0], color[1], color[2]] };
}

/**
 * Model of region `id`: core < 64 px → solid; rmseFlat <= max(2, 1.5σ) → solid; linear acceptable when
 * rmseLin <= max(2.5, 2σ) and <= 0.6·rmseFlat; radial acceptable (opts.radial) with the same two bounds and
 * <= 0.85·rmseLin (or no linear fit); the radial wins, then the linear; otherwise complex with the lowest-
 * RMSE candidate. A degenerate gradient becomes the solid mean colour.
 */
export function selectModel(
  img: RasterImage,
  px: RegionPixels,
  id: number,
  moments: Float64Array,
  opts: FitOptions & { radial: boolean; support?: (pixel: number) => boolean },
): RegionModel {
  const flat = fitFlat(moments, id);
  const coreCount = px.offsets[id + 1] - px.offsets[id];
  const sigma = sanitizeSigma(opts.sigma);
  if (coreCount < MIN_MODEL_CORE || flat.rmse <= Math.max(FLAT_RMSE_FLOOR, FLAT_RMSE_SIGMA * sigma)) {
    return { fill: solidOf(flat.color), rmse: flat.rmse, rmseFlat: flat.rmse, coreCount, complex: false };
  }
  const lin = fitLinear(img, px, id, fitPlane(moments, id), opts);
  const rad = opts.radial ? fitRadial(img, px, id, opts) : null;
  const limit = Math.max(GRADIENT_RMSE_FLOOR, GRADIENT_RMSE_SIGMA * sigma);
  const flatBound = GRADIENT_MAX_FLAT_RATIO * flat.rmse;
  const linOk = lin !== null && lin.rmse <= limit && lin.rmse <= flatBound;
  const radOk =
    rad !== null && rad.rmse <= limit && rad.rmse <= flatBound && (lin === null || rad.rmse <= RADIAL_MAX_LINEAR_RATIO * lin.rmse);
  let fill: Fill;
  let rmse: number;
  let complex = false;
  if (radOk) {
    fill = rad.fill;
    rmse = rad.rmse;
  } else if (linOk) {
    fill = lin.fill;
    rmse = lin.rmse;
  } else {
    complex = true;
    fill = solidOf(flat.color);
    rmse = flat.rmse;
    if (lin !== null && lin.rmse < rmse) {
      fill = lin.fill;
      rmse = lin.rmse;
    }
    if (rad !== null && rad.rmse < rmse) {
      fill = rad.fill;
      rmse = rad.rmse;
    }
  }
  if (fill.kind !== 'solid' && isDegenerateGradient(fill)) {
    fill = solidOf(flat.color);
    rmse = flat.rmse;
  }
  return { fill, rmse, rmseFlat: flat.rmse, coreCount, complex };
}

/**
 * Colour of the line through stops a and b (a.offset < b.offset) at offset u, clamped to [0, 255] per channel.
 */
function lineColour(a: GradientStop, b: GradientStop, u: number): RGB {
  const k = (u - a.offset) / (b.offset - a.offset);
  return [
    clamp255(a.color[0] + (b.color[0] - a.color[0]) * k),
    clamp255(a.color[1] + (b.color[1] - a.color[1]) * k),
    clamp255(a.color[2] + (b.color[2] - a.color[2]) * k),
  ];
}

/** Pooled RMSE of `fill` over an explicit pixel list (pixel centres, levels over R, G and B); 0 for an empty list. */
function rmseOnList(img: RasterImage, pixels: Int32Array, fill: Fill): number {
  const n = pixels.length;
  if (n === 0) return 0;
  const W = img.width;
  const d = img.data;
  const c: RGB = [0, 0, 0];
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const p = pixels[i];
    const x = p % W;
    evaluateFill(fill, x + 0.5, (p - x) / W + 0.5, c);
    const o = p * 4;
    ss += (d[o] - c[0]) ** 2 + (d[o + 1] - c[1]) ** 2 + (d[o + 2] - c[2]) ** 2;
  }
  return Math.sqrt(ss / (3 * n));
}

/**
 * A fitted gradient extended over `pixels` (typically the region's pixels past its core): the core of a region stops
 * a few px short of its outline (the edge band), so the stop range of a fit ends there and pad paints the rest of the
 * shape with the end colours (radialDisc(128): r 44.1 px of 48). With u = the gradient parameter of each pixel (linear:
 * projection on (x2 − x1, y2 − y1) / |d|²; radial: distance to the centre / r) and its RAMP_TRIM quantiles uLo and uHi,
 * a linear gradient whose uLo < 0 or uHi > 1 has its end points moved to those quantiles and a radial gradient whose
 * uHi > 1 gets r·uHi (its centre stays), the offsets remapped so the old stops keep their positions, and the first and
 * last stops moved outward along their end segments (colour extrapolated linearly and clamped to [0, 255]), so the stop
 * count is unchanged. The extension is kept only when its RMSE over `pixels` is lower than the fit's; otherwise, or with
 * nothing to extend, the input object is returned.
 */
export function extendGradient(img: RasterImage, fill: Gradient, pixels: Int32Array): Gradient {
  const n = pixels.length;
  const stops = fill.stops;
  const m = stops.length;
  if (n === 0 || m < 2) return fill;
  const W = img.width;
  const u = new Float64Array(n);
  if (fill.kind === 'linear') {
    const dx = fill.x2 - fill.x1;
    const dy = fill.y2 - fill.y1;
    const len2 = dx * dx + dy * dy;
    if (!(len2 > 0)) return fill;
    for (let i = 0; i < n; i++) {
      const p = pixels[i];
      const x = p % W;
      u[i] = ((x + 0.5 - fill.x1) * dx + ((p - x) / W + 0.5 - fill.y1) * dy) / len2;
    }
  } else {
    if (!(fill.r > 0)) return fill;
    for (let i = 0; i < n; i++) {
      const p = pixels[i];
      const x = p % W;
      u[i] = Math.hypot(x + 0.5 - fill.cx, (p - x) / W + 0.5 - fill.cy) / fill.r;
    }
  }
  const [qLo, qHi] = quantilePair(u, RAMP_TRIM, 1 - RAMP_TRIM);
  const lo = fill.kind === 'linear' && qLo < 0 ? qLo : 0;
  const hi = qHi > 1 ? qHi : 1;
  if (lo === 0 && hi === 1) return fill;
  // End segments: the first pair of stops with distinct offsets from each end.
  let a1 = 1;
  while (a1 < m - 1 && !(stops[a1].offset > stops[0].offset)) a1++;
  let b0 = m - 2;
  while (b0 > 0 && !(stops[b0].offset < stops[m - 1].offset)) b0--;
  if (!(stops[a1].offset > stops[0].offset) || !(stops[b0].offset < stops[m - 1].offset)) return fill;
  const span = hi - lo;
  const out: GradientStop[] = stops.map((s) => ({ offset: (s.offset - lo) / span, color: [s.color[0], s.color[1], s.color[2]] }));
  if (lo < 0) out[0] = { offset: 0, color: lineColour(stops[0], stops[a1], lo) };
  if (hi > 1) out[m - 1] = { offset: 1, color: lineColour(stops[b0], stops[m - 1], hi) };
  const extended: Gradient =
    fill.kind === 'linear'
      ? {
          kind: 'linear',
          x1: fill.x1 + (fill.x2 - fill.x1) * lo,
          y1: fill.y1 + (fill.y2 - fill.y1) * lo,
          x2: fill.x1 + (fill.x2 - fill.x1) * hi,
          y2: fill.y1 + (fill.y2 - fill.y1) * hi,
          stops: normalizeStops(out),
        }
      : { kind: 'radial', cx: fill.cx, cy: fill.cy, r: fill.r * hi, stops: normalizeStops(out) };
  return rmseOnList(img, pixels, extended) < rmseOnList(img, pixels, fill) ? extended : fill;
}

/** The model selectModel picks for an explicit pixel list, fitted as a single region. */
function modelOfList(img: RasterImage, indices: Int32Array, opts: FitOptions & { radial?: boolean }): RegionModel {
  const px: RegionPixels = { offsets: Int32Array.from([0, indices.length]), indices };
  return selectModel(img, px, 0, momentsOf(img, indices), { sigma: opts.sigma, maxStops: opts.maxStops, radial: opts.radial ?? true });
}

/**
 * Deterministic k-means with k = 2 over three features of each pixel of `indices`, each scaled to [0, 1] so the
 * geometry and the colour error weigh the same: x and y by the bounding box of the list, and the SIGNED luma
 * residual of `fill` by its range over the list. Seeded from the most positive and the most negative residual
 * pixel (ties: the lower raster index, so the seeds do not depend on the iteration order), at most
 * SPLIT_KMEANS_ITERATIONS sweeps, stopping as soon as no pixel changes cluster; a tie in the distance goes to
 * the first cluster. The residual is what a single-axis ramp gets wrong, so its sign separates the two shadings
 * that a 2-D shading superimposes, while x and y keep each part in one piece.
 * Returns the two lists in raster order, or null when the residual has no range (nothing to separate) or one
 * cluster comes out empty.
 */
function kmeansResidualSplit(img: RasterImage, indices: Int32Array, fill: Fill): [Int32Array, Int32Array] | null {
  const n = indices.length;
  const W = img.width;
  const d = img.data;
  const c: RGB = [0, 0, 0];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const res = new Float64Array(n);
  let hi = -Infinity;
  let lo = Infinity;
  let hiAt = 0;
  let loAt = 0;
  for (let i = 0; i < n; i++) {
    const p = indices[i];
    const x = p % W;
    const y = (p - x) / W;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    evaluateFill(fill, x + 0.5, y + 0.5, c);
    const o = p * 4;
    const r = 0.299 * (d[o] - c[0]) + 0.587 * (d[o + 1] - c[1]) + 0.114 * (d[o + 2] - c[2]);
    res[i] = r;
    if (r > hi) {
      hi = r;
      hiAt = i;
    }
    if (r < lo) {
      lo = r;
      loAt = i;
    }
  }
  const span = hi - lo;
  if (!(span > 0)) return null;
  const sx = Math.max(1, maxX - minX + 1);
  const sy = Math.max(1, maxY - minY + 1);
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const fr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = indices[i];
    const x = p % W;
    fx[i] = (x + 0.5 - minX) / sx;
    fy[i] = ((p - x) / W + 0.5 - minY) / sy;
    fr[i] = (res[i] - lo) / span;
  }
  let ax = fx[hiAt];
  let ay = fy[hiAt];
  let ar = fr[hiAt];
  let bx = fx[loAt];
  let by = fy[loAt];
  let br = fr[loAt];
  const side = new Uint8Array(n);
  for (let pass = 0; pass < SPLIT_KMEANS_ITERATIONS; pass++) {
    let moved = false;
    let n0 = 0;
    let s0x = 0;
    let s0y = 0;
    let s0r = 0;
    let s1x = 0;
    let s1y = 0;
    let s1r = 0;
    for (let i = 0; i < n; i++) {
      const u = fx[i];
      const v = fy[i];
      const w = fr[i];
      const da = (u - ax) * (u - ax) + (v - ay) * (v - ay) + (w - ar) * (w - ar);
      const db = (u - bx) * (u - bx) + (v - by) * (v - by) + (w - br) * (w - br);
      const s = da <= db ? 0 : 1;
      if (s !== side[i]) {
        side[i] = s;
        moved = true;
      }
      if (s === 0) {
        n0++;
        s0x += u;
        s0y += v;
        s0r += w;
      } else {
        s1x += u;
        s1y += v;
        s1r += w;
      }
    }
    const n1 = n - n0;
    if (n0 === 0 || n1 === 0) return null;
    if (!moved) break;
    ax = s0x / n0;
    ay = s0y / n0;
    ar = s0r / n0;
    bx = s1x / n1;
    by = s1y / n1;
    br = s1r / n1;
  }
  let n0 = 0;
  for (let i = 0; i < n; i++) if (side[i] === 0) n0++;
  const a = new Int32Array(n0);
  const b = new Int32Array(n - n0);
  let ia = 0;
  let ib = 0;
  for (let i = 0; i < n; i++) {
    if (side[i] === 0) a[ia++] = indices[i];
    else b[ib++] = indices[i];
  }
  return [a, b];
}

/**
 * Splits a region no single fill explains (selectModel's complex) into 2..2^maxDepth parts, each with its own
 * solid, linear or radial fill: the SVG-expressible answer to a 2-D shading, where the three channels' colour
 * gradients are not collinear and no one-axis gradient can follow them (pajaro's belly: fitPlane 4.03 against
 * 8.81 for the best ramp, and more stops do not help because Douglas-Peucker has already converged).
 *
 * One level = kmeansResidualSplit (k = 2 on x, y and the signed luma residual of the region's current fill) and
 * selectModel on each part. The level is kept only when both parts have at least MIN_MODEL_CORE core pixels (so
 * each gets a real model instead of the solid floor of the ladder) AND the core-weighted RMSE of the two parts
 * is at most SPLIT_MAX_RMSE_RATIO of the region's own RMSE and at least SPLIT_MIN_RMSE_GAIN levels below it;
 * otherwise that branch stays whole. A part the ladder still calls complex is split again, up to maxDepth levels
 * (default SPLIT_MAX_DEPTH). Returns null when nothing was split.
 *
 * `px` are the core pixels (corePixels, or the pipeline's fit core) and `opts.fill` the region's current best
 * fill (the caller already has it; without it splitComplex fits one). assign[i] = the part of the i-th core pixel
 * of `id`, in the order of `px`; fills[p] = the fill of part p. Pixels of the region that are NOT core (the edge
 * band) are not in `px` and the caller assigns them (the pipeline: to the part whose fill predicts them best).
 * Pure and deterministic: no random seeds and no iteration that depends on insertion order.
 */
export function splitComplex(
  img: RasterImage,
  px: RegionPixels,
  id: number,
  opts: FitOptions & { radial?: boolean; fill?: Fill; maxDepth?: number },
): { assign: Uint8Array; fills: Fill[] } | null {
  const start = px.offsets[id];
  const n = px.offsets[id + 1] - start;
  // Below two parts' worth of core pixels no split can leave both of them with a model of their own.
  if (n < 2 * MIN_MODEL_CORE) return null;
  const maxDepth = opts.maxDepth === undefined ? SPLIT_MAX_DEPTH : Math.floor(opts.maxDepth);
  if (!(maxDepth >= 1)) return null;
  const all = px.indices.subarray(start, start + n);
  const baseFill = opts.fill ?? modelOfList(img, all, opts).fill;
  const parts: Array<{ indices: Int32Array; fill: Fill }> = [];
  const visit = (indices: Int32Array, fill: Fill, depth: number): void => {
    const keep = (): void => void parts.push({ indices, fill });
    if (depth >= maxDepth || indices.length < 2 * MIN_MODEL_CORE) return keep();
    const pair = kmeansResidualSplit(img, indices, fill);
    if (pair === null) return keep();
    const [a, b] = pair;
    if (a.length < MIN_MODEL_CORE || b.length < MIN_MODEL_CORE) return keep();
    const ma = modelOfList(img, a, opts);
    const mb = modelOfList(img, b, opts);
    const before = rmseOnList(img, indices, fill);
    const after = Math.sqrt((a.length * ma.rmse * ma.rmse + b.length * mb.rmse * mb.rmse) / indices.length);
    if (!(after <= SPLIT_MAX_RMSE_RATIO * before) || !(before - after >= SPLIT_MIN_RMSE_GAIN)) return keep();
    // A part the ladder still cannot explain is worth another level; one it can is final.
    if (ma.complex) visit(a, ma.fill, depth + 1);
    else parts.push({ indices: a, fill: ma.fill });
    if (mb.complex) visit(b, mb.fill, depth + 1);
    else parts.push({ indices: b, fill: mb.fill });
  };
  visit(all, baseFill, 0);
  if (parts.length < 2 || parts.length > 255) return null;
  // assign: both `all` and every part are in raster order, so one merge pass per part places it.
  const assign = new Uint8Array(n);
  const fills: Fill[] = [];
  for (let p = 0; p < parts.length; p++) {
    fills.push(parts[p].fill);
    const list = parts[p].indices;
    let j = 0;
    for (let i = 0; i < list.length; i++) {
      while (j < n && all[j] !== list[i]) j++;
      if (j >= n) throw new RangeError('splitComplex: un píxel de una parte no está en el núcleo de la región');
      assign[j] = p;
      j++;
    }
  }
  return { assign, fills };
}

// ---------------------------------------------------------------------------------------------
// Merge planning
// ---------------------------------------------------------------------------------------------

/**
 * Colour of `f` at (x, y) with its end segments extended linearly beyond the first and last stop (no pad),
 * clamped to [0, 255]: what each model "would" paint on the far side of a shared boundary. Inside the
 * stop range it is exactly fillEval.
 */
function extrapolatedColor(f: Fill, x: number, y: number, out: RGB): RGB {
  if (f.kind === 'solid') return evaluateFill(f, x, y, out);
  let t: number;
  if (f.kind === 'linear') {
    const dx = f.x2 - f.x1;
    const dy = f.y2 - f.y1;
    const len2 = dx * dx + dy * dy;
    if (!(len2 > 0)) return evaluateFill(f, x, y, out);
    t = ((x - f.x1) * dx + (y - f.y1) * dy) / len2;
  } else {
    if (!(f.r > 0)) return evaluateFill(f, x, y, out);
    t = Math.hypot(x - f.cx, y - f.cy) / f.r;
  }
  const stops = f.stops;
  const n = stops.length;
  if (n < 2 || !Number.isFinite(t) || (t >= stops[0].offset && t <= stops[n - 1].offset)) {
    return stopColorAt(stops, t > 0 ? (t < 1 ? t : 1) : 0, out);
  }
  let a: number;
  let b: number;
  if (t < stops[0].offset) {
    a = 0;
    b = 1;
    while (b < n - 1 && stops[b].offset <= stops[a].offset) b++;
  } else {
    b = n - 1;
    a = n - 2;
    while (a > 0 && stops[a].offset >= stops[b].offset) a--;
  }
  const span = stops[b].offset - stops[a].offset;
  if (!(span > 0)) return stopColorAt(stops, t > 0 ? (t < 1 ? t : 1) : 0, out);
  const u = (t - stops[a].offset) / span;
  for (let ch = 0; ch < 3; ch++) out[ch] = clamp255(stops[a].color[ch] + (stops[b].color[ch] - stops[a].color[ch]) * u);
  return out;
}

/** Moments (16) of an explicit pixel list. */
function momentsOf(img: RasterImage, indices: Int32Array): Float64Array {
  const W = img.width;
  const d = img.data;
  const m = new Float64Array(MOMENTS_PER_REGION);
  for (let i = 0; i < indices.length; i++) {
    const p = indices[i];
    const x = p % W;
    const xc = x + 0.5;
    const yc = (p - x) / W + 0.5;
    const o = p * 4;
    const R = d[o];
    const G = d[o + 1];
    const B = d[o + 2];
    m[0] += 1;
    m[1] += xc;
    m[2] += yc;
    m[3] += xc * xc;
    m[4] += xc * yc;
    m[5] += yc * yc;
    m[6] += R;
    m[7] += G;
    m[8] += B;
    m[9] += R * xc;
    m[10] += G * xc;
    m[11] += B * xc;
    m[12] += R * yc;
    m[13] += G * yc;
    m[14] += B * yc;
    m[15] += R * R + G * G + B * B;
  }
  return m;
}

interface GroupModel {
  fill: Fill;
  rmse: number;
}

interface Candidate {
  cost: number;
  a: number;
  b: number;
  va: number;
  vb: number;
  model: RegionModel;
}

function candidateLess(x: Candidate, y: Candidate): boolean {
  if (x.cost !== y.cost) return x.cost < y.cost;
  if (x.a !== y.a) return x.a < y.a;
  return x.b < y.b;
}

function heapPush(h: Candidate[], c: Candidate): void {
  h.push(c);
  let i = h.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!candidateLess(h[i], h[parent])) break;
    [h[i], h[parent]] = [h[parent], h[i]];
    i = parent;
  }
}

function heapPop(h: Candidate[]): Candidate | undefined {
  if (h.length === 0) return undefined;
  const top = h[0];
  const last = h.pop() as Candidate;
  if (h.length > 0) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let s = i;
      if (l < h.length && candidateLess(h[l], h[s])) s = l;
      if (r < h.length && candidateLess(h[r], h[s])) s = r;
      if (s === i) break;
      [h[i], h[s]] = [h[s], h[i]];
      i = s;
    }
  }
  return top;
}

function undirectedAngleDeg(a: LinearGradient, b: LinearGradient): number {
  const ang = (g: LinearGradient): number => Math.atan2(g.y2 - g.y1, g.x2 - g.x1);
  let diff = Math.abs(ang(a) - ang(b)) % Math.PI;
  if (diff > Math.PI / 2) diff = Math.PI - diff;
  return (diff * 180) / Math.PI;
}

/**
 * Merge pairs [src, dst] (src into dst), in application order (union-find semantics, as mergeRegions):
 *   1) tiny regions (area < minArea, default max(16, 2e-5·W·H)) and regions without core pixels (their
 *      model is meaningless), smallest first, into the 4-adjacent region with the highest shared boundary /
 *      (1 + rmseOf of that neighbour's model on the core pixels of the tiny region and of what it already
 *      absorbed) (no core: the longest boundary); a neighbour without core pixels only as a last resort.
 *      A tiny neighbour is a valid destination: the union-find chains it to wherever that one goes;
 *   2) compatible neighbours, greedily by the lowest cost rmseJoint − max(rmseA, rmseB): never two linear
 *      models whose axes differ by more than 15°; the mean over the shared boundary of the largest channel
 *      difference between the two models extrapolated there <= maxBoundaryJump (default 3), or, when one of the
 *      two groups has fewer than MIN_MODEL_CORE core pixels, the joint model's RMSE on that group's core <=
 *      max(rmseA, rmseB) + maxRmseGain; the model selectModel fits on A ∪ B (a strided sample above
 *      MERGE_MAX_JOINT_PIXELS, with fitRadial reading its derivative supports from seg.core and the two groups) with
 *      rmse <= max(rmseA, rmseB) + maxRmseGain (default 1.5). A merged pair takes that joint model for the following
 *      decisions. opts.pixels, when given, must be corePixels(seg).
 */
export function planMerges(
  img: RasterImage,
  seg: Segmentation,
  models: readonly RegionModel[],
  opts: Partial<MergeOptions> = {},
): Array<[number, number]> {
  checkSameSize(img, seg, 'planMerges');
  const W = seg.regions.width;
  const H = seg.regions.height;
  const count = seg.regions.count;
  if (models.length !== count) throw new RangeError(`planMerges: ${models.length} modelos para ${count} regiones`);
  const sigma = sanitizeSigma(opts.sigma ?? seg.sigma);
  const minArea = opts.minArea ?? Math.max(MERGE_MIN_AREA_FLOOR, MERGE_MIN_AREA_SHARE * W * H);
  const maxGain = opts.maxRmseGain ?? MERGE_MAX_RMSE_GAIN;
  const maxJump = opts.maxBoundaryJump ?? MERGE_MAX_BOUNDARY_JUMP;
  const fitOpts = { sigma, maxStops: opts.maxStops ?? 8, radial: opts.radial ?? true };
  const px = opts.pixels ?? corePixels(seg);
  const smallGroups = opts.smallGroups ?? true;
  const reg = seg.regions.data;

  // Shared boundaries: per neighbour, chunks of encoded 4-adjacent pairs (p·2 + 0 → p+1, p·2 + 1 → p+W).
  const nbr: Array<Map<number, number[][]>> = Array.from({ length: count }, () => new Map());
  for (let y = 0; y < H; y++) {
    for (let x = 0, i = y * W; x < W; x++, i++) {
      const k = reg[i];
      if (k < 0) continue;
      if (x + 1 < W) {
        const q = reg[i + 1];
        if (q >= 0 && q !== k) addBoundary(nbr, k, q, i * 2);
      }
      if (y + 1 < H) {
        const q = reg[i + W];
        if (q >= 0 && q !== k) addBoundary(nbr, k, q, i * 2 + 1);
      }
    }
  }

  const parent = new Int32Array(count);
  for (let k = 0; k < count; k++) parent[k] = k;
  const members: number[][] = Array.from({ length: count }, (_, k) => [k]);
  const area = Float64Array.from(seg.area);
  const group: GroupModel[] = models.map((m) => ({ fill: m.fill, rmse: m.rmse }));
  const pairs: Array<[number, number]> = [];

  const union = (src: number, dst: number): void => {
    parent[src] = dst;
    for (const [q, chunks] of nbr[src]) {
      nbr[q].delete(src);
      if (q === dst) continue;
      const existing = nbr[dst].get(q);
      const merged = existing ? existing.concat(chunks) : chunks.slice();
      nbr[dst].set(q, merged);
      nbr[q].set(dst, merged);
    }
    nbr[src].clear();
    for (const mbr of members[src]) members[dst].push(mbr);
    members[src] = [];
    area[dst] += area[src];
    pairs.push([src, dst]);
  };

  // 1) tiny and coreless regions
  const order: number[] = [];
  for (let k = 0; k < count; k++) {
    if (area[k] < minArea || px.offsets[k + 1] === px.offsets[k]) order.push(k);
  }
  order.sort((a, b) => area[a] - area[b] || a - b);
  const groupCore = (root: number): number => {
    let n = 0;
    for (const mbr of members[root]) n += px.offsets[mbr + 1] - px.offsets[mbr];
    return n;
  };
  /** rmseOf pooled over the core pixels of every member of the group (the tiny region and what it already absorbed). */
  const groupRmse = (root: number, fill: Fill): number => {
    let ss = 0;
    let n = 0;
    for (const mbr of members[root]) {
      const c = px.offsets[mbr + 1] - px.offsets[mbr];
      if (c === 0) continue;
      const r = rmseOf(img, px, mbr, fill);
      ss += r * r * c;
      n += c;
    }
    return n === 0 ? 0 : Math.sqrt(ss / n);
  };
  /** groupRmse with extrapolatedColor (no pad): how a model continues over the group's core pixels. */
  const groupRmseExtrapolated = (root: number, fill: Fill): number => {
    const c: RGB = [0, 0, 0];
    let ss = 0;
    let n = 0;
    for (const mbr of members[root]) {
      for (let i = px.offsets[mbr]; i < px.offsets[mbr + 1]; i++) {
        const p = px.indices[i];
        const x = p % W;
        extrapolatedColor(fill, x + 0.5, (p - x) / W + 0.5, c);
        const o = p * 4;
        ss += (img.data[o] - c[0]) ** 2 + (img.data[o + 1] - c[1]) ** 2 + (img.data[o + 2] - c[2]) ** 2;
        n += 3;
      }
    }
    return n === 0 ? 0 : Math.sqrt(ss / n);
  };
  for (const s of order) {
    if (nbr[s].size === 0) continue;
    const hasCore = groupCore(s) > 0;
    let best = -1;
    let bestTier = -1;
    let bestScore = -Infinity;
    for (const [q, chunks] of nbr[s]) {
      let len = 0;
      for (const c of chunks) len += c.length;
      const res = hasCore ? groupRmse(s, group[q].fill) : 0;
      const score = len / (1 + res);
      // A destination without core pixels has no real model (selectModel paints it black): last resort.
      const tier = groupCore(q) > 0 ? 1 : 0;
      if (tier > bestTier || (tier === bestTier && (score > bestScore || (score === bestScore && q < best)))) {
        best = q;
        bestTier = tier;
        bestScore = score;
      }
    }
    union(s, best);
  }

  // 2) compatible neighbours
  const version = new Int32Array(count);
  const memberStamp = new Int32Array(count);
  const coreData = seg.core.data;
  let stamp = 0;
  const heap: Candidate[] = [];
  const colorA: RGB = [0, 0, 0];
  const colorB: RGB = [0, 0, 0];

  const evaluate = (a: number, b: number): Candidate | null => {
    const fa = group[a].fill;
    const fb = group[b].fill;
    if (fa.kind === 'linear' && fb.kind === 'linear' && undirectedAngleDeg(fa, fb) > MERGE_MAX_AXIS_DEG) return null;
    const chunks = nbr[a].get(b);
    if (!chunks) return null;
    let total = 0;
    for (const c of chunks) total += c.length;
    if (total === 0) return null;
    // A group under MIN_MODEL_CORE core pixels is solid by the ladder, not by its colours: a piece of a ramp cut off by a
    // spurious edge cannot extrapolate to the boundary, so when the jump test fails it may still merge if the joint model
    // explains its own core within the same gain.
    const coreA = groupCore(a);
    const coreB = groupCore(b);
    const small = smallGroups && Math.min(coreA, coreB) < MIN_MODEL_CORE ? (coreA <= coreB ? a : b) : -1;
    const bStride = Math.max(1, Math.ceil(total / MERGE_MAX_BOUNDARY_SAMPLES));
    let jumpSum = 0;
    let jumpN = 0;
    let seen = 0;
    for (const c of chunks) {
      for (let e = 0; e < c.length; e++, seen++) {
        if (seen % bStride !== 0) continue;
        const code = c[e];
        const p = code >> 1;
        const x = p % W;
        const y = (p - x) / W;
        const mx = (code & 1) === 0 ? x + 1 : x + 0.5; // midpoint between the two pixel centres
        const my = (code & 1) === 0 ? y + 0.5 : y + 1;
        extrapolatedColor(fa, mx, my, colorA);
        extrapolatedColor(fb, mx, my, colorB);
        jumpSum += Math.max(Math.abs(colorA[0] - colorB[0]), Math.abs(colorA[1] - colorB[1]), Math.abs(colorA[2] - colorB[2]));
        jumpN++;
      }
    }
    const jumpOk = jumpSum / jumpN <= maxJump;
    if (!jumpOk && small < 0) return null;
    if (!jumpOk && !(groupRmseExtrapolated(small, group[small === a ? b : a].fill) <= MERGE_SMALL_MAX_OFFSET)) return null;
    let pixelsTotal = 0;
    for (const mbr of members[a]) pixelsTotal += px.offsets[mbr + 1] - px.offsets[mbr];
    for (const mbr of members[b]) pixelsTotal += px.offsets[mbr + 1] - px.offsets[mbr];
    const pStride = Math.max(1, Math.ceil(pixelsTotal / MERGE_MAX_JOINT_PIXELS));
    const joint = new Int32Array(Math.ceil(pixelsTotal / pStride));
    let fillAt = 0;
    let counter = 0;
    for (const list of [members[a], members[b]]) {
      for (const mbr of list) {
        for (let i = px.offsets[mbr]; i < px.offsets[mbr + 1]; i++, counter++) {
          if (counter % pStride === 0) joint[fillAt++] = px.indices[i];
        }
      }
    }
    const jointPx: RegionPixels = { offsets: Int32Array.from([0, fillAt]), indices: joint.subarray(0, fillAt) };
    // A strided sample is not a neighbourhood: fitRadial reads its derivative supports from the regions instead.
    let support: ((pixel: number) => boolean) | undefined;
    if (pStride > 1) {
      stamp++;
      for (const mbr of members[a]) memberStamp[mbr] = stamp;
      for (const mbr of members[b]) memberStamp[mbr] = stamp;
      const mark = stamp;
      support = (pixel: number): boolean => coreData[pixel] !== 0 && reg[pixel] >= 0 && memberStamp[reg[pixel]] === mark;
    }
    const model = selectModel(img, jointPx, 0, momentsOf(img, jointPx.indices), support === undefined ? fitOpts : { ...fitOpts, support });
    const base = Math.max(group[a].rmse, group[b].rmse);
    if (!(model.rmse <= base + maxGain)) return null;
    if (!jumpOk && !(groupRmse(small, model.fill) <= base + maxGain)) return null;
    return { cost: model.rmse - base, a, b, va: version[a], vb: version[b], model };
  };

  const pushPairsOf = (a: number): void => {
    const keys = [...nbr[a].keys()].sort((x, y) => x - y);
    for (const q of keys) {
      const lo = Math.min(a, q);
      const hi = Math.max(a, q);
      const c = evaluate(lo, hi);
      if (c) heapPush(heap, c);
    }
  };

  for (let a = 0; a < count; a++) {
    if (parent[a] !== a) continue;
    const keys = [...nbr[a].keys()].filter((q) => q > a).sort((x, y) => x - y);
    for (const q of keys) {
      const c = evaluate(a, q);
      if (c) heapPush(heap, c);
    }
  }
  for (;;) {
    const c = heapPop(heap);
    if (!c) break;
    if (parent[c.a] !== c.a || parent[c.b] !== c.b || version[c.a] !== c.va || version[c.b] !== c.vb) continue;
    const dst = area[c.a] > area[c.b] || (area[c.a] === area[c.b] && c.a < c.b) ? c.a : c.b;
    const src = dst === c.a ? c.b : c.a;
    union(src, dst);
    group[dst] = { fill: c.model.fill, rmse: c.model.rmse };
    version[dst]++;
    pushPairsOf(dst);
  }
  return pairs;
}

function addBoundary(nbr: Array<Map<number, number[][]>>, k: number, q: number, code: number): void {
  let chunks = nbr[k].get(q);
  if (!chunks) {
    chunks = [[]];
    nbr[k].set(q, chunks);
    nbr[q].set(k, chunks);
  }
  chunks[0].push(code);
}
