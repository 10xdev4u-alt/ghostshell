import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the VM end-to-end suite.
 *
 * The app is served by the Vite dev server. A static preview of the
 * single-file build would also work, but the dev server starts faster and
 * does not require a 59 MB `dist/single/index.html` to be rebuilt on every
 * change. The dev server sends the COOP/COEP headers v86 needs for threaded
 * WASM (vite.config.ts).
 *
 * v86 boot is slow: the emulator WASM must load, then the guest kernel boots
 * to a shell. The test waits for a real signal (the guest shell prompt), not
 * a fixed sleep, and the timeouts below are safety nets around that wait.
 */

const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  // One VM at a time: v86 allocates 512 MB and owns a single serial port.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // A slow or flaky VM boot must not be papered over with retries in CI.
  retries: 0,
  reporter: 'list',
  // The boot wait itself is 180 s; the test timeout leaves room around it.
  timeout: 240_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: BASE_URL,
    headless: true,
    navigationTimeout: 120_000,
    actionTimeout: 30_000,
    // Keep evidence for a failed boot: screenshot + trace land in
    // test-results/ and are attached to the test report.
    screenshot: 'on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run dev',
    url: BASE_URL,
    // Reuse a already-running dev server locally; never reuse in CI.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
