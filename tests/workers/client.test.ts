/**
 * WorkerClient against an in-process fake Worker that runs the real handler with structured clone,
 * transfer (buffers get detached like with postMessage) and asynchronous delivery, so the client's
 * contract with the UI is checked in Node: copies, latest-wins, the lazy tune worker, crash recovery
 * and terminate.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AbsPath, Engine, RasterImage, RGB, Tracer } from '../../src/types';
import { MAX_CONSECUTIVE_CRASHES, WorkerClient } from '../../src/workers/client';
import { createHandler } from '../../src/workers/handler';
import { responseTransferables, type TuneProgress, type WorkerRequest, type WorkerResponse } from '../../src/workers/protocol';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { aaCircle, bakedCheckerLogo, flatShapes3, glyph } from '../../src/dev/synth';
import { parseSvg, renderAt1x } from '../fixtures/svgBack';

const WASM = path.join(process.cwd(), 'node_modules/vtracer-web/vtracer.wasm');
const WHITE: RGB = [255, 255, 255];
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function realTracers(): Record<Engine, Tracer> {
  return { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };
}

let tracerFactory: () => Record<Engine, Tracer> = realTracers;

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  terminated = false;
  readonly received: WorkerRequest[] = [];
  private readonly handler = createHandler({ tracers: tracerFactory(), now: () => performance.now(), yieldToEvents: tick });

  readonly url: URL;
  readonly options: WorkerOptions;

  constructor(url: URL, options: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeWorker.all.push(this);
  }

  postMessage(msg: WorkerRequest, transfer: Transferable[] = []): void {
    if (this.terminated) return;
    const clone = structuredClone(msg, { transfer });
    this.received.push(clone);
    setTimeout(() => {
      if (!this.terminated) this.handler.handle(clone, (res) => this.reply(res));
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** What the Worker object reports when the worker throws or fails to load. */
  crash(message: string): void {
    this.onerror?.({ message, preventDefault: () => undefined } as unknown as ErrorEvent);
  }

  private reply(res: WorkerResponse): void {
    if (this.terminated) return;
    const clone = structuredClone(res, { transfer: responseTransferables(res) });
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: clone } as MessageEvent<WorkerResponse>);
    }, 0);
  }
}

function imageData(img: RasterImage): ImageData {
  return new ImageData(img.data.slice(), img.width, img.height);
}

const clients: WorkerClient[] = [];
function newClient(): WorkerClient {
  const c = new WorkerClient();
  clients.push(c);
  return c;
}

beforeAll(async () => {
  await createVtracerTracer().init(readFileSync(WASM));
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  for (const c of clients.splice(0)) c.terminate();
  FakeWorker.all = [];
  tracerFactory = realTracers;
});

describe('WorkerClient: trace worker', () => {
  it('ready → setSource → classify → trace → compare, copying every ImageData', async () => {
    const client = newClient();
    expect(await client.ready()).toEqual({ potrace: true, vtracer: true });
    expect(FakeWorker.all).toHaveLength(1);
    expect(String(FakeWorker.all[0].url)).toMatch(/\/src\/workers\/trace\.worker\.ts$/);
    expect(FakeWorker.all[0].options).toEqual({ type: 'module' });

    const src = imageData(aaCircle().image);
    const info = await client.setSource(src);
    expect([info.width, info.height]).toEqual([64, 64]);
    expect(src.data.byteLength).toBe(64 * 64 * 4); // not detached: the caller keeps its pixels
    expect(src.data[0]).toBe(255);

    expect((await client.classify()).mode).toBe('lines');
    const out = await client.trace({});
    expect(out).not.toBeNull();
    expect(out?.resolved.mode).toBe('lines');
    expect(out?.svg).toContain('<path');

    const rendered = imageData(renderAt1x(parseSvg(out?.svg ?? ''), WHITE));
    const cmp = await client.compare(rendered, 'lines');
    expect(cmp?.metrics.fidelity).toBeGreaterThanOrEqual(0.97);
    expect(cmp?.diffMap).toBeInstanceOf(ImageData);
    expect([cmp?.diffMap.width, cmp?.diffMap.height, cmp?.diffMap.data.length]).toEqual([64, 64, 64 * 64 * 4]);
    expect(rendered.data.byteLength).toBe(64 * 64 * 4);

    const ids = FakeWorker.all[0].received.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('latest-wins: a newer trace or compare resolves the previous one with null and cancels it', async () => {
    const client = newClient();
    await client.setSource(imageData(glyph().image));
    const first = client.trace({ mode: 'lines', upscale: 4 });
    const second = client.trace({ mode: 'lines', upscale: 2 });
    expect(await first).toBeNull();
    expect((await second)?.resolved.upscale).toBe(2);

    const w = FakeWorker.all[0];
    const traces = w.received.filter((m) => m.type === 'trace');
    const cancels = w.received.filter((m) => m.type === 'cancel');
    expect(cancels).toEqual([{ type: 'cancel', id: expect.any(Number), target: traces[0].id }]);

    const rendered = imageData(glyph().image);
    const c1 = client.compare(rendered, 'lines');
    const c2 = client.compare(rendered, 'lines');
    expect(await c1).toBeNull();
    expect((await c2)?.metrics.fidelity).toBeCloseTo(1, 6);
  });

  it('compare(rendered, mode, resolved) measures against the source the trace used and sends only the given target', async () => {
    const client = newClient();
    const { image } = bakedCheckerLogo({ cell: 10 });
    await client.setSource(imageData(image));
    const out = await client.trace({ engine: 'potrace' });
    const resolved = out?.resolved;
    if (out === null || resolved === undefined) throw new Error('sin trazado');
    expect(out.warnings[0]?.code).toBe('baked-checkerboard');
    const rendered = imageData(renderAt1x(parseSvg(out.svg), null));
    expect((await client.compare(rendered, resolved.mode, resolved))?.metrics.fidelity).toBeGreaterThanOrEqual(0.97);
    expect((await client.compare(imageData(image), resolved.mode, { bakedBackground: 'keep' }))?.metrics.pctDiff16).toBe(0);
    expect((await client.compare(rendered, resolved.mode))?.metrics.fidelity).toBeGreaterThanOrEqual(0.97);

    const sent = FakeWorker.all[0].received.flatMap((m) => (m.type === 'compare' ? [m] : []));
    expect(sent.map((m) => [m.bakedBackground, m.background])).toEqual([
      ['auto', 'auto'],
      ['keep', undefined],
      [undefined, undefined],
    ]);
    expect('bakedBackground' in sent[2] || 'background' in sent[2]).toBe(false);
  });

  it('worker errors reject with their Spanish message and the client keeps working', async () => {
    const client = newClient();
    await expect(client.trace({})).rejects.toThrow(/no hay ninguna imagen cargada/);
    await client.setSource(imageData(aaCircle().image));
    await expect(client.compare(imageData(glyph().image), 'lines')).rejects.toThrow(/48×48 px y la original 64×64 px/);
    expect((await client.trace({}))?.svg).toContain('<path');
  });
});

describe('WorkerClient: tune worker', () => {
  it('runs on a lazily spawned second worker that receives the source; progress; cancelTune and supersede give null', async () => {
    const client = newClient();
    await client.setSource(imageData(flatShapes3().image));
    const events: TuneProgress[] = [];
    const tuned = await client.tune({}, 60_000, (p) => events.push(p));
    expect(tuned).not.toBeNull();
    expect(FakeWorker.all).toHaveLength(2);
    const tuneWorker = FakeWorker.all[1];
    expect(tuneWorker.received.map((m) => m.type)).toEqual(['init', 'setSource', 'tune']);
    expect(events.length).toBeGreaterThan(36);
    expect(events[events.length - 1].best?.score).toBe(tuned?.score);
    // Before -> after for the UI: the result's summary is its own stats; the baseline is trace({}).
    expect(tuned?.tuned).toEqual({
      fidelity: expect.any(Number),
      cornerFraction: tuned?.stats.cornerFraction,
      nodeCount: tuned?.stats.nodeCount,
      bytes: tuned?.stats.bytes,
    });
    expect(tuned?.tuned.fidelity ?? 0).toBeGreaterThanOrEqual((tuned?.baseline.fidelity ?? 1) - 0.005);
    const baselineTrace = await client.trace({});
    expect(tuned?.baseline).toEqual({
      fidelity: expect.any(Number),
      cornerFraction: baselineTrace?.stats.cornerFraction,
      nodeCount: baselineTrace?.stats.nodeCount,
      bytes: baselineTrace?.stats.bytes,
    });
    // The tuned params reproduce the tuned SVG on the trace worker.
    expect((await client.trace(tuned?.params ?? {}))?.svg).toBe(tuned?.svg);

    const cancelled = client.tune({}, 60_000, () => client.cancelTune());
    expect(await cancelled).toBeNull();

    const older = client.tune({}, 60_000, () => undefined);
    const newer = client.tune({}, 150, () => undefined);
    expect(await older).toBeNull();
    expect(await newer).not.toBeNull();
    expect(tuneWorker.received.filter((m) => m.type === 'cancel').length).toBeGreaterThanOrEqual(2);

    await client.setSource(imageData(glyph().image));
    expect(tuneWorker.received.filter((m) => m.type === 'setSource')).toHaveLength(2);
  });
});

describe('WorkerClient: crash recovery', () => {
  it('onerror rejects only the in-flight call; the new worker gets init + source and the queued calls answer', async () => {
    const client = newClient();
    await client.ready();
    await client.setSource(imageData(glyph().image));
    const inflight = client.classify();
    const queued = client.trace({ mode: 'lines' });
    FakeWorker.all[0].crash('se cayó');
    await expect(inflight).rejects.toThrow(/se reinició \(se cayó\)/);
    expect((await queued)?.svg).toContain('<path');
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(FakeWorker.all[1].received.map((m) => m.type)).toEqual(['init', 'setSource', 'trace']);
    expect((await client.classify()).mode).toBe('lines');
  });

  it("a 'fatal' answer (potrace aborted) rejects that call and recreates the worker", async () => {
    let abortsLeft = 1;
    tracerFactory = () => {
      const real = createPotraceTracer();
      const potrace: Tracer = {
        name: 'potrace',
        init: (s) => real.init(s),
        traceBinary: async (mask, opts): Promise<AbsPath[]> => {
          if (abortsLeft > 0) {
            abortsLeft--;
            throw new Error('potrace: Aborted(OOM). Build with -sASSERTIONS for more info.');
          }
          return real.traceBinary(mask, opts);
        },
      };
      return { potrace, vtracer: createVtracerTracer() };
    };
    const client = newClient();
    await client.setSource(imageData(aaCircle().image));
    await expect(client.trace({ engine: 'potrace' })).rejects.toThrow(/No se pudo vectorizar la imagen: potrace: Aborted\(OOM\)/);
    expect(FakeWorker.all).toHaveLength(2);
    expect((await client.trace({ engine: 'potrace' }))?.svg).toContain('<path');
    expect(FakeWorker.all[1].received.map((m) => m.type)).toEqual(['init', 'setSource', 'trace']);
  });

  it(`gives up after ${MAX_CONSECUTIVE_CRASHES} deaths without an answer; the next call starts a fresh worker`, async () => {
    const client = newClient();
    for (let i = 0; i < MAX_CONSECUTIVE_CRASHES; i++) FakeWorker.all[FakeWorker.all.length - 1].crash(`fallo ${i}`);
    await expect(client.ready()).rejects.toThrow(new RegExp(`${MAX_CONSECUTIVE_CRASHES} veces seguidas`));
    expect(FakeWorker.all).toHaveLength(MAX_CONSECUTIVE_CRASHES);
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);

    const info = await client.setSource(imageData(glyph().image));
    expect(info.width).toBe(48);
    expect(await client.ready()).toEqual({ potrace: true, vtracer: true });
    expect(FakeWorker.all).toHaveLength(MAX_CONSECUTIVE_CRASHES + 1);
    // setSource on a fresh worker sends its own image once (no copy of an older one first).
    expect(FakeWorker.all[MAX_CONSECUTIVE_CRASHES].received.map((m) => m.type)).toEqual(['init', 'setSource']);
  });

  it('after giving up, the fresh worker of the next call gets the image on screen back', async () => {
    const client = newClient();
    await client.setSource(imageData(glyph().image));
    const w0 = FakeWorker.all[0];
    for (let i = 0; i < MAX_CONSECUTIVE_CRASHES; i++) FakeWorker.all[FakeWorker.all.length - 1].crash(`fallo ${i}`);
    expect(FakeWorker.all).toHaveLength(MAX_CONSECUTIVE_CRASHES);
    expect(w0.terminated).toBe(true);

    const out = await client.trace({ mode: 'lines' });
    expect(out?.svg).toContain('<path');
    expect(out?.resolved.mode).toBe('lines');
    const fresh = FakeWorker.all[MAX_CONSECUTIVE_CRASHES];
    expect(fresh.received.map((m) => m.type)).toEqual(['init', 'setSource', 'trace']);
    const sent = fresh.received[1];
    expect(sent.type === 'setSource' ? [sent.image.width, sent.image.height] : null).toEqual([48, 48]);
  });
});

describe('WorkerClient: terminate', () => {
  it('pending trace/tune/compare resolve null, other calls reject, later calls reject', async () => {
    const client = newClient();
    await client.setSource(imageData(glyph().image));
    const t = client.trace({});
    const tu = client.tune({}, 60_000, () => undefined);
    const c = client.classify();
    client.terminate();
    expect(await t).toBeNull();
    expect(await tu).toBeNull();
    await expect(c).rejects.toThrow(/cerrado/);
    await expect(client.trace({})).rejects.toThrow(/cerrado/);
    await expect(client.setSource(imageData(glyph().image))).rejects.toThrow(/cerrado/);
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
  });
});
