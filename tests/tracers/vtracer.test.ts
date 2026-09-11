import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVtracerTracer, vtracerColorSvg } from '../../src/tracers/vtracer';
import { extractPaths } from '../../src/tracers/svgParse';
import { applyTransform, parsePathData, parseTransform } from '../../src/svg/pathParse';
import { pathBounds } from '../../src/svg/pathSerialize';
import type { AbsPath, BinaryMask, RasterImage, Seg, TracerOptions, VtracerParams } from '../../src/types';

// NOTE: vitest isolates each test file, so the module-level wasm state starts fresh here.
// The first test relies on that (it exercises the "not initialised" error path).

const WASM_PATH = path.join(process.cwd(), 'node_modules/vtracer-web/vtracer.wasm');
const wasmBytes = (): Uint8Array => readFileSync(WASM_PATH);

// ---- fixtures -----------------------------------------------------------------------------

function makeMask(w: number, h: number, ink: (x: number, y: number) => boolean): BinaryMask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (ink(x, y)) data[y * w + x] = 1;
  }
  return { data, width: w, height: h };
}

const SQUARE = makeMask(16, 16, (x, y) => x >= 4 && x < 12 && y >= 4 && y < 12);
const DISC = makeMask(64, 64, (x, y) => (x + 0.5 - 32) ** 2 + (y + 0.5 - 32) ** 2 < 400);
/** 16×16 square at [8,24) with an 8×8 hole at [12,20). */
const HOLLOW = makeMask(
  32,
  32,
  (x, y) => x >= 8 && x < 24 && y >= 8 && y < 24 && !(x >= 12 && x < 20 && y >= 12 && y < 20),
);
/** Two separate squares: [2,12) and [18,30). */
const TWO = makeMask(
  32,
  32,
  (x, y) => (x >= 2 && x < 12 && y >= 2 && y < 12) || (x >= 18 && x < 30 && y >= 18 && y < 30),
);
/** 16×16 square at [8,24) plus a 3×3 (9 px) speck at [1,4). */
const SPECK9 = makeMask(
  32,
  32,
  (x, y) => (x >= 8 && x < 24 && y >= 8 && y < 24) || (x >= 1 && x < 4 && y >= 1 && y < 4),
);
const EMPTY = makeMask(8, 8, () => false);

const VT: VtracerParams = {
  cornerThresholdDeg: 60,
  lengthThreshold: 4,
  maxIterations: 10,
  spliceThresholdDeg: 45,
  filterSpeckle: 4,
  colorPrecision: 6,
  layerDifference: 16,
  pathPrecision: 3,
};

const OPTS: TracerOptions = {
  alphamax: 1,
  opttolerance: 0.2,
  turdsize: 2,
  turnpolicy: 'minority',
  opticurve: true,
  vtracer: VT,
};

/** 32×32 opaque image: blue background with a red 16×16 square at [8,24). */
function twoColourImage(): RasterImage {
  const w = 32;
  const data = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inside = x >= 8 && x < 24 && y >= 8 && y < 24;
      data[o] = inside ? 255 : 0;
      data[o + 1] = 0;
      data[o + 2] = inside ? 0 : 255;
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: w };
}

function countKinds(p: AbsPath): Record<Seg['kind'], number> {
  const c: Record<Seg['kind'], number> = { M: 0, L: 0, Q: 0, C: 0, Z: 0 };
  for (const s of p.segs) c[s.kind]++;
  return c;
}

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

function expectBounds(p: AbsPath, lo: number, hi: number, tol: number): void {
  const b = pathBounds(p);
  expect(Math.abs(b.minX - lo), `minX ${b.minX} vs ${lo}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(b.minY - lo), `minY ${b.minY} vs ${lo}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(b.maxX - hi), `maxX ${b.maxX} vs ${hi}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(b.maxY - hi), `maxY ${b.maxY} vs ${hi}`).toBeLessThanOrEqual(tol);
}

// ---- tests --------------------------------------------------------------------------------

describe('createVtracerTracer', () => {
  it('traceBinary before init(source) rejects with "vtracer: …" (no wasm URL is bundled)', async () => {
    const tracer = createVtracerTracer();
    expect(tracer.name).toBe('vtracer');
    await expect(tracer.traceBinary(SQUARE, OPTS)).rejects.toThrow(/^vtracer: /);
    // Empty masks short-circuit even without the wasm.
    expect(await tracer.traceBinary(EMPTY, OPTS)).toEqual([]);
  });

  it('init(bytes) works, is idempotent, and is shared by every tracer instance', async () => {
    const tracer = createVtracerTracer();
    await Promise.all([tracer.init(wasmBytes()), tracer.init(wasmBytes())]);
    await tracer.init(wasmBytes());
    // Once initialised, a later init with any source is a no-op (cached promise).
    await tracer.init('this-is-not-a-real-url');
    const other = createVtracerTracer();
    await other.init();
    expect((await other.traceBinary(SQUARE, OPTS)).length).toBe(1);
  });

  it('16×16 square at (4,4): one path, bounds [4,12] ±0.01, four C with collinear controls', async () => {
    const tracer = createVtracerTracer();
    await tracer.init(wasmBytes());
    const paths = await tracer.traceBinary(SQUARE, OPTS);
    expect(paths).toHaveLength(1);
    const p = paths[0];
    expectBounds(p, 4, 12, 0.01);
    const kinds = countKinds(p);
    expect(kinds.M).toBe(1);
    expect(kinds.Z).toBe(1);
    expect(kinds.C).toBe(4);
    expect(kinds.L + kinds.Q).toBe(0);
    // The translate(4,4) must be applied: the first vertex is the square's corner (4,4).
    const m = p.segs[0];
    expect(m.kind).toBe('M');
    if (m.kind === 'M') {
      expect(Math.abs(m.x - 4)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(m.y - 4)).toBeLessThanOrEqual(0.01);
    }
    // Each C is a straight edge: control points collinear with its endpoints (cross ≈ 0),
    // and every corner is one of the four square corners.
    let px = 0;
    let py = 0;
    for (const s of p.segs) {
      if (s.kind === 'M') {
        px = s.x;
        py = s.y;
      } else if (s.kind === 'C') {
        const dx = s.x - px;
        const dy = s.y - py;
        const cross1 = dx * (s.y1 - py) - dy * (s.x1 - px);
        const cross2 = dx * (s.y2 - py) - dy * (s.x2 - px);
        expect(Math.abs(cross1)).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(cross2)).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(s.x - 4) <= 0.01 || Math.abs(s.x - 12) <= 0.01).toBe(true);
        expect(Math.abs(s.y - 4) <= 0.01 || Math.abs(s.y - 12) <= 0.01).toBe(true);
        px = s.x;
        py = s.y;
      }
    }
  });

  it('64×64 disc r=20: one path, bounds within ±1.5 px of [12,52], curves only', async () => {
    const tracer = createVtracerTracer();
    await tracer.init(wasmBytes());
    const paths = await tracer.traceBinary(DISC, OPTS);
    expect(paths).toHaveLength(1);
    const p = paths[0];
    expectBounds(p, 12, 52, 1.5);
    const kinds = countKinds(p);
    expect(kinds.M).toBe(1);
    expect(kinds.Z).toBe(1);
    expect(kinds.C).toBeGreaterThanOrEqual(4);
    expect(kinds.L).toBe(0);
    for (const s of p.segs) {
      if (s.kind !== 'C' && s.kind !== 'M') continue;
      const r = Math.hypot(s.x - 32, s.y - 32);
      expect(Math.abs(r - 20), `radius at (${s.x},${s.y})`).toBeLessThanOrEqual(1.5);
    }
  });

  it('hollow square: one path with two subpaths (outline + hole) at exact bounds', async () => {
    const tracer = createVtracerTracer();
    await tracer.init(wasmBytes());
    const paths = await tracer.traceBinary(HOLLOW, OPTS);
    expect(paths).toHaveLength(1);
    const subs = subpaths(paths[0]);
    expect(subs).toHaveLength(2);
    const sorted = subs.slice().sort((a, b) => pathBounds(a).minX - pathBounds(b).minX);
    expectBounds(sorted[0], 8, 24, 0.01);
    expectBounds(sorted[1], 12, 20, 0.01);
  });

  it('two components → two paths, each translated to its own position', async () => {
    const tracer = createVtracerTracer();
    await tracer.init(wasmBytes());
    const paths = await tracer.traceBinary(TWO, OPTS);
    expect(paths).toHaveLength(2);
    const sorted = paths.slice().sort((a, b) => pathBounds(a).minX - pathBounds(b).minX);
    expectBounds(sorted[0], 2, 12, 0.01);
    expectBounds(sorted[1], 18, 30, 0.01);
  });

  it('filterSpeckle is an AREA threshold in vtracer-web 0.1.0 (9 px speck: kept at 9, dropped at 10)', async () => {
    const tracer = createVtracerTracer();
    await tracer.init(wasmBytes());
    const kept = await tracer.traceBinary(SPECK9, { ...OPTS, vtracer: { ...VT, filterSpeckle: 9 } });
    const dropped = await tracer.traceBinary(SPECK9, { ...OPTS, vtracer: { ...VT, filterSpeckle: 10 } });
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(1);
    expectBounds(dropped[0], 8, 24, 0.01);
    const speck = kept.slice().sort((a, b) => pathBounds(a).minX - pathBounds(b).minX)[0];
    expectBounds(speck, 1, 4, 0.01);
  });

  it('empty mask (no ink) and zero-sized mask → []', async () => {
    const tracer = createVtracerTracer();
    await tracer.init(wasmBytes());
    expect(await tracer.traceBinary(EMPTY, OPTS)).toEqual([]);
    expect(await tracer.traceBinary({ data: new Uint8Array(0), width: 0, height: 0 }, OPTS)).toEqual([]);
    expect(await tracer.traceBinary({ data: new Uint8Array(0), width: 7, height: 0 }, OPTS)).toEqual([]);
  });

  it('is deterministic and never mutates the mask', async () => {
    const tracer = createVtracerTracer();
    await tracer.init(wasmBytes());
    const before = Uint8Array.from(DISC.data);
    const a = await tracer.traceBinary(DISC, OPTS);
    const b = await tracer.traceBinary(DISC, OPTS);
    expect(a).toEqual(b);
    expect(Array.from(DISC.data)).toEqual(Array.from(before));
  });

  it('rejects malformed masks / non-finite params with "vtracer: …" and keeps working', async () => {
    const tracer = createVtracerTracer();
    await tracer.init(wasmBytes());
    await expect(
      tracer.traceBinary({ data: new Uint8Array(3), width: 2, height: 2 }, OPTS),
    ).rejects.toThrow(/^vtracer: /);
    await expect(
      tracer.traceBinary(SQUARE, { ...OPTS, vtracer: { ...VT, cornerThresholdDeg: Number.NaN } }),
    ).rejects.toThrow(/^vtracer: opción vtracer "cornerThresholdDeg"/);
    expect((await tracer.traceBinary(SQUARE, OPTS)).length).toBe(1);
  });
});

describe('vtracerColorSvg', () => {
  it('stacked: raw SVG with viewBox inserted into the root tag, one path per colour', async () => {
    await createVtracerTracer().init(wasmBytes());
    const img = twoColourImage();
    const before = Uint8ClampedArray.from(img.data);
    const svg = vtracerColorSvg(img, VT, 'stacked');
    expect(Array.from(img.data)).toEqual(Array.from(before));
    expect(svg.startsWith('<?xml')).toBe(true);
    expect((svg.match(/viewBox=/g) ?? []).length).toBe(1);
    expect(svg).toMatch(/<svg\b[^>]*\swidth="32"[^>]*\sheight="32"[^>]*\sviewBox="0 0 32 32"[^>]*>/);
    const paths = extractPaths(svg);
    expect(paths).toHaveLength(2);
    const fills = paths.map((p) => (p.fill ?? '').toLowerCase()).sort();
    expect(fills).toEqual(['#0000ff', '#ff0000']);
    // Background first (stacked order), red square on top at [8,24).
    expect(paths[0].fill?.toLowerCase()).toBe('#0000ff');
    const red = paths.find((p) => p.fill?.toLowerCase() === '#ff0000')!;
    const abs = applyTransform(parsePathData(red.d), parseTransform(red.transform ?? ''));
    expectBounds(abs, 8, 24, 0.01);
    const bg = paths.find((p) => p.fill?.toLowerCase() === '#0000ff')!;
    expectBounds(applyTransform(parsePathData(bg.d), parseTransform(bg.transform ?? '')), 0, 32, 0.01);
  });

  it('cutout: the background path carries the hole where the square sits', async () => {
    await createVtracerTracer().init(wasmBytes());
    const svg = vtracerColorSvg(twoColourImage(), VT, 'cutout');
    expect(svg).toMatch(/<svg\b[^>]*\sviewBox="0 0 32 32"[^>]*>/);
    const paths = extractPaths(svg);
    expect(paths).toHaveLength(2);
    const bg = paths.find((p) => p.fill?.toLowerCase() === '#0000ff')!;
    const abs = applyTransform(parsePathData(bg.d), parseTransform(bg.transform ?? ''));
    const subs = subpaths(abs);
    expect(subs).toHaveLength(2);
    const sorted = subs.slice().sort((a, b) => pathBounds(a).minX - pathBounds(b).minX);
    expectBounds(sorted[0], 0, 32, 0.01);
    expectBounds(sorted[1], 8, 24, 0.01);
  });

  it('uniform image still yields a root <svg> with the viewBox (and no crash)', async () => {
    await createVtracerTracer().init(wasmBytes());
    const w = 8;
    const data = new Uint8ClampedArray(w * w * 4).fill(255);
    const svg = vtracerColorSvg({ data, width: w, height: w }, VT, 'stacked');
    expect(svg).toMatch(/<svg\b[^>]*\sviewBox="0 0 8 8"[^>]*>/);
    expect(svg).toMatch(/<\/svg>\s*$/);
  });

  it('throws "vtracer: …" for a raster whose data length does not match', async () => {
    await createVtracerTracer().init(wasmBytes());
    expect(() => vtracerColorSvg({ data: new Uint8ClampedArray(10), width: 2, height: 2 }, VT, 'stacked')).toThrow(
      /^vtracer: /,
    );
  });
});
