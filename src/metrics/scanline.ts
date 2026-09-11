/**
 * Reference polygon rasteriser (ground truth for tests and the auto-tuner). Pure TypeScript,
 * no DOM. Nonzero winding, S sub-scanlines per pixel row (default 4) with exact horizontal span
 * coverage, so axis-aligned integer rectangles are pixel-exact and edges get fractional
 * coverage. Never mutates inputs.
 */
import type { AbsPath, Gradient, GradientStop, GrayImage, Layer, RasterImage, RGB } from '../types';
import { gradientT, isDegenerateGradient, stopColorAt } from '../core/fillEval';

type Pt = [number, number];

/** Maximum recursion depth of the adaptive Bézier subdivision (<= 2^16 points per curve). */
const MAX_DEPTH = 16;
const DEFAULT_TOLERANCE = 0.1;
const DEFAULT_SUPERSAMPLE = 4;
const MAX_SUPERSAMPLE = 64;
/** Fewest steps of a gradient colour LUT (256 entries, t step 1/255). */
const GRADIENT_LUT_MIN_STEPS = 255;
/** Most steps of a gradient colour LUT; a steeper ramp is evaluated exactly per pixel instead. */
const GRADIENT_LUT_MAX_STEPS = 4095;

function pushPt(out: Pt[], x: number, y: number): void {
  const n = out.length;
  if (n > 0) {
    const last = out[n - 1];
    if (last[0] === x && last[1] === y) return;
  }
  out.push([x, y]);
}

/**
 * Quadratic: the deviation from the chord is at most |P0 - 2P1 + P2| / 4, so the curve is flat
 * when |P0 - 2P1 + P2|^2 <= 16 tol^2. Non-finite input counts as flat (no runaway recursion).
 */
function flattenQuad(
  out: Pt[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  tol16: number,
  depth: number,
): void {
  const dx = x0 - 2 * x1 + x2;
  const dy = y0 - 2 * y1 + y2;
  const m = dx * dx + dy * dy;
  // Flat when within tolerance; also stop on NaN / Infinity (garbage in, no runaway recursion).
  if (depth >= MAX_DEPTH || !(m > tol16 && m < Number.POSITIVE_INFINITY)) {
    pushPt(out, x2, y2);
    return;
  }
  const x01 = (x0 + x1) * 0.5;
  const y01 = (y0 + y1) * 0.5;
  const x12 = (x1 + x2) * 0.5;
  const y12 = (y1 + y2) * 0.5;
  const xm = (x01 + x12) * 0.5;
  const ym = (y01 + y12) * 0.5;
  flattenQuad(out, x0, y0, x01, y01, xm, ym, tol16, depth + 1);
  flattenQuad(out, xm, ym, x12, y12, x2, y2, tol16, depth + 1);
}

/**
 * Cubic: B(t) - L(t) = t(1-t)[(1-t)u + t v] with u = 3P1 - 2P0 - P3, v = 3P2 - 2P3 - P0, so the
 * distance to the chord is bounded by sqrt(max(ux²,vx²) + max(uy²,vy²)) / 4 (Willcocks).
 */
function flattenCubic(
  out: Pt[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tol16: number,
  depth: number,
): void {
  const ux = 3 * x1 - 2 * x0 - x3;
  const uy = 3 * y1 - 2 * y0 - y3;
  const vx = 3 * x2 - 2 * x3 - x0;
  const vy = 3 * y2 - 2 * y3 - y0;
  const ux2 = ux * ux;
  const vx2 = vx * vx;
  const uy2 = uy * uy;
  const vy2 = vy * vy;
  // Math.max propagates NaN (a ternary would silently pick the finite operand).
  const m = Math.max(ux2, vx2) + Math.max(uy2, vy2);
  if (depth >= MAX_DEPTH || !(m > tol16 && m < Number.POSITIVE_INFINITY)) {
    pushPt(out, x3, y3);
    return;
  }
  const x01 = (x0 + x1) * 0.5;
  const y01 = (y0 + y1) * 0.5;
  const x12 = (x1 + x2) * 0.5;
  const y12 = (y1 + y2) * 0.5;
  const x23 = (x2 + x3) * 0.5;
  const y23 = (y2 + y3) * 0.5;
  const x012 = (x01 + x12) * 0.5;
  const y012 = (y01 + y12) * 0.5;
  const x123 = (x12 + x23) * 0.5;
  const y123 = (y12 + y23) * 0.5;
  const xm = (x012 + x123) * 0.5;
  const ym = (y012 + y123) * 0.5;
  flattenCubic(out, x0, y0, x01, y01, x012, y012, xm, ym, tol16, depth + 1);
  flattenCubic(out, xm, ym, x123, y123, x23, y23, x3, y3, tol16, depth + 1);
}

/** Drop a trailing copy of the first vertex (explicit close) and keep polylines with >= 2 points. */
function finishPoly(out: Pt[][], poly: Pt[] | null): void {
  if (!poly) return;
  while (poly.length > 1) {
    const first = poly[0];
    const last = poly[poly.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) poly.pop();
    else break;
  }
  if (poly.length >= 2) out.push(poly);
}

/**
 * One closed polyline per subpath (the closing edge last -> first is implicit, never
 * duplicated). Q/C segments are subdivided adaptively until they deviate <= `tolerance` px
 * (default 0.1) from their chord, recursion capped at depth 16. A drawing segment after Z (or
 * without any M) starts a new subpath at the current point, as in SVG. Subpaths with fewer than
 * two distinct points are dropped. Consecutive duplicate vertices are merged.
 */
export function flattenPath(p: AbsPath, tolerance = DEFAULT_TOLERANCE): Pt[][] {
  const tol = tolerance > 0 ? tolerance : DEFAULT_TOLERANCE;
  const tol16 = 16 * tol * tol;
  const out: Pt[][] = [];
  let cur: Pt[] | null = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const segs = p.segs;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    switch (s.kind) {
      case 'M':
        finishPoly(out, cur);
        cur = [[s.x, s.y]];
        cx = sx = s.x;
        cy = sy = s.y;
        break;
      case 'L':
        if (cur === null) cur = [[cx, cy]];
        pushPt(cur, s.x, s.y);
        cx = s.x;
        cy = s.y;
        break;
      case 'Q':
        if (cur === null) cur = [[cx, cy]];
        flattenQuad(cur, cx, cy, s.x1, s.y1, s.x, s.y, tol16, 0);
        cx = s.x;
        cy = s.y;
        break;
      case 'C':
        if (cur === null) cur = [[cx, cy]];
        flattenCubic(cur, cx, cy, s.x1, s.y1, s.x2, s.y2, s.x, s.y, tol16, 0);
        cx = s.x;
        cy = s.y;
        break;
      case 'Z':
        finishPoly(out, cur);
        cur = null;
        cx = sx;
        cy = sy;
        break;
    }
  }
  finishPoly(out, cur);
  return out;
}

function resolveSupersample(supersample: number): number {
  let S = Math.floor(supersample);
  if (!(S >= 1)) S = DEFAULT_SUPERSAMPLE;
  if (S > MAX_SUPERSAMPLE) S = MAX_SUPERSAMPLE;
  return S;
}

/**
 * Add the coverage of the half-open span [xa, xb) on one sub-scanline to `acc` (row starting at
 * `base`, `w` pixels wide). Units: fraction of a sub-scanline (1 = the pixel is fully covered
 * on this sub-scanline).
 */
function fillSpan(acc: Float32Array, base: number, w: number, xa: number, xb: number): void {
  if (xa < 0) xa = 0;
  if (xb > w) xb = w;
  if (!(xb > xa)) return;
  const ia = xa | 0; // floor, xa >= 0 and < w
  const ib = xb | 0; // floor, <= w
  if (ia === ib) {
    acc[base + ia] += xb - xa;
    return;
  }
  acc[base + ia] += ia + 1 - xa;
  for (let x = ia + 1; x < ib; x++) acc[base + x] += 1;
  if (ib < w) acc[base + ib] += xb - ib;
}

/**
 * Coverage 0..255 (Float32) of the union of `paths` under the nonzero winding rule.
 * For each of the S sub-scanlines per pixel row (y = (j + 0.5) / S) the crossings with every
 * non-horizontal edge are computed with the half-open convention (edge active when
 * ymin <= y < ymax), sorted by x, and the spans where the winding number is non-zero are
 * accumulated with exact horizontal coverage. Coordinates outside the image are clipped.
 */
export function rasterizeMask(
  paths: AbsPath[],
  width: number,
  height: number,
  supersample = DEFAULT_SUPERSAMPLE,
): GrayImage {
  const w = width > 0 ? Math.floor(width) : 0;
  const h = height > 0 ? Math.floor(height) : 0;
  const acc = new Float32Array(w * h);
  const result: GrayImage = { data: acc, width: w, height: h };
  if (w === 0 || h === 0) return result;
  const S = resolveSupersample(supersample);

  // 1. Flatten every subpath and count usable edges (non-horizontal, finite, crossing [0, h)).
  const polys: Pt[][] = [];
  for (let i = 0; i < paths.length; i++) {
    const flat = flattenPath(paths[i]);
    for (let k = 0; k < flat.length; k++) polys.push(flat[k]);
  }
  let E = 0;
  for (let k = 0; k < polys.length; k++) {
    const poly = polys[k];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[i + 1 === n ? 0 : i + 1];
      if (edgeUsable(a[0], a[1], b[0], b[1], h)) E++;
    }
  }
  if (E === 0) return result;

  // 2. Edge table: y range, x at ymin, dx/dy and winding direction.
  const eYmin = new Float64Array(E);
  const eYmax = new Float64Array(E);
  const eX = new Float64Array(E);
  const eDxdy = new Float64Array(E);
  const eDir = new Int8Array(E);
  let e = 0;
  for (let k = 0; k < polys.length; k++) {
    const poly = polys[k];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[i + 1 === n ? 0 : i + 1];
      if (!edgeUsable(a[0], a[1], b[0], b[1], h)) continue;
      if (a[1] < b[1]) {
        eYmin[e] = a[1];
        eYmax[e] = b[1];
        eX[e] = a[0];
        eDxdy[e] = (b[0] - a[0]) / (b[1] - a[1]);
        eDir[e] = 1;
      } else {
        eYmin[e] = b[1];
        eYmax[e] = a[1];
        eX[e] = b[0];
        eDxdy[e] = (a[0] - b[0]) / (a[1] - b[1]);
        eDir[e] = -1;
      }
      e++;
    }
  }

  // 3. Bucket edges by the sub-scanline where they (may) start. floor() gives a bucket at or
  //    one before the true first sample; late edges are deferred one line at activation time.
  const L = h * S;
  const head = new Int32Array(L).fill(-1);
  const next = new Int32Array(E);
  for (e = 0; e < E; e++) {
    let j = Math.floor(eYmin[e] * S - 0.5);
    if (j < 0) j = 0;
    else if (j >= L) j = L - 1; // cannot happen (ymin < h) but keeps the index safe
    next[e] = head[j];
    head[j] = e;
  }

  // 4. Sweep.
  const active = new Int32Array(E);
  const xs = new Float64Array(E);
  let nA = 0;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let k = 0; k < S; k++) {
      const j = y * S + k;
      const sy = (j + 0.5) / S;
      // Retire edges that ended above this sample line (half-open: y < ymax).
      let m = 0;
      for (let i = 0; i < nA; i++) {
        const ei = active[i];
        if (eYmax[ei] > sy) active[m++] = ei;
      }
      nA = m;
      // Activate the edges bucketed on this line (deferring those that start below it).
      let ei = head[j];
      head[j] = -1;
      while (ei !== -1) {
        const nx = next[ei];
        if (eYmin[ei] <= sy) {
          if (eYmax[ei] > sy) active[nA++] = ei;
        } else if (j + 1 < L) {
          next[ei] = head[j + 1];
          head[j + 1] = ei;
        }
        ei = nx;
      }
      if (nA < 2) continue;
      // Crossings, sorted by x (insertion sort: the list is nearly sorted between lines).
      for (let i = 0; i < nA; i++) {
        const ec = active[i];
        xs[i] = eX[ec] + (sy - eYmin[ec]) * eDxdy[ec];
      }
      for (let i = 1; i < nA; i++) {
        const xv = xs[i];
        const ev = active[i];
        let t = i - 1;
        while (t >= 0 && xs[t] > xv) {
          xs[t + 1] = xs[t];
          active[t + 1] = active[t];
          t--;
        }
        xs[t + 1] = xv;
        active[t + 1] = ev;
      }
      // Nonzero winding spans.
      let wind = 0;
      let spanStart = 0;
      for (let i = 0; i < nA; i++) {
        const before = wind;
        wind += eDir[active[i]];
        if (before === 0) {
          if (wind !== 0) spanStart = xs[i];
        } else if (wind === 0) {
          fillSpan(acc, base, w, spanStart, xs[i]);
        }
      }
    }
  }

  // 5. Scale sub-scanline fractions to 0..255 (S * 255 / S == 255 exactly for full pixels).
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const v = (acc[i] * 255) / S;
    acc[i] = v > 255 ? 255 : v;
  }
  return result;
}

/** Non-horizontal, finite, and intersecting the vertical range [0, h). */
function edgeUsable(x0: number, y0: number, x1: number, y1: number, h: number): boolean {
  if (y0 === y1) return false;
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
    return false;
  }
  const ymin = y0 < y1 ? y0 : y1;
  const ymax = y0 < y1 ? y1 : y0;
  return ymax > 0 && ymin < h;
}

/** '#rrggbb' or '#rgb' (case-insensitive) -> RGB. Throws on anything else. */
function parseFill(fill: string): RGB {
  const s = fill.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) {
    return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  }
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = parseInt(s[1], 16);
    const g = parseInt(s[2], 16);
    const b = parseInt(s[3], 16);
    return [r * 17, g * 17, b * 17];
  }
  throw new Error(`rasterizeLayers: color de relleno no válido: "${fill}"`);
}

function clampLevel(v: number): number {
  return v > 0 ? (v < 255 ? v : 255) : 0; // NaN -> 0
}

interface GradientLut {
  /** (steps + 1) RGB triplets: entry k = the ramp at t = k / steps, clamped to 0..255. */
  rgb: Float32Array;
  steps: number;
}

/**
 * Colour lookup table of a gradient ramp, sampled with stopColorAt (core/fillEval). steps =
 * max(255, ceil(s)), s = the steepest colour change between consecutive stops in levels per unit of
 * t, so the entry nearest to any t is within s / (2 steps) <= 0.5 level of the exact colour (a
 * 2-stop 0 -> 255 ramp gets the plain 256 entries). Null, and the caller evaluates every pixel
 * exactly, when that needs more than GRADIENT_LUT_MAX_STEPS steps or when the ramp may jump: a
 * non-finite value, a decreasing offset, or a colour change over a zero offset span.
 */
function gradientLut(stops: readonly GradientStop[]): GradientLut | null {
  let slope = 0;
  for (let i = 0; i < stops.length; i++) {
    const b = stops[i];
    if (!Number.isFinite(b.offset)) return null;
    for (let k = 0; k < 3; k++) if (!Number.isFinite(b.color[k])) return null;
    if (i === 0) continue;
    const a = stops[i - 1];
    const span = b.offset - a.offset;
    if (span < 0) return null;
    let change = 0;
    for (let k = 0; k < 3; k++) change = Math.max(change, Math.abs(b.color[k] - a.color[k]));
    if (change === 0) continue;
    if (span === 0) return null;
    slope = Math.max(slope, change / span);
  }
  const steps = Math.max(GRADIENT_LUT_MIN_STEPS, Math.ceil(slope));
  if (!(steps <= GRADIENT_LUT_MAX_STEPS)) return null;
  const rgb = new Float32Array((steps + 1) * 3);
  const c: RGB = [0, 0, 0];
  for (let k = 0, o = 0; k <= steps; k++, o += 3) {
    stopColorAt(stops, k / steps, c);
    rgb[o] = clampLevel(c[0]);
    rgb[o + 1] = clampLevel(c[1]);
    rgb[o + 2] = clampLevel(c[2]);
  }
  return { rgb, steps };
}

/**
 * Blends one gradient layer into the premultiplied accumulators, like a solid fill but with the
 * colour of pixel (x, y) = the ramp at gradientT(g, x + 0.5, y + 0.5) (the gradient is in the
 * raster's own units), read from the nearest gradientLut entry or, without a LUT, from stopColorAt;
 * channels clamped to 0..255 (what an SVG stop-color can hold). `accA` is null over an opaque
 * background (alpha stays 1).
 */
function blendGradient(
  g: Gradient,
  cov: Float32Array,
  w: number,
  h: number,
  scale: number,
  accR: Float32Array,
  accG: Float32Array,
  accB: Float32Array,
  accA: Float32Array | null,
): void {
  const lut = gradientLut(g.stops);
  // A local reference: a per-call module binding lookup (vitest's SSR transform) costs 1.98x instead of 1.41x.
  const tAt = gradientT;
  if (lut === null) {
    const c: RGB = [0, 0, 0];
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const cy = y + 0.5;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const cv = cov[i];
        if (cv === 0) continue;
        stopColorAt(g.stops, tAt(g, x + 0.5, cy), c);
        const a = cv * scale;
        const ia = 1 - a;
        accR[i] = clampLevel(c[0]) * a + accR[i] * ia;
        accG[i] = clampLevel(c[1]) * a + accG[i] * ia;
        accB[i] = clampLevel(c[2]) * a + accB[i] * ia;
        if (accA !== null) accA[i] = a + accA[i] * ia;
      }
    }
    return;
  }
  const rgb = lut.rgb;
  const steps = lut.steps;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const cy = y + 0.5;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const cv = cov[i];
      if (cv === 0) continue;
      const o = ((tAt(g, x + 0.5, cy) * steps + 0.5) | 0) * 3; // t in [0, 1]
      const a = cv * scale;
      const ia = 1 - a;
      accR[i] = rgb[o] * a + accR[i] * ia;
      accG[i] = rgb[o + 1] * a + accG[i] * ia;
      accB[i] = rgb[o + 2] * a + accB[i] * ia;
      if (accA !== null) accA[i] = a + accA[i] * ia;
    }
  }
}

/**
 * Composite `layers` back to front (first = bottom) over an opaque `background`, or over
 * transparency when it is null. Per layer a = coverage/255 * opacity and
 * out = fill * a + out * (1 - a). With a null background the alpha channel is the union
 * coverage (a + alpha * (1 - a)) and the colours are stored straight (un-premultiplied), so the
 * result composites correctly over any colour later. Values rounded to the nearest byte.
 * A layer with a non-degenerate `gradient` (isDegenerateGradient) takes its per-pixel colour from
 * it (blendGradient, within 1 level of evaluateFill at the pixel centre); a degenerate one paints
 * `fill`. Every layer's `fill` must be a hex colour, gradient or not.
 */
export function rasterizeLayers(
  layers: Layer[],
  width: number,
  height: number,
  background: RGB | null,
  supersample = DEFAULT_SUPERSAMPLE,
): RasterImage {
  const w = width > 0 ? Math.floor(width) : 0;
  const h = height > 0 ? Math.floor(height) : 0;
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const result: RasterImage = { data: out, width: w, height: h };
  // Premultiplied float accumulators (alpha is 1 everywhere when a background is given).
  const accR = new Float32Array(n);
  const accG = new Float32Array(n);
  const accB = new Float32Array(n);
  const accA = new Float32Array(n);
  const opaque = background !== null;
  if (opaque) {
    accR.fill(background[0]);
    accG.fill(background[1]);
    accB.fill(background[2]);
    accA.fill(1);
  }
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const [fr, fg, fb] = parseFill(layer.fill);
    let op = layer.opacity === undefined ? 1 : layer.opacity;
    if (!(op > 0)) continue;
    if (op > 1) op = 1;
    if (n === 0 || layer.paths.length === 0) continue;
    const cov = rasterizeMask(layer.paths, w, h, supersample).data;
    const scale = op / 255;
    const gradient = layer.gradient;
    if (gradient !== undefined && !isDegenerateGradient(gradient)) {
      blendGradient(gradient, cov, w, h, scale, accR, accG, accB, opaque ? null : accA);
      continue;
    }
    for (let i = 0; i < n; i++) {
      const c = cov[i];
      if (c === 0) continue;
      const a = c * scale;
      const ia = 1 - a;
      accR[i] = fr * a + accR[i] * ia;
      accG[i] = fg * a + accG[i] * ia;
      accB[i] = fb * a + accB[i] * ia;
      if (!opaque) accA[i] = a + accA[i] * ia;
    }
  }
  if (opaque) {
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      out[o] = accR[i];
      out[o + 1] = accG[i];
      out[o + 2] = accB[i];
      out[o + 3] = 255;
    }
  } else {
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const a = accA[i];
      if (a <= 0) continue; // stays (0,0,0,0)
      out[o] = accR[i] / a;
      out[o + 1] = accG[i] / a;
      out[o + 2] = accB[i] / a;
      out[o + 3] = a * 255;
    }
  }
  return result;
}
