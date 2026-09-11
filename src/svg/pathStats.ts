/**
 * Statistics over traced layers (node/segment counts, corner fraction) plus helpers to
 * count segments in a raw `d` string and to measure UTF-8 size without TextEncoder.
 * Pure: never mutates its inputs.
 */
import type { Layer, PathStats } from '../types';

/**
 * Node definition: a node is the END POINT of a drawing segment (L, Q or C). The M that opens
 * a subpath is not a node (it is the start point, which the closing segment returns to), and
 * Z adds none. So a square "M + 3 L + Z" has 3 nodes, a circle of 4 C has 4 nodes.
 *
 * - pathCount: number of AbsPath objects across all layers.
 * - subpathCount: number of M segments (each M opens a subpath).
 * - cornerFraction: lineCount / (lineCount + curveCount), 0 when there are no segments.
 * - bytes: the `svgBytes` given by the caller (UTF-8 length of the final SVG).
 */
export function pathStats(layers: Layer[], svgBytes: number): PathStats {
  let pathCount = 0;
  let subpathCount = 0;
  let lineCount = 0;
  let curveCount = 0;
  for (let li = 0; li < layers.length; li++) {
    const paths = layers[li].paths;
    pathCount += paths.length;
    for (let pi = 0; pi < paths.length; pi++) {
      const segs = paths[pi].segs;
      for (let si = 0; si < segs.length; si++) {
        switch (segs[si].kind) {
          case 'M':
            subpathCount++;
            break;
          case 'L':
            lineCount++;
            break;
          case 'Q':
          case 'C':
            curveCount++;
            break;
          case 'Z':
            break;
        }
      }
    }
  }
  const total = lineCount + curveCount;
  return {
    pathCount,
    subpathCount,
    nodeCount: total,
    lineCount,
    curveCount,
    cornerFraction: total === 0 ? 0 : lineCount / total,
    bytes: svgBytes,
  };
}

/** One command letter or one number ("3.5.5" splits into "3.5" and ".5"; "1e-3" is one token). */
const TOKEN_SRC = '[A-Za-z]|[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';

function commandArity(cmd: string): number {
  switch (cmd) {
    case 'M':
    case 'm':
    case 'L':
    case 'l':
    case 'T':
    case 't':
      return 2;
    case 'H':
    case 'h':
    case 'V':
    case 'v':
      return 1;
    case 'C':
    case 'c':
      return 6;
    case 'S':
    case 's':
    case 'Q':
    case 'q':
      return 4;
    case 'Z':
    case 'z':
      return 0;
    default:
      return -1;
  }
}

/**
 * Counts segments in a raw path string, implicit repeats included. L/l/H/h/V/v are lines
 * (and so are the implicit LineTos following M/m), C/c/S/s/Q/q/T/t are curves, M/m are moves.
 * Independent from `parsePathData` so tests can cross-check the two. Throws on unknown commands.
 */
export function countSegments(d: string): { lines: number; curves: number; moves: number } {
  let lines = 0;
  let curves = 0;
  let moves = 0;
  const re = new RegExp(TOKEN_SRC, 'g');
  let cmd = '';
  let arity = -1;
  let seen = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const tok = m[0];
    const c = tok.charCodeAt(0);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      cmd = tok;
      arity = commandArity(cmd);
      if (arity < 0) throw new Error(`countSegments: unsupported command "${cmd}" at index ${m.index}`);
      seen = 0;
      continue;
    }
    if (arity <= 0) {
      throw new Error(`countSegments: unexpected number "${tok}" at index ${m.index}`);
    }
    seen++;
    if (seen < arity) continue;
    seen = 0;
    switch (cmd) {
      case 'M':
        moves++;
        cmd = 'L'; // implicit repeats after M are LineTo
        break;
      case 'm':
        moves++;
        cmd = 'l';
        break;
      case 'L':
      case 'l':
      case 'H':
      case 'h':
      case 'V':
      case 'v':
        lines++;
        break;
      default:
        curves++;
        break;
    }
  }
  return { lines, curves, moves };
}

/** UTF-8 byte length of a string (lone surrogates count as U+FFFD, i.e. 3 bytes, like TextEncoder). */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
