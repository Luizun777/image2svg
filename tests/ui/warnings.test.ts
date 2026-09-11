import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../../src/core/classify';
import { resolveParams } from '../../src/core/params';
import { bakedCheckerboardWarning, prepareLines } from '../../src/core/pipeline';
import { transparentLogo } from '../../src/dev/synth';
import type { BakedCheckerboard, RasterImage, Warning, WarningCode } from '../../src/types';
import type { WarningContext } from '../../src/ui/warnings';
import {
  WARNING_TITLE,
  keptCheckerboardMessage,
  mergeWarnings,
  suggestsAlphaMask,
  transparentCheckerboardMessage,
  warningAction,
  withBakedCheckerboard,
} from '../../src/ui/warnings';

const w = (code: WarningCode, message = 'm'): Warning => ({ code, message });

function ctx(over: Partial<WarningContext> = {}): WarningContext {
  return {
    params: {},
    mode: 'flat',
    engines: { potrace: true, vtracer: true },
    resolvedUpscale: 2,
    ...over,
  };
}

describe('mergeWarnings', () => {
  it('keeps trace warnings first and dedupes by code', () => {
    const merged = mergeWarnings(
      [w('upscale-capped', 'a'), w('upscale-capped', 'dup')],
      [w('photo'), w('upscale-capped', 'c')],
      'flat',
    );
    expect(merged.map((x) => x.code)).toEqual(['upscale-capped', 'photo']);
    expect(merged[0].message).toBe('a');
  });

  it('drops the classifier thin-strokes warning outside line tracing', () => {
    expect(mergeWarnings([], [w('thin-strokes')], 'flat')).toEqual([]);
    expect(mergeWarnings([], [w('thin-strokes')], 'lines').map((x) => x.code)).toEqual(['thin-strokes']);
  });

  it('titles every code', () => {
    for (const title of Object.values(WARNING_TITLE)) expect(title.length).toBeGreaterThan(3);
  });
});

describe('warningAction', () => {
  it('photo: more colours in flat, Color plano elsewhere', () => {
    const a = warningAction(w('photo'), ctx());
    expect(a?.label).toBe('Usar 32 colores');
    expect(a?.apply({ colors: 16, exactPalette: false })).toEqual({ colors: 32, exactPalette: false });
    expect(warningAction(w('photo'), ctx({ params: { colors: 32 } }))).toBeNull();
    const toFlat = warningAction(w('photo'), ctx({ mode: 'lines' }));
    expect(toFlat?.label).toBe('Cambiar a Color plano');
    expect(toFlat?.apply({ mode: 'auto' })).toEqual({ mode: 'flat' });
  });

  it('thin-strokes: upscale first, then less blur', () => {
    const lines = ctx({ mode: 'lines' });
    expect(warningAction(w('thin-strokes'), lines)?.apply({})).toEqual({ upscale: 4 });
    const at4 = ctx({ mode: 'lines', resolvedUpscale: 4 });
    expect(warningAction(w('thin-strokes'), at4)?.label).toBe('Reducir desenfoque');
    expect(warningAction(w('thin-strokes'), at4)?.apply({})).toEqual({ blurK: 0.15 });
    expect(warningAction(w('thin-strokes'), { ...at4, params: { blurK: 0.1 } })).toBeNull();
  });

  it('too-many-rects and empty-trace', () => {
    expect(warningAction(w('too-many-rects'), ctx({ mode: 'pixel' }))?.apply({ mode: 'pixel' })).toEqual({
      mode: 'flat',
    });
    expect(warningAction(w('too-many-rects'), ctx())).toBeNull();
    expect(warningAction(w('empty-trace'), ctx({ mode: 'lines' }))?.label).toBe('Cambiar a Color plano');
    expect(warningAction(w('empty-trace'), ctx())?.apply({})).toEqual({ turdsize: 0 });
    const vt = ctx({ params: { engine: 'vtracer' } });
    expect(warningAction(w('empty-trace'), vt)?.apply({ vtracer: { maxIterations: 12 } })).toEqual({
      vtracer: { maxIterations: 12, filterSpeckle: 0 },
    });
    expect(warningAction(w('empty-trace'), ctx({ params: { turdsize: 0 } }))).toBeNull();
  });

  it('engine-unavailable offers the other engine only if it works', () => {
    const a = warningAction(w('engine-unavailable'), ctx({ params: { engine: 'vtracer' } }));
    expect(a?.label).toBe('Usar Potrace');
    expect(a?.apply({ engine: 'vtracer' })).toEqual({ engine: 'potrace' });
    expect(
      warningAction(w('engine-unavailable'), ctx({ params: { engine: 'vtracer' }, engines: { potrace: false, vtracer: false } })),
    ).toBeNull();
  });

  it('has no action for purely informative warnings', () => {
    expect(warningAction(w('upscale-capped'), ctx())).toBeNull();
    expect(warningAction(w('large-input'), ctx())).toBeNull();
  });
});

/** As detected on clip_art: a 20 px board, levels 238 / 254. */
const BOARD: BakedCheckerboard = {
  cell: 20.007,
  offsetX: 0,
  offsetY: 0,
  levels: [
    [238, 238, 238],
    [254, 254, 254],
  ],
  borderMatchRatio: 1,
};

describe('painted checkerboard banner', () => {
  it('has a title and toggles between keeping the board and treating it as transparent, in every mode', () => {
    expect(WARNING_TITLE['baked-checkerboard']).toBe('Transparencia falsa');
    for (const mode of ['flat', 'pixel'] as const) {
      const keep = warningAction(w('baked-checkerboard'), ctx({ mode }));
      expect(keep?.label, mode).toBe('Mantener el tablero');
      expect(keep?.apply({ colors: 16 })).toEqual({ colors: 16, bakedBackground: 'keep' });
    }
    for (const mode of ['lines', 'flat', 'pixel'] as const) {
      const back = warningAction(w('baked-checkerboard'), ctx({ mode, params: { bakedBackground: 'keep' } }));
      expect(back?.label, mode).toBe('Tratar como transparente');
      expect(back?.apply({ colors: 16, bakedBackground: 'keep' })).toEqual({ colors: 16, bakedBackground: 'auto' });
    }
  });

  it('keeps the board in Color plano from Líneas/logo, which traces a single colour', () => {
    const fromAuto = warningAction(w('baked-checkerboard'), ctx({ mode: 'lines', params: { mode: 'auto' } }));
    expect(fromAuto?.label).toBe('Mantener el tablero en Color plano');
    expect(fromAuto?.apply({ mode: 'auto' })).toEqual({ mode: 'flat', bakedBackground: 'keep' });
    // The mode picked in the UI wins over the trace on screen, which lags behind the change.
    expect(warningAction(w('baked-checkerboard'), ctx({ mode: 'flat', params: { mode: 'lines' } }))?.label).toBe(
      'Mantener el tablero en Color plano',
    );
    expect(warningAction(w('baked-checkerboard'), ctx({ mode: 'lines', params: { mode: 'flat' } }))?.label).toBe(
      'Mantener el tablero',
    );
  });

  it("uses the pipeline's own text while the board is treated as transparent", () => {
    expect(transparentCheckerboardMessage(BOARD)).toBe(bakedCheckerboardWarning(BOARD).message);
    expect(keptCheckerboardMessage(BOARD, 'flat')).toContain('cuadros de 20 px');
    expect(keptCheckerboardMessage(BOARD, 'flat')).toContain('se traza y se compara con los píxeles tal cual');
    expect(keptCheckerboardMessage(BOARD, 'lines')).toContain('Líneas/logo traza un solo color');
    const all = [transparentCheckerboardMessage(BOARD), keptCheckerboardMessage(BOARD, 'flat'), keptCheckerboardMessage(BOARD, 'lines')];
    for (const message of all) expect(message).not.toMatch(/[\n–—]/);
  });

  it('goes first and follows the UI setting, not the trace still on screen', () => {
    const photo = w('photo', 'p');
    const autoTrace = [photo, bakedCheckerboardWarning(BOARD)];
    expect(withBakedCheckerboard(autoTrace, BOARD, 'auto', 'flat')).toEqual([bakedCheckerboardWarning(BOARD), photo]);
    // "Mantener el tablero" clicked while the 'auto' trace is still shown: already the kept text.
    expect(withBakedCheckerboard(autoTrace, BOARD, 'keep', 'flat')).toEqual([
      { code: 'baked-checkerboard', message: keptCheckerboardMessage(BOARD, 'flat') },
      photo,
    ]);
    // A 'keep' trace carries no warning; back to 'auto' before the re-trace answers.
    expect(withBakedCheckerboard([photo], BOARD, 'keep', 'lines')[0].message).toBe(keptCheckerboardMessage(BOARD, 'lines'));
    expect(withBakedCheckerboard([photo], BOARD, 'auto', 'pixel')).toEqual([bakedCheckerboardWarning(BOARD), photo]);
    // Nothing detected: the list is left alone.
    expect(withBakedCheckerboard([photo], null, 'keep', 'flat')).toEqual([photo]);
  });
});

/** transparentLogo's star in white: composited on white it is plain paper, its alpha is the star. */
function whiteStar(): RasterImage {
  const { image } = transparentLogo(64);
  const data = Uint8ClampedArray.from(image.data);
  for (let p = 0; p < data.length; p += 4) data.set([255, 255, 255], p);
  return { data, width: image.width, height: image.height };
}

/** Opaque light-grey square on white: too close to the paper for threshold offset -0.25. */
function greySquare(): RasterImage {
  const size = 48;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 12; y < 36; y++) for (let x = 12; x < 36; x++) data.set([240, 240, 240], (y * size + x) * 4);
  return { data, width: size, height: size };
}

function emptyTraceOf(image: RasterImage, params: Parameters<typeof resolveParams>[0]): Warning {
  const prepared = prepareLines(image, resolveParams(params, image), analyzeSource(image));
  const found = prepared.warnings.find((x) => x.code === 'empty-trace');
  if (found === undefined) throw new Error('expected an empty-trace warning');
  return found;
}

describe('empty-trace with the alpha mask as the fix', () => {
  it('offers "Usar máscara de transparencia" when the real pipeline message suggests it', () => {
    const hint = emptyTraceOf(whiteStar(), { mode: 'lines', upscale: 4, alphaMode: 'composite' });
    expect(suggestsAlphaMask(hint)).toBe(true);
    const action = warningAction(hint, ctx({ mode: 'lines', params: { alphaMode: 'composite' } }));
    expect(action?.label).toBe('Usar máscara de transparencia');
    expect(action?.apply({ alphaMode: 'composite', upscale: 4 })).toEqual({ alphaMode: 'mask', upscale: 4 });
    // Already on the mask: nothing new to offer there, Color plano stays.
    expect(warningAction(hint, ctx({ mode: 'lines', params: { alphaMode: 'mask' } }))?.label).toBe('Cambiar a Color plano');
  });

  it('keeps Cambiar a Color plano for the threshold cause', () => {
    const hint = emptyTraceOf(greySquare(), { mode: 'lines', upscale: 4, thresholdOffset: -0.25 });
    expect(suggestsAlphaMask(hint)).toBe(false);
    expect(warningAction(hint, ctx({ mode: 'lines' }))?.label).toBe('Cambiar a Color plano');
    expect(suggestsAlphaMask(w('photo', 'Prueba Transparencia: Máscara'))).toBe(false);
  });
});
