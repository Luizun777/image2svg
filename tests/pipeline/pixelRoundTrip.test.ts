/**
 * pixel mode round trip: sprite32 -> SVG -> rects -> RGBA byte-identical to the sprite.
 */
import { describe, expect, it } from 'vitest';
import type { Engine, RasterImage, Tracer } from '../../src/types';
import { trace } from '../../src/core/pipeline';
import { analyzeSource, classify } from '../../src/core/classify';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { parsePathData } from '../../src/svg/pathParse';
import { nearestUpscale, noisePhoto, sprite32 } from '../../src/dev/synth';
import { rasterEquals } from '../fixtures/helpers';

const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };

const PATH_RE = /<path fill="(#[0-9a-f]{6})"(?: fill-opacity="([\d.]+)")? d="([^"]*)"\/>/g;

/**
 * Fills every closed axis-aligned subpath of every <path> into a fresh RGBA canvas of the
 * viewBox size (the subpaths of one colour never overlap, so paint order is irrelevant).
 */
function rasterFromPixelSvg(svg: string): RasterImage {
  const head = /<svg[^>]*\sviewBox="0 0 (\d+) (\d+)"[^>]*\sshape-rendering="crispEdges">/.exec(svg);
  if (head === null) throw new Error('cabecera de pixelSvg no reconocida');
  const w = Number(head[1]);
  const h = Number(head[2]);
  const out: RasterImage = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  let m: RegExpExecArray | null;
  const re = new RegExp(PATH_RE.source, 'g');
  while ((m = re.exec(svg)) !== null) {
    const r = parseInt(m[1].slice(1, 3), 16);
    const g = parseInt(m[1].slice(3, 5), 16);
    const b = parseInt(m[1].slice(5, 7), 16);
    const a = m[2] === undefined ? 255 : Math.round(Number(m[2]) * 255);
    const segs = parsePathData(m[3]).segs;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    const flush = (): void => {
      if (count === 0) return;
      expect(count).toBe(4); // M + 3 L: an axis-aligned rectangle
      expect(Number.isInteger(minX) && Number.isInteger(maxX) && Number.isInteger(minY) && Number.isInteger(maxY)).toBe(true);
      for (let y = minY; y < maxY; y++) {
        for (let x = minX; x < maxX; x++) {
          const o = (y * w + x) * 4;
          expect(out.data[o + 3]).toBe(0); // rects never overlap
          out.data[o] = r;
          out.data[o + 1] = g;
          out.data[o + 2] = b;
          out.data[o + 3] = a;
        }
      }
      minX = minY = Infinity;
      maxX = maxY = -Infinity;
      count = 0;
    };
    for (const s of segs) {
      if (s.kind === 'Z') {
        flush();
        continue;
      }
      expect(s.kind === 'M' || s.kind === 'L').toBe(true);
      if (s.kind === 'M' || s.kind === 'L') {
        count++;
        if (s.x < minX) minX = s.x;
        if (s.x > maxX) maxX = s.x;
        if (s.y < minY) minY = s.y;
        if (s.y > maxY) maxY = s.y;
      }
    }
    flush();
  }
  return out;
}

describe('pixel pipeline round trip', () => {
  it('sprite32 -> svg -> rects -> byte-identical RGBA', async () => {
    const sprite = sprite32();
    const res = await trace(sprite, { mode: 'pixel' }, tracers);
    expect(res.resolved.mode).toBe('pixel');
    expect(res.resolved.upscale).toBe(1);
    expect(res.svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="32" height="32" viewBox="0 0 32 32" shape-rendering="crispEdges">/,
    );
    expect(res.warnings).toEqual([]);
    const back = rasterFromPixelSvg(res.svg);
    expect(rasterEquals(back, sprite)).toBe(true);
    // 6 colours at most -> at most 6 <path> elements, one per colour.
    expect(res.stats.pathCount).toBeLessThanOrEqual(6);
    expect(res.stats.subpathCount).toBeGreaterThan(6);
    expect(res.stats.cornerFraction).toBe(1);
  });

  it('nearestUpscale(sprite, 3) with gridScale auto -> the same svg except width/height', async () => {
    const sprite = sprite32();
    const base = await trace(sprite, { mode: 'pixel' }, tracers);
    const up = nearestUpscale(sprite, 3);
    const res = await trace(up, { mode: 'pixel', gridScale: 'auto' }, tracers);
    expect(res.svg).toMatch(/width="96" height="96" viewBox="0 0 32 32"/);
    expect(res.svg.replace('width="96" height="96"', 'width="32" height="32"')).toBe(base.svg);
    expect(rasterEquals(rasterFromPixelSvg(res.svg), sprite)).toBe(true);
    // An explicit gridScale that divides the image gives exactly the same SVG.
    expect((await trace(up, { mode: 'pixel', gridScale: 3 }, tracers)).svg).toBe(res.svg);
    // The classifier reaches the same result on its own (grid 3 -> pixel, gridScale 3).
    const auto = await trace(up, {}, tracers);
    expect(auto.resolved.mode).toBe('pixel');
    expect(auto.resolved.gridScale).toBe(3);
    expect(auto.svg).toBe(res.svg);
  });

  it('sprite32 at 1x with no mode (classify + trace): pixel, gridScale 1, byte-identical for seeds 1-7', async () => {
    // Regression: hardEdgeRatio only recognised black/white steps, so a native colour sprite
    // (no grid to detect) measured 0 and was traced as 'flat' with 128 curves.
    for (let seed = 1; seed <= 7; seed++) {
      const sprite = sprite32(seed);
      const info = analyzeSource(sprite);
      expect(info.grid, `seed ${seed}`).toBe(1);
      expect(info.hardEdgeRatio, `seed ${seed}`).toBeGreaterThan(0.9);
      expect(classify(info).mode, `seed ${seed}`).toBe('pixel');
      const res = await trace(sprite, {}, tracers);
      expect(res.resolved.mode, `seed ${seed}`).toBe('pixel');
      expect(res.resolved.gridScale, `seed ${seed}`).toBe(1);
      expect(res.warnings, `seed ${seed}`).toEqual([]);
      expect(res.stats.curveCount, `seed ${seed}`).toBe(0);
      expect(res.stats.cornerFraction, `seed ${seed}`).toBe(1);
      expect(rasterEquals(rasterFromPixelSvg(res.svg), sprite), `seed ${seed}`).toBe(true);
    }
  });

  it('gridScale 3 on a 10x10 image: 10x10 SVG in source pixels, partial edge blocks kept, every block colour in place', async () => {
    // 4x4 blocks of 3 px (the last column and row are 1 px wide), each with its own colour.
    const size = 10;
    const k = 3;
    const colourOf = (bx: number, by: number): number[] => [20 + 60 * bx, 20 + 60 * by, (4 * bx + by) * 15, 255];
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) data.set(colourOf(Math.floor(x / k), Math.floor(y / k)), (y * size + x) * 4);
    }
    const img: RasterImage = { data, width: size, height: size };
    const res = await trace(img, { mode: 'pixel', gridScale: k }, tracers);
    expect(res.svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="10" height="10" viewBox="0 0 10 10" shape-rendering="crispEdges">/,
    );
    expect(res.warnings).toEqual([]);
    expect(res.stats.subpathCount).toBe(16);
    expect(rasterEquals(rasterFromPixelSvg(res.svg), img)).toBe(true);
    // The block's top-left pixel decides its colour: a stray pixel inside block (1, 1) is not kept.
    const stray = Uint8ClampedArray.from(data);
    stray.set([1, 2, 3, 255], (4 * size + 5) * 4);
    const strayRes = await trace({ data: stray, width: size, height: size }, { mode: 'pixel', gridScale: k }, tracers);
    expect(rasterEquals(rasterFromPixelSvg(strayRes.svg), img)).toBe(true);
  });

  it('a 300x300 noise image forced to pixel mode warns too-many-rects (in Spanish)', async () => {
    const res = await trace(noisePhoto(300), { mode: 'pixel' }, tracers);
    expect(res.resolved.mode).toBe('pixel');
    expect(res.stats.subpathCount).toBeGreaterThan(10000);
    expect(res.warnings.map((w) => w.code)).toEqual(['too-many-rects']);
    expect(res.warnings[0].message).toMatch(/rectángulos/);
    expect(res.svg.startsWith('<svg')).toBe(true);
  });
});
