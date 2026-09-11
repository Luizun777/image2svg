/**
 * Worker handler protocol, exercised in Node with the real tracers (vtracer initialised from the wasm
 * bytes) and, for the fatal path, a fake potrace that aborts like the emscripten runtime does.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AbsPath, Engine, RasterImage, RGB, TraceParams, Tracer } from '../../src/types';
import {
  TRACE_MEMO_SIZE,
  canonicalKey,
  createHandler,
  isFatalError,
  rasterFromPayload,
  type Handler,
} from '../../src/workers/handler';
import type { RasterPayload, WorkerRequest, WorkerResponse } from '../../src/workers/protocol';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { aaCircle, bakedCheckerLogo, glyph, transparentLogo } from '../../src/dev/synth';
import { parseSvg, renderAt1x } from '../fixtures/svgBack';

const WASM = path.join(process.cwd(), 'node_modules/vtracer-web/vtracer.wasm');
const WHITE: RGB = [255, 255, 255];
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  // wasm-bindgen keeps one module-level instance: later init() calls reuse it.
  await createVtracerTracer().init(readFileSync(WASM));
});

function realTracers(): Record<Engine, Tracer> {
  return { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };
}

function payload(img: RasterImage): RasterPayload {
  return { data: img.data.slice().buffer, width: img.width, height: img.height };
}

type Of<T extends WorkerResponse['type']> = Extract<WorkerResponse, { type: T }>;

class Harness {
  readonly responses: WorkerResponse[] = [];
  readonly handler: Handler;
  constructor(tracers: Record<Engine, Tracer> = realTracers()) {
    this.handler = createHandler({ tracers, now: () => performance.now(), yieldToEvents: tick });
  }
  /** Posts are structured-cloned, as postMessage would: responses must be cloneable. */
  send(req: WorkerRequest): void {
    this.handler.handle(req, (res) => this.responses.push(structuredClone(res)));
  }
  of(id: number): WorkerResponse[] {
    return this.responses.filter((r) => r.id === id);
  }
  one<T extends WorkerResponse['type']>(id: number, type: T): Of<T> {
    const rs = this.of(id).filter((r) => r.type !== 'progress');
    expect(rs.map((r) => r.type), `respuestas de ${id}`).toEqual([type]);
    return rs[0] as Of<T>;
  }
  async until(pred: () => boolean, maxTicks = 2000): Promise<void> {
    for (let i = 0; i < maxTicks && !pred(); i++) await tick();
    expect(pred()).toBe(true);
  }
}

describe('handler: init → setSource → classify → trace → compare', () => {
  it('answers every request in order with the expected payloads', async () => {
    const h = new Harness();
    const circle = aaCircle();
    h.send({ type: 'init', id: 1, vtracerWasmUrl: null });
    h.send({ type: 'setSource', id: 2, image: payload(circle.image) });
    h.send({ type: 'classify', id: 3 });
    h.send({ type: 'trace', id: 4, params: { mode: 'auto' } });
    await h.handler.idle();

    expect(h.one(1, 'ready').engines).toEqual({ potrace: true, vtracer: true });
    const info = h.one(2, 'sourceSet').info;
    expect([info.width, info.height, info.paletteColors]).toEqual([64, 64, 2]);
    expect(h.one(3, 'classified').result.mode).toBe('lines');
    const traced = h.one(4, 'traced');
    expect(traced.svg.startsWith('<svg')).toBe(true);
    expect(traced.resolved.mode).toBe('lines');
    expect(traced.resolved.upscale).toBe(4);
    expect(traced.stats.nodeCount).toBeGreaterThan(0);
    expect(traced.stats.cornerFraction).toBe(0);
    expect(h.responses.map((r) => r.id)).toEqual([1, 2, 3, 4]);

    // compare: the SVG rendered back at 1× against the original, and the original against itself.
    const rendered = renderAt1x(parseSvg(traced.svg), WHITE);
    h.send({ type: 'compare', id: 5, rendered: payload(rendered), mode: 'lines' });
    h.send({ type: 'compare', id: 6, rendered: payload(circle.image), mode: 'lines' });
    await h.handler.idle();
    const cmp = h.one(5, 'compared');
    expect(cmp.metrics.fidelity).toBeGreaterThanOrEqual(0.97);
    expect(cmp.metrics.iou).toBeGreaterThanOrEqual(0.97);
    expect([cmp.diffMap.width, cmp.diffMap.height, cmp.diffMap.data.byteLength]).toEqual([64, 64, 64 * 64 * 4]);
    const same = h.one(6, 'compared');
    expect(same.metrics.fidelity).toBeCloseTo(1, 6);
    expect(same.metrics.pctDiff16).toBe(0);
    expect(new Uint8Array(same.diffMap.data).every((v) => v === 0)).toBe(true);
  });

  it('memoises traces by canonical params (key order and undefined entries do not matter)', async () => {
    const h = new Harness();
    h.send({ type: 'setSource', id: 1, image: payload(glyph().image) });
    h.send({ type: 'trace', id: 2, params: { mode: 'lines', upscale: 2, blurK: 0.5, invert: undefined } });
    h.send({ type: 'trace', id: 3, params: { blurK: 0.5, upscale: 2, mode: 'lines' } });
    await h.handler.idle();
    const a = h.one(2, 'traced');
    const b = h.one(3, 'traced');
    expect(b.svg).toBe(a.svg);
    expect(b.ms).toBe(a.ms); // same cached result, not a re-trace
    expect(canonicalKey({ a: 1, b: undefined, c: { y: 2, x: [1, { q: 1, p: 2 }] } })).toBe(
      canonicalKey({ c: { x: [1, { p: 2, q: 1 }], y: 2 }, a: 1 }),
    );
    expect(TRACE_MEMO_SIZE).toBeGreaterThanOrEqual(2);
  });
});

describe('handler: cancel', () => {
  it("a queued trace yields 'cancelled' and never runs; the one before it still answers", async () => {
    const h = new Harness();
    h.send({ type: 'setSource', id: 1, image: payload(glyph().image) });
    h.send({ type: 'trace', id: 2, params: { mode: 'lines', upscale: 4 } });
    h.send({ type: 'trace', id: 3, params: { mode: 'lines', upscale: 2 } });
    h.send({ type: 'cancel', id: 4, target: 3 });
    await h.handler.idle();
    h.one(2, 'traced');
    expect(h.of(3)).toEqual([{ type: 'cancelled', id: 3 }]);
    expect(h.of(4)).toEqual([]); // cancel itself has no answer
  });

  it("a running trace that finishes after its cancel answers 'cancelled' instead of 'traced'", async () => {
    // A real potrace trace resolves in microtasks, so the cancel could never land while it runs in
    // Node; this tracer waits on a timer first, like the worker's event loop would let it.
    let started = false;
    const real = createPotraceTracer();
    const slow: Tracer = {
      name: 'potrace',
      init: (source) => real.init(source),
      traceBinary: async (mask, opts) => {
        started = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return real.traceBinary(mask, opts);
      },
    };
    const h = new Harness({ potrace: slow, vtracer: createVtracerTracer() });
    h.send({ type: 'setSource', id: 1, image: payload(glyph().image) });
    h.send({ type: 'trace', id: 2, params: { mode: 'lines', engine: 'potrace' } });
    await h.until(() => started);
    h.send({ type: 'cancel', id: 3, target: 2 });
    await h.handler.idle();
    expect(h.of(2)).toEqual([{ type: 'cancelled', id: 2 }]);
  });

  it('cancelling init or setSource is ignored (state requests always run)', async () => {
    const h = new Harness();
    h.send({ type: 'setSource', id: 1, image: payload(glyph().image) });
    h.send({ type: 'classify', id: 2 });
    h.send({ type: 'cancel', id: 3, target: 1 });
    await h.handler.idle();
    h.one(1, 'sourceSet');
    h.one(2, 'classified');
  });
});

describe('handler: errors', () => {
  it("each failure answers 'error' in Spanish and the handler keeps working", async () => {
    const h = new Harness();
    h.send({ type: 'trace', id: 1, params: {} });
    h.send({ type: 'classify', id: 2 });
    h.send({ type: 'setSource', id: 3, image: { data: new ArrayBuffer(10), width: 4, height: 4 } });
    h.send({ type: 'setSource', id: 4, image: { data: new ArrayBuffer(0), width: 0, height: 4 } });
    h.send({ type: 'setSource', id: 5, image: payload(aaCircle().image) });
    h.send({ type: 'compare', id: 6, rendered: payload(glyph().image), mode: 'lines' });
    h.send({ type: 'trace', id: 7, params: {} });
    await h.handler.idle();

    for (const id of [1, 2, 3, 4, 6]) {
      const e = h.one(id, 'error');
      expect(e.message, `error ${id}`).toMatch(/^No se pudo (vectorizar|clasificar|analizar|comparar) /);
    }
    expect(h.one(1, 'error').message).toMatch(/no hay ninguna imagen cargada/);
    expect(h.one(3, 'error').message).toMatch(/10 bytes y se esperaban 64/);
    expect(h.one(6, 'error').message).toMatch(/48×48 px y la original 64×64 px/);
    h.one(5, 'sourceSet');
    expect(h.one(7, 'traced').svg).toContain('<path');
  });

  it('rasterFromPayload validates size and wraps the buffer without copying', () => {
    const buf = new ArrayBuffer(2 * 3 * 4);
    const img = rasterFromPayload({ data: buf, width: 2, height: 3 }, 'x');
    expect(img.data.buffer).toBe(buf);
    expect(() => rasterFromPayload({ data: buf, width: 3, height: 3 }, 'x')).toThrow(/24 bytes y se esperaban 36/);
    expect(() => rasterFromPayload({ data: buf, width: 2.5, height: 3 }, 'x')).toThrow(/dimensiones inválidas/);
  });

  it("a wasm abort answers 'fatal' once; every later request answers 'error'", async () => {
    let calls = 0;
    const aborting: Tracer = {
      name: 'potrace',
      init: async () => undefined,
      traceBinary: async (): Promise<AbsPath[]> => {
        calls++;
        throw new Error('potrace: Aborted(OOM). Build with -sASSERTIONS for more info.');
      },
    };
    const h = new Harness({ potrace: aborting, vtracer: createVtracerTracer() });
    h.send({ type: 'init', id: 1, vtracerWasmUrl: null });
    h.send({ type: 'setSource', id: 2, image: payload(aaCircle().image) });
    h.send({ type: 'trace', id: 3, params: { engine: 'potrace' } });
    h.send({ type: 'classify', id: 4 });
    await h.handler.idle();
    h.one(2, 'sourceSet');
    const fatal = h.one(3, 'fatal');
    expect(fatal.message).toMatch(/^No se pudo vectorizar la imagen: potrace: Aborted\(OOM\)/);
    expect(h.one(4, 'error').message).toMatch(/reiniciando/);
    expect(calls).toBe(1);
  });

  it('isFatalError: aborts, exit and wasm traps are fatal; ordinary errors are not', () => {
    expect(isFatalError(new WebAssembly.RuntimeError('unreachable'))).toBe(true);
    expect(isFatalError(new Error('potrace: Program terminated with exit(1)'))).toBe(true);
    expect(isFatalError(new Error('potrace: memory access out of bounds'))).toBe(true);
    expect(isFatalError(new Error('potrace: turnpolicy desconocida "x"'))).toBe(false);
    expect(isFatalError(new RangeError('prepareLines: dimensiones de imagen inválidas'))).toBe(false);
  });
});

describe('handler: compare measures against the source the trace used', () => {
  it("a logo over a painted checkerboard scores >= 0.97 ('auto'); 'keep' compares with the original pixels", async () => {
    const h = new Harness();
    const { image } = bakedCheckerLogo({ cell: 10 });
    h.send({ type: 'setSource', id: 1, image: payload(image) });
    h.send({ type: 'trace', id: 2, params: { engine: 'potrace' } });
    h.send({ type: 'trace', id: 3, params: { engine: 'potrace', bakedBackground: 'keep' } });
    await h.handler.idle();
    const auto = h.one(2, 'traced');
    const keep = h.one(3, 'traced');
    expect(auto.warnings[0]?.code).toBe('baked-checkerboard');
    // Rendered back with the reference scanline rasteriser, transparent where no layer paints (as the browser does).
    const autoRendered = renderAt1x(parseSvg(auto.svg), null);
    const keepRendered = renderAt1x(parseSvg(keep.svg), null);
    const target = { bakedBackground: auto.resolved.bakedBackground, background: auto.resolved.background };
    h.send({ type: 'compare', id: 4, rendered: payload(autoRendered), mode: auto.resolved.mode, ...target });
    h.send({ type: 'compare', id: 5, rendered: payload(autoRendered), mode: auto.resolved.mode }); // default: 'auto'
    h.send({ type: 'compare', id: 6, rendered: payload(image), mode: keep.resolved.mode, bakedBackground: 'keep' });
    h.send({ type: 'compare', id: 7, rendered: payload(image), mode: keep.resolved.mode });
    h.send({ type: 'compare', id: 8, rendered: payload(keepRendered), mode: keep.resolved.mode, bakedBackground: 'keep' });
    h.send({ type: 'compare', id: 9, rendered: payload(autoRendered), mode: keep.resolved.mode, bakedBackground: 'keep' });
    await h.handler.idle();

    const measured = h.one(4, 'compared').metrics;
    expect(measured.fidelity).toBeGreaterThanOrEqual(0.97);
    expect(h.one(5, 'compared').metrics).toEqual(measured);
    // 'keep': the painted pixels are the reference, so they match themselves exactly…
    const same = h.one(6, 'compared');
    expect(same.metrics.fidelity).toBeCloseTo(1, 6);
    expect(same.metrics.pctDiff16).toBe(0);
    expect(new Uint8Array(same.diffMap.data).every((v) => v === 0)).toBe(true);
    // …while 'auto' excludes the checkerboard: the painted grey cells now differ from the source.
    expect(h.one(7, 'compared').metrics.pctDiff16).toBeGreaterThan(0.1);
    // A 'keep' trace measured against the painted pixels beats the checkerboard-free trace.
    expect(h.one(8, 'compared').metrics.fidelity).toBeGreaterThan(h.one(9, 'compared').metrics.fidelity + 0.05);
  });

  it('flat mode: an opaque background the SVG paints is what the source is composited on', async () => {
    const h = new Harness();
    const params: TraceParams = { mode: 'flat', engine: 'potrace', background: { rgb: [200, 30, 30] } };
    h.send({ type: 'setSource', id: 1, image: payload(transparentLogo(64).image) });
    h.send({ type: 'trace', id: 2, params });
    await h.handler.idle();
    const traced = h.one(2, 'traced');
    const rendered = renderAt1x(parseSvg(traced.svg), null);
    h.send({ type: 'compare', id: 3, rendered: payload(rendered), mode: 'flat', background: traced.resolved.background });
    h.send({ type: 'compare', id: 4, rendered: payload(rendered), mode: 'flat' });
    await h.handler.idle();
    const painted = h.one(3, 'compared').metrics;
    const plain = h.one(4, 'compared').metrics;
    expect(painted.fidelity).toBeGreaterThanOrEqual(0.97);
    expect(plain.fidelity).toBeLessThan(painted.fidelity - 0.1);
  });
});

describe('handler: tune', () => {
  it("progress events carry the tune id, then 'tuned' with params that re-trace to the same SVG", async () => {
    const h = new Harness();
    h.send({ type: 'setSource', id: 1, image: payload(glyph().image) });
    h.send({ type: 'tune', id: 2, params: {}, budgetMs: 60_000 });
    await h.handler.idle();
    const rs = h.of(2);
    const progress = rs.filter((r): r is Of<'progress'> => r.type === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(rs[rs.length - 1].type).toBe('tuned');
    const tuned = rs[rs.length - 1] as Of<'tuned'>;
    expect(Number.isFinite(tuned.score)).toBe(true);
    expect(tuned.score).toBeGreaterThanOrEqual(progress[0].progress.best?.score ?? Infinity);
    // Before -> after: the baseline is trace(params) measured by the tuner, the result its own stats.
    expect(tuned.tuned).toEqual({
      fidelity: expect.any(Number),
      cornerFraction: tuned.stats.cornerFraction,
      nodeCount: tuned.stats.nodeCount,
      bytes: tuned.stats.bytes,
    });
    expect(tuned.tuned.fidelity).toBeGreaterThanOrEqual(tuned.baseline.fidelity - 0.005);

    h.send({ type: 'trace', id: 3, params: tuned.params });
    h.send({ type: 'trace', id: 4, params: {} });
    await h.handler.idle();
    expect(h.one(3, 'traced').svg).toBe(tuned.svg);
    const baseline = h.one(4, 'traced');
    expect(tuned.baseline).toEqual({
      fidelity: expect.any(Number),
      cornerFraction: baseline.stats.cornerFraction,
      nodeCount: baseline.stats.nodeCount,
      bytes: baseline.stats.bytes,
    });
  });

  it("cancelling a running tune answers 'cancelled' and stops its progress", async () => {
    const h = new Harness();
    h.send({ type: 'setSource', id: 1, image: payload(glyph().image) });
    h.send({ type: 'tune', id: 2, params: {}, budgetMs: 60_000 });
    await h.until(() => h.of(2).some((r) => r.type === 'progress'));
    const before = h.of(2).length;
    h.send({ type: 'cancel', id: 3, target: 2 });
    await h.handler.idle();
    const after = h.of(2).slice(before);
    expect(after).toEqual([{ type: 'cancelled', id: 2 }]);
  });
});
