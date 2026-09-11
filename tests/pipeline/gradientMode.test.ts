/**
 * Gradient mode plumbing: dispatch by mode, lazy layer masks, the gradient copied onto the traced layers and the
 * fallback of prepareGradient (a 16-colour median-cut flat palette plus the 'gradient-fallback' warning). The round
 * trip of the full gradient pipeline is in tests/pipeline/gradientRoundTrip.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { AbsPath, BinaryMask, Engine, LinearGradient, Tracer, TracerOptions } from '../../src/types';
import { analyzeSource } from '../../src/core/classify';
import { resolveParams } from '../../src/core/params';
import {
  fitGradientRegions,
  gradientFallbackWarning,
  layerMask,
  prepareFlat,
  prepareForMode,
  prepareGradient,
  prepareLines,
  trace,
  traceLayers,
  type Prepared,
} from '../../src/core/pipeline';
import { flatShapes3, noisePhoto } from '../../src/dev/synth';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { hexToRgb, parseSvg } from '../fixtures/svgBack';

const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };

const OPTS: TracerOptions = {
  alphamax: 1,
  opttolerance: 0.2,
  turdsize: 0,
  turnpolicy: 'minority',
  opticurve: true,
  vtracer: {
    cornerThresholdDeg: 60,
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThresholdDeg: 45,
    filterSpeckle: 4,
    colorPrecision: 6,
    layerDifference: 16,
    pathPrecision: 3,
  },
};

function mask(width: number, height: number, fill: (x: number, y: number) => boolean): BinaryMask {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (fill(x, y)) data[y * width + x] = 1;
  return { data, width, height };
}

/** Records every traced mask and returns one square path per call. */
function recordingTracer(seen: BinaryMask[]): Tracer {
  const square: AbsPath = {
    segs: [
      { kind: 'M', x: 1, y: 1 },
      { kind: 'L', x: 2, y: 1 },
      { kind: 'L', x: 2, y: 2 },
      { kind: 'Z' },
    ],
  };
  return {
    name: 'potrace',
    init: () => Promise.resolve(),
    traceBinary: (m) => {
      seen.push(m);
      return Promise.resolve([square]);
    },
  };
}

/** `prepared` with every lazy mask built, so two preparations compare with toEqual. */
function materialise(prepared: Prepared): Prepared {
  return { ...prepared, layers: prepared.layers.map((l) => ({ ...l, mask: layerMask(l) })) };
}

describe('gradient mode plumbing', () => {
  it("trace(flatShapes3, { mode: 'gradient' }): 3 solid cutout layers close to the palette, no warning", async () => {
    const { image, palette } = flatShapes3();
    const res = await trace(image, { mode: 'gradient' }, tracers);
    expect(res.resolved.mode).toBe('gradient');
    expect(res.resolved.layering).toBe('cutout');
    const layers = parseSvg(res.svg).layers;
    expect(layers).toHaveLength(3);
    for (const layer of layers) {
      const c = hexToRgb(layer.fill);
      expect(Math.min(...palette.map((p) => Math.max(...p.map((v, k) => Math.abs(v - c[k])))))).toBeLessThanOrEqual(2);
    }
    expect(res.svg).not.toContain('url(');
    expect(res.warnings).toEqual([]);
  });

  it('the fallback warning is one Spanish sentence pair without dashes, with or without a reason', () => {
    const generic = gradientFallbackWarning(null);
    expect(generic.code).toBe('gradient-fallback');
    expect(generic.message).toBe(
      'No se pudieron reconstruir los degradados. Se vectorizó como Color plano con 16 colores y pueden verse bandas de color.',
    );
    expect(gradientFallbackWarning('el 72 % de la imagen es borde').message).toContain(
      'No se pudieron reconstruir los degradados: el 72 % de la imagen es borde. Se vectorizó',
    );
    expect(generic.message).not.toMatch(/[\n–—]/);
  });

  it('prepareGradient (fallback) = prepareFlat with 16 median-cut colours, plus the warning with its reason', () => {
    const image = noisePhoto(64);
    const info = analyzeSource(image);
    const resolved = resolveParams({ mode: 'gradient', upscale: 2 }, image);
    const fit = fitGradientRegions(image, resolved, info);
    if (fit.kind !== 'fallback') throw new Error(`noisePhoto(64) should fall back, got ${fit.kind}`);
    const g = prepareGradient(image, resolved, info);
    const f = prepareFlat(image, { ...resolved, mode: 'flat', colors: 16, exactPalette: false }, info);
    expect(g.layers.map((l) => l.fill)).toEqual(f.layers.map((l) => l.fill));
    expect(g.layers.map((l) => layerMask(l).data)).toEqual(f.layers.map((l) => layerMask(l).data));
    expect(g.warnings).toEqual([...f.warnings, gradientFallbackWarning(fit.reason)]);
    expect([g.U, g.width, g.height]).toEqual([2, 64, 64]);
  });

  it('prepareForMode dispatches lines, flat and gradient; pixel mode has no layers', () => {
    const { image } = flatShapes3(48);
    const info = analyzeSource(image);
    const at = (mode: 'lines' | 'flat' | 'gradient' | 'pixel') => resolveParams({ mode, upscale: 1 }, image);
    expect(prepareForMode(image, at('lines'), info)).toEqual(prepareLines(image, at('lines'), info));
    expect(prepareForMode(image, at('flat'), info)).toEqual(prepareFlat(image, at('flat'), info));
    expect(materialise(prepareForMode(image, at('gradient'), info))).toEqual(materialise(prepareGradient(image, at('gradient'), info)));
    expect(() => prepareForMode(image, at('pixel'), info)).toThrow('modo píxel');
  });

  it('layerMask returns a plain mask as it is and builds a lazy one on every read', () => {
    const plain = mask(4, 4, () => true);
    expect(layerMask({ mask: plain, fill: '#000000' })).toBe(plain);
    let built = 0;
    const lazy = { mask: () => (built++, mask(4, 4, (x) => x < 2)), fill: '#000000' };
    expect(layerMask(lazy).data[0]).toBe(1);
    layerMask(lazy);
    expect(built).toBe(2);
  });

  it('traceLayers builds each lazy mask once, copies the gradient and draws a full mask as the canvas rectangle', async () => {
    const gradient: LinearGradient = {
      kind: 'linear',
      x1: 0,
      y1: 0,
      x2: 16,
      y2: 0,
      stops: [
        { offset: 0, color: [0x20, 0x40, 0xd0] },
        { offset: 1, color: [0x80, 0x30, 0xc0] },
      ],
    };
    let builds = 0;
    const prepared: Prepared = {
      U: 2,
      width: 8,
      height: 6,
      warnings: [],
      layers: [
        { mask: () => (builds++, mask(16, 12, () => true)), fill: '#ffffff' },
        { mask: () => (builds++, mask(16, 12, (x, y) => x > 3 && y > 3)), fill: '#503890', gradient },
        { mask: mask(16, 12, (x) => x === 0), fill: '#20222a', opacity: 0.5 },
      ],
    };
    const seen: BinaryMask[] = [];
    const layers = await traceLayers(prepared, recordingTracer(seen), OPTS);
    expect(builds).toBe(2);
    expect(seen).toHaveLength(2); // the full mask is not traced
    expect(layers.map((l) => l.fill)).toEqual(['#ffffff', '#503890', '#20222a']);
    expect(layers[0].paths[0].segs).toEqual([
      { kind: 'M', x: 0, y: 0 },
      { kind: 'L', x: 16, y: 0 },
      { kind: 'L', x: 16, y: 12 },
      { kind: 'L', x: 0, y: 12 },
      { kind: 'Z' },
    ]);
    expect(layers[0].gradient).toBeUndefined();
    expect(layers[1].gradient).toEqual(gradient);
    expect(layers[2]).toMatchObject({ opacity: 0.5 });
    expect('gradient' in layers[2]).toBe(false);
  });
});
