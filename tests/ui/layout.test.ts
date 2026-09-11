/**
 * Responsive rules of src/styles/layout.css that a flex layout can silently break. Node has no
 * layout engine, so the flex line breaking of a warning banner is reproduced from the declarations.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LAYOUT_CSS = readFileSync(new URL('../../src/styles/layout.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Body of the first brace-balanced block whose prelude matches. */
function blockBody(css: string, prelude: RegExp): string {
  const match = prelude.exec(css);
  if (match === null) throw new Error(`No block matches ${prelude}`);
  const open = css.indexOf('{', match.index);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`Unbalanced block for ${prelude}`);
}

/** Merged declarations of the flat rules (no nested blocks) whose selector list contains `selector`. */
function declarations(css: string, selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const d = /^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
      if (d !== null) out.set(d[1], d[2]);
    }
  }
  return out;
}

/** The part of the stylesheet outside @media blocks. */
function withoutMedia(css: string): string {
  let out = '';
  let i = 0;
  for (const m of css.matchAll(/@media[^{]*\{/g)) {
    if (m.index < i) continue;
    out += css.slice(i, m.index);
    let depth = 0;
    let j = css.indexOf('{', m.index);
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) break;
    }
    i = j + 1;
  }
  return out + css.slice(i);
}

/** px value of a length: "12px", "100%", "calc(100% - 40px)" or "calc(18px + 10px)" against `percentBase`. */
function length(value: string | undefined, percentBase: number): number {
  if (value === undefined) return 0;
  const v = value.trim();
  const calc = /^calc\((.+)\)$/.exec(v);
  const expr = calc !== null ? calc[1] : v;
  let total = 0;
  for (const term of expr.match(/[+-]?\s*[\d.]+(?:px|%)/g) ?? []) {
    const t = /([+-]?)\s*([\d.]+)(px|%)/.exec(term)!;
    const n = Number(t[2]) * (t[1] === '-' ? -1 : 1);
    total += t[3] === '%' ? (n / 100) * percentBase : n;
  }
  return total;
}

/** Flex basis of an item from `flex` / `flex-basis` (a unitless-zero or content basis counts as 0). */
function basis(decl: Map<string, string>, percentBase: number): number {
  const fb = decl.get('flex-basis');
  if (fb !== undefined) return length(fb, percentBase);
  const flex = decl.get('flex');
  if (flex === undefined || flex === 'none' || flex === 'auto') return 0;
  const parts = flex.split(/\s+(?![^(]*\))/);
  return parts.length >= 3 ? length(parts[2], percentBase) : 0;
}

describe('warning banners below 760 px', () => {
  const narrow = blockBody(LAYOUT_CSS, /@media\s*\(\s*max-width:\s*759\.98px\s*\)\s*\{/);
  const base = withoutMedia(LAYOUT_CSS);
  const merged = (selector: string): Map<string, string> => new Map([...declarations(base, selector), ...declarations(narrow, selector)]);

  // The icon is icon('warning', 18) (warningsView.ts); the gap comes from the stylesheet.
  const ICON = 18;

  it.each([343, 520, 700, 759])('puts the action on its own line at a %i px wide banner, aligned with the text', (width) => {
    const banner = merged('.banner');
    const body = merged('.banner__body');
    const action = merged('.banner__action');
    expect(banner.get('flex-wrap')).toBe('wrap');
    const inner = width - 2 * 12 - 2; // padding 10px 12px, 1 px border
    const gap = length(banner.get('gap')?.split(/\s+/).pop(), inner);
    const bodyBasis = basis(body, inner);
    // Line 1 holds the icon and the text column...
    expect(ICON + gap + bodyBasis).toBeLessThanOrEqual(inner);
    // ...and no action fits after them (the narrowest button, padding and a short label, is wider
    // than 24 px), so it wraps.
    expect(ICON + gap + bodyBasis + gap + 24).toBeGreaterThan(inner);
    // On its own line the action starts under the text, not under the icon.
    expect(length(action.get('margin-left'), inner)).toBe(ICON + gap);
  });

  it('keeps the action on the same row as the text from 760 px up', () => {
    expect(declarations(base, '.banner').get('flex-wrap')).toBeUndefined();
    expect(declarations(base, '.banner__action').get('margin-left')).toBeUndefined();
  });
});
