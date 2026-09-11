/**
 * Ground-truth Segmentation for the gradient-mode tests, built from a known RegionMap WITHOUT
 * src/core/regions.ts: lets core/fillModel.ts be tested against the true shapes, independently of the
 * edge detector. Pure, no vitest dependency.
 *
 *   regions  = labels, and -1 where alpha < 128 (the cut regions.ts uses)
 *   core     = alpha >= 250 and every in-image 4-neighbour has the same label (out-of-image neighbours
 *              count as the same, like the replicated borders of the edge maps)
 *   edge     = every other labelled pixel (the label boundary on both sides, and semi-transparent pixels)
 *   area     = labelled pixels per region; adjacency = 4-adjacent ids, ascending, without self or repeats
 *   sigma    = opts.sigma, or Immerkaer's estimate over the pixels whose whole 3x3 is core of one region
 *   edgeShare = |edge| / |alpha >= 128|
 */
import type { BinaryMask, LabelMap, RasterImage, RegionMap, Segmentation } from '../../src/types';
import { coverage, type Sdf } from '../../src/dev/synth';

export const SEG_REGION_MIN_ALPHA = 128;
export const SEG_CORE_MIN_ALPHA = 250;

export interface SegFromLabelsOptions {
  /** Noise estimate to store in the segmentation; default: immerkaerOnCore. */
  sigma?: number;
}

/**
 * Immerkaer (1996) noise estimate in levels on the Rec.601 luma, summing |L * N|, N = [[1,-2,1],[-2,4,-2],
 * [1,-2,1]], only over pixels whose 3x3 is entirely core of a single region (no label edge, no AA band):
 * sigma = sqrt(pi/2) * sum / (6 n); 0 when no pixel qualifies.
 */
export function immerkaerOnCore(img: RasterImage, core: BinaryMask, regions: RegionMap): number {
  const W = img.width;
  const H = img.height;
  const d = img.data;
  const reg = regions.data;
  const cd = core.data;
  const luma = (p: number): number => 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
  let sum = 0;
  let n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const k = reg[i];
      if (k < 0) continue;
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const q = i + dy * W + dx;
          if (cd[q] === 0 || reg[q] !== k) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      const v =
        luma(i - W - 1) - 2 * luma(i - W) + luma(i - W + 1) -
        2 * luma(i - 1) + 4 * luma(i) - 2 * luma(i + 1) +
        luma(i + W - 1) - 2 * luma(i + W) + luma(i + W + 1);
      sum += Math.abs(v);
      n++;
    }
  }
  return n === 0 ? 0 : (Math.sqrt(Math.PI / 2) * sum) / (6 * n);
}

/** Segmentation of `img` whose regions are exactly `labels` (see the module comment). */
export function segFromLabels(img: RasterImage, labels: RegionMap, opts: SegFromLabelsOptions = {}): Segmentation {
  const W = img.width;
  const H = img.height;
  if (labels.width !== W || labels.height !== H) {
    throw new RangeError(`segFromLabels: labels ${labels.width}x${labels.height} != image ${W}x${H}`);
  }
  const n = W * H;
  const count = labels.count;
  const d = img.data;
  const reg = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = labels.data[i];
    if (k >= count) throw new RangeError(`segFromLabels: label ${k} >= count ${count}`);
    reg[i] = d[i * 4 + 3] < SEG_REGION_MIN_ALPHA ? -1 : k;
  }
  const core = new Uint8Array(n);
  const edge = new Uint8Array(n);
  const area = new Float64Array(count);
  const sets: Array<Set<number>> = Array.from({ length: count }, () => new Set<number>());
  let labelled = 0;
  let edges = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const k = reg[i];
      if (k < 0) continue;
      labelled++;
      area[k]++;
      let same = true;
      if (x > 0 && reg[i - 1] !== k) same = false;
      if (x < W - 1 && reg[i + 1] !== k) same = false;
      if (y > 0 && reg[i - W] !== k) same = false;
      if (y < H - 1 && reg[i + W] !== k) same = false;
      if (x < W - 1 && reg[i + 1] >= 0 && reg[i + 1] !== k) {
        sets[k].add(reg[i + 1]);
        sets[reg[i + 1]].add(k);
      }
      if (y < H - 1 && reg[i + W] >= 0 && reg[i + W] !== k) {
        sets[k].add(reg[i + W]);
        sets[reg[i + W]].add(k);
      }
      if (same && d[i * 4 + 3] >= SEG_CORE_MIN_ALPHA) core[i] = 1;
      else {
        edge[i] = 1;
        edges++;
      }
    }
  }
  const regions: RegionMap = { data: reg, width: W, height: H, count };
  const coreMask: BinaryMask = { data: core, width: W, height: H };
  const adjacency = sets.map((s) => Int32Array.from([...s].sort((a, b) => a - b)));
  const sigma = opts.sigma ?? immerkaerOnCore(img, coreMask, regions);
  return {
    regions,
    edge: { data: edge, width: W, height: H },
    core: coreMask,
    area,
    adjacency,
    sigma,
    edgeShare: labelled === 0 ? 0 : edges / labelled,
  };
}

/** A LabelMap (Uint8) as a RegionMap (Int32), same ids. */
export function regionMapFromLabelMap(labels: LabelMap): RegionMap {
  return { data: Int32Array.from(labels.data), width: labels.width, height: labels.height, count: labels.count };
}

/** Two-region map of a single shape: 1 where its coverage (8x8 subsamples) is >= 0.5, else 0 (background). */
export function labelsFromSdf(size: number, sdf: Sdf): RegionMap {
  const cov = coverage(size, sdf);
  const data = new Int32Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = cov[i] >= 0.5 ? 1 : 0;
  return { data, width: size, height: size, count: 2 };
}

/** Every pixel in region 0 (an image that is one region, like hueRamp). */
export function singleRegion(width: number, height: number): RegionMap {
  return { data: new Int32Array(width * height), width, height, count: 1 };
}
