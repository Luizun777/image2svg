/** Shared assertion helpers for tests (pure, no vitest dependency). */
import type { BinaryMask, RasterImage } from '../../src/types';

function assertSameSize(a: BinaryMask, b: BinaryMask, fn: string): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`${fn}: tamaños distintos (${a.width}x${a.height} vs ${b.width}x${b.height})`);
  }
  if (a.data.length !== a.width * a.height || b.data.length !== b.width * b.height) {
    throw new Error(`${fn}: data.length no coincide con width*height`);
  }
}

/** Intersection over union of ink pixels (value !== 0). 1 when both masks are empty. */
export function maskIoU(a: BinaryMask, b: BinaryMask): number {
  assertSameSize(a, b, 'maskIoU');
  const da = a.data;
  const db = b.data;
  let inter = 0;
  let union = 0;
  for (let i = 0; i < da.length; i++) {
    const x = da[i] !== 0;
    const y = db[i] !== 0;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union === 0 ? 1 : inter / union;
}

/** Throws unless every ink pixel of `inner` is also ink in `outer` (inner ⊆ outer). */
export function assertMaskNested(outer: BinaryMask, inner: BinaryMask): void {
  assertSameSize(outer, inner, 'assertMaskNested');
  const di = inner.data;
  const dout = outer.data;
  let violations = 0;
  for (let i = 0; i < di.length; i++) {
    if (di[i] !== 0 && dout[i] === 0) violations++;
  }
  if (violations > 0) {
    throw new Error(
      `assertMaskNested: ${violations} píxel(es) de inner no están en outer (inner ⊄ outer)`,
    );
  }
}

/** True when both rasters have identical dimensions and identical RGBA bytes. */
export function rasterEquals(a: RasterImage, b: RasterImage): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (a.data.length !== b.data.length) return false;
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i++) {
    if (da[i] !== db[i]) return false;
  }
  return true;
}
