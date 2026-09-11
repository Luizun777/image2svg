/**
 * Minimal DOM helpers for the UI (no framework).
 */

export type Child = Node | string | number | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | null | undefined>;

/** Sets attributes; null/undefined/false are skipped, true becomes an empty boolean attribute. */
export function setAttrs(el: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(key, value === true ? '' : String(value));
  }
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) setAttrs(el, attrs);
  append(el, children);
  return el;
}

let counter = 0;

/** Unique DOM id. */
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Adds a listener and returns its remover. */
export function listen<E extends Event>(
  target: EventTarget,
  type: string,
  handler: (event: E) => void,
  options?: AddEventListenerOptions | boolean,
): () => void {
  const fn = handler as EventListener;
  target.addEventListener(type, fn, options);
  return () => target.removeEventListener(type, fn, options);
}

/** Writes text only when it changed (avoids re-announcing unchanged live regions). */
export function setText(el: Node, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  if (typeof err === 'string' && err.trim().length > 0) return err;
  return fallback;
}
