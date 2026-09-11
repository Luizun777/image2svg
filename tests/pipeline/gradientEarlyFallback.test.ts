/**
 * Gradient mode decides the edge-share fallback before labelling anything: segmentRegions (components, colour growth,
 * orphans, adjacency) must not run on an image that falls back on its edges. Kept in its own file because it mocks
 * core/regions.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RasterImage } from '../../src/types';

vi.mock('../../src/core/regions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/regions')>();
  return { ...actual, segmentRegions: vi.fn(actual.segmentRegions), segmentEdges: vi.fn(actual.segmentEdges) };
});

const { analyzeSource } = await import('../../src/core/classify');
const { resolveParams } = await import('../../src/core/params');
const { GRADIENT_MAX_EDGE_SHARE, fitGradientRegions } = await import('../../src/core/pipeline');
const { segmentEdges, segmentRegions } = await import('../../src/core/regions');
const { gradientFeathers } = await import('../../src/dev/synth');

/**
 * size×size image of 4×4 px blocks of independent pseudo-random colours (mulberry32): flat inside (so the noise estimate
 * stays near 0 and the thresholds at their floors) and so small that the edge band covers almost all of it.
 */
function blockNoise(size: number, seed: number): RasterImage {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const cells = Math.ceil(size / 4);
  const colours = Array.from({ length: cells * cells }, () => [rand() * 256, rand() * 256, rand() * 256]);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = colours[(y >> 2) * cells + (x >> 2)];
      const o = (y * size + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

describe('gradient mode: the edge-share fallback comes before any labelling', () => {
  it('an image that is almost all edge falls back after segmentEdges, without segmentRegions', () => {
    const image = blockNoise(512, 7);
    const info = analyzeSource(image);
    vi.mocked(segmentRegions).mockClear();
    vi.mocked(segmentEdges).mockClear();
    const fit = fitGradientRegions(image, resolveParams({ mode: 'gradient' }, image), info);
    expect(fit.kind).toBe('fallback');
    if (fit.kind !== 'fallback') throw new Error('unreachable');
    expect(fit.reason).toMatch(/^el \d+ % de la imagen es borde$/);
    expect(Number(/\d+/.exec(fit.reason)?.[0]) / 100).toBeGreaterThan(GRADIENT_MAX_EDGE_SHARE);
    expect(vi.mocked(segmentEdges)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(segmentRegions)).not.toHaveBeenCalled();
  });

  it('an image under the limit is segmented once, reusing the edge mask it was checked on', () => {
    const { image } = gradientFeathers(128, 1);
    const info = analyzeSource(image);
    vi.mocked(segmentRegions).mockClear();
    vi.mocked(segmentEdges).mockClear();
    const fit = fitGradientRegions(image, resolveParams({ mode: 'gradient' }, image), info);
    expect(fit.kind).toBe('regions');
    expect(vi.mocked(segmentEdges)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(segmentRegions)).toHaveBeenCalledTimes(1);
    const edges = vi.mocked(segmentEdges).mock.results[0].value;
    expect(vi.mocked(segmentRegions).mock.calls[0][1].edges).toBe(edges);
  });
});
