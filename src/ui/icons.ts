/**
 * Phosphor Regular icons, taken from @phosphor-icons/core (MIT). The license notice sits as a legal
 * comment on SOURCES, the statement that carries the path data into the bundle.
 *
 * The SVG files are imported as text at build time and only their path data is used: every icon
 * keeps Phosphor's 256-unit grid and is filled with currentColor (Regular ships outlined shapes,
 * so there is no stroke to scale). Always decorative: aria-hidden, the accessible name lives on
 * the control.
 */
import check from '@phosphor-icons/core/assets/regular/check.svg?raw';
import copy from '@phosphor-icons/core/assets/regular/copy.svg?raw';
import cornersOut from '@phosphor-icons/core/assets/regular/corners-out.svg?raw';
import downloadSimple from '@phosphor-icons/core/assets/regular/download-simple.svg?raw';
import image from '@phosphor-icons/core/assets/regular/image.svg?raw';
import magnifyingGlassMinus from '@phosphor-icons/core/assets/regular/magnifying-glass-minus.svg?raw';
import magnifyingGlassPlus from '@phosphor-icons/core/assets/regular/magnifying-glass-plus.svg?raw';
import slidersHorizontal from '@phosphor-icons/core/assets/regular/sliders-horizontal.svg?raw';
import uploadSimple from '@phosphor-icons/core/assets/regular/upload-simple.svg?raw';
import warningCircle from '@phosphor-icons/core/assets/regular/warning-circle.svg?raw';
import warning from '@phosphor-icons/core/assets/regular/warning.svg?raw';
import x from '@phosphor-icons/core/assets/regular/x.svg?raw';

const SVG_NS = 'http://www.w3.org/2000/svg';

export type IconName =
  | 'upload'
  | 'download'
  | 'copy'
  | 'check'
  | 'warning'
  | 'error'
  | 'zoomIn'
  | 'zoomOut'
  | 'fit'
  | 'close'
  | 'image'
  | 'sliders';

/*! Phosphor Icons (https://phosphoricons.com): MIT License, Copyright (c) 2023 Phosphor Icons */
const SOURCES: Record<IconName, string> = {
  upload: uploadSimple,
  download: downloadSimple,
  copy,
  check,
  warning,
  error: warningCircle,
  zoomIn: magnifyingGlassPlus,
  zoomOut: magnifyingGlassMinus,
  fit: cornersOut,
  close: x,
  image,
  sliders: slidersHorizontal,
};

/** The d attributes of a Phosphor SVG file (Regular files contain only <path> elements). */
const pathData = (svg: string): readonly string[] => Array.from(svg.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g), (m) => m[1]);

const PATHS = Object.fromEntries(
  Object.entries(SOURCES).map(([name, svg]) => [name, pathData(svg)]),
) as Record<IconName, readonly string[]>;

export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'icon');
  for (const d of PATHS[name]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
