import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { EventBus } from '@/lib/events.js';
import type { AppEventMap } from '@/types/index.js';

/**
 * xterm.js terminal wired to the v86 serial port.
 *
 * The terminal is the "Twin-View" right-hand pane: it shows the raw VM serial
 * stream (already filtered of sentinel protocol noise by `src/ui/serial.ts`),
 * and the twin-view uses its buffer to scroll to the lines a tool call
 * produced.
 */

export interface TerminalHandle {
  terminal: Terminal;
  write(data: string): void;
  writeln(data: string): void;
  clear(): void;
  focus(): void;
  fit(): void;
  /**
   * Scroll the viewport so `line` (a filtered-serial line index) is visible.
   * When `text` is supplied and does not match the buffer line at `line`, the
   * buffer is searched for the text instead (the terminal wraps long lines,
   * so its physical line index is not always the logical index).
   */
  scrollToLine(line: number, text?: string): void;
  /** Search the scrollback for `text` and scroll to it. */
  scrollToText(text: string): boolean;
  /** Total number of lines currently in the terminal buffer. */
  lineCount(): number;
  /** Text of a buffer line, or undefined when the index is out of range. */
  lineAt(index: number): string | undefined;
  dispose(): void;
}

export function createTerminal(
  container: HTMLElement,
  bus?: EventBus<AppEventMap>,
): TerminalHandle {
  const terminal = new Terminal({
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      selectionBackground: '#264f78',
    },
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    convertEol: true,
    scrollback: 10_000,
  });

  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  fit.fit();

  const lineAt = (index: number): string | undefined =>
    terminal.buffer.active.getLine(index)?.translateToString(true);

  const scrollToText = (text: string): boolean => {
    const needle = text.trim().slice(0, 80);
    if (!needle) return false;
    const buffer = terminal.buffer.active;
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i)?.translateToString(true) ?? '';
      if (line.includes(needle)) {
        try {
          terminal.scrollToLine(i);
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  };

  const scrollToLine = (line: number, text?: string): void => {
    if (text !== undefined) {
      const current = lineAt(line);
      if (current === undefined || !current.includes(text.trim().slice(0, 80))) {
        if (scrollToText(text)) return;
      }
    }
    try {
      terminal.scrollToLine(line);
    } catch {
      /* line is outside the buffer; ignore */
    }
  };

  const unsubscribe = bus
    ? bus.on('vm:serial', (data) => {
        terminal.write(data);
      })
    : null;

  return {
    terminal,
    write: (data) => terminal.write(data),
    writeln: (data) => terminal.writeln(data),
    clear: () => terminal.clear(),
    focus: () => terminal.focus(),
    fit: () => {
      try {
        fit.fit();
      } catch {
        /* container not visible yet */
      }
    },
    scrollToLine,
    scrollToText,
    lineCount: () => terminal.buffer.active.length,
    lineAt,
    dispose: () => {
      unsubscribe?.();
      terminal.dispose();
    },
  };
}
