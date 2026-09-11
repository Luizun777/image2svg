/**
 * Image decoding on the main thread: File/Blob → ImageData (sRGB, EXIF orientation applied,
 * first frame for GIF). The validation helpers are pure so Node tests can import this module;
 * browser APIs are only touched inside `decodeImageFile` and `create2dContext`.
 */

/** Largest accepted side, in px (the product limit is a 4096 × 4096 input). */
export const MAX_INPUT_SIDE = 4096;

export const ACCEPTED_FORMATS_LABEL = 'PNG, JPG, WebP, GIF o BMP';

/** Value for `<input type="file" accept>`. */
export const ACCEPT_ATTRIBUTE =
  'image/png,image/jpeg,image/webp,image/gif,image/bmp,.png,.jpg,.jpeg,.webp,.gif,.bmp';

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp';

/** Decoding failure whose message is ready to show to the user (Spanish). */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

const NBSP = String.fromCharCode(160);

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

/**
 * Identifies an accepted format from its magic bytes (the declared MIME type is unreliable:
 * pasted images, renamed files). Returns null for anything else (AVIF, TIFF, SVG, HEIC…).
 */
export function sniffImageKind(bytes: Uint8Array): ImageKind | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 'PNG') &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'gif';
  if (bytes.length >= 14 && ascii(bytes, 0, 'BM')) return 'bmp';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp';
  return null;
}

/** Short name of the declared format for messages ("AVIF", "TIFF"), from extension or MIME type. */
export function describeFormat(type: string, name: string): string | null {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  if (ext !== null) return ext[1].toUpperCase();
  const mime = /^image\/(?:x-)?([a-z0-9.+-]+)$/i.exec(type.trim());
  if (mime !== null) return mime[1].replace(/\+xml$/i, '').toUpperCase();
  return null;
}

export function unsupportedFormatMessage(type: string, name: string): string {
  const fmt = describeFormat(type, name);
  return `Formato no admitido${fmt !== null ? ` (${fmt})` : ''}. Usa una imagen ${ACCEPTED_FORMATS_LABEL}.`;
}

/** Spanish error when the decoded size is not accepted, null when it is. */
export function checkDimensions(width: number, height: number): string | null {
  if (!(width > 0 && height > 0)) return 'La imagen no tiene píxeles.';
  if (width > MAX_INPUT_SIDE || height > MAX_INPUT_SIDE) {
    return (
      `La imagen mide ${width}${NBSP}×${NBSP}${height}${NBSP}px y el máximo es ` +
      `${MAX_INPUT_SIDE}${NBSP}×${NBSP}${MAX_INPUT_SIDE}${NBSP}px. Redúcela antes de vectorizarla.`
    );
  }
  return null;
}

export interface Canvas2d {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

/** sRGB 2D context on an OffscreenCanvas when available, else on a detached <canvas>. */
export function create2dContext(width: number, height: number, willReadFrequently = true): Canvas2d {
  const settings: CanvasRenderingContext2DSettings = { colorSpace: 'srgb', willReadFrequently };
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', settings);
    if (ctx !== null) return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', settings);
  if (ctx === null) throw new DecodeError('El navegador no pudo crear un lienzo para leer la imagen.');
  return { canvas, ctx };
}

/**
 * Decodes an image file. Rejects with DecodeError (Spanish message) when the format is not one
 * of PNG/JPG/WebP/GIF/BMP, the file cannot be decoded, or a side exceeds 4096 px.
 */
export async function decodeImageFile(file: Blob, name = ''): Promise<ImageData> {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  if (sniffImageKind(head) === null) throw new DecodeError(unsupportedFormatMessage(file.type, name));

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'default',
    });
  } catch {
    throw new DecodeError(
      'No se pudo leer la imagen: el archivo está dañado o el navegador no puede decodificarlo.',
    );
  }
  try {
    const problem = checkDimensions(bitmap.width, bitmap.height);
    if (problem !== null) throw new DecodeError(problem);
    const { ctx } = create2dContext(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' });
  } finally {
    bitmap.close();
  }
}
