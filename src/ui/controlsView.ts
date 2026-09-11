/**
 * Left panel: detection summary, automatic tuning and the controls rendered from controlSchema.
 * Controls are built once; `sync(ctx)` updates values and shows only the relevant ones.
 */
import type { ClassifyResult, TraceParams } from '../types';
import type {
  ColorControl,
  ControlContext,
  ControlDef,
  ControlGroup,
  SegmentedControl,
  SelectControl,
  SliderControl,
  ToggleControl,
} from './controlSchema';
import { CONTROLS, GROUP_LABEL, formatSliderValue, sliderFillPercent, sliderPosition } from './controlSchema';
import { h, setText, uid } from './dom';
import { MODE_LABEL } from './format';
import { icon } from './icons';
import { TUNE_HINT } from './tuneProgress';

export type TuneViewState =
  | {
      kind: 'idle';
      message: string | null;
      tone: 'ok' | 'neutral' | 'error';
      /** Applied tune: the before → after figures, one line in mono (formatTuneSummary). */
      summary?: string | null;
      /** Applied tune: the changed parameters. */
      changes?: string | null;
    }
  | { kind: 'running'; fraction: number; label: string };

export interface ControlsView {
  el: HTMLElement;
  sync(ctx: ControlContext): void;
  setDetection(result: ClassifyResult | null): void;
  setTuning(state: TuneViewState): void;
  setDisabled(disabled: boolean): void;
}

export interface ControlsOptions {
  onChange(next: TraceParams, control: ControlDef): void;
  onTune(): void;
  onCancelTune(): void;
}

interface Field {
  control: ControlDef;
  row: HTMLElement;
  update(ctx: ControlContext): void;
}

export function createControls(opts: ControlsOptions): ControlsView {
  let ctx: ControlContext | null = null;
  const emit = (control: ControlDef, next: TraceParams): void => opts.onChange(next, control);
  const params = (): TraceParams => ctx?.params ?? {};

  function noteEl(id: string): HTMLElement {
    return h('p', { class: 'field__note', id, hidden: true });
  }
  function setNote(el: HTMLElement, text: string | null): void {
    el.hidden = text === null || text.length === 0;
    setText(el, text ?? '');
  }
  function describedBy(...ids: Array<string | null>): string {
    return ids.filter((x): x is string => x !== null).join(' ');
  }

  function sliderField(c: SliderControl): Field {
    const id = uid(`ctl-${c.id}`);
    const hintId = c.hint ? `${id}-hint` : null;
    const note = noteEl(`${id}-note`);
    const input = h('input', {
      type: 'range',
      class: 'slider',
      id,
      min: c.min,
      max: c.max,
      step: c.step,
      'aria-describedby': describedBy(hintId, note.id),
    });
    const output = h('output', { class: 'field__value', for: id });
    const autoButton = c.auto
      ? h('button', { type: 'button', class: 'chip-button', title: `Volver a ${c.label.toLowerCase()} automático` }, c.auto.label)
      : null;
    const row = h(
      'div',
      { class: 'field field--slider', 'data-control': c.id },
      h('div', { class: 'field__head' }, h('label', { class: 'field__label', for: id }, c.label), autoButton, output),
      input,
      c.minLabel
        ? h('div', { class: 'field__scale', 'aria-hidden': 'true' }, h('span', null, c.minLabel), h('span', null, c.maxLabel ?? ''))
        : null,
      note,
      c.hint ? h('p', { class: 'field__hint', id: hintId }, c.hint) : null,
    );
    const paint = (position: number, value: number | 'auto'): void => {
      input.style.setProperty('--fill', `${sliderFillPercent(c, position)}%`);
      const text = formatSliderValue(c, value);
      setText(output, text);
      input.setAttribute('aria-valuetext', text);
    };
    input.addEventListener('input', () => {
      const v = Number(input.value);
      paint(v, v);
      emit(c, c.set(params(), v));
    });
    autoButton?.addEventListener('click', () => {
      emit(c, c.set(params(), 'auto'));
      input.focus();
    });
    return {
      control: c,
      row,
      update(next) {
        const value = c.get(next);
        const position = sliderPosition(c, next);
        if (Math.abs(Number(input.value) - position) > c.step / 2) input.value = String(position);
        paint(position, value);
        if (autoButton) autoButton.hidden = value === 'auto';
        setNote(note, c.note?.(next) ?? null);
      },
    };
  }

  function segmentedField(c: SegmentedControl): Field {
    const name = uid(`ctl-${c.id}`);
    const note = noteEl(`${name}-note`);
    const longest = Math.max(...c.options.map((o) => o.label.length));
    const columns = c.options.length > 3 && longest > 6 ? 2 : c.options.length;
    const options = c.options.map((o) => {
      const input = h('input', { type: 'radio', class: 'segmented__input', name, value: o.value });
      const label = h('label', { class: 'segmented__option' }, input, h('span', { class: 'segmented__text' }, o.label));
      input.addEventListener('change', () => {
        if (input.checked) emit(c, c.set(params(), o.value));
      });
      return { input, label, option: o };
    });
    const hintId = c.hint ? `${name}-hint` : null;
    const row = h(
      'fieldset',
      { class: 'field field--segmented', 'data-control': c.id, 'aria-describedby': describedBy(hintId, note.id) },
      h('legend', { class: 'field__label' }, c.label),
      h('div', { class: 'segmented', style: `--columns: ${columns}` }, ...options.map((o) => o.label)),
      note,
      c.hint ? h('p', { class: 'field__hint', id: hintId }, c.hint) : null,
    );
    return {
      control: c,
      row,
      update(next) {
        const value = c.get(next);
        const reasons: string[] = [];
        for (const { input, label, option } of options) {
          input.checked = option.value === value;
          const reason = c.disabledReason?.(option.value, next) ?? null;
          input.disabled = reason !== null && option.value !== value;
          label.dataset.disabled = reason !== null ? 'true' : 'false';
          if (reason !== null) reasons.push(reason);
        }
        const notes = [c.note?.(next) ?? null, ...reasons].filter((x): x is string => x !== null);
        setNote(note, notes.join(' '));
      },
    };
  }

  function toggleField(c: ToggleControl): Field {
    const id = uid(`ctl-${c.id}`);
    const hintId = c.hint ? `${id}-hint` : null;
    const input = h('input', { type: 'checkbox', class: 'checkbox', id, 'aria-describedby': hintId });
    input.addEventListener('change', () => emit(c, c.set(params(), input.checked)));
    const row = h(
      'div',
      { class: 'field field--toggle', 'data-control': c.id },
      h('div', { class: 'field__check' }, input, h('label', { class: 'field__label', for: id }, c.label)),
      c.hint ? h('p', { class: 'field__hint', id: hintId }, c.hint) : null,
    );
    return {
      control: c,
      row,
      update(next) {
        input.checked = c.get(next);
      },
    };
  }

  function selectField(c: SelectControl): Field {
    const id = uid(`ctl-${c.id}`);
    const hintId = c.hint ? `${id}-hint` : null;
    const select = h(
      'select',
      { class: 'select', id, 'aria-describedby': hintId },
      ...c.options.map((o) => h('option', { value: o.value }, o.label)),
    );
    select.addEventListener('change', () => emit(c, c.set(params(), select.value)));
    const row = h(
      'div',
      { class: 'field field--select', 'data-control': c.id },
      h('label', { class: 'field__label', for: id }, c.label),
      select,
      c.hint ? h('p', { class: 'field__hint', id: hintId }, c.hint) : null,
    );
    return {
      control: c,
      row,
      update(next) {
        const v = c.get(next);
        if (select.value !== v) select.value = v;
      },
    };
  }

  function colorField(c: ColorControl): Field {
    const id = uid(`ctl-${c.id}`);
    const input = h('input', { type: 'color', class: 'color-input', id });
    const value = h('output', { class: 'field__value', for: id });
    input.addEventListener('input', () => {
      setText(value, input.value);
      emit(c, c.set(params(), input.value));
    });
    const row = h(
      'div',
      { class: 'field field--color', 'data-control': c.id },
      h('div', { class: 'field__head' }, h('label', { class: 'field__label', for: id }, c.label), value),
      input,
    );
    return {
      control: c,
      row,
      update(next) {
        const v = c.get(next);
        if (input.value.toLowerCase() !== v) input.value = v;
        setText(value, v);
      },
    };
  }

  const fields: Field[] = CONTROLS.map((c) => {
    switch (c.kind) {
      case 'slider':
        return sliderField(c);
      case 'segmented':
        return segmentedField(c);
      case 'toggle':
        return toggleField(c);
      case 'select':
        return selectField(c);
      case 'color':
        return colorField(c);
    }
  });

  // ---- detection ----------------------------------------------------------------------------
  const detectedMode = h('strong', null);
  const reasons = h('ul', { class: 'detection__reasons' });
  const detection = h(
    'div',
    { class: 'detection', hidden: true },
    h('p', { class: 'detection__title' }, 'Modo detectado: ', detectedMode),
    reasons,
  );

  // ---- tuning -------------------------------------------------------------------------------
  const tuneButton = h(
    'button',
    { type: 'button', class: 'btn btn--secondary btn--block', 'aria-describedby': 'tune-hint' },
    icon('sliders'),
    h('span', { class: 'btn__label' }, 'Ajuste automático'),
  );
  tuneButton.addEventListener('click', () => opts.onTune());
  const bar = h('div', { class: 'progress__bar' });
  const progress = h(
    'div',
    {
      class: 'progress',
      role: 'progressbar',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': 0,
      'aria-label': 'Progreso del ajuste automático',
    },
    bar,
  );
  const progressLabel = h('p', { class: 'tune__label' });
  const cancelButton = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, icon('close'), 'Cancelar');
  cancelButton.addEventListener('click', () => opts.onCancelTune());
  const running = h(
    'div',
    { class: 'tune__running', hidden: true },
    h('div', { class: 'tune__row' }, progressLabel, cancelButton),
    progress,
  );
  const tuneMessage = h('p', { class: 'tune__message' });
  const tuneSummary = h('p', { class: 'tune__summary' });
  const tuneChanges = h('p', { class: 'tune__changes' });
  const tuneResult = h('div', { class: 'tune__result', role: 'status', hidden: true }, tuneMessage, tuneSummary, tuneChanges);
  const tune = h(
    'div',
    { class: 'tune' },
    tuneButton,
    h('p', { class: 'field__hint', id: 'tune-hint' }, TUNE_HINT),
    running,
    tuneResult,
  );

  // ---- layout -------------------------------------------------------------------------------
  const groupEls = new Map<string, HTMLElement>();
  const mainGroup = h('div', { class: 'controls__group' }, ...fields.filter((f) => f.control.section === 'main').map((f) => f.row));
  const advancedBody = h('div', { class: 'advanced__body' });
  for (const group of ['trace', 'vtracer', 'output'] as ControlGroup[]) {
    const rows = fields.filter((f) => f.control.section === 'advanced' && f.control.group === group).map((f) => f.row);
    const el = h('div', { class: 'controls__group', 'data-group': group }, h('h3', { class: 'group__title' }, GROUP_LABEL[group]), ...rows);
    groupEls.set(group, el);
    advancedBody.appendChild(el);
  }
  const advanced = h('details', { class: 'advanced' }, h('summary', { class: 'advanced__summary' }, 'Avanzado'), advancedBody);
  const fieldset = h(
    'fieldset',
    { class: 'controls__fieldset' },
    h('legend', { class: 'sr-only' }, 'Parámetros de trazado'),
    mainGroup,
    advanced,
  );
  const form = h('form', { class: 'controls', novalidate: true }, fieldset);
  form.addEventListener('submit', (e) => e.preventDefault());

  const el = h(
    'aside',
    { class: 'panel panel--controls', 'aria-labelledby': 'controls-title' },
    h('h2', { class: 'panel__title', id: 'controls-title' }, 'Controles'),
    detection,
    tune,
    form,
  );

  return {
    el,
    sync(next) {
      ctx = next;
      for (const f of fields) {
        const visible = f.control.visible(next);
        f.row.hidden = !visible;
        if (visible) f.update(next);
      }
      for (const [group, groupEl] of groupEls) {
        groupEl.hidden = !fields.some((f) => f.control.section === 'advanced' && f.control.group === group && !f.row.hidden);
      }
    },
    setDetection(result) {
      detection.hidden = result === null;
      if (result === null) return;
      setText(detectedMode, MODE_LABEL[result.mode]);
      reasons.replaceChildren(...result.reasons.map((r) => h('li', null, r)));
    },
    setTuning(state) {
      if (state.kind === 'running') {
        const refocus = document.activeElement === tuneButton;
        tuneButton.hidden = true;
        running.hidden = false;
        const pct = Math.round(state.fraction * 100);
        bar.style.width = `${(state.fraction * 100).toFixed(1)}%`;
        progress.setAttribute('aria-valuenow', String(pct));
        progress.setAttribute('aria-valuetext', `${pct} %: ${state.label}`);
        setText(progressLabel, state.label);
        for (const p of [tuneMessage, tuneSummary, tuneChanges]) setText(p, '');
        tuneResult.hidden = true;
        if (refocus) cancelButton.focus();
      } else {
        const refocus = document.activeElement === cancelButton;
        running.hidden = true;
        tuneButton.hidden = false;
        setText(tuneMessage, state.message ?? '');
        setText(tuneSummary, state.summary ?? '');
        setText(tuneChanges, state.changes ?? '');
        tuneMessage.dataset.tone = state.tone;
        tuneResult.hidden = [state.message, state.summary, state.changes].every((t) => (t ?? '') === '');
        if (refocus) tuneButton.focus();
      }
    },
    setDisabled(disabled) {
      fieldset.disabled = disabled;
    },
  };
}
