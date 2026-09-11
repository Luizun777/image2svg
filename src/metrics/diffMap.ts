/**
 * Visual difference heat-map (RGBA overlay). Pure; never mutates inputs.
 */
import type { RasterImage } from '../types';

/** Colour ramp stops (d < 0.3 yellow, 0.3..0.45 yellow->orange, 0.45..0.6 orange->red, >= 0.6 red). */
const YELLOW_R = 255;
const YELLOW_G = 214;
const YELLOW_B = 0;
const ORANGE_R = 255;
const ORANGE_G = 122;
const ORANGE_B = 0;
const RED_R = 224;
const RED_G = 24;
const RED_B = 24;

/**
 * Per pixel: m = max |Δ| over the RGB channels, d = m / 255.
 * - m <= 16 -> fully transparent (0,0,0,0).
 * - alpha = min(255, d * 765) (= min(255, 3m), exact integer).
 * - colour: yellow for d < 0.3, red for d >= 0.6, linear yellow->orange->red in between.
 * Throws when the images differ in size.
 */
export function diffHeatmap(a: RasterImage, b: RasterImage): RasterImage {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `diffHeatmap: tamaños distintos (${a.width}x${a.height} vs ${b.width}x${b.height})`,
    );
  }
  const A = a.data;
  const B = b.data;
  const n = a.width * a.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n * 4; p += 4) {
    let dr = A[p] - B[p];
    let dg = A[p + 1] - B[p + 1];
    let db = A[p + 2] - B[p + 2];
    if (dr < 0) dr = -dr;
    if (dg < 0) dg = -dg;
    if (db < 0) db = -db;
    const m = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
    if (m <= 16) continue; // stays (0,0,0,0)
    const d = m / 255;
    const alpha = m * 3;
    out[p + 3] = alpha > 255 ? 255 : alpha;
    if (d < 0.3) {
      out[p] = YELLOW_R;
      out[p + 1] = YELLOW_G;
      out[p + 2] = YELLOW_B;
    } else if (d >= 0.6) {
      out[p] = RED_R;
      out[p + 1] = RED_G;
      out[p + 2] = RED_B;
    } else {
      const t = (d - 0.3) / 0.3; // 0..1 across the ramp
      if (t < 0.5) {
        const u = t * 2;
        out[p] = YELLOW_R + (ORANGE_R - YELLOW_R) * u;
        out[p + 1] = YELLOW_G + (ORANGE_G - YELLOW_G) * u;
        out[p + 2] = YELLOW_B + (ORANGE_B - YELLOW_B) * u;
      } else {
        const u = (t - 0.5) * 2;
        out[p] = ORANGE_R + (RED_R - ORANGE_R) * u;
        out[p + 1] = ORANGE_G + (RED_G - ORANGE_G) * u;
        out[p + 2] = ORANGE_B + (RED_B - ORANGE_B) * u;
      }
    }
  }
  return { data: out, width: a.width, height: a.height };
}
