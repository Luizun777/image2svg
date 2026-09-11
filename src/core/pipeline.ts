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
  GrayImage,
  Layer,
  PathStats,
  RasterImage,
  ResolvedParams,
  RGB,
  SourceInfo,
  TraceParams,
  TraceResult,
  Tracer,
  TracerOptions,
  Warning,
} from '../types';
import { alphaToGray, compositeOnColor, dominantInkColor, toGray } from './raster';
import { MAX_UPSCALED_AREA, upscaleGray, upscaleRaster } from './upscale';
import { gaussianBlur, gaussianBlurRaster } from './blur';
import { binarize, maskFromAlpha, resolveThreshold } from './threshold';
import { resolveAlphaMode, resolveBackground } from './background';
import { resolveParams } from './params';
import { assignLabels, buildPalette, toHex } from './palette';
import { cutoutMasks, layerOrder, nestedMasks } from './stack';
import { MAX_PIXEL_RECTS, downscaleNearest, pixelSvg } from './pixelExact';
import { countInk } from './morphology';
import { detectGrid } from './edges';
import { analyzeSource, classify, THIN_STROKE_RATIO } from './classify';
import { applyBakedBackground, detectBakedCheckerboard, effectiveSource } from './bakedBackground';
import { assembleSvg } from '../svg/assemble';
import { pathStats, utf8ByteLength } from '../svg/pathStats';

export interface PreparedLayer {
  mask: BinaryMask;
  fill: string;
  opacity?: number;
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
function isFullMask(mask: BinaryMask): boolean {
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
function rectPath(w: number, h: number): AbsPath {
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

async function traceLayers(prepared: Prepared, tracer: Tracer, opts: TracerOptions): Promise<Layer[]> {
  const vw = prepared.width * prepared.U;
  const vh = prepared.height * prepared.U;
  const layers: Layer[] = [];
  for (let i = 0; i < prepared.layers.length; i++) {
    const pl = prepared.layers[i];
    const paths: AbsPath[] = isFullMask(pl.mask) ? [rectPath(vw, vh)] : await tracer.traceBinary(pl.mask, opts);
    if (paths.length === 0) continue;
    const layer: Layer = { fill: pl.fill, paths };
    if (pl.opacity !== undefined && pl.opacity < 1) layer.opacity = pl.opacity;
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
    const prepared = resolved.mode === 'lines' ? prepareLines(source, resolved, si) : prepareFlat(source, resolved, si);
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
      prepared.layers.some((l) => countInk(l.mask) > 0)
    ) {
      warnings.push(emptyTraceWarning('tracer'));
    }
  }
  if (baked !== null) warnings.unshift(bakedCheckerboardWarning(baked));

  return { svg, stats, resolved, warnings, ms: performance.now() - t0 };
}
