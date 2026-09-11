import { describe, expect, it } from 'vitest';
import { assembleSvg, rgbToHex } from '../../src/svg/assemble';
import { parsePathData } from '../../src/svg/pathParse';
import { countSegments } from '../../src/svg/pathStats';
import type { AssembleOptions } from '../../src/svg/assemble';
import type { AbsPath, Layer, Seg } from '../../src/types';

const M = (x: number, y: number): Seg => ({ kind: 'M', x, y });
const L = (x: number, y: number): Seg => ({ kind: 'L', x, y });
const Z: Seg = { kind: 'Z' };

const SQUARE: AbsPath = { segs: [M(16, 16), L(48, 16), L(48, 48), L(16, 48), Z] };
const HOLE: AbsPath = { segs: [M(24, 24), L(24, 40), L(40, 40), L(40, 24), Z] };
const BASE: AssembleOptions = { width: 16, height: 16, viewBoxWidth: 64, viewBoxHeight: 64 };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

describe('assembleSvg — document structure', () => {
  it('starts with the exact <svg> header (original size, upscaled viewBox) and ends with </svg>', () => {
    const svg = assembleSvg([{ fill: '#000000', paths: [SQUARE] }], BASE);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="16" height="16" viewBox="0 0 64 64">/);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).not.toMatch(/<\?xml/);
    expect((svg.match(/<svg/g) ?? []).length).toBe(1);
    expect((svg.match(/<\/svg>/g) ?? []).length).toBe(1);
  });

  it('adds shape-rendering="crispEdges" right after the viewBox when requested', () => {
    const svg = assembleSvg([{ fill: '#000000', paths: [SQUARE] }], { ...BASE, crispEdges: true });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="16" height="16" viewBox="0 0 64 64" shape-rendering="crispEdges">/);
    const plain = assembleSvg([{ fill: '#000000', paths: [SQUARE] }], { ...BASE, crispEdges: false });
    expect(plain).not.toMatch(/shape-rendering/);
  });

  it('emits one <path> per non-empty layer, in order, each on its own line', () => {
    const layers: Layer[] = [
      { fill: '#112233', paths: [SQUARE] },
      { fill: '#445566', paths: [] },
      { fill: '#778899', paths: [{ segs: [] }] },
      { fill: '#aabbcc', paths: [HOLE] },
    ];
    const svg = assembleSvg(layers, BASE);
    const paths = svg.match(/<path [^>]*\/>/g) ?? [];
    expect(paths.length).toBe(2);
    expect(paths[0]).toMatch(/^<path fill="#112233" d="/);
    expect(paths[1]).toMatch(/^<path fill="#aabbcc" d="/);
    expect(svg.indexOf('#112233')).toBeLessThan(svg.indexOf('#aabbcc'));
    expect(svg.split('\n')).toEqual([
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 64 64">',
      '<path fill="#112233" d="M16 16L48 16 48 48 16 48Z"/>',
      '<path fill="#aabbcc" d="M24 24L24 40 40 40 40 24Z"/>',
      '</svg>',
    ]);
  });

  it('no layers → header + closing tag only', () => {
    expect(assembleSvg([], BASE)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 64 64">\n</svg>',
    );
  });
});

describe('assembleSvg — background rect', () => {
  it('inserts <rect> with the background colour and viewBox size before the first path', () => {
    const svg = assembleSvg([{ fill: '#000000', paths: [SQUARE] }], { ...BASE, background: [255, 255, 255] });
    expect(svg).toMatch(/^<svg [^>]*>\n<rect fill="#ffffff" width="64" height="64"\/>\n<path /);
    expect((svg.match(/<rect/g) ?? []).length).toBe(1);
  });

  it('omits the rect when background is null or undefined', () => {
    expect(assembleSvg([{ fill: '#000000', paths: [SQUARE] }], { ...BASE, background: null })).not.toMatch(/<rect/);
    expect(assembleSvg([{ fill: '#000000', paths: [SQUARE] }], BASE)).not.toMatch(/<rect/);
  });

  it('rgbToHex is lower-case, zero-padded, rounded and clamped', () => {
    expect(rgbToHex([255, 255, 255])).toBe('#ffffff');
    expect(rgbToHex([0, 0, 0])).toBe('#000000');
    expect(rgbToHex([242, 232, 213])).toBe('#f2e8d5');
    expect(rgbToHex([10, 2, 171])).toBe('#0a02ab');
    expect(rgbToHex([254.6, -3, 300])).toBe('#ff00ff');
  });
});

describe('assembleSvg — path attributes', () => {
  it('orders attributes fill, fill-opacity, fill-rule, d', () => {
    const layers: Layer[] = [{ fill: '#ff0000', opacity: 0.5, paths: [SQUARE, HOLE] }];
    const svg = assembleSvg(layers, BASE);
    expect(svg).toMatch(/<path fill="#ff0000" fill-opacity="0.5" fill-rule="evenodd" d="M16 16L48 16 48 48 16 48ZM24 24L24 40 40 40 40 24Z"\/>/);
  });

  it('fill-rule="evenodd" only when the layer has more than one subpath', () => {
    const one = assembleSvg([{ fill: '#000000', paths: [SQUARE] }], BASE);
    expect(one).not.toMatch(/fill-rule/);
    const twoPaths = assembleSvg([{ fill: '#000000', paths: [SQUARE, HOLE] }], BASE);
    expect(twoPaths).toMatch(/<path fill="#000000" fill-rule="evenodd" d="/);
    const twoSubpathsOnePath = assembleSvg(
      [{ fill: '#000000', paths: [{ segs: [...SQUARE.segs, ...HOLE.segs] }] }],
      BASE,
    );
    expect(twoSubpathsOnePath).toMatch(/<path fill="#000000" fill-rule="evenodd" d="/);
    // two layers with one subpath each: no evenodd anywhere
    const twoLayers = assembleSvg(
      [
        { fill: '#000000', paths: [SQUARE] },
        { fill: '#ffffff', paths: [HOLE] },
      ],
      BASE,
    );
    expect(twoLayers).not.toMatch(/fill-rule/);
  });

  it('fill-opacity only when opacity is defined and < 1; clamped to [0,1]', () => {
    const at = (opacity: number | undefined): string =>
      assembleSvg([{ fill: '#000000', opacity, paths: [SQUARE] }], BASE);
    expect(at(undefined)).not.toMatch(/fill-opacity/);
    expect(at(1)).not.toMatch(/fill-opacity/);
    expect(at(1.5)).not.toMatch(/fill-opacity/);
    expect(at(0.5)).toMatch(/ fill-opacity="0.5" /);
    expect(at(0.25)).toMatch(/ fill-opacity="0.25" /);
    expect(at(1 / 3)).toMatch(/ fill-opacity="0.3333" /);
    expect(at(0)).toMatch(/ fill-opacity="0" /);
    expect(at(-0.2)).toMatch(/ fill-opacity="0" /);
  });

  it('uses the given precision for d and dimensions (default 3)', () => {
    const p: AbsPath = { segs: [M(1.23456, 2.34567), L(3.45678, 4.56789), Z] };
    const two = assembleSvg([{ fill: '#000000', paths: [p] }], { ...BASE, viewBoxWidth: 64.12345, precision: 2 });
    expect(two).toMatch(/viewBox="0 0 64.12 64"/);
    expect(two).toMatch(/ d="M1.23 2.35L3.46 4.57Z"\/>/);
    const three = assembleSvg([{ fill: '#000000', paths: [p] }], BASE);
    expect(three).toMatch(/ d="M1.235 2.346L3.457 4.568Z"\/>/);
    const zero = assembleSvg([{ fill: '#000000', paths: [p] }], { ...BASE, precision: 0 });
    expect(zero).toMatch(/ d="M1 2L3 5Z"\/>/);
  });

  it('escapes characters that would break the attribute in a hostile fill string', () => {
    const svg = assembleSvg([{ fill: 'url("#g")<&', paths: [SQUARE] }], BASE);
    expect(svg).toMatch(/<path fill="url\(&quot;#g&quot;\)&lt;&amp;" d="/);
  });

  it('concatenated d of a layer keeps the total segment count of its paths', () => {
    const a = parsePathData('M40 80 l0 -40 40 0 40 0 0 40 0 40 -40 0 -40 0 0 -40z');
    const b = parsePathData('M252 509 c-48 -14 -109 -80 -123 -131 -23 -89 12 -182 88 -229 z');
    const svg = assembleSvg([{ fill: '#000000', paths: [a, b] }], { width: 100, height: 100, viewBoxWidth: 600, viewBoxHeight: 600 });
    const d = /<path [^>]* d="([^"]*)"/.exec(svg)?.[1] ?? '';
    expect(countSegments(d)).toEqual({ lines: 8, curves: 2, moves: 2 });
    expect(svg).toMatch(new RegExp(escapeRe(' fill-rule="evenodd" d="')));
  });

  it('never leaks "undefined"/"NaN" and does not mutate the layers', () => {
    const layers: Layer[] = [{ fill: '#000000', opacity: 0.5, paths: [SQUARE, HOLE] }];
    const before = JSON.stringify(layers);
    const svg = assembleSvg(layers, { ...BASE, background: [1, 2, 3], crispEdges: true });
    expect(svg).not.toMatch(/undefined|NaN|null/);
    expect(JSON.stringify(layers)).toBe(before);
    // every element is self-closing or the closing tag, and quotes are balanced
    for (const line of svg.split('\n').slice(1, -1)) {
      expect(line).toMatch(/^<(rect|path) [^<>]*\/>$/);
      expect((line.match(/"/g) ?? []).length % 2).toBe(0);
    }
  });
});
