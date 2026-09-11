/**
 * Shared helpers for the tracer adapters (potrace, vtracer). Pure TypeScript, no DOM.
 */
import type { BinaryMask, RasterImage, TurnPolicy } from '../types';

export type { Tracer, TracerOptions } from '../types';

/** potrace `turnpolicy` numeric codes (potracelib.h: POTRACE_TURNPOLICY_*). */
export const TURNPOLICY_CODE: Record<TurnPolicy, number> = {
  black: 0,
  white: 1,
  left: 2,
  right: 3,
  minority: 4,
  majority: 5,
};

/**
 * Throws unless `mask` is internally consistent (non-negative integer size, data length equal
 * to width*height). Shared by both adapters so a corrupt mask never reaches the wasm heap.
 */
export function assertMaskShape(mask: BinaryMask, fn: string): void {
  const { width, height, data } = mask;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new Error(`${fn}: dimensiones de máscara inválidas (${String(width)}x${String(height)})`);
  }
  if (data.length !== width * height) {
    throw new Error(
      `${fn}: data.length (${data.length}) no coincide con width*height (${width * height})`,
    );
  }
}

/** True when the mask has at least one ink pixel (any non-zero value counts as ink). */
export function maskHasInk(mask: BinaryMask): boolean {
  const d = mask.data;
  for (let i = 0; i < d.length; i++) if (d[i] !== 0) return true;
  return false;
}

/**
 * Renders a binary mask as an opaque RGBA raster: ink (non-zero) → black, background → white.
 * Both tracers take "dark" pixels as ink (potrace: luma < 128; vtracer binary: r < 128).
 * Returns a fresh buffer; never mutates the mask.
 */
export function maskToRaster(mask: BinaryMask): RasterImage {
  assertMaskShape(mask, 'maskToRaster');
  const { width, height, data } = mask;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  out.fill(255);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    if (data[i] !== 0) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      // alpha stays 255
    }
  }
  return { data: out, width, height };
}
