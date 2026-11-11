import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * End-to-end VM boot test.
 *
 * Boots the real v86 emulator in headless Chromium and runs `echo hello`
 * through the app's command path: `App.vm.exec`, the same sentinel-wrapped
 * serial runner the agent's bash tool uses (src/core/vm/commands.ts).
 *
 * The test skips only when a boot prerequisite is genuinely absent:
 *   - the vendored Alpine 9p rootfs (`images/alpine-fs.json`), built by
 *     `bun run image:build`
 *   - the v86 emulator WASM (`node_modules/v86/build/v86.wasm`)
 *   - network reachability for the v86 BIOS (`copy.sh`)
 *
 * If every prerequisite is present but the VM still fails to boot, the test
 * fails — a broken boot path is a regression, not an environment problem.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const IMAGE_MANIFEST = resolve(ROOT, 'images/alpine-fs.json');
const V86_WASM = resolve(ROOT, 'node_modules/v86/build/v86.wasm');
const BIOS_URL = 'https://copy.sh/v86/bios/seabios.bin';

/**
 * `?net=fetch` turns the app's egress lockdown off. The lockdown allowlist
 * only covers the v86 BIOS and the model CDN, so a same-origin probe of the
 * locally served rootfs manifest would otherwise be blocked and the app would
 * report the image as missing even when it is present.
 */
const APP_URL = '/?net=fetch';

const SHELL_PROMPT = /(?:^|\r?\n)(?:root@)?localhost:[\w/.~-]*[#$]\s*$/m;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

interface GsTestApp {
  vm: {
    running: boolean;
    exec(cmd: string): Promise<CommandResult>;
    onSerial(listener: (chunk: string) => void): void;
  };
}

interface GsTestWindow extends Window {
  __gsApp?: GsTestApp;
  __gsSerial?: string;
}

type BootOutcome = { ready: true } | { failed: string } | null;

async function canReach(url: string, timeoutMs = 15_000): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

test('boots the VM and runs echo hello', async ({ page }) => {
  test.setTimeout(240_000);

  test.skip(
    !existsSync(IMAGE_MANIFEST),
    'VM image artifacts are not built: images/alpine-fs.json is missing. ' +
      'Run `bun run image:build` (requires Docker) to build the Alpine i386 rootfs.',
  );
  test.skip(
    !existsSync(V86_WASM),
    'v86 WASM is missing: node_modules/v86/build/v86.wasm not found. ' +
      'Run `bun install`.',
  );
  test.skip(
    !(await canReach(BIOS_URL)),
    `Cannot reach the v86 BIOS host (${BIOS_URL}); the VM cannot boot without it.`,
  );

  await page.goto(APP_URL);

  // `App.init` builds the chat composer once the module graph has loaded.
  await expect(page.locator('.gs-chat-input')).toBeVisible({ timeout: 120_000 });

  // Capture the live App instance and its raw serial stream. The app does not
  // expose a global handle, so patch the prototype before the start button is
  // clicked; the click handler looks up `start` at call time.
  await page.evaluate(async () => {
    const win = window as unknown as GsTestWindow;
    const appModulePath = '/src/app.ts';
    const mod = (await import(appModulePath)) as {
      App: {
        prototype: {
          start: (...args: unknown[]) => Promise<void>;
          __gsE2eHooked?: boolean;
        };
      };
    };
    const proto = mod.App.prototype;
    if (proto.__gsE2eHooked) return;
    const original = proto.start;
    proto.start = async function (this: GsTestApp, ...args: unknown[]) {
      const w = window as unknown as GsTestWindow;
      w.__gsApp = this;
      w.__gsSerial = '';
      this.vm.onSerial((chunk: string) => {
        w.__gsSerial = (w.__gsSerial ?? '') + chunk;
      });
      return original.apply(this, args);
    };
    proto.__gsE2eHooked = true;
  });

  await page.click('#gs-start');

  // Wait for the guest shell prompt. `#gs-vm` becoming "running" only means
  // the emulator WASM is up; the prompt means Linux has booted far enough to
  // accept a command. A boot failure is reported by the app in the welcome
  // panel, so race that against the prompt instead of timing out blindly.
  const outcome: BootOutcome = await page
    .waitForFunction(
      () => {
        const w = window as unknown as GsTestWindow;
        const hint = Array.from(document.querySelectorAll('.gs-hint'))
          .map((el) => el.textContent ?? '')
          .find((text) => text.startsWith('Boot failed:'));
        if (hint) return { failed: hint };
        if (w.__gsApp?.vm.running && SHELL_PROMPT.test(w.__gsSerial ?? '')) {
          return { ready: true };
        }
        return false;
      },
      null,
      { timeout: 180_000 },
    )
    .then((handle) => handle.jsonValue() as unknown as BootOutcome)
    .catch(() => null);

  if (outcome === null) {
    const serial = await page.evaluate(
      () => (window as unknown as GsTestWindow).__gsSerial ?? '',
    );
    throw new Error(
      `VM did not reach a shell prompt within 180 s. Serial tail:\n${serial.slice(-2_000)}`,
    );
  }
  if ('failed' in outcome) {
    throw new Error(`VM boot failed: ${outcome.failed}`);
  }

  const result = await page.evaluate(async () => {
    const w = window as unknown as GsTestWindow;
    if (!w.__gsApp) throw new Error('GhostShell app handle was not captured');
    return w.__gsApp.vm.exec('echo hello');
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('hello');
});
