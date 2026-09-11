/**
 * Defaults and parameter resolution. Pure.
 */
import type {
  ConcreteMode,
  ResolvedParams,
  TraceParams,
  TurnPolicy,
  VtracerParams,
} from '../types';
import { chooseUpscale } from './upscale';

export const VTRACER_DEFAULTS: VtracerParams = {
  cornerThresholdDeg: 60,
  lengthThreshold: 4,
  maxIterations: 10,
  spliceThresholdDeg: 45,
  filterSpeckle: 4,
  colorPrecision: 6,
  layerDifference: 16,
  pathPrecision: 3,
};

export type ModeDefaults = Required<Omit<TraceParams, 'vtracer' | 'mode'>> & {
  vtracer: VtracerParams;
};

function baseDefaults(): ModeDefaults {
  return {
    engine: 'potrace',
    upscale: 'auto',
    blurK: 0.35,
    thresholdOffset: 0,
    invert: false,
    alphamax: 1.0,
    opttolerance: 0.2,
    turdsize: 2,
    turnpolicy: 'minority',
    opticurve: true,
    colors: 'auto',
    exactPalette: true,
    layering: 'stacked',
    background: 'auto',
    alphaMode: 'auto',
    fill: 'auto',
    gridScale: 'auto',
    optimize: false,
    bakedBackground: 'auto',
    vtracer: { ...VTRACER_DEFAULTS },
  };
}

export const DEFAULTS: Record<ConcreteMode, ModeDefaults> = {
  lines: baseDefaults(),
  flat: baseDefaults(),
  pixel: { ...baseDefaults(), upscale: 1, blurK: 0 },
};

const TURN_POLICIES: ReadonlySet<string> = new Set<TurnPolicy>([
  'black',
  'white',
  'left',
  'right',
  'minority',
  'majority',
]);

function clampNum(v: number | undefined, def: number, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return v < lo ? lo : v > hi ? hi : v;
}

function pick<T>(v: T | undefined, def: T): T {
  return v === undefined ? def : v;
}

/**
 * mode 'auto' without modeIfAuto -> 'lines'. Clamps: alphamax [0,1.334], opttolerance [0.01,1],
 * turdsize [0,100], blurK [0,1], thresholdOffset [-0.25,0.25], colors [2,32] (integer).
 * pixel: upscale 1, sigmaPx 0. Non-finite numbers fall back to the mode default.
 */
export function resolveParams(
  params: TraceParams,
  source: { width: number; height: number },
  modeIfAuto?: ConcreteMode,
): ResolvedParams {
  const requestedMode = params.mode ?? 'auto';
  const mode: ConcreteMode = requestedMode === 'auto' ? (modeIfAuto ?? 'lines') : requestedMode;
  const d = DEFAULTS[mode];

  const blurK = clampNum(params.blurK, d.blurK, 0, 1);
  const alphamax = clampNum(params.alphamax, d.alphamax, 0, 1.334);
  const opttolerance = clampNum(params.opttolerance, d.opttolerance, 0.01, 1);
  const turdsize = clampNum(params.turdsize, d.turdsize, 0, 100);
  const thresholdOffset = clampNum(params.thresholdOffset, d.thresholdOffset, -0.25, 0.25);

  let colors: number | 'auto';
  const c = pick(params.colors, d.colors);
  if (c === 'auto') colors = 'auto';
  else colors = Math.round(clampNum(c, typeof d.colors === 'number' ? d.colors : 8, 2, 32));

  let gridScale: 'auto' | number;
  const g = pick(params.gridScale, d.gridScale);
  if (g === 'auto') gridScale = 'auto';
  else gridScale = Math.max(1, Math.floor(clampNum(g, 1, 1, 64)));

  const turnpolicyRaw = pick(params.turnpolicy, d.turnpolicy);
  const turnpolicy: TurnPolicy = TURN_POLICIES.has(turnpolicyRaw) ? turnpolicyRaw : d.turnpolicy;

  const engine = params.engine === 'vtracer' || params.engine === 'potrace' ? params.engine : d.engine;

  let upscale: number;
  let upscaleCapped: boolean;
  let sigmaPx: number;
  if (mode === 'pixel') {
    upscale = 1;
    upscaleCapped = false;
    sigmaPx = 0;
  } else {
    const chosen = chooseUpscale(source.width, source.height, pick(params.upscale, d.upscale));
    upscale = chosen.U;
    upscaleCapped = chosen.capped;
    sigmaPx = blurK * upscale;
  }

  const vt = resolveVtracer(params.vtracer);

  return {
    mode,
    engine,
    upscale,
    upscaleCapped,
    sigmaPx,
    thresholdOffset,
    invert: pick(params.invert, d.invert) === true,
    alphamax,
    opttolerance,
    turdsize,
    turdsizeScaled: turdsize * upscale * upscale,
    turnpolicy,
    opticurve: pick(params.opticurve, d.opticurve) === true,
    colors,
    exactPalette: pick(params.exactPalette, d.exactPalette) === true,
    layering: pick(params.layering, d.layering) === 'cutout' ? 'cutout' : 'stacked',
    background: pick(params.background, d.background),
    alphaMode: pick(params.alphaMode, d.alphaMode),
    fill: pick(params.fill, d.fill),
    gridScale,
    vtracer: vt,
    optimize: pick(params.optimize, d.optimize) === true,
    bakedBackground: pick(params.bakedBackground, d.bakedBackground) === 'keep' ? 'keep' : 'auto',
  };
}

/** Merge a partial vtracer config over the defaults, ignoring undefined / non-finite entries. */
function resolveVtracer(partial: Partial<VtracerParams> | undefined): VtracerParams {
  const v: VtracerParams = { ...VTRACER_DEFAULTS };
  if (!partial) return v;
  v.cornerThresholdDeg = clampNum(partial.cornerThresholdDeg, v.cornerThresholdDeg, 0, 180);
  v.lengthThreshold = clampNum(partial.lengthThreshold, v.lengthThreshold, 3.5, 10);
  v.maxIterations = Math.round(clampNum(partial.maxIterations, v.maxIterations, 1, 1000));
  v.spliceThresholdDeg = clampNum(partial.spliceThresholdDeg, v.spliceThresholdDeg, 0, 180);
  v.filterSpeckle = Math.round(clampNum(partial.filterSpeckle, v.filterSpeckle, 0, 1e6));
  v.colorPrecision = Math.round(clampNum(partial.colorPrecision, v.colorPrecision, 1, 8));
  v.layerDifference = Math.round(clampNum(partial.layerDifference, v.layerDifference, 0, 255));
  v.pathPrecision = Math.round(clampNum(partial.pathPrecision, v.pathPrecision, 0, 8));
  return v;
}
