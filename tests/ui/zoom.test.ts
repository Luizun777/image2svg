import { describe, expect, it } from 'vitest';
import {
  clampView,
  clampZoom,
  fitScale,
  fitView,
  imageToScreen,
  isPixelated,
  panBy,
  screenToImage,
  stepZoom,
  viewTransform,
  wheelZoom,
  zoomAt,
} from '../../src/ui/zoom';

const vp = { width: 1000, height: 500 };
const img = { width: 200, height: 100 };

describe('fit and clamping', () => {
  it('fits the image inside the padded viewport', () => {
    expect(fitScale(vp, img)).toBeCloseTo(4.68, 12); // min(968/200, 468/100)
    expect(fitScale({ width: 10, height: 10 }, img)).toBeCloseTo(0.005, 12);
    expect(fitScale(vp, { width: 0, height: 10 })).toBe(1);
  });

  it('clamps zoom to 1×..16×', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(20)).toBe(16);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(3)).toBe(3);
  });

  it('centres the image at zoom 1', () => {
    const t = viewTransform(fitView(img), vp, img);
    expect(t.scale).toBeCloseTo(4.68, 12);
    expect(t.tx).toBeCloseTo(32, 9);
    expect(t.ty).toBeCloseTo(16, 9);
    expect(clampView({ zoom: 1, cx: 0, cy: 0 }, vp, img)).toEqual({ zoom: 1, cx: 100, cy: 50 });
  });

  it('keeps the image edges inside the viewport when zoomed', () => {
    const scale = 4.68 * 4;
    const half = 1000 / (2 * scale);
    expect(clampView({ zoom: 4, cx: 0, cy: 50 }, vp, img).cx).toBeCloseTo(half, 9);
    expect(clampView({ zoom: 4, cx: 1000, cy: 50 }, vp, img).cx).toBeCloseTo(200 - half, 9);
  });
});

describe('zoom and pan', () => {
  it('keeps the point under the cursor fixed', () => {
    const anchor = { x: 700, y: 200 };
    const before = viewTransform(fitView(img), vp, img);
    const p = screenToImage(anchor, before);
    const next = zoomAt(fitView(img), 4, anchor, vp, img);
    const s = imageToScreen(p, viewTransform(next, vp, img));
    expect(next.zoom).toBe(4);
    expect(s.x).toBeCloseTo(700, 9);
    expect(s.y).toBeCloseTo(200, 9);
  });

  it('pans the content with the pointer', () => {
    const scale = 4.68 * 4;
    const v = panBy({ zoom: 4, cx: 100, cy: 50 }, scale, -scale / 2, vp, img);
    expect(v.cx).toBeCloseTo(99, 9);
    expect(v.cy).toBeCloseTo(50.5, 9);
    expect(panBy(fitView(img), 300, 300, vp, img)).toEqual(fitView(img));
  });

  it('round-trips screen and image coordinates', () => {
    const t = viewTransform({ zoom: 6, cx: 80, cy: 30 }, vp, img);
    const p = { x: 12.5, y: 77.25 };
    const back = screenToImage(imageToScreen(p, t), t);
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('steps through presets', () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1.5, 1)).toBe(2);
    expect(stepZoom(5, 1)).toBe(6);
    expect(stepZoom(5, -1)).toBe(4);
    expect(stepZoom(16, 1)).toBe(16);
    expect(stepZoom(1.2, -1)).toBe(1);
    expect(stepZoom(1, -1)).toBe(1);
  });

  it('zooms with the wheel exponentially and within bounds', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1);
    expect(wheelZoom(4, 100)).toBeLessThan(4);
    expect(wheelZoom(16, -1000)).toBe(16);
    expect(wheelZoom(1, 1000)).toBe(1);
    expect(wheelZoom(2, -3, 1)).toBeCloseTo(wheelZoom(2, -48, 0), 12);
    // a single coarse event cannot jump more than ×1.62
    expect(wheelZoom(2, -100000)).toBeLessThan(2 * 1.62);
  });

  it('switches to nearest-neighbour above 1 CSS px per source px', () => {
    expect(isPixelated(1)).toBe(false);
    expect(isPixelated(1.01)).toBe(true);
  });
});
