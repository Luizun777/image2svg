/**
 * Serialises `AbsPath` segments back to SVG path data using absolute commands only
 * (M L Q C Z). Consecutive segments of the same kind (L, Q, C) reuse the command letter via
 * implicit repeats, numbers are rounded to `precision` decimals with trailing zeros stripped,
 * and tokens are separated by exactly one space (none between a command letter and its
 * first number, none around Z). Pure: never mutates its inputs.
 */
import type { AbsPath } from '../types';

const C_DOT = 46;
const C_0 = 48;

/**
 * Formats a finite number with at most `precision` decimals, no trailing zeros, no "-0".
 * Integers are emitted verbatim. Non-finite values throw (they indicate an upstream bug).
 */
export function formatNumber(n: number, precision = 3): string {
  if (!Number.isFinite(n)) throw new Error(`formatNumber: non-finite value ${n}`);
  if (Number.isInteger(n)) return n === 0 ? '0' : String(n);
  const p = precision >= 20 ? 20 : precision <= 0 ? 0 : Math.floor(precision);
  let s = n.toFixed(p);
  if (s.indexOf('.') !== -1) {
    let end = s.length;
    while (s.charCodeAt(end - 1) === C_0) end--;
    if (s.charCodeAt(end - 1) === C_DOT) end--;
    s = s.slice(0, end);
  }
  if (s === '-0') return '0';
  return s;
}

export function serializePath(p: AbsPath, precision = 3): string {
  const segs = p.segs;
  if (segs.length === 0) return '';
  const parts: string[] = [];
  let last = ''; // kind of the previous segment, for implicit repeats
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    switch (s.kind) {
      case 'M':
        parts.push('M', formatNumber(s.x, precision), ' ', formatNumber(s.y, precision));
        break;
      case 'L':
        parts.push(
          last === 'L' ? ' ' : 'L',
          formatNumber(s.x, precision),
          ' ',
          formatNumber(s.y, precision),
        );
        break;
      case 'Q':
        parts.push(
          last === 'Q' ? ' ' : 'Q',
          formatNumber(s.x1, precision),
          ' ',
          formatNumber(s.y1, precision),
          ' ',
          formatNumber(s.x, precision),
          ' ',
          formatNumber(s.y, precision),
        );
        break;
      case 'C':
        parts.push(
          last === 'C' ? ' ' : 'C',
          formatNumber(s.x1, precision),
          ' ',
          formatNumber(s.y1, precision),
          ' ',
          formatNumber(s.x2, precision),
          ' ',
          formatNumber(s.y2, precision),
          ' ',
          formatNumber(s.x, precision),
          ' ',
          formatNumber(s.y, precision),
        );
        break;
      case 'Z':
        parts.push('Z');
        break;
    }
    last = s.kind;
  }
  return parts.join('');
}

/**
 * Axis-aligned bounds over every endpoint AND control point (a conservative hull of the
 * curves). An empty path yields min=+Infinity / max=-Infinity so results compose with min/max.
 */
export function pathBounds(p: AbsPath): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const segs = p.segs;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.kind === 'Z') continue;
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
    if (s.kind === 'Q' || s.kind === 'C') {
      if (s.x1 < minX) minX = s.x1;
      if (s.x1 > maxX) maxX = s.x1;
      if (s.y1 < minY) minY = s.y1;
      if (s.y1 > maxY) maxY = s.y1;
      if (s.kind === 'C') {
        if (s.x2 < minX) minX = s.x2;
        if (s.x2 > maxX) maxX = s.x2;
        if (s.y2 < minY) minY = s.y2;
        if (s.y2 > maxY) maxY = s.y2;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}
