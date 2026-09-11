import { describe, expect, it } from 'vitest';
import type { Gradient, GradientStop, LinearGradient, RadialGradient, RGB } from '../../src/types';
import {
  evaluateFill,
  gradientMeanColor,
  gradientT,
  isDegenerateGradient,
  normalizeStops,
  scaleFill,
  scaleGradient,
  stopColorAt,
} from '../../src/core/fillEval';

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];
const BLUE: RGB = [0x20, 0x40, 0xd0];
const PURPLE: RGB = [0x80, 0x30, 0xc0];

const stop = (offset: number, color: RGB): GradientStop => ({ offset, color: [color[0], color[1], color[2]] });
const ramp = (a: RGB, b: RGB): GradientStop[] => [stop(0, a), stop(1, b)];

function linear(x1: number, y1: number, x2: number, y2: number, stops = ramp(BLACK, WHITE)): LinearGradient {
  return { kind: 'linear', x1, y1, x2, y2, stops };
}

function radial(cx: number, cy: number, r: number, stops = ramp(BLACK, WHITE)): RadialGradient {
  return { kind: 'radial', cx, cy, r, stops };
}

function colorAt(g: Gradient, x: number, y: number): RGB {
  return evaluateFill(g, x, y, [0, 0, 0]);
}

function expectColor(actual: RGB, expected: RGB, digits = 9): void {
  for (let k = 0; k < 3; k++) expect(actual[k], `channel ${k}`).toBeCloseTo(expected[k], digits);
}

describe('gradientT', () => {
  it('linear: 0 at (x1, y1), 1 at (x2, y2), 0.5 halfway, whatever the perpendicular offset', () => {
    const g = linear(10, 20, 50, 50); // d = (40, 30), |d| = 50
    expect(gradientT(g, 10, 20)).toBe(0);
    expect(gradientT(g, 50, 50)).toBe(1);
    expect(gradientT(g, 30, 35)).toBeCloseTo(0.5, 12);
    // (-3, 4) is perpendicular to d: moving along it keeps t.
    expect(gradientT(g, 30 - 3 * 5, 35 + 4 * 5)).toBeCloseTo(0.5, 12);
    expect(gradientT(g, 10 + 40 * 0.25, 20 + 30 * 0.25)).toBeCloseTo(0.25, 12);
  });

  it('linear: pads outside the segment (spreadMethod pad)', () => {
    const g = linear(10, 20, 50, 50);
    expect(gradientT(g, -100, -100)).toBe(0);
    expect(gradientT(g, 90, 80)).toBe(1);
  });

  it('pixel-centre convention: a 4 px ramp from x = 0 to x = 4 samples t = 1/8, 3/8, 5/8, 7/8', () => {
    const g = linear(0, 0, 4, 0);
    expect([0, 1, 2, 3].map((x) => gradientT(g, x + 0.5, 0.5))).toEqual([0.125, 0.375, 0.625, 0.875]);
  });

  it('radial: 0 at the centre, distance / r inside, 1 at r and beyond', () => {
    const g = radial(60, 66, 48);
    expect(gradientT(g, 60, 66)).toBe(0);
    expect(gradientT(g, 60 + 24, 66)).toBeCloseTo(0.5, 12);
    expect(gradientT(g, 60, 66 - 48)).toBe(1);
    expect(gradientT(g, 60 + 30, 66 + 40)).toBe(1); // distance 50
  });

  it('degenerate geometry paints the last stop: |d| = 0 and r = 0 give t = 1', () => {
    expect(gradientT(linear(5, 5, 5, 5), 0, 0)).toBe(1);
    expect(gradientT(radial(5, 5, 0), 5, 5)).toBe(1);
    expect(gradientT(radial(5, 5, -3), 5, 5)).toBe(1);
    expect(gradientT(linear(0, 0, 10, 0), Number.NaN, 0)).toBe(0);
  });
});

describe('stopColorAt', () => {
  const three = [stop(0.2, [0, 100, 200]), stop(0.6, [200, 100, 0]), stop(0.8, [100, 50, 25])];

  it('interpolates linearly in sRGB between the surrounding stops', () => {
    expectColor(stopColorAt(three, 0.4, [0, 0, 0]), [100, 100, 100]);
    expectColor(stopColorAt(three, 0.7, [0, 0, 0]), [150, 75, 12.5]);
    expectColor(stopColorAt(three, 0.6, [0, 0, 0]), [200, 100, 0]);
  });

  it('uses the end stops before the first and after the last offset', () => {
    expectColor(stopColorAt(three, 0, [9, 9, 9]), [0, 100, 200]);
    expectColor(stopColorAt(three, 0.2, [9, 9, 9]), [0, 100, 200]);
    expectColor(stopColorAt(three, 0.95, [9, 9, 9]), [100, 50, 25]);
    expectColor(stopColorAt(three, 1, [9, 9, 9]), [100, 50, 25]);
  });

  it('two stops at one offset: below it the ramp heads to the first, at it the later colour wins', () => {
    const hard = [stop(0, BLACK), stop(0.5, [100, 100, 100]), stop(0.5, WHITE), stop(1, WHITE)];
    expectColor(stopColorAt(hard, 0.25, [0, 0, 0]), [50, 50, 50]);
    expectColor(stopColorAt(hard, 0.5, [0, 0, 0]), WHITE);
  });

  it('writes into `out`, returns it and never touches the stops; no stops gives black', () => {
    const out: RGB = [1, 2, 3];
    const stops = ramp(BLUE, PURPLE);
    expect(stopColorAt(stops, 0.5, out)).toBe(out);
    expect(stops).toEqual(ramp(BLUE, PURPLE));
    expect(stopColorAt([], 0.5, [7, 7, 7])).toEqual([0, 0, 0]);
    expectColor(stopColorAt([stop(0.3, BLUE)], 0.9, [0, 0, 0]), BLUE);
  });
});

describe('evaluateFill', () => {
  it('a solid fill is the same everywhere', () => {
    expect(evaluateFill({ kind: 'solid', color: [0x20, 0x22, 0x2a] }, 1e6, -3, [0, 0, 0])).toEqual([0x20, 0x22, 0x2a]);
  });

  it('2-stop linear ramp: first stop at (x1, y1), last at (x2, y2), mean halfway, padded outside', () => {
    const g = linear(8, 8, 108, 8, ramp(BLUE, PURPLE));
    expectColor(colorAt(g, 8, 40), BLUE);
    expectColor(colorAt(g, 108, 0), PURPLE);
    expectColor(colorAt(g, 58, 8), [(BLUE[0] + PURPLE[0]) / 2, (BLUE[1] + PURPLE[1]) / 2, (BLUE[2] + PURPLE[2]) / 2]);
    expectColor(colorAt(g, -50, 8), BLUE);
    expectColor(colorAt(g, 400, 8), PURPLE);
  });

  it('radial: centre = first stop, middle stop halfway, edge and outside = last stop', () => {
    const stops = [stop(0, [0xff, 0xe0, 0x8a]), stop(0.5, [0xff, 0x7a, 0x3d]), stop(1, [0x7a, 0x1f, 0xa2])];
    const g = radial(60, 66, 48, stops);
    expectColor(colorAt(g, 60, 66), [0xff, 0xe0, 0x8a]);
    expectColor(colorAt(g, 60, 66 + 24), [0xff, 0x7a, 0x3d]);
    expectColor(colorAt(g, 60 + 48, 66), [0x7a, 0x1f, 0xa2]);
    expectColor(colorAt(g, 0, 0), [0x7a, 0x1f, 0xa2]);
  });

  it('a degenerate gradient paints its last stop', () => {
    expectColor(colorAt(linear(3, 3, 3, 3, ramp(BLUE, PURPLE)), 0, 0), PURPLE);
    expectColor(colorAt(radial(3, 3, 0, ramp(BLUE, PURPLE)), 3, 3), PURPLE);
  });
});

describe('scaleGradient / scaleFill', () => {
  it('multiplies coordinates and r by s and copies the stops', () => {
    const g = linear(1, 2, 3, 4, ramp(BLUE, PURPLE));
    const s = scaleGradient(g, 4);
    expect(s).toEqual({ kind: 'linear', x1: 4, y1: 8, x2: 12, y2: 16, stops: ramp(BLUE, PURPLE) });
    expect(s.stops).not.toBe(g.stops);
    expect(s.stops[0].color).not.toBe(g.stops[0].color);
    expect(g).toEqual(linear(1, 2, 3, 4, ramp(BLUE, PURPLE)));
    expect(scaleGradient(radial(10, 20, 5), 0.5)).toEqual(radial(5, 10, 2.5));
    const solid = scaleFill({ kind: 'solid', color: [1, 2, 3] }, 4);
    expect(solid).toEqual({ kind: 'solid', color: [1, 2, 3] });
    expect(scaleFill(radial(1, 1, 1), 3)).toEqual(radial(3, 3, 3));
  });

  it('convention: at U× pixel centres the scaled fill equals the 1× fill at ((X + 0.5)/U, (Y + 0.5)/U)', () => {
    const fills: Gradient[] = [
      linear(3.2, 1.7, 9.9, 6.1, ramp(BLUE, PURPLE)),
      radial(5.25, 4.5, 3.75, [stop(0, WHITE), stop(0.4, BLUE), stop(1, PURPLE)]),
    ];
    for (const g1 of fills) {
      for (const U of [1, 2, 4]) {
        const gU = scaleGradient(g1, U);
        for (let Y = 0; Y < 12 * U; Y++) {
          for (let X = 0; X < 12 * U; X++) {
            const a = colorAt(gU, X + 0.5, Y + 0.5);
            const b = colorAt(g1, (X + 0.5) / U, (Y + 0.5) / U);
            for (let k = 0; k < 3; k++) expect(Math.abs(a[k] - b[k])).toBeLessThan(1e-9);
          }
        }
      }
    }
  });
});

describe('gradientMeanColor', () => {
  it('the mean of a 0 → 255 ramp is 127.5', () => {
    expect(gradientMeanColor(linear(0, 0, 1, 0, ramp(BLACK, WHITE)))).toEqual([127.5, 127.5, 127.5]);
  });

  it('integrates the constant ends and every segment over t in [0, 1]', () => {
    // 0 up to 0.25, ramp to 255 at 0.75, 255 after: 0.5 · 127.5 + 0.25 · 255 = 127.5.
    expect(gradientMeanColor(radial(0, 0, 1, [stop(0.25, BLACK), stop(0.75, WHITE)]))).toEqual([127.5, 127.5, 127.5]);
    // Triangle 0 → 255 → 0: 127.5. Blue → purple: the midpoint colour.
    expect(gradientMeanColor(linear(0, 0, 1, 0, [stop(0, BLACK), stop(0.5, WHITE), stop(1, BLACK)]))[0]).toBeCloseTo(127.5, 12);
    expectColor(gradientMeanColor(linear(0, 0, 1, 0, ramp(BLUE, PURPLE))), [80, 56, 200]);
    // Constant 0 for 90 % of the ramp, then 255.
    expect(gradientMeanColor(linear(0, 0, 1, 0, [stop(0, BLACK), stop(0.9, BLACK), stop(0.9, WHITE)]))[0]).toBeCloseTo(25.5, 12);
  });

  it('one stop: its colour; no stops: black', () => {
    expect(gradientMeanColor(linear(0, 0, 1, 0, [stop(0.3, BLUE)]))).toEqual(BLUE);
    expect(gradientMeanColor(linear(0, 0, 1, 0, []))).toEqual([0, 0, 0]);
  });
});

describe('isDegenerateGradient', () => {
  it('a real ramp is not degenerate', () => {
    expect(isDegenerateGradient(linear(0, 0, 10, 0, ramp(BLUE, PURPLE)))).toBe(false);
    expect(isDegenerateGradient(radial(0, 0, 10, ramp(BLUE, PURPLE)))).toBe(false);
    expect(isDegenerateGradient(linear(0, 0, 1e-3, 0, ramp([10, 10, 10], [10, 10, 12])))).toBe(false);
  });

  it('degenerate: zero-length axis, zero radius, fewer than 2 stops, colours within 1 level, non-finite', () => {
    expect(isDegenerateGradient(linear(4, 4, 4, 4 + 1e-7, ramp(BLUE, PURPLE)))).toBe(true);
    expect(isDegenerateGradient(radial(4, 4, 5e-7, ramp(BLUE, PURPLE)))).toBe(true);
    expect(isDegenerateGradient(radial(4, 4, -1, ramp(BLUE, PURPLE)))).toBe(true);
    expect(isDegenerateGradient(linear(0, 0, 10, 0, [stop(0, BLUE)]))).toBe(true);
    expect(isDegenerateGradient(linear(0, 0, 10, 0, []))).toBe(true);
    expect(isDegenerateGradient(linear(0, 0, 10, 0, [stop(0, [10, 20, 30]), stop(0.5, [11, 19, 31]), stop(1, [10, 20, 30])]))).toBe(true);
    expect(isDegenerateGradient(linear(0, 0, Number.NaN, 0, ramp(BLUE, PURPLE)))).toBe(true);
    expect(isDegenerateGradient(radial(0, Number.POSITIVE_INFINITY, 3, ramp(BLUE, PURPLE)))).toBe(true);
  });
});

describe('normalizeStops', () => {
  it('clamps offsets to [0, 1] and makes them non-decreasing', () => {
    const out = normalizeStops([stop(-0.5, BLACK), stop(0.6, BLUE), stop(0.4, PURPLE), stop(1.7, WHITE)]);
    expect(out.map((s) => s.offset)).toEqual([0, 0.6, 0.6, 1]);
    // 0.4 is raised to 0.6: a hard stop from BLUE to PURPLE, as SVG draws it.
    expect(out.map((s) => s.color)).toEqual([BLACK, BLUE, PURPLE, WHITE]);
  });

  it('keeps a hard stop (two stops at one offset), keeps the first and last of a longer run, clamps colours and never mutates the input', () => {
    const input = [stop(0, BLACK), stop(0.5, BLUE), stop(0.5, PURPLE), stop(1, [300, -4, Number.NaN])];
    const frozen = JSON.stringify(input);
    const out = normalizeStops(input);
    expect(out).toEqual([stop(0, BLACK), stop(0.5, BLUE), stop(0.5, PURPLE), stop(1, [255, 0, 0])]);
    // A run of three at 0.5: the middle one is never visible (stopColorAt and SVG use the first below and the last from there).
    expect(normalizeStops([stop(0, BLACK), stop(0.5, BLUE), stop(0.5, WHITE), stop(0.5, PURPLE), stop(1, BLACK)])).toEqual([
      stop(0, BLACK),
      stop(0.5, BLUE),
      stop(0.5, PURPLE),
      stop(1, BLACK),
    ]);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(out[0].color).not.toBe(input[0].color);
    expect(normalizeStops([stop(Number.NaN, BLUE), stop(0.25, PURPLE)])).toEqual([stop(0, BLUE), stop(0.25, PURPLE)]);
    expect(normalizeStops([])).toEqual([]);
  });
});
