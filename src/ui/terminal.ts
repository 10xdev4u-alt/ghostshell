import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * xterm.js terminal wired to the v86 serial port.
 *
 * The terminal is the "Twin-View" right-hand pane: it shows the raw VM serial
 * stream, and every line is also mirrored to the event bus so the chat view
 * can link tool calls to serial output.
 */

export interface TerminalHandle {
  terminal: Terminal;
  write(data: string): void;
  writeln(data: string): void;
  clear(): void;
  focus(): void;
  fit(): void;
  dispose(): void;
}

export function createTerminal(container: HTMLElement): TerminalHandle {
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
  });

  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  fit.fit();

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
    dispose: () => terminal.dispose(),
  };
}
