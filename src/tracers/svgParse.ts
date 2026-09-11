/**
 * Minimal, DOM-free extraction of `<path>` elements from an SVG string, as emitted by the
 * tracer libraries (esm-potrace-wasm, vtracer-web). Regex-based on purpose: it runs inside a
 * Web Worker where DOMParser is unavailable, and the inputs are machine-generated.
 *
 * For every `<path>` it reports:
 *   - `d`: the path data (elements without a non-empty `d` are skipped);
 *   - `fill`: the element's own `fill` attribute, else the nearest enclosing `<g>`/`<svg>`
 *     fill, else null;
 *   - `transform`: the composition of every enclosing `<g>` transform (outermost first) with
 *     the path's own transform, joined by a space so `parseTransform` composes them in SVG
 *     order; null when nobody carries a transform.
 *
 * XML comments and `<![CDATA[…]]>` sections are stripped before scanning. Pure function.
 */

export interface ExtractedPath {
  d: string;
  fill: string | null;
  transform: string | null;
}

/** Matches an opening/self-closing <g>, <svg> or <path> tag, or a closing </g> / </svg>. */
const TAG_RE = /<(g|svg|path)\b([^>]*)>|<\/(g|svg)\s*>/g;
const COMMENT_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;

/**
 * Reads attribute `name` from the attribute string of a tag. Requires whitespace before the
 * name so `d=` never matches inside `id=`. Supports double and single quotes.
 * Returns null when the attribute is absent.
 */
function readAttr(attrs: string, name: string): string | null {
  // Attribute names are [A-Za-z-] only here, safe to inline in a RegExp without escaping.
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (m === null) return null;
  return m[1] !== undefined ? m[1] : (m[2] ?? '');
}

interface Container {
  tag: string; // 'g' | 'svg'
  fill: string | null; // effective fill (inherits from the parent when absent)
  transform: string | null; // composed transform of this container and all its ancestors
}

function joinTransforms(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return `${a} ${b}`;
}

export function extractPaths(svg: string): ExtractedPath[] {
  const out: ExtractedPath[] = [];
  if (svg.length === 0) return out;
  const src = svg.replace(COMMENT_RE, '');
  const stack: Container[] = [];
  const re = new RegExp(TAG_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[3] !== undefined) {
      // Closing tag: pop the nearest matching container (tolerates stray closers).
      const closing = m[3];
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === closing) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const tag = m[1];
    let attrs = m[2];
    const selfClosing = attrs.length > 0 && attrs.charCodeAt(attrs.length - 1) === 47; // '/'
    if (selfClosing) attrs = attrs.slice(0, -1);
    // Leading space guarantees `readAttr`'s whitespace guard works for the first attribute.
    attrs = ` ${attrs}`;
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    const ownFill = readAttr(attrs, 'fill');
    const ownTransform = readAttr(attrs, 'transform');
    const fill = ownFill !== null ? ownFill : parent !== null ? parent.fill : null;
    const transform = joinTransforms(parent !== null ? parent.transform : null, ownTransform);

    if (tag === 'path') {
      const d = readAttr(attrs, 'd');
      if (d === null || d.trim().length === 0) continue;
      out.push({ d, fill, transform });
      continue;
    }
    if (!selfClosing) stack.push({ tag, fill, transform });
  }
  return out;
}
