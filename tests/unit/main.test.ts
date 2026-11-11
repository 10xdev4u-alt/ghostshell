import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Entry-point tests. `main.ts` runs `boot()` on import, so each test resets
 * the module registry and re-imports it with a fresh App fake. The success
 * path must stamp the version and register the beforeunload cleanup; the
 * failure path must log and surface a hint instead of crashing the page.
 */

const { FakeApp } = vi.hoisted(() => {
  class FakeApp {
    static initImpl: () => Promise<void> = async () => undefined;
    static last: FakeApp | null = null;
    initCalls = 0;
    disposed = 0;

    constructor() {
      FakeApp.last = this;
    }

    init(): Promise<void> {
      this.initCalls += 1;
      return FakeApp.initImpl();
    }

    dispose(): void {
      this.disposed += 1;
    }
  }

  return { FakeApp };
});

vi.mock('@/app.js', () => ({ App: FakeApp }));

import { APP_VERSION } from '@/config.js';

class FakeElement {
  tagName: string;
  textContent = '';
  className = '';
  children: FakeElement[] = [];

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
}

function installDocument() {
  const version = new FakeElement('span');
  const welcome = new FakeElement('div');
  vi.stubGlobal('document', {
    getElementById: (id: string) => (id === 'gs-version' ? version : null),
    querySelector: (selector: string) => (selector === '.gs-welcome' ? welcome : null),
    createElement: (tagName: string) => new FakeElement(tagName),
  });
  return { version, welcome };
}

describe('main boot', () => {
  beforeEach(() => {
    FakeApp.initImpl = async () => undefined;
    FakeApp.last = null;
    vi.resetModules();
  });

  it('stamps the version and registers beforeunload cleanup', async () => {
    const { version } = installDocument();
    const listeners: Array<() => void> = [];
    vi.stubGlobal('addEventListener', (type: string, fn: () => void) => {
      if (type === 'beforeunload') listeners.push(fn);
    });

    await import('@/main.js');
    await vi.waitFor(() => expect(version.textContent).toBe(`v${APP_VERSION}`));
    expect(FakeApp.last).not.toBeNull();
    expect(FakeApp.last!.initCalls).toBe(1);
    expect(listeners).toHaveLength(1);

    listeners[0]!();
    expect(FakeApp.last!.disposed).toBe(1);
    vi.unstubAllGlobals();
  });

  it('logs init failures and renders a hint in the welcome panel', async () => {
    const { welcome } = installDocument();
    vi.stubGlobal('addEventListener', () => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    FakeApp.initImpl = () => Promise.reject(new Error('boot exploded'));

    await import('@/main.js');
    await vi.waitFor(() => expect(welcome.children).toHaveLength(1));

    const hint = welcome.children[0]!;
    expect(hint.className).toBe('gs-hint');
    expect(hint.textContent).toBe('Failed to start: boot exploded');
    expect(error).toHaveBeenCalledWith('[ghostshell] init failed', expect.any(Error));
    vi.unstubAllGlobals();
    error.mockRestore();
  });
});
