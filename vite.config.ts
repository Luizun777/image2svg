import { defineConfig } from 'vite';

export default defineConfig({
  base: '/image2svg/',
  worker: { format: 'es' },
  optimizeDeps: { include: ['esm-potrace-wasm', 'vtracer-web'] },
  build: { target: 'es2022', sourcemap: true },
});
