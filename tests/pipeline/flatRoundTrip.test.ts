/**
 * flat mode round trip on flatShapes3: three stacked layers (background first), rendered back
 * through the reference rasteriser and compared with the ground-truth labels.
 */
import { describe, expect, it } from 'vitest';
import type { Engine, LabelMap, RasterImage, RGB, Tracer } from '../../src/types';
import { trace } from '../../src/core/pipeline';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { rasterizeMask } from '../../src/metrics/scanline';
import { analyzeSource } from '../../src/core/classify';
import { flatShapes3 } from '../../src/dev/synth';
import { ACCENT_RED, RING_INK, accentIcon, greyDiscs, ringedDisc } from '../fixtures/shapes';
import { computeMetrics } from '../../src/metrics/fidelity';
import { hexToRgb, parseSvg, renderAt1x } from '../fixtures/svgBack';

const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };

function maxDiff(a: RGB, b: RGB): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

function nearestIndex(c: RGB, palette: RGB[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let j = 0; j < palette.length; j++) {
    const d = (c[0] - palette[j][0]) ** 2 + (c[1] - palette[j][1]) ** 2 + (c[2] - palette[j][2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

function pixel(img: RasterImage, i: number): RGB {
  return [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
}

/** Pixels whose label and all four neighbours' labels are shapes (1 or 2). */
function strictlyInsideShapes(labels: LabelMap): Uint8Array {
  const { width: w, height: h, data } = labels;
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (data[i] === 0 || data[i - 1] === 0 || data[i + 1] === 0 || data[i - w] === 0 || data[i + w] === 0) continue;
      out[i] = 1;
    }
  }
  return out;
}

describe('flat pipeline round trip (flatShapes3, potrace)', () => {
  it('3 layers in area order, background rect first, >= 98 % label agreement, no seams', async () => {
    const { image, labels, palette } = flatShapes3();
    const res = await trace(image, { mode: 'flat' }, tracers);
    const U = res.resolved.upscale;
    expect(U).toBe(4);
    expect(res.warnings).toEqual([]);
    expect(res.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="96" height="96" viewBox="0 0 384 384">/);

    const parsed = parseSvg(res.svg);
    expect(parsed.layers).toHaveLength(3);
    const fills = parsed.layers.map((l) => hexToRgb(l.fill));
    // Area descending: background (#F2E8D5), rect (#E07A5F, 1600 px), circle (partly covered).
    expect(maxDiff(fills[0], palette[0])).toBeLessThanOrEqual(2);
    expect(maxDiff(fills[1], palette[2])).toBeLessThanOrEqual(2);
    expect(maxDiff(fills[2], palette[1])).toBeLessThanOrEqual(2);

    // First layer covers the whole viewBox (one rectangular subpath, coverage 255 everywhere).
    expect(parsed.layers[0].paths[0].segs.filter((s) => s.kind === 'M')).toHaveLength(1);
    const cov0 = rasterizeMask(parsed.layers[0].paths, 384, 384);
    let full = 0;
    for (let i = 0; i < cov0.data.length; i++) if (cov0.data[i] === 255) full++;
    expect(full).toBe(384 * 384);

    // Render at U, box-downscale to 1x, compare with the ground truth.
    const rendered = renderAt1x(parsed, null);
    expect(rendered.width).toBe(96);
    expect(rendered.height).toBe(96);
    let pure = 0;
    let agree = 0;
    for (let i = 0; i < 96 * 96; i++) {
      const c = pixel(image, i);
      if (!palette.some((p) => maxDiff(p, c) === 0)) continue; // AA pixel
      pure++;
      if (nearestIndex(pixel(rendered, i), palette) === labels.data[i]) agree++;
    }
    expect(pure).toBeGreaterThan(8000);
    const agreement = agree / pure;

    // No seams: strictly inside circle ∪ rect nothing may look like the background (±8).
    const inside = strictlyInsideShapes(labels);
    let insideCount = 0;
    let bgLike = 0;
    for (let i = 0; i < inside.length; i++) {
      if (inside[i] === 0) continue;
      insideCount++;
      if (maxDiff(pixel(rendered, i), palette[0]) <= 8) bgLike++;
    }
    expect(insideCount).toBeGreaterThan(2000);
    console.info(
      `flatShapes3: layers=${parsed.layers.length} agreement=${(agreement * 100).toFixed(2)} % (${agree}/${pure}) ` +
        `seams=${bgLike}/${insideCount} nodes=${res.stats.nodeCount} cornerFraction=${res.stats.cornerFraction.toFixed(3)} bytes=${res.stats.bytes}`,
    );
    expect(agreement).toBeGreaterThanOrEqual(0.98);
    expect(bgLike / insideCount).toBeLessThan(0.001);
  });

  it('grey disc beside a black disc on white (no mode): flat, 3 layers white / grey / black, pure pixels round-trip', async () => {
    // Regression: exactPalette took the grey-128 disc for anti-aliasing between white and black
    // (it lies on that segment) and returned [white, black].
    const image = greyDiscs();
    const info = analyzeSource(image);
    expect(info.paletteColors).toBe(3);
    const res = await trace(image, {}, tracers, info);
    expect(res.resolved.mode).toBe('flat');
    expect(res.resolved.upscale).toBe(4);
    expect(res.warnings).toEqual([]);
    const parsed = parseSvg(res.svg);
    // Area order after the 4x labelling: the black disc's anti-aliased ring is labelled grey, so
    // the grey layer (nested: grey ∪ black) comes before the black one.
    expect(parsed.layers.map((l) => l.fill)).toEqual(['#ffffff', '#808080', '#000000']);
    const rendered = renderAt1x(parsed, null);
    const levels: RGB[] = [
      [0, 0, 0],
      [128, 128, 128],
      [255, 255, 255],
    ];
    let pure = 0;
    let agree = 0;
    for (let i = 0; i < 199 * 199; i++) {
      const c = pixel(image, i);
      const k = levels.findIndex((l) => maxDiff(l, c) === 0);
      if (k < 0) continue; // anti-aliased pixel
      pure++;
      if (nearestIndex(pixel(rendered, i), levels) === k) agree++;
    }
    console.info(`greyDiscs: layers=${parsed.layers.length} agreement=${((agree / pure) * 100).toFixed(2)} % (${agree}/${pure})`);
    expect(pure).toBeGreaterThan(38000);
    expect(agree / pure).toBeGreaterThanOrEqual(0.999); // measured 1.0000 (38969/38969)
  });

  it('auto on a yellow disc with a 1.5 px dark outline: flat with a dark layer, the outline renders dark', async () => {
    const { image, ring } = ringedDisc({ width: 1.5 });
    const res = await trace(image, { engine: 'potrace' }, tracers);
    expect(res.resolved.mode).toBe('flat');
    const parsed = parseSvg(res.svg);
    expect(parsed.layers.some((l) => maxDiff(hexToRgb(l.fill), RING_INK) <= 8)).toBe(true);
    const out = renderAt1x(parsed, [255, 255, 255]);
    let covered = 0;
    let dark = 0;
    for (let i = 0; i < ring.data.length; i++) {
      if (ring.data[i] === 0) continue;
      covered++;
      if (Math.max(...pixel(out, i)) <= 128) dark++;
    }
    expect(covered).toBeGreaterThan(90);
    expect(dark / covered).toBeGreaterThanOrEqual(0.9);
    const m = computeMetrics({ original: image, rendered: out, mode: 'flat', background: [255, 255, 255] });
    expect(m.fidelity).toBeGreaterThanOrEqual(0.95);
  });

  it('auto on a 48 px icon with a small red dot: flat, and the dot renders red', async () => {
    const image = accentIcon();
    const res = await trace(image, { engine: 'potrace' }, tracers);
    expect(res.resolved.mode).toBe('flat');
    const parsed = parseSvg(res.svg);
    expect(parsed.layers.some((l) => maxDiff(hexToRgb(l.fill), ACCENT_RED) <= 8)).toBe(true);
    const out = renderAt1x(parsed, [255, 255, 255]);
    expect(maxDiff(pixel(out, 7 * 48 + 39), ACCENT_RED)).toBeLessThanOrEqual(16);
  });
});
