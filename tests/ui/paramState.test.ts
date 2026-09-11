import { describe, expect, it } from 'vitest';
import type { TraceParams } from '../../src/types';
import {
  applyTunedParams,
  describeParamChanges,
  diffParams,
  effectiveMode,
  sameTrace,
  traceParamsFor,
} from '../../src/ui/paramState';

describe('traceParamsFor', () => {
  it('sends the concrete mode and drops output-only keys without mutating', () => {
    const ui: TraceParams = Object.freeze({ mode: 'auto', colors: 16, exactPalette: false, optimize: true });
    expect(traceParamsFor(ui, 'flat')).toEqual({ mode: 'flat', colors: 16, exactPalette: false });
    expect(traceParamsFor({}, 'pixel')).toEqual({ mode: 'pixel' });
    expect(traceParamsFor({ mode: 'lines' }, 'flat')).toEqual({ mode: 'lines' });
    expect(effectiveMode({ mode: 'auto' }, 'pixel')).toBe('pixel');
  });
});

describe('diffParams', () => {
  it('treats omitted values as the mode defaults', () => {
    expect(diffParams({}, { alphamax: 1, blurK: 0.35, colors: 'auto' }, 'lines')).toEqual([]);
    expect(diffParams({}, { alphamax: 0.85 }, 'lines')).toEqual(['alphamax']);
  });

  it('compares the effective mode and its defaults', () => {
    expect(diffParams({ mode: 'auto' }, { mode: 'flat' }, 'flat')).toEqual([]);
    expect(diffParams({ mode: 'auto' }, { mode: 'lines' }, 'flat')).toEqual(['mode']);
    expect(diffParams({ mode: 'lines' }, { mode: 'pixel' }, 'flat')).toEqual(['mode', 'upscale', 'blurK']);
  });

  it('compares nested vtracer values and custom backgrounds by value', () => {
    expect(diffParams({ vtracer: { cornerThresholdDeg: 60 } }, {}, 'lines')).toEqual([]);
    expect(diffParams({ vtracer: { cornerThresholdDeg: 90 } }, {}, 'lines')).toEqual([
      'vtracer.cornerThresholdDeg',
    ]);
    expect(diffParams({ background: { rgb: [1, 2, 3] } }, { background: { rgb: [1, 2, 3] } }, 'flat')).toEqual([]);
    expect(diffParams({ background: { rgb: [1, 2, 3] } }, { background: { rgb: [1, 2, 4] } }, 'flat')).toEqual([
      'background',
    ]);
  });

  it('ignores the SVGO flag when deciding whether to re-trace', () => {
    expect(sameTrace({ optimize: true }, {}, 'lines')).toBe(true);
    expect(sameTrace({ mode: 'auto' }, { mode: 'flat' }, 'flat')).toBe(true);
    expect(sameTrace({ turdsize: 3 }, {}, 'lines')).toBe(false);
    // "Mantener el tablero" must re-trace: the setting is part of the trace, 'auto' is its default.
    expect(sameTrace({ bakedBackground: 'keep' }, {}, 'flat')).toBe(false);
    expect(sameTrace({ bakedBackground: 'auto' }, {}, 'pixel')).toBe(true);
  });
});

describe('describeParamChanges', () => {
  it('describes each edited control with Spanish formatting, in schema order', () => {
    expect(describeParamChanges({}, { blurK: 0.5, alphamax: 1.15 }, 'lines')).toEqual([
      'Suavizado: 1,00 → 1,15',
      'Desenfoque: 0,35 → 0,50',
    ]);
    expect(describeParamChanges({ engine: 'potrace' }, { engine: 'vtracer' }, 'flat')).toEqual([
      'Motor: Potrace → VTracer',
    ]);
    expect(describeParamChanges({ mode: 'auto' }, { mode: 'lines' }, 'flat')).toEqual([
      'Modo: Auto → Líneas/logo',
    ]);
  });

  it('describes a background change once', () => {
    expect(describeParamChanges({}, { background: { rgb: [0, 0, 0] } }, 'flat')).toEqual([
      'Fondo: Auto (color del borde) → Color personalizado',
    ]);
    expect(describeParamChanges({ optimize: false }, { optimize: false }, 'flat')).toEqual([]);
    expect(describeParamChanges({}, { bakedBackground: 'keep' }, 'flat')).toEqual([
      'Fondo de tablero pintado: Auto → Mantener',
    ]);
  });
});

describe('applyTunedParams', () => {
  it('keeps Auto when the tuner kept the detected mode, and UI-only keys', () => {
    const ui: TraceParams = { mode: 'auto', optimize: true, background: 'white' };
    expect(applyTunedParams(ui, { mode: 'flat', alphamax: 0.9, blurK: 0.5 }, 'flat')).toEqual({
      mode: 'auto',
      optimize: true,
      background: 'white',
      alphamax: 0.9,
      blurK: 0.5,
    });
  });

  it('switches to the tuned mode when it differs from the detected one', () => {
    expect(applyTunedParams({ mode: 'auto' }, { mode: 'lines' }, 'flat').mode).toBe('lines');
    expect(applyTunedParams({ mode: 'pixel' }, {}, 'flat').mode).toBe('pixel');
  });

  it('merges vtracer settings and never takes optimize from the tuner', () => {
    const next = applyTunedParams(
      { vtracer: { maxIterations: 12 } },
      { vtracer: { cornerThresholdDeg: 90 }, optimize: true },
      'lines',
    );
    expect(next.vtracer).toEqual({ maxIterations: 12, cornerThresholdDeg: 90 });
    expect('optimize' in next).toBe(false);
  });
});

describe('gradient mode parameters', () => {
  it('are part of the compared state; gradient defaults to cutout layers', () => {
    expect(diffParams({ mode: 'flat' }, { mode: 'gradient' }, 'flat')).toEqual(['mode', 'layering']);
    expect(diffParams({}, { maxStops: 4, regionDetail: 1.5, radialGradients: false }, 'gradient')).toEqual([
      'regionDetail',
      'maxStops',
      'radialGradients',
    ]);
    expect(diffParams({ maxStops: 8, regionDetail: 1 }, {}, 'gradient')).toEqual([]);
    expect(sameTrace({ mode: 'auto' }, { mode: 'gradient' }, 'gradient')).toBe(true);
  });

  it('describes the gradient controls with Spanish formatting, in schema order', () => {
    expect(describeParamChanges({}, { regionDetail: 1.5 }, 'gradient')).toEqual(['Detalle de regiones: 1,0 → 1,5']);
    expect(describeParamChanges({}, { maxStops: 4 }, 'gradient')).toEqual(['Paradas máximas: 8 → 4']);
    expect(describeParamChanges({}, { radialGradients: false }, 'gradient')).toEqual(['Degradados radiales: sí → no']);
    expect(
      describeParamChanges({ mode: 'auto' }, { mode: 'auto', radialGradients: false, maxStops: 4, regionDetail: 1.5 }, 'gradient'),
    ).toEqual(['Detalle de regiones: 1,0 → 1,5', 'Paradas máximas: 8 → 4', 'Degradados radiales: sí → no']);
    // Switching to Degradados also brings its cutout default, and says so.
    expect(describeParamChanges({ mode: 'flat' }, { mode: 'gradient' }, 'flat')).toEqual([
      'Modo: Color plano → Degradados',
      'Capas: Apiladas → Recortadas',
    ]);
  });
});
