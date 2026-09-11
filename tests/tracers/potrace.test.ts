import { describe, expect, it } from 'vitest';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { TURNPOLICY_CODE, maskToRaster } from '../../src/tracers/types';
import { pathBounds } from '../../src/svg/pathSerialize';
import type { AbsPath, BinaryMask, Seg, TracerOptions } from '../../src/types';

// ---- fixtures (self-contained, no dependency on other modules) ----------------------------

function makeMask(w: number, h: number, ink: (x: number, y: number) => boolean): BinaryMask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (ink(x, y)) data[y * w + x] = 1;
  }
  return { data, width: w, height: h };
}

/** 16×16 with the 8×8 square covering [4,12) in both axes (same geometry as filledSquare(16,4)). */
const SQUARE = makeMask(16, 16, (x, y) => x >= 4 && x < 12 && y >= 4 && y < 12);
/** 64×64 disc of radius 20 (pixel-centre test), like aaCircle(64,20).maskAt(1). */
const DISC = makeMask(64, 64, (x, y) => (x + 0.5 - 32) ** 2 + (y + 0.5 - 32) ** 2 < 400);
/** Annulus 10 <= r < 20 → one component with one hole. */
const RING = makeMask(64, 64, (x, y) => {
  const d2 = (x + 0.5 - 32) ** 2 + (y + 0.5 - 32) ** 2;
  return d2 < 400 && d2 >= 100;
});
/** 16×16 square at [8,24) plus a 1-px speck at (2,2). */
const SPECK = makeMask(32, 32, (x, y) => (x >= 8 && x < 24 && y >= 8 && y < 24) || (x === 2 && y === 2));
const EMPTY = makeMask(8, 8, () => false);

const OPTS: TracerOptions = {
  alphamax: 1,
  opttolerance: 0.2,
  turdsize: 2,
  turnpolicy: 'minority',
  opticurve: true,
  vtracer: {
    cornerThresholdDeg: 60,
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThresholdDeg: 45,
    filterSpeckle: 4,
    colorPrecision: 6,
    layerDifference: 16,
    pathPrecision: 3,
  },
};

function countKinds(p: AbsPath): Record<Seg['kind'], number> {
  const c: Record<Seg['kind'], number> = { M: 0, L: 0, Q: 0, C: 0, Z: 0 };
  for (const s of p.segs) c[s.kind]++;
  return c;
}

/** Splits a path into its subpaths (each starting at an M). */
function subpaths(p: AbsPath): AbsPath[] {
  const out: AbsPath[] = [];
  let cur: Seg[] = [];
  for (const s of p.segs) {
    if (s.kind === 'M' && cur.length > 0) {
      out.push({ segs: cur });
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length > 0) out.push({ segs: cur });
  return out;
}

function expectBounds(
  p: AbsPath,
  lo: number,
  hi: number,
  tol: number,
): void {
  const b = pathBounds(p);
  expect(Math.abs(b.minX - lo), `minX ${b.minX} vs ${lo}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(b.minY - lo), `minY ${b.minY} vs ${lo}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(b.maxX - hi), `maxX ${b.maxX} vs ${hi}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(b.maxY - hi), `maxY ${b.maxY} vs ${hi}`).toBeLessThanOrEqual(tol);
}

// ---- helpers ------------------------------------------------------------------------------

describe('tracers/types helpers', () => {
  it('TURNPOLICY_CODE matches potracelib numbering', () => {
    expect(TURNPOLICY_CODE).toEqual({ black: 0, white: 1, left: 2, right: 3, minority: 4, majority: 5 });
  });

  it('maskToRaster: ink → opaque black, background → opaque white, input untouched', () => {
    const mask = makeMask(3, 2, (x, y) => x === 1 && y === 1);
    mask.data[0] = 7; // any non-zero counts as ink
    const before = Uint8Array.from(mask.data);
    const img = maskToRaster(mask);
    expect(img.width).toBe(3);
    expect(img.height).toBe(2);
    expect(img.data.length).toBe(24);
    for (let i = 0; i < 6; i++) {
      const ink = i === 0 || i === 4;
      const v = ink ? 0 : 255;
      expect(Array.from(img.data.subarray(i * 4, i * 4 + 4)), `pixel ${i}`).toEqual([v, v, v, 255]);
    }
    expect(Array.from(mask.data)).toEqual(Array.from(before));
  });

  it('maskToRaster: zero-size mask → empty raster; bad shape throws', () => {
    expect(maskToRaster({ data: new Uint8Array(0), width: 0, height: 0 }).data.length).toBe(0);
    expect(() => maskToRaster({ data: new Uint8Array(5), width: 2, height: 2 })).toThrow(/data\.length/);
    expect(() => maskToRaster({ data: new Uint8Array(4), width: -2, height: -2 })).toThrow(/inválid/);
  });
});

// ---- potrace adapter ----------------------------------------------------------------------

describe('createPotraceTracer', () => {
  it('has the engine name and initialises lazily from traceBinary (no explicit init)', async () => {
    const tracer = createPotraceTracer();
    expect(tracer.name).toBe('potrace');
    const paths = await tracer.traceBinary(SQUARE, OPTS);
    expect(paths).toHaveLength(1);
  });

  it('init() is idempotent and safe to call repeatedly / concurrently', async () => {
    const tracer = createPotraceTracer();
    await Promise.all([tracer.init(), tracer.init()]);
    await tracer.init();
    const other = createPotraceTracer();
    await other.init();
    expect((await other.traceBinary(SQUARE, OPTS)).length).toBe(1);
  });

  it('16×16 square at (4,4): exactly one polygonal path with bounds [4,12] ±0.01, y down', async () => {
    const tracer = createPotraceTracer();
    await tracer.init();
    const paths = await tracer.traceBinary(SQUARE, OPTS);
    expect(paths).toHaveLength(1);
    const p = paths[0];
    expectBounds(p, 4, 12, 0.01);
    const kinds = countKinds(p);
    expect(kinds.M).toBe(1);
    expect(kinds.C).toBe(0);
    expect(kinds.Q).toBe(0);
    expect(kinds.L).toBe(8); // corners + edge midpoints (potrace emits both)
    expect(p.segs[p.segs.length - 1].kind).toBe('Z');
    // Every vertex lies on the square's outline.
    for (const s of p.segs) {
      if (s.kind === 'Z') continue;
      const onX = Math.abs(s.x - 4) <= 0.01 || Math.abs(s.x - 12) <= 0.01;
      const onY = Math.abs(s.y - 4) <= 0.01 || Math.abs(s.y - 12) <= 0.01;
      expect(onX || onY, `vertex (${s.x},${s.y}) on outline`).toBe(true);
    }
    // The raw output is "M40 80 l0 -40 …" under translate(0,16) scale(0.1,-0.1): the second
    // vertex (40,40) must land on y = 16 - 4 = 12, which proves the y-flip was applied.
    const second = p.segs[1];
    expect(second.kind).toBe('L');
    if (second.kind === 'L') {
      expect(Math.abs(second.x - 4)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(second.y - 12)).toBeLessThanOrEqual(0.01);
    }
  });

  it('64×64 disc r=20: one smooth path, bounds within ±1.5 px of [12,52], curves not lines', async () => {
    const tracer = createPotraceTracer();
    await tracer.init();
    const paths = await tracer.traceBinary(DISC, OPTS);
    expect(paths).toHaveLength(1);
    const p = paths[0];
    expectBounds(p, 12, 52, 1.5);
    const kinds = countKinds(p);
    expect(kinds.M).toBe(1);
    expect(kinds.Z).toBe(1);
    expect(kinds.C).toBeGreaterThanOrEqual(4);
    expect(kinds.L).toBeLessThanOrEqual(2);
    // Every on-curve endpoint sits close to the circle of radius 20 around (32,32).
    for (const s of p.segs) {
      if (s.kind !== 'C' && s.kind !== 'M') continue;
      const r = Math.hypot(s.x - 32, s.y - 32);
      expect(Math.abs(r - 20), `radius at (${s.x},${s.y})`).toBeLessThanOrEqual(1.5);
    }
  });

  it('consecutive calls with different alphamax both succeed (module reuse) and differ as expected', async () => {
    const tracer = createPotraceTracer();
    await tracer.init();
    const smooth = await tracer.traceBinary(DISC, { ...OPTS, alphamax: 1.0 });
    const polygon = await tracer.traceBinary(DISC, { ...OPTS, alphamax: 0 });
    expect(smooth).toHaveLength(1);
    expect(polygon).toHaveLength(1);
    expectBounds(smooth[0], 12, 52, 1.5);
    expectBounds(polygon[0], 12, 52, 1.5);
    expect(countKinds(smooth[0]).C).toBeGreaterThan(0);
    // alphamax = 0 → every vertex is a corner → pure polygon.
    expect(countKinds(polygon[0]).C).toBe(0);
    expect(countKinds(polygon[0]).L).toBeGreaterThanOrEqual(12);
    // And the smooth variant still works afterwards.
    const again = await tracer.traceBinary(DISC, { ...OPTS, alphamax: 1.0 });
    expect(again).toEqual(smooth);
  });

  it('ring: one path with two subpaths (outer contour + hole) at the right radii', async () => {
    const tracer = createPotraceTracer();
    await tracer.init();
    const paths = await tracer.traceBinary(RING, OPTS);
    expect(paths).toHaveLength(1);
    const subs = subpaths(paths[0]);
    expect(subs).toHaveLength(2);
    expect(countKinds(paths[0]).Z).toBe(2);
    // Classify the subpaths by the mean radius of their on-curve points (control points of
    // a 3-Bézier circle overshoot by several px, so bounds are not a fair test for the hole).
    const radii = subs.map((sp) => {
      const rs: number[] = [];
      for (const s of sp.segs) if (s.kind !== 'Z') rs.push(Math.hypot(s.x - 32, s.y - 32));
      return rs;
    });
    const mean = (rs: number[]) => rs.reduce((a, b) => a + b, 0) / rs.length;
    const outerIdx = mean(radii[0]) > mean(radii[1]) ? 0 : 1;
    const innerIdx = 1 - outerIdx;
    for (const r of radii[outerIdx]) expect(Math.abs(r - 20), `outer r=${r}`).toBeLessThanOrEqual(1.5);
    for (const r of radii[innerIdx]) expect(Math.abs(r - 10), `inner r=${r}`).toBeLessThanOrEqual(1.5);
    expect(radii[outerIdx].length).toBeGreaterThanOrEqual(4);
    expect(radii[innerIdx].length).toBeGreaterThanOrEqual(3);
    expectBounds(subs[outerIdx], 12, 52, 1.5);
  });

  it('turdsize drops specks smaller than the area threshold', async () => {
    const tracer = createPotraceTracer();
    await tracer.init();
    const kept = await tracer.traceBinary(SPECK, { ...OPTS, turdsize: 0 });
    const dropped = await tracer.traceBinary(SPECK, { ...OPTS, turdsize: 2 });
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(1);
    expectBounds(dropped[0], 8, 24, 0.01);
    const speck = kept.map((p) => pathBounds(p)).find((b) => b.maxX < 8)!;
    expect(speck).toBeDefined();
    expect(Math.abs(speck.minX - 2)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(speck.maxX - 3)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(speck.minY - 2)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(speck.maxY - 3)).toBeLessThanOrEqual(0.01);
  });

  it('empty mask (no ink) and zero-sized mask → []', async () => {
    const tracer = createPotraceTracer();
    await tracer.init();
    expect(await tracer.traceBinary(EMPTY, OPTS)).toEqual([]);
    expect(await tracer.traceBinary({ data: new Uint8Array(0), width: 0, height: 0 }, OPTS)).toEqual([]);
    expect(await tracer.traceBinary({ data: new Uint8Array(0), width: 0, height: 5 }, OPTS)).toEqual([]);
  });

  it('is deterministic and never mutates the mask', async () => {
    const tracer = createPotraceTracer();
    await tracer.init();
    const before = Uint8Array.from(DISC.data);
    const a = await tracer.traceBinary(DISC, OPTS);
    const b = await tracer.traceBinary(DISC, OPTS);
    expect(a).toEqual(b);
    expect(Array.from(DISC.data)).toEqual(Array.from(before));
  });

  it('full-frame ink (touching every border) is traced with bounds = image', async () => {
    const tracer = createPotraceTracer();
    await tracer.init();
    const full = makeMask(10, 6, () => true);
    const paths = await tracer.traceBinary(full, OPTS);
    expect(paths).toHaveLength(1);
    const b = pathBounds(paths[0]);
    expect(Math.abs(b.minX)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(b.minY)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(b.maxX - 10)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(b.maxY - 6)).toBeLessThanOrEqual(0.01);
  });

  it('rejects malformed input and options with an Error whose message starts with "potrace: "', async () => {
    const tracer = createPotraceTracer();
    await tracer.init();
    await expect(
      tracer.traceBinary({ data: new Uint8Array(3), width: 2, height: 2 }, OPTS),
    ).rejects.toThrow(/^potrace: /);
    await expect(
      tracer.traceBinary(SQUARE, { ...OPTS, turnpolicy: 'diagonal' as unknown as 'minority' }),
    ).rejects.toThrow(/^potrace: turnpolicy/);
    await expect(tracer.traceBinary(SQUARE, { ...OPTS, alphamax: Number.NaN })).rejects.toThrow(
      /^potrace: opción "alphamax"/,
    );
    // …and the module keeps working afterwards.
    expect((await tracer.traceBinary(SQUARE, OPTS)).length).toBe(1);
  });
});
