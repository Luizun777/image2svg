/**
 * 'empty-trace' hint: when composite mode leaves no ink on a source whose transparency holds the shape,
 * the warning points to Transparencia: Máscara; other empty traces keep the threshold hint.
 */
import { describe, expect, it } from 'vitest';
import type { Engine, RasterImage, Tracer } from '../../src/types';
import { trace } from '../../src/core/pipeline';
import { createPotraceTracer } from '../../src/tracers/potrace';
import { createVtracerTracer } from '../../src/tracers/vtracer';
import { aaCircle, transparentLogo } from '../../src/dev/synth';
import { parseSvg } from '../fixtures/svgBack';

const tracers: Record<Engine, Tracer> = { potrace: createPotraceTracer(), vtracer: createVtracerTracer() };
const SMOOTH = { mode: 'lines', engine: 'potrace', upscale: 4 } as const;

/** transparentLogo's star in white: composited on white it is plain paper, its alpha is the star. */
function whiteStar(): RasterImage {
  const { image } = transparentLogo(64);
  const data = Uint8ClampedArray.from(image.data);
  for (let p = 0; p < data.length; p += 4) data.set([255, 255, 255], p);
  return { data, width: image.width, height: image.height };
}

describe("'empty-trace' hint", () => {
  it('composite mode on a transparent logo that vanishes into the paper suggests Transparencia: Máscara', async () => {
    const image = whiteStar();
    const composite = await trace(image, { ...SMOOTH, alphaMode: 'composite' }, tracers);
    expect(parseSvg(composite.svg).paths).toHaveLength(0);
    expect(composite.warnings.map((w) => w.code)).toEqual(['empty-trace']);
    const message = composite.warnings[0].message;
    expect(message).toContain('Transparencia: Máscara');
    expect(message).toContain('zonas transparentes');
    expect(message).not.toMatch(/umbral/);
    expect(message).not.toMatch(/[–—]/);
    // The suggestion works: the alpha mask traces the star without any warning.
    const mask = await trace(image, { ...SMOOTH, alphaMode: 'mask' }, tracers);
    expect(parseSvg(mask.svg).paths.length).toBeGreaterThan(0);
    expect(mask.warnings).toEqual([]);
  });

  it('an empty trace without a shape in the transparency keeps the threshold hint', async () => {
    // Opaque light-grey square on white: its level is too close to the paper for offset -0.25.
    const size = 48;
    const data = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 12; y < 36; y++) for (let x = 12; x < 36; x++) data.set([240, 240, 240], (y * size + x) * 4);
    const grey = await trace({ data, width: size, height: size }, { ...SMOOTH, thresholdOffset: -0.25 }, tracers);
    expect(parseSvg(grey.svg).paths).toHaveLength(0);
    expect(grey.warnings.map((w) => w.code)).toEqual(['empty-trace']);
    expect(grey.warnings[0].message).toMatch(/umbral/);
    expect(grey.warnings[0].message).not.toContain('Máscara');

    // Alpha mask mode with invert on an opaque image: already a mask, uniform alpha, same threshold hint.
    const inverted = await trace(aaCircle().image, { ...SMOOTH, alphaMode: 'mask', invert: true }, tracers);
    expect(inverted.warnings.map((w) => w.code)).toEqual(['empty-trace']);
    expect(inverted.warnings[0].message).not.toContain('Máscara');
  });
});
