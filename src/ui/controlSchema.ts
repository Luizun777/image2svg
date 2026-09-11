/**
 * Declarative schema of the trace controls. Pure and DOM-free: `controlsView.ts` renders it and
 * the tests pin its visibility rules and value mapping.
 *
 * Every control reads from a ControlContext (UI params + detected mode + source facts) and writes
 * by returning NEW params (never mutating). Only controls relevant to the mode the trace runs in
 * (and to the selected engine) are visible.
 */
import type {
  BackgroundSetting,
  BakedCheckerboard,
  ConcreteMode,
  Engine,
  Layering,
  Mode,
  RGB,
  TraceParams,
  UpscaleSetting,
  VtracerParams,
} from '../types';
import { DEFAULTS, VTRACER_DEFAULTS } from '../core/params';
import { rgbToHex } from '../svg/assemble';
import { ENGINE_LABEL, MODE_LABEL, NBSP, formatDecimal, formatSigned } from './format';

export interface ControlContext {
  /** UI parameters; `mode` may be 'auto'. */
  params: TraceParams;
  /** Mode the trace runs in: the detected one while the user keeps Auto. */
  mode: ConcreteMode;
  /** Engine availability reported by the worker; null while unknown. */
  engines: Record<Engine, boolean> | null;
  /** SourceInfo.paletteColors (null when the image has more than 32 real colours). */
  paletteColors: number | null;
  /** SourceInfo.grid (1 when no pixel grid was detected). */
  grid: number;
  /** Upscale factor used by the last trace; null before the first one. */
  resolvedUpscale: number | null;
  /** SourceInfo.bakedBackground: the fake-transparency checkerboard painted into the pixels, or null. */
  bakedBackground: BakedCheckerboard | null;
}

export type ControlSection = 'main' | 'advanced';
export type ControlGroup = 'trace' | 'vtracer' | 'output';

export const GROUP_LABEL: Record<ControlGroup, string> = {
  trace: 'Trazado',
  vtracer: 'Parámetros de VTracer',
  output: 'Salida',
};

interface ControlBase {
  readonly id: string;
  readonly label: string;
  readonly section: ControlSection;
  readonly group: ControlGroup;
  /** Parameter path this control edits ('alphamax', 'vtracer.cornerThresholdDeg', …). */
  readonly param: string;
  /** Static one-line help. */
  readonly hint?: string;
  visible(ctx: ControlContext): boolean;
  /** Dynamic note shown under the control (value in use, detected value…), or null. */
  note?(ctx: ControlContext): string | null;
}

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
}

export interface SegmentedControl extends ControlBase {
  readonly kind: 'segmented';
  readonly options: readonly ChoiceOption[];
  get(ctx: ControlContext): string;
  set(params: TraceParams, value: string): TraceParams;
  /** Spanish reason why `value` cannot be chosen now, or null when it can. */
  disabledReason?(value: string, ctx: ControlContext): string | null;
}

export interface SelectControl extends ControlBase {
  readonly kind: 'select';
  readonly options: readonly ChoiceOption[];
  get(ctx: ControlContext): string;
  set(params: TraceParams, value: string): TraceParams;
}

export interface SliderAuto {
  readonly label: string;
  /** Where the thumb rests while the value is 'auto'. */
  position(ctx: ControlContext): number;
}

export interface SliderControl extends ControlBase {
  readonly kind: 'slider';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly decimals: number;
  readonly unit?: string;
  readonly signed?: boolean;
  readonly minLabel?: string;
  readonly maxLabel?: string;
  /** Present when the parameter also accepts 'auto'. */
  readonly auto?: SliderAuto;
  get(ctx: ControlContext): number | 'auto';
  set(params: TraceParams, value: number | 'auto'): TraceParams;
}

export interface ToggleControl extends ControlBase {
  readonly kind: 'toggle';
  get(ctx: ControlContext): boolean;
  set(params: TraceParams, value: boolean): TraceParams;
}

export interface ColorControl extends ControlBase {
  readonly kind: 'color';
  /** '#rrggbb'. */
  get(ctx: ControlContext): string;
  set(params: TraceParams, hex: string): TraceParams;
}

export type ControlDef =
  | SegmentedControl
  | SelectControl
  | SliderControl
  | ToggleControl
  | ColorControl;

// ---------------------------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------------------------

export function engineOf(ctx: Pick<ControlContext, 'params' | 'mode'>): Engine {
  return ctx.params.engine ?? DEFAULTS[ctx.mode].engine;
}

const always = (): boolean => true;
const notPixel = (ctx: ControlContext): boolean => ctx.mode !== 'pixel';
const isLines = (ctx: ControlContext): boolean => ctx.mode === 'lines';
const isFlat = (ctx: ControlContext): boolean => ctx.mode === 'flat';
const isPixel = (ctx: ControlContext): boolean => ctx.mode === 'pixel';
const potraceTrace = (ctx: ControlContext): boolean => notPixel(ctx) && engineOf(ctx) === 'potrace';
const vtracerTrace = (ctx: ControlContext): boolean => notPixel(ctx) && engineOf(ctx) === 'vtracer';

type NumberKey = 'alphamax' | 'thresholdOffset' | 'blurK' | 'opttolerance' | 'turdsize';

function numberParam(key: NumberKey): Pick<SliderControl, 'get' | 'set' | 'param'> {
  return {
    param: key,
    get: (ctx) => ctx.params[key] ?? DEFAULTS[ctx.mode][key],
    set: (params, value) => {
      const next: TraceParams = { ...params };
      if (value === 'auto') delete next[key];
      else next[key] = value;
      return next;
    },
  };
}

function vtracerParam(key: keyof VtracerParams): Pick<SliderControl, 'get' | 'set' | 'param'> {
  return {
    param: `vtracer.${key}`,
    get: (ctx) => ctx.params.vtracer?.[key] ?? VTRACER_DEFAULTS[key],
    set: (params, value) => {
      const vt: Partial<VtracerParams> = { ...params.vtracer };
      vt[key] = value === 'auto' ? VTRACER_DEFAULTS[key] : value;
      return { ...params, vtracer: vt };
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const MODES: readonly Mode[] = ['auto', 'lines', 'flat', 'pixel'];

function toMode(value: string): Mode {
  return (MODES as readonly string[]).includes(value) ? (value as Mode) : 'auto';
}

function toUpscale(value: string): UpscaleSetting {
  const n = Number(value);
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : 'auto';
}

const DEFAULT_CUSTOM_BACKGROUND: RGB = [255, 255, 255];

/** '#rrggbb' → RGB; anything else → white. */
export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return [...DEFAULT_CUSTOM_BACKGROUND];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toBackground(value: string, previous: BackgroundSetting | undefined): BackgroundSetting {
  if (value === 'white' || value === 'transparent' || value === 'auto') return value;
  if (value === 'custom') {
    return typeof previous === 'object' ? previous : { rgb: [...DEFAULT_CUSTOM_BACKGROUND] };
  }
  return 'auto';
}

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

export const CONTROLS: readonly ControlDef[] = [
  {
    id: 'mode',
    kind: 'segmented',
    label: 'Modo',
    section: 'main',
    group: 'trace',
    param: 'mode',
    options: MODES.map((m) => ({ value: m, label: MODE_LABEL[m] })),
    visible: always,
    get: (ctx) => ctx.params.mode ?? 'auto',
    set: (params, value) => ({ ...params, mode: toMode(value) }),
    note: (ctx) =>
      (ctx.params.mode ?? 'auto') === 'auto' ? `Detectado: ${MODE_LABEL[ctx.mode]}` : null,
  },
  {
    id: 'engine',
    kind: 'segmented',
    label: 'Motor',
    section: 'main',
    group: 'trace',
    param: 'engine',
    options: [
      { value: 'potrace', label: ENGINE_LABEL.potrace },
      { value: 'vtracer', label: ENGINE_LABEL.vtracer },
    ],
    visible: notPixel,
    get: (ctx) => engineOf(ctx),
    set: (params, value) => ({ ...params, engine: value === 'vtracer' ? 'vtracer' : 'potrace' }),
    disabledReason: (value, ctx) => {
      if (ctx.engines === null || (value !== 'potrace' && value !== 'vtracer')) return null;
      return ctx.engines[value] ? null : `${ENGINE_LABEL[value]} no está disponible en este navegador.`;
    },
  },
  {
    id: 'alphamax',
    kind: 'slider',
    label: 'Suavizado',
    section: 'main',
    group: 'trace',
    min: 0,
    max: 1.334,
    step: 0.05,
    decimals: 2,
    minLabel: 'Afilado',
    maxLabel: 'Suave',
    hint: 'Hacia Afilado conserva esquinas; hacia Suave las convierte en curvas.',
    visible: potraceTrace,
    ...numberParam('alphamax'),
  },
  {
    id: 'thresholdOffset',
    kind: 'slider',
    label: 'Umbral',
    section: 'main',
    group: 'trace',
    min: -0.25,
    max: 0.25,
    step: 0.01,
    decimals: 2,
    signed: true,
    minLabel: 'Menos tinta',
    maxLabel: 'Más tinta',
    hint: 'Desplaza el corte entre tinta y fondo: engorda o adelgaza los trazos.',
    visible: isLines,
    ...numberParam('thresholdOffset'),
  },
  {
    id: 'colors',
    kind: 'slider',
    label: 'Colores',
    section: 'main',
    group: 'trace',
    param: 'colors',
    min: 2,
    max: 32,
    step: 1,
    decimals: 0,
    auto: { label: 'Auto', position: (ctx) => clamp(ctx.paletteColors ?? 8, 2, 32) },
    visible: isFlat,
    get: (ctx) => ctx.params.colors ?? DEFAULTS[ctx.mode].colors,
    set: (params, value) => ({ ...params, colors: value }),
    note: (ctx) => {
      const auto = (ctx.params.colors ?? DEFAULTS[ctx.mode].colors) === 'auto';
      if (!auto) return null;
      return ctx.paletteColors !== null
        ? `Paleta exacta detectada: ${ctx.paletteColors} colores.`
        : 'Sin paleta exacta: se usan 8 colores.';
    },
  },
  {
    id: 'exactPalette',
    kind: 'toggle',
    label: 'Detectar paleta exacta',
    section: 'main',
    group: 'trace',
    param: 'exactPalette',
    hint: 'Usa los colores reales de la imagen cuando caben en el número elegido.',
    visible: isFlat,
    get: (ctx) => ctx.params.exactPalette ?? DEFAULTS[ctx.mode].exactPalette,
    set: (params, value) => ({ ...params, exactPalette: value }),
  },
  // ---- Avanzado · Trazado -------------------------------------------------------------------
  {
    id: 'upscale',
    kind: 'segmented',
    label: 'Reescalado',
    section: 'advanced',
    group: 'trace',
    param: 'upscale',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: '1', label: '1×' },
      { value: '2', label: '2×' },
      { value: '3', label: '3×' },
      { value: '4', label: '4×' },
    ],
    hint: 'Traza a mayor resolución para que los escalones de píxel no acaben en picos.',
    visible: notPixel,
    get: (ctx) => String(ctx.params.upscale ?? DEFAULTS[ctx.mode].upscale),
    set: (params, value) => ({ ...params, upscale: toUpscale(value) }),
    note: (ctx) => (ctx.resolvedUpscale !== null ? `En uso: ${ctx.resolvedUpscale}×` : null),
  },
  {
    id: 'blurK',
    kind: 'slider',
    label: 'Desenfoque',
    section: 'advanced',
    group: 'trace',
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    hint: 'Suaviza los escalones antes de trazar; en exceso redondea los detalles finos.',
    visible: notPixel,
    ...numberParam('blurK'),
  },
  {
    id: 'opttolerance',
    kind: 'slider',
    label: 'Tolerancia de curva',
    section: 'advanced',
    group: 'trace',
    min: 0.05,
    max: 1,
    step: 0.05,
    decimals: 2,
    hint: 'Cuánto puede desviarse una curva al unir tramos: más alto, menos nodos.',
    visible: potraceTrace,
    ...numberParam('opttolerance'),
  },
  {
    id: 'turdsize',
    kind: 'slider',
    label: 'Manchas mínimas',
    section: 'advanced',
    group: 'trace',
    min: 0,
    max: 20,
    step: 1,
    decimals: 0,
    unit: 'px²',
    hint: 'Descarta manchas con un área menor que esta.',
    visible: potraceTrace,
    ...numberParam('turdsize'),
  },
  {
    id: 'invert',
    kind: 'toggle',
    label: 'Invertir tinta y fondo',
    section: 'advanced',
    group: 'trace',
    param: 'invert',
    visible: isLines,
    get: (ctx) => ctx.params.invert ?? DEFAULTS[ctx.mode].invert,
    set: (params, value) => ({ ...params, invert: value }),
  },
  {
    id: 'background',
    kind: 'select',
    label: 'Fondo',
    section: 'advanced',
    group: 'trace',
    param: 'background',
    options: [
      { value: 'auto', label: 'Auto (color del borde)' },
      { value: 'white', label: 'Blanco' },
      { value: 'transparent', label: 'Transparente' },
      { value: 'custom', label: 'Color personalizado' },
    ],
    visible: notPixel,
    get: (ctx) => {
      const bg = ctx.params.background ?? DEFAULTS[ctx.mode].background;
      return typeof bg === 'object' ? 'custom' : bg;
    },
    set: (params, value) => ({ ...params, background: toBackground(value, params.background) }),
  },
  {
    id: 'backgroundColor',
    kind: 'color',
    label: 'Color de fondo',
    section: 'advanced',
    group: 'trace',
    param: 'background',
    visible: (ctx) => notPixel(ctx) && typeof ctx.params.background === 'object',
    get: (ctx) => {
      const bg = ctx.params.background;
      return rgbToHex(typeof bg === 'object' ? bg.rgb : DEFAULT_CUSTOM_BACKGROUND);
    },
    set: (params, hex) => ({ ...params, background: { rgb: hexToRgb(hex) } }),
  },
  {
    id: 'bakedBackground',
    kind: 'segmented',
    label: 'Fondo de tablero pintado',
    section: 'advanced',
    group: 'trace',
    param: 'bakedBackground',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'keep', label: 'Mantener' },
    ],
    hint: 'Auto trata como transparente el tablero de ajedrez pintado que imita la transparencia; Mantener lo traza como parte de la imagen.',
    // Every mode honours it (pixel mode too), but only a source where one was detected needs it.
    visible: (ctx) => ctx.bakedBackground !== null,
    get: (ctx) => ctx.params.bakedBackground ?? DEFAULTS[ctx.mode].bakedBackground,
    set: (params, value) => ({ ...params, bakedBackground: value === 'keep' ? 'keep' : 'auto' }),
    // Líneas/logo emits one fill: a kept two-tone board cannot appear (see warnings.ts).
    disabledReason: (value, ctx) =>
      value === 'keep' && ctx.mode === 'lines'
        ? 'Líneas/logo traza un solo color: para conservar el tablero cambia a Color plano.'
        : null,
    note: (ctx) =>
      ctx.bakedBackground !== null ? `Detectado: cuadros de ${Math.round(ctx.bakedBackground.cell)}${NBSP}px.` : null,
  },
  {
    id: 'alphaMode',
    kind: 'select',
    label: 'Transparencia',
    section: 'advanced',
    group: 'trace',
    param: 'alphaMode',
    options: [
      { value: 'auto', label: 'Auto' },
      // "Máscara" first: the empty-trace warning tells the user to pick "Transparencia: Máscara".
      { value: 'mask', label: 'Máscara (el canal alfa es la tinta)' },
      { value: 'composite', label: 'Componer sobre el fondo' },
    ],
    hint: 'Cómo se decide qué es tinta en una imagen con transparencia.',
    visible: isLines,
    get: (ctx) => ctx.params.alphaMode ?? DEFAULTS[ctx.mode].alphaMode,
    set: (params, value) => ({
      ...params,
      alphaMode: value === 'mask' || value === 'composite' ? value : 'auto',
    }),
  },
  {
    id: 'layering',
    kind: 'segmented',
    label: 'Capas',
    section: 'advanced',
    group: 'trace',
    param: 'layering',
    options: [
      { value: 'stacked', label: 'Apiladas' },
      { value: 'cutout', label: 'Recortadas' },
    ],
    hint: 'Apiladas: sin costuras entre colores. Recortadas: formas sin solaparse.',
    visible: isFlat,
    get: (ctx) => ctx.params.layering ?? DEFAULTS[ctx.mode].layering,
    set: (params, value) => ({
      ...params,
      layering: (value === 'cutout' ? 'cutout' : 'stacked') satisfies Layering,
    }),
  },
  {
    id: 'gridScale',
    kind: 'slider',
    label: 'Rejilla de píxel',
    section: 'advanced',
    group: 'trace',
    param: 'gridScale',
    min: 1,
    max: 16,
    step: 1,
    decimals: 0,
    unit: 'px',
    auto: { label: 'Auto', position: (ctx) => clamp(ctx.grid, 1, 16) },
    hint: 'Lado del bloque que forma cada píxel lógico.',
    visible: isPixel,
    get: (ctx) => ctx.params.gridScale ?? DEFAULTS[ctx.mode].gridScale,
    set: (params, value) => ({ ...params, gridScale: value }),
    note: (ctx) => {
      const auto = (ctx.params.gridScale ?? DEFAULTS[ctx.mode].gridScale) === 'auto';
      return auto ? `Detectada: ${ctx.grid}${NBSP}px` : null;
    },
  },
  // ---- Avanzado · VTracer -------------------------------------------------------------------
  {
    id: 'vtCornerThreshold',
    kind: 'slider',
    label: 'Umbral de esquina',
    section: 'advanced',
    group: 'vtracer',
    min: 0,
    max: 180,
    step: 1,
    decimals: 0,
    unit: '°',
    hint: 'Giros más cerrados que este ángulo se mantienen como esquinas.',
    visible: vtracerTrace,
    ...vtracerParam('cornerThresholdDeg'),
  },
  {
    id: 'vtLengthThreshold',
    kind: 'slider',
    label: 'Longitud mínima',
    section: 'advanced',
    group: 'vtracer',
    min: 3.5,
    max: 10,
    step: 0.5,
    decimals: 1,
    unit: 'px',
    visible: vtracerTrace,
    ...vtracerParam('lengthThreshold'),
  },
  {
    id: 'vtMaxIterations',
    kind: 'slider',
    label: 'Iteraciones',
    section: 'advanced',
    group: 'vtracer',
    min: 1,
    max: 50,
    step: 1,
    decimals: 0,
    visible: vtracerTrace,
    ...vtracerParam('maxIterations'),
  },
  {
    id: 'vtSpliceThreshold',
    kind: 'slider',
    label: 'Umbral de empalme',
    section: 'advanced',
    group: 'vtracer',
    min: 0,
    max: 180,
    step: 1,
    decimals: 0,
    unit: '°',
    visible: vtracerTrace,
    ...vtracerParam('spliceThresholdDeg'),
  },
  {
    id: 'vtFilterSpeckle',
    kind: 'slider',
    label: 'Filtro de motas',
    section: 'advanced',
    group: 'vtracer',
    min: 0,
    max: 64,
    step: 1,
    decimals: 0,
    unit: 'px²',
    visible: vtracerTrace,
    ...vtracerParam('filterSpeckle'),
  },
  {
    id: 'vtPathPrecision',
    kind: 'slider',
    label: 'Precisión',
    section: 'advanced',
    group: 'vtracer',
    min: 0,
    max: 8,
    step: 1,
    decimals: 0,
    hint: 'Decimales de las coordenadas que devuelve VTracer.',
    visible: vtracerTrace,
    ...vtracerParam('pathPrecision'),
  },
  // ---- Avanzado · Salida --------------------------------------------------------------------
  {
    id: 'optimize',
    kind: 'toggle',
    label: 'Optimizar con SVGO',
    section: 'advanced',
    group: 'output',
    param: 'optimize',
    hint: 'Solo al descargar o copiar; la vista previa y las métricas usan el SVG sin optimizar.',
    visible: always,
    get: (ctx) => ctx.params.optimize ?? false,
    set: (params, value) => ({ ...params, optimize: value }),
  },
];

export function controlById(id: string): ControlDef | undefined {
  return CONTROLS.find((c) => c.id === id);
}

export function visibleControls(ctx: ControlContext, section?: ControlSection): ControlDef[] {
  return CONTROLS.filter((c) => (section === undefined || c.section === section) && c.visible(ctx));
}

/** Display text of a slider value: "1,00", "+0,05", "2 px²", "60°", "Auto". */
export function formatSliderValue(control: SliderControl, value: number | 'auto'): string {
  if (value === 'auto') return control.auto?.label ?? 'Auto';
  const num = control.signed ? formatSigned(value, control.decimals) : formatDecimal(value, control.decimals);
  if (control.unit === undefined) return num;
  return control.unit === '°' ? `${num}°` : `${num}${NBSP}${control.unit}`;
}

/** Numeric thumb position for a slider (the auto position while 'auto'), clamped to its range. */
export function sliderPosition(control: SliderControl, ctx: ControlContext): number {
  const v = control.get(ctx);
  const n = v === 'auto' ? (control.auto?.position(ctx) ?? control.min) : v;
  return clamp(n, control.min, control.max);
}

/** 0..100: how much of the track is filled at `position`. */
export function sliderFillPercent(control: SliderControl, position: number): number {
  const span = control.max - control.min;
  if (span <= 0) return 0;
  return clamp(((position - control.min) / span) * 100, 0, 100);
}

/** Display text of any control's current value (used to describe parameter changes). */
export function formatControlValue(control: ControlDef, ctx: ControlContext): string {
  switch (control.kind) {
    case 'slider':
      return formatSliderValue(control, control.get(ctx));
    case 'segmented':
    case 'select': {
      const v = control.get(ctx);
      return control.options.find((o) => o.value === v)?.label ?? v;
    }
    case 'toggle':
      return control.get(ctx) ? 'sí' : 'no';
    case 'color':
      return control.get(ctx);
  }
}
