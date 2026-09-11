/**
 * Gradient probe table (gradient mode, phase 7). Skipped unless BENCH=1:
 *
 *   BENCH=1 npx vitest run tests/bench/gradientProbe.test.ts
 *
 * For the 7 real samples and the gradient fixtures: probeGradients on the effective source (sigma, edgeShare,
 * regions, explained, linearShare, radialShare), its time on the <= 512 px proxy (median of 5 runs after a warm-up)
 * and on the full image (proxy build included), whether analyzeSource runs it (the photo branch), the palette facts
 * that decide that branch and the classified mode. For the samples also the fidelity of the classified trace and of
 * a trace forced to mode 'gradient' (potrace, the realImages bench measure). The constants of the gradient rule are
 * chosen from this table (ARCHITECTURE.md, "Decisiones de implementación", gradient mode phase 7).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { Engine, GradientProbe, RasterImage, RGB, SourceInfo, Tracer, TraceParams } from '../../src/types';
import { analyzeSource, classify, gradientProbeFactor, offPaletteShare, probeGradients } from '../../src/core/classify';
import { effectiveSource } from '../../src/core/bakedBackground';
import { TRANSPARENT_AUTO_RATIO } from '../../src/core/background';
import { downscaleBoxRaster } from '../../src/core/upscale';
import { trace } from '../../src/core/pipeline';
import { diagonalSweep, flatShapes3, gradientFeathers, noisePhoto, radialDisc, withNoise } from '../../src/dev/synth';
import { computeMetrics } from '../../src/metrics/fidelity';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { parseSvg, renderAt1x } from '../fixtures/svgBack';

const SAMPLES = path.join(process.cwd(), 'samples');
const WHITE: RGB = [255, 255, 255];
const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };

const NAMES: Record<string, string> = {
  'GENTERA.MX_fd172f50.png': 'GENTERA',
  'Instagram_Logo.png': 'Instagram',
  'clip_art_graphic_design_.png': 'clip_art',
  'colorful_eagle_head_logo.png': 'eagle',
  'emp_20032380_Avatar_Comp.png': 'Compartamos avatar',
  'vector_brillante_salpica.png': 'splash',
  'pajaro.png': 'pajaro',
};

function decode(file: string): RasterImage {
  const png = PNG.sync.read(readFileSync(path.join(SAMPLES, file)));
  return { data: Uint8ClampedArray.from(png.data), width: png.width, height: png.height };
}

interface Row {
  name: string;
  dims: string;
  f: number;
  pal: string;
  offShare: number;
  branch: boolean;
  probe: GradientProbe;
  proxyMs: number;
  fullMs: number;
  mode: string;
  fidAuto: number;
  fidGradient: number;
  gradientNote: string;
}

function fmt(v: number, d: number): string {
  return Number.isFinite(v) ? v.toFixed(d) : '-';
}

function table(rows: Row[]): string {
  const cols: Array<[string, (r: Row) => string, number, boolean]> = [
    ['image', (r) => r.name, 20, false],
    ['dims', (r) => r.dims, 9, true],
    ['f', (r) => String(r.f), 2, true],
    ['pal', (r) => r.pal, 4, true],
    ['offSh', (r) => fmt(r.offShare, 3), 5, true],
    ['probe', (r) => (r.branch ? 'yes' : 'no'), 5, false],
    ['sigma', (r) => fmt(r.probe.sigma, 3), 6, true],
    ['edge', (r) => fmt(r.probe.edgeShare, 3), 5, true],
    ['reg', (r) => String(r.probe.regions), 5, true],
    ['expl', (r) => fmt(r.probe.explained, 3), 5, true],
    ['lin', (r) => fmt(r.probe.linearShare, 3), 5, true],
    ['rad', (r) => fmt(r.probe.radialShare, 3), 5, true],
    ['pxMs', (r) => fmt(r.proxyMs, 1), 6, true],
    ['fullMs', (r) => fmt(r.fullMs, 0), 6, true],
    ['mode', (r) => r.mode, 8, false],
    ['fidAuto', (r) => fmt(r.fidAuto, 4), 7, true],
    ['fidGrad', (r) => fmt(r.fidGradient, 4), 7, true],
    ['gradient trace', (r) => r.gradientNote, 14, false],
  ];
  const lines: string[] = [];
  lines.push(cols.map(([h, , w, right]) => (right ? h.padStart(w) : h.padEnd(w))).join('  '));
  lines.push(cols.map(([, , w]) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(cols.map(([, fn, w, right]) => (right ? fn(r).padStart(w) : fn(r).padEnd(w))).join('  '));
  return lines.join('\n');
}

/** The background probeGradients gets from analyzeSource: null when transparent ('auto'), else border colour or white. */
function probeBackground(info: SourceInfo): RGB | null {
  return info.transparentRatio > TRANSPARENT_AUTO_RATIO ? null : (info.borderColor ?? WHITE);
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** probeGradients on the effective source, timed on the full image and on its <= 512 px proxy. */
function measureProbe(eff: RasterImage, info: SourceInfo): { probe: GradientProbe; fullMs: number; proxyMs: number; f: number } {
  const bg = probeBackground(info);
  let t = performance.now();
  const probe = probeGradients(eff, bg);
  const fullMs = performance.now() - t;
  const f = gradientProbeFactor(eff.width, eff.height);
  // Opaque proxy (the timing only: the transparent path downscales premultiplied colour).
  const proxy = f === 1 ? eff : downscaleBoxRaster(eff, f);
  probeGradients(proxy, bg);
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    t = performance.now();
    probeGradients(proxy, bg);
    times.push(performance.now() - t);
  }
  return { probe, fullMs, proxyMs: median(times), f };
}

async function fidelityOf(img: RasterImage, info: SourceInfo, params: TraceParams): Promise<{ fidelity: number; note: string; mode: string }> {
  const res = await trace(img, { engine: 'potrace', ...params }, tracers, info);
  const bg: RGB = info.borderColor ?? WHITE;
  const rendered = renderAt1x(parseSvg(res.svg), bg);
  const original = effectiveSource(img, info, res.resolved);
  const m = computeMetrics({ original, rendered, mode: res.resolved.mode, background: bg });
  const layers = parseSvg(res.svg).layers;
  const lin = (res.svg.match(/<linearGradient\b/g) ?? []).length;
  const rad = (res.svg.match(/<radialGradient\b/g) ?? []).length;
  const fallback = res.warnings.some((w) => w.code === 'gradient-fallback');
  const note = fallback ? `fallback ${layers.length}` : `${layers.length}L ${lin}lin ${rad}rad`;
  return { fidelity: m.fidelity, note, mode: res.resolved.mode };
}

describe.skipIf(process.env.BENCH !== '1')('bench: gradient probe', () => {
  it('prints the probe table of the samples and the gradient fixtures', async () => {
    const rows: Row[] = [];
    const files = readdirSync(SAMPLES)
      .filter((f) => f.endsWith('.png'))
      .sort();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const name = NAMES[file] ?? file;
      const img = decode(file);
      const info = analyzeSource(img);
      const eff = effectiveSource(img, info, {});
      const { probe, fullMs, proxyMs, f } = measureProbe(eff, info);
      const cls = classify(info);
      const auto = await fidelityOf(img, info, {});
      const grad = await fidelityOf(img, info, { mode: 'gradient' });
      const offShare = offPaletteShare(info);
      rows.push({
        name,
        dims: `${img.width}x${img.height}`,
        f,
        pal: info.paletteColors === null ? 'null' : String(info.paletteColors),
        offShare,
        branch: info.gradientProbe !== null,
        probe,
        proxyMs,
        fullMs,
        mode: cls.mode + (cls.warnings.some((w) => w.code === 'photo') ? '*' : ''),
        fidAuto: auto.fidelity,
        fidGradient: grad.fidelity,
        gradientNote: grad.note,
      });
      if (info.gradientProbe !== null) expect(info.gradientProbe, name).toEqual(probe);
    }

    const fixtures: Array<[string, RasterImage]> = [
      ['gradientFeathers', gradientFeathers(256).image],
      ['radialDisc', radialDisc(128).image],
      ['diagonalSweep', diagonalSweep(128).image],
      ['gradientFeathers ±3', withNoise(gradientFeathers(256).image, 3, 1)],
      ['noisePhoto', noisePhoto()],
      ['noisePhoto(256)', noisePhoto(256)],
      ['flatShapes3', flatShapes3().image],
    ];
    for (const [name, img] of fixtures) {
      const info = analyzeSource(img);
      const { probe, fullMs, proxyMs, f } = measureProbe(img, info);
      const cls = classify(info);
      rows.push({
        name,
        dims: `${img.width}x${img.height}`,
        f,
        pal: info.paletteColors === null ? 'null' : String(info.paletteColors),
        offShare: offPaletteShare(info),
        branch: info.gradientProbe !== null,
        probe,
        proxyMs,
        fullMs,
        mode: cls.mode + (cls.warnings.some((w) => w.code === 'photo') ? '*' : ''),
        fidAuto: Number.NaN,
        fidGradient: Number.NaN,
        gradientNote: '',
      });
    }

    console.info('\n(mode: the classified mode, * = photo warning; probe: analyzeSource runs it)\n' + table(rows) + '\n');
    for (const r of rows) {
      for (const v of [r.probe.explained, r.probe.linearShare, r.probe.radialShare, r.probe.edgeShare]) {
        expect(v, r.name).toBeGreaterThanOrEqual(0);
        expect(v, r.name).toBeLessThanOrEqual(1);
      }
      expect(r.probe.linearShare + r.probe.radialShare, r.name).toBeLessThanOrEqual(1 + 1e-9);
    }
  }, 900000);
});
