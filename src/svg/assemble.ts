/**
 * Builds the final SVG document from traced layers.
 *
 *   <svg xmlns="http://www.w3.org/2000/svg" width="W" height="H" viewBox="0 0 VW VH"[ shape-rendering="crispEdges"]>
 *   [<defs>
 *   <linearGradient id="g<h>-0" …>…</linearGradient>      (one per drawn layer with a non-degenerate gradient)
 *   </defs>]
 *   [<rect fill="#rrggbb" width="VW" height="VH"/>]
 *   <path fill="#rrggbb"|"url(#g<h>-n)"[ fill-opacity="o"][ fill-rule="evenodd"] d="…"/>   (one per non-empty layer)
 *   </svg>
 *
 * width/height are the ORIGINAL pixel size, the viewBox the traced (upscaled) size.
 * No XML prolog, one element per line. Without gradients the output is exactly the pre-gradient format.
 * Gradient ids are `g<h>-<n>`: n = 0, 1… in layer order and h = gradientIdPrefix of the document written with
 * the plain ids g0, g1…, so ids are stable for the same layers and differ between documents (two SVGs pasted
 * in one page must not resolve url(#…) to each other's gradients).
 * Pure: never mutates its inputs.
 */
import type { Layer, RGB } from '../types';
import { isDegenerateGradient } from '../core/fillEval';
import { rgbToHex, serializeGradient } from './gradients';
import { formatNumber, serializePath } from './pathSerialize';

export { rgbToHex } from './gradients';

export interface AssembleOptions {
  width: number;
  height: number;
  viewBoxWidth: number;
  viewBoxHeight: number;
  crispEdges?: boolean;
  precision?: number;
  background?: RGB | null;
}

/** Minimal escaping so an arbitrary fill string cannot break the attribute/document. */
function escapeAttr(s: string): string {
  return s.replace(/[&<"]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&quot;'));
}

/** FNV-1a (32 bit) of the UTF-16 code units of `s`, in base 36: the per-document part of the gradient ids. */
export function gradientIdPrefix(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function assembleSvg(layers: Layer[], opts: AssembleOptions): string {
  const precision = opts.precision ?? 3;
  const w = formatNumber(opts.width, precision);
  const h = formatNumber(opts.height, precision);
  const vw = formatNumber(opts.viewBoxWidth, precision);
  const vh = formatNumber(opts.viewBoxHeight, precision);

  // First pass: the path data of every layer. The <defs> precede the paths and only layers that draw
  // something get a gradient, numbered 0, 1… in layer order without gaps.
  const ds: string[] = [];
  const evenOdd: boolean[] = [];
  const gradientIndex: number[] = [];
  let gradientCount = 0;
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const paths = layer.paths;
    let subpaths = 0;
    let d = '';
    for (let pi = 0; pi < paths.length; pi++) {
      const segs = paths[pi].segs;
      for (let si = 0; si < segs.length; si++) {
        if (segs[si].kind === 'M') subpaths++;
      }
      d += serializePath(paths[pi], precision);
    }
    ds.push(d);
    evenOdd.push(subpaths > 1);
    const gradient = layer.gradient;
    gradientIndex.push(d.length > 0 && gradient !== undefined && !isDegenerateGradient(gradient) ? gradientCount++ : -1);
  }

  const render = (idOf: (n: number) => string): string => {
    let defs = '';
    for (let li = 0; li < layers.length; li++) {
      const n = gradientIndex[li];
      if (n >= 0) defs += '\n' + serializeGradient(layers[li].gradient as NonNullable<Layer['gradient']>, idOf(n), precision);
    }
    return document(defs, (li) => (gradientIndex[li] >= 0 ? idOf(gradientIndex[li]) : null));
  };
  const document = (defs: string, idOfLayer: (li: number) => string | null): string => {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${vw} ${vh}"`,
  );
  if (opts.crispEdges) parts.push(' shape-rendering="crispEdges"');
  parts.push('>');

  if (defs.length > 0) parts.push('\n<defs>', defs, '\n</defs>');

  if (opts.background) {
    parts.push(`\n<rect fill="${rgbToHex(opts.background)}" width="${vw}" height="${vh}"/>`);
  }

  for (let li = 0; li < layers.length; li++) {
    const d = ds[li];
    if (d.length === 0) continue; // nothing to draw for this layer
    const layer = layers[li];
    const id = idOfLayer(li);

    parts.push(`\n<path fill="${id !== null ? `url(#${id})` : escapeAttr(layer.fill)}"`);
    const opacity = layer.opacity;
    if (opacity !== undefined && opacity < 1) {
      const o = opacity <= 0 || !Number.isFinite(opacity) ? 0 : opacity;
      parts.push(` fill-opacity="${formatNumber(o, 4)}"`);
    }
    if (evenOdd[li]) parts.push(' fill-rule="evenodd"');
    parts.push(` d="${d}"/>`);
  }

  parts.push('\n</svg>');
  return parts.join('');
  };
  if (gradientCount === 0) return document('', () => null);
  const prefix = gradientIdPrefix(render((n) => `g${n}`));
  return render((n) => `g${prefix}-${n}`);
}
