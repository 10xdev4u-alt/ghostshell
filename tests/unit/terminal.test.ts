import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/lib/events.js';
import type { AppEventMap } from '@/types/index.js';

/**
 * Terminal wrapper tests.
 *
 * xterm.js and its fit addon are replaced with recording fakes; the wrapper's
 * buffer access, text search, scroll fallback, fit error swallowing, and bus
 * subscription are the behavior under test.
 */

const { TerminalMock, FitAddonMock } = vi.hoisted(() => {
  class MockBuffer {
    lines: string[];

    constructor() {
      this.lines = [];
    }

    get length(): number {
      return this.lines.length;
    }

    getLine(index: number): { translateToString: (trim: boolean) => string } | undefined {
      const line = this.lines[index];
      if (line === undefined) return undefined;
      return { translateToString: () => line };
    }
  }

  class MockTerminal {
    static instances: MockTerminal[] = [];
    buffer = { active: new MockBuffer() };
    loadedAddons: unknown[] = [];
    opened: unknown[] = [];
    written: string[] = [];
    scrollCalls: number[] = [];
    scrollThrows = false;
    disposed = 0;

    constructor(public options: Record<string, unknown>) {
      MockTerminal.instances.push(this);
    }

    loadAddon(addon: unknown): void {
      this.loadedAddons.push(addon);
    }

    open(container: unknown): void {
      this.opened.push(container);
    }

    write(data: string): void {
      this.written.push(data);
    }

    writeln(data: string): void {
      this.written.push(`${data}\n`);
    }

    clear(): void {}

    focus(): void {}

    scrollToLine(line: number): void {
      if (this.scrollThrows) throw new Error('line out of range');
      this.scrollCalls.push(line);
    }

    dispose(): void {
      this.disposed += 1;
    }
  }

  class MockFitAddon {
    fits = 0;
    fitThrows = false;

    fit(): void {
      if (this.fitThrows) throw new Error('container has no dimensions');
      this.fits += 1;
    }
  }

  return { TerminalMock: MockTerminal, FitAddonMock: MockFitAddon };
});

vi.mock('@xterm/xterm', () => ({ Terminal: TerminalMock }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FitAddonMock }));

import { createTerminal } from '@/ui/terminal.js';

const container = { id: 'terminal' } as unknown as HTMLElement;

beforeEach(() => {
  TerminalMock.instances.length = 0;
  vi.clearAllMocks();
});

describe('createTerminal', () => {
  it('creates the xterm instance, loads the fit addon, and opens the container', () => {
    createTerminal(container);

    const terminal = TerminalMock.instances[0]!;
    expect(terminal.opened).toEqual([container]);
    expect(terminal.loadedAddons).toHaveLength(1);
    expect(terminal.loadedAddons[0]).toBeInstanceOf(FitAddonMock);
    expect(terminal.options['scrollback']).toBe(10_000);
    expect(terminal.options['convertEol']).toBe(true);
  });

  it('delegates write, writeln, clear, and focus', () => {
    const handle = createTerminal(container);
    const terminal = TerminalMock.instances[0]!;

    handle.write('a');
    handle.writeln('b');
    handle.clear();
    handle.focus();

    expect(terminal.written).toEqual(['a', 'b\n']);
  });

  it('reads buffer lines and reports the line count', () => {
    const handle = createTerminal(container);
    const terminal = TerminalMock.instances[0]!;
    terminal.buffer.active.lines.push('hello', 'world');

    expect(handle.lineCount()).toBe(2);
    expect(handle.lineAt(0)).toBe('hello');
    expect(handle.lineAt(1)).toBe('world');
    expect(handle.lineAt(2)).toBeUndefined();
  });

  it('scrolls to the first buffer line containing the text', () => {
    const handle = createTerminal(container);
    const terminal = TerminalMock.instances[0]!;
    terminal.buffer.active.lines.push('abc', 'def');

    expect(handle.scrollToText('def')).toBe(true);
    expect(terminal.scrollCalls).toEqual([1]);
  });

  it('refuses empty text and absent matches', () => {
    const handle = createTerminal(container);
    const terminal = TerminalMock.instances[0]!;
    terminal.buffer.active.lines.push('abc');

    expect(handle.scrollToText('   ')).toBe(false);
    expect(handle.scrollToText('zzz')).toBe(false);
    expect(terminal.scrollCalls).toEqual([]);
  });

  it('returns false when scrolling to a match throws', () => {
    const handle = createTerminal(container);
    const terminal = TerminalMock.instances[0]!;
    terminal.buffer.active.lines.push('abc');
    terminal.scrollThrows = true;

    expect(handle.scrollToText('abc')).toBe(false);
  });

  it('scrolls directly when the buffer line matches the text', () => {
    const handle = createTerminal(container);
    const terminal = TerminalMock.instances[0]!;
    terminal.buffer.active.lines.push('abc');

    handle.scrollToLine(0, 'abc');
    expect(terminal.scrollCalls).toEqual([0]);
  });

  it('falls back to a text search when the line index is out of range', () => {
    const handle = createTerminal(container);
    const terminal = TerminalMock.instances[0]!;
    terminal.buffer.active.lines.push('abc', 'def');

    handle.scrollToLine(9, 'def');
    expect(terminal.scrollCalls).toEqual([1]);
  });

  it('falls back to a text search when the line text does not match', () => {
    const handle = createTerminal(container);
    const terminal = TerminalMock.instances[0]!;
    terminal.buffer.active.lines.push('abc', 'def');

    handle.scrollToLine(0, 'def');
    expect(terminal.scrollCalls).toEqual([1]);
  });

  it('swallows an out-of-range scroll without text', () => {
    const handle = createTerminal(container);
    const terminal = TerminalMock.instances[0]!;
    terminal.scrollThrows = true;

    expect(() => handle.scrollToLine(5)).not.toThrow();
  });

  it('swallows a fit failure when the container is not visible', () => {
    const handle = createTerminal(container);
    const terminal = TerminalMock.instances[0]!;
    const fit = terminal.loadedAddons[0] as InstanceType<typeof FitAddonMock>;
    fit.fitThrows = true;

    expect(() => handle.fit()).not.toThrow();
  });

  it('writes bus serial events to the terminal', () => {
    const bus = new EventBus<AppEventMap>();
    createTerminal(container, bus);
    const terminal = TerminalMock.instances[0]!;

    bus.emit('vm:serial', 'hello\n');
    expect(terminal.written).toEqual(['hello\n']);
  });

  it('unsubscribes and disposes on dispose', () => {
    const bus = new EventBus<AppEventMap>();
    const handle = createTerminal(container, bus);
    const terminal = TerminalMock.instances[0]!;

    handle.dispose();
    bus.emit('vm:serial', 'after\n');

    expect(terminal.written).toEqual([]);
    expect(terminal.disposed).toBe(1);
  });
});
