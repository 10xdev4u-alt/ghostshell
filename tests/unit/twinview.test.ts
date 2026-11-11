import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/lib/events.js';
import type { AppEventMap } from '@/types/index.js';
import type { TerminalHandle } from '@/ui/terminal.js';
import { createTwinView } from '@/ui/twinview.js';

function fakeTerminal(): TerminalHandle {
  return {
    scrollToLine: vi.fn(),
    scrollToText: vi.fn(() => true),
    lineCount: vi.fn(() => 0),
    lineAt: vi.fn(() => undefined),
  } as unknown as TerminalHandle;
}

describe('twin view', () => {
  it('buffers filtered serial lines and records tool ranges', () => {
    const bus = new EventBus<AppEventMap>();
    const twin = createTwinView({ bus });
    twin.attach();

    bus.emit('vm:serial', 'boot\n');
    expect(twin.lineCount()).toBe(1);
    expect(twin.lineAt(0)).toBe('boot');

    const start = twin.beginTool();
    bus.emit('vm:serial', 'tool output\n');
    const range = twin.endTool(start);

    expect(range).toEqual({ start: 1, end: 1 });
    expect(twin.takeRanges()).toEqual([{ start: 1, end: 1 }]);
    expect(twin.takeRanges()).toEqual([]);
  });

  it('stops buffering after detach', () => {
    const bus = new EventBus<AppEventMap>();
    const twin = createTwinView({ bus });
    twin.attach();
    twin.detach();

    bus.emit('vm:serial', 'ignored\n');
    expect(twin.lineCount()).toBe(0);
  });

  it('evicts the oldest lines when the buffer exceeds maxLines', () => {
    const bus = new EventBus<AppEventMap>();
    const twin = createTwinView({ bus, maxLines: 3 });
    twin.attach();

    bus.emit('vm:serial', 'a\nb\nc\nd\n');
    expect(twin.lineCount()).toBe(4);
    expect(twin.lineAt(0)).toBeUndefined();
    expect(twin.lineAt(1)).toBe('b');
    expect(twin.lineAt(3)).toBe('d');
  });

  it('reports an empty range when a tool produces no output', () => {
    const bus = new EventBus<AppEventMap>();
    const twin = createTwinView({ bus });
    twin.attach();

    const start = twin.beginTool();
    const range = twin.endTool(start);
    expect(range).toEqual({ start: 0, end: -1 });
  });

  it('scrolls the terminal to the line text', () => {
    const bus = new EventBus<AppEventMap>();
    const terminal = fakeTerminal();
    const twin = createTwinView({ bus, terminal });
    twin.attach();

    bus.emit('vm:serial', 'output line\n');
    twin.scrollTerminalToLine(0);

    expect(terminal.scrollToLine).toHaveBeenCalledWith(0, 'output line');
  });
});
