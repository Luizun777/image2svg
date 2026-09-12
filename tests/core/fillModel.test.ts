import { describe, expect, it } from 'vitest';
import type { BinaryMask, Fill, Gradient, LinearGradient, RasterImage, RegionMap, RegionModel, RGB, Segmentation } from '../../src/types';
import { diagonalSweep, flatShapes3, gradientFeathers, hueRamp, radialDisc, withNoise } from '../../src/dev/synth';
import { evaluateFill, isDegenerateGradient } from '../../src/core/fillEval';
import {
  M_B,
  M_BX,
  M_BY,
  M_CC,
  M_G,
  M_GX,
  M_GY,
  M_N,
  M_R,
  M_RX,
  M_RY,
  M_X,
  M_XX,
  M_XY,
  M_Y,
  M_YY,
  MERGE_MAX_JOINT_PIXELS,
  MIN_MODEL_CORE,
  MOMENTS_PER_REGION,
  SPLIT_MAX_DEPTH,
  accumulateMoments,
  corePixels,
  fitFlat,
  fitLinear,
  fitPlane,
  planeAxis,
  planMerges,
  rmseOf,
  selectModel,
  splitComplex,
  type Plane,
  type RegionPixels,
} from '../../src/core/fillModel';
import { labelsFromSdf, regionMapFromLabelMap, segFromLabels, singleRegion } from '../fixtures/segFromLabels';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface Fitted {
  seg: Segmentation;
  px: RegionPixels;
  moments: Float64Array;
  models: RegionModel[];
}

function fitAll(img: RasterImage, labels: RegionMap, over: { maxStops?: number; radial?: boolean; sigma?: number } = {}): Fitted {
  const seg = segFromLabels(img, labels, over.sigma === undefined ? {} : { sigma: over.sigma });
  const px = corePixels(seg);
  const moments = accumulateMoments(img, seg);
  const models = Array.from({ length: seg.regions.count }, (_, k) =>
    selectModel(img, px, k, moments, { sigma: seg.sigma, maxStops: over.maxStops ?? 8, radial: over.radial ?? true }),
  );
  return { seg, px, moments, models };
}

function rasterOf(w: number, h: number, color: (x: number, y: number) => RGB): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = color(x, y);
      const o = (y * w + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function labelsOf(w: number, h: number, count: number, label: (x: number, y: number) => number): RegionMap {
  const data = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = label(x, y);
  return { data, width: w, height: h, count };
}

/** Segmentation with explicit regions and core (for shapes segFromLabels cannot express, like a one-row core). */
function manualSeg(w: number, h: number, count: number, region: (x: number, y: number) => number, core: (x: number, y: number) => boolean): Segmentation {
  const regions = labelsOf(w, h, count, region);
  const coreData = new Uint8Array(w * h);
  const area = new Float64Array(count);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = regions.data[y * w + x];
      if (k >= 0) area[k]++;
      if (k >= 0 && core(x, y)) coreData[y * w + x] = 1;
    }
  }
  const coreMask: BinaryMask = { data: coreData, width: w, height: h };
  return {
    regions,
    edge: { data: Uint8Array.from(coreData, (v) => 1 - v), width: w, height: h },
    core: coreMask,
    area,
    adjacency: Array.from({ length: count }, () => new Int32Array(0)),
    sigma: 0,
    edgeShare: 0,
  };
}

/** Undirected angle between two directions, degrees in [0, 90]. */
function lineAngleDeg(ax: number, ay: number, bx: number, by: number): number {
  let d = Math.abs(Math.atan2(ay, ax) - Math.atan2(by, bx)) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return (d * 180) / Math.PI;
}

function axisErrorDeg(fit: LinearGradient, truth: LinearGradient): number {
  return lineAngleDeg(fit.x2 - fit.x1, fit.y2 - fit.y1, truth.x2 - truth.x1, truth.y2 - truth.y1);
}

/**
 * Largest channel difference between each fitted stop colour and the true fill at that stop's position
 * (along the fitted axis for a linear fit; at distance offset·r from the true centre for a radial one).
 * The fitted ramp spans the core pixels (0.5 to 99.5 percentile), not the drawn shape, so its end stops
 * sit a pixel or two inside the true ones: comparing at the same position is what "stops within ±6" means.
 */
function stopErrorVsTruth(fit: Gradient, truth: Gradient): number {
  const c: RGB = [0, 0, 0];
  let worst = 0;
  for (const s of fit.stops) {
    if (fit.kind === 'linear') evaluateFill(truth, fit.x1 + (fit.x2 - fit.x1) * s.offset, fit.y1 + (fit.y2 - fit.y1) * s.offset, c);
    else if (truth.kind === 'radial') evaluateFill(truth, truth.cx + fit.r * s.offset, truth.cy, c);
    else throw new Error('radial fit compared with a linear truth');
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(c[k] - s.color[k]));
  }
  return worst;
}

/** Union-find over merge pairs: root of each region after applying them in order. */
function rootsAfter(pairs: ReadonlyArray<readonly [number, number]>, count: number): (k: number) => number {
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a];
    return a;
  };
  for (const [s, d] of pairs) {
    const a = find(s);
    const b = find(d);
    if (a !== b) parent[a] = b;
  }
  return find;
}

/** The ground-truth labels with feather `id` cut in two: `across` its axis at mid-length, or `along` it. */
function splitFeather(labels: RegionMap, fill: LinearGradient, id: number, mode: 'across' | 'along'): RegionMap {
  const W = labels.width;
  const data = Int32Array.from(labels.data);
  const dx = fill.x2 - fill.x1;
  const dy = fill.y2 - fill.y1;
  const newId = labels.count;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== id) continue;
    const x = (i % W) + 0.5 - fill.x1;
    const y = Math.floor(i / W) + 0.5 - fill.y1;
    const second = mode === 'across' ? (x * dx + y * dy) / (dx * dx + dy * dy) > 0.5 : x * dy - y * dx > 0;
    if (second) data[i] = newId;
  }
  return { data, width: W, height: labels.height, count: labels.count + 1 };
}

// ---------------------------------------------------------------------------------------------
// Moments, core pixels, flat and plane
// ---------------------------------------------------------------------------------------------

describe('accumulateMoments and corePixels', () => {
  const { image, labels } = flatShapes3(48);
  const seg = segFromLabels(image, regionMapFromLabelMap(labels));

  it('sums the 16 moments of every region over its core pixels, at pixel centres', () => {
    const m = accumulateMoments(image, seg);
    expect(m.length).toBe(MOMENTS_PER_REGION * 3);
    const brute = new Float64Array(m.length);
    let cores = 0;
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 48; x++) {
        const i = y * 48 + x;
        if (seg.core.data[i] === 0) continue;
        cores++;
        const o = seg.regions.data[i] * MOMENTS_PER_REGION;
        const xc = x + 0.5;
        const yc = y + 0.5;
        const R = image.data[i * 4];
        const G = image.data[i * 4 + 1];
        const B = image.data[i * 4 + 2];
        brute[o + M_N] += 1;
        brute[o + M_X] += xc;
        brute[o + M_Y] += yc;
        brute[o + M_XX] += xc * xc;
        brute[o + M_XY] += xc * yc;
        brute[o + M_YY] += yc * yc;
        brute[o + M_R] += R;
        brute[o + M_G] += G;
        brute[o + M_B] += B;
        brute[o + M_RX] += R * xc;
        brute[o + M_GX] += G * xc;
        brute[o + M_BX] += B * xc;
        brute[o + M_RY] += R * yc;
        brute[o + M_GY] += G * yc;
        brute[o + M_BY] += B * yc;
        brute[o + M_CC] += R * R + G * G + B * B;
      }
    }
    expect(cores).toBeGreaterThan(1500);
    for (let i = 0; i < m.length; i++) expect(Math.abs(m[i] - brute[i])).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(brute[i])));
  });

  it('lists the core pixels of each region in raster order (CSR offsets and indices)', () => {
    const px = corePixels(seg);
    expect(px.offsets).toHaveLength(4);
    expect(px.offsets[0]).toBe(0);
    const m = accumulateMoments(image, seg);
    for (let k = 0; k < 3; k++) {
      const start = px.offsets[k];
      const end = px.offsets[k + 1];
      expect(end - start).toBe(m[k * MOMENTS_PER_REGION + M_N]);
      for (let i = start; i < end; i++) {
        expect(seg.core.data[px.indices[i]]).toBe(1);
        expect(seg.regions.data[px.indices[i]]).toBe(k);
        if (i > start) expect(px.indices[i]).toBeGreaterThan(px.indices[i - 1]);
      }
    }
    expect(px.indices).toHaveLength(px.offsets[3]);
  });

  it('rejects an image whose size differs from the segmentation', () => {
    expect(() => accumulateMoments(flatShapes3(40).image, seg)).toThrow(RangeError);
  });
});

describe('fitFlat, fitPlane and planeAxis', () => {
  it('fitFlat: mean colour and pooled RMSE; an empty region is black with RMSE 0', () => {
    const img = rasterOf(10, 10, (x) => (x < 5 ? [0, 0, 0] : [10, 20, 30]));
    const seg = segFromLabels(img, singleRegion(10, 10), { sigma: 0 });
    const flat = fitFlat(accumulateMoments(img, seg), 0);
    expect(flat.color[0]).toBeCloseTo(5, 9);
    expect(flat.color[1]).toBeCloseTo(10, 9);
    expect(flat.color[2]).toBeCloseTo(15, 9);
    expect(flat.rmse).toBeCloseTo(Math.sqrt((25 + 100 + 225) / 3), 9); // 10.80
    expect(fitFlat(new Float64Array(MOMENTS_PER_REGION), 0)).toEqual({ color: [0, 0, 0], rmse: 0 });
  });

  it('fitPlane recovers an exact per-channel plane with centred coordinates', () => {
    const img = rasterOf(40, 30, (x, y) => [20 + 3 * x, 200 - 2 * y, 50 + x + y]);
    const seg = segFromLabels(img, singleRegion(40, 30), { sigma: 0 });
    const p = fitPlane(accumulateMoments(img, seg), 0);
    expect(p.cx).toBeCloseTo(20, 9);
    expect(p.cy).toBeCloseTo(15, 9);
    const expected: Array<[number, number, number]> = [
      [20 + 3 * 19.5, 3, 0],
      [200 - 2 * 14.5, 0, -2],
      [50 + 19.5 + 14.5, 1, 1],
    ];
    for (let c = 0; c < 3; c++) {
      expect(p.mean[c]).toBeCloseTo(expected[c][0], 6);
      expect(p.gx[c]).toBeCloseTo(expected[c][1], 6);
      expect(p.gy[c]).toBeCloseTo(expected[c][2], 6);
    }
    expect(p.rmse).toBeLessThan(1e-3);
  });

  it('fitPlane: a collinear core (one row) has a singular system and gives the flat model', () => {
    const img = rasterOf(20, 11, (x) => [10 + 5 * x, 40, 60]);
    const seg = manualSeg(20, 11, 1, () => 0, (_x, y) => y === 5);
    const m = accumulateMoments(img, seg);
    const p = fitPlane(m, 0);
    expect(p.gx).toEqual([0, 0, 0]);
    expect(p.gy).toEqual([0, 0, 0]);
    expect(p.rmse).toBeCloseTo(fitFlat(m, 0).rmse, 9);
  });

  const plane = (gx: RGB, gy: RGB): Plane => ({ cx: 0, cy: 0, mean: [0, 0, 0], gx, gy, rmse: 0 });

  it('planeAxis keeps a hue-only ramp (no luma change) and reports strength and collinearity', () => {
    const gR = 2;
    const gG = (-0.299 * gR) / 0.587; // constant Rec.601 luma: a luma-weighted axis would vanish
    const a = planeAxis(plane([gR, gG, 0], [0, 0, 0]));
    expect(a.ux).toBeCloseTo(1, 12);
    expect(a.uy).toBeCloseTo(0, 12);
    expect(a.strength).toBeCloseTo(Math.hypot(gR, gG), 12);
    expect(a.collinearity).toBeCloseTo(0, 12);
    const iso = planeAxis(plane([1, 0, 0], [0, 1, 0]));
    expect(iso.collinearity).toBeCloseTo(1, 12);
    expect(planeAxis(plane([0, 0, 0], [0, 0, 0])).strength).toBe(0);
  });

  it('planeAxis fixes the sign: ux > 0, or ux = 0 and uy > 0', () => {
    const diag = planeAxis(plane([-1, 0, 0], [-1, 0, 0]));
    expect(diag.ux).toBeCloseTo(Math.SQRT1_2, 12);
    expect(diag.uy).toBeCloseTo(Math.SQRT1_2, 12);
    const up = planeAxis(plane([0, 0, 0], [-3, 0, 0]));
    expect(up.ux).toBeCloseTo(0, 12);
    expect(up.uy).toBeCloseTo(1, 12);
    expect(up.ux >= 0).toBe(true);
  });
});

describe('rmseOf', () => {
  it('is the pooled RMSE of fillEval at the core pixel centres; the mean colour gives fitFlat', () => {
    const gf = gradientFeathers(256, 1);
    const seg = segFromLabels(gf.image, gf.labels);
    const px = corePixels(seg);
    const m = accumulateMoments(gf.image, seg);
    const fill = gf.shapes[4].fill;
    const id = gf.shapes[4].label;
    let ss = 0;
    const c: RGB = [0, 0, 0];
    for (let i = px.offsets[id]; i < px.offsets[id + 1]; i++) {
      const p = px.indices[i];
      evaluateFill(fill, (p % 256) + 0.5, Math.floor(p / 256) + 0.5, c);
      for (let k = 0; k < 3; k++) ss += (gf.image.data[p * 4 + k] - c[k]) ** 2;
    }
    const n = px.offsets[id + 1] - px.offsets[id];
    expect(rmseOf(gf.image, px, id, fill)).toBeCloseTo(Math.sqrt(ss / (3 * n)), 9);
    const flat = fitFlat(m, id);
    expect(rmseOf(gf.image, px, id, { kind: 'solid', color: flat.color })).toBeCloseTo(flat.rmse, 6);
  });
});

// ---------------------------------------------------------------------------------------------
// Models on the ground truth of the gradient fixtures
// ---------------------------------------------------------------------------------------------

describe('gradientFeathers(256) on its ground-truth regions', () => {
  const gf = gradientFeathers(256, 1);
  const fit = fitAll(gf.image, gf.labels);

  it('fits every feather with a 2-stop linear gradient: axis <= 3°, stops within ±6 levels, core RMSE < 2', () => {
    for (const shape of gf.shapes.slice(0, 8)) {
      const model = fit.models[shape.label];
      const name = `feather ${shape.label}`;
      expect(model.complex, name).toBe(false);
      expect(model.fill.kind, name).toBe('linear');
      const f = model.fill as LinearGradient;
      const truth = shape.fill as LinearGradient;
      expect(f.stops, name).toHaveLength(2);
      expect(axisErrorDeg(f, truth), name).toBeLessThanOrEqual(3);
      expect(stopErrorVsTruth(f, truth), name).toBeLessThanOrEqual(6);
      expect(model.rmse, name).toBeLessThan(2);
      expect(model.rmse, name).toBeCloseTo(rmseOf(gf.image, fit.px, shape.label, f), 9);
      expect(model.coreCount).toBe(fit.px.offsets[shape.label + 1] - fit.px.offsets[shape.label]);
      expect(model.rmseFlat, name).toBeGreaterThan(10);
    }
  });

  it('paints the shadow and the background with a solid colour, RMSE < 1', () => {
    for (const id of [0, 9]) {
      const model = fit.models[id];
      expect(model.fill.kind, `region ${id}`).toBe('solid');
      expect(model.complex).toBe(false);
      expect(model.rmse).toBeLessThan(1);
    }
    expect(fit.models[9].fill).toEqual({ kind: 'solid', color: [0x20, 0x22, 0x2a] });
  });

  it('a fitted gradient paints its first stop at (x1, y1) and its last at (x2, y2)', () => {
    for (let id = 1; id <= 8; id++) {
      const f = fit.models[id].fill as LinearGradient;
      expect(evaluateFill(f, f.x1, f.y1, [0, 0, 0])).toEqual(f.stops[0].color);
      expect(evaluateFill(f, f.x2, f.y2, [0, 0, 0])).toEqual(f.stops[f.stops.length - 1].color);
    }
  });

  it('is deterministic', () => {
    const again = fitAll(gf.image, gf.labels);
    expect(again.models).toEqual(fit.models);
  });
});

describe('flat ends of a ramp', () => {
  it('a linear ramp with flat ends gets 2 stops at the ends of the ramp itself (no flat end segments)', () => {
    const img = rasterOf(120, 24, (x) => {
      const t = Math.min(1, Math.max(0, (x + 0.5 - 30) / 60));
      return [200 - 150 * t, 60, 40 + 160 * t];
    });
    const m = fitAll(img, singleRegion(120, 24), { sigma: 0 }).models[0];
    if (m.fill.kind !== 'linear') throw new Error(`expected linear, got ${m.fill.kind}`);
    // Before: 4 stops, the first and last pair of the same colour (pad already paints the flat ends).
    expect(m.fill.stops).toHaveLength(2);
    expect(Math.abs(Math.min(m.fill.x1, m.fill.x2) - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(Math.max(m.fill.x1, m.fill.x2) - 90)).toBeLessThanOrEqual(1);
    expect(m.rmse).toBeLessThan(1);
  });

  it('a radial ramp with a flat centre and a flat rim gets 2 stops, the first at the inner radius and r at the outer one', () => {
    const inner: RGB = [255, 220, 120];
    const outer: RGB = [90, 30, 160];
    const img = rasterOf(128, 128, (x, y) => {
      const rho = Math.hypot(x + 0.5 - 64, y + 0.5 - 64);
      if (rho >= 56) return [255, 255, 255];
      const t = Math.min(1, Math.max(0, (rho - 12) / 28));
      return [inner[0] + (outer[0] - inner[0]) * t, inner[1] + (outer[1] - inner[1]) * t, inner[2] + (outer[2] - inner[2]) * t];
    });
    const labels = labelsOf(128, 128, 2, (x, y) => (Math.hypot(x + 0.5 - 64, y + 0.5 - 64) < 56 ? 1 : 0));
    const m = fitAll(img, labels, { sigma: 0 }).models[1];
    if (m.fill.kind !== 'radial') throw new Error(`expected radial, got ${m.fill.kind}`);
    expect(m.fill.stops).toHaveLength(2);
    expect(Math.abs(m.fill.r - 40)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(m.fill.stops[0].offset * m.fill.r - 12)).toBeLessThanOrEqual(1.5);
    expect(m.rmse).toBeLessThan(1);
  });
});

describe('radialDisc, diagonalSweep and hueRamp', () => {
  it('radialDisc: radial, centre within 2 px, r within 5 %, 3 stops within ±6 levels', () => {
    const rd = radialDisc(128);
    const fit = fitAll(rd.image, labelsFromSdf(128, rd.sdf));
    const model = fit.models[1];
    expect(model.complex).toBe(false);
    expect(model.fill.kind).toBe('radial');
    if (model.fill.kind !== 'radial') return;
    expect(Math.hypot(model.fill.cx - rd.fill.cx, model.fill.cy - rd.fill.cy)).toBeLessThanOrEqual(2);
    expect(Math.abs(model.fill.r - rd.fill.r) / rd.fill.r).toBeLessThanOrEqual(0.05);
    expect(model.fill.stops).toHaveLength(3);
    expect(stopErrorVsTruth(model.fill, rd.fill)).toBeLessThanOrEqual(6);
    expect(fit.models[0].fill.kind).toBe('solid');
  });

  it('radialDisc with radial gradients disabled never yields a radial fill', () => {
    const rd = radialDisc(128);
    const fit = fitAll(rd.image, labelsFromSdf(128, rd.sdf), { radial: false });
    expect(fit.models[1].fill.kind).not.toBe('radial');
  });

  it('diagonalSweep: linear with 4 ± 1 stops, RMSE < 2.5, axis <= 3°', () => {
    const ds = diagonalSweep(128);
    const fit = fitAll(ds.image, labelsFromSdf(128, ds.sdf));
    const model = fit.models[1];
    expect(model.complex).toBe(false);
    expect(model.fill.kind).toBe('linear');
    const f = model.fill as LinearGradient;
    expect(f.stops.length).toBeGreaterThanOrEqual(3);
    expect(f.stops.length).toBeLessThanOrEqual(5);
    expect(model.rmse).toBeLessThan(2.5);
    expect(axisErrorDeg(f, ds.fill)).toBeLessThanOrEqual(3);
    expect(stopErrorVsTruth(f, ds.fill)).toBeLessThanOrEqual(6);
  });

  it('maxStops caps the stops of the ramp', () => {
    const ds = diagonalSweep(128);
    const labels = labelsFromSdf(128, ds.sdf);
    for (const maxStops of [2, 3]) {
      const fill = fitAll(ds.image, labels, { maxStops }).models[1].fill;
      expect(fill.kind === 'solid' ? 0 : fill.stops.length).toBeLessThanOrEqual(maxStops);
      expect(fill.kind).not.toBe('solid');
    }
  });

  it('hueRamp (red to green at constant luma): linear, axis <= 3° from the x axis', () => {
    const hr = hueRamp(96);
    const fit = fitAll(hr.image, singleRegion(96, 96));
    const model = fit.models[0];
    expect(model.fill.kind).toBe('linear');
    const f = model.fill as LinearGradient;
    expect(axisErrorDeg(f, hr.fill)).toBeLessThanOrEqual(3);
    expect(stopErrorVsTruth(f, hr.fill)).toBeLessThanOrEqual(6);
    expect(model.rmse).toBeLessThan(1);
  });

  it('flatShapes3: 3 solid regions, no linear or radial fill (no false gradients in flat art)', () => {
    const fs = flatShapes3(96);
    const fit = fitAll(fs.image, regionMapFromLabelMap(fs.labels));
    expect(fit.models.map((m) => m.fill.kind)).toEqual(['solid', 'solid', 'solid']);
    for (const m of fit.models) {
      expect(m.complex).toBe(false);
      expect(m.rmse).toBeLessThan(1);
    }
  });
});

describe('withNoise(gradientFeathers(256), ±3)', () => {
  /**
   * The axis comes from the least-squares plane, which is already the efficient estimator here: its
   * angle error has a standard deviation of σ / (|g| · sqrt(Σ d⊥²)) (σ = 2 levels per channel, |g| =
   * colour change per px, d⊥ = distance of each core pixel to the axis). Narrow, low-contrast feathers sit
   * near 2°: over seeds 1..40 the RMS error per feather is 0.88°-2.12° and 14 of 320 cases exceed 3°
   * (max 5.14°, feather 6, whose widest part the shadow removes). A 5×5-deep core is worse (fewer pixels).
   * So "axis <= 3°" cannot hold for every feather and seed; these are the tightest values reached on
   * seeds 1..3 (see ARCHITECTURE.md, Degradados fase 3).
   */
  const NOISY_AXIS_MAX_DEG = 4.5; // measured 4.43 (seed 1 feather 4) and 4.41 (seed 3 feather 6)
  const NOISY_AXIS_RMS_DEG = 1.6; // measured 1.54 over the 24 feather × seed cases
  const NOISY_AXIS_WITHIN_3_DEG = 22; // of 24, measured

  it('keeps every feather linear with stops within ±6 levels, and the axis at the estimator floor', () => {
    const gf = gradientFeathers(256, 1);
    let worst = 0;
    let sumSq = 0;
    let within = 0;
    let cases = 0;
    for (const seed of [1, 2, 3]) {
      const img = withNoise(gf.image, 3, seed);
      const fit = fitAll(img, gf.labels);
      for (const shape of gf.shapes.slice(0, 8)) {
        const model = fit.models[shape.label];
        const name = `seed ${seed} feather ${shape.label}`;
        expect(model.fill.kind, name).toBe('linear');
        const f = model.fill as LinearGradient;
        const truth = shape.fill as LinearGradient;
        expect(stopErrorVsTruth(f, truth), name).toBeLessThanOrEqual(6);
        const err = axisErrorDeg(f, truth);
        worst = Math.max(worst, err);
        sumSq += err * err;
        if (err <= 3) within++;
        cases++;
      }
    }
    expect(cases).toBe(24);
    expect(worst).toBeLessThanOrEqual(NOISY_AXIS_MAX_DEG);
    expect(Math.sqrt(sumSq / cases)).toBeLessThanOrEqual(NOISY_AXIS_RMS_DEG);
    expect(within).toBeGreaterThanOrEqual(NOISY_AXIS_WITHIN_3_DEG);
  });
});

// ---------------------------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------------------------

describe('selectModel ladder', () => {
  it('a region with fewer than 64 core pixels is solid even on a steep ramp', () => {
    const img = rasterOf(16, 16, (x) => [16 * x, 0, 0]);
    const labels = labelsOf(16, 16, 2, (x, y) => (x >= 5 && x < 11 && y >= 5 && y < 11 ? 1 : 0));
    const fit = fitAll(img, labels, { sigma: 0 });
    const model = fit.models[1];
    expect(model.coreCount).toBe(16);
    expect(model.fill.kind).toBe('solid');
    expect(model.complex).toBe(false);
    expect(model.rmse).toBe(model.rmseFlat);
    expect(model.rmseFlat).toBeGreaterThan(10);
  });

  it('a degenerate best candidate becomes the solid mean colour (complex region)', () => {
    // ±8 checkerboard, and red +1 on the odd rows of the right half (a +0.5 step): nothing passes the ladder,
    // the lowest-RMSE candidate is the linear fit (measured 8.0029 against 8.0039 flat), and its stops are
    // 0.75 level apart, so it must come out as the solid mean colour.
    const img = rasterOf(64, 64, (x, y) => {
      const c = (x + y) % 2 === 0 ? 8 : -8;
      return [100 + c + (x >= 32 && y % 2 === 1 ? 1 : 0), 100 + c, 100 + c];
    });
    const fit = fitAll(img, singleRegion(64, 64), { sigma: 0, radial: false });
    const model = fit.models[0];
    const lin = fitLinear(img, fit.px, 0, fitPlane(fit.moments, 0), { sigma: 0, maxStops: 8 });
    expect(lin).not.toBeNull();
    const linFit = lin as { fill: LinearGradient; rmse: number };
    expect(linFit.rmse).toBeLessThan(model.rmseFlat);
    expect(isDegenerateGradient(linFit.fill)).toBe(true);
    expect(model.complex).toBe(true);
    expect(model.fill.kind).toBe('solid');
    expect(model.rmse).toBe(model.rmseFlat);
  });
});

// ---------------------------------------------------------------------------------------------
// Merges
// ---------------------------------------------------------------------------------------------

describe('planMerges', () => {
  const gf = gradientFeathers(256, 1);
  const feather = (id: number): LinearGradient => gf.shapes[id - 1].fill as LinearGradient;

  it('proposes nothing on the ground truth of gradientFeathers', () => {
    const fit = fitAll(gf.image, gf.labels);
    expect(planMerges(gf.image, fit.seg, fit.models)).toEqual([]);
  });

  for (const mode of ['across', 'along'] as const) {
    it(`merges the two halves of a feather cut ${mode} its axis, and never joins feathers 3 and 4`, () => {
      for (const id of [5, 3]) {
        const labels = splitFeather(gf.labels, feather(id), id, mode);
        const fit = fitAll(gf.image, labels);
        const pairs = planMerges(gf.image, fit.seg, fit.models);
        const root = rootsAfter(pairs, labels.count);
        expect(root(id), `feather ${id} ${mode}`).toBe(root(10));
        const roots = new Set(Array.from({ length: 10 }, (_, k) => root(k)));
        expect(roots.size, `feather ${id} ${mode}: the 10 true shapes stay apart`).toBe(10);
        expect(root(3)).not.toBe(root(4));
      }
    });
  }

  it('absorbs a tiny region and a region without core pixels into the neighbour that explains them', () => {
    const data = Int32Array.from(gf.labels.data);
    for (let y = 20; y < 23; y++) for (let x = 20; x < 23; x++) data[y * 256 + x] = 10; // 9 px speck in the background
    for (let x = 30; x < 70; x++) data[240 * 256 + x] = 11; // 1 px line, 40 px, no core
    const labels: RegionMap = { data, width: 256, height: 256, count: 12 };
    const fit = fitAll(gf.image, labels);
    expect(fit.models[11].coreCount).toBe(0);
    const pairs = planMerges(gf.image, fit.seg, fit.models);
    expect(pairs).toContainEqual([10, 0]);
    expect(pairs).toContainEqual([11, 0]);
    const root = rootsAfter(pairs, 12);
    expect(new Set(Array.from({ length: 10 }, (_, k) => root(k))).size).toBe(10);
  });

  it('sends a tiny region through a tiny neighbour of its own colour rather than into a longer-bordered different one', () => {
    // White background (0), navy block N (1), navy 4×4 t (2) touching N, navy 3×3 s (3) touching t and the
    // background only. With minArea 20 both s and t are tiny: s must go to t (its model explains s exactly)
    // and t to N, never s to the background it borders on 9 px.
    const NAVY: RGB = [1, 55, 128];
    const labels = labelsOf(64, 64, 4, (x, y) => {
      if (x >= 30 && x < 50 && y >= 20 && y < 40) return 1;
      if (x >= 26 && x < 30 && y >= 20 && y < 24) return 2;
      if (x >= 23 && x < 26 && y >= 20 && y < 23) return 3;
      return 0;
    });
    const img = rasterOf(64, 64, (x, y) => (labels.data[y * 64 + x] === 0 ? [255, 255, 255] : NAVY));
    const fit = fitAll(img, labels, { sigma: 0 });
    expect(fit.models[3].coreCount).toBe(1);
    expect(planMerges(img, fit.seg, fit.models, { minArea: 20 })).toEqual([
      [3, 2],
      [2, 1],
    ]);
  });

  it('never merges two linear regions whose axes differ by more than 15°, whatever the other limits', () => {
    const rot = 20 * (Math.PI / 180);
    const make = (angle: number): RasterImage =>
      rasterOf(64, 32, (x, y) => {
        if (x < 32) return [50 + 2 * x, 100, 150];
        const t = (x - 32) * Math.cos(angle) + y * Math.sin(angle);
        return [114 + 2 * t, 100, 150];
      });
    const labels = labelsOf(64, 32, 2, (x) => (x < 32 ? 0 : 1));
    const lax = { maxBoundaryJump: 1e9, maxRmseGain: 1e9 };
    const tilted = make(rot);
    const fitT = fitAll(tilted, labels, { sigma: 0 });
    expect(fitT.models.map((m) => m.fill.kind)).toEqual(['linear', 'linear']);
    expect(planMerges(tilted, fitT.seg, fitT.models, lax)).toEqual([]);
    const aligned = make(0);
    const fitA = fitAll(aligned, labels, { sigma: 0 });
    expect(planMerges(aligned, fitA.seg, fitA.models, lax)).toEqual([[1, 0]]);
  });

  it('merges the two halves of a radial disc larger than MERGE_MAX_JOINT_PIXELS (the joint fit keeps its radial model)', () => {
    const rd = radialDisc(512);
    const base = labelsFromSdf(512, rd.sdf);
    const data = Int32Array.from(base.data);
    for (let i = 0; i < data.length; i++) if (data[i] === 1 && i % 512 >= 240) data[i] = 2;
    const labels: RegionMap = { data, width: 512, height: 512, count: 3 };
    const fit = fitAll(rd.image, labels);
    expect(fit.models[1].fill.kind).toBe('radial');
    expect(fit.models[2].fill.kind).toBe('radial');
    expect(fit.px.offsets[3] - fit.px.offsets[1]).toBeGreaterThan(MERGE_MAX_JOINT_PIXELS);
    const pairs = planMerges(rd.image, fit.seg, fit.models, { pixels: fit.px });
    expect(pairs).toEqual([[2, 1]]);
  });

  it('reuses opts.pixels with the same result', () => {
    const labels = splitFeather(gf.labels, feather(5), 5, 'across');
    const fit = fitAll(gf.image, labels);
    expect(planMerges(gf.image, fit.seg, fit.models, { pixels: fit.px })).toEqual(planMerges(gf.image, fit.seg, fit.models));
  });
});

/**
 * One region holding two shadings at once, like pajaro's belly: the top half ramps one way across the image and the
 * bottom half ramps back the other way. The two gradients cancel, so planeAxis finds no axis at all and the best
 * single fill the whole ladder can offer is a flat colour (measured RMSE 39.6), and no number of stops helps: a
 * ramp is a function of one projection and this region needs two. Each half on its own is an exact 150-level ramp, so
 * the parts a split finds fit to a fraction of a level and none of them is flat enough for a solid fill.
 */
function twoAxisHalves(w = 128, h = 96): RasterImage {
  return rasterOf(w, h, (x, y) => {
    const u = (x + 0.5) / w;
    return 2 * y < h ? [40 + 150 * u, 50 + 140 * u, 70 + 120 * u] : [190 - 150 * u, 190 - 140 * u, 190 - 120 * u];
  });
}

/**
 * The limit of the split, measured: a VERTICAL seam whose halves ramp along x and along y is not split at all. The two
 * halves sit at disjoint parameters of the fitted x-ramp, so its stops follow each half on its own and the only thing
 * left unexplained is the y variation, which no cut across the axis separates by half.
 */
function perpendicularHalves(w = 128, h = 96): RasterImage {
  return rasterOf(w, h, (x, y) => {
    const u = (2 * (x + 0.5)) / w;
    const v = (y + 0.5) / h;
    return 2 * x < w ? [40 + 100 * u, 55 + 100 * u, 70 + 100 * u] : [40 + 100 * v, 55 + 100 * v, 70 + 100 * v];
  });
}

/** Pooled RMSE of `fill` over an explicit pixel list. */
function rmseOnPixels(img: RasterImage, list: readonly number[], fill: Fill): number {
  return rmseOf(img, { offsets: Int32Array.from([0, list.length]), indices: Int32Array.from(list) }, 0, fill);
}

/** The core pixels of region `id`, grouped by the part splitComplex put them in. */
function groupsOf(px: RegionPixels, id: number, assign: Uint8Array, parts: number): number[][] {
  const out: number[][] = Array.from({ length: parts }, () => []);
  for (let i = 0; i < assign.length; i++) out[assign[i]].push(px.indices[px.offsets[id] + i]);
  return out;
}

describe('splitComplex', () => {
  it('splits a region two shadings share, and every part comes out under RMSE 2 inside one half', () => {
    const img = twoAxisHalves();
    const fit = fitAll(img, singleRegion(128, 96), { sigma: 0 });
    const whole = fit.models[0];
    expect(whole.complex).toBe(true);
    expect(whole.fill.kind).toBe('solid'); // the halves' gradients cancel: no axis left to fit
    expect(whole.rmse).toBeGreaterThan(6);
    const split = splitComplex(img, fit.px, 0, { sigma: 0, maxStops: 8, fill: whole.fill });
    expect(split).not.toBeNull();
    if (split === null) throw new Error('unreachable');
    // The cut runs across the fitted axis, so a half comes back as one or two parts, never mixed with the other.
    expect(split.fills.length).toBeGreaterThanOrEqual(2);
    expect(split.fills.length).toBeLessThanOrEqual(2 ** SPLIT_MAX_DEPTH);
    const groups = groupsOf(fit.px, 0, split.assign, split.fills.length);
    const rmses = groups.map((g, p) => rmseOnPixels(img, g, split.fills[p]));
    const topShare = groups.map((g) => g.filter((p) => 2 * Math.floor(p / 128) < 96).length / g.length);
    console.info(
      `twoAxisHalves: whole ${whole.fill.kind} rmse ${whole.rmse.toFixed(2)} (flat ${whole.rmseFlat.toFixed(2)}) -> ` +
        groups.map((g, p) => `${split.fills[p].kind} ${g.length} px rmse ${rmses[p].toFixed(2)}`).join(', '),
    );
    for (let p = 0; p < groups.length; p++) {
      expect(rmses[p], `part ${p}`).toBeLessThan(2);
      expect(split.fills[p].kind, `part ${p}`).not.toBe('solid'); // every part still needs a gradient of its own
      expect(groups[p].length, `part ${p}`).toBeGreaterThanOrEqual(MIN_MODEL_CORE);
      // No part straddles the seam: at least 98 % of its pixels in one half.
      expect(Math.max(topShare[p], 1 - topShare[p]), `part ${p}`).toBeGreaterThanOrEqual(0.98);
    }
    expect(topShare.some((s) => s > 0.5), 'the top half is recovered').toBe(true);
    expect(topShare.some((s) => s < 0.5), 'the bottom half is recovered').toBe(true);
    // Every core pixel of the region belongs to exactly one part.
    expect(groups.reduce((n, g) => n + g.length, 0)).toBe(fit.px.offsets[1] - fit.px.offsets[0]);
  });

  it('is deterministic, and maxDepth bounds the parts (0 never splits)', () => {
    const img = twoAxisHalves();
    const fit = fitAll(img, singleRegion(128, 96), { sigma: 0 });
    const opts = { sigma: 0, maxStops: 8, fill: fit.models[0].fill };
    const a = splitComplex(img, fit.px, 0, opts);
    const b = splitComplex(img, fit.px, 0, opts);
    expect(a).not.toBeNull();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect((a?.fills ?? []).length).toBeLessThanOrEqual(2 ** SPLIT_MAX_DEPTH);
    expect(splitComplex(img, fit.px, 0, { ...opts, maxDepth: 0 })).toBeNull();
  });

  it('returns null for what one fill already explains and for a region too small for two models', () => {
    // A clean single ramp: the parts could only trade the noise floor, far from SPLIT_MIN_RMSE_GAIN.
    const hr = hueRamp(96);
    const fitHr = fitAll(hr.image, singleRegion(96, 96), { sigma: 0 });
    expect(fitHr.models[0].complex).toBe(false);
    expect(splitComplex(hr.image, fitHr.px, 0, { sigma: 0, maxStops: 8, fill: fitHr.models[0].fill })).toBeNull();
    // Flat art: a complex region keeps its best candidate, as before splitComplex existed.
    const fs = flatShapes3(48);
    const seg = segFromLabels(fs.image, regionMapFromLabelMap(fs.labels));
    expect(splitComplex(fs.image, corePixels(seg), 0, { sigma: 0, maxStops: 8 })).toBeNull();
    // The same two shadings on 12 × 10 px: 120 core pixels, under 2 · MIN_MODEL_CORE.
    const small = twoAxisHalves(12, 10);
    const fitSmall = fitAll(small, singleRegion(12, 10), { sigma: 0 });
    expect(fitSmall.px.offsets[1]).toBeLessThan(2 * MIN_MODEL_CORE);
    expect(splitComplex(small, fitSmall.px, 0, { sigma: 0, maxStops: 8 })).toBeNull();
  });

  it('leaves a vertical seam with perpendicular axes alone (the measured limit of the split)', () => {
    // Not a goal, a recorded limit: the halves sit at disjoint parameters of the fitted ramp, whose stops then follow
    // each of them, so no cut across that axis separates the halves and none earns SPLIT_MIN_RMSE_GAIN.
    const img = perpendicularHalves();
    const fit = fitAll(img, singleRegion(128, 96), { sigma: 0 });
    expect(fit.models[0].complex).toBe(true);
    expect(splitComplex(img, fit.px, 0, { sigma: 0, maxStops: 8, fill: fit.models[0].fill })).toBeNull();
  });
});
