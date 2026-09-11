/**
 * Preview: original raster vs traced SVG in three views (side by side, onion-skin overlay,
 * difference heat-map), synchronized zoom/pan and the node overlay.
 *
 * Content is sized in layout px (not CSS-scaled) so the SVG <img> re-rasterises crisply at every
 * zoom; pan is a translate. One `View` drives every visible pane.
 */
import { h, setText, uid } from './dom';
import { formatInteger, formatZoom } from './format';
import { icon } from './icons';
import type { SvgNodes } from './nodes';
import { extractNodes, viewBoxToScreen } from './nodes';
import { svgDataUrl } from './output';
import type { Size, View, ViewTransform } from './zoom';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  fitView,
  isPixelated,
  panBy,
  stepZoom,
  viewTransform,
  wheelZoom,
  zoomAt,
} from './zoom';

export type PreviewMode = 'side' | 'overlay' | 'diff';

/** Which panes paint the UI's transparency checkerboard under their content. */
export interface PreviewAlpha {
  /** The decoded pixels have transparency. */
  original: boolean;
  /**
   * The SVG may be transparent where the original is not: a painted checkerboard treated as
   * transparent. The Original pane keeps the real pixels, so the two boards look different.
   */
  result: boolean;
}

export interface PreviewView {
  el: HTMLElement;
  setSource(image: ImageData, alpha: PreviewAlpha): void;
  /** Updates the result pane's checkerboard for the SVG on screen. */
  setResultAlpha(transparent: boolean): void;
  /** null: no result yet (skeleton); '': the trace produced no SVG. */
  setSvg(svg: string | null): void;
  setDiff(diff: ImageData | null): void;
  setBusy(busy: boolean): void;
  setError(message: string | null, onRetry?: () => void): void;
  destroy(): void;
}

interface Pane {
  el: HTMLElement;
  label: HTMLElement;
  viewport: HTMLElement;
  content: HTMLElement;
  nodes: HTMLCanvasElement;
  message: HTMLElement;
}

const VIEW_LABEL: Record<PreviewMode, string> = {
  side: 'Lado a lado',
  overlay: 'Superposición',
  diff: 'Diferencias',
};
const PANE_B_LABEL: Record<PreviewMode, string> = { side: 'SVG', overlay: 'Original + SVG', diff: 'Diferencias' };
const PAN_STEP = 48;

export function createPreview(): PreviewView {
  let image: ImageData | null = null;
  let svg: string | null = null;
  let hasDiff = false;
  let mode: PreviewMode = 'side';
  let view: View = { zoom: 1, cx: 0, cy: 0 };
  let showNodes = false;
  let nodes: SvgNodes | null = null;
  let raf = 0;
  let svgToken = 0;
  let spaceDown = false;

  // ---- toolbar ------------------------------------------------------------------------------
  const viewName = uid('preview-view');
  const viewInputs = (Object.keys(VIEW_LABEL) as PreviewMode[]).map((value) => {
    const input = h('input', { type: 'radio', class: 'segmented__input', name: viewName, value, checked: value === mode });
    input.addEventListener('change', () => input.checked && setMode(value));
    return { value, input, label: h('label', { class: 'segmented__option' }, input, h('span', { class: 'segmented__text' }, VIEW_LABEL[value])) };
  });
  const zoomOut = h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Alejar' }, icon('zoomOut'));
  const zoomIn = h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Acercar' }, icon('zoomIn'));
  const zoomValue = h('output', { class: 'zoom__value', 'aria-live': 'polite', 'aria-label': 'Zoom' }, '1×');
  const fit = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, icon('fit'), 'Ajustar');
  const nodesId = uid('show-nodes');
  const nodesToggle = h('input', { type: 'checkbox', class: 'checkbox', id: nodesId });
  const busyText = h('span', { class: 'preview__busy', hidden: true }, 'Trazando…');
  const toolbar = h(
    'div',
    { class: 'preview__toolbar' },
    h(
      'fieldset',
      { class: 'preview__views' },
      h('legend', { class: 'sr-only' }, 'Vista'),
      h('div', { class: 'segmented segmented--inline', style: '--columns: 3' }, ...viewInputs.map((v) => v.label)),
    ),
    h('div', { class: 'zoom', role: 'group', 'aria-label': 'Zoom' }, zoomOut, zoomValue, zoomIn, fit),
    h('div', { class: 'field__check preview__nodes' }, nodesToggle, h('label', { class: 'field__label', for: nodesId }, 'Mostrar nodos')),
    busyText,
  );

  // ---- stage --------------------------------------------------------------------------------
  const createPane = (text: string, kind: 'original' | 'result'): Pane => {
    const label = h('span', { class: 'pane__label' }, text);
    const content = h('div', { class: 'pane__content' });
    const nodesCanvas = h('canvas', { class: 'pane__nodes', 'aria-hidden': 'true', hidden: true });
    const message = h('p', { class: 'pane__message', hidden: true });
    const viewport = h(
      'div',
      {
        class: 'pane__viewport',
        tabindex: 0,
        role: 'group',
        'aria-label': `${text}. Arrastra para mover; Ctrl o ⌘ con la rueda, o las teclas + y -, para ampliar; 0 para ajustar.`,
      },
      content,
      nodesCanvas,
      message,
    );
    const el = h('div', { class: 'pane', 'data-pane': kind }, label, viewport);
    return { el, label, viewport, content, nodes: nodesCanvas, message };
  };
  const paneA = createPane('Original', 'original');
  const paneB = createPane('SVG', 'result');
  const original = h('canvas', { class: 'pane__raster', 'aria-hidden': 'true' });
  const svgImg = h('img', { class: 'pane__svg', alt: 'SVG generado', hidden: true, draggable: 'false' });
  const diffCanvas = h('canvas', { class: 'pane__diff', 'aria-hidden': 'true', hidden: true });
  const skeleton = h('div', { class: 'pane__skeleton', 'aria-hidden': 'true' });
  paneA.content.appendChild(original);
  paneB.content.append(skeleton, svgImg, diffCanvas);

  const progress = h('div', { class: 'stage__progress', hidden: true, 'aria-hidden': 'true' });
  const errorText = h('span', null);
  const retry = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, 'Reintentar');
  const error = h('div', { class: 'stage__error', role: 'alert', hidden: true }, icon('error', 18), errorText, retry);
  let onRetry: (() => void) | undefined;
  retry.addEventListener('click', () => onRetry?.());
  const stage = h('div', { class: 'stage', 'data-view': mode }, progress, paneA.el, paneB.el, error);

  // ---- footer -------------------------------------------------------------------------------
  const opacityId = uid('overlay-opacity');
  const opacity = h('input', { type: 'range', class: 'slider', id: opacityId, min: 0, max: 100, step: 1, value: 50 });
  const opacityValue = h('output', { class: 'field__value', for: opacityId }, '50 %');
  const overlayControl = h(
    'div',
    { class: 'preview__legend overlay-control' },
    h('label', { class: 'field__label', for: opacityId }, 'Opacidad del SVG'),
    opacity,
    opacityValue,
  );
  const diffNote = h('span', null, 'Amarillo: diferencia leve · naranja · rojo: fuerte. Sin color: coincide.');
  const diffLegend = h(
    'div',
    { class: 'preview__legend' },
    h('span', { class: 'legend__ramp', 'aria-hidden': 'true' }),
    diffNote,
  );
  const cornerCount = h('strong', null, '0');
  const curveCount = h('strong', null, '0');
  const nodesLegend = h(
    'div',
    { class: 'preview__legend' },
    h('span', { class: 'legend__corner', 'aria-hidden': 'true' }),
    h('span', null, 'Esquinas ', cornerCount),
    h('span', { class: 'legend__curve', 'aria-hidden': 'true' }),
    h('span', null, 'Curvas ', curveCount),
    h('span', { class: 'legend__hint' }, 'Los picos aparecen como racimos de esquinas.'),
  );
  const footer = h('div', { class: 'preview__footer' }, overlayControl, diffLegend, nodesLegend);

  const el = h('section', { class: 'panel panel--preview', 'aria-label': 'Vista previa' }, toolbar, stage, footer);

  // ---- behaviour ----------------------------------------------------------------------------
  const imageSize = (): Size => ({ width: image?.width ?? 1, height: image?.height ?? 1 });
  const viewportSize = (pane: Pane): Size => ({ width: pane.viewport.clientWidth, height: pane.viewport.clientHeight });
  const visiblePanes = (): Pane[] => (mode === 'side' ? [paneA, paneB] : [paneB]);

  function schedule(): void {
    if (raf === 0) raf = requestAnimationFrame(layout);
  }

  function setView(next: View): void {
    view = next;
    schedule();
  }

  function layout(): void {
    raf = 0;
    if (image === null) return;
    const img = imageSize();
    for (const pane of visiblePanes()) {
      const vp = viewportSize(pane);
      if (vp.width === 0 || vp.height === 0) continue;
      const t = viewTransform(view, vp, img);
      pane.content.style.width = `${img.width * t.scale}px`;
      pane.content.style.height = `${img.height * t.scale}px`;
      pane.content.style.transform = `translate(${t.tx}px, ${t.ty}px)`;
      pane.content.classList.toggle('is-pixelated', isPixelated(t.scale));
      if (pane === paneB) drawNodes(vp, t);
    }
    setText(zoomValue, formatZoom(view.zoom));
    zoomOut.disabled = view.zoom <= MIN_ZOOM + 1e-9;
    zoomIn.disabled = view.zoom >= MAX_ZOOM - 1e-9;
  }

  function drawNodes(vp: Size, t: ViewTransform): void {
    const canvas = paneB.nodes;
    const root = nodes?.root ?? null;
    if (!showNodes || nodes === null || root === null || image === null) {
      canvas.hidden = true;
      return;
    }
    canvas.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(vp.width * dpr);
    const ch = Math.round(vp.height * dpr);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vp.width, vp.height);
    const m = viewBoxToScreen(root.viewBox, {
      left: t.tx,
      top: t.ty,
      width: image.width * t.scale,
      height: image.height * t.scale,
    });
    const styles = getComputedStyle(stage);
    const halo = styles.getPropertyValue('--node-halo').trim() || '#ffffff';
    const plot = (points: Float64Array, color: string, square: boolean): void => {
      ctx.beginPath();
      for (let i = 0; i < points.length; i += 2) {
        const x = m.offsetX + points[i] * m.scale;
        const y = m.offsetY + points[i + 1] * m.scale;
        if (x < -4 || y < -4 || x > vp.width + 4 || y > vp.height + 4) continue;
        if (square) ctx.rect(x - 2.5, y - 2.5, 5, 5);
        else {
          ctx.moveTo(x + 2.5, y);
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        }
      }
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = halo;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fill();
    };
    plot(nodes.curves, styles.getPropertyValue('--overlay-curve').trim() || '#2563eb', false);
    plot(nodes.corners, styles.getPropertyValue('--overlay-corner').trim() || '#e11d48', true);
  }

  function refreshFooter(): void {
    overlayControl.hidden = mode !== 'overlay';
    diffLegend.hidden = mode !== 'diff';
    nodesLegend.hidden = !showNodes;
    footer.hidden = overlayControl.hidden && diffLegend.hidden && nodesLegend.hidden;
    if (mode === 'diff') {
      setText(
        diffNote,
        svg === '' || image === null
          ? 'No hay SVG con el que comparar.'
          : hasDiff
            ? 'Amarillo: diferencia leve · naranja · rojo: fuerte. Sin color: coincide.'
            : 'Calculando diferencias…',
      );
    }
    schedule();
  }

  function refreshMessage(): void {
    const message = svg === '' ? 'No se generó el SVG. Revisa el aviso de arriba.' : null;
    paneB.message.hidden = message === null;
    setText(paneB.message, message ?? '');
    skeleton.hidden = svg !== null;
    svgImg.hidden = svg === null || svg === '';
  }

  function setMode(next: PreviewMode): void {
    mode = next;
    stage.dataset.view = next;
    if (next === 'side') paneA.content.appendChild(original);
    else paneB.content.insertBefore(original, paneB.content.firstChild);
    setText(paneB.label, PANE_B_LABEL[next]);
    svgImg.style.opacity = next === 'overlay' ? String(Number(opacity.value) / 100) : '';
    for (const v of viewInputs) v.input.checked = v.value === next;
    refreshFooter();
  }

  function ensureNodes(): void {
    if (showNodes && nodes === null && svg !== null && svg !== '') nodes = extractNodes(svg);
    setText(cornerCount, formatInteger(nodes?.cornerCount ?? 0));
    setText(curveCount, formatInteger(nodes?.curveCount ?? 0));
  }

  const centre = (pane: Pane): { x: number; y: number } => ({
    x: pane.viewport.clientWidth / 2,
    y: pane.viewport.clientHeight / 2,
  });

  function zoomStep(direction: 1 | -1): void {
    const pane = paneB;
    setView(zoomAt(view, stepZoom(view.zoom, direction), centre(pane), viewportSize(pane), imageSize()));
  }

  function bindViewport(pane: Pane): void {
    let drag: { id: number; x: number; y: number } | null = null;
    const vp = pane.viewport;
    vp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || image === null) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      vp.setPointerCapture(e.pointerId);
      stage.classList.add('is-dragging');
    });
    vp.addEventListener('pointermove', (e) => {
      if (drag === null || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      setView(panBy(view, dx, dy, viewportSize(pane), imageSize()));
    });
    const end = (): void => {
      drag = null;
      stage.classList.remove('is-dragging');
    };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);
    vp.addEventListener('lostpointercapture', end);
    vp.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || image === null) return;
        e.preventDefault();
        const r = vp.getBoundingClientRect();
        setView(
          zoomAt(view, wheelZoom(view.zoom, e.deltaY, e.deltaMode), { x: e.clientX - r.left, y: e.clientY - r.top }, viewportSize(pane), imageSize()),
        );
      },
      { passive: false },
    );
    vp.addEventListener('keydown', (e) => {
      if (image === null || e.altKey || e.ctrlKey || e.metaKey) return;
      const size = viewportSize(pane);
      let handled = true;
      switch (e.key) {
        case '+':
        case '=':
          zoomStep(1);
          break;
        case '-':
        case '_':
          zoomStep(-1);
          break;
        case '0':
          setView(fitView(imageSize()));
          break;
        case 'ArrowLeft':
          setView(panBy(view, PAN_STEP, 0, size, imageSize()));
          break;
        case 'ArrowRight':
          setView(panBy(view, -PAN_STEP, 0, size, imageSize()));
          break;
        case 'ArrowUp':
          setView(panBy(view, 0, PAN_STEP, size, imageSize()));
          break;
        case 'ArrowDown':
          setView(panBy(view, 0, -PAN_STEP, size, imageSize()));
          break;
        case ' ':
          if (!spaceDown) stage.classList.add('is-space');
          spaceDown = true;
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    });
    vp.addEventListener('keyup', (e) => {
      if (e.key === ' ') {
        spaceDown = false;
        stage.classList.remove('is-space');
      }
    });
    vp.addEventListener('blur', () => {
      spaceDown = false;
      stage.classList.remove('is-space');
    });
  }

  bindViewport(paneA);
  bindViewport(paneB);
  zoomIn.addEventListener('click', () => zoomStep(1));
  zoomOut.addEventListener('click', () => zoomStep(-1));
  fit.addEventListener('click', () => setView(fitView(imageSize())));
  nodesToggle.addEventListener('change', () => {
    showNodes = nodesToggle.checked;
    ensureNodes();
    refreshFooter();
  });
  opacity.addEventListener('input', () => {
    setText(opacityValue, `${opacity.value} %`);
    opacity.style.setProperty('--fill', `${opacity.value}%`);
    if (mode === 'overlay') svgImg.style.opacity = String(Number(opacity.value) / 100);
  });
  opacity.style.setProperty('--fill', '50%');

  const resize = new ResizeObserver(() => schedule());
  resize.observe(stage);
  setMode('side');
  refreshMessage();

  return {
    el,
    setSource(next, alpha) {
      image = next;
      original.width = next.width;
      original.height = next.height;
      original.getContext('2d')?.putImageData(next, 0, 0);
      paneA.content.classList.toggle('has-alpha', alpha.original);
      paneB.content.classList.toggle('has-alpha', alpha.result);
      view = fitView(imageSize());
      this.setSvg(null);
      this.setDiff(null);
      schedule();
    },
    setSvg(next) {
      svg = next;
      nodes = null;
      const token = ++svgToken;
      if (next !== null && next !== '') {
        const url = svgDataUrl(next);
        // Decode off-screen first so the previous result stays visible until the new one is ready.
        const loader = new Image();
        loader.src = url;
        loader
          .decode()
          .catch(() => undefined)
          .then(() => {
            if (token === svgToken) svgImg.src = url;
          });
      } else {
        svgImg.removeAttribute('src');
      }
      ensureNodes();
      refreshMessage();
      refreshFooter();
    },
    setResultAlpha(transparent) {
      paneB.content.classList.toggle('has-alpha', transparent);
    },
    setDiff(diff) {
      hasDiff = diff !== null;
      diffCanvas.hidden = diff === null;
      if (diff !== null) {
        diffCanvas.width = diff.width;
        diffCanvas.height = diff.height;
        diffCanvas.getContext('2d')?.putImageData(diff, 0, 0);
      }
      refreshFooter();
    },
    setBusy(busy) {
      progress.hidden = !busy;
      busyText.hidden = !busy;
      stage.setAttribute('aria-busy', busy ? 'true' : 'false');
    },
    setError(message, retryHandler) {
      error.hidden = message === null;
      // No endless skeleton behind an error when there is no previous result.
      skeleton.hidden = svg !== null || message !== null;
      setText(errorText, message ?? '');
      onRetry = retryHandler;
      retry.hidden = retryHandler === undefined;
    },
    destroy() {
      resize.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
      svgToken++;
    },
  };
}
