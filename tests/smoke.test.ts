import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('runs under vitest with the ImageData shim', () => {
    expect(typeof ImageData).toBe('function');
    const img = new ImageData(new Uint8ClampedArray(16), 2, 2);
    expect(img.width).toBe(2);
  });
});
