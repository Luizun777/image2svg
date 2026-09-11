/**
 * Application shell: wires the views to a TraceClient.
 *
 * Flow: image (drop / paste / picker / ?synth=) → decode → client.setSource → client.classify →
 * detected mode + reasons → client.trace (debounced 200 ms on every control change, latest wins)
 * → preview + stats + warnings → rasterize the SVG on the main thread → client.compare →
 * fidelity panel and difference map. "Ajuste automático" runs client.tune on the second worker.
 * While a new image is being analysed, requests for the image still on screen wait (sourceSync.ts).
 * Global styles and the font are imported by src/main.ts.
 */
import { ACCEPTED_FORMATS_LABEL, ACCEPT_ATTRIBUTE, DecodeError, decodeImageFile } from '../platform/decode';
import type { BakedBackgroundSetting, ClassifyResult, Engine, SourceInfo, TraceParams } from '../types';
import type { TraceClient, TraceOutput, TuneProgress } from './clientContract';
import type { ControlContext } from './controlSchema';
import { createControls } from './controlsView';
import { errorMessage, h, listen, setText } from './dom';
import { createEntry } from './entry';
import {
  FIDELITY_LEVEL_LABEL,
  MODE_LABEL,
  fidelityLevel,
  formatBytes,
  formatDimensions,
  formatInteger,
  formatPercent,
  withErrorContext,
} from './format';
import { icon } from './icons';
import { optimizeSvg, preloadSvgo, svgFileName } from './output';
import { applyTunedParams, describeParamChanges, effectiveMode, sameTrace, traceParamsFor } from './paramState';
import { createPreview } from './previewView';
import { rasterizeSvg } from './rasterize';
import { createResults } from './resultsView';
import { createSourceSync } from './sourceSync';
import {
  TUNE_BUDGET_MS,
  describeTuneProgress,
  formatTuneSummary,
  tuneFraction,
  tuneResultOutdated,
  type ShownTuneResult,
} from './tuneProgress';
import { mergeWarnings, warningAction, withBakedCheckerboard } from './warnings';
import { createWarnings } from './warningsView';

export interface MountOptions {
  /** Enables the `?synth=` dev fixtures (and their links in the empty state). */
  devFixtures?: boolean;
}

export const TRACE_DEBOUNCE_MS = 200;

interface Loaded {
  name: string;
  image: ImageData;
  info: SourceInfo;
  classification: ClassifyResult;
  /** The decoded pixels have transparency (info may describe the effective source instead). */
  hasAlpha: boolean;
}

/**
 * Transparency of the decoded pixels, with SourceInfo's cut-off (alpha < 248). With a painted
 * checkerboard detected, `info` describes the effective source, where the board is transparent,
 * so the real pixels are scanned instead.
 */
function sourceHasAlpha(image: ImageData, info: SourceInfo): boolean {
  if (info.bakedBackground === null) return info.transparentRatio > 0 || info.partialAlphaRatio > 0;
  const d = image.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 248) return true;
  return false;
}

/** The SVG pane shows the UI checkerboard when the result can be transparent over opaque pixels. */
function resultHasAlpha(source: Loaded, setting: BakedBackgroundSetting): boolean {
  return source.hasAlpha || (source.info.bakedBackground !== null && setting !== 'keep');
}

/**
 * Mounts the app into `root` and returns an unmount function. The caller owns `client`:
 * unmounting cancels a running tune but does not terminate the client.
 */
export function mountApp(root: HTMLElement, client: TraceClient, opts: MountOptions = {}): () => void {
  let engines: Record<Engine, boolean> | null = null;
  let loaded: Loaded | null = null;
  let ui: TraceParams = {};
  let current: TraceOutput | null = null;
  let lastRequested: TraceParams | null = null;
  let traceInFlight = false;
  let traceSeq = 0;
  let loadSeq = 0;
  let tuneSeq = 0;
  let tuning = false;
  /** Params the tune message on screen describes; cleared with the message once the controls move away. */
  let tuneShown: ShownTuneResult | null = null;
  let debounce = 0;
  let destroyed = false;
  const optimized = new Map<string, Promise<string>>();
  const removers: Array<() => void> = [];
  /** Gates trace / compare / tune while a new image travels to the worker (see sourceSync.ts). */
  const sourceSync = createSourceSync<ImageData>();

  // ---- shell --------------------------------------------------------------------------------
  const fileInput = h('input', { type: 'file', accept: ACCEPT_ATTRIBUTE, class: 'sr-only', tabindex: -1, 'aria-hidden': 'true' });
  const fileChip = h('span', { class: 'topbar__file' });
  const changeButton = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', hidden: true }, icon('upload'), 'Cambiar imagen');
  const topbar = h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'brand' },
      h('h1', { class: 'brand__name' }, 'image2svg'),
      h('p', { class: 'brand__tagline' }, 'Vectoriza imágenes a SVG sin picos y mide la fidelidad del resultado.'),
    ),
    h('div', { class: 'topbar__actions' }, fileChip, changeButton),
  );
  const main = h('main', { class: 'main' });
  const status = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const dropOverlay = h(
    'div',
    { class: 'drop-overlay', hidden: true, 'aria-hidden': 'true' },
    h('p', { class: 'drop-overlay__text' }, icon('upload', 24), 'Suelta la imagen para cargarla'),
  );
  const appEl = h('div', { class: 'app' }, topbar, main, status, dropOverlay, fileInput);

  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
  const entry = createEntry({ onPick: () => fileInput.click(), devFixtures: opts.devFixtures === true, isMac });
  const preview = createPreview();
  const results = createResults({ onDownload: () => void download(), onCopy: () => void copy() });
  const controls = createControls({
    onChange: (next) => changeParams(next),
    onTune: () => void startTune(),
    onCancelTune: cancelTune,
  });
  const warningsView = createWarnings({ onAction: (action) => changeParams(action.apply(ui)) });
  const noticeText = h('span', null);
  const noticeClose = h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Cerrar aviso' }, icon('close'));
  const notice = h('div', { class: 'notice', role: 'alert', hidden: true }, icon('error', 18), noticeText, noticeClose);
  noticeClose.addEventListener('click', () => (notice.hidden = true));
  preview.el.prepend(notice, warningsView.el);
  const workspace = h('div', { class: 'workspace' }, controls.el, preview.el, results.el);

  main.appendChild(entry.el);
  root.replaceChildren(appEl);

  const readyPromise = client.ready().then((e) => {
    engines = e;
    syncControls();
    refreshWarnings();
    return e;
  });
  readyPromise.catch(() => undefined); // surfaced when an image is loaded

  // ---- helpers ------------------------------------------------------------------------------
  const announce = (text: string): void => setText(status, text);

  function controlContext(): ControlContext | null {
    if (loaded === null) return null;
    return {
      params: ui,
      mode: effectiveMode(ui, loaded.classification.mode),
      engines,
      paletteColors: loaded.info.paletteColors,
      grid: loaded.info.grid,
      resolvedUpscale: current?.resolved.upscale ?? null,
      bakedBackground: loaded.info.bakedBackground,
    };
  }

  function syncControls(): void {
    const ctx = controlContext();
    if (ctx !== null) controls.sync(ctx);
  }

  function refreshWarnings(): void {
    if (loaded === null) {
      warningsView.set([]);
      return;
    }
    const mode = current?.resolved.mode ?? effectiveMode(ui, loaded.classification.mode);
    const list = withBakedCheckerboard(
      mergeWarnings(current?.warnings ?? [], loaded.classification.warnings, mode),
      loaded.info.bakedBackground,
      ui.bakedBackground ?? 'auto',
      effectiveMode(ui, loaded.classification.mode),
    );
    const ctx = { params: ui, mode, engines, resolvedUpscale: current?.resolved.upscale ?? null };
    warningsView.set(list.map((warning) => ({ warning, action: warningAction(warning, ctx) })));
  }

  function showNotice(message: string | null): void {
    notice.hidden = message === null;
    setText(noticeText, message ?? '');
  }

  // ---- tracing ------------------------------------------------------------------------------
  function changeParams(next: TraceParams): void {
    if (loaded === null || tuning) return;
    ui = next;
    if (tuneResultOutdated(tuneShown, ui)) {
      // Its before and after figures (and "se mantienen los parámetros") no longer describe this trace.
      setTuneMessage({ kind: 'idle', message: null, tone: 'neutral' });
    }
    syncControls();
    refreshWarnings();
    if (ui.optimize === true) preloadSvgo().catch(() => undefined);
    window.clearTimeout(debounce);
    debounce = 0;
    if (lastRequested !== null && sameTrace(lastRequested, ui, loaded.classification.mode)) {
      preview.setBusy(traceInFlight);
      return;
    }
    preview.setBusy(true);
    debounce = window.setTimeout(() => void runTrace(), TRACE_DEBOUNCE_MS);
  }

  async function runTrace(): Promise<void> {
    debounce = 0;
    const source = loaded;
    if (source === null || destroyed) return;
    const requested = ui;
    const seq = ++traceSeq;
    lastRequested = requested;
    traceInFlight = true;
    preview.setBusy(true);
    preview.setError(null);
    let out: TraceOutput | null;
    try {
      if (sourceSync.busy) {
        // A new image is on its way to the worker: these params must not run on its pixels.
        await sourceSync.settled();
        if (seq !== traceSeq || source !== loaded || destroyed) return;
      }
      out = await client.trace(traceParamsFor(requested, source.classification.mode));
    } catch (err) {
      if (seq !== traceSeq || source !== loaded || destroyed) return;
      traceInFlight = false;
      lastRequested = null;
      preview.setBusy(false);
      preview.setError(withErrorContext('No se pudo vectorizar', errorMessage(err, 'error desconocido.')), () => void runTrace());
      if (current !== null) void measure(current, seq);
      else results.setMetricsMessage('No hay resultado que medir.', 'error');
      return;
    }
    if (out === null || seq !== traceSeq || source !== loaded || destroyed) return;
    traceInFlight = false;
    preview.setBusy(false);
    showOutput(out, seq);
  }

  function showOutput(out: TraceOutput, seq: number): void {
    if (loaded === null) return;
    current = out;
    preview.setError(null);
    preview.setResultAlpha(resultHasAlpha(loaded, out.resolved.bakedBackground));
    preview.setSvg(out.svg);
    preview.setDiff(null);
    results.setTrace(out, svgFileName(loaded.name));
    syncControls();
    refreshWarnings();
    announce(
      out.svg.length > 0
        ? `SVG listo: ${formatInteger(out.stats.nodeCount)} nodos, ${formatBytes(out.stats.bytes)}.`
        : 'No se generó el SVG; revisa los avisos.',
    );
    void measure(out, seq);
  }

  async function measure(out: TraceOutput, seq: number): Promise<void> {
    const source = loaded;
    if (source === null) return;
    if (out.svg.length === 0) {
      results.setMetricsMessage('No hay SVG que medir.', 'neutral');
      return;
    }
    results.setMetricsPending();
    try {
      const rendered = await rasterizeSvg(out.svg, source.image.width, source.image.height);
      if (seq !== traceSeq || source !== loaded || destroyed) return;
      if (sourceSync.busy) {
        await sourceSync.settled(); // compare against the image this SVG was traced from
        if (seq !== traceSeq || source !== loaded || destroyed) return;
      }
      // Measured against what this trace used: the painted checkerboard transparent unless kept, and
      // in flat mode its opaque background.
      const cmp = await client.compare(rendered, out.resolved.mode, {
        bakedBackground: out.resolved.bakedBackground,
        background: out.resolved.background,
      });
      if (cmp === null || seq !== traceSeq || source !== loaded || destroyed) return;
      results.setMetrics(cmp.metrics, out.resolved.mode);
      preview.setDiff(cmp.diffMap);
      const level = FIDELITY_LEVEL_LABEL[fidelityLevel(cmp.metrics.fidelity)].toLowerCase();
      announce(`Fidelidad ${formatPercent(cmp.metrics.fidelity)}: ${level}.`);
    } catch (err) {
      if (seq !== traceSeq || source !== loaded || destroyed) return;
      results.setMetricsMessage(withErrorContext('No se pudo medir la fidelidad', errorMessage(err, 'error desconocido.')), 'error');
    }
  }

  // ---- automatic tuning ---------------------------------------------------------------------
  /** controls.setTuning, remembering which params an idle message describes (null: nothing shown). */
  function setTuneMessage(state: Parameters<typeof controls.setTuning>[0], shownFor: ShownTuneResult | null = null): void {
    tuneShown = state.kind === 'idle' && state.message !== null ? shownFor : null;
    controls.setTuning(state);
  }

  function endTuning(): void {
    tuning = false;
    controls.setDisabled(false);
    syncControls();
  }

  async function startTune(): Promise<void> {
    const source = loaded;
    if (source === null || tuning || sourceSync.busy) return; // no tuning while a new image is analysed
    const detected = source.classification.mode;
    const before = ui;
    const id = ++tuneSeq;
    tuning = true;
    window.clearTimeout(debounce);
    debounce = 0;
    controls.setDisabled(true);
    let fraction = 0;
    setTuneMessage({ kind: 'running', fraction: 0, label: 'Preparando el ajuste…' });
    announce('Ajuste automático en curso.');
    try {
      const res = await client.tune(traceParamsFor(before, detected), TUNE_BUDGET_MS, (p: TuneProgress) => {
        if (id !== tuneSeq || !tuning) return;
        fraction = Math.max(fraction, tuneFraction(p));
        controls.setTuning({ kind: 'running', fraction, label: describeTuneProgress(p) });
      });
      if (id !== tuneSeq || source !== loaded || destroyed) return;
      endTuning();
      if (res === null) {
        setTuneMessage({ kind: 'idle', message: 'Ajuste cancelado; se mantienen los parámetros.', tone: 'neutral' }, { params: ui, detected });
        announce('Ajuste automático cancelado.');
        if (lastRequested === null || !sameTrace(lastRequested, ui, detected)) void runTrace();
        return;
      }
      const next = applyTunedParams(before, res.params, detected);
      const changes = describeParamChanges(before, next, detected);
      ui = next;
      const seq = ++traceSeq; // any trace still in flight is now stale
      lastRequested = next;
      traceInFlight = false;
      preview.setBusy(false);
      showOutput(res, seq);
      setTuneMessage(
        {
          kind: 'idle',
          message: 'Ajuste aplicado.',
          summary: formatTuneSummary(res.baseline, res.tuned),
          changes: changes.length > 0 ? `${changes.join(' · ')}.` : 'Los parámetros actuales ya eran los mejores.',
          tone: 'ok',
        },
        { params: next, detected },
      );
      announce('Ajuste automático terminado.');
    } catch (err) {
      if (id !== tuneSeq || source !== loaded || destroyed) return;
      endTuning();
      setTuneMessage(
        {
          kind: 'idle',
          message: withErrorContext('No se pudo completar el ajuste', errorMessage(err, 'error desconocido.')),
          tone: 'error',
        },
        { params: ui, detected },
      );
      // As after a cancel: a change still debounced when the tune started was never traced.
      if (lastRequested === null || !sameTrace(lastRequested, ui, detected)) void runTrace();
    }
  }

  function cancelTune(): void {
    if (!tuning) return;
    client.cancelTune();
  }

  function abandonTune(): void {
    if (!tuning) return;
    tuneSeq++;
    client.cancelTune();
    endTuning();
    setTuneMessage({ kind: 'idle', message: null, tone: 'neutral' });
  }

  // ---- loading ------------------------------------------------------------------------------
  function failLoad(err: unknown, name: string, hadSource: boolean): void {
    const detail =
      err instanceof DecodeError ? err.message : withErrorContext('No se pudo analizar', errorMessage(err, 'error desconocido.'));
    const message = `No se pudo cargar «${name}». ${detail}`;
    if (hadSource) {
      preview.setBusy(traceInFlight);
      showNotice(message);
    } else {
      entry.setLoading(null);
      entry.setError(message);
    }
  }

  async function loadFile(file: Blob, name: string): Promise<void> {
    const id = ++loadSeq;
    const hadSource = loaded !== null;
    showNotice(null);
    if (hadSource) preview.setBusy(true);
    else {
      entry.setError(null);
      entry.setLoading('Leyendo la imagen…');
    }
    let image: ImageData;
    try {
      image = await decodeImageFile(file, name);
    } catch (err) {
      if (id === loadSeq && !destroyed) failLoad(err, name, hadSource);
      return;
    }
    if (id === loadSeq && !destroyed) await loadImage(image, name, id);
  }

  /** Keeps the worker in sync with what is still on screen after a load that did not end there. */
  function restoreShownSource(attempt: ImageData): void {
    const shown = sourceSync.restore(attempt, loaded?.image ?? null);
    if (shown !== null) client.setSource(shown).catch(() => undefined);
  }

  async function loadImage(image: ImageData, name: string, id = ++loadSeq): Promise<void> {
    const previous = loaded;
    if (previous === null) entry.setLoading('Analizando la imagen…');
    else preview.setBusy(true);
    abandonTune();
    let settle: (() => void) | null = null;
    try {
      try {
        engines = await readyPromise;
      } catch (err) {
        throw new DecodeError(
          withErrorContext('No se pudo iniciar el motor de trazado', errorMessage(err, 'error desconocido.')),
        );
      }
      settle = sourceSync.begin(image);
      const info = await client.setSource(image);
      const classification = await client.classify();
      if (destroyed) return;
      if (id !== loadSeq) {
        restoreShownSource(image); // superseded by an attempt that may never reach the worker
        return;
      }

      window.clearTimeout(debounce);
      debounce = 0;
      abandonTune();
      loaded = { name, image, info, classification, hasAlpha: sourceHasAlpha(image, info) };
      ui = { ...classification.params, mode: 'auto' };
      current = null;
      lastRequested = null;
      traceInFlight = false;
      traceSeq++;
      settle(); // requests that waited for this swap re-check traceSeq / loaded and drop out

      if (previous === null) {
        main.replaceChildren(workspace);
        appEl.classList.add('has-source');
      }
      showNotice(null);
      preview.setError(null);
      preview.setSource(image, { original: loaded.hasAlpha, result: resultHasAlpha(loaded, ui.bakedBackground ?? 'auto') });
      results.reset();
      controls.setDetection(classification);
      setTuneMessage({ kind: 'idle', message: null, tone: 'neutral' });
      syncControls();
      refreshWarnings();
      setText(fileChip, `${name} · ${formatDimensions(image.width, image.height)}`);
      changeButton.hidden = false;
      announce(
        `Imagen cargada: ${name}, ${formatDimensions(image.width, image.height)}. ` +
          `Modo detectado: ${MODE_LABEL[classification.mode]}.`,
      );
      if (previous === null) (preview.el.querySelector('.pane__viewport') as HTMLElement | null)?.focus({ preventScroll: true });
      void runTrace();
    } catch (err) {
      if (destroyed) return;
      restoreShownSource(image);
      if (id !== loadSeq) return;
      failLoad(err, name, previous !== null);
    } finally {
      settle?.();
    }
  }

  // ---- output -------------------------------------------------------------------------------
  function outputSvg(svg: string): Promise<string> {
    if (ui.optimize !== true) return Promise.resolve(svg);
    let pending = optimized.get(svg);
    if (pending === undefined) {
      optimized.clear();
      pending = optimizeSvg(svg);
      optimized.set(svg, pending);
      pending.catch(() => optimized.delete(svg));
    }
    return pending;
  }

  async function download(): Promise<void> {
    const svg = current?.svg ?? '';
    if (loaded === null || svg.length === 0) return;
    const name = svgFileName(loaded.name);
    results.setAction('download', 'loading');
    results.setFeedback(null);
    try {
      const text = await outputSvg(svg);
      const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name, class: 'sr-only' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      results.setAction('download', 'success');
      results.setFeedback(`Descargado ${name} (${formatBytes(blob.size)}${ui.optimize === true ? ', optimizado con SVGO' : ''}).`);
    } catch (err) {
      results.setAction('download', 'error');
      results.setFeedback(`No se pudo descargar: ${errorMessage(err, 'error desconocido.')}`, 'error');
    }
  }

  async function copy(): Promise<void> {
    const svg = current?.svg ?? '';
    if (svg.length === 0) return;
    results.setAction('copy', 'loading');
    results.setFeedback(null);
    let text: string;
    try {
      text = await outputSvg(svg);
    } catch (err) {
      results.setAction('copy', 'error');
      results.setFeedback(`No se pudo copiar: ${errorMessage(err, 'error desconocido.')}`, 'error');
      return;
    }
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('unsupported');
      await navigator.clipboard.writeText(text);
      results.setAction('copy', 'success');
      results.setFeedback(`SVG copiado al portapapeles (${formatBytes(new Blob([text]).size)}).`);
    } catch {
      results.setAction('copy', 'error');
      results.setFeedback('No se pudo copiar: el navegador no permite acceder al portapapeles. Usa Descargar SVG.', 'error');
    }
  }

  // ---- global events ------------------------------------------------------------------------
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void loadFile(file, file.name);
  });
  changeButton.addEventListener('click', () => fileInput.click());

  let dragDepth = 0;
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const setDrag = (active: boolean): void => {
    dropOverlay.hidden = !active;
    entry.setDragActive(active);
  };
  removers.push(
    listen<DragEvent>(window, 'dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      setDrag(true);
    }),
    listen<DragEvent>(window, 'dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }),
    listen<DragEvent>(window, 'dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDrag(false);
    }),
    listen<DragEvent>(window, 'drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      setDrag(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) void loadFile(file, file.name);
    }),
    listen<ClipboardEvent>(document, 'paste', (e) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files = items.filter((i) => i.kind === 'file');
      if (files.length === 0) return;
      e.preventDefault();
      const imageItem = files.find((i) => i.type.startsWith('image/'));
      const file = imageItem?.getAsFile() ?? null;
      if (file === null) {
        const message = `El portapapeles no contiene una imagen ${ACCEPTED_FORMATS_LABEL}.`;
        if (loaded === null) entry.setError(message);
        else showNotice(message);
        return;
      }
      const name = file.name && file.name !== 'image.png' ? file.name : 'imagen-pegada.png';
      void loadFile(file, name);
    }),
  );

  // Dev only. The import.meta.env.DEV guard lets production builds drop this dynamic import, and
  // with it src/dev/synth.ts. The module arrives asynchronously: skip it if the app was unmounted.
  if (import.meta.env.DEV && opts.devFixtures === true) {
    import('../dev/fixtures')
      .then(({ buildSynthFixture, parseSynthParam }) => {
        const fixture = destroyed ? null : parseSynthParam(window.location.search);
        if (fixture === null) return;
        const { fileName, image } = buildSynthFixture(fixture);
        void loadImage(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), fileName);
      })
      .catch((err: unknown) => entry.setError(errorMessage(err, 'No se pudieron cargar las imágenes de prueba.')));
  }

  return () => {
    destroyed = true;
    sourceSync.dispose();
    loadSeq++;
    traceSeq++;
    window.clearTimeout(debounce);
    if (tuning) client.cancelTune();
    tuneSeq++;
    for (const remove of removers) remove();
    preview.destroy();
    results.destroy();
    root.replaceChildren();
  };
}
