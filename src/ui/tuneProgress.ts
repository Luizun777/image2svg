/**
 * Presentation of the automatic tuning progress. Pure and DOM-free.
 *
 * The tuner (src/tuner/autotune.ts) reports `done` as the cumulative number of evaluated
 * candidates over a fixed `total` for the whole run (measured: "A 25/101", then "B 58/101"), with
 * the current stage as context. The bar therefore shows done/total; the app keeps the maximum,
 * so an implementation that restarted counts per stage would stall instead of going backwards.
 * A run can finish before reaching `total` (early exit or time budget).
 */
import type { ConcreteMode, TraceParams } from '../types';
import type { TuneProgress, TuneSummary } from '../workers/protocol';
import { NBSP, formatBytes, formatDecimal, formatInteger, formatPercent } from './format';
import { sameTrace } from './paramState';

/** Time budget handed to `client.tune()`. */
export const TUNE_BUDGET_MS = 3000;

/**
 * Fidelity the tuner may give up for a cleaner trace, as a 0..1 fraction. Mirrors FIDELITY_GUARD of
 * src/tuner/autotune.ts (not imported: the main bundle must not pull the tuner in); a test pins both.
 */
export const TUNE_FIDELITY_GUARD = 0.005;

/**
 * Help line under the button. The score trades fidelity against corners and node complexity (a trace
 * can end with fewer corners but more nodes: avatar 171 -> 3 corners, 1027 -> 1488 nodes) and the
 * guard bounds the fidelity loss, so the copy promises a balance, not "fewer nodes".
 */
export const TUNE_HINT =
  `Busca durante ${formatDecimal(TUNE_BUDGET_MS / 1000, 0)}${NBSP}s el mejor equilibrio entre fidelidad, esquinas y nodos, ` +
  `sin perder más de ${formatDecimal(TUNE_FIDELITY_GUARD * 100, 1)} puntos de fidelidad.`;

export const TUNE_STAGE_LABEL: Record<TuneProgress['stage'], string> = {
  A: 'Etapa A: exploración',
  B: 'Etapa B: refinado',
  engine: 'Motor: Potrace frente a VTracer',
};

/** Overall completion 0..1 (done/total, clamped; 0 without a total). */
export function tuneFraction(p: TuneProgress): number {
  if (!(p.total > 0) || !Number.isFinite(p.done)) return 0;
  return Math.min(1, Math.max(0, p.done / p.total));
}

/** "Etapa A: exploración · 12/40 · mejor puntuación 0,947". */
export function describeTuneProgress(p: TuneProgress): string {
  const parts = [TUNE_STAGE_LABEL[p.stage] ?? p.stage, `${p.done}/${p.total}`];
  if (p.best !== null) parts.push(`mejor puntuación ${formatDecimal(p.best.score, 3)}`);
  return parts.join(' · ');
}

/** Corner nodes (L segments) of a summary: nodeCount = lines + curves and cornerFraction = lines / nodes. */
export function tuneCornerCount(s: TuneSummary): number {
  return Math.round(s.cornerFraction * s.nodeCount);
}

/** "de X a Y" with non-breaking spaces. */
function change(from: string, to: string, unit = ''): string {
  return `de${NBSP}${from}${NBSP}a${NBSP}${to}${unit === '' ? '' : `${NBSP}${unit}`}`;
}

/** "de 40,2 a 29,6 KB" when both sizes share a unit, else "de 1,02 MB a 980 KB". */
function sizeChange(from: number, to: number): string {
  const a = formatBytes(from);
  const b = formatBytes(to);
  const [numA, unitA] = a.split(NBSP);
  const [numB, unitB] = b.split(NBSP);
  return unitA !== undefined && unitA === unitB ? change(numA, numB, unitA) : change(a, b);
}

/**
 * Before and after line shown when a tune is applied, both sides as the tuner measured them:
 * "Fidelidad de 86,8 % a 86,6 % · Esquinas de 79 a 3 · Nodos de 1218 a 851 · Tamaño de 40,2 a 29,6 KB".
 * Words, not an arrow: the line is set in JetBrains Mono and no self-hosted subset covers U+2192, so
 * the arrow came from the fallback monospace. Spaces inside each item are non-breaking, so a narrow
 * panel only wraps between items.
 */
export function formatTuneSummary(baseline: TuneSummary, tuned: TuneSummary): string {
  return [
    `Fidelidad${NBSP}${change(formatPercent(baseline.fidelity), formatPercent(tuned.fidelity))}`,
    `Esquinas${NBSP}${change(formatInteger(tuneCornerCount(baseline)), formatInteger(tuneCornerCount(tuned)))}`,
    `Nodos${NBSP}${change(formatInteger(baseline.nodeCount), formatInteger(tuned.nodeCount))}`,
    `Tamaño${NBSP}${sizeChange(baseline.bytes, tuned.bytes)}`,
  ].join(' · ');
}

/** The parameters a tune message on screen was shown for ("Ajuste aplicado." and its summary, a cancel, an error). */
export interface ShownTuneResult {
  params: TraceParams;
  detected: ConcreteMode;
}

/**
 * True once the current parameters no longer trace like the ones the tune message describes: its
 * before and after figures would contradict the results panel, so the app clears it.
 */
export function tuneResultOutdated(shown: ShownTuneResult | null, current: TraceParams): boolean {
  return shown !== null && !sameTrace(shown.params, current, shown.detected);
}
