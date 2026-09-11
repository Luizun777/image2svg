/**
 * potrace adapter (esm-potrace-wasm 0.5.1). Traces a binary mask into absolute paths in mask
 * pixel units, y down. Usable from Node tests (with tests/setup.ts shims) and from a module
 * Web Worker. This is the one place in src/tracers allowed to construct `ImageData`, because
 * the library requires an ImageData-like input.
 *
 * Output format (observed): every contour lands in one or more `<path>` elements inside a
 * `<g transform="translate(0,H) scale(0.1,-0.1)" fill="#000000">`, i.e. coordinates in 1/10
 * px with the y-flip baked into the group transform. We parse and apply that transform.
 */
import { init as potraceInit, potrace as potraceRun } from 'esm-potrace-wasm';
import type { AbsPath, BinaryMask, Tracer, TracerOptions } from '../types';
import { applyTransform, parsePathData, parseTransform } from '../svg/pathParse';
import { extractPaths } from './svgParse';
import { TURNPOLICY_CODE, assertMaskShape, maskHasInk, maskToRaster } from './types';

const PREFIX = 'potrace: ';

function wrapError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg.startsWith(PREFIX) ? msg : PREFIX + msg);
}

/** Module-level cache: the wasm runtime is a singleton, so every tracer instance shares it. */
let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (initPromise === null) {
    let p: Promise<void>;
    try {
      p = Promise.resolve(potraceInit());
    } catch (e) {
      // Synchronous throw (e.g. the loader failing at call time): keep the module retryable.
      return Promise.reject(wrapError(e));
    }
    initPromise = p.catch((e: unknown) => {
      initPromise = null; // allow a later retry instead of caching the failure forever
      throw wrapError(e);
    });
  }
  return initPromise;
}

function finiteOrThrow(name: string, v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${PREFIX}opción "${name}" inválida (${String(v)})`);
  }
  return v;
}

async function traceBinary(mask: BinaryMask, opts: TracerOptions): Promise<AbsPath[]> {
  assertMaskShape(mask, 'potrace');
  if (mask.width === 0 || mask.height === 0 || !maskHasInk(mask)) return [];

  const turnpolicy = TURNPOLICY_CODE[opts.turnpolicy];
  if (turnpolicy === undefined) {
    throw new Error(`${PREFIX}turnpolicy desconocida "${String(opts.turnpolicy)}"`);
  }
  const alphamax = finiteOrThrow('alphamax', opts.alphamax);
  const opttolerance = finiteOrThrow('opttolerance', opts.opttolerance);
  const turdsize = Math.max(0, Math.round(finiteOrThrow('turdsize', opts.turdsize)));

  await ensureInit();

  const rgba = maskToRaster(mask);
  let svg: string;
  try {
    // RasterImage.data is a fresh Uint8ClampedArray over its own ArrayBuffer (maskToRaster).
    const img = new ImageData(
      rgba.data as Uint8ClampedArray<ArrayBuffer>,
      rgba.width,
      rgba.height,
    );
    svg = await potraceRun(img, {
      turdsize,
      turnpolicy,
      alphamax,
      opticurve: opts.opticurve ? 1 : 0,
      opttolerance,
      pathonly: false,
      extractcolors: false,
      posterizelevel: 2,
      posterizationalgorithm: 0,
    });
  } catch (e) {
    throw wrapError(e);
  }
  if (typeof svg !== 'string') {
    throw new Error(`${PREFIX}salida inesperada del módulo wasm (${typeof svg})`);
  }

  const found = extractPaths(svg);
  const paths: AbsPath[] = new Array<AbsPath>(found.length);
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    let parsed: AbsPath;
    try {
      parsed = parsePathData(f.d);
    } catch (e) {
      throw wrapError(e);
    }
    paths[i] = f.transform === null ? parsed : applyTransform(parsed, parseTransform(f.transform));
  }
  return paths;
}

export function createPotraceTracer(): Tracer {
  return {
    name: 'potrace',
    init: () => ensureInit(),
    traceBinary,
  };
}
