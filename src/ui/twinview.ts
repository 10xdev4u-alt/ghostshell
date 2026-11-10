import type { EventBus } from '@/lib/events.js';
import type { AppEventMap } from '@/types/index.js';

/**
 * Twin-View: keeps the chat pane and the raw serial terminal in sync.
 *
 * Every serial chunk is buffered into a line ring. When a tool call starts, we
 * record the current line index; when it finishes, we annotate the tool card
 * with "lines 42–47". Clicking that link scrolls the terminal to the line.
 *
 * This is the feature that makes the agent legible (docs/CREATIVE_INNOVATION.md §1.1).
 */

export interface TwinView {
  attach(): void;
  detach(): void;
  scrollTerminalToLine(line: number): void;
}

export function createTwinView(bus: EventBus<AppEventMap>): TwinView {
  let buffer: string[] = [];
  let marking = false;
  let markStart = 0;

  const onSerial = (chunk: string) => {
    for (const ch of chunk) {
      if (ch === '\n') {
        buffer.push('');
        if (buffer.length > 5000) buffer.shift();
      } else {
        const last = buffer.length - 1;
        buffer[last] = (buffer[last] ?? '') + ch;
      }
    }
  };

  const onToolCall = () => {
    marking = true;
    markStart = buffer.length;
  };

  const onToolResult = () => {
    marking = false;
    // TODO: annotate the tool card with the line range.
    void markStart;
  };

  return {
    attach() {
      bus.on('vm:serial', onSerial);
      bus.on('agent:tool-call', onToolCall);
      bus.on('agent:tool-result', onToolResult);
    },
    detach() {
      bus.off('vm:serial', onSerial);
      bus.off('agent:tool-call', onToolCall);
      bus.off('agent:tool-result', onToolResult);
    },
    scrollTerminalToLine(line: number) {
      // TODO: ask the terminal handle to scroll to `line`.
      void line;
    },
  };
}
