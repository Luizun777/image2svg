/**
 * Main-thread client of the trace workers (contract shared with the UI; see ARCHITECTURE.md, "Worker").
 *
 * - One trace worker, spawned by the constructor (init → ready()); a second worker for tune(),
 *   spawned lazily and fed a copy of the source, so tuning never blocks trace/compare.
 * - Monotonic ids shared by both workers. Latest-wins per channel (trace, compare, tune): a newer
 *   call resolves the previous one with null at once and sends {type:'cancel'} for it.
 * - Every ImageData is copied (the caller keeps its pixels) and each send transfers a fresh copy.
 * - Crash recovery: a worker that dies (onerror / onmessageerror) or reports 'fatal' (potrace aborted
 *   or called exit) is terminated and recreated, re-initialised and given back its last source; only
 *   the call it was running is rejected, the requests queued behind it are re-sent. After
 *   MAX_CONSECUTIVE_CRASHES deaths without a single answer in between the client gives up on that
 *   worker (pending calls reject) and the next call spawns a fresh one.
 * - Errors reject with Error(message in Spanish).
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
import {
  requestTransferables,
  type TuneProgress,
  type TuneSummary,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol';

export type { TuneSummary };

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

/** Consecutive worker deaths, without any answer in between, before giving up on that worker. */
export const MAX_CONSECUTIVE_CRASHES = 3;

type Kind = 'trace' | 'tune';
type Channel = 'trace' | 'tune' | 'compare';

const CLOSED = 'El procesador de imágenes está cerrado.';
const CANCELLED = 'La operación se canceló.';
const START_FAILED = 'No se pudo iniciar el procesador de imágenes';

interface SourceCopy {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

interface Call {
  readonly id: number;
  readonly type: WorkerRequest['type'];
  /** Builds the message, with fresh transferable buffers, for every (re)send. */
  readonly make: () => WorkerRequest;
  readonly source: SourceCopy | undefined;
  readonly onProgress: ((p: TuneProgress) => void) | undefined;
  settled: boolean;
  finish(res: WorkerResponse): void;
  fail(err: Error): void;
  /** Superseded / cancelled / closed: null for nullable calls, a rejection otherwise. */
  drop(err?: Error): void;
}

interface Slot {
  readonly kind: Kind;
  readonly worker: Worker;
  /** Sent and not yet answered, in send order (includes superseded calls awaiting their ack). */
  readonly calls: Map<number, Call>;
  crashes: number;
  /** Last source this worker confirmed (sourceSet). */
  source: SourceCopy | null;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  settled: boolean;
  resolve(v: T): void;
  reject(e: Error): void;
}

function deferred<T>(): Deferred<T> {
  let res!: (v: T) => void;
  let rej!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    res = a;
    rej = b;
  });
  promise.catch(() => undefined); // a rejection nobody awaits is not an unhandled rejection
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve(v) {
      if (d.settled) return;
      d.settled = true;
      res(v);
    },
    reject(e) {
      if (d.settled) return;
      d.settled = true;
      rej(e);
    },
  };
  return d;
}

/** Vite needs this literal form to bundle the worker. */
function createWorker(): Worker {
  return new Worker(new URL('./trace.worker.ts', import.meta.url), { type: 'module' });
}

function toError(e: unknown, prefix: string): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(`${prefix}: ${msg}`);
}

function unexpected(res: WorkerResponse): Error {
  return new Error(`Respuesta inesperada del procesador de imágenes ("${String(res.type)}").`);
}

function sourceRequest(id: number, copy: SourceCopy): WorkerRequest {
  return { type: 'setSource', id, image: { data: copy.data.slice().buffer, width: copy.width, height: copy.height } };
}

export class WorkerClient {
  private nextId = 1;
  private readonly slots: Record<Kind, Slot | null> = { trace: null, tune: null };
  private readonly latest: Record<Channel, { kind: Kind; call: Call } | null> = { trace: null, tune: null, compare: null };
  private source: SourceCopy | null = null;
  private readyState: Deferred<Record<Engine, boolean>> = deferred();
  private readyFailed = false;
  private closed = false;

  constructor() {
    try {
      this.slot('trace');
    } catch (e) {
      this.readyState.reject(toError(e, START_FAILED));
      this.readyFailed = true;
    }
  }

  /** Resolves when the trace worker initialised; an engine set to false is unavailable. */
  ready(): Promise<Record<Engine, boolean>> {
    return this.readyState.promise;
  }

  /** Copies `img` (the caller keeps it) and sends it to every live worker. */
  setSource(img: ImageData): Promise<SourceInfo> {
    if (this.closed) return Promise.reject(new Error(CLOSED));
    const copy: SourceCopy = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
    let slot: Slot;
    try {
      slot = this.slot('trace', false);
    } catch (e) {
      return Promise.reject(toError(e, START_FAILED));
    }
    this.source = copy;
    const { call, promise } = this.sourceCall(copy);
    this.send(slot, call);
    const tune = this.slots.tune;
    if (tune !== null) this.send(tune, this.sourceCall(copy).call);
    return promise as Promise<SourceInfo>;
  }

  classify(): Promise<ClassifyResult> {
    if (this.closed) return Promise.reject(new Error(CLOSED));
    let slot: Slot;
    try {
      slot = this.slot('trace');
    } catch (e) {
      return Promise.reject(toError(e, START_FAILED));
    }
    const { call, promise } = this.newCall<ClassifyResult>(
      'classify',
      (id) => ({ type: 'classify', id }),
      (res) => {
        if (res.type !== 'classified') throw unexpected(res);
        return res.result;
      },
      { nullable: false },
    );
    this.send(slot, call);
    return promise as Promise<ClassifyResult>;
  }

  /** Latest-wins: resolves null when superseded by a newer trace(). */
  trace(params: TraceParams): Promise<TraceOutput | null> {
    let snapshot: TraceParams;
    try {
      snapshot = structuredClone(params);
    } catch (e) {
      return Promise.reject(toError(e, 'Parámetros no válidos'));
    }
    return this.latestWins<TraceOutput>(
      'trace',
      'trace',
      'trace',
      (id) => ({ type: 'trace', id, params: snapshot }),
      (res) => {
        if (res.type !== 'traced') throw unexpected(res);
        return { svg: res.svg, stats: res.stats, resolved: res.resolved, warnings: res.warnings, ms: res.ms };
      },
    );
  }

  /** Runs on the second worker; resolves null when cancelled or superseded by a newer tune(). */
  tune(params: TraceParams, budgetMs: number, onProgress: (p: TuneProgress) => void): Promise<TuneOutput | null> {
    let snapshot: TraceParams;
    try {
      snapshot = structuredClone(params);
    } catch (e) {
      return Promise.reject(toError(e, 'Parámetros no válidos'));
    }
    return this.latestWins<TuneOutput>(
      'tune',
      'tune',
      'tune',
      (id) => ({ type: 'tune', id, params: snapshot, budgetMs }),
      (res) => {
        if (res.type !== 'tuned') throw unexpected(res);
        return {
          svg: res.svg,
          stats: res.stats,
          resolved: res.resolved,
          warnings: res.warnings,
          ms: res.ms,
          params: res.params,
          score: res.score,
          baseline: res.baseline,
          tuned: res.tuned,
        };
      },
      onProgress,
    );
  }

  cancelTune(): void {
    this.supersede('tune');
  }

  /**
   * Latest-wins; `rendered` is copied. `target` (the resolved params of the measured trace) says what
   * it is compared with: bakedBackground 'auto' (default) the source with a detected fake checkerboard
   * transparent, 'keep' the original pixels; in flat mode an opaque `background` is what both images
   * are composited on.
   */
  compare(rendered: ImageData, mode: ConcreteMode, target?: CompareTarget): Promise<CompareOutput | null> {
    if (this.closed) return Promise.reject(new Error(CLOSED));
    let bakedBackground: BakedBackgroundSetting | undefined;
    let background: BackgroundSetting | undefined;
    try {
      bakedBackground = target?.bakedBackground;
      background = target?.background === undefined ? undefined : structuredClone(target.background);
    } catch (e) {
      return Promise.reject(toError(e, 'Parámetros no válidos'));
    }
    const copy = new Uint8ClampedArray(rendered.data);
    const { width, height } = rendered;
    return this.latestWins<CompareOutput>(
      'compare',
      'trace',
      'compare',
      (id) => {
        const msg: Extract<WorkerRequest, { type: 'compare' }> = {
          type: 'compare',
          id,
          rendered: { data: copy.slice().buffer, width, height },
          mode,
        };
        if (bakedBackground !== undefined) msg.bakedBackground = bakedBackground;
        if (background !== undefined) msg.background = structuredClone(background);
        return msg;
      },
      (res) => {
        if (res.type !== 'compared') throw unexpected(res);
        const d = res.diffMap;
        return { metrics: res.metrics, diffMap: new ImageData(new Uint8ClampedArray(d.data), d.width, d.height) };
      },
    );
  }

  /** Terminates both workers: pending trace/tune/compare resolve null, other calls reject. */
  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(CLOSED);
    for (const kind of ['trace', 'tune'] as const) {
      const slot = this.slots[kind];
      if (slot === null) continue;
      this.slots[kind] = null;
      slot.worker.terminate();
      for (const call of slot.calls.values()) call.drop(err);
      slot.calls.clear();
    }
    this.latest.trace = null;
    this.latest.tune = null;
    this.latest.compare = null;
    this.readyState.reject(err);
  }

  // -------------------------------------------------------------------------------------------

  private newCall<T>(
    type: WorkerRequest['type'],
    make: (id: number) => WorkerRequest,
    map: (res: WorkerResponse) => T,
    opts: { nullable: boolean; source?: SourceCopy; onProgress?: (p: TuneProgress) => void },
  ): { call: Call; promise: Promise<T | null> } {
    const id = this.nextId++;
    let resolve!: (v: T | null) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<T | null>((a, b) => {
      resolve = a;
      reject = b;
    });
    const call: Call = {
      id,
      type,
      make: () => make(id),
      source: opts.source,
      onProgress: opts.onProgress,
      settled: false,
      finish(res) {
        if (call.settled) return;
        call.settled = true;
        try {
          resolve(map(res));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
      fail(err) {
        if (call.settled) return;
        call.settled = true;
        reject(err);
      },
      drop(err) {
        if (call.settled) return;
        call.settled = true;
        if (opts.nullable) resolve(null);
        else reject(err ?? new Error(CANCELLED));
      },
    };
    return { call, promise };
  }

  private sourceCall(copy: SourceCopy): { call: Call; promise: Promise<SourceInfo | null> } {
    const created = this.newCall<SourceInfo>(
      'setSource',
      (id) => sourceRequest(id, copy),
      (res) => {
        if (res.type !== 'sourceSet') throw unexpected(res);
        return res.info;
      },
      { nullable: false, source: copy },
    );
    created.promise.catch(() => undefined); // internal copies (tune worker, recovery) have no caller
    return created;
  }

  private latestWins<T>(
    channel: Channel,
    kind: Kind,
    type: WorkerRequest['type'],
    make: (id: number) => WorkerRequest,
    map: (res: WorkerResponse) => T,
    onProgress?: (p: TuneProgress) => void,
  ): Promise<T | null> {
    if (this.closed) return Promise.reject(new Error(CLOSED));
    this.supersede(channel);
    let slot: Slot;
    try {
      slot = this.slot(kind);
    } catch (e) {
      return Promise.reject(toError(e, START_FAILED));
    }
    const { call, promise } = this.newCall<T>(type, make, map, { nullable: true, onProgress });
    this.latest[channel] = { kind, call };
    this.send(slot, call);
    return promise;
  }

  /** Resolves the channel's pending call with null and tells its worker to drop it. */
  private supersede(channel: Channel): void {
    const prev = this.latest[channel];
    this.latest[channel] = null;
    if (prev === null || prev.call.settled) return;
    prev.call.drop();
    const slot = this.slots[prev.kind];
    if (slot === null || !slot.calls.has(prev.call.id)) return;
    try {
      slot.worker.postMessage({ type: 'cancel', id: this.nextId++, target: prev.call.id } satisfies WorkerRequest);
    } catch {
      // The worker is gone; recovery handles it.
    }
  }

  private send(slot: Slot, call: Call): void {
    let msg: WorkerRequest;
    try {
      msg = call.make();
    } catch (e) {
      call.fail(toError(e, 'No se pudo preparar la petición'));
      return;
    }
    slot.calls.set(call.id, call);
    try {
      slot.worker.postMessage(msg, requestTransferables(msg));
    } catch (e) {
      slot.calls.delete(call.id);
      call.fail(toError(e, 'No se pudo enviar la petición al procesador de imágenes'));
    }
  }

  /**
   * The live worker for `kind`, spawning one when there is none: the tune worker on first use, or
   * any worker after the client gave up on the previous one. A spawned worker is given the current
   * source (unless the caller is about to send a new one), so it answers for the image on screen
   * instead of "no hay ninguna imagen cargada".
   */
  private slot(kind: Kind, withSource = true): Slot {
    const existing = this.slots[kind];
    if (existing !== null) return existing;
    const slot = this.spawn(kind, 0);
    if (withSource && this.source !== null) this.send(slot, this.sourceCall(this.source).call);
    return slot;
  }

  /** New worker for `kind`, with its init request already sent. Throws when Worker creation fails. */
  private spawn(kind: Kind, crashes: number): Slot {
    if (kind === 'trace' && this.readyFailed) {
      this.readyState = deferred();
      this.readyFailed = false;
    }
    const worker = createWorker();
    const slot: Slot = { kind, worker, calls: new Map(), crashes, source: null };
    this.slots[kind] = slot;
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      this.onMessage(slot, ev.data);
    };
    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault();
      this.recover(slot, ev.message || 'error sin detalles', null);
    };
    worker.onmessageerror = () => {
      this.recover(slot, 'mensaje ilegible', null);
    };
    const init = this.newCall<Record<Engine, boolean>>(
      'init',
      (id) => ({ type: 'init', id, vtracerWasmUrl: null }),
      (res) => {
        if (res.type !== 'ready') throw unexpected(res);
        return res.engines;
      },
      { nullable: false },
    );
    init.promise.then(
      (engines) => {
        if (kind === 'trace' && engines !== null) this.readyState.resolve(engines);
      },
      () => undefined,
    );
    this.send(slot, init.call);
    return slot;
  }

  private onMessage(slot: Slot, res: WorkerResponse): void {
    if (this.slots[slot.kind] !== slot || res === null || typeof res !== 'object') return;
    const call = slot.calls.get(res.id);
    if (call === undefined) return;
    if (res.type === 'progress') {
      if (!call.settled && call.onProgress !== undefined) {
        try {
          call.onProgress(res.progress);
        } catch (e) {
          console.error(e);
        }
      }
      return;
    }
    slot.calls.delete(res.id);
    if (res.type === 'fatal') {
      call.fail(new Error(res.message));
      this.recover(slot, res.message, call);
      return;
    }
    slot.crashes = 0;
    if (res.type === 'sourceSet' && call.source !== undefined) slot.source = call.source;
    if (res.type === 'error') call.fail(new Error(res.message));
    else if (res.type === 'cancelled') call.drop();
    else call.finish(res);
  }

  /**
   * Replaces a dead worker. `failed` is the call it reported as fatal; after onerror it is the oldest
   * unanswered call (the worker handles requests in order, so that is the one it was running).
   */
  private recover(slot: Slot, message: string, failed: Call | null): void {
    if (this.slots[slot.kind] !== slot) return;
    this.slots[slot.kind] = null;
    slot.worker.terminate();
    const pending = [...slot.calls.values()];
    slot.calls.clear();
    const inflight = failed ?? pending.shift() ?? null;
    if (failed === null && inflight !== null) {
      inflight.fail(new Error(`El procesador de imágenes falló y se reinició (${message}).`));
    }

    // A source that was being analysed when the worker died is not sent again (neither now nor to a
    // fresh worker after giving up): later requests fail with "no hay imagen" instead of looping on
    // it or silently using the previous image.
    let source = slot.source;
    if (inflight !== null && inflight.type === 'setSource') {
      source = null;
      if (this.source === inflight.source) this.source = null;
    }

    const crashes = slot.crashes + 1;
    if (crashes >= MAX_CONSECUTIVE_CRASHES) {
      const err = new Error(`El procesador de imágenes falló ${crashes} veces seguidas y se detuvo (${message}).`);
      for (const c of pending) c.fail(err);
      if (slot.kind === 'trace' && !this.readyState.settled) {
        this.readyState.reject(err);
        this.readyFailed = true;
      }
      return;
    }

    let next: Slot;
    try {
      next = this.spawn(slot.kind, crashes);
    } catch (e) {
      const err = toError(e, 'No se pudo reiniciar el procesador de imágenes');
      for (const c of pending) c.fail(err);
      return;
    }
    const resend = pending.filter((c) => !c.settled && c.type !== 'init');
    if (source !== null && (resend.length === 0 || resend[0].type !== 'setSource')) {
      this.send(next, this.sourceCall(source).call);
    }
    for (const c of resend) this.send(next, c);
  }
}
