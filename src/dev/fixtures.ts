/**
 * Dev-only `?synth=` loader: builds one of the synthetic images of ./synth so the app can be
 * exercised without files (`?synth=circle|line|glyph|flat|sprite|logo|gradient|radial`). Pure TypeScript, like
 * the rest of src/dev: the app turns the RasterImage into ImageData.
 *
 * Sizes are larger than the unit-test defaults so the preview has something to look at; the
 * sprite is the 32 × 32 sprite scaled ×4 so the pixel-grid detector has a real grid to find.
 */
import type { RasterImage } from '../types';
import {
  aaCircle,
  aaDiagonalLine,
  flatShapes3,
  glyph,
  gradientFeathers,
  nearestUpscale,
  radialDisc,
  sprite32,
  transparentLogo,
} from './synth';

export const SYNTH_FIXTURES = ['circle', 'line', 'glyph', 'flat', 'sprite', 'logo', 'gradient', 'radial'] as const;
export type SynthFixtureName = (typeof SYNTH_FIXTURES)[number];

export interface SynthFixture {
  /** Pseudo file name, used for the download name ("synth-circle.svg"). */
  fileName: string;
  image: RasterImage;
}

/** The fixture named by the `synth` query parameter, or null. */
export function parseSynthParam(search: string): SynthFixtureName | null {
  const value = new URLSearchParams(search).get('synth');
  if (value === null) return null;
  return (SYNTH_FIXTURES as readonly string[]).includes(value) ? (value as SynthFixtureName) : null;
}

export function buildSynthFixture(name: SynthFixtureName): SynthFixture {
  let image: RasterImage;
  switch (name) {
    case 'circle':
      image = aaCircle(128, 40).image;
      break;
    case 'line':
      image = aaDiagonalLine(128, 1.5, 30).image;
      break;
    case 'glyph':
      image = glyph(96).image;
      break;
    case 'flat':
      image = flatShapes3(192).image;
      break;
    case 'sprite':
      image = nearestUpscale(sprite32(1), 4);
      break;
    case 'logo':
      image = transparentLogo(128).image;
      break;
    case 'gradient':
      image = gradientFeathers(512).image;
      break;
    case 'radial':
      image = radialDisc(256).image;
      break;
  }
  return { fileName: `synth-${name}.png`, image };
}
