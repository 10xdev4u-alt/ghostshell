import type { Message } from '@/types/index.js';
import { escapeHtml, truncate } from '@/lib/utils.js';

/**
 * Chat panel.
 *
 * Renders the conversation as a stream of message cards. Assistant tool calls
 * get a distinct card with the tool name, arguments, and result. All content
 * is rendered with textContent / createElement — never innerHTML — to prevent
 * XSS from model output.
 */

export interface ChatHandle {
  render(messages: Message[]): void;
  append(message: Message): void;
  scrollToBottom(): void;
  dispose(): void;
}

export function createChat(container: HTMLElement): ChatHandle {
  const stream = document.createElement('div');
  stream.className = 'gs-chat-stream';
  container.appendChild(stream);

  return {
    render(messages: Message[]) {
      stream.replaceChildren();
      for (const message of messages) stream.appendChild(renderMessage(message));
      this.scrollToBottom();
    },
    append(message: Message) {
      stream.appendChild(renderMessage(message));
      this.scrollToBottom();
    },
    scrollToBottom() {
      stream.scrollTop = stream.scrollHeight;
    },
    dispose() {
      stream.remove();
    },
  };
}

function renderMessage(message: Message): HTMLElement {
  const card = document.createElement('div');
  card.className = `gs-msg gs-msg--${message.role}`;

  const header = document.createElement('div');
  header.className = 'gs-msg-header';
  const role = document.createElement('span');
  role.className = 'gs-msg-role';
  role.textContent = message.role;
  header.appendChild(role);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'gs-msg-body';
  body.textContent = message.content || '(no content)';
  card.appendChild(body);

  if (message.toolCalls?.length) {
    for (const call of message.toolCalls) {
      body.appendChild(renderToolCall(call));
    }
  }
  if (message.toolResults?.length) {
    for (const result of message.toolResults) {
      body.appendChild(renderToolResult(result));
    }
  }

  return card;
}

function renderToolCall(call: { name: string; arguments: Record<string, unknown> }): HTMLElement {
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
