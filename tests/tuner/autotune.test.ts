/**
 * Auto-tuner on synthetic fixtures (potrace + vtracer in Node). The numbers behind the thresholds were
 * measured on 2026-09-10 (ARCHITECTURE.md, "Decisiones de implementación", auto-tuner):
 *   aaCircle        default 0.9934 → early exit on the baseline
 *   aaCircle naive  (U 1, blur 0) 0.9755 → 0.9867, 2 evaluated
 *   glyph 48        0.9617 → 0.9909, 28 evaluated, early exit
 *   glyph 24        0.9358 → 0.9877, 24 evaluated, early exit
 *   flatShapes3 96  0.9438 → 0.9743, 71 evaluated of 101, complete (~330 ms)
 *   flatShapes3 192 0.9750 → 0.9839, complete (~970 ms; budget 150 stops at ~155 ms)
 *   glyph 384       (proxy 192 px) 0.9832 → 0.9964, 38 evaluated, early exit in stage B
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BinaryMask, Engine, RasterImage, Tracer, TraceParams } from '../../src/types';
import type { TuneProgress } from '../../src/workers/protocol';
import { analyzeSource } from '../../src/core/classify';
import { resolveParams } from '../../src/core/params';
import { layerMask, prepareLines, trace } from '../../src/core/pipeline';
import { computeMetrics, tunerScore } from '../../src/metrics/fidelity';
import { effectiveSource } from '../../src/core/bakedBackground';
import {
  aaCircle,
  bakedCheckerLogo,
  flatShapes3,
  glyph,
  gradientFeathers,
  nearestUpscale,
  sprite32,
  transparentLogo,
} from '../../src/dev/synth';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import {
  EARLY_EXIT_SCORE,
  FIDELITY_GUARD,
  autotune,
  comparisonBackground,
  maskPerimeter,
  metricBackground,
  outranks,
  renderLayersAt1x,
  type AvailableTracers,
  type TuneResult,
} from '../../src/tuner/autotune';
import { STAGE_B_PER_SEED, STAGE_B_SEEDS, stageAGrid } from '../../src/tuner/grid';
import { parseSvg, renderAt1x } from '../fixtures/svgBack';

const WASM = path.join(process.cwd(), 'node_modules/vtracer-web/vtracer.wasm');
const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };
const TOTAL_BOTH_ENGINES = 1 + stageAGrid(0.2).length + STAGE_B_SEEDS * STAGE_B_PER_SEED + 1;
const NAIVE: TraceParams = { upscale: 1, blurK: 0 };
/** Scheduling slack on top of "budget + one candidate" (timer granularity, GC, assembling the SVG). */
const BUDGET_SLACK_MS = 40;

beforeAll(async () => {
  await tracers.vtracer.init(readFileSync(WASM));
  await tracers.potrace.init();
});

interface Run {
  result: TuneResult | null;
  events: Array<{ p: TuneProgress; t: number }>;
  elapsed: number;
  /** Longest time between two progress events (or from the start to the first): one candidate. */
  maxGap: number;
}

async function run(
  img: RasterImage,
  params: TraceParams = {},
  o: { budgetMs?: number; tracers?: AvailableTracers; cancelWhen?: (p: TuneProgress) => boolean; cancelled?: () => boolean } = {},
): Promise<Run> {
  const info = analyzeSource(img);
  const events: Array<{ p: TuneProgress; t: number }> = [];
  let cancelled = false;
  const t0 = performance.now();
  const result = await autotune(img, info, params, o.tracers ?? tracers, {
    budgetMs: o.budgetMs ?? 60_000,
    now: () => performance.now(),
    yieldToEvents: () => new Promise((resolve) => setTimeout(resolve, 0)),
    isCancelled: () => cancelled || (o.cancelled?.() ?? false),
    onProgress: (p) => {
      events.push({ p: structuredClone(p), t: performance.now() });
      if (o.cancelWhen?.(p) === true) cancelled = true;
    },
  });
  const elapsed = performance.now() - t0;
  let maxGap = 0;
  let prev = t0;
  for (const e of events) {
    maxGap = Math.max(maxGap, e.t - prev);
    prev = e.t;
  }
  return { result, events, elapsed, maxGap };
}

function done(r: Run): TuneResult {
  expect(r.result).not.toBeNull();
  return r.result as TuneResult;
}

const STAGE_ORDER: Record<TuneProgress['stage'], number> = { A: 0, B: 1, engine: 2 };

/** done = 1, 2, 3…; constant total; stages A → B → engine; best score never decreases. */
function expectMonotonicProgress(r: Run): void {
  const res = done(r);
  const ps = r.events.map((e) => e.p);
  expect(ps.length).toBeGreaterThan(0);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    expect(p.done).toBe(i + 1);
    expect(p.total).toBe(ps[0].total);
    expect(p.best).not.toBeNull();
    if (i > 0) {
      expect(STAGE_ORDER[p.stage]).toBeGreaterThanOrEqual(STAGE_ORDER[ps[i - 1].stage]);
      expect(p.best?.score ?? -1).toBeGreaterThanOrEqual(ps[i - 1].best?.score ?? -1);
    }
  }
  const last = ps[ps.length - 1];
  if (res.stop === 'complete') expect(last.done).toBe(last.total);
  else expect(['early-exit', 'budget']).toContain(res.stop);
  expect(last.best?.score).toBe(res.score);
}

/** The tuned params re-trace (core pipeline) to exactly the returned output. */
async function expectReproducible(img: RasterImage, res: TuneResult): Promise<void> {
  const again = await trace(img, res.params, tracers, analyzeSource(img));
  expect(again.svg).toBe(res.svg);
  expect(again.stats).toEqual(res.stats);
  expect(again.warnings).toEqual(res.warnings);
  expect(again.resolved).toEqual(res.resolved);
}

/**
 * The before -> after summaries: `tuned` is the returned trace's own stats, `baseline` the stats of
 * trace(params); both fidelities in 0..1. An early exit on the baseline returns it unchanged.
 */
async function expectSummaries(img: RasterImage, params: TraceParams, res: TuneResult): Promise<void> {
  expect(res.tuned).toEqual({
    fidelity: expect.any(Number),
    cornerFraction: res.stats.cornerFraction,
    nodeCount: res.stats.nodeCount,
    bytes: res.stats.bytes,
  });
  const base = await trace(img, params, tracers, analyzeSource(img));
  expect(res.baseline).toEqual({
    fidelity: expect.any(Number),
    cornerFraction: base.stats.cornerFraction,
    nodeCount: base.stats.nodeCount,
    bytes: base.stats.bytes,
  });
  for (const s of [res.baseline, res.tuned]) {
    expect(s.fidelity).toBeGreaterThan(0);
    expect(s.fidelity).toBeLessThanOrEqual(1);
  }
  expect(res.tuned.fidelity).toBeGreaterThanOrEqual(res.baseline.fidelity - 0.005);
  if (res.svg === base.svg) expect(res.tuned).toEqual(res.baseline);
}

/** tunerScore of trace(params) measured through the test fixtures (SVG parsed back, renderAt1x). */
async function independentLinesScore(img: RasterImage, params: TraceParams): Promise<number> {
  const info = analyzeSource(img);
  const r = await trace(img, params, tracers, info);
  const bg = metricBackground(info);
  const m = computeMetrics({ original: img, rendered: renderAt1x(parseSvg(r.svg), bg), mode: 'lines', background: bg });
  const at1x = resolveParams({ ...params, upscale: 1, blurK: 0 }, img, 'lines');
  return tunerScore(m, r.stats, maskPerimeter(layerMask(prepareLines(img, at1x, info).layers[0])));
}

function progressSignature(r: Run): string[] {
  return r.events.map((e) => `${e.p.stage}:${e.p.done}/${e.p.total}:${e.p.best?.score}`);
}

describe('autotune on aaCircle', () => {
  it('returns a score >= the default-params score, measured independently too; early exit on the baseline', async () => {
    const { image } = aaCircle();
    const r = await run(image);
    const res = done(r);
    const independent = await independentLinesScore(image, {});
    expect(Math.abs(res.defaultScore - independent)).toBeLessThan(2e-3);
    expect(res.score).toBeGreaterThanOrEqual(res.defaultScore);
    expect(res.defaultScore).toBeGreaterThan(EARLY_EXIT_SCORE);
    expect(res.stop).toBe('early-exit');
    expect(res.evaluated).toBe(1);
    expect(res.params).toEqual({});
    expect(r.events[0].p.total).toBe(TOTAL_BOTH_ENGINES);
    expectMonotonicProgress(r);
    await expectReproducible(image, res);
  });

  it('from the naive trace (U 1, no blur) finds a better one', async () => {
    const { image } = aaCircle();
    const r = await run(image, NAIVE);
    const res = done(r);
    expect(Math.abs(res.defaultScore - (await independentLinesScore(image, NAIVE)))).toBeLessThan(2e-3);
    expect(res.score).toBeGreaterThan(res.defaultScore + 0.008);
    expect(res.resolved.upscale).toBeGreaterThanOrEqual(2);
    expect(res.stats.cornerFraction).toBe(0);
    expectMonotonicProgress(r);
    await expectReproducible(image, res);
  });

  it('is deterministic across two runs', async () => {
    const { image } = aaCircle();
    for (const params of [{}, NAIVE]) {
      const a = await run(image, params);
      const b = await run(image, params);
      expect(done(b).params).toEqual(done(a).params);
      expect(done(b).score).toBe(done(a).score);
      expect(done(b).svg).toBe(done(a).svg);
      expect(done(b).evaluated).toBe(done(a).evaluated);
      expect(progressSignature(b)).toEqual(progressSignature(a));
    }
  });

  it('budgetMs 150 returns within the budget plus one candidate', async () => {
    const r = await run(aaCircle().image, NAIVE, { budgetMs: 150 });
    done(r);
    expect(r.elapsed).toBeLessThanOrEqual(150 + r.maxGap + BUDGET_SLACK_MS);
  });

  it('cancel stops within one candidate', async () => {
    const pre = await run(aaCircle().image, NAIVE, { cancelled: () => true });
    expect(pre.result).toBeNull();
    expect(pre.events).toEqual([]);
    const r = await run(aaCircle().image, NAIVE, { cancelWhen: (p) => p.done >= 1 });
    expect(r.result).toBeNull();
    expect(r.events.length).toBeLessThanOrEqual(2);
  });
});

describe('autotune search on flatShapes3 (never reaches the early exit)', () => {
  it('runs every stage, memoises duplicates, improves the default, deterministically and reproducibly', async () => {
    const { image } = flatShapes3();
    const a = await run(image);
    const res = done(a);
    expect(res.stop).toBe('complete');
    expect(res.score).toBeLessThan(EARLY_EXIT_SCORE);
    expectMonotonicProgress(a);
    const stages = a.events.map((e) => e.p.stage);
    expect(stages.filter((s) => s === 'A')).toHaveLength(1 + 36);
    expect(stages.filter((s) => s === 'B')).toHaveLength(STAGE_B_SEEDS * STAGE_B_PER_SEED);
    expect(stages[stages.length - 1]).toBe('engine');
    expect(a.events[a.events.length - 1].p.done).toBe(TOTAL_BOTH_ENGINES);
    expect(res.evaluated).toBeLessThan(TOTAL_BOTH_ENGINES); // stage-B duplicates of stage A are not re-traced
    expect(res.evaluated).toBeGreaterThan(36);
    expect(res.score).toBeGreaterThan(res.defaultScore + 0.02);
    await expectReproducible(image, res);

    const b = await run(image);
    expect(done(b).params).toEqual(res.params);
    expect(done(b).svg).toBe(res.svg);
    expect(progressSignature(b)).toEqual(progressSignature(a));
  });

  it('budgetMs 150 stops the search within the budget plus one candidate', async () => {
    const { image } = flatShapes3(192); // full search ~1 s
    const r = await run(image, {}, { budgetMs: 150 });
    const res = done(r);
    expect(res.stop).toBe('budget');
    expect(r.elapsed).toBeLessThanOrEqual(150 + r.maxGap + BUDGET_SLACK_MS);
    expect(r.events[r.events.length - 1].p.done).toBeLessThan(TOTAL_BOTH_ENGINES);
    expect(res.score).toBeGreaterThanOrEqual(res.defaultScore);
    await expectReproducible(image, res);
  });

  it('a cancel raised during a candidate stops before the next one', async () => {
    const { image } = flatShapes3();
    const fromProgress = await run(image, {}, { cancelWhen: (p) => p.done === 10 });
    expect(fromProgress.result).toBeNull();
    expect(fromProgress.events.length).toBeLessThanOrEqual(11);

    let flag = false;
    let flaggedAt = Infinity;
    setTimeout(() => {
      flag = true;
      flaggedAt = performance.now();
    }, 60);
    const fromTimer = await run(image, {}, { cancelled: () => flag });
    expect(fromTimer.result).toBeNull();
    expect(flaggedAt).toBeLessThan(Infinity);
    expect(fromTimer.events.filter((e) => e.t > flaggedAt).length).toBeLessThanOrEqual(1);
  });
});

describe('autotune on low-resolution logo-like glyphs', () => {
  it('improves the default score by more than 0.02 at 48 px and 24 px', async () => {
    for (const size of [48, 24]) {
      const { image } = glyph(size);
      const r = await run(image);
      const res = done(r);
      expect(res.score, `glyph ${size}`).toBeGreaterThan(res.defaultScore + 0.02);
      expect(res.stats.cornerFraction, `glyph ${size}`).toBe(0);
      expectMonotonicProgress(r);
      await expectReproducible(image, res);
    }
  });

  it('ranks on a proxy for sources above 256 px and returns a full-resolution trace', async () => {
    const { image } = glyph(384);
    const r = await run(image);
    const res = done(r);
    expect(r.events.some((e) => e.p.stage === 'B')).toBe(true);
    expect(res.score).toBeGreaterThan(res.defaultScore + 0.005);
    expect(res.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384"')).toBe(true);
    expectMonotonicProgress(r);
    await expectReproducible(image, res);
  });
});

describe('autotune fidelity guard (measured 2026-09-10, potrace + vtracer)', () => {
  it('never returns a trace more than FIDELITY_GUARD below the baseline fidelity (glyph 24, 48, 96)', async () => {
    // Measured (fidelity baseline -> tuned, corners): 24 0.9782 -> 0.9969, 4 -> 0; 48 0.9969 -> 0.9969,
    // 4 -> 0; 96 0.9978 -> 0.9936, 4 -> 0.
    for (const size of [24, 48, 96]) {
      const { image } = glyph(size);
      const res = done(await run(image));
      expect(res.tuned.fidelity, `glyph ${size}`).toBeGreaterThanOrEqual(res.baseline.fidelity - 0.005);
      expect(res.score, `glyph ${size}`).toBeGreaterThanOrEqual(res.defaultScore);
      await expectSummaries(image, {}, res);
    }
  });

  it('a trace that drops most corners for less than FIDELITY_GUARD of fidelity still wins', async () => {
    // A pixelated circle (nearest ×3, lines): 28 corners (cornerFraction 0.269) at fidelity 0.9722; the
    // tuned trace has no corner at 0.9706, 0.0017 less.
    const image = nearestUpscale(aaCircle(48, 16).image, 3);
    const res = done(await run(image, { mode: 'lines' }));
    expect(res.baseline.cornerFraction).toBeGreaterThan(0.2);
    expect(res.tuned.cornerFraction).toBe(0);
    expect(res.tuned.fidelity).toBeLessThan(res.baseline.fidelity);
    expect(res.tuned.fidelity).toBeGreaterThanOrEqual(res.baseline.fidelity - 0.005);
    expect(res.tuned.nodeCount).toBeLessThan(res.baseline.nodeCount);
    expectMonotonicProgress(await run(image, { mode: 'lines' }));
    await expectReproducible(image, res);
    await expectSummaries(image, { mode: 'lines' }, res);
  });
});

describe('autotune over a painted checkerboard', () => {
  it("'auto' is measured against the effective source and reproduces trace(); 'keep' traces the painted pixels", async () => {
    const { image } = bakedCheckerLogo({ cell: 10 });
    const info = analyzeSource(image);
    const auto = done(await run(image));
    expect(auto.warnings[0]?.code).toBe('baked-checkerboard');
    // Against the painted pixels the grey cells would count as missing detail; measured 0.9933.
    expect(auto.baseline.fidelity).toBeGreaterThanOrEqual(0.97);
    const baseTrace = await trace(image, {}, tracers, info);
    const bg = metricBackground(info);
    const independent = computeMetrics({
      original: effectiveSource(image, info, baseTrace.resolved),
      rendered: renderAt1x(parseSvg(baseTrace.svg), bg),
      mode: baseTrace.resolved.mode,
      background: bg,
    });
    expect(Math.abs(auto.baseline.fidelity - independent.fidelity)).toBeLessThan(2e-3);
    await expectReproducible(image, auto);
    await expectSummaries(image, {}, auto);

    const keep = done(await run(image, { bakedBackground: 'keep' }));
    expect(keep.resolved.bakedBackground).toBe('keep');
    expect(keep.warnings.map((w) => w.code)).not.toContain('baked-checkerboard');
    await expectReproducible(image, keep);
    await expectSummaries(image, { bakedBackground: 'keep' }, keep);
    // The painted cells are layers only with 'keep' (measured 35 nodes vs 667).
    expect(auto.stats.nodeCount * 4).toBeLessThan(keep.stats.nodeCount);
  });
});

describe('autotune in gradient mode with maxStops 4', () => {
  // tests/pipeline/gradientRoundTrip.test.ts covers the defaults (maxStops 8); here a non-default fit parameter
  // must survive every candidate, since the tuner memoises the segmentation keyed by it (gradientFitKey).
  // Measured 2026-09-11: score 0.9669 -> 0.9770, fidelity 0.9877 -> 0.9850, 71 evaluated, complete, ~1.35 s; the
  // same as with maxStops 8, because the feathers are 2-stop ramps (5 gradients of 2 stops at 128 px with 8 and
  // with 4). So the stop-count check is a guard; reproducibility with maxStops 4 carried through is the point.
  it('keeps maxStops 4 through the search: reproducible, never below the baseline, at most 4 stops per gradient', async () => {
    const { image } = gradientFeathers(128, 1);
    const params: TraceParams = { mode: 'gradient', maxStops: 4 };
    const r = await run(image, params);
    const res = done(r);
    expect(res.resolved.mode).toBe('gradient');
    expect(res.resolved.maxStops).toBe(4);
    expect(res.params.maxStops).toBe(4);
    expect(res.score).toBeGreaterThanOrEqual(res.defaultScore);
    expectMonotonicProgress(r);
    await expectReproducible(image, res);
    await expectSummaries(image, params, res);
    const gradients = parseSvg(res.svg).layers.flatMap((l) => (l.gradient === undefined ? [] : [l.gradient]));
    expect(gradients.length).toBeGreaterThan(0);
    for (const g of gradients) expect(g.stops.length).toBeLessThanOrEqual(4);
  }, 120_000);
});

describe('autotune engines and pixel mode', () => {
  it('without vtracer there is no engine pass; without potrace the search runs on vtracer', async () => {
    const { image } = glyph();
    const potraceOnly = await run(image, {}, { tracers: { potrace: tracers.potrace } });
    expect(potraceOnly.events[0].p.total).toBe(TOTAL_BOTH_ENGINES - 1);
    expect(potraceOnly.events.every((e) => e.p.stage !== 'engine')).toBe(true);

    const vtracerOnly = await run(image, { engine: 'vtracer' }, { tracers: { vtracer: tracers.vtracer } });
    const res = done(vtracerOnly);
    expect(vtracerOnly.events[0].p.total).toBe(TOTAL_BOTH_ENGINES - 1);
    expect(res.resolved.engine).toBe('vtracer');
    expect(res.score).toBeGreaterThanOrEqual(res.defaultScore);
    // alphamax / turdsize / opttolerance do not reach vtracer: those candidates are traced once.
    expect(res.evaluated).toBeLessThanOrEqual(1 + 6);
    const again = await trace(image, res.params, { vtracer: tracers.vtracer } as Record<Engine, Tracer>, analyzeSource(image));
    expect(again.svg).toBe(res.svg);
  });

  it('pixel mode returns the default trace at once', async () => {
    const image = nearestUpscale(sprite32(3), 4);
    const r = await run(image);
    const res = done(r);
    expect(res.stop).toBe('pixel');
    expect(res.evaluated).toBe(1);
    expect(r.events.map((e) => [e.p.stage, e.p.done, e.p.total])).toEqual([['A', 1, 1]]);
    expect(res.score).toBeGreaterThanOrEqual(0.999); // pixel mode reproduces every pixel
    expect(res.svg).toBe((await trace(image, {}, tracers, analyzeSource(image))).svg);
    expect(res.tuned).toEqual(res.baseline);
    await expectSummaries(image, {}, res);
  });

  it('pixel mode with a gridScale that does not divide the image scores every block, partial edges included', async () => {
    // 10x10 in blocks of 3: the last column and row are 1 px wide. The SVG draws them, so does the score.
    const size = 10;
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const bx = Math.floor(x / 3);
        const by = Math.floor(y / 3);
        data.set([20 + 60 * bx, 20 + 60 * by, (4 * bx + by) * 15, 255], (y * size + x) * 4);
      }
    }
    const image: RasterImage = { data, width: size, height: size };
    const res = done(await run(image, { mode: 'pixel', gridScale: 3 }));
    expect(res.stop).toBe('pixel');
    expect(res.svg).toContain('width="10" height="10" viewBox="0 0 10 10"');
    expect(res.score).toBeCloseTo(1, 9);
    await expectSummaries(image, { mode: 'pixel', gridScale: 3 }, res);
  });
});

describe('autotune helpers', () => {
  it('renderLayersAt1x matches rasterising at U× and box-downscaling to within 1 level (lines)', async () => {
    const { image } = aaCircle();
    const r = await trace(image, { mode: 'lines', upscale: 4 }, tracers);
    const parsed = parseSvg(r.svg);
    const bg = metricBackground({ borderColor: null });
    const reference = renderAt1x(parsed, bg);
    const fast = renderLayersAt1x(parsed.layers, 4, 64, 64, bg);
    let maxDiff = 0;
    for (let i = 0; i < reference.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(reference.data[i] - fast.data[i]));
    expect(maxDiff).toBeLessThanOrEqual(1);
  });

  it('maskPerimeter estimates a disc perimeter within 3 % and ignores the image border', () => {
    const n = 64;
    const disc: BinaryMask = { data: new Uint8Array(n * n), width: n, height: n };
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) if ((x + 0.5 - 32) ** 2 + (y + 0.5 - 32) ** 2 < 400) disc.data[y * n + x] = 1;
    }
    expect(Math.abs(maskPerimeter(disc) - 2 * Math.PI * 20) / (2 * Math.PI * 20)).toBeLessThan(0.03);
    const full: BinaryMask = { data: new Uint8Array(n * n).fill(1), width: n, height: n };
    expect(maskPerimeter(full)).toBe(0);
  });

  it('metricBackground is the border colour, else white', () => {
    expect(metricBackground({ borderColor: [1, 2, 3] })).toEqual([1, 2, 3]);
    expect(metricBackground({ borderColor: null })).toEqual([255, 255, 255]);
  });

  it('comparisonBackground: the opaque background a flat SVG paints, else metricBackground', () => {
    const { image } = transparentLogo(32); // > 5 % transparent: 'auto' resolves to a transparent background
    const info = { borderColor: [1, 2, 3] as [number, number, number] };
    expect(comparisonBackground(image, info, 'flat', { rgb: [200, 10, 10] })).toEqual([200, 10, 10]);
    expect(comparisonBackground(image, info, 'flat', 'white')).toEqual([255, 255, 255]);
    expect(comparisonBackground(image, info, 'flat', 'auto')).toEqual([1, 2, 3]);
    expect(comparisonBackground(image, info, 'flat')).toEqual([1, 2, 3]);
    expect(comparisonBackground(image, info, 'flat', 'transparent')).toEqual([1, 2, 3]);
    // A gradient SVG paints its background region like a flat one.
    expect(comparisonBackground(image, info, 'gradient', { rgb: [200, 10, 10] })).toEqual([200, 10, 10]);
    expect(comparisonBackground(image, info, 'gradient', 'auto')).toEqual([1, 2, 3]);
    // lines and pixel SVGs never paint a background.
    expect(comparisonBackground(image, info, 'lines', { rgb: [200, 10, 10] })).toEqual([1, 2, 3]);
    expect(comparisonBackground(image, { borderColor: null }, 'pixel', 'white')).toEqual([255, 255, 255]);
  });
});

describe('fidelity guard', () => {
  it('outranks: only within FIDELITY_GUARD of the baseline; then score, fewer corners, fewer nodes', () => {
    expect(FIDELITY_GUARD).toBe(0.005);
    const incumbent = { score: 0.9, fidelity: 0.95, corners: 80, nodes: 1200 };
    const floor = incumbent.fidelity - FIDELITY_GUARD;
    // A higher score that costs more than 0.005 of fidelity never becomes the result.
    expect(outranks({ score: 0.95, fidelity: 0.944, corners: 0, nodes: 100 }, incumbent, floor)).toBe(false);
    // 0.002 less fidelity, 80 -> 3 corners and a higher score: accepted.
    expect(outranks({ score: 0.93, fidelity: 0.948, corners: 3, nodes: 850 }, incumbent, floor)).toBe(true);
    expect(outranks({ score: 0.91, fidelity: floor, corners: 80, nodes: 1200 }, incumbent, floor)).toBe(true);
    // Within the guard but a lower score: no.
    expect(outranks({ score: 0.89, fidelity: 0.96, corners: 0, nodes: 10 }, incumbent, floor)).toBe(false);
    // Equal scores: fewer corners, then fewer nodes; an identical standing keeps the incumbent.
    expect(outranks({ ...incumbent, corners: 79 }, incumbent, floor)).toBe(true);
    expect(outranks({ ...incumbent, corners: 81, nodes: 1 }, incumbent, floor)).toBe(false);
    expect(outranks({ ...incumbent, nodes: 1199 }, incumbent, floor)).toBe(true);
    expect(outranks({ ...incumbent }, incumbent, floor)).toBe(false);
    expect(outranks({ ...incumbent, score: Number.NaN }, incumbent, floor)).toBe(false);
    expect(outranks({ ...incumbent, score: 1, fidelity: Number.NaN }, incumbent, floor)).toBe(false);
  });
});
