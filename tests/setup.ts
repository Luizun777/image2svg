// Test-only environment shims.
// 1) esm-potrace-wasm's emscripten loader takes the Node branch (require/__dirname) when
//    process.versions.node is set and process.type !== 'renderer'; in ESM that throws.
//    Marking the process as an Electron-style renderer makes it take the browser branch,
//    which only needs the inlined wasm. Must run before the module is imported.
(process as unknown as { type?: string }).type = 'renderer';

// 2) Minimal ImageData for Node (esm-potrace-wasm reads .data/.width/.height only).
if (typeof (globalThis as { ImageData?: unknown }).ImageData === 'undefined') {
  class ImageDataShim {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly colorSpace = 'srgb';
    constructor(data: Uint8ClampedArray | number, width: number, height?: number) {
      if (typeof data === 'number') {
        this.width = data;
        this.height = width;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else {
        this.data = data;
        this.width = width;
        this.height = height ?? data.length / 4 / width;
      }
    }
  }
  (globalThis as { ImageData?: unknown }).ImageData = ImageDataShim;
}
