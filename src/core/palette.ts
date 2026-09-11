/**
 * Palette extraction and colour assignment for flat mode. Pure; never mutates inputs.
 *
 * Two colour distances are used on purpose:
 *  - the geometric rules of exactPalette (anti-alias exclusion, cluster merge) use the plain
 *    Euclidean RGB distance, because the contract states its tolerance ("distancia 12") in raw
 *    RGB units;
 *  - nearest-colour assignment (kmeansRefine, assignLabels) uses the weighted distance
 *    (0.5054, 0.9925, 0.4342) · Δ from the contract (colorDistance2).
 *
 * All histograms are 5-bit per channel (32 768 bins) and keep the real per-bin colour sums, so
 * every returned colour is a true average of source pixels, not a bin centre.
 */
import type { LabelMap, RasterImage, RGB } from '../types';
import { borderModeColor } from './raster';

const BINS = 32768;

const W_R = 0.5054;
const W_G = 0.9925;
const W_B = 0.4342;
const W_R2 = W_R * W_R;
const W_G2 = W_G * W_G;
const W_B2 = W_B * W_B;

/** Population (fraction of counted pixels) a 5-bit colour needs to count as "present". */
export const MIN_COLOR_RATIO = 0.0005;
/** Default cap for exactPalette. */
export const EXACT_MAX_COLORS = 32;
/**
 * Spatial coherence (replaces the old 0.5 % population floor): a palette cluster survives when it
 * has at least max(MIN_CORE_PIXELS, MIN_CORE_RATIO of the counted pixels) CORE pixels, i.e. pixels
 * labelled with it (nearest centre, weighted) whose 8 neighbours all carry that label (clamped at
 * the image edge; transparent neighbours never match). JPEG ringing bands and chroma specks are
 * 1-2 px wide and have (almost) no core; a small solid accent (the orange fish of clip_art, 0.4 %)
 * keeps its interior. Measured (see ARCHITECTURE.md): with 7 of 8 neighbours the clip_art ringing
 * band kept 33 core px and survived; a colour tolerance to the centre (24 or 48) never changed that
 * decision but dropped real gradient steps (eagle, noisePhoto at 24) and emptied compromise
 * clusters (flatShapes3 asked for 2 colours returned 1 at 48), so there is none.
 */
export const MIN_CORE_PIXELS = 12;
export const MIN_CORE_RATIO = 0.0002;
/**
 * ...and its core must also be at least this fraction of the pixels labelled with it: once the
 * small noise clusters are gone the ringing band owns long contiguous stretches (clip_art without
 * its checkerboard: 44 core px of 1 084, 0.04). Measured core fractions: ringing bands 0.010-0.026;
 * real clusters >= 0.142 (noisePhoto seed 2; eagle 0.169; clip_art magenta 0.27, orange 0.32-0.56).
 */
export const MIN_CORE_FRACTION = 0.05;
/**
 * Exception to the coherence rule for thin or small DISTINCT features: a cluster without enough core
 * survives when one 8-connected piece holds at least max(MIN_CORE_PIXELS, MIN_STRUCTURE_SHARE of its
 * labelled pixels) AND its colour is at least DISTINCT_DISTANCE (weighted) from every coherent
 * cluster. A 1-2 px outline has no pixel with 8 neighbours of its colour, like a JPEG ringing band,
 * and a 5 px accent has only ~4 core px; dropping them repainted a dark outline in the fill colour
 * (and a two-ink sticker became a one-colour line drawing). What still goes: ringing is a shade of
 * the ink it rings (measured weighted distance 21-22 on clip_art, 34 for the synthetic 1 px band)
 * and halo or speck remnants are fragmented (clip_art without its checkerboard: a pale (253,226,248)
 * cluster of 130 px in 38 pieces, largest 28, at distance 99; ringing 1 453 px, largest piece 99).
 * Kept: the 1.5 px dark ring of a yellow sticker (one piece, distance 221), a 16 px red dot on a
 * 48 px icon (distance 101 from its navy disc).
 */
export const DISTINCT_DISTANCE = 60;
export const MIN_STRUCTURE_SHARE = 0.5;
/** Weighted colour distance below which two median-cut / k-means clusters are merged. */
export const MERGE_DISTANCE = 20;
/** Default number of pixels sampled (deterministic stride) by the sample-based helpers. */
const DEFAULT_SAMPLE = 20000;
/** Raw-RGB distance: same cluster (<= tol from a dominant) or an AA blend (< tol from a segment). */
const CLUSTER_TOL = 12;
const CLUSTER_TOL2 = CLUSTER_TOL * CLUSTER_TOL;
/** Sub-threshold bins farther than this from every dominant colour are ignored (stray specks). */
const STRAY_TOL2 = 24 * 24;
const AA_T_MIN = 0.15;
const AA_T_MAX = 0.85;
/**
 * Near the ends of a segment (t outside (0.15, 0.85) but still inside (0, 1)) a colour on the
 * segment is still a blend when it is rare compared with both endpoints: anti-aliasing is a
 * perimeter effect, flat regions are areas. Ratio of the smaller endpoint's population.
 */
const AA_END_POP_RATIO = 0.05;
/** Raw-RGB max-channel difference above which two 4-neighbours form an edge. */
const EDGE_DIFF = 32;
/**
 * A colour whose pixels hug edges (this fraction of them touch an edge) is a band — the
 * anti-aliasing or JPEG halo of thin strokes, whose population can rival the ink itself — not
 * a region. Only applied to colours that already lie on a segment between two dominants.
 */
const BAND_EDGE_FRACTION = 0.5;
/**
 * Spatial anti-aliasing test: a colour on a segment between two dominants is a blend when at
 * least this fraction of its pixels are RAMP pixels — their colour lies between two opposite
 * 8-neighbours (horizontal, vertical or a diagonal), i.e. on a transition. Large or contiguous
 * regions have almost none (their pixels are surrounded by their own colour). Measured
 * fraction per 5-bit bin: genuine grey regions on a white-black segment 0.00-0.01; AA bins of
 * flatShapes3 / aaCircle / glyph / the Compartamos avatar 1.00; JPEG AA of clip_art 0.73-0.88;
 * the posterised grey steps of the splash gradient 0.01-0.72.
 */
export const AA_RAMP_FRACTION = 0.6;
/** Opposite neighbours must differ by at least this (raw RGB) for the pixel between them to be a ramp pixel. */
const RAMP_MIN_SPAN2 = (2 * CLUSTER_TOL) * (2 * CLUSTER_TOL);
/** ... and the pixel must project at least this far (raw RGB) from both of them along the segment. */
const RAMP_MARGIN = 4;
/** Raw-RGB distance above which a pixel counts as "off the palette" (offPaletteRatio). */
export const OFF_PALETTE_TOL = 24;

// ---------------------------------------------------------------------------------------------
// Basic helpers
// ---------------------------------------------------------------------------------------------

/** Weighted squared distance: (0.5054·ΔR)² + (0.9925·ΔG)² + (0.4342·ΔB)². */
export function colorDistance2(a: RGB, b: RGB): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return W_R2 * dr * dr + W_G2 * dg * dg + W_B2 * db * db;
}

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function hex2(v: number): string {
  const n = clampByte(v);
  return (n < 16 ? '0' : '') + n.toString(16);
}

/** '#rrggbb', lowercase. Components are rounded and clamped to 0..255. */
export function toHex(c: RGB): string {
  return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
}

function quantKey(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

// ---------------------------------------------------------------------------------------------
// 5-bit histogram (typed arrays; the Map form is only built on request)
// ---------------------------------------------------------------------------------------------

interface BinHist {
  counts: Uint32Array; // BINS
  sums: Float64Array; // BINS * 3 (r, g, b)
  total: number; // pixels counted
}

/**
 * bg === null: pixels with alpha < 128 are ignored, the rest use their raw RGB.
 * bg !== null: every pixel is composited over bg (same rounding as compositeOnColor).
 */
function binHistogram(img: RasterImage, bg: RGB | null): BinHist {
  const d = img.data;
  const n = Math.min(img.width * img.height, d.length >> 2);
  const counts = new Uint32Array(BINS);
  const sums = new Float64Array(BINS * 3);
  let total = 0;
  if (bg === null) {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (d[p + 3] < 128) continue;
      const r = d[p];
      const g = d[p + 1];
      const b = d[p + 2];
      const k = quantKey(r, g, b);
      counts[k]++;
      const s = k * 3;
      sums[s] += r;
      sums[s + 1] += g;
      sums[s + 2] += b;
      total++;
    }
  } else {
    const br = clampByte(bg[0]);
    const bgc = clampByte(bg[1]);
    const bb = clampByte(bg[2]);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const a = d[p + 3];
      let r: number;
      let g: number;
      let b: number;
      if (a === 255) {
        r = d[p];
        g = d[p + 1];
        b = d[p + 2];
      } else if (a === 0) {
        r = br;
        g = bgc;
        b = bb;
      } else {
        const ia = 255 - a;
        r = ((d[p] * a + br * ia + 127) / 255) | 0;
        g = ((d[p + 1] * a + bgc * ia + 127) / 255) | 0;
        b = ((d[p + 2] * a + bb * ia + 127) / 255) | 0;
      }
      const k = quantKey(r, g, b);
      counts[k]++;
      const s = k * 3;
      sums[s] += r;
      sums[s + 1] += g;
      sums[s + 2] += b;
      total++;
    }
  }
  return { counts, sums, total };
}

/**
 * 5-bit histogram as a Map keyed by (r>>3)<<10 | (g>>3)<<5 | (b>>3), ascending key order.
 * `sum` holds the real per-channel sums of the member pixels. With bg === null pixels with
 * alpha < 128 are ignored; with a bg every pixel is composited over it first.
 */
export function quantizedHistogram(
  img: RasterImage,
  bg: RGB | null,
): Map<number, { count: number; sum: [number, number, number] }> {
  const h = binHistogram(img, bg);
  const out = new Map<number, { count: number; sum: [number, number, number] }>();
  for (let k = 0; k < BINS; k++) {
    const c = h.counts[k];
    if (c === 0) continue;
    const s = k * 3;
    out.set(k, { count: c, sum: [h.sums[s], h.sums[s + 1], h.sums[s + 2]] });
  }
  return out;
}

/** Number of 5-bit colours whose population is >= minRatio of the counted (alpha >= 128) pixels. */
export function distinctColorCount(img: RasterImage, minRatio = MIN_COLOR_RATIO): number {
  const h = binHistogram(img, null);
  if (h.total === 0) return 0;
  const min = (Number.isFinite(minRatio) && minRatio > 0 ? minRatio : 0) * h.total;
  let n = 0;
  const counts = h.counts;
  for (let k = 0; k < BINS; k++) if (counts[k] > 0 && counts[k] >= min) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// exactPalette
// ---------------------------------------------------------------------------------------------

/**
 * Per 5-bit bin: number of its pixels (alpha >= 128) that touch an edge, i.e. have a
 * 4-neighbour (alpha >= 128) whose max-channel raw difference exceeds EDGE_DIFF.
 */
function edgePixelsPerBin(img: RasterImage): Uint32Array {
  const { width: w, height: h, data: d } = img;
  const n = Math.min(w * h, d.length >> 2);
  const flag = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      if (p >= n) break;
      const o = p * 4;
      if (d[o + 3] < 128) continue;
      if (x + 1 < w && p + 1 < n && d[o + 7] >= 128) {
        const dr = Math.abs(d[o] - d[o + 4]);
        const dg = Math.abs(d[o + 1] - d[o + 5]);
        const db = Math.abs(d[o + 2] - d[o + 6]);
        if (dr > EDGE_DIFF || dg > EDGE_DIFF || db > EDGE_DIFF) {
          flag[p] = 1;
          flag[p + 1] = 1;
        }
      }
      const q = p + w;
      if (y + 1 < h && q < n) {
        const oq = q * 4;
        if (d[oq + 3] >= 128) {
          const dr = Math.abs(d[o] - d[oq]);
          const dg = Math.abs(d[o + 1] - d[oq + 1]);
          const db = Math.abs(d[o + 2] - d[oq + 2]);
          if (dr > EDGE_DIFF || dg > EDGE_DIFF || db > EDGE_DIFF) {
            flag[p] = 1;
            flag[q] = 1;
          }
        }
      }
    }
  }
  const out = new Uint32Array(BINS);
  for (let p = 0; p < n; p++) {
    if (flag[p] === 0) continue;
    const o = p * 4;
    out[quantKey(d[o], d[o + 1], d[o + 2])]++;
  }
  return out;
}

/**
 * Per 5-bit bin: number of its pixels (alpha >= 128) that are ramp pixels: for one of the four
 * axes through the pixel (horizontal, vertical, both diagonals) the two opposite neighbours are
 * opaque, differ by >= 2·CLUSTER_TOL and the pixel's colour lies within CLUSTER_TOL of the
 * segment between them, strictly inside it (>= RAMP_MARGIN from both ends).
 */
function rampPixelsPerBin(img: RasterImage): Uint32Array {
  const { width: w, height: h, data: d } = img;
  const out = new Uint32Array(BINS);
  if (d.length < w * h * 4) return out;
  const AX = [1, 0, 1, 1];
  const AY = [0, 1, 1, -1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (d[o + 3] < 128) continue;
      for (let a = 0; a < 4; a++) {
        const x1 = x - AX[a];
        const y1 = y - AY[a];
        const x2 = x + AX[a];
        const y2 = y + AY[a];
        if (x1 < 0 || x2 >= w || y1 < 0 || y1 >= h || y2 < 0 || y2 >= h) continue;
        const o1 = (y1 * w + x1) * 4;
        const o2 = (y2 * w + x2) * 4;
        if (d[o1 + 3] < 128 || d[o2 + 3] < 128) continue;
        const sr = d[o2] - d[o1];
        const sg = d[o2 + 1] - d[o1 + 1];
        const sb = d[o2 + 2] - d[o1 + 2];
        const l2 = sr * sr + sg * sg + sb * sb;
        if (l2 < RAMP_MIN_SPAN2) continue;
        const ur = d[o] - d[o1];
        const ug = d[o + 1] - d[o1 + 1];
        const ub = d[o + 2] - d[o1 + 2];
        const len = Math.sqrt(l2);
        const along = (ur * sr + ug * sg + ub * sb) / len;
        if (along < RAMP_MARGIN || along > len - RAMP_MARGIN) continue;
        if (ur * ur + ug * ug + ub * ub - along * along >= CLUSTER_TOL2) continue;
        out[quantKey(d[o], d[o + 1], d[o + 2])]++;
        break;
      }
    }
  }
  return out;
}

/**
 * True when (pr,pg,pb) is an anti-aliasing blend of two dominant colours: it lies within
 * CLUSTER_TOL of the segment between them, strictly inside it (0 < t < 1), and either
 *  - it is spatially a transition: `rampFrac` >= AA_RAMP_FRACTION of its pixels are ramp
 *    pixels (see rampPixelsPerBin) — the only test in the middle of the segment
 *    (AA_T_MIN < t < AA_T_MAX), where a genuine colour (a grey between black and white) is
 *    as likely as a blend and population says nothing; or
 *  - near an end of the segment (t outside that window), it is rare (population below
 *    AA_END_POP_RATIO of the smaller endpoint's) or a band (`edgeFrac` of its pixels touch an
 *    edge, see BAND_EDGE_FRACTION: JPEG halos of thin strokes).
 */
function isBlend(
  pr: number,
  pg: number,
  pb: number,
  count: number,
  edgeFrac: number,
  rampFrac: number,
  dom: Float64Array,
  domCount: Float64Array,
  nDom: number,
): boolean {
  for (let i = 0; i < nDom; i++) {
    const ar = dom[i * 3];
    const ag = dom[i * 3 + 1];
    const ab = dom[i * 3 + 2];
    const par = pr - ar;
    const pag = pg - ag;
    const pab = pb - ab;
    const pa2 = par * par + pag * pag + pab * pab;
    for (let j = i + 1; j < nDom; j++) {
      const abr = dom[j * 3] - ar;
      const abg = dom[j * 3 + 1] - ag;
      const abb = dom[j * 3 + 2] - ab;
      const l2 = abr * abr + abg * abg + abb * abb;
      if (l2 === 0) continue;
      const t = (par * abr + pag * abg + pab * abb) / l2;
      if (t <= 0 || t >= 1) continue;
      const perp2 = pa2 - t * t * l2;
      if (perp2 >= CLUSTER_TOL2) continue;
      if (rampFrac >= AA_RAMP_FRACTION) return true;
      if (t > AA_T_MIN && t < AA_T_MAX) continue;
      const smaller = domCount[i] < domCount[j] ? domCount[i] : domCount[j];
      if (count < AA_END_POP_RATIO * smaller) return true;
      if (edgeFrac >= BAND_EDGE_FRACTION) return true;
    }
  }
  return false;
}

/** Index of the nearest dominant (Euclidean) and its squared distance; -1 when there is none. */
function nearestDominant(
  pr: number,
  pg: number,
  pb: number,
  dom: Float64Array,
  nDom: number,
): { index: number; dist2: number } {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < nDom; i++) {
    const dr = pr - dom[i * 3];
    const dg = pg - dom[i * 3 + 1];
    const db = pb - dom[i * 3 + 2];
    const d2 = dr * dr + dg * dg + db * db;
    if (d2 < bestD) {
      bestD = d2;
      best = i;
    }
  }
  return { index: best, dist2: bestD };
}

export interface ExactPaletteResult {
  /** Real average colour of each cluster, most populous first. */
  colors: RGB[];
  /** Pixels (alpha >= 128) attributed to each colour, same order as `colors`. */
  counts: number[];
  /** Pixels counted (alpha >= 128). */
  total: number;
}

/**
 * Exact palette of a flat-colour image with per-colour populations, or null when the image
 * has more than `maxColors` real colours AFTER anti-aliasing exclusion (photo-like).
 *
 * Algorithm: candidate bins (population >= 0.05 %) are visited by decreasing population.
 * A candidate within 12 (raw RGB) of an accepted dominant colour joins its cluster; a candidate
 * within 12 of the segment between two dominants (0 < t < 1) is an anti-aliasing blend and is
 * excluded when >= 60 % of its pixels are ramp pixels lying between two opposite neighbours
 * (AA_RAMP_FRACTION — contiguous regions are real colours, whatever their t), or, near the ends
 * of the segment only, when it is rare next to both endpoints (AA_END_POP_RATIO) or a band whose
 * pixels hug edges (BAND_EDGE_FRACTION); anything else becomes a new dominant colour — the (maxColors + 1)-th dominant makes the result null. Then
 * every non-empty bin (including sub-threshold ones, unless they are blends or stray specks) is
 * added to its nearest cluster, clusters closer than MERGE_DISTANCE (weighted) are merged,
 * clusters without spatial coherence — fewer than max(MIN_CORE_PIXELS, minCoreRatio of the counted
 * pixels) core pixels or a core under MIN_CORE_FRACTION of their labelled pixels, see
 * MIN_CORE_PIXELS; a non-positive ratio disables the rule — are dropped
 * (their pixels are counted for the nearest surviving cluster, whose colour stays its own mean;
 * the largest cluster always survives) and the real averages are returned, most populous first. Candidate bins need >= 0.05 % of the counted
 * pixels and at least MIN_CORE_PIXELS px.
 *
 * Empty image (no pixel with alpha >= 128) -> { colors: [], counts: [], total: 0 }. Pixels
 * with alpha < 128 are ignored.
 */
export function exactPaletteDetailed(
  img: RasterImage,
  maxColors = EXACT_MAX_COLORS,
  minCoreRatio = MIN_CORE_RATIO,
): ExactPaletteResult | null {
  const h = binHistogram(img, null);
  if (h.total === 0) return { colors: [], counts: [], total: 0 };
  const counts = h.counts;
  const sums = h.sums;
  // A colour with fewer pixels than MIN_CORE_PIXELS can never be coherent on its own: on a small
  // opaque area (a logo on transparency) 0.05 % is a couple of px and JPEG noise bins would fill the cap.
  const minPop = Math.max(MIN_COLOR_RATIO * h.total, MIN_CORE_PIXELS);
  const cap = Number.isFinite(maxColors) ? Math.max(0, Math.floor(maxColors)) : EXACT_MAX_COLORS;

  const candidates: number[] = [];
  for (let k = 0; k < BINS; k++) if (counts[k] > 0 && counts[k] >= minPop) candidates.push(k);
  if (candidates.length === 0) return null; // pure noise: nothing reaches 0.05 %
  candidates.sort((a, b) => counts[b] - counts[a] || a - b);

  const maxDom = Math.min(candidates.length, cap);
  const dom = new Float64Array(maxDom * 3);
  const domCount = new Float64Array(maxDom); // population of each dominant's own bin
  let nDom = 0;
  // memberOf: -1 unassigned (sub-threshold), -2 excluded blend, >= 0 cluster index.
  const memberOf = new Int16Array(BINS).fill(-1);
  const edge = edgePixelsPerBin(img);
  const ramp = rampPixelsPerBin(img);

  for (let i = 0; i < candidates.length; i++) {
    const k = candidates[i];
    const c = counts[k];
    const pr = sums[k * 3] / c;
    const pg = sums[k * 3 + 1] / c;
    const pb = sums[k * 3 + 2] / c;
    const near = nearestDominant(pr, pg, pb, dom, nDom);
    if (near.index >= 0 && near.dist2 <= CLUSTER_TOL2) {
      memberOf[k] = near.index;
      continue;
    }
    if (isBlend(pr, pg, pb, c, edge[k] / c, ramp[k] / c, dom, domCount, nDom)) {
      memberOf[k] = -2;
      continue;
    }
    if (nDom >= cap) return null; // more real colours than allowed: photo-like
    dom[nDom * 3] = pr;
    dom[nDom * 3 + 1] = pg;
    dom[nDom * 3 + 2] = pb;
    domCount[nDom] = c;
    memberOf[k] = nDom;
    nDom++;
  }

  // Accumulate real sums per cluster.
  const clSum = new Float64Array(nDom * 3);
  const clCnt = new Float64Array(nDom);
  for (let k = 0; k < BINS; k++) {
    const c = counts[k];
    if (c === 0) continue;
    let m = memberOf[k];
    if (m === -2) continue;
    if (m === -1) {
      // Sub-threshold bin: same rules as the candidates, plus a stray-speck cut-off.
      const pr = sums[k * 3] / c;
      const pg = sums[k * 3 + 1] / c;
      const pb = sums[k * 3 + 2] / c;
      const near = nearestDominant(pr, pg, pb, dom, nDom);
      if (near.index < 0) continue;
      if (near.dist2 > CLUSTER_TOL2) {
        if (isBlend(pr, pg, pb, c, edge[k] / c, ramp[k] / c, dom, domCount, nDom)) continue;
        if (near.dist2 > STRAY_TOL2) continue;
      }
      m = near.index;
    }
    clSum[m * 3] += sums[k * 3];
    clSum[m * 3 + 1] += sums[k * 3 + 1];
    clSum[m * 3 + 2] += sums[k * 3 + 2];
    clCnt[m] += c;
  }

  // Merge clusters whose means are closer than MERGE_DISTANCE (weighted): JPEG noise and
  // sub-bin shading split one flat colour into neighbouring bins that AA exclusion cannot see.
  const merge2 = MERGE_DISTANCE * MERGE_DISTANCE;
  for (;;) {
    let bi = -1;
    let bj = -1;
    let bestD = Infinity;
    for (let i = 0; i < nDom; i++) {
      if (clCnt[i] === 0) continue;
      const ci = clCnt[i];
      for (let j = i + 1; j < nDom; j++) {
        if (clCnt[j] === 0) continue;
        const cj = clCnt[j];
        const dr = clSum[i * 3] / ci - clSum[j * 3] / cj;
        const dg = clSum[i * 3 + 1] / ci - clSum[j * 3 + 1] / cj;
        const db = clSum[i * 3 + 2] / ci - clSum[j * 3 + 2] / cj;
        const d2 = W_R2 * dr * dr + W_G2 * dg * dg + W_B2 * db * db;
        if (d2 < bestD) {
          bestD = d2;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0 || bestD >= merge2) break;
    clSum[bi * 3] += clSum[bj * 3];
    clSum[bi * 3 + 1] += clSum[bj * 3 + 1];
    clSum[bi * 3 + 2] += clSum[bj * 3 + 2];
    clCnt[bi] += clCnt[bj];
    clCnt[bj] = 0;
  }

  // Spatial coherence: drop clusters with too few core pixels (the largest always survives; a
  // non-positive ratio disables the rule) and hand their pixels to the nearest surviving cluster,
  // measured between cluster means (Euclidean, like the rest of the geometric rules here).
  const alive = new Uint8Array(nDom);
  const means = new Float64Array(nDom * 3);
  for (let j = 0; j < nDom; j++) {
    if (clCnt[j] === 0) continue;
    alive[j] = 1;
    means[j * 3] = clSum[j * 3] / clCnt[j];
    means[j * 3 + 1] = clSum[j * 3 + 1] / clCnt[j];
    means[j * 3 + 2] = clSum[j * 3 + 2] / clCnt[j];
  }
  const coherence = Number.isFinite(minCoreRatio) && minCoreRatio > 0;
  const cc = coherence && nDom > 1 ? coreCounts(img, means, alive, nDom) : null;
  const minCore = Math.max(MIN_CORE_PIXELS, (coherence ? minCoreRatio : 0) * h.total);
  const keep: number[] = [];
  let largest = 0;
  for (let j = 0; j < nDom; j++) {
    if (clCnt[j] > 0 && (cc === null || (cc.core[j] >= minCore && cc.core[j] >= MIN_CORE_FRACTION * cc.pop[j]))) keep.push(j);
    if (clCnt[j] > clCnt[largest]) largest = j;
  }
  if (keep.length === 0) keep.push(largest);
  if (cc !== null && keep.length < nDom) {
    const coherent = new Uint8Array(nDom);
    for (const j of keep) coherent[j] = 1;
    for (const j of distinctFeatures(img, cc, means, alive, coherent, nDom)) keep.push(j);
    keep.sort((a, b) => a - b);
  }
  const reassigned = new Float64Array(nDom);
  if (keep.length < nDom) {
    const keptDom = new Float64Array(keep.length * 3);
    for (let i = 0; i < keep.length; i++) {
      const j = keep[i];
      const c = clCnt[j];
      keptDom[i * 3] = clSum[j * 3] / c;
      keptDom[i * 3 + 1] = clSum[j * 3 + 1] / c;
      keptDom[i * 3 + 2] = clSum[j * 3 + 2] / c;
    }
    for (let j = 0; j < nDom; j++) {
      if (keep.includes(j) || clCnt[j] === 0) continue;
      const c = clCnt[j];
      const near = nearestDominant(clSum[j * 3] / c, clSum[j * 3 + 1] / c, clSum[j * 3 + 2] / c, keptDom, keep.length);
      // Counts only: the colour of a coherent cluster stays its own mean. Incoherent clusters can be
      // large (1-px lines are 10 % of a line drawing) and would drag it off the real colour.
      reassigned[keep[near.index]] += c;
    }
  }
  keep.sort((a, b) => clCnt[b] + reassigned[b] - (clCnt[a] + reassigned[a]) || a - b);

  const colors: RGB[] = [];
  const outCounts: number[] = [];
  for (let i = 0; i < keep.length; i++) {
    const j = keep[i];
    const c = clCnt[j];
    colors.push([
      Math.round(clSum[j * 3] / c),
      Math.round(clSum[j * 3 + 1] / c),
      Math.round(clSum[j * 3 + 2] / c),
    ]);
    outCounts.push(c + reassigned[j]);
  }
  return { colors, counts: outCounts, total: h.total };
}

/**
 * Exact palette of a flat-colour image, or null when it has more than `maxColors` real colours
 * after anti-aliasing exclusion (see exactPaletteDetailed). [] for an image without opaque pixels.
 */
export function exactPalette(img: RasterImage, maxColors = EXACT_MAX_COLORS): RGB[] | null {
  const r = exactPaletteDetailed(img, maxColors);
  return r === null ? null : r.colors;
}

// ---------------------------------------------------------------------------------------------
// Deterministic pixel sample (shared by k-means, consolidation and the error metric)
// ---------------------------------------------------------------------------------------------

/** About `sample` pixels with alpha >= 128 taken with a constant stride; 3 bytes per pixel. */
function gatherSample(img: RasterImage, sample: number): { px: Uint8Array; m: number } {
  const d = img.data;
  const n = Math.min(img.width * img.height, d.length >> 2);
  const stride = sample > 0 && Number.isFinite(sample) ? Math.max(1, Math.floor(n / sample)) : 1;
  const cap = Math.floor((n + stride - 1) / stride);
  const px = new Uint8Array(cap * 3);
  let m = 0;
  for (let i = 0; i < n; i += stride) {
    const p = i * 4;
    if (d[p + 3] < 128) continue;
    px[m * 3] = d[p];
    px[m * 3 + 1] = d[p + 1];
    px[m * 3 + 2] = d[p + 2];
    m++;
  }
  return { px, m };
}

/** Index of the nearest centre (weighted distance) and that squared distance. */
function nearestCentre(
  r: number,
  g: number,
  b: number,
  cen: Float64Array,
  alive: Uint8Array | null,
  k: number,
): { index: number; dist2: number } {
  let best = -1;
  let bestD = Infinity;
  for (let j = 0; j < k; j++) {
    if (alive !== null && alive[j] === 0) continue;
    const dr = r - cen[j * 3];
    const dg = g - cen[j * 3 + 1];
    const db = b - cen[j * 3 + 2];
    const dist = W_R2 * dr * dr + W_G2 * dg * dg + W_B2 * db * db;
    if (dist < bestD) {
      bestD = dist;
      best = j;
    }
  }
  return { index: best, dist2: bestD };
}

/**
 * Labelled and core pixels per centre over the whole image (see MIN_CORE_PIXELS): nearest centre
 * (weighted, alive centres only) per pixel with alpha >= 128; core = those whose 8 neighbours
 * (clamped at the edges) all share their label.
 */
interface CoreCounts {
  core: Float64Array;
  pop: Float64Array;
  /** Label per pixel (LABEL_NONE for alpha < 128); null when the data is shorter than width x height. */
  lab: Uint16Array | null;
}

const LABEL_NONE = 0xffff;
const LABEL_VISITED = 0xfffe;

function coreCounts(img: RasterImage, cen: Float64Array, alive: Uint8Array, k: number): CoreCounts {
  const { width: w, height: h, data: d } = img;
  const n = Math.min(w * h, d.length >> 2);
  const NONE = LABEL_NONE;
  const lab = new Uint16Array(n);
  const cacheKey = new Int32Array(CACHE_SIZE).fill(-1);
  const cacheLabel = new Uint16Array(CACHE_SIZE);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (d[p + 3] < 128) {
      lab[i] = NONE;
      continue;
    }
    const r = d[p];
    const g = d[p + 1];
    const b = d[p + 2];
    const rgb = (r << 16) | (g << 8) | b;
    const slot = (Math.imul(rgb, 0x9e3779b1) >>> (32 - CACHE_BITS)) & (CACHE_SIZE - 1);
    if (cacheKey[slot] === rgb) {
      lab[i] = cacheLabel[slot];
      continue;
    }
    const j = nearestCentre(r, g, b, cen, alive, k).index;
    const label = j < 0 ? NONE : j;
    cacheKey[slot] = rgb;
    cacheLabel[slot] = label;
    lab[i] = label;
  }
  const out = new Float64Array(k);
  const pop = new Float64Array(k);
  if (n < w * h) return { core: out, pop, lab: null };
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w;
    const mid = y * w;
    const down = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const j = lab[mid + x];
      if (j === NONE) continue;
      pop[j]++;
      const xl = x > 0 ? x - 1 : 0;
      const xr = x < w - 1 ? x + 1 : w - 1;
      if (
        lab[up + xl] !== j ||
        lab[up + x] !== j ||
        lab[up + xr] !== j ||
        lab[mid + xl] !== j ||
        lab[mid + xr] !== j ||
        lab[down + xl] !== j ||
        lab[down + x] !== j ||
        lab[down + xr] !== j
      ) {
        continue;
      }
      out[j]++;
    }
  }
  return { core: out, pop, lab };
}

/**
 * Clusters that fail the core rule (coherent[j] === 0, alive) but are thin or small distinct
 * features (see DISTINCT_DISTANCE): their largest 8-connected piece of labelled pixels holds at
 * least max(MIN_CORE_PIXELS, MIN_STRUCTURE_SHARE of their pixels) and their centre is at least
 * DISTINCT_DISTANCE (weighted) from every coherent centre. Consumes cc.lab (visited pixels are
 * overwritten).
 */
function distinctFeatures(
  img: RasterImage,
  cc: CoreCounts,
  cen: Float64Array,
  alive: Uint8Array,
  coherent: Uint8Array,
  k: number,
): number[] {
  const lab = cc.lab;
  if (lab === null) return [];
  const far2 = DISTINCT_DISTANCE * DISTINCT_DISTANCE;
  const want = new Uint8Array(k);
  let maxPop = 0;
  for (let j = 0; j < k; j++) {
    if (alive[j] === 0 || coherent[j] !== 0 || cc.pop[j] < MIN_CORE_PIXELS) continue;
    let far = true;
    for (let i = 0; i < k && far; i++) {
      if (coherent[i] === 0) continue;
      const dr = cen[j * 3] - cen[i * 3];
      const dg = cen[j * 3 + 1] - cen[i * 3 + 1];
      const db = cen[j * 3 + 2] - cen[i * 3 + 2];
      if (W_R2 * dr * dr + W_G2 * dg * dg + W_B2 * db * db < far2) far = false;
    }
    if (!far) continue;
    want[j] = 1;
    if (cc.pop[j] > maxPop) maxPop = cc.pop[j];
  }
  if (maxPop === 0) return [];
  const { width: w, height: h } = img;
  const largest = new Float64Array(k);
  const queue = new Int32Array(maxPop);
  for (let s = 0; s < w * h; s++) {
    const j = lab[s];
    if (j >= k || want[j] === 0) continue;
    let tail = 0;
    queue[tail++] = s;
    lab[s] = LABEL_VISITED;
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const x = i % w;
      const y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const nb = yy * w + xx;
          if (lab[nb] !== j) continue;
          lab[nb] = LABEL_VISITED;
          queue[tail++] = nb;
        }
      }
    }
    if (tail > largest[j]) largest[j] = tail;
  }
  const out: number[] = [];
  for (let j = 0; j < k; j++) {
    if (want[j] !== 0 && largest[j] >= Math.max(MIN_CORE_PIXELS, MIN_STRUCTURE_SHARE * cc.pop[j])) out.push(j);
  }
  return out;
}

/**
 * Cleans up a median-cut / k-means palette so JPEG logos end with their real colours:
 * repeatedly (a) re-centres every cluster on the mean of its sample pixels, (b) merges the two
 * closest clusters when their weighted distance is below `mergeDistance`, and otherwise (c) drops
 * the least coherent cluster (lowest core fraction) among those without spatial coherence over the
 * whole image — fewer than max(MIN_CORE_PIXELS, minRatio of the opaque pixels) core pixels, or a
 * core under MIN_CORE_FRACTION of its pixels (see MIN_CORE_PIXELS) — reassigning its pixels; a
 * non-positive minRatio disables (c). Stops when nothing changes.
 * Returns rounded colours, most populous first; at least one colour survives. Palettes of 0/1
 * colours are returned unchanged.
 */
export function consolidatePalette(
  img: RasterImage,
  palette: RGB[],
  sample = DEFAULT_SAMPLE,
  mergeDistance = MERGE_DISTANCE,
  minRatio = MIN_CORE_RATIO,
): RGB[] {
  const k = palette.length;
  if (k <= 1) return palette.map((c) => [clampByte(c[0]), clampByte(c[1]), clampByte(c[2])]);
  const { px, m } = gatherSample(img, sample);
  if (m === 0) return palette.map((c) => [clampByte(c[0]), clampByte(c[1]), clampByte(c[2])]);

  const cen = new Float64Array(k * 3);
  for (let j = 0; j < k; j++) {
    cen[j * 3] = palette[j][0];
    cen[j * 3 + 1] = palette[j][1];
    cen[j * 3 + 2] = palette[j][2];
  }
  const alive = new Uint8Array(k).fill(1);
  const sum = new Float64Array(k * 3);
  const cnt = new Float64Array(k);
  const merge2 = mergeDistance * mergeDistance;
  const coherence = Number.isFinite(minRatio) && minRatio > 0;
  let opaque = 0;
  if (coherence) for (let p = 3; p < img.data.length; p += 4) if (img.data[p] >= 128) opaque++;
  const minCore = Math.max(MIN_CORE_PIXELS, (coherence ? minRatio : 0) * opaque);

  // Each pass either merges or drops one cluster, so at most k passes.
  for (let pass = 0; pass <= k; pass++) {
    sum.fill(0);
    cnt.fill(0);
    for (let i = 0; i < m; i++) {
      const r = px[i * 3];
      const g = px[i * 3 + 1];
      const b = px[i * 3 + 2];
      const j = nearestCentre(r, g, b, cen, alive, k).index;
      sum[j * 3] += r;
      sum[j * 3 + 1] += g;
      sum[j * 3 + 2] += b;
      cnt[j]++;
    }
    let aliveCount = 0;
    for (let j = 0; j < k; j++) {
      if (alive[j] === 0) continue;
      if (cnt[j] === 0) {
        alive[j] = 0; // nobody maps to it: gone
        continue;
      }
      cen[j * 3] = sum[j * 3] / cnt[j];
      cen[j * 3 + 1] = sum[j * 3 + 1] / cnt[j];
      cen[j * 3 + 2] = sum[j * 3 + 2] / cnt[j];
      aliveCount++;
    }
    if (aliveCount <= 1) break;
    // (b) closest pair.
    let bi = -1;
    let bj = -1;
    let bestD = Infinity;
    for (let i = 0; i < k; i++) {
      if (alive[i] === 0) continue;
      for (let j = i + 1; j < k; j++) {
        if (alive[j] === 0) continue;
        const dr = cen[i * 3] - cen[j * 3];
        const dg = cen[i * 3 + 1] - cen[j * 3 + 1];
        const db = cen[i * 3 + 2] - cen[j * 3 + 2];
        const d2 = W_R2 * dr * dr + W_G2 * dg * dg + W_B2 * db * db;
        if (d2 < bestD) {
          bestD = d2;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi >= 0 && bestD < merge2) {
      const ci = cnt[bi];
      const cj = cnt[bj];
      const tot = ci + cj;
      cen[bi * 3] = (cen[bi * 3] * ci + cen[bj * 3] * cj) / tot;
      cen[bi * 3 + 1] = (cen[bi * 3 + 1] * ci + cen[bj * 3 + 1] * cj) / tot;
      cen[bi * 3 + 2] = (cen[bi * 3 + 2] * ci + cen[bj * 3 + 2] * cj) / tot;
      alive[bj] = 0;
      continue;
    }
    // (c) the least coherent cluster below the core floor, one per pass: a region split between two
    // k-means clusters has little core in each half until one of them absorbs the other.
    if (!coherence) break;
    const cc = coreCounts(img, cen, alive, k);
    const { core, pop } = cc;
    let largest = -1;
    let weakest = -1;
    let weakestFrac = Infinity;
    for (let j = 0; j < k; j++) {
      if (alive[j] === 0) continue;
      if (largest < 0 || cnt[j] > cnt[largest]) largest = j;
    }
    const coherent = new Uint8Array(k);
    let failing = 0;
    for (let j = 0; j < k; j++) {
      if (alive[j] === 0) continue;
      if (j === largest || (core[j] >= minCore && core[j] >= MIN_CORE_FRACTION * pop[j])) coherent[j] = 1;
      else failing++;
    }
    if (failing === 0) break;
    const exempt = new Uint8Array(k);
    for (const j of distinctFeatures(img, cc, cen, alive, coherent, k)) exempt[j] = 1;
    for (let j = 0; j < k; j++) {
      if (alive[j] === 0 || coherent[j] !== 0 || exempt[j] !== 0) continue;
      const frac = pop[j] > 0 ? core[j] / pop[j] : 0;
      if (frac < weakestFrac || (frac === weakestFrac && cnt[j] < cnt[weakest])) {
        weakest = j;
        weakestFrac = frac;
      }
    }
    if (weakest < 0) break;
    alive[weakest] = 0;
    continue;
  }

  const order: number[] = [];
  for (let j = 0; j < k; j++) if (alive[j] !== 0) order.push(j);
  order.sort((a, b) => cnt[b] - cnt[a] || a - b);
  const out: RGB[] = [];
  for (const j of order) {
    out.push([clampByte(cen[j * 3]), clampByte(cen[j * 3 + 1]), clampByte(cen[j * 3 + 2])]);
  }
  return out;
}

/**
 * Fraction of the sampled pixels (alpha >= 128, deterministic stride) whose raw-RGB Euclidean
 * distance to the nearest palette colour exceeds `tol` (default OFF_PALETTE_TOL = 24): the
 * share of the image a flat fill with this palette would get visibly wrong. Anti-aliasing and
 * JPEG halos are a thin band (a few %); gradients and photos leave a large fraction off the
 * palette. 0 when the image has no opaque pixels; 1 when the palette is empty but pixels exist.
 */
export function offPaletteRatio(
  img: RasterImage,
  palette: RGB[],
  tol = OFF_PALETTE_TOL,
  sample = DEFAULT_SAMPLE,
): number {
  const { px, m } = gatherSample(img, sample);
  if (m === 0) return 0;
  const k = palette.length;
  if (k === 0) return 1;
  const tol2 = tol * tol;
  let off = 0;
  for (let i = 0; i < m; i++) {
    const r = px[i * 3];
    const g = px[i * 3 + 1];
    const b = px[i * 3 + 2];
    let best = Infinity;
    for (let j = 0; j < k; j++) {
      const dr = r - palette[j][0];
      const dg = g - palette[j][1];
      const db = b - palette[j][2];
      const d2 = dr * dr + dg * dg + db * db;
      if (d2 < best) best = d2;
    }
    if (best > tol2) off++;
  }
  return off / m;
}

/**
 * Mean weighted colour distance (sqrt of colorDistance2, 0..~305) from the sampled pixels
 * (alpha >= 128, deterministic stride) to their nearest palette colour: the quantisation error
 * the palette would cause. 0 when the image has no opaque pixels or the palette is empty.
 */
export function paletteError(img: RasterImage, palette: RGB[], sample = DEFAULT_SAMPLE): number {
  const k = palette.length;
  if (k === 0) return 0;
  const { px, m } = gatherSample(img, sample);
  if (m === 0) return 0;
  const cen = new Float64Array(k * 3);
  for (let j = 0; j < k; j++) {
    cen[j * 3] = palette[j][0];
    cen[j * 3 + 1] = palette[j][1];
    cen[j * 3 + 2] = palette[j][2];
  }
  let acc = 0;
  for (let i = 0; i < m; i++) {
    acc += Math.sqrt(nearestCentre(px[i * 3], px[i * 3 + 1], px[i * 3 + 2], cen, null, k).dist2);
  }
  return acc / m;
}

// ---------------------------------------------------------------------------------------------
// medianCut (over the 5-bit histogram, weighted by population; real sums kept)
// ---------------------------------------------------------------------------------------------

interface Box {
  start: number; // range in `idx`
  end: number;
  count: number;
  axis: number; // 0 r, 1 g, 2 b
  side: number; // extent along `axis` (in real-average units)
}

/**
 * Median cut with at most k colours. Runs on the populated 5-bit bins (<= 32 768) so cost is
 * independent of the image size; each box's colour is the real average of its pixels. The box
 * to split is the one maximising population x longest side; the cut is the population median
 * along that side. Returns fewer than k colours when the image has fewer distinct bins;
 * [] for an empty image or k < 1. Ordered by population, descending.
 */
export function medianCut(img: RasterImage, k: number): RGB[] {
  const kk = Math.floor(k);
  if (!(kk >= 1)) return [];
  const h = binHistogram(img, null);
  const counts = h.counts;
  const sums = h.sums;
  let nb = 0;
  for (let i = 0; i < BINS; i++) if (counts[i] > 0) nb++;
  if (nb === 0) return [];

  const bkey = new Int32Array(nb);
  const bcnt = new Float64Array(nb);
  const avg = new Float64Array(nb * 3);
  for (let i = 0, j = 0; i < BINS; i++) {
    const c = counts[i];
    if (c === 0) continue;
    bkey[j] = i;
    bcnt[j] = c;
    avg[j * 3] = sums[i * 3] / c;
    avg[j * 3 + 1] = sums[i * 3 + 1] / c;
    avg[j * 3 + 2] = sums[i * 3 + 2] / c;
    j++;
  }

  const idx = new Int32Array(nb);
  for (let i = 0; i < nb; i++) idx[i] = i;

  const makeBox = (start: number, end: number): Box => {
    let count = 0;
    let minR = Infinity;
    let maxR = -Infinity;
    let minG = Infinity;
    let maxG = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (let i = start; i < end; i++) {
      const b = idx[i];
      count += bcnt[b];
      const r = avg[b * 3];
      const g = avg[b * 3 + 1];
      const bl = avg[b * 3 + 2];
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (g < minG) minG = g;
      if (g > maxG) maxG = g;
      if (bl < minB) minB = bl;
      if (bl > maxB) maxB = bl;
    }
    const dR = maxR - minR;
    const dG = maxG - minG;
    const dB = maxB - minB;
    let axis = 0;
    let side = dR;
    if (dG > side) {
      axis = 1;
      side = dG;
    }
    if (dB > side) {
      axis = 2;
      side = dB;
    }
    return { start, end, count, axis, side };
  };

  const boxes: Box[] = [makeBox(0, nb)];
  while (boxes.length < kk) {
    let best = -1;
    let bestP = 0;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.end - bx.start < 2) continue;
      const p = bx.count * bx.side;
      if (p > bestP) {
        bestP = p;
        best = i;
      }
    }
    if (best < 0) break;
    const bx = boxes[best];
    const axis = bx.axis;
    const sub = Array.from(idx.subarray(bx.start, bx.end));
    sub.sort((a, b) => avg[a * 3 + axis] - avg[b * 3 + axis] || bkey[a] - bkey[b]);
    for (let i = 0; i < sub.length; i++) idx[bx.start + i] = sub[i];
    // Most balanced cut (population median) with both halves non-empty.
    let cum = 0;
    let cut = 1;
    let bestImb = Infinity;
    for (let i = 0; i < sub.length - 1; i++) {
      cum += bcnt[sub[i]];
      const imb = Math.abs(2 * cum - bx.count);
      if (imb < bestImb) {
        bestImb = imb;
        cut = i + 1;
      }
    }
    const mid = bx.start + cut;
    boxes[best] = makeBox(bx.start, mid);
    boxes.push(makeBox(mid, bx.end));
  }

  const result: Array<{ count: number; color: RGB }> = [];
  for (const bx of boxes) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let i = bx.start; i < bx.end; i++) {
      const b = idx[i];
      const key = bkey[b];
      sr += sums[key * 3];
      sg += sums[key * 3 + 1];
      sb += sums[key * 3 + 2];
    }
    const c = bx.count;
    result.push({
      count: c,
      color: [Math.round(sr / c), Math.round(sg / c), Math.round(sb / c)],
    });
  }
  result.sort((a, b) => b.count - a.count);
  return result.map((r) => r.color);
}

// ---------------------------------------------------------------------------------------------
// kmeansRefine
// ---------------------------------------------------------------------------------------------

/**
 * Lloyd iterations over a deterministic stride sample (about `sample` pixels, alpha >= 128
 * only) with the weighted distance; centres are plain RGB means. Empty clusters keep their
 * previous centre. Stops early when no centre moves. Returns rounded colours in the same order
 * as the input palette.
 */
export function kmeansRefine(
  img: RasterImage,
  palette: RGB[],
  iters = 10,
  sample = 20000,
): RGB[] {
  const k = palette.length;
  if (k === 0) return [];
  // Gather the sample once (3 bytes per pixel).
  const { px, m } = gatherSample(img, sample);

  const cen = new Float64Array(k * 3);
  for (let j = 0; j < k; j++) {
    cen[j * 3] = palette[j][0];
    cen[j * 3 + 1] = palette[j][1];
    cen[j * 3 + 2] = palette[j][2];
  }
  if (m === 0) return palette.map((c) => [clampByte(c[0]), clampByte(c[1]), clampByte(c[2])]);

  const sum = new Float64Array(k * 3);
  const cnt = new Float64Array(k);
  const maxIters = Number.isFinite(iters) ? Math.max(0, Math.floor(iters)) : 10;
  for (let it = 0; it < maxIters; it++) {
    sum.fill(0);
    cnt.fill(0);
    for (let i = 0; i < m; i++) {
      const r = px[i * 3];
      const g = px[i * 3 + 1];
      const b = px[i * 3 + 2];
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const dr = r - cen[j * 3];
        const dg = g - cen[j * 3 + 1];
        const db = b - cen[j * 3 + 2];
        const dist = W_R2 * dr * dr + W_G2 * dg * dg + W_B2 * db * db;
        if (dist < bestD) {
          bestD = dist;
          best = j;
        }
      }
      sum[best * 3] += r;
      sum[best * 3 + 1] += g;
      sum[best * 3 + 2] += b;
      cnt[best]++;
    }
    let changed = false;
    for (let j = 0; j < k; j++) {
      const c = cnt[j];
      if (c === 0) continue;
      const nr = sum[j * 3] / c;
      const ng = sum[j * 3 + 1] / c;
      const nb = sum[j * 3 + 2] / c;
      if (nr !== cen[j * 3] || ng !== cen[j * 3 + 1] || nb !== cen[j * 3 + 2]) changed = true;
      cen[j * 3] = nr;
      cen[j * 3 + 1] = ng;
      cen[j * 3 + 2] = nb;
    }
    if (!changed) break;
  }

  const out: RGB[] = [];
  for (let j = 0; j < k; j++) {
    out.push([clampByte(cen[j * 3]), clampByte(cen[j * 3 + 1]), clampByte(cen[j * 3 + 2])]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// buildPalette / assignLabels
// ---------------------------------------------------------------------------------------------

/** Palette size used when the exact palette is unavailable and colors === 'auto'. */
const AUTO_FALLBACK_COLORS = 8;

/**
 * exact && colors 'auto': exact palette when the image has <= 32 real colours, else
 * medianCut(8) + k-means. exact && numeric colors: the exact palette when it fits in `colors`,
 * else medianCut(colors) + k-means. !exact: medianCut(colors | 8) + k-means. Every median-cut
 * result is consolidated (clusters closer than MERGE_DISTANCE merged, clusters without
 * spatial coherence dropped, see MIN_CORE_PIXELS), so it may hold fewer than `colors` entries.
 */
export function buildPalette(img: RasterImage, colors: number | 'auto', exact: boolean): RGB[] {
  const k = colors === 'auto' ? AUTO_FALLBACK_COLORS : Math.max(1, Math.floor(colors));
  if (exact) {
    const p = exactPalette(img);
    if (p !== null && (colors === 'auto' || p.length <= k)) return p;
  }
  return consolidatePalette(img, kmeansRefine(img, medianCut(img, k)));
}

const CACHE_BITS = 16;
const CACHE_SIZE = 1 << CACHE_BITS;

/**
 * Nearest palette index per pixel (weighted distance). Pixels with alpha < 128 get the index of
 * the background colour when the palette holds one (the palette entry within 12 raw-RGB units
 * of the image's border colour, see borderModeColor), else 0. Ties -> lowest index.
 */
export function assignLabels(img: RasterImage, palette: RGB[]): LabelMap {
  const { width, height } = img;
  const d = img.data;
  const n = Math.min(width * height, d.length >> 2);
  const k = palette.length;
  if (k > 256) throw new RangeError(`assignLabels: paleta demasiado grande (${k} > 256)`);
  const out = new Uint8Array(width * height);
  if (k === 0 || n === 0) return { data: out, width, height, count: k };

  const cen = new Float64Array(k * 3);
  for (let j = 0; j < k; j++) {
    cen[j * 3] = palette[j][0];
    cen[j * 3 + 1] = palette[j][1];
    cen[j * 3 + 2] = palette[j][2];
  }

  let bgIndex = 0;
  const border = borderModeColor(img);
  if (border !== null) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < k; j++) {
      const dr = border[0] - cen[j * 3];
      const dg = border[1] - cen[j * 3 + 1];
      const db = border[2] - cen[j * 3 + 2];
      const d2 = dr * dr + dg * dg + db * db;
      if (d2 < bestD) {
        bestD = d2;
        best = j;
      }
    }
    if (best >= 0 && bestD <= CLUSTER_TOL2) bgIndex = best;
  }

  // Direct-mapped exact cache keyed by the 24-bit colour: flat images repeat colours heavily.
  const cacheKey = new Int32Array(CACHE_SIZE).fill(-1);
  const cacheLabel = new Uint8Array(CACHE_SIZE);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (d[p + 3] < 128) {
      out[i] = bgIndex;
      continue;
    }
    const r = d[p];
    const g = d[p + 1];
    const b = d[p + 2];
    const rgb = (r << 16) | (g << 8) | b;
    const slot = (Math.imul(rgb, 0x9e3779b1) >>> (32 - CACHE_BITS)) & (CACHE_SIZE - 1);
    if (cacheKey[slot] === rgb) {
      out[i] = cacheLabel[slot];
      continue;
    }
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < k; j++) {
      const dr = r - cen[j * 3];
      const dg = g - cen[j * 3 + 1];
      const db = b - cen[j * 3 + 2];
      const dist = W_R2 * dr * dr + W_G2 * dg * dg + W_B2 * db * db;
      if (dist < bestD) {
        bestD = dist;
        best = j;
      }
    }
    cacheKey[slot] = rgb;
    cacheLabel[slot] = best;
    out[i] = best;
  }
  return { data: out, width, height, count: k };
}
