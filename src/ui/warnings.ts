/**
 * Warning banners: titles, merging of classifier and trace warnings, and the suggested action for
 * each code. Pure and DOM-free.
 */
import type {
  BakedBackgroundSetting,
  BakedCheckerboard,
  ConcreteMode,
  Engine,
  SourceInfo,
  TraceParams,
  Warning,
  WarningCode,
} from '../types';
import { DEFAULTS, VTRACER_DEFAULTS } from '../core/params';
import { ENGINE_LABEL } from './format';

export const WARNING_TITLE: Record<WarningCode, string> = {
  photo: 'Parece una foto o un degradado',
  'thin-strokes': 'Trazos muy finos',
  'too-many-rects': 'Demasiados rectángulos',
  'upscale-capped': 'Reescalado limitado',
  'large-input': 'Imagen muy grande',
  'engine-unavailable': 'Motor no disponible',
  'empty-trace': 'El SVG ha salido vacío',
  'baked-checkerboard': 'Transparencia falsa',
  'gradient-fallback': 'Degradados no reconstruidos',
};

export interface WarningContext {
  /** UI parameters (mode may be 'auto'). */
  params: TraceParams;
  /** Mode the trace ran in. */
  mode: ConcreteMode;
  engines: Record<Engine, boolean> | null;
  /** Upscale factor the last trace used; null when unknown. */
  resolvedUpscale: number | null;
  /** The classifier's gradient probe explains enough of the source for Degradados (isGradientCandidate). */
  gradientCandidate: boolean;
}

/**
 * Share of the labelled area the gradient probe must explain (solid, linear or radial regions) before the
 * 'photo' banner offers Degradados instead of more colours. Plan value: the classifier's own threshold to pick
 * gradient is higher (0.85); between the two the image stays a photo but gradients are worth a try.
 */
export const GRADIENT_CANDIDATE_MIN_EXPLAINED = 0.5;

/** True when SourceInfo.gradientProbe explains at least GRADIENT_CANDIDATE_MIN_EXPLAINED of the image. */
export function isGradientCandidate(info: Pick<SourceInfo, 'gradientProbe'>): boolean {
  return (info.gradientProbe?.explained ?? 0) >= GRADIENT_CANDIDATE_MIN_EXPLAINED;
}

export interface WarningAction {
  label: string;
  apply(params: TraceParams): TraceParams;
}

/**
 * Trace warnings first, then classifier warnings whose code is not already present. The
 * classifier's 'thin-strokes' only applies to line tracing, so it is dropped in other modes; its
 * 'photo' warning describes the 16-colour flat palette and suggests Degradados, so it is dropped in
 * gradient mode (where a failed reconstruction brings its own 'gradient-fallback').
 */
export function mergeWarnings(
  traceWarnings: readonly Warning[],
  classifyWarnings: readonly Warning[],
  mode: ConcreteMode,
): Warning[] {
  const out: Warning[] = [];
  const seen = new Set<WarningCode>();
  for (const w of traceWarnings) {
    if (seen.has(w.code)) continue;
    seen.add(w.code);
    out.push(w);
  }
  for (const w of classifyWarnings) {
    if (seen.has(w.code)) continue;
    if (w.code === 'thin-strokes' && mode !== 'lines') continue;
    if (w.code === 'photo' && mode === 'gradient') continue;
    seen.add(w.code);
    out.push(w);
  }
  return out;
}

const TO_FLAT: WarningAction = {
  label: 'Cambiar a Color plano',
  apply: (p) => ({ ...p, mode: 'flat' }),
};

const USE_GRADIENTS: WarningAction = {
  label: 'Usar degradados',
  apply: (p) => ({ ...p, mode: 'gradient' }),
};

const KEEP_CHECKERBOARD: WarningAction = {
  label: 'Mantener el tablero',
  apply: (p) => ({ ...p, bakedBackground: 'keep' }),
};

/**
 * Líneas/logo emits a single fill, so a kept two-tone board cannot show up there: measured on a 256 px
 * board (16 px cells, #ffffff / #cccccc) with a magenta disc and bar, lines + keep gave a grey disc
 * without the board (fidelity 32,9 %, 81 nodes), flat + keep reproduced it (99,6 %, 923 nodes).
 */
const KEEP_CHECKERBOARD_IN_FLAT: WarningAction = {
  label: 'Mantener el tablero en Color plano',
  apply: (p) => ({ ...p, bakedBackground: 'keep', mode: 'flat' }),
};

const TREAT_AS_TRANSPARENT: WarningAction = {
  label: 'Tratar como transparente',
  apply: (p) => ({ ...p, bakedBackground: 'auto' }),
};

const USE_ALPHA_MASK: WarningAction = {
  label: 'Usar máscara de transparencia',
  apply: (p) => ({ ...p, alphaMode: 'mask' }),
};

/**
 * True when an 'empty-trace' message points to the alpha mask: in composite mode the shape of a
 * source lives in its transparency (a light logo composited on the paper vanishes) and the pipeline
 * says so ("Prueba Transparencia: Máscara…"). The code is shared with the threshold and tracer causes,
 * so the message is what tells them apart; tests pin it against the real pipeline.
 */
export function suggestsAlphaMask(warning: Warning): boolean {
  return warning.code === 'empty-trace' && /Transparencia: Máscara/.test(warning.message);
}

/** Cell size as the pipeline words it (whole pixels). */
const cellPx = (det: BakedCheckerboard): number => Math.round(det.cell);

/** The trace's message for a checkerboard treated as transparent (same text as the pipeline's warning). */
export function transparentCheckerboardMessage(det: BakedCheckerboard): string {
  return (
    `La imagen no es transparente de verdad: lleva pintado un tablero de ajedrez (cuadros de ${cellPx(det)} px) ` +
    'que imita la transparencia. Se trató como fondo transparente y se excluyó de la comparación de fidelidad. ' +
    'Si el tablero forma parte del diseño, puedes conservarlo.'
  );
}

/**
 * Banner text while the user keeps the checkerboard (the trace itself no longer warns). In Líneas/logo,
 * which traces a single colour, the kept board cannot appear and the text says so.
 */
export function keptCheckerboardMessage(det: BakedCheckerboard, mode: ConcreteMode): string {
  const kept = `Se conserva el tablero de ajedrez pintado (cuadros de ${cellPx(det)} px) como parte del diseño`;
  if (mode === 'lines') {
    return `${kept}, pero Líneas/logo traza un solo color y no puede reproducirlo: usa Color plano o trátalo como transparente.`;
  }
  return `${kept}: se traza y se compara con los píxeles tal cual. Si solo imita la transparencia, trátalo como transparente.`;
}

/**
 * The 'baked-checkerboard' banner follows the UI setting and mode, not the last trace, which lags
 * behind a click until the re-trace answers (and a 'keep' trace carries no warning at all). With a
 * detection, the banner goes first, as trace() puts it: the trace's own message while the board is
 * treated as transparent (the fallback text when the shown trace was a 'keep' one), the kept text
 * otherwise. Without a detection the list is returned unchanged.
 */
export function withBakedCheckerboard(
  warnings: readonly Warning[],
  detected: BakedCheckerboard | null,
  setting: BakedBackgroundSetting,
  mode: ConcreteMode,
): Warning[] {
  if (detected === null) return [...warnings];
  const fromTrace = warnings.find((w) => w.code === 'baked-checkerboard');
  const message =
    setting === 'keep'
      ? keptCheckerboardMessage(detected, mode)
      : (fromTrace?.message ?? transparentCheckerboardMessage(detected));
  return [{ code: 'baked-checkerboard', message }, ...warnings.filter((w) => w.code !== 'baked-checkerboard')];
}

/** Suggested one-click fix for a warning, or null when there is nothing sensible to offer. */
export function warningAction(warning: Warning, ctx: WarningContext): WarningAction | null {
  const { params, mode } = ctx;
  const d = DEFAULTS[mode];
  const engine: Engine = params.engine ?? d.engine;
  switch (warning.code) {
    case 'photo': {
      // Gradients the probe can explain are rebuilt by Degradados; more flat colours would only add bands.
      if (mode !== 'gradient' && ctx.gradientCandidate) return USE_GRADIENTS;
      if (mode !== 'flat') return TO_FLAT;
      if (params.colors === 32) return null;
      return {
        label: 'Usar 32 colores',
        apply: (p) => ({ ...p, colors: 32, exactPalette: false }),
      };
    }
    case 'thin-strokes': {
      if (mode === 'pixel') return null;
      const upscale = params.upscale ?? d.upscale;
      if (upscale !== 4 && (ctx.resolvedUpscale === null || ctx.resolvedUpscale < 4)) {
        return { label: 'Reescalar a 4×', apply: (p) => ({ ...p, upscale: 4 }) };
      }
      if ((params.blurK ?? d.blurK) > 0.15 + 1e-9) {
        return { label: 'Reducir desenfoque', apply: (p) => ({ ...p, blurK: 0.15 }) };
      }
      return null;
    }
    case 'too-many-rects':
      return mode === 'pixel' ? TO_FLAT : null;
    case 'empty-trace': {
      if (mode === 'lines') {
        return suggestsAlphaMask(warning) && (params.alphaMode ?? d.alphaMode) !== 'mask' ? USE_ALPHA_MASK : TO_FLAT;
      }
      // Flat and gradient trace one mask per layer: a speckle filter larger than the shapes empties both.
      if (mode !== 'flat' && mode !== 'gradient') return null;
      const speckle =
        engine === 'vtracer'
          ? (params.vtracer?.filterSpeckle ?? VTRACER_DEFAULTS.filterSpeckle)
          : (params.turdsize ?? d.turdsize);
      if (speckle <= 0) return null;
      return {
        label: 'Quitar manchas mínimas',
        apply: (p) =>
          engine === 'vtracer'
            ? { ...p, vtracer: { ...p.vtracer, filterSpeckle: 0 } }
            : { ...p, turdsize: 0 },
      };
    }
    case 'engine-unavailable': {
      const other: Engine = engine === 'potrace' ? 'vtracer' : 'potrace';
      if (ctx.engines !== null && !ctx.engines[other]) return null;
      return { label: `Usar ${ENGINE_LABEL[other]}`, apply: (p) => ({ ...p, engine: other }) };
    }
    case 'baked-checkerboard': {
      // Every mode traces the effective source unless the board is kept. The mode chosen in the UI
      // wins over the trace's, which lags behind a mode change.
      if ((params.bakedBackground ?? d.bakedBackground) === 'keep') return TREAT_AS_TRANSPARENT;
      const uiMode = params.mode === undefined || params.mode === 'auto' ? mode : params.mode;
      return uiMode === 'lines' ? KEEP_CHECKERBOARD_IN_FLAT : KEEP_CHECKERBOARD;
    }
    case 'gradient-fallback':
      // The trace already fell back to a 16-colour flat palette: Color plano gives its palette controls.
      return TO_FLAT;
    case 'upscale-capped':
    case 'large-input':
      return null;
  }
}
