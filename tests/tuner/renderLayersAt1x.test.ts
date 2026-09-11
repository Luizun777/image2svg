/**
 * renderLayersAt1x with gradient layers (modo Degradados, fase 5): rendering layers traced at U× straight at
 * the image size must match rasterising them at U× and box-downscaling (tests/fixtures/svgBack renderAt1x).
 * The 1× render samples a gradient once per pixel centre while the reference averages U² sample colours, so
 * both agree while the ramp is affine across a pixel; at a kink (inner stop, pad end, radial centre) the
 * box average differs by about (slope change in levels per 1× pixel) / 8. Measured 2026-09-11, 64×64 disc
 * r 28, white background, U ∈ {2, 4} (identical maxima for both):
 *   2-stop linear 68 px, pad ends outside the disc     max 1 (interior and AA edge)
 *   2-stop linear 41 px, pad ends inside the disc      max 1
 *   3-stop linear 64 px (feather-like, kink at 0.4)    max 1
 *   2-stop radial r 27, centre between pixel centres   interior max 1, AA edge max 2
 *   8-stop linear 68 px (kinks of up to 26 levels/px)  max 2
 *   3-stop radial r 27 (kink of 19 levels/px at 0.5)   max 3
 *   2-stop radial r 20 centred on a pixel centre       max 2 at rho >= 2 px (pad kink, 12 levels/px), 5 at the apex
 */
import { describe, expect, it } from 'vitest';
import type { AbsPath, Gradient, Layer, RasterImage, RGB } from '../../src/types';
import { scaleGradient } from '../../src/core/fillEval';
import { downscaleBoxRaster } from '../../src/core/upscale';
import { rasterizeLayers, rasterizeMask } from '../../src/metrics/scanline';
import { renderLayersAt1x } from '../../src/tuner/autotune';

const KAPPA = 0.5522847498307936;
const SIZE = 64;
const WHITE: RGB = [255, 255, 255];

function circlePath(cx: number, cy: number, r: number): AbsPath {
  const k = KAPPA * r;
  return {
    segs: [
      { kind: 'M', x: cx + r, y: cy },
      { kind: 'C', x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x: cx, y: cy + r },
      { kind: 'C', x1: cx - k, y1: cy + r, x2: cx - r, y2: cy + k, x: cx - r, y: cy },
      { kind: 'C', x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x: cx, y: cy - r },
      { kind: 'C', x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x: cx + r, y: cy },
      { kind: 'Z' },
    ],
  };
}

function rectPath(x0: number, y0: number, x1: number, y1: number): AbsPath {
  return {
    segs: [
      { kind: 'M', x: x0, y: y0 },
      { kind: 'L', x: x1, y: y0 },
      { kind: 'L', x: x1, y: y1 },
      { kind: 'L', x: x0, y: y1 },
      { kind: 'Z' },
    ],
  };
}

function scalePath(p: AbsPath, s: number): AbsPath {
  return {
    segs: p.segs.map((g) => {
      switch (g.kind) {
        case 'M':
        case 'L':
          return { kind: g.kind, x: g.x * s, y: g.y * s };
        case 'Q':
          return { kind: 'Q', x1: g.x1 * s, y1: g.y1 * s, x: g.x * s, y: g.y * s };
        case 'C':
          return { kind: 'C', x1: g.x1 * s, y1: g.y1 * s, x2: g.x2 * s, y2: g.y2 * s, x: g.x * s, y: g.y * s };
        default:
          return g;
      }
    }),
  };
}

/** A layer described in 1× units, emitted in viewBox (U×) units like the pipeline does. */
function atU(paths: AbsPath[], gradient: Gradient | undefined, U: number, fill = '#808080'): Layer {
  const layer: Layer = { fill, paths: paths.map((p) => scalePath(p, U)) };
  if (gradient !== undefined) layer.gradient = scaleGradient(gradient, U);
  return layer;
}

interface Gap {
  /** Largest channel difference over pixels fully covered by the gradient layer. */
  interior: number;
  /** Largest channel difference over every pixel. */
  all: number;
  /** Largest channel difference over interior pixels farther than 2 px from a radial centre. */
  awayFromApex: number;
}

/** renderLayersAt1x vs downscaleBoxRaster(rasterizeLayers at U×), per channel (alpha included). */
function gapToReference(layersU: Layer[], U: number, coverage1x: RasterImage['data'] | Float32Array, g: Gradient): Gap {
  const reference = downscaleBoxRaster(rasterizeLayers(layersU, SIZE * U, SIZE * U, WHITE), U);
  const fast = renderLayersAt1x(layersU, U, SIZE, SIZE, WHITE);
  expect([fast.width, fast.height]).toEqual([reference.width, reference.height]);
  const gap: Gap = { interior: 0, all: 0, awayFromApex: 0 };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      let d = 0;
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(reference.data[i * 4 + k] - fast.data[i * 4 + k]));
      gap.all = Math.max(gap.all, d);
      if (coverage1x[i] < 255) continue;
      gap.interior = Math.max(gap.interior, d);
      const apexFar = g.kind === 'linear' || Math.hypot(x + 0.5 - g.cx, y + 0.5 - g.cy) >= 2;
      if (apexFar) gap.awayFromApex = Math.max(gap.awayFromApex, d);
    }
  }
  return gap;
}

const DISC = [circlePath(32, 32, 28)];

describe('renderLayersAt1x with gradients', () => {
  it('matches rasterising at U× and box-downscaling within 1 level for ramps affine across a pixel (U = 2, 4)', () => {
    const cases: Array<{ name: string; paths: AbsPath[]; g: Gradient; all: number }> = [
      {
        name: '2-stop linear, ends outside the shape',
        paths: DISC,
        g: { kind: 'linear', x1: 4.3, y1: 10.7, x2: 58.9, y2: 51.2, stops: [{ offset: 0, color: [255, 0, 40] }, { offset: 1, color: [0, 255, 200] }] },
        all: 1,
      },
      {
        name: '2-stop linear, pad ends inside the shape',
        paths: DISC,
        g: { kind: 'linear', x1: 14.2, y1: 20.1, x2: 47.3, y2: 44.9, stops: [{ offset: 0, color: [40, 90, 230] }, { offset: 1, color: [170, 40, 200] }] },
        all: 1,
      },
      {
        name: '3-stop feather-like linear',
        paths: DISC,
        g: {
          kind: 'linear',
          x1: 6,
          y1: 50,
          x2: 58,
          y2: 12,
          stops: [
            { offset: 0, color: [40, 90, 230] },
            { offset: 0.4, color: [120, 60, 215] },
            { offset: 1, color: [170, 40, 200] },
          ],
        },
        all: 1,
      },
      {
        name: '2-stop radial, centre between pixel centres',
        paths: [circlePath(31.3, 33.1, 27)],
        g: { kind: 'radial', cx: 31.3, cy: 33.1, r: 27, stops: [{ offset: 0, color: [255, 240, 0] }, { offset: 1, color: [20, 0, 160] }] },
        all: 2, // AA edge pixels: coverage and colour both vary across the pixel
      },
    ];
    for (const U of [2, 4]) {
      for (const c of cases) {
        const coverage = rasterizeMask(c.paths, SIZE, SIZE, 4 * U).data;
        // A solid layer below the gradient one: both kinds go through the same scaling.
        const layersU = [atU([rectPath(0, 0, 64, 20)], undefined, U, '#204060'), atU(c.paths, c.g, U)];
        const gap = gapToReference(layersU, U, coverage, c.g);
        expect(gap.interior, `${c.name}, U ${U}`).toBeLessThanOrEqual(1);
        expect(gap.all, `${c.name}, U ${U}`).toBeLessThanOrEqual(c.all);
      }
    }
  });

  it('at steep ramp kinks the gap stays at the measured (slope change / 8) values', () => {
    const cases: Array<{ name: string; paths: AbsPath[]; g: Gradient; interior: number; awayFromApex: number }> = [
      {
        name: '8-stop linear, kinks up to 26 levels/px',
        paths: DISC,
        g: {
          kind: 'linear',
          x1: 8,
          y1: 8,
          x2: 56,
          y2: 56,
          stops: Array.from({ length: 8 }, (_, i) => ({
            offset: i / 7,
            color: [(i * 97) % 256, (i * 53 + 20) % 256, 255 - ((i * 31) % 256)] as RGB,
          })),
        },
        interior: 2,
        awayFromApex: 2,
      },
      {
        name: '3-stop radial, kink of 19 levels/px at t = 0.5',
        paths: [circlePath(31.3, 33.1, 27)],
        g: {
          kind: 'radial',
          cx: 31.3,
          cy: 33.1,
          r: 27,
          stops: [
            { offset: 0, color: [255, 255, 0] },
            { offset: 0.5, color: [255, 0, 0] },
            { offset: 1, color: [0, 0, 128] },
          ],
        },
        interior: 3,
        awayFromApex: 3,
      },
      {
        name: '2-stop radial r 20 on a pixel centre, pad kink inside the shape',
        paths: [circlePath(32, 32, 30)],
        g: { kind: 'radial', cx: 32.5, cy: 32.5, r: 20, stops: [{ offset: 0, color: [255, 240, 0] }, { offset: 1, color: [20, 0, 160] }] },
        interior: 5, // the apex: the 1× sample sits exactly on the centre, the U² samples do not
        awayFromApex: 2,
      },
    ];
    for (const U of [2, 4]) {
      for (const c of cases) {
        const coverage = rasterizeMask(c.paths, SIZE, SIZE, 4 * U).data;
        const gap = gapToReference([atU(c.paths, c.g, U)], U, coverage, c.g);
        expect(gap.interior, `${c.name}, U ${U}`).toBeLessThanOrEqual(c.interior);
        expect(gap.awayFromApex, `${c.name}, U ${U}`).toBeLessThanOrEqual(c.awayFromApex);
      }
    }
  });

  it('U = 1 renders the layers as given; U > 1 never mutates them', () => {
    const g: Gradient = { kind: 'radial', cx: 20.5, cy: 40.25, r: 33, stops: [{ offset: 0, color: [9, 99, 199] }, { offset: 1, color: [250, 240, 10] }] };
    const layers1 = [atU(DISC, g, 1)];
    expect(Array.from(renderLayersAt1x(layers1, 1, SIZE, SIZE, WHITE).data)).toEqual(
      Array.from(rasterizeLayers(layers1, SIZE, SIZE, WHITE).data),
    );
    const layers4 = [atU(DISC, g, 4), atU([rectPath(0, 0, 10, 10)], undefined, 4, '#ff0000')];
    const before = JSON.stringify(layers4);
    renderLayersAt1x(layers4, 4, SIZE, SIZE, WHITE);
    expect(JSON.stringify(layers4)).toBe(before);
  });
});
