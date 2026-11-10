import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Development build.
 *
 * COOP/COEP headers are required for threaded WASM (SharedArrayBuffer) and
 * for `postMessage` isolation between the UI and the model worker.
 */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
});
