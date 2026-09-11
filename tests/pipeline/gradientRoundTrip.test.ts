/**
 * Gradient mode round trip (phase 6): trace() in mode 'gradient' on the gradient fixtures, read back with parseSvg and
 * rendered at 1x through the reference rasteriser (renderAt1x), then compared with the fixture and its ground truth.
 * The numbers behind the thresholds are in ARCHITECTURE.md, "Decisiones de implementación" (gradient mode, phase 6).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Engine, LinearGradient, RasterImage, RegionMap, RGB, Tracer, TraceParams, TraceResult } from '../../src/types';
import { analyzeSource, classify } from '../../src/core/classify';
import { resolveParams } from '../../src/core/params';
import {
  fitGradientRegions,
  gradientFallbackWarning,
  gradientProxyFactor,
  isFullMask,
  layerMask,
  prepareGradient,
  trace,
  traceLayers,
} from '../../src/core/pipeline';
import { erode1 } from '../../src/core/morphology';
import { assembleSvg } from '../../src/svg/assemble';
import { upscaleRaster } from '../../src/core/upscale';
import { flatShapes3, gradientFeathers, noisePhoto, radialDisc, transparentLogo, withNoise } from '../../src/dev/synth';
import { computeMetrics } from '../../src/metrics/fidelity';
import { rasterizeMask } from '../../src/metrics/scanline';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { autotune } from '../../src/tuner/autotune';
import { hexToRgb, parseSvg, renderAt1x, type ParsedSvg } from '../fixtures/svgBack';
import {
  BAR_INK,
  FEATHER_BAR_INK,
  SEMI_INK,
  feathersWithBars,
  feathersWithRampButton,
  fullColumns,
  fullRows,
  gradientRectsWithSemiDisc,
  semiTransparentDisc,
  splitRadialDisc,
  steepRamp,
  thinBars,
  type Bar,
} from '../fixtures/gradientCases';

const WASM = path.join(process.cwd(), 'node_modules/vtracer-web/vtracer.wasm');
const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };
const WHITE: RGB = [255, 255, 255];

beforeAll(async () => {
  await tracers.vtracer.init(readFileSync(WASM));
  await tracers.potrace.init();
});

interface Traced {
  res: TraceResult;
  parsed: ParsedSvg;
  rendered: RasterImage;
  fidelity: number;
  /** The <path …> start tags, in layer order. */
  pathTags: string[];
}

async function traceGradient(image: RasterImage, params: TraceParams = {}): Promise<Traced> {
  const res = await trace(image, { mode: 'gradient', engine: 'potrace', ...params }, tracers);
  const parsed = parseSvg(res.svg);
  const rendered = renderAt1x(parsed, null);
  const fidelity = computeMetrics({ original: image, rendered, mode: 'gradient', background: WHITE }).fidelity;
  return { res, parsed, rendered, fidelity, pathTags: [...res.svg.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]) };
}

function count(svg: string, re: RegExp): number {
  return (svg.match(re) ?? []).length;
}

function maxDiff(a: ArrayLike<number>, ia: number, b: ArrayLike<number>, ib: number): number {
  return Math.max(Math.abs(a[ia] - b[ib]), Math.abs(a[ia + 1] - b[ib + 1]), Math.abs(a[ia + 2] - b[ib + 2]));
}

/** Pixels of `label` whose whole 3×3 has that label (outside the anti-aliasing band of the shape). */
function coreOf(labels: RegionMap, label: number): Uint8Array {
  const { width: w, height: h, data } = labels;
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let inside = true;
      for (let dy = -1; dy <= 1 && inside; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (data[(y + dy) * w + x + dx] !== label) {
            inside = false;
            break;
          }
        }
      }
      if (inside) out[y * w + x] = 1;
    }
  }
  return out;
}

/** RMSE (levels, pooled over R, G and B) between the render and the fixture over `core`. */
function coreRmse(rendered: RasterImage, image: RasterImage, core: Uint8Array): number {
  let ss = 0;
  let n = 0;
  for (let i = 0; i < core.length; i++) {
    if (core[i] === 0) continue;
    n++;
    for (let c = 0; c < 3; c++) ss += (rendered.data[i * 4 + c] - image.data[i * 4 + c]) ** 2;
  }
  return Math.sqrt(ss / (3 * n));
}

/**
 * For every core pixel, the topmost layer whose outline covers its centre (rasterised at viewBox size); returns the
 * layer painting most of the core and the share of the core it paints.
 */
function paintingLayer(parsed: ParsedSvg, core: Uint8Array, width: number): { layer: number; share: number } {
  const U = parsed.vbW / width;
  const coverage = parsed.layers.map((l) => rasterizeMask(l.paths, parsed.vbW, parsed.vbH).data);
  const votes = new Map<number, number>();
  let n = 0;
  for (let i = 0; i < core.length; i++) {
    if (core[i] === 0) continue;
    n++;
    const x = i % width;
    const y = (i - x) / width;
    const at = Math.floor((y + 0.5) * U) * parsed.vbW + Math.floor((x + 0.5) * U);
    let top = -1;
    for (let k = parsed.layers.length - 1; k >= 0; k--) {
      if (coverage[k][at] >= 128) {
        top = k;
        break;
      }
    }
    votes.set(top, (votes.get(top) ?? 0) + 1);
  }
  let layer = -1;
  let most = 0;
  for (const [k, v] of votes) {
    if (v > most) {
      layer = k;
      most = v;
    }
  }
  return { layer, share: most / n };
}

/**
 * For every 1x pixel, the topmost layer whose outline covers its centre (rasterised at viewBox size, coverage >= 128);
 * per layer, the pixels it paints of each ground-truth label.
 */
function paintedLabels(parsed: ParsedSvg, labels: RegionMap): Array<Map<number, number>> {
  const { width, height } = labels;
  const U = parsed.vbW / width;
  const coverage = parsed.layers.map((l) => rasterizeMask(l.paths, parsed.vbW, parsed.vbH).data);
  const out = parsed.layers.map(() => new Map<number, number>());
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = Math.floor((y + 0.5) * U) * parsed.vbW + Math.floor((x + 0.5) * U);
      for (let k = parsed.layers.length - 1; k >= 0; k--) {
        if (coverage[k][at] < 128) continue;
        const label = labels.data[y * width + x];
        out[k].set(label, (out[k].get(label) ?? 0) + 1);
        break;
      }
    }
  }
  return out;
}

/**
 * Seams between cut-out shapes: the contact pixels (a label other than `background` with a 4-neighbour of another label
 * that is not `background` either), how many render farther than 40 levels from the source and how many as white.
 */
function contactSeams(rendered: RasterImage, image: RasterImage, labels: RegionMap, background: number): { contact: number; off: number; white: number } {
  const { width: w, height: h, data: L } = labels;
  let contact = 0;
  let off = 0;
  let white = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = L[i];
      if (a === background) continue;
      const touches =
        (x > 0 && L[i - 1] !== a && L[i - 1] !== background) ||
        (x < w - 1 && L[i + 1] !== a && L[i + 1] !== background) ||
        (y > 0 && L[i - w] !== a && L[i - w] !== background) ||
        (y < h - 1 && L[i + w] !== a && L[i + w] !== background);
      if (!touches) continue;
      contact++;
      if (maxDiff(rendered.data, i * 4, image.data, i * 4) > 40) off++;
      if (maxDiff(rendered.data, i * 4, [255, 255, 255], 0) <= 8) white++;
    }
  }
  return { contact, off, white };
}

/** Undirected angle between two gradient axes, degrees in [0, 90]. */
function axisAngleDeg(a: LinearGradient, b: LinearGradient): number {
  let d = Math.abs(Math.atan2(a.y2 - a.y1, a.x2 - a.x1) - Math.atan2(b.y2 - b.y1, b.x2 - b.x1)) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return (d * 180) / Math.PI;
}

describe('gradient pipeline round trip (potrace)', () => {
  it('gradientFeathers(256): one layer per shape plus the background (10), no shape split, 8 linear gradients, fidelity >= 0.98, core RMSE < 2, no seams', async () => {
    const gf = gradientFeathers(256, 1);
    const t = await traceGradient(gf.image);
    expect(t.res.warnings).toEqual([]);
    expect([t.res.resolved.upscale, t.res.resolved.layering]).toEqual([4, 'cutout']);
    const layers = t.parsed.layers;
    // The review found 11: feather 5 as a gradient layer plus a solid layer painting 73 px of its tip.
    expect(layers.length).toBe(gf.shapes.length + 1);
    expect(t.pathTags).toHaveLength(layers.length);
    // Every layer paints mostly one label, and no two layers the same one: a split shape would need two.
    const painted = paintedLabels(t.parsed, gf.labels);
    const mains = painted.map((m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    expect(new Set(mains).size).toBe(layers.length);
    for (let label = 0; label <= gf.shapes.length; label++) {
      let total = 0;
      for (const m of painted) total += m.get(label) ?? 0;
      const own = painted[mains.indexOf(label)].get(label) ?? 0;
      expect(own / total, `label ${label}`).toBeGreaterThanOrEqual(0.97); // the rest: anti-aliased pixels under the background
    }
    expect(count(t.res.svg, /<linearGradient\b/g)).toBe(8);
    expect(count(t.res.svg, /<radialGradient\b/g)).toBe(0);
    expect(layers[0].fill).toBe('#ffffff');
    expect(layers[0].gradient).toBeUndefined();

    const painting = new Set<number>();
    const rmses: string[] = [];
    for (const shape of gf.shapes) {
      const core = coreOf(gf.labels, shape.label);
      const { layer, share } = paintingLayer(t.parsed, core, 256);
      painting.add(layer);
      expect(share, `shape ${shape.label}`).toBeGreaterThanOrEqual(0.99);
      const paint = layers[layer];
      if (shape.fill.kind === 'linear') {
        expect(paint.gradient?.kind, `shape ${shape.label}`).toBe('linear');
        expect(t.pathTags[layer], `shape ${shape.label}`).not.toContain('evenodd');
      } else {
        expect(paint.gradient, `shape ${shape.label}`).toBeUndefined();
      }
      const rmse = coreRmse(t.rendered, gf.image, core);
      rmses.push(rmse.toFixed(2));
      expect(rmse, `shape ${shape.label}`).toBeLessThan(2);
    }
    expect(painting.size).toBe(gf.shapes.length); // one layer (one <path>) per shape

    // No seams: inside the shapes nothing renders as the white background (±8).
    let inside = 0;
    let white = 0;
    for (const shape of gf.shapes) {
      const core = coreOf(gf.labels, shape.label);
      for (let i = 0; i < core.length; i++) {
        if (core[i] === 0) continue;
        inside++;
        if (maxDiff(t.rendered.data, i * 4, [255, 255, 255], 0) <= 8) white++;
      }
    }
    // Seams sit on the pixels where two shapes touch, which the core check above never sees.
    const seams = contactSeams(t.rendered, gf.image, gf.labels, 0);
    console.info(
      `gradientFeathers(256): layers=${layers.length} fidelity=${t.fidelity.toFixed(4)} coreRmse=[${rmses.join(', ')}] ` +
        `seams=${white}/${inside} contact off>40=${seams.off}/${seams.contact} white=${seams.white} nodes=${t.res.stats.nodeCount} bytes=${t.res.stats.bytes}`,
    );
    expect(white / inside).toBeLessThan(0.001);
    expect(seams.contact).toBe(159);
    expect(seams.white).toBe(0);
    expect(seams.off).toBeLessThanOrEqual(8); // 5 %; a 2 px erosion of the masks at U 4 gives 19 (next test)
    expect(t.fidelity).toBeGreaterThanOrEqual(0.98);
  });

  it('the contact-seam check sees seams: masks eroded by 2 px at U 4 (the ceil(U/2) dilation undone) and by 6 px fail it', async () => {
    const gf = gradientFeathers(256, 1);
    const image = gf.image;
    const resolved = resolveParams({ mode: 'gradient', engine: 'potrace' }, image);
    const prepared = prepareGradient(image, resolved, analyzeSource(image));
    const results: string[] = [];
    for (const k of [2, 6]) {
      const eroded = {
        ...prepared,
        layers: prepared.layers.map((l) => {
          let m = layerMask(l);
          if (!isFullMask(m)) for (let e = 0; e < k; e++) m = erode1(m);
          return { ...l, mask: m };
        }),
      };
      const layers = await traceLayers(eroded, tracers.potrace, {
        alphamax: resolved.alphamax,
        opttolerance: resolved.opttolerance,
        turdsize: resolved.turdsizeScaled,
        turnpolicy: resolved.turnpolicy,
        opticurve: resolved.opticurve,
        vtracer: resolved.vtracer,
      });
      const svg = assembleSvg(layers, { width: 256, height: 256, viewBoxWidth: 256 * prepared.U, viewBoxHeight: 256 * prepared.U });
      const seams = contactSeams(renderAt1x(parseSvg(svg), null), image, gf.labels, 0);
      results.push(`erode ${k}: off>40 ${seams.off}/${seams.contact}`);
      expect(seams.off, `erosion ${k}`).toBeGreaterThan(8);
    }
    console.info(`contact-seam control: ${results.join(', ')}`);
  });

  it('radialDisc(128): exactly one radialGradient, centre / U within 2 px and r / U within 5 %', async () => {
    const rd = radialDisc(128);
    const t = await traceGradient(rd.image);
    expect(t.res.warnings).toEqual([]);
    expect(count(t.res.svg, /<radialGradient\b/g)).toBe(1);
    const radial = t.parsed.layers.map((l) => l.gradient).filter((g) => g?.kind === 'radial');
    expect(radial).toHaveLength(1);
    const g = radial[0];
    if (g?.kind !== 'radial') throw new Error('unreachable');
    const U = t.res.resolved.upscale;
    console.info(
      `radialDisc(128): U=${U} centre=(${(g.cx / U).toFixed(2)}, ${(g.cy / U).toFixed(2)}) r=${(g.r / U).toFixed(2)} ` +
        `stops=${g.stops.length} layers=${t.parsed.layers.length} fidelity=${t.fidelity.toFixed(4)}`,
    );
    expect(Math.hypot(g.cx / U - rd.fill.cx, g.cy / U - rd.fill.cy)).toBeLessThanOrEqual(2);
    expect(Math.abs(g.r / U - rd.fill.r) / rd.fill.r).toBeLessThanOrEqual(0.05);
    expect(t.fidelity).toBeGreaterThanOrEqual(0.98);
  });

  it('withNoise(gradientFeathers(256), ±3): fidelity >= 0.97 with 8 linear gradients', async () => {
    const gf = gradientFeathers(256, 1);
    const t = await traceGradient(withNoise(gf.image, 3, 1));
    console.info(`gradientFeathers(256) ±3: layers=${t.parsed.layers.length} fidelity=${t.fidelity.toFixed(4)}`);
    expect(t.res.warnings).toEqual([]);
    expect(count(t.res.svg, /<linearGradient\b/g)).toBe(8);
    expect(t.fidelity).toBeGreaterThanOrEqual(0.97);
  });

  it('flatShapes3: 3 solid layers without <defs>, >= 98 % label agreement as in flat mode', async () => {
    const { image, labels, palette } = flatShapes3();
    const t = await traceGradient(image);
    expect(t.res.warnings).toEqual([]);
    expect(t.res.svg).not.toContain('<defs>');
    expect(t.res.svg).not.toContain('url(');
    expect(t.parsed.layers).toHaveLength(3);
    for (const layer of t.parsed.layers) {
      const c = hexToRgb(layer.fill);
      expect(Math.min(...palette.map((p) => maxDiff(p, 0, c, 0)))).toBeLessThanOrEqual(2);
    }
    let pure = 0;
    let agree = 0;
    for (let i = 0; i < labels.data.length; i++) {
      const k = palette.findIndex((p) => maxDiff(image.data, i * 4, p, 0) === 0);
      if (k < 0) continue; // anti-aliased pixel
      pure++;
      let best = 0;
      for (let j = 1; j < palette.length; j++) {
        const dj = palette[j].reduce((s, v, c) => s + (v - t.rendered.data[i * 4 + c]) ** 2, 0);
        const db = palette[best].reduce((s, v, c) => s + (v - t.rendered.data[i * 4 + c]) ** 2, 0);
        if (dj < db) best = j;
      }
      if (best === labels.data[i]) agree++;
    }
    console.info(`flatShapes3 (gradient): agreement=${((agree / pure) * 100).toFixed(2)} % (${agree}/${pure}) fidelity=${t.fidelity.toFixed(4)}`);
    expect(pure).toBeGreaterThan(8000);
    expect(agree / pure).toBeGreaterThanOrEqual(0.98);
  });

  it("noisePhoto(64) forced to gradient: 'gradient-fallback' with the complex share, 16 flat layers", async () => {
    const image = noisePhoto(64);
    const t = await traceGradient(image);
    expect(t.res.warnings.map((w) => w.code)).toEqual(['gradient-fallback']);
    const fit = fitGradientRegions(image, resolveParams({ mode: 'gradient' }, image), analyzeSource(image));
    expect(fit.kind).toBe('fallback');
    if (fit.kind !== 'fallback') throw new Error('unreachable');
    // A smooth colour field: 44 % edge since the Sobel gate (93 % before), 92 % of it in complex regions.
    expect(fit.reason).toMatch(/^el \d+ % de la imagen no se explica con colores planos ni degradados$/);
    expect(t.res.warnings[0]).toEqual(gradientFallbackWarning(fit.reason));
    expect(t.parsed.layers).toHaveLength(16);
    expect(t.res.svg).not.toContain('url(');
  });

  it('convention round trip: upscale 1, 2 and 4 emit the same 1x gradients, axes within 3° of the truth, core RMSE < 2', async () => {
    const gf = gradientFeathers(256, 1);
    const cores = gf.shapes.map((s) => coreOf(gf.labels, s.label));
    const at1x: LinearGradient[][] = [];
    for (const U of [1, 2, 4] as const) {
      const t = await traceGradient(gf.image, { upscale: U });
      expect(t.res.resolved.upscale).toBe(U);
      const grads: LinearGradient[] = [];
      let worstAxis = 0;
      let worstRmse = 0;
      gf.shapes.forEach((shape, k) => {
        const { layer } = paintingLayer(t.parsed, cores[k], 256);
        const rmse = coreRmse(t.rendered, gf.image, cores[k]);
        worstRmse = Math.max(worstRmse, rmse);
        expect(rmse, `U ${U}, shape ${shape.label}`).toBeLessThan(2);
        if (shape.fill.kind !== 'linear') return;
        const g = t.parsed.layers[layer].gradient;
        if (g?.kind !== 'linear') throw new Error(`U ${U}, shape ${shape.label}: no linear gradient`);
        const scaled: LinearGradient = { ...g, x1: g.x1 / U, y1: g.y1 / U, x2: g.x2 / U, y2: g.y2 / U };
        const axis = axisAngleDeg(scaled, shape.fill);
        worstAxis = Math.max(worstAxis, axis);
        expect(axis, `U ${U}, shape ${shape.label}`).toBeLessThanOrEqual(3);
        grads.push(scaled);
      });
      console.info(`convention U=${U}: worst axis ${worstAxis.toFixed(2)}°, worst core RMSE ${worstRmse.toFixed(2)}`);
      at1x.push(grads);
    }
    for (let u = 1; u < at1x.length; u++) {
      at1x[u].forEach((g, k) => {
        const ref = at1x[0][k];
        for (const key of ['x1', 'y1', 'x2', 'y2'] as const) {
          expect(Math.abs(g[key] - ref[key]), `feather ${k + 1} ${key}`).toBeLessThanOrEqual(0.1);
        }
      });
    }
  });

  it('radialDisc(512) with a spurious 1-px column across the disc: its two halves are merged back into one radial gradient', async () => {
    // Each half has more than MERGE_MAX_JOINT_PIXELS core pixels together: the joint fit ran on a strided sample, fitRadial
    // found no 9×9 neighbourhood in it and planMerges kept 2 <radialGradient>. The raised column itself is a real 1-px line
    // of the image and keeps its own thin layers.
    const image = splitRadialDisc();
    const t = await traceGradient(image);
    const radial = t.parsed.layers.filter((l) => l.gradient?.kind === 'radial');
    console.info(`split radialDisc(512): layers=${t.parsed.layers.length} radial=${radial.length} fidelity=${t.fidelity.toFixed(4)}`);
    expect(count(t.res.svg, /<radialGradient\b/g)).toBe(1);
    expect(radial).toHaveLength(1);
    expect(t.fidelity).toBeGreaterThanOrEqual(0.99);
  }, 60_000);

  it('transparentLogo(64): no background layer, nothing painted where the source is transparent', async () => {
    const { image } = transparentLogo(64);
    const t = await traceGradient(image);
    expect(t.res.svg).not.toContain('<defs>');
    expect(t.parsed.layers.length).toBeGreaterThanOrEqual(1);
    let opaque = 0;
    let both = 0;
    let painted = 0;
    for (let i = 0; i < 64 * 64; i++) {
      const src = image.data[i * 4 + 3] >= 128;
      const out = t.rendered.data[i * 4 + 3] >= 128;
      if (src) opaque++;
      if (out) painted++;
      if (src && out) both++;
    }
    const iou = both / (opaque + painted - both);
    console.info(`transparentLogo (gradient): layers=${t.parsed.layers.length} alpha IoU=${iou.toFixed(4)}`);
    expect(iou).toBeGreaterThanOrEqual(0.95);
  });
});

/** Mean of channel c of `img` over the fully covered pixels of `bars`, and the RMSE (pooled over R, G, B) against `ref`. */
function barStats(img: RasterImage, ref: RasterImage, bars: readonly Bar[]): { mean: number[]; rmse: number } {
  const mean: number[] = [];
  let ss = 0;
  let n = 0;
  for (const bar of bars) {
    let s = 0;
    let k = 0;
    for (const y of fullRows(bar)) {
      for (const x of fullColumns(bar)) {
        const o = (y * img.width + x) * 4;
        s += img.data[o];
        k++;
        for (let c = 0; c < 3; c++) ss += (img.data[o + c] - ref.data[o + c]) ** 2;
        n += 3;
      }
    }
    mean.push(s / k);
  }
  return { mean, rmse: Math.sqrt(ss / n) };
}

/** RMSE (pooled over R, G, B) of the pixels at least 2 px inside `box`. */
function insideRmse(img: RasterImage, ref: RasterImage, box: Bar): number {
  let ss = 0;
  let n = 0;
  for (let y = Math.ceil(box.y0) + 2; y < Math.floor(box.y1) - 2; y++) {
    for (let x = Math.ceil(box.x0) + 2; x < Math.floor(box.x1) - 2; x++) {
      const o = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) ss += (img.data[o + c] - ref.data[o + c]) ** 2;
      n += 3;
    }
  }
  return Math.sqrt(ss / n);
}

describe('shapes the segmentation used to lose (review)', () => {
  it('thin bars 2 to 12 px wide survive in gradient mode as in flat mode', async () => {
    const { image, bars } = thinBars();
    const g = await traceGradient(image);
    const flat = await trace(image, { mode: 'flat', engine: 'potrace' }, tracers);
    const flatFid = computeMetrics({ original: image, rendered: renderAt1x(parseSvg(flat.svg), null), mode: 'flat', background: WHITE }).fidelity;
    const s = barStats(g.rendered, image, bars);
    console.info(`thinBars (gradient): layers=${g.parsed.layers.length} fidelity=${g.fidelity.toFixed(4)} flat=${flatFid.toFixed(4)} meanR=[${s.mean.map((v) => v.toFixed(1)).join(', ')}]`);
    // Before: the 2-5 px bars rendered as the background (mean R 255), fidelity 0.7709.
    for (const m of s.mean) expect(Math.abs(m - BAR_INK[0])).toBeLessThanOrEqual(2);
    expect(g.fidelity).toBeGreaterThanOrEqual(flatFid - 0.001);
  });

  it('steep ramps (24 and 36 px wide) are painted with their gradient, not with the background', async () => {
    for (const w of [24, 36]) {
      const { image, box } = steepRamp(w);
      const g = await traceGradient(image);
      const flat = await trace(image, { mode: 'flat', engine: 'potrace' }, tracers);
      const flatRender = renderAt1x(parseSvg(flat.svg), null);
      const flatFid = computeMetrics({ original: image, rendered: flatRender, mode: 'flat', background: WHITE }).fidelity;
      const rmse = insideRmse(g.rendered, image, box);
      console.info(`steepRamp(${w}) (gradient): layers=${g.parsed.layers.length} insideRmse=${rmse.toFixed(2)} fidelity=${g.fidelity.toFixed(4)} flat=${flatFid.toFixed(4)} flatRmse=${insideRmse(flatRender, image, box).toFixed(2)}`);
      // Before: one solid layer, inside RMSE 202, fidelity 0.28.
      expect(count(g.res.svg, /<linearGradient\b/g)).toBe(1);
      expect(rmse).toBeLessThan(2);
      expect(g.fidelity).toBeGreaterThanOrEqual(flatFid);
    }
  });

  it('a semi-transparent disc is painted with its colour, as flat mode does, not black', async () => {
    const image = semiTransparentDisc();
    const t = await traceGradient(image);
    expect(t.parsed.layers.map((l) => l.fill)).toEqual(['#ff8800']);
    const o = (64 * 128 + 64) * 4;
    expect(Array.from(t.rendered.data.subarray(o, o + 4))).toEqual([...SEMI_INK, 255]);
  });

  it('Auto on the review images: gradient mode keeps the bars, the steep button and the semi-transparent disc', async () => {
    const auto = async (image: RasterImage, bg: RGB | null) => {
      const info = analyzeSource(image);
      const cls = classify(info);
      const res = await trace(image, { ...cls.params, engine: 'potrace' }, tracers, info);
      const rendered = renderAt1x(parseSvg(res.svg), bg);
      const fidelity = computeMetrics({ original: image, rendered, mode: res.resolved.mode, background: bg ?? WHITE }).fidelity;
      return { cls, res, rendered, fidelity };
    };
    const flatOf = async (image: RasterImage) => {
      const res = await trace(image, { mode: 'flat', engine: 'potrace' }, tracers);
      return computeMetrics({ original: image, rendered: renderAt1x(parseSvg(res.svg), WHITE), mode: 'flat', background: WHITE }).fidelity;
    };
    const h1 = feathersWithBars();
    const a1 = await auto(h1.image, WHITE);
    const s1 = barStats(a1.rendered, h1.image, h1.bars);
    const f1 = await flatOf(h1.image);
    console.info(`feathersWithBars (Auto ${a1.cls.mode}): barRmse=${s1.rmse.toFixed(2)} fidelity=${a1.fidelity.toFixed(4)} flat=${f1.toFixed(4)}`);
    expect(a1.cls.mode).toBe('gradient');
    for (const m of s1.mean) expect(Math.abs(m - FEATHER_BAR_INK[0])).toBeLessThanOrEqual(8); // before: 255
    expect(a1.fidelity).toBeGreaterThanOrEqual(f1);

    const h2 = feathersWithRampButton();
    const a2 = await auto(h2.image, WHITE);
    const r2 = insideRmse(a2.rendered, h2.image, h2.box);
    const f2 = await flatOf(h2.image);
    console.info(`feathersWithRampButton (Auto ${a2.cls.mode}): buttonRmse=${r2.toFixed(2)} fidelity=${a2.fidelity.toFixed(4)} flat=${f2.toFixed(4)}`);
    expect(a2.cls.mode).toBe('gradient');
    expect(r2).toBeLessThan(2); // before: 170
    expect(a2.fidelity).toBeGreaterThanOrEqual(f2);

    const h3 = gradientRectsWithSemiDisc();
    const a3 = await auto(h3, null);
    expect(a3.cls.mode).toBe('gradient');
    expect(parseSvg(a3.res.svg).layers.map((l) => l.fill)).toContain('#ff8800');
    const o = (128 * 256 + 128) * 4;
    expect(Array.from(a3.rendered.data.subarray(o, o + 4))).toEqual([...SEMI_INK, 255]); // before: 0,0,0,255
  });
});

describe('gradient mode on a proxy (f > 1)', () => {
  it('gradientProxyFactor keeps the segmentation at <= 4 Mpx', () => {
    expect(gradientProxyFactor(2000, 2000)).toBe(1);
    expect(gradientProxyFactor(2048, 2048)).toBe(2);
    expect(gradientProxyFactor(3840, 2160)).toBe(2);
    expect(gradientProxyFactor(4001, 4001)).toBe(3);
    expect(gradientProxyFactor(1, 1)).toBe(1);
  });

  it('gradientFeathers upscaled 8× (2048 px, f = 2): gradients back in 1x units, one layer per shape', () => {
    const gf = gradientFeathers(256, 1);
    const image = upscaleRaster(gf.image, 8);
    const info = analyzeSource(image);
    const resolved = resolveParams({ mode: 'gradient' }, image);
    expect(resolved.upscale).toBe(1);
    const fit = fitGradientRegions(image, resolved, info);
    expect(fit.kind).toBe('regions');
    if (fit.kind !== 'regions') throw new Error('unreachable');
    expect([fit.f, fit.seg.regions.width]).toEqual([2, 1024]);
    const prepared = prepareGradient(image, resolved, info, fit);
    const linear = prepared.layers.map((l) => l.gradient).filter((g): g is LinearGradient => g?.kind === 'linear');
    console.info(`2048 px proxy: layers=${prepared.layers.length} linear=${linear.length} raw=${fit.rawRegions} rounds=${fit.mergeRounds}`);
    expect(prepared.layers.length).toBeGreaterThanOrEqual(9);
    expect(prepared.layers.length).toBeLessThanOrEqual(11);
    expect(linear).toHaveLength(8);
    for (const shape of gf.shapes) {
      if (shape.fill.kind !== 'linear') continue;
      const truth: LinearGradient = { ...shape.fill, x1: shape.fill.x1 * 8, y1: shape.fill.y1 * 8, x2: shape.fill.x2 * 8, y2: shape.fill.y2 * 8 };
      const mid = [(truth.x1 + truth.x2) / 2, (truth.y1 + truth.y2) / 2];
      // The emitted gradient of this feather: the one whose axis passes closest to the true midpoint.
      let best = linear[0];
      let bestD = Infinity;
      for (const g of linear) {
        const dx = g.x2 - g.x1;
        const dy = g.y2 - g.y1;
        const len = Math.hypot(dx, dy);
        const d = Math.abs((mid[0] - g.x1) * dy - (mid[1] - g.y1) * dx) / len + Math.abs(Math.hypot(mid[0] - (g.x1 + g.x2) / 2, mid[1] - (g.y1 + g.y2) / 2));
        if (d < bestD) {
          bestD = d;
          best = g;
        }
      }
      expect(axisAngleDeg(best, truth), `feather ${shape.label}`).toBeLessThanOrEqual(3);
      expect(bestD, `feather ${shape.label}`).toBeLessThan(40); // 5 px at 1x of the fixture
    }
    const first = layerMask(prepared.layers[0]);
    expect([first.width, first.height]).toEqual([2048, 2048]);
  });

  it('a 1-px black frame on a 2048 px image (f = 2) is traced black, not in the grey the proxy averages it to', async () => {
    const size = 2048;
    const data = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        if (x === 0 || y === 0 || x === size - 1 || y === size - 1) {
          data[o] = data[o + 1] = data[o + 2] = 0;
        } else if (x >= 400 && x < 1600 && y >= 500 && y < 1500) {
          const t = (x + 0.5 - 400) / 1200;
          data[o] = 30 + 190 * t;
          data[o + 1] = 80;
          data[o + 2] = 200 - 160 * t;
        }
      }
    }
    const image: RasterImage = { data, width: size, height: size };
    expect(gradientProxyFactor(size, size)).toBe(2);
    const res = await trace(image, { mode: 'gradient', engine: 'potrace' }, tracers);
    expect(res.resolved.upscale).toBe(1);
    const rendered = renderAt1x(parseSvg(res.svg), WHITE);
    let ring = 0;
    let wrong = 0;
    for (let i = 0; i < size; i++) {
      for (const [x, y] of [[i, 0], [i, size - 1], [0, i], [size - 1, i]]) {
        ring++;
        if (maxDiff(rendered.data, (y * size + x) * 4, image.data, (y * size + x) * 4) > 40) wrong++;
      }
    }
    const inside = insideRmse(rendered, image, { x0: 400, x1: 1600, y0: 500, y1: 1500 });
    console.info(`frame 2048 px (f = 2): layers=${parseSvg(res.svg).layers.length} ring wrong=${wrong}/${ring} insideRmse=${inside.toFixed(2)}`);
    expect(wrong / ring).toBeLessThanOrEqual(0.01);
    expect(inside).toBeLessThan(2);
  }, 120_000);

  it('more than MAX_GRADIENT_REGIONS regions: fallback with the region count', () => {
    // 1000 × 1000 px of 20 px cells in 3 alternating colours: 2 500 flat regions with thin edges between them.
    const size = 1000;
    const data = new Uint8ClampedArray(size * size * 4);
    const colours: RGB[] = [
      [230, 60, 40],
      [40, 120, 220],
      [250, 210, 60],
    ];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = colours[(Math.floor(x / 20) + 2 * Math.floor(y / 20)) % 3];
        const o = (y * size + x) * 4;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
        data[o + 3] = 255;
      }
    }
    const image = { data, width: size, height: size };
    const fit = fitGradientRegions(image, resolveParams({ mode: 'gradient' }, image), analyzeSource(image));
    expect(fit).toEqual({ kind: 'fallback', reason: 'la imagen se divide en 2 500 regiones (el límite es 2 000)' });
  });
});

describe('autotune in gradient mode', () => {
  it('autotune(gradientFeathers(128)) reproduces trace(result.params) and scores >= the baseline', async () => {
    const { image } = gradientFeathers(128, 1);
    const info = analyzeSource(image);
    const result = await autotune(image, info, { mode: 'gradient' }, tracers, {
      budgetMs: 120_000,
      now: () => performance.now(),
      yieldToEvents: () => Promise.resolve(),
      isCancelled: () => false,
      onProgress: () => undefined,
    });
    expect(result).not.toBeNull();
    if (result === null) throw new Error('unreachable');
    console.info(
      `autotune gradientFeathers(128): default ${result.defaultScore.toFixed(4)} -> ${result.score.toFixed(4)}, ` +
        `fidelity ${result.baseline.fidelity.toFixed(4)} -> ${result.tuned.fidelity.toFixed(4)}, evaluated ${result.evaluated}, stop ${result.stop}`,
    );
    expect(result.resolved.mode).toBe('gradient');
    expect(result.score).toBeGreaterThanOrEqual(result.defaultScore);
    const again = await trace(image, result.params, tracers, info);
    expect(again.svg).toBe(result.svg);
    expect(again.warnings).toEqual(result.warnings);
  }, 120_000);
});
