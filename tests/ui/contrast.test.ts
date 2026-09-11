/**
 * WCAG 2.x contrast of the design tokens in both themes, for the colour pairs the stylesheets
 * actually use. Parses src/styles/tokens.css (light `:root`, the prefers-color-scheme dark block
 * and `:root[data-theme='dark']`) and checks that the rules in src/styles/*.css still wire those
 * pairs, so a new text colour or a changed background cannot slip past. No browser needed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];
type Theme = ReadonlyMap<string, string>;

const readStyle = (name: string): string =>
  readFileSync(new URL(`../../src/styles/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const TOKENS_CSS = readStyle('tokens.css');
const ALL_CSS = ['tokens.css', 'controls.css', 'layout.css'].map(readStyle).join('\n');

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

/** Custom properties of a declaration block (semicolons inside quotes or url() are kept). */
function customProperties(body: string): Map<string, string> {
  const props = new Map<string, string>();
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = i === body.length ? ';' : body[i];
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
    } else if (c === ';' && depth === 0) {
      const decl = /^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(body.slice(start, i));
      if (decl !== null) props.set(decl[1], decl[2]);
      start = i + 1;
    }
  }
  return props;
}

const LIGHT = customProperties(blockBody(TOKENS_CSS, /(?:^|\})\s*:root\s*\{/));
const DARK_MEDIA = customProperties(
  blockBody(
    blockBody(TOKENS_CSS, /@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{/),
    /:root:not\(\[data-theme=(['"])light\1\]\)\s*\{/,
  ),
);
const DARK_ATTR = customProperties(blockBody(TOKENS_CSS, /:root\[data-theme=(['"])dark\1\]\s*\{/));
const THEMES: ReadonlyArray<[string, Theme]> = [
  ['light', LIGHT],
  ['dark', new Map([...LIGHT, ...DARK_ATTR])],
];

function parseHex(value: string): Rgb {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (m === null) throw new Error(`Not a hex colour: ${value}`);
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function color(theme: Theme, token: string, depth = 0): Rgb {
  const value = theme.get(`--${token}`);
  if (value === undefined) throw new Error(`--${token} is not defined`);
  const ref = /^var\(--([\w-]+)\)$/.exec(value);
  if (ref !== null) {
    if (depth > 8) throw new Error(`--${token} does not resolve`);
    return color(theme, ref[1], depth + 1);
  }
  return parseHex(value);
}

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLCH hue in degrees (Björn Ottosson's matrices). */
function oklchHue(rgb: Rgb): number {
  const [r, g, b] = rgb.map(channel);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
}

interface Requirement {
  fg: string;
  on: readonly string[];
  min: number;
  use: string;
}

const TEXT = 4.5;
const LARGE = 3;
const NON_TEXT = 3;

/** Small text: every `color:` token of the stylesheets on every background it sits on. */
const TEXT_PAIRS: readonly Requirement[] = [
  { fg: 'ink', on: ['paper', 'surface', 'canvas', 'line', 'warn-surface', 'bad-surface'], min: TEXT, use: 'body, panels, detection box, pressed summary, banners' },
  { fg: 'muted', on: ['paper', 'surface', 'canvas', 'line'], min: TEXT, use: 'secondary text, labels, segmented options, disabled primary button' },
  { fg: 'accent', on: ['paper', 'surface'], min: TEXT, use: 'links' },
  { fg: 'accent-deep', on: ['paper', 'surface'], min: TEXT, use: 'hovered links' },
  { fg: 'on-accent', on: ['accent', 'accent-deep'], min: TEXT, use: 'primary button, also hovered' },
  { fg: 'inverse-ink', on: ['inverse-bg'], min: TEXT, use: 'active segmented option' },
  { fg: 'signal-ok', on: ['surface', 'paper'], min: TEXT, use: 'tune and copy feedback, success button' },
  { fg: 'signal-warn', on: ['surface', 'paper', 'warn-surface'], min: TEXT, use: 'fidelity figure, warning banner icon' },
  { fg: 'signal-bad', on: ['surface', 'paper', 'bad-surface'], min: TEXT, use: 'error messages, error button, notices' },
];

/** Large figures (fidelity percentage, 2.5 rem bold). */
const LARGE_PAIRS: readonly Requirement[] = [
  { fg: 'signal-ok', on: ['surface'], min: LARGE, use: 'fidelity figure ok' },
  { fg: 'signal-warn', on: ['surface'], min: LARGE, use: 'fidelity figure warn' },
  { fg: 'signal-bad', on: ['surface'], min: LARGE, use: 'fidelity figure bad' },
  { fg: 'muted', on: ['surface'], min: LARGE, use: 'fidelity figure without level' },
];

/** Graphical objects and focus indicators against their adjacent colours. */
const NON_TEXT_PAIRS: readonly Requirement[] = [
  { fg: 'accent', on: ['paper', 'surface', 'canvas'], min: NON_TEXT, use: 'focus ring, slider thumb and fill, checked checkbox, progress' },
  { fg: 'signal-ok', on: ['surface'], min: NON_TEXT, use: 'signal dot, success border' },
  { fg: 'signal-warn', on: ['surface'], min: NON_TEXT, use: 'signal dot' },
  { fg: 'signal-bad', on: ['surface'], min: NON_TEXT, use: 'signal dot, error border' },
  { fg: 'line-strong', on: ['surface'], min: NON_TEXT, use: 'checkbox, select and colour input borders' },
  { fg: 'on-accent', on: ['accent'], min: NON_TEXT, use: 'check mark of a checked checkbox' },
  { fg: 'muted', on: ['surface'], min: NON_TEXT, use: 'select and disclosure chevron' },
];

function failures(theme: Theme, pairs: readonly Requirement[]): string[] {
  const out: string[] = [];
  for (const { fg, on, min, use } of pairs) {
    for (const bg of on) {
      const ratio = contrast(color(theme, fg), color(theme, bg));
      if (ratio < min) out.push(`${fg} on ${bg} = ${ratio.toFixed(2)} < ${min} (${use})`);
    }
  }
  return out;
}

/** Declaration bodies of the rules whose selector list contains `selector` exactly. */
function rulesFor(selector: string): string[] {
  const wanted = selector.replace(/\s+/g, ' ').trim();
  const bodies: string[] = [];
  for (const m of ALL_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim());
    if (selectors.includes(wanted)) bodies.push(m[2]);
  }
  return bodies;
}

const decl = (property: string, token: string): RegExp =>
  new RegExp(`(?<![\\w-])${property}\\s*:\\s*var\\(--${token}\\)`);

describe('contrast helpers', () => {
  it('match known WCAG ratios', () => {
    expect(contrast(parseHex('#ffffff'), parseHex('#000000'))).toBeCloseTo(21, 5);
    expect(contrast(parseHex('#767676'), parseHex('#ffffff'))).toBeCloseTo(4.54, 2);
    // The failing pair measured in the browser: white text on the dark accent.
    expect(contrast(parseHex('#ffffff'), parseHex('#7b96ff'))).toBeCloseTo(2.75, 2);
  });
});

describe('token blocks', () => {
  it('parses both themes', () => {
    expect(LIGHT.size).toBeGreaterThan(30);
    expect(DARK_ATTR.size).toBeGreaterThan(10);
  });

  it('keeps the prefers-color-scheme block and [data-theme=dark] identical', () => {
    expect(Object.fromEntries(DARK_MEDIA)).toEqual(Object.fromEntries(DARK_ATTR));
  });

  it('redefines only tokens that exist in the light theme', () => {
    expect([...DARK_ATTR.keys()].filter((k) => !LIGHT.has(k))).toEqual([]);
  });

  it('gives on-accent and the signal colours their own value per theme', () => {
    for (const token of ['--on-accent', '--signal-ok', '--signal-warn', '--signal-bad']) {
      expect(DARK_ATTR.has(token), token).toBe(true);
      expect(DARK_ATTR.get(token), token).not.toBe(LIGHT.get(token));
    }
  });

  it('leaves the overlay colours unchanged and theme independent', () => {
    expect(LIGHT.get('--overlay-corner')).toBe('#e11d48');
    expect(LIGHT.get('--overlay-curve')).toBe('#2563eb');
    expect(DARK_ATTR.has('--overlay-corner')).toBe(false);
    expect(DARK_ATTR.has('--overlay-curve')).toBe(false);
  });
});

describe.each(THEMES)('%s theme', (_name, theme) => {
  it('small text reaches 4.5:1 on every background it is used on', () => {
    expect(failures(theme, TEXT_PAIRS)).toEqual([]);
  });

  it('large figures reach 3:1', () => {
    expect(failures(theme, LARGE_PAIRS)).toEqual([]);
  });

  it('focus ring and graphical objects reach 3:1 against adjacent colours', () => {
    expect(failures(theme, NON_TEXT_PAIRS)).toEqual([]);
  });

  it('keeps the hue of each signal colour close to the other theme (OKLCH, within 3 degrees)', () => {
    for (const token of ['signal-ok', 'signal-warn', 'signal-bad']) {
      const delta = Math.abs(oklchHue(color(theme, token)) - oklchHue(color(LIGHT, token)));
      expect(Math.min(delta, 360 - delta), token).toBeLessThanOrEqual(3);
    }
  });

  it('draws the check mark in on-accent and the chevron in muted', () => {
    const stroke = (token: string): Rgb => {
      const m = /stroke='%23([0-9a-f]{6})'/i.exec(theme.get(`--${token}`) ?? '');
      if (m === null) throw new Error(`--${token} has no stroke colour`);
      return parseHex(`#${m[1]}`);
    };
    expect(stroke('check-mark')).toEqual(color(theme, 'on-accent'));
    expect(stroke('chevron')).toEqual(color(theme, 'muted'));
  });
});

/** Colour of `fg` drawn at `alpha` over `bg`, composited in sRGB as browsers do. */
function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((v, i) => Math.round(alpha * v + (1 - alpha) * bg[i])) as Rgb;
}

/** Last declaration of `property` in the rules for `selector`, or undefined. */
function declared(selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const body of rulesFor(selector)) {
    for (const m of body.matchAll(new RegExp(`(?<![\\w-])${property}\\s*:\\s*([^;]+)`, 'g'))) value = m[1].trim();
  }
  return value;
}

interface StalePart {
  /** Selector of the part inside the stale element ('' = the element itself). */
  part: string;
  property: 'color' | 'background';
  /** Tokens the part uses when not stale (one per state). */
  tokens: readonly string[];
  min: number;
  use: string;
}

/**
 * Figures waiting for a new measurement (resultsView adds `is-stale` between a control change and the
 * next compare()) must stay readable: they are still the numbers on screen. Each part is checked with
 * the stale rule's own colour when it declares one, composited at the opacity the stale rules declare.
 */
const STALE: ReadonlyArray<{ element: string; parts: readonly StalePart[] }> = [
  {
    element: '.fidelity.is-stale',
    parts: [
      { part: '.fidelity__value', property: 'color', tokens: ['signal-ok', 'signal-warn', 'signal-bad', 'muted'], min: LARGE, use: 'fidelity figure' },
      { part: '.fidelity__level', property: 'color', tokens: ['ink'], min: TEXT, use: 'fidelity level text' },
      { part: '.fidelity__explain', property: 'color', tokens: ['muted'], min: TEXT, use: 'fidelity explanation' },
      { part: '.signal-dot', property: 'background', tokens: ['signal-ok', 'signal-warn', 'signal-bad', 'line-strong'], min: NON_TEXT, use: 'signal dot' },
    ],
  },
  {
    element: '.metric__value.is-stale',
    parts: [
      { part: '', property: 'color', tokens: ['ink'], min: TEXT, use: 'metric value (17 px, not large text)' },
      { part: '.metric__sub', property: 'color', tokens: ['muted'], min: TEXT, use: 'metric sub-line' },
    ],
  },
];

describe.each(THEMES)('%s theme: stale figures', (_name, theme) => {
  it('stay at the text, large-text and graphic contrast minimums while they wait for a new measurement', () => {
    const out: string[] = [];
    const surface = color(theme, 'surface');
    for (const { element, parts } of STALE) {
      // The stale state must still be styled somewhere (on the element or on its parts).
      expect(ALL_CSS.includes(element), `no rule mentions ${element}`).toBe(true);
      for (const { part, property, tokens, min, use } of parts) {
        const selector = part === '' ? element : `${element} ${part}`;
        const opacity = [element, ...(part === '' ? [] : [selector])]
          .map((s) => Number(declared(s, 'opacity') ?? '1'))
          .reduce((a, b) => a * b, 1);
        const override = /^var\(--([\w-]+)\)$/.exec(declared(selector, property) ?? '');
        for (const token of override !== null ? [override[1]] : tokens) {
          const ratio = contrast(over(color(theme, token), surface, opacity), surface);
          if (ratio < min) out.push(`${use}: ${token} at opacity ${opacity} = ${ratio.toFixed(2)} < ${min}`);
        }
      }
    }
    expect(out).toEqual([]);
  });
});

describe('stale overrides', () => {
  it('come after the level rules of the same specificity they override', () => {
    const layout = readStyle('layout.css');
    const lastLevel = Math.max(
      ...['ok', 'warn', 'bad', 'none'].map((l) => layout.lastIndexOf(`.fidelity[data-level='${l}'] .fidelity__value`)),
      ...['ok', 'warn', 'bad'].map((l) => layout.lastIndexOf(`.fidelity[data-level='${l}'] .signal-dot`)),
    );
    for (const selector of ['.fidelity.is-stale .fidelity__value', '.fidelity.is-stale .signal-dot']) {
      const at = layout.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(lastLevel);
    }
  });
});

describe('stylesheets use the tested pairs', () => {
  it('every token used as a text colour is covered by a small-text requirement', () => {
    const used = new Set([...ALL_CSS.matchAll(/(?<![\w-])color\s*:\s*var\(--([\w-]+)\)/g)].map((m) => m[1]));
    const covered = new Set(TEXT_PAIRS.map((p) => p.fg));
    expect([...used].filter((token) => !covered.has(token))).toEqual([]);
  });

  it.each([
    ['body', decl('color', 'ink')],
    ['body', decl('background', 'paper')],
    ['.btn--primary', decl('background', 'accent')],
    ['.btn--primary', decl('color', 'on-accent')],
    ['.btn--primary:hover:not(:disabled)', decl('background', 'accent-deep')],
    ['.segmented__input:checked + .segmented__text', decl('background', 'inverse-bg')],
    ['.segmented__input:checked + .segmented__text', decl('color', 'inverse-ink')],
    [".fidelity[data-level='ok'] .fidelity__value", decl('color', 'signal-ok')],
    [".fidelity[data-level='warn'] .fidelity__value", decl('color', 'signal-warn')],
    [".fidelity[data-level='bad'] .fidelity__value", decl('color', 'signal-bad')],
    [".fidelity[data-level='ok'] .signal-dot", decl('background', 'signal-ok')],
    [".tune__message[data-tone='ok']", decl('color', 'signal-ok')],
    [".output__feedback[data-tone='ok']", decl('color', 'signal-ok')],
    [".output__feedback[data-tone='error']", decl('color', 'signal-bad')],
    ['.entry__error', decl('color', 'signal-bad')],
    ['.entry__error', decl('background', 'bad-surface')],
    ['.banner__icon', decl('color', 'signal-warn')],
    [':focus-visible', /outline\s*:\s*2px solid var\(--accent\)/],
    // Labels and messages over the preview carry their own surface, never the checkerboard.
    ['.pane__label', decl('background', 'surface')],
    ['.pane__message', decl('background', 'surface')],
  ] as const)('%s declares %s', (selector, pattern) => {
    const bodies = rulesFor(selector);
    expect(bodies.length, `no rule for ${selector}`).toBeGreaterThan(0);
    expect(bodies.some((body) => pattern.test(body))).toBe(true);
  });
});
