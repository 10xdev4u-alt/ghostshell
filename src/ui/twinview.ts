import { EventBus } from '@/lib/events.js';
import type { AppEventMap } from '@/types/index.js';
import type { TerminalHandle } from './terminal.js';
import type { LineRange } from './lineRange.js';

/**
 * Twin-View: keeps the chat pane and the raw serial terminal in sync.
 *
 * The filtered serial stream is buffered into a logical line ring. When a tool
 * call starts, `beginTool()` records the current line index; when it finishes,
 * `endTool(start)` returns the inclusive range of lines the tool produced.
 * The chat panel renders those ranges as jump links, and clicking one scrolls
 * the terminal to the first line of the range.
 *
 * This is the feature that makes the agent legible
 * (docs/CREATIVE_INNOVATION.md §1.1).
 */

export interface TwinViewOptions {
  bus: EventBus<AppEventMap>;
  /** The terminal to scroll. Omit to make scrolling a no-op. */
  terminal?: TerminalHandle | undefined;
  /** Maximum logical lines retained (oldest lines are dropped). */
  maxLines?: number;
}

export interface TwinView {
  attach(): void;
  detach(): void;
  /** Mark the start of a tool call. Returns the line index the next output line gets. */
  beginTool(): number;
  /** Mark the end of a tool call and return its line range. */
  endTool(start: number): LineRange;
  /** Drain the ranges recorded since the last call. */
  takeRanges(): LineRange[];
  /** Total number of logical lines buffered (including dropped history). */
  lineCount(): number;
  /** The logical line at `index`, or undefined when out of range. */
  lineAt(index: number): string | undefined;
  /** Scroll the terminal so the line at `line` is visible. */
  scrollTerminalToLine(line: number): void;
}

/**
 * Create a twin-view. Accepts either the full options object or a bare event
 * bus (the latter keeps the pre-wiring call site in `app.ts` working).
 */
export function createTwinView(options: TwinViewOptions | EventBus<AppEventMap>): TwinView {
  const normalized: TwinViewOptions = options instanceof EventBus ? { bus: options } : options;
  const { bus, terminal } = normalized;
  const maxLines = normalized.maxLines ?? 10_000;

  let lines: string[] = [];
  let baseOffset = 0;
  let pending = '';
  let attached = false;
  let unsubscribe: (() => void) | null = null;
  const ranges: LineRange[] = [];

  const pushLine = (line: string): void => {
    lines.push(line);
    if (lines.length > maxLines) {
      lines.shift();
      baseOffset += 1;
    }
  };

  const onSerial = (chunk: string): void => {
    pending += chunk;
    let index: number;
    while ((index = pending.indexOf('\n')) !== -1) {
      pushLine(pending.slice(0, index));
      pending = pending.slice(index + 1);
    }
  };

  const lineCount = (): number => baseOffset + lines.length;

  const lineAt = (index: number): string | undefined => {
    if (index < baseOffset || index >= baseOffset + lines.length) return undefined;
    return lines[index - baseOffset];
  };

  return {
    attach() {
      if (attached) return;
      attached = true;
      unsubscribe = bus.on('vm:serial', onSerial);
    },

    detach() {
      unsubscribe?.();
      unsubscribe = null;
      attached = false;
    },

    beginTool() {
      return lineCount();
    },

    endTool(start: number) {
      const range: LineRange = { start, end: lineCount() - 1 };
      ranges.push(range);
      return range;
    },

    takeRanges() {
      const out = ranges.slice();
      ranges.length = 0;
      return out;
    },

    lineCount,

    lineAt,

    scrollTerminalToLine(line: number) {
      if (!terminal) return;
      terminal.scrollToLine(line, lineAt(line) ?? '');
    },
  };
}
