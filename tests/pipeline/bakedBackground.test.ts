/**
 * Fake transparency end to end: a logo over a checkerboard painted into an opaque image is traced
 * without the checkerboard (transparent path, no background layer) unless bakedBackground 'keep'.
 */
import { describe, expect, it } from 'vitest';
import type { Engine, RGB, RasterImage, Tracer } from '../../src/types';
import { trace } from '../../src/core/pipeline';
import { analyzeSource } from '../../src/core/classify';
import { effectiveSource } from '../../src/core/bakedBackground';
import { computeMetrics } from '../../src/metrics/fidelity';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { bakedCheckerLogo, chessboardGraphic, type BakedCheckerLogoOptions } from '../../src/dev/synth';
import { hexToRgb, parseSvg, renderAt1x } from '../fixtures/svgBack';
import { barOnBoard, diagonalStripes, outlinedSprite } from '../fixtures/shapes';

const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };
const WHITE: RGB = [255, 255, 255];
const C10: BakedCheckerLogoOptions = { cell: 10 };
const C16: BakedCheckerLogoOptions = { cell: 16, offset: [5, 11], levels: [238, 255] };

function alphaAt(img: RasterImage, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4 + 3];
}

function corners(img: RasterImage): Array<[number, number]> {
  return [
    [0, 0],
    [img.width - 1, 0],
    [0, img.height - 1],
    [img.width - 1, img.height - 1],
  ];
}

describe('trace over a painted checkerboard (potrace)', () => {
  it('auto: warning first, only ink layers, transparent corners, fidelity vs the effective source >= 0.97', async () => {
    for (const opts of [C10, C16]) {
      const { image } = bakedCheckerLogo(opts);
      const info = analyzeSource(image);
      const res = await trace(image, { engine: 'potrace' }, tracers, info);
      expect(res.resolved.bakedBackground).toBe('auto');
      expect(res.warnings[0]?.code).toBe('baked-checkerboard');
      expect(res.warnings[0].message).toContain('tablero de ajedrez');
      expect(res.warnings[0].message).toContain(`${opts.cell} px`);
      expect(res.warnings[0].message).not.toMatch(/[–—]/);
      const parsed = parseSvg(res.svg);
      expect(parsed.layers.length).toBeGreaterThan(0);
      for (const layer of parsed.layers) {
        const [r, g, b] = hexToRgb(layer.fill);
        expect(r).toBeGreaterThan(180);
        expect(g).toBeLessThan(60);
        expect(b).toBeGreaterThan(90);
      }
      const clear = renderAt1x(parsed, null);
      for (const [x, y] of corners(image)) expect(alphaAt(clear, x, y)).toBe(0);
      const bg = info.borderColor ?? WHITE;
      const m = computeMetrics({
        original: effectiveSource(image, info, res.resolved),
        rendered: renderAt1x(parsed, bg),
        mode: res.resolved.mode,
        background: bg,
      });
      expect(m.fidelity).toBeGreaterThanOrEqual(0.97);
    }
  });

  it('flat mode keeps the letter counters transparent', async () => {
    const f = bakedCheckerLogo({ ...C10, inner: 'counters' });
    const res = await trace(f.image, { mode: 'flat', engine: 'potrace' }, tracers);
    expect(res.warnings[0]?.code).toBe('baked-checkerboard');
    const clear = renderAt1x(parseSvg(res.svg), null);
    let counters = 0;
    let transparent = 0;
    for (let i = 0; i < f.counters.data.length; i++) {
      if (f.counters.data[i] === 0) continue;
      counters++;
      if (clear.data[i * 4 + 3] < 128) transparent++;
    }
    expect(counters).toBeGreaterThan(100);
    expect(transparent / counters).toBeGreaterThanOrEqual(0.95);
  });

  it('a genuine white rectangle inside the logo is traced as a white layer', async () => {
    const f = bakedCheckerLogo({ ...C16, inner: 'whiteRect' });
    const res = await trace(f.image, { engine: 'potrace' }, tracers);
    expect(res.resolved.mode).toBe('flat');
    const parsed = parseSvg(res.svg);
    expect(parsed.layers.some((l) => Math.min(...hexToRgb(l.fill)) >= 245)).toBe(true);
    const onBlack = renderAt1x(parsed, [0, 0, 0]);
    let rect = 0;
    let white = 0;
    for (let i = 0; i < f.whiteRect.data.length; i++) {
      if (f.whiteRect.data[i] === 0) continue;
      rect++;
      if (Math.min(onBlack.data[i * 4], onBlack.data[i * 4 + 1], onBlack.data[i * 4 + 2]) >= 240) white++;
    }
    expect(white / rect).toBeGreaterThanOrEqual(0.95);
  });

  it("keep: the painted pixels are traced as they are (opaque corners, no warning), even with the cached 'auto' analysis", async () => {
    const { image } = bakedCheckerLogo(C10);
    const info = analyzeSource(image);
    const res = await trace(image, { engine: 'potrace', bakedBackground: 'keep' }, tracers, info);
    expect(res.resolved.bakedBackground).toBe('keep');
    expect(res.warnings.map((w) => w.code)).not.toContain('baked-checkerboard');
    const clear = renderAt1x(parseSvg(res.svg), null);
    for (const [x, y] of corners(image)) expect(alphaAt(clear, x, y)).toBe(255);
  });

  it('explicit pixel mode without an analysis still removes the checkerboard', async () => {
    const { image } = bakedCheckerLogo(C16);
    const auto = await trace(image, { mode: 'pixel' }, tracers);
    const keep = await trace(image, { mode: 'pixel', bakedBackground: 'keep' }, tracers);
    expect(auto.warnings[0]?.code).toBe('baked-checkerboard');
    expect(keep.warnings.map((w) => w.code)).not.toContain('baked-checkerboard');
    expect(auto.stats.subpathCount).toBeLessThan(keep.stats.subpathCount / 2);
  });

  it('a real chessboard graphic on a solid background is traced, not erased', async () => {
    const { image } = chessboardGraphic();
    const res = await trace(image, { mode: 'flat', engine: 'potrace' }, tracers);
    expect(res.warnings.map((w) => w.code)).not.toContain('baked-checkerboard');
    const fills = parseSvg(res.svg).layers.map((l) => l.fill);
    expect(fills).toContain('#ffffff');
    expect(fills).toContain('#cccccc');
  });

  it('a light bar touching the board is traced whole: opaque over both levels, faithful on black', async () => {
    const f = barOnBoard([255, 204], 255);
    const info = analyzeSource(f.image);
    const res = await trace(f.image, { engine: 'potrace' }, tracers, info);
    expect(res.warnings[0]?.code).toBe('baked-checkerboard');
    const parsed = parseSvg(res.svg);
    const clear = renderAt1x(parsed, null);
    let holes = 0;
    for (let i = 0; i < f.bar.data.length; i++) if (f.bar.data[i] !== 0 && clear.data[i * 4 + 3] < 128) holes++;
    expect(holes).toBeLessThanOrEqual(8);
    const black: RGB = [0, 0, 0];
    const m = computeMetrics({ original: f.truth, rendered: renderAt1x(parsed, black), mode: res.resolved.mode, background: black });
    expect(m.fidelity).toBeGreaterThanOrEqual(0.97);
  });

  it('pixel mode keeps a hard-edged sprite exact: no translucent rects next to its outline', async () => {
    const f = outlinedSprite();
    const res = await trace(f.image, { mode: 'pixel' }, tracers, analyzeSource(f.image));
    expect(res.warnings[0]?.code).toBe('baked-checkerboard');
    expect(res.svg).not.toContain('fill-opacity');
    const clear = renderAt1x(parseSvg(res.svg), null);
    let wrong = 0;
    for (let i = 0; i < f.sprite.data.length; i++) {
      const p = i * 4;
      for (let c = 0; c < 4; c++) if (clear.data[p + c] !== f.truth.data[p + c]) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it('light diagonal stripes are a design, not fake transparency: no warning, nothing erased', async () => {
    const image = diagonalStripes(200, 150, 18, [255, 230]);
    const info = analyzeSource(image);
    expect(info.bakedBackground).toBeNull();
    expect(info.transparentRatio).toBe(0);
    const res = await trace(image, { engine: 'potrace' }, tracers, info);
    expect(res.warnings.map((w) => w.code)).not.toContain('baked-checkerboard');
    expect(effectiveSource(image, info, res.resolved)).toBe(image);
    // In Color plano both stripe levels come back as opaque layers.
    const flat = await trace(image, { engine: 'potrace', mode: 'flat' }, tracers, info);
    expect(flat.warnings.map((w) => w.code)).not.toContain('baked-checkerboard');
    const clear = renderAt1x(parseSvg(flat.svg), null);
    let transparent = 0;
    for (let i = 0; i < 200 * 150; i++) if (clear.data[i * 4 + 3] < 128) transparent++;
    expect(transparent).toBe(0);
    const m = computeMetrics({ original: image, rendered: renderAt1x(parseSvg(flat.svg), WHITE), mode: 'flat', background: WHITE });
    expect(m.pctDiff16).toBeLessThanOrEqual(0.05);
  });
});
