/**
 * Pixel-exact mode: every logical pixel becomes (part of) an axis-aligned rectangle, emitted as
 * crisp-edged SVG paths grouped by colour. Pure; never mutates inputs.
 */
import type { RasterImage } from '../types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** RGBA packed r<<24 | g<<16 | b<<8 | a, unsigned (>>> 0). */
  color: number;
}

function sanitizeFactor(k: number): number {
  if (!Number.isFinite(k)) return 1;
  return Math.max(1, Math.floor(k));
}

/**
 * Keeps pixel (0,0) of every k x k block. Output size ceil(w/k) x ceil(h/k): when k does not divide
 * the size, the partial blocks of the last column / row are kept too (their top-left pixel always
 * exists). k <= 1 -> copy.
 */
export function downscaleNearest(img: RasterImage, k: number): RasterImage {
  const kk = sanitizeFactor(k);
  const { width: w, height: h, data: src } = img;
  if (kk === 1) return { data: new Uint8ClampedArray(src), width: w, height: h };
  const W = Math.ceil(w / kk);
  const H = Math.ceil(h / kk);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const srow = y * kk * w;
    let o = y * W * 4;
    for (let x = 0; x < W; x++, o += 4) {
      const i = (srow + x * kk) * 4;
      out[o] = src[i];
      out[o + 1] = src[i + 1];
      out[o + 2] = src[i + 2];
      out[o + 3] = src[i + 3];
    }
  }
  return { data: out, width: W, height: H };
}

/**
 * Above this many merged rectangles pixelSvg does not serialise at all. Each rect costs ~20-40
 * bytes of path data plus a Rect object while building: 200 000 rects is already a ~6 MB SVG,
 * whereas the 1440x1440 noise case (2 070 717 rects) built a 79 MB string and grew the RSS by
 * 1.6 GB. Pixel art that legitimately needs more is not pixel art any more.
 */
export const MAX_PIXEL_RECTS = 200_000;

/**
 * Shared greedy merge (see mergeRects). Calls `emit` for every rectangle when given and returns
 * how many there are; with `emit` null nothing is allocated beyond the packed-pixel and `used`
 * buffers.
 */
function scanRects(
  img: RasterImage,
  emit: ((x: number, y: number, w: number, h: number, color: number) => void) | null,
): number {
  const { width: w, height: h, data: d } = img;
  const n = Math.min(w * h, d.length >> 2);
  if (n === 0 || w <= 0 || h <= 0) return 0;
  const px = new Uint32Array(w * h);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    px[i] = ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
  }
  const used = new Uint8Array(w * h);
  let count = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (used[i] !== 0) continue;
      const c = px[i];
      if ((c & 0xff) === 0) continue;
      // Extend to the right.
      let x2 = x + 1;
      while (x2 < w && used[row + x2] === 0 && px[row + x2] === c) x2++;
      const rw = x2 - x;
      // Extend downwards while the whole segment matches.
      let y2 = y + 1;
      while (y2 < h) {
        const r2 = y2 * w + x;
        let ok = true;
        for (let t = 0; t < rw; t++) {
          if (used[r2 + t] !== 0 || px[r2 + t] !== c) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
        y2++;
      }
      for (let yy = y; yy < y2; yy++) used.fill(1, yy * w + x, yy * w + x2);
      count++;
      if (emit !== null) emit(x, y, rw, y2 - y, c);
    }
  }
  return count;
}

/**
 * Greedy rectangle merge in scan order (y, then x): from each unconsumed pixel with alpha != 0
 * the run of identical RGBA to the right is taken, then extended downwards while the whole row
 * segment is identical and unconsumed. Alpha-0 pixels are skipped. Rects are returned in (y, x)
 * order of their top-left corner and cover every non-transparent pixel exactly once.
 */
export function mergeRects(img: RasterImage): Rect[] {
  const rects: Rect[] = [];
  scanRects(img, (x, y, w, h, color) => {
    rects.push({ x, y, w, h, color });
  });
  return rects;
}

/** Number of rectangles mergeRects would return, without building them. */
export function countMergedRects(img: RasterImage): number {
  return scanRects(img, null);
}

function hexByte(v: number): string {
  return (v < 16 ? '0' : '') + v.toString(16);
}

function fillOf(color: number): string {
  return '#' + hexByte((color >>> 24) & 0xff) + hexByte((color >>> 16) & 0xff) + hexByte((color >>> 8) & 0xff);
}

/** Compact number: integers as-is, otherwise up to 3 decimals without trailing zeros. */
function num(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(3)));
}

/**
 * One path per colour (first-appearance order). Each rect is a closed subpath written with a
 * relative move from the previous rect's origin (the current point after `z` is the subpath
 * start): `m dx dy h w v h h -w z`, without redundant separators.
 * Opacity (alpha/255, 3 decimals) is only present when alpha < 255.
 */
export function rectsToPathsByColor(rects: Rect[]): Array<{ fill: string; opacity?: number; d: string }> {
  interface Group {
    fill: string;
    opacity?: number;
    parts: string[];
    lx: number;
    ly: number;
  }
  const groups = new Map<number, Group>();
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const color = r.color >>> 0;
    let g = groups.get(color);
    if (g === undefined) {
      g = { fill: fillOf(color), parts: [], lx: 0, ly: 0 };
      const a = color & 0xff;
      if (a < 255) g.opacity = Math.round((a / 255) * 1000) / 1000;
      groups.set(color, g);
    }
    const dx = r.x - g.lx;
    const dy = r.y - g.ly;
    g.parts.push(
      'm' + num(dx) + (dy < 0 ? '' : ' ') + num(dy) + 'h' + num(r.w) + 'v' + num(r.h) + 'h' + num(-r.w) + 'z',
    );
    g.lx = r.x;
    g.ly = r.y;
  }
  const out: Array<{ fill: string; opacity?: number; d: string }> = [];
  for (const g of groups.values()) {
    const d = g.parts.join('');
    if (g.opacity === undefined) out.push({ fill: g.fill, d });
    else out.push({ fill: g.fill, opacity: g.opacity, d });
  }
  return out;
}

/**
 * The logical rectangles in source pixels: scaled by k and clipped to width × height, so the partial
 * blocks of the last column / row keep their true size.
 */
function toSourcePixels(rects: Rect[], k: number, width: number, height: number): Rect[] {
  const out: Rect[] = new Array<Rect>(rects.length);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const x = r.x * k;
    const y = r.y * k;
    out[i] = { x, y, w: Math.min((r.x + r.w) * k, width) - x, h: Math.min((r.y + r.h) * k, height) - y, color: r.color };
  }
  return out;
}

/** A source side must hold exactly `blocks` blocks of k px, the last one possibly partial. */
function assertSide(blocks: number, k: number, side: number, what: string): void {
  if (!Number.isInteger(side) || side > blocks * k || side <= (blocks - 1) * k) {
    throw new RangeError(`pixelSvg: ${what} de ${String(side)} px no corresponde a ${blocks} bloques de ${k} px`);
  }
}

/**
 * <svg xmlns width height viewBox shape-rendering="crispEdges"> with one <path> per colour
 * (fill-opacity when alpha < 255). `img` is the logical (already downscaled) pixel grid, k the block
 * size and `size` the source size (default img × k); width/height are always the source size.
 *
 * Exact grid (size = W·k × H·k): viewBox "0 0 W H" in logical pixels, one unit per block. Otherwise
 * (k does not divide the source: its last column / row of blocks is partial) the viewBox is in SOURCE
 * pixels, "0 0 width height", with every rectangle scaled by k and clipped to the image. `size` must
 * hold exactly W and H blocks: (W−1)·k < width <= W·k, same for the height (RangeError otherwise).
 *
 * Above `maxRects` merged rectangles (default MAX_PIXEL_RECTS; they are counted first, without
 * allocating any) nothing is serialised: { svg: '', rectCount } with the exact count.
 */
export function pixelSvg(
  img: RasterImage,
  k: number,
  maxRects: number = MAX_PIXEL_RECTS,
  size?: { width: number; height: number },
): { svg: string; rectCount: number } {
  const kk = sanitizeFactor(k);
  const { width: w, height: h } = img;
  const outW = size === undefined ? w * kk : size.width;
  const outH = size === undefined ? h * kk : size.height;
  if (size !== undefined) {
    assertSide(w, kk, outW, 'un ancho');
    assertSide(h, kk, outH, 'un alto');
  }
  const exact = outW === w * kk && outH === h * kk;
  if (maxRects < Infinity) {
    const count = countMergedRects(img);
    if (count > maxRects) return { svg: '', rectCount: count };
  }
  const merged = mergeRects(img);
  const rects = exact ? merged : toSourcePixels(merged, kk, outW, outH);
  const paths = rectsToPathsByColor(rects);
  const viewBox = exact ? `0 0 ${w} ${h}` : `0 0 ${outW} ${outH}`;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="${viewBox}" shape-rendering="crispEdges">`,
  );
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const op = p.opacity === undefined ? '' : ` fill-opacity="${num(p.opacity)}"`;
    parts.push(`<path fill="${p.fill}"${op} d="${p.d}"/>`);
  }
  parts.push('</svg>');
  return { svg: parts.join('\n'), rectCount: rects.length };
}
