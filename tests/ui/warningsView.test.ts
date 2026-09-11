/**
 * Warning banners and keyboard focus. Node has no DOM, so a minimal document stands in for the
 * few APIs the view uses; it models the browser's focus fix-up: removing (or moving) the focused
 * element sends focus to <body>.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BakedCheckerboard, ConcreteMode, TraceParams, Warning } from '../../src/types';
import { effectiveMode } from '../../src/ui/paramState';
import { warningAction, withBakedCheckerboard } from '../../src/ui/warnings';
import { createWarnings, type WarningsView } from '../../src/ui/warningsView';

class FakeNode {
  parentNode: FakeElement | null = null;
  readonly childNodes: FakeNode[] = [];

  get isConnected(): boolean {
    for (let n: FakeNode | null = this; n !== null; n = n.parentNode) if (n === fakeDocument.body) return true;
    return false;
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (value !== '') this.appendChild(new FakeText(value));
  }

  contains(other: unknown): boolean {
    for (let n = other as FakeNode | null; n !== null && n !== undefined; n = n.parentNode) if (n === this) return true;
    return false;
  }

  appendChild<T extends FakeNode>(child: T): T {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this as unknown as FakeElement;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    if (child.contains(fakeDocument.activeElement)) fakeDocument.activeElement = fakeDocument.body;
    return child;
  }

  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const c of [...this.childNodes]) this.removeChild(c);
    for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n);
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }
}

class FakeText extends FakeNode {
  private data: string;

  constructor(data: string) {
    super();
    this.data = data;
  }

  override get textContent(): string {
    return this.data;
  }

  override set textContent(value: string) {
    this.data = value;
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<() => void>>();
  hidden = false;
  disabled = false;
  readonly localName: string;

  constructor(localName: string) {
    super();
    this.localName = localName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  focus(): void {
    if (this.isConnected) fakeDocument.activeElement = this;
  }

  click(): void {
    if (this.disabled) return;
    for (const fn of this.listeners.get('click') ?? []) fn();
  }

  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.childNodes) {
      if (c instanceof FakeElement) out.push(c, ...c.descendants());
    }
    return out;
  }
}

const fakeDocument = {
  body: new FakeElement('body'),
  activeElement: null as FakeElement | null,
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
  createTextNode: (text: string) => new FakeText(text),
};
fakeDocument.activeElement = fakeDocument.body;

const scope = globalThis as { document?: unknown };
const hadDocument = 'document' in scope;
const previousDocument = scope.document;

beforeAll(() => {
  scope.document = fakeDocument;
});

afterAll(() => {
  if (hadDocument) scope.document = previousDocument;
  else delete scope.document;
});

/** As detected on clip_art: a 20 px board, levels 238 / 254. */
const BOARD: BakedCheckerboard = {
  cell: 20.007,
  offsetX: 0,
  offsetY: 0,
  levels: [
    [238, 238, 238],
    [254, 254, 254],
  ],
  borderMatchRatio: 1,
};

const PHOTO: Warning = { code: 'photo', message: 'La imagen parece una fotografía.' };

/** The banners the app shows (refreshWarnings) for these params, with the painted board detected. */
function harness(detected: ConcreteMode): {
  view: WarningsView;
  root: FakeElement;
  params: () => TraceParams;
  extra: (w: Warning[]) => void;
} {
  let ui: TraceParams = {};
  let others: Warning[] = [];
  const render = (): void => {
    const mode = effectiveMode(ui, detected);
    const list = withBakedCheckerboard(others, BOARD, ui.bakedBackground ?? 'auto', mode);
    const ctx = { params: ui, mode, engines: { potrace: true, vtracer: true }, resolvedUpscale: 2 };
    view.set(list.map((warning) => ({ warning, action: warningAction(warning, ctx) })));
  };
  // Like app.ts: the action changes the params and the banners are refreshed synchronously.
  const view = createWarnings({
    onAction: (action) => {
      ui = action.apply(ui);
      render();
    },
  });
  const root = view.el as unknown as FakeElement;
  fakeDocument.body.replaceChildren(root);
  render();
  return {
    view,
    root,
    params: () => ui,
    extra: (w) => {
      others = w;
      render();
    },
  };
}

function actionOf(root: FakeElement, code: string): FakeElement | null {
  const banner = root.descendants().find((e) => e.getAttribute('data-code') === code);
  return banner?.descendants().find((e) => e.localName === 'button') ?? null;
}

describe('warnings view focus', () => {
  it('keeps keyboard focus on the painted-checkerboard action when it toggles, both ways', () => {
    const { root, params } = harness('lines');
    const keep = actionOf(root, 'baked-checkerboard');
    expect(keep?.textContent).toBe('Mantener el tablero en Color plano');
    keep!.focus();
    keep!.click();
    expect(params()).toEqual({ bakedBackground: 'keep', mode: 'flat' });
    const transparent = actionOf(root, 'baked-checkerboard');
    expect(transparent?.textContent).toBe('Tratar como transparente');
    expect(transparent?.isConnected).toBe(true);
    expect(fakeDocument.activeElement).toBe(transparent);

    transparent!.click();
    expect(params()).toEqual({ bakedBackground: 'auto', mode: 'flat' });
    const again = actionOf(root, 'baked-checkerboard');
    expect(again?.textContent).toBe('Mantener el tablero');
    expect(fakeDocument.activeElement).toBe(again);
  });

  it('keeps focus on the same banner action when another banner appears before it', () => {
    const { root, extra } = harness('flat');
    const keep = actionOf(root, 'baked-checkerboard');
    keep!.focus();
    extra([PHOTO]);
    const codes = root.childNodes.map((b) => (b as FakeElement).getAttribute('data-code'));
    expect(codes).toEqual(['baked-checkerboard', 'photo']);
    extra([]);
    expect(fakeDocument.activeElement).toBe(actionOf(root, 'baked-checkerboard'));
  });

  it('updates the text of a banner that stays and does not steal focus from outside the banners', () => {
    const { root, params } = harness('flat');
    const outside = new FakeElement('button');
    fakeDocument.body.appendChild(outside);
    outside.focus();
    actionOf(root, 'baked-checkerboard')!.click();
    expect(params().bakedBackground).toBe('keep');
    expect(root.textContent).toContain('Se conserva el tablero de ajedrez pintado');
    expect(fakeDocument.activeElement).toBe(outside);
  });
});
