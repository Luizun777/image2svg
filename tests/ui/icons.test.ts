/**
 * Every IconName renders the real Phosphor Regular glyph: an aria-hidden <svg> on the 256-unit
 * grid whose path data is exactly the one shipped by @phosphor-icons/core. Node has no DOM, so a
 * minimal document stands in for createElementNS / setAttribute / appendChild.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { icon, type IconName } from '../../src/ui/icons';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Phosphor file behind each icon. A Record, so the typecheck fails if an IconName is missing. */
const PHOSPHOR: Record<IconName, string> = {
  upload: 'upload-simple',
  download: 'download-simple',
  copy: 'copy',
  check: 'check',
  warning: 'warning',
  error: 'warning-circle',
  zoomIn: 'magnifying-glass-plus',
  zoomOut: 'magnifying-glass-minus',
  fit: 'corners-out',
  close: 'x',
  image: 'image',
  sliders: 'sliders-horizontal',
};
const NAMES = Object.keys(PHOSPHOR) as IconName[];

interface FakeElement {
  namespaceURI: string;
  localName: string;
  children: FakeElement[];
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeElement): FakeElement;
}

function fakeElement(namespaceURI: string, localName: string): FakeElement {
  const attributes = new Map<string, string>();
  const children: FakeElement[] = [];
  return {
    namespaceURI,
    localName,
    children,
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute: (name) => attributes.get(name) ?? null,
    appendChild(child) {
      children.push(child);
      return child;
    },
  };
}

const scope = globalThis as { document?: unknown };
const hadDocument = 'document' in scope;
const previousDocument = scope.document;

beforeAll(() => {
  scope.document = { createElementNS: (ns: string, name: string) => fakeElement(ns, name) };
});

afterAll(() => {
  if (hadDocument) scope.document = previousDocument;
  else delete scope.document;
});

const render = (name: IconName, size?: number): FakeElement => icon(name, size) as unknown as FakeElement;

const require = createRequire(import.meta.url);
const phosphorSource = (file: string): string =>
  readFileSync(require.resolve(`@phosphor-icons/core/assets/regular/${file}.svg`), 'utf8');

describe('icon', () => {
  it('covers all twelve icon names', () => {
    expect(NAMES).toHaveLength(12);
  });

  it.each(NAMES)('%s renders a non-empty, aria-hidden svg with viewBox 0 0 256 256', (name) => {
    const svg = render(name);
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.localName).toBe('svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 256 256');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('class')).toBe('icon');
    // Phosphor Regular ships outlined shapes: filled with the text colour, never stroked.
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('stroke')).toBeNull();
    expect(svg.children.length).toBeGreaterThan(0);
    for (const child of svg.children) {
      expect(child.namespaceURI).toBe(SVG_NS);
      expect(child.localName).toBe('path');
      expect((child.getAttribute('d') ?? '').length).toBeGreaterThan(40);
    }
  });

  it.each(NAMES)('%s is the Phosphor Regular glyph', (name) => {
    const source = phosphorSource(PHOSPHOR[name]);
    expect(source).toContain('viewBox="0 0 256 256"');
    // Only <svg> and <path> elements, so taking the d attributes loses nothing.
    expect(new Set([...source.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) => m[1]))).toEqual(new Set(['svg', 'path']));
    const expected = [...source.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
    expect(expected.length).toBeGreaterThan(0);
    expect(render(name).children.map((c) => c.getAttribute('d'))).toEqual(expected);
  });

  it('honours the size argument', () => {
    const svg = render('upload', 20);
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('height')).toBe('20');
    expect(svg.getAttribute('viewBox')).toBe('0 0 256 256');
  });

  it('gives every name a different glyph', () => {
    const glyphs = NAMES.map((name) => render(name).children.map((c) => c.getAttribute('d')).join(' '));
    expect(new Set(glyphs).size).toBe(NAMES.length);
  });
});
