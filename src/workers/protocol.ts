/**
 * Typed message protocol between the main thread and the trace worker.
 * Every `RasterPayload.data` buffer is transferred (zero-copy); never reuse it after posting.
 */
import type {
  BackgroundSetting,
  BakedBackgroundSetting,
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

/** RGBA pixels as a transferable buffer. */
export interface RasterPayload {
  data: ArrayBuffer;
  width: number;
  height: number;
}

export type WorkerRequest =
  | { type: 'init'; id: number; vtracerWasmUrl: string | null }
  | { type: 'setSource'; id: number; image: RasterPayload }
  | { type: 'classify'; id: number }
  | { type: 'trace'; id: number; params: TraceParams }
  | { type: 'tune'; id: number; params: TraceParams; budgetMs: number }
  | {
      type: 'compare';
      id: number;
      rendered: RasterPayload;
      mode: ConcreteMode;
      thresholdNorm?: number;
      /**
       * The trace's setting (default 'auto'): 'auto' compares with the effective source (a detected fake
       * checkerboard is transparent), 'keep' with the original pixels.
       */
      bakedBackground?: BakedBackgroundSetting;
      /** The trace's setting (default 'auto'): in flat mode an opaque background is what both images are composited on. */
      background?: BackgroundSetting;
    }
  | { type: 'cancel'; id: number; target: number };

export interface TuneProgress {
  stage: 'A' | 'B' | 'engine';
  done: number;
  total: number;
  best: { score: number; params: TraceParams } | null;
}

/**
 * One trace measured by the tuner (reference scanline render against the effective source): the params
 * given to tune (baseline) or its result (tuned).
 */
export interface TuneSummary {
  /** 0..1, the same fidelity computeMetrics gives. */
  fidelity: number;
  cornerFraction: number;
  nodeCount: number;
  /** UTF-8 length of the SVG. */
  bytes: number;
}

export type WorkerResponse =
  | { type: 'ready'; id: number; engines: Record<Engine, boolean> }
  | { type: 'sourceSet'; id: number; info: SourceInfo }
  | { type: 'classified'; id: number; result: ClassifyResult }
  | {
      type: 'traced';
      id: number;
      svg: string;
      stats: PathStats;
      resolved: ResolvedParams;
      warnings: Warning[];
      ms: number;
    }
  | { type: 'progress'; id: number; progress: TuneProgress }
  | {
      type: 'tuned';
      id: number;
      params: TraceParams;
      svg: string;
      stats: PathStats;
      resolved: ResolvedParams;
      score: number;
      warnings: Warning[];
      ms: number;
      /** The params given to tune, measured by the tuner. */
      baseline: TuneSummary;
      /** The tuned result, measured the same way. */
      tuned: TuneSummary;
    }
  | { type: 'compared'; id: number; metrics: Metrics; diffMap: RasterPayload }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string }
  /**
   * Request `id` failed and left the worker unusable (a wasm abort / exit / trap: potrace's runtime
   * stays aborted). The worker answers 'error' to everything after it; the client must recreate it.
   */
  | { type: 'fatal'; id: number; message: string };

export type WorkerRequestType = WorkerRequest['type'];
export type WorkerResponseType = WorkerResponse['type'];

/** Buffers to transfer for a given request, if any. */
export function requestTransferables(req: WorkerRequest): Transferable[] {
  switch (req.type) {
    case 'setSource':
      return [req.image.data];
    case 'compare':
      return [req.rendered.data];
    default:
      return [];
  }
}

/** Buffers to transfer for a given response, if any. */
export function responseTransferables(res: WorkerResponse): Transferable[] {
  return res.type === 'compared' ? [res.diffMap.data] : [];
}
