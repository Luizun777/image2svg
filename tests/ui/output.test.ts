import { describe, expect, it } from 'vitest';
import { assembleSvg } from '../../src/svg/assemble';
import { gradientMeanHex } from '../../src/svg/gradients';
import type { AbsPath, Layer, LinearGradient, RadialGradient } from '../../src/types';
import { SVGO_CONFIG, optimizeSvg, svgDataUrl, svgFileName } from '../../src/ui/output';
import { parseSvg } from '../fixtures/svgBack';

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

  it('keeps the gradient <defs>: ids g<h>-0 and g<h>-1, userSpaceOnUse, the same stops and matching url(#…) references', async () => {
    const linear: LinearGradient = {
      kind: 'linear',
      x1: 16.123456,
      y1: 20,
      x2: 48,
      y2: 40.5,
      stops: [
        { offset: 0, color: [254, 218, 117] },
        { offset: 0.35, color: [214, 41, 118] },
        { offset: 1, color: [150, 47, 191] },
      ],
    };
    // #ffffff comes back as #fff (convertColors): parseSvg reads both forms
    const radial: RadialGradient = {
      kind: 'radial',
      cx: 32,
      cy: 30,
      r: 12.5,
      stops: [
        { offset: 0, color: [26, 43, 60] },
        { offset: 1, color: [255, 255, 255] },
      ],
    };
    const gradientLayers: Layer[] = [
      { fill: gradientMeanHex(linear), gradient: linear, paths: [square] },
      { fill: '#2a6f97', paths: [triangle] },
      { fill: gradientMeanHex(radial), gradient: radial, paths: [triangle] },
    ];
    const svg = assembleSvg(gradientLayers, { width: 16, height: 16, viewBoxWidth: 64, viewBoxHeight: 64, precision: 6 });
    const out = await optimizeSvg(svg);
    const pre = /id="(g[0-9a-z]+)-0"/.exec(svg)?.[1] ?? '';
    expect(pre).toMatch(/^g[0-9a-z]+$/);
    expect(out).toMatch(/<defs>/);
    expect(out).toMatch(new RegExp(`<linearGradient\\b[^>]*\\sid="${pre}-0"`));
    expect(out).toMatch(new RegExp(`<radialGradient\\b[^>]*\\sid="${pre}-1"`));
    expect(out.match(/gradientUnits="userSpaceOnUse"/g)?.length).toBe(2);
    expect(out).not.toMatch(/gradientTransform|\sfx=|\sfy=/);
    expect(out.split(`fill="url(#${pre}-0)"`).length - 1).toBe(1);
    expect(out.split(`fill="url(#${pre}-1)"`).length - 1).toBe(1);
    expect(out.match(/<path\b/g)?.length).toBe(3);

    const before = parseSvg(svg).layers;
    const after = parseSvg(out).layers;
    expect(after.map((l) => l.gradient?.kind ?? l.fill)).toEqual(['linear', '#2a6f97', 'radial']);
    for (const i of [0, 2]) {
      const a = after[i].gradient;
      const b = before[i].gradient;
      expect(a?.stops).toEqual(b?.stops);
      expect(after[i].fill).toBe(before[i].fill);
      if (a?.kind === 'linear' && b?.kind === 'linear') {
        for (const k of ['x1', 'y1', 'x2', 'y2'] as const) expect(Math.abs(a[k] - b[k])).toBeLessThanOrEqual(1e-4);
      } else if (a?.kind === 'radial' && b?.kind === 'radial') {
        for (const k of ['cx', 'cy', 'r'] as const) expect(Math.abs(a[k] - b[k])).toBeLessThanOrEqual(1e-4);
      } else {
        expect.unreachable(`layer ${i}: ${a?.kind} vs ${b?.kind}`);
      }
    }
  });

  it('SVGO_CONFIG is the single configuration: preset-default with mergePaths and cleanupIds off, 4 decimals', () => {
    expect(SVGO_CONFIG).toEqual({
      multipass: false,
      floatPrecision: 4,
      plugins: [{ name: 'preset-default', params: { floatPrecision: 4, overrides: { mergePaths: false, cleanupIds: false } } }],
    });
  });
});
