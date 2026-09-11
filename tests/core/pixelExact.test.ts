import { describe, expect, it } from 'vitest';
import type { RasterImage } from '../../src/types';
import type { Rect } from '../../src/core/pixelExact';
import {
  MAX_PIXEL_RECTS,
  countMergedRects,
  downscaleNearest,
  mergeRects,
  pixelSvg,
  rectsToPathsByColor,
} from '../../src/core/pixelExact';
import { nearestUpscale, sprite32 } from '../../src/dev/synth';
import { rasterEquals } from '../fixtures/helpers';

function raster(width: number, height: number, bytes: number[]): RasterImage {
  if (bytes.length !== width * height * 4) throw new Error('raster: bytes.length');
  return { data: Uint8ClampedArray.from(bytes), width, height };
}

function packed(r: number, g: number, b: number, a: number): number {
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/** Reference rasteriser: plain fill loop over an RGBA(0,0,0,0) canvas. */
function rasterizeRects(rects: Rect[], width: number, height: number): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const r of rects) {
    const cr = (r.color >>> 24) & 0xff;
    const cg = (r.color >>> 16) & 0xff;
    const cb = (r.color >>> 8) & 0xff;
    const ca = r.color & 0xff;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const o = (y * width + x) * 4;
        data[o] = cr;
        data[o + 1] = cg;
        data[o + 2] = cb;
        data[o + 3] = ca;
      }
    }
  }
  return { data, width, height };
}

function opaqueCount(img: RasterImage): number {
  let n = 0;
  for (let o = 3; o < img.data.length; o += 4) if (img.data[o] !== 0) n++;
  return n;
}

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const NONE = [0, 0, 0, 0];

describe('downscaleNearest', () => {
  it('keeps pixel (0,0) of every k x k block', () => {
    // 4x2 image, k=2 -> 2x1: blocks' top-left pixels are (0,0) and (2,0).
    const img = raster(4, 2, [
      ...[1, 1, 1, 255], ...[2, 2, 2, 255], ...[3, 3, 3, 255], ...[4, 4, 4, 255],
      ...[5, 5, 5, 255], ...[6, 6, 6, 255], ...[7, 7, 7, 255], ...[8, 8, 8, 255],
    ]);
    const out = downscaleNearest(img, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(1);
    expect(Array.from(out.data)).toEqual([1, 1, 1, 255, 3, 3, 3, 255]);
  });

  it('keeps the partial blocks of non-multiple sizes (ceil) and k=1 copies without aliasing the input buffer', () => {
    // 5x3 with pixel (x, y) = (10x, 10y, 7): k=2 -> 3x2, blocks start at x 0, 2, 4 and y 0, 2.
    const bytes: number[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) bytes.push(10 * x, 10 * y, 7, 255);
    const img = raster(5, 3, bytes);
    const out = downscaleNearest(img, 2);
    expect([out.width, out.height]).toEqual([3, 2]);
    expect(Array.from(out.data)).toEqual([
      ...[0, 0, 7, 255], ...[20, 0, 7, 255], ...[40, 0, 7, 255],
      ...[0, 20, 7, 255], ...[20, 20, 7, 255], ...[40, 20, 7, 255],
    ]);
    const copy = downscaleNearest(img, 1);
    expect(rasterEquals(copy, img)).toBe(true);
    expect(copy.data).not.toBe(img.data);
  });

  it('downscaleNearest(nearestUpscale(sprite, 3), 3) equals the sprite byte-for-byte', () => {
    const sprite = sprite32();
    const up = nearestUpscale(sprite, 3);
    expect([up.width, up.height]).toEqual([96, 96]);
    expect(rasterEquals(downscaleNearest(up, 3), sprite)).toBe(true);
    // A different seed and a different factor too.
    const s2 = sprite32(7);
    expect(rasterEquals(downscaleNearest(nearestUpscale(s2, 5), 5), s2)).toBe(true);
  });
});

describe('mergeRects', () => {
  it('merges right then down, skips alpha 0 and returns (y, x) order', () => {
    // 4x3:
    //  R R B .
    //  R R B .
    //  . . B R
    const img = raster(4, 3, [
      ...RED, ...RED, ...BLUE, ...NONE,
      ...RED, ...RED, ...BLUE, ...NONE,
      ...NONE, ...NONE, ...BLUE, ...RED,
    ]);
    expect(mergeRects(img)).toEqual([
      { x: 0, y: 0, w: 2, h: 2, color: packed(255, 0, 0, 255) },
      { x: 2, y: 0, w: 1, h: 3, color: packed(0, 0, 255, 255) },
      { x: 3, y: 2, w: 1, h: 1, color: packed(255, 0, 0, 255) },
    ]);
  });

  it('prefers the horizontal run (greedy right) even when a taller rect would be possible', () => {
    // 2x2 all red -> one 2x2 rect. 3x2 with the bottom-right missing -> 3x1 + 2x1.
    const solid = raster(2, 2, [...RED, ...RED, ...RED, ...RED]);
    expect(mergeRects(solid)).toEqual([{ x: 0, y: 0, w: 2, h: 2, color: packed(255, 0, 0, 255) }]);
    const l = raster(3, 2, [...RED, ...RED, ...RED, ...RED, ...RED, ...NONE]);
    expect(mergeRects(l)).toEqual([
      { x: 0, y: 0, w: 3, h: 1, color: packed(255, 0, 0, 255) },
      { x: 0, y: 1, w: 2, h: 1, color: packed(255, 0, 0, 255) },
    ]);
  });

  it('distinguishes colours by all four channels (alpha and RGB) and skips alpha-0 with RGB set', () => {
    const img = raster(3, 1, [10, 20, 30, 255, 10, 20, 30, 128, 99, 99, 99, 0]);
    expect(mergeRects(img)).toEqual([
      { x: 0, y: 0, w: 1, h: 1, color: packed(10, 20, 30, 255) },
      { x: 1, y: 0, w: 1, h: 1, color: packed(10, 20, 30, 128) },
    ]);
    expect(mergeRects({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toEqual([]);
    expect(mergeRects(raster(2, 2, [...NONE, ...NONE, ...NONE, ...NONE]))).toEqual([]);
  });

  it('sprite32: fewer rects than opaque pixels, and rasterising them back reproduces the input exactly', () => {
    for (const seed of [1, 2, 3]) {
      const sprite = sprite32(seed);
      const rects = mergeRects(sprite);
      const opaque = opaqueCount(sprite);
      expect(opaque).toBeGreaterThan(0);
      expect(rects.length).toBeGreaterThan(0);
      expect(rects.length).toBeLessThan(opaque);
      // No overlap: total rect area equals the number of opaque pixels.
      let area = 0;
      for (const r of rects) area += r.w * r.h;
      expect(area).toBe(opaque);
      expect(rasterEquals(rasterizeRects(rects, 32, 32), sprite)).toBe(true);
      // Scan order.
      for (let i = 1; i < rects.length; i++) {
        const a = rects[i - 1];
        const b = rects[i];
        expect(a.y < b.y || (a.y === b.y && a.x < b.x)).toBe(true);
      }
    }
  });

  it('does not mutate its input', () => {
    const sprite = sprite32(4);
    const copy = Uint8ClampedArray.from(sprite.data);
    mergeRects(sprite);
    expect(Array.from(sprite.data)).toEqual(Array.from(copy));
  });
});

describe('rectsToPathsByColor', () => {
  it('emits relative moves from the previous rect origin, grouped by colour in order of appearance', () => {
    const rects: Rect[] = [
      { x: 3, y: 4, w: 2, h: 1, color: packed(255, 0, 0, 255) },
      { x: 0, y: 5, w: 1, h: 3, color: packed(0, 0, 255, 255) },
      { x: 1, y: 6, w: 4, h: 2, color: packed(255, 0, 0, 255) },
    ];
    expect(rectsToPathsByColor(rects)).toEqual([
      { fill: '#ff0000', d: 'm3 4h2v1h-2zm-2 2h4v2h-4z' },
      { fill: '#0000ff', d: 'm0 5h1v3h-1z' },
    ]);
  });

  it('omits the space before a negative dy and adds opacity for alpha < 255', () => {
    const rects: Rect[] = [
      { x: 5, y: 5, w: 1, h: 1, color: packed(1, 2, 3, 128) },
      { x: 7, y: 2, w: 1, h: 1, color: packed(1, 2, 3, 128) },
    ];
    expect(rectsToPathsByColor(rects)).toEqual([{ fill: '#010203', opacity: 0.502, d: 'm5 5h1v1h-1zm2-3h1v1h-1z' }]);
    expect(rectsToPathsByColor([])).toEqual([]);
  });
});

describe('pixelSvg', () => {
  it('has the contract attributes, crispEdges, fill-opacity for alpha < 255 and the rect count', () => {
    const img = raster(3, 2, [...RED, ...RED, ...[0, 0, 255, 128], ...NONE, ...RED, ...NONE]);
    const { svg, rectCount } = pixelSvg(img, 4);
    expect(rectCount).toBe(3);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8" viewBox="0 0 3 2" shape-rendering="crispEdges">')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('<path fill="#ff0000" d="m0 0h2v1h-2zm1 1h1v1h-1z"/>');
    expect(svg).toContain('<path fill="#0000ff" fill-opacity="0.502" d="m2 0h1v1h-1z"/>');
    expect((svg.match(/<path /g) ?? []).length).toBe(2);
    expect(svg).not.toContain('<?xml');
  });

  it('sprite32 at k=3: 96x96 canvas, 32x32 viewBox, one path per colour, no fill-opacity', () => {
    const sprite = sprite32();
    const { svg, rectCount } = pixelSvg(sprite, 3);
    expect(rectCount).toBe(mergeRects(sprite).length);
    expect(svg).toContain('width="96" height="96" viewBox="0 0 32 32"');
    expect(svg).not.toContain('fill-opacity');
    const fills = new Set(svg.match(/fill="#[0-9a-f]{6}"/g));
    expect(fills.size).toBeGreaterThanOrEqual(2);
    expect(fills.size).toBeLessThanOrEqual(6);
    // Every path is a sequence of m/h/v/z commands with integers only.
    for (const m of svg.matchAll(/ d="([^"]*)"/g)) expect(m[1]).toMatch(/^(m-?\d+ ?-?\d+h\d+v\d+h-\d+z)+$/);
  });

  it('a source size k does not divide: width/height and viewBox in source pixels, edge rects clipped', () => {
    // Logical 2x2 (R B / B R), k = 3, source 5x4: the right column is 2 px wide, the bottom row 1 px tall.
    const img = raster(2, 2, [...RED, ...BLUE, ...BLUE, ...RED]);
    const { svg, rectCount } = pixelSvg(img, 3, MAX_PIXEL_RECTS, { width: 5, height: 4 });
    expect(rectCount).toBe(4);
    expect(
      svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="4" viewBox="0 0 5 4" shape-rendering="crispEdges">'),
    ).toBe(true);
    expect(svg).toContain('<path fill="#ff0000" d="m0 0h3v3h-3zm3 3h2v1h-2z"/>');
    expect(svg).toContain('<path fill="#0000ff" d="m3 0h2v3h-2zm-3 3h3v1h-3z"/>');
    // The exact size changes nothing; a size that does not hold exactly 2 blocks per side is rejected.
    expect(pixelSvg(img, 3, MAX_PIXEL_RECTS, { width: 6, height: 6 }).svg).toBe(pixelSvg(img, 3).svg);
    expect(() => pixelSvg(img, 3, MAX_PIXEL_RECTS, { width: 3, height: 6 })).toThrow(RangeError);
    expect(() => pixelSvg(img, 3, MAX_PIXEL_RECTS, { width: 6, height: 7 })).toThrow(RangeError);
  });

  it('empty image -> empty svg with 0 rects', () => {
    const { svg, rectCount } = pixelSvg(raster(2, 1, [...NONE, ...NONE]), 2);
    expect(rectCount).toBe(0);
    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2" viewBox="0 0 2 1" shape-rendering="crispEdges">\n</svg>');
  });
});

describe('rectangle cap', () => {
  it('countMergedRects counts exactly what mergeRects returns, without building rects', () => {
    for (const seed of [1, 2, 3]) expect(countMergedRects(sprite32(seed))).toBe(mergeRects(sprite32(seed)).length);
    const bytes: number[] = [];
    for (let i = 0; i < 50 * 50; i++) bytes.push((i * 37) % 3 === 0 ? 255 : 0, (i * 11) % 2 === 0 ? 255 : 0, 0, (i * 13) % 5 === 0 ? 0 : 255);
    const noise = raster(50, 50, bytes);
    expect(countMergedRects(noise)).toBe(mergeRects(noise).length);
    expect(countMergedRects({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toBe(0);
    expect(countMergedRects(raster(2, 1, [...NONE, ...NONE]))).toBe(0);
  });

  it('pixelSvg does not serialise above maxRects: svg "" with the exact rect count', () => {
    expect(MAX_PIXEL_RECTS).toBe(200_000);
    const sprite = sprite32();
    const n = mergeRects(sprite).length;
    expect(pixelSvg(sprite, 1, n).svg.startsWith('<svg')).toBe(true);
    const capped = pixelSvg(sprite, 1, n - 1);
    expect(capped.svg).toBe('');
    expect(capped.rectCount).toBe(n);
    // Default cap: the sprite is far below it.
    expect(pixelSvg(sprite, 1).svg).toBe(pixelSvg(sprite, 1, n).svg);
  });
});
