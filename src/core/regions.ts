/**
 * Gradient mode, phase 2: edge-based segmentation of an image into regions, region bookkeeping (merges,
 * adjacency, painter's order) and the Ux label maps and masks the layers are traced from.
 *
 * Pure; never mutates its inputs except rankMap, which relabels its array in place by contract.
 * Coordinates of fills follow the convention of core/fillEval.ts: pixel (x, y) is sampled at its centre
 * (x + 0.5, y + 0.5); the Ux pixel (X, Y) at ((X + 0.5)/U, (Y + 0.5)/U) in units of the segmentation.
 */
import type { BinaryMask, Fill, Layering, RasterImage, RegionMap, RGB, Segmentation } from '../types';
import { gaussianBlurRaster } from './blur';
import { type EdgeMaps, type EdgeThresholds, edgeThresholds, gateSobel, hysteresis, rgbEdgeMaps } from './edges';
import { evaluateFill } from './fillEval';
import { immerkaerSigma } from './noise';

/** More regions than this after merging: not flat art, the pipeline falls back to the flat palette. */
export const MAX_GRADIENT_REGIONS = 2000;
/** Gaussian sigma (px) of the blur applied before the edge maps. */
export const PREBLUR_SIGMA = 0.7;
/**
 * Core pixel: alpha >= this and not an edge pixel. Equal to REGION_MIN_ALPHA: with transparency the alpha channel
 * takes part in the edge maps, so the anti-aliased rim of a shape is edge and a flat semi-transparent interior is
 * core (at 250 a shape of alpha 128..249 had no core and was fitted as black).
 */
export const CORE_MIN_ALPHA = 128;
/** Below this alpha a pixel has no region (-1): the same cut as flat mode's transparent sentinel. */
export const REGION_MIN_ALPHA = 128;
/** Rings of the edge band grown into the regions by majority. */
export const BAND_RINGS = 3;
/** Ux label (Uint16Array) of a pixel without region. */
export const NO_REGION = 0xffff;
/**
 * Orphan test of segmentRegions: a pixel the colour growth gave to a region is a candidate when it differs from the
 * core pixel its growth started from by more than ORPHAN_STEP_RATIO·sobHi levels (max channel; 48 at the floors).
 */
export const ORPHAN_STEP_RATIO = 2;
/** Orphan test: each of the 8 rays from a candidate looks this many px for the first core pixel. */
export const ORPHAN_RAY_LENGTH = 8;
/**
 * A 4-connected group of orphans smaller than this goes back to the region that grew into it: the anti-aliased pixels
 * where three colours meet are not a blend of any two of them, and as regions of their own they were merged into their
 * neighbours with their odd colours in the fit core (the background of gradientFeathers stopped being solid).
 */
export const ORPHAN_MIN_AREA = 16;
/**
 * Core of the thin regions (orphans and leftovers): a pixel is a blend of its two neighbours along x or y when it lies
 * within THIN_BLEND_RATIO·sobHi levels (12 at the floors) of the segment between them and farther than that from both.
 */
export const THIN_BLEND_RATIO = 0.5;

// ---------------------------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------------------------

/** rgb *= alpha/255 (rounded); alpha untouched. The same rule as the flat pipeline. */
function premultiply(img: RasterImage): RasterImage {
  const src = img.data;
  const out = new Uint8ClampedArray(src.length);
  for (let p = 0; p < src.length; p += 4) {
    const a = src[p + 3];
    if (a === 255) {
      out[p] = src[p];
      out[p + 1] = src[p + 1];
      out[p + 2] = src[p + 2];
    } else if (a !== 0) {
      out[p] = (src[p] * a + 127) / 255;
      out[p + 1] = (src[p + 1] * a + 127) / 255;
      out[p + 2] = (src[p + 2] * a + 127) / 255;
    }
    out[p + 3] = a;
  }
  return { data: out, width: img.width, height: img.height };
}

/** Inverse of premultiply: rgb = rgb*255/alpha (clamped); fully transparent pixels stay black. */
function unpremultiply(img: RasterImage): RasterImage {
  const src = img.data;
  const out = new Uint8ClampedArray(src.length);
  for (let p = 0; p < src.length; p += 4) {
    const a = src[p + 3];
    if (a === 255) {
      out[p] = src[p];
      out[p + 1] = src[p + 1];
      out[p + 2] = src[p + 2];
    } else if (a !== 0) {
      out[p] = (src[p] * 255) / a;
      out[p + 1] = (src[p + 1] * 255) / a;
      out[p + 2] = (src[p + 2] * 255) / a;
    }
    out[p + 3] = a;
  }
  return { data: out, width: img.width, height: img.height };
}

/**
 * Edge maps of the image blurred by PREBLUR_SIGMA; with transparency the blur runs on premultiplied colour and the alpha
 * channel joins the maps (a shape's rim against transparency has no colour step once unpremultiplied).
 */
function preblurredEdgeMaps(img: RasterImage, transparent: boolean): EdgeMaps {
  const blurred = transparent
    ? unpremultiply(gaussianBlurRaster(premultiply(img), PREBLUR_SIGMA))
    : gaussianBlurRaster(img, PREBLUR_SIGMA);
  return rgbEdgeMaps(blurred, transparent);
}

/**
 * Segments `img` into regions separated by edges.
 *
 * edges = opts.edges ?? segmentEdges(img, opts) -> core = alpha >= CORE_MIN_ALPHA and not edge -> labelComponents(core)
 * -> the eligible pixels (alpha >= REGION_MIN_ALPHA) without region are grown into by colour (growByColour, seeded
 * region growing on the unblurred RGB: a band pixel joins the adjacent region whose colour it continues, not the one
 * whose core is nearest, so a feather tip narrower than the edge band stays with its feather) -> orphans (releaseOrphans:
 * grown pixels unlike the core pixel their growth came from and unlike any blend of the core colours around them, in
 * groups of ORPHAN_MIN_AREA px or more) become new regions -> the eligible pixels no region reaches become new
 * 4-connected components, as after growIntoBand's rings -> those new regions get core pixels (addThinCore) -> area and
 * regionAdjacency.
 * Measured on gradientFeathers(256), seeds 1-5, clean and with ±3 noise, after merging fragments as in the
 * tests: growIntoBand's majority rings gave feather tips and bases to the background (worst feather IoU
 * 0.905-0.922) and left 98-109 regions without core; the colour growth gives 1.000 on the clean seeds and no
 * region without core pixels.
 *
 * Invariants: regions.data[i] = -1 exactly when alpha < 128; every core pixel has a region; every region has a core
 * pixel; edgeShare = |edge ∧ alpha >= 128| / |alpha >= 128| (0 without such pixels); sigma = the one used.
 */
export function segmentRegions(img: RasterImage, opts: { regionDetail: number; sigma?: number; edges?: SegmentEdges }): Segmentation {
  const { width: w, height: h } = img;
  const n = w * h;
  const src = img.data;
  if (src.length < n * 4) throw new RangeError('segmentRegions: data.length < width·height·4');
  const edges = opts.edges ?? segmentEdges(img, opts);
  if (edges.edge.width !== w || edges.edge.height !== h) throw new RangeError('segmentRegions: opts.edges has another size');
  const { edge, sigma, thresholds: t } = edges;
  const ed = edge.data;

  const core = new Uint8Array(n);
  const eligible = new Uint8Array(n);
  for (let i = 0, o = 3; i < n; i++, o += 4) {
    const a = src[o];
    if (a < REGION_MIN_ALPHA) continue;
    eligible[i] = 1;
    if (ed[i] === 0 && a >= CORE_MIN_ALPHA) core[i] = 1;
  }
  const coreMask: BinaryMask = { data: core, width: w, height: h };
  const seeds = labelComponents(coreMask);
  const origin = growByColour(seeds.data, eligible, img);
  const orphan = releaseOrphans(seeds.data, origin, core, eligible, img, ORPHAN_STEP_RATIO * t.sobHi);
  const thinFrom = seeds.count;
  const withOrphans = labelLeftovers(seeds.data, orphan, w, h, thinFrom);
  const count = labelLeftovers(seeds.data, eligible, w, h, withOrphans);
  if (count > thinFrom) addThinCore(core, seeds.data, thinFrom, count, img, eligible, THIN_BLEND_RATIO * t.sobHi);
  const regions: RegionMap = { data: seeds.data, width: w, height: h, count };
  const area = new Float64Array(regions.count);
  const rd = regions.data;
  for (let i = 0; i < n; i++) if (rd[i] >= 0) area[rd[i]]++;
  return {
    regions,
    edge,
    core: coreMask,
    area,
    adjacency: regionAdjacency(regions),
    sigma,
    edgeShare: edges.edgeShare,
  };
}

/** The edge stage of segmentRegions: what the gradient fallback on edgeShare needs before any labelling. */
export interface SegmentEdges {
  /** 1 = edge pixel: hysteresis(laplacian) ∪ hysteresis(gateSobel(sobel)). */
  edge: BinaryMask;
  /** Edge pixels with alpha >= 128 / pixels with alpha >= 128 (0 without such pixels). */
  edgeShare: number;
  /** Noise estimate the thresholds were scaled with. */
  sigma: number;
  thresholds: EdgeThresholds;
}

/**
 * Edge mask of `img` as segmentRegions builds it: sigma = opts.sigma ?? immerkaerSigma(img); blur by PREBLUR_SIGMA
 * (premultiplied, with the alpha channel in the maps, when some alpha < 255) -> rgbEdgeMaps -> edgeThresholds(sigma,
 * regionDetail) -> hysteresis(laplacian, lapLo, lapHi) ∪ hysteresis(gateSobel(sobel, laplacian), sobLo, sobHi). The
 * pipeline checks edgeShare here and skips the labelling of an image it will not trace in gradient mode.
 */
export function segmentEdges(img: RasterImage, opts: { regionDetail: number; sigma?: number }): SegmentEdges {
  const { width: w, height: h } = img;
  const n = w * h;
  const src = img.data;
  if (src.length < n * 4) throw new RangeError('segmentEdges: data.length < width·height·4');
  const sigma = opts.sigma ?? immerkaerSigma(img);
  let transparent = false;
  for (let o = 3; o < n * 4; o += 4) {
    if (src[o] < 255) {
      transparent = true;
      break;
    }
  }
  const t = edgeThresholds(sigma, opts.regionDetail);
  let maps: EdgeMaps | null = preblurredEdgeMaps(img, transparent);
  const edge = hysteresis(maps.laplacian.data, w, h, t.lapLo, t.lapHi);
  const sobelEdge = hysteresis(gateSobel(maps.sobel.data, maps.laplacian.data, w, h, t), w, h, t.sobLo, t.sobHi).data;
  maps = null;
  const ed = edge.data;
  let opaque = 0;
  let edgeOpaque = 0;
  for (let i = 0, o = 3; i < n; i++, o += 4) {
    if (sobelEdge[i] !== 0) ed[i] = 1;
    if (src[o] < REGION_MIN_ALPHA) continue;
    opaque++;
    if (ed[i] !== 0) edgeOpaque++;
  }
  return { edge, edgeShare: opaque === 0 ? 0 : edgeOpaque / opaque, sigma, thresholds: t };
}

/**
 * 4-connected components of mask = 1 (any non-zero value), by two-pass union-find over Int32Arrays.
 * Ids 0..count-1 in the raster order of each component's first pixel; -1 outside the mask.
 */
export function labelComponents(mask: BinaryMask): RegionMap {
  const { width: w, height: h, data: m } = mask;
  const n = w * h;
  if (m.length < n) throw new RangeError('labelComponents: data.length < width·height');
  const out = new Int32Array(n);
  let parent = new Int32Array(Math.max(16, Math.min(n, 1 << 16)));
  let next = 0;
  // Pass 1: provisional labels from the left and upper neighbours; equivalences united at the smaller root.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (m[i] === 0) {
        out[i] = -1;
        continue;
      }
      const left = x > 0 ? out[i - 1] : -1;
      const up = y > 0 ? out[i - w] : -1;
      if (left < 0 && up < 0) {
        if (next === parent.length) {
          const grown = new Int32Array(Math.min(n, parent.length * 2));
          grown.set(parent);
          parent = grown;
        }
        parent[next] = next;
        out[i] = next++;
      } else if (up < 0 || up === left) {
        out[i] = left;
      } else if (left < 0) {
        out[i] = up;
      } else {
        let a = left;
        while (parent[a] !== a) a = parent[a];
        let b = up;
        while (parent[b] !== b) b = parent[b];
        const root = a < b ? a : b;
        // Path compression of both chains onto the common root.
        for (let v = left; parent[v] !== root; ) {
          const nx = parent[v];
          parent[v] = root;
          v = nx;
        }
        for (let v = up; parent[v] !== root; ) {
          const nx = parent[v];
          parent[v] = root;
          v = nx;
        }
        parent[a] = root;
        parent[b] = root;
        out[i] = root;
      }
    }
  }
  // Pass 2: roots -> compact ids in raster order of first appearance.
  const ids = new Int32Array(next).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const p = out[i];
    if (p < 0) continue;
    let r = p;
    while (parent[r] !== r) r = parent[r];
    if (parent[p] !== r) parent[p] = r;
    let id = ids[r];
    if (id < 0) {
      id = count++;
      ids[r] = id;
    }
    out[i] = id;
  }
  return { data: out, width: w, height: h, count };
}

/**
 * Grows `regions` into the eligible pixels without region. Does not mutate. In each of `rings` rings, every
 * eligible unlabelled pixel with a 4-neighbour labelled before that ring takes the most frequent label among
 * its 8 neighbours labelled before that ring (tie -> smaller id). After the rings, the eligible pixels still
 * without region form new 4-connected components (ids after regions.count, in raster order); count updated.
 * Negative labels in the input count as none.
 */
export function growIntoBand(regions: RegionMap, eligible: BinaryMask, rings: number): RegionMap {
  const { width: w, height: h } = regions;
  const n = w * h;
  if (eligible.width !== w || eligible.height !== h) throw new RangeError('growIntoBand: eligible has another size');
  if (regions.data.length < n || eligible.data.length < n) throw new RangeError('growIntoBand: data.length < width·height');
  const el = eligible.data;
  const lab = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const v = regions.data[i];
    lab[i] = v >= 0 ? v : -1;
  }
  const ringCount = rings > 0 ? Math.floor(rings) : 0;

  let cand = new Int32Array(1024);
  let nc = 0;
  let next = new Int32Array(1024);
  let nn = 0;
  const queued = new Uint8Array(ringCount > 0 ? n : 0);
  if (ringCount > 0) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (lab[i] >= 0 || el[i] === 0) continue;
        if ((x > 0 && lab[i - 1] >= 0) || (x < w - 1 && lab[i + 1] >= 0) || (y > 0 && lab[i - w] >= 0) || (y < h - 1 && lab[i + w] >= 0)) {
          if (nc === cand.length) {
            const grown = new Int32Array(Math.min(n, cand.length * 2));
            grown.set(cand);
            cand = grown;
          }
          cand[nc++] = i;
          queued[i] = 1;
        }
      }
    }
  }

  const labs = new Int32Array(8);
  const counts = new Int32Array(8);
  let chosen = new Int32Array(cand.length);
  for (let r = 0; r < ringCount && nc > 0; r++) {
    if (chosen.length < nc) chosen = new Int32Array(cand.length);
    // Every choice reads the labels as they were before this ring.
    for (let k = 0; k < nc; k++) {
      const p = cand[k];
      const x = p % w;
      const y = (p - x) / w;
      const xa = x > 0 ? x - 1 : 0;
      const xb = x < w - 1 ? x + 1 : x;
      const ya = y > 0 ? y - 1 : 0;
      const yb = y < h - 1 ? y + 1 : y;
      let m = 0;
      for (let yy = ya; yy <= yb; yy++) {
        const row = yy * w;
        for (let xx = xa; xx <= xb; xx++) {
          const q = row + xx;
          if (q === p) continue;
          const l = lab[q];
          if (l < 0) continue;
          let j = 0;
          while (j < m && labs[j] !== l) j++;
          if (j === m) {
            labs[m] = l;
            counts[m++] = 1;
          } else {
            counts[j]++;
          }
        }
      }
      let best = labs[0];
      let bestCount = counts[0];
      for (let j = 1; j < m; j++) {
        if (counts[j] > bestCount || (counts[j] === bestCount && labs[j] < best)) {
          best = labs[j];
          bestCount = counts[j];
        }
      }
      chosen[k] = best;
    }
    for (let k = 0; k < nc; k++) lab[cand[k]] = chosen[k];
    if (r === ringCount - 1) break;
    // Next ring: the unlabelled eligible 4-neighbours of the pixels labelled in this one.
    nn = 0;
    for (let k = 0; k < nc; k++) {
      const p = cand[k];
      const x = p % w;
      for (let s = 0; s < 4; s++) {
        let q: number;
        if (s === 0) {
          if (x === 0) continue;
          q = p - 1;
        } else if (s === 1) {
          if (x === w - 1) continue;
          q = p + 1;
        } else if (s === 2) {
          q = p - w;
          if (q < 0) continue;
        } else {
          q = p + w;
          if (q >= n) continue;
        }
        if (lab[q] >= 0 || el[q] === 0 || queued[q] !== 0) continue;
        queued[q] = 1;
        if (nn === next.length) {
          const grown = new Int32Array(Math.min(n, next.length * 2));
          grown.set(next);
          next = grown;
        }
        next[nn++] = q;
      }
    }
    const swap = cand;
    cand = next;
    next = swap;
    nc = nn;
  }

  return { data: lab, width: w, height: h, count: labelLeftovers(lab, el, w, h, regions.count) };
}

/**
 * In place: the eligible pixels of `lab` still without region (< 0) become new 4-connected components with
 * ids count, count + 1, ... in the raster order of their first pixel. Returns the new count.
 */
function labelLeftovers(lab: Int32Array, eligible: Uint8Array, w: number, h: number, count: number): number {
  const n = w * h;
  let any = false;
  for (let i = 0; i < n; i++) {
    if (lab[i] < 0 && eligible[i] !== 0) {
      any = true;
      break;
    }
  }
  if (!any) return count;
  const rest = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (lab[i] < 0 && eligible[i] !== 0) rest[i] = 1;
  const extra = labelComponents({ data: rest, width: w, height: h });
  const ed = extra.data;
  for (let i = 0; i < n; i++) if (ed[i] >= 0) lab[i] = count + ed[i];
  return count + extra.count;
}

/** Priorities of growByColour's bucket queue: the L1 distance over R, G and B is 0..765. */
const COLOUR_BUCKETS = 766;

/**
 * Seeded region growing by colour, in place on `lab` (-1 = no region; img gives the colours, same size):
 * every eligible pixel 4-connected to a region through eligible pixels gets one. A labelled pixel offers
 * each unlabelled eligible 4-neighbour at priority |ΔR| + |ΔG| + |ΔB| between the two pixels; the lowest
 * priority is served first (FIFO within one priority, so the result is deterministic) and the pixel joins
 * its labelled 4-neighbour of most similar colour (tie -> smaller id), then offers its own neighbours.
 * Returns origin[i] = the pixel the growth of i started from (i itself for a pixel labelled on input; -1 when unreached).
 */
function growByColour(lab: Int32Array, eligible: Uint8Array, img: RasterImage): Int32Array {
  const w = img.width;
  const n = w * img.height;
  const d = img.data;
  const head = new Int32Array(COLOUR_BUCKETS).fill(-1);
  const tail = new Int32Array(COLOUR_BUCKETS).fill(-1);
  let pix = new Int32Array(4096);
  let link = new Int32Array(4096);
  let size = 0;
  let lowest = COLOUR_BUCKETS;
  const distance = (p: number, q: number): number => {
    const a = p * 4;
    const b = q * 4;
    const dr = d[a] - d[b];
    const dg = d[a + 1] - d[b + 1];
    const db = d[a + 2] - d[b + 2];
    return (dr < 0 ? -dr : dr) + (dg < 0 ? -dg : dg) + (db < 0 ? -db : db);
  };
  const push = (q: number, bucket: number): void => {
    if (size === pix.length) {
      const grownPix = new Int32Array(size * 2);
      grownPix.set(pix);
      pix = grownPix;
      const grownLink = new Int32Array(size * 2);
      grownLink.set(link);
      link = grownLink;
    }
    pix[size] = q;
    link[size] = -1;
    if (tail[bucket] < 0) head[bucket] = size;
    else link[tail[bucket]] = size;
    tail[bucket] = size;
    size++;
    if (bucket < lowest) lowest = bucket;
  };
  const offer = (p: number): void => {
    const x = p % w;
    if (x > 0 && lab[p - 1] < 0 && eligible[p - 1] !== 0) push(p - 1, distance(p, p - 1));
    if (x < w - 1 && lab[p + 1] < 0 && eligible[p + 1] !== 0) push(p + 1, distance(p, p + 1));
    if (p >= w && lab[p - w] < 0 && eligible[p - w] !== 0) push(p - w, distance(p, p - w));
    if (p + w < n && lab[p + w] < 0 && eligible[p + w] !== 0) push(p + w, distance(p, p + w));
  };
  const origin = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (lab[i] < 0) continue;
    origin[i] = i;
    offer(i);
  }
  for (;;) {
    while (lowest < COLOUR_BUCKETS && head[lowest] < 0) lowest++;
    if (lowest === COLOUR_BUCKETS) break;
    const e = head[lowest];
    head[lowest] = link[e];
    if (head[lowest] < 0) tail[lowest] = -1;
    const p = pix[e];
    if (lab[p] >= 0) continue;
    const x = p % w;
    let best = -1;
    let bestFrom = -1;
    let bestDist = COLOUR_BUCKETS;
    for (let s = 0; s < 4; s++) {
      let q: number;
      if (s === 0) {
        if (x === 0) continue;
        q = p - 1;
      } else if (s === 1) {
        if (x === w - 1) continue;
        q = p + 1;
      } else if (s === 2) {
        q = p - w;
        if (q < 0) continue;
      } else {
        q = p + w;
        if (q >= n) continue;
      }
      const l = lab[q];
      if (l < 0) continue;
      const dist = distance(p, q);
      if (dist < bestDist || (dist === bestDist && l < best)) {
        best = l;
        bestFrom = q;
        bestDist = dist;
      }
    }
    lab[p] = best;
    origin[p] = origin[bestFrom];
    offer(p);
  }
  return origin;
}

/** Largest per-channel difference between the RGB of pixels p and q of `d`. */
function channelDiff(d: Uint8ClampedArray, p: number, q: number): number {
  const a = p * 4;
  const b = q * 4;
  const dr = d[a] - d[b];
  const dg = d[a + 1] - d[b + 1];
  const db = d[a + 2] - d[b + 2];
  return Math.max(dr < 0 ? -dr : dr, dg < 0 ? -dg : dg, db < 0 ? -db : db);
}

/**
 * Largest per-channel distance from the RGB of pixel p to the point of the segment between pixels a and b nearest to
 * it (Euclidean projection clamped to the segment).
 */
function segmentDiff(d: Uint8ClampedArray, p: number, a: number, b: number): number {
  const op = p * 4;
  const oa = a * 4;
  const ob = b * 4;
  let dot = 0;
  let len2 = 0;
  for (let c = 0; c < 3; c++) {
    const e = d[ob + c] - d[oa + c];
    dot += (d[op + c] - d[oa + c]) * e;
    len2 += e * e;
  }
  const u = len2 > 0 ? Math.min(1, Math.max(0, dot / len2)) : 0;
  let worst = 0;
  for (let c = 0; c < 3; c++) {
    const v = Math.abs(d[op + c] - (d[oa + c] + (d[ob + c] - d[oa + c]) * u));
    if (v > worst) worst = v;
  }
  return worst;
}

const RAY_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const RAY_DY = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * Orphans: pixels the colour growth handed to a region they do not belong to (a stroke, a ring or a steep ramp too
 * thin or too steep to keep core pixels, grown into by its only cored neighbour). A grown pixel p (labelled, not core)
 * is a candidate when channelDiff(p, origin[p]) > step; it is explained, and stays, when one of the 8 rays from p
 * (ORPHAN_RAY_LENGTH px, stopped by transparency or the image border) reaches no core pixel, or when the colours of
 * the first core pixels they reach contain a pair (a pixel with itself included) whose segment passes within `step` of
 * p's colour: an anti-aliased pixel between two regions is a blend of them, a stroke is not. 4-connected groups of
 * orphans of ORPHAN_MIN_AREA px or more leave their region (lab = -1); smaller groups stay. Returns the mask of the
 * orphans that left. Reads core, origin and colours only, so the order of the pixels does not matter.
 */
function releaseOrphans(
  lab: Int32Array,
  origin: Int32Array,
  core: Uint8Array,
  eligible: Uint8Array,
  img: RasterImage,
  step: number,
): Uint8Array {
  const w = img.width;
  const h = img.height;
  const n = w * h;
  const d = img.data;
  const orphan = new Uint8Array(n);
  const hits = new Int32Array(8);
  let any = false;
  for (let p = 0; p < n; p++) {
    if (lab[p] < 0 || core[p] !== 0 || origin[p] < 0 || channelDiff(d, p, origin[p]) <= step) continue;
    const x0 = p % w;
    const y0 = (p - x0) / w;
    let m = 0;
    for (let r = 0; r < 8; r++) {
      let x = x0;
      let y = y0;
      for (let k = 0; k < ORPHAN_RAY_LENGTH; k++) {
        x += RAY_DX[r];
        y += RAY_DY[r];
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        const q = y * w + x;
        if (eligible[q] === 0) break;
        if (core[q] !== 0) {
          hits[m++] = q;
          break;
        }
      }
    }
    if (m === 0) continue;
    let explained = false;
    for (let a = 0; a < m && !explained; a++) {
      for (let b = a; b < m; b++) {
        if (segmentDiff(d, p, hits[a], hits[b]) <= step) {
          explained = true;
          break;
        }
      }
    }
    if (!explained) {
      orphan[p] = 1;
      any = true;
    }
  }
  if (!any) return orphan;
  // Groups under ORPHAN_MIN_AREA stay where the growth put them.
  const groups = labelComponents({ data: orphan, width: w, height: h });
  const size = new Int32Array(groups.count);
  for (let p = 0; p < n; p++) if (groups.data[p] >= 0) size[groups.data[p]]++;
  for (let p = 0; p < n; p++) {
    const g = groups.data[p];
    if (g < 0) continue;
    if (size[g] < ORPHAN_MIN_AREA) orphan[p] = 0;
    else lab[p] = -1;
  }
  return orphan;
}

/**
 * Core pixels of the regions from..to-1 (orphans and leftovers, which have none from the edge mask), in place on `core`:
 * a pixel of such a region is core unless it is a blend of its two eligible neighbours along x or along y (within `tol`
 * of the segment between their colours and farther than `tol` from both), i.e. the anti-aliased sides of a stroke are
 * left out and its inside, or a gentle ramp along it, is kept. A region where every pixel is a blend takes all of them.
 */
function addThinCore(
  core: Uint8Array,
  lab: Int32Array,
  from: number,
  to: number,
  img: RasterImage,
  eligible: Uint8Array,
  tol: number,
): void {
  const w = img.width;
  const h = img.height;
  const n = w * h;
  const d = img.data;
  const got = new Uint8Array(to - from);
  const blend = (p: number, a: number, b: number): boolean =>
    channelDiff(d, p, a) > tol && channelDiff(d, p, b) > tol && segmentDiff(d, p, a, b) <= tol;
  for (let p = 0; p < n; p++) {
    const l = lab[p];
    if (l < from || l >= to) continue;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0 && x < w - 1 && eligible[p - 1] !== 0 && eligible[p + 1] !== 0 && blend(p, p - 1, p + 1)) continue;
    if (y > 0 && y < h - 1 && eligible[p - w] !== 0 && eligible[p + w] !== 0 && blend(p, p - w, p + w)) continue;
    core[p] = 1;
    got[l - from] = 1;
  }
  if (got.every((v) => v !== 0)) return;
  for (let p = 0; p < n; p++) {
    const l = lab[p];
    if (l >= from && l < to && got[l - from] === 0) core[p] = 1;
  }
}

/** [i] = ids of the regions 4-adjacent to region i, ascending, without i and without repeats. */
export function regionAdjacency(regions: RegionMap): Int32Array[] {
  const { width: w, height: h, data: d, count } = regions;
  const n = w * h;
  if (d.length < n) throw new RangeError('regionAdjacency: data.length < width·height');
  const lists: number[][] = [];
  for (let i = 0; i < count; i++) lists.push([]);
  const seen = new Set<number>();
  let lastRight = -1;
  let lastDown = -1;
  const add = (a: number, b: number): number => {
    if (a >= count || b >= count) throw new RangeError(`regionAdjacency: etiqueta fuera de rango (${Math.max(a, b)} >= ${count})`);
    const key = a < b ? a * count + b : b * count + a;
    if (!seen.has(key)) {
      seen.add(key);
      lists[a].push(b);
      lists[b].push(a);
    }
    return key;
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const a = d[i];
      if (a < 0) continue;
      if (x < w - 1) {
        const b = d[i + 1];
        if (b >= 0 && b !== a) {
          const key = a < b ? a * count + b : b * count + a;
          if (key !== lastRight) lastRight = add(a, b);
        }
      }
      if (y < h - 1) {
        const b = d[i + w];
        if (b >= 0 && b !== a) {
          const key = a < b ? a * count + b : b * count + a;
          if (key !== lastDown) lastDown = add(a, b);
        }
      }
    }
  }
  return lists.map((l) => Int32Array.from(l).sort());
}

/**
 * Applies the [src, dst] pairs in order (union-find: [a, b], [b, c] puts a and b in c). New compact ids
 * 0..count'-1 in the order of each group's smallest original id; remap[oldId] = newId. regions, area and
 * adjacency are recomputed (adjacency as the union of the members' lists); edge, core, sigma and edgeShare
 * are the same objects and values. Does not mutate `seg`. Ids out of 0..count-1 throw a RangeError.
 */
export function mergeRegions(
  seg: Segmentation,
  pairs: ReadonlyArray<readonly [number, number]>,
): { seg: Segmentation; remap: Int32Array } {
  const count = seg.regions.count;
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (v: number): number => {
    let r = v;
    while (parent[r] !== r) r = parent[r];
    while (parent[v] !== r) {
      const nx = parent[v];
      parent[v] = r;
      v = nx;
    }
    return r;
  };
  for (const [src, dst] of pairs) {
    if (!Number.isInteger(src) || !Number.isInteger(dst) || src < 0 || dst < 0 || src >= count || dst >= count) {
      throw new RangeError(`mergeRegions: par fuera de rango [${src}, ${dst}] (count ${count})`);
    }
    const rs = find(src);
    const rd = find(dst);
    if (rs !== rd) parent[rs] = rd;
  }
  const remap = new Int32Array(count);
  const idOfRoot = new Int32Array(count).fill(-1);
  let k = 0;
  for (let id = 0; id < count; id++) {
    const r = find(id);
    if (idOfRoot[r] < 0) idOfRoot[r] = k++;
    remap[id] = idOfRoot[r];
  }

  const old = seg.regions.data;
  const data = new Int32Array(old.length);
  for (let i = 0; i < old.length; i++) {
    const v = old[i];
    data[i] = v < 0 ? -1 : remap[v];
  }
  const area = new Float64Array(k);
  for (let id = 0; id < count; id++) area[remap[id]] += seg.area[id];

  // Members of each new id (CSR), then the union of their adjacency lists.
  const start = new Int32Array(k + 1);
  for (let id = 0; id < count; id++) start[remap[id] + 1]++;
  for (let g = 0; g < k; g++) start[g + 1] += start[g];
  const fillAt = start.slice(0, k);
  const members = new Int32Array(count);
  for (let id = 0; id < count; id++) members[fillAt[remap[id]]++] = id;
  const stamp = new Int32Array(k).fill(-1);
  const adjacency: Int32Array[] = [];
  const list: number[] = [];
  for (let g = 0; g < k; g++) {
    list.length = 0;
    for (let m = start[g]; m < start[g + 1]; m++) {
      const adj = seg.adjacency[members[m]];
      for (let j = 0; j < adj.length; j++) {
        const nb = remap[adj[j]];
        if (nb === g || stamp[nb] === g) continue;
        stamp[nb] = g;
        list.push(nb);
      }
    }
    adjacency.push(Int32Array.from(list).sort());
  }

  return {
    seg: {
      regions: { data, width: seg.regions.width, height: seg.regions.height, count: k },
      edge: seg.edge,
      core: seg.core,
      area,
      adjacency,
      sigma: seg.sigma,
      edgeShare: seg.edgeShare,
    },
    remap,
  };
}

// ---------------------------------------------------------------------------------------------
// Painter's order
// ---------------------------------------------------------------------------------------------

/** 1 for every region with a pixel on the outer 1-px ring of the image. */
function borderRegions(regions: RegionMap): Uint8Array {
  const { width: w, height: h, data: d, count } = regions;
  const out = new Uint8Array(count);
  if (w === 0 || h === 0) return out;
  const mark = (i: number): void => {
    const v = d[i];
    if (v >= 0 && v < count) out[v] = 1;
  };
  for (let x = 0; x < w; x++) {
    mark(x);
    mark((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    mark(y * w);
    mark(y * w + w - 1);
  }
  return out;
}

/**
 * Painter's order (back to front), a permutation of 0..count-1: area descending (tie: smaller id); then
 * every region enclosed by a single region a (its adjacency is exactly [a] and it does not touch the image
 * border) is painted after a: a ring around a disc puts the disc after the ring, whatever their areas.
 * A region already after its encloser keeps its place; one before it moves right after it (with the
 * regions it encloses in turn). Cycles (two regions whose only neighbour is each other, possible when
 * transparency isolates them) keep the area order for the first of them.
 */
export function regionOrder(seg: Segmentation): number[] {
  const count = seg.regions.count;
  const area = seg.area;
  const base: number[] = [];
  for (let i = 0; i < count; i++) base.push(i);
  base.sort((a, b) => area[b] - area[a] || a - b);
  const pos = new Int32Array(count);
  for (let j = 0; j < count; j++) pos[base[j]] = j;

  const border = borderRegions(seg.regions);
  const parent = new Int32Array(count).fill(-1);
  for (let id = 0; id < count; id++) {
    const adj = seg.adjacency[id];
    if (adj !== undefined && adj.length === 1 && border[id] === 0) {
      const a = adj[0];
      if (a >= 0 && a < count && a !== id) parent[id] = a;
    }
  }
  // Break the cycles of the parent graph (at most one parent each): the member first in area order stays.
  const walk = new Int32Array(count).fill(-1);
  for (let s = 0; s < count; s++) {
    if (walk[s] !== -1) continue;
    let v = s;
    while (v !== -1 && walk[v] === -1) {
      walk[v] = s;
      v = parent[v];
    }
    if (v !== -1 && walk[v] === s) {
      let first = v;
      for (let u = parent[v]; u !== v; u = parent[u]) if (pos[u] < pos[first]) first = u;
      parent[first] = -1;
    }
  }

  const emitted = new Uint8Array(count);
  const waiting: Array<number[] | undefined> = new Array(count);
  const order: number[] = [];
  const stack: number[] = [];
  for (const r of base) {
    const p = parent[r];
    if (p !== -1 && emitted[p] === 0) {
      const list = waiting[p];
      if (list === undefined) waiting[p] = [r];
      else list.push(r);
      continue;
    }
    stack.push(r);
    while (stack.length > 0) {
      const v = stack.pop() as number;
      emitted[v] = 1;
      order.push(v);
      const kids = waiting[v];
      if (kids !== undefined) {
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        waiting[v] = undefined;
      }
    }
  }
  return order;
}

// ---------------------------------------------------------------------------------------------
// Ux labels and masks
// ---------------------------------------------------------------------------------------------

/**
 * Labels of `up` (up.width × up.height), a resampled copy of the segmented image. U = pixels of up per
 * pixel of seg (U·f when seg ran on a proxy of factor f); fills[k] = fill of region k in seg units.
 * Pixel (X, Y) with alpha of up < 128 -> NO_REGION. Otherwise (x, y) = (floor(X/U), floor(Y/U)) clamped
 * to seg: when its 3×3 in seg holds a single label >= 0, that label; with more than one, the k of that
 * 3×3 minimising Σ_c (evaluateFill(fills[k], (X + 0.5)/U, (Y + 0.5)/U)_c − up_c)² (tie -> the label of
 * (x, y), then the smaller id); with none, NO_REGION.
 */
export function refineLabels(seg: Segmentation, fills: readonly Fill[], up: RasterImage, U: number): Uint16Array {
  const { width: sw, height: sh, data: lab, count } = seg.regions;
  if (count > NO_REGION) throw new RangeError(`refineLabels: ${count} regiones no caben en Uint16 (máximo ${NO_REGION})`);
  if (fills.length < count) throw new RangeError(`refineLabels: ${fills.length} rellenos para ${count} regiones`);
  if (!(U > 0) || !Number.isFinite(U)) throw new RangeError(`refineLabels: U inválido (${U})`);
  const W = up.width;
  const H = up.height;
  const ud = up.data;
  if (ud.length < W * H * 4) throw new RangeError('refineLabels: up.data.length < width·height·4');
  const out = new Uint16Array(W * H);
  if (W === 0 || H === 0) return out;
  if (sw === 0 || sh === 0) return out.fill(NO_REGION);

  // Per seg pixel: its single label (>= 0), -1 without any label in its 3×3, -2 with several.
  const status = new Int32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const ya = y > 0 ? y - 1 : 0;
    const yb = y < sh - 1 ? y + 1 : y;
    for (let x = 0; x < sw; x++) {
      const xa = x > 0 ? x - 1 : 0;
      const xb = x < sw - 1 ? x + 1 : x;
      let first = -1;
      let mixed = false;
      for (let yy = ya; yy <= yb && !mixed; yy++) {
        const row = yy * sw;
        for (let xx = xa; xx <= xb; xx++) {
          const l = lab[row + xx];
          if (l < 0) continue;
          if (first < 0) first = l;
          else if (l !== first) {
            mixed = true;
            break;
          }
        }
      }
      status[y * sw + x] = mixed ? -2 : first;
    }
  }

  const colOf = new Int32Array(W);
  for (let X = 0; X < W; X++) {
    const x = Math.floor(X / U);
    colOf[X] = x < sw ? x : sw - 1;
  }
  const cand = new Int32Array(9);
  const c: RGB = [0, 0, 0];
  for (let Y = 0; Y < H; Y++) {
    let y = Math.floor(Y / U);
    if (y >= sh) y = sh - 1;
    const rowBase = y * sw;
    const ya = y > 0 ? y - 1 : 0;
    const yb = y < sh - 1 ? y + 1 : y;
    const cy = (Y + 0.5) / U;
    const outRow = Y * W;
    for (let X = 0; X < W; X++) {
      const i = outRow + X;
      const o = i * 4;
      if (ud[o + 3] < REGION_MIN_ALPHA) {
        out[i] = NO_REGION;
        continue;
      }
      const x = colOf[X];
      const s = status[rowBase + x];
      if (s >= 0) {
        out[i] = s;
        continue;
      }
      if (s === -1) {
        out[i] = NO_REGION;
        continue;
      }
      let m = 0;
      const xa = x > 0 ? x - 1 : 0;
      const xb = x < sw - 1 ? x + 1 : x;
      for (let yy = ya; yy <= yb; yy++) {
        const row = yy * sw;
        for (let xx = xa; xx <= xb; xx++) {
          const l = lab[row + xx];
          if (l < 0) continue;
          let j = 0;
          while (j < m && cand[j] !== l) j++;
          if (j === m) cand[m++] = l;
        }
      }
      const own = lab[rowBase + x];
      const cx = (X + 0.5) / U;
      const r = ud[o];
      const g = ud[o + 1];
      const b = ud[o + 2];
      let best = -1;
      let bestErr = Infinity;
      for (let j = 0; j < m; j++) {
        const k = cand[j];
        evaluateFill(fills[k], cx, cy, c);
        const dr = c[0] - r;
        const dg = c[1] - g;
        const db = c[2] - b;
        const err = dr * dr + dg * dg + db * db;
        if (err < bestErr || (err === bestErr && best !== own && (k === own || k < best))) {
          best = k;
          bestErr = err;
        }
      }
      out[i] = best;
    }
  }
  return out;
}

/** In place: label k -> position of k in `order`; NO_REGION stays. Returns the same array. */
export function rankMap(labels: Uint16Array, order: readonly number[]): Uint16Array {
  const pos = new Int32Array(NO_REGION + 1).fill(-1);
  for (let j = 0; j < order.length; j++) {
    const k = order[j];
    if (!Number.isInteger(k) || k < 0 || k >= NO_REGION || pos[k] !== -1) {
      throw new RangeError(`rankMap: order no es una permutación válida (posición ${j}: ${k})`);
    }
    pos[k] = j;
  }
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l === NO_REGION) continue;
    const p = pos[l];
    if (p < 0) throw new RangeError(`rankMap: etiqueta ${l} ausente de order`);
    labels[i] = p;
  }
  return labels;
}

/**
 * Mask of layer j. cutout: rank === j dilated `dilate` times with morphology.dilate1 (4-neighbour cross,
 * clipped to the image; computed as the city-block distance <= dilate inside the bounding box of the rank
 * grown by dilate, which is the same set), kept only on ranks >= j: the dilation slides under the layers
 * painted later (no seam where a later path does not quite reach the label boundary) and never over the
 * layers painted before, so every shape keeps its outline (dilating over them fattened each shape by
 * dilate/U px: gradientFeathers(256) at U 4 fell from fidelity 0.998 to 0.967); stacked: rank >= j. In both,
 * and rank !== NO_REGION.
 */
export function regionMask(
  ranks: Uint16Array,
  width: number,
  height: number,
  j: number,
  layering: Layering,
  dilate: number,
): BinaryMask {
  const n = width * height;
  if (ranks.length < n) throw new RangeError('regionMask: ranks.length < width·height');
  const out = new Uint8Array(n);
  const mask: BinaryMask = { data: out, width, height };
  if (layering === 'stacked') {
    for (let i = 0; i < n; i++) {
      const r = ranks[i];
      if (r >= j && r !== NO_REGION) out[i] = 1;
    }
    return mask;
  }
  if (j === NO_REGION) return mask;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (ranks[row + x] !== j) continue;
      out[row + x] = 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  const k = dilate > 0 ? Math.floor(dilate) : 0;
  if (x1 < 0 || k === 0) return mask;

  const wx0 = Math.max(0, x0 - k);
  const wy0 = Math.max(0, y0 - k);
  const wx1 = Math.min(width - 1, x1 + k);
  const wy1 = Math.min(height - 1, y1 + k);
  const ww = wx1 - wx0 + 1;
  const wh = wy1 - wy0 + 1;
  const far = k + 1;
  const dist = new Int32Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    const src = (wy0 + y) * width + wx0;
    const row = y * ww;
    for (let x = 0; x < ww; x++) dist[row + x] = out[src + x] !== 0 ? 0 : far;
  }
  // Two-pass city-block distance transform (exact for the 4-neighbour metric).
  for (let y = 0; y < wh; y++) {
    const row = y * ww;
    for (let x = 0; x < ww; x++) {
      const i = row + x;
      let v = dist[i];
      if (v === 0) continue;
      if (y > 0 && dist[i - ww] + 1 < v) v = dist[i - ww] + 1;
      if (x > 0 && dist[i - 1] + 1 < v) v = dist[i - 1] + 1;
      dist[i] = v;
    }
  }
  for (let y = wh - 1; y >= 0; y--) {
    const row = y * ww;
    for (let x = ww - 1; x >= 0; x--) {
      const i = row + x;
      let v = dist[i];
      if (v === 0) continue;
      if (y < wh - 1 && dist[i + ww] + 1 < v) v = dist[i + ww] + 1;
      if (x < ww - 1 && dist[i + 1] + 1 < v) v = dist[i + 1] + 1;
      dist[i] = v;
    }
  }
  for (let y = 0; y < wh; y++) {
    const dst = (wy0 + y) * width + wx0;
    const row = y * ww;
    for (let x = 0; x < ww; x++) {
      const p = dst + x;
      const r = ranks[p];
      out[p] = dist[row + x] <= k && r >= j && r !== NO_REGION ? 1 : 0;
    }
  }
  return mask;
}
