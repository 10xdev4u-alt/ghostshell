import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Release build: one self-contained HTML file.
 *
 * Everything (JS, WASM glue, CSS, fonts) is inlined. The only network call at
 * runtime is the model weight download from a CDN, cached into OPFS/IndexedDB.
 *
 * Note: COOP/COEP must be served by the host (Netlify/Cloudflare Pages) for
 * threaded WASM. GitHub Pages works but falls back to single-threaded.
 */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
    cssCodeSplit: false,
    sourcemap: false,
    minify: 'esbuild',
  },
  worker: {
    format: 'es',
    plugins: () => [],
  },
});
