import type { Message } from '@/types/index.js';
import { escapeHtml, truncate } from '@/lib/utils.js';
import type { ToolLineRange } from './lineRange.js';

/**
 * Chat panel.
 *
 * Renders the conversation as a stream of message cards. Assistant tool calls
 * get a distinct card with the tool name, arguments, and result. All content
 * is rendered with textContent / createElement — never innerHTML — to prevent
 * XSS from model output.
 *
 * The composer is created with the panel but its listeners are attached by
 * `attach()`, which the app calls once the surrounding DOM is ready. This
 * keeps the panel constructible in tests with a minimal DOM stub.
 */

export interface ChatHandle {
  render(messages: Message[]): void;
  /** Append a message and return its card element. */
  append(message: Message): HTMLElement;
  /**
   * Add jump links to the tool-call cards of a message. `ranges` maps tool
   * call ids to serial line ranges; `onJump` is called with the range when a
   * link is clicked.
   */
  annotateToolCalls(
    messageId: string,
    ranges: ToolLineRange[],
    onJump: (start: number, end: number) => void,
  ): void;
  /** Enable/disable the composer and show a working indicator. */
  setWorking(working: boolean): void;
  /** Register the submit handler. */
  onSubmit(fn: (text: string) => void): void;
  /** Attach composer listeners. Safe to call more than once. */
  attach(): void;
  scrollToBottom(): void;
  dispose(): void;
}

export function createChat(container: HTMLElement): ChatHandle {
  const stream = document.createElement('div');
  stream.className = 'gs-chat-stream';
  container.appendChild(stream);

  const composer = document.createElement('div');
  composer.className = 'gs-chat-composer';
  const textarea = document.createElement('textarea');
  textarea.className = 'gs-chat-input';
  textarea.placeholder = 'Ask GhostShell…';
  textarea.rows = 2;
  const send = document.createElement('button');
  send.className = 'gs-chat-send';
  send.type = 'button';
  send.textContent = 'Send';
  composer.appendChild(textarea);
  composer.appendChild(send);
  container.appendChild(composer);

  const status = document.createElement('div');
  status.className = 'gs-chat-status';
  container.appendChild(status);

  const messageElements = new Map<string, HTMLElement>();
  const toolCallElements = new Map<string, HTMLElement>();
  let submitHandler: ((text: string) => void) | null = null;
  let attached = false;
  let onSubmit: (() => void) | null = null;
  let onKeydown: ((event: KeyboardEvent) => void) | null = null;

  const scrollToBottom = (): void => {
    stream.scrollTop = stream.scrollHeight;
  };

  function renderToolCall(call: { id: string; name: string; arguments: Record<string, unknown> }): HTMLElement {
    const el = document.createElement('details');
    el.className = 'gs-tool-call';
    const summary = document.createElement('summary');
    summary.textContent = `🔧 ${call.name}`;
    el.appendChild(summary);
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(call.arguments, null, 2);
    el.appendChild(pre);
    return el;
  }

  function renderMessage(message: Message): HTMLElement {
    const card = document.createElement('div');
    card.className = `gs-msg gs-msg--${message.role}`;
    messageElements.set(message.id, card);

    const header = document.createElement('div');
    header.className = 'gs-msg-header';
    const role = document.createElement('span');
    role.className = 'gs-msg-role';
    role.textContent = message.role;
    header.appendChild(role);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'gs-msg-body';
    card.appendChild(body);

    // The loop emits tool output as a dedicated `tool` message. Render it with
    // the same ok/error styling as the legacy `toolResults` path.
    if (message.role === 'tool') {
      body.appendChild(renderToolMessage(message));
      return card;
    }

    if (message.content) {
      body.textContent = message.content;
    } else if (!message.toolCalls?.length && !message.toolResults?.length) {
      body.textContent = '(no content)';
    }

    if (message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        const el = renderToolCall(call);
        toolCallElements.set(call.id, el);
        body.appendChild(el);
      }
    }
    if (message.toolResults?.length) {
      for (const result of message.toolResults) {
        body.appendChild(renderToolResult(result));
      }
    }

    return card;
  }

  return {
    render(messages: Message[]) {
      stream.replaceChildren();
      messageElements.clear();
      toolCallElements.clear();
      for (const message of messages) stream.appendChild(renderMessage(message));
      scrollToBottom();
    },

    append(message: Message) {
      const card = renderMessage(message);
      stream.appendChild(card);
      scrollToBottom();
      return card;
    },

    annotateToolCalls(messageId, ranges, onJump) {
      const card = messageElements.get(messageId);
      if (!card) return;
      for (const range of ranges) {
        const el = toolCallElements.get(range.callId);
        if (!el) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'gs-tool-range';
        button.textContent =
          range.end >= range.start
            ? `Lines ${range.start}–${range.end}`
            : `Line ${range.start}`;
        button.addEventListener('click', () => onJump(range.start, range.end));
        el.appendChild(button);
      }
    },

    setWorking(working: boolean) {
      send.disabled = working;
      textarea.disabled = working;
      status.textContent = working ? 'Working…' : '';
    },

    onSubmit(fn) {
      submitHandler = fn;
    },

    attach() {
      if (attached) return;
      attached = true;
      onSubmit = () => {
        const text = textarea.value.trim();
        if (!text) return;
        textarea.value = '';
        submitHandler?.(text);
      };
      onKeydown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          onSubmit?.();
        }
      };
      send.addEventListener('click', onSubmit);
      textarea.addEventListener('keydown', onKeydown);
    },

    scrollToBottom,

    dispose() {
      if (onSubmit) send.removeEventListener('click', onSubmit);
      if (onKeydown) textarea.removeEventListener('keydown', onKeydown);
      messageElements.clear();
      toolCallElements.clear();
      stream.remove();
      composer.remove();
      status.remove();
    },
  };
}

function renderToolMessage(message: Message): HTMLElement {
  const el = document.createElement('pre');
  el.className = `gs-tool-result ${toolMessageOk(message) ? 'is-ok' : 'is-error'}`;
  el.textContent = truncate(message.content, 4000);
  return el;
}

/**
 * Resolve the ok/error state of a `tool` message. Prefer a structured
 * `toolResults` entry when one is attached; otherwise derive it from the
 * markers the built-in tools emit.
 */
function toolMessageOk(message: Message): boolean {
  const structured = message.toolResults?.[0];
  if (structured) return structured.ok;
  return deriveToolOk(message.content);
}

function deriveToolOk(content: string): boolean {
  // bash appends `[exit N]`; the last marker is the command's own status.
  const exits = content.match(/\[exit -?\d+\]/g);
  const lastExit = exits?.[exits.length - 1];
  if (lastExit !== undefined && lastExit !== '[exit 0]') return false;
  if (/^(?:bash|read_file|write_file|list_dir|search) failed:/m.test(content)) return false;
  if (/^Missing required argument:/m.test(content)) return false;
  if (/appears to be a binary file/i.test(content)) return false;
  if (/^Unknown tool /m.test(content)) return false;
  if (/Command timed out/i.test(content)) return false;
  // grep exits 0 (match) or 1 (no match); anything else is an error.
  if (/grep exited with code (?!0\b|1\b)\d+/i.test(content)) return false;
  return true;
}

function renderToolResult(result: { ok: boolean; content: string }): HTMLElement {
  const el = document.createElement('pre');
  el.className = `gs-tool-result ${result.ok ? 'is-ok' : 'is-error'}`;
  el.textContent = truncate(result.content, 4000);
  return el;
}

export function renderMarkdown(text: string): string {
  // Deliberately conservative: escape then apply a tiny subset of markdown.
  const escaped = escapeHtml(text);
  return escaped
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}
