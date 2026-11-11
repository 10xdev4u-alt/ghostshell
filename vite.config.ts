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
  // v86/build/v86.wasm?inline (src/core/vm/wasm.ts) must be treated as an
  // asset in dev too; `.wasm` is not in Vite's default asset types.
  assetsInclude: ['**/*.wasm'],
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
