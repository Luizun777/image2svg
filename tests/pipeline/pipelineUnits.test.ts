/**
 * Pipeline unit tests with a fake tracer: option plumbing (turdsize / vtracer filterSpeckle
 * scaled by U²), engine fallback, warnings, the prepare* functions and the transparent flat
 * handling (alpha < 128 belongs to no layer, no background rect).
 */
import { describe, expect, it } from 'vitest';
import type {
  AbsPath,
  BinaryMask,
  Engine,
  RasterImage,
  RGB,
  Tracer,
  TracerOptions,
} from '../../src/types';
import { layerMask, prepareFlat, prepareLines, trace, TOO_MANY_RECTS } from '../../src/core/pipeline';
import { analyzeSource } from '../../src/core/classify';
import { resolveParams } from '../../src/core/params';
import { buildPalette, toHex } from '../../src/core/palette';
import { countInk } from '../../src/core/morphology';
import { coverage, aaCircle, flatShapes3, noisePhoto, sprite32, transparentLogo } from '../../src/dev/synth';
import { extractPaths } from '../../src/tracers/svgParse';
import { parsePathData } from '../../src/svg/pathParse';
import { rasterizeLayers } from '../../src/metrics/scanline';
import { maskIoU, assertMaskNested } from '../fixtures/helpers';
import { fadingBlocks } from '../fixtures/shapes';

// ---------------------------------------------------------------------------------------------
// Fake tracer: one rectangular path around the ink bbox; records every call.
// ---------------------------------------------------------------------------------------------

interface Call {
  mask: BinaryMask;
  opts: TracerOptions;
}

function fakeTracer(name: Engine, calls: Call[]): Tracer {
  return {
    name,
    init: () => Promise.resolve(),
    traceBinary: (mask, opts) => {
      calls.push({ mask, opts });
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < mask.height; y++) {
        for (let x = 0; x < mask.width; x++) {
          if (mask.data[y * mask.width + x] === 0) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) return Promise.resolve([]);
      const p: AbsPath = {
        segs: [
          { kind: 'M', x: minX, y: minY },
          { kind: 'L', x: maxX + 1, y: minY },
          { kind: 'L', x: maxX + 1, y: maxY + 1 },
          { kind: 'L', x: minX, y: maxY + 1 },
          { kind: 'Z' },
        ],
      };
      return Promise.resolve([p]);
    },
  };
}

function fakes(): { tracers: Record<Engine, Tracer>; calls: Call[] } {
  const calls: Call[] = [];
  return { tracers: { potrace: fakeTracer('potrace', calls), vtracer: fakeTracer('vtracer', calls) }, calls };
}

/**
 * Transparent two-colour logo with GARBAGE colour in the transparent pixels: the star of
 * transparentLogo in navy with a red disc (r = 7) in its centre; alpha = star coverage; the RGB
 * of fully transparent pixels is white (a common PNG export artefact).
 */
function twoColourTransparent(size = 64): {
  image: RasterImage;
  star: (U: number) => BinaryMask;
  disc: (U: number) => BinaryMask;
} {
  const base = transparentLogo(size);
  const s = size / 64;
  const cx = 32 * s;
  const cy = 32 * s;
  const r = 7 * s;
  const sdf = (x: number, y: number): number => Math.hypot(x - cx, y - cy) - r;
  const covDisc = coverage(size, sdf);
  const data = Uint8ClampedArray.from(base.image.data);
  const RED: RGB = [200, 30, 30];
  const NAVY: RGB = [0x1d, 0x35, 0x57];
  for (let p = 0, o = 0; p < covDisc.length; p++, o += 4) {
    const a = data[o + 3];
    if (a === 0) {
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      continue;
    }
    const t = covDisc[p];
    data[o] = Math.round(RED[0] * t + NAVY[0] * (1 - t));
    data[o + 1] = Math.round(RED[1] * t + NAVY[1] * (1 - t));
    data[o + 2] = Math.round(RED[2] * t + NAVY[2] * (1 - t));
  }
  const disc = (U: number): BinaryMask => {
    const n = size * U;
    const m = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (sdf((x + 0.5) / U, (y + 0.5) / U) < 0) m[y * n + x] = 1;
    return { data: m, width: n, height: n };
  };
  return { image: { data, width: size, height: size }, star: base.maskAt, disc };
}

function expectHexNear(hex: string, rgb: RGB, tol: number): void {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  for (let c = 0; c < 3; c++) {
    const v = parseInt(hex.slice(1 + 2 * c, 3 + 2 * c), 16);
    expect(Math.abs(v - rgb[c]), `${hex} channel ${c} vs ${rgb[c]}`).toBeLessThanOrEqual(tol);
  }
}

function alphaOutside(img: RasterImage, mask: BinaryMask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] === 0 && img.data[i * 4 + 3] > 0) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------

describe('trace: option plumbing and engines', () => {
  it('scales turdsize and vtracer filterSpeckle by U² and passes the rest through', async () => {
    const { tracers, calls } = fakes();
    const r = await trace(
      aaCircle().image,
      { mode: 'lines', upscale: 4, engine: 'vtracer', turdsize: 3, vtracer: { filterSpeckle: 5 }, alphamax: 0.7 },
      tracers,
    );
    expect(r.resolved.engine).toBe('vtracer');
    expect(r.resolved.upscale).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.turdsize).toBe(3 * 16);
    expect(calls[0].opts.vtracer.filterSpeckle).toBe(5 * 16);
    expect(calls[0].opts.alphamax).toBe(0.7);
    expect(calls[0].mask.width).toBe(256);
    expect(calls[0].mask.height).toBe(256);
    expect(r.warnings).toEqual([]);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('falls back to another engine with the engine-unavailable warning (in Spanish)', async () => {
    const { tracers, calls } = fakes();
    const onlyPotrace = { potrace: tracers.potrace } as Record<Engine, Tracer>;
    const r = await trace(aaCircle().image, { mode: 'lines', engine: 'vtracer' }, onlyPotrace);
    expect(r.resolved.engine).toBe('potrace');
    expect(r.warnings.map((w) => w.code)).toEqual(['engine-unavailable']);
    expect(r.warnings[0].message).toMatch(/vtracer/);
    expect(r.warnings[0].message).toMatch(/[áéíóú]|no está/);
    expect(calls).toHaveLength(1);
    await expect(trace(aaCircle().image, { mode: 'lines' }, {} as Record<Engine, Tracer>)).rejects.toThrow(/motor/);
  });

  it('mode auto: classifies (flatShapes3 -> flat, noisePhoto -> photo warning) and keeps user overrides', async () => {
    const { tracers } = fakes();
    const flat = await trace(flatShapes3().image, {}, tracers);
    expect(flat.resolved.mode).toBe('flat');
    expect(flat.resolved.colors).toBe('auto');
    expect(flat.warnings).toEqual([]);
    const photo = await trace(noisePhoto(), { mode: 'auto', upscale: 1 }, tracers);
    expect(photo.resolved.mode).toBe('flat');
    expect(photo.resolved.colors).toBe(16);
    expect(photo.resolved.upscale).toBe(1);
    expect(photo.warnings.map((w) => w.code)).toEqual(['photo']);
    const lines = await trace(aaCircle().image, {}, tracers);
    expect(lines.resolved.mode).toBe('lines');
  });

  it('reports each warning code once (thin-strokes from classify and prepareLines)', async () => {
    const { tracers } = fakes();
    const size = 200;
    const data = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < size; y += 10) for (let x = 0; x < size; x++) data.set([0, 0, 0, 255], (y * size + x) * 4);
    const r = await trace({ data, width: size, height: size }, {}, tracers);
    expect(r.resolved.mode).toBe('lines');
    expect(r.warnings.filter((w) => w.code === 'thin-strokes')).toHaveLength(1);
  });

  it("'empty-trace' blank rule: an empty mask warns unless BOTH the composite luma and the alpha are uniform", async () => {
    const { tracers } = fakes();
    // Opaque, non-blank image forced to the alpha mask with invert: alpha is uniform (255) but the
    // image is not blank, so the empty SVG must be explained.
    const forced = await trace(aaCircle().image, { mode: 'lines', upscale: 1, alphaMode: 'mask', invert: true }, tracers);
    expect(extractPaths(forced.svg)).toHaveLength(0);
    expect(forced.warnings.map((w) => w.code)).toEqual(['empty-trace']);
    // Fully transparent image with garbage RGB: blank in both senses, no warning.
    const size = 32;
    const data = new Uint8ClampedArray(size * size * 4);
    for (let p = 0; p < data.length; p += 4) data.set([(p * 7) & 255, (p * 13) & 255, (p * 29) & 255, 0], p);
    const transparent = await trace({ data, width: size, height: size }, { mode: 'lines', upscale: 1 }, tracers);
    expect(transparent.resolved.mode).toBe('lines');
    expect(extractPaths(transparent.svg)).toHaveLength(0);
    expect(transparent.warnings).toEqual([]);
  });

  it('rejects inconsistent images', async () => {
    const { tracers } = fakes();
    await expect(trace({ data: new Uint8ClampedArray(3), width: 1, height: 1 }, { mode: 'lines' }, tracers)).rejects.toThrow(
      /data\.length/,
    );
    await expect(trace({ data: new Uint8ClampedArray(0), width: 0, height: 1 }, { mode: 'flat' }, tracers)).rejects.toThrow(
      /dimensiones/,
    );
  });
});

describe('prepareLines', () => {
  it('composite mode: mask matches the ideal disc; invert flips it; fill = dominant ink', () => {
    const { image, maskAt } = aaCircle();
    const info = analyzeSource(image);
    const p = prepareLines(image, resolveParams({ mode: 'lines', upscale: 1, blurK: 0 }, image), info);
    expect(p.U).toBe(1);
    expect(p.layers).toHaveLength(1);
    expect(p.layers[0].fill).toBe('#000000');
    expect(maskIoU(layerMask(p.layers[0]), maskAt(1))).toBeGreaterThan(0.95);
    const inv = prepareLines(image, resolveParams({ mode: 'lines', upscale: 1, blurK: 0, invert: true }, image), info);
    expect(countInk(layerMask(inv.layers[0])) + countInk(layerMask(p.layers[0]))).toBe(64 * 64);
    const up = prepareLines(image, resolveParams({ mode: 'lines', upscale: 4 }, image), info);
    expect(up.U).toBe(4);
    expect(layerMask(up.layers[0]).width).toBe(256);
    expect(maskIoU(layerMask(up.layers[0]), maskAt(4))).toBeGreaterThan(0.97);
    expect(prepareLines(image, resolveParams({ mode: 'lines', fill: '#ff0000' }, image), info).layers[0].fill).toBe('#ff0000');
  });

  it('alpha-mask mode: transparentLogo -> mask = alpha >= 0.5 (upscaled), thresholdOffset shifts it', () => {
    const { image, maskAt } = transparentLogo();
    const info = analyzeSource(image);
    const p = prepareLines(image, resolveParams({ mode: 'lines', upscale: 2, blurK: 0 }, image), info);
    expect(maskIoU(layerMask(p.layers[0]), maskAt(2))).toBeGreaterThan(0.95);
    expect(p.layers[0].fill).toBe('#1d3557');
    const fat = prepareLines(image, resolveParams({ mode: 'lines', upscale: 2, blurK: 0, thresholdOffset: -0.25 }, image), info);
    const thin = prepareLines(image, resolveParams({ mode: 'lines', upscale: 2, blurK: 0, thresholdOffset: 0.25 }, image), info);
    expect(countInk(layerMask(fat.layers[0]))).toBeGreaterThan(countInk(layerMask(p.layers[0])));
    expect(countInk(layerMask(thin.layers[0]))).toBeLessThan(countInk(layerMask(p.layers[0])));
    assertMaskNested(layerMask(fat.layers[0]), layerMask(thin.layers[0]));
  });
});

describe('prepareFlat', () => {
  it('opaque: one nested mask per colour, largest first, masks[0] full canvas', () => {
    const { image, palette } = flatShapes3();
    const p = prepareFlat(image, resolveParams({ mode: 'flat', upscale: 2 }, image), analyzeSource(image));
    expect(p.U).toBe(2);
    expect(p.layers).toHaveLength(3);
    expect(countInk(layerMask(p.layers[0]))).toBe(192 * 192);
    expect(p.layers[0].fill).toBe('#f2e8d5');
    const fills = p.layers.map((l) => l.fill);
    expect(fills).toContain('#2a6f97');
    expect(fills).toContain('#e07a5f');
    expect(palette.length).toBe(3);
    assertMaskNested(layerMask(p.layers[0]), layerMask(p.layers[1]));
    assertMaskNested(layerMask(p.layers[1]), layerMask(p.layers[2]));
    expect(countInk(layerMask(p.layers[1]))).toBeGreaterThan(countInk(layerMask(p.layers[2])));
  });

  it('transparent single colour: one layer covering only the opaque star, no full-canvas layer', () => {
    const { image, maskAt } = transparentLogo();
    const p = prepareFlat(image, resolveParams({ mode: 'flat', upscale: 2 }, image), analyzeSource(image));
    expect(p.layers).toHaveLength(1);
    expect(p.layers[0].fill).toBe('#1d3557');
    const star = maskAt(2);
    expect(maskIoU(layerMask(p.layers[0]), star)).toBeGreaterThan(0.95);
    // No ink where the source is transparent (even after the blur).
    let outside = 0;
    for (let i = 0; i < star.data.length; i++) if (star.data[i] === 0 && layerMask(p.layers[0]).data[i] !== 0) outside++;
    expect(outside / countInk(star)).toBeLessThan(0.03);
  });

  it('transparent two colours with garbage RGB outside: 2 real-ink layers, alpha < 128 in no layer', async () => {
    const { image, star, disc } = twoColourTransparent();
    const info = analyzeSource(image);
    expect(info.paletteColors).toBe(2);
    const p = prepareFlat(image, resolveParams({ mode: 'flat', upscale: 4 }, image), info);
    expect(p.layers).toHaveLength(2);
    expect(p.layers[0].fill).toBe('#1d3557'); // larger area first
    expectHexNear(p.layers[1].fill, [200, 30, 30], 3); // exact-palette average, AA edges shift it slightly
    const S = star(4);
    const D = disc(4);
    expect(maskIoU(layerMask(p.layers[0]), S)).toBeGreaterThan(0.95);
    expect(maskIoU(layerMask(p.layers[1]), D)).toBeGreaterThan(0.9);
    assertMaskNested(layerMask(p.layers[0]), layerMask(p.layers[1]));
    for (const l of p.layers) {
      let outside = 0;
      for (let i = 0; i < S.data.length; i++) if (S.data[i] === 0 && layerMask(l).data[i] !== 0) outside++;
      expect(outside / countInk(S)).toBeLessThan(0.03);
    }
    // The white garbage never becomes a layer, and the edge of the star is navy, not whitish:
    // the navy mask must reach the star boundary (premultiplied resampling).
    expect(countInk(layerMask(p.layers[0])) / countInk(S)).toBeGreaterThan(0.95);

    // End to end: no <rect>, exactly two <path>, transparency preserved when rendered.
    const { tracers } = fakes();
    const r = await trace(image, { mode: 'flat', upscale: 4 }, tracers);
    expect(r.svg).not.toContain('<rect');
    expect(extractPaths(r.svg)).toHaveLength(2);
    expect(r.svg).toMatch(/width="64" height="64" viewBox="0 0 256 256"/);
    const layers = extractPaths(r.svg).map((e) => ({ fill: e.fill ?? '#000000', paths: [parsePathData(e.d)] }));
    const rendered = rasterizeLayers(layers, 256, 256, null);
    // The fake tracer draws bounding boxes, so only the corners of the star's bbox stay
    // transparent: at least the bbox exterior must be alpha 0.
    expect(alphaOutside(rendered, bboxMask(S))).toBe(0);
  });

  it('a palette colour nobody maps to produces no layer (faint blocks the blur fades below alpha 0.5)', async () => {
    const { image, square } = fadingBlocks();
    const info = analyzeSource(image);
    // The palette is built on the 1x image and really has 2 colours: the red square and the blue of
    // four 4x4 blocks at alpha 136 (16 core px: coherent). A 1-px checkerboard, the previous fixture,
    // has no core and no longer reaches the palette.
    expect(buildPalette(image, 'auto', true).map(toHex)).toEqual(['#c81e1e', '#1e3cc8']);
    // Without upscale or blur both colours keep their pixels: nested layers of 320 and 64 px.
    const sharp = prepareFlat(image, resolveParams({ mode: 'flat', upscale: 1, blurK: 0 }, image), info);
    expect(sharp.layers.map((l) => l.fill)).toEqual(['#c81e1e', '#1e3cc8']);
    expect(sharp.layers.map((l) => countInk(layerMask(l)))).toEqual([320, 64]);
    // Labels are assigned after upscale 4 + blur sigma 4 px: the blocks fade below alpha 128, so blue
    // gets 0 pixels and must not become an (empty) layer.
    const params = { mode: 'flat', upscale: 4, blurK: 1 } as const;
    const p = prepareFlat(image, resolveParams(params, image), info);
    expect(p.layers.map((l) => l.fill)).toEqual(['#c81e1e']);
    expect(maskIoU(layerMask(p.layers[0]), square(4))).toBeGreaterThan(0.95);
    // End to end: the tracer runs once (red).
    const { tracers, calls } = fakes();
    const r = await trace(image, params, tracers, info);
    expect(calls).toHaveLength(1);
    expect(extractPaths(r.svg).map((e) => e.fill)).toEqual(['#c81e1e']);
    expect(r.warnings).toEqual([]);
  });
});

function bboxMask(m: BinaryMask): BinaryMask {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++) {
      if (m.data[y * m.width + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  const out = new Uint8Array(m.width * m.height);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) out[y * m.width + x] = 1;
  return { data: out, width: m.width, height: m.height };
}

describe('pixel mode', () => {
  it('stats: 3 nodes per rect, cornerFraction 1, bytes = svg length; too-many-rects above the cap', async () => {
    const { tracers, calls } = fakes();
    const r = await trace(sprite32(), { mode: 'pixel' }, tracers);
    expect(calls).toHaveLength(0);
    expect(r.resolved.upscale).toBe(1);
    expect(r.stats.nodeCount).toBe(3 * r.stats.subpathCount);
    expect(r.stats.lineCount).toBe(r.stats.nodeCount);
    expect(r.stats.curveCount).toBe(0);
    expect(r.stats.cornerFraction).toBe(1);
    expect(r.stats.bytes).toBe(Buffer.byteLength(r.svg, 'utf8'));
    expect(r.stats.pathCount).toBe(extractPaths(r.svg).length);
    expect(r.warnings).toEqual([]);
    const big = await trace(noisePhoto(120, 5), { mode: 'pixel' }, tracers);
    expect(big.stats.subpathCount).toBeGreaterThan(TOO_MANY_RECTS);
    expect(big.warnings.map((w) => w.code)).toEqual(['too-many-rects']);
    expect(big.warnings[0].message).toMatch(/rect/);
  });
});
