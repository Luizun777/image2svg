import { describe, expect, it } from 'vitest';
import type { RasterImage, SourceInfo } from '../../src/types';
import { analyzeSource, classify, offPaletteShare } from '../../src/core/classify';
import {
  aaCircle,
  aaDiagonalLine,
  coverage,
  flatShapes3,
  glyph,
  grayToRaster,
  nearestUpscale,
  bakedCheckerLogo,
  noisePhoto,
  sprite32,
} from '../../src/dev/synth';
import { accentIcon, ringedDisc } from '../fixtures/shapes';

/** 300x300 white image with 1-px black lines (h/v/diagonal). min(w,h) > 256 -> not "native pixel art". */
function lineDrawing(size = 300): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  const ink = (x: number, y: number): void => {
    const o = (y * size + x) * 4;
    data[o] = 0;
    data[o + 1] = 0;
    data[o + 2] = 0;
  };
  for (const y of [50, 150, 250]) for (let x = 20; x < size - 20; x++) ink(x, y);
  for (const x of [100, 200]) for (let y = 20; y < size - 20; y++) ink(x, y);
  for (let t = 20; t < size - 20; t++) ink(t, t);
  return { data, width: size, height: size };
}

/** 100x100 1-bit drawing on white: 1-px horizontal lines, two diagonals and a filled block. */
function bitmapDrawing(size = 100): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  const ink = (x: number, y: number): void => {
    const o = (y * size + x) * 4;
    data[o] = 0;
    data[o + 1] = 0;
    data[o + 2] = 0;
  };
  for (let y = 10; y < size - 10; y += 17) for (let x = 5; x < size - 5; x++) ink(x, y);
  for (let t = 5; t < size - 5; t++) {
    ink(t, t);
    ink(size - 1 - t, t);
  }
  for (let y = 30; y < 60; y++) for (let x = 30; x < 70; x++) ink(x, y);
  return { data, width: size, height: size };
}

/** 256 px cream paper with six anti-aliased dark-brown strokes and deterministic +-amp noise per channel. */
function noisySepiaScan(size = 256, amp = 30): RasterImage {
  const strokes = [0, 30, 60, 90, 120, 150].map((deg, i) => {
    const th = (deg * Math.PI) / 180;
    const cx = 40 + (i % 3) * 80;
    const cy = 70 + Math.floor(i / 3) * 110;
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    return (x: number, y: number): number => {
      const px = x - cx;
      const py = y - cy;
      const t = Math.max(-30, Math.min(30, px * dx + py * dy));
      return Math.hypot(px - t * dx, py - t * dy) - 2.5;
    };
  });
  const img = grayToRaster(coverage(size, (x, y) => Math.min(...strokes.map((f) => f(x, y)))), size, [60, 40, 30], [240, 228, 205]);
  let a = 5;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let p = 0; p < img.data.length; p += 4) for (let c = 0; c < 3; c++) img.data[p + c] += (rnd() * 2 - 1) * amp;
  return img;
}

/** Two halves of colourful 2-D gradients, a dark one (blue/purple) and a light one (yellow/cyan). */
function bimodalColourSweep(w = 320, h = 160): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const half = w / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const u = (x % half) / (half - 1);
      const v = y / (h - 1);
      const dark = x < half;
      data[o] = dark ? 150 * u : 140 + 115 * u;
      data[o + 1] = dark ? 70 * v : 185 + 70 * v;
      data[o + 2] = dark ? 50 + 205 * ((u + v) / 2) : 20 + 235 * ((u + v) / 2);
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function baseInfo(over: Partial<SourceInfo>): SourceInfo {
  return {
    width: 100,
    height: 100,
    transparentRatio: 0,
    partialAlphaRatio: 0,
    distinctColors: 10,
    paletteColors: 10,
    offPaletteRatio: 0.01,
    quantError: 1,
    twoToneOffRatio: 0.01,
    hardEdgeRatio: 0,
    thinStrokeRatio: 0,
    grid: 1,
    dominantInk: [0, 0, 0],
    borderColor: [255, 255, 255],
    isBimodal: false,
    bakedBackground: null,
    ...over,
  };
}

const SPANISH = /[áéíóúñ]|(^| )(de|la|el|se|con|colores|imagen|trazos)( |$)/i;

describe('analyzeSource', () => {
  it('flatShapes3: 3..32 colours, no alpha, border = background colour, dominant ink = rect, not bimodal', () => {
    const info = analyzeSource(flatShapes3().image);
    expect(info.width).toBe(96);
    expect(info.height).toBe(96);
    expect(info.transparentRatio).toBe(0);
    expect(info.partialAlphaRatio).toBe(0);
    expect(info.distinctColors).toBeGreaterThanOrEqual(3);
    expect(info.distinctColors).toBeLessThanOrEqual(32);
    expect(info.borderColor).toEqual([0xf2, 0xe8, 0xd5]);
    expect(info.dominantInk).toEqual([0xe0, 0x7a, 0x5f]);
    expect(info.grid).toBe(1);
    // The rectangle sits on integer coordinates (no AA: genuinely hard) and the circle is
    // anti-aliased (soft): about half of the edges are hard, far from the 0.9 of pixel art.
    expect(info.hardEdgeRatio).toBeGreaterThan(0.3);
    expect(info.hardEdgeRatio).toBeLessThan(0.8);
    expect(info.thinStrokeRatio).toBeLessThan(0.2);
    expect(info.isBimodal).toBe(false);
  });

  it('aaCircle: white border, black ink, bimodal luma, soft edges', () => {
    const info = analyzeSource(aaCircle().image);
    expect(info.borderColor).toEqual([255, 255, 255]);
    expect(info.dominantInk).toEqual([0, 0, 0]);
    expect(info.isBimodal).toBe(true);
    expect(info.hardEdgeRatio).toBeLessThan(0.5);
    expect(info.grid).toBe(1);
    // A 1x anti-aliased disc of r=20 loses ~9 % of its ink to a 1-px erosion.
    expect(info.thinStrokeRatio).toBeGreaterThan(0.05);
    expect(info.thinStrokeRatio).toBeLessThan(0.2);
  });

  it('sprite32 x3: grid 3, mostly transparent, 2..6 colours, no border colour', () => {
    const info = analyzeSource(nearestUpscale(sprite32(), 3));
    expect(info.grid).toBe(3);
    expect(info.transparentRatio).toBeGreaterThan(0.3);
    expect(info.partialAlphaRatio).toBe(0);
    expect(info.distinctColors).toBeGreaterThanOrEqual(2);
    expect(info.distinctColors).toBeLessThanOrEqual(6);
    expect(info.borderColor).toBeNull();
  });

  it('1-px line drawing: 2 colours, every edge hard, almost all ink removed by erosion', () => {
    const info = analyzeSource(lineDrawing());
    expect(info.distinctColors).toBe(2);
    expect(info.hardEdgeRatio).toBe(1);
    // Only the line crossings (4 ink neighbours) survive a 1-px erosion.
    expect(info.thinStrokeRatio).toBeGreaterThan(0.99);
    expect(info.thinStrokeRatio).toBeLessThanOrEqual(1);
    expect(info.grid).toBe(1);
    expect(info.borderColor).toEqual([255, 255, 255]);
    expect(info.dominantInk).toEqual([0, 0, 0]);
  });

  it('noisePhoto: > 200 colours, no grid, no agreeing border', () => {
    const info = analyzeSource(noisePhoto());
    expect(info.distinctColors).toBeGreaterThan(200);
    expect(info.grid).toBe(1);
    expect(info.isBimodal).toBe(false);
    expect(info.hardEdgeRatio).toBeLessThan(0.5);
  });

  it('does not mutate the input and handles an empty image', () => {
    const img = flatShapes3().image;
    const copy = Uint8ClampedArray.from(img.data);
    analyzeSource(img);
    expect(Array.from(img.data)).toEqual(Array.from(copy));
    const empty = analyzeSource({ data: new Uint8ClampedArray(0), width: 0, height: 0 });
    expect(empty.distinctColors).toBe(0);
    expect(empty.transparentRatio).toBe(0);
    expect(empty.grid).toBe(1);
  });
});

describe('classify (end to end on fixtures)', () => {
  it('sprite32 upscaled x3 -> pixel with gridScale 3', () => {
    const r = classify(analyzeSource(nearestUpscale(sprite32(), 3)));
    expect(r.mode).toBe('pixel');
    expect(r.params.mode).toBe('pixel');
    expect(r.params.gridScale).toBe(3);
    expect(r.warnings).toEqual([]);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('aaCircle -> lines, no warnings', () => {
    const r = classify(analyzeSource(aaCircle().image));
    expect(r.mode).toBe('lines');
    expect(r.params.mode).toBe('lines');
    expect(r.warnings).toEqual([]);
  });

  it("flatShapes3 -> flat with colors 'auto' and no photo warning", () => {
    const r = classify(analyzeSource(flatShapes3().image));
    expect(r.mode).toBe('flat');
    expect(r.params.mode).toBe('flat');
    expect(r.params.colors).toBe('auto');
    expect(r.warnings.map((w) => w.code)).not.toContain('photo');
    expect(r.warnings).toEqual([]);
  });

  it('noisePhoto -> flat with colors 16 and the photo warning (in Spanish)', () => {
    const r = classify(analyzeSource(noisePhoto()));
    expect(r.mode).toBe('flat');
    expect(r.params.colors).toBe(16);
    expect(r.params.exactPalette).toBe(false);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0].code).toBe('photo');
    expect(r.warnings[0].message).toMatch(SPANISH);
  });

  it('1-px line drawing -> lines with the thin-strokes warning (in Spanish)', () => {
    const r = classify(analyzeSource(lineDrawing()));
    expect(r.mode).toBe('lines');
    expect(r.warnings.map((w) => w.code)).toEqual(['thin-strokes']);
    expect(r.warnings[0].message).toMatch(SPANISH);
  });
});

describe('classify: thin outlines and small accents are colours of their own', () => {
  it('a yellow sticker with a 1 to 2 px dark outline is flat, not a one-colour line drawing (white and transparent)', () => {
    for (const width of [1, 1.5, 2]) {
      for (const transparent of [false, true]) {
        const info = analyzeSource(ringedDisc({ width, transparent }).image);
        const label = `${width} px${transparent ? ' transparent' : ''}`;
        expect(info.paletteColors, label).toBe(transparent ? 2 : 3);
        expect(classify(info).mode, label).toBe('flat');
      }
    }
  });

  it('a 48 px icon with a navy disc and a small red dot is flat', () => {
    const info = analyzeSource(accentIcon());
    expect(info.paletteColors).toBe(3);
    expect(classify(info).mode).toBe('flat');
  });
});

describe('classify: native-resolution pixel art', () => {
  it('colour sprite at 1x (sprite32, no grid) -> hardEdgeRatio > 0.9 and pixel with gridScale 1', () => {
    for (const seed of [1, 2, 3]) {
      const info = analyzeSource(sprite32(seed));
      expect(info.grid, `seed ${seed}`).toBe(1);
      expect(info.hardEdgeRatio, `seed ${seed}`).toBeGreaterThan(0.9);
      const r = classify(info);
      expect(r.mode, `seed ${seed}`).toBe('pixel');
      expect(r.params.gridScale).toBe(1);
    }
  });

  it('a 1-bit B/W drawing <= 128 px is hard (> 0.9); anti-aliased and flat fixtures are never pixel', () => {
    const bw = analyzeSource(bitmapDrawing());
    expect(bw.hardEdgeRatio).toBeGreaterThan(0.9);
    expect(classify(bw).mode).toBe('pixel');
    for (const [name, img] of [
      ['aaCircle', aaCircle().image],
      ['glyph', glyph().image],
      ['aaDiagonalLine', aaDiagonalLine().image],
      ['flatShapes3', flatShapes3().image],
    ] as const) {
      const info = analyzeSource(img);
      expect(info.hardEdgeRatio, name).toBeLessThanOrEqual(0.9);
      expect(classify(info).mode, name).not.toBe('pixel');
    }
  });
});

describe('classify: too many tones for an exact palette and bimodal luma', () => {
  it('a noisy two-tone scan is lines; a colourful bimodal gradient is photo, not lines', () => {
    const scan = analyzeSource(noisySepiaScan());
    expect(scan.paletteColors).toBeNull();
    expect(scan.isBimodal).toBe(true);
    expect(scan.twoToneOffRatio).toBeLessThan(0.1);
    expect(classify(scan).mode).toBe('lines');

    const sweep = analyzeSource(bimodalColourSweep());
    expect(sweep.paletteColors).toBeNull();
    expect(sweep.isBimodal).toBe(true);
    expect(sweep.twoToneOffRatio).toBeGreaterThan(0.55);
    const r = classify(sweep);
    expect(r.mode).toBe('flat');
    expect(r.warnings.map((w) => w.code)).toEqual(['photo']);
  });
});

describe('classify (rules on synthetic SourceInfo)', () => {
  it('pixel when grid >= 2 regardless of everything else', () => {
    const r = classify(baseInfo({ grid: 2, distinctColors: 500, isBimodal: true }));
    expect(r.mode).toBe('pixel');
    expect(r.params.gridScale).toBe(2);
  });

  it('pixel on hard edges only when min(w,h) <= 128, whatever the colour count', () => {
    expect(classify(baseInfo({ hardEdgeRatio: 0.95, width: 128, height: 900 })).mode).toBe('pixel');
    expect(classify(baseInfo({ hardEdgeRatio: 0.95, width: 128, height: 900 })).params.gridScale).toBe(1);
    expect(classify(baseInfo({ hardEdgeRatio: 0.9, width: 128, height: 128 })).mode).not.toBe('pixel');
    expect(classify(baseInfo({ hardEdgeRatio: 0.95, width: 129, height: 129 })).mode).not.toBe('pixel');
    // A small hard-edged sprite with many colours is still pixel art...
    expect(
      classify(baseInfo({ hardEdgeRatio: 1, paletteColors: null, distinctColors: 500, width: 64, height: 64 })).mode,
    ).toBe('pixel');
    // ...but a hard-edged B/W drawing larger than 128 px is a line drawing, not pixel art.
    expect(classify(baseInfo({ hardEdgeRatio: 1, paletteColors: 2, width: 300, height: 300 })).mode).toBe('lines');
  });

  it('never pixel above 1 Mpx without a grid, even with hard edges and a small side', () => {
    expect(classify(baseInfo({ hardEdgeRatio: 1, width: 100, height: 10_000 })).mode).toBe('pixel');
    expect(classify(baseInfo({ hardEdgeRatio: 1, width: 100, height: 10_001 })).mode).not.toBe('pixel');
    expect(classify(baseInfo({ hardEdgeRatio: 1, width: 100, height: 10_001, grid: 2 })).mode).toBe('pixel');
  });

  it('lines when <= 2 real colours cover the image, or bimodal without an exact palette', () => {
    expect(classify(baseInfo({ paletteColors: 2 })).mode).toBe('lines');
    expect(classify(baseInfo({ paletteColors: 1 })).mode).toBe('lines');
    // A bimodal luma histogram is not enough when the palette has more colours (GENTERA: six
    // flat brand colours whose luma splits in two).
    expect(classify(baseInfo({ paletteColors: 6, isBimodal: true })).mode).toBe('flat');
    // A noisy scan: too many tones for an exact palette, but bimodal luma and two colours cover it -> lines.
    expect(classify(baseInfo({ paletteColors: null, isBimodal: true, offPaletteRatio: 0.3 })).mode).toBe('lines');
    expect(classify(baseInfo({ paletteColors: null, isBimodal: true, twoToneOffRatio: 0.5 })).mode).toBe('lines');
    // A colourful gradient with bimodal luma (Instagram: 76.6 % of the pixels off two colours) is not a drawing.
    const colourful = classify(baseInfo({ paletteColors: null, isBimodal: true, twoToneOffRatio: 0.766 }));
    expect(colourful.mode).toBe('flat');
    expect(colourful.warnings.map((w) => w.code)).toEqual(['photo']);
    // A linear two-colour gradient has 2 "colours" but most pixels are off them -> photo.
    const grad = classify(baseInfo({ paletteColors: 2, offPaletteRatio: 0.8 }));
    expect(grad.mode).toBe('flat');
    expect(grad.warnings.map((w) => w.code)).toEqual(['photo']);
    // thin-strokes warning only above 0.5, and only in lines mode.
    const thin = classify(baseInfo({ paletteColors: 2, thinStrokeRatio: 0.51 }));
    expect(thin.warnings.map((w) => w.code)).toEqual(['thin-strokes']);
    expect(classify(baseInfo({ paletteColors: 2, thinStrokeRatio: 0.5 })).warnings).toEqual([]);
    expect(classify(baseInfo({ paletteColors: 10, thinStrokeRatio: 0.9 })).warnings).toEqual([]);
  });

  it('lines boundaries: offPaletteRatio 0.5 with 2 colours and twoToneOffRatio 0.5 without a palette are lines; 0.51 is not', () => {
    // LINES_MAX_OFF_PALETTE = 0.5 is inclusive on both lines rules.
    expect(classify(baseInfo({ paletteColors: 2, offPaletteRatio: 0.5 })).mode).toBe('lines');
    const off = classify(baseInfo({ paletteColors: 2, offPaletteRatio: 0.51 }));
    expect(off.mode).not.toBe('lines');
    expect(off.mode).toBe('flat');
    expect(off.warnings.map((w) => w.code)).toEqual(['photo']);
    expect(classify(baseInfo({ paletteColors: null, isBimodal: true, twoToneOffRatio: 0.5 })).mode).toBe('lines');
    const noisy = classify(baseInfo({ paletteColors: null, isBimodal: true, twoToneOffRatio: 0.51 }));
    expect(noisy.mode).not.toBe('lines');
    expect(noisy.warnings.map((w) => w.code)).toEqual(['photo']);
  });

  it('flat with auto colours while <= 32 real colours cover >= 85 % of the pixels; photo otherwise', () => {
    const f = classify(baseInfo({ paletteColors: 32, offPaletteRatio: 0.15 }));
    expect(f.mode).toBe('flat');
    expect(f.params.colors).toBe('auto');
    expect(f.warnings).toEqual([]);
    const p = classify(baseInfo({ paletteColors: 32, offPaletteRatio: 0.151 }));
    expect(p.mode).toBe('flat');
    expect(p.params.colors).toBe(16);
    expect(p.params.exactPalette).toBe(false); // the exact palette is what failed to cover the image
    expect(p.warnings.map((w) => w.code)).toEqual(['photo']);
    expect(p.warnings[0].message).toMatch(SPANISH);
    const n = classify(baseInfo({ paletteColors: null, distinctColors: 800 }));
    expect(n.mode).toBe('flat');
    expect(n.params.colors).toBe(16);
    expect(n.warnings.map((w) => w.code)).toEqual(['photo']);
    // distinctColors (5-bit tones) no longer decides: JPEG noise inflates it.
    expect(classify(baseInfo({ paletteColors: 3, distinctColors: 75, offPaletteRatio: 0.08 })).mode).toBe('flat');
    expect(classify(baseInfo({ paletteColors: 3, distinctColors: 75, offPaletteRatio: 0.08 })).warnings).toEqual([]);
  });

  it('always gives at least one Spanish reason', () => {
    for (const info of [
      baseInfo({ grid: 4 }),
      baseInfo({ hardEdgeRatio: 1, width: 64, height: 64 }),
      baseInfo({ paletteColors: 2 }),
      baseInfo({ paletteColors: null, isBimodal: true }),
      baseInfo({ paletteColors: 8 }),
      baseInfo({ paletteColors: 8, offPaletteRatio: 0.5 }),
      baseInfo({ paletteColors: null, distinctColors: 800 }),
    ]) {
      const r = classify(info);
      expect(r.reasons.length).toBeGreaterThanOrEqual(1);
      expect(r.reasons.join(' ')).toMatch(SPANISH);
    }
  });
});

describe('classify: transparent sources and fake transparency', () => {
  it('on transparency one ink is lines and two inks are flat; the noisy-scan rule needs an opaque background', () => {
    expect(classify(baseInfo({ transparentRatio: 0.7, paletteColors: 1 })).mode).toBe('lines');
    expect(classify(baseInfo({ transparentRatio: 0.7, paletteColors: 2 })).mode).toBe('flat');
    expect(classify(baseInfo({ transparentRatio: 0, paletteColors: 2 })).mode).toBe('lines');
    const noisy = classify(baseInfo({ transparentRatio: 0.7, paletteColors: null, isBimodal: true, twoToneOffRatio: 0.2 }));
    expect(noisy.mode).toBe('flat');
    expect(noisy.warnings.map((w) => w.code)).toContain('photo');
  });

  it('the photo rule weighs offPaletteRatio by the opaque share of the image', () => {
    // clip_art without its checkerboard (bench): 0.306 of its opaque pixels off its 2 colours, 87.8 % transparent.
    const logo = baseInfo({ transparentRatio: 0.878, paletteColors: 2, offPaletteRatio: 0.306 });
    expect(offPaletteShare(logo)).toBeCloseTo(0.0373, 4);
    const r = classify(logo);
    expect(r.mode).toBe('flat');
    expect(r.warnings).toEqual([]);
    expect(classify(baseInfo({ paletteColors: 4, offPaletteRatio: 0.2 })).warnings.map((w) => w.code)).toContain('photo');
    expect(classify(baseInfo({ transparentRatio: 0.5, paletteColors: 4, offPaletteRatio: 0.32 })).warnings.map((w) => w.code)).toContain('photo');
    expect(classify(baseInfo({ transparentRatio: 0.5, paletteColors: 4, offPaletteRatio: 0.28 })).warnings).toEqual([]);
  });

  it('analyzeSource over a painted checkerboard describes the logo on transparency; keep measures the pixels', () => {
    const { image } = bakedCheckerLogo({ cell: 10 });
    const info = analyzeSource(image);
    expect(info.bakedBackground).not.toBeNull();
    expect(info.bakedBackground?.cell).toBeCloseTo(10, 1);
    expect(info.transparentRatio).toBeGreaterThan(0.6);
    expect(info.paletteColors).toBe(1);
    expect(info.borderColor).toBeNull();
    expect(classify(info).mode).toBe('lines');
    const kept = analyzeSource(image, 'keep');
    expect(kept.bakedBackground).toBeNull();
    expect(kept.transparentRatio).toBe(0);
    expect(kept.paletteColors).toBeGreaterThanOrEqual(3);
    expect(classify(kept).mode).toBe('flat');
  });
});
