/**
 * UI parameter state helpers: what is sent to the tracer, when a re-trace is needed, how tuned
 * parameters are applied and described. Pure and DOM-free.
 *
 * The UI keeps `TraceParams` whose `mode` may be 'auto' (the "Auto" chip) plus the output-only
 * `optimize` flag. The tracer always receives the concrete mode (the detected one while Auto is
 * selected) and never `optimize`, so toggling SVGO does not re-trace.
 */
import type { BackgroundSetting, ConcreteMode, TraceParams, VtracerParams } from '../types';
import { DEFAULTS, VTRACER_DEFAULTS } from '../core/params';
import type { ControlContext } from './controlSchema';
import { CONTROLS, formatControlValue } from './controlSchema';

export function effectiveMode(params: TraceParams, detected: ConcreteMode): ConcreteMode {
  const m = params.mode ?? 'auto';
  return m === 'auto' ? detected : m;
}

/** Parameters for `client.trace()` / `client.tune()`: concrete mode, no output-only keys. */
export function traceParamsFor(ui: TraceParams, detected: ConcreteMode): TraceParams {
  const out: TraceParams = { ...ui, mode: effectiveMode(ui, detected) };
  delete out.optimize;
  return out;
}

type FlatValue = string | number | boolean;

function backgroundKey(bg: BackgroundSetting): string {
  return typeof bg === 'object' ? `rgb(${bg.rgb.map((c) => Math.round(c)).join(',')})` : bg;
}

const PARAM_KEYS = Object.keys(DEFAULTS.lines).filter((k) => k !== 'vtracer') as Array<
  Exclude<keyof (typeof DEFAULTS)['lines'], 'vtracer'>
>;
const VTRACER_KEYS = Object.keys(VTRACER_DEFAULTS) as Array<keyof VtracerParams>;

/** Every parameter resolved against the mode defaults, flattened to comparable scalars. */
function flatten(params: TraceParams, mode: ConcreteMode): Map<string, FlatValue> {
  const d = DEFAULTS[mode];
  const out = new Map<string, FlatValue>();
  out.set('mode', mode);
  for (const key of PARAM_KEYS) {
    const raw = params[key] ?? d[key];
    out.set(key, key === 'background' ? backgroundKey(raw as BackgroundSetting) : (raw as FlatValue));
  }
  for (const key of VTRACER_KEYS) {
    out.set(`vtracer.${key}`, params.vtracer?.[key] ?? VTRACER_DEFAULTS[key]);
  }
  return out;
}

/**
 * Parameter paths that differ between `a` and `b` once both are resolved against their
 * effective mode's defaults ('mode', 'alphamax', 'vtracer.cornerThresholdDeg', …), in a stable
 * order. An omitted value equals its default.
 */
export function diffParams(a: TraceParams, b: TraceParams, detected: ConcreteMode): string[] {
  const fa = flatten(a, effectiveMode(a, detected));
  const fb = flatten(b, effectiveMode(b, detected));
  const changed: string[] = [];
  for (const [key, value] of fa) if (fb.get(key) !== value) changed.push(key);
  return changed;
}

/** True when both would produce the same trace (output-only keys ignored). */
export function sameTrace(a: TraceParams, b: TraceParams, detected: ConcreteMode): boolean {
  return diffParams(traceParamsFor(a, detected), traceParamsFor(b, detected), detected).length === 0;
}

function contextFor(params: TraceParams, detected: ConcreteMode): ControlContext {
  return {
    params,
    mode: effectiveMode(params, detected),
    engines: null,
    paletteColors: null,
    grid: 1,
    resolvedUpscale: null,
    bakedBackground: null,
  };
}

/**
 * Human-readable changes between two parameter sets, one per edited control:
 * "Suavizado: 1,00 → 1,15". Parameters without a control are not described.
 */
export function describeParamChanges(
  before: TraceParams,
  after: TraceParams,
  detected: ConcreteMode,
): string[] {
  const changed = new Set(diffParams(before, after, detected));
  const ctxBefore = contextFor(before, detected);
  const ctxAfter = contextFor(after, detected);
  const lines: string[] = [];
  const described = new Set<string>();
  for (const control of CONTROLS) {
    if (!changed.has(control.param) || described.has(control.param)) continue;
    if (control.kind === 'color') continue; // the background select already describes it
    described.add(control.param);
    const from = formatControlValue(control, ctxBefore);
    const to = formatControlValue(control, ctxAfter);
    if (from !== to) lines.push(`${control.label}: ${from} → ${to}`);
  }
  return lines;
}

/**
 * Applies the tuner's parameters over the UI state. Keys the tuner omitted keep their UI value;
 * the "Auto" chip stays selected when the tuner kept the detected mode; `optimize` is preserved.
 */
export function applyTunedParams(
  ui: TraceParams,
  tuned: TraceParams,
  detected: ConcreteMode,
): TraceParams {
  const next: TraceParams = { ...ui, ...tuned };
  if (ui.vtracer !== undefined || tuned.vtracer !== undefined) {
    next.vtracer = { ...ui.vtracer, ...tuned.vtracer };
  }
  const uiMode = ui.mode ?? 'auto';
  const tunedMode = tuned.mode ?? 'auto';
  if (tunedMode === 'auto') next.mode = uiMode;
  else if (uiMode === 'auto' && tunedMode === detected) next.mode = 'auto';
  if (ui.optimize === undefined) delete next.optimize;
  else next.optimize = ui.optimize;
  return next;
}
