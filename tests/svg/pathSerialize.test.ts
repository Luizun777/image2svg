import { describe, expect, it } from 'vitest';
import { parsePathData } from '../../src/svg/pathParse';
import { formatNumber, pathBounds, serializePath } from '../../src/svg/pathSerialize';
import { countSegments } from '../../src/svg/pathStats';
import type { AbsPath, Seg } from '../../src/types';

const M = (x: number, y: number): Seg => ({ kind: 'M', x, y });
const L = (x: number, y: number): Seg => ({ kind: 'L', x, y });
const Q = (x1: number, y1: number, x: number, y: number): Seg => ({ kind: 'Q', x1, y1, x, y });
const C = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): Seg => ({
  kind: 'C',
  x1,
  y1,
  x2,
  y2,
  x,
  y,
});
const Z: Seg = { kind: 'Z' };

function expectSegsClose(actual: Seg[], expected: Seg[], tol: number): void {
  expect(actual.length, 'segment count').toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i] as unknown as Record<string, unknown>;
    const e = expected[i] as unknown as Record<string, unknown>;
    expect(a.kind, `seg ${i} kind`).toBe(e.kind);
    for (const key of Object.keys(e)) {
      if (key === 'kind') continue;
      const av = a[key] as number;
      const ev = e[key] as number;
      expect(Math.abs(av - ev) <= tol, `seg ${i}.${key}: got ${av}, want ${ev}`).toBe(true);
    }
  }
}

const SQUARE: AbsPath = { segs: [M(4, 4), L(12, 4), L(12, 12), L(4, 12), Z] };

describe('formatNumber', () => {
  it('emits integers verbatim and strips trailing zeros', () => {
    expect(formatNumber(4)).toBe('4');
    expect(formatNumber(-7)).toBe('-7');
    expect(formatNumber(100)).toBe('100');
    expect(formatNumber(4.5)).toBe('4.5');
    expect(formatNumber(4.1)).toBe('4.1');
    expect(formatNumber(0.25)).toBe('0.25');
    expect(formatNumber(-0.125)).toBe('-0.125');
  });

  it('rounds to the requested precision (default 3)', () => {
    expect(formatNumber(1.23456)).toBe('1.235');
    expect(formatNumber(1.23456, 1)).toBe('1.2');
    expect(formatNumber(1.23456, 0)).toBe('1');
    expect(formatNumber(1.23456, 6)).toBe('1.23456');
    expect(formatNumber(1.0004)).toBe('1');
    expect(formatNumber(2.9996)).toBe('3');
  });

  it('never emits "-0"', () => {
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(-0.0001)).toBe('0');
    expect(formatNumber(-0.4, 0)).toBe('0');
  });

  it('throws on non-finite values', () => {
    expect(() => formatNumber(NaN)).toThrow(/non-finite/);
    expect(() => formatNumber(Infinity)).toThrow(/non-finite/);
    expect(() => formatNumber(-Infinity)).toThrow(/non-finite/);
  });
});

describe('serializePath', () => {
  it('serialises a square with absolute commands and implicit repeats', () => {
    expect(serializePath(SQUARE)).toBe('M4 4L12 4 12 12 4 12Z');
  });

  it('does not collapse the implicit repeat after M (always an explicit L)', () => {
    expect(serializePath({ segs: [M(0, 0), L(1, 1)] })).toBe('M0 0L1 1');
  });

  it('collapses consecutive Q and C but not across kinds', () => {
    const p: AbsPath = { segs: [M(0, 0), Q(1, 1, 2, 0), Q(3, -1, 4, 0), C(5, 1, 6, 1, 7, 0), C(8, -1, 9, -1, 10, 0), L(11, 0), Z] };
    expect(serializePath(p)).toBe('M0 0Q1 1 2 0 3 -1 4 0C5 1 6 1 7 0 8 -1 9 -1 10 0L11 0Z');
  });

  it('applies the precision and strips zeros', () => {
    const p: AbsPath = { segs: [M(1.23456, -0.0004), L(2.5, 10)] };
    expect(serializePath(p)).toBe('M1.235 0L2.5 10');
    expect(serializePath(p, 1)).toBe('M1.2 0L2.5 10');
    expect(serializePath(p, 0)).toBe('M1 0L3 10');
    expect(serializePath(p, 6)).toBe('M1.23456 -0.0004L2.5 10');
  });

  it('emits M directly after Z and an explicit L after Z when no M follows', () => {
    expect(serializePath({ segs: [M(0, 0), L(1, 0), Z, M(2, 2), L(3, 2), Z] })).toBe('M0 0L1 0ZM2 2L3 2Z');
    expect(serializePath({ segs: [M(0, 0), L(1, 0), Z, L(2, 2)] })).toBe('M0 0L1 0ZL2 2');
  });

  it('empty path → empty string', () => {
    expect(serializePath({ segs: [] })).toBe('');
  });

  it('has no redundant whitespace and only valid characters', () => {
    const p = parsePathData('M-1.5 -2.25 L -3 4 C 1 -1 2 -2 3 -3 Q -4 4 -5 5 Z');
    const s = serializePath(p);
    expect(s).toBe('M-1.5 -2.25L-3 4C1 -1 2 -2 3 -3Q-4 4 -5 5Z');
    expect(s).not.toMatch(/  /);
    expect(s).not.toMatch(/^\s|\s$/);
    expect(s).toMatch(/^[MLQCZ0-9. -]+$/);
    expect(s).not.toMatch(/[MLQCZ] /);
    expect(s).not.toMatch(/ [MLQCZ]/);
  });

  it('propagates non-finite coordinates as an error', () => {
    expect(() => serializePath({ segs: [M(NaN, 0)] })).toThrow(/non-finite/);
  });

  it('does not mutate its input', () => {
    const p: AbsPath = { segs: [M(1.23456, 2), C(1, 2, 3, 4, 5, 6.789), Z] };
    const before = JSON.stringify(p);
    serializePath(p, 1);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe('round trip: serialize(parse(d)) re-parses to the same segments', () => {
  const samples = [
    'M40 80 l0 -40 40 0 40 0 0 40 0 40 -40 0 -40 0 0 -40z',
    'M252 509 c-48 -14 -109 -80 -123 -131 -23 -89 12 -182 88 -229 z',
    'M0 0 C2.64 0 5.28 0 8 0 C8 2.64 8 5.28 8 8 C5.36 8 2.72 8 0 8 C0 5.36 0 2.72 0 0 Z ',
    'M-.5.5L1e-3,2E+1 3.5.5H7V-2h1v1S9 9 10 10s1 1 2 2Q1 1 2 2T3 3t1 1Z m1 1 2 2z',
    'M0.123456 9.876543L-12.5 0.000001 1234.5678 -0.5',
  ];
  for (const d of samples) {
    it(`round-trips ${JSON.stringify(d.slice(0, 40))}… (precision 6, tol 1e-9)`, () => {
      const p1 = parsePathData(d);
      const s = serializePath(p1, 6);
      const p2 = parsePathData(s);
      expectSegsClose(p2.segs, p1.segs, 1e-9);
      // serialising again is a fixed point
      expect(serializePath(p2, 6)).toBe(s);
      // segment counts agree with the independent raw-string counter
      const c1 = countSegments(d);
      const c2 = countSegments(s);
      expect(c2).toEqual(c1);
    });
  }

  it('serialises the vtracer sample to the expected compact form', () => {
    const s = serializePath(parsePathData(samples[2]));
    expect(s).toBe('M0 0C2.64 0 5.28 0 8 0 8 2.64 8 5.28 8 8 5.36 8 2.72 8 0 8 0 5.36 0 2.72 0 0Z');
  });
});

describe('pathBounds', () => {
  it('covers endpoints and control points', () => {
    const p: AbsPath = { segs: [M(0, 0), C(10, -5, 20, 25, 30, 0), Z] };
    expect(pathBounds(p)).toEqual({ minX: 0, minY: -5, maxX: 30, maxY: 25 });
    const q: AbsPath = { segs: [M(1, 1), Q(-3, 7, 2, 2)] };
    expect(pathBounds(q)).toEqual({ minX: -3, minY: 1, maxX: 2, maxY: 7 });
  });

  it('square → its corners; single point → degenerate box', () => {
    expect(pathBounds(SQUARE)).toEqual({ minX: 4, minY: 4, maxX: 12, maxY: 12 });
    expect(pathBounds({ segs: [M(3, -2)] })).toEqual({ minX: 3, minY: -2, maxX: 3, maxY: -2 });
  });

  it('empty path → +Infinity/-Infinity (composable with min/max)', () => {
    const b = pathBounds({ segs: [] });
    expect(b.minX).toBe(Infinity);
    expect(b.minY).toBe(Infinity);
    expect(b.maxX).toBe(-Infinity);
    expect(b.maxY).toBe(-Infinity);
    expect(pathBounds({ segs: [Z] })).toEqual(b);
  });
});
