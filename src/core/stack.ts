/**
 * Layer stacking helpers for flat mode. Pure; never mutates inputs.
 *
 * rank(label) = position of the label in `order` (0 = back-most / largest area). Labels that
 * do not appear in `order` get rank 0, so they only belong to the background mask.
 */
import type { BinaryMask, LabelMap } from '../types';
import { dilate1 } from './morphology';

const MAX_LABELS = 256; // labels are Uint8

/** Palette indices sorted by pixel area, descending; ties broken by ascending index (stable). */
export function layerOrder(labels: LabelMap): number[] {
  const count = Number.isFinite(labels.count) ? Math.max(0, Math.floor(labels.count)) : 0;
  if (count === 0) return [];
  const area = new Float64Array(count);
  const d = labels.data;
  const n = Math.min(labels.width * labels.height, d.length);
  for (let i = 0; i < n; i++) {
    const l = d[i];
    if (l < count) area[l]++;
  }
  const order: number[] = new Array<number>(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => area[b] - area[a] || a - b);
  return order;
}

/** Per-pixel rank table (Uint8): rank of each label, 0 for labels absent from `order`. */
function pixelRanks(labels: LabelMap, order: number[]): Uint8Array {
  if (order.length > MAX_LABELS) {
    throw new RangeError(`stack: order tiene ${order.length} entradas (máximo ${MAX_LABELS})`);
  }
  const rank = new Uint8Array(MAX_LABELS);
  for (let j = 0; j < order.length; j++) {
    const l = order[j];
    if (Number.isInteger(l) && l >= 0 && l < MAX_LABELS) rank[l] = j;
  }
  const d = labels.data;
  const n = labels.width * labels.height;
  const pr = new Uint8Array(n);
  const m = Math.min(n, d.length);
  for (let i = 0; i < m; i++) pr[i] = rank[d[i]];
  return pr;
}

/**
 * masks[j] = pixels whose rank >= j, for j in 0..order.length-1. masks[0] is all ones and
 * masks[j+1] ⊆ masks[j]; masks[j] minus masks[j+1] is exactly the set of pixels with rank j.
 */
export function nestedMasks(labels: LabelMap, order: number[]): BinaryMask[] {
  const { width, height } = labels;
  const out: BinaryMask[] = [];
  if (order.length === 0) return out;
  const pr = pixelRanks(labels, order);
  const n = pr.length;
  for (let j = 0; j < order.length; j++) {
    const data = new Uint8Array(n);
    if (j === 0) {
      data.fill(1);
    } else {
      for (let i = 0; i < n; i++) if (pr[i] >= j) data[i] = 1;
    }
    out.push({ data, width, height });
  }
  return out;
}

/** masks[j] = dilate1(pixels whose rank == j), for j in 0..order.length-1. */
export function cutoutMasks(labels: LabelMap, order: number[]): BinaryMask[] {
  const { width, height } = labels;
  const out: BinaryMask[] = [];
  if (order.length === 0) return out;
  const pr = pixelRanks(labels, order);
  const n = pr.length;
  for (let j = 0; j < order.length; j++) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (pr[i] === j) data[i] = 1;
    out.push(dilate1({ data, width, height }));
  }
  return out;
}
