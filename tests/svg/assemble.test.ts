import { describe, expect, it } from 'vitest';
import { assembleSvg, gradientIdPrefix, rgbToHex } from '../../src/svg/assemble';
import { parsePathData } from '../../src/svg/pathParse';
import { countSegments } from '../../src/svg/pathStats';
import type { AssembleOptions } from '../../src/svg/assemble';
import type { AbsPath, Gradient, Layer, LinearGradient, RadialGradient, Seg } from '../../src/types';

const M = (x: number, y: number): Seg => ({ kind: 'M', x, y });
const L = (x: number, y: number): Seg => ({ kind: 'L', x, y });
const Z: Seg = { kind: 'Z' };

const SQUARE: AbsPath = { segs: [M(16, 16), L(48, 16), L(48, 48), L(16, 48), Z] };
const HOLE: AbsPath = { segs: [M(24, 24), L(24, 40), L(40, 40), L(40, 24), Z] };
const BASE: AssembleOptions = { width: 16, height: 16, viewBoxWidth: 64, viewBoxHeight: 64 };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The document with its gradient ids g<h>-<n> written as g<n>, after checking that h is gradientIdPrefix of exactly that
 * document (the ids are a function of the output with plain ids).
 */
function plainIds(svg: string): string {
  const m = /<(?:linear|radial)Gradient id="g([0-9a-z]+)-0"/.exec(svg);
  if (m === null) return svg;
  const plain = svg.split(`g${m[1]}-`).join('g');
  expect(gradientIdPrefix(plain)).toBe(m[1]);
  return plain;
}

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

describe('assembleSvg — gradients', () => {
  const LIN: LinearGradient = {
    kind: 'linear',
    x1: 16,
    y1: 16,
    x2: 48.12345,
    y2: 47.5,
    stops: [
      { offset: 0, color: [254, 218, 117] },
      { offset: 1, color: [150, 47, 191] },
    ],
  };
  const RAD: RadialGradient = {
    kind: 'radial',
    cx: 32,
    cy: 32.0004,
    r: 16,
    stops: [
      { offset: 0, color: [255, 255, 255] },
      { offset: 0.5, color: [214, 41, 118] },
      { offset: 1, color: [0, 0, 0] },
    ],
  };
  const LIN_LINE =
    '<linearGradient id="g0" gradientUnits="userSpaceOnUse" x1="16" y1="16" x2="48.123" y2="47.5">' +
    '<stop offset="0" stop-color="#feda75"/><stop offset="1" stop-color="#962fbf"/></linearGradient>';
  const RAD_LINE =
    '<radialGradient id="g1" gradientUnits="userSpaceOnUse" cx="32" cy="32" r="16">' +
    '<stop offset="0" stop-color="#ffffff"/><stop offset="0.5" stop-color="#d62976"/><stop offset="1" stop-color="#000000"/></radialGradient>';

  it('<defs> right after <svg> and before the background rect; url(#gN) fills; attribute order fill, fill-opacity, fill-rule, d', () => {
    const layers: Layer[] = [
      { fill: '#c8a098', gradient: LIN, paths: [SQUARE] },
      { fill: '#112233', paths: [HOLE] },
      { fill: '#6b4a5c', gradient: RAD, opacity: 0.5, paths: [SQUARE, HOLE] },
    ];
    const svg = plainIds(assembleSvg(layers, { ...BASE, background: [255, 255, 255] }));
    expect(svg.split('\n')).toEqual([
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 64 64">',
      '<defs>',
      LIN_LINE,
      RAD_LINE,
      '</defs>',
      '<rect fill="#ffffff" width="64" height="64"/>',
      '<path fill="url(#g0)" d="M16 16L48 16 48 48 16 48Z"/>',
      '<path fill="#112233" d="M24 24L24 40 40 40 40 24Z"/>',
      '<path fill="url(#g1)" fill-opacity="0.5" fill-rule="evenodd" d="M16 16L48 16 48 48 16 48ZM24 24L24 40 40 40 40 24Z"/>',
      '</svg>',
    ]);
  });

  it('with crispEdges the <defs> follow the complete opening tag', () => {
    const svg = plainIds(assembleSvg([{ fill: '#000000', gradient: LIN, paths: [SQUARE] }], { ...BASE, crispEdges: true }));
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 64 64" shape-rendering="crispEdges">\n<defs>\n<linearGradient id="g0" ')).toBe(true);
  });

  it('ids g<h>-0, g<h>-1… count only drawn layers with a non-degenerate gradient, in layer order', () => {
    const oneStop: LinearGradient = { ...LIN, stops: [LIN.stops[0]] };
    const layers: Layer[] = [
      { fill: '#010101', gradient: LIN, paths: [] },
      { fill: '#aa0000', gradient: oneStop, paths: [SQUARE] },
      { fill: '#020202', gradient: RAD, paths: [HOLE] },
      { fill: '#030303', gradient: LIN, paths: [{ segs: [] }] },
      { fill: '#040404', gradient: LIN, paths: [SQUARE] },
    ];
    const svg = plainIds(assembleSvg(layers, BASE));
    expect((svg.match(/<defs>/g) ?? []).length).toBe(1);
    expect(svg.match(/<(linear|radial)Gradient id="g\d+"/g)).toEqual(['<radialGradient id="g0"', '<linearGradient id="g1"']);
    expect(svg.match(/<path fill="[^"]*"/g)).toEqual(['<path fill="#aa0000"', '<path fill="url(#g0)"', '<path fill="url(#g1)"']);
  });

  it('degenerate gradients fall back to layer.fill: all degenerate → byte-identical to the layers without them', () => {
    const degenerate: Gradient[] = [
      { ...LIN, stops: [] },
      { ...LIN, stops: [LIN.stops[1]] },
      { ...LIN, x2: 16, y2: 16 },
      { ...LIN, x1: Number.NaN },
      { ...RAD, r: 0 },
      { ...RAD, r: -3 },
      { ...RAD, r: Number.POSITIVE_INFINITY },
      { ...RAD, stops: [{ offset: 0, color: [10, 10, 10] }, { offset: 1, color: [11, 10.5, 10] }] },
    ];
    const opts: AssembleOptions = { ...BASE, background: [1, 2, 3], crispEdges: true };
    const plain = assembleSvg([{ fill: '#123456', opacity: 0.25, paths: [SQUARE, HOLE] }], opts);
    for (const g of degenerate) {
      expect(assembleSvg([{ fill: '#123456', gradient: g, opacity: 0.25, paths: [SQUARE, HOLE] }], opts)).toBe(plain);
    }
    // a degenerate layer next to a real one keeps its escaped flat fill
    const mixed = plainIds(
      assembleSvg(
        [
          { fill: 'url("#x")<&', gradient: degenerate[2], paths: [SQUARE] },
          { fill: 'ignored', gradient: RAD, paths: [HOLE] },
        ],
        BASE,
      ),
    );
    expect(mixed).toMatch(/<path fill="url\(&quot;#x&quot;\)&lt;&amp;" d="/);
    expect(mixed).toMatch(/<path fill="url\(#g0\)" d="/);
    expect(mixed).not.toContain('ignored');
  });

  it('two different documents never share a gradient id; the same layers always get the same ids', () => {
    const other: LinearGradient = { ...LIN, stops: [{ offset: 0, color: [1, 2, 3] }, { offset: 1, color: [200, 100, 50] }] };
    const a = assembleSvg([{ fill: '#000000', gradient: LIN, paths: [SQUARE] }, { fill: '#000000', gradient: RAD, paths: [HOLE] }], BASE);
    const b = assembleSvg([{ fill: '#000000', gradient: other, paths: [SQUARE] }], BASE);
    const ids = (svg: string): string[] => [...svg.matchAll(/<(?:linear|radial)Gradient id="([^"]+)"/g)].map((m) => m[1]);
    const idsA = ids(a);
    const idsB = ids(b);
    expect(idsA).toHaveLength(2);
    expect(idsB).toHaveLength(1);
    for (const id of [...idsA, ...idsB]) expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect(new Set(idsA).size).toBe(2);
    // every reference points at an id of its own document
    for (const [svg, own] of [[a, idsA], [b, idsB]] as const) {
      for (const m of svg.matchAll(/fill="url\(#([^)]+)\)"/g)) expect(own).toContain(m[1]);
    }
    expect(assembleSvg([{ fill: '#000000', gradient: LIN, paths: [SQUARE] }, { fill: '#000000', gradient: RAD, paths: [HOLE] }], BASE)).toBe(a);
  });

  it('without gradients the output is byte-identical whether or not the key is present', () => {
    const layers: Layer[] = [
      { fill: '#112233', opacity: 0.5, paths: [SQUARE, HOLE] },
      { fill: '#445566', paths: [] },
      { fill: '#aabbcc', paths: [HOLE] },
    ];
    const withKey: Layer[] = layers.map((l) => ({ ...l, gradient: undefined }));
    const opts: AssembleOptions = { ...BASE, background: [9, 8, 7], precision: 2 };
    const svg = assembleSvg(withKey, opts);
    expect(svg).toBe(assembleSvg(layers, opts));
    expect(svg).not.toMatch(/<defs|url\(/);
  });

  it('gradient coordinates use the same precision as the path data; offsets keep 4 decimals', () => {
    const g: LinearGradient = { ...LIN, x1: 1.23456, stops: [{ offset: 1 / 3, color: [0, 0, 0] }, { offset: 1, color: [9, 9, 9] }] };
    const p: AbsPath = { segs: [M(1.23456, 2.34567), L(3.45678, 4.56789), Z] };
    const two = assembleSvg([{ fill: '#000000', gradient: g, paths: [p] }], { ...BASE, precision: 2 });
    expect(two).toContain(' x1="1.23" y1="16" x2="48.12" y2="47.5"><stop offset="0.3333" ');
    expect(two).toContain(' d="M1.23 2.35L3.46 4.57Z"/>');
    const zero = assembleSvg([{ fill: '#000000', gradient: g, paths: [p] }], { ...BASE, precision: 0 });
    expect(zero).toContain(' x1="1" y1="16" x2="48" y2="48"><stop offset="0.3333" ');
    expect(zero).toContain(' d="M1 2L3 5Z"/>');
  });

  it('never leaks "undefined"/"NaN", keeps one element per line and does not mutate layers or gradients', () => {
    const messy: LinearGradient = {
      ...LIN,
      stops: [
        { offset: 0.9, color: [1, 2, 3] },
        { offset: -0.2, color: [300, 5, 6] },
        { offset: 0.9, color: [7, 8, 9] },
      ],
    };
    const layers: Layer[] = [
      { fill: '#000000', gradient: messy, opacity: 0.5, paths: [SQUARE, HOLE] },
      { fill: '#ffffff', paths: [HOLE] },
      { fill: '#808080', gradient: RAD, paths: [SQUARE] },
    ];
    const before = JSON.stringify(layers);
    const svg = plainIds(assembleSvg(layers, { ...BASE, background: [1, 2, 3], crispEdges: true }));
    expect(svg).not.toMatch(/undefined|NaN|null/);
    expect(JSON.stringify(layers)).toBe(before);
    const lines = svg.split('\n').slice(1, -1);
    expect(lines[0]).toBe('<defs>');
    expect(lines[3]).toBe('</defs>');
    for (const line of lines.slice(1, 3)) {
      expect(line).toMatch(/^<(linear|radial)Gradient id="g\d" gradientUnits="userSpaceOnUse" [^<>]*>(<stop offset="[\d.]+" stop-color="#[0-9a-f]{6}"\/>)+<\/(linear|radial)Gradient>$/);
    }
    for (const line of lines.slice(4)) {
      expect(line).toMatch(/^<(rect|path) [^<>]*\/>$/);
      expect((line.match(/"/g) ?? []).length % 2).toBe(0);
    }
    // normalizeStops on the way out: -0.2 is raised to 0.9, and of the three stops at 0.9 the first and the last stay
    expect(lines[1].match(/offset="[^"]*" stop-color="[^"]*"/g)).toEqual(['offset="0.9" stop-color="#010203"', 'offset="0.9" stop-color="#070809"']);
  });
});
