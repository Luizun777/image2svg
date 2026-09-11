import { describe, expect, it } from 'vitest';
import { extractPaths } from '../../src/tracers/svgParse';

// Real outputs of the two engines (verified by running them from this repo).
const POTRACE_SVG =
  '<svg version="1.0" xmlns="http://www.w3.org/2000/svg" width="16.000000" height="16.000000" ' +
  'viewBox="0 0 16.000000 16.000000" preserveAspectRatio="xMidYMid meet">' +
  '<g transform="translate(0.000000,16.000000) scale(0.100000,-0.100000)" fill="#000000" stroke="none">' +
  '<path d="M40 80 l0 -40 40 0 40 0 0 40 0 40 -40 0 -40 0 0 -40z"/></g></svg>';

const VTRACER_SVG =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!-- Generator: visioncortex VTracer 0.1.0 -->\n' +
  '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="16" height="16">\n' +
  '<path d="M0 0 C2.64 0 5.28 0 8 0 C8 2.64 8 5.28 8 8 C5.36 8 2.72 8 0 8 C0 5.36 0 2.72 0 0 Z " ' +
  'fill="#000000" transform="translate(4,4)"/>\n' +
  '</svg>';

describe('extractPaths on real tracer output', () => {
  it('potrace: one path, fill and transform inherited from the <g>', () => {
    const paths = extractPaths(POTRACE_SVG);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toEqual({
      d: 'M40 80 l0 -40 40 0 40 0 0 40 0 40 -40 0 -40 0 0 -40z',
      fill: '#000000',
      transform: 'translate(0.000000,16.000000) scale(0.100000,-0.100000)',
    });
  });

  it('vtracer: prolog and comment are ignored; own fill and transform are used', () => {
    const paths = extractPaths(VTRACER_SVG);
    expect(paths).toHaveLength(1);
    expect(paths[0].d).toBe(
      'M0 0 C2.64 0 5.28 0 8 0 C8 2.64 8 5.28 8 8 C5.36 8 2.72 8 0 8 C0 5.36 0 2.72 0 0 Z ',
    );
    expect(paths[0].fill).toBe('#000000');
    expect(paths[0].transform).toBe('translate(4,4)');
  });

  it('several paths inside one potrace group all inherit the group attributes', () => {
    const svg =
      '<svg><g transform="translate(0,64) scale(0.1,-0.1)" fill="#000000" stroke="none">' +
      '<path d="M1 2z"/><path d="M3 4z"/>\n<path\n  d="M5 6z"\n/></g></svg>';
    const paths = extractPaths(svg);
    expect(paths.map((p) => p.d)).toEqual(['M1 2z', 'M3 4z', 'M5 6z']);
    for (const p of paths) {
      expect(p.fill).toBe('#000000');
      expect(p.transform).toBe('translate(0,64) scale(0.1,-0.1)');
    }
  });
});

describe('extractPaths inheritance rules', () => {
  it('path without attributes and without any container → nulls', () => {
    expect(extractPaths('<svg><path d="M0 0z"/></svg>')).toEqual([
      { d: 'M0 0z', fill: null, transform: null },
    ]);
  });

  it("the path's own fill wins over the group's", () => {
    const svg = '<svg><g fill="#111111"><path d="M0 0z" fill="#ff0000"/></g></svg>';
    expect(extractPaths(svg)[0].fill).toBe('#ff0000');
  });

  it('nearest enclosing group wins; outer groups are fallback', () => {
    const svg =
      '<svg fill="#0000ff"><g fill="#111111"><g><path d="M1 1z"/></g>' +
      '<g fill="#222222"><path d="M2 2z"/></g></g><path d="M3 3z"/></svg>';
    const paths = extractPaths(svg);
    expect(paths.map((p) => p.fill)).toEqual(['#111111', '#222222', '#0000ff']);
  });

  it('after </g> the group attributes stop applying', () => {
    const svg =
      '<svg><g fill="#111111" transform="translate(1,2)"><path d="M0 0z"/></g><path d="M9 9z"/></svg>';
    const paths = extractPaths(svg);
    expect(paths).toHaveLength(2);
    expect(paths[1]).toEqual({ d: 'M9 9z', fill: null, transform: null });
  });

  it('self-closing <g/> does not open a scope', () => {
    const svg = '<svg><g fill="#111111"/><path d="M0 0z"/></svg>';
    expect(extractPaths(svg)[0].fill).toBeNull();
  });

  it('group and path transforms compose outer→inner (SVG order)', () => {
    const svg =
      '<svg><g transform="translate(0,16) scale(0.1,-0.1)"><g transform="scale(2)">' +
      '<path d="M0 0z" transform="translate(4,4)"/></g></g></svg>';
    expect(extractPaths(svg)[0].transform).toBe(
      'translate(0,16) scale(0.1,-0.1) scale(2) translate(4,4)',
    );
  });

  it('path transform alone when the group has none', () => {
    const svg = '<svg><g fill="#000"><path d="M0 0z" transform="translate(4,4)"/></g></svg>';
    expect(extractPaths(svg)[0].transform).toBe('translate(4,4)');
  });
});

describe('extractPaths robustness', () => {
  it('empty string and svg without paths → []', () => {
    expect(extractPaths('')).toEqual([]);
    expect(extractPaths('<svg width="4" height="4"></svg>')).toEqual([]);
    expect(extractPaths('<svg><g fill="#000"></g></svg>')).toEqual([]);
  });

  it('single-quoted attributes and odd whitespace', () => {
    const svg = "<svg><g fill = '#abcdef' ><path\td='M1 1z'\ntransform = 'translate(1, 2)' /></g></svg>";
    expect(extractPaths(svg)).toEqual([
      { d: 'M1 1z', fill: '#abcdef', transform: 'translate(1, 2)' },
    ]);
  });

  it('id="…" is never mistaken for d="…"', () => {
    const svg = '<svg><path id="d1" d="M7 7z" fill="#123456"/><path id="only"/></svg>';
    const paths = extractPaths(svg);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toEqual({ d: 'M7 7z', fill: '#123456', transform: null });
  });

  it('paths with a missing or empty d are skipped', () => {
    const svg = '<svg><path fill="#000"/><path d="" fill="#000"/><path d="   "/><path d="M1 1z"/></svg>';
    expect(extractPaths(svg).map((p) => p.d)).toEqual(['M1 1z']);
  });

  it('non-self-closing <path>…</path> is handled and </path> is ignored', () => {
    const svg = '<svg><g fill="#000"><path d="M1 1z"><title>x</title></path><path d="M2 2z"/></g></svg>';
    const paths = extractPaths(svg);
    expect(paths.map((p) => p.d)).toEqual(['M1 1z', 'M2 2z']);
    expect(paths.map((p) => p.fill)).toEqual(['#000', '#000']);
  });

  it('paths inside comments or CDATA are ignored', () => {
    const svg =
      '<svg><!-- <path d="M0 0z"/> --><path d="M1 1z"/>' +
      '<![CDATA[<path d="M2 2z"/>]]><!--\n<g fill="#f00">\n--><path d="M3 3z"/></svg>';
    const paths = extractPaths(svg);
    expect(paths.map((p) => p.d)).toEqual(['M1 1z', 'M3 3z']);
    expect(paths.map((p) => p.fill)).toEqual([null, null]);
  });

  it('other elements (rect, circle, defs) are ignored, groups still tracked', () => {
    const svg =
      '<svg><rect width="4" height="4" fill="#fff"/><g fill="#000"><circle r="1"/>' +
      '<path d="M1 1z"/></g></svg>';
    expect(extractPaths(svg)).toEqual([{ d: 'M1 1z', fill: '#000', transform: null }]);
  });

  it('stray closing tags do not break the scan', () => {
    const svg = '<svg></g><g fill="#000"><path d="M1 1z"/></g></g><path d="M2 2z"/></svg>';
    const paths = extractPaths(svg);
    expect(paths.map((p) => p.fill)).toEqual(['#000', null]);
  });

  it('does not mutate its input and handles long path data linearly', () => {
    const chunks: string[] = [];
    for (let i = 0; i < 20000; i++) chunks.push(`l${i % 7} ${-(i % 5)}`);
    const d = `M0 0 ${chunks.join(' ')}z`;
    const svg = `<svg><g fill="#000000"><path d="${d}"/></g></svg>`;
    const before = svg;
    const t0 = performance.now();
    const paths = extractPaths(svg);
    const ms = performance.now() - t0;
    expect(svg).toBe(before);
    expect(paths).toHaveLength(1);
    expect(paths[0].d).toBe(d);
    expect(paths[0].d.length).toBeGreaterThan(100000);
    expect(ms).toBeLessThan(500);
  });
});
