/**
 * Integration pipeline: RasterImage + TraceParams -> { svg, stats, resolved, warnings, ms }.
 *
 * lines: composite (or alpha mask) -> gray -> upscale U -> gaussian blur sigmaPx -> binarize at
 *        the 50 % ink/paper iso-level measured on the UNBLURRED gray (resolveThreshold) -> tracer
 *        -> one Layer -> assembleSvg (viewBox W·U × H·U). 'empty-trace' when a non-blank image
 *        ends up without ink.
 * flat:  composite -> palette on the ORIGINAL composited image -> upscaleRaster U + blurRaster
 *        (premultiplied when the background is transparent) -> assignLabels on the upscaled
 *        image -> layerOrder -> nested (or cutout) masks -> tracer per mask, back to front.
 *        A mask that covers the whole canvas (masks[0] in stacked mode over an opaque
 *        background) is emitted as a single rectangular path instead of being traced; with a
 *        transparent background pixels with alpha < 128 belong to no layer.
 * gradient: composite like flat -> box proxy <= 4 Mpx -> noise sigma -> edge segmentation into regions ->
 *        one solid / linear / radial model per region, merged regions re-fitted -> resampleRaster U ->
 *        labels refined at Ux by the models -> painter's order -> one lazy mask per region, the layer
 *        carrying its gradient (see prepareGradient). Too many edges or regions: 16-colour flat palette
 *        with the 'gradient-fallback' warning.
 * pixel: detectGrid (or gridScale) -> downscaleNearest -> pixelSvg at the source size (a gridScale
 *        that does not divide the image keeps its partial edge blocks, in source-pixel coordinates);
 *        above MAX_PIXEL_RECTS merged rectangles no SVG is built (svg '') and 'too-many-rects'
 *        points to Color plano.
 *
 * Pure TypeScript: no DOM. Tracers are injected; potrace auto-initialises, vtracer must have
 * been initialised by the caller (the worker passes the wasm URL, Node tests the bytes).
 */
import type {
  AbsPath,
  BakedCheckerboard,
  BinaryMask,
  ConcreteMode,
  Engine,
  Fill,
  Gradient,
  GrayImage,
  Layer,
  PathStats,
  RasterImage,
  RegionModel,
  ResolvedParams,
  RGB,
  Segmentation,
  SourceInfo,
  TraceParams,
  TraceResult,
  Tracer,
  TracerOptions,
  Warning,
} from '../types';
import { alphaToGray, compositeOnColor, dominantInkColor, toGray } from './raster';
import { MAX_UPSCALED_AREA, downscaleBoxRaster, upscaleGray, upscaleRaster } from './upscale';
import { gaussianBlur, gaussianBlurRaster } from './blur';
import { binarize, maskFromAlpha, resolveThreshold } from './threshold';
import { resolveAlphaMode, resolveBackground } from './background';
import { resolveParams } from './params';
import { assignLabels, buildPalette, toHex } from './palette';
import { cutoutMasks, layerOrder, nestedMasks } from './stack';
import { MAX_PIXEL_RECTS, downscaleNearest, pixelSvg } from './pixelExact';
import { countInk } from './morphology';
import { detectGrid } from './edges';
import { analyzeSource, classify, PHOTO_FALLBACK_COLORS, THIN_STROKE_RATIO } from './classify';
import { applyBakedBackground, detectBakedCheckerboard, effectiveSource } from './bakedBackground';
import { immerkaerSigma } from './noise';
import { CORE_MIN_ALPHA, MAX_GRADIENT_REGIONS, NO_REGION, mergeRegions, rankMap, refineLabels, regionMask, regionOrder, segmentEdges, segmentRegions } from './regions';
import { accumulateMoments, corePixels, extendGradient, planMerges, rmseOf, selectModel, type RegionPixels } from './fillModel';
import { isDegenerateGradient, scaleGradient } from './fillEval';
import { assembleSvg } from '../svg/assemble';
import { gradientMeanHex, rgbToHex } from '../svg/gradients';
import { pathStats, utf8ByteLength } from '../svg/pathStats';

export interface PreparedLayer {
  /**
   * Pixels of the layer at Ux (1 = paint). A function builds the mask on demand: gradient mode keeps a
   * single mask alive at a time (dozens of 16 Mpx masks at once would not fit). Read it with layerMask().
   */
  mask: BinaryMask | (() => BinaryMask);
  /** '#rrggbb'; with `gradient`, the mean colour of its stops. */
  fill: string;
  opacity?: number;
  /** Gradient mode: the gradient that paints the layer, in viewBox units (Ux). */
  gradient?: Gradient;
}

/** The layer's mask. A lazy mask is built again on every call: keep the result if you need it twice. */
export function layerMask(pl: PreparedLayer): BinaryMask {
  return typeof pl.mask === 'function' ? pl.mask() : pl.mask;
}

export interface Prepared {
  U: number;
  width: number;
  height: number;
  layers: PreparedLayer[];
  warnings: Warning[];
}

const WHITE: RGB = [255, 255, 255];

/** Above this many rectangles the pixel-mode SVG gets a 'too-many-rects' warning. */
export const TOO_MANY_RECTS = 10_000;

// ---------------------------------------------------------------------------------------------
// Warnings (user-facing text in Spanish)
// ---------------------------------------------------------------------------------------------

function pct(v: number): string {
  return (v * 100).toFixed(0);
}

function upscaleCappedWarning(resolved: ResolvedParams): Warning {
  return {
    code: 'upscale-capped',
    message:
      `El reescalado se limitó a ${resolved.upscale}× para no superar los 16 Mpx de trabajo; ` +
      'los bordes pueden quedar menos suaves de lo pedido.',
  };
}

function thinStrokesWarning(info: SourceInfo): Warning {
  return {
    code: 'thin-strokes',
    message:
      `Los trazos son muy finos: el ${pct(info.thinStrokeRatio)} % de la tinta desaparece con una ` +
      'erosión de 1 px. Conviene aumentar el reescalado o reducir el desenfoque para no perderlos.',
  };
}

function largeInputWarning(width: number, height: number): Warning {
  return {
    code: 'large-input',
    message:
      `La imagen es muy grande (${width}×${height} px, más de 16 Mpx): se procesa sin reescalar ` +
      'y puede tardar bastante.',
  };
}

function engineUnavailableWarning(wanted: Engine, used: Engine): Warning {
  return {
    code: 'engine-unavailable',
    message: `El motor "${wanted}" no está disponible; se usó "${used}" en su lugar.`,
  };
}

/** Thousands separated by spaces (Spanish style), e.g. 2 070 717. */
function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function pixelRectCapWarning(count: number): Warning {
  return {
    code: 'too-many-rects',
    message:
      `El modo píxel necesitaría ${formatCount(count)} rectángulos (el límite es ${formatCount(MAX_PIXEL_RECTS)}), ` +
      'así que no se generó el SVG: sería enorme y podría bloquear el navegador. Esta imagen no es pixel art; ' +
      'usa el modo Color plano.',
  };
}

/**
 * threshold: the mask came out without ink; transparency: the same in composite mode on a source whose
 * alpha has a shape (a light logo on transparent composites to plain paper), so the fix is the alpha
 * mask; tracer: the masks had ink but the tracer dropped all of it.
 */
function emptyTraceWarning(cause: 'threshold' | 'transparency' | 'tracer'): Warning {
  let message: string;
  if (cause === 'threshold') {
    message =
      'No se encontró tinta que vectorizar: el SVG sale vacío aunque la imagen no está en blanco. ' +
      'Ajusta el umbral, prueba a invertir o usa el modo Color plano.';
  } else if (cause === 'transparency') {
    message =
      'No se encontró tinta que vectorizar: el SVG sale vacío aunque la imagen tiene zonas transparentes. ' +
      'Prueba Transparencia: Máscara, que traza la silueta de las zonas opacas.';
  } else {
    message =
      'El trazado eliminó toda la tinta (manchas por debajo del tamaño mínimo): el SVG sale vacío. ' +
      'Reduce las manchas mínimas o ajusta el umbral.';
  }
  return { code: 'empty-trace', message };
}

/** The source had a fake-transparency checkerboard painted into its pixels and it was made transparent. */
export function bakedCheckerboardWarning(det: BakedCheckerboard): Warning {
  return {
    code: 'baked-checkerboard',
    message:
      `La imagen no es transparente de verdad: lleva pintado un tablero de ajedrez (cuadros de ${Math.round(det.cell)} px) ` +
      'que imita la transparencia. Se trató como fondo transparente y se excluyó de la comparación de fidelidad. ' +
      'Si el tablero forma parte del diseño, puedes conservarlo.',
  };
}

/**
 * Gradient mode could not rebuild the image with gradients and traced it as a flat palette of
 * PHOTO_FALLBACK_COLORS colours. `reason` (Spanish, lower-case start, no final period) says why; null
 * gives the generic sentence.
 */
export function gradientFallbackWarning(reason: string | null): Warning {
  const why = reason === null ? '' : `: ${reason}`;
  return {
    code: 'gradient-fallback',
    message:
      `No se pudieron reconstruir los degradados${why}. ` +
      `Se vectorizó como Color plano con ${PHOTO_FALLBACK_COLORS} colores y pueden verse bandas de color.`,
  };
}

function tooManyRectsWarning(count: number): Warning {
  return {
    code: 'too-many-rects',
    message:
      `El modo píxel generó ${count} rectángulos (más de ${TOO_MANY_RECTS}); el SVG será pesado. ` +
      'Prueba el modo de líneas o de colores planos.',
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function assertImage(img: RasterImage, fn: string): void {
  const { width, height, data } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`${fn}: dimensiones de imagen inválidas (${String(width)}×${String(height)})`);
  }
  if (data.length !== width * height * 4) {
    throw new RangeError(
      `${fn}: data.length (${data.length}) no coincide con width*height*4 (${width * height * 4})`,
    );
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Gray -> upscale U -> blur sigmaPx (sigma <= 0 or U = 1 are handled by the modules). */
function upscaleAndBlur(gray: GrayImage, U: number, sigmaPx: number): GrayImage {
  const up = upscaleGray(gray, U);
  return sigmaPx > 0 ? gaussianBlur(up, sigmaPx) : up;
}

/** True when every value equals the first one (a blank source: nothing to trace). */
function isUniform(img: GrayImage): boolean {
  const d = img.data;
  for (let i = 1; i < d.length; i++) if (d[i] !== d[0]) return false;
  return true;
}

/** True when every pixel has the same alpha (no shape in the transparency). */
function isAlphaUniform(img: RasterImage): boolean {
  const d = img.data;
  for (let p = 7; p < d.length; p += 4) if (d[p] !== d[3]) return false;
  return true;
}

/** True when every pixel of the mask is ink (a full-canvas layer). */
export function isFullMask(mask: BinaryMask): boolean {
  const d = mask.data;
  for (let i = 0; i < d.length; i++) if (d[i] === 0) return false;
  return d.length > 0;
}

/** In-place a &= b (both same size). */
function intersectInto(a: BinaryMask, b: BinaryMask): void {
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i++) if (db[i] === 0) da[i] = 0;
}

/** Single closed rectangle path covering [0,w]×[0,h] in viewBox units. */
export function rectPath(w: number, h: number): AbsPath {
  return {
    segs: [
      { kind: 'M', x: 0, y: 0 },
      { kind: 'L', x: w, y: 0 },
      { kind: 'L', x: w, y: h },
      { kind: 'L', x: 0, y: h },
      { kind: 'Z' },
    ],
  };
}

function baseWarnings(resolved: ResolvedParams, width: number, height: number): Warning[] {
  const warnings: Warning[] = [];
  if (resolved.upscaleCapped) warnings.push(upscaleCappedWarning(resolved));
  if (width * height > MAX_UPSCALED_AREA) warnings.push(largeInputWarning(width, height));
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// lines
// ---------------------------------------------------------------------------------------------

/**
 * One binary layer. alphaMode 'mask': the alpha channel is the gray source and the ink is
 * alpha >= (0.5 + thresholdOffset) after upscale + blur. 'composite': the image is composited
 * once over the resolved background (white when the background is transparent), converted to
 * luma, upscaled and blurred; the blurred image is binarised at resolveThreshold(luma) — the
 * 50 % coverage iso-level between ink and paper measured on the UNBLURRED luma (the blur keeps
 * flat levels but lightens thin strokes, which would fatten them).
 * A mask without any ink adds the 'empty-trace' warning unless the image is blank: its composite
 * luma AND its alpha are both uniform (a white logo on transparent composites to plain white, yet
 * its alpha is the logo). In composite mode with a non-uniform alpha the warning points to the
 * alpha mask (Transparencia: Máscara) instead of the threshold.
 */
export function prepareLines(img: RasterImage, resolved: ResolvedParams, info: SourceInfo): Prepared {
  assertImage(img, 'prepareLines');
  const { width, height } = img;
  const U = resolved.upscale;
  const alphaMode = resolveAlphaMode(info, resolved.alphaMode);
  const bg = resolveBackground(img, resolved.background, info);

  const compositeBg = bg ?? info.borderColor ?? WHITE;
  let source: GrayImage;
  let mask: BinaryMask;
  if (alphaMode === 'mask') {
    source = alphaToGray(img);
    const blurred = upscaleAndBlur(source, U, resolved.sigmaPx);
    const t = clamp(0.5 + resolved.thresholdOffset, 0.02, 0.98);
    // binarize ink = gray < t; the alpha polarity is the opposite (ink = alpha >= t).
    mask = binarize(blurred, t, !resolved.invert);
  } else {
    source = toGray(compositeOnColor(img, compositeBg));
    const blurred = upscaleAndBlur(source, U, resolved.sigmaPx);
    const t = resolveThreshold(source, resolved.thresholdOffset, resolved.invert);
    mask = binarize(blurred, t, resolved.invert);
  }

  // 'auto' fill. mask: the ink IS the opaque pixels, so it is their most common colour
  // (info.dominantInk skips colours within 48 of the composite background, white for a transparent
  // image: a white logo on transparent came out black). composite: the dominant colour away from it.
  const fill =
    resolved.fill !== 'auto' ? resolved.fill : toHex(alphaMode === 'mask' ? dominantInkColor(img, null) : info.dominantInk);
  const warnings = baseWarnings(resolved, width, height);
  if (info.thinStrokeRatio > THIN_STROKE_RATIO) warnings.push(thinStrokesWarning(info));
  if (countInk(mask) === 0) {
    if (alphaMode === 'composite' && !isAlphaUniform(img)) {
      // The shape is in the transparency: composited it can vanish into the paper, the alpha mask traces it.
      warnings.push(emptyTraceWarning('transparency'));
    } else {
      const luma = alphaMode === 'mask' ? toGray(compositeOnColor(img, compositeBg)) : source;
      if (!isUniform(luma) || !isAlphaUniform(img)) warnings.push(emptyTraceWarning('threshold'));
    }
  }

  return { U, width, height, layers: [{ mask, fill }], warnings };
}

// ---------------------------------------------------------------------------------------------
// flat
// ---------------------------------------------------------------------------------------------

/** rgb *= alpha/255 (rounded); alpha untouched. */
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
 * upscaleRaster U + gaussianBlurRaster sigmaPx. With `transparent` the RGB of transparent
 * pixels is meaningless, so the filters run on premultiplied colour (otherwise the bicubic taps
 * would smear that garbage into the opaque edge and mislabel it).
 */
function resampleRaster(img: RasterImage, U: number, sigmaPx: number, transparent: boolean): RasterImage {
  const blur = sigmaPx > 0;
  if (!transparent || (U <= 1 && !blur)) {
    const up = upscaleRaster(img, U);
    return blur ? gaussianBlurRaster(up, sigmaPx) : up;
  }
  const up = upscaleRaster(premultiply(img), U);
  return unpremultiply(blur ? gaussianBlurRaster(up, sigmaPx) : up);
}

/**
 * One layer per palette colour, back to front (largest area first). The palette is built on
 * the ORIGINAL composited image; labels are assigned on the upscaled + blurred image. Colours
 * that no pixel maps to produce no layer. With a transparent background (resolveBackground
 * null) pixels with alpha < 128 belong to NO layer: they are excluded from the area ordering
 * and from every mask, so the SVG keeps the transparency, and no full-canvas background layer
 * is emitted — the first layer is real ink.
 */
export function prepareFlat(img: RasterImage, resolved: ResolvedParams, info: SourceInfo): Prepared {
  assertImage(img, 'prepareFlat');
  const { width, height } = img;
  const U = resolved.upscale;
  const bg = resolveBackground(img, resolved.background, info);
  const transparent = bg === null;
  const base = transparent ? img : compositeOnColor(img, bg);
  const warnings = baseWarnings(resolved, width, height);

  const palette = buildPalette(base, resolved.colors, resolved.exactPalette);
  const count = palette.length;
  if (count === 0) return { U, width, height, layers: [], warnings }; // no opaque pixel at all

  const up = resampleRaster(base, U, resolved.sigmaPx, transparent);
  const labels = assignLabels(up, palette);
  if (transparent) {
    // Sentinel label `count`: ignored by layerOrder (only labels < count have an area) and
    // ranked 0 by the stack helpers, i.e. present only in the all-ones masks[0].
    const d = up.data;
    const l = labels.data;
    for (let i = 0, p = 3; i < l.length; i++, p += 4) if (d[p] < 128) l[i] = count;
  }
  const order = layerOrder(labels);
  const masks = resolved.layering === 'cutout' ? cutoutMasks(labels, order) : nestedMasks(labels, order);
  if (transparent) {
    const opaque = maskFromAlpha(up, 0.5);
    for (let j = 0; j < masks.length; j++) intersectInto(masks[j], opaque);
  }

  // Pixels per rank: a rank without pixels adds nothing (nested: masks[j] === masks[j+1]).
  const rankOf = new Int32Array(count).fill(-1);
  for (let j = 0; j < order.length; j++) rankOf[order[j]] = j;
  const area = new Float64Array(order.length);
  const l = labels.data;
  for (let i = 0; i < l.length; i++) {
    const lab = l[i];
    if (lab < count) area[rankOf[lab]]++;
  }

  const layers: PreparedLayer[] = [];
  for (let j = 0; j < order.length; j++) {
    if (area[j] === 0) continue;
    layers.push({ mask: masks[j], fill: toHex(palette[order[j]]) });
  }

  return { U, width, height, layers, warnings };
}

// ---------------------------------------------------------------------------------------------
// gradient
// ---------------------------------------------------------------------------------------------

/** Segmentation and model fitting run on a box-downscaled proxy of at most this many pixels. */
export const GRADIENT_PROXY_AREA = 4e6;
/** Above this share of edge pixels (Segmentation.edgeShare) the image is not flat art: flat fallback. */
export const GRADIENT_MAX_EDGE_SHARE = 0.6;
/** At most this many rounds of planMerges -> mergeRegions -> re-fit; a round without pairs ends them. */
export const GRADIENT_MERGE_ROUNDS = 3;
/**
 * Deep band of a region: its opaque pixels (alpha >= CORE_MIN_ALPHA) whose Chebyshev neighbourhood of radius
 * GRADIENT_FIT_DEPTH (clipped to the image) holds that region only, core or edge. On a steep smooth ramp the Sobel
 * hysteresis floods the region from its outline and leaves a core that no longer spans the ramp (radialDisc(128):
 * 1976 core pixels of 7256, fitted radius 24.9 px of 48).
 */
export const GRADIENT_FIT_DEPTH = 1;
/** A region whose core pixels are fewer than this share of its core ∪ deep band is fitted again on that union. */
export const GRADIENT_FIT_MIN_CORE_SHARE = 0.5;
/**
 * The union fit replaces the core fit only when it is not complex while the core fit was not, and its RMSE on the
 * core pixels exceeds the core fit's by at most this many levels (the core stays the trusted sample).
 */
export const GRADIENT_FIT_CORE_TOLERANCE = 0.5;
/**
 * Above this share of the labelled area in complex regions (no solid, linear or radial model explains them) the image is
 * not flat art either: flat fallback. noisePhoto(64) was caught by the edge share only while the Sobel hysteresis
 * flooded smooth ramps; once gated, it is 44 % edge and 91 % complex (see "Decisiones de implementación").
 */
export const GRADIENT_MAX_COMPLEX_SHARE = 0.5;

/** Proxy factor of gradient mode: f = ceil(sqrt(W·H / GRADIENT_PROXY_AREA)), at least 1. */
export function gradientProxyFactor(width: number, height: number): number {
  return Math.max(1, Math.ceil(Math.sqrt((width * height) / GRADIENT_PROXY_AREA)));
}

/**
 * The part of gradient mode that does not depend on the upscale, the blur or the layering (the tuner memoises
 * it per image): either why the image falls back to the flat palette, or its merged regions and their models.
 */
export type GradientFit =
  | { kind: 'fallback'; /** Spanish, lower-case start, no final period (gradientFallbackWarning). */ reason: string }
  | {
      kind: 'regions';
      /** What the layers are resampled from: the source composited on the resolved background, or the source itself when that is transparent. */
      base: RasterImage;
      transparent: boolean;
      /** Proxy factor: seg and every model are in units of the proxy (1 proxy px = f px of base). */
      f: number;
      /** immerkaerSigma of the proxy (levels). */
      sigma: number;
      /** Segmentation of the proxy after the merges; its core is the fit core (core pixels and deep band). */
      seg: Segmentation;
      /** models[k] = the model of region k of seg. */
      models: RegionModel[];
      /** Regions segmentRegions gave before merging. */
      rawRegions: number;
      /** Merge rounds that found pairs (0..GRADIENT_MERGE_ROUNDS). */
      mergeRounds: number;
    };

/** Deep band of every region of `seg` (see GRADIENT_FIT_DEPTH), core pixels included: 1 = in the band. */
function deepBand(seg: Segmentation, img: RasterImage, depth: number): Uint8Array {
  const { width: w, height: h, data: lab } = seg.regions;
  const n = w * h;
  const src = img.data;
  const cap = depth + 1;
  // hor[i]: the run of equal labels through i reaches `depth` px (or the image edge) on both sides.
  const hor = new Uint8Array(n);
  const left = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      left[x] = x > 0 && lab[i - 1] === lab[i] ? Math.min(cap, left[x - 1] + 1) : 1;
    }
    let right = 1;
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x;
      right = x < w - 1 && lab[i + 1] === lab[i] ? Math.min(cap, right + 1) : 1;
      if (lab[i] >= 0 && left[x] - 1 >= Math.min(depth, x) && right - 1 >= Math.min(depth, w - 1 - x)) hor[i] = 1;
    }
  }
  // The same along the columns, over rows whose run qualifies with the same label.
  const up = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (hor[i] === 0) continue;
      up[i] = y > 0 && hor[i - w] !== 0 && lab[i - w] === lab[i] ? Math.min(cap, up[i - w] + 1) : 1;
    }
  }
  const band = new Uint8Array(n);
  const down = new Uint8Array(w);
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (hor[i] === 0) {
        down[x] = 0;
        continue;
      }
      down[x] = y < h - 1 && hor[i + w] !== 0 && lab[i + w] === lab[i] ? Math.min(cap, down[x] + 1) : 1;
      if (up[i] - 1 >= Math.min(depth, y) && down[x] - 1 >= Math.min(depth, h - 1 - y) && src[i * 4 + 3] >= CORE_MIN_ALPHA) {
        band[i] = 1;
      }
    }
  }
  return band;
}

interface FittedRegions {
  /** `seg` with core = the fit core: the core, plus the deep band of every region fitted on it. */
  fitSeg: Segmentation;
  px: RegionPixels;
  models: RegionModel[];
  /** deep[k] = 1: region k was fitted on its core ∪ deep band. */
  deep: Uint8Array;
}

/**
 * One model per region of `seg` (core = the segmentation's core). known[k] (a region unchanged since the previous
 * fit) is kept as it is; every other region gets selectModel on its core pixels and, when those are fewer than
 * GRADIENT_FIT_MIN_CORE_SHARE of its core ∪ deep band, selectModel on that union, which wins under
 * GRADIENT_FIT_CORE_TOLERANCE (see there).
 */
function fitRegionModels(
  proxy: RasterImage,
  seg: Segmentation,
  opts: { sigma: number; maxStops: number; radial: boolean },
  known: ReadonlyArray<{ model: RegionModel; deep: number } | null>,
): FittedRegions {
  const count = seg.regions.count;
  const reg = seg.regions.data;
  const core = seg.core.data;
  const band = deepBand(seg, proxy, GRADIENT_FIT_DEPTH);
  const models: RegionModel[] = new Array<RegionModel>(count);
  const deep = new Uint8Array(count);
  const todo: number[] = [];
  for (let k = 0; k < count; k++) {
    const kn = known[k];
    if (kn === null || kn === undefined) {
      todo.push(k);
    } else {
      models[k] = kn.model;
      deep[k] = kn.deep;
    }
  }
  if (todo.length > 0) {
    const corePx = corePixels(seg);
    const moments = accumulateMoments(proxy, seg);
    const unionCount = new Float64Array(count);
    for (let i = 0; i < reg.length; i++) if (reg[i] >= 0 && (core[i] !== 0 || band[i] !== 0)) unionCount[reg[i]]++;
    const candidate = new Uint8Array(count);
    let candidates = 0;
    for (const k of todo) {
      models[k] = selectModel(proxy, corePx, k, moments, opts);
      if (corePx.offsets[k + 1] - corePx.offsets[k] < GRADIENT_FIT_MIN_CORE_SHARE * unionCount[k]) {
        candidate[k] = 1;
        candidates++;
      }
    }
    if (candidates > 0) {
      const trial = Uint8Array.from(core);
      for (let i = 0; i < reg.length; i++) if (band[i] !== 0 && reg[i] >= 0 && candidate[reg[i]] !== 0) trial[i] = 1;
      const trialSeg: Segmentation = { ...seg, core: { data: trial, width: seg.core.width, height: seg.core.height } };
      const trialPx = corePixels(trialSeg);
      const trialMoments = accumulateMoments(proxy, trialSeg);
      for (const k of todo) {
        if (candidate[k] === 0) continue;
        const onCore = models[k];
        const onUnion = selectModel(proxy, trialPx, k, trialMoments, opts);
        if ((!onUnion.complex || onCore.complex) && rmseOf(proxy, corePx, k, onUnion.fill) <= onCore.rmse + GRADIENT_FIT_CORE_TOLERANCE) {
          models[k] = onUnion;
          deep[k] = 1;
        }
      }
    }
  }
  let fitCore = seg.core;
  if (deep.some((v) => v !== 0)) {
    const data = Uint8Array.from(core);
    for (let i = 0; i < reg.length; i++) if (band[i] !== 0 && reg[i] >= 0 && deep[reg[i]] !== 0) data[i] = 1;
    fitCore = { data, width: seg.core.width, height: seg.core.height };
  }
  const fitSeg: Segmentation = { ...seg, core: fitCore };
  return { fitSeg, px: corePixels(fitSeg), models, deep };
}

/**
 * Segments and fits gradient mode on `img` (the traced source): background as flat (resolveBackground; transparent
 * -> not composited) -> proxy (downscaleBoxRaster by gradientProxyFactor, on premultiplied colour when transparent)
 * -> sigma = immerkaerSigma(proxy) -> segmentEdges; fallback when edgeShare > GRADIENT_MAX_EDGE_SHARE, before any
 * labelling -> segmentRegions(proxy, { regionDetail, sigma, edges }); fallback with more than MAX_GRADIENT_REGIONS
 * regions. Otherwise selectModel per region (maxStops,
 * radial = radialGradients) on its core, or on its core ∪ deep band when the core no longer spans it
 * (GRADIENT_FIT_MIN_CORE_SHARE), and up to GRADIENT_MERGE_ROUNDS rounds of planMerges -> mergeRegions, re-fitting
 * every region made of more than one old region (the others keep their model). splitComplex does not exist yet: a
 * complex region keeps the lowest-RMSE candidate selectModel returns; above GRADIENT_MAX_COMPLEX_SHARE of the labelled
 * area in complex regions, fallback. Last, every gradient is extended over its region's deep band (extendModels).
 */
export function fitGradientRegions(img: RasterImage, resolved: ResolvedParams, info: SourceInfo): GradientFit {
  assertImage(img, 'fitGradientRegions');
  const bg = resolveBackground(img, resolved.background, info);
  const transparent = bg === null;
  const base = transparent ? img : compositeOnColor(img, bg);
  const f = gradientProxyFactor(img.width, img.height);
  const proxy =
    f === 1 ? base : transparent ? unpremultiply(downscaleBoxRaster(premultiply(base), f)) : downscaleBoxRaster(base, f);
  const sigma = immerkaerSigma(proxy);
  // The edge share is known before any labelling: an image that falls back on it is not segmented further.
  const edges = segmentEdges(proxy, { regionDetail: resolved.regionDetail, sigma });
  if (edges.edgeShare > GRADIENT_MAX_EDGE_SHARE) {
    return { kind: 'fallback', reason: `el ${pct(edges.edgeShare)} % de la imagen es borde` };
  }
  let seg = segmentRegions(proxy, { regionDetail: resolved.regionDetail, sigma, edges });
  const rawRegions = seg.regions.count;
  if (rawRegions > MAX_GRADIENT_REGIONS) {
    return {
      kind: 'fallback',
      reason: `la imagen se divide en ${formatCount(rawRegions)} regiones (el límite es ${formatCount(MAX_GRADIENT_REGIONS)})`,
    };
  }

  const fitOpts = { sigma, maxStops: resolved.maxStops, radial: resolved.radialGradients };
  let fitted = fitRegionModels(proxy, seg, fitOpts, new Array<null>(seg.regions.count).fill(null));
  // Complex regions do not become explained by merging: over the limit already, fall back without the merge rounds.
  const early = complexFallback(seg.area, fitted.models);
  if (early !== null) return early;
  let mergeRounds = 0;
  for (let round = 0; round < GRADIENT_MERGE_ROUNDS; round++) {
    const pairs = planMerges(proxy, fitted.fitSeg, fitted.models, {
      sigma,
      pixels: fitted.px,
      maxStops: resolved.maxStops,
      radial: resolved.radialGradients,
    });
    if (pairs.length === 0) break;
    mergeRounds++;
    const { seg: merged, remap } = mergeRegions(seg, pairs);
    const members = new Int32Array(merged.regions.count);
    const member = new Int32Array(merged.regions.count);
    for (let old = 0; old < remap.length; old++) {
      members[remap[old]]++;
      member[remap[old]] = old;
    }
    const known: Array<{ model: RegionModel; deep: number } | null> = [];
    for (let k = 0; k < merged.regions.count; k++) {
      known.push(members[k] === 1 ? { model: fitted.models[member[k]], deep: fitted.deep[member[k]] } : null);
    }
    seg = merged;
    fitted = fitRegionModels(proxy, seg, fitOpts, known);
  }
  const models = fitted.models;
  seg = fitted.fitSeg;
  const late = complexFallback(seg.area, models);
  if (late !== null) return late;
  extendModels(proxy, seg, models, fitted.px);
  return { kind: 'regions', base, transparent, f, sigma, seg, models, rawRegions, mergeRounds };
}

/** The complex-share fallback: above GRADIENT_MAX_COMPLEX_SHARE of the labelled area in complex regions, null otherwise. */
function complexFallback(area: Float64Array, models: readonly RegionModel[]): GradientFit | null {
  let labelled = 0;
  let complexArea = 0;
  for (let k = 0; k < models.length; k++) {
    labelled += area[k];
    if (models[k].complex) complexArea += area[k];
  }
  if (!(labelled > 0) || complexArea / labelled <= GRADIENT_MAX_COMPLEX_SHARE) return null;
  return { kind: 'fallback', reason: `el ${pct(complexArea / labelled)} % de la imagen no se explica con colores planos ni degradados` };
}

/**
 * In place on `models`: every gradient is extended over the deep band of its region (GRADIENT_FIT_DEPTH) with
 * extendGradient, so its stop range reaches the outline instead of ending where the core ends; rmse is recomputed on
 * the fit core.
 */
function extendModels(proxy: RasterImage, seg: Segmentation, models: RegionModel[], px: RegionPixels): void {
  const count = models.length;
  if (!models.some((m) => m.fill.kind !== 'solid')) return;
  const band = deepBand(seg, proxy, GRADIENT_FIT_DEPTH);
  const reg = seg.regions.data;
  const offsets = new Int32Array(count + 1);
  for (let i = 0; i < reg.length; i++) if (band[i] !== 0 && reg[i] >= 0 && models[reg[i]].fill.kind !== 'solid') offsets[reg[i] + 1]++;
  for (let k = 0; k < count; k++) offsets[k + 1] += offsets[k];
  const cursor = offsets.slice(0, count);
  const indices = new Int32Array(offsets[count]);
  for (let i = 0; i < reg.length; i++) {
    if (band[i] !== 0 && reg[i] >= 0 && models[reg[i]].fill.kind !== 'solid') indices[cursor[reg[i]]++] = i;
  }
  for (let k = 0; k < count; k++) {
    const fill = models[k].fill;
    if (fill.kind === 'solid') continue;
    const extended = extendGradient(proxy, fill, indices.subarray(offsets[k], offsets[k + 1]));
    if (extended !== fill) models[k] = { ...models[k], fill: extended, rmse: rmseOf(proxy, px, k, extended) };
  }
}

/**
 * Gradient mode ('Degradados'): one layer per region, each painted with a solid, linear or radial fill
 * (contract in ARCHITECTURE.md, "src/core/pipeline.ts"). `fit` defaults to fitGradientRegions(img, resolved, info).
 * Fallback: prepareFlat with a PHOTO_FALLBACK_COLORS-colour median-cut palette (exactPalette false; the resolved
 * layering) plus gradientFallbackWarning(reason). Otherwise: up = resampleRaster(base, U, sigmaPx, transparent) ->
 * refineLabels(seg, fills in proxy units, up, U·f) -> regionOrder -> rankMap, and in that order one layer per region
 * with Ux pixels: mask () => regionMask(ranks, W·U, H·U, j, layering, cutout ? ceil(U/2) : 0) (built on every read);
 * fill = the hex of the solid colour or of the gradient's mean colour; gradient = scaleGradient(g, U·f). A pixel of
 * up with alpha < 128 has no region (refineLabels), and regionMask never paints such a pixel, so every mask is
 * already inside the alpha mask of up. A full mask (stacked layer 0 over an opaque background) becomes the canvas
 * rectangle in traceLayers.
 */
export function prepareGradient(
  img: RasterImage,
  resolved: ResolvedParams,
  info: SourceInfo,
  fit: GradientFit = fitGradientRegions(img, resolved, info),
): Prepared {
  assertImage(img, 'prepareGradient');
  const { width, height } = img;
  if (fit.kind === 'fallback') {
    const flat = prepareFlat(img, { ...resolved, mode: 'flat', colors: PHOTO_FALLBACK_COLORS, exactPalette: false }, info);
    return { ...flat, warnings: [...flat.warnings, gradientFallbackWarning(fit.reason)] };
  }
  const U = resolved.upscale;
  const warnings = baseWarnings(resolved, width, height);
  const { seg, models, f } = fit;
  const up = resampleRaster(fit.base, U, resolved.sigmaPx, fit.transparent);
  const WU = up.width;
  const HU = up.height;
  const fills = models.map((m) => m.fill);
  let ranks = refineLabels(seg, fills, up, U * f);
  if (f > 1 && refitThinFills(seg, fills, ranks, up)) ranks = refineLabels(seg, fills, up, U * f);
  const order = regionOrder(seg);
  rankMap(ranks, order);
  const pixels = new Float64Array(order.length);
  for (let i = 0; i < ranks.length; i++) {
    const r = ranks[i];
    if (r !== NO_REGION) pixels[r]++;
  }

  const layering = resolved.layering;
  const dilate = layering === 'cutout' ? Math.ceil(U / 2) : 0;
  const layers: PreparedLayer[] = [];
  for (let j = 0; j < order.length; j++) {
    if (pixels[j] === 0) continue;
    const fill = fills[order[j]];
    const layer: PreparedLayer = {
      mask: () => regionMask(ranks, WU, HU, j, layering, dilate),
      fill: fill.kind === 'solid' ? rgbToHex(fill.color) : gradientMeanHex(fill),
    };
    if (fill.kind !== 'solid' && !isDegenerateGradient(fill)) layer.gradient = scaleGradient(fill, U * f);
    layers.push(layer);
  }
  return { U, width, height, layers, warnings };
}

/**
 * On a proxy (f > 1) a region with no pixel whose 3×3 (in the image) is all its own is a stroke at most 2 px wide there,
 * averaged with its surroundings by the box downscale (the 1-px black frame of pajaro fitted as #7f7f7f..#a9a9a9). In
 * place on `fills`: each such region gets the mean colour, solid, of the pixels of `up` that `labels` (refineLabels,
 * before rankMap) gave it, i.e. of the full-resolution pixels closer to it than to its neighbours. Returns whether
 * any fill changed (the caller labels `up` again with the new colours).
 */
function refitThinFills(seg: Segmentation, fills: Fill[], labels: Uint16Array, up: RasterImage): boolean {
  const { width: w, height: h, data: lab, count } = seg.regions;
  const interior = new Uint8Array(count);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = lab[y * w + x];
      if (k < 0 || interior[k] !== 0) continue;
      let all = true;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1) && all; yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          if (lab[yy * w + xx] !== k) {
            all = false;
            break;
          }
        }
      }
      if (all) interior[k] = 1;
    }
  }
  if (interior.every((v) => v !== 0)) return false;
  const sums = new Float64Array(count * 4);
  const d = up.data;
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i];
    if (k === NO_REGION || interior[k] !== 0) continue;
    const o = i * 4;
    sums[k * 4] += d[o];
    sums[k * 4 + 1] += d[o + 1];
    sums[k * 4 + 2] += d[o + 2];
    sums[k * 4 + 3]++;
  }
  let changed = false;
  for (let k = 0; k < count; k++) {
    const n = sums[k * 4 + 3];
    if (interior[k] !== 0 || n === 0) continue;
    fills[k] = { kind: 'solid', color: [sums[k * 4] / n, sums[k * 4 + 1] / n, sums[k * 4 + 2] / n] };
    changed = true;
  }
  return changed;
}

/** The preparation of `resolved.mode`: lines, flat or gradient layers (pixel mode has none and throws). */
export function prepareForMode(img: RasterImage, resolved: ResolvedParams, info: SourceInfo): Prepared {
  switch (resolved.mode) {
    case 'lines':
      return prepareLines(img, resolved, info);
    case 'flat':
      return prepareFlat(img, resolved, info);
    case 'gradient':
      return prepareGradient(img, resolved, info);
    case 'pixel':
      throw new Error('pipeline: el modo píxel no prepara capas');
  }
}

// ---------------------------------------------------------------------------------------------
// pixel
// ---------------------------------------------------------------------------------------------

/**
 * Stats of a pixel-mode SVG without re-parsing it: every rect is one closed subpath
 * `m dx dy h w v h h -w z`, i.e. 3 line segments = 3 nodes (same definition as pathStats).
 */
function pixelStats(svg: string, rectCount: number): PathStats {
  let pathCount = 0;
  const re = /<path\b/g;
  while (re.exec(svg) !== null) pathCount++;
  const nodeCount = rectCount * 3;
  return {
    pathCount,
    subpathCount: rectCount,
    nodeCount,
    lineCount: nodeCount,
    curveCount: 0,
    cornerFraction: rectCount > 0 ? 1 : 0,
    bytes: utf8ByteLength(svg),
  };
}

const EMPTY_STATS: Readonly<PathStats> = {
  pathCount: 0,
  subpathCount: 0,
  nodeCount: 0,
  lineCount: 0,
  curveCount: 0,
  cornerFraction: 0,
  bytes: 0,
};

/**
 * Pixel mode. The SVG always has the source width and height: with a gridScale that does not divide
 * the image the partial blocks of the last column / row are kept, clipped to the image, and the
 * viewBox is in source pixels (an exact grid keeps one viewBox unit per block). The merged
 * rectangles are counted before serialising: above MAX_PIXEL_RECTS no SVG is built at all (svg '',
 * empty stats) and 'too-many-rects' explains why and points to Color plano; above TOO_MANY_RECTS the
 * SVG is built with the same warning code as a heads-up.
 */
function tracePixel(img: RasterImage, resolved: ResolvedParams): { svg: string; stats: PathStats; warnings: Warning[] } {
  const k = resolved.gridScale === 'auto' ? detectGrid(img) : Math.max(1, Math.floor(resolved.gridScale));
  const logical = k > 1 ? downscaleNearest(img, k) : img;
  const { svg, rectCount } = pixelSvg(logical, k, MAX_PIXEL_RECTS, { width: img.width, height: img.height });
  if (rectCount > MAX_PIXEL_RECTS) {
    return { svg: '', stats: { ...EMPTY_STATS }, warnings: [pixelRectCapWarning(rectCount)] };
  }
  const warnings: Warning[] = [];
  if (rectCount > TOO_MANY_RECTS) warnings.push(tooManyRectsWarning(rectCount));
  return { svg, stats: pixelStats(svg, rectCount), warnings };
}

// ---------------------------------------------------------------------------------------------
// trace
// ---------------------------------------------------------------------------------------------

/** Copies only the defined entries of `over` on top of `base` (spread would copy undefined). */
function mergeParams(base: TraceParams, over: TraceParams): TraceParams {
  const out: TraceParams = { ...base };
  const src = over as Record<string, unknown>;
  const dst = out as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (src[key] !== undefined) dst[key] = src[key];
  }
  return out;
}

function pickTracer(
  tracers: Record<Engine, Tracer>,
  wanted: Engine,
): { tracer: Tracer; engine: Engine; warning: Warning | null } {
  const direct = tracers[wanted] as Tracer | undefined;
  if (direct !== undefined) return { tracer: direct, engine: wanted, warning: null };
  const fallbacks: Engine[] = ['potrace', 'vtracer'];
  for (const engine of fallbacks) {
    const t = tracers[engine] as Tracer | undefined;
    if (t !== undefined) return { tracer: t, engine, warning: engineUnavailableWarning(wanted, engine) };
  }
  throw new Error('pipeline: no hay ningún motor de trazado disponible');
}

function tracerOptions(resolved: ResolvedParams): TracerOptions {
  const U = resolved.upscale;
  return {
    alphamax: resolved.alphamax,
    opttolerance: resolved.opttolerance,
    turdsize: resolved.turdsizeScaled,
    turnpolicy: resolved.turnpolicy,
    opticurve: resolved.opticurve,
    // vtracer-web's filterSpeckle is an AREA threshold (px²) in the mask's resolution: scale
    // it by U² like turdsize so the user value keeps meaning "original px²".
    vtracer: { ...resolved.vtracer, filterSpeckle: resolved.vtracer.filterSpeckle * U * U },
  };
}

/**
 * Traces the prepared layers back to front: one Layer per PreparedLayer whose trace is not empty. A
 * full-canvas mask becomes rectPath(W·U, H·U) without tracing; opacity (< 1) and gradient are copied.
 * Lazy masks are built one at a time. Shared by trace() and the tuner, so both emit the same layers.
 */
export async function traceLayers(prepared: Prepared, tracer: Tracer, opts: TracerOptions): Promise<Layer[]> {
  const vw = prepared.width * prepared.U;
  const vh = prepared.height * prepared.U;
  const layers: Layer[] = [];
  for (let i = 0; i < prepared.layers.length; i++) {
    const pl = prepared.layers[i];
    const mask = layerMask(pl);
    const paths: AbsPath[] = isFullMask(mask) ? [rectPath(vw, vh)] : await tracer.traceBinary(mask, opts);
    if (paths.length === 0) continue;
    const layer: Layer = { fill: pl.fill, paths };
    if (pl.opacity !== undefined && pl.opacity < 1) layer.opacity = pl.opacity;
    if (pl.gradient !== undefined) layer.gradient = pl.gradient;
    layers.push(layer);
  }
  return layers;
}

/**
 * The image and the analysis trace() works on for `params`, given `info` = analyzeSource(img)
 * (default 'auto'): with bakedBackground 'auto' the effective source (a detected checkerboard made
 * transparent, see effectiveSource) and `info` itself; with 'keep' the original pixels and, when
 * `info` had applied a checkerboard, a fresh analyzeSource(img, 'keep').
 */
export function traceInput(
  img: RasterImage,
  info: SourceInfo,
  params: Pick<TraceParams, 'bakedBackground'>,
): { image: RasterImage; info: SourceInfo } {
  if ((info.bakedBackground ?? null) === null) return { image: img, info };
  if (params.bakedBackground === 'keep') return { image: img, info: analyzeSource(img, 'keep') };
  return { image: effectiveSource(img, info, params), info };
}

/**
 * Full pipeline. `info` is computed with analyzeSource when not given and only when needed (an
 * explicit pixel mode never needs it); mode 'auto' (or absent) is decided by classify(info),
 * whose suggested params fill the gaps left by `params`. A non-blank image whose trace ends
 * without any layer gets the 'empty-trace' warning.
 * Fake transparency: `info` = analyzeSource(img) describes the effective source when it found a
 * checkerboard painted into the pixels. With bakedBackground 'auto' (default) lines/flat trace that
 * effective source (no background layer) and the 'baked-checkerboard' warning comes first; with
 * 'keep' such an `info` is replaced by analyzeSource(img, 'keep') and the pixels are traced as they
 * are. An explicit pixel mode without `info` only runs the checkerboard detection.
 */
export async function trace(
  img: RasterImage,
  params: TraceParams,
  tracers: Record<Engine, Tracer>,
  info?: SourceInfo,
): Promise<TraceResult> {
  const t0 = performance.now();
  assertImage(img, 'trace');
  const { width, height } = img;
  const keep = params.bakedBackground === 'keep';
  // An analysis that applied a checkerboard describes the effective source, not the kept pixels.
  let src: SourceInfo | undefined = info !== undefined && keep && (info.bakedBackground ?? null) !== null ? undefined : info;
  const sourceInfo = (): SourceInfo => {
    if (src === undefined) src = analyzeSource(img, keep ? 'keep' : 'auto');
    return src;
  };

  const warnings: Warning[] = [];
  let effective = params;
  let modeIfAuto: ConcreteMode | undefined;
  if (params.mode === undefined || params.mode === 'auto') {
    const cls = classify(sourceInfo());
    effective = mergeParams(cls.params, params);
    modeIfAuto = cls.mode;
    warnings.push(...cls.warnings);
  }
  let resolved = resolveParams(effective, { width, height }, modeIfAuto);

  let svg: string;
  let stats: PathStats;
  let baked: BakedCheckerboard | null;
  if (resolved.mode === 'pixel') {
    baked = src !== undefined ? (src.bakedBackground ?? null) : keep ? null : detectBakedCheckerboard(img);
    const r = tracePixel(baked === null ? img : applyBakedBackground(img, baked), resolved);
    svg = r.svg;
    stats = r.stats;
    warnings.push(...r.warnings);
  } else {
    const picked = pickTracer(tracers, resolved.engine);
    if (picked.warning !== null) {
      warnings.push(picked.warning);
      resolved = { ...resolved, engine: picked.engine };
    }
    const si = sourceInfo();
    baked = si.bakedBackground ?? null;
    const source = effectiveSource(img, si, resolved);
    const prepared = prepareForMode(source, resolved, si);
    const layers = await traceLayers(prepared, picked.tracer, tracerOptions(resolved));
    svg = assembleSvg(layers, {
      width: prepared.width,
      height: prepared.height,
      viewBoxWidth: prepared.width * prepared.U,
      viewBoxHeight: prepared.height * prepared.U,
    });
    stats = pathStats(layers, utf8ByteLength(svg));
    // Prepared warnings after the classifier's so duplicates (thin-strokes) collapse below.
    for (const w of prepared.warnings) if (!warnings.some((x) => x.code === w.code)) warnings.push(w);
    // The masks had ink but the tracer dropped all of it (speckle filter larger than the shapes).
    if (
      layers.length === 0 &&
      !warnings.some((x) => x.code === 'empty-trace') &&
      prepared.layers.some((l) => countInk(layerMask(l)) > 0)
    ) {
      warnings.push(emptyTraceWarning('tracer'));
    }
  }
  if (baked !== null) warnings.unshift(bakedCheckerboardWarning(baked));

  return { svg, stats, resolved, warnings, ms: performance.now() - t0 };
}
