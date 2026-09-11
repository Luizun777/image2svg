/**
 * Synthetic cases for gradient mode found in review (pure, no vitest dependency): thin strokes, steep ramps,
 * semi-transparent shapes, low-contrast flat shapes and the Auto images that combine them with gradientFeathers.
 * Every shape is anti-aliased by 4×4 supersampling at sample positions (x + (i + 0.5)/4, y + (j + 0.5)/4); the
 * colour of a sample is that of the topmost shape containing it (no blending between shapes), and the samples are
 * averaged on premultiplied colour, so a transparent background leaves the RGB of partial pixels exact.
 */
import type { RGB, RasterImage } from '../../src/types';
import { gradientFeathers, radialDisc } from '../../src/dev/synth';

/** RGBA sample colour of a shape at a continuous point. */
export type Rgba = [number, number, number, number];

export interface PaintedCase {
  inside: (x: number, y: number) => boolean;
  colour: (x: number, y: number) => Rgba;
}

const SS = 4;
const WHITE: RGB = [255, 255, 255];

/** width×height image of `shapes` (later ones on top) over `background` (null = transparent), 4×4 supersampled. */
export function paintCases(width: number, height: number, background: RGB | null, shapes: readonly PaintedCase[]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const samples = SS * SS;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const sx = x + (i + 0.5) / SS;
          const sy = y + (j + 0.5) / SS;
          let c: Rgba | null = background === null ? null : [background[0], background[1], background[2], 255];
          for (let k = shapes.length - 1; k >= 0; k--) {
            if (shapes[k].inside(sx, sy)) {
              c = shapes[k].colour(sx, sy);
              break;
            }
          }
          if (c === null) continue;
          const alpha = c[3] / 255;
          r += c[0] * alpha;
          g += c[1] * alpha;
          b += c[2] * alpha;
          a += alpha;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        data[o] = Math.round(r / a);
        data[o + 1] = Math.round(g / a);
        data[o + 2] = Math.round(b / a);
      }
      data[o + 3] = Math.round((a / samples) * 255);
    }
  }
  return { data, width, height };
}

function rect(x0: number, y0: number, x1: number, y1: number, colour: (x: number, y: number) => Rgba): PaintedCase {
  return { inside: (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1, colour };
}

const solid = (c: RGB, alpha = 255) => (): Rgba => [c[0], c[1], c[2], alpha];

/** A vertical bar [x0, x1) × [y0, y1). */
export interface Bar {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Columns whose pixels the bar covers completely (x >= x0 and x + 1 <= x1). */
export function fullColumns(bar: Bar): number[] {
  const out: number[] = [];
  for (let x = Math.ceil(bar.x0); x + 1 <= bar.x1; x++) out.push(x);
  return out;
}

/** Rows whose pixels the bar covers completely. */
export function fullRows(bar: Bar): number[] {
  const out: number[] = [];
  for (let y = Math.ceil(bar.y0); y + 1 <= bar.y1; y++) out.push(y);
  return out;
}

export const BAR_INK: RGB = [20, 20, 20];
export const BAR_WIDTHS = [2, 3, 4, 5, 6, 7, 8, 10, 12] as const;

/** 200×120 white with 9 vertical bars of BAR_INK, widths BAR_WIDTHS, the first at x = 6.3, 10 px apart, y in [10, 110). */
export function thinBars(): { image: RasterImage; bars: Bar[] } {
  const bars: Bar[] = [];
  let x = 6.3;
  for (const w of BAR_WIDTHS) {
    bars.push({ x0: x, x1: x + w, y0: 10, y1: 110 });
    x += w + 10;
  }
  const image = paintCases(200, 120, WHITE, bars.map((b) => rect(b.x0, b.y0, b.x1, b.y1, solid(BAR_INK))));
  return { image, bars };
}

/** gradientFeathers(256, 1) in the top 256 px of a 256 × height white canvas. */
function feathersOnCanvas(height: number): RasterImage {
  const f = gradientFeathers(256, 1).image;
  const data = new Uint8ClampedArray(256 * height * 4).fill(255);
  data.set(f.data, 0);
  return { data, width: 256, height };
}

/** Pastes `shapes` painted on white over rows [yFrom, height) of `base` (the rest of base is kept). */
function pasteBelow(base: RasterImage, yFrom: number, shapes: readonly PaintedCase[]): RasterImage {
  const painted = paintCases(base.width, base.height, WHITE, shapes);
  const data = Uint8ClampedArray.from(base.data);
  data.set(painted.data.subarray(yFrom * base.width * 4), yFrom * base.width * 4);
  return { data, width: base.width, height: base.height };
}

export const FEATHER_BAR_INK: RGB = [30, 30, 60];

/** Auto case: gradientFeathers(256) on a 256×320 white canvas plus 12 bars of FEATHER_BAR_INK, widths 3/4/5 px, x0 = 12 + 19k + 0.4, y in [268, 310). */
export function feathersWithBars(): { image: RasterImage; bars: Bar[] } {
  const bars: Bar[] = [];
  for (let k = 0; k < 12; k++) {
    const x0 = 12 + 19 * k + 0.4;
    bars.push({ x0, x1: x0 + 3 + (k % 3), y0: 268, y1: 310 });
  }
  const image = pasteBelow(feathersOnCanvas(320), 256, bars.map((b) => rect(b.x0, b.y0, b.x1, b.y1, solid(FEATHER_BAR_INK))));
  return { image, bars };
}

/** The colour of the steep ramp at t in [0, 1]: (255·t, 0, 128·(1 − t)). */
export function steepRampColour(t: number): RGB {
  return [255 * t, 0, 128 * (1 - t)];
}

/** 160×128 white with a rectangle x in [40, 40 + w), y in [20, 108) painted with steepRampColour((x − 40)/w). */
export function steepRamp(w: number): { image: RasterImage; box: Bar; colourAt: (x: number) => RGB } {
  const box: Bar = { x0: 40, x1: 40 + w, y0: 20, y1: 108 };
  const colourAt = (x: number): RGB => steepRampColour(Math.min(1, Math.max(0, (x - 40) / w)));
  const image = paintCases(160, 128, WHITE, [
    rect(box.x0, box.y0, box.x1, box.y1, (x) => {
      const c = colourAt(x);
      return [c[0], c[1], c[2], 255];
    }),
  ]);
  return { image, box, colourAt };
}

/** Auto case: gradientFeathers(256) on a 256×320 white canvas plus a button x in [60.4, 90.4), y in [268.3, 308.3), R 10 → 240, G 40, B 220 → 20 along x. */
export function feathersWithRampButton(): { image: RasterImage; box: Bar } {
  const box: Bar = { x0: 60.4, x1: 90.4, y0: 268.3, y1: 308.3 };
  const image = pasteBelow(feathersOnCanvas(320), 256, [
    rect(box.x0, box.y0, box.x1, box.y1, (x) => {
      const t = (x - box.x0) / (box.x1 - box.x0);
      return [10 + 230 * t, 40, 220 - 200 * t, 255];
    }),
  ]);
  return { image, box };
}

export const SEMI_INK: RGB = [0xff, 0x88, 0x00];
export const SEMI_ALPHA = 200;

/** 128×128 transparent with a disc of radius 40 at (64, 64), SEMI_INK at alpha SEMI_ALPHA. */
export function semiTransparentDisc(): RasterImage {
  return paintCases(128, 128, null, [
    { inside: (x, y) => Math.hypot(x - 64, y - 64) < 40, colour: solid(SEMI_INK, SEMI_ALPHA) },
  ]);
}

/**
 * Auto case: 256×160 transparent with three opaque 70×80 rectangles painted with diagonal gradients (red → blue,
 * yellow → green, cyan → magenta; t = ((x − x0) + (y − y0)) / 150) at x0 = 8, 93, 178 and y0 = 8, and a disc of
 * radius 26 at (128, 128) of SEMI_INK at alpha SEMI_ALPHA.
 */
export function gradientRectsWithSemiDisc(): RasterImage {
  const ramps: Array<[RGB, RGB]> = [
    [[230, 30, 40], [40, 60, 220]],
    [[250, 220, 40], [30, 170, 60]],
    [[40, 220, 230], [220, 40, 200]],
  ];
  const shapes: PaintedCase[] = ramps.map(([a, b], k) => {
    const x0 = 8 + 85 * k;
    return rect(x0, 8, x0 + 70, 88, (x, y) => {
      const t = (x - x0 + (y - 8)) / 150;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 255];
    });
  });
  shapes.push({ inside: (x, y) => Math.hypot(x - 128, y - 128) < 26, colour: solid(SEMI_INK, SEMI_ALPHA) });
  return paintCases(256, 160, null, shapes);
}

export const LOW_BASE: RGB = [0x30, 0x60, 0xc0];

/**
 * 256×256 white with a square [28, 228)² of LOW_BASE and two inner shapes of LOW_BASE + delta per channel: a diamond
 * |x − 100| + |y − 110| < 45 and a square [160.3, 200.3) × [150.6, 190.6). inner(x, y) tells a point of the inner shapes.
 */
export function lowContrastShapes(delta: number): { image: RasterImage; inner: (x: number, y: number) => boolean } {
  const lifted: RGB = [LOW_BASE[0] + delta, LOW_BASE[1] + delta, LOW_BASE[2] + delta];
  const diamond = (x: number, y: number): boolean => Math.abs(x - 100) + Math.abs(y - 110) < 45;
  const square = (x: number, y: number): boolean => x >= 160.3 && x < 200.3 && y >= 150.6 && y < 190.6;
  const image = paintCases(256, 256, WHITE, [
    rect(28, 28, 228, 228, solid(LOW_BASE)),
    { inside: diamond, colour: solid(lifted) },
    { inside: square, colour: solid(lifted) },
  ]);
  return { image, inner: (x, y) => diamond(x, y) || square(x, y) };
}

/** The same square of LOW_BASE with a single disc of radius 50 at (128, 128) of LOW_BASE + delta. */
export function lowContrastDisc(delta: number): { image: RasterImage; inner: (x: number, y: number) => boolean } {
  const lifted: RGB = [LOW_BASE[0] + delta, LOW_BASE[1] + delta, LOW_BASE[2] + delta];
  const disc = (x: number, y: number): boolean => Math.hypot(x - 128, y - 128) < 50;
  const image = paintCases(256, 256, WHITE, [rect(28, 28, 228, 228, solid(LOW_BASE)), { inside: disc, colour: solid(lifted) }]);
  return { image, inner: disc };
}

/** radialDisc(512) with the G and B channels of column x = 240 raised by 60 inside the disc (a spurious edge that splits it). */
export function splitRadialDisc(): RasterImage {
  const rd = radialDisc(512);
  const data = Uint8ClampedArray.from(rd.image.data);
  for (let y = 0; y < 512; y++) {
    if (rd.sdf(240.5, y + 0.5) >= 0) continue;
    const o = (y * 512 + 240) * 4;
    data[o + 1] = Math.min(255, data[o + 1] + 60);
    data[o + 2] = Math.min(255, data[o + 2] + 60);
  }
  return { data, width: 512, height: 512 };
}
