/**
 * Background / alpha handling decisions. Pure.
 */
import type { AlphaMode, BackgroundSetting, RasterImage, RGB, SourceInfo } from '../types';

/** Fraction of transparent pixels above which 'auto' decisions treat the image as transparent. */
export const TRANSPARENT_AUTO_RATIO = 0.05;

const WHITE: RGB = [255, 255, 255];

/** Fraction of pixels with alpha < 8 (same definition as SourceInfo.transparentRatio). */
function transparentRatioOf(img: RasterImage): number {
  const n = img.width * img.height;
  if (n === 0) return 0;
  const d = img.data;
  let count = 0;
  for (let p = 3; p < d.length; p += 4) if (d[p] < 8) count++;
  return count / n;
}

/**
 * null = transparent background.
 * 'auto': transparent when more than 5 % of the pixels are transparent (alpha < 8); otherwise the
 * detected border colour when the border agrees, else white.
 */
export function resolveBackground(
  img: RasterImage,
  setting: BackgroundSetting,
  info: Pick<SourceInfo, 'borderColor'>,
): RGB | null {
  if (setting === 'transparent') return null;
  if (setting === 'white') return [...WHITE];
  if (typeof setting === 'object' && setting !== null) {
    const [r, g, b] = setting.rgb;
    return [clampByte(r), clampByte(g), clampByte(b)];
  }
  // 'auto'
  if (transparentRatioOf(img) > TRANSPARENT_AUTO_RATIO) return null;
  if (info.borderColor) return [info.borderColor[0], info.borderColor[1], info.borderColor[2]];
  return [...WHITE];
}

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** auto: 'mask' when transparentRatio > 0.05, else 'composite'. Explicit values pass through. */
export function resolveAlphaMode(
  info: Pick<SourceInfo, 'transparentRatio'>,
  setting: AlphaMode,
): 'mask' | 'composite' {
  if (setting === 'mask' || setting === 'composite') return setting;
  return info.transparentRatio > TRANSPARENT_AUTO_RATIO ? 'mask' : 'composite';
}
