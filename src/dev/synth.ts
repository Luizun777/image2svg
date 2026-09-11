/**
 * Synthetic fixtures for tests and the dev playground. Pure TypeScript, no DOM, no binaries.
 *
 * Every anti-aliased shape is defined by a signed distance function (sdf < 0 = inside) so the
 * same geometry can be rendered as a 1x anti-aliased image (`coverage`) and as an exact binary
 * mask at any integer upscale factor (`maskAt(U)`, pixel-centre test at U resolution).
 */
import type { BinaryMask, Fill, LabelMap, LinearGradient, RadialGradient, RegionMap, RGB, RasterImage } from '../types';
import { evaluateFill } from '../core/fillEval';

/** Signed distance: negative inside the shape, positive outside, in (1x) pixel units. */
export type Sdf = (x: number, y: number) => number;

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

function assertNonNegInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) {
    throw new RangeError(`${name} debe ser un entero >= 0 (recibido ${String(v)})`);
  }
}

function assertPosInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 1) {
    throw new RangeError(`${name} debe ser un entero >= 1 (recibido ${String(v)})`);
  }
}

/** mulberry32 PRNG: deterministic 32-bit generator, returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// SDF primitives
// ---------------------------------------------------------------------------------------------

function circleSdf(cx: number, cy: number, r: number): Sdf {
  return (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return Math.sqrt(dx * dx + dy * dy) - r;
  };
}

/** Axis-aligned box given by its centre and half extents (exact SDF outside the corners too). */
function boxSdf(cx: number, cy: number, hw: number, hh: number): Sdf {
  return (x, y) => {
    const dx = Math.abs(x - cx) - hw;
    const dy = Math.abs(y - cy) - hh;
    if (dx > 0 && dy > 0) return Math.sqrt(dx * dx + dy * dy);
    return dx > dy ? dx : dy;
  };
}

/** Annulus rIn <= d <= rOut. */
function ringSdf(cx: number, cy: number, rOut: number, rIn: number): Sdf {
  const c = circleSdf(cx, cy, 0);
  return (x, y) => {
    const d = c(x, y);
    const a = d - rOut;
    const b = rIn - d;
    return a > b ? a : b;
  };
}

/** Rounded segment (capsule): distance to the segment [-L, L] along `dir` minus half width. */
function capsuleSdf(cx: number, cy: number, dirX: number, dirY: number, L: number, half: number): Sdf {
  return (x, y) => {
    const qx = x - cx;
    const qy = y - cy;
    let t = qx * dirX + qy * dirY;
    if (t < -L) t = -L;
    else if (t > L) t = L;
    const ex = qx - t * dirX;
    const ey = qy - t * dirY;
    return Math.sqrt(ex * ex + ey * ey) - half;
  };
}

/** Exact SDF of a simple (possibly concave) polygon; sign by crossing parity. */
function polygonSdf(vx: Float64Array, vy: Float64Array): Sdf {
  const n = vx.length;
  return (px, py) => {
    let d = (px - vx[0]) * (px - vx[0]) + (py - vy[0]) * (py - vy[0]);
    let s = 1;
    for (let i = 0, j = n - 1; i < n; j = i, i++) {
      const ex = vx[j] - vx[i];
      const ey = vy[j] - vy[i];
      const wx = px - vx[i];
      const wy = py - vy[i];
      let h = (wx * ex + wy * ey) / (ex * ex + ey * ey);
      if (h < 0) h = 0;
      else if (h > 1) h = 1;
      const bx = wx - ex * h;
      const by = wy - ey * h;
      const dd = bx * bx + by * by;
      if (dd < d) d = dd;
      const c1 = py >= vy[i];
      const c2 = py < vy[j];
      const c3 = ex * wy > ey * wx;
      if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
    }
    return s * Math.sqrt(d);
  };
}

function unionSdf(a: Sdf, b: Sdf): Sdf {
  return (x, y) => {
    const da = a(x, y);
    const db = b(x, y);
    return da < db ? da : db;
  };
}

/** 5-point star polygon (10 vertices), one tip pointing up (towards -y). */
function starSdf(cx: number, cy: number, rOuter: number, rInner: number): Sdf {
  const vx = new Float64Array(10);
  const vy = new Float64Array(10);
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const r = k % 2 === 0 ? rOuter : rInner;
    vx[k] = cx + r * Math.cos(a);
    vy[k] = cy + r * Math.sin(a);
  }
  return polygonSdf(vx, vy);
}

// ---------------------------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------------------------

/**
 * Fractional coverage of each pixel of a size×size grid: ss×ss subsamples per pixel at
 * (x + (i+0.5)/ss, y + (j+0.5)/ss); a subsample is inside when sdf < 0. Values are k/(ss*ss).
 */
export function coverage(size: number, sdf: Sdf, ss = 8): Float32Array {
  assertNonNegInt('size', size);
  assertPosInt('ss', ss);
  const out = new Float32Array(size * size);
  const total = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0;
      for (let j = 0; j < ss; j++) {
        const py = y + (j + 0.5) / ss;
        for (let i = 0; i < ss; i++) {
          if (sdf(x + (i + 0.5) / ss, py) < 0) inside++;
        }
      }
      out[y * size + x] = inside / total;
    }
  }
  return out;
}

/** Binary mask of the same sdf at U× resolution, pixel-centre test: sdf((x+0.5)/U, (y+0.5)/U) < 0. */
function maskFromSdf(size: number, U: number, sdf: Sdf): BinaryMask {
  assertPosInt('U', U);
  const n = size * U;
  const data = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    const py = (y + 0.5) / U;
    for (let x = 0; x < n; x++) {
      if (sdf((x + 0.5) / U, py) < 0) data[y * n + x] = 1;
    }
  }
  return { data, width: n, height: n };
}

/** Coverage (0..1 per pixel) → opaque RGBA: colour = ink*cov + bg*(1-cov), rounded to nearest. */
export function grayToRaster(cov: Float32Array, size: number, ink: RGB, bg: RGB): RasterImage {
  assertNonNegInt('size', size);
  if (cov.length !== size * size) {
    throw new RangeError(`grayToRaster: cov.length (${cov.length}) != size*size (${size * size})`);
  }
  const data = new Uint8ClampedArray(size * size * 4);
  const ir = ink[0];
  const ig = ink[1];
  const ib = ink[2];
  const br = bg[0];
  const bgg = bg[1];
  const bb = bg[2];
  for (let p = 0, o = 0; p < cov.length; p++, o += 4) {
    let t = cov[p];
    if (!(t >= 0)) t = 0; // also maps NaN to 0
    else if (t > 1) t = 1;
    const u = 1 - t;
    data[o] = Math.round(ir * t + br * u);
    data[o + 1] = Math.round(ig * t + bgg * u);
    data[o + 2] = Math.round(ib * t + bb * u);
    data[o + 3] = 255;
  }
  return { data, width: size, height: size };
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** Anti-aliased black disc of radius r centred in a size×size white image. */
export function aaCircle(
  size = 64,
  r = 20,
): { image: RasterImage; maskAt: (U: number) => BinaryMask; area: number; perimeter: number } {
  assertNonNegInt('size', size);
  const c = size / 2;
  const sdf = circleSdf(c, c, r);
  return {
    image: grayToRaster(coverage(size, sdf), size, BLACK, WHITE),
    maskAt: (U: number) => maskFromSdf(size, U, sdf),
    area: Math.PI * r * r,
    perimeter: 2 * Math.PI * r,
  };
}

/**
 * Anti-aliased black line of the given width through the image centre at `angleDeg`
 * (measured from +x towards +y, i.e. clockwise on screen). The infinite line is clipped to a
 * segment with round caps that keeps an 8 px margin from every image edge, so the shape is a
 * single closed component fully inside the image.
 */
export function aaDiagonalLine(
  size = 64,
  width = 1.5,
  angleDeg = 30,
): { image: RasterImage; maskAt: (U: number) => BinaryMask } {
  assertNonNegInt('size', size);
  const MARGIN = 8;
  const c = size / 2;
  const half = width / 2;
  const th = (angleDeg * Math.PI) / 180;
  const dirX = Math.cos(th);
  const dirY = Math.sin(th);
  // Half length so that endpoints plus caps stay >= MARGIN from all edges.
  const reach = c - MARGIN - half;
  let L = Infinity;
  if (Math.abs(dirX) > 1e-12) L = Math.min(L, reach / Math.abs(dirX));
  if (Math.abs(dirY) > 1e-12) L = Math.min(L, reach / Math.abs(dirY));
  if (!(L > 0) || !Number.isFinite(L)) {
    throw new RangeError('aaDiagonalLine: la imagen es demasiado pequeña para los márgenes de 8 px');
  }
  const sdf = capsuleSdf(c, c, dirX, dirY, L, half);
  return {
    image: grayToRaster(coverage(size, sdf), size, BLACK, WHITE),
    maskAt: (U: number) => maskFromSdf(size, U, sdf),
  };
}

/**
 * Glyph-like shape: annulus (outer r 14, inner r 9) ∪ horizontal bar (4 px tall) that runs from
 * inside the ring wall on the left up to the centre. One connected component with one hole
 * (the bar does NOT cross the whole hole; a full-width bar would split it into two holes).
 * Coordinates scale with size/48.
 */
export function glyph(size = 48): { image: RasterImage; maskAt: (U: number) => BinaryMask } {
  assertNonNegInt('size', size);
  const s = size / 48;
  const c = 24 * s;
  const ring = ringSdf(c, c, 14 * s, 9 * s);
  // bar: x in [12, 24], y in [22, 26]  → centre (18, 24), half extents (6, 2)
  const bar = boxSdf(18 * s, 24 * s, 6 * s, 2 * s);
  const sdf = unionSdf(ring, bar);
  return {
    image: grayToRaster(coverage(size, sdf), size, BLACK, WHITE),
    maskAt: (U: number) => maskFromSdf(size, U, sdf),
  };
}

const FLAT_BG: RGB = [0xf2, 0xe8, 0xd5];
const FLAT_CIRCLE: RGB = [0x2a, 0x6f, 0x97];
const FLAT_RECT: RGB = [0xe0, 0x7a, 0x5f];

/**
 * Three flat colours: background #F2E8D5, circle #2A6F97 (centre 40,44, r 24) and rect #E07A5F
 * (x 46..86, y 30..70) drawn on top of the circle; coordinates scale with size/96.
 * Colour = linear blend in draw order using each shape's coverage. Labels (0 bg, 1 circle,
 * 2 rect) by maximum effective coverage, ties → later shape. palette = [bg, circle, rect].
 */
export function flatShapes3(size = 96): { image: RasterImage; labels: LabelMap; palette: RGB[] } {
  assertNonNegInt('size', size);
  const s = size / 96;
  const covC = coverage(size, circleSdf(40 * s, 44 * s, 24 * s));
  const covR = coverage(size, boxSdf(66 * s, 50 * s, 20 * s, 20 * s));
  const n = size * size;
  const data = new Uint8ClampedArray(n * 4);
  const labels = new Uint8Array(n);
  for (let p = 0, o = 0; p < n; p++, o += 4) {
    const cC = covC[p];
    const cR = covR[p];
    const effBg = (1 - cC) * (1 - cR);
    const effC = cC * (1 - cR);
    const effR = cR;
    let label = 0;
    let best = effBg;
    if (effC >= best) {
      best = effC;
      label = 1;
    }
    if (effR >= best) label = 2;
    labels[p] = label;
    data[o] = Math.round(FLAT_BG[0] * effBg + FLAT_CIRCLE[0] * effC + FLAT_RECT[0] * effR);
    data[o + 1] = Math.round(FLAT_BG[1] * effBg + FLAT_CIRCLE[1] * effC + FLAT_RECT[1] * effR);
    data[o + 2] = Math.round(FLAT_BG[2] * effBg + FLAT_CIRCLE[2] * effC + FLAT_RECT[2] * effR);
    data[o + 3] = 255;
  }
  const palette: RGB[] = [[...FLAT_BG], [...FLAT_CIRCLE], [...FLAT_RECT]];
  return {
    image: { data, width: size, height: size },
    labels: { data: labels, width: size, height: size, count: 3 },
    palette,
  };
}

const SPRITE_PALETTE: readonly RGB[] = [
  [255, 0, 77],
  [255, 163, 0],
  [255, 236, 39],
  [0, 228, 54],
  [41, 173, 255],
  [126, 37, 83],
];
const SPRITE_SIZE = 32;
const SPRITE_BLOCKS = 25;

/**
 * 32×32 pixel-art sprite: fully transparent background (RGBA 0,0,0,0) and 25 random opaque
 * axis-aligned blocks of 2–6 px from a 6-colour palette. Deterministic for a given seed.
 */
export function sprite32(seed = 1): RasterImage {
  const rand = mulberry32(seed);
  const w = SPRITE_SIZE;
  const data = new Uint8ClampedArray(w * w * 4);
  for (let b = 0; b < SPRITE_BLOCKS; b++) {
    const bw = 2 + Math.floor(rand() * 5); // 2..6
    const bh = 2 + Math.floor(rand() * 5);
    const bx = Math.floor(rand() * (w - bw + 1)); // 0..w-bw
    const by = Math.floor(rand() * (w - bh + 1));
    const col = SPRITE_PALETTE[Math.floor(rand() * SPRITE_PALETTE.length)];
    for (let y = by; y < by + bh; y++) {
      let o = (y * w + bx) * 4;
      for (let x = 0; x < bw; x++, o += 4) {
        data[o] = col[0];
        data[o + 1] = col[1];
        data[o + 2] = col[2];
        data[o + 3] = 255;
      }
    }
  }
  return { data, width: w, height: w };
}

/** Replicates each pixel into a k×k block (nearest-neighbour upscale). k=1 → copy. */
export function nearestUpscale(img: RasterImage, k: number): RasterImage {
  assertPosInt('k', k);
  const { width: w, height: h, data: src } = img;
  const W = w * k;
  const H = h * k;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor(y / k);
    let o = y * W * 4;
    for (let x = 0; x < W; x++, o += 4) {
      const i = (sy * w + Math.floor(x / k)) * 4;
      out[o] = src[i];
      out[o + 1] = src[i + 1];
      out[o + 2] = src[i + 2];
      out[o + 3] = src[i + 3];
    }
  }
  return { data: out, width: W, height: H };
}

const LOGO_RGB: RGB = [0x1d, 0x35, 0x57];

/**
 * Logo on transparent background: RGB constant #1D3557 everywhere; alpha = coverage of a
 * 5-point star (outer r 26, inner r 11, centre 32,32 for size 64; scales with size/64).
 */
export function transparentLogo(size = 64): { image: RasterImage; maskAt: (U: number) => BinaryMask } {
  assertNonNegInt('size', size);
  const s = size / 64;
  const sdf = starSdf(32 * s, 32 * s, 26 * s, 11 * s);
  const cov = coverage(size, sdf);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let p = 0, o = 0; p < cov.length; p++, o += 4) {
    data[o] = LOGO_RGB[0];
    data[o + 1] = LOGO_RGB[1];
    data[o + 2] = LOGO_RGB[2];
    data[o + 3] = Math.round(cov[p] * 255);
  }
  return {
    image: { data, width: size, height: size },
    maskAt: (U: number) => maskFromSdf(size, U, sdf),
  };
}

const NOISE_CELLS = [24, 12, 6] as const;
const NOISE_AMPS = [1, 0.5, 0.25] as const;
/** Per-channel sampling phase (in lattice cells) so R, G and B see the same field shifted. */
const NOISE_PHASE_X = [0, 0.37, 0.71] as const;
const NOISE_PHASE_Y = [0, 0.61, 0.23] as const;
/**
 * Contrast gain around mid grey. Tuned (64×64, seeds 1/2/3/7) so that the image keeps a
 * photo-like spread (std >= 35, range >= 214 per channel) while colours still repeat: >= 390
 * distinct 5-bit colours with >= 3 px each (the classifier's 0.05 % population threshold).
 * A higher gain (2.2) made almost every pixel its own 5-bit colour.
 */
const NOISE_GAIN = 1.6;

/**
 * Photo-like smooth colour noise: 3 octaves (cells 24/12/6 px, amplitudes 1/0.5/0.25) of
 * bilinearly interpolated random lattices; each RGB channel samples the same field with a
 * different phase offset. Contrast-stretched around mid grey. Deterministic per seed.
 */
export function noisePhoto(size = 64, seed = 1): RasterImage {
  assertNonNegInt('size', size);
  const rand = mulberry32(seed);
  const n = size * size;
  const data = new Uint8ClampedArray(n * 4);
  const field = new Float32Array(n);
  const ampSum = NOISE_AMPS[0] + NOISE_AMPS[1] + NOISE_AMPS[2];

  // Random lattices, one per octave, shared by the three channels (phase-shifted sampling).
  const lattices: Float32Array[] = [];
  const dims: number[] = [];
  for (let o = 0; o < NOISE_CELLS.length; o++) {
    const dim = Math.ceil(size / NOISE_CELLS[o]) + 3; // +1 for the far edge, +2 for phase shifts
    const lat = new Float32Array(dim * dim);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    lattices.push(lat);
    dims.push(dim);
  }

  for (let ch = 0; ch < 3; ch++) {
    field.fill(0);
    for (let o = 0; o < NOISE_CELLS.length; o++) {
      const cell = NOISE_CELLS[o];
      const amp = NOISE_AMPS[o] / ampSum;
      const lat = lattices[o];
      const dim = dims[o];
      const phx = NOISE_PHASE_X[ch];
      const phy = NOISE_PHASE_Y[ch];
      for (let y = 0; y < size; y++) {
        const v = y / cell + phy;
        const j0 = Math.floor(v);
        const fy = v - j0;
        const row0 = j0 * dim;
        const row1 = (j0 + 1) * dim;
        for (let x = 0; x < size; x++) {
          const u = x / cell + phx;
          const i0 = Math.floor(u);
          const fx = u - i0;
          const a = lat[row0 + i0];
          const b = lat[row0 + i0 + 1];
          const c = lat[row1 + i0];
          const d = lat[row1 + i0 + 1];
          const top = a + (b - a) * fx;
          const bot = c + (d - c) * fx;
          field[y * size + x] += amp * (top + (bot - top) * fy);
        }
      }
    }
    for (let p = 0, o = ch; p < n; p++, o += 4) {
      // Uint8ClampedArray clamps to [0,255] and rounds on assignment.
      data[o] = 128 + (field[p] - 0.5) * 255 * NOISE_GAIN;
    }
  }
  for (let o = 3; o < data.length; o += 4) data[o] = 255;
  return { data, width: size, height: size };
}

/** Opaque black square covering [inset, size-inset) in both axes on a white background. */
export function filledSquare(size = 64, inset = 16): RasterImage {
  assertNonNegInt('size', size);
  assertNonNegInt('inset', inset);
  const data = new Uint8ClampedArray(size * size * 4);
  data.fill(255);
  const lo = inset;
  const hi = size - inset;
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      const o = (y * size + x) * 4;
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
    }
  }
  return { data, width: size, height: size };
}

// ---------------------------------------------------------------------------------------------
// Fake transparency (checkerboard painted into the pixels)
// ---------------------------------------------------------------------------------------------

function subtractSdf(a: Sdf, b: Sdf): Sdf {
  return (x, y) => {
    const da = a(x, y);
    const db = -b(x, y);
    return da > db ? da : db;
  };
}

/** Grey level of a painted checkerboard at pixel (x, y): parity of floor((x + 0.5 - ox) / cell) + floor((y + 0.5 - oy) / cell). */
function checkerLevel(x: number, y: number, cell: number, offset: [number, number], levels: [number, number]): number {
  return levels[(Math.floor((x + 0.5 - offset[0]) / cell) + Math.floor((y + 0.5 - offset[1]) / cell)) & 1];
}

const CHECKER_LOGO_INK: RGB = [230, 0, 126];

export interface BakedCheckerLogoOptions {
  /** Image side, px. Default 128. */
  size?: number;
  /** Checker cell side, px (fractional allowed: a resampled preview). Default 10. */
  cell?: number;
  /** Position of a cell boundary (x, y), px. Default [0, 0]. */
  offset?: [number, number];
  /** Grey levels of parity 0 and 1 (r = g = b). Default [255, 204]. */
  levels?: [number, number];
  /** Seeded uniform noise, +- per channel on every pixel. Default 4. */
  noise?: number;
  seed?: number;
  /**
   * 'counters': two round holes and a 20 % x 6 % slot inside the disc show the checkerboard;
   * 'whiteRect': an opaque white rectangle (28 % x 16 % of the side) inside the disc. Default 'none'.
   */
  inner?: 'none' | 'counters' | 'whiteRect';
}

/**
 * Magenta logo (#E6007E): anti-aliased disc (centre 0.5, 0.42 of the side, r 0.24) and bar (centre
 * 0.5, 0.78, half extents 0.34 x 0.06) over a checkerboard painted into an opaque image, the way
 * stock previews fake transparency. Deterministic per seed.
 * background: 1 where the opaque coverage (logo, white rectangle included) is < 0.5.
 * counters: hole pixels at least 1 px inside their edges (coverage 0); whiteRect: fully covered
 * rectangle pixels. Both empty for the other variants.
 */
export function bakedCheckerLogo(opts: BakedCheckerLogoOptions = {}): {
  image: RasterImage;
  background: BinaryMask;
  coverage: Float32Array;
  counters: BinaryMask;
  whiteRect: BinaryMask;
} {
  const size = opts.size ?? 128;
  const cell = opts.cell ?? 10;
  const offset = opts.offset ?? [0, 0];
  const levels = opts.levels ?? [255, 204];
  const noise = opts.noise ?? 4;
  const inner = opts.inner ?? 'none';
  assertNonNegInt('size', size);
  if (!(cell >= 1) || !Number.isFinite(cell)) throw new RangeError(`cell debe ser un número >= 1 (recibido ${String(cell)})`);
  assertNonNegInt('noise', noise);
  const rand = mulberry32(opts.seed ?? 1);
  const s = size;
  const disc = circleSdf(0.5 * s, 0.42 * s, 0.24 * s);
  let logo: Sdf = disc;
  let holes: Sdf | null = null;
  if (inner === 'counters') {
    holes = unionSdf(
      unionSdf(circleSdf(0.42 * s, 0.34 * s, 0.04 * s), circleSdf(0.58 * s, 0.34 * s, 0.04 * s)),
      boxSdf(0.5 * s, 0.5 * s, 0.1 * s, 0.03 * s),
    );
    logo = subtractSdf(disc, holes);
  }
  logo = unionSdf(logo, boxSdf(0.5 * s, 0.78 * s, 0.34 * s, 0.06 * s));
  const cov = coverage(size, logo);
  const rectCov = inner === 'whiteRect' ? coverage(size, boxSdf(0.5 * s, 0.42 * s, 0.14 * s, 0.08 * s)) : null;
  const holeCov = holes !== null ? coverage(size, holes) : null;

  const n = size * size;
  const data = new Uint8ClampedArray(n * 4);
  const background = new Uint8Array(n);
  const counters = new Uint8Array(n);
  const white = new Uint8Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const L = checkerLevel(x, y, cell, offset, levels);
      const c = cov[i];
      const rc = rectCov !== null ? rectCov[i] : 0;
      const o = i * 4;
      for (let ch = 0; ch < 3; ch++) {
        const v = (CHECKER_LOGO_INK[ch] * c + L * (1 - c)) * (1 - rc) + 255 * rc;
        const jitter = noise > 0 ? Math.floor(rand() * (2 * noise + 1)) - noise : 0;
        data[o + ch] = Math.round(v + jitter);
      }
      data[o + 3] = 255;
      if (c < 0.5) background[i] = 1;
      if (rc === 1) white[i] = 1;
    }
  }
  if (holeCov !== null) {
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        let full = true;
        for (let dy = -1; dy <= 1 && full; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (holeCov[(y + dy) * size + x + dx] < 1) {
              full = false;
              break;
            }
          }
        }
        if (full && disc(x + 0.5, y + 0.5) < 0) counters[y * size + x] = 1;
      }
    }
  }
  return {
    image: { data, width: size, height: size },
    background: { data: background, width: size, height: size },
    coverage: cov,
    counters: { data: counters, width: size, height: size },
    whiteRect: { data: white, width: size, height: size },
  };
}

/**
 * A genuine chessboard graphic that does NOT fake transparency: `levels` grey cells of `cell` px
 * (8 x 8 cells from (size/6, size/6)) on a solid background colour that fills the border.
 * board: 1 inside the chessboard.
 */
export function chessboardGraphic(
  size = 96,
  cell = 8,
  levels: [number, number] = [255, 204],
  background: RGB = [40, 90, 160],
): { image: RasterImage; board: BinaryMask } {
  assertNonNegInt('size', size);
  assertPosInt('cell', cell);
  const n = size * size;
  const data = new Uint8ClampedArray(n * 4);
  const board = new Uint8Array(n);
  const start = Math.floor(size / 6);
  const end = Math.min(size, start + 8 * cell);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const o = i * 4;
      const inside = x >= start && x < end && y >= start && y < end;
      if (inside) {
        const L = checkerLevel(x - start, y - start, cell, [0, 0], levels);
        data[o] = L;
        data[o + 1] = L;
        data[o + 2] = L;
        board[i] = 1;
      } else {
        data[o] = background[0];
        data[o + 1] = background[1];
        data[o + 2] = background[2];
      }
      data[o + 3] = 255;
    }
  }
  return { image: { data, width: size, height: size }, board: { data: board, width: size, height: size } };
}

// ---------------------------------------------------------------------------------------------
// Gradient fixtures (gradient mode): shapes painted with solid, linear and radial fills
// ---------------------------------------------------------------------------------------------

/** A shape of a gradient fixture: its geometry, its ground-truth fill and its id in the labels. */
export interface GradientShape {
  /** Negative inside, in 1x pixel units. */
  sdf: Sdf;
  /** Ground truth in 1x continuous coordinates: pixel (x, y) is painted with the fill at (x + 0.5, y + 0.5). */
  fill: Fill;
  /** Region id in the fixture's labels (0 is the background). */
  label: number;
}

/** Pixel box [x0, x1) × [y0, y1). */
interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxAround(xs: readonly number[], ys: readonly number[], pad: number): PixelBox {
  return {
    x0: Math.floor(Math.min(...xs) - pad),
    y0: Math.floor(Math.min(...ys) - pad),
    x1: Math.ceil(Math.max(...xs) + pad) + 1,
    y1: Math.ceil(Math.max(...ys) + pad) + 1,
  };
}

function boxesOverlap(a: PixelBox, b: PixelBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * coverage() of `sdf` restricted to `box` on a size×size grid (0 outside the box): the square crop at
 * the box origin is rendered by coverage() on the translated sdf. Subsample positions are the same
 * dyadic numbers as on the full grid, so inside the box the values equal coverage(size, sdf).
 */
function coverageInBox(size: number, sdf: Sdf, box: PixelBox, ss = 8): Float32Array {
  const out = new Float32Array(size * size);
  const x0 = Math.max(0, box.x0);
  const y0 = Math.max(0, box.y0);
  const x1 = Math.min(size, box.x1);
  const y1 = Math.min(size, box.y1);
  if (x1 <= x0 || y1 <= y0) return out;
  const side = Math.max(x1 - x0, y1 - y0);
  const local = coverage(side, (x, y) => sdf(x + x0, y + y0), ss);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) out[y * size + x] = local[(y - y0) * side + (x - x0)];
  }
  return out;
}

interface PaintedShape {
  sdf: Sdf;
  fill: Fill;
  /** Every pixel the shape touches. */
  box: PixelBox;
}

/**
 * Paints `shapes` in order over an opaque `background` without conflation: the effective coverage of a
 * shape is the share of the 8×8 subsamples of a pixel whose topmost shape it is (coverage() of the shape
 * minus every later shape), and the background takes the rest, so a side shared by two shapes blends
 * them directly (no background seam). Colour = sum of effective coverage × the shape's fill evaluated
 * at the pixel centre (x + 0.5, y + 0.5), plus the background share, rounded to nearest.
 * labels: 0 background, k + 1 for shapes[k], by maximum effective coverage (ties → the later one).
 */
function paintShapes(
  size: number,
  shapes: readonly PaintedShape[],
  background: RGB,
): { image: RasterImage; labels: RegionMap } {
  const n = size * size;
  const eff = shapes.map((shape, k) => {
    const later: Sdf[] = [];
    for (let j = k + 1; j < shapes.length; j++) if (boxesOverlap(shape.box, shapes[j].box)) later.push(shapes[j].sdf);
    // Sign-only sdf of "inside this shape and outside every later one": coverage() only reads the sign.
    const topmost: Sdf =
      later.length === 0
        ? shape.sdf
        : (x, y) => {
            const d = shape.sdf(x, y);
            if (d >= 0) return d;
            for (let j = 0; j < later.length; j++) if (later[j](x, y) < 0) return 1;
            return d;
          };
    return coverageInBox(size, topmost, shape.box);
  });
  const data = new Uint8ClampedArray(n * 4);
  const labels = new Int32Array(n);
  const c: RGB = [0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      let r = 0;
      let g = 0;
      let b = 0;
      let rest = 1;
      for (let k = 0; k < shapes.length; k++) {
        const e = eff[k][p];
        if (e === 0) continue;
        evaluateFill(shapes[k].fill, x + 0.5, y + 0.5, c);
        r += e * c[0];
        g += e * c[1];
        b += e * c[2];
        rest -= e;
      }
      if (rest < 0) rest = 0;
      let best = rest;
      let label = 0;
      for (let k = 0; k < shapes.length; k++) {
        const e = eff[k][p];
        if (e > 0 && e >= best) {
          best = e;
          label = k + 1;
        }
      }
      const o = p * 4;
      data[o] = Math.round(r + rest * background[0]);
      data[o + 1] = Math.round(g + rest * background[1]);
      data[o + 2] = Math.round(b + rest * background[2]);
      data[o + 3] = 255;
      labels[p] = label;
    }
  }
  return {
    image: { data, width: size, height: size },
    labels: { data: labels, width: size, height: size, count: shapes.length + 1 },
  };
}

const DEG = Math.PI / 180;

/** Unit vector at `deg` degrees counter-clockwise on screen from +x (y grows downwards): (cos, -sin). */
function screenDir(deg: number): [number, number] {
  return [Math.cos(deg * DEG), -Math.sin(deg * DEG)];
}

const FEATHER_SHADOW: RGB = [0x20, 0x22, 0x2a];
/** Base → tip colours of feathers 1..8; 3 and 4 are the blue / purple pair that touches. */
const FEATHER_COLORS: ReadonlyArray<readonly [RGB, RGB]> = [
  [[0xff, 0x6a, 0x00], [0xff, 0xd2, 0x3f]], // orange → yellow
  [[0xe8, 0x17, 0x5d], [0xff, 0x8c, 0x42]], // raspberry → orange
  [[0x20, 0x40, 0xd0], [0x80, 0x30, 0xc0]], // blue → purple
  [[0x80, 0x30, 0xc0], [0x20, 0x40, 0xd0]], // purple → blue
  [[0x00, 0xa6, 0xa6], [0x9b, 0xe1, 0x5d]], // teal → light green
  [[0x1e, 0x7f, 0xcb], [0x56, 0xcc, 0xf2]], // blue → sky blue
  [[0xc2, 0x18, 0x5b], [0xf0, 0x62, 0x92]], // dark pink → pink
  [[0x2e, 0x7d, 0x32], [0xc0, 0xca, 0x33]], // green → lime
];
const FEATHER_HUB: readonly [number, number] = [126, 190];
/** Distance from the hub to a feather's base apex, px (size 256). */
const FEATHER_BASE_RADIUS = 18;
/** Half width of the base and tip edges, px. */
const FEATHER_HALF_EDGE = 1.5;
/** Length of the sides from the base edge to the widest points, px. */
const FEATHER_SIDE = 32;
/** Base apex → tip distance before the seeded jitter (× 0.94..1), px. */
const FEATHER_LENGTH = 104;
/** Angle of the sides to the axis, degrees: half the 22.5° spacing, so facing sides are parallel. */
const FEATHER_SIDE_ANGLE = 11.25;

/**
 * Logo-like fan of 8 feathers, each painted with a 2-stop linear gradient along its own long axis, and a
 * flat dark disc (the "shadow") drawn last over feathers 6 and 7, on white: the gradient-mode test bed
 * where every shape is one region with a known fill. Deterministic per seed; the seed only jitters the
 * tip lengths. Coordinates for size 256, everything scaled by size/256; directions dir(a) = (cos a,
 * -sin a), i.e. a degrees counter-clockwise on screen from +x:
 *
 *   hub H = (126, 190). Feather i = 1..8 has axis angle a_i = 7° + 22.5°·(i - 1) and is a convex
 *   hexagon around its axis:
 *     base apex B_i = H + 18·dir(a_i); base edge B_i ± 1.5·dir(a_i ± 90°);
 *     sides from the base edge ends at a_i ± 11.25° for 32 px, to the widest points S± (half width 7.74);
 *     tip T_i = B_i + L_i·dir(a_i), L_i = 104·(0.94 + 0.06·u_i) with u_i the i-th mulberry32(seed) draw;
 *     tip edge T_i ± 1.5·dir(a_i ± 90°) (blunt ends: sharp apexes left sub-pixel label slivers).
 *   Facing sides of neighbours are parallel (both at a_i + 11.25°) with a background gap of 4.1 px
 *   (7.5 px next to the 3/4 pair). Feathers 3 and 4 instead touch: their base apexes sit 1.47 px
 *   (1.5·cos 11.25°) on either side of P = H + 18·dir(63.25°), across the line through P at 63.25°, so
 *   their facing sides lie on that line and coincide from the base edge to S (32 px, t <= 0.33 of each
 *   ramp); past S they part with a background wedge. Blue → purple against purple → blue differ there
 *   by (1 - 2t)·96 levels of red, at least 33 (measured 33.5..36.1 on seeds 1..8, 44 contact pairs):
 *   the contact never reaches the mid-ramp where the two colours are equal.
 *   Gradient of feather i: (x1, y1) = B_i, first colour at 0 → (x2, y2) = T_i, second colour at 1
 *   (the middles of the base and tip edges).
 *   Shadow: disc of r 11 centred at H + 52·dir(130.75°) (the bisector of feathers 6 and 7), #20222a,
 *   biting about 7 px into each of them at their widest part without splitting either.
 *
 * Painting and labels as in paintShapes (no conflation; label = maximum effective coverage, ties → the
 * later shape): labels 0 background (solid `background`), 1..8 the feathers, 9 the shadow (count 10);
 * shapes[k].label = k + 1. At 128 and 256 px every label is a single 4-connected piece; at 512 px the
 * argmax leaves a background speck in the thin wedge where feathers 3 and 4 part.
 */
export function gradientFeathers(
  size = 256,
  seed = 1,
): { image: RasterImage; shapes: GradientShape[]; labels: RegionMap; background: RGB } {
  assertNonNegInt('size', size);
  const s = size / 256;
  const rand = mulberry32(seed);
  const hx = FEATHER_HUB[0] * s;
  const hy = FEATHER_HUB[1] * s;
  const rho = FEATHER_BASE_RADIUS * s;
  const half = FEATHER_HALF_EDGE * s;
  const side = FEATHER_SIDE * s;
  const painted: PaintedShape[] = [];
  const shapes: GradientShape[] = [];
  for (let i = 1; i <= 8; i++) {
    const a = 7 + 22.5 * (i - 1);
    const axis = screenDir(a);
    let bx: number;
    let by: number;
    if (i === 3 || i === 4) {
      const shared = 7 + 22.5 * 2.5; // 63.25°: the line both facing sides lie on
      const p = screenDir(shared);
      const normal = screenDir(shared + 90);
      const off = (i === 3 ? -1 : 1) * half * Math.cos(FEATHER_SIDE_ANGLE * DEG);
      bx = hx + rho * p[0] + off * normal[0];
      by = hy + rho * p[1] + off * normal[1];
    } else {
      bx = hx + rho * axis[0];
      by = hy + rho * axis[1];
    }
    const length = FEATHER_LENGTH * s * (0.94 + 0.06 * rand());
    const nMinus = screenDir(a - 90);
    const nPlus = screenDir(a + 90);
    const sideMinus = screenDir(a - FEATHER_SIDE_ANGLE);
    const sidePlus = screenDir(a + FEATHER_SIDE_ANGLE);
    const tx = bx + length * axis[0];
    const ty = by + length * axis[1];
    const bmx = bx + half * nMinus[0];
    const bmy = by + half * nMinus[1];
    const bpx = bx + half * nPlus[0];
    const bpy = by + half * nPlus[1];
    const vx = [bmx, bmx + side * sideMinus[0], tx + half * nMinus[0], tx + half * nPlus[0], bpx + side * sidePlus[0], bpx];
    const vy = [bmy, bmy + side * sideMinus[1], ty + half * nMinus[1], ty + half * nPlus[1], bpy + side * sidePlus[1], bpy];
    const sdf = polygonSdf(Float64Array.from(vx), Float64Array.from(vy));
    const [first, second] = FEATHER_COLORS[i - 1];
    const fill: LinearGradient = {
      kind: 'linear',
      x1: bx,
      y1: by,
      x2: tx,
      y2: ty,
      stops: [
        { offset: 0, color: [first[0], first[1], first[2]] },
        { offset: 1, color: [second[0], second[1], second[2]] },
      ],
    };
    shapes.push({ sdf, fill, label: i });
    painted.push({ sdf, fill, box: boxAround(vx, vy, 1) });
  }
  const toward = screenDir(130.75);
  const cx = hx + 52 * s * toward[0];
  const cy = hy + 52 * s * toward[1];
  const r = 11 * s;
  const shadowSdf = circleSdf(cx, cy, r);
  const shadow: Fill = { kind: 'solid', color: [FEATHER_SHADOW[0], FEATHER_SHADOW[1], FEATHER_SHADOW[2]] };
  shapes.push({ sdf: shadowSdf, fill: shadow, label: 9 });
  painted.push({ sdf: shadowSdf, fill: shadow, box: boxAround([cx - r, cx + r], [cy - r, cy + r], 1) });
  const { image, labels } = paintShapes(size, painted, WHITE);
  return { image, shapes, labels, background: [WHITE[0], WHITE[1], WHITE[2]] };
}

const RADIAL_STOPS: ReadonlyArray<readonly [number, RGB]> = [
  [0, [0xff, 0xe0, 0x8a]],
  [0.5, [0xff, 0x7a, 0x3d]],
  [1, [0x7a, 0x1f, 0xa2]],
];

/**
 * Disc of radius 48 centred at (60, 66) painted with a 3-stop radial gradient of the same centre and
 * r 48 (#ffe08a at 0, #ff7a3d at 0.5, #7a1fa2 at 1), anti-aliased on white as in paintShapes.
 * Coordinates for size 128, scaled by size/128; `fill` in 1x continuous coordinates.
 */
export function radialDisc(size = 128): { image: RasterImage; fill: RadialGradient; sdf: Sdf } {
  assertNonNegInt('size', size);
  const s = size / 128;
  const cx = 60 * s;
  const cy = 66 * s;
  const r = 48 * s;
  const sdf = circleSdf(cx, cy, r);
  const fill: RadialGradient = {
    kind: 'radial',
    cx,
    cy,
    r,
    stops: RADIAL_STOPS.map(([offset, c]) => ({ offset, color: [c[0], c[1], c[2]] })),
  };
  const { image } = paintShapes(size, [{ sdf, fill, box: boxAround([cx - r, cx + r], [cy - r, cy + r], 1) }], WHITE);
  return { image, fill, sdf };
}

const SWEEP_STOPS: ReadonlyArray<readonly [number, RGB]> = [
  [0, [0xfe, 0xda, 0x75]],
  [0.3, [0xfa, 0x7e, 0x1e]],
  [0.65, [0xd6, 0x29, 0x76]],
  [1, [0x96, 0x2f, 0xbf]],
];

/**
 * Rounded square (x and y in [16, 112], corner radius 20) painted with a 4-stop diagonal linear
 * gradient in Instagram-like colours from the bottom-left (20, 108) to the top-right (108, 20): #feda75
 * at 0, #fa7e1e at 0.3, #d62976 at 0.65, #962fbf at 1. Anti-aliased on white as in paintShapes;
 * coordinates for size 128, scaled by size/128.
 */
export function diagonalSweep(size = 128): { image: RasterImage; fill: LinearGradient; sdf: Sdf } {
  assertNonNegInt('size', size);
  const s = size / 128;
  const inner = boxSdf(64 * s, 64 * s, 28 * s, 28 * s);
  const corner = 20 * s;
  const sdf: Sdf = (x, y) => inner(x, y) - corner;
  const fill: LinearGradient = {
    kind: 'linear',
    x1: 20 * s,
    y1: 108 * s,
    x2: 108 * s,
    y2: 20 * s,
    stops: SWEEP_STOPS.map(([offset, c]) => ({ offset, color: [c[0], c[1], c[2]] })),
  };
  const { image } = paintShapes(size, [{ sdf, fill, box: boxAround([16 * s, 112 * s], [16 * s, 112 * s], 1) }], WHITE);
  return { image, fill, sdf };
}

/** #ed2b2b and #149e14: both have Rec.601 luma 0.299R + 0.587G + 0.114B = 101.006 exactly. */
const HUE_RED: RGB = [0xed, 0x2b, 0x2b];
const HUE_GREEN: RGB = [0x14, 0x9e, 0x14];

/**
 * Horizontal red → green ramp over the whole image at constant Rec.601 luma: #ed2b2b at x = 0 and
 * #149e14 at x = size (luma 101.006 both, so every interpolated colour has it before rounding). Each
 * pixel is the fill at its centre, rounded; no shape and no anti-aliasing.
 */
export function hueRamp(size = 96): { image: RasterImage; fill: LinearGradient } {
  assertNonNegInt('size', size);
  const fill: LinearGradient = {
    kind: 'linear',
    x1: 0,
    y1: size / 2,
    x2: size,
    y2: size / 2,
    stops: [
      { offset: 0, color: [HUE_RED[0], HUE_RED[1], HUE_RED[2]] },
      { offset: 1, color: [HUE_GREEN[0], HUE_GREEN[1], HUE_GREEN[2]] },
    ],
  };
  const data = new Uint8ClampedArray(size * size * 4);
  const c: RGB = [0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      evaluateFill(fill, x + 0.5, y + 0.5, c);
      const o = (y * size + x) * 4;
      data[o] = Math.round(c[0]);
      data[o + 1] = Math.round(c[1]);
      data[o + 2] = Math.round(c[2]);
      data[o + 3] = 255;
    }
  }
  return { image: { data, width: size, height: size }, fill };
}

/**
 * Copy of `img` with seeded uniform integer noise in [-amp, amp] added to each RGB channel
 * independently (clamped to 0..255); alpha untouched. Per channel the noise has sigma
 * sqrt(amp·(amp + 1)/3) (2 for amp 3); on Rec.601 luma 0.669 times that (1.34 for amp 3).
 */
export function withNoise(img: RasterImage, amp = 3, seed = 1): RasterImage {
  assertNonNegInt('amp', amp);
  const rand = mulberry32(seed);
  const src = img.data;
  const out = new Uint8ClampedArray(src.length);
  const span = 2 * amp + 1;
  for (let o = 0; o < src.length; o += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const jitter = amp > 0 ? Math.floor(rand() * span) - amp : 0;
      out[o + ch] = src[o + ch] + jitter;
    }
    out[o + 3] = src[o + 3];
  }
  return { data: out, width: img.width, height: img.height };
}
