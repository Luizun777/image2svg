/**
 * Test helpers to read a pipeline SVG back into layers / rasters (pure, no vitest dependency).
 */
import type { AbsPath, BinaryMask, GrayImage, Layer, RGB, RasterImage } from '../../src/types';
import { extractPaths } from '../../src/tracers/svgParse';
import { parsePathData } from '../../src/svg/pathParse';
import { downscaleBoxRaster } from '../../src/core/upscale';
import { rasterizeLayers } from '../../src/metrics/scanline';
import { nearestUpscale } from '../../src/dev/synth';

export interface ParsedSvg {
  width: number;
  height: number;
  vbW: number;
  vbH: number;
  /** One layer per <path>, in document order; coordinates in viewBox units. */
  layers: Layer[];
  /** Every path of every layer. */
  paths: AbsPath[];
}

const HEADER_RE = /<svg\b[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"[^>]*\sviewBox="0 0 ([\d.]+) ([\d.]+)"/;

/** Parses the <svg> header and every <path> (fill + d, parsed to absolute segments). */
export function parseSvg(svg: string): ParsedSvg {
  const m = HEADER_RE.exec(svg);
  if (m === null) throw new Error('parseSvg: cabecera <svg> no reconocida');
  const layers: Layer[] = extractPaths(svg).map((e) => ({
    fill: e.fill ?? '#000000',
    paths: [parsePathData(e.d)],
  }));
  return {
    width: Number(m[1]),
    height: Number(m[2]),
    vbW: Number(m[3]),
    vbH: Number(m[4]),
    layers,
    paths: layers.flatMap((l) => l.paths),
  };
}

/** Coverage image -> mask at 128. */
export function binarise(cov: GrayImage): BinaryMask {
  const out = new Uint8Array(cov.data.length);
  for (let i = 0; i < out.length; i++) out[i] = cov.data[i] >= 128 ? 1 : 0;
  return { data: out, width: cov.width, height: cov.height };
}

export function hexToRgb(hex: string): RGB {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Number of subpaths (M segments) in a path. */
export function subpathCount(p: AbsPath): number {
  let n = 0;
  for (const s of p.segs) if (s.kind === 'M') n++;
  return n;
}

/**
 * Renders the parsed layers at viewBox size over `background` and brings the result to the
 * original 1x size: box-downscale when the viewBox is an integer multiple of the image
 * (lines/flat, U >= 1), nearest-upscale when the image is a multiple of the viewBox (pixel mode).
 */
export function renderAt1x(parsed: ParsedSvg, background: RGB | null): RasterImage {
  const rendered = rasterizeLayers(parsed.layers, parsed.vbW, parsed.vbH, background);
  if (parsed.vbW === parsed.width && parsed.vbH === parsed.height) return rendered;
  if (parsed.vbW % parsed.width === 0 && parsed.vbW / parsed.width === parsed.vbH / parsed.height) {
    return downscaleBoxRaster(rendered, parsed.vbW / parsed.width);
  }
  if (parsed.width % parsed.vbW === 0 && parsed.width / parsed.vbW === parsed.height / parsed.vbH) {
    return nearestUpscale(rendered, parsed.width / parsed.vbW);
  }
  throw new Error(`renderAt1x: viewBox ${parsed.vbW}x${parsed.vbH} vs tamaño ${parsed.width}x${parsed.height}`);
}
