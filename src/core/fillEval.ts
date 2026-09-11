/**
 * Evaluation of region fills: solid colours, linear and radial gradients. The single implementation
 * shared by the gradient fitter (core/fillModel.ts), the label refiner (core/regions.ts refineLabels),
 * the rasteriser (metrics/scanline.ts) and the SVG emitter (svg/gradients.ts), so none of them can
 * diverge. Pure: never mutates its inputs (only the `out` arguments).
 *
 * Coordinate convention
 * ---------------------
 * Fills are expressed in continuous image coordinates where pixel (x, y) covers [x, x+1) × [y, y+1)
 * and is sampled at its centre (x + 0.5, y + 0.5). A fill fitted at 1× is in 1× units. The U× pixel
 * (X, Y) has its centre at ((X + 0.5)/U, (Y + 0.5)/U) in 1× units, so evaluating the 1× fill there is
 * the same as evaluating scaleFill(fill, U) at (X + 0.5, Y + 0.5): a 1× fill is emitted in viewBox
 * units (U×) by multiplying its coordinates and r by U, with no offset.
 *
 * Semantics (SVG 1.1, gradientUnits="userSpaceOnUse", spreadMethod="pad", no fx/fy):
 *   linear  t = ((x − x1)(x2 − x1) + (y − y1)(y2 − y1)) / |d|², clamped to [0, 1]; |d| = 0 → t = 1
 *   radial  t = hypot(x − cx, y − cy) / r, clamped to [0, 1]; r <= 0 → t = 1
 *   colour  linear interpolation in sRGB between the two stops around t; before the first stop the
 *           first colour, after the last stop the last colour. A degenerate geometry therefore paints
 *           its last stop, as SVG does.
 */
import type { Fill, Gradient, GradientStop, LinearGradient, RadialGradient, RGB } from '../types';

/** Below this length (|d| or r, in the gradient's units) a gradient's geometry is degenerate. */
export const DEGENERATE_EPS = 1e-6;
/** Stops whose colours all lie within this many levels (every channel) paint a flat colour. */
export const DEGENERATE_COLOR_SPAN = 1;

/** Ramp parameter of `g` at (x, y), in [0, 1] (pad). Degenerate geometry → 1; non-finite input → 0. */
export function gradientT(g: Gradient, x: number, y: number): number {
  let t: number;
  if (g.kind === 'linear') {
    const dx = g.x2 - g.x1;
    const dy = g.y2 - g.y1;
    const len2 = dx * dx + dy * dy;
    if (!(len2 > 0)) return 1;
    t = ((x - g.x1) * dx + (y - g.y1) * dy) / len2;
  } else {
    if (!(g.r > 0)) return 1;
    t = Math.hypot(x - g.cx, y - g.cy) / g.r;
  }
  return t > 0 ? (t < 1 ? t : 1) : 0;
}

function setColor(out: RGB, c: RGB): RGB {
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  return out;
}

/**
 * Colour of the ramp at t, written into `out` (returned). `stops` must be non-decreasing in offset
 * (normalizeStops). Between stops i and i+1 (offset_i <= t < offset_i+1) the colours are interpolated
 * linearly in sRGB; t at or below the first offset → first colour, at or above the last → last colour;
 * with several stops at one offset, t equal to it takes the later colour. No stops → black.
 */
export function stopColorAt(stops: readonly GradientStop[], t: number, out: RGB): RGB {
  const n = stops.length;
  if (n === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  // i = last stop with offset <= t (-1 when t is below every offset or NaN).
  let i = -1;
  while (i + 1 < n && stops[i + 1].offset <= t) i++;
  if (i < 0) return setColor(out, stops[0].color);
  if (i === n - 1) return setColor(out, stops[n - 1].color);
  const a = stops[i];
  const b = stops[i + 1];
  const u = (t - a.offset) / (b.offset - a.offset); // b.offset > t >= a.offset: the span is > 0
  const ca = a.color;
  const cb = b.color;
  out[0] = ca[0] + (cb[0] - ca[0]) * u;
  out[1] = ca[1] + (cb[1] - ca[1]) * u;
  out[2] = ca[2] + (cb[2] - ca[2]) * u;
  return out;
}

/** Colour of `f` at (x, y) (same units as the fill), written into `out` (returned). */
export function evaluateFill(f: Fill, x: number, y: number, out: RGB): RGB {
  if (f.kind === 'solid') return setColor(out, f.color);
  return stopColorAt(f.stops, gradientT(f, x, y), out);
}

function copyStops(stops: readonly GradientStop[]): GradientStop[] {
  return stops.map((s) => ({ offset: s.offset, color: [s.color[0], s.color[1], s.color[2]] }));
}

/** New gradient with its coordinates and r multiplied by `s` (> 0) and copied stops. */
export function scaleGradient(g: LinearGradient, s: number): LinearGradient;
export function scaleGradient(g: RadialGradient, s: number): RadialGradient;
export function scaleGradient(g: Gradient, s: number): Gradient;
export function scaleGradient(g: Gradient, s: number): Gradient {
  if (g.kind === 'linear') {
    return { kind: 'linear', x1: g.x1 * s, y1: g.y1 * s, x2: g.x2 * s, y2: g.y2 * s, stops: copyStops(g.stops) };
  }
  return { kind: 'radial', cx: g.cx * s, cy: g.cy * s, r: g.r * s, stops: copyStops(g.stops) };
}

/** scaleGradient for gradients; a copy for solid fills (a colour has no geometry). */
export function scaleFill(f: Fill, s: number): Fill {
  if (f.kind === 'solid') return { kind: 'solid', color: [f.color[0], f.color[1], f.color[2]] };
  return scaleGradient(f, s);
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/**
 * Mean colour of the ramp itself, independent of any area: the integral over t in [0, 1] of the stop
 * interpolation (constant first colour up to the first offset, trapezoids between stops, constant last
 * colour after the last offset). Not rounded. No stops → black. A 0 → 255 ramp gives 127.5.
 */
export function gradientMeanColor(g: Gradient): RGB {
  const stops = g.stops;
  const out: RGB = [0, 0, 0];
  if (stops.length === 0) return out;
  for (let k = 0; k < 3; k++) {
    let prevO = clamp01(stops[0].offset);
    let prevC = stops[0].color[k];
    let sum = prevO * prevC;
    for (let i = 1; i < stops.length; i++) {
      let o = clamp01(stops[i].offset);
      if (o < prevO) o = prevO;
      const c = stops[i].color[k];
      sum += ((o - prevO) * (prevC + c)) / 2;
      prevO = o;
      prevC = c;
    }
    out[k] = sum + (1 - prevO) * prevC;
  }
  return out;
}

/**
 * True when the gradient paints (at most) one flat colour or cannot be drawn: fewer than 2 stops,
 * non-finite geometry, |d| < DEGENERATE_EPS (linear) or r < DEGENERATE_EPS (radial), or every channel of
 * every stop within DEGENERATE_COLOR_SPAN level of the others. Such a gradient becomes a solid fill.
 */
export function isDegenerateGradient(g: Gradient): boolean {
  const stops = g.stops;
  if (stops.length < 2) return true;
  if (g.kind === 'linear') {
    if (!Number.isFinite(g.x1) || !Number.isFinite(g.y1) || !Number.isFinite(g.x2) || !Number.isFinite(g.y2)) return true;
    if (!(Math.hypot(g.x2 - g.x1, g.y2 - g.y1) >= DEGENERATE_EPS)) return true;
  } else {
    if (!Number.isFinite(g.cx) || !Number.isFinite(g.cy) || !Number.isFinite(g.r)) return true;
    if (!(g.r >= DEGENERATE_EPS)) return true;
  }
  for (let k = 0; k < 3; k++) {
    let lo = stops[0].color[k];
    let hi = lo;
    for (let i = 1; i < stops.length; i++) {
      const c = stops[i].color[k];
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
    if (hi - lo > DEGENERATE_COLOR_SPAN) return false;
  }
  return true;
}

function clampChannel(v: number): number {
  return v > 0 ? (v < 255 ? v : 255) : 0; // NaN → 0
}

/**
 * Stops ready to evaluate and serialise: offsets clamped to [0, 1] (non-finite → 0) and raised to be
 * non-decreasing, colours clamped to [0, 255] (non-finite → 0; not rounded: the SVG hex rounds, <= 0.5
 * level). Two stops at one offset are kept: a hard stop, drawn by stopColorAt and by SVG as a jump from
 * the first colour to the second. In a run of three or more stops at one offset only the first and the
 * last are kept (the ones between are never visible). New objects; the input is not modified.
 */
export function normalizeStops(stops: readonly GradientStop[]): GradientStop[] {
  const out: GradientStop[] = [];
  let prev = 0;
  for (const s of stops) {
    let o = Number.isFinite(s.offset) ? clamp01(s.offset) : 0;
    if (o < prev) o = prev;
    const stop: GradientStop = {
      offset: o,
      color: [clampChannel(s.color[0]), clampChannel(s.color[1]), clampChannel(s.color[2])],
    };
    const k = out.length;
    if (k >= 2 && out[k - 1].offset === o && out[k - 2].offset === o) out[k - 1] = stop;
    else out.push(stop);
    prev = o;
  }
  return out;
}
