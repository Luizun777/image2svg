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

export type Mode = 'auto' | 'lines' | 'flat' | 'pixel';
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

/** A traced layer, coordinates in viewBox units (upscaled pixels). */
export interface Layer {
  fill: string; // '#rrggbb'
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
  | 'baked-checkerboard';

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
