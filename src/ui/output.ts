/**
 * Output helpers: data URLs, download file names and the optional SVGO pass applied to what the
 * user downloads or copies. DOM-free; SVGO is loaded lazily (its own chunk) the first time.
 */

import type { Config } from 'svgo/browser';

const DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';

/** `data:image/svg+xml;charset=utf-8,…` with the markup percent-encoded (safe for `#`, `%`, quotes). */
export function svgDataUrl(svg: string): string {
  return DATA_URL_PREFIX + encodeURIComponent(svg);
}

const FALLBACK_BASENAME = 'imagen';
const FORBIDDEN_FILE_CHARS = '\\\\/:*?"<>|';

/**
 * Download name: the source name without its extension plus ".svg". Path separators and
 * characters that file systems reject become "-"; an empty result falls back to "imagen.svg".
 */
export function svgFileName(sourceName: string): string {
  let base = sourceName.trim();
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.slice(0, dot);
  let cleaned = '';
  for (const ch of base) cleaned += ch.charCodeAt(0) < 32 || FORBIDDEN_FILE_CHARS.includes(ch) ? '-' : ch;
  cleaned = cleaned.replace(/-{2,}/g, '-').replace(/^[-.\s]+|[-.\s]+$/g, '');
  return `${cleaned.length > 0 ? cleaned : FALLBACK_BASENAME}.svg`;
}

/**
 * SVGO configuration for the exported file (the only one: optimizeSvg passes it as is).
 * `mergePaths` stays off so every colour layer keeps its own path (editors rely on it).
 * `cleanupIds` stays off so the gradient ids g<h>-0, g<h>-1… (unique per document, see assembleSvg) keep
 * their names and their url(#…) references (SVGO would shorten them to a, b…, the same in every file);
 * `removeUselessDefs` keeps its default, since it
 * only drops <defs> children without an id and every emitted gradient has one. SVGO 4 no longer
 * runs `removeViewBox` in preset-default, so the viewBox survives without an override
 * (overriding a plugin outside the preset only logs a warning). Coordinates keep 4 decimals.
 */
export const SVGO_CONFIG: Config = {
  multipass: false,
  floatPrecision: 4,
  plugins: [
    {
      name: 'preset-default',
      params: {
        floatPrecision: 4,
        overrides: { mergePaths: false, cleanupIds: false },
      },
    },
  ],
};

type SvgoModule = typeof import('svgo/browser');
let svgoPromise: Promise<SvgoModule> | null = null;

/** Starts downloading the SVGO chunk (idempotent). */
export function preloadSvgo(): Promise<SvgoModule> {
  if (svgoPromise === null) {
    svgoPromise = import('svgo/browser').catch((err: unknown) => {
      svgoPromise = null;
      throw err;
    });
  }
  return svgoPromise;
}

/** Runs SVGO with SVGO_CONFIG. Rejects with a Spanish message if SVGO cannot load or parse. */
export async function optimizeSvg(svg: string): Promise<string> {
  let mod: SvgoModule;
  try {
    mod = await preloadSvgo();
  } catch {
    throw new Error('No se pudo cargar el optimizador SVGO.');
  }
  try {
    return mod.optimize(svg, SVGO_CONFIG).data;
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : '';
    throw new Error(`SVGO no pudo optimizar el SVG${detail}`);
  }
}
