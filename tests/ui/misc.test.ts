import { describe, expect, it } from 'vitest';
import { detectGrid } from '../../src/core/edges';
import { SYNTH_FIXTURES, buildSynthFixture, parseSynthParam } from '../../src/dev/fixtures';
import {
  ACCEPT_ATTRIBUTE,
  checkDimensions,
  describeFormat,
  sniffImageKind,
  unsupportedFormatMessage,
} from '../../src/platform/decode';
import { supersampleFactor } from '../../src/ui/rasterize';
import { FIDELITY_GUARD } from '../../src/tuner/autotune';
import {
  TUNE_BUDGET_MS,
  TUNE_FIDELITY_GUARD,
  TUNE_HINT,
  describeTuneProgress,
  formatTuneSummary,
  tuneCornerCount,
  tuneFraction,
  tuneResultOutdated,
} from '../../src/ui/tuneProgress';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const bytes = (...parts: Array<number[] | string>): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe('decode helpers', () => {
  it('sniffs the accepted formats from magic bytes', () => {
    expect(sniffImageKind(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffImageKind(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImageKind(bytes('GIF89a'))).toBe('gif');
    expect(sniffImageKind(bytes('GIF87a'))).toBe('gif');
    expect(sniffImageKind(bytes('BM', new Array<number>(12).fill(0)))).toBe('bmp');
    expect(sniffImageKind(bytes('RIFF', [0, 0, 0, 0], 'WEBP'))).toBe('webp');
  });

  it('rejects everything else', () => {
    expect(sniffImageKind(bytes('GIF88a'))).toBeNull();
    expect(sniffImageKind(bytes('BM'))).toBeNull();
    expect(sniffImageKind(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBeNull();
    expect(sniffImageKind(bytes([0, 0, 0, 0x1c], 'ftypavif'))).toBeNull();
    expect(sniffImageKind(new Uint8Array(0))).toBeNull();
  });

  it('names the rejected format in Spanish', () => {
    expect(describeFormat('image/avif', 'foto.avif')).toBe('AVIF');
    expect(describeFormat('image/tiff', '')).toBe('TIFF');
    expect(describeFormat('image/svg+xml', '')).toBe('SVG');
    expect(describeFormat('', '')).toBeNull();
    expect(unsupportedFormatMessage('image/avif', 'foto.avif')).toBe(
      'Formato no admitido (AVIF). Usa una imagen PNG, JPG, WebP, GIF o BMP.',
    );
    expect(unsupportedFormatMessage('', '')).toBe('Formato no admitido. Usa una imagen PNG, JPG, WebP, GIF o BMP.');
    expect(ACCEPT_ATTRIBUTE).toContain('.webp');
    expect(ACCEPT_ATTRIBUTE).toContain('image/bmp');
  });

  it('limits each side to 4096 px', () => {
    expect(checkDimensions(4096, 4096)).toBeNull();
    const msg = checkDimensions(4097, 10);
    expect(msg).toContain('4097');
    expect(msg).toContain('4096');
    expect(checkDimensions(10, 5000)).not.toBeNull();
    expect(checkDimensions(0, 10)).toBe('La imagen no tiene píxeles.');
  });
});

describe('rasterize supersampling', () => {
  it('draws at 2× only while the 2× canvas stays within 16.7 Mpx', () => {
    expect(supersampleFactor(1000, 1000)).toBe(2);
    expect(supersampleFactor(2048, 2048)).toBe(2);
    expect(supersampleFactor(2049, 2048)).toBe(1);
    expect(supersampleFactor(3840, 2160)).toBe(1);
  });
});

describe('tune progress', () => {
  it('shows cumulative done over the run total, whatever the stage', () => {
    // Real tuner counts are cumulative over one total (measured "A 25/101" then "B 58/101").
    expect(tuneFraction({ stage: 'A', done: 0, total: 101, best: null })).toBe(0);
    expect(tuneFraction({ stage: 'A', done: 25, total: 101, best: null })).toBeCloseTo(25 / 101, 12);
    expect(tuneFraction({ stage: 'B', done: 58, total: 101, best: null })).toBeCloseTo(58 / 101, 12);
    expect(tuneFraction({ stage: 'engine', done: 101, total: 101, best: null })).toBe(1);
    expect(tuneFraction({ stage: 'B', done: 150, total: 101, best: null })).toBe(1);
    expect(tuneFraction({ stage: 'A', done: 1, total: 1, best: null })).toBe(1); // pixel mode: one evaluation
    expect(tuneFraction({ stage: 'A', done: 3, total: 0, best: null })).toBe(0);
    expect(tuneFraction({ stage: 'A', done: -2, total: 10, best: null })).toBe(0);
  });

  it('describes stage, count and best score', () => {
    expect(describeTuneProgress({ stage: 'A', done: 12, total: 40, best: { score: 0.9474, params: {} } })).toBe(
      'Etapa A: exploración · 12/40 · mejor puntuación 0,947',
    );
    expect(describeTuneProgress({ stage: 'B', done: 3, total: 9, best: null })).toBe('Etapa B: refinado · 3/9');
  });
});

describe('dev fixtures', () => {
  it('parses the synth query parameter', () => {
    expect(parseSynthParam('?synth=circle')).toBe('circle');
    expect(parseSynthParam('?foo=1&synth=logo')).toBe('logo');
    expect(parseSynthParam('synth=flat')).toBe('flat');
    expect(parseSynthParam('?synth=nope')).toBeNull();
    expect(parseSynthParam('')).toBeNull();
  });

  it('builds every fixture as a well-formed RGBA image', () => {
    for (const name of SYNTH_FIXTURES) {
      const { fileName, image } = buildSynthFixture(name);
      expect(fileName).toBe(`synth-${name}.png`);
      expect(image.width).toBeGreaterThanOrEqual(96);
      expect(image.data.length).toBe(image.width * image.height * 4);
    }
  });

  it('gives the sprite a detectable grid and the logo real transparency', () => {
    const sprite = buildSynthFixture('sprite').image;
    expect([sprite.width, sprite.height]).toEqual([128, 128]);
    expect(detectGrid(sprite)).toBeGreaterThanOrEqual(4);
    const logo = buildSynthFixture('logo').image.data;
    let transparent = 0;
    let opaque = 0;
    for (let i = 3; i < logo.length; i += 4) {
      if (logo[i] === 0) transparent++;
      else if (logo[i] === 255) opaque++;
    }
    expect(transparent).toBeGreaterThan(1000);
    expect(opaque).toBeGreaterThan(500);
  });

  it('builds the gradient fixtures at preview size', () => {
    expect(parseSynthParam('?synth=gradient')).toBe('gradient');
    expect(parseSynthParam('?synth=radial')).toBe('radial');
    expect(buildSynthFixture('gradient').image.width).toBe(512);
    expect(buildSynthFixture('radial').image.width).toBe(256);
  });
});

describe('tune summary', () => {
  const plain = (text: string): string => text.replace(/\u00a0/g, ' ');

  it('shows fidelity, corners, nodes and size before and after in one line', () => {
    const baseline = { fidelity: 0.868, cornerFraction: 79 / 1218, nodeCount: 1218, bytes: 41165 };
    const tuned = { fidelity: 0.866, cornerFraction: 3 / 851, nodeCount: 851, bytes: 30310 };
    const line = formatTuneSummary(baseline, tuned);
    expect(plain(line)).toBe('Fidelidad de 86,8 % a 86,6 % · Esquinas de 79 a 3 · Nodos de 1218 a 851 · Tamaño de 40,2 a 29,6 KB');
    // Non-breaking inside each item: a narrow panel only wraps between items.
    expect(line.split(' · ')).toHaveLength(4);
    expect(line.split(' · ').every((item) => !item.includes(' '))).toBe(true);
    expect(line).not.toMatch(/[\n–—]/);
  });

  it('draws every character of the mono line with the self-hosted JetBrains Mono (no fallback glyphs)', () => {
    // The @font-face rules only serve the code points of their unicode-range; anything else (U+2192 is
    // in no subset) comes from ui-monospace / Menlo and does not match the figures around it.
    const require = createRequire(import.meta.url);
    const css = readFileSync(require.resolve('@fontsource-variable/jetbrains-mono/index.css'), 'utf8');
    const ranges: Array<[number, number]> = [];
    for (const face of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      if (!/font-style:\s*normal/.test(face[1])) continue;
      const list = /unicode-range:\s*([^;]+);/.exec(face[1]);
      for (const r of list?.[1].split(',') ?? []) {
        const m = /U\+([0-9a-f]+)(?:-([0-9a-f]+))?/i.exec(r.trim());
        if (m !== null) ranges.push([parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)]);
      }
    }
    expect(ranges.length).toBeGreaterThan(10);
    const lines = [
      formatTuneSummary(
        { fidelity: 0.868, cornerFraction: 79 / 1218, nodeCount: 1218, bytes: 41165 },
        { fidelity: 0.866, cornerFraction: 3 / 851, nodeCount: 851, bytes: 30310 },
      ),
      formatTuneSummary(
        { fidelity: 0.9, cornerFraction: 0.042, nodeCount: 22702, bytes: 1069548 },
        { fidelity: 0.8644, cornerFraction: 68 / 16349, nodeCount: 16349, bytes: 1003520 },
      ),
    ];
    const missing = new Set<string>();
    for (const ch of lines.join('')) {
      const cp = ch.codePointAt(0)!;
      if (!ranges.some(([a, b]) => cp >= a && cp <= b)) missing.add(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
    expect([...missing]).toEqual([]);
  });

  it('an applied tune result is outdated as soon as the parameters no longer trace the same', () => {
    const shown = { params: { mode: 'auto', alphamax: 1.15 } as const, detected: 'lines' as const };
    expect(tuneResultOutdated(null, { alphamax: 0.5 })).toBe(false);
    expect(tuneResultOutdated(shown, { mode: 'auto', alphamax: 1.15 })).toBe(false);
    // Auto resolves to the detected mode, and output-only settings do not change the trace.
    expect(tuneResultOutdated(shown, { mode: 'lines', alphamax: 1.15, optimize: true })).toBe(false);
    expect(tuneResultOutdated(shown, { mode: 'auto', alphamax: 1 })).toBe(true);
    expect(tuneResultOutdated(shown, { mode: 'flat', alphamax: 1.15 })).toBe(true);
  });

  it('counts corners from the fraction and repeats the size unit only when it changes', () => {
    expect(tuneCornerCount({ fidelity: 1, cornerFraction: 1, nodeCount: 30, bytes: 90 })).toBe(30); // pixel mode
    expect(tuneCornerCount({ fidelity: 1, cornerFraction: 0, nodeCount: 0, bytes: 0 })).toBe(0);
    const before = { fidelity: 0.9, cornerFraction: 0.042, nodeCount: 22702, bytes: 1069548 };
    const after = { fidelity: 0.8644, cornerFraction: 68 / 16349, nodeCount: 16349, bytes: 1003520 };
    expect(plain(formatTuneSummary(before, after))).toBe(
      'Fidelidad de 90,0 % a 86,4 % · Esquinas de 953 a 68 · Nodos de 22 702 a 16 349 · Tamaño de 1,02 MB a 980 KB',
    );
  });

  it('describes the search with the budget and the fidelity guard the tuner applies', () => {
    expect(TUNE_FIDELITY_GUARD).toBe(FIDELITY_GUARD);
    expect(TUNE_BUDGET_MS).toBe(3000);
    expect(plain(TUNE_HINT)).toBe(
      'Busca durante 3 s el mejor equilibrio entre fidelidad, esquinas y nodos, sin perder más de 0,5 puntos de fidelidad.',
    );
    expect(TUNE_HINT).not.toMatch(/[\n–—]/);
  });
});
