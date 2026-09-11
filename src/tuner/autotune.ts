/**
 * Auto-tuner. Pure TypeScript (no DOM): tracers, clock, yielding and cancellation are injected.
 *
 * What is measured: every candidate traces the source trace() works on for the params (traceInput: a
 * detected fake-transparency checkerboard is transparent unless bakedBackground is 'keep'); its layers
 * are rendered with the reference scanline rasteriser and compared with that same source by
 * computeMetrics, both composited on comparisonBackground (the opaque background a flat SVG paints,
 * else the border colour or white). That is the measurement the worker's compare runs on the
 * browser-rendered SVG, so a painted checkerboard never counts as detail to reproduce.
 *
 * Objective: tunerScore = fidelity − 0.15·cornerFraction − 0.10·min(1, nodes / (2·perimeter)), under a
 * fidelity guard. The baseline (the given params) is evaluated first; a later candidate can only
 * become the result when its fidelity >= baseline fidelity − FIDELITY_GUARD; among those the highest
 * score wins, ties go to fewer corners (L segments) and then fewer nodes (outranks). `perimeter` is
 * estimated once per scale from the masks the pipeline prepares at U = 1 without blur (maskPerimeter).
 *
 * Search:
 *   baseline  the given params at full resolution (always evaluated: the result is never worse)
 *   stage A   36 candidates (grid.ts) on a box-downscaled proxy <= 256 px (premultiplied when the source
 *             has transparency; the source itself when it already fits); turdsize is divided by the
 *             proxy factor² so it drops the same specks. Preprocessing (upscale + blur + threshold /
 *             palette) is memoised per (U, blurK).
 *   stage B   the top 3 of stage A at full resolution: alphamax ±0.15 step 0.05 × opttolerance {0.1,0.2,0.4}.
 *             Without a proxy, stage-A candidates below the guard rank after the rest when the seeds are
 *             picked; a proxy ranks by score only.
 *   engine    vtracer with its defaults on the best preprocessing found, when vtracer is available
 * Stages A/B trace with potrace (vtracer when potrace is unavailable). Only full-resolution
 * evaluations can be returned; with a real proxy, stage A only ranks. Candidates whose resolved
 * tracer input is identical are scored once (they still count as done).
 *
 * Stops: early exit as soon as a full-resolution candidate within the guard scores > 0.985 with
 * cornerFraction < 0.15; budget: a candidate is not started when elapsed + the duration of the
 * previous evaluation on the same scale would exceed budgetMs (the baseline always runs);
 * cancellation is checked before every candidate and again after yieldToEvents(), so a cancel lands
 * within one candidate. Progress after every candidate. Pixel mode has nothing to tune: the default
 * trace is returned at once with score = its fidelity.
 */
import type {
  AbsPath,
  BackgroundSetting,
  BakedCheckerboard,
  BinaryMask,
  ConcreteMode,
  Engine,
  Layer,
  RasterImage,
  ResolvedParams,
  RGB,
  Seg,
  SourceInfo,
  TraceParams,
  TraceResult,
  Tracer,
  TracerOptions,
  Warning,
} from '../types';
import type { TuneProgress, TuneSummary } from '../workers/protocol';
import { resolveBackground } from '../core/background';
import { classify } from '../core/classify';
import { detectGrid } from '../core/edges';
import { countInk } from '../core/morphology';
import { VTRACER_DEFAULTS, resolveParams } from '../core/params';
import { bakedCheckerboardWarning, prepareFlat, prepareLines, trace, traceInput, type Prepared } from '../core/pipeline';
import { downscaleNearest } from '../core/pixelExact';
import { downscaleBoxRaster } from '../core/upscale';
import { computeMetrics, tunerScore } from '../metrics/fidelity';
import { flattenPath, rasterizeLayers } from '../metrics/scanline';
import { assembleSvg } from '../svg/assemble';
import { pathStats, utf8ByteLength } from '../svg/pathStats';
import {
  STAGE_B_PER_SEED,
  STAGE_B_SEEDS,
  candidateParams,
  groupByPreprocessing,
  pickSeeds,
  proxyFactor,
  stageAGrid,
  stageBGrid,
  type Ranked,
} from './grid';

export type { TuneSummary };

export const EARLY_EXIT_SCORE = 0.985;
export const EARLY_EXIT_MAX_CORNER_FRACTION = 0.15;
/** Fidelity a candidate may lose against the baseline and still become the result. */
export const FIDELITY_GUARD = 0.005;

/** Initialised tracers; a missing engine is unavailable (the pipeline falls back and warns). */
export type AvailableTracers = Partial<Record<Engine, Tracer>>;

export interface TuneOptions {
  budgetMs: number;
  now: () => number;
  yieldToEvents: () => Promise<void>;
  isCancelled: () => boolean;
  onProgress: (progress: TuneProgress) => void;
}

export type TuneStop = 'complete' | 'early-exit' | 'budget' | 'pixel';

export interface TuneResult extends TraceResult {
  /** Params that reproduce `svg` with trace(): the given params with the tuned knobs. */
  params: TraceParams;
  score: number;
  /** Score of the given params (the baseline). */
  defaultScore: number;
  /** The given params measured like every candidate (fidelity against the effective source, SVG size). */
  baseline: TuneSummary;
  /** The returned trace, measured the same way. */
  tuned: TuneSummary;
  /** Candidates actually traced (memoised duplicates excluded). */
  evaluated: number;
  stop: TuneStop;
}

/** What decides between two full-resolution evaluations (see outranks). */
export interface Standing {
  score: number;
  fidelity: number;
  /** Corner nodes: line segments (L). */
  corners: number;
  nodes: number;
}

/**
 * True when `a` must replace `b` (the current result, already within the guard): `a` keeps
 * fidelity >= fidelityFloor (baseline fidelity − FIDELITY_GUARD) and has a higher score, or the same
 * score with fewer corners, or the same score and corners with fewer nodes.
 */
export function outranks(a: Standing, b: Standing, fidelityFloor: number): boolean {
  if (!(a.fidelity >= fidelityFloor)) return false;
  if (a.score !== b.score) return a.score > b.score;
  if (a.corners !== b.corners) return a.corners < b.corners;
  return a.nodes < b.nodes;
}

const WHITE: RGB = [255, 255, 255];

/** Colour both images are composited on for metrics: the border colour, else white. */
export function metricBackground(info: Pick<SourceInfo, 'borderColor'>): RGB {
  const b = info.borderColor;
  return b === null ? [WHITE[0], WHITE[1], WHITE[2]] : [b[0], b[1], b[2]];
}

/**
 * Colour a trace of `image` and `image` itself are composited on for metrics. `image` is the traced
 * source (traceInput(img, info, params).image) and `info` its analysis. In flat mode an opaque
 * background resolved from `background` is painted by the SVG over the whole canvas, so the source's
 * transparent pixels are shown on it too; otherwise (lines, pixel, or a transparent flat background)
 * metricBackground(info).
 */
export function comparisonBackground(
  image: RasterImage,
  info: Pick<SourceInfo, 'borderColor'>,
  mode: ConcreteMode,
  background: BackgroundSetting = 'auto',
): RGB {
  const painted = mode === 'flat' ? resolveBackground(image, background, info) : null;
  return painted ?? metricBackground(info);
}

/**
 * Perimeter estimate (px) of a mask's shapes: 4-neighbour ink/background transitions inside the
 * image × π/4 (Cauchy–Crofton: a curve's axis-aligned staircase is 4/π times longer on average).
 * The image border is not counted: a shape clipped by it costs the tracer almost no nodes there.
 */
export function maskPerimeter(mask: BinaryMask): number {
  const { data, width: w, height: h } = mask;
  let edges = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const below = row + w;
    for (let x = 0; x < w; x++) {
      const v = data[row + x] !== 0;
      if (x + 1 < w && v !== (data[row + x + 1] !== 0)) edges++;
      if (y + 1 < h && v !== (data[below + x] !== 0)) edges++;
    }
  }
  return (edges * Math.PI) / 4;
}

/**
 * Renders layers traced at U× (viewBox = image × U) straight at the image size. Curves are flattened
 * in viewBox units (the rasteriser's 0.1 px tolerance at U×) before the polylines are scaled by 1/U,
 * and each row gets 4·U sub-scanlines: the same flattening and sample rows as rasterising at U× with
 * 4 sub-scanlines and box-downscaling (tests/fixtures/svgBack renderAt1x), without the U²-sized
 * buffers. Scaling the curves first would flatten them U times coarser (up to 22 levels off).
 */
export function renderLayersAt1x(layers: Layer[], U: number, width: number, height: number, background: RGB): RasterImage {
  if (U === 1) return rasterizeLayers(layers, width, height, background);
  const s = 1 / U;
  const scaled: Layer[] = layers.map((layer) => {
    const segs: Seg[] = [];
    for (const p of layer.paths) {
      for (const poly of flattenPath(p)) {
        segs.push({ kind: 'M', x: poly[0][0] * s, y: poly[0][1] * s });
        for (let i = 1; i < poly.length; i++) segs.push({ kind: 'L', x: poly[i][0] * s, y: poly[i][1] * s });
        segs.push({ kind: 'Z' });
      }
    }
    // One path per layer: the rasteriser applies nonzero winding to the union of all edges anyway.
    return { ...layer, paths: [{ segs }] };
  });
  return rasterizeLayers(scaled, width, height, background, Math.min(64, 4 * Math.max(1, Math.round(U))));
}

// ---------------------------------------------------------------------------------------------
// Mirror of the private steps of core/pipeline.trace(), so that a candidate's output is exactly
// what trace() gives for its params (tests/tuner/autotune.test.ts checks svg/stats/warnings).
// ---------------------------------------------------------------------------------------------

function mergeParams(base: TraceParams, over: TraceParams): TraceParams {
  const out: TraceParams = { ...base };
  const src = over as Record<string, unknown>;
  const dst = out as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (src[key] !== undefined) dst[key] = src[key];
  }
  return out;
}

function engineUnavailableWarning(wanted: Engine, used: Engine): Warning {
  return {
    code: 'engine-unavailable',
    message: `El motor "${wanted}" no está disponible; se usó "${used}" en su lugar.`,
  };
}

function emptyTraceTracerWarning(): Warning {
  return {
    code: 'empty-trace',
    message:
      'El trazado eliminó toda la tinta (manchas por debajo del tamaño mínimo): el SVG sale vacío. ' +
      'Reduce las manchas mínimas o ajusta el umbral.',
  };
}

function pickTracer(tracers: AvailableTracers, wanted: Engine): { tracer: Tracer; engine: Engine; warning: Warning | null } {
  const direct = tracers[wanted];
  if (direct !== undefined) return { tracer: direct, engine: wanted, warning: null };
  const fallbacks: Engine[] = ['potrace', 'vtracer'];
  for (const engine of fallbacks) {
    const t = tracers[engine];
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
    vtracer: { ...resolved.vtracer, filterSpeckle: resolved.vtracer.filterSpeckle * U * U },
  };
}

function isFullMask(mask: BinaryMask): boolean {
  const d = mask.data;
  for (let i = 0; i < d.length; i++) if (d[i] === 0) return false;
  return d.length > 0;
}

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

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

interface Context {
  /** Analysis of the traced source (traceInput). */
  info: SourceInfo;
  tracers: AvailableTracers;
  /** classify(info).params when the given mode is 'auto' (or absent), else null. */
  clsParams: TraceParams | null;
  modeIfAuto: ConcreteMode | undefined;
  clsWarnings: Warning[];
  /** Fake checkerboard trace() makes transparent for these params (its warning goes first), or null. */
  baked: BakedCheckerboard | null;
  bg: RGB;
}

interface Scored extends Standing {
  cornerFraction: number;
}

/** An image the candidates are traced on: the source (full) or its proxy. */
interface Scale {
  img: RasterImage;
  /** Full resolution: its evaluations are returnable as they are. */
  full: boolean;
  perimeter: number;
  scores: Map<string, Scored>;
  /** Last preparation (one entry: candidates arrive grouped by preprocessing). */
  prep: { key: string; prepared: Prepared } | null;
  /** Duration of the previous evaluation on this scale (budget estimate). */
  lastMs: number;
}

interface Planned {
  params: TraceParams;
  resolved: ResolvedParams;
  tracer: Tracer;
  engineWarning: Warning | null;
  key: string;
}

interface Evaluated extends Scored {
  planned: Planned;
  layers: Layer[];
  U: number;
  width: number;
  height: number;
  preparedWarnings: Warning[];
  /** The masks had ink but the tracer dropped all of it. */
  inkDropped: boolean;
}

type Step = { kind: 'next' | 'stop'; key: string; scored: Scored | null } | { kind: 'cancelled' };

function effectiveParams(ctx: Pick<Context, 'clsParams'>, p: TraceParams): TraceParams {
  return ctx.clsParams === null ? p : mergeParams(ctx.clsParams, p);
}

function resolveFor(ctx: Pick<Context, 'clsParams' | 'modeIfAuto'>, img: RasterImage, p: TraceParams): ResolvedParams {
  return resolveParams(effectiveParams(ctx, p), { width: img.width, height: img.height }, ctx.modeIfAuto);
}

/** Identity of the traced output for fixed non-tuned params (mode, colours, background, fill…). */
function evalKey(r: ResolvedParams): string {
  const head = `${r.engine}|${r.upscale}|${r.upscaleCapped ? 1 : 0}|${r.sigmaPx}`;
  if (r.engine === 'potrace') {
    const turd = Math.max(0, Math.round(r.turdsizeScaled)); // what the potrace adapter receives
    return `${head}|${r.alphamax}|${r.opttolerance}|${turd}|${r.turnpolicy}|${r.opticurve ? 1 : 0}`;
  }
  const v = r.vtracer;
  const speckle = v.filterSpeckle * r.upscale * r.upscale;
  return (
    `${head}|${v.cornerThresholdDeg}|${v.lengthThreshold}|${v.maxIterations}|${v.spliceThresholdDeg}|` +
    `${speckle}|${v.colorPrecision}|${v.layerDifference}|${v.pathPrecision}`
  );
}

function plan(ctx: Context, scale: Scale, params: TraceParams): Planned {
  let resolved = resolveFor(ctx, scale.img, params);
  const picked = pickTracer(ctx.tracers, resolved.engine);
  if (picked.warning !== null) resolved = { ...resolved, engine: picked.engine };
  return { params, resolved, tracer: picked.tracer, engineWarning: picked.warning, key: evalKey(resolved) };
}

function prepare(ctx: Context, img: RasterImage, resolved: ResolvedParams): Prepared {
  return resolved.mode === 'lines' ? prepareLines(img, resolved, ctx.info) : prepareFlat(img, resolved, ctx.info);
}

function prepareCached(ctx: Context, scale: Scale, resolved: ResolvedParams): Prepared {
  const key = `${resolved.upscale}|${resolved.upscaleCapped ? 1 : 0}|${resolved.sigmaPx}`;
  if (scale.prep !== null && scale.prep.key === key) return scale.prep.prepared;
  scale.prep = null; // release the previous masks before building the next ones
  const prepared = prepare(ctx, scale.img, resolved);
  scale.prep = { key, prepared };
  return prepared;
}

function makeScale(ctx: Context, img: RasterImage, full: boolean, base: TraceParams): Scale {
  const resolved = resolveFor(ctx, img, { ...base, upscale: 1, blurK: 0 });
  const prepared = prepare(ctx, img, resolved);
  let perimeter = 0;
  for (const layer of prepared.layers) if (!isFullMask(layer.mask)) perimeter += maskPerimeter(layer.mask);
  return { img, full, perimeter, scores: new Map(), prep: null, lastMs: 0 };
}

/**
 * Box-downscaled proxy of `img`. With transparency the average runs on premultiplied colour: the RGB
 * of transparent pixels (0 in an effective source) would otherwise darken every edge of the proxy.
 */
function proxyImage(img: RasterImage, f: number): RasterImage {
  const d = img.data;
  let opaque = true;
  for (let p = 3; p < d.length; p += 4) {
    if (d[p] !== 255) {
      opaque = false;
      break;
    }
  }
  if (opaque) return downscaleBoxRaster(img, f);
  const pre = new Uint8ClampedArray(d.length);
  for (let p = 0; p < d.length; p += 4) {
    const a = d[p + 3];
    pre[p] = (d[p] * a) / 255;
    pre[p + 1] = (d[p + 1] * a) / 255;
    pre[p + 2] = (d[p + 2] * a) / 255;
    pre[p + 3] = a;
  }
  const small = downscaleBoxRaster({ data: pre, width: img.width, height: img.height }, f);
  const s = small.data;
  for (let p = 0; p < s.length; p += 4) {
    const a = s[p + 3];
    if (a === 0 || a === 255) continue;
    s[p] = (s[p] * 255) / a;
    s[p + 1] = (s[p + 1] * 255) / a;
    s[p + 2] = (s[p + 2] * 255) / a;
  }
  return small;
}

async function evaluate(ctx: Context, scale: Scale, planned: Planned): Promise<Evaluated> {
  const { resolved } = planned;
  const prepared = prepareCached(ctx, scale, resolved);
  const layers = await traceLayers(prepared, planned.tracer, tracerOptions(resolved));
  const stats = pathStats(layers, 0);
  const rendered = renderLayersAt1x(layers, prepared.U, prepared.width, prepared.height, ctx.bg);
  const metrics = computeMetrics({ original: scale.img, rendered, mode: resolved.mode, background: ctx.bg });
  return {
    score: tunerScore(metrics, stats, scale.perimeter),
    fidelity: metrics.fidelity,
    corners: stats.lineCount,
    nodes: stats.nodeCount,
    cornerFraction: stats.cornerFraction,
    planned,
    layers,
    U: prepared.U,
    width: prepared.width,
    height: prepared.height,
    preparedWarnings: prepared.warnings,
    inkDropped: layers.length === 0 && prepared.layers.some((l) => countInk(l.mask) > 0),
  };
}

function scoredOf(ev: Evaluated): Scored {
  return { score: ev.score, fidelity: ev.fidelity, corners: ev.corners, nodes: ev.nodes, cornerFraction: ev.cornerFraction };
}

function svgOf(ev: Evaluated): string {
  return assembleSvg(ev.layers, {
    width: ev.width,
    height: ev.height,
    viewBoxWidth: ev.width * ev.U,
    viewBoxHeight: ev.height * ev.U,
  });
}

function finish(
  ctx: Context,
  best: Evaluated,
  baseline: Evaluated,
  ms: number,
  extra: { defaultScore: number; evaluated: number; stop: TuneStop },
): TuneResult {
  const svg = svgOf(best);
  const stats = pathStats(best.layers, utf8ByteLength(svg));
  const baselineBytes = baseline === best ? stats.bytes : utf8ByteLength(svgOf(baseline));
  // Same order and de-duplication as trace(): classifier, engine fallback, preparation, empty trace;
  // the fake-checkerboard warning goes first.
  const warnings: Warning[] = [...ctx.clsWarnings];
  if (best.planned.engineWarning !== null) warnings.push(best.planned.engineWarning);
  for (const w of best.preparedWarnings) if (!warnings.some((x) => x.code === w.code)) warnings.push(w);
  if (best.inkDropped && !warnings.some((x) => x.code === 'empty-trace')) warnings.push(emptyTraceTracerWarning());
  if (ctx.baked !== null) warnings.unshift(bakedCheckerboardWarning(ctx.baked));
  return {
    svg,
    stats,
    resolved: best.planned.resolved,
    warnings,
    ms,
    params: best.planned.params,
    score: best.score,
    baseline: {
      fidelity: baseline.fidelity,
      cornerFraction: baseline.cornerFraction,
      nodeCount: baseline.nodes,
      bytes: baselineBytes,
    },
    tuned: { fidelity: best.fidelity, cornerFraction: stats.cornerFraction, nodeCount: stats.nodeCount, bytes: stats.bytes },
    ...extra,
  };
}

/**
 * What the pixel-mode SVG draws, at the source size: every pixel takes the colour of the top-left
 * pixel of its block (partial edge blocks included). It reproduces every logical pixel exactly.
 */
function pixelReconstruction(img: RasterImage, resolved: ResolvedParams): RasterImage {
  const k = resolved.gridScale === 'auto' ? detectGrid(img) : Math.max(1, Math.floor(resolved.gridScale));
  if (k <= 1) return img;
  const logical = downscaleNearest(img, k);
  const { width: w, height: h } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  const src = logical.data;
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / k) * logical.width;
    for (let x = 0; x < w; x++) {
      const s = (row + Math.floor(x / k)) * 4;
      const o = (y * w + x) * 4;
      out[o] = src[s];
      out[o + 1] = src[s + 1];
      out[o + 2] = src[s + 2];
      out[o + 3] = src[s + 3];
    }
  }
  return { data: out, width: w, height: h };
}

async function tunePixel(
  ctx: Context,
  img: RasterImage,
  source: RasterImage,
  params: TraceParams,
  opts: TuneOptions,
  t0: number,
): Promise<TuneResult | null> {
  if (opts.isCancelled()) return null;
  const r = await trace(img, params, ctx.tracers as Record<Engine, Tracer>, ctx.info);
  const rendered =
    r.svg === ''
      ? { data: new Uint8ClampedArray(source.data.length), width: source.width, height: source.height }
      : pixelReconstruction(source, r.resolved);
  const score = computeMetrics({ original: source, rendered, mode: 'pixel', background: ctx.bg }).fidelity;
  opts.onProgress({ stage: 'A', done: 1, total: 1, best: { score, params } });
  if (opts.isCancelled()) return null;
  const summary: TuneSummary = {
    fidelity: score,
    cornerFraction: r.stats.cornerFraction,
    nodeCount: r.stats.nodeCount,
    bytes: r.stats.bytes,
  };
  return {
    ...r,
    ms: opts.now() - t0,
    params,
    score,
    defaultScore: score,
    baseline: summary,
    tuned: { ...summary },
    evaluated: 1,
    stop: 'pixel',
  };
}

/**
 * Tunes `params` for `img`, whose analyzeSource is `info` (or, for bakedBackground 'keep', its
 * analyzeSource(img, 'keep')). Resolves null when cancelled; errors from the tracers propagate.
 */
export async function autotune(
  img: RasterImage,
  info: SourceInfo,
  params: TraceParams,
  tracers: AvailableTracers,
  opts: TuneOptions,
): Promise<TuneResult | null> {
  const t0 = opts.now();
  // The source trace() works on for these params (a fake checkerboard is transparent unless 'keep').
  const input = traceInput(img, info, params);
  const source = input.image;
  const cls = params.mode === undefined || params.mode === 'auto' ? classify(input.info) : null;
  const clsParams = cls === null ? null : cls.params;
  const modeIfAuto = cls === null ? undefined : cls.mode;
  const base = resolveFor({ clsParams, modeIfAuto }, source, params);
  const ctx: Context = {
    info: input.info,
    tracers,
    clsParams,
    modeIfAuto,
    clsWarnings: cls === null ? [] : cls.warnings,
    baked: input.info.bakedBackground ?? null,
    bg: comparisonBackground(source, input.info, base.mode, base.background),
  };
  if (base.mode === 'pixel') return tunePixel(ctx, img, source, params, opts, t0);

  const searchEngine: Engine = tracers.potrace !== undefined ? 'potrace' : 'vtracer';
  const enginePass = searchEngine === 'potrace' && tracers.vtracer !== undefined;
  const gridA = stageAGrid(base.opttolerance);
  const total = 1 + gridA.length + STAGE_B_SEEDS * STAGE_B_PER_SEED + (enginePass ? 1 : 0);
  const state = {
    done: 0,
    evaluated: 0,
    best: null as Evaluated | null,
    baseline: null as Evaluated | null,
    /** Lowest fidelity with which a full-resolution candidate can become the result. */
    floor: -Infinity,
    stop: 'complete' as TuneStop,
  };

  const report = (stage: TuneProgress['stage']): void => {
    const b = state.best;
    opts.onProgress({ stage, done: state.done, total, best: b === null ? null : { score: b.score, params: b.planned.params } });
  };

  const step = async (stage: TuneProgress['stage'], scale: Scale, p: TraceParams, force = false): Promise<Step> => {
    if (opts.isCancelled()) return { kind: 'cancelled' };
    const planned = plan(ctx, scale, p);
    const cached = scale.scores.get(planned.key);
    if (cached !== undefined) {
      state.done++;
      report(stage);
      return { kind: 'next', key: planned.key, scored: cached };
    }
    if (!force && opts.now() - t0 + scale.lastMs > opts.budgetMs) {
      state.stop = 'budget';
      return { kind: 'stop', key: planned.key, scored: null };
    }
    await opts.yieldToEvents();
    if (opts.isCancelled()) return { kind: 'cancelled' };
    const started = opts.now();
    const ev = await evaluate(ctx, scale, planned);
    scale.lastMs = opts.now() - started;
    state.evaluated++;
    const scored = scoredOf(ev);
    scale.scores.set(planned.key, scored);
    if (scale.full) {
      if (state.baseline === null) {
        state.baseline = ev;
        state.floor = ev.fidelity - FIDELITY_GUARD;
      }
      if (state.best === null || outranks(ev, state.best, state.floor)) state.best = ev;
    }
    state.done++;
    report(stage);
    if (
      scale.full &&
      ev.fidelity >= state.floor &&
      ev.score > EARLY_EXIT_SCORE &&
      ev.cornerFraction < EARLY_EXIT_MAX_CORNER_FRACTION
    ) {
      state.stop = 'early-exit';
      return { kind: 'stop', key: planned.key, scored };
    }
    return { kind: 'next', key: planned.key, scored };
  };

  const full = makeScale(ctx, source, true, params);
  const baseline = await step('A', full, params, true);
  if (baseline.kind === 'cancelled' || baseline.scored === null) return null;
  const defaultScore = baseline.scored.score;
  let flow: 'next' | 'stop' = baseline.kind;

  if (flow === 'next') {
    const f = proxyFactor(img.width, img.height);
    const proxy = f === 1 ? full : makeScale(ctx, proxyImage(source, f), false, params);
    const ranked: Ranked[] = [];
    for (const c of gridA) {
      const onProxy = f === 1 ? c : { ...c, turdsize: c.turdsize / (f * f) };
      const r = await step('A', proxy, candidateParams(params, onProxy, searchEngine, proxy.img));
      if (r.kind === 'cancelled') return null;
      if (r.scored !== null) {
        // On the source itself the guard is exact and decides the seed order first. A proxy ranks by
        // score only: its fidelity gaps are not the source's (see ARCHITECTURE.md, fidelity guard).
        const entry: Ranked = { candidate: c, key: r.key, score: r.scored.score };
        if (proxy === full) entry.eligible = r.scored.fidelity >= state.floor;
        ranked.push(entry);
      }
      if (r.kind === 'stop') {
        flow = 'stop';
        break;
      }
    }

    if (flow === 'next') {
      stageB: for (const seed of groupByPreprocessing(pickSeeds(ranked))) {
        for (const c of stageBGrid(seed)) {
          const r = await step('B', full, candidateParams(params, c, searchEngine, source));
          if (r.kind === 'cancelled') return null;
          if (r.kind === 'stop') {
            flow = 'stop';
            break stageB;
          }
        }
      }
    }

    if (flow === 'next' && enginePass && state.best !== null) {
      const p: TraceParams = { ...state.best.planned.params, engine: 'vtracer', vtracer: { ...VTRACER_DEFAULTS } };
      const r = await step('engine', full, p);
      if (r.kind === 'cancelled') return null;
    }
  }

  if (opts.isCancelled() || state.best === null || state.baseline === null) return null;
  return finish(ctx, state.best, state.baseline, opts.now() - t0, {
    defaultScore,
    evaluated: state.evaluated,
    stop: state.stop,
  });
}
