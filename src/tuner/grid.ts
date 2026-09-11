/**
 * Candidate grids of the auto-tuner. Pure and deterministic: the same inputs always give the same
 * candidates in the same order.
 *
 * stage A (proxy <= 256 px): U {2, 4} x blurK {0, 0.5, 0.9} x alphamax {0.6, 1.0, 1.334} x
 *   turdsize {1, 4} = 36, nested in that order so consecutive candidates share the preprocessing
 *   (upscale + blur) and the tuner can reuse it.
 * stage B (full resolution, per seed): alphamax ±0.15 in steps of 0.05 (clamped to [0, 1.334]) x
 *   opttolerance {0.1, 0.2, 0.4} = 21. Clamped duplicates are kept, so every seed has exactly 21
 *   entries and the progress total is known up front; the tuner scores a duplicate only once.
 */
import type { Engine, TraceParams } from '../types';
import { chooseUpscale } from '../core/upscale';

export type Upscale = 1 | 2 | 3 | 4;

export const PROXY_MAX_SIDE = 256;
export const STAGE_A_UPSCALE: readonly Upscale[] = [2, 4];
export const STAGE_A_BLUR_K: readonly number[] = [0, 0.5, 0.9];
export const STAGE_A_ALPHAMAX: readonly number[] = [0.6, 1.0, 1.334];
export const STAGE_A_TURDSIZE: readonly number[] = [1, 4];
export const STAGE_B_SEEDS = 3;
export const STAGE_B_ALPHAMAX_SPAN = 0.15;
export const STAGE_B_ALPHAMAX_STEP = 0.05;
export const STAGE_B_OPTTOLERANCE: readonly number[] = [0.1, 0.2, 0.4];
export const ALPHAMAX_MAX = 1.334;

const HALF_STEPS = Math.round(STAGE_B_ALPHAMAX_SPAN / STAGE_B_ALPHAMAX_STEP);

/** Candidates generated per stage-B seed (7 alphamax values x 3 opttolerances). */
export const STAGE_B_PER_SEED = (2 * HALF_STEPS + 1) * STAGE_B_OPTTOLERANCE.length;

export interface Candidate {
  upscale: Upscale;
  blurK: number;
  alphamax: number;
  /** ORIGINAL px² (the tuner rescales it for the proxy). */
  turdsize: number;
  opttolerance: number;
}

/** The 36 stage-A candidates; `opttolerance` is the one of the params being tuned. */
export function stageAGrid(opttolerance: number): Candidate[] {
  const out: Candidate[] = [];
  for (const upscale of STAGE_A_UPSCALE) {
    for (const blurK of STAGE_A_BLUR_K) {
      for (const alphamax of STAGE_A_ALPHAMAX) {
        for (const turdsize of STAGE_A_TURDSIZE) out.push({ upscale, blurK, alphamax, turdsize, opttolerance });
      }
    }
  }
  return out;
}

/** center - 0.15 .. center + 0.15 in steps of 0.05, rounded to 1e-3 and clamped to [0, 1.334]. */
export function stageBAlphamax(center: number): number[] {
  const out: number[] = [];
  for (let k = -HALF_STEPS; k <= HALF_STEPS; k++) {
    const v = Math.round((center + k * STAGE_B_ALPHAMAX_STEP) * 1000) / 1000;
    out.push(v < 0 ? 0 : v > ALPHAMAX_MAX ? ALPHAMAX_MAX : v);
  }
  return out;
}

/** The 21 stage-B candidates around `seed` (its upscale, blurK and turdsize are kept). */
export function stageBGrid(seed: Candidate): Candidate[] {
  const out: Candidate[] = [];
  for (const alphamax of stageBAlphamax(seed.alphamax)) {
    for (const opttolerance of STAGE_B_OPTTOLERANCE) out.push({ ...seed, alphamax, opttolerance });
  }
  return out;
}

/** Integer box-downscale factor that brings the longest side to <= maxSide (1 when it already fits). */
export function proxyFactor(width: number, height: number, maxSide = PROXY_MAX_SIDE): number {
  const m = Math.max(width, height);
  return m <= maxSide ? 1 : Math.ceil(m / maxSide);
}

/**
 * TraceParams of a candidate traced on an image of `size`: `base` with the candidate's knobs and
 * `engine`. The upscale is the one that image can actually take (chooseUpscale): a request above the
 * 16 Mpx cap becomes the capped value, so it neither adds 'upscale-capped' nor differs from asking
 * for that smaller U directly.
 */
export function candidateParams(
  base: TraceParams,
  c: Candidate,
  engine: Engine,
  size: { width: number; height: number },
): TraceParams {
  return {
    ...base,
    engine,
    upscale: chooseUpscale(size.width, size.height, c.upscale).U as Upscale,
    blurK: c.blurK,
    alphamax: c.alphamax,
    turdsize: c.turdsize,
    opttolerance: c.opttolerance,
  };
}

export interface Ranked {
  candidate: Candidate;
  /** Identity of the traced output: candidates with equal keys produce the same SVG. */
  key: string;
  score: number;
  /**
   * Passes the tuner's fidelity guard on the scale it was scored on (default true). Candidates that
   * do not rank after every candidate that does.
   */
  eligible?: boolean;
}

/**
 * Best `n` candidates: eligible ones first, then by score (descending; ties and NaN keep grid
 * order). Candidates whose output is identical to a better one (same key) are skipped while
 * distinct ones remain, so the seeds explore different traces.
 */
export function pickSeeds(results: readonly Ranked[], n = STAGE_B_SEEDS): Candidate[] {
  const finite = (v: number): number => (Number.isFinite(v) ? v : -Infinity);
  const tier = (r: Ranked): number => (r.eligible === false ? 1 : 0);
  const order = results.map((r, i) => ({ r, i }));
  order.sort((a, b) => tier(a.r) - tier(b.r) || finite(b.r.score) - finite(a.r.score) || a.i - b.i);
  const seeds: Candidate[] = [];
  const repeats: Candidate[] = [];
  const seen = new Set<string>();
  for (const { r } of order) {
    if (seen.has(r.key)) {
      repeats.push(r.candidate);
    } else {
      seen.add(r.key);
      if (seeds.length < n) seeds.push(r.candidate);
    }
  }
  for (let i = 0; seeds.length < n && i < repeats.length; i++) seeds.push(repeats[i]);
  return seeds;
}

/** Stable reorder that makes candidates with the same (upscale, blurK) adjacent (first-seen order). */
export function groupByPreprocessing(candidates: readonly Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = `${c.upscale}|${c.blurK}`;
    const g = groups.get(k);
    if (g === undefined) groups.set(k, [c]);
    else g.push(c);
  }
  return [...groups.values()].flat();
}
