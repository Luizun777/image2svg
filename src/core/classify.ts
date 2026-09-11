/**
 * Source analysis and automatic mode selection. Pure; never mutates inputs.
 */
import type {
  BakedBackgroundSetting,
  ClassifyResult,
  GradientProbe,
  RasterImage,
  RegionModel,
  RGB,
  SourceInfo,
  TraceParams,
  Warning,
} from '../types';
import { alphaStats, borderModeColor, compositeOnColor, dominantInkColor, toGray } from './raster';
import { binarize, histogram256, isBimodal, resolveThreshold } from './threshold';
import { detectGrid, edgeThresholds, hardEdgeRatio, thinStrokeRatio } from './edges';
import { evaluateFill } from './fillEval';
import { applyBakedBackground, detectBakedCheckerboard } from './bakedBackground';
import { TRANSPARENT_AUTO_RATIO, resolveBackground } from './background';
import {
  distinctColorCount,
  exactPaletteDetailed,
  kmeansRefine,
  medianCut,
  offPaletteRatio,
  paletteError,
} from './palette';
import { downscaleBoxRaster } from './upscale';
import { immerkaerSigma } from './noise';
import { MAX_GRADIENT_REGIONS, mergeRegions, segmentRegions } from './regions';
import {
  GRADIENT_RMSE_FLOOR,
  GRADIENT_RMSE_SIGMA,
  accumulateMoments,
  corePixels,
  planMerges,
  selectModel,
} from './fillModel';

const WHITE: RGB = [255, 255, 255];

/** Thresholds of the classification rules (see ARCHITECTURE.md, "Decisiones de implementación"). */
export const PIXEL_HARD_EDGE_RATIO = 0.9;
export const PIXEL_MAX_DIM = 128;
/**
 * Sources above this area are never native-resolution pixel art without a detected grid: pixel
 * mode emits one rectangle per run of pixels (a 1440x1440 noisy image gave 2 million rects).
 */
export const PIXEL_MAX_AREA = 1_000_000;
export const LINES_MAX_COLORS = 2;
/** lines needs the two-colour palette to actually cover the image (a linear gradient has 2 "colours" too). */
export const LINES_MAX_OFF_PALETTE = 0.5;
export const FLAT_MAX_COLORS = 32;
/**
 * Above this share of pixels off the exact palette the image is a gradient / photo. Measured:
 * flat / line art (JPEG included) <= 0.083, gradients and photos >= 0.29.
 */
export const PHOTO_OFF_PALETTE_RATIO = 0.15;
export const PHOTO_FALLBACK_COLORS = 16;
/**
 * Raw-RGB tolerance of twoToneOffRatio: twice the flat-palette tolerance so that scan noise stays
 * inside. Measured off-ratio at 24 / 48: noisy sepia scan (+-30 per channel) 0.688 / 0.015,
 * (+-40) 0.817 / 0.101; Instagram 0.914 / 0.766; eagle 0.963 / 0.838.
 */
export const TWO_TONE_TOL = 48;
export const THIN_STROKE_RATIO = 0.5;
/** Palette size used to measure the colour error when the exact palette does not exist. */
const FALLBACK_PROBE_COLORS = 8;

// ---------------------------------------------------------------------------------------------
// Gradient probe (gradient mode)
// ---------------------------------------------------------------------------------------------

/** The gradient probe runs on a box-downscaled proxy whose longer side is at most this many pixels. */
export const GRADIENT_PROBE_MAX_SIDE = 512;
/**
 * Stops the probe's fits may use (maxStops defaults to 8 in the trace). The probe only asks whether a region is
 * explained: with 8, 6 and 4 stops every probe value of the measured table is identical, and a complex multicolour
 * region costs fitLinear 36-51 ms with 8 (Instagram: probe 111 ms with 8, 45 ms with 4).
 */
export const GRADIENT_PROBE_MAX_STOPS = 4;
/**
 * analyzeSource also probes an image whose exact palette covers it (the flat branch) when that palette has at least
 * this many colours: the exact palette of a smooth ramp is a staircase of many colours within the tolerance.
 */
export const GRADIENT_PROBE_MIN_COLORS = 8;
/**
 * Gradient rule: probe.edgeShare <= this. Also the probe's own limit, above which it fits no model (explained 0):
 * the pipeline falls back to the flat palette above the same share (pipeline.GRADIENT_MAX_EDGE_SHARE, not imported
 * because pipeline imports this module).
 */
export const GRADIENT_MAX_EDGE_SHARE = 0.6;
/** Gradient rule: probe.regions <= this. */
export const GRADIENT_MAX_REGIONS = 400;
/** Gradient rule: probe.explained >= this. */
export const GRADIENT_MIN_EXPLAINED = 0.85;
/** On the flat branch gradient mode must also bring gradients: probe.linearShare + probe.radialShare >= this. */
export const GRADIENT_FLAT_MIN_GRADIENT_SHARE = 0.05;
/** The 'photo' warning suggests gradient mode when probe.explained >= this. */
export const GRADIENT_SUGGEST_EXPLAINED = 0.5;
/**
 * The probe's limit on the share of the labelled area in complex regions, above which it reports nothing explained: the
 * pipeline falls back to the flat palette above the same share (pipeline.GRADIENT_MAX_COMPLEX_SHARE, not imported
 * because pipeline imports this module).
 */
export const GRADIENT_MAX_COMPLEX_SHARE = 0.5;
/**
 * A pixel deep inside a region (GRADIENT_PROBE_INTERIOR_RADIUS px from any other label or transparency) is foreign to
 * the region, and not explained, when its colour is more than GRADIENT_PROBE_FOREIGN_RATIO·sobHi levels (max channel;
 * 48 at the floors) from the region's model: a stroke, a ramp or a semi-transparent shape the segmentation handed to
 * a neighbour. The core RMSE of the region cannot see such pixels.
 */
export const GRADIENT_PROBE_FOREIGN_RATIO = 2;
/** Radius (px, Chebyshev) that keeps the foreign test off the anti-aliased band along region boundaries. */
export const GRADIENT_PROBE_INTERIOR_RADIUS = 2;

/** Proxy factor of the gradient probe: f = ceil(max(w, h) / GRADIENT_PROBE_MAX_SIDE), at least 1. */
export function gradientProbeFactor(width: number, height: number): number {
  return Math.max(1, Math.ceil(Math.max(width, height) / GRADIENT_PROBE_MAX_SIDE));
}

/** rgb *= alpha/255 (rounded); alpha untouched (the pipeline's private helper). */
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
 * Gradient-mode probe of `img` (the effective source): what gradient mode would make of it, measured on a
 * cheap proxy. `background` as resolveBackground 'auto' gives it (null = transparent: not composited, the proxy
 * is box-downscaled on premultiplied colour; an RGB: composited on it first); omitted → resolved here.
 * Proxy (downscaleBoxRaster by gradientProbeFactor) → sigma = immerkaerSigma → segmentRegions(proxy,
 * { regionDetail: 1, sigma }) → accumulateMoments → selectModel per region (GRADIENT_PROBE_MAX_STOPS stops, radial)
 * → one round of planMerges → mergeRegions → selectModel of the regions made of more than one. Shares are of the labelled area
 * (proxy pixels with alpha >= 128): explained = regions whose model has rmse <= max(GRADIENT_RMSE_FLOOR,
 * GRADIENT_RMSE_SIGMA·sigma) (the linear acceptance bound) less their foreign pixels (foreignPixels: deep inside the region
 * and far from its model, which the core RMSE cannot see), linearShare / radialShare = regions painted with a linear /
 * radial gradient. Where gradient mode falls back to the flat palette (edgeShare > GRADIENT_MAX_EDGE_SHARE, or more than
 * MAX_GRADIENT_REGIONS raw regions) nothing is fitted: regions = the raw count and the three shares 0; above
 * GRADIENT_MAX_COMPLEX_SHARE of the area in complex regions the three shares are 0 too.
 */
export function probeGradients(img: RasterImage, background?: RGB | null): GradientProbe {
  const bg = background === undefined ? resolveBackground(img, 'auto', { borderColor: borderModeColor(img) }) : background;
  return probeOn(bg === null ? img : compositeOnColor(img, bg), bg === null);
}

function probeOn(base: RasterImage, transparent: boolean): GradientProbe {
  const { width, height } = base;
  if (width === 0 || height === 0) return { sigma: 0, regions: 0, explained: 0, linearShare: 0, radialShare: 0, edgeShare: 0 };
  const f = gradientProbeFactor(width, height);
  const proxy =
    f === 1 ? base : transparent ? unpremultiply(downscaleBoxRaster(premultiply(base), f)) : downscaleBoxRaster(base, f);
  const sigma = immerkaerSigma(proxy);
  let seg = segmentRegions(proxy, { regionDetail: 1, sigma });
  const edgeShare = seg.edgeShare;
  if (edgeShare > GRADIENT_MAX_EDGE_SHARE || seg.regions.count > MAX_GRADIENT_REGIONS) {
    return { sigma, regions: seg.regions.count, explained: 0, linearShare: 0, radialShare: 0, edgeShare };
  }
  const opts = { sigma, maxStops: GRADIENT_PROBE_MAX_STOPS, radial: true };
  let px = corePixels(seg);
  let moments = accumulateMoments(proxy, seg);
  let models: RegionModel[] = [];
  for (let k = 0; k < seg.regions.count; k++) models.push(selectModel(proxy, px, k, moments, opts));
  // Complex regions do not become explained by merging: over the limit already, skip planMerges (a smooth colour field
  // such as noisePhoto(256) paid 15 s of joint fits there).
  if (complexShare(seg.area, models) > GRADIENT_MAX_COMPLEX_SHARE) {
    return { sigma, regions: seg.regions.count, explained: 0, linearShare: 0, radialShare: 0, edgeShare };
  }
  const pairs = planMerges(proxy, seg, models, { sigma, pixels: px, maxStops: GRADIENT_PROBE_MAX_STOPS, radial: true, smallGroups: false });
  if (pairs.length > 0) {
    const { seg: merged, remap } = mergeRegions(seg, pairs);
    const count = merged.regions.count;
    const members = new Int32Array(count);
    const member = new Int32Array(count);
    for (let old = 0; old < remap.length; old++) {
      members[remap[old]]++;
      member[remap[old]] = old;
    }
    px = corePixels(merged);
    moments = accumulateMoments(proxy, merged);
    const next: RegionModel[] = [];
    for (let k = 0; k < count; k++) {
      next.push(members[k] === 1 ? models[member[k]] : selectModel(proxy, px, k, moments, opts));
    }
    seg = merged;
    models = next;
  }
  const bound = Math.max(GRADIENT_RMSE_FLOOR, GRADIENT_RMSE_SIGMA * sigma);
  const count = seg.regions.count;
  const accepted = new Uint8Array(count);
  for (let k = 0; k < count; k++) if (models[k].rmse <= bound) accepted[k] = 1;
  const foreign = foreignPixels(proxy, seg.regions.data, models, accepted, GRADIENT_PROBE_FOREIGN_RATIO * edgeThresholds(sigma, 1).sobHi);
  let total = 0;
  let explained = 0;
  let linear = 0;
  let radial = 0;
  let complexArea = 0;
  for (let k = 0; k < count; k++) {
    const a = seg.area[k];
    const m = models[k];
    total += a;
    if (accepted[k] !== 0) explained += a - foreign[k];
    if (m.complex) complexArea += a;
    if (m.fill.kind === 'linear') linear += a;
    else if (m.fill.kind === 'radial') radial += a;
  }
  const share = (v: number): number => (total > 0 ? v / total : 0);
  if (share(complexArea) > GRADIENT_MAX_COMPLEX_SHARE) {
    return { sigma, regions: count, explained: 0, linearShare: 0, radialShare: 0, edgeShare };
  }
  return {
    sigma,
    regions: seg.regions.count,
    explained: share(explained),
    linearShare: share(linear),
    radialShare: share(radial),
    edgeShare,
  };
}

/** Share of the area in regions whose model is complex (0 without area). */
function complexShare(area: Float64Array, models: readonly RegionModel[]): number {
  let total = 0;
  let complex = 0;
  for (let k = 0; k < models.length; k++) {
    total += area[k];
    if (models[k].complex) complex += area[k];
  }
  return total > 0 ? complex / total : 0;
}

/**
 * Per region, the pixels of an accepted region (accepted[k] = 1) lying GRADIENT_PROBE_INTERIOR_RADIUS px or more inside
 * it (no other label and no transparency within that Chebyshev radius, clipped to the image) whose colour is more than
 * `tol` levels (max channel) from the region's model at the pixel centre.
 */
function foreignPixels(img: RasterImage, lab: Int32Array, models: readonly RegionModel[], accepted: Uint8Array, tol: number): Float64Array {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const out = new Float64Array(models.length);
  if (!accepted.some((v) => v !== 0)) return out;
  const r = GRADIENT_PROBE_INTERIOR_RADIUS;
  // boundary: no region, or a 4-neighbour with another label; then dilated by r with sliding counts.
  const boundary = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = lab[i];
      if (l < 0) {
        boundary[i] = 1;
        continue;
      }
      if (x + 1 < w && lab[i + 1] !== l) boundary[i] = boundary[i + 1] = 1;
      if (y + 1 < h && lab[i + w] !== l) boundary[i] = boundary[i + w] = 1;
    }
  }
  const hor = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let c = 0;
    for (let x = 0; x <= Math.min(w - 1, r); x++) c += boundary[row + x];
    for (let x = 0; x < w; x++) {
      if (c > 0) hor[row + x] = 1;
      if (x + r + 1 < w) c += boundary[row + x + r + 1];
      if (x - r >= 0) c -= boundary[row + x - r];
    }
  }
  const col = new Int32Array(w);
  for (let y = 0; y <= Math.min(h - 1, r); y++) for (let x = 0; x < w; x++) col[x] += hor[y * w + x];
  const c: RGB = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = lab[i];
      if (col[x] > 0 || k < 0 || accepted[k] === 0) continue;
      evaluateFill(models[k].fill, x + 0.5, y + 0.5, c);
      const o = i * 4;
      if (Math.max(Math.abs(d[o] - c[0]), Math.abs(d[o + 1] - c[1]), Math.abs(d[o + 2] - c[2])) > tol) out[k]++;
    }
    if (y + r + 1 < h) for (let x = 0; x < w; x++) col[x] += hor[(y + r + 1) * w + x];
    if (y - r >= 0) for (let x = 0; x < w; x++) col[x] -= hor[(y - r) * w + x];
  }
  return out;
}

/**
 * Facts about the source image, measured on the image composited over its resolved background
 * (border colour when the border agrees, else white): hardEdgeRatio on that RGB image, the stroke
 * statistics on its luma (mask = binarize(gray, resolveThreshold(gray, 0))). Colour statistics
 * (paletteColors, offPaletteRatio, quantError) ignore pixels with alpha < 128.
 * With `bakedBackground` 'auto' (default) a fake-transparency checkerboard painted into the pixels
 * is detected first and every statistic describes the effective source where it is transparent
 * (info.bakedBackground = the detection); 'keep' measures the pixels as they are (bakedBackground
 * null).
 */
export function analyzeSource(source: RasterImage, bakedBackground: BakedBackgroundSetting = 'auto'): SourceInfo {
  const baked = bakedBackground === 'keep' ? null : detectBakedCheckerboard(source);
  const img = baked === null ? source : applyBakedBackground(source, baked);
  const { width, height } = img;
  const { transparentRatio, partialAlphaRatio } = alphaStats(img);
  const borderColor = borderModeColor(img);
  const bg: RGB = borderColor ?? WHITE;
  const composited = compositeOnColor(img, bg);
  const gray = toGray(composited);
  const mask = binarize(gray, resolveThreshold(gray, 0));

  const exact = exactPaletteDetailed(img, FLAT_MAX_COLORS);
  const palette: RGB[] =
    exact !== null ? exact.colors : kmeansRefine(img, medianCut(img, FALLBACK_PROBE_COLORS));
  const offRatio = offPaletteRatio(img, palette);
  // The probe runs where gradient mode is an alternative: the branch classify() ends in 'photo' on (no exact palette,
  // or too much of the image off it), and an exact palette of GRADIENT_PROBE_MIN_COLORS or more colours (the staircase
  // a smooth ramp leaves within the palette tolerance). Background as resolveBackground 'auto'.
  const photoBranch = exact === null || offPaletteShare({ offPaletteRatio: offRatio, transparentRatio }) > PHOTO_OFF_PALETTE_RATIO;
  const manyColours = exact !== null && exact.colors.length >= GRADIENT_PROBE_MIN_COLORS;
  const transparent = transparentRatio > TRANSPARENT_AUTO_RATIO;
  const gradientProbe = photoBranch || manyColours ? probeOn(transparent ? img : composited, transparent) : null;

  return {
    width,
    height,
    transparentRatio,
    partialAlphaRatio,
    distinctColors: distinctColorCount(img),
    paletteColors: exact === null ? null : exact.colors.length,
    offPaletteRatio: offRatio,
    quantError: paletteError(img, palette),
    twoToneOffRatio: offPaletteRatio(img, kmeansRefine(img, medianCut(img, 2)), TWO_TONE_TOL),
    hardEdgeRatio: hardEdgeRatio(composited),
    thinStrokeRatio: thinStrokeRatio(mask),
    grid: detectGrid(img),
    dominantInk: dominantInkColor(img, bg),
    borderColor,
    isBimodal: isBimodal(histogram256(gray)),
    bakedBackground: baked,
    gradientProbe,
  };
}

function pct(v: number): string {
  return (v * 100).toFixed(0);
}

function thinStrokeWarning(info: SourceInfo): Warning {
  return {
    code: 'thin-strokes',
    message:
      `Los trazos son muy finos: el ${pct(info.thinStrokeRatio)} % de la tinta desaparece con una ` +
      'erosión de 1 px. Conviene aumentar el reescalado o reducir el desenfoque para no perderlos.',
  };
}

/**
 * offPaletteRatio weighed by the opaque share of the image (1 - transparentRatio): the photo rule
 * compares images, and on transparency a logo's edges are most of its opaque pixels. clip_art
 * without its checkerboard: 0.306 of its opaque pixels, 0.037 of the image (with the painted
 * checkerboard, opaque: 0.082).
 */
export function offPaletteShare(info: Pick<SourceInfo, 'offPaletteRatio' | 'transparentRatio'>): number {
  return info.offPaletteRatio * (1 - info.transparentRatio);
}

function photoWarning(info: SourceInfo): Warning {
  const why =
    info.paletteColors === null
      ? `tiene más de ${FLAT_MAX_COLORS} colores reales`
      : `el ${pct(offPaletteShare(info))} % de los píxeles no coincide con ninguno de sus ${info.paletteColors} colores planos`;
  const suggest =
    info.gradientProbe !== null && info.gradientProbe.explained >= GRADIENT_SUGGEST_EXPLAINED ? ' Prueba el modo Degradados.' : '';
  return {
    code: 'photo',
    message:
      `La imagen ${why}; parece una fotografía o un degradado. Se usará una paleta de ` +
      `${PHOTO_FALLBACK_COLORS} colores y el resultado puede perder detalle.${suggest}`,
  };
}

/**
 * The gradient rule on a probe: edgeShare <= GRADIENT_MAX_EDGE_SHARE, regions <= GRADIENT_MAX_REGIONS and explained >=
 * GRADIENT_MIN_EXPLAINED; when the exact palette already covers the image (`flatPalette`), also linearShare +
 * radialShare >= GRADIENT_FLAT_MIN_GRADIENT_SHARE (gradient mode must bring gradients to replace flat mode there).
 */
export function choosesGradient(probe: GradientProbe, flatPalette: boolean): boolean {
  return (
    probe.edgeShare <= GRADIENT_MAX_EDGE_SHARE &&
    probe.regions <= GRADIENT_MAX_REGIONS &&
    probe.explained >= GRADIENT_MIN_EXPLAINED &&
    (!flatPalette || probe.linearShare + probe.radialShare >= GRADIENT_FLAT_MIN_GRADIENT_SHARE)
  );
}

function regionCount(n: number): string {
  return `${n} ${n === 1 ? 'región' : 'regiones'}`;
}

/**
 * pixel: grid >= 2, or hard edges (> 0.9) with min(w,h) <= 128 and w*h <= 1 Mpx.
 * lines: <= 2 real colours covering the image (offPaletteRatio <= 0.5), or — when the image has
 *        too many colours for an exact palette (noisy scans) — a bimodal luma histogram AND two
 *        colours covering it (twoToneOffRatio <= 0.5): colourful gradients are bimodal too;
 *        with a transparent background (transparentRatio > 0.05) only 1 real colour, and no
 *        noisy-scan rule (the palette holds only inks); 'thin-strokes' warning when
 *        thinStrokeRatio > 0.5.
 * gradient: a gradient probe (analyzeSource computes it on the photo branch and for exact palettes of
 *        GRADIENT_PROBE_MIN_COLORS or more colours) that passes choosesGradient -> { mode: 'gradient' }, no
 *        warning, before the flat rule.
 * photo: no exact palette (> 32 real colours) or more than 15 % of the image off the exact
 *        palette (offPaletteShare: offPaletteRatio x opaque share) -> flat with 16 median-cut
 *        colours (exactPalette false) plus the 'photo' warning, which suggests gradient mode when
 *        probe.explained >= GRADIENT_SUGGEST_EXPLAINED.
 * flat:  otherwise, with colors 'auto' (exact palette).
 */
export function classify(info: SourceInfo): ClassifyResult {
  const warnings: Warning[] = [];
  const reasons: string[] = [];
  const minDim = Math.min(info.width, info.height);

  if (info.grid >= 2) {
    reasons.push(
      `Se detectó una cuadrícula de bloques de ${info.grid}×${info.grid} px: la imagen es pixel art reescalado.`,
    );
    const params: TraceParams = { mode: 'pixel', gridScale: info.grid };
    return { mode: 'pixel', params, warnings, reasons };
  }

  if (
    info.hardEdgeRatio > PIXEL_HARD_EDGE_RATIO &&
    minDim <= PIXEL_MAX_DIM &&
    info.width * info.height <= PIXEL_MAX_AREA
  ) {
    reasons.push(
      `Bordes duros sin suavizado (${pct(info.hardEdgeRatio)} %) en una imagen de ` +
        `${info.width}×${info.height} px (≤ ${PIXEL_MAX_DIM} px): pixel art a tamaño nativo.`,
    );
    const params: TraceParams = { mode: 'pixel', gridScale: 1 };
    return { mode: 'pixel', params, warnings, reasons };
  }

  // With a transparent background the palette only holds the inks (the transparency is the paper):
  // a single colour is a line drawing, two are two inks, and the composited luma is bimodal anyway.
  const transparent = info.transparentRatio > TRANSPARENT_AUTO_RATIO;
  const fewColors =
    info.paletteColors !== null &&
    info.paletteColors <= (transparent ? LINES_MAX_COLORS - 1 : LINES_MAX_COLORS) &&
    info.offPaletteRatio <= LINES_MAX_OFF_PALETTE;
  const noisyBitonal =
    !transparent && info.paletteColors === null && info.isBimodal && info.twoToneOffRatio <= LINES_MAX_OFF_PALETTE;
  if (fewColors || noisyBitonal) {
    if (fewColors) {
      reasons.push(
        `Solo ${info.paletteColors} color(es) reales (${info.distinctColors} tonos contando el suavizado de bordes): ` +
          'dibujo de líneas / trazo monocromo.',
      );
    } else {
      reasons.push(
        `Muchos tonos (${info.distinctColors}) pero el histograma de luminancia es bimodal y dos colores cubren el ` +
          `${pct(1 - info.twoToneOffRatio)} % de los píxeles: dibujo de líneas con ruido.`,
      );
    }
    if (info.thinStrokeRatio > THIN_STROKE_RATIO) warnings.push(thinStrokeWarning(info));
    const params: TraceParams = { mode: 'lines' };
    return { mode: 'lines', params, warnings, reasons };
  }

  const offShare = offPaletteShare(info);
  const flatPalette = info.paletteColors !== null && offShare <= PHOTO_OFF_PALETTE_RATIO;
  const probe = info.gradientProbe;
  if (probe !== null && choosesGradient(probe, flatPalette)) {
    const gradientShare = probe.linearShare + probe.radialShare;
    reasons.push(
      `El ${pct(probe.explained)} % de los píxeles se explica con ${regionCount(probe.regions)} de color plano o degradado` +
        (gradientShare >= 0.005 ? ` (el ${pct(gradientShare)} % con degradados)` : '') +
        ': se vectoriza en modo Degradados.',
    );
    if (flatPalette) {
      reasons.push(
        `Sus ${info.paletteColors} colores planos cubren la imagen, pero partirían cada degradado en bandas de color.`,
      );
    }
    const params: TraceParams = { mode: 'gradient' };
    return { mode: 'gradient', params, warnings, reasons };
  }

  if (flatPalette) {
    reasons.push(
      `${info.paletteColors} colores planos reales (≤ ${FLAT_MAX_COLORS}) que cubren el ${pct(1 - offShare)} % ` +
        'de los píxeles: ilustración de colores planos con paleta exacta.',
    );
    const params: TraceParams = { mode: 'flat', colors: 'auto' };
    return { mode: 'flat', params, warnings, reasons };
  }

  reasons.push(
    info.paletteColors === null
      ? `Más de ${FLAT_MAX_COLORS} colores reales (${info.distinctColors} tonos): imagen fotográfica o con degradados; ` +
          `se vectoriza en modo plano con ${PHOTO_FALLBACK_COLORS} colores.`
      : `El ${pct(offShare)} % de los píxeles queda fuera de sus ${info.paletteColors} colores planos ` +
          `(> ${pct(PHOTO_OFF_PALETTE_RATIO)} %): degradados o fotografía; se vectoriza en modo plano con ${PHOTO_FALLBACK_COLORS} colores.`,
  );
  warnings.push(photoWarning(info));
  // exactPalette false: the exact palette is precisely what failed to cover the image, so the
  // 16 colours must come from median cut + k-means, not from it.
  const params: TraceParams = { mode: 'flat', colors: PHOTO_FALLBACK_COLORS, exactPalette: false };
  return { mode: 'flat', params, warnings, reasons };
}
