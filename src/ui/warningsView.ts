/**
 * Warning banners above the preview: title, the worker's Spanish message and, when one exists,
 * a one-click suggested action.
 *
 * Banners are keyed by warning code and updated in place: an action that toggles (the painted
 * checkerboard's "Mantener el tablero" / "Tratar como transparente") changes its own message and
 * label synchronously, and rebuilding the banner would drop keyboard focus to <body>. Nodes are
 * only moved when the order of the codes changes, and focus that was inside a banner that stays
 * goes back to its action (or to the first remaining action).
 */
import type { Warning, WarningCode } from '../types';
import { h, setText } from './dom';
import { icon } from './icons';
import type { WarningAction } from './warnings';
import { WARNING_TITLE } from './warnings';

export interface WarningItem {
  warning: Warning;
  action: WarningAction | null;
}

export interface WarningsView {
  el: HTMLElement;
  set(items: readonly WarningItem[]): void;
}

interface Banner {
  code: WarningCode;
  root: HTMLElement;
  title: HTMLElement;
  text: HTMLElement;
  button: HTMLButtonElement | null;
  action: WarningAction | null;
}

export function createWarnings(opts: { onAction(action: WarningAction): void }): WarningsView {
  const el = h('div', { class: 'warnings', 'aria-live': 'polite', 'aria-label': 'Avisos' });
  let key = '';
  let banners: Banner[] = [];

  function createBanner(code: WarningCode): Banner {
    const title = h('p', { class: 'banner__title' });
    const text = h('p', { class: 'banner__text' });
    const root = h(
      'div',
      { class: 'banner', 'data-code': code },
      h('span', { class: 'banner__icon' }, icon('warning', 18)),
      h('div', { class: 'banner__body' }, title, text),
    );
    return { code, root, title, text, button: null, action: null };
  }

  function update(banner: Banner, { warning, action }: WarningItem): void {
    setText(banner.title, WARNING_TITLE[warning.code] ?? 'Aviso');
    setText(banner.text, warning.message);
    banner.action = action;
    if (action === null) {
      banner.button?.remove();
      banner.button = null;
      return;
    }
    if (banner.button === null) {
      const button = h('button', { type: 'button', class: 'btn btn--secondary btn--sm banner__action' });
      button.addEventListener('click', () => {
        if (banner.action !== null) opts.onAction(banner.action);
      });
      banner.root.appendChild(button);
      banner.button = button;
    }
    setText(banner.button, action.label);
  }

  return {
    el,
    set(items) {
      const next = items
        .map((i) => `${i.warning.code}|${i.warning.message}|${i.action?.label ?? ''}`)
        .join('\n');
      if (next === key) return; // unchanged: do not re-announce
      key = next;

      const active = document.activeElement;
      const focused = active !== null && el.contains(active) ? (banners.find((b) => b.root.contains(active)) ?? null) : null;

      const previous = new Map(banners.map((b) => [b.code, b]));
      const shown: Banner[] = [];
      for (const item of items) {
        let banner = previous.get(item.warning.code);
        if (banner === undefined || shown.includes(banner)) banner = createBanner(item.warning.code);
        update(banner, item);
        shown.push(banner);
      }
      const sameOrder =
        el.childNodes.length === shown.length && shown.every((b, i) => el.childNodes[i] === b.root);
      if (!sameOrder) el.replaceChildren(...shown.map((b) => b.root));
      banners = shown;
      el.hidden = shown.length === 0;

      if (focused !== null && !el.contains(document.activeElement)) {
        const same = shown.find((b) => b.code === focused.code && b.button !== null);
        const target = same ?? shown.find((b) => b.button !== null);
        target?.button?.focus();
      }
    },
  };
}
