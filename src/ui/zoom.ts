/**
 * Zoom and pan maths for the synchronized preview panes. Pure and DOM-free.
 *
 * A view is `{ zoom, cx, cy }`:
 * - `zoom` is relative to "fit": 1 shows the whole image inside the viewport (minus padding),
 *   16 is the maximum magnification.
 * - `(cx, cy)` is the image point, in source pixels, shown at the centre of the viewport.
 *
 * Every pane of the same size renders the same view with the same transform, which is what keeps
 * "Lado a lado" synchronized. Screen mapping: `sx = tx + x * scale`, `sy = ty + y * scale`.
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 16;
export const ZOOM_STEPS: readonly number[] = [1, 1.5, 2, 3, 4, 6, 8, 12, 16];
/** Breathing room around the image at zoom 1 (CSS px per side). */
export const VIEW_PADDING = 16;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface View {
  zoom: number;
  cx: number;
  cy: number;
}

export interface ViewTransform {
  /** CSS px per source px. */
  scale: number;
  tx: number;
  ty: number;
}

/** Largest scale at which the image fits the padded viewport. */
export function fitScale(viewport: Size, image: Size, padding = VIEW_PADDING): number {
  if (image.width <= 0 || image.height <= 0) return 1;
  const w = Math.max(1, viewport.width - 2 * padding);
  const h = Math.max(1, viewport.height - 2 * padding);
  return Math.min(w / image.width, h / image.height);
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return zoom < MIN_ZOOM ? MIN_ZOOM : zoom > MAX_ZOOM ? MAX_ZOOM : zoom;
}

/** Zoom 1, centred. */
export function fitView(image: Size): View {
  return { zoom: 1, cx: image.width / 2, cy: image.height / 2 };
}

function clampAxis(c: number, imageLen: number, viewportLen: number, scale: number): number {
  if (imageLen * scale <= viewportLen) return imageLen / 2;
  const half = viewportLen / (2 * scale);
  return c < half ? half : c > imageLen - half ? imageLen - half : c;
}

/**
 * Clamps zoom to [1, 16] and the centre so the image never leaves the viewport: an axis that fits
 * stays centred; an axis larger than the viewport cannot show past the image edge.
 */
export function clampView(view: View, viewport: Size, image: Size, padding = VIEW_PADDING): View {
  const zoom = clampZoom(view.zoom);
  const scale = fitScale(viewport, image, padding) * zoom;
  const cx = Number.isFinite(view.cx) ? view.cx : image.width / 2;
  const cy = Number.isFinite(view.cy) ? view.cy : image.height / 2;
  return {
    zoom,
    cx: clampAxis(cx, image.width, viewport.width, scale),
    cy: clampAxis(cy, image.height, viewport.height, scale),
  };
}

export function viewTransform(
  view: View,
  viewport: Size,
  image: Size,
  padding = VIEW_PADDING,
): ViewTransform {
  const v = clampView(view, viewport, image, padding);
  const scale = fitScale(viewport, image, padding) * v.zoom;
  return {
    scale,
    tx: viewport.width / 2 - v.cx * scale,
    ty: viewport.height / 2 - v.cy * scale,
  };
}

export function imageToScreen(p: Point, t: ViewTransform): Point {
  return { x: t.tx + p.x * t.scale, y: t.ty + p.y * t.scale };
}

export function screenToImage(p: Point, t: ViewTransform): Point {
  return { x: (p.x - t.tx) / t.scale, y: (p.y - t.ty) / t.scale };
}

/** New zoom keeping the image point under `anchor` (viewport coordinates) in place, then clamped. */
export function zoomAt(
  view: View,
  zoom: number,
  anchor: Point,
  viewport: Size,
  image: Size,
  padding = VIEW_PADDING,
): View {
  const target = screenToImage(anchor, viewTransform(view, viewport, image, padding));
  const z = clampZoom(zoom);
  const scale = fitScale(viewport, image, padding) * z;
  return clampView(
    {
      zoom: z,
      cx: target.x - (anchor.x - viewport.width / 2) / scale,
      cy: target.y - (anchor.y - viewport.height / 2) / scale,
    },
    viewport,
    image,
    padding,
  );
}

/** Drags the content by (dx, dy) screen px (content follows the pointer). */
export function panBy(
  view: View,
  dx: number,
  dy: number,
  viewport: Size,
  image: Size,
  padding = VIEW_PADDING,
): View {
  const v = clampView(view, viewport, image, padding);
  const scale = fitScale(viewport, image, padding) * v.zoom;
  return clampView({ zoom: v.zoom, cx: v.cx - dx / scale, cy: v.cy - dy / scale }, viewport, image, padding);
}

/** Next preset step up (+1) or down (-1) from `zoom`. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const z = clampZoom(zoom);
  if (direction > 0) {
    for (const s of ZOOM_STEPS) if (s > z + 1e-9) return s;
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < z - 1e-9) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}

/**
 * Exponential wheel zoom: negative deltaY zooms in. Line/page deltas are normalised to pixels and
 * a single event is capped so a coarse wheel cannot jump from 1× to 16×.
 */
export function wheelZoom(zoom: number, deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const capped = px < -120 ? -120 : px > 120 ? 120 : px;
  return clampZoom(clampZoom(zoom) * Math.exp(-capped * 0.004));
}

/** Nearest-neighbour rendering for the raster once a source pixel covers more than one CSS px. */
export function isPixelated(scale: number): boolean {
  return scale > 1;
}
