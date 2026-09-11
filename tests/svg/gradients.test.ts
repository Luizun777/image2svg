import { describe, expect, it } from 'vitest';
import { assembleSvg, rgbToHex as rgbToHexFromAssemble } from '../../src/svg/assemble';
import { gradientMeanHex, rgbToHex, serializeGradient } from '../../src/svg/gradients';
import { extractPaths } from '../../src/tracers/svgParse';
import { renderLayersAt1x } from '../../src/tuner/autotune';
import { parseSvg, renderAt1x } from '../fixtures/svgBack';
import type { AbsPath, Gradient, Layer, LinearGradient, RadialGradient, RGB, Seg } from '../../src/types';

type StopSpec = Array<[number, RGB]>;

const lin = (x1: number, y1: number, x2: number, y2: number, stops: StopSpec): LinearGradient => ({
  kind: 'linear',
  x1,
  y1,
  x2,
  y2,
  stops: stops.map(([offset, color]) => ({ offset, color })),
});

const rad = (cx: number, cy: number, r: number, stops: StopSpec): RadialGradient => ({
  kind: 'radial',
  cx,
  cy,
  r,
  stops: stops.map(([offset, color]) => ({ offset, color })),
});

const M = (x: number, y: number): Seg => ({ kind: 'M', x, y });
const L = (x: number, y: number): Seg => ({ kind: 'L', x, y });
const Z: Seg = { kind: 'Z' };
const SQUARE: AbsPath = { segs: [M(16, 16), L(48, 16), L(48, 48), L(16, 48), Z] };
const HOLE: AbsPath = { segs: [M(24, 24), L(24, 40), L(40, 40), L(40, 24), Z] };

describe('serializeGradient', () => {
  it('linear: one-line element with userSpaceOnUse, coordinates at the given precision, hex stops', () => {
    const g = lin(1.23456, 2, 30.5, 40.0004, [
      [0, [254, 218, 117]],
      [1, [150, 47, 191]],
    ]);
    expect(serializeGradient(g, 'g0', 3)).toBe(
      '<linearGradient id="g0" gradientUnits="userSpaceOnUse" x1="1.235" y1="2" x2="30.5" y2="40">' +
        '<stop offset="0" stop-color="#feda75"/><stop offset="1" stop-color="#962fbf"/></linearGradient>',
    );
  });

  it('radial: cx, cy and r only (no fx/fy), negative coordinates without "-0"', () => {
    const g = rad(64.5, -3.25, 20.0001, [
      [0, [255, 255, 255]],
      [0.35, [214, 41, 118]],
      [1, [0, 0, 0]],
    ]);
    expect(serializeGradient(g, 'g12', 2)).toBe(
      '<radialGradient id="g12" gradientUnits="userSpaceOnUse" cx="64.5" cy="-3.25" r="20">' +
        '<stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#d62976"/>' +
        '<stop offset="1" stop-color="#000000"/></radialGradient>',
    );
    expect(serializeGradient(rad(-0.0001, 0.4, 1.6, [[0, [0, 0, 0]], [1, [9, 9, 9]]]), 'r', 0)).toMatch(
      /^<radialGradient id="r" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2">/,
    );
  });

  it('stops go through normalizeStops: clamped, raised to non-decreasing, a run at one offset keeps its first and last stop; offsets <= 4 decimals, colours rounded and clamped', () => {
    const g = lin(0, 0, 10, 0, [
      [-0.5, [300, -4, 12.4]],
      [1 / 3, [10, 20, 30]],
      [0.2, [1, 2, 3]],
      [0.2, [4, 5, 6]],
      [1.7, [254.5, 0.49, 127.5]],
    ]);
    const stops = serializeGradient(g, 'g0', 3).match(/<stop [^>]*\/>/g);
    expect(stops).toEqual([
      '<stop offset="0" stop-color="#ff000c"/>',
      '<stop offset="0.3333" stop-color="#0a141e"/>',
      '<stop offset="0.3333" stop-color="#040506"/>',
      '<stop offset="1" stop-color="#ff0080"/>',
    ]);
    const nan = serializeGradient(lin(0, 0, 1, 1, [[Number.NaN, [1, 1, 1]], [0.99996, [2, 2, 2]]]), 'g1', 3);
    expect(nan.match(/offset="[^"]*"/g)).toEqual(['offset="0"', 'offset="1"']);
    const tiny = serializeGradient(lin(0, 0, 1, 1, [[0.00004, [1, 1, 1]], [0.123456, [2, 2, 2]]]), 'g2', 3);
    expect(tiny.match(/offset="[^"]*"/g)).toEqual(['offset="0"', 'offset="0.1235"']);
  });

  it('never writes gradientTransform, fx, fy, spreadMethod or a line break, and does not mutate the gradient', () => {
    const gradients: Gradient[] = [
      lin(3, 4, 5, 6, [[0.9, [1, 2, 3]], [0.1, [400, 5, 6]]]),
      rad(3, 4, 5, [[0, [1, 2, 3]], [1, [4, 5, 6]]]),
    ];
    for (const g of gradients) {
      const before = JSON.stringify(g);
      const s = serializeGradient(g, 'g0', 3);
      expect(s).not.toMatch(/gradientTransform|\sfx=|\sfy=|spreadMethod|\n|undefined|NaN/);
      expect(JSON.stringify(g)).toBe(before);
    }
  });

  it('rejects ids that are not XML names and non-finite coordinates', () => {
    const g = lin(0, 0, 8, 0, [[0, [0, 0, 0]], [1, [255, 255, 255]]]);
    for (const bad of ['', '1g', 'a b', 'g"0', 'g>0', 'url(#g0)', 'ns:g0']) {
      expect(() => serializeGradient(g, bad, 3)).toThrow(/invalid id/);
    }
    for (const good of ['g0', '_x', 'grad-1.a']) expect(serializeGradient(g, good, 3)).toContain(`id="${good}"`);
    expect(() => serializeGradient({ ...g, x2: Number.NaN }, 'g0', 3)).toThrow(/non-finite/);
    expect(() => serializeGradient(rad(0, 0, Number.POSITIVE_INFINITY, g.stops.map((s) => [s.offset, s.color])), 'g0', 3)).toThrow(
      /non-finite/,
    );
  });
});

describe('gradientMeanHex and rgbToHex', () => {
  it('hex of the ramp mean: constant ends, trapezoids between stops', () => {
    expect(gradientMeanHex(lin(0, 0, 1, 0, [[0, [0, 0, 0]], [1, [255, 255, 255]]]))).toBe('#808080'); // 127.5 rounds up
    const tent: StopSpec = [
      [0, [0, 0, 0]],
      [0.5, [200, 100, 50]],
      [1, [0, 0, 0]],
    ];
    expect(gradientMeanHex(lin(0, 0, 1, 0, tent))).toBe('#643219'); // (100, 50, 25)
    expect(gradientMeanHex(rad(0, 0, 1, tent))).toBe('#643219');
    expect(gradientMeanHex(lin(0, 0, 1, 0, [[0.25, [40, 0, 0]], [1, [200, 0, 0]]]))).toBe('#640000'); // 0.25·40 + 0.75·120
    expect(gradientMeanHex(rad(0, 0, 1, []))).toBe('#000000');
  });

  it('assemble.ts re-exports the same rgbToHex', () => {
    expect(rgbToHexFromAssemble).toBe(rgbToHex);
    expect(rgbToHex([254.6, -3, 300])).toBe('#ff00ff');
  });
});

describe('parseSvg reads the gradients back', () => {
  const within = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

  it('round trip parseSvg(assembleSvg(layers)): coordinates and offsets within 1e-3, colours exact, fill = mean hex', () => {
    const g1 = lin(3.14159, 60.5, 100.0004, -2.5, [
      [0, [254, 218, 117]],
      [0.41237, [214, 41, 118]],
      [1, [150, 47, 191]],
    ]);
    const g2 = rad(50.123456, 49.9996, 33.3333, [
      [0, [255, 255, 255]],
      [0.123456, [10, 200, 30]],
      [1, [0, 0, 128]],
    ]);
    const g3 = lin(0.0004, 7.77777, 64, 63.9995, [
      [0.25, [0, 128, 255]],
      [0.5, [1, 2, 3]],
      [0.75, [200, 100, 0]],
    ]);
    const layers: Layer[] = [
      { fill: '#112233', paths: [SQUARE] },
      { fill: gradientMeanHex(g1), gradient: g1, paths: [SQUARE] },
      { fill: gradientMeanHex(g2), gradient: g2, paths: [HOLE] },
      { fill: '#aabbcc', paths: [HOLE] },
      { fill: gradientMeanHex(g3), gradient: g3, paths: [SQUARE, HOLE] },
    ];
    const svg = assembleSvg(layers, { width: 16, height: 16, viewBoxWidth: 64, viewBoxHeight: 64, background: [255, 255, 255] });
    const parsed = parseSvg(svg);
    expect(parsed.layers).toHaveLength(layers.length);
    for (let i = 0; i < layers.length; i++) {
      const want = layers[i];
      const got = parsed.layers[i];
      expect(got.fill).toBe(want.fill);
      const wg = want.gradient;
      if (wg === undefined) {
        expect(got.gradient).toBeUndefined();
        continue;
      }
      const gg = got.gradient;
      expect(gg?.kind).toBe(wg.kind);
      if (gg === undefined) continue;
      if (wg.kind === 'linear' && gg.kind === 'linear') {
        for (const k of ['x1', 'y1', 'x2', 'y2'] as const) expect(within(gg[k], wg[k], 1e-3), `${i}.${k}`).toBe(true);
      } else if (wg.kind === 'radial' && gg.kind === 'radial') {
        for (const k of ['cx', 'cy', 'r'] as const) expect(within(gg[k], wg[k], 1e-3), `${i}.${k}`).toBe(true);
      }
      expect(gg.stops).toHaveLength(wg.stops.length);
      for (let s = 0; s < wg.stops.length; s++) {
        expect(within(gg.stops[s].offset, wg.stops[s].offset, 1e-3), `${i}.stop${s}`).toBe(true);
        expect(gg.stops[s].color).toEqual(wg.stops[s].color);
      }
    }
    // one parsed path per <path> element: the two-subpath layer comes back as one path with two M
    expect(parsed.paths).toHaveLength(5);
    expect(parsed.paths[4].segs.filter((seg) => seg.kind === 'M')).toHaveLength(2);
  });

  it('a hard stop survives the SVG: 4 stops written, the parsed render equals renderLayersAt1x of the layers', () => {
    const hard: LinearGradient = {
      kind: 'linear',
      x1: 0,
      y1: 0,
      x2: 256,
      y2: 0,
      stops: [
        { offset: 0, color: [0, 0, 0] },
        { offset: 0.5, color: [255, 255, 255] },
        { offset: 0.5, color: [255, 0, 0] },
        { offset: 1, color: [0, 0, 255] },
      ],
    };
    const rect: AbsPath = { segs: [M(0, 0), L(256, 0), L(256, 128), L(0, 128), Z] };
    const layers: Layer[] = [{ fill: gradientMeanHex(hard), gradient: hard, paths: [rect] }];
    const svg = assembleSvg(layers, { width: 64, height: 32, viewBoxWidth: 256, viewBoxHeight: 128 });
    expect(svg.match(/<stop [^>]*\/>/g)).toEqual([
      '<stop offset="0" stop-color="#000000"/>',
      '<stop offset="0.5" stop-color="#ffffff"/>',
      '<stop offset="0.5" stop-color="#ff0000"/>',
      '<stop offset="1" stop-color="#0000ff"/>',
    ]);
    const back = renderAt1x(parseSvg(svg), [255, 255, 255]);
    const direct = renderLayersAt1x(layers, 4, 64, 32, [255, 255, 255]);
    let worst = 0;
    for (let i = 0; i < back.data.length; i++) worst = Math.max(worst, Math.abs(back.data[i] - direct.data[i]));
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('fractional stop colours come back rounded, as the hex wrote them', () => {
    const g = lin(0, 0, 10, 0, [[0, [10.4, 200.6, 30.5]], [1, [0, 0, 0]]]);
    const svg = assembleSvg([{ fill: gradientMeanHex(g), gradient: g, paths: [SQUARE] }], {
      width: 16,
      height: 16,
      viewBoxWidth: 64,
      viewBoxHeight: 64,
    });
    expect(parseSvg(svg).layers[0].gradient?.stops.map((s) => s.color)).toEqual([
      [10, 201, 31],
      [0, 0, 0],
    ]);
  });

  it('applies the SVG defaults and reads what SVGO writes: missing geometry, percentages, #rgb, ".5" offsets, any attribute order', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20" viewBox="0 0 40 80"><defs>' +
      '<radialGradient id="r" gradientUnits="userSpaceOnUse"><stop offset="50%" stop-color="#FFF"/><stop stop-color="#0a0b0c" offset=".75"/></radialGradient>' +
      '<linearGradient x2="10" id="l" gradientUnits="userSpaceOnUse"><stop offset="0"/><stop offset="1" stop-color="#abc"/></linearGradient>' +
      '<linearGradient id="d" gradientUnits="userSpaceOnUse" y2="25%"/>' +
      '</defs><path fill="url(#l)" d="M0 0h10v10H0z"/><path fill="url(\'#r\')" d="M0 0h10v10H0z"/><path fill="url(#d)" d="M0 0h1v1H0z"/></svg>';
    const [l, r, d] = parseSvg(svg).layers;
    expect(l.gradient).toEqual(lin(0, 0, 10, 0, [[0, [0, 0, 0]], [1, [170, 187, 204]]]));
    expect(l.fill).toBe('#555e66'); // (85, 93.5, 102)
    expect(r.gradient?.kind).toBe('radial');
    if (r.gradient?.kind === 'radial') {
      expect(r.gradient.cx).toBe(20);
      expect(r.gradient.cy).toBe(40);
      expect(r.gradient.r).toBeCloseTo(0.5 * Math.sqrt((40 * 40 + 80 * 80) / 2), 9);
      expect(r.gradient.stops).toEqual([
        { offset: 0.5, color: [255, 255, 255] },
        { offset: 0.75, color: [10, 11, 12] },
      ]);
    }
    expect(d.gradient).toEqual(lin(0, 0, 40, 20, []));
    expect(d.fill).toBe('#000000');
  });

  it('offsets are clamped to [0, 1] and raised to the previous one like SVG; equal offsets are kept', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4"><defs>' +
      '<linearGradient id="g0" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="4" y2="0">' +
      '<stop offset="0.6" stop-color="#010203"/><stop offset="0.4" stop-color="#ffffff"/><stop offset="-1" stop-color="#000000"/><stop offset="1.5" stop-color="#102030"/>' +
      '</linearGradient></defs><path fill="url(#g0)" d="M0 0h4v4H0z"/></svg>';
    expect(parseSvg(svg).layers[0].gradient?.stops.map((s) => s.offset)).toEqual([0.6, 0.6, 0.6, 1]);
  });

  it('every path gets its own copy of a gradient several paths share', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4"><defs>' +
      '<linearGradient id="g0" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="4" y2="0"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/></linearGradient>' +
      '</defs><path fill="url(#g0)" d="M0 0h2v2H0z"/><path fill="url(#g0)" d="M2 2h2v2H2z"/></svg>';
    const [a, b] = parseSvg(svg).layers;
    expect(a.gradient).toEqual(b.gradient);
    expect(a.gradient).not.toBe(b.gradient);
    expect(a.gradient?.stops[0].color).not.toBe(b.gradient?.stops[0].color);
  });

  it('rejects what the Layer model cannot represent and references to undefined gradients', () => {
    const doc = (gradient: string, fill = 'url(#g0)'): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4"><defs>${gradient}</defs><path fill="${fill}" d="M0 0h4v4H0z"/></svg>`;
    const stops = '<stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/>';
    const linear = (attrs: string, body = stops): string =>
      `<linearGradient id="g0" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="4" y2="0"${attrs}>${body}</linearGradient>`;
    expect(() => parseSvg(doc(linear(' gradientTransform="rotate(45)"')))).toThrow(/gradientTransform/);
    expect(() => parseSvg(doc(linear(' xlink:href="#other"')))).toThrow(/xlink:href/);
    expect(() => parseSvg(doc(linear(' spreadMethod="reflect"')))).toThrow(/spreadMethod/);
    expect(() => parseSvg(doc(`<radialGradient id="g0" gradientUnits="userSpaceOnUse" cx="2" cy="2" r="2" fx="1">${stops}</radialGradient>`))).toThrow(
      /fx/,
    );
    expect(() => parseSvg(doc(`<linearGradient id="g0" x1="0" y1="0" x2="4" y2="0">${stops}</linearGradient>`))).toThrow(/userSpaceOnUse/);
    expect(() => parseSvg(doc(linear('', '<stop offset="0" stop-color="#000000" stop-opacity="0.5"/>')))).toThrow(/stop-opacity/);
    expect(() => parseSvg(doc(linear('', '<stop offset="0" stop-color="red"/>')))).toThrow(/no soportado/);
    expect(() => parseSvg(doc(linear('', '<stop offset="abc" stop-color="#000000"/>')))).toThrow(/no reconocido/);
    expect(() => parseSvg(doc(linear(''), 'url(#missing)'))).toThrow(/#missing no definido/);
    expect(parseSvg(doc(linear(' spreadMethod="pad"'))).layers[0].gradient?.kind).toBe('linear');
  });
});

describe('extractPaths skips <defs>', () => {
  it('paths and groups inside <defs> are neither collected nor change the inherited fill', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">' +
      '<defs><path id="p" d="M0 0L1 1Z"/><g fill="#ff0000"><path d="M2 2L3 3Z"/></g></defs>' +
      '<g fill="#00ff00"><path d="M4 4L5 5Z"/></g>' +
      '<defs/>' +
      '<g fill="#0000ff"><defs><g></g><linearGradient id="g0"><stop offset="0"/></linearGradient></defs><path d="M8 8L9 9Z"/></g>' +
      '<path d="M6 6L7 7Z"/></svg>';
    expect(extractPaths(svg)).toEqual([
      { d: 'M4 4L5 5Z', fill: '#00ff00', transform: null },
      { d: 'M8 8L9 9Z', fill: '#0000ff', transform: null },
      { d: 'M6 6L7 7Z', fill: null, transform: null },
    ]);
  });
});
