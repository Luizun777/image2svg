/**
 * SVG path-data parser producing absolute segments (see `AbsPath` / `Seg` in ../types).
 *
 * Supported commands: M/m L/l H/h V/v C/c S/s Q/q T/t Z/z with implicit repeats
 * (after M the repeats are LineTo, per the SVG spec). H/V become L; S/T are expanded
 * to C/Q with the reflected control point. After Z the current point returns to the
 * subpath start; if a drawing command follows Z without an explicit M, an implicit
 * `M start` segment is emitted so every subpath in the result begins with an M.
 *
 * Numbers: optional sign, digits, optional fraction, optional exponent. "3.5.5" is two
 * numbers, "-.5" and "1e-3" are valid, commas and whitespace separate tokens.
 * Unsupported commands (A/a, …) or malformed data throw an Error.
 *
 * Pure: never mutates its inputs.
 */
import type { AbsPath, Seg } from '../types';

// ---- char codes -------------------------------------------------------------------------
const C_TAB = 9;
const C_LF = 10;
const C_FF = 12;
const C_CR = 13;
const C_SPACE = 32;
const C_PLUS = 43;
const C_COMMA = 44;
const C_MINUS = 45;
const C_DOT = 46;
const C_0 = 48;
const C_9 = 57;
const C_E = 69;
const C_e = 101;
const C_C = 67;
const C_H = 72;
const C_L = 76;
const C_M = 77;
const C_Q = 81;
const C_S = 83;
const C_T = 84;
const C_V = 86;
const C_Z = 90;
const C_c = 99;
const C_h = 104;
const C_l = 108;
const C_m = 109;
const C_q = 113;
const C_s = 115;
const C_t = 116;
const C_v = 118;
const C_z = 122;

/** Exact powers of ten (10^0 … 10^22 are all representable as doubles). */
const POW10: readonly number[] = [
  1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16,
  1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
];

function isSeparator(c: number): boolean {
  return c === C_SPACE || c === C_COMMA || c === C_LF || c === C_CR || c === C_TAB || c === C_FF;
}

/** Number of arguments a command takes; 0 for Z; -1 for unknown letters. */
function arity(cmd: number): number {
  switch (cmd) {
    case C_M:
    case C_m:
    case C_L:
    case C_l:
    case C_T:
    case C_t:
      return 2;
    case C_H:
    case C_h:
    case C_V:
    case C_v:
      return 1;
    case C_C:
    case C_c:
      return 6;
    case C_S:
    case C_s:
    case C_Q:
    case C_q:
      return 4;
    case C_Z:
    case C_z:
      return 0;
    default:
      return -1;
  }
}

/**
 * Scratch slot for `scanNumber` (module-private; JS is single-threaded per realm, and the
 * value is consumed immediately after each call). Avoids allocating a result object per number.
 */
let scannedValue = 0;

/**
 * Scans one number token starting at `i` (d[i] must be a sign, digit or '.').
 * Returns the index just past the token, or -1 when no valid number starts at `i`.
 * The parsed value is left in `scannedValue`.
 *
 * Fast path (Clinger): when the mantissa has <= 15 significant digits and the decimal
 * exponent is within ±22 the value is `mant * 10^e` or `mant / 10^-e` — both operands are
 * exact doubles, so the single rounding matches `Number()` bit for bit. Otherwise it falls
 * back to `Number(slice)`.
 */
function scanNumber(d: string, i: number): number {
  const start = i;
  let c = d.charCodeAt(i);
  let negative = false;
  if (c === C_MINUS || c === C_PLUS) {
    negative = c === C_MINUS;
    i++;
    c = d.charCodeAt(i);
  }
  let mant = 0;
  let sig = 0; // significant digits folded into `mant`
  let digits = 0; // total digits seen (int + frac), to reject "." / "-"
  let fracDigits = 0;
  let inexact = false; // too many significant digits for the fast path
  while (c >= C_0 && c <= C_9) {
    if (mant !== 0 || c !== C_0) {
      if (sig < 15) {
        mant = mant * 10 + (c - C_0);
        sig++;
      } else {
        inexact = true;
      }
    }
    digits++;
    i++;
    c = d.charCodeAt(i);
  }
  if (c === C_DOT) {
    i++;
    c = d.charCodeAt(i);
    while (c >= C_0 && c <= C_9) {
      if (mant !== 0 || c !== C_0) {
        if (sig < 15) {
          mant = mant * 10 + (c - C_0);
          sig++;
        } else {
          inexact = true;
        }
      }
      digits++;
      fracDigits++;
      i++;
      c = d.charCodeAt(i);
    }
  }
  if (digits === 0) return -1;

  let exp = 0;
  if (c === C_e || c === C_E) {
    let j = i + 1;
    let ec = d.charCodeAt(j);
    let expNegative = false;
    if (ec === C_MINUS || ec === C_PLUS) {
      expNegative = ec === C_MINUS;
      j++;
      ec = d.charCodeAt(j);
    }
    if (ec >= C_0 && ec <= C_9) {
      while (ec >= C_0 && ec <= C_9) {
        if (exp < 100000) exp = exp * 10 + (ec - C_0);
        j++;
        ec = d.charCodeAt(j);
      }
      if (expNegative) exp = -exp;
      i = j;
    }
    // An 'e' not followed by digits is not part of the number; the caller will reject it.
  }

  const e10 = exp - fracDigits;
  if (!inexact && e10 >= -22 && e10 <= 22) {
    const value = e10 >= 0 ? mant * POW10[e10] : mant / POW10[-e10];
    scannedValue = negative ? -value : value;
  } else {
    // Slow path; the slice already carries the sign.
    scannedValue = Number(d.slice(start, i));
  }
  return i;
}

export function parsePathData(d: string): AbsPath {
  const segs: Seg[] = [];
  const len = d.length;
  const args = new Float64Array(6);
  let i = 0;
  let cmd = 0; // current command char code (0 = none yet)
  let cx = 0;
  let cy = 0; // current point
  let sx = 0;
  let sy = 0; // start of the current subpath
  let px = 0;
  let py = 0; // last control point (for S/T reflection)
  let prev = 0; // C_C / C_Q when the previous segment was cubic/quadratic, else 0
  let started = false; // an M has been seen
  let needMove = true; // at start and after Z: next drawing command needs an (implicit) M

  while (i < len) {
    const c = d.charCodeAt(i);
    if (isSeparator(c)) {
      i++;
      continue;
    }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      cmd = c;
      i++;
      const n = arity(cmd);
      if (n < 0) {
        throw new Error(`parsePathData: unsupported command "${d[i - 1]}" at index ${i - 1}`);
      }
      if (n === 0) {
        if (!started) throw new Error('parsePathData: path data must start with M');
        segs.push({ kind: 'Z' });
        cx = sx;
        cy = sy;
        prev = 0;
        needMove = true;
        continue;
      }
    } else if (cmd === 0) {
      throw new Error(`parsePathData: number before any command at index ${i}`);
    } else if (cmd === C_Z || cmd === C_z) {
      throw new Error(`parsePathData: coordinates after Z at index ${i}`);
    } else if (cmd === C_M) {
      cmd = C_L; // implicit repeats after M are LineTo
    } else if (cmd === C_m) {
      cmd = C_l;
    }

    const n = arity(cmd);
    for (let k = 0; k < n; k++) {
      while (i < len && isSeparator(d.charCodeAt(i))) i++;
      const end = i < len ? scanNumber(d, i) : -1;
      if (end < 0) {
        throw new Error(
          `parsePathData: expected number at index ${i} (command "${String.fromCharCode(cmd)}")`,
        );
      }
      args[k] = scannedValue;
      i = end;
    }

    if (needMove && cmd !== C_M && cmd !== C_m) {
      if (!started) throw new Error('parsePathData: path data must start with M');
      // Drawing command right after Z: the spec starts a new subpath at the previous start.
      segs.push({ kind: 'M', x: sx, y: sy });
      needMove = false;
    }

    switch (cmd) {
      case C_M:
      case C_m: {
        if (cmd === C_m) {
          cx += args[0];
          cy += args[1];
        } else {
          cx = args[0];
          cy = args[1];
        }
        sx = cx;
        sy = cy;
        segs.push({ kind: 'M', x: cx, y: cy });
        prev = 0;
        started = true;
        needMove = false;
        break;
      }
      case C_L:
      case C_l: {
        if (cmd === C_l) {
          cx += args[0];
          cy += args[1];
        } else {
          cx = args[0];
          cy = args[1];
        }
        segs.push({ kind: 'L', x: cx, y: cy });
        prev = 0;
        break;
      }
      case C_H:
      case C_h: {
        cx = cmd === C_h ? cx + args[0] : args[0];
        segs.push({ kind: 'L', x: cx, y: cy });
        prev = 0;
        break;
      }
      case C_V:
      case C_v: {
        cy = cmd === C_v ? cy + args[0] : args[0];
        segs.push({ kind: 'L', x: cx, y: cy });
        prev = 0;
        break;
      }
      case C_C:
      case C_c: {
        const ox = cmd === C_c ? cx : 0;
        const oy = cmd === C_c ? cy : 0;
        const x1 = ox + args[0];
        const y1 = oy + args[1];
        const x2 = ox + args[2];
        const y2 = oy + args[3];
        cx = ox + args[4];
        cy = oy + args[5];
        segs.push({ kind: 'C', x1, y1, x2, y2, x: cx, y: cy });
        px = x2;
        py = y2;
        prev = C_C;
        break;
      }
      case C_S:
      case C_s: {
        const ox = cmd === C_s ? cx : 0;
        const oy = cmd === C_s ? cy : 0;
        // First control point: reflection of the previous cubic's second control point
        // about the current point, or the current point itself when there is none.
        const x1 = prev === C_C ? 2 * cx - px : cx;
        const y1 = prev === C_C ? 2 * cy - py : cy;
        const x2 = ox + args[0];
        const y2 = oy + args[1];
        cx = ox + args[2];
        cy = oy + args[3];
        segs.push({ kind: 'C', x1, y1, x2, y2, x: cx, y: cy });
        px = x2;
        py = y2;
        prev = C_C;
        break;
      }
      case C_Q:
      case C_q: {
        const ox = cmd === C_q ? cx : 0;
        const oy = cmd === C_q ? cy : 0;
        const x1 = ox + args[0];
        const y1 = oy + args[1];
        cx = ox + args[2];
        cy = oy + args[3];
        segs.push({ kind: 'Q', x1, y1, x: cx, y: cy });
        px = x1;
        py = y1;
        prev = C_Q;
        break;
      }
      case C_T:
      case C_t: {
        const ox = cmd === C_t ? cx : 0;
        const oy = cmd === C_t ? cy : 0;
        const x1 = prev === C_Q ? 2 * cx - px : cx;
        const y1 = prev === C_Q ? 2 * cy - py : cy;
        cx = ox + args[0];
        cy = oy + args[1];
        segs.push({ kind: 'Q', x1, y1, x: cx, y: cy });
        px = x1;
        py = y1;
        prev = C_Q;
        break;
      }
      default:
        // unreachable: arity() already rejected unknown commands
        throw new Error(`parsePathData: unsupported command "${String.fromCharCode(cmd)}"`);
    }
  }
  return { segs };
}

export interface PathTransform {
  tx?: number;
  ty?: number;
  sx?: number;
  sy?: number;
}

/** x' = x*sx + tx ; y' = y*sy + ty for every coordinate, control points included. Returns a new path. */
export function applyTransform(p: AbsPath, t: PathTransform): AbsPath {
  const sx = t.sx ?? 1;
  const sy = t.sy ?? 1;
  const tx = t.tx ?? 0;
  const ty = t.ty ?? 0;
  const src = p.segs;
  const out: Seg[] = new Array<Seg>(src.length);
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    switch (s.kind) {
      case 'M':
        out[i] = { kind: 'M', x: s.x * sx + tx, y: s.y * sy + ty };
        break;
      case 'L':
        out[i] = { kind: 'L', x: s.x * sx + tx, y: s.y * sy + ty };
        break;
      case 'Q':
        out[i] = {
          kind: 'Q',
          x1: s.x1 * sx + tx,
          y1: s.y1 * sy + ty,
          x: s.x * sx + tx,
          y: s.y * sy + ty,
        };
        break;
      case 'C':
        out[i] = {
          kind: 'C',
          x1: s.x1 * sx + tx,
          y1: s.y1 * sy + ty,
          x2: s.x2 * sx + tx,
          y2: s.y2 * sy + ty,
          x: s.x * sx + tx,
          y: s.y * sy + ty,
        };
        break;
      case 'Z':
        out[i] = { kind: 'Z' };
        break;
    }
  }
  return { segs: out };
}

const TRANSFORM_FN_RE = /(translate|scale)\s*\(([^)]*)\)/g;

/**
 * Parses a `transform` attribute containing only translate()/scale() functions, composing
 * them left-to-right as the SVG spec does (the right-most function applies first), into the
 * axis-aligned affine {sx, sy, tx, ty} consumed by `applyTransform`. Any other function
 * (rotate, matrix, skew…) is ignored. Missing/empty → identity.
 */
export function parseTransform(attr: string): { tx: number; ty: number; sx: number; sy: number } {
  let sx = 1;
  let sy = 1;
  let tx = 0;
  let ty = 0;
  const re = new RegExp(TRANSFORM_FN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(attr)) !== null) {
    const parts = m[2].trim().split(/[\s,]+/).filter((s) => s.length > 0);
    const a = parts.length > 0 ? Number(parts[0]) : NaN;
    if (!Number.isFinite(a)) continue;
    if (m[1] === 'translate') {
      const b = parts.length > 1 ? Number(parts[1]) : 0;
      if (!Number.isFinite(b)) continue;
      // M ∘ translate(a,b): p ↦ M(p + (a,b))
      tx += sx * a;
      ty += sy * b;
    } else {
      const b = parts.length > 1 ? Number(parts[1]) : a;
      if (!Number.isFinite(b)) continue;
      // M ∘ scale(a,b)
      sx *= a;
      sy *= b;
    }
  }
  return { tx, ty, sx, sy };
}
