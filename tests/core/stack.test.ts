import { describe, expect, it } from 'vitest';
import type { BinaryMask, LabelMap } from '../../src/types';
import { cutoutMasks, layerOrder, nestedMasks } from '../../src/core/stack';
import { dilate1 } from '../../src/core/morphology';
import { flatShapes3 } from '../../src/dev/synth';
import { assertMaskNested } from '../fixtures/helpers';

function labelMap(width: number, height: number, count: number, values: number[]): LabelMap {
  if (values.length !== width * height) throw new Error('labelMap: values.length');
  return { data: Uint8Array.from(values), width, height, count };
}

function ink(m: BinaryMask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) if (m.data[i] !== 0) n++;
  return n;
}

function bits(m: BinaryMask): number[] {
  return Array.from(m.data);
}

/** Number of pixels where inner has ink but outer does not (0 = nested). */
function nestingViolations(outer: BinaryMask, inner: BinaryMask): number {
  let v = 0;
  for (let i = 0; i < inner.data.length; i++) if (inner.data[i] !== 0 && outer.data[i] === 0) v++;
  return v;
}

// 4x3 map with 3 labels: label 0 = 5 px, label 1 = 4 px, label 2 = 3 px.
const SMALL = labelMap(4, 3, 3, [
  0, 0, 1, 1,
  0, 2, 2, 1,
  0, 0, 2, 1,
]);

describe('layerOrder', () => {
  it('sorts palette indices by area, descending', () => {
    expect(layerOrder(SMALL)).toEqual([0, 1, 2]);
    // Same map with labels 1 and 2 swapped -> label 2 is now the second largest.
    const swapped = labelMap(4, 3, 3, Array.from(SMALL.data, (v) => (v === 1 ? 2 : v === 2 ? 1 : v)));
    expect(layerOrder(swapped)).toEqual([0, 2, 1]);
  });

  it('breaks ties by ascending index (stable) and lists zero-area labels last', () => {
    const lm = labelMap(4, 1, 5, [3, 1, 3, 1]);
    expect(layerOrder(lm)).toEqual([1, 3, 0, 2, 4]);
    expect(layerOrder(labelMap(0, 0, 0, []))).toEqual([]);
    expect(layerOrder(labelMap(0, 0, 2, []))).toEqual([0, 1]);
  });

  it('flatShapes3: background first, then rect, then the partly covered circle', () => {
    const { labels } = flatShapes3();
    expect(layerOrder(labels)).toEqual([0, 2, 1]);
  });
});

describe('nestedMasks', () => {
  it('masks[j] = rank >= j on a small example', () => {
    const order = [0, 1, 2];
    const masks = nestedMasks(SMALL, order);
    expect(masks.length).toBe(3);
    expect(bits(masks[0])).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(bits(masks[1])).toEqual([0, 0, 1, 1, 0, 1, 1, 1, 0, 0, 1, 1]);
    expect(bits(masks[2])).toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0]);
    for (const m of masks) {
      expect(m.width).toBe(4);
      expect(m.height).toBe(3);
    }
  });

  it('respects a non-identity order (rank = position in order)', () => {
    const masks = nestedMasks(SMALL, [2, 0, 1]);
    // rank: label2 -> 0, label0 -> 1, label1 -> 2
    expect(bits(masks[1])).toEqual([1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1]);
    expect(bits(masks[2])).toEqual([0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('labels absent from order only belong to masks[0]; empty order -> []', () => {
    const masks = nestedMasks(SMALL, [1, 2]);
    expect(masks.length).toBe(2);
    expect(bits(masks[0])).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    // rank(1)=0, rank(2)=1, label 0 -> rank 0 -> not in masks[1]
    expect(bits(masks[1])).toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0]);
    expect(nestedMasks(SMALL, [])).toEqual([]);
  });

  it('flatShapes3 invariants: masks[0] all ones, masks[j+1] ⊆ masks[j], difference == rank j', () => {
    const { labels } = flatShapes3();
    const order = layerOrder(labels);
    const masks = nestedMasks(labels, order);
    expect(masks.length).toBe(3);
    expect(ink(masks[0])).toBe(96 * 96);
    const rankOf = new Map<number, number>();
    order.forEach((l, j) => rankOf.set(l, j));
    for (let j = 0; j + 1 < masks.length; j++) {
      expect(nestingViolations(masks[j], masks[j + 1])).toBe(0);
      expect(() => assertMaskNested(masks[j], masks[j + 1])).not.toThrow();
      let mismatches = 0;
      for (let i = 0; i < labels.data.length; i++) {
        const diff = masks[j].data[i] !== 0 && masks[j + 1].data[i] === 0 ? 1 : 0;
        const isRankJ = rankOf.get(labels.data[i]) === j ? 1 : 0;
        if (diff !== isRankJ) mismatches++;
      }
      expect(mismatches).toBe(0);
    }
    // The last mask is exactly the last-ranked label (the circle, label 1).
    let circle = 0;
    for (let i = 0; i < labels.data.length; i++) if (labels.data[i] === 1) circle++;
    expect(ink(masks[2])).toBe(circle);
    expect(circle).toBeGreaterThan(1000);
    expect(circle).toBeLessThan(1400);
  });

  it('does not mutate the label map', () => {
    const copy = Uint8Array.from(SMALL.data);
    nestedMasks(SMALL, [2, 1, 0]);
    expect(Array.from(SMALL.data)).toEqual(Array.from(copy));
  });
});

describe('cutoutMasks', () => {
  it('equals dilate1(rank == j) on a small example', () => {
    const order = [0, 1, 2];
    const masks = cutoutMasks(SMALL, order);
    expect(masks.length).toBe(3);
    // rank 2 == label 2 at (1,1), (2,1), (2,2) -> dilated by the 4-neighbourhood.
    expect(bits(masks[2])).toEqual([
      0, 1, 1, 0,
      1, 1, 1, 1,
      0, 1, 1, 1,
    ]);
    for (let j = 0; j < 3; j++) {
      const raw: BinaryMask = { data: new Uint8Array(12), width: 4, height: 3 };
      for (let i = 0; i < 12; i++) if (SMALL.data[i] === order[j]) raw.data[i] = 1;
      expect(bits(masks[j])).toEqual(bits(dilate1(raw)));
    }
  });

  it('flatShapes3: every cutout mask is dilate1 of its label and grows by at most one ring', () => {
    const { labels } = flatShapes3();
    const order = layerOrder(labels);
    const masks = cutoutMasks(labels, order);
    expect(masks.length).toBe(3);
    for (let j = 0; j < order.length; j++) {
      const raw: BinaryMask = { data: new Uint8Array(labels.data.length), width: 96, height: 96 };
      let area = 0;
      for (let i = 0; i < labels.data.length; i++) {
        if (labels.data[i] === order[j]) {
          raw.data[i] = 1;
          area++;
        }
      }
      const ref = dilate1(raw);
      expect(bits(masks[j])).toEqual(bits(ref));
      expect(nestingViolations(masks[j], raw)).toBe(0); // raw ⊆ dilated
      expect(ink(masks[j])).toBeGreaterThanOrEqual(area);
    }
    // Union of the undilated ranks covers the image, so the dilated union does too.
    const union = new Uint8Array(96 * 96);
    for (const m of masks) for (let i = 0; i < union.length; i++) if (m.data[i] !== 0) union[i] = 1;
    expect(union.every((v) => v === 1)).toBe(true);
    expect(cutoutMasks(labels, [])).toEqual([]);
  });
});
