import { describe, expect, it } from 'vitest';
import type { BinaryMask } from '../../src/types';
import { countInk, dilate1, erode1 } from '../../src/core/morphology';

function mask(rows: string[]): BinaryMask {
  const height = rows.length;
  const width = height === 0 ? 0 : rows[0].length;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = rows[y][x] === '#' ? 1 : 0;
  return { data, width, height };
}

function rows(m: BinaryMask): string[] {
  const out: string[] = [];
  for (let y = 0; y < m.height; y++) {
    let s = '';
    for (let x = 0; x < m.width; x++) s += m.data[y * m.width + x] ? '#' : '.';
    out.push(s);
  }
  return out;
}

describe('countInk', () => {
  it('counts ones', () => {
    expect(countInk(mask(['#.#', '...', '###']))).toBe(5);
    expect(countInk(mask([]))).toBe(0);
    expect(countInk({ data: Uint8Array.from([1, 2, 0, 7]), width: 4, height: 1 })).toBe(3);
  });
});

describe('erode1', () => {
  it('erodes a 5x5 square inside 7x7 to a 3x3 square', () => {
    const m = mask(['.......', '.#####.', '.#####.', '.#####.', '.#####.', '.#####.', '.......']);
    expect(rows(erode1(m))).toEqual(['.......', '.......', '..###..', '..###..', '..###..', '.......', '.......']);
    expect(countInk(erode1(m))).toBe(9);
  });

  it('treats outside as 0: a full 3x3 keeps only its centre', () => {
    expect(rows(erode1(mask(['###', '###', '###'])))).toEqual(['...', '.#.', '...']);
  });

  it('removes 1-px lines entirely and uses 4-connectivity (diagonals do not help)', () => {
    expect(countInk(erode1(mask(['.....', '#####', '.....'])))).toBe(0);
    expect(countInk(erode1(mask(['.#.', '.#.', '.#.'])))).toBe(0);
    // Centre has 4 diagonal neighbours only -> eroded.
    expect(countInk(erode1(mask(['#.#', '.#.', '#.#'])))).toBe(0);
    // Centre with a cross of neighbours survives.
    expect(rows(erode1(mask(['.#.', '###', '.#.'])))).toEqual(['...', '.#.', '...']);
  });

  it('empty and degenerate masks', () => {
    const e = erode1(mask([]));
    expect([e.width, e.height, e.data.length]).toEqual([0, 0, 0]);
    expect(countInk(erode1(mask(['#'])))).toBe(0);
    expect(countInk(erode1(mask(['....', '....'])))).toBe(0);
  });

  it('does not mutate the input', () => {
    const m = mask(['###', '###', '###']);
    const before = Array.from(m.data);
    erode1(m);
    expect(Array.from(m.data)).toEqual(before);
  });
});

describe('dilate1', () => {
  it('turns a single pixel into a cross', () => {
    expect(rows(dilate1(mask(['.....', '.....', '..#..', '.....', '.....'])))).toEqual([
      '.....',
      '..#..',
      '.###.',
      '..#..',
      '.....',
    ]);
  });

  it('clips at the image border', () => {
    expect(rows(dilate1(mask(['#..', '...', '...'])))).toEqual(['##.', '#..', '...']);
    expect(rows(dilate1(mask(['...', '...', '..#'])))).toEqual(['...', '..#', '.##']);
  });

  it('opening (dilate1 ∘ erode1) of a 5x5 square drops its 4 corners', () => {
    const m = mask(['.......', '.#####.', '.#####.', '.#####.', '.#####.', '.#####.', '.......']);
    const opened = dilate1(erode1(m));
    expect(rows(opened)).toEqual(['.......', '..###..', '.#####.', '.#####.', '.#####.', '..###..', '.......']);
    expect(countInk(opened)).toBe(21);
  });

  it('closing (erode1 ∘ dilate1) fills a 1-px hole', () => {
    const m = mask(['#####', '#####', '##.##', '#####', '#####']);
    const closed = erode1(dilate1(m));
    // Border pixels erode (outside = 0), the hole is closed.
    expect(rows(closed)).toEqual(['.....', '.###.', '.###.', '.###.', '.....']);
  });

  it('does not mutate the input and handles empty masks', () => {
    const m = mask(['.#.']);
    const before = Array.from(m.data);
    dilate1(m);
    expect(Array.from(m.data)).toEqual(before);
    const d = dilate1(mask([]));
    expect([d.width, d.height, d.data.length]).toEqual([0, 0, 0]);
  });
});
