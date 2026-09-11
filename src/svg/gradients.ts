/**
 * SVG serialisation of gradient fills (gradient mode) and the '#rrggbb' colour format shared with
 * assemble.ts. rgbToHex lives here so the dependency stays one-way (assemble.ts → gradients.ts);
 * assemble.ts re-exports it for its existing importers.
 *
 *   <linearGradient id="g<h>-0" gradientUnits="userSpaceOnUse" x1="…" y1="…" x2="…" y2="…"><stop offset="0" stop-color="#rrggbb"/>…</linearGradient>
 *   <radialGradient id="g<h>-1" gradientUnits="userSpaceOnUse" cx="…" cy="…" r="…"><stop …/>…</radialGradient>
 *
 * Coordinates are in viewBox units (the same as the paths, see core/fillEval.ts for the convention) and
 * use the path precision; no gradientTransform, fx, fy or spreadMethod (pad is the SVG default), so every
 * editor reads the gradient the same way. Pure: never mutates its inputs.
 */
import type { Gradient, RGB } from '../types';
import { gradientMeanColor, normalizeStops } from '../core/fillEval';
import { formatNumber } from './pathSerialize';

const HEX = '0123456789abcdef';

function channelHex(v: number): string {
  const c = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
  return HEX[c >> 4] + HEX[c & 15];
}

/** '#rrggbb' (lower-case), channels rounded and clamped to 0..255. */
export function rgbToHex(c: RGB): string {
  return '#' + channelHex(c[0]) + channelHex(c[1]) + channelHex(c[2]);
}

/** Stop offsets keep at most this many decimals (1e-4 of the ramp, far below one level of colour). */
const OFFSET_DECIMALS = 4;

/** An XML name without a namespace prefix, so the id can be referenced as url(#id) and needs no escaping. */
const ID_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * One-line <linearGradient>/<radialGradient> element with id `id`. Coordinates and r go through
 * formatNumber(v, precision); stops are normalizeStops(g.stops), offsets printed with at most 4 decimals
 * and stop-color = rgbToHex (colours are rounded here). Callers skip degenerate gradients
 * (isDegenerateGradient); a non-finite coordinate or an id that is not an XML name throws.
 */
export function serializeGradient(g: Gradient, id: string, precision: number): string {
  if (!ID_RE.test(id)) throw new Error(`serializeGradient: invalid id ${JSON.stringify(id)}`);
  const num = (v: number): string => formatNumber(v, precision);
  const tag = g.kind === 'linear' ? 'linearGradient' : 'radialGradient';
  let s =
    g.kind === 'linear'
      ? `<${tag} id="${id}" gradientUnits="userSpaceOnUse" x1="${num(g.x1)}" y1="${num(g.y1)}" x2="${num(g.x2)}" y2="${num(g.y2)}">`
      : `<${tag} id="${id}" gradientUnits="userSpaceOnUse" cx="${num(g.cx)}" cy="${num(g.cy)}" r="${num(g.r)}">`;
  for (const stop of normalizeStops(g.stops)) {
    s += `<stop offset="${formatNumber(stop.offset, OFFSET_DECIMALS)}" stop-color="${rgbToHex(stop.color)}"/>`;
  }
  return `${s}</${tag}>`;
}

/** rgbToHex(gradientMeanColor(g)): the flat colour a reader that ignores the gradient paints (Layer.fill). */
export function gradientMeanHex(g: Gradient): string {
  return rgbToHex(gradientMeanColor(g));
}
