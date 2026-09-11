/**
 * Fidelity metrics between the original raster and a rendered SVG raster. Pure; never mutates.
 */
import type { ConcreteMode, Metrics, PathStats, RasterImage, RGB } from '../types';
import { gaussianBlur } from '../core/blur';
import { compositeOnColor, toGray } from '../core/raster';
import { binarize, histogram256, otsu } from '../core/threshold';
import { inkBBox } from './bbox';
import { iou, mae, pctDiff } from './iou';
import { ssim } from './ssim';

export interface FidelityInput {
  original: RasterImage;
  rendered: RasterImage;
  mode: ConcreteMode;
  /** Colour both images are composited on before comparing. */
  background: RGB;
  /** lines mode only: binarisation threshold (0..1); default Otsu of the composited original. */
  thresholdNorm?: number;
}

/** Sigma of the blur applied before SSIM / MAE (tolerates sub-pixel edge shifts). */
const METRIC_BLUR_SIGMA = 0.8;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Both images composited on `background` -> luma. ROI = inkBBox of the original luma.
 * SSIM and MAE on gaussianBlur(σ = 0.8); pctDiff16/32 on the composited RGB.
 * IoU: lines -> binary masks of the UNBLURRED lumas at thresholdNorm ?? Otsu(original) / 255;
 * flat/pixel -> 1 - pctDiff16. fidelity = clamp01(0.6 * ssim + 0.4 * iou).
 * Throws when the two images differ in size.
 */
export function computeMetrics(inp: FidelityInput): Metrics {
  const { original, rendered, mode, background } = inp;
  if (original.width !== rendered.width || original.height !== rendered.height) {
    throw new Error(
      `computeMetrics: la imagen original y la renderizada tienen tamaños distintos ` +
        `(${original.width}x${original.height} vs ${rendered.width}x${rendered.height})`,
    );
  }
  const oc = compositeOnColor(original, background);
  const rc = compositeOnColor(rendered, background);
  const og = toGray(oc);
  const rg = toGray(rc);
  const bgLuma = 0.299 * background[0] + 0.587 * background[1] + 0.114 * background[2];
  const roi = inkBBox(og, bgLuma);

  const ob = gaussianBlur(og, METRIC_BLUR_SIGMA);
  const rb = gaussianBlur(rg, METRIC_BLUR_SIGMA);
  const s = ssim(ob, rb, roi);
  const m = mae(ob, rb, roi);
  const p16 = pctDiff(oc, rc, 16, roi);
  const p32 = pctDiff(oc, rc, 32, roi);

  let io: number;
  if (mode === 'lines') {
    let t = inp.thresholdNorm;
    if (t === undefined || !Number.isFinite(t)) t = otsu(histogram256(og)) / 255;
    io = iou(binarize(og, t), binarize(rg, t), roi);
  } else {
    io = 1 - p16;
  }

  return {
    fidelity: clamp01(0.6 * s + 0.4 * io),
    ssim: s,
    iou: io,
    mae: m,
    pctDiff16: p16,
    pctDiff32: p32,
  };
}

/**
 * Auto-tuner objective: fidelity minus a corner penalty (0.15 * cornerFraction) and a
 * complexity penalty (0.10 * min(1, nodeCount / max(1, 2 * perimeterPx))).
 */
export function tunerScore(m: Metrics, stats: PathStats, perimeterPx: number): number {
  const density = stats.nodeCount / Math.max(1, 2 * perimeterPx);
  return m.fidelity - 0.15 * stats.cornerFraction - 0.1 * Math.min(1, density);
}
