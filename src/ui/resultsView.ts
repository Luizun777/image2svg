/**
 * Right panel: fidelity metrics and output actions (download / copy).
 */
import type { ConcreteMode, Metrics } from '../types';
import type { TraceOutput } from './clientContract';
import { h, setText } from './dom';
import {
  FIDELITY_LEVEL_LABEL,
  NBSP,
  fidelityExplanation,
  fidelityLevel,
  formatBytes,
  formatDecimal,
  formatInteger,
  formatMs,
  formatPercent,
} from './format';
import type { IconName } from './icons';
import { icon } from './icons';

export type ActionState = 'idle' | 'loading' | 'success' | 'error';
export type ActionName = 'download' | 'copy';

export interface ResultsView {
  el: HTMLElement;
  reset(): void;
  setTrace(out: TraceOutput, fileName: string): void;
  setMetricsPending(): void;
  setMetrics(metrics: Metrics, mode: ConcreteMode): void;
  /** Replaces the metrics with a message (no SVG to measure, or a measuring error). */
  setMetricsMessage(message: string, tone: 'error' | 'neutral'): void;
  setAction(which: ActionName, state: ActionState): void;
  setFeedback(message: string | null, tone?: 'ok' | 'error'): void;
  destroy(): void;
}

interface Metric {
  row: HTMLElement;
  value: HTMLElement;
}

const ACTION_TEXT: Record<ActionName, Record<ActionState, string>> = {
  download: { idle: 'Descargar SVG', loading: 'Preparando…', success: 'Descargado', error: 'Descargar SVG' },
  copy: { idle: 'Copiar SVG', loading: 'Copiando…', success: 'Copiado', error: 'Copiar SVG' },
};
const ACTION_ICON: Record<ActionName, IconName> = { download: 'download', copy: 'copy' };

export function createResults(opts: { onDownload(): void; onCopy(): void }): ResultsView {
  const number = h('span', { class: 'fidelity__number' }, NBSP);
  const levelText = h('span', { class: 'fidelity__level-text' }, 'Midiendo');
  const fidelity = h(
    'div',
    { class: 'fidelity', 'data-level': 'pending' },
    h('p', { class: 'fidelity__value' }, number),
    h('p', { class: 'fidelity__level' }, h('span', { class: 'signal-dot', 'aria-hidden': 'true' }), levelText),
  );
  const explain = h('p', { class: 'fidelity__explain' }, fidelityExplanation('lines'));

  const metric = (label: string): Metric => {
    const value = h('dd', { class: 'metric__value is-pending' }, NBSP);
    return { row: h('div', { class: 'metric' }, h('dt', { class: 'metric__label' }, label), value), value };
  };
  const ssim = metric('SSIM');
  const iou = metric('IoU');
  const diff = metric('Píxeles distintos');
  const nodes = metric('Nodos');
  const size = metric('Tamaño');
  const time = metric('Tiempo');
  const measured = [ssim, iou, diff];
  const traced = [nodes, size, time];
  const status = h('p', { class: 'results__status', role: 'status' });

  const buttons = {} as Record<ActionName, { button: HTMLButtonElement; label: HTMLElement; iconSlot: HTMLElement }>;
  for (const name of ['download', 'copy'] as const) {
    const label = h('span', { class: 'btn__label' }, ACTION_TEXT[name].idle);
    const iconSlot = h('span', { class: 'btn__icon' }, icon(ACTION_ICON[name]));
    const button = h(
      'button',
      { type: 'button', class: `btn ${name === 'download' ? 'btn--primary' : 'btn--secondary'} btn--block`, disabled: true },
      iconSlot,
      label,
    );
    button.addEventListener('click', () => (name === 'download' ? opts.onDownload() : opts.onCopy()));
    buttons[name] = { button, label, iconSlot };
  }
  const meta = h('p', { class: 'output__meta' });
  const feedback = h('p', { class: 'output__feedback', role: 'status' });

  const el = h(
    'aside',
    { class: 'panel panel--results', 'aria-label': 'Resultados' },
    h(
      'section',
      { class: 'results__block', 'aria-labelledby': 'fidelity-title' },
      h('h2', { class: 'panel__title', id: 'fidelity-title' }, 'Fidelidad'),
      fidelity,
      explain,
      h('dl', { class: 'metrics' }, ...measured.map((m) => m.row), ...traced.map((m) => m.row)),
      status,
    ),
    h(
      'section',
      { class: 'results__block', 'aria-labelledby': 'output-title' },
      h('h2', { class: 'panel__title', id: 'output-title' }, 'Salida'),
      h('div', { class: 'output__actions' }, buttons.download.button, buttons.copy.button),
      meta,
      feedback,
    ),
    h(
      'p',
      { class: 'legal' },
      'image2svg es software libre con licencia GPL-2.0. Las imágenes no salen de tu navegador.',
    ),
  );

  const timers: Partial<Record<ActionName, number>> = {};
  let hasSvg = false;

  function setValue(m: Metric, text: string, sub?: string): void {
    m.value.classList.remove('is-pending', 'is-stale');
    m.value.replaceChildren(text, ...(sub ? [h('span', { class: 'metric__sub' }, sub)] : []));
  }

  function pending(list: Metric[]): void {
    for (const m of list) {
      if (m.value.textContent === NBSP) m.value.classList.add('is-pending');
      else m.value.classList.add('is-stale');
    }
  }

  function clear(list: Metric[]): void {
    for (const m of list) {
      m.value.classList.remove('is-stale');
      m.value.classList.add('is-pending');
      m.value.textContent = NBSP;
    }
  }

  const view: ResultsView = {
    el,
    reset() {
      clear([...measured, ...traced]);
      setText(number, NBSP);
      setText(levelText, 'Midiendo');
      fidelity.dataset.level = 'pending';
      setText(status, '');
      setText(meta, '');
      view.setFeedback(null);
      hasSvg = false;
      for (const name of ['download', 'copy'] as const) view.setAction(name, 'idle');
    },
    setTrace(out, fileName) {
      hasSvg = out.svg.length > 0;
      setValue(nodes, formatInteger(out.stats.nodeCount), `esquinas ${formatPercent(out.stats.cornerFraction)}`);
      setValue(size, formatBytes(out.stats.bytes));
      setValue(time, formatMs(out.ms));
      setText(
        meta,
        hasSvg
          ? `${fileName} · ${formatBytes(out.stats.bytes)} · ${formatInteger(out.stats.nodeCount)} nodos`
          : 'No hay SVG que descargar.',
      );
      for (const name of ['download', 'copy'] as const) {
        buttons[name].button.disabled = !hasSvg || buttons[name].button.getAttribute('aria-busy') === 'true';
      }
    },
    setMetricsPending() {
      pending(measured);
      fidelity.classList.add('is-stale');
      setText(status, 'Midiendo la fidelidad…');
      status.dataset.tone = 'neutral';
    },
    setMetrics(metrics, mode) {
      const level = fidelityLevel(metrics.fidelity);
      fidelity.classList.remove('is-stale');
      fidelity.dataset.level = level;
      setText(number, formatPercent(metrics.fidelity));
      setText(levelText, FIDELITY_LEVEL_LABEL[level]);
      setText(explain, fidelityExplanation(mode));
      setValue(ssim, formatDecimal(metrics.ssim, 3));
      setValue(iou, formatDecimal(metrics.iou, 3));
      setValue(diff, formatPercent(metrics.pctDiff16));
      setText(status, '');
    },
    setMetricsMessage(message, tone) {
      fidelity.classList.remove('is-stale');
      fidelity.dataset.level = 'none';
      setText(number, 'n/d');
      setText(levelText, tone === 'error' ? 'Sin medir' : 'Sin SVG');
      for (const m of measured) setValue(m, 'n/d');
      // Without any trace output the trace metrics would otherwise pulse forever.
      for (const m of traced) if (m.value.classList.contains('is-pending')) setValue(m, 'n/d');
      setText(status, message);
      status.dataset.tone = tone;
    },
    setAction(which, state) {
      const { button, label, iconSlot } = buttons[which];
      window.clearTimeout(timers[which]);
      button.dataset.state = state;
      button.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
      button.disabled = state === 'loading' || !hasSvg;
      setText(label, ACTION_TEXT[which][state]);
      iconSlot.replaceChildren(icon(state === 'success' ? 'check' : state === 'error' ? 'error' : ACTION_ICON[which]));
      if (state === 'success' || state === 'error') {
        timers[which] = window.setTimeout(() => view.setAction(which, 'idle'), 2000);
      }
    },
    setFeedback(message, tone = 'ok') {
      setText(feedback, message ?? '');
      feedback.dataset.tone = tone;
    },
    destroy() {
      for (const name of ['download', 'copy'] as const) window.clearTimeout(timers[name]);
    },
  };
  return view;
}
