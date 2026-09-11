import { describe, expect, it } from 'vitest';
import type { BinaryMask, Fill, RasterImage, RegionMap, RGB, Segmentation } from '../../src/types';
import {
  BAND_RINGS,
  CORE_MIN_ALPHA,
  MAX_GRADIENT_REGIONS,
  NO_REGION,
  ORPHAN_MIN_AREA,
  ORPHAN_RAY_LENGTH,
  ORPHAN_STEP_RATIO,
  PREBLUR_SIGMA,
  REGION_MIN_ALPHA,
  THIN_BLEND_RATIO,
  growIntoBand,
  labelComponents,
  mergeRegions,
  rankMap,
  refineLabels,
  regionAdjacency,
  regionMask,
  regionOrder,
  segmentEdges,
  segmentRegions,
} from '../../src/core/regions';
import { edgeThresholds, gateSobel, hysteresis, rgbEdgeMaps } from '../../src/core/edges';
import { immerkaerSigma } from '../../src/core/noise';
import { dilate1 } from '../../src/core/morphology';
import { gaussianBlurRaster } from '../../src/core/blur';
import { upscaleRaster } from '../../src/core/upscale';
import { flatShapes3, gradientFeathers, noisePhoto, withNoise } from '../../src/dev/synth';
import { assertMaskNested } from '../fixtures/helpers';
import { BAR_INK, SEMI_ALPHA, SEMI_INK, fullColumns, fullRows, paintCases, semiTransparentDisc, steepRamp, thinBars } from '../fixtures/gradientCases';

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RegionMap from rows of characters: '.' = -1, '0'-'9' and 'a'-'z' = ids 0..35. */
function mapOf(rows: string[], count?: number): RegionMap {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Int32Array(width * height);
  let max = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];
      const v = ch === '.' ? -1 : parseInt(ch, 36);
      data[y * width + x] = v;
      if (v > max) max = v;
    }
  }
  return { data, width, height, count: count ?? max + 1 };
}

/** BinaryMask from rows: '#' = 1. */
function maskOf(rows: string[]): BinaryMask {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = rows[y][x] === '#' ? 1 : 0;
  return { data, width, height };
}

function raster(
  width: number,
  height: number,
  f: (x: number, y: number) => [number, number, number, number],
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(f(x, y), (y * width + x) * 4);
  return { data, width, height };
}

/** A Segmentation around `regions` (area and adjacency computed; edge/core empty). */
function segOf(regions: RegionMap): Segmentation {
  const n = regions.width * regions.height;
  const area = new Float64Array(regions.count);
  for (let i = 0; i < n; i++) if (regions.data[i] >= 0) area[regions.data[i]]++;
  return {
    regions,
    edge: { data: new Uint8Array(n), width: regions.width, height: regions.height },
    core: { data: new Uint8Array(n), width: regions.width, height: regions.height },
    area,
    adjacency: regionAdjacency(regions),
    sigma: 0.5,
    edgeShare: 0.25,
  };
}

/** Reference 4-connected labelling by BFS, ids in raster order of the first pixel. */
function referenceLabels(mask: BinaryMask): { data: Int32Array; count: number } {
  const { width: w, height: h, data: m } = mask;
  const out = new Int32Array(w * h).fill(-1);
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    if (m[i] === 0 || out[i] >= 0) continue;
    const id = count++;
    out[i] = id;
    const queue = [i];
    while (queue.length > 0) {
      const p = queue.pop() as number;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= w * h || m[q] === 0 || out[q] >= 0) continue;
        out[q] = id;
        queue.push(q);
      }
    }
  }
  return { data: out, count };
}

/** 1 for pixels with a 4-neighbour of another ground-truth label (the 1-px anti-aliasing band, both sides). */
function aaBand(gt: RegionMap): Uint8Array {
  const { width: w, height: h, data } = gt;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = data[i];
      if ((x > 0 && data[i - 1] !== l) || (x < w - 1 && data[i + 1] !== l) || (y > 0 && data[i - w] !== l) || (y < h - 1 && data[i + w] !== l)) {
        out[i] = 1;
      }
    }
  }
  return out;
}

/** For each region: its majority ground-truth label outside the band, and its IoU with that label outside the band. */
function matchRegions(regions: RegionMap, gt: RegionMap): Array<{ gt: number; iou: number; area: number }> {
  const n = regions.width * regions.height;
  const band = aaBand(gt);
  const overlap: Float64Array[] = [];
  const area = new Float64Array(regions.count);
  for (let k = 0; k < regions.count; k++) overlap.push(new Float64Array(gt.count));
  const gtArea = new Float64Array(gt.count);
  for (let i = 0; i < n; i++) {
    const k = regions.data[i];
    if (k >= 0) area[k]++;
    if (band[i] !== 0) continue;
    gtArea[gt.data[i]]++;
    if (k >= 0) overlap[k][gt.data[i]]++;
  }
  return overlap.map((ov, k) => {
    let g = 0;
    for (let j = 1; j < gt.count; j++) if (ov[j] > ov[g]) g = j;
    let inRegion = 0;
    for (let j = 0; j < gt.count; j++) inRegion += ov[j];
    return { gt: g, iou: ov[g] / (inRegion + gtArea[g] - ov[g]), area: area[k] };
  });
}

/**
 * Stand-in for fillModel.planMerges, which owns the absorption of fragments (this module only applies merges):
 * (1) adjacent flat regions (standard deviation <= 4 levels per channel over their core) whose core means are
 * within 6 levels merge; (2) a region with fewer than 16 core pixels merges into the adjacent region of closest
 * mean colour. Both applied with mergeRegions.
 */
function emulateMerges(img: RasterImage, seg0: Segmentation): Segmentation {
  const stats = (seg: Segmentation) => {
    const K = seg.regions.count;
    const n = img.width * img.height;
    const cnt = new Float64Array(K);
    const all = new Float64Array(K);
    const sum = new Float64Array(K * 3);
    const sq = new Float64Array(K * 3);
    const sumAll = new Float64Array(K * 3);
    for (let i = 0; i < n; i++) {
      const k = seg.regions.data[i];
      if (k < 0) continue;
      all[k]++;
      const core = seg.core.data[i] !== 0;
      if (core) cnt[k]++;
      for (let c = 0; c < 3; c++) {
        const v = img.data[i * 4 + c];
        sumAll[k * 3 + c] += v;
        if (core) {
          sum[k * 3 + c] += v;
          sq[k * 3 + c] += v * v;
        }
      }
    }
    const mean = (k: number, c: number): number => (cnt[k] > 0 ? sum[k * 3 + c] / cnt[k] : sumAll[k * 3 + c] / all[k]);
    const sd = (k: number, c: number): number =>
      cnt[k] > 0 ? Math.sqrt(Math.max(0, sq[k * 3 + c] / cnt[k] - mean(k, c) ** 2)) : Infinity;
    return { cnt, mean, sd };
  };
  let seg = seg0;
  let st = stats(seg);
  const flatPairs: Array<[number, number]> = [];
  for (let a = 0; a < seg.regions.count; a++) {
    for (const b of seg.adjacency[a]) {
      if (b <= a) continue;
      let ok = true;
      for (let c = 0; c < 3 && ok; c++) ok = st.sd(a, c) <= 4 && st.sd(b, c) <= 4 && Math.abs(st.mean(a, c) - st.mean(b, c)) <= 6;
      if (ok) flatPairs.push([a, b]);
    }
  }
  seg = mergeRegions(seg, flatPairs).seg;
  st = stats(seg);
  const tinyPairs: Array<[number, number]> = [];
  for (let k = 0; k < seg.regions.count; k++) {
    if (st.cnt[k] >= 16) continue;
    let best = -1;
    let bestDist = Infinity;
    for (const j of seg.adjacency[k]) {
      let dist = 0;
      for (let c = 0; c < 3; c++) dist += (st.mean(k, c) - st.mean(j, c)) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = j;
      }
    }
    if (best >= 0) tinyPairs.push([k, best]);
  }
  return mergeRegions(seg, tinyPairs).seg;
}

describe('constants', () => {
  it('match the contract', () => {
    expect(MAX_GRADIENT_REGIONS).toBe(2000);
    expect(PREBLUR_SIGMA).toBe(0.7);
    expect(CORE_MIN_ALPHA).toBe(128);
    expect([ORPHAN_STEP_RATIO, ORPHAN_RAY_LENGTH, ORPHAN_MIN_AREA, THIN_BLEND_RATIO]).toEqual([2, 8, 16, 0.5]);
    expect(REGION_MIN_ALPHA).toBe(128);
    expect(BAND_RINGS).toBe(3);
    expect(NO_REGION).toBe(0xffff);
  });
});

describe('labelComponents', () => {
  it('labels 4-connected components in raster order of their first pixel; diagonal contact does not connect', () => {
    const r = labelComponents(maskOf(['#.#', '.#.', '#.#']));
    expect(r.count).toBe(5);
    expect(Array.from(r.data)).toEqual([0, -1, 1, -1, 2, -1, 3, -1, 4]);
  });

  it('unites provisional labels that meet later (U shapes, combs, staircases)', () => {
    expect(labelComponents(maskOf(['#.#.#', '#.#.#', '#####'])).count).toBe(1);
    const stair = labelComponents(maskOf(['...#', '..##', '.##.', '##..']));
    expect(stair.count).toBe(1);
    expect(Array.from(stair.data).filter((v) => v >= 0).every((v) => v === 0)).toBe(true);
    const two = labelComponents(maskOf(['##..##', '#....#', '######', '......', '..##..']));
    expect(two.count).toBe(2);
    expect(two.data[4 * 6 + 2]).toBe(1);
  });

  it('equals a BFS labelling on random masks', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rnd = prng(seed);
      const w = 50 + seed;
      const h = 37;
      const data = new Uint8Array(w * h);
      for (let i = 0; i < data.length; i++) data[i] = rnd() < 0.55 ? 1 : 0;
      const mask = { data, width: w, height: h };
      const ref = referenceLabels(mask);
      const got = labelComponents(mask);
      expect(got.count, `seed ${seed}`).toBe(ref.count);
      expect(Array.from(got.data), `seed ${seed}`).toEqual(Array.from(ref.data));
    }
  });

  it('300 isolated points give 300 labels (beyond the 256 of LabelMap)', () => {
    const mask = maskOf(Array.from({ length: 30 }, (_, y) => Array.from({ length: 40 }, (_, x) => (x % 2 === 0 && y % 2 === 0 ? '#' : '.')).join('')));
    const r = labelComponents(mask);
    expect(r.count).toBe(300);
    for (let j = 0; j < 15; j++) for (let i = 0; i < 20; i++) expect(r.data[2 * j * 40 + 2 * i]).toBe(j * 20 + i);
  });

  it('handles 131 072 components (union-find storage grows)', () => {
    const w = 512;
    const data = new Uint8Array(w * w);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) data[y * w + x] = (x + y) & 1 ? 0 : 1;
    const r = labelComponents({ data, width: w, height: w });
    expect(r.count).toBe(131072);
    expect(r.data[w * w - 1]).toBe(131071);
    expect(r.data[w + 1]).toBe(256 + 0);
  });
});

describe('growIntoBand', () => {
  const all = (w: number, h: number): BinaryMask => ({ data: new Uint8Array(w * h).fill(1), width: w, height: h });

  it('a band pixel takes the most frequent label among its 8 labelled neighbours (tie: smaller id)', () => {
    const five = growIntoBand(mapOf(['001', '0.1', '111']), all(3, 3), 1);
    expect(five.data[4]).toBe(1); // 0 ×3, 1 ×5
    const tie = growIntoBand(mapOf(['001', '0.1', '011']), all(3, 3), 1);
    expect(tie.data[4]).toBe(0); // 0 ×4, 1 ×4
  });

  it('grows ring by ring from the labels as they were before each ring', () => {
    const strip = mapOf(['0...1']);
    // One ring: the middle pixel had no labelled 4-neighbour before it, so it is left over (new component 2).
    const one = growIntoBand(strip, all(5, 1), 1);
    expect(Array.from(one.data)).toEqual([0, 0, 2, 1, 1]);
    expect(one.count).toBe(3);
    const two = growIntoBand(strip, all(5, 1), 2);
    expect(Array.from(two.data)).toEqual([0, 0, 0, 1, 1]); // tie 0 / 1 -> 0
    expect(two.count).toBe(2);
    const wide = growIntoBand(mapOf(['0......']), all(7, 1), BAND_RINGS);
    expect(Array.from(wide.data)).toEqual([0, 0, 0, 0, 1, 1, 1]);
    expect(wide.count).toBe(2);
  });

  it('only eligible pixels grow; after the rings the unreached ones form new 4-connected components', () => {
    const regions = mapOf(['0....', '.....']);
    const eligible = maskOf(['##..#', '....#']);
    const r = growIntoBand(regions, eligible, 3);
    expect(r.count).toBe(2);
    expect(Array.from(r.data)).toEqual([0, 0, -1, -1, 1, -1, -1, -1, -1, 1]);
    // A pixel touching a label only diagonally is not in any ring.
    const diag = growIntoBand(mapOf(['0.', '..']), maskOf(['#.', '.#']), 3);
    expect(Array.from(diag.data)).toEqual([0, -1, -1, 1]);
    expect(diag.count).toBe(2);
    // rings 0: only the leftovers.
    const none = growIntoBand(mapOf(['0..']), maskOf(['###']), 0);
    expect(Array.from(none.data)).toEqual([0, 1, 1]);
  });

  it('does not mutate its inputs and reads negative labels as none', () => {
    const regions = mapOf(['0.1']);
    regions.data[1] = -5;
    const copy = Int32Array.from(regions.data);
    const r = growIntoBand(regions, all(3, 1), 1);
    expect(Array.from(regions.data)).toEqual(Array.from(copy));
    expect(Array.from(r.data)).toEqual([0, 0, 1]);
  });
});

describe('regionAdjacency', () => {
  it('lists 4-adjacent ids ascending, without repeats, ignoring -1 and diagonal contact', () => {
    const adj = regionAdjacency(mapOf(['001', '221', '.13']));
    expect(adj.map((a) => Array.from(a))).toEqual([[1, 2], [0, 2, 3], [0, 1], [1]]);
    expect(regionAdjacency(mapOf(['0.', '.1'])).map((a) => Array.from(a))).toEqual([[], []]);
  });

  it('equals a brute-force set on random maps', () => {
    const rnd = prng(9);
    const w = 41;
    const h = 23;
    const data = new Int32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = rnd() < 0.1 ? -1 : Math.floor(rnd() * 12);
    const regions = { data, width: w, height: h, count: 12 };
    const sets = Array.from({ length: 12 }, () => new Set<number>());
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = data[y * w + x];
        for (const b of [x + 1 < w ? data[y * w + x + 1] : -1, y + 1 < h ? data[(y + 1) * w + x] : -1]) {
          if (a < 0 || b < 0 || a === b) continue;
          sets[a].add(b);
          sets[b].add(a);
        }
      }
    }
    expect(regionAdjacency(regions).map((a) => Array.from(a))).toEqual(sets.map((s) => [...s].sort((p, q) => p - q)));
  });
});

describe('segmentRegions', () => {
  it('builds the edge mask from the preblurred RGB maps and keeps every invariant', () => {
    const f = gradientFeathers(256, 1);
    const img = f.image;
    const n = img.width * img.height;
    const before = new Uint8ClampedArray(img.data);
    const seg = segmentRegions(img, { regionDetail: 1 });
    expect(img.data).toEqual(before);
    expect(seg.sigma).toBe(immerkaerSigma(img));
    const maps = rgbEdgeMaps(gaussianBlurRaster(img, PREBLUR_SIGMA));
    const t = edgeThresholds(seg.sigma, 1);
    const lap = hysteresis(maps.laplacian.data, 256, 256, t.lapLo, t.lapHi).data;
    const sob = hysteresis(gateSobel(maps.sobel.data, maps.laplacian.data, 256, 256, t), 256, 256, t.sobLo, t.sobHi).data;
    expect(Array.from(segmentEdges(img, { regionDetail: 1 }).edge.data)).toEqual(Array.from(seg.edge.data));
    // A region without a non-edge pixel (a thin region) takes its core from addThinCore; any other core pixel is non-edge.
    const regular = new Uint8Array(seg.regions.count);
    for (let i = 0; i < n; i++) if ((lap[i] | sob[i]) === 0) regular[seg.regions.data[i]] = 1;
    let edges = 0;
    for (let i = 0; i < n; i++) {
      const e = lap[i] | sob[i];
      edges += e;
      expect(seg.edge.data[i]).toBe(e);
      if (e === 0) expect(seg.core.data[i]).toBe(1);
      else if (seg.core.data[i] === 1) expect(regular[seg.regions.data[i]]).toBe(0);
      expect(seg.regions.data[i]).toBeGreaterThanOrEqual(0); // opaque: every pixel has a region
    }
    expect(seg.edgeShare).toBeCloseTo(edges / n, 12);
    const area = new Float64Array(seg.regions.count);
    for (let i = 0; i < n; i++) area[seg.regions.data[i]]++;
    expect(Array.from(seg.area)).toEqual(Array.from(area));
    expect(seg.adjacency.map((a) => Array.from(a))).toEqual(regionAdjacency(seg.regions).map((a) => Array.from(a)));
    // Explicit sigma: used as given (stronger thresholds, fewer edges).
    const loud = segmentRegions(img, { regionDetail: 1, sigma: 5 });
    expect(loud.sigma).toBe(5);
    expect(loud.edgeShare).toBeLessThan(seg.edgeShare);
  });

  it('regions follow the core components: one per component, each with core pixels (no seedless leftovers)', () => {
    for (const seed of [1, 2, 3]) {
      const f = gradientFeathers(256, seed);
      for (const img of [f.image, withNoise(f.image, 3, seed)]) {
        const seg = segmentRegions(img, { regionDetail: 1 });
        const comps = labelComponents(seg.core);
        expect(seg.regions.count).toBe(comps.count);
        const coreCount = new Float64Array(seg.regions.count);
        for (let i = 0; i < comps.data.length; i++) {
          if (comps.data[i] >= 0) {
            expect(seg.regions.data[i]).toBe(comps.data[i]);
            coreCount[seg.regions.data[i]]++;
          }
        }
        expect(Array.from(coreCount).every((c) => c > 0)).toBe(true);
        // Measured 23-28: 10 shapes plus fragments of 1-10 core px at feather tips and in the gaps.
        expect(seg.regions.count).toBeLessThanOrEqual(30);
      }
    }
  });

  it('gradientFeathers: 10 ± 1 regions of >= 16 px after merging fragments, each with IoU >= 0.97 against its shape outside the AA band', () => {
    for (const seed of [1, 2, 3]) {
      const f = gradientFeathers(256, seed);
      const merged = emulateMerges(f.image, segmentRegions(f.image, { regionDetail: 1 }));
      const matches = matchRegions(merged.regions, f.labels).filter((m) => m.area >= 16);
      expect(matches.length, `seed ${seed}`).toBeGreaterThanOrEqual(9);
      expect(matches.length, `seed ${seed}`).toBeLessThanOrEqual(11);
      expect(new Set(matches.map((m) => m.gt)).size, `seed ${seed}`).toBe(10);
      for (const m of matches) expect(m.iou, `seed ${seed} shape ${m.gt}`).toBeGreaterThanOrEqual(0.97);
    }
  });

  it('gradientFeathers with ±3 noise: 10 ± 1 regions after merging; the best region of every shape has IoU >= 0.93 (worst measured 0.935)', () => {
    const f = gradientFeathers(256, 1);
    for (const seed of [1, 2, 3]) {
      const img = withNoise(f.image, 3, seed);
      const merged = emulateMerges(img, segmentRegions(img, { regionDetail: 1 }));
      const matches = matchRegions(merged.regions, f.labels).filter((m) => m.area >= 16);
      expect(matches.length, `seed ${seed}`).toBeGreaterThanOrEqual(9);
      expect(matches.length, `seed ${seed}`).toBeLessThanOrEqual(11);
      for (let g = 0; g < 10; g++) {
        const best = Math.max(0, ...matches.filter((m) => m.gt === g).map((m) => m.iou));
        expect(best, `seed ${seed} shape ${g}`).toBeGreaterThanOrEqual(0.93);
      }
    }
  });

  it('feathers 3 (blue→purple) and 4 (purple→blue) are separate regions', () => {
    for (const seed of [1, 2, 3]) {
      const f = gradientFeathers(256, seed);
      const seg = segmentRegions(f.image, { regionDetail: 1 });
      const band = aaBand(f.labels);
      const majority = (label: number): number => {
        const counts = new Map<number, number>();
        for (let i = 0; i < band.length; i++) {
          if (f.labels.data[i] === label && band[i] === 0) counts.set(seg.regions.data[i], (counts.get(seg.regions.data[i]) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      };
      const r3 = majority(3);
      const r4 = majority(4);
      expect(r3).not.toBe(r4);
      // And neither region takes a meaningful part of the other feather.
      let cross = 0;
      for (let i = 0; i < band.length; i++) if (band[i] === 0 && ((f.labels.data[i] === 3 && seg.regions.data[i] === r4) || (f.labels.data[i] === 4 && seg.regions.data[i] === r3))) cross++;
      expect(cross).toBe(0);
    }
  });

  it('flatShapes3: exactly 3 regions matching the labels outside the AA band', () => {
    const fs = flatShapes3(96);
    const seg = segmentRegions(fs.image, { regionDetail: 1 });
    expect(seg.regions.count).toBe(3);
    const gt: RegionMap = { data: Int32Array.from(fs.labels.data), width: 96, height: 96, count: 3 };
    for (const m of matchRegions(seg.regions, gt)) expect(m.iou).toBeGreaterThanOrEqual(0.999);
  });

  it('regionDetail moves the thresholds: more edge pixels at 2, fewer at 0.5 (gradientFeathers 10.6 / 11.9 / 12.8 %)', () => {
    const img = gradientFeathers(256, 1).image;
    const low = segmentRegions(img, { regionDetail: 0.5 });
    const mid = segmentRegions(img, { regionDetail: 1 });
    const high = segmentRegions(img, { regionDetail: 2 });
    expect(low.edgeShare).toBeLessThan(mid.edgeShare);
    expect(mid.edgeShare).toBeLessThan(high.edgeShare);
    expect(high.regions.count).toBeGreaterThanOrEqual(mid.regions.count);
  });

  it('noisePhoto, a smooth colour field, is edge only along its bilinear creases (0.37); the ungated Sobel flooded 0.93 of it', () => {
    const img = noisePhoto(256);
    const share = segmentRegions(img, { regionDetail: 1 }).edgeShare;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.45);
    const t = edgeThresholds(immerkaerSigma(img), 1);
    const maps = rgbEdgeMaps(gaussianBlurRaster(img, PREBLUR_SIGMA));
    const ungated = hysteresis(maps.sobel.data, 256, 256, t.sobLo, t.sobHi).data.reduce((a, v) => a + v, 0) / (256 * 256);
    expect(ungated).toBeGreaterThan(0.9);
  });

  it('thin strokes keep a region of their own: bars 2 to 12 px wide each get a region with core in their fully covered columns', () => {
    const { image, bars } = thinBars();
    const seg = segmentRegions(image, { regionDetail: 1 });
    const background = seg.regions.data[0];
    expect(seg.regions.count).toBe(bars.length + 1);
    for (const bar of bars) {
      const cols = fullColumns(bar);
      const rows = fullRows(bar);
      const label = seg.regions.data[60 * 200 + cols[Math.floor(cols.length / 2)]];
      expect(label, `bar ${bar.x0}`).not.toBe(background);
      let core = 0;
      let sum = 0;
      for (const y of rows) {
        for (const x of cols) {
          const i = y * 200 + x;
          expect(seg.regions.data[i], `bar ${bar.x0} (${x}, ${y})`).toBe(label);
          if (seg.core.data[i] === 1) {
            core++;
            sum += image.data[i * 4];
          }
        }
      }
      // Measured: 100, 200, 300 and 400 core px for the 2-5 px bars (0 before the orphan rescue); the wider bars keep their
      // edge-mask core, 2 px short of the bar ends (96 px for the 6 px bar).
      expect(core, `bar ${bar.x0}`).toBeGreaterThanOrEqual(rows.length - 4);
      expect(Math.abs(sum / core - BAR_INK[0]), `bar ${bar.x0}`).toBeLessThanOrEqual(1);
      // The core of the bar never leaves the pixels the bar touches.
      for (let i = 0; i < seg.regions.data.length; i++) {
        if (seg.regions.data[i] !== label || seg.core.data[i] === 0) continue;
        const x = i % 200;
        expect(x >= Math.floor(bar.x0) && x < Math.ceil(bar.x1), `bar ${bar.x0} core at x ${x}`).toBe(true);
      }
    }
  });

  it('orphans under ORPHAN_MIN_AREA stay with the region that grew into them: 3×3 dots are absorbed, 5×5 dots are regions', () => {
    const dots = (side: number): RasterImage =>
      raster(96, 96, (x, y) => (x % 16 >= 6 && x % 16 < 6 + side && y % 16 >= 6 && y % 16 < 6 + side ? [20, 20, 20, 255] : [255, 255, 255, 255]));
    expect(segmentRegions(dots(3), { regionDetail: 1 }).regions.count).toBe(1);
    expect(segmentRegions(dots(5), { regionDetail: 1 }).regions.count).toBe(37);
  });

  it('a steep ramp keeps its core (the Sobel hysteresis no longer floods it): one region, core on >= 75 % of its inside', () => {
    // Measured core share of the inside (1 px from the rectangle): w 24 0.780, w 36 0.841, w 48 0.892 (0, 0 and 0.021 before).
    for (const [w, least] of [[24, 0.75], [36, 0.8], [48, 0.85]] as const) {
      const { image } = steepRamp(w);
      const seg = segmentRegions(image, { regionDetail: 1 });
      expect(seg.regions.count, `w ${w}`).toBe(2);
      const label = seg.regions.data[60 * 160 + 40 + Math.floor(w / 2)];
      let inside = 0;
      let core = 0;
      for (let y = 21; y < 107; y++) {
        for (let x = 41; x < 39 + w; x++) {
          inside++;
          expect(seg.regions.data[y * 160 + x]).toBe(label);
          core += seg.core.data[y * 160 + x];
        }
      }
      expect(core / inside, `w ${w}`).toBeGreaterThanOrEqual(least);
    }
  });

  it('a semi-transparent disc (alpha 200) has core pixels, fitted on its own colour', () => {
    const image = semiTransparentDisc();
    const seg = segmentRegions(image, { regionDetail: 1 });
    expect(seg.regions.count).toBe(1);
    let core = 0;
    let inside = 0;
    for (let i = 0; i < 128 * 128; i++) {
      if (image.data[i * 4 + 3] !== SEMI_ALPHA) continue;
      inside++;
      if (seg.core.data[i] === 0) continue;
      core++;
      for (let c = 0; c < 3; c++) expect(image.data[i * 4 + c]).toBe(SEMI_INK[c]);
    }
    expect(core / inside).toBeGreaterThanOrEqual(0.9);
  });

  it('every region has core pixels, also thin shapes that transparency isolates (leftovers)', () => {
    const lines = paintCases(64, 64, null, [
      { inside: (x, y) => x >= 10 && x < 12 && y >= 5 && y < 60, colour: () => [200, 40, 40, 255] },
      { inside: (x, y) => x >= 30 && x < 33.5 && y >= 5 && y < 60, colour: () => [40, 40, 200, 160] },
      { inside: (x, y) => Math.hypot(x - 50, y - 30) < 1.6, colour: () => [10, 200, 10, 255] },
    ]);
    for (const img of [lines, semiTransparentDisc(), thinBars().image, steepRamp(24).image, gradientFeathers(256, 2).image]) {
      const seg = segmentRegions(img, { regionDetail: 1 });
      const core = new Float64Array(seg.regions.count);
      for (let i = 0; i < seg.core.data.length; i++) {
        if (seg.core.data[i] === 0) continue;
        expect(seg.regions.data[i]).toBeGreaterThanOrEqual(0);
        core[seg.regions.data[i]]++;
      }
      expect(Array.from(core).every((c) => c > 0)).toBe(true);
    }
    expect(segmentRegions(lines, { regionDetail: 1 }).regions.count).toBe(3);
  });

  it('with transparency: -1 exactly below alpha 128, 300 isolated dots give 300 regions, each with core pixels', () => {
    const w = 100;
    const h = 75;
    const img = raster(w, h, (x, y) => {
      const i = Math.floor(x / 5);
      const j = Math.floor(y / 5);
      const inDot = x % 5 >= 1 && x % 5 <= 3 && y % 5 >= 1 && y % 5 <= 3;
      if (!inDot) return [0, 0, 0, (x + y) % 3 === 0 ? 127 : 0];
      const alpha = x % 5 === 1 && y % 5 === 1 ? 128 : x % 5 === 3 && y % 5 === 3 ? 249 : 255;
      return [(i * 37) % 256, (j * 53) % 256, ((i + j) * 29) % 256, alpha];
    });
    const seg = segmentRegions(img, { regionDetail: 1 });
    expect(seg.regions.count).toBe(300);
    for (let i = 0; i < w * h; i++) {
      const a = img.data[i * 4 + 3];
      if (a < 128) expect(seg.regions.data[i]).toBe(-1);
      else expect(seg.regions.data[i]).toBeGreaterThanOrEqual(0);
      if (a < CORE_MIN_ALPHA) expect(seg.core.data[i]).toBe(0);
    }
    const cores = new Float64Array(300);
    for (let i = 0; i < w * h; i++) if (seg.core.data[i] === 1) cores[seg.regions.data[i]]++;
    expect(Array.from(cores).every((c) => c > 0)).toBe(true);
    const counts = new Float64Array(300);
    for (let i = 0; i < w * h; i++) if (seg.regions.data[i] >= 0) counts[seg.regions.data[i]]++;
    expect(Array.from(counts).every((c) => c === 9)).toBe(true);
    expect(regionOrder(seg)).toHaveLength(300);
  });
});

describe('mergeRegions', () => {
  it('applies pairs through union-find, compacts ids by smallest original id and recomputes regions, area and adjacency', () => {
    const seg = segOf(mapOf(['0011', '0213', '4443']));
    const before = Int32Array.from(seg.regions.data);
    const { seg: merged, remap } = mergeRegions(seg, [
      [0, 2],
      [2, 3],
    ]);
    expect(Array.from(seg.regions.data)).toEqual(Array.from(before));
    expect(Array.from(remap)).toEqual([0, 1, 0, 0, 2]);
    expect(merged.regions.count).toBe(3);
    expect(Array.from(merged.regions.data)).toEqual([0, 0, 1, 1, 0, 0, 1, 0, 2, 2, 2, 0]);
    expect(Array.from(merged.area)).toEqual([6, 3, 3]);
    expect(merged.adjacency.map((a) => Array.from(a))).toEqual(regionAdjacency(merged.regions).map((a) => Array.from(a)));
    expect(merged.edge).toBe(seg.edge);
    expect(merged.core).toBe(seg.core);
    expect(merged.sigma).toBe(seg.sigma);
    expect(merged.edgeShare).toBe(seg.edgeShare);
  });

  it('[a, b], [b, c] puts a and b in c; a pair inside one group is a no-op; no pairs keeps the ids', () => {
    const seg = segOf(mapOf(['0123']));
    expect(Array.from(mergeRegions(seg, [[0, 1], [1, 2]]).remap)).toEqual([0, 0, 0, 1]);
    expect(Array.from(mergeRegions(seg, [[3, 1], [1, 3], [3, 3]]).remap)).toEqual([0, 1, 2, 1]);
    const same = mergeRegions(seg, []);
    expect(Array.from(same.remap)).toEqual([0, 1, 2, 3]);
    expect(Array.from(same.seg.regions.data)).toEqual([0, 1, 2, 3]);
  });

  it('keeps -1 and matches regionAdjacency on a merged segmentation of gradientFeathers', () => {
    const f = gradientFeathers(128, 2);
    const seg = segmentRegions(f.image, { regionDetail: 1 });
    const pairs: Array<[number, number]> = [];
    for (let k = 1; k < seg.regions.count; k += 2) pairs.push([k, seg.adjacency[k][0]]);
    const merged = mergeRegions(seg, pairs).seg;
    expect(merged.adjacency.map((a) => Array.from(a))).toEqual(regionAdjacency(merged.regions).map((a) => Array.from(a)));
    expect(merged.area.reduce((s, v) => s + v, 0)).toBe(128 * 128);
  });

  it('throws on ids out of range', () => {
    const seg = segOf(mapOf(['01']));
    expect(() => mergeRegions(seg, [[0, 2]])).toThrow(RangeError);
    expect(() => mergeRegions(seg, [[-1, 0]])).toThrow(RangeError);
    expect(() => mergeRegions(seg, [[0.5, 1]])).toThrow(RangeError);
  });
});

describe('regionOrder', () => {
  /** Region map of discs/rings by distance from centres (1-px sampling at pixel centres). */
  function radialMap(width: number, height: number, f: (x: number, y: number) => number, count: number): RegionMap {
    const data = new Int32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x + 0.5, y + 0.5);
    return { data, width, height, count };
  }

  it('a ring around a larger disc: the disc is painted after the ring; the background stays first', () => {
    // ids: disc 0 (r <= 15, 709 px), background 1, ring 2 (15 < r <= 18).
    const map = radialMap(40, 40, (x, y) => {
      const r = Math.hypot(x - 20, y - 20);
      return r <= 15 ? 0 : r <= 18 ? 2 : 1;
    }, 3);
    const seg = segOf(map);
    expect(seg.area[0]).toBeGreaterThan(seg.area[1]);
    expect(seg.area[1]).toBeGreaterThan(seg.area[2]);
    expect(Array.from(seg.adjacency[1])).toEqual([2]); // the background also has a single neighbour, but touches the border
    expect(regionOrder(seg)).toEqual([1, 2, 0]);
  });

  it('an enclosed region already after its encloser keeps its place; one before it moves right after it', () => {
    // Left: ring A (id 0, 15..17) around disc B (id 1, r 15). Right: ring C (id 2, 9..16) around disc D (id 3, r 9). Background 4.
    const map = radialMap(80, 40, (x, y) => {
      const rl = Math.hypot(x - 20, y - 20);
      const rr = Math.hypot(x - 60, y - 20);
      if (rl <= 15) return 1;
      if (rl <= 17) return 0;
      if (rr <= 9) return 3;
      if (rr <= 16) return 2;
      return 4;
    }, 5);
    const seg = segOf(map);
    // Area order: background, B, C, D, A.
    const byArea = [0, 1, 2, 3, 4].sort((a, b) => seg.area[b] - seg.area[a] || a - b);
    expect(byArea).toEqual([4, 1, 2, 3, 0]);
    expect(regionOrder(seg)).toEqual([4, 2, 3, 0, 1]);
  });

  it('area descending with ties to the smaller id; two regions isolated by transparency keep the area order', () => {
    const tie = segOf(mapOf(['0011', '2233']));
    expect(regionOrder(tie)).toEqual([0, 1, 2, 3]);
    const island = segOf(mapOf(['........', '.000111.', '.00011..', '........']));
    // 0 (6 px) and 1 (5 px): each is the only neighbour of the other and neither touches the border.
    expect(regionOrder(island)).toEqual([0, 1]);
    const island2 = segOf(mapOf(['........', '.001111.', '.00111..', '........']));
    expect(regionOrder(island2)).toEqual([1, 0]);
  });

  it('returns a permutation on a real segmentation', () => {
    const seg = segmentRegions(gradientFeathers(256, 3).image, { regionDetail: 1 });
    const order = regionOrder(seg);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: seg.regions.count }, (_, i) => i));
  });
});

describe('refineLabels', () => {
  const RED: RGB = [255, 0, 0];
  const BLUE: RGB = [0, 0, 255];
  const solid = (c: RGB): Fill => ({ kind: 'solid', color: c });

  it('copies uniform 3×3 parents, picks the best-predicting label on mixed ones, NO_REGION below alpha 128 or without labels', () => {
    const seg = segOf(mapOf(['000111']));
    const colours: Array<[number, number, number, number]> = [
      [255, 0, 0, 255], // X0 -> x0 uniform 0
      [0, 0, 255, 255], // X1 -> x0 uniform: 0 whatever the colour
      [255, 0, 0, 255],
      [255, 0, 0, 255],
      [255, 0, 0, 255], // X4 -> x2 mixed, red -> 0
      [0, 0, 255, 255], // X5 -> x2 mixed, blue -> 1
      [255, 0, 0, 255], // X6 -> x3 mixed, red -> 0
      [128, 0, 128, 255], // X7 -> x3 mixed, equidistant -> own label 1
      [0, 0, 255, 255],
      [255, 0, 0, 255], // X9 -> x4: its 3×3 is x3..x5, all 1 -> 1
      [0, 0, 255, 255],
      [0, 0, 255, 100], // X11 alpha < 128
    ];
    const up = raster(12, 1, (x) => colours[x]);
    const labels = refineLabels(seg, [solid(RED), solid(BLUE)], up, 2);
    expect(Array.from(labels)).toEqual([0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, NO_REGION]);
    // Equidistant on a parent labelled 0 -> 0.
    const tie = refineLabels(seg, [solid(RED), solid(BLUE)], raster(12, 1, (x) => (x === 4 ? [128, 0, 128, 255] : [0, 0, 0, 255])), 2);
    expect(tie[4]).toBe(0);
    // Parents without any label in their 3×3.
    const holes = segOf(mapOf(['...0']));
    expect(Array.from(refineLabels(holes, [solid(RED)], raster(8, 1, () => [255, 0, 0, 255]), 2))).toEqual([
      NO_REGION, NO_REGION, NO_REGION, NO_REGION, 0, 0, 0, 0,
    ]);
  });

  it('evaluates the fills at ((X + 0.5)/U, (Y + 0.5)/U) in segmentation units', () => {
    // Region 0: black -> white over [0, 2]; region 1: flat 100. At U = 2, X = 1 the centre is 0.75: t 0.375, 95.6.
    const seg = segOf(mapOf(['01']));
    const ramp: Fill = { kind: 'linear', x1: 0, y1: 0.5, x2: 2, y2: 0.5, stops: [{ offset: 0, color: [0, 0, 0] }, { offset: 1, color: [255, 255, 255] }] };
    const up = raster(4, 2, () => [96, 96, 96, 255]);
    const labels = refineLabels(seg, [ramp, solid([100, 100, 100])], up, 2);
    expect(labels[1]).toBe(0); // evaluated at 1.5 (t 0.75, 191) it would pick region 1
  });

  it('gradientFeathers at U = 2 and 4 with the true fills agrees with the upsampled ground truth on >= 98 % outside the AA band', () => {
    const f = gradientFeathers(256, 1);
    const merged = emulateMerges(f.image, segmentRegions(f.image, { regionDetail: 1 }));
    const gtOf = matchRegions(merged.regions, f.labels).map((m) => m.gt);
    const truth: Fill[] = [solid(f.background), ...f.shapes.map((s) => s.fill)];
    const fills = gtOf.map((g) => truth[g]);
    const band = aaBand(f.labels);
    for (const U of [2, 4]) {
      const up = gaussianBlurRaster(upscaleRaster(f.image, U), 0.35 * U);
      const labels = refineLabels(merged, fills, up, U);
      expect(labels.length).toBe(256 * U * 256 * U);
      let total = 0;
      let agree = 0;
      for (let Y = 0; Y < 256 * U; Y++) {
        for (let X = 0; X < 256 * U; X++) {
          const parent = Math.floor(Y / U) * 256 + Math.floor(X / U);
          if (band[parent] !== 0) continue;
          total++;
          const k = labels[Y * 256 * U + X];
          if (k !== NO_REGION && gtOf[k] === f.labels.data[parent]) agree++;
        }
      }
      expect(agree / total, `U ${U}`).toBeGreaterThanOrEqual(0.98);
    }
  });

  it('throws when the ids do not fit Uint16 or fills are missing', () => {
    const big: Segmentation = { ...segOf(mapOf(['0'])), regions: { data: Int32Array.from([0]), width: 1, height: 1, count: 65536 } };
    const fills = new Array<Fill>(65536).fill(solid(RED));
    expect(() => refineLabels(big, fills, raster(1, 1, () => [255, 0, 0, 255]), 1)).toThrow(RangeError);
    expect(() => refineLabels(segOf(mapOf(['01'])), [solid(RED)], raster(2, 1, () => [255, 0, 0, 255]), 1)).toThrow(RangeError);
  });
});

describe('rankMap', () => {
  it('relabels in place by position in order and keeps NO_REGION', () => {
    const labels = Uint16Array.from([2, 0, NO_REGION, 1]);
    const out = rankMap(labels, [1, 2, 0]);
    expect(out).toBe(labels);
    expect(Array.from(labels)).toEqual([1, 2, NO_REGION, 0]);
  });

  it('throws on an invalid order or a label missing from it', () => {
    expect(() => rankMap(Uint16Array.from([0]), [0, 0])).toThrow(RangeError);
    expect(() => rankMap(Uint16Array.from([3]), [0, 1])).toThrow(RangeError);
  });
});

describe('regionMask', () => {
  function randomRanks(seed: number, w: number, h: number, layers: number): Uint16Array {
    const rnd = prng(seed);
    const ranks = new Uint16Array(w * h);
    // Blocks of 3..7 px so the dilation has shapes to grow; some holes; rank 2 on the borders.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bx = Math.floor(x / 5);
        const by = Math.floor(y / 4);
        const v = ((bx * 7919 + by * 104729 + seed) % 97) / 97;
        ranks[y * w + x] = v < 0.12 ? NO_REGION : Math.floor(v * layers) % layers;
      }
    }
    for (let x = 0; x < w; x++) ranks[x] = 2;
    for (let y = 0; y < h; y++) ranks[y * w + w - 1] = rnd() < 0.5 ? 2 : NO_REGION;
    return ranks;
  }

  it('cutout = rank j dilated `dilate` times with dilate1, on ranks >= j and rank != NO_REGION', () => {
    const w = 37;
    const h = 29;
    for (const seed of [1, 2]) {
      const ranks = randomRanks(seed, w, h, 6);
      for (const j of [0, 2, 5, 9]) {
        let expected: BinaryMask = { data: Uint8Array.from(ranks, (r) => (r === j ? 1 : 0)), width: w, height: h };
        for (let k = 0; k <= 3; k++) {
          const got = regionMask(ranks, w, h, j, 'cutout', k);
          const want = Uint8Array.from(expected.data, (v, i) => (v !== 0 && ranks[i] >= j && ranks[i] !== NO_REGION ? 1 : 0));
          expect(Array.from(got.data), `seed ${seed} j ${j} dilate ${k}`).toEqual(Array.from(want));
          expected = dilate1(expected);
        }
      }
      expect(Array.from(regionMask(ranks, w, h, NO_REGION, 'cutout', 2).data).every((v) => v === 0)).toBe(true);
    }
  });

  it('cutout never paints over an earlier layer: the dilation only reaches ranks >= j (painted later)', () => {
    const w = 37;
    const h = 29;
    for (const seed of [1, 2]) {
      const ranks = randomRanks(seed, w, h, 6);
      for (const j of [0, 2, 5]) {
        for (let k = 0; k <= 3; k++) {
          const got = regionMask(ranks, w, h, j, 'cutout', k);
          let over = 0;
          for (let i = 0; i < w * h; i++) if (got.data[i] !== 0 && ranks[i] < j) over++;
          expect(over, `seed ${seed} j ${j} dilate ${k}`).toBe(0);
        }
      }
    }
  });

  it('stacked = rank >= j without NO_REGION, and the masks are nested', () => {
    const w = 37;
    const h = 29;
    const ranks = randomRanks(3, w, h, 6);
    let previous = regionMask(ranks, w, h, 0, 'stacked', 0);
    for (let i = 0; i < w * h; i++) expect(previous.data[i]).toBe(ranks[i] !== NO_REGION ? 1 : 0);
    for (let j = 1; j < 6; j++) {
      const mask = regionMask(ranks, w, h, j, 'stacked', 3);
      for (let i = 0; i < w * h; i++) expect(mask.data[i]).toBe(ranks[i] >= j && ranks[i] !== NO_REGION ? 1 : 0);
      assertMaskNested(previous, mask);
      previous = mask;
    }
  });

  it('on refined gradientFeathers labels at U = 2: stacked masks nested, cutout masks cover every labelled pixel', () => {
    const f = gradientFeathers(128, 1);
    const seg = segmentRegions(f.image, { regionDetail: 1 });
    const U = 2;
    const up = gaussianBlurRaster(upscaleRaster(f.image, U), 0.35 * U);
    const fills: Fill[] = [];
    for (let k = 0; k < seg.regions.count; k++) fills.push({ kind: 'solid', color: [128, 128, 128] });
    const ranks = rankMap(refineLabels(seg, fills, up, U), regionOrder(seg));
    const W = 128 * U;
    const union = new Uint8Array(W * W);
    let previous: BinaryMask | null = null;
    for (let j = 0; j < seg.regions.count; j++) {
      const stacked = regionMask(ranks, W, W, j, 'stacked', 0);
      if (previous !== null) assertMaskNested(previous, stacked);
      previous = stacked;
      const cut = regionMask(ranks, W, W, j, 'cutout', Math.ceil(U / 2));
      for (let i = 0; i < union.length; i++) union[i] |= cut.data[i];
    }
    for (let i = 0; i < union.length; i++) expect(union[i]).toBe(ranks[i] !== NO_REGION ? 1 : 0);
  });
});
