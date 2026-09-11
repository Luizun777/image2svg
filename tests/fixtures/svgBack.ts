/**
 * Test helpers to read a pipeline SVG back into layers / rasters (pure, no vitest dependency).
 */
import type { AbsPath, BinaryMask, Gradient, GradientStop, GrayImage, Layer, RGB, RasterImage } from '../../src/types';
import { extractPaths } from '../../src/tracers/svgParse';
import { parsePathData } from '../../src/svg/pathParse';
import { gradientMeanHex } from '../../src/svg/gradients';
import { scaleGradient } from '../../src/core/fillEval';
import { downscaleBoxRaster } from '../../src/core/upscale';
import { rasterizeLayers } from '../../src/metrics/scanline';
import { nearestUpscale } from '../../src/dev/synth';

export interface ParsedSvg {
  width: number;
  height: number;
  vbW: number;
  vbH: number;
  /**
   * One layer per <path>, in document order; coordinates in viewBox units. A path whose fill is
   * url(#id) gets `gradient` (its own copy of that <defs> gradient) and fill = gradientMeanHex.
   */
  layers: Layer[];
  /** Every path of every layer. */
  paths: AbsPath[];
}

const HEADER_RE = /<svg\b[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"[^>]*\sviewBox="0 0 ([\d.]+) ([\d.]+)"/;

const GRADIENT_OPEN_RE = /<(linearGradient|radialGradient)\b([^>]*)>/g;
const STOP_RE = /<stop\b([^>]*)>/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const URL_FILL_RE = /^url\(\s*(['"]?)#([^'")\s]+)\1\s*\)$/;
const LENGTH_RE = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(%?)\s*$/;
const HEX_COLOR_RE = /^\s*#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\s*$/;
/** Attributes the Layer model cannot represent: a gradient using them is rejected instead of misread. */
const UNSUPPORTED_GRADIENT_ATTRS = ['gradientTransform', 'fx', 'fy', 'fr', 'href', 'xlink:href', 'style'];

/** Attribute `name` of a tag's attribute string (whitespace required before the name), or null. */
function readAttr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  if (m === null) return null;
  return m[1] !== undefined ? m[1] : (m[2] ?? '');
}

/** The attribute string of a matched tag with its self-closing slash removed and a leading space. */
function tagAttrs(raw: string): { attrs: string; selfClosing: boolean } {
  const selfClosing = raw.endsWith('/');
  return { attrs: ` ${selfClosing ? raw.slice(0, -1) : raw}`, selfClosing };
}

/** A number, or a percentage of `reference` (userSpaceOnUse percentages refer to the viewport). */
function parseLength(raw: string, reference: number, what: string): number {
  const m = LENGTH_RE.exec(raw);
  if (m === null) throw new Error(`parseSvg: valor ${JSON.stringify(raw)} de ${what} no reconocido`);
  const v = Number(m[1]);
  return m[2] === '%' ? (v / 100) * reference : v;
}

function parseHexColor(raw: string): RGB {
  const m = HEX_COLOR_RE.exec(raw);
  if (m === null) throw new Error(`parseSvg: color ${JSON.stringify(raw)} no soportado (solo #rgb y #rrggbb)`);
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Stops as SVG reads them: offset a number or a percentage, clamped to [0, 1] and raised to the largest
 * previous offset; missing stop-color = black. Equal offsets are kept (stopColorAt resolves them as SVG).
 */
function parseStops(body: string, id: string): GradientStop[] {
  const stops: GradientStop[] = [];
  let prev = 0;
  for (const s of body.matchAll(STOP_RE)) {
    const { attrs } = tagAttrs(s[1]);
    const opacity = readAttr(attrs, 'stop-opacity');
    if (readAttr(attrs, 'style') !== null || (opacity !== null && Number(opacity) !== 1)) {
      throw new Error(`parseSvg: parada de #${id} con style o stop-opacity no soportada`);
    }
    const rawOffset = readAttr(attrs, 'offset');
    let offset = rawOffset === null ? 0 : parseLength(rawOffset, 1, `offset en #${id}`);
    offset = offset > 0 ? (offset < 1 ? offset : 1) : 0;
    if (offset < prev) offset = prev;
    prev = offset;
    stops.push({ offset, color: parseHexColor(readAttr(attrs, 'stop-color') ?? '#000000') });
  }
  return stops;
}

/**
 * Every <linearGradient>/<radialGradient> with an id (the first one wins on duplicates), with the SVG
 * defaults for missing geometry: x1 = y1 = y2 = 0%, x2 = 100%, cx = cy = r = 50% of the viewport. Only
 * gradientUnits="userSpaceOnUse" with spreadMethod pad and no transform, focus or template is accepted.
 */
function parseGradients(svg: string, vbW: number, vbH: number): Map<string, Gradient> {
  const src = svg.replace(COMMENT_RE, '');
  const out = new Map<string, Gradient>();
  const re = new RegExp(GRADIENT_OPEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const tag = m[1];
    const { attrs, selfClosing } = tagAttrs(m[2]);
    let body = '';
    if (!selfClosing) {
      const close = src.indexOf(`</${tag}`, re.lastIndex);
      if (close < 0) throw new Error(`parseSvg: <${tag}> sin cerrar`);
      body = src.slice(re.lastIndex, close);
      re.lastIndex = close;
    }
    const id = readAttr(attrs, 'id');
    if (id === null || out.has(id)) continue;
    for (const name of UNSUPPORTED_GRADIENT_ATTRS) {
      if (readAttr(attrs, name) !== null) throw new Error(`parseSvg: atributo ${name} en #${id} no soportado`);
    }
    const units = readAttr(attrs, 'gradientUnits');
    if (units !== 'userSpaceOnUse') throw new Error(`parseSvg: #${id} sin gradientUnits="userSpaceOnUse"`);
    const spread = readAttr(attrs, 'spreadMethod');
    if (spread !== null && spread !== 'pad') throw new Error(`parseSvg: spreadMethod ${spread} en #${id} no soportado`);
    const len = (name: string, fallback: string, reference: number): number =>
      parseLength(readAttr(attrs, name) ?? fallback, reference, `${name} en #${id}`);
    const stops = parseStops(body, id);
    if (tag === 'linearGradient') {
      out.set(id, {
        kind: 'linear',
        x1: len('x1', '0%', vbW),
        y1: len('y1', '0%', vbH),
        x2: len('x2', '100%', vbW),
        y2: len('y2', '0%', vbH),
        stops,
      });
    } else {
      out.set(id, {
        kind: 'radial',
        cx: len('cx', '50%', vbW),
        cy: len('cy', '50%', vbH),
        r: len('r', '50%', Math.sqrt((vbW * vbW + vbH * vbH) / 2)),
        stops,
      });
    }
  }
  return out;
}

/**
 * Parses the <svg> header, the <defs> gradients and every <path> outside <defs> (fill + d, parsed to
 * absolute segments). A fill url(#id) that names no gradient throws.
 */
export function parseSvg(svg: string): ParsedSvg {
  const m = HEADER_RE.exec(svg);
  if (m === null) throw new Error('parseSvg: cabecera <svg> no reconocida');
  const vbW = Number(m[3]);
  const vbH = Number(m[4]);
  const gradients = parseGradients(svg, vbW, vbH);
  const layers: Layer[] = extractPaths(svg).map((e) => {
    const fill = e.fill ?? '#000000';
    const paths = [parsePathData(e.d)];
    const ref = URL_FILL_RE.exec(fill.trim());
    if (ref === null) return { fill, paths };
    const gradient = gradients.get(ref[2]);
    if (gradient === undefined) throw new Error(`parseSvg: degradado #${ref[2]} no definido`);
    return { fill: gradientMeanHex(gradient), gradient: scaleGradient(gradient, 1), paths };
  });
  return {
    width: Number(m[1]),
    height: Number(m[2]),
    vbW,
    vbH,
    layers,
    paths: layers.flatMap((l) => l.paths),
  };
}

/** Coverage image -> mask at 128. */
export function binarise(cov: GrayImage): BinaryMask {
  const out = new Uint8Array(cov.data.length);
  for (let i = 0; i < out.length; i++) out[i] = cov.data[i] >= 128 ? 1 : 0;
  return { data: out, width: cov.width, height: cov.height };
}

export function hexToRgb(hex: string): RGB {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Number of subpaths (M segments) in a path. */
export function subpathCount(p: AbsPath): number {
  let n = 0;
  for (const s of p.segs) if (s.kind === 'M') n++;
  return n;
}

/**
 * Renders the parsed layers at viewBox size over `background` and brings the result to the
 * original 1x size: box-downscale when the viewBox is an integer multiple of the image
 * (lines/flat, U >= 1), nearest-upscale when the image is a multiple of the viewBox (pixel mode).
 */
export function renderAt1x(parsed: ParsedSvg, background: RGB | null): RasterImage {
  const rendered = rasterizeLayers(parsed.layers, parsed.vbW, parsed.vbH, background);
  if (parsed.vbW === parsed.width && parsed.vbH === parsed.height) return rendered;
  if (parsed.vbW % parsed.width === 0 && parsed.vbW / parsed.width === parsed.vbH / parsed.height) {
    return downscaleBoxRaster(rendered, parsed.vbW / parsed.width);
  }
  if (parsed.width % parsed.vbW === 0 && parsed.width / parsed.vbW === parsed.height / parsed.vbH) {
    return nearestUpscale(rendered, parsed.width / parsed.vbW);
  }
  throw new Error(`renderAt1x: viewBox ${parsed.vbW}x${parsed.vbH} vs tamaño ${parsed.width}x${parsed.height}`);
}
