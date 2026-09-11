import { describe, expect, it } from 'vitest';
import { assembleSvg } from '../../src/svg/assemble';
import { pathStats } from '../../src/svg/pathStats';
import type { AbsPath, Layer, Seg } from '../../src/types';
import { extractNodes, parseSvgRoot, viewBoxToScreen } from '../../src/ui/nodes';

const M = (x: number, y: number): Seg => ({ kind: 'M', x, y });
const L = (x: number, y: number): Seg => ({ kind: 'L', x, y });
const C = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): Seg => ({
  kind: 'C',
  x1,
  y1,
  x2,
  y2,
  x,
  y,
});
const Q = (x1: number, y1: number, x: number, y: number): Seg => ({ kind: 'Q', x1, y1, x, y });
const Z: Seg = { kind: 'Z' };

function pairs(a: Float64Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < a.length; i += 2) out.push(`${a[i]},${a[i + 1]}`);
  return out.sort();
}

describe('extractNodes', () => {
  const square: AbsPath = { segs: [M(16, 16), L(48, 16), L(48, 48), L(16, 48), Z] };
  const blob: AbsPath = {
    segs: [M(10, 0), C(15, 0, 20, 5, 20, 10), C(20, 15, 15, 20, 10, 20), Q(0, 20, 0, 10), L(10, 0), Z],
  };
  const layers: Layer[] = [
    { fill: '#000000', paths: [square] },
    { fill: '#2563eb', paths: [blob] },
  ];
  const svg = assembleSvg(layers, {
    width: 16,
    height: 16,
    viewBoxWidth: 64,
    viewBoxHeight: 64,
    background: [255, 255, 255],
  });

  it('classifies L end points as corners and C/Q end points as curves, like pathStats', () => {
    const nodes = extractNodes(svg);
    const stats = pathStats(layers, svg.length);
    expect(nodes.cornerCount).toBe(stats.lineCount);
    expect(nodes.curveCount).toBe(stats.curveCount);
    expect(nodes.cornerCount).toBe(4);
    expect(nodes.curveCount).toBe(3);
    expect(pairs(nodes.corners)).toEqual(['10,0', '16,48', '48,16', '48,48']);
    expect(pairs(nodes.curves)).toEqual(['0,10', '10,20', '20,10']);
    expect(nodes.skippedPaths).toBe(0);
    expect(nodes.root).toEqual({ width: 16, height: 16, viewBox: { x: 0, y: 0, width: 64, height: 64 } });
  });

  it('applies group transforms (potrace-style output)', () => {
    const potrace =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<g transform="translate(0,16) scale(0.1,-0.1)"><path d="M40 80 l0 -40 40 0 40 0 0 40z"/></g></svg>';
    const nodes = extractNodes(potrace);
    expect(nodes.cornerCount).toBe(4);
    expect(pairs(nodes.corners)).toEqual(['12,12', '12,8', '4,12', '8,12']);
  });

  it('reads the relative rectangles of pixel mode', () => {
    const pixel =
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 2 2" shape-rendering="crispEdges">' +
      '<path fill="#ff0000" d="m0 0h1v1h-1z"/></svg>';
    const nodes = extractNodes(pixel);
    expect(nodes.curveCount).toBe(0);
    expect(pairs(nodes.corners)).toEqual(['0,1', '1,0', '1,1']);
  });

  it('skips unparseable paths instead of throwing', () => {
    const bad =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4">' +
      '<path d="M0 0 A 2 2 0 0 1 4 4"/><path d="M0 0L4 0L4 4Z"/></svg>';
    const nodes = extractNodes(bad);
    expect(nodes.skippedPaths).toBe(1);
    expect(nodes.cornerCount).toBe(2);
  });
});

describe('parseSvgRoot', () => {
  it('falls back to width/height without viewBox and accepts px units', () => {
    expect(parseSvgRoot('<svg width="10px" height="20">')).toEqual({
      width: 10,
      height: 20,
      viewBox: { x: 0, y: 0, width: 10, height: 20 },
    });
    expect(parseSvgRoot('<svg viewBox="0,0,32,16">')).toEqual({
      width: 32,
      height: 16,
      viewBox: { x: 0, y: 0, width: 32, height: 16 },
    });
    expect(parseSvgRoot('<svg>')).toBeNull();
    expect(parseSvgRoot('<path d="M0 0"/>')).toBeNull();
  });
});

describe('viewBoxToScreen', () => {
  it('maps viewBox units onto the displayed box (xMidYMid meet)', () => {
    expect(viewBoxToScreen({ x: 0, y: 0, width: 64, height: 64 }, { left: 10, top: 20, width: 32, height: 32 })).toEqual({
      scale: 0.5,
      offsetX: 10,
      offsetY: 20,
    });
    expect(viewBoxToScreen({ x: 0, y: 0, width: 100, height: 50 }, { left: 0, top: 0, width: 200, height: 200 })).toEqual({
      scale: 2,
      offsetX: 0,
      offsetY: 50,
    });
    const m = viewBoxToScreen({ x: 10, y: 10, width: 10, height: 10 }, { left: 0, top: 0, width: 100, height: 100 });
    expect(m.offsetX + 10 * m.scale).toBe(0);
    expect(m.offsetY + 20 * m.scale).toBe(100);
  });
});
