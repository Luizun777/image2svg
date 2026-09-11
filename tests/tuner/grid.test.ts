import { describe, expect, it } from 'vitest';
import {
  ALPHAMAX_MAX,
  STAGE_B_PER_SEED,
  candidateParams,
  groupByPreprocessing,
  pickSeeds,
  proxyFactor,
  stageAGrid,
  stageBAlphamax,
  stageBGrid,
  type Candidate,
  type Ranked,
} from '../../src/tuner/grid';

describe('stage A grid', () => {
  it('has the 36 distinct combinations U{2,4} x blurK{0,0.5,0.9} x alphamax{0.6,1,1.334} x turdsize{1,4}', () => {
    const grid = stageAGrid(0.2);
    expect(grid).toHaveLength(36);
    const keys = new Set(grid.map((c) => `${c.upscale}|${c.blurK}|${c.alphamax}|${c.turdsize}`));
    expect(keys.size).toBe(36);
    expect([...new Set(grid.map((c) => c.upscale))]).toEqual([2, 4]);
    expect([...new Set(grid.map((c) => c.blurK))]).toEqual([0, 0.5, 0.9]);
    expect([...new Set(grid.map((c) => c.alphamax))]).toEqual([0.6, 1.0, 1.334]);
    expect([...new Set(grid.map((c) => c.turdsize))]).toEqual([1, 4]);
    expect(grid.every((c) => c.opttolerance === 0.2)).toBe(true);
  });

  it('keeps candidates that share (U, blurK) adjacent: 6 preprocessing groups of 6', () => {
    const grid = stageAGrid(0.2);
    const runs: string[] = [];
    for (const c of grid) {
      const k = `${c.upscale}|${c.blurK}`;
      if (runs[runs.length - 1] !== k) runs.push(k);
    }
    expect(runs).toHaveLength(6);
    expect(new Set(runs).size).toBe(6);
  });

  it('is deterministic', () => {
    expect(stageAGrid(0.3)).toEqual(stageAGrid(0.3));
  });
});

describe('stage B grid', () => {
  it('alphamax ±0.15 in steps of 0.05 around the seed', () => {
    expect(stageBAlphamax(1.0)).toEqual([0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15]);
    expect(stageBAlphamax(0.6)).toEqual([0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75]);
  });

  it('clamps to [0, 1.334] and keeps the duplicates (7 entries per seed)', () => {
    expect(stageBAlphamax(1.334)).toEqual([1.184, 1.234, 1.284, 1.334, 1.334, 1.334, 1.334]);
    expect(stageBAlphamax(0.05)).toEqual([0, 0, 0, 0.05, 0.1, 0.15, 0.2]);
    expect(Math.max(...stageBAlphamax(1.3))).toBe(ALPHAMAX_MAX);
  });

  it('21 candidates per seed: 7 alphamax x opttolerance {0.1, 0.2, 0.4}, preprocessing kept', () => {
    const seed: Candidate = { upscale: 4, blurK: 0.5, alphamax: 1, turdsize: 4, opttolerance: 0.2 };
    const grid = stageBGrid(seed);
    expect(STAGE_B_PER_SEED).toBe(21);
    expect(grid).toHaveLength(21);
    expect(new Set(grid.map((c) => `${c.alphamax}|${c.opttolerance}`)).size).toBe(21);
    expect([...new Set(grid.map((c) => c.opttolerance))]).toEqual([0.1, 0.2, 0.4]);
    expect(grid.every((c) => c.upscale === 4 && c.blurK === 0.5 && c.turdsize === 4)).toBe(true);
  });
});

describe('proxyFactor', () => {
  it('1 when the longest side fits in 256 px, else the smallest integer factor that fits', () => {
    expect(proxyFactor(64, 64)).toBe(1);
    expect(proxyFactor(256, 100)).toBe(1);
    expect(proxyFactor(257, 10)).toBe(2);
    expect(proxyFactor(1561, 1672)).toBe(7); // ceil(1672 / 256)
    expect(proxyFactor(3840, 2160)).toBe(15);
    for (const [w, h] of [
      [257, 10],
      [1561, 1672],
      [3840, 2160],
      [1000, 999],
    ]) {
      const f = proxyFactor(w, h);
      expect(Math.ceil(Math.max(w, h) / f)).toBeLessThanOrEqual(256);
      expect(Math.ceil(Math.max(w, h) / (f - 1))).toBeGreaterThan(256);
    }
  });
});

describe('candidateParams', () => {
  const c: Candidate = { upscale: 4, blurK: 0.9, alphamax: 0.6, turdsize: 4, opttolerance: 0.4 };

  it('overrides only the tuned knobs and the engine', () => {
    const base = { mode: 'lines' as const, invert: true, thresholdOffset: 0.1, alphamax: 1, engine: 'vtracer' as const };
    expect(candidateParams(base, c, 'potrace', { width: 64, height: 64 })).toEqual({
      mode: 'lines',
      invert: true,
      thresholdOffset: 0.1,
      engine: 'potrace',
      upscale: 4,
      blurK: 0.9,
      alphamax: 0.6,
      turdsize: 4,
      opttolerance: 0.4,
    });
  });

  it('uses the upscale the image can take under the 16 Mpx cap', () => {
    expect(candidateParams({}, c, 'potrace', { width: 1561, height: 1672 }).upscale).toBe(2);
    expect(candidateParams({}, c, 'potrace', { width: 3840, height: 2160 }).upscale).toBe(1);
  });
});

describe('pickSeeds / groupByPreprocessing', () => {
  const cand = (upscale: 2 | 4, blurK: number, alphamax: number): Candidate => ({
    upscale,
    blurK,
    alphamax,
    turdsize: 1,
    opttolerance: 0.2,
  });

  it('best three by score, ties and NaN in grid order, identical outputs skipped while others remain', () => {
    const a = cand(2, 0, 0.6);
    const b = cand(2, 0, 1);
    const c = cand(4, 0.5, 1);
    const d = cand(4, 0.9, 1.334);
    const e = cand(2, 0.5, 0.6);
    const results: Ranked[] = [
      { candidate: a, key: 'ka', score: 0.9 },
      { candidate: b, key: 'ka', score: 0.95 }, // same output as a, better
      { candidate: c, key: 'kc', score: 0.95 },
      { candidate: d, key: 'kd', score: Number.NaN },
      { candidate: e, key: 'ke', score: 0.8 },
    ];
    expect(pickSeeds(results)).toEqual([b, c, e]);
  });

  it('eligible candidates (within the fidelity guard) rank before every ineligible one, whatever the score', () => {
    const a = cand(2, 0, 0.6);
    const b = cand(2, 0, 1);
    const c = cand(4, 0.5, 1);
    const d = cand(4, 0.9, 1.334);
    const results: Ranked[] = [
      { candidate: a, key: 'ka', score: 0.99, eligible: false },
      { candidate: b, key: 'kb', score: 0.8 }, // absent = eligible
      { candidate: c, key: 'kc', score: 0.95, eligible: false },
      { candidate: d, key: 'kd', score: 0.85, eligible: true },
    ];
    expect(pickSeeds(results)).toEqual([d, b, a]);
  });

  it('fills with repeats when there are fewer distinct outputs than seeds', () => {
    const a = cand(2, 0, 0.6);
    const b = cand(2, 0, 1);
    expect(
      pickSeeds([
        { candidate: a, key: 'k', score: 0.5 },
        { candidate: b, key: 'k', score: 0.4 },
      ]),
    ).toEqual([a, b]);
  });

  it('groups by (upscale, blurK) keeping first-seen order', () => {
    const a = cand(2, 0, 0.6);
    const b = cand(4, 0.5, 1);
    const c = cand(2, 0, 1.334);
    expect(groupByPreprocessing([a, b, c])).toEqual([a, c, b]);
  });
});
