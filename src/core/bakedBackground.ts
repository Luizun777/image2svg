/**
 * Fake transparency: a checkerboard painted into the pixels of an opaque image (stock "PNG"
 * previews saved without alpha, usually as JPEG). Pure; never mutates inputs.
 *
 * detectBakedCheckerboard looks only at the border band: two light neutral levels, square cells
 * (fractional sizes allowed: resampled previews) whose parity explains >= 90 % of the band.
 * bakedBackgroundMask follows the cell parity over the whole image, component by component, so
 * letter counters showing the checkerboard are background while genuine light shapes that break
 * the parity are kept. applyBakedBackground / effectiveSource turn that background transparent
 * (and estimate the alpha of the anti-aliased fringe against the local checker level), so the
 * palette, the classifier and the stacking take the transparent path.
 */
import type { BakedBackgroundSetting, BakedCheckerboard, BinaryMask, RasterImage, RGB, SourceInfo } from '../types';

/** Depth of the border band sampled for detection: the 1-px ring plus a 2-px margin. */
export const CHECKER_BAND = 3;
/** Max channel spread (max - min) of a neutral (grey) pixel. */
export const CHECKER_NEUTRAL_SPREAD = 12;
/** Luma tolerance around a checker level (JPEG noise). */
export const CHECKER_LEVEL_TOL = 8;
/** Minimum luma distance between the two levels. */
export const CHECKER_MIN_LEVEL_GAP = 8;
/** Both levels must be at least this light (luma 0..255). */
export const CHECKER_MIN_LUMA = 128;
/** Cell sizes searched, px. */
export const CHECKER_MIN_CELL = 6;
export const CHECKER_MAX_CELL = 48;
/** Minimum share of the candidate border pixels whose level matches their cell parity. */
export const CHECKER_MIN_MATCH = 0.9;
/** Minimum share of the border band made of checker candidates (the border is mostly background). */
export const CHECKER_MIN_CANDIDATES = 0.5;
/** An enclosed candidate component is background when this share of its pixels matches the parity. */
export const CHECKER_COMPONENT_MATCH = 0.9;

/** Each level must hold at least this share of the candidates. */
const MIN_LEVEL_SHARE = 0.2;
/** (Almost) opaque: at most this share of pixels with alpha < 248. */
const MAX_NON_OPAQUE = 0.01;
/** Smallest image side considered (two minimum cells plus the band). */
const MIN_SIDE = 24;
/** Half-width (luma levels) of the histogram window that finds the two levels. */
const PEAK_HALF_WINDOW = 3;
/** Max distance (px) between two candidates of different levels read as one cell boundary. */
const MAX_TRANSITION_GAP = 4;
/** Minimum phase coherence of a period worth checking against the parity. */
const MIN_COHERENCE = 0.5;
const MAX_PERIOD_CANDIDATES = 8;
/** Boundary positions used by the period search per axis (evenly subsampled beyond this). */
const MAX_TRANSITIONS_PER_AXIS = 1024;
/** Pixels whose centre is closer than this (px) to a cell boundary do not vote on a component's parity. */
const BOUNDARY_MARGIN = 1;
/** Pixels whose centre is closer than this (px) to a cell boundary may blend both levels. */
const BLEND_MARGIN = 1.5;
/** Fringe band (Chebyshev radius, px) around the background whose alpha is estimated. */
const FRINGE_RADIUS = 2;
/** Minimum raw-RGB distance between ink and checker level to estimate a fringe alpha. */
const FRINGE_MIN_CONTRAST = 24;
/** Estimated coverage at or above this leaves the pixel untouched. */
const FRINGE_OPAQUE = 0.95;
/**
 * A fringe pixel P is repainted as ink I with alpha a only when L + a (I - L) reproduces it within this
 * raw-RGB distance: a yellow pixel next to a dark outline projects onto board -> dark at 0.25-0.6 but
 * is nowhere near that blend (residual ~200), and was repainted as translucent dark ink.
 */
export const FRINGE_MAX_RESIDUAL = 32;
/** Border cells whose interior is at least this share within tolerance of its median are uniform. */
const UNIFORM_CELL_SHARE = 0.8;
/** Rings of cells along the image border checked by borderCellsAgree. */
const CELL_RINGS = 2;
/** Share of the level pixels of those cells that must show the level of their cell parity. */
const CELL_PARITY_MATCH = 0.95;
/** Border cells need this many interior pixels to vote. */
const MIN_CELL_VOTE_PIXELS = 9;
/** Rounds of the light-shape reconstruction (projection into hidden halves, then attached thin pieces). */
const SHAPE_ROUNDS = 4;

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Level index (0/1) of the pixel at byte offset p, or -1 when it is not a neutral pixel near a level. */
function levelAt(d: Uint8ClampedArray, p: number, l0: number, l1: number): number {
  const r = d[p];
  const g = d[p + 1];
  const b = d[p + 2];
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
  const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
  if (mx - mn > CHECKER_NEUTRAL_SPREAD) return -1;
  const y = luma(r, g, b);
  const d0 = Math.abs(y - l0);
  const d1 = Math.abs(y - l1);
  if (d0 <= d1) return d0 <= CHECKER_LEVEL_TOL ? 0 : -1;
  return d1 <= CHECKER_LEVEL_TOL ? 1 : -1;
}

/** Calls fn(x, y) for every pixel of the border band of depth `band` (each pixel once). */
function forEachBandPixel(w: number, h: number, band: number, fn: (x: number, y: number) => void): void {
  for (let y = 0; y < h; y++) {
    if (y < band || y >= h - band) {
      for (let x = 0; x < w; x++) fn(x, y);
    } else {
      for (let x = 0; x < band; x++) fn(x, y);
      for (let x = w - band; x < w; x++) fn(x, y);
    }
  }
}

/** The two most populated luma windows at least CHECKER_MIN_LEVEL_GAP apart, or null. */
function twoPeaks(hist: Float64Array): [number, number] | null {
  const s = new Float64Array(256);
  for (let v = 0; v < 256; v++) {
    let acc = 0;
    for (let u = Math.max(0, v - PEAK_HALF_WINDOW); u <= Math.min(255, v + PEAK_HALF_WINDOW); u++) acc += hist[u];
    s[v] = acc;
  }
  let a = 0;
  for (let v = 1; v < 256; v++) if (s[v] > s[a]) a = v;
  if (s[a] === 0) return null;
  let b = -1;
  for (let v = 0; v < 256; v++) {
    if (Math.abs(v - a) < CHECKER_MIN_LEVEL_GAP || s[v] === 0) continue;
    if (v > 0 && s[v] < s[v - 1]) continue;
    if (v < 255 && s[v] < s[v + 1]) continue;
    if (b < 0 || s[v] > s[b]) b = v;
  }
  return b < 0 ? null : [a, b];
}

/** Sub-pixel edge coordinate where the luma crosses halfway between two levels, between i0 and i1. */
function crossing(vals: Float64Array, i0: number, i1: number, from: number, to: number): number {
  const mid = (from + to) / 2;
  const dir = to > from ? 1 : -1;
  for (let i = i0; i < i1; i++) {
    const a = (vals[i] - mid) * dir;
    const b = (vals[i + 1] - mid) * dir;
    if (a < 0 && b >= 0) return i + 0.5 + a / (a - b);
  }
  return (i0 + 1 + i1) / 2;
}

/** Appends the cell-boundary positions found along one line of the band. */
function lineTransitions(vals: Float64Array, levels: Int8Array, n: number, lv: [number, number], out: number[]): void {
  let lastI = -1;
  let lastK = -1;
  for (let i = 0; i < n; i++) {
    const k = levels[i];
    if (k < 0) continue;
    if (lastK >= 0 && k !== lastK && i - lastI <= MAX_TRANSITION_GAP) {
      out.push(crossing(vals, lastI, i, lv[lastK], lv[k]));
    }
    lastI = i;
    lastK = k;
  }
}

function subsample(v: number[]): number[] {
  if (v.length <= MAX_TRANSITIONS_PER_AXIS) return v;
  const out: number[] = [];
  const stride = v.length / MAX_TRANSITIONS_PER_AXIS;
  for (let i = 0; i < MAX_TRANSITIONS_PER_AXIS; i++) out.push(v[Math.floor(i * stride)]);
  return out;
}

/** Offset in [0, c) of the boundaries whose mean phase is phi (radians). */
function phaseOffset(phi: number, c: number): number {
  const o = ((phi / (2 * Math.PI)) * c) % c;
  const r = o < 0 ? o + c : o;
  return r >= c ? 0 : r;
}

/**
 * Phase coherence of the boundary positions for period c: mean resultant length over both axes
 * (1 = every boundary at offset + k*c), with the offsets of that mean phase.
 */
function coherence(xs: number[], ys: number[], c: number): { r: number; ox: number; oy: number } {
  const k = (2 * Math.PI) / c;
  let cx = 0;
  let sx = 0;
  for (let i = 0; i < xs.length; i++) {
    cx += Math.cos(k * xs[i]);
    sx += Math.sin(k * xs[i]);
  }
  let cy = 0;
  let sy = 0;
  for (let i = 0; i < ys.length; i++) {
    cy += Math.cos(k * ys[i]);
    sy += Math.sin(k * ys[i]);
  }
  return {
    r: (Math.hypot(cx, sx) + Math.hypot(cy, sy)) / (xs.length + ys.length),
    ox: phaseOffset(Math.atan2(sx, cx), c),
    oy: phaseOffset(Math.atan2(sy, cy), c),
  };
}

/**
 * Fake-transparency checkerboard of an (almost) opaque image, or null. The border band (the ring
 * plus a 2-px margin) must be mostly (>= 50 %) neutral pixels within +-8 luma of two light levels
 * at least 8 apart; the cell size (6..48 px, fractional allowed) and the offsets come from the
 * phase coherence of the level transitions along the band, and the first candidate period whose
 * parity explains >= 90 % of the candidate band pixels wins (sub-multiples of the true period
 * explain about half).
 */
export function detectBakedCheckerboard(img: RasterImage): BakedCheckerboard | null {
  const { width: w, height: h, data: d } = img;
  if (!(w >= MIN_SIDE && h >= MIN_SIDE) || d.length !== w * h * 4) return null;
  let nonOpaque = 0;
  for (let p = 3; p < d.length; p += 4) if (d[p] < 248) nonOpaque++;
  if (nonOpaque > MAX_NON_OPAQUE * w * h) return null;

  // 1. Two levels from the neutral band luma histogram.
  const hist = new Float64Array(256);
  let bandCount = 0;
  forEachBandPixel(w, h, CHECKER_BAND, (x, y) => {
    bandCount++;
    const p = (y * w + x) * 4;
    const r = d[p];
    const g = d[p + 1];
    const b = d[p + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > CHECKER_NEUTRAL_SPREAD) return;
    hist[Math.round(luma(r, g, b))]++;
  });
  const peaks = twoPeaks(hist);
  if (peaks === null) return null;

  // 2. Refine each level on the band pixels within tolerance (two passes).
  let l0 = peaks[0];
  let l1 = peaks[1];
  const acc = new Float64Array(10); // per level: count, luma, r, g, b
  for (let pass = 0; pass < 2; pass++) {
    acc.fill(0);
    forEachBandPixel(w, h, CHECKER_BAND, (x, y) => {
      const p = (y * w + x) * 4;
      const k = levelAt(d, p, l0, l1);
      if (k < 0) return;
      const o = k * 5;
      acc[o]++;
      acc[o + 1] += luma(d[p], d[p + 1], d[p + 2]);
      acc[o + 2] += d[p];
      acc[o + 3] += d[p + 1];
      acc[o + 4] += d[p + 2];
    });
    if (acc[0] === 0 || acc[5] === 0) return null;
    l0 = acc[1] / acc[0];
    l1 = acc[6] / acc[5];
  }
  const c0 = acc[0];
  const c1 = acc[5];
  const candidates = c0 + c1;
  if (Math.min(l0, l1) < CHECKER_MIN_LUMA || Math.abs(l0 - l1) < CHECKER_MIN_LEVEL_GAP) return null;
  if (candidates < CHECKER_MIN_CANDIDATES * bandCount || Math.min(c0, c1) < MIN_LEVEL_SHARE * candidates) return null;
  const rgb0: RGB = [Math.round(acc[2] / c0), Math.round(acc[3] / c0), Math.round(acc[4] / c0)];
  const rgb1: RGB = [Math.round(acc[7] / c1), Math.round(acc[8] / c1), Math.round(acc[9] / c1)];
  const lv: [number, number] = [l0, l1];

  // 3. Cell boundaries along the band: x from the top/bottom rows, y from the left/right columns.
  const len = Math.max(w, h);
  const vals = new Float64Array(len);
  const levels = new Int8Array(len);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < h; y++) {
    if (y >= CHECKER_BAND && y < h - CHECKER_BAND) continue;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      vals[x] = luma(d[p], d[p + 1], d[p + 2]);
      levels[x] = levelAt(d, p, l0, l1);
    }
    lineTransitions(vals, levels, w, lv, xs);
  }
  for (let x = 0; x < w; x++) {
    if (x >= CHECKER_BAND && x < w - CHECKER_BAND) continue;
    for (let y = 0; y < h; y++) {
      const p = (y * w + x) * 4;
      vals[y] = luma(d[p], d[p + 1], d[p + 2]);
      levels[y] = levelAt(d, p, l0, l1);
    }
    lineTransitions(vals, levels, h, lv, ys);
  }
  if (xs.length < 2 || ys.length < 2) return null;

  // 4. Period search: phase coherence on a grid fine enough for the whole span, then the
  //    parity of the best local maxima decides.
  const sx = subsample(xs);
  const sy = subsample(ys);
  const cs: number[] = [];
  const rs: number[] = [];
  for (let c = CHECKER_MIN_CELL; c <= CHECKER_MAX_CELL; c += Math.max(1e-3, (c * c) / (8 * len))) {
    cs.push(c);
    rs.push(coherence(sx, sy, c).r);
  }
  const maxima: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    if (rs[i] < MIN_COHERENCE) continue;
    if (i > 0 && rs[i] < rs[i - 1]) continue;
    if (i < cs.length - 1 && rs[i] < rs[i + 1]) continue;
    maxima.push(i);
  }
  maxima.sort((a, b) => rs[b] - rs[a] || a - b);

  let best: BakedCheckerboard | null = null;
  for (const i of maxima.slice(0, MAX_PERIOD_CANDIDATES)) {
    // Refine the period around the grid point with every boundary.
    const lo = i > 0 ? cs[i - 1] : cs[i];
    const hi = i < cs.length - 1 ? cs[i + 1] : cs[i];
    let bestC = cs[i];
    let bestFit = coherence(xs, ys, bestC);
    for (let j = 0; j <= 20; j++) {
      const c = lo + ((hi - lo) * j) / 20;
      const fit = coherence(xs, ys, c);
      if (fit.r > bestFit.r) {
        bestFit = fit;
        bestC = c;
      }
    }
    if (bestC < CHECKER_MIN_CELL || bestC > CHECKER_MAX_CELL) continue;
    const { ox, oy } = bestFit;
    let agree = 0;
    let total = 0;
    forEachBandPixel(w, h, CHECKER_BAND, (x, y) => {
      const k = levelAt(d, (y * w + x) * 4, l0, l1);
      if (k < 0) return;
      total++;
      const parity = (Math.floor((x + 0.5 - ox) / bestC) + Math.floor((y + 0.5 - oy) / bestC)) & 1;
      if (k === parity) agree++;
    });
    if (total === 0) continue;
    const swap = agree < total - agree;
    const ratio = Math.max(agree, total - agree) / total;
    if (ratio < CHECKER_MIN_MATCH || (best !== null && ratio <= best.borderMatchRatio)) continue;
    const det: BakedCheckerboard = {
      cell: bestC,
      offsetX: ox,
      offsetY: oy,
      levels: swap ? [[...rgb1], [...rgb0]] : [[...rgb0], [...rgb1]],
      borderMatchRatio: ratio,
    };
    if (borderCellsAgree(img, det)) best = det;
  }
  return best;
}

/**
 * Whole cells near the border (the two outer rings of cells, interior CELL_MARGIN px inside their
 * boundaries) must behave like a checkerboard, not just the 3 px band:
 * - >= CELL_PARITY_MATCH of their neutral pixels within tolerance of either level show the level of
 *   their cell parity. 45-degree stripes flip like a checkerboard along the top and left bands (band
 *   ratio up to 0.93) but split every cell diagonally: 0.66-0.87 over two rings; real boards 1.000
 *   (fixtures, clip_art, splash).
 * - the two cell classes of each parity ((even, even) with (odd, odd), (even, odd) with (odd, even))
 *   show the same level: the medians of their uniform cells (>= 80 % of the interior within tolerance
 *   of the cell median) differ by at most 2 * CHECKER_LEVEL_TOL. Grey gingham (255 / 230 / 205) has a
 *   perfect parity along a ring of even cells, but its (odd, odd) cells are a third level.
 */
function borderCellsAgree(img: RasterImage, det: BakedCheckerboard): boolean {
  const { width: w, height: h, data: d } = img;
  const c = det.cell;
  const ox = det.offsetX;
  const oy = det.offsetY;
  const glob = [luma(det.levels[0][0], det.levels[0][1], det.levels[0][2]), luma(det.levels[1][0], det.levels[1][1], det.levels[1][2])];
  const kx0 = Math.floor((0.5 - ox) / c);
  const kx1 = Math.floor((w - 0.5 - ox) / c);
  const ky0 = Math.floor((0.5 - oy) / c);
  const ky1 = Math.floor((h - 0.5 - oy) / c);
  const m = c >= 4 * CELL_MARGIN ? CELL_MARGIN : Math.floor(c / 4);
  const hist = new Uint32Array(256);
  const classMedians: [number[], number[], number[], number[]] = [[], [], [], []];
  let levelPixels = 0;
  let matching = 0;
  for (let ky = ky0; ky <= ky1; ky++) {
    for (let kx = kx0; kx <= kx1; kx++) {
      if (kx >= kx0 + CELL_RINGS && kx <= kx1 - CELL_RINGS && ky >= ky0 + CELL_RINGS && ky <= ky1 - CELL_RINGS) continue;
      const [xa, xb] = cellRange(kx, ox, c, m, w);
      const [ya, yb] = cellRange(ky, oy, c, m, h);
      if (xa > xb || ya > yb) continue;
      const area = (xb - xa + 1) * (yb - ya + 1);
      if (area < MIN_CELL_VOTE_PIXELS) continue;
      const parity = (kx + ky) & 1;
      hist.fill(0);
      let neutral = 0;
      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
          const p = (y * w + x) * 4;
          const r = d[p];
          const g = d[p + 1];
          const b = d[p + 2];
          if (Math.max(r, g, b) - Math.min(r, g, b) > CHECKER_NEUTRAL_SPREAD) continue;
          const v = luma(r, g, b);
          hist[Math.round(v)]++;
          neutral++;
          const d0 = Math.abs(v - glob[0]);
          const d1 = Math.abs(v - glob[1]);
          if (Math.min(d0, d1) > CHECKER_LEVEL_TOL) continue;
          levelPixels++;
          if ((parity === 0 ? d0 : d1) <= CHECKER_LEVEL_TOL) matching++;
        }
      }
      if (neutral === 0) continue;
      let v = 0;
      for (let acc = 0; v < 256; v++) {
        acc += hist[v];
        if (2 * acc >= neutral) break;
      }
      let within = 0;
      for (let u = Math.max(0, v - CHECKER_LEVEL_TOL); u <= Math.min(255, v + CHECKER_LEVEL_TOL); u++) within += hist[u];
      if (within >= UNIFORM_CELL_SHARE * area && v >= CHECKER_MIN_LUMA) classMedians[((kx & 1) << 1) | (ky & 1)].push(v);
    }
  }
  if (levelPixels > 0 && matching < CELL_PARITY_MATCH * levelPixels) return false;
  const median = (v: number[]): number => {
    const sorted = [...v].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };
  for (const [a, b] of [
    [0, 3],
    [1, 2],
  ]) {
    if (classMedians[a].length < 2 || classMedians[b].length < 2) continue;
    if (Math.abs(median(classMedians[a]) - median(classMedians[b])) > 2 * CHECKER_LEVEL_TOL) return false;
  }
  return true;
}

interface BakedLabels {
  /** 1 = background (checker). */
  mask: BinaryMask;
  /** For neutral pixels within tolerance of a local level: the parity whose level they show, else -1. */
  level: Int8Array;
}

/** Interior margin (px) of a cell used for its level statistics. */
const CELL_MARGIN = 2;
/** A cell's median is trusted when this share of its interior is neutral within tolerance of it. */
const CELL_CLEAN_SHARE = 0.5;
/** Max luma drift between nearby cells of the same parity (a glow or a shadow painted over the board). */
const CELL_DRIFT = 24;
/** Leftover pixels within this raw-RGB distance of a local level are pale (JPEG chroma specks and halos). */
const SPECKLE_TOL = 32;
/** 4-connected groups of pale pixels up to this many px that touch the background join it. */
const SPECKLE_MAX = 16;

/** Cell index per coordinate and whether it lies within BOUNDARY_MARGIN / BLEND_MARGIN of a boundary. */
function cellTable(n: number, offset: number, cell: number): { index: Int32Array; near: Uint8Array; blend: Uint8Array } {
  const index = new Int32Array(n);
  const near = new Uint8Array(n);
  const blend = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const u = i + 0.5 - offset;
    const k = Math.floor(u / cell);
    index[i] = k;
    const f = Math.min(u - k * cell, cell - (u - k * cell));
    near[i] = f < BOUNDARY_MARGIN ? 1 : 0;
    blend[i] = f < BLEND_MARGIN ? 1 : 0;
  }
  return { index, near, blend };
}

/** 4-neighbour erosion with outside = 0. */
function erode4(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (src[i] !== 0 && src[i - 1] !== 0 && src[i + 1] !== 0 && src[i - w] !== 0 && src[i + w] !== 0) out[i] = 1;
    }
  }
  return out;
}

/** Pixel range [a, b] (inclusive, clamped) of cell k along an axis, `m` px inside its boundaries. */
function cellRange(k: number, offset: number, cell: number, m: number, n: number): [number, number] {
  return [Math.max(0, Math.ceil(offset + k * cell + m - 0.5)), Math.min(n - 1, Math.floor(offset + (k + 1) * cell - m - 0.5))];
}

interface LevelField {
  cx0: number;
  cy0: number;
  ncx: number;
  ncy: number;
  /** field[p][cell] = luma of the level of parity p around that cell. */
  field: [Float32Array, Float32Array];
}

/**
 * Local luma of each parity's level at every cell (the board may be shaded by a glow or a
 * shadow). Cell median = median neutral luma of its interior, trusted when >= 50 % of the interior
 * is neutral within tolerance of it. Seeds: trusted cells within tolerance of their border level.
 * A trusted cell joins when a joined cell of its parity within 2 cells differs by <= CELL_DRIFT
 * and every joined 4-neighbour (the other parity) keeps the border level order at least
 * CHECKER_MIN_LEVEL_GAP apart (so a light shape covering several cells never joins). Each parity's
 * field is then filled everywhere by breadth-first averaging from its joined cells.
 */
function levelField(img: RasterImage, det: BakedCheckerboard): LevelField {
  const { width: w, height: h, data: d } = img;
  const c = det.cell;
  const ox = det.offsetX;
  const oy = det.offsetY;
  const cx0 = Math.floor((0.5 - ox) / c);
  const cy0 = Math.floor((0.5 - oy) / c);
  const ncx = Math.floor((w - 0.5 - ox) / c) - cx0 + 1;
  const ncy = Math.floor((h - 0.5 - oy) / c) - cy0 + 1;
  const cells = ncx * ncy;
  const glob = [luma(det.levels[0][0], det.levels[0][1], det.levels[0][2]), luma(det.levels[1][0], det.levels[1][1], det.levels[1][2])];
  const parityOf = (k: number): number => ((cx0 + (k % ncx)) + (cy0 + ((k / ncx) | 0))) & 1;

  // Median and trust of every cell.
  const med = new Float32Array(cells);
  const trusted = new Uint8Array(cells);
  const hist = new Uint32Array(256);
  const m = c >= 4 * CELL_MARGIN ? CELL_MARGIN : Math.floor(c / 4);
  for (let j = 0; j < ncy; j++) {
    let [ya, yb] = cellRange(cy0 + j, oy, c, m, h);
    if (ya > yb) [ya, yb] = cellRange(cy0 + j, oy, c, 0, h);
    for (let i = 0; i < ncx; i++) {
      let [xa, xb] = cellRange(cx0 + i, ox, c, m, w);
      if (xa > xb) [xa, xb] = cellRange(cx0 + i, ox, c, 0, w);
      if (xa > xb || ya > yb) continue;
      hist.fill(0);
      let neutral = 0;
      const total = (xb - xa + 1) * (yb - ya + 1);
      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
          const p = (y * w + x) * 4;
          const r = d[p];
          const g = d[p + 1];
          const b = d[p + 2];
          if (d[p + 3] < 128 || Math.max(r, g, b) - Math.min(r, g, b) > CHECKER_NEUTRAL_SPREAD) continue;
          hist[Math.round(luma(r, g, b))]++;
          neutral++;
        }
      }
      if (neutral === 0) continue;
      let v = 0;
      for (let acc = 0; v < 256; v++) {
        acc += hist[v];
        if (2 * acc >= neutral) break;
      }
      let within = 0;
      for (let u = Math.max(0, v - CHECKER_LEVEL_TOL); u <= Math.min(255, v + CHECKER_LEVEL_TOL); u++) within += hist[u];
      const k = j * ncx + i;
      med[k] = v;
      trusted[k] = within >= CELL_CLEAN_SHARE * total ? 1 : 0;
    }
  }

  // Join cells from the seeds.
  const joined = new Uint8Array(cells);
  const queued = new Uint8Array(cells);
  const queue: number[] = [];
  for (let k = 0; k < cells; k++) {
    if (trusted[k] !== 0 && Math.abs(med[k] - glob[parityOf(k)]) <= CHECKER_LEVEL_TOL) joined[k] = 1;
  }
  const pushAround = (k: number): void => {
    const i = k % ncx;
    const j = (k / ncx) | 0;
    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= ncx || jj >= ncy) continue;
        const n = jj * ncx + ii;
        if (joined[n] !== 0 || trusted[n] === 0 || queued[n] !== 0) continue;
        queued[n] = 1;
        queue.push(n);
      }
    }
  };
  for (let k = 0; k < cells; k++) if (joined[k] !== 0) pushAround(k);
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head];
    queued[k] = 0;
    if (joined[k] !== 0) continue;
    const i = k % ncx;
    const j = (k / ncx) | 0;
    const p = parityOf(k);
    let near = false;
    for (let dj = -2; dj <= 2 && !near; dj++) {
      for (let di = -2; di <= 2; di++) {
        if ((di + dj) % 2 !== 0 || (di === 0 && dj === 0)) continue;
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= ncx || jj >= ncy) continue;
        const n = jj * ncx + ii;
        if (joined[n] !== 0 && Math.abs(med[k] - med[n]) <= CELL_DRIFT) {
          near = true;
          break;
        }
      }
    }
    if (!near) continue;
    const order = glob[p] - glob[1 - p];
    let others = 0;
    let ordered = true;
    const check = (ii: number, jj: number): void => {
      if (ii < 0 || jj < 0 || ii >= ncx || jj >= ncy) return;
      const n = jj * ncx + ii;
      if (joined[n] === 0) return;
      others++;
      const diff = med[k] - med[n];
      if (diff * order <= 0 || Math.abs(diff) < CHECKER_MIN_LEVEL_GAP) ordered = false;
    };
    check(i - 1, j);
    check(i + 1, j);
    check(i, j - 1);
    check(i, j + 1);
    if (others === 0 || !ordered) continue;
    joined[k] = 1;
    pushAround(k);
  }

  // Fill each parity's field by breadth-first averaging from its joined cells.
  const field: [Float32Array, Float32Array] = [new Float32Array(cells), new Float32Array(cells)];
  const state = new Uint8Array(cells);
  for (let p = 0; p < 2; p++) {
    const F = field[p];
    state.fill(0);
    const q: number[] = [];
    for (let k = 0; k < cells; k++) {
      if (joined[k] !== 0 && parityOf(k) === p) {
        F[k] = med[k];
        state[k] = 2;
        q.push(k);
      }
    }
    if (q.length === 0) {
      F.fill(glob[p]);
      continue;
    }
    for (let head = 0; head < q.length; head++) {
      const k = q[head];
      const i = k % ncx;
      const j = (k / ncx) | 0;
      if (state[k] === 1) {
        let sum = 0;
        let cnt = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= ncx || jj >= ncy) continue;
            const n = jj * ncx + ii;
            if (state[n] === 2) {
              sum += F[n];
              cnt++;
            }
          }
        }
        F[k] = cnt > 0 ? sum / cnt : glob[p];
        state[k] = 2;
      }
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= ncx || jj >= ncy) continue;
          const n = jj * ncx + ii;
          if (state[n] === 0) {
            state[n] = 1;
            q.push(n);
          }
        }
      }
    }
  }
  return { cx0, cy0, ncx, ncy, field };
}

/** Bilinear interpolation indices between cell centres along one axis. */
function lerpTable(n: number, offset: number, cell: number, k0: number, count: number): { i0: Int32Array; i1: Int32Array; t: Float32Array } {
  const i0 = new Int32Array(n);
  const i1 = new Int32Array(n);
  const t = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    const f = (x + 0.5 - offset) / cell - 0.5 - k0;
    if (f <= 0) continue; // i0 = i1 = 0, t = 0
    if (f >= count - 1) {
      i0[x] = count - 1;
      i1[x] = count - 1;
      continue;
    }
    const a = Math.floor(f);
    i0[x] = a;
    i1[x] = a + 1;
    t[x] = f - a;
  }
  return { i0, i1, t };
}

/** First and last pixel of the cell of every coordinate along an axis (from its cell index table). */
function cellBounds(index: Int32Array): { start: Int32Array; end: Int32Array } {
  const n = index.length;
  const start = new Int32Array(n);
  const end = new Int32Array(n);
  for (let i = 0; i < n; i++) start[i] = i > 0 && index[i - 1] === index[i] ? start[i - 1] : i;
  for (let i = n - 1; i >= 0; i--) end[i] = i < n - 1 && index[i + 1] === index[i] ? end[i + 1] : i;
  return { start, end };
}

/**
 * A light shape that touches the checkerboard shows its level over the cells of the other parity
 * (violators, already in `shape` when thick) and is invisible over the cells of its own level: those
 * pixels match the board. Rebuilt per pixel of such a hidden cell from the shape pixels of the same
 * level 1 or 2 px beyond its boundaries, along its row (left L, right R) and column (up U, down D): the
 * pixel belongs to the shape when L && R, U && D, or (L || R) && (U || D) (exact for axis-aligned
 * edges and corners; a curved edge is approximated within the cell). Thin violator pieces (4 px across
 * or less, cell-edge noise when alone) join when 4-adjacent to the shape, and the projection runs
 * again, up to SHAPE_ROUNDS times. `shape` is updated in place.
 */
function reconstructLightShapes(
  w: number,
  h: number,
  level: Int8Array,
  mask: Uint8Array,
  shape: Uint8Array,
  colIndex: Int32Array,
  rowIndex: Int32Array,
  thinStart: number[],
  thinPixels: number[],
): void {
  const n = w * h;
  const cx = cellBounds(colIndex);
  const cy = cellBounds(rowIndex);
  const attached = new Uint8Array(Math.max(0, thinStart.length - 1));
  const accept = new Uint8Array(n);
  const ev = (x: number, y: number, k: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const j = y * w + x;
    return shape[j] !== 0 && level[j] === k;
  };
  for (let round = 0; round < SHAPE_ROUNDS; round++) {
    let changed = false;
    if (shape.some((v) => v !== 0)) {
      accept.fill(0);
      let any = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const k = level[i];
          if (mask[i] === 0 || shape[i] !== 0 || k < 0 || k !== ((colIndex[x] + rowIndex[y]) & 1)) continue;
          const xa = cx.start[x];
          const xb = cx.end[x];
          const ya = cy.start[y];
          const yb = cy.end[y];
          const L = ev(xa - 1, y, k) || ev(xa - 2, y, k);
          const R = ev(xb + 1, y, k) || ev(xb + 2, y, k);
          const U = ev(x, ya - 1, k) || ev(x, ya - 2, k);
          const D = ev(x, yb + 1, k) || ev(x, yb + 2, k);
          if ((L && R) || (U && D) || ((L || R) && (U || D))) {
            accept[i] = 1;
            any = true;
          }
        }
      }
      if (any) {
        for (let i = 0; i < n; i++) if (accept[i] !== 0) shape[i] = 1;
        changed = true;
      }
    }
    for (let c = 0; c < attached.length; c++) {
      if (attached[c] !== 0) continue;
      let touches = false;
      for (let t = thinStart[c]; t < thinStart[c + 1] && !touches; t++) {
        const i = thinPixels[t];
        const x = i % w;
        const k = level[i];
        touches =
          (x > 0 && shape[i - 1] !== 0 && level[i - 1] === k) ||
          (x < w - 1 && shape[i + 1] !== 0 && level[i + 1] === k) ||
          (i >= w && shape[i - w] !== 0 && level[i - w] === k) ||
          (i + w < n && shape[i + w] !== 0 && level[i + w] === k);
      }
      if (!touches) continue;
      attached[c] = 1;
      for (let t = thinStart[c]; t < thinStart[c + 1]; t++) shape[thinPixels[t]] = 1;
      changed = true;
    }
    if (!changed) break;
  }
}

function labelBaked(img: RasterImage, det: BakedCheckerboard): BakedLabels {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const lf = levelField(img, det);
  const lx = lerpTable(w, det.offsetX, det.cell, lf.cx0, lf.ncx);
  const ly = lerpTable(h, det.offsetY, det.cell, lf.cy0, lf.ncy);
  const expected = (p: number, x: number, y: number): number => {
    const F = lf.field[p];
    const r0 = ly.i0[y] * lf.ncx;
    const r1 = ly.i1[y] * lf.ncx;
    const tx = lx.t[x];
    const ty = ly.t[y];
    const top = F[r0 + lx.i0[x]] * (1 - tx) + F[r0 + lx.i1[x]] * tx;
    const bot = F[r1 + lx.i0[x]] * (1 - tx) + F[r1 + lx.i1[x]] * tx;
    return top * (1 - ty) + bot * ty;
  };

  const cols = cellTable(w, det.offsetX, det.cell);
  const rows = cellTable(h, det.offsetY, det.cell);
  // The border levels still hold where the field extrapolates past the outermost cell centres (a
  // glow brightens a cell's inner side, and its median, but not the image edge).
  const g0 = luma(det.levels[0][0], det.levels[0][1], det.levels[0][2]);
  const g1 = luma(det.levels[1][0], det.levels[1][1], det.levels[1][2]);
  // Level shown by every neutral pixel near its local (or border) levels (-1 otherwise). Next to a cell
  // boundary the resampled or JPEG-blurred edge blends both levels and rings past them: any luma
  // between them, with twice the tolerance outside, counts.
  const level = new Int8Array(n).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r = d[p];
      const g = d[p + 1];
      const b = d[p + 2];
      if (d[p + 3] < 128 || Math.max(r, g, b) - Math.min(r, g, b) > CHECKER_NEUTRAL_SPREAD) continue;
      const v = luma(r, g, b);
      const e0 = expected(0, x, y);
      const e1 = expected(1, x, y);
      const d0 = Math.min(Math.abs(v - e0), Math.abs(v - g0));
      const d1 = Math.min(Math.abs(v - e1), Math.abs(v - g1));
      const k = d0 <= d1 ? 0 : 1;
      if (Math.min(d0, d1) <= CHECKER_LEVEL_TOL) {
        level[y * w + x] = k;
      } else if (
        (cols.blend[x] !== 0 || rows.blend[y] !== 0) &&
        v >= Math.min(e0, e1, g0, g1) - 2 * CHECKER_LEVEL_TOL &&
        v <= Math.max(e0, e1, g0, g1) + 2 * CHECKER_LEVEL_TOL
      ) {
        level[y * w + x] = k;
      }
    }
  }

  // Candidate components (4-connected, both levels together).
  const mask = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (level[s] < 0 || seen[s] !== 0) continue;
    let tail = 0;
    queue[tail++] = s;
    seen[s] = 1;
    let touches = false;
    let interior = 0;
    let matches = 0;
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const x = i % w;
      const y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      if (cols.near[x] === 0 && rows.near[y] === 0) {
        interior++;
        if (level[i] === ((cols.index[x] + rows.index[y]) & 1)) matches++;
      }
      if (x > 0 && level[i - 1] >= 0 && seen[i - 1] === 0) {
        seen[i - 1] = 1;
        queue[tail++] = i - 1;
      }
      if (x < w - 1 && level[i + 1] >= 0 && seen[i + 1] === 0) {
        seen[i + 1] = 1;
        queue[tail++] = i + 1;
      }
      if (y > 0 && level[i - w] >= 0 && seen[i - w] === 0) {
        seen[i - w] = 1;
        queue[tail++] = i - w;
      }
      if (y < h - 1 && level[i + w] >= 0 && seen[i + w] === 0) {
        seen[i + w] = 1;
        queue[tail++] = i + w;
      }
    }
    const background = touches || interior === 0 || matches >= CHECKER_COMPONENT_MATCH * interior;
    if (background) for (let j = 0; j < tail; j++) mask[queue[j]] = 1;
  }

  // Inside the background, thick blobs that break the parity are genuine light shapes (a white
  // shape touching the checkerboard); thin ones (<= 4 px across) are cell-edge noise.
  const violators = new Uint8Array(n);
  let anyViolator = false;
  for (let i = 0; i < n; i++) {
    if (mask[i] !== 0 && level[i] !== ((cols.index[i % w] + rows.index[(i / w) | 0]) & 1)) {
      violators[i] = 1;
      anyViolator = true;
    }
  }
  if (anyViolator) {
    const core = erode4(erode4(violators, w, h), w, h);
    seen.fill(0);
    // Violator components: thick ones seed the shape; thin ones are kept later only when attached to it.
    const shape = new Uint8Array(n);
    const thinStart: number[] = [];
    const thinPixels: number[] = [];
    for (let s = 0; s < n; s++) {
      if (violators[s] === 0 || seen[s] !== 0) continue;
      let tail = 0;
      queue[tail++] = s;
      seen[s] = 1;
      let thick = false;
      for (let head = 0; head < tail; head++) {
        const i = queue[head];
        if (core[i] !== 0) thick = true;
        const x = i % w;
        if (x > 0 && violators[i - 1] !== 0 && seen[i - 1] === 0) {
          seen[i - 1] = 1;
          queue[tail++] = i - 1;
        }
        if (x < w - 1 && violators[i + 1] !== 0 && seen[i + 1] === 0) {
          seen[i + 1] = 1;
          queue[tail++] = i + 1;
        }
        if (i >= w && violators[i - w] !== 0 && seen[i - w] === 0) {
          seen[i - w] = 1;
          queue[tail++] = i - w;
        }
        if (i + w < n && violators[i + w] !== 0 && seen[i + w] === 0) {
          seen[i + w] = 1;
          queue[tail++] = i + w;
        }
      }
      if (thick) {
        for (let j = 0; j < tail; j++) shape[queue[j]] = 1;
      } else {
        thinStart.push(thinPixels.length);
        for (let j = 0; j < tail; j++) thinPixels.push(queue[j]);
      }
    }
    thinStart.push(thinPixels.length);
    if (thinStart.length > 1 || shape.some((v) => v !== 0)) reconstructLightShapes(w, h, level, mask, shape, cols.index, rows.index, thinStart, thinPixels);
    for (let i = 0; i < n; i++) if (shape[i] !== 0) mask[i] = 0;
  }

  // JPEG specks: small 4-connected groups of pale leftover pixels (not candidates, within
  // SPECKLE_TOL of a local level: chroma noise past the neutral spread) touching the background.
  const pale = new Uint8Array(n);
  const tol2 = SPECKLE_TOL * SPECKLE_TOL;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;
      if (mask[i] !== 0 || level[i] >= 0 || d[p + 3] < 128) continue;
      const e0 = expected(0, x, y);
      const e1 = expected(1, x, y);
      const r = d[p];
      const g = d[p + 1];
      const b = d[p + 2];
      const d0 = (r - e0) ** 2 + (g - e0) ** 2 + (b - e0) ** 2;
      const d1 = (r - e1) ** 2 + (g - e1) ** 2 + (b - e1) ** 2;
      if (Math.min(d0, d1) <= tol2) pale[i] = 1;
    }
  }
  seen.fill(0);
  for (let s = 0; s < n; s++) {
    if (pale[s] === 0 || seen[s] !== 0) continue;
    let tail = 0;
    queue[tail++] = s;
    seen[s] = 1;
    let touches = false;
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const x = i % w;
      const y = (i / w) | 0;
      if ((x > 0 && mask[i - 1] !== 0) || (x < w - 1 && mask[i + 1] !== 0) || (y > 0 && mask[i - w] !== 0) || (y < h - 1 && mask[i + w] !== 0)) {
        touches = true;
      }
      if (x > 0 && pale[i - 1] !== 0 && seen[i - 1] === 0) {
        seen[i - 1] = 1;
        queue[tail++] = i - 1;
      }
      if (x < w - 1 && pale[i + 1] !== 0 && seen[i + 1] === 0) {
        seen[i + 1] = 1;
        queue[tail++] = i + 1;
      }
      if (y > 0 && pale[i - w] !== 0 && seen[i - w] === 0) {
        seen[i - w] = 1;
        queue[tail++] = i - w;
      }
      if (y < h - 1 && pale[i + w] !== 0 && seen[i + w] === 0) {
        seen[i + w] = 1;
        queue[tail++] = i + w;
      }
    }
    if (touches && tail <= SPECKLE_MAX) for (let j = 0; j < tail; j++) mask[queue[j]] = 1;
  }
  return { mask: { data: mask, width: w, height: h }, level };
}

/**
 * Background of a detected checkerboard, 1 = background. The level of each parity is tracked
 * locally (cell medians joined from the border, see levelField, interpolated between cell centres),
 * so a glow or a shadow painted over the board does not break it. Candidates are the neutral
 * pixels within +-8 luma of either local level (or of the border level of that parity), grouped in 4-connected components: a component is
 * background when it touches the image border or when >= 90 % of its pixels away from the cell
 * edges show the level their cell parity expects (a counter showing several cells, or a light hole
 * whose level matches every cell it covers); a light shape that breaks the parity is kept. Inside
 * the background, blobs that break the parity and are thicker than 4 px (a genuine light shape
 * touching the checkerboard) are kept too, and pale specks (groups of up to 16 px within 32 raw RGB
 * of a local level: JPEG chroma noise) that touch it join it.
 */
export function bakedBackgroundMask(img: RasterImage, det: BakedCheckerboard): BinaryMask {
  return labelBaked(img, det).mask;
}

/**
 * Copy of `img` with the checkerboard background transparent (RGBA 0,0,0,0). The anti-aliased
 * fringe (non-candidate pixels within 2 px of the background) gets its alpha estimated against the
 * local checker level L (mean of the background pixels in its 5x5 window) and the local ink I (the
 * non-background pixel of that window farthest from L): alpha = projection of the pixel on L -> I,
 * colour I; estimates >= 0.95 (or ink closer than 24 to L) leave the pixel as it was.
 */
export function applyBakedBackground(img: RasterImage, det: BakedCheckerboard): RasterImage {
  const { width: w, height: h, data: d } = img;
  const { mask, level } = labelBaked(img, det);
  const m = mask.data;
  const out = new Uint8ClampedArray(d);
  for (let i = 0, p = 0; i < m.length; i++, p += 4) {
    if (m[i] !== 0) {
      out[p] = 0;
      out[p + 1] = 0;
      out[p + 2] = 0;
      out[p + 3] = 0;
    }
  }

  // Pixels within FRINGE_RADIUS (Chebyshev) of the background: separable running counts.
  const R = FRINGE_RADIUS;
  const rowCount = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let run = 0;
    for (let x = 0; x < Math.min(w, R + 1); x++) run += m[o + x];
    for (let x = 0; x < w; x++) {
      rowCount[o + x] = run;
      if (x + R + 1 < w) run += m[o + x + R + 1];
      if (x - R >= 0) run -= m[o + x - R];
    }
  }
  const near = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y < Math.min(h, R + 1); y++) run += rowCount[y * w + x];
    for (let y = 0; y < h; y++) {
      if (run > 0) near[y * w + x] = 1;
      if (y + R + 1 < h) run += rowCount[(y + R + 1) * w + x];
      if (y - R >= 0) run -= rowCount[(y - R) * w + x];
    }
  }

  const minContrast2 = FRINGE_MIN_CONTRAST * FRINGE_MIN_CONTRAST;
  const maxResidual2 = FRINGE_MAX_RESIDUAL * FRINGE_MAX_RESIDUAL;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;
      if (near[i] === 0 || m[i] !== 0 || level[i] >= 0 || d[p + 3] < 128) continue;
      let lr = 0;
      let lg = 0;
      let lb = 0;
      let lc = 0;
      const y0 = Math.max(0, y - R);
      const y1 = Math.min(h - 1, y + R);
      const x0 = Math.max(0, x - R);
      const x1 = Math.min(w - 1, x + R);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const j = yy * w + xx;
          if (m[j] === 0) continue;
          const q = j * 4;
          lr += d[q];
          lg += d[q + 1];
          lb += d[q + 2];
          lc++;
        }
      }
      if (lc === 0) continue;
      lr /= lc;
      lg /= lc;
      lb /= lc;
      // The ink: the window's opaque non-background pixel farthest from L whose blend with L explains P
      // (P itself qualifies with a = 1). Nothing explains P: it is ink of its own, left untouched.
      const pr = d[p] - lr;
      const pg = d[p + 1] - lg;
      const pb = d[p + 2] - lb;
      let far = 0;
      let a = 1;
      let ir = d[p];
      let ig = d[p + 1];
      let ib = d[p + 2];
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const j = yy * w + xx;
          const q = j * 4;
          if (m[j] !== 0 || d[q + 3] < 128) continue;
          const er = d[q] - lr;
          const eg = d[q + 1] - lg;
          const eb = d[q + 2] - lb;
          const dist = er * er + eg * eg + eb * eb;
          if (dist < minContrast2 || dist <= far) continue;
          const t = Math.min(1, Math.max(0, (pr * er + pg * eg + pb * eb) / dist));
          const residual2 = (pr - t * er) ** 2 + (pg - t * eg) ** 2 + (pb - t * eb) ** 2;
          if (residual2 > maxResidual2) continue;
          far = dist;
          a = t;
          ir = d[q];
          ig = d[q + 1];
          ib = d[q + 2];
        }
      }
      if (far === 0 || a >= FRINGE_OPAQUE) continue;
      const alpha = a <= 0 ? 0 : Math.round(a * 255);
      if (alpha === 0) {
        out[p] = 0;
        out[p + 1] = 0;
        out[p + 2] = 0;
        out[p + 3] = 0;
      } else {
        out[p] = ir;
        out[p + 1] = ig;
        out[p + 2] = ib;
        out[p + 3] = alpha;
      }
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * The image the pipeline, the analysis and the fidelity metrics work on: `img` itself unless the
 * analysis applied a checkerboard (info.bakedBackground) and the parameters do not ask to keep it,
 * in which case applyBakedBackground(img, info.bakedBackground).
 */
export function effectiveSource(
  img: RasterImage,
  info: Pick<SourceInfo, 'bakedBackground'>,
  params: { bakedBackground?: BakedBackgroundSetting },
): RasterImage {
  const det = info.bakedBackground ?? null;
  if (det === null || params.bakedBackground === 'keep') return img;
  return applyBakedBackground(img, det);
}
