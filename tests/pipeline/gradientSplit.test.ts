/**
 * Complex regions split into parts: fillModel.splitComplex wired into pipeline.fitGradientRegions, where the parts
 * become regions of the Segmentation so that regionOrder, refineLabels, rankMap, regionMask and the layers work
 * unchanged. A region whose three channels' colour gradients are not collinear (no single-axis SVG gradient can
 * express it, whatever its stops) comes out as several layers; the fixtures one gradient already explains are not
 * touched; and with BENCH=1 pajaro's belly lands under the quality target. Numbers in ARCHITECTURE.md, "Degradados,
 * división de regiones complejas".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { BinaryMask, Engine, RasterImage, RegionMap, RGB, Segmentation, Tracer } from '../../src/types';
import { analyzeSource } from '../../src/core/classify';
import { resolveParams } from '../../src/core/params';
import {
  GRADIENT_SPLIT_MAX_NEW_SHARE,
  GRADIENT_SPLIT_MIN_ISLAND,
  type FittedRegions,
  fitGradientRegions,
  splitComplexRegions,
  trace,
} from '../../src/core/pipeline';
import { MIN_MODEL_CORE, SPLIT_MAX_DEPTH, accumulateMoments, corePixels, selectModel } from '../../src/core/fillModel';
import { segFromLabels, singleRegion } from '../fixtures/segFromLabels';
import { effectiveSource } from '../../src/core/bakedBackground';
import { computeMetrics } from '../../src/metrics/fidelity';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { diagonalSweep, flatShapes3, gradientFeathers, radialDisc } from '../../src/dev/synth';
import { parseSvg, renderAt1x } from '../fixtures/svgBack';

const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };
const WHITE: RGB = [255, 255, 255];

/**
 * A square of smooth shading on white whose channels run in different directions: R along x, G along y, B against
 * both. Their gradients are not collinear, so no single-axis gradient follows them and no number of stops helps
 * (pajaro's belly in miniature). Inside the square the field has no step at all, so the edge segmentation hands it
 * over as ONE region, and the square covers a quarter of the canvas, well under GRADIENT_MAX_COMPLEX_SHARE: an image
 * that is mostly complex falls back to the flat palette before any split, which is what the share limit is for.
 */
function crossShading(size = 192, side = 96): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  const lo = (size - side) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      data[o + 3] = 255;
      if (x < lo || x >= lo + side || y < lo || y >= lo + side) continue;
      const u = (x + 0.5 - lo) / side;
      const v = (y + 0.5 - lo) / side;
      data[o] = 50 + 90 * u;
      data[o + 1] = 60 + 80 * v;
      data[o + 2] = 200 - 50 * u - 40 * v;
    }
  }
  return { data, width: size, height: size };
}

/** The worst RMSE of any region with core pixels, and the core-weighted RMSE over all of them. */
function regionRmse(fit: Extract<ReturnType<typeof fitGradientRegions>, { kind: 'regions' }>): { worst: number; weighted: number } {
  const px = corePixels(fit.seg);
  let worst = 0;
  let ss = 0;
  let n = 0;
  for (let k = 0; k < fit.models.length; k++) {
    const count = px.offsets[k + 1] - px.offsets[k];
    if (count === 0) continue;
    const { rmse } = fit.models[k];
    if (rmse > worst) worst = rmse;
    ss += rmse * rmse * count;
    n += count;
  }
  return { worst, weighted: Math.sqrt(ss / n) };
}

describe('gradient mode: a region no single gradient explains is split into parts', () => {
  it('crossShading: the region becomes several regions, each with its own fill, and the trace follows the shading', async () => {
    const image = crossShading();
    const info = analyzeSource(image);
    const resolved = resolveParams({ mode: 'gradient', engine: 'potrace' }, image);
    const fit = fitGradientRegions(image, resolved, info);
    expect(fit.kind).toBe('regions');
    if (fit.kind !== 'regions') throw new Error('unreachable');
    expect(fit.splitRegions).toBeGreaterThanOrEqual(1);
    expect(fit.seg.regions.count).toBeGreaterThanOrEqual(2);
    const { worst, weighted } = regionRmse(fit);
    const res = await trace(image, { mode: 'gradient', engine: 'potrace' }, tracers, info);
    const rendered = renderAt1x(parseSvg(res.svg), WHITE);
    const m = computeMetrics({ original: image, rendered, mode: 'gradient', background: WHITE });
    console.info(
      `crossShading: regions=${fit.seg.regions.count} split=${fit.splitRegions} worst rmse=${worst.toFixed(2)} ` +
        `weighted=${weighted.toFixed(2)} kinds=[${fit.models.map((mm) => mm.fill.kind).join(',')}] layers=${parseSvg(res.svg).layers.length} ` +
        `fidelity=${m.fidelity.toFixed(4)}`,
    );
    // The parts of the split square keep a model of their own: at least the background and two parts.
    expect(fit.seg.regions.count).toBeGreaterThanOrEqual(3);
    const px = corePixels(fit.seg);
    const parts = [fit.seg.regions.count - 1, fit.seg.regions.count - 2];
    for (const k of parts) expect(px.offsets[k + 1] - px.offsets[k], `part ${k}`).toBeGreaterThanOrEqual(MIN_MODEL_CORE);

    // What ONE fill manages on the same shading, measured here rather than assumed: the square on its own as a single
    // region. The parts have to beat it by a clear margin, which is the whole point of splitting it.
    const background = fit.seg.area.indexOf(Math.max(...Array.from(fit.seg.area)));
    let ss = 0;
    let n = 0;
    for (let k = 0; k < fit.models.length; k++) {
      const count = px.offsets[k + 1] - px.offsets[k];
      if (count === 0 || k === background) continue;
      ss += fit.models[k].rmse ** 2 * count;
      n += count;
      expect(fit.models[k].fill.kind, `region ${k}`).not.toBe('solid'); // every part of the shading keeps a gradient
    }
    const shading = Math.sqrt(ss / n);
    const alone = crossShading(96, 96);
    const sq = segFromLabels(alone, singleRegion(96, 96), { sigma: 0 });
    const one = selectModel(alone, corePixels(sq), 0, accumulateMoments(alone, sq), { sigma: 0, maxStops: 8, radial: true });
    console.info(`crossShading: one fill ${one.fill.kind} rmse ${one.rmse.toFixed(2)} -> parts weighted ${shading.toFixed(2)}`);
    expect(one.complex).toBe(true); // no single fill explains it, whatever its stops
    expect(shading).toBeLessThanOrEqual(0.7 * one.rmse);
    expect(m.fidelity).toBeGreaterThanOrEqual(0.98);
    expect(res.warnings.map((w) => w.code)).not.toContain('gradient-fallback');
  });

  it('is deterministic: two fits of the same image give the same regions, labels and fills', () => {
    const image = crossShading();
    const info = analyzeSource(image);
    const resolved = resolveParams({ mode: 'gradient' }, image);
    const a = fitGradientRegions(image, resolved, info);
    const b = fitGradientRegions(image, resolved, info);
    if (a.kind !== 'regions' || b.kind !== 'regions') throw new Error('unreachable');
    expect(b.splitRegions).toBe(a.splitRegions);
    expect(b.seg.regions.count).toBe(a.seg.regions.count);
    expect(Array.from(b.seg.regions.data)).toEqual(Array.from(a.seg.regions.data));
    expect(Array.from(b.seg.area)).toEqual(Array.from(a.seg.area));
    expect(JSON.stringify(b.models)).toBe(JSON.stringify(a.models));
  });

  it('does not fire on the fixtures a single gradient already explains', () => {
    const cases: Array<[string, RasterImage]> = [
      ['gradientFeathers(256)', gradientFeathers(256, 1).image],
      ['radialDisc(128)', radialDisc(128).image],
      ['diagonalSweep(128)', diagonalSweep(128).image],
      ['flatShapes3(96)', flatShapes3(96).image],
    ];
    for (const [name, image] of cases) {
      const info = analyzeSource(image);
      const fit = fitGradientRegions(image, resolveParams({ mode: 'gradient' }, image), info);
      expect(fit.kind, name).toBe('regions');
      if (fit.kind !== 'regions') continue;
      expect(fit.splitRegions, name).toBe(0);
    }
  });
});

/**
 * 288x288 of 36 independent 2-D shadings (squares of side 24 at pitch 48 on white), each one a region the ladder cannot
 * explain: what the split costs when it is not one belly but the whole image. Every shading is the same size, so there is
 * no "one region that matters": the budget decides how many of them are worth the nodes.
 */
function shadingGrid(size = 288, side = 24, pitch = 48): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      data[o + 3] = 255;
      const cx = x % pitch;
      const cy = y % pitch;
      if (cx >= side || cy >= side) continue;
      const u = (cx + 0.5) / side;
      const v = (cy + 0.5) / side;
      data[o] = 50 + 90 * u;
      data[o + 1] = 60 + 80 * v;
      data[o + 2] = 200 - 50 * u - 40 * v;
    }
  }
  return { data, width: size, height: size };
}

/** Sizes of the 4-connected pieces of every label, descending: out[k] = the pieces of region k. */
function componentSizes(regions: RegionMap): number[][] {
  const { data, width: W, height: H, count } = regions;
  const out: number[][] = Array.from({ length: count }, () => []);
  const seen = new Uint8Array(data.length);
  const stack: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const k = data[i];
    if (seen[i] !== 0 || k < 0) continue;
    let n = 0;
    seen[i] = 1;
    stack.push(i);
    while (stack.length > 0) {
      const p = stack.pop() as number;
      n++;
      const x = p % W;
      const y = (p - x) / W;
      if (x > 0 && seen[p - 1] === 0 && data[p - 1] === k) ((seen[p - 1] = 1), stack.push(p - 1));
      if (x < W - 1 && seen[p + 1] === 0 && data[p + 1] === k) ((seen[p + 1] = 1), stack.push(p + 1));
      if (y > 0 && seen[p - W] === 0 && data[p - W] === k) ((seen[p - W] = 1), stack.push(p - W));
      if (y < H - 1 && seen[p + W] === 0 && data[p + W] === k) ((seen[p + W] = 1), stack.push(p + W));
    }
    out[k].push(n);
  }
  for (const l of out) l.sort((a, b) => b - a);
  return out;
}

describe('gradient mode: the split stays within its region budget', () => {
  it('shadingGrid: 36 complex regions do not multiply the region count, the nodes or the bytes', async () => {
    const image = shadingGrid();
    const info = analyzeSource(image);
    const fit = fitGradientRegions(image, resolveParams({ mode: 'gradient', engine: 'potrace' }, image), info);
    expect(fit.kind).toBe('regions');
    if (fit.kind !== 'regions') throw new Error('unreachable');
    // 37 regions before the split (the 36 shadings and the white ground), measured; 36 of them are complex, so without a
    // budget the split turns them into 145 regions (measured: 3838 nodes, 155,785 bytes, fidelity 0.9902).
    const before = 37;
    const budget = Math.max(2 ** SPLIT_MAX_DEPTH - 1, Math.ceil(GRADIENT_SPLIT_MAX_NEW_SHARE * before));
    expect(fit.splitRegions).toBeGreaterThanOrEqual(1);
    expect(fit.seg.regions.count).toBeLessThanOrEqual(before + budget);
    expect(fit.splitRegions).toBe(3); // 3 of the 36, each into 4 parts: 9 new regions of the 10 the budget allows
    const res = await trace(image, { mode: 'gradient', engine: 'potrace' }, tracers, info);
    const parsed = parseSvg(res.svg);
    const m = computeMetrics({ original: image, rendered: renderAt1x(parsed, WHITE), mode: 'gradient', background: WHITE });
    console.info(
      `shadingGrid: regions=${fit.seg.regions.count} split=${fit.splitRegions} layers=${parsed.layers.length} ` +
        `nodes=${res.stats.nodeCount} bytes=${res.stats.bytes} fidelity=${m.fidelity.toFixed(4)}`,
    );
    // Measured 797 nodes and 30,645 bytes against 548 / 22,518 with no split at all: the same order as the +41 % pajaro
    // pays, instead of the 7x of the unbudgeted split.
    expect(res.stats.nodeCount).toBeLessThanOrEqual(900);
    expect(res.stats.bytes).toBeLessThanOrEqual(35000);
    expect(m.fidelity).toBeGreaterThanOrEqual(0.945);
  }, 300000);
});

// ---------------------------------------------------------------------------------------------
// The boundary passes and the true-core gate, on segmentations built by hand. splitComplexRegions is exported for these:
// neither case is reachable from a sample on its own (pajaro's islands need its 1334² proxy and 30 s of splash, and no
// input measured has a region whose TRUE core is as much sparser than its fit core as GRADIENT_FIT_MIN_CORE_SHARE allows).
// ---------------------------------------------------------------------------------------------

const HAND_OPTS = { sigma: 0, maxStops: 8, radial: true };

/** `labels` as the segmentation of `img`, with an explicit TRUE core and FIT core (1 = in it), every region deep-fitted. */
function handFitted(
  img: RasterImage,
  labels: Int32Array,
  count: number,
  trueCore: Uint8Array,
  fitCore: Uint8Array,
): { seg: Segmentation; fitted: FittedRegions } {
  const { width, height } = img;
  const mask = (data: Uint8Array): BinaryMask => ({ data, width, height });
  const area = new Float64Array(count);
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) area[labels[i]]++;
  const seg: Segmentation = {
    regions: { data: labels, width, height, count },
    edge: mask(new Uint8Array(width * height)),
    core: mask(trueCore),
    area,
    adjacency: Array.from({ length: count }, () => new Int32Array(0)),
    sigma: 0,
    edgeShare: 0,
  };
  const fitSeg: Segmentation = { ...seg, core: mask(fitCore) };
  const px = corePixels(fitSeg);
  const moments = accumulateMoments(img, fitSeg);
  const models = Array.from({ length: count }, (_, k) => selectModel(img, px, k, moments, HAND_OPTS));
  return { seg, fitted: { fitSeg, px, models, deep: new Uint8Array(count).fill(1) } };
}

/** True-core pixels per region of the split result. */
function trueCoreCounts(regions: RegionMap, trueCore: Uint8Array): Int32Array {
  const out = new Int32Array(regions.count);
  for (let i = 0; i < regions.data.length; i++) if (trueCore[i] !== 0 && regions.data[i] >= 0) out[regions.data[i]]++;
  return out;
}

/**
 * A 2-D shading inside the rectangle [8, 120) x [8, 88) of a 128x96 image (region 0), the frame around it region 1, and
 * `patches` blocks of 5x5 px flush with the shading's left edge that are NOT core: the edge band of a region, which
 * splitComplexRegions assigns pixel by pixel to the part whose fill predicts it best. They are painted with the colour the
 * shading has at the MIRRORED point, the opposite corner, so the part that predicts them best is never the part around
 * them. Flush with the region's outline they also keep a majority of their own 8 neighbours inside the region (the frame's
 * pixels do not vote), so the smoothing passes cannot absorb them either: it is what pajaro's belly leaves along its
 * outline, in miniature and without the edge detector in the way.
 */
function shadedInset(patches = 6): { image: RasterImage; labels: Int32Array; core: Uint8Array } {
  const W = 128;
  const H = 96;
  const x0 = 8;
  const y0 = 8;
  const x1 = 120;
  const y1 = 88;
  const shade = (u: number, v: number): RGB => [90 + 90 * u, 100 + 80 * v, 200 - 50 * u - 40 * v];
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const labels = new Int32Array(W * H).fill(1);
  const core = new Uint8Array(W * H).fill(1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = i * 4;
      data[o + 3] = 255;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) {
        data[o] = 240;
        data[o + 1] = 240;
        data[o + 2] = 240;
        continue;
      }
      labels[i] = 0;
      const c = shade((x + 0.5 - x0) / (x1 - x0), (y + 0.5 - y0) / (y1 - y0));
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
    }
  }
  for (let p = 0; p < patches; p++) {
    const yc = y0 + 6 + p * 12;
    for (let y = yc - 2; y <= yc + 2; y++) {
      for (let x = x0; x < x0 + 5; x++) {
        const i = y * W + x;
        const o = i * 4;
        core[i] = 0;
        const c = shade(1 - (x + 0.5 - x0) / (x1 - x0), 1 - (y + 0.5 - y0) / (y1 - y0));
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
      }
    }
  }
  return { image: { data, width: W, height: H }, labels, core };
}

describe('splitComplexRegions: the boundary passes and the true-core gate', () => {
  it('leaves no piece of a part under GRADIENT_SPLIT_MIN_ISLAND px, so every part is one traced shape', () => {
    const { image, labels, core } = shadedInset();
    const { seg, fitted } = handFitted(image, labels, 2, core, core);
    expect(fitted.models[0].complex).toBe(true);
    const res = splitComplexRegions(image, seg, fitted, HAND_OPTS);
    expect(res).not.toBeNull();
    if (res === null) throw new Error('unreachable');
    const sizes = componentSizes(res.fitted.fitSeg.regions);
    const islands = sizes.flatMap((l, k) => l.filter((n) => n < GRADIENT_SPLIT_MIN_ISLAND).map((n) => `${k}:${n}`));
    console.info(`shadedInset: regions=${res.fitted.fitSeg.regions.count} split=${res.splitRegions} pieces=[${sizes.map((l) => l.join('+')).join(' ')}]`);
    // Without the cleanup the 6 dark blocks survive the 4 smoothing passes as 9-px pieces of the other part.
    expect(islands).toEqual([]);
    // Every part of the shading is a single piece, and so is the frame: one subpath each.
    for (let k = 0; k < sizes.length; k++) expect(sizes[k].length, `region ${k}`).toBe(1);
  });

  it('does not split a region whose parts would not each keep MIN_MODEL_CORE pixels of the TRUE core', () => {
    const image = crossShading(96, 96); // every pixel of the image is the same 2-D shading
    const n = image.width * image.height;
    const labels = new Int32Array(n);
    const dense = new Uint8Array(n).fill(1);
    const whole = handFitted(image, labels, 1, dense, dense);
    expect(whole.fitted.models[0].complex).toBe(true);
    const ok = splitComplexRegions(image, whole.seg, whole.fitted, HAND_OPTS);
    expect(ok).not.toBeNull();
    if (ok === null) throw new Error('unreachable');
    const counts = trueCoreCounts(ok.fitted.fitSeg.regions, dense);
    for (let k = 0; k < counts.length; k++) {
      expect(counts[k], `region ${k} true core`).toBeGreaterThanOrEqual(MIN_MODEL_CORE);
      expect(ok.fitted.models[k].coreCount, `region ${k} fitted core`).toBeGreaterThan(0);
    }

    // The same fit core, but the TRUE core is 100 px in one corner: what GRADIENT_FIT_MIN_CORE_SHARE allows when the edge
    // hysteresis floods a region. splitComplex and smoothParts see their 64 px per part on the fit core, but
    // fitRegionModels fits every part on the true core, where one part would have 100 px and the others none: the solid
    // floor of the ladder, or fitFlat(n = 0) = BLACK with rmse 0 and complex false.
    const sparse = new Uint8Array(n);
    for (let y = 2; y < 12; y++) for (let x = 2; x < 12; x++) sparse[y * image.width + x] = 1;
    const h = handFitted(image, labels, 1, sparse, dense);
    expect(h.fitted.models[0].complex).toBe(true);
    expect(splitComplexRegions(image, h.seg, h.fitted, HAND_OPTS)).toBeNull();
  });
});

const SAMPLES = path.join(process.cwd(), 'samples');

function decode(file: string): RasterImage {
  const png = PNG.sync.read(readFileSync(path.join(SAMPLES, file)));
  return { data: Uint8ClampedArray.from(png.data), width: png.width, height: png.height };
}

describe.skipIf(process.env.BENCH !== '1')('gradient mode: pajaro’s belly (BENCH=1)', () => {
  it('splits the belly into parts under the region target, keeping the layers and the fidelity', async () => {
    const img = decode('pajaro.png');
    const info = analyzeSource(img);
    const resolved = resolveParams({ mode: 'gradient' }, img);
    const fit = fitGradientRegions(img, resolved, info);
    expect(fit.kind).toBe('regions');
    if (fit.kind !== 'regions') throw new Error('unreachable');
    // One complex region is split (the belly) into 3 parts: 33 regions before, 35 after.
    expect(fit.splitRegions).toBe(1);
    expect(fit.seg.regions.count).toBe(35);
    const px = corePixels(fit.seg);
    const { worst, weighted } = regionRmse(fit);
    // The parts the split appended keep the last ids; the belly's third part keeps the region's own id.
    const appended = [fit.seg.regions.count - 2, fit.seg.regions.count - 1];
    let inkSs = 0;
    let inkN = 0;
    let underTarget = 0;
    const background = fit.seg.area.indexOf(Math.max(...Array.from(fit.seg.area)));
    for (let k = 0; k < fit.models.length; k++) {
      const count = px.offsets[k + 1] - px.offsets[k];
      if (count === 0 || k === background) continue;
      inkSs += fit.models[k].rmse ** 2 * count;
      inkN += count;
      if (fit.models[k].rmse <= 2.5) underTarget += count;
    }
    const ink = Math.sqrt(inkSs / inkN);
    console.info(
      `pajaro: regions=${fit.seg.regions.count} split=${fit.splitRegions} worst=${worst.toFixed(2)} weighted=${weighted.toFixed(3)} ` +
        `ink=${ink.toFixed(3)} under 2.5=${((underTarget / inkN) * 100).toFixed(1)} % parts=[${appended.map((k) => fit.models[k].rmse.toFixed(2)).join(', ')}]`,
    );
    // Before the split the belly was one region at RMSE 8.81; its parts are all near the 2.5 target now.
    for (const k of appended) expect(fit.models[k].rmse, `part ${k}`).toBeLessThanOrEqual(3);
    // And each part is ONE shape: before the island cleanup the belly's three parts were 8, 1 and 2 pieces
    // (5562, 25, 19, 16, 8, 8, 7, 2 | 5895 | 10307, 7), and potrace emitted a subpath for every stray piece.
    const pieces = componentSizes(fit.seg.regions);
    console.info(`pajaro pieces: ${[25, ...appended].map((k) => `${k}:${pieces[k].join('+')}`).join(' ')}`);
    for (const k of [25, ...appended]) expect(pieces[k].length, `region ${k} pieces`).toBe(1);
    // Nothing in the image misses by more than the small noisy region that is not worth splitting (4.45).
    expect(worst).toBeLessThanOrEqual(4.5);
    expect(ink).toBeLessThanOrEqual(1.2); // 2.833 before the split
    expect(underTarget / inkN).toBeGreaterThanOrEqual(0.91); // 0.894 before

    const res = await trace(img, { mode: 'gradient', engine: 'potrace' }, tracers, info);
    const parsed = parseSvg(res.svg);
    const bg: RGB = info.borderColor ?? WHITE;
    const rendered = renderAt1x(parsed, bg);
    const m = computeMetrics({ original: effectiveSource(img, info, res.resolved), rendered, mode: 'gradient', background: bg });
    console.info(
      `pajaro trace: layers=${parsed.layers.length} linear=${(res.svg.match(/<linearGradient\b/g) ?? []).length} ` +
        `nodes=${res.stats.nodeCount} bytes=${res.stats.bytes} fidelity=${m.fidelity.toFixed(4)} iou=${m.iou.toFixed(4)}`,
    );
    expect(parsed.layers).toHaveLength(35);
    expect(m.fidelity).toBeGreaterThanOrEqual(0.998); // 0.9982 before the split, 0.9994 after
    // Two traces of the same image are byte-identical (no random seed, no unseeded iteration order).
    const again = await trace(img, { mode: 'gradient', engine: 'potrace' }, tracers, info);
    expect(again.svg).toBe(res.svg);
  }, 900000);
});
