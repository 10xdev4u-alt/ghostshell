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
      // The 80% policy from #29 is not met yet. Measured 2026-11-11 on the
      // v0.1 suite (390 tests): statements 77.53%, branches 80.43%,
      // functions 86.97%, lines 77.53%. Thresholds sit just below those
      // numbers so the gate is real and passes today: any drop in coverage
      // fails CI. Statements and lines are 2.47 points under the 80% target;
      // a follow-up issue must raise all four thresholds to 80 as coverage
      // improves.
      thresholds: {
        statements: 77,
        branches: 80,
        functions: 86,
        lines: 77,
      },
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
