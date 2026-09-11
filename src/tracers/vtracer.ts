/**
 * vtracer adapter (vtracer-web 0.1.0, wasm-bindgen). Traces a binary mask into absolute paths
 * in mask pixel units (y down), and exposes vtracer's native colour mode as a raw SVG string.
 *
 * The wasm binary is NOT imported here: `init(source)` receives it from the caller (the
 * worker passes `vtracer-web/vtracer.wasm?url`, Node tests pass the file bytes). The package
 * default (`vtracer_bg.wasm` next to vtracer.js) does not exist, so a source is required.
 *
 * Output format (observed): `<svg … width="W" height="H">\n<path d="M0 0 C… Z " fill="#rrggbb"
 * transform="translate(x,y)"/>…</svg>` — one path per cluster, coordinates relative to the
 * cluster's top-left, hence the translate. vtracer emits C even for straight runs (collinear
 * control points).
 */
import vtracerInit, { to_svg } from 'vtracer-web';
import type {
  AbsPath,
  BinaryMask,
  Layering,
  RasterImage,
  Tracer,
  TracerOptions,
  VtracerParams,
} from '../types';
import { applyTransform, parsePathData, parseTransform } from '../svg/pathParse';
import { extractPaths } from './svgParse';
import { assertMaskShape, maskHasInk, maskToRaster } from './types';

const PREFIX = 'vtracer: ';
const DEG2RAD = Math.PI / 180;

function wrapError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg.startsWith(PREFIX) ? msg : PREFIX + msg);
}

/** Module-level cache: wasm-bindgen keeps a single instance, so all tracers share it. */
let initPromise: Promise<void> | null = null;
let ready = false;

type VtracerInitInput = Parameters<typeof vtracerInit>[0];

function ensureInit(source?: unknown): Promise<void> {
  if (initPromise === null) {
    let p: Promise<unknown>;
    try {
      // wasm interop: the caller passes a URL / string / Response / BufferSource / Module.
      p =
        source === undefined
          ? vtracerInit()
          : vtracerInit({ module_or_path: source as VtracerInitInput } as VtracerInitInput);
    } catch (e) {
      return Promise.reject(wrapError(e));
    }
    initPromise = p.then(
      () => {
        ready = true;
      },
      (e: unknown) => {
        initPromise = null; // retryable (e.g. a wrong URL the first time)
        throw wrapError(e);
      },
    );
  }
  return initPromise;
}

/** vtracer-web's `to_svg` config. Every key is mandatory (missing keys make the wasm throw). */
interface VtracerConfig {
  binary: boolean;
  mode: 'none' | 'polygon' | 'spline';
  hierarchical: Layering;
  cornerThreshold: number; // radians
  lengthThreshold: number;
  maxIterations: number;
  spliceThreshold: number; // radians
  filterSpeckle: number;
  colorPrecision: number;
  layerDifference: number;
  pathPrecision: number;
}

function numberOrThrow(name: string, v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${PREFIX}opción vtracer "${name}" inválida (${String(v)})`);
  }
  return v;
}

function buildConfig(p: VtracerParams, binary: boolean, hierarchical: Layering): VtracerConfig {
  return {
    binary,
    mode: 'spline',
    hierarchical,
    cornerThreshold: numberOrThrow('cornerThresholdDeg', p.cornerThresholdDeg) * DEG2RAD,
    lengthThreshold: numberOrThrow('lengthThreshold', p.lengthThreshold),
    maxIterations: numberOrThrow('maxIterations', p.maxIterations),
    spliceThreshold: numberOrThrow('spliceThresholdDeg', p.spliceThresholdDeg) * DEG2RAD,
    filterSpeckle: numberOrThrow('filterSpeckle', p.filterSpeckle),
    colorPrecision: numberOrThrow('colorPrecision', p.colorPrecision),
    layerDifference: numberOrThrow('layerDifference', p.layerDifference),
    pathPrecision: numberOrThrow('pathPrecision', p.pathPrecision),
  };
}

/** Byte view over the RGBA buffer without copying (respects the view's offset/length). */
function rgbaBytes(img: RasterImage): Uint8Array {
  return new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
}

function assertRasterShape(img: RasterImage): void {
  const { width, height, data } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new Error(`${PREFIX}dimensiones de imagen inválidas (${String(width)}x${String(height)})`);
  }
  if (data.length !== width * height * 4) {
    throw new Error(
      `${PREFIX}data.length (${data.length}) no coincide con width*height*4 (${width * height * 4})`,
    );
  }
}

function runToSvg(img: RasterImage, config: VtracerConfig): string {
  if (!ready) {
    throw new Error(`${PREFIX}módulo wasm no inicializado; llama a init(source) primero`);
  }
  let svg: string;
  try {
    svg = to_svg(rgbaBytes(img), img.width, img.height, config);
  } catch (e) {
    throw wrapError(e);
  }
  if (typeof svg !== 'string') {
    throw new Error(`${PREFIX}salida inesperada del módulo wasm (${typeof svg})`);
  }
  return svg;
}

async function traceBinary(mask: BinaryMask, opts: TracerOptions): Promise<AbsPath[]> {
  assertMaskShape(mask, 'vtracer');
  if (mask.width === 0 || mask.height === 0 || !maskHasInk(mask)) return [];
  const config = buildConfig(opts.vtracer, true, 'stacked');
  if (initPromise !== null) await initPromise;
  const svg = runToSvg(maskToRaster(mask), config);

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

export function createVtracerTracer(): Tracer {
  return {
    name: 'vtracer',
    init: (source?: unknown) => ensureInit(source),
    traceBinary,
  };
}

const SVG_ROOT_RE = /<svg\b([^>]*)>/;
const VIEWBOX_RE = /\sviewBox\s*=\s*(?:"[^"]*"|'[^']*')/;

/**
 * vtracer's native colour mode (binary:false). Returns the raw SVG string with a
 * `viewBox="0 0 w h"` attribute inserted into (or replacing the one in) the root `<svg>` tag.
 * Synchronous: requires `init(source)` to have completed.
 */
export function vtracerColorSvg(img: RasterImage, params: VtracerParams, hierarchical: Layering): string {
  assertRasterShape(img);
  const config = buildConfig(params, false, hierarchical);
  const svg = runToSvg(img, config);
  const m = SVG_ROOT_RE.exec(svg);
  if (m === null) {
    throw new Error(`${PREFIX}la salida no contiene un elemento <svg> raíz`);
  }
  const viewBox = ` viewBox="0 0 ${img.width} ${img.height}"`;
  let attrs = m[1];
  const selfClosing = attrs.length > 0 && attrs.charCodeAt(attrs.length - 1) === 47; // '/'
  if (selfClosing) attrs = attrs.slice(0, -1);
  attrs = VIEWBOX_RE.test(attrs) ? attrs.replace(VIEWBOX_RE, viewBox) : attrs + viewBox;
  const root = `<svg${attrs}${selfClosing ? '/' : ''}>`;
  return svg.slice(0, m.index) + root + svg.slice(m.index + m[0].length);
}
