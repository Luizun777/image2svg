/**
 * Spanish-locale formatting for the UI (decimal comma, non-breaking space before units).
 * Pure and DOM-free.
 */
import type { ConcreteMode, Engine, Mode } from '../types';

export const NBSP = '\u00a0';

/** Placeholder for a value that cannot be shown (never an em-dash: brand rule). */
export const NOT_AVAILABLE = 'n/d';

/** Fixed decimals with a decimal comma; never prints "-0". */
export function formatDecimal(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return NOT_AVAILABLE;
  let s = value.toFixed(decimals);
  if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
  return s.replace('.', ',');
}

/** Same as formatDecimal but always signed ("+0,05", "-0,10", "0,00"). */
export function formatSigned(value: number, decimals: number): string {
  const s = formatDecimal(value, decimals);
  if (s === NOT_AVAILABLE || s.startsWith('-')) return s;
  return /[1-9]/.test(s) ? `+${s}` : s;
}

/**
 * Integer with thousands grouped by a non-breaking space from five digits on
 * (RAE: "1853", "60 446").
 */
export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return NOT_AVAILABLE;
  const n = Math.round(value);
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(n));
  if (digits.length < 5) return sign + digits;
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Fraction 0..1 as a percentage: 0.9874 → "98,7 %". */
export function formatPercent(fraction: number, decimals = 1): string {
  if (!Number.isFinite(fraction)) return NOT_AVAILABLE;
  return `${formatDecimal(fraction * 100, decimals)}${NBSP}%`;
}

/** Binary units: "512 B", "68,9 KB", "2,28 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return NOT_AVAILABLE;
  if (bytes < 1024) return `${Math.round(bytes)}${NBSP}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${formatDecimal(kb, kb < 100 ? 1 : 0)}${NBSP}KB`;
  return `${formatDecimal(kb / 1024, 2)}${NBSP}MB`;
}

/** "412 ms" below one second, "1,2 s" above. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return NOT_AVAILABLE;
  if (ms < 1000) return `${Math.round(ms)}${NBSP}ms`;
  return `${formatDecimal(ms / 1000, 1)}${NBSP}s`;
}

/** "512 × 512 px". */
export function formatDimensions(width: number, height: number): string {
  return `${formatInteger(width)}${NBSP}×${NBSP}${formatInteger(height)}${NBSP}px`;
}

export type FidelityLevel = 'ok' | 'warn' | 'bad';

export const FIDELITY_OK = 0.97;
export const FIDELITY_WARN = 0.9;

/**
 * Signal level of a fidelity score, decided on the value as DISPLAYED (one decimal of a
 * percentage), so "97,0 %" is never painted as a warning.
 */
export function fidelityLevel(fidelity: number): FidelityLevel {
  // Integer tenths of a percent, exactly as displayed (avoids 0.97 * 100 float drift).
  const tenths = Math.round(fidelity * 1000);
  if (tenths >= Math.round(FIDELITY_OK * 1000)) return 'ok';
  if (tenths >= Math.round(FIDELITY_WARN * 1000)) return 'warn';
  return 'bad';
}

export const FIDELITY_LEVEL_LABEL: Record<FidelityLevel, string> = {
  ok: 'Muy fiel',
  warn: 'Revisar',
  bad: 'Poco fiel',
};

/** One plain-Spanish line on what the fidelity number measures for this mode. */
export function fidelityExplanation(mode: ConcreteMode): string {
  const shape =
    mode === 'lines'
      ? 'coincidencia de formas (IoU)'
      : 'coincidencia de color píxel a píxel (IoU)';
  return (
    'Renderiza el SVG de vuelta y lo compara con el original: 60 % similitud estructural (SSIM) ' +
    `y 40 % ${shape}.`
  ).replace(/ %/g, `${NBSP}%`);
}

export const MODE_LABEL: Record<Mode, string> = {
  auto: 'Auto',
  lines: 'Líneas/logo',
  flat: 'Color plano',
  pixel: 'Píxel exacto',
};

export const ENGINE_LABEL: Record<Engine, string> = {
  potrace: 'Potrace',
  vtracer: 'VTracer',
};

/** "1×", "1,5×", "12×". */
export function formatZoom(zoom: number): string {
  const rounded = Math.round(zoom * 10) / 10;
  return `${formatDecimal(rounded, Number.isInteger(rounded) ? 0 : 1)}×`;
}

/**
 * Error text for the user: "<context>: <message>", unless the message already is a complete failure
 * sentence as the worker and the client word them ("No se pudo vectorizar la imagen: …"), which
 * names its own operation and would otherwise read "No se pudo vectorizar: No se pudo vectorizar…".
 */
export function withErrorContext(context: string, message: string): string {
  return /^No se pudo\b/.test(message.trimStart()) ? message : `${context}: ${message}`;
}
