/**
 * Worker-side request handler. Pure and Node-testable: the tracers, the clock and the way to yield
 * to the event loop are injected, and responses leave through the `post` callback given with each
 * request. trace.worker.ts is only a thin wrapper around it.
 *
 * Per-worker state: the engines initialised by 'init', the source image with its SourceInfo
 * (setSource) and a memo (classification of the current source, the last TRACE_MEMO_SIZE traces by
 * canonical params; both cleared by setSource and init).
 *
 * Requests run one at a time in arrival order (FIFO), yielding to the event loop before each one so
 * that pending 'cancel' messages land first. 'cancel' is never queued: a queued trace / tune /
 * compare is dropped at once with {type:'cancelled'}; the running one is flagged (a tune stops
 * within one candidate; a trace or compare that finishes anyway answers 'cancelled' instead of its
 * result). A failing request answers {type:'error'} and the handler keeps going; a fatal wasm
 * failure (abort / exit / trap: potrace's runtime stays broken afterwards) answers {type:'fatal'}
 * so the client recreates the worker, and every later request answers 'error'. handle() never throws.
 */
import type { ClassifyResult, Engine, RasterImage, SourceInfo, TraceResult, Tracer } from '../types';
import type { RasterPayload, WorkerRequest, WorkerResponse } from './protocol';
import { effectiveSource } from '../core/bakedBackground';
import { analyzeSource, classify } from '../core/classify';
import { trace } from '../core/pipeline';
import { compositeOnColor } from '../core/raster';
import { diffHeatmap } from '../metrics/diffMap';
import { computeMetrics } from '../metrics/fidelity';
import { autotune, comparisonBackground, type AvailableTracers } from '../tuner/autotune';

export interface HandlerDeps {
  tracers: Record<Engine, Tracer>;
  now: () => number;
  yieldToEvents: () => Promise<void>;
}

export type Post = (res: WorkerResponse) => void;

export interface Handler {
  /** Queues `req` (FIFO); 'cancel' takes effect immediately. Never throws. */
  handle(req: WorkerRequest, post: Post): void;
  /** Resolves once nothing is queued or running. */
  idle(): Promise<void>;
}

export const TRACE_MEMO_SIZE = 4;

const ENGINES: readonly Engine[] = ['potrace', 'vtracer'];
const CANCELLABLE: ReadonlySet<WorkerRequest['type']> = new Set<WorkerRequest['type']>(['trace', 'tune', 'compare']);

const NO_SOURCE = 'no hay ninguna imagen cargada; carga una imagen primero.';
const DEAD =
  'El procesador de imágenes sufrió un error grave y se está reiniciando; vuelve a intentarlo en un momento.';
const OP_LABEL: Record<WorkerRequest['type'], string> = {
  init: 'No se pudieron iniciar los motores de trazado',
  setSource: 'No se pudo analizar la imagen',
  classify: 'No se pudo clasificar la imagen',
  trace: 'No se pudo vectorizar la imagen',
  tune: 'No se pudo completar el ajuste automático',
  compare: 'No se pudo comparar el resultado con la imagen original',
  cancel: 'No se pudo cancelar la operación',
};

/** Messages of the emscripten runtime once it is unusable: abort(), exit() or a wasm trap. */
const FATAL_RE = /Aborted\(|Program terminated with exit\(|RuntimeError|unreachable|memory access out of bounds/i;

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : String(e);
}

/** True for failures after which the wasm runtime cannot be trusted (the worker must be recreated). */
export function isFatalError(e: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) return true;
  return FATAL_RE.test(errorText(e));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

/** JSON with sorted keys and undefined entries dropped: equal params give equal keys. */
export function canonicalKey(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'undefined';
}

/** Validates a transferred RGBA payload and wraps it (no copy) as a RasterImage. */
export function rasterFromPayload(p: RasterPayload, what: string): RasterImage {
  const width = p?.width;
  const height = p?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${what}: dimensiones inválidas (${String(width)}×${String(height)})`);
  }
  const data = (p as { data?: ArrayBuffer }).data;
  const bytes = data?.byteLength;
  if (data === undefined || bytes !== width * height * 4) {
    throw new Error(`${what}: el búfer tiene ${String(bytes)} bytes y se esperaban ${width * height * 4}`);
  }
  return { data: new Uint8ClampedArray(data), width, height };
}

/** The pixels' own ArrayBuffer when the view spans it exactly, else a copy (safe to transfer). */
function ownBuffer(data: Uint8ClampedArray): ArrayBuffer {
  const buf = data.buffer;
  if (buf instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === buf.byteLength) return buf;
  return data.slice().buffer;
}

export function createHandler(deps: HandlerDeps): Handler {
  let engines: Record<Engine, boolean> | null = null;
  let available: AvailableTracers = {};
  let source: RasterImage | null = null;
  let info: SourceInfo | null = null;
  let classified: ClassifyResult | null = null;
  // traceInput of the current source, memoised (both cleared by setSource): the source with a
  // detected fake checkerboard made transparent ('auto') and analyzeSource(source, 'keep').
  let effective: RasterImage | null = null;
  let keepInfo: SourceInfo | null = null;
  const traces = new Map<string, TraceResult>();
  const queue: Array<{ req: WorkerRequest; post: Post }> = [];
  const cancelled = new Set<number>();
  let running: WorkerRequest | null = null;
  let pumping = false;
  let fatal = false;
  const idleWaiters: Array<() => void> = [];

  function safePost(post: Post, res: WorkerResponse): void {
    try {
      post(res);
    } catch {
      // The channel is gone (worker closing); nothing else to tell.
    }
  }

  async function initEngines(vtracerSource: string | null): Promise<Record<Engine, boolean>> {
    const status: Record<Engine, boolean> = { potrace: false, vtracer: false };
    const next: AvailableTracers = {};
    for (const engine of ENGINES) {
      const tracer = deps.tracers[engine] as Tracer | undefined;
      if (tracer === undefined) continue;
      try {
        if (engine === 'vtracer' && vtracerSource !== null) await tracer.init(vtracerSource);
        else await tracer.init();
        status[engine] = true;
        next[engine] = tracer;
      } catch {
        status[engine] = false;
      }
    }
    engines = status;
    available = next;
    traces.clear(); // availability decides engine fallbacks
    return { ...status };
  }

  async function ensureEngines(): Promise<void> {
    if (engines === null) await initEngines(null);
  }

  function requireSource(): { img: RasterImage; info: SourceInfo } {
    if (source === null || info === null) throw new Error(NO_SOURCE);
    return { img: source, info };
  }

  /**
   * The analysis trace() uses for `setting` (pipeline.traceInput, memoised): the source's own, or
   * analyzeSource(source, 'keep') when it applied a fake checkerboard that 'keep' must trace as painted.
   */
  function analysisFor(setting: unknown): SourceInfo {
    const s = requireSource();
    if (setting !== 'keep' || (s.info.bakedBackground ?? null) === null) return s.info;
    keepInfo ??= analyzeSource(s.img, 'keep');
    return keepInfo;
  }

  /** The pixels trace() works on for `setting` and their analysis (pipeline.traceInput, memoised). */
  function inputFor(setting: unknown): { image: RasterImage; info: SourceInfo } {
    const s = requireSource();
    const analysis = analysisFor(setting);
    if (setting === 'keep' || (s.info.bakedBackground ?? null) === null) return { image: s.img, info: analysis };
    effective ??= effectiveSource(s.img, s.info, { bakedBackground: 'auto' });
    return { image: effective, info: analysis };
  }

  function remember(key: string, r: TraceResult): void {
    traces.delete(key);
    traces.set(key, r);
    while (traces.size > TRACE_MEMO_SIZE) {
      const oldest = traces.keys().next();
      if (oldest.done === true) break;
      traces.delete(oldest.value);
    }
  }

  async function run(req: WorkerRequest, post: Post): Promise<void> {
    switch (req.type) {
      case 'init': {
        const status = await initEngines(typeof req.vtracerWasmUrl === 'string' ? req.vtracerWasmUrl : null);
        post({ type: 'ready', id: req.id, engines: status });
        return;
      }
      case 'setSource': {
        const img = rasterFromPayload(req.image, 'imagen');
        const nextInfo = analyzeSource(img);
        source = img;
        info = nextInfo;
        classified = null;
        effective = null;
        keepInfo = null;
        traces.clear();
        post({ type: 'sourceSet', id: req.id, info: nextInfo });
        return;
      }
      case 'classify': {
        const s = requireSource();
        if (classified === null) classified = classify(s.info);
        post({ type: 'classified', id: req.id, result: classified });
        return;
      }
      case 'trace': {
        const s = requireSource();
        await ensureEngines();
        const key = canonicalKey(req.params);
        let r = traces.get(key);
        if (r === undefined) {
          // The memoised 'keep' analysis spares trace() re-analysing the source on every request.
          const analysis = analysisFor(req.params?.bakedBackground);
          r = await trace(s.img, req.params, available as Record<Engine, Tracer>, analysis);
        }
        remember(key, r);
        if (cancelled.has(req.id)) {
          post({ type: 'cancelled', id: req.id });
          return;
        }
        post({ type: 'traced', id: req.id, svg: r.svg, stats: r.stats, resolved: r.resolved, warnings: r.warnings, ms: r.ms });
        return;
      }
      case 'tune': {
        const s = requireSource();
        await ensureEngines();
        const id = req.id;
        const budgetMs = typeof req.budgetMs === 'number' && req.budgetMs >= 0 ? req.budgetMs : 0;
        const r = await autotune(s.img, analysisFor(req.params?.bakedBackground), req.params, available, {
          budgetMs,
          now: deps.now,
          yieldToEvents: deps.yieldToEvents,
          isCancelled: () => cancelled.has(id),
          onProgress: (progress) => {
            if (!cancelled.has(id)) post({ type: 'progress', id, progress });
          },
        });
        if (r === null || cancelled.has(id)) {
          post({ type: 'cancelled', id });
          return;
        }
        post({
          type: 'tuned',
          id,
          params: r.params,
          svg: r.svg,
          stats: r.stats,
          resolved: r.resolved,
          score: r.score,
          warnings: r.warnings,
          ms: r.ms,
          baseline: r.baseline,
          tuned: r.tuned,
        });
        return;
      }
      case 'compare': {
        const s = requireSource();
        const rendered = rasterFromPayload(req.rendered, 'imagen renderizada');
        if (rendered.width !== s.img.width || rendered.height !== s.img.height) {
          throw new Error(
            `la imagen renderizada mide ${rendered.width}×${rendered.height} px y la original ` +
              `${s.img.width}×${s.img.height} px`,
          );
        }
        // The pixels the trace was made from (a fake checkerboard is transparent unless 'keep'), both
        // images composited on the background the SVG shows: the painted checkerboard is not fidelity.
        const input = inputFor(req.bakedBackground);
        const background = comparisonBackground(input.image, input.info, req.mode, req.background);
        const metrics = computeMetrics({
          original: input.image,
          rendered,
          mode: req.mode,
          background,
          thresholdNorm: req.thresholdNorm,
        });
        const diff = diffHeatmap(compositeOnColor(input.image, background), compositeOnColor(rendered, background));
        if (cancelled.has(req.id)) {
          post({ type: 'cancelled', id: req.id });
          return;
        }
        post({
          type: 'compared',
          id: req.id,
          metrics,
          diffMap: { data: ownBuffer(diff.data), width: diff.width, height: diff.height },
        });
        return;
      }
      case 'cancel':
        return;
    }
  }

  function notifyIdle(): void {
    if (pumping || queue.length > 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        await deps.yieldToEvents(); // let queued 'cancel' messages land before starting the next request
        const next = queue.shift();
        if (next === undefined) break;
        const { req, post } = next;
        if (fatal) {
          safePost(post, { type: 'error', id: req.id, message: DEAD });
          continue;
        }
        running = req;
        try {
          await run(req, post);
        } catch (e) {
          const message = `${OP_LABEL[req.type] ?? 'Error'}: ${errorText(e)}`;
          if (isFatalError(e)) {
            fatal = true;
            safePost(post, { type: 'fatal', id: req.id, message });
          } else {
            safePost(post, { type: 'error', id: req.id, message });
          }
        } finally {
          cancelled.delete(req.id);
          running = null;
        }
      }
    } finally {
      pumping = false;
      notifyIdle();
    }
  }

  function cancel(target: number): void {
    const i = queue.findIndex((q) => q.req.id === target);
    if (i >= 0) {
      const q = queue[i];
      if (!CANCELLABLE.has(q.req.type)) return;
      queue.splice(i, 1);
      safePost(q.post, { type: 'cancelled', id: target });
      notifyIdle();
      return;
    }
    if (running !== null && running.id === target && CANCELLABLE.has(running.type)) cancelled.add(target);
  }

  function handle(req: WorkerRequest, post: Post): void {
    try {
      if (req.type === 'cancel') {
        cancel(req.target);
        return;
      }
      queue.push({ req, post });
      void pump();
    } catch (e) {
      const id = (req as { id?: unknown } | null)?.id;
      safePost(post, { type: 'error', id: typeof id === 'number' ? id : -1, message: `Petición no válida: ${errorText(e)}` });
    }
  }

  return {
    handle,
    idle: () => (pumping || queue.length > 0 ? new Promise<void>((resolve) => idleWaiters.push(resolve)) : Promise.resolve()),
  };
}
