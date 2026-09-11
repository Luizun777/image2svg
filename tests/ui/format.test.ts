import { describe, expect, it } from 'vitest';
import {
  NBSP,
  fidelityExplanation,
  fidelityLevel,
  formatBytes,
  formatDecimal,
  formatDimensions,
  formatInteger,
  formatMs,
  formatPercent,
  formatSigned,
  formatZoom,
  withErrorContext,
} from '../../src/ui/format';

describe('formatDecimal / formatSigned', () => {
  it('uses a decimal comma with fixed decimals', () => {
    expect(formatDecimal(0.99347, 3)).toBe('0,993');
    expect(formatDecimal(12, 2)).toBe('12,00');
    expect(formatDecimal(1853, 0)).toBe('1853');
  });

  it('never prints a negative zero and marks non-finite values', () => {
    expect(formatDecimal(-0.0001, 2)).toBe('0,00');
    expect(formatDecimal(-0, 0)).toBe('0');
    expect(formatDecimal(Number.NaN, 2)).toBe('n/d');
  });

  it('signs non-zero values only', () => {
    expect(formatSigned(0.05, 2)).toBe('+0,05');
    expect(formatSigned(-0.1, 2)).toBe('-0,10');
    expect(formatSigned(0, 2)).toBe('0,00');
    expect(formatSigned(-0.001, 2)).toBe('0,00');
  });
});

describe('formatInteger', () => {
  it('groups thousands with a non-breaking space from five digits on', () => {
    expect(formatInteger(1853)).toBe('1853');
    expect(formatInteger(60446)).toBe(`60${NBSP}446`);
    expect(formatInteger(2070717)).toBe(`2${NBSP}070${NBSP}717`);
    expect(formatInteger(-12345)).toBe(`-12${NBSP}345`);
    expect(formatInteger(12.6)).toBe('13');
  });
});

describe('units', () => {
  it('formats percentages from fractions', () => {
    expect(formatPercent(0.9874)).toBe(`98,7${NBSP}%`);
    expect(formatPercent(1)).toBe(`100,0${NBSP}%`);
    expect(formatPercent(0.0123, 2)).toBe(`1,23${NBSP}%`);
  });

  it('formats sizes in binary units', () => {
    expect(formatBytes(512)).toBe(`512${NBSP}B`);
    expect(formatBytes(70527)).toBe(`68,9${NBSP}KB`); // 68.87 KB
    expect(formatBytes(153600)).toBe(`150${NBSP}KB`);
    expect(formatBytes(2391810)).toBe(`2,28${NBSP}MB`); // 2.281 MB
    expect(formatBytes(-1)).toBe('n/d');
  });

  it('formats durations', () => {
    expect(formatMs(412.4)).toBe(`412${NBSP}ms`);
    expect(formatMs(1234)).toBe(`1,2${NBSP}s`);
  });

  it('formats dimensions and zoom', () => {
    expect(formatDimensions(512, 256)).toBe(`512${NBSP}×${NBSP}256${NBSP}px`);
    expect(formatZoom(1)).toBe('1×');
    expect(formatZoom(1.5)).toBe('1,5×');
    expect(formatZoom(12)).toBe('12×');
    expect(formatZoom(2.04)).toBe('2×');
  });
});

describe('fidelityLevel', () => {
  it('uses the thresholds 97 % (ok) and 90 % (warn) on the displayed value', () => {
    expect(fidelityLevel(1)).toBe('ok');
    expect(fidelityLevel(0.97)).toBe('ok');
    expect(fidelityLevel(0.96951)).toBe('ok'); // shown as 97,0 %
    expect(fidelityLevel(0.9694)).toBe('warn'); // 96,9 %
    expect(fidelityLevel(0.9)).toBe('warn');
    expect(fidelityLevel(0.89951)).toBe('warn'); // 90,0 %
    expect(fidelityLevel(0.8994)).toBe('bad'); // 89,9 %
    expect(fidelityLevel(0)).toBe('bad');
  });

  it('explains the score per mode in one line', () => {
    const lines = fidelityExplanation('lines');
    expect(lines).toContain('SSIM');
    expect(lines).toContain('formas (IoU)');
    expect(fidelityExplanation('flat')).toContain('color píxel a píxel');
    expect(lines).not.toMatch(/\n|—/);
  });
});

describe('withErrorContext', () => {
  it('adds the UI context to bare or client-level messages', () => {
    expect(withErrorContext('No se pudo vectorizar', 'El procesador de imágenes falló y se reinició (se cayó).')).toBe(
      'No se pudo vectorizar: El procesador de imágenes falló y se reinició (se cayó).',
    );
    expect(withErrorContext('No se pudo medir la fidelidad', 'error desconocido.')).toBe(
      'No se pudo medir la fidelidad: error desconocido.',
    );
  });

  it('does not repeat the operation when the worker already named it', () => {
    const worker = 'No se pudo vectorizar la imagen: potrace: Aborted(OOM)';
    expect(withErrorContext('No se pudo vectorizar', worker)).toBe(worker);
    const compare = 'No se pudo comparar el resultado con la imagen original: la imagen renderizada mide 48×48 px';
    expect(withErrorContext('No se pudo medir la fidelidad', compare)).toBe(compare);
    const start = 'No se pudo iniciar el procesador de imágenes: Worker is not defined';
    expect(withErrorContext('No se pudo iniciar el motor de trazado', start)).toBe(start);
    // Only the whole words count: "No se pudiera…" is not a worker sentence.
    expect(withErrorContext('Contexto', 'No se pudieron leer los datos')).toBe('Contexto: No se pudieron leer los datos');
  });
});
