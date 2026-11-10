import { defineConfig } from 'vitest/config';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  // Required for the inlined v86.wasm asset import (src/core/vm/wasm.ts).
  assetsInclude: ['**/*.wasm'],
  server: {
    fs: {
      // node_modules can be a symlink to a directory outside the workspace
      // (a shared store). Vite denies transforming files outside the root,
      // which breaks inlined asset imports such as `v86/build/v86.wasm?inline`.
      allow: [
        resolve(import.meta.dirname),
        realpathSync(resolve(import.meta.dirname, 'node_modules')),
      ],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // The 80% gate is tracked in #67 and enabled once the v0.1 modules have
      // tests. Until then coverage is reported, not enforced.
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
