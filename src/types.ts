/**
 * Shared contract types for image2svg. Pure data — no DOM, no worker globals.
 * Every image-like structure is a plain object so it works in Node (vitest) and browsers.
 */

/** RGBA, 4 bytes per pixel, row-major. Structurally compatible with ImageData. */
export interface RasterImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Single-channel float image, values 0..255 (luma or alpha). */
export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
}

/** Binary mask, 1 = ink/foreground, 0 = background. */
export interface BinaryMask {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Per-pixel palette index (0..count-1). */
export interface LabelMap {
  data: Uint8Array;
  width: number;
  height: number;
  count: number;
}

export type RGB = [number, number, number];

export type Mode = 'auto' | 'lines' | 'flat' | 'gradient' | 'pixel';
export type ConcreteMode = Exclude<Mode, 'auto'>;
export type Engine = 'potrace' | 'vtracer';
export type Layering = 'stacked' | 'cutout';
export type TurnPolicy = 'black' | 'white' | 'left' | 'right' | 'minority' | 'majority';
export type BackgroundSetting = 'auto' | 'white' | 'transparent' | { rgb: RGB };
export type AlphaMode = 'auto' | 'mask' | 'composite';
export type UpscaleSetting = 'auto' | 1 | 2 | 3 | 4;
/** 'auto': a detected fake-transparency checkerboard is treated as transparent; 'keep': traced as painted. */
export type BakedBackgroundSetting = 'auto' | 'keep';

/**
 * A checkerboard painted into the pixels of an opaque image to fake transparency (stock "PNG"
 * previews saved without alpha). Cells are squares of `cell` px (fractional when the image was
 * resampled); cell boundaries sit at offsetX + k*cell and offsetY + k*cell (pixel-edge coordinates,
 * pixel x spans [x, x+1]). A pixel's parity is
 * (floor((x + 0.5 - offsetX) / cell) + floor((y + 0.5 - offsetY) / cell)) mod 2.
 */
export interface BakedCheckerboard {
  cell: number;
  offsetX: number; // in [0, cell)
  offsetY: number; // in [0, cell)
  /** levels[p] = colour of the cells of parity p (mean of the matching border pixels). */
  levels: [RGB, RGB];
  /** Fraction of the candidate border pixels whose level matches their cell parity, 0..1. */
  borderMatchRatio: number;
}

/** vtracer-specific knobs. Angles in DEGREES here; the adapter converts to radians. */
export interface VtracerParams {
  cornerThresholdDeg: number; // default 60
  lengthThreshold: number; // default 4 (valid 3.5..10)
  maxIterations: number; // default 10
  spliceThresholdDeg: number; // default 45
  filterSpeckle: number; // default 4 (cluster size in px)
  colorPrecision: number; // default 6 (1..8)
  layerDifference: number; // default 16
  pathPrecision: number; // default 3
}

/** User-facing parameters. Everything optional; resolveParams() fills defaults. */
export interface TraceParams {
  mode?: Mode;
  engine?: Engine;
  upscale?: UpscaleSetting;
  /** Gaussian sigma as a multiple of the upscale factor (sigma_px = blurK * U). Default 0.35. */
  blurK?: number;
  /** Added to the clamped Otsu threshold (normalised 0..1). Range -0.25..0.25. */
  thresholdOffset?: number;
  invert?: boolean;
  alphamax?: number; // 0..1.334, default 1.0
  opttolerance?: number; // default 0.2
  /** Speckle area in ORIGINAL px². Scaled by U² internally. Default 2. */
  turdsize?: number;
  turnpolicy?: TurnPolicy; // default 'minority'
  opticurve?: boolean; // default true
  /** Palette size for flat mode, or 'auto' (exact palette if <= 32 colours, else 8). */
  colors?: number | 'auto';
  exactPalette?: boolean; // default true
  layering?: Layering; // default 'stacked'
  background?: BackgroundSetting; // default 'auto'
  alphaMode?: AlphaMode; // default 'auto'
  /** Fill colour for lines mode: '#rrggbb' or 'auto' (dominant ink colour). */
  fill?: string;
  /** Pixel mode: logical pixel grid size, or 'auto' (detect). */
  gridScale?: 'auto' | number;
  vtracer?: Partial<VtracerParams>;
  /** Run svgo on the final SVG (lazy-loaded in the browser). */
  optimize?: boolean;
  /** Fake transparency (checkerboard painted into the pixels): 'auto' treats it as transparent. Default 'auto'. */
  bakedBackground?: BakedBackgroundSetting;
  /** Gradient mode: segmentation detail 0.5..2; the edge thresholds are divided by it (above 1, more regions). Default 1. */
  regionDetail?: number;
  /** Gradient mode: most colour stops per gradient, integer 2..8. Default 8. */
  maxStops?: number;
  /** Gradient mode: allow radial gradients. Default true. */
  radialGradients?: boolean;
}

/** Fully resolved, numeric parameters used by the pipeline. */
export interface ResolvedParams {
  mode: ConcreteMode;
  engine: Engine;
  upscale: number; // U, integer >= 1
  upscaleCapped: boolean; // true if the 16 Mpx cap reduced the requested U
  sigmaPx: number; // blurK * U, in upscaled pixels
  thresholdOffset: number;
  invert: boolean;
  alphamax: number;
  opttolerance: number;
  turdsize: number; // original px²
  turdsizeScaled: number; // turdsize * U²  (what the tracer receives)
  turnpolicy: TurnPolicy;
  opticurve: boolean;
  colors: number | 'auto';
  exactPalette: boolean;
  layering: Layering;
  background: BackgroundSetting;
  alphaMode: AlphaMode;
  fill: string;
  gridScale: 'auto' | number;
  vtracer: VtracerParams;
  optimize: boolean;
  bakedBackground: BakedBackgroundSetting;
  regionDetail: number; // 0.5..2
  maxStops: number; // integer 2..8
  radialGradients: boolean;
}

/** Absolute path segments in some pixel space (y down). */
export type Seg =
  | { kind: 'M'; x: number; y: number }
  | { kind: 'L'; x: number; y: number }
  | { kind: 'Q'; x1: number; y1: number; x: number; y: number }
  | { kind: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { kind: 'Z' };

export interface AbsPath {
  segs: Seg[];
}

// ---------------------------------------------------------------------------------------------
// Gradient mode ('gradient'): fills, regions and models
//
// Coordinate convention of every fill (core/fillEval.ts is the only implementation): continuous
// image coordinates where pixel (x, y) covers [x, x+1) x [y, y+1) and is sampled at its centre
// (x + 0.5, y + 0.5). Fills fitted at 1x are in 1x units; the Ux pixel (X, Y) has its centre at
// ((X + 0.5)/U, (Y + 0.5)/U) in 1x units, so a 1x fill is emitted in viewBox units by multiplying
// its coordinates and r by U, with no offset (scaleFill). Layer.gradient is in viewBox units.
// ---------------------------------------------------------------------------------------------

/** A colour stop: offset in [0, 1] along the ramp, sRGB colour 0..255 per channel (not rounded). */
export interface GradientStop {
  offset: number;
  color: RGB;
}

/**
 * SVG linearGradient (gradientUnits userSpaceOnUse, spreadMethod pad): t = projection of the point on
 * (x2 - x1, y2 - y1) divided by its squared length, clamped to [0, 1]. Stops non-decreasing in offset.
 */
export interface LinearGradient {
  kind: 'linear';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: GradientStop[];
}

/** SVG radialGradient (userSpaceOnUse, no fx/fy, pad): t = distance to (cx, cy) / r, clamped to [0, 1]. */
export interface RadialGradient {
  kind: 'radial';
  cx: number;
  cy: number;
  r: number;
  stops: GradientStop[];
}

export type Gradient = LinearGradient | RadialGradient;

export interface SolidFill {
  kind: 'solid';
  color: RGB;
}

/** What paints a region: a flat colour or a gradient (same coordinate convention). */
export type Fill = SolidFill | Gradient;

/** Region id per pixel (0..count-1); -1 = no region. Int32: unlike LabelMap, not limited to 256. */
export interface RegionMap {
  data: Int32Array;
  width: number;
  height: number;
  count: number;
}

/**
 * Edge-based segmentation of an image into regions (core/regions.ts segmentRegions), at the resolution
 * it ran on (1x or a proxy). Defined here so that core/fillModel.ts does not import core/regions.ts.
 */
export interface Segmentation {
  /** Region per pixel: every pixel with alpha >= 128 has one (the edge band is grown into the regions); -1 below. */
  regions: RegionMap;
  /** 1 = edge pixel (hysteresis on the RGB Laplacian and Sobel maps). */
  edge: BinaryMask;
  /**
   * 1 = core pixel: alpha >= 128 and not edge; in a thin region (a stroke or ramp the edge band covers, see segmentRegions)
   * its pixels that are not a blend of their neighbours. Every region has at least one. Model fits use only these.
   */
  core: BinaryMask;
  /** Pixels per region (core and band), length regions.count. */
  area: Float64Array;
  /** adjacency[i] = ids of the regions 4-adjacent to region i, ascending, without i and without repeats. */
  adjacency: Int32Array[];
  /** Noise estimate (Immerkaer, levels) the edge thresholds were scaled with. */
  sigma: number;
  /** Edge pixels with alpha >= 128 / pixels with alpha >= 128 (0 when there is none). */
  edgeShare: number;
}

/** The model chosen for one region (core/fillModel.ts selectModel). */
export interface RegionModel {
  /** In continuous coordinates of the image it was fitted on (see the convention above); stops normalised. */
  fill: Fill;
  /** RMSE (levels, pooled over R, G and B) of `fill` on the region's core pixels. */
  rmse: number;
  /** RMSE of the flat model (mean colour) on the same pixels. */
  rmseFlat: number;
  /** Core pixels the fit used. */
  coreCount: number;
  /** No model passed the ladder; `fill` is then the candidate with the lowest RMSE. */
  complex: boolean;
}

/** Gradient-mode probe the classifier runs on a <= 512 px proxy (core/classify.ts probeGradients). */
export interface GradientProbe {
  /** Immerkaer noise estimate of the proxy (levels). */
  sigma: number;
  /** Regions after merging. */
  regions: number;
  /**
   * Share of the labelled area explained: the regions whose model has rmse <= max(2.5, 2σ) on their core, less their
   * pixels at least 2 px inside them that the model misses by more than 2·sobHi levels (a shape the segmentation handed
   * to them). 0 where gradient mode falls back (edge share, region count or complex share).
   */
  explained: number;
  /** Share of the labelled area in regions painted with a linear gradient. */
  linearShare: number;
  /** Share of the labelled area in regions painted with a radial gradient. */
  radialShare: number;
  /** Segmentation.edgeShare of the proxy. */
  edgeShare: number;
}

/** A traced layer, coordinates in viewBox units (upscaled pixels). */
export interface Layer {
  fill: string; // '#rrggbb'; with `gradient`, the mean colour of its stops (what readers that ignore it paint)
  /** Gradient mode: the gradient that paints the layer, in viewBox units like the paths. */
  gradient?: Gradient;
  opacity?: number; // 0..1, omitted when 1
  paths: AbsPath[];
}

export interface PathStats {
  pathCount: number;
  subpathCount: number;
  /** Number of segment endpoints (L/Q/C), i.e. nodes. */
  nodeCount: number;
  lineCount: number;
  curveCount: number;
  /** lineCount / (lineCount + curveCount); 0 when no segments. */
  cornerFraction: number;
  bytes: number; // UTF-8 length of the SVG string
}

export type WarningCode =
  | 'photo'
  | 'thin-strokes'
  | 'too-many-rects'
  | 'upscale-capped'
  | 'large-input'
  | 'engine-unavailable'
  /** lines/flat: the image is not blank but the trace came out without any ink. */
  | 'empty-trace'
  /** A fake-transparency checkerboard painted into the pixels was treated as transparent. */
  | 'baked-checkerboard'
  /** gradient: the image could not be rebuilt with gradients and was traced as a 16-colour flat palette. */
  | 'gradient-fallback';

export interface Warning {
  code: WarningCode;
  message: string; // Spanish, user-facing
}

/** Facts about the source image computed once after decode. */
export interface SourceInfo {
  width: number;
  height: number;
  /** Fraction of pixels with alpha < 8. */
  transparentRatio: number;
  /** Fraction of pixels with 8 <= alpha < 248. */
  partialAlphaRatio: number;
  /** Distinct colours after 5-bit quantisation, counting only colours with >= 0.05% population. */
  distinctColors: number;
  /**
   * Real colours of the exact palette (anti-aliasing and edge bands excluded, clusters closer
   * than 20 weighted units merged, clusters under 0.5% dropped); null when there are more than
   * 32 (photo-like).
   */
  paletteColors: number | null;
  /**
   * Fraction of opaque pixels farther than 24 raw-RGB units from every colour of that palette
   * (of an 8-colour median-cut palette when paletteColors is null): what a flat fill would get
   * visibly wrong. Anti-aliasing is a thin band (a few %); gradients/photos leave much more.
   */
  offPaletteRatio: number;
  /** Mean weighted colour distance (0..~305) from the opaque pixels to that palette. */
  quantError: number;
  /**
   * Fraction of opaque pixels farther than 48 raw-RGB units from a 2-colour palette (median cut
   * + k-means): how far the image is from two-tone. Tells a noisy scan (bimodal luma, too many
   * tones for an exact palette, yet two colours plus noise) from a colourful gradient whose luma
   * merely happens to be bimodal.
   */
  twoToneOffRatio: number;
  /**
   * Fraction of edge pixels whose transition is abrupt (no anti-aliasing blend of the two sides
   * within 1 px), measured on RGB, 0..1.
   */
  hardEdgeRatio: number;
  /** Fraction of ink pixels removed by a 1-px erosion (thin-stroke indicator), 0..1. */
  thinStrokeRatio: number;
  /** Detected pixel-art block size (>= 2) or 1 when no grid. */
  grid: number;
  /** Most common non-background ink colour. */
  dominantInk: RGB;
  /** Mode of the 1-px border ring when >= 80% agree, else null. */
  borderColor: RGB | null;
  /** True when the luma histogram is clearly bimodal (2 dominant clusters). */
  isBimodal: boolean;
  /**
   * Fake-transparency checkerboard detected in the source AND applied to this analysis: when not
   * null every other statistic describes the effective source, where that checkerboard is
   * transparent (see core/bakedBackground.ts). null when none was detected, or when the analysis
   * was asked to keep it (analyzeSource(img, 'keep')).
   */
  bakedBackground: BakedCheckerboard | null;
  /**
   * Gradient-mode probe (classify.ts probeGradients, <= 512 px proxy). Computed on the branch that would end in
   * 'photo' (no exact palette, or offPaletteShare > 0.15) and when the exact palette has GRADIENT_PROBE_MIN_COLORS (8)
   * or more colours (the staircase a smooth ramp leaves); null otherwise.
   */
  gradientProbe: GradientProbe | null;
}

export interface ClassifyResult {
  mode: ConcreteMode;
  params: TraceParams;
  warnings: Warning[];
  reasons: string[];
}

export interface Metrics {
  /** 0..1 combined score (0.6*SSIM + 0.4*IoU for lines; see fidelity.ts). */
  fidelity: number;
  ssim: number;
  iou: number;
  mae: number; // 0..255
  pctDiff16: number; // fraction of ROI pixels with max channel diff > 16
  pctDiff32: number;
}

export interface TraceResult {
  svg: string;
  stats: PathStats;
  resolved: ResolvedParams;
  warnings: Warning[];
  ms: number;
}

/** Tracer options in the tracer's own pixel space (already scaled). */
export interface TracerOptions {
  alphamax: number;
  opttolerance: number;
  turdsize: number; // px² in the mask's resolution
  turnpolicy: TurnPolicy;
  opticurve: boolean;
  vtracer: VtracerParams;
}

/**
 * A tracer turns a binary mask into absolute paths in MASK pixel units (y down, origin top-left).
 * Implementations must be usable from a module Web Worker and from Node tests.
 */
export interface Tracer {
  readonly name: Engine;
  /** Idempotent. `source` lets Node tests pass wasm bytes / a URL for vtracer. */
  init(source?: unknown): Promise<void>;
  traceBinary(mask: BinaryMask, opts: TracerOptions): Promise<AbsPath[]>;
}
