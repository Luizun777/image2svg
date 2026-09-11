/**
 * Structural contract of the worker client as the UI consumes it. It mirrors exactly the public
 * surface of `src/workers/client.ts` (implemented in parallel) without importing that module, so
 * the UI compiles on its own and can be driven by any object with this shape (a fake in tests,
 * the real `WorkerClient` in `main.ts`). Keep both in sync.
 *
 * Semantics the UI relies on:
 * - `trace()` and `compare()` are latest-wins: they resolve to `null` when a newer call of the
 *   same kind superseded them. `tune()` resolves to `null` when cancelled or superseded.
 * - `setSource()` copies the ImageData, so the caller keeps using its own copy.
 * - Errors reject with `Error(message in Spanish)`. A dead worker is recreated by the client and
 *   only the in-flight call rejects.
 */
import type {
  ClassifyResult,
  ConcreteMode,
  Engine,
  Metrics,
  PathStats,
  ResolvedParams,
  SourceInfo,
  TraceParams,
  Warning,
} from '../types';
import type { TuneProgress, TuneSummary } from '../workers/protocol';

export type { TuneProgress, TuneSummary };

export interface TraceOutput {
  svg: string;
  stats: PathStats;
  resolved: ResolvedParams;
  warnings: Warning[];
  ms: number;
}

export interface TuneOutput extends TraceOutput {
  params: TraceParams;
  score: number;
  /** The params given to tune(), measured by the tuner (fidelity against the effective source, SVG size). */
  baseline: TuneSummary;
  /** The returned trace, measured the same way. */
  tuned: TuneSummary;
}

/** What compare() measures against: pass the resolved params of the trace being measured. */
export type CompareTarget = Pick<TraceParams, 'bakedBackground' | 'background'>;

export interface CompareOutput {
  metrics: Metrics;
  diffMap: ImageData;
}

export interface TraceClient {
  /** Resolves when the trace worker initialised; an engine mapped to false is unavailable. */
  ready(): Promise<Record<Engine, boolean>>;
  /** Copies `img` (the caller keeps it) and sends it to every live worker. */
  setSource(img: ImageData): Promise<SourceInfo>;
  classify(): Promise<ClassifyResult>;
  /** Latest-wins: null when superseded by a newer trace(). */
  trace(params: TraceParams): Promise<TraceOutput | null>;
  /** Runs on a second worker; null when cancelled or superseded. */
  tune(
    params: TraceParams,
    budgetMs: number,
    onProgress: (p: TuneProgress) => void,
  ): Promise<TuneOutput | null>;
  cancelTune(): void;
  /**
   * Latest-wins; `rendered` is copied. `target` (the measured trace's resolved params) decides the
   * reference: a detected fake checkerboard is transparent unless it was kept, and in flat mode an
   * opaque background is what both images are composited on. Without it the worker measures as 'auto'.
   */
  compare(rendered: ImageData, mode: ConcreteMode, target?: CompareTarget): Promise<CompareOutput | null>;
  terminate(): void;
}
