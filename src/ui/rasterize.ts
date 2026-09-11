/**
 * Renders an SVG back to pixels on the MAIN thread (workers have no SVG renderer) so the worker
 * can compare it with the source. The SVG goes through a data: URL <img>; its root must keep
 * width/height/viewBox. It is drawn at 2× and box-reduced to 1× at the source size, which
 * approximates the anti-aliasing of the original raster better than a direct 1× draw.
 */
import { create2dContext } from '../platform/decode';
import { svgDataUrl } from './output';

/**
 * Largest canvas area we allocate (Safari and iOS refuse bigger canvases and draw nothing,
 * silently). Supersampling falls back to 1× when the 2× canvas would exceed it.
 */
export const MAX_CANVAS_AREA = 16_777_216;

export function supersampleFactor(width: number, height: number): 1 | 2 {
  return 4 * width * height <= MAX_CANVAS_AREA ? 2 : 1;
}

export async function rasterizeSvg(svg: string, width: number, height: number): Promise<ImageData> {
  const img = new Image();
  img.decoding = 'async';
  img.src = svgDataUrl(svg);
  try {
    await img.decode();
  } catch {
    throw new Error('El navegador no pudo renderizar el SVG para medir la fidelidad.');
  }

  const out = create2dContext(width, height);
  const k = supersampleFactor(width, height);
  if (k === 1) {
    out.ctx.drawImage(img, 0, 0, width, height);
  } else {
    const big = create2dContext(width * k, height * k, false);
    big.ctx.drawImage(img, 0, 0, width * k, height * k);
    out.ctx.imageSmoothingEnabled = true;
    out.ctx.imageSmoothingQuality = 'high';
    out.ctx.drawImage(big.canvas, 0, 0, width, height);
    // Release the 2× backing store right away instead of waiting for GC.
    big.canvas.width = 0;
    big.canvas.height = 0;
  }
  return out.ctx.getImageData(0, 0, width, height, { colorSpace: 'srgb' });
}
