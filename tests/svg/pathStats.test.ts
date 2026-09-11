import { describe, expect, it } from 'vitest';
import { countSegments, pathStats, utf8ByteLength } from '../../src/svg/pathStats';
import type { AbsPath, Layer, Seg } from '../../src/types';

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

const SQUARE: AbsPath = { segs: [M(4, 4), L(12, 4), L(12, 12), L(4, 12), Z] };
// circle r=10 around (10,10) as 4 cubics (k = 0.5523)
const K = 5.523;
const CIRCLE: AbsPath = {
  segs: [
    M(20, 10),
    C(20, 10 + K, 10 + K, 20, 10, 20),
    C(10 - K, 20, 0, 10 + K, 0, 10),
    C(0, 10 - K, 10 - K, 0, 10, 0),
    C(10 + K, 0, 20, 10 - K, 20, 10),
    Z,
  ],
};

describe('pathStats', () => {
  it('square (M + 3 L + Z): 3 nodes, cornerFraction 1', () => {
    const layers: Layer[] = [{ fill: '#000000', paths: [SQUARE] }];
    expect(pathStats(layers, 123)).toEqual({
      pathCount: 1,
      subpathCount: 1,
      nodeCount: 3,
      lineCount: 3,
      curveCount: 0,
      cornerFraction: 1,
      bytes: 123,
    });
  });

  it('circle of 4 C: 4 nodes, cornerFraction 0', () => {
    const s = pathStats([{ fill: '#ff0000', paths: [CIRCLE] }], 0);
    expect(s.nodeCount).toBe(4);
    expect(s.lineCount).toBe(0);
    expect(s.curveCount).toBe(4);
    expect(s.cornerFraction).toBe(0);
    expect(s.subpathCount).toBe(1);
    expect(s.pathCount).toBe(1);
  });

  it('mixed segments: Q counts as a curve, the M is not a node', () => {
    const p: AbsPath = { segs: [M(0, 0), L(1, 0), Q(2, 1, 3, 0), C(4, 1, 5, 1, 6, 0), L(0, 0), Z] };
    const s = pathStats([{ fill: '#000000', paths: [p] }], 10);
    expect(s.nodeCount).toBe(4);
    expect(s.lineCount).toBe(2);
    expect(s.curveCount).toBe(2);
    expect(s.cornerFraction).toBeCloseTo(0.5, 12);
  });

  it('aggregates across layers, paths and subpaths', () => {
    const two: AbsPath = { segs: [...SQUARE.segs, M(20, 20), L(30, 20), L(30, 30), Z] };
    const layers: Layer[] = [
      { fill: '#000000', paths: [SQUARE, CIRCLE] },
      { fill: '#00ff00', opacity: 0.5, paths: [two] },
      { fill: '#0000ff', paths: [] },
    ];
    const s = pathStats(layers, 999);
    expect(s.pathCount).toBe(3);
    expect(s.subpathCount).toBe(4);
    expect(s.lineCount).toBe(3 + 5);
    expect(s.curveCount).toBe(4);
    expect(s.nodeCount).toBe(12);
    expect(s.cornerFraction).toBeCloseTo(8 / 12, 12);
    expect(s.bytes).toBe(999);
  });

  it('no layers / no segments → zeros and cornerFraction 0 (not NaN)', () => {
    expect(pathStats([], 0)).toEqual({
      pathCount: 0,
      subpathCount: 0,
      nodeCount: 0,
      lineCount: 0,
      curveCount: 0,
      cornerFraction: 0,
      bytes: 0,
    });
    const s = pathStats([{ fill: '#000000', paths: [{ segs: [] }, { segs: [M(1, 1), Z] }] }], 5);
    expect(s.pathCount).toBe(2);
    expect(s.subpathCount).toBe(1);
    expect(s.nodeCount).toBe(0);
    expect(s.cornerFraction).toBe(0);
  });

  it('does not mutate its input', () => {
    const layers: Layer[] = [{ fill: '#000000', paths: [SQUARE] }];
    const before = JSON.stringify(layers);
    pathStats(layers, 1);
    expect(JSON.stringify(layers)).toBe(before);
  });
});

describe('countSegments', () => {
  it('counts implicit repeats in the potrace square', () => {
    expect(countSegments('M40 80 l0 -40 40 0 40 0 0 40 0 40 -40 0 -40 0 0 -40z')).toEqual({
      lines: 8,
      curves: 0,
      moves: 1,
    });
  });

  it('counts implicit repeated cubics in the potrace curve sample', () => {
    expect(countSegments('M252 509 c-48 -14 -109 -80 -123 -131 -23 -89 12 -182 88 -229 z')).toEqual({
      lines: 0,
      curves: 2,
      moves: 1,
    });
  });

  it('counts the vtracer sample (trailing space)', () => {
    expect(
      countSegments('M0 0 C2.64 0 5.28 0 8 0 C8 2.64 8 5.28 8 8 C5.36 8 2.72 8 0 8 C0 5.36 0 2.72 0 0 Z '),
    ).toEqual({ lines: 0, curves: 4, moves: 1 });
  });

  it('H/V are lines, S/T/Q are curves, coordinates after M are lines', () => {
    expect(countSegments('M0 0H5V5h-5v-5z')).toEqual({ lines: 4, curves: 0, moves: 1 });
    expect(countSegments('M0 0S1 1 2 2s1 1 2 2T5 5t1 1Q1 1 2 2q1 1 2 2')).toEqual({ lines: 0, curves: 6, moves: 1 });
    expect(countSegments('M0 0 1 1 2 2')).toEqual({ lines: 2, curves: 0, moves: 1 });
    expect(countSegments('m0 0 1 1 2 2 L3 3')).toEqual({ lines: 3, curves: 0, moves: 1 });
  });

  it('tokenises "3.5.5", exponents and sign-glued numbers correctly', () => {
    expect(countSegments('M0 0L3.5.5 1e-3-2')).toEqual({ lines: 2, curves: 0, moves: 1 });
    expect(countSegments('M-.5.5L1E+1.5')).toEqual({ lines: 1, curves: 0, moves: 1 });
  });

  it('counts several subpaths', () => {
    expect(countSegments('M0 0L1 0L1 1Z M2 2L3 2L3 3Z M5 5 6 6')).toEqual({ lines: 5, curves: 0, moves: 3 });
  });

  it('empty string → zeros; unknown command throws', () => {
    expect(countSegments('')).toEqual({ lines: 0, curves: 0, moves: 0 });
    expect(countSegments('  ')).toEqual({ lines: 0, curves: 0, moves: 0 });
    expect(() => countSegments('M0 0A1 1 0 0 0 2 2')).toThrow(/unsupported command "A"/);
    expect(() => countSegments('M0 0Z1 1')).toThrow(/unexpected number/);
  });
});

describe('utf8ByteLength', () => {
  it('matches TextEncoder for ASCII, 2/3/4-byte code points and lone surrogates', () => {
    const enc = new TextEncoder();
    const samples = ['', 'abc', '<svg d="M0 0"/>', 'ñ', 'año', '€', '日本語', '😀', 'a😀b', '\ud83d', '\ude00', 'x\ud83dy'];
    for (const s of samples) {
      expect(utf8ByteLength(s), JSON.stringify(s)).toBe(enc.encode(s).length);
    }
    expect(utf8ByteLength('ñ')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
  });
});
