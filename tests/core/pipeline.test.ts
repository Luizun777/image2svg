/**
 * Pipeline behaviour decided in src/core: the 50 % coverage iso-level threshold measured on real
 * traces, the 'empty-trace' warning and the pixel-mode rectangle cap.
 */
import { describe, expect, it } from 'vitest';
import type { BinaryMask, Engine, RasterImage, RGB, Tracer } from '../../src/types';
import { prepareLines, trace, layerMask } from '../../src/core/pipeline';
import { analyzeSource, classify } from '../../src/core/classify';
import { resolveParams } from '../../src/core/params';
import { countInk } from '../../src/core/morphology';
import { MAX_PIXEL_RECTS } from '../../src/core/pixelExact';
import { aaCircle, aaDiagonalLine, coverage, grayToRaster, noisePhoto } from '../../src/dev/synth';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { rasterizeMask } from '../../src/metrics/scanline';
import { maskIoU } from '../fixtures/helpers';
import { binarise, parseSvg } from '../fixtures/svgBack';

const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };
const SMOOTH = { mode: 'lines', upscale: 4, blurK: 0.35, engine: 'potrace' } as const;
const WHITE: RGB = [255, 255, 255];
const SPANISH = /[áéíóúñ]/;

/** Anti-aliased disc (r 20 in 64 px) of colour `ink` over `bg`, with its ideal mask at U x. */
function disc(ink: RGB, bg: RGB, size = 64, r = 20): { image: RasterImage; ideal: (U: number) => BinaryMask } {
  const c = size / 2;
  const sdf = (x: number, y: number): number => Math.hypot(x - c, y - c) - r;
  return {
    image: grayToRaster(coverage(size, sdf), size, ink, bg),
    ideal: (U: number) => {
      const n = size * U;
      const data = new Uint8Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (sdf((x + 0.5) / U, (y + 0.5) / U) < 0) data[y * n + x] = 1;
      return { data, width: n, height: n };
    },
  };
}

function traced(svg: string, ideal: BinaryMask): { iou: number; ratio: number; ink: number } {
  const mask = binarise(rasterizeMask(parseSvg(svg).paths, ideal.width, ideal.height));
  return { iou: maskIoU(mask, ideal), ratio: countInk(mask) / countInk(ideal), ink: countInk(mask) };
}

describe('lines threshold: 50 % coverage iso-level between ink and paper', () => {
  it('orange, cyan, gold and light grey discs on white: classified lines, traced IoU >= 0.97', async () => {
    const inks: Array<[string, RGB]> = [
      ['orange', [255, 165, 0]],
      ['cyan', [0, 255, 255]],
      ['gold', [255, 215, 0]],
      ['light grey', [211, 211, 211]],
    ];
    for (const [name, ink] of inks) {
      const { image, ideal } = disc(ink, WHITE);
      expect(classify(analyzeSource(image)).mode, name).toBe('lines');
      const r = await trace(image, SMOOTH, tracers);
      const m = traced(r.svg, ideal(4));
      console.info(`${name} disc: IoU=${m.iou.toFixed(4)} ratio=${m.ratio.toFixed(3)}`);
      expect(m.iou, name).toBeGreaterThanOrEqual(0.97);
      expect(r.warnings, name).toEqual([]);
    }
  });

  it('navy disc on #303030: traced IoU >= 0.97 and not all-ink', async () => {
    const { image, ideal } = disc([0, 0, 128], [48, 48, 48]);
    const r = await trace(image, SMOOTH, tracers);
    const m = traced(r.svg, ideal(4));
    console.info(`navy on #303030: IoU=${m.iou.toFixed(4)} ratio=${m.ratio.toFixed(3)}`);
    expect(m.iou).toBeGreaterThanOrEqual(0.97);
    expect(m.ink / (256 * 256)).toBeLessThan(0.5);
  });

  it('aaDiagonalLine (1.5 px): traced IoU >= 0.93 with ink ratio in (0.9, 1.1); aaCircle stays >= 0.99', async () => {
    const line = aaDiagonalLine();
    const rl = await trace(line.image, SMOOTH, tracers);
    const ml = traced(rl.svg, line.maskAt(4));
    const circle = aaCircle();
    const rc = await trace(circle.image, SMOOTH, tracers);
    const mc = traced(rc.svg, circle.maskAt(4));
    console.info(`aaDiagonalLine: IoU=${ml.iou.toFixed(4)} ratio=${ml.ratio.toFixed(3)}; aaCircle IoU=${mc.iou.toFixed(4)}`);
    expect(ml.iou).toBeGreaterThanOrEqual(0.93);
    expect(ml.ratio).toBeGreaterThan(0.9);
    expect(ml.ratio).toBeLessThan(1.1);
    expect(mc.iou).toBeGreaterThanOrEqual(0.99);
  });

  it('thresholdOffset still shifts the level: + adds ink, - removes it', () => {
    const { image } = disc([255, 165, 0], WHITE);
    const info = analyzeSource(image);
    const ink = (thresholdOffset: number): number =>
      countInk(layerMask(prepareLines(image, resolveParams({ mode: 'lines', upscale: 2, thresholdOffset }, image), info).layers[0]));
    const base = ink(0);
    expect(base).toBeGreaterThan(0);
    expect(ink(0.08)).toBeGreaterThan(base);
    expect(ink(-0.08)).toBeLessThan(base);
  });
});

describe("'empty-trace' warning", () => {
  it('a non-blank image whose mask ends with 0 ink px warns (in Spanish) instead of a silent empty SVG', async () => {
    const { image } = disc([255, 255, 0], WHITE); // yellow, luma 226: offset -0.25 puts the level below it
    const r = await trace(image, { ...SMOOTH, thresholdOffset: -0.25 }, tracers);
    expect(parseSvg(r.svg).paths).toHaveLength(0);
    expect(r.warnings.map((w) => w.code)).toEqual(['empty-trace']);
    expect(r.warnings[0].message).toMatch(SPANISH);
  });

  it('a blank image does not warn', async () => {
    const blank: RasterImage = { data: new Uint8ClampedArray(32 * 32 * 4).fill(255), width: 32, height: 32 };
    const r = await trace(blank, { mode: 'lines', engine: 'potrace' }, tracers);
    expect(parseSvg(r.svg).paths).toHaveLength(0);
    expect(r.warnings).toEqual([]);
  });

  it('also warns when the tracer drops every path of a non-empty mask (speckle filter)', async () => {
    const dropAll: Tracer = { name: 'potrace', init: () => Promise.resolve(), traceBinary: () => Promise.resolve([]) };
    const r = await trace(aaCircle().image, { mode: 'lines', upscale: 1 }, { potrace: dropAll, vtracer: dropAll });
    expect(r.warnings.map((w) => w.code)).toEqual(['empty-trace']);
  });
});

describe('pixel mode rectangle cap', () => {
  it('1440x1440 noise forced to pixel mode: < 1 s, no SVG string, too-many-rects pointing to Color plano', async () => {
    const img = noisePhoto(1440);
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const r = await trace(img, { mode: 'pixel' }, tracers);
    const ms = performance.now() - t0;
    const heapGrowth = process.memoryUsage().heapUsed - heap0;
    console.info(`noise 1440 pixel: ${ms.toFixed(0)} ms, heap +${(heapGrowth / 1e6).toFixed(1)} MB, ${r.warnings[0]?.message}`);
    expect(ms).toBeLessThan(1000);
    expect(r.svg).toBe('');
    expect(r.stats.bytes).toBe(0);
    expect(r.stats.subpathCount).toBe(0);
    expect(r.warnings.map((w) => w.code)).toEqual(['too-many-rects']);
    expect(r.warnings[0].message).toMatch(/Color plano/);
    expect(r.warnings[0].message).toMatch(/rectángulos/);
    expect(r.warnings[0].message).toContain(String(MAX_PIXEL_RECTS).slice(0, 3));
    // No 79 MB string and no two million Rect objects.
    expect(heapGrowth).toBeLessThan(64e6);
  });
});
