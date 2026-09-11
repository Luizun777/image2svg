import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../src/core/params';
import type { BakedCheckerboard, ConcreteMode, TraceParams } from '../../src/types';
import type {
  ControlContext,
  SegmentedControl,
  SelectControl,
  SliderControl,
} from '../../src/ui/controlSchema';
import {
  CONTROLS,
  controlById,
  formatControlValue,
  formatSliderValue,
  hexToRgb,
  sliderFillPercent,
  sliderPosition,
  visibleControls,
} from '../../src/ui/controlSchema';
import { NBSP } from '../../src/ui/format';

function ctx(over: Partial<ControlContext> = {}): ControlContext {
  return {
    params: {},
    mode: 'lines',
    engines: { potrace: true, vtracer: true },
    paletteColors: null,
    grid: 1,
    resolvedUpscale: null,
    bakedBackground: null,
    ...over,
  };
}

/** As detected on clip_art: a 20 px board, levels 238 / 254. */
const BOARD: BakedCheckerboard = {
  cell: 20.007,
  offsetX: 0,
  offsetY: 0,
  levels: [
    [238, 238, 238],
    [254, 254, 254],
  ],
  borderMatchRatio: 1,
};

const ids = (c: ControlContext, section?: 'main' | 'advanced'): string[] =>
  visibleControls(c, section).map((x) => x.id);

function slider(id: string): SliderControl {
  const c = controlById(id);
  if (c?.kind !== 'slider') throw new Error(`${id} is not a slider`);
  return c;
}

/** A context in which the given control is visible. */
function contextShowing(id: string): ControlContext {
  const candidates: ControlContext[] = [
    ctx({ mode: 'lines' }),
    ctx({ mode: 'flat' }),
    ctx({ mode: 'pixel' }),
    ctx({ mode: 'gradient' }),
    ctx({ mode: 'flat', params: { engine: 'vtracer' } }),
    ctx({ mode: 'flat', bakedBackground: BOARD }),
  ];
  const found = candidates.find((c) => controlById(id)?.visible(c));
  if (found === undefined) throw new Error(`${id} is never visible`);
  return found;
}

describe('schema integrity', () => {
  it('has unique ids and sane slider ranges', () => {
    const all = CONTROLS.map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
    for (const c of CONTROLS) {
      if (c.kind !== 'slider') continue;
      expect(c.max, c.id).toBeGreaterThan(c.min);
      expect(c.step, c.id).toBeGreaterThan(0);
    }
  });

  it('keeps every mode default inside the slider range', () => {
    const modes: ConcreteMode[] = ['lines', 'flat', 'gradient', 'pixel'];
    for (const mode of modes) {
      for (const c of CONTROLS) {
        if (c.kind !== 'slider') continue;
        const v = c.get(ctx({ mode }));
        if (v === 'auto') {
          expect(c.auto, `${c.id} returns auto without an auto position`).toBeDefined();
          continue;
        }
        expect(v, `${mode}/${c.id}`).toBeGreaterThanOrEqual(c.min);
        expect(v, `${mode}/${c.id}`).toBeLessThanOrEqual(c.max);
      }
    }
  });

  it('matches the requested ranges', () => {
    expect([slider('alphamax').min, slider('alphamax').max, slider('alphamax').step]).toEqual([0, 1.334, 0.05]);
    expect([slider('thresholdOffset').min, slider('thresholdOffset').max]).toEqual([-0.25, 0.25]);
    expect([slider('colors').min, slider('colors').max]).toEqual([2, 32]);
    expect([slider('blurK').min, slider('blurK').max]).toEqual([0, 1]);
    expect([slider('opttolerance').min, slider('opttolerance').max]).toEqual([0.05, 1]);
    expect([slider('turdsize').min, slider('turdsize').max]).toEqual([0, 20]);
    expect(slider('alphamax').minLabel).toBe('Afilado');
    expect(slider('alphamax').maxLabel).toBe('Suave');
  });
});

describe('visibility rules', () => {
  it('lines + Potrace', () => {
    expect(ids(ctx({ mode: 'lines' }))).toEqual([
      'mode',
      'engine',
      'alphamax',
      'thresholdOffset',
      'upscale',
      'blurK',
      'opttolerance',
      'turdsize',
      'invert',
      'background',
      'alphaMode',
      'optimize',
    ]);
  });

  it('flat + VTracer hides the Potrace-only knobs and shows the VTracer group', () => {
    expect(ids(ctx({ mode: 'flat', params: { engine: 'vtracer' } }))).toEqual([
      'mode',
      'engine',
      'colors',
      'exactPalette',
      'upscale',
      'blurK',
      'background',
      'layering',
      'vtCornerThreshold',
      'vtLengthThreshold',
      'vtMaxIterations',
      'vtSpliceThreshold',
      'vtFilterSpeckle',
      'vtPathPrecision',
      'optimize',
    ]);
  });

  it('pixel shows only mode, grid and output', () => {
    expect(ids(ctx({ mode: 'pixel' }))).toEqual(['mode', 'gridScale', 'optimize']);
  });

  it('gradient: no palette or line controls; layering shown as in flat, cutout by default', () => {
    const shown = ids(ctx({ mode: 'gradient' }));
    for (const id of ['mode', 'engine', 'upscale', 'blurK', 'background', 'layering', 'optimize']) expect(shown).toContain(id);
    for (const id of ['colors', 'exactPalette', 'thresholdOffset', 'invert', 'alphaMode', 'gridScale']) {
      expect(shown).not.toContain(id);
    }
    expect(ids(ctx({ mode: 'lines' }))).not.toContain('layering');
    const layering = controlById('layering') as SegmentedControl;
    expect(layering.get(ctx({ mode: 'gradient' }))).toBe('cutout');
    expect(layering.get(ctx({ mode: 'flat' }))).toBe('stacked');
  });

  it('gradient + Potrace: exact controls in main and advanced', () => {
    const g = ctx({ mode: 'gradient' });
    expect(ids(g, 'main')).toEqual(['mode', 'engine', 'alphamax', 'regionDetail', 'maxStops', 'radialGradients']);
    expect(ids(g, 'advanced')).toEqual(['upscale', 'blurK', 'opttolerance', 'turdsize', 'background', 'layering', 'optimize']);
  });

  it('gradient + VTracer: exact controls in main and advanced', () => {
    const g = ctx({ mode: 'gradient', params: { engine: 'vtracer' } });
    expect(ids(g, 'main')).toEqual(['mode', 'engine', 'regionDetail', 'maxStops', 'radialGradients']);
    expect(ids(g, 'advanced')).toEqual([
      'upscale',
      'blurK',
      'background',
      'layering',
      'vtCornerThreshold',
      'vtLengthThreshold',
      'vtMaxIterations',
      'vtSpliceThreshold',
      'vtFilterSpeckle',
      'vtPathPrecision',
      'optimize',
    ]);
  });

  it('shows the gradient controls only in gradient mode', () => {
    for (const mode of ['lines', 'flat', 'pixel'] as const) {
      for (const id of ['regionDetail', 'maxStops', 'radialGradients']) {
        expect(ids(ctx({ mode })), `${mode}/${id}`).not.toContain(id);
        expect(ids(ctx({ mode, params: { engine: 'vtracer' } })), `${mode}/${id}`).not.toContain(id);
      }
    }
  });

  it('notes the cutout default of Capas in gradient mode only', () => {
    const layering = controlById('layering') as SegmentedControl;
    const note = 'Recortadas por defecto: cada forma con su propio degradado, editable.';
    expect(layering.note?.(ctx({ mode: 'gradient' }))).toBe(note);
    expect(layering.note?.(ctx({ mode: 'gradient', params: { layering: 'stacked' } }))).toBe(note);
    expect(layering.note?.(ctx({ mode: 'flat' }))).toBeNull();
    expect(note).not.toMatch(/[\n–—]/);
  });

  it('main section of flat + Potrace', () => {
    expect(ids(ctx({ mode: 'flat' }), 'main')).toEqual(['mode', 'engine', 'alphamax', 'colors', 'exactPalette']);
  });

  it('shows the colour picker only for a custom background', () => {
    expect(ids(ctx({ mode: 'flat' }))).not.toContain('backgroundColor');
    const c = ctx({ mode: 'flat', params: { background: { rgb: [1, 2, 3] } } });
    expect(ids(c)).toContain('backgroundColor');
    const picker = controlById('backgroundColor');
    expect(picker?.kind === 'color' && picker.get(c)).toBe('#010203');
  });

  it('shows the painted checkerboard setting only when one was detected, in every mode', () => {
    for (const mode of ['lines', 'flat', 'gradient', 'pixel'] as const) {
      expect(ids(ctx({ mode })), mode).not.toContain('bakedBackground');
      expect(ids(ctx({ mode, bakedBackground: BOARD }), 'advanced'), mode).toContain('bakedBackground');
    }
    expect(ids(ctx({ mode: 'pixel', bakedBackground: BOARD }))).toEqual(['mode', 'bakedBackground', 'gridScale', 'optimize']);
    const c = controlById('bakedBackground') as SegmentedControl;
    expect([c.label, c.section, c.group, c.kind]).toEqual(['Fondo de tablero pintado', 'advanced', 'trace', 'segmented']);
    expect(c.options.map((o) => o.label)).toEqual(['Auto', 'Mantener']);
    const shown = ctx({ mode: 'flat', bakedBackground: BOARD });
    expect(c.get(shown)).toBe('auto');
    expect(c.note?.(shown)).toBe(`Detectado: cuadros de 20${NBSP}px.`);
    const kept = c.set(Object.freeze({ colors: 8 }), 'keep');
    expect(kept).toEqual({ colors: 8, bakedBackground: 'keep' });
    expect(c.get({ ...shown, params: kept })).toBe('keep');
    expect(c.set(kept, 'auto')).toEqual({ colors: 8, bakedBackground: 'auto' });
    // Líneas/logo traces one fill: keeping a two-tone board there is disabled, with the reason.
    const reason = 'Líneas/logo traza un solo color: para conservar el tablero cambia a Color plano.';
    expect(c.disabledReason?.('keep', ctx({ mode: 'lines', bakedBackground: BOARD }))).toBe(reason);
    expect(c.disabledReason?.('auto', ctx({ mode: 'lines', bakedBackground: BOARD }))).toBeNull();
    expect(c.disabledReason?.('keep', shown)).toBeNull();
    expect(c.disabledReason?.('keep', ctx({ mode: 'pixel', bakedBackground: BOARD }))).toBeNull();
  });

  it('explains why an engine cannot be chosen', () => {
    const engine = controlById('engine') as SegmentedControl;
    const noVt = ctx({ engines: { potrace: true, vtracer: false } });
    expect(engine.disabledReason?.('vtracer', noVt)).toBe('VTracer no está disponible en este navegador.');
    expect(engine.disabledReason?.('potrace', noVt)).toBeNull();
    expect(engine.disabledReason?.('vtracer', ctx({ engines: null }))).toBeNull();
  });
});

describe('value mapping', () => {
  it('sets values immutably and reads them back for every slider', () => {
    for (const c of CONTROLS) {
      if (c.kind !== 'slider') continue;
      const base = contextShowing(c.id);
      const frozen: TraceParams = Object.freeze({ ...base.params, vtracer: Object.freeze({ maxIterations: 12 }) });
      const mid = c.min + c.step * Math.floor((c.max - c.min) / c.step / 2);
      const next = c.set(frozen, mid); // throws on mutation of the frozen input
      expect(c.get({ ...base, params: next }), c.id).toBeCloseTo(mid, 9);
      if (c.group === 'vtracer' && c.id !== 'vtMaxIterations') {
        expect(next.vtracer?.maxIterations, c.id).toBe(12);
      }
    }
  });

  it('handles auto sliders', () => {
    const colors = slider('colors');
    const flat = ctx({ mode: 'flat' });
    expect(colors.get(flat)).toBe('auto');
    expect(sliderPosition(colors, { ...flat, paletteColors: 6 })).toBe(6);
    expect(sliderPosition(colors, flat)).toBe(8);
    expect(colors.set({}, 12)).toEqual({ colors: 12 });
    expect(colors.set({ colors: 12 }, 'auto')).toEqual({ colors: 'auto' });
    const grid = slider('gridScale');
    expect(sliderPosition(grid, ctx({ mode: 'pixel', grid: 4 }))).toBe(4);
    expect(grid.note?.(ctx({ mode: 'pixel', grid: 4 }))).toBe(`Detectada: 4${NBSP}px`);
  });

  it('maps segmented and select values', () => {
    const upscale = controlById('upscale') as SegmentedControl;
    expect(upscale.get(ctx())).toBe('auto');
    expect(upscale.set({}, '3')).toEqual({ upscale: 3 });
    expect(upscale.set({}, 'x')).toEqual({ upscale: 'auto' });
    expect(upscale.note?.(ctx({ resolvedUpscale: 4 }))).toBe('En uso: 4×');

    const mode = controlById('mode') as SegmentedControl;
    expect(mode.set({}, 'pixel')).toEqual({ mode: 'pixel' });
    expect(mode.set({}, 'nope')).toEqual({ mode: 'auto' });
    expect(mode.note?.(ctx({ mode: 'flat' }))).toBe('Detectado: Color plano');
    expect(mode.note?.(ctx({ mode: 'flat', params: { mode: 'flat' } }))).toBeNull();
    expect(mode.options.map((o) => o.value)).toEqual(['auto', 'lines', 'flat', 'gradient', 'pixel']);
    expect(mode.options.find((o) => o.value === 'gradient')?.label).toBe('Degradados');
    expect(mode.set({}, 'gradient')).toEqual({ mode: 'gradient' });
    expect(mode.note?.(ctx({ mode: 'gradient' }))).toBe('Detectado: Degradados');

    const bg = controlById('background') as SelectControl;
    expect(bg.set({ background: 'auto' }, 'custom')).toEqual({ background: { rgb: [255, 255, 255] } });
    expect(bg.set({ background: { rgb: [1, 2, 3] } }, 'custom')).toEqual({ background: { rgb: [1, 2, 3] } });
    expect(bg.set({}, 'transparent')).toEqual({ background: 'transparent' });
    expect(bg.get(ctx({ params: { background: { rgb: [0, 0, 0] } } }))).toBe('custom');
  });

  it('formats values for display', () => {
    expect(formatSliderValue(slider('alphamax'), 1)).toBe('1,00');
    expect(formatSliderValue(slider('thresholdOffset'), 0.05)).toBe('+0,05');
    expect(formatSliderValue(slider('turdsize'), 2)).toBe(`2${NBSP}px²`);
    expect(formatSliderValue(slider('vtCornerThreshold'), 60)).toBe('60°');
    expect(formatSliderValue(slider('colors'), 'auto')).toBe('Auto');
    expect(formatControlValue(controlById('engine')!, ctx())).toBe('Potrace');
    expect(formatControlValue(controlById('optimize')!, ctx({ params: { optimize: true } }))).toBe('sí');
    expect(DEFAULTS.lines.alphamax).toBe(1);
  });

  it('defines the gradient controls: ranges, labels, hints, defaults and value mapping', () => {
    const detail = slider('regionDetail');
    expect([detail.label, detail.section, detail.group, detail.param]).toEqual(['Detalle de regiones', 'main', 'trace', 'regionDetail']);
    expect([detail.min, detail.max, detail.step, detail.decimals]).toEqual([0.5, 2, 0.1, 1]);
    expect([detail.minLabel, detail.maxLabel, detail.auto]).toEqual(['Menos regiones', 'Más regiones', undefined]);
    expect(detail.hint).toBe('Cuánto separa dos zonas de color parecido: más alto encuentra más formas.');

    const stops = slider('maxStops');
    expect([stops.label, stops.section, stops.group, stops.param]).toEqual(['Paradas máximas', 'main', 'trace', 'maxStops']);
    expect([stops.min, stops.max, stops.step, stops.decimals]).toEqual([2, 8, 1, 0]);
    expect(stops.hint).toBe('Número máximo de colores en cada degradado.');

    const radial = controlById('radialGradients');
    if (radial?.kind !== 'toggle') throw new Error('radialGradients is not a toggle');
    expect([radial.label, radial.section, radial.group, radial.param]).toEqual(['Degradados radiales', 'main', 'trace', 'radialGradients']);
    expect(radial.hint).toBe('Permite degradados circulares además de los lineales.');

    const g = ctx({ mode: 'gradient' });
    expect([detail.get(g), stops.get(g), radial.get(g)]).toEqual([
      DEFAULTS.gradient.regionDetail,
      DEFAULTS.gradient.maxStops,
      DEFAULTS.gradient.radialGradients,
    ]);
    expect([detail.get(g), stops.get(g), radial.get(g)]).toEqual([1, 8, true]);
    const frozen: TraceParams = Object.freeze({ mode: 'gradient' });
    expect(detail.set(frozen, 1.5)).toEqual({ mode: 'gradient', regionDetail: 1.5 });
    expect(stops.set(frozen, 4)).toEqual({ mode: 'gradient', maxStops: 4 });
    expect(radial.set(frozen, false)).toEqual({ mode: 'gradient', radialGradients: false });
    expect(radial.get({ ...g, params: { radialGradients: false } })).toBe(false);
    expect(formatSliderValue(detail, 1.5)).toBe('1,5');
    expect(formatSliderValue(stops, 4)).toBe('4');
    expect(formatControlValue(radial, g)).toBe('sí');
    for (const c of [detail, stops, radial]) expect(`${c.label} ${c.hint} ${detail.minLabel} ${detail.maxLabel}`).not.toMatch(/[\n–—]/);
  });

  it('computes the filled share of the track', () => {
    const a = slider('alphamax');
    expect(sliderFillPercent(a, 0.667)).toBeCloseTo(50, 9);
    expect(sliderFillPercent(a, -1)).toBe(0);
    expect(sliderFillPercent(a, 9)).toBe(100);
  });

  it('parses hex colours', () => {
    expect(hexToRgb('#1d3557')).toEqual([29, 53, 87]);
    expect(hexToRgb('FFFFFF')).toEqual([255, 255, 255]);
    expect(hexToRgb('nope')).toEqual([255, 255, 255]);
  });
});
