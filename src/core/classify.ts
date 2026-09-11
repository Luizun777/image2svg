/**
 * Source analysis and automatic mode selection. Pure; never mutates inputs.
 */
import type { BakedBackgroundSetting, ClassifyResult, RasterImage, RGB, SourceInfo, TraceParams, Warning } from '../types';
import { alphaStats, borderModeColor, compositeOnColor, dominantInkColor, toGray } from './raster';
import { binarize, histogram256, isBimodal, resolveThreshold } from './threshold';
import { detectGrid, hardEdgeRatio, thinStrokeRatio } from './edges';
import { applyBakedBackground, detectBakedCheckerboard } from './bakedBackground';
import { TRANSPARENT_AUTO_RATIO } from './background';
import {
  distinctColorCount,
  exactPaletteDetailed,
  kmeansRefine,
  medianCut,
  offPaletteRatio,
  paletteError,
} from './palette';

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
  const probe: RGB[] =
    exact !== null ? exact.colors : kmeansRefine(img, medianCut(img, FALLBACK_PROBE_COLORS));

  return {
    width,
    height,
    transparentRatio,
    partialAlphaRatio,
    distinctColors: distinctColorCount(img),
    paletteColors: exact === null ? null : exact.colors.length,
    offPaletteRatio: offPaletteRatio(img, probe),
    quantError: paletteError(img, probe),
    twoToneOffRatio: offPaletteRatio(img, kmeansRefine(img, medianCut(img, 2)), TWO_TONE_TOL),
    hardEdgeRatio: hardEdgeRatio(composited),
    thinStrokeRatio: thinStrokeRatio(mask),
    grid: detectGrid(img),
    dominantInk: dominantInkColor(img, bg),
    borderColor,
    isBimodal: isBimodal(histogram256(gray)),
    bakedBackground: baked,
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
  return {
    code: 'photo',
    message:
      `La imagen ${why}; parece una fotografía o un degradado. Se usará una paleta de ` +
      `${PHOTO_FALLBACK_COLORS} colores y el resultado puede perder detalle.`,
  };
}

/**
 * pixel: grid >= 2, or hard edges (> 0.9) with min(w,h) <= 128 and w*h <= 1 Mpx.
 * lines: <= 2 real colours covering the image (offPaletteRatio <= 0.5), or — when the image has
 *        too many colours for an exact palette (noisy scans) — a bimodal luma histogram AND two
 *        colours covering it (twoToneOffRatio <= 0.5): colourful gradients are bimodal too;
 *        with a transparent background (transparentRatio > 0.05) only 1 real colour, and no
 *        noisy-scan rule (the palette holds only inks); 'thin-strokes' warning when
 *        thinStrokeRatio > 0.5.
 * photo: no exact palette (> 32 real colours) or more than 15 % of the image off the exact
 *        palette (offPaletteShare: offPaletteRatio x opaque share) -> flat with 16 median-cut
 *        colours (exactPalette false) plus the 'photo' warning.
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
  if (info.paletteColors !== null && offShare <= PHOTO_OFF_PALETTE_RATIO) {
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
