import { describe, expect, it } from 'vitest';
import type { BakedCheckerboard, BinaryMask, RasterImage } from '../../src/types';
import {
  applyBakedBackground,
  bakedBackgroundMask,
  detectBakedCheckerboard,
  effectiveSource,
} from '../../src/core/bakedBackground';
import { analyzeSource } from '../../src/core/classify';
import { cloneRaster } from '../../src/core/raster';
import {
  aaCircle,
  bakedCheckerLogo,
  chessboardGraphic,
  flatShapes3,
  glyph,
  noisePhoto,
  sprite32,
  transparentLogo,
  type BakedCheckerLogoOptions,
} from '../../src/dev/synth';
import { maskIoU, rasterEquals } from '../fixtures/helpers';
import { barOnBoard, boardLevel, diagonalStripes, gingham, outlinedSprite, stickerOnBoard } from '../fixtures/shapes';

/** Largest raw-RGB channel error allowed when a translucent pixel is recomposed over its board level. */
const RESIDUAL_LIMIT = 48;

/** Levels 255 / 204 (Photoshop's grid), boundaries on multiples of 10. */
const C10: BakedCheckerLogoOptions = { cell: 10 };
/** Levels 238 / 255 (clip_art), boundaries at 5 + 16k and 11 + 16k. */
const C16: BakedCheckerLogoOptions = { cell: 16, offset: [5, 11], levels: [238, 255] };

function transparentMask(img: RasterImage): BinaryMask {
  const data = new Uint8Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) data[i] = img.data[i * 4 + 3] < 128 ? 1 : 0;
  return { data, width: img.width, height: img.height };
}

function parityOf(det: BakedCheckerboard, x: number, y: number): number {
  return (Math.floor((x + 0.5 - det.offsetX) / det.cell) + Math.floor((y + 0.5 - det.offsetY) / det.cell)) & 1;
}

/** Distance from a pixel centre to the nearest cell boundary of a grid. */
function boundaryDistance(v: number, offset: number, cell: number): number {
  const f = (((v + 0.5 - offset) % cell) + cell) % cell;
  return Math.min(f, cell - f);
}

describe('detectBakedCheckerboard', () => {
  it('finds the cell, the grid and the levels of a painted checkerboard (cells 10, 16 and 12.5, +-4 noise)', () => {
    const cases: Array<[BakedCheckerLogoOptions, number]> = [
      [C10, 10],
      [C16, 16],
      [{ cell: 12.5, offset: [3, 7], levels: [153, 252], seed: 3 }, 12.5],
    ];
    for (const [opts, cell] of cases) {
      const f = bakedCheckerLogo(opts);
      const det = detectBakedCheckerboard(f.image);
      expect(det, JSON.stringify(opts)).not.toBeNull();
      if (det === null) continue;
      expect(Math.abs(det.cell - cell)).toBeLessThan(0.05);
      for (const o of [det.offsetX, det.offsetY]) {
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThan(det.cell);
      }
      expect(det.borderMatchRatio).toBeGreaterThanOrEqual(0.95);
      // The detected grid, parity and levels predict the painted grey of every uncovered pixel
      // at least 1 px from a true cell boundary (noise +-4, level means rounded).
      const [ox, oy] = opts.offset ?? [0, 0];
      const levels = opts.levels ?? [255, 204];
      let checked = 0;
      for (let y = 0; y < f.image.height; y++) {
        for (let x = 0; x < f.image.width; x++) {
          if (f.coverage[y * f.image.width + x] !== 0) continue;
          if (boundaryDistance(x, ox, cell) < 1 || boundaryDistance(y, oy, cell) < 1) continue;
          const truth = levels[(Math.floor((x + 0.5 - ox) / cell) + Math.floor((y + 0.5 - oy) / cell)) & 1];
          const level = det.levels[parityOf(det, x, y)];
          expect(Math.abs(level[0] - truth), `${x},${y}`).toBeLessThanOrEqual(3);
          checked++;
        }
      }
      // Sanity: the loop really checked most of the uncovered pixels (7 649 for the 12.5 px cell).
      expect(checked).toBeGreaterThan(5000);
    }
  });

  it('is null without fake transparency: fixtures, a real chessboard on a solid background, alpha', () => {
    const images: Array<[string, RasterImage]> = [
      ['aaCircle', aaCircle().image],
      ['glyph', glyph().image],
      ['flatShapes3', flatShapes3().image],
      ['sprite32', sprite32()],
      ['transparentLogo', transparentLogo().image],
      ['noisePhoto', noisePhoto()],
      ['chessboardGraphic', chessboardGraphic().image],
    ];
    for (const [name, img] of images) expect(detectBakedCheckerboard(img), name).toBeNull();
    // A checkerboard image that already has real transparency (2 % transparent) is not faked.
    const withAlpha = cloneRaster(bakedCheckerLogo(C10).image);
    for (let i = 0; i < 0.02 * withAlpha.data.length / 4; i++) withAlpha.data[i * 4 + 3] = 0;
    expect(detectBakedCheckerboard(withAlpha)).toBeNull();
  });
});

describe('detectBakedCheckerboard: patterns that only look like a checkerboard along the border', () => {
  it('is null for light 45-degree stripes (every size, width and level pair of the sweep)', () => {
    // Along the top and left bands the stripes flip exactly like a checkerboard; only the far bands
    // disagree, and when the height and width leave little of the next stripe the band ratio reached
    // 0.92-0.93 (200x150 s 18, 300x200 s 14, 512x512 s 22, 400x300 s 36).
    const sizes: Array<[number, number]> = [[200, 150], [300, 200], [512, 512], [400, 300]];
    const widths = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48];
    const levels: Array<[number, number]> = [[255, 230], [255, 204], [238, 254]];
    const detected: string[] = [];
    for (const [w, h] of sizes) {
      for (const s of widths) {
        for (const lv of levels) {
          if (detectBakedCheckerboard(diagonalStripes(w, h, s, lv)) !== null) detected.push(`${w}x${h} s${s} ${lv.join('/')}`);
        }
      }
    }
    expect(detected).toEqual([]);
  });

  it('is null for grey gingham (three levels in square cells)', () => {
    for (const [w, h, s] of [[128, 128, 8], [160, 120, 10], [256, 256, 16], [200, 150, 12]]) {
      expect(detectBakedCheckerboard(gingham(w, h, s, [255, 230, 205])), `${w}x${h} s${s}`).toBeNull();
    }
  });
});

describe('bakedBackgroundMask', () => {
  it('matches the true background (coverage < 0.5): IoU >= 0.98 for the mask and for the effective transparency', () => {
    // Measured: mask 0.9940-0.9945, alpha < 128 of the effective source 0.9930-0.9936.
    for (const opts of [C10, C16, { ...C10, seed: 2 }, { ...C16, seed: 5 }]) {
      const f = bakedCheckerLogo(opts);
      const det = detectBakedCheckerboard(f.image);
      expect(det).not.toBeNull();
      if (det === null) continue;
      expect(maskIoU(bakedBackgroundMask(f.image, det), f.background)).toBeGreaterThanOrEqual(0.98);
      expect(maskIoU(transparentMask(applyBakedBackground(f.image, det)), f.background)).toBeGreaterThanOrEqual(0.98);
    }
  });

  it('letter-counter holes inside the logo show the checkerboard and are background', () => {
    for (const opts of [C10, C16]) {
      const f = bakedCheckerLogo({ ...opts, inner: 'counters' });
      const det = detectBakedCheckerboard(f.image);
      expect(det).not.toBeNull();
      if (det === null) continue;
      const mask = bakedBackgroundMask(f.image, det);
      let counters = 0;
      let background = 0;
      for (let i = 0; i < mask.data.length; i++) {
        if (f.counters.data[i] === 0) continue;
        counters++;
        if (mask.data[i] !== 0) background++;
      }
      expect(counters).toBeGreaterThan(100);
      expect(background).toBe(counters);
    }
  });

  it('keeps a genuine white rectangle spanning several cells inside the opaque logo', () => {
    for (const opts of [C10, C16]) {
      const f = bakedCheckerLogo({ ...opts, inner: 'whiteRect' });
      const det = detectBakedCheckerboard(f.image);
      expect(det).not.toBeNull();
      if (det === null) continue;
      const mask = bakedBackgroundMask(f.image, det);
      const eff = applyBakedBackground(f.image, det);
      let rect = 0;
      for (let i = 0; i < mask.data.length; i++) {
        if (f.whiteRect.data[i] === 0) continue;
        rect++;
        expect(mask.data[i]).toBe(0);
        expect(eff.data[i * 4 + 3]).toBe(255);
      }
      expect(rect).toBeGreaterThan(600);
    }
  });
});

describe('bakedBackgroundMask: light shapes touching the checkerboard', () => {
  it('keeps the whole of a light bar that touches the board, over the cells of both levels', () => {
    const cases: Array<[[number, number], number]> = [
      [[255, 204], 255],
      [[255, 204], 204],
      [[238, 255], 238],
      [[238, 255], 255],
    ];
    for (const [levels, bar] of cases) {
      const label = `levels ${levels.join('/')} bar ${bar}`;
      const f = barOnBoard(levels, bar);
      const det = detectBakedCheckerboard(f.image);
      expect(det, label).not.toBeNull();
      if (det === null) continue;
      const mask = bakedBackgroundMask(f.image, det);
      const eff = applyBakedBackground(f.image, det);
      const w = f.image.width;
      let barPixels = 0;
      let lost = 0;
      let board = 0;
      let boardKept = 0;
      for (let i = 0; i < mask.data.length; i++) {
        if (f.bar.data[i] !== 0) {
          barPixels++;
          if (mask.data[i] !== 0 || eff.data[i * 4 + 3] !== 255) lost++;
          continue;
        }
        // Board pixels at least 2 px (Chebyshev) from anything opaque stay background.
        const x = i % w;
        const y = (i / w) | 0;
        let clear = true;
        for (let dy = -2; dy <= 2 && clear; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            const yy = Math.min(w - 1, Math.max(0, y + dy));
            if (f.truth.data[(yy * w + xx) * 4 + 3] !== 0) {
              clear = false;
              break;
            }
          }
        }
        if (!clear) continue;
        board++;
        if (mask.data[i] === 0) boardKept++;
      }
      expect(barPixels, label).toBe(3840);
      expect(lost, label).toBe(0);
      expect(board, label).toBeGreaterThan(15000);
      expect(boardKept, label).toBe(0);
    }
  });
});

describe('applyBakedBackground / effectiveSource', () => {
  it('makes the background transparent, leaves the logo interior untouched and estimates the edge alpha', () => {
    const f = bakedCheckerLogo(C10);
    const before = cloneRaster(f.image);
    const det = detectBakedCheckerboard(f.image);
    expect(det).not.toBeNull();
    if (det === null) return;
    const eff = applyBakedBackground(f.image, det);
    expect(rasterEquals(f.image, before)).toBe(true);
    const w = f.image.width;
    const h = f.image.height;
    const cov = (x: number, y: number): number => f.coverage[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
    let partial = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const p = i * 4;
        let lo = 1;
        let hi = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            lo = Math.min(lo, cov(x + dx, y + dy));
            hi = Math.max(hi, cov(x + dx, y + dy));
          }
        }
        if (hi === 0) expect(eff.data[p + 3], `bg ${x},${y}`).toBe(0);
        if (lo === 1) {
          expect(eff.data[p + 3], `ink ${x},${y}`).toBe(255);
          expect(Array.from(eff.data.subarray(p, p + 3))).toEqual(Array.from(f.image.data.subarray(p, p + 3)));
        }
        if (eff.data[p + 3] > 0 && eff.data[p + 3] < 255) {
          partial++;
          expect(lo < 1 && hi > 0, `partial ${x},${y}`).toBe(true);
        }
      }
    }
    expect(partial).toBeGreaterThan(50);
  });

  it('leaves hard-edged sprite pixels next to a darker outline opaque and exact (no blend of the board explains them)', () => {
    const f = outlinedSprite();
    const det = detectBakedCheckerboard(f.image);
    expect(det).not.toBeNull();
    if (det === null) return;
    const eff = applyBakedBackground(f.image, det);
    let sprite = 0;
    const wrong: string[] = [];
    for (let i = 0; i < f.sprite.data.length; i++) {
      const p = i * 4;
      if (f.sprite.data[i] === 0) {
        expect(eff.data[p + 3], `board ${i}`).toBe(0);
        continue;
      }
      sprite++;
      const got = Array.from(eff.data.subarray(p, p + 4));
      const want = [...Array.from(f.image.data.subarray(p, p + 3)), 255];
      if (got.join() !== want.join()) wrong.push(`${i % 64},${(i / 64) | 0}: ${got.join()}`);
    }
    expect(sprite).toBe(576);
    expect(wrong).toEqual([]);
  });

  it('keeps the pure fill of an anti-aliased sticker with a 1 px dark ring, and every translucent pixel is a blend of its colour and the board', () => {
    const f = stickerOnBoard();
    const det = detectBakedCheckerboard(f.image);
    expect(det).not.toBeNull();
    if (det === null) return;
    const eff = applyBakedBackground(f.image, det);
    const w = f.image.width;
    let fill = 0;
    let corrupted = 0;
    let translucent = 0;
    let worst = 0;
    for (let i = 0; i < f.fill.data.length; i++) {
      const p = i * 4;
      if (f.fill.data[i] !== 0) {
        fill++;
        if (eff.data[p + 3] !== 255 || eff.data[p] !== f.image.data[p] || eff.data[p + 1] !== f.image.data[p + 1] || eff.data[p + 2] !== f.image.data[p + 2]) {
          corrupted++;
        }
      }
      const a = eff.data[p + 3] / 255;
      if (a === 0 || a === 1) continue;
      translucent++;
      const L = boardLevel(i % w, (i / w) | 0, f.cell, f.levels);
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(f.image.data[p + c] - (a * eff.data[p + c] + (1 - a) * L)));
    }
    expect(fill).toBeGreaterThan(7000);
    expect(corrupted).toBe(0);
    expect(translucent).toBeGreaterThan(100);
    expect(worst).toBeLessThanOrEqual(RESIDUAL_LIMIT);
  });

  it('effectiveSource is the image itself without a detection or with keep; analyzeSource applies it by default', () => {
    const { image } = bakedCheckerLogo(C16);
    const info = analyzeSource(image);
    expect(info.bakedBackground).not.toBeNull();
    expect(info.transparentRatio).toBeGreaterThan(0.6);
    const kept = analyzeSource(image, 'keep');
    expect(kept.bakedBackground).toBeNull();
    expect(kept.transparentRatio).toBe(0);
    expect(effectiveSource(image, kept, {})).toBe(image);
    expect(effectiveSource(image, info, { bakedBackground: 'keep' })).toBe(image);
    const eff = effectiveSource(image, info, { bakedBackground: 'auto' });
    expect(eff).not.toBe(image);
    expect(rasterEquals(eff, applyBakedBackground(image, info.bakedBackground as BakedCheckerboard))).toBe(true);
    // A real chessboard graphic on a solid background is not erased.
    const board = chessboardGraphic().image;
    const boardInfo = analyzeSource(board);
    expect(boardInfo.bakedBackground).toBeNull();
    expect(effectiveSource(board, boardInfo, {})).toBe(board);
  });
});
