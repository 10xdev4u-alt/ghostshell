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
      // 80% policy from #29, now met. Measured 2026-11-11 on the v0.1 suite
      // (599 passing tests): statements 93.91%, branches 85.27%,
      // functions 92.22%, lines 93.91%. All four thresholds sit at the policy
      // floor, so any drop below 80% fails CI.
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
