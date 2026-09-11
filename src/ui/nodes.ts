/**
 * Node extraction for the "Mostrar nodos" overlay. Pure and DOM-free.
 *
 * A node is the end point of a drawing segment (same definition as `pathStats`): L end points are
 * corner nodes, C/Q end points are curve nodes. A spike in a trace shows up as a dense cluster of
 * corner nodes. Coordinates are in viewBox units; `viewBoxToScreen` maps them onto the displayed
 * image box following the SVG default `preserveAspectRatio="xMidYMid meet"`.
 */
import { applyTransform, parsePathData, parseTransform } from '../svg/pathParse';
import { extractPaths } from '../tracers/svgParse';

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SvgRoot {
  width: number;
  height: number;
  viewBox: ViewBox;
}

export interface SvgNodes {
  root: SvgRoot | null;
  /** Corner node positions as x,y pairs (viewBox units). */
  corners: Float64Array;
  /** Curve node positions as x,y pairs (viewBox units). */
  curves: Float64Array;
  cornerCount: number;
  curveCount: number;
  /** <path> elements whose data could not be parsed (skipped, never thrown). */
  skippedPaths: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NodeMapping {
  scale: number;
  offsetX: number;
  offsetY: number;
}

const SVG_OPEN_RE = /<svg\b([^>]*)>/;
const LENGTH_RE = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(?:px)?\s*$/;

function readAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (m === null) return null;
  return m[1] !== undefined ? m[1] : (m[2] ?? '');
}

function parseLength(raw: string | null): number | null {
  if (raw === null) return null;
  const m = LENGTH_RE.exec(raw);
  if (m === null) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Root width/height/viewBox. A missing viewBox falls back to 0 0 width height; null when neither. */
export function parseSvgRoot(svg: string): SvgRoot | null {
  const m = SVG_OPEN_RE.exec(svg);
  if (m === null) return null;
  const attrs = ` ${m[1]}`;
  let viewBox: ViewBox | null = null;
  const vbRaw = readAttr(attrs, 'viewBox');
  if (vbRaw !== null) {
    const parts = vbRaw.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      viewBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
  }
  const width = parseLength(readAttr(attrs, 'width'));
  const height = parseLength(readAttr(attrs, 'height'));
  if (viewBox === null) {
    if (width === null || height === null) return null;
    viewBox = { x: 0, y: 0, width, height };
  }
  return { width: width ?? viewBox.width, height: height ?? viewBox.height, viewBox };
}

export function extractNodes(svg: string): SvgNodes {
  const corners: number[] = [];
  const curves: number[] = [];
  let skippedPaths = 0;
  for (const p of extractPaths(svg)) {
    let segs;
    try {
      let path = parsePathData(p.d);
      if (p.transform !== null) path = applyTransform(path, parseTransform(p.transform));
      segs = path.segs;
    } catch {
      skippedPaths++;
      continue;
    }
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.kind === 'L') corners.push(s.x, s.y);
      else if (s.kind === 'C' || s.kind === 'Q') curves.push(s.x, s.y);
    }
  }
  return {
    root: parseSvgRoot(svg),
    corners: Float64Array.from(corners),
    curves: Float64Array.from(curves),
    cornerCount: corners.length / 2,
    curveCount: curves.length / 2,
    skippedPaths,
  };
}

/** viewBox units → screen px inside `rect` (xMidYMid meet): `sx = offsetX + x * scale`. */
export function viewBoxToScreen(viewBox: ViewBox, rect: ScreenRect): NodeMapping {
  const scale = Math.min(rect.width / viewBox.width, rect.height / viewBox.height);
  return {
    scale,
    offsetX: rect.left + (rect.width - viewBox.width * scale) / 2 - viewBox.x * scale,
    offsetY: rect.top + (rect.height - viewBox.height * scale) / 2 - viewBox.y * scale,
  };
}
