import { describe, expect, it } from 'vitest';
import type { AbsPath, Layer, RasterImage } from '../../src/types';
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
