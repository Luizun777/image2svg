/**
 * Builds the final SVG document from traced layers.
 *
 *   <svg xmlns="http://www.w3.org/2000/svg" width="W" height="H" viewBox="0 0 VW VH"[ shape-rendering="crispEdges"]>
 *   [<rect fill="#rrggbb" width="VW" height="VH"/>]
 *   <path fill="#rrggbb"[ fill-opacity="o"][ fill-rule="evenodd"] d="…"/>   (one per non-empty layer)
 *   </svg>
 *
 * width/height are the ORIGINAL pixel size, the viewBox the traced (upscaled) size.
 * No XML prolog, one element per line. Pure: never mutates its inputs.
 */
import type { Layer, RGB } from '../types';
import { formatNumber, serializePath } from './pathSerialize';

export interface AssembleOptions {
  width: number;
  height: number;
  viewBoxWidth: number;
  viewBoxHeight: number;
  crispEdges?: boolean;
  precision?: number;
  background?: RGB | null;
}

const HEX = '0123456789abcdef';

function channelHex(v: number): string {
  const c = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
  return HEX[c >> 4] + HEX[c & 15];
}

/** '#rrggbb' (lower-case), channels rounded and clamped to 0..255. */
export function rgbToHex(c: RGB): string {
  return '#' + channelHex(c[0]) + channelHex(c[1]) + channelHex(c[2]);
}

/** Minimal escaping so an arbitrary fill string cannot break the attribute/document. */
function escapeAttr(s: string): string {
  return s.replace(/[&<"]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&quot;'));
}

export function assembleSvg(layers: Layer[], opts: AssembleOptions): string {
  const precision = opts.precision ?? 3;
  const w = formatNumber(opts.width, precision);
  const h = formatNumber(opts.height, precision);
  const vw = formatNumber(opts.viewBoxWidth, precision);
  const vh = formatNumber(opts.viewBoxHeight, precision);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${vw} ${vh}"`,
  );
  if (opts.crispEdges) parts.push(' shape-rendering="crispEdges"');
  parts.push('>');

  if (opts.background) {
    parts.push(`\n<rect fill="${rgbToHex(opts.background)}" width="${vw}" height="${vh}"/>`);
  }

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
    if (d.length === 0) continue; // nothing to draw for this layer

    parts.push(`\n<path fill="${escapeAttr(layer.fill)}"`);
    const opacity = layer.opacity;
    if (opacity !== undefined && opacity < 1) {
      const o = opacity <= 0 || !Number.isFinite(opacity) ? 0 : opacity;
      parts.push(` fill-opacity="${formatNumber(o, 4)}"`);
    }
    if (subpaths > 1) parts.push(' fill-rule="evenodd"');
    parts.push(` d="${d}"/>`);
  }

  parts.push('\n</svg>');
  return parts.join('');
}
