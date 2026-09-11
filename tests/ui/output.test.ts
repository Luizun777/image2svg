import { describe, expect, it } from 'vitest';
import { assembleSvg } from '../../src/svg/assemble';
import type { AbsPath, Layer } from '../../src/types';
import { optimizeSvg, svgDataUrl, svgFileName } from '../../src/ui/output';

const PREFIX = 'data:image/svg+xml;charset=utf-8,';

describe('svgDataUrl', () => {
  it('percent-encodes the markup so # and quotes cannot break the URL', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4">' +
      '<path fill="#e11d48" d="M0 0h4v4H0z"/></svg>';
    const url = svgDataUrl(svg);
    expect(url.startsWith(PREFIX)).toBe(true);
    const payload = url.slice(PREFIX.length);
    expect(payload).not.toMatch(/[#"<>\s]/);
    expect(decodeURIComponent(payload)).toBe(svg);
  });
});

describe('svgFileName', () => {
  it('replaces the extension with .svg', () => {
    expect(svgFileName('logo.png')).toBe('logo.svg');
    expect(svgFileName('foto.final.JPG')).toBe('foto.final.svg');
    expect(svgFileName('synth-circle.png')).toBe('synth-circle.svg');
    expect(svgFileName('imagen-pegada')).toBe('imagen-pegada.svg');
  });

  it('sanitises characters that file systems reject', () => {
    expect(svgFileName('a:b*c?.png')).toBe('a-b-c.svg');
    expect(svgFileName(`a${String.fromCharCode(7)}b.png`)).toBe('a-b.svg');
  });

  it('falls back to imagen.svg for empty names', () => {
    expect(svgFileName('')).toBe('imagen.svg');
    expect(svgFileName('   ')).toBe('imagen.svg');
    expect(svgFileName('???.png')).toBe('imagen.svg');
  });
});

describe('optimizeSvg', () => {
  const square: AbsPath = {
    segs: [
      { kind: 'M', x: 16.123456, y: 16 },
      { kind: 'L', x: 48, y: 16 },
      { kind: 'L', x: 48, y: 48 },
      { kind: 'L', x: 16, y: 48 },
      { kind: 'Z' },
    ],
  };
  const triangle: AbsPath = {
    segs: [
      { kind: 'M', x: 20, y: 20 },
      { kind: 'L', x: 30, y: 20 },
      { kind: 'L', x: 30, y: 30 },
      { kind: 'Z' },
    ],
  };
  const layers: Layer[] = [
    { fill: '#2a6f97', paths: [square] },
    { fill: '#2a6f97', paths: [triangle] },
  ];

  it('keeps width, height, viewBox and one path per layer; rounds to 4 decimals', async () => {
    const svg = assembleSvg(layers, {
      width: 16,
      height: 16,
      viewBoxWidth: 64,
      viewBoxHeight: 64,
      precision: 6,
      background: [255, 255, 255],
    });
    expect(svg).toContain('16.123456');
    const out = await optimizeSvg(svg);
    expect(out).toContain('viewBox="0 0 64 64"');
    expect(out).toContain('width="16"');
    expect(out).toContain('height="16"');
    // background rect (converted to a path) + two layers that mergePaths would have fused
    expect(out.match(/<path\b/g)?.length).toBe(3);
    expect(out).not.toMatch(/\d\.\d{5,}/);
    expect(out).toContain('16.1235');
  });
});
