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
 *        one solid / linear / radial model per region, merged regions re-fitted, a region no single fill explains
 *        split into parts that become regions of their own -> resampleRaster U ->
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
  RegionMap,
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
import {
  CORE_MIN_ALPHA,
  MAX_GRADIENT_REGIONS,
  NO_REGION,
  mergeRegions,
  rankMap,
  refineLabels,
  regionAdjacency,
  regionMask,
  regionOrder,
  segmentEdges,
  segmentRegions,
} from './regions';
import {
  MIN_MODEL_CORE,
  SPLIT_MAX_DEPTH,
  accumulateMoments,
  corePixels,
  extendGradient,
  planMerges,
  rmseOf,
  selectModel,
  splitComplex,
  type RegionPixels,
} from './fillModel';
import { evaluateFill, isDegenerateGradient, scaleGradient } from './fillEval';
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
/**
 * Majority-smoothing passes over the part labels of a split region (splitComplexRegions). The k-means boundary and the
 * per-pixel decision of the band are ragged, and the tracer pays for every wiggle of an outline.
 */
export const GRADIENT_SPLIT_SMOOTH_PASSES = 4;
/**
 * Smallest 4-connected piece of a part the split may leave behind (proxy px, absorbIslands): a piece under
 * MIN_MODEL_CORE could never carry a model of its own, so it cannot justify a traced subpath of its own either.
 * Measured: the islands the belly of pajaro left are 25, 19, 16, 8, 8, 7, 2 and 7 proxy px against parts of 5562, 5895
 * and 10307, and the smallest parts the split produces anywhere measured (the shadingGrid fixture) are 169-186 px, so 64
 * separates them with room on both sides while 128 would start absorbing that fixture's parts.
 */
export const GRADIENT_SPLIT_MIN_ISLAND = MIN_MODEL_CORE;
/**
 * Budget of the split: it may add at most max(2^SPLIT_MAX_DEPTH - 1, ceil(share · regions)) regions to the image, so one
 * region can always be split to the full depth, and an image made of many 2-D shadings cannot multiply its region count
 * (and with it its masks, potrace calls, <linearGradient> elements, nodes and bytes) by up to 2^SPLIT_MAX_DEPTH. The
 * largest complex regions go first, which is where the error is. Measured on the shadingGrid fixture ("Decisiones de
 * implementación").
 */
export const GRADIENT_SPLIT_MAX_NEW_SHARE = 0.25;

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
      /** Complex regions splitComplex broke into parts (0 when none was, or none was worth it). */
      splitRegions: number;
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

export interface FittedRegions {
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
 * Majority smoothing of the part labels of the split regions, in place on `part` and only over the window
 * [wx0, wx1] × [wy0, wy1] (every pixel of every split region): GRADIENT_SPLIT_SMOOTH_PASSES passes, each moving a
 * pixel to the part that strictly most of its 8 neighbours INSIDE the same region belong to (a tie keeps the pixel
 * where it is), read from a snapshot of the previous pass so the outcome never depends on the scan order. The
 * k-means decides per pixel on a residual, and along the band so does the fill comparison, so both boundaries come
 * out ragged and the tracer pays a node for every wiggle. A region whose parts would be left with fewer than
 * MIN_MODEL_CORE fit-core pixels keeps its unsmoothed labels instead: every part must still earn a model of its own.
 * The vote alone does not tidy everything: a blob along the region's outline has few or no voters (only neighbours of
 * the same ORIGINAL region count) and survives every pass, which is what absorbIslands is for.
 *
 * `base` indexes the parts: region k owns the slots base[k] .. base[k+1], and base[k+1] === base[k] when it was not
 * split (then part[i] is 0 everywhere in it, i.e. the region itself).
 */
function smoothParts(
  lab: Int32Array,
  part: Int32Array,
  base: Int32Array,
  W: number,
  wx0: number,
  wy0: number,
  wx1: number,
  wy1: number,
  fitCore: Uint8Array,
): void {
  if (GRADIENT_SPLIT_SMOOTH_PASSES <= 0 || wx1 < wx0) return;
  const ww = wx1 - wx0 + 1;
  const wh = wy1 - wy0 + 1;
  const unsmoothed = new Int32Array(ww * wh);
  for (let y = wy0; y <= wy1; y++) {
    const row = y * W + wx0;
    unsmoothed.set(part.subarray(row, row + ww), (y - wy0) * ww);
  }
  const prev = new Int32Array(ww * wh);
  const counts = new Int32Array(256);
  for (let pass = 0; pass < GRADIENT_SPLIT_SMOOTH_PASSES; pass++) {
    for (let y = wy0; y <= wy1; y++) {
      const row = y * W + wx0;
      prev.set(part.subarray(row, row + ww), (y - wy0) * ww);
    }
    for (let y = wy0; y <= wy1; y++) {
      for (let x = wx0; x <= wx1; x++) {
        const i = y * W + x;
        const k = lab[i];
        if (k < 0) continue;
        const m = base[k + 1] - base[k];
        if (m === 0) continue;
        counts.fill(0, 0, m);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < wy0 || yy > wy1) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx === 0 && dy === 0) || xx < wx0 || xx > wx1) continue;
            if (lab[yy * W + xx] !== k) continue;
            counts[prev[(yy - wy0) * ww + (xx - wx0)]]++;
          }
        }
        const own = prev[(y - wy0) * ww + (x - wx0)];
        let best = 0;
        for (let p = 1; p < m; p++) if (counts[p] > counts[best]) best = p;
        if (counts[best] > counts[own]) part[i] = best;
      }
    }
  }
  const core = new Int32Array(base[base.length - 1]);
  for (let y = wy0; y <= wy1; y++) {
    for (let x = wx0; x <= wx1; x++) {
      const i = y * W + x;
      const k = lab[i];
      if (k < 0 || base[k + 1] === base[k] || fitCore[i] === 0) continue;
      core[base[k] + part[i]]++;
    }
  }
  const revert = new Uint8Array(base.length - 1);
  let any = false;
  for (let k = 0; k + 1 < base.length; k++) {
    for (let p = base[k]; p < base[k + 1]; p++) {
      if (core[p] >= MIN_MODEL_CORE) continue;
      revert[k] = 1;
      any = true;
    }
  }
  if (!any) return;
  for (let y = wy0; y <= wy1; y++) {
    for (let x = wx0; x <= wx1; x++) {
      const i = y * W + x;
      const k = lab[i];
      if (k >= 0 && revert[k] !== 0) part[i] = unsmoothed[(y - wy0) * ww + (x - wx0)];
    }
  }
}

/**
 * Connected-component cleanup of the part labels, in place on `part` over the same window: every 4-connected piece of a
 * part smaller than GRADIENT_SPLIT_MIN_ISLAND proxy px that touches a piece of at least that size of ANOTHER part of the
 * same region moves to the part of most of those neighbouring pixels (a tie goes to the lowest part index). The k-means
 * assigns a core pixel on a residual and the band pixel by pixel on its fill, so both leave islands, and the majority
 * vote of smoothParts cannot reach the ones along the region's outline (no voters there): the tracer then emits a
 * subpath per island, painted from a different part's gradient than its surroundings. Every island of the round is moved
 * at once (the vote only counts pieces that are NOT being moved, so two islands cannot swap parts), and the rounds
 * repeat while one moves: a move joins two pieces, so their number strictly drops and it ends. A piece with no bigger
 * neighbouring piece of another part is left alone: the region itself is disconnected there, which the segmentation
 * already allows and no relabelling inside the region can fix.
 */
function absorbIslands(
  lab: Int32Array,
  part: Int32Array,
  base: Int32Array,
  W: number,
  wx0: number,
  wy0: number,
  wx1: number,
  wy1: number,
): void {
  if (GRADIENT_SPLIT_MIN_ISLAND <= 1 || wx1 < wx0) return;
  const ww = wx1 - wx0 + 1;
  const wh = wy1 - wy0 + 1;
  const comp = new Int32Array(ww * wh);
  const stack: number[] = [];
  for (;;) {
    comp.fill(-1);
    const size: number[] = [];
    const first: number[] = [];
    for (let y = wy0; y <= wy1; y++) {
      for (let x = wx0; x <= wx1; x++) {
        const w0 = (y - wy0) * ww + (x - wx0);
        if (comp[w0] >= 0) continue;
        const i0 = y * W + x;
        const k = lab[i0];
        if (k < 0 || base[k + 1] === base[k]) continue;
        const p = part[i0];
        const id = size.length;
        size.push(0);
        first.push(i0);
        comp[w0] = id;
        stack.push(w0);
        while (stack.length > 0) {
          const q = stack.pop() as number;
          size[id]++;
          const qx = q % ww;
          const qy = (q - qx) / ww;
          const qi = (qy + wy0) * W + (qx + wx0);
          for (let s = 0; s < 4; s++) {
            const nx = qx + (s === 0 ? -1 : s === 1 ? 1 : 0);
            const ny = qy + (s === 2 ? -1 : s === 3 ? 1 : 0);
            if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
            const w2 = ny * ww + nx;
            if (comp[w2] >= 0) continue;
            const i2 = qi + (s === 0 ? -1 : s === 1 ? 1 : s === 2 ? -W : W);
            if (lab[i2] !== k || part[i2] !== p) continue;
            comp[w2] = id;
            stack.push(w2);
          }
        }
      }
    }
    // The islands of this round, smallest first (tie: its first pixel in raster order), and a tally per part for each.
    const slot = new Int32Array(size.length).fill(-1);
    const order: number[] = [];
    for (let id = 0; id < size.length; id++) {
      if (size[id] >= GRADIENT_SPLIT_MIN_ISLAND) continue;
      slot[id] = order.length;
      order.push(id);
    }
    if (order.length === 0) return;
    order.sort((a, b) => size[a] - size[b] || first[a] - first[b]);
    const tally = order.map(() => new Int32Array(0));
    for (const id of order) {
      const k = lab[first[id]];
      tally[slot[id]] = new Int32Array(base[k + 1] - base[k]);
    }
    for (let y = wy0; y <= wy1; y++) {
      for (let x = wx0; x <= wx1; x++) {
        const w0 = (y - wy0) * ww + (x - wx0);
        const id = comp[w0];
        if (id < 0 || slot[id] < 0) continue;
        const i0 = y * W + x;
        const k = lab[i0];
        const p = part[i0];
        const counts = tally[slot[id]];
        for (let s = 0; s < 4; s++) {
          const nx = x + (s === 0 ? -1 : s === 1 ? 1 : 0);
          const ny = y + (s === 2 ? -1 : s === 3 ? 1 : 0);
          if (nx < wx0 || ny < wy0 || nx > wx1 || ny > wy1) continue;
          const i2 = i0 + (s === 0 ? -1 : s === 1 ? 1 : s === 2 ? -W : W);
          if (lab[i2] !== k) continue;
          const q = part[i2];
          if (q === p || slot[comp[(ny - wy0) * ww + (nx - wx0)]] >= 0) continue;
          counts[q]++;
        }
      }
    }
    const target = new Int32Array(size.length).fill(-1);
    let moves = 0;
    for (const id of order) {
      const counts = tally[slot[id]];
      let best = -1;
      for (let p = 0; p < counts.length; p++) if (counts[p] > 0 && (best < 0 || counts[p] > counts[best])) best = p;
      if (best < 0) continue;
      target[id] = best;
      moves++;
    }
    if (moves === 0) return;
    for (let y = wy0; y <= wy1; y++) {
      for (let x = wx0; x <= wx1; x++) {
        const id = comp[(y - wy0) * ww + (x - wx0)];
        if (id >= 0 && target[id] >= 0) part[y * W + x] = target[id];
      }
    }
  }
}

/**
 * The parts of every complex region of `seg` materialised as real regions, so that everything downstream
 * (regionOrder, refineLabels, rankMap, regionMask, the layers) works unchanged: splitComplex on the fit core of each
 * complex region, by descending area (the ones that matter most first, id as tie-break) and only while the regions the
 * split adds fit both the GRADIENT_SPLIT_MAX_NEW_SHARE budget and MAX_GRADIENT_REGIONS; part 0 keeps the region's id
 * and the other parts get new ones after the last region.
 *
 * The split must cover EVERY pixel of the region, not only the core the k-means saw: a pixel of the region outside
 * the fit core (the edge band) goes to the part whose fitted fill predicts it best (squared RGB error), which is the
 * criterion refineLabels uses at Ux, so the proxy labels and the Ux refinement agree instead of disagreeing along the
 * seam (by nearest part instead, a band pixel could land in a part whose ramp never reaches it). Both boundaries are
 * then tidied: smoothParts votes them smooth and absorbIslands absorbs the pieces the vote leaves behind.
 *
 * Last gate, on the final labels: every part needs MIN_MODEL_CORE pixels of the TRUE core, because that is what
 * fitRegionModels fits its model on (the guarantees inside splitComplex and smoothParts count the FIT core, core ∪ deep
 * band, which is bigger); a region with a part under it is not split at all. area and adjacency are rebuilt for the new
 * labels; core, edge, sigma and edgeShare are unchanged: the core mask is per pixel, so a core pixel of the old region
 * is a core pixel of whichever part took it. The parts are then fitted exactly like the regions a merge round creates
 * (fitRegionModels, the untouched regions keeping their model), so every model comes from its final pixel set and the
 * deep-band rule applies to the parts too. Returns null when nothing was split.
 *
 * Exported for the tests: they hand it a Segmentation whose true core is deliberately sparser than the fit core, and
 * one whose k-means leaves islands, which no sample reaches on its own.
 */
export function splitComplexRegions(
  proxy: RasterImage,
  seg: Segmentation,
  fitted: FittedRegions,
  fitOpts: { sigma: number; maxStops: number; radial: boolean },
): { fitted: FittedRegions; splitRegions: number } | null {
  const count = seg.regions.count;
  const models = fitted.models;
  const px = fitted.px;
  const todo: number[] = [];
  for (let k = 0; k < count; k++) if (models[k].complex) todo.push(k);
  if (todo.length === 0) return null;
  todo.sort((a, b) => seg.area[b] - seg.area[a] || a - b);

  const W = seg.regions.width;
  const H = seg.regions.height;
  const lab = seg.regions.data;
  const part = new Int32Array(lab.length);
  const fills: Array<Fill[] | null> = Array.from({ length: count }, () => null);
  const budget = Math.max(2 ** SPLIT_MAX_DEPTH - 1, Math.ceil(GRADIENT_SPLIT_MAX_NEW_SHARE * count));
  let added = 0;
  for (const k of todo) {
    if (added >= budget) break; // every split adds at least one region
    const split = splitComplex(proxy, px, k, { ...fitOpts, fill: models[k].fill });
    if (split === null) continue;
    const m = split.fills.length;
    // Descending area, so a region whose parts do not fit what is left of the budget can still be followed by a
    // smaller one that does (MAX_GRADIENT_REGIONS is the absolute ceiling behind the per-image budget).
    if (added + m - 1 > budget || count + added + m - 1 > MAX_GRADIENT_REGIONS) continue;
    fills[k] = split.fills;
    added += m - 1;
    const start = px.offsets[k];
    for (let i = 0; i < split.assign.length; i++) part[px.indices[start + i]] = split.assign[i];
  }
  if (added === 0) return null;
  const base = new Int32Array(count + 1);
  for (let k = 0; k < count; k++) {
    const f = fills[k];
    base[k + 1] = base[k] + (f === null ? 0 : f.length);
  }

  const fitCore = fitted.fitSeg.core.data;
  const d = proxy.data;
  const c: RGB = [0, 0, 0];
  // Window of every split region (core and band), so the passes below only sweep what they can change.
  let wx0 = W;
  let wy0 = H;
  let wx1 = -1;
  let wy1 = -1;
  for (let i = 0; i < lab.length; i++) {
    const k = lab[i];
    if (k < 0) continue;
    const f = fills[k];
    if (f === null) continue;
    const x = i % W;
    const y = (i - x) / W;
    if (x < wx0) wx0 = x;
    if (x > wx1) wx1 = x;
    if (y < wy0) wy0 = y;
    if (y > wy1) wy1 = y;
    if (fitCore[i] !== 0) continue;
    const cx = x + 0.5;
    const cy = y + 0.5;
    const o = i * 4;
    let best = 0;
    let bestErr = Infinity;
    for (let p = 0; p < f.length; p++) {
      evaluateFill(f[p], cx, cy, c);
      const err = (d[o] - c[0]) ** 2 + (d[o + 1] - c[1]) ** 2 + (d[o + 2] - c[2]) ** 2;
      if (err < bestErr) {
        bestErr = err;
        best = p;
      }
    }
    part[i] = best;
  }
  smoothParts(lab, part, base, W, wx0, wy0, wx1, wy1, fitCore);
  absorbIslands(lab, part, base, W, wx0, wy0, wx1, wy1);

  const trueCore = seg.core.data;
  const coreCount = new Int32Array(base[count]);
  for (let y = wy0; y <= wy1; y++) {
    for (let x = wx0; x <= wx1; x++) {
      const i = y * W + x;
      const k = lab[i];
      if (k < 0 || base[k + 1] === base[k] || trueCore[i] === 0) continue;
      coreCount[base[k] + part[i]]++;
    }
  }
  const ids: Array<Int32Array | null> = Array.from({ length: count }, () => null);
  let next = count;
  let splitRegions = 0;
  for (let k = 0; k < count; k++) {
    const m = base[k + 1] - base[k];
    if (m === 0) continue;
    let ok = true;
    for (let p = 0; p < m; p++) if (coreCount[base[k] + p] < MIN_MODEL_CORE) ok = false;
    if (!ok) continue; // the region keeps its id on every one of its pixels, and its model
    const list = new Int32Array(m);
    list[0] = k;
    for (let p = 1; p < m; p++) list[p] = next++;
    ids[k] = list;
    splitRegions++;
  }
  if (splitRegions === 0) return null;
  const data = Int32Array.from(lab);
  for (let y = wy0; y <= wy1; y++) {
    for (let x = wx0; x <= wx1; x++) {
      const i = y * W + x;
      const k = lab[i];
      if (k < 0) continue;
      const list = ids[k];
      if (list !== null) data[i] = list[part[i]];
    }
  }

  const regions: RegionMap = { data, width: W, height: H, count: next };
  const area = new Float64Array(next);
  for (let i = 0; i < data.length; i++) if (data[i] >= 0) area[data[i]]++;
  const newSeg: Segmentation = {
    regions,
    edge: seg.edge,
    core: seg.core,
    area,
    adjacency: regionAdjacency(regions),
    sigma: seg.sigma,
    edgeShare: seg.edgeShare,
  };
  const known: Array<{ model: RegionModel; deep: number } | null> = [];
  for (let k = 0; k < next; k++) known.push(k < count && ids[k] === null ? { model: models[k], deep: fitted.deep[k] } : null);
  return { fitted: fitRegionModels(proxy, newSeg, fitOpts, known), splitRegions };
}

/**
 * Segments and fits gradient mode on `img` (the traced source): background as flat (resolveBackground; transparent
 * -> not composited) -> proxy (downscaleBoxRaster by gradientProxyFactor, on premultiplied colour when transparent)
 * -> sigma = immerkaerSigma(proxy) -> segmentEdges; fallback when edgeShare > GRADIENT_MAX_EDGE_SHARE, before any
 * labelling -> segmentRegions(proxy, { regionDetail, sigma, edges }); fallback with more than MAX_GRADIENT_REGIONS
 * regions. Otherwise selectModel per region (maxStops,
 * radial = radialGradients) on its core, or on its core ∪ deep band when the core no longer spans it
 * (GRADIENT_FIT_MIN_CORE_SHARE), and up to GRADIENT_MERGE_ROUNDS rounds of planMerges -> mergeRegions, re-fitting
 * every region made of more than one old region (the others keep their model). Above GRADIENT_MAX_COMPLEX_SHARE of the
 * labelled area in complex regions, fallback; below it, the complex regions left (a 2-D shading no single gradient
 * expresses) are split into parts with their own fills and materialised as regions (splitComplexRegions), and a part
 * that still comes out complex keeps the lowest-RMSE candidate selectModel returns. Last, every gradient is extended
 * over its region's deep band (extendModels).
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
  const late = complexFallback(fitted.fitSeg.area, fitted.models);
  if (late !== null) return late;
  // The fallback comes first on purpose: an image that is mostly complex is not flat art, and splitting its regions
  // would not make it so (splash and Instagram forced to gradient). Below the limit, the complex regions are split.
  let splitRegions = 0;
  const split = splitComplexRegions(proxy, seg, fitted, fitOpts);
  if (split !== null) {
    fitted = split.fitted;
    splitRegions = split.splitRegions;
  }
  const models = fitted.models;
  seg = fitted.fitSeg;
  extendModels(proxy, seg, models, fitted.px);
  return { kind: 'regions', base, transparent, f, sigma, seg, models, rawRegions, mergeRounds, splitRegions };
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
