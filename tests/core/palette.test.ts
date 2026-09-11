import { describe, expect, it } from 'vitest';
import type { LabelMap, RasterImage, RGB } from '../../src/types';
import {
  assignLabels,
  buildPalette,
  colorDistance2,
  consolidatePalette,
  distinctColorCount,
  exactPalette,
  exactPaletteDetailed,
  kmeansRefine,
  offPaletteRatio,
  paletteError,
  medianCut,
  quantizedHistogram,
  toHex,
} from '../../src/core/palette';
import { coverage, flatShapes3, noisePhoto, sprite32 } from '../../src/dev/synth';
import { ACCENT_NAVY, ACCENT_RED, RING_FILL, RING_INK, accentIcon, ringedDisc } from '../fixtures/shapes';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function raster(width: number, height: number, bytes: number[]): RasterImage {
  if (bytes.length !== width * height * 4) throw new Error('raster: bytes.length');
  return { data: Uint8ClampedArray.from(bytes), width, height };
}

/** Solid image of one RGBA colour. */
function solid(width: number, height: number, rgba: [number, number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let o = 0; o < data.length; o += 4) data.set(rgba, o);
  return { data, width, height };
}

/** Fills the w x h rectangle at (x0, y0) with `rgba` (in place). */
function rect(img: RasterImage, x0: number, y0: number, w: number, h: number, rgba: [number, number, number, number]): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.data.set(rgba, (y * img.width + x) * 4);
}

/** Sort a palette lexicographically for order-independent comparisons. */
function sorted(p: RGB[]): RGB[] {
  return [...p].map((c) => [...c] as RGB).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

/** Max per-channel absolute difference between `c` and its nearest colour of `palette`. */
function nearestMaxDiff(c: RGB, palette: RGB[]): number {
  let best = Infinity;
  for (const p of palette) {
    const d = Math.max(Math.abs(p[0] - c[0]), Math.abs(p[1] - c[1]), Math.abs(p[2] - c[2]));
    if (d < best) best = d;
  }
  return best;
}

function key(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

function isPurePixel(img: RasterImage, i: number, palette: RGB[]): boolean {
  const o = i * 4;
  return palette.some((c) => img.data[o] === c[0] && img.data[o + 1] === c[1] && img.data[o + 2] === c[2]);
}

function sameLabels(a: LabelMap, b: LabelMap): boolean {
  if (a.count !== b.count || a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

const FLAT_BG: RGB = [0xf2, 0xe8, 0xd5];
const FLAT_CIRCLE: RGB = [0x2a, 0x6f, 0x97];
const FLAT_RECT: RGB = [0xe0, 0x7a, 0x5f];

// ---------------------------------------------------------------------------------------------
// colorDistance2 / toHex
// ---------------------------------------------------------------------------------------------

describe('colorDistance2', () => {
  it('is 0 for identical colours and symmetric', () => {
    expect(colorDistance2([10, 20, 30], [10, 20, 30])).toBe(0);
    expect(colorDistance2([0, 0, 0], [255, 255, 255])).toBeCloseTo(
      colorDistance2([255, 255, 255], [0, 0, 0]),
      9,
    );
  });

  it('applies the per-channel weights (0.5054, 0.9925, 0.4342) to the deltas', () => {
    expect(colorDistance2([10, 0, 0], [0, 0, 0])).toBeCloseTo(0.5054 * 0.5054 * 100, 9);
    expect(colorDistance2([0, 10, 0], [0, 0, 0])).toBeCloseTo(0.9925 * 0.9925 * 100, 9);
    expect(colorDistance2([0, 0, 10], [0, 0, 0])).toBeCloseTo(0.4342 * 0.4342 * 100, 9);
    // Green dominates: a green delta of 10 is farther than a red delta of 19.
    expect(colorDistance2([0, 10, 0], [0, 0, 0])).toBeGreaterThan(colorDistance2([19, 0, 0], [0, 0, 0]));
  });
});

describe('toHex', () => {
  it('formats lowercase #rrggbb with zero padding', () => {
    expect(toHex([0, 0, 0])).toBe('#000000');
    expect(toHex([255, 255, 255])).toBe('#ffffff');
    expect(toHex([0x2a, 0x6f, 0x97])).toBe('#2a6f97');
    expect(toHex([1, 2, 3])).toBe('#010203');
  });

  it('rounds and clamps components', () => {
    expect(toHex([255.4, -3, 300])).toBe('#ff00ff');
    expect(toHex([9.5, 10.49, 0])).toBe('#0a0a00');
  });
});

// ---------------------------------------------------------------------------------------------
// quantizedHistogram / distinctColorCount
// ---------------------------------------------------------------------------------------------

describe('quantizedHistogram', () => {
  it('keys by 5-bit (r>>3<<10 | g>>3<<5 | b>>3) and keeps real sums', () => {
    // Two pixels in the same bin (250,250,250)/(255,255,255) + one distinct pixel.
    const img = raster(3, 1, [250, 250, 250, 255, 255, 255, 255, 255, 10, 20, 30, 255]);
    const h = quantizedHistogram(img, null);
    expect(h.size).toBe(2);
    const white = h.get(key(255, 255, 255));
    expect(white).toBeDefined();
    expect(white!.count).toBe(2);
    expect(white!.sum).toEqual([505, 505, 505]);
    const dark = h.get(key(10, 20, 30));
    expect(dark).toEqual({ count: 1, sum: [10, 20, 30] });
  });

  it('with bg null ignores alpha < 128 but counts alpha >= 128', () => {
    const img = raster(3, 1, [10, 10, 10, 0, 20, 20, 20, 127, 30, 30, 30, 128]);
    const h = quantizedHistogram(img, null);
    expect(h.size).toBe(1);
    expect(h.get(key(30, 30, 30))).toEqual({ count: 1, sum: [30, 30, 30] });
  });

  it('with a bg composites every pixel over it (alpha 0 -> bg, alpha 255 -> src, partial -> blend)', () => {
    const img = raster(3, 1, [10, 10, 10, 0, 0, 0, 0, 255, 0, 0, 0, 128]);
    const h = quantizedHistogram(img, [255, 255, 255]);
    // alpha 0 -> (255,255,255); alpha 255 -> (0,0,0); alpha 128 -> round(127*255/255) = 127
    expect(h.get(key(255, 255, 255))).toEqual({ count: 1, sum: [255, 255, 255] });
    expect(h.get(key(0, 0, 0))).toEqual({ count: 1, sum: [0, 0, 0] });
    expect(h.get(key(127, 127, 127))).toEqual({ count: 1, sum: [127, 127, 127] });
    expect(h.size).toBe(3);
  });

  it('returns keys in ascending order and handles an empty image', () => {
    const img = raster(2, 1, [200, 0, 0, 255, 0, 0, 200, 255]);
    expect([...quantizedHistogram(img, null).keys()]).toEqual([key(0, 0, 200), key(200, 0, 0)]);
    expect(quantizedHistogram({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, null).size).toBe(0);
  });
});

describe('distinctColorCount', () => {
  it('counts only colours reaching the population ratio (default 0.05 %)', () => {
    // 4000 px: 3999 white + 1 red -> red is 0.025 % < 0.05 % -> 1 colour. minRatio 0 -> 2.
    const img = solid(4000, 1, [255, 255, 255, 255]);
    img.data.set([255, 0, 0, 255], 0);
    expect(distinctColorCount(img)).toBe(1);
    expect(distinctColorCount(img, 0)).toBe(2);
    expect(distinctColorCount(img, 0.0002)).toBe(2); // 1/4000 = 0.025 % >= 0.02 %
  });

  it('ignores transparent pixels and returns 0 for an empty / fully transparent image', () => {
    expect(distinctColorCount({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toBe(0);
    expect(distinctColorCount(solid(4, 4, [1, 2, 3, 0]))).toBe(0);
    expect(distinctColorCount(sprite32())).toBeLessThanOrEqual(6);
    expect(distinctColorCount(sprite32())).toBeGreaterThanOrEqual(2);
  });

  it('flatShapes3 <= 32 colours (few AA blends), noisePhoto > 200', () => {
    expect(distinctColorCount(flatShapes3().image)).toBeLessThanOrEqual(32);
    expect(distinctColorCount(flatShapes3().image)).toBeGreaterThanOrEqual(3);
    expect(distinctColorCount(noisePhoto())).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------------------------
// exactPalette
// ---------------------------------------------------------------------------------------------

describe('exactPalette', () => {
  it('returns exactly the 3 colours of flatShapes3, each within ±2 per channel', () => {
    const { image, palette } = flatShapes3();
    const p = exactPalette(image);
    expect(p).not.toBeNull();
    expect(p!.length).toBe(3);
    for (const c of palette) expect(nearestMaxDiff(c, p!)).toBeLessThanOrEqual(2);
    // Most populous first: background, then rect, then the (partly covered) circle.
    expect(nearestMaxDiff(FLAT_BG, [p![0]])).toBeLessThanOrEqual(2);
    expect(nearestMaxDiff(FLAT_RECT, [p![1]])).toBeLessThanOrEqual(2);
    expect(nearestMaxDiff(FLAT_CIRCLE, [p![2]])).toBeLessThanOrEqual(2);
  });

  it('excludes AA blends between two dominant colours: a 1-px mid-grey seam between white and black', () => {
    // 30x100: white | grey 128 seam (x = 15) | black. The seam is 3.3 % of the pixels, sits at
    // t = 0.5 of the white-black segment and every one of its pixels lies between a white and a
    // black neighbour: an anti-aliasing blend, whatever its population.
    const img = solid(30, 100, [255, 255, 255, 255]);
    for (let y = 0; y < 100; y++) {
      img.data.set([128, 128, 128, 255], (y * 30 + 15) * 4);
      for (let x = 16; x < 30; x++) img.data.set([0, 0, 0, 255], (y * 30 + x) * 4);
    }
    expect(sorted(exactPalette(img)!)).toEqual([
      [0, 0, 0],
      [255, 255, 255],
    ]);
  });

  it('keeps a genuine colour that lies on the segment between two dominants: regions are not blends', () => {
    // 199x199 white with a black AA disc (6600 px) and a grey-128 AA disc (6362 px), apart.
    const size = 199;
    const covA = coverage(size, (x, y) => Math.hypot(x - 50, y - 100) - Math.sqrt(6600 / Math.PI));
    const covB = coverage(size, (x, y) => Math.hypot(x - 148, y - 100) - Math.sqrt(6362 / Math.PI));
    const discs = solid(size, size, [255, 255, 255, 255]);
    for (let p = 0; p < size * size; p++) {
      const v = Math.round(255 * (1 - covA[p] - covB[p]) + 128 * covB[p]);
      discs.data.set([v, v, v, 255], p * 4);
    }
    const p1 = exactPalette(discs)!;
    // Before: [white, black] — the grey disc was taken for anti-aliasing (0.15 < t < 0.85).
    expect(p1.length).toBe(3);
    expect(nearestMaxDiff([255, 255, 255], p1)).toBeLessThanOrEqual(2);
    expect(nearestMaxDiff([0, 0, 0], p1)).toBeLessThanOrEqual(2);
    expect(nearestMaxDiff([128, 128, 128], p1)).toBeLessThanOrEqual(2);

    // Three flat greys without any AA: background 192, 24x24 squares of 64 and 30 in 96x96.
    // 64 lies on the 192-30 segment at t = 0.79. Before: [192, 30].
    const greys = solid(96, 96, [192, 192, 192, 255]);
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 96; x++) {
        if (x >= 10 && x < 34 && y >= 10 && y < 34) greys.data.set([64, 64, 64, 255], (y * 96 + x) * 4);
        if (x >= 60 && x < 84 && y >= 60 && y < 84) greys.data.set([30, 30, 30, 255], (y * 96 + x) * 4);
      }
    }
    expect(sorted(exactPalette(greys)!)).toEqual([
      [30, 30, 30],
      [64, 64, 64],
      [192, 192, 192],
    ]);
  });

  it('keeps a colour that is off the segment (distance >= 12) or beyond its ends', () => {
    // Mid grey pushed 20 units off the black-white diagonal -> a real third colour.
    const img = solid(1000, 1, [255, 255, 255, 255]);
    for (let i = 600; i < 900; i++) img.data.set([0, 0, 0, 255], i * 4);
    for (let i = 900; i < 1000; i++) img.data.set([148, 128, 108, 255], i * 4);
    expect(exactPalette(img)!.length).toBe(3);
    expect(nearestMaxDiff([148, 128, 108], exactPalette(img)!)).toBe(0);
    // A colour beyond an endpoint (t > 1 on the segment grey -> white) is kept too.
    const img2 = solid(1000, 1, [200, 200, 200, 255]);
    for (let i = 600; i < 900; i++) img2.data.set([100, 100, 100, 255], i * 4);
    for (let i = 900; i < 1000; i++) img2.data.set([255, 255, 255, 255], i * 4);
    expect(exactPalette(img2)!.length).toBe(3);
  });

  it('merges near-identical colours (< 12 apart) and returns the real average', () => {
    // Two bins 8 apart in red, 500 px each -> one cluster with average red 254.
    const img = solid(1000, 1, [250, 100, 100, 255]);
    for (let i = 500; i < 1000; i++) img.data.set([255, 100, 100, 255], i * 4);
    for (let i = 0; i < 100; i++) img.data.set([0, 0, 0, 255], i * 4);
    const p = exactPalette(img)!;
    expect(p.length).toBe(2);
    // 400 px at 250 + 500 px at 255 -> 252.78 -> 253
    expect(p[0]).toEqual([253, 100, 100]);
    expect(p[1]).toEqual([0, 0, 0]);
  });

  it('returns null when more than maxColors REAL colours remain AFTER AA exclusion', () => {
    expect(exactPalette(noisePhoto())).toBeNull();
    const { image } = flatShapes3();
    // flatShapes3 has 3 flat colours plus a handful of AA bins above 0.05 %: the AA bins are
    // blends, so the cap only counts the 3 real clusters.
    const populated = distinctColorCount(image);
    expect(populated).toBeGreaterThan(3);
    expect(exactPalette(image, 3)!.length).toBe(3);
    expect(exactPalette(image, 2)).toBeNull();
    expect(exactPalette(image, populated)!.length).toBe(3);
  });

  it('drops clusters without spatial coherence and reassigns their pixels (exactPaletteDetailed reports counts)', () => {
    // 100x100 white, a 30x30 black square and 40 isolated red pixels (0.4 %): no red pixel has its 8
    // neighbours red, so red has no core and its pixels are counted for the nearest cluster (black),
    // whose colour stays black.
    const img = solid(100, 100, [255, 255, 255, 255]);
    rect(img, 10, 10, 30, 30, [0, 0, 0, 255]);
    for (let i = 0; i < 40; i++) img.data.set([200, 0, 0, 255], ((60 + 4 * Math.floor(i / 10)) * 100 + 50 + 2 * (i % 10)) * 4);
    const r = exactPaletteDetailed(img)!;
    expect(r.total).toBe(10000);
    expect(r.colors.length).toBe(2);
    expect(r.counts).toEqual([9060, 940]);
    expect(r.colors[0]).toEqual([255, 255, 255]);
    expect(r.colors[1]).toEqual([0, 0, 0]);
    // A solid 6x6 red block (36 px, 0.36 %: under the old 0.5 % floor) has 16 core px >= 12 and
    // survives. A 5x5 block has only 9 core px: it survives as a distinct feature (one piece, far
    // from white and black), but the same block in a dark red close to black does not.
    const six = solid(100, 100, [255, 255, 255, 255]);
    rect(six, 10, 10, 30, 30, [0, 0, 0, 255]);
    rect(six, 60, 60, 6, 6, [200, 0, 0, 255]);
    expect(exactPaletteDetailed(six)!.colors).toEqual([[255, 255, 255], [0, 0, 0], [200, 0, 0]]);
    const five = solid(100, 100, [255, 255, 255, 255]);
    rect(five, 10, 10, 30, 30, [0, 0, 0, 255]);
    rect(five, 60, 60, 5, 5, [200, 0, 0, 255]);
    expect(exactPaletteDetailed(five)!.colors).toEqual([[255, 255, 255], [0, 0, 0], [200, 0, 0]]);
    const shade = solid(100, 100, [255, 255, 255, 255]);
    rect(shade, 10, 10, 30, 30, [0, 0, 0, 255]);
    rect(shade, 60, 60, 5, 5, [60, 20, 20, 255]);
    const shaded = exactPaletteDetailed(shade)!;
    expect(shaded.colors).toEqual([[255, 255, 255], [0, 0, 0]]);
    expect(shaded.counts).toEqual([10000 - 925, 925]);
    // A non-positive ratio disables the rule. With an unreachable core minimum the largest cluster
    // still survives, the black square only as a distinct feature (the red specks are fragments),
    // and a pale grey square close to white not at all.
    expect(exactPaletteDetailed(shade, 32, 0)!.colors.length).toBe(3);
    expect(exactPaletteDetailed(img, 32, 0.99)!.colors).toEqual([[255, 255, 255], [0, 0, 0]]);
    const pale = solid(100, 100, [255, 255, 255, 255]);
    rect(pale, 10, 10, 30, 30, [230, 230, 230, 255]);
    expect(exactPaletteDetailed(pale, 32, 0.99)!.colors).toEqual([[255, 255, 255]]);
  });

  it('drops a 1 px ringing outline and keeps a small solid accent (clip_art-like)', () => {
    // 120x80 white; a magenta bar with a 1 px darker outline (a JPEG ringing band, 164 px = 1.7 %,
    // which the old 0.5 % floor kept) and an 8x6 orange block (48 px, 0.5 %).
    const img = solid(120, 80, [255, 255, 255, 255]);
    rect(img, 19, 19, 62, 22, [180, 20, 100, 255]);
    rect(img, 20, 20, 60, 20, [230, 0, 126, 255]);
    rect(img, 95, 50, 8, 6, [250, 176, 53, 255]);
    const p = exactPalette(img)!;
    expect(p).toHaveLength(3);
    expect(p).toContainEqual([255, 255, 255]);
    expect(p).toContainEqual([250, 176, 53]);
    // The outline pixels are counted for the nearest cluster (magenta), whose colour stays exact.
    expect(p).toContainEqual([230, 0, 126]);
    expect(exactPaletteDetailed(img)!.counts).toEqual([120 * 80 - 1364 - 48, 1364, 48]);
  });

  it('keeps a thin outline whose colour is far from every coherent colour (1 to 2 px dark ring), opaque and on transparency', () => {
    // The ring has no pixel with 8 dark neighbours, like a ringing band, but it is one connected
    // piece far from the yellow fill and the white paper: dropping it repainted the outline yellow.
    for (const width of [1, 1.5, 2, 3]) {
      for (const transparent of [false, true]) {
        const label = `${width} px${transparent ? ' transparent' : ''}`;
        const p = exactPalette(ringedDisc({ width, transparent }).image)!;
        expect(p, label).not.toBeNull();
        expect(p.length, label).toBe(transparent ? 2 : 3);
        // The mean of a 1 px ring includes its anti-aliased pixels: (35, 33, 24) on white.
        expect(nearestMaxDiff(RING_INK, p), label).toBeLessThanOrEqual(width === 1 ? 16 : 8);
        expect(nearestMaxDiff(RING_FILL, p), label).toBeLessThanOrEqual(2);
      }
    }
  });

  it('keeps a small distinct accent of a small icon (a 16 px red dot with 4 core px)', () => {
    const p = exactPalette(accentIcon())!;
    expect(p).toHaveLength(3);
    expect(nearestMaxDiff([255, 255, 255], p)).toBeLessThanOrEqual(2);
    expect(nearestMaxDiff(ACCENT_NAVY, p)).toBeLessThanOrEqual(4);
    expect(nearestMaxDiff(ACCENT_RED, p)).toBeLessThanOrEqual(8);
  });

  it('ignores transparent pixels; [] for an empty image; single colour -> 1 entry', () => {
    const img = solid(10, 10, [7, 8, 9, 255]);
    img.data.set([200, 0, 0, 0], 0);
    expect(exactPalette(img)).toEqual([[7, 8, 9]]);
    expect(exactPalette({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toEqual([]);
    expect(exactPalette(solid(4, 4, [1, 2, 3, 0]))).toEqual([]);
    const p = exactPalette(sprite32());
    expect(p).not.toBeNull();
    expect(p!.length).toBeLessThanOrEqual(6);
    for (const c of p!) expect(c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)).toBe(true);
  });

  it('is deterministic', () => {
    const { image } = flatShapes3();
    expect(exactPalette(image)).toEqual(exactPalette(image));
  });
});

// ---------------------------------------------------------------------------------------------
// medianCut / kmeansRefine / buildPalette
// ---------------------------------------------------------------------------------------------

describe('medianCut + kmeansRefine', () => {
  it('flatShapes3 with k=3 lands within ±6 of the true colours after refinement', () => {
    const { image, palette } = flatShapes3();
    const mc = medianCut(image, 3);
    expect(mc.length).toBe(3);
    const refined = kmeansRefine(image, mc);
    expect(refined.length).toBe(3);
    for (const c of palette) expect(nearestMaxDiff(c, refined)).toBeLessThanOrEqual(6);
    // Refinement never makes things worse on this fixture.
    for (const c of palette) expect(nearestMaxDiff(c, mc)).toBeLessThanOrEqual(12);
  });

  it('medianCut returns exact colours for a two-colour image and fewer than k when there are fewer bins', () => {
    const img = solid(100, 1, [0, 0, 0, 255]);
    for (let i = 40; i < 100; i++) img.data.set([255, 255, 255, 255], i * 4);
    expect(medianCut(img, 2)).toEqual([
      [255, 255, 255],
      [0, 0, 0],
    ]);
    expect(medianCut(img, 8)).toEqual([
      [255, 255, 255],
      [0, 0, 0],
    ]);
    expect(medianCut(img, 1)).toEqual([[153, 153, 153]]); // 60*255/100 = 153
    expect(medianCut(img, 0)).toEqual([]);
    expect(medianCut({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, 4)).toEqual([]);
  });

  it('medianCut splits along the widest axis first (population-weighted median)', () => {
    // Four colours in a line along blue, equal population -> k=2 splits them 2/2.
    const img = solid(400, 1, [0, 0, 0, 255]);
    for (let i = 100; i < 200; i++) img.data.set([0, 0, 60, 255], i * 4);
    for (let i = 200; i < 300; i++) img.data.set([0, 0, 180, 255], i * 4);
    for (let i = 300; i < 400; i++) img.data.set([0, 0, 240, 255], i * 4);
    expect(sorted(medianCut(img, 2))).toEqual([
      [0, 0, 30],
      [0, 0, 210],
    ]);
  });

  it('kmeansRefine keeps the palette order, uses a deterministic stride sample and clamps', () => {
    const img = noisePhoto();
    const p0 = medianCut(img, 4);
    const a = kmeansRefine(img, p0, 10, 20000);
    const b = kmeansRefine(img, p0, 10, 20000);
    expect(a).toEqual(b);
    expect(a.length).toBe(4);
    for (const c of a) expect(c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)).toBe(true);
    // A tiny sample still works (stride > 1) and 0 iterations returns the input palette.
    expect(kmeansRefine(img, p0, 10, 50).length).toBe(4);
    expect(kmeansRefine(img, p0, 0)).toEqual(p0);
    expect(kmeansRefine(img, [])).toEqual([]);
  });

  it('kmeansRefine moves a rough guess onto the real cluster means', () => {
    const img = solid(200, 1, [10, 10, 10, 255]);
    for (let i = 100; i < 200; i++) img.data.set([200, 200, 200, 255], i * 4);
    expect(kmeansRefine(img, [[0, 0, 0], [255, 255, 255]])).toEqual([
      [10, 10, 10],
      [200, 200, 200],
    ]);
  });

  it('consolidatePalette merges clusters closer than 20 (weighted) and drops clusters without coherence', () => {
    // 100x100: 6 000 px at (100,100,100), 3 000 at (100,110,100) [weighted 9.9 apart], a red band
    // of 960 px and 40 isolated blue pixels inside it (0.4 %, no core).
    const img = solid(100, 100, [100, 100, 100, 255]);
    rect(img, 0, 60, 100, 30, [100, 110, 100, 255]);
    rect(img, 0, 90, 100, 10, [255, 0, 0, 255]);
    for (let i = 0; i < 40; i++) img.data.set([0, 0, 255, 255], ((i < 20 ? 92 : 97) * 100 + 1 + 5 * (i % 20)) * 4);
    const p = consolidatePalette(img, [
      [100, 100, 100],
      [100, 110, 100],
      [255, 0, 0],
      [0, 0, 255],
    ]);
    // Grey: 6000*100 + 3000*110 -> G 102.9; the 40 dropped blue pixels are reassigned to the
    // nearest survivor (grey, weighted 132 vs red 170) -> B (9000*100 + 40*255)/9040 = 100.7.
    expect(p).toEqual([
      [100, 103, 101],
      [255, 0, 0],
    ]);
    // Palettes of 0/1 colours pass through; a palette entry nobody maps to disappears.
    expect(consolidatePalette(img, [])).toEqual([]);
    expect(consolidatePalette(img, [[7, 7, 7]])).toEqual([[7, 7, 7]]);
    expect(consolidatePalette(img, [[100, 105, 100], [255, 0, 0], [250, 250, 250]])).toEqual([
      [100, 103, 101],
      [255, 0, 0],
    ]);
    // Without the coherence rule the blue specks stay.
    expect(consolidatePalette(img, [[100, 100, 100], [100, 110, 100], [255, 0, 0], [0, 0, 255]], undefined, undefined, 0)).toHaveLength(3);
  });

  it('consolidatePalette keeps a thin distinct outline and a small distinct accent, like the exact palette', () => {
    // Same result as with the coherence rule disabled: k-means centres of thin features drift towards
    // their anti-aliasing ((55, 52, 36) for the 1.5 px ring, (36, 35, 28) at 3 px), with or without it.
    const ringImage = ringedDisc({ width: 1.5 }).image;
    const start: RGB[] = [[255, 255, 255], RING_FILL, RING_INK];
    const ring = consolidatePalette(ringImage, start);
    expect(ring).toHaveLength(3);
    expect(ring).toEqual(consolidatePalette(ringImage, start, undefined, undefined, 0));
    expect(Math.max(...ring[2])).toBeLessThanOrEqual(64);
    const icon = consolidatePalette(accentIcon(), [[255, 255, 255], ACCENT_NAVY, ACCENT_RED]);
    expect(icon).toHaveLength(3);
    expect(nearestMaxDiff(ACCENT_RED, icon)).toBeLessThanOrEqual(8);
  });

  it('paletteError and offPaletteRatio measure how well a palette covers the pixels', () => {
    const { image, palette } = flatShapes3();
    expect(paletteError(image, palette)).toBeLessThan(1);
    expect(offPaletteRatio(image, palette)).toBeLessThan(0.02);
    // A single mid colour for a two-colour image: half the pixels far off, big error.
    const img = solid(200, 1, [0, 0, 0, 255]);
    for (let i = 100; i < 200; i++) img.data.set([255, 255, 255, 255], i * 4);
    expect(offPaletteRatio(img, [[0, 0, 0]])).toBe(0.5);
    expect(offPaletteRatio(img, [[0, 0, 0]], 450)).toBe(0); // white is 441.7 from black
    expect(paletteError(img, [[0, 0, 0]])).toBeCloseTo(Math.sqrt(colorDistance2([0, 0, 0], [255, 255, 255])) / 2, 6);
    expect(paletteError(img, [[0, 0, 0], [255, 255, 255]])).toBe(0);
    // Degenerate inputs.
    expect(paletteError(img, [])).toBe(0);
    expect(offPaletteRatio(img, [])).toBe(1);
    expect(offPaletteRatio(solid(4, 4, [1, 2, 3, 0]), [[0, 0, 0]])).toBe(0);
    // noisePhoto: an 8-colour palette leaves most pixels off (> 50 %).
    const noise = noisePhoto();
    expect(offPaletteRatio(noise, buildPalette(noise, 8, false))).toBeGreaterThan(0.5);
  });

  it('buildPalette: exact when possible, otherwise medianCut + k-means with the requested size', () => {
    const { image } = flatShapes3();
    expect(buildPalette(image, 'auto', true).length).toBe(3);
    expect(buildPalette(image, 4, true).length).toBe(3); // exact fits in 4 -> exact
    expect(buildPalette(image, 2, true).length).toBe(2); // exact does not fit -> medianCut(2)
    expect(buildPalette(image, 3, false).length).toBe(3);
    // Photo: 'auto' falls back to 8 colours, explicit 16 -> 16.
    expect(buildPalette(noisePhoto(), 'auto', true).length).toBe(8);
    expect(buildPalette(noisePhoto(), 16, true).length).toBe(16);
  });
});

// ---------------------------------------------------------------------------------------------
// assignLabels
// ---------------------------------------------------------------------------------------------

describe('assignLabels', () => {
  it('agrees with the flatShapes3 ground truth on >= 98 % of the pure (coverage 0 or 1) pixels', () => {
    const { image, labels, palette } = flatShapes3();
    const lm = assignLabels(image, palette);
    expect(lm.count).toBe(3);
    expect(lm.width).toBe(96);
    expect(lm.height).toBe(96);
    let pure = 0;
    let agree = 0;
    for (let i = 0; i < lm.data.length; i++) {
      if (!isPurePixel(image, i, palette)) continue;
      pure++;
      if (lm.data[i] === labels.data[i]) agree++;
    }
    expect(pure).toBeGreaterThan(8000);
    expect(agree / pure).toBeGreaterThanOrEqual(0.98);
  });

  it('uses the weighted distance (green counts most) and picks the lowest index on ties', () => {
    // Pixel (20, 0, 0) vs palette [red-ish (40,0,0), green-ish (0,12,0)]:
    // weighted d² to A = (0.5054*20)² = 102.2 ; to B = (0.5054*20)² + (0.9925*12)² = 244 -> A.
    // Pixel (0, 0, 0): tie-free, nearest is B (0.9925*12)²=141.9 vs A (0.5054*40)²=408.7.
    const img = raster(3, 1, [20, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const lm = assignLabels(img, [
      [40, 0, 0],
      [0, 12, 0],
      [0, 12, 0],
    ]);
    expect(Array.from(lm.data)).toEqual([0, 1, 1]);
  });

  it('transparent pixels get the background index (palette colour matching the border) else 0', () => {
    // 6x6: border ring blue, interior red, and two transparent pixels inside.
    const w = 6;
    const img = solid(w, w, [200, 0, 0, 255]);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        if (x === 0 || y === 0 || x === w - 1 || y === w - 1) img.data.set([0, 0, 200, 255], (y * w + x) * 4);
      }
    }
    img.data.set([0, 0, 0, 0], (2 * w + 2) * 4);
    img.data.set([0, 0, 0, 5], (3 * w + 3) * 4);
    const palette: RGB[] = [
      [200, 0, 0],
      [0, 0, 200],
    ];
    const lm = assignLabels(img, palette);
    expect(lm.data[2 * w + 2]).toBe(1);
    expect(lm.data[3 * w + 3]).toBe(1);
    expect(lm.data[2 * w + 3]).toBe(0);
    expect(lm.data[0]).toBe(1);
    // Without a matching border colour in the palette -> 0.
    const lm2 = assignLabels(img, [[200, 0, 0], [0, 200, 0]]);
    expect(lm2.data[2 * w + 2]).toBe(0);
  });

  it('is deterministic, handles an empty palette and a large exact-cache workload', () => {
    const { image, palette } = flatShapes3();
    expect(sameLabels(assignLabels(image, palette), assignLabels(image, palette))).toBe(true);
    const empty = assignLabels(image, []);
    expect(empty.count).toBe(0);
    expect(empty.data.every((v) => v === 0)).toBe(true);
    // Many distinct colours (cache collisions) must still give exact nearest labels.
    const img = noisePhoto(64, 3);
    const p = kmeansRefine(img, medianCut(img, 6));
    const lm = assignLabels(img, p);
    for (let i = 0; i < lm.data.length; i++) {
      const c: RGB = [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < p.length; j++) {
        const d = colorDistance2(c, p[j]);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      expect(lm.data[i]).toBe(best);
    }
  });
});
