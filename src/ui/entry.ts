/**
 * Empty state: teaches what the tool does and how to give it an image (drop, paste, pick).
 */
import { SYNTH_FIXTURES } from '../dev/fixtures';
import { ACCEPTED_FORMATS_LABEL, MAX_INPUT_SIDE } from '../platform/decode';
import { h } from './dom';
import { NBSP } from './format';
import { icon } from './icons';

export interface EntryOptions {
  onPick(): void;
  devFixtures: boolean;
  isMac: boolean;
}

export interface EntryView {
  el: HTMLElement;
  setLoading(message: string | null): void;
  setError(message: string | null): void;
  setDragActive(active: boolean): void;
  focus(): void;
}

export function createEntry(opts: EntryOptions): EntryView {
  const pickButton = h(
    'button',
    { type: 'button', class: 'btn btn--primary btn--lg' },
    icon('upload', 18),
    h('span', { class: 'btn__label' }, 'Elegir imagen'),
  );
  pickButton.addEventListener('click', () => opts.onPick());

  const pasteKeys = opts.isMac
    ? [h('kbd', null, '⌘'), '+', h('kbd', null, 'V')]
    : [h('kbd', null, 'Ctrl'), '+', h('kbd', null, 'V')];

  const error = h('p', { class: 'entry__error', role: 'alert', hidden: true });
  const loading = h('p', { class: 'entry__loading', role: 'status', hidden: true });

  const zone = h(
    'div',
    { class: 'dropzone', 'data-state': 'idle' },
    h('span', { class: 'dropzone__icon' }, icon('image', 28)),
    h('h2', { class: 'entry__title', id: 'entry-title' }, 'Suelta aquí una imagen'),
    h('p', { class: 'entry__lead' }, 'o pégala desde el portapapeles con ', ...pasteKeys),
    pickButton,
    h(
      'p',
      { class: 'entry__formats' },
      `${ACCEPTED_FORMATS_LABEL} · hasta ${MAX_INPUT_SIDE}${NBSP}×${NBSP}${MAX_INPUT_SIDE}${NBSP}px`,
    ),
    loading,
    error,
  );

  const steps = h(
    'ol',
    { class: 'entry__steps' },
    h(
      'li',
      null,
      h('strong', null, 'Detecta el tipo de imagen.'),
      ' Logo de líneas, ilustración de colores planos o pixel art.',
    ),
    h(
      'li',
      null,
      h('strong', null, 'Traza sin picos.'),
      ' Reescala y suaviza antes de vectorizar, conservando las esquinas reales.',
    ),
    h(
      'li',
      null,
      h('strong', null, 'Mide la fidelidad.'),
      ' Renderiza el SVG y lo compara con el original, con mapa de diferencias.',
    ),
  );

  const el = h(
    'section',
    { class: 'entry', 'aria-labelledby': 'entry-title' },
    zone,
    steps,
    h('p', { class: 'entry__privacy' }, 'La imagen se procesa en tu navegador y no se sube a ningún servidor.'),
  );

  if (opts.devFixtures) {
    const links = SYNTH_FIXTURES.flatMap((name, i) => [
      i > 0 ? ' · ' : '',
      h('a', { href: `?synth=${name}` }, name),
    ]);
    el.appendChild(h('p', { class: 'entry__dev' }, 'Fixtures de desarrollo: ', ...links));
  }

  return {
    el,
    setLoading(message) {
      loading.hidden = message === null;
      loading.textContent = message ?? '';
      pickButton.disabled = message !== null;
      zone.setAttribute('aria-busy', message !== null ? 'true' : 'false');
      zone.dataset.state = message !== null ? 'loading' : zone.dataset.state === 'loading' ? 'idle' : (zone.dataset.state ?? 'idle');
      if (message !== null) error.hidden = true;
    },
    setError(message) {
      error.hidden = message === null;
      error.textContent = message ?? '';
      if (message !== null) zone.dataset.state = 'error';
      else if (zone.dataset.state === 'error') zone.dataset.state = 'idle';
    },
    setDragActive(active) {
      if (active) zone.dataset.state = 'dragover';
      else if (zone.dataset.state === 'dragover') zone.dataset.state = 'idle';
    },
    focus() {
      pickButton.focus();
    },
  };
}
