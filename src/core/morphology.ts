/**
 * Binary morphology with a 4-connected (cross) structuring element. Pixels outside the image
 * count as 0 (so ink touching the border erodes there). Pure; never mutates inputs.
 */
import type { BinaryMask } from '../types';

export function erode1(mask: BinaryMask): BinaryMask {
  const { width: w, height: h, data: m } = mask;
  const out = new Uint8Array(w * h);
  if (w === 0 || h === 0) return { data: out, width: w, height: h };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = y > 0 ? row - w : -1;
    const down = y < h - 1 ? row + w : -1;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      if (m[p] === 0) continue;
      if (up < 0 || down < 0 || x === 0 || x === w - 1) continue; // touches the border -> 0
      if (m[up + x] !== 0 && m[down + x] !== 0 && m[p - 1] !== 0 && m[p + 1] !== 0) out[p] = 1;
    }
  }
  return { data: out, width: w, height: h };
}

export function dilate1(mask: BinaryMask): BinaryMask {
  const { width: w, height: h, data: m } = mask;
  const out = new Uint8Array(w * h);
  if (w === 0 || h === 0) return { data: out, width: w, height: h };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      if (m[p] === 0) continue;
      out[p] = 1;
      if (x > 0) out[p - 1] = 1;
      if (x < w - 1) out[p + 1] = 1;
      if (y > 0) out[p - w] = 1;
      if (y < h - 1) out[p + w] = 1;
    }
  }
  return { data: out, width: w, height: h };
}

export function countInk(mask: BinaryMask): number {
  const m = mask.data;
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i] !== 0) n++;
  return n;
}
