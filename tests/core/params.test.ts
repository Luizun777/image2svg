import { describe, expect, it } from 'vitest';
import type { ConcreteMode, TraceParams } from '../../src/types';
import { DEFAULTS, VTRACER_DEFAULTS, resolveParams } from '../../src/core/params';

const SRC = { width: 500, height: 500 };

describe('DEFAULTS', () => {
  it('vtracer defaults are 60, 4, 10, 45, 4, 6, 16, 3', () => {
    expect(VTRACER_DEFAULTS).toEqual({
      cornerThresholdDeg: 60,
      lengthThreshold: 4,
      maxIterations: 10,
      spliceThresholdDeg: 45,
      filterSpeckle: 4,
      colorPrecision: 6,
      layerDifference: 16,
      pathPrecision: 3,
    });
  });

  it('shared defaults per mode match the plan', () => {
    for (const mode of ['lines', 'flat', 'pixel'] as ConcreteMode[]) {
      const d = DEFAULTS[mode];
      expect(d.engine).toBe('potrace');
      expect(d.alphamax).toBe(1.0);
      expect(d.opttolerance).toBe(0.2);
      expect(d.turdsize).toBe(2);
      expect(d.turnpolicy).toBe('minority');
      expect(d.opticurve).toBe(true);
      expect(d.colors).toBe('auto');
      expect(d.exactPalette).toBe(true);
      expect(d.layering).toBe('stacked');
      expect(d.background).toBe('auto');
      expect(d.alphaMode).toBe('auto');
      expect(d.fill).toBe('auto');
      expect(d.gridScale).toBe('auto');
      expect(d.optimize).toBe(false);
      expect(d.thresholdOffset).toBe(0);
      expect(d.invert).toBe(false);
      expect(d.vtracer).toEqual(VTRACER_DEFAULTS);
    }
    expect(DEFAULTS.lines.blurK).toBe(0.35);
    expect(DEFAULTS.lines.upscale).toBe('auto');
    expect(DEFAULTS.flat.blurK).toBe(0.35);
    expect(DEFAULTS.flat.upscale).toBe('auto');
    expect(DEFAULTS.pixel.blurK).toBe(0);
    expect(DEFAULTS.pixel.upscale).toBe(1);
  });

  it('each mode owns its own vtracer object (no shared mutable state)', () => {
    expect(DEFAULTS.lines.vtracer).not.toBe(DEFAULTS.flat.vtracer);
    expect(DEFAULTS.lines.vtracer).not.toBe(VTRACER_DEFAULTS);
  });
});

describe('resolveParams', () => {
  it('empty params on 500x500 -> lines, U = 4, sigmaPx = 1.4, turdsizeScaled = 32', () => {
    const r = resolveParams({}, SRC);
    expect(r.mode).toBe('lines');
    expect(r.engine).toBe('potrace');
    expect(r.upscale).toBe(4);
    expect(r.upscaleCapped).toBe(false);
    expect(r.sigmaPx).toBeCloseTo(1.4, 10);
    expect(r.turdsize).toBe(2);
    expect(r.turdsizeScaled).toBe(32);
    expect(r.thresholdOffset).toBe(0);
    expect(r.invert).toBe(false);
    expect(r.alphamax).toBe(1);
    expect(r.opttolerance).toBe(0.2);
    expect(r.turnpolicy).toBe('minority');
    expect(r.opticurve).toBe(true);
    expect(r.colors).toBe('auto');
    expect(r.exactPalette).toBe(true);
    expect(r.layering).toBe('stacked');
    expect(r.background).toBe('auto');
    expect(r.alphaMode).toBe('auto');
    expect(r.fill).toBe('auto');
    expect(r.gridScale).toBe('auto');
    expect(r.optimize).toBe(false);
    expect(r.vtracer).toEqual(VTRACER_DEFAULTS);
  });

  it("mode 'auto' uses modeIfAuto, defaulting to 'lines'", () => {
    expect(resolveParams({ mode: 'auto' }, SRC).mode).toBe('lines');
    expect(resolveParams({ mode: 'auto' }, SRC, 'flat').mode).toBe('flat');
    expect(resolveParams({}, SRC, 'pixel').mode).toBe('pixel');
    expect(resolveParams({ mode: 'flat' }, SRC, 'pixel').mode).toBe('flat');
  });

  it('pixel mode forces upscale 1 and sigmaPx 0 even when asked otherwise', () => {
    const r = resolveParams({ mode: 'pixel', upscale: 4, blurK: 0.8 }, SRC);
    expect(r.upscale).toBe(1);
    expect(r.upscaleCapped).toBe(false);
    expect(r.sigmaPx).toBe(0);
    expect(r.turdsizeScaled).toBe(2);
  });

  it('sigmaPx = blurK * U and turdsizeScaled = turdsize * U² for explicit U', () => {
    const r = resolveParams({ upscale: 2, blurK: 0.5, turdsize: 3 }, SRC);
    expect(r.upscale).toBe(2);
    expect(r.sigmaPx).toBe(1);
    expect(r.turdsizeScaled).toBe(12);
    const auto = resolveParams({ blurK: 0.25 }, { width: 800, height: 800 });
    expect(auto.upscale).toBe(2);
    expect(auto.sigmaPx).toBe(0.5);
    expect(auto.turdsizeScaled).toBe(8);
  });

  it('caps explicit upscale to the 16 Mpx budget and reports it', () => {
    const r = resolveParams({ upscale: 4 }, { width: 2500, height: 2500 });
    expect(r.upscale).toBe(1);
    expect(r.upscaleCapped).toBe(true);
    expect(r.sigmaPx).toBeCloseTo(0.35, 10);
    const big = resolveParams({}, { width: 3000, height: 3000 });
    expect(big.upscale).toBe(1);
    expect(big.upscaleCapped).toBe(false);
  });

  it('clamps numeric knobs to their ranges', () => {
    const r = resolveParams(
      {
        alphamax: 5,
        opttolerance: 0,
        turdsize: 1000,
        blurK: -1,
        thresholdOffset: 0.9,
        colors: 100,
      },
      SRC,
    );
    expect(r.alphamax).toBe(1.334);
    expect(r.opttolerance).toBe(0.01);
    expect(r.turdsize).toBe(100);
    expect(r.sigmaPx).toBe(0); // blurK clamped to 0
    expect(r.thresholdOffset).toBe(0.25);
    expect(r.colors).toBe(32);
    const lo = resolveParams({ alphamax: -1, opttolerance: 3, turdsize: -4, blurK: 2, thresholdOffset: -1, colors: 1 }, SRC);
    expect(lo.alphamax).toBe(0);
    expect(lo.opttolerance).toBe(1);
    expect(lo.turdsize).toBe(0);
    expect(lo.sigmaPx).toBe(4); // blurK 1 * U 4
    expect(lo.thresholdOffset).toBe(-0.25);
    expect(lo.colors).toBe(2);
  });

  it('colors: fractional numbers are rounded, auto stays auto', () => {
    expect(resolveParams({ colors: 7.6 }, SRC).colors).toBe(8);
    expect(resolveParams({ colors: 'auto' }, SRC).colors).toBe('auto');
  });

  it('non-finite numbers fall back to defaults', () => {
    const r = resolveParams({ blurK: Number.NaN, alphamax: Number.POSITIVE_INFINITY, turdsize: Number.NaN }, SRC);
    expect(r.sigmaPx).toBeCloseTo(1.4, 10);
    expect(r.alphamax).toBe(1);
    expect(r.turdsize).toBe(2);
  });

  it('merges partial vtracer over defaults and ignores undefined entries', () => {
    const r = resolveParams({ vtracer: { cornerThresholdDeg: 30, filterSpeckle: undefined } }, SRC);
    expect(r.vtracer).toEqual({ ...VTRACER_DEFAULTS, cornerThresholdDeg: 30 });
    expect(r.vtracer).not.toBe(VTRACER_DEFAULTS);
  });

  it('passes through the remaining user choices', () => {
    const p: TraceParams = {
      engine: 'vtracer',
      invert: true,
      turnpolicy: 'majority',
      opticurve: false,
      exactPalette: false,
      layering: 'cutout',
      background: { rgb: [1, 2, 3] },
      alphaMode: 'mask',
      fill: '#ff00aa',
      gridScale: 3,
      optimize: true,
    };
    const r = resolveParams(p, SRC);
    expect(r.engine).toBe('vtracer');
    expect(r.invert).toBe(true);
    expect(r.turnpolicy).toBe('majority');
    expect(r.opticurve).toBe(false);
    expect(r.exactPalette).toBe(false);
    expect(r.layering).toBe('cutout');
    expect(r.background).toEqual({ rgb: [1, 2, 3] });
    expect(r.alphaMode).toBe('mask');
    expect(r.fill).toBe('#ff00aa');
    expect(r.gridScale).toBe(3);
    expect(r.optimize).toBe(true);
  });

  it('rejects unknown enum values by falling back to the default', () => {
    const r = resolveParams({ turnpolicy: 'sideways' as never, engine: 'magick' as never }, SRC);
    expect(r.turnpolicy).toBe('minority');
    expect(r.engine).toBe('potrace');
  });

  it('does not mutate the input params', () => {
    const p: TraceParams = { vtracer: { lengthThreshold: 1 }, colors: 99 };
    const copy = JSON.parse(JSON.stringify(p)) as TraceParams;
    resolveParams(p, SRC);
    expect(p).toEqual(copy);
  });
});

describe('resolveParams: bakedBackground', () => {
  it("defaults to 'auto' in every mode and passes 'keep' through", () => {
    for (const mode of ['lines', 'flat', 'pixel'] as ConcreteMode[]) expect(DEFAULTS[mode].bakedBackground).toBe('auto');
    expect(resolveParams({}, SRC).bakedBackground).toBe('auto');
    expect(resolveParams({ bakedBackground: 'keep' }, SRC).bakedBackground).toBe('keep');
    expect(resolveParams({ mode: 'pixel', bakedBackground: 'keep' }, SRC).bakedBackground).toBe('keep');
    expect(resolveParams({ bakedBackground: 'bogus' as unknown as TraceParams['bakedBackground'] }, SRC).bakedBackground).toBe('auto');
  });
});
