import { describe, expect, it } from 'vitest';
import type { AbsPath, Gradient, GradientStop, Layer, RasterImage, RGB } from '../../src/types';
import { evaluateFill } from '../../src/core/fillEval';
import { flattenPath, rasterizeLayers, rasterizeMask } from '../../src/metrics/scanline';

/** Axis-aligned rectangle [x0,x1) x [y0,y1); `ccw` reverses the orientation. */
function rectPath(x0: number, y0: number, x1: number, y1: number, ccw = false): AbsPath {
  const pts: Array<[number, number]> = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  if (ccw) pts.reverse();
  return {
    segs: [
      { kind: 'M', x: pts[0][0], y: pts[0][1] },
      { kind: 'L', x: pts[1][0], y: pts[1][1] },
      { kind: 'L', x: pts[2][0], y: pts[2][1] },
      { kind: 'L', x: pts[3][0], y: pts[3][1] },
      { kind: 'Z' },
    ],
  };
}

const KAPPA = 0.5522847498307936; // 4/3 * (sqrt(2) - 1)

/** Circle as 4 cubic Béziers (max radial error ~2.7e-4 r). */
function circlePath(cx: number, cy: number, r: number): AbsPath {
  const k = KAPPA * r;
  return {
    segs: [
      { kind: 'M', x: cx + r, y: cy },
      { kind: 'C', x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x: cx, y: cy + r },
      { kind: 'C', x1: cx - k, y1: cy + r, x2: cx - r, y2: cy + k, x: cx - r, y: cy },
      { kind: 'C', x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x: cx, y: cy - r },
      { kind: 'C', x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x: cx + r, y: cy },
      { kind: 'Z' },
    ],
  };
}

function at(img: { data: ArrayLike<number>; width: number }, x: number, y: number): number {
  return img.data[y * img.width + x];
}

function px(img: RasterImage, x: number, y: number): [number, number, number, number] {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

function total(img: { data: Float32Array }): number {
  let s = 0;
  for (let i = 0; i < img.data.length; i++) s += img.data[i];
  return s;
}

describe('flattenPath', () => {
  it('lines: one closed polyline per subpath, explicit close point dropped', () => {
    const p: AbsPath = {
      segs: [
        { kind: 'M', x: 1, y: 2 },
        { kind: 'L', x: 5, y: 2 },
        { kind: 'L', x: 5, y: 6 },
        { kind: 'L', x: 1, y: 2 },
        { kind: 'Z' },
        { kind: 'M', x: 10, y: 10 },
        { kind: 'L', x: 12, y: 10 },
        { kind: 'L', x: 12, y: 12 },
      ],
    };
    const polys = flattenPath(p);
    expect(polys).toEqual([
      [
        [1, 2],
        [5, 2],
        [5, 6],
      ],
      [
        [10, 10],
        [12, 10],
        [12, 12],
      ],
    ]);
  });

  it('a segment after Z starts a new subpath at the previous start point (SVG semantics)', () => {
    const p: AbsPath = {
      segs: [
        { kind: 'M', x: 0, y: 0 },
        { kind: 'L', x: 4, y: 0 },
        { kind: 'L', x: 4, y: 4 },
        { kind: 'Z' },
        { kind: 'L', x: 0, y: 4 },
        { kind: 'L', x: -4, y: 4 },
      ],
    };
    const polys = flattenPath(p);
    expect(polys.length).toBe(2);
    expect(polys[1][0]).toEqual([0, 0]);
    expect(polys[1]).toEqual([
      [0, 0],
      [0, 4],
      [-4, 4],
    ]);
  });

  it('drops degenerate subpaths and merges duplicate vertices', () => {
    const p: AbsPath = {
      segs: [
        { kind: 'M', x: 3, y: 3 },
        { kind: 'Z' },
        { kind: 'M', x: 5, y: 5 },
        { kind: 'L', x: 5, y: 5 },
        { kind: 'M', x: 0, y: 0 },
        { kind: 'L', x: 0, y: 0 },
        { kind: 'L', x: 2, y: 0 },
        { kind: 'L', x: 2, y: 0 },
        { kind: 'L', x: 2, y: 2 },
        { kind: 'Z' },
      ],
    };
    expect(flattenPath(p)).toEqual([
      [
        [0, 0],
        [2, 0],
        [2, 2],
      ],
    ]);
    expect(flattenPath({ segs: [] })).toEqual([]);
  });

  it('quadratic: endpoints exact, every vertex within tolerance of the true curve', () => {
    const p: AbsPath = {
      segs: [
        { kind: 'M', x: 0, y: 0 },
        { kind: 'Q', x1: 20, y1: 40, x: 40, y: 0 },
      ],
    };
    const [poly] = flattenPath(p, 0.1);
    expect(poly[0]).toEqual([0, 0]);
    expect(poly[poly.length - 1]).toEqual([40, 0]);
    expect(poly.length).toBeGreaterThan(8);
    // The curve is y = 2x - x²/20 (parabola); vertices lie on it within 1e-9 (subdivision is exact).
    for (const [x, y] of poly) {
      expect(Math.abs(y - (2 * x - (x * x) / 20))).toBeLessThan(1e-9);
    }
    // Chord deviation: the midpoint of each polyline edge is within tol of the curve.
    for (let i = 1; i < poly.length; i++) {
      const mx = (poly[i - 1][0] + poly[i][0]) / 2;
      const my = (poly[i - 1][1] + poly[i][1]) / 2;
      expect(Math.abs(my - (2 * mx - (mx * mx) / 20))).toBeLessThan(0.1 + 1e-9);
    }
    // A coarser tolerance yields fewer points.
    expect(flattenPath(p, 1)[0].length).toBeLessThan(poly.length);
  });

  it('cubic circle: vertices at radius r (+-3e-3), edge midpoints within tol, sane count', () => {
    const [poly] = flattenPath(circlePath(32, 32, 20), 0.1);
    expect(poly.length).toBeGreaterThan(16);
    expect(poly.length).toBeLessThan(2000);
    for (const [x, y] of poly) {
      const r = Math.hypot(x - 32, y - 32);
      expect(Math.abs(r - 20)).toBeLessThan(0.006); // Bézier circle approximation error (2.7e-4 r)
    }
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const r = Math.hypot((a[0] + b[0]) / 2 - 32, (a[1] + b[1]) / 2 - 32);
      expect(20 - r).toBeLessThan(0.1 + 0.006);
    }
  });

  it('degenerate curves (all control points equal) do not explode', () => {
    const p: AbsPath = {
      segs: [
        { kind: 'M', x: 1, y: 1 },
        { kind: 'C', x1: 1, y1: 1, x2: 1, y2: 1, x: 1, y: 1 },
        { kind: 'Q', x1: 1, y1: 1, x: 1, y: 1 },
        { kind: 'L', x: 3, y: 1 },
      ],
    };
    expect(flattenPath(p)).toEqual([
      [
        [1, 1],
        [3, 1],
      ],
    ]);
    // Non-finite control points terminate immediately as well.
    const bad: AbsPath = {
      segs: [
        { kind: 'M', x: 0, y: 0 },
        { kind: 'C', x1: Number.NaN, y1: 0, x2: 1, y2: 1, x: 4, y: 4 },
      ],
    };
    expect(flattenPath(bad)[0].length).toBe(2);
  });

  it('recursion is capped at depth 16 for a huge curve with a tiny tolerance', () => {
    const p: AbsPath = {
      segs: [
        { kind: 'M', x: 0, y: 0 },
        { kind: 'C', x1: 0, y1: 1e6, x2: 1e6, y2: 1e6, x: 1e6, y: 0 },
      ],
    };
    const [poly] = flattenPath(p, 1e-9);
    expect(poly.length).toBeLessThanOrEqual(65537);
    expect(poly.length).toBeGreaterThan(1000);
  });
});

describe('rasterizeMask', () => {
  it('integer axis-aligned rect (4,4)-(12,12) is pixel-exact in both orientations', () => {
    for (const ccw of [false, true]) {
      const cov = rasterizeMask([rectPath(4, 4, 12, 12, ccw)], 16, 16);
      expect([cov.width, cov.height]).toEqual([16, 16]);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const inside = x >= 4 && x < 12 && y >= 4 && y < 12;
          expect(at(cov, x, y)).toBe(inside ? 255 : 0);
        }
      }
    }
  });

  it('rect exactness holds for supersample 1, 3, 7 and 8', () => {
    for (const S of [1, 3, 7, 8]) {
      const cov = rasterizeMask([rectPath(4, 4, 12, 12)], 16, 16, S);
      expect(at(cov, 4, 4)).toBe(255);
      expect(at(cov, 11, 11)).toBe(255);
      expect(at(cov, 3, 4)).toBe(0);
      expect(at(cov, 12, 11)).toBe(0);
      expect(at(cov, 4, 3)).toBe(0);
      expect(at(cov, 4, 12)).toBe(0);
      expect(total(cov)).toBe(64 * 255);
    }
  });

  it('half-pixel horizontal offsets give exact partial coverage (127.5)', () => {
    const cov = rasterizeMask([rectPath(4.5, 4, 12.5, 12)], 16, 16);
    expect(at(cov, 4, 6)).toBeCloseTo(127.5, 3);
    expect(at(cov, 12, 6)).toBeCloseTo(127.5, 3);
    for (let x = 5; x < 12; x++) expect(at(cov, x, 6)).toBe(255);
    expect(at(cov, 3, 6)).toBe(0);
    expect(at(cov, 13, 6)).toBe(0);
    // Quarter pixel: 0.25 * 255 = 63.75.
    const q = rasterizeMask([rectPath(4.75, 4, 12, 12)], 16, 16);
    expect(at(q, 4, 6)).toBeCloseTo(63.75, 3);
  });

  it('half-pixel vertical offsets: 2 of 4 sub-scanlines inside -> 127.5', () => {
    const cov = rasterizeMask([rectPath(4, 4.5, 12, 12)], 16, 16);
    expect(at(cov, 6, 4)).toBeCloseTo(127.5, 3);
    expect(at(cov, 6, 5)).toBe(255);
    expect(at(cov, 6, 3)).toBe(0);
    // With S = 8 a 1/8 offset gives 7/8 coverage.
    const c8 = rasterizeMask([rectPath(4, 4.125, 12, 12)], 16, 16, 8);
    expect(at(c8, 6, 4)).toBeCloseTo((7 / 8) * 255, 3);
  });

  it('circle r=20 in 64²: area within 1 % of πr², intermediate edge values, exact interior', () => {
    const cov = rasterizeMask([circlePath(32, 32, 20)], 64, 64);
    const area = total(cov) / 255;
    expect(Math.abs(area - Math.PI * 400) / (Math.PI * 400)).toBeLessThan(0.01);
    expect(at(cov, 32, 32)).toBe(255);
    expect(at(cov, 20, 32)).toBe(255);
    expect(at(cov, 0, 0)).toBe(0);
    expect(at(cov, 63, 63)).toBe(0);
    let partial = 0;
    for (let i = 0; i < cov.data.length; i++) {
      const v = cov.data[i];
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
      if (v > 0 && v < 255) partial++;
    }
    // Roughly the perimeter (2πr ≈ 126) worth of anti-aliased pixels.
    expect(partial).toBeGreaterThan(60);
    expect(partial).toBeLessThan(260);
    // Left/right symmetry of coverage (x mirrored about the centre).
    for (let y = 8; y < 56; y += 4) {
      expect(Math.abs(at(cov, 12, y) - at(cov, 51, y))).toBeLessThan(1.5);
    }
    // S = 8 still within 1 %.
    const c8 = rasterizeMask([circlePath(32, 32, 20)], 64, 64, 8);
    expect(Math.abs(total(c8) / 255 - Math.PI * 400) / (Math.PI * 400)).toBeLessThan(0.01);
  });

  it('nonzero winding: opposite-orientation inner square is a hole, same orientation is filled', () => {
    const outer = rectPath(2, 2, 14, 14);
    const holeInner = rectPath(6, 6, 10, 10, true);
    const sameInner = rectPath(6, 6, 10, 10, false);
    const withHole = rasterizeMask([outer, holeInner], 16, 16);
    expect(at(withHole, 8, 8)).toBe(0);
    expect(at(withHole, 6, 6)).toBe(0);
    expect(at(withHole, 9, 9)).toBe(0);
    expect(at(withHole, 4, 4)).toBe(255);
    expect(at(withHole, 10, 10)).toBe(255);
    expect(at(withHole, 5, 8)).toBe(255);
    expect(total(withHole)).toBe((144 - 16) * 255);
    const filled = rasterizeMask([outer, sameInner], 16, 16);
    expect(at(filled, 8, 8)).toBe(255);
    expect(at(filled, 4, 4)).toBe(255);
    expect(total(filled)).toBe(144 * 255);
    // Two subpaths inside one path behave the same as two paths.
    const combined: AbsPath = { segs: [...outer.segs, ...holeInner.segs] };
    expect(total(rasterizeMask([combined], 16, 16))).toBe((144 - 16) * 255);
  });

  it('skips horizontal edges: a path made only of horizontal moves covers nothing', () => {
    const flat: AbsPath = {
      segs: [
        { kind: 'M', x: 1, y: 5 },
        { kind: 'L', x: 10, y: 5 },
        { kind: 'L', x: 14, y: 5 },
        { kind: 'Z' },
      ],
    };
    expect(total(rasterizeMask([flat], 16, 16))).toBe(0);
    // A triangle with a horizontal base still fills correctly (base at y = 12, apex at (8, 4)).
    const tri: AbsPath = {
      segs: [
        { kind: 'M', x: 2, y: 12 },
        { kind: 'L', x: 14, y: 12 },
        { kind: 'L', x: 8, y: 4 },
        { kind: 'Z' },
      ],
    };
    const cov = rasterizeMask([tri], 16, 16);
    expect(Math.abs(total(cov) / 255 - 48)).toBeLessThan(0.5); // area 12*8/2
    expect(at(cov, 8, 10)).toBe(255);
    expect(at(cov, 8, 12)).toBe(0);
  });

  it('vertices exactly on sample lines use the half-open convention (no double counting)', () => {
    // Diamond with all vertices on sub-scanlines y = k + 0.125 (S = 4 samples at .125/.375/.625/.875).
    const diamond: AbsPath = {
      segs: [
        { kind: 'M', x: 8, y: 2.125 },
        { kind: 'L', x: 14, y: 8.125 },
        { kind: 'L', x: 8, y: 14.125 },
        { kind: 'L', x: 2, y: 8.125 },
        { kind: 'Z' },
      ],
    };
    const cov = rasterizeMask([diamond], 16, 16);
    for (let i = 0; i < cov.data.length; i++) {
      expect(cov.data[i]).toBeGreaterThanOrEqual(0);
      expect(cov.data[i]).toBeLessThanOrEqual(255);
    }
    const area = total(cov) / 255;
    expect(Math.abs(area - 72) / 72).toBeLessThan(0.02); // d1*d2/2 = 12*12/2
    // Row through the top vertex: the sample at y=2.125 sees a zero-width span.
    expect(at(cov, 8, 2)).toBeLessThan(255);
    expect(at(cov, 8, 8)).toBe(255);
    // Rect whose top/bottom edges sit exactly on sample lines (S=4 samples at .125/.375/.625/.875):
    // ymin <= y counts (row 4 sees all 4 samples), y < ymax excludes the bottom sample (row 12 sees 0).
    const r = rasterizeMask([rectPath(4, 4.125, 12, 12.125)], 16, 16);
    expect(at(r, 6, 3)).toBe(0);
    expect(at(r, 6, 4)).toBe(255);
    expect(at(r, 6, 11)).toBe(255);
    expect(at(r, 6, 12)).toBe(0);
    expect(total(r)).toBe(64 * 255); // area preserved: 8 full rows
    // Shifting by one more sample moves exactly one sub-scanline of coverage between rows.
    const r2 = rasterizeMask([rectPath(4, 4.375, 12, 12.375)], 16, 16);
    expect(at(r2, 6, 4)).toBeCloseTo(255 * 0.75, 3);
    expect(at(r2, 6, 12)).toBeCloseTo(255 * 0.25, 3);
  });

  it('clips to the image: shapes partly or fully outside, negative or huge coordinates', () => {
    const cov = rasterizeMask([rectPath(-10, -10, 4, 4)], 8, 8);
    expect(at(cov, 0, 0)).toBe(255);
    expect(at(cov, 3, 3)).toBe(255);
    expect(at(cov, 4, 4)).toBe(0);
    expect(total(cov)).toBe(16 * 255);
    const off = rasterizeMask([rectPath(20, 20, 30, 30), rectPath(-5, 0, -1, 8)], 8, 8);
    expect(total(off)).toBe(0);
    const huge = rasterizeMask([rectPath(-1e9, -1e9, 1e9, 1e9)], 8, 8);
    expect(total(huge)).toBe(64 * 255);
  });

  it('empty input, degenerate paths and zero-sized images', () => {
    expect(total(rasterizeMask([], 8, 8))).toBe(0);
    expect(total(rasterizeMask([{ segs: [{ kind: 'M', x: 2, y: 2 }] }], 8, 8))).toBe(0);
    const z = rasterizeMask([rectPath(0, 0, 4, 4)], 0, 5);
    expect([z.width, z.height, z.data.length]).toEqual([0, 5, 0]);
    const nan: AbsPath = {
      segs: [
        { kind: 'M', x: 0, y: 0 },
        { kind: 'L', x: Number.NaN, y: 4 },
        { kind: 'L', x: 4, y: 4 },
        { kind: 'Z' },
      ],
    };
    const c = rasterizeMask([nan], 8, 8);
    for (let i = 0; i < c.data.length; i++) expect(Number.isNaN(c.data[i])).toBe(false);
  });

  it('does not mutate the input paths', () => {
    const p = circlePath(8, 8, 5);
    const before = JSON.stringify(p);
    rasterizeMask([p], 16, 16);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe('rasterizeLayers', () => {
  it('opaque background: fill where covered, background elsewhere, AA edges blended', () => {
    const layers: Layer[] = [{ fill: '#000000', paths: [rectPath(4, 4, 12.5, 12)] }];
    const img = rasterizeLayers(layers, 16, 16, [255, 255, 255]);
    expect([img.width, img.height, img.data.length]).toEqual([16, 16, 16 * 16 * 4]);
    expect(px(img, 6, 6)).toEqual([0, 0, 0, 255]);
    expect(px(img, 1, 1)).toEqual([255, 255, 255, 255]);
    expect(px(img, 3, 6)).toEqual([255, 255, 255, 255]);
    const edge = px(img, 12, 6);
    expect(Math.abs(edge[0] - 127.5)).toBeLessThanOrEqual(0.5);
    expect(edge[3]).toBe(255);
    // Every alpha is 255.
    for (let o = 3; o < img.data.length; o += 4) expect(img.data[o]).toBe(255);
  });

  it('transparent background: alpha = coverage, colour stays the straight fill colour', () => {
    const layers: Layer[] = [{ fill: '#ff8000', paths: [rectPath(4, 4, 12.5, 12)] }];
    const img = rasterizeLayers(layers, 16, 16, null);
    expect(px(img, 6, 6)).toEqual([255, 128, 0, 255]);
    expect(px(img, 1, 1)).toEqual([0, 0, 0, 0]);
    const edge = px(img, 12, 6);
    expect(Math.abs(edge[3] - 127.5)).toBeLessThanOrEqual(0.5);
    expect(edge[0]).toBe(255); // not premultiplied
    expect(edge[1]).toBe(128);
    expect(edge[2]).toBe(0);
  });

  it('composites back to front: later layers cover earlier ones, alpha is the union', () => {
    const layers: Layer[] = [
      { fill: '#ff0000', paths: [rectPath(0, 0, 8, 8)] },
      { fill: '#0000ff', paths: [rectPath(4, 4, 12, 12)] },
    ];
    const img = rasterizeLayers(layers, 16, 16, null);
    expect(px(img, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(px(img, 6, 6)).toEqual([0, 0, 255, 255]);
    expect(px(img, 10, 10)).toEqual([0, 0, 255, 255]);
    expect(px(img, 14, 14)).toEqual([0, 0, 0, 0]);
    // Half-covered pixel of the top layer over a fully covered bottom layer: alpha stays 255,
    // colour is the straight blend.
    const layers2: Layer[] = [
      { fill: '#ff0000', paths: [rectPath(0, 0, 16, 16)] },
      { fill: '#0000ff', paths: [rectPath(4.5, 4, 12, 12)] },
    ];
    const img2 = rasterizeLayers(layers2, 16, 16, null);
    const p = px(img2, 4, 6);
    expect(p[3]).toBe(255);
    expect(Math.abs(p[0] - 127.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(p[2] - 127.5)).toBeLessThanOrEqual(0.5);
    expect(p[1]).toBe(0);
  });

  it('layer opacity scales the coverage', () => {
    const layers: Layer[] = [{ fill: '#ff0000', opacity: 0.5, paths: [rectPath(0, 0, 8, 8)] }];
    const onWhite = rasterizeLayers(layers, 8, 8, [255, 255, 255]);
    const p = px(onWhite, 3, 3);
    expect(p[0]).toBe(255);
    expect(Math.abs(p[1] - 127.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(p[2] - 127.5)).toBeLessThanOrEqual(0.5);
    expect(p[3]).toBe(255);
    const onNothing = rasterizeLayers(layers, 8, 8, null);
    const q = px(onNothing, 3, 3);
    expect(q[0]).toBe(255);
    expect(q[1]).toBe(0);
    expect(q[2]).toBe(0);
    expect(Math.abs(q[3] - 127.5)).toBeLessThanOrEqual(0.5);
    // Opacity 0 layers contribute nothing.
    const none = rasterizeLayers([{ fill: '#ff0000', opacity: 0, paths: [rectPath(0, 0, 8, 8)] }], 8, 8, null);
    expect(px(none, 3, 3)).toEqual([0, 0, 0, 0]);
  });

  it('accepts #rgb shorthand and custom backgrounds; rejects invalid fills', () => {
    const img = rasterizeLayers([{ fill: '#F80', paths: [rectPath(0, 0, 2, 2)] }], 4, 4, [10, 20, 30]);
    expect(px(img, 0, 0)).toEqual([255, 136, 0, 255]);
    expect(px(img, 3, 3)).toEqual([10, 20, 30, 255]);
    expect(() => rasterizeLayers([{ fill: 'red', paths: [rectPath(0, 0, 2, 2)] }], 4, 4, null)).toThrow(
      /relleno/,
    );
    expect(() => rasterizeLayers([{ fill: '#12345', paths: [] }], 4, 4, null)).toThrow(/relleno/);
  });

  it('no layers -> plain background or fully transparent; empty image sizes are safe', () => {
    const bg = rasterizeLayers([], 3, 2, [1, 2, 3]);
    for (let i = 0; i < 6; i++) expect(px(bg, i % 3, Math.floor(i / 3))).toEqual([1, 2, 3, 255]);
    const tr = rasterizeLayers([], 3, 2, null);
    for (let i = 0; i < tr.data.length; i++) expect(tr.data[i]).toBe(0);
    const empty = rasterizeLayers([{ fill: '#000000', paths: [rectPath(0, 0, 2, 2)] }], 0, 0, null);
    expect([empty.width, empty.height, empty.data.length]).toEqual([0, 0, 0]);
  });

  it('circle layer on white matches the union coverage of rasterizeMask', () => {
    const paths = [circlePath(32, 32, 20)];
    const cov = rasterizeMask(paths, 64, 64);
    const img = rasterizeLayers([{ fill: '#000000', paths }], 64, 64, [255, 255, 255]);
    for (let i = 0; i < 64 * 64; i++) {
      const expected = 255 - cov.data[i];
      expect(Math.abs(img.data[i * 4] - expected)).toBeLessThanOrEqual(0.51);
    }
  });
});

/** Full-image rectangle painted by `gradient`; `fill` is its reserve colour. */
function gradientLayer(w: number, h: number, gradient: Gradient, fill = '#808080'): Layer {
  return { fill, gradient, paths: [rectPath(0, 0, w, h)] };
}

/** 0..255 with NaN -> 0, what an SVG stop-color can hold. */
function level(v: number): number {
  return v > 0 ? (v < 255 ? v : 255) : 0;
}

/** Largest channel difference between an opaque raster and evaluateFill (clamped) at every pixel centre. */
function maxDiffFromEvaluateFill(img: RasterImage, g: Gradient): number {
  const c: RGB = [0, 0, 0];
  let worst = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      evaluateFill(g, x + 0.5, y + 0.5, c);
      const p = px(img, x, y);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(p[k] - level(c[k])));
    }
  }
  return worst;
}

const GRAY_RAMP: GradientStop[] = [
  { offset: 0, color: [0, 0, 0] },
  { offset: 1, color: [255, 255, 255] },
];

describe('rasterizeLayers with gradients', () => {
  it('64x16 rect, linear 0 -> 255 from x1 = 0 to x2 = 64: column x = round(255 (x + 0.5) / 64) +- 1', () => {
    const g: Gradient = { kind: 'linear', x1: 0, y1: 0, x2: 64, y2: 0, stops: GRAY_RAMP };
    for (const bg of [[255, 255, 255], [10, 200, 30], null] as Array<RGB | null>) {
      const img = rasterizeLayers([gradientLayer(64, 16, g)], 64, 16, bg);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 64; x++) {
          const expected = Math.round((255 * (x + 0.5)) / 64);
          const p = px(img, x, y);
          for (let k = 0; k < 3; k++) expect(Math.abs(p[k] - expected)).toBeLessThanOrEqual(1);
          expect(p[3]).toBe(255);
        }
      }
    }
  });

  it('linear from x1 = 16 to x2 = 48: first colour before x1, last colour after x2 (pad), ramp between', () => {
    const g: Gradient = { kind: 'linear', x1: 16, y1: 5, x2: 48, y2: 5, stops: GRAY_RAMP };
    const img = rasterizeLayers([gradientLayer(64, 16, g)], 64, 16, [255, 0, 0]);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 64; x++) {
        const p = px(img, x, y);
        if (x + 0.5 <= 16) expect(p).toEqual([0, 0, 0, 255]);
        else if (x + 0.5 >= 48) expect(p).toEqual([255, 255, 255, 255]);
        else {
          const expected = Math.round((255 * (x + 0.5 - 16)) / 32);
          for (let k = 0; k < 3; k++) expect(Math.abs(p[k] - expected)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('radial: centre pixel = first stop, rho >= r = last stop (pad), halfway between stops interpolated', () => {
    const stops: GradientStop[] = [
      { offset: 0, color: [255, 220, 0] },
      { offset: 0.5, color: [230, 20, 40] },
      { offset: 1, color: [10, 20, 110] },
    ];
    const g: Gradient = { kind: 'radial', cx: 32.5, cy: 32.5, r: 20, stops };
    const img = rasterizeLayers([gradientLayer(64, 64, g)], 64, 64, [255, 255, 255]);
    const centre = px(img, 32, 32);
    [255, 220, 0].forEach((v, k) => expect(Math.abs(centre[k] - v)).toBeLessThanOrEqual(1));
    let padded = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (Math.hypot(x + 0.5 - 32.5, y + 0.5 - 32.5) < 20) continue;
        expect(px(img, x, y)).toEqual([10, 20, 110, 255]);
        padded++;
      }
    }
    expect(padded).toBeGreaterThan(2700); // 64² - π 20² ≈ 2839
    // rho = 5 (t = 0.25): halfway between the first two stops; rho = 15 (t = 0.75): between the last two.
    const q1 = px(img, 37, 32);
    [242.5, 120, 20].forEach((v, k) => expect(Math.abs(q1[k] - v)).toBeLessThanOrEqual(2));
    const q2 = px(img, 32, 47);
    [120, 20, 75].forEach((v, k) => expect(Math.abs(q2[k] - v)).toBeLessThanOrEqual(2));
    expect(maxDiffFromEvaluateFill(img, g)).toBeLessThanOrEqual(1);
  });

  it('every pixel within 1 level of evaluateFill at its centre: many stops, steep ramps, hard stops, odd input', () => {
    const W = 256;
    const H = 24;
    const lin = (stops: GradientStop[]): Gradient => ({ kind: 'linear', x1: 0, y1: 0, x2: 256, y2: 16, stops });
    const cases: Gradient[] = [
      // 8 stops at an angle, ramp ends inside the image.
      {
        kind: 'linear',
        x1: 30.7,
        y1: 20.2,
        x2: 201.9,
        y2: 3.4,
        stops: Array.from({ length: 8 }, (_, i) => ({
          offset: i / 7,
          color: [(i * 97) % 256, (i * 53 + 20) % 256, 255 - ((i * 31) % 256)] as RGB,
        })),
      },
      // 255 levels over 0.1 of t: a plain 256-entry table would be up to 5 levels off.
      lin([
        { offset: 0.45, color: [0, 0, 0] },
        { offset: 0.55, color: [255, 128, 64] },
      ]),
      // 255 levels over 0.005 of t: steeper than any table, evaluated exactly.
      lin([
        { offset: 0.5, color: [0, 0, 0] },
        { offset: 0.505, color: [255, 255, 255] },
      ]),
      // Hard stop (two stops at one offset) and stops outside [0, 1].
      lin([
        { offset: -0.5, color: [0, 0, 255] },
        { offset: 0.4, color: [0, 255, 0] },
        { offset: 0.4, color: [255, 0, 0] },
        { offset: 1.5, color: [255, 255, 0] },
      ]),
      // Decreasing offsets, out-of-range and non-finite colours (clamped like the SVG hex).
      lin([
        { offset: 0, color: [-100, 300, 50] },
        { offset: 0.8, color: [355, -40, 200] },
        { offset: 0.3, color: [20, 30, 40] },
        { offset: 1, color: [NaN, 10, 250] },
      ]),
      // Radial with the centre between pixels and one with the centre outside the image.
      {
        kind: 'radial',
        cx: 100.3,
        cy: 11.8,
        r: 57.5,
        stops: [
          { offset: 0, color: [255, 255, 255] },
          { offset: 0.2, color: [250, 126, 30] },
          { offset: 0.65, color: [214, 41, 118] },
          { offset: 1, color: [150, 47, 191] },
        ],
      },
      { kind: 'radial', cx: -40, cy: 60, r: 200, stops: GRAY_RAMP },
    ];
    for (const g of cases) {
      const img = rasterizeLayers([gradientLayer(W, H, g)], W, H, [255, 255, 255]);
      expect(maxDiffFromEvaluateFill(img, g)).toBeLessThanOrEqual(1);
      for (let o = 3; o < img.data.length; o += 4) expect(img.data[o]).toBe(255);
    }
  });

  it('coverage, opacity and back-to-front order blend the gradient colour like a solid fill', () => {
    const g: Gradient = {
      kind: 'linear',
      x1: 0,
      y1: 0,
      x2: 16,
      y2: 16,
      stops: [
        { offset: 0, color: [0, 64, 255] },
        { offset: 1, color: [255, 200, 0] },
      ],
    };
    const top = [rectPath(4.5, 2, 14, 13.25)];
    const cov = rasterizeMask(top, 16, 16);
    const onGrey = rasterizeLayers([{ fill: '#808080', opacity: 0.5, gradient: g, paths: top }], 16, 16, [100, 100, 100]);
    const onRed = rasterizeLayers(
      [
        { fill: '#ff0000', paths: [rectPath(0, 0, 16, 16)] },
        { fill: '#808080', opacity: 0.5, gradient: g, paths: top },
      ],
      16,
      16,
      null,
    );
    const alone = rasterizeLayers([{ fill: '#808080', gradient: g, paths: top }], 16, 16, null);
    const covered = rasterizeLayers(
      [
        { fill: '#808080', gradient: g, paths: top },
        { fill: '#00ff00', paths: [rectPath(0, 0, 16, 16)] },
      ],
      16,
      16,
      null,
    );
    const c: RGB = [0, 0, 0];
    let partial = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        evaluateFill(g, x + 0.5, y + 0.5, c);
        const a = at(cov, x, y) / 255;
        if (a > 0 && a < 1) partial++;
        const pg = px(onGrey, x, y);
        for (let k = 0; k < 3; k++) expect(Math.abs(pg[k] - (c[k] * a * 0.5 + 100 * (1 - a * 0.5)))).toBeLessThanOrEqual(1);
        expect(pg[3]).toBe(255);
        const pr = px(onRed, x, y);
        const red = [255, 0, 0];
        for (let k = 0; k < 3; k++) expect(Math.abs(pr[k] - (c[k] * a * 0.5 + red[k] * (1 - a * 0.5)))).toBeLessThanOrEqual(1);
        expect(pr[3]).toBe(255);
        const pa = px(alone, x, y);
        if (a === 0) expect(pa).toEqual([0, 0, 0, 0]);
        else {
          for (let k = 0; k < 3; k++) expect(Math.abs(pa[k] - c[k])).toBeLessThanOrEqual(1); // straight colour
          expect(Math.abs(pa[3] - 255 * a)).toBeLessThanOrEqual(0.51);
        }
        expect(px(covered, x, y)).toEqual([0, 255, 0, 255]);
      }
    }
    expect(partial).toBeGreaterThan(10); // the AA column x = 4 and row y = 13 were checked
  });

  it('a degenerate gradient paints layer.fill: byte-identical to the solid layer', () => {
    const paths = [rectPath(2, 2, 13.5, 11)];
    const solid = rasterizeLayers([{ fill: '#3366cc', paths }], 16, 16, null);
    const degenerate: Gradient[] = [
      { kind: 'linear', x1: 5, y1: 5, x2: 5, y2: 5, stops: GRAY_RAMP },
      { kind: 'radial', cx: 8, cy: 8, r: 0, stops: GRAY_RAMP },
      { kind: 'radial', cx: Number.NaN, cy: 8, r: 5, stops: GRAY_RAMP },
      { kind: 'linear', x1: 0, y1: 0, x2: 16, y2: 0, stops: [{ offset: 0, color: [0, 0, 0] }] },
      {
        kind: 'linear',
        x1: 0,
        y1: 0,
        x2: 16,
        y2: 0,
        stops: [
          { offset: 0, color: [100, 100, 100] },
          { offset: 1, color: [101, 100.5, 99] },
        ],
      },
    ];
    for (const g of degenerate) {
      const img = rasterizeLayers([{ fill: '#3366cc', gradient: g, paths }], 16, 16, null);
      expect(Array.from(img.data)).toEqual(Array.from(solid.data));
    }
  });

  it('validates the reserve fill of gradient layers too and never mutates the layers', () => {
    const g: Gradient = { kind: 'radial', cx: 4, cy: 4, r: 3, stops: GRAY_RAMP };
    expect(() => rasterizeLayers([{ fill: 'url(#g0)', gradient: g, paths: [rectPath(0, 0, 8, 8)] }], 8, 8, null)).toThrow(
      /relleno/,
    );
    const layers: Layer[] = [
      gradientLayer(8, 8, { kind: 'linear', x1: 0, y1: 0, x2: 8, y2: 8, stops: GRAY_RAMP }),
      { fill: '#123456', gradient: g, paths: [rectPath(1, 1, 7, 7)] },
    ];
    const before = JSON.stringify(layers);
    rasterizeLayers(layers, 8, 8, [0, 0, 0]);
    expect(JSON.stringify(layers)).toBe(before);
  });
});

/**
 * Opt-in (BENCH=1, the timing depends on the machine load): the per-pixel gradient colour must stay cheap next to
 * the coverage sweep. Measured 2026-09-11 (Node 26, vitest 5, best of 9 interleaved runs, 2000x2000, 2 stops):
 * full rect on white solid 30.6 ms, linear 43.4 ms (1.42x), radial 63.0 ms (2.06x); transparent 1.41x / 2.08x;
 * disc r 990 on white 1.53x / 2.45x. The radial cost is Math.hypot inside fillEval.gradientT: the same loop with
 * Math.sqrt measured 1.16x with byte-identical output.
 */
describe.skipIf(process.env.BENCH !== '1')('rasterizeLayers gradient cost (BENCH=1)', () => {
  it('a 2000x2000 linear gradient layer takes at most 1.5x the time of the same solid layer', () => {
    const N = 2000;
    const paths = [rectPath(0, 0, N, N)];
    const solid: Layer = { fill: '#808080', paths };
    const linear: Layer = {
      fill: '#808080',
      paths,
      gradient: {
        kind: 'linear',
        x1: 100,
        y1: 300,
        x2: 1900,
        y2: 1700,
        stops: [
          { offset: 0, color: [10, 200, 30] },
          { offset: 1, color: [240, 20, 180] },
        ],
      },
    };
    const time = (layer: Layer): number => {
      const t0 = performance.now();
      rasterizeLayers([layer], N, N, [255, 255, 255]);
      return performance.now() - t0;
    };
    for (let i = 0; i < 2; i++) time(solid) + time(linear); // warm-up
    let bestSolid = Number.POSITIVE_INFINITY;
    let bestLinear = Number.POSITIVE_INFINITY;
    for (let rep = 0; rep < 9; rep++) {
      bestSolid = Math.min(bestSolid, time(solid));
      bestLinear = Math.min(bestLinear, time(linear));
    }
    expect(bestLinear / bestSolid).toBeLessThanOrEqual(1.5);
  });
});
