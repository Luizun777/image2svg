import { describe, expect, it } from 'vitest';
import { applyTransform, parsePathData, parseTransform } from '../../src/svg/pathParse';
import { pathBounds } from '../../src/svg/pathSerialize';
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

/** Segment-by-segment comparison with an absolute tolerance on every coordinate. */
function expectSegsClose(actual: Seg[], expected: Seg[], tol = 1e-12): void {
  expect(actual.length, 'segment count').toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i] as unknown as Record<string, unknown>;
    const e = expected[i] as unknown as Record<string, unknown>;
    expect(a.kind, `seg ${i} kind`).toBe(e.kind);
    expect(Object.keys(a).sort(), `seg ${i} keys`).toEqual(Object.keys(e).sort());
    for (const key of Object.keys(e)) {
      if (key === 'kind') continue;
      const av = a[key] as number;
      const ev = e[key] as number;
      expect(Math.abs(av - ev) <= tol, `seg ${i}.${key}: got ${av}, want ${ev}`).toBe(true);
    }
  }
}

// Real tracer outputs documented in ARCHITECTURE.md
const POTRACE_SQUARE = 'M40 80 l0 -40 40 0 40 0 0 40 0 40 -40 0 -40 0 0 -40z';
const POTRACE_TRANSFORM = 'translate(0.000000,16.000000) scale(0.100000,-0.100000)';
const POTRACE_CURVE = 'M252 509 c-48 -14 -109 -80 -123 -131 -23 -89 12 -182 88 -229 z';
const VTRACER_SQUARE = 'M0 0 C2.64 0 5.28 0 8 0 C8 2.64 8 5.28 8 8 C5.36 8 2.72 8 0 8 C0 5.36 0 2.72 0 0 Z ';

describe('parsePathData — tracer outputs', () => {
  it('parses the potrace square (relative l with implicit repeats, lowercase z)', () => {
    const p = parsePathData(POTRACE_SQUARE);
    expectSegsClose(p.segs, [
      M(40, 80),
      L(40, 40),
      L(80, 40),
      L(120, 40),
      L(120, 80),
      L(120, 120),
      L(80, 120),
      L(40, 120),
      L(40, 80),
      Z,
    ]);
  });

  it('potrace square + its transform lands exactly on the 8x8 square at offset 4', () => {
    const t = parseTransform(POTRACE_TRANSFORM);
    expect(t).toEqual({ tx: 0, ty: 16, sx: 0.1, sy: -0.1 });
    const p = applyTransform(parsePathData(POTRACE_SQUARE), t);
    const b = pathBounds(p);
    expect(b.minX).toBe(4);
    expect(b.maxX).toBe(12);
    expect(b.minY).toBe(4);
    expect(b.maxY).toBe(12);
    // Every vertex is a corner or edge midpoint of that square, and y is flipped.
    expectSegsClose(
      p.segs,
      [M(4, 8), L(4, 12), L(8, 12), L(12, 12), L(12, 8), L(12, 4), L(8, 4), L(4, 4), L(4, 8), Z],
      1e-12,
    );
  });

  it('parses potrace curves (relative c with implicit repeats)', () => {
    const p = parsePathData(POTRACE_CURVE);
    expectSegsClose(p.segs, [
      M(252, 509),
      C(204, 495, 143, 429, 129, 378),
      C(106, 289, 141, 196, 217, 149),
      Z,
    ]);
  });

  it('parses the vtracer output (absolute C, trailing space after Z)', () => {
    const p = parsePathData(VTRACER_SQUARE);
    expectSegsClose(p.segs, [
      M(0, 0),
      C(2.64, 0, 5.28, 0, 8, 0),
      C(8, 2.64, 8, 5.28, 8, 8),
      C(5.36, 8, 2.72, 8, 0, 8),
      C(0, 5.36, 0, 2.72, 0, 0),
      Z,
    ]);
    const moved = applyTransform(p, parseTransform('translate(4,4)'));
    expect(pathBounds(moved)).toEqual({ minX: 4, minY: 4, maxX: 12, maxY: 12 });
  });
});

describe('parsePathData — number syntax', () => {
  it('handles "-.5", ".5", exponents and "3.5.5" (two numbers)', () => {
    expectSegsClose(parsePathData('M-.5.5').segs, [M(-0.5, 0.5)], 0);
    expectSegsClose(parsePathData('M.5-.5').segs, [M(0.5, -0.5)], 0);
    expectSegsClose(parsePathData('M1e-3,2E+1').segs, [M(0.001, 20)], 0);
    expectSegsClose(parsePathData('M3.5.5').segs, [M(3.5, 0.5)], 0);
    expectSegsClose(parsePathData('M0 0L3.5.5 1e-3-2').segs, [M(0, 0), L(3.5, 0.5), L(0.001, -2)], 0);
  });

  it('accepts commas, tabs, newlines and repeated separators', () => {
    expectSegsClose(parsePathData('M1,2\tL3,,4\n5 ,6').segs, [M(1, 2), L(3, 4), L(5, 6)], 0);
  });

  it('parses leading zeros, explicit plus and negative zero like Number()', () => {
    const p = parsePathData('M007 08L+5 -0');
    expect(p.segs[0]).toEqual(M(7, 8));
    expect(p.segs[1]).toEqual(L(5, -0));
    expect(Object.is((p.segs[1] as { y: number }).y, -0)).toBe(true);
  });

  it('parses fractions exactly like Number() (fast path)', () => {
    const p = parsePathData('M0.1 0.2L0.3 123.456C1.005 2.675 0.000123 12345678.9 99999999999999 0.1234567890123');
    const s = p.segs as unknown as Array<Record<string, number>>;
    expect(s[0].x).toBe(0.1);
    expect(s[0].y).toBe(0.2);
    expect(s[1].x).toBe(0.3);
    expect(s[1].y).toBe(123.456);
    expect(s[2].x1).toBe(1.005);
    expect(s[2].y1).toBe(2.675);
    expect(s[2].x2).toBe(0.000123);
    expect(s[2].y2).toBe(12345678.9);
    expect(s[2].x).toBe(99999999999999);
    expect(s[2].y).toBe(0.1234567890123);
  });

  it('falls back to Number() for > 15 significant digits and huge exponents', () => {
    const cases = [
      '123456789012345678',
      '0.1234567890123456789',
      '1234567890.1234567890',
      '1e300',
      '1e-300',
      '5e-324',
      '1.7976931348623157e308',
      '123456789012345.6e-30',
      '9007199254740993',
      '-8438728.235858899',
      '-0.12345678901234567',
      '-1e300',
      '+123456789012345678',
    ];
    for (const s of cases) {
      const p = parsePathData(`M${s} 0`);
      expect((p.segs[0] as { x: number }).x, s).toBe(Number(s));
    }
  });

  it('matches Number() bit-for-bit on 3000 seeded random number strings', () => {
    // mulberry32 — deterministic
    let seed = 0x1234abcd;
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let n = 0; n < 3000; n++) {
      const mag = Math.pow(10, rnd() * 20 - 10);
      const v = (rnd() < 0.5 ? -1 : 1) * rnd() * mag;
      const fmt = n % 4;
      let s: string;
      if (fmt === 0) s = String(v);
      else if (fmt === 1) s = v.toFixed(Math.floor(rnd() * 12));
      else if (fmt === 2) s = v.toExponential(Math.floor(rnd() * 15));
      else s = v.toPrecision(1 + Math.floor(rnd() * 17));
      const p = parsePathData(`M${s},${s}`);
      const got = (p.segs[0] as { x: number; y: number }).x;
      expect(Object.is(got, Number(s)), `"${s}" → ${got}`).toBe(true);
    }
  });
});

describe('parsePathData — commands', () => {
  it('turns implicit coordinates after M into LineTo (absolute and relative)', () => {
    expectSegsClose(parsePathData('M1 2 3 4 5 6').segs, [M(1, 2), L(3, 4), L(5, 6)], 0);
    expectSegsClose(parsePathData('m1 1 2 2 3 3').segs, [M(1, 1), L(3, 3), L(6, 6)], 0);
  });

  it('first relative m is taken from (0,0)', () => {
    expectSegsClose(parsePathData('m5 6l1 1').segs, [M(5, 6), L(6, 7)], 0);
  });

  it('converts H/h/V/v to L using the current point', () => {
    expectSegsClose(
      parsePathData('M1 2H5V7h2v-3H0 3').segs,
      [M(1, 2), L(5, 2), L(5, 7), L(7, 7), L(7, 4), L(0, 4), L(3, 4)],
      0,
    );
  });

  it('expands S/s with the reflected second control point of the previous C', () => {
    expectSegsClose(
      parsePathData('M0 0C1 1 2 1 3 0S5 -1 6 0').segs,
      [M(0, 0), C(1, 1, 2, 1, 3, 0), C(4, -1, 5, -1, 6, 0)],
      0,
    );
    expectSegsClose(
      parsePathData('M0 0c1 1 2 1 3 0s2 -1 3 0 2 -1 3 0').segs,
      [M(0, 0), C(1, 1, 2, 1, 3, 0), C(4, -1, 5, -1, 6, 0), C(7, 1, 8, -1, 9, 0)],
      0,
    );
  });

  it('S without a preceding C uses the current point as first control point', () => {
    expectSegsClose(parsePathData('M1 1S2 3 4 5').segs, [M(1, 1), C(1, 1, 2, 3, 4, 5)], 0);
    // a line in between breaks the chain
    expectSegsClose(
      parsePathData('M0 0C1 1 2 1 3 0L4 0S6 1 7 0').segs,
      [M(0, 0), C(1, 1, 2, 1, 3, 0), L(4, 0), C(4, 0, 6, 1, 7, 0)],
      0,
    );
  });

  it('expands T/t with the reflected control point of the previous Q, chaining', () => {
    expectSegsClose(
      parsePathData('M0 0Q1 1 2 0T4 0T6 0').segs,
      [M(0, 0), Q(1, 1, 2, 0), Q(3, -1, 4, 0), Q(5, 1, 6, 0)],
      0,
    );
    expectSegsClose(
      parsePathData('M0 0q1 1 2 0t2 0 2 0').segs,
      [M(0, 0), Q(1, 1, 2, 0), Q(3, -1, 4, 0), Q(5, 1, 6, 0)],
      0,
    );
    expectSegsClose(parsePathData('M0 0T2 2').segs, [M(0, 0), Q(0, 0, 2, 2)], 0);
  });

  it('handles several subpaths (M…Z M…Z) and absolute/relative coordinates', () => {
    const p = parsePathData('M0 0L10 0L10 10Z M20 20l10 0 0 10Z');
    expectSegsClose(
      p.segs,
      [M(0, 0), L(10, 0), L(10, 10), Z, M(20, 20), L(30, 20), L(30, 30), Z],
      0,
    );
  });

  it('returns to the subpath start after Z (relative commands after Z)', () => {
    // relative m after Z is measured from the start of the closed subpath
    expectSegsClose(parsePathData('M1 1L2 1Z m1 1').segs, [M(1, 1), L(2, 1), Z, M(2, 2)], 0);
    // drawing command right after Z: implicit M at the subpath start
    expectSegsClose(
      parsePathData('M10 10L20 10L20 20Z l5 5').segs,
      [M(10, 10), L(20, 10), L(20, 20), Z, M(10, 10), L(15, 15)],
      0,
    );
    expectSegsClose(parsePathData('M10 10L20 10ZH30').segs, [M(10, 10), L(20, 10), Z, M(10, 10), L(30, 10)], 0);
  });

  it('accepts Z immediately after M and repeated Z', () => {
    expectSegsClose(parsePathData('M1 1Z').segs, [M(1, 1), Z], 0);
    expectSegsClose(parsePathData('M1 1L2 2ZZ').segs, [M(1, 1), L(2, 2), Z, Z], 0);
  });

  it('empty or blank input → no segments', () => {
    expect(parsePathData('')).toEqual({ segs: [] });
    expect(parsePathData('   \n\t ')).toEqual({ segs: [] });
  });

  it('throws on malformed data', () => {
    expect(() => parsePathData('M1')).toThrow(/expected number/);
    expect(() => parsePathData('M1 2L3')).toThrow(/expected number/);
    expect(() => parsePathData('L1 1')).toThrow(/start with M/);
    expect(() => parsePathData('Z')).toThrow(/start with M/);
    expect(() => parsePathData('1 2')).toThrow(/before any command/);
    expect(() => parsePathData('M0 0A1 1 0 0 0 2 2')).toThrow(/unsupported command "A"/);
    expect(() => parsePathData('M0 0 Z 1 1')).toThrow(/after Z/);
    expect(() => parsePathData('M0 0 L 1 x')).toThrow(/expected number/);
    expect(() => parsePathData('M0 0 L1 1 x')).toThrow(/unsupported command "x"/);
    expect(() => parsePathData('M0 0L1 .')).toThrow(/expected number/);
    expect(() => parsePathData('M0 0L1 -')).toThrow(/expected number/);
    expect(() => parsePathData('M0 0L1 2e')).toThrow(/unsupported command "e"/);
    expect(() => parsePathData('M0 0L1 2#')).toThrow(/expected number/);
  });
});

describe('applyTransform', () => {
  const src: AbsPath = {
    segs: [M(1, 2), L(3, 4), Q(5, 6, 7, 8), C(9, 10, 11, 12, 13, 14), Z],
  };

  it('scales then translates every coordinate including control points', () => {
    const out = applyTransform(src, { sx: 2, sy: -1, tx: 100, ty: 50 });
    expectSegsClose(
      out.segs,
      [M(102, 48), L(106, 46), Q(110, 44, 114, 42), C(118, 40, 122, 38, 126, 36), Z],
      0,
    );
  });

  it('missing fields default to identity and the result is a new object', () => {
    const out = applyTransform(src, {});
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    expect(out.segs).not.toBe(src.segs);
    expect(out.segs[0]).not.toBe(src.segs[0]);
    const only = applyTransform(src, { tx: 1 });
    expect(only.segs[0]).toEqual(M(2, 2));
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(src);
    applyTransform(src, { sx: 3, sy: 3, tx: -7, ty: 9 });
    expect(JSON.stringify(src)).toBe(before);
  });

  it('empty path → empty path', () => {
    expect(applyTransform({ segs: [] }, { sx: 2 })).toEqual({ segs: [] });
  });
});

describe('parseTransform', () => {
  it('parses the potrace translate+scale', () => {
    expect(parseTransform('translate(0.000000,16.000000) scale(0.100000,-0.100000)')).toEqual({
      tx: 0,
      ty: 16,
      sx: 0.1,
      sy: -0.1,
    });
  });

  it('translate only → unit scale; single-argument forms per spec', () => {
    expect(parseTransform('translate(4,4)')).toEqual({ tx: 4, ty: 4, sx: 1, sy: 1 });
    expect(parseTransform('translate(5)')).toEqual({ tx: 5, ty: 0, sx: 1, sy: 1 });
    expect(parseTransform('scale(2)')).toEqual({ tx: 0, ty: 0, sx: 2, sy: 2 });
    expect(parseTransform('scale(2 3)')).toEqual({ tx: 0, ty: 0, sx: 2, sy: 3 });
    expect(parseTransform('translate( 1.5 , -2.5 )')).toEqual({ tx: 1.5, ty: -2.5, sx: 1, sy: 1 });
  });

  it('composes in SVG order when scale comes first (scale(c,d) translate(a,b) → tx=a*c)', () => {
    expect(parseTransform('scale(2,3) translate(4,5)')).toEqual({ tx: 8, ty: 15, sx: 2, sy: 3 });
    expect(parseTransform('translate(4,5) scale(2,3)')).toEqual({ tx: 4, ty: 5, sx: 2, sy: 3 });
    expect(parseTransform('translate(1,1) translate(2,3)')).toEqual({ tx: 3, ty: 4, sx: 1, sy: 1 });
  });

  it('missing, empty, unknown functions or garbage → identity (unknown functions ignored)', () => {
    const id = { tx: 0, ty: 0, sx: 1, sy: 1 };
    expect(parseTransform('')).toEqual(id);
    expect(parseTransform('rotate(45)')).toEqual(id);
    expect(parseTransform('matrix(1 0 0 1 5 5)')).toEqual(id);
    expect(parseTransform('translate(foo,bar)')).toEqual(id);
    expect(parseTransform('translate()')).toEqual(id);
    expect(parseTransform('rotate(45) translate(1,2)')).toEqual({ tx: 1, ty: 2, sx: 1, sy: 1 });
  });
});
