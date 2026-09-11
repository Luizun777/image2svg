/**
 * THE quantitative anti-spike proof: the lines pipeline (upscale 4 + blur 0.35·U + binarisation at
 * the 50 % coverage iso-level) turns anti-aliased shapes into smooth curves that land on the ideal
 * geometry, and the naive pipeline (no upscale, no blur) is measurably worse.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Engine, RGB, Tracer } from '../../src/types';
import { trace } from '../../src/core/pipeline';
import { analyzeSource } from '../../src/core/classify';
import { resolveAlphaMode } from '../../src/core/background';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { pathStats } from '../../src/svg/pathStats';
import { applyTransform } from '../../src/svg/pathParse';
import { countInk } from '../../src/core/morphology';
import { rasterizeMask } from '../../src/metrics/scanline';
import { aaCircle, aaDiagonalLine, glyph, transparentLogo } from '../../src/dev/synth';
import { maskIoU } from '../fixtures/helpers';
import { binarise, parseSvg, subpathCount } from '../fixtures/svgBack';
import { colourDisc, recolouredLogo, rotatedEllipse } from '../fixtures/shapes';

const WASM = path.join(process.cwd(), 'node_modules/vtracer-web/vtracer.wasm');
const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };

const SMOOTH = { mode: 'lines', upscale: 4, blurK: 0.35 } as const;
const NAIVE = { mode: 'lines', upscale: 1, blurK: 0 } as const;

describe('lines pipeline: no spikes (potrace)', () => {
  it('aaCircle(64,20): cornerFraction < 0.15, IoU > 0.98 at 4x; the naive trace loses IoU with no fewer nodes', async () => {
    const { image, maskAt } = aaCircle(64, 20);
    const smooth = await trace(image, SMOOTH, tracers);
    expect(smooth.resolved.upscale).toBe(4);
    expect(smooth.resolved.sigmaPx).toBeCloseTo(1.4, 9);
    expect(smooth.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="64" height="64" viewBox="0 0 256 256">/);

    const parsed = parseSvg(smooth.svg);
    expect(parsed.layers).toHaveLength(1);
    expect(parsed.layers[0].fill).toBe('#000000');
    const stats = pathStats(parsed.layers, 0);
    // The re-parsed stats agree with the pipeline's own.
    expect(stats.cornerFraction).toBeCloseTo(smooth.stats.cornerFraction, 9);
    expect(stats.nodeCount).toBe(smooth.stats.nodeCount);
    expect(stats.cornerFraction).toBeLessThan(0.15);

    const iou = maskIoU(binarise(rasterizeMask(parsed.paths, 256, 256)), maskAt(4));
    expect(iou).toBeGreaterThan(0.98);

    // Naive baseline: same image, no upscale, no blur. Its paths are in 1x units; scale them by
    // 4 so both traces are measured against the same 4x ideal mask.
    const naive = await trace(image, NAIVE, tracers);
    expect(naive.resolved.upscale).toBe(1);
    const naiveParsed = parseSvg(naive.svg);
    const naivePaths4 = naiveParsed.paths.map((p) => applyTransform(p, { sx: 4, sy: 4 }));
    const naiveIou = maskIoU(binarise(rasterizeMask(naivePaths4, 256, 256)), maskAt(4));
    console.info(
      `aaCircle cornerFraction: naive=${naive.stats.cornerFraction.toFixed(3)} (${naive.stats.lineCount}L/${naive.stats.curveCount}C, IoU@4x ${naiveIou.toFixed(4)}) ` +
        `smoothed=${smooth.stats.cornerFraction.toFixed(3)} (${smooth.stats.lineCount}L/${smooth.stats.curveCount}C, IoU@4x ${iou.toFixed(4)})`,
    );
    // potrace (alphamax 1) already rounds every vertex of a 40 px disc, so on THIS fixture the
    // corner fraction is 0 for both traces and cannot show the difference (the corner claim is
    // proven on the shallow ellipse below); the naive contour still wobbles through the 1x
    // staircase and loses > 1 point of IoU (measured 0.9815 vs 0.9945). Node counts: at the exact
    // 50 % iso-level (127.5) both traces use 6 nodes; the smoothed count is not monotonic in the
    // level (5 at 130, 6 at 127.5, 10 at 125: potrace's polygon optimiser), so only "no more nodes
    // than the naive trace" is a stable property.
    expect(naiveIou).toBeLessThan(iou - 0.01);
    expect(naive.stats.nodeCount).toBeGreaterThanOrEqual(smooth.stats.nodeCount);
  });

  it('ellipse 20x6 rotated 4 deg: the naive 1x trace has spurious corners (>= 0.2, >= 2x smoothed), the smoothed one is more faithful', async () => {
    // An ellipse has no corner at all, so every straight-segment corner is a staircase artefact.
    // Circles cannot show it (potrace rounds them at 1x too: aaCircle 16..64 px all give 0 / 0),
    // nor can glyph (naive 0.333 vs smoothed 0.190, only 1.75x, and its bar has 2 real corners).
    // The long 4-degree sides of this ellipse make 1-px steps that the naive trace keeps as a
    // corner. Measured: naive 0.250 (2L/6C) IoU@4x 0.9399; smoothed 0.000 (0L/10C) IoU 0.9824.
    const { image, maskAt } = rotatedEllipse(48, 20, 6, 4);
    const smooth = await trace(image, SMOOTH, tracers);
    const naive = await trace(image, NAIVE, tracers);
    expect(smooth.warnings).toEqual([]);
    const ideal = maskAt(4);
    const iou = maskIoU(binarise(rasterizeMask(parseSvg(smooth.svg).paths, 192, 192)), ideal);
    const naivePaths4 = parseSvg(naive.svg).paths.map((p) => applyTransform(p, { sx: 4, sy: 4 }));
    const naiveIou = maskIoU(binarise(rasterizeMask(naivePaths4, 192, 192)), ideal);
    console.info(
      `ellipse 20x6@4deg cornerFraction: naive=${naive.stats.cornerFraction.toFixed(3)} (${naive.stats.lineCount}L/${naive.stats.curveCount}C, IoU@4x ${naiveIou.toFixed(4)}) ` +
        `smoothed=${smooth.stats.cornerFraction.toFixed(3)} (${smooth.stats.lineCount}L/${smooth.stats.curveCount}C, IoU@4x ${iou.toFixed(4)})`,
    );
    expect(naive.stats.lineCount).toBeGreaterThan(0);
    expect(naive.stats.cornerFraction).toBeGreaterThanOrEqual(0.2);
    expect(naive.stats.cornerFraction).toBeGreaterThanOrEqual(2 * smooth.stats.cornerFraction);
    expect(iou).toBeGreaterThanOrEqual(naiveIou);
    expect(iou).toBeGreaterThan(0.97);
  });

  it('orange disc on white with no mode (classify + trace): lines, one #ffa500 layer, IoU >= 0.97', async () => {
    // Regression: the Otsu level clamped to [0.35, 0.65] sat above the whole orange disc (luma 173):
    // 0 ink px and an empty SVG without any warning. Measured now: IoU 0.9954.
    const { image, maskAt } = colourDisc([255, 165, 0]);
    const res = await trace(image, {}, tracers);
    expect(res.resolved.mode).toBe('lines');
    expect(res.resolved.upscale).toBe(4);
    expect(res.warnings).toEqual([]);
    const parsed = parseSvg(res.svg);
    expect(parsed.layers).toHaveLength(1);
    expect(parsed.layers[0].fill).toBe('#ffa500');
    expect(res.stats.nodeCount).toBeGreaterThan(0);
    const iou = maskIoU(binarise(rasterizeMask(parsed.paths, 256, 256)), maskAt(4));
    console.info(`orange disc (auto) IoU=${iou.toFixed(4)} nodes=${res.stats.nodeCount}`);
    expect(iou).toBeGreaterThanOrEqual(0.97);
  });

  it('aaDiagonalLine: exactly one path, cornerFraction < 0.2 (capsule with round caps)', async () => {
    const { image, maskAt } = aaDiagonalLine();
    const res = await trace(image, SMOOTH, tracers);
    const parsed = parseSvg(res.svg);
    expect(parsed.layers).toHaveLength(1);
    expect(res.stats.pathCount).toBe(1);
    expect(res.stats.subpathCount).toBe(1);
    expect(subpathCount(parsed.paths[0])).toBe(1);
    expect(res.stats.cornerFraction).toBeLessThan(0.2);
    const traced = binarise(rasterizeMask(parsed.paths, 256, 256));
    const ideal = maskAt(4);
    const iou = maskIoU(traced, ideal);
    const naive = await trace(image, NAIVE, tracers);
    console.info(
      `aaDiagonalLine cornerFraction: naive=${naive.stats.cornerFraction.toFixed(3)} smoothed=${res.stats.cornerFraction.toFixed(3)} ` +
        `IoU=${iou.toFixed(4)} ink ratio traced/ideal=${(countInk(traced) / countInk(ideal)).toFixed(3)} thinStrokes=${res.warnings.some((w) => w.code === 'thin-strokes')}`,
    );
    // A 1.5 px line is 6 px wide at 4x. resolveThreshold binarises at the 50 % coverage
    // iso-level between the ink (a low percentile of the ink class, measured on the 1x source)
    // and the paper: measured IoU 0.954, ink ratio 0.995. (The old clamped Otsu level sat on its
    // 0.65 cap in this 97 % white image: 27 % too wide, IoU 0.786.)
    expect(iou).toBeGreaterThan(0.93);
    expect(countInk(traced) / countInk(ideal)).toBeGreaterThan(0.9);
    expect(countInk(traced) / countInk(ideal)).toBeLessThan(1.1);
    expect(res.warnings.map((w) => w.code)).toEqual(['thin-strokes']);
  });

  it('glyph: one component with one hole (2 subpaths), cornerFraction < 0.25', async () => {
    const { image, maskAt } = glyph();
    const res = await trace(image, SMOOTH, tracers);
    const parsed = parseSvg(res.svg);
    expect(parsed.layers).toHaveLength(1);
    expect(res.stats.pathCount).toBe(1);
    expect(res.stats.subpathCount).toBe(2);
    expect(subpathCount(parsed.paths[0])).toBe(2);
    expect(res.svg).toContain('fill-rule="evenodd"');
    expect(res.stats.cornerFraction).toBeLessThan(0.25);
    const iou = maskIoU(binarise(rasterizeMask(parsed.paths, 192, 192)), maskAt(4));
    const naive = await trace(image, NAIVE, tracers);
    console.info(
      `glyph cornerFraction: naive=${naive.stats.cornerFraction.toFixed(3)} smoothed=${res.stats.cornerFraction.toFixed(3)} IoU=${iou.toFixed(4)}`,
    );
    expect(iou).toBeGreaterThan(0.95);
  });

  it('transparentLogo: alphaMode auto -> mask, IoU vs maskAt(4) > 0.97, fill = the logo colour', async () => {
    const { image, maskAt } = transparentLogo();
    const info = analyzeSource(image);
    expect(info.transparentRatio).toBeGreaterThan(0.05);
    expect(resolveAlphaMode(info, 'auto')).toBe('mask');
    const res = await trace(image, SMOOTH, tracers, info);
    expect(res.resolved.alphaMode).toBe('auto');
    const parsed = parseSvg(res.svg);
    expect(parsed.layers).toHaveLength(1);
    expect(parsed.layers[0].fill).toBe('#1d3557');
    expect(res.svg).not.toContain('<rect');
    const iou = maskIoU(binarise(rasterizeMask(parsed.paths, 256, 256)), maskAt(4));
    console.info(`transparentLogo IoU=${iou.toFixed(4)} cornerFraction=${res.stats.cornerFraction.toFixed(3)}`);
    expect(iou).toBeGreaterThan(0.97);
  });

  it('white and #f4f4f4 logos on transparent: only the alpha mask sees them (auto -> mask IoU >= 0.97 in the logo colour; composite < 0.5)', async () => {
    // The navy logo above traces the same with alphaMode 'composite' (its luma is linear in alpha),
    // so it cannot tell the branches apart. A white (or near-white) logo composited over the white
    // fallback background has no ink/paper separation: only the alpha mask recovers the star.
    const cases: Array<[string, RGB, string]> = [
      ['white', [255, 255, 255], '#ffffff'],
      ['#f4f4f4', [244, 244, 244], '#f4f4f4'],
    ];
    for (const [name, rgb, hex] of cases) {
      const { image, maskAt } = recolouredLogo(rgb);
      const info = analyzeSource(image);
      expect(info.transparentRatio, name).toBeGreaterThan(0.05);
      expect(resolveAlphaMode(info, 'auto'), name).toBe('mask');
      const ideal = maskAt(4);

      const auto = await trace(image, SMOOTH, tracers, info);
      expect(auto.resolved.alphaMode, name).toBe('auto');
      expect(auto.warnings, name).toEqual([]);
      const parsed = parseSvg(auto.svg);
      expect(parsed.layers, name).toHaveLength(1);
      expect(parsed.layers[0].fill, name).toBe(hex);
      const iou = maskIoU(binarise(rasterizeMask(parsed.paths, 256, 256)), ideal);
      expect((await trace(image, { ...SMOOTH, alphaMode: 'mask' }, tracers, info)).svg, name).toBe(auto.svg);

      const composite = await trace(image, { ...SMOOTH, alphaMode: 'composite' }, tracers, info);
      const compositeIou = maskIoU(binarise(rasterizeMask(parseSvg(composite.svg).paths, 256, 256)), ideal);
      console.info(`${name} logo on transparent: mask IoU=${iou.toFixed(4)} composite IoU=${compositeIou.toFixed(4)}`);
      expect(iou, name).toBeGreaterThanOrEqual(0.97);
      expect(compositeIou, name).toBeLessThan(0.5);
      // The image is not blank (its alpha varies), so the empty composite trace must say so.
      expect(composite.warnings.map((w) => w.code), name).toEqual(['empty-trace']);

      // Fully automatic (no mode): classified lines, traced through the mask in the logo colour.
      const full = await trace(image, {}, tracers);
      expect(full.resolved.mode, name).toBe('lines');
      expect(parseSvg(full.svg).layers.map((l) => l.fill), name).toEqual([hex]);
    }
  });
});

describe('lines pipeline: no spikes (vtracer)', () => {
  it('aaCircle through vtracer: IoU > 0.97 at 4x', async () => {
    await tracers.vtracer.init(readFileSync(WASM));
    const { image, maskAt } = aaCircle(64, 20);
    const res = await trace(image, { ...SMOOTH, engine: 'vtracer' }, tracers);
    expect(res.resolved.engine).toBe('vtracer');
    expect(res.warnings).toEqual([]);
    const parsed = parseSvg(res.svg);
    expect(parsed.layers).toHaveLength(1);
    const iou = maskIoU(binarise(rasterizeMask(parsed.paths, 256, 256)), maskAt(4));
    // vtracer emits C even for straight runs: cornerFraction is not comparable, only printed.
    console.info(`aaCircle (vtracer) IoU=${iou.toFixed(4)} cornerFraction=${res.stats.cornerFraction.toFixed(3)} nodes=${res.stats.nodeCount}`);
    expect(iou).toBeGreaterThan(0.97);
  });
});
