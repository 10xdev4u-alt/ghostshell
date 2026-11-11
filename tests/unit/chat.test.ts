import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types/index.js';
import { createChat } from '@/ui/chat.js';

/**
 * Minimal DOM stub. chat.ts only uses createElement, appendChild,
 * replaceChildren, remove, textContent, className, and scroll metrics.
 */
class FakeElement {
  tagName: string;
  className = '';
  textContent = '';
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  scrollTop = 0;
  scrollHeight = 0;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index !== -1) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

function installDocument(): void {
  vi.stubGlobal('document', {
    createElement: (tagName: string) => new FakeElement(tagName),
  });
}

function findByClass(root: FakeElement, className: string): FakeElement | undefined {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return undefined;
}

function makeMessage(role: Message['role'], content: string, extra?: Partial<Message>): Message {
  return { id: `m-${role}-${Math.random()}`, role, content, timestamp: 1, ...extra };
}

function render(messages: Message[]): FakeElement {
  installDocument();
  const container = new FakeElement('div');
  const chat = createChat(container as unknown as HTMLElement);
  chat.render(messages);
  const stream = container.children[0];
  if (!stream) throw new Error('chat did not mount a stream');
  return stream;
}

describe('chat panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders tool messages with ok/error styling', () => {
    const stream = render([
      makeMessage('tool', 'hello\n[exit 0] [1ms]'),
      makeMessage('tool', 'command not found\n[exit 127] [2ms]'),
    ]);

    const ok = findByClass(stream.children[0]!, 'gs-tool-result');
    expect(ok?.className).toContain('is-ok');
    expect(ok?.textContent).toContain('hello');

    const error = findByClass(stream.children[1]!, 'gs-tool-result');
    expect(error?.className).toContain('is-error');
    expect(error?.textContent).toContain('command not found');
  });

  it('prefers a structured toolResults state over the content', () => {
    const stream = render([
      makeMessage('tool', 'looks fine\n[exit 0]', {
        toolResults: [{ ok: false, content: 'looks fine\n[exit 0]' }],
      }),
    ]);

    const result = findByClass(stream.children[0]!, 'gs-tool-result');
    expect(result?.className).toContain('is-error');
  });

  it('still renders legacy assistant toolResults', () => {
    const stream = render([
      makeMessage('assistant', 'done', {
        toolResults: [{ ok: true, content: 'a.txt\nb.txt' }],
      }),
    ]);

    const result = findByClass(stream.children[0]!, 'gs-tool-result');
    expect(result?.className).toContain('is-ok');
    expect(result?.textContent).toContain('a.txt');
  });
});
