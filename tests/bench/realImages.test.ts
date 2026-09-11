/**
 * Bench over REAL user images (samples/*.png). Skipped unless BENCH=1:
 *
 *   BENCH=1 npx vitest run tests/bench
 *
 * For every image: analyzeSource + classify, trace with the classified params (potrace),
 * fidelity of the SVG rendered back through the reference rasteriser against the effective source
 * (a painted fake-transparency checkerboard made transparent), and the naive
 * cornerFraction for lines/flat images (the same resolved params except upscale 1 and blur 0).
 * One aligned table at the end, then per-image regression floors (fidelity and IoU).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { Engine, RGB, RasterImage, ResolvedParams, Tracer, TraceParams, TraceResult } from '../../src/types';
import { trace } from '../../src/core/pipeline';
import { analyzeSource, classify } from '../../src/core/classify';
import { effectiveSource } from '../../src/core/bakedBackground';
import { computeMetrics } from '../../src/metrics/fidelity';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { hexToRgb, parseSvg, renderAt1x } from '../fixtures/svgBack';

const SAMPLES = path.join(process.cwd(), 'samples');

/**
 * Measured on 2026-09-10 with the classified params (potrace), after the fake-transparency
 * checkerboard (clip_art, splash: compared with the effective source) and the spatial-coherence
 * palette rule (table in ARCHITECTURE.md, "Decisiones de implementación"). Before them clip_art
 * measured 0.869 / 0.874 and splash 0.888 / 0.809.
 * A run fails when fidelity drops more than FIDELITY_SLACK or IoU more than IOU_SLACK below them.
 */
const MEASURED: Record<string, { fidelity: number; iou: number }> = {
  GENTERA: { fidelity: 0.999, iou: 0.999 },
  Instagram: { fidelity: 0.94, iou: 0.862 },
  clip_art: { fidelity: 0.961, iou: 0.913 },
  eagle: { fidelity: 0.9, iou: 0.776 },
  'Compartamos avatar': { fidelity: 0.995, iou: 0.988 },
  splash: { fidelity: 0.899, iou: 0.816 },
};
const FIDELITY_SLACK = 0.02;
const IOU_SLACK = 0.03;

/** The params that resolve to `r` again, except upscale 1 and blur 0 (the naive baseline). */
function naiveParams(r: ResolvedParams): TraceParams {
  return {
    mode: r.mode,
    engine: r.engine,
    upscale: 1,
    blurK: 0,
    thresholdOffset: r.thresholdOffset,
    invert: r.invert,
    alphamax: r.alphamax,
    opttolerance: r.opttolerance,
    turdsize: r.turdsize,
    turnpolicy: r.turnpolicy,
    opticurve: r.opticurve,
    colors: r.colors,
    exactPalette: r.exactPalette,
    layering: r.layering,
    background: r.background,
    alphaMode: r.alphaMode,
    fill: r.fill,
    gridScale: r.gridScale,
    vtracer: { ...r.vtracer },
    optimize: r.optimize,
    bakedBackground: r.bakedBackground,
  };
}
const WHITE: RGB = [255, 255, 255];
const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };

function decode(file: string): RasterImage {
  const png = PNG.sync.read(readFileSync(path.join(SAMPLES, file)));
  return { data: Uint8ClampedArray.from(png.data), width: png.width, height: png.height };
}

interface Row {
  name: string;
  dims: string;
  mode: string;
  U: number;
  ms: number;
  layers: number;
  paths: number;
  nodes: number;
  corner: number;
  naive: number;
  bytes: number;
  fidelity: number;
  ssim: number;
  iou: number;
  mae: number;
  pct16: number;
  warnings: string;
}

function pad(s: string, n: number, right = false): string {
  return right ? s.padStart(n) : s.padEnd(n);
}

function fmt(v: number, d: number): string {
  return Number.isFinite(v) ? v.toFixed(d) : '-';
}

function table(rows: Row[]): string {
  const cols: Array<[string, (r: Row) => string, number, boolean]> = [
    ['image', (r) => r.name, 26, false],
    ['dims', (r) => r.dims, 9, true],
    ['mode', (r) => r.mode, 5, false],
    ['U', (r) => String(r.U), 1, true],
    ['ms', (r) => fmt(r.ms, 0), 6, true],
    ['layers', (r) => String(r.layers), 6, true],
    ['paths', (r) => String(r.paths), 5, true],
    ['nodes', (r) => String(r.nodes), 6, true],
    ['corner', (r) => fmt(r.corner, 3), 6, true],
    ['naive', (r) => fmt(r.naive, 3), 5, true],
    ['bytes', (r) => String(r.bytes), 8, true],
    ['fidel', (r) => fmt(r.fidelity, 3), 5, true],
    ['ssim', (r) => fmt(r.ssim, 3), 5, true],
    ['iou', (r) => fmt(r.iou, 3), 5, true],
    ['mae', (r) => fmt(r.mae, 1), 5, true],
    ['pct16', (r) => fmt(r.pct16, 3), 5, true],
    ['warnings', (r) => r.warnings, 20, false],
  ];
  const lines: string[] = [];
  lines.push(cols.map(([h, , w, right]) => pad(h, w, right)).join('  '));
  lines.push(cols.map(([, , w]) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(cols.map(([, f, w, right]) => pad(f(r), w, right)).join('  '));
  return lines.join('\n');
}

const NAMES: Record<string, string> = {
  'GENTERA.MX_fd172f50.png': 'GENTERA',
  'Instagram_Logo.png': 'Instagram',
  'clip_art_graphic_design_.png': 'clip_art',
  'colorful_eagle_head_logo.png': 'eagle',
  'emp_20032380_Avatar_Comp.png': 'Compartamos avatar',
  'vector_brillante_salpica.png': 'splash',
};

describe.skipIf(process.env.BENCH !== '1')('bench: real images (potrace)', () => {
  it('classifies, traces and measures every sample', async () => {
    const files = readdirSync(SAMPLES)
      .filter((f) => f.endsWith('.png'))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const rows: Row[] = [];
    const byName = new Map<
      string,
      { result: TraceResult; layers: number; info: ReturnType<typeof analyzeSource>; fidelity: number; iou: number }
    >();

    for (const file of files) {
      const name = NAMES[file] ?? file;
      const img = decode(file);
      const info = analyzeSource(img);
      const cls = classify(info);
      console.info(`\n== ${name} (${file}) ${img.width}x${img.height}`);
      console.info(`   mode=${cls.mode} params=${JSON.stringify(cls.params)} warnings=[${cls.warnings.map((w) => w.code).join(',')}]`);
      for (const r of cls.reasons) console.info(`   reason: ${r}`);
      console.info(
        `   distinctColors=${info.distinctColors} paletteColors=${info.paletteColors} offPaletteRatio=${info.offPaletteRatio.toFixed(3)} ` +
          `quantError=${info.quantError.toFixed(1)} hardEdgeRatio=${info.hardEdgeRatio.toFixed(3)} isBimodal=${info.isBimodal} grid=${info.grid} ` +
          `transparentRatio=${info.transparentRatio.toFixed(3)} partialAlphaRatio=${info.partialAlphaRatio.toFixed(3)} ` +
          `borderColor=${JSON.stringify(info.borderColor)} thinStrokeRatio=${info.thinStrokeRatio.toFixed(3)}`,
      );

      const result = await trace(img, { engine: 'potrace' }, tracers, info);
      const parsed = parseSvg(result.svg);
      const bg: RGB = info.borderColor ?? WHITE;
      const rendered = renderAt1x(parsed, bg);
      // A fake-transparency checkerboard is transparent in the source the SVG is compared with.
      const original = effectiveSource(img, info, result.resolved);
      const m = computeMetrics({ original, rendered, mode: result.resolved.mode, background: bg });

      let naive = Number.NaN;
      if (result.resolved.mode !== 'pixel') {
        const n = await trace(img, naiveParams(result.resolved), tracers, info);
        // Same resolved params (photo: colors 16 AND exactPalette false) except the upscale and blur.
        const R = result.resolved;
        expect(n.resolved.upscale, name).toBe(1);
        expect(n.resolved.sigmaPx, name).toBe(0);
        expect(
          { ...n.resolved, upscale: R.upscale, upscaleCapped: R.upscaleCapped, sigmaPx: R.sigmaPx, turdsizeScaled: R.turdsizeScaled },
          name,
        ).toEqual(R);
        naive = n.stats.cornerFraction;
      }
      console.info(
        `   U=${result.resolved.upscale} ms=${result.ms.toFixed(0)} layers=${parsed.layers.length} paths=${result.stats.pathCount} ` +
          `nodes=${result.stats.nodeCount} cornerFraction=${result.stats.cornerFraction.toFixed(3)} naive=${fmt(naive, 3)} bytes=${result.stats.bytes} ` +
          `fidelity=${m.fidelity.toFixed(3)} ssim=${m.ssim.toFixed(3)} iou=${m.iou.toFixed(3)} mae=${m.mae.toFixed(1)} pctDiff16=${m.pctDiff16.toFixed(3)} ` +
          `warnings=[${result.warnings.map((w) => w.code).join(',')}]`,
      );
      rows.push({
        name,
        dims: `${img.width}x${img.height}`,
        mode: result.resolved.mode,
        U: result.resolved.upscale,
        ms: result.ms,
        layers: parsed.layers.length,
        paths: result.stats.pathCount,
        nodes: result.stats.nodeCount,
        corner: result.stats.cornerFraction,
        naive,
        bytes: result.stats.bytes,
        fidelity: m.fidelity,
        ssim: m.ssim,
        iou: m.iou,
        mae: m.mae,
        pct16: m.pctDiff16,
        warnings: result.warnings.map((w) => w.code).join(',') || '-',
      });
      byName.set(name, { result, layers: parsed.layers.length, info, fidelity: m.fidelity, iou: m.iou });
    }

    console.info('\n' + table(rows) + '\n');

    // Expectations from the task (regression guard for real images).
    const get = (
      n: string,
    ): { result: TraceResult; layers: number; info: ReturnType<typeof analyzeSource>; fidelity: number; iou: number } => {
      const v = byName.get(n);
      if (v === undefined) throw new Error(`falta la muestra ${n}`);
      return v;
    };
    const gentera = get('GENTERA');
    expect(gentera.result.resolved.mode).toBe('flat');
    expect(gentera.result.warnings.map((w) => w.code)).not.toContain('photo');
    expect(gentera.layers).toBe(6);
    expect(gentera.result.svg).not.toContain('<rect');

    const insta = get('Instagram');
    expect(insta.result.resolved.upscale).toBe(1);
    expect(insta.result.warnings.map((w) => w.code)).toContain('photo');

    // clip_art: the painted checkerboard (20 px cells, 238 / 254) is transparent, so no grey
    // background layer; the orange fish survive (spatial coherence) and the JPEG ringing band
    // (~(194, 21, 108)) does not.
    const clip = get('clip_art');
    expect(clip.result.resolved.mode).toBe('flat');
    expect(clip.result.warnings.map((w) => w.code)).not.toContain('photo');
    expect(clip.result.warnings[0]?.code).toBe('baked-checkerboard');
    expect(clip.info.bakedBackground?.cell).toBeCloseTo(20, 1);
    expect(clip.info.paletteColors).toBe(2);
    expect(clip.layers).toBe(2);
    const clipFills = parseSvg(clip.result.svg).layers.map((l) => hexToRgb(l.fill));
    expect(clipFills.some(([r, g, b]) => r > 200 && g > 140 && g < 210 && b < 120), 'capa naranja').toBe(true);
    expect(clipFills.some(([r, g, b]) => Math.hypot(r - 194, g - 21, b - 108) < 20), 'capa de ringing').toBe(false);
    expect(clipFills.some(([r, g, b]) => Math.min(r, g, b) > 200), 'capa de fondo gris').toBe(false);

    const avatar = get('Compartamos avatar');
    expect(avatar.result.resolved.mode).toBe('flat');
    expect(avatar.result.warnings.map((w) => w.code)).not.toContain('photo');
    expect(avatar.layers).toBeGreaterThanOrEqual(3);
    expect(avatar.layers).toBeLessThanOrEqual(4);

    expect(get('eagle').result.warnings.map((w) => w.code)).toContain('photo');
    const splash = get('splash');
    expect(splash.result.warnings.map((w) => w.code)).toEqual(['baked-checkerboard', 'photo']);
    expect(splash.info.bakedBackground?.cell).toBeGreaterThan(32);
    expect(splash.info.bakedBackground?.cell).toBeLessThan(33);
    // Fake transparency only where it is painted.
    for (const n of ['GENTERA', 'Instagram', 'eagle', 'Compartamos avatar']) {
      expect(get(n).info.bakedBackground, n).toBeNull();
      expect(get(n).result.warnings.map((w) => w.code), n).not.toContain('baked-checkerboard');
    }

    // Per-image regression floors: every sample must have measured numbers.
    for (const name of byName.keys()) {
      const floor = MEASURED[name] as { fidelity: number; iou: number } | undefined;
      expect(floor, `sin medidas de referencia para ${name}`).toBeDefined();
      if (floor === undefined) continue;
      const v = get(name);
      expect(v.fidelity, `${name} fidelity`).toBeGreaterThanOrEqual(floor.fidelity - FIDELITY_SLACK);
      expect(v.iou, `${name} IoU`).toBeGreaterThanOrEqual(floor.iou - IOU_SLACK);
    }
    expect([...byName.keys()].sort()).toEqual(Object.keys(MEASURED).sort());
  }, 900000);
});
