/**
 * Extra synthetic fixtures for the pipeline tests (pure, no vitest dependency). They use the same
 * coverage() rasteriser as src/dev/synth.ts, so every anti-aliased shape also has an exact mask
 * at any integer upscale factor (pixel-centre test, like synth's maskAt).
 */
import type { BinaryMask, RGB, RasterImage } from '../../src/types';
import { coverage, grayToRaster, transparentLogo } from '../../src/dev/synth';

/** Signed distance in 1x pixel units: negative inside. */
export type Sdf = (x: number, y: number) => number;

export interface ShapeFixture {
  image: RasterImage;
  maskAt: (U: number) => BinaryMask;
}

const WHITE: RGB = [255, 255, 255];

/** Exact mask of `sdf` on a size×size image at U× (inside when the pixel centre has sdf < 0). */
export function maskFromSdf(size: number, U: number, sdf: Sdf): BinaryMask {
  const n = size * U;
  const data = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (sdf((x + 0.5) / U, (y + 0.5) / U) < 0) data[y * n + x] = 1;
  }
  return { data, width: n, height: n };
}

/** Anti-aliased centred disc of radius r in colour `ink` over `bg`. */
export function colourDisc(ink: RGB, bg: RGB = WHITE, size = 64, r = 20): ShapeFixture {
  const c = size / 2;
  const sdf: Sdf = (x, y) => Math.hypot(x - c, y - c) - r;
  return { image: grayToRaster(coverage(size, sdf), size, ink, bg), maskAt: (U) => maskFromSdf(size, U, sdf) };
}

/** transparentLogo (alpha = star coverage) with the RGB of EVERY pixel replaced by `rgb`. */
export function recolouredLogo(rgb: RGB, size = 64): ShapeFixture {
  const base = transparentLogo(size);
  const data = Uint8ClampedArray.from(base.image.data);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = rgb[0];
    data[p + 1] = rgb[1];
    data[p + 2] = rgb[2];
  }
  return { image: { data, width: size, height: size }, maskAt: base.maskAt };
}

/**
 * 199×199 white with a black anti-aliased disc (6600 px) and a grey-128 one (6362 px) apart:
 * three real colours, the grey one lying on the white-black segment.
 */
export function greyDiscs(): RasterImage {
  const size = 199;
  const covA = coverage(size, (x, y) => Math.hypot(x - 50, y - 100) - Math.sqrt(6600 / Math.PI));
  const covB = coverage(size, (x, y) => Math.hypot(x - 148, y - 100) - Math.sqrt(6362 / Math.PI));
  const data = new Uint8ClampedArray(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const v = Math.round(255 * (1 - covA[p] - covB[p]) + 128 * covB[p]);
    data[p * 4] = v;
    data[p * 4 + 1] = v;
    data[p * 4 + 2] = v;
    data[p * 4 + 3] = 255;
  }
  return { data, width: size, height: size };
}

/**
 * 64×64 grey #808080 with a 20×20 one-pixel black/white checkerboard (x, y in 8..27) and a 16×16
 * red #c81e1e square (x in 40..55, y in 36..51), no anti-aliasing. `square(U)` is the red square's
 * exact mask at U×.
 */
export function checkerAndSquare(): { image: RasterImage; square: (U: number) => BinaryMask } {
  const size = 64;
  const data = new Uint8ClampedArray(size * size * 4);
  const inSquare = (x: number, y: number): boolean => x >= 40 && x < 56 && y >= 36 && y < 52;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c: RGB = [128, 128, 128];
      if (x >= 8 && x < 28 && y >= 8 && y < 28) c = (x + y) % 2 === 0 ? [0, 0, 0] : [255, 255, 255];
      if (inSquare(x, y)) c = [200, 30, 30];
      data.set([c[0], c[1], c[2], 255], (y * size + x) * 4);
    }
  }
  const square = (U: number): BinaryMask => {
    const n = size * U;
    const m = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (inSquare(Math.floor(x / U), Math.floor(y / U))) m[y * n + x] = 1;
    return { data: m, width: n, height: n };
  };
  return { image: { data, width: size, height: size }, square };
}

/**
 * Anti-aliased black ellipse (semi-axes a along the rotated x axis, b across) centred in a
 * size×size white image, rotated by angleDeg. The SDF is the scaled implicit form (exact sign,
 * approximate distance), enough for coverage and pixel-centre masks.
 */
export function rotatedEllipse(size: number, a: number, b: number, angleDeg: number): ShapeFixture {
  const t = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const c = size / 2;
  const sdf: Sdf = (x, y) => {
    const u = (x - c) * cos + (y - c) * sin;
    const v = -(x - c) * sin + (y - c) * cos;
    return (Math.hypot(u / a, v / b) - 1) * Math.min(a, b);
  };
  return { image: grayToRaster(coverage(size, sdf), size, [0, 0, 0], WHITE), maskAt: (U) => maskFromSdf(size, U, sdf) };
}

/**
 * Transparent 64x64: an opaque red (#c81e1e) 16x16 square at (8, 8) and four blue (#1e3cc8) 4x4
 * blocks at alpha 136 whose corners are (36|46, 36|46). At 1x the blocks are a coherent palette
 * colour (4 core px each); upscale 4 + blur sigma 4 px fades their alpha below 128.
 * square(U): the red square at U.
 */
export function fadingBlocks(): { image: RasterImage; square: (U: number) => BinaryMask } {
  const size = 64;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) data.set([200, 30, 30, 255], (y * size + x) * 4);
  for (const by of [36, 46]) {
    for (const bx of [36, 46]) {
      for (let y = by; y < by + 4; y++) for (let x = bx; x < bx + 4; x++) data.set([30, 60, 200, 136], (y * size + x) * 4);
    }
  }
  const square = (U: number): BinaryMask => {
    const n = size * U;
    const out = new Uint8Array(n * n);
    for (let y = 8 * U; y < 24 * U; y++) for (let x = 8 * U; x < 24 * U; x++) out[y * n + x] = 1;
    return { data: out, width: n, height: n };
  };
  return { image: { data, width: size, height: size }, square };
}

export interface RingedDiscOptions {
  /** Ring width, px (outer radius 50, inner 50 - width). */
  width: number;
  /** Background: opaque white (default) or transparent (alpha = coverage). */
  transparent?: boolean;
}

export const RING_FILL: RGB = [255, 210, 0];
export const RING_INK: RGB = [20, 20, 20];

/**
 * 160x160 sticker: an anti-aliased yellow (255, 210, 0) disc of radius 50 at (80, 80) whose outer
 * `width` px are a dark (20, 20, 20) ring, on white or on transparency. ring: pixels fully covered by
 * the ring (inner coverage 0, outer coverage 1).
 */
export function ringedDisc(opts: RingedDiscOptions): { image: RasterImage; ring: BinaryMask } {
  const size = 160;
  const outer = coverage(size, (x, y) => Math.hypot(x - 80, y - 80) - 50);
  const inner = coverage(size, (x, y) => Math.hypot(x - 80, y - 80) - (50 - opts.width));
  const data = new Uint8ClampedArray(size * size * 4);
  const ring = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const fill = inner[i];
    const ink = outer[i] - inner[i];
    const o = i * 4;
    if (opts.transparent === true) {
      const a = outer[i];
      for (let c = 0; c < 3; c++) data[o + c] = a > 0 ? Math.round((RING_FILL[c] * fill + RING_INK[c] * ink) / a) : 0;
      data[o + 3] = Math.round(255 * a);
    } else {
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(RING_FILL[c] * fill + RING_INK[c] * ink + 255 * (1 - outer[i]));
      data[o + 3] = 255;
    }
    if (outer[i] === 1 && inner[i] === 0) ring[i] = 1;
  }
  return { image: { data, width: size, height: size }, ring: { data: ring, width: size, height: size } };
}

export const ACCENT_NAVY: RGB = [29, 53, 87];
export const ACCENT_RED: RGB = [220, 30, 40];

/**
 * 48x48 white icon: an anti-aliased navy (29, 53, 87) disc of radius 14.4 at the centre and a red
 * (220, 30, 40) dot of radius 2.5 centred on the pixel corner (40, 8): 16 px at coverage >= 0.5,
 * only 4 of them with 8 red neighbours.
 */
export function accentIcon(): RasterImage {
  const size = 48;
  const disc = coverage(size, (x, y) => Math.hypot(x - 24, y - 24) - 14.4);
  const dot = coverage(size, (x, y) => Math.hypot(x - 40, y - 8) - 2.5);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      data[o + c] = Math.round(ACCENT_NAVY[c] * disc[i] + ACCENT_RED[c] * dot[i] + 255 * (1 - disc[i] - dot[i]));
    }
    data[o + 3] = 255;
  }
  return { data, width: size, height: size };
}

// ---------------------------------------------------------------------------------------------
// Scenes over a painted fake-transparency checkerboard (boundaries on multiples of the cell)
// ---------------------------------------------------------------------------------------------

/** Board level at pixel (x, y): levels[(floor(x / cell) + floor(y / cell)) & 1]. */
export function boardLevel(x: number, y: number, cell: number, levels: readonly [number, number]): number {
  return levels[(Math.floor(x / cell) + Math.floor(y / cell)) & 1];
}

export interface BoardScene {
  /** Opaque image with the checkerboard painted where nothing covers it. */
  image: RasterImage;
  /** The scene without the checkerboard: RGB of what covers each pixel, alpha = its coverage. */
  truth: RasterImage;
  cell: number;
  levels: [number, number];
}

const BOARD_MAGENTA: RGB = [230, 0, 126];

function paintScene(
  size: number,
  cell: number,
  levels: [number, number],
  cover: (x: number, y: number, i: number) => { rgb: RGB; a: number },
): BoardScene {
  const data = new Uint8ClampedArray(size * size * 4);
  const truth = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const { rgb, a } = cover(x, y, i);
      const L = boardLevel(x, y, cell, levels);
      for (let c = 0; c < 3; c++) {
        data[i * 4 + c] = Math.round(rgb[c] * a + L * (1 - a));
        truth[i * 4 + c] = a > 0 ? rgb[c] : 0;
      }
      data[i * 4 + 3] = 255;
      truth[i * 4 + 3] = Math.round(255 * a);
    }
  }
  return {
    image: { data, width: size, height: size },
    truth: { data: truth, width: size, height: size },
    cell,
    levels,
  };
}

/**
 * 160x160 board (cell 16): an anti-aliased magenta disc (radius 36 at (80, 60)), a magenta link
 * (x 76..83, y 96..99) and an opaque grey `bar` level bar (x 20..139, y 100..131, 3 840 px) that
 * touches the checkerboard on three sides. bar: its pixels.
 */
export function barOnBoard(levels: [number, number], bar: number): BoardScene & { bar: BinaryMask } {
  const size = 160;
  const disc = coverage(size, (x, y) => Math.hypot(x - 80, y - 60) - 36);
  const barMask = new Uint8Array(size * size);
  const scene = paintScene(size, 16, levels, (x, y, i) => {
    if (x >= 20 && x < 140 && y >= 100 && y < 132) {
      barMask[i] = 1;
      return { rgb: [bar, bar, bar], a: 1 };
    }
    if (x >= 76 && x < 84 && y >= 96 && y < 100) return { rgb: BOARD_MAGENTA, a: 1 };
    return { rgb: BOARD_MAGENTA, a: disc[i] };
  });
  return { ...scene, bar: { data: barMask, width: size, height: size } };
}

/**
 * 64x64 board (cell 8, levels 255 / 204) with a hard-edged sprite: a black square (x, y 20..43)
 * whose 1 px outline surrounds yellow (255, 220, 0) and a red (220, 20, 60) centre (28..35).
 * sprite: its 576 pixels.
 */
export function outlinedSprite(): BoardScene & { sprite: BinaryMask } {
  const size = 64;
  const sprite = new Uint8Array(size * size);
  const inside = (v: number, a: number, b: number): boolean => v >= a && v < b;
  const scene = paintScene(size, 8, [255, 204], (x, y, i) => {
    if (!inside(x, 20, 44) || !inside(y, 20, 44)) return { rgb: [0, 0, 0], a: 0 };
    sprite[i] = 1;
    if (inside(x, 28, 36) && inside(y, 28, 36)) return { rgb: [220, 20, 60], a: 1 };
    if (inside(x, 21, 43) && inside(y, 21, 43)) return { rgb: [255, 220, 0], a: 1 };
    return { rgb: [0, 0, 0], a: 1 };
  });
  return { ...scene, sprite: { data: sprite, width: size, height: size } };
}

/**
 * 160x160 board (cell 16, levels 255 / 204) with an anti-aliased sticker: a yellow (255, 210, 0)
 * disc of radius 50 at (80, 80) whose outer 1 px is a dark (20, 20, 20) ring. fill: pixels fully
 * covered by the yellow.
 */
export function stickerOnBoard(): BoardScene & { fill: BinaryMask } {
  const size = 160;
  const outer = coverage(size, (x, y) => Math.hypot(x - 80, y - 80) - 50);
  const inner = coverage(size, (x, y) => Math.hypot(x - 80, y - 80) - 49);
  const fill = new Uint8Array(size * size);
  const scene = paintScene(size, 16, [255, 204], (_x, _y, i) => {
    const a = outer[i];
    if (inner[i] === 1) fill[i] = 1;
    if (a === 0) return { rgb: [0, 0, 0], a: 0 };
    const rgb: RGB = [0, 1, 2].map((c) => (RING_FILL[c] * inner[i] + RING_INK[c] * (a - inner[i])) / a) as RGB;
    return { rgb, a };
  });
  return { ...scene, fill: { data: fill, width: size, height: size } };
}

/** Opaque 45-degree stripes: level = levels[floor((x + y) / s) & 1]. */
export function diagonalStripes(width: number, height: number, s: number, levels: readonly [number, number]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = levels[Math.floor((x + y) / s) & 1];
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

/** Opaque grey gingham: level = levels[(floor(x / s) & 1) + (floor(y / s) & 1)]. */
export function gingham(width: number, height: number, s: number, levels: readonly [number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = levels[(Math.floor(x / s) & 1) + (Math.floor(y / s) & 1)];
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}
